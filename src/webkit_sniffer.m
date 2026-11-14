#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface SnifferDelegate : NSObject <NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate>
@property (strong, nonatomic) NSWindow *window;
@property (strong, nonatomic) WKWebView *webView;
@property (copy, nonatomic) NSString *targetUrl;
@property (copy, nonatomic) NSString *userAgent;
@property (copy, nonatomic) NSString *cookieHeader;
@property (assign, nonatomic) NSInteger maxScrollCount;
@property (assign, nonatomic) NSInteger currentScrollCount;
@property (assign, nonatomic) BOOL isProfileMode;
@property (assign, nonatomic) BOOL scrollStarted;
@property (assign, nonatomic) BOOL finished;
@end

@implementation SnifferDelegate

- (NSArray<NSHTTPCookie *> *)parseCookiesFromHeader:(NSString *)header forURL:(NSURL *)url {
    NSMutableArray<NSHTTPCookie *> *cookies = [NSMutableArray array];
    if (!header || header.length == 0 || !url || !url.host) {
        return cookies;
    }

    NSString *cleanHeader = [header stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if ([cleanHeader.lowercaseString hasPrefix:@"cookie:"]) {
        cleanHeader = [[cleanHeader substringFromIndex:7] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    }

    NSString *host = url.host.lowercaseString;
    NSString *cookieDomain = host;
    BOOL isIpOrLocal = [host isEqualToString:@"localhost"] ||
                       [host rangeOfString:@"^\\d+\\.\\d+\\.\\d+\\.\\d+$" options:NSRegularExpressionSearch].location != NSNotFound;
    if (!isIpOrLocal) {
        NSArray<NSString *> *parts = [host componentsSeparatedByString:@"."];
        if (parts.count >= 2) {
            cookieDomain = [NSString stringWithFormat:@".%@.%@", parts[parts.count - 2], parts[parts.count - 1]];
        }
    }

    BOOL isHttps = [url.scheme.lowercaseString isEqualToString:@"https"];
    NSDate *expiresDate = [NSDate dateWithTimeIntervalSinceNow:86400.0 * 30.0];

    NSArray<NSString *> *pairs = [cleanHeader componentsSeparatedByString:@";"];
    for (NSString *rawPair in pairs) {
        NSString *trimmed = [rawPair stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (trimmed.length == 0) continue;
        NSRange eqRange = [trimmed rangeOfString:@"="];
        if (eqRange.location == NSNotFound || eqRange.location == 0) continue;

        NSString *name = [[trimmed substringToIndex:eqRange.location] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        NSString *val = [[trimmed substringFromIndex:eqRange.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if (name.length == 0) continue;

        if (val.length >= 2 &&
            (([val hasPrefix:@"\""] && [val hasSuffix:@"\""]) || ([val hasPrefix:@"'"] && [val hasSuffix:@"'"]))) {
            val = [val substringWithRange:NSMakeRange(1, val.length - 2)];
        }

        NSMutableDictionary *props = [@{
            NSHTTPCookieName: name,
            NSHTTPCookieValue: val,
            NSHTTPCookieDomain: cookieDomain,
            NSHTTPCookiePath: @"/",
            NSHTTPCookieExpires: expiresDate
        } mutableCopy];
        if (isHttps) {
            props[NSHTTPCookieSecure] = @"TRUE";
        }
        NSHTTPCookie *cookie = [NSHTTPCookie cookieWithProperties:props];
        if (cookie) {
            [cookies addObject:cookie];
        }
    }
    return cookies;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    config.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];

    WKUserContentController *ucc = [[WKUserContentController alloc] init];
    [ucc addScriptMessageHandler:self name:@"sniffer"];

    NSString *hookJs = @
    "(function() {\n"
    "  const reportedUrls = new Set();\n"
    "  function report(type, data) {\n"
    "    try { window.webkit.messageHandlers.sniffer.postMessage(JSON.stringify({type: type, data: data})); } catch(e) {}\n"
    "  }\n"
    "  function isImageOrStatic(u) {\n"
    "    const lower = u.split('?')[0].toLowerCase();\n"
    "    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') ||\n"
    "           lower.endsWith('.webp') || lower.endsWith('.avif') || lower.endsWith('.gif') ||\n"
    "           lower.endsWith('.svg') || lower.endsWith('.js') || lower.endsWith('.css') || lower.endsWith('.woff2');\n"
    "  }\n"
    "  function isVideoStreamUrl(u) {\n"
    "    if (!u || !u.startsWith('http') || u.startsWith('blob:') || isImageOrStatic(u)) return false;\n"
    "    const lower = u.toLowerCase();\n"
    "    return lower.includes('.mp4') || lower.includes('.m3u8') || lower.includes('mime_type=video') ||\n"
    "           lower.includes('aweme/v1/play') || (lower.includes('xhscdn.com') && lower.includes('stream'));\n"
    "  }\n"
    "  function isRelevantUrl(u) {\n"
    "    if (!u) return false;\n"
    "    const l = u.toLowerCase();\n"
    "    return l.includes('aweme/detail') || l.includes('aweme/post') || l.includes('aweme/favorite') ||\n"
    "           l.includes('user/profile') || l.includes('user/info') || l.includes('web/api/v2/aweme') ||\n"
    "           l.includes('graphql') || l.includes('playurl') || l.includes('player/video') || l.includes('user_posted');\n"
    "  }\n"
    "  function hasMediaOrProfilePayload(text) {\n"
    "    if (!text || text.length < 20) return false;\n"
    "    return text.includes('aweme_detail') || text.includes('aweme_list') || text.includes('play_addr') ||\n"
    "           text.includes('photoUrl') || text.includes('mp4Url') || text.includes('mainMvUrls') ||\n"
    "           text.includes('visionVideoDetail') || text.includes('visionProfilePhotoList') ||\n"
    "           text.includes('visionProfile') || text.includes('user_profile') || text.includes('userInfo') ||\n"
    "           text.includes('\"sec_uid\"') || text.includes('\"aweme_count\"') || text.includes('\"nickname\"') ||\n"
    "           text.includes('adaptationSet') || text.includes('originVideoKey') || text.includes('masterUrl') ||\n"
    "           text.includes('video_download') || text.includes('video_url') || text.includes('vlist') ||\n"
    "           text.includes('note_list') || text.includes('\"notes\"');\n"
    "  }\n"
    "  const origOpen = XMLHttpRequest.prototype.open;\n"
    "  const origSend = XMLHttpRequest.prototype.send;\n"
    "  XMLHttpRequest.prototype.open = function(method, url) {\n"
    "    this._sniffUrl = url ? String(url) : '';\n"
    "    return origOpen.apply(this, arguments);\n"
    "  };\n"
    "  XMLHttpRequest.prototype.send = function() {\n"
    "    this.addEventListener('load', function() {\n"
    "      try {\n"
    "        const u = String(this._sniffUrl || this.responseURL || '');\n"
    "        let txt = '';\n"
    "        if (!this.responseType || this.responseType === 'text') {\n"
    "          txt = this.responseText || '';\n"
    "        } else if (this.responseType === 'json' && this.response) {\n"
    "          txt = JSON.stringify(this.response);\n"
    "        }\n"
    "        if (txt && (hasMediaOrProfilePayload(txt) || isRelevantUrl(u))) {\n"
    "          report('xhr', { url: u, body: txt });\n"
    "        }\n"
    "      } catch(e) {}\n"
    "    });\n"
    "    return origSend.apply(this, arguments);\n"
    "  };\n"
    "  const origFetch = window.fetch;\n"
    "  if (origFetch) {\n"
    "    window.fetch = async function() {\n"
    "      const arg0 = arguments[0];\n"
    "      const reqUrl = (typeof Request !== 'undefined' && arg0 instanceof Request) ? arg0.url : String((arg0 && arg0.url) || arg0 || '');\n"
    "      const res = await origFetch.apply(this, arguments);\n"
    "      try {\n"
    "        const u = res.url || reqUrl;\n"
    "        const clone = res.clone();\n"
    "        clone.text().then(txt => {\n"
    "          if (txt && (hasMediaOrProfilePayload(txt) || isRelevantUrl(u))) {\n"
    "            report('fetch', { url: u, body: txt });\n"
    "          }\n"
    "        }).catch(()=>{});\n"
    "      } catch(e) {}\n"
    "      return res;\n"
    "    };\n"
    "  }\n"
    "  let stateReported = false;\n"
    "  setInterval(() => {\n"
    "    try {\n"
    "      const videos = document.querySelectorAll('video, video source');\n"
    "      for (const v of videos) {\n"
    "        const s = v.currentSrc || v.src;\n"
    "        if (isVideoStreamUrl(s) && !reportedUrls.has(s)) {\n"
    "          reportedUrls.add(s);\n"
    "          report('video_dom', { src: s, title: document.title, href: location.href });\n"
    "        }\n"
    "      }\n"
    "      const resources = performance.getEntriesByType('resource') || [];\n"
    "      for (const r of resources) {\n"
    "        const name = r.name || '';\n"
    "        if (isVideoStreamUrl(name) && !reportedUrls.has(name)) {\n"
    "          reportedUrls.add(name);\n"
    "          report('resource_stream', { src: name, title: document.title, href: location.href });\n"
    "        }\n"
    "      }\n"
    "      if (!stateReported && (window.__APOLLO_STATE__ || window.INIT_STATE || window.__INITIAL_STATE__ || window._ROUTER_DATA || window._SSR_HYDRATED_DATA || window.ppxItemDetail || window.__RENDER_DATA__)) {\n"
    "        const ssr = {};\n"
    "        if (window.__APOLLO_STATE__) ssr.apollo = window.__APOLLO_STATE__;\n"
    "        if (window.INIT_STATE) ssr.initState = window.INIT_STATE;\n"
    "        if (window.__INITIAL_STATE__) ssr.initialState = window.__INITIAL_STATE__;\n"
    "        if (window._ROUTER_DATA) ssr.routerData = window._ROUTER_DATA;\n"
    "        if (window._SSR_HYDRATED_DATA) ssr.ssrHydrated = window._SSR_HYDRATED_DATA;\n"
    "        if (window.ppxItemDetail) ssr.ppxItemDetail = window.ppxItemDetail;\n"
    "        if (window.__RENDER_DATA__) ssr.renderData = window.__RENDER_DATA__;\n"
    "        stateReported = true;\n"
    "        report('window_state', { href: location.href, title: document.title, ssr: ssr });\n"
    "      }\n"
    "    } catch(e) {}\n"
    "  }, 300);\n"
    "})();";

    WKUserScript *script = [[WKUserScript alloc] initWithSource:hookJs injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:NO];
    [ucc addUserScript:script];
    config.userContentController = ucc;
    config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;

    // Đặt cửa sổ trong phạm vi màn hình với độ trong suốt 0 để WebKit không bị throttle timers/IntersectionObserver
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1280, 860)
                                              styleMask:NSWindowStyleMaskBorderless
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    [self.window setAlphaValue:0.0];
    [self.window setIgnoresMouseEvents:YES];
    [self.window orderBack:nil];

    self.webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1280, 860) configuration:config];
    if (self.userAgent && self.userAgent.length > 0) {
        self.webView.customUserAgent = self.userAgent;
    }
    self.webView.navigationDelegate = self;
    [self.window.contentView addSubview:self.webView];

    NSURL *url = [NSURL URLWithString:self.targetUrl];
    NSArray<NSHTTPCookie *> *parsedCookies = [self parseCookiesFromHeader:self.cookieHeader forURL:url];

    void (^startLoad)(void) = ^{
        NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
        if (self.cookieHeader && self.cookieHeader.length > 0) {
            [req setValue:self.cookieHeader forHTTPHeaderField:@"Cookie"];
        }
        [self.webView loadRequest:req];
    };

    if (parsedCookies.count > 0) {
        WKHTTPCookieStore *cookieStore = config.websiteDataStore.httpCookieStore;
        dispatch_group_t grp = dispatch_group_create();
        for (NSHTTPCookie *c in parsedCookies) {
            dispatch_group_enter(grp);
            [cookieStore setCookie:c completionHandler:^{
                dispatch_group_leave(grp);
            }];
        }
        dispatch_group_notify(grp, dispatch_get_main_queue(), ^{
            startLoad();
        });
    } else {
        startLoad();
    }

    int timeoutSec = self.isProfileMode ? (int)(12 + self.maxScrollCount * 2) : 8;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutSec * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (!self.finished) {
            self.finished = YES;
            [self dumpPageInfoAndExit];
        }
    });
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    if (!self.isProfileMode || self.finished) return;
    // Kích hoạt cuộn trang tự động nếu trang tải xong mà API video chưa kích hoạt hoặc cần tải thêm trang sau
    if (!self.scrollStarted && self.maxScrollCount > 0) {
        self.scrollStarted = YES;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1600 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
            [self performScrollStepIfNeeded];
        });
    }
}

- (void)performScrollStepIfNeeded {
    if (self.finished) return;
    if (self.currentScrollCount >= self.maxScrollCount) {
        self.finished = YES;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(900 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
            [self dumpPageInfoAndExit];
        });
        return;
    }
    self.currentScrollCount += 1;
    NSString *scrollJs = @"window.scrollTo({ top: document.body.scrollHeight || 4000, behavior: 'smooth' });";
    [self.webView evaluateJavaScript:scrollJs completionHandler:nil];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1600 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
        [self performScrollStepIfNeeded];
    });
}

- (void)dumpPageInfoAndExit {
    // Tuyệt đối KHÔNG trả về document.cookie ra stdout để bảo vệ thông tin xác thực của người dùng
    NSString *dumpJs = @
    "(function() {"
    "  const href = location.href || '';"
    "  const title = document.title || '';"
    "  const bodyText = (document.body && document.body.innerText) || '';"
    "  const capEl = document.querySelector('#captcha_container, .captcha-verify-container, .secsdk-captcha-wrapper, iframe[src*=\"verify\"], iframe[src*=\"captcha\"]');"
    "  let capVisible = false;"
    "  if (capEl) {"
    "    const r = capEl.getBoundingClientRect();"
    "    capVisible = (r && r.width > 50 && r.height > 50) || capEl.tagName === 'IFRAME';"
    "  }"
    "  const hasCaptcha = href.includes('verifycenter') || title.includes('验证码') || capVisible ||"
    "    bodyText.includes('请完成下列验证后继续') || bodyText.includes('拖动滑块') || bodyText.includes('点击依次') || bodyText.includes('验证码中间页');"
    "  const videoAnchors = Array.from(document.querySelectorAll('a[href*=\"/video/\"], a[href*=\"/note/\"], a[href*=\"/short-video/\"], a[href*=\"/explore/\"], a[href*=\"modal_id=\"]'));"
    "  const allAnchors = Array.from(document.querySelectorAll('a[href]'));"
    "  const seenHref = new Set();"
    "  const mergedLinks = [];"
    "  for (const a of [...videoAnchors, ...allAnchors]) {"
    "    if (!a.href || seenHref.has(a.href)) continue;"
    "    seenHref.add(a.href);"
    "    const img = a.querySelector('img');"
    "    const rawText = (a.innerText || a.getAttribute('title') || (img && img.getAttribute('alt')) || '').replace(/\\s+/g, ' ').trim();"
    "    mergedLinks.push({"
    "      href: a.href,"
    "      text: rawText.slice(0, 200),"
    "      cover: (img && (img.src || img.getAttribute('data-src'))) || ''"
    "    });"
    "    if (mergedLinks.length >= 260) break;"
    "  }"
    "  const hasLoginWall = videoAnchors.length === 0 && (href.includes('/login') || bodyText.includes('登录后即可查看') || bodyText.includes('请先登录') || bodyText.includes('扫码登录'));"
    "  const renderDataEl = document.getElementById('RENDER_DATA');"
    "  let renderDataRaw = '';"
    "  if (renderDataEl) {"
    "    try { renderDataRaw = decodeURIComponent(renderDataEl.textContent || ''); } catch(e) { renderDataRaw = renderDataEl.textContent || ''; }"
    "  }"
    "  let parsedRenderSummary = null;"
    "  if (renderDataRaw) {"
    "    try {"
    "      const rObj = JSON.parse(renderDataRaw);"
    "      for (const v of Object.values(rObj)) {"
    "        if (!v || typeof v !== 'object') continue;"
    "        const u = (v.user && v.user.user) || v.userInfo || v.user;"
    "        const p = (v.post && v.post.data) || v.awemeList;"
    "        if (u || p) {"
    "          parsedRenderSummary = { user: u || null, posts: Array.isArray(p) ? p.slice(0, 60) : null };"
    "          break;"
    "        }"
    "      }"
    "    } catch(e) {}"
    "  }"
    "  const h1El = document.querySelector('[data-e2e=\"user-info\"] h1, h1, .user-name, .user-info-name');"
    "  const avatarEl = document.querySelector('[data-e2e=\"user-info\"] img, .avatar img, img.avatar');"
    "  const descEl = document.querySelector('[data-e2e=\"user-desc\"], [data-e2e=\"user-signature\"], .user-desc');"
    "  return JSON.stringify({"
    "    href: href,"
    "    title: title,"
    "    hasCaptcha: hasCaptcha,"
    "    hasLoginWall: hasLoginWall,"
    "    domProfile: {"
    "      nickname: h1El ? (h1El.innerText || '').trim() : '',"
    "      avatar: avatarEl ? (avatarEl.src || '') : '',"
    "      signature: descEl ? (descEl.innerText || '').trim() : ''"
    "    },"
    "    parsedRenderSummary: parsedRenderSummary,"
    "    renderDataSnippet: parsedRenderSummary ? '' : (renderDataRaw ? renderDataRaw.slice(0, 500000) : ''),"
    "    links: mergedLinks"
    "  });"
    "})()";
    [self.webView evaluateJavaScript:dumpJs completionHandler:^(id res, NSError *err) {
        if (res) {
            printf("SNIFF_FINAL:%s\n", [[NSString stringWithFormat:@"%@", res] UTF8String]);
            fflush(stdout);
        }
        exit(0);
    }];
}

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {
    NSString *body = [NSString stringWithFormat:@"%@", message.body];
    printf("SNIFF_EVENT:%s\n", [body UTF8String]);
    fflush(stdout);

    if (self.isProfileMode) {
        if ([body containsString:@"\"aweme_list\""] ||
            [body containsString:@"\"visionProfilePhotoList\""] ||
            [body containsString:@"\"note_list\""] ||
            [body containsString:@"\"vlist\""]) {
            if (!self.scrollStarted && self.maxScrollCount > 0) {
                self.scrollStarted = YES;
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(800 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
                    [self performScrollStepIfNeeded];
                });
            } else if (self.maxScrollCount == 0 && !self.finished) {
                self.finished = YES;
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1200 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
                    [self dumpPageInfoAndExit];
                });
            }
        }
        return;
    }

    if ([body containsString:@"\"type\":\"video_dom\""] ||
        [body containsString:@"\"type\":\"resource_stream\""] ||
        [body containsString:@"\"aweme_detail\""] ||
        [body containsString:@"\"aweme_list\""] ||
        [body containsString:@"\"photoUrl\""] ||
        [body containsString:@"\"mp4Url\""] ||
        [body containsString:@"\"visionProfilePhotoList\""] ||
        [body containsString:@"\"adaptationSet\""] ||
        [body containsString:@"\"originVideoKey\""]) {
        if (!self.finished) {
            self.finished = YES;
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(500 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
                [self dumpPageInfoAndExit];
            });
        }
    }
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (argc < 2) {
            fprintf(stderr, "Usage: WebKitSniffer <url> [user-agent]\n");
            return 1;
        }
        NSString *url = [NSString stringWithUTF8String:argv[1]];
        NSString *ua = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : nil;

        NSDictionary *env = [[NSProcessInfo processInfo] environment];
        NSString *cookieEnv = env[@"SNIFFER_COOKIE"] ?: @"";
        NSString *profileModeEnv = env[@"SNIFFER_PROFILE_MODE"] ?: @"0";
        NSString *scrollEnv = env[@"SNIFFER_SCROLL_COUNT"] ?: @"0";

        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
        SnifferDelegate *del = [[SnifferDelegate alloc] init];
        del.targetUrl = url;
        del.userAgent = ua;
        del.cookieHeader = cookieEnv;
        del.isProfileMode = [profileModeEnv isEqualToString:@"1"];
        del.maxScrollCount = MAX(0, MIN(6, [scrollEnv integerValue]));
        del.currentScrollCount = 0;
        del.scrollStarted = NO;
        [app setDelegate:del];
        [app run];
    }
    return 0;
}

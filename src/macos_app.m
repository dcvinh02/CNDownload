#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate>
@property (strong, nonatomic) NSWindow *window;
@property (strong, nonatomic) WKWebView *webView;
@property (strong, nonatomic) NSTask *serverTask;
@property (copy, nonatomic) NSString *projectRoot;
@property (assign, nonatomic) BOOL pageLoaded;
@end

@implementation AppDelegate

- (instancetype)initWithProjectRoot:(NSString *)root {
    self = [super init];
    if (self) {
        _projectRoot = [root copy];
        _pageLoaded = NO;
    }
    return self;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self setupMainMenu];

    NSString *iconPath = [self.projectRoot stringByAppendingPathComponent:@"public/icon.png"];
    if ([[NSFileManager defaultManager] fileExistsAtPath:iconPath]) {
        NSImage *iconImg = [[NSImage alloc] initWithContentsOfFile:iconPath];
        if (iconImg) {
            [NSApp setApplicationIconImage:iconImg];
        }
    }

    NSRect frame = NSMakeRect(0, 0, 1360, 860);
    NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
    self.window = [[NSWindow alloc] initWithContentRect:frame styleMask:style backing:NSBackingStoreBuffered defer:NO];
    [self.window center];
    [self.window setTitle:@"CN Video Downloader — 12 Nền tảng Video Trung Quốc"];
    [self.window setBackgroundColor:[NSColor colorWithCalibratedRed:0.97 green:0.98 blue:0.99 alpha:1.0]];
    [self.window setDelegate:self];

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    [config.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
    // Cho phép phát audio nghe thử / video xem trước ngay cả khi play() được gọi sau một yêu cầu bất đồng bộ.
    if (@available(macOS 10.12, *)) {
        config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    }

    self.webView = [[WKWebView alloc] initWithFrame:[[self.window contentView] bounds] configuration:config];
    [self.webView setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
    [self.webView setUIDelegate:self];
    [self.webView setNavigationDelegate:self];

    [[self.window contentView] addSubview:self.webView];

    // Mở cửa sổ giao diện ngay lập tức mà không chờ đợi (Instant Window Display)
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    // Kiểm tra xem backend đã có sẵn hay cần khởi chạy
    [self checkAndStartBackendIfNeeded];
}

- (void)checkAndStartBackendIfNeeded {
    NSURL *healthUrl = [NSURL URLWithString:@"http://127.0.0.1:3889/api/health"];
    NSURLRequest *req = [NSURLRequest requestWithURL:healthUrl cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:0.4];
    [[[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSHTTPURLResponse *httpResp = (NSHTTPURLResponse *)response;
        if (httpResp && httpResp.statusCode == 200) {
            dispatch_async(dispatch_get_main_queue(), ^{
                [self loadAppPageOnce];
            });
        } else {
            dispatch_async(dispatch_get_main_queue(), ^{
                [self startBackendServer];
                [self pollServerWithRetries:35];
            });
        }
    }] resume];
}

- (void)startBackendServer {
    if (self.serverTask && [self.serverTask isRunning]) return;

    NSArray *candidates = @[@"/opt/homebrew/bin/node", @"/usr/local/bin/node", @"/usr/bin/node"];
    NSString *nodePath = @"/opt/homebrew/bin/node";
    for (NSString *path in candidates) {
        if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
            nodePath = path;
            break;
        }
    }

    NSString *serverScript = [self.projectRoot stringByAppendingPathComponent:@"src/server.js"];
    NSTask *task = [[NSTask alloc] init];
    [task setExecutableURL:[NSURL fileURLWithPath:nodePath]];
    [task setArguments:@[serverScript]];
    [task setCurrentDirectoryURL:[NSURL fileURLWithPath:self.projectRoot]];

    NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
    NSString *binDir = [self.projectRoot stringByAppendingPathComponent:@"bin"];
    NSString *currentPath = env[@"PATH"] ?: @"";
    env[@"PATH"] = [NSString stringWithFormat:@"%@:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:%@", binDir, currentPath];
    [task setEnvironment:env];

    NSFileHandle *nullDevice = [NSFileHandle fileHandleWithNullDevice];
    [task setStandardOutput:nullDevice];
    [task setStandardError:nullDevice];

    NSError *err = nil;
    [task launchAndReturnError:&err];
    if (!err) {
        self.serverTask = task;
    }
}

- (void)loadAppPageOnce {
    if (self.pageLoaded) return;
    self.pageLoaded = YES;
    NSURL *appUrl = [NSURL URLWithString:@"http://127.0.0.1:3889"];
    [self.webView loadRequest:[NSURLRequest requestWithURL:appUrl]];
}

- (void)pollServerWithRetries:(NSInteger)retries {
    if (self.pageLoaded) return;

    NSURL *healthUrl = [NSURL URLWithString:@"http://127.0.0.1:3889/api/health"];
    NSURLRequest *req = [NSURLRequest requestWithURL:healthUrl cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:0.5];
    [[[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSHTTPURLResponse *httpResp = (NSHTTPURLResponse *)response;
        if (httpResp && httpResp.statusCode == 200) {
            dispatch_async(dispatch_get_main_queue(), ^{
                [self loadAppPageOnce];
            });
        } else if (retries > 0) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(150 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
                [self pollServerWithRetries:retries - 1];
            });
        } else {
            dispatch_async(dispatch_get_main_queue(), ^{
                [self loadAppPageOnce];
            });
        }
    }] resume];
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    [alert setMessageText:@"Thông báo"];
    [alert setInformativeText:message];
    [alert addButtonWithTitle:@"Đóng"];
    [alert runModal];
    completionHandler();
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    [alert setMessageText:@"Xác nhận"];
    [alert setInformativeText:message];
    [alert addButtonWithTitle:@"Đồng ý"];
    [alert addButtonWithTitle:@"Hủy"];
    NSModalResponse resp = [alert runModal];
    completionHandler(resp == NSAlertFirstButtonReturn);
}

- (void)setupMainMenu {
    NSMenu *menubar = [[NSMenu alloc] init];
    NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:appMenuItem];

    NSMenu *appMenu = [[NSMenu alloc] init];
    NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:@"Thoát CN Video Scraper Pro" action:@selector(terminate:) keyEquivalent:@"q"];
    [appMenu addItem:quitItem];
    [appMenuItem setSubmenu:appMenu];

    NSMenuItem *editMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:editMenuItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    [editMenuItem setSubmenu:editMenu];

    [NSApp setMainMenu:menubar];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    if (self.serverTask && [self.serverTask isRunning]) {
        [self.serverTask terminate];
    }
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSString *root = nil;
        if (argc > 1) {
            root = [NSString stringWithUTF8String:argv[1]];
        }
        if (!root || root.length == 0) {
            NSString *execPath = [[NSBundle mainBundle] executablePath];
            // Nếu chạy từ CNVideoScraperPro.app/Contents/MacOS/CNVideoScraperPro:
            // lùi lại 3 cấp thư mục (Contents -> App -> project root)
            NSString *appBundleDir = [[[execPath stringByDeletingLastPathComponent] stringByDeletingLastPathComponent] stringByDeletingLastPathComponent];
            NSString *candidateRoot = [appBundleDir stringByDeletingLastPathComponent];
            if ([[NSFileManager defaultManager] fileExistsAtPath:[candidateRoot stringByAppendingPathComponent:@"src/server.js"]]) {
                root = candidateRoot;
            } else {
                root = [[NSFileManager defaultManager] currentDirectoryPath];
            }
        }

        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        AppDelegate *delegate = [[AppDelegate alloc] initWithProjectRoot:root];
        [app setDelegate:delegate];
        [app run];
    }
    return 0;
}

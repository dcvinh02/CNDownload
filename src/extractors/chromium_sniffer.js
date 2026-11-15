/**
 * Chromium Sniffer — bản tương đương WebKitSniffer (macOS) cho Windows (và mọi máy có Edge/Chrome).
 *
 * Mở trang (vd. trình phát chính thức open.douyin.com) trong Microsoft Edge / Google Chrome chạy ẩn (headless),
 * điều khiển bằng Chrome DevTools Protocol, và ghi nhận ĐÚNG những gì trang tự tải về như một trình duyệt bình
 * thường: phản hồi XHR/fetch có dữ liệu video (aweme_detail...), thẻ <video>, luồng mp4/m3u8, state SSR.
 * Không giải CAPTCHA, không vượt cơ chế bảo vệ: nếu trang đòi xác minh, kết quả báo hasCaptcha để người dùng
 * dùng Cookie của chính họ.
 *
 * Kết quả cùng định dạng với WebKitSniffer: { events: [{type, data}], finalInfo }.
 * Mỗi lần chạy dùng hồ sơ trình duyệt tạm riêng (xóa sau khi xong) — không đụng tới trình duyệt của người dùng.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function findChromiumBrowser() {
  const env = process.env;
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
          path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
          path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe')
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium'
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  if (env.CN_CHROMIUM_PATH) candidates.unshift(env.CN_CHROMIUM_PATH);
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function isAvailable() {
  return typeof WebSocket === 'function' && Boolean(findChromiumBrowser());
}

/* Script chèn vào mọi trang trước khi trang chạy — cùng logic với WebKitSniffer, báo qua binding CDP. */
const HOOK_JS = `(function() {
  if (window.__cnSnifferInstalled) return; window.__cnSnifferInstalled = true;
  const reportedUrls = new Set();
  function report(type, data) { try { window.__cnSniffer(JSON.stringify({ type: type, data: data })); } catch (e) {} }
  function isImageOrStatic(u) {
    const lower = u.split('?')[0].toLowerCase();
    return /\\.(jpg|jpeg|png|webp|avif|gif|svg|js|css|woff2)$/.test(lower);
  }
  function isVideoStreamUrl(u) {
    if (!u || !u.startsWith('http') || u.startsWith('blob:') || isImageOrStatic(u)) return false;
    const lower = u.toLowerCase();
    return lower.includes('.mp4') || lower.includes('.m3u8') || lower.includes('mime_type=video') ||
      lower.includes('aweme/v1/play') || (lower.includes('xhscdn.com') && lower.includes('stream'));
  }
  function isRelevantUrl(u) {
    if (!u) return false;
    const l = u.toLowerCase();
    return l.includes('aweme/detail') || l.includes('aweme/post') || l.includes('aweme/favorite') ||
      l.includes('user/profile') || l.includes('user/info') || l.includes('web/api/v2/aweme') ||
      l.includes('graphql') || l.includes('playurl') || l.includes('player/video') || l.includes('user_posted');
  }
  function hasMediaOrProfilePayload(text) {
    if (!text || text.length < 20) return false;
    return ['aweme_detail','aweme_list','play_addr','photoUrl','mp4Url','mainMvUrls','visionVideoDetail',
      'visionProfilePhotoList','visionProfile','user_profile','userInfo','"sec_uid"','"aweme_count"','"nickname"',
      'adaptationSet','originVideoKey','masterUrl','video_download','video_url','vlist','note_list','"notes"']
      .some((k) => text.includes(k));
  }
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) { this._sniffUrl = url ? String(url) : ''; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      try {
        const u = String(this._sniffUrl || this.responseURL || '');
        let txt = '';
        if (!this.responseType || this.responseType === 'text') txt = this.responseText || '';
        else if (this.responseType === 'json' && this.response) txt = JSON.stringify(this.response);
        if (txt && (hasMediaOrProfilePayload(txt) || isRelevantUrl(u))) report('xhr', { url: u, body: txt });
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function() {
      const a0 = arguments[0];
      const reqUrl = (typeof Request !== 'undefined' && a0 instanceof Request) ? a0.url : String((a0 && a0.url) || a0 || '');
      const res = await origFetch.apply(this, arguments);
      try {
        const u = res.url || reqUrl;
        res.clone().text().then((txt) => {
          if (txt && (hasMediaOrProfilePayload(txt) || isRelevantUrl(u))) report('fetch', { url: u, body: txt });
        }).catch(() => {});
      } catch (e) {}
      return res;
    };
  }
  let stateReported = false;
  setInterval(() => {
    try {
      for (const v of document.querySelectorAll('video, video source')) {
        const s = v.currentSrc || v.src;
        if (isVideoStreamUrl(s) && !reportedUrls.has(s)) { reportedUrls.add(s); report('video_dom', { src: s, title: document.title, href: location.href }); }
      }
      for (const r of performance.getEntriesByType('resource') || []) {
        const name = r.name || '';
        if (isVideoStreamUrl(name) && !reportedUrls.has(name)) { reportedUrls.add(name); report('resource_stream', { src: name, title: document.title, href: location.href }); }
      }
      if (!stateReported && (window.__APOLLO_STATE__ || window.INIT_STATE || window.__INITIAL_STATE__ || window._ROUTER_DATA || window._SSR_HYDRATED_DATA || window.ppxItemDetail || window.__RENDER_DATA__)) {
        const ssr = {};
        if (window.__APOLLO_STATE__) ssr.apollo = window.__APOLLO_STATE__;
        if (window.INIT_STATE) ssr.initState = window.INIT_STATE;
        if (window.__INITIAL_STATE__) ssr.initialState = window.__INITIAL_STATE__;
        if (window._ROUTER_DATA) ssr.routerData = window._ROUTER_DATA;
        if (window._SSR_HYDRATED_DATA) ssr.ssrHydrated = window._SSR_HYDRATED_DATA;
        if (window.ppxItemDetail) ssr.ppxItemDetail = window.ppxItemDetail;
        if (window.__RENDER_DATA__) ssr.renderData = window.__RENDER_DATA__;
        stateReported = true;
        report('window_state', { href: location.href, title: document.title, ssr: ssr });
      }
    } catch (e) {}
  }, 300);
})();`;

/* Tóm tắt trang khi kết thúc — KHÔNG trả về document.cookie (bảo vệ thông tin đăng nhập của người dùng). */
const DUMP_JS = `(function() {
  const href = location.href || '';
  const title = document.title || '';
  const bodyText = (document.body && document.body.innerText) || '';
  const capEl = document.querySelector('#captcha_container, .captcha-verify-container, .secsdk-captcha-wrapper, iframe[src*="verify"], iframe[src*="captcha"]');
  let capVisible = false;
  if (capEl) { const r = capEl.getBoundingClientRect(); capVisible = (r && r.width > 50 && r.height > 50) || capEl.tagName === 'IFRAME'; }
  const hasCaptcha = href.includes('verifycenter') || title.includes('验证码') || capVisible ||
    bodyText.includes('请完成下列验证后继续') || bodyText.includes('拖动滑块') || bodyText.includes('点击依次') || bodyText.includes('验证码中间页');
  const videoAnchors = Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/note/"], a[href*="/short-video/"], a[href*="/explore/"], a[href*="modal_id="]'));
  const allAnchors = Array.from(document.querySelectorAll('a[href]'));
  const seenHref = new Set(); const mergedLinks = [];
  // Khung danh sách bài đăng CỦA CHỦ TRANG (không gồm video gợi ý/SEO/xu hướng ở các khung khác)
  const OWNER_LIST_SEL = '[data-e2e="user-post-list"], #userPostedFeeds, .user-photo-list, [class*="user-photo-list"]';
  for (const a of [...videoAnchors, ...allAnchors]) {
    if (!a.href || seenHref.has(a.href)) continue;
    seenHref.add(a.href);
    const img = a.querySelector('img');
    const rawText = (a.innerText || a.getAttribute('title') || (img && img.getAttribute('alt')) || '').replace(/\\s+/g, ' ').trim();
    mergedLinks.push({ href: a.href, text: rawText.slice(0, 200), cover: (img && (img.src || img.getAttribute('data-src'))) || '', inOwnerList: !!(a.closest && a.closest(OWNER_LIST_SEL)) });
    if (mergedLinks.length >= 260) break;
  }
  const hasLoginWall = videoAnchors.length === 0 && (href.includes('/login') || bodyText.includes('登录后即可查看') || bodyText.includes('请先登录') || bodyText.includes('扫码登录'));
  const renderDataEl = document.getElementById('RENDER_DATA');
  let renderDataRaw = '';
  if (renderDataEl) { try { renderDataRaw = decodeURIComponent(renderDataEl.textContent || ''); } catch (e) { renderDataRaw = renderDataEl.textContent || ''; } }
  let parsedRenderSummary = null;
  if (renderDataRaw) {
    try {
      const rObj = JSON.parse(renderDataRaw);
      for (const v of Object.values(rObj)) {
        if (!v || typeof v !== 'object') continue;
        const u = (v.user && v.user.user) || v.userInfo || v.user;
        const p = (v.post && v.post.data) || v.awemeList;
        if (u || p) { parsedRenderSummary = { user: u || null, posts: Array.isArray(p) ? p.slice(0, 60) : null }; break; }
      }
    } catch (e) {}
  }
  const h1El = document.querySelector('[data-e2e="user-info"] h1, h1, .user-name, .user-info-name');
  const avatarEl = document.querySelector('[data-e2e="user-info"] img, .avatar img, img.avatar');
  const descEl = document.querySelector('[data-e2e="user-desc"], [data-e2e="user-signature"], .user-desc');
  return JSON.stringify({
    href, title, hasCaptcha, hasLoginWall,
    domProfile: { nickname: h1El ? (h1El.innerText || '').trim() : '', avatar: avatarEl ? (avatarEl.src || '') : '', signature: descEl ? (descEl.innerText || '').trim() : '' },
    parsedRenderSummary,
    renderDataSnippet: parsedRenderSummary ? '' : (renderDataRaw ? renderDataRaw.slice(0, 500000) : ''),
    links: mergedLinks
  });
})()`;

function parseCookieHeader(header, targetUrl) {
  const out = [];
  let host = '';
  try {
    host = new URL(targetUrl).hostname;
  } catch (_) {
    return out;
  }
  const parts = host.split('.');
  const domain = parts.length >= 2 ? `.${parts.slice(-2).join('.')}` : host;
  const clean = String(header || '').replace(/^cookie:\s*/i, '');
  for (const pair of clean.split(';')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (name) out.push({ name, value, domain, path: '/', secure: true });
  }
  return out;
}

const PROFILE_KEYS = ['"aweme_list"', '"visionProfilePhotoList"', '"note_list"', '"vlist"'];
const MEDIA_KEYS = ['"type":"video_dom"', '"type":"resource_stream"', '"aweme_detail"', '"aweme_list"', '"photoUrl"', '"mp4Url"', '"visionProfilePhotoList"', '"adaptationSet"', '"originVideoKey"'];

/**
 * @returns {Promise<{events: Array, finalInfo: object|null, engine: string, error?: string}>}
 */
function runChromiumSniffer(targetUrl, userAgent, timeoutMs = 8000, opts = {}) {
  return new Promise((resolve) => {
    const browser = findChromiumBrowser();
    if (!browser || typeof WebSocket !== 'function') {
      resolve({ events: [], finalInfo: null, engine: 'chromium', error: 'Không tìm thấy Microsoft Edge / Google Chrome.' });
      return;
    }
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-sniffer-'));
    const isMobile = /iPhone|Android|Mobile/i.test(userAgent || '');
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      isMobile ? '--window-size=390,844' : '--window-size=1280,800',
      'about:blank'
    ];
    let proc;
    try {
      proc = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ events: [], finalInfo: null, engine: 'chromium', error: err.message });
      return;
    }
    if (typeof opts.onProc === 'function') opts.onProc(proc);

    const events = [];
    let finalInfo = null;
    let settled = false;
    let ws = null;
    let msgId = 0;
    const pending = new Map();
    let sessionId = null;
    let finishing = false;
    let scrollsDone = 0;
    let scrollStarted = false;
    const maxScroll = Math.max(0, Math.min(6, Number(opts.scrollCount) || 0));
    // Thêm thời gian khởi động trình duyệt (~1–3 s) so với WebKitSniffer
    const budgetMs = (opts.profileMode ? (12 + maxScroll * 2) * 1000 : timeoutMs) + 4000;

    const cleanup = () => {
      try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ id: ++msgId, method: 'Browser.close' }));
      } catch (_) {}
      setTimeout(() => {
        try {
          proc.kill();
        } catch (_) {}
        setTimeout(() => fs.rm(profileDir, { recursive: true, force: true }, () => {}), 1500);
      }, 600);
    };
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      cleanup();
      resolve({ events, finalInfo, engine: 'chromium', ...extra });
    };
    const hardTimer = setTimeout(() => dumpAndFinish(), budgetMs);

    const send = (method, params = {}, withSession = true) =>
      new Promise((res, rej) => {
        if (!ws || ws.readyState !== 1) return rej(new Error('CDP chưa kết nối'));
        const id = ++msgId;
        pending.set(id, { res, rej });
        const msg = { id, method, params };
        if (withSession && sessionId) msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
      });

    async function dumpAndFinish() {
      if (finishing) return;
      finishing = true;
      try {
        const r = await Promise.race([
          send('Runtime.evaluate', { expression: DUMP_JS, returnByValue: true }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('dump timeout')), 3000))
        ]);
        if (r && r.result && typeof r.result.value === 'string') finalInfo = JSON.parse(r.result.value);
      } catch (_) {}
      finish();
    }

    function scrollStep() {
      if (settled || finishing) return;
      if (scrollsDone >= maxScroll) {
        setTimeout(dumpAndFinish, 1200);
        return;
      }
      scrollsDone += 1;
      send('Runtime.evaluate', { expression: "window.scrollTo({ top: document.body.scrollHeight || 4000, behavior: 'smooth' })" }).catch(() => {});
      setTimeout(scrollStep, 1600);
    }

    function onReport(payload) {
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch (_) {
        return;
      }
      events.push(ev);
      if (finishing) return;
      if (opts.profileMode) {
        if (PROFILE_KEYS.some((k) => payload.includes(k))) {
          if (!scrollStarted && maxScroll > 0) {
            scrollStarted = true;
            setTimeout(scrollStep, 800);
          } else if (maxScroll === 0) {
            setTimeout(dumpAndFinish, 1200);
          }
        }
        return;
      }
      if (MEDIA_KEYS.some((k) => payload.includes(k))) setTimeout(dumpAndFinish, 500);
    }

    async function connect(wsUrl) {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString());
        } catch (_) {
          return;
        }
        if (m.id && pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (m.error) p.rej(new Error(m.error.message));
          else p.res(m.result);
          return;
        }
        if (m.method === 'Runtime.bindingCalled' && m.params && m.params.name === '__cnSniffer') onReport(m.params.payload);
      };
      ws.onerror = () => {};
      ws.onclose = () => finish();
      await new Promise((res, rej) => {
        ws.onopen = res;
        setTimeout(() => rej(new Error('Không kết nối được DevTools')), 5000);
      });
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
      ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, false));
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Network.enable');
      await send('Runtime.addBinding', { name: '__cnSniffer' });
      if (userAgent) await send('Network.setUserAgentOverride', { userAgent });
      if (isMobile) {
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }).catch(() => {});
        await send('Emulation.setTouchEmulationEnabled', { enabled: true }).catch(() => {});
      }
      const cookies = parseCookieHeader(opts.cookie, targetUrl);
      if (cookies.length) await send('Network.setCookies', { cookies }).catch(() => {});
      await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_JS });
      await send('Page.navigate', { url: targetUrl });
    }

    let stderrBuf = '';
    proc.stderr.on('data', (d) => {
      if (ws) return;
      stderrBuf += d.toString();
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        connect(m[1]).catch((err) => finish({ error: `CDP: ${err.message}` }));
      }
    });
    proc.on('error', (err) => finish({ error: err.message }));
    proc.on('exit', () => {
      if (!settled) finish({ error: 'Trình duyệt dừng sớm.' });
    });
  });
}

module.exports = { runChromiumSniffer, findChromiumBrowser, isAvailable, _internals: { HOOK_JS, DUMP_JS, parseCookieHeader } };

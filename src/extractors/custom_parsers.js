/**
 * Bộ Custom Parsers chuyên biệt cho 12 nền tảng Video Trung Quốc
 * Tích hợp Smart Auto-Discovery:
 *  - Tự động chuyển đổi mọi link thường sang Mobile H5 UTM / Open Player / oEmbed
 *  - Kết hợp Native WebKitSniffer (macOS) + SSR State (INIT_STATE, __APOLLO_STATE__, __INITIAL_STATE__, _ROUTER_DATA)
 */

const cheerio = require('cheerio');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { PLATFORMS, extractVideoId } = require('./platforms');

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Chạy binary macOS WebKitSniffer để thực thi JS bảo mật (webmssdk / a_bogus / Kuaishou H5 INIT_STATE / XHS)
 * và bắt trực tiếp gói tin JSON XHR/Fetch + Window SSR State + thẻ <video src="...">
 */
async function fallbackHttpSsrSniffer(targetUrl, userAgent = DESKTOP_UA, timeoutMs = 6000, snifferOptions = {}) {
  const events = [];
  let finalInfo = null;
  try {
    const reqHeaders = {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
    if (snifferOptions && snifferOptions.cookie) {
      reqHeaders.Cookie = snifferOptions.cookie;
    }
    const res = await fetch(targetUrl, {
      headers: reqHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    const hasCaptcha =
      html.includes('验证码') || html.includes('请完成验证') || html.includes('captcha_container');
    const hasLoginWall =
      html.includes('登录后即可') || html.includes('请先登录') || html.includes('扫码登录');
    let renderDataSnippet = '';
    const renderDataRaw = $('#RENDER_DATA').html() || '';
    if (renderDataRaw) {
      try {
        renderDataSnippet = decodeURIComponent(renderDataRaw).slice(0, 120000);
      } catch (_) {
        renderDataSnippet = renderDataRaw.slice(0, 120000);
      }
    }
    finalInfo = {
      title: ($('title').first().text() || '').trim(),
      href: res.url || targetUrl,
      hasCaptcha,
      hasLoginWall,
      renderDataSnippet
    };

    const videoSrc = $('video').attr('src') || $('video source').attr('src');
    if (videoSrc && videoSrc.startsWith('http')) {
      events.push({ type: 'video_dom', url: res.url || targetUrl, data: { src: videoSrc, title: finalInfo.title } });
    }

    const scripts = $('script').map((_, el) => $(el).html() || '').get();
    for (const sc of scripts) {
      for (const key of ['INIT_STATE', '__INITIAL_STATE__', '_ROUTER_DATA', '__APOLLO_STATE__']) {
        const idx = sc.indexOf(`window.${key}`);
        if (idx !== -1) {
          const eqIdx = sc.indexOf('=', idx);
          if (eqIdx !== -1) {
            const rawJson = sc.slice(eqIdx + 1).trim().replace(/;\s*$/, '');
            try {
              const parsed = JSON.parse(rawJson);
              events.push({ type: 'window_state', key, url: res.url || targetUrl, data: parsed });
            } catch {}
          }
        }
      }
    }
  } catch {}
  return {
    events,
    finalInfo,
    usedFallback: true,
    unsupportedReason:
      process.platform !== 'darwin'
        ? 'WebKitSniffer chỉ chạy trên macOS; đã dùng bộ trích xuất SSR HTTP thay thế trên hệ điều hành hiện tại.'
        : 'Không tìm thấy binary WebKitSniffer; đã dùng bộ trích xuất SSR HTTP thay thế.'
  };
}

function runWebKitSniffer(targetUrl, userAgent = DESKTOP_UA, timeoutMs = 8000, snifferOptions = {}) {
  return new Promise((resolve) => {
    const snifferBin = path.join(__dirname, '..', '..', 'bin', 'WebKitSniffer');
    if (process.platform !== 'darwin' || !fs.existsSync(snifferBin)) {
      fallbackHttpSsrSniffer(targetUrl, userAgent, Math.min(timeoutMs, 6000), snifferOptions).then(resolve);
      return;
    }

    try {
      fs.accessSync(snifferBin, fs.constants.X_OK);
    } catch {
      fallbackHttpSsrSniffer(targetUrl, userAgent, Math.min(timeoutMs, 6000), snifferOptions).then(resolve);
      return;
    }

    const childEnv = { ...process.env };
    if (snifferOptions && snifferOptions.cookie) {
      childEnv.SNIFFER_COOKIE = String(snifferOptions.cookie);
    }
    if (snifferOptions && snifferOptions.profileMode) {
      childEnv.SNIFFER_PROFILE_MODE = '1';
    }
    if (snifferOptions && typeof snifferOptions.scrollCount === 'number') {
      childEnv.SNIFFER_SCROLL_COUNT = String(snifferOptions.scrollCount);
    }

    let proc;
    try {
      proc = spawn(snifferBin, [targetUrl, userAgent], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: childEnv
      });
      if (snifferOptions && typeof snifferOptions.onProc === 'function') {
        snifferOptions.onProc(proc);
      }
    } catch {
      fallbackHttpSsrSniffer(targetUrl, userAgent, Math.min(timeoutMs, 6000), snifferOptions).then(resolve);
      return;
    }

    let stdout = '';
    const events = [];
    let finalInfo = null;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      finish({ events, finalInfo });
    }, timeoutMs);

    const processLine = (line) => {
      if (line.startsWith('SNIFF_EVENT:')) {
        try {
          events.push(JSON.parse(line.slice('SNIFF_EVENT:'.length)));
        } catch {}
      } else if (line.startsWith('SNIFF_FINAL:')) {
        try {
          finalInfo = JSON.parse(line.slice('SNIFF_FINAL:'.length));
        } catch {}
      }
    };

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    });

    proc.on('error', () => {
      fallbackHttpSsrSniffer(targetUrl, userAgent, 4000).then(finish);
    });

    proc.on('close', () => {
      if (stdout) processLine(stdout);
      finish({ events, finalInfo });
    });
  });
}

/**
 * Theo dõi chuỗi Redirect (301/302) nhanh với timeout ngắn (3.5s) để không bị treo nếu IP chặn
 */
async function resolveRedirect(initialUrl, options = {}) {
  const ua = options.mobile ? MOBILE_UA : DESKTOP_UA;
  const headers = {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,vi;q=0.7',
    ...(options.headers || {})
  };
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }

  let currentUrl = initialUrl;
  const redirectChain = [currentUrl];
  const collectedCookies = [];

  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(currentUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(4000)
      });

      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of setCookie) {
        const pair = c.split(';')[0];
        if (pair && !collectedCookies.includes(pair)) collectedCookies.push(pair);
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        currentUrl = new URL(loc, currentUrl).toString();
        redirectChain.push(currentUrl);
        if (collectedCookies.length > 0 && !options.cookie) {
          headers.Cookie = collectedCookies.join('; ');
        }
        continue;
      }

      const html = await res.text();
      return {
        finalUrl: currentUrl,
        redirectChain,
        status: res.status,
        html,
        cookies: collectedCookies.join('; ')
      };
    } catch (err) {
      return {
        finalUrl: currentUrl,
        redirectChain,
        status: 0,
        html: '',
        cookies: collectedCookies.join('; '),
        error: err.message
      };
    }
  }

  return {
    finalUrl: currentUrl,
    redirectChain,
    status: 200,
    html: '',
    cookies: collectedCookies.join('; ')
  };
}

/**
 * 1. Parser cho Bilibili (哔哩哔哩)
 */
async function parseBilibili(urlInfo, options = {}) {
  let bvid = urlInfo.videoId;
  let aid = null;

  if (bvid && bvid.toLowerCase().startsWith('av')) {
    aid = bvid.slice(2);
    bvid = null;
  }

  if (!bvid && !aid) {
    const m = urlInfo.resolvedUrl.match(/\/(BV[a-zA-Z0-9]{10})/i);
    if (m) bvid = m[1];
  }

  if (!bvid && !aid) {
    throw new Error('Không tìm thấy mã BVid hoặc AVid hợp lệ của Bilibili.');
  }

  const queryParam = bvid ? `bvid=${bvid}` : `aid=${aid}`;
  const viewApi = `https://api.bilibili.com/x/web-interface/view?${queryParam}`;
  const headers = {
    'User-Agent': DESKTOP_UA,
    Referer: 'https://www.bilibili.com/'
  };
  if (options.cookie) headers.Cookie = options.cookie;

  const viewRes = await fetch(viewApi, { headers, signal: AbortSignal.timeout(10000) });
  const viewJson = await viewRes.json();

  if (viewJson.code !== 0 || !viewJson.data) {
    throw new Error(`Bilibili API trả về lỗi: ${viewJson.message || 'Không xác định'}`);
  }

  const data = viewJson.data;
  const cid = data.cid || (data.pages && data.pages[0] && data.pages[0].cid);
  const realBvid = data.bvid || bvid;

  const playApiHd = `https://api.bilibili.com/x/player/playurl?bvid=${realBvid}&cid=${cid}&qn=80&fnval=1&platform=html5&high_quality=1`;
  const playApiFast = `https://api.bilibili.com/x/player/playurl?bvid=${realBvid}&cid=${cid}&qn=16&fnval=1&platform=html5&high_quality=0`;
  const [playResHd, playResFast] = await Promise.all([
    fetch(playApiHd, { headers, signal: AbortSignal.timeout(10000) }),
    fetch(playApiFast, { headers, signal: AbortSignal.timeout(10000) }).catch(() => null)
  ]);
  const playJson = await playResHd.json();
  const playJsonFast = playResFast ? await playResFast.json().catch(() => null) : null;

  const formats = [];
  let directVideoUrl = null;

  if (playJson.code === 0 && playJson.data && Array.isArray(playJson.data.durl)) {
    for (const item of playJson.data.durl) {
      directVideoUrl = item.url;
      const sizeMB = item.size ? ` • ${(item.size / 1024 / 1024).toFixed(1)} MB` : '';
      formats.push({
        formatId: `html5-qn${playJson.data.quality || 64}`,
        quality: `${playJson.data.quality >= 80 ? '1080P Full HD' : '720P HD'} (MP4${sizeMB})`,
        ext: 'mp4',
        size: item.size || null,
        url: item.url,
        hasAudio: true,
        noWatermark: true,
        headers: {
          Referer: 'https://www.bilibili.com/',
          'User-Agent': DESKTOP_UA
        }
      });
    }
  }

  if (playJsonFast && playJsonFast.code === 0 && playJsonFast.data && Array.isArray(playJsonFast.data.durl)) {
    for (const item of playJsonFast.data.durl) {
      if (item.url && item.url !== directVideoUrl) {
        const sizeMB = item.size ? ` • ${(item.size / 1024 / 1024).toFixed(1)} MB` : '';
        formats.push({
          formatId: `html5-fast-qn${playJsonFast.data.quality || 16}`,
          quality: `360P Fast MP4 (Tải nhanh${sizeMB})`,
          ext: 'mp4',
          size: item.size || null,
          url: item.url,
          hasAudio: true,
          noWatermark: true,
          headers: {
            Referer: 'https://www.bilibili.com/',
            'User-Agent': DESKTOP_UA
          }
        });
      }
    }
  }

  return {
    platform: 'bilibili',
    platformName: PLATFORMS.bilibili.name,
    videoId: realBvid,
    cid,
    title: data.title,
    description: data.desc || '',
    author: data.owner ? data.owner.name : 'Bilibili User',
    authorAvatar: data.owner ? data.owner.face : '',
    cover: data.pic ? data.pic.replace(/^http:/, 'https:') : '',
    duration: data.duration || 0,
    stats: {
      views: data.stat?.view || 0,
      likes: data.stat?.like || 0,
      coins: data.stat?.coin || 0,
      favorites: data.stat?.favorite || 0,
      shares: data.stat?.share || 0,
      comments: data.stat?.reply || 0
    },
    embedUrl: `https://player.bilibili.com/player.html?bvid=${realBvid}&cid=${cid}&high_quality=1`,
    directVideoUrl,
    formats,
    downloadHeaders: {
      Referer: 'https://www.bilibili.com/',
      'User-Agent': DESKTOP_UA
    },
    engine: 'Native Bilibili WebAPI + HTML5 Player (No-Watermark)'
  };
}

/**
 * 2. Parser cho Pipixia (皮皮虾)
 */
async function parsePipixia(urlInfo, options = {}) {
  let itemId = urlInfo.videoId;
  if (!itemId) {
    const m =
      urlInfo.resolvedUrl.match(/\/item\/(\d+)/) ||
      urlInfo.resolvedUrl.match(/item_id=(\d+)/) ||
      urlInfo.resolvedUrl.match(/cell_id=(\d+)/);
    if (m) itemId = m[1];
  }

  // Nếu là link rút gọn h5.pipix.com/s/ chưa giải mã được, dùng WebKitSniffer để giải mã
  if (!itemId) {
    const sniff = await runWebKitSniffer(urlInfo.inputUrl, MOBILE_UA, 7000);
    const finalHref = sniff.finalInfo?.href || '';
    itemId = extractVideoId('pipixia', finalHref);
  }

  if (!itemId) {
    throw new Error('Không tách được item_id từ link Pipixia (皮皮虾).');
  }

  const apiUrl = `https://h5.pipix.com/bds/webapi/item/detail/?item_id=${itemId}&source=share`;
  const headers = {
    'User-Agent': MOBILE_UA,
    Referer: `https://h5.pipix.com/item/${itemId}?source=share`
  };
  if (options.cookie) headers.Cookie = options.cookie;

  const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(10000) });
  const json = await res.json();

  const item = json?.data?.item;
  if (!item) {
    throw new Error('Pipixia API không trả về dữ liệu item hợp lệ.');
  }

  const videoObj =
    item.origin_video_download ||
    item.video?.video_download ||
    item.video?.video_high ||
    item.video?.video_fallback;
  const urlList = videoObj?.url_list || [];
  const directVideoUrl = urlList[0]?.url || null;

  const formats = urlList.map((u, idx) => ({
    formatId: `ppx-hd-${idx + 1}`,
    quality: `${videoObj.width || 720}×${videoObj.height || 1280} HD (Mirror ${idx + 1})`,
    ext: 'mp4',
    url: u.url,
    hasAudio: true,
    noWatermark: true,
    headers: { 'User-Agent': MOBILE_UA }
  }));

  return {
    platform: 'pipixia',
    platformName: PLATFORMS.pipixia.name,
    videoId: itemId,
    title: item.content || item.share?.title || `Pipixia Video ${itemId}`,
    description: item.content || '',
    author: item.author?.name || 'Pipixia Creator',
    authorAvatar: item.author?.avatar?.url_list?.[0]?.url || '',
    cover: videoObj?.cover_image?.url_list?.[0]?.url || item.cover?.url_list?.[0]?.url || '',
    duration: Math.round(videoObj?.duration || 0),
    stats: {
      views: item.stats?.play_count || 0,
      likes: item.stats?.like_count || 0,
      comments: item.stats?.comment_count || 0,
      shares: item.stats?.share_count || 0
    },
    embedUrl: apiUrl,
    directVideoUrl,
    formats,
    downloadHeaders: { 'User-Agent': MOBILE_UA },
    engine: 'Native Pipixia H5 WebAPI (No-Watermark)'
  };
}

/**
 * 3. Parser cho Douyin (抖音)
 * Tự động giải mã mọi link Douyin (jingxuan?modal_id=..., v.douyin.com/..., douyin.com/video/...)
 * và ký a_bogus qua WebKit Open Player
 */
async function parseDouyin(urlInfo, options = {}) {
  let videoId = urlInfo.videoId;
  if (!videoId) {
    const m =
      urlInfo.resolvedUrl.match(/\/(?:video|note)\/(\d{15,22})/) ||
      urlInfo.resolvedUrl.match(/modal_id=(\d{15,22})/) ||
      urlInfo.resolvedUrl.match(/vid=(\d{15,22})/);
    if (m) videoId = m[1];
  }

  // Nếu người dùng dán link rút gọn v.douyin.com mà chưa giải mã được ID, dùng WebKitSniffer để lấy URL đích
  if (!videoId) {
    const preSniff = await runWebKitSniffer(urlInfo.inputUrl, MOBILE_UA, 6500, { cookie: options.cookie });
    const href = preSniff.finalInfo?.href || '';
    videoId = extractVideoId('douyin', href);
  }

  if (!videoId) {
    throw new Error('Không tìm thấy mã Video ID (aweme_id / modal_id) trong link Douyin.');
  }

  const playerUrl = `https://open.douyin.com/player/video?vid=${videoId}&autoplay=1`;
  const iframeApiUrl = `https://open.douyin.com/api/douyin/v1/video/get_iframe_by_video?video_id=${videoId}`;

  const [iframeInfo, sniffRes] = await Promise.all([
    fetch(iframeApiUrl, { headers: { 'User-Agent': DESKTOP_UA }, signal: AbortSignal.timeout(7000) })
      .then((r) => r.json())
      .catch(() => null),
    runWebKitSniffer(playerUrl, DESKTOP_UA, 8500, { cookie: options.cookie })
  ]);

  let awemeDetail = null;
  let domVideoSrc = null;

  for (const ev of sniffRes.events || []) {
    if ((ev.type === 'xhr' || ev.type === 'fetch') && ev.data?.body) {
      try {
        const parsed = JSON.parse(ev.data.body);
        if (parsed.aweme_detail) {
          awemeDetail = parsed.aweme_detail;
        } else if (parsed.item_list && parsed.item_list[0]) {
          awemeDetail = parsed.item_list[0];
        }
      } catch {}
    } else if ((ev.type === 'video_dom' || ev.type === 'resource_stream') && ev.data?.src) {
      if (!domVideoSrc) domVideoSrc = ev.data.src;
    }
  }

  const dlHeaders = {
    'User-Agent': DESKTOP_UA,
    Referer: 'https://open.douyin.com/'
  };

  if (awemeDetail) {
    const video = awemeDetail.video || {};
    const formats = [];
    const seenUrls = new Set();

    const h264Urls = video.play_addr_h264?.url_list || [];
    for (const u of h264Urls) {
      if (u && u.startsWith('http') && !u.includes('douyin.com/aweme/v1/play') && !seenUrls.has(u)) {
        seenUrls.add(u);
        const sizeMB = video.play_addr_h264.data_size
          ? ` • ${(video.play_addr_h264.data_size / 1024 / 1024).toFixed(1)} MB`
          : '';
        formats.push({
          formatId: 'douyin-h264-1080p',
          quality: `1080P Full HD (${video.play_addr_h264.width || 1920}×${video.play_addr_h264.height || 1080} • H.264${sizeMB})`,
          ext: 'mp4',
          size: video.play_addr_h264.data_size || null,
          url: u,
          hasAudio: true,
          noWatermark: true,
          headers: dlHeaders
        });
        break;
      }
    }

    const bitRates = Array.isArray(video.bit_rate) ? [...video.bit_rate] : [];
    bitRates.sort((a, b) => (a.is_h265 || 0) - (b.is_h265 || 0));

    for (const br of bitRates) {
      const playAddr = br.play_addr;
      const u = (playAddr?.url_list || []).find((link) => link && !link.includes('douyin.com/aweme/v1/play'));
      if (u && !seenUrls.has(u)) {
        seenUrls.add(u);
        const codecLabel = br.is_h265 ? 'H.265' : 'H.264';
        const sizeMB = playAddr.data_size ? ` • ${(playAddr.data_size / 1024 / 1024).toFixed(1)} MB` : '';
        formats.push({
          formatId: `dy-${br.gear_name || 'stream'}`,
          quality: `${playAddr.height || 720}P (${playAddr.width || 1280}×${playAddr.height || 720} • ${codecLabel}${sizeMB})`,
          ext: 'mp4',
          size: playAddr.data_size || null,
          url: u,
          hasAudio: true,
          noWatermark: true,
          headers: dlHeaders
        });
      }
    }

    const fallbackUrl =
      domVideoSrc ||
      (video.play_addr?.url_list || []).find((u) => u && !u.includes('douyin.com/aweme/v1/play')) ||
      video.play_addr?.url_list?.[0];

    if (fallbackUrl && !seenUrls.has(fallbackUrl)) {
      formats.push({
        formatId: 'douyin-default-nowm',
        quality: `Original Stream (${video.width || 1920}×${video.height || 1080})`,
        ext: 'mp4',
        size: video.play_addr?.data_size || null,
        url: fallbackUrl,
        hasAudio: true,
        noWatermark: true,
        headers: dlHeaders
      });
    }

    const directVideoUrl = (formats[0] && formats[0].url) || domVideoSrc;
    const coverUrl =
      video.origin_cover?.url_list?.[0] ||
      video.cover?.url_list?.[0] ||
      video.dynamic_cover?.url_list?.[0] ||
      '';

    return {
      platform: 'douyin',
      platformName: PLATFORMS.douyin.name,
      videoId,
      title: awemeDetail.desc || iframeInfo?.data?.video_title || `Douyin Video ${videoId}`,
      description: awemeDetail.desc || '',
      author: awemeDetail.author?.nickname || 'Douyin Creator',
      authorAvatar: awemeDetail.author?.avatar_thumb?.url_list?.[0] || '',
      cover: coverUrl,
      duration: Math.round((video.duration || 0) / 1000),
      width: video.width || iframeInfo?.data?.video_width || 1920,
      height: video.height || iframeInfo?.data?.video_height || 1080,
      stats: {
        likes: awemeDetail.statistics?.digg_count || 0,
        comments: awemeDetail.statistics?.comment_count || 0,
        shares: awemeDetail.statistics?.share_count || 0,
        favorites: awemeDetail.statistics?.collect_count || 0
      },
      embedUrl: `https://open.douyin.com/player/video?vid=${videoId}&autoplay=0`,
      directVideoUrl,
      formats,
      downloadHeaders: dlHeaders,
      engine: 'Native Douyin WebKit a_bogus Signer + Open Player'
    };
  }

  if (domVideoSrc) {
    return {
      platform: 'douyin',
      platformName: PLATFORMS.douyin.name,
      videoId,
      title: iframeInfo?.data?.video_title || `Douyin Video ${videoId}`,
      description: iframeInfo?.data?.video_title || '',
      author: 'Douyin Creator',
      cover: '',
      duration: 0,
      width: iframeInfo?.data?.video_width || 1920,
      height: iframeInfo?.data?.video_height || 1080,
      stats: {},
      embedUrl: `https://open.douyin.com/player/video?vid=${videoId}&autoplay=0`,
      directVideoUrl: domVideoSrc,
      formats: [
        {
          formatId: 'douyin-dom-stream',
          quality: 'HD MP4 Stream (No Watermark)',
          ext: 'mp4',
          url: domVideoSrc,
          hasAudio: true,
          noWatermark: true,
          headers: dlHeaders
        }
      ],
      downloadHeaders: dlHeaders,
      engine: 'Native Douyin WebKit DOM Stream Extractor'
    };
  }

  throw new Error('Không bắt được luồng video từ Douyin Open Player.');
}

/**
 * 4. Parser cho Kuaishou (快手) - KHÔNG CẦN NGƯỜI DÙNG TỰ LẤY LINK UTM!
 * Người dùng chỉ cần dán bất kỳ link nào (kuaishou.com/short-video/..., v.kuaishou.com/..., kuaishou.com/f/...),
 * hệ thống tự động chuyển đổi sang Mobile H5 UTM (c.kuaishou.com/fw/photo/{id}?fid=1234&cc=share_copylink)
 * và trích xuất mainMvUrls + video_dom qua WebKitSniffer không dính Captcha!
 */
async function parseKuaishou(urlInfo, options = {}) {
  let photoId = urlInfo.videoId;

  // Nếu có photoId sẵn (ví dụ từ kuaishou.com/short-video/{id}), tự động tạo link Mobile H5 kèm UTM giả lập
  const sniffTargetUrl = photoId
    ? `https://c.kuaishou.com/fw/photo/${photoId}?fid=1234&cc=share_copylink&utm_source=app_share`
    : urlInfo.inputUrl;

  const sniffRes = await runWebKitSniffer(sniffTargetUrl, MOBILE_UA, 8000, { cookie: options.cookie });

  let photoObj = null;
  let domVideoSrc = null;
  const formats = [];
  const seenUrls = new Set();
  const dlHeaders = {
    'User-Agent': MOBILE_UA,
    Referer: 'https://c.kuaishou.com/'
  };

  for (const ev of sniffRes.events || []) {
    if (ev.type === 'window_state' && ev.data?.ssr?.initState) {
      const init = ev.data.ssr.initState;
      for (const val of Object.values(init)) {
        if (val && typeof val === 'object' && val.photo && (val.photo.mainMvUrls || val.photo.caption || val.photo.manifest)) {
          photoObj = val.photo;
          break;
        }
      }
    } else if ((ev.type === 'video_dom' || ev.type === 'resource_stream') && ev.data?.src) {
      const s = ev.data.src;
      if (s.startsWith('http') && !seenUrls.has(s)) {
        seenUrls.add(s);
        if (!domVideoSrc) domVideoSrc = s;
        formats.push({
          formatId: `ks-hd-${formats.length + 1}`,
          quality: s.includes('hd15') ? '1080P Full HD (Kuaishou Direct MP4)' : 'HD MP4 Stream (No Watermark)',
          ext: 'mp4',
          url: s,
          hasAudio: true,
          noWatermark: true,
          headers: dlHeaders
        });
      }
    }
  }

  if (photoObj) {
    if (!photoId) {
      photoId = photoObj.photoId || photoObj.id || extractVideoId('kuaishou', sniffRes.finalInfo?.href || '');
    }
    const mvUrls = photoObj.mainMvUrls || photoObj.ext_params?.video?.mainMvUrls || [];
    for (let i = 0; i < mvUrls.length; i++) {
      const u = mvUrls[i]?.url;
      if (u && u.startsWith('http') && !seenUrls.has(u)) {
        seenUrls.add(u);
        if (!domVideoSrc) domVideoSrc = u;
        formats.push({
          formatId: `ks-mainmv-${i + 1}`,
          quality: `Original Mobile MP4 (CDN ${i + 1} • Không Watermark)`,
          ext: 'mp4',
          url: u,
          hasAudio: true,
          noWatermark: true,
          headers: dlHeaders
        });
      }
    }

    const coverUrl =
      photoObj.coverUrls?.[0]?.url ||
      photoObj.headUrls?.[0]?.url ||
      '';

    if (domVideoSrc || formats.length > 0) {
      return {
        platform: 'kuaishou',
        platformName: PLATFORMS.kuaishou.name,
        videoId: photoId || 'ks_video',
        title: photoObj.caption || `Kuaishou Video ${photoId || ''}`,
        description: photoObj.caption || '',
        author: photoObj.userName || 'Kuaishou Creator',
        authorAvatar: photoObj.headUrl || photoObj.headUrls?.[0]?.url || '',
        cover: coverUrl,
        duration: Math.round((photoObj.duration || 0) / 1000),
        width: photoObj.width || 1080,
        height: photoObj.height || 1920,
        stats: {
          likes: photoObj.likeCount || photoObj.realLikeCount || 0,
          views: photoObj.viewCount || 0,
          comments: photoObj.commentCount || 0,
          shares: photoObj.shareCount || 0
        },
        embedUrl: `https://c.kuaishou.com/fw/photo/${photoId || ''}?fid=1234&cc=share_copylink`,
        directVideoUrl: formats[0]?.url || domVideoSrc,
        formats,
        downloadHeaders: dlHeaders,
        engine: 'Native Kuaishou Auto-UTM H5 + WebKit Extractor (No-Watermark)'
      };
    }
  }

  if (domVideoSrc) {
    return {
      platform: 'kuaishou',
      platformName: PLATFORMS.kuaishou.name,
      videoId: photoId || 'ks_video',
      title: sniffRes.finalInfo?.title || `Kuaishou Video ${photoId || ''}`,
      description: '',
      author: 'Kuaishou Creator',
      cover: '',
      duration: 0,
      stats: {},
      embedUrl: sniffTargetUrl,
      directVideoUrl: domVideoSrc,
      formats,
      downloadHeaders: dlHeaders,
      engine: 'Native Kuaishou WebKit Stream Extractor'
    };
  }

  throw new Error('Không tìm thấy luồng video Kuaishou (Hãy kiểm tra lại đường dẫn video).');
}

/**
 * 5. Parser cho Xiaohongshu (小红书 - Tiểu Hồng Thư)
 * Tự động dùng cả HTML SSR lẫn WebKitSniffer để bóc tách originVideoKey / stream H264
 */
async function parseXiaohongshu(urlInfo, options = {}) {
  let stateJson = null;
  const html = urlInfo.html || '';

  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})<\/script>/);
  if (stateMatch) {
    try {
      stateJson = JSON.parse(stateMatch[1].replace(/:\s*undefined/g, ': null'));
    } catch {}
  }

  let domVideoSrc = null;
  if (!stateJson) {
    const sniff = await runWebKitSniffer(urlInfo.inputUrl, DESKTOP_UA, 8000, { cookie: options.cookie });
    for (const ev of sniff.events || []) {
      if (ev.type === 'window_state' && ev.data?.ssr?.initialState) {
        stateJson = ev.data.ssr.initialState;
      } else if ((ev.type === 'video_dom' || ev.type === 'resource_stream') && ev.data?.src) {
        if (!domVideoSrc) domVideoSrc = ev.data.src;
      }
    }
  }

  const dlHeaders = {
    'User-Agent': DESKTOP_UA,
    Referer: 'https://www.xiaohongshu.com/'
  };

  if (stateJson) {
    const noteId =
      urlInfo.videoId ||
      stateJson.note?.firstNoteId ||
      Object.keys(stateJson.note?.noteDetailMap || {})[0];
    const note =
      stateJson.note?.noteDetailMap?.[noteId]?.note ||
      stateJson.noteData?.data?.noteData ||
      stateJson.note?.noteData;

    if (note) {
      const originKey = note.video?.consumer?.originVideoKey || note.video?.consumer?.origin_video_key;
      const h264Streams = note.video?.media?.stream?.h264 || [];
      const h265Streams = note.video?.media?.stream?.h265 || [];

      const formats = [];
      let directVideoUrl = null;

      if (originKey) {
        directVideoUrl = `https://sns-video-bd.xhscdn.com/${originKey}`;
        formats.push({
          formatId: 'xhs-origin-nowm',
          quality: 'Original Master MP4 (No Watermark)',
          ext: 'mp4',
          url: directVideoUrl,
          hasAudio: true,
          noWatermark: true,
          headers: dlHeaders
        });
      }

      for (const s of [...h264Streams, ...h265Streams]) {
        const streamUrl = s.masterUrl || s.master_url || s.backupUrls?.[0];
        if (streamUrl) {
          if (!directVideoUrl) directVideoUrl = streamUrl;
          formats.push({
            formatId: s.streamDesc || 'xhs-stream',
            quality: `${s.width || 1080}×${s.height || 1920} (${s.streamDesc || 'H.264'})`,
            ext: 'mp4',
            url: streamUrl,
            hasAudio: true,
            noWatermark: true,
            headers: dlHeaders
          });
        }
      }

      if (domVideoSrc && !directVideoUrl) {
        directVideoUrl = domVideoSrc;
        formats.push({
          formatId: 'xhs-dom-stream',
          quality: 'HD MP4 Stream (WebKit)',
          ext: 'mp4',
          url: domVideoSrc,
          hasAudio: true,
          noWatermark: true,
          headers: dlHeaders
        });
      }

      if (directVideoUrl) {
        return {
          platform: 'xiaohongshu',
          platformName: PLATFORMS.xiaohongshu.name,
          videoId: noteId || 'xhs_note',
          title: note.title || note.desc || `Xiaohongshu Note ${noteId}`,
          description: note.desc || '',
          author: note.user?.nickname || 'Xiaohongshu Creator',
          authorAvatar: note.user?.avatar || '',
          cover: note.imageList?.[0]?.urlDefault || '',
          duration: Math.round(note.video?.capa?.duration || 0),
          stats: {
            likes: parseInt(note.interactInfo?.likedCount || '0', 10) || 0,
            favorites: parseInt(note.interactInfo?.collectedCount || '0', 10) || 0,
            comments: parseInt(note.interactInfo?.commentCount || '0', 10) || 0,
            shares: parseInt(note.interactInfo?.shareCount || '0', 10) || 0
          },
          embedUrl: urlInfo.resolvedUrl,
          directVideoUrl,
          formats,
          downloadHeaders: dlHeaders,
          engine: 'Native Xiaohongshu Auto-State & Stream Extractor'
        };
      }
    }
  }

  if (domVideoSrc) {
    return {
      platform: 'xiaohongshu',
      platformName: PLATFORMS.xiaohongshu.name,
      videoId: urlInfo.videoId || 'xhs_note',
      title: `Xiaohongshu Video ${urlInfo.videoId || ''}`,
      description: '',
      author: 'Xiaohongshu Creator',
      cover: '',
      duration: 0,
      stats: {},
      embedUrl: urlInfo.resolvedUrl,
      directVideoUrl: domVideoSrc,
      formats: [
        {
          formatId: 'xhs-webkit-stream',
          quality: 'HD MP4 Stream',
          ext: 'mp4',
          url: domVideoSrc,
          hasAudio: true,
          noWatermark: true,
          headers: dlHeaders
        }
      ],
      downloadHeaders: dlHeaders,
      engine: 'Native Xiaohongshu WebKit Stream Extractor'
    };
  }

  throw new Error('Không tìm thấy luồng video trong liên kết Tiểu Hồng Thư này.');
}

/**
 * 6. Parser cho Jianying (剪映 / CapCut CN)
 */
async function parseJianying(urlInfo) {
  let html = urlInfo.html || '';
  const templateId = urlInfo.videoId;

  const videoUrlMatch =
    html.match(/"video_url"\s*:\s*"(https?:[^"]+)"/) ||
    html.match(/"play_addr"\s*:\s*\{[^}]*"url_list"\s*:\s*\[\s*"(https?:[^"]+)"/);

  if (videoUrlMatch) {
    const rawUrl = JSON.parse(`"${videoUrlMatch[1]}"`);
    const $ = cheerio.load(html);
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('title').text() ||
      `Jianying Template ${templateId || ''}`;
    const cover = $('meta[property="og:image"]').attr('content') || '';

    return {
      platform: 'jianying',
      platformName: PLATFORMS.jianying.name,
      videoId: templateId || 'jy_template',
      title: title.trim(),
      description: $('meta[name="description"]').attr('content') || '',
      author: 'Jianying Creator',
      cover,
      duration: 0,
      embedUrl: urlInfo.resolvedUrl,
      directVideoUrl: rawUrl,
      formats: [
        {
          formatId: 'jianying-template-hd',
          quality: 'Original Template Video (No Watermark)',
          ext: 'mp4',
          url: rawUrl,
          hasAudio: true,
          noWatermark: true,
          headers: { 'User-Agent': MOBILE_UA }
        }
      ],
      downloadHeaders: { 'User-Agent': MOBILE_UA },
      engine: 'Native Jianying SSR Template Extractor'
    };
  }

  const sniff = await runWebKitSniffer(urlInfo.inputUrl, MOBILE_UA, 7500);
  const videoEv = (sniff.events || []).find((e) => (e.type === 'video_dom' || e.type === 'resource_stream') && e.data?.src);
  if (videoEv?.data?.src) {
    return {
      platform: 'jianying',
      platformName: PLATFORMS.jianying.name,
      videoId: templateId || 'jy_template',
      title: sniff.finalInfo?.title || `Jianying Video ${templateId || ''}`,
      description: '',
      author: 'Jianying Creator',
      cover: '',
      duration: 0,
      embedUrl: urlInfo.resolvedUrl,
      directVideoUrl: videoEv.data.src,
      formats: [
        {
          formatId: 'jianying-webkit-hd',
          quality: 'HD Template Stream (No Watermark)',
          ext: 'mp4',
          url: videoEv.data.src,
          hasAudio: true,
          noWatermark: true,
          headers: { 'User-Agent': MOBILE_UA }
        }
      ],
      downloadHeaders: { 'User-Agent': MOBILE_UA },
      engine: 'Native Jianying WebKit Stream Extractor'
    };
  }

  throw new Error('Không tìm thấy video_url trực tiếp trong Jianying.');
}

/**
 * 7. Parser cho MangoTV (芒果TV)
 */
async function parseMangoTvMetadata(urlInfo) {
  const vid = urlInfo.videoId;
  if (!vid) return null;
  try {
    const infoUrl = `https://pcweb.api.mgtv.com/video/info?vid=${vid}`;
    const res = await fetch(infoUrl, {
      headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://www.mgtv.com/' },
      signal: AbortSignal.timeout(7000)
    });
    const json = await res.json();
    if (json?.code === 200 && json?.data?.info) {
      const info = json.data.info;
      return {
        title: `${info.title || ''} ${info.desc || ''}`.trim() || `MangoTV ${vid}`,
        description: info.story || info.desc || '',
        cover: info.img || '',
        duration: parseInt(info.time || '0', 10) || 0,
        author: info.RootName || 'MangoTV (芒果TV)'
      };
    }
  } catch {}
  return null;
}

function extractHtmlPageMetadata(html, fallbackTitle = 'Video') {
  if (!html) return { title: fallbackTitle, description: '', cover: '' };
  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="title"]').attr('content') ||
    $('title').first().text() ||
    fallbackTitle;
  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    '';
  let cover =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[itemprop="image"]').attr('content') ||
    '';
  if (cover.startsWith('//')) cover = 'https:' + cover;

  return {
    title: title.trim(),
    description: description.trim(),
    cover: cover.trim()
  };
}

module.exports = {
  MOBILE_UA,
  DESKTOP_UA,
  runWebKitSniffer,
  resolveRedirect,
  parseBilibili,
  parsePipixia,
  parseDouyin,
  parseXiaohongshu,
  parseKuaishou,
  parseJianying,
  parseMangoTvMetadata,
  extractHtmlPageMetadata
};

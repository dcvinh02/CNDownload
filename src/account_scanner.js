/**
 * Hệ thống Quét Danh sách Video của Tài khoản Người dùng, Xác thực Cookie Phiên & Hàng đợi Tải Hàng loạt (Batch Queue)
 * - Hỗ trợ định dạng Cookie dễ hiểu: Header string (`Cookie: k=v; ...` hoặc `k=v; ...`), Netscape cookies.txt, hoặc JSON array.
 * - Xác thực đầu vào Cookie, giới hạn gửi Cookie nghiêm ngặt tới đúng miền nền tảng (`isCookieAllowedForUrl`),
 *   và truyền nhất quán qua HTTP Fetch, WebKitSniffer (`SNIFFER_COOKIE`) và `yt-dlp` (`--cookies`).
 * - Tuyệt đối không ghi cookie/token vào log, lịch sử, `.metadata.json` hoặc trả ngược ra API trạng thái hàng đợi.
 * - Nhận diện hồ sơ (`previewAccountTarget`) trả về thông tin thực sự lấy được (tên tài khoản, ảnh đại diện, ID, số video, người theo dõi)
 *   và trạng thái `profileIdentified: true/false` minh bạch (nếu chỉ phân tích được URL thì báo rõ chưa nhận diện được hồ sơ).
 * - Không tuyên bố đăng nhập thành công nếu chưa xác minh được; báo rõ lỗi xác thực hoặc giới hạn CAPTCHA/đăng nhập.
 */

const { PLATFORMS, extractUrlFromText, detectPlatform, extractVideoId } = require('./extractors/platforms');
const { DESKTOP_UA, MOBILE_UA, runWebKitSniffer, resolveRedirect } = require('./extractors/custom_parsers');
const { startRealDownload, activeDownloads } = require('./extractors/index');
const fs = require('fs');
const { spawn } = require('child_process');
const { getYtDlpPath, createTempCookieFile } = require('./extractors/ytdlp_engine');

// Safari UA khớp với runtime macOS WKWebView nhằm tránh sai lệch dấu vân tay trình duyệt (Chrome UA trên Safari WebKit)
const SAFARI_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';

const PLATFORM_COOKIE_RULES = {
  douyin: {
    allowedDomains: ['douyin.com', 'iesdouyin.com'],
    authSessionKeys: ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'login_time'],
    commonKeys: ['ttwid', 'odin_tt', 'passport_csrf_token', 's_v_web_id', 'msToken']
  },
  bilibili: {
    allowedDomains: ['bilibili.com', 'bilivideo.com'],
    authSessionKeys: ['SESSDATA', 'DedeUserID', 'bili_jct'],
    commonKeys: ['buvid3', 'buvid4', 'b_nut']
  },
  kuaishou: {
    allowedDomains: ['kuaishou.com', 'chenzhongtech.com'],
    authSessionKeys: ['userId', 'kuaishou.server.web_st', 'passToken', 'did'],
    commonKeys: ['did', 'didv', 'clientid']
  },
  xiaohongshu: {
    allowedDomains: ['xiaohongshu.com', 'xhscdn.com'],
    authSessionKeys: ['web_session', 'a1', 'webId'],
    commonKeys: ['xsecappid', 'gid']
  }
};

const ACCOUNT_SCAN_SUPPORT = {
  bilibili: {
    supported: true,
    status: 'đã kiểm tra',
    statusCode: 'verified',
    inputHint: 'Nhập link hồ sơ (https://space.bilibili.com/123456), UID số, hoặc tên tài khoản Bilibili',
    reason: 'Hỗ trợ quét phân trang danh sách video công khai qua Bilibili Space API / Search API & yt-dlp.'
  },
  douyin: {
    supported: true,
    status: 'có điều kiện',
    statusCode: 'conditional',
    inputHint: 'Nhập link trang cá nhân Douyin (https://www.douyin.com/user/MS4wLjABAAAA... hoặc link rút gọn v.douyin.com)',
    reason: 'Hỗ trợ quét các video trên trang hồ sơ Douyin qua WebKitSniffer kết hợp Cookie phiên người dùng cung cấp.'
  },
  kuaishou: {
    supported: true,
    status: 'có điều kiện',
    statusCode: 'conditional',
    inputHint: 'Nhập link trang cá nhân Kuaishou (https://www.kuaishou.com/profile/3x... hoặc https://c.kuaishou.com/fw/user/...)',
    reason: 'Hỗ trợ quét danh sách video công khai trên trang hồ sơ Kuaishou qua WebKitSniffer / Mobile H5.'
  },
  xiaohongshu: {
    supported: true,
    status: 'có điều kiện',
    statusCode: 'conditional',
    inputHint: 'Nhập link hồ sơ Xiaohongshu (https://www.xiaohongshu.com/user/profile/5f...)',
    reason: 'Hỗ trợ quét các bài đăng công khai trên trang hồ sơ Xiaohongshu qua WebKitSniffer (__INITIAL_STATE__).'
  },
  pipixia: {
    supported: false,
    status: 'chưa hỗ trợ quét tài khoản',
    statusCode: 'unsupported',
    inputHint: 'Chưa hỗ trợ quét tài khoản (Chỉ hỗ trợ tải từng video qua link)',
    reason: 'Pipixia khóa hoàn toàn danh sách video trang cá nhân trên giao diện Web H5, yêu cầu chữ ký thiết bị trong App nội địa.'
  },
  youku: {
    supported: false,
    status: 'chưa hỗ trợ quét tài khoản',
    statusCode: 'unsupported',
    inputHint: 'Chưa hỗ trợ quét tài khoản (Chỉ hỗ trợ tải từng video qua link)',
    reason: 'Youku là nền tảng OTT phim dài tập và yêu cầu token xác thực cna/acs-token đăng nhập để liệt kê kênh.'
  },
  tencent: {
    supported: false,
    status: 'chưa hỗ trợ quét tài khoản',
    statusCode: 'unsupported',
    inputHint: 'Chưa hỗ trợ quét tài khoản (Chỉ hỗ trợ tải từng video qua link)',
    reason: 'Tencent Video là nền tảng OTT truyền hình/phim dài tập, không cung cấp API danh sách video hồ sơ cá nhân công khai.'
  },
  iqiyi: {
    supported: false,
    status: 'chưa hỗ trợ quét tài khoản',
    statusCode: 'unsupported',
    inputHint: 'Chưa hỗ trợ quét tài khoản (Chỉ hỗ trợ tải từng video qua link)',
    reason: 'iQIYI là nền tảng OTT phim dài tập, yêu cầu chữ ký vf token riêng cho từng tập phim.'
  },
  mangotv: {
    supported: false,
    status: 'chưa hỗ trợ quét tài khoản',
    statusCode: 'unsupported',
    inputHint: 'Chưa hỗ trợ quét tài khoản (Chỉ hỗ trợ tải từng video qua link)',
    reason: 'MangoTV là nền tảng truyền hình OTT, không có hồ sơ danh sách video người dùng UGC công khai.'
  },
  wetv: {
    supported: false,
    status: 'chưa hỗ trợ quét tài khoản',
    statusCode: 'unsupported',
    inputHint: 'Chưa hỗ trợ quét tài khoản (Chỉ hỗ trợ tải từng video qua link)',
    reason: 'WeTV là nền tảng OTT quốc tế theo bộ phim, không có trang hồ sơ người dùng cá nhân.'
  },
  xigua: {
    supported: false,
    status: 'chưa hỗ trợ quét tài khoản',
    statusCode: 'unsupported',
    inputHint: 'Chưa hỗ trợ quét tài khoản (Chỉ hỗ trợ tải từng video qua link)',
    reason: 'Trang kênh Xigua Video yêu cầu chữ ký __ac_signature động và phiên đăng nhập tài khoản ByteDance.'
  },
  jianying: {
    supported: false,
    status: 'chưa hỗ trợ quét tài khoản',
    statusCode: 'unsupported',
    inputHint: 'Chưa hỗ trợ quét tài khoản (Chỉ hỗ trợ tải từng mẫu video qua link)',
    reason: 'Jianying / CapCut Web chỉ hỗ trợ chia sẻ từng mẫu (template) riêng lẻ, không mở trang danh sách mẫu theo tài khoản trên Web.'
  }
};

const activeScanJobs = new Map();
const scanAbortControllers = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Kiểm tra xem một URL có thuộc đúng miền được phép nhận Cookie của nền tảng hay không.
 */
function isCookieAllowedForUrl(targetUrl, platformId) {
  if (!targetUrl || !platformId) return false;
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    const rule = PLATFORM_COOKIE_RULES[platformId];
    const allowedList = (rule && rule.allowedDomains) || PLATFORMS[platformId]?.domains || [];
    return allowedList.some((d) => {
      const cleanD = d.toLowerCase().replace(/^\./, '');
      return host === cleanD || host.endsWith(`.${cleanD}`);
    });
  } catch (_) {
    return false;
  }
}

/**
 * Phân tích & xác thực đầu vào Cookie từ người dùng:
 * Hỗ trợ:
 *  1. Chuỗi Header: `Cookie: sessionid=abc; ttwid=xyz` hoặc `sessionid=abc; ttwid=xyz`
 *  2. Định dạng Netscape cookies.txt (nhiều dòng cách nhau bằng tab)
 *  3. Mảng JSON (`[{"name":"sessionid","value":"abc","domain":".douyin.com"}]`)
 */
function parseAndValidateCookieInput(rawCookie, platformId = 'douyin') {
  let text = String(rawCookie || '').trim();
  // Gỡ bỏ cặp dấu ngoặc kép/đơn bao quanh toàn chuỗi nếu người dùng copy cả dấu
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) &&
    !text.startsWith('[{')
  ) {
    text = text.slice(1, -1).trim();
  }

  // Hỗ trợ tách tự động nếu người dùng dán nguyên lệnh cURL từ Chrome DevTools (-H 'cookie: ...' hoặc -b '...')
  if (/^\s*curl\s+/i.test(text)) {
    const mCookie =
      text.match(/(?:-H|--header)\s+['"]cookie\s*:\s*([^'"]+)['"]/i) ||
      text.match(/(?:-b|--cookie)\s+['"]([^'"]+)['"]/i);
    if (mCookie && mCookie[1]) {
      text = mCookie[1].trim();
    }
  }

  const rule = PLATFORM_COOKIE_RULES[platformId] || {
    allowedDomains: PLATFORMS[platformId]?.domains || [`${platformId}.com`],
    authSessionKeys: ['sessionid', 'SESSDATA', 'token'],
    commonKeys: []
  };

  if (!text) {
    return {
      provided: false,
      valid: false,
      format: 'none',
      cookieHeader: '',
      cookieCount: 0,
      count: 0,
      keyNames: [],
      hasAuthSessionKey: false,
      domainRestrictedTo: rule.allowedDomains,
      error: null
    };
  }

  const kvMap = new Map();
  let rejectedCrossDomainCount = 0;
  let detectedFormat = 'header';

  const isDomainMatched = (cookieDomain) => {
    if (!cookieDomain) return true;
    const clean = String(cookieDomain).toLowerCase().replace(/^#httponly_/i, '').replace(/^\./, '');
    return rule.allowedDomains.some((d) => {
      const base = d.toLowerCase().replace(/^\./, '');
      return clean === base || clean.endsWith(`.${base}`) || base.endsWith(`.${clean}`);
    });
  };

  // Trường hợp 1: JSON Array hoặc JSON Object
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    detectedFormat = 'json';
    try {
      const parsedJson = JSON.parse(text);
      const arr = Array.isArray(parsedJson)
        ? parsedJson
        : Array.isArray(parsedJson?.cookies)
        ? parsedJson.cookies
        : null;
      if (arr) {
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          const k = String(item.name || item.key || '').trim();
          const v = String(item.value ?? '').trim();
          if (!k) continue;
          if (item.domain && !isDomainMatched(item.domain)) {
            rejectedCrossDomainCount++;
            continue;
          }
          if (!/[\r\n\0\t;]/.test(k) && !/[\r\n\0]/.test(v)) {
            kvMap.set(k, v);
          }
        }
      } else if (parsedJson && typeof parsedJson === 'object') {
        for (const [rawK, rawV] of Object.entries(parsedJson)) {
          const k = String(rawK || '').trim();
          const v = String(rawV ?? '').trim();
          if (k && typeof rawV !== 'object' && !/[\r\n\0\t;]/.test(k) && !/[\r\n\0]/.test(v)) {
            kvMap.set(k, v);
          }
        }
      }
    } catch (e) {
      return {
        provided: true,
        valid: false,
        format: 'json',
        cookieHeader: '',
        cookieCount: 0,
        count: 0,
        keyNames: [],
        hasAuthSessionKey: false,
        domainRestrictedTo: rule.allowedDomains,
        error: 'Định dạng JSON Cookie không hợp lệ. Vui lòng dán chuỗi Cookie: name=value; ... hoặc Netscape cookies.txt.'
      };
    }
  } else if (
    text.includes('\t') ||
    text.includes('# Netscape HTTP Cookie File') ||
    text.includes('#HttpOnly_')
  ) {
    // Trường hợp 2: Netscape cookies.txt (giữ nguyên các dòng #HttpOnly_ như sessionid, ttwid, sid_tt!)
    detectedFormat = 'netscape';
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      let trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#') && !trimmed.startsWith('#HttpOnly_')) continue;
      if (trimmed.startsWith('#HttpOnly_')) {
        trimmed = trimmed.slice('#HttpOnly_'.length).trim();
      }
      const cols = trimmed.includes('\t') ? trimmed.split('\t') : trimmed.split(/\s+/);
      if (cols.length >= 7) {
        const domain = cols[0].trim();
        const k = cols[5].trim();
        const v = cols.slice(6).join(trimmed.includes('\t') ? '\t' : ' ').trim();
        if (!isDomainMatched(domain)) {
          rejectedCrossDomainCount++;
          continue;
        }
        if (k && !/[\r\n\0;]/.test(k)) {
          kvMap.set(k, v);
        }
      }
    }
  } else {
    // Trường hợp 3: Chuỗi Header "Cookie: k=v; k2=v2" hoặc nhiều dòng "k=v"
    detectedFormat = 'header';
    const cleanHeader = text
      .replace(/^Cookie\s*:\s*/i, '')
      .replace(/\r?\n/g, '; ')
      .trim();

    const segments = cleanHeader
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const seg of segments) {
      const eqIdx = seg.indexOf('=');
      if (eqIdx <= 0) continue;
      const k = seg.slice(0, eqIdx).trim();
      const v = seg.slice(eqIdx + 1).trim();
      // Không nhận các thuộc tính Set-Cookie metadata làm tên cookie
      if (/^(path|domain|expires|max-age|secure|httponly|samesite)$/i.test(k)) continue;
      if (/^[a-zA-Z0-9_.\-~%]+$/.test(k) && !/[\r\n\0]/.test(v)) {
        kvMap.set(k, v);
      }
    }
  }

  if (kvMap.size === 0) {
    return {
      provided: true,
      valid: false,
      format: detectedFormat,
      cookieHeader: '',
      cookieCount: 0,
      count: 0,
      keyNames: [],
      hasAuthSessionKey: false,
      domainRestrictedTo: rule.allowedDomains,
      error:
        rejectedCrossDomainCount > 0
          ? `Cookie bạn nhập thuộc tên miền khác, không khớp với miền của ${PLATFORMS[platformId]?.name || platformId} (${rule.allowedDomains.join(', ')}).`
          : 'Định dạng Cookie không hợp lệ (không tìm thấy cặp khóa=giá_trị hợp lệ). Ví dụ đúng: sessionid=xxx; ttwid=yyy'
    };
  }

  const keyNames = Array.from(kvMap.keys());
  const lowerKeys = new Set(keyNames.map((k) => k.toLowerCase()));
  const matchedAuthKeys = rule.authSessionKeys.filter((ak) => lowerKeys.has(ak.toLowerCase()));
  const matchedCommonKeys = rule.commonKeys.filter((ck) => lowerKeys.has(ck.toLowerCase()));

  const cookieHeader = Array.from(kvMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  return {
    provided: true,
    valid: true,
    format: detectedFormat,
    cookieHeader,
    cookieCount: kvMap.size,
    count: kvMap.size,
    keyNames,
    hasAuthSessionKey: matchedAuthKeys.length > 0,
    matchedAuthKeys,
    matchedCommonKeys,
    domainRestrictedTo: rule.allowedDomains,
    warning:
      matchedAuthKeys.length === 0
        ? `Cookie có ${kvMap.size} trường hợp lệ nhưng thiếu khóa phiên đăng nhập chính (${rule.authSessionKeys.slice(0, 3).join(', ')}). Có thể chỉ xem được nội dung khách (Guest).`
        : null,
    error: null
  };
}

/**
 * Ẩn mọi chuỗi cookie / token nếu vô tình xuất hiện trong thông báo lỗi hoặc nhật ký.
 */
function redactSensitiveText(text) {
  if (!text) return '';
  return String(text)
    .replace(/(sessionid|sessionid_ss|sid_tt|SESSDATA|bili_jct|passToken|web_session)\s*=\s*[^;\s&"']+/gi, '$1=[REDACTED]')
    .replace(/Cookie\s*:\s*[^\r\n]+/gi, 'Cookie: [REDACTED]');
}

function detectAccountPlatformAndId(rawInput, platformOverride = 'auto') {
  const trimmed = (rawInput || '').trim();
  const extractedUrl = extractUrlFromText(trimmed);
  let platformId = platformOverride !== 'auto' && PLATFORMS[platformOverride] ? platformOverride : null;

  if (!platformId) {
    const lower = trimmed.toLowerCase();
    if (lower.includes('space.bilibili.com') || lower.includes('bilibili.com') || lower.includes('b23.tv')) {
      platformId = 'bilibili';
    } else if (lower.includes('douyin.com') || lower.includes('iesdouyin.com')) {
      platformId = 'douyin';
    } else if (lower.includes('kuaishou.com')) {
      platformId = 'kuaishou';
    } else if (lower.includes('xiaohongshu.com') || lower.includes('xhslink.com')) {
      platformId = 'xiaohongshu';
    } else {
      const detected = detectPlatform(trimmed);
      if (detected) platformId = detected.id;
    }
  }

  if (!platformId) {
    platformId = /^MS4wLjAB[a-zA-Z0-9_-]+$/.test(trimmed) ? 'douyin' : 'bilibili';
  }

  const supportInfo = ACCOUNT_SCAN_SUPPORT[platformId] || {
    supported: false,
    status: 'chưa hỗ trợ quét tài khoản',
    statusCode: 'unsupported',
    reason: 'Nền tảng này chưa hỗ trợ quét danh sách video tài khoản.'
  };

  let accountId = null;
  let profileUrl = extractedUrl.startsWith('http') ? extractedUrl : null;
  let isSearchByKeyword = false;

  if (platformId === 'bilibili') {
    const mSpace = trimmed.match(/space\.bilibili\.com\/(\d+)/i);
    if (mSpace) {
      accountId = mSpace[1];
      profileUrl = `https://space.bilibili.com/${accountId}/video`;
    } else if (/^\d{3,16}$/.test(trimmed)) {
      accountId = trimmed;
      profileUrl = `https://space.bilibili.com/${accountId}/video`;
    } else if (!trimmed.startsWith('http')) {
      accountId = trimmed;
      isSearchByKeyword = true;
      profileUrl = `https://search.bilibili.com/upuser?keyword=${encodeURIComponent(trimmed)}`;
    }
  } else if (platformId === 'douyin') {
    const mUser =
      trimmed.match(/douyin\.com\/user\/([a-zA-Z0-9_-]+)/i) ||
      trimmed.match(/share\/user\/([a-zA-Z0-9_-]+)/i) ||
      trimmed.match(/sec_uid=([a-zA-Z0-9_-]+)/i);
    if (mUser) {
      accountId = mUser[1];
      profileUrl = `https://www.douyin.com/user/${accountId}`;
    } else if (/^MS4wLjAB[a-zA-Z0-9_-]+$/.test(trimmed)) {
      accountId = trimmed;
      profileUrl = `https://www.douyin.com/user/${accountId}`;
    }
  } else if (platformId === 'kuaishou') {
    const mProf = trimmed.match(/kuaishou\.com\/(?:profile|fw\/user)\/([a-zA-Z0-9_-]+)/i);
    if (mProf) {
      accountId = mProf[1];
      profileUrl = `https://www.kuaishou.com/profile/${accountId}`;
    }
  } else if (platformId === 'xiaohongshu') {
    const mXhs = trimmed.match(/xiaohongshu\.com\/user\/profile\/([a-f0-9]{24})/i);
    if (mXhs) {
      accountId = mXhs[1];
      profileUrl = `https://www.xiaohongshu.com/user/profile/${accountId}`;
    }
  }

  return {
    platformId,
    platformName: PLATFORMS[platformId]?.name || platformId,
    supportInfo,
    accountId,
    profileUrl,
    isSearchByKeyword,
    rawInput: trimmed
  };
}

/**
 * Mã định danh chủ trang lấy từ URL hồ sơ — dùng để CHỈ giữ video do chính tài khoản này đăng.
 * Douyin: sec_uid (MS4wLjAB...), Kuaishou: eid (3x...), Xiaohongshu: userId 24 ký tự hex.
 */
function profileOwnerIdFromUrl(platformId, profileUrl = '') {
  const u = String(profileUrl || '');
  if (platformId === 'douyin') return (u.match(/\/user\/(MS4wLjAB[a-zA-Z0-9_-]+)/) || [])[1] || '';
  if (platformId === 'kuaishou') return (u.match(/\/profile\/([a-zA-Z0-9_-]+)/) || [])[1] || '';
  if (platformId === 'xiaohongshu') return (u.match(/\/user\/profile\/([a-f0-9]{24})/i) || [])[1] || '';
  return '';
}

/**
 * Bóc tách dữ liệu hồ sơ Douyin / Kuaishou / Xiaohongshu từ kết quả WebKitSniffer & RENDER_DATA.
 * Trang hồ sơ còn chứa video GỢI Ý / xu hướng / link SEO của tài khoản khác (và trang "喜欢" là video người khác),
 * nên chỉ nhận video khi xác minh được tác giả là chủ trang (ownerId), hoặc nằm trong khung danh sách bài đăng của chủ trang.
 */
function parseWebKitSnifferProfileAndVideos(platformId, sniffRes, fallbackAccountId = '', ownerId = '') {
  const items = [];
  const errors = [];
  let skippedForeign = 0;
  let hiddenOwnNotes = 0;
  let nickname = '';
  let uniqueId = fallbackAccountId || '';
  let avatar = '';
  let signature = '';
  let followerCount = null;
  let videoCount = null;
  let hasMore = false;

  const finalInfo = sniffRes?.finalInfo || {};
  const hasCaptcha = Boolean(finalInfo.hasCaptcha);
  const hasLoginWall = Boolean(finalInfo.hasLoginWall);

  if (finalInfo.domProfile) {
    if (finalInfo.domProfile.nickname) nickname = finalInfo.domProfile.nickname;
    if (finalInfo.domProfile.avatar) avatar = finalInfo.domProfile.avatar;
    if (finalInfo.domProfile.signature) signature = finalInfo.domProfile.signature;
  }

  if (!nickname && finalInfo.title) {
    const cleanTitle = finalInfo.title
      .replace(/的抖音.*$/, '')
      .replace(/的快手.*$/, '')
      .replace(/\s*-\s*小红书.*$/, '')
      .replace(/\s*-\s*抖音.*$/, '')
      .trim();
    if (
      cleanTitle &&
      !['抖音', '快手', '小红书', 'rednote', 'Xiaohongshu', 'Kuaishou', 'Douyin'].includes(cleanTitle) &&
      !cleanTitle.includes('抖音-记录美好生活') &&
      !cleanTitle.includes('验证码')
    ) {
      nickname = cleanTitle;
    }
  }

  // Phân tích dữ liệu đã cấu trúc sẵn hoặc RENDER_DATA của Douyin
  const applyRenderUserAndPosts = (u, postList) => {
    const uSec = u && typeof u === 'object' ? u.secUid || u.sec_uid || '' : '';
    if (ownerId && uSec && uSec !== ownerId) u = null; // hồ sơ của người khác (vd. tài khoản đang đăng nhập)
    if (u && typeof u === 'object' && (u.nickname || u.uid || u.secUid || u.sec_uid)) {
      if (u.nickname && !nickname) nickname = u.nickname;
      if (u.uniqueId || u.unique_id || u.shortId || u.short_id || u.uid) {
        uniqueId = String(u.uniqueId || u.unique_id || u.shortId || u.short_id || u.uid);
      }
      const pic =
        u.avatarThumb?.urlList?.[0] ||
        u.avatarLarger?.urlList?.[0] ||
        u.avatar_thumb?.url_list?.[0] ||
        u.avatarUrl;
      if (pic && !avatar) avatar = pic;
      if ((u.signature || u.desc) && !signature) signature = u.signature || u.desc;
      if (
        typeof u.followerCount === 'number' ||
        typeof u.mplatformFollowersCount === 'number' ||
        typeof u.follower_count === 'number'
      ) {
        followerCount = u.mplatformFollowersCount ?? u.followerCount ?? u.follower_count;
      }
      if (typeof u.awemeCount === 'number' || typeof u.aweme_count === 'number') {
        videoCount = u.awemeCount ?? u.aweme_count;
      }
    }
    if (Array.isArray(postList)) {
      for (const aw of postList) {
        const vid = aw.awemeId || aw.aweme_id;
        if (!vid) continue;
        const aSec = aw.authorInfo?.secUid || aw.author?.secUid || aw.author?.sec_uid || '';
        if (ownerId && aSec && aSec !== ownerId) {
          skippedForeign++;
          continue;
        }
        const cTime = aw.createTime ?? aw.create_time;
        items.push({
          videoId: String(vid),
          title: aw.desc || `Douyin Video ${vid}`,
          url: `https://www.douyin.com/video/${vid}`,
          cover: aw.video?.cover?.urlList?.[0] || aw.video?.cover?.url_list?.[0] || '',
          duration: Math.round((aw.video?.duration || 0) / 1000),
          publishedAt: cTime ? new Date(cTime * 1000).toISOString().slice(0, 10) : '',
          views: aw.statistics?.playCount || aw.statistics?.play_count || aw.statistics?.diggCount || aw.statistics?.digg_count || 0,
          author: aw.author?.nickname || nickname || 'Douyin Creator',
          downloadable: true,
          statusNote: 'Sẵn sàng tải (Không logo)'
        });
      }
    }
  };

  if (finalInfo.parsedRenderSummary && typeof finalInfo.parsedRenderSummary === 'object') {
    applyRenderUserAndPosts(finalInfo.parsedRenderSummary.user, finalInfo.parsedRenderSummary.posts);
  }

  if (finalInfo.renderDataSnippet) {
    try {
      const renderObj = JSON.parse(finalInfo.renderDataSnippet);
      for (const val of Object.values(renderObj)) {
        if (!val || typeof val !== 'object') continue;
        applyRenderUserAndPosts(val.user?.user || val.userInfo || val.user, val.post?.data || val.awemeList);
      }
    } catch (_) {}
  }

  // Phân tích các sự kiện XHR / Fetch / Window State
  for (const ev of sniffRes?.events || []) {
    try {
      if ((ev.type === 'xhr' || ev.type === 'fetch') && ev.data?.body) {
        const body = JSON.parse(ev.data.body);
        const evUrl = String(ev.data.url || '');

        // Douyin user/profile/other — bỏ qua hồ sơ không phải chủ trang (vd. hồ sơ của chính người dùng đang đăng nhập)
        let uObj = body.user || body.user_info;
        if (uObj && typeof uObj === 'object' && ownerId && uObj.sec_uid && uObj.sec_uid !== ownerId) uObj = null;
        if (uObj && typeof uObj === 'object') {
          if (uObj.nickname && !nickname) nickname = uObj.nickname;
          if (uObj.unique_id || uObj.short_id || uObj.uid) uniqueId = String(uObj.unique_id || uObj.short_id || uObj.uid);
          if (uObj.avatar_larger?.url_list?.[0] || uObj.avatar_thumb?.url_list?.[0]) {
            avatar = uObj.avatar_larger?.url_list?.[0] || uObj.avatar_thumb?.url_list?.[0];
          }
          if (uObj.signature) signature = uObj.signature;
          if (typeof uObj.mplatform_followers_count === 'number' || typeof uObj.follower_count === 'number') {
            followerCount = uObj.mplatform_followers_count ?? uObj.follower_count;
          }
          if (typeof uObj.aweme_count === 'number') {
            videoCount = uObj.aweme_count;
          }
        }

        // Douyin aweme_list — CHỈ danh sách "作品" của chủ trang (/aweme/post/). Các danh sách khác trên trang
        // (đề xuất /tab/feed/, "喜欢" /aweme/favorite/, tìm kiếm liên quan...) là video của tài khoản khác.
        if (Array.isArray(body.aweme_list)) {
          const isOwnerPostApi = /\/aweme\/v\d+\/web\/aweme\/post\//.test(evUrl) ||
            (/\/aweme\/post\//.test(evUrl) && !/favorite|collect|feed|search|related/.test(evUrl));
          if (isOwnerPostApi && (body.has_more === 1 || body.has_more === true)) hasMore = true;
          for (const aw of body.aweme_list) {
            const vid = aw.aweme_id;
            if (!vid) continue;
            const aSec = aw.author?.sec_uid || '';
            const ownedByTarget = ownerId ? (aSec ? aSec === ownerId : isOwnerPostApi) : isOwnerPostApi;
            if (!ownedByTarget) {
              skippedForeign++;
              continue;
            }
            if (aw.author?.nickname && !nickname) nickname = aw.author.nickname;
            if (aw.author?.avatar_thumb?.url_list?.[0] && !avatar) {
              avatar = aw.author.avatar_thumb.url_list[0];
            }
            if (aw.author?.unique_id && (!uniqueId || uniqueId.startsWith('MS4wLjAB'))) {
              uniqueId = aw.author.unique_id;
            }
            items.push({
              videoId: String(vid),
              title: aw.desc || `Douyin Video ${vid}`,
              url: `https://www.douyin.com/video/${vid}`,
              cover: aw.video?.cover?.url_list?.[0] || aw.video?.origin_cover?.url_list?.[0] || '',
              duration: Math.round((aw.video?.duration || 0) / 1000),
              publishedAt: aw.create_time ? new Date(aw.create_time * 1000).toISOString().slice(0, 10) : '',
              views: aw.statistics?.play_count || aw.statistics?.digg_count || 0,
              author: aw.author?.nickname || nickname || 'Douyin User',
              downloadable: true,
              statusNote: 'Sẵn sàng tải (Không logo)'
            });
          }
        }

        // Kuaishou visionProfile / visionProfilePhotoList
        const ksUser = body?.data?.visionProfile?.userProfile?.profile;
        if (ksUser) {
          if (ksUser.user_name && !nickname) nickname = ksUser.user_name;
          if (ksUser.headurl && !avatar) avatar = ksUser.headurl;
          if (ksUser.user_id) uniqueId = String(ksUser.user_id);
        }
        const ksFeeds = body?.data?.visionProfilePhotoList?.feeds;
        if (Array.isArray(ksFeeds)) {
          if (body?.data?.visionProfilePhotoList?.pcursor && body.data.visionProfilePhotoList.pcursor !== 'no_more') {
            hasMore = true;
          }
          for (const f of ksFeeds) {
            const pid = f?.photo?.id;
            if (!pid) continue;
            if (ownerId && f?.author?.id && /^3x/i.test(String(f.author.id)) && String(f.author.id) !== ownerId) {
              skippedForeign++;
              continue;
            }
            if (f?.author?.name && !nickname) nickname = f.author.name;
            if (f?.author?.headerUrl && !avatar) avatar = f.author.headerUrl;
            items.push({
              videoId: String(pid),
              title: f.photo.caption || `Kuaishou Video ${pid}`,
              url: `https://www.kuaishou.com/short-video/${pid}`,
              cover: f.photo.coverUrl || '',
              duration: Math.round((f.photo.duration || 0) / 1000),
              publishedAt: f.photo.timestamp ? new Date(f.photo.timestamp).toISOString().slice(0, 10) : '',
              views: f.photo.viewCount || f.photo.likeCount || 0,
              author: f.author?.name || nickname || 'Kuaishou User',
              downloadable: true,
              statusNote: 'Sẵn sàng tải (Auto-UTM HD)'
            });
          }
        }
      } else if (ev.type === 'window_state' && ev.data?.ssr) {
        const initState = ev.data.ssr.initialState || ev.data.ssr;
        const xhsUser = initState?.user?.userPageData?.basicInfo;
        if (xhsUser) {
          if (xhsUser.nickname && !nickname) nickname = xhsUser.nickname;
          if (xhsUser.images && !avatar) avatar = xhsUser.images;
          if (xhsUser.redId) uniqueId = String(xhsUser.redId);
          if (xhsUser.desc) signature = xhsUser.desc;
        }
        // Bài đăng của chủ trang: user.notes[0] (tab "笔记"); chỉ nhận bài có userId trùng chủ trang và là video
        const xhsNotes = initState?.user?.notes;
        const postedTab = Array.isArray(xhsNotes) && Array.isArray(xhsNotes[0]) ? xhsNotes[0] : [];
        for (const n of postedTab) {
          const card = n?.noteCard || {};
          const nUid = card.user?.userId || '';
          if (ownerId && nUid && nUid !== ownerId) {
            skippedForeign++;
            continue;
          }
          if (card.type && card.type !== 'video') continue; // ghi chú ảnh, không phải video
          const nid = n.id || card.noteId || '';
          if (!nid) {
            hiddenOwnNotes++;
            continue;
          }
          const tok = n.xsecToken || card.xsecToken || '';
          items.push({
            videoId: String(nid),
            title: card.displayTitle || `Xiaohongshu ${nid}`,
            url: `https://www.xiaohongshu.com/explore/${nid}${tok ? `?xsec_token=${encodeURIComponent(tok)}&xsec_source=pc_user` : ''}`,
            cover: card.cover?.urlDefault || card.cover?.url || '',
            duration: 0,
            publishedAt: '',
            views: 0,
            author: card.user?.nickname || card.user?.nickName || nickname || 'Xiaohongshu Creator',
            downloadable: true,
            statusNote: 'Sẵn sàng tải'
          });
        }
      }
    } catch (_) {}
  }

  // Bóc tách bổ sung từ các thẻ <a href> trên DOM trang hồ sơ
  const domLinks = finalInfo.links || [];
  for (const lnk of domLinks) {
    try {
      const href = lnk.href || '';
      const vid = extractVideoId(platformId, href);
      if (!vid) continue;
      const urlNamesOwner = Boolean(ownerId) && platformId === 'xiaohongshu' && href.includes(`/user/profile/${ownerId}/`);
      if (!lnk.inOwnerList && !urlNamesOwner) {
        skippedForeign++;
        continue;
      }

      let canonical = href;
      if (platformId === 'douyin') canonical = `https://www.douyin.com/video/${vid}`;
      else if (platformId === 'kuaishou') canonical = `https://www.kuaishou.com/short-video/${vid}`;
      else if (platformId === 'xiaohongshu') canonical = `https://www.xiaohongshu.com/explore/${vid}`;
      else if (platformId === 'bilibili') canonical = `https://www.bilibili.com/video/${vid}`;

      items.push({
        videoId: String(vid),
        title: lnk.text || `${PLATFORMS[platformId]?.name || platformId} Video ${vid}`,
        url: canonical,
        cover: lnk.cover || '',
        duration: 0,
        publishedAt: '',
        views: 0,
        author: nickname || PLATFORMS[platformId]?.name || '',
        downloadable: true,
        statusNote: 'Sẵn sàng tải'
      });
    } catch (e) {
      errors.push(`Lỗi đọc link DOM: ${e.message}`);
    }
  }

  const profileIdentified = Boolean(
    nickname || avatar || followerCount !== null || videoCount !== null || items.length > 0
  );
  if (hiddenOwnNotes > 0 && items.length === 0) {
    errors.push(
      `Xiaohongshu ẩn mã bài viết khi chưa đăng nhập (thấy ${hiddenOwnNotes} bài của tài khoản này nhưng không có link). Hãy dán Cookie đăng nhập Xiaohongshu của bạn rồi quét lại.`
    );
  }

  return {
    profileIdentified,
    nickname,
    uniqueId,
    avatar,
    signature,
    followerCount,
    videoCount,
    hasCaptcha,
    hasLoginWall,
    hasMore,
    items,
    errors,
    skippedForeign
  };
}

/**
 * Xem trước và xác minh thực tế thông tin hồ sơ/tài khoản trước khi quét:
 * - Trả về thông tin thực sự lấy được (tên tài khoản, ảnh đại diện, ID, số video, người theo dõi).
 * - Nếu chỉ phân tích được URL mà chưa lấy được thông tin hồ sơ (`profileIdentified: false`),
 *   báo rõ cho người dùng biết nguyên nhân (cần Cookie phiên, bị chặn Captcha, hoặc chế độ Offline).
 */
async function previewAccountTarget({
  rawInput,
  platformId = 'auto',
  cookie = '',
  userConsentedCookie = false,
  skipRemoteProbe = false
}) {
  if (!rawInput || !String(rawInput).trim()) {
    throw new Error('Vui lòng nhập đường dẫn trang tài khoản hoặc tên/ID tài khoản cần quét.');
  }

  const parsed = detectAccountPlatformAndId(rawInput, platformId);
  const { supportInfo } = parsed;

  // Kiểm tra và xác thực Cookie người dùng nhập (nếu có)
  const rawCookieProvided = Boolean(cookie && String(cookie).trim());
  const cookieValidation = parseAndValidateCookieInput(
    rawCookieProvided ? cookie : '',
    parsed.platformId
  );

  if (rawCookieProvided && !cookieValidation.valid) {
    throw new Error(cookieValidation.error);
  }

  // Nếu người dùng đã chủ động nhập Cookie hợp lệ vào ô Cookie, cho phép dùng trong phiên hiện tại
  const effectiveCookie =
    cookieValidation.valid && (userConsentedCookie || rawCookieProvided)
      ? cookieValidation.cookieHeader
      : '';

  if (!supportInfo.supported) {
    return {
      success: true,
      supported: false,
      canStartScan: false,
      profileIdentified: false,
      platformId: parsed.platformId,
      platformName: parsed.platformName,
      status: supportInfo.status,
      supportLabel: supportInfo.status,
      statusCode: supportInfo.statusCode,
      supportStatus: supportInfo.statusCode,
      reason: supportInfo.reason,
      accountId: parsed.accountId || parsed.rawInput,
      displayHandle: parsed.accountId || parsed.rawInput,
      profileUrl: parsed.profileUrl || '',
      cookieStatus: {
        provided: cookieValidation.provided,
        valid: cookieValidation.valid,
        verifiedAuth: false,
        message: supportInfo.reason
      },
      account: {
        accountId: parsed.accountId || parsed.rawInput,
        accountName: parsed.rawInput,
        profileUrl: parsed.profileUrl || '',
        avatar: '',
        videoCount: null,
        followerCount: null,
        description: supportInfo.reason
      }
    };
  }

  let resolvedProfileUrl = parsed.profileUrl;
  let accountId = parsed.accountId;
  let accountName = '';
  let avatar = '';
  let followerText = '';
  let videoCount = null;
  let followerCount = null;
  let signature = '';
  let profileIdentified = false;
  let hasCaptcha = false;
  let authVerified = false;
  let authMessage = '';

  // Giải mã nhanh link rút gọn (v.douyin.com, v.kuaishou.com, b23.tv)
  if (
    process.env.OFFLINE_TEST_MODE !== '1' &&
    resolvedProfileUrl &&
    (resolvedProfileUrl.includes('v.douyin.com') ||
      resolvedProfileUrl.includes('v.kuaishou.com') ||
      resolvedProfileUrl.includes('b23.tv') ||
      resolvedProfileUrl.includes('xhslink.com'))
  ) {
    try {
      const redirCookie = isCookieAllowedForUrl(resolvedProfileUrl, parsed.platformId) ? effectiveCookie : '';
      let redir = await resolveRedirect(resolvedProfileUrl, {
        mobile: false,
        cookie: redirCookie
      });
      if (!redir?.finalUrl || redir.finalUrl === resolvedProfileUrl) {
        const mobRedir = await resolveRedirect(resolvedProfileUrl, {
          mobile: true,
          cookie: redirCookie
        });
        if (mobRedir?.finalUrl && mobRedir.finalUrl !== resolvedProfileUrl) {
          redir = mobRedir;
        }
      }
      if (redir?.finalUrl) {
        resolvedProfileUrl = redir.finalUrl;
        const reDetected = detectAccountPlatformAndId(resolvedProfileUrl, parsed.platformId);
        if (reDetected.accountId) accountId = reDetected.accountId;
        if (reDetected.profileUrl) resolvedProfileUrl = reDetected.profileUrl;
      }
    } catch (_) {}
  }

  // 1. Lấy thông tin hồ sơ thực tế trên Bilibili
  if (parsed.platformId === 'bilibili' && process.env.OFFLINE_TEST_MODE !== '1') {
    try {
      const biliHeaders = {
        'User-Agent': DESKTOP_UA,
        Referer: 'https://space.bilibili.com/',
        ...(effectiveCookie ? { Cookie: effectiveCookie } : {})
      };

      if (parsed.isSearchByKeyword && !/^\d+$/.test(accountId || '')) {
        const searchUrl = `https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(
          parsed.rawInput
        )}`;
        const res = await fetch(searchUrl, {
          headers: biliHeaders,
          signal: AbortSignal.timeout(6000)
        });
        const j = await readJsonResponse(res, 'Bilibili tìm tài khoản');
        const firstUser = j?.data?.result?.[0];
        if (firstUser && firstUser.mid) {
          accountId = String(firstUser.mid);
          accountName = firstUser.uname || '';
          avatar = firstUser.upic
            ? firstUser.upic.startsWith('//')
              ? `https:${firstUser.upic}`
              : firstUser.upic
            : '';
          followerCount = firstUser.fans ?? null;
          videoCount = firstUser.videos ?? null;
          followerText = `${followerCount ?? 0} người theo dõi • ${videoCount ?? 0} video`;
          resolvedProfileUrl = `https://space.bilibili.com/${accountId}/video`;
          profileIdentified = true;
        }
      } else if (accountId) {
        const cardUrl = `https://api.bilibili.com/x/web-interface/card?mid=${accountId}`;
        const res = await fetch(cardUrl, {
          headers: biliHeaders,
          signal: AbortSignal.timeout(5500)
        });
        const j = await readJsonResponse(res, 'Bilibili hồ sơ');
        const card = j?.data?.card;
        if (card && card.name) {
          accountName = card.name;
          avatar = card.face || '';
          signature = card.sign || '';
          followerCount = j.data.follower ?? 0;
          videoCount = j.data.archive_count ?? 0;
          followerText = `${followerCount} người theo dõi • ${videoCount} video`;
          profileIdentified = true;
          if (effectiveCookie && cookieValidation.hasAuthSessionKey) {
            authVerified = true;
            authMessage = 'Đã xác thực phiên Bilibili và nhận diện hồ sơ UP chủ thành công.';
          }
        }
      }
    } catch (err) {
      authMessage = `Chưa lấy được thông tin hồ sơ Bilibili: ${redactSensitiveText(err.message)}`;
    }
  }

  // 2. Lấy thông tin hồ sơ thực tế trên Douyin / Kuaishou / Xiaohongshu bằng WebKitSniffer + Cookie
  if (
    !skipRemoteProbe &&
    ['douyin', 'kuaishou', 'xiaohongshu'].includes(parsed.platformId) &&
    resolvedProfileUrl &&
    process.env.OFFLINE_TEST_MODE !== '1'
  ) {
    try {
      const domainSafeCookie = isCookieAllowedForUrl(resolvedProfileUrl, parsed.platformId)
        ? effectiveCookie
        : '';

      const sniffRes = await runWebKitSniffer(resolvedProfileUrl, SAFARI_DESKTOP_UA, 13500, {
        cookie: domainSafeCookie,
        profileMode: true,
        scrollCount: 0
      });

      const prof = parseWebKitSnifferProfileAndVideos(
        parsed.platformId,
        sniffRes,
        accountId || '',
        profileOwnerIdFromUrl(parsed.platformId, resolvedProfileUrl)
      );
      if (prof.nickname) accountName = prof.nickname;
      if (prof.uniqueId) accountId = prof.uniqueId;
      if (prof.avatar) avatar = prof.avatar;
      if (prof.signature) signature = prof.signature;
      if (prof.followerCount !== null) followerCount = prof.followerCount;
      if (prof.videoCount !== null) videoCount = prof.videoCount;
      else if (prof.items.length > 0) videoCount = prof.items.length;

      const statsParts = [];
      if (followerCount !== null) statsParts.push(`${followerCount} người theo dõi`);
      if (videoCount !== null) statsParts.push(`${videoCount} video`);
      if (statsParts.length > 0) followerText = statsParts.join(' • ');

      profileIdentified = prof.profileIdentified;
      hasCaptcha = Boolean(prof.hasCaptcha);

      if (prof.hasCaptcha) {
        authVerified = false;
        authMessage =
          'Nền tảng đang yêu cầu xác minh chống bot (CAPTCHA / 验证码). Ứng dụng không tự vượt CAPTCHA; vui lòng mở trình duyệt xác minh và cập nhật lại Cookie phiên.';
      } else if (prof.hasLoginWall && !prof.profileIdentified) {
        authVerified = false;
        authMessage = effectiveCookie
          ? 'Cookie đã cung cấp nhưng phiên đăng nhập đã hết hạn hoặc bị từ chối (Yêu cầu đăng nhập lại).'
          : 'Trang hồ sơ yêu cầu Cookie phiên đăng nhập hợp lệ để xem thông tin tài khoản và danh sách video.';
      } else if (prof.profileIdentified) {
        if (effectiveCookie) {
          authVerified = cookieValidation.hasAuthSessionKey;
          authMessage = authVerified
            ? `Đã xác minh Cookie ${parsed.platformName} và nhận diện thành công hồ sơ "${accountName || accountId}".`
            : `Đã nhận diện hồ sơ "${accountName || accountId}" (sử dụng Cookie chế độ khách).`;
        } else {
          authMessage = `Đã nhận diện công khai hồ sơ "${accountName || accountId}".`;
        }
      } else {
        authMessage = effectiveCookie
          ? 'Chỉ mới phân tích được URL, chưa lấy được thông tin tài khoản (Cookie có thể thiếu sessionid/ttwid hoặc trang bị giới hạn truy cập).'
          : 'Chỉ mới phân tích được URL, chưa nhận diện được thông tin hồ sơ. Vui lòng dán thêm Cookie phiên (ví dụ Douyin Cookie) để xác thực.';
      }
    } catch (err) {
      authMessage = `Chưa thể lấy thông tin chi tiết hồ sơ: ${redactSensitiveText(err.message)}`;
    }
  }

  // Chế độ kiểm thử Offline: mô phỏng nhận diện rõ ràng
  if (process.env.OFFLINE_TEST_MODE === '1') {
    profileIdentified = Boolean(accountId);
    accountName = accountId ? `Tài khoản ${parsed.platformName} (${accountId})` : '';
    followerText = profileIdentified ? 'Chế độ kiểm thử Offline' : 'Chưa nhận diện được hồ sơ';
  }

  const displayHandle = profileIdentified
    ? accountName || accountId || parsed.rawInput
    : `Chưa nhận diện được tên hồ sơ (${accountId ? `ID: ${accountId}` : 'Chỉ mới phân tích URL'})`;

  return {
    success: true,
    supported: true,
    canStartScan: true,
    profileIdentified,
    hasCaptcha,
    platformId: parsed.platformId,
    platformName: parsed.platformName,
    status: supportInfo.status,
    supportLabel: supportInfo.status,
    statusCode: supportInfo.statusCode,
    supportStatus: supportInfo.statusCode,
    reason: authMessage || supportInfo.reason,
    accountId: accountId || parsed.rawInput,
    displayHandle,
    profileUrl: resolvedProfileUrl || parsed.rawInput,
    cookieStatus: {
      provided: cookieValidation.provided,
      valid: cookieValidation.valid,
      cookieCount: cookieValidation.cookieCount,
      hasAuthSessionKey: cookieValidation.hasAuthSessionKey,
      verifiedAuth: authVerified,
      domainRestrictedTo: cookieValidation.domainRestrictedTo,
      warning: cookieValidation.warning || null,
      message:
        authMessage ||
        (cookieValidation.valid
          ? `Đã nạp ${cookieValidation.cookieCount} trường Cookie (giới hạn miền: ${cookieValidation.domainRestrictedTo.join(', ')}).`
          : 'Chưa cung cấp Cookie (chỉ quét được dữ liệu công khai).')
    },
    account: {
      profileIdentified,
      accountId: accountId || parsed.rawInput,
      accountName: accountName || (accountId ? `ID: ${accountId}` : 'Chưa xác định tên tài khoản'),
      profileUrl: resolvedProfileUrl || parsed.rawInput,
      avatar,
      signature,
      videoCount,
      followerCount,
      followerText:
        followerText ||
        (profileIdentified
          ? 'Đã nhận diện hồ sơ'
          : 'Chỉ mới phân tích được URL — chưa lấy được thông tin tài khoản')
    }
  };
}

/**
 * Đọc JSON từ phản hồi HTTP; nếu nền tảng trả về trang HTML (chặn/kiểm soát rủi ro) thì báo lỗi rõ ràng.
 */
async function readJsonResponse(res, label) {
  const text = await res.text();
  const ct = String(res.headers.get('content-type') || '');
  if (!ct.includes('json') && /^\s*</.test(text)) {
    throw new Error(`${label}: nền tảng trả về trang HTML thay vì dữ liệu (HTTP ${res.status}) — thường do kiểm soát truy cập/chống bot. Hãy cung cấp Cookie đăng nhập của bạn hoặc thử lại sau.`);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(`${label}: dữ liệu trả về không phải JSON hợp lệ (HTTP ${res.status}).`);
  }
}

/**
 * Danh sách video TẢI LÊN của UP chủ Bilibili qua yt-dlp (BilibiliSpaceVideo), phân trang bằng --playlist-items.
 * Dùng Cookie đăng nhập của chính người dùng (nếu cung cấp) — không tự tạo danh tính giả để né kiểm soát truy cập.
 */
function fetchBilibiliUploadsViaYtDlp({ accountId, page = 1, pageSize = 20, cookie = '', onProc = null, signal = null }) {
  return new Promise((resolve) => {
    const ytdlp = getYtDlpPath();
    if (!ytdlp || !fs.existsSync(ytdlp)) {
      return resolve({ ok: false, items: [], hasMore: false, error: 'Thiếu yt-dlp để liệt kê video Bilibili. Mở tab Công cụ để cài.' });
    }
    const start = (page - 1) * pageSize + 1;
    const end = page * pageSize;
    const args = ['--flat-playlist', '-J', '--no-warnings', '--socket-timeout', '20', '--playlist-items', `${start}-${end}`];
    let cookieFile = null;
    if (cookie) {
      cookieFile = createTempCookieFile(cookie, '.bilibili.com');
      if (cookieFile) args.push('--cookies', cookieFile);
    }
    args.push(`https://space.bilibili.com/${accountId}/video`);
    const proc = spawn(ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (typeof onProc === 'function') onProc(proc);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
    }, 90000);
    const onAbort = () => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    proc.stderr.on('data', (d) => {
      err = (err + d.toString('utf8')).slice(-2000);
    });
    const finish = (result) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (cookieFile) {
        try {
          fs.unlinkSync(cookieFile);
        } catch (_) {}
      }
      resolve(result);
    };
    proc.on('error', (e) => finish({ ok: false, items: [], hasMore: false, error: `Không chạy được yt-dlp: ${e.message}` }));
    proc.on('close', (code) => {
      if (code !== 0) {
        const cleanErr = redactSensitiveText(err.trim().split('\n').filter((l) => /ERROR/i.test(l)).pop() || err.trim().slice(-300));
        let msg = `yt-dlp không liệt kê được video (mã ${code}): ${cleanErr}`;
        if (/\(352\)|-352|rejected by server/i.test(err)) {
          msg = cookie
            ? 'Bilibili từ chối yêu cầu (mã 352 — kiểm soát rủi ro) dù đã có Cookie. Cookie có thể hết hạn: đăng nhập lại Bilibili trên trình duyệt, xuất Cookie mới (cần SESSDATA) rồi thử lại.'
            : 'Bilibili từ chối yêu cầu liệt kê video khi chưa đăng nhập (mã 352 — kiểm soát rủi ro). Hãy dán Cookie đăng nhập Bilibili của bạn (có SESSDATA) vào ô Cookie để quét danh sách video tải lên.';
        } else if (/\(412\)|precondition/i.test(err)) {
          msg = 'Bilibili tạm chặn do gửi nhiều yêu cầu (HTTP 412). Hãy chờ vài phút rồi quét lại.';
        }
        return finish({ ok: false, items: [], hasMore: false, error: msg, blockedByPlatform: /352|412/.test(err) });
      }
      try {
        const j = JSON.parse(out);
        const entries = Array.isArray(j.entries) ? j.entries : [];
        const items = entries
          .map((e) => {
            const id = String(e.id || '').trim() || String(e.url || '').match(/BV[0-9A-Za-z]{10}/)?.[0] || '';
            if (!id) return null;
            return {
              videoId: id,
              title: e.title || `Bilibili ${id}`,
              url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.bilibili.com/video/${id}`,
              cover: (e.thumbnails && e.thumbnails[0] && e.thumbnails[0].url) || e.thumbnail || '',
              duration: Number(e.duration) || 0,
              publishedAt: e.timestamp ? new Date(e.timestamp * 1000).toISOString().slice(0, 10) : e.upload_date ? `${e.upload_date.slice(0, 4)}-${e.upload_date.slice(4, 6)}-${e.upload_date.slice(6, 8)}` : '',
              views: Number(e.view_count) || 0,
              downloadable: true,
              statusNote: 'Video tải lên (yt-dlp)'
            };
          })
          .filter(Boolean);
        finish({ ok: true, items, hasMore: items.length >= pageSize, total: Number(j.playlist_count) || null });
      } catch (e) {
        finish({ ok: false, items: [], hasMore: false, error: `Không đọc được dữ liệu yt-dlp: ${e.message}` });
      }
    });
  });
}

/**
 * Quét phân trang video của tài khoản Bilibili.
 * 1) Video tải lên: yt-dlp (BilibiliSpaceVideo) + Cookie người dùng (nếu có).
 * 2) Bổ sung tiêu đề/thời lượng/lượt xem qua API thông tin video công khai.
 * KHÔNG dùng kết quả tìm kiếm theo từ khóa để thay thế (tránh hiển thị video của tài khoản khác).
 */
async function fetchBilibiliAccountPage({ accountId, accountName, page = 1, pageSize = 20, cookie = '', signal, onProc, log = () => {} }) {
  const items = [];
  const errors = [];
  let hasMore = false;
  const resolvedAccountName = accountName || accountId;
  const isNumericUid = /^\d+$/.test(String(accountId));
  if (!isNumericUid) {
    return {
      items,
      hasMore,
      accountName: resolvedAccountName,
      errors: ['Chưa xác định được UID (mid) Bilibili của tài khoản. Hãy dán link dạng https://space.bilibili.com/<UID>.']
    };
  }
  const safeBiliCookie = isCookieAllowedForUrl('https://api.bilibili.com/', 'bilibili') ? cookie : '';

  log(`Trang ${page}: liệt kê video tải lên qua yt-dlp${safeBiliCookie ? ' (có Cookie người dùng)' : ' (không Cookie)'}...`);
  const up = await fetchBilibiliUploadsViaYtDlp({ accountId, page, pageSize, cookie: safeBiliCookie, onProc, signal });
  if (up.ok) {
    items.push(...up.items.map((it) => ({ ...it, author: resolvedAccountName })));
    hasMore = up.hasMore;
    log(`Trang ${page}: nhận ${up.items.length} video tải lên.`);
  } else {
    errors.push(up.error);
    log(`Trang ${page}: lỗi liệt kê video tải lên — ${up.error}`);
  }

  // Bổ sung tiêu đề/thời lượng/lượt xem từ API thông tin video công khai (giới hạn 3 luồng song song)
  const needInfo = items.filter((it) => !it.title || it.title.startsWith('Bilibili ') || !it.duration);
  if (needInfo.length > 0) {
    log(`Đọc thông tin chi tiết ${needInfo.length} video (API công khai, 3 luồng)...`);
    let failed = 0;
    let cursor = 0;
    let blocked = false;
    const worker = async () => {
      while (cursor < needInfo.length && !blocked) {
        if (signal && signal.aborted) return;
        const it = needInfo[cursor++];
        try {
          const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(it.videoId)}`, {
            headers: { 'User-Agent': DESKTOP_UA, Referer: `https://www.bilibili.com/video/${it.videoId}`, ...(safeBiliCookie ? { Cookie: safeBiliCookie } : {}) },
            signal: signal || AbortSignal.timeout(10000)
          });
          const j = await readJsonResponse(res, 'Bilibili video info');
          if (j.code !== 0 || !j.data) throw new Error(`mã ${j.code}`);
          const d = j.data;
          it.title = d.title || it.title;
          it.duration = Number(d.duration) || it.duration;
          it.cover = d.pic || it.cover;
          it.views = Number(d.stat && d.stat.view) || it.views;
          it.publishedAt = d.pubdate ? new Date(d.pubdate * 1000).toISOString().slice(0, 10) : it.publishedAt;
        } catch (err) {
          if (err.name === 'AbortError') return;
          failed++;
          // Nền tảng đang chặn/giới hạn tốc độ -> dừng gửi thêm yêu cầu (tôn trọng giới hạn truy cập)
          if (/trang HTML|412|429/.test(err.message)) blocked = true;
        }
        await sleep(150);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (blocked) {
      errors.push('Bilibili đang giới hạn tốc độ truy cập — đã dừng đọc chi tiết video (tiêu đề tạm hiển thị theo mã BV, vẫn tải được theo link). Hãy chờ vài phút hoặc dùng Cookie đăng nhập.');
      log('Chi tiết video: nền tảng đang giới hạn truy cập → dừng gửi thêm yêu cầu.');
    } else if (failed > 0) {
      errors.push(`Không đọc được chi tiết ${failed}/${needInfo.length} video (vẫn tải được theo link).`);
      log(`Chi tiết video: lỗi ${failed}/${needInfo.length}.`);
    }
  }

  return { items, hasMore, accountName: resolvedAccountName, errors };
}

/**
 * Quét danh sách video trên trang hồ sơ Douyin / Kuaishou / Xiaohongshu bằng WebKitSniffer + Cookie phiên
 */
async function fetchWebKitProfilePage({
  platformId,
  profileUrl,
  accountId = '',
  page = 1,
  scrollCountOverride = null,
  cookie = '',
  onProc = null
}) {
  const domainSafeCookie = isCookieAllowedForUrl(profileUrl, platformId) ? cookie : '';
  const scrollCount =
    scrollCountOverride !== null
      ? Math.min(6, Math.max(0, Number(scrollCountOverride) || 0))
      : Math.min(4, Math.max(0, (Number(page) || 1) - 1));
  const timeoutMs = 15000 + scrollCount * 2500;

  const sniffRes = await runWebKitSniffer(profileUrl, SAFARI_DESKTOP_UA, timeoutMs, {
    cookie: domainSafeCookie,
    profileMode: true,
    scrollCount,
    onProc
  });

  const parsed = parseWebKitSnifferProfileAndVideos(platformId, sniffRes, accountId, profileOwnerIdFromUrl(platformId, profileUrl));
  if (parsed.items.length === 0 && parsed.skippedForeign > 0 && !parsed.hasCaptcha) {
    parsed.errors.push(
      `Chưa lấy được danh sách video của chủ trang (đã loại ${parsed.skippedForeign} video gợi ý của tài khoản khác).` +
        (domainSafeCookie ? ' Cookie có thể đã hết hạn — đăng nhập lại trên trình duyệt và xuất Cookie mới.' : ' Hãy dán Cookie đăng nhập của bạn rồi quét lại.')
    );
  }
  if (sniffRes.unsupportedReason && parsed.items.length === 0) {
    parsed.errors.push(sniffRes.unsupportedReason);
  }
  if (parsed.hasCaptcha) {
    parsed.errors.push(
      'Nền tảng yêu cầu xác minh CAPTCHA (验证码). Ứng dụng không tự vượt CAPTCHA — hãy nhấn "Mở trang trên Trình duyệt" để tự xác minh và dán lại Cookie mới.'
    );
  }
  if (parsed.hasLoginWall && parsed.items.length === 0) {
    parsed.errors.push(
      domainSafeCookie
        ? 'Cookie phiên đã hết hạn hoặc bị nền tảng từ chối truy cập danh sách video tài khoản này.'
        : 'Trang hồ sơ yêu cầu Cookie đăng nhập để tải danh sách video.'
    );
  }

  return {
    items: parsed.items,
    skippedForeign: parsed.skippedForeign,
    hasMore: parsed.hasMore,
    accountName: parsed.nickname,
    uniqueId: parsed.uniqueId,
    avatar: parsed.avatar,
    signature: parsed.signature,
    followerCount: parsed.followerCount,
    videoCount: parsed.videoCount,
    profileIdentified: parsed.profileIdentified,
    hasCaptcha: parsed.hasCaptcha,
    hasLoginWall: parsed.hasLoginWall,
    errors: parsed.errors
  };
}

/**
 * Khởi chạy hoặc tiếp tục quét danh sách video của tài khoản (Hỗ trợ Phân trang, Chống trùng, Làm mới, Hủy quét)
 */
async function startAccountScanJob({
  rawInput,
  platformId = 'auto',
  page = 1,
  maxPages = 1,
  refresh = false,
  existingScanId = null,
  cookie = '',
  userConsentedCookie = false
}) {
  const rawCookieProvided = Boolean(cookie && String(cookie).trim());
  const preParsed = detectAccountPlatformAndId(rawInput, platformId);
  const useSingleWebKitPass =
    process.env.OFFLINE_TEST_MODE !== '1' &&
    ['douyin', 'kuaishou', 'xiaohongshu'].includes(preParsed.platformId);
  const preview = await previewAccountTarget({
    rawInput,
    platformId,
    cookie,
    userConsentedCookie: userConsentedCookie || rawCookieProvided,
    skipRemoteProbe: useSingleWebKitPass
  });

  if (!preview.supported) {
    return {
      scanId: `unsupported_${Date.now()}`,
      success: false,
      unsupported: true,
      platformId: preview.platformId,
      platformName: preview.platformName,
      status: 'unsupported',
      supportLabel: preview.status,
      statusText: preview.status,
      reason: preview.reason,
      error: preview.reason,
      account: preview.account,
      accountName: preview.displayHandle,
      displayHandle: preview.displayHandle,
      profileUrl: preview.profileUrl,
      totalFound: 0,
      scannedPages: 0,
      videos: []
    };
  }

  const cookieValidation = parseAndValidateCookieInput(
    rawCookieProvided ? cookie : '',
    preview.platformId
  );
  const safeCookie =
    cookieValidation.valid && (userConsentedCookie || rawCookieProvided)
      ? cookieValidation.cookieHeader
      : '';

  // Chỉ "quét tiếp" phiên cũ khi đúng CÙNG nền tảng + CÙNG tài khoản. Trước đây nhập tài khoản mới rồi bấm Quét
  // vẫn dùng lại phiên cũ → hiện video của tài khoản trước đó.
  const targetKey = `${preview.platformId}:${String(preview.accountId || preview.profileUrl || '').trim().toLowerCase()}`;
  let scanJob = existingScanId && !refresh ? activeScanJobs.get(existingScanId) : null;
  if (scanJob && scanJob.targetKey !== targetKey) scanJob = null;
  if (!scanJob) {
    const scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    scanJob = {
      scanId,
      targetKey,
      platformId: preview.platformId,
      platformName: preview.platformName,
      account: preview.account,
      cookieStatus: preview.cookieStatus,
      status: 'scanning', // 'scanning' | 'completed' | 'cancelled' | 'failed'
      progress: 5,
      statusText: 'Đang khởi tạo quét hồ sơ tài khoản...',
      currentPage: page,
      scannedPages: 0,
      hasMore: false,
      videos: [],
      seenKeys: new Set(),
      itemErrors: [],
      hasCaptcha: false,
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null
    };
    activeScanJobs.set(scanId, scanJob);
  } else {
    scanJob.status = 'scanning';
    scanJob.progress = 10;
    scanJob.hasCaptcha = false;
    scanJob.statusText = `Đang tiếp tục quét trang ${page}...`;
    scanJob.error = null;
  }

  const abortCtrl = new AbortController();
  const procSet = new Set();
  scanAbortControllers.set(scanJob.scanId, { abortCtrl, procSet });
  if (!Array.isArray(scanJob.logs)) scanJob.logs = [];
  const log = (msg) => {
    scanJob.logs.push({ at: new Date().toISOString(), msg: redactSensitiveText(String(msg)).slice(0, 400) });
    if (scanJob.logs.length > 200) scanJob.logs.splice(0, scanJob.logs.length - 200);
  };
  log(`Bắt đầu quét ${preview.platformName} — tài khoản ${preview.account?.accountName || preview.accountId} (trang ${page}).`);
  if (safeCookie) log(`Dùng Cookie người dùng (${cookieValidation.cookieCount} trường, chỉ gửi tới ${cookieValidation.domainRestrictedTo.join(', ')}).`);
  const trackProc = (p) => {
    if (p) {
      procSet.add(p);
      p.on('close', () => procSet.delete(p));
    }
  };

  const pagesToFetch = Math.min(5, Math.max(1, Number(maxPages) || 1));
  const startPage = Number(page) || 1;

  (async () => {
    try {
      for (let i = 0; i < pagesToFetch; i++) {
        if (scanJob.status === 'cancelled' || abortCtrl.signal.aborted) break;

        const curPage = startPage + i;
        scanJob.currentPage = curPage;
        scanJob.progress = Math.min(90, Math.round(((i + 0.3) / pagesToFetch) * 100));
        scanJob.statusText = `Đang quét danh sách video (Trang ${curPage}/${startPage + pagesToFetch - 1})...`;

        let pageRes;
        if (process.env.OFFLINE_TEST_MODE === '1') {
          await sleep(450);
          pageRes = {
            accountName: scanJob.account.accountName || 'OfflineTestUser',
            hasMore: curPage < 3,
            items: [
              {
                videoId: `offline_${curPage}_1`,
                title: `Video Kiểm Thử Offline #${curPage}`,
                url: `${scanJob.account.profileUrl || 'https://space.bilibili.com/1'}/video_${curPage}`,
                duration: 45,
                publishedAt: '2026-11-14',
                views: 1200,
                downloadable: true,
                statusNote: 'Tải được'
              }
            ],
            errors: []
          };
        } else if (scanJob.platformId === 'bilibili') {
          pageRes = await fetchBilibiliAccountPage({
            accountId: scanJob.account.accountId,
            accountName: scanJob.account.accountName,
            page: curPage,
            pageSize: 20,
            cookie: safeCookie,
            signal: abortCtrl.signal,
            onProc: trackProc,
            log
          });
        } else {
          // Chạy 1 phiên WebKitSniffer duy nhất với cuộn liên tiếp để lấy đúng phân trang XHR thay vì mở WebKit mới lặp lại
          const scrollOverride = !existingScanId || refresh ? Math.min(5, pagesToFetch) : Math.min(6, startPage + pagesToFetch - 1);
          scanJob.statusText = `Đang mở trình duyệt nền & thu thập dữ liệu hồ sơ ${scanJob.platformName}...`;
          log(`Mở WebKit nền (cuộn ${scrollOverride} lần) tại ${scanJob.account.profileUrl}${safeCookie ? ' với Cookie người dùng' : ' không Cookie'}...`);
          pageRes = await fetchWebKitProfilePage({
            platformId: scanJob.platformId,
            profileUrl: scanJob.account.profileUrl,
            accountId: scanJob.account.accountId,
            page: curPage,
            scrollCountOverride: scrollOverride,
            cookie: safeCookie,
            onProc: (p) => {
              if (p) {
                procSet.add(p);
                p.on('close', () => procSet.delete(p));
              }
            }
          });
        }

        if (scanJob.status === 'cancelled' || abortCtrl.signal.aborted) break;
        if (scanJob.platformId !== 'bilibili' && (pageRes.items || []).length === 0 && !pageRes.profileIdentified && !(pageRes.errors || []).length) {
          pageRes.errors = [
            safeCookie
              ? `Không nhận diện được hồ sơ ${scanJob.platformName} dù đã có Cookie: tài khoản có thể không tồn tại/đặt riêng tư, hoặc Cookie đã hết hạn.`
              : `Không nhận diện được hồ sơ ${scanJob.platformName}: tài khoản có thể không tồn tại, hoặc nền tảng yêu cầu đăng nhập — hãy dán Cookie đăng nhập của bạn rồi quét lại.`
          ];
        }
        if (scanJob.platformId !== 'bilibili') {
          log(
            `WebKit: ${(pageRes.items || []).length} video của chủ trang` +
              `${pageRes.skippedForeign ? ` (đã loại ${pageRes.skippedForeign} video gợi ý của tài khoản khác)` : ''}` +
              ` • hồ sơ ${pageRes.profileIdentified ? 'đã nhận diện' : 'chưa nhận diện'}` +
              `${pageRes.hasCaptcha ? ' • GẶP CAPTCHA' : ''}${pageRes.hasLoginWall ? ' • yêu cầu đăng nhập' : ''}` +
              `${(pageRes.errors || []).length ? ` • lỗi: ${(pageRes.errors || []).join(' | ')}` : ''}`
          );
        }

        if (pageRes.accountName) {
          scanJob.account.accountName = pageRes.accountName;
          scanJob.account.profileIdentified = true;
        }
        if (pageRes.uniqueId) {
          scanJob.account.accountId = pageRes.uniqueId;
        }
        if (pageRes.avatar && !scanJob.account.avatar) {
          scanJob.account.avatar = pageRes.avatar;
        }
        if (pageRes.signature && !scanJob.account.signature) {
          scanJob.account.signature = pageRes.signature;
        }
        if (pageRes.followerCount !== null && pageRes.followerCount !== undefined) {
          scanJob.account.followerCount = pageRes.followerCount;
        }
        if (pageRes.videoCount !== null && pageRes.videoCount !== undefined) {
          scanJob.account.videoCount = pageRes.videoCount;
        }
        if (scanJob.account.profileIdentified) {
          const statParts = [];
          if (scanJob.account.followerCount !== null && scanJob.account.followerCount !== undefined) {
            statParts.push(`${scanJob.account.followerCount} người theo dõi`);
          }
          if (scanJob.account.videoCount !== null && scanJob.account.videoCount !== undefined) {
            statParts.push(`${scanJob.account.videoCount} video`);
          }
          if (statParts.length > 0) {
            scanJob.account.followerText = statParts.join(' • ');
          } else {
            scanJob.account.followerText = 'Đã nhận diện hồ sơ';
          }
        }
        if (pageRes.hasCaptcha) {
          scanJob.hasCaptcha = true;
        }
        if (scanJob.cookieStatus) {
          if (pageRes.hasCaptcha) {
            scanJob.cookieStatus.verifiedAuth = false;
            scanJob.cookieStatus.message =
              'Nền tảng yêu cầu xác minh CAPTCHA (验证码). Hãy mở trang trong trình duyệt thường để xác minh thủ công rồi dán lại Cookie.';
          } else if (pageRes.hasLoginWall && (pageRes.items || []).length === 0) {
            scanJob.cookieStatus.verifiedAuth = false;
            scanJob.cookieStatus.message = safeCookie
              ? 'Cookie đã cung cấp nhưng phiên đăng nhập bị từ chối hoặc đã hết hạn.'
              : 'Yêu cầu cung cấp Cookie đăng nhập hợp lệ.';
          } else if (scanJob.account.profileIdentified && safeCookie && cookieValidation.hasAuthSessionKey) {
            scanJob.cookieStatus.verifiedAuth = true;
            scanJob.cookieStatus.message = `Đã xác minh Cookie ${scanJob.platformName} và quét hồ sơ "${scanJob.account.accountName}".`;
          } else if (scanJob.account.profileIdentified && safeCookie) {
            scanJob.cookieStatus.verifiedAuth = false;
            scanJob.cookieStatus.message = `Đã nhận diện hồ sơ "${scanJob.account.accountName}" (Cookie thiếu khóa session đăng nhập đầy đủ).`;
          }
        }

        if (Array.isArray(pageRes.errors) && pageRes.errors.length > 0) {
          for (const errMsg of pageRes.errors) {
            const cleanErr = redactSensitiveText(errMsg);
            if (!scanJob.itemErrors.includes(cleanErr)) {
              scanJob.itemErrors.push(cleanErr);
            }
          }
        }

        let addedOnPage = 0;
        for (const item of pageRes.items || []) {
          if (!item || !item.videoId) continue;
          const dedupKey = `${scanJob.platformId}_${item.videoId}`;
          if (scanJob.seenKeys.has(dedupKey)) continue;
          scanJob.seenKeys.add(dedupKey);

          scanJob.videos.push({
            dedupKey,
            uniqueKey: dedupKey,
            platformId: scanJob.platformId,
            platformName: scanJob.platformName,
            videoId: String(item.videoId),
            title: item.title || `Video ${item.videoId}`,
            url: item.url,
            cover: item.cover || '',
            duration: item.duration || 0,
            publishedAt: item.publishedAt || '',
            publishDate: item.publishedAt || '',
            views: item.views || 0,
            author: item.author || scanJob.account.accountName,
            downloadable: item.downloadable !== false,
            statusNote: item.statusNote || 'Sẵn sàng tải',
            downloadStatusText: item.statusNote || (item.downloadable !== false ? 'Tải được' : 'Giới hạn')
          });
          addedOnPage++;
        }

        scanJob.scannedPages += 1;
        log(`Trang ${curPage}: thêm ${addedOnPage} video mới (tổng ${scanJob.videos.length}).`);
        scanJob.hasMore = Boolean(pageRes.hasMore || (scanJob.platformId !== 'bilibili' && addedOnPage >= 6));
        scanJob.updatedAt = new Date().toISOString();

        if (
          !scanJob.hasMore ||
          i === pagesToFetch - 1 ||
          (scanJob.platformId !== 'bilibili' && process.env.OFFLINE_TEST_MODE !== '1')
        ) {
          break;
        }

        scanJob.statusText = `Đã tìm thấy ${scanJob.videos.length} video. Đang chờ 1.2s trước khi sang trang ${curPage + 1}...`;
        await sleep(1200);
      }

      scanAbortControllers.delete(scanJob.scanId);
      if (scanJob.status === 'cancelled') {
        scanJob.statusText = 'Đã hủy quét tài khoản.';
        return;
      }

      scanJob.progress = 100;
      scanJob.status = scanJob.videos.length === 0 && scanJob.itemErrors.length > 0 ? 'failed' : 'completed';
      log(`Kết thúc: ${scanJob.status === 'failed' ? 'thất bại' : 'hoàn tất'} — ${scanJob.videos.length} video.`);
      if (scanJob.videos.length > 0) {
        scanJob.statusText = `Hoàn tất quét! Tìm thấy ${scanJob.videos.length} video không trùng lặp (${scanJob.scannedPages} trang).`;
      } else {
        const specificReason =
          scanJob.itemErrors[0] ||
          (safeCookie
            ? 'Không tìm thấy video công khai hoặc Cookie đã hết hạn/gặp xác minh CAPTCHA.'
            : 'Không tìm thấy video công khai (tài khoản trống hoặc nền tảng yêu cầu Cookie phiên đăng nhập).');
        scanJob.statusText = `${scanJob.status === 'failed' ? 'Quét thất bại' : 'Hoàn tất quét nhưng chưa có video'}: ${specificReason}`;
        if (scanJob.hasCaptcha || scanJob.itemErrors.length > 0) {
          scanJob.error = specificReason;
        }
      }
    } catch (err) {
      scanAbortControllers.delete(scanJob.scanId);
      if (scanJob.status === 'cancelled' || err.name === 'AbortError') {
        scanJob.status = 'cancelled';
        scanJob.statusText = 'Đã hủy quét tài khoản.';
        return;
      }
      scanJob.status = 'failed';
      scanJob.error = redactSensitiveText(err.message);
      scanJob.statusText = `Lỗi quét tài khoản: ${scanJob.error}`;
      log(`Lỗi: ${scanJob.error}`);
    }
  })();

  const serialized = serializeScanJob(scanJob);
  return {
    success: true,
    ...serialized,
    scanJob: serialized
  };
}

function serializeScanJob(job) {
  if (!job) return null;
  return {
    scanId: job.scanId,
    platformId: job.platformId,
    platformName: job.platformName,
    account: job.account,
    cookieStatus: job.cookieStatus || null,
    accountName: job.account?.accountName || job.account?.accountId || '',
    displayHandle: job.account?.accountName || job.account?.accountId || '',
    profileUrl: job.account?.profileUrl || '',
    status: job.status,
    progress: job.progress,
    statusText: job.statusText,
    currentPage: job.currentPage,
    scannedPages: job.scannedPages,
    hasMore: job.hasMore,
    totalVideos: job.videos.length,
    totalFound: job.videos.length,
    videos: job.videos,
    itemErrors: job.itemErrors.slice(-10),
    logs: (job.logs || []).slice(-80),
    hasCaptcha: Boolean(job.hasCaptcha),
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt
  };
}

/* ---------------------- Quét NHIỀU tài khoản (tuần tự, có giới hạn tốc độ) ---------------------- */
const multiScanJobs = new Map();
const MULTI_SCAN_MAX_ACCOUNTS = 50;
const MULTI_SCAN_DELAY_MS = 2500; // nghỉ giữa các tài khoản để tránh bị giới hạn tốc độ

function serializeMultiScan(job) {
  if (!job) return null;
  const done = job.items.filter((x) => !['pending', 'scanning'].includes(x.status)).length;
  return {
    batchId: job.batchId,
    status: job.status,
    total: job.items.length,
    done,
    progress: job.items.length ? Math.round((done / job.items.length) * 100) : 100,
    totalVideos: job.items.reduce((m, x) => m + (x.videosFound || 0), 0),
    items: job.items.map((x) => ({ ...x })),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null
  };
}

function startMultiAccountScan({ inputs, platformId = 'auto', maxPages = 1, cookie = '', userConsentedCookie = false } = {}) {
  const raw = Array.isArray(inputs) ? inputs : String(inputs || '').split(/\r?\n/);
  const list = Array.from(new Set(raw.map((x) => String(x || '').trim()).filter(Boolean)));
  if (list.length === 0) throw new Error('Vui lòng nhập ít nhất 1 tài khoản (mỗi dòng một link hồ sơ hoặc UID).');
  if (list.length > MULTI_SCAN_MAX_ACCOUNTS) {
    throw new Error(`Tối đa ${MULTI_SCAN_MAX_ACCOUNTS} tài khoản mỗi lượt quét (đang có ${list.length}).`);
  }
  const batchId = `multi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    batchId,
    status: 'scanning',
    cancelled: false,
    currentScanId: null,
    items: list.map((input) => ({ input, status: 'pending', scanId: null, platformName: '', accountName: '', videosFound: 0, error: null })),
    startedAt: new Date().toISOString()
  };
  multiScanJobs.set(batchId, job);

  (async () => {
    for (let i = 0; i < job.items.length; i++) {
      const item = job.items[i];
      if (job.cancelled) {
        item.status = 'cancelled';
        continue;
      }
      item.status = 'scanning';
      try {
        const r = await startAccountScanJob({ rawInput: item.input, platformId, maxPages, cookie, userConsentedCookie });
        item.platformName = r.platformName || '';
        if (r.unsupported) {
          item.status = 'unsupported';
          item.error = r.reason || 'Nền tảng chưa hỗ trợ quét tài khoản.';
        } else {
          item.scanId = r.scanId;
          job.currentScanId = r.scanId;
          let st = getAccountScanStatus(r.scanId);
          while (st && st.status === 'scanning') {
            await sleep(500);
            st = getAccountScanStatus(r.scanId);
          }
          item.status = st ? st.status : 'failed';
          item.accountName = st ? st.accountName : '';
          item.videosFound = st ? st.videos.length : 0;
          item.error = st ? st.error || (st.status === 'failed' ? st.statusText : null) : 'Mất trạng thái quét.';
        }
      } catch (err) {
        item.status = 'failed';
        item.error = redactSensitiveText(err.message);
      }
      job.currentScanId = null;
      if (i < job.items.length - 1 && !job.cancelled) await sleep(MULTI_SCAN_DELAY_MS);
    }
    job.status = job.cancelled ? 'cancelled' : 'completed';
    job.finishedAt = new Date().toISOString();
  })();

  return serializeMultiScan(job);
}

function getMultiAccountScanStatus(batchId) {
  return serializeMultiScan(multiScanJobs.get(batchId));
}

function cancelMultiAccountScan(batchId) {
  const job = multiScanJobs.get(batchId);
  if (!job) return { success: false, error: 'Không tìm thấy lượt quét nhiều tài khoản.' };
  job.cancelled = true;
  if (job.currentScanId) cancelAccountScanJob(job.currentScanId);
  return { success: true, batch: serializeMultiScan(job) };
}

function getAccountScanStatus(scanId) {
  if (scanId) {
    const job = activeScanJobs.get(scanId);
    return job ? serializeScanJob(job) : null;
  }
  const all = Array.from(activeScanJobs.values()).map(serializeScanJob).reverse();
  return all[0] || null;
}

function cancelAccountScanJob(scanId) {
  const job = activeScanJobs.get(scanId);
  if (!job) return { success: false, message: 'Không tìm thấy phiên quét tài khoản.' };

  job.status = 'cancelled';
  job.statusText = 'Đã hủy quét theo yêu cầu người dùng.';
  const ctrlEntry = scanAbortControllers.get(scanId);
  if (ctrlEntry) {
    try {
      ctrlEntry.abortCtrl.abort();
    } catch (_) {}
    if (ctrlEntry.procSet) {
      for (const p of ctrlEntry.procSet) {
        try {
          p.kill('SIGKILL');
        } catch (_) {}
      }
      ctrlEntry.procSet.clear();
    }
    scanAbortControllers.delete(scanId);
  }
  const serialized = serializeScanJob(job);
  return { success: true, scan: serialized, scanJob: serialized };
}

/**
 * Hàng đợi Tải Hàng loạt (Batch Download Queue) với giới hạn số tác vụ đồng thời (Concurrency Limit)
 * - Đảm bảo truyền Cookie phiên (đã xác thực đúng miền) xuống `startRealDownload` -> `analyzeVideo` / `yt-dlp`.
 * - Tuyệt đối không lộ trường `cookie` khi trả về `getBatchQueueInfo()`.
 */
const batchQueueState = {
  concurrency: 2,
  pendingQueue: [],
  processing: false
};

async function processBatchQueue() {
  if (batchQueueState.processing) return;
  batchQueueState.processing = true;

  try {
    while (batchQueueState.pendingQueue.length > 0) {
      const activeCount = Array.from(activeDownloads.values()).filter((j) => j.status === 'downloading').length;
      if (activeCount >= batchQueueState.concurrency) {
        await sleep(800);
        continue;
      }

      const nextItem = batchQueueState.pendingQueue.shift();
      if (!nextItem) continue;

      try {
        await startRealDownload({
          platform: nextItem.platformId || 'bilibili',
          title: nextItem.title || `Video_${nextItem.videoId}`,
          videoId: nextItem.videoId || '',
          targetUrl: nextItem.url,
          outputFormat: nextItem.outputFormat || 'mp4',
          cookie: nextItem.cookie || ''
        });
      } catch (_) {}

      await sleep(350);
    }
  } finally {
    batchQueueState.processing = false;
  }
}

function enqueueBatchDownloads({
  items = [],
  videos = [],
  concurrency = null,
  maxConcurrent = null,
  outputFormat = 'mp4',
  cookie = '',
  userConsentedCookie = false
}) {
  const inputList = Array.isArray(videos) && videos.length > 0 ? videos : items;
  if (!Array.isArray(inputList) || inputList.length === 0) {
    throw new Error('Vui lòng chọn ít nhất 1 video hợp lệ để đưa vào hàng đợi tải.');
  }

  const requestedConc = maxConcurrent ?? concurrency ?? 2;
  batchQueueState.concurrency = Math.min(3, Math.max(1, Number(requestedConc) || 2));
  const rawCookieProvided = Boolean(cookie && String(cookie).trim());

  let enqueuedCount = 0;
  let skippedDuplicateCount = 0;

  for (const item of inputList) {
    if (!item || !item.url || item.downloadable === false) continue;
    const itemPlatform = item.platformId || 'douyin';
    const dedupKey = `${itemPlatform}_${item.videoId}_${outputFormat}`;

    const alreadyActive = Array.from(activeDownloads.values()).some(
      (j) => j.platform === itemPlatform && j.videoId === item.videoId && j.status === 'downloading'
    );
    const alreadyPending = batchQueueState.pendingQueue.some(
      (q) => q.platformId === itemPlatform && q.videoId === item.videoId
    );

    if (alreadyActive || alreadyPending) {
      skippedDuplicateCount++;
      continue;
    }

    // Xác thực và giới hạn miền Cookie cho từng mục trong hàng đợi tải hàng loạt
    let itemSafeCookie = '';
    if (rawCookieProvided && (userConsentedCookie || rawCookieProvided)) {
      const validated = parseAndValidateCookieInput(cookie, itemPlatform);
      if (validated.valid && isCookieAllowedForUrl(item.url, itemPlatform)) {
        itemSafeCookie = validated.cookieHeader;
      }
    }

    batchQueueState.pendingQueue.push({
      dedupKey,
      platformId: itemPlatform,
      videoId: item.videoId,
      title: item.title,
      url: item.url,
      outputFormat,
      cookie: itemSafeCookie
    });
    enqueuedCount++;
  }

  processBatchQueue();

  return {
    success: true,
    addedCount: enqueuedCount,
    enqueuedCount,
    skippedDuplicateCount,
    pendingInQueue: batchQueueState.pendingQueue.length,
    concurrency: batchQueueState.concurrency,
    maxConcurrent: batchQueueState.concurrency
  };
}

function clearPendingBatchQueue() {
  const cleared = batchQueueState.pendingQueue.length;
  batchQueueState.pendingQueue = [];
  return { success: true, clearedCount: cleared };
}

function getBatchQueueInfo() {
  const runningCount = Array.from(activeDownloads.values()).filter((j) => j.status === 'downloading').length;
  // Loại bỏ hoàn toàn trường `cookie` khỏi `pendingItems` trước khi trả về qua API
  const safePendingItems = batchQueueState.pendingQueue.map(({ cookie, ...safeRest }) => ({
    ...safeRest,
    hasAuthCookie: Boolean(cookie)
  }));
  return {
    concurrency: batchQueueState.concurrency,
    maxConcurrent: batchQueueState.concurrency,
    runningCount,
    pendingCount: safePendingItems.length,
    pendingItems: safePendingItems
  };
}

module.exports = {
  startMultiAccountScan,
  getMultiAccountScanStatus,
  cancelMultiAccountScan,
  ACCOUNT_SCAN_SUPPORT,
  PLATFORM_COOKIE_RULES,
  isCookieAllowedForUrl,
  parseAndValidateCookieInput,
  redactSensitiveText,
  previewAccountTarget,
  startAccountScanJob,
  getAccountScanStatus,
  cancelAccountScanJob,
  enqueueBatchDownloads,
  clearPendingBatchQueue,
  getBatchQueueInfo
};

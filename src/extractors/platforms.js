/**
 * Định nghĩa cấu hình chi tiết cho 12 nền tảng Video Trung Quốc
 * Tích hợp cơ chế Smart Auto-Discovery:
 *   Người dùng chỉ cần dán 1 link bất kỳ (Web link / Share link / Feed link),
 *   hệ thống tự động tổng hợp (Synthesize) cả 3 dạng: Canonical Link, UTM Mobile Token Link và oEmbed Player Link!
 */

const PLATFORMS = {
  douyin: {
    id: 'douyin',
    index: 1,
    name: 'Douyin (抖音)',
    folderName: 'Douyin',
    category: 'Short Video',
    company: 'ByteDance',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'link', 'utm', 'obem'],
    domains: ['douyin.com', 'iesdouyin.com', 'v.douyin.com'],
    preserveQueryKeys: ['modal_id', 'vid'],
    injectUtmParams: {
      utm_source: 'copy',
      utm_campaign: 'client_share',
      app: 'aweme'
    },
    embedTemplate: (videoId) => `https://open.douyin.com/player/video?vid=${videoId}&autoplay=1`,
    mobileShareTemplate: (videoId) => `https://www.iesdouyin.com/share/video/${videoId}/`,
    canonicalTemplate: (videoId) => `https://www.douyin.com/video/${videoId}`,
    description: 'Tự động trích xuất videoId từ mọi link Douyin (jingxuan/modal_id, v.douyin.com, video) và mở khóa qua WebKit Open Player.'
  },
  kuaishou: {
    id: 'kuaishou',
    index: 2,
    name: 'Kuaishou (快手)',
    folderName: 'Kuaishou',
    category: 'Short Video',
    company: 'Kuaishou Tech',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'utm', 'link', 'obem'],
    domains: ['kuaishou.com', 'v.kuaishou.com', 'chenzhongtech.com', 'gifshow.com'],
    preserveQueryKeys: ['shareToken', 'shareObjectId', 'shareId', 'photoId', 'utm_source', 'fid', 'cc'],
    injectUtmParams: {
      utm_source: 'app_share',
      utm_medium: 'app_share'
    },
    embedTemplate: (videoId) => `https://www.kuaishou.com/short-video/${videoId}?utm_source=app_share`,
    mobileShareTemplate: (videoId) => `https://c.kuaishou.com/fw/photo/${videoId}?utm_source=app_share`,
    canonicalTemplate: (videoId) => `https://www.kuaishou.com/short-video/${videoId}`,
    description: 'Tự động giả lập UTM Mobile Share & trích xuất luồng MP4 gốc qua WebKit Apollo/GraphQL mà không cần tự tìm link UTM.'
  },
  pipixia: {
    id: 'pipixia',
    index: 3,
    name: 'Pipixia (皮皮虾)',
    folderName: 'Pipixia',
    category: 'Short Video / Humor',
    company: 'ByteDance',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'link', 'utm', 'obem'],
    domains: ['pipix.com', 'h5.pipix.com'],
    preserveQueryKeys: ['item_id', 'cell_id', 'source'],
    injectUtmParams: {
      source: 'share',
      utm_source: 'copy_link',
      app_id: '1319'
    },
    embedTemplate: (videoId) => `https://h5.pipix.com/bds/webapi/item/detail/?item_id=${videoId}&source=share`,
    mobileShareTemplate: (videoId) => `https://h5.pipix.com/item/${videoId}?source=share&utm_source=copy_link`,
    canonicalTemplate: (videoId) => `https://h5.pipix.com/item/${videoId}`,
    description: 'Tự động chuyển đổi link Pipixia sang endpoint WebAPI H5 để lấy video_download không watermark.'
  },
  youku: {
    id: 'youku',
    index: 4,
    name: 'Youku (优酷)',
    folderName: 'Youku',
    category: 'Long-form OTT',
    company: 'Alibaba',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'obem', 'link', 'utm'],
    domains: ['youku.com', 'v.youku.com', 'player.youku.com', 'm.youku.com'],
    preserveQueryKeys: ['spm', 'vid'],
    injectUtmParams: {
      utm_source: 'share'
    },
    embedTemplate: (videoId) => `https://player.youku.com/embed/${videoId}`,
    mobileShareTemplate: (videoId) => `https://m.youku.com/alipay_video/id_${videoId}.html`,
    canonicalTemplate: (videoId) => `https://v.youku.com/v_show/id_${videoId}.html`,
    description: 'Tự động trích xuất ID video Youku và chuyển đổi sang Embed Player + yt-dlp.'
  },
  tencent: {
    id: 'tencent',
    index: 5,
    name: 'Tencent Video (腾讯视频)',
    folderName: 'TencentVideo',
    category: 'Long-form OTT',
    company: 'Tencent',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'obem', 'link', 'utm'],
    domains: ['v.qq.com', 'qq.com/x/page', 'qq.com/x/cover', 'm.v.qq.com'],
    preserveQueryKeys: ['vid', 'cid', 'ptag'],
    injectUtmParams: {
      ptag: 'v_qq_com',
      utm_source: 'share'
    },
    embedTemplate: (videoId) => `https://v.qq.com/txp/iframe/player.html?vid=${videoId}`,
    mobileShareTemplate: (videoId) => `https://m.v.qq.com/x/m/play?vid=${videoId}`,
    canonicalTemplate: (videoId) => `https://v.qq.com/x/page/${videoId}.html`,
    description: 'Tự động dò tìm vid từ trang cover/page và tạo link TXP Embed Player + yt-dlp.'
  },
  iqiyi: {
    id: 'iqiyi',
    index: 6,
    name: 'iQIYI (爱奇艺)',
    folderName: 'iQIYI',
    category: 'Long-form OTT',
    company: 'Baidu',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'link', 'obem', 'utm'],
    domains: ['iqiyi.com', 'iq.com', 'm.iqiyi.com'],
    preserveQueryKeys: ['tvid', 'vid'],
    injectUtmParams: {
      utm_source: 'share',
      vfrm: 'pcw_home'
    },
    embedTemplate: (videoId) => `https://www.iqiyi.com/v_${videoId}.html`,
    mobileShareTemplate: (videoId) => `https://m.iqiyi.com/v_${videoId}.html`,
    canonicalTemplate: (videoId) => `https://www.iqiyi.com/v_${videoId}.html`,
    description: 'Hỗ trợ tự động nhận diện cả iqiyi.com và bản quốc tế iq.com.'
  },
  mangotv: {
    id: 'mangotv',
    index: 7,
    name: 'MangoTV (芒果TV)',
    folderName: 'MangoTV',
    category: 'Long-form OTT / Variety',
    company: 'Hunan TV',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'utm', 'link', 'obem'],
    domains: ['mgtv.com', 'w.mgtv.com', 'm.mgtv.com'],
    preserveQueryKeys: ['fpa', 'fpos', 'video_id'],
    injectUtmParams: {
      utm_source: 'share',
      fpa: 'se'
    },
    embedTemplate: (videoId) => `https://pcweb.api.mgtv.com/player/video?video_id=${videoId}`,
    mobileShareTemplate: (videoId) => `https://m.mgtv.com/b/${videoId}.html`,
    canonicalTemplate: (videoId) => `https://www.mgtv.com/b/${videoId}.html`,
    description: 'Tự động tách video_id từ link MangoTV và gọi API thông tin + luồng HLS.'
  },
  wetv: {
    id: 'wetv',
    index: 8,
    name: 'WeTV',
    folderName: 'WeTV',
    category: 'Global OTT',
    company: 'Tencent Global',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'utm', 'link', 'obem'],
    domains: ['wetv.vip'],
    preserveQueryKeys: ['vid', 'cid', 'language', 'utm_source'],
    injectUtmParams: {
      utm_source: 'copy_link',
      language: 'vi'
    },
    embedTemplate: (videoId) => `https://wetv.vip/en/play/${videoId}`,
    mobileShareTemplate: (videoId) => `https://wetv.vip/vi/play/${videoId}`,
    canonicalTemplate: (videoId) => `https://wetv.vip/vi/play/${videoId}`,
    description: 'Tự động bóc tách tập phim WeTV quốc tế và tải qua yt-dlp + FFmpeg.'
  },
  bilibili: {
    id: 'bilibili',
    index: 9,
    name: 'Bilibili (哔哩哔哩)',
    folderName: 'Bilibili',
    category: 'UGC / Anime / Tech',
    company: 'Bilibili Inc.',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'obem', 'link', 'utm'],
    domains: ['bilibili.com', 'bilibili.tv', 'b23.tv', 'player.bilibili.com', 'm.bilibili.com'],
    preserveQueryKeys: ['p'],
    injectUtmParams: {
      share_source: 'copy_web',
      utm_source: 'copy_link'
    },
    embedTemplate: (videoId) =>
      /^(BV|av)/i.test(videoId)
        ? `https://player.bilibili.com/player.html?bvid=${videoId}&high_quality=1&danmaku=0`
        : `https://www.bilibili.tv/vi/video/${videoId}`,
    mobileShareTemplate: (videoId) =>
      /^(BV|av)/i.test(videoId)
        ? `https://m.bilibili.com/video/${videoId}`
        : `https://www.bilibili.tv/vi/video/${videoId}?share_source=copy_web`,
    canonicalTemplate: (videoId) =>
      /^(BV|av)/i.test(videoId)
        ? `https://www.bilibili.com/video/${videoId}`
        : `https://www.bilibili.tv/vi/video/${videoId}`,
    description: 'Tự động giải mã b23.tv / BVid / Bilibili.tv và ghép luồng Video + Audio chuẩn H.264 MP4.'
  },
  xigua: {
    id: 'xigua',
    index: 10,
    name: 'Xigua Video (西瓜视频)',
    folderName: 'XiguaVideo',
    category: 'Mid/Long Video',
    company: 'ByteDance',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'obem', 'link', 'utm'],
    domains: ['ixigua.com', 'v.ixigua.com', 'm.ixigua.com'],
    preserveQueryKeys: ['id', 'logTag'],
    injectUtmParams: {
      utm_source: 'copy_link'
    },
    embedTemplate: (videoId) => `https://www.ixigua.com/iframe/${videoId}?autoplay=1`,
    mobileShareTemplate: (videoId) => `https://m.ixigua.com/video/${videoId}/`,
    canonicalTemplate: (videoId) => `https://www.ixigua.com/${videoId}`,
    description: 'Tự động chuyển đổi link Xigua sang Iframe Player (/iframe/{id}) để vượt qua __ac_signature.'
  },
  xiaohongshu: {
    id: 'xiaohongshu',
    index: 11,
    name: 'Xiaohongshu (小红书)',
    folderName: 'Xiaohongshu',
    category: 'Lifestyle / Video Note',
    company: 'Xiaohongshu',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'utm', 'link', 'obem'],
    domains: ['xiaohongshu.com', 'xhslink.com'],
    preserveQueryKeys: ['xsec_token', 'xsec_source', 'utm_source', 'xhsshare', 'appuid', 'apptime'],
    injectUtmParams: {
      xsec_source: 'pc_share',
      utm_source: 'copy_link'
    },
    embedTemplate: (videoId) => `https://www.xiaohongshu.com/explore/${videoId}`,
    mobileShareTemplate: (videoId) => `https://www.xiaohongshu.com/discovery/item/${videoId}`,
    canonicalTemplate: (videoId) => `https://www.xiaohongshu.com/explore/${videoId}`,
    description: 'Tự động bảo toàn xsec_token hoặc mở qua WebKit Sniffer để trích xuất video gốc không watermark.'
  },
  jianying: {
    id: 'jianying',
    index: 12,
    name: 'Jianying (剪映)',
    folderName: 'Jianying',
    category: 'Video Template / Creative',
    company: 'ByteDance',
    recommendedMethod: 'auto',
    supportedMethods: ['auto', 'link', 'utm', 'obem'],
    domains: ['jianying.com', 'v.jianying.com', 'capcut.cn', 'capcut.com', 'ulikecam.com'],
    preserveQueryKeys: ['template_id', 'share_id', 'video_id', 'enter_from', 'utm_source'],
    injectUtmParams: {
      enter_from: 'share_link',
      utm_source: 'copy_link'
    },
    embedTemplate: (videoId) => `https://www.jianying.com/share/template/${videoId}`,
    mobileShareTemplate: (videoId) => `https://m.ulikecam.com/template/detail?id=${videoId}`,
    canonicalTemplate: (videoId) => `https://www.jianying.com/share/template/${videoId}`,
    description: 'Tự động giải mã link chia sẻ mẫu Jianying/CapCut và bóc tách video mẫu không logo.'
  }
};

function extractUrlFromText(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  const trimmed = rawInput.trim();

  const iframeMatch = trimmed.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (iframeMatch && iframeMatch[1]) {
    let src = iframeMatch[1].trim();
    if (src.startsWith('//')) src = 'https:' + src;
    return src;
  }

  const urlMatch = trimmed.match(/https?:\/\/[^\s"'<>\\，。！？；：）】》]+/i);
  if (urlMatch) {
    return urlMatch[0].replace(/[.,;!?)\]}'"`]+$/, '');
  }

  return trimmed;
}

function detectPlatform(inputUrlOrText) {
  const lower = (inputUrlOrText || '').toLowerCase();
  for (const [, cfg] of Object.entries(PLATFORMS)) {
    for (const domain of cfg.domains) {
      if (lower.includes(domain)) {
        return cfg;
      }
    }
  }
  if (lower.includes('抖音')) return PLATFORMS.douyin;
  if (lower.includes('快手')) return PLATFORMS.kuaishou;
  if (lower.includes('皮皮虾')) return PLATFORMS.pipixia;
  if (lower.includes('优酷')) return PLATFORMS.youku;
  if (lower.includes('腾讯视频')) return PLATFORMS.tencent;
  if (lower.includes('爱奇艺')) return PLATFORMS.iqiyi;
  if (lower.includes('芒果tv') || lower.includes('芒果')) return PLATFORMS.mangotv;
  if (lower.includes('哔哩哔哩') || lower.includes('bilibili')) return PLATFORMS.bilibili;
  if (lower.includes('西瓜视频')) return PLATFORMS.xigua;
  if (lower.includes('小红书')) return PLATFORMS.xiaohongshu;
  if (lower.includes('剪映')) return PLATFORMS.jianying;

  return null;
}

function extractVideoId(platformId, urlStr) {
  if (!urlStr) return null;
  try {
    const parsed = new URL(urlStr);
    const path = parsed.pathname;
    const params = parsed.searchParams;

    switch (platformId) {
      case 'douyin': {
        if (params.get('modal_id')) return params.get('modal_id');
        if (params.get('vid')) return params.get('vid');
        const m = path.match(/\/(?:video|note|share\/video|share\/note)\/(\d{15,22})/);
        return m ? m[1] : null;
      }
      case 'kuaishou': {
        if (params.get('photoId')) return params.get('photoId');
        if (params.get('shareObjectId')) return params.get('shareObjectId');
        const m = path.match(/\/(?:short-video|photo|fw\/photo)\/([a-zA-Z0-9_-]{8,32})/);
        return m ? m[1] : null;
      }
      case 'pipixia': {
        if (params.get('item_id')) return params.get('item_id');
        if (params.get('cell_id')) return params.get('cell_id');
        const m = path.match(/\/item\/(\d{10,25})/);
        return m ? m[1] : null;
      }
      case 'youku': {
        if (params.get('vid')) return params.get('vid');
        const m1 = path.match(/id_([a-zA-Z0-9=_]+?)(?:\.html|$)/);
        if (m1) return m1[1];
        const m2 = path.match(/\/embed\/([a-zA-Z0-9=_]+)/);
        return m2 ? m2[1] : null;
      }
      case 'tencent': {
        if (params.get('vid')) return params.get('vid');
        const m1 = path.match(/\/page\/([a-zA-Z0-9]+)(?:\.html|$)/);
        if (m1) return m1[1];
        const m2 = path.match(/\/cover\/[^/]+\/([a-zA-Z0-9]+)(?:\.html|$)/);
        if (m2) return m2[1];
        const m3 = path.match(/\/cover\/([a-zA-Z0-9]+)(?:\.html|$)/);
        return m3 ? m3[1] : null;
      }
      case 'iqiyi': {
        const m = path.match(/\/(?:v_|play\/)([a-zA-Z0-9_-]+?)(?:\.html|$)/);
        return m ? m[1] : null;
      }
      case 'mangotv': {
        if (params.get('video_id')) return params.get('video_id');
        const m = path.match(/\/b\/\d+\/(\d+)(?:\.html|$)/) || path.match(/\/b\/(\d+)(?:\.html|$)/);
        return m ? m[1] : null;
      }
      case 'wetv': {
        if (params.get('vid')) return params.get('vid');
        const m = path.match(/\/play\/[^/]+\/([a-zA-Z0-9]+)/) || path.match(/\/play\/([a-zA-Z0-9]+)/);
        return m ? m[1] : null;
      }
      case 'bilibili': {
        if (params.get('bvid')) return params.get('bvid');
        if (params.get('aid')) return `av${params.get('aid')}`;
        const m1 = path.match(/\/(BV[a-zA-Z0-9]{10}|av\d+)/i);
        if (m1) return m1[1];
        const m2 = path.match(/\/(?:video|play\/[^/]+)\/(\d{6,22})/i) || path.match(/\/play\/(\d{6,22})/i);
        return m2 ? m2[1] : null;
      }
      case 'xigua': {
        const m = path.match(/\/(?:iframe|video)\/(\d{15,22})/) || path.match(/^\/(\d{15,22})/);
        return m ? m[1] : (params.get('id') || null);
      }
      case 'xiaohongshu': {
        const m = path.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})/i);
        return m ? m[1] : null;
      }
      case 'jianying': {
        if (params.get('template_id')) return params.get('template_id');
        if (params.get('id')) return params.get('id');
        if (params.get('video_id')) return params.get('video_id');
        const m = path.match(/\/(?:template|share|detail)\/(\d{15,22})/);
        return m ? m[1] : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Tự động tổng hợp (Synthesize) tất cả các dạng URL (Canonical Link, UTM Link, oEmbed Link, Mobile H5 Link)
 * từ 1 đường dẫn bất kỳ mà người dùng đưa vào!
 */
function transformUrlByMethod(urlStr, platformCfg, method = 'auto') {
  if (!urlStr || !platformCfg) {
    return {
      selectedMethod: method,
      targetUrl: urlStr,
      embedUrl: null,
      mobileUrl: urlStr,
      utmUrl: urlStr,
      cleanUrl: urlStr,
      videoId: null,
      explanation: 'Giữ nguyên URL gốc.'
    };
  }

  const videoId = extractVideoId(platformCfg.id, urlStr);
  let cleanUrlStr = urlStr;
  let utmUrlStr = urlStr;

  try {
    const parsed = new URL(urlStr);

    // 1. Tạo Clean Canonical Link
    if (videoId && platformCfg.canonicalTemplate) {
      cleanUrlStr = platformCfg.canonicalTemplate(videoId);
    } else {
      const cUrl = new URL(parsed.origin + parsed.pathname);
      for (const key of platformCfg.preserveQueryKeys || []) {
        if (parsed.searchParams.has(key) && !key.startsWith('utm_')) {
          cUrl.searchParams.set(key, parsed.searchParams.get(key));
        }
      }
      cleanUrlStr = cUrl.toString();
    }

    // 2. Tạo Synthesized UTM Link (Bảo toàn token cũ + Tự động bơm tham số UTM Mobile Share)
    const uUrl = new URL(urlStr);
    for (const [k, v] of Object.entries(platformCfg.injectUtmParams || {})) {
      if (!uUrl.searchParams.has(k)) {
        uUrl.searchParams.set(k, v);
      }
    }
    utmUrlStr = uUrl.toString();
  } catch {}

  const embedUrl = videoId && platformCfg.embedTemplate ? platformCfg.embedTemplate(videoId) : null;
  const mobileUrl = videoId && platformCfg.mobileShareTemplate ? platformCfg.mobileShareTemplate(videoId) : utmUrlStr;

  if (method === 'link') {
    return {
      selectedMethod: 'link',
      targetUrl: cleanUrlStr,
      cleanUrl: cleanUrlStr,
      utmUrl: utmUrlStr,
      mobileUrl,
      embedUrl,
      videoId,
      explanation: `Direct Link: Tự động trích xuất URL chuẩn (${cleanUrlStr})`
    };
  }

  if (method === 'utm') {
    return {
      selectedMethod: 'utm',
      targetUrl: utmUrlStr,
      cleanUrl: cleanUrlStr,
      utmUrl: utmUrlStr,
      mobileUrl,
      embedUrl,
      videoId,
      explanation: `Auto-UTM Synthesis: Tự động gắn tham số UTM/Token bảo mật (${utmUrlStr})`
    };
  }

  if (method === 'obem' || method === 'oembed') {
    return {
      selectedMethod: 'obem',
      targetUrl: embedUrl || cleanUrlStr,
      cleanUrl: cleanUrlStr,
      utmUrl: utmUrlStr,
      mobileUrl,
      embedUrl: embedUrl || cleanUrlStr,
      videoId,
      explanation: `Auto-oEmbed Synthesis: Tự động chuyển đổi sang Player Nhúng (${embedUrl || cleanUrlStr})`
    };
  }

  // Mặc định 'auto': Tự động kết hợp cả 3 phương thức (Smart Multi-Path Discovery)
  return {
    selectedMethod: 'auto',
    targetUrl: utmUrlStr,
    cleanUrl: cleanUrlStr,
    utmUrl: utmUrlStr,
    mobileUrl,
    embedUrl,
    videoId,
    explanation: `Smart Auto-Discovery: Tự động tổng hợp Link chuẩn, bơm tham số UTM và tạo oEmbed Player từ 1 link duy nhất.`
  };
}

module.exports = {
  PLATFORMS,
  extractUrlFromText,
  detectPlatform,
  extractVideoId,
  transformUrlByMethod
};

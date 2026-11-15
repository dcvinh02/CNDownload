/**
 * Unified Scraper & Downloader Orchestrator
 * Tính năng cốt lõi:
 *  1. Smart Auto-Discovery: Tự động tìm kiếm & tổng hợp Link chuẩn / UTM / oEmbed từ 1 link bất kỳ
 *  2. Lưu trữ theo thư mục riêng cho từng nền tảng (hỗ trợ tùy chỉnh đường dẫn từng nền tảng)
 *  3. Chống nhấn tải trùng lặp (Deduplication) + Hủy tải / Dừng tải cho từng video riêng biệt
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const {
  PLATFORMS,
  extractUrlFromText,
  detectPlatform,
  extractVideoId,
  transformUrlByMethod
} = require('./platforms');

const {
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
} = require('./custom_parsers');

const {
  getYtDlpPath,
  getFfmpegPath,
  extractWithYtDlp,
  downloadWithYtDlp
} = require('./ytdlp_engine');

const {
  getPlatformDownloadDir,
  getStorageOverview
} = require('../storage_config');

const {
  verifyMediaOutput,
  ensureCompatibleMp4,
  startConversionJob,
  cancelConversionJob
} = require('../converter_engine');

/**
 * Hàm phân tích (Scrape & Parse) tổng hợp cho cả 12 nền tảng
 */
/**
 * Video "giữ chỗ" mà trình phát nhúng tự phát khi bị chặn/lỗi (vd. Bilibili phát s1.hdslb.com/.../error.mp4 khi
 * API trả 412) — không phải video thật, không được coi là luồng tải được.
 */
function isPlaceholderMedia(src = '') {
  const u = String(src);
  if (/^blob:/i.test(u) || /\/(?:error|loading|placeholder|default)[-_]?\w{0,8}\.mp4(?:[?#]|$)/i.test(u) || /hdslb\.com\/bfs\/static\/player\/media\//i.test(u)) return true;
  let parsed;
  try {
    parsed = new URL(u);
  } catch (_) {
    return true;
  }
  // Link thống kê/quảng cáo (vd. WeTV h.trace.qq.com/bosskv?...) có thể chứa ".mp4" trong tham số nhưng không phải video
  if (/(^|\.)(trace|beacon|log|logs|stat|stats|report|analytics|mcs)\./i.test(parsed.hostname) || /bosskv|beacon|\/report\b|\/log\b/i.test(parsed.pathname)) return true;
  const l = u.toLowerCase();
  const mediaPath = /\.(mp4|m3u8|flv|m4s|ts|mov|webm)$/i.test(parsed.pathname) || /\.(mp4|m3u8|flv)\b/i.test(parsed.pathname);
  return !(mediaPath || l.includes('mime_type=video') || l.includes('aweme/v1/play') || (l.includes('xhscdn.com') && l.includes('stream')));
}

async function analyzeVideo(params = {}) {
  const {
    rawInput = '',
    platformId = 'auto',
    method = 'auto',
    cookie = '',
    cookiesFromBrowser = 'none'
  } = params;

  const extractedUrl = extractUrlFromText(rawInput);
  if (!extractedUrl || !extractedUrl.startsWith('http')) {
    throw new Error('Vui lòng nhập đường dẫn URL hợp lệ, văn bản chia sẻ có chứa link (http/https), hoặc mã nhúng <iframe>.');
  }

  // Bước 1: Nhận diện nền tảng
  let platformCfg =
    platformId !== 'auto' && PLATFORMS[platformId]
      ? PLATFORMS[platformId]
      : detectPlatform(rawInput) || detectPlatform(extractedUrl);

  // Kiểm tra nhanh xem URL ban đầu đã chứa sẵn Video ID chưa (giúp bỏ qua bước chờ redirect không cần thiết)
  const initialVideoId = platformCfg ? extractVideoId(platformCfg.id, extractedUrl) : null;
  const skipSlowRedirect =
    initialVideoId &&
    platformCfg &&
    ['douyin', 'kuaishou', 'bilibili', 'pipixia'].includes(platformCfg.id);

  let redirectRes = {
    finalUrl: extractedUrl,
    redirectChain: [extractedUrl],
    html: '',
    cookies: cookie
  };

  if (!skipSlowRedirect) {
    const useMobileRedirect = platformCfg
      ? ['douyin', 'kuaishou', 'pipixia', 'xiaohongshu', 'jianying'].includes(platformCfg.id)
      : false;
    redirectRes = await resolveRedirect(extractedUrl, {
      mobile: useMobileRedirect,
      cookie
    });
  }

  const resolvedUrl = redirectRes.finalUrl || extractedUrl;
  if (!platformCfg) {
    platformCfg = detectPlatform(resolvedUrl);
  }
  if (!platformCfg) {
    throw new Error(`Không nhận diện được nền tảng từ URL: ${resolvedUrl}. Vui lòng chọn nền tảng ở danh sách bên trái.`);
  }

  // Bước 2: Tự động tổng hợp cả 3 dạng Link (Clean Link / Auto-UTM / Auto-oEmbed)
  const methodInfo = transformUrlByMethod(resolvedUrl, platformCfg, method);
  const videoId =
    initialVideoId ||
    methodInfo.videoId ||
    extractVideoId(platformCfg.id, resolvedUrl) ||
    extractVideoId(platformCfg.id, extractedUrl);

  const urlInfo = {
    inputUrl: extractedUrl,
    resolvedUrl,
    targetUrl: methodInfo.targetUrl,
    cleanUrl: methodInfo.cleanUrl,
    utmUrl: methodInfo.utmUrl,
    embedUrl: methodInfo.embedUrl,
    mobileUrl: methodInfo.mobileUrl,
    videoId,
    selectedMethod: methodInfo.selectedMethod,
    methodExplanation: methodInfo.explanation,
    redirectChain: redirectRes.redirectChain,
    html: redirectRes.html,
    cookies: cookie || redirectRes.cookies
  };

  const traceLogs = [
    `[1. Input] Nhận link: ${extractedUrl}`,
    `[2. Auto-Discovery] Nền tảng: ${platformCfg.name} • ID: ${videoId || 'Đang dò tự động'}`,
    `[3. Synthesized Links] Clean: ${methodInfo.cleanUrl || resolvedUrl} | UTM: ${methodInfo.utmUrl || resolvedUrl} | oEmbed: ${methodInfo.embedUrl || 'Auto'}`
  ];

  let result = null;
  const errors = [];

  // Bước 3: Chạy Native Auto-Extractor cho các nền tảng hỗ trợ sâu
  try {
    if (platformCfg.id === 'bilibili' && !resolvedUrl.includes('bilibili.tv')) {
      result = await parseBilibili(urlInfo, { cookie: urlInfo.cookies });
      traceLogs.push(`[4. Engine] Thành công qua ${result.engine}`);
    } else if (platformCfg.id === 'pipixia') {
      result = await parsePipixia(urlInfo, { cookie: urlInfo.cookies });
      traceLogs.push(`[4. Engine] Thành công qua ${result.engine}`);
    } else if (platformCfg.id === 'douyin') {
      result = await parseDouyin(urlInfo, { cookie: urlInfo.cookies });
      traceLogs.push(`[4. Engine] Thành công qua ${result.engine}`);
    } else if (platformCfg.id === 'kuaishou') {
      result = await parseKuaishou(urlInfo, { cookie: urlInfo.cookies });
      traceLogs.push(`[4. Engine] Thành công qua ${result.engine}`);
    } else if (platformCfg.id === 'xiaohongshu') {
      result = await parseXiaohongshu(urlInfo, { cookie: urlInfo.cookies });
      traceLogs.push(`[4. Engine] Thành công qua ${result.engine}`);
    } else if (platformCfg.id === 'jianying') {
      result = await parseJianying(urlInfo, { cookie: urlInfo.cookies });
      traceLogs.push(`[4. Engine] Thành công qua ${result.engine}`);
    }
  } catch (customErr) {
    errors.push(`Native Parser: ${customErr.message}`);
    traceLogs.push(`[4. Native Parser] Chuyển tiếp (${customErr.message})`);
  }

  // Bước 4: Chạy yt-dlp Core Engine nếu chưa có directVideoUrl
  if (!result || !result.directVideoUrl) {
    const useMobile = ['douyin', 'kuaishou', 'pipixia', 'xiaohongshu', 'jianying'].includes(platformCfg.id);
    const urlForYtDlp = methodInfo.cleanUrl || resolvedUrl;

    try {
      const ytdlpRes = await extractWithYtDlp(urlForYtDlp, {
        cookie: urlInfo.cookies,
        domain: `.${platformCfg.domains[0]}`,
        cookiesFromBrowser,
        referer: resolvedUrl,
        userAgent: useMobile ? MOBILE_UA : DESKTOP_UA
      });

      result = {
        platform: platformCfg.id,
        platformName: platformCfg.name,
        ...ytdlpRes,
        videoId: ytdlpRes.videoId || videoId || 'unknown',
        embedUrl: methodInfo.embedUrl || resolvedUrl
      };
      traceLogs.push(`[5. Engine] Trích xuất thành công qua ${result.engine}`);
    } catch (ytErr) {
      errors.push(`yt-dlp: ${ytErr.message}`);
      traceLogs.push(`[5. yt-dlp] Đang dò luồng qua Universal WebKit Sniffer...`);
    }
  }

  // Bước 5: Universal WebKit Sniffer (Dò tự động cả Embed Player lẫn Mobile H5 URL)
  if (!result || !result.directVideoUrl) {
    const candidateUrls = [
      methodInfo.embedUrl,
      methodInfo.mobileUrl,
      methodInfo.utmUrl,
      resolvedUrl
    ].filter(Boolean);

    const uniqueCandidates = [...new Set(candidateUrls)].slice(0, 2);
    for (const sniffUrl of uniqueCandidates) {
      try {
        const useMobile = sniffUrl.includes('m.') || sniffUrl.includes('h5.') || sniffUrl.includes('c.kuaishou');
        const sniffRes = await runWebKitSniffer(sniffUrl, useMobile ? MOBILE_UA : DESKTOP_UA, 8000, {
          cookie: urlInfo.cookies
        });
        const videoEv = (sniffRes.events || []).find(
          (e) => (e.type === 'video_dom' || e.type === 'resource_stream') && e.data?.src && !isPlaceholderMedia(e.data.src)
        );
        if (videoEv && videoEv.data.src) {
          const htmlMeta = extractHtmlPageMetadata(
            urlInfo.html,
            sniffRes.finalInfo?.title || videoEv.data.title || `${platformCfg.name} ${videoId || ''}`
          );
          result = {
            platform: platformCfg.id,
            platformName: platformCfg.name,
            videoId: videoId || extractVideoId(platformCfg.id, sniffRes.finalInfo?.href || '') || 'unknown',
            title: htmlMeta.title || sniffRes.finalInfo?.title || `${platformCfg.name} Video`,
            description: htmlMeta.description || '',
            author: platformCfg.company,
            cover: htmlMeta.cover || '',
            duration: 0,
            stats: {},
            embedUrl: methodInfo.embedUrl || sniffUrl,
            directVideoUrl: videoEv.data.src,
            formats: [
              {
                formatId: 'webkit-auto-stream',
                quality: /\.m3u8/i.test(videoEv.data.src) ? 'HD HLS Stream (Auto-Discovered)' : 'HD Direct Stream (Auto-Discovered)',
                ext: /\.m3u8/i.test(videoEv.data.src) ? 'm3u8' : 'mp4',
                url: videoEv.data.src,
                hasAudio: true,
                noWatermark: true,
                headers: {
                  'User-Agent': useMobile ? MOBILE_UA : DESKTOP_UA,
                  Referer: sniffUrl
                }
              }
            ],
            downloadHeaders: {
              'User-Agent': useMobile ? MOBILE_UA : DESKTOP_UA,
              Referer: sniffUrl
            },
            engine: 'Universal WebKit Auto-Stream Sniffer'
          };
          traceLogs.push(`[6. Auto-Sniffer] Bắt thành công luồng video từ ${sniffUrl}`);
          break;
        }
      } catch {}
    }
  }

  // Bước 6: Fallback cuối cùng lấy Metadata & oEmbed
  if (!result) {
    let htmlMeta = extractHtmlPageMetadata(urlInfo.html, `${platformCfg.name} Video ${videoId || ''}`);
    if (platformCfg.id === 'mangotv') {
      const mgtvMeta = await parseMangoTvMetadata(urlInfo);
      if (mgtvMeta) htmlMeta = { ...htmlMeta, ...mgtvMeta };
    }

    result = {
      platform: platformCfg.id,
      platformName: platformCfg.name,
      videoId: videoId || 'unknown',
      title: htmlMeta.title,
      description: htmlMeta.description,
      author: htmlMeta.author || platformCfg.company,
      cover: htmlMeta.cover || '',
      duration: htmlMeta.duration || 0,
      stats: {},
      embedUrl: methodInfo.embedUrl || resolvedUrl,
      directVideoUrl: null,
      formats: [],
      requiresAuthOrGeo: true,
      authHint: errors.join(' | '),
      engine: 'SSR Metadata & oEmbed Inspector'
    };
  }

  const platformSaveDir = getPlatformDownloadDir(platformCfg.id);

  return {
    success: true,
    scrapedAt: new Date().toISOString(),
    platform: platformCfg.id,
    platformName: platformCfg.name,
    category: platformCfg.category,
    saveDir: platformSaveDir,
    selectedMethod: methodInfo.selectedMethod,
    recommendedMethod: platformCfg.recommendedMethod,
    methodExplanation: methodInfo.explanation,
    inputUrl: extractedUrl,
    resolvedUrl: result.embedUrl && !videoId ? result.embedUrl : resolvedUrl,
    targetUrl: methodInfo.targetUrl,
    synthesizedLinks: {
      cleanUrl: methodInfo.cleanUrl || resolvedUrl,
      utmUrl: methodInfo.utmUrl || resolvedUrl,
      embedUrl: result.embedUrl || methodInfo.embedUrl || resolvedUrl,
      mobileUrl: methodInfo.mobileUrl || resolvedUrl
    },
    embedUrl: result.embedUrl || methodInfo.embedUrl,
    redirectChain: redirectRes.redirectChain,
    traceLogs,
    data: result
  };
}

/**
 * Quản lý hàng đợi, chống nhấn trùng & Hỗ trợ Dừng/Hủy tải cho từng video riêng biệt
 */
const activeDownloads = new Map();
const downloadControllers = new Map(); // Lưu { abortController, cancelHandle, fileStream } theo jobId

function sanitizeFilename(name) {
  return (name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 75);
}

/**
 * Loại bỏ đệ quy mọi trường nhạy cảm (cookie, token, authorization...) trước khi lưu file .metadata.json
 */
function sanitizeMetadataForDisk(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeMetadataForDisk);
  const clean = {};
  const forbiddenKeys = new Set([
    'cookie',
    'cookies',
    'set-cookie',
    'authorization',
    'token',
    'access_token',
    'sessionid',
    'sessdata',
    'bili_jct'
  ]);
  for (const [k, v] of Object.entries(obj)) {
    if (forbiddenKeys.has(String(k).toLowerCase())) continue;
    clean[k] = sanitizeMetadataForDisk(v);
  }
  return clean;
}

async function startRealDownload(jobParams) {
  const {
    platform = 'douyin',
    title = 'video',
    videoId = '',
    directVideoUrl = '',
    targetUrl = '',
    formatId = '',
    hasAudio = true,
    requiresYtDlpMerge = false,
    outputFormat = 'mp4',
    headers = {},
    cookie = '',
    cookiesFromBrowser = 'none',
    metadata = null
  } = jobParams;

  // Chống nhấn trùng lặp (Deduplication): Kiểm tra nếu video + format này đang được tải
  const dedupKey = `${platform}_${videoId || title}_${formatId || 'default'}_${outputFormat}`;
  for (const existingJob of activeDownloads.values()) {
    if (existingJob.dedupKey === dedupKey && existingJob.status === 'downloading') {
      return {
        alreadyDownloading: true,
        job: existingJob
      };
    }
  }

  // Lấy đúng thư mục lưu trữ riêng của nền tảng này
  const platformDir = getPlatformDownloadDir(platform);
  if (!fs.existsSync(platformDir)) {
    fs.mkdirSync(platformDir, { recursive: true });
  }

  const jobId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const safeTitle = sanitizeFilename(title);
  const baseName = `${platform}_${videoId ? videoId + '_' : ''}${safeTitle}_${Date.now().toString().slice(-5)}`;
  const outputPath = path.join(platformDir, `${baseName}.mp4`);
  const metaPath = path.join(platformDir, `${baseName}.metadata.json`);

  const jobState = {
    jobId,
    dedupKey,
    platform,
    platformName: PLATFORMS[platform]?.name || platform,
    title,
    videoId,
    formatId,
    outputFormat: (outputFormat || 'mp4').toLowerCase(),
    status: 'downloading', // 'downloading' | 'completed' | 'cancelled' | 'failed'
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    speedText: 'Đang kết nối...',
    saveDir: platformDir,
    outputPath,
    metaPath,
    fileName: path.basename(outputPath),
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null
  };

  const abortController = new AbortController();
  const cancelHandle = { killProcess: null };
  const ctrlRecord = { abortController, cancelHandle, fileStream: null };

  activeDownloads.set(jobId, jobState);
  downloadControllers.set(jobId, ctrlRecord);

  const safeMetadata = metadata ? sanitizeMetadataForDisk(metadata) : null;
  if (safeMetadata) {
    try {
      fs.writeFileSync(metaPath, JSON.stringify(safeMetadata, null, 2), 'utf8');
    } catch {}
  }

  (async () => {
    let currentDirectUrl = directVideoUrl;
    let currentHeaders = { ...headers };
    delete currentHeaders.Cookie;
    delete currentHeaders.cookie;
    let needYtDlpMerge = Boolean(requiresYtDlpMerge || hasAudio === false);

    try {
      if (!currentDirectUrl && targetUrl) {
        jobState.speedText = 'Đang lấy luồng gốc...';
        const fresh = await analyzeVideo({
          rawInput: targetUrl,
          platformId: platform,
          cookie,
          cookiesFromBrowser
        });
        if (fresh?.data?.directVideoUrl) {
          currentDirectUrl = fresh.data.directVideoUrl;
          currentHeaders = fresh.data.downloadHeaders || currentHeaders;
          if (fresh.data.requiresYtDlpMerge) needYtDlpMerge = true;
        }
      }

      if (jobState.status === 'cancelled') return;

      // Luồng DASH .m4s hoặc video-only (như trên Bilibili.tv / Bilibili DASH) PHẢI tải qua yt-dlp + FFmpeg để ghép Audio và chuẩn hóa H.264
      const isDashOrSplitStream =
        needYtDlpMerge ||
        (currentDirectUrl &&
          (currentDirectUrl.includes('.m4s') ||
            currentDirectUrl.includes('upos-bstar') ||
            currentDirectUrl.includes('iupxcodeboss')));

      const isDirectHttpMp4 =
        currentDirectUrl &&
        currentDirectUrl.startsWith('http') &&
        !currentDirectUrl.includes('.m3u8') &&
        !currentDirectUrl.includes('.mpd') &&
        !isDashOrSplitStream;

      const platformDomains = PLATFORMS[platform]?.domains || [];
      const isTargetSamePlatformDomain = (() => {
        if (!currentDirectUrl || !cookie) return false;
        try {
          const h = new URL(currentDirectUrl).hostname.toLowerCase();
          return platformDomains.some((d) => h === d || h.endsWith(`.${d}`));
        } catch (_) {
          return false;
        }
      })();

      if (isDirectHttpMp4) {
        const reqHeaders = {
          'User-Agent': currentHeaders['User-Agent'] || DESKTOP_UA,
          Accept: '*/*',
          ...(currentHeaders.Referer ? { Referer: currentHeaders.Referer } : {}),
          ...(cookie && isTargetSamePlatformDomain ? { Cookie: cookie } : {})
        };

        const res = await fetch(currentDirectUrl, {
          headers: reqHeaders,
          redirect: 'follow',
          signal: abortController.signal
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} khi tải stream trực tiếp`);
        }

        const total = parseInt(res.headers.get('content-length') || '0', 10);
        jobState.totalBytes = total;

        let downloaded = 0;
        const startTime = Date.now();
        const fileStream = fs.createWriteStream(outputPath);
        ctrlRecord.fileStream = fileStream;

        const nodeReadable = Readable.fromWeb(res.body);
        nodeReadable.on('data', (chunk) => {
          if (jobState.status === 'cancelled') {
            nodeReadable.destroy();
            return;
          }
          downloaded += chunk.length;
          jobState.downloadedBytes = downloaded;
          const elapsedSec = Math.max((Date.now() - startTime) / 1000, 0.2);
          const speedMB = (downloaded / 1024 / 1024 / elapsedSec).toFixed(2);
          jobState.speedText = `${speedMB} MB/s`;
          if (total > 0) {
            jobState.progress = Math.min(98, Math.round((downloaded / total) * 100));
          } else {
            jobState.progress = Math.min(95, jobState.progress + 2);
          }
        });

        await pipeline(nodeReadable, fileStream, { signal: abortController.signal });
      } else {
        // Luồng M3U8 / DASH (.m4s) / Bilibili -> dùng yt-dlp + FFmpeg để ghép Video H.264 + Audio AAC
        // Luồng HLS bắt trực tiếp từ trình phát (webkit-auto-stream): tải thẳng luồng đó. Tải lại theo link trang
        // phụ thuộc trình trích xuất yt-dlp của nền tảng (vd. WeTV đang lỗi "Unable to extract next.js data").
        const isSniffedHls = String(formatId || '').startsWith('webkit-') && /\.m3u8/i.test(currentDirectUrl || '');
        const urlToDownload = isSniffedHls ? currentDirectUrl : targetUrl || currentDirectUrl;
        if (!urlToDownload) {
          throw new Error('Không tìm thấy luồng tải hợp lệ.');
        }

        const primaryDomain = platformDomains[0] ? `.${platformDomains[0]}` : undefined;
        await downloadWithYtDlp(
          urlToDownload,
          outputPath,
          {
            formatId,
            cookie,
            domain: primaryDomain,
            cookiesFromBrowser,
            referer: currentHeaders.Referer || urlToDownload
          },
          (prog) => {
            if (jobState.status === 'cancelled') return;
            jobState.progress = Math.min(98, Math.round(prog.percent || 0));
            if (prog.speedStr) jobState.speedText = prog.speedStr;
          },
          cancelHandle
        );
      }

      if (jobState.status === 'cancelled') return;

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 256) {
        throw new Error('File tải về rỗng hoặc chưa hoàn tất (< 256B).');
      }

      // Đánh dấu đã tải xong file gốc (.mp4) để nếu bước chuyển đổi sau đó bị hủy/lỗi thì vẫn giữ lại file gốc
      jobState.downloadPhaseDone = true;
      jobState.originalDownloadedPath = outputPath;

      const desiredFmt = (outputFormat || 'mp4').toLowerCase();
      if (desiredFmt === 'mp4') {
        const normRes = await ensureCompatibleMp4(
          outputPath,
          (msg, pct) => {
            jobState.speedText = msg;
            if (typeof pct === 'number') {
              jobState.progress = Math.min(99, pct);
            }
          },
          cancelHandle
        );

        if (normRes.cancelled || jobState.status === 'cancelled') {
          throw new Error('USER_CANCELLED');
        }
        if (!normRes.ok) {
          throw new Error(normRes.error || 'Chuẩn hóa và xác minh file MP4 thất bại.');
        }

        jobState.ext = 'mp4';
        jobState.outputDurationSec = Number(normRes.duration) || 0;
        jobState.vcodec = normRes.vcodec;
        jobState.acodec = normRes.acodec;
        jobState.hasAudio = normRes.hasAudio;
        jobState.audioStatusText = normRes.audioStatusText;
      } else {
        jobState.speedText = `Đang chuyển đổi sang .${desiredFmt.toUpperCase()}...`;
        const targetOutPath = path.join(platformDir, `${baseName}.${desiredFmt}`);
        const convJob = await startConversionJob({
          inputPath: outputPath,
          targetFormat: desiredFmt,
          quality: 'high',
          outputDir: platformDir,
          customOutputPath: targetOutPath
        });

        cancelHandle.killProcess = () => {
          cancelConversionJob(convJob.jobId);
        };

        while (convJob.status === 'converting') {
          if (jobState.status === 'cancelled') {
            cancelConversionJob(convJob.jobId);
            break;
          }
          jobState.progress = Math.min(99, convJob.progress || 50);
          jobState.speedText = `Đang chuyển sang .${desiredFmt.toUpperCase()} (${convJob.progress || 0}%)...`;
          await new Promise((r) => setTimeout(r, 300));
        }

        if (jobState.status === 'cancelled' || convJob.status === 'cancelled') {
          downloadControllers.delete(jobId);
          jobState.status = 'cancelled';
          jobState.speedText = 'Đã hủy chuyển đổi (Giữ lại file MP4 gốc)';
          jobState.error = `Đã hủy chuyển đổi sang .${desiredFmt.toUpperCase()}. File tải gốc vẫn được giữ lại: ${path.basename(outputPath)}`;
          return;
        }

        if (convJob.status !== 'completed') {
          downloadControllers.delete(jobId);
          jobState.status = 'failed';
          jobState.speedText = 'Lỗi chuyển đổi (Giữ lại file MP4 gốc)';
          jobState.error = `${convJob.error || 'Chuyển đổi thất bại'}. File tải gốc vẫn được giữ lại: ${path.basename(outputPath)}`;
          return;
        }

        // Xác minh nghiêm ngặt file đích trước khi xóa file nguồn trung gian
        const verifyTarget = await verifyMediaOutput(convJob.outputPath, desiredFmt);
        if (!verifyTarget.ok) {
          downloadControllers.delete(jobId);
          jobState.status = 'failed';
          jobState.error = `${verifyTarget.error}. File tải gốc vẫn được giữ lại: ${path.basename(outputPath)}`;
          return;
        }

        try {
          if (fs.existsSync(outputPath) && path.resolve(outputPath) !== path.resolve(convJob.outputPath)) {
            fs.unlinkSync(outputPath);
          }
        } catch {}

        jobState.outputPath = convJob.outputPath;
        jobState.fileName = path.basename(convJob.outputPath);
        jobState.ext = desiredFmt;
        jobState.outputDurationSec = Number(verifyTarget.duration) || 0;
        jobState.vcodec = verifyTarget.vcodec;
        jobState.acodec = verifyTarget.acodec;
        jobState.hasAudio = verifyTarget.hasAudio;
        jobState.audioStatusText = verifyTarget.audioStatusText;
      }

      const finalStat = fs.statSync(jobState.outputPath);
      jobState.totalBytes = finalStat.size;
      jobState.downloadedBytes = finalStat.size;
      jobState.progress = 100;
      jobState.status = 'completed';
      jobState.speedText = `Hoàn tất • ${jobState.audioStatusText || 'Đã xác minh media'}`;
      // Nền tảng chỉ cho tải đoạn xem thử (vd. MangoTV/iQIYI nội dung VIP phát 5 phút đầu): báo rõ, không im lặng
      const expectedDur = Number(metadata?.data?.duration) || 0;
      const gotDur = Number(jobState.outputDurationSec) || 0;
      if (expectedDur >= 60 && gotDur > 0 && gotDur < expectedDur * 0.9) {
        const fmt = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`;
        jobState.partialWarning = `Chỉ tải được ${fmt(gotDur)} / ${fmt(expectedDur)} — nền tảng chỉ cho phát đoạn xem thử (thường là nội dung VIP). Cần Cookie tài khoản có quyền xem đầy đủ.`;
        jobState.speedText = `Hoàn tất (MỘT PHẦN) • ${jobState.partialWarning}`;
      }
      jobState.completedAt = new Date().toISOString();

      // Cập nhật file metadata.json phản ánh chính xác kết quả file cuối cùng (đã loại bỏ mọi cookie/token nhạy cảm)
      try {
        const finalMeta = {
          ...(safeMetadata || {}),
          finalOutput: {
            fileName: jobState.fileName,
            outputPath: jobState.outputPath,
            format: jobState.ext || 'mp4',
            fileSize: finalStat.size,
            vcodec: jobState.vcodec || '',
            acodec: jobState.acodec || '',
            hasAudio: jobState.hasAudio,
            audioStatusText: jobState.audioStatusText || '',
            completedAt: jobState.completedAt
          }
        };
        fs.writeFileSync(metaPath, JSON.stringify(finalMeta, null, 2), 'utf8');
      } catch {}

      downloadControllers.delete(jobId);
    } catch (err) {
      downloadControllers.delete(jobId);
      if (jobState.status === 'cancelled' || err.name === 'AbortError' || err.message === 'USER_CANCELLED') {
        jobState.status = 'cancelled';
        jobState.speedText = 'Đã hủy tải';
        jobState.error = null;
        if (!jobState.downloadPhaseDone) {
          cleanupPartialFiles(outputPath, metaPath);
        }
        return;
      }
      jobState.status = 'failed';
      jobState.error = err.message;
      if (!jobState.downloadPhaseDone) {
        cleanupPartialFiles(outputPath, null);
      }
    }
  })();

  return {
    alreadyDownloading: false,
    job: jobState
  };
}

function cleanupPartialFiles(outputPath, metaPath) {
  for (const p of [outputPath, outputPath ? `${outputPath}.part` : null, metaPath]) {
    if (p && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
}

/**
 * Dừng / Hủy tải ngay lập tức 1 video đang tải và xóa file tạm
 */
function cancelDownloadJob(jobId) {
  const job = activeDownloads.get(jobId);
  if (!job) {
    return { success: false, message: 'Không tìm thấy tác vụ tải.' };
  }

  job.status = 'cancelled';
  job.speedText = job.downloadPhaseDone ? 'Đã hủy chuyển đổi (Giữ file gốc)' : 'Đã hủy tải';
  job.error = null;

  const ctrl = downloadControllers.get(jobId);
  if (ctrl) {
    try { ctrl.abortController.abort(); } catch {}
    if (ctrl.cancelHandle && typeof ctrl.cancelHandle.killProcess === 'function') {
      try { ctrl.cancelHandle.killProcess(); } catch {}
    }
    if (ctrl.fileStream) {
      try { ctrl.fileStream.destroy(); } catch {}
    }
    downloadControllers.delete(jobId);
  }

  if (!job.downloadPhaseDone) {
    cleanupPartialFiles(job.outputPath, job.metaPath);
  }
  return { success: true, job };
}

const MEDIA_EXT_REGEX = /\.(mp4|mov|mkv|webm|avi|flv|mp3|wav|gif)$/i;

/**
 * Xóa 1 mục khỏi danh sách hiển thị (và tùy chọn xóa luôn file trên ổ cứng)
 */
function removeDownloadItem({ jobId, filePath, deleteFromDisk = false }) {
  if (jobId && activeDownloads.has(jobId)) {
    const job = activeDownloads.get(jobId);
    if (job.status === 'downloading') {
      cancelDownloadJob(jobId);
    }
    if (deleteFromDisk) {
      cleanupPartialFiles(job.outputPath, job.metaPath);
    }
    activeDownloads.delete(jobId);
  } else if (filePath && deleteFromDisk && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      const metaCandidate = filePath.replace(MEDIA_EXT_REGEX, '.metadata.json');
      if (fs.existsSync(metaCandidate)) fs.unlinkSync(metaCandidate);
    } catch {}
  }
  return { success: true };
}

function isTempMediaFile(f) {
  return (
    !MEDIA_EXT_REGEX.test(f) ||
    f.includes('.part_') ||
    f.includes('_fixing_') ||
    f.endsWith('_fixing.mp4') ||
    f.startsWith('preview_voice_') ||
    f.startsWith('dub_master_')
  );
}

function readSidecarMetadata(fullPath) {
  try {
    const dubMetaCandidates = [
      `${fullPath}.dubbing.metadata.json`,
      fullPath.replace(/\.mp4$/i, '.dubbing.metadata.json')
    ];
    const dubMeta = dubMetaCandidates.find((p) => fs.existsSync(p));
    if (dubMeta) {
      const parsed = JSON.parse(fs.readFileSync(dubMeta, 'utf8'));
      const langObj = parsed.targetLang;
      const langName =
        typeof langObj === 'object' && langObj
          ? langObj.name || langObj.code || ''
          : parsed.targetLangName || parsed.targetLang || '';
      const voiceObj = parsed.voice;
      const vName =
        typeof voiceObj === 'object' && voiceObj ? voiceObj.name || '' : parsed.voiceName || '';
      return {
        isDubbed: true,
        targetLang: typeof langObj === 'object' && langObj ? langObj.code : parsed.targetLang,
        targetLangName: langName,
        voiceName: vName,
        audioStatusText: `Lồng tiếng ${langName}${vName ? ` (${vName})` : ''}`.trim()
      };
    }
    const baseNoExt = fullPath.replace(MEDIA_EXT_REGEX, '');
    const metaFile = `${baseNoExt}.metadata.json`;
    if (fs.existsSync(metaFile)) {
      const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (parsed && parsed.finalOutput) {
        return {
          isDubbed: false,
          vcodec: parsed.finalOutput.vcodec || '',
          acodec: parsed.finalOutput.acodec || '',
          hasAudio: parsed.finalOutput.hasAudio,
          audioStatusText: parsed.finalOutput.audioStatusText || ''
        };
      }
    }
  } catch {}
  return { isDubbed: false };
}

/**
 * Quét danh sách các tác vụ tải & toàn bộ file Media trong các thư mục riêng của 12 nền tảng (gồm cả thư mục con Dubbed/)
 */
function getDownloadsList() {
  const jobs = Array.from(activeDownloads.values()).reverse();
  const overview = getStorageOverview();
  const filesOnDisk = [];
  const seenPaths = new Set();

  // Quét từng thư mục nền tảng
  for (const [pid, pInfo] of Object.entries(overview.platforms)) {
    const dir = pInfo.effectiveDir;
    if (dir && fs.existsSync(dir)) {
      try {
        const entries = fs.readdirSync(dir).filter((f) => !isTempMediaFile(f));
        for (const f of entries) {
          const full = path.join(dir, f);
          if (seenPaths.has(full)) continue;
          const stat = fs.statSync(full);
          if (!stat.isFile()) continue;
          seenPaths.add(full);
          const ext = path.extname(f).replace('.', '').toLowerCase() || 'mp4';
          const sidecar = readSidecarMetadata(full);
          filesOnDisk.push({
            platformId: pid,
            platformName: pInfo.platformName,
            folderName: pInfo.folderName,
            fileName: f,
            filePath: full,
            ext,
            saveDir: dir,
            fileSize: stat.size,
            createdAt: stat.mtime.toISOString(),
            ...sidecar
          });
        }

        // Quét thêm thư mục con Dubbed/ của nền tảng đó
        const dubbedDir = path.join(dir, 'Dubbed');
        if (fs.existsSync(dubbedDir) && fs.statSync(dubbedDir).isDirectory()) {
          const dubEntries = fs.readdirSync(dubbedDir).filter((f) => !isTempMediaFile(f));
          for (const f of dubEntries) {
            const full = path.join(dubbedDir, f);
            if (seenPaths.has(full)) continue;
            const stat = fs.statSync(full);
            if (!stat.isFile()) continue;
            seenPaths.add(full);
            const ext = path.extname(f).replace('.', '').toLowerCase() || 'mp4';
            const sidecar = readSidecarMetadata(full);
            filesOnDisk.push({
              platformId: pid,
              platformName: pInfo.platformName,
              folderName: `${pInfo.folderName}/Dubbed`,
              fileName: f,
              filePath: full,
              ext,
              saveDir: dubbedDir,
              fileSize: stat.size,
              createdAt: stat.mtime.toISOString(),
              ...sidecar,
              isDubbed: true
            });
          }
        }
      } catch {}
    }
  }

  // Quét thêm thư mục gốc (nếu có video cũ lưu từ trước)
  if (fs.existsSync(overview.rootDir)) {
    try {
      const rootEntries = fs.readdirSync(overview.rootDir).filter((f) => !isTempMediaFile(f));
      for (const f of rootEntries) {
        const full = path.join(overview.rootDir, f);
        if (seenPaths.has(full)) continue;
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        seenPaths.add(full);
        const prefix = f.split('_')[0]?.toLowerCase();
        const cfg = PLATFORMS[prefix];
        const ext = path.extname(f).replace('.', '').toLowerCase() || 'mp4';
        const sidecar = readSidecarMetadata(full);
        filesOnDisk.push({
          platformId: cfg ? cfg.id : 'root',
          platformName: cfg ? cfg.name : 'Thư mục gốc',
          folderName: '',
          fileName: f,
          filePath: full,
          ext,
          saveDir: overview.rootDir,
          fileSize: stat.size,
          createdAt: stat.mtime.toISOString(),
          ...sidecar
        });
      }
    } catch {}
  }

  filesOnDisk.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return {
    activeJobs: jobs,
    savedFiles: filesOnDisk,
    storage: overview
  };
}

module.exports = {
  PLATFORMS,
  analyzeVideo,
  startRealDownload,
  cancelDownloadJob,
  removeDownloadItem,
  getDownloadsList,
  readSidecarMetadata,
  sanitizeMetadataForDisk,
  activeDownloads,
  getYtDlpPath,
  getFfmpegPath
};

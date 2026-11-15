const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const {
  PLATFORMS,
  analyzeVideo,
  startRealDownload,
  cancelDownloadJob,
  removeDownloadItem,
  getDownloadsList
} = require('./extractors');
const { DESKTOP_UA } = require('./extractors/custom_parsers');
const {
  DEFAULT_ROOT_DIR,
  getStorageOverview,
  saveSettings,
  getPlatformDownloadDir,
  pickNativeFolderDialog,
  pickNativeFileDialog,
  openInSystemExplorer
} = require('./storage_config');
const {
  SUPPORTED_FORMATS,
  startConversionJob,
  cancelConversionJob,
  getConversionsList
} = require('./converter_engine');
const {
  CAP_STATUS,
  getSystemCapabilities,
  getCapabilitiesSnapshot,
  triggerBackgroundCapabilitiesCheck
} = require('./capabilities');
const {
  getInstallableToolsCatalog,
  startToolInstallJob,
  getToolInstallJob
} = require('./tool_installer');
const {
  ACCOUNT_SCAN_SUPPORT,
  previewAccountTarget,
  startAccountScanJob,
  getAccountScanStatus,
  cancelAccountScanJob,
  enqueueBatchDownloads,
  clearPendingBatchQueue,
  getBatchQueueInfo,
  startMultiAccountScan,
  getMultiAccountScanStatus,
  cancelMultiAccountScan
} = require('./account_scanner');
const {
  VOICE_CATALOG,
  LOCAL_MODELS_CATALOG,
  TRANSLATION_PROVIDERS_CATALOG,
  TRANSLATION_STYLES,
  LANGUAGE_INFO,
  DUBBING_PIPELINE_STEPS,
  getSupportedVoices,
  getLocalModelsCatalogStatus,
  retranslateSegments,
  extractAndPrepareSegments,
  generateVoicePreviewAudio,
  startDubbingJob,
  getDubbingJob,
  getAllDubbingJobs,
  cancelDubbingJob,
  startExtractTask,
  resumeExtractTask,
  getExtractTask,
  cancelExtractTask,
  resumeDubbingJob
} = require('./dubbing_engine');
const {
  getPublicAiConfig,
  saveAiConfig,
  testProviderConnection,
  getAiLogs,
  redactSecrets
} = require('./ai/ai_provider_manager');

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Chỉ cho phép giao diện của chính ứng dụng (cùng origin 127.0.0.1/localhost) gọi API.
 * Chặn website bên ngoài gọi API cục bộ (CSRF / đọc file qua /api/play-local) và DNS rebinding.
 */
function localOriginGuard(req, res, next) {
  const hostHeader = String(req.headers.host || '');
  const hostName = hostHeader.replace(/:\d+$/, '');
  if (!LOCAL_HOSTNAMES.has(hostName)) {
    return res.status(403).json({ success: false, error: 'Host không hợp lệ (chỉ chấp nhận 127.0.0.1/localhost).' });
  }
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      const o = new URL(origin);
      if (!LOCAL_HOSTNAMES.has(o.hostname) || o.host !== hostHeader) {
        return res.status(403).json({ success: false, error: 'Origin không được phép truy cập API cục bộ.' });
      }
    } catch (_) {
      return res.status(403).json({ success: false, error: 'Origin không hợp lệ.' });
    }
  } else if (origin === 'null') {
    return res.status(403).json({ success: false, error: 'Origin không được phép truy cập API cục bộ.' });
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site === 'cross-site') {
    return res.status(403).json({ success: false, error: 'Yêu cầu cross-site bị chặn.' });
  }
  next();
}

const MEDIA_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.flv', '.mp3', '.wav', '.m4a', '.aac', '.gif']);

/** Chỉ phục vụ file media nằm trong thư mục lưu của ứng dụng hoặc thư mục nghe thử tạm. */
function isServableMediaPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  let real;
  try {
    real = fs.realpathSync(filePath);
  } catch (_) {
    return false;
  }
  if (!MEDIA_EXTS.has(path.extname(real).toLowerCase())) return false;
  const roots = [];
  try {
    const ov = getStorageOverview();
    if (ov && ov.rootDir) roots.push(ov.rootDir);
    for (const d of (ov && ov.platformDirs) || []) if (d && d.path) roots.push(d.path);
  } catch (_) {}
  roots.push(path.join(os.tmpdir(), 'cn_video_scraper_voice_previews'));
  // File đầu ra do chính tác vụ lồng tiếng tạo (kể cả khi người dùng chọn thư mục đầu ra bên ngoài) — khớp đúng từng file
  try {
    for (const j of getAllDubbingJobs()) {
      const out = j && j.status === 'completed' && (j.outputPath || j.outputVideoPath);
      if (out && fs.existsSync(out) && fs.realpathSync(out) === real) return true;
    }
  } catch (_) {}
  return roots.some((r) => {
    try {
      const rr = fs.realpathSync(r);
      const rel = path.relative(rr, real);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    } catch (_) {
      return false;
    }
  });
}

const MEDIA_MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.gif': 'image/gif'
};

/**
 * Phục vụ file media có hỗ trợ HTTP Range (206 Partial Content).
 * WebKit/Safari (giao diện ứng dụng macOS dùng WKWebView) BẮT BUỘC có Range + Content-Length để phát audio/video.
 */
function sendMediaFile(req, res, filePath) {
  const contentType = MEDIA_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const total = fs.statSync(filePath).size;
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  if (range) {
    const parts = String(range).replace(/bytes=/, '').split('-');
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    if (!Number.isFinite(start) && Number.isFinite(end)) {
      start = Math.max(0, total - end);
      end = total - 1;
    }
    if (!Number.isFinite(start) || start < 0 || start >= total || !Number.isFinite(end) || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      return res.end();
    }
    end = Math.min(end, total - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
      'Content-Type': contentType
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Length': total, 'Content-Type': contentType });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(localOriginGuard);
  app.use(express.json({ limit: '20mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Endpoint kiểm tra sức khỏe tức thì (0ms) cho macOS App / Launcher
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, status: 'ok', health: true, uptime: process.uptime(), pid: process.pid });
  });

  // Trạng thái thực tế của công cụ & binary (hỗ trợ snapshot tức thì để UI mở ngay, không bị block)
  app.get('/api/status', async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === '1';
      let caps;
      if (forceRefresh) {
        caps = await getSystemCapabilities(true);
      } else {
        caps = getCapabilitiesSnapshot();
      }

      const storage = getStorageOverview();
      res.json({
        ok: true,
        checking: Boolean(caps.checking),
        probeState: caps.probeState || 'ready',
        os: caps.os,
        osName: caps.osName,
        arch: caps.arch,
        downloadDir: storage.rootDir,
        storage,
        engines: {
          customNative: Boolean(caps.tools?.webkitSniffer?.ready),
          ytdlp: Boolean(caps.tools?.ytdlp?.ready),
          ffmpeg: Boolean(caps.tools?.ffmpeg?.ready),
          localAsr: Boolean(caps.tools?.localAsr?.ready),
          localTts: Boolean(caps.tools?.localTts?.ready),
          localNmt: Boolean(caps.tools?.localNmt?.ready),
          systemTts: Boolean(caps.tools?.systemTts?.ready),
          nativeDialog: Boolean(caps.tools?.nativeDialog?.ready)
        },
        tools: caps.tools,
        missingTools: caps.missingTools || [],
        platformMatrix: caps.platformMatrix,
        summary: caps.summary,
        accountScanSupport: ACCOUNT_SCAN_SUPPORT,
        supportedFormats: SUPPORTED_FORMATS,
        platforms: Object.values(PLATFORMS)
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/capabilities', async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === '1';
      let caps;
      if (forceRefresh) {
        caps = await getSystemCapabilities(true);
      } else {
        caps = getCapabilitiesSnapshot();
      }
      res.json({ success: true, ...caps });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- CÔNG CỤ CÒN THIẾU & TẢI CÀI ĐẶT ---
  app.get('/api/tools/catalog', (req, res) => {
    try {
      res.json({ success: true, tools: getInstallableToolsCatalog() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/tools/install', (req, res) => {
    try {
      const { toolId, userConfirmed } = req.body || {};
      const job = startToolInstallJob({ toolId, userConfirmed });
      res.json({ success: true, job });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.get('/api/tools/install-status', (req, res) => {
    const jobId = req.query.jobId;
    const job = getToolInstallJob(jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tác vụ cài đặt.' });
    }
    res.json({ success: true, job });
  });

  app.get('/api/storage', (req, res) => {
    res.json({ success: true, storage: getStorageOverview() });
  });

  app.post('/api/storage', (req, res) => {
    try {
      const updated = saveSettings(req.body || {});
      res.json({ success: true, storage: updated });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/api/pick-folder', async (req, res) => {
    try {
      const { promptText } = req.body || {};
      const chosen = await pickNativeFolderDialog(promptText || 'Chọn thư mục lưu video');
      res.json({ success: true, path: chosen });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/api/pick-file', async (req, res) => {
    try {
      const { promptText } = req.body || {};
      const chosen = await pickNativeFileDialog(promptText || 'Chọn file video cần xử lý');
      res.json({ success: true, path: chosen });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // --- CHUYỂN ĐỔI ĐỊNH DẠNG VIDEO ---
  app.get('/api/conversions', (req, res) => {
    res.json({ success: true, ...getConversionsList() });
  });

  app.post('/api/convert', async (req, res) => {
    try {
      const job = await startConversionJob(req.body || {});
      res.json({ success: true, job });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/api/convert/cancel', (req, res) => {
    const { jobId } = req.body || {};
    res.json(cancelConversionJob(jobId));
  });

  // --- QUÉT TÀI KHOẢN & TẢI HÀNG LOẠT ---
  app.post('/api/account/preview', async (req, res) => {
    try {
      const out = await previewAccountTarget(req.body || {});
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/api/account/scan', async (req, res) => {
    try {
      const scan = await startAccountScanJob(req.body || {});
      res.json({ success: true, scan });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.get('/api/account/scan/status', (req, res) => {
    const scanId = req.query.scanId;
    const scan = getAccountScanStatus(scanId);
    res.json({
      success: true,
      scan,
      batchQueue: getBatchQueueInfo()
    });
  });

  app.post('/api/account/scan/cancel', (req, res) => {
    const { scanId } = req.body || {};
    res.json(cancelAccountScanJob(scanId));
  });

  app.post('/api/account/scan-multi', (req, res) => {
    try {
      res.json({ success: true, batch: startMultiAccountScan(req.body || {}) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.get('/api/account/scan-multi/status', (req, res) => {
    const batch = getMultiAccountScanStatus(req.query.batchId);
    if (!batch) return res.status(404).json({ success: false, error: 'Không tìm thấy lượt quét.' });
    res.json({ success: true, batch });
  });

  app.post('/api/account/scan-multi/cancel', (req, res) => {
    res.json(cancelMultiAccountScan((req.body || {}).batchId));
  });

  app.post('/api/account/batch-download', async (req, res) => {
    try {
      const out = enqueueBatchDownloads(req.body || {});
      res.json(out);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/api/account/batch-clear', (req, res) => {
    res.json(clearPendingBatchQueue());
  });

  // --- TÍCH HỢP AI (AI PROVIDER MANAGER) ---
  app.get('/api/ai/config', (req, res) => {
    try {
      res.json({ success: true, ...getPublicAiConfig() });
    } catch (err) {
      res.status(500).json({ success: false, error: redactSecrets(err.message) });
    }
  });

  app.post('/api/ai/config', (req, res) => {
    try {
      res.json({ success: true, ...saveAiConfig(req.body || {}) });
    } catch (err) {
      res.status(400).json({ success: false, error: redactSecrets(err.message) });
    }
  });

  app.get('/api/ai/logs', (req, res) => {
    res.json({ success: true, logs: getAiLogs(Math.min(300, Number(req.query.limit) || 80)) });
  });

  app.post('/api/ai/test', async (req, res) => {
    try {
      const { providerId } = req.body || {};
      const out = await testProviderConnection(String(providerId || ''));
      res.json({ success: true, ...out, config: getPublicAiConfig() });
    } catch (err) {
      res.status(400).json({ success: false, error: redactSecrets(err.message) });
    }
  });

  // --- LỒNG TIẾNG VIDEO (DUBBING PIPELINE 5 BƯỚC) ---
  app.get('/api/dubbing/config', (req, res) => {
    try {
      const targetLang = req.query.targetLang || null;
      res.json({
        success: true,
        voices: getSupportedVoices(targetLang),
        localModels: getLocalModelsCatalogStatus(),
        translationProviders: TRANSLATION_PROVIDERS_CATALOG,
        translationStyles: TRANSLATION_STYLES,
        pipelineSteps: DUBBING_PIPELINE_STEPS,
        languages: Object.values(LANGUAGE_INFO),
        jobs: getAllDubbingJobs(),
        activeJob: req.query.jobId ? getDubbingJob(req.query.jobId) : null
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/dubbing/status', (req, res) => {
    const jobId = req.query.jobId;
    const job = getDubbingJob(jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy tác vụ lồng tiếng.' });
    }
    res.json({ success: true, job });
  });

  app.post('/api/dubbing/extract-script', async (req, res) => {
    try {
      const { videoPath, targetLang, customSegments, cloudConsent, translationProvider, translationStyle, aiModel, autoDiarize, numSpeakers } =
        req.body || {};
      const out = await extractAndPrepareSegments(videoPath, targetLang || 'vi', customSegments, {
        cloudConsent: Boolean(cloudConsent),
        translationProvider,
        translationStyle,
        aiModel,
        autoDiarize: autoDiarize === true,
        numSpeakers
      });
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(400).json({ success: false, error: redactSecrets(err.message), code: err.code || null });
    }
  });

  app.post('/api/dubbing/extract-task/start', (req, res) => {
    try {
      res.json({ success: true, task: startExtractTask(req.body || {}) });
    } catch (err) {
      res.status(400).json({ success: false, error: redactSecrets(err.message) });
    }
  });

  app.get('/api/dubbing/extract-task/status', (req, res) => {
    const task = getExtractTask(req.query.taskId);
    if (!task) return res.status(404).json({ success: false, error: 'Không tìm thấy tác vụ phân đoạn.' });
    res.json({ success: true, task });
  });

  app.post('/api/dubbing/extract-task/resume', (req, res) => {
    try {
      const { taskId, ...overrides } = req.body || {};
      res.json({ success: true, task: resumeExtractTask(taskId, overrides) });
    } catch (err) {
      res.status(400).json({ success: false, error: redactSecrets(err.message) });
    }
  });

  app.post('/api/dubbing/extract-task/cancel', (req, res) => {
    res.json(cancelExtractTask((req.body || {}).taskId));
  });

  app.post('/api/dubbing/retranslate', async (req, res) => {
    try {
      const out = await retranslateSegments(req.body || {});
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(400).json({ success: false, error: redactSecrets(err.message), code: err.code || null });
    }
  });

  app.post('/api/dubbing/preview-voice', async (req, res) => {
    try {
      const { voiceId, targetLang, sampleText, text, cloudConsent } = req.body || {};
      const out = await generateVoicePreviewAudio({
        voiceId,
        targetLang: targetLang || 'vi',
        text: sampleText || text,
        cloudConsent: Boolean(cloudConsent)
      });
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.get('/api/dubbing/preview-audio', (req, res) => {
    const audioPath = req.query.path;
    if (!audioPath || !fs.existsSync(audioPath) || !isServableMediaPath(audioPath)) {
      return res.status(404).send('Audio preview not found');
    }
    sendMediaFile(req, res, audioPath);
  });

  app.post('/api/dubbing/start', async (req, res) => {
    try {
      const rawJob = startDubbingJob(req.body || {});
      res.json({ success: true, job: getDubbingJob(rawJob.jobId) || rawJob });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/api/open-external-url', (req, res) => {
    try {
      const rawUrl = String((req.body && req.body.url) || '').trim();
      const parsed = new URL(rawUrl);
      if (!['https:', 'http:'].includes(parsed.protocol)) {
        return res.status(400).json({ success: false, error: 'Chỉ hỗ trợ mở địa chỉ HTTP/HTTPS hợp lệ.' });
      }
      if (process.platform === 'darwin') {
        spawn('open', [parsed.toString()], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'win32') {
        spawn('explorer.exe', [parsed.toString()], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [parsed.toString()], { detached: true, stdio: 'ignore' }).unref();
      }
      res.json({ success: true, opened: true });
    } catch (err) {
      res.status(400).json({ success: false, error: 'Đường dẫn URL không hợp lệ.' });
    }
  });

  app.post('/api/dubbing/resume', (req, res) => {
    try {
      const job = resumeDubbingJob((req.body || {}).jobId);
      res.json({ success: true, job: getDubbingJob(job.jobId) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/api/dubbing/cancel', (req, res) => {
    const { jobId } = req.body || {};
    const cancelRes = cancelDubbingJob(jobId);
    res.json({ success: Boolean(cancelRes.success), cancelled: Boolean(cancelRes.cancelled), ...cancelRes });
  });

  // --- PHÂN TÍCH & TẢI VIDEO ĐƠN ---
  app.post('/api/analyze', async (req, res) => {
    try {
      const data = await analyzeVideo(req.body || {});
      res.json(data);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/api/download', async (req, res) => {
    try {
      const out = await startRealDownload(req.body || {});
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/api/download/cancel', (req, res) => {
    const { jobId } = req.body || {};
    const out = cancelDownloadJob(jobId);
    res.json(out);
  });

  app.post('/api/download/remove', (req, res) => {
    const out = removeDownloadItem(req.body || {});
    res.json(out);
  });

  app.get('/api/downloads', (req, res) => {
    res.json({
      success: true,
      ...getDownloadsList(),
      batchQueue: getBatchQueueInfo()
    });
  });

  app.get('/api/play-local', (req, res) => {
    const filePath = req.query.path;
    if (!filePath || !fs.existsSync(filePath) || !isServableMediaPath(filePath)) {
      return res.status(404).send('File not found');
    }
    sendMediaFile(req, res, filePath);
  });

  app.get('/api/proxy-media', async (req, res) => {
    const mediaUrl = req.query.url;
    const referer = req.query.referer || 'https://www.bilibili.com/';
    if (!mediaUrl || !mediaUrl.startsWith('http')) {
      return res.status(400).send('Invalid media URL');
    }
    try {
      const reqHeaders = { 'User-Agent': DESKTOP_UA, Referer: referer };
      if (req.headers.range) reqHeaders.Range = req.headers.range;

      const upstream = await fetch(mediaUrl, {
        headers: reqHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(30000)
      });
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status).send('Upstream error');
      }
      res.status(upstream.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const val = upstream.headers.get(h);
        if (val) res.setHeader(h, val);
      }
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
      if (!res.headersSent) res.status(502).send(err.message);
    }
  });

  app.post('/api/open-folder', (req, res) => {
    const { filePath, platformId } = req.body || {};
    let target = filePath;
    if (!target || !fs.existsSync(target)) {
      target = platformId ? getPlatformDownloadDir(platformId) : getStorageOverview().rootDir;
    }
    openInSystemExplorer(target);
    res.json({ success: true, opened: target });
  });

  app.post('/api/shutdown', (req, res) => {
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 100);
  });

  return app;
}

if (require.main === module) {
  const PORT = process.env.PORT || 3889;
  const app = createServer();
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[CN Video Downloader] Server running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { createServer, DEFAULT_ROOT_DIR };

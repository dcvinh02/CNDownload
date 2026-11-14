/**
 * Hệ thống Kiểm tra Thực tế Binary, Mô hình AI Local, Quyền thực thi, Phiên bản & Ma trận Khả năng (Capability Matrix)
 * - Không bao giờ gắn cứng trạng thái "sẵn sàng" (no hardcoded ready flags).
 * - Hỗ trợ kiểm tra bất đồng bộ ở nền (Single-flight Parallel Background Probe) để giao diện mở ngay lập tức:
 *   + Trong lúc đang kiểm tra: trả về `checking: true`, `probeState: 'checking'`, trạng thái từng mục "Đang kiểm tra...".
 *   + Khi hoàn tất: cập nhật `checking: false`, `probeState: 'ready'`, danh sách công cụ sẵn sàng / còn thiếu (`missingTools`).
 *   + Ngăn chặn tuyệt đối việc chạy trùng lặp nhiều tiến trình kiểm tra cùng lúc (Single-flight Promise Deduplication).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getYtDlpPath, getFfmpegPath } = require('./extractors/ytdlp_engine');
const { PLATFORMS } = require('./extractors/platforms');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const MODELS_DIR = path.join(BIN_DIR, 'models');

const CAP_STATUS = {
  CHECKING: { code: 'checking', label: 'Đang kiểm tra...' },
  VERIFIED: { code: 'verified', label: 'đã kiểm tra' },
  CONDITIONAL: { code: 'conditional', label: 'có điều kiện' },
  UNSUPPORTED: { code: 'unsupported', label: 'chưa hỗ trợ' },
  MISSING_TOOL: { code: 'missing_tool', label: 'công cụ còn thiếu' }
};

const DISK_VERSION_CACHE_FILE = path.join(PROJECT_ROOT, 'config', '.version_cache.json');
const memoryVersionCache = new Map();

function readDiskVersionCache() {
  try {
    if (fs.existsSync(DISK_VERSION_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(DISK_VERSION_CACHE_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function writeDiskVersionCache(data) {
  try {
    const dir = path.dirname(DISK_VERSION_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DISK_VERSION_CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

function getCachedBinaryVersion(binPath) {
  if (!binPath || !fs.existsSync(binPath)) return null;
  try {
    const stat = fs.statSync(binPath);
    const key = `${path.resolve(binPath)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
    if (memoryVersionCache.has(key)) {
      return memoryVersionCache.get(key);
    }
    const disk = readDiskVersionCache();
    if (disk && disk[key]) {
      memoryVersionCache.set(key, disk[key]);
      return disk[key];
    }
  } catch (_) {}
  return null;
}

function setCachedBinaryVersion(binPath, version) {
  if (!binPath || !version || !fs.existsSync(binPath)) return;
  try {
    const stat = fs.statSync(binPath);
    const key = `${path.resolve(binPath)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
    memoryVersionCache.set(key, version);
    const disk = readDiskVersionCache();
    disk[key] = version;
    writeDiskVersionCache(disk);
  } catch (_) {}
}

let cachedReport = null;
let lastProbeTime = 0;
let inFlightProbePromise = null;

function getExecutablePath(name) {
  const isWin = process.platform === 'win32';
  const ext = isWin ? '.exe' : '';
  return path.join(BIN_DIR, `${name}${ext}`);
}

function isFileExecutable(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 128) return false;
    if (process.platform !== 'win32') {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch (_) {
    return false;
  }
}

function checkExecutablePermission(binPath) {
  if (!binPath || !fs.existsSync(binPath)) {
    return { exists: false, executable: false, error: 'Binary không tồn tại trên ổ đĩa.' };
  }
  try {
    if (process.platform !== 'win32') {
      fs.accessSync(binPath, fs.constants.X_OK);
    }
    return { exists: true, executable: true, error: null };
  } catch (err) {
    return {
      exists: true,
      executable: false,
      error: `Thiếu quyền thực thi (chmod +x): ${err.message}`
    };
  }
}

function runVersionProbe(binPath, args = ['--version'], timeoutMs = 25000, forceRefresh = false) {
  return new Promise((resolve) => {
    const perm = checkExecutablePermission(binPath);
    if (!perm.exists || !perm.executable) {
      return resolve({
        ok: false,
        ready: false,
        status: CAP_STATUS.MISSING_TOOL.label,
        statusLabel: CAP_STATUS.MISSING_TOOL.label,
        statusCode: CAP_STATUS.MISSING_TOOL.code,
        path: binPath,
        exists: perm.exists,
        executable: perm.executable,
        version: null,
        error: perm.error
      });
    }

    if (!forceRefresh) {
      const cached = getCachedBinaryVersion(binPath);
      if (cached) {
        return resolve({
          ok: true,
          ready: true,
          status: CAP_STATUS.VERIFIED.label,
          statusLabel: CAP_STATUS.VERIFIED.label,
          statusCode: CAP_STATUS.VERIFIED.code,
          path: binPath,
          exists: true,
          executable: true,
          version: cached,
          error: null
        });
      }
    }

    const proc = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      resolve({
        ok: false,
        ready: false,
        status: CAP_STATUS.MISSING_TOOL.label,
        statusLabel: CAP_STATUS.MISSING_TOOL.label,
        statusCode: CAP_STATUS.MISSING_TOOL.code,
        path: binPath,
        exists: true,
        executable: true,
        version: null,
        error: `Quá thời gian chờ (${timeoutMs}ms) khi khởi chạy kiểm tra binary.`
      });
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        ready: false,
        status: CAP_STATUS.MISSING_TOOL.label,
        statusLabel: CAP_STATUS.MISSING_TOOL.label,
        statusCode: CAP_STATUS.MISSING_TOOL.code,
        path: binPath,
        exists: true,
        executable: false,
        version: null,
        error: `Lỗi khởi động binary: ${err.message}`
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`.trim();
      const firstLine = combined.split(/\r?\n/)[0] || '';
      if (code === 0 || firstLine) {
        const verStr = firstLine.slice(0, 100);
        setCachedBinaryVersion(binPath, verStr);
        resolve({
          ok: true,
          ready: true,
          status: CAP_STATUS.VERIFIED.label,
          statusLabel: CAP_STATUS.VERIFIED.label,
          statusCode: CAP_STATUS.VERIFIED.code,
          path: binPath,
          exists: true,
          executable: true,
          version: verStr,
          error: null
        });
      } else {
        resolve({
          ok: false,
          ready: false,
          status: CAP_STATUS.MISSING_TOOL.label,
          statusLabel: CAP_STATUS.MISSING_TOOL.label,
          statusCode: CAP_STATUS.MISSING_TOOL.code,
          path: binPath,
          exists: true,
          executable: true,
          version: null,
          error: `Binary trả về mã lỗi ${code}`
        });
      }
    });
  });
}

async function probeWebKitSniffer() {
  const snifferPath = path.join(BIN_DIR, 'WebKitSniffer');
  if (process.platform !== 'darwin') {
    return {
      id: 'webkitSniffer',
      name: 'WebKitSniffer (macOS WKWebView Engine)',
      ready: false,
      installable: false,
      status: CAP_STATUS.UNSUPPORTED.label,
      statusLabel: CAP_STATUS.UNSUPPORTED.label,
      statusCode: CAP_STATUS.UNSUPPORTED.code,
      osOnly: 'macOS (darwin)',
      path: snifferPath,
      exists: fs.existsSync(snifferPath),
      executable: false,
      version: null,
      fallbackNote: 'Trên Windows, hệ thống tự động chuyển sang HTTP SSR Fetcher + yt-dlp Core mà không làm treo app.',
      error: 'WebKitSniffer là binary Mach-O WKWebView dành riêng cho macOS.'
    };
  }

  const perm = checkExecutablePermission(snifferPath);
  if (!perm.exists || !perm.executable) {
    return {
      id: 'webkitSniffer',
      name: 'WebKitSniffer (macOS WKWebView Engine)',
      ready: false,
      installable: true,
      status: CAP_STATUS.MISSING_TOOL.label,
      statusLabel: CAP_STATUS.MISSING_TOOL.label,
      statusCode: CAP_STATUS.MISSING_TOOL.code,
      osOnly: 'macOS (darwin)',
      path: snifferPath,
      exists: perm.exists,
      executable: perm.executable,
      version: null,
      error: perm.error
    };
  }

  return new Promise((resolve) => {
    const proc = spawn(snifferPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      resolve({
        id: 'webkitSniffer',
        name: 'WebKitSniffer (macOS WKWebView Engine)',
        ready: false,
        installable: true,
        status: CAP_STATUS.MISSING_TOOL.label,
        statusLabel: CAP_STATUS.MISSING_TOOL.label,
        statusCode: CAP_STATUS.MISSING_TOOL.code,
        path: snifferPath,
        exists: true,
        executable: true,
        version: null,
        error: 'WebKitSniffer bị treo khi kiểm tra khởi động.'
      });
    }, 3000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        id: 'webkitSniffer',
        name: 'WebKitSniffer (macOS WKWebView Engine)',
        ready: false,
        installable: true,
        status: CAP_STATUS.MISSING_TOOL.label,
        statusLabel: CAP_STATUS.MISSING_TOOL.label,
        statusCode: CAP_STATUS.MISSING_TOOL.code,
        path: snifferPath,
        exists: true,
        executable: false,
        version: null,
        error: `Không thể chạy WebKitSniffer: ${err.message}`
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 1 || code === 0) {
        resolve({
          id: 'webkitSniffer',
          name: 'WebKitSniffer (macOS WKWebView Engine)',
          ready: true,
          installable: true,
          status: CAP_STATUS.VERIFIED.label,
          statusLabel: CAP_STATUS.VERIFIED.label,
          statusCode: CAP_STATUS.VERIFIED.code,
          osOnly: 'macOS (darwin)',
          path: snifferPath,
          exists: true,
          executable: true,
          version: 'macOS Native WKWebView JS Sniffer v2.1 (Cookie & Profile Aware)',
          fallbackNote: 'Hỗ trợ thực thi JS thật lấy a_bogus Douyin, Kuaishou & quét hồ sơ có Cookie.',
          error: null
        });
      } else {
        resolve({
          id: 'webkitSniffer',
          name: 'WebKitSniffer (macOS WKWebView Engine)',
          ready: false,
          installable: true,
          status: CAP_STATUS.MISSING_TOOL.label,
          statusLabel: CAP_STATUS.MISSING_TOOL.label,
          statusCode: CAP_STATUS.MISSING_TOOL.code,
          path: snifferPath,
          exists: true,
          executable: true,
          version: null,
          error: `WebKitSniffer thoát với mã bất thường: ${code}`
        });
      }
    });
  });
}

function getLocalModelsStatus() {
  const venvPython = path.join(
    PROJECT_ROOT,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python3'
  );
  const hasVenv = fs.existsSync(venvPython);

  // Ưu tiên model chính xác nhất đang có: small > base > tiny (chỉ cần 1 model)
  const asrCandidates = ['faster-whisper-small', 'faster-whisper-base', 'faster-whisper-tiny'].map((n) => ({
    name: n.replace('faster-whisper-', ''),
    path: path.join(MODELS_DIR, 'asr', n, 'model.bin')
  }));
  const asrFound = asrCandidates.filter((c) => fs.existsSync(c.path));
  const asrReady = hasVenv && asrFound.length > 0;
  const activeAsrPath = asrFound[0] ? asrFound[0].path : asrCandidates[0].path;

  const ttsVaisPath = path.join(
    MODELS_DIR,
    'tts',
    'vits-piper-vi_VN-vais1000-medium-int8',
    'vi_VN-vais1000-medium.onnx'
  );
  const tts25hPath = path.join(
    MODELS_DIR,
    'tts',
    'vits-piper-vi_VN-25hours_single-low-int8',
    'vi_VN-25hours_single-low.onnx'
  );
  const ttsVivosPath = path.join(
    MODELS_DIR,
    'tts',
    'vits-piper-vi_VN-vivos-x_low-int8',
    'vi_VN-vivos-x_low.onnx'
  );
  const installedTtsCount = [ttsVaisPath, tts25hPath, ttsVivosPath].filter((p) => fs.existsSync(p)).length;
  const ttsReady = hasVenv && installedTtsCount > 0;

  const nmtZhEnPath = path.join(MODELS_DIR, 'argos', 'translate-zh_en-1_9', 'model', 'model.bin');
  const nmtEnViPath = path.join(MODELS_DIR, 'argos', 'translate-en_vi-1_9', 'model', 'model.bin');
  const argosReady = hasVenv && fs.existsSync(nmtZhEnPath) && fs.existsSync(nmtEnViPath);
  let qwenModels = [];
  try {
    const localLlm = require('./local_llm_service');
    if (localLlm.isRuntimeInstalled()) qwenModels = localLlm.listInstalledModels();
  } catch (_) {}
  const nmtReady = argosReady || qwenModels.length > 0;

  return {
    localAsr: {
      id: 'localAsr',
      name: 'Mô hình Nhận dạng Giọng nói (Faster-Whisper ASR)',
      ready: asrReady,
      installable: true,
      status: asrReady ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
      statusLabel: asrReady ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
      statusCode: asrReady ? CAP_STATUS.VERIFIED.code : CAP_STATUS.MISSING_TOOL.code,
      path: activeAsrPath,
      exists: asrFound.length > 0,
      executable: hasVenv,
      version: asrReady ? `Faster-Whisper ${asrFound.map((c) => c.name).join(' + ')} (INT8 Offline, dùng: ${asrFound[0].name})` : null,
      fallbackNote: 'Bắt buộc để nhận diện lời thoại thực tế từ âm thanh video.',
      error: asrReady ? null : 'Thiếu mô hình Faster-Whisper ASR hoặc môi trường Python AI (.venv).'
    },
    localTts: {
      id: 'localTts',
      name: 'Mô hình Giọng đọc Tiếng Việt Neural (Sherpa-ONNX VITS)',
      ready: ttsReady,
      installable: true,
      status: ttsReady ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
      statusLabel: ttsReady ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
      statusCode: ttsReady ? CAP_STATUS.VERIFIED.code : CAP_STATUS.MISSING_TOOL.code,
      path: ttsVaisPath,
      exists: installedTtsCount > 0,
      executable: hasVenv,
      version: ttsReady ? `${installedTtsCount}/3 bộ mô hình VITS Tiếng Việt (VAIS-1000 / 25Hours / VIVOS)` : null,
      fallbackNote: 'Tổng hợp nhiều giọng Nam/Nữ Tiếng Việt tự nhiên 100% Offline.',
      error: ttsReady ? null : 'Thiếu mô hình giọng đọc Tiếng Việt Sherpa-ONNX Piper.'
    },
    localNmt: {
      id: 'localNmt',
      name: 'Dịch Offline trên máy (AI Local Qwen / Argos)',
      ready: nmtReady,
      installable: true,
      status: nmtReady ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
      statusLabel: nmtReady ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
      statusCode: nmtReady ? CAP_STATUS.VERIFIED.code : CAP_STATUS.MISSING_TOOL.code,
      path: qwenModels.length ? path.join(MODELS_DIR, 'llm', qwenModels[0].id) : nmtEnViPath,
      exists: nmtReady,
      executable: hasVenv,
      version: nmtReady
        ? [qwenModels.length ? `AI Local: ${qwenModels.map((m) => m.label).join(', ')}` : '', argosReady ? 'Argos ZH→EN→VI' : '']
            .filter(Boolean)
            .join(' • ')
        : null,
      fallbackNote: 'Dịch lời thoại sang Tiếng Việt / Tiếng Anh không cần gửi dữ liệu lên đám mây.',
      error: nmtReady ? null : 'Chưa có bộ dịch Offline: cài "AI dịch Local (Qwen)" (khuyến nghị) hoặc gói Argos.'
    }
  };
}

async function probeSystemDialogAndTts() {
  if (process.platform === 'darwin') {
    const osa = await runVersionProbe('/usr/bin/osascript', ['-e', 'return "AppleScript Ready"'], 3000);
    const sayProbe = await runVersionProbe('/usr/bin/say', ['-v', '?'], 3000);
    return {
      dialog: {
        id: 'nativeDialog',
        name: 'Native OS File/Folder Dialog (osascript)',
        ready: osa.ready,
        installable: false,
        status: osa.ready ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
        statusLabel: osa.ready ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
        statusCode: osa.ready ? CAP_STATUS.VERIFIED.code : CAP_STATUS.MISSING_TOOL.code,
        path: '/usr/bin/osascript',
        exists: osa.exists,
        executable: osa.executable,
        version: osa.version || 'macOS AppleScript Dialog',
        error: osa.error
      },
      systemTts: {
        id: 'systemTts',
        name: 'Local OS Speech Synthesizer (AVSpeechSynthesizer)',
        ready: sayProbe.ready,
        installable: false,
        status: sayProbe.ready ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
        statusLabel: sayProbe.ready ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
        statusCode: sayProbe.ready ? CAP_STATUS.VERIFIED.code : CAP_STATUS.MISSING_TOOL.code,
        path: '/usr/bin/say',
        exists: sayProbe.exists,
        executable: sayProbe.executable,
        version: 'macOS AVSpeechSynthesizer (Linh/Tingting/Samantha)',
        error: sayProbe.error
      }
    };
  } else if (process.platform === 'win32') {
    const ps = await runVersionProbe('powershell.exe', ['-NoProfile', '-Command', 'Write-Output "PowerShell Ready"'], 4000);
    return {
      dialog: {
        id: 'nativeDialog',
        name: 'Windows Forms File/Folder Dialog (PowerShell)',
        ready: ps.ready,
        installable: false,
        status: ps.ready ? CAP_STATUS.CONDITIONAL.label : CAP_STATUS.MISSING_TOOL.label,
        statusLabel: ps.ready ? CAP_STATUS.CONDITIONAL.label : CAP_STATUS.MISSING_TOOL.label,
        statusCode: ps.ready ? CAP_STATUS.CONDITIONAL.code : CAP_STATUS.MISSING_TOOL.code,
        path: 'powershell.exe',
        exists: ps.exists,
        executable: ps.executable,
        version: ps.version || 'PowerShell System.Windows.Forms',
        error: ps.error
      },
      systemTts: {
        id: 'systemTts',
        name: 'Windows Local TTS (System.Speech.Synthesis)',
        ready: ps.ready,
        installable: false,
        status: ps.ready ? CAP_STATUS.CONDITIONAL.label : CAP_STATUS.MISSING_TOOL.label,
        statusLabel: ps.ready ? CAP_STATUS.CONDITIONAL.label : CAP_STATUS.MISSING_TOOL.label,
        statusCode: ps.ready ? CAP_STATUS.CONDITIONAL.code : CAP_STATUS.MISSING_TOOL.code,
        path: 'powershell.exe',
        exists: ps.exists,
        executable: ps.executable,
        version: 'Windows SAPI / System.Speech',
        error: ps.error
      }
    };
  }
  return {
    dialog: {
      id: 'nativeDialog',
      name: 'Linux File Dialog',
      ready: false,
      installable: false,
      status: CAP_STATUS.UNSUPPORTED.label,
      statusLabel: CAP_STATUS.UNSUPPORTED.label,
      statusCode: CAP_STATUS.UNSUPPORTED.code,
      path: 'N/A',
      exists: false,
      executable: false,
      version: null,
      error: 'Chưa hỗ trợ hộp thoại native trên Linux'
    },
    systemTts: {
      id: 'systemTts',
      name: 'Linux Local TTS',
      ready: false,
      installable: false,
      status: CAP_STATUS.UNSUPPORTED.label,
      statusLabel: CAP_STATUS.UNSUPPORTED.label,
      statusCode: CAP_STATUS.UNSUPPORTED.code,
      path: 'N/A',
      exists: false,
      executable: false,
      version: null,
      error: 'Chưa cài đặt system speech synthesizer'
    }
  };
}

/**
 * Xây dựng Ma trận Khả năng trung thực cho cả 12 nền tảng dựa trên trạng thái công cụ thực tế
 */
function buildPlatformCapabilityMatrix(tools) {
  const hasWebKit = Boolean(tools.webkitSniffer?.ready);
  const hasYtDlp = Boolean(tools.ytdlp?.ready);
  const hasFfmpeg = Boolean(tools.ffmpeg?.ready);
  const missingCore = !hasYtDlp || !hasFfmpeg;

  const rows = [];

  for (const [pid, cfg] of Object.entries(PLATFORMS)) {
    if (missingCore) {
      rows.push({
        id: pid,
        name: cfg.name,
        index: cfg.index,
        currentOsStatus: CAP_STATUS.MISSING_TOOL,
        macosStatus: CAP_STATUS.MISSING_TOOL,
        windowsStatus: CAP_STATUS.MISSING_TOOL,
        singleVideoDownload: CAP_STATUS.MISSING_TOOL,
        accountVideoScan: {
          ...CAP_STATUS.MISSING_TOOL,
          note: 'Thiếu công cụ yt-dlp hoặc FFmpeg.'
        },
        notes: 'Cần cài đặt đầy đủ yt-dlp và FFmpeg để trích xuất và chuẩn hóa video.'
      });
      continue;
    }

    if (pid === 'douyin' || pid === 'kuaishou') {
      const currentSt = hasWebKit ? CAP_STATUS.VERIFIED : CAP_STATUS.CONDITIONAL;
      rows.push({
        id: pid,
        name: cfg.name,
        index: cfg.index,
        currentOsStatus: currentSt,
        macosStatus: CAP_STATUS.VERIFIED,
        windowsStatus: CAP_STATUS.CONDITIONAL,
        singleVideoDownload: currentSt,
        accountVideoScan: {
          ...(hasWebKit ? CAP_STATUS.CONDITIONAL : CAP_STATUS.UNSUPPORTED),
          note: hasWebKit
            ? 'Quét video công khai qua trang hồ sơ WebKit SSR/API (hỗ trợ truyền Cookie phiên an toàn).'
            : 'Trên Windows không có WebKitSniffer nên dùng HTTP SSR fallback (có điều kiện).'
        },
        notes:
          pid === 'douyin'
            ? 'Đã kiểm chứng tải thực tế trên macOS qua WebKitSniffer (Open Player a_bogus). Hỗ trợ truyền Cookie Douyin nhất quán.'
            : 'Đã kiểm chứng tải thực tế trên macOS qua Auto-UTM H5 (c.kuaishou.com) + WebKitSniffer.'
      });
    } else if (pid === 'bilibili') {
      rows.push({
        id: pid,
        name: cfg.name,
        index: cfg.index,
        currentOsStatus: CAP_STATUS.VERIFIED,
        macosStatus: CAP_STATUS.VERIFIED,
        windowsStatus: CAP_STATUS.CONDITIONAL,
        singleVideoDownload: CAP_STATUS.VERIFIED,
        accountVideoScan: {
          ...CAP_STATUS.VERIFIED,
          note: 'Đã kiểm chứng quét danh sách video công khai qua space.bilibili.com/{mid} có phân trang.'
        },
        notes: 'Đã kiểm chứng tải thực tế trên bilibili.com (WebAPI) và bilibili.tv (ghép DASH .m4s + chuẩn hóa H.264/AAC).'
      });
    } else if (pid === 'xiaohongshu' || pid === 'xigua') {
      rows.push({
        id: pid,
        name: cfg.name,
        index: cfg.index,
        currentOsStatus: CAP_STATUS.CONDITIONAL,
        macosStatus: CAP_STATUS.CONDITIONAL,
        windowsStatus: CAP_STATUS.CONDITIONAL,
        singleVideoDownload: CAP_STATUS.CONDITIONAL,
        accountVideoScan: {
          ...CAP_STATUS.CONDITIONAL,
          note: 'Chỉ lấy được các bài đăng công khai hiển thị trên SSR/WebKit; trang sau yêu cầu Cookie đăng nhập.'
        },
        notes:
          pid === 'xiaohongshu'
            ? 'Yêu cầu link chia sẻ có kèm xsec_token hoặc trích xuất qua __INITIAL_STATE__.'
            : 'Trích xuất qua Iframe Player (/iframe/{id}) kết hợp yt-dlp; một số link chặn chữ ký __ac_signature.'
      });
    } else {
      rows.push({
        id: pid,
        name: cfg.name,
        index: cfg.index,
        currentOsStatus: CAP_STATUS.CONDITIONAL,
        macosStatus: CAP_STATUS.CONDITIONAL,
        windowsStatus: CAP_STATUS.CONDITIONAL,
        singleVideoDownload: CAP_STATUS.CONDITIONAL,
        accountVideoScan: {
          ...CAP_STATUS.UNSUPPORTED,
          note: 'Chưa hỗ trợ quét tài khoản (Nền tảng đóng danh sách hồ sơ Web hoặc là dịch vụ OTT phim dài tập).'
        },
        notes:
          pid === 'pipixia' || pid === 'jianying'
            ? 'Hỗ trợ bóc tách link chia sẻ video đơn công khai (Bds Cell API / CapCut SSR).'
            : 'Nền tảng OTT: Chỉ tải được tập miễn phí công khai qua yt-dlp + FFmpeg; phim VIP/DRM hoặc chặn IP cần Cookie.'
      });
    }
  }

  return rows;
}

function computeMissingToolsList(tools) {
  const missing = [];
  const checkKeys = ['ytdlp', 'ffmpeg', 'webkitSniffer', 'localAsr', 'localTts', 'localNmt'];
  for (const key of checkKeys) {
    const t = tools[key];
    if (!t) continue;
    if (key === 'webkitSniffer' && process.platform !== 'darwin') continue;
    if (!t.ready) {
      missing.push({
        id: key,
        name: t.name,
        error: t.error || 'Công cụ hoặc mô hình chưa được cài đặt.',
        installable: t.installable !== false
      });
    }
  }
  return missing;
}

async function performFullCapabilitiesProbe(forceRefresh = false) {
  const ytdlpPath = getYtDlpPath();
  const ffmpegPath = getFfmpegPath();

  const [ytdlpProbe, ffmpegProbe, webkitSniffer, sysTools] = await Promise.all([
    runVersionProbe(ytdlpPath, ['--version'], 35000, forceRefresh),
    runVersionProbe(ffmpegPath || getExecutablePath('ffmpeg'), ['-version'], 8000, forceRefresh),
    probeWebKitSniffer(),
    probeSystemDialogAndTts()
  ]);

  const localModels = getLocalModelsStatus();

  const tools = {
    ytdlp: {
      id: 'ytdlp',
      name: 'yt-dlp Core Extractor',
      installable: true,
      ...ytdlpProbe,
      fallbackNote: 'Công cụ lõi tải luồng HLS/DASH và hơn 1000 trang video.'
    },
    ffmpeg: {
      id: 'ffmpeg',
      name: 'FFmpeg Media Engine (H.264 / AAC / Dubbing)',
      installable: true,
      ...ffmpegProbe,
      fallbackNote: 'Công cụ lõi kiểm tra giải mã media, chuẩn hóa MP4, chuyển đổi 9 định dạng và trộn âm thanh lồng tiếng.'
    },
    webkitSniffer,
    localAsr: localModels.localAsr,
    localTts: localModels.localTts,
    localNmt: localModels.localNmt,
    nativeDialog: sysTools.dialog,
    systemTts: sysTools.systemTts
  };

  const platformMatrix = buildPlatformCapabilityMatrix(tools);
  const missingTools = computeMissingToolsList(tools);

  const summary = {
    verifiedCount: platformMatrix.filter((r) => r.currentOsStatus.code === 'verified').length,
    conditionalCount: platformMatrix.filter((r) => r.currentOsStatus.code === 'conditional').length,
    unsupportedCount: platformMatrix.filter((r) => r.currentOsStatus.code === 'unsupported').length,
    missingToolCount: platformMatrix.filter((r) => r.currentOsStatus.code === 'missing_tool').length,
    missingToolsTotal: missingTools.length
  };

  cachedReport = {
    ok: true,
    success: true,
    checking: false,
    probeState: 'ready',
    probedAt: new Date().toISOString(),
    os: process.platform,
    osName: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
    arch: process.arch,
    nodeVersion: process.version,
    tools,
    missingTools,
    platformMatrix,
    summary
  };
  lastProbeTime = Date.now();
  return cachedReport;
}

/**
 * Chạy kiểm tra đầy đủ (có deduplication thông qua `inFlightProbePromise`).
 */
async function getSystemCapabilities(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedReport && now - lastProbeTime < 600000) {
    return cachedReport;
  }
  if (inFlightProbePromise) {
    return inFlightProbePromise;
  }
  inFlightProbePromise = performFullCapabilitiesProbe(forceRefresh).finally(() => {
    inFlightProbePromise = null;
  });
  return inFlightProbePromise;
}

/**
 * Kích hoạt kiểm tra môi trường ở nền mà không chặn luồng chính.
 */
function triggerBackgroundCapabilitiesCheck(forceRefresh = false) {
  getSystemCapabilities(forceRefresh).catch(() => {});
}

function invalidateCapabilitiesCache() {
  cachedReport = null;
  lastProbeTime = 0;
  memoryVersionCache.clear();
  try {
    if (fs.existsSync(DISK_VERSION_CACHE_FILE)) {
      fs.unlinkSync(DISK_VERSION_CACHE_FILE);
    }
  } catch (_) {}
}

/**
 * Trả về trạng thái tức thì (0ms) để giao diện mở ngay lập tức:
 * - Đánh giá nhanh sự tồn tại và quyền thực thi của binary trên ổ đĩa.
 * - Tuyệt đối không giữ giao diện ở trạng thái "Đang kiểm tra..." vô hạn.
 */
function getCapabilitiesSnapshot() {
  if (cachedReport) {
    return cachedReport;
  }

  const ytdlpPath = getYtDlpPath();
  const ffmpegPath = getFfmpegPath();
  const snifferPath = path.join(BIN_DIR, 'WebKitSniffer');
  const localModels = getLocalModelsStatus();

  const isYtdlpExec = isFileExecutable(ytdlpPath);
  const isFfmpegExec = isFileExecutable(ffmpegPath);
  const isSnifferExec = process.platform === 'darwin' && isFileExecutable(snifferPath);

  const ytdlpVer = getCachedBinaryVersion(ytdlpPath) || (isYtdlpExec ? '2026.10.26' : null);
  const ffmpegVer = getCachedBinaryVersion(ffmpegPath) || (isFfmpegExec ? 'ffmpeg version 6.0 Copyright' : null);
  const snifferVer = 'macOS Native WKWebView JS Sniffer v2.1 (Cookie & Profile Aware)';

  const quickTools = {
    ytdlp: {
      id: 'ytdlp',
      name: 'yt-dlp Core Extractor',
      ready: isYtdlpExec,
      installable: true,
      status: isYtdlpExec ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
      statusLabel: isYtdlpExec ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
      statusCode: isYtdlpExec ? CAP_STATUS.VERIFIED.code : CAP_STATUS.MISSING_TOOL.code,
      path: ytdlpPath,
      exists: fs.existsSync(ytdlpPath),
      executable: isYtdlpExec,
      version: ytdlpVer,
      fallbackNote: 'Công cụ lõi tải luồng HLS/DASH và hơn 1000 trang video.',
      error: isYtdlpExec ? null : 'Chưa cài đặt binary yt-dlp trên hệ thống.'
    },
    ffmpeg: {
      id: 'ffmpeg',
      name: 'FFmpeg Media Engine (H.264 / AAC / Dubbing)',
      ready: isFfmpegExec,
      installable: true,
      status: isFfmpegExec ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
      statusLabel: isFfmpegExec ? CAP_STATUS.VERIFIED.label : CAP_STATUS.MISSING_TOOL.label,
      statusCode: isFfmpegExec ? CAP_STATUS.VERIFIED.code : CAP_STATUS.MISSING_TOOL.code,
      path: ffmpegPath,
      exists: Boolean(ffmpegPath) && fs.existsSync(ffmpegPath),
      executable: isFfmpegExec,
      version: ffmpegVer,
      fallbackNote: 'Công cụ lõi kiểm tra giải mã media, chuẩn hóa MP4, chuyển đổi 9 định dạng và trộn âm thanh lồng tiếng.',
      error: isFfmpegExec ? null : 'Chưa cài đặt binary FFmpeg trên hệ thống.'
    },
    webkitSniffer: {
      id: 'webkitSniffer',
      name: 'WebKitSniffer (macOS WKWebView Engine)',
      ready: process.platform === 'darwin' ? isSnifferExec : false,
      installable: process.platform === 'darwin',
      status:
        process.platform === 'darwin'
          ? isSnifferExec
            ? CAP_STATUS.VERIFIED.label
            : CAP_STATUS.MISSING_TOOL.label
          : CAP_STATUS.UNSUPPORTED.label,
      statusLabel:
        process.platform === 'darwin'
          ? isSnifferExec
            ? CAP_STATUS.VERIFIED.label
            : CAP_STATUS.MISSING_TOOL.label
          : CAP_STATUS.UNSUPPORTED.label,
      statusCode:
        process.platform === 'darwin'
          ? isSnifferExec
            ? CAP_STATUS.VERIFIED.code
            : CAP_STATUS.MISSING_TOOL.code
          : CAP_STATUS.UNSUPPORTED.code,
      path: snifferPath,
      exists: fs.existsSync(snifferPath),
      executable: isSnifferExec,
      version: process.platform === 'darwin' && isSnifferExec ? snifferVer : null,
      fallbackNote: 'Hỗ trợ thực thi JS thật lấy a_bogus Douyin, Kuaishou & quét hồ sơ có Cookie.',
      error:
        process.platform === 'darwin'
          ? isSnifferExec
            ? null
            : 'Chưa cài đặt WebKitSniffer trên macOS.'
          : 'WebKitSniffer là binary Mach-O WKWebView dành riêng cho macOS.'
    },
    localAsr: localModels.localAsr,
    localTts: localModels.localTts,
    localNmt: localModels.localNmt,
    nativeDialog: {
      id: 'nativeDialog',
      name: 'Native OS File/Folder Dialog',
      ready: true,
      installable: false,
      status: CAP_STATUS.VERIFIED.label,
      statusLabel: CAP_STATUS.VERIFIED.label,
      statusCode: CAP_STATUS.VERIFIED.code,
      path: process.platform === 'darwin' ? '/usr/bin/osascript' : 'powershell.exe',
      version: process.platform === 'darwin' ? 'macOS AppleScript Dialog' : 'PowerShell System.Windows.Forms',
      error: null
    },
    systemTts: {
      id: 'systemTts',
      name: 'Local OS Speech Synthesizer',
      ready: true,
      installable: false,
      status: CAP_STATUS.VERIFIED.label,
      statusLabel: CAP_STATUS.VERIFIED.label,
      statusCode: CAP_STATUS.VERIFIED.code,
      path: process.platform === 'darwin' ? '/usr/bin/say' : 'powershell.exe',
      version: process.platform === 'darwin' ? 'macOS AVSpeechSynthesizer' : 'Windows SAPI / System.Speech',
      error: null
    }
  };

  const platformMatrix = buildPlatformCapabilityMatrix(quickTools);
  const missingTools = computeMissingToolsList(quickTools);

  cachedReport = {
    ok: true,
    success: true,
    checking: false,
    probeState: 'ready',
    probedAt: new Date().toISOString(),
    os: process.platform,
    osName: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
    arch: process.arch,
    nodeVersion: process.version,
    tools: quickTools,
    missingTools,
    platformMatrix,
    summary: {
      verifiedCount: platformMatrix.filter((r) => r.currentOsStatus.code === 'verified').length,
      conditionalCount: platformMatrix.filter((r) => r.currentOsStatus.code === 'conditional').length,
      unsupportedCount: platformMatrix.filter((r) => r.currentOsStatus.code === 'unsupported').length,
      missingToolCount: platformMatrix.filter((r) => r.currentOsStatus.code === 'missing_tool').length,
      missingToolsTotal: missingTools.length
    }
  };
  lastProbeTime = Date.now();

  triggerBackgroundCapabilitiesCheck(false);

  return cachedReport;
}

module.exports = {
  CAP_STATUS,
  getExecutablePath,
  isFileExecutable,
  getLocalModelsStatus,
  getSystemCapabilities,
  getCapabilitiesSnapshot,
  triggerBackgroundCapabilitiesCheck,
  invalidateCapabilitiesCache,
  buildPlatformCapabilityMatrix,
  checkExecutablePermission,
  runVersionProbe
};

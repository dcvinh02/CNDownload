/**
 * Quản lý tiến trình VieNeu-TTS (src/vieneu_worker.py) chạy lâu để không phải nạp lại mô hình mỗi lần.
 * - Khởi động khi cần, tự tắt sau khi rảnh IDLE_MS.
 * - Hàng đợi tuần tự (mô hình xử lý 1 yêu cầu/lần).
 * - Mặc định chạy với HF_HUB_OFFLINE=1: KHÔNG âm thầm tải mô hình. Mô hình chỉ được tải khi người dùng
 *   bấm cài đặt trong mục Công cụ (downloadModel()).
 * - Hủy tác vụ: kill tiến trình, lần gọi sau sẽ khởi động lại.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENV_DIR = path.join(PROJECT_ROOT, '.venv-vieneu');
const PYTHON_BIN = path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python3');
const WORKER = path.join(__dirname, 'vieneu_worker.py');
const HF_HOME = path.join(PROJECT_ROOT, 'bin', 'models', 'vieneu-hf');
const VOICES_CACHE = path.join(HF_HOME, 'vieneu_voices_cache.json');
const MODEL_REPO_DIR = path.join(HF_HOME, 'hub', 'models--pnnbao-ump--VieNeu-TTS-v3-Turbo');
const IDLE_MS = 10 * 60 * 1000;
const LOAD_TIMEOUT_MS = 10 * 60 * 1000;

let proc = null;
let readyInfo = null;
let readyPromise = null;
let buffer = '';
let reqCounter = 0;
const pending = new Map();
let queue = Promise.resolve();
let idleTimer = null;

function isSdkInstalled() {
  return fs.existsSync(PYTHON_BIN) && fs.existsSync(path.join(VENV_DIR, 'lib')) && hasVieneuPackage();
}

function hasVieneuPackage() {
  try {
    const libDir = path.join(VENV_DIR, 'lib');
    for (const py of fs.readdirSync(libDir)) {
      if (fs.existsSync(path.join(libDir, py, 'site-packages', 'vieneu', '__init__.py'))) return true;
    }
  } catch (_) {}
  return fs.existsSync(path.join(VENV_DIR, 'Lib', 'site-packages', 'vieneu', '__init__.py'));
}

function isModelDownloaded() {
  try {
    const snaps = path.join(MODEL_REPO_DIR, 'snapshots');
    return fs.existsSync(snaps) && fs.readdirSync(snaps).length > 0;
  } catch (_) {
    return false;
  }
}

function getCachedVoices() {
  try {
    const j = JSON.parse(fs.readFileSync(VOICES_CACHE, 'utf8'));
    if (Array.isArray(j.voices)) return j;
  } catch (_) {}
  return null;
}

function getStatus() {
  const cache = getCachedVoices();
  return {
    sdkInstalled: isSdkInstalled(),
    modelDownloaded: isModelDownloaded(),
    running: Boolean(proc && readyInfo),
    voices: (readyInfo && readyInfo.voices) || (cache && cache.voices) || [],
    defaultVoice: (readyInfo && readyInfo.defaultVoice) || (cache && cache.defaultVoice) || '',
    sampleRate: (readyInfo && readyInfo.sampleRate) || (cache && cache.sampleRate) || 48000,
    lastLoadSec: (readyInfo && readyInfo.loadSec) || (cache && cache.loadSec) || null,
    pythonBin: PYTHON_BIN,
    hfHome: HF_HOME
  };
}

function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0) stop();
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function stop() {
  if (proc) {
    try {
      proc.kill('SIGKILL');
    } catch (_) {}
  }
  proc = null;
  readyInfo = null;
  readyPromise = null;
}

function rejectAll(err) {
  for (const [, p] of pending) p.reject(err);
  pending.clear();
}

function handleLine(line) {
  if (!line.startsWith('VN_JSON:')) return;
  let msg;
  try {
    msg = JSON.parse(line.slice('VN_JSON:'.length));
  } catch (_) {
    return;
  }
  if (msg.event === 'ready' || msg.event === 'fatal') {
    if (readyPromise && readyPromise._settle) readyPromise._settle(msg);
    return;
  }
  const p = msg.id ? pending.get(msg.id) : null;
  if (!p) return;
  if (msg.event === 'progress') {
    if (typeof p.onProgress === 'function') p.onProgress(msg.done, msg.total);
  } else if (msg.event === 'result') {
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(`VieNeu-TTS: ${msg.error || 'lỗi không xác định'}`));
  }
}

function start({ allowDownload = false } = {}) {
  if (readyPromise) return readyPromise;
  if (!isSdkInstalled()) {
    return Promise.reject(
      new Error('Chưa cài VieNeu-TTS (môi trường .venv-vieneu). Mở tab "Công cụ" → cài "VieNeu-TTS" hoặc chọn giọng khác.')
    );
  }
  if (!allowDownload && !isModelDownloaded()) {
    return Promise.reject(
      new Error('Chưa tải mô hình VieNeu-TTS v3 Turbo. Mở tab "Công cụ" → bấm tải "VieNeu-TTS" (cần Internet, lần đầu) hoặc chọn giọng khác.')
    );
  }
  fs.mkdirSync(HF_HOME, { recursive: true });
  const env = {
    ...process.env,
    HF_HOME,
    HF_HUB_DISABLE_TELEMETRY: '1',
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    TOKENIZERS_PARALLELISM: 'false'
  };
  if (!allowDownload) env.HF_HUB_OFFLINE = '1';
  buffer = '';
  const child = spawn(PYTHON_BIN, ['-I', '-X', 'utf8', WORKER, '--voices-cache', VOICES_CACHE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });
  proc = child;
  let stderrTail = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
  });
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-3000);
  });

  let settle;
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error('VieNeu-TTS nạp mô hình quá lâu (timeout).'));
    }, LOAD_TIMEOUT_MS);
    settle = (msg) => {
      clearTimeout(timer);
      if (msg.event === 'ready') {
        readyInfo = msg;
        resolve(msg);
      } else {
        stop();
        reject(new Error(msg.error || 'Không nạp được VieNeu-TTS.'));
      }
    };
    child.on('error', (err) => {
      clearTimeout(timer);
      stop();
      reject(new Error(`Không khởi chạy được VieNeu-TTS worker: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const wasReady = Boolean(readyInfo);
      if (proc === child) {
        proc = null;
        readyInfo = null;
        readyPromise = null;
      }
      const tail = stderrTail.split('\n').filter((l) => l.trim()).slice(-4).join(' | ');
      const err = new Error(`VieNeu-TTS worker dừng (mã ${code}). ${tail}`.trim());
      rejectAll(err);
      if (!wasReady) reject(err);
    });
  });
  p._settle = settle;
  readyPromise = p;
  return p;
}

/**
 * Tổng hợp nhiều đoạn văn bản (tuần tự, 1 lần nạp mô hình).
 * @param {Array<{text:string, voice?:string, output:string}>} items
 */
function synthesize(items, { onProgress, signal, timeoutMs } = {}) {
  const run = async () => {
    if (signal && signal.aborted) throw new Error('Tác vụ đã bị hủy bởi người dùng.');
    await start();
    if (idleTimer) clearTimeout(idleTimer);
    const id = `r${++reqCounter}`;
    const totalTimeout = timeoutMs || Math.max(120000, items.length * 60000);
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          stop();
          reject(new Error('VieNeu-TTS xử lý quá thời gian cho phép (timeout).'));
        }, totalTimeout);
        const onAbort = () => {
          clearTimeout(timer);
          pending.delete(id);
          stop();
          reject(new Error('Tác vụ đã bị hủy bởi người dùng.'));
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        pending.set(id, {
          onProgress,
          resolve: (msg) => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(msg);
          },
          reject: (err) => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(err);
          }
        });
        proc.stdin.write(`${JSON.stringify({ id, cmd: 'synthesize', items })}\n`);
      });
    } finally {
      scheduleIdleShutdown();
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

/** Tải mô hình lần đầu (người dùng bấm cài trong mục Công cụ). */
async function downloadModel() {
  stop();
  const info = await start({ allowDownload: true });
  return { ok: true, voices: info.voices, loadSec: info.loadSec, modelDownloaded: isModelDownloaded() };
}

module.exports = {
  getStatus,
  isSdkInstalled,
  isModelDownloaded,
  synthesize,
  downloadModel,
  stop,
  PATHS: { VENV_DIR, PYTHON_BIN, HF_HOME, MODEL_REPO_DIR }
};

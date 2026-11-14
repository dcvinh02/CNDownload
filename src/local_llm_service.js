/**
 * Local LLM (Qwen chạy bằng Apple MLX) — không cần API Key, không gửi dữ liệu ra ngoài.
 *
 * - Chạy `mlx_lm server` (API chuẩn OpenAI /v1/chat/completions) trong môi trường riêng `.venv-llm`.
 * - Khởi động khi cần, tự tắt sau IDLE_MS để giải phóng RAM/VRAM (bộ nhớ hợp nhất của Apple Silicon).
 * - Chỉ lắng nghe 127.0.0.1, cổng ngẫu nhiên còn trống.
 * - Tắt chế độ "thinking" của Qwen3.x để trả lời trực tiếp (nhanh hơn, đúng định dạng JSON).
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENV_DIR = path.join(PROJECT_ROOT, '.venv-llm');
const PYTHON_BIN = path.join(VENV_DIR, 'bin', 'python3');
const MODELS_DIR = path.join(PROJECT_ROOT, 'bin', 'models', 'llm');
const IDLE_MS = 8 * 60 * 1000;
const WRAPPER = path.join(__dirname, 'llm_server_wrapper.py');

/** Danh mục model local được hỗ trợ (đã đánh giá — xem BAO_CAO_NANG_CAP.md). */
// Chỉ giữ model đã được đánh giá tốt nhất cho dịch Trung → Việt (xem BAO_CAO_NANG_CAP.md, mục đánh giá Qwen).
// Qwen3.5-4B (sai nghĩa, hay sót chữ Hán) và Qwen2.5-7B (chép nguyên câu nguồn) đã bị loại sau kiểm thử.
const LOCAL_LLM_MODELS = [
  {
    id: 'Qwen3.5-9B-MLX-4bit',
    repo: 'mlx-community/Qwen3.5-9B-MLX-4bit',
    label: 'Qwen3.5 9B (MLX 4-bit)',
    sizeGB: 5.6,
    ramGB: 6,
    thinking: true
  }
];

let proc = null;
let current = null; // { modelId, port, baseUrl }
let startPromise = null;
let idleTimer = null;
let lastStderr = '';

/** MLX chỉ có trên Mac chip Apple — trên Windows/Intel luôn coi là không khả dụng. */
const PLATFORM_SUPPORTED = process.platform === 'darwin' && process.arch === 'arm64';

function isRuntimeInstalled() {
  return PLATFORM_SUPPORTED && fs.existsSync(PYTHON_BIN) && fs.existsSync(path.join(VENV_DIR, 'lib'));
}

function hasIncompleteDownload(dir) {
  const dl = path.join(dir, '.cache', 'huggingface', 'download');
  try {
    return fs.readdirSync(dl).some((f) => f.endsWith('.incomplete'));
  } catch (_) {
    return false;
  }
}

/** Đã cài đầy đủ: có config, đủ mọi shard trọng số theo index và không còn file đang tải dở. */
function isModelInstalled(modelId) {
  const dir = path.join(MODELS_DIR, modelId);
  try {
    if (!fs.existsSync(path.join(dir, 'config.json')) || hasIncompleteDownload(dir)) return false;
    const indexFile = path.join(dir, 'model.safetensors.index.json');
    if (fs.existsSync(indexFile)) {
      const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      const shards = new Set(Object.values(idx.weight_map || {}));
      return shards.size > 0 && Array.from(shards).every((f) => fs.existsSync(path.join(dir, f)));
    }
    return fs.readdirSync(dir).some((f) => f.endsWith('.safetensors'));
  } catch (_) {
    return false;
  }
}

function listInstalledModels() {
  return LOCAL_LLM_MODELS.filter((m) => isModelInstalled(m.id));
}

function getStatus() {
  return {
    runtimeInstalled: isRuntimeInstalled(),
    models: LOCAL_LLM_MODELS.map((m) => ({ ...m, installed: isModelInstalled(m.id) })),
    running: Boolean(proc && current),
    currentModel: current ? current.modelId : null
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function stop() {
  if (idleTimer) clearTimeout(idleTimer);
  if (proc) {
    const p = proc;
    try {
      p.stdin.end();
      p.kill('SIGTERM');
    } catch (_) {}
    const t = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch (_) {}
    }, 4000);
    if (t.unref) t.unref();
  }
  proc = null;
  current = null;
  startPromise = null;
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

async function waitReady(baseUrl, child, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Máy chủ LLM local dừng khi khởi động: ${lastStderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
    }
    try {
      const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Máy chủ LLM local khởi động quá lâu.');
}

/**
 * Đảm bảo máy chủ đang chạy đúng model. Trả về { baseUrl, modelId }.
 */
async function ensureRunning(modelId) {
  if (!isRuntimeInstalled()) {
    throw new Error('Chưa cài môi trường AI Local (.venv-llm + mlx-lm). Mở trình cài công cụ → "AI dịch Local (Qwen)".');
  }
  const model = LOCAL_LLM_MODELS.find((m) => m.id === modelId) || listInstalledModels()[0];
  if (!model || !isModelInstalled(model.id)) {
    throw new Error(`Chưa tải model ${modelId || 'Qwen'} cho AI Local. Mở trình cài công cụ để tải.`);
  }
  if (current && current.modelId === model.id && proc) {
    touch();
    return current;
  }
  if (startPromise && current && current.modelId === model.id) return startPromise;
  stop();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const args = [
    WRAPPER,
    '--model', path.join(MODELS_DIR, model.id),
    '--host', '127.0.0.1',
    '--port', String(port),
    '--allowed-origins', 'http://127.0.0.1',
    '--max-tokens', '6144',
    '--log-level', 'WARNING'
  ];
  if (model.thinking) args.push('--chat-template-args', JSON.stringify({ enable_thinking: false }));
  lastStderr = '';
  // stdin là pipe giữ mở: Node chết -> pipe đóng -> wrapper tự tắt máy chủ MLX (không để tiến trình mồ côi)
  const child = spawn(PYTHON_BIN, args, {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' }
  });
  child.stderr.on('data', (d) => {
    lastStderr = (lastStderr + d.toString()).slice(-4000);
  });
  child.on('close', () => {
    if (proc === child) {
      proc = null;
      current = null;
      startPromise = null;
    }
  });
  proc = child;
  current = { modelId: model.id, port, baseUrl, modelPath: path.join(MODELS_DIR, model.id) };
  startPromise = waitReady(baseUrl, child, 180000).then(() => {
    touch();
    return current;
  });
  try {
    return await startPromise;
  } catch (err) {
    stop();
    throw err;
  }
}

module.exports = {
  PLATFORM_SUPPORTED,
  LOCAL_LLM_MODELS,
  MODELS_DIR,
  PYTHON_BIN,
  VENV_DIR,
  getStatus,
  isRuntimeInstalled,
  isModelInstalled,
  listInstalledModels,
  ensureRunning,
  stop
};

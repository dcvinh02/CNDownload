/**
 * Local LLM Qwen3.5-9B — không cần API Key, không gửi dữ liệu ra ngoài. Hai bộ chạy, cùng API chuẩn OpenAI:
 *
 * - macOS chip Apple: `mlx_lm server` (Apple MLX) trong môi trường riêng `.venv-llm`, model MLX 4-bit.
 * - Windows 10/11 (x64/arm64): `llama-server.exe` (llama.cpp bản chính thức, Vulkan — dùng GPU NVIDIA/AMD/Intel
 *   nếu có, tự chạy CPU nếu không), model GGUF Q4_K_M. Không cần cài gì vào hệ thống, mọi thứ nằm trong thư mục dự án.
 *
 * Chung: khởi động khi cần, tự tắt sau IDLE_MS; chỉ nghe 127.0.0.1, cổng ngẫu nhiên; tắt chế độ "thinking";
 * chạy qua llm_server_wrapper.py để máy chủ tự tắt khi ứng dụng thoát (không để tiến trình mồ côi).
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const VENV_DIR = path.join(PROJECT_ROOT, '.venv-llm');
const PYTHON_BIN = path.join(VENV_DIR, 'bin', 'python3');
// Windows: wrapper chạy bằng Python lõi (.venv) đã có sẵn cho ASR/TTS
const CORE_PYTHON = path.join(PROJECT_ROOT, '.venv', IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python3');
const MODELS_DIR = path.join(PROJECT_ROOT, 'bin', 'models', 'llm');
const IDLE_MS = 8 * 60 * 1000;
const WRAPPER = path.join(__dirname, 'llm_server_wrapper.py');

/** Bộ chạy theo máy: 'mlx' (Mac chip Apple), 'llamacpp' (Windows), null (chưa hỗ trợ). */
const BACKEND =
  process.platform === 'darwin' && process.arch === 'arm64'
    ? 'mlx'
    : IS_WIN && (process.arch === 'x64' || process.arch === 'arm64')
      ? 'llamacpp'
      : null;
const PLATFORM_SUPPORTED = Boolean(BACKEND);

/** llama.cpp bản chính thức đã ghim (GitHub Releases ggml-org/llama.cpp), kiểm tra SHA-256 khi tải. */
const LLAMA_CPP = {
  build: 'b12387',
  assets: {
    x64: { name: 'llama-b12387-bin-win-vulkan-x64.zip', sha256: '68462280e0801af67a5a02617cf155a0fa8018fd5f805b2285157b771c10da12', sizeMB: 36 },
    arm64: { name: 'llama-b12387-bin-win-vulkan-arm64.zip', sha256: 'd82aab38a46ebaeb174e85487febbc7774da57538adb94c82d57861b674145d1', sizeMB: 24 }
  }
};
LLAMA_CPP.dir = path.join(PROJECT_ROOT, 'bin', 'tools', 'llama.cpp', LLAMA_CPP.build);
LLAMA_CPP.serverBin = path.join(LLAMA_CPP.dir, IS_WIN ? 'llama-server.exe' : 'llama-server');
LLAMA_CPP.asset = LLAMA_CPP.assets[process.arch] || null;
LLAMA_CPP.url = LLAMA_CPP.asset ? `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP.build}/${LLAMA_CPP.asset.name}` : '';

// Chỉ giữ model đã được đánh giá tốt nhất cho dịch Trung → Việt (xem BAO_CAO_NANG_CAP.md, mục đánh giá Qwen).
// Qwen3.5-4B (sai nghĩa, hay sót chữ Hán) và Qwen2.5-7B (chép nguyên câu nguồn) đã bị loại sau kiểm thử.
const ALL_MODELS = [
  {
    id: 'Qwen3.5-9B-MLX-4bit',
    backend: 'mlx',
    repo: 'mlx-community/Qwen3.5-9B-MLX-4bit',
    label: 'Qwen3.5 9B (MLX 4-bit)',
    sizeGB: 5.6,
    ramGB: 6,
    thinking: true
  },
  {
    id: 'Qwen3.5-9B-Q4_K_M-GGUF',
    backend: 'llamacpp',
    repo: 'unsloth/Qwen3.5-9B-GGUF',
    revision: '3885219b6810b007914f3a7950a8d1b469d598a5',
    file: 'Qwen3.5-9B-Q4_K_M.gguf',
    sizeBytes: 5680522464,
    sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
    label: 'Qwen3.5 9B (GGUF Q4_K_M • llama.cpp)',
    sizeGB: 5.7,
    ramGB: 8,
    thinking: true
  }
];
const LOCAL_LLM_MODELS = ALL_MODELS.filter((m) => m.backend === BACKEND);

let proc = null;
let current = null; // { modelId, port, baseUrl }
let startPromise = null;
let idleTimer = null;
let lastStderr = '';

function isRuntimeInstalled() {
  if (BACKEND === 'mlx') return fs.existsSync(PYTHON_BIN) && fs.existsSync(path.join(VENV_DIR, 'lib'));
  if (BACKEND === 'llamacpp') return fs.existsSync(LLAMA_CPP.serverBin) && fs.existsSync(CORE_PYTHON);
  return false;
}

function modelFilePath(model) {
  return model.file ? path.join(MODELS_DIR, model.id, model.file) : path.join(MODELS_DIR, model.id);
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
  const spec = ALL_MODELS.find((m) => m.id === modelId);
  if (spec && spec.file) {
    // GGUF: 1 file duy nhất, đủ kích thước (SHA-256 đã kiểm khi tải)
    try {
      return fs.statSync(path.join(dir, spec.file)).size === spec.sizeBytes;
    } catch (_) {
      return false;
    }
  }
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
    backend: BACKEND,
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

function buildServerCommand(model, port) {
  if (BACKEND === 'llamacpp') {
    const args = [
      WRAPPER,
      '--exec', LLAMA_CPP.serverBin,
      '-m', modelFilePath(model),
      '--host', '127.0.0.1',
      '--port', String(port),
      '-c', '12288',
      '-np', '1',
      '--cors-origins', 'localhost',
      '--no-webui'
    ];
    if (model.thinking) args.push('--chat-template-kwargs', JSON.stringify({ enable_thinking: false }));
    return { bin: CORE_PYTHON, args, env: { ...process.env, PYTHONUTF8: '1' } };
  }
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
  return { bin: PYTHON_BIN, args, env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' } };
}

/**
 * Đảm bảo máy chủ đang chạy đúng model. Trả về { baseUrl, modelId }.
 */
async function ensureRunning(modelId) {
  if (!PLATFORM_SUPPORTED) {
    throw new Error('AI Local Qwen chưa hỗ trợ máy này (cần Mac chip Apple hoặc Windows 10/11).');
  }
  if (!isRuntimeInstalled()) {
    throw new Error('Chưa cài bộ chạy AI Local. Mở trình cài công cụ → "AI dịch Local (Qwen3.5 9B)".');
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
  const cmd = buildServerCommand(model, port);
  lastStderr = '';
  // stdin là pipe giữ mở: Node chết -> pipe đóng -> wrapper tự tắt máy chủ (không để tiến trình mồ côi)
  const child = spawn(cmd.bin, cmd.args, { stdio: ['pipe', 'ignore', 'pipe'], env: cmd.env, windowsHide: true });
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
  current = { modelId: model.id, port, baseUrl, modelPath: modelFilePath(model) };
  // Nạp 5–6 GB từ ổ cứng: SSD ~10–30 s, HDD có thể vài phút
  startPromise = waitReady(baseUrl, child, 360000).then(() => {
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
  BACKEND,
  PLATFORM_SUPPORTED,
  LLAMA_CPP,
  LOCAL_LLM_MODELS,
  ALL_MODELS,
  CORE_PYTHON,
  modelFilePath,
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

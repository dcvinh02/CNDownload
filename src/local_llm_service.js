/**
 * Local LLM Qwen3.5-9B — không cần API Key, không gửi dữ liệu ra ngoài. Hai bộ chạy, cùng API chuẩn OpenAI:
 *
 * - macOS chip Apple: `mlx_lm server` (Apple MLX) trong môi trường riêng `.venv-llm`, model MLX 4-bit.
 * - Windows 10/11 (x64/arm64): `llama-server.exe` (llama.cpp bản chính thức, Vulkan — dùng GPU NVIDIA/AMD/Intel
 *   nếu có, tự chạy CPU nếu không), model GGUF Q4_K_M. Cài vào THƯ MỤC DÙNG CHUNG của người dùng
 *   `%USERPROFILE%\QwenLocal` (có file mô tả `qwen-local.json`) để các ứng dụng khác tìm và dùng lại, không tải trùng.
 *
 * Chung: khởi động khi cần, tự tắt sau IDLE_MS; chỉ nghe 127.0.0.1, cổng ngẫu nhiên; tắt chế độ "thinking";
 * chạy qua llm_server_wrapper.py để máy chủ tự tắt khi ứng dụng thoát (không để tiến trình mồ côi).
 */

const fs = require('fs');
const os = require('os');
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
// Log máy chủ AI Local (không chứa API Key/văn bản dịch) để chẩn đoán lỗi khởi động
const SERVER_LOG = path.join(PROJECT_ROOT, 'config', 'llm_server.log');

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
/**
 * Windows: Qwen dùng chung cho mọi ứng dụng — %USERPROFILE%\QwenLocal (đổi được bằng biến môi trường QWEN_LOCAL_HOME).
 *   qwen-local.json          file mô tả (model, bộ chạy, tham số khuyên dùng, cách gọi API) — app khác đọc file này
 *   models\<file .gguf>      model
 *   llama.cpp\<build>\       bộ chạy llama-server.exe
 *   Start_Qwen_Server.bat    bật máy chủ API chuẩn OpenAI (http://127.0.0.1:8765/v1) cho app khác
 */
// Vị trí mặc định (ổ chứa thư mục người dùng) — file mô tả ở đây LUÔN có, kể cả khi Qwen được cài chỗ khác,
// để ứng dụng khác chỉ cần tìm %USERPROFILE%\QwenLocal\qwen-local.json rồi đọc trường "home".
const QWEN_DEFAULT_HOME = IS_WIN ? path.join(os.homedir(), 'QwenLocal') : null;
// Vị trí thay thế khi ổ C ít chỗ: trong thư mục ứng dụng (người dùng chọn lúc cài)
const QWEN_APP_HOME = IS_WIN ? path.join(PROJECT_ROOT, 'QwenLocal') : null;
const QWEN_DEFAULT_PORT = 8765;

function readManifestHome(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'qwen-local.json'), 'utf8'));
    return j && j.home && fs.existsSync(j.home) ? j.home : null;
  } catch (_) {
    return null;
  }
}

/** Thứ tự: biến môi trường QWEN_LOCAL_HOME → "home" trong %USERPROFILE%\QwenLocal\qwen-local.json → thư mục app (nếu đã cài ở đó) → mặc định. */
function resolveQwenHome() {
  if (!IS_WIN) return null;
  if (process.env.QWEN_LOCAL_HOME) return process.env.QWEN_LOCAL_HOME;
  return readManifestHome(QWEN_DEFAULT_HOME) || readManifestHome(QWEN_APP_HOME) || QWEN_DEFAULT_HOME;
}

let QWEN_HOME = null;
LLAMA_CPP.legacyDir = path.join(PROJECT_ROOT, 'bin', 'tools', 'llama.cpp', LLAMA_CPP.build);
/** Đặt vị trí Qwen (gọi khi người dùng chọn nơi cài). */
function setQwenHome(dir) {
  QWEN_HOME = dir;
  LLAMA_CPP.dir = IS_WIN && dir ? path.join(dir, 'llama.cpp', LLAMA_CPP.build) : LLAMA_CPP.legacyDir;
  LLAMA_CPP.serverBin = path.join(LLAMA_CPP.dir, IS_WIN ? 'llama-server.exe' : 'llama-server');
}
setQwenHome(resolveQwenHome());
LLAMA_CPP.asset = LLAMA_CPP.assets[process.arch] || null;
LLAMA_CPP.url = LLAMA_CPP.asset ? `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP.build}/${LLAMA_CPP.asset.name}` : '';

// Chỉ giữ model đã được đánh giá tốt nhất cho dịch Trung → Việt.
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

/** DLL Visual C++ 2015–2022 mà llama.cpp bản Windows cần (không có sẵn trong gói llama.cpp). */
const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

/** Windows: trả về danh sách DLL VC++ còn thiếu (tìm trong System32 và thư mục llama.cpp). */
function missingVcRuntime() {
  if (!IS_WIN) return [];
  const sys32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  return VC_RUNTIME_DLLS.filter(
    (d) => !fs.existsSync(path.join(sys32, d)) && !fs.existsSync(path.join(LLAMA_CPP.dir, d)) && !fs.existsSync(path.join(LLAMA_CPP.legacyDir, d))
  );
}

// Đã gặp crash do driver GPU/Vulkan → chạy CPU cho các lần sau trong phiên này
let llamaCpuOnly = false;

function isRuntimeInstalled() {
  if (BACKEND === 'mlx') return fs.existsSync(PYTHON_BIN) && fs.existsSync(path.join(VENV_DIR, 'lib'));
  if (BACKEND === 'llamacpp') return fs.existsSync(serverBinPath()) && fs.existsSync(CORE_PYTHON) && missingVcRuntime().length === 0;
  return false;
}

/** Thư mục chứa model: Windows (GGUF) → %USERPROFILE%\QwenLocal\models; Mac (MLX) → bin/models/llm/<id>. */
function modelDir(model) {
  return model && model.backend === 'llamacpp' && IS_WIN ? path.join(QWEN_HOME, 'models') : path.join(MODELS_DIR, model.id);
}

function modelFilePath(model) {
  return model.file ? path.join(modelDir(model), model.file) : modelDir(model);
}

/** Vị trí cũ (trong thư mục ứng dụng) của bản Qwen đã tải trước khi có thư mục dùng chung. */
function legacyModelFilePath(model) {
  return model.file ? path.join(MODELS_DIR, model.id, model.file) : null;
}

/** File model thực dùng: thư mục dùng chung; nếu chưa chuyển xong thì dùng tạm bản cũ trong thư mục ứng dụng. */
function resolveModelFile(model) {
  const p = modelFilePath(model);
  if (fs.existsSync(p)) return p;
  const old = legacyModelFilePath(model);
  return old && fs.existsSync(old) ? old : p;
}

/** llama-server.exe thực dùng (thư mục dùng chung, hoặc bản cũ khi chưa chuyển). */
function serverBinPath() {
  if (fs.existsSync(LLAMA_CPP.serverBin)) return LLAMA_CPP.serverBin;
  const old = path.join(LLAMA_CPP.legacyDir, IS_WIN ? 'llama-server.exe' : 'llama-server');
  return fs.existsSync(old) ? old : LLAMA_CPP.serverBin;
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
      return fs.statSync(resolveModelFile(spec)).size === spec.sizeBytes;
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
    currentModel: current ? current.modelId : null,
    sharedHome: QWEN_HOME,
    sharedManifest: QWEN_HOME && fs.existsSync(path.join(QWEN_HOME, 'qwen-local.json')) ? path.join(QWEN_HOME, 'qwen-local.json') : null
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
      // Đóng stdin → wrapper tự tắt máy chủ con đúng cách.
      p.stdin.end();
      // POSIX: SIGTERM được wrapper bắt để tắt máy chủ con. Windows: kill() = TerminateProcess ngay lập tức
      // (wrapper không kịp dọn) → chỉ dùng làm dự phòng sau 5 s; Job Object trong wrapper vẫn diệt máy chủ con.
      if (!IS_WIN) p.kill('SIGTERM');
    } catch (_) {}
    const t = setTimeout(() => {
      try {
        if (p.exitCode === null) p.kill(IS_WIN ? undefined : 'SIGKILL');
      } catch (_) {}
    }, IS_WIN ? 5000 : 4000);
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

/** Các dòng log có ích nhất khi máy chủ lỗi: ưu tiên dòng [wrapper]/error, bỏ dòng sập Python khi thoát. */
function usefulStderr() {
  const lines = lastStderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/Python runtime state|Current thread|<no Python frame>|Fatal Python error|_enter_buffered_busy/.test(l));
  const key = lines.filter((l) => /\[wrapper\]|error|failed|lỗi|vulkan|out of memory|cannot|unable/i.test(l));
  return (key.length ? key.slice(-3) : lines.slice(-3)).join(' | ') || 'không có log';
}

async function waitReady(baseUrl, child, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Máy chủ LLM local dừng khi khởi động: ${usefulStderr()}`);
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
      '--exec', serverBinPath(),
      '-m', resolveModelFile(model),
      '--host', '127.0.0.1',
      '--port', String(port),
      '-c', '12288',
      '-np', '1',
      '--cors-origins', 'localhost',
      '--no-webui'
    ];
    if (llamaCpuOnly) args.push('--device', 'none');
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
  const missingDll = missingVcRuntime();
  if (missingDll.length) {
    throw new Error(
      `Máy thiếu Microsoft Visual C++ Redistributable (${missingDll.join(', ')}) mà AI Local cần. Mở "Công cụ" → bấm cài lại "AI dịch Local Qwen3.5 9B" (tự cài bản chính thức của Microsoft), hoặc tải tại https://aka.ms/vs/17/release/vc_redist.x64.exe`
    );
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
  try {
    fs.mkdirSync(path.dirname(SERVER_LOG), { recursive: true });
    if (fs.existsSync(SERVER_LOG) && fs.statSync(SERVER_LOG).size > 2 * 1024 * 1024) fs.rmSync(SERVER_LOG, { force: true });
    fs.appendFileSync(SERVER_LOG, `\n[${new Date().toISOString()}] Khởi động ${model.id}${llamaCpuOnly ? ' (CPU)' : ''}\n`);
  } catch (_) {}
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const cmd = buildServerCommand(model, port);
  lastStderr = '';
  // stdin là pipe giữ mở: Node chết -> pipe đóng -> wrapper tự tắt máy chủ (không để tiến trình mồ côi)
  const child = spawn(cmd.bin, cmd.args, { stdio: ['pipe', 'ignore', 'pipe'], env: cmd.env, windowsHide: true });
  child.stderr.on('data', (d) => {
    lastStderr = (lastStderr + d.toString()).slice(-4000);
    try {
      fs.appendFileSync(SERVER_LOG, d);
    } catch (_) {}
  });
  child.on('close', () => {
    if (proc === child) {
      proc = null;
      current = null;
      startPromise = null;
    }
  });
  proc = child;
  current = { modelId: model.id, port, baseUrl, modelPath: resolveModelFile(model) };
  // Nạp 5–6 GB từ ổ cứng: SSD ~10–30 s, HDD có thể vài phút
  startPromise = waitReady(baseUrl, child, 360000).then(() => {
    touch();
    return current;
  });
  try {
    return await startPromise;
  } catch (err) {
    stop();
    // Bản Vulkan crash/không dùng được GPU (driver cũ, GPU không hỗ trợ) → thử lại 1 lần bằng CPU
    if (BACKEND === 'llamacpp' && !llamaCpuOnly && !/Visual C\+\+|0xC0000135|thiếu DLL/i.test(err.message)) {
      llamaCpuOnly = true;
      try {
        fs.appendFileSync(SERVER_LOG, `[${new Date().toISOString()}] GPU lỗi, chuyển sang CPU: ${err.message}\n`);
      } catch (_) {}
      return ensureRunning(model.id);
    }
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
  legacyModelFilePath,
  resolveModelFile,
  serverBinPath,
  QWEN_DEFAULT_HOME,
  QWEN_APP_HOME,
  QWEN_DEFAULT_PORT,
  setQwenHome,
  resolveQwenHome,
  missingVcRuntime,
  VC_RUNTIME_DLLS,
  SERVER_LOG,
  MODELS_DIR,
  PYTHON_BIN,
  VENV_DIR,
  getStatus,
  isRuntimeInstalled,
  isModelInstalled,
  listInstalledModels,
  ensureRunning,
  stop,
  _internals: { getProcess: () => proc }
};

// Vị trí Qwen có thể đổi khi người dùng chọn nơi cài → đọc động
Object.defineProperty(module.exports, 'QWEN_HOME', { enumerable: true, get: () => QWEN_HOME });
Object.defineProperty(module.exports, 'QWEN_MANIFEST', { enumerable: true, get: () => (QWEN_HOME ? path.join(QWEN_HOME, 'qwen-local.json') : null) });

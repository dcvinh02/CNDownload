/**
 * Quản lý môi trường Python đa nền tảng (macOS + Windows) cho các thành phần AI.
 *
 * - Dùng `uv` (Astral) để cài Python 3.12 độc lập + tạo môi trường ảo, không phụ thuộc Python của hệ thống.
 * - Tìm uv theo thứ tự: bản đã có trong bin/tools → uv trong PATH → cài bằng pip của một Python có sẵn
 *   (.venv hoặc Python hệ thống) → tải bản phát hành chính thức từ GitHub (astral-sh/uv) có kiểm tra SHA-256.
 * - Giải nén .tar.bz2/.zip bằng Python (tarfile/zipfile) để không phụ thuộc `tar`/`unzip` của hệ điều hành
 *   (Windows không có `unzip`, `tar` của Windows không phải bản nào cũng hỗ trợ bz2).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(PROJECT_ROOT, 'bin', 'tools');
const REQ_DIR = path.join(PROJECT_ROOT, 'requirements');
const PYTHON_VERSION = '3.12';

const VENVS = {
  core: path.join(PROJECT_ROOT, '.venv'),
  vieneu: path.join(PROJECT_ROOT, '.venv-vieneu'),
  llm: path.join(PROJECT_ROOT, '.venv-llm')
};

function venvPython(venvDir) {
  return path.join(venvDir, IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python3');
}

function uvEnv(extra = {}) {
  return {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: path.join(TOOLS_DIR, 'python'),
    UV_CACHE_DIR: path.join(TOOLS_DIR, 'uv-cache'),
    UV_PYTHON_PREFERENCE: 'only-managed',
    PYTHONIOENCODING: 'utf-8',
    HF_HUB_DISABLE_TELEMETRY: '1',
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
    ...extra
  };
}

function run(bin, args, { env, timeoutMs = 600000, cwd = PROJECT_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let tail = '';
    const onData = (d) => {
      tail = (tail + d.toString()).slice(-3000);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      reject(new Error(`${path.basename(bin)} quá thời gian chờ.`));
    }, timeoutMs);
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(tail);
      else reject(new Error(`${path.basename(bin)} ${args.slice(0, 2).join(' ')} lỗi (mã ${code}): ${tail.slice(-500)}`));
    });
  });
}

/* ------------------------------------ uv ------------------------------------ */

function uvCandidates() {
  const exe = IS_WIN ? 'uv.exe' : 'uv';
  return [
    path.join(TOOLS_DIR, 'uv', exe),
    path.join(TOOLS_DIR, 'uvpkg', 'bin', exe),
    path.join(TOOLS_DIR, 'uvpkg', 'Scripts', exe)
  ];
}

function findLocalUv() {
  return uvCandidates().find((p) => fs.existsSync(p)) || null;
}

async function findWorkingCommand(cands, args) {
  for (const c of cands) {
    try {
      await run(c[0], [...c.slice(1), ...args], { timeoutMs: 20000 });
      return c;
    } catch (_) {}
  }
  return null;
}

/** Tên file bản phát hành chính thức của uv cho máy hiện tại. */
function uvReleaseAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'arm64' ? 'uv-aarch64-pc-windows-msvc.zip' : 'uv-x86_64-pc-windows-msvc.zip';
  if (platform === 'darwin') return arch === 'arm64' ? 'uv-aarch64-apple-darwin.tar.gz' : 'uv-x86_64-apple-darwin.tar.gz';
  return arch === 'arm64' ? 'uv-aarch64-unknown-linux-gnu.tar.gz' : 'uv-x86_64-unknown-linux-gnu.tar.gz';
}

async function downloadToFile(url, dest) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf;
}

/**
 * Đảm bảo có uv. Trả về đường dẫn uv.
 * @param {(msg:string)=>void} onStep
 */
async function ensureUv(onStep = () => {}) {
  const local = findLocalUv();
  if (local) return local;

  const inPath = await findWorkingCommand([[IS_WIN ? 'uv.exe' : 'uv']], ['--version']);
  if (inPath) return inPath[0];

  // Cài bằng pip của một Python có sẵn (không cần quyền admin, cài vào bin/tools/uvpkg)
  const pyCands = [[venvPython(VENVS.core)], ...(IS_WIN ? [['py', '-3'], ['python']] : [['python3']])].filter(
    (c) => !path.isAbsolute(c[0]) || fs.existsSync(c[0])
  );
  const py = await findWorkingCommand(pyCands, ['-m', 'pip', '--version']);
  if (py) {
    onStep('Đang cài công cụ uv bằng pip (PyPI)...');
    await run(py[0], [...py.slice(1), '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--target', path.join(TOOLS_DIR, 'uvpkg'), 'uv'], {
      timeoutMs: 600000
    });
    const got = findLocalUv();
    if (got) return got;
  }

  // Tải bản phát hành chính thức + kiểm tra SHA-256
  const asset = uvReleaseAsset();
  const base = 'https://github.com/astral-sh/uv/releases/latest/download';
  onStep(`Đang tải uv chính thức (${asset}) từ GitHub astral-sh/uv...`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn_uv_'));
  try {
    const archive = path.join(tmp, asset);
    const buf = await downloadToFile(`${base}/${asset}`, archive);
    const shaText = Buffer.from(await (await fetch(`${base}/${asset}.sha256`, { redirect: 'follow' })).arrayBuffer()).toString('utf8');
    const expected = (shaText.match(/[a-f0-9]{64}/i) || [''])[0].toLowerCase();
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (!expected || expected !== actual) throw new Error('Mã SHA-256 của uv tải về không khớp bản phát hành chính thức — đã hủy.');
    const outDir = path.join(TOOLS_DIR, 'uv');
    fs.mkdirSync(outDir, { recursive: true });
    // Windows 10+ có sẵn tar.exe (bsdtar) giải nén được .zip; macOS/Linux dùng tar cho .tar.gz
    await run(IS_WIN ? 'tar.exe' : 'tar', ['-xf', archive, '-C', tmp], { timeoutMs: 120000 });
    const exe = IS_WIN ? 'uv.exe' : 'uv';
    const found = findFileRecursive(tmp, exe);
    if (!found) throw new Error('Không tìm thấy uv trong gói tải về.');
    fs.copyFileSync(found, path.join(outDir, exe));
    if (!IS_WIN) fs.chmodSync(path.join(outDir, exe), 0o755);
    return path.join(outDir, exe);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function findFileRecursive(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const f = findFileRecursive(full, name);
      if (f) return f;
    } else if (e.name === name) return full;
  }
  return null;
}

/* --------------------------------- Venv ---------------------------------- */

async function pythonImports(venvDir, modules) {
  const py = venvPython(venvDir);
  if (!fs.existsSync(py)) return false;
  try {
    await run(py, ['-c', modules.map((m) => `import ${m}`).join('; ')], { timeoutMs: 120000, env: uvEnv() });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Tạo (nếu cần) một môi trường ảo Python 3.12 và cài requirements.
 * Bỏ qua nếu môi trường đã import được các module kiểm tra (không cài lại môi trường đang chạy tốt).
 */
async function ensureVenv(kind, { requirements, checkModules, onStep = () => {}, sync = false }) {
  const venvDir = VENVS[kind];
  if (await pythonImports(venvDir, checkModules)) {
    // Môi trường đã có: đồng bộ lại đúng phiên bản trong requirements (sửa máy lỡ cài bản thư viện không tương thích)
    const uvExisting = findLocalUv();
    if (uvExisting && sync) {
      onStep(`Đang đồng bộ phiên bản thư viện của ${path.basename(venvDir)} theo requirements...`);
      await run(uvExisting, ['pip', 'install', '--only-binary', ':all:', '-r', path.join(REQ_DIR, requirements)], {
        env: uvEnv({ VIRTUAL_ENV: venvDir }),
        timeoutMs: 3600000
      });
    }
    return { venvDir, created: false };
  }
  const uv = await ensureUv(onStep);
  onStep(`Đang chuẩn bị Python ${PYTHON_VERSION} (bản độc lập, không ảnh hưởng Python của hệ thống)...`);
  await run(uv, ['python', 'install', PYTHON_VERSION], { env: uvEnv(), timeoutMs: 1800000 });
  if (!fs.existsSync(venvPython(venvDir))) {
    onStep(`Đang tạo môi trường ${path.basename(venvDir)}...`);
    await run(uv, ['venv', venvDir, '--python', PYTHON_VERSION], { env: uvEnv(), timeoutMs: 600000 });
  }
  onStep(`Đang cài thư viện cho ${path.basename(venvDir)} (chỉ dùng gói dựng sẵn, có thể mất vài phút)...`);
  await run(uv, ['pip', 'install', '--only-binary', ':all:', '-r', path.join(REQ_DIR, requirements)], {
    env: uvEnv({ VIRTUAL_ENV: venvDir }),
    timeoutMs: 3600000
  });
  try {
    await run(uv, ['cache', 'clean'], { env: uvEnv(), timeoutMs: 600000 });
  } catch (_) {}
  if (!(await pythonImports(venvDir, checkModules))) {
    throw new Error(`Đã cài ${path.basename(venvDir)} nhưng không import được: ${checkModules.join(', ')}.`);
  }
  return { venvDir, created: true };
}

const ensureCoreVenv = (onStep, opts = {}) =>
  ensureVenv('core', { requirements: 'core.txt', checkModules: ['faster_whisper', 'sherpa_onnx', 'ctranslate2', 'numpy'], onStep, sync: Boolean(opts.sync) });
const ensureVieneuVenv = (onStep) => ensureVenv('vieneu', { requirements: 'vieneu.txt', checkModules: ['vieneu'], onStep });
const ensureLlmVenv = (onStep) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return Promise.reject(new Error('AI Local (MLX) chỉ chạy trên Mac chip Apple. Trên Windows hãy dùng Gemini hoặc Ollama/LM Studio (API tương thích OpenAI).'));
  }
  return ensureVenv('llm', { requirements: 'llm-macos.txt', checkModules: ['mlx_lm'], onStep });
};

/* ------------------------------ Giải nén ------------------------------- */

/**
 * Giải nén .tar.bz2 / .tar.gz / .zip bằng Python của .venv (đa nền tảng, an toàn với đường dẫn).
 */
async function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const py = venvPython(VENVS.core);
  const script = [
    'import sys, os, tarfile, zipfile',
    'src, dst = sys.argv[1], os.path.abspath(sys.argv[2])',
    'def safe(name):',
    '    p = os.path.abspath(os.path.join(dst, name))',
    '    if not (p == dst or p.startswith(dst + os.sep)): raise SystemExit("đường dẫn không an toàn: " + name)',
    'if zipfile.is_zipfile(src):',
    '    z = zipfile.ZipFile(src)',
    '    [safe(n) for n in z.namelist()]',
    '    z.extractall(dst)',
    'else:',
    '    t = tarfile.open(src)',
    '    [safe(m.name) for m in t.getmembers()]',
    '    t.extractall(dst)'
  ].join('\n');
  if (fs.existsSync(py)) {
    return run(py, ['-c', script, archivePath, destDir], { timeoutMs: 1800000 });
  }
  // Chưa có .venv: dùng tar của hệ điều hành
  return run(IS_WIN ? 'tar.exe' : 'tar', ['-xf', archivePath, '-C', destDir], { timeoutMs: 1800000 });
}

module.exports = {
  IS_WIN,
  VENVS,
  PYTHON_VERSION,
  venvPython,
  uvEnv,
  run,
  findLocalUv,
  uvReleaseAsset,
  ensureUv,
  ensureVenv,
  ensureCoreVenv,
  ensureVieneuVenv,
  ensureLlmVenv,
  extractArchive,
  pythonImports
};

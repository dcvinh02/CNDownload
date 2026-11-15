/**
 * Windows: thư mục Qwen DÙNG CHUNG cho mọi ứng dụng — %USERPROFILE%\QwenLocal
 *
 * Ứng dụng khác chỉ cần tìm file  %USERPROFILE%\QwenLocal\qwen-local.json  (hoặc biến môi trường QWEN_LOCAL_HOME)
 * để biết đường dẫn model, bộ chạy và cách bật máy chủ API chuẩn OpenAI — không phải tải lại 5,7 GB.
 *
 * Module này:
 *  - chuyển bản Qwen đã tải trong thư mục ứng dụng (bản cũ) sang thư mục dùng chung (đổi tên nếu cùng ổ đĩa,
 *    khác ổ thì sao chép → kiểm kích thước → mới xóa bản cũ);
 *  - ghi qwen-local.json, Start_Qwen_Server.bat, README.txt;
 *  - tạo lối tắt "Qwen Local.lnk" trong thư mục ứng dụng trỏ tới thư mục dùng chung.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const localLlm = require('./local_llm_service');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const SHORTCUT_NAME = 'Qwen Local.lnk';
const home = () => localLlm.QWEN_HOME;

// Dung lượng: model 5,7 GB + bộ chạy + dư khi tải
const QWEN_NEED_BYTES = 6.2e9;
// Ổ C coi là "ít chỗ" nếu sau khi cài còn dưới 10 GB trống
const LOW_SPACE_MARGIN = 10e9;

function existingAncestor(p) {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

function freeBytes(p) {
  try {
    const st = fs.statfsSync(existingAncestor(p));
    return Number(st.bavail) * Number(st.bsize);
  } catch (_) {
    return null;
  }
}

/** Đã cài Qwen ở đâu chưa (vị trí đang dùng, mặc định, thư mục app hoặc bản cũ). */
function isQwenPresentAnywhere() {
  const m = ggufModel();
  if (!m) return false;
  const candidates = [localLlm.modelFilePath(m), localLlm.legacyModelFilePath(m)];
  for (const h of [localLlm.QWEN_DEFAULT_HOME, localLlm.QWEN_APP_HOME]) if (h) candidates.push(path.join(h, 'models', m.file));
  return candidates.some((f) => f && fs.existsSync(f));
}

/**
 * Quyết định thuần (để kiểm thử): có cần hỏi người dùng chọn nơi cài không, và nên đề xuất chỗ nào.
 * Chỉ hỏi khi ổ của thư mục người dùng ít chỗ VÀ thư mục ứng dụng nằm ở ổ khác.
 */
function decideLocation({ userFree, appFree, sameDrive, need = QWEN_NEED_BYTES, margin = LOW_SPACE_MARGIN }) {
  const userKnown = typeof userFree === 'number';
  const userLow = userKnown && userFree < need + margin;
  const userTooSmall = userKnown && userFree < need + 1e9;
  const appOk = typeof appFree === 'number' ? appFree >= need + 1e9 : true;
  if (!userLow || sameDrive) return { ask: false, choice: 'user', userLow, userTooSmall, appOk };
  return { ask: true, recommended: appOk ? 'app' : 'user', userLow, userTooSmall, appOk };
}

/** Đánh giá dung lượng thật trên máy. */
function assessLocation() {
  if (!IS_WIN) return { ask: false, choice: null };
  const userHome = localLlm.QWEN_DEFAULT_HOME;
  const appHome = localLlm.QWEN_APP_HOME;
  // QWEN_TEST_USER_FREE_BYTES: chỉ dùng trong kiểm thử để giả lập ổ C ít chỗ
  const userFree = process.env.QWEN_TEST_USER_FREE_BYTES ? Number(process.env.QWEN_TEST_USER_FREE_BYTES) : freeBytes(userHome);
  const appFree = freeBytes(appHome);
  const sameDrive = path.parse(path.resolve(userHome)).root.toLowerCase() === path.parse(path.resolve(appHome)).root.toLowerCase();
  const d = decideLocation({ userFree, appFree, sameDrive });
  const explicit = Boolean(process.env.QWEN_LOCAL_HOME) || fs.existsSync(path.join(userHome, 'qwen-local.json'));
  return {
    ...d,
    ask: d.ask && !explicit && !isQwenPresentAnywhere(),
    userHome,
    appHome,
    userFree,
    appFree,
    sameDrive,
    needBytes: QWEN_NEED_BYTES,
    userDrive: path.parse(path.resolve(userHome)).root,
    appDrive: path.parse(path.resolve(appHome)).root
  };
}

/** Ghi file mô tả trỏ đường (chỉ trường "home") vào thư mục người dùng — để app khác vẫn tìm được Qwen. */
function writePointer(target) {
  const p = path.join(localLlm.QWEN_DEFAULT_HOME, 'qwen-local.json');
  fs.mkdirSync(localLlm.QWEN_DEFAULT_HOME, { recursive: true });
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}
  fs.writeFileSync(p, JSON.stringify({ ...prev, schema: 1, name: 'Qwen Local', home: target }, null, 2), 'utf8');
}

/** Chọn nơi cài: 'user' (%USERPROFILE%\QwenLocal) hoặc 'app' (<thư mục ứng dụng>\QwenLocal). */
function chooseLocation(choice) {
  if (!IS_WIN) return null;
  const target = choice === 'app' ? localLlm.QWEN_APP_HOME : localLlm.QWEN_DEFAULT_HOME;
  fs.mkdirSync(target, { recursive: true });
  localLlm.setQwenHome(target);
  writePointer(target);
  return target;
}

function ggufModel() {
  return localLlm.ALL_MODELS.find((m) => m.backend === 'llamacpp');
}

/** Chuyển file/thư mục sang chỗ mới an toàn: đổi tên (cùng ổ đĩa), khác ổ → sao chép, kiểm kích thước, rồi xóa bản gốc. */
async function moveSafely(src, dest, { forceCopy = false } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!forceCopy) {
    try {
      fs.renameSync(src, dest);
      return 'rename';
    } catch (e) {
      if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e;
    }
  }
  const st = fs.statSync(src);
  const tmp = `${dest}.dang-chuyen`;
  fs.rmSync(tmp, { recursive: true, force: true });
  if (st.isDirectory()) {
    fs.cpSync(src, tmp, { recursive: true });
  } else {
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src);
      const ws = fs.createWriteStream(tmp);
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
    if (fs.statSync(tmp).size !== st.size) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Sao chép ${path.basename(src)} không đủ dung lượng — giữ nguyên bản cũ.`);
    }
  }
  fs.renameSync(tmp, dest);
  fs.rmSync(src, { recursive: true, force: true });
  return 'copy';
}

let migrating = null;
/** Chuyển bản Qwen cũ (trong thư mục ứng dụng) sang thư mục dùng chung — không tải lại. */
function migrateLegacy(log = () => {}) {
  if (!IS_WIN || !home()) return Promise.resolve({ moved: [] });
  if (migrating) return migrating;
  migrating = (async () => {
    const moved = [];
    const m = ggufModel();
    // Bản cũ trong thư mục app + ổ C ít chỗ (khác ổ với app) → giữ trên cùng ổ với app (đổi chỗ tức thì), không chép 5,7 GB sang C
    const legacyThere = m && fs.existsSync(localLlm.legacyModelFilePath(m));
    if (legacyThere && !process.env.QWEN_LOCAL_HOME && !fs.existsSync(path.join(localLlm.QWEN_DEFAULT_HOME, 'qwen-local.json'))) {
      const userFree = freeBytes(localLlm.QWEN_DEFAULT_HOME);
      const appFree = freeBytes(localLlm.QWEN_APP_HOME);
      const sameDrive = path.parse(path.resolve(localLlm.QWEN_DEFAULT_HOME)).root.toLowerCase() === path.parse(path.resolve(localLlm.QWEN_APP_HOME)).root.toLowerCase();
      const d = decideLocation({ userFree, appFree, sameDrive });
      if (d.ask) {
        chooseLocation('app');
        log(`Ổ ${path.parse(localLlm.QWEN_DEFAULT_HOME).root} chỉ còn ${(userFree / 1e9).toFixed(1)} GB trống → giữ Qwen trong thư mục ứng dụng (${localLlm.QWEN_APP_HOME}); app khác vẫn tìm được qua ${path.join(localLlm.QWEN_DEFAULT_HOME, 'qwen-local.json')}.`);
      } else {
        chooseLocation('user');
      }
    }
    const oldModel = m && localLlm.legacyModelFilePath(m);
    const newModel = m && localLlm.modelFilePath(m);
    if (oldModel && fs.existsSync(oldModel) && !fs.existsSync(newModel)) {
      if (fs.statSync(oldModel).size === m.sizeBytes) {
        log(`Đang chuyển model Qwen (${(m.sizeBytes / 1e9).toFixed(1)} GB) sang ${home()}...`);
        const how = await moveSafely(oldModel, newModel);
        moved.push(`model (${how === 'rename' ? 'đổi chỗ tức thì' : 'sao chép khác ổ đĩa'})`);
        try {
          fs.rmSync(path.dirname(oldModel), { recursive: true, force: true });
        } catch (_) {}
      }
    }
    const lc = localLlm.LLAMA_CPP;
    if (fs.existsSync(path.join(lc.legacyDir, 'llama-server.exe')) && !fs.existsSync(lc.serverBin)) {
      log('Đang chuyển bộ chạy llama.cpp sang thư mục dùng chung...');
      await moveSafely(lc.legacyDir, lc.dir);
      moved.push('llama.cpp');
    }
    return { moved };
  })().finally(() => {
    migrating = null;
  });
  return migrating;
}

function rel(p) {
  return path.relative(home(), p).split(path.sep).join('\\');
}

/** Ghi file mô tả + file bật máy chủ + hướng dẫn trong thư mục dùng chung (chỉ khi đã cài đủ). */
function writeHomeFiles() {
  const QWEN_HOME = home();
  if (!IS_WIN || !QWEN_HOME) return null;
  const m = ggufModel();
  const lc = localLlm.LLAMA_CPP;
  if (!m || !fs.existsSync(localLlm.modelFilePath(m)) || !fs.existsSync(lc.serverBin)) return null;
  fs.mkdirSync(QWEN_HOME, { recursive: true });
  const serverArgs = ['-m', rel(localLlm.modelFilePath(m)), '--host', '127.0.0.1', '--port', String(localLlm.QWEN_DEFAULT_PORT), '-c', '12288', '-np', '1', '--no-webui', '--chat-template-kwargs', '{"enable_thinking":false}'];
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(localLlm.QWEN_MANIFEST, 'utf8'));
  } catch (_) {}
  const manifest = {
    schema: 1,
    name: 'Qwen Local',
    description: 'Qwen3.5 9B chạy trên máy (llama.cpp) — dùng chung cho mọi ứng dụng. Các đường dẫn file là tương đối so với "home".',
    home: QWEN_HOME,
    model: {
      id: m.id,
      label: m.label,
      file: rel(localLlm.modelFilePath(m)),
      format: 'GGUF Q4_K_M',
      sizeBytes: m.sizeBytes,
      sha256: m.sha256,
      source: `https://huggingface.co/${m.repo} (revision ${m.revision})`
    },
    runtime: {
      engine: 'llama.cpp',
      build: lc.build,
      server: rel(lc.serverBin),
      requires: 'Microsoft Visual C++ Redistributable 2015–2022'
    },
    server: {
      start: 'Start_Qwen_Server.bat',
      defaultPort: localLlm.QWEN_DEFAULT_PORT,
      args: serverArgs,
      api: `OpenAI-compatible: POST http://127.0.0.1:${localLlm.QWEN_DEFAULT_PORT}/v1/chat/completions`,
      notes: 'Tắt chế độ suy nghĩ (enable_thinking=false) để trả lời nhanh. Chỉ nghe 127.0.0.1.'
    },
    installedBy: prev.installedBy || 'CN Video Scraper Pro',
    installedAt: prev.installedAt || new Date().toISOString(),
    usedBy: Array.from(new Set([...(Array.isArray(prev.usedBy) ? prev.usedBy : []), PROJECT_ROOT]))
  };
  fs.writeFileSync(localLlm.QWEN_MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
  // Qwen cài ngoài thư mục người dùng → bản sao file mô tả ở %USERPROFILE%\QwenLocal để app khác vẫn tìm thấy
  if (path.resolve(QWEN_HOME).toLowerCase() !== path.resolve(localLlm.QWEN_DEFAULT_HOME).toLowerCase()) {
    fs.mkdirSync(localLlm.QWEN_DEFAULT_HOME, { recursive: true });
    fs.writeFileSync(path.join(localLlm.QWEN_DEFAULT_HOME, 'qwen-local.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }

  const q = (a) => (/[\s"{}]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const bat = [
    '@echo off',
    'chcp 65001 >nul',
    'title Qwen Local - may chu AI tren may',
    'cd /d "%~dp0"',
    'set PORT=%1',
    `if "%PORT%"=="" set PORT=${localLlm.QWEN_DEFAULT_PORT}`,
    'echo ============================================================',
    'echo  Qwen Local - API chuan OpenAI: http://127.0.0.1:%PORT%/v1',
    'echo  Dong cua so nay de tat may chu.',
    'echo ============================================================',
    `${q(rel(lc.serverBin))} ${serverArgs.map((a) => (a === String(localLlm.QWEN_DEFAULT_PORT) ? '%PORT%' : q(a))).join(' ')}`,
    'pause',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(QWEN_HOME, 'Start_Qwen_Server.bat'), bat, 'utf8');

  const readme = [
    'QWEN LOCAL — mô hình AI Qwen3.5 9B dùng chung trên máy này',
    '',
    `Thư mục: ${QWEN_HOME}`,
    `(File mô tả luôn có ở %USERPROFILE%\\QwenLocal\\qwen-local.json — trường "home" là thư mục thật.)`,
    'File mô tả cho ứng dụng khác: qwen-local.json (model, bộ chạy, tham số, địa chỉ API).',
    '',
    'Cách dùng từ ứng dụng khác:',
    `  1. Đọc %USERPROFILE%\\QwenLocal\\qwen-local.json, lấy trường "home" (hoặc biến môi trường QWEN_LOCAL_HOME nếu có).`,
    '  2. Chạy Start_Qwen_Server.bat (hoặc chạy "server" + "args" trong file mô tả).',
    `  3. Gọi API chuẩn OpenAI: POST http://127.0.0.1:${localLlm.QWEN_DEFAULT_PORT}/v1/chat/completions`,
    '',
    'Không xóa thư mục này nếu còn ứng dụng dùng Qwen (danh sách trong "usedBy" của qwen-local.json).',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(QWEN_HOME, 'README.txt'), readme, 'utf8');
  return manifest;
}

/** Lối tắt "Qwen Local.lnk" trong thư mục ứng dụng trỏ tới thư mục dùng chung. */
function ensureAppShortcut(timeoutMs = 30000) {
  const QWEN_HOME = home();
  if (!IS_WIN || !QWEN_HOME || !fs.existsSync(QWEN_HOME)) return Promise.resolve(false);
  const lnk = path.join(PROJECT_ROOT, SHORTCUT_NAME);
  // Qwen đã nằm ngay trong thư mục ứng dụng (thư mục "QwenLocal") → không cần lối tắt
  const relToApp = path.relative(PROJECT_ROOT, QWEN_HOME);
  if (!relToApp.startsWith('..') && !path.isAbsolute(relToApp)) {
    try {
      fs.rmSync(lnk, { force: true });
    } catch (_) {}
    return Promise.resolve(true);
  }
  const esc = (s) => s.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${esc(lnk)}')`,
    `$s.TargetPath = '${esc(QWEN_HOME)}'`,
    "$s.Description = 'Qwen Local - mo hinh AI dung chung cho moi ung dung'",
    '$s.Save()'
  ].join('; ');
  const env = { ...process.env };
  delete env.PSModulePath; // PowerShell 5.1 không nạp nhầm module của PowerShell 7
  return new Promise((resolve) => {
    let done = false;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env, windowsHide: true });
    const t = setTimeout(() => {
      try {
        p.kill();
      } catch (_) {}
    }, timeoutMs);
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(ok && fs.existsSync(lnk));
    };
    p.on('error', () => finish(false));
    p.on('close', (code) => finish(code === 0));
  });
}

/** Gọi khi khởi động app / sau khi cài: chuyển bản cũ, ghi file mô tả, tạo lối tắt. Không bao giờ ném lỗi. */
async function ensureSharedHome(log = () => {}) {
  if (!IS_WIN) return { ok: false, reason: 'not-windows' };
  try {
    const mig = await migrateLegacy(log);
    const manifest = writeHomeFiles();
    const shortcut = manifest ? await ensureAppShortcut() : false;
    if (mig.moved.length) log(`Đã chuyển sang ${home()}: ${mig.moved.join(', ')}.`);
    return { ok: Boolean(manifest), home: home(), moved: mig.moved, shortcut };
  } catch (e) {
    log(`Không hoàn tất thư mục Qwen dùng chung: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  SHORTCUT_NAME,
  QWEN_NEED_BYTES,
  LOW_SPACE_MARGIN,
  freeBytes,
  decideLocation,
  assessLocation,
  chooseLocation,
  moveSafely,
  migrateLegacy,
  writeHomeFiles,
  ensureAppShortcut,
  ensureSharedHome
};

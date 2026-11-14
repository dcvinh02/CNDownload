/**
 * Quản lý Cấu hình Đường dẫn Lưu trữ Riêng cho Từng Nền tảng (macOS & Windows)
 * Mặc định: <Thư mục gốc>/Tên_Nền_Tảng/
 * Cho phép thay đổi Thư mục gốc hoặc tùy chỉnh đường dẫn riêng cho từng nền tảng trong 12 nền tảng.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PLATFORMS } = require('./extractors/platforms');

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const DEFAULT_ROOT_DIR = path.join(PROJECT_ROOT, 'downloads');

function getConfigFile() {
  return process.env.CN_STORAGE_CONFIG_FILE || path.join(CONFIG_DIR, 'storage_settings.json');
}

function getEffectiveDefaultRootDir() {
  return process.env.CN_DEFAULT_DOWNLOAD_DIR || DEFAULT_ROOT_DIR;
}

const PLATFORM_FOLDER_NAMES = {
  douyin: 'Douyin',
  kuaishou: 'Kuaishou',
  pipixia: 'Pipixia',
  youku: 'Youku',
  tencent: 'TencentVideo',
  iqiyi: 'iQIYI',
  mangotv: 'MangoTV',
  wetv: 'WeTV',
  bilibili: 'Bilibili',
  xigua: 'XiguaVideo',
  xiaohongshu: 'Xiaohongshu',
  jianying: 'Jianying'
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadSettings() {
  const cfgFile = getConfigFile();
  ensureDir(path.dirname(cfgFile));
  let saved = {};
  if (fs.existsSync(cfgFile)) {
    try {
      saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch {
      saved = {};
    }
  }

  const rootDir = saved.rootDir && typeof saved.rootDir === 'string' ? saved.rootDir : getEffectiveDefaultRootDir();
  const customPlatformDirs = saved.customPlatformDirs && typeof saved.customPlatformDirs === 'object'
    ? saved.customPlatformDirs
    : {};

  // Đảm bảo thư mục gốc và các thư mục con của 12 nền tảng được khởi tạo sẵn
  ensureDir(rootDir);
  for (const pid of Object.keys(PLATFORMS)) {
    const folderName = PLATFORM_FOLDER_NAMES[pid] || pid;
    const effectiveDir = customPlatformDirs[pid] || path.join(rootDir, folderName);
    try {
      ensureDir(effectiveDir);
    } catch {}
  }

  return {
    rootDir,
    customPlatformDirs
  };
}

function saveSettings(newSettings) {
  const cfgFile = getConfigFile();
  ensureDir(path.dirname(cfgFile));
  const current = loadSettings();
  const updated = {
    rootDir: newSettings.rootDir || current.rootDir,
    customPlatformDirs: {
      ...current.customPlatformDirs,
      ...(newSettings.customPlatformDirs || {})
    }
  };

  // Nếu người dùng truyền null hoặc chuỗi rỗng cho 1 nền tảng -> xóa custom để quay về mặc định <rootDir>/<FolderName>
  for (const [k, v] of Object.entries(updated.customPlatformDirs)) {
    if (!v || typeof v !== 'string' || !v.trim()) {
      delete updated.customPlatformDirs[k];
    } else {
      updated.customPlatformDirs[k] = path.resolve(v.trim());
      try { ensureDir(updated.customPlatformDirs[k]); } catch {}
    }
  }

  updated.rootDir = path.resolve(updated.rootDir);
  try { ensureDir(updated.rootDir); } catch {}

  fs.writeFileSync(cfgFile, JSON.stringify(updated, null, 2), 'utf8');
  return getStorageOverview();
}

/**
 * Lấy đường dẫn lưu thực tế của 1 nền tảng cụ thể
 */
function getPlatformDownloadDir(platformId) {
  const settings = loadSettings();
  const pid = PLATFORMS[platformId] ? platformId : 'douyin';
  const folderName = PLATFORM_FOLDER_NAMES[pid] || pid;
  const targetDir = settings.customPlatformDirs[pid] || path.join(settings.rootDir, folderName);
  ensureDir(targetDir);
  return targetDir;
}

/**
 * Trả về thông tin đầy đủ đường dẫn của tất cả 12 nền tảng cho giao diện
 */
function getStorageOverview() {
  const settings = loadSettings();
  const platformsStorage = {};

  for (const [pid, cfg] of Object.entries(PLATFORMS)) {
    const folderName = PLATFORM_FOLDER_NAMES[pid] || pid;
    const defaultDir = path.join(settings.rootDir, folderName);
    const customDir = settings.customPlatformDirs[pid] || null;
    const effectiveDir = customDir || defaultDir;
    try { ensureDir(effectiveDir); } catch {}

    platformsStorage[pid] = {
      platformId: pid,
      platformName: cfg.name,
      folderName,
      defaultDir,
      customDir,
      effectiveDir,
      isCustom: Boolean(customDir)
    };
  }

  return {
    rootDir: settings.rootDir,
    defaultRootDir: DEFAULT_ROOT_DIR,
    platforms: platformsStorage
  };
}

/**
 * Mở hộp thoại chọn thư mục gốc của Hệ điều hành (macOS Finder & Windows Explorer)
 */
function pickNativeFolderDialog(promptText = 'Chọn thư mục lưu video') {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      const script = `POSIX path of (choose folder with prompt "${promptText.replace(/"/g, '\\"')}")`;
      const proc = spawn('osascript', ['-e', script]);
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.on('close', (code) => {
        const chosen = out.trim();
        if (code === 0 && chosen) {
          resolve(chosen.replace(/\/+$/, '') || '/');
        } else {
          resolve(null);
        }
      });
    } else if (process.platform === 'win32') {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms;
        $f = New-Object System.Windows.Forms.FolderBrowserDialog;
        $f.Description = '${promptText.replace(/'/g, "''")}';
        $f.ShowNewFolderButton = $true;
        if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }
      `;
      const proc = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript]);
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.on('close', (code) => {
        const chosen = out.trim();
        if (code === 0 && chosen) {
          resolve(chosen);
        } else {
          resolve(null);
        }
      });
    } else {
      resolve(null);
    }
  });
}

/**
 * Mở thư mục hoặc hiển thị file trong Finder (macOS) / Explorer (Windows)
 */
function openInSystemExplorer(targetPath) {
  if (!targetPath) return false;
  const exists = fs.existsSync(targetPath);
  const isFile = exists && fs.statSync(targetPath).isFile();

  if (process.platform === 'darwin') {
    const args = isFile ? ['-R', targetPath] : [targetPath];
    spawn('open', args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } else if (process.platform === 'win32') {
    const winPath = path.resolve(targetPath);
    const args = isFile ? [`/select,${winPath}`] : [winPath];
    spawn('explorer.exe', args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } else {
    const dir = isFile ? path.dirname(targetPath) : targetPath;
    spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
}

/**
 * Mở hộp thoại chọn file video gốc của Hệ điều hành (macOS Finder & Windows Explorer)
 */
function pickNativeFileDialog(promptText = 'Chọn file video cần chuyển đổi định dạng') {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      const script = `POSIX path of (choose file with prompt "${promptText.replace(/"/g, '\\"')}")`;
      const proc = spawn('osascript', ['-e', script]);
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.on('close', (code) => {
        const chosen = out.trim();
        if (code === 0 && chosen) {
          resolve(chosen);
        } else {
          resolve(null);
        }
      });
    } else if (process.platform === 'win32') {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms;
        $f = New-Object System.Windows.Forms.OpenFileDialog;
        $f.Title = '${promptText.replace(/'/g, "''")}';
        $f.Filter = 'Video & Audio Files|*.mp4;*.mov;*.mkv;*.webm;*.avi;*.flv;*.m4s;*.ts;*.mp3;*.wav|All Files|*.*';
        if ($f.ShowDialog() -eq 'OK') { Write-Output $f.FileName }
      `;
      const proc = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript]);
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.on('close', (code) => {
        const chosen = out.trim();
        if (code === 0 && chosen) {
          resolve(chosen);
        } else {
          resolve(null);
        }
      });
    } else {
      resolve(null);
    }
  });
}

module.exports = {
  DEFAULT_ROOT_DIR,
  PLATFORM_FOLDER_NAMES,
  loadSettings,
  saveSettings,
  getPlatformDownloadDir,
  getStorageOverview,
  pickNativeFolderDialog,
  pickNativeFileDialog,
  openInSystemExplorer
};

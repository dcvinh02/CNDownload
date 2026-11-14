/**
 * Cross-Platform Desktop App Launcher (Hỗ trợ cả macOS & Windows)
 * - Trên macOS: Chạy ứng dụng Native Cocoa/WebKit (./bin/CNVideoScraperApp) hoặc mở giao diện Web nội bộ
 * - Trên Windows: Tự động kiểm tra/tải yt-dlp.exe, khởi chạy Backend Server, tự xử lý xung đột cổng và mở cửa sổ Native App Mode (Edge / Chrome WebView)
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createServer } = require('./server');

const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_PORT = parseInt(process.env.PORT || '3889', 10);

async function ensureWindowsYtDlp() {
  if (process.platform !== 'win32') return;
  const binDir = path.join(ROOT_DIR, 'bin');
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
  const exePath = path.join(binDir, 'yt-dlp.exe');
  if (fs.existsSync(exePath)) return;

  console.log('[Windows Setup] Đang tải tự động yt-dlp.exe cho Windows...');
  try {
    const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(exePath, buf);
      console.log('[Windows Setup] Đã cài đặt thành công bin/yt-dlp.exe!');
    }
  } catch (err) {
    console.warn('[Windows Setup] Không thể tải tự động yt-dlp.exe:', err.message);
  }
}

function launchWindowsAppWindow(url, onWindowClose) {
  const candidates = [
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];
  // Hồ sơ trình duyệt RIÊNG cho cửa sổ ứng dụng: nếu dùng hồ sơ mặc định mà Edge/Chrome đang chạy (Windows 10/11 bật
  // "Startup boost" nên Edge gần như luôn chạy ngầm), tiến trình mới chỉ chuyển yêu cầu cho Edge cũ rồi THOÁT NGAY —
  // ứng dụng tưởng cửa sổ đã đóng và tắt máy chủ. Hồ sơ riêng buộc mở 1 tiến trình sống đúng bằng vòng đời cửa sổ.
  const profileDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CNVideoScraperPro', 'app-window');
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (_) {}

  for (const bin of candidates) {
    if (bin && fs.existsSync(bin)) {
      const startedAt = Date.now();
      const proc = spawn(
        bin,
        [`--app=${url}`, '--window-size=1360,860', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'],
        { detached: false, stdio: 'ignore' }
      );
      proc.on('error', () => {});
      proc.on('close', () => {
        // Phòng hờ: tiến trình thoát quá nhanh (< 5 s) nghĩa là đã chuyển cho trình duyệt khác chứ không phải người dùng
        // đóng cửa sổ → giữ máy chủ chạy, người dùng tắt bằng cách đóng cửa sổ dòng lệnh.
        if (Date.now() - startedAt < 5000) {
          console.log(`[CN Video Downloader] Giao diện đang mở trong trình duyệt: ${url}`);
          console.log('[CN Video Downloader] Đóng cửa sổ dòng lệnh này để tắt ứng dụng.');
          return;
        }
        if (typeof onWindowClose === 'function') onWindowClose();
      });
      return;
    }
  }

  // Fallback mở trình duyệt mặc định trên Windows
  const fallback = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
  fallback.on('error', () => {});
  fallback.unref();
  console.log(`[CN Video Downloader] Giao diện đang mở trong trình duyệt: ${url} — đóng cửa sổ dòng lệnh này để tắt ứng dụng.`);
}

function listenWithFallbackPort(app, preferredPort) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(preferredPort, '127.0.0.1', () => {
      const actualPort = srv.address().port;
      resolve({ server: srv, port: actualPort, reusedExisting: false });
    });
    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Thử kết nối vào server đang chạy hoặc cấp cổng động
        const srvFallback = app.listen(0, '127.0.0.1', () => {
          resolve({ server: srvFallback, port: srvFallback.address().port, reusedExisting: false });
        });
        srvFallback.on('error', reject);
      } else {
        reject(err);
      }
    });
  });
}

async function checkExistingServer(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(400)
    });
    if (res.ok) {
      return true;
    }
  } catch (_) {}
  return false;
}

async function main() {
  const isServerAlreadyRunning = await checkExistingServer(DEFAULT_PORT);

  if (process.platform === 'darwin' && process.env.CN_FORCE_NODE_LAUNCHER !== '1') {
    const macAppBin = path.join(ROOT_DIR, 'bin', 'CNVideoScraperApp');
    if (fs.existsSync(macAppBin)) {
      try {
        fs.accessSync(macAppBin, fs.constants.X_OK);
        const proc = spawn(macAppBin, [ROOT_DIR], { stdio: 'inherit' });
        proc.on('error', (err) => {
          console.error('[macOS App] Lỗi khởi chạy binary:', err.message);
        });
        proc.on('close', (code) => process.exit(code || 0));
        return;
      } catch {}
    }
  }

  await ensureWindowsYtDlp();

  if (isServerAlreadyRunning) {
    const appUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
    console.log(`[CN Video Downloader] Server đã chạy sẵn từ trước tại ${appUrl}. Đang mở giao diện...`);
    if (process.platform === 'win32') {
      launchWindowsAppWindow(appUrl, () => process.exit(0));
    } else if (process.platform === 'darwin') {
      const p = spawn('open', [appUrl], { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    } else {
      const p = spawn('xdg-open', [appUrl], { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    }
    return;
  }

  const app = createServer();
  const { server, port } = await listenWithFallbackPort(app, DEFAULT_PORT);
  const appUrl = `http://127.0.0.1:${port}`;
  console.log(`[CN Video Downloader] Desktop Server running at ${appUrl}`);

  const gracefulShutdown = () => {
    try {
      server.close(() => process.exit(0));
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  if (process.platform === 'win32') {
    launchWindowsAppWindow(appUrl, gracefulShutdown);
  } else if (process.platform === 'darwin') {
    const p = spawn('open', [appUrl], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } else {
    const p = spawn('xdg-open', [appUrl], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Launcher error:', err);
    process.exit(1);
  });
}

module.exports = { listenWithFallbackPort, ensureWindowsYtDlp };

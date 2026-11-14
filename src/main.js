/**
 * Electron Main Process - Khởi chạy Desktop App Cào & Tải Video 12 Nền tảng Trung Quốc
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { createServer } = require('./server');

let mainWindow = null;
let serverInstance = null;
const PORT = 3889;

function startEmbeddedServer() {
  return new Promise((resolve) => {
    const expressApp = createServer();
    serverInstance = expressApp.listen(PORT, '127.0.0.1', () => {
      console.log(`[Desktop App] Embedded Backend started at http://127.0.0.1:${PORT}`);
      resolve(`http://127.0.0.1:${PORT}`);
    });
    serverInstance.on('error', () => {
      // Nếu cổng đã được mở bởi tiến trình server khác thì kết nối trực tiếp
      resolve(`http://127.0.0.1:${PORT}`);
    });
  });
}

async function createWindow() {
  const appUrl = await startEmbeddedServer();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1080,
    minHeight: 720,
    title: 'CN Video Scraper & Downloader Pro — 12 Nền tảng Video Trung Quốc',
    backgroundColor: '#0b0f19',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(appUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (serverInstance) {
    try { serverInstance.close(); } catch {}
  }
  app.quit();
});

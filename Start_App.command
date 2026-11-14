#!/bin/zsh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "⚠️  Chưa cài Node.js 20+. Tải tại https://nodejs.org"; read -k1; exit 1
fi
if [ ! -d node_modules/express ]; then
  echo "📦 Lần đầu chạy: đang cài thư viện Node..."
  npm install --omit=dev --no-audit --no-fund || { read -k1; exit 1; }
fi
if ! node scripts/setup.js --check >/dev/null 2>&1; then
  echo "🧩 Đang cài thành phần AI còn thiếu (chỉ lần đầu, cần Internet)..."
  node scripts/setup.js --yes || { read -k1; exit 1; }
fi
pkill -f "src/server.js" 2>/dev/null || true
pkill -f "bin/CNVideoScraperApp" 2>/dev/null || true
echo "🚀 Đang khởi động CN Video Downloader..."
npm start

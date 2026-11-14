#!/usr/bin/env node
/**
 * Đóng gói để chia sẻ qua Google Drive / USB:
 *
 *   node scripts/pack.js            → dist/CNVideoScraperPro-source-<version>.zip   (chỉ mã nguồn, vài MB)
 *   node scripts/pack.js --models   → dist/CNVideoScraperPro-models-<ngày>.zip      (thư mục bin/models, tùy chọn)
 *   node scripts/pack.js --models --no-llm   (bỏ model Qwen 5,6 GB — vô dụng trên Windows)
 *
 * Máy nhận: giải nén gói mã nguồn → (tùy chọn) giải nén gói model vào thư mục dự án → chạy
 * Start_App_Windows.bat (Windows) hoặc `npm install --omit=dev && npm run setup` (macOS).
 * Thành phần đã có trong gói model sẽ được setup bỏ qua, không tải lại.
 *
 * Gói model được tạo bằng cách "giải" mọi symlink (cache HuggingFace trên macOS dùng symlink, Windows không
 * giải nén được) và bỏ thư mục blobs/.cache trùng lặp — nên dùng được trên cả Windows và macOS.
 * Môi trường Python (.venv*) KHÔNG được đóng gói vì phụ thuộc hệ điều hành và đường dẫn tuyệt đối.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
const args = new Set(process.argv.slice(2));
const IS_WIN = process.platform === 'win32';
const TAR = IS_WIN ? 'tar.exe' : 'tar';
const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, { recursive: true });
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

function sourceFiles() {
  // Đúng tập file sẽ lên GitHub: file đang track + file mới, trừ mọi thứ khớp .gitignore
  const run = (a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean);
  const ignored = new Set(run(['ls-files', '-ci', '--exclude-standard']));
  return Array.from(new Set(run(['ls-files', '-co', '--exclude-standard']))).filter((f) => !ignored.has(f) && fs.existsSync(f));
}

function zipFromList(outZip, files, { dereference = false } = {}) {
  const listFile = path.join(DIST, '.filelist.txt');
  fs.writeFileSync(listFile, files.join('\n'));
  if (fs.existsSync(outZip)) fs.unlinkSync(outZip);
  // bsdtar (có sẵn trên macOS và Windows 10+) tạo được file .zip
  const tarArgs = ['-a', '-c', '-f', outZip, ...(dereference ? ['-h'] : []), '-T', listFile];
  const r = spawnSync(TAR, tarArgs, { stdio: 'inherit' });
  fs.unlinkSync(listFile);
  if (r.status !== 0) throw new Error(`Đóng gói thất bại (mã ${r.status}).`);
  return outZip;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full);
    // Bỏ phần trùng/lặt vặt: blobs của cache HF (snapshots đã chứa file thật sau khi giải symlink), .cache, .locks
    if (/(^|[\\/])(blobs|\.cache|\.locks|xet)([\\/]|$)/.test(rel) || e.name === '.DS_Store') continue;
    if (e.isDirectory() || (e.isSymbolicLink() && fs.statSync(full).isDirectory())) walk(full, out);
    else out.push(rel.split(path.sep).join('/'));
  }
  return out;
}

if (args.has('--models')) {
  const modelsDir = path.join(ROOT, 'bin', 'models');
  if (!fs.existsSync(modelsDir)) throw new Error('Chưa có bin/models để đóng gói.');
  let files = walk(modelsDir);
  if (args.has('--no-llm')) files = files.filter((f) => !f.startsWith('bin/models/llm/'));
  const stamp = new Date().toISOString().slice(0, 10);
  const out = path.join(DIST, `CNVideoScraperPro-models-${stamp}${args.has('--no-llm') ? '-no-llm' : ''}.zip`);
  console.log(`Đóng gói ${files.length} file model (giải symlink)...`);
  zipFromList(out, files, { dereference: true });
  console.log(`✅ ${path.relative(ROOT, out)} — ${(fs.statSync(out).size / 1024 / 1024).toFixed(0)} MB`);
} else {
  const files = sourceFiles();
  const out = path.join(DIST, `CNVideoScraperPro-source-${version}.zip`);
  zipFromList(out, files);
  console.log(`✅ ${path.relative(ROOT, out)} — ${files.length} file, ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
}

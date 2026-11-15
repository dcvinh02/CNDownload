#!/usr/bin/env node
/**
 * Cài đặt các thành phần cần thiết sau khi tải mã nguồn (GitHub/Drive) — chạy được trên Windows 10/11 x64 và macOS.
 *
 *   node scripts/setup.js              # gói "core": đủ để tải video + lồng tiếng (hỏi xác nhận trước khi tải)
 *   node scripts/setup.js --full       # macOS: thêm AI dịch Local Qwen3.5 9B (MLX, ~5,6 GB)
 *   node scripts/setup.js --no-llm     # Windows: bỏ AI dịch Local Qwen3.5 9B (mặc định có, ~5,8 GB) — dùng Gemini thay thế
 *   node scripts/setup.js --yes        # không hỏi lại
 *   node scripts/setup.js --check      # chỉ kiểm tra, không tải gì (mã thoát 1 nếu thiếu thành phần bắt buộc)
 *
 * Mọi thành phần tải từ nguồn chính thức (PyPI, GitHub Releases, HuggingFace) qua cùng trình cài của ứng dụng
 * (src/tool_installer.js), có kiểm tra sau khi cài. Thành phần đã có sẵn (vd. copy thư mục bin/models từ Drive) sẽ được bỏ qua.
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');

process.chdir(path.resolve(__dirname, '..'));

const args = new Set(process.argv.slice(2));
const FULL = args.has('--full') || args.has('--profile=full');
const YES = args.has('--yes') || args.has('-y');
const CHECK_ONLY = args.has('--check');
const NO_LLM = args.has('--no-llm');
// Nơi cài Qwen trên Windows: --qwen-dir=user (%USERPROFILE%\QwenLocal) | --qwen-dir=app (thư mục ứng dụng)
const QWEN_DIR_ARG = (Array.from(args).find((a) => a.startsWith('--qwen-dir=')) || '').split('=')[1] || null;
const os = require('os');

const IS_MAC_ARM = process.platform === 'darwin' && process.arch === 'arm64';

function plan() {
  const core = [
    { id: 'pythonCore', why: 'Môi trường Python AI (bắt buộc)' },
    { id: 'ytdlp', why: 'Tải video' },
    { id: 'ffmpeg', why: 'Xử lý âm thanh/video (thường đã có qua npm ffmpeg-static)' },
    { id: 'localAsrSmall', why: 'Nhận dạng giọng nói' },
    { id: 'speakerDiarization', why: 'Nhận diện người nói' },
    { id: 'voiceSeparation', why: 'Tách giọng gốc khỏi nhạc nền' },
    { id: 'vieneuTts', why: 'Giọng đọc tiếng Việt VieNeu (mặc định)' },
    { id: 'localTts', why: 'Giọng đọc Piper (dự phòng, nhẹ)' }
  ];
  if (process.platform === 'darwin') core.push({ id: 'webkitSniffer', why: 'Quét Douyin/Kuaishou (cần Xcode Command Line Tools)', optional: true });
  // Dịch Offline: chỉ cài Qwen3.5 9B — bản tốt nhất đã kiểm nghiệm. Argos, Qwen3.5-4B, Qwen2.5-7B, Whisper tiny/base
  // đã bị loại vì chất lượng kém (đã kiểm thử) nên KHÔNG cài tự động.
  if (process.platform === 'win32') {
    if (!NO_LLM) core.push({ id: 'localLlmQwen', why: 'AI dịch Local Qwen3.5 9B — dịch Trung→Việt ngay trên máy, không cần API Key' });
  } else if (IS_MAC_ARM && FULL) {
    core.push({ id: 'localLlmQwen', why: 'AI dịch Local Qwen3.5 9B (~5,6 GB)' });
  }
  return core;
}

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });
}

async function waitJob(installer, jobId, label) {
  let last = '';
  for (;;) {
    const job = installer.getToolInstallJob(jobId);
    const line = `   [${String(job.progress).padStart(3)}%] ${job.step}`;
    if (line !== last) {
      console.log(line.slice(0, 200));
      last = line;
    }
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`\n=== CN Video Scraper Pro — Cài đặt (${process.platform} ${process.arch}, Node ${process.versions.node}) ===\n`);
  if (major < 20) {
    console.error('❌ Cần Node.js 20 trở lên: https://nodejs.org');
    process.exit(1);
  }
  if (process.platform === 'win32' && process.cwd().length > 60) {
    console.log(`⚠️  Thư mục dự án nằm khá sâu (${process.cwd().length} ký tự): ${process.cwd()}`);
    console.log('   Windows giới hạn đường dẫn 260 ký tự; một số thư viện Python có đường dẫn rất dài. Nếu cài lỗi,');
    console.log('   hãy chuyển thư mục về đường dẫn ngắn (vd. C:\\CNVideo) hoặc bật "Enable Win32 long paths".\n');
  }
  const ramGB = os.totalmem() / 1024 ** 3;
  if (process.platform === 'win32' && !NO_LLM && ramGB < 15) {
    console.log(`⚠️  Máy có ${ramGB.toFixed(1)} GB RAM. Qwen3.5 9B cần ~8 GB RAM trống — máy dưới 16 GB sẽ dịch chậm.`);
    console.log('   Có thể bỏ qua bằng:  node scripts/setup.js --no-llm   (rồi dùng Gemini miễn phí qua AI Studio)\n');
  }
  if (!fs.existsSync(path.join('node_modules', 'express'))) {
    console.error('❌ Chưa cài thư viện Node. Hãy chạy trước:  npm install --omit=dev');
    process.exit(1);
  }

  const installer = require('../src/tool_installer');
  const catalog = new Map(installer.getInstallableToolsCatalog().map((t) => [t.id, t]));
  // Kiểm tra sâu môi trường Python (giải mã âm thanh thật) — phát hiện thư viện cài sai phiên bản
  const py = catalog.get('pythonCore');
  if (py && py.installed) {
    const v = await installer.verifyInstalledToolOrModel('pythonCore');
    if (!v.ok) {
      console.log(`⚠️  ${v.error}`);
      catalog.set('pythonCore', { ...py, installed: false });
    }
  }
  const items = plan().filter((p) => catalog.has(p.id));
  const missing = items.filter((p) => !catalog.get(p.id).installed);

  for (const p of items) {
    const t = catalog.get(p.id);
    console.log(`${t.installed ? '✅' : p.optional ? '➖' : '⬜'} ${t.name}${t.installed ? '' : `  (~${t.estimatedSizeMB} MB)`} — ${p.why}`);
  }
  if (missing.length === 0) {
    console.log('\n🎉 Tất cả thành phần đã sẵn sàng. Chạy ứng dụng: npm start  (Windows: Start_App_Windows.bat)');
    return;
  }
  const required = missing.filter((p) => !p.optional);
  if (CHECK_ONLY) {
    console.log(`\nThiếu ${missing.length} thành phần (${required.length} bắt buộc). Chạy: node scripts/setup.js`);
    process.exit(required.length ? 1 : 0);
  }
  const totalMB = missing.reduce((m, p) => m + (catalog.get(p.id).estimatedSizeMB || 0), 0);
  console.log(`\nSẽ tải & cài ${missing.length} thành phần (~${(totalMB / 1024).toFixed(1)} GB) từ nguồn chính thức.`);
  if (!YES) {
    const a = await ask('Tiếp tục? [Y/n] ');
    if (a && !['y', 'yes', 'c', 'co', 'có'].includes(a)) {
      console.log('Đã hủy.');
      return;
    }
  }

  // Windows: ổ chứa thư mục người dùng (thường là C) ít chỗ → hỏi nơi cài Qwen (~6 GB)
  let qwenLocation = QWEN_DIR_ARG === 'user' || QWEN_DIR_ARG === 'app' ? QWEN_DIR_ARG : null;
  if (process.platform === 'win32' && missing.some((p) => p.id === 'localLlmQwen') && !qwenLocation) {
    const qh = require('../src/qwen_shared_home');
    const a = qh.assessLocation();
    if (a.ask) {
      const gb = (b) => (typeof b === 'number' ? (b / 1e9).toFixed(1) : '?');
      console.log(`\n⚠️  Ổ ${a.userDrive} chỉ còn ${gb(a.userFree)} GB trống. AI dịch Local Qwen cần khoảng 6 GB.`);
      console.log(`   [1] Cài vào ổ ${a.userDrive}: ${a.userHome}   (dùng chung cho mọi ứng dụng)${a.userTooSmall ? '  — KHÔNG ĐỦ CHỖ' : ''}`);
      console.log(`   [2] Cài vào thư mục ứng dụng: ${a.appHome}   (ổ ${a.appDrive}, còn ${gb(a.appFree)} GB)`);
      console.log(`   Dù chọn [2], ứng dụng khác vẫn tìm được Qwen qua ${a.userHome}\\qwen-local.json (file rất nhỏ).`);
      if (process.stdin.isTTY) {
        const def = a.recommended === 'user' ? '1' : '2';
        const ans = await ask(`   Chọn [1/2] (Enter = ${def}): `);
        qwenLocation = (ans || def) === '1' ? 'user' : 'app';
      } else {
        qwenLocation = a.recommended || 'app';
        console.log(`   (Không có cửa sổ để hỏi → tự chọn ${qwenLocation === 'app' ? '[2] thư mục ứng dụng' : '[1]'}.)`);
      }
      console.log(`   → Cài Qwen vào: ${qwenLocation === 'app' ? a.appHome : a.userHome}`);
    }
  }

  const failed = [];
  for (const p of missing) {
    const t = catalog.get(p.id);
    // Kiểm tra lại: có thể đã đủ sau khi bước trước cài môi trường Python (model copy sẵn từ gói Drive)
    const fresh = installer.getInstallableToolsCatalog().find((x) => x.id === p.id);
    if (fresh && fresh.installed) {
      console.log(`\n✅ ${t.name} — đã có sẵn, bỏ qua`);
      continue;
    }
    console.log(`\n▶ ${t.name}`);
    try {
      const job = installer.startToolInstallJob({ toolId: p.id, userConfirmed: true, qwenLocation: p.id === 'localLlmQwen' ? qwenLocation : null });
      const done = await waitJob(installer, job.id, t.name);
      if (done.status === 'completed') console.log(`   ✅ ${done.verifiedVersion || 'Đã cài'}`);
      else {
        console.log(`   ❌ ${done.error}`);
        (done.remediationSteps || []).forEach((r) => console.log(`      • ${r}`));
        failed.push(p);
      }
    } catch (err) {
      console.log(`   ❌ ${err.message}`);
      failed.push(p);
    }
  }
  try {
    require('../src/vieneu_service').stop();
    require('../src/local_llm_service').stop();
  } catch (_) {}

  const failedRequired = failed.filter((p) => !p.optional);
  console.log('\n========================================');
  if (failed.length === 0) console.log('🎉 Cài đặt hoàn tất. Chạy ứng dụng: npm start  (Windows: Start_App_Windows.bat)');
  else console.log(`⚠️  ${failed.length} thành phần lỗi (${failedRequired.length} bắt buộc): ${failed.map((p) => p.id).join(', ')}. Có thể chạy lại lệnh này để thử tiếp.`);
  process.exit(failedRequired.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌', err && err.stack ? err.stack : err);
  process.exit(1);
});

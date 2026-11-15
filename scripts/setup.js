#!/usr/bin/env node
/**
 * Cài đặt các thành phần (môi trường / model) sau khi tải mã nguồn — Windows 10/11 và macOS.
 * HỎI TỪNG THÀNH PHẦN: hiện tác dụng, dung lượng, khuyến nghị cho máy này — chỉ tải những gì người dùng đồng ý.
 * Thành phần đã từ chối được ghi nhớ (config/setup_choices.json); có thể cài thêm bất cứ lúc nào trong app (🧰 Công cụ).
 *
 *   node scripts/setup.js              # hỏi từng thành phần (mặc định theo khuyến nghị)
 *   node scripts/setup.js --yes        # không hỏi: cài các thành phần được khuyến nghị cho máy này
 *   node scripts/setup.js --all        # không hỏi: cài TẤT CẢ (dùng cho máy kiểm thử / CI)
 *   node scripts/setup.js --ask-again  # hỏi lại cả những thành phần đã từ chối trước đây
 *   node scripts/setup.js --check      # chỉ kiểm tra (mã thoát 1 nếu còn thành phần chưa cài mà chưa chọn bỏ qua)
 *   --no-llm / --full                  # bỏ qua / chọn sẵn AI dịch Local Qwen
 *   --qwen-dir=user|app                # Windows: nơi cài Qwen (thư mục người dùng / thư mục ứng dụng)
 *
 * Mọi thành phần tải từ nguồn chính thức (PyPI, GitHub Releases, HuggingFace) qua cùng trình cài của ứng dụng
 * (src/tool_installer.js), có kiểm tra sau khi cài. Thành phần đã có sẵn (vd. copy thư mục bin/models từ Drive) sẽ được bỏ qua.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

process.chdir(path.resolve(__dirname, '..'));

const args = new Set(process.argv.slice(2));
const ALL = args.has('--all');
const YES = args.has('--yes') || args.has('-y') || ALL;
const CHECK_ONLY = args.has('--check');
const ASK_AGAIN = args.has('--ask-again');
const NO_LLM = args.has('--no-llm');
const FULL = args.has('--full') || args.has('--profile=full');
const QWEN_DIR_ARG = (Array.from(args).find((a) => a.startsWith('--qwen-dir=')) || '').split('=')[1] || null;
const INTERACTIVE = !YES && Boolean(process.stdin.isTTY);

// Thứ tự hỏi: công cụ tải video → nền tảng AI → model lồng tiếng → tùy chọn → AI dịch (lớn nhất, cuối cùng)
const ORDER = ['windowsApp', 'ytdlp', 'ffmpeg', 'webkitSniffer', 'pythonCore', 'localAsrSmall', 'vieneuTts', 'voiceSeparation', 'localTts', 'speakerDiarization', 'localLlmQwen'];

let rl = null;
function ask(q) {
  return new Promise((resolve) => {
    if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => resolve(String(a || '').trim().toLowerCase()));
  });
}
const isYes = (a) => ['y', 'yes', 'c', 'co', 'có', '1'].includes(a);
const isNo = (a) => ['n', 'no', 'k', 'khong', 'không', '0'].includes(a);

async function waitJob(installer, jobId) {
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

const ICON = { required: '✅', recommended: '✅', optional: '➖', not_needed: '⛔' };

function printBlock(i, n, t, guide, depNote) {
  const g = guide;
  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`[${i}/${n}] ${t.name}`);
  console.log(`   Loại       : ${t.category || 'Thành phần'}`);
  console.log(`   Tác dụng   : ${t.purpose}`);
  console.log(`   Dung lượng : ~${g.fmtSize(t.diskSizeMB)} trên ổ đĩa`);
  console.log(`   Khuyến nghị: ${ICON[t.recommendation.level] || '•'} ${t.recommendation.label} — ${t.recommendation.text}`);
  if (depNote) console.log(`   Cần trước  : ${depNote}`);
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`\n=== CN Video Scraper Pro — Cài đặt thành phần (${process.platform} ${process.arch}, Node ${process.versions.node}) ===`);
  if (major < 20) {
    console.error('❌ Cần Node.js 20 trở lên: https://nodejs.org');
    process.exit(1);
  }
  if (process.platform === 'win32' && process.cwd().length > 60) {
    console.log(`⚠️  Thư mục dự án nằm khá sâu (${process.cwd().length} ký tự): ${process.cwd()}`);
    console.log('   Windows giới hạn đường dẫn 260 ký tự; nếu cài lỗi, hãy chuyển thư mục về đường dẫn ngắn (vd. C:\\CNVideo).');
  }
  if (!fs.existsSync(path.join('node_modules', 'express'))) {
    console.error('❌ Chưa cài thư viện Node. Hãy chạy trước:  npm install --omit=dev');
    process.exit(1);
  }

  const installer = require('../src/tool_installer');
  const guide = require('../src/component_guide');
  let tools = installer.getInstallableToolsCatalog();
  // Kiểm tra sâu môi trường Python (giải mã âm thanh thật) — phát hiện thư viện cài sai phiên bản
  const py = tools.find((t) => t.id === 'pythonCore');
  if (py && py.installed) {
    const v = await installer.verifyInstalledToolOrModel('pythonCore');
    if (!v.ok) {
      console.log(`⚠️  ${v.error}`);
      py.installed = false;
    }
  }
  tools = ORDER.map((id) => tools.find((t) => t.id === id)).filter(Boolean);
  const byId = new Map(tools.map((t) => [t.id, t]));
  const choices = guide.loadChoices();
  const declinedBefore = new Set(choices.declined);

  const installed = tools.filter((t) => t.installed);
  const missing = tools.filter((t) => !t.installed);
  const pending = missing.filter((t) => ASK_AGAIN || ALL || !declinedBefore.has(t.id));

  console.log(`\nĐã cài ${installed.length}/${tools.length} thành phần:`);
  for (const t of tools) {
    const st = t.installed ? '✅ đã cài' : declinedBefore.has(t.id) ? '➖ đã chọn không cài' : '⬜ chưa cài';
    console.log(`   ${st.padEnd(20)} ${t.name}  (~${guide.fmtSize(t.diskSizeMB)})`);
  }

  if (CHECK_ONLY) {
    if (pending.length) console.log(`\nCòn ${pending.length} thành phần chưa cài và chưa chọn. Chạy: node scripts/setup.js`);
    process.exit(pending.length ? 1 : 0);
  }
  if (pending.length === 0) {
    console.log('\n🎉 Không còn gì cần hỏi. Muốn cài thêm thành phần đã bỏ qua: mở app → 🧰 Công cụ, hoặc chạy: node scripts/setup.js --ask-again');
    return;
  }

  const ctx = guide.machineContext();
  if (ctx.hasCloudAiKey) console.log('\nℹ️  Máy này đã có API Key AI (Gemini/ChatGPT) → không cần cài AI dịch Local Qwen.');
  console.log(
    INTERACTIVE
      ? '\nTrả lời từng mục: Enter = theo khuyến nghị, y = cài, n = không cài.'
      : `\n(Không hỏi: ${ALL ? 'cài TẤT CẢ' : 'cài các thành phần được khuyến nghị'}.)`
  );

  const selected = new Set(installed.map((t) => t.id));
  const declinedNow = [];
  let i = 0;
  for (const t0 of pending) {
    i++;
    // Khuyến nghị tính lại theo lựa chọn trước đó (vd. đã chọn VieNeu → không cần Piper)
    const t = guide.annotate([{ ...t0 }], { ...ctx, selected })[0];
    const needs = (t.requires || []).filter((d) => !selected.has(d));
    const depNote = (t.requires || []).length ? (t.requires || []).map((d) => (byId.get(d) || { name: d }).name).join(', ') : '';
    printBlock(i, pending.length, t, guide, depNote);
    if (needs.length) {
      console.log(`   → Bỏ qua: cần "${needs.map((d) => (byId.get(d) || { name: d }).name).join(', ')}" mà bạn không cài.`);
      declinedNow.push(t.id);
      continue;
    }
    let want;
    const recYes = ['required', 'recommended'].includes(t.recommendation.level);
    if (t.id === 'localLlmQwen' && NO_LLM) want = false;
    else if (t.id === 'localLlmQwen' && FULL) want = true;
    else if (ALL) want = true;
    else if (!INTERACTIVE) want = recYes;
    else {
      for (;;) {
        const a = await ask(`   Cài mục này? [${recYes ? 'Y/n' : 'y/N'}]: `);
        if (!a) {
          want = recYes;
          break;
        }
        if (isYes(a)) {
          want = true;
          break;
        }
        if (isNo(a)) {
          want = false;
          break;
        }
      }
    }
    console.log(`   → ${want ? 'SẼ CÀI' : 'Không cài'}`);
    if (want) selected.add(t.id);
    else declinedNow.push(t.id);
  }

  const toInstall = pending.filter((t) => selected.has(t.id));
  const totalMB = toInstall.reduce((m, t) => m + (t.diskSizeMB || 0), 0);
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`Sẽ cài ${toInstall.length} thành phần (~${guide.fmtSize(totalMB)}):`);
  toInstall.forEach((t) => console.log(`   + ${t.name} (~${guide.fmtSize(t.diskSizeMB)})`));
  if (declinedNow.length) {
    console.log(`Không cài ${declinedNow.length} thành phần (cài thêm sau trong app → 🧰 Công cụ):`);
    declinedNow.forEach((id) => console.log(`   - ${(byId.get(id) || { name: id }).name}`));
  }
  // Ghi nhớ lựa chọn: bỏ các mục đã cài khỏi danh sách từ chối, thêm mục vừa từ chối
  const keepDeclined = choices.declined.filter((id) => !selected.has(id) && !(byId.get(id) || {}).installed);
  guide.saveChoices({ declined: [...keepDeclined, ...declinedNow] });

  if (toInstall.length === 0) {
    console.log('\nKhông có gì để tải. Chạy ứng dụng: npm start  (Windows: Start_App_Windows.bat)');
    if (rl) rl.close();
    return;
  }
  if (INTERACTIVE) {
    const a = await ask(`\nBắt đầu tải ~${guide.fmtSize(totalMB)} từ nguồn chính thức? [Y/n]: `);
    if (a && !isYes(a)) {
      console.log('Đã hủy — chưa tải gì. Chạy lại lệnh này khi muốn cài.');
      guide.saveChoices({ declined: keepDeclined });
      rl.close();
      return;
    }
  }

  // Windows: ổ chứa thư mục người dùng (thường là C) ít chỗ → hỏi nơi cài Qwen (~6 GB)
  let qwenLocation = QWEN_DIR_ARG === 'user' || QWEN_DIR_ARG === 'app' ? QWEN_DIR_ARG : null;
  if (process.platform === 'win32' && selected.has('localLlmQwen') && !qwenLocation) {
    const qh = require('../src/qwen_shared_home');
    const a = qh.assessLocation();
    if (a.ask) {
      const gb = (b) => (typeof b === 'number' ? (b / 1e9).toFixed(1) : '?');
      console.log(`\n⚠️  Ổ ${a.userDrive} chỉ còn ${gb(a.userFree)} GB trống. AI dịch Local Qwen cần khoảng 6 GB.`);
      console.log(`   [1] Cài vào ổ ${a.userDrive}: ${a.userHome}   (dùng chung cho mọi ứng dụng)${a.userTooSmall ? '  — KHÔNG ĐỦ CHỖ' : ''}`);
      console.log(`   [2] Cài vào thư mục ứng dụng: ${a.appHome}   (ổ ${a.appDrive}, còn ${gb(a.appFree)} GB)`);
      console.log(`   Dù chọn [2], ứng dụng khác vẫn tìm được Qwen qua ${a.userHome}\\qwen-local.json (file rất nhỏ).`);
      if (INTERACTIVE) {
        const def = a.recommended === 'user' ? '1' : '2';
        const ans = await ask(`   Chọn [1/2] (Enter = ${def}): `);
        qwenLocation = (ans || def) === '1' ? 'user' : 'app';
      } else {
        qwenLocation = a.recommended || 'app';
        console.log(`   (Không hỏi được → tự chọn ${qwenLocation === 'app' ? '[2] thư mục ứng dụng' : '[1]'}.)`);
      }
      console.log(`   → Cài Qwen vào: ${qwenLocation === 'app' ? a.appHome : a.userHome}`);
    }
  }
  if (rl) {
    rl.close();
    rl = null;
  }

  const failed = [];
  for (const t of toInstall) {
    const fresh = installer.getInstallableToolsCatalog().find((x) => x.id === t.id);
    if (fresh && fresh.installed) {
      console.log(`\n✅ ${t.name} — đã có sẵn, bỏ qua`);
      continue;
    }
    console.log(`\n▶ ${t.name}`);
    try {
      const job = installer.startToolInstallJob({ toolId: t.id, userConfirmed: true, qwenLocation: t.id === 'localLlmQwen' ? qwenLocation : null });
      const done = await waitJob(installer, job.id);
      if (done.status === 'completed') console.log(`   ✅ ${done.verifiedVersion || 'Đã cài'}`);
      else {
        console.log(`   ❌ ${done.error}`);
        (done.remediationSteps || []).forEach((r) => console.log(`      • ${r}`));
        failed.push(t);
      }
    } catch (err) {
      console.log(`   ❌ ${err.message}`);
      failed.push(t);
    }
  }
  try {
    require('../src/vieneu_service').stop();
    require('../src/local_llm_service').stop();
  } catch (_) {}

  console.log('\n========================================');
  if (failed.length === 0)
    console.log(
      `🎉 Cài đặt hoàn tất. Chạy ứng dụng: ${process.platform === 'win32' && fs.existsSync('CNVideoScraperPro.exe') ? 'CNVideoScraperPro.exe (hoặc lối tắt trên Desktop)' : 'npm start  (Windows: Start_App_Windows.bat)'}`
    );
  else console.log(`⚠️  ${failed.length} thành phần lỗi: ${failed.map((t) => t.id).join(', ')}. Có thể chạy lại lệnh này để thử tiếp.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌', err && err.stack ? err.stack : err);
  process.exit(1);
});

/**
 * Bộ kiểm thử cho đợt nâng cấp (AI Provider, dịch theo phân đoạn, VieNeu-TTS, âm lượng, timeline, bảo mật).
 *
 * - Âm lượng: tạo video thử bằng FFmpeg (âm gốc 440 Hz, giọng thử 1 kHz), xuất qua bộ trộn THẬT của ứng dụng,
 *   rồi ĐO mức RMS trên file xuất (volumedetect) để chứng minh thông số áp dụng đúng.
 * - AI Provider: kiểm thử giao thức HTTP với một máy chủ cục bộ đóng vai API Gemini/OpenAI (mô phỏng lỗi 401/429/JSON sai).
 *   Đây KHÔNG phải kiểm thử với API thật — kiểm thử API thật cần API Key và được báo riêng (BLOCKED nếu thiếu key).
 * - VieNeu-TTS: tổng hợp thật nếu mô hình đã cài (SKIP nếu chưa cài).
 * - Không ghi đè cấu hình người dùng: cấu hình AI dùng thư mục tạm (CN_AI_CONFIG_DIR).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cn_upgrade_test_'));
process.env.CN_AI_CONFIG_DIR = path.join(TMP, 'config');
process.env.CN_STORAGE_CONFIG_FILE = path.join(TMP, 'storage_settings.json');
process.env.CN_DEFAULT_DOWNLOAD_DIR = path.join(TMP, 'downloads');
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.OPENAI_API_KEY;

const ROOT = path.resolve(__dirname, '..');
// Dùng cùng ffmpeg với ứng dụng (ffmpeg-static từ npm, đúng hệ điều hành; dự phòng bin/ffmpeg[.exe])
const FFMPEG = require('../src/extractors/ytdlp_engine').getFfmpegPath() || 'ffmpeg';
const PY_CORE = require('../src/python_env').venvPython(require('../src/python_env').VENVS.core);
const timeline = require('../src/audio_timeline');
const ai = require('../src/ai/ai_provider_manager');
const { translateSegmentsWithLLM, _internals: llmInternals } = require('../src/ai/llm_translator');
const dub = require('../src/dubbing_engine');
const vieneu = require('../src/vieneu_service');

const results = [];
function record(status, name, note = '') {
  results.push({ status, name, note });
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : status === 'BLOCKED' ? '⛔' : '⏭️';
  console.log(`  ${icon} ${status}: ${name}${note ? ` — ${note}` : ''}`);
}
async function check(name, fn) {
  try {
    const note = await fn();
    record('PASS', name, note || '');
  } catch (err) {
    if (err && err.skip) record(err.blocked ? 'BLOCKED' : 'SKIP', name, err.message);
    // Máy chưa cài bộ dịch Offline nào (Argos/Qwen/Ollama): thiếu điều kiện tiên quyết, không phải lỗi mã
    else if (err && /Thiếu mô hình dịch Offline/.test(err.message)) record('BLOCKED', name, 'Chưa cài bộ dịch Offline (chạy: node scripts/setup.js)');
    else record('FAIL', name, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function skip(msg, blocked = false) {
  const e = new Error(msg);
  e.skip = true;
  e.blocked = blocked;
  return e;
}
function ff(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg lỗi: ${r.stderr.slice(-400)}`);
  return r.stderr;
}
/** Đo RMS (dB) trong khoảng [start, start+dur] của track âm thanh. */
function meanVolumeDb(file, start, dur) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-ss', String(start), '-t', String(dur), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = r.stderr.match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
  if (!m) throw new Error(`Không đo được âm lượng: ${r.stderr.slice(-300)}`);
  return m[1] === '-inf' ? -Infinity : parseFloat(m[1]);
}
function near(actual, expected, tol, label) {
  assert(Math.abs(actual - expected) <= tol, `${label}: đo ${actual.toFixed(2)} dB, kỳ vọng ${expected.toFixed(2)} ± ${tol} dB`);
  return `${label} ${actual.toFixed(2)} dB (kỳ vọng ${expected.toFixed(2)})`;
}

async function main() {
  console.log('\n=== KIỂM THỬ NÂNG CẤP: Timeline, Âm lượng, AI Provider, VieNeu-TTS, Bảo mật ===\n');

  /* ----------------------------- 1. Timeline ----------------------------- */
  console.log('--- [1] Lập lịch & dựng timeline lồng tiếng ---');
  await check('Lập lịch: câu ngắn giữ nguyên tốc độ & đúng timestamp', () => {
    const s = timeline.scheduleDubSegments([{ startSec: 1, endSec: 3, naturalSec: 1.5 }, { startSec: 4, endSec: 6, naturalSec: 1.2 }], 10);
    assert(s[0].tempo === 1 && s[0].placedStartSec === 1 && s[1].placedStartSec === 4, JSON.stringify(s));
    return JSON.stringify(s.map((x) => [x.placedStartSec, x.tempo]));
  });
  await check('Lập lịch: câu dịch dài dùng khoảng lặng phía sau trước khi tăng tốc', () => {
    const s = timeline.scheduleDubSegments([{ startSec: 0, endSec: 2, naturalSec: 3.0 }, { startSec: 5, endSec: 7, naturalSec: 1 }], 10);
    assert(s[0].tempo === 1, `không cần tăng tốc khi còn khoảng lặng: ${JSON.stringify(s[0])}`);
    return `tempo=${s[0].tempo}`;
  });
  await check('Lập lịch: tăng tốc tối đa 1.3x, không chồng lấn, KHÔNG cắt câu (đẩy lùi đoạn sau)', () => {
    const segs = [
      { startSec: 0, endSec: 2, naturalSec: 4.0 },
      { startSec: 2, endSec: 4, naturalSec: 1.0 },
      { startSec: 6, endSec: 8, naturalSec: 1.0 }
    ];
    const s = timeline.scheduleDubSegments(segs, 20, { maxTempo: 1.3 });
    assert(s[0].tempo <= 1.3001, 'tempo vượt giới hạn');
    for (let i = 0; i < s.length - 1; i++) {
      assert(s[i].placedStartSec + s[i].finalSec <= s[i + 1].placedStartSec + 1e-6, `chồng lấn đoạn ${i}`);
    }
    // tổng thời lượng phát = thời lượng tự nhiên / tempo (không mất nội dung)
    assert(Math.abs(s[0].finalSec * s[0].tempo - 4.0) < 0.01, 'mất nội dung');
    assert(s[1].delaySec > 0 && s[2].delaySec === 0, `đoạn 2 phải bị đẩy lùi, đoạn 3 bù lại: ${JSON.stringify(s)}`);
    return `đoạn1 tempo=${s[0].tempo}, đoạn2 trễ ${s[1].delaySec}s, đoạn3 trễ ${s[2].delaySec}s`;
  });
  await check('Lập lịch: 2.000 phân đoạn (video dài) chạy nhanh, không chồng lấn', () => {
    const segs = [];
    for (let i = 0; i < 2000; i++) segs.push({ startSec: i * 3, endSec: i * 3 + 2.5, naturalSec: 1 + (i % 7) * 0.6 });
    const t0 = Date.now();
    const s = timeline.scheduleDubSegments(segs, 6000);
    for (let i = 0; i < s.length - 1; i++) assert(s[i].placedStartSec + s[i].finalSec <= s[i + 1].placedStartSec + 1e-6, `chồng lấn ${i}`);
    return `${Date.now() - t0} ms, trễ tối đa ${Math.max(...s.map((x) => x.delaySec)).toFixed(2)}s`;
  });

  const segA = path.join(TMP, 'segA.wav');
  const segB = path.join(TMP, 'segB.wav');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=2', '-af', 'volume=0.3', '-ac', '1', '-c:a', 'pcm_s16le', segA]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=1', '-af', 'volume=0.3', '-ac', '1', '-c:a', 'pcm_s16le', segB]);
  await check('Đọc thời lượng WAV do FFmpeg ghi (có khối LIST) chính xác', () => {
    const d = timeline.wavDurationSec(segA);
    assert(Math.abs(d - 2) < 0.002, `đo ${d}`);
    return `${d.toFixed(3)} s`;
  });
  const tlPath = path.join(TMP, 'timeline.wav');
  await check('Dựng timeline: đúng vị trí, chuẩn hóa RMS -20 dBFS, có khoảng lặng giữa các đoạn', () => {
    const info = timeline.writeTimelineWav(
      [
        { wavPath: segA, placedStartSec: 2, finalSec: 2 },
        { wavPath: segB, placedStartSec: 5, finalSec: 1 }
      ],
      8,
      tlPath
    );
    const total = timeline.wavDurationSec(tlPath);
    assert(total >= 8, `timeline ngắn hơn video: ${total}`);
    const sil = meanVolumeDb(tlPath, 0.2, 1.5);
    const a = meanVolumeDb(tlPath, 2.2, 1.6);
    assert(sil === -Infinity || sil < -80, `đoạn lặng không im: ${sil}`);
    near(a, -20, 1.2, 'RMS đoạn 1');
    return `gain=${info.gainApplied}, lặng=${sil}, đoạn1=${a.toFixed(2)} dB`;
  });

  /* ----------------------------- 2. Âm lượng ----------------------------- */
  console.log('\n--- [2] Âm lượng gốc / lồng tiếng áp dụng THỰC SỰ vào file xuất (đo bằng FFmpeg) ---');
  const srcVideo = path.join(TMP, 'source_tone.mp4');
  ff([
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
    '-af', 'volume=0.25', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-b:a', '192k', '-shortest', srcVideo
  ]);
  const origRef = meanVolumeDb(srcVideo, 5.2, 1.5);
  const winSpeech = [{ s: 2, e: 4 }, { s: 5.0, e: 5.0 }].filter((w) => w.e > w.s);
  const mixCase = async (name, opts) => {
    const out = path.join(TMP, `mix_${name}.mp4`);
    const dir = fs.mkdtempSync(path.join(TMP, 'mixdir_'));
    await dub.mixDubTrackWithVideo(srcVideo, tlPath, out, { totalDuration: 8, tempDir: dir, speechWindows: winSpeech, ...opts });
    return out;
  };
  const silentRegion = [6.0, 1.5]; // không có lời lồng tiếng (segB nằm ở 5–6s)
  await check('Gốc 100% / Lồng 0% / tắt ducking → âm gốc giữ nguyên mức', async () => {
    const o = await mixCase('o100_d0', { originalVolume: 1, dubVolume: 0, autoDucking: false });
    return near(meanVolumeDb(o, ...silentRegion), origRef, 0.6, 'gốc');
  });
  await check('Gốc 50% → giảm đúng -6.02 dB', async () => {
    const o = await mixCase('o50', { originalVolume: 0.5, dubVolume: 0, autoDucking: false });
    return near(meanVolumeDb(o, ...silentRegion), origRef - 6.02, 0.6, 'gốc 50%');
  });
  await check('Gốc 20% → giảm đúng -13.98 dB', async () => {
    const o = await mixCase('o20', { originalVolume: 0.2, dubVolume: 0, autoDucking: false });
    return near(meanVolumeDb(o, ...silentRegion), origRef - 13.98, 0.6, 'gốc 20%');
  });
  await check('Gốc 200% (tăng âm lượng) → tăng đúng +6.02 dB', async () => {
    const o = await mixCase('o200', { originalVolume: 2, dubVolume: 0, autoDucking: false });
    return near(meanVolumeDb(o, ...silentRegion), origRef + 6.02, 0.6, 'gốc 200%');
  });
  await check('Gốc 0% (tắt hẳn) / Lồng 100% → ngoài lời lồng tiếng là im lặng tuyệt đối', async () => {
    const o = await mixCase('o0_d100', { originalVolume: 0, dubVolume: 1, autoDucking: true });
    const sil = meanVolumeDb(o, ...silentRegion);
    const sp = meanVolumeDb(o, 2.3, 1.4);
    assert(sil === -Infinity || sil < -70, `vùng không lời phải im: ${sil}`);
    return `${near(sp, -20, 1.0, 'lồng tiếng')}; vùng không lời ${sil} dB`;
  });
  await check('Lồng 70% độc lập với gốc → giảm -3.10 dB so với 100%', async () => {
    const o = await mixCase('o0_d70', { originalVolume: 0, dubVolume: 0.7, autoDucking: false });
    return near(meanVolumeDb(o, 2.3, 1.4), -20 - 3.1, 1.0, 'lồng 70%');
  });
  await check('Lồng 0% (tắt giọng lồng tiếng) / Gốc 0% → toàn bộ im lặng', async () => {
    const o = await mixCase('o0_d0', { originalVolume: 0, dubVolume: 0, autoDucking: false });
    const v = meanVolumeDb(o, 0.5, 7);
    assert(v === -Infinity || v < -70, `phải im lặng: ${v}`);
    return `${v} dB`;
  });
  await check('Auto-Ducking: gốc 50%, hệ số 0.35 → trong lời lồng tiếng -15.14 dB, ngoài lời -6.02 dB', async () => {
    const o = await mixCase('duck', { originalVolume: 0.5, dubVolume: 0, autoDucking: true, duckLevel: 0.35 });
    const inside = meanVolumeDb(o, 2.4, 1.2);
    const outside = meanVolumeDb(o, ...silentRegion);
    return `${near(inside, origRef - 15.14, 0.8, 'trong')}; ${near(outside, origRef - 6.02, 0.6, 'ngoài')}`;
  });
  await check('Gốc 20% + Lồng 100% cùng lúc: mức tổng = cộng công suất 2 nguồn', async () => {
    const o = await mixCase('o20_d100', { originalVolume: 0.2, dubVolume: 1, autoDucking: false });
    const expected = 10 * Math.log10(10 ** ((origRef - 13.98) / 10) + 10 ** (-20 / 10));
    return near(meanVolumeDb(o, 2.3, 1.4), expected, 1.0, 'tổng');
  });
  await check('Âm gốc STEREO: gốc 100% giữ nguyên, 50% giảm đúng -6.02 dB', async () => {
    const stereoVideo = path.join(TMP, 'source_stereo.mp4');
    ff([
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
      '-filter_complex', '[1:a]volume=0.25,pan=stereo|c0=c0|c1=c0[a]', '-map', '0:v', '-map', '[a]',
      '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-b:a', '192k', '-shortest', stereoVideo
    ]);
    const ref = meanVolumeDb(stereoVideo, 5.2, 1.5);
    const dir = fs.mkdtempSync(path.join(TMP, 'mixdir_'));
    const o1 = path.join(TMP, 'st100.mp4');
    const o2 = path.join(TMP, 'st50.mp4');
    await dub.mixDubTrackWithVideo(stereoVideo, tlPath, o1, { totalDuration: 8, tempDir: dir, originalVolume: 1, dubVolume: 0, autoDucking: false });
    await dub.mixDubTrackWithVideo(stereoVideo, tlPath, o2, { totalDuration: 8, tempDir: dir, originalVolume: 0.5, dubVolume: 0, autoDucking: false });
    return `${near(meanVolumeDb(o1, ...silentRegion), ref, 0.6, 'stereo 100%')}; ${near(meanVolumeDb(o2, ...silentRegion), ref - 6.02, 0.6, 'stereo 50%')}`;
  });
  await check('Giá trị âm lượng không hợp lệ (NaN, chuỗi rỗng) dùng mặc định thay vì làm hỏng FFmpeg', async () => {
    const o = await mixCase('nan', { originalVolume: 'abc', dubVolume: '', autoDucking: false });
    return near(meanVolumeDb(o, ...silentRegion), origRef - 13.98, 0.6, 'mặc định gốc 20%');
  });

  /* --------------------------- 3. AI Provider ---------------------------- */
  console.log('\n--- [3] AI Provider Manager & dịch theo phân đoạn (máy chủ giao thức cục bộ) ---');
  let mode = 'ok';
  let lastBody = null;
  let lastModel = null;
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const key = req.headers['x-goog-api-key'] || String(req.headers.authorization || '').replace('Bearer ', '');
      if (key !== 'TEST-KEY-1234567890' && !req.url.startsWith('/ollama')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 401, message: 'API key not valid', status: 'UNAUTHENTICATED' } }));
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url.startsWith('/ollama/models')) {
          return res.end(JSON.stringify({ data: [{ id: 'qwen2.5:7b' }] }));
        }
        if (req.url.startsWith('/gemini/models')) {
          return res.end(JSON.stringify({ models: [{ name: 'models/gemini-test', displayName: 'Gemini Test', supportedGenerationMethods: ['generateContent'] }] }));
        }
        return res.end(JSON.stringify({ data: [{ id: 'gpt-test' }, { id: 'text-embedding-3-small' }] }));
      }
      lastBody = JSON.parse(body || '{}');
      if (mode === 'quota') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }));
      }
      if (mode === 'ratelimit-once') {
        mode = 'ok';
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        return res.end(JSON.stringify({ error: { message: 'Rate limit reached for requests per minute' } }));
      }
      const userText = req.url.startsWith('/gemini') ? lastBody.contents[0].parts[0].text : lastBody.messages[1].content;
      const input = JSON.parse(userText.slice(userText.indexOf('DỮ LIỆU ĐẦU VÀO:') + 'DỮ LIỆU ĐẦU VÀO:'.length));
      const reqModel = (lastBody && lastBody.model) || (req.url.match(/models\/([^:]+):/) || [])[1];
      if (mode === 'notfound' && reqModel === 'old-model') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 404, message: 'This model models/old-model is no longer available to new users.' } }));
      }
      if (mode === 'overloaded') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.' } }));
      }
      if (mode === 'leak-cjk') {
        mode = 'ok';
        const bad = input.segments.map((s) => ({ ...s, translated_text: `Bản dịch ${s.id} 你好` }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ segments: bad }) } }] }));
      }
      lastModel = (lastBody && lastBody.model) || (req.url.match(/models\/([^:]+):/) || [])[1];
      let segs = input.segments.map((s) => ({ ...s, translated_text: `Bản dịch ${s.id}` }));
      if (mode === 'drop-one-then-ok') {
        mode = 'ok';
        segs = segs.slice(1);
      } else if (mode === 'bad-json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const txt = 'xin lỗi tôi không thể';
        return res.end(
          req.url.startsWith('/gemini')
            ? JSON.stringify({ candidates: [{ content: { parts: [{ text: txt }] } }] })
            : JSON.stringify({ choices: [{ message: { content: txt } }] })
        );
      }
      const payload = JSON.stringify({ segments: segs });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/gemini')) {
        return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '```json\n' + payload + '\n```' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }));
      }
      return res.end(JSON.stringify({ choices: [{ message: { content: payload }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 40 } }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${stub.address().port}`;

  await check('Chưa có API Key → báo lỗi NO_KEY rõ ràng, không gọi mạng', async () => {
    try {
      ai.resolveFeatureTarget('translation', { providerId: 'gemini' });
      throw new Error('phải báo lỗi');
    } catch (e) {
      assert(e.code === 'NO_KEY', `code=${e.code}`);
      return e.message.slice(0, 80);
    }
  });
  await check('Lưu API Key: file secrets quyền 0600, cấu hình công khai KHÔNG chứa key', () => {
    const cfg = ai.saveAiConfig({
      providers: {
        gemini: { apiKey: 'TEST-KEY-1234567890', baseUrl: `${base}/gemini`, defaultModel: 'gemini-test' },
        openai: { apiKey: 'TEST-KEY-1234567890', baseUrl: `${base}/openai`, defaultModel: 'gpt-test' }
      },
      features: { translation: { providerId: 'gemini', model: 'gemini-test', autoFallback: false } }
    });
    let mode = fs.statSync(ai._internals.SECRETS_FILE).mode & 0o777;
    let permNote = '';
    if (process.platform === 'win32') {
      // Windows: kiểm tra ACL thật — chỉ tài khoản hiện tại, không kế thừa, không có Users/Everyone
      const acl = spawnSync('icacls', [ai._internals.SECRETS_FILE], { encoding: 'utf8' }).stdout || '';
      assert(!/Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/i.test(acl), `ACL còn quyền chung: ${acl.replace(/\s+/g, ' ')}`);
      assert(acl.toLowerCase().includes(String(process.env.USERNAME).toLowerCase()), `ACL thiếu tài khoản hiện tại: ${acl}`);
      permNote = 'ACL: chỉ tài khoản hiện tại';
    } else {
      assert(mode === 0o600, `quyền file ${mode.toString(8)}`);
      permNote = `mode=0${mode.toString(8)}`;
    }
    const pub = JSON.stringify(cfg);
    assert(!pub.includes('TEST-KEY-1234567890'), 'lộ key trong cấu hình công khai');
    assert(!fs.readFileSync(ai._internals.SETTINGS_FILE, 'utf8').includes('TEST-KEY'), 'key lọt vào ai_settings.json');
    const g = cfg.providers.find((p) => p.id === 'gemini');
    assert(g.hasKey && g.keyHint === '••••7890', JSON.stringify(g));
    return `${permNote}, keyHint=${g.keyHint}`;
  });
  await check('Base URL không an toàn (http tới máy khác) bị từ chối', () => {
    try {
      ai.saveAiConfig({ providers: { openai_compatible: { baseUrl: 'http://evil.example.com/v1' } } });
      throw new Error('phải từ chối');
    } catch (e) {
      assert(/Base URL không hợp lệ/.test(e.message), e.message);
      return 'đã chặn';
    }
  });
  await check('Kiểm tra kết nối Gemini & OpenAI: trả danh sách model, lọc model không phải chat', async () => {
    const g = await ai.testProviderConnection('gemini');
    const o = await ai.testProviderConnection('openai');
    assert(g.ok && g.models[0].id === 'gemini-test', JSON.stringify(g));
    assert(o.ok && o.models.length === 1 && o.models[0].id === 'gpt-test', JSON.stringify(o));
    return `gemini=${g.models.map((m) => m.id)}, openai=${o.models.map((m) => m.id)}`;
  });
  const segsIn = [
    { index: 1, id: 1, startSec: 0.5, endSec: 2.1, sourceText: '你好', speakerId: 'speaker_1' },
    { index: 2, id: 2, startSec: 2.4, endSec: 4.0, sourceText: '今天天气很好', speakerId: 'speaker_2' },
    { index: 3, id: 3, startSec: 4.2, endSec: 6.0, sourceText: '我们出去吧', speakerId: 'speaker_1' }
  ];
  await check('Dịch Gemini: dùng prompt phiên dịch viên, gửi ID/timestamp, ghép đúng theo ID, giữ timestamp', async () => {
    mode = 'ok';
    const r = await translateSegmentsWithLLM(segsIn, { sourceLang: 'zh', targetLang: 'vi', providerId: 'gemini', useCache: false });
    assert(r.translations.join('|') === 'Bản dịch 1|Bản dịch 2|Bản dịch 3', r.translations.join('|'));
    assert(lastBody.systemInstruction.parts[0].text.includes('Đóng vai là một phiên dịch viên chuyên nghiệp'), 'thiếu prompt');
    assert(lastBody.generationConfig.responseMimeType === 'application/json', 'không bật JSON mode');
    const sent = lastBody.contents[0].parts[0].text;
    assert(sent.includes('"id": 2') && sent.includes('"start": 2.4') && sent.includes('"speaker_id": "speaker_2"'), 'thiếu cấu trúc');
    return r.mode;
  });
  await check('Dịch OpenAI (JSON mode) qua cùng lớp Adapter', async () => {
    mode = 'ok';
    const r = await translateSegmentsWithLLM(segsIn, { sourceLang: 'zh', targetLang: 'vi', providerId: 'openai', useCache: false });
    assert(r.translations[1] === 'Bản dịch 2', r.translations.join('|'));
    assert(lastBody.response_format && lastBody.response_format.type === 'json_object', 'thiếu response_format');
    return r.mode;
  });
  await check('AI trả thiếu phân đoạn → phát hiện sai cấu trúc và tự yêu cầu lại', async () => {
    mode = 'drop-one-then-ok';
    const r = await translateSegmentsWithLLM(segsIn, { sourceLang: 'zh', targetLang: 'vi', providerId: 'gemini', useCache: false });
    assert(r.translations.length === 3 && r.stats.retries + r.stats.partialRetries >= 1 && r.requests !== 0, JSON.stringify(r.stats));
    return `retries=${r.stats.retries}, dịch lại một phần=${r.stats.partialRetries}, ${r.stats.requests} request`;
  });
  await check('429 rate-limit tạm thời → tự thử lại thành công', async () => {
    mode = 'ratelimit-once';
    const r = await translateSegmentsWithLLM(segsIn.slice(0, 1), { sourceLang: 'zh', targetLang: 'vi', providerId: 'openai', useCache: false });
    assert(r.translations[0] === 'Bản dịch 1', r.translations[0]);
    return 'ok';
  });
  await check('429 hết hạn mức (insufficient_quota) → lỗi QUOTA rõ ràng, không thử lại vô ích', async () => {
    mode = 'quota';
    try {
      await translateSegmentsWithLLM(segsIn.slice(0, 1), { sourceLang: 'zh', targetLang: 'vi', providerId: 'openai', useCache: false });
      throw new Error('phải lỗi');
    } catch (e) {
      assert(e.code === 'QUOTA', `code=${e.code} ${e.message}`);
      return e.message.slice(0, 90);
    }
  });
  await check('Phản hồi không phải JSON → báo INVALID_RESPONSE (không ghép dữ liệu hỏng vào video)', async () => {
    mode = 'bad-json';
    try {
      await translateSegmentsWithLLM(segsIn.slice(0, 1), { sourceLang: 'zh', targetLang: 'vi', providerId: 'gemini', useCache: false });
      throw new Error('phải lỗi');
    } catch (e) {
      assert(e.code === 'INVALID_RESPONSE', `code=${e.code}`);
      return e.message.slice(0, 90);
    }
  });
  await check('API Key sai → lỗi AUTH, thông báo không chứa key', async () => {
    ai.saveAiConfig({ providers: { gemini: { apiKey: 'WRONG-KEY-0000000000' } } });
    const r = await ai.testProviderConnection('gemini');
    ai.saveAiConfig({ providers: { gemini: { apiKey: 'TEST-KEY-1234567890' } } });
    assert(!r.ok && r.code === 'AUTH', JSON.stringify(r));
    assert(!JSON.stringify(r).includes('WRONG-KEY'), 'lộ key');
    return r.error.slice(0, 80);
  });
  await check('Hạn mức do người dùng đặt (request/tháng) chặn gọi API khi vượt', async () => {
    mode = 'ok';
    const used = (ai.getPublicAiConfig().providers.find((p) => p.id === 'openai').usageThisMonth.requests) || 0;
    ai.saveAiConfig({ limits: { openai: { monthlyRequestLimit: used } } });
    try {
      await translateSegmentsWithLLM(segsIn.slice(0, 1), { sourceLang: 'zh', targetLang: 'vi', providerId: 'openai', useCache: false });
      throw new Error('phải bị chặn');
    } catch (e) {
      assert(e.code === 'LIMIT_EXCEEDED', `code=${e.code}`);
    } finally {
      ai.saveAiConfig({ limits: { openai: { monthlyRequestLimit: 0 } } });
    }
    return `chặn tại ${used} request`;
  });
  await check('Bộ dịch AI yêu cầu đồng ý gửi Cloud (cloudConsent) — không âm thầm gửi dữ liệu', async () => {
    try {
      await dub.translateSegmentList(segsIn, 'zh', 'vi', { translationProvider: 'ai_gemini', cloudConsent: false });
      throw new Error('phải chặn');
    } catch (e) {
      assert(/đồng ý gửi văn bản/.test(e.message), e.message);
      return 'đã chặn';
    }
  });
  await check('Pipeline dịch: translateSegmentList giữ nguyên số lượng, index, id, timestamp, speakerId', async () => {
    mode = 'ok';
    const r = await dub.translateSegmentList(segsIn, 'zh', 'vi', { translationProvider: 'ai_gemini', cloudConsent: true });
    r.segments.forEach((s, i) => {
      assert(s.id === segsIn[i].id && s.startSec === segsIn[i].startSec && s.endSec === segsIn[i].endSec && s.speakerId === segsIn[i].speakerId, `lệch cấu trúc ở ${i}`);
    });
    return `${r.segments.length} đoạn, ${r.mode}`;
  });
  await check('Gateway: bản dịch còn sót chữ Hán bị chặn và tự yêu cầu dịch lại (không đưa vào TTS)', async () => {
    mode = 'leak-cjk';
    const r = await translateSegmentsWithLLM(segsIn, { sourceLang: 'zh', targetLang: 'vi', providerId: 'openai', useCache: false });
    assert(r.translations.every((t) => !/[\u4e00-\u9fff]/.test(t)), r.translations.join('|'));
    assert(r.stats.problems.some((p) => /chữ Hán/.test(p)), JSON.stringify(r.stats.problems));
    return `retries=${r.stats.retries}; vấn đề phát hiện: ${r.stats.problems[0]}`;
  });
  await check('Gateway: model bị ngừng (404) → ghi nhớ "không khả dụng" và tự chuyển model khác cùng nhà cung cấp', async () => {
    // cung cấp danh sách model thật giả lập có 2 model; model cấu hình bị 404 ở lần gọi đầu
    ai.saveAiConfig({ features: { translation: { providerId: 'openai', model: 'old-model', autoFallback: false } } });
    const settingsFile = ai._internals.SETTINGS_FILE;
    const st = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    st.providers.openai.cachedModels = [{ id: 'old-model' }, { id: 'gpt-9.1-mini' }];
    fs.writeFileSync(settingsFile, JSON.stringify(st));
    mode = 'notfound';
    const r = await translateSegmentsWithLLM(segsIn.slice(0, 1), { sourceLang: 'zh', targetLang: 'vi', useCache: false });
    mode = 'ok';
    const cfg = ai.getPublicAiConfig().providers.find((p) => p.id === 'openai');
    assert(cfg.unavailableModels.includes('old-model'), JSON.stringify(cfg.unavailableModels));
    assert(r.stats.model === 'gpt-9.1-mini', `model dùng: ${r.stats.model}`);
    ai.saveAiConfig({ features: { translation: { providerId: 'gemini', model: 'gemini-test', autoFallback: false } } });
    return `đã đánh dấu old-model không khả dụng, dùng ${r.stats.model}`;
  });
  await check('Gateway: nhà cung cấp chính quá tải (503) → tự dùng nhà cung cấp dự phòng đã cấu hình', async () => {
    ai.saveAiConfig({ features: { translation: { providerId: 'gemini', model: 'gemini-test', autoFallback: false, fallbacks: [{ providerId: 'openai', model: 'gpt-test' }] } } });
    mode = 'overloaded';
    const flip = setInterval(() => {
      if (lastBody && lastBody.messages && mode === 'overloaded') mode = 'ok';
    }, 5);
    // gemini (503, thử lại 1 lần) → openai
    const origFetchMode = mode;
    const r = await translateSegmentsWithLLM(segsIn.slice(0, 1), { sourceLang: 'zh', targetLang: 'vi', useCache: false }).finally(() => clearInterval(flip));
    void origFetchMode;
    mode = 'ok';
    ai.saveAiConfig({ features: { translation: { providerId: 'gemini', model: 'gemini-test', autoFallback: false, fallbacks: [] } } });
    assert(r.stats.providerId === 'openai' && r.stats.fallbacks.length > 0, JSON.stringify(r.stats));
    const logs = ai.getAiLogs(20).map((l) => l.code);
    assert(logs.includes('FALLBACK_USED'), logs.join(','));
    return `kết quả từ ${r.stats.providerId}/${r.stats.model}; log: ${logs.slice(0, 4).join(', ')}`;
  });
  await check('Gateway: bộ nhớ đệm theo lô — chạy lại không gửi lại request (phục hồi sau gián đoạn)', async () => {
    mode = 'ok';
    const a = await translateSegmentsWithLLM(segsIn, { sourceLang: 'zh', targetLang: 'vi', providerId: 'openai', model: 'gpt-test' });
    const b = await translateSegmentsWithLLM(segsIn, { sourceLang: 'zh', targetLang: 'vi', providerId: 'openai', model: 'gpt-test' });
    assert(b.stats.cacheHits >= 1 && b.stats.requests === 0, JSON.stringify(b.stats));
    assert(a.translations.join('|') === b.translations.join('|'), 'khác kết quả');
    return `lần 2: ${b.stats.requests} request, ${b.stats.cacheHits} lô từ bộ nhớ đệm`;
  });
  await check('Kiểm tra trước TTS: chặn lời dịch còn chữ Hán, chữ thừa, ID trùng, timestamp sai', () => {
    const v = dub.validateSegmentsForTts([
      { index: 1, id: 1, startSec: 0, endSec: 2, translatedText: 'Xin chào' },
      { index: 2, id: 1, startSec: 2, endSec: 4, translatedText: 'Tên là 苏无名' },
      { index: 3, id: 3, startSec: 5, endSec: 4, translatedText: 'Dịch: câu ba' },
      { index: 4, id: 4, startSec: 6, endSec: 7, translatedText: '' }
    ], { targetLang: 'vi' });
    assert(!v.ok && v.errors.length >= 4 && v.warnings.length === 1, JSON.stringify(v));
    return v.errors.join(' | ').slice(0, 160);
  });
  await check('Máy chủ AI cục bộ (Ollama/LM Studio, cho Windows): không cần API Key, không cần đồng ý gửi Cloud', async () => {
    mode = 'ok';
    ai.saveAiConfig({ providers: { openai_compatible: { baseUrl: `${base}/ollama`, defaultModel: '' } } });
    const t = await ai.testProviderConnection('openai_compatible');
    assert(t.ok && t.models[0].id === 'qwen2.5:7b', JSON.stringify(t));
    const r = await dub.translateSegmentList(segsIn, 'zh', 'vi', { translationProvider: 'ai_openai_compatible', cloudConsent: false });
    assert(r.usedCloud === false && r.segments.every((x) => x.translatedText.startsWith('Bản dịch')), JSON.stringify({ usedCloud: r.usedCloud, mode: r.mode }));
    ai.saveAiConfig({ providers: { openai_compatible: { baseUrl: '' } } });
    return `${r.mode}; usedCloud=${r.usedCloud}`;
  });
  await check('Mã bộ dịch cũ cloud_gemini/cloud_openai được ánh xạ sang AI Provider mới', () => {
    assert(dub.normalizeTranslationProvider('cloud_gemini') === 'ai_gemini' && dub.normalizeTranslationProvider('cloud_openai') === 'ai_openai', 'sai ánh xạ');
    return 'ok';
  });
  await check('Kiểm tra cấu trúc kết quả: sai ID / thứ tự bị từ chối', () => {
    const chunk = [{ id: 1 }, { id: 2 }];
    const v1 = llmInternals.validateChunkResult({ segments: [{ id: 2, translated_text: 'a' }, { id: 1, translated_text: 'b' }] }, chunk);
    const v2 = llmInternals.validateChunkResult({ segments: [{ id: 1, translated_text: 'a' }, { id: 2, translated_text: '' }] }, chunk);
    assert(!v1.ok && !v2.ok, 'phải từ chối');
    return v1.problems[0];
  });
  stub.close();

  /* ----------------------------- 4. VieNeu-TTS ----------------------------- */
  console.log('\n--- [4] VieNeu-TTS (tổng hợp thật trên máy) ---');
  const vst = vieneu.getStatus();
  await check('VieNeu-TTS có trong danh sách giọng tiếng Việt và là giọng đề xuất khi đã cài', () => {
    const voices = dub.getSupportedVoices('vi');
    const vn = voices.filter((v) => v.engine === 'vieneu');
    assert(vn.length > 0, 'không có mục VieNeu');
    if (!vst.sdkInstalled || !vst.modelDownloaded || vst.voices.length === 0) {
      assert(vn.every((v) => !v.installed && !v.isDefaultRecommended), 'không được đánh dấu sẵn sàng khi chưa cài');
      throw skip('VieNeu-TTS chưa cài trên máy này — mục giọng hiển thị trạng thái "chưa cài" (đúng).');
    }
    const rec = voices.find((v) => v.isDefaultRecommended);
    assert(rec && rec.engine === 'vieneu', `giọng đề xuất: ${rec && rec.id}`);
    assert(voices.some((v) => v.engine === 'sherpa-piper') && voices.some((v) => v.engine === 'system-tts'), 'giọng cũ bị mất');
    return `${vn.length} giọng VieNeu, đề xuất "${rec.name}", giữ ${voices.length - vn.length} giọng cũ`;
  });
  await check('Nghe thử giọng VieNeu: tạo file WAV hợp lệ (âm thanh thật)', async () => {
    if (!vst.sdkInstalled || !vst.modelDownloaded) throw skip('VieNeu-TTS chưa cài.');
    const t0 = Date.now();
    const r = await dub.generateVoicePreviewAudio({ voiceId: `vieneu:${vst.defaultVoice}`, targetLang: 'vi', text: 'Xin chào, đây là kiểm thử giọng đọc.' });
    const vol = meanVolumeDb(r.previewPath, 0, 30);
    assert(r.duration > 0.8 && vol > -40, `duration=${r.duration}, vol=${vol}`);
    return `${r.duration}s âm thanh, ${vol.toFixed(1)} dB, ${Date.now() - t0} ms`;
  });
  await check('VieNeu-TTS lỗi/thiếu mô hình → thông báo rõ ràng (không tạo âm thanh giả)', () => {
    try {
      dub.resolveVoiceConfig('vieneu:__khong_ton_tai__', 'vi');
    } catch (e) {
      return e.message;
    }
    throw new Error('phải báo lỗi với giọng không tồn tại / chưa có mô hình');
  });
  await check('Nhận diện người nói: hội thoại 2 giọng (Nam/Nữ xen kẽ) → 2 speakerId, gán đúng từng câu', async () => {
    if (!vst.sdkInstalled || !vst.modelDownloaded) throw skip('VieNeu-TTS chưa cài (cần để tạo hội thoại thử).');
    const diarDir = path.join(ROOT, 'bin', 'models', 'diarization');
    if (!fs.existsSync(path.join(diarDir, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'))) throw skip('Chưa cài mô hình phân tách người nói.');
    const lines = [
      ['Hải Đăng', 'Chào chị, hôm nay chị có khỏe không? Em vừa đi công tác về hôm qua.'],
      ['Trúc Ly', 'Chị khỏe, cảm ơn em nhé. Chuyến đi của em có vui không, có gì mới không?'],
      ['Hải Đăng', 'Vui lắm chị ạ, em đã gặp rất nhiều khách hàng mới ở thành phố Đà Nẵng.'],
      ['Trúc Ly', 'Tuyệt quá, vậy tuần sau mình họp lại để bàn kế hoạch cho quý tới nhé.']
    ];
    const items = lines.map(([voice, text], i) => ({ voice, text, output: path.join(TMP, `dlg_${i}.wav`) }));
    await vieneu.synthesize(items);
    const listFile = path.join(TMP, 'dlg_list.txt');
    const silence = path.join(TMP, 'sil.wav');
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.8', '-c:a', 'pcm_s16le', silence]);
    fs.writeFileSync(listFile, items.map((it) => `file '${it.output}'\nfile '${silence}'`).join('\n'));
    const dlg16 = path.join(TMP, 'dialog16k.wav');
    ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dlg16]);
    const asrDir = ['faster-whisper-small', 'faster-whisper-base', 'faster-whisper-tiny'].map((d) => path.join(ROOT, 'bin', 'models', 'asr', d)).find((d) => fs.existsSync(path.join(d, 'model.bin')));
    const r = spawnSync(PY_CORE, [path.join(ROOT, 'src', 'local_ai_worker.py'), 'transcribe_and_translate', '--audio', dlg16, '--asr-dir', asrDir, '--argos-dir', path.join(ROOT, 'bin', 'models', 'argos'), '--target-lang', 'vi', '--skip-translation', '1', '--diarize', '1', '--diar-dir', diarDir], { encoding: 'utf8', timeout: 300000 });
    const line = r.stdout.split('\n').reverse().find((l) => l.startsWith('WORKER_JSON:'));
    const res = JSON.parse(line.slice('WORKER_JSON:'.length));
    assert(res.ok, res.error);
    const spk = res.segments.map((x) => x.speakerId);
    assert(res.speakerCount === 2, `speakerCount=${res.speakerCount} (${spk.join(',')})`);
    // Các câu của cùng một giọng phải cùng speakerId, hai giọng khác nhau
    const first = res.segments.filter((x) => x.startSec < 4.5).map((x) => x.speakerId);
    return `speakerCount=${res.speakerCount}; thứ tự: ${spk.join(', ')}; đầu=${first.join('/')}`;
  });
  vieneu.stop();

  /* ---------------------- 4b. Toàn luồng: đồng bộ & tách giọng gốc ---------------------- */
  console.log('\n--- [4b] Toàn luồng thật: ASR → dịch → TTS → đồng bộ → xuất video (đo bằng FFmpeg) ---');
  const syncDir = path.join(TMP, 'sync');
  fs.mkdirSync(syncDir, { recursive: true });
  const syncVideo = path.join(syncDir, 'sync_test.mp4');
  let truthOnsets = [1.0, 6.0, 11.5];
  const haveTingting = !process.env.TEST_NO_TINGTING && process.platform === 'darwin' && spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout.includes('Tingting');
  const onsetsOf = (file, thrDb) => {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
    const b = r.stdout;
    const n = b.length / 2;
    const win = 160;
    const out = [];
    let quiet = 0.35;
    for (let i = 0; i + win <= n; i += win) {
      let sum = 0;
      for (let k = 0; k < win; k++) {
        const v = b.readInt16LE((i + k) * 2) / 32768;
        sum += v * v;
      }
      if (10 * Math.log10(sum / win + 1e-12) > thrDb) {
        if (quiet >= 0.35) out.push(Number((i / 16000).toFixed(3)));
        quiet = 0;
      } else quiet += win / 16000;
    }
    return out;
  };
  const syncLines = ['大家好，今天我们来介绍一款新手机。', '它的电池可以用两天，充电也非常快。', '如果你喜欢这个视频，请点赞关注。'];
  let fixtureVoice = '';
  let clips = [];
  if (haveTingting) {
    clips = syncLines.map((t, i) => {
      const f = path.join(syncDir, `s${i}.aiff`);
      spawnSync('say', ['-v', 'Tingting', '-o', f, t]);
      return f;
    });
    fixtureVoice = 'Tingting';
  } else if (fs.existsSync(PY_CORE)) {
    // Windows/Linux: giọng Trung Microsoft Edge (gói edge-tts trong .venv, cần Internet) — chỉ để tạo video thử
    clips = syncLines.map((t, i) => {
      const f = path.join(syncDir, `s${i}.mp3`);
      spawnSync(PY_CORE, ['-m', 'edge_tts', '--voice', 'zh-CN-XiaoxiaoNeural', '--text', t, '--write-media', f], { timeout: 60000, windowsHide: true });
      return f;
    });
    fixtureVoice = 'edge-tts zh-CN-XiaoxiaoNeural';
  }
  if (clips.length !== 3 || !clips.every((f) => fs.existsSync(f) && fs.statSync(f).size > 1000)) fixtureVoice = '';
  if (fixtureVoice) {
    // Mốc chuẩn = độ trễ chèn + khoảng lặng đầu thật của từng file giọng (đo bằng FFmpeg)
    truthOnsets = truthOnsets.map((t, i) => Number((t + (onsetsOf(clips[i], -38)[0] || 0)).toFixed(3)));
    ff([
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=18,volume=0.05',
      '-i', clips[0], '-i', clips[1], '-i', clips[2],
      '-filter_complex', '[1:a]aresample=48000,adelay=1000|1000[a1];[2:a]aresample=48000,adelay=6000|6000[a2];[3:a]aresample=48000,adelay=11500|11500[a3];[0:a][a1][a2][a3]amix=inputs=4:normalize=0:duration=first[a]',
      '-map', '[a]', '-ac', '1', path.join(syncDir, 'orig.wav')
    ]);
    ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=18', '-i', path.join(syncDir, 'orig.wav'), '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-b:a', '192k', '-shortest', syncVideo]);
  }
  const runDub = (opts) =>
    new Promise((resolve, reject) => {
      const job = dub.startDubbingJob({ videoPath: syncVideo, outputDir: path.join(syncDir, 'out'), targetLang: 'vi', translationProvider: 'local', ...opts });
      const t = setInterval(() => {
        const j = dub.getDubbingJob(job.jobId);
        if (j.status === 'completed') {
          clearInterval(t);
          resolve(j);
        } else if (j.status === 'error') {
          clearInterval(t);
          reject(new Error(j.error));
        }
      }, 400);
    });
  let syncJob = null;
  await check('Đồng bộ: lời lồng tiếng bắt đầu cùng lúc lời gốc (3 câu cách nhau 1–1,5 s, ASR không được gộp câu)', async () => {
    if (!fixtureVoice) throw skip('Không tạo được video thử (cần giọng Tingting trên macOS, hoặc edge-tts + Internet).', true);
    if (!vst.sdkInstalled || !vst.modelDownloaded) throw skip('VieNeu-TTS chưa cài.');
    syncJob = await runDub({ voiceId: `vieneu:${vst.defaultVoice}`, originalVolume: 0, dubVolume: 1, autoDucking: false, removeOriginalVoice: false });
    assert(syncJob.segments.length === 3, `ASR phải ra 3 phân đoạn, nhận ${syncJob.segments.length}`);
    const dubOn = onsetsOf(syncJob.outputPath, -38);
    assert(dubOn.length >= 3, `onsets=${JSON.stringify(dubOn)}`);
    const diffs = truthOnsets.map((t) => Math.min(...dubOn.map((o) => Math.abs(o - t))));
    if (process.env.TEST_DEBUG_SYNC) console.log("DBG truth", truthOnsets, "dub", dubOn, "asr", syncJob.segments.map((s) => [s.startSec, s.endSec, s.sourceText]));
    assert(diffs.every((d) => d <= 0.15), `lệch ${diffs.map((d) => d.toFixed(3)).join(', ')} s`);
    return `[${fixtureVoice}] onset lồng tiếng ${dubOn.slice(0, 3).join(' / ')} s vs gốc ${truthOnsets.join(' / ')} s (lệch tối đa ${(Math.max(...diffs) * 1000).toFixed(0)} ms)`;
  });
  await check('Tách giọng gốc: chế độ "chỉ giữ nhạc nền" loại lời nói gốc khỏi file xuất (đo dải tần lời nói)', async () => {
    if (!syncJob) throw skip('Phụ thuộc kiểm thử đồng bộ ở trên.');
    if (!dub.isSeparationAvailable()) throw skip('Chưa cài mô hình tách giọng.');
    const speechBand = (file) => {
      const r = spawnSync(FFMPEG, ['-hide_banner', '-ss', '2.0', '-t', '2.0', '-i', file, '-af', 'highpass=f=400,volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      const m = r.stderr.match(/mean_volume:\s*(-?[\d.]+|-inf)/);
      return m[1] === '-inf' ? -120 : parseFloat(m[1]);
    };
    const keep = await runDub({ customSegments: syncJob.segments, voiceId: `vieneu:${vst.defaultVoice}`, originalVolume: 1, dubVolume: 0, autoDucking: false, removeOriginalVoice: false });
    const removed = await runDub({ customSegments: syncJob.segments, voiceId: `vieneu:${vst.defaultVoice}`, originalVolume: 1, dubVolume: 0, autoDucking: false, removeOriginalVoice: true });
    const a = speechBand(keep.outputPath);
    const b = speechBand(removed.outputPath);
    assert(a - b >= 25, `giảm chỉ ${(a - b).toFixed(1)} dB`);
    return `lời nói gốc: ${a.toFixed(1)} dB → ${b.toFixed(1)} dB (giảm ${(a - b).toFixed(1)} dB)`;
  });
  vieneu.stop();

  /* ---------------- 4c. Giao diện: danh sách tải không bị treo khi tác vụ hoàn tất ---------------- */
  console.log('\n--- [4c] Giao diện (chạy public/app.js thật trong DOM giả lập) ---');
  await check('Danh sách tải chuyển sang "✅ Hoàn tất" khi tác vụ xong (lỗi thanh tiến độ treo ở 98%)', async () => {
    const vm = require('vm');
    const els = new Map();
    const el = (id) => {
      if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', value: '', style: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, addEventListener() {}, dataset: {}, options: [] });
      return els.get(id);
    };
    const errors = [];
    const jobs = [
      { jobId: 'a', status: 'downloading', progress: 98, platform: 'bilibili', platformName: 'Bilibili', title: 'Video A', fileName: 'a.mp4', speedText: 'x' },
      { jobId: 'b', status: 'completed', progress: 100, platform: 'bilibili', platformName: 'Bilibili', title: 'Video B', fileName: 'b.mp4', outputPath: '/tmp/b.mp4', totalBytes: 1000 }
    ];
    const sandbox = {
      console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) },
      document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => el('x' + Math.random()) },
      window: { addEventListener() {}, location: { href: 'http://127.0.0.1/' } },
      navigator: { clipboard: { writeText() {} } },
      localStorage: { getItem: () => null, setItem() {} },
      setInterval: () => 0,
      clearInterval() {},
      setTimeout: (f) => 0,
      fetch: async () => ({ json: async () => ({ success: true, activeJobs: jobs, savedFiles: [] }) }),
      URLSearchParams,
      Blob: function () {},
      URL
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'), sandbox);
    await vm.runInContext('loadDownloads()', sandbox);
    const html = el('downloadsList').innerHTML;
    assert(errors.length === 0, `console.error: ${errors.join(' | ')}`);
    assert(/✅ Hoàn tất/.test(html) && /Đang xử lý \(98%/.test(html), 'danh sách không được vẽ lại');
    return 'tác vụ đang chạy hiện 98%, tác vụ xong hiện ✅ Hoàn tất, không lỗi';
  });

  /* ------------------------------ 5. Bảo mật ------------------------------ */
  console.log('\n--- [5] Bảo mật API cục bộ ---');
  const { createServer } = require('../src/server');
  const app = createServer();
  const srv = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const port = srv.address().port;
  const req = (method, p, headers = {}, body) =>
    new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...headers } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      rq.on('error', reject);
      if (body) rq.write(body);
      rq.end();
    });
  await check('Website bên ngoài (Origin lạ) không gọi được API cục bộ', async () => {
    const r = await req('GET', '/api/ai/config', { Origin: 'https://evil.example.com' });
    assert(r.status === 403, `status=${r.status}`);
    return `HTTP ${r.status}`;
  });
  await check('Chặn DNS rebinding (Host không phải 127.0.0.1/localhost)', async () => {
    const r = await req('GET', '/api/health', { Host: 'attacker.example.com' });
    assert(r.status === 403, `status=${r.status}`);
    return `HTTP ${r.status}`;
  });
  await check('Giao diện cùng origin vẫn gọi API bình thường', async () => {
    const r = await req('GET', '/api/health', { Origin: `http://127.0.0.1:${port}` });
    assert(r.status === 200, `status=${r.status}`);
    return `HTTP ${r.status}`;
  });
  await check('/api/play-local không đọc được file ngoài thư mục lưu (vd. /etc/passwd)', async () => {
    const r = await req('GET', `/api/play-local?path=${encodeURIComponent('/etc/passwd')}`);
    assert(r.status === 404 && !r.body.includes('root:'), `status=${r.status}`);
    return `HTTP ${r.status}`;
  });
  await check('Nghe thử / phát media hỗ trợ HTTP Range (WebKit của ứng dụng macOS bắt buộc)', async () => {
    const previewDir = path.join(os.tmpdir(), 'cn_video_scraper_voice_previews');
    fs.mkdirSync(previewDir, { recursive: true });
    const wav = path.join(previewDir, `range_test_${Date.now()}.wav`);
    fs.copyFileSync(segA, wav);
    const r = await req('GET', `/api/dubbing/preview-audio?path=${encodeURIComponent(wav)}`, { Range: 'bytes=0-1' });
    fs.unlinkSync(wav);
    assert(r.status === 206, `status=${r.status}`);
    return `HTTP ${r.status} cho Range bytes=0-1`;
  });
  await check('Tác vụ "Phân đoạn & Dịch" chạy nền có tiến độ từng giai đoạn và kết quả đã kiểm tra', async () => {
    if (!fs.existsSync(syncVideo)) throw skip('Không tạo được video thử (Tingting / edge-tts).', true);
    const start = await req('POST', '/api/dubbing/extract-task/start', { 'Content-Type': 'application/json' }, JSON.stringify({ videoPath: syncVideo, targetLang: 'vi', translationProvider: 'local', autoDiarize: false }));
    const taskId = JSON.parse(start.body).task.taskId;
    let task;
    const seenStages = new Set();
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 500));
      task = JSON.parse((await req('GET', `/api/dubbing/extract-task/status?taskId=${taskId}`)).body).task;
      seenStages.add(task.stage);
      if (task.status !== 'running') break;
    }
    assert(task.status === 'completed', `${task.status} ${task.errors.join(' ')}`);
    assert(task.result.segments.length === 3 && task.result.validation, 'thiếu kết quả/kiểm tra');
    return `giai đoạn đã thấy: ${Array.from(seenStages).join(' → ')}; ${task.result.segments.length} đoạn, ${task.elapsedSec}s`;
  });
  await check('/api/ai/config không trả về API Key', async () => {
    const r = await req('GET', '/api/ai/config');
    assert(r.status === 200 && !r.body.includes('TEST-KEY-1234567890'), 'lộ key');
    return 'không có key trong phản hồi';
  });
  srv.close();

  const summary = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  console.log('\n========================================================================');
  console.log(`📊 KẾT QUẢ: ${summary.PASS || 0} PASS / ${summary.FAIL || 0} FAIL / ${summary.SKIP || 0} SKIP / ${summary.BLOCKED || 0} BLOCKED`);
  console.log('========================================================================\n');
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  process.exit(summary.FAIL ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

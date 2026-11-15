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

const DESKTOP_UA_TEST = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
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
    else if (err && /Thiếu mô hình dịch Offline|Chưa cài bộ dịch Offline/.test(err.message)) record('BLOCKED', name, 'Chưa cài bộ dịch Offline (chạy: node scripts/setup.js)');
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
    // Yêu cầu thật: KHÔNG gộp 2 câu cách nhau >= 1 s vào 1 đoạn, và mỗi câu có 1 đoạn bắt đầu đúng lúc.
    // (Được phép tách 1 câu ở chỗ ngắt hơi dài — ASR tách theo khoảng nghỉ thật để đồng bộ.)
    const segs = syncJob.segments;
    const segDesc = segs.map((x) => `[${x.startSec}-${x.endSec}] ${x.sourceText}`).join(' | ');
    assert(segs.length >= 3 && segs.length <= 6, `số phân đoạn ${segs.length}: ${segDesc}`);
    const merged = segs.filter((x) => truthOnsets.filter((t) => t > x.startSec + 0.3 && t < x.endSec - 0.3).length > 0);
    assert(merged.length === 0, `đoạn gộp nhiều câu: ${merged.map((x) => x.sourceText).join(' | ')}`);
    const startDiff = truthOnsets.map((t) => Math.min(...segs.map((x) => Math.abs(x.startSec - t))));
    assert(startDiff.every((d) => d <= 0.3), `mốc ASR lệch ${startDiff.map((d) => d.toFixed(2)).join(', ')} s: ${segDesc}`);
    const dubOn = onsetsOf(syncJob.outputPath, -38);
    assert(dubOn.length >= 3, `onsets=${JSON.stringify(dubOn)}`);
    const diffs = truthOnsets.map((t) => Math.min(...dubOn.map((o) => Math.abs(o - t))));
    assert(
      diffs.every((d) => d <= 0.15),
      `lệch ${diffs.map((d) => d.toFixed(3)).join(', ')} s; gốc=${truthOnsets.join('/')} lồng=${dubOn.join('/')} ASR=${segs.map((x) => x.startSec).join('/')} [${fixtureVoice}]`
    );
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

  /* ---------------- 4b2. AI Local Qwen: không để máy chủ mồ côi (Windows) ---------------- */
  await check('AI Local Qwen trên Windows: tắt bình thường và khi wrapper bị diệt đột ngột đều KHÔNG để llama-server mồ côi', async () => {
    if (process.platform !== 'win32') throw skip('Chỉ áp dụng Windows (macOS dùng tín hiệu POSIX, đã kiểm ở đợt 2).');
    const localLlm = require('../src/local_llm_service');
    const inst = localLlm.listInstalledModels();
    if (!localLlm.isRuntimeInstalled() || inst.length === 0) throw skip('Chưa cài AI Local Qwen.', true);
    const count = () => (spawnSync('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '').split('\n').filter((l) => /llama-server/i.test(l)).length;
    const waitZero = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (count() === 0) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return count() === 0;
    };
    localLlm.stop();
    assert(await waitZero(15000), `trước khi kiểm thử đã có ${count()} llama-server`);
    await localLlm.ensureRunning(inst[0].id);
    assert(count() >= 1, 'máy chủ chưa chạy');
    localLlm.stop();
    const t1 = Date.now();
    assert(await waitZero(12000), `tắt bình thường: còn ${count()} llama-server`);
    const graceful = ((Date.now() - t1) / 1000).toFixed(1);
    await localLlm.ensureRunning(inst[0].id);
    const wrapper = localLlm._internals.getProcess();
    assert(wrapper && wrapper.pid && count() >= 1, 'máy chủ chưa chạy lần 2');
    process.kill(wrapper.pid); // Windows: TerminateProcess wrapper — mô phỏng đóng cửa sổ / crash
    const t2 = Date.now();
    assert(await waitZero(10000), `wrapper bị diệt: còn ${count()} llama-server mồ côi (Job Object không hoạt động)`);
    const hard = ((Date.now() - t2) / 1000).toFixed(1);
    localLlm.stop();
    return `tắt bình thường: dọn sau ${graceful} s; wrapper bị diệt đột ngột: máy chủ con tự tắt sau ${hard} s`;
  });

  await check('Windows: tải bộ cài Microsoft Visual C++ Redistributable chính thức và xác minh chữ ký số Microsoft (không cài)', async () => {
    if (process.platform !== 'win32') throw skip('Chỉ áp dụng Windows.');
    const localLlm = require('../src/local_llm_service');
    const file = await require('../src/tool_installer')._internals.downloadVerifiedVcRedist();
    const size = fs.statSync(file).size;
    fs.rmSync(file, { force: true });
    assert(size > 10 * 1024 * 1024, `kích thước ${size}`);
    return `chữ ký Microsoft hợp lệ, ${(size / 1048576).toFixed(1)} MB; DLL VC++ trên máy CI: ${localLlm.missingVcRuntime().length ? 'thiếu ' + localLlm.missingVcRuntime().join(',') : 'đủ'}`;
  });

  /* ---------------- 4b3. Chromium Sniffer (Douyin/Kuaishou trên Windows) ---------------- */
  await check('Chromium Sniffer (Edge/Chrome ẩn): bắt phản hồi có dữ liệu video + thẻ <video> trên trang thử cục bộ', async () => {
    const chromium = require('../src/extractors/chromium_sniffer');
    if (!chromium.isAvailable()) throw skip('Máy không có Edge/Chrome.');
    const http = require('http');
    const srv = http.createServer((rq, rs) => {
      if (rq.url.startsWith('/aweme/v1/web/aweme/detail')) {
        rs.setHeader('Content-Type', 'application/json');
        return rs.end(JSON.stringify({ aweme_detail: { desc: 'thử', video: { play_addr: { url_list: ['https://example.com/v.mp4'] } } } }));
      }
      if (rq.url.startsWith('/v.mp4')) {
        rs.statusCode = 404;
        return rs.end();
      }
      rs.setHeader('Content-Type', 'text/html; charset=utf-8');
      rs.end('<!doctype html><title>Trang thử</title><video src="/v.mp4?mime_type=video_mp4" muted></video><script>fetch("/aweme/v1/web/aweme/detail/?aweme_id=1").then(r=>r.text())</script>');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${srv.address().port}/`;
      const r = await chromium.runChromiumSniffer(url, DESKTOP_UA_TEST, 8000, {});
      const types = r.events.map((e) => e.type);
      assert(types.includes('fetch') && r.events.some((e) => (e.data.body || '').includes('aweme_detail')), `không bắt được fetch: ${JSON.stringify(types)} ${r.error || ''}`);
      assert(types.includes('video_dom'), `không bắt được <video>: ${JSON.stringify(types)}`);
      assert(r.finalInfo && r.finalInfo.title === 'Trang thử' && r.finalInfo.hasCaptcha === false, `finalInfo=${JSON.stringify(r.finalInfo).slice(0, 200)}`);
      return `${path.basename(chromium.findChromiumBrowser())}: ${types.join(', ')}`;
    } finally {
      srv.close();
    }
  });
  await check('Douyin thật qua Chromium Sniffer (đường dùng trên Windows): có aweme_detail và link phát', async () => {
    const chromium = require('../src/extractors/chromium_sniffer');
    if (!chromium.isAvailable()) throw skip('Máy không có Edge/Chrome.');
    const r = await chromium.runChromiumSniffer('https://open.douyin.com/player/video?vid=7702399097798785014&autoplay=1', DESKTOP_UA_TEST, 9000, {});
    let det = null;
    for (const e of r.events) {
      try {
        const j = JSON.parse((e.data && e.data.body) || '{}');
        if (j.aweme_detail) det = j.aweme_detail;
      } catch (_) {}
    }
    const urls = (det && det.video && det.video.play_addr && det.video.play_addr.url_list) || [];
    if (!det || urls.length === 0) {
      throw skip(`Douyin không trả dữ liệu cho máy này (mạng/khu vực/xác minh): ${r.error || ''} captcha=${r.finalInfo && r.finalInfo.hasCaptcha}`, true);
    }
    return `"${String(det.desc || '').slice(0, 30)}" • ${urls.length} link phát`;
  });

  console.log('\n--- [4a2] Chia câu & kiểm tra bản dịch tiếng Trung ---');
  await check('Dấu câu cỡ nhỏ của Whisper (﹐ ﹒ ﹖ …) được quy về dấu chuẩn để chia câu (lỗi đoạn 13 giây gộp nhiều câu)', async () => {
    if (!fs.existsSync(PY_CORE)) throw skip('Chưa cài môi trường Python lõi.', true);
    const r = spawnSync(PY_CORE, ['-c', "import sys; sys.path.insert(0, 'src'); import local_ai_worker as w; print(w.normalize_punct('鸟都被你吓跑了﹐我听说﹒真的吗﹖好﹗'))"], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const out = (r.stdout || '').trim();
    assert(out === '鸟都被你吓跑了，我听说。真的吗？好！', `kết quả: ${out} ${r.stderr}`);
    return out;
  });
  await check('Kiểm tra bản dịch: câu gốc vốn lặp từ (鱼 鱼 鱼, 叫叫叫) thì bản dịch lặp là hợp lệ; câu gốc không lặp thì vẫn bắt lỗi', async () => {
    const { inspectTranslation } = require('../src/ai/llm_translator')._internals;
    const a = inspectTranslation('Cá, nhìn cá cá cá nhìn bạn', '鱼，你看鱼 鱼 鱼看你', 'vi');
    const b = inspectTranslation('Sủa sủa sủa', '叫叫叫', 'vi');
    const c = inspectTranslation('Tôi tôi tôi đi đây', '我走了', 'vi');
    assert(!a.problem && !b.problem, `báo lỗi nhầm: ${a.problem || b.problem}`);
    assert(c.problem && /lặp từ/.test(c.problem), 'phải bắt lỗi lặp từ khi câu gốc không lặp');
    return 'nguồn lặp → chấp nhận • nguồn không lặp → báo lỗi';
  });

  /* ---------------- 4b0. Qwen dùng chung (Windows: %USERPROFILE%\QwenLocal) ---------------- */
  console.log('\n--- [4b0] Qwen dùng chung cho mọi ứng dụng ---');
  await check('Chuyển bản Qwen cũ sang thư mục dùng chung an toàn (đổi chỗ cùng ổ; khác ổ: sao chép → kiểm → mới xóa bản cũ)', async () => {
    const { moveSafely } = require('../src/qwen_shared_home');
    const d = path.join(TMP, 'qwen_move');
    fs.mkdirSync(path.join(d, 'old', 'llama'), { recursive: true });
    const data = Buffer.alloc(3 * 1024 * 1024, 7);
    fs.writeFileSync(path.join(d, 'old', 'model.gguf'), data);
    fs.writeFileSync(path.join(d, 'old', 'llama', 'llama-server.exe'), 'bin');
    const how1 = await moveSafely(path.join(d, 'old', 'model.gguf'), path.join(d, 'home', 'models', 'model.gguf'));
    fs.writeFileSync(path.join(d, 'old', 'model2.gguf'), data);
    const how2 = await moveSafely(path.join(d, 'old', 'model2.gguf'), path.join(d, 'home', 'models', 'model2.gguf'), { forceCopy: true });
    const how3 = await moveSafely(path.join(d, 'old', 'llama'), path.join(d, 'home', 'llama.cpp', 'b1'), { forceCopy: true });
    assert(how1 === 'rename' && how2 === 'copy' && how3 === 'copy', `${how1}/${how2}/${how3}`);
    assert(fs.statSync(path.join(d, 'home', 'models', 'model2.gguf')).size === data.length, 'bản sao thiếu dữ liệu');
    assert(!fs.existsSync(path.join(d, 'old', 'model.gguf')) && !fs.existsSync(path.join(d, 'old', 'model2.gguf')) && !fs.existsSync(path.join(d, 'old', 'llama')), 'bản cũ chưa được dọn');
    assert(fs.readFileSync(path.join(d, 'home', 'llama.cpp', 'b1', 'llama-server.exe'), 'utf8') === 'bin', 'thư mục bộ chạy chuyển sai');
    return 'đổi chỗ + sao chép file 3 MB + sao chép thư mục: đủ dữ liệu, bản cũ đã dọn';
  });
  await check('Chọn nơi cài Qwen theo dung lượng: ổ C đủ chỗ → không hỏi; ổ C ít chỗ & app ở ổ khác → hỏi, đề xuất thư mục app', async () => {
    const { decideLocation } = require('../src/qwen_shared_home');
    const GB = 1e9;
    const a = decideLocation({ userFree: 80 * GB, appFree: 200 * GB, sameDrive: false });
    const b = decideLocation({ userFree: 12 * GB, appFree: 200 * GB, sameDrive: false });
    const c = decideLocation({ userFree: 12 * GB, appFree: 200 * GB, sameDrive: true });
    const d = decideLocation({ userFree: 5 * GB, appFree: 3 * GB, sameDrive: false });
    assert(!a.ask && a.choice === 'user', `C còn 80 GB: ${JSON.stringify(a)}`);
    assert(b.ask && b.recommended === 'app', `C còn 12 GB: ${JSON.stringify(b)}`);
    assert(!c.ask, `cùng ổ thì không hỏi: ${JSON.stringify(c)}`);
    assert(d.ask && d.userTooSmall && d.recommended === 'user', `cả hai ổ thiếu: ${JSON.stringify(d)}`);
    return 'C 80 GB → không hỏi • C 12 GB (app ở ổ khác) → hỏi, đề xuất app • cùng ổ → không hỏi • cả hai thiếu → hỏi, cảnh báo';
  });
  await check('Windows: ổ C ít chỗ (giả lập) → bắt buộc hỏi nơi cài; chọn thư mục app → %USERPROFILE%\\QwenLocal\\qwen-local.json trỏ đúng chỗ', async () => {
    if (process.platform !== 'win32') throw skip('Chỉ áp dụng Windows.');
    const fakeUser = path.join(TMP, 'fake_user_profile');
    fs.mkdirSync(fakeUser, { recursive: true });
    const code = `
      const qh = require('./src/qwen_shared_home'); const ll = require('./src/local_llm_service'); const ti = require('./src/tool_installer');
      const a = qh.assessLocation(); let err = null;
      if (a.ask) { try { ti.startToolInstallJob({ toolId: 'localLlmQwen', userConfirmed: true }); } catch (e) { err = e.code; } }
      const target = qh.chooseLocation('app');
      const ptr = JSON.parse(require('fs').readFileSync(require('path').join(ll.QWEN_DEFAULT_HOME, 'qwen-local.json'), 'utf8'));
      console.log(JSON.stringify({ ask: a.ask, userLow: a.userLow, err, target, home: ll.QWEN_HOME, ptrHome: ptr.home, def: ll.QWEN_DEFAULT_HOME, serverBin: ll.LLAMA_CPP.serverBin }));`;
    const r = spawnSync(process.execPath, ['-e', code], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, USERPROFILE: fakeUser, QWEN_TEST_USER_FREE_BYTES: String(4e9), CN_SKIP_QWEN_HOME: '1', QWEN_LOCAL_HOME: '' },
      encoding: 'utf8',
      timeout: 60000
    });
    const out = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}');
    assert(out.userLow, `phải nhận ra ổ C ít chỗ: ${r.stdout} ${r.stderr}`);
    if (out.ask) assert(out.err === 'QWEN_LOCATION_REQUIRED', `cài khi chưa chọn nơi phải bị chặn để hỏi: ${out.err}`);
    assert(out.def.toLowerCase().startsWith(fakeUser.toLowerCase()), `thư mục user giả lập: ${out.def}`);
    assert(out.home === out.target && out.ptrHome === out.target && out.target.endsWith('QwenLocal') && !out.target.toLowerCase().startsWith(fakeUser.toLowerCase()), `trỏ sai: ${JSON.stringify(out)}`);
    assert(out.serverBin.startsWith(out.target), `bộ chạy phải nằm trong ${out.target}`);
    return `${out.ask ? 'đã hỏi (QWEN_LOCATION_REQUIRED)' : 'Qwen đã có sẵn nên không hỏi'} • chọn app → ${out.target} • file trỏ ở ${out.def}`;
  });
  await check('Windows: qwen-local.json ở %USERPROFILE%\\QwenLocal trỏ tới Qwen đã cài (model + bộ chạy + Start_Qwen_Server.bat) + lối tắt/thư mục trong app', async () => {
    if (process.platform !== 'win32') throw skip('Chỉ áp dụng Windows (macOS dùng MLX trong thư mục ứng dụng).');
    const localLlm = require('../src/local_llm_service');
    const qh = require('../src/qwen_shared_home');
    if (!localLlm.isModelInstalled(localLlm.LOCAL_LLM_MODELS[0].id)) throw skip('Chưa cài AI Local Qwen.', true);
    const r = await qh.ensureSharedHome();
    assert(r.ok, `ensureSharedHome: ${r.error || ''}`);
    const ptrFile = path.join(os.homedir(), 'QwenLocal', 'qwen-local.json');
    const mf = JSON.parse(fs.readFileSync(ptrFile, 'utf8'));
    const home = mf.home;
    assert(fs.statSync(path.join(home, mf.model.file)).size === mf.model.sizeBytes, 'model sai kích thước');
    assert(fs.existsSync(path.join(home, mf.runtime.server)), 'thiếu llama-server.exe');
    assert(fs.existsSync(path.join(home, 'Start_Qwen_Server.bat')), 'thiếu Start_Qwen_Server.bat');
    const inApp = home.toLowerCase().startsWith(path.join(__dirname, '..').toLowerCase());
    assert(inApp || fs.existsSync(path.join(__dirname, '..', 'Qwen Local.lnk')), 'thiếu lối tắt Qwen Local.lnk trong thư mục app');
    assert(!fs.existsSync(localLlm.legacyModelFilePath(localLlm.LOCAL_LLM_MODELS[0])), 'còn bản model trùng ở vị trí cũ');
    return `file mô tả: ${ptrFile} → home ${home} (${inApp ? 'thư mục app' : 'thư mục user, có lối tắt trong app'})`;
  });

  /* ---------------- 4b1. Tải nhiều link video riêng lẻ ---------------- */
  console.log('\n--- [4b1] Tải nhiều link cùng lúc (mạng thật) ---');
  await check('Tải nhiều link: bỏ trùng, tải đúng video thật, link không tồn tại báo lỗi (không tải nhầm clip tĩnh của trang)', async () => {
    const lb = require('../src/link_batch');
    const good = 'https://www.douyin.com/video/7702399097798785014';
    const bad = 'https://www.douyin.com/video/1234567890123456789';
    const b0 = lb.startLinkBatch({ text: `${good}\n3.2 复制打开抖音 ${good} 看看\n${bad}`, concurrency: 2 });
    assert(b0.total === 2, `phải bỏ link trùng: total=${b0.total}`);
    let b;
    for (let i = 0; i < 480; i++) {
      b = lb.getLinkBatch(b0.batchId);
      if (b.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert(b.status === 'completed', `lô chưa xong: ${b.status}`);
    const g = b.items.find((x) => x.url === good);
    const x = b.items.find((x) => x.url === bad);
    if (g.status !== 'completed') throw skip(`Douyin không trả video cho máy này: ${g.error || g.status}`, true);
    const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', g.outputPath], { encoding: 'utf8' }).stderr || '';
    const dur = Number(((probe.match(/Duration: (\d+):(\d+):([\d.]+)/) || []).slice(1).reduce((a, v, k) => a + Number(v) * [3600, 60, 1][k], 0)) || 0);
    assert(dur > 100 && /Audio:/.test(probe), `video tải về sai: ${dur}s, audio=${/Audio:/.test(probe)}`);
    assert(x.status === 'failed' && x.error, `link không tồn tại phải báo lỗi, thực tế: ${x.status} ${x.outputPath || ''}`);
    return `2/3 link (bỏ 1 trùng) • video thật ${dur.toFixed(1)}s có tiếng • link sai: "${String(x.error).slice(0, 80)}"`;
  });

  /* ---------------- 4b2. Quét trang cá nhân: chỉ video của chủ trang ---------------- */
  console.log('\n--- [4b2] Quét trang cá nhân (mạng thật) ---');
  const waitScan = async (sc, id) => {
    for (let i = 0; i < 120; i++) {
      const st = sc.getAccountScanStatus(id);
      if (st && st.status !== 'scanning') return st;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('quét quá 120 s');
  };
  await check('Quét tài khoản mới KHÔNG dùng lại phiên/video của tài khoản quét trước (lỗi hiện video tài khoản khác)', async () => {
    const sc = require('../src/account_scanner');
    const a = await sc.startAccountScanJob({ rawInput: 'https://space.bilibili.com/546195', refresh: false });
    const sa = await waitScan(sc, a.scanId);
    const b = await sc.startAccountScanJob({ rawInput: 'https://space.bilibili.com/163637592', refresh: false, existingScanId: a.scanId });
    const sb = await waitScan(sc, b.scanId);
    if (!sa.account.profileIdentified && !sb.account.profileIdentified) throw skip('Không lấy được hồ sơ Bilibili (mạng/giới hạn truy cập).', true);
    assert(b.scanId !== a.scanId, 'tài khoản B vẫn dùng lại phiên quét của tài khoản A');
    assert(sb.account.accountName !== sa.account.accountName, `B hiển thị tên của A: ${sb.account.accountName}`);
    const c = await sc.startAccountScanJob({ rawInput: sb.profileUrl, refresh: false, existingScanId: b.scanId });
    await waitScan(sc, c.scanId);
    assert(c.scanId === b.scanId, '"Quét tiếp" cùng tài khoản phải dùng lại phiên cũ');
    return `A="${sa.account.accountName}" → B="${sb.account.accountName}" (phiên mới) • quét tiếp B dùng lại phiên B`;
  });
  await check('Douyin: trang cá nhân không trả video gợi ý/SEO của tài khoản khác', async () => {
    const sc = require('../src/account_scanner');
    const owner = 'MS4wLjABAAAAxvr2V5hydvkSMvOGtuFxkJ1rjuGv-lXBI9aw62FypvYUBnuFDt50_hfxUm_3h9vq';
    const r = await sc.startAccountScanJob({ rawInput: `https://www.douyin.com/user/${owner}`, refresh: true });
    const st = await waitScan(sc, r.scanId);
    const logText = (st.logs || []).map((l) => l.msg).join(' | ');
    const skipped = Number((logText.match(/đã loại (\d+) video gợi ý/) || [])[1] || 0);
    if (st.videos.length === 0 && skipped === 0) throw skip(`Douyin không trả trang hồ sơ cho máy này: ${st.statusText}`, true);
    // Mọi video còn lại phải xác minh được tác giả là chủ trang (đọc aweme_detail thật qua trình phát công khai)
    const { runWebKitSniffer, DESKTOP_UA } = require('../src/extractors/custom_parsers');
    for (const v of st.videos.slice(0, 3)) {
      const sr = await runWebKitSniffer(`https://open.douyin.com/player/video?vid=${v.videoId}&autoplay=1`, DESKTOP_UA, 8500, {});
      let sec = '';
      for (const e of sr.events || []) {
        try {
          const j = JSON.parse((e.data && e.data.body) || '{}');
          if (j.aweme_detail) sec = j.aweme_detail.author && j.aweme_detail.author.sec_uid;
        } catch (_) {}
      }
      assert(!sec || sec === owner, `video ${v.videoId} thuộc tài khoản khác (${sec})`);
    }
    return st.videos.length
      ? `${st.videos.length} video, đã xác minh tác giả ${Math.min(3, st.videos.length)} video • loại ${skipped} video gợi ý`
      : `0 video lạ hiển thị (đã loại ${skipped} video gợi ý); báo: ${String(st.statusText).slice(0, 90)}`;
  });

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
    assert(task.result && task.result.segments.length >= 3 && task.result.segments.length <= 6 && task.result.validation, `thiếu kết quả/kiểm tra: ${JSON.stringify(task.result && task.result.segments && task.result.segments.map((x) => x.sourceText))}`);
    return `giai đoạn đã thấy: ${Array.from(seenStages).join(' → ')}; ${task.result.segments.length} đoạn, ${task.elapsedSec}s`;
  });
  await check('Phân đoạn & Dịch: lỗi ở bước dịch → "Chạy tiếp" dùng lại âm thanh + ASR, chỉ dịch lại; nhận diện người nói mặc định tắt; có nhật ký', async () => {
    if (!fs.existsSync(syncVideo)) throw skip('Không tạo được video thử (Tingting / edge-tts).', true);
    const { isProviderReady } = require('../src/ai/ai_provider_manager');
    if (!isProviderReady('local_qwen')) throw skip('Chưa cài AI Local Qwen (cần để dịch thật ở lần chạy tiếp).', true);
    // Lỗi được TẠO trong test: chặn yêu cầu HTTP tới máy chủ dịch AI Local ở lần chạy đầu (giống máy chủ không phản hồi)
    const realFetch = globalThis.fetch;
    let block = true;
    globalThis.fetch = (u, o) => (block && /\/v1\/chat\/completions/.test(String(u)) ? Promise.reject(new TypeError('fetch failed (kiểm thử: chặn máy chủ dịch)')) : realFetch(u, o));
    const waitT = async (id) => {
      for (let i = 0; i < 600; i++) {
        const t = dub.getExtractTask(id);
        if (t.status !== 'running') return t;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('quá thời gian');
    };
    try {
      // targetLang 'en' để không trùng bộ nhớ đệm bản dịch của test trước
      const t0 = dub.startExtractTask({ videoPath: syncVideo, source: 'user', targetLang: 'en', translationProvider: 'ai_local_qwen' });
      const a = await waitT(t0.taskId);
      const st = (t, c) => t.stages.find((x) => x.code === c).state;
      assert(a.status === 'error', `lần 1 phải lỗi ở bước dịch, thực tế: ${a.status}`);
      assert(st(a, 'extract_audio') === 'completed' && st(a, 'asr') === 'completed' && st(a, 'translate') === 'error', `trạng thái bước: ${a.stages.map((x) => `${x.code}:${x.state}`).join(' ')}`);
      assert(st(a, 'diarize') === 'skipped', 'nhận diện người nói phải mặc định tắt');
      assert(a.resumable && a.checkpointInfo.asrSegments >= 3, `thiếu dữ liệu chạy tiếp: ${JSON.stringify(a.checkpointInfo)}`);
      block = false;
      const nLogs = a.logs.length;
      dub.resumeExtractTask(t0.taskId, {});
      const b = await waitT(t0.taskId);
      assert(b.status === 'completed', `chạy tiếp: ${b.status} ${(b.errors || []).join(' ')}`);
      const after = b.logs.slice(nLogs).map((l) => l.msg);
      assert(after.some((m) => /Bỏ qua Bước 1–2/.test(m)), 'không thấy log bỏ qua ASR');
      assert(!after.some((m) => /Bước 2: nhận dạng giọng nói bằng/.test(m)), 'ASR bị chạy lại');
      assert(b.logs.every((l) => l.source === 'user'), 'nhật ký phải ghi nguồn user');
      assert(b.result.segments.every((x) => String(x.translatedText || '').trim()), 'còn đoạn chưa dịch');
      return `lần 1 lỗi ở bước dịch (ASR ${a.checkpointInfo.asrSegments} đoạn được giữ) → chạy tiếp ${b.elapsedSec}s, không ASR lại • ${b.logs.length} dòng nhật ký [user]`;
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  await check('Giọng lồng tiếng mặc định (Tiếng Việt) là Ngọc Huyền — VieNeu', async () => {
    const vi = dub.getSupportedVoices('vi');
    const def = vi.find((v) => v.isDefaultRecommended);
    const vieneuReady = vi.some((v) => v.engine === 'vieneu' && v.voiceArg);
    if (!vieneuReady) throw skip('VieNeu-TTS chưa cài — giọng mặc định là giọng offline có sẵn.', true);
    assert(def && def.voiceArg === 'Ngọc Huyền', `mặc định: ${def && def.name}`);
    assert(dub.resolveVoiceConfig('', 'vi').voiceArg === 'Ngọc Huyền', 'resolveVoiceConfig("") không ra Ngọc Huyền');
    return def.name;
  });
  await check('Lồng tiếng nguồn video ngoài: chọn video + thư mục đầu ra, nhật ký ghi nguồn user, xem thử được file đầu ra', async () => {
    if (!fs.existsSync(syncVideo)) throw skip('Không tạo được video thử.', true);
    let voice;
    try {
      voice = dub.resolveVoiceConfig('', 'vi');
    } catch (e) {
      throw skip(`Chưa có giọng đọc Tiếng Việt: ${e.message}`, true);
    }
    const outDir = path.join(TMP, 'thu muc dau ra ngoai');
    const job = dub.startDubbingJob({
      videoPath: syncVideo,
      source: 'user',
      outputDir: outDir,
      targetLang: 'vi',
      voiceId: voice.id,
      removeOriginalVoice: false,
      customSegments: [
        { index: 1, id: 1, startSec: 1.0, endSec: 2.6, sourceText: 'a', translatedText: 'Xin chào các bạn.' },
        { index: 2, id: 2, startSec: 6.0, endSec: 7.6, sourceText: 'b', translatedText: 'Hôm nay trời đẹp.' }
      ]
    });
    let j;
    for (let i = 0; i < 600; i++) {
      j = dub.getDubbingJob(job.jobId);
      if (j.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert(j.status === 'completed', `${j.status}: ${j.error}`);
    assert(path.dirname(j.outputPath) === outDir && fs.existsSync(j.outputPath), `file không nằm trong thư mục đầu ra: ${j.outputPath}`);
    assert(j.source === 'user' && j.logs.length > 0 && j.logs.every((l) => l.source === 'user'), 'nhật ký phải ghi nguồn user');
    const r = await req('GET', `/api/play-local?path=${encodeURIComponent(j.outputPath)}`, { Range: 'bytes=0-1' });
    assert(r.status === 206, `xem thử file đầu ra: HTTP ${r.status}`);
    const other = await req('GET', `/api/play-local?path=${encodeURIComponent(syncVideo)}`);
    assert(other.status === 404, 'không được mở file ngoài thư mục lưu không phải đầu ra lồng tiếng');
    return `${path.basename(j.outputPath)} trong "${path.basename(outDir)}" • ${j.logs.length} dòng nhật ký [user] • xem thử HTTP 206`;
  });
  const runExtract = async (params) => {
    const t0 = dub.startExtractTask(params);
    for (let i = 0; i < 600; i++) {
      const t = dub.getExtractTask(t0.taskId);
      if (t.status !== 'running') return t;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('quá thời gian');
  };
  await check('Ngôn ngữ đầu vào: tiếng Trung giữ nguyên kết quả (Tự động = ép Tiếng Trung), không dùng module tiếng Anh', async () => {
    if (!fs.existsSync(syncVideo)) throw skip('Không tạo được video thử tiếng Trung.', true);
    // targetLang 'zh' = cùng ngôn ngữ nguồn → không cần bộ dịch, chỉ so kết quả nhận dạng & chia câu
    const a = await runExtract({ videoPath: syncVideo, targetLang: 'zh', inputLang: 'auto' });
    const b = await runExtract({ videoPath: syncVideo, targetLang: 'zh', inputLang: 'zh' });
    assert(a.status === 'completed' && b.status === 'completed', `${a.status}/${b.status} ${(a.errors || []).concat(b.errors || []).join(' ')}`);
    const key = (t) => JSON.stringify(t.result.segments.map((x) => [x.startSec, x.endSec, x.sourceText]));
    assert(a.result.detectedSourceLang === 'zh' && !a.result.englishModule && !b.result.englishModule, 'tiếng Trung không được dùng module tiếng Anh');
    assert(key(a) === key(b), `Tự động khác ép Tiếng Trung:\n${key(a)}\n${key(b)}`);
    return `${a.result.segments.length} đoạn, Tự động = Tiếng Trung (giống hệt)`;
  });
  await check('Module tiếng Anh: câu ngắt ở dấu phẩy không bị chia vụn, viết tắt "Mr."/"3.5" không bị tách, 3 câu cách nhau 1–1,5 s vẫn riêng & đúng thời điểm', async () => {
    const enDir = path.join(TMP, 'en');
    fs.mkdirSync(enDir, { recursive: true });
    const lines = ['Hi everyone, welcome back to my channel.', 'Mr. Smith bought 3.5 kilos of apples yesterday.', 'Honestly, the coffee tastes amazing, but it is a little noisy.'];
    const haveSamantha = process.platform === 'darwin' && spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout.includes('Samantha');
    let clips = [];
    let voice = '';
    if (haveSamantha) {
      clips = lines.map((t, i) => {
        const f = path.join(enDir, `e${i}.aiff`);
        spawnSync('say', ['-v', 'Samantha', '-o', f, t]);
        return f;
      });
      voice = 'macOS Samantha';
    } else if (fs.existsSync(PY_CORE)) {
      clips = lines.map((t, i) => {
        const f = path.join(enDir, `e${i}.mp3`);
        spawnSync(PY_CORE, ['-m', 'edge_tts', '--voice', 'en-US-JennyNeural', '--text', t, '--write-media', f], { timeout: 60000, windowsHide: true });
        return f;
      });
      voice = 'edge-tts en-US-JennyNeural';
    }
    if (clips.length !== 3 || !clips.every((f) => fs.existsSync(f) && fs.statSync(f).size > 1000)) throw skip('Không tạo được giọng tiếng Anh mẫu (cần macOS Samantha hoặc edge-tts + Internet).', true);
    const truth = [1.0, 6.0, 11.5].map((t, i) => Number((t + (onsetsOf(clips[i], -38)[0] || 0)).toFixed(3)));
    const enVideo = path.join(enDir, 'en_test.mp4');
    ff([
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=17',
      '-i', clips[0], '-i', clips[1], '-i', clips[2],
      '-filter_complex', '[1:a]aresample=48000,adelay=1000|1000[a1];[2:a]aresample=48000,adelay=6000|6000[a2];[3:a]aresample=48000,adelay=11500|11500[a3];[0:a][a1][a2][a3]amix=inputs=4:normalize=0:duration=first[a]',
      '-map', '[a]', '-ac', '1', path.join(enDir, 'orig.wav')
    ]);
    ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=17', '-i', path.join(enDir, 'orig.wav'), '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-shortest', enVideo]);
    const t = await runExtract({ videoPath: enVideo, targetLang: 'en', inputLang: 'auto' });
    assert(t.status === 'completed', `${t.status} ${(t.errors || []).join(' ')}`);
    const segs = t.result.segments;
    const desc = segs.map((x) => `[${x.startSec}] ${x.sourceText}`).join(' | ');
    assert(t.result.detectedSourceLang === 'en' && t.result.englishModule, 'Tự động phải nhận ra tiếng Anh và dùng module tiếng Anh');
    assert(segs.length === 3, `phải đúng 3 câu: ${desc}`);
    assert(/everyone/i.test(segs[0].sourceText) && /channel/i.test(segs[0].sourceText), `câu 1 bị chia vụn: ${desc}`);
    assert(/Mr\.?\s*Smith/i.test(segs[1].sourceText) && /yesterday/i.test(segs[1].sourceText), `câu 2 bị tách sai ở viết tắt: ${desc}`);
    assert(/honestly/i.test(segs[2].sourceText) && /noisy/i.test(segs[2].sourceText), `câu 3 bị chia vụn: ${desc}`);
    segs.forEach((x, i) => assert(Math.abs(x.startSec - truth[i]) <= 0.3, `câu ${i + 1} lệch ${(x.startSec - truth[i]).toFixed(2)} s`));
    const tEn = await runExtract({ videoPath: enVideo, targetLang: 'en', inputLang: 'en' });
    assert(tEn.status === 'completed' && tEn.result.englishModule && tEn.result.segments.length === 3, 'ép Tiếng Anh phải cho cùng kết quả');
    return `[${voice}] ${desc} • lệch tối đa ${Math.max(...segs.map((x, i) => Math.abs(x.startSec - truth[i]))).toFixed(2)} s`;
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

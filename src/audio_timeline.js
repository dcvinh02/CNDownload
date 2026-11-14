/**
 * Audio Timeline cho lồng tiếng:
 * - scheduleDubSegments(): xếp lịch từng đoạn giọng đọc theo timestamp gốc, không chồng lấn, không cắt câu.
 *   Câu dịch dài hơn khung thời gian: (1) tận dụng khoảng lặng phía sau, (2) bắt đầu sớm tối đa vài trăm ms
 *   nếu có khoảng lặng phía trước, (3) tăng tốc độ đọc có giới hạn (mặc định ≤ 1.3x để giọng không méo),
 *   (4) nếu vẫn dài: đẩy đoạn sau lùi lại (trễ được bù dần ở các khoảng lặng kế tiếp) — KHÔNG cắt nội dung.
 * - writeTimelineWav(): ghi track lồng tiếng hoàn chỉnh dạng stream (bộ nhớ O(1) theo độ dài video),
 *   chuẩn hóa độ to giọng đọc về mức RMS cố định để thanh "Âm lượng lồng tiếng 100%" có ý nghĩa nhất quán.
 * - writeGainEnvelopeWav(): đường bao âm lượng (float32) cho âm thanh gốc: mức nền = âm lượng gốc người dùng chọn,
 *   trong lúc có lời lồng tiếng = mức nền × hệ số ducking (chuyển mượt 80 ms). Không giới hạn số đoạn.
 */

const fs = require('fs');

/* ------------------------------- WAV đọc/ghi ------------------------------- */

function parseWavHeader(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('File không phải WAV RIFF hợp lệ.');
  }
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV thiếu khối fmt trước data.');
      const end = Math.min(buf.length, body + size);
      return { ...fmt, dataOffset: body, dataLength: end - body, declaredDataLength: size };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV không có khối data.');
}

/** Đọc WAV PCM16 mono -> Int16Array */
function readWavPcm16Mono(filePath) {
  const buf = fs.readFileSync(filePath);
  const h = parseWavHeader(buf);
  if (h.audioFormat !== 1 || h.bitsPerSample !== 16 || h.channels !== 1) {
    throw new Error(`WAV phải là PCM16 mono (nhận format=${h.audioFormat}, bits=${h.bitsPerSample}, ch=${h.channels}).`);
  }
  const samples = new Int16Array(buf.buffer.slice(buf.byteOffset + h.dataOffset, buf.byteOffset + h.dataOffset + h.dataLength - (h.dataLength % 2)));
  return { sampleRate: h.sampleRate, samples };
}

function wavDurationSec(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const h = parseWavHeader(head.subarray(0, n));
    const stat = fs.fstatSync(fd);
    const available = Math.max(0, stat.size - h.dataOffset);
    const declared = h.declaredDataLength;
    // FFmpeg khi ghi qua pipe có thể để size = 0 hoặc 0xFFFFFFFF -> dùng kích thước thực của file
    const dataLen = declared > 0 && declared !== 0xffffffff ? Math.min(declared, available) : available;
    const bytesPerFrame = (h.bitsPerSample / 8) * h.channels;
    return dataLen / bytesPerFrame / h.sampleRate;
  } finally {
    fs.closeSync(fd);
  }
}

function wavHeader({ sampleRate, channels, bitsPerSample, audioFormat, dataBytes }) {
  const h = Buffer.alloc(44);
  const blockAlign = (channels * bitsPerSample) / 8;
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(audioFormat, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/* --------------------------------- Lập lịch -------------------------------- */

/**
 * @param {Array<{startSec:number,endSec:number,naturalSec:number}>} segs  đã sắp theo startSec
 * @param {number} totalDurationSec
 * @param {{maxTempo?:number,lastMaxTempo?:number,maxEarlySec?:number,gapSec?:number}} opts
 * @returns {Array<{placedStartSec:number,tempo:number,finalSec:number,delaySec:number,overflowSec:number}>}
 */
function scheduleDubSegments(segs, totalDurationSec, opts = {}) {
  const maxTempo = Math.max(1, Number(opts.maxTempo) || 1.3);
  const lastMaxTempo = Math.max(maxTempo, Number(opts.lastMaxTempo) || 1.6);
  const maxEarly = Math.max(0, Number(opts.maxEarlySec ?? 0.25));
  const gap = Math.max(0, Number(opts.gapSec ?? 0.06));
  const total = Math.max(0.5, Number(totalDurationSec) || 0);
  const out = [];
  let cursor = 0; // thời điểm sớm nhất đoạn kế tiếp được phép bắt đầu

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const natural = Math.max(0.01, Number(seg.naturalSec) || 0.01);
    const origStart = Math.max(0, Number(seg.startSec) || 0);
    const next = segs[i + 1];
    const isLast = !next;
    const limitEnd = (next ? Math.max(origStart, Number(next.startSec) || 0) : total) - (next ? gap : 0);

    let start = Math.max(origStart, cursor);
    let avail = limitEnd - start;
    if (natural > avail) {
      const earliest = Math.max(cursor, origStart - maxEarly);
      if (earliest < start) {
        start = earliest;
        avail = limitEnd - start;
      }
    }
    const tempoCap = isLast ? lastMaxTempo : maxTempo;
    let tempo = 1;
    if (natural > avail) {
      tempo = avail > 0.05 ? Math.min(tempoCap, natural / avail) : tempoCap;
      tempo = Math.max(1, tempo);
      if (tempo < 1.03) tempo = 1; // chênh lệch không đáng kể -> giữ nguyên giọng
    }
    const finalSec = natural / tempo;
    const end = start + finalSec;
    out.push({
      placedStartSec: Number(start.toFixed(3)),
      tempo: Number(tempo.toFixed(3)),
      finalSec: Number(finalSec.toFixed(3)),
      delaySec: Number(Math.max(0, start - origStart).toFixed(3)),
      overflowSec: Number(Math.max(0, end - limitEnd).toFixed(3))
    });
    cursor = end + gap;
  }
  return out;
}

/* ------------------------------ Ghi track dub ------------------------------ */

/**
 * @param {Array<{wavPath:string, placedStartSec:number}>} placed  WAV PCM16 mono cùng sampleRate
 * @param {number} totalDurationSec
 * @param {string} outPath
 * @param {{sampleRate?:number,targetRmsDbfs?:number}} opts
 */
function writeTimelineWav(placed, totalDurationSec, outPath, opts = {}) {
  const sampleRate = opts.sampleRate || 48000;
  const targetRms = 10 ** ((opts.targetRmsDbfs ?? -20) / 20);
  const sorted = [...placed].sort((a, b) => a.placedStartSec - b.placedStartSec);

  // Lượt 1: đo RMS (chỉ trên mẫu có tiếng) và đỉnh để tính hệ số chuẩn hóa chung
  let sumSq = 0;
  let count = 0;
  let peak = 0;
  for (const p of sorted) {
    const { sampleRate: sr, samples } = readWavPcm16Mono(p.wavPath);
    if (sr !== sampleRate) throw new Error(`Đoạn ${p.wavPath} có sampleRate ${sr}, cần ${sampleRate}.`);
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] / 32768;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a > 0.003) {
        sumSq += v * v;
        count++;
      }
    }
  }
  const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
  let gain = rms > 1e-5 ? targetRms / rms : 1;
  if (peak > 0) gain = Math.min(gain, 0.97 / peak);
  gain = Math.max(0.05, Math.min(gain, 20));

  // Lượt 2: ghi tuần tự (đoạn đã được lập lịch không chồng lấn; nếu có chồng lấn nhỏ thì cộng dồn trong vùng chồng)
  const lastEndSec = sorted.reduce((m, p) => Math.max(m, p.placedStartSec + (p.finalSec || 0)), 0);
  const totalSamples = Math.ceil(Math.max(totalDurationSec, lastEndSec) * sampleRate) + Math.round(sampleRate * 0.25);
  const fd = fs.openSync(outPath, 'w');
  try {
    fs.writeSync(fd, wavHeader({ sampleRate, channels: 1, bitsPerSample: 16, audioFormat: 1, dataBytes: totalSamples * 2 }));
    let written = 0; // số mẫu đã ghi
    let pending = null; // phần đuôi đoạn trước chưa ghi (khi đoạn sau chồng lên)
    const writeSilence = (n) => {
      const CH = 48000;
      const zero = Buffer.alloc(CH * 2);
      while (n > 0) {
        const k = Math.min(n, CH);
        fs.writeSync(fd, zero, 0, k * 2);
        n -= k;
        written += k;
      }
    };
    const toBuf = (floatLike) => {
      const b = Buffer.alloc(floatLike.length * 2);
      for (let i = 0; i < floatLike.length; i++) {
        let v = Math.round(floatLike[i] * gain);
        if (v > 32767) v = 32767;
        else if (v < -32768) v = -32768;
        b.writeInt16LE(v, i * 2);
      }
      return b;
    };
    for (const p of sorted) {
      const { samples } = readWavPcm16Mono(p.wavPath);
      let startSample = Math.max(0, Math.round(p.placedStartSec * sampleRate));
      let data = Float32Array.from(samples);
      if (pending) {
        const pendStart = pending.start;
        if (startSample < pendStart + pending.data.length) {
          // trộn phần chồng lấn
          const mixStart = Math.max(startSample, pendStart);
          const mergedLen = Math.max(pendStart + pending.data.length, startSample + data.length) - pendStart;
          const merged = new Float32Array(mergedLen);
          merged.set(pending.data, 0);
          for (let i = 0; i < data.length; i++) merged[startSample - pendStart + i] += data[i];
          pending = { start: pendStart, data: merged };
          void mixStart;
          continue;
        }
        if (pendStart > written) writeSilence(pendStart - written);
        fs.writeSync(fd, toBuf(pending.data));
        written += pending.data.length;
        pending = null;
      }
      if (startSample < written) startSample = written;
      pending = { start: startSample, data };
    }
    if (pending) {
      if (pending.start > written) writeSilence(pending.start - written);
      const remain = Math.min(pending.data.length, totalSamples - written);
      if (remain > 0) {
        fs.writeSync(fd, toBuf(pending.data.subarray(0, remain)));
        written += remain;
      }
    }
    if (written < totalSamples) writeSilence(totalSamples - written);
  } finally {
    fs.closeSync(fd);
  }
  return { outPath, gainApplied: Number(gain.toFixed(4)), measuredRmsDbfs: rms > 0 ? Number((20 * Math.log10(rms)).toFixed(2)) : null, peak: Number(peak.toFixed(4)) };
}

/* --------------------------- Đường bao âm lượng gốc --------------------------- */

/**
 * @param {Array<{s:number,e:number}>} windows  khoảng thời gian có lời lồng tiếng (giây)
 * @param {number} totalDurationSec
 * @param {number} baseGain   âm lượng gốc (0..2)
 * @param {number} duckGain   âm lượng gốc khi có lời lồng tiếng (0..baseGain)
 */
function writeGainEnvelopeWav(windows, totalDurationSec, baseGain, duckGain, outPath, opts = {}) {
  const rate = opts.rate || 1000;
  const ramp = Math.max(1, Math.round((opts.rampSec ?? 0.08) * rate));
  const n = Math.ceil((Math.max(0.5, totalDurationSec) + 1.0) * rate);
  const env = new Float32Array(n).fill(baseGain);
  const sorted = (windows || []).filter((w) => w.e > w.s).sort((a, b) => a.s - b.s);
  // Gộp các khoảng gần nhau (< 0.35s) để tiếng gốc không "nhấp nhô"
  const merged = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.s <= last.e + 0.35) last.e = Math.max(last.e, w.e);
    else merged.push({ s: w.s, e: w.e });
  }
  for (const w of merged) {
    const a = Math.max(0, Math.round(w.s * rate) - ramp);
    const b = Math.min(n, Math.round(w.e * rate) + ramp);
    for (let i = a; i < b; i++) {
      let g;
      if (i < a + ramp) g = baseGain + (duckGain - baseGain) * ((i - a) / ramp);
      else if (i >= b - ramp) g = duckGain + (baseGain - duckGain) * ((i - (b - ramp)) / ramp);
      else g = duckGain;
      if (g < env[i]) env[i] = g;
    }
  }
  const data = Buffer.from(env.buffer, env.byteOffset, env.byteLength);
  fs.writeFileSync(outPath, Buffer.concat([wavHeader({ sampleRate: rate, channels: 1, bitsPerSample: 32, audioFormat: 3, dataBytes: data.length }), data]));
  return { outPath, windows: merged.length };
}

module.exports = {
  parseWavHeader,
  readWavPcm16Mono,
  wavDurationSec,
  scheduleDubSegments,
  writeTimelineWav,
  writeGainEnvelopeWav
};

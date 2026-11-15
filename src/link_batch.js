/**
 * Tải nhiều link video riêng lẻ cùng lúc (dán nhiều link / nhiều đoạn văn bản chia sẻ).
 * Mỗi link chạy đúng quy trình của nút "Trích xuất & Tải": phân tích → chọn luồng tốt nhất → tải & xác minh.
 * Giới hạn số link chạy song song và nghỉ giữa các lần phân tích để tôn trọng giới hạn truy cập của nền tảng.
 */
const { analyzeVideo, downloadFromLink, cancelDownloadJob, activeDownloads } = require('./extractors');
const { detectPlatform } = require('./extractors/platforms');

const MAX_LINKS = 200;
const ANALYZE_GAP_MS = 1200; // nghỉ giữa 2 lần phân tích (tránh bị nền tảng chặn vì gửi dồn dập)
const batches = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lấy tất cả link http(s) trong văn bản (mỗi dòng 1 link hoặc cả đoạn chia sẻ của app), bỏ trùng. */
function extractAllUrls(text) {
  const found = String(text || '').match(/https?:\/\/[^\s"'<>，。！？、；：（）【】《》「」]+/gi) || [];
  const out = [];
  const seen = new Set();
  for (let u of found) {
    u = u.replace(/[),.;!?\]}>]+$/, '');
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function serialize(b) {
  if (!b) return null;
  const counts = b.items.reduce((m, it) => ((m[it.status] = (m[it.status] || 0) + 1), m), {});
  return {
    batchId: b.batchId,
    status: b.status,
    outputFormat: b.outputFormat,
    concurrency: b.concurrency,
    total: b.items.length,
    counts,
    done: (counts.completed || 0) + (counts.failed || 0) + (counts.cancelled || 0),
    startedAt: b.startedAt,
    finishedAt: b.finishedAt,
    items: b.items.map((it) => {
      const job = it.jobId ? activeDownloads.get(it.jobId) : null;
      return {
        index: it.index,
        url: it.url,
        platformName: it.platformName,
        status: it.status,
        title: it.title,
        quality: it.quality,
        jobId: it.jobId,
        progress: job ? job.progress : it.status === 'completed' ? 100 : 0,
        speedText: job ? job.speedText : '',
        outputPath: job ? job.outputPath : it.outputPath || '',
        partialWarning: job ? job.partialWarning || null : null,
        error: it.error
      };
    })
  };
}

async function runItem(b, it) {
  if (b.cancelled) return;
  it.status = 'analyzing';
  try {
    // Nghỉ giữa các lần phân tích (dùng chung cho cả lô)
    const wait = b.nextAnalyzeAt - Date.now();
    b.nextAnalyzeAt = Math.max(Date.now(), b.nextAnalyzeAt) + ANALYZE_GAP_MS;
    if (wait > 0) await sleep(wait);
    if (b.cancelled) return;
    const analysis = await analyzeVideo({ rawInput: it.url });
    if (b.cancelled) return;
    it.platformName = analysis.platformName || it.platformName;
    it.title = (analysis.data && analysis.data.title) || it.title;
    const res = await downloadFromLink({ url: it.url, outputFormat: b.outputFormat, analysis });
    it.quality = (res.chosen && (res.chosen.quality || res.chosen.label)) || 'Mặc định';
    it.jobId = res.job && res.job.jobId;
    it.status = 'downloading';
    // Chờ tải xong để giữ đúng số link chạy song song
    for (;;) {
      const job = activeDownloads.get(it.jobId);
      if (!job) break;
      if (job.status === 'completed') {
        it.status = 'completed';
        it.outputPath = job.outputPath;
        break;
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        it.status = job.status === 'cancelled' ? 'cancelled' : 'failed';
        it.error = job.error || (job.status === 'cancelled' ? 'Đã hủy' : 'Tải thất bại');
        if (it.status === 'failed' && !res.chosen) {
          it.error = `Không tìm thấy video ở link này (link sai, video đã bị xóa/đặt riêng tư, hoặc nền tảng yêu cầu đăng nhập). Chi tiết: ${it.error}`;
        }
        break;
      }
      await sleep(700);
    }
  } catch (err) {
    if (b.cancelled) return;
    it.status = 'failed';
    it.error = String(err.message || err).slice(0, 400);
  }
}

function startLinkBatch({ text = '', links = null, outputFormat = 'mp4', concurrency = 2 } = {}) {
  const urls = Array.isArray(links) && links.length ? extractAllUrls(links.join('\n')) : extractAllUrls(text);
  if (urls.length === 0) throw new Error('Không tìm thấy link video nào (link phải bắt đầu bằng http:// hoặc https://).');
  if (urls.length > MAX_LINKS) throw new Error(`Tối đa ${MAX_LINKS} link mỗi lần (đang có ${urls.length}).`);
  const batchId = `links_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const b = {
    batchId,
    status: 'running',
    outputFormat: String(outputFormat || 'mp4').toLowerCase(),
    concurrency: Math.min(3, Math.max(1, Number(concurrency) || 2)),
    cancelled: false,
    nextAnalyzeAt: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    items: urls.map((url, i) => {
      let platformName = '';
      try {
        const p = detectPlatform(url);
        platformName = (p && p.name) || '';
      } catch (_) {}
      return { index: i + 1, url, platformName, status: 'pending', title: '', quality: '', jobId: null, error: null };
    })
  };
  batches.set(batchId, b);

  (async () => {
    let cursor = 0;
    const worker = async () => {
      while (!b.cancelled && cursor < b.items.length) {
        const it = b.items[cursor++];
        await runItem(b, it);
      }
    };
    await Promise.all(Array.from({ length: b.concurrency }, worker));
    b.status = b.cancelled ? 'cancelled' : 'completed';
    b.finishedAt = new Date().toISOString();
  })();
  return serialize(b);
}

function getLinkBatch(batchId) {
  return serialize(batches.get(batchId));
}

function cancelLinkBatch(batchId) {
  const b = batches.get(batchId);
  if (!b) return { success: false, error: 'Không tìm thấy lô tải.' };
  b.cancelled = true;
  for (const it of b.items) {
    if (it.status === 'pending' || it.status === 'analyzing') {
      it.status = 'cancelled';
      it.error = 'Đã hủy';
    } else if (it.status === 'downloading' && it.jobId) {
      try {
        cancelDownloadJob(it.jobId);
      } catch (_) {}
      it.status = 'cancelled';
      it.error = 'Đã hủy';
    }
  }
  return { success: true, batch: serialize(b) };
}

module.exports = { extractAllUrls, startLinkBatch, getLinkBatch, cancelLinkBatch };

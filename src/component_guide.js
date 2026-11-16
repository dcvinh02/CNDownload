/**
 * Hướng dẫn từng thành phần cài thêm (môi trường / model): tác dụng, dung lượng thật, khuyến nghị có nên cài
 * theo máy của người dùng — dùng chung cho cài đặt trong Terminal (scripts/setup.js) và giao diện app (🧰 Công cụ).
 *
 * Lựa chọn của người dùng (thành phần đã từ chối) lưu ở config/setup_choices.json để lần sau không hỏi lại;
 * trong app vẫn hiện thành phần đó kèm nút cài nếu đổi ý.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = process.env.CN_AI_CONFIG_DIR || path.join(PROJECT_ROOT, 'config');
const CHOICES_FILE = path.join(CONFIG_DIR, 'setup_choices.json');
const IS_WIN = process.platform === 'win32';

/** Dung lượng chiếm trên đĩa đo thực tế sau khi cài (MB). */
const DISK_MB = {
  windowsApp: 1.2,
  pythonCore: 370,
  ytdlp: 36,
  ffmpeg: 44,
  webkitSniffer: 0.1,
  localAsrSmall: 464,
  subtitleOcr: 16,
  speakerDiarization: 45,
  voiceSeparation: 38,
  localTts: 36,
  vieneuTts: 1200,
  localLlmQwen: IS_WIN ? 5800 : 6000
};

/** Thành phần cần "Môi trường Python AI" để chạy. */
const REQUIRES = {
  localAsrSmall: ['pythonCore'],
  subtitleOcr: ['pythonCore'],
  speakerDiarization: ['pythonCore'],
  voiceSeparation: ['pythonCore'],
  localTts: ['pythonCore'],
  vieneuTts: ['pythonCore'],
  localLlmQwen: ['pythonCore']
};

const PURPOSE = {
  windowsApp: 'Mở app như một phần mềm độc lập: file CNVideoScraperPro.exe có cửa sổ riêng (không mở Edge, không có cửa sổ dòng lệnh đen), đóng cửa sổ là tắt hẳn. Lối tắt Desktop trỏ vào file này.',
  pythonCore: 'Nền tảng chạy các mô hình AI trên máy (nhận dạng giọng nói, tách giọng, giọng đọc). Không cài vẫn TẢI VIDEO được, nhưng không dùng được "Phân đoạn & Dịch" và "Lồng tiếng".',
  ytdlp: 'Công cụ tải video chính (Bilibili, YouTube, Youku, WeTV…) và tải hàng loạt.',
  ffmpeg: 'Ghép hình + tiếng, chuyển đổi định dạng, xuất video lồng tiếng.',
  webkitSniffer: 'Trình duyệt ẩn của macOS để lấy video Douyin / Kuaishou / Xiaohongshu và quét trang cá nhân.',
  localAsrSmall: 'Nhận dạng lời nói trong video (Whisper small) — bước đầu của "Phân đoạn & Dịch" để lồng tiếng.',
  subtitleOcr: 'Đọc lời thoại từ PHỤ ĐỀ CHỮ TRUNG in sẵn trong video (OCR) thay vì nghe — chính xác hơn nhiều khi video có tiếng địa phương hoặc nhạc nền. Tự bỏ qua chữ ngoài vùng phụ đề (biển hiệu, logo).',
  speakerDiarization: 'Phân biệt nhiều người nói để mỗi người một giọng lồng tiếng (trong app mặc định TẮT).',
  voiceSeparation: 'Tách lời nói gốc khỏi nhạc nền — video lồng tiếng chỉ còn giọng mới + nhạc/tiếng động gốc.',
  localTts: 'Giọng đọc tiếng Việt nhẹ (Piper) — dự phòng khi không có VieNeu.',
  vieneuTts: 'Giọng đọc tiếng Việt tự nhiên 48 kHz (giọng mặc định Ngọc Huyền) để lồng tiếng.',
  localLlmQwen: 'AI dịch Trung/Anh → Việt ngay trên máy (Qwen3.5 9B), không cần API Key, không gửi dữ liệu ra ngoài.'
};

function loadChoices() {
  try {
    const j = JSON.parse(fs.readFileSync(CHOICES_FILE, 'utf8'));
    return { declined: Array.isArray(j.declined) ? j.declined : [], updatedAt: j.updatedAt || null };
  } catch (_) {
    return { declined: [], updatedAt: null };
  }
}

function saveChoices({ declined = [] } = {}) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const data = { declined: Array.from(new Set(declined)), updatedAt: new Date().toISOString() };
  fs.writeFileSync(CHOICES_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

/** Bỏ một thành phần khỏi danh sách đã từ chối (khi người dùng cài từ app). */
function clearDeclined(id) {
  const c = loadChoices();
  if (!c.declined.includes(id)) return c;
  return saveChoices({ declined: c.declined.filter((x) => x !== id) });
}

/** Người dùng đã có API Key AI đám mây (Gemini / ChatGPT / API tương thích ngoài máy) chưa. */
function hasCloudAiKey() {
  try {
    const ai = require('./ai/ai_provider_manager');
    if (['gemini', 'openai'].some((p) => ai.isProviderReady(p))) return true;
    return ai.isProviderReady('openai_compatible') && !ai.isLocalProvider('openai_compatible');
  } catch (_) {
    return false;
  }
}

function machineContext(extra = {}) {
  return {
    ramGB: os.totalmem() / 1024 ** 3,
    platform: process.platform,
    hasCloudAiKey: hasCloudAiKey(),
    ...extra
  };
}

/**
 * Khuyến nghị cho 1 thành phần trên máy này.
 * level: 'required' (cần cho chức năng cơ bản) | 'recommended' | 'optional' | 'not_needed'
 * ctx.selected: Set id đã chọn cài/đã có (để khuyến nghị phụ thuộc lẫn nhau, vd. Piper khi đã có VieNeu)
 */
function recommend(id, ctx) {
  const sel = ctx.selected || new Set();
  switch (id) {
    case 'windowsApp':
      return { level: 'recommended', text: 'Nên cài — rất nhẹ (~1 MB), giúp mở app như phần mềm bình thường thay vì cửa sổ Edge.' };
    case 'ytdlp':
    case 'ffmpeg':
      return { level: 'required', text: 'Nên cài — cần cho chức năng tải video cơ bản.' };
    case 'webkitSniffer':
      return { level: 'recommended', text: 'Nên cài nếu bạn tải video Douyin / Kuaishou / Xiaohongshu (rất nhẹ; cần Xcode Command Line Tools).' };
    case 'pythonCore':
      return { level: 'recommended', text: 'Nên cài nếu bạn dùng Lồng tiếng / Phân đoạn & Dịch. Chỉ tải video thì không cần.' };
    case 'localAsrSmall':
      return { level: 'recommended', text: 'Nên cài nếu bạn dùng Lồng tiếng (bắt buộc cho Phân đoạn & Dịch).' };
    case 'vieneuTts':
      return { level: 'recommended', text: 'Nên cài nếu bạn lồng tiếng sang tiếng Việt (giọng đọc chính của app).' };
    case 'voiceSeparation':
      return { level: 'recommended', text: 'Nên cài nếu bạn lồng tiếng (nhẹ, giúp bỏ giọng gốc).' };
    case 'subtitleOcr':
      return { level: 'recommended', text: 'Nên cài nếu bạn lồng tiếng video Douyin/Kuaishou có phụ đề in sẵn (rất nhẹ, ~16 MB).' };
    case 'speakerDiarization':
      return { level: 'optional', text: 'Không cần, trừ khi bạn hay lồng video nhiều nhân vật và muốn mỗi người một giọng.' };
    case 'localTts':
      return sel.has('vieneuTts')
        ? { level: 'not_needed', text: 'Không cần — đã có giọng VieNeu tốt hơn.' }
        : { level: 'recommended', text: 'Nên cài nếu KHÔNG cài VieNeu (giọng đọc tiếng Việt nhẹ thay thế).' };
    case 'localLlmQwen':
      if (ctx.hasCloudAiKey) return { level: 'not_needed', text: 'Không cần — bạn đã có API Key AI (Gemini/ChatGPT) để dịch. Chỉ cài nếu muốn dịch không cần mạng.' };
      if (ctx.ramGB < 15) return { level: 'optional', text: `Không khuyến nghị: máy có ${ctx.ramGB.toFixed(0)} GB RAM (Qwen cần ~8 GB trống, dịch sẽ chậm). Nên dùng Gemini miễn phí qua AI Studio.` };
      return { level: 'optional', text: 'Tùy chọn: cài nếu muốn dịch hoàn toàn trên máy, không cần API Key. Có API Key Gemini (miễn phí) thì không cần.' };
    default:
      return { level: 'optional', text: 'Tùy chọn.' };
  }
}

const LEVEL_LABEL = { required: 'Nên cài (cơ bản)', recommended: 'Nên cài', optional: 'Tùy chọn', not_needed: 'Không cần' };

/** Gắn tác dụng / dung lượng / khuyến nghị / phụ thuộc / đã từ chối vào danh mục công cụ. */
function annotate(tools, ctx = machineContext()) {
  const choices = loadChoices();
  const selected = new Set((ctx.selected ? Array.from(ctx.selected) : []).concat(tools.filter((t) => t.installed).map((t) => t.id)));
  const c2 = { ...ctx, selected };
  return tools.map((t) => {
    const rec = recommend(t.id, c2);
    return {
      ...t,
      purpose: PURPOSE[t.id] || t.description || '',
      diskSizeMB: DISK_MB[t.id] ?? t.estimatedSizeMB ?? null,
      requires: REQUIRES[t.id] || [],
      recommendation: { ...rec, label: LEVEL_LABEL[rec.level] },
      userDeclined: !t.installed && choices.declined.includes(t.id)
    };
  });
}

function fmtSize(mb) {
  if (mb === null || mb === undefined) return '?';
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  if (mb < 1) return '< 1 MB';
  return `${Math.round(mb)} MB`;
}

module.exports = { DISK_MB, REQUIRES, PURPOSE, LEVEL_LABEL, CHOICES_FILE, loadChoices, saveChoices, clearDeclined, hasCloudAiKey, machineContext, recommend, annotate, fmtSize };

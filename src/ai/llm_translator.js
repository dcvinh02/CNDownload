/**
 * Dịch phân đoạn lời thoại video bằng AI Text (Gemini / OpenAI / tương thích OpenAI).
 *
 * Nguyên tắc bảo toàn cấu trúc:
 * - Mỗi phân đoạn gửi đi có `id`, `start`, `end`, `speaker_id`, `source_text`, `translated_text` (rỗng).
 * - AI chỉ được điền `translated_text`. Kết quả được kiểm tra: đủ số lượng, đúng ID, đúng thứ tự.
 * - Timestamp KHÔNG bao giờ lấy từ AI — hệ thống giữ nguyên timestamp gốc và chỉ ghép văn bản dịch theo ID.
 * - Dịch theo lô (chunk) kèm ngữ cảnh câu trước/sau để giữ mạch hội thoại với video dài.
 * - Lô bị sai cấu trúc sẽ được gửi lại kèm thông báo lỗi; nếu vẫn sai thì chia đôi lô cho tới từng đoạn.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateText, parseJsonFromModel, AiProviderError, isLocalProvider, isProviderReady, primaryProviderFor, loadSettings } = require('./ai_provider_manager');
const LOCAL_AI_ID = 'local_qwen';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(process.env.CN_AI_CONFIG_DIR || path.join(PROJECT_ROOT, 'config'), 'ai_cache', 'translation');
const PROMPT_VERSION = 'v3-2026-11-17';

const LANG_NAMES_VI = {
  zh: 'tiếng Trung',
  vi: 'tiếng Việt',
  en: 'tiếng Anh',
  ja: 'tiếng Nhật',
  ko: 'tiếng Hàn'
};

// Prompt dịch lồng tiếng (bản 3, 2026-11-17): giữ nguyên các yêu cầu gốc của người dùng + hướng dẫn chất lượng
// (đọc cả kịch bản trước, xưng hô nhất quán, câu bị cắt qua nhiều phân đoạn, phương ngữ/khẩu ngữ, chơi chữ).
const DUBBING_TRANSLATION_PROMPT = `Đóng vai là một phiên dịch viên lồng tiếng phim chuyên nghiệp, nhiều năm kinh nghiệm dịch thoại phim, video ngắn và hài.

Nhiệm vụ: dịch lời thoại của video từ ngôn ngữ nguồn sang ngôn ngữ đích để lồng tiếng (đọc bằng giọng TTS).

CÁCH LÀM:
1. Đọc TOÀN BỘ kịch bản trước khi dịch: nắm bối cảnh, ai đang nói với ai, quan hệ và tính cách nhân vật, giọng điệu cảnh (hài, căng thẳng, trang trọng...).
2. Dịch theo Ý của cả câu/cả lượt thoại, không dịch máy móc từng chữ. Người xem phải hiểu ngay khi nghe, câu không được cụt nghĩa hay tối nghĩa.
3. Một câu nói bị phụ đề cắt qua NHIỀU phân đoạn liên tiếp: hiểu cả câu, rồi chia phần nghĩa tương ứng vào từng phân đoạn theo đúng thứ tự, sao cho đọc nối liền vẫn là một câu tự nhiên. Không dồn nghĩa của đoạn này sang đoạn khác.
4. Xưng hô (đặc biệt khi dịch sang tiếng Việt): chọn theo quan hệ và giọng điệu, giữ NHẤT QUÁN giữa cùng các nhân vật trong suốt video.
   - 老板 = ông chủ / bà chủ / chủ quán (người bán hàng, chủ tiệm), KHÔNG dịch "chủ nhân"; 老大 = đại ca / sếp; 兄弟 = anh em / người anh em; 大师 = đại sư; 师傅 = sư phụ (cổ trang) hoặc bác tài / thợ (hiện đại).
   - 老子 khi tự xưng = "ông đây" / "tao" (ngạo mạn, cục cằn), không phải "Lão Tử".
5. Khẩu ngữ, tiếng lóng, phương ngữ (Tứ Xuyên, Đông Bắc...): dịch đúng nghĩa thực. Ví dụ: 做啥子 = làm gì; 晓得 = biết; 莫 = đừng; 没得 = không có; 要得 = được đấy; 巴适 = sướng/tuyệt; 脑壳 = cái đầu; 咋个 = sao/thế nào. Trợ từ cuối câu (嗦, 噻, 嘛, 嘞, 哈, 咯) chuyển thành sắc thái tương ứng (à, mà, chứ, nhé, đấy...), không bỏ mất giọng điệu.
6. Thành ngữ, tục ngữ, câu nói quen thuộc: dùng cách nói tương đương tự nhiên của ngôn ngữ đích. Chơi chữ / câu gây cười: giữ được cái ý gây cười, không dịch nghĩa đen làm mất chuyện.
7. Câu cảm thán, tiếng kêu (嗯, 啊, 哎, 嘿嘿, 呃...): dịch thành từ cảm thán ngắn tương ứng (Ừ, À, Ơ, Hì hì, Ờ...).
8. Giữ nguyên số liệu, tên thương hiệu quốc tế; tên người, địa danh, danh hiệu Trung Quốc dùng âm Hán-Việt (苏无名 → Tô Vô Danh, 长安 → Trường An). Không tự thêm, bớt hay suy diễn nội dung; không giải thích, không bình luận.
9. Độ dài: câu dịch nên vừa thời lượng của đoạn (xem "max_length_hint"); ưu tiên câu gọn nhưng KHÔNG được bỏ ý chính.

ĐẶC BIỆT QUAN TRỌNG - GIỮ NGUYÊN CẤU TRÚC DỮ LIỆU:
- Không thay đổi số lượng phân đoạn, ID hay thứ tự các phân đoạn.
- Không gộp nhiều phân đoạn thành một, không tách một phân đoạn thành nhiều.
- Mốc thời gian do hệ thống giữ nguyên; chỉ trả về bản dịch theo ID.
- Kết quả là MỘT đối tượng JSON duy nhất, không có chữ nào bên ngoài JSON.

QUY TẮC BẮT BUỘC CHO "translated_text":
- CHỈ chứa đúng câu sẽ được đọc lồng tiếng: không ghi chú, không ngoặc giải thích, không phiên âm, không chép lại câu gốc, không tiền tố như "Dịch:".
- Dịch sang tiếng Việt thì KHÔNG được còn sót chữ Hán/Nhật/Hàn.
- Mỗi phân đoạn đúng một bản dịch, không lặp từ vô nghĩa.`;

const STYLE_NOTES = {
  natural: 'Văn phong: khẩu ngữ tự nhiên, đời thường, như người bản ngữ đang nói chuyện.',
  serious: 'Văn phong: NGHIÊM TÚC, trang trọng, chuẩn mực (tin tức, tài liệu, phóng sự, giáo dục): câu rõ ràng, dùng từ chính xác, không dùng tiếng lóng hay đùa cợt; xưng hô lịch sự (tôi, chúng tôi, quý vị, các bạn).',
  comic: 'Văn phong: HÀI HƯỚC / COMIC: lời thoại nhí nhảnh, đậm chất khẩu ngữ, được dùng tiếng lóng thông dụng và cách nói vui của giới trẻ để tạo tiếng cười; giữ trọn ý và nhịp gây cười (punchline) của câu gốc, không biến thành câu nghiêm túc.',
  ancient: 'Văn phong: CỔ TRANG / KIẾM HIỆP: xưng hô cổ (ta, ngươi, huynh, đệ, tỷ, muội, tại hạ, các hạ, bổn tọa...), dùng từ Hán-Việt vừa phải, câu có không khí cổ phong nhưng vẫn dễ nghe; nếu cảnh mang tính gây cười thì vẫn giữ cái hài.',
  review: 'Văn phong: review / giới thiệu chuyên nghiệp, mạch lạc, súc tích.',
  story: 'Văn phong: kể chuyện / thuyết minh mượt mà, giàu nhịp điệu.',
  youth: 'Văn phong: TRẺ TRUNG / MẠNG XÃ HỘI (vlog, TikTok): năng động, gần gũi, xưng "mình – các bạn", có thể dùng từ ngữ mạng thông dụng nhưng không thô tục.'
};

const LANG_EN = { zh: 'Chinese', vi: 'Vietnamese', en: 'English', ja: 'Japanese', ko: 'Korean' };

// Chỉ thêm khi ngôn ngữ nguồn là TIẾNG ANH (video tiếng Trung không bị ảnh hưởng)
const ENGLISH_SOURCE_NOTES = [
  'Lưu ý riêng cho nguồn tiếng Anh:',
  '- Bỏ các từ đệm vô nghĩa khi nói (um, uh, like, you know, I mean, basically, actually khi chỉ để đệm) nhưng giữ đủ ý.',
  '- Tên người, thương hiệu, sản phẩm, tên kênh và thuật ngữ đã quen dùng trong tiếng Việt (iPhone, YouTube, review, AI, vlog...) giữ nguyên tiếng Anh; KHÔNG phiên âm Hán-Việt.',
  '- Xưng hô kiểu vlog: "I" → "mình/tôi", "you/you guys" khi nói với người xem → "các bạn"; chọn theo ngữ cảnh, thống nhất trong cả video.',
  '- Giữ nguyên số liệu và đơn vị như câu gốc (không tự quy đổi dặm, pound, °F...).',
  '- Câu tiếng Việt thường dài hơn câu tiếng Anh: diễn đạt gọn để vừa thời lượng đoạn.'
].join('\n');

// Tốc độ đọc TTS tham chiếu (âm tiết hoặc từ mỗi giây) để gợi ý độ dài câu dịch.
const SPEECH_UNITS_PER_SEC = { vi: 5.0, zh: 4.5, en: 2.8, ja: 7.0, ko: 6.0 };

const RESPONSE_SCHEMA_GEMINI = {
  type: 'OBJECT',
  properties: {
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'INTEGER' },
          translated_text: { type: 'STRING' }
        },
        required: ['id', 'translated_text']
      }
    }
  },
  required: ['segments']
};

function countSpeechUnits(text, lang) {
  const t = String(text || '').trim();
  if (!t) return 0;
  if (lang === 'zh' || lang === 'ja') return t.replace(/[\s\p{P}]/gu, '').length;
  return t.split(/\s+/).filter(Boolean).length;
}

// Lời thoại nhận dạng được có giọng Quảng Đông / địa phương (SenseVoice báo) → nhắc AI hiểu theo nghĩa phương ngữ
const DIALECT_NOTES = {
  yue: 'Lưu ý nguồn: lời thoại có giọng QUẢNG ĐÔNG hoặc phương ngữ (Tứ Xuyên...), có thể viết bằng chữ Quảng Đông (佢 = anh ấy/cô ấy, 嘅 = của, 咗 = rồi, 冇 = không có, 唔 = không, 喺 = ở, 咁 = như vậy, 乜嘢 = cái gì, 點解 = tại sao) hoặc chữ đồng âm do nhận dạng giọng nói. Hiểu theo nghĩa phương ngữ và ngữ cảnh, KHÔNG dịch theo nghĩa đen từng chữ đồng âm.'
};

const OCR_SOURCE_NOTE =
  'Lưu ý nguồn: lời thoại được ĐỌC TỪ PHỤ ĐỀ IN TRONG HÌNH (OCR) nên có thể sai vài chữ hoặc dính/thiếu dấu cách (ví dụ tiếng Anh: c↔e "nudc" = nude, "thcse" = these; l↔f; rn↔m; thiếu chữ đầu câu). Hiểu theo ngữ cảnh rồi dịch đúng ý, KHÔNG dịch lỗi chính tả.';

function buildUserPayload(chunk, ctxBefore, ctxAfter, sourceLang, targetLang, style, sourceDialect = '', sourceOrigin = '') {
  const rate = SPEECH_UNITS_PER_SEC[targetLang] || 4;
  const unitName = targetLang === 'vi' ? 'âm tiết' : targetLang === 'zh' || targetLang === 'ja' ? 'ký tự' : 'từ';
  const input = {
    segments: chunk.map((s) => {
      const dur = Math.max(0.3, (s.end ?? 0) - (s.start ?? 0));
      return {
        id: s.id,
        start: s.start,
        end: s.end,
        speaker_id: s.speaker_id,
        source_text: s.source_text,
        translated_text: '',
        max_length_hint: `~${Math.max(2, Math.round(dur * rate))} ${unitName}`
      };
    })
  };
  const lines = [
    `Ngôn ngữ nguồn: ${LANG_NAMES_VI[sourceLang] || sourceLang}. Ngôn ngữ đích: ${LANG_NAMES_VI[targetLang] || targetLang}.`,
    STYLE_NOTES[style] || STYLE_NOTES.natural,
    ...(sourceLang === 'en' ? [ENGLISH_SOURCE_NOTES] : []),
    ...(DIALECT_NOTES[sourceDialect] ? [DIALECT_NOTES[sourceDialect]] : []),
    ...(sourceOrigin === 'ocr' ? [OCR_SOURCE_NOTE] : []),
    `Trường "max_length_hint" là độ dài gợi ý tối đa để giọng đọc TTS vừa thời lượng (end - start) của đoạn. Ưu tiên câu gọn, nhưng KHÔNG được lược bỏ ý quan trọng.`,
    `Trường "speaker_id" cho biết ai đang nói (cùng speaker_id = cùng một người) để chọn xưng hô.`,
    `Kết quả: một đối tượng JSON duy nhất dạng {"segments": [{"id": ..., "translated_text": "..."}]} với đúng ${chunk.length} phân đoạn, đúng thứ tự, mỗi phần tử CHỈ gồm "id" và "translated_text" (không chép lại start, end, source_text, max_length_hint).`
  ];
  if (ctxBefore.length > 0) {
    lines.push(
      'Ngữ cảnh các câu ngay TRƯỚC (chỉ để tham khảo mạch hội thoại, KHÔNG dịch lại, KHÔNG đưa vào kết quả):',
      JSON.stringify(ctxBefore.map((s) => ({ source_text: s.source_text, translated_text: s.translated_text || '' })), null, 0)
    );
  }
  if (ctxAfter.length > 0) {
    lines.push(
      'Ngữ cảnh các câu ngay SAU (chỉ để tham khảo, KHÔNG dịch, KHÔNG đưa vào kết quả):',
      JSON.stringify(ctxAfter.map((s) => s.source_text), null, 0)
    );
  }
  const srcName = LANG_EN[sourceLang] || sourceLang;
  const tgtName = LANG_EN[targetLang] || targetLang;
  lines.push(
    `TASK (bắt buộc): Translate every "source_text" from ${srcName} into ${tgtName}. Put ONLY the ${tgtName} translation into "translated_text". "translated_text" must be written in ${tgtName} — never copy the ${srcName} source.`,
    `Ví dụ định dạng: {"segments":[{"id":7,"translated_text":"${targetLang === 'vi' ? 'Xin chào mọi người.' : 'Hello everyone.'}"}]}`
  );
  lines.push('DỮ LIỆU ĐẦU VÀO:', JSON.stringify(input, null, 1));
  return lines.join('\n\n');
}

/**
 * Kiểm tra kết quả: đúng số lượng, đúng ID và thứ tự, văn bản dịch không rỗng.
 * Trả về { ok, texts, problems }
 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

/** Làm sạch & phát hiện chữ thừa / lỗi chất lượng trong 1 bản dịch. Trả về { text, problem } */
function inspectTranslation(raw, sourceText, targetLang) {
  let t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  // Bỏ ngoặc kép bao ngoài và tiền tố kiểu "Dịch:" (chữ thừa ngoài nội dung cần đọc)
  if (/^["“「『].*["”」』]$/.test(t)) t = t.slice(1, -1).trim();
  t = t.replace(/^(bản dịch|dịch|translation|translated)\s*[:：]\s*/i, '');
  if (!t) return { text: '', problem: 'translated_text rỗng' };
  if (targetLang === 'vi' && CJK_RE.test(t)) return { text: t, problem: `còn sót chữ Hán/Nhật/Hàn ("${t.slice(0, 30)}")` };
  if (/\((ghi chú|chú thích|note|giải thích)[^)]*\)/i.test(t)) return { text: t, problem: 'có ghi chú thừa trong ngoặc' };
  const words = t.toLowerCase().split(/\s+/);
  // Câu gốc vốn lặp (vd. "鱼，你看鱼 鱼 鱼看你", "叫叫叫", "no no no") → bản dịch lặp từ là đúng, không coi là lỗi
  const srcCompact = String(sourceText || '').toLowerCase().replace(/[\s\p{P}]/gu, '');
  const srcWords = String(sourceText || '').toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean);
  const sourceRepeats = /(.)\1\1/u.test(srcCompact) || srcWords.some((w, i) => w === srcWords[i + 1] && w === srcWords[i + 2]);
  for (let i = 0; !sourceRepeats && i + 2 < words.length; i++) {
    if (words[i].length > 1 && words[i] === words[i + 1] && words[i] === words[i + 2]) {
      return { text: t, problem: `lặp từ bất thường ("${words[i]} ${words[i]} ${words[i]}")` };
    }
  }
  if (sourceText && t === String(sourceText).trim() && targetLang === 'vi' && CJK_RE.test(sourceText)) {
    return { text: t, problem: 'chưa dịch (trùng câu gốc)' };
  }
  return { text: t, problem: null };
}

/**
 * Lỗi cấu trúc (thiếu mảng, sai số lượng/ID/thứ tự, JSON hỏng, bị cắt) — khác lỗi chất lượng của từng câu.
 * Lưu ý: mọi thông báo lỗi câu đều có tiền tố "Phân đoạn id=…" nên KHÔNG được dò chữ "id" chung chung.
 */
function isStructuralProblem(problems) {
  return /Thiếu mảng|Số lượng phân đoạn|vị trí \d+ phải có id|JSON|bị cắt/i.test((problems || []).join(' '));
}

function validateChunkResult(parsed, chunk, targetLang = 'vi') {
  const problems = [];
  const arr = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.segments) ? parsed.segments : null;
  if (!arr) return { ok: false, problems: ['Thiếu mảng "segments" trong kết quả.'] };
  if (arr.length !== chunk.length) {
    problems.push(`Số lượng phân đoạn trả về (${arr.length}) khác đầu vào (${chunk.length}).`);
  }
  const texts = [];
  for (let i = 0; i < chunk.length; i++) {
    const want = chunk[i];
    const got = arr[i];
    if (!got || Number(got.id) !== Number(want.id)) {
      problems.push(`Phân đoạn vị trí ${i + 1} phải có id=${want.id} nhưng nhận ${got ? got.id : 'không có'}.`);
      continue;
    }
    const insp = inspectTranslation(got.translated_text, want.source_text, targetLang);
    if (insp.problem) {
      problems.push(`Phân đoạn id=${want.id}: ${insp.problem}.`);
      continue;
    }
    texts.push(insp.text);
  }
  // Các bản dịch hợp lệ theo ID (để chỉ dịch lại phần lỗi thay vì cả lô)
  const good = new Map();
  const wantIds = new Map(chunk.map((c) => [Number(c.id), c]));
  for (const item of arr) {
    const id = Number(item && item.id);
    if (!wantIds.has(id) || good.has(id)) continue;
    const insp = inspectTranslation(item.translated_text, wantIds.get(id).source_text, targetLang);
    if (!insp.problem) good.set(id, insp.text);
  }
  if (problems.length > 0) return { ok: false, problems, good };
  return { ok: true, texts, problems: [], good };
}

function cacheKey(chunk, opts) {
  const h = crypto.createHash('sha1');
  h.update(
    JSON.stringify({
      v: PROMPT_VERSION,
      s: opts.sourceLang,
      t: opts.targetLang,
      st: opts.style,
      d: opts.sourceDialect || '',
      o: opts.sourceOrigin || '',
      p: opts.providerId || 'feature',
      m: opts.model || '',
      items: chunk.map((c) => [c.id, c.start, c.end, c.source_text])
    })
  );
  return h.digest('hex');
}

function readCache(key) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${key}.json`), 'utf8'));
    return Array.isArray(j.texts) ? j : null;
  } catch (_) {
    return null;
  }
}

function writeCache(key, texts, meta) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ texts, ...meta, savedAt: new Date().toISOString() }));
  } catch (_) {}
}

async function translateChunk(chunk, ctxBefore, ctxAfter, opts, stats, depth = 0) {
  const { sourceLang, targetLang, style, providerId, model, signal } = opts;
  // Lưu đệm theo lô: chạy lại sau khi ứng dụng bị gián đoạn sẽ dùng lại phần đã dịch (không tốn thêm request)
  const key = cacheKey(chunk, opts);
  const cached = opts.useCache === false ? null : readCache(key);
  if (cached && cached.texts.length === chunk.length) {
    stats.cacheHits += 1;
    stats.providerId = stats.providerId || cached.providerId || '';
    stats.model = stats.model || cached.model || '';
    return cached.texts;
  }
  const baseUser = buildUserPayload(chunk, ctxBefore, ctxAfter, sourceLang, targetLang, style, opts.sourceDialect || '', opts.sourceOrigin || '');
  let user = baseUser;
  let lastProblems = [];

  // Câu đơn lẻ (đã chia nhỏ tới mức 1 câu) được thêm 1 lần thử với độ sáng tạo cao hơn — model hay "kẹt" lặp lại
  // đúng một lỗi (vd. giữ nguyên "放宽") khi nhiệt độ thấp
  const maxAttempts = chunk.length === 1 ? 3 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal && signal.aborted) throw new AiProviderError('CANCELLED', 'Tác vụ dịch đã bị hủy.');
    const res = await generateText({
      featureId: 'translation',
      providerId,
      model,
      system: DUBBING_TRANSLATION_PROMPT,
      user,
      jsonSchema: { gemini: RESPONSE_SCHEMA_GEMINI },
      temperature: attempt >= 3 ? 0.8 : 0.3,
      timeoutMs: opts.timeoutMs,
      cloudOnly: Boolean(opts.cloudOnly),
      signal,
      allowCloud: opts.allowCloud !== false
    });
    stats.requests += 1;
    stats.inputTokens += res.usage?.inputTokens || 0;
    stats.outputTokens += res.usage?.outputTokens || 0;
    stats.providerId = res.providerId;
    stats.model = res.model;
    if (res.usedFallback) stats.fallbacks.push(`${res.providerId}/${res.model}`);

    let parsed;
    try {
      parsed = parseJsonFromModel(res.text);
    } catch (e) {
      lastProblems = [res.finishReason && /length|max_tokens/i.test(res.finishReason) ? 'Phản hồi bị cắt do quá dài.' : 'Phản hồi không phải JSON hợp lệ.'];
      stats.problems.push(lastProblems[0]);
      user = `LẦN TRƯỚC KẾT QUẢ KHÔNG HỢP LỆ: ${lastProblems.join(' ')} Hãy trả lại đúng JSON {"segments": [...]}.\n\n${baseUser}`;
      stats.retries += 1;
      continue;
    }
    const v = validateChunkResult(parsed, chunk, targetLang);
    if (!v.ok) stats.problems.push(...v.problems.slice(0, 3));
    if (v.ok) {
      writeCache(key, v.texts, { providerId: res.providerId, model: res.model });
      return v.texts;
    }
    lastProblems = v.problems;
    // Phần lớn đúng: giữ các câu đúng, chỉ dịch lại các câu lỗi (giảm mạnh số token/thời gian)
    if (v.good && v.good.size > 0 && v.good.size < chunk.length && depth < 4) {
      stats.partialRetries += 1;
      const bad = chunk.filter((c) => !v.good.has(Number(c.id)));
      const ctx = chunk.filter((c) => v.good.has(Number(c.id))).slice(-3).map((c) => ({ ...c, translated_text: v.good.get(Number(c.id)) }));
      const fixed = await translateChunk(bad, ctx, ctxAfter, opts, stats, depth + 1);
      const fixedById = new Map(bad.map((c, i) => [Number(c.id), fixed[i]]));
      const texts = chunk.map((c) => v.good.get(Number(c.id)) || fixedById.get(Number(c.id)));
      writeCache(key, texts, { providerId: res.providerId, model: res.model });
      return texts;
    }
    stats.retries += 1;
    if (isStructuralProblem(v.problems)) {
      user = `LẦN TRƯỚC KẾT QUẢ SAI CẤU TRÚC: ${v.problems.slice(0, 6).join(' ')} Hãy trả lại đủ ${chunk.length} phân đoạn, đúng ID và thứ tự.\n\n${baseUser}`;
    } else {
      // Lỗi chất lượng (vd. còn sót chữ Hán): chỉ rõ phần chưa dịch để model sửa đúng chỗ
      const leftover = Array.from(new Set(v.problems.join(' ').match(/[\u3400-\u9fff]+/g) || [])).slice(0, 8);
      user = `LẦN TRƯỚC BẢN DỊCH CHƯA ĐẠT: ${v.problems.slice(0, 6).join(' ')}${leftover.length ? ` Phải dịch nghĩa cả các từ: ${leftover.join(', ')}.` : ''} Viết lại "translated_text" hoàn toàn bằng ${targetLang === 'vi' ? 'tiếng Việt, không còn chữ Hán' : 'ngôn ngữ đích'}.\n\n${baseUser}`;
    }
  }

  // Vẫn sai: chia đôi lô để giảm độ khó cho model
  if (chunk.length > 1 && depth < 6) {
    stats.splits += 1;
    const mid = Math.ceil(chunk.length / 2);
    const left = await translateChunk(chunk.slice(0, mid), ctxBefore, chunk.slice(mid, mid + 2), opts, stats, depth + 1);
    const leftCtx = chunk.slice(0, mid).map((s, i) => ({ ...s, translated_text: left[i] }));
    const right = await translateChunk(chunk.slice(mid), leftCtx.slice(-3), ctxAfter, opts, stats, depth + 1);
    return [...left, ...right];
  }
  // Chỉ còn 1 câu mà model vẫn dịch lỗi chất lượng → để trống câu đó (báo cảnh báo để người dùng tự nhập),
  // KHÔNG làm hỏng cả tác vụ hàng chục câu
  if (chunk.length === 1 && lastProblems.length && !isStructuralProblem(lastProblems)) {
    stats.problems.push(`Đoạn id=${chunk[0].id} chưa dịch được (${lastProblems.join(' ').slice(0, 160)}) — hãy nhập lời dịch.`);
    return [''];
  }
  throw new AiProviderError(
    'INVALID_RESPONSE',
    `AI không trả về bản dịch hợp lệ cho phân đoạn id=${chunk[0].id}: ${lastProblems.join(' ')}`
  );
}

/**
 * @param {Array<{index?:number,startSec:number,endSec:number,sourceText:string,speakerId?:string}>} segments
 * @returns {Promise<{translations:string[], mode:string, usedCloud:true, stats:object}>}
 */
async function translateSegmentsWithLLM(segments, { sourceLang, targetLang, style = 'natural', providerId, model, signal, onProgress, onChunk, allowCloud = true, useCache = true, sourceDialect = '', sourceOrigin = '' } = {}) {
  const items = (segments || []).map((s, idx) => ({
    id: Number(s.id ?? s.index ?? idx + 1) || idx + 1,
    start: Number(Number(s.startSec ?? s.start ?? 0).toFixed(3)),
    end: Number(Number(s.endSec ?? s.end ?? 0).toFixed(3)),
    speaker_id: String(s.speakerId || s.speaker_id || 'speaker_1'),
    source_text: String(s.sourceText ?? s.source_text ?? '').trim()
  }));
  // ID phải duy nhất để ghép chính xác
  const seen = new Set();
  items.forEach((it, idx) => {
    if (seen.has(it.id)) it.id = 100000 + idx;
    seen.add(it.id);
  });

  const translations = new Array(items.length).fill('');
  const toTranslateIdx = items.map((it, i) => (it.source_text ? i : -1)).filter((i) => i >= 0);
  const stats = { requests: 0, retries: 0, splits: 0, inputTokens: 0, outputTokens: 0, chunks: 0, cacheHits: 0, partialRetries: 0, fallbacks: [], problems: [], providerId: providerId || '', model: model || '' };

  // AI đám mây (ChatGPT, Gemini...): gửi CẢ KỊCH BẢN trong 1 request để AI hiểu toàn bộ mạch truyện, xưng hô nhất quán.
  //   Chỉ video rất dài (> 400 câu / 24.000 ký tự, ~40 phút thoại) mới chia thành vài phần lớn để không vượt giới hạn trả lời của model.
  // AI Local (Qwen trên máy): giữ lô ~35 câu — model nhỏ chạy trên máy dễ trả JSON hỏng/cụt với đầu vào dài, lô nhỏ ổn định hơn
  //   và hỏng 1 lô chỉ phải dịch lại lô đó.
  const primary = primaryProviderFor('translation', providerId);
  const wholeScript = Boolean(primary) && !isLocalProvider(primary);
  stats.wholeScript = wholeScript;
  let done = 0;

  /** Dịch các vị trí `idxs` theo lô tối đa maxSegs câu / maxChars ký tự. */
  const runChunks = async (idxs, maxSegs, maxChars, over = {}) => {
    const chunks = [];
    let cur = [];
    let curChars = 0;
    for (const i of idxs) {
      const len = items[i].source_text.length;
      if (cur.length > 0 && (cur.length >= maxSegs || curChars + len > maxChars)) {
        chunks.push(cur);
        cur = [];
        curChars = 0;
      }
      cur.push(i);
      curChars += len;
    }
    if (cur.length) chunks.push(cur);
    stats.chunks += chunks.length;
    for (const idxList of chunks) {
      const chunk = idxList.map((i) => items[i]);
      const firstIdx = idxList[0];
      const lastIdx = idxList[idxList.length - 1];
      const ctxBefore = items
        .slice(Math.max(0, firstIdx - 4), firstIdx)
        .filter((x) => x.source_text)
        .map((x) => ({ ...x, translated_text: translations[items.indexOf(x)] }));
      const ctxAfter = items.slice(lastIdx + 1, lastIdx + 3).filter((x) => x.source_text);
      // Thời gian chờ theo độ dài: cả kịch bản cần lâu hơn 1 lô 35 câu (≈ 1,5 s/câu, tối thiểu 90 s, tối đa 10 phút)
      const timeoutMs = Math.min(600000, Math.max(90000, chunk.length * 1500));
      const texts = await translateChunk(chunk, ctxBefore, ctxAfter, { sourceLang, targetLang, style, providerId, model, signal, allowCloud, useCache, timeoutMs, sourceDialect, sourceOrigin, ...over }, stats);
      idxList.forEach((segIdx, k) => {
        translations[segIdx] = texts[k];
      });
      done += idxList.length;
      // Báo từng lô đã dịch xong (vị trí trong mảng `segments` + bản dịch) để lưu tiến độ, chạy tiếp được nếu lô sau lỗi
      if (typeof onChunk === 'function') {
        try {
          onChunk(idxList.slice(), texts.slice(), stats);
        } catch (_) {}
      }
      if (typeof onProgress === 'function') onProgress(done, toTranslateIdx.length);
    }
  };

  if (!wholeScript) {
    await runChunks(toTranslateIdx, 35, 3500);
  } else {
    try {
      await runChunks(toTranslateIdx, 400, 24000, { cloudOnly: true });
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
      const feat = ((loadSettings() || {}).features || {}).translation || {};
      const canLocal = feat.autoFallback !== false && primary !== LOCAL_AI_ID && isProviderReady(LOCAL_AI_ID);
      if (!canLocal) throw err;
      // AI đám mây lỗi/quá tải/hết hạn mức → dịch phần còn lại bằng AI Local theo lô nhỏ (ổn định với model nhỏ)
      stats.fallbacks.push(`${LOCAL_AI_ID} (AI đám mây lỗi: ${err.code || err.message})`);
      stats.problems.push(`AI đám mây không dịch được (${err.code || ''}: ${String(err.message || '').slice(0, 120)}) → chuyển sang AI Local theo lô 35 câu.`);
      const rest = toTranslateIdx.filter((i) => !String(translations[i] || '').trim());
      await runChunks(rest, 35, 3500, { providerId: LOCAL_AI_ID, model: undefined, cloudOnly: false });
    }
  }

  // Cảnh báo câu dịch quá dài so với thời lượng (để UI hiển thị)
  const rate = SPEECH_UNITS_PER_SEC[targetLang] || 4;
  const lengthWarnings = [];
  items.forEach((it, i) => {
    if (!translations[i]) return;
    const dur = Math.max(0.3, it.end - it.start);
    const units = countSpeechUnits(translations[i], targetLang);
    if (units > dur * rate * 1.6 + 2) lengthWarnings.push({ id: it.id, units, durationSec: Number(dur.toFixed(2)) });
  });
  stats.lengthWarnings = lengthWarnings;

  return {
    translations,
    usedCloud: true,
    mode: `AI ${stats.providerId} (${stats.model}) • ${stats.wholeScript && stats.chunks === 1 ? 'cả kịch bản trong 1 lần gửi' : `${stats.chunks} lô`}, ${stats.requests} request${stats.cacheHits ? `, ${stats.cacheHits} lô dùng lại từ bộ nhớ đệm` : ''}${stats.fallbacks.length ? ` • dự phòng: ${Array.from(new Set(stats.fallbacks)).join(', ')}` : ''}`,
    stats
  };
}

module.exports = {
  DUBBING_TRANSLATION_PROMPT,
  translateSegmentsWithLLM,
  PROMPT_VERSION,
  _internals: { validateChunkResult, inspectTranslation, isStructuralProblem, buildUserPayload, countSpeechUnits, CACHE_DIR }
};

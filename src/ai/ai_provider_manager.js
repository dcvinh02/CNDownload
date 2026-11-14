/**
 * AI Provider Manager — lớp tích hợp AI tập trung.
 *
 * - Mỗi nhà cung cấp là một Adapter (Gemini, OpenAI, OpenAI-compatible) với cùng giao diện:
 *     listModels({ signal }) -> [{ id, label }]
 *     generate({ model, system, user, jsonSchema, temperature, signal }) -> { text, usage }
 * - Cấu hình (provider/model cho từng chức năng, hạn mức) lưu ở config/ai_settings.json (KHÔNG chứa key).
 * - API Key lưu riêng ở config/ai_secrets.json với quyền 0600, hoặc đọc từ biến môi trường.
 *   API Key KHÔNG BAO GIỜ được trả về frontend — chỉ trả `hasKey` và 4 ký tự cuối.
 * - Theo dõi số request/token theo tháng (config/ai_usage.json) và chặn khi vượt hạn mức do người dùng đặt.
 * - Lỗi được phân loại rõ ràng (AUTH, QUOTA, RATE_LIMIT, NETWORK, TIMEOUT, INVALID_RESPONSE, ...),
 *   tự thử lại với lỗi tạm thời (429 rate-limit, 5xx, mạng) theo backoff.
 */

const fs = require('fs');
const path = require('path');
const localLlm = require('../local_llm_service');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = process.env.CN_AI_CONFIG_DIR || path.join(PROJECT_ROOT, 'config');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'ai_settings.json');
const SECRETS_FILE = path.join(CONFIG_DIR, 'ai_secrets.json');
const USAGE_FILE = path.join(CONFIG_DIR, 'ai_usage.json');
const LOG_FILE = path.join(CONFIG_DIR, 'ai_logs.jsonl');
const LOCAL_PROVIDER_ID = 'local_qwen';

const DEFAULT_TIMEOUT_MS = 90000;
const MAX_ATTEMPTS = 3;

class AiProviderError extends Error {
  constructor(code, message, { status = 0, providerId = '', retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    this.status = status;
    this.providerId = providerId;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/* ----------------------------- Lưu trữ cấu hình ----------------------------- */

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, data, mode = 0o644) {
  ensureConfigDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch (_) {}
  if (mode === 0o600) restrictToCurrentUserWin(file);
}

/**
 * Windows bỏ qua quyền kiểu Unix (chmod 0600 chỉ còn cờ read-only) → dùng ACL: bỏ quyền kế thừa từ thư mục
 * (vd. nhóm Users đọc được khi dự án nằm ở C:\CNVideo), chỉ cấp cho tài khoản đang chạy ứng dụng.
 */
function restrictToCurrentUserWin(file) {
  if (process.platform !== 'win32' || !process.env.USERNAME) return;
  const who = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  try {
    require('child_process').spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${who}:F`], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
  } catch (_) {}
}

const DEFAULT_SETTINGS = {
  providers: {
    local_qwen: { defaultModel: '' },
    gemini: { defaultModel: '' },
    openai: { defaultModel: '', baseUrl: 'https://api.openai.com/v1' },
    openai_compatible: { defaultModel: '', baseUrl: '' }
  },
  features: {
    translation: { providerId: 'local_qwen', model: '', fallbacks: [] }
  },
  limits: {
    local_qwen: { monthlyRequestLimit: 0, monthlyTokenLimit: 0 },
    gemini: { monthlyRequestLimit: 0, monthlyTokenLimit: 0 },
    openai: { monthlyRequestLimit: 0, monthlyTokenLimit: 0 },
    openai_compatible: { monthlyRequestLimit: 0, monthlyTokenLimit: 0 }
  }
};

function loadSettings() {
  const raw = readJsonSafe(SETTINGS_FILE, {});
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const section of ['providers', 'features', 'limits']) {
    const src = raw[section] && typeof raw[section] === 'object' ? raw[section] : {};
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object') out[section][k] = { ...(out[section][k] || {}), ...v };
    }
  }
  return out;
}

function loadSecrets() {
  return readJsonSafe(SECRETS_FILE, {});
}

const ENV_KEY_NAMES = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openai_compatible: ['CN_OPENAI_COMPAT_API_KEY']
};

function getApiKey(providerId) {
  if (providerId === LOCAL_PROVIDER_ID) {
    // AI Local không cần API Key — "sẵn sàng" khi đã cài môi trường + ít nhất 1 model
    const ready = localLlm.isRuntimeInstalled() && localLlm.listInstalledModels().length > 0;
    return { key: ready ? 'local' : '', source: ready ? 'local' : null };
  }
  const secrets = loadSecrets();
  const fromFile = typeof secrets[providerId] === 'string' ? secrets[providerId].trim() : '';
  if (fromFile) return { key: fromFile, source: 'file' };
  // Máy chủ AI chạy trên chính máy (Ollama, LM Studio...) không cần API Key
  if (providerId === 'openai_compatible' && isLocalhostUrl((loadSettings().providers.openai_compatible || {}).baseUrl)) {
    return { key: 'local', source: 'local-server' };
  }
  for (const envName of ENV_KEY_NAMES[providerId] || []) {
    const v = String(process.env[envName] || '').trim();
    if (v) return { key: v, source: `env:${envName}` };
  }
  return { key: '', source: null };
}

function isLocalhostUrl(u) {
  try {
    const p = new URL(String(u || ''));
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(p.hostname);
  } catch (_) {
    return false;
  }
}

function maskKey(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `••••${key.slice(-4)}`;
}

function redactSecrets(text) {
  let out = String(text || '');
  for (const pid of Object.keys(ENV_KEY_NAMES)) {
    const { key } = getApiKey(pid);
    if (key && key.length >= 6) out = out.split(key).join('[API_KEY_ĐÃ_ẨN]');
  }
  return out
    .replace(/(AIza[0-9A-Za-z_\-]{20,})/g, '[API_KEY_ĐÃ_ẨN]')
    .replace(/(sk-[0-9A-Za-z_\-]{16,})/g, '[API_KEY_ĐÃ_ẨN]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[ĐÃ_ẨN]');
}

/* ------------------------------ Usage & hạn mức ----------------------------- */

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getUsageSnapshot() {
  const all = readJsonSafe(USAGE_FILE, {});
  return all[currentMonthKey()] || {};
}

function recordUsage(providerId, { inputTokens = 0, outputTokens = 0, error = false } = {}) {
  try {
    const all = readJsonSafe(USAGE_FILE, {});
    const month = currentMonthKey();
    all[month] = all[month] || {};
    const u = all[month][providerId] || { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 };
    u.requests += 1;
    u.inputTokens += Number(inputTokens) || 0;
    u.outputTokens += Number(outputTokens) || 0;
    if (error) u.errors += 1;
    u.updatedAt = new Date().toISOString();
    all[month][providerId] = u;
    writeJsonAtomic(USAGE_FILE, all);
  } catch (_) {}
}

function assertWithinLimits(providerId) {
  const limits = loadSettings().limits[providerId] || {};
  const usage = getUsageSnapshot()[providerId] || { requests: 0, inputTokens: 0, outputTokens: 0 };
  const reqLimit = Number(limits.monthlyRequestLimit) || 0;
  const tokLimit = Number(limits.monthlyTokenLimit) || 0;
  if (reqLimit > 0 && usage.requests >= reqLimit) {
    throw new AiProviderError(
      'LIMIT_EXCEEDED',
      `Đã đạt hạn mức ${reqLimit} request/tháng bạn đặt cho ${PROVIDER_META[providerId]?.name || providerId}. Tăng hạn mức trong mục "Tích hợp AI" nếu muốn tiếp tục.`,
      { providerId }
    );
  }
  const usedTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  if (tokLimit > 0 && usedTokens >= tokLimit) {
    throw new AiProviderError(
      'LIMIT_EXCEEDED',
      `Đã dùng ${usedTokens} token, vượt hạn mức ${tokLimit} token/tháng bạn đặt cho ${PROVIDER_META[providerId]?.name || providerId}.`,
      { providerId }
    );
  }
}

/* --------------------------------- HTTP chung -------------------------------- */

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new AiProviderError('CANCELLED', 'Tác vụ AI đã bị hủy.'));
        },
        { once: true }
      );
    }
  });
}

function parseRetryAfter(res) {
  const h = res.headers.get('retry-after');
  if (!h) return 0;
  const sec = Number(h);
  if (Number.isFinite(sec)) return Math.min(60000, sec * 1000);
  const dateMs = Date.parse(h);
  return Number.isFinite(dateMs) ? Math.max(0, Math.min(60000, dateMs - Date.now())) : 0;
}

async function httpJson(providerId, url, { method = 'GET', headers = {}, body, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined
    });
  } catch (err) {
    if (signal && signal.aborted) throw new AiProviderError('CANCELLED', 'Tác vụ AI đã bị hủy.', { providerId });
    if (timeoutSignal.aborted) {
      throw new AiProviderError('TIMEOUT', `Nhà cung cấp AI không phản hồi sau ${Math.round(timeoutMs / 1000)} giây.`, {
        providerId,
        retryable: true
      });
    }
    throw new AiProviderError('NETWORK', `Không kết nối được tới nhà cung cấp AI: ${redactSecrets(err.cause?.code || err.message)}`, {
      providerId,
      retryable: true
    });
  }

  const rawText = await res.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (_) {
    data = null;
  }

  if (!res.ok) {
    throw classifyHttpError(providerId, res, data, rawText);
  }
  if (data === null) {
    throw new AiProviderError('INVALID_RESPONSE', 'Nhà cung cấp AI trả về dữ liệu không phải JSON.', {
      providerId,
      status: res.status,
      retryable: true
    });
  }
  return data;
}

function classifyHttpError(providerId, res, data, rawText) {
  const status = res.status;
  const errObj = (data && (data.error || data)) || {};
  const apiMsg = redactSecrets(
    (typeof errObj === 'object' ? errObj.message || errObj.status || errObj.code : '') || rawText || ''
  ).slice(0, 300);
  const codeStr = String((errObj && (errObj.code || errObj.status || errObj.type)) || '').toLowerCase();
  const msgLower = apiMsg.toLowerCase();
  const name = PROVIDER_META[providerId]?.name || providerId;
  const opts = { providerId, status, retryAfterMs: parseRetryAfter(res) };

  if (status === 401 || status === 403 || /api key not valid|invalid api key|incorrect api key|permission_denied|unauthenticated/.test(msgLower)) {
    return new AiProviderError('AUTH', `${name}: API Key không hợp lệ, đã hết hạn hoặc không có quyền (${status}). ${apiMsg}`, opts);
  }
  if (status === 404 || /not found|does not exist|model_not_found/.test(codeStr + ' ' + msgLower)) {
    return new AiProviderError('MODEL_NOT_FOUND', `${name}: Không tìm thấy model hoặc endpoint (${status}). Hãy chọn model khác. ${apiMsg}`, opts);
  }
  if (status === 429) {
    const isQuota = /insufficient_quota|quota|billing|exceeded your current|limit: 0/.test(codeStr + ' ' + msgLower) && !/per minute|rate limit/.test(msgLower);
    if (isQuota) {
      return new AiProviderError('QUOTA', `${name}: Đã hết hạn mức sử dụng / hạn mức thanh toán của tài khoản API (429). ${apiMsg}`, opts);
    }
    return new AiProviderError('RATE_LIMIT', `${name}: Gửi quá nhiều yêu cầu (429), hệ thống sẽ thử lại. ${apiMsg}`, { ...opts, retryable: true });
  }
  if (status >= 500) {
    return new AiProviderError('SERVER', `${name}: Máy chủ AI đang lỗi (${status}). ${apiMsg}`, { ...opts, retryable: true });
  }
  return new AiProviderError('BAD_REQUEST', `${name}: Yêu cầu bị từ chối (${status}). ${apiMsg}`, opts);
}

/* --------------------------------- Adapters --------------------------------- */

const geminiAdapter = {
  id: 'gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  async listModels({ apiKey, baseUrl, signal }) {
    const base = (baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const data = await httpJson('gemini', `${base}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey },
      signal,
      timeoutMs: 20000
    });
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name }))
      .filter((m) => m.id && !/embedding|aqa|imagen|veo|tts|image|live/i.test(m.id));
  },
  async generate({ apiKey, baseUrl, model, system, user, jsonSchema, temperature = 0.3, signal }) {
    const base = (baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const generationConfig = { temperature };
    if (jsonSchema) {
      generationConfig.responseMimeType = 'application/json';
      if (jsonSchema.gemini) generationConfig.responseSchema = jsonSchema.gemini;
    }
    // Gemini 3.x mặc định "suy nghĩ" — với dịch thuật thì không cần: giảm token (chi phí) & độ trễ
    if (/^gemini-([3-9]|flash|pro)/.test(model)) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    const callGemini = () =>
      httpJson('gemini', `${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig
        },
        signal,
        timeoutMs: 75000
      });
    let data;
    try {
      data = await callGemini();
    } catch (err) {
      if (err.code === 'BAD_REQUEST' && /thinking/i.test(err.message) && generationConfig.thinkingConfig) {
        delete generationConfig.thinkingConfig;
        data = await callGemini();
      } else {
        throw err;
      }
    }
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      throw new AiProviderError('SAFETY', `Gemini chặn nội dung yêu cầu (${data.promptFeedback.blockReason}).`, { providerId: 'gemini' });
    }
    const cand = (data.candidates || [])[0];
    const text = ((cand && cand.content && cand.content.parts) || [])
      .filter((p) => p && typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');
    if (!text) {
      const reason = cand && cand.finishReason ? ` (finishReason=${cand.finishReason})` : '';
      throw new AiProviderError('INVALID_RESPONSE', `Gemini trả về phản hồi rỗng${reason}.`, { providerId: 'gemini', retryable: true });
    }
    const um = data.usageMetadata || {};
    return {
      text,
      finishReason: cand.finishReason || '',
      usage: { inputTokens: um.promptTokenCount || 0, outputTokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0) }
    };
  }
};

function makeOpenAiAdapter(id, defaultBaseUrl) {
  return {
    id,
    defaultBaseUrl,
    async listModels({ apiKey, baseUrl, signal }) {
      const base = (baseUrl || this.defaultBaseUrl || '').replace(/\/+$/, '');
      if (!base) throw new AiProviderError('BAD_REQUEST', 'Chưa nhập Base URL cho nhà cung cấp tương thích OpenAI.', { providerId: id });
      const data = await httpJson(id, `${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
        timeoutMs: 20000
      });
      return (data.data || [])
        .map((m) => ({ id: m.id, label: m.id }))
        .filter((m) => m.id && !/embedding|whisper|tts|dall-e|moderation|audio|realtime|image|transcribe|search/i.test(m.id))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    async generate({ apiKey, baseUrl, model, system, user, jsonSchema, temperature = 0.3, signal }) {
      const base = (baseUrl || this.defaultBaseUrl || '').replace(/\/+$/, '');
      if (!base) throw new AiProviderError('BAD_REQUEST', 'Chưa nhập Base URL cho nhà cung cấp tương thích OpenAI.', { providerId: id });
      const body = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      };
      if (temperature !== null) body.temperature = temperature;
      if (jsonSchema) body.response_format = { type: 'json_object' };
      let data;
      try {
        data = await httpJson(id, `${base}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body,
          signal
        });
      } catch (err) {
        // Một số model (reasoning) không chấp nhận temperature hoặc response_format -> thử lại không có các trường này
        if (err.code === 'BAD_REQUEST' && /temperature|response_format|json_object/i.test(err.message)) {
          delete body.temperature;
          if (/response_format|json_object/i.test(err.message)) delete body.response_format;
          data = await httpJson(id, `${base}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body,
            signal
          });
        } else {
          throw err;
        }
      }
      const choice = (data.choices || [])[0];
      const text = choice && choice.message ? String(choice.message.content || '') : '';
      if (!text) {
        throw new AiProviderError('INVALID_RESPONSE', `${PROVIDER_META[id].name} trả về phản hồi rỗng.`, { providerId: id, retryable: true });
      }
      const usage = data.usage || {};
      return {
        text,
        finishReason: choice.finish_reason || '',
        usage: { inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0 }
      };
    }
  };
}

const openAiCompatForLocal = makeOpenAiAdapter('local_qwen', '');

const localQwenAdapter = {
  id: LOCAL_PROVIDER_ID,
  defaultBaseUrl: '',
  isLocal: true,
  async listModels() {
    if (!localLlm.isRuntimeInstalled()) {
      throw new AiProviderError('NO_KEY', 'Chưa cài môi trường AI Local (mlx-lm). Mở trình cài công cụ để cài.', { providerId: LOCAL_PROVIDER_ID });
    }
    const models = localLlm.listInstalledModels().map((m) => ({ id: m.id, label: `${m.label} • ${m.sizeGB} GB` }));
    if (models.length === 0) {
      throw new AiProviderError('NO_KEY', 'Chưa tải model Qwen nào cho AI Local.', { providerId: LOCAL_PROVIDER_ID });
    }
    return models;
  },
  async generate(opts) {
    let rt;
    try {
      rt = await localLlm.ensureRunning(opts.model);
    } catch (err) {
      throw new AiProviderError('SERVER', `AI Local: ${err.message}`, { providerId: LOCAL_PROVIDER_ID });
    }
    const out = await openAiCompatForLocal.generate({ ...opts, apiKey: 'local', baseUrl: rt.baseUrl, model: rt.modelPath, temperature: 0.2 });
    // Phòng trường hợp model vẫn sinh khối suy nghĩ
    out.text = String(out.text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return out;
  }
};

const ADAPTERS = {
  local_qwen: localQwenAdapter,
  gemini: geminiAdapter,
  openai: makeOpenAiAdapter('openai', 'https://api.openai.com/v1'),
  openai_compatible: makeOpenAiAdapter('openai_compatible', '')
};

const PROVIDER_META = {
  local_qwen: {
    id: LOCAL_PROVIDER_ID,
    name: 'AI Local (Qwen • Apple MLX — không cần API Key)',
    keyHelpUrl: '',
    needsBaseUrl: false,
    needsKey: false,
    isLocal: true,
    suggestedModels: []
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    keyHelpUrl: 'https://aistudio.google.com/app/apikey',
    needsBaseUrl: false,
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']
  },
  openai: {
    id: 'openai',
    name: 'OpenAI (ChatGPT)',
    keyHelpUrl: 'https://platform.openai.com/api-keys',
    needsBaseUrl: false,
    suggestedModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini']
  },
  openai_compatible: {
    id: 'openai_compatible',
    name: 'Tương thích OpenAI (DeepSeek, Groq, OpenRouter, hoặc Ollama/LM Studio trên máy — không cần key)',
    keyHelpUrl: '',
    needsBaseUrl: true,
    suggestedModels: []
  }
};

const FEATURES_META = {
  translation: {
    id: 'translation',
    name: 'Dịch lời thoại video (lồng tiếng / phụ đề)',
    description: 'Dịch từng phân đoạn có ID + timestamp, giữ nguyên cấu trúc để ghép trực tiếp với video.'
  }
};

/* ------------------------------ API công khai ------------------------------ */

function getProviderRuntime(providerId) {
  const adapter = ADAPTERS[providerId];
  if (!adapter) throw new AiProviderError('BAD_REQUEST', `Nhà cung cấp AI không hợp lệ: ${providerId}`);
  const settings = loadSettings();
  const pcfg = settings.providers[providerId] || {};
  const { key } = getApiKey(providerId);
  return { adapter, apiKey: key, baseUrl: pcfg.baseUrl || adapter.defaultBaseUrl || '', defaultModel: pcfg.defaultModel || '' };
}

function getPublicAiConfig() {
  const settings = loadSettings();
  const usage = getUsageSnapshot();
  const providers = Object.values(PROVIDER_META).map((meta) => {
    const { key, source } = getApiKey(meta.id);
    const pcfg = settings.providers[meta.id] || {};
    return {
      ...meta,
      hasKey: Boolean(key),
      keySource: source,
      keyHint: maskKey(key),
      defaultModel: pcfg.defaultModel || '',
      baseUrl: pcfg.baseUrl || ADAPTERS[meta.id].defaultBaseUrl || '',
      unavailableModels: Array.isArray(pcfg.unavailableModels) ? pcfg.unavailableModels : [],
      cachedModels:
        meta.id === LOCAL_PROVIDER_ID
          ? localLlm.listInstalledModels().map((m) => ({ id: m.id, label: m.label }))
          : Array.isArray(pcfg.cachedModels)
            ? pcfg.cachedModels
            : [],
      lastTest: pcfg.lastTest || null,
      limits: settings.limits[meta.id] || { monthlyRequestLimit: 0, monthlyTokenLimit: 0 },
      usageThisMonth: usage[meta.id] || { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 }
    };
  });
  const features = Object.values(FEATURES_META).map((f) => {
    const cfg = { ...f, ...(settings.features[f.id] || {}) };
    let chainPreview = [];
    try {
      chainPreview = buildTargetChain(f.id, {}, true).chain.map((t) => ({ providerId: t.providerId, model: t.model, autoModel: Boolean(t.autoModel) }));
    } catch (_) {}
    return { ...cfg, autoFallback: cfg.autoFallback !== false, chainPreview };
  });
  return {
    providers: providers.map((p) => ({ ...p, recommendedModel: recommendModel(p.id, p.cachedModels) })),
    features,
    queue: getQueueSnapshot(),
    month: currentMonthKey(),
    storage: {
      settingsFile: path.relative(PROJECT_ROOT, SETTINGS_FILE),
      secretsFile: path.relative(PROJECT_ROOT, SECRETS_FILE),
      note: 'API Key chỉ lưu trên máy (quyền 0600), không trả về giao diện, không ghi vào log.'
    }
  };
}

function isValidHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || (p.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(p.hostname));
  } catch (_) {
    return false;
  }
}

/**
 * Cập nhật cấu hình. Body: { providers: { gemini: { apiKey?, clearKey?, defaultModel?, baseUrl? } }, features: {...}, limits: {...} }
 */
function saveAiConfig(body = {}) {
  const settings = loadSettings();
  const secrets = loadSecrets();
  let secretsChanged = false;

  for (const [pid, patch] of Object.entries(body.providers || {})) {
    if (!ADAPTERS[pid] || !patch || typeof patch !== 'object') continue;
    const cur = settings.providers[pid] || {};
    if (typeof patch.defaultModel === 'string') cur.defaultModel = patch.defaultModel.trim().slice(0, 120);
    if (typeof patch.baseUrl === 'string') {
      const bu = patch.baseUrl.trim();
      if (bu && !isValidHttpUrl(bu)) {
        throw new Error(`Base URL không hợp lệ cho ${PROVIDER_META[pid].name}: chỉ chấp nhận https:// (hoặc http:// tới máy cục bộ).`);
      }
      if (bu !== (cur.baseUrl || '')) cur.cachedModels = [];
      cur.baseUrl = bu;
    }
    settings.providers[pid] = cur;
    if (patch.clearKey) {
      delete secrets[pid];
      secretsChanged = true;
      settings.providers[pid].cachedModels = [];
      settings.providers[pid].lastTest = null;
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      const k = patch.apiKey.trim();
      if (/\s/.test(k) || k.length < 10 || k.length > 400) {
        throw new Error(`API Key cho ${PROVIDER_META[pid].name} không đúng định dạng (không được chứa khoảng trắng, độ dài 10–400 ký tự).`);
      }
      secrets[pid] = k;
      secretsChanged = true;
      settings.providers[pid].lastTest = null;
    }
  }

  for (const [fid, patch] of Object.entries(body.features || {})) {
    if (!FEATURES_META[fid] || !patch || typeof patch !== 'object') continue;
    const cur = settings.features[fid] || {};
    if (typeof patch.providerId === 'string') {
      if (!ADAPTERS[patch.providerId]) throw new Error(`Nhà cung cấp AI không hợp lệ: ${patch.providerId}`);
      cur.providerId = patch.providerId;
    }
    if (typeof patch.model === 'string') cur.model = patch.model.trim().slice(0, 120);
    if (typeof patch.autoFallback === 'boolean') cur.autoFallback = patch.autoFallback;
    if (Array.isArray(patch.fallbacks)) {
      cur.fallbacks = patch.fallbacks
        .filter((f) => f && ADAPTERS[f.providerId])
        .slice(0, 5)
        .map((f) => ({ providerId: f.providerId, model: String(f.model || '').trim().slice(0, 120) }));
    }
    settings.features[fid] = cur;
  }

  for (const [pid, patch] of Object.entries(body.limits || {})) {
    if (!ADAPTERS[pid] || !patch || typeof patch !== 'object') continue;
    const cur = settings.limits[pid] || {};
    for (const k of ['monthlyRequestLimit', 'monthlyTokenLimit']) {
      if (patch[k] !== undefined) cur[k] = Math.max(0, Math.floor(Number(patch[k]) || 0));
    }
    settings.limits[pid] = cur;
  }

  writeJsonAtomic(SETTINGS_FILE, settings);
  if (secretsChanged) writeJsonAtomic(SECRETS_FILE, secrets, 0o600);
  return getPublicAiConfig();
}

async function testProviderConnection(providerId, { signal } = {}) {
  const rt = getProviderRuntime(providerId);
  if (!rt.apiKey && providerId === LOCAL_PROVIDER_ID) {
    return { ok: false, providerId, code: 'NO_KEY', error: 'Chưa cài AI Local (mlx-lm + model Qwen). Mở trình cài công cụ để cài.' };
  }
  if (!rt.apiKey) {
    return { ok: false, providerId, code: 'NO_KEY', error: `Chưa cấu hình API Key cho ${PROVIDER_META[providerId].name}.` };
  }
  const t0 = Date.now();
  const settings = loadSettings();
  try {
    const models = await rt.adapter.listModels({ apiKey: rt.apiKey, baseUrl: rt.baseUrl, signal });
    const latencyMs = Date.now() - t0;
    settings.providers[providerId] = {
      ...(settings.providers[providerId] || {}),
      cachedModels: models.slice(0, 300),
      lastTest: { ok: true, at: new Date().toISOString(), latencyMs, modelCount: models.length }
    };
    writeJsonAtomic(SETTINGS_FILE, settings);
    return { ok: true, providerId, latencyMs, models };
  } catch (err) {
    const e = err instanceof AiProviderError ? err : new AiProviderError('NETWORK', redactSecrets(err.message), { providerId });
    settings.providers[providerId] = {
      ...(settings.providers[providerId] || {}),
      lastTest: { ok: false, at: new Date().toISOString(), code: e.code, error: redactSecrets(e.message) }
    };
    writeJsonAtomic(SETTINGS_FILE, settings);
    return { ok: false, providerId, code: e.code, status: e.status, error: redactSecrets(e.message) };
  }
}

/**
 * Chọn provider + model cho một chức năng (feature), có thể ghi đè theo yêu cầu.
 */
function resolveFeatureTarget(featureId, override = {}) {
  const settings = loadSettings();
  const feat = settings.features[featureId] || {};
  const providerId = override.providerId || feat.providerId || 'gemini';
  if (!ADAPTERS[providerId]) throw new AiProviderError('BAD_REQUEST', `Nhà cung cấp AI không hợp lệ: ${providerId}`);
  const rt = getProviderRuntime(providerId);
  let model = override.model || (override.providerId && override.providerId !== feat.providerId ? '' : feat.model) || rt.defaultModel;
  if (model && getUnavailableModels(providerId).includes(model)) model = ''; // đã biết bị ngừng → tự chọn model khác
  if (!rt.apiKey) {
    throw new AiProviderError(
      'NO_KEY',
      providerId === LOCAL_PROVIDER_ID
        ? 'Chưa cài AI Local (Qwen). Mở trình cài công cụ → "AI dịch Local (Qwen • MLX)".'
        : `Chưa cấu hình API Key cho ${PROVIDER_META[providerId].name}. Mở tab "🤖 Tích hợp AI" để thêm API Key và bấm "Kiểm tra kết nối".`,
      { providerId }
    );
  }
  if (!model && providerId === LOCAL_PROVIDER_ID) {
    const first = localLlm.listInstalledModels()[0];
    return { providerId, model: first ? first.id : '', providerName: PROVIDER_META[providerId].name };
  }
  if (!model) {
    const auto = recommendModel(providerId, getProviderModels(providerId));
    if (auto) return { providerId, model: auto, providerName: PROVIDER_META[providerId].name, autoModel: true };
    throw new AiProviderError(
      'BAD_REQUEST',
      `Chưa chọn model cho ${PROVIDER_META[providerId].name}. Bấm "Kiểm tra kết nối" ở tab Tích hợp AI để tải danh sách model.`,
      { providerId }
    );
  }
  return { providerId, model, providerName: PROVIDER_META[providerId].name };
}

function isProviderReady(providerId) {
  try {
    return Boolean(ADAPTERS[providerId] && getApiKey(providerId).key);
  } catch (_) {
    return false;
  }
}

/* ------------------------------- AI Gateway ------------------------------- */

function versionScore(id) {
  const m = String(id).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Chọn model khuyến nghị từ DANH SÁCH MODEL THẬT của tài khoản (không đặt cứng tên model —
 * nhà cung cấp ngừng model cũ thường xuyên). Ưu tiên model chat nhanh, bản ổn định mới nhất.
 */
function recommendModel(providerId, models) {
  const ids = (models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
  if (ids.length === 0) return '';
  const stable = ids.filter((id) => !/preview|exp|experimental|tts|image|audio|realtime|transcribe|search|computer|robotics|research|lyria|banana|live|embedding|codex|omni|instruct-?vision/i.test(id) && !/-\d{4}-\d{2}-\d{2}$/.test(id));
  const pick = (re) => stable.filter((id) => re.test(id)).sort((a, b) => versionScore(b) - versionScore(a))[0];
  if (providerId === 'gemini') {
    return (
      (stable.includes('gemini-flash-latest') && 'gemini-flash-latest') ||
      pick(/^gemini-[\d.]+-flash$/) ||
      pick(/^gemini-[\d.]+-pro$/) ||
      stable[0] ||
      ids[0]
    );
  }
  if (providerId === 'openai') {
    return pick(/^gpt-[\d.]+-mini$/) || pick(/^gpt-[\d.]+$/) || pick(/^gpt-/) || stable[0] || ids[0];
  }
  return stable[0] || ids[0];
}

function getUnavailableModels(providerId) {
  const pcfg = loadSettings().providers[providerId] || {};
  return Array.isArray(pcfg.unavailableModels) ? pcfg.unavailableModels : [];
}

function markModelUnavailable(providerId, model) {
  try {
    const settings = loadSettings();
    const cur = settings.providers[providerId] || {};
    const list = new Set(Array.isArray(cur.unavailableModels) ? cur.unavailableModels : []);
    list.add(model);
    cur.unavailableModels = Array.from(list).slice(-50);
    if (cur.defaultModel === model) cur.defaultModel = '';
    settings.providers[providerId] = cur;
    for (const f of Object.values(settings.features || {})) {
      if (f && f.providerId === providerId && f.model === model) f.model = '';
    }
    writeJsonAtomic(SETTINGS_FILE, settings);
  } catch (_) {}
}

function getProviderModels(providerId) {
  if (providerId === LOCAL_PROVIDER_ID) return localLlm.listInstalledModels().map((m) => ({ id: m.id, label: m.label }));
  const pcfg = loadSettings().providers[providerId] || {};
  const dead = new Set(Array.isArray(pcfg.unavailableModels) ? pcfg.unavailableModels : []);
  return (Array.isArray(pcfg.cachedModels) ? pcfg.cachedModels : []).filter((m) => !dead.has(m.id));
}

/** Nhà cung cấp chạy trên chính máy này (không gửi dữ liệu ra Internet). */
function isLocalProvider(providerId) {
  if (providerId === 'openai_compatible') return isLocalhostUrl((loadSettings().providers.openai_compatible || {}).baseUrl);
  return Boolean(ADAPTERS[providerId] && ADAPTERS[providerId].isLocal);
}

/** Nhật ký lỗi/sự kiện AI (đã ẩn key), xoay vòng khi > 1 MB. */
function appendAiLog(entry) {
  try {
    ensureConfigDir();
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry, message: redactSecrets(entry.message || '') });
    fs.appendFileSync(LOG_FILE, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}
}

function getAiLogs(limit = 100) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try {
        return JSON.parse(l);
      } catch (_) {
        return null;
      }
    }).filter(Boolean).reverse();
  } catch (_) {
    return [];
  }
}

// Hàng đợi: giới hạn số yêu cầu đồng thời mỗi nhà cung cấp (AI Local: 1 vì dùng chung GPU/RAM; Cloud: 2)
const queues = new Map();
function acquireSlot(providerId, signal) {
  const limit = isLocalProvider(providerId) ? 1 : 2;
  if (!queues.has(providerId)) queues.set(providerId, { running: 0, waiting: [] });
  const q = queues.get(providerId);
  if (q.running < limit) {
    q.running++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const item = { resolve, reject };
    q.waiting.push(item);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          const i = q.waiting.indexOf(item);
          if (i >= 0) q.waiting.splice(i, 1);
          reject(new AiProviderError('CANCELLED', 'Tác vụ AI đã bị hủy.'));
        },
        { once: true }
      );
    }
  }).then(() => {
    q.running++;
  });
}
function releaseSlot(providerId) {
  const q = queues.get(providerId);
  if (!q) return;
  q.running = Math.max(0, q.running - 1);
  const next = q.waiting.shift();
  if (next) next.resolve();
}

function getQueueSnapshot() {
  const out = {};
  for (const [pid, q] of queues.entries()) out[pid] = { running: q.running, waiting: q.waiting.length };
  return out;
}

// "Sức khỏe" model: model vừa timeout/quá tải trong 15 phút gần nhất bị đẩy xuống cuối chuỗi
const recentTransientFailures = new Map();
const HEALTH_WINDOW_MS = 15 * 60 * 1000;
function noteTransientFailure(providerId, model, code) {
  if (['TIMEOUT', 'SERVER', 'RATE_LIMIT'].includes(code)) recentTransientFailures.set(`${providerId}|${model}`, Date.now());
}
function isRecentlyUnhealthy(providerId, model) {
  const t = recentTransientFailures.get(`${providerId}|${model}`);
  return Boolean(t && Date.now() - t < HEALTH_WINDOW_MS);
}

// Lỗi khiến nên chuyển sang nhà cung cấp dự phòng
const FALLBACK_CODES = new Set(['AUTH', 'QUOTA', 'NO_KEY', 'NETWORK', 'TIMEOUT', 'SERVER', 'MODEL_NOT_FOUND', 'LIMIT_EXCEEDED', 'RATE_LIMIT', 'SAFETY', 'BAD_REQUEST']);

/**
 * Danh sách đích theo thứ tự ưu tiên: [chính, ...dự phòng]. Khi không cho phép Cloud chỉ giữ đích Local.
 */
function buildTargetChain(featureId, override = {}, allowCloud = true) {
  const settings = loadSettings();
  const feat = settings.features[featureId] || {};
  const raw = [{ providerId: override.providerId || feat.providerId, model: override.model || (override.providerId && override.providerId !== feat.providerId ? '' : feat.model) }];
  for (const f of feat.fallbacks || []) raw.push(f);
  if (feat.autoFallback !== false) {
    // Dự phòng tự động: model nhẹ/ổn định khác của cùng nhà cung cấp, sau đó AI Local (không cần key, không gửi Cloud)
    const primaryPid = raw[0].providerId;
    if (primaryPid === 'gemini') {
      const ids = getProviderModels('gemini').map((m) => m.id);
      for (const alt of ['gemini-flash-lite-latest', recommendModel('gemini', ids.filter((x) => /^gemini-[\d.]+-flash$/.test(x)))]) {
        if (alt && ids.includes(alt)) raw.push({ providerId: 'gemini', model: alt });
      }
    } else if (primaryPid === 'openai') {
      const ids = getProviderModels('openai').map((m) => m.id);
      const nano = recommendModel('openai', ids.filter((x) => /^gpt-[\d.]+-nano$/.test(x)));
      if (nano) raw.push({ providerId: 'openai', model: nano });
    }
    if (primaryPid !== LOCAL_PROVIDER_ID) raw.push({ providerId: LOCAL_PROVIDER_ID, model: '' });
    if (primaryPid !== 'openai_compatible' && isLocalProvider('openai_compatible')) raw.push({ providerId: 'openai_compatible', model: '' });
  }
  const chain = [];
  const seen = new Set();
  const skipped = [];
  for (const t of raw) {
    if (!t || !t.providerId || !ADAPTERS[t.providerId]) continue;
    if (!allowCloud && !isLocalProvider(t.providerId)) {
      skipped.push({ providerId: t.providerId, reason: 'chưa cho phép gửi Cloud' });
      continue;
    }
    try {
      const target = resolveFeatureTarget(featureId, { providerId: t.providerId, model: t.model });
      const key = `${target.providerId}|${target.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        chain.push(target);
      }
    } catch (err) {
      skipped.push({ providerId: t.providerId, reason: err.message });
    }
  }
  // Giữ thứ tự ưu tiên nhưng đẩy model vừa quá tải/timeout xuống sau (ổn định ưu tiên trước)
  const healthy = chain.filter((t) => !isRecentlyUnhealthy(t.providerId, t.model));
  const unhealthy = chain.filter((t) => isRecentlyUnhealthy(t.providerId, t.model));
  return { chain: [...healthy, ...unhealthy], skipped };
}

/**
 * Gọi model sinh văn bản qua AI Gateway:
 * hàng đợi theo nhà cung cấp → kiểm hạn mức → thử lại lỗi tạm thời → tự chuyển sang nhà cung cấp dự phòng → ghi usage & log.
 */
async function generateText({ featureId = 'translation', providerId, model, system, user, jsonSchema = null, temperature = 0.3, signal, allowCloud = true } = {}) {
  const { chain, skipped } = buildTargetChain(featureId, { providerId, model }, allowCloud);
  if (chain.length === 0) {
    const reason = skipped.map((x) => `${PROVIDER_META[x.providerId]?.name || x.providerId}: ${x.reason}`).join(' | ');
    throw new AiProviderError('NO_KEY', `Không có nhà cung cấp AI nào sẵn sàng cho chức năng này. ${reason}`);
  }
  const failures = [];
  for (let ci = 0; ci < chain.length; ci++) {
    const target = chain[ci];
    const rt = getProviderRuntime(target.providerId);
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        assertWithinLimits(target.providerId);
        await acquireSlot(target.providerId, signal);
        let out;
        try {
          out = await rt.adapter.generate({ apiKey: rt.apiKey, baseUrl: rt.baseUrl, model: target.model, system, user, jsonSchema, temperature, signal });
        } finally {
          releaseSlot(target.providerId);
        }
        recordUsage(target.providerId, out.usage);
        if (ci > 0) {
          appendAiLog({ level: 'warn', featureId, providerId: target.providerId, model: target.model, code: 'FALLBACK_USED', message: `Dùng dự phòng sau lỗi: ${failures.map((f) => f.code).join(', ')}` });
        }
        return { ...out, providerId: target.providerId, model: target.model, attempts: attempt, usedFallback: ci > 0, failures };
      } catch (err) {
        const e = err instanceof AiProviderError ? err : new AiProviderError('NETWORK', redactSecrets(err.message), { providerId: target.providerId, retryable: true });
        if (e.code === 'CANCELLED' || (signal && signal.aborted)) throw e;
        if (e.code !== 'LIMIT_EXCEEDED') recordUsage(target.providerId, { error: true });
        appendAiLog({ level: 'error', featureId, providerId: target.providerId, model: target.model, code: e.code, status: e.status, attempt, message: e.message });
        noteTransientFailure(target.providerId, target.model, e.code);
        lastErr = e;
        // Không thử lại cùng model khi quá thời gian (chuyển ngay sang dự phòng); lỗi máy chủ chỉ thử lại 1 lần
        const maxForCode = { TIMEOUT: 1, SERVER: 2, INVALID_RESPONSE: 2 }[e.code] || MAX_ATTEMPTS;
        if (!e.retryable || attempt >= maxForCode) break;
        const backoff = e.retryAfterMs || Math.min(20000, 1500 * 2 ** (attempt - 1));
        await sleep(backoff, signal);
      }
    }
    failures.push({ providerId: target.providerId, model: target.model, code: lastErr.code, message: lastErr.message });
    if (lastErr.code === 'MODEL_NOT_FOUND') {
      markModelUnavailable(target.providerId, target.model);
      // Model đã bị ngừng: thử model khuyến nghị khác của cùng nhà cung cấp (từ danh sách model thật)
      const alt = recommendModel(target.providerId, getProviderModels(target.providerId).filter((m) => (m.id || m) !== target.model));
      if (alt && !isRecentlyUnhealthy(target.providerId, alt) && !chain.some((c) => c.providerId === target.providerId && c.model === alt)) {
        chain.splice(ci + 1, 0, { providerId: target.providerId, model: alt, providerName: target.providerName, autoModel: true });
        appendAiLog({ level: 'warn', featureId, providerId: target.providerId, model: alt, code: 'MODEL_SWITCH', message: `Model ${target.model} không còn khả dụng → thử ${alt}` });
      }
    }
    if (!FALLBACK_CODES.has(lastErr.code) || ci === chain.length - 1) {
      if (failures.length > 1) {
        lastErr.message = `${lastErr.message} (đã thử ${failures.length} nhà cung cấp: ${failures.map((f) => `${f.providerId}/${f.code}`).join(', ')})`;
      }
      throw lastErr;
    }
  }
  throw new AiProviderError('SERVER', 'Không gọi được nhà cung cấp AI nào.');
}

/**
 * Trích JSON từ phản hồi LLM (chấp nhận khối ```json ... ``` hoặc văn bản bao quanh).
 */
function parseJsonFromModel(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (_) {}
  const firstObj = s.indexOf('{');
  const lastObj = s.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) {
    try {
      return JSON.parse(s.slice(firstObj, lastObj + 1));
    } catch (_) {}
  }
  throw new AiProviderError('INVALID_RESPONSE', 'Phản hồi của AI không phải JSON hợp lệ.', { retryable: true });
}

module.exports = {
  AiProviderError,
  isLocalhostUrl,
  recommendModel,
  getProviderModels,
  LOCAL_PROVIDER_ID,
  isLocalProvider,
  getAiLogs,
  getQueueSnapshot,
  buildTargetChain,
  PROVIDER_META,
  FEATURES_META,
  getPublicAiConfig,
  saveAiConfig,
  testProviderConnection,
  resolveFeatureTarget,
  isProviderReady,
  generateText,
  parseJsonFromModel,
  redactSecrets,
  // cho kiểm thử
  _internals: { classifyHttpError, SETTINGS_FILE, SECRETS_FILE, USAGE_FILE, LOG_FILE, ADAPTERS }
};

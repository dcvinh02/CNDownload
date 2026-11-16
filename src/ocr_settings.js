/**
 * Tham số OCR phụ đề người dùng chỉnh trong tab "🔤 Tinh chỉnh OCR" (lưu ở config/ocr_settings.json).
 * Giá trị mặc định và giới hạn khớp với src/subtitle_ocr.py (DEFAULT_PARAMS / PARAM_LIMITS) — Python cũng tự kẹp lại.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = process.env.CN_AI_CONFIG_DIR || path.join(PROJECT_ROOT, 'config');
const FILE = path.join(CONFIG_DIR, 'ocr_settings.json');

const DEFAULTS = { band_top: 0.5, band_bottom: 0.97, center_tol: 0.28, min_conf: 0.75, fps: 4, min_duration: 0.4, static_max_ratio: 0.35 };
const LIMITS = {
  band_top: [0, 0.95],
  band_bottom: [0.05, 1],
  center_tol: [0.05, 0.5],
  min_conf: [0.5, 0.95],
  fps: [1, 10],
  min_duration: [0.1, 2],
  static_max_ratio: [0.1, 1]
};

function sanitize(input) {
  const out = { ...DEFAULTS };
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = Number(input && input[k]);
    if (Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
  }
  if (out.band_bottom - out.band_top < 0.05) {
    out.band_top = DEFAULTS.band_top;
    out.band_bottom = DEFAULTS.band_bottom;
  }
  return out;
}

function loadOcrSettings() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function saveOcrSettings(input) {
  const s = sanitize(input);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2), 'utf8');
  return s;
}

function resetOcrSettings() {
  try {
    fs.unlinkSync(FILE);
  } catch (_) {}
  return { ...DEFAULTS };
}

module.exports = { OCR_DEFAULTS: DEFAULTS, OCR_LIMITS: LIMITS, loadOcrSettings, saveOcrSettings, resetOcrSettings };

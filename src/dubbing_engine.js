const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const {
  getExecutablePath,
  isFileExecutable,
  getLocalModelsStatus
} = require('./capabilities');
const { getFfmpegPath } = require('./extractors/ytdlp_engine');
const { getStorageOverview } = require('./storage_config');
const vieneuService = require('./vieneu_service');
const {
  wavDurationSec,
  scheduleDubSegments,
  writeTimelineWav,
  writeGainEnvelopeWav
} = require('./audio_timeline');
const { translateSegmentsWithLLM } = require('./ai/llm_translator');
const { isProviderReady, resolveFeatureTarget, redactSecrets, isLocalProvider } = require('./ai/ai_provider_manager');

// Định dạng chuẩn cho mọi đoạn giọng đọc trước khi dựng timeline
const DUB_SAMPLE_RATE = 48000;
const VIENEU_ID_PREFIX = 'vieneu:';
const DEFAULT_VIENEU_VOICE = 'Ngọc Huyền'; // giọng lồng tiếng mặc định (theo yêu cầu người dùng)

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENV_PYTHON = path.join(
  PROJECT_ROOT,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python3'
);
const LOCAL_AI_WORKER = path.join(__dirname, 'local_ai_worker.py');
const MODELS_ROOT = path.join(PROJECT_ROOT, 'bin', 'models');
const ASR_MODELS_DIR = path.join(MODELS_ROOT, 'asr');
const ARGOS_MODELS_DIR = path.join(MODELS_ROOT, 'argos');
const TTS_MODELS_DIR = path.join(MODELS_ROOT, 'tts');
const DIARIZATION_DIR = path.join(MODELS_ROOT, 'diarization');

const SEPARATION_MODEL_DIR = path.join(MODELS_ROOT, 'separation', 'sherpa-onnx-spleeter-2stems-fp16');

function isSeparationAvailable() {
  return (
    fs.existsSync(path.join(SEPARATION_MODEL_DIR, 'vocals.fp16.onnx')) &&
    fs.existsSync(path.join(SEPARATION_MODEL_DIR, 'accompaniment.fp16.onnx'))
  );
}

/**
 * Tách giọng nói gốc khỏi nhạc nền (Spleeter). Trả về WAV nền stereo 44.1 kHz để trộn thay âm thanh gốc.
 */
async function separateBackgroundAudio(videoPath, tempDir, trackProc, onProgress) {
  const st44 = path.join(tempDir, 'orig_stereo_44k.wav');
  const bg = path.join(tempDir, 'orig_background_44k.wav');
  await runFfmpegSimple(['-y', '-i', videoPath, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', st44], trackProc);
  const dur = wavDurationSec(st44);
  const res = await runLocalAiWorker(
    ['separate_background', '--input', st44, '--output', bg, '--model-dir', SEPARATION_MODEL_DIR],
    trackProc,
    Math.max(180000, Math.round(dur * 1000) + 120000),
    null,
    (p) => {
      if (p && p.stage === 'separate' && typeof onProgress === 'function') onProgress(p.pos, p.total);
    }
  );
  try {
    fs.unlinkSync(st44);
  } catch (_) {}
  if (!res || !res.ok || !fs.existsSync(bg)) throw new Error((res && res.error) || 'Tách giọng gốc khỏi nhạc nền thất bại.');
  return bg;
}

/**
 * Đo mức RMS (dBFS) của LỜI NÓI gốc trong các khoảng thời gian có thoại (ASR) — dùng để cân bằng
 * giọng lồng tiếng: 100% = to ngang người nói gốc. Trả về null nếu không đo được.
 */
function measureSpeechLevelDb(videoPath, windows) {
  return new Promise((resolve) => {
    const proc = spawn(getFfmpegBin(), ['-v', 'error', '-i', videoPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    const sorted = (windows || []).filter((w) => w.e > w.s).sort((a, b) => a.s - b.s);
    let sumSq = 0;
    let count = 0;
    let sampleIdx = 0;
    let wi = 0;
    let carry = null;
    proc.stdout.on('data', (chunk) => {
      let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      carry = usable < buf.length ? buf.subarray(usable) : null;
      for (let o = 0; o < usable; o += 2) {
        const t = sampleIdx / 8000;
        sampleIdx++;
        while (wi < sorted.length && t > sorted[wi].e) wi++;
        if (wi < sorted.length && t >= sorted[wi].s) {
          const v = buf.readInt16LE(o) / 32768;
          if (Math.abs(v) > 0.003) {
            sumSq += v * v;
            count++;
          }
        }
      }
    });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      if (count < 8000) return resolve(null);
      resolve(Number((10 * Math.log10(sumSq / count)).toFixed(2)));
    });
  });
}

function isDiarizationAvailable() {
  return (
    fs.existsSync(path.join(DIARIZATION_DIR, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx')) &&
    fs.existsSync(path.join(DIARIZATION_DIR, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'))
  );
}

/**
 * Danh mục Mô hình AI Local (ASR, NMT, TTS) kèm đầy đủ thông tin minh bạch:
 * ngôn ngữ, chất lượng, dung lượng mô hình (MB), giấy phép và yêu cầu máy.
 */
const LOCAL_MODELS_CATALOG = [
  {
    id: 'faster-whisper-small',
    category: 'ASR (Nhận dạng giọng nói)',
    name: 'Faster-Whisper Small (CTranslate2 INT8) — Đề xuất',
    language: 'Đa ngôn ngữ (99 ngôn ngữ: Trung, Việt, Anh, Nhật, Hàn...)',
    supportedLanguages: ['zh', 'vi', 'en', 'ja', 'ko'],
    quality: 'Chính xác hơn rõ rệt với tiếng Trung (đo trên video thử: đúng thuật ngữ, thành ngữ); ~0.13x thời gian thực trên M2 Pro',
    modelSizeMB: 464,
    sizeMB: 464,
    license: 'MIT License (OpenAI Whisper / SYSTRAN Faster-Whisper)',
    hardwareReq: 'CPU >= 4 nhân, RAM trống >= 1.2 GB (Chạy 100% Offline)',
    ramRequired: 'CPU >= 4 nhân, RAM trống >= 1.2 GB (Chạy 100% Offline)',
    cpuGpuNote: 'Tối ưu CPU int8',
    relPath: path.join('asr', 'faster-whisper-small', 'model.bin'),
    isDefault: true
  },
  {
    id: 'speaker-diarization',
    category: 'Phân tách người nói (Speaker Diarization)',
    name: 'Pyannote Segmentation 3.0 + 3D-Speaker ERes2Net (sherpa-onnx)',
    language: 'Không phụ thuộc ngôn ngữ',
    supportedLanguages: ['zh', 'vi', 'en', 'ja', 'ko'],
    quality: 'Tự gán speaker_1, speaker_2... cho từng câu; video có nhạc nền dày có thể chia dư người nói — có thể nhập số người nói cố định',
    modelSizeMB: 45,
    sizeMB: 45,
    license: 'MIT (pyannote segmentation) / Apache-2.0 (3D-Speaker)',
    hardwareReq: 'CPU 2+ nhân, RAM trống >= 300 MB (Chạy 100% Offline)',
    ramRequired: 'CPU 2+ nhân, RAM trống >= 300 MB (Chạy 100% Offline)',
    cpuGpuNote: 'Sherpa-ONNX',
    relPath: path.join('diarization', '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'),
    isDefault: false
  },
  {
    id: 'local-llm-qwen35-9b',
    category: 'Dịch thuật AI Local (LLM)',
    name: process.platform === 'win32' ? 'Qwen3.5 9B (GGUF Q4_K_M • llama.cpp) — dịch Trung/Nhật/Hàn → Việt' : 'Qwen3.5 9B (Apple MLX 4-bit) — dịch Trung/Nhật/Hàn → Việt',
    language: 'Trung, Nhật, Hàn, Anh → Việt',
    supportedLanguages: ['zh', 'ja', 'ko', 'en', 'vi'],
    quality: 'Tốt nhất trong các model local đã đánh giá (30 câu thật): ~3,2 giây/câu trên M2 Pro, dùng Hán-Việt cho tên riêng',
    modelSizeMB: process.platform === 'win32' ? 5420 : 5600,
    sizeMB: process.platform === 'win32' ? 5420 : 5600,
    license: process.platform === 'win32' ? 'Apache-2.0 (Qwen) / MIT (llama.cpp)' : 'Apache-2.0 (Qwen) / MIT (mlx-lm)',
    hardwareReq: process.platform === 'win32' ? 'Windows 10/11, RAM 16 GB (GPU tùy chọn)' : 'Mac chip Apple (M1+), RAM trống >= 6 GB',
    ramRequired:
      process.platform === 'win32'
        ? 'Windows 10/11, RAM 16 GB; GPU NVIDIA/AMD/Intel (Vulkan) tăng tốc nếu có (Chạy 100% Offline)'
        : 'Mac chip Apple (M1+), RAM trống >= 6 GB (Chạy 100% Offline)',
    cpuGpuNote: process.platform === 'win32' ? 'llama.cpp (Vulkan GPU hoặc CPU)' : 'Apple MLX (GPU Metal)',
    relPath:
      process.platform === 'win32'
        ? path.join('llm', 'Qwen3.5-9B-Q4_K_M-GGUF', 'Qwen3.5-9B-Q4_K_M.gguf')
        : path.join('llm', 'Qwen3.5-9B-MLX-4bit', 'config.json'),
    isDefault: true
  },
  {
    id: 'voice-separation-spleeter',
    category: 'Tách giọng nói / nhạc nền',
    name: 'Spleeter 2-stems fp16 (sherpa-onnx)',
    language: 'Không phụ thuộc ngôn ngữ',
    supportedLanguages: ['zh', 'vi', 'en', 'ja', 'ko'],
    quality: 'Giảm ~45 dB giọng nói gốc, giữ nhạc nền & tiếng động (đo trên video thử)',
    modelSizeMB: 40,
    sizeMB: 40,
    license: 'MIT (Spleeter)',
    hardwareReq: 'CPU bất kỳ, RAM trống >= 500 MB',
    ramRequired: 'CPU bất kỳ, RAM trống >= 500 MB (Chạy 100% Offline)',
    cpuGpuNote: 'ONNX Runtime',
    relPath: path.join('separation', 'sherpa-onnx-spleeter-2stems-fp16', 'accompaniment.fp16.onnx'),
    isDefault: true
  },
  {
    id: 'argos-nmt-zh-en-vi',
    category: 'NMT (Dịch máy Neural Offline)',
    name: 'Argos OpenNMT CTranslate2 (ZH -> EN -> VI) — dự phòng tùy chọn, đã thay bằng Qwen',
    language: 'Tiếng Trung / Anh / Nhật / Hàn -> Tiếng Việt & Tiếng Anh',
    supportedLanguages: ['zh', 'en', 'vi'],
    quality: 'Dịch câu thoại tự nhiên, giữ ngữ cảnh đoạn thoại',
    modelSizeMB: 215,
    sizeMB: 215,
    license: 'MIT / CC-BY-4.0 (Argos OpenTech / OpenNMT)',
    hardwareReq: 'CPU >= 2 nhân, RAM trống >= 400 MB (Chạy 100% Offline)',
    ramRequired: 'CPU >= 2 nhân, RAM trống >= 400 MB (Chạy 100% Offline)',
    cpuGpuNote: 'CTranslate2 int8',
    relPath: path.join('argos', 'translate-en_vi-1_9', 'model', 'model.bin'),
    isDefault: false
  },
  {
    id: 'vieneu-tts-v3-turbo',
    category: 'TTS (Tổng hợp giọng đọc Tiếng Việt)',
    name: 'VieNeu-TTS v3 Turbo (48 kHz, ONNX Runtime CPU)',
    language: 'Tiếng Việt (vi-VN) + chuyển mã Anh–Việt',
    supportedLanguages: ['vi'],
    quality: 'Neural 48 kHz, 25 giọng dựng sẵn (Bắc/Trung/Nam); đo trên M2 Pro: nhanh ~3.5x thời gian thực',
    modelSizeMB: 581,
    sizeMB: 581,
    license: 'Apache-2.0 (SDK & mô hình v3 Turbo — xem huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo)',
    hardwareReq: 'CPU 4+ nhân, RAM trống >= 2 GB, Python 3.10+ (môi trường riêng .venv-vieneu)',
    ramRequired: 'CPU 4+ nhân, RAM trống >= 2 GB (Chạy 100% Offline sau khi tải mô hình)',
    cpuGpuNote: 'ONNX Runtime fp32',
    customCheck: 'vieneu',
    isDefault: true
  },
  {
    id: 'vits-piper-vi-vais1000',
    category: 'TTS (Tổng hợp giọng đọc Tiếng Việt)',
    name: 'Piper VITS Neural — VAIS-1000 (22.05 kHz)',
    language: 'Tiếng Việt (vi-VN)',
    supportedLanguages: ['vi'],
    quality: 'Neural VITS Medium (22.05 kHz) — Phát âm chuẩn, rõ ràng',
    modelSizeMB: 30,
    sizeMB: 30,
    license: 'MIT License (Piper / rhasspy / VAIS-1000 Dataset)',
    hardwareReq: 'CPU bất kỳ (Apple Silicon / x64), RAM trống >= 180 MB (100% Offline)',
    ramRequired: 'CPU bất kỳ (Apple Silicon / x64), RAM trống >= 180 MB (100% Offline)',
    cpuGpuNote: 'Sherpa-ONNX VITS',
    relPath: path.join('tts', 'vits-piper-vi_VN-vais1000-medium-int8', 'vi_VN-vais1000-medium.onnx'),
    isDefault: true
  },
  {
    id: 'vits-piper-vi-25hours',
    category: 'TTS (Tổng hợp giọng đọc Tiếng Việt)',
    name: 'Piper VITS Neural — 25Hours Single (16 kHz)',
    language: 'Tiếng Việt (vi-VN)',
    supportedLanguages: ['vi'],
    quality: 'Neural VITS (16 kHz) — Giọng nữ miền Nam nhẹ nhàng',
    modelSizeMB: 29,
    sizeMB: 29,
    license: 'MIT License (Piper / rhasspy)',
    hardwareReq: 'CPU bất kỳ, RAM trống >= 180 MB (100% Offline)',
    ramRequired: 'CPU bất kỳ, RAM trống >= 180 MB (100% Offline)',
    cpuGpuNote: 'Sherpa-ONNX VITS',
    relPath: path.join('tts', 'vits-piper-vi_VN-25hours_single-low-int8', 'vi_VN-25hours_single-low.onnx'),
    isDefault: false
  },
  {
    id: 'vits-piper-vi-vivos',
    category: 'TTS (Tổng hợp giọng đọc Tiếng Việt)',
    name: 'Piper VITS Neural — VIVOS Multi-Speaker (65 giọng Nam/Nữ)',
    language: 'Tiếng Việt (vi-VN)',
    supportedLanguages: ['vi'],
    quality: 'Neural VITS Đa giọng (16 kHz) — Hỗ trợ cả giọng Nam và Nữ',
    modelSizeMB: 35,
    sizeMB: 35,
    license: 'MIT / CC-BY-SA 4.0 (VIVOS Corpus - AILAB HCMUS)',
    hardwareReq: 'CPU bất kỳ, RAM trống >= 200 MB (100% Offline)',
    ramRequired: 'CPU bất kỳ, RAM trống >= 200 MB (100% Offline)',
    cpuGpuNote: 'Sherpa-ONNX VITS',
    relPath: path.join('tts', 'vits-piper-vi_VN-vivos-x_low-int8', 'vi_VN-vivos-x_low.onnx'),
    isDefault: false
  }
];

/**
 * Danh mục Giọng đọc (VOICE_CATALOG):
 * - Ưu tiên xử lý Local Offline (Sherpa-ONNX Piper VITS & Hệ điều hành).
 * - Có đầy đủ thông tin: ngôn ngữ, chất lượng, dung lượng mô hình, giấy phép, yêu cầu máy.
 * - Đề xuất 1 giọng mặc định mỗi ngôn ngữ (`isDefaultRecommended: true`), không quảng cáo "hay nhất" vô căn cứ.
 * - Các giọng Cloud (`requiresCloudConsent: true`) chỉ hoạt động khi người dùng chủ động bật xác nhận.
 */
const VOICE_CATALOG = [
  // ===================== TIẾNG VIỆT (VI) =====================
  {
    id: 'vi_piper_vais1000',
    name: 'Ngọc Lan (Neural VITS VAIS-1000 — Nữ Bắc)',
    lang: 'vi',
    locale: 'vi_VN',
    gender: 'Nữ',
    engine: 'sherpa-piper',
    modelFolder: 'vits-piper-vi_VN-vais1000-medium-int8',
    onnxFile: 'vi_VN-vais1000-medium.onnx',
    speakerId: 0,
    rate: 1.0,
    isDefaultRecommended: true,
    requiresCloudConsent: false,
    processingMode: 'Local Offline (Sherpa-ONNX VITS)',
    qualityLabel: 'Neural Medium (22.05 kHz, tự nhiên, rõ chữ)',
    modelSizeMB: 30,
    license: 'MIT License (Open Source)',
    hardwareReq: 'CPU >= 2 nhân, RAM >= 180 MB (Chạy trên máy)',
    sampleText: 'Xin chào, đây là giọng đọc tiếng Việt tổng hợp bằng mô hình trí tuệ nhân tạo chạy trực tiếp trên máy tính của bạn.'
  },
  {
    id: 'vi_piper_25hours',
    name: 'Minh Châu (Neural VITS 25Hours — Nữ Nam)',
    lang: 'vi',
    locale: 'vi_VN',
    gender: 'Nữ',
    engine: 'sherpa-piper',
    modelFolder: 'vits-piper-vi_VN-25hours_single-low-int8',
    onnxFile: 'vi_VN-25hours_single-low.onnx',
    speakerId: 0,
    rate: 1.0,
    isDefaultRecommended: false,
    requiresCloudConsent: false,
    processingMode: 'Local Offline (Sherpa-ONNX VITS)',
    qualityLabel: 'Neural Standard (16 kHz, âm sắc ấm)',
    modelSizeMB: 29,
    license: 'MIT License (Open Source)',
    hardwareReq: 'CPU >= 2 nhân, RAM >= 180 MB (Chạy trên máy)',
    sampleText: 'Xin chào các bạn, đây là giọng đọc tiếng Việt xử lý ngoại tuyến giúp bảo mật dữ liệu hoàn toàn.'
  },
  {
    id: 'vi_piper_vivos_nam_1',
    name: 'Hoàng Nam (Neural VITS VIVOS #1 — Nam)',
    lang: 'vi',
    locale: 'vi_VN',
    gender: 'Nam',
    engine: 'sherpa-piper',
    modelFolder: 'vits-piper-vi_VN-vivos-x_low-int8',
    onnxFile: 'vi_VN-vivos-x_low.onnx',
    speakerId: 1,
    rate: 1.0,
    isDefaultRecommended: false,
    requiresCloudConsent: false,
    processingMode: 'Local Offline (Sherpa-ONNX VITS)',
    qualityLabel: 'Neural Multi-Speaker (16 kHz, giọng Nam trầm)',
    modelSizeMB: 35,
    license: 'MIT / CC-BY-SA 4.0 (VIVOS Corpus)',
    hardwareReq: 'CPU >= 2 nhân, RAM >= 200 MB (Chạy trên máy)',
    sampleText: 'Xin chào, đây là giọng nam tiếng Việt được tổng hợp từ bộ dữ liệu VIVOS ngay trên thiết bị.'
  },
  {
    id: 'vi_piper_vivos_nu_0',
    name: 'Thanh Hà (Neural VITS VIVOS #0 — Nữ)',
    lang: 'vi',
    locale: 'vi_VN',
    gender: 'Nữ',
    engine: 'sherpa-piper',
    modelFolder: 'vits-piper-vi_VN-vivos-x_low-int8',
    onnxFile: 'vi_VN-vivos-x_low.onnx',
    speakerId: 0,
    rate: 1.0,
    isDefaultRecommended: false,
    requiresCloudConsent: false,
    processingMode: 'Local Offline (Sherpa-ONNX VITS)',
    qualityLabel: 'Neural Multi-Speaker (16 kHz, giọng Nữ rõ ràng)',
    modelSizeMB: 35,
    license: 'MIT / CC-BY-SA 4.0 (VIVOS Corpus)',
    hardwareReq: 'CPU >= 2 nhân, RAM >= 200 MB (Chạy trên máy)',
    sampleText: 'Xin chào, tôi là giọng đọc Thanh Hà trong bộ mô hình đa người nói VIVOS tiếng Việt.'
  },
  {
    id: 'vi_piper_vivos_nam_2',
    name: 'Quốc Bảo (Neural VITS VIVOS #2 — Nam thuyết minh)',
    lang: 'vi',
    locale: 'vi_VN',
    gender: 'Nam',
    engine: 'sherpa-piper',
    modelFolder: 'vits-piper-vi_VN-vivos-x_low-int8',
    onnxFile: 'vi_VN-vivos-x_low.onnx',
    speakerId: 2,
    rate: 0.96,
    isDefaultRecommended: false,
    requiresCloudConsent: false,
    processingMode: 'Local Offline (Sherpa-ONNX VITS)',
    qualityLabel: 'Neural Multi-Speaker (16 kHz, nhịp đọc điềm tĩnh)',
    modelSizeMB: 35,
    license: 'MIT / CC-BY-SA 4.0 (VIVOS Corpus)',
    hardwareReq: 'CPU >= 2 nhân, RAM >= 200 MB (Chạy trên máy)',
    sampleText: 'Chào mừng các bạn đến với nội dung thuyết minh tiếng Việt được tạo tự động từ lời thoại gốc.'
  },
  {
    id: 'vi_piper_vivos_nu_3',
    name: 'Mai Anh (Neural VITS VIVOS #3 — Nữ trẻ)',
    lang: 'vi',
    locale: 'vi_VN',
    gender: 'Nữ',
    engine: 'sherpa-piper',
    modelFolder: 'vits-piper-vi_VN-vivos-x_low-int8',
    onnxFile: 'vi_VN-vivos-x_low.onnx',
    speakerId: 3,
    rate: 1.0,
    isDefaultRecommended: false,
    requiresCloudConsent: false,
    processingMode: 'Local Offline (Sherpa-ONNX VITS)',
    qualityLabel: 'Neural Multi-Speaker (16 kHz, giọng Nữ sáng)',
    modelSizeMB: 35,
    license: 'MIT / CC-BY-SA 4.0 (VIVOS Corpus)',
    hardwareReq: 'CPU >= 2 nhân, RAM >= 200 MB (Chạy trên máy)',
    sampleText: 'Xin chào, bạn có thể nghe thử và chọn giọng đọc phù hợp với nội dung video của mình.'
  },
  {
    id: 'vi_piper_vivos_nam_11',
    name: 'Đức Minh (Neural VITS VIVOS #11 — Nam nhanh)',
    lang: 'vi',
    locale: 'vi_VN',
    gender: 'Nam',
    engine: 'sherpa-piper',
    modelFolder: 'vits-piper-vi_VN-vivos-x_low-int8',
    onnxFile: 'vi_VN-vivos-x_low.onnx',
    speakerId: 11,
    rate: 1.04,
    isDefaultRecommended: false,
    requiresCloudConsent: false,
    processingMode: 'Local Offline (Sherpa-ONNX VITS)',
    qualityLabel: 'Neural Multi-Speaker (16 kHz, tốc độ linh hoạt cho video ngắn)',
    modelSizeMB: 35,
    license: 'MIT / CC-BY-SA 4.0 (VIVOS Corpus)',
    hardwareReq: 'CPU >= 2 nhân, RAM >= 200 MB (Chạy trên máy)',
    sampleText: 'Giọng đọc tốc độ linh hoạt phù hợp với các video ngắn có nhịp điệu nhanh.'
  },
  {
    id: 'Linh',
    name: 'Linh (Giọng tích hợp macOS — Nữ)',
    lang: 'vi',
    locale: 'vi_VN',
    gender: 'Nữ',
    engine: 'system-tts',
    voiceArg: 'Linh',
    rate: 185,
    isDefaultRecommended: false,
    requiresCloudConsent: false,
    processingMode: 'Local OS Speech Synthesizer',
    qualityLabel: 'Cơ bản (Speech Synthesis có sẵn trên hệ điều hành)',
    modelSizeMB: 0,
    license: 'Bản quyền hệ điều hành (Apple macOS / Windows SAPI)',
    hardwareReq: 'Tích hợp sẵn trong hệ điều hành, không tốn thêm RAM',
    sampleText: 'Xin chào, đây là giọng đọc Linh tích hợp sẵn trên hệ điều hành của bạn.'
  },
  {
    id: 'vi_edge_hoaimy',
    name: 'Hoài My (Cloud Neural — Nữ, cần bật cho phép Cloud)',
    lang: 'vi',
    locale: 'vi_VN',
    gender: 'Nữ',
    engine: 'edge-tts',
    voiceArg: 'vi-VN-HoaiMyNeural',
    rate: 1.0,
    isDefaultRecommended: false,
    requiresCloudConsent: true,
    processingMode: 'Cloud Neural TTS (Chỉ gửi khi người dùng đồng ý)',
    qualityLabel: 'Cloud Neural 24 kHz (Yêu cầu kết nối mạng & đồng ý gửi văn bản)',
    modelSizeMB: 0,
    license: 'Dịch vụ đám mây Microsoft Edge Read Aloud',
    hardwareReq: 'Yêu cầu kết nối Internet và bật tùy chọn Cho phép Cloud',
    sampleText: 'Xin chào, đây là giọng đọc Hoài My sử dụng dịch vụ đám mây khi bạn chủ động cho phép.'
  },
  {
    id: 'vi_edge_namminh',
    name: 'Nam Minh (Cloud Neural — Nam, cần bật cho phép Cloud)',
    lang: 'vi',
    locale: 'vi_VN',
    gender: 'Nam',
    engine: 'edge-tts',
    voiceArg: 'vi-VN-NamMinhNeural',
    rate: 1.0,
    isDefaultRecommended: false,
    requiresCloudConsent: true,
    processingMode: 'Cloud Neural TTS (Chỉ gửi khi người dùng đồng ý)',
    qualityLabel: 'Cloud Neural 24 kHz (Yêu cầu kết nối mạng & đồng ý gửi văn bản)',
    modelSizeMB: 0,
    license: 'Dịch vụ đám mây Microsoft Edge Read Aloud',
    hardwareReq: 'Yêu cầu kết nối Internet và bật tùy chọn Cho phép Cloud',
    sampleText: 'Xin chào, đây là giọng đọc Nam Minh sử dụng dịch vụ đám mây khi bạn chủ động cho phép.'
  },

  // ===================== TIẾNG ANH (EN) =====================
  {
    id: 'Samantha',
    name: 'Samantha (Local OS — Nữ chuẩn Mỹ)',
    lang: 'en',
    locale: 'en_US',
    gender: 'Nữ',
    engine: 'system-tts',
    voiceArg: 'Samantha',
    rate: 185,
    isDefaultRecommended: true,
    requiresCloudConsent: false,
    processingMode: 'Local OS Speech Synthesizer',
    qualityLabel: 'Chuẩn hệ điều hành (22 kHz Offline)',
    modelSizeMB: 0,
    license: 'Bản quyền hệ điều hành',
    hardwareReq: 'Tích hợp sẵn trên máy, chạy 100% Offline',
    sampleText: 'Hello, this is the default local English voice for video dubbing.'
  },
  {
    id: 'Daniel',
    name: 'Daniel (Local OS — Nam chuẩn Anh)',
    lang: 'en',
    locale: 'en_GB',
    gender: 'Nam',
    engine: 'system-tts',
    voiceArg: 'Daniel',
    rate: 185,
    isDefaultRecommended: false,
    requiresCloudConsent: false,
    processingMode: 'Local OS Speech Synthesizer',
    qualityLabel: 'Chuẩn hệ điều hành (22 kHz Offline)',
    modelSizeMB: 0,
    license: 'Bản quyền hệ điều hành',
    hardwareReq: 'Tích hợp sẵn trên máy, chạy 100% Offline',
    sampleText: 'Hello, this is Daniel speaking in British English.'
  },

  // ===================== TIẾNG TRUNG (ZH) =====================
  {
    id: 'Tingting',
    name: 'Tingting 婷婷 (Local OS — Nữ Phổ thông)',
    lang: 'zh',
    locale: 'zh_CN',
    gender: 'Nữ',
    engine: 'system-tts',
    voiceArg: 'Tingting',
    rate: 185,
    isDefaultRecommended: true,
    requiresCloudConsent: false,
    processingMode: 'Local OS Speech Synthesizer',
    qualityLabel: 'Chuẩn hệ điều hành (22 kHz Offline)',
    modelSizeMB: 0,
    license: 'Bản quyền hệ điều hành',
    hardwareReq: 'Tích hợp sẵn trên máy, chạy 100% Offline',
    sampleText: '你好，这是本地中文语音合成测试。'
  },

  // ===================== TIẾNG NHẬT (JA) =====================
  {
    id: 'Kyoko',
    name: 'Kyoko 京子 (Local OS — Nữ Nhật Bản)',
    lang: 'ja',
    locale: 'ja_JP',
    gender: 'Nữ',
    engine: 'system-tts',
    voiceArg: 'Kyoko',
    rate: 185,
    isDefaultRecommended: true,
    requiresCloudConsent: false,
    processingMode: 'Local OS Speech Synthesizer',
    qualityLabel: 'Chuẩn hệ điều hành (22 kHz Offline)',
    modelSizeMB: 0,
    license: 'Bản quyền hệ điều hành',
    hardwareReq: 'Tích hợp sẵn trên máy, chạy 100% Offline',
    sampleText: 'こんにちは、ローカル音声合成のテストです。'
  },

  // ===================== TIẾNG HÀN (KO) =====================
  {
    id: 'Yuna',
    name: 'Yuna 유나 (Local OS — Nữ Hàn Quốc)',
    lang: 'ko',
    locale: 'ko_KR',
    gender: 'Nữ',
    engine: 'system-tts',
    voiceArg: 'Yuna',
    rate: 185,
    isDefaultRecommended: true,
    requiresCloudConsent: false,
    processingMode: 'Local OS Speech Synthesizer',
    qualityLabel: 'Chuẩn hệ điều hành (22 kHz Offline)',
    modelSizeMB: 0,
    license: 'Bản quyền hệ điều hành',
    hardwareReq: 'Tích hợp sẵn trên máy, chạy 100% Offline',
    sampleText: '안녕하세요, 로컬 음성 합성 테스트입니다.'
  }
];

const LANGUAGE_INFO = {
  zh: { code: 'zh', name: 'Tiếng Trung (Chinese)', flag: '🇨🇳' },
  vi: { code: 'vi', name: 'Tiếng Việt (Vietnamese)', flag: '🇻🇳' },
  en: { code: 'en', name: 'Tiếng Anh (English)', flag: '🇺🇸' },
  ja: { code: 'ja', name: 'Tiếng Nhật (Japanese)', flag: '🇯🇵' },
  ko: { code: 'ko', name: 'Tiếng Hàn (Korean)', flag: '🇰🇷' }
};

/**
 * 5 bước quy trình lồng tiếng bắt buộc, được báo cáo rõ ràng về trạng thái:
 * 1. Tách tiếng (FFmpeg)
 * 2. Nhận dạng giọng nói (ASR)
 * 3. Dịch lời thoại (Translate)
 * 4. Tạo giọng đọc & căn thời gian (TTS & Align)
 * 5. Ghép âm thanh vào video & xác minh (Mux & Verify)
 */
const DUBBING_PIPELINE_STEPS = [
  { index: 1, code: 'extract_audio', label: 'Bước 1/5: Tách âm thanh gốc từ video (FFmpeg)' },
  { index: 2, code: 'asr_recognize', label: 'Bước 2/5: Nhận dạng giọng nói & chia mốc thời gian (ASR)' },
  { index: 3, code: 'translate_segments', label: 'Bước 3/5: Dịch từng đoạn thoại sang ngôn ngữ đích' },
  { index: 4, code: 'synthesize_tts', label: 'Bước 4/5: Tạo giọng đọc bản dịch & căn khớp thời gian' },
  { index: 5, code: 'mux_and_verify', label: 'Bước 5/5: Ghép âm thanh vào video & xác minh đầu ra' }
];

const TRANSLATION_PROVIDERS_CATALOG = [
  {
    id: 'auto',
    name: 'Tự động (Local Offline mặc định / Cloud khi cho phép)',
    requiresCloudConsent: false,
    requiresApiKey: false,
    description: 'Mặc định chạy 100% trên máy tính; tự nâng cấp Cloud Ngữ cảnh nếu bạn bật cho phép Cloud.'
  },
  {
    id: 'local',
    name: 'Offline Local NMT (Argos CTranslate2 Ngữ cảnh — Riêng tư)',
    requiresCloudConsent: false,
    requiresApiKey: false,
    description: 'Gộp câu theo ngữ cảnh + beam search 4 chạy hoàn toàn offline trên máy.'
  },
  {
    id: 'cloud_google',
    name: 'Cloud Google Ngữ cảnh (Gộp câu mượt, miễn phí)',
    requiresCloudConsent: true,
    requiresApiKey: false,
    description: 'Dịch cả đoạn hội thoại qua Google Translate kèm chỉnh văn phong nói tự nhiên.'
  },
  {
    id: 'ai',
    name: 'AI Text theo cấu hình (tab Tích hợp AI → chức năng "Dịch lời thoại")',
    requiresCloudConsent: true,
    requiresApiKey: true,
    description: 'Dùng nhà cung cấp + model đã chọn cho chức năng dịch. Giữ nguyên ID/timestamp từng phân đoạn.'
  },
  {
    id: 'ai_gemini',
    name: 'Google Gemini API (cần API Key)',
    requiresCloudConsent: true,
    requiresApiKey: true,
    description: 'Dịch theo lô kèm ngữ cảnh, prompt phiên dịch viên chuyên nghiệp, trả JSON đúng cấu trúc.'
  },
  {
    id: 'ai_openai',
    name: 'OpenAI ChatGPT API (cần API Key)',
    requiresCloudConsent: true,
    requiresApiKey: true,
    description: 'Chat Completions + JSON mode, kiểm tra số lượng/ID phân đoạn trước khi ghép.'
  },
  {
    id: 'ai_openai_compatible',
    name: 'API tương thích OpenAI (DeepSeek, Groq, OpenRouter, LM Studio...)',
    requiresCloudConsent: true,
    requiresApiKey: true,
    description: 'Cần cấu hình Base URL + API Key + model trong tab Tích hợp AI.'
  }
];

const TRANSLATION_STYLES = [
  { id: 'natural', name: 'Khẩu ngữ tự nhiên (Mặc định)' },
  { id: 'review', name: 'Review / Chuyên nghiệp' },
  { id: 'story', name: 'Kể chuyện / Thuyết minh' }
];

const activeDubbingJobs = new Map();

/* ---------- Lưu trạng thái tác vụ lồng tiếng xuống đĩa (phục hồi khi ứng dụng bị tắt giữa chừng) ---------- */
const JOB_STATE_FILE = path.join(process.env.CN_AI_CONFIG_DIR || path.join(PROJECT_ROOT, 'config'), 'dub_jobs_state.json');
const persistedJobs = new Map(); // jobId -> bản ghi tối giản (kể cả tác vụ bị gián đoạn từ lần chạy trước)
let persistTimer = null;

function loadPersistedJobs() {
  try {
    const arr = JSON.parse(fs.readFileSync(JOB_STATE_FILE, 'utf8'));
    for (const j of Array.isArray(arr) ? arr : []) {
      if (j.status === 'running') {
        j.status = 'interrupted';
        j.error = 'Ứng dụng bị tắt hoặc gián đoạn khi tác vụ đang chạy. Bấm "Chạy tiếp" để làm lại — phần dịch AI đã hoàn tất được dùng lại từ bộ nhớ đệm.';
        j.step = `⚠️ Bị gián đoạn ở bước ${j.stepIndex || '?'}/5`;
        j.statusText = j.step;
      }
      persistedJobs.set(j.jobId, j);
    }
  } catch (_) {}
}
loadPersistedJobs();

function snapshotJob(job) {
  return {
    jobId: job.jobId,
    id: job.jobId,
    status: job.status,
    progress: job.progress,
    stepIndex: job.stepIndex,
    step: job.step,
    statusText: job.statusText,
    error: job.error,
    videoPath: job.videoPath,
    inputFileName: job.inputFileName,
    outputPath: job.outputPath,
    outputVideoPath: job.outputVideoPath,
    outputFileName: job.outputFileName,
    targetLangName: job.targetLangName,
    voiceName: job.voiceName,
    originalVolume: job.originalVolume,
    dubVolume: job.dubVolume,
    autoDucking: job.autoDucking,
    warnings: job.warnings,
    source: job.source || 'download',
    outputDir: job.outputDir || null,
    logs: (job.logs || []).slice(-150),
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    resumeParams: job.resumeParams || null
  };
}

function persistJobsSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      for (const job of activeDubbingJobs.values()) persistedJobs.set(job.jobId, snapshotJob(job));
      const list = Array.from(persistedJobs.values())
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 40);
      fs.mkdirSync(path.dirname(JOB_STATE_FILE), { recursive: true });
      const tmp = `${JOB_STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list));
      fs.renameSync(tmp, JOB_STATE_FILE);
    } catch (_) {}
  }, 1500);
  if (persistTimer.unref) persistTimer.unref();
}

function resumeDubbingJob(jobId) {
  const rec = persistedJobs.get(jobId) || (activeDubbingJobs.get(jobId) && snapshotJob(activeDubbingJobs.get(jobId)));
  if (!rec || !rec.resumeParams) throw new Error('Không có đủ thông tin để chạy tiếp tác vụ này.');
  if (rec.status === 'running') throw new Error('Tác vụ đang chạy.');
  const job = startDubbingJob(rec.resumeParams);
  persistedJobs.delete(jobId);
  persistJobsSoon();
  return job;
}

function buildStepsProgress(activeStepIndex, statusOverride = null, errorStepIndex = null) {
  return DUBBING_PIPELINE_STEPS.map((s) => {
    let state = 'pending';
    if (errorStepIndex && s.index === errorStepIndex) {
      state = 'error';
    } else if (errorStepIndex && s.index < errorStepIndex) {
      state = 'completed';
    } else if (!errorStepIndex) {
      if (statusOverride === 'completed') {
        state = 'completed';
      } else if (s.index < activeStepIndex) {
        state = 'completed';
      } else if (s.index === activeStepIndex) {
        state = 'running';
      }
    }
    return {
      index: s.index,
      code: s.code,
      label: s.label,
      state
    };
  });
}

function getFfmpegBin() {
  const p = getFfmpegPath();
  if (p && isFileExecutable(p)) return p;
  const localBin = getExecutablePath('ffmpeg');
  if (isFileExecutable(localBin)) return localBin;
  return 'ffmpeg';
}

function getFfprobeBin() {
  const localProbe = getExecutablePath('ffprobe');
  if (isFileExecutable(localProbe)) return localProbe;
  return 'ffprobe';
}

function hasLocalPythonWorker() {
  return fs.existsSync(VENV_PYTHON) && fs.existsSync(LOCAL_AI_WORKER);
}

function getPreferredAsrModelDir() {
  // Ưu tiên model chính xác nhất đang có: small > base > tiny
  const smallDir = path.join(ASR_MODELS_DIR, 'faster-whisper-small');
  if (fs.existsSync(path.join(smallDir, 'model.bin'))) return smallDir;
  const baseDir = path.join(ASR_MODELS_DIR, 'faster-whisper-base');
  if (fs.existsSync(path.join(baseDir, 'model.bin'))) return baseDir;
  const tinyDir = path.join(ASR_MODELS_DIR, 'faster-whisper-tiny');
  if (fs.existsSync(path.join(tinyDir, 'model.bin'))) return tinyDir;
  return null;
}

function isVieneuReady() {
  return vieneuService.isSdkInstalled() && vieneuService.isModelDownloaded();
}

/**
 * Danh sách giọng VieNeu-TTS lấy từ chính SDK (list_preset_voices) — được lưu cache sau lần nạp mô hình đầu tiên.
 * Nếu chưa cài/chưa tải mô hình: trả về 1 mục trạng thái "chưa cài" (installed=false), không giả lập âm thanh.
 */
function getVieneuVoiceEntries() {
  const st = vieneuService.getStatus();
  const base = {
    lang: 'vi',
    locale: 'vi_VN',
    engine: 'vieneu',
    rate: 1.0,
    requiresCloudConsent: false,
    processingMode: 'Local Offline (VieNeu-TTS v3 Turbo • ONNX Runtime)',
    qualityLabel: 'Neural 48 kHz (VieNeu-TTS v3 Turbo)',
    modelSizeMB: 581,
    license: 'Apache-2.0 (VieNeu-TTS)',
    hardwareReq: 'CPU 4+ nhân, RAM >= 2 GB (Chạy trên máy, không gửi dữ liệu ra ngoài)',
    sampleText: 'Xin chào, đây là giọng đọc VieNeu-TTS chạy trực tiếp trên máy tính của bạn, không cần kết nối mạng.'
  };
  if (!st.voices || st.voices.length === 0) {
    return [
      {
        ...base,
        id: `${VIENEU_ID_PREFIX}default`,
        voiceArg: '',
        name: st.sdkInstalled
          ? 'VieNeu-TTS (chưa tải mô hình — mở tab Công cụ để tải)'
          : 'VieNeu-TTS (chưa cài — mở tab Công cụ để cài đặt)',
        gender: '',
        isDefaultRecommended: false
      }
    ];
  }
  const preferredVoice = st.voices.some(([, v]) => v === DEFAULT_VIENEU_VOICE) ? DEFAULT_VIENEU_VOICE : st.defaultVoice;
  return st.voices.map(([label, vid]) => {
    // Nhãn SDK dạng: "⭐ Hải Đăng — Nam · Bắc · Phong cách tự nhiên"
    const cleanLabel = String(label || vid).replace(/^⭐\s*/, '').trim();
    const details = (cleanLabel.split('—')[1] || '').split('·').map((x) => x.trim()).filter(Boolean);
    const gender = ['Nam', 'Nữ'].includes(details[0]) ? details[0] : '';
    const rest = gender ? details.slice(1) : details;
    return {
      ...base,
      id: `${VIENEU_ID_PREFIX}${vid}`,
      voiceArg: vid,
      name: `${vid}${rest.length ? ` (${rest.join(' · ')})` : ''} — VieNeu-TTS 48 kHz`,
      gender,
      featured: String(label || '').startsWith('⭐'),
      isDefaultRecommended: vid === preferredVoice
    };
  });
}

function getAllVoiceCatalog() {
  return [...getVieneuVoiceEntries(), ...VOICE_CATALOG];
}

function isVoiceAvailableOnMachine(voice) {
  if (!voice) return false;
  if (voice.engine === 'vieneu') {
    return isVieneuReady() && Boolean(voice.voiceArg);
  }
  if (voice.engine === 'sherpa-piper') {
    if (!hasLocalPythonWorker()) return false;
    const onnxPath = path.join(TTS_MODELS_DIR, voice.modelFolder || '', voice.onnxFile || '');
    const tokensPath = path.join(TTS_MODELS_DIR, voice.modelFolder || '', 'tokens.txt');
    return fs.existsSync(onnxPath) && fs.existsSync(tokensPath);
  }
  if (voice.engine === 'edge-tts') {
    return hasLocalPythonWorker();
  }
  if (voice.engine === 'system-tts') {
    // Giọng Linh/Samantha/Tingting... là giọng có sẵn của macOS. Trên Windows nhánh SAPI dùng giọng mặc định
    // của hệ thống (thường là tiếng Anh) nên chỉ coi là dùng được cho tiếng Anh.
    if (process.platform === 'darwin') return true;
    if (process.platform === 'win32') return voice.lang === 'en';
    return false;
  }
  return true;
}

function getSupportedVoices(targetLang = null) {
  const all = getAllVoiceCatalog().map((v) => ({ ...v, installed: isVoiceAvailableOnMachine(v) }));
  // Khi VieNeu-TTS sẵn sàng (đã cài + có giọng), giọng mặc định của VieNeu là giọng đề xuất cho tiếng Việt.
  // Các giọng cũ vẫn giữ nguyên để người dùng lựa chọn.
  const vieneuDefaultReady = all.some((v) => v.engine === 'vieneu' && v.installed && v.isDefaultRecommended);
  const voices = all.map((v) => {
    if (v.engine === 'vieneu' && !v.installed) return { ...v, isDefaultRecommended: false };
    if (vieneuDefaultReady && v.lang === 'vi' && v.engine !== 'vieneu') return { ...v, isDefaultRecommended: false };
    return v;
  });
  if (!targetLang) return voices;
  return voices.filter((v) => v.lang === targetLang);
}

function getLocalModelsCatalogStatus() {
  return LOCAL_MODELS_CATALOG.map((m) => {
    if (m.customCheck === 'vieneu') {
      const st = vieneuService.getStatus();
      return {
        ...m,
        installed: st.sdkInstalled && st.modelDownloaded,
        sdkInstalled: st.sdkInstalled,
        modelDownloaded: st.modelDownloaded,
        voiceCount: st.voices.length
      };
    }
    const fullPath = path.join(MODELS_ROOT, m.relPath);
    return {
      ...m,
      installed: fs.existsSync(fullPath)
    };
  });
}

function resolveVoiceConfig(voiceId, targetLang = 'vi', options = {}) {
  const allowCloud = Boolean(options.cloudConsent);
  const catalog = getAllVoiceCatalog();
  let byId = catalog.find((v) => v.id === voiceId);
  if (!byId && typeof voiceId === 'string' && voiceId.startsWith(VIENEU_ID_PREFIX)) {
    if (isVieneuReady() && vieneuService.getStatus().voices.length > 0) {
      throw new Error(`Không có giọng VieNeu-TTS "${voiceId.slice(VIENEU_ID_PREFIX.length)}". Hãy chọn giọng trong danh sách.`);
    }
    byId = catalog.find((v) => v.engine === 'vieneu');
  }
  if (byId) {
    if (byId.requiresCloudConsent && !allowCloud) {
      throw new Error(
        `Giọng đọc "${byId.name}" sử dụng dịch vụ đám mây. Vui lòng bật tùy chọn "Cho phép gửi văn bản lên Cloud" hoặc chọn một giọng đọc Local Offline.`
      );
    }
    if (byId.engine === 'vieneu' && !isVoiceAvailableOnMachine(byId)) {
      throw new Error(
        vieneuService.isSdkInstalled()
          ? 'Chưa tải mô hình VieNeu-TTS v3 Turbo. Mở tab "Công cụ" → tải "VieNeu-TTS" hoặc chọn giọng khác.'
          : 'Chưa cài VieNeu-TTS. Mở tab "Công cụ" → cài "VieNeu-TTS" hoặc chọn giọng khác.'
      );
    }
    if (byId.engine === 'sherpa-piper' && !isVoiceAvailableOnMachine(byId)) {
      throw new Error(
        `Mô hình giọng đọc "${byId.name}" (${byId.modelFolder}) chưa được cài đặt. Vui lòng tải mô hình trong mục Công cụ hoặc chọn giọng khác.`
      );
    }
    return byId;
  }

  // Chọn giọng mặc định được đề xuất cho ngôn ngữ đích
  const langVoices = getSupportedVoices(targetLang).filter((v) => !v.requiresCloudConsent);
  const recommended = langVoices.find((v) => v.isDefaultRecommended && isVoiceAvailableOnMachine(v));
  if (recommended) return recommended;
  const fallbackInstalled = langVoices.find((v) => isVoiceAvailableOnMachine(v));
  if (fallbackInstalled) return fallbackInstalled;
  return VOICE_CATALOG.find((v) => v.lang === targetLang) || VOICE_CATALOG[0];
}

/**
 * Rút gọn tên file gốc theo độ dài byte UTF-8 an toàn (<= maxBytes)
 * để khi ghép thêm hậu tố `_Dubbed_VI_12345.dubbing.metadata.json` không bao giờ vượt 255 bytes (ENAMETOOLONG).
 */
function truncateUtf8BaseName(baseName, maxBytes = 110) {
  const clean = String(baseName || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim();
  if (Buffer.byteLength(clean, 'utf8') <= maxBytes) {
    return clean;
  }
  let out = '';
  for (const ch of clean) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break;
    out += ch;
  }
  return out.trim() || 'video';
}

function detectSourceLanguage(text = '') {
  const sample = String(text || '');
  const cjkMatches = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  const kanaMatches = (sample.match(/[\u3040-\u30ff]/g) || []).length;
  const hangulMatches = (sample.match(/[\uac00-\ud7af]/g) || []).length;
  const viMatches = (
    sample.match(/[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/gi) || []
  ).length;

  if (kanaMatches > 2) return LANGUAGE_INFO.ja;
  if (hangulMatches > 2) return LANGUAGE_INFO.ko;
  if (cjkMatches >= 1) return LANGUAGE_INFO.zh;
  if (viMatches >= 2) return LANGUAGE_INFO.vi;
  return LANGUAGE_INFO.en;
}

/**
 * Chạy Python Local AI Worker và parse JSON từ dòng `WORKER_JSON:...`
 */
function runLocalAiWorker(args, trackProc = null, timeoutMs = 180000, extraEnv = null, onProgress = null) {
  return new Promise((resolve, reject) => {
    if (!hasLocalPythonWorker()) {
      return reject(
        new Error(
          'Môi trường Python AI nội bộ (.venv) hoặc local_ai_worker.py chưa sẵn sàng. Vui lòng cài đặt công cụ AI Local.'
        )
      );
    }

    const childEnv = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      HF_HUB_DISABLE_SYMLINKS_WARNING: '1'
    };
    if (extraEnv && typeof extraEnv === 'object') {
      for (const [k, v] of Object.entries(extraEnv)) {
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          childEnv[k] = String(v);
        }
      }
    }

    // Dữ liệu lớn đi qua file tạm: Windows giới hạn dòng lệnh 32.767 ký tự (video dài vượt xa con số này)
    let payloadFile = null;
    const finalArgs = [...args];
    const pj = finalArgs.indexOf('--payload-json');
    if (pj >= 0 && typeof finalArgs[pj + 1] === 'string') {
      payloadFile = path.join(os.tmpdir(), `cn_ai_payload_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
      fs.writeFileSync(payloadFile, finalArgs[pj + 1], 'utf8');
      finalArgs.splice(pj, 2, '--payload-file', payloadFile);
    }
    const cleanupPayload = () => {
      if (payloadFile) {
        try {
          fs.unlinkSync(payloadFile);
        } catch (_) {}
        payloadFile = null;
      }
    };

    const proc = spawn(VENV_PYTHON, [LOCAL_AI_WORKER, ...finalArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      windowsHide: true
    });
    proc.on('close', cleanupPayload);
    proc.on('error', cleanupPayload);

    if (typeof trackProc === 'function') trackProc(proc);

    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      reject(new Error(`Quá thời gian xử lý AI Local Worker (Timeout ${Math.round(timeoutMs / 1000)} giây).`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (typeof onProgress === 'function') {
        lineBuf += text;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (line.startsWith('WORKER_PROGRESS:')) {
            try {
              onProgress(JSON.parse(line.slice('WORKER_PROGRESS:'.length)));
            } catch (_) {}
          }
        }
      }
      // Giới hạn bộ nhớ: chỉ giữ phần cuối (kết quả JSON luôn là dòng cuối cùng)
      if (stdout.length > 4 * 1024 * 1024) {
        const keepFrom = stdout.lastIndexOf('\n', stdout.length - 1024 * 1024);
        stdout = stdout.slice(Math.max(0, keepFrom));
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Không thể khởi chạy AI Local Worker: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('WORKER_JSON:')) {
          try {
            const parsed = JSON.parse(line.slice('WORKER_JSON:'.length));
            return resolve(parsed);
          } catch (e) {
            return reject(new Error(`Dữ liệu trả về từ AI Worker không hợp lệ: ${e.message}`));
          }
        }
      }
      reject(
        new Error(
          `AI Worker kết thúc bất thường (mã ${code}): ${stderr.slice(-400) || stdout.slice(-400) || 'Không rõ lỗi'}`
        )
      );
    });
  });
}

/**
 * Dịch danh sách câu thoại:
 * - Mặc định chạy 100% Offline qua Local Argos CTranslate2.
 * - Chỉ gọi Cloud khi options.cloudConsent === true.
 */
/**
 * Chuẩn hóa mã bộ dịch. Mã cũ `cloud_gemini` / `cloud_openai` được ánh xạ sang lớp AI Provider mới.
 *  - local            : Argos CTranslate2 offline
 *  - cloud_google     : Google Translate (miễn phí, cần cho phép Cloud)
 *  - ai               : AI Provider theo cấu hình chức năng "Dịch lời thoại" trong tab Tích hợp AI
 *  - ai_gemini / ai_openai / ai_openai_compatible : chọn trực tiếp nhà cung cấp
 *  - auto             : không cho phép Cloud -> local; cho phép Cloud -> AI nếu đã cấu hình key, ngược lại Google
 */
function normalizeTranslationProvider(raw) {
  const v = String(raw || 'auto').trim().toLowerCase();
  if (v === 'cloud_gemini') return 'ai_gemini';
  if (v === 'cloud_openai') return 'ai_openai';
  return v;
}

function isAiTranslationProvider(v) {
  return v === 'ai' || v.startsWith('ai_');
}

function resolveEffectiveTranslationProvider(rawProvider, cloudConsent) {
  const v = normalizeTranslationProvider(rawProvider);
  // AI Local (Qwen) chạy trên máy: không cần đồng ý gửi Cloud
  if (v === 'ai_local_qwen') return v;
  // Máy chủ AI cục bộ (Ollama/LM Studio) cấu hình ở "API tương thích OpenAI" cũng không gửi dữ liệu ra ngoài
  if (v === 'ai_openai_compatible' && isLocalProvider('openai_compatible')) return v;
  // "Offline trên máy": dùng AI Local Qwen (chất lượng cao hơn hẳn Argos) khi đã cài; Argos chỉ còn là dự phòng nếu có
  if (v === 'local' && isProviderReady('local_qwen')) return 'ai_local_qwen';
  if (v === 'local' && isLocalProvider('openai_compatible') && isProviderReady('openai_compatible')) return 'ai_openai_compatible';
  if ((v === 'cloud_google' || isAiTranslationProvider(v)) && !cloudConsent) {
    throw new Error('Bộ dịch Cloud/AI yêu cầu tích chọn đồng ý gửi văn bản lên dịch vụ đám mây để bảo vệ riêng tư.');
  }
  if (v === 'auto') {
    if (!cloudConsent) {
      if (isProviderReady('local_qwen')) return 'ai_local_qwen';
      if (isLocalProvider('openai_compatible') && isProviderReady('openai_compatible')) return 'ai_openai_compatible';
      return 'local';
    }
    try {
      const t = resolveFeatureTarget('translation');
      if (t && isProviderReady(t.providerId)) return 'ai';
    } catch (_) {}
    return 'auto';
  }
  return v;
}

/**
 * Dịch danh sách phân đoạn (giữ nguyên index/id/timestamp/speaker; chỉ điền translatedText).
 * @param {boolean} options.onlyMissing  chỉ dịch các đoạn chưa có translatedText
 */
async function translateSegmentList(segments, sourceLang, targetLang, options = {}) {
  const list = (Array.isArray(segments) ? segments : []).map((s, idx) => ({ ...s, index: s.index || idx + 1 }));
  const needIdx = list
    .map((s, i) => (String(s.sourceText || '').trim() && (!options.onlyMissing || !String(s.translatedText || '').trim()) ? i : -1))
    .filter((i) => i >= 0);
  if (needIdx.length === 0) {
    return { segments: list, mode: 'Không có đoạn nào cần dịch', usedCloud: false, stats: null };
  }
  const provider = resolveEffectiveTranslationProvider(options.translationProvider, Boolean(options.cloudConsent));

  if (sourceLang === targetLang) {
    needIdx.forEach((i) => {
      list[i].translatedText = list[i].sourceText;
    });
    return { segments: list, mode: `Giữ nguyên ngôn ngữ gốc (${String(sourceLang).toUpperCase()})`, usedCloud: false, stats: null };
  }

  if (isAiTranslationProvider(provider)) {
    const providerId = provider === 'ai' ? undefined : provider.slice(3);
    const res = await translateSegmentsWithLLM(
      needIdx.map((i) => list[i]),
      {
        sourceLang,
        targetLang,
        style: String(options.translationStyle || 'natural').toLowerCase(),
        providerId,
        model: options.aiModel || undefined,
        signal: options.signal,
        onProgress: options.onTranslateProgress,
        onChunk: (posList, texts) => {
          posList.forEach((p, k) => {
            const segIdx = needIdx[p];
            if (segIdx !== undefined && texts[k]) list[segIdx].translatedText = texts[k];
          });
          if (typeof options.onPartial === 'function') options.onPartial(list);
        },
        allowCloud: Boolean(options.cloudConsent)
      }
    );
    needIdx.forEach((segIdx, k) => {
      list[segIdx].translatedText = res.translations[k];
    });
    // Chỉ coi là "đã gửi Cloud" khi nhà cung cấp thực tế (kể cả dự phòng) không phải AI Local
    const usedProviders = new Set([res.stats.providerId, ...(res.stats.fallbacks || []).map((f) => String(f).split('/')[0])].filter(Boolean));
    const usedCloud = Array.from(usedProviders).some((pid) => !isLocalProvider(pid));
    return { segments: list, mode: res.mode, usedCloud, stats: res.stats };
  }

  const tr = await translateSegmentsBatch(
    needIdx.map((i) => list[i].sourceText),
    sourceLang,
    targetLang,
    { ...options, translationProvider: provider, segments: needIdx.map((i) => list[i]) }
  );
  needIdx.forEach((segIdx, k) => {
    list[segIdx].translatedText = String(tr.translations[k] || '').trim() || list[segIdx].translatedText || '';
  });
  return { segments: list, mode: tr.mode, usedCloud: tr.usedCloud, stats: null };
}

async function translateSegmentsBatch(texts, sourceLang, targetLang, options = {}) {
  const cleanTexts = (Array.isArray(texts) ? texts : []).map((t) => String(t || '').trim());
  if (cleanTexts.length === 0) return { translations: [], mode: 'Empty', usedCloud: false };
  if (sourceLang === targetLang) {
    return {
      translations: cleanTexts,
      mode: `Giữ nguyên ngôn ngữ gốc (${sourceLang.toUpperCase()})`,
      usedCloud: false
    };
  }

  const cloudConsent = Boolean(options.cloudConsent);
  const provider = resolveEffectiveTranslationProvider(options.translationProvider, cloudConsent);
  const style = String(options.translationStyle || 'natural').trim().toLowerCase();

  if (isAiTranslationProvider(provider)) {
    const segs = cleanTexts.map((t, i) => ({
      index: i + 1,
      startSec: Number(options.segments?.[i]?.startSec) || i * 3,
      endSec: Number(options.segments?.[i]?.endSec) || i * 3 + 3,
      sourceText: t
    }));
    const res = await translateSegmentList(segs, sourceLang, targetLang, { ...options, translationProvider: provider });
    return { translations: res.segments.map((s) => s.translatedText), mode: res.mode, usedCloud: Boolean(res.usedCloud) };
  }

  // Chế độ kiểm thử Offline cho phép dịch câu mẫu nhanh nếu thiếu model
  if (process.env.OFFLINE_TEST_MODE === '1' && !hasLocalPythonWorker()) {
    return {
      translations: cleanTexts.map((t) => `[Bản dịch ${targetLang.toUpperCase()}] ${t}`),
      mode: 'Offline Test Deterministic Translator',
      usedCloud: false
    };
  }

  const extraEnv = null;

  const res = await runLocalAiWorker(
    [
      'translate_batch',
      '--argos-dir',
      ARGOS_MODELS_DIR,
      '--payload-json',
      JSON.stringify({
        texts: cleanTexts,
        sourceLang,
        targetLang,
        cloudConsent,
        translationProvider: provider,
        translationStyle: style,
        segments: Array.isArray(options.segments) ? options.segments : null
      })
    ],
    options.trackProc,
    Math.max(180000, cleanTexts.length * 4000),
    extraEnv
  );

  if (!res || !res.ok || !Array.isArray(res.translations)) {
    throw new Error((res && res.error) || `Không thể dịch từ ${sourceLang} sang ${targetLang}.`);
  }

  return {
    translations: res.translations,
    mode: res.mode || 'Offline Local NMT',
    usedCloud: Boolean(res.usedCloud)
  };
}

/**
 * Dịch lại danh sách phân đoạn thoại đã có với engine/văn phong người dùng chọn.
 */
async function retranslateSegments({
  segments,
  sourceLang = 'auto',
  targetLang = 'vi',
  cloudConsent = false,
  translationProvider = 'auto',
  translationStyle = 'natural',
  aiModel = ''
}) {
  const list = Array.isArray(segments) ? segments : [];
  if (list.length === 0) {
    throw new Error('Chưa có phân đoạn thoại để dịch lại. Hãy tách & nhận dạng lời thoại trước.');
  }
  const sourceTexts = list.map((s) => String(s.sourceText || s.translatedText || '').trim());
  if (!sourceTexts.some(Boolean)) {
    throw new Error('Các phân đoạn thoại hiện đang trống.');
  }
  const srcCode =
    !sourceLang || sourceLang === 'auto'
      ? detectSourceLanguage(sourceTexts.join(' ')).code
      : String(sourceLang).toLowerCase().slice(0, 2);

  const prepared = sanitizeSegments(list.map((s, idx) => ({ ...s, sourceText: sourceTexts[idx] })));
  const tr = await translateSegmentList(prepared, srcCode, targetLang, {
    cloudConsent: Boolean(cloudConsent),
    translationProvider,
    translationStyle,
    aiModel,
    onlyMissing: false
  });
  const updated = tr.segments.map((seg) => ({
    ...seg,
    translatedText: String(seg.translatedText || '').trim()
  }));

  return {
    sourceLang: LANGUAGE_INFO[srcCode] || { code: srcCode, name: srcCode.toUpperCase(), flag: '🌐' },
    detectedSourceLang: srcCode,
    targetLang: LANGUAGE_INFO[targetLang] || LANGUAGE_INFO.vi,
    translationMode: tr.mode,
    translationNote: tr.mode,
    usedCloudTranslation: Boolean(tr.usedCloud),
    translationStats: tr.stats || null,
    segments: updated
  };
}

/**
 * Chuẩn hóa danh sách phân đoạn theo schema của dự án:
 * { index, id, speakerId, startSec, endSec, sourceText, translatedText }
 * — sắp theo thời gian, đảm bảo end > start, không thay đổi nội dung văn bản.
 */
function sanitizeSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((s, idx) => {
      const start = Math.max(0, Number(s.startSec ?? s.start) || 0);
      let end = Number(s.endSec ?? s.end);
      if (!Number.isFinite(end) || end <= start + 0.05) end = start + 2.5;
      return {
        ...s,
        index: idx + 1,
        id: s.id ?? s.index ?? idx + 1,
        speakerId: String(s.speakerId || s.speaker_id || 'speaker_1').trim().slice(0, 40) || 'speaker_1',
        startSec: Number(start.toFixed(3)),
        endSec: Number(end.toFixed(3)),
        sourceText: String(s.sourceText ?? s.source_text ?? '').trim(),
        translatedText: String(s.translatedText ?? s.translated_text ?? '').trim()
      };
    })
    .sort((a, b) => a.startSec - b.startSec)
    .map((s, idx) => ({ ...s, index: idx + 1 }));
}

/**
 * Hàm dịch đơn lẻ (tương thích với bài kiểm thử translateTextOnline)
 */
async function translateTextOnline(text, sourceLang = 'auto', targetLang = 'vi', options = {}) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  const src = sourceLang === 'auto' ? detectSourceLanguage(clean).code : sourceLang;
  if (src === targetLang) return clean;
  const batch = await translateSegmentsBatch([clean], src, targetLang, options);
  return (batch.translations && batch.translations[0]) || clean;
}

/**
 * Đo thông tin video và kiểm tra có track âm thanh hay không.
 */
function probeVideoMedia(videoPath) {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegBin();
    const proc = spawn(ffmpegBin, ['-hide_banner', '-i', videoPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', () => {
      resolve({ duration: 0, hasVideo: false, hasAudio: false, raw: '' });
    });
    proc.on('close', () => {
      let duration = 0;
      const m = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
      if (m) {
        duration = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
      }
      const hasVideo = /Stream\s+#\d+:\d+.*Video:/i.test(stderr);
      const hasAudio = /Stream\s+#\d+:\d+.*Audio:/i.test(stderr);
      resolve({ duration, hasVideo, hasAudio, raw: stderr });
    });
  });
}

function getMediaDuration(filePath) {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegBin();
    const proc = spawn(ffmpegBin, ['-hide_banner', '-i', filePath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', () => resolve(0));
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
      if (!m) return resolve(0);
      const sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
      resolve(Number.isFinite(sec) ? sec : 0);
    });
  });
}

/**
 * Xác minh file đầu ra hợp lệ:
 * - Tồn tại trên ổ đĩa và dung lượng > 1 KB
 * - Có stream Video hợp lệ
 * - BẮT BUỘC có stream Audio (`hasAudio === true`)
 * - Thời lượng > 0.2s
 */
async function verifyPlayableOutputVideo(videoPath, requireAudio = true) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { ok: false, reason: 'File video đầu ra không tồn tại.' };
  }
  const stat = fs.statSync(videoPath);
  if (stat.size < 1024) {
    return { ok: false, reason: `File video đầu ra quá nhỏ (${stat.size} bytes), có thể bị hỏng.` };
  }
  const info = await probeVideoMedia(videoPath);
  if (!info.hasVideo || info.duration <= 0.2) {
    return {
      ok: false,
      reason: 'File video đầu ra không có luồng hình ảnh hợp lệ hoặc thời lượng bằng 0.'
    };
  }
  if (requireAudio && !info.hasAudio) {
    return {
      ok: false,
      reason: 'File video đầu ra không có track âm thanh (hasAudio = false).'
    };
  }
  return {
    ok: true,
    size: stat.size,
    duration: info.duration,
    hasVideo: info.hasVideo,
    hasAudio: info.hasAudio
  };
}

/**
 * Bước 1: Trích xuất track âm thanh gốc từ video bằng FFmpeg ra WAV 16kHz Mono PCM.
 * Nếu video không có track âm thanh hoặc FFmpeg lỗi, dừng ngay và báo lỗi cụ thể.
 */
function extractAudioTrackFromVideo(videoPath, outputWavPath, trackProc = null) {
  return new Promise(async (resolve, reject) => {
    if (!videoPath || !fs.existsSync(videoPath)) {
      return reject(new Error('Không tìm thấy file video gốc để tách âm thanh.'));
    }

    const mediaInfo = await probeVideoMedia(videoPath);
    if (!mediaInfo.hasVideo) {
      return reject(new Error('File đầu vào không phải là video hợp lệ.'));
    }
    if (!mediaInfo.hasAudio) {
      return reject(
        new Error(
          'Video gốc không có track âm thanh (Audio Stream). Không thể nhận dạng giọng nói hoặc lồng tiếng.'
        )
      );
    }

    const ffmpegBin = getFfmpegBin();
    const args = [
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      outputWavPath
    ];

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (typeof trackProc === 'function') trackProc(proc);

    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      reject(new Error(`Không thể chạy FFmpeg để tách âm thanh: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputWavPath) && fs.statSync(outputWavPath).size > 512) {
        resolve({
          wavPath: outputWavPath,
          duration: mediaInfo.duration,
          hasAudio: true
        });
      } else {
        reject(
          new Error(
            `Tách âm thanh từ video thất bại (mã ${code}): ${stderr.slice(-260) || 'Không trích xuất được dữ liệu PCM.'}`
          )
        );
      }
    });
  });
}

/**
 * Tổng hợp TTS bằng giọng đọc hệ điều hành (macOS `say` / Windows PowerShell SAPI)
 */
function synthesizeSpeechSystemOS(text, voiceCfg, outputWavPath, trackProc = null) {
  return new Promise((resolve, reject) => {
    const cleanText = String(text || '')
      .replace(/["`$\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanText) {
      return reject(new Error('Đoạn văn bản trống, không thể tạo giọng đọc.'));
    }

    if (process.platform === 'darwin') {
      const aiffPath = `${outputWavPath}.aiff`;
      const sayArgs = ['-v', voiceCfg.voiceArg || 'Linh', '-r', String(voiceCfg.rate || 185), '-o', aiffPath, cleanText];
      const sayProc = spawn('/usr/bin/say', sayArgs);
      if (typeof trackProc === 'function') trackProc(sayProc);

      let sayErr = '';
      sayProc.stderr.on('data', (d) => {
        sayErr += d.toString();
      });

      sayProc.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(aiffPath)) {
          return reject(new Error(`Không thể tạo giọng đọc hệ thống (${voiceCfg.voiceArg}): ${sayErr.trim()}`));
        }
        const ffmpegBin = getFfmpegBin();
        const ffProc = spawn(ffmpegBin, [
          '-y',
          '-i',
          aiffPath,
          '-ar',
          '44100',
          '-ac',
          '2',
          '-c:a',
          'pcm_s16le',
          outputWavPath
        ]);
        if (typeof trackProc === 'function') trackProc(ffProc);

        ffProc.on('close', (ffCode) => {
          try {
            fs.unlinkSync(aiffPath);
          } catch (_) {}
          if (ffCode === 0 && fs.existsSync(outputWavPath)) {
            resolve(outputWavPath);
          } else {
            reject(new Error('Chuyển đổi định dạng âm thanh TTS sang WAV thất bại.'));
          }
        });
      });
    } else if (process.platform === 'win32') {
      const psScript = `
        Add-Type -AssemblyName System.Speech;
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
        $synth.SetOutputToWaveFile('${outputWavPath.replace(/'/g, "''")}');
        $synth.Speak('${cleanText.replace(/'/g, "''")}');
        $synth.Dispose();
      `;
      const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
      if (typeof trackProc === 'function') trackProc(ps);
      ps.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputWavPath)) resolve(outputWavPath);
        else reject(new Error('Windows SpeechSynthesizer tạo giọng thất bại.'));
      });
    } else {
      reject(new Error('Hệ điều hành hiện tại không hỗ trợ System TTS mặc định.'));
    }
  });
}

/**
 * Tổng hợp 1 đoạn văn bản thành file WAV chuẩn 44.1kHz Stereo PCM (dùng cho Nghe thử giọng đọc hoặc từng câu).
 */
async function synthesizeSpeechSegment(text, voiceCfg, outputWavPath, options = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    throw new Error('Nội dung văn bản cần tạo giọng đọc đang trống.');
  }

  const trackProc = options.trackProc || null;
  const cloudConsent = Boolean(options.cloudConsent);

  if (voiceCfg.engine === 'vieneu') {
    const rawWav = `${outputWavPath}.vieneu.wav`;
    await vieneuService.synthesize([{ text: cleanText, voice: voiceCfg.voiceArg, output: rawWav }], {
      signal: options.signal
    });
    if (!fs.existsSync(rawWav)) throw new Error('VieNeu-TTS không tạo được file âm thanh.');
    await runFfmpegSimple(['-y', '-i', rawWav, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', outputWavPath], trackProc);
    try {
      fs.unlinkSync(rawWav);
    } catch (_) {}
    return outputWavPath;
  }

  if (voiceCfg.engine === 'sherpa-piper') {
    const rawWav = `${outputWavPath}.raw.wav`;
    const modelDir = path.join(TTS_MODELS_DIR, voiceCfg.modelFolder);
    const res = await runLocalAiWorker(
      [
        'tts_synthesize',
        '--engine',
        'sherpa-piper',
        '--model-dir',
        modelDir,
        '--onnx-file',
        voiceCfg.onnxFile,
        '--speaker-id',
        String(voiceCfg.speakerId || 0),
        '--speed',
        String(voiceCfg.rate || 1.0),
        '--text',
        cleanText,
        '--output',
        rawWav
      ],
      trackProc
    );
    if (!res || !res.ok || !fs.existsSync(rawWav)) {
      throw new Error((res && res.error) || `Không thể tạo giọng đọc Local Neural (${voiceCfg.name}).`);
    }

    // Chuẩn hóa sang 44.1kHz Stereo PCM16 để ghép mượt với FFmpeg filter
    await new Promise((resolve, reject) => {
      const ff = spawn(getFfmpegBin(), [
        '-y',
        '-i',
        rawWav,
        '-ar',
        '44100',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        outputWavPath
      ]);
      if (typeof trackProc === 'function') trackProc(ff);
      ff.on('close', (code) => {
        try {
          fs.unlinkSync(rawWav);
        } catch (_) {}
        if (code === 0 && fs.existsSync(outputWavPath)) resolve();
        else reject(new Error('Chuẩn hóa âm thanh WAV 44.1kHz thất bại.'));
      });
    });
    return outputWavPath;
  }

  if (voiceCfg.engine === 'edge-tts') {
    if (!cloudConsent) {
      throw new Error('Giọng đọc Cloud yêu cầu bạn bật tùy chọn cho phép gửi dữ liệu lên đám mây.');
    }
    const rawOut = `${outputWavPath}.edge`;
    const res = await runLocalAiWorker(
      [
        'tts_synthesize',
        '--engine',
        'edge-tts',
        '--voice-arg',
        voiceCfg.voiceArg || 'vi-VN-HoaiMyNeural',
        '--cloud-consent',
        '1',
        '--text',
        cleanText,
        '--output',
        rawOut
      ],
      trackProc
    );
    const mp3Path = res && res.outputMp3 ? res.outputMp3 : `${rawOut}.mp3`;
    if (!res || !res.ok || !fs.existsSync(mp3Path)) {
      throw new Error((res && res.error) || 'Tạo giọng đọc Cloud Neural thất bại.');
    }

    await new Promise((resolve, reject) => {
      const ff = spawn(getFfmpegBin(), [
        '-y',
        '-i',
        mp3Path,
        '-ar',
        '44100',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        outputWavPath
      ]);
      if (typeof trackProc === 'function') trackProc(ff);
      ff.on('close', (code) => {
        try {
          fs.unlinkSync(mp3Path);
        } catch (_) {}
        if (code === 0 && fs.existsSync(outputWavPath)) resolve();
        else reject(new Error('Chuyển đổi âm thanh Cloud MP3 sang WAV thất bại.'));
      });
    });
    return outputWavPath;
  }

  return synthesizeSpeechSystemOS(cleanText, voiceCfg, outputWavPath, trackProc);
}

/**
 * Tổng hợp hàng loạt các phân đoạn bằng Sherpa-ONNX chỉ trong 1 lần nạp model để tối ưu tốc độ.
 */
function runFfmpegSimple(args, trackProc = null) {
  return new Promise((resolve, reject) => {
    const ff = spawn(getFfmpegBin(), ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (typeof trackProc === 'function') trackProc(ff);
    let err = '';
    ff.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-1500);
    });
    ff.on('error', (e) => reject(new Error(`Không chạy được FFmpeg: ${e.message}`)));
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg lỗi (mã ${code}): ${err.trim().slice(-400)}`))));
  });
}

/**
 * Chuẩn hóa 1 đoạn giọng đọc về WAV PCM16 mono 48 kHz và cắt khoảng lặng thừa ở đầu/cuối
 * (để tận dụng tối đa khung thời gian, hạn chế phải tăng tốc độ đọc).
 */
async function normalizeTtsSegmentWav(inputPath, outputPath, trackProc = null) {
  const trim =
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.03,areverse,' +
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse';
  try {
    await runFfmpegSimple(['-y', '-i', inputPath, '-af', trim, '-ar', String(DUB_SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', outputPath], trackProc);
    if (wavDurationSec(outputPath) >= 0.08) return outputPath;
  } catch (_) {}
  await runFfmpegSimple(['-y', '-i', inputPath, '-ar', String(DUB_SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', outputPath], trackProc);
  return outputPath;
}

/**
 * Tổng hợp giọng đọc cho toàn bộ phân đoạn.
 * - Hỗ trợ nhiều người nói: `voiceForSegment(seg)` trả về cấu hình giọng riêng cho từng speakerId.
 * - Gom nhóm theo giọng: Piper/VieNeu chỉ nạp mô hình 1 lần cho mỗi nhóm.
 * - Đầu ra: WAV PCM16 mono 48 kHz đã cắt khoảng lặng, theo đúng thứ tự phân đoạn.
 */
async function synthesizeSegmentsBatch(segments, voiceCfgOrResolver, tempDir, options = {}) {
  const trackProc = options.trackProc || null;
  const onSegmentProgress = options.onSegmentProgress || null;
  const checkCancelled = options.checkCancelled || (() => false);
  const voiceFor = typeof voiceCfgOrResolver === 'function' ? voiceCfgOrResolver : () => voiceCfgOrResolver;
  const total = segments.length;
  const rawPaths = new Array(total).fill(null);
  let done = 0;
  const tick = () => {
    if (typeof onSegmentProgress === 'function') onSegmentProgress(Math.min(done, total), total);
  };

  const groups = new Map();
  segments.forEach((seg, i) => {
    const cfg = voiceFor(seg);
    const key = cfg.id;
    if (!groups.has(key)) groups.set(key, { cfg, idxs: [] });
    groups.get(key).idxs.push(i);
  });

  for (const { cfg, idxs } of groups.values()) {
    if (checkCancelled()) throw new Error('Tác vụ đã bị hủy bởi người dùng.');
    if (cfg.engine === 'sherpa-piper') {
      const modelDir = path.join(TTS_MODELS_DIR, cfg.modelFolder);
      const items = idxs.map((i) => ({ index: i + 1, text: segments[i].translatedText, outputWav: path.join(tempDir, `seg_${i}_raw.wav`) }));
      const before = done;
      const res = await runLocalAiWorker(
        ['tts_batch', '--payload-json', JSON.stringify({ engine: 'sherpa-piper', modelDir, onnxFile: cfg.onnxFile, speakerId: cfg.speakerId || 0, speed: cfg.rate || 1.0, items })],
        trackProc,
        Math.max(180000, items.length * 20000),
        null,
        (p) => {
          if (p && p.stage === 'tts') {
            done = before + Number(p.done || 0);
            tick();
          }
        }
      );
      if (!res || !res.ok) throw new Error((res && res.error) || `Tổng hợp giọng đọc Local Neural (${cfg.name}) thất bại.`);
      items.forEach((it, k) => {
        rawPaths[idxs[k]] = it.outputWav;
      });
      done = before + items.length;
      tick();
    } else if (cfg.engine === 'vieneu') {
      const items = idxs.map((i) => ({ text: segments[i].translatedText, voice: cfg.voiceArg, output: path.join(tempDir, `seg_${i}_raw.wav`) }));
      const before = done;
      await vieneuService.synthesize(items, {
        signal: options.signal,
        onProgress: (d) => {
          done = before + Number(d || 0);
          tick();
        }
      });
      items.forEach((it, k) => {
        if (!fs.existsSync(it.output)) throw new Error(`VieNeu-TTS không tạo được âm thanh cho đoạn số ${idxs[k] + 1}.`);
        rawPaths[idxs[k]] = it.output;
      });
      done = before + items.length;
      tick();
    } else {
      for (const i of idxs) {
        if (checkCancelled()) throw new Error('Tác vụ đã bị hủy bởi người dùng.');
        const out = path.join(tempDir, `seg_${i}_raw.wav`);
        await synthesizeSpeechSegment(segments[i].translatedText, cfg, out, options);
        rawPaths[i] = out;
        done += 1;
        tick();
      }
    }
  }

  const normPaths = [];
  for (let i = 0; i < total; i++) {
    if (checkCancelled()) throw new Error('Tác vụ đã bị hủy bởi người dùng.');
    const norm = path.join(tempDir, `seg_${i}_norm.wav`);
    await normalizeTtsSegmentWav(rawPaths[i], norm, trackProc);
    try {
      fs.unlinkSync(rawPaths[i]);
    } catch (_) {}
    normPaths.push(norm);
  }
  return normPaths;
}

/**
 * Tạo bản nghe thử giọng đọc (Voice Preview) trả về đường dẫn WAV tạm thời.
 */
async function generateVoicePreviewAudio(voiceIdOrOpts, text = '', targetLang = 'vi', options = {}) {
  let voiceId = voiceIdOrOpts;
  let cloudConsent = false;
  if (voiceIdOrOpts && typeof voiceIdOrOpts === 'object') {
    voiceId = voiceIdOrOpts.voiceId;
    text = voiceIdOrOpts.text || voiceIdOrOpts.sampleText || text;
    targetLang = voiceIdOrOpts.targetLang || targetLang;
    cloudConsent = Boolean(voiceIdOrOpts.cloudConsent);
  } else {
    cloudConsent = Boolean(options.cloudConsent);
  }

  const voiceCfg = resolveVoiceConfig(voiceId, targetLang, { cloudConsent });
  const sampleText = String(text || voiceCfg.sampleText || '').trim();
  if (!sampleText) {
    throw new Error('Không có văn bản mẫu để nghe thử giọng đọc.');
  }

  const previewDir = path.join(os.tmpdir(), 'cn_video_scraper_voice_previews');
  if (!fs.existsSync(previewDir)) {
    fs.mkdirSync(previewDir, { recursive: true });
  }
  const outWav = path.join(previewDir, `preview_${voiceCfg.id}_${Date.now()}.wav`);
  await synthesizeSpeechSegment(sampleText, voiceCfg, outWav, { cloudConsent });
  const dur = await getMediaDuration(outWav);
  if (!fs.existsSync(outWav) || fs.statSync(outWav).size < 512 || dur <= 0.1) {
    throw new Error('Không tạo được âm thanh nghe thử hợp lệ.');
  }
  return {
    ok: true,
    success: true,
    voice: {
      ...voiceCfg,
      installed: isVoiceAvailableOnMachine(voiceCfg)
    },
    sampleText,
    duration: Number(dur.toFixed(2)),
    previewPath: outWav,
    audioFilePath: outWav,
    audioUrl: `/api/dubbing/preview-audio?path=${encodeURIComponent(outWav)}`
  };
}

function clampVolume(value, fallback, max = 2) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, n));
}

/**
 * Áp dụng tăng tốc độ đọc (atempo, giữ cao độ) cho 1 đoạn WAV mono 48 kHz.
 */
async function applySegmentTempo(inputWavPath, tempo, outputWavPath, trackProc = null) {
  if (!(tempo > 1.001)) return inputWavPath;
  const filters = [];
  let rem = tempo;
  while (rem > 2.0) {
    filters.push('atempo=2.0');
    rem /= 2.0;
  }
  filters.push(`atempo=${rem.toFixed(4)}`);
  await runFfmpegSimple(
    ['-y', '-i', inputWavPath, '-af', filters.join(','), '-ar', String(DUB_SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', outputWavPath],
    trackProc
  );
  return outputWavPath;
}

/**
 * Bước 5: Trộn track lồng tiếng với âm thanh gốc và ghép vào video mới (giữ luồng hình `-c:v copy`).
 *
 * Âm lượng được áp dụng THỰC SỰ vào file xuất:
 * - Âm thanh gốc nhân với đường bao âm lượng (float32): mức nền = originalVolume (0–200%);
 *   khi bật Auto-Ducking, trong lúc có lời lồng tiếng mức = originalVolume × duckLevel.
 * - Track lồng tiếng (đã chuẩn hóa RMS -20 dBFS) nhân với dubVolume (0–200%).
 * - amix normalize=0: KHÔNG tự chia đôi âm lượng như mặc định của FFmpeg.
 * - alimiter (level=0) chỉ chặn đỉnh > -0.3 dBFS để tránh méo tiếng khi cả hai cùng to; không tự cân bằng âm lượng.
 */
async function mixDubTrackWithVideo(inputVideoPath, dubTimelineWav, outputVideoPath, opts = {}) {
  const mediaInfo = await probeVideoMedia(inputVideoPath);
  const ffmpegBin = getFfmpegBin();
  const trackProc = opts.trackProc || null;
  const origVol = clampVolume(opts.originalVolume, 0.2);
  const dubVol = clampVolume(opts.dubVolume, 1.0);
  const autoDucking = opts.autoDucking !== false;
  const duckLevel = clampVolume(opts.duckLevel, 0.35, 1);
  const totalDuration = Math.max(0.5, Number(opts.totalDuration) || mediaInfo.duration || 1);
  const tempDir = opts.tempDir || path.dirname(dubTimelineWav);

  // Lưu ý: FFmpeg tự nâng mono -> stereo bằng hệ số center-mix 0.707 (-3 dB). Với nguồn mono ta dùng `pan`
  // để nhân đôi kênh ở mức 1.0, đảm bảo âm lượng 100% = đúng mức gốc.
  const MONO_TO_STEREO = 'pan=stereo|c0=c0|c1=c0';
  const firstAudioLine = (String(mediaInfo.raw || '').match(/Stream #\d+:\d+[^\n]*Audio:[^\n]*/) || [''])[0];
  const overrideOrig = opts.originalAudioOverride && fs.existsSync(opts.originalAudioOverride) ? opts.originalAudioOverride : null;
  const origIsMono = overrideOrig ? false : /\bmono\b/i.test(firstAudioLine);
  const origUpmix = origIsMono ? MONO_TO_STEREO : 'aformat=channel_layouts=stereo';

  let args;
  let filterComplex;
  let envelopeInfo = null;
  if (mediaInfo.hasAudio) {
    const envPath = path.join(tempDir, 'orig_gain_envelope.wav');
    const duckGain = autoDucking ? origVol * duckLevel : origVol;
    envelopeInfo = writeGainEnvelopeWav(autoDucking ? opts.speechWindows || [] : [], totalDuration, origVol, duckGain, envPath);
    envelopeInfo.baseGain = origVol;
    envelopeInfo.duckGain = Number(duckGain.toFixed(4));
    filterComplex =
      `[${overrideOrig ? '3:a' : '0:a:0'}]aresample=${DUB_SAMPLE_RATE},aformat=sample_fmts=fltp,${origUpmix}[orig];` +
      `[2:a]aresample=${DUB_SAMPLE_RATE},aformat=sample_fmts=fltp,${MONO_TO_STEREO}[env];` +
      `[orig][env]amultiply[origv];` +
      `[1:a]aresample=${DUB_SAMPLE_RATE},aformat=sample_fmts=fltp,${MONO_TO_STEREO},volume=${dubVol.toFixed(4)}[dub];` +
      `[origv][dub]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,` +
      `alimiter=limit=0.966:level=0:latency=1[outa]`;
    args = ['-y', '-i', inputVideoPath, '-i', dubTimelineWav, '-i', envPath];
    if (overrideOrig) args.push('-i', overrideOrig);
    args.push('-filter_complex', filterComplex);
  } else {
    filterComplex =
      `[1:a]aresample=${DUB_SAMPLE_RATE},aformat=sample_fmts=fltp,${MONO_TO_STEREO},volume=${dubVol.toFixed(4)},` +
      `atrim=0:${totalDuration.toFixed(3)},alimiter=limit=0.966:level=0:latency=1[outa]`;
    args = ['-y', '-i', inputVideoPath, '-i', dubTimelineWav, '-filter_complex', filterComplex];
  }
  args.push('-map', '0:v:0', '-map', '[outa]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', String(DUB_SAMPLE_RATE), '-movflags', '+faststart', outputVideoPath);

  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args);
    if (typeof trackProc === 'function') trackProc(proc);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    proc.on('error', (e) => reject(new Error(`Không chạy được FFmpeg: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputVideoPath) && fs.statSync(outputVideoPath).size > 1024) resolve();
      else reject(new Error(`Ghép âm thanh vào video thất bại: ${stderr.slice(-300)}`));
    });
  });
  return {
    outputVideoPath,
    mix: {
      hasOriginalAudio: mediaInfo.hasAudio,
      originalSource: overrideOrig ? 'background_only (đã tách giọng gốc)' : 'original_full',
      originalIsMono: origIsMono,
      originalVolume: origVol,
      dubVolume: dubVol,
      autoDucking,
      duckLevel,
      envelope: envelopeInfo,
      filterComplex
    }
  };
}

function formatSrtTimestamp(sec) {
  const safe = Math.max(0, Number(sec) || 0);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(
    ms
  ).padStart(3, '0')}`;
}

function writeSrtFile(segments, srtPath, useTranslated = true) {
  const lines = [];
  segments.forEach((seg, idx) => {
    const text = useTranslated ? seg.translatedText || seg.sourceText : seg.sourceText;
    lines.push(`${idx + 1}`);
    lines.push(`${formatSrtTimestamp(seg.startSec)} --> ${formatSrtTimestamp(seg.endSec)}`);
    lines.push(String(text || '').trim());
    lines.push('');
  });
  fs.writeFileSync(srtPath, lines.join('\n'), 'utf8');
  return srtPath;
}

/**
 * Quy trình Bước 1 + Bước 2 + Bước 3:
 * - Tách track âm thanh từ video bằng FFmpeg.
 * - Chạy nhận dạng giọng nói thực tế (ASR Faster-Whisper) trên âm thanh để tạo lời thoại thực tế có mốc thời gian.
 * - Dịch từng đoạn sang ngôn ngữ người dùng chọn.
 * - TUYỆT ĐỐI KHÔNG dùng tiêu đề video, tên file hay metadata.description làm phụ đề/transcript thay thế!
 * - Nếu thiếu âm thanh, không có lời thoại, hoặc thiếu mô hình -> báo lỗi cụ thể và dừng ngay.
 */
async function extractAndPrepareSegments(videoPathOrOpts, targetLang = 'vi', customSegments = null, options = {}) {
  let videoPath = videoPathOrOpts;
  if (videoPathOrOpts && typeof videoPathOrOpts === 'object') {
    videoPath = videoPathOrOpts.videoPath;
    targetLang = videoPathOrOpts.targetLang || targetLang;
    customSegments = videoPathOrOpts.customSegments || customSegments;
    options = { ...videoPathOrOpts, ...options };
  }

  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error('Không tìm thấy file video đầu vào trên ổ đĩa.');
  }

  const onStepChange = typeof options.onStepChange === 'function' ? options.onStepChange : () => {};
  const onSubProgress = typeof options.onSubProgress === 'function' ? options.onSubProgress : () => {};
  const trackProc = options.trackProc || null;
  const cloudConsent = Boolean(options.cloudConsent);
  const translationStyle = String(options.translationStyle || 'natural').trim().toLowerCase();
  const effectiveProvider = resolveEffectiveTranslationProvider(options.translationProvider, cloudConsent);
  const trOptions = {
    cloudConsent,
    translationProvider: effectiveProvider,
    translationStyle,
    aiModel: options.aiModel || '',
    trackProc,
    signal: options.signal,
    onTranslateProgress: (d, t) => onSubProgress(3, d, t)
  };

  const mediaInfo = await probeVideoMedia(videoPath);
  if (!mediaInfo.hasVideo || mediaInfo.duration <= 0.1) {
    throw new Error('File đầu vào không phải là video hợp lệ hoặc thời lượng bằng 0.');
  }

  // Trường hợp người dùng đã chỉnh sửa/cung cấp danh sách phân đoạn trên bảng kịch bản:
  if (Array.isArray(customSegments) && customSegments.length > 0) {
    onStepChange(1, 'Đang kiểm tra âm thanh và kịch bản phân đoạn...');
    const cleaned = sanitizeSegments(customSegments).filter((s) => s.sourceText || s.translatedText);
    if (cleaned.length === 0) {
      throw new Error('Danh sách phân đoạn tùy chỉnh đang trống. Vui lòng nhập ít nhất 1 câu thoại.');
    }
    const sourceLang = options.sourceLang && LANGUAGE_INFO[options.sourceLang]
      ? LANGUAGE_INFO[options.sourceLang]
      : detectSourceLanguage(cleaned.map((c) => c.sourceText || c.translatedText).join(' '));

    let translationMode = 'Kịch bản do người dùng cung cấp / chỉnh sửa';
    let usedCloudTranslation = false;
    let translationStats = null;
    const missing = cleaned.filter((s) => !s.translatedText && s.sourceText).length;
    let segments = cleaned;
    if (missing > 0) {
      onStepChange(3, `Đang dịch ${missing} phân đoạn còn thiếu sang ${(LANGUAGE_INFO[targetLang] || LANGUAGE_INFO.vi).name}...`);
      const tr = await translateSegmentList(cleaned, sourceLang.code, targetLang, { ...trOptions, onlyMissing: true });
      segments = tr.segments;
      translationMode = tr.mode;
      usedCloudTranslation = tr.usedCloud;
      translationStats = tr.stats;
    }
    const empty = segments.find((s) => !String(s.translatedText || '').trim());
    if (empty) throw new Error(`Phân đoạn số ${empty.index} chưa có lời dịch để đọc.`);

    return {
      totalDuration: Number(mediaInfo.duration.toFixed(2)),
      hasAudio: mediaInfo.hasAudio,
      sourceLang,
      detectedSourceLang: sourceLang.code,
      targetLang: LANGUAGE_INFO[targetLang] || LANGUAGE_INFO.vi,
      asrModelUsed: 'Custom Edited Segments (Người dùng hiệu chỉnh)',
      translationMode,
      translationNote: translationMode,
      usedCloudTranslation,
      translationStats,
      segments
    };
  }

  // BẮT BUỘC: Phải có track âm thanh trong video gốc
  if (!mediaInfo.hasAudio) {
    throw new Error(
      'Video gốc không có track âm thanh (Audio Stream). Không thể nhận dạng giọng nói hoặc dịch tự động.'
    );
  }

  // Checkpoint (tùy chọn): lưu kết quả từng bước để "Chạy tiếp" từ đúng bước bị lỗi, không làm lại từ đầu.
  //   ckpt.workDir / ckpt.audioReady  → file âm thanh 16 kHz đã tách
  //   ckpt.asr                         → kết quả nhận dạng (segments chưa dịch, ngôn ngữ, người nói)
  //   ckpt.translated                  → danh sách phân đoạn có lời dịch (có thể dịch dở)
  const ckpt = options.checkpoint && typeof options.checkpoint === 'object' ? options.checkpoint : null;
  const log = typeof options.onLog === 'function' ? options.onLog : () => {};
  const keepWorkDir = Boolean(ckpt);
  let workDir = ckpt && ckpt.workDir && fs.existsSync(ckpt.workDir) ? ckpt.workDir : null;
  if (!workDir) {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn_asr_extract_'));
    if (ckpt) {
      ckpt.workDir = workDir;
      ckpt.audioReady = false;
    }
  }
  const extractedWavPath = path.join(workDir, 'extracted_audio_16k.wav');
  const wantDiarize = options.autoDiarize === true && isDiarizationAvailable();
  if (options.autoDiarize === true && !wantDiarize) log('warn', 'Đã bật nhận diện người nói nhưng máy chưa cài mô hình phân tách người nói — bỏ qua bước này.');

  try {
    let asr = ckpt && ckpt.asr ? ckpt.asr : null;
    if (asr) {
      onStepChange(2, `Dùng lại kết quả nhận dạng giọng nói đã có (${asr.segments.length} đoạn) — bỏ qua tách âm thanh & ASR.`);
      log('info', `Bỏ qua Bước 1–2: dùng lại kết quả ASR đã lưu (${asr.segments.length} đoạn, ${String(asr.detectedSourceLang || '').toUpperCase()}).`);
    } else {
      if (ckpt && ckpt.audioReady && fs.existsSync(extractedWavPath)) {
        log('info', 'Bỏ qua Bước 1: dùng lại file âm thanh 16 kHz đã tách.');
      } else {
        onStepChange(1, 'Bước 1/5: Đang trích xuất track âm thanh 16kHz từ video bằng FFmpeg...');
        log('info', 'Bước 1: tách track âm thanh 16 kHz bằng FFmpeg...');
        await extractAudioTrackFromVideo(videoPath, extractedWavPath, trackProc);
        if (ckpt) ckpt.audioReady = true;
        log('ok', `Bước 1: đã tách âm thanh (${(fs.statSync(extractedWavPath).size / 1048576).toFixed(1)} MB).`);
      }

      onStepChange(2, 'Bước 2/5: Đang chạy nhận dạng giọng nói (ASR Faster-Whisper) để tách câu thoại và mốc thời gian...');
      const asrModelDir = getPreferredAsrModelDir();
      if (!asrModelDir) {
        throw new Error(
          'Chưa cài đặt mô hình nhận dạng giọng nói Local ASR (Faster-Whisper). Vui lòng mở mục Công cụ để tải mô hình.'
        );
      }

      // Dịch bằng AI Provider (Gemini/OpenAI/Qwen) chạy ở Node -> worker chỉ nhận dạng (skip translation)
      const translateInNode = isAiTranslationProvider(effectiveProvider);
      const workerArgs = [
        'transcribe_and_translate',
        '--audio',
        extractedWavPath,
        '--asr-dir',
        asrModelDir,
        '--argos-dir',
        ARGOS_MODELS_DIR,
        '--target-lang',
        targetLang,
        '--cloud-consent',
        cloudConsent ? '1' : '0',
        '--translation-provider',
        translateInNode ? 'local' : effectiveProvider,
        '--translation-style',
        translationStyle,
        '--skip-translation',
        translateInNode ? '1' : '0'
      ];
      // Nhận diện người nói: CHỈ chạy khi người dùng bật (mặc định tắt)
      if (wantDiarize) {
        const n = Math.floor(Number(options.numSpeakers) || 0);
        workerArgs.push('--diarize', '1', '--diar-dir', DIARIZATION_DIR, '--num-speakers', String(n > 0 ? n : -1));
        onStepChange(2, 'Bước 2/5: Đang nhận dạng giọng nói (ASR) và phân tách người nói...');
      }
      log('info', `Bước 2: nhận dạng giọng nói bằng ${path.basename(asrModelDir)}${wantDiarize ? ' + phân tách người nói' : ' (không nhận diện người nói)'}...`);

      // Timeout theo độ dài âm thanh (CPU int8 ~ 0.3–1.5x thời gian thực tùy model)
      const asrTimeout = Math.max(240000, Math.round(mediaInfo.duration * 3000) + 120000);
      let lastAsrLogPct = 0;
      const workerRes = await runLocalAiWorker(workerArgs, trackProc, asrTimeout, null, (p) => {
        if (p && p.stage === 'asr' && p.total > 0) {
          onSubProgress(2, p.pos, p.total);
          const pct = Math.floor((p.pos / p.total) * 4) * 25;
          if (pct > lastAsrLogPct && pct < 100) {
            lastAsrLogPct = pct;
            log('info', `ASR: đã nghe ${pct}% âm thanh.`);
          }
        } else if (p && p.stage === 'diarize' && p.total > 0) onSubProgress('diarize', p.done, p.total);
        else if (p && p.warning) {
          onSubProgress('warning', p.warning, 0);
          log('warn', p.warning);
        }
      });

      const asrPayload = workerRes && workerRes.ok ? workerRes : workerRes && workerRes.partialAsr ? workerRes.partialAsr : null;
      if (!asrPayload) {
        throw new Error(
          (workerRes && workerRes.error) ||
            'Nhận dạng giọng nói hoặc dịch lời thoại thất bại. Không phát hiện được lời thoại hợp lệ trong video.'
        );
      }
      asr = {
        detectedSourceLang: asrPayload.detectedSourceLang || 'zh',
        languageProbability: asrPayload.languageProbability || 0,
        sourceLangName: (asrPayload.sourceLang && asrPayload.sourceLang.name) || '',
        asrModelUsed: asrPayload.asrModelUsed || 'Faster-Whisper Local',
        speakerCount: asrPayload.speakerCount || 1,
        diarization: asrPayload.diarization || (wantDiarize ? null : { ok: false, skipped: true }),
        segments: sanitizeSegments(asrPayload.segments).map((x) => ({ ...x, translatedText: '' }))
      };
      if (ckpt) ckpt.asr = asr;
      log(
        'ok',
        `Bước 2: nhận dạng ${asr.segments.length} đoạn thoại • ngôn ngữ ${asr.detectedSourceLang.toUpperCase()} (${Math.round(asr.languageProbability * 100)}%)` +
          `${asr.diarization && asr.diarization.ok ? ` • ${asr.speakerCount} người nói` : ''}.`
      );
      if (asr.diarization && asr.diarization.ok === false && asr.diarization.error) log('warn', asr.diarization.error);

      if (workerRes.ok && !translateInNode) {
        // Bộ dịch Offline/Google chạy ngay trong worker cùng lúc ASR
        const done = sanitizeSegments(workerRes.segments);
        if (ckpt) ckpt.translated = done;
        if (ckpt) ckpt.translationMode = workerRes.translationMode || '';
        if (ckpt) ckpt.usedCloud = Boolean(workerRes.usedCloudTranslation);
        log('ok', `Bước 3: ${workerRes.translationMode || 'đã dịch'} (${done.filter((x) => x.translatedText).length}/${done.length} đoạn).`);
      } else if (!workerRes.ok) {
        // ASR xong nhưng dịch lỗi: đã lưu ASR — lần "Chạy tiếp" chỉ dịch lại
        onStepChange(3, 'Bước 3/5: Dịch lời thoại thất bại.');
        throw new Error(workerRes.error || 'Dịch lời thoại thất bại.');
      }
    }

    const detectedCode = asr.detectedSourceLang || 'zh';
    let segments = (ckpt && ckpt.translated) || asr.segments.map((x) => ({ ...x }));
    let translationMode = (ckpt && ckpt.translationMode) || 'Offline Local NMT';
    let usedCloudTranslation = Boolean(ckpt && ckpt.usedCloud);
    let translationStats = (ckpt && ckpt.translationStats) || null;

    const missingCount = segments.filter((x) => String(x.sourceText || '').trim() && !String(x.translatedText || '').trim()).length;
    if (missingCount > 0) {
      const resumed = segments.length - missingCount;
      onStepChange(3, `Bước 3/5: Đang dịch ${missingCount} đoạn thoại${resumed > 0 ? ` (đã có ${resumed} đoạn dịch từ lần trước)` : ''} (giữ nguyên ID & timestamp)...`);
      log('info', `Bước 3: dịch ${missingCount} đoạn bằng "${effectiveProvider}"${options.aiModel ? ` • model ${options.aiModel}` : ''}${resumed > 0 ? ` — chạy tiếp, giữ ${resumed} đoạn đã dịch` : ''}.`);
      const tr = await translateSegmentList(segments, detectedCode, targetLang, {
        ...trOptions,
        onlyMissing: true,
        onPartial: (list) => {
          if (ckpt) ckpt.translated = list.map((x) => ({ ...x }));
        },
        onTranslateProgress: (d, t) => {
          onSubProgress(3, d, t);
          log('info', `Dịch: xong ${d}/${t} đoạn.`);
        }
      });
      segments = tr.segments;
      translationMode = tr.mode;
      usedCloudTranslation = usedCloudTranslation || Boolean(tr.usedCloud);
      translationStats = tr.stats || translationStats;
      if (ckpt) {
        ckpt.translated = segments.map((x) => ({ ...x }));
        ckpt.translationMode = translationMode;
        ckpt.usedCloud = usedCloudTranslation;
        ckpt.translationStats = translationStats;
      }
      if (tr.stats && Array.isArray(tr.stats.fallbacks) && tr.stats.fallbacks.length) log('warn', `Dịch: đã dùng dự phòng ${Array.from(new Set(tr.stats.fallbacks)).join(', ')}.`);
      log('ok', `Bước 3: ${translationMode}.`);
    }

    onStepChange(
      3,
      `Bước 3/5: Đã nhận diện ${segments.length} đoạn thoại (${detectedCode.toUpperCase()}) và dịch sang ${targetLang.toUpperCase()}.`
    );

    const sourceLangInfo = LANGUAGE_INFO[detectedCode] || {
      code: detectedCode,
      name: asr.sourceLangName || `Ngôn ngữ (${detectedCode})`,
      flag: '🌐'
    };
    const untranslatedIds = segments
      .filter((x) => String(x.sourceText || '').trim() && !String(x.translatedText || '').trim())
      .map((x) => x.index);
    if (untranslatedIds.length > 0 && untranslatedIds.length === segments.length) {
      throw new Error('Không dịch được đoạn thoại nào bằng bộ dịch đã chọn. Hãy đổi bộ dịch (AI/Google) rồi bấm "Chạy tiếp".');
    }

    return {
      totalDuration: Number(mediaInfo.duration.toFixed(2)),
      hasAudio: true,
      sourceLang: {
        ...sourceLangInfo,
        probability: asr.languageProbability || 0
      },
      detectedSourceLang: detectedCode,
      targetLang: LANGUAGE_INFO[targetLang] || LANGUAGE_INFO.vi,
      asrModelUsed: asr.asrModelUsed,
      translationMode,
      translationNote: translationMode,
      usedCloudTranslation,
      translationStats,
      untranslatedIds,
      speakerCount: asr.speakerCount || 1,
      diarization: asr.diarization,
      segments
    };
  } finally {
    if (!keepWorkDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

/**
 * Khởi chạy tiến trình Lồng tiếng Video hoàn chỉnh qua 5 bước rõ ràng:
 * 1. Tách tiếng (FFmpeg)
 * 2. Nhận dạng giọng nói (ASR)
 * 3. Dịch từng đoạn (Translate)
 * 4. Tạo giọng đọc & căn thời gian (TTS & lập lịch không chồng lấn / không cắt câu)
 * 5. Trộn âm lượng gốc/lồng tiếng, ghép video & xác minh file đầu ra (Mux & Verify)
 */
function startDubbingJob({
  videoPath,
  outputDir,
  targetLang = 'vi',
  voiceId = '',
  speakerVoices = null,
  originalVolume = 0.2,
  dubVolume = 1.0,
  autoDucking = true,
  duckLevel = 0.35,
  maxTempo = 1.3,
  customSegments = null,
  sourceLang = '',
  exportSrt = true,
  cloudConsent = false,
  translationProvider = 'auto',
  translationStyle = 'natural',
  aiModel = '',
  autoDiarize = false,
  numSpeakers = 0,
  removeOriginalVoice = true,
  source = 'download'
}) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error('Không tìm thấy file video gốc để lồng tiếng.');
  }
  const jobSource = source === 'user' ? 'user' : 'download';
  if (outputDir) {
    if (!path.isAbsolute(String(outputDir))) throw new Error('Thư mục đầu ra phải là đường dẫn đầy đủ (vd. /Users/ban/Videos hoặc D:\\Videos).');
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.accessSync(outputDir, fs.constants.W_OK);
    } catch (e) {
      throw new Error(`Không ghi được vào thư mục đầu ra "${outputDir}": ${e.code || e.message}`);
    }
  }
  const jobId = `dub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const voiceCfg = resolveVoiceConfig(voiceId, targetLang, { cloudConsent });
  // Giọng riêng cho từng người nói (speakerId -> voiceId); kiểm tra hợp lệ ngay khi bắt đầu
  const speakerVoiceCfgs = {};
  if (speakerVoices && typeof speakerVoices === 'object') {
    for (const [spk, vid] of Object.entries(speakerVoices)) {
      if (vid) speakerVoiceCfgs[String(spk)] = resolveVoiceConfig(String(vid), targetLang, { cloudConsent });
    }
  }
  const targetLangObj = LANGUAGE_INFO[targetLang] || LANGUAGE_INFO.vi;
  const origVolNorm = clampVolume(originalVolume, 0.2);
  const dubVolNorm = clampVolume(dubVolume, 1.0);
  const duckLevelNorm = clampVolume(duckLevel, 0.35, 1);
  const maxTempoNorm = Math.max(1.0, Math.min(1.6, Number(maxTempo) || 1.3));
  const duckFlag = autoDucking !== false;
  const abortCtrl = new AbortController();

  const jobState = {
    id: jobId,
    jobId: jobId,
    status: 'running', // running | completed | error | cancelled
    progress: 2,
    stepIndex: 1,
    stepCode: 'extract_audio',
    stepLabel: DUBBING_PIPELINE_STEPS[0].label,
    steps: buildStepsProgress(1),
    step: 'Đang khởi tạo quy trình phân tích âm thanh và lồng tiếng...',
    statusText: 'Đang khởi tạo quy trình phân tích âm thanh và lồng tiếng...',
    videoPath,
    source: jobSource,
    outputDir: outputDir || null,
    logs: [],
    inputFileName: videoPath ? path.basename(videoPath) : '',
    outputVideoPath: null,
    outputPath: null,
    outputFileName: '',
    outputSrtPath: null,
    metadataPath: null,
    totalBytes: 0,
    originalVolume: origVolNorm,
    dubVolume: dubVolNorm,
    autoDucking: duckFlag,
    duckLevel: duckLevelNorm,
    maxTempo: maxTempoNorm,
    removeOriginalVoice: Boolean(removeOriginalVoice),
    sourceLang: null,
    targetLang: targetLangObj,
    targetLangName: targetLangObj.name,
    voice: {
      ...voiceCfg,
      installed: isVoiceAvailableOnMachine(voiceCfg)
    },
    voiceName: voiceCfg.name,
    speakerVoices: Object.fromEntries(Object.entries(speakerVoiceCfgs).map(([k, v]) => [k, v.id])),
    asrModelUsed: null,
    translationMode: null,
    segments: [],
    timing: null,
    warnings: [],
    verification: null,
    error: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    procs: new Set(),
    abortCtrl
  };

  activeDubbingJobs.set(jobId, jobState);
  // Tham số để chạy tiếp nếu bị gián đoạn (không chứa API key)
  jobState.resumeParams = {
    videoPath, outputDir, targetLang, voiceId, speakerVoices, originalVolume, dubVolume, autoDucking, duckLevel, maxTempo,
    customSegments, sourceLang, exportSrt, cloudConsent, translationProvider, translationStyle, aiModel, autoDiarize, numSpeakers, removeOriginalVoice,
    source: jobSource
  };
  const jlog = (level, msg) => {
    jobState.logs.push({ at: new Date().toISOString(), level, step: jobState.stepIndex, source: jobSource, msg: redactSecrets(String(msg)).slice(0, 500) });
    if (jobState.logs.length > 300) jobState.logs.splice(0, jobState.logs.length - 300);
  };
  jlog('info', `Bắt đầu lồng tiếng • nguồn: ${jobSource} • video: ${videoPath}${outputDir ? ` • đầu ra: ${outputDir}` : ' • đầu ra: thư mục Dubbed/ cạnh video'} • giọng: ${voiceCfg.name}`);
  const persistIv = setInterval(() => {
    persistJobsSoon();
    if (jobState.status !== 'running') clearInterval(persistIv);
  }, 2000);
  if (persistIv.unref) persistIv.unref();
  persistJobsSoon();

  const trackProc = (proc) => {
    if (proc) {
      jobState.procs.add(proc);
      proc.on('close', () => jobState.procs.delete(proc));
    }
  };

  const setJobStep = (stepIndex, message, progressVal = null) => {
    const stepDef = DUBBING_PIPELINE_STEPS.find((s) => s.index === stepIndex) || DUBBING_PIPELINE_STEPS[0];
    jobState.stepIndex = stepDef.index;
    jobState.stepCode = stepDef.code;
    jobState.stepLabel = stepDef.label;
    jobState.steps = buildStepsProgress(stepDef.index);
    if (message) {
      if (message !== jobState.step) jlog('info', message);
      jobState.step = message;
      jobState.statusText = message;
    }
    if (typeof progressVal === 'number') jobState.progress = progressVal;
  };
  const isCancelled = () => jobState.status === 'cancelled' || abortCtrl.signal.aborted;

  (async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `cn_dub_${jobId}_`));
    try {
      // Bước 1 -> 3: Tách âm thanh, Nhận dạng ASR, Dịch lời thoại
      setJobStep(1, 'Bước 1/5: Đang tách track âm thanh gốc từ video bằng FFmpeg...', 6);
      const prepared = await extractAndPrepareSegments(videoPath, targetLang, customSegments, {
        cloudConsent,
        translationProvider,
        translationStyle,
        aiModel,
        sourceLang,
        autoDiarize,
        numSpeakers,
        trackProc,
        signal: abortCtrl.signal,
        onLog: (lv, m) => jlog(lv, m),
        onStepChange: (sIdx, msg) => {
          const pMap = { 1: 8, 2: 12, 3: 40 };
          setJobStep(sIdx, msg, pMap[sIdx] || jobState.progress);
        },
        onSubProgress: (stage, d, t) => {
          if (!(t > 0)) return;
          const frac = Math.max(0, Math.min(1, d / t));
          if (stage === 2) {
            jobState.progress = 12 + Math.round(frac * 26);
            jobState.step = `Bước 2/5: Đang nhận dạng giọng nói... ${Math.round(frac * 100)}% (${Math.round(d)}/${Math.round(t)} giây âm thanh)`;
          } else if (stage === 3) {
            jobState.progress = 40 + Math.round(frac * 8);
            jobState.step = `Bước 3/5: Đang dịch bằng AI... ${d}/${t} đoạn`;
          }
          jobState.statusText = jobState.step;
        }
      });

      if (isCancelled()) return;

      jobState.sourceLang = prepared.sourceLang;
      jobState.asrModelUsed = prepared.asrModelUsed;
      jobState.translationMode = prepared.translationMode;
      jobState.translationStats = prepared.translationStats || null;
      const segments = prepared.segments.filter((s) => String(s.translatedText || '').trim());
      if (segments.length === 0) throw new Error('Không có phân đoạn nào có lời dịch để tạo giọng đọc.');
      const ttsCheck = validateSegmentsForTts(segments, { targetLang, totalDuration: prepared.totalDuration });
      if (!ttsCheck.ok) {
        throw new Error(`Dữ liệu dịch chưa hợp lệ để tạo giọng đọc: ${ttsCheck.errors.slice(0, 5).join(' ')}${ttsCheck.errors.length > 5 ? ` (+${ttsCheck.errors.length - 5} lỗi)` : ''}`);
      }
      const skipped = prepared.segments.filter((s) => !String(s.translatedText || '').trim());
      if (skipped.length > 0) {
        jobState.warnings.push(
          `${skipped.length} đoạn chưa có lời dịch nên không được lồng tiếng (đoạn số ${skipped.map((s) => s.index).slice(0, 15).join(', ')}${skipped.length > 15 ? '...' : ''}). Hãy dùng "Phân đoạn & Dịch" rồi nhập lời dịch cho các đoạn này.`
        );
      }
      jobState.segments = segments;
      if (prepared.translationStats && prepared.translationStats.lengthWarnings && prepared.translationStats.lengthWarnings.length) {
        jobState.warnings.push(
          `${prepared.translationStats.lengthWarnings.length} câu dịch dài hơn nhiều so với thời lượng câu gốc (sẽ được tăng tốc tối đa ${maxTempoNorm}x và lùi thời điểm nếu cần).`
        );
      }

      // Bước 4: Tạo giọng đọc cho bản dịch
      const voiceForSegment = (seg) => speakerVoiceCfgs[seg.speakerId] || voiceCfg;
      const voiceNames = Array.from(new Set(segments.map((s) => voiceForSegment(s).name)));
      setJobStep(4, `Bước 4/5: Đang tạo giọng đọc (${voiceNames.join(', ')}) cho ${segments.length} đoạn thoại...`, 48);

      const segWavs = await synthesizeSegmentsBatch(segments, voiceForSegment, tempDir, {
        cloudConsent,
        trackProc,
        signal: abortCtrl.signal,
        checkCancelled: isCancelled,
        onSegmentProgress: (doneCount, totalCount) => {
          jobState.progress = 48 + Math.round((doneCount / Math.max(1, totalCount)) * 30);
          jobState.step = `Bước 4/5: Đã tổng hợp giọng đọc ${doneCount}/${totalCount} đoạn...`;
          jobState.statusText = jobState.step;
        }
      });

      if (isCancelled()) return;

      // Lập lịch: không chồng lấn, không cắt câu, tăng tốc có giới hạn
      jobState.step = 'Bước 4/5: Đang căn khớp thời gian từng câu (không cắt câu, không chồng lấn)...';
      jobState.statusText = jobState.step;
      const naturals = segWavs.map((p) => wavDurationSec(p));
      const schedule = scheduleDubSegments(
        segments.map((s, i) => ({ startSec: s.startSec, endSec: s.endSec, naturalSec: naturals[i] })),
        prepared.totalDuration,
        { maxTempo: maxTempoNorm, lastMaxTempo: Math.max(maxTempoNorm, 1.6) }
      );

      const placed = [];
      for (let i = 0; i < segments.length; i++) {
        if (isCancelled()) return;
        const sch = schedule[i];
        const finalWav = await applySegmentTempo(segWavs[i], sch.tempo, path.join(tempDir, `seg_${i}_fit.wav`), trackProc);
        const finalSec = wavDurationSec(finalWav);
        const seg = segments[i];
        seg.tempoRatio = sch.tempo;
        seg.audioDuration = Number(finalSec.toFixed(3));
        seg.naturalDuration = Number(naturals[i].toFixed(3));
        seg.placedStartSec = sch.placedStartSec;
        seg.delaySec = sch.delaySec;
        placed.push({ wavPath: finalWav, placedStartSec: sch.placedStartSec, finalSec });
      }

      const lastPlacedEnd = placed.reduce((m, p) => Math.max(m, p.placedStartSec + p.finalSec), 0);
      const overrunEnd = Math.max(0, lastPlacedEnd - prepared.totalDuration);
      const maxDelay = schedule.reduce((m, s) => Math.max(m, s.delaySec), 0);
      const tempoUsed = schedule.filter((s) => s.tempo > 1).length;
      jobState.timing = {
        maxTempo: maxTempoNorm,
        segmentsSpedUp: tempoUsed,
        maxTempoApplied: schedule.reduce((m, s) => Math.max(m, s.tempo), 1),
        maxDelaySec: Number(maxDelay.toFixed(3)),
        segmentsDelayed: schedule.filter((s) => s.delaySec > 0.05).length,
        overrunVideoEndSec: Number(overrunEnd.toFixed(3))
      };
      if (maxDelay > 0.6) {
        jobState.warnings.push(
          `Một số câu dịch dài hơn câu gốc: đã lùi tối đa ${maxDelay.toFixed(2)} giây so với hình (bù lại ở các khoảng lặng sau). Có thể rút gọn lời dịch ở bảng kịch bản để khớp hơn.`
        );
      }
      if (overrunEnd > 0.05) {
        jobState.warnings.push(
          `Câu cuối kết thúc sau khi video hết ${overrunEnd.toFixed(2)} giây — phần âm thanh vượt quá độ dài video sẽ không có trong file xuất. Hãy rút gọn câu cuối.`
        );
      }

      jobState.progress = 82;
      jobState.step = 'Bước 4/5: Đang dựng track lồng tiếng hoàn chỉnh (Audio Timeline)...';
      jobState.statusText = jobState.step;
      const timelineWav = path.join(tempDir, 'dub_timeline_full.wav');
      // Cân bằng: giọng lồng 100% = to ngang lời nói gốc (giới hạn -26..-14 dBFS để luôn nghe rõ, không vỡ tiếng)
      let targetRmsDbfs = -20;
      let measuredOriginalSpeechDb = null;
      if (prepared.hasAudio) {
        measuredOriginalSpeechDb = await measureSpeechLevelDb(
          videoPath,
          segments.map((s) => ({ s: s.startSec, e: s.endSec }))
        );
        if (measuredOriginalSpeechDb !== null) targetRmsDbfs = Math.max(-26, Math.min(-14, measuredOriginalSpeechDb));
      }
      const timelineInfo = writeTimelineWav(placed, prepared.totalDuration, timelineWav, { sampleRate: DUB_SAMPLE_RATE, targetRmsDbfs });
      timelineInfo.targetRmsDbfs = targetRmsDbfs;
      timelineInfo.originalSpeechRmsDbfs = measuredOriginalSpeechDb;

      if (isCancelled()) return;

      // Bước 5: Ghép âm thanh vào video đầu ra (không ghi đè video gốc) và xác minh file đầu ra
      setJobStep(5, 'Bước 5/5: Đang trộn âm lượng gốc/lồng tiếng và ghép vào video mới (FFmpeg)...', 88);

      const parsedIn = path.parse(videoPath);
      const targetFolder = outputDir || path.join(parsedIn.dir, 'Dubbed');
      if (!fs.existsSync(targetFolder)) {
        fs.mkdirSync(targetFolder, { recursive: true });
      }

      const safeStem = truncateUtf8BaseName(parsedIn.name, 105);
      const suffix = `_Dubbed_${targetLang.toUpperCase()}_${Date.now().toString().slice(-5)}`;
      const baseOutName = `${safeStem}${suffix}`;
      let outVideoPath = path.join(targetFolder, `${baseOutName}.mp4`);
      if (path.resolve(outVideoPath) === path.resolve(videoPath)) {
        outVideoPath = path.join(targetFolder, `${safeStem}_Dubbed_Copy_${Date.now()}.mp4`);
      }

      const speechWindows = placed.map((p) => ({ s: p.placedStartSec, e: p.placedStartSec + p.finalSec }));
      let backgroundWav = null;
      if (removeOriginalVoice && prepared.hasAudio && origVolNorm > 0) {
        if (isSeparationAvailable()) {
          jobState.step = 'Bước 5/5: Đang tách giọng gốc khỏi nhạc nền (giữ nhạc nền, bỏ lời gốc)...';
          jobState.statusText = jobState.step;
          backgroundWav = await separateBackgroundAudio(videoPath, tempDir, trackProc, (pos, total) => {
            jobState.progress = 88 + Math.round((pos / Math.max(1, total)) * 5);
            jobState.step = `Bước 5/5: Đang tách giọng gốc khỏi nhạc nền... ${Math.round((pos / Math.max(1, total)) * 100)}%`;
            jobState.statusText = jobState.step;
          });
          if (isCancelled()) return;
        } else {
          jobState.warnings.push('Chưa cài mô hình tách giọng (Spleeter) nên vẫn dùng âm thanh gốc đầy đủ — mở trình cài công cụ để cài.');
        }
      }
      const mixRes = await mixDubTrackWithVideo(videoPath, timelineWav, outVideoPath, {
        originalAudioOverride: backgroundWav,
        originalVolume: origVolNorm,
        dubVolume: dubVolNorm,
        autoDucking: duckFlag,
        duckLevel: duckLevelNorm,
        speechWindows,
        totalDuration: prepared.totalDuration,
        tempDir,
        trackProc
      });

      jobState.progress = 95;
      jobState.step = 'Bước 5/5: Đang xác minh video đầu ra có âm thanh và phát được...';
      jobState.statusText = jobState.step;
      const verify = await verifyPlayableOutputVideo(outVideoPath, true);
      if (!verify.ok || !verify.hasAudio) {
        throw new Error(verify.reason || 'Xác minh video lồng tiếng thất bại (thiếu âm thanh hoặc file lỗi).');
      }

      let outSrtPath = null;
      if (exportSrt) {
        outSrtPath = path.join(targetFolder, `${baseOutName}.${targetLang}.srt`);
        writeSrtFile(segments, outSrtPath, true);
      }

      const metaPath = `${outVideoPath}.dubbing.metadata.json`;
      const voicePublic = { ...jobState.voice };
      fs.writeFileSync(
        metaPath,
        JSON.stringify(
          {
            jobId,
            sourceVideo: videoPath,
            outputVideo: outVideoPath,
            outputSrt: outSrtPath,
            sourceLang: prepared.sourceLang,
            targetLang: jobState.targetLang,
            voice: voicePublic,
            speakerVoices: jobState.speakerVoices,
            asrModelUsed: prepared.asrModelUsed,
            translationMode: prepared.translationMode,
            translationStats: prepared.translationStats || null,
            originalVolume: origVolNorm,
            dubVolume: dubVolNorm,
            autoDucking: duckFlag,
            duckLevel: duckLevelNorm,
            mix: { ...mixRes.mix, timeline: timelineInfo },
            timing: jobState.timing,
            warnings: jobState.warnings,
            createdAt: new Date().toISOString(),
            verification: verify,
            segments
          },
          null,
          2
        ),
        'utf8'
      );

      const outStat = fs.existsSync(outVideoPath) ? fs.statSync(outVideoPath) : null;
      jobState.outputVideoPath = outVideoPath;
      jobState.outputPath = outVideoPath;
      jobState.outputFileName = path.basename(outVideoPath);
      jobState.outputSrtPath = outSrtPath;
      jobState.metadataPath = metaPath;
      jobState.totalBytes = outStat ? outStat.size : 0;
      jobState.verification = verify;
      jobState.progress = 100;
      jobState.status = 'completed';
      jobState.finishedAt = Date.now();
      jobState.steps = buildStepsProgress(5, 'completed');
      jobState.step = `Hoàn tất lồng tiếng & xác minh video đầu ra thành công (${((jobState.finishedAt - jobState.startedAt) / 1000).toFixed(1)} giây).`;
      jobState.statusText = jobState.step;
      jobState.warnings.forEach((w) => jlog('warn', w));
      jlog('ok', `${jobState.step} • file: ${outVideoPath}`);
    } catch (err) {
      if (!isCancelled()) {
        jobState.status = 'error';
        jobState.finishedAt = Date.now();
        jobState.error = redactSecrets(err.message || 'Lỗi không xác định trong quá trình lồng tiếng.');
        jobState.steps = buildStepsProgress(jobState.stepIndex, 'error', jobState.stepIndex);
        jobState.step = `Lỗi tại Bước ${jobState.stepIndex}/5: ${jobState.error}`;
        jobState.statusText = jobState.step;
        jlog('error', jobState.step);
      }
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  })();

  return jobState;
}

/* ---------------- Tác vụ nền "Phân đoạn & Dịch" có theo dõi tiến độ ---------------- */
const extractTasks = new Map();
const EXTRACT_STAGES = [
  { code: 'extract_audio', label: 'Tách âm thanh (FFmpeg)' },
  { code: 'asr', label: 'Nhận dạng giọng nói (ASR)' },
  { code: 'diarize', label: 'Phân tách người nói' },
  { code: 'translate', label: 'Dịch từng phân đoạn' },
  { code: 'validate', label: 'Kiểm tra kết quả trước TTS' }
];

const EXTRACT_RESUME_TTL_MS = 6 * 60 * 60 * 1000; // giữ dữ liệu "chạy tiếp" 6 giờ rồi dọn file tạm

function serializeExtractTask(t) {
  if (!t) return null;
  const { abortCtrl, procs, checkpoint, cleanupTimer, ...pub } = t;
  const ck = checkpoint || {};
  return {
    ...pub,
    logs: (t.logs || []).slice(-300),
    resumable: t.status !== 'running' && t.status !== 'completed' && Boolean(t.checkpoint),
    checkpointInfo: {
      audioReady: Boolean(ck.audioReady),
      asrSegments: ck.asr ? ck.asr.segments.length : 0,
      translatedSegments: ck.translated ? ck.translated.filter((x) => String(x.translatedText || '').trim()).length : 0
    },
    elapsedSec: Number((((t.finishedAt || Date.now()) - t.startedAt) / 1000).toFixed(1))
  };
}

function cleanupExtractCheckpoint(task) {
  if (task.cleanupTimer) {
    clearTimeout(task.cleanupTimer);
    task.cleanupTimer = null;
  }
  const dir = task.checkpoint && task.checkpoint.workDir;
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
  task.checkpoint = null;
}

function runExtractTask(task, params) {
  const setStage = (code, patch = {}) => {
    const idx = EXTRACT_STAGES.findIndex((s) => s.code === code);
    task.stage = code;
    task.stages.forEach((s, i) => {
      if (i < idx && (s.state === 'running' || s.state === 'error')) s.state = 'completed';
      if (i === idx) Object.assign(s, { state: 'running' }, patch);
    });
  };
  const trackProc = (proc) => {
    task.procs.add(proc);
    proc.on('close', () => task.procs.delete(proc));
  };
  const log = (level, msg) => {
    task.logs.push({ at: new Date().toISOString(), level, stage: task.stage, source: task.source, msg: redactSecrets(String(msg)).slice(0, 500) });
    if (task.logs.length > 400) task.logs.splice(0, task.logs.length - 400);
  };
  task.log = log;
  const runId = (task.runSeq = (task.runSeq || 0) + 1);
  const stale = () => task.runSeq !== runId; // lần chạy cũ (đã hủy) không được ghi đè lần "Chạy tiếp" mới
  const ck = task.checkpoint;
  // Đánh dấu sẵn các bước đã xong từ lần chạy trước
  if (ck && ck.asr) {
    ['extract_audio', 'asr'].forEach((c) => {
      const st = task.stages.find((x) => x.code === c);
      if (st) st.state = 'completed';
    });
    const dz = task.stages.find((x) => x.code === 'diarize');
    if (dz && dz.state !== 'completed') dz.state = ck.asr.diarization && ck.asr.diarization.ok ? 'completed' : 'skipped';
  } else if (ck && ck.audioReady) {
    const st = task.stages.find((x) => x.code === 'extract_audio');
    if (st) st.state = 'completed';
  }

  (async () => {
    try {
      const out = await extractAndPrepareSegments(params.videoPath, params.targetLang || 'vi', params.customSegments || null, {
        cloudConsent: Boolean(params.cloudConsent),
        translationProvider: params.translationProvider,
        translationStyle: params.translationStyle,
        aiModel: params.aiModel,
        autoDiarize: params.autoDiarize === true,
        numSpeakers: params.numSpeakers,
        checkpoint: task.checkpoint,
        onLog: log,
        trackProc,
        signal: task.abortCtrl.signal,
        onStepChange: (idx, msg) => {
          task.message = msg;
          if (idx === 1) setStage('extract_audio');
          else if (idx === 2) setStage('asr');
          else if (idx === 3) setStage('translate');
          task.progress = Math.max(task.progress || 0, { 1: 3, 2: 8, 3: 70 }[idx] || 0);
        },
        onSubProgress: (stage, d, t) => {
          if (stage === 'warning') {
            task.warnings.push(String(d));
            return;
          }
          const code = stage === 2 ? 'asr' : stage === 3 ? 'translate' : stage === 'diarize' ? 'diarize' : null;
          if (!code) return;
          setStage(code, { done: Math.round(d * 100) / 100, total: Math.round(t * 100) / 100 });
          const frac = t > 0 ? Math.min(1, d / t) : 0;
          if (code === 'asr') {
            task.progress = 8 + Math.round(frac * 50);
            const clk = (x) => `${Math.floor(Math.round(x) / 60)}:${String(Math.round(x) % 60).padStart(2, '0')}`;
            task.message = `Nhận dạng giọng nói: đã nghe ${clk(d)} / ${clk(t)} của video`;
          } else if (code === 'diarize') {
            task.progress = 58 + Math.round(frac * 10);
            task.message = `Phân tách người nói: ${d}/${t} khối`;
          } else {
            task.progress = 70 + Math.round(frac * 25);
            task.message = `Dịch: ${d}/${t} phân đoạn`;
          }
        }
      });
      if (task.status === 'cancelled' || stale()) return;
      setStage('validate');
      const validation = validateSegmentsForTts(out.segments, { targetLang: params.targetLang || 'vi', totalDuration: out.totalDuration });
      task.errors.push(...validation.errors);
      task.warnings.push(...validation.warnings);
      if (Array.isArray(out.untranslatedIds) && out.untranslatedIds.length) {
        task.warnings.push(`${out.untranslatedIds.length} đoạn chưa dịch được (số ${out.untranslatedIds.slice(0, 15).join(', ')}) — hãy nhập lời dịch.`);
      }
      log(validation.errors.length ? 'warn' : 'ok', `Bước 4: kiểm tra ${validation.checked} đoạn trước TTS — ${validation.errors.length} lỗi, ${validation.warnings.length} cảnh báo.`);
      validation.errors.slice(0, 10).forEach((e) => log('error', e));
      task.stages.forEach((s) => {
        if (s.state === 'running' || (s.state === 'pending' && s.code !== 'diarize')) s.state = 'completed';
        if (s.code === 'diarize' && s.state === 'pending') s.state = out.diarization && out.diarization.ok ? 'completed' : 'skipped';
      });
      task.result = { ...out, validation };
      task.status = 'completed';
      task.progress = 100;
      task.message = `Hoàn tất: ${out.segments.length} phân đoạn${validation.errors.length ? ` • ${validation.errors.length} lỗi cần sửa trước khi lồng tiếng` : ''}`;
      log('ok', `Hoàn tất sau ${(((Date.now() - task.startedAt) / 1000)).toFixed(1)} giây.`);
      cleanupExtractCheckpoint(task);
    } catch (err) {
      if (task.status === 'cancelled' || stale()) return;
      task.status = 'error';
      const msg = redactSecrets(err.message || String(err));
      task.errors.push(msg);
      task.message = `Lỗi: ${msg}`;
      const cur = task.stages.find((s) => s.state === 'running');
      if (cur) cur.state = 'error';
      log('error', `Lỗi ở bước "${cur ? cur.label : task.stage}": ${msg}`);
      if (task.checkpoint) {
        log('info', 'Đã lưu kết quả các bước trước — bấm "Chạy tiếp từ bước lỗi" để không phải làm lại từ đầu (có thể đổi bộ dịch/model).');
        task.cleanupTimer = setTimeout(() => cleanupExtractCheckpoint(task), EXTRACT_RESUME_TTL_MS);
        if (task.cleanupTimer.unref) task.cleanupTimer.unref();
      }
    } finally {
      if (!stale()) task.finishedAt = Date.now();
    }
  })();
}

function startExtractTask(params = {}) {
  const { videoPath } = params;
  if (!videoPath || !fs.existsSync(videoPath)) throw new Error('Không tìm thấy file video đầu vào trên ổ đĩa.');
  const taskId = `extract_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const source = params.source === 'user' ? 'user' : 'download';
  const task = {
    taskId,
    videoPath,
    source,
    inputFileName: path.basename(videoPath),
    status: 'running', // running | completed | error | cancelled
    stage: 'extract_audio',
    stages: EXTRACT_STAGES.map((s) => ({ ...s, state: 'pending', done: 0, total: 0 })),
    message: 'Đang khởi tạo...',
    progress: 0,
    errors: [],
    warnings: [],
    logs: [],
    attempts: 1,
    result: null,
    params: null,
    startedAt: Date.now(),
    finishedAt: null,
    abortCtrl: new AbortController(),
    procs: new Set(),
    checkpoint: Array.isArray(params.customSegments) && params.customSegments.length ? null : {}
  };
  // Tham số để chạy tiếp (không có API key — key nằm ở config/ai_secrets.json)
  task.params = {
    videoPath,
    targetLang: params.targetLang || 'vi',
    customSegments: params.customSegments || null,
    cloudConsent: Boolean(params.cloudConsent),
    translationProvider: params.translationProvider,
    translationStyle: params.translationStyle,
    aiModel: params.aiModel,
    autoDiarize: params.autoDiarize === true,
    numSpeakers: params.numSpeakers
  };
  if (!task.params.autoDiarize) {
    const dz = task.stages.find((x) => x.code === 'diarize');
    if (dz) Object.assign(dz, { state: 'skipped', label: 'Phân tách người nói (đang tắt)' });
  }
  extractTasks.set(taskId, task);
  // Dọn dữ liệu chạy tiếp của các tác vụ lỗi cũ quá nhiều (giữ 5 gần nhất)
  const stale = Array.from(extractTasks.values()).filter((t) => t !== task && t.checkpoint && t.status !== 'running');
  stale.slice(0, Math.max(0, stale.length - 5)).forEach(cleanupExtractCheckpoint);
  const p = task.params;
  runExtractTask(task, p);
  task.log('info', `Bắt đầu • nguồn: ${source} • video: ${task.inputFileName} • dịch sang ${String(p.targetLang).toUpperCase()} • bộ dịch: ${p.translationProvider || 'auto'}${p.aiModel ? ` (${p.aiModel})` : ''} • nhận diện người nói: ${p.autoDiarize ? 'BẬT' : 'tắt'}.`);
  return serializeExtractTask(task);
}

/**
 * Chạy tiếp tác vụ Phân đoạn & Dịch từ bước bị lỗi/hủy: dùng lại âm thanh đã tách, kết quả ASR và các đoạn đã dịch.
 * Có thể đổi bộ dịch / model / văn phong (vd. Gemini quá tải → chuyển sang Qwen) mà không phải nhận dạng lại.
 */
function resumeExtractTask(taskId, overrides = {}) {
  const task = extractTasks.get(taskId);
  if (!task) throw new Error('Không tìm thấy tác vụ phân đoạn (có thể ứng dụng đã khởi động lại).');
  if (task.status === 'running') throw new Error('Tác vụ đang chạy.');
  if (task.status === 'completed') throw new Error('Tác vụ đã hoàn tất, không cần chạy tiếp.');
  if (!task.checkpoint) throw new Error('Dữ liệu để chạy tiếp đã được dọn (quá 6 giờ). Hãy bấm "Phân đoạn & Dịch" để chạy lại.');
  if (task.cleanupTimer) {
    clearTimeout(task.cleanupTimer);
    task.cleanupTimer = null;
  }
  const p = { ...task.params };
  for (const k of ['cloudConsent', 'translationProvider', 'translationStyle', 'aiModel', 'targetLang']) {
    if (overrides[k] !== undefined && overrides[k] !== null && overrides[k] !== '') p[k] = k === 'cloudConsent' ? Boolean(overrides[k]) : overrides[k];
  }
  const changed = ['translationProvider', 'aiModel', 'translationStyle', 'targetLang'].filter((k) => String(p[k] || '') !== String(task.params[k] || ''));
  if (p.targetLang !== task.params.targetLang || p.translationStyle !== task.params.translationStyle) {
    task.checkpoint.translated = null; // ngôn ngữ đích / văn phong đổi → dịch lại toàn bộ (vẫn dùng lại ASR)
    task.checkpoint.translationStats = null;
  }
  task.params = p;
  task.status = 'running';
  task.attempts = (task.attempts || 1) + 1;
  task.errors = [];
  task.warnings = [];
  task.result = null;
  task.finishedAt = null;
  task.startedAt = Date.now();
  task.abortCtrl = new AbortController();
  task.procs = new Set();
  task.stages.forEach((s) => {
    if (s.state === 'error' || s.state === 'running') s.state = 'pending';
    if (s.code === 'translate' || s.code === 'validate') s.state = 'pending';
  });
  runExtractTask(task, p);
  const ck = task.checkpoint;
  task.log(
    'info',
    `▶ Chạy tiếp lần ${task.attempts}: giữ ${ck.asr ? `kết quả ASR (${ck.asr.segments.length} đoạn)` : ck.audioReady ? 'âm thanh đã tách' : 'không có gì'}` +
      `${ck.translated ? `, ${ck.translated.filter((x) => String(x.translatedText || '').trim()).length} đoạn đã dịch` : ''}` +
      `${changed.length ? ` • thay đổi: ${changed.map((k) => `${k}=${p[k] || 'auto'}`).join(', ')}` : ''}.`
  );
  return serializeExtractTask(task);
}

function getExtractTask(taskId) {
  return serializeExtractTask(extractTasks.get(taskId));
}

function cancelExtractTask(taskId) {
  const task = extractTasks.get(taskId);
  if (!task) return { success: false, error: 'Không tìm thấy tác vụ phân đoạn.' };
  if (task.status !== 'running') return { success: false, error: 'Tác vụ đã kết thúc.' };
  task.status = 'cancelled';
  task.message = 'Đã hủy phân đoạn & dịch.';
  task.finishedAt = Date.now();
  const cur = task.stages.find((s) => s.state === 'running');
  if (cur) cur.state = 'pending';
  if (task.log) task.log('warn', 'Người dùng đã hủy. Có thể bấm "Chạy tiếp" để làm tiếp từ bước đang dở.');
  if (task.checkpoint && !task.cleanupTimer) {
    task.cleanupTimer = setTimeout(() => cleanupExtractCheckpoint(task), EXTRACT_RESUME_TTL_MS);
    if (task.cleanupTimer.unref) task.cleanupTimer.unref();
  }
  try {
    task.abortCtrl.abort();
  } catch (_) {}
  for (const p of task.procs) {
    try {
      p.kill('SIGKILL');
    } catch (_) {}
  }
  return { success: true, task: serializeExtractTask(task) };
}

/**
 * Xác thực phân đoạn TRƯỚC khi chuyển sang TTS: đủ ID, timestamp hợp lệ & tăng dần,
 * có lời dịch, lời dịch không còn chữ của ngôn ngữ nguồn / ghi chú thừa.
 */
function validateSegmentsForTts(segments, { targetLang = 'vi', totalDuration = 0 } = {}) {
  const errors = [];
  const warnings = [];
  const list = Array.isArray(segments) ? segments : [];
  const ids = new Set();
  let prevStart = -1;
  list.forEach((s, i) => {
    const label = `Đoạn ${s.index || i + 1}`;
    if (s.id === undefined || s.id === null) errors.push(`${label}: thiếu ID.`);
    else if (ids.has(String(s.id))) errors.push(`${label}: ID ${s.id} bị trùng.`);
    ids.add(String(s.id));
    if (!(Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)) errors.push(`${label}: timestamp không hợp lệ.`);
    if (s.startSec < prevStart) errors.push(`${label}: thứ tự thời gian bị đảo.`);
    prevStart = s.startSec;
    if (totalDuration > 0 && s.startSec > totalDuration + 0.5) errors.push(`${label}: bắt đầu sau khi video kết thúc.`);
    const tr = String(s.translatedText || '').trim();
    if (!tr) {
      warnings.push(`${label}: chưa có lời dịch (sẽ không được lồng tiếng).`);
      return;
    }
    if (targetLang === 'vi' && /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(tr)) {
      errors.push(`${label}: lời dịch còn chữ Trung/Nhật/Hàn: "${tr.slice(0, 40)}".`);
    }
    if (/^(bản dịch|dịch|translation)\s*[:：]/i.test(tr) || /\((ghi chú|chú thích|note)[^)]*\)/i.test(tr)) {
      errors.push(`${label}: lời dịch có chữ thừa ngoài nội dung cần đọc: "${tr.slice(0, 40)}".`);
    }
  });
  return { ok: errors.length === 0, errors, warnings, checked: list.length };
}

function serializeDubbingJob(job) {
  if (!job) return null;
  const { procs, abortCtrl, ...safeJob } = job;
  return {
    ...safeJob,
    statusText: safeJob.statusText || safeJob.step || '',
    targetLangName:
      safeJob.targetLangName ||
      (typeof safeJob.targetLang === 'object' && safeJob.targetLang ? safeJob.targetLang.name : '') ||
      'Tiếng Việt',
    voiceName:
      safeJob.voiceName ||
      (typeof safeJob.voice === 'object' && safeJob.voice ? safeJob.voice.name : '') ||
      '',
    inputFileName:
      safeJob.inputFileName || (safeJob.videoPath ? path.basename(safeJob.videoPath) : ''),
    originalVolume: safeJob.originalVolume ?? 0.2,
    dubVolume: safeJob.dubVolume ?? 1.0,
    autoDucking: safeJob.autoDucking !== false
  };
}

function getDubbingJob(jobId) {
  const job = activeDubbingJobs.get(jobId);
  return serializeDubbingJob(job);
}

/**
 * Liệt kê tất cả tiến trình lồng tiếng đang chạy + lịch sử các bản video đã lồng tiếng lưu trong thư mục Dubbed.
 */
function getAllDubbingJobs() {
  const jobs = [];
  const seenOutputs = new Set();

  for (const rec of persistedJobs.values()) {
    if (activeDubbingJobs.has(rec.jobId) || rec.status !== 'interrupted') continue;
    jobs.push({ ...rec, resumable: Boolean(rec.resumeParams) });
  }
  for (const job of Array.from(activeDubbingJobs.values())) {
    const serialized = serializeDubbingJob(job);
    if (serialized.outputPath) {
      seenOutputs.add(path.resolve(serialized.outputPath));
    }
    jobs.push(serialized);
  }

  try {
    const overview = getStorageOverview();
    const candDirs = [];
    if (overview?.rootDir) {
      candDirs.push(overview.rootDir, path.join(overview.rootDir, 'Dubbed'));
    }
    for (const d of overview?.platformDirs || []) {
      if (d?.path) {
        candDirs.push(d.path, path.join(d.path, 'Dubbed'));
      }
    }

    const uniqueDirs = Array.from(new Set(candDirs.map((d) => path.resolve(d))));
    for (const dir of uniqueDirs) {
      if (!fs.existsSync(dir)) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch (_) {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.dubbing.metadata.json')) continue;
        if (name.startsWith('dub_master_') || name.startsWith('preview_voice_')) continue;
        const metaFullPath = path.join(dir, name);
        try {
          const parsed = JSON.parse(fs.readFileSync(metaFullPath, 'utf8'));
          const outVideo = parsed?.outputVideo;
          if (!outVideo || !fs.existsSync(outVideo)) continue;
          const resolvedOut = path.resolve(outVideo);
          if (seenOutputs.has(resolvedOut)) continue;
          seenOutputs.add(resolvedOut);

          const st = fs.statSync(resolvedOut);
          const tLangObj = parsed.targetLang;
          const vObj = parsed.voice;
          jobs.push({
            id: parsed.jobId || `disk_${path.basename(resolvedOut)}`,
            jobId: parsed.jobId || `disk_${path.basename(resolvedOut)}`,
            status: 'completed',
            progress: 100,
            step: 'Hoàn tất lồng tiếng & xác minh video đầu ra thành công!',
            statusText: 'Hoàn tất lồng tiếng (Đã lưu trên đĩa)',
            videoPath: parsed.sourceVideo || '',
            inputFileName: parsed.sourceVideo ? path.basename(parsed.sourceVideo) : '',
            outputVideoPath: resolvedOut,
            outputPath: resolvedOut,
            outputFileName: path.basename(resolvedOut),
            outputSrtPath: parsed.outputSrt || null,
            metadataPath: metaFullPath,
            totalBytes: st.size || 0,
            originalVolume: parsed.originalVolume ?? 0.2,
            dubVolume: parsed.dubVolume ?? 1.15,
            autoDucking: parsed.autoDucking !== false,
            targetLang: typeof tLangObj === 'object' && tLangObj ? tLangObj : LANGUAGE_INFO.vi,
            targetLangName:
              (typeof tLangObj === 'object' && tLangObj ? tLangObj.name : tLangObj) || 'Tiếng Việt',
            voice: typeof vObj === 'object' && vObj ? vObj : null,
            voiceName:
              (typeof vObj === 'object' && vObj ? vObj.name : vObj) || 'Giọng đọc đã chọn',
            asrModelUsed: parsed.asrModelUsed || '',
            translationMode: parsed.translationMode || '',
            createdAt: parsed.createdAt ? new Date(parsed.createdAt).getTime() : st.mtimeMs
          });
        } catch (_) {}
      }
    }
  } catch (_) {}

  jobs.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  return jobs.slice(0, 50);
}

function cancelDubbingJob(jobId) {
  const job = activeDubbingJobs.get(jobId);
  if (!job) {
    return { success: false, cancelled: false, error: 'Không tìm thấy tác vụ lồng tiếng.' };
  }
  if (job.status !== 'running') {
    return { success: false, cancelled: false, error: 'Tác vụ lồng tiếng đã kết thúc, không thể hủy.' };
  }
  job.status = 'cancelled';
  job.finishedAt = Date.now();
  try {
    job.abortCtrl && job.abortCtrl.abort();
  } catch (_) {}
  job.step = 'Đã hủy tác vụ lồng tiếng.';
  job.statusText = job.step;
  if (Array.isArray(job.logs)) job.logs.push({ at: new Date().toISOString(), level: 'warn', step: job.stepIndex, source: job.source || 'download', msg: 'Người dùng đã hủy tác vụ lồng tiếng.' });
  for (const proc of job.procs) {
    try {
      proc.kill('SIGKILL');
    } catch (_) {}
  }
  job.procs.clear();
  return { success: true, cancelled: true, job: getDubbingJob(jobId) };
}

module.exports = {
  VOICE_CATALOG,
  LOCAL_MODELS_CATALOG,
  TRANSLATION_PROVIDERS_CATALOG,
  TRANSLATION_STYLES,
  LANGUAGE_INFO,
  DUBBING_PIPELINE_STEPS,
  getSupportedVoices,
  getLocalModelsCatalogStatus,
  resolveVoiceConfig,
  detectSourceLanguage,
  translateTextOnline,
  translateSegmentsBatch,
  translateSegmentList,
  sanitizeSegments,
  synthesizeSegmentsBatch,
  mixDubTrackWithVideo,
  normalizeTranslationProvider,
  isSeparationAvailable,
  startExtractTask,
  resumeExtractTask,
  getExtractTask,
  cancelExtractTask,
  validateSegmentsForTts,
  measureSpeechLevelDb,
  retranslateSegments,
  probeVideoMedia,
  verifyPlayableOutputVideo,
  extractAudioTrackFromVideo,
  extractAndPrepareSegments,
  generateVoicePreviewAudio,
  startDubbingJob,
  getDubbingJob,
  getAllDubbingJobs,
  cancelDubbingJob,
  resumeDubbingJob,
  _internals: { runLocalAiWorker }
};

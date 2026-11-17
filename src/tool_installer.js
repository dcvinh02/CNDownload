/**
 * Trình quản lý Tải, Cài đặt & Xác minh Toàn vẹn Công cụ / Mô hình Còn thiếu (Tool & Model Installer)
 * - Nguồn tải chính thức theo đúng Hệ điều hành (macOS / Windows / Linux) và Kiến trúc (arm64 / x64).
 * - Không bao giờ tự ý tải hoặc chạy ngầm binary: yêu cầu người dùng xác nhận rõ ràng (`userConfirmed === true`)
 *   và thông báo chi tiết đang tải từ đâu, cài vào đâu.
 * - Kiểm tra tính toàn vẹn sau khi tải: kiểm tra dung lượng tối thiểu, tính mã băm SHA-256, kiểm tra định dạng
 *   header của file thực thi / gói nén, cấp quyền thực thi (`chmod 755`) và chạy thử nghiệm xác minh phiên bản.
 * - Nếu không tải được (mất mạng, tường lửa...), trả về hướng dẫn khắc phục thủ công cụ thể (`remediationSteps`).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  getExecutablePath,
  runVersionProbe,
  getLocalModelsStatus,
  invalidateCapabilitiesCache,
  triggerBackgroundCapabilitiesCheck
} = require('./capabilities');

const vieneuService = require('./vieneu_service');
const localLlm = require('./local_llm_service');
const pyEnv = require('./python_env');
const { getFfmpegPath } = require('./extractors/ytdlp_engine');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const MODELS_DIR = path.join(BIN_DIR, 'models');
// SenseVoiceSmall (FunAudioLLM) bản int8 do sherpa-onnx phát hành chính thức + Silero VAD để chia đoạn nói
const SENSEVOICE_DIR = path.join(MODELS_DIR, 'asr', 'sensevoice-small-int8');
// Bản 2024-07-17: đo trên video tiếng Tứ Xuyên 85,0% chữ đúng (bản 2025-09-09: 80,2%) và nghe tiếng Anh đúng
// ("Mr. Smith bought 3.5 kilos…"; bản 2025 ra "MT SMITHOUGHT 三 POINT FIVE"), có dấu câu, nhãn ngôn ngữ hoạt động.
const SENSEVOICE_PACKAGE = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
  sha256: '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e',
  sizeBytes: 163002883,
  folder: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
  files: ['model.int8.onnx', 'tokens.txt', 'LICENSE']
};
const SILERO_VAD = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  sizeBytes: 643854
};
function isSenseVoiceInstalled() {
  try {
    // version.txt ghi bản đã cài — máy còn bản cũ (2025-09-09) sẽ hiện "chưa cài" để cài lại bản tốt hơn
    return fs.readFileSync(path.join(SENSEVOICE_DIR, 'version.txt'), 'utf8').trim() === SENSEVOICE_PACKAGE.folder && fs.statSync(path.join(SENSEVOICE_DIR, 'model.int8.onnx')).size > 200 * 1024 * 1024 && fs.statSync(path.join(SENSEVOICE_DIR, 'tokens.txt')).size > 100000 && fs.statSync(path.join(SENSEVOICE_DIR, 'silero_vad.onnx')).size === SILERO_VAD.sizeBytes;
  } catch (_) {
    return false;
  }
}

/** Tải gói SenseVoice + VAD, kiểm SHA-256, giải nén và chỉ giữ file cần thiết (bỏ test_wavs). */
async function installSenseVoice(job, tempDir) {
  fs.mkdirSync(SENSEVOICE_DIR, { recursive: true });
  const archive = path.join(tempDir, 'sensevoice.tar.bz2');
  await downloadFileWithProgress(SENSEVOICE_PACKAGE.url, archive, (dl, total) => {
    job.downloadedBytes = dl;
    job.totalBytes = total || SENSEVOICE_PACKAGE.sizeBytes;
    job.progress = Math.min(70, 10 + Math.round((dl / job.totalBytes) * 60));
    job.step = `Đang tải SenseVoiceSmall: ${(dl / 1048576).toFixed(1)} / ${(job.totalBytes / 1048576).toFixed(0)} MB...`;
  });
  job.step = 'Đang kiểm tra SHA-256 gói SenseVoice...';
  const sha = await computeFileSha256(archive);
  if (sha !== SENSEVOICE_PACKAGE.sha256) throw new Error(`SHA-256 gói SenseVoice không khớp (${sha}) — file tải về bị hỏng hoặc không phải bản chính thức.`);
  job.progress = 75;
  job.step = 'Đang giải nén SenseVoiceSmall...';
  const exDir = path.join(tempDir, 'sv_extract');
  fs.mkdirSync(exDir, { recursive: true });
  await pyEnv.extractArchive(archive, exDir);
  for (const f of SENSEVOICE_PACKAGE.files) {
    const src = path.join(exDir, SENSEVOICE_PACKAGE.folder, f);
    if (!fs.existsSync(src)) throw new Error(`Gói SenseVoice thiếu file ${f}.`);
    fs.copyFileSync(src, path.join(SENSEVOICE_DIR, f));
  }
  fs.rmSync(exDir, { recursive: true, force: true });
  job.progress = 85;
  job.step = 'Đang tải Silero VAD (chia đoạn nói)...';
  const vadTmp = path.join(tempDir, 'silero_vad.onnx');
  await downloadFileWithProgress(SILERO_VAD.url, vadTmp, () => {});
  const vsha = await computeFileSha256(vadTmp);
  if (vsha !== SILERO_VAD.sha256) throw new Error(`SHA-256 Silero VAD không khớp (${vsha}).`);
  fs.copyFileSync(vadTmp, path.join(SENSEVOICE_DIR, 'silero_vad.onnx'));
  fs.writeFileSync(path.join(SENSEVOICE_DIR, 'version.txt'), SENSEVOICE_PACKAGE.folder, 'utf8');
}
const VENV_PYTHON = path.join(
  PROJECT_ROOT,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python3'
);

const activeInstallJobs = new Map();

/**
 * Xác định nguồn tải chính thức theo OS (`process.platform`) và kiến trúc (`process.arch`)
 */
function resolveOfficialToolSource(toolId, platform = process.platform, arch = process.arch) {
  const isMac = platform === 'darwin';
  const isWin = platform === 'win32';
  const isArm = arch === 'arm64';

  const definitions = {
    ytdlp: {
      id: 'ytdlp',
      name: 'yt-dlp Core Extractor',
      category: 'Binary Trích xuất Video',
      officialProvider: 'GitHub Releases (yt-dlp/yt-dlp)',
      license: 'Unlicense (Public Domain)',
      downloadUrl: isWin
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        : isMac
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
        : isArm
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
      targetPath: getExecutablePath('yt-dlp'),
      archiveType: 'raw_binary',
      minBytes: 2 * 1024 * 1024,
      estimatedSizeMB: isMac ? 32 : 18,
      description: 'Công cụ dòng lệnh chính thức để phân tích và tải luồng video/audio HLS, DASH từ hơn 1000 nền tảng.',
      remediationSteps: [
        isMac
          ? 'Cách 1 (macOS Homebrew): Mở Terminal và chạy `brew install yt-dlp`, sau đó copy vào thư mục `bin/yt-dlp`.'
          : 'Cách 1 (Windows Winget): Mở PowerShell và chạy `winget install yt-dlp.yt-dlp`.',
        'Cách 2 (Tải trực tiếp): Truy cập https://github.com/yt-dlp/yt-dlp/releases/latest và tải file phù hợp hệ điều hành rồi đặt vào thư mục `bin/` của dự án.',
        isMac ? 'Đừng quên cấp quyền chạy bằng lệnh: `chmod +x bin/yt-dlp`.' : 'Đảm bảo tên file là `bin/yt-dlp.exe`.'
      ]
    },
    ffmpeg: {
      id: 'ffmpeg',
      name: 'FFmpeg Media Engine',
      category: 'Binary Xử lý Âm thanh & Video',
      officialProvider: isMac
        ? 'evermeet.cx / osxexperts (Official macOS Static Builds)'
        : 'gyan.dev / BtbN (Official Windows Static Builds)',
      license: 'LGPL v2.1+ / GPL v2+',
      downloadUrl: isMac
        ? 'https://evermeet.cx/ffmpeg/getrelease/zip'
        : isWin
        ? 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
        : 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
      targetPath: getExecutablePath('ffmpeg'),
      archiveType: isMac || isWin ? 'zip_ffmpeg' : 'tar_ffmpeg',
      minBytes: 10 * 1024 * 1024,
      estimatedSizeMB: isMac ? 45 : 85,
      description: 'Công cụ bắt buộc để tách âm thanh (ASR), chuẩn hóa H.264/AAC, chuyển đổi 9 định dạng và ghép lồng tiếng.',
      remediationSteps: [
        isMac
          ? 'Cách 1 (macOS Homebrew): Chạy `brew install ffmpeg` trong Terminal, sau đó chạy `cp $(which ffmpeg) bin/ffmpeg`.'
          : 'Cách 1 (Windows Winget): Chạy `winget install Gyan.FFmpeg` trong PowerShell.',
        'Cách 2 (Tải trực tiếp): Tải bản static tại https://ffmpeg.org/download.html, giải nén file `ffmpeg` vào thư mục `bin/` của ứng dụng.',
        isMac ? 'Cấp quyền chạy bằng lệnh: `chmod +x bin/ffmpeg`.' : 'Đặt file tại `bin/ffmpeg.exe`.'
      ]
    },
    webkitSniffer: {
      id: 'webkitSniffer',
      name: 'WebKitSniffer (macOS WKWebView Engine)',
      category: 'Binary Trình duyệt Ẩn (macOS)',
      officialProvider: 'Trình biên dịch Clang cục bộ (Apple WebKit Framework)',
      license: 'MIT (Nội bộ dự án)',
      downloadUrl: 'local://compile-webkit-sniffer',
      targetPath: path.join(BIN_DIR, 'WebKitSniffer'),
      archiveType: 'local_compile',
      minBytes: 16 * 1024,
      estimatedSizeMB: 0.1,
      description: 'Biên dịch trực tiếp từ mã nguồn `src/webkit_sniffer.m` bằng Apple Clang trên máy macOS để giải mã chữ ký Douyin/Kuaishou.',
      remediationSteps: [
        'Cài đặt Xcode Command Line Tools trên macOS bằng lệnh: `xcode-select --install`.',
        'Biên dịch thủ công trong thư mục dự án: `clang -fobjc-arc -framework Cocoa -framework WebKit src/webkit_sniffer.m -o bin/WebKitSniffer`.'
      ]
    },
    localAsr: {
      id: 'localAsr',
      name: 'Faster-Whisper ASR (Mô hình Nhận dạng Giọng nói)',
      category: 'Mô hình AI Local (ASR)',
      officialProvider: 'HuggingFace Official (Systran/faster-whisper-tiny)',
      license: 'MIT License',
      downloadUrl: 'local://python-download-asr',
      targetPath: path.join(MODELS_DIR, 'asr', 'faster-whisper-tiny', 'model.bin'),
      archiveType: 'python_asr_model',
      minBytes: 30 * 1024 * 1024,
      estimatedSizeMB: 75,
      description: 'Mô hình nhận diện lời thoại đa ngôn ngữ (Trung, Việt, Anh, Nhật, Hàn) từ âm thanh thực tế của video.',
      remediationSteps: [
        'Kiểm tra kết nối Internet tới `huggingface.co`.',
        'Hoặc chạy lệnh cài đặt thủ công: `.venv/bin/python3 -c "from faster_whisper import download_model; download_model(\'tiny\', output_dir=\'bin/models/asr/faster-whisper-tiny\')"`.'
      ]
    },
    localAsrSenseVoice: {
      id: 'localAsrSenseVoice',
      name: 'SenseVoiceSmall ASR (Nhận dạng giọng nói — Đề xuất)',
      category: 'Mô hình AI Local (ASR)',
      officialProvider: 'GitHub Releases (k2-fsa/sherpa-onnx — FunAudioLLM SenseVoiceSmall int8 2024-07-17 + Silero VAD)',
      license: 'FunASR Model License (SenseVoice, dùng miễn phí, ghi nguồn) / MIT (Silero VAD)',
      downloadUrl: SENSEVOICE_PACKAGE.url,
      targetPath: path.join(SENSEVOICE_DIR, 'model.int8.onnx'),
      archiveType: 'sensevoice_asr',
      minBytes: 200 * 1024 * 1024,
      estimatedSizeMB: 238,
      description:
        'Nhận dạng giọng nói Trung/Anh/Nhật/Hàn/Quảng Đông (FunAudioLLM SenseVoiceSmall, int8). Đo trên video tiếng Tứ Xuyên có nhạc nền: 85% chữ đúng (Whisper small 60%), nhanh hơn ~5 lần, nhẹ hơn một nửa.',
      remediationSteps: [
        `Tải thủ công ${SENSEVOICE_PACKAGE.url} (SHA-256 ${SENSEVOICE_PACKAGE.sha256}) → giải nén, chép model.int8.onnx, tokens.txt, LICENSE vào bin/models/asr/sensevoice-small-int8/ và tạo file version.txt chứa "${SENSEVOICE_PACKAGE.folder}".`,
        `Tải ${SILERO_VAD.url} (SHA-256 ${SILERO_VAD.sha256}) vào cùng thư mục.`
      ]
    },
    localAsrSmall: {
      id: 'localAsrSmall',
      name: 'Faster-Whisper Small ASR (dự phòng / tiếng Anh)',
      category: 'Mô hình AI Local (ASR)',
      officialProvider: 'HuggingFace Official (Systran/faster-whisper-small)',
      license: 'MIT License',
      downloadUrl: 'local://python-download-asr-small',
      targetPath: path.join(MODELS_DIR, 'asr', 'faster-whisper-small', 'model.bin'),
      archiveType: 'python_asr_model',
      asrSize: 'small',
      minBytes: 200 * 1024 * 1024,
      estimatedSizeMB: 464,
      description: 'Model nhận dạng lớn hơn, chính xác hơn rõ rệt với tiếng Trung. Khi có model này, ứng dụng tự ưu tiên dùng.',
      remediationSteps: [
        'Kiểm tra kết nối Internet tới `huggingface.co`.',
        'Hoặc chạy: `.venv/bin/python3 -c "from faster_whisper import download_model; download_model(\'small\', output_dir=\'bin/models/asr/faster-whisper-small\')"`.'
      ]
    },
    localTts: {
      id: 'localTts',
      name: 'Sherpa-ONNX Piper VITS (Giọng đọc Tiếng Việt Neural)',
      category: 'Mô hình AI Local (TTS)',
      officialProvider: 'GitHub Releases (k2-fsa/sherpa-onnx)',
      license: 'MIT License',
      downloadUrl:
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-vi_VN-vais1000-medium-int8.tar.bz2',
      targetPath: path.join(
        MODELS_DIR,
        'tts',
        'vits-piper-vi_VN-vais1000-medium-int8',
        'vi_VN-vais1000-medium.onnx'
      ),
      archiveType: 'tar_bz2_tts',
      minBytes: 10 * 1024 * 1024,
      estimatedSizeMB: 30,
      description: 'Bộ mô hình giọng đọc Tiếng Việt Neural Offline (VAIS-1000 22.05kHz & VIVOS) chạy trực tiếp trên CPU.',
      remediationSteps: [
        'Tải gói mô hình tại: https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-vi_VN-vais1000-medium-int8.tar.bz2',
        'Giải nén vào thư mục `bin/models/tts/` của ứng dụng.'
      ]
    },
    localNmt: {
      id: 'localNmt',
      name: 'Argos OpenNMT CTranslate2 (Mô hình Dịch Offline ZH -> VI)',
      category: 'Mô hình AI Local (NMT)',
      officialProvider: 'Argos OpenTech Official Packages (data.argosopentech.com)',
      license: 'MIT / CC-BY-4.0',
      downloadUrl: 'local://download-argos-nmt',
      targetPath: path.join(MODELS_DIR, 'argos', 'translate-en_vi-1_9', 'model', 'model.bin'),
      archiveType: 'argos_packages',
      minBytes: 40 * 1024 * 1024,
      estimatedSizeMB: 215,
      description: 'Bộ 2 mô hình dịch máy Neural Offline (Trung -> Anh & Anh -> Việt) chạy bằng CTranslate2 không cần gửi dữ liệu lên Cloud.',
      remediationSteps: [
        'Tải 2 gói `.argosmodel` tại `https://data.argosopentech.com/argospm/index.json` (`translate-zh_en-1_9.argosmodel` và `translate-en_vi-1_9.argosmodel`).',
        'Giải nén (định dạng ZIP) vào thư mục `bin/models/argos/`.'
      ]
    },
    pythonCore: {
      id: 'pythonCore',
      name: 'Môi trường Python AI (nền tảng cho nhận dạng giọng nói, tách giọng, giọng đọc)',
      category: 'Nền tảng',
      officialProvider: 'uv (astral-sh) + Python 3.12 độc lập + gói PyPI trong requirements/core.txt',
      license: 'MIT / Apache-2.0',
      downloadUrl: 'https://github.com/astral-sh/uv',
      targetPath: pyEnv.venvPython(pyEnv.VENVS.core),
      archiveType: 'python_core',
      minBytes: 0,
      estimatedSizeMB: 450,
      description:
        'Tạo môi trường .venv bằng Python 3.12 độc lập (không đụng Python của hệ thống) và cài faster-whisper, sherpa-onnx, CTranslate2... Chạy được trên macOS và Windows 10/11 x64.',
      remediationSteps: [
        'Kiểm tra Internet tới pypi.org, github.com (uv, Python), files.pythonhosted.org.',
        'Cài thủ công: tải uv tại https://github.com/astral-sh/uv/releases → `uv python install 3.12` → `uv venv .venv --python 3.12` → `uv pip install -r requirements/core.txt` (đặt VIRTUAL_ENV=.venv).'
      ]
    },
    localLlmQwen:
      localLlm.BACKEND === 'llamacpp'
        ? {
            id: 'localLlmQwen',
            name: 'AI dịch Local Qwen3.5 9B (llama.cpp — không cần API Key)',
            category: 'Mô hình AI Local (LLM dịch thuật)',
            officialProvider: `GitHub Releases (ggml-org/llama.cpp ${localLlm.LLAMA_CPP.build}, Vulkan) + HuggingFace (unsloth/Qwen3.5-9B-GGUF)`,
            license: 'MIT (llama.cpp) / Apache-2.0 (Qwen3.5)',
            downloadUrl: localLlm.LLAMA_CPP.url,
            targetPath: localLlm.LLAMA_CPP.serverBin,
            archiveType: 'llamacpp_llm',
            minBytes: 0,
            estimatedSizeMB: 5800,
            description:
              `Dịch Trung–Việt bằng Qwen3.5 9B chạy ngay trên máy Windows (GPU NVIDIA/AMD/Intel qua Vulkan, tự chạy CPU nếu không có GPU). Không gửi dữ liệu ra ngoài, không cần API Key. Cài vào thư mục dùng chung ${localLlm.QWEN_HOME || '%USERPROFILE%\\QwenLocal'} (file mô tả qwen-local.json) để ứng dụng khác dùng lại; thư mục app có lối tắt "Qwen Local". Nên có RAM 16 GB.`,
            remediationSteps: [
              `Tải thủ công ${localLlm.LLAMA_CPP.url} → giải nén vào %USERPROFILE%\\QwenLocal\\llama.cpp\\${localLlm.LLAMA_CPP.build}\\ (SHA-256 ${localLlm.LLAMA_CPP.asset ? localLlm.LLAMA_CPP.asset.sha256 : ''}).`,
              'Tải Qwen3.5-9B-Q4_K_M.gguf tại https://huggingface.co/unsloth/Qwen3.5-9B-GGUF → đặt vào %USERPROFILE%\\QwenLocal\\models\\.',
              'Máy dưới 16 GB RAM có thể chậm; khi đó nên dùng Gemini (miễn phí qua AI Studio).'
            ]
          }
        : {
            id: 'localLlmQwen',
            name: 'AI dịch Local (Qwen • Apple MLX — không cần API Key)',
            category: 'Mô hình AI Local (LLM dịch thuật)',
            officialProvider: 'PyPI `mlx-lm` (Apple MLX) + HuggingFace (mlx-community)',
            license: 'MIT (mlx-lm) / Apache-2.0 (Qwen)',
            downloadUrl: 'https://pypi.org/project/mlx-lm/',
            targetPath: path.join(PROJECT_ROOT, '.venv-llm'),
            archiveType: 'mlx_llm',
            minBytes: 0,
            estimatedSizeMB: 6500,
            description:
              'Dịch Trung–Việt bằng Qwen chạy trên GPU Apple Silicon (MLX), không gửi dữ liệu ra ngoài, không cần API Key. Máy Mac chip Apple (M1 trở lên).',
            remediationSteps: [
              'Cài thủ công: `bin/tools/uvpkg/bin/uv venv .venv-llm --python 3.12` → `VIRTUAL_ENV=.venv-llm bin/tools/uvpkg/bin/uv pip install mlx-lm`, rồi tải model vào bin/models/llm/.'
            ]
          },
    voiceSeparation: {
      id: 'voiceSeparation',
      name: 'Tách giọng gốc khỏi nhạc nền (Spleeter 2-stems fp16)',
      category: 'Mô hình AI Local (Source Separation)',
      officialProvider: 'GitHub Releases (k2-fsa/sherpa-onnx)',
      license: 'MIT (Spleeter / Deezer)',
      downloadUrl:
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2',
      targetPath: path.join(MODELS_DIR, 'separation', 'sherpa-onnx-spleeter-2stems-fp16', 'accompaniment.fp16.onnx'),
      archiveType: 'tar_bz2_separation',
      minBytes: 10 * 1024 * 1024,
      estimatedSizeMB: 40,
      description: 'Loại bỏ giọng nói gốc, giữ nhạc nền & tiếng động khi xuất video lồng tiếng (không còn nghe giọng gốc chồng lên giọng lồng).',
      remediationSteps: [
        'Tải gói tại URL trên và giải nén vào bin/models/separation/.'
      ]
    },
    subtitleOcr: {
      id: 'subtitleOcr',
      name: 'Đọc phụ đề trong hình (OCR • PaddleOCR PP-OCRv4)',
      category: 'Mô hình AI Local (OCR)',
      officialProvider: `PyPI (rapidocr_onnxruntime ${OCR_PACKAGE.version} — mô hình PaddleOCR PP-OCRv4 ONNX)`,
      license: 'Apache-2.0 (PaddleOCR / RapidOCR)',
      downloadUrl: OCR_PACKAGE.url,
      targetPath: path.join(OCR_MODELS_DIR, 'ch_PP-OCRv4_rec_infer.onnx'),
      archiveType: 'ocr_models',
      minBytes: 0,
      estimatedSizeMB: 16,
      description:
        'Đọc lời thoại từ phụ đề chữ Trung in sẵn trong video (chính xác hơn nhiều so với nghe khi có tiếng địa phương / nhạc nền). Chỉ giữ 2 file mô hình (~15,6 MB), không cài OpenCV.',
      remediationSteps: [
        `Tải ${OCR_PACKAGE.url} (SHA-256 ${OCR_PACKAGE.sha256}), đổi đuôi .zip, giải nén rồi chép rapidocr_onnxruntime/models/ch_PP-OCRv4_det_infer.onnx và ch_PP-OCRv4_rec_infer.onnx vào bin/models/ocr/.`
      ]
    },
    speakerDiarization: {
      id: 'speakerDiarization',
      name: 'Phân tách người nói (Pyannote Segmentation 3.0 + 3D-Speaker)',
      category: 'Mô hình AI Local (Diarization)',
      officialProvider: 'GitHub Releases (k2-fsa/sherpa-onnx)',
      license: 'MIT / Apache-2.0',
      downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-segmentation-models',
      targetPath: path.join(MODELS_DIR, 'diarization', '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'),
      archiveType: 'diarization_models',
      minBytes: 20 * 1024 * 1024,
      estimatedSizeMB: 45,
      description: 'Tự nhận diện ai đang nói trong từng câu (speaker_1, speaker_2...) để gán giọng lồng tiếng nhất quán cho từng người.',
      remediationSteps: [
        'Tải https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 và giải nén vào bin/models/diarization/.',
        'Tải https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx vào bin/models/diarization/.'
      ]
    },
    vieneuTts: {
      id: 'vieneuTts',
      name: 'VieNeu-TTS v3 Turbo (Giọng đọc Tiếng Việt 48 kHz)',
      category: 'Mô hình AI Local (TTS)',
      officialProvider: 'PyPI `vieneu` + HuggingFace (pnnbao-ump/VieNeu-TTS-v3-Turbo)',
      license: 'Apache-2.0',
      downloadUrl: 'https://pypi.org/project/vieneu/',
      targetPath: path.join(PROJECT_ROOT, '.venv-vieneu'),
      archiveType: 'vieneu_python',
      minBytes: 0,
      estimatedSizeMB: 1300,
      description:
        'Tạo môi trường Python 3.12 riêng (.venv-vieneu) bằng uv, cài SDK chính thức `vieneu` (ONNX Runtime CPU) rồi tải mô hình v3 Turbo (~581 MB) từ HuggingFace. Sau khi tải chạy 100% offline.',
      remediationSteps: [
        'Kiểm tra kết nối Internet tới pypi.org, github.com (python-build-standalone) và huggingface.co.',
        'Cài thủ công: `.venv/bin/pip install --target bin/tools/uvpkg uv` → `bin/tools/uvpkg/bin/uv python install 3.12` → `bin/tools/uvpkg/bin/uv venv .venv-vieneu --python 3.12` → `VIRTUAL_ENV=.venv-vieneu bin/tools/uvpkg/bin/uv pip install vieneu`.',
        'Sau đó bấm cài lại mục này để tải mô hình (HF_HOME = bin/models/vieneu-hf).'
      ]
    }
  };

  definitions.windowsApp = {
    id: 'windowsApp',
    name: 'Ứng dụng Windows CNVideoScraperPro.exe (cửa sổ riêng, không cần mở Edge)',
    category: 'Ứng dụng',
    officialProvider: `NuGet (Microsoft.Web.WebView2 ${WEBVIEW2_SDK.version}) + bộ dịch C# có sẵn của Windows`,
    license: 'BSD-3-Clause (Microsoft WebView2 SDK)',
    downloadUrl: WEBVIEW2_SDK.url,
    targetPath: WINDOWS_APP_EXE,
    archiveType: 'webview2_app',
    minBytes: 0,
    estimatedSizeMB: 2,
    description:
      'Dựng CNVideoScraperPro.exe ngay trên máy: cửa sổ ứng dụng riêng (Microsoft WebView2), máy chủ chạy ẩn, đóng cửa sổ là tắt hẳn. Chỉ tải ~10 MB gói SDK chính thức (giữ lại ~1 MB).',
    remediationSteps: [
      `Tải thủ công ${WEBVIEW2_SDK.url} (SHA-256 ${WEBVIEW2_SDK.sha256}), đổi đuôi .zip rồi giải nén.`,
      'Chép lib\\net462\\Microsoft.Web.WebView2.Core.dll, Microsoft.Web.WebView2.WinForms.dll vào bin\\windows_app\\ và runtimes\\win-x64\\native\\WebView2Loader.dll vào bin\\windows_app\\x64\\, rồi bấm cài lại mục này.',
      'Máy chưa có Microsoft Edge WebView2 Runtime: tải tại https://go.microsoft.com/fwlink/p/?LinkId=2124703'
    ]
  };

  return definitions[toolId] || null;
}

/* ---------- OCR phụ đề (PP-OCRv4 ONNX từ gói RapidOCR trên PyPI) ---------- */
const OCR_PACKAGE = {
  version: '1.4.4',
  url: 'https://files.pythonhosted.org/packages/ba/12/1e5497183bdbe782dbb91bad1d0d2297dba4d2831b2652657f7517bfc6df/rapidocr_onnxruntime-1.4.4-py3-none-any.whl',
  sha256: '971d7d5f223a7a808662229df1ef69893809d8457d834e6373d3854bc1782cbf',
  files: [
    ['rapidocr_onnxruntime/models/ch_PP-OCRv4_det_infer.onnx', 'ch_PP-OCRv4_det_infer.onnx', 4745517],
    ['rapidocr_onnxruntime/models/ch_PP-OCRv4_rec_infer.onnx', 'ch_PP-OCRv4_rec_infer.onnx', 10857958]
  ]
};
const OCR_MODELS_DIR = path.join(MODELS_DIR, 'ocr');
// Model đọc phụ đề TIẾNG ANH (PP-OCRv4 en, giữ dấu cách giữa các từ) — kho model chính thức của RapidOCR (RapidAI) trên ModelScope
const OCR_EN_MODEL = {
  url: 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/onnx/PP-OCRv4/rec/en_PP-OCRv4_rec_mobile.onnx',
  sha256: 'e8770c967605983d1570cdf5352041dfb68fa0c21664f49f47b155abd3e0e318',
  file: 'en_PP-OCRv4_rec_mobile.onnx',
  size: 7653044
};
function isOcrEnInstalled() {
  try {
    return fs.statSync(path.join(OCR_MODELS_DIR, OCR_EN_MODEL.file)).size === OCR_EN_MODEL.size;
  } catch (_) {
    return false;
  }
}

function isOcrInstalled() {
  return OCR_PACKAGE.files.every(([, dst, size]) => {
    try {
      return fs.statSync(path.join(OCR_MODELS_DIR, dst)).size === size;
    } catch (_) {
      return false;
    }
  });
}

async function installOcrModels(job) {
  fs.mkdirSync(OCR_MODELS_DIR, { recursive: true });
  const pkg = path.join(OCR_MODELS_DIR, 'rapidocr.whl.part');
  job.progress = 15;
  job.step = `Đang tải gói RapidOCR ${OCR_PACKAGE.version} từ PyPI (~15 MB)...`;
  await downloadFileWithProgress(OCR_PACKAGE.url, pkg, (dl, total) => {
    if (total > 0) job.progress = 15 + Math.round((dl / total) * 55);
  });
  const sha = await computeFileSha256(pkg);
  if (sha !== OCR_PACKAGE.sha256) {
    fs.rmSync(pkg, { force: true });
    throw new Error(`Mã SHA-256 của gói RapidOCR không khớp (nhận ${sha.slice(0, 16)}…) — đã hủy, không giải nén.`);
  }
  job.progress = 75;
  job.step = 'Đang lấy 2 file mô hình PP-OCRv4 (~15,6 MB)...';
  // Giải nén trong cùng thư mục (cùng ổ đĩa) bằng Python lõi — chạy giống nhau trên macOS và Windows
  const script = [
    'import sys, zipfile, os',
    'z = zipfile.ZipFile(sys.argv[1])',
    'for src, dst in zip(sys.argv[3::2], sys.argv[4::2]):',
    '    data = z.read(src)',
    '    tmp = os.path.join(sys.argv[2], dst + ".part")',
    '    open(tmp, "wb").write(data)',
    '    os.replace(tmp, os.path.join(sys.argv[2], dst))'
  ].join('\n');
  await pyEnv.run(pyEnv.venvPython(pyEnv.VENVS.core), ['-I', '-c', script, pkg, OCR_MODELS_DIR, ...OCR_PACKAGE.files.flatMap(([src, dst]) => [src, dst])], { timeoutMs: 120000 });
  fs.rmSync(pkg, { force: true });
  if (!isOcrInstalled()) throw new Error('Giải nén mô hình OCR không đủ dung lượng — hãy cài lại.');
  job.progress = 85;
  job.step = 'Đang tải model đọc phụ đề tiếng Anh (PP-OCRv4 en, ~7,6 MB)...';
  const enPart = path.join(OCR_MODELS_DIR, `${OCR_EN_MODEL.file}.part`);
  await downloadFileWithProgress(OCR_EN_MODEL.url, enPart, () => {});
  const enSha = await computeFileSha256(enPart);
  if (enSha !== OCR_EN_MODEL.sha256) {
    fs.rmSync(enPart, { force: true });
    throw new Error(`Mã SHA-256 model OCR tiếng Anh không khớp (nhận ${enSha.slice(0, 16)}…) — đã hủy.`);
  }
  fs.renameSync(enPart, path.join(OCR_MODELS_DIR, OCR_EN_MODEL.file));
}

async function verifyOcrModels() {
  if (!isOcrInstalled()) return { ok: false, error: 'Chưa có mô hình OCR (bin/models/ocr).' };
  const py = pyEnv.venvPython(pyEnv.VENVS.core);
  const code = [
    'import sys; sys.path.insert(0, sys.argv[1])',
    'import numpy as np, subtitle_ocr as so',
    'o = so.SubtitleOCR(sys.argv[2], lang=sys.argv[3])',
    'img = np.full((96, 640, 3), 255, np.uint8)',
    'o.detect_lines(img)',
    'print("OK", len(o.charset), len(o.charset_en) if o.rec_en is not None else 0)'
  ].join('\n');
  const r = await runCapture(py, ['-I', '-c', code, path.join(PROJECT_ROOT, 'src'), OCR_MODELS_DIR, isOcrEnInstalled() ? 'en' : 'zh'], { timeoutMs: 120000 });
  const m = r.out.match(/OK (\d+) (\d+)/);
  if (r.code === 0 && m && Number(m[1]) > 6000) return { ok: true, version: `PP-OCRv4 (nạp thử thành công: chữ Trung ${m[1]} ký tự${Number(m[2]) ? `, tiếng Anh ${m[2]} ký tự` : ''})`, sha256: null, sizeBytes: 0 };
  return { ok: false, error: `Không nạp được mô hình OCR: ${r.out.slice(-300)}` };
}

/* ---------- Ứng dụng Windows (WebView2) ---------- */
// Gói SDK chính thức của Microsoft trên NuGet — ghim phiên bản & SHA-256
const WEBVIEW2_SDK = {
  version: '1.0.4258.31',
  url: 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4258.31/microsoft.web.webview2.1.0.4258.31.nupkg',
  sha256: '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9',
  files: [
    ['lib/net462/Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.Core.dll'],
    ['lib/net462/Microsoft.Web.WebView2.WinForms.dll', 'Microsoft.Web.WebView2.WinForms.dll'],
    ['runtimes/win-x64/native/WebView2Loader.dll', 'x64/WebView2Loader.dll'],
    ['runtimes/win-arm64/native/WebView2Loader.dll', 'arm64/WebView2Loader.dll']
  ]
};
const WINDOWS_APP_DIR = path.join(PROJECT_ROOT, 'bin', 'windows_app');
const WINDOWS_APP_EXE = path.join(PROJECT_ROOT, 'CNVideoScraperPro.exe');
const WINDOWS_APP_SRC = path.join(PROJECT_ROOT, 'src', 'windows_app', 'CNVideoScraperPro.cs');

function isWindowsAppInstalled() {
  return fs.existsSync(WINDOWS_APP_EXE) && WEBVIEW2_SDK.files.every(([, dst]) => fs.existsSync(path.join(WINDOWS_APP_DIR, dst)));
}

/** Bộ dịch C# có sẵn trong Windows (.NET Framework 4.x). */
function findCsc() {
  const win = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runCapture(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(bin, args, { windowsHide: true, ...opts });
    } catch (e) {
      return resolve({ code: -1, out: e.message });
    }
    const t = setTimeout(() => {
      try {
        p.kill();
      } catch (_) {}
    }, opts.timeoutMs || 120000);
    p.stdout && p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.stderr && p.stderr.on('data', (d) => (out += d.toString('utf8')));
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: e.message });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

async function installWindowsApp(job) {
  if (process.platform !== 'win32') throw new Error('Ứng dụng .exe chỉ dành cho Windows (macOS đã có CNVideoScraperPro.app).');
  const csc = findCsc();
  if (!csc) throw new Error('Không thấy bộ dịch C# của .NET Framework 4 (csc.exe) trong Windows.');
  fs.mkdirSync(WINDOWS_APP_DIR, { recursive: true });
  if (!WEBVIEW2_SDK.files.every(([, dst]) => fs.existsSync(path.join(WINDOWS_APP_DIR, dst)))) {
    const pkg = path.join(WINDOWS_APP_DIR, 'webview2-sdk.zip.part');
    job.progress = 10;
    job.step = `Đang tải Microsoft WebView2 SDK ${WEBVIEW2_SDK.version} từ NuGet (~10 MB)...`;
    await downloadFileWithProgress(WEBVIEW2_SDK.url, pkg, (dl, total) => {
      if (total > 0) job.progress = 10 + Math.round((dl / total) * 40);
    });
    const sha = await computeFileSha256(pkg);
    if (sha !== WEBVIEW2_SDK.sha256) {
      fs.rmSync(pkg, { force: true });
      throw new Error(`Mã SHA-256 của gói WebView2 không khớp (nhận ${sha.slice(0, 16)}…) — đã hủy, không giải nén.`);
    }
    job.progress = 55;
    job.step = 'Đang lấy 3 thư viện cần thiết từ gói WebView2 (~1 MB)...';
    // Giải nén ngay trong thư mục app (cùng ổ đĩa): thư mục tạm của Windows thường ở ổ C, đổi tên file sang ổ khác sẽ lỗi EXDEV
    const tmp = fs.mkdtempSync(path.join(WINDOWS_APP_DIR, '.tmp_'));
    try {
      const zip = path.join(tmp, 'sdk.zip');
      fs.renameSync(pkg, zip);
      const win = process.env.SystemRoot || 'C:\\Windows';
      const tarExe = path.join(win, 'System32', 'tar.exe');
      const r = await runCapture(fs.existsSync(tarExe) ? tarExe : 'tar', ['-xf', zip, '-C', tmp, ...WEBVIEW2_SDK.files.map(([src]) => src)]);
      if (r.code !== 0) throw new Error(`Giải nén gói WebView2 lỗi: ${r.out.slice(-300)}`);
      for (const [src, dst] of WEBVIEW2_SDK.files) {
        const to = path.join(WINDOWS_APP_DIR, dst);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(tmp, ...src.split('/')), to);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  job.progress = 70;
  job.step = 'Đang dựng CNVideoScraperPro.exe bằng bộ dịch C# có sẵn của Windows...';
  // Thư viện WebView2 nằm trong bin\windows_app (không rải DLL ra thư mục gốc)
  fs.writeFileSync(
    `${WINDOWS_APP_EXE}.config`,
    '<?xml version="1.0" encoding="utf-8"?>\r\n<configuration>\r\n  <startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.6.2" /></startup>\r\n  <runtime>\r\n    <assemblyBinding xmlns="urn:schemas-microsoft-com:asm.v1"><probing privatePath="bin\\windows_app" /></assemblyBinding>\r\n  </runtime>\r\n</configuration>\r\n',
    'utf8'
  );
  const tmpExe = `${WINDOWS_APP_EXE}.new`;
  const args = [
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/codepage:65001',
    `/out:${tmpExe}`,
    `/win32icon:${path.join(PROJECT_ROOT, 'public', 'icon.ico')}`,
    `/reference:${path.join(WINDOWS_APP_DIR, 'Microsoft.Web.WebView2.Core.dll')}`,
    `/reference:${path.join(WINDOWS_APP_DIR, 'Microsoft.Web.WebView2.WinForms.dll')}`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    WINDOWS_APP_SRC
  ];
  const r = await runCapture(csc, args, { cwd: PROJECT_ROOT });
  if (r.code !== 0 || !fs.existsSync(tmpExe)) throw new Error(`Dựng CNVideoScraperPro.exe lỗi: ${r.out.slice(-800)}`);
  // Có bản cũ đang chạy thì không ghi đè được → báo rõ
  try {
    fs.rmSync(WINDOWS_APP_EXE, { force: true });
  } catch (e) {
    fs.rmSync(tmpExe, { force: true });
    throw new Error('CNVideoScraperPro.exe đang mở — hãy đóng ứng dụng rồi cài lại mục này.');
  }
  fs.renameSync(tmpExe, WINDOWS_APP_EXE);
  job.progress = 85;
  job.step = 'Đang kiểm tra ứng dụng (nạp WebView2)...';
}

async function verifyWindowsApp() {
  if (!isWindowsAppInstalled()) return { ok: false, error: 'Chưa có CNVideoScraperPro.exe hoặc thư viện WebView2.' };
  const r = await runCapture(WINDOWS_APP_EXE, ['--selftest'], { cwd: PROJECT_ROOT, timeoutMs: 60000 });
  const out = r.out.trim();
  if (r.code === 0 && /^OK/.test(out)) return { ok: true, version: `CNVideoScraperPro.exe • ${out.replace(/^OK\s*/, '')}`, sha256: null, sizeBytes: fs.statSync(WINDOWS_APP_EXE).size };
  if (r.code === 2) return { ok: false, error: 'Đã dựng CNVideoScraperPro.exe nhưng máy chưa có Microsoft Edge WebView2 Runtime — cài tại https://go.microsoft.com/fwlink/p/?LinkId=2124703 (app vẫn mở được bằng trình duyệt).' };
  return { ok: false, error: `CNVideoScraperPro.exe không chạy được: ${out || `mã ${r.code}`}` };
}

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath || !fs.existsSync(filePath)) {
      return reject(new Error('Không tìm thấy file để tính mã kiểm tra SHA-256.'));
    }
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Tải file qua HTTP/HTTPS có hỗ trợ theo dõi redirect (tối đa 6 lần), User-Agent chuẩn, và báo cáo tiến độ.
 */
function downloadFileWithProgress(url, destPath, onProgress = null, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 6) {
      return reject(new Error('Quá nhiều lần chuyển hướng (Redirect loop) khi tải công cụ.'));
    }

    const client = url.startsWith('https') ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: '*/*'
        },
        timeout: 45000
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(downloadFileWithProgress(nextUrl, destPath, onProgress, redirectCount + 1));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Máy chủ trả về mã lỗi HTTP ${res.statusCode} khi tải từ ${url}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let downloadedBytes = 0;

        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const fileStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (typeof onProgress === 'function') {
            onProgress(downloadedBytes, totalBytes);
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => resolve({ destPath, downloadedBytes, totalBytes }));
        });

        fileStream.on('error', (err) => {
          try {
            fs.unlinkSync(destPath);
          } catch (_) {}
          reject(err);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Quá thời gian kết nối khi tải công cụ.'));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

function runShellCommand(bin, args, timeoutMs = 120000, env = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env } : {}) });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      reject(new Error(`Lệnh ${bin} vượt quá thời gian chờ (${timeoutMs}ms).`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Lệnh ${bin} kết thúc với mã ${code}: ${[stdout.trim().slice(-300), stderr.trim().slice(-300)].filter(Boolean).join(' | ')}`));
    });
  });
}

/**
 * Xác minh thực tế sau khi tải/cài đặt: kiểm tra file tồn tại, dung lượng >= minBytes,
 * tính SHA-256 và chạy thử kiểm tra phiên bản / nạp mô hình.
 */
async function verifyInstalledToolOrModel(toolId) {
  const spec = resolveOfficialToolSource(toolId);
  if (!spec) {
    return { ok: false, error: `Không tìm thấy cấu hình công cụ: ${toolId}` };
  }

  if (toolId === 'localLlmQwen') {
    return verifyLocalLlm();
  }
  if (toolId === 'windowsApp') {
    return verifyWindowsApp();
  }
  if (toolId === 'subtitleOcr') {
    return verifyOcrModels();
  }
  if (toolId === 'pythonCore') {
    let ok = await pyEnv.pythonImports(pyEnv.VENVS.core, ['faster_whisper', 'sherpa_onnx', 'ctranslate2', 'numpy']);
    if (ok) {
      // Giải mã thử 1 giây âm thanh bằng chính hàm faster-whisper dùng (phát hiện PyAV không tương thích)
      try {
        await pyEnv.run(
          VENV_PYTHON,
          ['-c', 'import io,wave; b=io.BytesIO(); w=wave.open(b,"wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(bytes(32000)); w.close(); b.seek(0); from faster_whisper.audio import decode_audio; assert len(decode_audio(b))>0'],
          { env: pyEnv.uvEnv(), timeoutMs: 120000 }
        );
      } catch (err) {
        return { ok: false, error: `Thư viện giải mã âm thanh không tương thích (hãy chạy lại cài đặt "Môi trường Python AI"): ${String(err.message).slice(-200)}` };
      }
    }
    return ok
      ? { ok: true, sha256: null, sizeBytes: 0, version: `Python AI (.venv) sẵn sàng` }
      : { ok: false, error: 'Môi trường .venv chưa import được faster_whisper / sherpa_onnx / ctranslate2.' };
  }
  if (toolId === 'vieneuTts') {
    const st = vieneuService.getStatus();
    if (!st.sdkInstalled) return { ok: false, error: 'Chưa cài được SDK VieNeu-TTS trong .venv-vieneu.' };
    if (!st.modelDownloaded) return { ok: false, error: 'Chưa tải được mô hình VieNeu-TTS v3 Turbo.' };
    if (!st.voices || st.voices.length === 0) return { ok: false, error: 'Mô hình VieNeu-TTS chưa nạp được danh sách giọng.' };
    return { ok: true, sha256: null, sizeBytes: 0, version: `VieNeu-TTS v3 Turbo • ${st.voices.length} giọng (nạp ${st.lastLoadSec || '?'}s)` };
  }

  if (!fs.existsSync(spec.targetPath)) {
    return { ok: false, error: `File đích chưa tồn tại sau khi cài đặt: ${spec.targetPath}` };
  }

  const stat = fs.statSync(spec.targetPath);
  if (stat.size < spec.minBytes) {
    return {
      ok: false,
      error: `Dung lượng file (${stat.size} bytes) nhỏ hơn ngưỡng hợp lệ tối thiểu (${spec.minBytes} bytes). File có thể bị tải thiếu.`
    };
  }

  const sha256 = await computeFileSha256(spec.targetPath);

  if (toolId === 'ytdlp') {
    const probe = await runVersionProbe(spec.targetPath, ['--version'], 15000);
    if (!probe.ready) {
      return { ok: false, sha256, error: probe.error || 'yt-dlp không thể khởi chạy sau khi tải.' };
    }
    return { ok: true, sha256, sizeBytes: stat.size, version: probe.version };
  }

  if (toolId === 'ffmpeg') {
    const probe = await runVersionProbe(spec.targetPath, ['-version'], 8000);
    if (!probe.ready) {
      return { ok: false, sha256, error: probe.error || 'FFmpeg không thể khởi chạy sau khi tải.' };
    }
    return { ok: true, sha256, sizeBytes: stat.size, version: probe.version };
  }

  if (toolId === 'webkitSniffer') {
    const probe = await runVersionProbe(spec.targetPath, [], 4000);
    // WebKitSniffer khi gọi không tham số in Usage và thoát mã 1 (hoặc 0)
    const existsAndExec = fs.existsSync(spec.targetPath);
    if (!existsAndExec) {
      return { ok: false, sha256, error: 'WebKitSniffer không thể thực thi.' };
    }
    return {
      ok: true,
      sha256,
      sizeBytes: stat.size,
      version: probe.version || 'macOS Native WKWebView JS Sniffer v2.1'
    };
  }

  if (toolId === 'voiceSeparation') {
    const voc = path.join(path.dirname(spec.targetPath), 'vocals.fp16.onnx');
    try {
      await runShellCommand(
        VENV_PYTHON,
        ['-c', `import sherpa_onnx as s; c=s.OfflineSourceSeparationConfig(model=s.OfflineSourceSeparationModelConfig(spleeter=s.OfflineSourceSeparationSpleeterModelConfig(vocals=${JSON.stringify(voc)}, accompaniment=${JSON.stringify(spec.targetPath)}))); assert c.validate(); s.OfflineSourceSeparation(c)`],
        120000
      );
      return { ok: true, sha256, sizeBytes: stat.size, version: 'Spleeter 2-stems fp16 (nạp thử thành công)' };
    } catch (err) {
      return { ok: false, sha256, error: `Không nạp được mô hình tách giọng: ${err.message}` };
    }
  }

  if (toolId === 'speakerDiarization') {
    const segModel = path.join(path.dirname(spec.targetPath), 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx');
    if (!fs.existsSync(segModel)) return { ok: false, sha256, error: 'Thiếu model phân đoạn pyannote (model.onnx).' };
    try {
      await runShellCommand(
        VENV_PYTHON,
        [
          '-c',
          `import sherpa_onnx as s; c=s.OfflineSpeakerDiarizationConfig(segmentation=s.OfflineSpeakerSegmentationModelConfig(pyannote=s.OfflineSpeakerSegmentationPyannoteModelConfig(model=${JSON.stringify(segModel)})), embedding=s.SpeakerEmbeddingExtractorConfig(model=${JSON.stringify(spec.targetPath)}), clustering=s.FastClusteringConfig(num_clusters=-1, threshold=1.0)); assert c.validate(); s.OfflineSpeakerDiarization(c)`
        ],
        120000
      );
      return { ok: true, sha256, sizeBytes: stat.size, version: 'sherpa-onnx diarization (nạp thử thành công)' };
    } catch (err) {
      return { ok: false, sha256, error: `Không nạp được mô hình phân tách người nói: ${err.message}` };
    }
  }

  if (toolId === 'localAsrSenseVoice') {
    if (!isSenseVoiceInstalled()) return { ok: false, sha256, error: 'Thiếu file SenseVoice (model.int8.onnx / tokens.txt / silero_vad.onnx).' };
    try {
      const d = SENSEVOICE_DIR;
      await runShellCommand(
        VENV_PYTHON,
        ['-c', `import sherpa_onnx as s; s.OfflineRecognizer.from_sense_voice(model=${JSON.stringify(path.join(d, 'model.int8.onnx'))}, tokens=${JSON.stringify(path.join(d, 'tokens.txt'))}, language="zh", use_itn=True); c=s.VadModelConfig(); c.silero_vad.model=${JSON.stringify(path.join(d, 'silero_vad.onnx'))}; s.VoiceActivityDetector(c, buffer_size_in_seconds=10)`],
        180000
      );
      return { ok: true, sha256, sizeBytes: stat.size, version: 'SenseVoiceSmall int8 + Silero VAD (nạp thử thành công)' };
    } catch (err) {
      return { ok: false, sha256, error: `Không nạp được SenseVoiceSmall: ${err.message}` };
    }
  }

  if (toolId === 'localAsrSmall') {
    try {
      await runShellCommand(
        VENV_PYTHON,
        ['-c', `from faster_whisper import WhisperModel; WhisperModel(${JSON.stringify(path.dirname(spec.targetPath))}, device="cpu", compute_type="int8")`],
        180000
      );
      return { ok: true, sha256, sizeBytes: stat.size, version: 'Faster-Whisper Small (nạp thử thành công)' };
    } catch (err) {
      return { ok: false, sha256, error: `Không nạp được model Faster-Whisper Small: ${err.message}` };
    }
  }

  const modelsStatus = getLocalModelsStatus();
  const modelEntry = modelsStatus[toolId];
  if (modelEntry && modelEntry.ready) {
    return {
      ok: true,
      sha256,
      sizeBytes: stat.size,
      version: modelEntry.version
    };
  }

  return {
    ok: false,
    sha256,
    error: (modelEntry && modelEntry.error) || 'Mô hình AI chưa vượt qua bước kiểm tra nạp dữ liệu.'
  };
}

/**
 * Danh sách tất cả công cụ / mô hình có thể kiểm tra và cài đặt
 */
function getInstallableToolsCatalog() {
  // Gắn tác dụng / dung lượng thật / khuyến nghị theo máy / thành phần người dùng đã từ chối (dùng chung với setup.js)
  return require('./component_guide').annotate(getInstallableToolsCatalogRaw());
}

function getInstallableToolsCatalogRaw() {
  // Không liệt kê Argos (localNmt) và Whisper tiny (localAsr): đã kiểm nghiệm chất lượng kém, thay bằng Qwen3.5 9B / Whisper small.
  const ids = ['pythonCore', 'ytdlp', 'ffmpeg', 'webkitSniffer', 'localAsrSenseVoice', 'localAsrSmall', 'subtitleOcr', 'speakerDiarization', 'voiceSeparation', 'localLlmQwen', 'localTts', 'vieneuTts'];
  const modelsStatus = getLocalModelsStatus();

  return ids
    .filter((id) => !(id === 'webkitSniffer' && process.platform !== 'darwin'))
    .filter((id) => !(id === 'windowsApp' && process.platform !== 'win32'))
    .filter((id) => !(id === 'localLlmQwen' && !localLlm.PLATFORM_SUPPORTED))
    .map((id) => {
      const spec = resolveOfficialToolSource(id);
      if (id === 'ffmpeg') {
        // Ưu tiên ffmpeg do npm (ffmpeg-static) cài sẵn đúng HĐH; bin/ffmpeg(.exe) chỉ là phương án dự phòng
        const ff = getFfmpegPath();
        return { ...spec, os: process.platform, arch: process.arch, installed: Boolean(ff && fs.existsSync(ff)), activePath: ff, currentSizeBytes: 0 };
      }
      if (id === 'windowsApp') {
        return { ...spec, os: process.platform, arch: process.arch, installed: isWindowsAppInstalled(), currentSizeBytes: 0 };
      }
      if (id === 'subtitleOcr') {
        return { ...spec, os: process.platform, arch: process.arch, installed: isOcrInstalled(), currentSizeBytes: 0 };
      }
      if (id === 'localAsrSenseVoice') {
        return { ...spec, os: process.platform, arch: process.arch, installed: isSenseVoiceInstalled(), currentSizeBytes: 0 };
      }
      if (id === 'pythonCore') {
        // Môi trường Python độc lập với model: người dùng có thể cài Python nhưng không cài Whisper
        const py = pyEnv.venvPython(pyEnv.VENVS.core);
        return { ...spec, os: process.platform, arch: process.arch, installed: fs.existsSync(py), currentSizeBytes: 0 };
      }
      if (id === 'localLlmQwen') {
        const st = localLlm.getStatus();
        return { ...spec, os: process.platform, arch: process.arch, installed: st.runtimeInstalled && st.models.some((m) => m.installed), currentSizeBytes: 0 };
      }
      if (id === 'vieneuTts') {
        const st = vieneuService.getStatus();
        return {
          ...spec,
          os: process.platform,
          arch: process.arch,
          installed: st.sdkInstalled && st.modelDownloaded,
          sdkInstalled: st.sdkInstalled,
          modelDownloaded: st.modelDownloaded,
          currentSizeBytes: 0
        };
      }
      const exists = fs.existsSync(spec.targetPath);
      const sizeBytes = exists ? fs.statSync(spec.targetPath).size : 0;
      let ready = exists && sizeBytes >= spec.minBytes;
      if (modelsStatus[id]) {
        ready = modelsStatus[id].ready;
      }
      return {
        ...spec,
        os: process.platform,
        arch: process.arch,
        installed: ready,
        currentSizeBytes: sizeBytes
      };
    });
}

/**
 * Bắt đầu tác vụ tải & cài đặt công cụ còn thiếu.
 * BẮT BUỘC: `userConfirmed === true` để đảm bảo không bao giờ tải hoặc chạy ngầm mà người dùng không biết.
 */
function startToolInstallJob({ toolId, userConfirmed = false, qwenLocation = null }) {
  if (!userConfirmed) {
    throw new Error(
      'Cần sự xác nhận rõ ràng của người dùng (userConfirmed = true) trước khi tải và cài đặt công cụ hoặc mô hình.'
    );
  }
  // Người dùng chủ động cài → bỏ khỏi danh sách "đã từ chối" lúc cài đặt
  try {
    require('./component_guide').clearDeclined(toolId);
  } catch (_) {}
  // Windows: chọn nơi cài Qwen (ổ C ít chỗ → phải hỏi người dùng: ổ C hay thư mục ứng dụng)
  if (toolId === 'localLlmQwen' && process.platform === 'win32') {
    const qh = require('./qwen_shared_home');
    const a = qh.assessLocation();
    if (qwenLocation === 'user' || qwenLocation === 'app') {
      qh.chooseLocation(qwenLocation);
    } else if (a.ask) {
      const err = new Error(
        `Ổ ${a.userDrive} chỉ còn ${(a.userFree / 1e9).toFixed(1)} GB trống. Hãy chọn nơi cài Qwen (~6 GB): ổ ${a.userDrive} (thư mục dùng chung) hoặc thư mục ứng dụng (ổ ${a.appDrive}, còn ${a.appFree !== null ? (a.appFree / 1e9).toFixed(1) : '?'} GB).`
      );
      err.code = 'QWEN_LOCATION_REQUIRED';
      err.details = { userHome: a.userHome, appHome: a.appHome, userFree: a.userFree, appFree: a.appFree, userDrive: a.userDrive, appDrive: a.appDrive, recommended: a.recommended, userTooSmall: a.userTooSmall };
      throw err;
    }
  }

  const spec = resolveOfficialToolSource(toolId);
  if (!spec) {
    throw new Error(`Công cụ yêu cầu cài đặt không hợp lệ: "${toolId}".`);
  }

  // Nếu đang có job cài đặt cùng toolId đang chạy thì trả về job đó (tránh chạy trùng lặp)
  for (const existing of activeInstallJobs.values()) {
    if (existing.toolId === toolId && existing.status === 'running') {
      return existing;
    }
  }

  const jobId = `install_${toolId}_${Date.now()}`;
  const job = {
    id: jobId,
    toolId,
    toolName: spec.name,
    officialProvider: spec.officialProvider,
    downloadUrl: spec.downloadUrl,
    targetPath: spec.targetPath,
    os: process.platform,
    arch: process.arch,
    status: 'running', // running | completed | error
    progress: 5,
    step: `Đang chuẩn bị tải/cài đặt ${spec.name} từ ${spec.officialProvider}...`,
    downloadedBytes: 0,
    totalBytes: spec.estimatedSizeMB * 1024 * 1024,
    sha256: null,
    verifiedVersion: null,
    error: null,
    remediationSteps: spec.remediationSteps,
    createdAt: Date.now()
  };

  activeInstallJobs.set(jobId, job);

  (async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `cn_tool_install_${toolId}_`));
    try {
      if (process.env.OFFLINE_TEST_MODE === '1') {
        throw new Error('Đang ở chế độ kiểm thử ngoại tuyến (OFFLINE_TEST_MODE=1), chặn kết nối tải bên ngoài.');
      }

      if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

      const needsCorePython = ['ocr_models', 'sensevoice_asr', 'python_core', 'python_asr_model', 'tar_bz2_tts', 'tar_bz2_separation', 'diarization_models', 'argos_packages'];
      if (needsCorePython.includes(spec.archiveType)) {
        job.progress = Math.max(job.progress, 8);
        await pyEnv.ensureCoreVenv(
          (msg) => {
            job.step = msg;
          },
          { sync: spec.archiveType === 'python_core' }
        );
      }

      if (spec.archiveType === 'python_core') {
        // đã xử lý ở trên
      } else if (spec.archiveType === 'local_compile' && toolId === 'webkitSniffer') {
        job.progress = 25;
        job.step = 'Đang biên dịch mã nguồn src/webkit_sniffer.m bằng Apple Clang...';
        const srcPath = path.join(PROJECT_ROOT, 'src', 'webkit_sniffer.m');
        if (!fs.existsSync(srcPath)) {
          throw new Error('Không tìm thấy file mã nguồn src/webkit_sniffer.m.');
        }
        await runShellCommand('clang', [
          '-fobjc-arc',
          '-framework',
          'Cocoa',
          '-framework',
          'WebKit',
          srcPath,
          '-o',
          spec.targetPath
        ]);
        fs.chmodSync(spec.targetPath, 0o755);
      } else if (spec.archiveType === 'raw_binary') {
        const tempBin = path.join(tempDir, path.basename(spec.targetPath) + '.download');
        job.step = `Đang tải ${spec.name} từ ${spec.officialProvider}...`;
        await downloadFileWithProgress(spec.downloadUrl, tempBin, (dl, total) => {
          job.downloadedBytes = dl;
          if (total > 0) {
            job.totalBytes = total;
            job.progress = Math.min(78, 10 + Math.round((dl / total) * 68));
          } else {
            job.progress = Math.min(75, job.progress + 2);
          }
          const mb = (dl / (1024 * 1024)).toFixed(1);
          job.step = `Đang tải ${spec.name}: ${mb} MB...`;
        });

        job.progress = 82;
        job.step = 'Đang cấp quyền thực thi và cài đặt vào thư mục bin/...';
        fs.copyFileSync(tempBin, spec.targetPath);
        if (process.platform !== 'win32') {
          fs.chmodSync(spec.targetPath, 0o755);
        }
      } else if (spec.archiveType === 'zip_ffmpeg') {
        const zipPath = path.join(tempDir, 'ffmpeg_release.zip');
        job.step = `Đang tải gói nén FFmpeg từ ${spec.officialProvider}...`;
        await downloadFileWithProgress(spec.downloadUrl, zipPath, (dl, total) => {
          job.downloadedBytes = dl;
          if (total > 0) {
            job.totalBytes = total;
            job.progress = Math.min(72, 10 + Math.round((dl / total) * 62));
          }
          const mb = (dl / (1024 * 1024)).toFixed(1);
          job.step = `Đang tải FFmpeg: ${mb} MB...`;
        });

        job.progress = 78;
        job.step = 'Đang giải nén binary FFmpeg...';
        await pyEnv.extractArchive(zipPath, tempDir);

        // Tìm file ffmpeg hoặc ffmpeg.exe trong tempDir
        const findBin = (dir, targetName) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const found = findBin(full, targetName);
              if (found) return found;
            } else if (entry.name === targetName) {
              return full;
            }
          }
          return null;
        };
        const targetBinName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        const extractedBin = findBin(tempDir, targetBinName);
        if (!extractedBin) {
          throw new Error('Không tìm thấy file thực thi ffmpeg bên trong gói nén tải về.');
        }
        fs.copyFileSync(extractedBin, spec.targetPath);
        if (process.platform !== 'win32') {
          fs.chmodSync(spec.targetPath, 0o755);
        }
      } else if (spec.archiveType === 'python_asr_model') {
        job.progress = 25;
        job.step = 'Đang tải mô hình Faster-Whisper ASR từ HuggingFace Hub...';
        const asrSize = spec.asrSize || 'tiny';
        const outDir = path.dirname(spec.targetPath);
        fs.mkdirSync(outDir, { recursive: true });
        await pyEnv.run(
          VENV_PYTHON,
          ['-c', `from faster_whisper import download_model; download_model(${JSON.stringify(asrSize)}, output_dir=${JSON.stringify(outDir)})`],
          { env: pyEnv.uvEnv(), timeoutMs: 1800000 }
        );
      } else if (spec.archiveType === 'tar_bz2_tts') {
        const archivePath = path.join(tempDir, 'tts_model.tar.bz2');
        const ttsRoot = path.join(MODELS_DIR, 'tts');
        fs.mkdirSync(ttsRoot, { recursive: true });
        await downloadFileWithProgress(spec.downloadUrl, archivePath, (dl, total) => {
          job.downloadedBytes = dl;
          if (total > 0) {
            job.totalBytes = total;
            job.progress = Math.min(72, 10 + Math.round((dl / total) * 62));
          }
          job.step = `Đang tải mô hình giọng đọc Tiếng Việt: ${(dl / (1024 * 1024)).toFixed(1)} MB...`;
        });
        job.progress = 80;
        job.step = 'Đang giải nén mô hình giọng đọc Sherpa-ONNX...';
        await pyEnv.extractArchive(archivePath, ttsRoot);
      } else if (spec.archiveType === 'tar_bz2_separation') {
        const sepRoot = path.join(MODELS_DIR, 'separation');
        fs.mkdirSync(sepRoot, { recursive: true });
        const archivePath = path.join(tempDir, 'spleeter.tar.bz2');
        await downloadFileWithProgress(spec.downloadUrl, archivePath, (dl, total) => {
          job.downloadedBytes = dl;
          if (total > 0) job.progress = Math.min(80, 10 + Math.round((dl / total) * 70));
          job.step = `Đang tải mô hình tách giọng: ${(dl / (1024 * 1024)).toFixed(1)} MB...`;
        });
        job.step = 'Đang giải nén mô hình tách giọng...';
        await pyEnv.extractArchive(archivePath, sepRoot);
      } else if (spec.archiveType === 'diarization_models') {
        const diarDir = path.dirname(spec.targetPath);
        fs.mkdirSync(diarDir, { recursive: true });
        const segArchive = path.join(tempDir, 'seg.tar.bz2');
        job.step = 'Đang tải mô hình phân đoạn người nói (pyannote 3.0)...';
        await downloadFileWithProgress(
          'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
          segArchive,
          (dl) => {
            job.downloadedBytes = dl;
            job.progress = Math.min(35, 10 + Math.round(dl / (1024 * 1024)));
          }
        );
        await pyEnv.extractArchive(segArchive, diarDir);
        job.step = 'Đang tải mô hình đặc trưng giọng nói (3D-Speaker ERes2Net)...';
        await downloadFileWithProgress(
          'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
          spec.targetPath,
          (dl, total) => {
            job.downloadedBytes = dl;
            if (total > 0) job.progress = Math.min(85, 40 + Math.round((dl / total) * 45));
          }
        );
      } else if (spec.archiveType === 'ocr_models') {
        await installOcrModels(job);
      } else if (spec.archiveType === 'sensevoice_asr') {
        await installSenseVoice(job, tempDir);
      } else if (spec.archiveType === 'webview2_app') {
        await installWindowsApp(job);
      } else if (spec.archiveType === 'mlx_llm' || spec.archiveType === 'llamacpp_llm') {
        await installLocalLlm(job);
      } else if (spec.archiveType === 'vieneu_python') {
        await installVieneuEnvironment(job);
      } else if (spec.archiveType === 'argos_packages') {
        const argosRoot = path.join(MODELS_DIR, 'argos');
        fs.mkdirSync(argosRoot, { recursive: true });
        const pkgs = [
          {
            name: 'translate-zh_en-1_9',
            url: 'https://data.argosopentech.com/argospm/v1/translate-zh_en-1_9.argosmodel'
          },
          {
            name: 'translate-en_vi-1_9',
            url: 'https://data.argosopentech.com/argospm/v1/translate-en_vi-1_9.argosmodel'
          }
        ];
        for (let i = 0; i < pkgs.length; i++) {
          const pkg = pkgs[i];
          const zipFile = path.join(tempDir, `${pkg.name}.zip`);
          job.step = `Đang tải gói dịch Offline ${pkg.name} (${i + 1}/${pkgs.length})...`;
          await downloadFileWithProgress(pkg.url, zipFile, (dl, total) => {
            job.downloadedBytes = dl;
            if (total > 0) {
              job.progress = Math.min(78, 10 + i * 34 + Math.round((dl / total) * 30));
            }
          });
          await pyEnv.extractArchive(zipFile, argosRoot);
        }
      }

      // Bước kiểm tra tính toàn vẹn (SHA-256 + dung lượng + chạy thử nghiệm)
      job.progress = 90;
      job.step = `Đang kiểm tra tính toàn vẹn SHA-256 và khả năng chạy của ${spec.name}...`;
      const verification = await verifyInstalledToolOrModel(toolId);
      if (!verification.ok) {
        throw new Error(verification.error || 'Kiểm tra tính toàn vẹn sau khi tải thất bại.');
      }

      job.sha256 = verification.sha256;
      job.verifiedVersion = verification.version;
      job.progress = 100;
      job.status = 'completed';
      job.step = `Đã cài đặt và xác minh ${spec.name} thành công (${verification.version || 'Ready'})!`;

      // Làm mới bộ nhớ đệm Capabilities để giao diện cập nhật ngay
      invalidateCapabilitiesCache();
      triggerBackgroundCapabilitiesCheck(true);
    } catch (err) {
      job.status = 'error';
      job.error = err.message || 'Không thể tải hoặc cài đặt công cụ.';
      job.step = `Lỗi cài đặt ${spec.name}: ${job.error}`;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  })();

  return job;
}

/**
 * Cài AI dịch Local: .venv-llm (Python 3.12 qua uv) + mlx-lm, rồi tải model Qwen mặc định từ HuggingFace.
 */
async function installLocalLlm(job) {
  if (localLlm.BACKEND === 'llamacpp') return installLlamaCppLlm(job);
  job.progress = 10;
  await pyEnv.ensureLlmVenv((msg) => {
    job.step = msg;
  });
  const model = localLlm.LOCAL_LLM_MODELS[0];
  if (!localLlm.isModelInstalled(model.id)) {
    job.progress = 45;
    job.step = `Đang tải model ${model.label} (~${model.sizeGB} GB) từ HuggingFace...`;
    await pyEnv.run(
      localLlm.PYTHON_BIN,
      ['-c', `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(model.repo)}, local_dir=${JSON.stringify(path.join(localLlm.MODELS_DIR, model.id))})`],
      { env: pyEnv.uvEnv(), timeoutMs: 3 * 3600 * 1000 }
    );
  }
}

const psQuote = (p) => `'${String(p).replace(/'/g, "''")}'`;

/**
 * Chạy Windows PowerShell 5.1. Xóa PSModulePath kế thừa: nếu ứng dụng được mở từ PowerShell 7 (pwsh), biến này trỏ
 * tới module của bản 7 → PowerShell 5.1 không nạp được Microsoft.PowerShell.Security (Get-AuthenticodeSignature...).
 */
function runPowerShell(script, timeoutMs) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  return runShellCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeoutMs, env);
}

/** Tải bộ cài VC++ Redistributable chính thức (aka.ms của Microsoft) và xác minh chữ ký số Microsoft. */
async function downloadVerifiedVcRedist(onStep = () => {}) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const url = `https://aka.ms/vs/17/release/vc_redist.${arch}.exe`;
  const file = path.join(PROJECT_ROOT, 'bin', 'tools', `vc_redist.${arch}.exe`);
  await downloadFileWithProgress(url, file, (done, total) => {
    onStep(`Đang tải Microsoft Visual C++ Redistributable (${(done / 1048576).toFixed(0)}/${((total || 26e6) / 1048576).toFixed(0)} MB)...`);
  });
  const check =
    'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; ' +
    `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}; ` +
    "if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { Write-Output ('INVALID ' + $s.Status + ' ' + $s.SignerCertificate.Subject); exit 3 }; Write-Output 'VALID'";
  try {
    await runPowerShell(check, 60000);
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw new Error(`Bộ cài VC++ tải về không có chữ ký hợp lệ của Microsoft — đã xóa, không chạy. ${err.message.slice(0, 200)}`);
  }
  return file;
}

/**
 * llama.cpp bản Windows cần MSVCP140/VCRUNTIME140(_1).dll. Máy chưa có → tải bản chính thức của Microsoft,
 * kiểm chữ ký số rồi cài (Windows hỏi quyền quản trị 1 lần — người dùng đã bấm cài).
 */
async function ensureVcRedist(job) {
  if (process.platform !== 'win32' || localLlm.missingVcRuntime().length === 0) return;
  job.step = `Máy thiếu Microsoft Visual C++ Redistributable (${localLlm.missingVcRuntime().join(', ')}) — đang tải bản chính thức...`;
  const file = await downloadVerifiedVcRedist((m) => {
    job.step = m;
  });
  job.step = 'Đang cài Microsoft Visual C++ Redistributable — hãy bấm "Yes/Có" khi Windows hỏi quyền...';
  const install =
    `$p = Start-Process -FilePath ${psQuote(file)} -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  try {
    await runPowerShell(install, 15 * 60 * 1000);
  } catch (err) {
    // 3010 = cần khởi động lại, 1638 = đã có bản mới hơn — đều coi là thành công nếu DLL đã có
    if (localLlm.missingVcRuntime().length) {
      throw new Error(
        `Chưa cài được Microsoft Visual C++ Redistributable (có thể đã bấm "No" khi Windows hỏi quyền). Hãy cài thủ công: https://aka.ms/vs/17/release/vc_redist.${process.arch === 'arm64' ? 'arm64' : 'x64'}.exe rồi bấm cài lại. ${err.message.slice(0, 160)}`
      );
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
  if (localLlm.missingVcRuntime().length) {
    throw new Error(`Đã chạy bộ cài VC++ nhưng vẫn thiếu: ${localLlm.missingVcRuntime().join(', ')}. Khởi động lại máy rồi thử lại.`);
  }
}

/**
 * Windows: llama.cpp (bản chính thức đã ghim, kiểm SHA-256) + model GGUF Qwen3.5-9B Q4_K_M (kiểm SHA-256).
 * Không cần quyền Administrator, không cài gì vào hệ thống — tất cả nằm trong bin/.
 */
async function installLlamaCppLlm(job) {
  const lc = localLlm.LLAMA_CPP;
  if (!lc.asset) throw new Error(`Chưa có bản llama.cpp cho kiến trúc ${process.arch}.`);
  const qwenHome = require('./qwen_shared_home');
  // Đã có bản tải trước đây trong thư mục ứng dụng → chuyển sang thư mục dùng chung, không tải lại
  await qwenHome.migrateLegacy((msg) => {
    job.step = msg;
  });
  job.progress = 5;
  job.step = 'Kiểm tra môi trường Python lõi (dùng để tải model và giám sát máy chủ AI)...';
  await pyEnv.ensureCoreVenv((msg) => {
    job.step = msg;
  });

  await ensureVcRedist(job);

  if (!fs.existsSync(lc.serverBin)) {
    fs.mkdirSync(localLlm.QWEN_HOME, { recursive: true });
    const zip = path.join(localLlm.QWEN_HOME, `${lc.asset.name}.part`);
    job.progress = 10;
    await downloadFileWithProgress(lc.url, zip, (done, total) => {
      job.step = `Đang tải llama.cpp ${lc.build} (${(done / 1048576).toFixed(0)}/${((total || lc.asset.sizeMB * 1048576) / 1048576).toFixed(0)} MB)...`;
    });
    const sha = await computeFileSha256(zip);
    if (sha !== lc.asset.sha256) {
      fs.rmSync(zip, { force: true });
      throw new Error(`Mã SHA-256 của llama.cpp không khớp (nhận ${sha.slice(0, 16)}…) — đã hủy, không giải nén.`);
    }
    job.step = 'Đang giải nén llama.cpp...';
    fs.rmSync(lc.dir, { recursive: true, force: true });
    fs.mkdirSync(lc.dir, { recursive: true });
    await pyEnv.extractArchive(zip, lc.dir);
    fs.rmSync(zip, { force: true });
    if (!fs.existsSync(lc.serverBin)) throw new Error('Giải nén llama.cpp xong nhưng không thấy llama-server.exe.');
  }

  const model = localLlm.LOCAL_LLM_MODELS[0];
  if (!localLlm.isModelInstalled(model.id)) {
    const dir = path.dirname(localLlm.modelFilePath(model));
    fs.mkdirSync(dir, { recursive: true });
    job.progress = 15;
    job.step = `Đang tải model ${model.label} (~${model.sizeGB} GB) từ HuggingFace (tải tiếp được nếu bị ngắt)...`;
    const dlDir = path.join(dir, '.cache', 'huggingface', 'download');
    const timer = setInterval(() => {
      try {
        const part = fs.readdirSync(dlDir).filter((f) => f.endsWith('.incomplete')).map((f) => fs.statSync(path.join(dlDir, f)).size);
        const got = part.length ? Math.max(...part) : 0;
        if (got > 0) {
          job.progress = Math.min(94, 15 + Math.round((got / model.sizeBytes) * 79));
          job.step = `Đang tải model ${model.label}: ${(got / 1e9).toFixed(2)}/${(model.sizeBytes / 1e9).toFixed(2)} GB...`;
        }
      } catch (_) {}
    }, 2000);
    try {
      await pyEnv.run(
        localLlm.CORE_PYTHON,
        [
          '-c',
          `from huggingface_hub import hf_hub_download; hf_hub_download(${JSON.stringify(model.repo)}, ${JSON.stringify(model.file)}, revision=${JSON.stringify(model.revision)}, local_dir=${JSON.stringify(dir)})`
        ],
        { env: { ...pyEnv.uvEnv(), HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1', PYTHONUTF8: '1' }, timeoutMs: 6 * 3600 * 1000 }
      );
    } finally {
      clearInterval(timer);
    }
    job.progress = 95;
    job.step = 'Đang kiểm tra SHA-256 của model (5,7 GB, khoảng 10–60 giây)...';
    const file = path.join(dir, model.file);
    const sha = await computeFileSha256(file);
    if (sha !== model.sha256) {
      fs.rmSync(file, { force: true });
      throw new Error(`Mã SHA-256 của model không khớp (nhận ${sha.slice(0, 16)}…) — đã xóa file hỏng, hãy cài lại.`);
    }
    fs.rmSync(path.join(dir, '.cache'), { recursive: true, force: true });
  }
  job.step = `Đang ghi thông tin Qwen dùng chung (${localLlm.QWEN_HOME}) và tạo lối tắt "Qwen Local"...`;
  const sh = await qwenHome.ensureSharedHome((msg) => {
    job.step = msg;
  });
  if (!sh.ok) throw new Error(`Đã tải Qwen nhưng chưa ghi được thư mục dùng chung: ${sh.error || 'thiếu file'}`);
}

async function verifyLocalLlm() {
  const st = localLlm.getStatus();
  if (!st.runtimeInstalled) return { ok: false, error: st.backend === 'llamacpp' ? 'Chưa cài llama.cpp (llama-server.exe) hoặc môi trường Python lõi.' : 'Chưa cài môi trường .venv-llm (mlx-lm).' };
  const installed = st.models.filter((m) => m.installed);
  if (installed.length === 0) return { ok: false, error: 'Chưa tải model Qwen nào.' };
  try {
    const rt = await localLlm.ensureRunning(installed[0].id);
    // Dịch thử 1 câu thật để chắc chắn model chạy được trên máy này (không chỉ khởi động máy chủ)
    const t0 = Date.now();
    const r = await fetch(`${rt.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: rt.modelPath,
        temperature: 0.2,
        max_tokens: 64,
        messages: [
          { role: 'system', content: 'Dịch câu tiếng Trung sang tiếng Việt. Chỉ trả về bản dịch.' },
          { role: 'user', content: '大家好，欢迎来到我的频道。' }
        ]
      }),
      signal: AbortSignal.timeout(600000)
    });
    const j = await r.json().catch(() => ({}));
    const text = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();
    localLlm.stop();
    if (!r.ok || !text) return { ok: false, error: `AI Local khởi động được nhưng không dịch được (HTTP ${r.status}): ${JSON.stringify(j).slice(0, 200)}` };
    return {
      ok: true,
      sha256: null,
      sizeBytes: 0,
      version: `${installed.map((m) => m.label).join(', ')} — dịch thử: "${text.slice(0, 60)}" (${((Date.now() - t0) / 1000).toFixed(1)} s)`
    };
  } catch (err) {
    return { ok: false, error: `Không khởi động được AI Local: ${err.message}` };
  }
}

/**
 * Cài VieNeu-TTS: uv -> Python 3.12 (python-build-standalone) -> .venv-vieneu -> pip install vieneu -> tải mô hình.
 * Mọi bước hiển thị trạng thái cho người dùng; cache tải xuống được dọn sau khi cài.
 */
async function installVieneuEnvironment(job) {
  job.progress = 10;
  await pyEnv.ensureVieneuVenv((msg) => {
    job.step = msg;
  });
  if (!vieneuService.isSdkInstalled()) throw new Error('Cài SDK VieNeu-TTS không thành công.');
  job.progress = 65;
  job.step = 'Đang tải mô hình VieNeu-TTS v3 Turbo từ HuggingFace (~581 MB, chỉ lần đầu)...';
  await vieneuService.downloadModel();
  vieneuService.stop();
}

function getToolInstallJob(jobId) {
  return activeInstallJobs.get(jobId) || null;
}

/* ------------------------------------------------------------------------------------------------
 * GỠ CÀI ĐẶT công cụ / model để giải phóng dung lượng (nút "🗑️ Xóa" trong app)
 * - Chỉ xóa đúng thư mục/file của thành phần, và chỉ trong thư mục ứng dụng (hoặc thư mục Qwen dùng chung).
 * - yt-dlp / FFmpeg là công cụ BẮT BUỘC: vẫn xóa được nhưng kèm cảnh báo đỏ + khuyến nghị không nên xóa (critical).
 * - Môi trường Python: chỉ xóa được khi không còn thành phần AI nào dùng tới.
 * - Qwen dùng chung trên Windows: nếu ứng dụng khác còn dùng thì chỉ gỡ khỏi app này, KHÔNG xóa file.
 * ------------------------------------------------------------------------------------------------ */
const CRITICAL_TOOLS = {
  ytdlp: 'KHÔNG KHUYẾN NGHỊ XÓA: yt-dlp là công cụ bắt buộc — xóa đi sẽ không tải được video Bilibili, YouTube, Youku, WeTV… và không tải hàng loạt được.',
  ffmpeg: 'KHÔNG KHUYẾN NGHỊ XÓA: FFmpeg là công cụ bắt buộc để ghép hình + tiếng, chuyển định dạng và xuất video lồng tiếng.'
};
const PY_DEPENDENTS = ['localAsrSenseVoice', 'localAsrSmall', 'subtitleOcr', 'speakerDiarization', 'voiceSeparation', 'localTts'];

function dirSizeBytes(p) {
  let total = 0;
  const walk = (q) => {
    let st;
    try {
      st = fs.lstatSync(q);
    } catch (_) {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names = [];
      try {
        names = fs.readdirSync(q);
      } catch (_) {}
      for (const n of names) walk(path.join(q, n));
    } else total += st.size;
  };
  walk(p);
  return total;
}

function isInside(child, parent) {
  if (!parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readQwenManifest() {
  try {
    return localLlm.QWEN_MANIFEST ? JSON.parse(fs.readFileSync(localLlm.QWEN_MANIFEST, 'utf8')) : null;
  } catch (_) {
    return null;
  }
}

/** Kế hoạch gỡ 1 thành phần: đường dẫn sẽ xóa, dung lượng giải phóng, cảnh báo, hoặc lý do không cho xóa. */
function getUninstallPlan(toolId) {
  const catalog = getInstallableToolsCatalogRaw();
  const item = catalog.find((t) => t.id === toolId);
  if (!item) return { ok: false, error: `Không có thành phần "${toolId}".` };
  const paths = [];
  const warnings = [];
  let keepSharedFiles = false;
  const critical = Boolean(CRITICAL_TOOLS[toolId]);
  if (critical) warnings.push(CRITICAL_TOOLS[toolId]);
  switch (toolId) {
    case 'ytdlp':
      paths.push(item.targetPath);
      break;
    case 'ffmpeg': {
      // Bản dự phòng trong bin/; bản đi kèm ứng dụng (npm ffmpeg-static) nằm trong node_modules — không xóa
      const binFf = resolveOfficialToolSource('ffmpeg').targetPath;
      paths.push(binFf);
      if (!fs.existsSync(binFf)) return { ok: false, error: 'Không có gì để xóa: FFmpeg đang dùng bản đi kèm ứng dụng (node_modules/ffmpeg-static), không phải bản tải thêm.' };
      if (item.activePath && path.resolve(item.activePath) !== path.resolve(binFf)) {
        // App đang dùng bản đi kèm (ffmpeg-static) → bin/ffmpeg chỉ là bản dự phòng, xóa không ảnh hưởng
        warnings.length = 0;
        warnings.push('Đây là bản FFmpeg DỰ PHÒNG trong bin/. Ứng dụng đang dùng bản đi kèm (node_modules/ffmpeg-static) nên xóa không ảnh hưởng chức năng.');
        return finishPlan(item, paths, warnings, false, false);
      }
      break;
    }
    case 'webkitSniffer':
      paths.push(item.targetPath);
      warnings.push('Sau khi xóa sẽ không tải/quét được Douyin, Kuaishou, Xiaohongshu cho tới khi cài lại.');
      break;
    case 'localAsrSenseVoice':
      paths.push(SENSEVOICE_DIR);
      if (!catalog.some((t) => t.id === 'localAsrSmall' && t.installed)) warnings.push('"Phân đoạn & Dịch" sẽ chỉ dùng được với video có phụ đề in sẵn (OCR) cho tới khi cài lại.');
      break;
    case 'localAsrSmall':
      paths.push(path.dirname(item.targetPath));
      if (!catalog.some((t) => t.id === 'localAsrSenseVoice' && t.installed)) warnings.push('"Phân đoạn & Dịch" sẽ chỉ dùng được với video có phụ đề in sẵn (OCR) cho tới khi cài lại.');
      else warnings.push('Đã có SenseVoiceSmall nên nhận dạng giọng nói vẫn chạy bình thường (tiếng Anh cũng dùng SenseVoice).');
      break;
    case 'subtitleOcr':
      paths.push(OCR_MODELS_DIR);
      break;
    case 'speakerDiarization':
      paths.push(path.join(MODELS_DIR, 'diarization'));
      break;
    case 'voiceSeparation':
      paths.push(path.join(MODELS_DIR, 'separation'));
      break;
    case 'localTts':
      paths.push(path.join(MODELS_DIR, 'tts'));
      break;
    case 'vieneuTts':
      paths.push(path.join(PROJECT_ROOT, '.venv-vieneu'), path.join(MODELS_DIR, 'vieneu-hf'));
      warnings.push('Giọng đọc mặc định Ngọc Huyền (VieNeu) sẽ không còn; app dùng giọng Piper/hệ điều hành nếu có.');
      break;
    case 'windowsApp':
      paths.push(WINDOWS_APP_EXE, `${WINDOWS_APP_EXE}.config`, WINDOWS_APP_DIR);
      warnings.push('Lối tắt Desktop sẽ quay về mở app bằng trình duyệt (Start_App_Windows.bat).');
      break;
    case 'pythonCore': {
      const deps = catalog.filter((t) => PY_DEPENDENTS.includes(t.id) && t.installed).map((t) => t.name);
      if (deps.length) return { ok: false, error: `Còn thành phần đang dùng Môi trường Python: ${deps.join(', ')}. Hãy xóa các thành phần đó trước.` };
      paths.push(path.join(PROJECT_ROOT, '.venv'));
      break;
    }
    case 'localLlmQwen':
      if (localLlm.BACKEND === 'llamacpp') {
        const home = localLlm.QWEN_HOME;
        const man = readQwenManifest();
        const others = ((man && man.usedBy) || []).filter((u) => path.resolve(u).toLowerCase() !== path.resolve(PROJECT_ROOT).toLowerCase());
        paths.push(path.join(PROJECT_ROOT, 'Qwen Local.lnk'));
        if (others.length) {
          keepSharedFiles = true;
          warnings.push(`Qwen dùng chung còn được ứng dụng khác dùng (${others.join('; ')}) — chỉ gỡ khỏi app này, KHÔNG xóa file model.`);
        } else if (home) {
          paths.push(home);
          if (localLlm.QWEN_DEFAULT_HOME && path.resolve(localLlm.QWEN_DEFAULT_HOME).toLowerCase() !== path.resolve(home).toLowerCase()) {
            paths.push(path.join(localLlm.QWEN_DEFAULT_HOME, 'qwen-local.json'));
          }
        }
      } else {
        paths.push(path.join(PROJECT_ROOT, '.venv-llm'), localLlm.MODELS_DIR);
      }
      warnings.push('Dịch bằng AI Local sẽ không còn — dùng AI API (ChatGPT/Gemini) để dịch.');
      break;
    default:
      return { ok: false, error: 'Thành phần này chưa hỗ trợ xóa.' };
  }
  return finishPlan(item, paths, warnings, critical, keepSharedFiles);
}

function finishPlan(item, paths, warnings, critical, keepSharedFiles) {
  const toolId = item.id;
  const allowedRoots = [PROJECT_ROOT, localLlm.QWEN_HOME, localLlm.QWEN_DEFAULT_HOME].filter(Boolean);
  const existing = paths.filter((p) => fs.existsSync(p));
  for (const p of existing) {
    const ok = allowedRoots.some((r) => isInside(p, r) || path.resolve(p) === path.resolve(r)) && path.resolve(p) !== path.resolve(PROJECT_ROOT);
    if (!ok) return { ok: false, error: `Từ chối xóa đường dẫn ngoài thư mục ứng dụng: ${p}` };
  }
  const sizeBytes = existing.reduce((a, p) => a + dirSizeBytes(p), 0);
  if (existing.length === 0) return { ok: false, error: 'Thành phần chưa được cài — không có gì để xóa.' };
  return { ok: true, toolId, name: item.name, installed: item.installed, critical, paths: existing, sizeBytes, warnings, keepSharedFiles };
}

/** Xóa thật (người dùng đã xác nhận trong app). Trả về dung lượng đã giải phóng. */
function uninstallTool(toolId, { confirmCritical = false } = {}) {
  const plan = getUninstallPlan(toolId);
  if (plan.ok && plan.critical && !confirmCritical) {
    const e = new Error(plan.warnings[0]);
    e.code = 'CRITICAL_CONFIRM_REQUIRED';
    throw e;
  }
  if (!plan.ok) {
    const e = new Error(plan.error);
    e.code = 'NOT_REMOVABLE';
    throw e;
  }
  if (activeInstallJobs && Array.from(activeInstallJobs.values()).some((j) => j.toolId === toolId && j.status === 'running')) {
    throw new Error('Thành phần này đang được cài đặt — hãy đợi cài xong rồi xóa.');
  }
  // Dừng tiến trình đang giữ file (máy chủ Qwen, VieNeu) trước khi xóa — Windows không cho xóa file đang mở
  try {
    if (toolId === 'localLlmQwen') localLlm.stop();
    if (toolId === 'vieneuTts') vieneuService.stop();
  } catch (_) {}
  if (toolId === 'localLlmQwen' && plan.keepSharedFiles) {
    try {
      const man = readQwenManifest();
      if (man && Array.isArray(man.usedBy)) {
        man.usedBy = man.usedBy.filter((u) => path.resolve(u).toLowerCase() !== path.resolve(PROJECT_ROOT).toLowerCase());
        fs.writeFileSync(localLlm.QWEN_MANIFEST, JSON.stringify(man, null, 2), 'utf8');
      }
    } catch (_) {}
  }
  const failed = [];
  for (const p of plan.paths) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch (err) {
      failed.push(`${p}: ${err.code || err.message}`);
    }
  }
  // Ghi nhận người dùng không muốn thành phần này → cài đặt Terminal (setup) không hỏi lại
  try {
    const guide = require('./component_guide');
    const c = guide.loadChoices();
    guide.saveChoices({ declined: [...c.declined, toolId] });
  } catch (_) {}
  if (failed.length) {
    const e = new Error(`Không xóa hết được (file đang được dùng?): ${failed.join(' | ')}. Hãy đóng các tác vụ đang chạy rồi thử lại.`);
    e.code = 'PARTIAL';
    throw e;
  }
  return { toolId, name: plan.name, freedBytes: plan.sizeBytes, removed: plan.paths, warnings: plan.warnings };
}

module.exports = {
  isOcrEnInstalled,
  isSenseVoiceInstalled,
  SENSEVOICE_DIR,
  getUninstallPlan,
  uninstallTool,
  isOcrInstalled,
  OCR_MODELS_DIR,
  _internals: { downloadVerifiedVcRedist },
  resolveOfficialToolSource,
  getInstallableToolsCatalog,
  verifyInstalledToolOrModel,
  startToolInstallJob,
  getToolInstallJob,
  computeFileSha256
};

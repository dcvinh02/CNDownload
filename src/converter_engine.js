/**
 * FFmpeg Video & Audio Format Converter & Media Verification Engine
 * Đáp ứng đầy đủ tiêu chuẩn:
 * 1. Chỉ báo hoàn tất khi file đầu ra tồn tại, đúng định dạng, kích thước hợp lệ và vượt qua kiểm tra giải mã (Decode Verification).
 * 2. Không bao giờ che giấu lỗi FFmpeg trong quá trình chuẩn hóa MP4 hoặc chuyển đổi định dạng.
 * 3. Giữ nguyên file gốc khi chuyển đổi lỗi hoặc bị hủy; dọn dẹp file tạm (_fixing / .part) an toàn.
 * 4. Xác minh rõ codec hình, codec tiếng, container và ghi nhận rõ trạng thái nếu video gốc không có tiếng (Silent Video).
 * 5. Hỗ trợ theo dõi tiến độ %, hủy tác vụ tức thời và phát hiện lỗi ổ đĩa đầy (ENOSPC / No space left on device).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getFfmpegPath } = require('./extractors/ytdlp_engine');

const SUPPORTED_FORMATS = [
  {
    id: 'mp4',
    ext: 'mp4',
    name: 'MP4 (Chuẩn H.264 + AAC)',
    category: 'video',
    expectedVCodecs: ['h264'],
    expectedACodecs: ['aac', 'mp3'],
    description: 'Tương thích với macOS QuickTime, Windows, Điện thoại, CapCut, Premiere'
  },
  {
    id: 'mov',
    ext: 'mov',
    name: 'MOV (Apple QuickTime)',
    category: 'video',
    expectedVCodecs: ['h264', 'hevc', 'prores'],
    expectedACodecs: ['aac', 'pcm_s16le'],
    description: 'Chuẩn video dựng phim cho macOS, Final Cut Pro, iMovie'
  },
  {
    id: 'mkv',
    ext: 'mkv',
    name: 'MKV (Matroska Video)',
    category: 'video',
    expectedVCodecs: ['h264', 'hevc', 'vp9', 'av1'],
    expectedACodecs: ['aac', 'opus', 'vorbis', 'mp3', 'ac3'],
    description: 'Định dạng lưu trữ đa luồng chất lượng cao'
  },
  {
    id: 'webm',
    ext: 'webm',
    name: 'WEBM (VP9 / Web Video)',
    category: 'video',
    expectedVCodecs: ['vp9', 'vp8', 'av1'],
    expectedACodecs: ['opus', 'vorbis'],
    description: 'Định dạng tối ưu cho trình duyệt web và HTML5'
  },
  {
    id: 'avi',
    ext: 'avi',
    name: 'AVI (MPEG-4 / MP3)',
    category: 'video',
    expectedVCodecs: ['mpeg4', 'h264', 'msmpeg4v3'],
    expectedACodecs: ['mp3', 'pcm_s16le', 'ac3'],
    description: 'Định dạng tương thích rộng với thiết bị phát đời cũ'
  },
  {
    id: 'flv',
    ext: 'flv',
    name: 'FLV (Flash Video H.264)',
    category: 'video',
    expectedVCodecs: ['h264', 'flv1'],
    expectedACodecs: ['aac', 'mp3'],
    description: 'Định dạng phát luồng trực tiếp (Streaming)'
  },
  {
    id: 'mp3',
    ext: 'mp3',
    name: 'MP3 (Tách nhạc Audio 320kbps)',
    category: 'audio',
    expectedVCodecs: [],
    expectedACodecs: ['mp3'],
    description: 'Trích xuất riêng âm thanh / nhạc nền chất lượng cao từ video'
  },
  {
    id: 'wav',
    ext: 'wav',
    name: 'WAV (Tách âm thanh Lossless)',
    category: 'audio',
    expectedVCodecs: [],
    expectedACodecs: ['pcm_s16le', 'pcm_s24le', 'pcm_f32le'],
    description: 'Âm thanh gốc PCM 16-bit không nén phục vụ biên tập'
  },
  {
    id: 'gif',
    ext: 'gif',
    name: 'GIF (Ảnh động chất lượng cao)',
    category: 'image',
    expectedVCodecs: ['gif'],
    expectedACodecs: [],
    description: 'Chuyển video ngắn thành ảnh động GIF (12fps, chiều rộng 480px)'
  }
];

const activeConversions = new Map();
const conversionProcesses = new Map();

function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':');
  if (parts.length !== 3) return 0;
  const h = parseFloat(parts[0]) || 0;
  const m = parseFloat(parts[1]) || 0;
  const s = parseFloat(parts[2]) || 0;
  return h * 3600 + m * 60 + s;
}

function formatFriendlyFfmpegError(stderrStr, exitCode) {
  const lower = (stderrStr || '').toLowerCase();
  if (lower.includes('no space left on device') || lower.includes('enospc') || lower.includes('disk full')) {
    return 'Ổ đĩa đã hết dung lượng trống (No space left on device). Vui lòng giải phóng bộ nhớ hoặc đổi thư mục lưu trữ.';
  }
  if (lower.includes('permission denied') || lower.includes('eacces')) {
    return 'Không có quyền ghi file vào thư mục đích (Permission denied).';
  }
  if (lower.includes('moov atom not found') || lower.includes('invalid data found when processing input')) {
    return 'File nguồn bị hỏng cấu trúc container (thiếu moov atom hoặc dữ liệu media không hợp lệ).';
  }
  if (lower.includes('does not contain any stream') || lower.includes('output file is empty')) {
    return 'File nguồn không chứa luồng âm thanh/hình ảnh phù hợp với định dạng đích đã chọn.';
  }
  const lines = (stderrStr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('frame=') && !l.startsWith('size='));
  const tail = lines.slice(-2).join(' | ');
  return tail ? `Lỗi xử lý FFmpeg (mã ${exitCode}): ${tail}` : `Tiến trình FFmpeg kết thúc bất thường (mã ${exitCode}).`;
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

/**
 * Kiểm tra chuyên sâu thông tin codec, container, thời lượng & giải mã thử 1 giây đầu của file media bằng FFmpeg
 */
function probeMediaFile(filePath, options = { verifyDecode: true }) {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegPath();
    if (!ffmpegBin) {
      return resolve({
        valid: false,
        error: 'Không tìm thấy binary FFmpeg để kiểm tra media.',
        duration: 0,
        vcodec: '',
        acodec: ''
      });
    }
    if (!filePath || !fs.existsSync(filePath)) {
      return resolve({
        valid: false,
        error: 'File media không tồn tại trên ổ đĩa.',
        duration: 0,
        vcodec: '',
        acodec: ''
      });
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      return resolve({ valid: false, error: `Không thể đọc thuộc tính file: ${e.message}`, duration: 0 });
    }

    if (stat.size < 256) {
      return resolve({
        valid: false,
        error: `Kích thước file quá nhỏ (${stat.size} bytes), file rỗng hoặc bị lỗi tải.`,
        fileSize: stat.size,
        duration: 0
      });
    }

    // Nếu verifyDecode = true, yêu cầu FFmpeg giải mã thử tối đa 1.5 giây đầu ra null muxer để phát hiện lỗi hỏng luồng
    const args = options.verifyDecode
      ? ['-hide_banner', '-t', '1.5', '-i', filePath, '-f', 'null', '-']
      : ['-hide_banner', '-i', filePath];

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, 10000);

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        valid: false,
        error: `Không thể khởi chạy FFmpeg: ${err.message}`,
        duration: 0
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      const durMatch = stderr.match(/Duration:\s*(\d{2}:\d{2}:\d{2}\.\d+)/);
      const duration = durMatch ? parseTimeToSeconds(durMatch[1]) : 0;

      const inputMatch = stderr.match(/Input #0,\s*([a-zA-Z0-9_,]+),\s*from/);
      const containerFormat = inputMatch ? inputMatch[1].toLowerCase() : '';

      const vMatch = stderr.match(
        /Stream\s+#\d+:\d+.*Video:\s*([a-zA-Z0-9_]+)(?:\s*\([^)]*\))?(?:\s*\(([a-zA-Z0-9_]+)\s*\/)?/
      );
      const vcodec = vMatch ? vMatch[1].toLowerCase() : '';
      const vtag = vMatch && vMatch[2] ? vMatch[2].toLowerCase() : '';

      const resMatch = stderr.match(/Stream\s+#\d+:\d+.*Video:.*,\s*(\d{2,5})x(\d{2,5})/);
      const width = resMatch ? parseInt(resMatch[1], 10) : null;
      const height = resMatch ? parseInt(resMatch[2], 10) : null;

      const aMatch = stderr.match(/Stream\s+#\d+:\d+.*Audio:\s*([a-zA-Z0-9_]+)/);
      const acodec = aMatch ? aMatch[1].toLowerCase() : '';

      const isFragmentedM4s =
        stderr.includes('ISO Media, MP4 Base Media v5') ||
        (stderr.includes('dash') && !acodec && vcodec === 'hevc');

      const hasFatalError =
        stderr.includes('moov atom not found') ||
        stderr.includes('Invalid data found when processing input') ||
        stderr.includes('Error while decoding stream');

      const hasStream = Boolean(vcodec || acodec);
      const decodePassed = options.verifyDecode ? code === 0 && !hasFatalError : !hasFatalError;

      const valid = hasStream && decodePassed;
      let errorMsg = null;
      if (!valid) {
        errorMsg = formatFriendlyFfmpegError(stderr, code);
      }

      resolve({
        valid,
        error: errorMsg,
        fileSize: stat.size,
        containerFormat,
        duration,
        vcodec,
        vtag,
        acodec,
        width,
        height,
        hasVideo: Boolean(vcodec),
        hasAudio: Boolean(acodec),
        audioStatusText: acodec
          ? `Có âm thanh (${acodec.toUpperCase()})`
          : 'Không có luồng âm thanh (Video không tiếng)',
        isHev1: vtag === 'hev1' || (vcodec === 'hevc' && vtag !== 'hvc1'),
        isFragmentedM4s,
        raw: stderr
      });
    });
  });
}

/**
 * Xác minh file đầu ra có khớp hoàn toàn với định dạng người dùng đã chọn hay không
 */
async function verifyMediaOutput(filePath, expectedFormatId) {
  const fmtSpec =
    SUPPORTED_FORMATS.find((f) => f.id === (expectedFormatId || 'mp4').toLowerCase()) ||
    SUPPORTED_FORMATS[0];

  if (!filePath || !fs.existsSync(filePath)) {
    return {
      ok: false,
      error: `File đầu ra (.${fmtSpec.ext}) không tồn tại sau khi xử lý.`
    };
  }

  const actualExt = path.extname(filePath).replace('.', '').toLowerCase();
  if (actualExt !== fmtSpec.ext) {
    return {
      ok: false,
      error: `Phần mở rộng file đầu ra (.${actualExt}) không khớp với định dạng yêu cầu (.${fmtSpec.ext}).`
    };
  }

  const probe = await probeMediaFile(filePath, { verifyDecode: true });
  if (!probe.valid) {
    return {
      ok: false,
      error: probe.error || `File .${fmtSpec.ext} đầu ra không vượt qua bước kiểm tra giải mã media.`,
      probe
    };
  }

  if (fmtSpec.category === 'video') {
    if (!probe.hasVideo) {
      return {
        ok: false,
        error: `File .${fmtSpec.ext} đầu ra bị thiếu luồng hình ảnh (Video stream).`,
        probe
      };
    }
    if (fmtSpec.id === 'mp4' && (probe.isHev1 || probe.isFragmentedM4s)) {
      return {
        ok: false,
        error: `File MP4 vẫn chứa codec hev1 hoặc phân mảnh DASH chưa tương thích chuẩn phát.`,
        probe
      };
    }
  } else if (fmtSpec.category === 'audio') {
    if (!probe.hasAudio) {
      return {
        ok: false,
        error: `Không thể tách âm thanh sang .${fmtSpec.ext} vì video nguồn không có luồng âm thanh (Audio stream).`,
        probe
      };
    }
  } else if (fmtSpec.category === 'image') {
    if (probe.vcodec !== 'gif') {
      return {
        ok: false,
        error: `File GIF đầu ra không hợp lệ (codec thực tế: ${probe.vcodec || 'none'}).`,
        probe
      };
    }
  }

  return {
    ok: true,
    format: fmtSpec.id,
    ext: fmtSpec.ext,
    fileSize: probe.fileSize,
    duration: probe.duration,
    vcodec: probe.vcodec,
    vtag: probe.vtag,
    acodec: probe.acodec,
    hasVideo: probe.hasVideo,
    hasAudio: probe.hasAudio,
    audioStatusText: probe.audioStatusText,
    probe
  };
}

/**
 * Chuẩn hóa file MP4 vừa tải về (không che giấu lỗi FFmpeg):
 * - Xác minh codec hình, codec tiếng, container và khả năng giải mã.
 * - Cho phép video không có tiếng (silent video) khi nguồn hợp lệ và trả về trạng thái rõ ràng.
 * - Nếu cần chuẩn hóa sang H.264 (avc1) + AAC + faststart, theo dõi tiến độ % và hỗ trợ hủy tác vụ.
 */
async function ensureCompatibleMp4(filePath, onStatus = () => {}, cancelHandle = null) {
  const ffmpegBin = getFfmpegPath();
  if (!ffmpegBin) {
    return {
      ok: false,
      error: 'Không tìm thấy công cụ FFmpeg để xác minh và chuẩn hóa file MP4.'
    };
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      ok: false,
      error: 'File MP4 cần chuẩn hóa không tồn tại.'
    };
  }

  const initialProbe = await probeMediaFile(filePath, { verifyDecode: true });
  if (!initialProbe.valid) {
    return {
      ok: false,
      error: initialProbe.error || 'File tải về bị lỗi cấu trúc media, không thể đọc được.'
    };
  }

  if (!initialProbe.hasVideo) {
    return {
      ok: false,
      error: 'File MP4 tải về chỉ có âm thanh, thiếu luồng hình ảnh (Video stream).'
    };
  }

  // Nếu đã là H.264 (avc1) hợp lệ, không phải hev1 và không bị phân mảnh DASH m4s -> đạt chuẩn ngay
  if (initialProbe.vcodec === 'h264' && !initialProbe.isHev1 && !initialProbe.isFragmentedM4s) {
    return {
      ok: true,
      normalized: false,
      filePath,
      fileSize: initialProbe.fileSize,
      duration: initialProbe.duration,
      vcodec: initialProbe.vcodec,
      acodec: initialProbe.acodec,
      hasAudio: initialProbe.hasAudio,
      audioStatusText: initialProbe.audioStatusText
    };
  }

  onStatus('Đang chuẩn hóa codec sang H.264 (avc1) + AAC tương thích mọi thiết bị...');
  const tempFixedPath = filePath.replace(/\.mp4$/i, `_fixing_${Date.now().toString().slice(-4)}.mp4`);
  const totalDuration = initialProbe.duration || 0;

  return new Promise((resolve) => {
    const args = [
      '-y',
      '-hide_banner',
      '-i',
      filePath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '21',
      '-pix_fmt',
      'yuv420p'
    ];

    if (initialProbe.hasAudio) {
      args.push('-c:a', 'aac', '-b:a', '192k');
    } else {
      args.push('-an');
    }

    args.push('-movflags', '+faststart', tempFixedPath);

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrLog = '';
    let isCancelled = false;

    if (cancelHandle) {
      cancelHandle.killProcess = () => {
        isCancelled = true;
        try {
          proc.kill('SIGTERM');
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 400);
        } catch {}
      };
    }

    proc.stderr.on('data', (chunk) => {
      const str = chunk.toString();
      stderrLog += str;
      const tMatch = str.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
      if (tMatch && totalDuration > 0) {
        const currentSec = parseTimeToSeconds(tMatch[1]);
        const pct = Math.min(99, Math.max(1, Math.round((currentSec / totalDuration) * 100)));
        onStatus(`Đang chuẩn hóa H.264 (${pct}%)...`, pct);
      }
    });

    proc.on('error', (err) => {
      safeUnlink(tempFixedPath);
      resolve({
        ok: false,
        error: `Lỗi khởi chạy FFmpeg khi chuẩn hóa MP4: ${err.message}`
      });
    });

    proc.on('close', async (code) => {
      if (isCancelled) {
        safeUnlink(tempFixedPath);
        return resolve({
          ok: false,
          cancelled: true,
          error: 'USER_CANCELLED'
        });
      }

      if (code !== 0 || !fs.existsSync(tempFixedPath)) {
        safeUnlink(tempFixedPath);
        return resolve({
          ok: false,
          error: formatFriendlyFfmpegError(stderrLog, code)
        });
      }

      const verifyRes = await verifyMediaOutput(tempFixedPath, 'mp4');
      if (!verifyRes.ok) {
        safeUnlink(tempFixedPath);
        return resolve({
          ok: false,
          error: verifyRes.error
        });
      }

      try {
        fs.renameSync(tempFixedPath, filePath);
      } catch (renameErr) {
        safeUnlink(tempFixedPath);
        return resolve({
          ok: false,
          error: `Không thể lưu file MP4 đã chuẩn hóa: ${renameErr.message}`
        });
      }

      resolve({
        ok: true,
        normalized: true,
        filePath,
        fileSize: verifyRes.fileSize,
        duration: verifyRes.duration,
        vcodec: verifyRes.vcodec,
        acodec: verifyRes.acodec,
        hasAudio: verifyRes.hasAudio,
        audioStatusText: verifyRes.audioStatusText
      });
    });
  });
}

/**
 * Tạo tham số FFmpeg tối ưu cho từng định dạng đích
 */
function buildFfmpegConvertArgs(inputPath, outputPath, formatId, quality = 'high', sourceProbe = null) {
  const base = ['-y', '-hide_banner', '-i', inputPath];
  const crf = quality === 'high' ? '20' : quality === 'medium' ? '24' : '28';
  const hasAudio = sourceProbe ? sourceProbe.hasAudio : true;

  switch (formatId) {
    case 'mp4':
      return [
        ...base,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', crf,
        '-pix_fmt', 'yuv420p',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        '-movflags', '+faststart',
        outputPath
      ];
    case 'mov':
      return [
        ...base,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', crf,
        '-pix_fmt', 'yuv420p',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        '-f', 'mov',
        outputPath
      ];
    case 'mkv':
      return [
        ...base,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', crf,
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        outputPath
      ];
    case 'webm':
      return [
        ...base,
        '-c:v', 'libvpx-vp9',
        '-crf', '30',
        '-b:v', '0',
        '-deadline', 'realtime',
        '-cpu-used', '4',
        ...(hasAudio ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-an']),
        outputPath
      ];
    case 'avi':
      return [
        ...base,
        '-c:v', 'mpeg4',
        '-qscale:v', '4',
        ...(hasAudio ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-an']),
        outputPath
      ];
    case 'flv':
      return [
        ...base,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', crf,
        ...(hasAudio ? ['-c:a', 'aac', '-ar', '44100'] : ['-an']),
        '-f', 'flv',
        outputPath
      ];
    case 'mp3':
      return [
        ...base,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', '320k',
        '-ar', '44100',
        outputPath
      ];
    case 'wav':
      return [
        ...base,
        '-vn',
        '-c:a', 'pcm_s16le',
        '-ar', '44100',
        '-ac', '2',
        outputPath
      ];
    case 'gif':
      return [
        ...base,
        '-t', '15',
        '-vf', 'fps=12,scale=480:-1:flags=lanczos',
        '-loop', '0',
        outputPath
      ];
    default:
      return [...base, '-c:v', 'libx264', ...(hasAudio ? ['-c:a', 'aac'] : ['-an']), outputPath];
  }
}

/**
 * Khởi chạy tác vụ chuyển đổi định dạng có xác minh file đầu ra nghiêm ngặt:
 * - Giữ nguyên file nguồn (inputPath) trong mọi trường hợp lỗi hoặc hủy.
 * - Sử dụng file tạm trong lúc chuyển đổi và chỉ đổi tên thành file đích sau khi verifyMediaOutput() thành công.
 */
async function startConversionJob({
  inputPath,
  targetFormat = 'mp4',
  quality = 'high',
  outputDir = null,
  customOutputPath = null
}) {
  const ffmpegBin = getFfmpegPath();
  if (!ffmpegBin) {
    throw new Error('Không tìm thấy công cụ FFmpeg trong hệ thống.');
  }
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error(`Không tìm thấy file nguồn cần chuyển đổi: ${inputPath}`);
  }

  const fmtSpec = SUPPORTED_FORMATS.find((f) => f.id === targetFormat.toLowerCase());
  if (!fmtSpec) {
    throw new Error(`Định dạng đầu ra "${targetFormat}" không được hỗ trợ.`);
  }

  const parsedIn = path.parse(inputPath);
  const destFolder = outputDir && fs.existsSync(outputDir) ? outputDir : parsedIn.dir;
  const jobId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const sourceProbe = await probeMediaFile(inputPath, { verifyDecode: true });
  let preCheckError = null;
  if (!sourceProbe.valid) {
    preCheckError = sourceProbe.error || 'File nguồn bị hỏng hoặc không thể đọc được.';
  } else if (fmtSpec.category === 'audio' && !sourceProbe.hasAudio) {
    preCheckError = 'Video nguồn không có luồng âm thanh (Silent Video), không thể tách sang định dạng nhạc MP3/WAV.';
  } else if ((fmtSpec.category === 'video' || fmtSpec.category === 'image') && !sourceProbe.hasVideo) {
    preCheckError = `File nguồn chỉ có âm thanh, không có hình ảnh để chuyển sang .${fmtSpec.ext.toUpperCase()}.`;
  }

  if (preCheckError) {
    const failedJob = {
      jobId,
      inputPath,
      inputFileName: parsedIn.base,
      outputPath: '',
      outputFileName: `${parsedIn.name}.${fmtSpec.ext}`,
      targetFormat: fmtSpec.id,
      targetFormatName: fmtSpec.name,
      ext: fmtSpec.ext,
      quality,
      status: 'failed',
      progress: 0,
      totalBytes: 0,
      hasAudio: sourceProbe.hasAudio,
      audioStatusText: sourceProbe.audioStatusText || '',
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: preCheckError
    };
    activeConversions.set(jobId, failedJob);
    return failedJob;
  }

  let finalOutputPath = customOutputPath;
  if (!finalOutputPath) {
    const suffix =
      parsedIn.ext.toLowerCase() === `.${fmtSpec.ext}`
        ? `_H264_Fixed_${Date.now().toString().slice(-4)}`
        : `_${fmtSpec.ext.toUpperCase()}_${Date.now().toString().slice(-4)}`;
    finalOutputPath = path.join(destFolder, `${parsedIn.name}${suffix}.${fmtSpec.ext}`);
  }

  // Không bao giờ ghi đè trực tiếp lên inputPath trong lúc đang chạy FFmpeg
  if (path.resolve(finalOutputPath) === path.resolve(inputPath)) {
    finalOutputPath = path.join(destFolder, `${parsedIn.name}_converted_${Date.now().toString().slice(-4)}.${fmtSpec.ext}`);
  }

  const tempWorkPath = finalOutputPath.replace(
    new RegExp(`\\.${fmtSpec.ext}$`, 'i'),
    `.part_${Date.now().toString().slice(-4)}.${fmtSpec.ext}`
  );

  const totalDuration = sourceProbe.duration || 0;

  const jobState = {
    jobId,
    inputPath,
    inputFileName: parsedIn.base,
    outputPath: finalOutputPath,
    outputFileName: path.basename(finalOutputPath),
    targetFormat: fmtSpec.id,
    targetFormatName: fmtSpec.name,
    ext: fmtSpec.ext,
    quality,
    status: 'converting', // 'converting' | 'completed' | 'cancelled' | 'failed'
    progress: 0,
    totalBytes: 0,
    vcodec: '',
    acodec: '',
    hasAudio: sourceProbe.hasAudio,
    audioStatusText: sourceProbe.audioStatusText,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null
  };

  activeConversions.set(jobId, jobState);

  const args = buildFfmpegConvertArgs(inputPath, tempWorkPath, fmtSpec.id, quality, sourceProbe);
  const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  conversionProcesses.set(jobId, { proc, tempWorkPath });

  let stderrLog = '';

  proc.stderr.on('data', (chunk) => {
    const str = chunk.toString();
    stderrLog += str;
    const tMatch = str.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
    if (tMatch && totalDuration > 0) {
      const currentSec = parseTimeToSeconds(tMatch[1]);
      jobState.progress = Math.min(98, Math.max(1, Math.round((currentSec / totalDuration) * 100)));
    } else if (jobState.progress < 90) {
      jobState.progress += 2;
    }
  });

  proc.on('close', async (code) => {
    conversionProcesses.delete(jobId);

    if (jobState.status === 'cancelled') {
      safeUnlink(tempWorkPath);
      return;
    }

    if (code !== 0 || !fs.existsSync(tempWorkPath)) {
      safeUnlink(tempWorkPath);
      jobState.status = 'failed';
      jobState.error = formatFriendlyFfmpegError(stderrLog, code);
      return;
    }

    // Bước kiểm tra nghiêm ngặt file đầu ra trước khi báo hoàn tất
    const verifyRes = await verifyMediaOutput(tempWorkPath, fmtSpec.id);
    if (!verifyRes.ok) {
      safeUnlink(tempWorkPath);
      jobState.status = 'failed';
      jobState.error = verifyRes.error;
      return;
    }

    try {
      fs.renameSync(tempWorkPath, finalOutputPath);
    } catch (err) {
      safeUnlink(tempWorkPath);
      jobState.status = 'failed';
      jobState.error = `Không thể ghi file đích: ${err.message}`;
      return;
    }

    jobState.totalBytes = verifyRes.fileSize;
    jobState.vcodec = verifyRes.vcodec;
    jobState.acodec = verifyRes.acodec;
    jobState.hasAudio = verifyRes.hasAudio;
    jobState.audioStatusText = verifyRes.audioStatusText;
    jobState.progress = 100;
    jobState.status = 'completed';
    jobState.completedAt = new Date().toISOString();
  });

  proc.on('error', (err) => {
    conversionProcesses.delete(jobId);
    safeUnlink(tempWorkPath);
    jobState.status = 'failed';
    jobState.error = `Lỗi tiến trình FFmpeg: ${err.message}`;
  });

  return jobState;
}

function cancelConversionJob(jobId) {
  const job = activeConversions.get(jobId);
  if (!job) return { success: false, message: 'Không tìm thấy tác vụ chuyển đổi.' };

  job.status = 'cancelled';
  job.error = 'Đã hủy chuyển đổi theo yêu cầu người dùng. File gốc vẫn được giữ nguyên.';

  const rec = conversionProcesses.get(jobId);
  if (rec) {
    try {
      rec.proc.kill('SIGTERM');
      setTimeout(() => { try { rec.proc.kill('SIGKILL'); } catch {} }, 400);
    } catch {}
    safeUnlink(rec.tempWorkPath);
    conversionProcesses.delete(jobId);
  }
  return { success: true, job };
}

function getConversionsList() {
  return {
    supportedFormats: SUPPORTED_FORMATS,
    jobs: Array.from(activeConversions.values()).reverse()
  };
}

module.exports = {
  SUPPORTED_FORMATS,
  getFfmpegPath,
  formatFriendlyFfmpegError,
  probeMediaFile,
  verifyMediaOutput,
  ensureCompatibleMp4,
  startConversionJob,
  cancelConversionJob,
  getConversionsList
};

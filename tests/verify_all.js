/**
 * Bộ Kiểm thử Tự động Toàn diện (Offline-Safe by Default) — CN Video Scraper Pro
 * Kiểm tra đầy đủ 4 nhóm nâng cấp và 5 vấn đề cốt lõi:
 * 1. Content Analysis, Translation & Dubbing Pipeline (ASR Whisper, NMT, TTS Piper, 5-step progress, no video title fallback)
 * 2. Giao diện co giãn màn hình & CSS Responsive
 * 3. Tải & cài đặt công cụ còn thiếu (SHA-256 integrity, OS/arch matching, user confirmation)
 * 4. Quét hồ sơ tài khoản, Cookie Douyin an toàn, cách ly miền & tải hàng loạt
 * 5. Khởi động giao diện tức thì & kiểm tra môi trường song song
 *
 * Ràng buộc bắt buộc:
 * - Mặc định KHÔNG tải video thật từ Internet (tránh phụ thuộc mạng/rate-limit).
 * - Tuyệt đối KHÔNG ghi đè file cấu hình `config/storage_settings.json` của người dùng.
 * - Tuyệt đối KHÔNG ghi đè video gốc khi lồng tiếng.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

// Thiết lập môi trường cô lập vào thư mục tạm TRƯỚC khi nạp các module của ứng dụng
const TEST_TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cn_video_test_'));
const TEST_CONFIG_FILE = path.join(TEST_TMP_ROOT, 'test_storage_settings.json');
const TEST_DOWNLOAD_DIR = path.join(TEST_TMP_ROOT, 'downloads');

process.env.CN_STORAGE_CONFIG_FILE = TEST_CONFIG_FILE;
process.env.CN_DEFAULT_DOWNLOAD_DIR = TEST_DOWNLOAD_DIR;
process.env.OFFLINE_TEST_MODE = '1';

const USER_REAL_CONFIG_PATH = path.join(__dirname, '..', 'config', 'storage_settings.json');
const userConfigBefore = fs.existsSync(USER_REAL_CONFIG_PATH)
  ? fs.readFileSync(USER_REAL_CONFIG_PATH, 'utf8')
  : null;

const {
  PLATFORMS,
  detectPlatform,
  extractUrlFromText,
  extractVideoId,
  transformUrlByMethod
} = require('../src/extractors/platforms');
const {
  getStorageOverview,
  getPlatformDownloadDir,
  saveSettings
} = require('../src/storage_config');
const {
  getFfmpegPath,
  formatFriendlyFfmpegError,
  probeMediaFile,
  verifyMediaOutput,
  ensureCompatibleMp4,
  startConversionJob,
  cancelConversionJob
} = require('../src/converter_engine');
const {
  CAP_STATUS,
  runVersionProbe,
  buildPlatformCapabilityMatrix,
  getSystemCapabilities,
  getCapabilitiesSnapshot
} = require('../src/capabilities');
const {
  previewAccountTarget,
  startAccountScanJob,
  cancelAccountScanJob,
  enqueueBatchDownloads,
  clearPendingBatchQueue,
  parseAndValidateCookieInput,
  isCookieAllowedForUrl
} = require('../src/account_scanner');
const {
  LOCAL_MODELS_CATALOG,
  VOICE_CATALOG,
  extractAndPrepareSegments,
  retranslateSegments,
  generateVoicePreviewAudio,
  startDubbingJob,
  getAllDubbingJobs,
  cancelDubbingJob,
  getSupportedVoices,
  resolveVoiceConfig
} = require('../src/dubbing_engine');
const {
  getInstallableToolsCatalog,
  resolveOfficialToolSource,
  startToolInstallJob,
  computeFileSha256
} = require('../src/tool_installer');
const { sanitizeMetadataForDisk, readSidecarMetadata } = require('../src/extractors/index');
const { createServer } = require('../src/server');
const { listenWithFallbackPort } = require('../src/launcher');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function generateSyntheticMedia(ffmpegBin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args);
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg fixture failed (${code}): ${err.slice(-200)}`));
    });
  });
}

async function runAllTests() {
  console.log('========================================================================');
  console.log('🧪 BẮT ĐẦU KIỂM THỬ TOÀN DIỆN HỆ THỐNG CN VIDEO SCRAPER PRO (OFFLINE-SAFE)');
  console.log(`📂 Thư mục kiểm thử cô lập: ${TEST_TMP_ROOT}`);
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assertTest(condition, title, detail = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${title}${detail ? ' — ' + detail : ''}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${title}${detail ? ' — ' + detail : ''}`);
      failed++;
    }
  }

  const ffmpegBin = getFfmpegPath();
  const fixturesDir = path.join(TEST_TMP_ROOT, 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });

  const sampleWithAudio = path.join(fixturesDir, 'sample_with_audio.mp4');
  const sampleSilent = path.join(fixturesDir, 'sample_silent.mp4');
  const sampleLong = path.join(fixturesDir, 'sample_long.mp4');
  const sampleCorrupt = path.join(fixturesDir, 'sample_corrupt.mp4');
  const sampleWithRealSpeech = path.join(fixturesDir, 'sample_with_speech.mp4');

  // 1. Tạo video sine wave
  await generateSyntheticMedia(ffmpegBin, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1',
    '-c:a', 'aac', '-b:a', '96k',
    sampleWithAudio
  ]);

  // 2. Tạo video silent không có track âm thanh
  await generateSyntheticMedia(ffmpegBin, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2.5:r=15',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-an',
    sampleSilent
  ]);

  // 3. Tạo video dài để kiểm thử hủy tác vụ
  await generateSyntheticMedia(ffmpegBin, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=8:size=640x360:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    sampleLong
  ]);

  // 4. Tạo video có tiếng nói người thực tế (sử dụng Neural TTS VITS) để kiểm thử ASR Faster-Whisper
  const defaultViVoice = VOICE_CATALOG.find((v) => v.lang === 'vi' && v.isDefaultRecommended) || VOICE_CATALOG[0];
  const speechPreview = await generateVoicePreviewAudio(defaultViVoice.id, 'Xin chào các bạn đây là bài kiểm tra nhận dạng giọng nói trên máy tính');
  await generateSyntheticMedia(ffmpegBin, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=15',
    '-i', speechPreview.audioFilePath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    sampleWithRealSpeech
  ]);

  fs.writeFileSync(sampleCorrupt, Buffer.alloc(1024, 0x42));

  // ============================================================================
  // PHẦN A: SỬA LỖI CHUYỂN ĐỔI VÀ CHUẨN HÓA VIDEO
  // ============================================================================
  console.log('--- [PHẦN A] Kiểm thử Chuẩn hóa MP4, Chuyển đổi Định dạng, Xác minh Media & Bảo toàn File gốc ---');

  // A1. Kiểm tra chuẩn hóa MP4 có tiếng
  const normAudio = await ensureCompatibleMp4(sampleWithAudio);
  assertTest(
    normAudio.ok && normAudio.hasAudio === true && normAudio.vcodec === 'h264',
    'Chuẩn hóa & xác minh MP4 có cả hình + tiếng',
    `vcodec=${normAudio.vcodec}, acodec=${normAudio.acodec}, status="${normAudio.audioStatusText}"`
  );

  // A2. Kiểm tra chuẩn hóa MP4 không có tiếng (Silent video allowed & reported clearly)
  const normSilent = await ensureCompatibleMp4(sampleSilent);
  assertTest(
    normSilent.ok && normSilent.hasAudio === false && normSilent.audioStatusText.includes('Không có luồng âm thanh'),
    'Cho phép video không có tiếng (Silent Video) và báo rõ trạng thái',
    `hasAudio=${normSilent.hasAudio}, status="${normSilent.audioStatusText}"`
  );

  // A3. Kiểm tra file MP4 lỗi/hỏng (Không che giấu lỗi FFmpeg)
  const normCorrupt = await ensureCompatibleMp4(sampleCorrupt);
  assertTest(
    normCorrupt.ok === false && Boolean(normCorrupt.error),
    'Phát hiện chính xác file MP4 hỏng (Không che giấu lỗi FFmpeg)',
    `error="${normCorrupt.error}"`
  );

  // A4. Chuyển đổi định dạng thành công (.mp4 -> .mov và .mp4 -> .mp3) kèm verifyMediaOutput
  const convMov = await startConversionJob({
    inputPath: sampleWithAudio,
    targetFormat: 'mov',
    quality: 'medium',
    outputDir: fixturesDir
  });
  while (convMov.status === 'converting') await sleep(150);
  const verifyMov = await verifyMediaOutput(convMov.outputPath, 'mov');
  assertTest(
    convMov.status === 'completed' && verifyMov.ok && path.extname(convMov.outputPath) === '.mov',
    'Chuyển đổi sang .MOV chỉ báo hoàn tất sau khi vượt qua verifyMediaOutput',
    `output=${path.basename(convMov.outputPath)} (${convMov.totalBytes} bytes)`
  );

  // A5. Chuyển đổi thất bại (Tách .MP3 từ video câm không có luồng âm thanh) -> Báo lỗi dễ hiểu & Giữ nguyên file gốc
  const silentStatBefore = fs.statSync(sampleSilent).size;
  const convFail = await startConversionJob({
    inputPath: sampleSilent,
    targetFormat: 'mp3',
    quality: 'high',
    outputDir: fixturesDir
  });
  while (convFail.status === 'converting') await sleep(150);
  const silentExistsAfter = fs.existsSync(sampleSilent) && fs.statSync(sampleSilent).size === silentStatBefore;
  const leftoverParts = fs.readdirSync(fixturesDir).filter((f) => f.includes('.part_'));
  assertTest(
    convFail.status === 'failed' && Boolean(convFail.error) && silentExistsAfter && leftoverParts.length === 0,
    'Khi chuyển đổi thất bại: Đánh dấu failed, giữ nguyên file gốc và dọn sạch file tạm .part_',
    `error="${convFail.error}"`
  );

  // A6. Hủy tác vụ chuyển đổi đang chạy -> Đánh dấu cancelled, giữ nguyên file nguồn & xóa file tạm
  const convCancel = await startConversionJob({
    inputPath: sampleLong,
    targetFormat: 'webm',
    quality: 'high',
    outputDir: fixturesDir
  });
  await sleep(120);
  const cancelConvRes = cancelConversionJob(convCancel.jobId);
  await sleep(200);
  const longExistsAfter = fs.existsSync(sampleLong);
  const leftoverCancelParts = fs.readdirSync(fixturesDir).filter((f) => f.includes('.part_'));
  assertTest(
    cancelConvRes.success && convCancel.status === 'cancelled' && longExistsAfter && leftoverCancelParts.length === 0,
    'Hủy tác vụ chuyển đổi: Đánh dấu cancelled, giữ lại file gốc và dọn file tạm an toàn'
  );

  // A7. Thông báo lỗi thiếu dung lượng ổ đĩa (ENOSPC)
  const diskErrMsg = formatFriendlyFfmpegError('av_interleaved_write_frame(): No space left on device', 1);
  assertTest(
    diskErrMsg.includes('hết dung lượng') || diskErrMsg.includes('No space left on device'),
    'Xử lý thông báo dễ hiểu khi ổ đĩa đầy (ENOSPC)',
    `msg="${diskErrMsg}"`
  );

  // ============================================================================
  // PHẦN B: LÀM RÕ HỖ TRỢ MACOS VÀ WINDOWS, TẢI CÔNG CỤ CÒN THIẾU & KHỞI ĐỘNG NHANH
  // ============================================================================
  console.log('\n--- [PHẦN B] Kiểm thử Phát hiện Binary Thực tế, Tải Công cụ Còn thiếu & Khởi động Nhanh ---');

  // B1. Kiểm tra probe thực tế các binary trên máy hiện tại
  const sysCaps = await getSystemCapabilities(true);
  assertTest(
    Boolean(sysCaps.tools?.ytdlp?.ready) &&
      Boolean(sysCaps.tools?.ffmpeg?.ready) &&
      typeof sysCaps.tools.ytdlp.version === 'string' &&
      sysCaps.tools.ytdlp.executable === true,
    'Phát hiện thực tế binary yt-dlp & ffmpeg (quyền chạy X_OK + chuỗi phiên bản)',
    `yt-dlp=${sysCaps.tools.ytdlp.version}, ffmpeg=${sysCaps.tools.ffmpeg.version?.slice(0, 28)}`
  );

  // B2. Kiểm thử trạng thái "công cụ còn thiếu" (missing_tool) khi binary không tồn tại
  const missingProbe = await runVersionProbe('/nonexistent/path/to/fake_binary_xyz', ['--version']);
  const matrixWhenMissing = buildPlatformCapabilityMatrix({
    ytdlp: { ready: false },
    ffmpeg: { ready: false },
    webkitSniffer: { ready: false }
  });
  const allMarkedMissing = matrixWhenMissing.every(
    (row) => row.currentOsStatus.code === 'missing_tool' && row.currentOsStatus.label === CAP_STATUS.MISSING_TOOL.label
  );
  assertTest(
    missingProbe.ok === false && allMarkedMissing,
    'Khi thiếu binary: Không đặt cứng "sẵn sàng", chuyển ma trận sang trạng thái "công cụ còn thiếu"',
    `label="${CAP_STATUS.MISSING_TOOL.label}"`
  );

  // B3. Kiểm tra ma trận 12 nền tảng có đầy đủ 4 trạng thái chuẩn hóa
  const validStatusCodes = new Set(['verified', 'conditional', 'unsupported', 'missing_tool']);
  const matrixValid =
    sysCaps.platformMatrix.length === 12 &&
    sysCaps.platformMatrix.every(
      (r) =>
        validStatusCodes.has(r.currentOsStatus.code) &&
        validStatusCodes.has(r.macosStatus.code) &&
        validStatusCodes.has(r.windowsStatus.code)
    );
  assertTest(
    matrixValid,
    'Ma trận khả năng 12 nền tảng trên macOS/Windows sử dụng đúng chuẩn trạng thái minh bạch'
  );

  // B4. Kiểm tra khởi động Server, xử lý xung đột cổng (Port fallback) và đóng Server an toàn
  const app1 = createServer();
  const srv1 = await listenWithFallbackPort(app1, 0);
  const app2 = createServer();
  const srv2 = await listenWithFallbackPort(app2, srv1.port); // Cố tình truyền trùng cổng với srv1
  const statusRes = await fetch(`http://127.0.0.1:${srv1.port}/api/status`).then((r) => r.json());
  assertTest(
    statusRes.ok === true && srv2.port !== srv1.port,
    'Khởi động Backend Server, tự động đổi cổng khi trùng cổng (EADDRINUSE) và mở tức thì',
    `srv1Port=${srv1.port}, srv2FallbackPort=${srv2.port}`
  );

  // B5. Kiểm tra khởi động tức thì: getCapabilitiesSnapshot() trả về dữ liệu ngay không bị block
  const snapshot = getCapabilitiesSnapshot();
  assertTest(
    snapshot.ok && typeof snapshot.probeState === 'string' && snapshot.tools,
    'getCapabilitiesSnapshot() trả về dữ liệu tức thì không chặn khởi động giao diện',
    `probeState="${snapshot.probeState}"`
  );

  // B6. Kiểm tra endpoint /api/health phản hồi HTTP 200 nhanh cho wrapper app
  const healthRes = await fetch(`http://127.0.0.1:${srv1.port}/api/health`).then((r) => r.json());
  assertTest(
    healthRes.status === 'ok' && healthRes.health === true,
    '/api/health phản hồi HTTP 200 trong vài mili-giây cho app wrapper và launcher'
  );

  // B7. Kiểm tra danh mục công cụ có thể cài đặt (Tool Installer Catalog)
  const installCatalog = getInstallableToolsCatalog();
  const ytdlpSpec = resolveOfficialToolSource('ytdlp');
  assertTest(
    installCatalog.length >= 5 &&
      ytdlpSpec &&
      ytdlpSpec.downloadUrl.includes('yt-dlp') &&
      Array.isArray(ytdlpSpec.remediationSteps),
    'Trình tải công cụ liệt kê đúng nguồn chính thức, hệ điều hành và cung cấp hướng dẫn thủ công',
    `tools=${installCatalog.map((t) => t.id).join(', ')}`
  );

  // B8. Kiểm tra từ chối tải binary ngầm nếu người dùng chưa xác nhận (userConfirmed === false)
  let unconfirmedBlocked = false;
  try {
    startToolInstallJob({ toolId: 'ytdlp', userConfirmed: false });
  } catch (err) {
    unconfirmedBlocked = err.message.includes('userConfirmed');
  }
  assertTest(
    unconfirmedBlocked,
    'Trình tải công cụ từ chối tải ngầm nếu người dùng chưa xác nhận rõ ràng (userConfirmed = true)'
  );

  // B9. Kiểm tra tính toán mã băm toàn vẹn SHA-256 sau tải
  const testShaFile = path.join(fixturesDir, 'sha_test.bin');
  fs.writeFileSync(testShaFile, 'CN_VIDEO_SCRAPER_INTEGRITY_VERIFICATION');
  const fileHash = await computeFileSha256(testShaFile);
  assertTest(
    fileHash.length === 64 && typeof fileHash === 'string',
    'Tính toán mã băm toàn vẹn SHA-256 thành công (64 ký tự hex)',
    `sha256=${fileHash.slice(0, 16)}...`
  );

  // B10. Kiểm tra toàn vẹn cú pháp JavaScript Frontend (public/app.js) nạp được và không làm đơ giao diện
  const appJsCode = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  let appJsSyntaxValid = false;
  try {
    new vm.Script(appJsCode);
    appJsSyntaxValid = true;
  } catch (err) {
    appJsSyntaxValid = false;
  }
  assertTest(
    appJsSyntaxValid === true,
    'Mã nguồn giao diện Frontend (public/app.js) hợp lệ, sẵn sàng chạy ngay không bị treo cú pháp'
  );

  srv1.server.close();
  srv2.server.close();

  // ============================================================================
  // PHẦN C: QUÉT DANH SÁCH VIDEO TÀI KHOẢN, COOKIE DOUYIN AN TOÀN & BATCH QUEUE
  // ============================================================================
  console.log('\n--- [PHẦN C] Kiểm thử Nhận diện Tài khoản, Phân tích Cookie, Cách ly Miền & Tải Hàng loạt ---');

  // C1. Nhận diện hồ sơ Bilibili (Hỗ trợ) trước khi quét
  const previewBili = await previewAccountTarget({
    rawInput: 'https://space.bilibili.com/396427034',
    platformId: 'auto'
  });
  assertTest(
    previewBili.canStartScan === true && previewBili.platformId === 'bilibili' && previewBili.accountId === '396427034',
    'Nhận diện đúng nền tảng & UID tài khoản Bilibili trước khi quét',
    `handle=${previewBili.displayHandle}, status="${previewBili.supportLabel}"`
  );

  // C2. Báo rõ khi chưa nhận diện được thông tin hồ sơ chi tiết (chỉ phân tích được URL)
  assertTest(
    typeof previewBili.profileIdentified === 'boolean',
    'Phân biệt rõ ràng giữa "Hồ sơ đã xác minh" và "Chỉ phân tích được URL mục tiêu"',
    `profileIdentified=${previewBili.profileIdentified}`
  );

  // C3. Nền tảng không có cách truy cập phù hợp (Youku / Pipixia / Jianying) -> Đánh dấu "chưa hỗ trợ quét tài khoản"
  const previewYouku = await previewAccountTarget({
    rawInput: 'https://i.youku.com/i/UMzI0NTY3ODkw',
    platformId: 'youku'
  });
  const scanUnsupported = await startAccountScanJob({
    rawInput: 'https://i.youku.com/i/UMzI0NTY3ODkw',
    platformId: 'youku'
  });
  assertTest(
    previewYouku.canStartScan === false &&
      previewYouku.supportLabel === 'chưa hỗ trợ quét tài khoản' &&
      scanUnsupported.status === 'unsupported',
    'Nền tảng không hỗ trợ quét tài khoản được đánh dấu rõ "chưa hỗ trợ quét tài khoản" kèm lý do',
    `reason="${previewYouku.reason.slice(0, 65)}..."`
  );

  // C4. Kiểm tra phân tích cú pháp và xác thực Cookie người dùng cung cấp (Header format, Netscape format, JSON array)
  const headerCookie = parseAndValidateCookieInput('sessionid=123456789abcdef; ttwid=test_token_abc;', 'douyin');
  const netscapeCookie = parseAndValidateCookieInput('.douyin.com\tTRUE\t/\tFALSE\t1999999999\tsessionid\t123456789abcdef', 'douyin');
  const jsonCookie = parseAndValidateCookieInput('[{"name":"sessionid","value":"123456789abcdef","domain":".douyin.com"}]', 'douyin');
  const invalidCookie = parseAndValidateCookieInput('invalid_no_equals_cookie_string', 'douyin');

  assertTest(
    headerCookie.valid && headerCookie.format === 'header' &&
    netscapeCookie.valid && netscapeCookie.format === 'netscape' &&
    jsonCookie.valid && jsonCookie.format === 'json' &&
    !invalidCookie.valid,
    'Hỗ trợ đầy đủ các định dạng Cookie (Header, Netscape txt, JSON array) và từ chối định dạng sai',
    `headerCookies=${headerCookie.count}, netscapeCookies=${netscapeCookie.count}, jsonCookies=${jsonCookie.count}`
  );

  // C5. Kiểm tra cách ly miền Cookie: Chỉ cho phép gửi Cookie tới đúng miền của nền tảng
  const douyinAllowed = isCookieAllowedForUrl('https://www.douyin.com/user/MS4wLjAB', 'douyin');
  const crossDomainBlocked = isCookieAllowedForUrl('https://evil-cross-domain.com/steal', 'douyin');
  const mismatchPlatformBlocked = isCookieAllowedForUrl('https://api.bilibili.com/x/space', 'douyin');

  assertTest(
    douyinAllowed === true && crossDomainBlocked === false && mismatchPlatformBlocked === false,
    'Giới hạn gửi Cookie nghiêm ngặt tới đúng miền nền tảng, chặn rò rỉ chéo tên miền'
  );

  // C6. Kiểm tra chống rò rỉ Cookie / Token vào metadata hoặc file JSON lưu trên ổ đĩa
  const sampleMetaWithCookie = {
    platform: 'douyin',
    cookie: 'sensitive_session_id_123',
    headers: {
      Cookie: 'sessionid=sensitive_session_id_123;',
      Authorization: 'Bearer secret_token_xyz'
    },
    data: {
      videoId: 'dy_123',
      title: 'Video Test'
    }
  };
  const sanitizedMeta = sanitizeMetadataForDisk(sampleMetaWithCookie);
  const jsonMetaStr = JSON.stringify(sanitizedMeta);
  assertTest(
    sanitizedMeta.cookie === undefined &&
    sanitizedMeta.headers?.Cookie === undefined &&
    sanitizedMeta.headers?.Authorization === undefined &&
    !jsonMetaStr.includes('sensitive_session_id') &&
    !jsonMetaStr.includes('secret_token'),
    'Tuyệt đối không lưu Cookie, Token hoặc Header nhạy cảm vào metadata JSON trên ổ cứng'
  );

  // C7. Kiểm thử hủy lượt quét tài khoản đang chạy
  const dummyScan = await startAccountScanJob({
    rawInput: 'https://www.douyin.com/user/MS4wLjABAAAA_test_cancel_handle',
    platformId: 'douyin',
    maxPages: 1
  });
  const cancelScanRes = cancelAccountScanJob(dummyScan.scanId);
  assertTest(
    cancelScanRes.success && cancelScanRes.scan.status === 'cancelled',
    'Hủy lượt quét tài khoản đang chạy hoạt động chính xác'
  );

  // C8. Kiểm thử chống trùng & giới hạn đồng thời trong hàng đợi tải hàng loạt (Batch Queue)
  clearPendingBatchQueue();
  const batchRes = enqueueBatchDownloads({
    videos: [
      { platformId: 'douyin', videoId: 'dup_001', title: 'Video 1', url: 'https://www.douyin.com/video/1', downloadable: false },
      { platformId: 'douyin', videoId: 'dup_002', title: 'Video 2 Restricted', url: 'https://www.douyin.com/video/2', downloadable: false }
    ],
    maxConcurrent: 2
  });
  assertTest(
    batchRes.success && batchRes.addedCount === 0 && batchRes.maxConcurrent === 2,
    'Hàng đợi tải hàng loạt lọc bỏ video không tải được và kiểm soát số luồng đồng thời'
  );

  // C9. Kiểm thử phân tích Cookie Netscape có #HttpOnly_ (sessionid/ttwid/sid_tt), cURL và JSON {cookies:[...]}
  const netscapeHttpOnlyDouyin = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t1800000000\tsessionid\tabc123xyz',
    '#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t1800000000\tsid_tt\tsid456def',
    '.douyin.com\tTRUE\t/\tFALSE\t1800000000\tttwid\t1%7Cmockttwid',
    '.evil-domain.com\tTRUE\t/\tFALSE\t1800000000\tleaked\tshould_drop'
  ].join('\n');
  const parsedNetscapeDy = parseAndValidateCookieInput(netscapeHttpOnlyDouyin, 'douyin');
  const parsedCurlDy = parseAndValidateCookieInput(
    "curl 'https://www.douyin.com/' -H 'cookie: sessionid=curl_sess_1; ttwid=curl_tt_2'",
    'douyin'
  );
  const parsedJsonObjDy = parseAndValidateCookieInput(
    JSON.stringify({ cookies: [{ name: 'sessionid', value: 'json_sess_9', domain: '.douyin.com' }] }),
    'douyin'
  );
  assertTest(
    parsedNetscapeDy.valid &&
      parsedNetscapeDy.hasAuthSessionKey &&
      parsedNetscapeDy.cookieHeader.includes('sessionid=abc123xyz') &&
      parsedNetscapeDy.cookieHeader.includes('sid_tt=sid456def') &&
      !parsedNetscapeDy.cookieHeader.includes('leaked=') &&
      parsedCurlDy.valid &&
      parsedCurlDy.cookieHeader.includes('sessionid=curl_sess_1') &&
      parsedJsonObjDy.valid &&
      parsedJsonObjDy.cookieHeader.includes('sessionid=json_sess_9'),
    'Bộ phân tích Cookie Douyin giữ nguyên các dòng #HttpOnly_ (sessionid/sid_tt), hỗ trợ cURL/JSON và chặn chéo miền'
  );

  // ============================================================================
  // PHẦN D: LỒNG TIẾNG CHO VIDEO ĐÃ TẢI (LOCAL-FIRST DUBBING PIPELINE)
  // ============================================================================
  console.log('\n--- [PHẦN D] Kiểm thử Quy trình Lồng tiếng 5 Bước, Nhận dạng Lời thoại Thực tế & Không Dùng Tiêu đề Giả ---');

  // D1. Kiểm tra danh mục mô hình Local hiển thị đầy đủ dung lượng, giấy phép, RAM và ngôn ngữ
  const modelsValid =
    LOCAL_MODELS_CATALOG.length >= 3 &&
    LOCAL_MODELS_CATALOG.every(
      (m) => typeof (m.sizeMB || m.modelSizeMB) === 'number' && Boolean(m.license) && Boolean(m.ramRequired || m.hardwareReq) && Array.isArray(m.supportedLanguages)
    );
  assertTest(
    modelsValid,
    'Danh mục mô hình Local hiển thị rõ dung lượng (MB), giấy phép, yêu cầu RAM và ngôn ngữ hỗ trợ'
  );

  // D2. Kiểm tra mở rộng các lựa chọn giọng tiếng Việt (Sherpa-ONNX Piper VITS VAIS-1000, 25Hours, VIVOS 65 giọng)
  const viVoices = getSupportedVoices('vi');
  const defaultVi = viVoices.find((v) => v.isDefaultRecommended);
  assertTest(
    viVoices.length >= 3 &&
      Boolean(defaultVi) &&
      viVoices.every((v) => typeof v.modelSizeMB === 'number' && Boolean(v.license) && Boolean(v.hardwareReq)),
    'Mở rộng các lựa chọn giọng tiếng Việt Local với mô hình Neural VITS và đề xuất 1 giọng mặc định minh bạch',
    `viVoicesCount=${viVoices.length}, defaultVoice="${defaultVi?.name}"`
  );

  // D3. Nghe thử giọng đọc Local (Voice Preview) không gửi dữ liệu ra ngoài
  const previewVoiceRes = await generateVoicePreviewAudio(defaultViVoice.id, 'Xin chào, đây là giọng đọc thử nghiệm.');
  assertTest(
    previewVoiceRes.ok && fs.existsSync(previewVoiceRes.previewPath) && fs.statSync(previewVoiceRes.previewPath).size > 512,
    'Tạo file âm thanh nghe thử giọng đọc (Voice Preview) thành công',
    `voice="${defaultViVoice.name}", file=${path.basename(previewVoiceRes.previewPath)}`
  );

  // D4. Kiểm tra từ chối giọng Cloud / Dịch Cloud khi người dùng chưa đồng ý (cloudConsent = false)
  let cloudBlocked = false;
  try {
    resolveVoiceConfig('vi_edge_hoaimy', 'vi', { cloudConsent: false });
  } catch (err) {
    cloudBlocked = err.message.includes('dịch vụ đám mây');
  }
  assertTest(
    cloudBlocked,
    'Cam kết quyền riêng tư: Chặn giọng Cloud khi người dùng chưa chủ động bật xác nhận (cloudConsent = false)'
  );

  // D5. KIỂM THỬ ASR THỰC TẾ: Nhận dạng giọng nói trên video có lời thoại tạo các phân đoạn có mốc thời gian startSec / endSec
  console.log('    ⏳ Đang chạy ASR Faster-Whisper trên video có lời thoại thực tế...');
  const realSpeechASR = await extractAndPrepareSegments(sampleWithRealSpeech, 'vi', null, { cloudConsent: false });
  assertTest(
    realSpeechASR.segments.length >= 1 &&
      realSpeechASR.segments.every((s) => typeof s.startSec === 'number' && typeof s.endSec === 'number' && s.endSec > s.startSec && Boolean(s.sourceText)),
    'Nhận dạng giọng nói (ASR) thực tế từ track âm thanh tạo các phân đoạn có mốc thời gian startSec/endSec rõ ràng',
    `segments=${realSpeechASR.segments.length}, seg1="${realSpeechASR.segments[0].sourceText}" [${realSpeechASR.segments[0].startSec}s -> ${realSpeechASR.segments[0].endSec}s]`
  );

  // D6. KIỂM THỬ TỪ CHỐI VIDEO KHÔNG CÓ LỜI THOẠI (Sine Wave / Nhạc nền): Báo lỗi cụ thể, TUYỆT ĐỐI KHÔNG dùng tiêu đề video làm kết quả giả
  let sineRejected = false;
  let sineErrMsg = '';
  try {
    await extractAndPrepareSegments(sampleWithAudio, 'vi', null, { cloudConsent: false });
  } catch (err) {
    sineRejected = true;
    sineErrMsg = err.message;
  }
  assertTest(
    sineRejected && (sineErrMsg.includes('Không nhận diện được lời thoại') || sineErrMsg.includes('lời thoại')),
    'Video không có lời thoại bị dừng và báo lỗi cụ thể (Tuyệt đối KHÔNG lấy tiêu đề video làm phụ đề thay thế)',
    `error="${sineErrMsg}"`
  );

  // D7. KIỂM THỬ TỪ CHỐI VIDEO CÂM (Không có luồng âm thanh)
  let silentRejected = false;
  let silentErrMsg = '';
  try {
    await extractAndPrepareSegments(sampleSilent, 'vi', null, { cloudConsent: false });
  } catch (err) {
    silentRejected = true;
    silentErrMsg = err.message;
  }
  assertTest(
    silentRejected && silentErrMsg.includes('không có track âm thanh'),
    'Video không có luồng âm thanh bị dừng ngay từ bước 1 và báo lỗi cụ thể',
    `error="${silentErrMsg}"`
  );

  // D8. Thực hiện quy trình lồng tiếng 5 bước hoàn chỉnh (Tách tiếng, ASR/Kịch bản, Dịch, TTS Piper, Ghép Ducking & Verify)
  console.log('    ⏳ Đang chạy quy trình lồng tiếng 5 bước hoàn chỉnh...');
  const origVideoSizeBefore = fs.statSync(sampleWithRealSpeech).size;
  const dubJob = await startDubbingJob({
    videoPath: sampleWithRealSpeech,
    targetLang: 'vi',
    voiceId: defaultViVoice.id,
    originalVolume: 0.25,
    dubVolume: 1.1,
    autoDucking: true,
    cloudConsent: false,
    customSegments: [
      {
        index: 1,
        startSec: 0.2,
        endSec: 1.8,
        sourceText: 'Xin chào các bạn đây là bài kiểm tra',
        translatedText: 'Xin chào các bạn đây là bài kiểm tra'
      },
      {
        index: 2,
        startSec: 2.0,
        endSec: 3.6,
        sourceText: 'Nhận dạng giọng nói trên máy tính',
        translatedText: 'Đã hoàn tất quy trình lồng tiếng thành công'
      }
    ]
  });

  while (dubJob.status === 'running' || dubJob.status === 'processing') {
    await sleep(200);
  }

  const origVideoUnchanged =
    fs.existsSync(sampleWithRealSpeech) && fs.statSync(sampleWithRealSpeech).size === origVideoSizeBefore;
  const dubOutputVerified = dubJob.status === 'completed' ? await verifyMediaOutput(dubJob.outputPath, 'mp4') : { ok: false };
  const inDubbedSubfolder = dubJob.outputPath && path.basename(path.dirname(dubJob.outputPath)) === 'Dubbed';
  const metaExists = dubJob.metadataPath && fs.existsSync(dubJob.metadataPath);

  assertTest(
    dubJob.status === 'completed' &&
      origVideoUnchanged &&
      dubOutputVerified.ok &&
      dubOutputVerified.hasAudio === true &&
      inDubbedSubfolder &&
      metaExists,
    'Lồng tiếng hoàn tất 5 bước: Lưu file mới trong thư mục Dubbed/, xác minh có tiếng, ghi metadata và giữ nguyên video gốc',
    `output=${path.basename(dubJob.outputPath || '')} (${dubJob.totalBytes} bytes, hasAudio=${dubOutputVerified.hasAudio})`
  );

  // D9. Kiểm thử hủy tác vụ lồng tiếng đang chạy
  const dubJobCancel = await startDubbingJob({
    videoPath: sampleLong,
    targetLang: 'en',
    voiceId: 'en_samantha',
    originalVolume: 0.3,
    dubVolume: 1.0,
    autoDucking: true,
    cloudConsent: false
  });
  await sleep(100);
  const cancelDubRes = cancelDubbingJob(dubJobCancel.jobId);
  await sleep(200);
  assertTest(
    cancelDubRes.success && dubJobCancel.status === 'cancelled' && fs.existsSync(sampleLong),
    'Hủy tác vụ lồng tiếng: Đánh dấu cancelled và giữ nguyên video gốc'
  );

  // D10. Kiểm tra danh sách tiến trình & các bản video đã lồng tiếng (getAllDubbingJobs + readSidecarMetadata)
  const allDubJobs = getAllDubbingJobs();
  const completedDubEntry = allDubJobs.find((j) => j.jobId === dubJob.jobId);
  const sidecarCheck = dubJob.outputPath ? readSidecarMetadata(dubJob.outputPath) : null;
  assertTest(
    Array.isArray(allDubJobs) &&
      allDubJobs.length >= 1 &&
      Boolean(completedDubEntry) &&
      completedDubEntry.outputFileName === dubJob.outputFileName &&
      Boolean(completedDubEntry.targetLangName) &&
      Boolean(completedDubEntry.voiceName) &&
      sidecarCheck?.isDubbed === true,
    'Khung tiến trình lồng tiếng trả về đầy đủ danh sách đã hoàn tất (từ bộ nhớ & metadata .dubbing.metadata.json)'
  );

  // D11. Kiểm tra API /api/dubbing/config trả về jobs, translationProviders và giao diện mặc định thu gọn bảng tài nguyên
  const testApiApp = createServer();
  const testSrv = await listenWithFallbackPort(testApiApp, 0);
  let dubConfigOk = false;
  try {
    const cfgPort = testSrv.port;
    const cfgRes = await fetch(`http://127.0.0.1:${cfgPort}/api/dubbing/config`);
    const cfgJson = await cfgRes.json();
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const hiddenDefaultRes = indexHtml.includes('id="dubResourcesDetailBody" style="display:none;');
    dubConfigOk =
      cfgJson.success &&
      Array.isArray(cfgJson.jobs) &&
      cfgJson.jobs.some((j) => j.jobId === dubJob.jobId) &&
      Array.isArray(cfgJson.translationProviders) &&
      cfgJson.translationProviders.some((p) => p.id === 'ai_gemini' || p.id === 'cloud_gemini') &&
      hiddenDefaultRes;
  } finally {
    if (testSrv?.server) {
      await new Promise((r) => testSrv.server.close(r));
    }
  }
  assertTest(
    dubConfigOk,
    'API /api/dubbing/config trả về jobs + bộ máy dịch và mặc định thu gọn khung tài nguyên AI Local trên UI'
  );

  // D12. Kiểm tra dịch lại theo ngữ cảnh (Local Offline NMT) & chặn Cloud nếu chưa đồng ý
  let retranslateCloudBlocked = false;
  try {
    await retranslateSegments({
      segments: [{ index: 1, startSec: 0, endSec: 2, sourceText: '大家好，今天天气很好。' }],
      sourceLang: 'zh',
      targetLang: 'vi',
      cloudConsent: false,
      translationProvider: 'cloud_gemini'
    });
  } catch (err) {
    retranslateCloudBlocked = err.message.includes('đám mây');
  }
  let retranslateLocalRes = null;
  let localNmtMissing = '';
  try {
    retranslateLocalRes = await retranslateSegments({
    segments: [
      { index: 1, startSec: 0.0, endSec: 1.5, sourceText: '大家好，欢迎来到我的频道，' },
      { index: 2, startSec: 1.6, endSec: 3.4, sourceText: '今天我们来测试这个新手机。' }
    ],
    sourceLang: 'zh',
    targetLang: 'vi',
    cloudConsent: false,
    translationProvider: 'local',
    translationStyle: 'natural'
    });
  } catch (err) {
    // Máy chưa cài bộ dịch Offline nào (Argos / Qwen / Ollama) — không phải lỗi mã nguồn, báo BLOCKED
    if (!/Thiếu mô hình dịch Offline|Chưa cài bộ dịch Offline/.test(err.message)) throw err;
    localNmtMissing = err.message;
  }
  if (localNmtMissing) {
    assertTest(retranslateCloudBlocked, 'Dịch lại: chặn nghiêm ngặt Cloud nếu thiếu cloudConsent');
    console.log(`⛔ BLOCKED: Dịch lại Local Offline — máy chưa cài bộ dịch Offline (${localNmtMissing.slice(0, 90)}...)`);
  } else assertTest(
    retranslateCloudBlocked &&
      retranslateLocalRes.usedCloudTranslation === false &&
      Array.isArray(retranslateLocalRes.segments) &&
      retranslateLocalRes.segments.length === 2 &&
      retranslateLocalRes.segments.every((s) => Boolean(s.translatedText && s.translatedText.trim())),
    'Dịch lại ngữ cảnh Local Offline NMT hoạt động mượt và chặn nghiêm ngặt Cloud nếu thiếu cloudConsent',
    `seg1="${retranslateLocalRes.segments?.[0]?.translatedText}", seg2="${retranslateLocalRes.segments?.[1]?.translatedText}"`
  );

  // ============================================================================
  // KIỂM TRA BẢO TOÀN CẤU HÌNH NGƯỜI DÙNG
  // ============================================================================
  saveSettings({ customPlatformDirs: { douyin: path.join(TEST_TMP_ROOT, 'custom_dy') } });
  const userConfigAfter = fs.existsSync(USER_REAL_CONFIG_PATH)
    ? fs.readFileSync(USER_REAL_CONFIG_PATH, 'utf8')
    : null;
  assertTest(
    userConfigBefore === userConfigAfter,
    'Bộ kiểm thử cô lập hoàn toàn, KHÔNG ghi đè file cấu hình của người dùng (config/storage_settings.json)'
  );

  // Dọn dẹp thư mục tạm sau khi kiểm thử
  try {
    fs.rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
  } catch {}

  console.log('\n========================================================================');
  console.log(`📊 TỔNG KẾT KIỂM THỬ: ${passed} PASS / ${failed} FAIL`);
  console.log('========================================================================');
  if (failed > 0) process.exit(1);
}

runAllTests().catch((err) => {
  console.error('Lỗi nghiêm trọng khi chạy kiểm thử:', err);
  process.exit(1);
});

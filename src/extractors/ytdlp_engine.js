/**
 * Engine 2: Tích hợp yt-dlp + FFmpeg (Hỗ trợ cả macOS & Windows + Hủy/Dừng tiến trình tải)
 * - Tự động suy luận miền cookie từ URL đích nếu không truyền `options.domain`.
 * - Tạo file cookie tạm thời với quyền đọc hạn chế (0600) và tự động xóa ngay sau khi tiến trình kết thúc.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function getYtDlpPath() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
  const localBin = path.join(__dirname, '..', '..', 'bin', binName);
  if (fs.existsSync(localBin)) return localBin;
  return binName;
}

function getFfmpegPath() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  } catch (_) {}
  const isWin = process.platform === 'win32';
  const localBin = path.join(__dirname, '..', '..', 'bin', isWin ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(localBin)) return localBin;
  return null;
}

function deriveCookieDomainFromUrl(targetUrl, explicitDomain = '') {
  if (explicitDomain && String(explicitDomain).trim()) {
    const d = String(explicitDomain).trim();
    return d.startsWith('.') ? d : `.${d}`;
  }
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    const parts = host.split('.');
    if (parts.length >= 2) {
      return `.${parts.slice(-2).join('.')}`;
    }
    return host;
  } catch (_) {
    return '.douyin.com';
  }
}

function createTempCookieFile(cookieStr, domain = '.douyin.com') {
  if (!cookieStr || !String(cookieStr).trim()) return null;
  const raw = String(cookieStr).trim();
  const tmpFile = path.join(os.tmpdir(), `cn_scraper_cookies_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
  const safeDomain = domain.startsWith('.') ? domain : `.${domain}`;

  if (raw.includes('# Netscape HTTP Cookie File') || raw.includes('\t')) {
    const outLines = raw.includes('# Netscape HTTP Cookie File') ? [] : ['# Netscape HTTP Cookie File'];
    for (const ln of raw.split(/\r?\n/)) {
      outLines.push(ln);
    }
    fs.writeFileSync(tmpFile, outLines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    return tmpFile;
  }

  const lines = ['# Netscape HTTP Cookie File', ''];
  const exp = Math.floor(Date.now() / 1000) + 86400 * 30;

  if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : null;
      if (arr) {
        for (const item of arr) {
          if (!item || !item.name) continue;
          const d = item.domain ? (String(item.domain).startsWith('.') ? item.domain : `.${item.domain}`) : safeDomain;
          lines.push(`${d}\tTRUE\t/\tFALSE\t${exp}\t${item.name}\t${item.value ?? ''}`);
        }
        fs.writeFileSync(tmpFile, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
        return tmpFile;
      }
    } catch (_) {}
  }

  // Hỗ trợ chuỗi Header "Cookie: k=v; ..."
  const cleanedHeader = raw.replace(/^Cookie\s*:\s*/i, '').trim();
  const pairs = cleanedHeader
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k && !/[\r\n\t]/.test(k) && !/[\r\n\t]/.test(v)) {
        lines.push(`${safeDomain}\tTRUE\t/\tFALSE\t${exp}\t${k}\t${v}`);
      }
    }
  }

  fs.writeFileSync(tmpFile, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  return tmpFile;
}

function extractWithYtDlp(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const ytdlpBin = getYtDlpPath();

    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--socket-timeout',
      '15'
    ];

    const ffmpegPath = getFfmpegPath();
    if (ffmpegPath) {
      args.push('--ffmpeg-location', ffmpegPath);
    }

    if (options.cookiesFromBrowser && options.cookiesFromBrowser !== 'none') {
      args.push('--cookies-from-browser', options.cookiesFromBrowser);
    }

    let tmpCookieFile = null;
    if (options.cookie) {
      const cookieDomain = deriveCookieDomainFromUrl(targetUrl, options.domain);
      tmpCookieFile = createTempCookieFile(options.cookie, cookieDomain);
      if (tmpCookieFile) {
        args.push('--cookies', tmpCookieFile);
      }
    }

    if (options.referer) {
      args.push('--referer', options.referer);
    }
    if (options.userAgent) {
      args.push('--user-agent', options.userAgent);
    }

    args.push(targetUrl);

    const proc = spawn(ytdlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      reject(new Error('Quá thời gian chờ (Timeout 25s) khi phân tích bằng yt-dlp.'));
    }, 25000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (tmpCookieFile && fs.existsSync(tmpCookieFile)) {
        try {
          fs.unlinkSync(tmpCookieFile);
        } catch (_) {}
      }
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (tmpCookieFile && fs.existsSync(tmpCookieFile)) {
        try {
          fs.unlinkSync(tmpCookieFile);
        } catch (_) {}
      }

      if (code !== 0 || !stdout.trim()) {
        return reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      }

      try {
        const info = JSON.parse(stdout);
        const rawFormats = info.formats || [];
        const videoFormats = rawFormats.filter((f) => f.url && f.vcodec && f.vcodec !== 'none');

        videoFormats.sort((a, b) => {
          const aIsAvc = String(a.vcodec || '').startsWith('avc') ? 1 : 0;
          const bIsAvc = String(b.vcodec || '').startsWith('avc') ? 1 : 0;
          const aHeight = a.height || 0;
          const bHeight = b.height || 0;
          if (bHeight !== aHeight) return bHeight - aHeight;
          if (bIsAvc !== aIsAvc) return bIsAvc - aIsAvc;
          const aHasAudio = a.acodec && a.acodec !== 'none' ? 1 : 0;
          const bHasAudio = b.acodec && b.acodec !== 'none' ? 1 : 0;
          return bHasAudio - aHasAudio;
        });

        const formats = videoFormats.slice(0, 10).map((f) => {
          const hasAudio = Boolean(f.acodec && f.acodec !== 'none');
          const isDashM4s = f.url.includes('.m4s') || !hasAudio;
          const codecShort = String(f.vcodec || '').startsWith('avc')
            ? 'H.264'
            : String(f.vcodec || '').startsWith('hev') || String(f.vcodec || '').startsWith('hvc')
            ? 'HEVC'
            : f.vcodec || 'MP4';

          const cleanHeaders = { ...(f.http_headers || {}) };
          delete cleanHeaders.Cookie;
          delete cleanHeaders.cookie;

          return {
            formatId: f.format_id,
            quality: `${f.format_note || (f.height ? `${f.height}P` : f.resolution || 'HD')} • ${codecShort}${
              hasAudio ? '' : ' + Ghép Audio tự động'
            }`,
            ext: f.ext || 'mp4',
            width: f.width || null,
            height: f.height || null,
            vcodec: f.vcodec || '',
            acodec: f.acodec || '',
            size: f.filesize || f.filesize_approx || null,
            url: f.url,
            hasAudio,
            isDashM4s,
            noWatermark: true,
            headers: cleanHeaders
          };
        });

        const bestProgressive = formats.find(
          (f) => f.hasAudio && !f.isDashM4s && !String(f.vcodec).startsWith('hev1')
        );

        const safeDlHeaders = { ...(info.http_headers || {}) };
        delete safeDlHeaders.Cookie;
        delete safeDlHeaders.cookie;

        resolve({
          videoId: info.id || '',
          title: info.title || info.fulltitle || 'Untitled Video',
          description: info.description || '',
          author: info.uploader || info.channel || info.creator || '',
          cover: info.thumbnail || '',
          duration: Math.round(info.duration || 0),
          stats: {
            views: info.view_count || 0,
            likes: info.like_count || 0,
            comments: info.comment_count || 0,
            shares: info.repost_count || 0
          },
          directVideoUrl: bestProgressive ? bestProgressive.url : formats[0]?.url || info.url || null,
          requiresYtDlpMerge: !bestProgressive,
          formats,
          downloadHeaders: safeDlHeaders,
          engine: 'yt-dlp Core Extractor + FFmpeg'
        });
      } catch (err) {
        reject(new Error(`Lỗi đọc JSON từ yt-dlp: ${err.message}`));
      }
    });
  });
}

function downloadWithYtDlp(targetUrl, outputPath, options = {}, onProgress = () => {}, cancelHandle = null) {
  return new Promise((resolve, reject) => {
    const ytdlpBin = getYtDlpPath();
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--continue',
      '--newline',
      '-S',
      'vcodec:h264,res,acodec:m4a',
      '--merge-output-format',
      'mp4',
      '--postprocessor-args',
      'Merger+ffmpeg:-movflags +faststart',
      '-o',
      outputPath
    ];

    if (
      options.formatId &&
      !options.formatId.startsWith('html5-') &&
      !options.formatId.startsWith('ppx-') &&
      !options.formatId.startsWith('dy-') &&
      !options.formatId.startsWith('douyin-') &&
      !options.formatId.startsWith('webkit-')
    ) {
      args.push(
        '-f',
        `${options.formatId}+bestaudio[acodec^=mp4a]/${options.formatId}+bestaudio/bestvideo[vcodec^=avc]+bestaudio/best`
      );
    } else {
      args.push(
        '-f',
        'bestvideo[vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
      );
    }

    const ffmpegPath = getFfmpegPath();
    if (ffmpegPath) {
      args.push('--ffmpeg-location', ffmpegPath);
    }

    if (options.cookiesFromBrowser && options.cookiesFromBrowser !== 'none') {
      args.push('--cookies-from-browser', options.cookiesFromBrowser);
    }

    let tmpCookieFile = null;
    if (options.cookie) {
      const cookieDomain = deriveCookieDomainFromUrl(targetUrl, options.domain);
      tmpCookieFile = createTempCookieFile(options.cookie, cookieDomain);
      if (tmpCookieFile) {
        args.push('--cookies', tmpCookieFile);
      }
    }

    if (options.referer) {
      args.push('--referer', options.referer);
    }
    if (options.userAgent) {
      args.push('--user-agent', options.userAgent);
    }

    args.push(targetUrl);

    const proc = spawn(ytdlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let isCancelled = false;

    if (cancelHandle) {
      cancelHandle.killProcess = () => {
        isCancelled = true;
        try {
          proc.kill('SIGTERM');
          setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch (_) {}
          }, 500);
        } catch (_) {}
      };
    }

    // Tiến độ tổng hợp: yt-dlp tải lần lượt luồng hình rồi luồng tiếng (mỗi luồng 0→100%), sau đó ghép (Merger).
    // Quy đổi sang một thanh tiến độ tăng dần duy nhất để giao diện không nhảy ngược / đứng yên.
    const expectedStreams = /\+/.test(args[args.indexOf('-f') + 1] || '') ? 2 : 1;
    let streamIdx = 0;
    let lastOverall = 0;
    let stdoutBuf = '';
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (/\[download\]\s+Destination:/i.test(line)) {
          streamIdx += 1;
          continue;
        }
        if (/\[(Merger|FixupM3u8|FixupM4a|VideoConvertor|ExtractAudio)\]/i.test(line)) {
          lastOverall = Math.max(lastOverall, 96);
          onProgress({ percent: lastOverall, phase: 'merge', speedStr: 'Đang ghép luồng hình + tiếng (FFmpeg)...' });
          continue;
        }
        const m = line.match(
          /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([0-9.]+\s*[KMG]?i?B)(?:\s+at\s+([0-9.]+\s*[KMG]?i?B\/s|Unknown B\/s))?/i
        );
        if (m) {
          const pct = parseFloat(m[1]);
          const nStreams = Math.max(expectedStreams, streamIdx || 1);
          const idx = Math.min(Math.max(streamIdx, 1), nStreams) - 1;
          const overall = Math.min(95, ((idx + pct / 100) / nStreams) * 95);
          lastOverall = Math.max(lastOverall, overall);
          onProgress({
            percent: Number(lastOverall.toFixed(1)),
            totalSizeStr: m[2],
            speedStr: m[3] && !/Unknown/i.test(m[3]) ? `${m[3]} • luồng ${idx + 1}/${nStreams}` : `luồng ${idx + 1}/${nStreams}`
          });
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      if (tmpCookieFile && fs.existsSync(tmpCookieFile)) {
        try {
          fs.unlinkSync(tmpCookieFile);
        } catch (_) {}
      }
      reject(err);
    });

    proc.on('close', (code) => {
      if (tmpCookieFile && fs.existsSync(tmpCookieFile)) {
        try {
          fs.unlinkSync(tmpCookieFile);
        } catch (_) {}
      }
      if (isCancelled) {
        return reject(new Error('USER_CANCELLED'));
      }
      if (code === 0 && fs.existsSync(outputPath)) {
        const stat = fs.statSync(outputPath);
        resolve({
          filePath: outputPath,
          fileSize: stat.size
        });
      } else {
        reject(new Error(stderr.trim() || `yt-dlp download thất bại (code ${code})`));
      }
    });
  });
}

module.exports = {
  getYtDlpPath,
  getFfmpegPath,
  deriveCookieDomainFromUrl,
  createTempCookieFile,
  extractWithYtDlp,
  downloadWithYtDlp
};

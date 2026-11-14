window.addEventListener('error', (event) => {
  console.error('[CN Video Scraper Client Error]', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[CN Video Scraper Unhandled Rejection]', event.reason);
});

let platforms = [];
let storageConfig = null;
let systemCapabilities = null;
let selectedPlatformId = 'auto';
let selectedMethod = 'auto';
let currentWorkspaceTab = 'single';
let currentResult = null;
let selectedStreamIndex = 0;
let allSavedFilesCache = [];
let platformFileCounts = {};

// State cho Quét tài khoản
let currentAccountScan = null;
let selectedAccountVideoKeys = new Set();

// State cho Lồng tiếng Video (Dubbing)
let dubbingCatalog = {
  localModels: [],
  languages: [],
  voicesByLang: {},
  allVoices: [],
  jobs: []
};
let currentDubSegments = [];
let currentDubSourceLang = 'auto';
let dubResourcesUserExpanded = false;
let aiConfigCache = null;
let dubSpeakerVoiceMap = {};

const PLATFORM_COLORS = {
  douyin: '#111827',
  kuaishou: '#f97316',
  pipixia: '#ec4899',
  youku: '#2563eb',
  tencent: '#0ea5e9',
  iqiyi: '#10b981',
  mangotv: '#f59e0b',
  wetv: '#3b82f6',
  bilibili: '#06b6d4',
  xigua: '#ef4444',
  xiaohongshu: '#e11d48',
  jianying: '#6366f1'
};

function toast(msg, type = 'info') {
  const wrap = document.getElementById('toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderLeft =
    type === 'error' ? '4px solid #dc2626' : type === 'warn' ? '4px solid #d97706' : '4px solid #10b981';
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

function fmtNum(n) {
  if (!n || isNaN(n)) return '0';
  if (n >= 100000000) return (n / 100000000).toFixed(1) + ' ức';
  if (n >= 10000) return (n / 10000).toFixed(1) + ' vạn';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function fmtDur(sec) {
  if (!sec || isNaN(sec)) return '00:00';
  sec = Math.round(Number(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtSizeMB(bytes) {
  if (!bytes || isNaN(bytes)) return '0.00';
  return (Number(bytes) / 1024 / 1024).toFixed(2);
}

function switchWorkspaceTab(tabId) {
  currentWorkspaceTab = tabId;
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `tabPane_${tabId}`);
  });

  if (tabId === 'dubbing') {
    loadDubbingConfig();
    populateDubVideoSelect();
  } else if (tabId === 'capabilities') {
    loadCapabilitiesMatrix(false);
  } else if (tabId === 'account') {
    pollAccountScanStatus();
  } else if (tabId === 'ai') {
    loadAiConfig();
  }
}

async function init() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    platforms = (data.platforms || []).map((p, i) => ({
      ...p,
      index: p.index || i + 1,
      color: p.color || PLATFORM_COLORS[p.id] || '#2563eb'
    }));
    storageConfig = data.storage || null;
    systemCapabilities = data;
    renderTopbarEngineStatus(data);
    renderCapabilitiesFromData(data);
    updateFolderLabels();
    renderPlatforms();
    await Promise.allSettled([
      loadDownloads(),
      loadDubbingConfig()
    ]);

    if (data.probeState === 'checking' || data.checking === true) {
      pollCapabilitiesUntilReady();
    }
  } catch (e) {
    toast('Lỗi kết nối máy chủ nội bộ: ' + e.message, 'error');
  }

  const urlInput = document.getElementById('urlInput');
  if (urlInput) {
    urlInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      if (!val) return;
      for (const p of platforms) {
        if ((p.domains || []).some((d) => val.toLowerCase().includes(d))) {
          document.getElementById('detectedBadge').textContent = `Nhận diện: ${p.name}`;
          updateActivePlatformFolderDisplay(p.id);
          break;
        }
      }
    });

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') analyzeVideo();
    });
  }

  setInterval(() => {
    loadDownloads();
    if (document.getElementById('converterModal')?.classList.contains('open')) {
      loadConversions();
    }
    if (currentWorkspaceTab === 'account') {
      pollAccountScanStatus();
    }
    if (currentWorkspaceTab === 'dubbing') {
      loadDubbingConfig(true);
    }
    if (systemCapabilities?.probeState === 'checking' || systemCapabilities?.checking === true) {
      pollCapabilitiesUntilReady();
    }
  }, 1600);
}

let isPollingCapabilities = false;
async function pollCapabilitiesUntilReady() {
  if (isPollingCapabilities) return;
  isPollingCapabilities = true;
  try {
    for (let i = 0; i < 35; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch('/api/status');
      const data = await res.json();
      systemCapabilities = data;
      renderTopbarEngineStatus(data);
      renderCapabilitiesFromData(data);
      if (data.probeState === 'ready' || data.checking === false) {
        break;
      }
    }
  } catch (_) {}
  finally {
    isPollingCapabilities = false;
  }
}

function renderTopbarEngineStatus(data) {
  const badge = document.getElementById('engineStatusBadge');
  const dot = document.getElementById('engineStatusDot');
  const txt = document.getElementById('engineStatusText');
  const missingBtn = document.getElementById('missingToolsBtn');
  const missingCountEl = document.getElementById('missingToolsCount');
  if (!badge || !txt) return;

  const tools = data.tools || {};
  const readyTools = Object.values(tools).filter((t) => t && t.ready).length;
  const totalTools = Object.keys(tools).length || 5;
  const missingCritical = !tools.ytdlp?.ready || !tools.ffmpeg?.ready;
  const isChecking = data.probeState === 'checking' || data.checking === true;
  const missingTools = data.missingTools || [];

  if (missingTools.length > 0) {
    if (missingBtn) {
      missingBtn.style.display = 'inline-flex';
      if (missingCountEl) missingCountEl.textContent = String(missingTools.length);
    }
  } else if (missingBtn) {
    missingBtn.style.display = 'none';
  }

  if (isChecking && readyTools === 0) {
    badge.style.background = '#fefce8';
    badge.style.color = '#854d0e';
    badge.style.borderColor = '#fef08a';
    if (dot) dot.style.background = '#eab308';
    txt.textContent = `⏳ Đang kiểm tra công cụ nền...`;
    return;
  }

  if (missingCritical) {
    badge.style.background = '#fef2f2';
    badge.style.color = '#991b1b';
    badge.style.borderColor = '#fca5a5';
    if (dot) dot.style.background = '#dc2626';
    txt.textContent = `${data.osName || data.os}: Thiếu công cụ lõi (${readyTools}/${totalTools})`;
  } else {
    badge.style.background = '#ecfdf5';
    badge.style.color = '#047857';
    badge.style.borderColor = '#a7f3d0';
    if (dot) dot.style.background = '#10b981';
    const checkingSuffix = isChecking ? ' (Đang đồng bộ...)' : '';
    txt.textContent = `${data.osName || data.os}: ${readyTools}/${totalTools} công cụ sẵn sàng${checkingSuffix}`;
  }
}

function updateFolderLabels() {
  if (!storageConfig) return;
  const activeId = selectedPlatformId !== 'auto' ? selectedPlatformId : currentResult?.platform || null;
  updateActivePlatformFolderDisplay(activeId);
}

function updateActivePlatformFolderDisplay(platformId) {
  if (!storageConfig) return;
  const activeFolderPathEl = document.getElementById('activePlatformFolder');
  if (platformId && storageConfig.platforms && storageConfig.platforms[platformId]) {
    const pConf = storageConfig.platforms[platformId];
    if (activeFolderPathEl) activeFolderPathEl.textContent = pConf.effectiveDir;
  } else {
    if (activeFolderPathEl) activeFolderPathEl.textContent = `${storageConfig.rootDir}/<Thư_Mục_Từng_Nền_Tảng>`;
  }
}

function renderPlatforms() {
  const list = document.getElementById('platformList');
  if (!list) return;
  const totalFiles = Object.values(platformFileCounts).reduce((a, b) => a + b, 0);

  const autoHtml = `
    <div class="platform-item ${selectedPlatformId === 'auto' ? 'active' : ''}" onclick="selectPlatform('auto')">
      <span class="p-dot" style="background: #2563eb"></span>
      <div class="p-info">
        <div class="p-name">Tất cả nền tảng (Auto)</div>
        <div class="p-sub">Hiện toàn bộ (${totalFiles} file đã lưu)</div>
      </div>
      <span class="p-tag">ALL</span>
    </div>
  `;

  const itemsHtml = platforms
    .map((p) => {
      const folderName = storageConfig?.platforms?.[p.id]?.folderName || p.id;
      const isCustom = storageConfig?.platforms?.[p.id]?.isCustom;
      const count = platformFileCounts[p.id] || 0;
      return `
      <div class="platform-item ${selectedPlatformId === p.id ? 'active' : ''}" onclick="selectPlatform('${p.id}')">
        <span class="p-dot" style="background: ${p.color}"></span>
        <div class="p-info">
          <div class="p-name">${escapeHtml(p.name)}</div>
          <div class="p-sub">📁 ${escapeHtml(folderName)}${isCustom ? '*' : ''} • ${count} file</div>
        </div>
        <span class="p-tag">${count > 0 ? count : '#' + p.index}</span>
      </div>
    `;
    })
    .join('');

  list.innerHTML = autoHtml + itemsHtml;
}

function selectPlatform(id) {
  selectedPlatformId = id;
  renderPlatforms();
  const p = platforms.find((x) => x.id === id);
  const badge = document.getElementById('detectedBadge');
  if (badge) {
    badge.textContent = p
      ? `Đang chọn & Lọc: ${p.name}`
      : 'Chế độ: Tất cả nền tảng (Tự động nhận diện)';
  }
  updateActivePlatformFolderDisplay(id === 'auto' ? null : id);
  loadDownloads();
}

function selectMethod(method, btn) {
  selectedMethod = method;
  document.querySelectorAll('.method-pill').forEach((el) => el.classList.remove('active'));
  btn.classList.add('active');
}

async function pasteClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      const input = document.getElementById('urlInput');
      input.value = text;
      input.dispatchEvent(new Event('input'));
      toast('Đã dán link từ Clipboard');
    }
  } catch (e) {
    toast('Hãy nhấn Cmd+V / Ctrl+V vào ô nhập', 'warn');
  }
}

async function analyzeVideo() {
  const rawInput = document.getElementById('urlInput').value.trim();
  if (!rawInput) {
    toast('Vui lòng dán link hoặc văn bản chia sẻ video!', 'warn');
    return;
  }

  const btn = document.getElementById('analyzeBtn');
  const loader = document.getElementById('analyzeSpin');
  const text = document.getElementById('analyzeText');
  btn.disabled = true;
  loader.style.display = 'inline-block';
  text.textContent = 'Đang tự động bóc tách...';

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawInput,
        method: selectedMethod,
        platformId: selectedPlatformId
      })
    });
    const payload = await res.json();
    if (!payload.success) throw new Error(payload.error || 'Phân tích thất bại');

    currentResult = payload;
    selectedStreamIndex = 0;
    if (payload.platform) {
      updateActivePlatformFolderDisplay(payload.platform);
    }
    renderResult(payload);
    toast(`Đã trích xuất thành công từ ${payload.platformName}!`);
  } catch (e) {
    toast('Lỗi: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    loader.style.display = 'none';
    text.textContent = 'Trích xuất & Tải';
  }
}

function renderResult(payload) {
  document.getElementById('resultCard').classList.add('visible');
  const info = payload.data || {};
  const color = PLATFORM_COLORS[payload.platform] || '#2563eb';

  const pTag = document.getElementById('resPlatformTag');
  pTag.textContent = payload.platformName || payload.platform;
  pTag.style.background = color + '18';
  pTag.style.color = color;

  document.getElementById('resStrategyTag').textContent = `Engine: ${info.engine || 'Auto'}`;
  document.getElementById('resMethodTag').textContent = `Chế độ: ${(payload.selectedMethod || 'auto').toUpperCase()}`;
  document.getElementById('resIdTag').textContent = info.videoId ? `ID: ${info.videoId}` : '';

  document.getElementById('resTitle').textContent = info.title || 'Không có tiêu đề';
  document.getElementById('resAuthor').textContent = info.author || 'Unknown';
  document.getElementById('resDuration').textContent = fmtDur(info.duration);
  document.getElementById('resViews').textContent = fmtNum(info.stats?.views || info.stats?.playCount);
  document.getElementById('resLikes').textContent = fmtNum(info.stats?.likes || info.stats?.diggCount);
  document.getElementById('resComments').textContent = fmtNum(info.stats?.comments || info.stats?.commentCount);

  const saveDirEl = document.getElementById('resSaveFolder');
  if (saveDirEl) {
    saveDirEl.textContent = payload.saveDir || storageConfig?.platforms?.[payload.platform]?.effectiveDir || '';
  }

  const synthWrap = document.getElementById('synthesizedLinksBox');
  if (synthWrap && payload.synthesizedLinks) {
    const links = payload.synthesizedLinks;
    synthWrap.innerHTML = `
      <div class="synth-row">
        <span class="synth-badge">Clean Link</span>
        <input class="synth-input" readonly value="${escapeHtml(links.cleanUrl || '')}" />
        <button class="btn-mini" onclick="copyText('${escapeHtml(links.cleanUrl || '')}')">Copy</button>
      </div>
      <div class="synth-row">
        <span class="synth-badge utm">Auto-UTM</span>
        <input class="synth-input" readonly value="${escapeHtml(links.utmUrl || links.mobileUrl || '')}" />
        <button class="btn-mini" onclick="copyText('${escapeHtml(links.utmUrl || links.mobileUrl || '')}')">Copy</button>
      </div>
      ${
        links.embedUrl
          ? `
      <div class="synth-row">
        <span class="synth-badge embed">oEmbed</span>
        <input class="synth-input" readonly value="${escapeHtml(links.embedUrl)}" />
        <button class="btn-mini" onclick="copyText('${escapeHtml(links.embedUrl)}')">Copy</button>
      </div>`
          : ''
      }
    `;
  }

  renderPreviewStage(payload, selectedStreamIndex);

  const sList = document.getElementById('streamsList');
  const streams = info.formats || [];
  document.getElementById('streamCountLabel').textContent = `${streams.length} luồng khả dụng`;

  if (streams.length === 0) {
    sList.innerHTML = `<div class="empty-hint">Hệ thống sẽ tự động tải qua yt-dlp / WebKit Sniffer khi bấm Tải Video.</div>`;
  } else {
    sList.innerHTML = streams
      .map((s, idx) => {
        const isDirect =
          s.url && !s.url.includes('bilibili.com/video') && !s.url.includes('youku.com/v_show') && !s.isDashM4s;
        return `
        <div class="stream-item ${idx === selectedStreamIndex ? 'selected' : ''}" onclick="selectStream(${idx})">
          <div>
            <span class="s-badge ${s.ext === 'm3u8' ? 'hls' : ''}">${escapeHtml((s.ext || 'mp4').toUpperCase())}</span>
            <span class="s-quality">${escapeHtml(s.quality || 'HD')}</span>
            <span class="s-meta">${s.width ? `${s.width}x${s.height}` : ''}</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            ${
              isDirect && s.ext !== 'm3u8'
                ? `<button class="btn-sm" onclick="event.stopPropagation(); previewStreamIndex(${idx})">▶ Xem thử</button>`
                : ''
            }
            <button class="btn-sm" onclick="event.stopPropagation(); copyStreamUrl(${idx})">📋 Copy URL</button>
          </div>
        </div>
      `;
      })
      .join('');
  }
}

function renderPreviewStage(payload, streamIdx = 0) {
  const stage = document.getElementById('previewStage');
  const info = payload.data || {};
  const streams = info.formats || [];
  const chosen = streams[streamIdx] || streams[0];
  const referer = info.downloadHeaders?.Referer || payload.resolvedUrl || '';
  const coverProxy = info.cover
    ? `/api/proxy-media?url=${encodeURIComponent(info.cover)}&referer=${encodeURIComponent(referer)}`
    : '';

  const playUrl = chosen?.url || info.directVideoUrl || '';
  const canPlayDirect =
    playUrl &&
    !chosen?.isDashM4s &&
    !playUrl.includes('.m4s') &&
    (playUrl.includes('.mp4') ||
      playUrl.includes('douyinvod') ||
      playUrl.includes('xhscdn') ||
      playUrl.includes('kwaicdn') ||
      playUrl.includes('kwimgs') ||
      playUrl.includes('ppx')) &&
    chosen?.ext !== 'm3u8';

  if (canPlayDirect) {
    const videoProxy = `/api/proxy-media?url=${encodeURIComponent(playUrl)}&referer=${encodeURIComponent(referer)}`;
    stage.innerHTML = `
      <video controls autoplay playsinline poster="${coverProxy}">
        <source src="${videoProxy}" type="video/mp4">
      </video>
      <div class="preview-toolbar">
        ${payload.embedUrl ? `<button class="preview-pill" onclick="switchToOembed()">🌐 Chuyển sang oEmbed Player</button>` : ''}
      </div>
    `;
  } else if (info.cover) {
    stage.innerHTML = `
      <img class="cover-img" src="${coverProxy}" alt="Cover" onerror="this.style.display='none'" />
      <div class="preview-toolbar">
        ${payload.embedUrl ? `<button class="preview-pill" onclick="switchToOembed()">▶ Mở oEmbed Player</button>` : ''}
      </div>
    `;
  } else if (payload.embedUrl) {
    switchToOembed();
  } else {
    stage.innerHTML = `<div style="color:#94a3b8;font-size:13px;padding:20px;text-align:center;">Nhấn "Tải về Thư mục Nền tảng" để tải và phát trực tiếp từ ổ cứng</div>`;
  }
}

function previewStreamIndex(idx) {
  if (!currentResult) return;
  selectedStreamIndex = idx;
  renderPreviewStage(currentResult, idx);
}

function switchToOembed() {
  if (!currentResult?.embedUrl) return;
  const stage = document.getElementById('previewStage');
  stage.innerHTML = `
    <iframe src="${currentResult.embedUrl}" allowfullscreen allow="autoplay; encrypted-media"></iframe>
    <div class="preview-toolbar">
      <button class="preview-pill" onclick="renderPreviewStage(currentResult, selectedStreamIndex)">🔙 Quay lại Preview gốc</button>
    </div>
  `;
}

function selectStream(idx) {
  selectedStreamIndex = idx;
  renderResult(currentResult);
}

function copyText(txt) {
  if (!txt) return;
  navigator.clipboard.writeText(txt);
  toast('Đã sao chép vào Clipboard!');
}

function copyStreamUrl(idx) {
  const s = currentResult?.data?.formats?.[idx];
  if (s?.url) {
    navigator.clipboard.writeText(s.url);
    toast('Đã sao chép URL luồng video!');
  }
}

function exportMetadataJson() {
  if (!currentResult) return;
  const blob = new Blob([JSON.stringify(currentResult, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentResult.platform}_${currentResult.data?.videoId || Date.now()}_metadata.json`;
  a.click();
  toast('Đã xuất file JSON Metadata!');
}

let isTriggeringDownload = false;
async function triggerDownload() {
  if (!currentResult || isTriggeringDownload) return;
  isTriggeringDownload = true;

  const dlBtn = document.getElementById('downloadMainBtn');
  if (dlBtn) dlBtn.disabled = true;

  const info = currentResult.data || {};
  const streams = info.formats || [];
  const chosen = streams[selectedStreamIndex] || streams[0] || null;
  const directUrl =
    chosen && chosen.ext !== 'm3u8' && !chosen.isDashM4s && chosen.url ? chosen.url : info.directVideoUrl || '';
  const outputFormat = document.getElementById('downloadFormatSelect')?.value || 'mp4';

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: currentResult.platform || 'douyin',
        title: info.title || 'video',
        videoId: info.videoId || '',
        directVideoUrl: directUrl,
        targetUrl: currentResult.synthesizedLinks?.cleanUrl || currentResult.resolvedUrl,
        formatId: chosen?.formatId || '',
        hasAudio: chosen ? chosen.hasAudio : true,
        requiresYtDlpMerge: Boolean(info.requiresYtDlpMerge || chosen?.isDashM4s || chosen?.hasAudio === false),
        outputFormat,
        headers: chosen?.headers || info.downloadHeaders || {},
        metadata: currentResult
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không thể bắt đầu tải');

    if (data.alreadyDownloading) {
      toast('⚠️ Video này đang được tải xuống rồi! Bạn có thể nhấn "Dừng / Hủy tải" ở bên dưới.', 'warn');
    } else {
      const folderName =
        storageConfig?.platforms?.[currentResult.platform]?.folderName || currentResult.platformName || '';
      toast(`🚀 Đang tải & xác minh (.${outputFormat.toUpperCase()}) vào thư mục [${folderName}]...`);
    }
    loadDownloads();
  } catch (e) {
    toast('Lỗi khởi tạo tải: ' + e.message, 'error');
  } finally {
    setTimeout(() => {
      isTriggeringDownload = false;
      if (dlBtn) dlBtn.disabled = false;
    }, 500);
  }
}

async function cancelDownload(jobId) {
  try {
    const res = await fetch('/api/download/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId })
    });
    const data = await res.json();
    if (data.success) {
      toast('🛑 Đã dừng tác vụ tải/chuyển đổi.', 'warn');
      loadDownloads();
    } else {
      toast('Không thể hủy: ' + (data.message || ''), 'error');
    }
  } catch (e) {
    toast('Lỗi khi hủy tải: ' + e.message, 'error');
  }
}

async function removeDownload(jobId, filePath, deleteFromDisk = false) {
  try {
    await fetch('/api/download/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, filePath, deleteFromDisk })
    });
    loadDownloads();
  } catch (e) {
    toast('Lỗi xóa mục: ' + e.message, 'error');
  }
}

/**
 * Hiển thị danh sách Tiến trình tải & File có sẵn — Tự động LỌC RIÊNG theo nền tảng đang chọn ở Sidebar
 */
async function loadDownloads() {
  try {
    const res = await fetch('/api/downloads');
    const data = await res.json();
    const list = document.getElementById('downloadsList');
    const allJobs = data.activeJobs || [];
    const allFiles = data.savedFiles || [];
    allSavedFilesCache = allFiles;

    if (data.batchQueue) {
      const bq = data.batchQueue;
      const bqEl = document.getElementById('batchQueueBadge');
      if (bqEl) {
        bqEl.textContent = `Hàng đợi: ${bq.pendingCount || 0} chờ • ${bq.runningCount || 0} đang chạy (Tối đa ${bq.maxConcurrent || 2} luồng)`;
      }
    }

    const counts = {};
    for (const f of allFiles) {
      counts[f.platformId] = (counts[f.platformId] || 0) + 1;
    }
    const countsChanged = JSON.stringify(counts) !== JSON.stringify(platformFileCounts);
    platformFileCounts = counts;
    if (countsChanged) {
      renderPlatforms();
      if (currentWorkspaceTab === 'dubbing') {
        populateDubVideoSelect();
      }
    }

    const isFiltered = selectedPlatformId !== 'auto';
    const selectedPlatformObj = platforms.find((p) => p.id === selectedPlatformId);

    const jobs = isFiltered ? allJobs.filter((j) => j.platform === selectedPlatformId) : allJobs;
    const files = isFiltered ? allFiles.filter((f) => f.platformId === selectedPlatformId) : allFiles;

    const titleEl = document.getElementById('dlSectionTitle');
    const badgeEl = document.getElementById('dlFilterBadge');
    const showAllBtn = document.getElementById('showAllFilterBtn');

    if (isFiltered && selectedPlatformObj) {
      if (titleEl) titleEl.textContent = `Tiến trình tải & Video có sẵn của ${selectedPlatformObj.name}`;
      if (badgeEl) {
        badgeEl.textContent = `Đang lọc riêng: ${selectedPlatformObj.name}`;
        badgeEl.style.background = (selectedPlatformObj.color || '#2563eb') + '18';
        badgeEl.style.color = selectedPlatformObj.color || '#2563eb';
      }
      if (showAllBtn) showAllBtn.style.display = 'inline-flex';
    } else {
      if (titleEl) titleEl.textContent = 'Tiến trình tải & Video có sẵn (Tất cả 12 nền tảng)';
      if (badgeEl) {
        badgeEl.textContent = 'Đang hiện: Tất cả nền tảng';
        badgeEl.style.background = '';
        badgeEl.style.color = '';
      }
      if (showAllBtn) showAllBtn.style.display = 'none';
    }

    const runningCount = jobs.filter((j) => j.status === 'downloading').length;
    document.getElementById('dlStatLabel').textContent = `${runningCount} đang tải • ${files.length} file có sẵn`;

    if (jobs.length === 0 && files.length === 0) {
      list.innerHTML = isFiltered
        ? `<div class="empty-hint">Chưa có video nào được tải của nền tảng <strong>${escapeHtml(selectedPlatformObj?.name || selectedPlatformId)}</strong>.<br/><span style="font-size:12px;color:#64748b;">Hãy dán link ${escapeHtml(selectedPlatformObj?.name || '')} ở trên để tải, hoặc bấm "Hiện tất cả 12 nền tảng".</span></div>`
        : `<div class="empty-hint">Chưa có lịch sử tải xuống.</div>`;
      return;
    }

    const activeFileNames = new Set(jobs.map((j) => j.fileName));

    const jobsHtml = jobs
      .map((j) => {
        const pName = j.platformName || j.platform?.toUpperCase() || '';
        const isRunning = j.status === 'downloading';
        const isCancelled = j.status === 'cancelled';
        const isDone = j.status === 'completed';
        const isFailed = j.status === 'failed';
        const extUpper = (j.ext || j.desiredFormat || 'mp4').toUpperCase();

        return `
        <div class="dl-item">
          <div class="dl-info">
            <div class="dl-name">
              <span class="dl-platform-tag">${escapeHtml(pName)}</span>
              <span class="s-badge" style="margin-right:2px;">.${escapeHtml(extUpper)}</span>
              ${escapeHtml(j.title || j.fileName)}
            </div>
            <div class="dl-sub">
              ${isRunning ? `🔄 Đang xử lý (${j.progress || 0}% • ${escapeHtml(j.speedText || '')}) — Lưu tại: ${escapeHtml(j.saveDir || '')}` : ''}
              ${isDone ? `✅ Hoàn tất (${fmtSizeMB(j.totalBytes)} MB • ${escapeHtml(j.audioStatusText || 'Đã xác minh')}) — 📁 ${escapeHtml(j.outputPath || '')}` : ''}
              ${isCancelled ? `🛑 ${escapeHtml(j.error || j.speedText || 'Đã dừng / hủy tải theo yêu cầu')}` : ''}
              ${isFailed ? `❌ Lỗi: ${escapeHtml(j.error || 'Không xác định')}` : ''}
            </div>
          ${isRunning ? `<div class="progress-bar"><div class="progress-fill" style="width:${j.progress || 5}%"></div></div>` : ''}
          </div>
          <div class="dl-actions">
            ${
              isRunning
                ? `<button class="btn-danger-sm" onclick="cancelDownload('${escapeHtml(j.jobId)}')">⏹ Dừng / Hủy</button>`
                : ''
            }
            ${
              isDone && j.outputPath
                ? `
              <button class="btn-sm" onclick="playDownloadedVideo('${escapeHtml(j.outputPath)}', '${escapeHtml(j.title || j.fileName)}')">▶ Phát</button>
              <button class="btn-sm" style="border-color:#a7f3d0;color:#047857;" onclick="openDubbingForFile('${escapeHtml(j.outputPath)}')">🎙️ Lồng tiếng</button>
              <button class="btn-sm" onclick="openConverterForFile('${escapeHtml(j.outputPath)}')">🔄 Đổi định dạng</button>
              <button class="btn-sm" onclick="openFileInFinder('${escapeHtml(j.outputPath)}')">📂 Mở thư mục</button>
            `
                : ''
            }
            ${
              !isRunning
                ? `<button class="btn-icon-sm" title="Xóa khỏi danh sách hiển thị" onclick="removeDownload('${escapeHtml(j.jobId)}', '', false)">✕</button>`
                : ''
            }
          </div>
        </div>
      `;
      })
      .join('');

    const filesHtml = files
      .filter((f) => !activeFileNames.has(f.fileName))
      .map((f) => {
        const pName = f.platformName || f.folderName || f.platformId || 'Root';
        const extUpper = (f.ext || 'mp4').toUpperCase();
        const dubBadge = f.isDubbed
          ? `<span class="cap-pill verified" style="margin-right:4px;">🎙️ ${escapeHtml(f.audioStatusText || 'Bản Lồng Tiếng')}</span>`
          : f.audioStatusText
          ? `<span class="badge" style="font-size:10px;">${escapeHtml(f.audioStatusText)}</span>`
          : '';
        return `
          <div class="dl-item">
            <div class="dl-info">
              <div class="dl-name">
                <span class="dl-platform-tag">${escapeHtml(pName)}</span>
                <span class="s-badge" style="margin-right:2px;">${escapeHtml(extUpper)}</span>
                ${dubBadge}
                ${escapeHtml(f.fileName)}
              </div>
              <div class="dl-sub">📦 ${fmtSizeMB(f.fileSize)} MB • 📁 ${escapeHtml(f.filePath)}</div>
            </div>
            <div class="dl-actions">
              <button class="btn-sm" onclick="playDownloadedVideo('${escapeHtml(f.filePath)}', '${escapeHtml(f.fileName)}')">▶ Phát</button>
              ${
                !f.isDubbed && (f.ext === 'mp4' || f.ext === 'mov' || f.ext === 'mkv' || f.ext === 'webm')
                  ? `<button class="btn-sm" style="border-color:#a7f3d0;color:#047857;" onclick="openDubbingForFile('${escapeHtml(f.filePath)}')">🎙️ Lồng tiếng</button>`
                  : ''
              }
              <button class="btn-sm" style="border-color:#93c5fd;color:#1d4ed8;" onclick="openConverterForFile('${escapeHtml(f.filePath)}')">🔄 Đổi định dạng</button>
              <button class="btn-sm" onclick="openFileInFinder('${escapeHtml(f.filePath)}')">📂 Hiện file</button>
              <button class="btn-icon-sm" title="Xóa file khỏi ổ cứng" onclick="if(confirm('Xóa file video này khỏi ổ cứng?')) removeDownload('', '${escapeHtml(f.filePath)}', true)">🗑</button>
            </div>
          </div>
        `;
      })
      .join('');

    list.innerHTML = jobsHtml + filesHtml;
  } catch (e) {
    console.error("[loadDownloads] Lỗi hiển thị danh sách tải:", e);
  }
}

function playDownloadedVideo(filePath, title) {
  switchWorkspaceTab('single');
  document.getElementById('resultCard').classList.add('visible');
  const stage = document.getElementById('previewStage');
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'gif') {
    stage.innerHTML = `<img class="cover-img" src="/api/play-local?path=${encodeURIComponent(filePath)}" />`;
  } else {
    stage.innerHTML = `
      <video controls autoplay playsinline src="/api/play-local?path=${encodeURIComponent(filePath)}"></video>
    `;
  }
  if (title) document.getElementById('resTitle').textContent = title;
  toast('Đang phát trực tiếp file từ ổ cứng!');
}

async function openDownloadsFolder(platformId = null) {
  try {
    const activePid =
      platformId || (selectedPlatformId !== 'auto' ? selectedPlatformId : currentResult?.platform || null);
    await fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platformId: activePid })
    });
  } catch (_) {}
}

async function openFileInFinder(filePath) {
  try {
    await fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath })
    });
  } catch (_) {}
}

// ================= TAB 2: QUÉT DANH SÁCH VIDEO TÀI KHOẢN & TẢI HÀNG LOẠT =================
function toggleAccountCookieBox() {
  const checked = document.getElementById('accConsentCookieCheck')?.checked;
  const wrap = document.getElementById('accCookieInputWrap');
  if (wrap) wrap.style.display = checked ? 'block' : 'none';
}

function toggleCookieVisibility() {
  const input = document.getElementById('accCookieInput');
  if (!input) return;
  if (input.tagName === 'TEXTAREA') {
    input.classList.toggle('masked');
  } else {
    input.type = input.type === 'password' ? 'text' : 'password';
  }
}

function validateCurrentCookieInput() {
  const cookie = (document.getElementById('accCookieInput')?.value || '').trim();
  const platformId = document.getElementById('accPlatformSelect')?.value || 'auto';
  const hint = document.getElementById('accCookieStatusHint');
  if (!hint) return;

  if (!cookie) {
    hint.innerHTML = '<span style="color:#b91c1c;font-weight:600;">Chưa có Cookie nào được nhập.</span>';
    return;
  }

  let format = 'Chuỗi Header tiêu chuẩn (key=val)';
  if ((cookie.startsWith('[') && cookie.endsWith(']')) || (cookie.startsWith('{') && cookie.endsWith('}'))) {
    format = 'JSON Cookie';
  } else if (/^curl\s+/i.test(cookie)) {
    format = 'Lệnh cURL (Tự tách Header Cookie)';
  } else if (cookie.includes('\t') || cookie.includes('#HttpOnly_') || cookie.includes('# Netscape') || cookie.includes('.douyin.com')) {
    format = 'Netscape cookies.txt (Giữ nguyên các dòng #HttpOnly_)';
  }

  const hasDouyinAuth = /(sessionid|sessionid_ss|sid_tt|uid_tt|ttwid)=/i.test(cookie) || /sessionid|sid_tt|ttwid/i.test(cookie);
  const hasDoubleQuotes = (cookie.startsWith('"') && cookie.endsWith('"')) || (cookie.startsWith("'") && cookie.endsWith("'"));
  hint.innerHTML = `
    <span style="color:#047857;font-weight:600;">✓ Định dạng nhận diện: ${format}</span>
    ${hasDouyinAuth ? ' • <span style="color:#047857;">✓ Phát hiện khóa phiên (sessionid/ttwid)</span>' : ''}
    ${hasDoubleQuotes ? ' • <span style="color:#d97706;">Lưu ý: Sẽ tự động loại bỏ cặp dấu nháy thừa ở 2 đầu.</span>' : ''}
    <div style="margin-top:3px;color:#475569;font-size:11px;">
      🔒 <strong>Bảo vệ an toàn:</strong> Cookie chỉ giữ trong bộ nhớ phiên, KHÔNG ghi vào file log hay metadata, và chỉ được đính kèm khi gửi request tới đúng miền của nền tảng <code>${escapeHtml(platformId.toUpperCase())}</code>.
    </div>
  `;
}

async function openUrlInExternalBrowser(url) {
  if (!url) return;
  try {
    const res = await fetch('/api/open-external-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không thể mở URL');
    toast('🌐 Đã mở trang trong trình duyệt mặc định để bạn tự xác minh, sau đó hãy dán Cookie mới vào đây.');
  } catch (e) {
    toast('Lỗi mở trình duyệt: ' + e.message, 'error');
  }
}

function renderAccountPreviewBox(data) {
  const box = document.getElementById('accPreviewBox');
  if (!box || !data) return;
  box.style.display = 'block';

  const statusMap = {
    verified: { code: 'verified', label: 'đã kiểm tra' },
    supported: { code: 'verified', label: 'đã kiểm tra' },
    conditional: { code: 'conditional', label: 'có điều kiện' },
    unsupported: { code: 'unsupported', label: 'chưa hỗ trợ quét tài khoản' },
    missing_tool: { code: 'missing_tool', label: 'thiếu công cụ' }
  };
  const st = statusMap[data.statusCode || data.supportStatus] || { code: 'conditional', label: data.supportLabel || 'có điều kiện' };

  const acc = data.account || {};
  const hasProfile = Boolean(data.profileIdentified ?? acc.profileIdentified);
  const profileUrl = data.profileUrl || acc.profileUrl || '';
  const avatarHtml = acc.avatar
    ? `<img src="/api/proxy-media?url=${encodeURIComponent(acc.avatar)}&referer=${encodeURIComponent(profileUrl)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid #e2e8f0;flex-shrink:0;" onerror="this.style.display='none'" />`
    : `<div style="width:48px;height:48px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">👤</div>`;

  const cookieHintHtml = data.cookieStatus?.provided
    ? `<div style="font-size:11.5px;color:${data.cookieStatus.valid ? (data.cookieStatus.verifiedAuth ? '#047857' : '#b45309') : '#b91c1c'};margin-top:3px;">
        🔐 Trạng thái Cookie: <strong>${data.cookieStatus.valid ? escapeHtml(data.cookieStatus.message || 'Hợp lệ & Đã áp dụng cho phiên này') : 'Không hợp lệ: ' + escapeHtml(data.cookieStatus.message || '')}</strong>
       </div>`
    : '';

  const profileStatusBadge = hasProfile
    ? `<span class="cap-pill verified" style="font-size:11px;">✓ Đã xác minh thông tin hồ sơ</span>`
    : `<span class="cap-pill conditional" style="font-size:11px;">⚠️ Chỉ phân tích URL mục tiêu (Chưa xác minh hồ sơ chi tiết)</span>`;

  const captchaBtnHtml =
    data.hasCaptcha && profileUrl
      ? `<button type="button" class="btn-outline" style="height:36px;padding:0 12px;" data-url="${escapeHtml(profileUrl)}" onclick="openUrlInExternalBrowser(this.dataset.url)">🌐 Mở trang trên Trình duyệt</button>`
      : '';

  const canScan = data.canStartScan !== false;
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div style="display:flex;align-items:center;gap:12px;min-width:0;flex:1 1 340px;">
        ${avatarHtml}
        <div style="min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:14px;font-weight:700;color:#0f172a;">${escapeHtml(acc.accountName || data.displayHandle || 'Tài khoản')}</span>
            <span class="badge primary">${escapeHtml(data.platformName || '')}</span>
            ${renderCapPillHtml(st.code, data.supportLabel || st.label)}
            ${profileStatusBadge}
          </div>
          <div style="font-size:12px;color:#475569;margin-top:2px;">
            🆔 UID: <code>${escapeHtml(acc.accountId || data.accountId || 'Chưa rõ')}</code>
            ${acc.videoCount !== null && acc.videoCount !== undefined ? ` • 📹 ${fmtNum(acc.videoCount)} video` : ''}
            ${acc.followerCount !== null && acc.followerCount !== undefined ? ` • 👥 ${fmtNum(acc.followerCount)} người theo dõi` : ''}
          </div>
          <div style="font-size:11.5px;color:#64748b;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:550px;">
            🔗 <code>${escapeHtml(profileUrl)}</code>
          </div>
          ${cookieHintHtml}
          ${
            data.reason
              ? `<div style="font-size:11.5px;color:${canScan ? '#047857' : '#b91c1c'};margin-top:4px;font-weight:600;">ℹ️ ${escapeHtml(data.reason)}</div>`
              : ''
          }
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        ${captchaBtnHtml}
        ${
          canScan
            ? `<button class="btn-primary" style="height:38px;padding:0 18px;" onclick="startAccountScan(false)">🚀 Bắt đầu Quét Ngay</button>`
            : `<span class="cap-pill unsupported">Nền tảng này chỉ hỗ trợ tải video lẻ</span>`
        }
      </div>
    </div>
  `;
}

function renderCapPillHtml(statusCode, statusLabel) {
  const cls = ['verified', 'conditional', 'unsupported', 'missing_tool'].includes(statusCode)
    ? statusCode
    : 'conditional';
  return `<span class="cap-pill ${cls}">${escapeHtml(statusLabel || statusCode)}</span>`;
}

async function previewAccount() {
  const rawInput = document.getElementById('accInputUrl')?.value.trim();
  const platformId = document.getElementById('accPlatformSelect')?.value || 'auto';
  const userConsentedCookie = Boolean(document.getElementById('accConsentCookieCheck')?.checked);
  const cookie = userConsentedCookie ? (document.getElementById('accCookieInput')?.value || '').trim() : '';

  if (!rawInput) {
    toast('Vui lòng nhập URL trang tài khoản hoặc UID người dùng!', 'warn');
    return;
  }

  try {
    toast('🔍 Đang kiểm tra URL & thông tin hồ sơ tài khoản...');
    const res = await fetch('/api/account/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawInput, platformId, cookie, userConsentedCookie })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không thể nhận diện hồ sơ');
    renderAccountPreviewBox(data);
  } catch (e) {
    toast('Lỗi nhận diện tài khoản: ' + e.message, 'error');
  }
}

async function startAccountScan(refresh = false) {
  const rawInput = document.getElementById('accInputUrl')?.value.trim();
  const platformId = document.getElementById('accPlatformSelect')?.value || 'auto';
  const maxPages = parseInt(document.getElementById('accMaxPages')?.value || '2', 10);
  const userConsentedCookie = Boolean(document.getElementById('accConsentCookieCheck')?.checked);
  const cookie = userConsentedCookie ? (document.getElementById('accCookieInput')?.value || '').trim() : '';

  if (!rawInput) {
    toast('Vui lòng nhập URL trang tài khoản hoặc UID!', 'warn');
    return;
  }

  try {
    const res = await fetch('/api/account/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawInput,
        platformId,
        maxPages,
        refresh,
        existingScanId: refresh ? null : currentAccountScan?.scanId || null,
        userConsentedCookie,
        cookie
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không thể quét tài khoản');

    currentAccountScan = data.scan;
    if (refresh) selectedAccountVideoKeys.clear();
    renderAccountScanStatus(currentAccountScan);
    renderAccountVideos();
    toast('🚀 Đang mở trình duyệt nền & quét hồ sơ tài khoản...');
  } catch (e) {
    toast('Lỗi quét tài khoản: ' + e.message, 'error');
  }
}

async function continueAccountScan() {
  if (!currentAccountScan) {
    return startAccountScan(false);
  }
  const rawInput = currentAccountScan.profileUrl || document.getElementById('accInputUrl')?.value.trim();
  const maxPages = parseInt(document.getElementById('accMaxPages')?.value || '2', 10);
  const userConsentedCookie = Boolean(document.getElementById('accConsentCookieCheck')?.checked);
  const cookie = userConsentedCookie ? document.getElementById('accCookieInput')?.value.trim() || '' : '';

  try {
    const res = await fetch('/api/account/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawInput,
        platformId: currentAccountScan.platformId,
        maxPages,
        refresh: false,
        existingScanId: currentAccountScan.scanId,
        userConsentedCookie,
        cookie
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không thể tiếp tục quét');
    currentAccountScan = data.scan;
    renderAccountScanStatus(currentAccountScan);
    toast('➕ Đang quét tiếp các trang tiếp theo...');
  } catch (e) {
    toast('Lỗi quét tiếp: ' + e.message, 'error');
  }
}

async function cancelAccountScan() {
  if (!currentAccountScan?.scanId) return;
  try {
    await fetch('/api/account/scan/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId: currentAccountScan.scanId })
    });
    toast('🛑 Đã dừng quét tài khoản.', 'warn');
    pollAccountScanStatus();
  } catch (e) {
    toast('Lỗi hủy quét: ' + e.message, 'error');
  }
}

async function pollAccountScanStatus() {
  try {
    const q = currentAccountScan?.scanId ? `?scanId=${encodeURIComponent(currentAccountScan.scanId)}` : '';
    const res = await fetch(`/api/account/scan/status${q}`);
    const data = await res.json();
    if (!data.success) return;

    if (data.batchQueue) {
      const bq = data.batchQueue;
      const bqEl = document.getElementById('batchQueueBadge');
      if (bqEl) {
        bqEl.textContent = `Hàng đợi: ${bq.pendingCount || 0} chờ • ${bq.runningCount || 0} đang chạy (Tối đa ${bq.maxConcurrent || 2} luồng)`;
      }
    }

    if (data.scan) {
      const prevCount = currentAccountScan?.videos?.length || 0;
      const prevStatus = currentAccountScan?.status || '';
      currentAccountScan = data.scan;
      renderAccountScanStatus(currentAccountScan);
      if ((currentAccountScan.videos?.length || 0) !== prevCount || currentAccountScan.status !== prevStatus) {
        renderAccountVideos();
      }
    }
  } catch (_) {}
}

function renderAccountScanStatus(scan) {
  const bar = document.getElementById('accScanStatusBar');
  if (!bar || !scan) return;
  bar.style.display = 'block';

  document.getElementById('accScanTitleText').textContent = `[${scan.platformName}] @${scan.accountName || scan.displayHandle} — ${scan.statusText || scan.status}`;
  document.getElementById('accScanSubText').textContent = `Đã thu thập: ${scan.totalFound || 0} video không trùng • Đã quét ${scan.scannedPages || 0} trang${scan.error ? ' • Lưu ý: ' + scan.error : ''}`;
  document.getElementById('accScanProgressFill').style.width = `${scan.progress || 0}%`;

  const cancelBtn = document.getElementById('accCancelScanBtn');
  if (cancelBtn) cancelBtn.style.display = scan.status === 'scanning' ? 'inline-flex' : 'none';
  bar.classList.toggle('scan-failed', scan.status === 'failed');

  const logBox = document.getElementById('accScanLogBox');
  if (logBox) {
    logBox.textContent = (scan.logs || [])
      .map((l) => `[${String(l.at || '').slice(11, 19)}] ${l.msg}`)
      .join('\n');
    logBox.scrollTop = logBox.scrollHeight;
  }
  const logDetails = document.getElementById('accScanLogDetails');
  if (logDetails && scan.status === 'failed') logDetails.open = true;

  // Cập nhật lại khung hồ sơ theo kết quả quét thực tế vừa lấy được từ WebKitSniffer
  if (scan.account || scan.hasCaptcha) {
    renderAccountPreviewBox({
      platformName: scan.platformName,
      statusCode: scan.hasCaptcha ? 'conditional' : scan.account?.profileIdentified ? 'verified' : 'conditional',
      supportLabel: scan.hasCaptcha ? 'yêu cầu CAPTCHA' : scan.account?.profileIdentified ? 'đã nhận diện' : 'đang phân tích',
      profileIdentified: Boolean(scan.account?.profileIdentified),
      hasCaptcha: Boolean(scan.hasCaptcha),
      canStartScan: true,
      profileUrl: scan.profileUrl || scan.account?.profileUrl || '',
      accountId: scan.account?.accountId || '',
      displayHandle: scan.displayHandle,
      cookieStatus: scan.cookieStatus,
      account: scan.account,
      reason: scan.statusText
    });
  }
}

function renderAccountVideos() {
  const wrap = document.getElementById('accVideosContainer');
  if (!wrap) return;
  const videos = currentAccountScan?.videos || [];

  const searchQ = (document.getElementById('accSearchInput')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('accFilterStatus')?.value || 'all';
  const sortBy = document.getElementById('accSortBy')?.value || 'newest';

  let filtered = videos.filter((v) => {
    if (searchQ && !String(v.title || '').toLowerCase().includes(searchQ) && !String(v.videoId || '').toLowerCase().includes(searchQ)) {
      return false;
    }
    if (statusFilter === 'downloadable' && !v.downloadable) return false;
    if (statusFilter === 'restricted' && v.downloadable) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (sortBy === 'views') return (b.views || 0) - (a.views || 0);
    if (sortBy === 'duration') return (b.duration || 0) - (a.duration || 0);
    return String(b.publishDate || '').localeCompare(String(a.publishDate || ''));
  });

  document.getElementById('accSelectedCountBadge').textContent = `Đã chọn: ${selectedAccountVideoKeys.size}`;

  if (filtered.length === 0) {
    wrap.innerHTML = `<div class="empty-hint">${
      currentAccountScan
        ? escapeHtml(currentAccountScan.error || 'Không có video nào khớp bộ lọc.')
        : 'Hãy nhập URL trang tài khoản ở trên và nhấn "Nhận diện Hồ sơ" hoặc "Quét Video".'
    }</div>`;
    return;
  }

  wrap.innerHTML = filtered
    .map((v) => {
      const checked = selectedAccountVideoKeys.has(v.uniqueKey) ? 'checked' : '';
      return `
      <div class="dl-item">
        <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
          <input
            type="checkbox"
            ${checked}
            ${v.downloadable ? '' : 'disabled'}
            onchange="toggleSelectAccountVideo('${escapeHtml(v.uniqueKey)}', this.checked)"
            style="width:16px;height:16px;cursor:pointer;"
          />
          <div class="dl-info">
            <div class="dl-name">
              <span class="dl-platform-tag">${escapeHtml(v.platformId.toUpperCase())}</span>
              <span class="cap-pill ${v.downloadable ? 'verified' : 'unsupported'}">${escapeHtml(v.downloadStatusText || (v.downloadable ? 'Tải được' : 'Giới hạn'))}</span>
              ${escapeHtml(v.title)}
            </div>
            <div class="dl-sub">
              🆔 <code>${escapeHtml(v.videoId)}</code> • ⏱️ ${fmtDur(v.duration)} • 👁️ ${fmtNum(v.views)} lượt xem • 📅 ${escapeHtml(v.publishDate || 'N/A')}
            </div>
          </div>
        </div>
        <div class="dl-actions">
          <button class="btn-sm" onclick="downloadSingleFromAccount('${escapeHtml(v.uniqueKey)}')">⬇️ Tải ngay</button>
          <button class="btn-sm" onclick="copyText('${escapeHtml(v.url)}')">📋 Copy Link</button>
        </div>
      </div>
    `;
    })
    .join('');
}

function toggleSelectAccountVideo(uniqueKey, isChecked) {
  if (isChecked) selectedAccountVideoKeys.add(uniqueKey);
  else selectedAccountVideoKeys.delete(uniqueKey);
  document.getElementById('accSelectedCountBadge').textContent = `Đã chọn: ${selectedAccountVideoKeys.size}`;
}

function selectAllDownloadableAccountVideos() {
  const videos = currentAccountScan?.videos || [];
  for (const v of videos) {
    if (v.downloadable) selectedAccountVideoKeys.add(v.uniqueKey);
  }
  renderAccountVideos();
}

function deselectAllAccountVideos() {
  selectedAccountVideoKeys.clear();
  renderAccountVideos();
}

async function downloadSingleFromAccount(uniqueKey) {
  const v = (currentAccountScan?.videos || []).find((x) => x.uniqueKey === uniqueKey);
  if (!v) return;
  const outputFormat = document.getElementById('accBatchFormat')?.value || 'mp4';
  const maxConcurrent = parseInt(document.getElementById('accBatchConcurrency')?.value || '2', 10);
  const userConsentedCookie = Boolean(document.getElementById('accConsentCookieCheck')?.checked);
  const cookie = userConsentedCookie ? document.getElementById('accCookieInput')?.value.trim() || '' : '';

  try {
    const res = await fetch('/api/account/batch-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videos: [v],
        outputFormat,
        maxConcurrent,
        userConsentedCookie,
        cookie
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    toast(`⬇️ Đã đưa "${v.title.slice(0, 35)}..." vào hàng đợi tải!`);
    loadDownloads();
  } catch (e) {
    toast('Lỗi tải video: ' + e.message, 'error');
  }
}

async function enqueueSelectedAccountVideos() {
  const videos = (currentAccountScan?.videos || []).filter((v) => selectedAccountVideoKeys.has(v.uniqueKey));
  if (videos.length === 0) {
    toast('Vui lòng tích chọn ít nhất 1 video tải được trong danh sách!', 'warn');
    return;
  }

  const outputFormat = document.getElementById('accBatchFormat')?.value || 'mp4';
  const maxConcurrent = parseInt(document.getElementById('accBatchConcurrency')?.value || '2', 10);
  const userConsentedCookie = Boolean(document.getElementById('accConsentCookieCheck')?.checked);
  const cookie = userConsentedCookie ? document.getElementById('accCookieInput')?.value.trim() || '' : '';

  try {
    const res = await fetch('/api/account/batch-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videos,
        outputFormat,
        maxConcurrent,
        userConsentedCookie,
        cookie
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    toast(
      `📦 Đã thêm ${data.addedCount} video vào hàng đợi tải (Bỏ qua ${data.skippedDuplicateCount} trùng lặp, tối đa ${data.maxConcurrent} luồng đồng thời).`
    );
    loadDownloads();
    pollAccountScanStatus();
  } catch (e) {
    toast('Lỗi thêm hàng đợi: ' + e.message, 'error');
  }
}

async function clearBatchQueue() {
  try {
    await fetch('/api/account/batch-clear', { method: 'POST' });
    toast('🧹 Đã xóa các mục đang chờ trong hàng đợi.');
    pollAccountScanStatus();
  } catch (_) {}
}

// ================= TAB 3: LỒNG TIẾNG VIDEO ĐÃ TẢI (DUBBING PIPELINE) =================
let activeDubbingJobId = null;
let dubbingPollTimer = null;

async function loadDubbingConfig(silent = false) {
  try {
    const res = await fetch('/api/dubbing/config');
    const data = await res.json();
    if (!data.success) return;
    dubbingCatalog = {
      ...data,
      voices: data.voices || [],
      localModels: data.localModels || [],
      pipelineSteps: data.pipelineSteps || []
    };

    if (!silent) {
      renderLocalModelsGrid(data.localModels || []);
      onChangeDubLanguage();
    }
    renderDubJobsList(data.jobs || []);
  } catch (_) {}
}

function toggleDubResources(forceShow = null) {
  const body = document.getElementById('dubResourcesDetailBody');
  const btn = document.getElementById('dubToggleResourcesBtn');
  if (!body || !btn) return;
  const shouldShow = forceShow !== null ? Boolean(forceShow) : body.style.display === 'none';
  if (forceShow === null) {
    dubResourcesUserExpanded = shouldShow;
  }
  body.style.display = shouldShow ? 'block' : 'none';
  btn.textContent = shouldShow ? '🔼 Thu gọn' : '🔽 Xem tài nguyên';
}

function renderLocalModelsGrid(models) {
  const grid = document.getElementById('dubLocalModelsGrid');
  const summaryEl = document.getElementById('dubResourcesSummaryText');
  const installedCount = (models || []).filter((m) => Boolean(m.installed)).length;
  const totalCount = (models || []).length;
  const missingDefaults = (models || []).filter((m) => !m.installed && m.isDefault);

  if (summaryEl) {
    if (totalCount === 0) {
      summaryEl.textContent = '💻 Tài nguyên AI Local: Đang kiểm tra...';
    } else if (missingDefaults.length > 0) {
      summaryEl.innerHTML = `<span style="color:#b91c1c;">⚠️ Thiếu ${missingDefaults.length} mô hình AI Local cần thiết (${escapeHtml(missingDefaults.map((x) => x.name).join(', '))})</span>`;
    } else {
      summaryEl.innerHTML = `<span style="color:#047857;">💻 Tài nguyên AI Local: ${installedCount}/${totalCount} mô hình đã sẵn sàng trên máy</span>`;
    }
  }

  // Mặc định thu gọn bảng tài nguyên dài, CHỈ mở sẵn khi thiếu mô hình mặc định hoặc người dùng chủ động mở
  if (missingDefaults.length > 0) {
    toggleDubResources(true);
  } else {
    toggleDubResources(Boolean(dubResourcesUserExpanded));
  }

  if (!grid) return;
  grid.innerHTML = (models || [])
    .map((m) => {
      const isInstalled = Boolean(m.installed);
      const sizeMB = m.sizeMB || m.modelSizeMB || 0;
      return `
      <div class="tool-probe-card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <span style="font-size:12px;font-weight:700;color:#0f172a;">${escapeHtml(m.name)}</span>
          <span class="cap-pill ${isInstalled ? 'verified' : 'conditional'}">${isInstalled ? 'Đã cài sẵn Local' : 'Chưa cài (' + sizeMB + ' MB)'}</span>
        </div>
        <div style="font-size:11px;color:#475569;margin-top:2px;">
          📦 Dung lượng: <strong>${sizeMB} MB</strong> • 📜 Giấy phép: <strong>${escapeHtml(m.license || 'Open Source')}</strong>
        </div>
        <div style="font-size:11px;color:#475569;margin-top:2px;">
          ⚙️ Yêu cầu: ${escapeHtml(m.ramRequired || m.hardwareReq || 'RAM >= 450 MB')} (${escapeHtml(m.cpuGpuNote || 'CPU Int8')})
        </div>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">
          🌐 Ngôn ngữ: ${escapeHtml(Array.isArray(m.supportedLanguages) ? m.supportedLanguages.join(', ') : m.language || 'Đa ngôn ngữ')}
        </div>
      </div>
    `;
    })
    .join('');
}

function onChangeTranslationProvider() {
  const provider = document.getElementById('dubTranslationProviderSelect')?.value || 'auto';
  const consent = Boolean(document.getElementById('dubCloudConsentCheck')?.checked);
  populateDubAiModelSelect();
  renderDubAiStatusLine();
  if (providerNeedsCloud(provider) && !consent) {
    toast('ℹ️ Bộ dịch này gửi văn bản lên dịch vụ đám mây. Hãy tích ô "Cho phép gửi văn bản phân đoạn lên đám mây" ở trên khi muốn dùng.', 'warn');
  }
}

function renderDubAiStatusLine() {
  const provider = document.getElementById('dubTranslationProviderSelect')?.value || 'auto';
  const consent = Boolean(document.getElementById('dubCloudConsentCheck')?.checked);
  const line = document.getElementById('dubAiStatusLine');
  const isAi = provider === 'ai' || provider.startsWith('ai_');
  if (line) {
    if (isAi) {
      const providers = (aiConfigCache && aiConfigCache.providers) || [];
      const feat = ((aiConfigCache && aiConfigCache.features) || []).find((f) => f.id === 'translation') || {};
      const pid = provider === 'ai' ? feat.providerId || 'gemini' : provider.slice(3);
      const p = providers.find((x) => x.id === pid);
      const chosen = document.getElementById('dubAiModelSelect')?.value || '';
      const model = chosen || (provider === 'ai' && feat.model) || (p && p.defaultModel) || (p && p.recommendedModel) || '';
      if (!aiConfigCache) {
        line.innerHTML = '⏳ Đang kiểm tra cấu hình AI...';
      } else if (!p || !p.hasKey) {
        line.innerHTML =
          pid === 'local_qwen'
            ? `⚠️ Chưa cài AI Local (Qwen). <button type="button" class="btn-sm" onclick="openToolInstallerModal()">🧰 Mở trình cài</button>`
            : `⚠️ Chưa có API Key cho <strong>${escapeHtml(p ? p.name : pid)}</strong>. <button type="button" class="btn-sm" onclick="switchWorkspaceTab('ai')">Mở tab Tích hợp AI</button>`;
      } else {
        const test = p.lastTest ? (p.lastTest.ok ? '✅ đã kiểm tra kết nối' : `❌ lần kiểm tra gần nhất lỗi: ${escapeHtml(p.lastTest.error || '')}`) : 'chưa kiểm tra kết nối';
        line.innerHTML = `🤖 Dịch bằng <strong>${escapeHtml(p.name)}</strong> • model <code>${escapeHtml(model || '(chưa chọn)')}</code> • ${test}`;
      }
      line.style.display = 'block';
    } else if (provider === 'local' || (provider === 'auto' && !consent)) {
      const lq = ((aiConfigCache && aiConfigCache.providers) || []).find((x) => x.id === 'local_qwen');
      line.innerHTML =
        lq && lq.hasKey
          ? `🔒 Dịch Offline trên máy bằng AI Local (${escapeHtml((lq.cachedModels[0] || {}).id || 'Qwen')}) — không gửi dữ liệu ra ngoài. Nhanh hơn: bật Cloud và chọn Gemini.`
          : '🔒 Dịch Offline trên máy (Argos, chất lượng cơ bản). Nên cài "AI dịch Local (Qwen)" trong trình cài công cụ để dịch tốt hơn.';
      line.style.display = 'block';
    } else {
      line.style.display = 'none';
    }
  }
}

function getDubbingTranslationParams() {
  const cloudConsent = Boolean(document.getElementById('dubCloudConsentCheck')?.checked);
  const translationProvider = document.getElementById('dubTranslationProviderSelect')?.value || 'auto';
  const translationStyle = document.getElementById('dubTranslationStyleSelect')?.value || 'natural';
  const modelCol = document.getElementById('dubAiModelCol');
  const aiModel = modelCol && modelCol.style.display !== 'none' ? document.getElementById('dubAiModelSelect')?.value || '' : '';
  return { cloudConsent, translationProvider, translationStyle, aiModel };
}

function providerNeedsCloud(provider) {
  if (provider === 'ai_local_qwen') return false;
  return provider === 'cloud_google' || provider === 'ai' || String(provider || '').startsWith('ai_');
}

/** Ô chọn model: liệt kê TOÀN BỘ model khả dụng của nhà cung cấp đang chọn (lấy từ API thật / model đã cài). */
function populateDubAiModelSelect() {
  const provider = document.getElementById('dubTranslationProviderSelect')?.value || 'auto';
  const col = document.getElementById('dubAiModelCol');
  const sel = document.getElementById('dubAiModelSelect');
  if (!col || !sel) return;
  const isAi = provider === 'ai' || provider.startsWith('ai_');
  if (!isAi || !aiConfigCache) {
    col.style.display = 'none';
    return;
  }
  const feat = (aiConfigCache.features || []).find((f) => f.id === 'translation') || {};
  const pid = provider === 'ai' ? feat.providerId : provider.slice(3);
  const p = (aiConfigCache.providers || []).find((x) => x.id === pid);
  const prev = sel.dataset.provider === pid ? sel.value : '';
  const models = modelOptionsFor(p);
  const rec = (p && p.recommendedModel) || '';
  const configured = provider === 'ai' ? feat.model || (p && p.defaultModel) || '' : (p && p.defaultModel) || '';
  const dead = new Set((p && p.unavailableModels) || []);
  sel.innerHTML =
    `<option value="">Tự động${configured ? `: ${escapeHtml(configured)}` : rec ? ` (khuyến nghị: ${escapeHtml(rec)})` : ''}</option>` +
    models
      .map((m) => `<option value="${escapeHtml(m)}" ${m === prev ? 'selected' : ''}>${escapeHtml(m)}${m === rec ? ' ★' : ''}${dead.has(m) ? ' (không khả dụng)' : ''}</option>`)
      .join('');
  sel.dataset.provider = pid || '';
  col.style.display = 'block';
}

function populateDubVideoSelect(preselectPath = '') {
  const sel = document.getElementById('dubVideoSelect');
  if (!sel) return;
  const currentVal = preselectPath || sel.value;
  const videoFiles = allSavedFilesCache.filter(
    (f) => !f.isDubbed && ['mp4', 'mov', 'mkv', 'webm', 'avi'].includes((f.ext || '').toLowerCase())
  );

  const opts = ['<option value="">-- Chọn video đã tải cần lồng tiếng --</option>'];
  for (const f of videoFiles) {
    const selAttr = f.filePath === currentVal ? 'selected' : '';
    opts.push(
      `<option value="${escapeHtml(f.filePath)}" ${selAttr}>[${escapeHtml(f.platformName)}] ${escapeHtml(f.fileName)} (${fmtSizeMB(f.fileSize)} MB)</option>`
    );
  }
  sel.innerHTML = opts.join('');
}

function openDubbingForFile(filePath) {
  switchWorkspaceTab('dubbing');
  populateDubVideoSelect(filePath);
  const sel = document.getElementById('dubVideoSelect');
  if (sel) sel.value = filePath;
  extractScriptFromSelectedVideo();
}

function onSelectDubVideo() {
  const val = document.getElementById('dubVideoSelect')?.value;
  if (val) {
    extractScriptFromSelectedVideo();
  }
}

function onChangeDubLanguage() {
  const lang = document.getElementById('dubTargetLangSelect')?.value || 'vi';
  const voiceSel = document.getElementById('dubVoiceSelect');
  if (!voiceSel) return;

  const voices = (dubbingCatalog.voices || []).filter((v) => v.lang === lang);
  if (voices.length === 0) {
    voiceSel.innerHTML = `<option value="">Chưa có giọng đọc cho ngôn ngữ này</option>`;
    onVoiceSelectionChange();
    return;
  }

  const defaultVoice =
    voices.find((v) => v.isDefaultRecommended && v.installed !== false) || voices.find((v) => v.installed !== false) || voices[0];
  voiceSel.innerHTML = voices
    .map((v) => {
      const recTag = v.isDefaultRecommended ? ' ★ [Giọng đề xuất mặc định]' : '';
      const isSelected = v.id === defaultVoice.id ? 'selected' : '';
      const missing = v.installed === false ? ' ⚠️ [chưa cài]' : '';
      return `<option value="${escapeHtml(v.id)}" ${isSelected}>${escapeHtml(v.name)}${v.gender ? ' — ' + escapeHtml(v.gender) : ''}${recTag}${missing}</option>`;
    })
    .join('');

  onVoiceSelectionChange();
  renderSpeakerVoiceMapping();
}

function onVoiceSelectionChange() {
  const voiceId = document.getElementById('dubVoiceSelect')?.value;
  const detailBox = document.getElementById('selectedVoiceDetailBox');
  if (!detailBox) return;

  if (!voiceId) {
    detailBox.style.display = 'none';
    return;
  }

  const voice = (dubbingCatalog.voices || []).find((v) => v.id === voiceId);
  if (!voice) {
    detailBox.style.display = 'none';
    return;
  }

  const isLocal = voice.processingMode?.toLowerCase().includes('local') || voice.engine === 'sherpa-piper' || voice.engine === 'vieneu';
  const modeBadge = isLocal
    ? `<span class="cap-pill verified" style="font-size:10.5px;">🔒 Xử lý 100% Local Offline trên máy</span>`
    : `<span class="cap-pill conditional" style="font-size:10.5px;">☁️ Dịch vụ Đám mây (Cần bật xác nhận)</span>`;

  const recBadge = voice.isDefaultRecommended
    ? `<span class="cap-pill verified" style="font-size:10.5px;">★ Giọng đề xuất mặc định của hệ thống</span>`
    : '';

  detailBox.style.display = 'block';
  detailBox.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:4px;">
      <div style="font-weight:700;color:#0f172a;font-size:12.5px;">
        🎙️ ${escapeHtml(voice.name)}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${modeBadge}
        ${recBadge}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(210px, 1fr));gap:6px;font-size:11.5px;color:#475569;">
      <div>📊 Chất lượng: <strong>${escapeHtml(voice.qualityLabel || voice.style || 'Chuẩn')}</strong></div>
      <div>📦 Dung lượng mô hình: <strong>${voice.modelSizeMB ? voice.modelSizeMB + ' MB' : 'Tích hợp sẵn'}</strong></div>
      <div>📜 Giấy phép: <strong>${escapeHtml(voice.license || 'Open Source')}</strong></div>
      <div>⚙️ Yêu cầu phần cứng: <strong>${escapeHtml(voice.hardwareReq || 'CPU thông thường')}</strong></div>
    </div>
    ${
      voice.installed === false
        ? `<div style="margin-top:6px;color:#b45309;font-weight:600;">⚠️ Giọng này chưa sẵn sàng trên máy. <button type="button" class="btn-sm" onclick="openToolInstallerModal()">🧰 Mở trình cài công cụ</button></div>`
        : ''
    }
    ${
      voice.sampleText
        ? `<div style="font-size:11px;color:#64748b;margin-top:4px;font-style:italic;">
             📝 Câu mẫu: "${escapeHtml(voice.sampleText)}"
           </div>`
        : ''
    }
  `;
}

async function previewSelectedVoice() {
  const voiceId = document.getElementById('dubVoiceSelect')?.value;
  const targetLang = document.getElementById('dubTargetLangSelect')?.value || 'vi';
  const cloudConsent = Boolean(document.getElementById('dubCloudConsentCheck')?.checked);

  if (!voiceId) {
    toast('Vui lòng chọn một giọng đọc!', 'warn');
    return;
  }
  try {
    const res = await fetch('/api/dubbing/preview-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId, targetLang, cloudConsent })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không thể tạo âm thanh nghe thử');

    const audioEl = document.getElementById('voicePreviewAudio');
    audioEl.style.display = 'block';
    const previewSrc = data.audioUrl || `/api/dubbing/preview-audio?path=${encodeURIComponent(data.previewPath || data.audioFilePath)}&t=${Date.now()}`;
    audioEl.src = previewSrc;
    try {
      await audioEl.play();
      toast(`🔊 Đang phát thử giọng đọc: ${data.voice?.name || voiceId} (${data.duration || '?'} giây)`);
    } catch (playErr) {
      // Trình duyệt chặn tự phát hoặc không giải mã được: vẫn để thanh phát hiển thị để người dùng bấm ▶
      toast(`⚠️ Đã tạo âm thanh nghe thử nhưng trình duyệt không tự phát (${playErr.name}). Hãy bấm ▶ trên thanh phát.`, 'warn');
    }
  } catch (e) {
    toast('Lỗi nghe thử giọng: ' + e.message, 'error');
  }
}

let activeExtractTaskId = null;
let extractPollTimer = null;

async function extractScriptFromSelectedVideo() {
  const videoPath = document.getElementById('dubVideoSelect')?.value;
  const targetLang = document.getElementById('dubTargetLangSelect')?.value || 'vi';
  const trParams = getDubbingTranslationParams();

  if (!videoPath) {
    toast('Vui lòng chọn video đã tải ở mục 1 trước!', 'warn');
    return;
  }
  if (providerNeedsCloud(trParams.translationProvider) && !trParams.cloudConsent) {
    toast('Bạn đang chọn dịch vụ dịch Cloud/AI. Vui lòng tích chọn "Cho phép gửi văn bản lên dịch vụ đám mây" hoặc chọn bộ dịch Local Offline.', 'warn');
    return;
  }
  if (activeExtractTaskId) {
    toast('Đang có tác vụ phân đoạn & dịch chạy — hãy chờ hoặc bấm Hủy.', 'warn');
    return;
  }

  try {
    const res = await fetch('/api/dubbing/extract-task/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath,
        targetLang,
        autoDiarize: Boolean(document.getElementById('dubAutoDiarizeCheck')?.checked),
        numSpeakers: parseInt(document.getElementById('dubNumSpeakersInput')?.value || '0', 10) || 0,
        ...trParams
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không thể bắt đầu phân đoạn');
    activeExtractTaskId = data.task.taskId;
    renderExtractMonitor(data.task);
    return await new Promise((resolve) => {
      if (extractPollTimer) clearInterval(extractPollTimer);
      extractPollTimer = setInterval(async () => {
        try {
          const r = await fetch(`/api/dubbing/extract-task/status?taskId=${encodeURIComponent(activeExtractTaskId)}`);
          const d = await r.json();
          if (!d.success) return;
          renderExtractMonitor(d.task);
          if (d.task.status !== 'running') {
            clearInterval(extractPollTimer);
            extractPollTimer = null;
            activeExtractTaskId = null;
            if (d.task.status === 'completed') applyExtractResult(d.task.result);
            else if (d.task.status === 'error') toast('Lỗi phân đoạn & dịch: ' + (d.task.errors[0] || ''), 'error');
            else toast('🛑 Đã hủy phân đoạn & dịch.', 'warn');
            resolve(d.task);
          }
        } catch (_) {}
      }, 700);
    });
  } catch (e) {
    activeExtractTaskId = null;
    toast('Lỗi phân đoạn lời nói: ' + e.message, 'error');
  }
}

function renderExtractMonitor(task) {
  const box = document.getElementById('dubExtractMonitor');
  if (!box || !task) return;
  box.style.display = 'block';
  const icon = { pending: '⏳', running: '🔄', completed: '✅', error: '❌', skipped: '➖' };
  document.getElementById('dubExtractTitle').textContent = `📝 Phân đoạn & Dịch — ${task.inputFileName || ''}`;
  document.getElementById('dubExtractElapsed').textContent = `${task.elapsedSec || 0}s`;
  document.getElementById('dubExtractProgressFill').style.width = `${task.progress || 0}%`;
  document.getElementById('dubExtractMessage').textContent = task.message || '';
  document.getElementById('dubExtractCancelBtn').style.display = task.status === 'running' ? 'inline-flex' : 'none';
  document.getElementById('dubExtractStages').innerHTML = (task.stages || [])
    .map((st) => {
      const cnt = st.total > 0 ? ` • ${st.code === 'asr' ? `${Math.round(st.done)}/${Math.round(st.total)} giây` : `${st.done}/${st.total}`}` : '';
      return `<div class="extract-stage ${st.state}">${icon[st.state] || '•'} ${escapeHtml(st.label)}${cnt}</div>`;
    })
    .join('');
  const errs = (task.errors || []).map((e) => `<div class="err">❌ ${escapeHtml(e)}</div>`).join('');
  const warns = (task.warnings || []).slice(0, 20).map((w) => `<div class="warn">⚠️ ${escapeHtml(w)}</div>`).join('');
  document.getElementById('dubExtractIssues').innerHTML = errs || warns ? `<div class="extract-issues">${errs}${warns}</div>` : '';
}

function applyExtractResult(data) {
  if (!data) return;
  currentDubSegments = data.segments || [];
  currentDubSourceLang = data.detectedSourceLang || 'zh';
  dubSpeakerVoiceMap = {};
  autoAssignSpeakerVoices();
  const badge = document.getElementById('dubSourceLangBadge');
  if (badge) badge.textContent = `Ngôn ngữ nguồn: ${currentDubSourceLang.toUpperCase()} • ${data.translationNote || ''}`;
  renderDubSegments();
  if ((data.speakerCount || 1) > 1) toast(`🗣️ Phát hiện ${data.speakerCount} người nói — đã gợi ý giọng riêng cho từng người (có thể đổi).`);
  const v = data.validation || { errors: [] };
  if (v.errors && v.errors.length) toast(`⚠️ ${v.errors.length} lỗi dữ liệu dịch cần sửa trước khi lồng tiếng (xem khung theo dõi).`, 'warn');
  else toast(`✅ Đã nhận diện ${currentDubSegments.length} phân đoạn thời gian thực tế!`);
}

async function cancelExtractTaskUi() {
  if (!activeExtractTaskId) return;
  await fetch('/api/dubbing/extract-task/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: activeExtractTaskId })
  });
}

async function retranslateCurrentSegments() {
  if (!currentDubSegments || currentDubSegments.length === 0) {
    toast('Chưa có câu thoại nào để dịch lại. Hãy nhấn "Phân đoạn & Dịch (ASR)" trước!', 'warn');
    return;
  }
  const targetLang = document.getElementById('dubTargetLangSelect')?.value || 'vi';
  const trParams = getDubbingTranslationParams();
  if (providerNeedsCloud(trParams.translationProvider) && !trParams.cloudConsent) {
    toast('Bộ dịch Cloud yêu cầu tích ô cho phép gửi văn bản lên đám mây ở phía trên.', 'warn');
    return;
  }

  try {
    toast('🔄 Đang dịch lại toàn bộ kịch bản theo ngữ cảnh & văn phong đã chọn...');
    const res = await fetch('/api/dubbing/retranslate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segments: currentDubSegments,
        sourceLang: currentDubSourceLang || 'auto',
        targetLang,
        ...trParams
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không thể dịch lại lời thoại');

    currentDubSegments = data.segments || currentDubSegments;
    const badge = document.getElementById('dubSourceLangBadge');
    if (badge) {
      badge.textContent = `Ngôn ngữ nguồn: ${(data.detectedSourceLang || currentDubSourceLang || 'zh').toUpperCase()} • ${data.translationNote || ''}`;
    }
    renderDubSegments();
    toast(`✅ Đã dịch lại ${currentDubSegments.length} phân đoạn (${data.translationMode || ''})!`);
  } catch (e) {
    toast('Lỗi dịch lại lời thoại: ' + e.message, 'error');
  }
}

function renderDubSegments() {
  const wrap = document.getElementById('dubSegmentsWrap');
  if (!wrap) return;

  if (currentDubSegments.length === 0) {
    wrap.innerHTML = `<div class="empty-hint" style="padding:12px;">Chưa có phân đoạn nào. Nhấn "📝 Phân đoạn & Dịch (ASR)" hoặc "➕ Thêm đoạn thoại".</div>`;
    renderSpeakerVoiceMapping();
    return;
  }

  wrap.innerHTML = currentDubSegments
    .map((seg, idx) => {
      const dur = Math.max(0.1, Number(seg.endSec || 0) - Number(seg.startSec || 0));
      const tooLong = seg.translatedText && String(seg.translatedText).trim().split(/\s+/).length > dur * 5 * 1.5 + 2;
      return `
      <div class="dub-seg-row" title="Phân đoạn #${seg.id ?? seg.index ?? idx + 1}">
        <input type="number" step="0.1" min="0" class="folder-input" value="${Number(seg.startSec || 0).toFixed(2)}" onchange="updateDubSeg(${idx}, 'startSec', this.value)" title="Giây bắt đầu" />
        <input type="number" step="0.1" min="0" class="folder-input" value="${Number(seg.endSec || 3).toFixed(2)}" onchange="updateDubSeg(${idx}, 'endSec', this.value)" title="Giây kết thúc" />
        <input type="text" class="folder-input" value="${escapeHtml(seg.speakerId || 'speaker_1')}" onchange="updateDubSeg(${idx}, 'speakerId', this.value)" title="Mã người nói — các đoạn cùng mã dùng cùng một giọng" />
        <input type="text" class="folder-input" value="${escapeHtml(seg.sourceText || '')}" oninput="updateDubSeg(${idx}, 'sourceText', this.value)" placeholder="Lời thoại gốc thực tế..." />
        <input type="text" class="folder-input${tooLong ? ' seg-too-long' : ''}" value="${escapeHtml(seg.translatedText || '')}" oninput="updateDubSeg(${idx}, 'translatedText', this.value)" placeholder="Lời dịch sẽ đọc lồng tiếng..." style="border-color:#93c5fd;background:#eff6ff;" title="${tooLong ? 'Câu dịch dài so với thời lượng — có thể phải đọc nhanh hoặc lùi thời điểm' : 'Lời dịch'}" />
        <button class="btn-icon-sm" onclick="removeDubSeg(${idx})" title="Xóa đoạn này">✕</button>
      </div>
    `;
    })
    .join('');
  renderSpeakerVoiceMapping();
}

function getDubSpeakers() {
  return Array.from(new Set(currentDubSegments.map((s) => String(s.speakerId || 'speaker_1').trim() || 'speaker_1')));
}

function renderSpeakerVoiceMapping() {
  const wrap = document.getElementById('dubSpeakerVoicesWrap');
  if (!wrap) return;
  const speakers = getDubSpeakers();
  if (speakers.length <= 1) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  const lang = document.getElementById('dubTargetLangSelect')?.value || 'vi';
  const voices = (dubbingCatalog.voices || []).filter((v) => v.lang === lang && v.installed !== false);
  const mainVoice = document.getElementById('dubVoiceSelect')?.value || '';
  wrap.style.display = 'block';
  wrap.innerHTML = `
    <div style="font-size:12px;font-weight:700;margin-bottom:6px;">🗣️ Giọng đọc cho từng người nói (${speakers.length} người):</div>
    <div class="dub-speaker-grid">
      ${speakers
        .map((spk) => {
          const cur = dubSpeakerVoiceMap[spk] || '';
          return `<label class="dub-speaker-item"><span><code>${escapeHtml(spk)}</code></span>
            <select class="folder-input" style="height:30px;" data-speaker="${escapeHtml(spk)}" onchange="dubSpeakerVoiceMap[this.dataset.speaker] = this.value">
              <option value="">(giọng chính: ${escapeHtml((voices.find((v) => v.id === mainVoice) || {}).name || mainVoice || 'mặc định')})</option>
              ${voices.map((v) => `<option value="${escapeHtml(v.id)}" ${v.id === cur ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}
            </select></label>`;
        })
        .join('')}
    </div>`;
}

/** Gợi ý giọng khác nhau cho từng người nói (xen kẽ Nam/Nữ trong các giọng đã cài), người nói 1 dùng giọng chính. */
function autoAssignSpeakerVoices() {
  const speakers = getDubSpeakers();
  if (speakers.length <= 1) return;
  const lang = document.getElementById('dubTargetLangSelect')?.value || 'vi';
  const mainId = document.getElementById('dubVoiceSelect')?.value || '';
  const voices = (dubbingCatalog.voices || []).filter((v) => v.lang === lang && v.installed !== false && !v.requiresCloudConsent);
  const main = voices.find((v) => v.id === mainId);
  const sameEngine = voices.filter((v) => !main || v.engine === main.engine);
  const pool = (sameEngine.length > 1 ? sameEngine : voices).filter((v) => v.id !== mainId);
  const females = pool.filter((v) => v.gender === 'Nữ');
  const males = pool.filter((v) => v.gender === 'Nam');
  const others = pool.filter((v) => v.gender !== 'Nữ' && v.gender !== 'Nam');
  let preferFemale = !main || main.gender !== 'Nữ';
  let fi = 0;
  let mi = 0;
  let oi = 0;
  speakers.slice(1).forEach((spk) => {
    let pick = null;
    if (preferFemale && females[fi]) pick = females[fi++];
    else if (!preferFemale && males[mi]) pick = males[mi++];
    else pick = females[fi++] || males[mi++] || others[oi++] || null;
    if (pick) dubSpeakerVoiceMap[spk] = pick.id;
    preferFemale = !preferFemale;
  });
}

function updateDubSeg(idx, field, val) {
  if (!currentDubSegments[idx]) return;
  if (field === 'startSec' || field === 'endSec') {
    currentDubSegments[idx][field] = Math.max(0, parseFloat(val) || 0);
  } else if (field === 'speakerId') {
    currentDubSegments[idx][field] = String(val || '').trim() || 'speaker_1';
    renderSpeakerVoiceMapping();
  } else {
    currentDubSegments[idx][field] = val;
  }
}

function removeDubSeg(idx) {
  currentDubSegments.splice(idx, 1);
  renderDubSegments();
}

function addDubSegmentRow() {
  const last = currentDubSegments[currentDubSegments.length - 1];
  const lastEnd = last ? Number(last.endSec || 0) + 0.5 : 0.5;
  const nextId = currentDubSegments.reduce((m, s) => Math.max(m, Number(s.id ?? s.index) || 0), 0) + 1;
  currentDubSegments.push({
    index: currentDubSegments.length + 1,
    id: nextId,
    speakerId: last ? last.speakerId || 'speaker_1' : 'speaker_1',
    startSec: Number(lastEnd.toFixed(2)),
    endSec: Number((lastEnd + 3.0).toFixed(2)),
    sourceText: '',
    translatedText: ''
  });
  renderDubSegments();
}

function fmtPct(v) {
  return `${Math.round(Number(v) * 100)}%`;
}

function onDubVolumeInput() {
  const o = parseFloat(document.getElementById('dubOrigVolSlider')?.value ?? '0.2');
  const d = parseFloat(document.getElementById('dubVoiceVolSlider')?.value ?? '1');
  const duckOn = Boolean(document.getElementById('dubAutoDuckingCheck')?.checked);
  const duck = parseFloat(document.getElementById('dubDuckLevelSlider')?.value ?? '0.35');
  const set = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  set('dubOrigVolLabel', o === 0 ? 'Tắt' : fmtPct(o));
  set('dubVoiceVolLabel', d === 0 ? 'Tắt' : fmtPct(d));
  set('dubDuckLevelLabel', fmtPct(duck));
  const duckSlider = document.getElementById('dubDuckLevelSlider');
  if (duckSlider) duckSlider.disabled = !duckOn;
  const summary = document.getElementById('dubVolumeSummary');
  if (summary) {
    const during = duckOn ? o * duck : o;
    const removeVoice = Boolean(document.getElementById('dubRemoveVoiceCheck')?.checked);
    summary.innerHTML =
      `📤 File xuất sẽ có: ${removeVoice ? 'nhạc nền gốc (đã tách bỏ giọng nói gốc)' : 'tiếng gốc (cả giọng nói)'} <strong>${o === 0 ? 'tắt hẳn' : fmtPct(o)}</strong>` +
      (duckOn && o > 0 ? ` (lúc có lời lồng tiếng: <strong>${fmtPct(during)}</strong>)` : '') +
      ` • giọng lồng tiếng <strong>${d === 0 ? 'tắt hẳn' : fmtPct(d)}</strong> (100% = to ngang người nói gốc). ` +
      (o === 0 && d === 0 ? '<span style="color:#b91c1c;">⚠️ Cả hai đều tắt — video xuất sẽ không có tiếng.</span>' : '');
  }
}

function onRemoveVoiceToggle() {
  const on = Boolean(document.getElementById('dubRemoveVoiceCheck')?.checked);
  const title = document.getElementById('dubOrigVolTitle');
  if (title) title.textContent = on ? '🔉 Âm lượng nhạc nền gốc' : '🔉 Âm lượng tiếng gốc';
  // Mức gợi ý: khi đã tách bỏ giọng gốc thì giữ nhạc nền to hơn; khi giữ cả giọng gốc thì để nhỏ
  setDubVolume('orig', on ? 0.8 : 0.2);
}

function setDubVolume(which, value) {
  const el = document.getElementById(which === 'orig' ? 'dubOrigVolSlider' : 'dubVoiceVolSlider');
  if (el) el.value = String(value);
  onDubVolumeInput();
}

function renderDubbingStepsProgress(steps, activeStepIndex, currentMessage, isError = false) {
  const stepsList = document.getElementById('dubStepsList');
  if (!stepsList) return;

  const defaultSteps = [
    { index: 1, code: 'extract_audio', label: 'Bước 1/5: Tách track âm thanh gốc từ video (FFmpeg)' },
    { index: 2, code: 'asr_recognize', label: 'Bước 2/5: Nhận dạng giọng nói & chia mốc thời gian (Faster-Whisper ASR)' },
    { index: 3, code: 'translate_segments', label: 'Bước 3/5: Dịch từng đoạn thoại sang ngôn ngữ đích' },
    { index: 4, code: 'synthesize_tts', label: 'Bước 4/5: Tạo giọng đọc bản dịch & căn khớp thời gian (TTS & Time-Stretch)' },
    { index: 5, code: 'mux_and_verify', label: 'Bước 5/5: Ghép âm thanh vào video & xác minh có tiếng' }
  ];

  const actualSteps = Array.isArray(steps) && steps.length > 0 ? steps : defaultSteps;

  stepsList.innerHTML = actualSteps
    .map((s) => {
      let state = s.state || 'pending';
      if (!s.state) {
        if (isError && s.index === activeStepIndex) state = 'error';
        else if (s.index < activeStepIndex) state = 'completed';
        else if (s.index === activeStepIndex) state = 'running';
      }

      let icon = '⏳';
      let stateText = 'Đang chờ';
      if (state === 'completed') {
        icon = '✅';
        stateText = 'Hoàn tất';
      } else if (state === 'running') {
        icon = '🔄';
        stateText = 'Đang xử lý';
      } else if (state === 'error') {
        icon = '❌';
        stateText = 'Lỗi';
      }

      const isCurrent = s.index === activeStepIndex;
      const msg = isCurrent && currentMessage ? ` — <span style="font-weight:600;">${escapeHtml(currentMessage)}</span>` : '';

      return `
        <div class="dub-step-item ${state}">
          <div style="display:flex;align-items:center;gap:8px;">
            <span>${icon}</span>
            <span style="font-weight:600;">${escapeHtml(s.label)}</span>
            <span class="cap-pill ${state === 'completed' ? 'verified' : state === 'running' ? 'conditional' : state === 'error' ? 'unsupported' : ''}" style="font-size:10px;padding:1px 6px;">
              ${stateText}
            </span>
          </div>
          <div style="font-size:11.5px;color:#475569;margin-top:2px;padding-left:24px;">
            ${msg}
          </div>
        </div>
      `;
    })
    .join('');
}

function pollActiveDubbingJob(jobId) {
  if (dubbingPollTimer) clearInterval(dubbingPollTimer);
  dubbingPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/dubbing/status?jobId=${encodeURIComponent(jobId)}`);
      const data = await res.json();
      if (!data.success || !data.job) {
        clearInterval(dubbingPollTimer);
        return;
      }
      const job = data.job;
      const progressFill = document.getElementById('dubJobProgressFill');
      if (progressFill) progressFill.style.width = `${job.progress || 0}%`;

      renderDubbingStepsProgress(job.steps, job.stepIndex || 1, job.step || '', job.status === 'failed' || job.status === 'error');

      if (job.status === 'completed') {
        clearInterval(dubbingPollTimer);
        const cancelBtn = document.getElementById('dubCancelActiveBtn');
        if (cancelBtn) cancelBtn.style.display = 'none';
        toast(`🎉 Lồng tiếng hoàn tất! File đã lưu: ${job.outputFileName || ''}`);
        loadDownloads();
        loadDubbingConfig(true);
      } else if (job.status === 'failed' || job.status === 'error') {
        clearInterval(dubbingPollTimer);
        const cancelBtn = document.getElementById('dubCancelActiveBtn');
        if (cancelBtn) cancelBtn.style.display = 'none';
        toast(`❌ Lồng tiếng thất bại: ${job.error || 'Lỗi không xác định'}`, 'error');
        loadDubbingConfig(true);
      } else if (job.status === 'cancelled') {
        clearInterval(dubbingPollTimer);
        const cancelBtn = document.getElementById('dubCancelActiveBtn');
        if (cancelBtn) cancelBtn.style.display = 'none';
        toast('🛑 Đã dừng lồng tiếng theo yêu cầu.', 'warn');
        loadDubbingConfig(true);
      }
    } catch (_) {}
  }, 750);
}

async function cancelActiveDubbingJob() {
  if (!activeDubbingJobId) return;
  try {
    await fetch('/api/dubbing/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: activeDubbingJobId })
    });
    toast('🛑 Đã gửi lệnh hủy lồng tiếng...', 'warn');
  } catch (e) {
    toast('Lỗi hủy lồng tiếng: ' + e.message, 'error');
  }
}

async function startDubbingProcess() {
  const videoPath = document.getElementById('dubVideoSelect')?.value;
  const targetLang = document.getElementById('dubTargetLangSelect')?.value || 'vi';
  const voiceId = document.getElementById('dubVoiceSelect')?.value;
  const originalVolume = parseFloat(document.getElementById('dubOrigVolSlider')?.value ?? '0.8');
  const dubVolume = parseFloat(document.getElementById('dubVoiceVolSlider')?.value ?? '1.0');
  const autoDucking = Boolean(document.getElementById('dubAutoDuckingCheck')?.checked);
  const duckLevel = parseFloat(document.getElementById('dubDuckLevelSlider')?.value ?? '0.35');
  const maxTempo = parseFloat(document.getElementById('dubMaxTempoSelect')?.value ?? '1.3');
  const speakerVoices = {};
  for (const spk of getDubSpeakers()) {
    if (dubSpeakerVoiceMap[spk]) speakerVoices[spk] = dubSpeakerVoiceMap[spk];
  }
  const trParams = getDubbingTranslationParams();
  const cloudConsent = trParams.cloudConsent;

  if (!videoPath) {
    toast('Vui lòng chọn video đã tải cần lồng tiếng!', 'warn');
    return;
  }
  if (!voiceId) {
    toast('Vui lòng chọn giọng đọc!', 'warn');
    return;
  }

  const selectedVoice = (dubbingCatalog.voices || []).find((v) => v.id === voiceId);
  if (selectedVoice?.requiresCloudConsent && !cloudConsent) {
    toast('Giọng đọc này yêu cầu dịch vụ Cloud. Vui lòng tích chọn "Cho phép gửi văn bản lên đám mây" hoặc chọn một giọng Local Offline.', 'warn');
    return;
  }
  if (providerNeedsCloud(trParams.translationProvider) && !cloudConsent && currentDubSegments.length === 0) {
    toast('Bộ dịch Cloud yêu cầu tích chọn "Cho phép gửi văn bản lên đám mây" trước khi chạy.', 'warn');
    return;
  }

  const stepsWrap = document.getElementById('dubPipelineStepsWrap');
  const cancelBtn = document.getElementById('dubCancelActiveBtn');
  if (stepsWrap) stepsWrap.style.display = 'block';
  if (cancelBtn) cancelBtn.style.display = 'inline-block';
  renderDubbingStepsProgress(null, 1, 'Đang gửi yêu cầu khởi tạo quy trình lồng tiếng 5 bước...');

  try {
    const res = await fetch('/api/dubbing/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath,
        targetLang,
        voiceId,
        originalVolume,
        dubVolume,
        autoDucking,
        duckLevel,
        maxTempo,
        speakerVoices,
        removeOriginalVoice: Boolean(document.getElementById('dubRemoveVoiceCheck')?.checked),
        sourceLang: currentDubSourceLang || '',
        ...trParams,
        customSegments: currentDubSegments.length > 0 ? currentDubSegments : null
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không thể bắt đầu lồng tiếng');

    activeDubbingJobId = data.job?.jobId;
    toast('🎙️ Đã khởi chạy quy trình lồng tiếng 5 bước trên máy tính...');
    pollActiveDubbingJob(activeDubbingJobId);
    loadDubbingConfig(true);
  } catch (e) {
    toast('Lỗi lồng tiếng: ' + e.message, 'error');
    if (cancelBtn) cancelBtn.style.display = 'none';
    renderDubbingStepsProgress(null, 1, 'Lỗi: ' + e.message, true);
  }
}

async function cancelDubbingProcess(jobId) {
  try {
    await fetch('/api/dubbing/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId })
    });
    toast('🛑 Đã hủy tác vụ lồng tiếng (File video gốc vẫn giữ nguyên).', 'warn');
    loadDubbingConfig(true);
  } catch (e) {
    toast('Lỗi hủy lồng tiếng: ' + e.message, 'error');
  }
}

function renderDubJobsList(jobs) {
  const wrap = document.getElementById('dubJobsList');
  const stat = document.getElementById('dubJobsStatLabel');
  if (!wrap) return;
  const list = Array.isArray(jobs) ? jobs : [];
  if (stat) stat.textContent = `${list.length} tác vụ`;

  if (list.length === 0) {
    wrap.innerHTML = `<div class="empty-hint">Chưa có tác vụ lồng tiếng nào.</div>`;
    return;
  }

  wrap.innerHTML = list
    .map((j) => {
      const isRunning = j.status === 'processing' || j.status === 'running';
      const isDone = j.status === 'completed';
      const isCancelled = j.status === 'cancelled';
      const isFailed = j.status === 'failed' || j.status === 'error';
      const isInterrupted = j.status === 'interrupted';
      const langLabel = j.targetLangName || (typeof j.targetLang === 'object' ? j.targetLang?.name : j.targetLang) || 'Tiếng Việt';
      const voiceLabel = j.voiceName || (typeof j.voice === 'object' ? j.voice?.name : j.voice) || 'Giọng mặc định';
      const origPct = Math.round((j.originalVolume ?? 0.2) * 100);
      const dubPct = Math.round((j.dubVolume ?? 1.0) * 100);
      const warnHtml = (j.warnings || []).length
        ? `<div class="dl-sub" style="color:#b45309;">⚠️ ${(j.warnings || []).map((w) => escapeHtml(w)).join('<br>⚠️ ')}</div>`
        : '';
      const outPath = j.outputPath || j.outputVideoPath || '';
      const outName = j.outputFileName || (outPath ? outPath.split(/[/\\]/).pop() : '') || j.inputFileName || 'Video lồng tiếng';
      const statusMsg = j.statusText || j.step || 'Đang xử lý...';

      return `
      <div class="dl-item">
        <div class="dl-info">
          <div class="dl-name">
            <span class="cap-pill verified">🎙️ ${escapeHtml(langLabel)} (${escapeHtml(voiceLabel)})</span>
            ${escapeHtml(outName)}
          </div>
          <div class="dl-sub">
            ${isRunning ? `🔄 ${escapeHtml(statusMsg)} (${j.progress || 0}%)` : ''}
            ${isDone ? `✅ Hoàn tất (${fmtSizeMB(j.totalBytes || 0)} MB • Tiếng gốc ${origPct}%, Tiếng lồng ${dubPct}%${j.autoDucking !== false ? ', Auto-Ducking' : ''}) — 📁 ${escapeHtml(outPath)}` : ''}
            ${isCancelled ? `🛑 ${escapeHtml(statusMsg || 'Đã hủy lồng tiếng')}` : ''}
            ${isFailed ? `❌ Lỗi: ${escapeHtml(j.error || statusMsg || '')}` : ''}
            ${isInterrupted ? `⚠️ ${escapeHtml(j.error || 'Tác vụ bị gián đoạn')}` : ''}
          </div>
          ${isDone ? warnHtml : ''}
          ${isRunning ? `<div class="progress-bar"><div class="progress-fill" style="width:${j.progress || 5}%"></div></div>` : ''}
        </div>
        <div class="dl-actions">
          ${isRunning ? `<button class="btn-danger-sm" data-job="${escapeHtml(j.jobId)}" onclick="cancelDubbingProcess(this.dataset.job)">⏹ Hủy</button>` : ''}
          ${isInterrupted && j.resumable ? `<button class="btn-sm" data-job="${escapeHtml(j.jobId)}" onclick="resumeDubbingJobUi(this.dataset.job)">▶ Chạy tiếp</button>` : ''}
          ${
            isDone && outPath
              ? `
            <button class="btn-sm" data-path="${escapeHtml(outPath)}" data-name="${escapeHtml(outName)}" onclick="playDownloadedVideo(this.dataset.path, this.dataset.name)">▶ Xem thử bản lồng tiếng</button>
            <button class="btn-sm" data-path="${escapeHtml(outPath)}" onclick="openFileInFinder(this.dataset.path)">📂 Mở thư mục Dubbed</button>
          `
              : ''
          }
          ${
            !isRunning && j.videoPath
              ? `<button class="btn-sm" data-path="${escapeHtml(j.videoPath)}" onclick="openDubbingForFile(this.dataset.path)">🔄 Chạy lại / Chỉnh âm lượng</button>`
              : ''
          }
        </div>
      </div>
    `;
    })
    .join('');
}

// ================= TAB 4: MA TRẬN KHẢ NĂNG & TRẠNG THÁI CÔNG CỤ (CAPABILITIES) =================
async function loadCapabilitiesMatrix(forceToast = false) {
  try {
    const res = await fetch('/api/capabilities');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    systemCapabilities = data;
    renderTopbarEngineStatus(data);
    renderCapabilitiesFromData(data);
    if (forceToast) toast('✅ Đã kiểm tra lại thực tế toàn bộ Binary và quyền chạy trên hệ điều hành!');
  } catch (e) {
    toast('Lỗi kiểm tra khả năng hệ thống: ' + e.message, 'error');
  }
}

function renderCapabilitiesFromData(data) {
  const banner = document.getElementById('missingToolsBanner');
  const bannerText = document.getElementById('missingToolsBannerText');
  const missingTools = data.missingTools || [];
  if (banner) {
    if (missingTools.length > 0) {
      banner.style.display = 'block';
      if (bannerText) {
        bannerText.textContent = `Hệ thống phát hiện ${missingTools.length} thành phần chưa sẵn sàng: ${missingTools.map((m) => m.name).join(', ')}. Nhấn nút bên phải để tải và cài đặt từ nguồn chính thức.`;
      }
    } else {
      banner.style.display = 'none';
    }
  }

  const toolsGrid = document.getElementById('toolsProbeGrid');
  if (toolsGrid && data.tools) {
    toolsGrid.innerHTML = Object.values(data.tools)
      .map((t) => {
        return `
        <div class="tool-probe-card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
            <span style="font-size:13px;font-weight:700;color:#0f172a;">${escapeHtml(t.name)}</span>
            ${renderCapPillHtml(t.statusCode, t.statusLabel)}
          </div>
          <div style="font-size:11.5px;color:#334155;font-family:ui-monospace, monospace;word-break:break-all;">
            📍 Binary: ${escapeHtml(t.path || 'N/A')}
          </div>
          <div style="font-size:11.5px;color:#475569;">
            🔑 Quyền chạy (X_OK): <strong>${t.executable ? 'Có' : 'Không'}</strong> • Phiên bản: <strong>${escapeHtml(t.version || 'N/A')}</strong>
          </div>
          <div style="font-size:11px;color:${t.error ? '#b91c1c' : '#64748b'};">
            ${escapeHtml(t.error || t.fallbackNote || 'Hoạt động bình thường')}
          </div>
        </div>
      `;
      })
      .join('');
  }

  const sumWrap = document.getElementById('capSummaryBadges');
  if (sumWrap && data.summary) {
    sumWrap.innerHTML = `
      <span class="cap-pill verified">Đã kiểm tra: ${data.summary.verifiedCount || 0}</span>
      <span class="cap-pill conditional">Có điều kiện: ${data.summary.conditionalCount || 0}</span>
      <span class="cap-pill unsupported">Chưa hỗ trợ: ${data.summary.unsupportedCount || 0}</span>
      <span class="cap-pill missing_tool">Công cụ còn thiếu: ${data.summary.missingToolCount || 0}</span>
    `;
  }

  const tbody = document.getElementById('capMatrixRows');
  if (tbody && data.platformMatrix) {
    tbody.innerHTML = data.platformMatrix
      .map((row) => {
        return `
        <tr>
          <td style="font-weight:700;">${escapeHtml(row.name)}</td>
          <td>${renderCapPillHtml(row.currentOsStatus.code, row.currentOsStatus.label)}</td>
          <td>${renderCapPillHtml(row.macosStatus.code, row.macosStatus.label)}</td>
          <td>${renderCapPillHtml(row.windowsStatus.code, row.windowsStatus.label)}</td>
          <td>${renderCapPillHtml(row.singleVideoDownload.code, row.singleVideoDownload.label)}</td>
          <td>${renderCapPillHtml(row.accountVideoScan.code, row.accountVideoScan.label)}</td>
          <td style="font-size:11.5px;color:#475569;">
            <div>${escapeHtml(row.notes)}</div>
            <div style="color:#64748b;margin-top:2px;">Quét TK: ${escapeHtml(row.accountVideoScan.note)}</div>
          </td>
        </tr>
      `;
      })
      .join('');
  }
}

// ================= CÔNG CỤ CHUYỂN ĐỔI ĐỊNH DẠNG VIDEO / AUDIO (FFMPEG CONVERTER) =================
function populateConverterSavedFilesDropdown(preselectPath = '') {
  const sel = document.getElementById('convSavedFileSelect');
  if (!sel) return;
  const options = ['<option value="">-- Chọn nhanh từ các video đã tải về --</option>'];
  for (const f of allSavedFilesCache) {
    const selectedAttr = f.filePath === preselectPath ? 'selected' : '';
    options.push(
      `<option value="${escapeHtml(f.filePath)}" ${selectedAttr}>[${escapeHtml(f.platformName)}] ${escapeHtml(f.fileName)} (${fmtSizeMB(f.fileSize)} MB)</option>`
    );
  }
  sel.innerHTML = options.join('');
}

function openConverterModal(preselectPath = '') {
  populateConverterSavedFilesDropdown(preselectPath);
  if (preselectPath) {
    document.getElementById('convInputPath').value = preselectPath;
  }
  loadConversions();
  document.getElementById('converterModal').classList.add('open');
}

function openConverterForFile(filePath) {
  openConverterModal(filePath);
}

function closeConverterModal() {
  document.getElementById('converterModal').classList.remove('open');
}

function onSelectSavedFileForConvert(val) {
  if (val) {
    document.getElementById('convInputPath').value = val;
  }
}

async function browseFileForConvert() {
  try {
    const res = await fetch('/api/pick-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptText: 'Chọn file video/audio cần chuyển đổi định dạng' })
    });
    const data = await res.json();
    if (data.success && data.path) {
      document.getElementById('convInputPath').value = data.path;
    }
  } catch (e) {
    toast('Lỗi mở hộp thoại chọn file: ' + e.message, 'error');
  }
}

async function startConversion() {
  const inputPath = document.getElementById('convInputPath').value.trim();
  const targetFormat = document.getElementById('convTargetFormat').value;
  const quality = document.getElementById('convQuality').value;

  if (!inputPath) {
    toast('Vui lòng chọn file nguồn cần chuyển đổi!', 'warn');
    return;
  }

  try {
    const res = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputPath, targetFormat, quality })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không thể bắt đầu chuyển đổi');
    toast(`🔄 Đang chuyển đổi & xác minh định dạng .${targetFormat.toUpperCase()}...`);
    loadConversions();
  } catch (e) {
    toast('Lỗi chuyển đổi: ' + e.message, 'error');
  }
}

async function cancelConversion(jobId) {
  try {
    await fetch('/api/convert/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId })
    });
    toast('🛑 Đã dừng chuyển đổi định dạng (File nguồn vẫn được giữ nguyên).', 'warn');
    loadConversions();
  } catch (e) {
    toast('Lỗi hủy chuyển đổi: ' + e.message, 'error');
  }
}

async function loadConversions() {
  try {
    const res = await fetch('/api/conversions');
    const data = await res.json();
    const wrap = document.getElementById('conversionsList');
    const jobs = data.jobs || [];

    if (jobs.length === 0) {
      wrap.innerHTML = `<div class="empty-hint">Chưa có tác vụ chuyển đổi nào.</div>`;
      return;
    }

    wrap.innerHTML = jobs
      .map((j) => {
        const isRunning = j.status === 'converting';
        const isDone = j.status === 'completed';
        const isCancelled = j.status === 'cancelled';
        const isFailed = j.status === 'failed';

        return `
        <div class="dl-item">
          <div class="dl-info">
            <div class="dl-name">
              <span class="dl-platform-tag">-> .${escapeHtml(j.targetFormat.toUpperCase())}</span>
              ${escapeHtml(j.outputFileName)}
            </div>
            <div class="dl-sub">
              ${isRunning ? `🔄 ${escapeHtml(j.statusText || 'Đang chuyển đổi')} (${j.progress || 0}%)` : ''}
              ${isDone ? `✅ Hoàn tất (${fmtSizeMB(j.totalBytes)} MB • ${escapeHtml(j.audioStatusText || 'Đã xác minh')}) — 📁 ${escapeHtml(j.outputPath)}` : ''}
              ${isCancelled ? `🛑 ${escapeHtml(j.error || 'Đã hủy chuyển đổi (Giữ nguyên file gốc)')}` : ''}
              ${isFailed ? `❌ Lỗi: ${escapeHtml(j.error || '')}` : ''}
            </div>
            ${isRunning ? `<div class="progress-bar"><div class="progress-fill" style="width:${j.progress || 5}%"></div></div>` : ''}
          </div>
          <div class="dl-actions">
            ${isRunning ? `<button class="btn-danger-sm" onclick="cancelConversion('${escapeHtml(j.jobId)}')">⏹ Hủy</button>` : ''}
            ${
              isDone
                ? `
              <button class="btn-sm" onclick="closeConverterModal(); playDownloadedVideo('${escapeHtml(j.outputPath)}', '${escapeHtml(j.outputFileName)}')">▶ Phát</button>
              <button class="btn-sm" onclick="openFileInFinder('${escapeHtml(j.outputPath)}')">📂 Hiện file</button>
            `
                : ''
            }
          </div>
        </div>
      `;
      })
      .join('');
  } catch (_) {}
}

// ================= QUẢN LÝ THƯ MỤC LƯU TRỮ THEO NỀN TẢNG =================
async function openStorageModal() {
  try {
    const res = await fetch('/api/storage');
    const data = await res.json();
    if (data.success) {
      storageConfig = data.storage;
      renderStorageModal();
      document.getElementById('storageModal').classList.add('open');
    }
  } catch (e) {
    toast('Không thể tải cấu hình thư mục: ' + e.message, 'error');
  }
}

function closeStorageModal() {
  document.getElementById('storageModal').classList.remove('open');
}

function renderStorageModal() {
  if (!storageConfig) return;
  document.getElementById('rootDirInput').value = storageConfig.rootDir || '';

  const tbody = document.getElementById('platformStorageRows');
  tbody.innerHTML = platforms
    .map((p) => {
      const pConf = storageConfig.platforms?.[p.id] || {};
      return `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:8px;font-weight:600;">
            <span class="p-dot" style="background:${p.color}"></span>
            ${escapeHtml(p.name)}
          </div>
        </td>
        <td>
          <input type="text" class="folder-input" id="dir_input_${p.id}" value="${escapeHtml(pConf.effectiveDir || '')}" />
        </td>
        <td>
          <div style="display:flex;gap:6px;justify-content:flex-end;">
            <button class="btn-sm" onclick="browsePlatformFolder('${p.id}')">📁 Chọn...</button>
            <button class="btn-sm" onclick="savePlatformFolder('${p.id}')">💾 Lưu</button>
            ${pConf.isCustom ? `<button class="btn-sm" onclick="resetPlatformFolder('${p.id}')">↺ Mặc định</button>` : ''}
            <button class="btn-sm" onclick="openDownloadsFolder('${p.id}')">↗ Mở</button>
          </div>
        </td>
      </tr>
    `;
    })
    .join('');
}

async function browseRootFolder() {
  try {
    const res = await fetch('/api/pick-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptText: 'Chọn thư mục gốc lưu trữ mặc định cho tất cả nền tảng' })
    });
    const data = await res.json();
    if (data.success && data.path) {
      document.getElementById('rootDirInput').value = data.path;
      await saveRootFolder();
    }
  } catch (e) {
    toast('Lỗi mở hộp thoại chọn thư mục: ' + e.message, 'error');
  }
}

async function saveRootFolder() {
  const newRoot = document.getElementById('rootDirInput').value.trim();
  if (!newRoot) return;
  try {
    const res = await fetch('/api/storage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootDir: newRoot })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    storageConfig = data.storage;
    renderStorageModal();
    renderPlatforms();
    updateFolderLabels();
    toast('Đã cập nhật thư mục gốc mặc định!');
  } catch (e) {
    toast('Lỗi lưu thư mục gốc: ' + e.message, 'error');
  }
}

async function browsePlatformFolder(platformId) {
  try {
    const p = platforms.find((x) => x.id === platformId);
    const res = await fetch('/api/pick-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptText: `Chọn thư mục lưu riêng cho ${p ? p.name : platformId}` })
    });
    const data = await res.json();
    if (data.success && data.path) {
      document.getElementById(`dir_input_${platformId}`).value = data.path;
      await savePlatformFolder(platformId);
    }
  } catch (e) {
    toast('Lỗi chọn thư mục: ' + e.message, 'error');
  }
}

async function savePlatformFolder(platformId) {
  const val = document.getElementById(`dir_input_${platformId}`).value.trim();
  if (!val) return;
  try {
    const res = await fetch('/api/storage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customPlatformDirs: { [platformId]: val } })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    storageConfig = data.storage;
    renderStorageModal();
    renderPlatforms();
    updateFolderLabels();
    toast(`Đã lưu đường dẫn riêng cho ${platformId.toUpperCase()}!`);
  } catch (e) {
    toast('Lỗi lưu đường dẫn: ' + e.message, 'error');
  }
}

async function resetPlatformFolder(platformId) {
  try {
    const res = await fetch('/api/storage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customPlatformDirs: { [platformId]: '' } })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    storageConfig = data.storage;
    renderStorageModal();
    renderPlatforms();
    updateFolderLabels();
    toast(`Đã đặt lại thư mục mặc định cho ${platformId.toUpperCase()}`);
  } catch (e) {
    toast('Lỗi đặt lại: ' + e.message, 'error');
  }
}

// ================= MODAL 3: TẢI & CÀI ĐẶT CÔNG CỤ / MÔ HÌNH AI CÒN THIẾU =================
function openToolInstallerModal() {
  loadInstallableToolsCatalog();
  document.getElementById('toolInstallerModal')?.classList.add('open');
}

function closeToolInstallerModal() {
  document.getElementById('toolInstallerModal')?.classList.remove('open');
}

async function loadInstallableToolsCatalog() {
  const list = document.getElementById('installerToolsList');
  if (!list) return;
  list.innerHTML = `<div class="empty-hint">Đang tải danh mục công cụ và kiểm tra tính toàn vẹn...</div>`;

  try {
    const res = await fetch('/api/tools/catalog');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderToolInstallerList(data.tools || []);
  } catch (e) {
    list.innerHTML = `<div class="empty-hint" style="color:#b91c1c;">Lỗi: ${escapeHtml(e.message)}</div>`;
  }
}

function renderToolInstallerList(tools) {
  const list = document.getElementById('installerToolsList');
  if (!list) return;

  if (tools.length === 0) {
    list.innerHTML = `<div class="empty-hint">Tất cả công cụ và mô hình AI đều đã sẵn sàng trên hệ thống!</div>`;
    return;
  }

  list.innerHTML = tools
    .map((t) => {
      const isInstalled = Boolean(t.installed);
      const sizeText = t.estimatedSizeMB ? `${t.estimatedSizeMB} MB` : 'N/A';
      return `
        <div class="tool-install-item" id="toolCard_${escapeHtml(t.id)}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span style="font-size:14px;font-weight:700;color:#0f172a;">${escapeHtml(t.name)}</span>
                <span class="badge primary">${escapeHtml(t.category || 'Công cụ')}</span>
                <span class="cap-pill ${isInstalled ? 'verified' : 'missing_tool'}">
                  ${isInstalled ? '✓ Đã sẵn sàng' : '⚠️ Chưa cài đặt'}
                </span>
              </div>
              <div style="font-size:12px;color:#475569;margin-top:3px;">
                ${escapeHtml(t.description || '')}
              </div>
              <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;color:#64748b;margin-top:4px;">
                <span>🌐 Nguồn chính thức: <strong>${escapeHtml(t.officialProvider || 'Official')}</strong></span>
                <span>📦 Ước tính: <strong>${sizeText}</strong></span>
                <span>📜 Giấy phép: <strong>${escapeHtml(t.license || 'Open Source')}</strong></span>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
              ${
                !isInstalled
                  ? `
                <label style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:#334155;cursor:pointer;">
                  <input type="checkbox" id="toolConfirm_${escapeHtml(t.id)}" />
                  <span>Tôi xác nhận tải từ nguồn chính thức</span>
                </label>
                <button class="btn-primary" style="height:34px;padding:0 14px;" onclick="installTool('${escapeHtml(t.id)}')">
                  📦 Tải & Cài đặt
                </button>
              `
                  : `
                <button class="btn-sm" style="height:34px;background:#ecfdf5;border-color:#a7f3d0;color:#047857;" onclick="installTool('${escapeHtml(t.id)}', true)">
                  🔄 Tải & Cài lại
                </button>
              `
              }
            </div>
          </div>

          <!-- Khu vực tiến độ tải & kết quả xác minh SHA-256 -->
          <div id="toolProgress_${escapeHtml(t.id)}" style="display:none;margin-top:10px;padding:8px 10px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;">
            <div style="display:flex;justify-content:space-between;font-size:11.5px;color:#334155;">
              <span id="toolProgStep_${escapeHtml(t.id)}">Đang chuẩn bị...</span>
              <span id="toolProgPct_${escapeHtml(t.id)}">0%</span>
            </div>
            <div class="progress-bar" style="margin-top:6px;height:6px;">
              <div class="progress-fill" id="toolProgFill_${escapeHtml(t.id)}" style="width:0%"></div>
            </div>
          </div>

          <!-- Hướng dẫn khắc phục thủ công nếu tải thất bại -->
          ${
            Array.isArray(t.remediationSteps) && t.remediationSteps.length > 0
              ? `
            <details style="margin-top:8px;font-size:11px;color:#64748b;">
              <summary style="cursor:pointer;color:#2563eb;font-weight:600;">📖 Xem hướng dẫn cài đặt thủ công (khi máy không có mạng)</summary>
              <div style="margin-top:6px;padding:8px 10px;background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0;line-height:1.5;">
                <ol style="margin:0;padding-left:18px;">
                  ${t.remediationSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
                </ol>
              </div>
            </details>
          `
              : ''
          }
        </div>
      `;
    })
    .join('');
}

async function installTool(toolId, isReinstall = false) {
  const confirmCheck = document.getElementById(`toolConfirm_${toolId}`);
  if (!isReinstall && confirmCheck && !confirmCheck.checked) {
    toast('Vui lòng tích vào ô xác nhận đồng ý tải trước khi nhấn cài đặt!', 'warn');
    return;
  }

  const progWrap = document.getElementById(`toolProgress_${toolId}`);
  const progStep = document.getElementById(`toolProgStep_${toolId}`);
  const progFill = document.getElementById(`toolProgFill_${toolId}`);
  const progPct = document.getElementById(`toolProgPct_${toolId}`);

  if (progWrap) progWrap.style.display = 'block';
  if (progStep) progStep.textContent = 'Đang gửi yêu cầu cài đặt tới máy chủ nội bộ...';

  try {
    const res = await fetch('/api/tools/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolId, userConfirmed: true })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    toast(`📦 Bắt đầu tải ${toolId}... Bạn có thể theo dõi tiến độ trực tiếp.`);
    pollToolInstallStatus(data.job?.jobId, toolId);
  } catch (e) {
    if (progStep) progStep.textContent = 'Lỗi: ' + e.message;
    toast('Lỗi cài đặt công cụ: ' + e.message, 'error');
  }
}

function pollToolInstallStatus(jobId, toolId) {
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`/api/tools/install-status?jobId=${encodeURIComponent(jobId)}`);
      const data = await res.json();
      if (!data.success || !data.job) {
        clearInterval(timer);
        return;
      }
      const job = data.job;
      const progStep = document.getElementById(`toolProgStep_${toolId}`);
      const progFill = document.getElementById(`toolProgFill_${toolId}`);
      const progPct = document.getElementById(`toolProgPct_${toolId}`);

      if (progFill) progFill.style.width = `${job.progress || 0}%`;
      if (progPct) progPct.textContent = `${job.progress || 0}%`;
      if (progStep) progStep.textContent = `${job.step || 'Đang xử lý'} ${job.speedText ? '(' + job.speedText + ')' : ''}`;

      if (job.status === 'completed') {
        clearInterval(timer);
        if (progStep) progStep.innerHTML = `<span style="color:#047857;font-weight:700;">✅ Cài đặt & Xác minh Toàn vẹn (SHA-256) Thành công! Phiên bản: ${escapeHtml(job.version || '')}</span>`;
        toast(`✅ Đã cài đặt thành công ${job.toolName || toolId}!`);
        loadInstallableToolsCatalog();
        loadCapabilitiesMatrix(false);
      } else if (job.status === 'failed') {
        clearInterval(timer);
        if (progStep) progStep.innerHTML = `<span style="color:#b91c1c;font-weight:700;">❌ Thất bại: ${escapeHtml(job.error || '')}</span>`;
        toast(`❌ Không thể cài đặt ${toolId}: ${job.error || ''}`, 'error');
      }
    } catch (_) {}
  }, 750);
}

init();


// ================= TAB: TÍCH HỢP AI (AI PROVIDER MANAGER) =================
async function loadAiConfig(silent = false) {
  try {
    const res = await fetch('/api/ai/config');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không đọc được cấu hình AI');
    aiConfigCache = data;
    if (!silent) renderAiConfig();
    populateDubAiModelSelect();
    renderDubAiStatusLine();
  } catch (e) {
    if (!silent) toast('Lỗi tải cấu hình AI: ' + e.message, 'error');
  }
}

function renderAiConfig() {
  const cfg = aiConfigCache;
  if (!cfg) return;
  const monthEl = document.getElementById('aiMonthLabel');
  if (monthEl) monthEl.textContent = `Thống kê sử dụng tháng ${cfg.month}`;

  const featWrap = document.getElementById('aiFeaturesWrap');
  if (featWrap) {
    featWrap.innerHTML = (cfg.features || [])
      .map((f) => {
        const providerOpts = cfg.providers
          .map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === f.providerId ? 'selected' : ''}>${escapeHtml(p.name)}${p.hasKey ? '' : ' (chưa có key)'}</option>`)
          .join('');
        const p = cfg.providers.find((x) => x.id === f.providerId) || cfg.providers[0];
        const models = modelOptionsFor(p);
        return `
        <div class="ai-feature-row">
          <div class="ai-feature-name">
            <strong>${escapeHtml(f.name)}</strong>
            <div style="font-size:11px;color:#64748b;">${escapeHtml(f.description || '')}</div>
          </div>
          <select class="folder-input" id="aiFeat_${escapeHtml(f.id)}_provider" style="height:32px;" onchange="onAiFeatureProviderChange('${escapeHtml(f.id)}')">${providerOpts}</select>
          ${modelSelectHtml(`aiFeat_${f.id}_model`, p, f.model || '')}
          <button type="button" class="btn-sm" onclick="saveAiFeature('${escapeHtml(f.id)}')">💾 Lưu</button>
          <div class="ai-chain-row">
            <label class="dub-check-label"><input type="checkbox" id="aiFeat_${escapeHtml(f.id)}_autofb" ${f.autoFallback !== false ? 'checked' : ''} onchange="saveAiFeature('${escapeHtml(f.id)}')" />
              <span>🔁 Tự động dự phòng khi lỗi (model khác cùng nhà cung cấp → AI Local)</span></label>
            <div style="font-size:11px;color:#475569;">Thứ tự sẽ thử: ${(f.chainPreview || []).map((t, i) => `${i + 1}. ${escapeHtml(t.providerId)}/${escapeHtml(t.model || 'tự động')}`).join(' → ') || '(chưa có nhà cung cấp sẵn sàng)'}</div>
          </div>
        </div>`;
      })
      .join('');
  }

  const grid = document.getElementById('aiProvidersGrid');
  if (!grid) return;
  grid.innerHTML = cfg.providers
    .map((p) => {
      const u = p.usageThisMonth || {};
      const lt = p.lastTest;
      const testHtml = lt
        ? lt.ok
          ? `<span class="cap-pill verified">✅ Kết nối OK • ${lt.modelCount ?? '?'} model • ${lt.latencyMs} ms</span>`
          : `<span class="cap-pill unsupported" title="${escapeHtml(lt.error || '')}">❌ ${escapeHtml(lt.code || 'Lỗi')}</span>`
        : '<span class="cap-pill">Chưa kiểm tra</span>';
      const keyHtml = p.isLocal
        ? p.hasKey
          ? `<span class="cap-pill verified">💻 Đã cài • ${(p.cachedModels || []).length} model</span>`
          : '<span class="cap-pill conditional">Chưa cài AI Local</span>'
        : p.hasKey
        ? `<span class="cap-pill verified">🔑 Đã có key ${escapeHtml(p.keyHint)}${p.keySource && p.keySource.startsWith('env') ? ' (biến môi trường)' : ''}</span>`
        : '<span class="cap-pill conditional">Chưa có API Key</span>';
      const models = modelOptionsFor(p);
      return `
      <div class="ai-provider-card" id="aiProv_${escapeHtml(p.id)}">
        <div class="ai-provider-head">
          <strong>${escapeHtml(p.name)}</strong>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">${keyHtml}${testHtml}</div>
        </div>
        ${lt && !lt.ok ? `<div class="ai-error-box">${escapeHtml(lt.error || '')}</div>` : ''}
        ${
          p.isLocal
            ? `<div style="font-size:11.5px;color:#334155;">Chạy Qwen3.5 9B ngay trên máy (Mac: Apple MLX • Windows: llama.cpp) — không cần API Key, không gửi dữ liệu ra ngoài. ${p.hasKey ? '' : '<button type="button" class="btn-sm" onclick="openToolInstallerModal()">🧰 Cài AI Local</button>'}</div>`
            : `        <label class="ai-field"><span>API Key ${p.keyHelpUrl ? `(<a href="#" onclick="openExternalUrl('${escapeHtml(p.keyHelpUrl)}');return false;">lấy key</a>)` : ''}</span>
          <input type="password" autocomplete="off" class="folder-input" id="aiKey_${escapeHtml(p.id)}" placeholder="${p.hasKey ? 'Để trống = giữ key hiện tại' : 'Dán API Key...'}" />
        </label>`
        }
        ${
          p.needsBaseUrl || p.id === 'openai'
            ? `<label class="ai-field"><span>Base URL${p.needsBaseUrl ? ' (bắt buộc, chuẩn OpenAI /v1)' : ''}</span>
                 <input type="text" class="folder-input" id="aiBase_${escapeHtml(p.id)}" value="${escapeHtml(p.baseUrl || '')}" placeholder="https://api.deepseek.com/v1 • Ollama: http://127.0.0.1:11434/v1 • LM Studio: http://127.0.0.1:1234/v1" /></label>
                 ${p.id === 'openai_compatible' ? '<div style="font-size:11px;color:#475569;">💻 Dùng Ollama/LM Studio trên máy (Windows/macOS): nhập Base URL 127.0.0.1, <strong>không cần API Key</strong>, dữ liệu không rời máy.</div>' : ''}`
            : ''
        }
        <label class="ai-field"><span>Model mặc định</span>
          ${modelSelectHtml(`aiModel_${p.id}`, p, p.defaultModel || '')}
        </label>
        <div class="ai-field-row">
          <label class="ai-field"><span>Hạn mức request/tháng (0 = không giới hạn)</span>
            <input type="number" min="0" class="folder-input" id="aiLimReq_${escapeHtml(p.id)}" value="${Number(p.limits?.monthlyRequestLimit || 0)}" /></label>
          <label class="ai-field"><span>Hạn mức token/tháng (0 = không giới hạn)</span>
            <input type="number" min="0" class="folder-input" id="aiLimTok_${escapeHtml(p.id)}" value="${Number(p.limits?.monthlyTokenLimit || 0)}" /></label>
        </div>
        <div class="ai-usage">📊 Tháng này: ${fmtNum(u.requests || 0)} request • ${fmtNum((u.inputTokens || 0) + (u.outputTokens || 0))} token (vào ${fmtNum(u.inputTokens || 0)} / ra ${fmtNum(u.outputTokens || 0)}) • ${fmtNum(u.errors || 0)} lỗi</div>
        <div class="ai-actions">
          <button type="button" class="btn-download" style="height:34px;padding:0 14px;" onclick="saveAiProvider('${escapeHtml(p.id)}')">💾 Lưu</button>
          <button type="button" class="btn-outline" style="height:34px;" onclick="testAiProvider('${escapeHtml(p.id)}')">🔌 Kiểm tra kết nối</button>
          ${p.hasKey && p.keySource === 'file' ? `<button type="button" class="btn-danger-sm" onclick="clearAiKey('${escapeHtml(p.id)}')">🗑️ Xóa key</button>` : ''}
        </div>
      </div>`;
    })
    .join('');
}

function modelSelectHtml(id, p, current) {
  const models = modelOptionsFor(p);
  const dead = new Set((p && p.unavailableModels) || []);
  const rec = (p && p.recommendedModel) || '';
  const list = current && !models.includes(current) ? [current, ...models] : models;
  return `<select class="folder-input" id="${escapeHtml(id)}" style="height:32px;">
    <option value="">Tự động${rec ? ` (khuyến nghị: ${escapeHtml(rec)})` : ''}</option>
    ${list.map((m) => `<option value="${escapeHtml(m)}" ${m === current ? 'selected' : ''}>${escapeHtml(m)}${m === rec ? ' ★' : ''}${dead.has(m) ? ' — không khả dụng' : ''}</option>`).join('')}
  </select>`;
}

async function loadAiLogs() {
  try {
    const r = await fetch('/api/ai/logs?limit=120');
    const d = await r.json();
    const box = document.getElementById('aiLogsBox');
    if (box) {
      box.textContent = (d.logs || []).length
        ? d.logs.map((l) => `[${String(l.at).replace('T', ' ').slice(0, 19)}] ${l.level || ''} ${l.providerId || ''}/${l.model || ''} ${l.code || ''}: ${l.message || ''}`).join('\n')
        : 'Chưa có sự kiện nào.';
    }
  } catch (_) {}
}

function modelOptionsFor(p) {
  if (!p) return [];
  const fromApi = (p.cachedModels || []).map((m) => m.id);
  return Array.from(new Set([...fromApi, ...(p.suggestedModels || [])])).filter(Boolean);
}

function onAiFeatureProviderChange(featureId) {
  const pid = document.getElementById(`aiFeat_${featureId}_provider`)?.value;
  const p = (aiConfigCache?.providers || []).find((x) => x.id === pid);
  const modelInput = document.getElementById(`aiFeat_${featureId}_model`);
  if (modelInput) modelInput.outerHTML = modelSelectHtml(`aiFeat_${featureId}_model`, p, '');
}

async function postAiConfig(body, okMsg) {
  const res = await fetch('/api/ai/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Không lưu được cấu hình AI');
  aiConfigCache = data;
  renderAiConfig();
  if (okMsg) toast(okMsg);
  return data;
}

async function saveAiProvider(pid) {
  try {
    const patch = {};
    const keyEl = document.getElementById(`aiKey_${pid}`);
    if (keyEl && keyEl.value.trim()) patch.apiKey = keyEl.value.trim();
    const baseEl = document.getElementById(`aiBase_${pid}`);
    if (baseEl) patch.baseUrl = baseEl.value.trim();
    const modelEl = document.getElementById(`aiModel_${pid}`);
    if (modelEl) patch.defaultModel = modelEl.value.trim();
    const limits = {
      monthlyRequestLimit: Number(document.getElementById(`aiLimReq_${pid}`)?.value || 0),
      monthlyTokenLimit: Number(document.getElementById(`aiLimTok_${pid}`)?.value || 0)
    };
    await postAiConfig({ providers: { [pid]: patch }, limits: { [pid]: limits } }, '💾 Đã lưu cấu hình nhà cung cấp AI.');
    if (keyEl) keyEl.value = '';
  } catch (e) {
    toast('Lỗi lưu cấu hình AI: ' + e.message, 'error');
  }
}

async function clearAiKey(pid) {
  if (!confirm('Xóa API Key đã lưu của nhà cung cấp này khỏi máy?')) return;
  try {
    await postAiConfig({ providers: { [pid]: { clearKey: true } } }, '🗑️ Đã xóa API Key.');
  } catch (e) {
    toast('Lỗi xóa key: ' + e.message, 'error');
  }
}

async function testAiProvider(pid) {
  try {
    const keyEl = document.getElementById(`aiKey_${pid}`);
    if (keyEl && keyEl.value.trim()) await saveAiProvider(pid);
    toast('🔌 Đang kiểm tra kết nối tới nhà cung cấp AI...');
    const res = await fetch('/api/ai/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: pid })
    });
    const data = await res.json();
    if (data.config) {
      aiConfigCache = data.config;
      renderAiConfig();
    }
    if (data.ok) toast(`✅ Kết nối thành công (${data.latencyMs} ms, ${data.models.length} model).`);
    else toast(`❌ Kết nối thất bại: ${data.error || 'Lỗi không xác định'}`, 'error');
  } catch (e) {
    toast('Lỗi kiểm tra kết nối: ' + e.message, 'error');
  }
}

async function saveAiFeature(featureId) {
  try {
    const providerId = document.getElementById(`aiFeat_${featureId}_provider`)?.value;
    const model = document.getElementById(`aiFeat_${featureId}_model`)?.value.trim() || '';
    const autoFallback = Boolean(document.getElementById(`aiFeat_${featureId}_autofb`)?.checked);
    await postAiConfig({ features: { [featureId]: { providerId, model, autoFallback } } }, '💾 Đã lưu nhà cung cấp AI cho chức năng.');
  } catch (e) {
    toast('Lỗi lưu chức năng AI: ' + e.message, 'error');
  }
}

async function openExternalUrl(url) {
  try {
    await fetch('/api/open-external-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  } catch (_) {}
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    onDubVolumeInput();
  } catch (_) {}
  loadAiConfig(true);
});


// ================= QUÉT NHIỀU TÀI KHOẢN =================
let activeMultiScanId = null;
let multiScanTimer = null;

async function startMultiAccountScanUi() {
  const inputs = (document.getElementById('accMultiInput')?.value || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (inputs.length === 0) {
    toast('Nhập ít nhất 1 tài khoản (mỗi dòng 1 link hoặc UID).', 'warn');
    return;
  }
  const platformId = document.getElementById('accPlatformSelect')?.value || 'auto';
  const maxPages = parseInt(document.getElementById('accMaxPages')?.value || '1', 10);
  const userConsentedCookie = Boolean(document.getElementById('accConsentCookieCheck')?.checked);
  const cookie = userConsentedCookie ? document.getElementById('accCookieInput')?.value.trim() || '' : '';
  try {
    const res = await fetch('/api/account/scan-multi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs, platformId, maxPages, userConsentedCookie, cookie })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Không thể bắt đầu quét nhiều tài khoản');
    activeMultiScanId = data.batch.batchId;
    renderMultiScan(data.batch);
    toast(`👥 Bắt đầu quét ${data.batch.total} tài khoản (tuần tự).`);
    if (multiScanTimer) clearInterval(multiScanTimer);
    multiScanTimer = setInterval(pollMultiScan, 1500);
  } catch (e) {
    toast('Lỗi quét nhiều tài khoản: ' + e.message, 'error');
  }
}

async function pollMultiScan() {
  if (!activeMultiScanId) return;
  try {
    const res = await fetch(`/api/account/scan-multi/status?batchId=${encodeURIComponent(activeMultiScanId)}`);
    const data = await res.json();
    if (!data.success) return;
    renderMultiScan(data.batch);
    if (['completed', 'cancelled'].includes(data.batch.status)) {
      clearInterval(multiScanTimer);
      multiScanTimer = null;
      toast(`👥 Quét xong ${data.batch.done}/${data.batch.total} tài khoản — ${data.batch.totalVideos} video.`);
    }
  } catch (_) {}
}

async function cancelMultiAccountScanUi() {
  if (!activeMultiScanId) return;
  await fetch('/api/account/scan-multi/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchId: activeMultiScanId })
  });
  toast('🛑 Đã yêu cầu dừng quét nhiều tài khoản.', 'warn');
  pollMultiScan();
}

function renderMultiScan(batch) {
  const wrap = document.getElementById('accMultiResults');
  if (!wrap || !batch) return;
  const icon = { pending: '⏳', scanning: '🔄', completed: '✅', failed: '❌', cancelled: '🛑', unsupported: '🚫' };
  const label = { pending: 'Đang chờ', scanning: 'Đang quét', completed: 'Hoàn tất', failed: 'Thất bại', cancelled: 'Đã hủy', unsupported: 'Chưa hỗ trợ' };
  wrap.innerHTML =
    `<div style="font-size:12px;font-weight:700;margin-bottom:6px;">Tiến độ: ${batch.done}/${batch.total} tài khoản • ${batch.totalVideos} video • ${batch.status === 'scanning' ? 'đang chạy' : batch.status}</div>` +
    batch.items
      .map(
        (it) => `
      <div class="dl-item">
        <div class="dl-info">
          <div class="dl-name">${icon[it.status] || '•'} <span class="cap-pill ${it.status === 'completed' ? 'verified' : it.status === 'failed' || it.status === 'unsupported' ? 'unsupported' : 'conditional'}">${label[it.status] || it.status}</span> ${escapeHtml(it.accountName || it.input)}</div>
          <div class="dl-sub">${escapeHtml(it.platformName || '')} • ${escapeHtml(it.input)} • ${it.videosFound || 0} video${it.error ? ` • <span style="color:#b91c1c;">${escapeHtml(it.error)}</span>` : ''}</div>
        </div>
        <div class="dl-actions">
          ${it.scanId && it.videosFound > 0 ? `<button class="btn-sm" data-scan="${escapeHtml(it.scanId)}" onclick="openScanResult(this.dataset.scan)">📋 Xem & chọn video</button>` : ''}
        </div>
      </div>`
      )
      .join('');
}

async function openScanResult(scanId) {
  try {
    const res = await fetch(`/api/account/scan/status?scanId=${encodeURIComponent(scanId)}`);
    const data = await res.json();
    if (!data.success || !data.scan) throw new Error('Không tìm thấy kết quả quét');
    currentAccountScan = data.scan;
    selectedAccountVideoKeys.clear();
    renderAccountScanStatus(currentAccountScan);
    renderAccountVideos();
    document.getElementById('accVideoListCard')?.scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    toast('Lỗi mở kết quả quét: ' + e.message, 'error');
  }
}


async function resumeDubbingJobUi(jobId) {
  try {
    const r = await fetch('/api/dubbing/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) });
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    activeDubbingJobId = d.job.jobId;
    document.getElementById('dubPipelineStepsWrap').style.display = 'block';
    pollActiveDubbingJob(activeDubbingJobId);
    toast('▶ Đang chạy tiếp tác vụ lồng tiếng (dùng lại phần dịch đã lưu)...');
    loadDubbingConfig(true);
  } catch (e) {
    toast('Không chạy tiếp được: ' + e.message, 'error');
  }
}

# 🐉 CN Video Scraper & Downloader Pro (Phiên bản Nâng cấp Toàn diện)
### Ứng dụng Desktop Cào Dữ Liệu, Quét Tài khoản, Chuyển đổi Định dạng & Lồng tiếng Video 12 Nền tảng Trung Quốc

Ứng dụng Desktop hỗ trợ **12 nền tảng video Trung Quốc**, tích hợp kiểm tra thực tế công cụ hệ thống, chuẩn hóa/chuyển đổi định dạng có xác minh giải mã media (`verifyMediaOutput`), quét danh sách video tài khoản theo phân trang và lồng tiếng video tự động ưu tiên xử lý Local (`Local-First Dubbing Pipeline`).

---

## 📊 1. Ma trận Khả năng theo Nền tảng & Hệ điều hành (Trung thực & Minh bạch)

Hệ thống tự động kiểm tra sự tồn tại của binary, quyền thực thi (`X_OK`), chuỗi phiên bản và lỗi khởi động của từng công cụ khi chạy thực tế (không đặt cứng trạng thái `"sẵn sàng"`).

| # | Nền tảng | Tải Video Đơn (macOS) | Tải Video Đơn (Windows) | Quét Danh sách Tài khoản | Điều kiện môi trường & Giới hạn kỹ thuật thực tế |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **01** | **Douyin (抖音)** | **Đã kiểm tra** | Có điều kiện | Có điều kiện | Trên macOS dùng `WebKitSniffer` tự sinh chữ ký `a_bogus` qua trang Open Player. Trên Windows không có `WebKitSniffer` nên dùng HTTP SSR + `yt-dlp` (cần người dùng cấp Cookie nếu Douyin bật Captcha). |
| **02** | **Kuaishou (快手)** | **Đã kiểm tra** | Có điều kiện | Có điều kiện | Trên macOS tự chuyển sang link Mobile H5 (`c.kuaishou.com`) kết hợp `WebKitSniffer`. Trên Windows hoạt động có điều kiện qua H5 SSR Fetcher. |
| **03** | **Bilibili (哔哩哔哩)** | **Đã kiểm tra** | Có điều kiện | **Đã kiểm tra** | Đã kiểm chứng trên cả `bilibili.com` (WebAPI) và `bilibili.tv` (ghép DASH `.m4s` Video + Audio và chuẩn hóa `H.264/AAC`). Quét tài khoản hỗ trợ phân trang qua `space.bilibili.com/{mid}`. |
| **04** | **Xiaohongshu (小红书)** | Có điều kiện | Có điều kiện | Có điều kiện | Yêu cầu link chia sẻ có kèm `xsec_token` (từ nút Share) hoặc trích xuất qua `__INITIAL_STATE__`. Quét tài khoản chỉ lấy được các bài đăng công khai hiển thị trên SSR/WebKit. |
| **05** | **Pipixia (皮皮虾)** | Có điều kiện | Có điều kiện | **Chưa hỗ trợ quét tài khoản** | Tải video lẻ qua Bds Cell API (`/bds/cell/cell_comment/`). Pipixia khóa hoàn toàn trang danh sách video hồ sơ cá nhân trên Web H5. |
| **06** | **Xigua Video (西瓜视频)** | Có điều kiện | Có điều kiện | **Chưa hỗ trợ quét tài khoản** | Tải video lẻ qua Iframe Player (`/iframe/{id}`) + `yt-dlp`. Trang kênh yêu cầu chữ ký `__ac_signature` động và phiên đăng nhập. |
| **07** | **Jianying (剪映 / CapCut)** | Có điều kiện | Có điều kiện | **Chưa hỗ trợ quét tài khoản** | Hỗ trợ tải mẫu video đơn (Template share link). Không có trang danh sách mẫu công khai theo tài khoản trên Web. |
| **08** | **Youku (优酷)** | Có điều kiện | Có điều kiện | **Chưa hỗ trợ quét tài khoản** | Nền tảng OTT phim dài tập: Chỉ tải được tập miễn phí công khai qua `yt-dlp` + `FFmpeg`. Phim VIP/DRM hoặc chặn IP ngoài Trung Quốc cần Cookie & Proxy. |
| **09** | **Tencent Video (腾讯视频)** | Có điều kiện | Có điều kiện | **Chưa hỗ trợ quét tài khoản** | Nền tảng OTT: Chỉ hỗ trợ tập miễn phí công khai; nội dung VIP/DRM yêu cầu tài khoản VIP và Cookie do người dùng tự cấp. |
| **10** | **iQIYI (爱奇艺)** | Có điều kiện | Có điều kiện | **Chưa hỗ trợ quét tài khoản** | Nền tảng OTT: Chỉ hỗ trợ tập miễn phí công khai; yêu cầu chữ ký `vf`/`dash` cho nội dung giới hạn. |
| **11** | **MangoTV (芒果TV)** | Có điều kiện | Có điều kiện | **Chưa hỗ trợ quét tài khoản** | Hỗ trợ metadata qua `pcweb.api.mgtv.com` và tải tập miễn phí qua `yt-dlp`. Không có hồ sơ người dùng UGC công khai. |
| **12** | **WeTV** | Có điều kiện | Có điều kiện | **Chưa hỗ trợ quét tài khoản** | Hỗ trợ tải tập phim miễn phí trên WeTV quốc tế (`wetv.vip`) qua `yt-dlp` + `FFmpeg`. |

> **Lưu ý về Hệ điều hành:**
> - **macOS (`darwin`)**: **Đã kiểm tra** thực tế toàn bộ luồng khởi động app ([CNVideoScraperPro.app](CNVideoScraperPro.app)), cổng backend (`3889` kèm cơ chế tự đổi cổng khi trùng `EADDRINUSE`), hộp thoại chọn file/thư mục (`osascript`), `WebKitSniffer`, `yt-dlp`, `ffmpeg` và bộ tổng hợp giọng đọc nội bộ (`AVSpeechSynthesizer`).
> - **Windows (`win32`)**: **Có điều kiện** (đã xây dựng đầy đủ nhánh tương thích đa nền tảng trong [src/launcher.js](src/launcher.js), [Start_App_Windows.bat](Start_App_Windows.bat), hộp thoại PowerShell `System.Windows.Forms`, SAPI TTS và cơ chế fallback an toàn khi không có `WebKitSniffer`, nhưng chưa chạy kiểm thử vật lý trực tiếp trên máy Windows).

---

## 🚀 Cài đặt trên máy mới (Windows 10/11 x64 hoặc macOS)

Kho mã nguồn chỉ chứa **mã nguồn (~2 MB)**. Môi trường Python, model AI, ffmpeg, yt-dlp được tải tự động từ nguồn chính thức ở lần chạy đầu.

**Yêu cầu:** [Node.js 20+](https://nodejs.org) (bản LTS) • Internet ở lần cài đầu • ~3 GB trống + 5,8 GB cho AI dịch Local Qwen3.5 9B • Windows: nên có RAM 16 GB.

### Windows
1. Tải mã nguồn (GitHub: *Code → Download ZIP*, hoặc gói `CNVideoScraperPro-source-*.zip` từ Drive) và giải nén — nên đặt ở đường dẫn ngắn, ví dụ `C:\CNVideo`.
2. Nhấp đúp **`Start_App_Windows.bat`**. Lần đầu file này tự chạy `npm install` và `scripts/setup.js` (tạo Python 3.12 riêng, tải model ~2,3 GB **+ AI dịch Local Qwen3.5 9B ~5,8 GB**), các lần sau mở thẳng ứng dụng. Không cần quyền Administrator. Qwen được cài vào thư mục người dùng `%USERPROFILE%\QwenLocal` để các ứng dụng khác dùng chung (xem mục 5).
3. **Mở ứng dụng:** chạy xong, app **tự mở** trong một cửa sổ riêng (Edge/Chrome dạng ứng dụng). Lần cài đầu tạo sẵn lối tắt **"CN Video Scraper Pro"** trên Desktop — các lần sau nhấp đúp lối tắt đó (hoặc `Start_App_Windows.bat`). Thiếu lối tắt: chạy `Tao_Shortcut_Desktop.bat`.
   - Cửa sổ dòng lệnh màu đen là máy chủ của app: **giữ nó mở** khi dùng; đóng nó hoặc đóng cửa sổ app là tắt ứng dụng.
   - Cửa sổ app không hiện ra: mở trình duyệt và vào `http://127.0.0.1:3889`.
4. Máy yếu / ít RAM: bỏ Qwen bằng `node scripts/setup.js --no-llm` rồi dùng Gemini (miễn phí qua AI Studio). Có thể cài Qwen sau bằng nút **🧰 Công cụ → "AI dịch Local Qwen3.5 9B"**.
5. **Qwen dùng chung cho mọi ứng dụng (Windows):** Qwen được cài vào `%USERPROFILE%\QwenLocal` (không nằm trong thư mục app), thư mục app có lối tắt **`Qwen Local`** trỏ tới đó. Ứng dụng khác chỉ cần đọc `%USERPROFILE%\QwenLocal\qwen-local.json` (đường dẫn model, bộ chạy, tham số khuyên dùng) hoặc chạy `Start_Qwen_Server.bat` để có API chuẩn OpenAI tại `http://127.0.0.1:8765/v1`. Bản Qwen đã tải trong thư mục app ở phiên bản cũ được tự chuyển sang đây khi mở app (không tải lại).
   - **Ổ C ít chỗ** (sau khi cài còn dưới ~10 GB trống) và thư mục app nằm ở ổ khác: lúc cài sẽ **hỏi** cài vào ổ C hay vào thư mục app (`<thư mục app>\QwenLocal`). Chọn thư mục app thì `%USERPROFILE%\QwenLocal\qwen-local.json` vẫn được ghi (vài KB, trường `"home"` là chỗ cài thật) để app khác tìm thấy. Có thể chọn trước: `node scripts/setup.js --qwen-dir=app` hoặc `--qwen-dir=user`.

### macOS
```bash
npm install --omit=dev
npm run setup          # thêm AI Local Qwen (Mac chip Apple): npm run setup:full
npm start
```

### Lệnh hữu ích
| Lệnh | Tác dụng |
|---|---|
| `npm run setup:check` | Kiểm tra thành phần còn thiếu (không tải gì) |
| `npm run setup` | Cài thành phần còn thiếu (bỏ qua cái đã có) |
| `npm run pack` | Tạo `dist/CNVideoScraperPro-source-*.zip` (chỉ mã nguồn) để đưa lên Drive |
| `npm run pack:models -- --no-llm` | Tạo gói model dùng chung Windows/macOS để máy khác khỏi tải lại (giải nén vào thư mục dự án trước khi chạy setup) |

### Khác biệt Windows ↔ macOS
| Tính năng | macOS | Windows |
|---|---|---|
| Tải video, lồng tiếng, VieNeu-TTS, tách giọng, nhận diện người nói | ✅ | ✅ |
| Dịch AI Cloud (Gemini/OpenAI) | ✅ | ✅ |
| AI dịch Local Qwen3.5 9B (không cần key, không gửi dữ liệu) | Apple MLX 4-bit (GPU Metal) | llama.cpp + GGUF Q4_K_M (GPU NVIDIA/AMD/Intel qua Vulkan, tự chạy CPU nếu không có GPU) — cài tự động |
| Quét hồ sơ Douyin/Kuaishou bằng WebKit | ✅ | Có điều kiện (dùng Cookie + yt-dlp) |
| Giọng đọc hệ điều hành | Giọng macOS (Linh, Tingting...) | Chỉ giọng tiếng Anh mặc định của Windows |

### Đưa lên GitHub / Drive
- `.gitignore` đã loại: `node_modules`, `.venv*`, `bin/models`, `bin/tools`, ffmpeg/yt-dlp, `downloads/`, và **dữ liệu riêng tư** (`config/ai_secrets.json` chứa API Key, nhật ký, cấu hình máy).
- Không copy cả thư mục dự án lên Drive để dùng ở máy khác: môi trường Python chứa đường dẫn tuyệt đối và phụ thuộc hệ điều hành. Hãy dùng `npm run pack` (+ gói model nếu muốn).
- Workflow `.github/workflows/ci.yml` tự cài và chạy toàn bộ test trên **Windows và macOS thật** của GitHub mỗi lần đẩy code.

## 🆕 Bản 1.2.0 — AI Local Qwen, AI Gateway, sửa đồng bộ/nghe thử/thanh tải

- **AI dịch Local (Qwen3.5-9B, Apple MLX)**: không cần API Key, không gửi dữ liệu ra ngoài; được chọn sau khi đánh giá thật Qwen3.5-4B/9B, Qwen2.5-7B, Argos. Model thừa đã xóa.
- **AI Gateway**: chọn mọi model khả dụng; tự dự phòng khi lỗi/quá tải/model bị ngừng; hàng đợi; nhật ký; hạn mức; lưu đệm bản dịch & chạy tiếp tác vụ bị gián đoạn.
- **Đồng bộ chuẩn** (lệch ≤ 50 ms), **tách giọng gốc giữ nhạc nền**, **cân bằng âm lượng theo lời gốc**, **khung theo dõi Phân đoạn & Dịch**.
- Sửa **thanh tải treo**, **nghe thử không phát trong app macOS** (thiếu HTTP Range).

## Bản 1.1.0 — Nâng cấp dịch AI, VieNeu-TTS, âm lượng, quét tài khoản

- **🤖 Tích hợp AI (tab mới)**: lớp AI Provider dùng chung (`src/ai/ai_provider_manager.js`) với Adapter cho **Google Gemini**, **OpenAI (ChatGPT)** và **API tương thích OpenAI** (DeepSeek, Groq, OpenRouter, LM Studio...). Nhập API Key, kiểm tra kết nối (tải danh sách model thật), chọn nhà cung cấp + model cho từng chức năng, đặt hạn mức request/token mỗi tháng, xem thống kê sử dụng. Key lưu ở `config/ai_secrets.json` (quyền 0600), không bao giờ trả về giao diện.
- **Dịch lời thoại bằng AI theo phân đoạn** (`src/ai/llm_translator.js`): dùng prompt "phiên dịch viên chuyên nghiệp", gửi từng phân đoạn kèm `id / start / end / speaker_id`, nhận lại JSON và **kiểm tra số lượng, ID, thứ tự**; timestamp luôn lấy từ dữ liệu gốc, không lấy từ AI. Dịch theo lô kèm ngữ cảnh câu trước/sau; tự yêu cầu lại khi sai cấu trúc; phân loại lỗi (key sai, hết hạn mức, rate-limit, mất mạng, JSON hỏng).
- **🎙️ VieNeu-TTS v3 Turbo** (48 kHz, Apache-2.0) chạy **offline** trên CPU qua SDK chính thức `vieneu` trong môi trường riêng `.venv-vieneu` (Python 3.12). 25 giọng dựng sẵn (Bắc/Trung/Nam), giọng mặc định đề xuất "Hải Đăng"; các giọng Piper/hệ điều hành/Edge cũ vẫn giữ nguyên. Cài/tải từ tab Công cụ.
- **Âm lượng xuất video chính xác**: tiếng gốc 0–200% và giọng lồng tiếng 0–200% độc lập, nút tắt/khôi phục, mức Auto-Ducking chỉnh được. Đã đo trên file xuất: sai lệch ≤ 0,2 dB.
- **Đồng bộ lồng tiếng**: tận dụng khoảng lặng, tăng tốc có giới hạn (mặc định ≤ 1,3x), không cắt câu, không chồng lấn.
- **Nhiều người nói**: tự phân tách người nói offline (sherpa-onnx pyannote + 3D-Speaker), mỗi `speakerId` một giọng, tự gợi ý giọng Nam/Nữ khác nhau; có thể nhập số người nói cố định.
- **ASR**: ưu tiên Faster-Whisper **Small** (chính xác hơn rõ rệt với tiếng Trung), ép chữ giản thể, tách câu theo dấu câu bằng word-timestamps.
- **Quét tài khoản**: Bilibili lấy đúng danh sách **video tải lên** qua yt-dlp (+Cookie người dùng nếu cần), bỏ nhánh tìm kiếm từng trả video của tài khoản khác; trạng thái thất bại rõ ràng; nhật ký quét; **quét nhiều tài khoản** tuần tự có giới hạn tốc độ.
- **Bảo mật API cục bộ**: chặn website lạ gọi API (kiểm tra Origin/Host), `/api/play-local` chỉ phục vụ file media trong thư mục lưu.

## 🛠️ 2. Năm Nhóm Nâng Cấp & Sửa Lỗi Trọng Tâm

### A. Phân tích Nội dung, Dịch & Lồng tiếng 5 Bước Hoàn Chỉnh ([src/dubbing_engine.js](src/dubbing_engine.js), [src/local_ai_worker.py](src/local_ai_worker.py))
- **Quy trình 5 bước minh bạch**:
  1. *Bước 1 - Tách âm thanh*: Trích xuất track âm thanh gốc 16kHz Mono PCM từ video bằng FFmpeg.
  2. *Bước 2 - Nhận dạng giọng nói (ASR)*: Chạy nhận dạng thực tế bằng Faster-Whisper trên track âm thanh để tạo lời thoại thực tế chia thành các đoạn có mốc thời gian `startSec` - `endSec`. **Tuyệt đối KHÔNG lấy tiêu đề video, tên file hay mô tả làm phụ đề/transcript thay thế**. Dừng ngay và báo lỗi cụ thể nếu video không có tiếng (`NO_AUDIO_STREAM`) hoặc không phát hiện lời thoại (`NO_SPEECH_DETECTED`).
  3. *Bước 3 - Dịch lời thoại (NMT & Cloud Tùy chọn)*: Dịch gộp theo cụm câu ngữ cảnh (Context Sentence Grouping) kết hợp hậu xử lý văn phong tiếng Việt (`Tự nhiên / Review / Kể chuyện`), beam search 4 trên CTranslate2 / Argos NMT 100% Offline; hỗ trợ mở rộng các bộ dịch đám mây (`Cloud Google Ngữ cảnh`, `Cloud Gemini AI`, `Cloud OpenAI / DeepSeek`) và nút **Dịch lại lời thoại** (**CHỈ gửi lên Cloud khi người dùng chủ động bật `cloudConsent`**).
  4. *Bước 4 - Tạo giọng đọc & Căn thời gian (TTS & Audio Timeline)*: Tổng hợp giọng đọc và căn chỉnh khớp trục thời gian (`atempo` time-stretch). Mở rộng danh mục giọng tiếng Việt Local chất lượng cao với mô hình **Sherpa-ONNX Piper Neural VITS** (VAIS-1000, 25Hours, VIVOS), hỗ trợ nghe thử trực tiếp (`Voice Preview`), thu gọn mặc định khung tài nguyên AI Local (chỉ mở rộng khi thiếu mô hình hoặc người dùng bấm xem), và đề xuất 1 giọng mặc định rõ ràng (`Ngọc Lan - VAIS-1000`).
  5. *Bước 5 - Ghép âm thanh & Xác minh*: Dùng bộ lọc ducking FFmpeg an toàn hạ nhỏ tiếng gốc khi có lời thuyết minh, ghép vào video mới trong thư mục `<Thư_mục_Nền_tảng>/Dubbed/` và xác minh file đầu ra phát được, có tiếng, ghi `.dubbing.metadata.json`, hiển thị đầy đủ ở khung **"Tiến trình & Các bản Video đã Lồng tiếng"** và **tuyệt đối không ghi đè video gốc**.

### B. Tối ưu Giao diện Co giãn & Đáp ứng Tỷ lệ Màn hình (Responsive UI)
- Sửa triệt để hiện tượng méo nút, tràn chữ, đè nút hoặc khó bấm trên các màn hình có tỷ lệ scale/zoom từ `100%` đến `175%` (đặc biệt các nút `"Đổi định dạng"`, `"Thư mục lưu"`, `"Mở thư mục"`, thanh công cụ topbar và các form quét tài khoản).
- Bổ sung cấu trúc CSS linh hoạt (`flex-wrap: wrap`, `min-width: 0`, `word-break: break-word`), cho phép tự động xuống dòng và bố cục thông minh trên cả macOS và Windows.

### C. Trình Tải & Cài đặt Công cụ Còn thiếu (Missing Tool Downloader) ([src/tool_installer.js](src/tool_installer.js))
- Bổ sung modal **"Quản lý & Tải Công cụ Còn thiếu"** trực tiếp trên giao diện:
  - Liệt kê chi tiết trạng thái từng công cụ (`yt-dlp`, `ffmpeg`, `WebKitSniffer`, mô hình Local ASR Faster-Whisper, Piper VITS TTS, Argos NMT).
  - Tự động tải từ nguồn chính thức của dự án (GitHub Releases, Evermeet, BtbN), chọn đúng hệ điều hành (`darwin` / `win32`) và kiến trúc máy (`arm64` / `x64`).
  - Xác thực mã băm toàn vẹn **SHA-256** và kiểm tra quyền chạy (`X_OK` + version probe) trước khi đưa vào sử dụng.
  - **Không bao giờ chạy binary tải về âm thầm**: Luôn hiển thị tiến độ và yêu cầu người dùng xác nhận rõ ràng trước khi tải/cài đặt.
  - Cung cấp hướng dẫn cài đặt thủ công chi tiết nếu máy không có kết nối Internet trực tiếp.

### D. Quét Hồ sơ Tài khoản, Cookie Douyin & Hàng đợi Tải Hàng loạt ([src/account_scanner.js](src/account_scanner.js))
- **Hỗ trợ đầy đủ các định dạng Cookie**: Chấp nhận chuỗi Header `key=val;`, Netscape `cookies.txt` (giữ nguyên các dòng `#HttpOnly_` như `sessionid`, `sid_tt`, `ttwid`), mảng/đối tượng JSON và lệnh cURL qua ô nhập nhiều dòng giữ nguyên xuống dòng & tab.
- **Cách ly Miền nghiêm ngặt & Bảo vệ Riêng tư**: Chỉ gửi cookie tới đúng miền nền tảng (`isCookieAllowedForUrl`), chặn rò rỉ chéo tên miền. Mặc định chỉ giữ cookie trong phiên RAM; **tuyệt đối không ghi cookie/token vào file log, lịch sử tải hay metadata lưu trên ổ đĩa**.
- **Nhận diện Hồ sơ Thực tế & WebKit Single-Pass**: Tối ưu 1 phiên `WebKitSniffer` dùng User-Agent Safari khớp WKWebView, không chặn render cửa sổ ẩn và bắt chính xác XHR JSON / `RENDER_DATA` của Douyin để trả avatar, nickname, UID, số video, số follower; báo rõ nếu gặp CAPTCHA và cung cấp nút mở trang trên trình duyệt thường để người dùng tự xác minh.
- **Tuân thủ Bản quyền & Giới hạn Nền tảng**: Không vượt CAPTCHA hay phá DRM. Hỗ trợ phân trang, lọc video tải được, giới hạn luồng tải đồng thời và hủy tác vụ quét/tải tức thì.

### E. Mở Giao diện Tức thì & Kiểm tra Môi trường Chạy nền Song song ([src/capabilities.js](src/capabilities.js))
- Thay vì bắt người dùng chờ kiểm tra toàn bộ binary và mô hình AI trước khi mở cửa sổ, app mở giao diện tức thì qua bản chụp nhanh (`getCapabilitiesSnapshot()`), đồng thời chạy kiểm tra công cụ bất đồng bộ ở chế độ nền với cơ chế gộp tiến trình đơn (`single-flight deduplication`).
- Endpoint `/api/health` phản hồi HTTP 200 trong vài mili-giây giúp launcher và web wrapper không bị nghẽn.
- Trạng thái *"Đang kiểm tra môi trường..."* được hiển thị trực quan và tự động cập nhật khi hoàn tất, không khóa các chức năng không phụ thuộc công cụ đang thiếu.

---

## 💻 3. Danh mục Mô hình Local & Yêu cầu Tài nguyên

| Tên Mô hình / Công cụ | Chức năng | Dung lượng | Giấy phép | Yêu cầu Tài nguyên | Trạng thái mặc định |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Sherpa-ONNX Piper Neural VITS (`vi_piper_vais1000`)** | Tổng hợp giọng đọc tiếng Việt chất lượng cao (Nữ Bắc — Đề xuất mặc định) | `62 MB` | MIT License | RAM >= 512 MB (CPU) | **Đã cài đặt & Hoạt động Offline** |
| **Sherpa-ONNX Piper Neural VITS (`vi_piper_25hours` / `vivos`)** | Giọng Nam Bắc, Nam/Nữ Nam Bộ và 65 người nói VIVOS | `60 - 75 MB` | MIT / Apache 2.0 | RAM >= 512 MB (CPU) | **Đã cài đặt & Hoạt động Offline** |
| **Faster-Whisper Local (`small`)** | Nhận diện giọng nói thành lời thoại thực tế có mốc thời gian (STT/ASR Offline) | `464 MB` | MIT License | RAM >= 2 GB (CPU) | **Cài tự động** (bản tiny/base đã loại vì kém) |
| **Qwen3.5 9B (MLX 4-bit trên Mac • GGUF Q4_K_M + llama.cpp trên Windows)** | Dịch Trung/Nhật/Hàn → Việt ngay trên máy, giữ ID/mốc thời gian | `5,6 – 5,8 GB` | Apache-2.0 / MIT | Mac M1+ RAM 8 GB • Windows RAM 16 GB | **Cài tự động trên Windows** (Mac: `npm run setup:full`). Thay Argos (đã loại vì kém) |
| **macOS AVSpeechSynthesizer / Windows SAPI** | Tổng hợp giọng đọc TTS hệ điều hành (Việt, Trung, Anh, Nhật, Hàn) | `0 MB` | System Native | RAM >= 256 MB (CPU) | **Có sẵn trong Hệ điều hành** |
| **FFmpeg Media Engine 6.0+** | Tách audio 16kHz, chuẩn hóa MP4, bộ lọc Auto-Ducking và ghép video | `76 MB` | LGPL v2.1+ / GPL v2 | RAM >= 512 MB (CPU) | **Đã cài đặt trong `bin/ffmpeg`** |

---

## 🚀 4. Cách Khởi Chạy & Kiểm Thử

### Khởi chạy ứng dụng
- **macOS**: Nhấp đúp vào **[CNVideoScraperPro.app](CNVideoScraperPro.app)** hoặc chạy `npm start`.
- **Windows**: Chạy **[Start_App_Windows.bat](Start_App_Windows.bat)** hoặc `npm start`.

### Chạy bộ kiểm thử tự động (Offline-Safe, không ghi đè cấu hình người dùng)
```bash
npm test
```
`npm test` chạy cả `tests/verify_all.js` (bộ cũ) và `tests/verify_upgrade.js` (âm lượng đo bằng FFmpeg, timeline, AI Provider, VieNeu-TTS, bảo mật). Chỉ chạy bộ mới:
```bash
npm run test:upgrade
```

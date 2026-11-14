# 📘 TÀI LIỆU KỸ THUẬT: TOÀN BỘ CÔNG CỤ, MA TRẬN KHẢ NĂNG & CƠ CHẾ HOẠT ĐỘNG CỦA CN VIDEO SCRAPER PRO

Tài liệu này mô tả chi tiết kiến trúc thực tế của ứng dụng **CN Video Scraper Pro**, phân biệt rõ **tính năng đã kiểm chứng thực tế (`đã kiểm tra`)**, **tính năng phụ thuộc điều kiện môi trường (`có điều kiện`)**, **nền tảng không hỗ trợ (`chưa hỗ trợ`)** và **yêu cầu mô hình Local**.

---

## 1. Kiến trúc Tổng thể & Kiểm tra Thực tế Công cụ (`src/capabilities.js`)

Thay vì gán cứng trạng thái công cụ là `"sẵn sàng"`, mô-đun [src/capabilities.js](src/capabilities.js) kiểm tra trực tiếp trên hệ điều hành mỗi khi khởi động hoặc khi người dùng nhấn **"🔄 Kiểm tra lại Binary"**:

1. **Kiểm tra sự tồn tại & quyền thực thi (`checkExecutablePermission`)**:
   - Xác minh file tồn tại trên ổ đĩa (`fs.existsSync`) và quyền thực thi (`fs.accessSync(binPath, fs.constants.X_OK)` trên macOS/Linux).
2. **Kiểm tra khởi chạy & lấy phiên bản (`runVersionProbe`)**:
   - Chạy thử tiến trình con với giới hạn thời gian (`timeoutMs`), bắt sự kiện `proc.on('error')` để không bao giờ làm crash hoặc treo ứng dụng nếu binary bị lỗi hoặc không tương thích kiến trúc CPU.
3. **5 Công cụ Lõi được Kiểm tra Thực tế**:
   - **`yt-dlp Core Extractor`** (`bin/yt-dlp` hoặc `bin/yt-dlp.exe`): Tải luồng HLS/DASH, hợp nhất phân mảnh và trích xuất metadata.
   - **`FFmpeg Media Engine`** (`ffmpeg-static`): Kiểm tra giải mã media, chuẩn hóa MP4 (`H.264/AAC`), chuyển đổi 9 định dạng, phát hiện khoảng lặng (`silencedetect`) và trộn âm thanh lồng tiếng (`amix` + `atempo`).
   - **`WebKitSniffer`** ([src/webkit_sniffer.m](src/webkit_sniffer.m) -> `bin/WebKitSniffer`): Binary Mach-O `WKWebView` riêng của macOS giúp thực thi JavaScript chống bot (`a_bogus` trên Douyin, `INIT_STATE` trên Kuaishou). Trên Windows, hệ thống tự động chuyển sang nhánh dự phòng `fallbackHttpSsrSniffer` + `yt-dlp`.
   - **`Native OS Dialog`** ([src/storage_config.js](src/storage_config.js)): Sử dụng `/usr/bin/osascript` trên macOS và `powershell.exe` (`System.Windows.Forms`) trên Windows.
   - **`Local TTS Synthesizer`** ([src/dubbing_engine.js](src/dubbing_engine.js)): Sử dụng `/usr/bin/say` (`AVSpeechSynthesizer`) trên macOS và `System.Speech.Synthesis` trên Windows.

---

## 2. Quy trình Chuẩn hóa MP4 & Chuyển đổi 9 Định dạng ([src/converter_engine.js](src/converter_engine.js))

### 2.1. Xác minh Giải mã Media (`probeMediaFile` & `verifyMediaOutput`)
- Mọi file đầu ra sau khi tải hoặc chuyển đổi đều phải đi qua hàm `verifyMediaOutput(filePath, expectedFormatId)`:
  1. Kiểm tra file tồn tại và kích thước hợp lệ (`>= 256 bytes`).
  2. Kiểm tra đúng phần mở rộng định dạng đã chọn.
  3. Chạy thử giải mã thực tế `1.5 giây` đầu tiên bằng lệnh `ffmpeg -v error -t 1.5 -i <file> -f null -` để phát hiện file hỏng header, thiếu `moov atom` hoặc codec lỗi.
  4. Kiểm tra sự hiện diện của luồng hình (`hasVideo`, `vcodec`, `vtag`) và luồng tiếng (`hasAudio`, `acodec`).

### 2.2. Chuẩn hóa MP4 Minh bạch (`ensureCompatibleMp4`)
- Không bao giờ che giấu lỗi của FFmpeg.
- Nếu video MP4 tải về dùng codec `HEVC / H.265 (hev1)`, `AV1` hoặc `VP9` (thường gặp trên Bilibili và Douyin gây lỗi đen màn hình trên QuickTime), hệ thống tự động chuyển mã sang `H.264 (avc1) + AAC` vào file tạm `*_fixing_*.mp4`, xác minh giải mã thành công rồi mới thay thế file đích.
- **Hỗ trợ Video không có tiếng (Silent Video)**: Nếu video gốc hợp lệ nhưng không có luồng âm thanh (`hasAudio: false`), hệ thống giữ nguyên trạng thái hợp lệ và báo rõ `"Không có luồng âm thanh (Video không tiếng)"`.

### 2.3. Bảo toàn File gốc khi Lỗi hoặc Hủy
- Khi người dùng chuyển đổi sang định dạng khác (`.mov`, `.mkv`, `.webm`, `.avi`, `.flv`, `.mp3`, `.wav`, `.gif`), FFmpeg luôn ghi vào file tạm `.part_<id>.<ext>`.
- Nếu quá trình chuyển đổi thất bại (ví dụ tách `.mp3` từ video không có tiếng, hoặc ổ đĩa đầy `ENOSPC`) hay bị người dùng nhấn **Hủy**, file `.part_*` được dọn sạch và **file tải gốc ban đầu được giữ nguyên 100%**.

---

## 3. Quét Danh sách Video Tài khoản & Hàng đợi Tải Hàng loạt ([src/account_scanner.js](src/account_scanner.js))

1. **Nhận diện & Xem trước Hồ sơ (`previewAccountTarget`)**:
   - Trước khi quét, hệ thống nhận diện nền tảng, trích xuất UID/handle và hiển thị rõ trạng thái hỗ trợ:
     - **Bilibili (`đã kiểm tra`)**: Quét phân trang danh sách video công khai qua `space.bilibili.com/{mid}` (kết hợp Bilibili Space API / Search API và `yt-dlp --flat-playlist`).
     - **Douyin, Kuaishou, Xiaohongshu (`có điều kiện`)**: Quét các video hiển thị công khai trên trang hồ sơ qua `WebKitSniffer` (trên macOS) hoặc Cookie do người dùng cấp.
     - **Pipixia, Youku, Tencent Video, iQIYI, MangoTV, WeTV, Xigua, Jianying (`chưa hỗ trợ quét tài khoản`)**: Báo rõ lý do kỹ thuật (nền tảng OTT phim dài tập hoặc đóng trang hồ sơ Web), đồng thời giữ nguyên tính năng tải video đơn lẻ.
2. **Chống trùng, Phân trang & Giới hạn tốc độ**:
   - Chống trùng video bằng khóa `${platformId}_${videoId}`.
   - Hỗ trợ **Làm mới danh sách (`refresh: true`)**, **Quét tiếp trang sau (`existingScanId`)** và **Hủy quét (`cancelAccountScanJob`)**.
   - Tự động nghỉ `1200ms` giữa các trang để tránh bị nền tảng chặn IP, đồng thời cô lập lỗi từng mục video.
3. **Hàng đợi Tải Hàng loạt (`enqueueBatchDownloads`)**:
   - Cho phép tìm kiếm theo từ khóa, lọc chỉ video tải được, sắp xếp theo ngày đăng/lượt xem/thời lượng, chọn từng video hoặc chọn tất cả video tải được.
   - Hỗ trợ tải hàng loạt với giới hạn số tác vụ đồng thời (`1..3` luồng, mặc định `2`), chống tải trùng và hủy từng tác vụ.
4. **Quy tắc Xác thực & Cookie An toàn**:
   - Tuyệt đối không tự động lấy hoặc trích xuất Cookie từ trình duyệt của người dùng khi chưa có sự đồng ý rõ ràng (`userConsentedCookie === true`).

---

## 4. Quy trình Lồng tiếng Video Tự động — Local-First ([src/dubbing_engine.js](src/dubbing_engine.js))

### 4.1. Quy trình 5 Bước Thực tế (Không Thay thế bằng Tiêu đề Video)
1. **Bước 1 — Trích xuất Track Âm thanh (FFmpeg)**:
   - Trích xuất track audio `16kHz Mono PCM 16-bit` (`extracted_audio_16k.wav`) bằng FFmpeg.
   - Nếu video không có track âm thanh (`hasAudio: false`), dừng ngay lập tức và báo lỗi: `"Video gốc không có track âm thanh (Audio Stream). Không thể nhận dạng giọng nói hoặc dịch tự động."`
2. **Bước 2 — Nhận dạng Giọng nói Thực tế (ASR Faster-Whisper)**:
   - Chạy Faster-Whisper qua `src/local_ai_worker.py` trên track âm thanh để trích xuất từng câu thoại thực tế kèm dấu mốc thời gian `startSec` và `endSec`.
   - **Tuyệt đối KHÔNG lấy tiêu đề video, tên file hay mô tả làm phụ đề/transcript thay thế**.
   - Nếu video chỉ có nhạc nền hoặc khoảng lặng không có lời nói, hệ thống dừng ngay và báo lỗi: `"Không nhận diện được lời thoại trong âm thanh của video (video chỉ có nhạc nền, tiếng động hoặc khoảng lặng)."`
3. **Bước 3 — Dịch thuật Lời thoại (NMT Argos / CTranslate2)**:
   - Dịch từng phân đoạn sang ngôn ngữ đích (`vi`, `en`, `zh`, `ja`, `ko`).
   - Mặc định chạy 100% Offline qua mô hình Argos CTranslate2 trên máy với cơ chế **gộp câu ngữ cảnh (Context Sentence Grouping)**, `beam_size=4`, `repetition_penalty=1.15` và hậu xử lý văn phong tiếng Việt (`Khẩu ngữ tự nhiên / Review / Kể chuyện`).
   - Hỗ trợ nút **🔄 Dịch lại lời thoại** và tùy chọn cài thêm bộ dịch đám mây (`Cloud Google Ngữ cảnh`, `Cloud Gemini AI`, `Cloud OpenAI / DeepSeek / Groq`) **chỉ hoạt động khi người dùng chủ động tích chọn xác nhận `cloudConsent`**.
4. **Bước 4 — Tổng hợp Giọng đọc & Căn Khớp Trục Thời gian (TTS & Audio Timeline)**:
   - Mở rộng các lựa chọn giọng tiếng Việt chất lượng cao bằng **Sherpa-ONNX Piper Neural VITS**:
     - *Ngọc Lan (VAIS-1000 — Nữ Bắc)*: Đề xuất mặc định (62 MB, CPU nhanh).
     - *Minh Quang (25Hours — Nam Bắc)*: Giọng nam truyền cảm (60 MB).
     - *Thanh Trúc (VIVOS — Nữ Nam Bộ)*: Giọng nữ phương Nam (75 MB).
     - *65 giọng đọc đa dạng* từ bộ dữ liệu VIVOS.
   - Bảng tài nguyên AI Local (`#dubResourcesDetailBody`) được thu gọn mặc định thành một thanh trạng thái gọn nhẹ, chỉ tự động mở rộng khi thiếu mô hình cần thiết hoặc người dùng bấm **"🔽 Xem tài nguyên"**.
   - Hỗ trợ nút **🔊 Nghe thử giọng (Voice Preview)** trước khi lồng tiếng.
   - Căn chỉnh tốc độ đọc thông minh (`atempo` tối đa `1.45x`) và dịch chuyển con trỏ thời gian để câu dịch dài hơn không bị cắt chữ hoặc chồng lấn âm thanh.
5. **Bước 5 — Ghép Âm thanh vào Video & Xác minh Đầu ra (FFmpeg Mux & Verify)**:
   - Áp dụng bộ lọc Auto-Ducking tự động hạ nhỏ âm lượng gốc (`originalVolume`) khi có lời thuyết minh lồng tiếng (`dubVolume`).
   - Biểu thức ducking được gộp cửa sổ `(gte(t,s)*lte(t,e))` ngắn gọn, tránh lỗi ngắt ngữ pháp trong bộ lọc FFmpeg.
   - Lưu video thành phẩm vào thư mục con `<Thư_mục_Nền_tảng>/Dubbed/`, ghi kèm file `.dubbing.metadata.json`, và đồng bộ hiển thị ngay qua `getAllDubbingJobs()` trong khung **"Tiến trình & Các bản Video đã Lồng tiếng"**.
   - Chạy kiểm tra giải mã thực tế bằng `verifyMediaOutput`: Đảm bảo video có hình, có tiếng và phát được.
   - **Bảo toàn 100% file gốc**: Tuyệt đối không ghi đè video gốc.

---

## 5. Trình Quản lý & Tải Công cụ Còn thiếu ([src/tool_installer.js](src/tool_installer.js))

Khi thiếu công cụ hệ thống (`yt-dlp`, `ffmpeg`, `WebKitSniffer`) hoặc mô hình AI (`localAsr`, `localTts`, `localNmt`), ứng dụng hỗ trợ người dùng tải và cài đặt tự động:
1. **Kiểm tra Môi trường Độc lập**:
   - Phân biệt rõ công cụ nào đã sẵn sàng, công cụ nào còn thiếu.
   - Không khóa cứng toàn bộ ứng dụng; các tính năng không phụ thuộc công cụ thiếu vẫn hoạt động bình thường.
2. **Nguồn Tải Chính thức & Minh bạch**:
   - Tải từ GitHub Releases chính thức của `yt-dlp`, các bản build FFmpeg uy tín (Evermeet trên macOS, BtbN trên Windows), và kho mô hình HuggingFace / Sherpa-ONNX chính thức.
   - Lựa chọn đúng hệ điều hành (`macOS / Windows`) và kiến trúc chip (`arm64 / x64`).
3. **Xác minh Toàn vẹn & Quyền Chạy**:
   - Xác thực mã băm SHA-256 sau khi tải để chống file hỏng hoặc bị sửa đổi.
   - Cấp quyền thực thi (`chmod +x` / `X_OK`) và chạy thử lệnh `--version` để đảm bảo binary hoạt động được trước khi bàn giao.
4. **An toàn & Minh bạch**:
   - **Tuyệt đối không chạy ngầm binary**: Luôn yêu cầu người dùng bấm xác nhận (`userConfirmed: true`).
   - Cung cấp tài liệu và câu lệnh cài đặt thủ công chi tiết nếu tải tự động thất bại do sự cố mạng.

---

## 6. Cơ chế Quét Hồ sơ Tài khoản, Cookie Douyin & Hàng đợi Tải Hàng loạt ([src/account_scanner.js](src/account_scanner.js))

1. **Hỗ trợ Đa Định dạng Cookie qua Ô nhập Nhiều dòng (`<textarea>`)**:
   - *Chuỗi Header HTTP*: `sessionid=...; ttwid=...; passport_csrf_token=...;`
   - *Định dạng Netscape (`cookies.txt`)*: Giữ nguyên ký tự xuống dòng/tab và tự động giải mã cả các cookie quan trọng có tiền tố `#HttpOnly_` (`sessionid`, `sessionid_ss`, `sid_tt`, `uid_tt`).
   - *Mảng/Object JSON & Lệnh cURL*: `[{"name": "sessionid", "value": "...", "domain": ".douyin.com"}]`, `{cookies:[...]}` hoặc `curl ... -H 'cookie: ...'`.
   - Xác thực cú pháp đầu vào và báo rõ số lượng cookie hợp lệ.
2. **Cách ly Miền Nghiêm ngặt & Bảo vệ Riêng tư**:
   - Hàm `isCookieAllowedForUrl` chỉ cho phép gửi cookie tới đúng tên miền của nền tảng (ví dụ cookie Douyin chỉ gửi tới `*.douyin.com`, không gửi tới các miền khác).
   - Ngăn chặn hoàn toàn việc rò rỉ cookie chéo giữa các nền tảng hoặc sang các yêu cầu bên ngoài.
3. **Bảo mật Dữ liệu Riêng tư**:
   - Mặc định chỉ giữ cookie trong bộ nhớ RAM của phiên làm việc.
   - Hàm `sanitizeMetadataForDisk` tự động loại bỏ mọi trường nhạy cảm (`cookie`, `Cookie`, `Authorization`, `token`) trước khi ghi bất kỳ metadata hoặc file lịch sử nào lên ổ đĩa.
4. **Nhận diện Hồ sơ Thực tế & WebKitSniffer Single-Pass**:
   - Sử dụng 1 phiên `WebKitSniffer` với Safari User-Agent khớp macOS `WKWebView`, chặn suy hao khung hình ở cửa sổ ẩn, cuộn phân trang liên tiếp và parse an toàn XHR JSON (`responseType === 'json'`), `fetch(Request)` lẫn `RENDER_DATA` của Douyin.
   - Bóc tách thông tin tài khoản thực: Ảnh đại diện (avatar), tên hiển thị (nickname), ID người dùng, tổng số video và số người theo dõi.
   - Nếu không lấy được thông tin chi tiết (ví dụ Douyin yêu cầu đăng nhập hoặc bật CAPTCHA), ứng dụng báo rõ và hiển thị nút **"🌐 Mở trang trên Trình duyệt"** để người dùng tự xác minh thủ công.
5. **Hàng đợi Tải Hàng loạt Có Kiểm soát**:
   - Tự động lọc bỏ các video bị khóa quyền hoặc không tải được.
   - Kiểm soát số luồng tải đồng thời (1-3 luồng) tránh nghẽn băng thông và bị khóa IP.
   - Hỗ trợ nút Hủy tức thì cho cả tác vụ quét và tác vụ tải.
6. **Tuân thủ Bản quyền & Bảo mật**:
   - Tuyệt đối không vượt CAPTCHA, DRM hoặc xâm nhập trái phép cơ chế bảo vệ của nền tảng.

---

## 7. Khởi động Tức thì & Kiểm tra Môi trường Chạy nền ([src/capabilities.js](src/capabilities.js))

1. **Giao diện Mở Ngay Lập tức**:
   - Hàm `getCapabilitiesSnapshot()` trả về kết quả bộ nhớ đệm ngay tức thì (dưới 10ms), cho phép cửa sổ ứng dụng mở ngay khi khởi chạy.
   - Khởi động kiểm tra môi trường chạy nền bất đồng bộ với cơ chế chống trùng tiến trình (`single-flight deduplication`), tránh spawn lặp lại nhiều tiến trình kiểm tra cùng lúc.
2. **Cập nhật Trạng thái Thời gian thực**:
   - Trong khi kiểm tra, giao diện hiển thị trạng thái `"Đang kiểm tra..."`.
   - Khi hoàn tất, giao diện tự động cập nhật danh sách công cụ sẵn sàng / còn thiếu và hiển thị nút mở hộp thoại tải công cụ.
3. **Endpoint `/api/health` Siêu tốc**:
   - Trả về HTTP 200 trong vòng 1-2ms giúp launcher và các wrapper kiểm tra trạng thái dịch vụ mà không gây trễ giao diện.

---

## 8. Tối ưu Giao diện Co giãn & Đổi Tỷ lệ Màn hình (Responsive UI)

1. **Khắc phục Lỗi Méo nút & Tràn viền**:
   - Các nút chức năng `"Đổi định dạng"`, `"Thư mục lưu"`, `"Mở thư mục"` và thanh công cụ đầu trang được cấu hình `flex-wrap: wrap`, `min-width: 0`, `white-space: normal` giúp nút tự động co giãn và xuống dòng hợp lý.
   - Đảm bảo giao diện hiển thị chuẩn xác, không bị cắt chữ hay chồng lấn nút ở mọi tỷ lệ thu phóng (100%, 125%, 150%, 175%) và các kích thước cửa sổ thông dụng trên cả macOS và Windows.
2. **Bố cục Phân đoạn Lồng tiếng & Modal Tải Công cụ**:
   - Bảng kịch bản 5 bước lồng tiếng và danh sách công cụ cần tải được thiết kế dạng thẻ responsive, hỗ trợ cuộn độc lập và tương tác mượt mà trên màn hình nhỏ.

---

## 9. Bộ Kiểm thử Tự động Toàn diện (`tests/verify_all.js`)

Chạy lệnh kiểm thử toàn diện:
```bash
npm test
```
hoặc:
```bash
node tests/verify_all.js
```

### Kết quả Kiểm thử Đạt 100% (39 PASS / 0 FAIL):
- **Phần A (Media & Chuyển đổi)**: 7 bài kiểm tra (Chuẩn hóa MP4, video câm, phát hiện file hỏng, chuyển đổi .MOV, xử lý lỗi dọn file tạm, hủy tác vụ, xử lý ổ đĩa đầy ENOSPC).
- **Phần B (Binary & Tải công cụ & Khởi động nhanh)**: 10 bài kiểm tra (Phát hiện thực tế yt-dlp/ffmpeg, trạng thái công cụ thiếu, ma trận 12 nền tảng, tự đổi cổng server, snapshot mở tức thì, /api/health phản hồi mili-giây, catalog tải công cụ, chặn tải ngầm khi chưa xác nhận, kiểm tra mã băm SHA-256, kiểm tra cú pháp Frontend `public/app.js`).
- **Phần C (Quét tài khoản, Cookie & Hàng đợi)**: 9 bài kiểm tra (Nhận diện UID Bilibili, phân biệt hồ sơ xác minh vs URL mục tiêu, đánh dấu nền tảng OTT chưa hỗ trợ, hỗ trợ 3 định dạng cookie Header/Netscape/JSON, cách ly miền cookie, không lưu cookie vào metadata trên đĩa, hủy lượt quét đang chạy, kiểm soát số luồng tải hàng loạt, giữ nguyên dòng `#HttpOnly_` của Douyin & phân tích cURL/JSON).
- **Phần D (Lồng tiếng 5 bước, Dịch Ngữ cảnh & Danh sách Tiến trình)**: 12 bài kiểm tra (Catalog mô hình local rõ RAM/dung lượng/giấy phép, mở rộng 10 lựa chọn giọng tiếng Việt Neural VITS với 1 giọng mặc định minh bạch, voice preview nghe thử offline, chặn cloud khi chưa đồng ý, nhận dạng ASR Faster-Whisper thực tế có mốc thời gian, từ chối video không có lời thoại, từ chối video không có luồng âm thanh, lồng tiếng hoàn tất 5 bước lưu vào Dubbed/ có tiếng và bảo toàn file gốc, hủy tác vụ lồng tiếng, trả về đầy đủ danh sách đã lồng tiếng qua `getAllDubbingJobs()` + `.dubbing.metadata.json`, `/api/dubbing/config` + mặc định thu gọn tài nguyên Local, dịch lại ngữ cảnh Local NMT & chặn Cloud khi thiếu `cloudConsent`).
- **Bảo toàn Cấu hình Người dùng**: 1 bài kiểm tra xác minh file cấu hình thực tế `config/storage_settings.json` của người dùng không bao giờ bị ghi đè trong quá trình test.

---

## 10. Giới hạn Kỹ thuật Còn lại & Khuyến nghị Vận hành

1. **Nền tảng OTT Phim Bản quyền (Youku, iQIYI, Tencent Video)**:
   - Các tập phim VIP hoặc có cơ chế mã hóa DRM (Widevine / ChinaDRM) yêu cầu người dùng phải có tài khoản VIP và cung cấp Cookie hợp lệ. Ứng dụng chỉ tải được các tập phim công khai miễn phí.
2. **Cơ chế Chống Bot Động của Douyin / Xiaohongshu**:
   - Khi Douyin hoặc Xiaohongshu kích hoạt xác thực hình ảnh (Sliding CAPTCHA) trên địa chỉ IP của người dùng, ứng dụng không cố gắng vượt CAPTCHA trái phép. Người dùng cần mở trình duyệt, hoàn thành xác thực và sao chép chuỗi Cookie Header dán vào ô Cookie của ứng dụng để tiếp tục.
3. **Yêu cầu Phần cứng cho Mô hình Local AI**:
   - Để chạy Faster-Whisper và Piper Neural VITS mượt mà, máy tính nên có tối thiểu 4GB RAM khả dụng (khuyến nghị 8GB+ RAM trên Apple Silicon M1/M2/M3/M4 hoặc máy tính có CPU Intel/AMD đa nhân).

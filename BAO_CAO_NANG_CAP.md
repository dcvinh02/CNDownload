# Báo cáo nâng cấp CN Video Scraper Pro — bản 1.3.0 (đợt 3), 1.2.0 (đợt 2), 1.1.0 (đợt 1)

## ĐỢT 3 (15/11/2026) — Chạy trên Windows, tối ưu dung lượng để đưa lên GitHub/Drive

### 3.1. Vấn đề tìm thấy
| Vấn đề | Ảnh hưởng | Cách sửa |
|---|---|---|
| Môi trường Python AI (`.venv`) trong repo là bản **macOS**, không có gì tạo lại trên Windows | Trên Windows: nhận dạng giọng nói, tách giọng, TTS, dịch Offline đều không chạy | `src/python_env.js` + `requirements/*.txt`: tự cài `uv` → Python 3.12 độc lập → `.venv` (chạy được trên Windows/macOS); mục "Môi trường Python AI" trong trình cài |
| Dữ liệu phân đoạn truyền qua tham số dòng lệnh | Windows giới hạn 32.767 ký tự; video 38 phút cần 95.761 ký tự → lỗi | Truyền qua file tạm (`--payload-file`), tự xóa sau khi xong |
| Giải nén bằng `tar -xjf` / `unzip` | Windows không có `unzip`; `tar` của Windows không chắc hỗ trợ bz2 | Giải nén bằng Python (tarfile/zipfile), có chặn đường dẫn nguy hiểm |
| AI Local Qwen (MLX) chỉ chạy trên Mac | Windows không có dịch Offline chất lượng tốt | Cho phép "API tương thích OpenAI" trỏ tới **Ollama/LM Studio trên máy, không cần key, không cần đồng ý Cloud**; Argos là dự phòng; ẩn mục Qwen trên Windows |
| Giọng hệ thống macOS (Linh, Tingting…) hiện trên Windows | SAPI Windows đọc bằng giọng mặc định (tiếng Anh) → đọc tiếng Việt sai | Chỉ cho giọng hệ thống tiếng Anh trên Windows |
| `fs.existsSync(null)` khi chưa có ffmpeg | Cảnh báo, sẽ thành lỗi ở Node bản mới | Kiểm tra null |
| Repo/lịch sử git: 694 MB, có file 138 MB, video cá nhân, `.venv`, `node_modules` | GitHub từ chối file > 100 MB; lộ dữ liệu riêng | `.gitignore` mới: repo chỉ còn mã nguồn |
| `bin/ffmpeg` (43 MB) trùng hoàn toàn ffmpeg của gói npm `ffmpeg-static` | Dư dung lượng; bản macOS vô dụng trên Windows | Bỏ khỏi repo — `npm install` tự cài đúng bản cho từng HĐH |

### 3.2. Dung lượng
| | Trước | Sau |
|---|---|---|
| Mã nguồn lên GitHub | ~10 GB thư mục / 694 MB lịch sử git | **55 file, ~3 MB** (gói zip 1,8 MB) |
| Gói model chia sẻ qua Drive (tùy chọn) | — | 878 MB (không Qwen), dùng được trên cả Windows và macOS |
| Cài trên máy mới (core) | — | ~2,2 GB tải tự động (Python + thư viện + model) |

Những gì bị loại khỏi repo đều được tạo lại tự động: `npm install --omit=dev` (Node + ffmpeg đúng HĐH) và `npm run setup` (Python, yt-dlp, model). **Dữ liệu riêng không bao giờ lên repo:** `config/ai_secrets.json` (API Key), nhật ký AI, cấu hình máy, video tải về.

### 3.3. Kiểm thử đợt 3
| Hạng mục | Kết quả | Bằng chứng |
|---|---|---|
| Thư viện Python cài được trên Windows x64 | PASS (gián tiếp) | `uv pip compile` cho `x86_64-pc-windows-msvc` + Python 3.12, chỉ dùng wheel dựng sẵn: lõi 38 gói, VieNeu 81 gói giải được hết |
| Cài từ mã nguồn trống ("máy mới", macOS, thư mục có dấu cách) | PASS | 7/7 thành phần tự cài & xác minh (Python 3.12 + thư viện, yt-dlp, ASR small, phân tách người nói, tách giọng, VieNeu 25 giọng, Piper) |
| Bộ test trong bản cài "máy mới" | PASS | 39/39 + 53/53 (sau khi cài thêm Argos như `setup` làm trên Windows). Lần chạy đầu phát hiện lỗi thật: `av>=15` kéo PyAV 19 → faster-whisper lỗi `metadata_errors` → đã ghim `av==15.1.0`, `numpy==2.2.6`; bước kiểm tra "Python AI" giờ giải mã một file WAV thật, `setup` tự phát hiện & cài lại môi trường hỏng |
| Máy chưa có bộ dịch Offline nào (Argos/Qwen/Ollama) | BLOCKED (đúng) | Test báo BLOCKED thay vì làm hỏng cả bộ test; ứng dụng báo rõ cần cài bộ dịch hoặc bật dịch Cloud |
| Khôi phục từ gói Drive (mã nguồn + model) | PASS | Model nhận đúng ngay, 0 symlink, setup bỏ qua phần đã có |
| Dữ liệu lớn qua file tạm | PASS | 57.467 ký tự, 1.500 phân đoạn, file tạm được xóa |
| Ollama/LM Studio không cần key | PASS | Test giao thức: `usedCloud=false`, không cần đồng ý Cloud |
| Mô phỏng nhánh code Windows (`process.platform=win32`) | PASS | Mọi API trả 200, đường dẫn `.venv\Scripts\python.exe`, `yt-dlp.exe`, `uv-x86_64-pc-windows-msvc.zip`, ẩn Qwen/WebKit |
| Dự án chính sau thay đổi | PASS | 39/39 + 53/53 |
| **Chạy trên máy Windows thật** | **BLOCKED** | Không có máy Windows. Đã thêm `.github/workflows/ci.yml` — GitHub sẽ tự cài & chạy toàn bộ test trên Windows thật mỗi lần đẩy code |

### 3.4. Cài trên Windows
1. Cài [Node.js LTS](https://nodejs.org). 2. Giải nén mã nguồn vào đường dẫn ngắn (vd. `C:\CNVideo`). 3. Nhấp đúp `Start_App_Windows.bat` — lần đầu tự `npm install` + `setup` (~2,2 GB), các lần sau mở thẳng ứng dụng. Dịch AI không cần key trên Windows: cài [Ollama](https://ollama.com), tải 1 model (vd. `ollama pull qwen2.5:7b`), nhập Base URL `http://127.0.0.1:11434/v1` ở mục "API tương thích OpenAI".

---


## ĐỢT 2 (15/11/2026) — Sửa lỗi thực tế, AI Local, AI Gateway

Máy kiểm thử: macOS, Apple M2 Pro, RAM 16 GB. Chỉ ghi PASS khi đã chạy thật và có số đo.

### 2.1. Nguyên nhân gốc & cách sửa

| Lỗi bạn báo | Nguyên nhân gốc (đã tái hiện) | Cách sửa | Bằng chứng |
|---|---|---|---|
| Thanh tải đơn treo dù file đã xong | (1) Lỗi do đợt 1 gây ra: biến `warnHtml` chèn nhầm vào hàm vẽ danh sách tải → khi tác vụ "completed" hàm ném `ReferenceError` (bị nuốt) nên danh sách không vẽ lại, thanh đứng ở 98%. (2) Regex tiến độ yt-dlp hỏng với dòng HLS `of ~  20MiB`; tải video rồi âm thanh làm thanh nhảy 100%→0%; giai đoạn ghép không có trạng thái | Sửa vị trí `warnHtml`, ghi log lỗi thay vì nuốt; tiến độ yt-dlp gộp nhiều luồng thành 1 thanh tăng dần + trạng thái "đang ghép" | Tải thật trong WebKit: UI chuyển "✅ Hoàn tất", 0 lỗi console; tiến độ video 5 phút tăng đều 0→95→96% (ghép) → xong; test tự động dựng lại tình huống |
| Nghe thử không phát | Endpoint nghe thử không hỗ trợ HTTP Range (trả 200 chunked). WebKit (giao diện app macOS) bắt buộc Range → từ chối phát (`NotSupportedError`); giao diện nuốt lỗi `play()` | Phục vụ media có Range/206 + Content-Length; WKWebView cho phép phát media không cần thao tác; báo lỗi rõ nếu trình duyệt chặn | Đối chứng trong WebKit thật: không Range → `NotSupportedError`; có Range → phát 2,6/5,4 s |
| Giọng gốc nói trước rồi giọng dịch mới phát | Whisper gộp 2 câu cách nhau 1 s (chỉ có dấu phẩy) thành 1 phân đoạn → lời dịch 2 câu đọc liền từ câu 1, câu 2 lệch ~5 s; ngoài ra giọng gốc vẫn nghe dưới giọng lồng | Tách phân đoạn theo khoảng nghỉ thật giữa các từ (≥ 0,45 s) và dấu câu; không gộp qua khoảng nghỉ; **tách giọng gốc khỏi nhạc nền (Spleeter)** — chỉ giữ nhạc nền & tiếng động | Video thử 3 câu: lời lồng bắt đầu 0,95 / 6,01 / 11,49 s so với gốc 1,00 / 6,00 / 11,50 s (lệch ≤ 50 ms); lời nói gốc giảm 45,6 dB |
| Cân bằng âm lượng | Giọng lồng chuẩn hóa cố định −20 dBFS, không theo độ to video gốc | Đo độ to lời nói gốc (theo các đoạn ASR) và chuẩn hóa giọng lồng ngang mức đó (giới hạn −26…−14 dBFS); mặc định giữ nhạc nền 80% khi đã tách giọng | APEC: lời gốc −15,8 dBFS → giọng lồng −15,8 dBFS |
| Không thấy đủ model AI / AI không chạy | Model `gemini-2.5-flash` đặt cứng đã bị Google ngừng (404); tài khoản OpenAI của bạn **hết credit** (429); `gemini-flash-latest` đang quá tải (503/timeout) | Bỏ model đặt cứng: tự chọn model khuyến nghị từ danh sách thật, ghi nhớ model bị ngừng, chuỗi dự phòng tự động; ô chọn liệt kê **toàn bộ** model của mọi nhà cung cấp | API thật: 404 → ghi nhớ → đổi model → timeout → dự phòng `gemini-flash-lite-latest` → thành công |
| Không thấy tiến độ phân đoạn & dịch | Gọi đồng bộ 1 request HTTP, không có trạng thái | Tác vụ nền + khung theo dõi: từng giai đoạn, giây âm thanh đã nhận dạng, số khối phân tách người nói, số đoạn đã dịch, lỗi/cảnh báo, nút hủy | WebKit: thấy 8%→35%→57%→…→100%, 5 giai đoạn |

### 2.2. Local AI — đánh giá Qwen (30 câu thật: 15 câu chính luận + 15 câu thoại phim cổ trang có lỗi ASR)

| Model | Thời gian | RAM | Kết quả |
|---|---|---|---|
| **Qwen3.5-9B (MLX 4-bit)** — đã chọn | 96 s | 4,7 GB | Tốt nhất trong các model local: "ngỗng trời" (大雁) đúng, Hán-Việt ("Tiểu lão nhân", "Lư Linh Phong", "Tô Vô Danh") |
| Qwen3.5-4B | 115 s | 2,2 GB | Sai nghĩa nhiều, hay sót chữ Hán → loại |
| Qwen2.5-7B-Instruct | thất bại | 3,7 GB | Chép nguyên câu tiếng Trung → loại |
| Argos (cũ) | 2,5 s | — | Kém nhất ("Tôi đã thấy Dwayne") → thay bằng Qwen |
| Gemini flash-lite (Cloud, tham chiếu) | 10 s | — | Tốt nhất tổng thể, sửa được cả lỗi ASR |

Chạy bằng Apple MLX (`mlx-lm`, cài từ PyPI vào `.venv-llm`), máy chủ OpenAI-compatible chỉ nghe 127.0.0.1, tự tắt sau 8 phút rảnh. **Đã xóa model thừa**: Qwen3.5-4B, Qwen2.5-7B, Argos (158 MB), Faster-Whisper tiny/base (216 MB). Argos/tiny vẫn có thể tải lại trong trình cài nếu cần. "Offline trên máy" giờ dùng Qwen3.5-9B.

### 2.3. Tích hợp ChatGPT Web / Gemini Web — kết luận
- **Không triển khai tự động hóa trình duyệt/ứng dụng desktop ChatGPT, Gemini.** Điều khoản sử dụng của OpenAI cấm trích xuất dữ liệu/kết quả bằng phương thức tự động; giao diện web có cơ chế chống bot/CAPTCHA và thay đổi liên tục nên rất dễ hỏng; máy có ChatGPT.app/Gemini.app nhưng không có API tự động hóa chính thức.
- **Đã triển khai thay thế:** (1) AI Local Qwen — không cần key, không gửi dữ liệu; (2) AI Gateway với Gemini/OpenAI chính thức + "API tương thích OpenAI" (DeepSeek, Groq, OpenRouter, hoặc LM Studio/Ollama chạy trên máy — không cần key). Gemini API có hạn mức miễn phí qua AI Studio.

### 2.4. AI Gateway
Hàng đợi theo nhà cung cấp (Local 1 luồng, Cloud 2 luồng) • thử lại theo loại lỗi (timeout không thử lại cùng model) • **dự phòng tự động** (model khác cùng nhà cung cấp → AI Local) và dự phòng tự cấu hình • ghi nhớ model bị ngừng & đẩy model đang quá tải xuống cuối 15 phút • hạn mức request/token theo tháng • nhật ký `config/ai_logs.jsonl` (đã ẩn key, xem trong tab AI) • **lưu đệm bản dịch theo lô** + **lưu trạng thái tác vụ lồng tiếng** (bị tắt giữa chừng → hiện "Bị gián đoạn" + nút "Chạy tiếp", phần dịch đã xong không tốn request lại).

Bảo toàn dữ liệu: timestamp/ID luôn lấy từ dữ liệu gốc; kết quả AI được kiểm tra số lượng, ID, thứ tự; tự loại ngoặc kép/tiền tố "Dịch:"; **chặn** bản dịch còn chữ Hán, có ghi chú, lặp từ, trùng câu gốc (chỉ dịch lại câu lỗi); kiểm tra lần nữa trước khi TTS.

### 2.5. Kết quả kiểm thử đợt 2
`npm test`: **39/39 + 52/52 PASS**.

| Hạng mục | Kết quả | Ghi chú |
|---|---|---|
| Thanh tải đơn | PASS | Tải thật trong WebKit + test hồi quy dựng lại lỗi |
| Nghe thử (WebKit/app macOS) | PASS | Có đối chứng không-Range |
| Đồng bộ lồng tiếng | PASS | Lệch ≤ 50 ms trên 3 câu |
| Tách giọng gốc | PASS | −45,6 dB lời gốc |
| Cân bằng âm lượng | PASS | Giọng lồng = độ to lời gốc |
| Tiến độ phân đoạn & dịch | PASS | Qua API và WebKit |
| Danh sách toàn bộ model | PASS | 38 model Gemini, 48 OpenAI (từ API thật), Qwen local |
| Dịch Gemini thật | PASS | flash-lite 1,3–10 s; 3.5-flash 13 s (có lỗi lặp từ → bị chặn); 3.8-flash/flash-latest đang quá tải |
| Dịch OpenAI thật | **BLOCKED** | Tài khoản hết credit (429 "no credits remaining") — cần nạp tiền |
| AI Local Qwen 9B | PASS | Toàn luồng APEC 114,6 s |
| Toàn luồng tải → phân đoạn → dịch → TTS → đồng bộ → xuất | PASS | Gemini 48,6 s; Qwen 114,6 s (video 66 s) |
| Phục hồi khi bị gián đoạn | PASS | Giết tiến trình ở 56% → chạy tiếp hoàn tất 54,6 s |
| Ứng dụng macOS (binary build lại) | PASS có giới hạn | Biên dịch thành công; hành vi WebKit đã kiểm bằng công cụ WKWebView cùng cấu hình; chưa mở cửa sổ app thật |

### 2.6. Cần bạn làm
1. **Tắt hẳn ứng dụng rồi mở lại** (server cổng 3889 đang chạy bản cũ).
2. OpenAI: nạp credit nếu muốn dùng; nếu không, Gateway tự dùng Gemini/Local.
3. Model Gemini của bạn đã được tự đổi khỏi `gemini-2.5-flash` (đã ngừng).

---

## ĐỢT 1 — bản 1.1.0

Ngày thực hiện: 14/11/2026 · Máy kiểm thử: macOS, Apple M2 Pro, RAM 16 GB, Node v26.13, FFmpeg 6.0

Báo cáo chỉ ghi **PASS** cho mục đã chạy thật và có bằng chứng đo được. Mục không kiểm thử được ghi rõ **BLOCKED** kèm lý do.

---

## 1. Hiện trạng trước khi sửa (nguyên nhân gốc)

| Chức năng | Hiện trạng | Vấn đề | Nguyên nhân gốc | Hướng xử lý |
|---|---|---|---|---|
| Âm lượng gốc | Sai | Đặt 0% vẫn nghe tiếng gốc; mức xuất ra thấp hơn thiết lập | (1) Auto-Ducking cứng mức **85%** ngoài đoạn lời thoại, bỏ qua thanh trượt; (2) `amix` mặc định **chia đôi** mỗi nguồn (−6 dB); (3) FFmpeg nâng mono→stereo giảm **−3 dB** (áp cả vào âm gốc lẫn đường bao); (4) không thể tăng quá 100% | Viết lại bộ trộn: đường bao âm lượng float32 nhân với âm gốc, `amix normalize=0`, `pan` cho nguồn mono, cho phép 0–200% |
| Âm lượng lồng tiếng | Sai | Không tắt được giọng lồng; mức không ổn định | `Number(dubVolume) \|\| 1.15` biến 0 thành 115%; timeline trộn N đoạn bằng `amix` (chia cho N+1) rồi `dynaudnorm` + `volume=1.35` | Dựng timeline bằng Node (ghi tuần tự, bộ nhớ O(1)), chuẩn hóa RMS −20 dBFS một lần, 100% = mức chuẩn |
| Đồng bộ lồng tiếng | Kém | Cắt mất cuối câu; câu bị méo khi tăng tốc | `atempo` tới 2.1x rồi `-t` **cắt cụt** phần dư; không dùng khoảng lặng sau câu | Bộ lập lịch mới: dùng khoảng lặng, bắt đầu sớm ≤ 0,25 s, tăng tốc ≤ 1,3x, phần dư đẩy lùi câu sau — không cắt, không chồng lấn |
| Dịch Offline | Sai lệch nghĩa | Bản dịch câu này nằm ở đoạn khác ("一花不是春" → "Cái lớn,") | Gộp 4 đoạn để dịch rồi **chia lại theo độ dài ký tự** | Dịch từng đoạn riêng (giữ đúng ID/timestamp) |
| Dịch AI (Gemini/OpenAI) | Có nhưng yếu | Video dài lỗi; lỗi API không rõ; key nhập mỗi lần | Gửi toàn bộ trong 1 request (timeout 35 s, vượt token); chỉ kiểm số lượng; không retry; key truyền qua biến môi trường mỗi lần | Lớp AI Provider tập trung + dịch theo lô có kiểm tra cấu trúc |
| ASR | Sai nhiều | Nhận sai thuật ngữ, trộn phồn thể/giản thể, đoạn dài 14 s nhiều câu | Model `base`; không gợi ý ngôn ngữ; không tách câu | Ưu tiên model `small`, gợi ý giản thể, tách câu bằng word-timestamps |
| Video dài | Hỏng | Dừng ở 180 s | Timeout cố định 180 s cho ASR và TTS | Timeout theo độ dài; tiến độ thời gian thực từ worker |
| Nhiều người nói | Không có | Mọi câu đọc cùng một giọng | Không có bước phân tách người nói | Phân tách người nói offline (sherpa-onnx) + gộp cụm theo embedding; mỗi người nói một giọng |
| Dịch Offline tiếng Hàn/Nhật | Hỏng (lỗi mới phát hiện) | "Cặp ngôn ngữ KO → VI chưa có mô hình" | Cầu nối Whisper→Anh yêu cầu số đoạn khớp tuyệt đối | Ghép bản dịch cầu nối theo thời gian (word timestamps); đoạn thiếu được đánh dấu để nhập tay thay vì dừng cả quy trình |
| Đo thời lượng đoạn TTS | (lỗi mới phát hiện khi chạy thử) | Mọi đoạn đo được 0,042 s | Đọc header WAV trong bộ đệm 4 KB | Dùng kích thước khai báo trong header |
| Quét tài khoản Bilibili | Không dùng được | 0 video ("Unexpected token '<'"); có thể hiện **video của người khác** | API `seasons_series_list` chỉ trả bộ sưu tập (nay 404); dự phòng tìm kiếm từ khóa bị chặn (trả HTML) và nếu không khớp UID thì vẫn trả toàn bộ kết quả tìm kiếm | Liệt kê video tải lên qua yt-dlp (+Cookie người dùng), bỏ nhánh tìm kiếm, thông báo lỗi rõ |
| Quét Douyin/Kuaishou/XHS | Có điều kiện | Không nhận diện được vẫn báo "hoàn tất" | Không phân biệt "không có video" và "không vào được hồ sơ" | Trạng thái "thất bại" kèm lý do cụ thể; nhật ký quét |
| Bảo mật API cục bộ | **Lỗ hổng** | Website bất kỳ mở trên máy có thể đọc file tùy ý | `cors()` cho mọi origin + `/api/play-local?path=` đọc mọi đường dẫn (vd. `/etc/passwd`) | Chặn Origin/Host lạ; chỉ phục vụ file media trong thư mục lưu |

---

## 2. Thay đổi đã thực hiện

### File mới
| File | Nội dung |
|---|---|
| `src/ai/ai_provider_manager.js` | AI Provider Manager: Adapter Gemini / OpenAI / tương thích OpenAI, lưu cấu hình & key (0600), kiểm tra kết nối, hạn mức tháng, thống kê token, phân loại lỗi + retry |
| `src/ai/llm_translator.js` | Dịch phân đoạn bằng AI với prompt phiên dịch viên (nguyên văn yêu cầu), lô + ngữ cảnh, kiểm tra cấu trúc, tự sửa |
| `src/audio_timeline.js` | Lập lịch đoạn lồng tiếng, ghi timeline WAV, đường bao âm lượng gốc |
| `src/vieneu_service.js`, `src/vieneu_worker.py` | Tiến trình VieNeu-TTS chạy lâu (nạp mô hình 1 lần), hàng đợi, hủy, timeout, chạy offline |
| `tests/verify_upgrade.js` | 42 kiểm thử: đo âm lượng thật, timeline, AI Provider, VieNeu, nhận diện người nói, bảo mật |
| `bin/models/diarization/` | Mô hình phân tách người nói (45 MB, tải từ GitHub Releases k2-fsa) |
| `.env.example`, `.gitignore` | Biến môi trường tùy chọn; chặn commit file key/cache |

### File sửa
| File | Thay đổi chính |
|---|---|
| `src/dubbing_engine.js` | Danh mục giọng VieNeu động; định tuyến bộ dịch (local / Google / AI); `sanitizeSegments` (schema có `id`, `speakerId`); tổng hợp nhiều giọng theo người nói; bộ trộn âm lượng mới; timeout theo độ dài; hủy bằng AbortController |
| `src/local_ai_worker.py` | Báo tiến độ; `--skip-translation`; gợi ý giản thể; tách câu bằng word-timestamps; dịch Offline từng đoạn; phân tách người nói (`--diarize`); cầu nối KO/JA theo thời gian; bỏ code gọi LLM trùng lặp |
| `src/account_scanner.js` | Bilibili qua yt-dlp + chi tiết video công khai; xử lý trang HTML/chặn; dừng khi bị giới hạn tốc độ; nhật ký quét; quét nhiều tài khoản |
| `src/tool_installer.js` | Mục cài VieNeu-TTS (uv → Python 3.12 → `.venv-vieneu` → `pip install vieneu` → tải mô hình), Faster-Whisper Small và mô hình phân tách người nói |
| `src/server.js` | Chặn Origin/Host lạ; giới hạn đường dẫn media; API `/api/ai/*`, `/api/account/scan-multi*` |
| `public/*` | Tab "🤖 Tích hợp AI"; khung âm lượng mới; cột người nói + chọn giọng theo người nói; nhật ký quét; quét nhiều tài khoản |
| `package.json` | Bỏ `cors` (không còn dùng); `npm test` chạy cả 2 bộ kiểm thử |

### Kiến trúc AI
```
Chức năng (Dịch lời thoại, ...)  ──>  resolveFeatureTarget(feature)  ──>  provider + model theo cấu hình
                                              │
                                   generateText() — kiểm hạn mức → gọi Adapter → retry lỗi tạm thời → ghi usage
                                              │
                      ┌───────────────────────┼─────────────────────────┐
               Gemini Adapter         OpenAI Adapter          OpenAI-compatible Adapter
       (generateContent + JSON schema) (chat/completions + json_object)   (Base URL tùy chỉnh)
```
Thêm nhà cung cấp mới = thêm 1 Adapter có `listModels()` và `generate()`; thêm chức năng AI mới = thêm 1 mục trong `FEATURES_META`.

### Quy trình dịch & lồng tiếng
1. FFmpeg tách âm thanh 16 kHz mono → 2. Faster-Whisper (small) nhận dạng, tách câu, gắn `id`, `startSec`, `endSec`, `speakerId` → 3. Dịch từng phân đoạn theo ID (AI/Google/Offline) → 4. TTS từng đoạn (VieNeu/Piper/hệ điều hành/Edge; mỗi người nói một giọng) → 5. Chuẩn hóa 48 kHz, cắt khoảng lặng thừa → 6. Lập lịch theo timestamp (không cắt, không chồng lấn) → 7. Dựng track lồng tiếng → 8. Trộn với âm gốc theo âm lượng người dùng → 9. Ghép video (giữ nguyên luồng hình) → 10. Xác minh file xuất, ghi `.srt` và `.dubbing.metadata.json`.

---

## 3. Kết quả kiểm thử

Lệnh: `npm test` → **`verify_all.js`: 39 PASS / 0 FAIL** · **`verify_upgrade.js`: 42 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED**

| Chức năng | Kết quả | Bằng chứng / ghi chú |
|---|---|---|
| Âm lượng gốc 100% / 50% / 20% / 200% / 0% | **PASS** | Đo `volumedetect` trên file xuất: −33,10 / −39,20 / −47,10 / −27,10 dB so với kỳ vọng −33,10 / −39,12 / −47,08 / −27,08; 0% → −91 dB (im lặng) |
| Âm lượng lồng tiếng 100% / 70% / 0% | **PASS** | −20,2 dB (chuẩn −20) / −23,3 (kỳ vọng −23,1) / im lặng |
| Auto-Ducking | **PASS** | Gốc 50%, hệ số 0,35: trong lời −48,30 (kỳ vọng −48,24), ngoài lời −39,20 (−39,12) |
| Âm gốc stereo và mono | **PASS** | Cả hai giữ đúng mức (đã sửa lỗi −3 dB mono→stereo) |
| Lập lịch & timeline | **PASS** | Không chồng lấn, không mất nội dung; 2.000 đoạn lập lịch trong 3 ms |
| Lồng tiếng thật (video Kuaishou 66 s, tiếng Trung) | **PASS** | 5/5 bước, 15,9 s xử lý; file xuất có hình + tiếng, 48 kHz stereo, không ghi đè video gốc |
| Lồng tiếng qua giao diện, 2 người nói | **PASS** | speaker_2 dùng giọng "Trúc Ly", speaker_1 "Hải Đăng"; âm lượng 50%/80% ghi đúng vào bộ trộn |
| Hủy tác vụ lồng tiếng giữa bước TTS | **PASS** | Trạng thái `cancelled` sau 16,9 s; tiến trình VieNeu của tác vụ bị dừng; không tạo file dở |
| Video dài 38:52 (526 phân đoạn) | **PASS** | Xem mục 3.1 |
| Nhận diện người nói — hội thoại 2 giọng | **PASS** | Hội thoại Nam/Nữ tạo bằng VieNeu → 2 người, gán xen kẽ đúng 4/4 câu (kiểm thử tự động) |
| Nhận diện người nói — 1 người đọc (APEC) | **PASS** | 1 người (trước khi thêm bước gộp cụm: 2–3) |
| Nhận diện người nói — trailer phim có nhạc nền | **Giới hạn** | Tự động chia 14 "người" (dư); khi nhập số người nói = 3 thì gán đúng 3 nhóm và tự gợi ý 3 giọng khác nhau |
| Dịch Offline tiếng Hàn (trailer 1:44) | **PASS** | Trước: lỗi "KO → VI chưa có mô hình"; sau: 28/29 đoạn dịch được, 1 đoạn đánh dấu để nhập tay |
| VieNeu-TTS | **PASS** | SDK `vieneu` 3.8.4 + mô hình v3 Turbo (581 MB) cài thật; 25 giọng; nạp ~1,3–3 s; tổng hợp nhanh ~3,5 lần thời gian thực trên M2 Pro; nghe thử qua giao diện: 5,5 s âm thanh |
| ASR Faster-Whisper Small | **PASS** | 66 s âm thanh trong 8,8 s; chữ giản thể; nhận đúng "经合组织", "拆墙/铸墙", "脚踏实地" (bản base sai) |
| AI Provider — giao thức Gemini & OpenAI | **PASS** | Kiểm thử với máy chủ cục bộ đóng vai API: JSON mode, prompt, ghép theo ID, retry 429, lỗi QUOTA/AUTH/JSON hỏng, hạn mức tháng |
| **Dịch AI với API thật (Gemini/OpenAI)** | **BLOCKED** | Chưa có API Key. Cần bạn nhập key ở tab "🤖 Tích hợp AI" → "Kiểm tra kết nối" → chạy "Phân đoạn & Dịch" với bộ dịch AI |
| Lưu/xóa API Key trên giao diện | **PASS** | Key không xuất hiện trong DOM/API; `ai_secrets.json` quyền 0600 |
| Quét Bilibili (影视飓风, UID 946974), không Cookie | **PASS có điều kiện** | 2 lần lấy được 20 video tải lên thật (mã BV); các lần khác Bilibili từ chối (mã 352/412 — kiểm soát rủi ro) và ứng dụng báo rõ cần Cookie đăng nhập, không treo |
| Quét Bilibili — tiêu đề/thời lượng chi tiết | **Chưa xác minh** | Code chạy nhưng mọi lượt thử đều trúng lúc Bilibili đang giới hạn tốc độ (HTTP 412); ứng dụng dừng gửi thêm và hiển thị mã BV thay tiêu đề |
| **Quét Bilibili có Cookie đăng nhập** | **BLOCKED** | Cần Cookie (SESSDATA) từ tài khoản của bạn |
| Quét nhiều tài khoản | **PASS** | 2 tài khoản: Bilibili hoàn tất 20 video, Youku "chưa hỗ trợ" kèm lý do; 19 s |
| Quét Douyin — hồ sơ không tồn tại | **PASS** | Trả "Quét thất bại" kèm lý do trong 8 s, không treo |
| **Quét Douyin/Kuaishou/XHS hồ sơ thật** | **BLOCKED** | Không có URL hồ sơ thật + Cookie đăng nhập để kiểm thử; logic WebKitSniffer giữ nguyên, chỉ thêm log và trạng thái lỗi |
| Bảo mật API cục bộ | **PASS** | Origin lạ → 403; Host lạ (DNS rebinding) → 403; `/etc/passwd` → 404; cùng origin → 200 |
| Giao diện | **PASS** | Tab AI, khung âm lượng, cột người nói hoạt động; khổ 700 px không tràn ngang |
| Hồi quy chức năng cũ | **PASS** | 39/39 kiểm thử cũ |
| Windows | **Chưa kiểm thử** | Không có máy Windows; mục cài VieNeu dùng đường dẫn `uv.exe` chưa chạy thử |

### 3.1. Hiệu năng video dài
Video Douyin 38:52, 1080p, tiếng Trung; Faster-Whisper Small + dịch Offline + VieNeu "Hải Đăng"; máy M2 Pro:

| Chỉ số | Kết quả |
|---|---|
| Tổng thời gian | **746,5 s** (≈ 0,32 × thời lượng video) |
| Tách âm + ASR + dịch | 354 s · 526 phân đoạn |
| Tạo giọng VieNeu (526 đoạn) | 336 s |
| Trộn âm + ghép video + xác minh | 52 s |
| RAM đỉnh | Node 184 MB · Python (ASR) 1,65 GB |
| Đồng bộ | 77 đoạn tăng tốc (tối đa 1,30x), 15 đoạn lùi (tối đa 0,50 s), **0 đoạn chồng lấn**, không cắt câu |
| File xuất | 38:52 (bằng bản gốc), H.264 giữ nguyên, AAC 48 kHz stereo |

Không có rò rỉ: worker VieNeu dừng sau 10 phút rảnh hoặc khi hủy; file tạm được xóa sau mỗi tác vụ.

---

## 4. Vấn đề còn tồn tại

1. **Cần API Key** Gemini hoặc OpenAI để dùng dịch AI — chưa kiểm thử với API thật.
2. **Nhận diện người nói** hoạt động tốt với hội thoại/giọng đọc rõ, nhưng video có nhạc nền dày, nhiều câu rất ngắn (trailer) bị chia dư người nói → nhập "Số người nói" cố định hoặc sửa cột người nói trong bảng kịch bản.
3. **Bilibili** có kiểm soát truy cập (mã 352/412): không đăng nhập thì có lúc bị từ chối. Ứng dụng không né cơ chế này — cần Cookie đăng nhập của chính bạn (có `SESSDATA`) hoặc chờ vài phút.
4. **Douyin / Kuaishou / Xiaohongshu**: phụ thuộc WebKitSniffer + Cookie; có thể gặp CAPTCHA (ứng dụng không vượt CAPTCHA).
5. Dịch **Offline (Argos)** vẫn chỉ ở mức cơ bản (dịch qua tiếng Anh); nên dùng AI cho chất lượng tốt.
6. Câu dịch quá dài so với câu gốc vẫn có thể lệch vài trăm ms (được bù dần ở khoảng lặng sau; lượng lệch được ghi trong metadata và cảnh báo trên giao diện).
7. Server đang chạy ở cổng 3889 trên máy là **bản cũ** — cần tắt ứng dụng và mở lại để dùng bản mới.

---

## 5. Hướng dẫn

### Cài đặt
1. `npm install` (Node 20+). FFmpeg, yt-dlp, mô hình Local đã có trong `bin/`.
2. Mở app: nhấp đúp `CNVideoScraperPro.app` hoặc `npm start`.
3. Tab **🛡️ Ma trận Khả năng & OS → 🧰 Quản lý & cài công cụ / mô hình AI** (hoặc nút ⚠️ trong khung giọng chưa cài) để cài phần còn thiếu: *VieNeu-TTS* (~1,3 GB gồm Python 3.12, SDK và mô hình) và *Faster-Whisper Small* (464 MB). Máy này đã cài sẵn cả hai.

### Cấu hình AI
1. Tab **🤖 Tích hợp AI** → dán API Key (Gemini: aistudio.google.com/app/apikey · OpenAI: platform.openai.com/api-keys) → **Lưu** → **Kiểm tra kết nối** (tải danh sách model thật).
2. Chọn model mặc định (gợi ý từ danh sách vừa tải).
3. Mục "Chọn AI cho từng chức năng" → chọn nhà cung cấp + model cho **Dịch lời thoại video** → Lưu.
4. (Tùy chọn) đặt hạn mức request/token mỗi tháng để kiểm soát chi phí.
5. Có thể dùng biến môi trường thay cho nhập key (xem `.env.example`).

### Dịch & lồng tiếng
1. Tab **🎙️ Lồng tiếng Video** → tích "Cho phép gửi văn bản lên dịch vụ đám mây" nếu dùng AI/Google.
2. Bộ máy dịch: **AI Text theo cấu hình** (hoặc Gemini/OpenAI trực tiếp).
3. Chọn video → **Phân đoạn & Dịch (ASR)** → kiểm tra/sửa lời dịch, gán người nói (`speaker_1`, `speaker_2`...) → chọn giọng cho từng người nói.
4. Chọn giọng (mặc định VieNeu "Hải Đăng") → **Nghe thử giọng**.
5. Chỉnh âm lượng gốc / lồng tiếng (0–200%), Auto-Ducking, tốc độ đọc tối đa → **Bắt đầu Lồng tiếng**.
6. File xuất: `<thư mục nền tảng>/Dubbed/…_Dubbed_VI_xxxxx.mp4` + `.srt` + `.dubbing.metadata.json` (có thông số trộn, lập lịch, cảnh báo).

### Kiểm thử, build & phát hành
- `npm test` — chạy toàn bộ kiểm thử (không tải video thật, không ghi đè cấu hình).
- Bản phát hành macOS dùng `CNVideoScraperPro.app` + thư mục dự án (Node chạy `src/launcher.js`). Khi đóng gói gửi máy khác, **không kèm** `config/ai_secrets.json`, `config/ai_usage.json` (đã có trong `.gitignore`); `.venv-vieneu`, `bin/tools`, `bin/models/vieneu-hf` có thể tái tạo qua mục cài công cụ.
- Danh sách dịch vụ ngoài: Google Gemini API, OpenAI API (hoặc API tương thích) — chỉ khi người dùng cho phép; Google Translate (miễn phí, khi cho phép Cloud); Edge TTS (giọng Cloud, khi cho phép); PyPI/HuggingFace/GitHub chỉ khi bấm cài công cụ.

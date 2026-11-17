# CN Video Scraper Pro

Ứng dụng desktop (Node.js + giao diện web) để tải video từ 12 nền tảng video Trung Quốc, quét danh sách video của một tài khoản và lồng tiếng Việt cho video. Phần nhận dạng giọng nói, đọc phụ đề, tách giọng và giọng đọc chạy trên máy. Phần dịch dùng AI API (ChatGPT, Gemini…) hoặc Qwen chạy trên máy.

Chạy trên macOS và Windows 10/11 x64 (Qwen trên Mac cần chip Apple Silicon).

## Tính năng chính

- Tải video lẻ, dán nhiều link cùng lúc, quét video của một tài khoản rồi tải hàng loạt.
- Lồng tiếng: lấy lời thoại (đọc phụ đề in sẵn hoặc nghe giọng nói) → dịch → đọc bằng giọng tiếng Việt → ghép lại với nhạc nền gốc.
- Bước nào lỗi thì chạy tiếp từ bước đó, không phải làm lại từ đầu. Có nhật ký cho từng tác vụ.
- Cài thành phần theo lựa chọn: lúc cài, mỗi model/môi trường đều hỏi trước, kèm tác dụng, dung lượng và khuyến nghị. Trong app cài thêm hoặc xóa được bất cứ lúc nào.

## Nền tảng hỗ trợ

| Nền tảng | Tải video lẻ | Quét tài khoản | Ghi chú |
|---|---|---|---|
| Douyin (抖音) | Có | Có điều kiện, cần cookie khi gặp captcha | macOS dùng `WebKitSniffer`, Windows dùng Edge/Chrome chạy ẩn |
| Kuaishou (快手) | Có | Có điều kiện | Chuyển sang trang H5 (`c.kuaishou.com`) |
| Bilibili | Có | Có | `bilibili.com` và `bilibili.tv`; quét qua yt-dlp, có thể thêm cookie. Gửi nhiều request liên tục sẽ bị chặn tạm (HTTP 412) |
| Xiaohongshu (小红书) | Có | Có điều kiện | Link cần có `xsec_token` (lấy từ nút Chia sẻ) |
| Pipixia (皮皮虾) | Có | Không | Trang hồ sơ không có trên web |
| Xigua Video (西瓜视频) | Có | Không | Trang kênh cần chữ ký `__ac_signature` và đăng nhập |
| Jianying / CapCut | Có (link mẫu) | Không | |
| Youku, Tencent Video, iQIYI, MangoTV, WeTV | Tập miễn phí | Không | Nội dung VIP/DRM không tải được; một số trang chặn IP ngoài Trung Quốc |

App không vượt captcha và không phá DRM. Gặp captcha thì mở trang trong trình duyệt, tự xác minh rồi dán cookie vào app.

## Cài đặt

Repo chỉ chứa mã nguồn. Môi trường Python, model AI, ffmpeg, yt-dlp được tải từ nguồn chính thức ở lần chạy đầu, có kiểm tra SHA-256.

Cần có [Node.js 20+](https://nodejs.org) và Internet ở lần cài đầu. Dung lượng tùy thành phần chọn cài: phần cơ bản khoảng 1 GB, thêm Qwen thì cộng 5,8 GB.

### Windows

1. Tải mã nguồn (*Code → Download ZIP*) và giải nén, nên để ở đường dẫn ngắn, ví dụ `C:\CNVideo`.
2. Chạy `Start_App_Windows.bat`. Lần đầu script chạy `npm install` rồi `scripts/setup.js`. Script hỏi từng thành phần; nhấn Enter là cài theo khuyến nghị. Không cần quyền Administrator.
3. Các lần sau mở `Start_App_Windows.bat` hoặc lối tắt "CN Video Scraper Pro" trên Desktop. App mở trong cửa sổ Edge dạng ứng dụng; giữ cửa sổ dòng lệnh mở trong lúc dùng. Cửa sổ không hiện thì mở `http://127.0.0.1:3889` trong trình duyệt.

Qwen trên Windows được cài vào `%USERPROFILE%\QwenLocal` để ứng dụng khác dùng chung. File `qwen-local.json` trong thư mục đó ghi đường dẫn model, bộ chạy và tham số; `Start_Qwen_Server.bat` mở API chuẩn OpenAI tại `http://127.0.0.1:8765/v1`. Nếu ổ C ít chỗ và app nằm ở ổ khác, setup sẽ hỏi cài vào ổ C hay vào thư mục app (`--qwen-dir=user|app` để chọn trước). Thư mục app có lối tắt `Qwen Local` trỏ tới chỗ cài.

### macOS

```bash
npm install --omit=dev
npm run setup
npm start
```

Hoặc mở `CNVideoScraperPro.app`.

### Lệnh cài đặt

| Lệnh | Tác dụng |
|---|---|
| `npm run setup:check` | Liệt kê thành phần còn thiếu, không tải gì |
| `npm run setup` | Hỏi và cài các thành phần còn thiếu (bỏ qua cái đã có hoặc đã chọn không cài) |
| `node scripts/setup.js --ask-again` | Hỏi lại cả các thành phần trước đây đã từ chối |
| `node scripts/setup.js --yes` | Không hỏi, cài theo khuyến nghị cho máy này |
| `node scripts/setup.js --all` | Không hỏi, cài tất cả (dùng cho CI) |
| `--no-llm` / `--full` | Bỏ qua / chọn sẵn Qwen |

## Thành phần

| Thành phần | Dung lượng | Dùng để | Ghi chú |
|---|---|---|---|
| yt-dlp | 36 MB | Tải video | Bắt buộc |
| FFmpeg | 43 MB | Tách/ghép âm thanh, xuất video | Bắt buộc, đi kèm qua npm `ffmpeg-static` |
| WebKitSniffer | < 1 MB | Lấy link Douyin/Kuaishou/Xiaohongshu trên macOS | Cần Xcode Command Line Tools |
| Môi trường Python | 370 MB | Chạy các model bên dưới | Python 3.12 riêng trong `.venv` |
| SenseVoiceSmall + Silero VAD | 238 MB | Nghe lời thoại | Phổ thông, Quảng Đông, Anh, Nhật, Hàn |
| PaddleOCR PP-OCRv4 (ONNX) | 23 MB | Đọc phụ đề chữ Trung / tiếng Anh in trong hình | |
| VieNeu-TTS v3 Turbo | 1,2 GB | Giọng đọc tiếng Việt 48 kHz, 25 giọng | Mặc định giọng Ngọc Huyền |
| Piper VITS | 36–100 MB | Giọng đọc nhẹ, dự phòng khi không có VieNeu | |
| Spleeter 2 stems | 38 MB | Tách lời nói gốc khỏi nhạc nền | |
| Pyannote 3.0 + 3D-Speaker | 45 MB | Phân biệt nhiều người nói | Mặc định tắt |
| Qwen3.5 9B | 5,6–5,8 GB | Dịch trên máy, không cần API key | macOS: MLX 4-bit; Windows: llama.cpp + GGUF Q4_K_M (Vulkan, tự chạy CPU nếu không có GPU) |
| Faster-Whisper small | 464 MB | Nhận dạng giọng nói (bản cũ) | Không còn cài mặc định |

Có API key ChatGPT/Gemini thì không cần cài Qwen. Trong app, mục 🧰 Công cụ hiện số thành phần đã cài, nút cài thêm và nút xóa. Xóa yt-dlp/FFmpeg vẫn được nhưng app hiện cảnh báo và bắt xác nhận hai lần.

## Lồng tiếng

Tab "Lồng tiếng Video": chọn video (đã tải hoặc file bất kỳ), bấm "Phân đoạn & Dịch", sửa lại lời dịch nếu cần, rồi bấm lồng tiếng. Chọn video chỉ đưa video vào làm nguồn, chưa chạy gì.

**Lấy lời thoại.** Có ba nguồn:

- *Đọc phụ đề in trong hình (OCR).* Chỉ đọc vùng phụ đề, chỉ nhận dòng ở gần giữa, đúng độ cao phụ đề và đủ độ tin cậy. Logo, watermark, biển hiệu, chữ lệch sang cạnh bị bỏ. Đọc được phụ đề chữ Trung hoặc tiếng Anh; video song ngữ thì chọn dòng muốn lấy.
- *Nghe giọng nói (SenseVoiceSmall).* Chế độ Tự động nhận giọng từng đoạn nói, nên video có giọng Quảng Đông, tiếng địa phương hoặc trộn nhiều giọng vẫn nhận được. Khi phát hiện giọng Quảng Đông (dựa vào chữ như 咗, 哋, 唔, 嘅), app báo cho bộ dịch biết.
- *Tự động.* Thử phụ đề chữ Trung trước, rồi phụ đề tiếng Anh, không có phụ đề thì nghe.

Tab "Tinh chỉnh OCR" cho chỉnh vùng đọc, độ lệch khỏi giữa, độ tin cậy, số khung/giây. Có thể xem thử một khung hình: app đánh dấu dòng nào được nhận, dòng nào bị bỏ và lý do.

Số đo trên một video tiếng Tứ Xuyên có nhạc nền dài 9 phút (134 câu, bản chuẩn đọc tay từ ảnh phụ đề):

| Cách lấy lời thoại | Ký tự đúng | Thời gian |
|---|---|---|
| OCR phụ đề chữ Trung | 96,4% | ~2,5 phút |
| SenseVoiceSmall (tự nhận giọng) | 85,0% | ~8 giây |
| Whisper small (bản cũ) | 60,0% | ~39 giây |

Phụ đề tiếng Anh trên cùng video đạt 93,4% chữ cái đúng. Lỗi chủ yếu là nhầm e/c với font có chân; bộ dịch được báo nguồn là OCR nên vẫn hiểu đúng ý.

**Dịch.** AI API (ChatGPT, Gemini, API tương thích OpenAI) nhận cả kịch bản trong một request, để giữ mạch truyện và xưng hô nhất quán. Chỉ video trên 400 câu mới chia thành vài phần. Qwen trên máy dịch theo lô 35 câu, vì model nhỏ dễ trả JSON hỏng khi đầu vào dài. AI API lỗi hoặc quá tải thì tự chuyển sang Qwen. AI chỉ trả `id` + `translated_text`; mốc thời gian luôn lấy từ dữ liệu gốc. Văn phong chọn được: tự nhiên, hài hước, nghiêm túc, cổ trang, trẻ trung, review, kể chuyện. Câu nào AI vẫn dịch lỗi (còn sót chữ Hán…) thì để trống kèm cảnh báo; lúc lồng tiếng app tự dịch lại câu đó, không được thì bỏ qua, không dừng cả video.

**Giọng đọc và ghép.** Câu dịch dài hơn câu gốc thì dùng khoảng lặng phía sau trước, sau đó mới tăng tốc (tối đa 1,3x), không cắt câu và không chồng lên câu sau. Âm lượng tiếng gốc và giọng lồng chỉnh riêng (0–200%), có auto-ducking. Video xuất ra nằm trong `<thư mục nền tảng>/Dubbed/`, không ghi đè video gốc.

API key lưu ở `config/ai_secrets.json` (quyền 0600) và không bao giờ trả về giao diện. Nội dung chỉ được gửi lên dịch vụ đám mây khi người dùng bật cho phép.

## Kiểm thử

```bash
npm test               # tests/verify_all.js + tests/verify_upgrade.js
npm run test:upgrade   # chỉ bộ mới
```

Bộ kiểm thử dùng thư mục cấu hình tạm nên không đụng tới cấu hình và lịch sử của người dùng. Âm lượng được đo trực tiếp trên file xuất bằng FFmpeg. OCR được thử trên video dựng bằng `drawtext`, có cả chữ nhiễu (logo, biển hiệu). Dịch AI được thử với một máy chủ giả lập giao thức Gemini/OpenAI; thử với API thật cần key riêng. Những bài cần điều kiện chưa có (model chưa cài, nền tảng đòi captcha) được báo là SKIP/BLOCKED chứ không tính là PASS. CI chạy cả hai bộ trên Windows và macOS (`.github/workflows/ci.yml`).

## Lịch sử thay đổi

**1.3.0**
- Nghe giọng nói bằng SenseVoiceSmall thay Whisper small: chính xác hơn, nhanh hơn, nhận được giọng Quảng Đông và tiếng địa phương. Thêm lựa chọn ngôn ngữ đầu vào: Tự động / Phổ thông / Quảng Đông / Tiếng Anh.
- Đọc phụ đề in trong hình (OCR) cho chữ Trung và tiếng Anh; thêm tab Tinh chỉnh OCR.
- Dịch bằng AI API gửi cả kịch bản trong một lần; viết lại prompt; thêm văn phong; lỗi ở một câu không còn làm hỏng cả tác vụ.
- Thêm nút xóa công cụ/model, ảnh thu nhỏ trong danh sách đã tải.
- Cài thành phần theo lựa chọn; Qwen trên Windows cài vào thư mục dùng chung `%USERPROFILE%\QwenLocal`.

**1.2.0**
- Qwen3.5 9B dịch trên máy (MLX trên Mac, llama.cpp trên Windows).
- AI Gateway: tự chuyển model/nhà cung cấp khi lỗi hoặc quá tải, hàng đợi, hạn mức, lưu đệm bản dịch.
- Sửa lệch đồng bộ (≤ 50 ms), tách giọng gốc giữ nhạc nền, thanh tải bị treo, nghe thử không phát trong app macOS.

**1.1.0**
- Tab Tích hợp AI (Gemini, OpenAI, API tương thích OpenAI), dịch theo phân đoạn có kiểm tra ID/thứ tự.
- Giọng đọc VieNeu-TTS, phân biệt nhiều người nói, chỉnh âm lượng chính xác.
- Quét Bilibili đúng danh sách video tải lên; quét nhiều tài khoản; chặn website lạ gọi API cục bộ.

# -*- coding: utf-8 -*-
"""
Đọc PHỤ ĐỀ CỨNG (chữ in trong hình) của video bằng OCR — thay cho nhận dạng giọng nói khi video đã có phụ đề
(tiếng địa phương, nhạc nền to... làm Whisper nghe sai nhưng phụ đề thì đúng).

Chỉ dùng onnxruntime + numpy (đã có trong môi trường Python của app) và FFmpeg — KHÔNG cần OpenCV.
Mô hình: PP-OCRv4 (PaddleOCR) bản ONNX lấy từ gói RapidOCR chính thức: tìm chữ (det) + đọc chữ (rec, ~6.600 ký tự).

Chống chữ "vô tình" trong hình (biển hiệu, logo, tiêu đề, watermark):
  - chỉ đọc dải dưới khung hình (nơi đặt phụ đề);
  - chỉ giữ dòng có chữ Trung, nằm ngang, gần giữa, đúng độ cao mà phụ đề xuất hiện nhiều nhất;
  - bỏ dòng đứng yên quá lâu (> 35% thời lượng video: logo/watermark) và dòng chỉ nháy qua (< 0,4 s).
"""
import json
import os
import re
import subprocess
import sys

import numpy as np

CJK_RE = re.compile(r"[一-鿿]")
LATIN_WORD_RE = re.compile(r"[A-Za-z]{2,}")
EN_REC_FILE = "en_PP-OCRv4_rec_mobile.onnx"
# Ngôn ngữ phụ đề cần đọc: "zh" (chữ Trung, mặc định) hoặc "en" (phụ đề tiếng Anh — model đọc tiếng Anh riêng, giữ dấu cách)
SUB_LANG = {"value": "zh"}


def set_sub_lang(lang):
    SUB_LANG["value"] = "en" if str(lang or "").lower().startswith("en") else "zh"
    return SUB_LANG["value"]


def is_target_text(text):
    """Dòng chữ có phải ngôn ngữ phụ đề đang đọc không."""
    if SUB_LANG["value"] == "en":
        return bool(LATIN_WORD_RE.search(text)) and not CJK_RE.search(text)
    return bool(CJK_RE.search(text))


def target_char_count(text):
    if SUB_LANG["value"] == "en":
        return len(re.findall(r"[A-Za-z]", text))
    return len(CJK_RE.findall(text))


def join_lines(parts):
    return (" " if SUB_LANG["value"] == "en" else "").join(parts).strip()
WORK_WIDTH = 960     # chiều rộng xử lý

# Tham số người dùng chỉnh được trong app (⚙️ Tinh chỉnh OCR) — giá trị mặc định đã kiểm nghiệm trên video thật
DEFAULT_PARAMS = {
    "band_top": 0.50,         # vùng đọc phụ đề: từ ... (tỉ lệ chiều cao khung hình, 0 = mép trên)
    "band_bottom": 0.97,      # ... đến
    "center_tol": 0.28,       # dòng chữ phải nằm gần giữa: lệch tối đa 28% chiều rộng (bỏ biển hiệu, chữ ở cạnh)
    "min_conf": 0.75,         # độ tin cậy tối thiểu để nhận là phụ đề (dòng đúng vị trí phụ đề được nới thêm 0,15)
    "fps": 4.0,               # số khung đọc mỗi giây (nhiều hơn = mốc thời gian chính xác hơn nhưng chậm hơn)
    "min_duration": 0.4,      # bỏ dòng chỉ hiện thoáng qua dưới ... giây
    "static_max_ratio": 0.35, # bỏ chữ đứng yên quá ...% thời lượng video (logo, watermark, tiêu đề cố định)
}
PARAM_LIMITS = {
    "band_top": (0.0, 0.95), "band_bottom": (0.05, 1.0), "center_tol": (0.05, 0.5), "min_conf": (0.5, 0.95),
    "fps": (1.0, 10.0), "min_duration": (0.1, 2.0), "static_max_ratio": (0.1, 1.0),
}
PARAMS = dict(DEFAULT_PARAMS)


def set_params(d):
    """Áp dụng tham số (bỏ qua khóa lạ, kẹp vào khoảng hợp lệ). Trả về bộ tham số đang dùng."""
    PARAMS.clear()
    PARAMS.update(DEFAULT_PARAMS)
    for k, v in (d or {}).items():
        if k in PARAM_LIMITS:
            try:
                lo, hi = PARAM_LIMITS[k]
                PARAMS[k] = min(hi, max(lo, float(v)))
            except (TypeError, ValueError):
                pass
    if PARAMS["band_bottom"] - PARAMS["band_top"] < 0.05:
        PARAMS["band_top"], PARAMS["band_bottom"] = DEFAULT_PARAMS["band_top"], DEFAULT_PARAMS["band_bottom"]
    return dict(PARAMS)
REC_H = 48


class SubtitleOCR:
    def __init__(self, models_dir, lang="zh"):
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.log_severity_level = 3
        self.det = ort.InferenceSession(os.path.join(models_dir, "ch_PP-OCRv4_det_infer.onnx"), so, providers=["CPUExecutionProvider"])
        self.rec, self.charset = self._load_rec(ort, so, os.path.join(models_dir, "ch_PP-OCRv4_rec_infer.onnx"))
        self.rec_en = None
        if str(lang).startswith("en"):
            en_path = os.path.join(models_dir, EN_REC_FILE)
            if not os.path.exists(en_path):
                raise RuntimeError("Chưa có model đọc phụ đề tiếng Anh — vào 🧰 Công cụ, cài lại \"Đọc phụ đề trong hình (OCR)\".")
            self.rec_en, self.charset_en = self._load_rec(ort, so, en_path)

    @staticmethod
    def _load_rec(ort, so, path):
        sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
        chars = [c for c in sess.get_modelmeta().custom_metadata_map.get("character", "").split("\n") if c != ""]
        charset = ["<blank>"] + chars
        n_cls = sess.get_outputs()[0].shape[-1]
        while isinstance(n_cls, int) and len(charset) < n_cls:
            charset.append(" ")  # PaddleOCR use_space_char: lớp cuối là dấu cách
        return sess, charset

    # ---------- tìm dòng chữ ----------
    def detect_lines(self, img):
        """img: HxWx3 uint8 BGR → danh sách hộp (x0, y0, x1, y1, score) của từng dòng chữ nằm ngang."""
        h, w = img.shape[:2]
        ph, pw = (h + 31) // 32 * 32, (w + 31) // 32 * 32
        pad = np.zeros((ph, pw, 3), np.float32)
        pad[:h, :w] = img.astype(np.float32)
        x = ((pad / 255.0) - 0.5) / 0.5
        prob = self.det.run(None, {"x": x.transpose(2, 0, 1)[None]})[0][0, 0, :h, :w]
        mask = prob > 0.3
        weak = prob > 0.1
        rows = mask.sum(axis=1) > 2
        boxes = []
        r = 0
        while r < h:
            if not rows[r]:
                r += 1
                continue
            r0 = r
            while r < h and rows[r]:
                r += 1
            r1 = r
            lh = r1 - r0
            if lh < 3:
                continue
            cols = mask[r0:r1].any(axis=0)
            idx = np.where(cols)[0]
            if idx.size == 0:
                continue
            # tách các cụm chữ cách xa nhau trên cùng hàng
            gap = max(12, int(lh * 2.5))
            start = idx[0]
            prev = idx[0]
            for c in list(idx[1:]) + [None]:
                if c is None or c - prev > gap:
                    c0, c1 = start, prev + 1
                    if lh >= 8:
                        # dòng bình thường (như trước)
                        if c1 - c0 >= lh * 1.2:
                            score = float(prob[r0:r1, c0:c1].mean())
                            if score >= 0.3:
                                pad_y = int(lh * 0.35)
                                pad_x = int(lh * 0.5)
                                boxes.append((max(0, c0 - pad_x), max(0, r0 - pad_y), min(w, c1 + pad_x), min(h, r1 + pad_y), score))
                    else:
                        # Chữ nét mảnh/nhạt: vùng lõi của bộ tìm chữ (DB) chỉ cao vài px → nới theo ngưỡng thấp
                        # để lấy đủ chiều cao chữ (giới hạn để không dính sang dòng bên cạnh)
                        g0, g1 = r0, r1
                        while g0 > 0 and r0 - g0 < 8 and int(weak[g0 - 1, c0:c1].sum()) > 2:
                            g0 -= 1
                        while g1 < h and g1 - r1 < 8 and int(weak[g1, c0:c1].sum()) > 2:
                            g1 += 1
                        th = max(g1 - g0, lh * 2)
                        cy = (g0 + g1) // 2
                        g0, g1 = cy - th // 2, cy + (th + 1) // 2
                        # dòng 1 chữ (嗯, 嘿, 哼…) gần vuông → chỉ cần rộng ≥ 0,5 lần chiều cao
                        if th >= 8 and c1 - c0 >= th * 0.5:
                            score = float(prob[r0:r1, c0:c1].mean())
                            if score >= 0.3:
                                pad_y = int(th * 0.3) + 1
                                pad_x = int(th * 0.5)
                                boxes.append((max(0, c0 - pad_x), max(0, g0 - pad_y), min(w, c1 + pad_x), min(h, g1 + pad_y), score))
                    if c is not None:
                        start = c
                if c is not None:
                    prev = c
        return boxes

    # ---------- đọc chữ ----------
    @staticmethod
    def _resize_h(crop, out_h):
        h, w = crop.shape[:2]
        new_w = max(8, min(1600, int(round(w * out_h / float(h)))))
        ys = (np.arange(out_h) + 0.5) * h / out_h - 0.5
        xs = (np.arange(new_w) + 0.5) * w / new_w - 0.5
        y0 = np.clip(np.floor(ys).astype(int), 0, h - 1)
        x0 = np.clip(np.floor(xs).astype(int), 0, w - 1)
        y1 = np.clip(y0 + 1, 0, h - 1)
        x1 = np.clip(x0 + 1, 0, w - 1)
        wy = np.clip(ys - y0, 0, 1)[:, None, None]
        wx = np.clip(xs - x0, 0, 1)[None, :, None]
        c = crop.astype(np.float32)
        top = c[y0][:, x0] * (1 - wx) + c[y0][:, x1] * wx
        bot = c[y1][:, x0] * (1 - wx) + c[y1][:, x1] * wx
        return top * (1 - wy) + bot * wy

    def recognize_line(self, img, box):
        """Đọc 1 dòng: luôn đọc bằng model chữ Trung trước; chế độ tiếng Anh thì dòng không có chữ Trung được đọc lại
        bằng model tiếng Anh (giữ đúng dấu cách giữa các từ)."""
        text, conf = self.recognize(img, box)
        if self.rec_en is not None and text and not CJK_RE.search(text):
            t2, c2 = self.recognize(img, box, self.rec_en, self.charset_en)
            if t2:
                return re.sub(r"\s+", " ", t2).strip(), c2
        return text, conf

    def recognize(self, img, box, sess=None, charset=None):
        sess = sess or self.rec
        charset = charset or self.charset
        x0, y0, x1, y1, _ = box
        crop = img[y0:y1, x0:x1]
        if crop.size == 0:
            return "", 0.0
        r = self._resize_h(crop, REC_H)
        x = ((r / 255.0) - 0.5) / 0.5
        out = sess.run(None, {"x": x.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
        ids = out.argmax(axis=1)
        probs = out.max(axis=1)
        text, confs, last = [], [], -1
        for i, p in zip(ids, probs):
            if i != last and i != 0 and i < len(charset):
                text.append(charset[i])
                confs.append(float(p))
            last = i
        return "".join(text).strip(), (float(np.mean(confs)) if confs else 0.0)


def video_info(ffmpeg, video):
    r = subprocess.run([ffmpeg, "-hide_banner", "-i", video], capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr)
    dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0
    m2 = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", r.stderr)
    w, h = (int(m2.group(1)), int(m2.group(2))) if m2 else (0, 0)
    rot = re.search(r"rotate\s*:\s*(-?\d+)|displaymatrix: rotation of (-?[\d.]+)", r.stderr)
    if rot:
        ang = abs(int(float(rot.group(1) or rot.group(2)))) % 180
        if ang == 90:
            w, h = h, w
    return dur, w, h


def iter_band_frames(ffmpeg, video, w, h, fps, seek_list=None):
    """Sinh (thời điểm, khung BGR của dải phụ đề) — đọc thẳng từ FFmpeg, không cần OpenCV."""
    y0 = int(h * PARAMS["band_top"]) // 2 * 2
    bh = max(32, (int(h * PARAMS["band_bottom"]) - y0) // 2 * 2)
    out_w = WORK_WIDTH if w >= WORK_WIDTH else (w // 2 * 2)
    out_h = max(32, int(round(bh * out_w / float(w))) // 2 * 2)
    vf = "crop={}:{}:0:{},scale={}:{}".format(w, bh, y0, out_w, out_h)
    frame_bytes = out_w * out_h * 3
    if seek_list is not None:
        for t in seek_list:
            r = subprocess.run(
                [ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", "%.3f" % t, "-i", video, "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                capture_output=True,
            )
            if len(r.stdout) >= frame_bytes:
                yield t, np.frombuffer(r.stdout[:frame_bytes], np.uint8).reshape(out_h, out_w, 3)
        return
    p = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", video, "-vf", "fps={},{}".format(fps, vf), "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE,
    )
    i = 0
    try:
        while True:
            buf = p.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            yield i / float(fps), np.frombuffer(buf, np.uint8).reshape(out_h, out_w, 3)
            i += 1
    finally:
        try:
            p.kill()
        except Exception:
            pass


def read_frame_lines(ocr, img, cache):
    """Các dòng chữ của 1 khung: [(text, conf, y_center, x_center, height)]. Khung gần như không đổi → dùng lại kết quả trước."""
    small = img[::8, ::8].mean(axis=2)
    if cache.get("small") is not None and cache["small"].shape == small.shape and float(np.abs(small - cache["small"]).mean()) < 1.5:
        return cache["lines"]
    lines = []
    for b in ocr.detect_lines(img):
        text, conf = ocr.recognize_line(img, b)
        if text:
            lines.append((text, conf, (b[1] + b[3]) / 2.0, (b[0] + b[2]) / 2.0, b[3] - b[1]))
    cache["small"], cache["lines"] = small, lines
    return lines


def _core(t):
    return "".join(ch for ch in t if CJK_RE.match(ch) or ch.isalnum())


def _is_subseq(a, b):
    it = iter(b)
    return all(ch in it for ch in a)


def _similar(a, b):
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    # tỉ lệ ký tự chung theo thứ tự (LCS) — chịu được lỗi OCR 1-2 ký tự
    n, m = len(a), len(b)
    dp = [0] * (m + 1)
    for i in range(1, n + 1):
        prev = 0
        for j in range(1, m + 1):
            tmp = dp[j]
            dp[j] = prev + 1 if a[i - 1] == b[j - 1] else max(dp[j], dp[j - 1])
            prev = tmp
    return 2.0 * dp[m] / (n + m)


def pick_subtitle_lines(frames, width):
    """Từ các dòng chữ từng khung, chỉ giữ dòng PHỤ ĐỀ: chữ Trung, gần giữa, đúng độ cao phụ đề phổ biến nhất."""
    cands = []
    for t, lines in frames:
        for (text, conf, yc, xc, lh) in lines:
            if conf >= PARAMS["min_conf"] and is_target_text(text) and abs(xc - width / 2.0) <= width * PARAMS["center_tol"]:
                cands.append(yc)
    if not cands:
        return None, []
    hist, edges = np.histogram(cands, bins=max(4, int((max(cands) - min(cands)) / 12) + 1))
    k = int(hist.argmax())
    mode_y = (edges[k] + edges[k + 1]) / 2.0
    per_frame = []
    for t, lines in frames:
        keep = [
            l for l in lines
            # đã đúng vị trí phụ đề (giữa, đúng độ cao) → chấp nhận độ tin cậy thấp hơn một chút (chữ trên nền sáng)
            if l[1] >= PARAMS["min_conf"] - 0.15 and is_target_text(l[0]) and abs(l[3] - width / 2.0) <= width * PARAMS["center_tol"] and abs(l[2] - mode_y) <= max(24, l[4] * 1.6)
        ]
        keep.sort(key=lambda l: l[2])
        text = join_lines([l[0] for l in keep])
        # dòng chỉ 1 chữ (嗯 → 咽) / tiếng Anh ≤ 2 chữ cái dễ đọc nhầm → cần độ tin cậy cao
        n_ch = target_char_count(text)
        if 0 < n_ch <= (2 if SUB_LANG["value"] == "en" else 1) and max([l[1] for l in keep] or [0]) < 0.85:
            keep, text = [], ""
        conf = float(np.mean([l[1] for l in keep])) if keep else 0.0
        per_frame.append((t, text, conf))
    return mode_y, per_frame


def build_events(per_frame, fps, duration):
    events = []
    cur = None
    step = 1.0 / fps
    for t, text, conf in per_frame:
        if text and cur and _similar(cur["variants"][-1][0], text) >= 0.7:
            cur["end"] = t + step
            cur["variants"].append((text, conf))
            continue
        if cur:
            events.append(cur)
            cur = None
        if text:
            cur = {"start": t, "end": t + step, "variants": [(text, conf)]}
    if cur:
        events.append(cur)
    # cùng 1 câu bị ngắt quãng ngắn (1-2 khung không đọc được do bị che/nền sáng) → gộp lại, tránh lồng tiếng lặp câu
    # Phụ đề hiện dần từng phần (三界 → 一窥三界, 老…… → 老……大……我……) → cũng là 1 câu: gộp, lấy bản đầy đủ.
    # Khác với câu ngập ngừng rồi nói cả câu (我……不…… → 我不光自己加…): câu sau dài hơn hẳn → giữ riêng.
    merged = []
    for e in events:
        if merged and e["start"] - merged[-1]["end"] <= 0.6:
            # so với bản đầy đủ nhất của câu trước (không phải khung cuối, có thể chỉ đọc được 1 phần)
            a = max((v[0] for v in merged[-1]["variants"]), key=lambda t: len(_core(t)))
            b = e["variants"][0][0]
            if _similar(a, b) >= 0.7:
                merged[-1]["end"] = e["end"]
                merged[-1]["variants"].extend(e["variants"])
                continue
            ca, cb = _core(a), _core(b)
            prev = merged[-1]
            short, long_, short_dur = (ca, cb, prev["end"] - prev["start"]) if len(ca) <= len(cb) else (cb, ca, e["end"] - e["start"])
            # phần hiện dần chỉ thoáng qua (≤ 0,75 s); câu ngập ngừng ("我真的……") hiện đủ lâu để đọc → giữ riêng
            if short and short_dur <= 0.75 and _is_subseq(short, long_) and len(long_) <= 2 * len(short) + 2:
                merged[-1]["end"] = e["end"]
                merged[-1]["variants"].extend(e["variants"])
                merged[-1]["progressive"] = True
                continue
        merged.append(e)
    events = merged
    out = []
    for e in events:
        # chọn cách đọc xuất hiện nhiều nhất (độ tin cậy cao nhất khi bằng nhau)
        score = {}
        for txt, c in e["variants"]:
            s = score.setdefault(txt, [0, 0.0])
            s[0] += 1
            s[1] = max(s[1], c)
        if e.get("progressive"):
            text = max(score.items(), key=lambda kv: (len(_core(kv[0])), kv[1][0], kv[1][1]))[0]
        else:
            text = max(score.items(), key=lambda kv: (kv[1][0], kv[1][1]))[0]
        out.append({"startSec": round(e["start"], 2), "endSec": round(min(duration or e["end"], e["end"]), 2), "sourceText": text})
    # bỏ dòng nháy qua và dòng đứng yên quá lâu (logo, watermark, tiêu đề cố định)
    total = {}
    for e in out:
        total[e["sourceText"]] = total.get(e["sourceText"], 0.0) + (e["endSec"] - e["startSec"])
    res = []
    for e in out:
        d = e["endSec"] - e["startSec"]
        if d < PARAMS["min_duration"]:
            continue
        if duration > 0 and total.get(e["sourceText"], 0) > max(20.0, PARAMS["static_max_ratio"] * duration):
            continue
        res.append(e)
    for i, e in enumerate(res):
        e["index"] = i + 1
        e["id"] = i + 1
    return res


def probe(ocr, ffmpeg, video, samples=24):
    """Kiểm tra nhanh video có phụ đề cứng tiếng Trung không (dùng cho chế độ Tự động)."""
    dur, w, h = video_info(ffmpeg, video)
    if dur <= 0 or w <= 0:
        return {"ok": False, "error": "Không đọc được thông tin video."}
    ts = [dur * (i + 0.5) / samples for i in range(samples)]
    frames = []
    cache = {}
    for t, img in iter_band_frames(ffmpeg, video, w, h, 1, seek_list=ts):
        cache.clear()
        frames.append((t, read_frame_lines(ocr, img, cache)))
    width = WORK_WIDTH if w >= WORK_WIDTH else w
    mode_y, per_frame = pick_subtitle_lines(frames, width)
    with_text = [x for x in per_frame if x[1]]
    distinct = len(set(x[1] for x in with_text))
    ratio = len(with_text) / float(max(1, len(frames)))
    return {"ok": True, "hasSubtitles": ratio >= 0.25 and distinct >= 4, "ratio": round(ratio, 2), "distinct": distinct, "sampled": len(frames), "examples": [x[1] for x in with_text[:5]]}


def extract(ocr, ffmpeg, video, fps=4, on_progress=None):
    dur, w, h = video_info(ffmpeg, video)
    if dur <= 0 or w <= 0:
        return {"ok": False, "error": "Không đọc được thông tin video."}
    frames = []
    cache = {}
    last_pct = -1
    for t, img in iter_band_frames(ffmpeg, video, w, h, fps):
        frames.append((t, read_frame_lines(ocr, img, cache)))
        if on_progress and dur > 0:
            pct = int(t * 100 / dur)
            if pct != last_pct:
                last_pct = pct
                on_progress(t, dur)
    width = WORK_WIDTH if w >= WORK_WIDTH else w
    mode_y, per_frame = pick_subtitle_lines(frames, width)
    if not per_frame:
        return {"ok": False, "errorCode": "NO_SUBTITLES", "error": "Không tìm thấy phụ đề " + ("tiếng Anh" if SUB_LANG["value"] == "en" else "chữ Trung") + " trong hình video."}
    segs = build_events(per_frame, fps, dur)
    if not segs:
        return {"ok": False, "errorCode": "NO_SUBTITLES", "error": "Không tìm thấy phụ đề " + ("tiếng Anh" if SUB_LANG["value"] == "en" else "chữ Trung") + " trong hình video."}
    return {"ok": True, "segments": segs, "totalDuration": round(dur, 2), "framesRead": len(frames), "subtitleY": mode_y}


def analyze_frame(ocr, ffmpeg, video, t):
    """Xem thử 1 khung hình với tham số hiện tại: các dòng chữ tìm thấy trong vùng đọc, dòng nào được nhận là
    phụ đề / bị bỏ và lý do. Tọa độ trả về theo tỉ lệ khung hình gốc (0..1) để giao diện vẽ khung lên ảnh."""
    dur, w, h = video_info(ffmpeg, video)
    if dur <= 0 or w <= 0:
        return {"ok": False, "error": "Không đọc được thông tin video."}
    t = max(0.0, min(float(t), max(0.0, dur - 0.05)))
    got = list(iter_band_frames(ffmpeg, video, w, h, 1, seek_list=[t]))
    if not got:
        return {"ok": False, "error": "Không lấy được khung hình tại thời điểm này."}
    img = got[0][1]
    out_w = img.shape[1]
    k = w / float(out_w)
    y0 = int(h * PARAMS["band_top"]) // 2 * 2
    keep_conf = PARAMS["min_conf"] - 0.15
    lines = []
    for b in ocr.detect_lines(img):
        text, conf = ocr.recognize_line(img, b)
        if not text:
            continue
        x0, by0, x1, by1, _ = b
        xc = (x0 + x1) / 2.0
        reasons = []
        if not is_target_text(text):
            reasons.append("không phải chữ tiếng Anh" if SUB_LANG["value"] == "en" else "không có chữ Trung")
        if conf < keep_conf:
            reasons.append("độ tin cậy thấp (%.2f < %.2f)" % (conf, keep_conf))
        if abs(xc - out_w / 2.0) > out_w * PARAMS["center_tol"]:
            reasons.append("lệch xa giữa khung")
        if 0 < target_char_count(text) <= (2 if SUB_LANG["value"] == "en" else 1) and conf < 0.85:
            reasons.append("dòng quá ngắn cần độ tin cậy ≥ 0,85")
        lines.append({
            "text": text, "conf": round(conf, 2), "keep": not reasons, "reasons": reasons,
            "x0": round(x0 * k / w, 4), "x1": round(x1 * k / w, 4),
            "y0": round((y0 + by0 * k) / h, 4), "y1": round((y0 + by1 * k) / h, 4),
        })
    return {"ok": True, "t": round(t, 2), "duration": round(dur, 2), "width": w, "height": h, "params": dict(PARAMS), "lines": lines}

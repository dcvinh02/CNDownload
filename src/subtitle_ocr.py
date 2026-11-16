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
BAND_TOP = 0.50      # dải phụ đề: từ 50% ...
BAND_BOTTOM = 0.97   # ... đến 97% chiều cao khung hình
WORK_WIDTH = 960     # chiều rộng xử lý
REC_H = 48


class SubtitleOCR:
    def __init__(self, models_dir):
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.log_severity_level = 3
        self.det = ort.InferenceSession(os.path.join(models_dir, "ch_PP-OCRv4_det_infer.onnx"), so, providers=["CPUExecutionProvider"])
        self.rec = ort.InferenceSession(os.path.join(models_dir, "ch_PP-OCRv4_rec_infer.onnx"), so, providers=["CPUExecutionProvider"])
        chars = self.rec.get_modelmeta().custom_metadata_map.get("character", "").split("\n")
        self.charset = ["<blank>"] + chars + [" "]

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

    def recognize(self, img, box):
        x0, y0, x1, y1, _ = box
        crop = img[y0:y1, x0:x1]
        if crop.size == 0:
            return "", 0.0
        r = self._resize_h(crop, REC_H)
        x = ((r / 255.0) - 0.5) / 0.5
        out = self.rec.run(None, {"x": x.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
        ids = out.argmax(axis=1)
        probs = out.max(axis=1)
        text, confs, last = [], [], -1
        for i, p in zip(ids, probs):
            if i != last and i != 0 and i < len(self.charset):
                text.append(self.charset[i])
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
    y0 = int(h * BAND_TOP) // 2 * 2
    bh = (int(h * BAND_BOTTOM) - y0) // 2 * 2
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
        text, conf = ocr.recognize(img, b)
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
            if conf >= 0.75 and CJK_RE.search(text) and abs(xc - width / 2.0) <= width * 0.28:
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
            if l[1] >= 0.6 and CJK_RE.search(l[0]) and abs(l[3] - width / 2.0) <= width * 0.28 and abs(l[2] - mode_y) <= max(24, l[4] * 1.6)
        ]
        keep.sort(key=lambda l: l[2])
        text = "".join(l[0] for l in keep)
        # dòng chỉ 1 chữ dễ đọc nhầm (嗯 → 咽) → cần độ tin cậy cao
        if len(CJK_RE.findall(text)) == 1 and max([l[1] for l in keep] or [0]) < 0.85:
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
        if d < 0.4:
            continue
        if duration > 0 and total.get(e["sourceText"], 0) > max(20.0, 0.35 * duration):
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
        return {"ok": False, "errorCode": "NO_SUBTITLES", "error": "Không tìm thấy phụ đề chữ Trung trong hình video."}
    segs = build_events(per_frame, fps, dur)
    if not segs:
        return {"ok": False, "errorCode": "NO_SUBTITLES", "error": "Không tìm thấy phụ đề chữ Trung trong hình video."}
    return {"ok": True, "segments": segs, "totalDuration": round(dur, 2), "framesRead": len(frames), "subtitleY": mode_y}

# -*- coding: utf-8 -*-
"""
Module nhận dạng & chia câu RIÊNG cho video tiếng Anh.

Đường xử lý tiếng Trung (local_ai_worker.py) giữ nguyên — module này chỉ chạy khi ngôn ngữ đầu vào là tiếng Anh
(người dùng chọn "Tiếng Anh", hoặc "Tự động" và Whisper nhận ra tiếng Anh).

Khác biệt so với đường chung:
- Ép Whisper nhận dạng tiếng Anh + gợi ý có dấu câu (initial_prompt) để có dấu chấm/phẩy rõ ràng → chia câu đúng hơn.
- Người nói tiếng Anh hay ngừng 0,3–0,7 s ở dấu phẩy ("Hi everyone, ... / Honestly, ..."): KHÔNG coi đó là hết câu.
  Chỉ tách khi có dấu kết câu (bỏ qua viết tắt Mr./Dr./U.S./3.5...) hoặc khoảng nghỉ thật >= 0,8 s.
- Gộp mảnh câu chưa kết thúc (chưa có dấu kết câu) với phần tiếp theo khi khoảng nghỉ < 0,8 s, và gộp mảnh quá ngắn
  (< 0,8 s, vd. "Okay." / "Yes.") — để bản dịch tiếng Việt không bị ngắt vụn và giọng đọc vừa thời lượng.
- Hai câu thật cách nhau >= 0,8 s vẫn tách riêng để lời lồng tiếng bắt đầu cùng lúc với lời gốc.
"""
import re

EN_INITIAL_PROMPT = "Hello everyone, welcome back. Today, we're going to talk about it. Okay, let's get started!"

# Viết tắt thường gặp — dấu chấm của chúng KHÔNG phải hết câu
_ABBREV = {
    "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.", "vs.", "etc.", "e.g.", "i.e.", "u.s.", "u.k.",
    "a.m.", "p.m.", "no.", "vol.", "approx.", "inc.", "ltd.", "co.", "jan.", "feb.", "aug.", "sept.", "oct.", "nov.", "dec.",
}
_SENT_END_RE = re.compile(r"[.!?…]+[\"')\]]*$")
_SOFT_PUNCT_RE = re.compile(r"[,;:—–-]$")

EN_PAUSE_SPLIT_SEC = 0.8   # khoảng nghỉ thật giữa 2 câu
EN_MERGE_GAP_SEC = 0.8     # gộp mảnh chưa hết câu nếu nghỉ ngắn hơn
EN_SHORT_PIECE_SEC = 0.8   # mảnh ngắn hơn ngưỡng này ("Okay.", "Yes.") được gộp với câu kế nếu nghỉ ngắn
EN_MAX_SEG_SEC = 9.0       # không gộp quá dài (khó khớp lồng tiếng)


def transcribe_english(model, audio_path):
    """Nhận dạng tiếng Anh (ép ngôn ngữ 'en', có gợi ý dấu câu). Trả về (segments_generator, info)."""
    return model.transcribe(
        audio_path,
        beam_size=5,
        language="en",
        initial_prompt=EN_INITIAL_PROMPT,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=350, speech_pad_ms=200),
        condition_on_previous_text=False,
    )


def _is_sentence_end(word):
    w = (word or "").strip()
    if not w or not _SENT_END_RE.search(w):
        return False
    low = w.lower().strip("\"')]")
    if low in _ABBREV:
        return False
    if re.fullmatch(r"(?:[a-z]\.){1,3}", low):  # viết tắt dạng a.m. / U.S.
        return False
    if re.fullmatch(r"\d+\.", low):  # số thứ tự / số thập phân bị cắt
        return False
    return True


def split_english_segment(seg, max_len_sec=EN_MAX_SEG_SEC):
    """Tách 1 đoạn Whisper tiếng Anh thành câu theo mốc thời gian từng từ."""
    text = (seg.text or "").strip()
    words = [w for w in (getattr(seg, "words", None) or []) if (w.word or "").strip()]
    if not words:
        return [{"start": float(seg.start), "end": float(seg.end), "text": text}]
    groups, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if nxt is None:
            break
        gap = float(nxt.start) - float(w.end)
        cur_len = float(w.end) - float(cur[0].start)
        if _is_sentence_end(w.word) or gap >= EN_PAUSE_SPLIT_SEC or (
            cur_len >= max_len_sec and (_SOFT_PUNCT_RE.search((w.word or "").strip()) or gap >= 0.25)
        ):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    out = []
    for g in groups:
        joined = "".join(x.word for x in g).strip()
        joined = re.sub(r"\s+", " ", joined).strip(" ,;:")
        if joined:
            out.append({"start": float(g[0].start), "end": float(g[-1].end), "text": joined})
    return out or [{"start": float(seg.start), "end": float(seg.end), "text": text}]


def merge_english_segments(raw_segments, total_duration):
    """Làm sạch + gộp mảnh câu tiếng Anh. Trả về danh sách {index, startSec, endSec, sourceText}."""
    cleaned = []
    for s in raw_segments:
        txt = re.sub(r"\s+", " ", (s.get("text") or "")).strip()
        if not txt:
            continue
        start = max(0.0, float(s.get("start", 0.0)))
        end = max(start + 0.3, float(s.get("end", start + 1.5)))
        if total_duration > 0:
            end = min(total_duration, end)
        cleaned.append({"startSec": round(start, 2), "endSec": round(end, 2), "sourceText": txt})
    merged = []
    for seg in cleaned:
        if not merged:
            merged.append(seg)
            continue
        prev = merged[-1]
        prev_dur = prev["endSec"] - prev["startSec"]
        gap = seg["startSec"] - prev["endSec"]
        combined = seg["endSec"] - prev["startSec"]
        prev_text = prev["sourceText"]
        ended = bool(_SENT_END_RE.search(prev_text))
        unfinished = not ended and gap < EN_MERGE_GAP_SEC
        tiny = prev_dur < EN_SHORT_PIECE_SEC and gap < 0.5
        if (unfinished or tiny) and combined <= EN_MAX_SEG_SEC:
            sep = " " if ended else ", "
            prev["endSec"] = round(seg["endSec"], 2)
            prev["sourceText"] = f"{prev_text.rstrip(' ,;:')}{sep}{seg['sourceText']}"
        else:
            merged.append(seg)
    for i, it in enumerate(merged):
        it["index"] = i + 1
    return merged

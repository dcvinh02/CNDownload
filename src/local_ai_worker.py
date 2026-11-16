#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Local AI Worker cho CN Video Scraper Pro:
1. ASR (Speech-to-Text): Nhận dạng giọng nói thực tế từ track âm thanh (WAV 16kHz) bằng Faster-Whisper (CTranslate2 int8).
   - Trả về ngôn ngữ nói thực tế, độ tin cậy và các phân đoạn có mốc thời gian chính xác (startSec, endSec, sourceText).
   - Tuyệt đối không dùng tiêu đề video làm transcript giả. Nếu không có lời thoại, báo lỗi NO_SPEECH_DETECTED.
2. NMT (Neural Machine Translation): Dịch từng đoạn thoại sang ngôn ngữ đích bằng CTranslate2 + SentencePiece (Argos Offline Models)
   hoặc Cloud Translation (CHỈ KHI cloud_consent == 1).
3. TTS (Text-to-Speech): Tổng hợp giọng đọc tiếng Việt Neural Offline bằng Sherpa-ONNX (Piper VITS ONNX: VAIS-1000, 25Hours, VIVOS 65 giọng)
   hoặc Edge Cloud Neural TTS (CHỈ KHI cloud_consent == 1).
"""

import argparse
import asyncio
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import wave


# Windows: console/pipe mặc định cp1252 → ký tự tiếng Việt/emoji gây UnicodeEncodeError. Ép UTF-8 cho giao thức.
for _s in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace" if _s is sys.stderr else "strict")
    except Exception:
        pass
import numpy as np


LANG_NAMES = {
    "zh": "Tiếng Trung (Chinese)",
    "vi": "Tiếng Việt (Vietnamese)",
    "en": "Tiếng Anh (English)",
    "ja": "Tiếng Nhật (Japanese)",
    "ko": "Tiếng Hàn (Korean)",
}


def load_payload(args):
    """Đọc dữ liệu đầu vào từ file JSON (ưu tiên) hoặc tham số dòng lệnh.

    Dùng file vì Windows giới hạn dòng lệnh 32.767 ký tự (video dài có thể > 90.000 ký tự).
    """
    path = getattr(args, "payload_file", "") or ""
    if path:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    return json.loads(args.payload_json or "{}")


def emit_progress(obj):
    sys.stdout.write("WORKER_PROGRESS:" + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def detokenize_sp(pieces):
    text = "".join(pieces).replace("▁", " ").strip()
    while "  " in text:
        text = text.replace("  ", " ")
    return text


STYLE_PROMPTS = {
    "natural": "Dịch sang văn nói tự nhiên, đời thường, ngắn gọn vừa nhịp đọc lồng tiếng video, bỏ cấu trúc dịch thô word-by-word.",
    "review": "Dịch theo văn phong review sản phẩm/công nghệ chuyên nghiệp, mạch lạc, súc tích, dễ nghe.",
    "story": "Dịch theo văn phong kể chuyện/thuyết minh mượt mà, giàu nhịp điệu, tự nhiên như người bản xứ.",
}


def normalize_punct_and_spaces(text):
    out = (text or "").strip()
    if not out:
        return ""
    replacements = [
        ("，", ", "),
        ("。", ". "),
        ("！", "! "),
        ("？", "? "),
        ("；", "; "),
        ("：", ": "),
        ("（", " ("),
        ("）", ") "),
        ("【", " ["),
        ("】", "] "),
        ("“", '"'),
        ("”", '"'),
        ("、", ", "),
    ]
    for src_ch, dst_ch in replacements:
        out = out.replace(src_ch, dst_ch)
    out = re.sub(r"\s+([,.;:!?])", r"\1", out)
    out = re.sub(r"([,.;:!?])(?=[^\s\"')\]\d.])", r"\1 ", out)
    out = re.sub(r"\s{2,}", " ", out).strip()
    out = out.rstrip(" ").strip()
    return out


def polish_translation(text, target_lang="vi", style="natural"):
    out = normalize_punct_and_spaces(text)
    if not out:
        return ""
    tgt = (target_lang or "vi").lower()[:2]
    if tgt == "vi":
        vi_fixes = [
            (r"\bnhư bạn có thể thấy\b", "như các bạn thấy đấy"),
            (r"\btheo ý kiến của tôi\b", "theo mình"),
            (r"\bcảm ơn bạn đã xem\b", "cảm ơn các bạn đã xem"),
            (r"\bđừng quên nhấn đăng ký\b", "đừng quên bấm đăng ký"),
            (r"\bhãy chắc chắn rằng\b", "hãy nhớ rằng"),
            (r"\bđiều này là bởi vì\b", "là vì"),
            (r"\btôi muốn nói rằng\b", "tôi muốn nói là"),
            (r"\btrong trường hợp này\b", "trong lúc này"),
            (r"\bsản phẩm này rất tốt cho\b", "sản phẩm này cực kỳ hợp để"),
        ]
        if style == "story":
            vi_fixes.append((r"\bnhư các bạn thấy đấy\b", "như bạn thấy đấy"))
        for pat, rep in vi_fixes:
            out = re.sub(pat, rep, out, flags=re.IGNORECASE)
        out = re.sub(r"\s+([,.;:!?])", r"\1", out)
        out = re.sub(r"\s{2,}", " ", out).strip()
        if out and out[0].islower():
            out = out[0].upper() + out[1:]
    return out


def group_indices_for_context(texts, segments=None, max_group_size=1, max_chars=130):
    """Nhóm phân đoạn để dịch.

    Mặc định max_group_size=1: mỗi phân đoạn được dịch riêng để bản dịch luôn khớp đúng ID/timestamp.
    (Gộp nhiều đoạn rồi chia lại bản dịch theo độ dài từng làm lệch nghĩa sang đoạn bên cạnh.)
    """
    groups = []
    cur_group = []
    cur_chars = 0
    terminal_re = re.compile(r"[。！？!?；;…\.]$")

    for i, raw in enumerate(texts):
        clean = (raw or "").strip()
        if not clean:
            if cur_group:
                groups.append(cur_group)
                cur_group = []
                cur_chars = 0
            groups.append([i])
            continue

        if cur_group and segments and i < len(segments) and cur_group[-1] < len(segments):
            prev_seg = segments[cur_group[-1]]
            cur_seg = segments[i]
            gap = float(cur_seg.get("startSec", 0) or 0) - float(prev_seg.get("endSec", 0) or 0)
            if gap > 0.85:
                groups.append(cur_group)
                cur_group = []
                cur_chars = 0

        cur_group.append(i)
        cur_chars += len(clean)
        if (
            terminal_re.search(clean)
            or len(cur_group) >= max_group_size
            or cur_chars >= max_chars
        ):
            groups.append(cur_group)
            cur_group = []
            cur_chars = 0

    if cur_group:
        groups.append(cur_group)
    return groups


def join_group_source(texts, group_indices):
    parts = [(texts[i] or "").strip() for i in group_indices if (texts[i] or "").strip()]
    if not parts:
        return ""
    has_cjk = any("\u4e00" <= ch <= "\u9fff" or "\u3040" <= ch <= "\u30ff" for ch in "".join(parts))
    if has_cjk:
        out = parts[0]
        for p in parts[1:]:
            if re.search(r"[，。！？、；：,.!?]$", out):
                out += p
            else:
                out += "，" + p
        return out
    out = parts[0]
    for p in parts[1:]:
        if re.search(r"[,.;:!?]$", out):
            out += " " + p
        else:
            out += ", " + p
    return out


def split_translated_to_group(translated_sentence, source_parts):
    n = len(source_parts)
    if n <= 1:
        return [translated_sentence.strip()]

    text = (translated_sentence or "").strip()
    words = text.split()
    if len(words) < n:
        # Câu dịch quá ngắn để chia từ, phân bổ dấu câu hoặc giữ rõ ở đoạn chính
        res = []
        for idx in range(n):
            res.append(text if idx == 0 else "")
        # Tránh đoạn rỗng khiến TTS lỗi
        return [x if x else "..." for x in res]

    lengths = [max(1, len((p or "").strip())) for p in source_parts]
    total_len = sum(lengths)
    boundaries = []
    acc = 0
    for idx in range(n - 1):
        acc += lengths[idx]
        ideal_char = int(round((acc / float(total_len)) * len(text)))
        # Tìm vị trí dấu phẩy hoặc khoảng trắng gần nhất với ideal_char
        best_pos = -1
        best_dist = 999999
        for pos in range(1, len(text)):
            ch = text[pos - 1]
            if ch in (",", ";", ":") or text[pos] == " ":
                bonus = -6 if ch in (",", ";", ":") else 0
                dist = abs(pos - ideal_char) + bonus
                if dist < best_dist:
                    best_dist = dist
                    best_pos = pos
        boundaries.append(best_pos)

    # Bảo đảm ranh giới tăng nghiêm ngặt
    pieces = []
    prev_cut = 0
    for idx, b in enumerate(boundaries):
        min_cut = prev_cut + 1
        max_cut = len(text) - (n - 1 - idx)
        cut = max(min_cut, min(max_cut, b if b > 0 else prev_cut + max(1, (len(text) - prev_cut) // (n - idx))))
        # Kéo tới hết từ hiện tại nếu lỡ rơi vào giữa từ
        while cut < max_cut and cut > 0 and text[cut - 1] != " " and text[cut] != " ":
            cut += 1
        part = text[prev_cut:cut].strip()
        if not part:
            part = text[prev_cut:max_cut].strip() or text
        pieces.append(part)
        prev_cut = cut
    last_part = text[prev_cut:].strip() or pieces[-1]
    pieces.append(last_part)
    return pieces


def cloud_translate_single(text, source_lang, target_lang):
    clean = (text or "").strip()
    if not clean or source_lang == target_lang:
        return clean
    url = (
        "https://translate.googleapis.com/translate_a/single?client=gtx"
        f"&sl={urllib.parse.quote(source_lang or 'auto')}"
        f"&tl={urllib.parse.quote(target_lang)}"
        f"&dt=t&q={urllib.parse.quote(clean)}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        if isinstance(data, list) and data and isinstance(data[0], list):
            out = "".join(part[0] for part in data[0] if part and part[0]).strip()
            if out:
                return out
    raise RuntimeError("Không nhận được phản hồi hợp lệ từ dịch vụ dịch đám mây Google.")


def cloud_google_translate_batch(texts, source_lang, target_lang, segments=None, style="natural"):
    groups = group_indices_for_context(texts, segments=segments)
    group_sources = [join_group_source(texts, g) for g in groups]

    # Dịch gộp các câu theo lô nhỏ qua delimiter ít bị biến dạng để tiết kiệm request và giữ mạch câu
    translated_groups = [""] * len(group_sources)
    chunk_size = 10
    sep_token = "\n[###]\n"
    for start in range(0, len(group_sources), chunk_size):
        chunk = group_sources[start : start + chunk_size]
        non_empty_pos = [idx for idx, txt in enumerate(chunk) if txt]
        if not non_empty_pos:
            continue
        if len(non_empty_pos) == 1:
            idx0 = non_empty_pos[0]
            translated_groups[start + idx0] = cloud_translate_single(
                chunk[idx0], source_lang, target_lang
            )
            continue

        joined = sep_token.join(chunk[idx] for idx in non_empty_pos)
        raw_out = cloud_translate_single(joined, source_lang, target_lang)
        split_parts = re.split(r"\s*\[\s*#+\s*\]\s*", raw_out.strip())
        if len(split_parts) == len(non_empty_pos):
            for k_idx, pos_in_chunk in enumerate(non_empty_pos):
                translated_groups[start + pos_in_chunk] = split_parts[k_idx].strip()
        else:
            for pos_in_chunk in non_empty_pos:
                translated_groups[start + pos_in_chunk] = cloud_translate_single(
                    chunk[pos_in_chunk], source_lang, target_lang
                )

    final_out = list(texts)
    for g_idx, g_indices in enumerate(groups):
        g_trans = translated_groups[g_idx]
        if not g_trans:
            continue
        if len(g_indices) == 1:
            final_out[g_indices[0]] = polish_translation(g_trans, target_lang, style)
        else:
            src_parts = [texts[idx] for idx in g_indices]
            split_items = split_translated_to_group(g_trans, src_parts)
            for k_idx, orig_idx in enumerate(g_indices):
                final_out[orig_idx] = polish_translation(split_items[k_idx], target_lang, style)
    return final_out


class LocalArgosTranslator:
    def __init__(self, argos_root):
        self.argos_root = argos_root
        self._loaded = {}

    def _get_pair(self, pair_folder):
        if pair_folder in self._loaded:
            return self._loaded[pair_folder]
        import ctranslate2
        import sentencepiece as spm

        pair_dir = os.path.join(self.argos_root, pair_folder)
        sp_path = os.path.join(pair_dir, "sentencepiece.model")
        model_dir = os.path.join(pair_dir, "model")
        if not os.path.exists(sp_path) or not os.path.exists(model_dir):
            return None
        sp = spm.SentencePieceProcessor(model_file=sp_path)
        tr = ctranslate2.Translator(model_dir, device="cpu", intra_threads=2)
        self._loaded[pair_folder] = (sp, tr)
        return (sp, tr)

    def has_pair(self, pair_folder):
        pair_dir = os.path.join(self.argos_root, pair_folder)
        return os.path.exists(os.path.join(pair_dir, "sentencepiece.model")) and os.path.exists(
            os.path.join(pair_dir, "model", "model.bin")
        )

    def translate_with_pair(self, texts, pair_folder):
        pair = self._get_pair(pair_folder)
        if not pair:
            raise RuntimeError(f"Thiếu mô hình dịch Offline '{pair_folder}' trong {self.argos_root}.")
        sp, tr = pair
        results = []
        batch_tokens = [sp.encode(t.strip(), out_type=str) if t.strip() else [] for t in texts]
        non_empty_indices = [i for i, tok in enumerate(batch_tokens) if tok]
        if not non_empty_indices:
            return [t for t in texts]

        to_translate = [batch_tokens[i] for i in non_empty_indices]
        hyps = tr.translate_batch(
            to_translate,
            beam_size=4,
            repetition_penalty=1.15,
            no_repeat_ngram_size=3,
            max_decoding_length=320,
        )
        translated_map = {}
        for idx_pos, orig_idx in enumerate(non_empty_indices):
            pieces = hyps[idx_pos].hypotheses[0] if hyps[idx_pos].hypotheses else []
            translated_map[orig_idx] = detokenize_sp(pieces)

        for i in range(len(texts)):
            results.append(translated_map.get(i, texts[i]))
        return results

    def _translate_grouped(self, texts, pair_seq, segments=None):
        """Gộp các đoạn thoại ngắn thành câu hoàn chỉnh theo dấu câu trước khi chạy Argos CTranslate2."""
        groups = group_indices_for_context(texts, segments=segments)
        group_sources = [join_group_source(texts, g) for g in groups]

        cur = list(group_sources)
        for pair_folder in pair_seq:
            cur = self.translate_with_pair(cur, pair_folder)

        out = list(texts)
        for g_idx, g_indices in enumerate(groups):
            if not group_sources[g_idx]:
                continue
            trans_group = cur[g_idx]
            if len(g_indices) == 1:
                out[g_indices[0]] = trans_group
            else:
                src_parts = [texts[idx] for idx in g_indices]
                split_items = split_translated_to_group(trans_group, src_parts)
                for k_idx, orig_idx in enumerate(g_indices):
                    out[orig_idx] = split_items[k_idx]
        return out

    def translate_texts(self, texts, source_lang, target_lang, whisper_en_texts=None, segments=None, style="natural"):
        src = (source_lang or "zh").lower()[:2]
        tgt = (target_lang or "vi").lower()[:2]
        if src == tgt:
            return list(texts), f"Giữ nguyên ngôn ngữ gốc ({src.upper()})"

        raw_out = None
        mode = ""

        if src == "zh" and tgt == "en":
            if self.has_pair("translate-zh_en-1_9"):
                raw_out = self._translate_grouped(texts, ["translate-zh_en-1_9"], segments=segments)
                mode = "Offline Local NMT Ngữ cảnh (Argos CTranslate2 ZH -> EN)"
            elif whisper_en_texts and len(whisper_en_texts) == len(texts):
                raw_out = list(whisper_en_texts)
                mode = "Offline Local Whisper Audio-to-English Translation"
            else:
                raise RuntimeError("Thiếu mô hình dịch Offline Trung -> Anh (translate-zh_en-1_9).")

        elif src == "en" and tgt == "vi":
            if self.has_pair("translate-en_vi-1_9"):
                raw_out = self._translate_grouped(texts, ["translate-en_vi-1_9"], segments=segments)
                mode = "Offline Local NMT Ngữ cảnh (Argos CTranslate2 EN -> VI)"
            else:
                raise RuntimeError("Thiếu mô hình dịch Offline Anh -> Việt (translate-en_vi-1_9).")

        elif src == "zh" and tgt == "vi":
            if self.has_pair("translate-zh_en-1_9") and self.has_pair("translate-en_vi-1_9"):
                raw_out = self._translate_grouped(
                    texts, ["translate-zh_en-1_9", "translate-en_vi-1_9"], segments=segments
                )
                mode = "Offline Local NMT Ngữ cảnh (Argos CTranslate2 ZH -> EN -> VI)"
            elif whisper_en_texts and len(whisper_en_texts) == len(texts) and self.has_pair("translate-en_vi-1_9"):
                raw_out = self._translate_grouped(whisper_en_texts, ["translate-en_vi-1_9"], segments=segments)
                mode = "Offline Local (Whisper ZH->EN + Argos EN->VI)"
            else:
                raise RuntimeError(
                    "Thiếu mô hình dịch Offline — chưa cài bộ dịch Offline: mở mục \"Công cụ\" → cài \"AI dịch Local Qwen3.5 9B\" (dịch ngay trên máy, không cần API Key), hoặc bật dịch AI Cloud (Gemini)."
                )

        elif src in ("ja", "ko") and tgt in ("en", "vi"):
            if whisper_en_texts and len(whisper_en_texts) == len(texts):
                if tgt == "en":
                    raw_out = list(whisper_en_texts)
                    mode = f"Offline Local Whisper ({src.upper()} -> EN)"
                elif tgt == "vi" and self.has_pair("translate-en_vi-1_9"):
                    raw_out = self._translate_grouped(whisper_en_texts, ["translate-en_vi-1_9"], segments=segments)
                    mode = f"Offline Local (Whisper {src.upper()}->EN + Argos EN->VI)"

        if raw_out is None:
            raise RuntimeError(
                f"Cặp ngôn ngữ dịch Offline ({src.upper()} -> {tgt.upper()}) chưa có mô hình Local. Bạn có thể bật tùy chọn dịch đám mây (Cloud) hoặc chỉnh sửa trực tiếp lời dịch."
            )

        polished = [polish_translation(x, tgt, style=style) for x in raw_out]
        return polished, mode


def run_translation_pipeline(
    texts,
    source_lang,
    target_lang,
    argos_dir,
    cloud_consent=False,
    provider="auto",
    style="natural",
    segments=None,
    whisper_en_texts=None,
    cloud_model="",
    cloud_base_url="",
):
    src = (source_lang or "zh").lower()[:2]
    tgt = (target_lang or "vi").lower()[:2]
    prov = (provider or "auto").strip().lower()
    st = (style or "natural").strip().lower()

    if not texts:
        return [], "Empty", False
    if src == tgt:
        return list(texts), f"Giữ nguyên ngôn ngữ gốc ({src.upper()})", False

    if prov in ("cloud_google", "cloud_gemini", "cloud_openai") and not cloud_consent:
        raise RuntimeError(
            "Bộ dịch Cloud yêu cầu tích chọn xác nhận gửi văn bản lên dịch vụ đám mây để bảo vệ riêng tư."
        )

    if prov.startswith("ai") or prov in ("cloud_gemini", "cloud_openai"):
        raise RuntimeError(
            "Bộ dịch AI (Gemini/OpenAI) được xử lý ở lớp AI Provider của ứng dụng, không qua worker Python."
        )

    if prov == "cloud_google":
        out = cloud_google_translate_batch(texts, src, tgt, segments=segments, style=st)
        return out, f"Cloud Google Ngữ cảnh • Văn phong {st}", True

    if prov == "auto" and cloud_consent:
        try:
            out = cloud_google_translate_batch(texts, src, tgt, segments=segments, style=st)
            return out, "Cloud Google Ngữ cảnh (Đã cho phép Cloud)", True
        except Exception as cloud_err:  # noqa: BLE001
            emit_progress({"stage": "translate", "warning": f"Google Cloud lỗi, chuyển sang dịch Offline: {cloud_err}"})

    translator = LocalArgosTranslator(argos_dir)
    try:
        out, mode = translator.translate_texts(
            texts, src, tgt, whisper_en_texts=whisper_en_texts, segments=segments, style=st
        )
        return out, mode, False
    except Exception as local_err:
        if cloud_consent and prov == "auto":
            out = cloud_google_translate_batch(texts, src, tgt, segments=segments, style=st)
            return out, "Cloud Google Ngữ cảnh (Fallback)", True
        raise local_err


DIAR_SEG_REL = os.path.join("sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")
DIAR_EMB_REL = "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"


def read_wav_float32(path):
    with wave.open(path, "rb") as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        raw = wf.readframes(wf.getnframes())
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data, sr


def run_speaker_diarization(audio_path, diar_dir, num_speakers=-1, threshold=0.8, merge_cos=0.55):
    """Phân tách người nói (sherpa-onnx: pyannote segmentation 3.0 + 3D-Speaker ERes2Net).

    Trả về danh sách (start, end, speaker_index) hoặc None nếu thiếu mô hình.
    """
    import sherpa_onnx

    seg_model = os.path.join(diar_dir, DIAR_SEG_REL)
    emb_model = os.path.join(diar_dir, DIAR_EMB_REL)
    if not (os.path.exists(seg_model) and os.path.exists(emb_model)):
        return None
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg_model),
            num_threads=2,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb_model, num_threads=2),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=int(num_speakers), threshold=float(threshold)),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("Cấu hình mô hình phân tách người nói không hợp lệ.")
    sd = sherpa_onnx.OfflineSpeakerDiarization(config)
    samples, sr = read_wav_float32(audio_path)
    if sr != sd.sample_rate:
        raise RuntimeError(f"Âm thanh phải có tần số {sd.sample_rate} Hz để phân tách người nói (đang là {sr}).")

    def _progress(done, total):
        emit_progress({"stage": "diarize", "done": int(done), "total": int(total)})
        return 0

    result = sd.process(samples, callback=_progress).sort_by_start_time()
    turns = [(float(r.start), float(r.end), int(r.speaker)) for r in result]
    if int(num_speakers) <= 0 and len(set(t[2] for t in turns)) > 1:
        turns = merge_similar_speakers(samples, sr, turns, emb_model, merge_cos)
    return turns


def merge_similar_speakers(samples, sr, turns, emb_model, merge_cos=0.55):
    """Bước 2 của phân tách người nói: gộp các cụm có giọng quá giống nhau.

    Phân cụm nhanh đôi khi chia một người thành nhiều cụm (vd. người đọc đổi ngữ điệu). Tính embedding
    trung bình mỗi cụm (3D-Speaker) rồi gộp dần cặp cụm có cosine >= merge_cos.
    Đã đo: 2 giọng khác nhau ~0.17; cùng một người bị chia đôi ~0.72.
    """
    import sherpa_onnx

    ext = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb_model, num_threads=2)
    )
    embs = {}
    for (a, b, spk) in turns:
        chunk = samples[int(a * sr): int(b * sr)]
        if len(chunk) < int(sr * 0.6):
            continue
        st = ext.create_stream()
        st.accept_waveform(sr, chunk)
        st.input_finished()
        e = np.array(ext.compute(st), dtype=np.float32)
        n = float(np.linalg.norm(e))
        if n > 0:
            embs.setdefault(spk, []).append(e / n)
    label = {spk: spk for spk in set(t[2] for t in turns)}

    def centroid(lst):
        c = np.mean(lst, axis=0)
        return c / (np.linalg.norm(c) or 1.0)

    groups = {spk: list(v) for spk, v in embs.items()}
    while len(groups) > 1:
        keys = list(groups.keys())
        best = None
        for i in range(len(keys)):
            for j in range(i + 1, len(keys)):
                sim = float(centroid(groups[keys[i]]) @ centroid(groups[keys[j]]))
                if best is None or sim > best[0]:
                    best = (sim, keys[i], keys[j])
        if best is None or best[0] < merge_cos:
            break
        _, keep, drop = best
        groups[keep].extend(groups.pop(drop))
        for k, v in label.items():
            if v == drop:
                label[k] = keep
    return [(a, b, label[spk]) for (a, b, spk) in turns]


def assign_speakers_to_segments(segments, turns):
    """Gán speakerId cho mỗi phân đoạn ASR theo người nói chồng lấn thời gian nhiều nhất.

    Đánh số speaker_1, speaker_2... theo thứ tự xuất hiện đầu tiên.
    """
    order = {}
    for seg in segments:
        s0, e0 = float(seg["startSec"]), float(seg["endSec"])
        overlap = {}
        for (s1, e1, spk) in turns:
            ov = min(e0, e1) - max(s0, s1)
            if ov > 0:
                overlap[spk] = overlap.get(spk, 0.0) + ov
        if not overlap:
            # không chồng lấn: lấy lượt nói gần nhất
            mid = (s0 + e0) / 2.0
            nearest = min(turns, key=lambda t: min(abs(t[0] - mid), abs(t[1] - mid))) if turns else None
            spk = nearest[2] if nearest else 0
        else:
            spk = max(overlap.items(), key=lambda kv: kv[1])[0]
        if spk not in order:
            order[spk] = len(order) + 1
        seg["speakerId"] = f"speaker_{order[spk]}"
    return len(order)


def align_bridge_by_time(segments, en_segs):
    """Ghép bản dịch tiếng Anh của Whisper (task=translate) vào từng phân đoạn theo THỜI GIAN.

    Không yêu cầu số đoạn khớp nhau: mỗi từ tiếng Anh (word timestamps) được gán cho phân đoạn chứa
    điểm giữa của từ; nếu không có word timestamps thì dùng độ chồng lấn của cả câu.
    """
    texts = [[] for _ in segments]
    bounds = [(float(sg["startSec"]), float(sg["endSec"])) for sg in segments]

    def best_index(t0, t1):
        mid = (t0 + t1) / 2.0
        for i, (a, b) in enumerate(bounds):
            if a - 0.15 <= mid <= b + 0.15:
                return i
        best, best_ov = None, 0.0
        for i, (a, b) in enumerate(bounds):
            ov = min(b, t1) - max(a, t0)
            if ov > best_ov:
                best, best_ov = i, ov
        return best

    for es in en_segs:
        words = list(getattr(es, "words", None) or [])
        if words:
            for w in words:
                idx = best_index(float(w.start), float(w.end))
                if idx is not None:
                    texts[idx].append(w.word)
        else:
            idx = best_index(float(es.start), float(es.end))
            if idx is not None:
                texts[idx].append(" " + (es.text or "").strip())
    out = ["".join(t).strip() for t in texts]
    if sum(1 for x in out if x) < max(1, int(len(out) * 0.6)):
        return None  # cầu nối quá thưa, không đáng tin
    return out


SENTENCE_END_RE = re.compile(r"[。！？!?；;…]$|[.](?=\s*$)")

# Whisper đôi khi viết dấu câu dạng "cỡ nhỏ" (﹐ U+FE50, ﹒ ﹔ ﹕ ﹖ ﹗ ﹑) thay cho ，。；：？！、 — quy đổi về dạng chuẩn,
# nếu không bộ chia câu không nhận ra dấu phẩy/dấu chấm → gộp nhiều câu (nhiều nhân vật) thành đoạn 10+ giây.
_SMALL_PUNCT = str.maketrans({"\ufe50": "，", "\ufe51": "、", "\ufe52": "。", "\ufe54": "；", "\ufe55": "：", "\ufe56": "？", "\ufe57": "！"})


def normalize_punct(text):
    return (text or "").translate(_SMALL_PUNCT)


PAUSE_SPLIT_SEC = 0.45  # khoảng nghỉ giữa 2 từ >= ngưỡng này -> coi là ranh giới câu nói
SOFT_PUNCT_RE = re.compile(r"[，,、：:]$")


def split_segment_by_sentences(seg, max_len_sec=7.0):
    """Tách đoạn ASR thành từng câu nói theo mốc thời gian từng từ (word_timestamps).

    Ranh giới khi: (1) từ kết thúc bằng dấu kết câu; (2) khoảng nghỉ thật tới từ kế tiếp >= 0.45 s
    (Whisper thường gộp 2 câu cách nhau 1 s và chỉ dùng dấu phẩy); (3) đoạn đã dài > max_len_sec và gặp dấu phẩy.
    Đúng ranh giới câu thì lời lồng tiếng mới bắt đầu cùng lúc với lời gốc.
    """
    text = (seg.text or "").strip()
    words = [w for w in (getattr(seg, "words", None) or []) if (w.word or "").strip()]
    if not words:
        return [{"start": seg.start, "end": seg.end, "text": text}]
    groups = []
    cur = []
    for i, w in enumerate(words):
        cur.append(w)
        wt = normalize_punct((w.word or "").strip())
        nxt = words[i + 1] if i + 1 < len(words) else None
        gap = (float(nxt.start) - float(w.end)) if nxt else 0.0
        cur_len = float(w.end) - float(cur[0].start)
        if nxt is None:
            break
        if SENTENCE_END_RE.search(wt) or gap >= PAUSE_SPLIT_SEC or (cur_len >= max_len_sec and (SOFT_PUNCT_RE.search(wt) or gap >= 0.2)):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    pieces = []
    for grp in groups:
        joined = normalize_punct("".join(x.word for x in grp)).strip().strip(",，、")
        if not joined:
            continue
        pieces.append({"start": float(grp[0].start), "end": float(grp[-1].end), "text": joined})
    return pieces or [{"start": seg.start, "end": seg.end, "text": text}]


def merge_and_clean_asr_segments(raw_segments, total_duration):
    """
    Gộp các đoạn thoại quá ngắn (< 1.1s) liền kề nhau để tạo câu thoại tự nhiên,
    và loại bỏ các đoạn trống hoặc nhiễu.
    """
    cleaned = []
    for s in raw_segments:
        txt = normalize_punct((s.get("text") or "")).strip()
        if not txt:
            continue
        start = max(0.0, float(s.get("start", 0.0)))
        end = max(start + 0.3, float(s.get("end", start + 1.5)))
        if total_duration > 0:
            end = min(total_duration, end)
        cleaned.append({"startSec": round(start, 2), "endSec": round(end, 2), "sourceText": txt})

    if not cleaned:
        return []

    merged = []
    for seg in cleaned:
        if not merged:
            merged.append(seg)
            continue
        prev = merged[-1]
        prev_dur = prev["endSec"] - prev["startSec"]
        gap = seg["startSec"] - prev["endSec"]
        combined_dur = seg["endSec"] - prev["startSec"]
        prev_text = prev["sourceText"].strip()
        has_end_punct = bool(re.search(r"[。！？.!?]$", prev_text))
        # Gộp các câu chưa kết thúc dấu câu hoặc quá ngắn nếu khoảng nghỉ nhỏ để tránh dịch cắt vụn
        # Chỉ gộp mảnh rất ngắn nói LIỀN MẠCH (khoảng nghỉ < 0.3 s). Không gộp qua khoảng nghỉ thật,
        # nếu không lời lồng tiếng của câu sau sẽ phát sớm/muộn so với hình (lệch đồng bộ).
        if prev_dur < 1.2 and not has_end_punct and gap < 0.3 and combined_dur <= 6.0:
            sep = "，" if any("\u4e00" <= c <= "\u9fff" for c in prev_text) else ", "
            prev["endSec"] = round(seg["endSec"], 2)
            prev["sourceText"] = f"{prev_text}{sep}{seg['sourceText']}"
        else:
            merged.append(seg)

    for idx, item in enumerate(merged):
        item["index"] = idx + 1
    return merged


def refine_segment_starts(audio_path, segments, sr=16000):
    """
    Whisper hay đặt mốc từ đầu tiên SỚM hơn lời nói thật (~0,1–0,25 s; cộng thêm speech_pad của VAD),
    làm lời lồng tiếng vào trước lời gốc. Căn lại theo năng lượng âm thanh thật:
    - chỉ dời mốc VỀ SAU, tối đa 0,4 s, không vượt quá (endSec - 0,3 s);
    - chỉ khi phần trước điểm bắt đầu nói là khoảng lặng rõ (thấp hơn mức lời nói >= 20 dB);
      có nhạc nền/tiếng động lớn thì giữ nguyên mốc ASR.
    """
    if not segments:
        return segments
    try:
        import numpy as _np
        from faster_whisper.audio import decode_audio

        pcm = decode_audio(audio_path, sampling_rate=sr).astype(_np.float32)
    except Exception:
        return segments
    hop = int(sr * 0.01)  # khung 10 ms
    n = len(pcm) // hop
    if n <= 0:
        return segments
    frames = pcm[: n * hop].reshape(n, hop)
    db = 10.0 * _np.log10(_np.mean(frames * frames, axis=1) + 1e-12)
    for seg in segments:
        st, en = float(seg["startSec"]), float(seg["endSec"])
        i0 = int(st * 100)
        i_hi = min(n, int(min(st + 0.4, en - 0.3) * 100))
        i_ref = min(n, int(min(st + 1.2, en) * 100))
        if i_hi <= i0 + 1 or i_ref <= i0:
            continue
        speech_db = float(_np.percentile(db[i0:i_ref], 90))
        thr = speech_db - 20.0
        onset = None
        for k in range(i0, i_hi):
            if db[k] >= thr:
                onset = k
                break
        if onset is not None and onset > i0:
            seg["startSec"] = round(onset / 100.0, 2)
    return segments


# ----------------------------------------------------------------------------------------------
# SenseVoiceSmall (FunAudioLLM, int8, qua sherpa-onnx) + Silero VAD — nhận dạng giọng nói mặc định.
# Bản int8 2024-07-17. Đo trên video tiếng Tứ Xuyên có nhạc nền (bản chuẩn 134 câu đọc tay): 85,0% chữ đúng so với
# Whisper small 60,0%, nhanh hơn ~5 lần. Chia câu theo dấu kết câu và khoảng ngừng giữa các chữ (mốc thời gian từng chữ).
# ----------------------------------------------------------------------------------------------
class _AsrInfo:
    def __init__(self, language, duration, prob=0.0):
        self.language = language
        self.duration = duration
        self.language_probability = prob


SV_GAP_SPLIT = 0.6   # khoảng cách giữa mốc bắt đầu 2 chữ liền nhau >= 0,6 s (≈ ngừng >= 0,4 s) → ranh giới câu
SV_MAX_LEN = 7.0     # câu dài hơn → tách ở khoảng ngừng lớn nhất / dấu phẩy
SV_LANG_MAP = {"zh": "zh", "yue": "zh", "en": "en", "ja": "ja", "ko": "ko"}
# Chữ chỉ dùng trong tiếng Quảng Đông viết (khẩu ngữ) — dấu hiệu video nói tiếng Quảng Đông
CANTONESE_RE = re.compile(r"[咗哋唔嘅佢冇喺嘢咁啲噉睇嚟嗰啱乜嘥攞揾噃喎]")


def sensevoice_ready(sv_dir):
    return bool(sv_dir) and all(os.path.exists(os.path.join(sv_dir, f)) for f in ("model.int8.onnx", "tokens.txt", "silero_vad.onnx"))


def _sv_vad_segments(sv_dir, samples, sr):
    import numpy as _np
    import sherpa_onnx as so

    cfg = so.VadModelConfig()
    cfg.silero_vad.model = os.path.join(sv_dir, "silero_vad.onnx")
    cfg.silero_vad.min_silence_duration = 0.25
    cfg.silero_vad.min_speech_duration = 0.2
    cfg.silero_vad.max_speech_duration = 15
    cfg.sample_rate = sr
    vad = so.VoiceActivityDetector(cfg, buffer_size_in_seconds=60)
    win = cfg.silero_vad.window_size
    spans = []
    for i in range(0, len(samples), win):
        vad.accept_waveform(samples[i:i + win])
        while not vad.empty():
            spans.append((vad.front.start, vad.front.start + len(vad.front.samples)))
            vad.pop()
    vad.flush()
    while not vad.empty():
        spans.append((vad.front.start, vad.front.start + len(vad.front.samples)))
        vad.pop()
    # VAD cắt sát → mất chữ đầu/cuối câu ("老板" → "板"). Nới mỗi đoạn 0,3 s hai đầu nhưng không lấn sang đoạn bên cạnh.
    pad = int(0.3 * sr)
    out = []
    for k, (a, b) in enumerate(spans):
        lo = max(0, a - pad, (spans[k - 1][1] + a) // 2 if k > 0 else 0)
        hi = min(len(samples), b + pad, (b + spans[k + 1][0]) // 2 if k + 1 < len(spans) else len(samples))
        out.append((lo / float(sr), _np.asarray(samples[lo:hi], dtype=_np.float32)))
    return out


def _sv_recognizer(sv_dir, language):
    import sherpa_onnx as so

    return so.OfflineRecognizer.from_sense_voice(
        model=os.path.join(sv_dir, "model.int8.onnx"), tokens=os.path.join(sv_dir, "tokens.txt"),
        num_threads=4, language=language, use_itn=True,
    )


def _sv_decode(rec, sr, samples):
    st = rec.create_stream()
    st.accept_waveform(sr, samples)
    rec.decode_stream(st)
    return st.result


_SV_WORD_RE = re.compile(r"[0-9A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")
_SV_ABBR = {"mr", "mrs", "ms", "dr", "st", "vs", "jr", "sr", "no", "mt", "etc", "prof", "inc", "ltd"}


def _sv_split(seg_start, seg_end, tokens, times, lang):
    """Chia 1 đoạn nói (VAD) thành các câu theo dấu kết câu / khoảng ngừng giữa các CHỮ.

    - Dấu câu và dấu cách luôn dính vào chữ đứng trước (mốc thời gian của dấu câu hay bị muộn → không dùng).
    - Tiếng Anh: dấu chấm không kết câu ở viết tắt ("Mr.") hay số thập phân ("3.5").
    """
    items = [(t, float(x)) for t, x in zip(tokens, times) if t and not (t.startswith("<|") and t.endswith("|>"))]
    widx = [i for i, (t, _) in enumerate(items) if _SV_WORD_RE.search(t)]
    if not widx:
        return []
    groups, cur = [], []
    word = ""
    for k, i in enumerate(widx):
        nxt_i = widx[k + 1] if k + 1 < len(widx) else len(items)
        chunk = items[i:nxt_i]  # chữ + dấu câu / dấu cách theo sau
        cur.append(chunk)
        tok = chunk[0][0]
        word = tok.strip() if (tok.startswith(" ") or tok.startswith("\u2581") or not word) else word + tok.strip()
        if k + 1 >= len(widx):
            break
        nxt_tok = items[widx[k + 1]][0]
        gap = items[widx[k + 1]][1] - chunk[0][1]
        tail = normalize_punct("".join(t for t, _ in chunk[1:]))
        ends = bool(re.search(r"[。！？!?；;…]", tail))
        if not ends and "." in tail:
            starts_new_word = nxt_tok.startswith(" ") or nxt_tok.startswith("\u2581") or " " in tail
            ends = starts_new_word and word.lower().strip(".") not in _SV_ABBR and not (word[-1:].isdigit() and nxt_tok.strip()[:1].isdigit())
        soft = bool(re.search(r"[，,、：:]", tail))
        cur_len = chunk[0][1] - cur[0][0][1]
        if ends or gap >= SV_GAP_SPLIT or (cur_len >= SV_MAX_LEN and (gap >= 0.35 or soft)):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    pieces = []
    for gi, grp in enumerate(groups):
        text = "".join(t for chunk in grp for t, _ in chunk).replace("\u2581", " ")
        text = normalize_punct(re.sub(r"\s+", " ", text)).strip().strip(",，、")
        if lang != "en":
            text = text.replace(" ", "")
        if not _SV_WORD_RE.search(text):
            continue
        start = seg_start + grp[0][0][1]
        nxt_start = seg_start + groups[gi + 1][0][0][1] if gi + 1 < len(groups) else seg_end
        end = min(seg_start + grp[-1][0][1] + 0.35, nxt_start - 0.05, seg_end)
        pieces.append({"start": round(start, 3), "end": round(max(end, start + 0.3), 3), "text": text})
    return pieces


def transcribe_sensevoice(sv_dir, audio_path, input_lang="auto"):
    """Trả về (danh sách {start,end,text}, info{language, duration, dialect}).

    - "auto" (mặc định): SenseVoice tự nhận giọng TỪNG ĐOẠN NÓI (Phổ thông, Quảng Đông, Anh, Nhật, Hàn) — video trộn
      nhiều giọng / tiếng địa phương vẫn nhận đúng. Đo trên video tiếng Tứ Xuyên: tự nhận 85,0% ≈ ép Phổ thông 85,5%
      (ép Quảng Đông chỉ 76% — chỉ dùng cho video nói tiếng Quảng Đông).
    - "zh" ép tiếng Phổ thông, "yue" ép tiếng Quảng Đông, "en" ép tiếng Anh.
    """
    samples, sr = read_wav_float32(audio_path)
    duration = len(samples) / float(sr) if sr else 0.0
    vsegs = _sv_vad_segments(sv_dir, samples, sr)
    forced = {"zh": "zh", "yue": "yue", "en": "en"}.get(input_lang, "auto")

    def decode_all(language, split_lang, report=True):
        rec = _sv_recognizer(sv_dir, language)
        out, vt = [], {}
        for st, smp in vsegs:
            res = _sv_decode(rec, sr, smp)
            tag = (getattr(res, "lang", "") or "").strip("<|>") or language
            vt[tag] = vt.get(tag, 0) + len(smp)
            en = st + len(smp) / float(sr)
            if report and duration > 0:
                emit_progress({"stage": "asr", "pos": round(en, 2), "total": round(duration, 2)})
            # ngôn ngữ của TỪNG đoạn nói (video tiếng Trung có câu tiếng Anh xen giữa vẫn giữ dấu cách)
            txt = getattr(res, "text", "") or ""
            seg_lang = "en" if (split_lang == "en" or tag == "en" or len(re.findall(r"[A-Za-z]", txt)) > 2 * len(re.findall(r"[\u4e00-\u9fff]", txt))) else "zh"
            out.extend(_sv_split(st, en, list(res.tokens), list(res.timestamps), seg_lang))
        return out, vt

    raw, votes = decode_all(forced, "en" if forced == "en" else "zh")
    total = float(sum(votes.values()) or 1)
    # Nhãn ngôn ngữ của model chưa đủ chắc (bản 2025 gắn "yue" cho mọi câu, kể cả tiếng Anh)
    # → gộp zh/yue thành tiếng Trung; nhận biết giọng Quảng Đông qua CHỮ đặc trưng trong lời nhận dạng được.
    merged = {}
    for k, v in votes.items():
        kk = SV_LANG_MAP.get(k, k)
        merged[kk] = merged.get(kk, 0) + v
    # → xét chữ viết của lời nhận dạng được
    alltext = "".join(r.get("text", "") for r in raw)
    n_latin = len(re.findall(r"[A-Za-z]", alltext))
    n_cjk = len(re.findall(r"[\u4e00-\u9fff]", alltext))
    n_kana = len(re.findall(r"[\u3040-\u30ff]", alltext))
    n_hangul = len(re.findall(r"[\uac00-\ud7af]", alltext))
    if forced in ("zh", "yue", "en"):
        top = "zh" if forced in ("zh", "yue") else "en"
    elif n_hangul > max(n_cjk, n_latin) * 0.5:
        top = "ko"
    elif n_kana > n_cjk * 0.2:
        top = "ja"
    elif n_latin > n_cjk * 3:
        top = "en"
    else:
        top = "zh"
    merged = {top: total}
    lang = top
    if forced == "auto" and lang == "en":
        # Đã nhận ra tiếng Anh → giải mã lại với chế độ ép tiếng Anh: chế độ tự nhận hay viết số trong câu tiếng Anh
        # thành chữ Trung ("3.5" → "三点五") và dính từ. Nhanh (~1 s mỗi phút âm thanh).
        raw, _ = decode_all("en", "en", report=False)
    yue_lines = sum(1 for r in raw if CANTONESE_RE.search(r.get("text", "")))
    dialect = "yue" if lang == "zh" and raw and (yue_lines >= 2 or yue_lines / float(len(raw)) >= 0.1) else ""
    info = _AsrInfo(lang, duration, round(merged.get(top, 0) / total, 3))
    info.dialect = dialect
    info.lang_share = {k: round(v / total, 2) for k, v in merged.items()}
    info.cantonese_lines = yue_lines
    return raw, info


def cmd_transcribe_and_translate(args):
    from faster_whisper import WhisperModel

    audio_path = args.audio
    if not audio_path or not os.path.exists(audio_path):
        return {"ok": False, "errorCode": "MISSING_AUDIO", "error": f"Không tìm thấy file âm thanh đã tách: {audio_path}"}

    asr_dir = args.asr_dir or ""
    sv_dir = getattr(args, "sv_dir", "") or ""
    whisper_ok = bool(asr_dir) and os.path.exists(os.path.join(asr_dir, "model.bin"))
    sv_ok = sensevoice_ready(sv_dir)
    if not whisper_ok and not sv_ok:
        return {
            "ok": False,
            "errorCode": "MISSING_ASR_MODEL",
            "error": "Chưa cài mô hình nhận dạng giọng nói (SenseVoiceSmall). Vui lòng cài trong mục 🧰 Công cụ.",
        }
    # Ngôn ngữ đầu vào người dùng chọn: auto | zh | en
    input_lang = (getattr(args, "input_lang", "auto") or "auto").strip().lower()[:4]
    english_mode = False
    model = None
    asr_engine = "whisper"
    if sv_ok and not (input_lang == "en" and whisper_ok):
        # SenseVoice mặc định. Video tiếng Anh: dùng module tiếng Anh của Whisper nếu máy còn Whisper (chuyên tiếng Anh).
        sv_raw, sv_info = transcribe_sensevoice(sv_dir, audio_path, input_lang)
        if sv_info.language == "en" and whisper_ok:
            asr_engine = "whisper"
            input_lang = "en"
        else:
            asr_engine = "sensevoice"
    if asr_engine == "whisper":
        model = WhisperModel(asr_dir, device="cpu", compute_type="int8", cpu_threads=4)
    if asr_engine == "sensevoice":
        segments_gen, info = [], sv_info
        english_mode = sv_info.language == "en"
    elif input_lang == "en":
        import asr_english

        segments_gen, info = asr_english.transcribe_english(model, audio_path)
        english_mode = True
    else:
        segments_gen, info = model.transcribe(
            audio_path,
            beam_size=4,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=350, speech_pad_ms=200),
            condition_on_previous_text=False,
            **({"language": "zh"} if input_lang in ("zh", "zh_d") else {}),
        )
    detected_lang0 = (getattr(info, "language", "") or "").lower()
    if asr_engine == "whisper" and not english_mode and input_lang == "auto" and detected_lang0.startswith("en"):
        # Tự động nhận ra tiếng Anh → dùng module tiếng Anh riêng (generator chưa chạy nên không tốn thêm lượt nhận dạng)
        import asr_english

        segments_gen, info = asr_english.transcribe_english(model, audio_path)
        english_mode = True
    # Whisper hay trộn chữ phồn thể/giản thể với tiếng Phổ thông. Ngôn ngữ đã được nhận diện trước khi giải mã
    # (generator chưa chạy), nên với "zh" ta tạo lại generator kèm gợi ý giản thể — không tốn thêm lượt nhận dạng.
    zh_prompt = "以下是普通话的句子，使用简体中文，带标点符号。"
    if input_lang == "zh_d":
        # Chỉ khi người dùng chọn "Tiếng Trung — phương ngữ": gợi ý từ vựng phương ngữ + tên video (đo trên video
        # tiếng Tứ Xuyên có nhạc nền: 55% → 64% chữ đúng). Không áp cho tiếng phổ thông.
        title = (getattr(args, "context_title", "") or "").strip()[:80]
        zh_prompt = (title + "。" if title else "") + "以下是方言（四川话等）的对话，使用简体中文书写，带标点符号。常用词：做啥子、晓得、没得、啥子、嘞、噻、嗦、脑壳、老子、巴适、要得、咋个、莫得。"
    if asr_engine == "whisper" and not english_mode and (input_lang in ("zh", "zh_d") or detected_lang0.startswith("zh")):
        segments_gen, info = model.transcribe(
            audio_path,
            beam_size=4,
            language="zh",
            initial_prompt=zh_prompt,
            hotwords="简体中文",
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=350, speech_pad_ms=200),
            condition_on_previous_text=False,
        )
    raw_list = list(sv_raw) if asr_engine == "sensevoice" else []
    total_dur = float(getattr(info, "duration", 0.0) or 0.0)
    for s in segments_gen:
        if total_dur > 0:
            emit_progress({"stage": "asr", "pos": round(float(s.end), 2), "total": round(total_dur, 2)})
        if getattr(s, "no_speech_prob", 0.0) > 0.88 and len((s.text or "").strip()) < 2:
            continue
        if english_mode:
            raw_list.extend(asr_english.split_english_segment(s))
        else:
            raw_list.extend(split_segment_by_sentences(s))

    # Nếu vad_filter quá chặt trên clip ngắn, thử lại không có vad_filter — NHƯNG chỉ khi VAD (ngưỡng nới lỏng)
    # vẫn thấy có tiếng nói. Không có bước này, Whisper "bịa" chữ trên nhạc/âm đơn (thấy trên CPU x86 Windows).
    speech_present = True
    if not raw_list and model is not None:
        try:
            from faster_whisper.audio import decode_audio
            from faster_whisper.vad import VadOptions, get_speech_timestamps

            _pcm = decode_audio(audio_path, sampling_rate=16000)
            speech_present = bool(
                get_speech_timestamps(_pcm, VadOptions(threshold=0.25, min_speech_duration_ms=150, speech_pad_ms=200))
            )
        except Exception:
            speech_present = True  # không kiểm tra được thì giữ hành vi cũ
    if not raw_list and speech_present and model is not None:
        segments_gen2, info2 = model.transcribe(
            audio_path,
            beam_size=3,
            vad_filter=False,
            no_speech_threshold=0.65,
            condition_on_previous_text=False,
            **({"language": "en"} if english_mode else {"language": "zh"} if input_lang in ("zh", "zh_d") else {}),
        )
        info = info2
        for s in segments_gen2:
            if getattr(s, "no_speech_prob", 0.0) > 0.85:
                continue
            # Đoạn độ tin cậy thấp hoặc lặp từ (dấu hiệu ảo giác) bị loại
            if getattr(s, "avg_logprob", 0.0) < -1.0 or getattr(s, "compression_ratio", 0.0) > 2.4:
                continue
            raw_list.append({"start": s.start, "end": s.end, "text": (s.text or "").strip()})

    if english_mode:
        import asr_english

        merged_segments = asr_english.merge_english_segments(raw_list, getattr(info, "duration", 0.0) or 0.0)
    else:
        merged_segments = merge_and_clean_asr_segments(raw_list, getattr(info, "duration", 0.0) or 0.0)
    merged_segments = refine_segment_starts(audio_path, merged_segments)
    total_chars = sum(len(x["sourceText"]) for x in merged_segments)
    if not merged_segments or total_chars < 1:
        return {
            "ok": False,
            "errorCode": "NO_SPEECH_DETECTED",
            "error": "Không nhận diện được lời thoại trong âm thanh của video (video chỉ có nhạc nền, tiếng động hoặc khoảng lặng).",
        }

    detected_code = (getattr(info, "language", None) or "zh").lower()[:2]
    detected_prob = round(float(getattr(info, "language_probability", 0.0) or 0.0), 3)
    target_lang = (args.target_lang or "vi").lower()[:2]
    cloud_consent = bool(int(args.cloud_consent or 0))
    trans_provider = (getattr(args, "translation_provider", "auto") or "auto").strip().lower()
    trans_style = (getattr(args, "translation_style", "natural") or "natural").strip().lower()
    cloud_model = (getattr(args, "cloud_model", "") or "").strip()
    cloud_base_url = (getattr(args, "cloud_base_url", "") or "").strip()

    source_texts = [seg["sourceText"] for seg in merged_segments]
    translated_texts = None
    translation_error = None
    translation_mode = ""
    used_cloud = False

    skip_translation = str(getattr(args, "skip_translation", "0") or "0") == "1"
    if skip_translation:
        translated_texts = ["" for _ in source_texts]
        translation_mode = "Chưa dịch (dịch ở bước AI Provider)"
    elif detected_code == target_lang:
        translated_texts = list(source_texts)
        translation_mode = f"Giữ nguyên lời thoại gốc ({detected_code.upper()})"
    else:
        translator = LocalArgosTranslator(args.argos_dir)
        whisper_en_bridge = None
        if model is not None and (detected_code in ("ja", "ko") or (
            detected_code == "zh" and not translator.has_pair("translate-zh_en-1_9")
        )) and not cloud_consent:
            try:
                en_gen, _ = model.transcribe(
                    audio_path, task="translate", beam_size=2, vad_filter=True, word_timestamps=True
                )
                en_segs = list(en_gen)
                whisper_en_bridge = align_bridge_by_time(merged_segments, en_segs)
            except Exception:
                whisper_en_bridge = None

        try:
            translated_texts, translation_mode, used_cloud = run_translation_pipeline(
                source_texts,
                detected_code,
                target_lang,
                args.argos_dir,
                cloud_consent=cloud_consent,
                provider=trans_provider,
                style=trans_style,
                segments=merged_segments,
                whisper_en_texts=whisper_en_bridge,
                cloud_model=cloud_model,
                cloud_base_url=cloud_base_url,
            )
        except Exception as err:
            # Giữ kết quả ASR để ứng dụng chạy tiếp từ bước dịch (không phải nhận dạng lại)
            translation_error = str(err)
            translated_texts = ["" for _ in source_texts]

    speaker_count = 1
    diar_info = None
    if str(getattr(args, "diarize", "0") or "0") == "1" and getattr(args, "diar_dir", ""):
        try:
            turns = run_speaker_diarization(
                audio_path,
                args.diar_dir,
                num_speakers=int(getattr(args, "num_speakers", -1) or -1),
                threshold=float(getattr(args, "diar_threshold", 0.8) or 0.8),
            )
            if turns:
                speaker_count = assign_speakers_to_segments(merged_segments, turns)
                diar_info = {"ok": True, "speakers": speaker_count, "turns": len(turns)}
            else:
                diar_info = {"ok": False, "error": "Thiếu mô hình phân tách người nói hoặc không tìm thấy lượt nói."}
        except Exception as diar_err:  # noqa: BLE001
            diar_info = {"ok": False, "error": f"Phân tách người nói lỗi: {diar_err}"}

    final_segments = []
    untranslated_ids = []
    for idx, seg in enumerate(merged_segments):
        trans = (translated_texts[idx] if idx < len(translated_texts) else "").strip()
        if not trans and not skip_translation:
            untranslated_ids.append(idx + 1)
        final_segments.append(
            {
                "index": idx + 1,
                "id": idx + 1,
                "speakerId": seg.get("speakerId", "speaker_1"),
                "startSec": seg["startSec"],
                "endSec": seg["endSec"],
                "sourceText": seg["sourceText"],
                "translatedText": trans,
            }
        )

    model_name = os.path.basename(asr_dir.rstrip("/\\")) if asr_dir else ""
    result = {
        "ok": True,
        "detectedSourceLang": detected_code,
        "languageProbability": detected_prob,
        "sourceLang": {
            "code": detected_code,
            "name": LANG_NAMES.get(detected_code, f"Ngôn ngữ ({detected_code})"),
            "probability": detected_prob,
        },
        "totalDuration": round(float(getattr(info, "duration", 0.0) or 0.0), 2),
        "asrModelUsed": (
            f"SenseVoiceSmall (int8 CPU Local, chia câu theo khoảng ngừng){' • tiếng Anh' if english_mode else ''}"
            if asr_engine == "sensevoice"
            else f"Faster-Whisper ({model_name}, int8 CPU Local){' • module tiếng Anh' if english_mode else ''}"
        ),
        "asrEngine": asr_engine,
        "sourceDialect": getattr(info, "dialect", "") or "",
        "languageShare": getattr(info, "lang_share", None),
        "inputLangMode": input_lang,
        "englishModule": english_mode,
        "translationMode": translation_mode,
        "usedCloudTranslation": used_cloud,
        "speakerCount": speaker_count,
        "untranslatedIds": untranslated_ids,
        "diarization": diar_info,
        "segments": final_segments,
    }
    partial = dict(result, segments=[dict(x, translatedText="") for x in final_segments], untranslatedIds=[])
    if translation_error is not None:
        return {"ok": False, "errorCode": "TRANSLATION_FAILED", "error": translation_error, "partialAsr": partial}
    if untranslated_ids and len(untranslated_ids) == len(merged_segments):
        return {
            "ok": False,
            "errorCode": "EMPTY_TRANSLATION",
            "error": "Không dịch được đoạn thoại nào bằng bộ dịch đã chọn. Hãy dùng bộ dịch AI/Google hoặc nhập lời dịch thủ công.",
            "partialAsr": partial,
        }
    return result


def cmd_ocr_subtitles(args):
    """Đọc phụ đề cứng tiếng Trung trong hình video (PP-OCRv4 ONNX, chỉ vùng phụ đề)."""
    import subtitle_ocr as so

    lang = so.set_sub_lang(getattr(args, "sub_lang", "zh"))
    try:
        ocr = so.SubtitleOCR(args.models, lang=lang)
    except RuntimeError as err:
        return {"ok": False, "errorCode": "MISSING_OCR_EN", "error": str(err)}
    try:
        so.set_params(json.loads(args.params) if args.params else {})
    except ValueError:
        so.set_params({})
    if args.mode == "probe":
        return so.probe(ocr, args.ffmpeg, args.video, samples=int(args.samples or 24))
    if args.mode == "frame":
        return so.analyze_frame(ocr, args.ffmpeg, args.video, float(args.at or 0))
    return so.extract(
        ocr,
        args.ffmpeg,
        args.video,
        fps=float(args.fps) if args.fps else so.PARAMS["fps"],
        on_progress=lambda t, d: emit_progress({"stage": "ocr", "pos": round(t, 2), "total": round(d, 2)}),
    )


def cmd_translate_batch(args):
    payload = load_payload(args)
    texts = payload.get("texts") or []
    source_lang = (payload.get("sourceLang") or "zh").lower()[:2]
    target_lang = (payload.get("targetLang") or "vi").lower()[:2]
    cloud_consent = bool(payload.get("cloudConsent", False))
    provider = (payload.get("translationProvider") or "auto").strip().lower()
    style = (payload.get("translationStyle") or "natural").strip().lower()
    segments = payload.get("segments")
    cloud_model = (payload.get("cloudModel") or "").strip()
    cloud_base_url = (payload.get("cloudBaseUrl") or "").strip()

    if not texts:
        return {"ok": True, "translations": [], "mode": "Empty"}

    try:
        out, mode, used_cloud = run_translation_pipeline(
            texts,
            source_lang,
            target_lang,
            args.argos_dir,
            cloud_consent=cloud_consent,
            provider=provider,
            style=style,
            segments=segments,
            cloud_model=cloud_model,
            cloud_base_url=cloud_base_url,
        )
        return {"ok": True, "translations": out, "mode": mode, "usedCloud": used_cloud}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def cmd_separate_background(args):
    """Tách giọng nói khỏi nhạc nền/tiếng động (Spleeter 2-stems, sherpa-onnx, offline).

    Đầu vào: WAV PCM16 stereo 44.1 kHz. Đầu ra: WAV nền (accompaniment) cùng độ dài, để trộn thay cho
    âm thanh gốc -> người xem không còn nghe giọng gốc nói chồng lên giọng lồng tiếng.
    Xử lý theo khúc 30 s, chồng 1 s và crossfade để bộ nhớ không phụ thuộc độ dài video.
    """
    import sherpa_onnx

    model_dir = args.model_dir
    voc = os.path.join(model_dir, "vocals.fp16.onnx")
    acc = os.path.join(model_dir, "accompaniment.fp16.onnx")
    if not (os.path.exists(voc) and os.path.exists(acc)):
        return {"ok": False, "error": "Thiếu mô hình tách giọng Spleeter (vocals/accompaniment)."}
    cfg = sherpa_onnx.OfflineSourceSeparationConfig(
        model=sherpa_onnx.OfflineSourceSeparationModelConfig(
            spleeter=sherpa_onnx.OfflineSourceSeparationSpleeterModelConfig(vocals=voc, accompaniment=acc),
            num_threads=4,
        )
    )
    if not cfg.validate():
        return {"ok": False, "error": "Cấu hình mô hình tách giọng không hợp lệ."}
    sep = sherpa_onnx.OfflineSourceSeparation(cfg)

    with wave.open(args.input, "rb") as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        total = wf.getnframes()
        if ch != 2 or wf.getsampwidth() != 2:
            return {"ok": False, "error": "Đầu vào tách giọng phải là WAV PCM16 stereo."}
        chunk = sr * 30
        overlap = sr * 1
        out = wave.open(args.output, "wb")
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(sr)
        prev_tail = None  # phần chồng lấn (2, overlap) của khúc trước
        pos = 0
        while pos < total:
            wf.setpos(max(0, pos - (overlap if prev_tail is not None else 0)))
            start_read = wf.tell()
            n = min(total - start_read, chunk + (overlap if prev_tail is not None else 0))
            raw = wf.readframes(n)
            x = np.frombuffer(raw, dtype=np.int16).astype(np.float32).reshape(-1, 2).T / 32768.0
            res = sep.process(sample_rate=sr, samples=np.ascontiguousarray(x))
            stems = list(res.stems)  # [vocals, accompaniment]
            want = 0 if str(getattr(args, "stem", "accompaniment")) == "vocals" else 1
            stem = np.asarray(stems[want].data, dtype=np.float32) if len(stems) > want else np.asarray(stems[0].data, dtype=np.float32)
            if stem.ndim == 1:
                stem = np.vstack([stem, stem])
            stem = stem[:, : x.shape[1]]
            if prev_tail is not None:
                k = min(overlap, stem.shape[1], prev_tail.shape[1])
                fade = np.linspace(0.0, 1.0, k, dtype=np.float32)
                stem[:, :k] = prev_tail[:, :k] * (1.0 - fade) + stem[:, :k] * fade
            end_read = start_read + x.shape[1]
            if end_read < total:
                body, prev_tail = stem[:, :-overlap], stem[:, -overlap:]
            else:
                body, prev_tail = stem, None
            pcm = (np.clip(body.T, -1.0, 1.0) * 32767.0).astype(np.int16)
            out.writeframes(pcm.tobytes())
            pos = end_read
            emit_progress({"stage": "separate", "pos": round(pos / sr, 2), "total": round(total / sr, 2)})
            if prev_tail is None:
                break
        out.close()
    return {"ok": True, "output": args.output, "durationSec": round(total / float(sr), 2)}


def write_pcm16_wav(output_path, samples, sample_rate):
    arr = np.asarray(samples, dtype=np.float32)
    arr = np.clip(arr, -1.0, 1.0)
    pcm16 = (arr * 32767.0).astype(np.int16)
    with wave.open(output_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16.tobytes())


def cmd_tts_synthesize(args):
    text = (args.text or "").strip()
    if not text:
        return {"ok": False, "error": "Nội dung văn bản cần đọc trống."}

    engine = args.engine
    output_wav = args.output

    if engine == "sherpa-piper":
        import sherpa_onnx

        model_dir = args.model_dir
        onnx_file = args.onnx_file
        onnx_path = os.path.join(model_dir, onnx_file)
        tokens_path = os.path.join(model_dir, "tokens.txt")
        data_dir = os.path.join(model_dir, "espeak-ng-data")
        if not os.path.exists(onnx_path) or not os.path.exists(tokens_path):
            return {
                "ok": False,
                "error": f"Thiếu file mô hình giọng đọc Local TTS tại: {model_dir}. Vui lòng tải mô hình trong mục Công cụ.",
            }

        tts_cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=onnx_path,
                    tokens=tokens_path,
                    data_dir=data_dir if os.path.exists(data_dir) else "",
                ),
                num_threads=2,
            )
        )
        tts = sherpa_onnx.OfflineTts(tts_cfg)
        sid = int(args.speaker_id or 0)
        speed = float(args.speed or 1.0)
        audio = tts.generate(text, sid=sid, speed=speed)
        if not audio.samples or len(audio.samples) < 100 or audio.sample_rate <= 0:
            return {"ok": False, "error": "Mô hình TTS không sinh được dữ liệu âm thanh hợp lệ."}
        write_pcm16_wav(output_wav, audio.samples, audio.sample_rate)
        return {
            "ok": True,
            "outputWav": output_wav,
            "sampleRate": audio.sample_rate,
            "duration": round(len(audio.samples) / float(audio.sample_rate), 2),
        }

    elif engine == "edge-tts":
        if not bool(int(args.cloud_consent or 0)):
            return {
                "ok": False,
                "error": "Giọng đọc Cloud Neural yêu cầu bạn bật xác nhận cho phép gửi văn bản lên dịch vụ đám mây.",
            }
        import edge_tts

        voice_name = args.voice_arg or "vi-VN-HoaiMyNeural"
        temp_mp3 = output_wav + ".mp3"

        async def _run_edge():
            comm = edge_tts.Communicate(text, voice_name)
            await comm.save(temp_mp3)

        asyncio.run(_run_edge())
        if not os.path.exists(temp_mp3) or os.path.getsize(temp_mp3) < 128:
            return {"ok": False, "error": "Không nhận được dữ liệu âm thanh từ dịch vụ Edge Cloud TTS."}
        return {"ok": True, "outputMp3": temp_mp3}

    return {"ok": False, "error": f"Engine TTS không hợp lệ: {engine}"}


def cmd_tts_batch(args):
    payload = load_payload(args)
    engine = payload.get("engine") or "sherpa-piper"
    items = payload.get("items") or []
    if not items:
        return {"ok": True, "outputs": []}

    if engine == "sherpa-piper":
        import sherpa_onnx

        model_dir = payload.get("modelDir") or ""
        onnx_file = payload.get("onnxFile") or ""
        onnx_path = os.path.join(model_dir, onnx_file)
        tokens_path = os.path.join(model_dir, "tokens.txt")
        data_dir = os.path.join(model_dir, "espeak-ng-data")
        if not os.path.exists(onnx_path) or not os.path.exists(tokens_path):
            return {
                "ok": False,
                "error": f"Thiếu file mô hình giọng đọc Local TTS tại: {model_dir}. Vui lòng tải mô hình trong mục Công cụ.",
            }

        tts_cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=onnx_path,
                    tokens=tokens_path,
                    data_dir=data_dir if os.path.exists(data_dir) else "",
                ),
                num_threads=2,
            )
        )
        tts = sherpa_onnx.OfflineTts(tts_cfg)
        sid = int(payload.get("speakerId", 0) or 0)
        speed = float(payload.get("speed", 1.0) or 1.0)
        outputs = []
        for idx, item in enumerate(items):
            text = (item.get("text") or "").strip()
            output_wav = item.get("outputWav")
            if not text or not output_wav:
                return {"ok": False, "error": f"Đoạn số {idx + 1} thiếu văn bản hoặc đường dẫn file đầu ra."}
            audio = tts.generate(text, sid=sid, speed=speed)
            if not audio.samples or len(audio.samples) < 100 or audio.sample_rate <= 0:
                return {"ok": False, "error": f"Mô hình TTS không sinh được âm thanh cho đoạn số {idx + 1}."}
            write_pcm16_wav(output_wav, audio.samples, audio.sample_rate)
            emit_progress({"stage": "tts", "done": idx + 1, "total": len(items)})
            outputs.append(
                {
                    "index": item.get("index", idx + 1),
                    "outputWav": output_wav,
                    "sampleRate": audio.sample_rate,
                    "duration": round(len(audio.samples) / float(audio.sample_rate), 2),
                }
            )
        return {"ok": True, "outputs": outputs}

    elif engine == "edge-tts":
        if not bool(payload.get("cloudConsent", False)):
            return {
                "ok": False,
                "error": "Giọng đọc Cloud Neural yêu cầu bạn bật xác nhận cho phép gửi văn bản lên dịch vụ đám mây.",
            }
        import edge_tts

        voice_name = payload.get("voiceArg") or "vi-VN-HoaiMyNeural"
        outputs = []

        async def _run_batch_edge():
            for idx, item in enumerate(items):
                text = (item.get("text") or "").strip()
                output_mp3 = item.get("outputMp3")
                if not text or not output_mp3:
                    raise RuntimeError(f"Đoạn số {idx + 1} thiếu văn bản hoặc đường dẫn file đầu ra.")
                comm = edge_tts.Communicate(text, voice_name)
                await comm.save(output_mp3)
                if not os.path.exists(output_mp3) or os.path.getsize(output_mp3) < 128:
                    raise RuntimeError(f"Không nhận được âm thanh Cloud TTS cho đoạn số {idx + 1}.")
                outputs.append({"index": item.get("index", idx + 1), "outputMp3": output_mp3})

        asyncio.run(_run_batch_edge())
        return {"ok": True, "outputs": outputs}

    return {"ok": False, "error": f"Engine TTS không hợp lệ: {engine}"}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")

    p_asr = sub.add_parser("transcribe_and_translate")
    p_asr.add_argument("--audio", required=True)
    p_asr.add_argument("--asr-dir", default="")
    p_asr.add_argument("--sv-dir", default="")
    p_asr.add_argument("--argos-dir", required=True)
    p_asr.add_argument("--target-lang", default="vi")
    p_asr.add_argument("--cloud-consent", default="0")
    p_asr.add_argument("--translation-provider", default="auto")
    p_asr.add_argument("--translation-style", default="natural")
    p_asr.add_argument("--cloud-model", default="")
    p_asr.add_argument("--cloud-base-url", default="")
    p_asr.add_argument("--skip-translation", default="0")
    p_asr.add_argument("--input-lang", default="auto")
    p_asr.add_argument("--context-title", default="")
    p_asr.add_argument("--diarize", default="0")
    p_asr.add_argument("--diar-dir", default="")
    p_asr.add_argument("--num-speakers", default="-1")
    p_asr.add_argument("--diar-threshold", default="0.8")

    p_tr = sub.add_parser("translate_batch")
    p_tr.add_argument("--argos-dir", required=True)
    p_tr.add_argument("--payload-json", default="")
    p_tr.add_argument("--payload-file", default="")

    p_tts = sub.add_parser("tts_synthesize")
    p_tts.add_argument("--engine", required=True)
    p_tts.add_argument("--model-dir", default="")
    p_tts.add_argument("--onnx-file", default="")
    p_tts.add_argument("--speaker-id", default="0")
    p_tts.add_argument("--speed", default="1.0")
    p_tts.add_argument("--voice-arg", default="")
    p_tts.add_argument("--cloud-consent", default="0")
    p_tts.add_argument("--text", required=True)
    p_tts.add_argument("--output", required=True)

    p_ocr = sub.add_parser("ocr_subtitles")
    p_ocr.add_argument("--video", required=True)
    p_ocr.add_argument("--models", required=True)
    p_ocr.add_argument("--ffmpeg", required=True)
    p_ocr.add_argument("--mode", default="extract")
    p_ocr.add_argument("--fps", default="")
    p_ocr.add_argument("--samples", default="24")
    p_ocr.add_argument("--params", default="")
    p_ocr.add_argument("--at", default="0")
    p_ocr.add_argument("--sub-lang", default="zh")

    p_sep = sub.add_parser("separate_background")
    p_sep.add_argument("--input", required=True)
    p_sep.add_argument("--output", required=True)
    p_sep.add_argument("--model-dir", required=True)
    p_sep.add_argument("--stem", default="accompaniment")

    p_ttsb = sub.add_parser("tts_batch")
    p_ttsb.add_argument("--payload-json", default="")
    p_ttsb.add_argument("--payload-file", default="")

    args = parser.parse_args()
    try:
        if args.cmd == "transcribe_and_translate":
            res = cmd_transcribe_and_translate(args)
        elif args.cmd == "translate_batch":
            res = cmd_translate_batch(args)
        elif args.cmd == "tts_synthesize":
            res = cmd_tts_synthesize(args)
        elif args.cmd == "tts_batch":
            res = cmd_tts_batch(args)
        elif args.cmd == "separate_background":
            res = cmd_separate_background(args)
        elif args.cmd == "ocr_subtitles":
            res = cmd_ocr_subtitles(args)
        else:
            res = {"ok": False, "error": f"Lệnh không hợp lệ: {args.cmd}"}
    except Exception as exc:
        res = {"ok": False, "error": str(exc)}

    sys.stdout.write("WORKER_JSON:" + json.dumps(res, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()

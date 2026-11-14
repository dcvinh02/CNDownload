#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VieNeu-TTS worker (tiến trình chạy lâu, giao tiếp JSON theo dòng qua stdin/stdout).

Chạy bằng môi trường Python riêng `.venv-vieneu` (VieNeu-TTS yêu cầu Python >= 3.10),
dùng SDK chính thức `vieneu` (https://github.com/pnnbao97/VieNeu-TTS), chế độ v3 Turbo 48 kHz
chạy ONNX Runtime trên CPU (không cần GPU, không cần PyTorch).

Giao thức:
  Worker in ra:  VN_JSON:{"event":"ready","voices":[[label,id],...],"defaultVoice":"...","sampleRate":48000,"loadSec":...}
  Node gửi:      {"id":"r1","cmd":"synthesize","items":[{"text":"...","voice":"...","output":"/path.wav"}]}
  Worker in ra:  VN_JSON:{"id":"r1","event":"progress","done":1,"total":3}
                 VN_JSON:{"id":"r1","event":"result","ok":true,"outputs":[{"output":"...","duration":2.31}]}
  Lỗi:           VN_JSON:{"id":"r1","event":"result","ok":false,"error":"..."}
Mọi log khác của thư viện đi ra stderr.
"""

import argparse
import json
import os
import sys
import time
import traceback


def emit(obj):
    sys.__stdout__.write("VN_JSON:" + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.__stdout__.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", default="v3turbo")
    parser.add_argument("--precision", default="fp32")
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--voices-cache", default="")
    args = parser.parse_args()

    # Thư viện có thể in ra stdout -> chuyển hướng toàn bộ print() sang stderr, chỉ giao thức dùng __stdout__
    sys.stdout = sys.stderr

    t0 = time.time()
    try:
        from vieneu import Vieneu

        kwargs = {}
        if args.mode == "v3turbo":
            kwargs["precision"] = args.precision
            if args.threads > 0:
                kwargs["threads"] = args.threads
        tts = Vieneu(mode=args.mode, **kwargs)
        voices = [[str(label), str(vid)] for label, vid in tts.list_preset_voices()]
        default_voice = getattr(tts, "_default_voice", None) or (voices[0][1] if voices else "")
    except Exception as exc:  # noqa: BLE001
        emit({"event": "fatal", "error": f"Không nạp được VieNeu-TTS: {exc}", "trace": traceback.format_exc()[-1500:]})
        return 2

    sample_rate = int(getattr(tts, "sample_rate", 48000) or 48000)
    ready = {
        "event": "ready",
        "voices": voices,
        "defaultVoice": default_voice,
        "sampleRate": sample_rate,
        "mode": args.mode,
        "precision": args.precision,
        "loadSec": round(time.time() - t0, 2),
    }
    if args.voices_cache:
        try:
            with open(args.voices_cache, "w", encoding="utf-8") as fh:
                json.dump({**ready, "cachedAt": time.time()}, fh, ensure_ascii=False, indent=1)
        except Exception:  # noqa: BLE001
            pass
    emit(ready)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            cmd = req.get("cmd")
            if cmd == "ping":
                emit({"id": req_id, "event": "result", "ok": True})
                continue
            if cmd == "shutdown":
                emit({"id": req_id, "event": "result", "ok": True})
                break
            if cmd != "synthesize":
                emit({"id": req_id, "event": "result", "ok": False, "error": f"Lệnh không hợp lệ: {cmd}"})
                continue

            items = req.get("items") or []
            outputs = []
            for idx, item in enumerate(items):
                text = str(item.get("text") or "").strip()
                out_path = item.get("output")
                voice = item.get("voice") or default_voice
                if not text or not out_path:
                    raise ValueError(f"Đoạn số {idx + 1} thiếu văn bản hoặc đường dẫn đầu ra.")
                t1 = time.time()
                audio = tts.infer(text, voice=voice)
                if audio is None or len(audio) < 200:
                    raise RuntimeError(f"VieNeu-TTS không sinh được âm thanh cho đoạn số {idx + 1}.")
                tts.save(audio, out_path)
                outputs.append(
                    {
                        "output": out_path,
                        "duration": round(len(audio) / float(sample_rate), 3),
                        "synthSec": round(time.time() - t1, 3),
                    }
                )
                emit({"id": req_id, "event": "progress", "done": idx + 1, "total": len(items)})
            emit({"id": req_id, "event": "result", "ok": True, "outputs": outputs})
        except Exception as exc:  # noqa: BLE001
            emit({"id": req_id, "event": "result", "ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    sys.exit(main())

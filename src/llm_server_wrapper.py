#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bọc máy chủ LLM cục bộ (`mlx_lm server` trên Mac, `llama-server.exe` trên Windows) để nó KHÔNG BAO GIỜ mồ côi.

Node giữ một pipe stdin mở tới wrapper. Khi ứng dụng Node thoát (kể cả bị tắt đột ngột / crash),
pipe bị đóng -> wrapper đọc được EOF -> dừng máy chủ MLX (SIGTERM, sau 3 giây SIGKILL) và giải phóng RAM/GPU.

Dùng: python llm_server_wrapper.py <các tham số của mlx_lm server ...>
      python llm_server_wrapper.py --exec <đường dẫn llama-server> <tham số ...>
"""

import os
import signal
import subprocess
import sys
import threading


def main():
    argv = sys.argv[1:]
    if argv[:1] == ["--exec"] and len(argv) >= 2:
        cmd = argv[1:]
    else:
        cmd = [sys.executable, "-m", "mlx_lm", "server", *argv]
    # Windows: không mở cửa sổ console riêng cho máy chủ
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    child = subprocess.Popen(cmd, creationflags=flags)

    def shutdown(*_):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
        os._exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    def watch_parent():
        try:
            while sys.stdin.buffer.read(1):
                pass
        except Exception:  # noqa: BLE001
            pass
        shutdown()

    threading.Thread(target=watch_parent, daemon=True).start()
    code = child.wait()
    os._exit(code)


if __name__ == "__main__":
    main()

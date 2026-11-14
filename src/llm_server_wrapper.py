#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bọc máy chủ `mlx_lm server` để nó KHÔNG BAO GIỜ mồ côi.

Node giữ một pipe stdin mở tới wrapper. Khi ứng dụng Node thoát (kể cả bị tắt đột ngột / crash),
pipe bị đóng -> wrapper đọc được EOF -> dừng máy chủ MLX (SIGTERM, sau 3 giây SIGKILL) và giải phóng RAM/GPU.

Dùng: python llm_server_wrapper.py <các tham số của mlx_lm server ...>
"""

import os
import signal
import subprocess
import sys
import threading


def main():
    child = subprocess.Popen([sys.executable, "-m", "mlx_lm", "server", *sys.argv[1:]])

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

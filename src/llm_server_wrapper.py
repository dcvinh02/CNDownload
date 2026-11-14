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


_JOB = None  # giữ handle Job Object suốt đời wrapper


def _kill_child_with_wrapper(proc):
    """
    Windows: gắn máy chủ con vào một Job Object có cờ KILL_ON_JOB_CLOSE. Khi wrapper kết thúc theo BẤT KỲ cách nào
    (bị TerminateProcess, đóng cửa sổ console, crash), hệ điều hành đóng handle và tự diệt máy chủ con —
    không còn llama-server mồ côi giữ ~6 GB RAM. (POSIX dùng tín hiệu + EOF stdin như cũ.)
    """
    global _JOB
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in ("r", "w", "o", "rb", "wb", "ob")]

        class BASIC(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class EXTENDED(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BASIC),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        job = k32.CreateJobObjectW(None, None)
        info = EXTENDED()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok1 = k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))  # JobObjectExtendedLimitInformation
        ok2 = k32.AssignProcessToJobObject(job, wintypes.HANDLE(int(proc._handle)))
        if ok1 and ok2:
            _JOB = job
        else:
            sys.stderr.write(f"[wrapper] Không gắn được Job Object (lỗi {ctypes.get_last_error()})\n")
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"[wrapper] Job Object lỗi: {exc}\n")


_NTSTATUS = {
    0xC0000135: "thiếu DLL (thường là Microsoft Visual C++ Redistributable 2015–2022)",
    0xC0000005: "truy cập bộ nhớ không hợp lệ (thường do driver GPU/Vulkan)",
    0xC000001D: "CPU không hỗ trợ tập lệnh của bản dựng",
    0xC0000409: "tiến trình tự hủy (abort) — xem các dòng log phía trên",
    0xC0000017: "không đủ bộ nhớ",
    0xC000012D: "không đủ bộ nhớ ảo (RAM + pagefile)",
}


def _describe_exit(code):
    if os.name != "nt":
        return f"tín hiệu {-code}" if code < 0 else str(code)
    u = code & 0xFFFFFFFF
    if u >= 0xC0000000:
        return f"0x{u:08X} — {_NTSTATUS.get(u, 'lỗi hệ thống Windows')}"
    return str(code)


def _exit(code):
    # os._exit chỉ nhận số nguyên có dấu 32-bit: mã NTSTATUS (vd. 0xC0000135) phải đổi về mã ngắn.
    os._exit(code if 0 <= code <= 255 else 1)


def main():
    argv = sys.argv[1:]
    if argv[:1] == ["--exec"] and len(argv) >= 2:
        cmd = argv[1:]
    else:
        cmd = [sys.executable, "-m", "mlx_lm", "server", *argv]
    # Windows: không mở cửa sổ console riêng cho máy chủ
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    child = subprocess.Popen(cmd, creationflags=flags)
    _kill_child_with_wrapper(child)

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
    if code != 0:
        sys.stderr.write(f"[wrapper] Máy chủ LLM dừng với mã {_describe_exit(code)}\n")
        sys.stderr.flush()
    _exit(code)


if __name__ == "__main__":
    try:
        main()
    except BaseException as exc:  # noqa: BLE001 — luôn thoát bằng os._exit để luồng đọc stdin không làm Python sập khi thoát
        import traceback

        sys.stderr.write("[wrapper] Lỗi: " + "".join(traceback.format_exception_only(type(exc), exc)))
        sys.stderr.flush()
        os._exit(1)

#!/usr/bin/env python3
"""
Tạo lại bộ icon ứng dụng từ assets/icon-1024.png (ảnh vuông, nền ngoài khung trong suốt):
  public/icon.png (512)                         — giao diện, favicon, cửa sổ app macOS
  public/icon.ico (16–256)                      — lối tắt Desktop Windows, favicon
  CNVideoScraperPro.app/Contents/Resources/AppIcon.icns — gói .app macOS (cần iconutil trên macOS)

Chạy:  <python có Pillow> scripts/build_icons.py     (vd. .venv-vieneu/bin/python3 scripts/build_icons.py)
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "icon-1024.png")


def fit(img, size, fill):
    c = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * fill)
    c.paste(img.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
    return c


def main():
    src = Image.open(SRC).convert("RGBA")
    bbox = src.split()[3].getbbox()
    art = src.crop(bbox)
    side = max(art.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(art, ((side - art.size[0]) // 2, (side - art.size[1]) // 2))

    full = fit(sq, 1024, 0.96)
    full.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, "public", "icon.png"), optimize=True)
    full.save(os.path.join(ROOT, "public", "icon.ico"), sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])

    if sys.platform == "darwin" and shutil.which("iconutil"):
        mac = fit(sq, 1024, 0.82)  # lưới icon macOS ~824/1024
        with tempfile.TemporaryDirectory() as tmp:
            iset = os.path.join(tmp, "AppIcon.iconset")
            os.makedirs(iset)
            for b in (16, 32, 128, 256, 512):
                mac.resize((b, b), Image.LANCZOS).save(os.path.join(iset, f"icon_{b}x{b}.png"))
                mac.resize((b * 2, b * 2), Image.LANCZOS).save(os.path.join(iset, f"icon_{b}x{b}@2x.png"))
            out = os.path.join(ROOT, "CNVideoScraperPro.app", "Contents", "Resources", "AppIcon.icns")
            subprocess.run(["iconutil", "-c", "icns", iset, "-o", out], check=True)
    print("Đã tạo lại icon.")


if __name__ == "__main__":
    main()

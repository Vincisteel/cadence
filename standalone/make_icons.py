#!/usr/bin/env python3
"""Generate the Android/PWA icon set for Cadence.

Brand: three rising waveform bars on a violet→cyan gradient, dark rounded tile.
Maskable variants keep everything inside the 80% safe zone Android crops to.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent / "icons"
OUT.mkdir(exist_ok=True)

S = 1024
VIOLET = (139, 92, 246)
CYAN = (34, 211, 238)
BG = (10, 10, 18)


def gradient(size, c1, c2):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for i in range(size):
        t = i / max(1, size - 1)
        d.line([(0, i), (size, i)], fill=tuple(int(c1[k] + (c2[k] - c1[k]) * t) for k in range(3)))
    return img


def bars(draw, size, scale=1.0, color=(255, 255, 255, 240)):
    """Three rounded bars of increasing height, centred."""
    cx, cy = size / 2, size / 2
    bar_w = size * 0.088 * scale
    gap = size * 0.055 * scale
    heights = [0.34, 0.52, 0.42]
    total = 3 * bar_w + 2 * gap
    x = cx - total / 2
    for h in heights:
        bh = size * h * scale
        r = bar_w / 2
        draw.rounded_rectangle([x, cy - bh / 2, x + bar_w, cy + bh / 2], radius=r, fill=color)
        x += bar_w + gap


def tile(size, maskable=False):
    pad = int(size * 0.10) if maskable else 0
    inner = size - 2 * pad
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if maskable:
        img.paste(Image.new("RGBA", (size, size), BG + (255,)), (0, 0))

    grad = gradient(inner, VIOLET, CYAN).convert("RGBA")
    # darken the gradient a little so white bars read clearly
    overlay = Image.new("RGBA", (inner, inner), (8, 8, 14, 120))
    grad = Image.alpha_composite(grad, overlay)

    if maskable:
        img.paste(grad, (pad, pad))
    else:
        mask = Image.new("L", (inner, inner), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, inner - 1, inner - 1], radius=int(inner * 0.22), fill=255)
        img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    bars(d, inner, scale=0.92, color=(255, 255, 255, 245)) if not maskable else None
    if maskable:
        layer = Image.new("RGBA", (inner, inner), (0, 0, 0, 0))
        bars(ImageDraw.Draw(layer), inner, scale=0.78, color=(255, 255, 255, 245))
        img.paste(layer, (pad, pad), layer)
    return img


def save(img, name):
    img.save(OUT / name, optimize=True)
    print(f"  {name:32s} {img.size[0]}×{img.size[1]}")


print("icons →")
save(tile(S), "icon-1024.png")
for s in (512, 192, 180, 128, 96):
    save(tile(S).resize((s, s), Image.LANCZOS), f"icon-{s}.png")
save(tile(S, maskable=True).resize((512, 512), Image.LANCZOS), "icon-maskable-512.png")
save(tile(S).resize((180, 180), Image.LANCZOS), "apple-touch-icon.png")
# favicon
save(tile(S).resize((64, 64), Image.LANCZOS), "favicon-64.png")
print("done")

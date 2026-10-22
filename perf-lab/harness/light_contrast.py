"""Contrast of the community palette against both backgrounds (WCAG 2.1 relative luminance).

  python harness/light_contrast.py
"""
import io, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, REPO)
from graphify.exporters.base import COMMUNITY_COLORS

DARK_BG = "#0f0f1a"
LIGHT_BG = "#ffffff"


def lum(hexc):
    h = hexc.lstrip("#")
    if len(h) == 3:
        h = h[0] * 2 + h[1] * 2 + h[2] * 2
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


print("%-10s %8s %8s   %s" % ("colour", "on dark", "on white", "verdict (light needs >= 3.0)"))
for c in COMMUNITY_COLORS:
    d, l = ratio(c, DARK_BG), ratio(c, LIGHT_BG)
    print("%-10s %8.2f %8.2f   %s" % (c, d, l, "ok" if l >= 3.0 else "TOO FAINT on white"))

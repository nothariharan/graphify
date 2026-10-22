"""Derive a light-background palette from the dark one: same hue, darker shade, every
colour clears 4.5:1 contrast on white (WCAG 2.1).

  python harness/light_palette.py
"""
import colorsys
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, REPO)
from graphify.exporters.base import COMMUNITY_COLORS

WHITE = "#ffffff"


def lum(hexc):
    h = hexc.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def ratio_on_white(hexc):
    return 1.05 / (lum(hexc) + 0.05)


def to_hex(r, g, b):
    return "#%02X%02X%02X" % (round(r * 255), round(g * 255), round(b * 255))


out = []
for c in COMMUNITY_COLORS:
    h = c.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    hh, ll, ss = colorsys.rgb_to_hls(r, g, b)
    best = None
    # walk the lightness down until the colour clears the target on white
    for step in range(0, 100):
        l2 = ll - step * 0.01
        if l2 <= 0.05:
            break
        rr, gg, bb = colorsys.hls_to_rgb(hh, l2, ss)
        hexc = to_hex(rr, gg, bb)
        if ratio_on_white(hexc) >= 4.6:
            best = (hexc, l2, ratio_on_white(hexc))
            break
    if best is None:
        best = (c, ll, ratio_on_white(c))
    out.append(best[0])
    print("%-10s -> %-10s  L %.2f -> %.2f   contrast on white %.2f" %
          (c, best[0], ll, best[1], best[2]))

print()
print("COMMUNITY_COLORS_LIGHT = [")
for i in range(0, len(out), 5):
    print("    " + ", ".join('"%s"' % x for x in out[i:i + 5]) + ",")
print("]")

"""Shared constants/helpers for the graphify exporters package.

Symbols used by more than one exporter live here so each exporter module can be
split out of graphify/export.py without a circular import (export.py and the
per-format modules both import from here, never from each other).
"""
from __future__ import annotations

# Categorical palette for community coloring, shared by the HTML, SVG, and
# Obsidian exporters. Moved verbatim from graphify/export.py.
#
# This is the palette in BOTH themes. A darkened light-theme variant was tried (the ten
# hues with the lightness walked down until every one cleared 4.6:1 on white) and the user
# rejected it: on white the original colours are the ones that look right, even though five
# of them are below the 3:1 contrast ratio there (yellow #EDC948 is 1.61:1). What did need
# fixing in light mode was everything around the nodes - the edges, the selection ring and
# the dimming - and those are theme values now (see _html_styles).
COMMUNITY_COLORS = [
    "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
    "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
]

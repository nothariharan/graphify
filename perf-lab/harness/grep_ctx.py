"""Print the source context around a token in a minified file.

  python harness/grep_ctx.py data/vis-network.min.js smooth 200 6
"""
import io
import re
import sys

path, token = sys.argv[1], sys.argv[2]
width = int(sys.argv[3]) if len(sys.argv) > 3 else 160
limit = int(sys.argv[4]) if len(sys.argv) > 4 else 6

s = io.open(path, encoding="utf-8", errors="replace").read()
print(f"{path}: {len(s)} chars, {s.count(token)} occurrences of {token!r}")
for n, m in enumerate(re.finditer(re.escape(token), s)):
    if n >= limit:
        print(f"... ({s.count(token) - limit} more)")
        break
    a = max(0, m.start() - width)
    b = min(len(s), m.end() + width)
    print(f"\n--- #{n+1} @ {m.start()} ---")
    print(s[a:b].replace("\n", " "))

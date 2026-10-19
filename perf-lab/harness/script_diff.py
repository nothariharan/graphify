"""Show how two artifacts differ outside their data payload.

Prints differing lines (short ones only, so a minified JSON blob cannot flood the
output), which for a before/after pair should be exactly the perf levers.

  python harness/script_diff.py a.html b.html
"""
import io
import sys

a = io.open(sys.argv[1], encoding="utf-8").read().splitlines()
b = io.open(sys.argv[2], encoding="utf-8").read().splitlines()

print(f"{sys.argv[1]} -> {len(a)} lines")
print(f"{sys.argv[2]} -> {len(b)} lines")

sa, sb = {}, {}
for i, ln in enumerate(a):
    sa.setdefault(ln, []).append(i)
for i, ln in enumerate(b):
    sb.setdefault(ln, []).append(i)

only_a = [ln for ln in sa if ln not in sb]
only_b = [ln for ln in sb if ln not in sa]
print(f"\nlines only in A: {len(only_a)}   lines only in B: {len(only_b)}")

print("\n--- only in A (anything longer than 120 chars is a blob, counted not shown) ---")
shown = 0
for ln in only_a:
    if len(ln) <= 120:
        print("  A| " + ln)
        shown += 1
    if shown > 40:
        print("  ...")
        break

print("\n--- only in B ---")
shown = 0
for ln in only_b:
    if len(ln) <= 120:
        print("  B| " + ln)
        shown += 1
    if shown > 40:
        print("  ...")
        break

print(f"\nblob-length lines: A={sum(1 for l in only_a if len(l) > 120)} "
      f"B={sum(1 for l in only_b if len(l) > 120)}")

"""Build the L12 rest-batch variant from the shipped v8 artifact.

  python harness/mk_l12.py

Patches the in-page gesture JS (no exporter change until the lane wins):

  1. `_EDGE_BATCH` is installed once after load and stays installed, so the resting frame
     uses the batched edge pass too.
  2. The patched drawLine hands selected/hovered edges and arrow-bearing edges back to vis,
     because the batch draws lines only - no highlight width, no arrowhead.
  3. A DataSet '*' listener marks the cached groups dirty so hidden nodes / legend toggles
     take effect on the next frame.

Fails loudly if a patch anchor is missing, so a moved exporter is never silently unpatched.
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-v8.html")
OUT = os.path.join(LAB, "variants", "L12-rest-batch.html")

s = io.open(SRC, encoding="utf-8").read()   # universal newlines: anchors are LF
if "rest-batch" in s:
    raise SystemExit("source already patched")


def sub(old, new, why):
    global s
    if s.count(old) != 1:
        raise SystemExit(f"anchor not unique for {why}: {s.count(old)}")
    s = s.replace(old, new, 1)


# 1. module-level rest flag
sub(
    "const _EDGE_BATCH = (function () {\n"
    "  let _installed = false, _drawn = false, _groups = null, _ctx = null, _errors = 0;",
    "let _REST_BATCH_ON = false;   // L12: batch stays installed at rest\n"
    "const _EDGE_BATCH = (function () {\n"
    "  let _installed = false, _drawn = false, _groups = null, _ctx = null, _errors = 0;\n"
    "  let _dirty = false;",
    "rest flag",
)

# 2. `_set` becomes a no-op while rest batching owns the install state
sub(
    "  function _set(on) {\n    if (on) {",
    "  function _set(on) {\n"
    "    if (_REST_BATCH_ON) return;   // installed for the whole session\n"
    "    if (on) {",
    "set guard",
)

# 3. edge classification inside the patched drawLine
sub(
    "        et.drawLine = function (ctx, values, sel, hov, via) {\n"
    "          if (_drawn) return;          // the other 3875 edges are already on the canvas",
    "        et.drawLine = function (ctx, values, sel, hov, via) {\n"
    "          // L12: highlighted edges and edges showing an arrowhead are vis's job - the\n"
    "          // batch draws the plain line only.\n"
    "          if (sel || hov || _arrowed(this)) { orig.call(this, ctx, values, sel, hov, via); return; }\n"
    "          if (_drawn) return;          // the other 3875 edges are already on the canvas",
    "drawLine classify",
)

# 4. arrow test + dirty rebuild + the exposed frame hook
sub(
    "  return { set: _set, frame: function () { _drawn = false; } };\n})();",
    "  function _arrowed(et) {\n"
    "    const a = et && et.options && et.options.arrows;\n"
    "    return !!(a && a.to && a.to.enabled === true);\n"
    "  }\n"
    "  return { set: _set, frame: function () {\n"
    "    _drawn = false;\n"
    "    if (_dirty && _installed) { _dirty = false; _build(); }\n"
    "  }, dirty: function () { _dirty = true; },\n"
    "    count: function () { if (!_groups) return -1; let n = 0; for (const g of _groups) n += g.ets.length; return n; } };\n})();",
    "batch api",
)

# 5. invalidate on any data change (hidden nodes, legend toggles, arrow reveal)
sub(
    "// One batched edge pass per frame: afterDrawing fires once per vis draw.\n"
    "network.on('afterDrawing', function () { _EDGE_BATCH.frame(); });",
    "// One batched edge pass per frame: afterDrawing fires once per vis draw.\n"
    "network.on('afterDrawing', function () { _EDGE_BATCH.frame(); });\n"
    "// L12: any data change can change a group key (colour/width) or which edges are hidden,\n"
    "// so recompute the groups on the next frame instead of drawing a stale cache.\n"
    "try {\n"
    "  nodesDS.on('*', function () { _EDGE_BATCH.dirty(); });\n"
    "  edgesDS.on('*', function () { _EDGE_BATCH.dirty(); });\n"
    "} catch (e) {}\n"
    "// L12: keep the batch installed at rest, after the first draw has settled.\n"
    "_EDGE_BATCH.set(true);\n"
    "_REST_BATCH_ON = true;",
    "install at rest",
)

io.open(OUT, "w", encoding="utf-8", newline="").write(s)
print("wrote", OUT, len(s), "bytes")

"""Build the v8 "Obsidian feel" variant from the shipped v7 artifact.

Everything here is injected as one <script> block before </body>, so the exporter is
untouched until the measurements say the variant is a winner.

What it adds / fixes
  1. Selected/hovered nodes keep their community colour with a white ring, instead of
     being repainted white (#ffffff highlight) - the "washed out" look.
  2. Smooth eased wheel zoom anchored at the cursor: one redraw per frame instead of one
     per wheel event, clamped so labels cannot blow up into 50px text.
  3. Hover focus, Obsidian style: the hovered node + 1-hop neighbours stay fully coloured,
     everything else is blended 55% toward the background. Restored on blur, never on
     click, and never while a drag/zoom lean is active.
  4. A 1.5px halo ring on the hovered node, drawn in vis's afterDrawing (one arc).
  5. A correct fps/frame-time HUD on H (textContent only, no DOM churn).

  python harness/mk_v8.py
"""
import io
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-v7.html")
OUT = os.path.join(LAB, "variants", "v8-obsidian.html")

V8_JS = r'''
<script id="v8-ux">
// ---- v8 (#perf): Obsidian-feel interaction, still canvas-2d and still light. ----
(function () {
  var cont = document.getElementById('graph');
  var nodesObj = network.body.nodes;

  // 1. Keep the community colour on select/hover; accent with a white ring.
  //    The old highlight repainted the node #ffffff, which is what made a selected
  //    cluster look washed out.
  for (var hid in nodesObj) {
    var c0 = nodesObj[hid] && nodesObj[hid].options && nodesObj[hid].options.color;
    if (!c0 || typeof c0 !== 'object' || !c0.background) continue;
    c0.highlight = { background: c0.background, border: '#ffffff' };
    c0.hover = { background: c0.background, border: '#ffffff' };
  }

  // 2. Eased zoom at the cursor. vis zooms once per wheel event (trackpads fire dozens
  //    per frame), so the camera jumps and every event costs a full redraw. Here the
  //    target scale is accumulated and approached over rAF frames, one redraw each.
  //
  //    Important: network.moveTo(..., {animation:false}) does NOT emit zoom/pan in vis
  //    9.1.6 (probe: 2 moveTo calls -> 0 zoom, 0 pan events), so the lean handlers that
  //    key off 'zoom' never fire. The lean is driven explicitly here instead.
  //    The clamp is derived from the fitted scale on the first wheel, not at script
  //    time: the fit happens after this block runs (and after a baked build fits too).
  var fitScale = null, MIN_S = 0.004, MAX_S = 2.0;
  var targetScale = null, curScale = null, anchor = null, raf = 0, animating = false;

  function lean(on, redraw) {
    try { if (typeof _setLean === 'function') _setLean(on, redraw); } catch (e) {}
  }
  function viewCenter() {
    var r = cont.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function zoomStep() {
    raf = 0;
    if (targetScale === null || !anchor) { animating = false; lean(false, true); return; }
    var c = viewCenter();
    var k = Math.log(targetScale / curScale);
    var next = Math.abs(k) < 0.0025 ? targetScale : Math.exp(Math.log(curScale) + k * 0.25);
    // world point currently under the cursor, held there while the scale changes
    var wp = network.DOMtoCanvas({ x: anchor.x, y: anchor.y });
    curScale = next;
    network.moveTo({
      position: { x: wp.x - (anchor.x - c.x) / next, y: wp.y - (anchor.y - c.y) / next },
      scale: next,
      animation: false
    });
    if (next !== targetScale) raf = requestAnimationFrame(zoomStep);
    else { animating = false; setTimeout(function () { if (!raf) lean(false, true); }, 90); }
  }
  cont.addEventListener('wheel', function (e) {
    e.preventDefault();
    e.stopPropagation();          // vis's own wheel handler never sees it
    if (fitScale === null) {
      fitScale = network.getScale();
      MIN_S = Math.max(0.004, fitScale / 6);
      MAX_S = Math.max(0.4, Math.min(2.0, fitScale * 12));
    }
    if (curScale === null) { curScale = network.getScale(); targetScale = curScale; }
    var unit = e.deltaMode === 1 ? 0.05 : (e.deltaMode === 2 ? 1.0 : 0.0016);
    var f = Math.exp(-e.deltaY * unit);
    targetScale = Math.max(MIN_S, Math.min(MAX_S, targetScale * f));
    anchor = { x: e.clientX, y: e.clientY };
    animating = true;
    lean(true);
    if (!raf) raf = requestAnimationFrame(zoomStep);
  }, { passive: false, capture: true });
  // Keep our copy in sync when something else moves the camera (fit, search focus).
  network.on('zoom', function () {
    if (!animating) { curScale = network.getScale(); targetScale = curScale; }
  });

  // 3. Hover focus. Colour blending is done by writing each node's own options.color
  //    and issuing one redraw. datasets.update() is NOT used: 1886 nodes measured at
  //    149.6 ms, which is exactly the hitch this replaces.
  var BG = (function () {
    try {
      var v = getComputedStyle(document.body).getPropertyValue('--bg').trim();
      return v || '#0f0f1a';
    } catch (e) { return '#0f0f1a'; }
  })();
  function rgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(hex, bg, t) {
    var a = rgb(hex), b = rgb(bg);
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' +
                    Math.round(a[1] + (b[1] - a[1]) * t) + ',' +
                    Math.round(a[2] + (b[2] - a[2]) * t) + ')';
  }
  var orig = new Map(), dimCache = new Map();
  for (var oid in nodesObj) {
    var oc = nodesObj[oid] && nodesObj[oid].options && nodesObj[oid].options.color;
    if (oc && typeof oc === 'object' && oc.background) {
      orig.set(oid, { bg: oc.background, bd: oc.border || oc.background });
    }
  }
  function dimOf(hex) {
    var d = dimCache.get(hex);
    if (!d) { d = mix(hex, BG, 0.55); dimCache.set(hex, d); }
    return d;
  }
  var hoverTimer = 0, hoverOn = false;
  function paint(keep) {
    for (var nid in nodesObj) {
      var n = nodesObj[nid];
      var oc = n && n.options && n.options.color;
      var o = orig.get(nid);
      if (!oc || typeof oc !== 'object' || !o) continue;
      if (!keep || keep.has(nid)) { oc.background = o.bg; oc.border = o.bd; }
      else { var d = dimOf(o.bg); oc.background = d; oc.border = d; }
    }
  }
  function setHover(id) {
    if (_dragging || _lean) return;         // never fight a gesture
    var keep = new Set([id]);
    var one = network.getConnectedNodes(id) || [];
    for (var i = 0; i < one.length; i++) keep.add(one[i]);
    paint(keep);
    hoverOn = true;
    network.redraw();
  }
  function clearHover() {
    if (!hoverOn) return;
    paint(null);
    hoverOn = false;
    network.redraw();
  }
  network.on('hoverNode', function (p) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(function () { setHover(p.node); }, 70);
  });
  network.on('blurNode', function () {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(clearHover, 140);
  });
  network.on('dragStart', function () { clearTimeout(hoverTimer); clearHover(); });

  // 4. Halo ring on the hovered node (one arc per frame, no shadow).
  var hoverId = null;
  network.on('hoverNode', function (p) { hoverId = p.node; });
  network.on('blurNode', function () { hoverId = null; });
  network.on('afterDrawing', function (ctx) {
    if (hoverId === null) return;
    var n = network.body.nodes[hoverId];
    if (!n) return;
    var pos = network.getPositions([hoverId])[hoverId];
    if (!pos) return;
    var q = network.canvasToDOM(pos);
    var rad = ((n.shape && n.shape.radius) || 12) * network.getScale() + 3;
    ctx.save();
    ctx.beginPath();
    ctx.arc(q.x, q.y, rad, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  });

  // 5. fps / frame-time HUD on H. textContent only.
  var hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;background:rgba(0,0,0,.72);' +
    'color:#fff;font:11px/1.4 ui-monospace,monospace;padding:4px 8px;border-radius:4px;' +
    'display:none;pointer-events:none';
  document.body.appendChild(hud);
  var hudOn = false, frames = 0, t0 = performance.now(), fps = 0, lastT = performance.now(), ft = 0;
  (function loop(t) {
    ft = t - lastT; lastT = t; frames++;
    if (t - t0 >= 500) { fps = Math.round(frames * 1000 / (t - t0)); frames = 0; t0 = t; }
    if (hudOn) hud.textContent = fps + ' fps   ' + ft.toFixed(1) + ' ms';
    requestAnimationFrame(loop);
  })(performance.now());
  document.addEventListener('keydown', function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if ((e.key === 'h' || e.key === 'H') && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      hudOn = !hudOn;
      hud.style.display = hudOn ? 'block' : 'none';
    }
  });
})();
</script>
'''

s = io.open(SRC, encoding="utf-8", newline="").read()
if 'v8-ux' in s:
    raise SystemExit("source already contains v8")
if "</body>" not in s:
    raise SystemExit("no </body>")
out = s.replace("</body>", V8_JS + "\n</body>", 1)
io.open(OUT, "w", encoding="utf-8", newline="").write(out)
print("wrote", OUT, len(out), "bytes")

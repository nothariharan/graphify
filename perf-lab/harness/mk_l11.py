"""Build L11 viewer-experience variants from the shipped v7 artifact.

Injects a self-contained UX block (click-to-focus, search fly-to + pulse, fps HUD
toggle, legend isolate + hide-leaves) before </body>. Capability is untouched: nothing
is removed, only faded/isolated on demand and restored on background click.

  python harness/mk_l11.py
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-v7.html")
OUT = os.path.join(LAB, "variants", "L11-ux.html")

UX_JS = r'''
<script id="l11-ux">
// L11 viewer experience (#perf): focus, fly-to, HUD, legend isolate.
(function () {
  const css = `
    #l11-hud { position: fixed; top: 8px; right: 8px; z-index: 9999; background: rgba(0,0,0,.7); color: #fff; font: 11px/1.4 monospace; padding: 4px 8px; border-radius: 4px; display: none; white-space: pre; }
    #l11-hud.on { display: block; }
    #l11-hud button { background: #333; color: #fff; border: 1px solid #555; border-radius: 3px; padding: 1px 6px; margin-left: 6px; cursor: pointer; font: 11px monospace; }
    #legend-wrap { position: relative; }
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  const hud = document.createElement('div'); hud.id = 'l11-hud'; hud.innerHTML = 'fps: --  frame: --ms <button id="l11-hud-tog">hide</button>';
  document.body.appendChild(hud);

  let hudOn = false;
  let focusNode = null;
  let hiddenLeaves = false;

  function setOpacity(id, val) {
    try { nodesDS.update({ id, opacity: val }); } catch (e) {}
  }

  function twoHop(id) {
    const set = new Set([id]);
    const one = network.getConnectedNodes(id) || [];
    for (const n of one) set.add(n);
    for (const n of one) {
      const two = network.getConnectedNodes(n) || [];
      for (const m of two) set.add(m);
    }
    return set;
  }

  function applyFocus(id) {
    focusNode = id;
    const keep = twoHop(id);
    const updates = nodesDS.get().map(n => ({ id: n.id, opacity: keep.has(n.id) ? 1 : 0.12 }));
    nodesDS.update(updates);
    const edgeUpdates = edgesDS.get().map(e => {
      const ok = keep.has(e.from) && keep.has(e.to);
      return { id: e.id, color: ok ? e.color : { opacity: 0.06 } };
    });
    edgesDS.update(edgeUpdates);
  }

  function clearFocus() {
    focusNode = null;
    nodesDS.update(nodesDS.get().map(n => ({ id: n.id, opacity: 1 })));
    edgesDS.update(edgesDS.get().map(e => ({ id: e.id, color: e.color && e.color.opacity !== undefined ? e.color : e.color })));
    // restore edge opacity to original
    edgesDS.update(edgesDS.get().map(e => ({ id: e.id, color: { opacity: (e.confidence === 'EXTRACTED' ? 0.7 : 0.35) } })));
  }

  network.on('click', (p) => {
    if (p.nodes && p.nodes.length) {
      applyFocus(p.nodes[0]);
    } else {
      if (focusNode) clearFocus();
    }
  });

  // Search fly-to + pulse
  const searchInput = document.getElementById('search');
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const q = searchInput.value.trim().toLowerCase();
      if (!q) return;
      const hits = RAW_NODES.filter(n => (n.label || '').toLowerCase().includes(q));
      if (!hits.length) return;
      const target = hits[0].id;
      try { network.focus(target, { scale: 1.4, animation: { duration: 400, easingFunction: 'easeInOutQuad' } }); } catch (err) {}
      // pulse
      const orig = nodesDS.get(target);
      const origSize = orig ? orig.size : 10;
      nodesDS.update({ id: target, size: origSize * 1.8 });
      setTimeout(() => { try { nodesDS.update({ id: target, size: origSize }); } catch (e) {} }, 600);
    });
  }

  // FPS / frame-time HUD
  let frames = 0, last = performance.now(), fps = 0, frameMs = 0, lastFrame = performance.now();
  function tick() {
    const now = performance.now();
    frameMs = now - lastFrame; lastFrame = now;
    frames++;
    if (now - last >= 500) { fps = Math.round(frames * 1000 / (now - last)); frames = 0; last = now; }
    if (hudOn) {
      hud.textContent = `fps: ${fps}  frame: ${frameMs.toFixed(1)}ms`;
      const b = document.createElement('button'); b.id='l11-hud-tog'; b.textContent='hide'; b.onclick = () => { hudOn = false; hud.classList.remove('on'); };
      hud.appendChild(b);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // HUD toggle via 'H' key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') {
      hudOn = !hudOn;
      hud.classList.toggle('on', hudOn);
    }
  });

  // Legend isolate: double-click a legend item's color swatch -> isolate that community
  // Hide-leaves toggle
  const legendWrap = document.getElementById('legend-wrap');
  if (legendWrap) {
    const btn = document.createElement('button');
    btn.textContent = 'hide leaves';
    btn.style.cssText = 'margin: 4px 0; font-size: 11px; cursor: pointer;';
    btn.onclick = () => {
      hiddenLeaves = !hiddenLeaves;
      btn.textContent = hiddenLeaves ? 'show leaves' : 'hide leaves';
      const degs = {};
      RAW_NODES.forEach(n => { degs[n.id] = n.degree || 0; });
      const updates = RAW_NODES.filter(n => (degs[n.id] || 0) <= 1).map(n => ({ id: n.id, hidden: hiddenLeaves }));
      try { nodesDS.update(updates); } catch (e) {}
    };
    legendWrap.appendChild(btn);
  }

  // legend double-click isolate
  document.addEventListener('dblclick', (e) => {
    const sw = e.target && e.target.classList && e.target.classList.contains('legend-swatch');
    if (!sw) return;
    const cid = e.target.dataset.cid;
    if (cid === undefined) return;
    const keep = new Set(RAW_NODES.filter(n => String(n.community) === String(cid)).map(n => n.id));
    nodesDS.update(RAW_NODES.map(n => ({ id: n.id, opacity: keep.has(n.id) ? 1 : 0.08 })));
    edgesDS.update(edgesDS.get().map(ed => ({ id: ed.id, color: { opacity: (keep.has(ed.from) && keep.has(ed.to)) ? 0.7 : 0.04 } })));
  });
})();
</script>
'''

s = open(SRC, encoding='utf-8', newline='').read()
# inject before </body>
anchor = '</body>'
if anchor not in s:
    raise SystemExit('no </body>')
out = s.replace(anchor, UX_JS + '\n' + anchor, 1)
open(OUT, 'w', encoding='utf-8', newline='').write(out)
print('wrote', OUT, len(out), 'bytes')
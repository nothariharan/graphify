# L24 — click to focus: the node you are working on, and nothing else

## What the user asked for

> "when you specifically click on, let's say, a green node or something, all the other nodes
> which are not connected to it should be dimmed down ... When you are on the green family, the
> other nodes should be dimmed down so that they won't appear prominent."

The attached screenshot is the **hover** focus at work (the node `_make_member()` is hovered:
it and the nodes connected to it keep their colour, the rest are dimmed). The user likes that
picture and wants the same thing on **click**, and sticky: while you work on one node, the
rest of the graph should recede.

This reverses the L13 decision, which was "focus is hover-only and always restores" - that
was a judgement call made without the user asking for a click focus. The user has now asked
for one, so it is the user's call and the old decision is superseded (D60/D63).

## Design

Reuse the hover focus's painting, which already does exactly this visual: the focus set
keeps its community colour, everything else is blended 55% toward the background, by writing
the node instances' `options.color` (never `nodesDS.update` - 1886 nodes measured 149.6 ms -
and never `opacity`, which vis ignores on the draw).

- **Focus set** = the clicked node + its 1-hop neighbours (`network.getConnectedNodes`), the
  same set the hover focus uses.
- **Sticky**: it survives the pointer leaving the node and survives a drag (you are working
  on that node, not browsing).
- **Dismissed** by: clicking the same node again, clicking empty space, Escape, or hiding
  the node with the legend.
- **Hover does not fight it**: while a click focus is active, the hover focus does not
  repaint - the clicked focus owns the picture. Moving the pointer over another node must
  not wipe the focus the user just set.
- The clicked node is also *selected* by vis, so it keeps the white selection ring (the
  L13 colour-preserving selection) - the focused node is marked, not just bright.

## Method

- `harness/probe_click_focus.mjs` (new): a real mouse click on a node (synthetic events do
  not set vis's selection), then the count of dimmed vs bright node pixels, the white
  selection ring, and the restore on click-empty / Escape / same node.
- `harness/ab_rest.mjs` for the cost: the focus paint is one pass over the node instances
  plus one redraw, the same as the hover focus, so the frame must not move.
- A screenshot at zoom, so the picture can be looked at.

## Bar

- clicking a node dims every node that is not connected to it, and leaves the connected ones
  at full colour;
- clicking empty space (or Escape, or the same node) restores every node to its original
  colour - byte-identical to the frame before the click;
- the white selection ring on the focused node survives;
- the frame cost of the focus does not regress the resting frame.

## Results

`harness/probe_click_focus.mjs` on `variants/base-ours-v13.html` (a real mouse click on a
node with 37 neighbours, zoom 1.2; "bright" = the node keeps its own colour, "dimmed" = the
colour blended toward the background):

| step | bright | dimmed | selected |
|---|---|---|---|
| rest | 1886 | 0 | - |
| after the click | **38** | **1848** | the clicked node |
| click empty space | 1886 | 0 | - |
| click the node again | 38 | 1848 | the clicked node |
| click the same node again | 1886 | 0 | - |
| Escape | 1886 | 0 | - |

So: the node and its 37 connected neighbours stay at full colour, the other 1848 dim down,
and every dismiss path puts the picture back. The white selection ring of the focused node
survives (it is vis's own selection, and the L13 colour-preserving selection keeps the
community fill). Screenshot `shots/L24-click-focus.png`: the focused node is white-ringed in
the middle, its community is bright, the rest of the graph is dimmed.

The pixel diff against a reference frame is not a usable signal here: vis paints the labels
a frame late and the hover ring comes and goes with the pointer, so the same state differs
by 67 k-194 k pixels from run to run. The contract is measured on the node instance
colours instead (1886 bright / 0 dimmed), which is what the feature actually changes.

Cost: the focus paint is the same mechanism as the hover focus (a pass over the node
instances plus one redraw) and it only runs on a click, so the resting frame does not
change. The A/B (`results/ab-rest-L24-5r.csv`) is inside the noise, and so is the **A/A
control** (`results/ab-rest-AA-control.csv`, the same build measured against itself):
x1.58 on the resting frame between two *identical* builds. That is the harness's position
bias, not a difference - and a useful number to have.

Capability on v13 is unchanged (`probe_capabilities.mjs`): arrow 96 px, selected edge 163 px
and 0 after deselect, legend toggle 7880 px and restored, at-rest edge parity 9.83%.

## And the load time, which the user noticed

`harness/probe_reopen.mjs` opens the same page three times in one browser context:

| build | first open | re-open | layout cache |
|---|---|---|---|
| ours (v13) | 4 538 ms | **363 ms** | 1 entry |
| official (v8 @ 847a93f3) | 4 848 ms | 4 416 ms | none |

That is where the "4-7 seconds less" comes from: the official build runs vis's 200-iteration
solver on every open, ours keeps the stabilized positions in localStorage and skips it. The
*first* open in a fresh browser still pays the solver - which is the `--bake` lever.

## Verdict

Ship it. It is the feature the user asked for by name, it costs nothing at rest, and every
dismiss path puts the graph back.


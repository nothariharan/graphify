# L28 — the families panel: filtering by family, by colour, and the freeze it hid

## What the user asked for

> "filtering as of now only by search, and make it a bit better (like family-wise, color of
> node, or something like those kinds of classifications on the sidebar)"

The starting point was worse than "only by search": **there was no family filtering at all**,
because the community list was built from the community *labels* and this graph has none.
The sidebar showed a "COMMUNITIES" heading and a "Select All" checkbox over an empty list
(`LEGEND` had 0 entries in the shipped page - verified with `harness/legend_check.py`).

## What shipped

1. **Every community is a row.** The list is built from the communities themselves, and a
   community without a label is named after the file most of its members come from
   ("backend/tests/test_validation.py", 87 nodes). 141 rows, each with a checkbox, its
   colour, its name and its size.
2. **A filter box over the families** (`Filter families`) - it narrows the list, not the
   graph, so it is instant.
3. **Click a family's name to isolate it** - the other 140 families are hidden and the graph
   shows that family alone. Clicking it again shows everything.
4. **A colour strip** - one swatch per palette colour in use; clicking a swatch shows the
   families of that colour alone (the community colours are adjacency-aware, see L27, so a
   colour is a set of families that never touch).
5. **"All" resets the view**, and it is now free: the update only touches the families whose
   state actually changed. Before, "Select All" ran a DataSet update over all 1 886 nodes
   (149.6 ms measured) *even when everything was already visible*.
6. **A bulk change is spread over four frames.** A DataSet update for 1 800 nodes is ~280 ms
   in one block, which is a freeze; it is now four updates of ~35 families each.

## Cost (`harness/probe_families.mjs`, rsl)

| action | visible nodes | worst frame |
|---|---|---|
| click a family name (isolate) | 1 886 -> 87 | **76 ms** (280 ms in one block before) |
| click it again (show all) | 87 -> 1 886 | 201 ms |
| click a colour swatch | 1 886 -> 933 | 118 ms |
| "All" | -> 1 886 | 160 ms |
| type "frontend" in the filter | 141 rows -> 21 rows | instant |

The remaining cost is vis's own: hiding a node has to go through the DataSet. Writing
`node.options.hidden` on the instance does **not** work (measured: 0 pixels changed) - vis
recomputes the visible indices from the data, so the 91 ms per 200 nodes is the floor
(`probe_instance_hidden.mjs`).

The resting frame did not move: v14 27.4 ms vs v15 29.2 ms (x1.07, inside the harness's own
position bias of x1.58 measured by the A/A control).

Capability is unchanged: the legend toggle still hides a community and its edges (7 815 px
changed, restored to 0), the arrowhead appears on a hovered edge, the selected edge restores
to 0 after deselect, and the at-rest edge parity is the same 10.3% (colour only, the L12
ordering residual).

Screenshot: `shots/L28-families.png` - the panel with the filter box, the colour strip and
the family rows, and the graph behind it with the adjacency-aware community colours.

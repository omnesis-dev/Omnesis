# Landing graph generator

`gen-graph.mjs` generates the round **"unified graph → timeline"** SVG that is
inlined into `website/index.html` (the `.graph-flatten` section: a compact
people + document graph on the left that "flattens" into the event-trail
timeline on the right).

The graph is ~30 nodes and edges of hand-tuned geometry. Rather than hand-edit
~200 coordinates in the HTML, **edit the model/constants in the generator and
re-run it** — it rebuilds the `<svg>` and splices it back into `index.html` in
place (it rewrites only the `<svg>` inside `<div id="graph-viz">`, nothing else).

## Usage

```bash
node website/graph/gen-graph.mjs
```

No dependencies, no build step. Run it from the repo root (the script resolves
`index.html` relative to its own location). After running, the inlined SVG in
`website/index.html` is updated; commit both files together.

## What lives where

- **Graph geometry, nodes, edges, icons** → `gen-graph.mjs`. Edit the `N`
  (nodes) and `E` (edges) tables, or the geometry constants:
  - `C` / `R` — circle centre and node-ring radius.
  - `ROT` — rotates the whole ring. It is tuned so **Gmail lands near the top**
    and the **tenancy-agreement WhatsApp near the bottom**, which is what lets
    their two citation cards stack above/below the circle in `index.html`.
  - `VIEWBOX` — the tight box framing the circle.
- **Layout, the arrow, the two citation cards, and the timeline** → CSS
  (`.gf-*` rules) and markup in `website/index.html`. These are _not_ generated.

## Gotcha

The two citation cards in `index.html` (the Gmail email card and the WhatsApp
chat bubble) are absolutely positioned relative to where **Gmail** and the
**tenancy WhatsApp** node render. If you move those nodes (change `ROT`, the
ring order, or their angles), re-check the `.gf-cite-email` / `.gf-cite-chat`
offsets in `index.html`.

## Design language

The graph mirrors the "Gateway" card in the _"Your data, indexed in the
background"_ section: clean filled disks under the source icons, thin
brand-coloured edges (document links crisp, neutral person links faint), and no
glow except the accent ring on the "You" hub.

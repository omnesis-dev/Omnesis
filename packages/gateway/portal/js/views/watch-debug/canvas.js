// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The definition canvas: a watch's node graph, top to bottom.
 *
 * Sources sit across the top rank and the sink alone on the last one, because
 * the pane that opens on a node click slides in from the right — a left-to-right
 * graph would put the end of the flow exactly where the pane covers it, and the
 * whole point of this page is reading a path from source to sink while looking
 * at one node's configuration.
 *
 * Two layers over one coordinate space, both driven by the numbers
 * `layoutWatchDag` computed. Edges are an SVG layer underneath: lines, arrow
 * heads and nothing else. The boxes and the edge labels are HTML on top, so a
 * node is a real button (focusable, keyboard-operable) and its badges are real
 * chips that wrap and truncate through CSS rather than through measured text.
 *
 * SVG presentation attributes do not resolve `var()`, so every stroke and fill
 * below is applied through inline `style` — which does. That is what lets a
 * theme flip re-colour an already-rendered canvas.
 *
 * The same boxes carry the state lens. `counts` puts a live-cell badge on each
 * node; `dimmed` — the set of nodes lit under a selected key — drops everything
 * outside that key's slice back. Both are optional: with neither, this is the
 * definition alone, which is what it renders before the state read returns.
 */

import { html } from "htm/preact";

import {
  isPlainObject,
  watchDeliveryFields,
  watchKeyLabel,
  watchNodeSummary,
} from "../../lib/watch-dsl.js";
import { MAX_VISIBLE_BADGES } from "../../lib/watch-dag.js";


/**
 * How each kind of edge is drawn. An arrow marker cannot inherit its line's
 * stroke, so each stroke colour owns a marker of its own.
 */
const EDGE_STYLES = {
  arm: { id: "watch-dag-arrow-arm", stroke: "var(--graph-edge)", dash: null },
  cancel: { id: "watch-dag-arrow-cancel", stroke: "var(--danger)", dash: "6 4" },
  broadcast: { id: "watch-dag-arrow-broadcast", stroke: "var(--warning)", dash: "2 4" },
  sink: { id: "watch-dag-arrow-sink", stroke: "var(--accent)", dash: null },
};

function edgeStyle(edge) {
  if (edge.sink) return EDGE_STYLES.sink;
  if (edge.role === "cancel") return EDGE_STYLES.cancel;
  if (edge.broadcast) return EDGE_STYLES.broadcast;
  return EDGE_STYLES.arm;
}

/**
 * @param verdicts A chip per node id, when one event's path is lit. Null means
 * no path is selected; a node absent from a non-null map is one the event never
 * reached, and dims — where the signal did not go is half of what a path says.
 * @param paneOpen Whether a drawer is open over the canvas, from any lens. The
 * graph is laid out vertically so a pane never covers it, which only holds if
 * the canvas makes room for whichever pane is open — a selected node's, or a
 * selected event's, whose path is the thing the reader opened it to see.
 */
export function WatchDagCanvas({
  layout,
  selectedId = null,
  onSelect = () => {},
  counts = null,
  dimmed = null,
  verdicts = null,
  paneOpen = false,
}) {
  return html`<div class=${`watch-dag-scroll ${paneOpen ? "has-pane" : ""}`.trim()}>
    <div class="watch-dag" style=${`width:${layout.width}px;height:${layout.height}px;`}>
      <svg
        class="watch-dag-edges"
        width=${layout.width}
        height=${layout.height}
        viewBox=${`0 0 ${layout.width} ${layout.height}`}
        aria-hidden="true"
      >
        <defs>
          ${Object.values(EDGE_STYLES).map(
            (style) => html`<marker
              key=${style.id}
              id=${style.id}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" style=${`fill:${style.stroke}`} />
            </marker>`,
          )}
        </defs>
        ${layout.edges.map((edge) => {
          const style = edgeStyle(edge);
          return html`<line
            key=${`${edge.from}->${edge.to}`}
            x1=${edge.x1}
            y1=${edge.y1}
            x2=${edge.x2}
            y2=${edge.y2}
            stroke-width="1.5"
            stroke-dasharray=${style.dash}
            marker-end=${`url(#${style.id})`}
            style=${`stroke:${style.stroke}`}
          />`;
        })}
      </svg>
      ${layout.edges.map(
        (edge) => html`<${EdgeLabel} key=${`${edge.from}->${edge.to}`} edge=${edge} />`,
      )}
      ${layout.nodes.map(
        (node) => html`<${NodeBox}
          key=${node.id}
          node=${node}
          selected=${node.id === selectedId}
          count=${counts?.get(node.id) ?? 0}
          dim=${dimmed !== null && !dimmed.has(node.id)}
          verdict=${verdicts ? (verdicts.get(node.id) ?? null) : null}
          lit=${verdicts !== null}
          onSelect=${onSelect}
        />`,
      )}
      ${verdicts
        ? layout.nodes.map((node) => {
            const verdict = verdicts.get(node.id);
            return verdict
              ? html`<${VerdictChip} key=${`verdict:${node.id}`} node=${node} verdict=${verdict} />`
              : null;
          })
        : null}
    </div>
  </div>`;
}

/**
 * What flows across an edge: the key expression, and what happens to it here.
 *
 * Sits over the line's midpoint and takes no pointer events, so it never eats a
 * click meant for a box.
 */
function EdgeLabel({ edge }) {
  const key = watchKeyLabel(edge.key);
  if (!key && edge.notes.length === 0) return null;
  return html`<div
    class="watch-dag-edge-label"
    style=${`left:${edge.labelX}px;top:${edge.labelY}px;`}
  >
    ${key
      ? html`<code class="watch-dag-key" title=${keyExpressionTitle(edge.key)}>${key}</code>`
      : null}
    ${edge.notes.map(
      (note) => html`<span
        key=${note.kind}
        class=${`watch-dag-note ${note.kind}`}
        title=${note.title}
      >${note.label}</span>`,
    )}
  </div>`;
}

function keyExpressionTitle(key) {
  if (!isPlainObject(key)) return null;
  return Object.entries(key)
    .map(([component, expression]) => `${component} = ${expression}`)
    .join("\n");
}

function NodeBox({
  node,
  selected,
  onSelect,
  count = 0,
  dim = false,
  verdict = null,
  lit = false,
}) {
  const isSink = node.kind === "sink";
  const classes = [
    "watch-dag-node",
    isSink ? "is-sink" : null,
    node.isSource ? "is-source" : null,
    selected ? "is-selected" : null,
    dim ? "is-dim" : null,
    // A lit path with nothing on this box means the event never reached it.
    lit ? (verdict ? `is-on-path is-${verdict.tone}` : "is-off-path") : null,
  ]
    .filter(Boolean)
    .join(" ");
  return html`<button
    type="button"
    class=${classes}
    data-node-id=${node.id}
    aria-pressed=${selected}
    style=${`left:${node.x}px;top:${node.y}px;width:${node.w}px;height:${node.h}px;`}
    onClick=${() => onSelect(node.id)}
  >
    <${CellCount} count=${count} />
    ${isSink ? html`<${SinkBoxBody} node=${node} />` : html`<${NodeBoxBody} node=${node} />`}
  </button>`;
}

/**
 * How many cells this node holds, as of the snapshot in the bar above.
 *
 * A node holding nothing wears no badge at all rather than a `0`: on a watch
 * that has never armed, every box would carry one and the row of zeroes would
 * read as a fault. Absence is the same claim and makes the boxes that do hold
 * something the only thing on the canvas that draws the eye.
 */
function CellCount({ count }) {
  if (!Number.isInteger(count) || count < 1) return null;
  return html`<span
    class="watch-dag-count"
    title=${`${count} live ${count === 1 ? "cell" : "cells"} on this node.`}
    >${count}</span
  >`;
}

/**
 * What one node did at the selected moment, riding on its top edge.
 *
 * A sibling of the box rather than a child of it: a box's height is computed
 * from the badge rows it was measured for, so a row added inside would be
 * clipped by the box it belongs to. Sitting in the rank gap above, it also
 * stays legible when the box beneath it is dimmed.
 */
function VerdictChip({ node, verdict }) {
  return html`<span
    class=${`watch-dag-verdict is-${verdict.tone}`}
    style=${`left:${node.x + node.w / 2}px;top:${node.y}px;`}
    title=${verdict.title}
  >${verdict.label}</span>`;
}

function NodeBoxBody({ node }) {
  const summary = watchNodeSummary(node.node);
  return html`
    <span class="watch-dag-node-type">${node.type}</span>
    <code class="watch-dag-node-id">${node.id}</code>
    <span class="watch-dag-node-summary">
      ${summary ?? "This build does not know what this node type configures."}
    </span>
    <${Badges} badges=${node.badges} />
  `;
}

/**
 * The sink is a box like any other, because that is what it is to a reader: the
 * end of the flow. In the DSL it is a top-level block naming a node rather than
 * a node itself, which is why it carries an input line instead of an id.
 */
function SinkBoxBody({ node }) {
  const delivery = watchDeliveryFields(node.delivery);
  return html`
    <span class="watch-dag-node-type">sink</span>
    <code class="watch-dag-node-id">from ${node.node?.input ?? "—"}</code>
    <span class="watch-dag-node-summary">
      ${delivery
        ? delivery.kind === "agent-wake"
          ? `Wakes ${delivery.fields[0][1] ?? "an agent"}`
          : "Notifies your devices"
        : "Records the firing and tells nobody"}
    </span>
    <${Badges} badges=${node.badges} />
  `;
}

/** The badge row every box shares — and the row the layout sized the box for. */
function Badges({ badges }) {
  if (badges.length === 0) return null;
  const visible = badges.slice(0, MAX_VISIBLE_BADGES);
  const hidden = badges.length - visible.length;
  return html`<span class="watch-dag-node-badges">
    ${visible.map(
      (badge) => html`<span key=${badge.label} class="watch-dag-badge" title=${badge.title}>
        ${badge.label}
      </span>`,
    )}
    ${hidden > 0
      ? html`<span class="watch-dag-badge is-more" title="Open the node to see the rest."
          >+${hidden}</span
        >`
      : null}
  </span>`;
}

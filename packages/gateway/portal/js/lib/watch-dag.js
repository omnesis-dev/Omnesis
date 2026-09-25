// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A stored watch definition, read as a drawable graph.
 *
 * Two steps, kept apart because they answer different questions. `readWatchDag`
 * turns the DSL into structure — nodes, the edges its `inputs` maps imply, the
 * rank each node sits on, and what happens to the key along every edge.
 * `layoutWatchDag` turns that structure into pixels. Neither touches the DOM,
 * so both are testable without a browser and the view stays declarative.
 *
 * There is no edge list in the DSL: an edge is an entry in the *consuming*
 * node's `inputs` map, which is also where its role, its key extractor and its
 * broadcast flag live. The sink is not a node either — it is a top-level
 * `{ input, output_map }` naming the terminal node — so a synthetic box is
 * added below it, because to a reader the sink is plainly the end of the flow.
 *
 * Ranks come from Kahn's algorithm over declaration order, the same ordering
 * the runtime's validator uses, so two reads of one watch draw the same
 * picture. A definition that cannot be ranked (a cycle, an input naming a node
 * that is not there) is reported as a reason rather than drawn half-way: a
 * canvas that silently omits an edge is worse than one that says it cannot be
 * trusted.
 */

import {
  WATCH_SINK_ID,
  isPlainObject,
  isWatchSourceNode,
  watchDeliveryFields,
  watchKeyComponents,
  watchNodeBadges,
  watchNodeReportsFiredBy,
} from "./watch-dsl.js";

/**
 * Read a stored `dsl` into a graph, or say why it cannot be read.
 *
 * Returns `{ ok: true, dag }` or `{ ok: false, reason }`, where `reason` is one
 * sentence naming what is wrong with this definition — the canvas prints it and
 * offers the raw JSON, rather than rendering nothing.
 */
export function readWatchDag(dsl) {
  const definition = dsl?.watch;
  if (!isPlainObject(definition)) {
    return fail("This definition has no `watch` block, so there is no graph in it to draw.");
  }
  if (!Array.isArray(definition.nodes) || definition.nodes.length === 0) {
    return fail("This definition declares no nodes.");
  }

  const byId = new Map();
  for (const raw of definition.nodes) {
    if (!isPlainObject(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
      return fail("A node in this definition has no id, so its edges cannot be resolved.");
    }
    if (byId.has(raw.id)) {
      return fail(`Two nodes share the id \`${raw.id}\`, so an edge to it is ambiguous.`);
    }
    byId.set(raw.id, raw);
  }

  const sinkInput = definition.sink?.input;
  if (typeof sinkInput !== "string" || !byId.has(sinkInput)) {
    return fail("The sink names no node this definition declares, so the flow has no end.");
  }

  const edges = [];
  for (const [id, raw] of byId) {
    const inputs = isPlainObject(raw.inputs) ? raw.inputs : {};
    for (const [from, input] of Object.entries(inputs)) {
      if (!byId.has(from)) {
        return fail(`Node \`${id}\` takes an input from \`${from}\`, which is not declared here.`);
      }
      if (from === id) {
        return fail(`Node \`${id}\` takes an input from itself, so signal has nowhere to flow.`);
      }
      edges.push({
        from,
        to: id,
        role: input?.role === "cancel" ? "cancel" : "arm",
        key: isPlainObject(input?.key) ? input.key : null,
        broadcast: input?.broadcast === true,
        notes: [],
      });
    }
  }

  const order = topologicalOrder(byId, edges);
  if (!order) {
    return fail("Signal must flow downstream only, and a cycle among these nodes stops it.");
  }

  const rankById = new Map();
  for (const id of order) {
    const parents = edges.filter((edge) => edge.to === id);
    const rank = parents.reduce((max, edge) => Math.max(max, rankById.get(edge.from) + 1), 0);
    rankById.set(id, rank);
  }

  const nodes = order.map((id) => {
    const raw = byId.get(id);
    const inbound = edges.filter((edge) => edge.to === id);
    const keyed = inbound.filter((edge) => edge.key !== null);
    return {
      kind: "node",
      id,
      type: typeof raw.type === "string" ? raw.type : "unknown",
      node: raw,
      rank: rankById.get(id),
      isSource: isWatchSourceNode(raw),
      keyed: keyed.length > 0,
      keyComponents: unique(keyed.flatMap((edge) => watchKeyComponents(edge.key))),
      badges: watchNodeBadges(raw),
    };
  });

  // The sink sits below everything, not merely below its own input: it is the
  // end of the flow, and a rank it shared with anything else would read as a
  // branch off to one side.
  const sinkRank = nodes.reduce((max, node) => Math.max(max, node.rank), 0) + 1;
  const delivery = watchDeliveryFields(definition.delivery);
  nodes.push({
    kind: "sink",
    id: WATCH_SINK_ID,
    type: "sink",
    node: definition.sink,
    delivery: definition.delivery ?? null,
    rank: sinkRank,
    isSource: false,
    keyed: false,
    keyComponents: [],
    // The sink wears its delivery kind, so the box it is measured for has to
    // allow for that row. Derived from the same reading the box draws from —
    // deciding it twice would size one thing and render another.
    badges: delivery
      ? [{ label: delivery.kind, title: "How a firing leaves the runtime." }]
      : [],
  });
  edges.push({
    from: sinkInput,
    to: WATCH_SINK_ID,
    role: "arm",
    key: null,
    broadcast: false,
    sink: true,
    notes: [],
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) annotateEdge(edge, nodeById, edges);

  // Declaration order within a rank: the same tie-break the runtime's
  // topological walk uses, so the picture is stable across reads.
  const declarationOrder = new Map([...byId.keys()].map((id, index) => [id, index]));
  const ranks = Array.from({ length: sinkRank + 1 }, () => []);
  for (const node of nodes) ranks[node.rank].push(node);
  for (const rank of ranks) {
    rank.sort((a, b) => (declarationOrder.get(a.id) ?? 0) - (declarationOrder.get(b.id) ?? 0));
  }

  return { ok: true, dag: { definition, nodes, edges, ranks, nodeById, sinkInput } };
}

function fail(reason) {
  return { ok: false, reason };
}

/**
 * Kahn's algorithm over declaration order. Null when a cycle leaves nodes
 * unordered — the same condition the runtime's validator refuses to install.
 */
function topologicalOrder(byId, edges) {
  const indegree = new Map([...byId.keys()].map((id) => [id, 0]));
  const dependents = new Map([...byId.keys()].map((id) => [id, []]));
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    dependents.get(edge.from).push(edge.to);
  }

  const queue = [...byId.keys()].filter((id) => indegree.get(id) === 0);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const dependent of dependents.get(id)) {
      const remaining = indegree.get(dependent) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  return order.length === byId.size ? order : null;
}

/**
 * What happens to the key along one edge.
 *
 * A key is *derived* where it is first computed from an arriving payload, under
 * an upstream that holds no key of its own; *joined* where two or more keyed
 * arms meet on the same node; *dropped* where a keyed upstream feeds a node
 * that keys nothing, collapsing its population into one global cell. A keyless
 * edge into a keyed node is a broadcast — the DSL requires it to say so — and
 * fans out to every live key rather than starting one of its own.
 */
function annotateEdge(edge, nodeById, edges) {
  const from = nodeById.get(edge.from);
  const to = nodeById.get(edge.to);
  const notes = edge.notes;

  if (edge.role === "cancel") {
    notes.push({ kind: "cancel", label: "cancels", title: "This arrival kills the live cell." });
  }
  if (edge.broadcast) {
    notes.push({
      kind: "broadcast",
      label: "broadcast",
      title: "Keyless into a keyed node: it fans out to every live key rather than starting one.",
    });
  }
  if (edge.key !== null) {
    if (from && !from.keyed) {
      notes.push({
        kind: "derived",
        label: "derives key",
        title: "The key is first computed here, from this edge's arriving payload.",
      });
    }
    const keyedArms = edges.filter(
      (other) => other.to === edge.to && other.key !== null && other.role === "arm",
    );
    if (keyedArms.length > 1) {
      notes.push({
        kind: "joined",
        label: "joins",
        title: `${keyedArms.length} keyed arms meet on this node under the same key.`,
      });
    }
  } else if (from?.keyed && to && !to.keyed && !edge.broadcast && !edge.sink) {
    // Not said of the edge into the sink: the sink is where the flow ends
    // rather than a node that collapses a population, so every keyed watch
    // would wear the note and it would stop meaning anything.
    notes.push({
      kind: "dropped",
      label: "key dropped",
      title: "This node keys nothing, so the population above it collapses to one global cell.",
    });
  }
  if (to && edge.role === "arm" && to.kind === "node" && watchNodeReportsFiredBy(to.node)) {
    notes.push({
      kind: "fired-by",
      label: `$fired_by: ${edge.from}`,
      title: "An arrival on this arm is what this node reports through `$fired_by`.",
    });
  }
}

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * How many badges a box draws before the rest collapse into a `+n` chip.
 *
 * Declared beside the layout because the layout sizes the box for them: a cap
 * the renderer knew about alone would draw more chips than the box was measured
 * for, which is how a row ends up clipped.
 */
export const MAX_VISIBLE_BADGES = 3;

const NODE_W = 216;
const NODE_BASE_H = 74;
const BADGE_ROW_H = 22;
const COL_GAP = 28;
const RANK_GAP = 82;
const PAD = 16;
/** Kept clear of the box edge so the arrow head is not swallowed by the border. */
const ARROW_GAP = 8;

/**
 * Place every box and every edge, top to bottom: sources across the top rank,
 * the sink alone on the last one.
 *
 * Heights are computed rather than measured — a box's badge rows are known
 * before it renders — so the SVG edge layer and the HTML boxes agree on one
 * coordinate space without a layout pass, and the same numbers come out under a
 * test that has no layout engine at all.
 */
export function layoutWatchDag(dag) {
  const placed = new Map();
  const rows = dag.ranks.map((rank) => {
    const height = rank.reduce((max, node) => Math.max(max, boxHeight(node)), NODE_BASE_H);
    const width = rank.length * NODE_W + (rank.length - 1) * COL_GAP;
    return { rank, height, width };
  });

  const canvasWidth = rows.reduce((max, row) => Math.max(max, row.width), NODE_W) + PAD * 2;
  let y = PAD;
  for (const row of rows) {
    const left = (canvasWidth - row.width) / 2;
    row.rank.forEach((node, index) => {
      placed.set(node.id, {
        ...node,
        x: left + index * (NODE_W + COL_GAP),
        y,
        w: NODE_W,
        h: row.height,
      });
    });
    y += row.height + RANK_GAP;
  }
  const canvasHeight = y - RANK_GAP + PAD;

  // Spread the endpoints across the box edge, ordered by where the other end
  // sits, so a fan-in reads as separate lines converging rather than one line
  // drawn four times.
  const outSlots = slotsBy(dag.edges, "from", "to", placed);
  const inSlots = slotsBy(dag.edges, "to", "from", placed);

  const edges = dag.edges.map((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    const x1 = from.x + slotFraction(outSlots, edge.from, edge) * from.w;
    const y1 = from.y + from.h;
    const x2 = to.x + slotFraction(inSlots, edge.to, edge) * to.w;
    const y2 = to.y - ARROW_GAP;
    return {
      ...edge,
      x1,
      y1,
      x2,
      y2,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2,
    };
  });

  return {
    width: canvasWidth,
    height: canvasHeight,
    nodes: dag.ranks.flat().map((node) => placed.get(node.id)),
    edges,
  };
}

function boxHeight(node) {
  return NODE_BASE_H + badgeRows(node.badges.length) * BADGE_ROW_H;
}

/**
 * How many rows of badges a box has to allow for.
 *
 * Chip widths are not knowable here — `collision: accumulate` is three times
 * `spawn` — so this counts chips rather than measuring them, and the CSS caps
 * the row box so a wider-than-expected label can never push the text above it
 * out of the box. One badge always fits on a line; two might not, and beyond
 * that {@link MAX_VISIBLE_BADGES} plus the overflow chip bounds it at two rows.
 */
export function badgeRows(count) {
  if (count === 0) return 0;
  return count === 1 ? 1 : 2;
}

function slotsBy(edges, own, other, placed) {
  const groups = new Map();
  for (const edge of edges) {
    if (!groups.has(edge[own])) groups.set(edge[own], []);
    groups.get(edge[own]).push(edge);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => placed.get(a[other]).x - placed.get(b[other]).x);
  }
  return groups;
}

function slotFraction(groups, id, edge) {
  const group = groups.get(id);
  return (group.indexOf(edge) + 1) / (group.length + 1);
}

function unique(values) {
  return [...new Set(values)];
}

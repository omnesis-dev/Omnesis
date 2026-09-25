// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SVG graph renderer for the portal's graph-debug page.
 *
 * Stateless: given a `{ vertices, edges }` payload, mutates a host
 * `<svg>` element so it shows the graph. Computes node positions via a
 * lightweight force-directed simulation (no external library); edges
 * are straight lines with directional arrow markers and a midpoint
 * label carrying the edge type.
 *
 * Vertices know nothing about source-specific anything; they read
 * `sourceIconUrl(sourceId)` from `format.js` to pick the right glyph,
 * so adding a new source automatically gets the right icon here.
 */

import { sourceIconUrl } from "./format.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const NODE_RADIUS = 24;
const ICON_SIZE = 22;
const EDGE_LABEL_PAD = 4;
const ARROW_OFFSET = 6;

// Colours are CSS custom properties resolved at paint time, not hex literals.
// SVG presentation attributes (`fill="…"`) don't resolve `var()`, so every
// fill/stroke below is applied via inline `style` (which does) — that lets a
// `data-theme` flip on <html> re-colour an already-rendered graph live, with
// no re-render. The tokens themselves live in style.css under `--graph-*`.
const PERSON_FILL = "var(--graph-person-fill)";
const PERSON_FILL_SELF = "var(--graph-person-self-fill)";
const DOC_FILL = "var(--graph-doc-fill)";
const SEED_OUTLINE = "var(--accent)";
const PERSON_OUTLINE = "var(--graph-person-outline)";
const DOC_OUTLINE = "var(--graph-doc-outline)";

const EDGE_COLOR = "var(--graph-edge)";
const EDGE_LABEL_COLOR = "var(--text-secondary)";
const EDGE_NEAR_DUP_COLOR = "var(--graph-edge-near-dup)";
const EDGE_PEOPLE_COLOR = "var(--graph-edge-people)";

// Text on / under nodes, and the merged-count pill.
const NODE_TEXT = "var(--text-primary)";
const PILL_FILL = "var(--accent)";
const PILL_STROKE = "var(--bg-primary)";
const PILL_TEXT = "var(--graph-pill-text)";

/**
 * Render `graph` into `svgEl`. Mutates `svgEl` directly — clears any
 * previous children. The caller is responsible for sizing the SVG via
 * its CSS; we read `getBoundingClientRect()` for the viewport at the
 * moment of render.
 *
 * `onVertexClick(vertex)` is invoked when the user clicks a node. The
 * graph-debug view uses this to route into `/portal/doc/<id>` or
 * `/portal/people/<id>`.
 *
 * `onVertexHover(vertex | null, rect)` fires when the cursor enters or
 * leaves a merged-document vertex (one with `mergedDocuments.length > 1`).
 * `rect` is the screen-space bounding rect of the node group, in the
 * SVG's client coordinate system — the view uses it to position a
 * popover. `null` vertex means the cursor left a merged node.
 */
export function renderGraph(svgEl, graph, opts = {}) {
  const onVertexClick = opts.onVertexClick ?? (() => {});
  const onVertexHover = opts.onVertexHover ?? (() => {});

  // Clear previous content + defs.
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

  const rect = svgEl.getBoundingClientRect();
  const width = Math.max(400, rect.width);
  const height = Math.max(400, rect.height);
  svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);

  if (graph.vertices.length === 0) return;

  // ─── Layout ─────────────────────────────────────────────────────────
  const nodes = layout(graph.vertices, graph.edges, width, height);
  const idToNode = new Map(nodes.map((n) => [n.id, n]));

  // ─── Defs: one arrow marker per directed-edge colour ────────────────
  const defs = svgNs("defs");
  defs.appendChild(arrowMarker("arrow-default", EDGE_COLOR));
  svgEl.appendChild(defs);

  // ─── Edges (under nodes) ─────────────────────────────────────────────
  const edgesGroup = svgNs("g");
  edgesGroup.setAttribute("class", "graph-edges");
  svgEl.appendChild(edgesGroup);

  // Group edges by the unordered vertex pair so parallel edges between
  // the same pair can be staggered apart (otherwise their lines stack
  // and the labels overlap).
  const pairGroups = groupEdgesByPair(graph.edges);
  for (const group of pairGroups.values()) {
    drawEdgeGroup(edgesGroup, group, idToNode);
  }

  // ─── Nodes (above edges) ────────────────────────────────────────────
  const nodesGroup = svgNs("g");
  nodesGroup.setAttribute("class", "graph-nodes");
  svgEl.appendChild(nodesGroup);

  const seedSet = new Set(graph.seeds ?? []);
  for (const node of nodes) {
    drawNode(nodesGroup, node, seedSet.has(node.id), onVertexClick, onVertexHover, svgEl);
  }
}

// ─── Layout (force-directed) ────────────────────────────────────────────

/**
 * Lightweight spring layout. O(N²) — fine for the bounded vertex caps
 * the gateway enforces (≤ ~600 vertices, typically << 200 once depth
 * and fanout cap take effect).
 */
function layout(vertices, edges, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 2 - NODE_RADIUS - 20;

  // Deterministic-ish initial positions on a ring around the centre,
  // jittered with a hash so layout is stable across re-renders of the
  // same graph but varies for distinct graphs.
  const nodes = vertices.map((v, i) => {
    const angle = (i / vertices.length) * Math.PI * 2;
    const jitter = (hash32(v.id) % 100) / 100;
    const radius = r * (0.4 + 0.4 * jitter);
    return {
      ...v,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
  });

  const idIdx = new Map(nodes.map((n, i) => [n.id, i]));

  const links = [];
  for (const e of edges) {
    const a = idIdx.get(e.from);
    const b = idIdx.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b]);
  }

  // Tunables: a small N with many iterations is cheaper than the
  // converse on this scale and produces a more pleasing settled graph.
  const ITERATIONS = 320;
  const SPRING_K = 0.03;
  // Both REPULSION and SPRING_LENGTH scale inversely with N so a
  // sparse 10-node graph really spreads to fill the canvas while a
  // dense 200-node graph stays compact. Without this, the spring
  // forces dominate at small N and the whole graph collapses to a
  // tight ball regardless of canvas size.
  const N = Math.max(1, nodes.length);
  const REPULSION = Math.max(6000, Math.min(28000, 60000 / Math.sqrt(N)));
  const SPRING_LENGTH = Math.max(150, Math.min(280, 700 / Math.sqrt(N)));
  const GRAVITY = 0.0035;
  const DAMPING = 0.86;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Repulsion between every pair of nodes.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 1) {
          // Same-position guard — push apart in a deterministic direction
          // so the simulation doesn't NaN out on dist=0.
          dx = (i - j) * 0.5;
          dy = (j - i) * 0.5;
          dist2 = dx * dx + dy * dy;
        }
        const inv = REPULSION / dist2;
        const dist = Math.sqrt(dist2);
        const fx = (dx / dist) * inv;
        const fy = (dy / dist) * inv;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Spring attraction along edges.
    for (const [ai, bi] of links) {
      const a = nodes[ai];
      const b = nodes[bi];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const delta = dist - SPRING_LENGTH;
      const f = SPRING_K * delta;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Centring gravity so disconnected components don't drift offscreen.
    for (const n of nodes) {
      n.vx += (cx - n.x) * GRAVITY;
      n.vy += (cy - n.y) * GRAVITY;
    }

    // Integrate + damp.
    for (const n of nodes) {
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
      // Clamp to viewport so nodes never leave the SVG.
      n.x = Math.max(NODE_RADIUS + 4, Math.min(width - NODE_RADIUS - 4, n.x));
      n.y = Math.max(NODE_RADIUS + 4, Math.min(height - NODE_RADIUS - 4, n.y));
    }
  }

  return nodes;
}

// ─── Drawing ────────────────────────────────────────────────────────────

function drawNode(group, node, isSeed, onClick, onHover, svgEl) {
  const g = svgNs("g");
  const mergedCount = node.mergedDocuments ? node.mergedDocuments.length : 0;
  const isMerged = mergedCount > 1;
  g.setAttribute(
    "class",
    `graph-node ${node.kind}${isSeed ? " seed" : ""}${isMerged ? " merged" : ""}`,
  );
  g.setAttribute("transform", `translate(${node.x}, ${node.y})`);
  g.style.cursor = "pointer";
  g.addEventListener("click", () => onClick(node));
  if (isMerged) {
    g.addEventListener("mouseenter", () => {
      const rect = g.getBoundingClientRect();
      const svgRect = svgEl.getBoundingClientRect();
      // Report rect relative to the SVG element so the view can place
      // its popover with absolute positioning inside .graph-debug-canvas-wrap.
      onHover(node, {
        left: rect.left - svgRect.left,
        top: rect.top - svgRect.top,
        right: rect.right - svgRect.left,
        bottom: rect.bottom - svgRect.top,
        width: rect.width,
        height: rect.height,
      });
    });
    g.addEventListener("mouseleave", () => onHover(null, null));
  }

  const isPerson = node.kind === "person";
  const isRow = node.kind === "analytics-row";
  // Analytics-row vertices get a distinct teal so the cross-store
  // `same-entity` edge reads as "this doc ↔ its structured row".
  const fill = isPerson
    ? node.isSelf
      ? PERSON_FILL_SELF
      : PERSON_FILL
    : isRow
      ? "var(--graph-row-fill, #1f5f5a)"
      : DOC_FILL;
  const stroke = isSeed
    ? SEED_OUTLINE
    : isPerson
      ? PERSON_OUTLINE
      : DOC_OUTLINE;
  const strokeWidth = isSeed ? 2.5 : 1.2;

  // Background circle.
  const circle = svgNs("circle");
  circle.setAttribute("r", String(NODE_RADIUS));
  circle.style.fill = fill;
  circle.style.stroke = stroke;
  circle.setAttribute("stroke-width", String(strokeWidth));
  g.appendChild(circle);

  // Inner content — icon for documents, initials for people.
  if (isPerson) {
    const text = svgNs("text");
    text.textContent = initials(node.canonicalName || "?");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("font-size", "11");
    text.setAttribute("font-weight", "600");
    text.style.fill = NODE_TEXT;
    text.setAttribute("pointer-events", "none");
    g.appendChild(text);
  } else {
    // For merged duplicates, surface every UNIQUE source the cluster
    // touches (capped at 3 so a 4-source merge falls back to two
    // icons + the existing count pill). For a single-source node
    // this is just the one icon at full size.
    const sids = uniqueSourceIds(node);
    if (sids.length === 0) {
      const text = svgNs("text");
      text.textContent = "\uD83D\uDCC4"; // 📄
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      text.setAttribute("font-size", "16");
      text.setAttribute("pointer-events", "none");
      g.appendChild(text);
    } else {
      const count = Math.min(sids.length, 3);
      // Per-icon size + spacing tuned so a 2- or 3-icon row fits
      // comfortably inside the 48px node bubble without bleeding
      // into the count pill on the top-right.
      const layout =
        count === 1 ? { size: ICON_SIZE, gap: 0 }
        : count === 2 ? { size: 18, gap: 18 }
        : { size: 14, gap: 14 };
      const totalSpan = (count - 1) * layout.gap;
      for (let i = 0; i < count; i++) {
        const sid = sids[i];
        const iconUrl = sourceIconUrl(sid);
        const cx = (i * layout.gap) - totalSpan / 2;
        if (iconUrl) {
          const img = svgNs("image");
          img.setAttribute("href", iconUrl);
          img.setAttribute("x", String(cx - layout.size / 2));
          img.setAttribute("y", String(-layout.size / 2));
          img.setAttribute("width", String(layout.size));
          img.setAttribute("height", String(layout.size));
          img.setAttribute("pointer-events", "none");
          // Rounded clip so square icons match the circular node.
          img.setAttribute("clip-path", "inset(0% round 3px)");
          g.appendChild(img);
        } else {
          // Generic fallback per slot — keeps the layout consistent
          // even when one of the sources lacks a registered icon.
          const text = svgNs("text");
          text.textContent = "\uD83D\uDCC4";
          text.setAttribute("x", String(cx));
          text.setAttribute("text-anchor", "middle");
          text.setAttribute("dominant-baseline", "central");
          text.setAttribute("font-size", String(layout.size - 2));
          text.setAttribute("pointer-events", "none");
          g.appendChild(text);
        }
      }
    }
  }

  // Title below the circle.
  const label = svgNs("text");
  const labelText = isPerson
    ? node.canonicalName ?? "(unknown)"
    : isRow
      ? node.tableDisplayName ?? node.tableName ?? "(row)"
      : node.title ?? "(untitled)";
  label.textContent = truncate(labelText, 28);
  label.setAttribute("y", String(NODE_RADIUS + 14));
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("font-size", "11");
  label.style.fill = NODE_TEXT;
  label.setAttribute("pointer-events", "none");
  g.appendChild(label);

  // Title tooltip — full title + id (helps a debugger trace the doc).
  const title = svgNs("title");
  const idForTitle = isPerson ? node.personId : node.documentId;
  title.textContent = `${labelText}\n${idForTitle ?? ""}`;
  g.appendChild(title);

  // Merge-count pill — top-right of the circle, only on merged nodes.
  // The popover (rendered by the view) shows the full list on hover.
  if (isMerged) {
    const pillR = 9;
    const pillX = NODE_RADIUS - 2;
    const pillY = -NODE_RADIUS + 2;
    const pillBg = svgNs("circle");
    pillBg.setAttribute("cx", String(pillX));
    pillBg.setAttribute("cy", String(pillY));
    pillBg.setAttribute("r", String(pillR));
    pillBg.style.fill = PILL_FILL;
    pillBg.style.stroke = PILL_STROKE;
    pillBg.setAttribute("stroke-width", "1.5");
    pillBg.setAttribute("pointer-events", "none");
    g.appendChild(pillBg);
    const pillText = svgNs("text");
    pillText.textContent = String(mergedCount);
    pillText.setAttribute("x", String(pillX));
    pillText.setAttribute("y", String(pillY));
    pillText.setAttribute("text-anchor", "middle");
    pillText.setAttribute("dominant-baseline", "central");
    pillText.setAttribute("font-size", "10");
    pillText.setAttribute("font-weight", "700");
    pillText.style.fill = PILL_TEXT;
    pillText.setAttribute("pointer-events", "none");
    g.appendChild(pillText);
  }

  group.appendChild(g);
}

function drawEdgeGroup(group, edgeGroup, idToNode) {
  // Stagger parallel edges between the same pair so labels don't stack.
  // Offset is perpendicular to the pair's line; even counts split
  // symmetrically around the midline.
  const count = edgeGroup.length;
  edgeGroup.forEach((edge, i) => {
    const a = idToNode.get(edge.from);
    const b = idToNode.get(edge.to);
    if (!a || !b) return;
    const offset = edgeOffset(i, count);
    drawEdge(group, edge, a, b, offset);
  });
}

function drawEdge(group, edge, a, b, perpOffset) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / len;
  const ny = dy / len;
  // Perpendicular unit vector.
  const px = -ny;
  const py = nx;

  // Start / end pulled inward by NODE_RADIUS so the line doesn't disappear
  // under the node circles. The arrow head goes between them.
  const x1 = a.x + nx * NODE_RADIUS + px * perpOffset;
  const y1 = a.y + ny * NODE_RADIUS + py * perpOffset;
  const arrowPad = edge.directed ? ARROW_OFFSET : 0;
  const x2 = b.x - nx * (NODE_RADIUS + arrowPad) + px * perpOffset;
  const y2 = b.y - ny * (NODE_RADIUS + arrowPad) + py * perpOffset;

  const color = edgeColor(edge);

  const line = svgNs("line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  line.style.stroke = color;
  line.setAttribute("stroke-width", "1");
  if (edge.directed) line.setAttribute("marker-end", "url(#arrow-default)");
  group.appendChild(line);

  // Edge label — type string at midpoint, slightly offset along the
  // perpendicular so it doesn't sit on the line.
  const mx = (x1 + x2) / 2 + px * (perpOffset >= 0 ? EDGE_LABEL_PAD : -EDGE_LABEL_PAD);
  const my = (y1 + y2) / 2 + py * (perpOffset >= 0 ? EDGE_LABEL_PAD : -EDGE_LABEL_PAD);
  const label = svgNs("text");
  label.textContent = labelForEdge(edge);
  label.setAttribute("x", String(mx));
  label.setAttribute("y", String(my));
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("dominant-baseline", "central");
  label.setAttribute("font-size", "10");
  label.style.fill = EDGE_LABEL_COLOR;
  label.setAttribute("pointer-events", "none");
  group.appendChild(label);
}

function edgeColor(edge) {
  if (edge.type === "near-duplicate") return EDGE_NEAR_DUP_COLOR;
  // Person-doc edges (roles) use the people palette. We detect them by
  // the endpoint kind — but the renderer doesn't see kinds in `edge`,
  // so use the type string convention: roles never collide with link
  // types because document_links uses kebab-case ("email-thread") and
  // people roles are single lowercase words ("sender", "recipient").
  // Falls through to default if there's any ambiguity — type-agnostic
  // rendering, not a hardcoded enum.
  if (PERSON_ROLE_TYPES.has(edge.type)) return EDGE_PEOPLE_COLOR;
  return EDGE_COLOR;
}

// Roles emitted by document_people today — kept here purely for COLOUR
// dispatch (visual grouping), not for behaviour. An unfamiliar role
// just falls back to the default edge colour; nothing breaks.
const PERSON_ROLE_TYPES = new Set([
  "sender",
  "recipient",
  "attendee",
  "participant",
  "mentioned",
  "author",
  "editor",
  "owner",
  "contact",
]);

function labelForEdge(edge) {
  if (edge.type === "near-duplicate" && typeof edge.jaccard === "number") {
    return `near-dup ${Math.round(edge.jaccard * 100)}%`;
  }
  return edge.type;
}

function edgeOffset(index, count) {
  if (count <= 1) return 0;
  // Spread offsets symmetrically: 2 edges → [-10, +10], 3 → [-12, 0, +12], …
  const span = 12;
  return (index - (count - 1) / 2) * span;
}

function groupEdgesByPair(edges) {
  const map = new Map();
  for (const e of edges) {
    const key = [e.from, e.to].sort().join("↔");
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return map;
}

// ─── SVG helpers ────────────────────────────────────────────────────────

function svgNs(tag) {
  return document.createElementNS(SVG_NS, tag);
}

function arrowMarker(id, color) {
  const marker = svgNs("marker");
  marker.setAttribute("id", id);
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "7");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("orient", "auto-start-reverse");
  const path = svgNs("path");
  path.setAttribute("d", "M0,0 L10,5 L0,10 z");
  path.style.fill = color;
  marker.appendChild(path);
  return marker;
}

// ─── Utilities ──────────────────────────────────────────────────────────

/**
 * Unique sourceIds carried by a node, in stable first-seen order.
 * For a non-merged node it's a single-entry list with the node's own
 * sourceId. For a merged duplicate node it dedupes across every
 * member of `mergedDocuments` — typically the same source repeated,
 * but cross-source dupes (a PDF on WhatsApp + Drive + Gmail) yield
 * multiple ids that we want to surface in the bubble.
 */
function uniqueSourceIds(node) {
  if (!node.mergedDocuments || node.mergedDocuments.length === 0) {
    return node.sourceId ? [node.sourceId] : [];
  }
  const seen = new Set();
  const out = [];
  for (const m of node.mergedDocuments) {
    const sid = m.sourceId;
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    out.push(sid);
  }
  return out;
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

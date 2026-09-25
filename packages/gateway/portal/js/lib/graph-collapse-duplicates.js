// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Collapse `duplicate-content` and `near-duplicate` clusters of
 * document vertices into a single representative node, re-pointing
 * every incoming + outgoing edge of any cluster member at the
 * representative.
 *
 * Pure function over `{ vertices, edges, seeds, ... }` — returns a new
 * graph object. The original `mergedDocuments` array on the
 * representative carries the full member list (id + title + sourceId
 * + sourceUrl) so the UI can render a hover popover with one link
 * per merged document.
 *
 * `same-resource` deliberately stays expanded: it relates a retained capture
 * to the structured owner of one URL, but their content and historical value
 * differ. Collapsing them would hide the capture this relationship preserves.
 *
 * Algorithm:
 *   1. Union-find over edges whose `type ∈ { "duplicate-content",
 *      "near-duplicate" }` AND whose two endpoints are BOTH document
 *      vertices. Edges to people don't merge anything; cross-class
 *      edges between two distinct clusters stay separate.
 *   2. For each connected component of size ≥ 2, pick a representative:
 *      a seed (any of them) if present, else the minimum-depth member,
 *      then lexicographic id as a deterministic tiebreaker.
 *   3. Drop non-representative document vertices; copy their identity
 *      onto the rep's `mergedDocuments` array.
 *   4. Re-point every edge endpoint from a cluster member to the rep,
 *      drop edges that became self-loops (an internal cluster edge),
 *      dedupe using the same direction-aware key the backend uses
 *      (`D|from→to|type` for directed, `U|<lex sort>|type` for
 *      undirected).
 *   5. If any seed vertex was merged, remap `graph.seeds` entries to
 *      the rep so the renderer still highlights the right nodes.
 */

const COLLAPSIBLE_TYPES = new Set(["duplicate-content", "near-duplicate"]);

export function collapseDuplicateClusters(graph) {
  const vertexById = new Map(graph.vertices.map((v) => [v.id, v]));

  // ─── 1. Union-find over collapsible doc↔doc edges ──────────────────
  const parent = new Map();
  function find(x) {
    let cur = x;
    while (parent.get(cur) !== cur) {
      const p = parent.get(cur);
      parent.set(cur, parent.get(p));
      cur = parent.get(cur);
    }
    return cur;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const v of graph.vertices) parent.set(v.id, v.id);

  for (const edge of graph.edges) {
    if (!COLLAPSIBLE_TYPES.has(edge.type)) continue;
    const from = vertexById.get(edge.from);
    const to = vertexById.get(edge.to);
    if (!from || !to) continue;
    if (from.kind !== "document" || to.kind !== "document") continue;
    union(edge.from, edge.to);
  }

  // ─── 2. Group document vertices by component, pick a rep ───────────
  const componentMembers = new Map();
  for (const v of graph.vertices) {
    if (v.kind !== "document") continue;
    const root = find(v.id);
    if (!componentMembers.has(root)) componentMembers.set(root, []);
    componentMembers.get(root).push(v);
  }

  const seedSet = new Set(graph.seeds ?? []);
  const repByMember = new Map();
  const repExtras = new Map();
  for (const members of componentMembers.values()) {
    if (members.length === 1) {
      repByMember.set(members[0].id, members[0].id);
      continue;
    }
    let rep = pickRepresentative(members, seedSet);
    for (const m of members) repByMember.set(m.id, rep.id);
    repExtras.set(
      rep.id,
      members.map((m) => ({
        documentId: m.documentId,
        title: m.title,
        sourceId: m.sourceId,
        sourceUrl: m.sourceUrl,
      })),
    );
  }

  function remap(id) {
    const v = vertexById.get(id);
    if (!v) return id;
    if (v.kind !== "document") return id;
    return repByMember.get(id) ?? id;
  }

  // ─── 3. Rewrite vertices ───────────────────────────────────────────
  const keptVertices = [];
  const seenKept = new Set();
  for (const v of graph.vertices) {
    const newId = remap(v.id);
    if (newId !== v.id) continue; // a non-rep cluster member — drop
    if (seenKept.has(newId)) continue;
    seenKept.add(newId);
    const extras = repExtras.get(v.id);
    if (extras && extras.length > 1) {
      keptVertices.push({ ...v, mergedDocuments: extras });
    } else {
      keptVertices.push(v);
    }
  }

  // ─── 4. Rewrite edges + dedupe ─────────────────────────────────────
  const seenEdges = new Set();
  const keptEdges = [];
  for (const e of graph.edges) {
    const fromMapped = remap(e.from);
    const toMapped = remap(e.to);
    if (fromMapped === toMapped) continue; // dropped — internal cluster edge
    // If the edge itself collapsed the cluster (a collapsible type
    // between two members that ended up in different reps — i.e.
    // separate clusters), keep it.
    const key = e.directed
      ? `D|${fromMapped}→${toMapped}|${e.type}`
      : `U|${[fromMapped, toMapped].sort().join("↔")}|${e.type}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    keptEdges.push({ ...e, from: fromMapped, to: toMapped });
  }

  // ─── 5. Re-point seeds if any got merged ───────────────────────────
  // Each seed in `graph.seeds` maps through `remap` to its cluster
  // rep; dedupe in case two seeds fell into the same cluster.
  const newSeeds = [];
  const seenNewSeeds = new Set();
  for (const s of graph.seeds ?? []) {
    const remapped = remap(s);
    if (seenNewSeeds.has(remapped)) continue;
    seenNewSeeds.add(remapped);
    newSeeds.push(remapped);
  }

  return {
    ...graph,
    seeds: newSeeds,
    vertices: keptVertices,
    edges: keptEdges,
  };
}

/**
 * Pick the representative vertex for a duplicate cluster. Preference
 * order:
 *   - A seed wins (any of them) so user-typed entry points stay
 *     highlighted; the first seed in `members` is fine — clusters can
 *     contain at most one seed in normal usage.
 *   - Otherwise the minimum-depth member (closer to a seed).
 *   - Lex-smallest id as a deterministic tiebreaker.
 */
function pickRepresentative(members, seedSet) {
  for (const m of members) if (seedSet.has(m.id)) return m;
  let best = members[0];
  for (let i = 1; i < members.length; i++) {
    const m = members[i];
    if (
      m.depth < best.depth ||
      (m.depth === best.depth && m.id < best.id)
    ) {
      best = m;
    }
  }
  return best;
}

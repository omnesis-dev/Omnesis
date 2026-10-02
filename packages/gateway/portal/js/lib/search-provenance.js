// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Only attach diagnostic evidence to the exact indexed identities it describes. */
export function provenanceForResults(response, results) {
  const visible = new Set(results.map((result) => result.documentId));
  const byDocument = Object.create(null);
  if (response?.kind !== "search.results") return byDocument;
  for (const result of response.results || []) {
    if (!result.provenance) continue;
    const ids = [result.documentId, ...(result.provenance.copies || []).map((copy) => copy.documentId)];
    for (const id of ids) {
      if (visible.has(id)) byDocument[id] = result.provenance;
    }
  }
  return byDocument;
}

export function graphContextNotice(error) {
  if ([403, 404, 405].includes(error?.status)) return null;
  return "Graph context is unavailable for this search. Ordinary results are shown.";
}

/** Resolve only the document identities already present in bounded graph evidence. */
export function provenanceDocumentIds(response) {
  return [...new Set((response?.results || []).flatMap((result) => result.provenance
    ? [result.documentId, ...result.provenance.copies.map((copy) => copy.documentId),
      ...result.provenance.paths.flatMap((path) => path.documentIds)]
    : []))];
}

/** A copy family shares one panel while the ordinary result order stays intact. */
export function provenancePanels(results, byDocument) {
  const panels = Object.create(null);
  const firstByFamily = new Map();
  for (const result of results || []) {
    const provenance = byDocument[result.documentId];
    if (!provenance) continue;
    const hasOtherCopy = (provenance.copies || []).some((copy) => copy.documentId !== result.documentId);
    const hasPhysicalLocation = (provenance.copies || []).some((copy) => copy.documentId === result.documentId && (copy.deviceName || copy.path));
    if (!hasOtherCopy && !hasPhysicalLocation && !provenanceLines(provenance).length) continue;
    const copyIds = (provenance.copies || []).map((copy) => copy.documentId).sort();
    const family = JSON.stringify(copyIds.length ? copyIds : [result.documentId]);
    const first = firstByFamily.get(family);
    const panelId = first || `search-graph-${encodeURIComponent(result.documentId)}`;
    if (!first) firstByFamily.set(family, panelId);
    panels[result.documentId] = { provenance, panelId, repeated: Boolean(first) };
  }
  return panels;
}

/** Human relation fallback for gateways that only return directed edge codes. */
export function graphRelation(edge) {
  const [prefix, suffix] = (edge || "").split(":");
  const kind = suffix || prefix;
  const inbound = suffix && prefix === "inbound";
  const outbound = suffix && prefix === "outbound";
  switch (kind) {
    case "url": return inbound ? "is linked from" : outbound ? "links to" : "has a link with";
    case "references": return inbound ? "is referenced by" : outbound ? "references" : "has a reference connection with";
    case "replies-to": return inbound ? "has a reply from" : outbound ? "replies to" : "has a reply connection with";
    case "part-of-thread": return "shares a thread with";
    case "calendar-event": return "has an event connection with";
    case "contains": return "has related content in";
    case "revision-of": return "is another version of";
    default: return "is connected to";
  }
}

/** The exact paths supplied by the graph snapshot as one tree per root; repeated steps merge. */
function provenanceTrees(provenance) {
  const roots = new Map();
  for (const path of provenance.paths || []) {
    const ids = path.documentIds || [];
    // A malformed or looping path would read as a connection that is not there.
    if (ids.length < 2 || ids.length !== (path.edges || []).length + 1 || new Set(ids).size !== ids.length) continue;
    let node = roots.get(ids[0]);
    if (!node) {
      node = { documentId: ids[0], children: new Map() };
      roots.set(ids[0], node);
    }
    for (let index = 0; index < ids.length - 1; index++) {
      if (ids[index] === ids[index + 1]) continue;
      const edge = path.edges?.[index] || "";
      const relation = typeof path.relations?.[index] === "string" && path.relations[index].trim()
        ? path.relations[index] : graphRelation(edge);
      const key = JSON.stringify([ids[index + 1], edge, relation]);
      let child = node.children.get(key);
      if (!child) {
        child = { documentId: ids[index + 1], relation, children: new Map(), more: 0 };
        node.children.set(key, child);
      }
      node = child;
    }
  }
  return [...roots.values()];
}

/**
 * Leaves that share a relation and a title under different documents of one
 * root's tree (an inline image repeated in every message of a thread) fold
 * into the first one, which counts the rest. Siblings under one document stay
 * listed: they already share a clause, and each is separate evidence. A
 * document `titleOf` does not name never folds.
 */
function foldRepeatedLeaves(roots, titleOf) {
  let first;
  const visit = (node) => {
    for (const [key, child] of node.children) {
      if (child.children.size) {
        visit(child);
        continue;
      }
      const title = (titleOf(child.documentId) || "").trim().toLowerCase();
      if (!title) continue;
      const fold = JSON.stringify([child.relation, title]);
      const kept = first.get(fold);
      if (!kept) first.set(fold, { leaf: child, parent: node });
      else if (kept.parent !== node && kept.leaf.documentId !== child.documentId) {
        kept.leaf.more++;
        node.children.delete(key);
      }
    }
  };
  for (const root of roots) {
    first = new Map();
    visit(root);
  }
}

/**
 * Graph facts as an outline. A route is said once: a single branch continues
 * inline ("…, which includes A"), siblings sharing a relation read as one
 * clause ("includes A, B and C"), and where a document branches, its line
 * ends with a colon and each branch follows one level deeper. A part is a
 * `{ text }` or a `{ documentId, more }` reference.
 */
export function provenanceLines(provenance, titleOf = () => undefined) {
  const roots = provenanceTrees(provenance);
  foldRepeatedLeaves(roots, titleOf);
  const lines = [];
  const ref = (node) => ({ documentId: node.documentId, more: node.more || 0 });
  const list = (nodes) => nodes.flatMap((node, index) => [
    ...(index ? [{ text: index === nodes.length - 1 ? " and " : ", " }] : []), ref(node),
  ]);
  const groupsOf = (node) => {
    const groups = new Map();
    for (const child of node.children.values()) {
      if (!groups.has(child.relation)) groups.set(child.relation, []);
      groups.get(child.relation).push(child);
    }
    return [...groups];
  };
  const render = (node, prefix, depth) => {
    const groups = groupsOf(node);
    if (!groups.length) return;
    if (groups.every(([, targets]) => targets.every((target) => !target.children.size))) {
      lines.push({ depth, parts: [...prefix, ...groups.flatMap(([relation, targets], index) => [
        { text: `${index ? " and" : ""} ${relation} ` }, ...list(targets),
      ]), { text: "." }] });
      return;
    }
    if (groups.length === 1) {
      const [relation, targets] = groups[0];
      if (targets.length === 1) {
        render(targets[0], [...prefix, { text: ` ${relation} ` }, ref(targets[0]), { text: ", which" }], depth);
        return;
      }
    }
    lines.push({ depth, parts: [...prefix, { text: ":" }] });
    const leafGroups = groups
      .map(([relation, targets]) => [relation, targets.filter((target) => !target.children.size)])
      .filter(([, leaves]) => leaves.length);
    if (leafGroups.length)
      lines.push({ depth: depth + 1, parts: [...leafGroups.flatMap(([relation, leaves], index) => [
        { text: `${index ? " and " : ""}${relation} ` }, ...list(leaves),
      ]), { text: "." }] });
    for (const [relation, targets] of groups) {
      for (const branch of targets.filter((target) => target.children.size))
        render(branch, [{ text: `${relation} ` }, ref(branch), { text: ", which" }], depth + 1);
    }
  };
  for (const root of roots) render(root, [ref(root)], 0);
  return lines;
}

/** Flat outline lines as a tree, so a branch's lines nest under the line ending with its colon. */
export function nestProvenanceLines(lines) {
  const top = [];
  const open = [];
  for (const line of lines) {
    const item = { ...line, children: [] };
    while (open.length && open[open.length - 1].depth >= line.depth) open.pop();
    (open.length ? open[open.length - 1].children : top).push(item);
    open.push(item);
  }
  return top;
}

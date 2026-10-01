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
    if (!hasOtherCopy && !hasPhysicalLocation && !provenanceSentences(provenance).length) continue;
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

/** Merge clauses only within the exact paths supplied by the graph snapshot. */
export function provenanceSentences(provenance) {
  const roots = new Map();
  for (const path of provenance.paths || []) {
    const ids = path.documentIds || [];
    if (ids.length < 2) continue;
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
        child = { documentId: ids[index + 1], relation, children: new Map() };
        node.children.set(key, child);
      }
      node = child;
    }
  }
  const sentences = [];
  function collect(node, root, steps) {
    const children = [...node.children.values()];
    if (!children.length) return;
    if (children.every((child) => !child.children.size)) {
      sentences.push({ root, steps, clauses: children.map(({ documentId, relation }) => ({ documentId, relation })) });
      return;
    }
    for (const child of children) {
      const step = { documentId: child.documentId, relation: child.relation };
      if (!child.children.size) sentences.push({ root, steps, clauses: [step] });
      else collect(child, root, [...steps, step]);
    }
  }
  for (const root of roots.values()) collect(root, root.documentId, []);
  return sentences;
}

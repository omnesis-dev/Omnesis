// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SearchProvenance } from "@omnesis/core";

type Context = NonNullable<SearchProvenance["modelContext"]>;
type Document = Omit<Context["documents"][number], "ref">;
type Reason = SearchProvenance["stopReasons"][number];
interface Node {
  id: string;
  relation?: string;
  children: Map<string, Node>;
}

/** "A", "A and B", "A, B and C". */
function list(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Labels shared by every hit of one search: `refs` maps a document id to its
 * label, and `ranks` gives each hit's 1-based position in the results.
 */
export interface SharedReferences {
  refs: Map<string, string>;
  ranks: ReadonlyMap<string, number>;
}

/**
 * Build prose only from exact directed paths. Each hit lists every document
 * its facts name; labels are local to the hit unless `shared` carries them
 * across one search's results.
 */
export function provenanceModelContext(
  rootId: string,
  copies: SearchProvenance["copies"],
  paths: SearchProvenance["paths"],
  documents: ReadonlyMap<string, Document>,
  roles: ReadonlyMap<string, string>,
  hubs: ReadonlySet<string>,
  reasons: Set<Reason>,
  maxChars: number,
  derived = false,
  shared?: SharedReferences,
): Context {
  const context: Context = { facts: [], documents: [], limits: [] };
  const refs = shared?.refs ?? new Map<string, string>();
  const listed = new Set<string>();
  const reference = (id: string): string => {
    let ref = refs.get(id);
    if (!ref) {
      ref = `D${refs.size + 1}`;
      refs.set(id, ref);
    }
    if (!listed.has(id)) {
      const document = documents.get(id);
      if (!document) throw new Error("Graph reference has no snapshot document");
      listed.add(id);
      context.documents.push({ ref, ...document });
    }
    return `[${ref}]`;
  };
  reference(rootId);
  for (const copy of copies) reference(copy.documentId);
  let used = 0;
  const fact = (sentence: string): void => {
    if (context.facts.length >= 64 || used + sentence.length > maxChars) {
      reasons.add("summary");
      return;
    }
    context.facts.push(sentence);
    used += sentence.length;
  };
  if (derived) {
    fact(
      "This is Omnesis-generated context. Its document links are not independent evidence of sharing.",
    );
  } else {
    const otherCopies = copies.filter((copy) => copy.documentId !== rootId);
    if (otherCopies.length) {
      fact(
        `Matching extracted text also appears in ${otherCopies.map((copy) => reference(copy.documentId)).join(", ")}. Byte identity has not been verified.`,
      );
    }
    for (const copy of copies) {
      if (copy.deviceName || copy.path)
        fact(
          `${reference(copy.documentId)} is indexed${copy.deviceName ? ` on ${JSON.stringify(copy.deviceName)}` : ""}${copy.path ? ` at ${JSON.stringify(copy.path)}` : ""}.`,
        );
    }
    const roots = new Map<string, Node>();
    for (const path of paths) {
      if (!path.relations || path.relations.length !== path.edges.length) continue;
      const first = path.documentIds[0];
      let node: Node = roots.get(first) ?? { id: first, children: new Map() };
      roots.set(first, node);
      for (let index = 0; index < path.edges.length; index++) {
        const id = path.documentIds[index + 1];
        if (id === path.documentIds[index]) continue;
        reference(id);
        const relation = path.relations[index];
        const key = JSON.stringify([id, path.edges[index], relation]);
        let child: Node | undefined = node.children.get(key);
        if (!child) {
          child = { id, relation, children: new Map() };
          node.children.set(key, child);
        }
        node = child;
      }
    }
    const sentences = (node: Node, prefix: string): void => {
      const children = [...node.children.values()];
      if (!children.length) return;
      if (children.every((child) => !child.children.size)) {
        // Leaves sharing a relation read as one clause: "includes A, B and C".
        const byRelation = new Map<string, string[]>();
        for (const child of children)
          byRelation.set(child.relation ?? "", [
            ...(byRelation.get(child.relation ?? "") ?? []),
            reference(child.id),
          ]);
        fact(
          `${prefix} ${[...byRelation].map(([relation, refs]) => `${relation} ${list(refs)}`).join(" and ")}.`,
        );
        return;
      }
      for (const child of children) {
        const clause = `${prefix} ${child.relation} ${reference(child.id)}`;
        if (child.children.size) sentences(child, `${clause}, which`);
        else fact(`${clause}.`);
      }
    };
    // Every path document is labelled by now. Which of them are other results
    // goes ahead of the path sentences, so the budget drops a path first.
    if (shared) {
      const own = shared.ranks.get(rootId);
      const alsoHits = context.documents.flatMap((document) => {
        const rank = shared.ranks.get(document.documentId);
        return rank === undefined || rank === own ? [] : [`[${document.ref}] (result ${rank})`];
      });
      if (alsoHits.length) fact(`Also in these search results: ${alsoHits.join(", ")}.`);
    }
    for (const root of roots.values()) sentences(root, reference(root.id));
    for (const document of context.documents) {
      const labels = roles.get(document.documentId);
      if (labels) fact(`[${document.ref}] lists ${labels}.`);
    }
  }
  if (reasons.has("hub")) {
    const refs = [...hubs].map(reference).join(", ");
    const message = `Further connections of ${refs} were not explored because they are highly connected.`;
    context.limits.push(
      refs && message.length <= 240
        ? message
        : "Some highly connected documents were not expanded.",
    );
  }
  if (reasons.has("depth"))
    context.limits.push("Further connections beyond the traversal depth were not explored.");
  if (reasons.has("nodes"))
    context.limits.push(
      "The graph document budget was reached; more copies or connections may exist.",
    );
  if (reasons.has("copies"))
    context.limits.push(
      "The copy inventory was capped; more documents with matching text may exist.",
    );
  if (reasons.has("summary"))
    context.limits.push(
      "Some graph facts or document details were omitted or shortened to fit the context budget.",
    );
  return context;
}

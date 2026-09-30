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

/** Build prose only from exact directed paths; labels are local to one search hit. */
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
): Context {
  const context: Context = { facts: [], documents: [], limits: [] };
  const refs = new Map<string, string>();
  const reference = (id: string): string => {
    let ref = refs.get(id);
    if (!ref) {
      ref = `D${refs.size + 1}`;
      refs.set(id, ref);
      const document = documents.get(id);
      if (!document) throw new Error("Graph reference has no snapshot document");
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
        fact(
          `${prefix} ${children.map((child) => `${child.relation} ${reference(child.id)}`).join(" and ")}.`,
        );
        return;
      }
      for (const child of children) {
        const clause = `${prefix} ${child.relation} ${reference(child.id)}`;
        if (child.children.size) sentences(child, `${clause}, which`);
        else fact(`${clause}.`);
      }
    };
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

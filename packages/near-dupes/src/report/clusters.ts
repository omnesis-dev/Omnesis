// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Union-find over the pair table. Given a list of (a, b) edges,
 * returns connected components, each represented as a sorted list of
 * document ids.
 */
export function connectedComponents(edges: Iterable<readonly [string, string]>): string[][] {
  const parent = new Map<string, string>();

  function find(x: string): string {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const [a, b] of edges) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    union(a, b);
  }

  const groups = new Map<string, string[]>();
  for (const node of parent.keys()) {
    const root = find(node);
    const arr = groups.get(root);
    if (arr) arr.push(node);
    else groups.set(root, [node]);
  }

  return [...groups.values()].map((g) => g.sort()).sort((a, b) => b.length - a.length);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The JSON Pointer leaf paths whose values differ between two configs.
 *
 * Used by every writer of `omnesis.json` — the gateway's config store and the
 * CLI when it edits the file while no gateway is running — to report what a
 * mutation changed and to recognise a mutation that changed nothing.
 */
export function diffConfigPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (deepEqual(before, after)) return [];

  // Both objects → recurse per key so we surface leaf paths.
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const out: string[] = [];
    for (const key of keys) {
      const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
      const next = `${prefix}/${escaped}`;
      out.push(
        ...diffConfigPaths(
          (before as Record<string, unknown>)[key],
          (after as Record<string, unknown>)[key],
          next,
        ),
      );
    }
    return out;
  }

  // One side is a plain object and the other is missing/scalar: descend into
  // the object so the reported paths point at leaves, not the subtree root.
  // (e.g. adding `{ indexer: { model: "x" } }` from `{}` yields `/indexer/model`
  // rather than `/indexer`.)
  if (isPlainObject(before) && !isPlainObject(after)) {
    return collectLeaves(before, prefix);
  }
  if (!isPlainObject(before) && isPlainObject(after)) {
    return collectLeaves(after, prefix);
  }

  return prefix === "" ? [] : [prefix];
}

function collectLeaves(obj: Record<string, unknown>, prefix: string): string[] {
  const out: string[] = [];
  for (const key of Object.keys(obj)) {
    const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
    const next = `${prefix}/${escaped}`;
    const value = obj[key];
    if (isPlainObject(value)) {
      out.push(...collectLeaves(value, next));
    } else {
      out.push(next);
    }
  }
  // An empty object at a leaf position reports itself so the change is visible.
  if (out.length === 0 && prefix !== "") out.push(prefix);
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
        return false;
    }
    return true;
  }
  return false;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    Object.getPrototypeOf(x) === Object.prototype
  );
}

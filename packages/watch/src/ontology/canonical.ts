// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A value as text that depends on what it contains and nothing else.
 *
 * Both hashes taken over the ontology use it — the install-wide fingerprint the
 * gateway stamps onto a watch, and the referenced-surface digest a watch is
 * re-stamped against — and they have to agree about what "unchanged" means or
 * one of them will see a change the other cannot.
 *
 * `JSON.stringify` preserves the order keys were inserted in, so two objects
 * carrying identical content serialize differently when they were built in a
 * different order — and hashing that makes a fingerprint a function of the
 * surface *and* of however the layer underneath happened to assemble it.
 *
 * Which is not hypothetical. The analytics catalog returns a column sometimes
 * as `{name, type, description}` and sometimes as `{type, name, description}`.
 * Nothing about the install had changed, but the fingerprint moved — and a
 * fingerprint that moves is a fingerprint that pauses every watch in the
 * install, with a note saying the ontology it validated against has changed.
 *
 * Arrays keep their order, because order in an array is content: a table's
 * column order is part of what the table is.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, held]) => `${JSON.stringify(key)}:${canonicalJson(held)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The half of a source entry a watch's meaning depends on.
 *
 * `providerId` is deliberately not in it. It is read from the corpus rather
 * than declared, so it appears the moment a source produces its first document
 * — and anything hashing it moves on an ordinary sync. The install-wide
 * fingerprint learned that the hard way and excludes it; both hashes taken
 * over a source project through here so they cannot come to disagree about
 * what "the source changed" means.
 */
export function declaredSource(source: {
  readonly sourceId: string;
  readonly semanticallyIndexed: boolean;
  readonly profile: unknown;
}): unknown {
  return {
    sourceId: source.sourceId,
    semanticallyIndexed: source.semanticallyIndexed,
    profile: source.profile,
  };
}

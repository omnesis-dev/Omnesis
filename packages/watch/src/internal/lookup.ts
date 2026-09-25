// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Own-property lookup for tables keyed by parsed input.
 *
 * Every "is this a declared field / a known unit / a legal function" table in
 * this package is indexed with a name that came out of a watch document, and a
 * plain `table[key]` walks the prototype chain: `constructor`, `toString` and
 * `__proto__` all resolve to something truthy on an object literal. That turns
 * an unknown-field check into a check that silently passes — and then hands the
 * caller a function where it expected a type.
 *
 * Use this at every such site. It is the single reason the "unknown X"
 * diagnostics can be trusted.
 */
export function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

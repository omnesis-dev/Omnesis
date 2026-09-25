// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The SQL half of the source addressing rule, and its in-memory twin.
 *
 * `sourceIdAddresses` states the rule: a bare type covers every account of
 * that type, a qualified id covers exactly itself. SQL cannot call it, so this
 * module transcribes it once. Transcribed per caller instead, the copies drift
 * — one omits `ESCAPE`, another widens a qualified name into a prefix scan —
 * and because each is reached by a different caller, no single test can show
 * that they disagree.
 *
 * Both halves live here because the pairing is only checkable by reading them
 * together, and a query that widens where the predicate does not is how rows
 * the caller never named get deleted.
 */

import { sourceIdAddresses } from "@omnesis/types";
import { escapeLike } from "./repositories/person-match.js";

/**
 * A clause matching `column` against every id in `prefixes`, with the
 * parameters it binds.
 *
 * The clause is self-bracketing: an empty list yields `0` (false for every
 * row, so naming nothing selects nothing) and anything else yields one
 * parenthesised group. A caller can therefore splice it straight after `AND`
 * or `AND NOT` without knowing whether it expanded to one term or ten — an
 * unbracketed `a OR b` spliced after `AND` binds as `(x AND a) OR b` and
 * matches rows nobody named.
 *
 * A bare type becomes an equality plus a `type:%` scan; the pattern is escaped
 * because `_` and `%` in a literal are wildcards to LIKE, and a type that
 * widens its own pattern matches source ids it does not name. A qualified id
 * becomes the equality alone — appending `:%` to it would match a *different*
 * account, since `parseSourceId` splits on the first colon and everything after
 * it, colons included, is one account id.
 */
export function sourcePrefixPredicate(
  column: string,
  prefixes: readonly string[],
): { sql: string; params: string[] } {
  if (prefixes.length === 0) return { sql: "0", params: [] };
  const clauses: string[] = [];
  const params: string[] = [];
  for (const prefix of prefixes) {
    if (prefix.includes(":")) {
      clauses.push(`(${column} = ?)`);
      params.push(prefix);
      continue;
    }
    clauses.push(`(${column} = ? OR ${column} LIKE ? ESCAPE '\\')`);
    params.push(prefix, `${escapeLike(prefix)}:%`);
  }
  return { sql: `(${clauses.join(" OR ")})`, params };
}

/** The in-memory half of {@link sourcePrefixPredicate}. */
export function sourceMatchesAnyPrefix(sourceId: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => sourceIdAddresses(prefix, sourceId));
}

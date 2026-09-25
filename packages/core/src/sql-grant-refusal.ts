// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a source-scoped SQL grant refused, and how to say it.
 *
 * A statement run on a source's behalf reaches only the tables that source
 * owns. Everything else the gate can refuse — a table belonging to another
 * source, a table function, a bare `SHOW`, a stored macro — is carried
 * separately, because they are different things to stop doing.
 *
 * Both refusals in the tree (the gateway's own gate, and the port an agent
 * tool calls) carry exactly these four, so the sentence is written once and
 * every caller reads the same words for the same refusal.
 */
export interface SqlGrantRefusal {
  /** Table names as the caller typed them. */
  readonly tables: readonly string[];
  /** Table-function names as the caller typed them. */
  readonly tableFunctions: readonly string[];
  /** Engine `SHOW` kinds refused — an internal enum, not a caller's word. */
  readonly shows: readonly string[];
  /** Stored-macro names the statement tried to call, as typed. */
  readonly macros: readonly string[];
}

/**
 * State the refusal in one sentence, per category.
 *
 * The categories stay apart because a flat list would claim a table was
 * touched when the only thing refused was a table function. What each name
 * says is bounded: a table or a function is the caller's own token quoted
 * back, so naming it discloses nothing they did not just type, and a refused
 * table reads the same whether it belongs to another source or does not
 * exist — the gate does not hand a restricted caller an existence oracle.
 */
export function describeSqlGrantRefusal(refusal: SqlGrantRefusal): string {
  const parts: string[] = [];
  if (refusal.tables.length > 0) {
    parts.push(`tables outside this grant: ${refusal.tables.join(", ")}`);
  }
  if (refusal.tableFunctions.length > 0) {
    parts.push(`table functions this grant cannot call: ${refusal.tableFunctions.join(", ")}`);
  }
  if (refusal.shows.length > 0) {
    parts.push(`SHOW statements this grant cannot run: ${refusal.shows.join(", ")}`);
  }
  if (refusal.macros.length > 0) {
    parts.push(`stored macros this grant cannot call: ${refusal.macros.join(", ")}`);
  }
  return (
    `This grant does not include ${parts.join("; ")}. ` +
    `Query only tables from its permitted sources, without table functions, SHOW, or macros.`
  );
}

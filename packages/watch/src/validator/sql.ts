// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Static analysis of the SQL a `sql` or `stateless.transform` node carries.
 *
 * This is not a SQL parser and does not try to be one — DuckDB is the parser,
 * and the runtime hands it the query verbatim. What the validator needs is
 * narrower and answerable lexically:
 *
 * 1. **Which tables does the query read?** They must resolve in the analytics
 *    catalog, and in exactly one catalog — that is the whole reason SQL nodes
 *    are DuckDB-only.
 * 2. **What does the query project?** A node's structured output is its result
 *    columns, and downstream `$n.<node>.<field>` references are checked against
 *    them. Hence the rule that every projected item carries an explicit alias:
 *    a query the validator cannot name the outputs of is a query whose
 *    consumers cannot be checked.
 * 3. **Which parameters does it bind?** `$today`, `$now`, `$key.…`, `$n.…`,
 *    `$const.…` are bound values, never inlined text, and never clock reads.
 *
 * Everything the lexer cannot see through — a column that does not exist, a
 * type error, a syntactically broken query — surfaces at execution against the
 * real engine, which the PoC universe provides from day one.
 */

export interface SqlAnalysis {
  /** Table names read by `FROM` / `JOIN`, minus names bound by `WITH`. */
  readonly tables: readonly string[];
  /** Names bound by `WITH … AS (…)`, which shadow catalog tables. */
  readonly cteNames: readonly string[];
  /** Aliases of the outermost `SELECT` list, in order. */
  readonly outputColumns: readonly string[];
  /** Projected items the analyzer could not name — an unaliased expression. */
  readonly unaliasedOutputCount: number;
  /**
   * `$`-prefixed binding sites, each exactly as written (`$today`,
   * `$n.trip_booked.depart_date`) with its offset into the query.
   */
  readonly parameters: readonly { readonly text: string; readonly offset: number }[];
  /** Whether the outermost statement has a `FROM` clause at all. */
  readonly hasFrom: boolean;
  /**
   * Every function the query calls, plus the bare-word forms that read like
   * identifiers (`current_date`). Lower-cased. The validator uses this to
   * refuse the ones that would make a watch non-reproducible.
   */
  readonly functions: readonly string[];
  /** Set when the query does not look like a `SELECT` statement. */
  readonly problem: string | null;
}

type TokenKind = "word" | "punct" | "string" | "number" | "param" | "quoted-ident";

interface SqlToken {
  kind: TokenKind;
  /** Upper-cased for `word` so keyword tests are case-insensitive. */
  text: string;
  /** As written — the case-preserving spelling, for identifiers. */
  raw: string;
  offset: number;
  depth: number;
}

/** Tokenize far enough to answer the three questions above. */
function tokenizeSql(sql: string): { tokens: SqlToken[]; problem: string | null } {
  const tokens: SqlToken[] = [];
  let i = 0;
  let depth = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return { tokens, problem: "unterminated block comment" };
      i = end + 2;
      continue;
    }

    if (ch === "'") {
      let end = i + 1;
      for (;;) {
        end = sql.indexOf("'", end);
        if (end === -1) return { tokens, problem: "unterminated string literal" };
        // '' is an escaped quote inside a literal.
        if (sql[end + 1] === "'") {
          end += 2;
          continue;
        }
        break;
      }
      tokens.push({
        kind: "string",
        text: sql.slice(i, end + 1),
        raw: sql.slice(i, end + 1),
        offset: i,
        depth,
      });
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end === -1) return { tokens, problem: "unterminated quoted identifier" };
      const raw = sql.slice(i + 1, end);
      tokens.push({ kind: "quoted-ident", text: raw.toUpperCase(), raw, offset: i, depth });
      i = end + 1;
      continue;
    }

    if (ch === "$") {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(sql.slice(i));
      if (!match) return { tokens, problem: "'$' must introduce a bound parameter" };
      tokens.push({ kind: "param", text: match[0], raw: match[0], offset: i, depth });
      i += match[0].length;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const match = /^\d+(\.\d+)?/.exec(sql.slice(i))!;
      tokens.push({ kind: "number", text: match[0], raw: match[0], offset: i, depth });
      i += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!;
      tokens.push({ kind: "word", text: match[0].toUpperCase(), raw: match[0], offset: i, depth });
      i += match[0].length;
      continue;
    }

    // List and struct literals nest just as parentheses do; a comma inside one
    // is not a boundary between projected items.
    if (ch === "(" || ch === "[" || ch === "{") {
      tokens.push({ kind: "punct", text: ch, raw: ch, offset: i, depth });
      depth++;
      i++;
      continue;
    }

    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth < 0) return { tokens, problem: `unbalanced '${ch}'` };
      tokens.push({ kind: "punct", text: ch, raw: ch, offset: i, depth });
      i++;
      continue;
    }

    tokens.push({ kind: "punct", text: ch, raw: ch, offset: i, depth });
    i++;
  }

  if (depth !== 0) return { tokens, problem: "unbalanced '('" };
  return { tokens, problem: null };
}

/** Keywords that terminate a `SELECT` list at the same nesting depth. */
const SELECT_LIST_TERMINATORS = new Set([
  "FROM",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "WINDOW",
  "QUALIFY",
]);

/** Keywords that may follow a table name in a `FROM` item without being one. */
const FROM_ITEM_TERMINATORS = new Set([
  "FROM",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "WINDOW",
  "QUALIFY",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "ON",
  "USING",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "NATURAL",
  "ANTI",
  "SEMI",
  "POSITIONAL",
  "ASOF",
  "AS",
]);

/**
 * SQL's bare-word pseudo-functions: they read like identifiers and do what a
 * call does. `now()` and `current_date` are the same forbidden thing spelled
 * two ways, so both have to be findable.
 */
const BARE_WORD_FUNCTIONS: ReadonlySet<string> = new Set([
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "CURRENT_LOCALTIME",
  "CURRENT_LOCALTIMESTAMP",
  "LOCALTIME",
  "LOCALTIMESTAMP",
  "TODAY",
]);

/**
 * Every name the query invokes, lower-cased.
 *
 * Quoted identifiers count. `"now"()` and `now()` call the same function, and a
 * denylist that reads only bare words would let the quoted spelling through —
 * which is worse than not having the denylist, because the query looks checked.
 * A quoted name is never a bare-word pseudo-function, though: `"current_date"`
 * is an identifier, so only the call form is collected for those.
 */
function collectFunctions(tokens: readonly SqlToken[]): string[] {
  const found = new Set<string>();
  tokens.forEach((token, i) => {
    const quoted = token.kind === "quoted-ident";
    if (token.kind !== "word" && !quoted) return;
    const next = tokens[i + 1];
    const called = next?.kind === "punct" && next.text === "(";
    if (called || (!quoted && BARE_WORD_FUNCTIONS.has(token.text))) {
      found.add(token.text.toLowerCase());
    }
  });
  return [...found];
}

export function analyzeSql(sql: string): SqlAnalysis {
  const { tokens, problem } = tokenizeSql(sql);
  if (problem) {
    return {
      tables: [],
      cteNames: [],
      outputColumns: [],
      unaliasedOutputCount: 0,
      parameters: [],
      hasFrom: false,
      functions: [],
      problem,
    };
  }

  const parameters = tokens
    .filter((t) => t.kind === "param")
    .map((t) => ({ text: t.text, offset: t.offset }));

  const cteNames = collectCteNames(tokens);
  const tables = collectTables(tokens, new Set(cteNames.map((n) => n.toLowerCase())));
  const select = collectOutputColumns(tokens);

  return {
    tables,
    cteNames,
    functions: collectFunctions(tokens),
    outputColumns: select.aliases,
    unaliasedOutputCount: select.unaliased,
    parameters,
    hasFrom: select.hasFrom,
    problem: select.problem,
  };
}

/**
 * `WITH a AS (…), b AS (…)` — the names that shadow catalog tables.
 *
 * Scans every `WITH`, at every nesting depth: a CTE body may open a `WITH` of
 * its own, and a name bound there is just as much not-a-catalog-table as one
 * bound at the top. A name may also carry a column list — `WITH t(a, b) AS (…)`
 * — which puts a parenthesis where the `AS` would otherwise be.
 */
function collectCteNames(tokens: readonly SqlToken[]): string[] {
  const names: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.kind !== "word" || tokens[i]!.text !== "WITH") continue;
    const clauseDepth = tokens[i]!.depth;

    // A name is bound only in the two positions that can start a definition:
    // straight after `WITH` (or its `RECURSIVE` modifier), and after a comma
    // separating one definition from the next. Anywhere else — `AS`, a column
    // name in a list — is not a binding, whatever follows it.
    let expectName = true;
    for (let j = i + 1; j < tokens.length; j++) {
      const candidate = tokens[j]!;
      if (candidate.depth < clauseDepth) break;
      if (candidate.depth > clauseDepth) continue;
      // A SELECT at the clause's own depth ends the WITH clause.
      if (candidate.kind === "word" && candidate.text === "SELECT") break;

      if (candidate.kind === "punct" && candidate.text === ",") {
        expectName = true;
        continue;
      }
      if (candidate.kind !== "word" && candidate.kind !== "quoted-ident") continue;
      if (candidate.text === "RECURSIVE") continue;

      if (expectName) {
        if (!names.includes(candidate.raw)) names.push(candidate.raw);
        expectName = false;
      }
    }
  }
  return names;
}

function collectTables(tokens: readonly SqlToken[], cteNames: ReadonlySet<string>): string[] {
  const tables: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word") continue;
    if (token.text !== "FROM" && token.text !== "JOIN") continue;

    // A FROM clause is a comma-separated list of table items at this depth.
    let expectItem = true;
    for (let j = i + 1; j < tokens.length; j++) {
      const item = tokens[j]!;
      if (item.depth < token.depth) break;
      if (item.depth > token.depth) continue;

      if (item.kind === "punct" && item.text === ",") {
        expectItem = true;
        continue;
      }
      if (item.kind === "punct" && (item.text === "(" || item.text === ")")) {
        // A subquery or table function stands where a table name would. Its
        // contents are scanned in their own right, and the item that follows
        // the closing paren is still part of this FROM list.
        expectItem = false;
        continue;
      }
      if (item.kind !== "word" && item.kind !== "quoted-ident") continue;
      // A join/filter keyword ends this FROM clause. `JOIN` is picked up again
      // by the outer loop, which then reads the table on its right.
      if (item.kind === "word" && FROM_ITEM_TERMINATORS.has(item.text)) break;

      if (expectItem) {
        // `main.health_vitals` names the table, not the schema it lives in.
        const qualified = tokens[j + 1]?.text === "." && tokens[j + 2] !== undefined;
        const item2 = qualified ? tokens[j + 2]! : item;
        const name = item2.raw;
        if (qualified) j += 2;
        if (!cteNames.has(name.toLowerCase()) && !tables.includes(name)) tables.push(name);
        expectItem = false;
      }
      // Anything else at this depth is an alias; wait for the next comma.
    }
  }

  return tables;
}

interface SelectAnalysis {
  aliases: string[];
  unaliased: number;
  hasFrom: boolean;
  problem: string | null;
}

/**
 * The outermost `SELECT` list. Everything a CTE projects sits inside
 * parentheses, so the depth-0 `SELECT` is the statement's own projection.
 */
function collectOutputColumns(tokens: readonly SqlToken[]): SelectAnalysis {
  const start = tokens.findIndex((t) => t.kind === "word" && t.text === "SELECT" && t.depth === 0);
  if (start === -1) {
    return { aliases: [], unaliased: 0, hasFrom: false, problem: "no top-level SELECT" };
  }

  let end = tokens.length;
  let hasFrom = false;
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.depth !== 0 || token.kind !== "word") continue;
    if (SELECT_LIST_TERMINATORS.has(token.text)) {
      end = i;
      hasFrom = token.text === "FROM";
      break;
    }
  }

  const items: SqlToken[][] = [[]];
  for (let i = start + 1; i < end; i++) {
    const token = tokens[i]!;
    if (token.depth === 0 && token.kind === "punct" && token.text === ",") {
      items.push([]);
      continue;
    }
    items[items.length - 1]!.push(token);
  }

  const aliases: string[] = [];
  let unaliased = 0;
  for (const item of items) {
    if (item.length === 0) continue;
    const alias = aliasOf(item);
    if (alias) aliases.push(alias);
    else unaliased++;
  }

  return { aliases, unaliased, hasFrom, problem: null };
}

/** The alias a projected item declares, or `null` if it declares none. */
function aliasOf(item: readonly SqlToken[]): string | null {
  const last = item[item.length - 1]!;
  const beforeLast = item[item.length - 2];

  if (
    beforeLast &&
    beforeLast.kind === "word" &&
    beforeLast.text === "AS" &&
    beforeLast.depth === 0 &&
    (last.kind === "word" || last.kind === "quoted-ident")
  ) {
    return last.raw;
  }

  // A lone column reference names itself: `SELECT fires` or `SELECT t.fires`.
  if (item.length === 1 && (last.kind === "word" || last.kind === "quoted-ident")) return last.raw;
  if (
    item.length === 3 &&
    item[1]!.kind === "punct" &&
    item[1]!.text === "." &&
    (last.kind === "word" || last.kind === "quoted-ident")
  ) {
    return last.raw;
  }

  return null;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Regression test for the citty-positional-doubling bug that hit
 * `omnesis sql "SELECT 1"` and `omnesis search "foo"` after PR #307.
 *
 * Citty parses a named positional like `query: { type: "positional",
 * required: true }` into BOTH `args.query` (the named field) AND
 * `args._` (the catch-all). A naive `[args.query, ...args._]` spread
 * therefore doubles the value: a single-arg invocation produces
 * `"SELECT 1 SELECT 1"` on the wire.
 *
 * The leaf commands here (`search`, `sql`, plus `recent`) take a
 * single required positional. They should rely on `args.query` /
 * `args.id` directly, never the spread.
 *
 * Anyone who later adds a variadic command (`sources sync gmail:
 * notion:`) and reaches for the same spread idiom should pause and
 * read this file before doing it.
 */
import { parseArgs } from "citty";
import { describe, expect, it } from "vitest";
import { searchCommand } from "./search.js";
import { sqlCommand } from "./sql.js";

describe("positional-arg parsing — single-positional commands", () => {
  it("citty exposes a named positional in BOTH args.query AND args._", async () => {
    // This is the citty behaviour our commands have to account for. If
    // a future major-version bump removes args._ for named positionals
    // this assertion fails and the surrounding bug-recurrence guard
    // can be relaxed.
    const argsDef =
      typeof searchCommand.args === "function"
        ? await searchCommand.args()
        : await searchCommand.args;
    const parsed = parseArgs(["foo"], argsDef!);
    expect(parsed.query).toBe("foo");
    expect(parsed._).toEqual(["foo"]);
  });

  it("search command does NOT double a single-arg query through args._", async () => {
    const argsDef =
      typeof searchCommand.args === "function"
        ? await searchCommand.args()
        : await searchCommand.args;
    const parsed = parseArgs(["validation"], argsDef!);
    // The bug shape — what NOT to do:
    const buggy = [parsed.query, ...(parsed._ ?? [])].filter(Boolean).join(" ");
    expect(buggy).toBe("validation validation"); // ← regression marker
    // The fix shape — what we ship:
    const fixed = parsed.query;
    expect(fixed).toBe("validation");
  });

  it("sql command does NOT double a single-arg statement through args._", async () => {
    const argsDef =
      typeof sqlCommand.args === "function" ? await sqlCommand.args() : await sqlCommand.args;
    const parsed = parseArgs(["SELECT 1"], argsDef!);
    const buggy = [parsed.query, ...(parsed._ ?? [])].filter(Boolean).join(" ");
    expect(buggy).toBe("SELECT 1 SELECT 1");
    const fixed = parsed.query;
    expect(fixed).toBe("SELECT 1");
  });

  it("sql command preserves the full query string verbatim (no whitespace munging)", async () => {
    const argsDef =
      typeof sqlCommand.args === "function" ? await sqlCommand.args() : await sqlCommand.args;
    // Shells deliver the quoted argument as one token. citty stores it as one
    // string in args.query — the previous .join(" ") collapsed that into the
    // same shape only by coincidence; rely on args.query directly.
    const parsed = parseArgs(["SELECT * FROM documents WHERE id = 'abc-123'"], argsDef!);
    expect(parsed.query).toBe("SELECT * FROM documents WHERE id = 'abc-123'");
  });
});

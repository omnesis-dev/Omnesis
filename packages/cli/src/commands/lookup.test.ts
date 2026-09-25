// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseArgs } from "citty";
import { describe, expect, it } from "vitest";
import { lookupCommand } from "./lookup.js";

describe("lookup command — arg parsing", () => {
  it("parses a single URL positional verbatim (colons, slashes, query string preserved)", async () => {
    const argsDef =
      typeof lookupCommand.args === "function"
        ? await lookupCommand.args()
        : await lookupCommand.args;
    const url =
      "https://docs.google.com/document/d/1ybl47iZVfBC67hiRqX8nWRMMxrl2FeSLWMkBH0FN4cU/edit?tab=t.0";
    const parsed = parseArgs([url], argsDef!);
    expect(parsed.url).toBe(url);
  });

  it("treats the URL as a single token even when it contains characters citty might split on", async () => {
    // Regression guard: see commands/positional-args.test.ts — citty
    // exposes named positionals in BOTH `args.url` and `args._`. The
    // command body must read `args.url` directly, never spread `args._`,
    // otherwise the wire request doubles the URL.
    const argsDef =
      typeof lookupCommand.args === "function"
        ? await lookupCommand.args()
        : await lookupCommand.args;
    const url = "https://mail.google.com/mail/u/0/#inbox/abc123";
    const parsed = parseArgs([url], argsDef!);
    expect(parsed.url).toBe(url);
    expect(parsed._).toEqual([url]);
    const buggy = [parsed.url, ...(parsed._ ?? [])].filter(Boolean).join(" ");
    expect(buggy).toBe(`${url} ${url}`); // bug shape — what NOT to ship
    expect(parsed.url).toBe(url); // fix shape — what we ship
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// The portal's stylesheet, as a parser sees it.
//
// A CSS rule left unclosed does not fail loudly: the browser swallows the rest
// of the file as declarations of that rule and drops every rule after it. The
// page still renders — just unstyled from that byte on, which reads as a
// layout bug in whichever view happens to sit lowest in the file rather than as
// a broken stylesheet. Nothing else in this repo would notice: the portal has
// no build step to parse it and no test mounts a real browser.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const STYLESHEET = fileURLToPath(new URL("../css/style.css", import.meta.url));

/**
 * Braces that a parser would count, with the places one can legally appear
 * without opening a block blanked out: comments, and quoted strings such as a
 * `content: "}"`. Blanked rather than removed so a reported line number still
 * points at the line the reader has to look at.
 */
function significant(css: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return css
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, blank)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, blank);
}

describe("the portal stylesheet", () => {
  const css = significant(readFileSync(STYLESHEET, "utf8"));

  test("lets the agent landing wash span the full content grid width", () => {
    const declarations = /\.app-main:has\(> \.agent-page-hero\)\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(declarations).toMatch(/\bmax-width:\s*none\s*;/);
  });

  test("closes every rule it opens", () => {
    let depth = 0;
    let line = 1;
    // Where the outermost block currently open was opened. Reported on failure,
    // because the unclosed brace is the useful location — the end of the file
    // is where the symptom is, not where the mistake is.
    let openedAt: number | null = null;
    for (const character of css) {
      if (character === "\n") line += 1;
      else if (character === "{") {
        if (depth === 0) openedAt = line;
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        expect(depth, `an extra closing brace on line ${line}`).toBeGreaterThanOrEqual(0);
        if (depth === 0) openedAt = null;
      }
    }
    expect(
      depth,
      `a rule opened on line ${openedAt} is never closed — every rule after it is dropped`,
    ).toBe(0);
  });

  test("never opens a section divider inside a rule", () => {
    // The way the rule above comes to be left open: a block of new rules is
    // spliced in at a section boundary and lands *inside* the last rule of the
    // previous section, swallowing its closing brace. The braces can even come
    // back into balance — the new block's own closing brace pairs with the old
    // rule's opening one — and then the damage is silent and different: the old
    // rule quietly loses its trailing declarations to the new one.
    //
    // A divider is written at the top level by construction, so finding one
    // while a rule is open catches the splice itself rather than either of the
    // two shapes it can settle into.
    const lines = readFileSync(STYLESHEET, "utf8").split("\n");
    let depth = 0;
    const inside: number[] = [];
    lines.forEach((line, index) => {
      if (depth > 0 && line.includes("/* ──")) inside.push(index + 1);
      for (const character of significant(line)) {
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
      }
    });
    expect(inside, `section dividers opened inside a rule, on line(s) ${inside.join(", ")}`).toEqual(
      [],
    );
  });
});

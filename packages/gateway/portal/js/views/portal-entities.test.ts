// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * htm renders template text literally: it is a tagged template, not an HTML
 * parser, so `&middot;` reaches the DOM as those eight characters rather than
 * as `·`. Every portal view is authored in htm, which makes an HTML entity in
 * a template a rendering bug that no type checker or linter sees — and one
 * that reads as a typo to whoever notices it on screen.
 *
 * This shipped once. The evidence was even in a test failure's output
 * ("Budgettoday &middot; 2026-08-24") and was read straight past, so the guard
 * is a test rather than a habit.
 *
 * Escaping helpers are the legitimate exception: a function whose job is to
 * PRODUCE entities for an HTML string is not a template.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const VIEWS = new URL(".", import.meta.url).pathname;
const LIB = join(VIEWS, "..", "lib");

/** Files whose purpose is to emit entities, not to render them. */
const ESCAPERS = new Set(["sql-editor.js", "file-type-icons.js"]);

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? jsFiles(join(dir, entry.name))
      : entry.name.endsWith(".js")
        ? [join(dir, entry.name)]
        : [],
  );
}

describe("portal templates carry no HTML entities", () => {
  it("uses real characters, because htm does not decode entities", () => {
    const offenders: string[] = [];
    for (const file of [...jsFiles(VIEWS), ...jsFiles(LIB)]) {
      const name = file.split("/").pop()!;
      if (ESCAPERS.has(name)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = line.match(/&(?:[a-z]+|#\d+);/i);
          if (m) offenders.push(`${name}:${i + 1}  ${m[0]}  →  ${line.trim().slice(0, 70)}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

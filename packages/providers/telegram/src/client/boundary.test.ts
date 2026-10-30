// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The adapter boundary is a rule, not a habit: only `client/mtcute/` may import
 * mtcute, so the provider stays testable against the simulation and the client
 * library stays replaceable.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
const ALLOWED = join(SRC, "client", "mtcute");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("the mtcute boundary", () => {
  it("is crossed only from src/client/mtcute", () => {
    const offenders = sources(SRC)
      .filter((path) => !path.startsWith(ALLOWED))
      .filter((path) =>
        /from\s+["']@mtcute\/|import\(\s*["']@mtcute\//u.test(readFileSync(path, "utf8")),
      )
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it("is actually crossed there, so the check above is not vacuous", () => {
    const adapter = readFileSync(join(ALLOWED, "adapter.ts"), "utf8");
    expect(adapter).toMatch(/from "@mtcute\/node"/u);
  });
});

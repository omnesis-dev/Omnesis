// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { nodePathProbe } from "./path-probe-node.js";

// Root reads everything, so a closed folder proves nothing when run as root.
const asRoot = process.getuid?.() === 0;

describe("nodePathProbe.readable", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function folder(): string {
    const dir = mkdtempSync(join(tmpdir(), "path-probe-"));
    dirs.push(dir);
    return dir;
  }

  test("an open folder and file are readable", () => {
    const dir = folder();
    writeFileSync(join(dir, "note.md"), "fictional");
    expect(nodePathProbe.readable!(dir)).toBe(true);
    expect(nodePathProbe.readable!(join(dir, "note.md"))).toBe(true);
  });

  test.skipIf(asRoot)("a folder closed to the process is not", () => {
    const dir = folder();
    chmodSync(dir, 0o000);
    expect(nodePathProbe.readable!(dir)).toBe(false);
  });

  test("a path that is gone is not", () => {
    expect(nodePathProbe.readable!(join(folder(), "missing"))).toBe(false);
  });
});

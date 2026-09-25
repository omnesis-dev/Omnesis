// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EMBEDDING_DIM } from "./db.js";
import { UsearchWriteHandle } from "./usearch-index.js";
import { quarantineCorruptUsearch } from "./usearch-boot-guard.js";

describe("quarantineCorruptUsearch", () => {
  const dirs: string[] = [];
  function tmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), "usearch-guard-"));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  test("absent file is a no-op", () => {
    const dir = tmpDir();
    expect(quarantineCorruptUsearch(join(dir, "nope.usearch"), EMBEDDING_DIM)).toBe("absent");
  });

  test("a valid sidecar is left in place", () => {
    const dir = tmpDir();
    const path = join(dir, "good.usearch");
    const h = new UsearchWriteHandle(path, EMBEDDING_DIM);
    const v = new Float32Array(EMBEDDING_DIM);
    v[0] = 1;
    h.add(1n, v);
    h.add(2n, v);
    h.save();
    h.close();

    expect(quarantineCorruptUsearch(path, EMBEDDING_DIM)).toBe("ok");
    expect(existsSync(path)).toBe(true);
  });

  test("a corrupt sidecar is quarantined without crashing the caller", () => {
    // These bytes declare enormous vector counts to the allocating loader.
    // The mapped validator must reject the impossible matrix span first,
    // allowing quarantine without an unbounded native allocation.
    const dir = tmpDir();
    const path = join(dir, "garbage.usearch");
    writeFileSync(path, Buffer.from("not a usearch index — random bytes ".repeat(64)));

    expect(quarantineCorruptUsearch(path, EMBEDDING_DIM)).toBe("quarantined");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("garbage.usearch.corrupt-"))).toBe(true);
  });

  test("an oversized matrix declaration in a tiny file is quarantined", () => {
    const dir = tmpDir();
    const path = join(dir, "oversized.usearch");
    const header = Buffer.alloc(8);
    header.writeUInt32LE(0xffffffff, 0);
    header.writeUInt32LE(0xffffffff, 4);
    writeFileSync(path, header);

    expect(quarantineCorruptUsearch(path, EMBEDDING_DIM)).toBe("quarantined");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("oversized.usearch.corrupt-"))).toBe(true);
  });

  test("a wrong-dimension sidecar is quarantined", () => {
    const dir = tmpDir();
    const path = join(dir, "wrongdim.usearch");
    const h = new UsearchWriteHandle(path, EMBEDDING_DIM);
    const v = new Float32Array(EMBEDDING_DIM);
    v[0] = 1;
    h.add(1n, v);
    h.save();
    h.close();

    // Validating at a different dimension than the file was written at fails.
    expect(quarantineCorruptUsearch(path, EMBEDDING_DIM + 128)).toBe("quarantined");
    expect(existsSync(path)).toBe(false);
  });
});

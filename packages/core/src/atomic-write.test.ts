// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { atomicWriteFile, atomicWriteFileSync } from "./atomic-write.js";

describe("atomic writes", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-atomic-write-test-"));
    path = join(dir, "value.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function scratchFiles(): string[] {
    return readdirSync(dir).filter((name) => name !== "value.json");
  }

  test("writes the payload and applies the requested mode", async () => {
    await atomicWriteFile(path, "async", { mode: 0o600 });
    expect(readFileSync(path, "utf8")).toBe("async");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    atomicWriteFileSync(path, "sync", { mode: 0o600 });
    expect(readFileSync(path, "utf8")).toBe("sync");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("leaves no scratch file behind", async () => {
    await atomicWriteFile(path, "async");
    atomicWriteFileSync(path, "sync");
    expect(scratchFiles()).toEqual([]);
  });

  test("writes binary payloads byte for byte", async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x0a, 0x7f, 0x00]);
    await atomicWriteFile(path, bytes);
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);

    atomicWriteFileSync(path, bytes);
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
  });

  test("ensureDir creates the parent directory", async () => {
    const nested = join(dir, "a", "b", "value.json");
    await atomicWriteFile(nested, "nested", { ensureDir: true });
    expect(readFileSync(nested, "utf8")).toBe("nested");
  });

  // The bug this guards: with a scratch name shared by every writer, one
  // write renames the scratch file away while another is still chmod'ing
  // or fsync'ing it, and that one fails with ENOENT on a file it just
  // created. Concurrent writes to one path are the norm for OAuth token
  // caches rewritten from parallel in-flight API calls.
  test("concurrent writes to one path all succeed", async () => {
    const payloads = Array.from({ length: 32 }, (_, i) => `payload-${i}`);

    const results = await Promise.allSettled(
      payloads.map((payload) => atomicWriteFile(path, payload, { mode: 0o600, ensureDir: true })),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

    // Last writer wins, but the committed file is always exactly one of
    // the payloads — never a torn or empty intermediate.
    expect(payloads).toContain(readFileSync(path, "utf8"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(scratchFiles()).toEqual([]);
  });

  test("a failed write removes its own scratch file", async () => {
    // A non-empty directory where the payload should go makes rename(2)
    // fail — after the scratch file has been created and fsync'd, which
    // is the only ordering that exercises the cleanup.
    const blocked = join(dir, "blocked");
    await atomicWriteFile(join(blocked, "occupant"), "x", { ensureDir: true });

    await expect(atomicWriteFile(blocked, "payload")).rejects.toThrow(/ENOTEMPTY|EISDIR|EEXIST/);
    expect(() => atomicWriteFileSync(blocked, "payload")).toThrow(/ENOTEMPTY|EISDIR|EEXIST/);

    expect(readdirSync(dir).sort()).toEqual(["blocked"]);
    expect(readdirSync(blocked)).toEqual(["occupant"]);
  });

  test("scratch files from failing writes don't survive a concurrent batch", async () => {
    const blocked = join(dir, "blocked");
    await atomicWriteFile(join(blocked, "occupant"), "x", { ensureDir: true });

    // Half the writers target a path they can never rename onto. Their
    // scratch files land in the same directory as the succeeding ones, so
    // a cleanup that missed the concurrent case would strand them here.
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        atomicWriteFile(i % 2 === 0 ? path : blocked, `payload-${i}`, { mode: 0o600 }),
      ),
    );

    expect(results.filter((r) => r.status === "rejected")).toHaveLength(8);
    expect(scratchFiles()).toEqual(["blocked"]);
    expect(readdirSync(blocked)).toEqual(["occupant"]);
  });
});

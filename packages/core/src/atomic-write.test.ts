// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { atomicWriteFile, atomicWriteFileSync, fsyncFileSync } from "./atomic-write.js";

vi.mock("node:fs", async (actual) => ({ ...(await actual<typeof import("node:fs")>()) }));
vi.mock("node:fs/promises", async (actual) => ({
  ...(await actual<typeof import("node:fs/promises")>()),
}));

describe("atomic writes", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-atomic-write-test-"));
    path = join(dir, "value.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function scratchFiles(): string[] {
    return readdirSync(dir).filter((name) => name !== "value.json");
  }

  test("writes the payload through both entrypoints", async () => {
    await atomicWriteFile(path, "async", { mode: 0o600 });
    expect(readFileSync(path, "utf8")).toBe("async");

    atomicWriteFileSync(path, "sync", { mode: 0o600 });
    expect(readFileSync(path, "utf8")).toBe("sync");
  });

  test.runIf(process.platform !== "win32")("applies the requested POSIX mode", async () => {
    await atomicWriteFile(path, "async", { mode: 0o600 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    atomicWriteFileSync(path, "sync", { mode: 0o600 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("flushes read-only payloads through their creation handles", async () => {
    await atomicWriteFile(path, "async", { mode: 0o444 });
    expect(readFileSync(path, "utf8")).toBe("async");
    expect(statSync(path).mode & 0o200).toBe(0);
    const syncPath = join(dir, "read-only.txt");
    atomicWriteFileSync(syncPath, "sync", { mode: 0o444 });
    expect(readFileSync(syncPath, "utf8")).toBe("sync");
    expect(statSync(syncPath).mode & 0o200).toBe(0);
  });

  test("leaves no scratch file behind", async () => {
    await atomicWriteFile(path, "async");
    atomicWriteFileSync(path, "sync");
    expect(scratchFiles()).toEqual([]);
  });

  test("flushes an existing writable file without replacing its content", () => {
    fs.writeFileSync(path, "existing payload");
    fsyncFileSync(path);
    expect(readFileSync(path, "utf8")).toBe("existing payload");
  });

  test.each(["sync", "async"])(
    "a %s scratch collision preserves the existing file",
    async (kind) => {
      let collision = "";
      const error = Object.assign(new Error("EEXIST: scratch file already exists"), {
        code: "EEXIST",
      });
      const collide = (scratch: fs.PathLike): never => {
        collision = String(scratch);
        fs.writeFileSync(collision, "another writer's payload");
        throw error;
      };
      if (kind === "sync") {
        vi.spyOn(fs, "openSync").mockImplementationOnce(collide);
        expect(() => atomicWriteFileSync(path, "replacement")).toThrow(error);
      } else {
        vi.spyOn(fsp, "open").mockImplementationOnce(async (scratch) => collide(scratch));
        await expect(atomicWriteFile(path, "replacement")).rejects.toBe(error);
      }
      expect(readFileSync(collision, "utf8")).toBe("another writer's payload");
      expect(fs.existsSync(path)).toBe(false);
    },
  );

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
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(scratchFiles()).toEqual([]);
  });

  test("a failed write removes its own scratch file", async () => {
    // A non-empty directory where the payload should go makes rename(2)
    // fail — after the scratch file has been created and fsync'd, which
    // is the only ordering that exercises the cleanup.
    const blocked = join(dir, "blocked");
    await atomicWriteFile(join(blocked, "occupant"), "x", { ensureDir: true });

    await expect(atomicWriteFile(blocked, "payload")).rejects.toThrow(
      /ENOTEMPTY|EISDIR|EEXIST|EPERM/,
    );
    expect(() => atomicWriteFileSync(blocked, "payload")).toThrow(/ENOTEMPTY|EISDIR|EEXIST|EPERM/);

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

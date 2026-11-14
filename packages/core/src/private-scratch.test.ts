// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat as asyncLstat, writeFile as asyncWriteFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrivateScratch, createPrivateScratchAsync } from "./private-scratch.js";
import { openSqliteSnapshot } from "./sqlite-snapshot.js";

const state = vi.hoisted(() => ({ base: "", originalTmpdir: "" }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  state.originalTmpdir = actual.tmpdir();
  return { ...actual, tmpdir: () => state.base || actual.tmpdir() };
});

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync), writeFileSync: vi.fn(fs.writeFileSync) };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, lstat: vi.fn(fs.lstat), writeFile: vi.fn(fs.writeFile) };
});
beforeEach(async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs"),
    promises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(lstatSync).mockReset().mockImplementation(fs.lstatSync);
  vi.mocked(writeFileSync).mockReset().mockImplementation(fs.writeFileSync);
  vi.mocked(asyncLstat).mockReset().mockImplementation(promises.lstat);
  vi.mocked(asyncWriteFile).mockReset().mockImplementation(promises.writeFile);
});

function setup(): string {
  state.base = mkdtempSync(join(state.originalTmpdir || tmpdir(), "omnesis-scratch-test-"));
  return join(state.base, `omnesis-owned-scratch-${process.getuid?.() ?? "user"}`);
}
afterEach(() => {
  vi.restoreAllMocks();
  if (state.base) rmSync(state.base, { recursive: true, force: true });
  state.base = "";
});

describe("private scratch", () => {
  it.each(["sync", "async"] as const)(
    "%s recovery keeps a process-join fence after parent death and ordinary scratch remains reclaimable",
    async (kind) => {
      const root = setup();
      const guarded =
        kind === "sync"
          ? createPrivateScratch("guarded", { requiresProcessJoin: true })
          : await createPrivateScratchAsync("guarded", { requiresProcessJoin: true });
      const marker = ".process-join-required";
      expect(statSync(join(guarded.path, marker)).isFile()).toBe(true);
      if (process.platform !== "win32")
        expect(statSync(join(guarded.path, marker)).mode & 0o777).toBe(0o600);
      const ordinary = createPrivateScratch("ordinary");
      const retained = join(root, "2147483647-retained"),
        abandoned = join(root, "2147483647-ordinary");
      renameSync(guarded.path, retained);
      renameSync(ordinary.path, abandoned);
      writeFileSync(join(retained, "input"), "invented retained subprocess input");
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === 2147483647) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return kill(pid, signal);
      });
      const next =
        kind === "sync" ? createPrivateScratch("next") : await createPrivateScratchAsync("next");
      expect(existsSync(retained)).toBe(true);
      expect(existsSync(abandoned)).toBe(false);
      await Promise.resolve(next.cleanup());
      const joined =
        kind === "sync"
          ? createPrivateScratch("joined", { requiresProcessJoin: true })
          : await createPrivateScratchAsync("joined", { requiresProcessJoin: true });
      await Promise.resolve(joined.cleanup());
      expect(existsSync(joined.path)).toBe(false);
      // An odd marker is still a fence, never evidence of a completed process.
      rmSync(join(retained, marker));
      mkdirSync(join(retained, marker));
      const again =
        kind === "sync" ? createPrivateScratch("again") : await createPrivateScratchAsync("again");
      expect(existsSync(retained)).toBe(true);
      await Promise.resolve(again.cleanup());
      // A dangling marker still exists lexically; stat/exists would miss it.
      rmSync(join(retained, marker), { recursive: true, force: true });
      symlinkSync(join(state.base, "absent-marker-target"), join(retained, marker), "junction");
      expect(lstatSync(join(retained, marker)).isSymbolicLink()).toBe(true);
      const dangling =
        kind === "sync"
          ? createPrivateScratch("dangling")
          : await createPrivateScratchAsync("dangling");
      expect(existsSync(retained)).toBe(true);
      await Promise.resolve(dangling.cleanup());
    },
  );

  it.each(["sync", "async"] as const)(
    "%s recovery retains an entry when its join-fence metadata cannot be inspected",
    async (kind) => {
      const root = setup(),
        scratch = createPrivateScratch("guarded", { requiresProcessJoin: true }),
        retained = join(root, "2147483647-unreadable");
      renameSync(scratch.path, retained);
      const denied = Object.assign(new Error("Invented marker metadata refusal"), {
          code: "EACCES",
        }),
        kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === 2147483647) {
          if (kind === "sync")
            vi.mocked(lstatSync).mockImplementationOnce(() => {
              throw denied;
            });
          else vi.mocked(asyncLstat).mockRejectedValueOnce(denied);
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        return kill(pid, signal);
      });
      const next =
        kind === "sync" ? createPrivateScratch("next") : await createPrivateScratchAsync("next");
      expect(existsSync(retained)).toBe(true);
      await Promise.resolve(next.cleanup());
    },
  );

  it.each(["sync", "async"] as const)(
    "%s join-marker failure rejects before scratch can be returned to a child launcher",
    async (kind) => {
      const root = setup(),
        failure = new Error("Invented join marker write failure");
      if (kind === "sync") {
        vi.mocked(writeFileSync).mockImplementationOnce(() => {
          throw failure;
        });
        expect(() => createPrivateScratch("guarded", { requiresProcessJoin: true })).toThrow(
          failure,
        );
      } else {
        vi.mocked(asyncWriteFile).mockRejectedValueOnce(failure);
        await expect(
          createPrivateScratchAsync("guarded", { requiresProcessJoin: true }),
        ).rejects.toBe(failure);
      }
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it("asynchronously prepares private independent children and idempotent cleanup", async () => {
    const root = setup();
    const [first, second] = await Promise.all([
      createPrivateScratchAsync("ocr"),
      createPrivateScratchAsync("ocr"),
    ]);
    expect(first.path).not.toBe(second.path);
    if (process.platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(first.path).mode & 0o777).toBe(0o700);
    }
    writeFileSync(join(first.path, "plaintext"), "invented image bytes");
    await first.cleanup();
    await first.cleanup();
    expect(existsSync(second.path)).toBe(true);
    await second.cleanup();
    expect(readdirSync(root)).toEqual([]);
  });

  it("asynchronous preparation refuses a linked root before creating plaintext scratch", async () => {
    const root = setup();
    symlinkSync(state.base, root, "junction");
    await expect(createPrivateScratchAsync("ocr")).rejects.toThrow("Unsafe private scratch");
    expect(readdirSync(state.base)).toEqual([basename(root)]);
  });

  it("isolates concurrent operations and restricts directory permissions", () => {
    const root = setup();
    const first = createPrivateScratch("snapshot");
    const second = createPrivateScratch("snapshot");
    if (process.platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(first.path).mode & 0o777).toBe(0o700);
    }
    first.cleanup();
    first.cleanup();
    expect(existsSync(second.path)).toBe(true);
    second.cleanup();
    expect(readdirSync(root)).toEqual([]);
  });

  it("recovers only dead owners and never follows abandoned symlinks", () => {
    const root = setup();
    const current = createPrivateScratch("live");
    const abandoned = join(root, "2147483647-abandoned");
    mkdirSync(abandoned);
    writeFileSync(join(abandoned, "plaintext"), "fixture");
    const outside = join(state.base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "2147483647-link"), "junction");
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 2147483647) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return realKill(pid, signal);
    });
    createPrivateScratch("next").cleanup();
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(current.path)).toBe(true);
    current.cleanup();
  });

  it("retains owners when liveness cannot be established", () => {
    const root = setup();
    const current = createPrivateScratch("first");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    createPrivateScratch("next").cleanup();
    expect(existsSync(current.path)).toBe(true);
    expect(readdirSync(root)).toHaveLength(1);
  });

  it("refuses a symlinked scratch root before writing plaintext", () => {
    const root = setup();
    symlinkSync(state.base, root, "junction");
    expect(() => createPrivateScratch("snapshot")).toThrow("Unsafe private scratch");
  });

  it("cleans a failed snapshot copy and restricts DB plus sidecars", () => {
    const root = setup();
    expect(() => openSqliteSnapshot(join(state.base, "missing"))).toThrow();
    expect(readdirSync(root)).toEqual([]);
    const source = join(state.base, "source.db");
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      writeFileSync(source + suffix, "fixture", { mode: 0o644 });
    const snapshot = openSqliteSnapshot(source);
    if (process.platform !== "win32")
      for (const suffix of ["", "-wal", "-shm", "-journal"])
        expect(statSync(snapshot.path + suffix).mode & 0o777).toBe(0o600);
    snapshot.cleanup();
    expect(readdirSync(root)).toEqual([]);
  });
});

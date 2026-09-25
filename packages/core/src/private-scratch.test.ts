// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateScratch } from "./private-scratch.js";
import { openSqliteSnapshot } from "./sqlite-snapshot.js";

const state = vi.hoisted(() => ({ base: "" }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, tmpdir: () => state.base || actual.tmpdir() };
});

function setup(): string {
  state.base = mkdtempSync("/tmp/omnesis-scratch-test-");
  return join(state.base, `omnesis-owned-scratch-${process.getuid?.() ?? "user"}`);
}
afterEach(() => {
  vi.restoreAllMocks();
  if (state.base) rmSync(state.base, { recursive: true, force: true });
  state.base = "";
});

describe("private scratch", () => {
  it("isolates concurrent operations and restricts directory permissions", () => {
    const root = setup();
    const first = createPrivateScratch("snapshot");
    const second = createPrivateScratch("snapshot");
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(first.path).mode & 0o777).toBe(0o700);
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
    symlinkSync(outside, join(root, "2147483647-link"));
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
    symlinkSync(state.base, root);
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
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      expect(statSync(snapshot.path + suffix).mode & 0o777).toBe(0o600);
    snapshot.cleanup();
    expect(readdirSync(root)).toEqual([]);
  });
});

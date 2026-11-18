// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openSqliteSnapshot } from "./sqlite-snapshot.js";

const hooks = vi.hoisted(() => ({ afterCopy: (_source: string, _target: string) => {} }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    copyFileSync: (source: string, target: string) => {
      actual.copyFileSync(source, target);
      hooks.afterCopy(source, target);
    },
  };
});
vi.mock("./windows-private-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./windows-private-file.js")>();
  return {
    ...actual,
    copyWindowsPrivateFileSync: (source: string, target: string) => {
      actual.copyWindowsPrivateFileSync(source, target);
      hooks.afterCopy(source, target);
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  hooks.afterCopy = () => {};
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sqlite-copy-race-"));
  roots.push(root);
  const source = join(root, "fixture.db");
  writeFileSync(source, "initial");
  return source;
}
it("retries from scratch when a sidecar appears during the copy", () => {
  const source = fixture();
  const copies: string[] = [];
  hooks.afterCopy = (from, to) => {
    copies.push(to);
    if (from === source && copies.length === 1) writeFileSync(source + "-wal", "committed frame");
  };
  const snapshot = openSqliteSnapshot(source);
  try {
    expect(readFileSync(snapshot.path + "-wal", "utf8")).toBe("committed frame");
    expect(existsSync(dirname(copies[0]))).toBe(false);
  } finally {
    snapshot.cleanup();
  }
});
it("refuses continuing changes after three attempts and cleans every partial copy", () => {
  const source = fixture();
  const copies: string[] = [];
  hooks.afterCopy = (from, to) => {
    copies.push(to);
    writeFileSync(from, "changed".repeat(copies.length));
  };
  expect(() => openSqliteSnapshot(source)).toThrow("changed while copying");
  expect(copies).toHaveLength(3);
  for (const copy of copies) expect(existsSync(dirname(copy))).toBe(false);
});
it("retries a sidecar that vanishes before copying instead of keeping a half-copy", () => {
  const source = fixture();
  writeFileSync(source + "-wal", "frame");
  const copies: string[] = [];
  hooks.afterCopy = (from, to) => {
    copies.push(to);
    if (from === source && copies.length === 1) rmSync(source + "-wal");
  };
  const snapshot = openSqliteSnapshot(source);
  try {
    expect(copies).toHaveLength(2);
    expect(existsSync(dirname(copies[0]))).toBe(false);
    expect(existsSync(snapshot.path + "-wal")).toBe(false);
    expect(readFileSync(snapshot.path, "utf8")).toBe("initial");
  } finally {
    snapshot.cleanup();
  }
});
it.each([
  { code: "EACCES", stage: undefined },
  { code: "EPRIVATE", stage: "regular-leaf" },
])("does not swallow sidecar copy errors or retry permission failures $code/$stage", (reason) => {
  const source = fixture();
  writeFileSync(source + "-wal", "frame");
  const copies: string[] = [];
  hooks.afterCopy = (from, to) => {
    copies.push(to);
    if (from.endsWith("-wal")) throw Object.assign(Error("fixture denied"), reason);
  };
  expect(() => openSqliteSnapshot(source)).toThrow("fixture denied");
  expect(copies).toHaveLength(2);
  for (const copy of copies) expect(existsSync(dirname(copy))).toBe(false);
});

it.each([
  { code: "ENOENT", stage: undefined },
  { code: "EPRIVATE", stage: "copy-source-changed" },
])("retries a source-change copy error $code/$stage from a fresh scratch directory", (reason) => {
  const source = fixture();
  const copies: string[] = [];
  hooks.afterCopy = (_from, to) => {
    copies.push(to);
    if (copies.length === 1) throw Object.assign(new Error("Invented source changed"), reason);
  };
  const snapshot = openSqliteSnapshot(source);
  try {
    expect(copies).toHaveLength(2);
    expect(existsSync(dirname(copies[0]!))).toBe(false);
    expect(dirname(copies[1]!)).not.toBe(dirname(copies[0]!));
    expect(readFileSync(snapshot.path, "utf8")).toBe("initial");
  } finally {
    snapshot.cleanup();
  }
});

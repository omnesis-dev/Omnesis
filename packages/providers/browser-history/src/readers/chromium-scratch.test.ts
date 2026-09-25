// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChromiumHistoryReader } from "./chromium.js";

const observed = vi.hoisted(() => ({
  path: "",
  failOpen: true,
  readonlyPaths: [] as string[],
  closedPaths: [] as string[],
}));
afterEach(() => {
  observed.failOpen = true;
  observed.readonlyPaths = [];
  observed.closedPaths = [];
});
vi.mock("better-sqlite3", () => ({
  default: class {
    constructor(
      private path: string,
      private options: { readonly: boolean },
    ) {
      observed.path = path;
      if (observed.failOpen) throw new Error("fixture open failure");
      if (options.readonly) observed.readonlyPaths.push(path);
    }
    prepare() {
      return { get: () => undefined, all: () => [] };
    }
    close() {
      if (!this.options.readonly) return;
      observed.closedPaths.push(this.path);
      if (this.path === observed.readonlyPaths[0]) throw Error("fixture close failure");
    }
  },
}));

it("removes a copied history database when its SQLite open fails", () => {
  const root = mkdtempSync(join(tmpdir(), "omnesis-chromium-scratch-test-"));
  mkdirSync(join(root, "Default"));
  writeFileSync(join(root, "Default", "History"), "fixture");
  writeFileSync(
    join(root, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Fixture" } } } }),
  );
  const reader = new ChromiumHistoryReader({
    id: "chrome",
    name: "Fixture",
    baseDir: root,
    engine: "chromium",
  });
  try {
    expect(reader.readVisits({}, 0, 100).visits).toEqual([]);
    expect(observed.path).not.toBe("");
    expect(existsSync(observed.path)).toBe(false);
  } finally {
    reader.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("cleans every owned snapshot when the first handle close fails", () => {
  const root = mkdtempSync(join(tmpdir(), "omnesis-chromium-close-test-"));
  for (const name of ["Default", "Profile 1"]) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "History"), "fixture");
  }
  writeFileSync(
    join(root, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "First fixture" },
          "Profile 1": { name: "Second fixture" },
        },
      },
    }),
  );
  observed.failOpen = false;
  const reader = new ChromiumHistoryReader({
    id: "chrome",
    name: "Fixture",
    baseDir: root,
    engine: "chromium",
  });
  try {
    reader.readVisits({}, 0, 100);
    expect(observed.readonlyPaths).toHaveLength(2);
    expect(() => reader.close()).toThrow(AggregateError);
    expect(observed.closedPaths).toEqual(observed.readonlyPaths);
    for (const path of observed.readonlyPaths) expect(existsSync(path)).toBe(false);
    expect(() => reader.close()).not.toThrow();
    expect(observed.closedPaths).toHaveLength(2);
  } finally {
    reader.close();
    rmSync(root, { recursive: true, force: true });
  }
});

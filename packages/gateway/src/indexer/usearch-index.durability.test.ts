// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const durability = vi.hoisted(() => ({
  events: [] as string[],
  failFileSync: false,
}));

vi.mock("@omnesis/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@omnesis/core")>();
  return {
    ...core,
    fsyncFileSync: (path: string) => {
      durability.events.push(`file:${path}`);
      if (durability.failFileSync) throw new Error("fsync failed: EIO");
      core.fsyncFileSync(path);
    },
    fsyncDirSync: (dir: string) => {
      durability.events.push(`dir:${dir}`);
      core.fsyncDirSync(dir);
    },
  };
});

const { UsearchWriteHandle } = await import("./usearch-index.js");

const DIM = 8;

function vector(): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = 1;
  return v;
}

describe("UsearchWriteHandle.save durability", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usearch-durable-"));
    path = join(dir, "index.usearch");
    durability.events.length = 0;
    durability.failFileSync = false;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("syncs the temp file before the rename and the directory before reporting the save", () => {
    const events: string[] = durability.events;
    const handle = new UsearchWriteHandle(path, DIM);
    handle.setOnSaved(() => {
      events.push(`saved:${existsSync(path)}`);
    });
    handle.add(1n, vector());
    handle.save();
    handle.close();

    expect(events.slice(0, 3)).toEqual([`file:${path}.tmp`, `dir:${dir}`, "saved:true"]);
  });

  test("a failed file sync keeps the previous graph and the handle dirty", () => {
    const handle = new UsearchWriteHandle(path, DIM);
    handle.add(1n, vector());
    handle.save();
    const previous = readFileSync(path);

    handle.add(2n, vector());
    durability.failFileSync = true;
    expect(() => handle.save()).toThrow("fsync failed");

    expect(readFileSync(path).equals(previous)).toBe(true);
    expect(readdirSync(dir)).toEqual(["index.usearch"]);

    durability.failFileSync = false;
    handle.save();
    expect(readFileSync(path).equals(previous)).toBe(false);
    handle.close();
  });
});

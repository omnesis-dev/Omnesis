// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cross-boot model-digest cache: it has to skip the read when the file is
 * unchanged, and it has to NOT skip it whenever anything about the file moved.
 * A cache that answers stale here would put a wrong digest in the manifest,
 * which is worse than the fifteen seconds it saves.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256WithCache } from "./hash-cache.js";

let root: string;
let cacheDir: string;
let previousCacheDir: string | undefined;

/** Counts what the cache did not save us from. */
function countingHasher(digest = "deadbeef") {
  let calls = 0;
  return {
    calls: () => calls,
    hash: (_path: string) => {
      calls += 1;
      return Promise.resolve(digest);
    },
  };
}

function writeModel(name: string, contents: string): string {
  const path = join(root, name);
  writeFileSync(path, contents);
  return path;
}

beforeEach(() => {
  root = join("/tmp", `omnesis-test-${randomUUID()}`);
  cacheDir = join(root, "cache");
  mkdirSync(root, { recursive: true });
  previousCacheDir = process.env.OMNESIS_MODEL_HASH_CACHE_DIR;
  process.env.OMNESIS_MODEL_HASH_CACHE_DIR = cacheDir;
});

afterEach(() => {
  if (previousCacheDir === undefined) delete process.env.OMNESIS_MODEL_HASH_CACHE_DIR;
  else process.env.OMNESIS_MODEL_HASH_CACHE_DIR = previousCacheDir;
  rmSync(root, { recursive: true, force: true });
});

describe("the model digest cache", () => {
  it("hashes a file it has never seen", async () => {
    const model = writeModel("model.gguf", "weights");
    const hasher = countingHasher("abc123");

    expect(await sha256WithCache(model, hasher.hash)).toBe("abc123");
    expect(hasher.calls()).toBe(1);
  });

  it("answers a second boot without reading the file again", async () => {
    const model = writeModel("model.gguf", "weights");
    const first = countingHasher("abc123");
    await sha256WithCache(model, first.hash);

    const second = countingHasher("would-be-wrong");
    expect(await sha256WithCache(model, second.hash)).toBe("abc123");
    expect(second.calls()).toBe(0);
  });

  // The case the cache exists for: many isolated config directories, each with
  // its own symlink, all pointing at one real model file. Keying on the real
  // path is what makes the second instance free.
  it("is shared by every config directory that symlinks the same file", async () => {
    const real = writeModel("model.gguf", "weights");
    const firstInstance = join(root, "instance-a");
    const secondInstance = join(root, "instance-b");
    mkdirSync(firstInstance);
    mkdirSync(secondInstance);
    symlinkSync(real, join(firstInstance, "model.gguf"));
    symlinkSync(real, join(secondInstance, "model.gguf"));

    const a = countingHasher("abc123");
    await sha256WithCache(join(firstInstance, "model.gguf"), a.hash);
    const b = countingHasher("would-be-wrong");

    expect(await sha256WithCache(join(secondInstance, "model.gguf"), b.hash)).toBe("abc123");
    expect(b.calls()).toBe(0);
  });

  it("re-hashes when the file's size changed", async () => {
    const model = writeModel("model.gguf", "weights");
    await sha256WithCache(model, countingHasher("abc123").hash);

    writeFileSync(model, "weights and more weights");
    const after = countingHasher("def456");

    expect(await sha256WithCache(model, after.hash)).toBe("def456");
    expect(after.calls()).toBe(1);
  });

  // Same length, different content — the size check alone would serve the old
  // digest, so the mtime is what catches it.
  it("re-hashes when the file's mtime changed but its size did not", async () => {
    const model = writeModel("model.gguf", "weights-v1");
    await sha256WithCache(model, countingHasher("abc123").hash);

    writeFileSync(model, "weights-v2");
    const bumped = new Date(Date.now() + 60_000);
    utimesSync(model, bumped, bumped);
    const after = countingHasher("def456");

    expect(await sha256WithCache(model, after.hash)).toBe("def456");
    expect(after.calls()).toBe(1);
  });

  it("does not confuse two files for each other", async () => {
    const first = writeModel("first.gguf", "one");
    const second = writeModel("second.gguf", "two");

    expect(await sha256WithCache(first, countingHasher("first-digest").hash)).toBe("first-digest");
    expect(await sha256WithCache(second, countingHasher("second-digest").hash)).toBe(
      "second-digest",
    );
    const reread = countingHasher("would-be-wrong");
    expect(await sha256WithCache(first, reread.hash)).toBe("first-digest");
    expect(reread.calls()).toBe(0);
  });

  it("falls back to hashing when the cache directory cannot be written", async () => {
    const model = writeModel("model.gguf", "weights");
    // A path whose parent is a regular file — mkdir there always fails.
    process.env.OMNESIS_MODEL_HASH_CACHE_DIR = join(model, "cache");

    const first = countingHasher("abc123");
    expect(await sha256WithCache(model, first.hash)).toBe("abc123");
    const second = countingHasher("abc123");
    expect(await sha256WithCache(model, second.hash)).toBe("abc123");
    expect(second.calls(), "an unwritable cache costs time, never correctness").toBe(1);
  });

  it("hashes a path that does not resolve rather than throwing", async () => {
    const missing = join(root, "not-here.gguf");
    const hasher = countingHasher("abc123");

    expect(await sha256WithCache(missing, hasher.hash)).toBe("abc123");
    expect(hasher.calls()).toBe(1);
  });

  it("ignores a cache entry that is not a readable document", async () => {
    const model = writeModel("model.gguf", "weights");
    await sha256WithCache(model, countingHasher("abc123").hash);
    // Corrupt every entry the cache holds, as a boot killed mid-write would.
    for (const entry of readdirSync(cacheDir)) {
      writeFileSync(join(cacheDir, entry), "{not json");
    }

    const after = countingHasher("def456");
    expect(await sha256WithCache(model, after.hash)).toBe("def456");
    expect(after.calls()).toBe(1);
  });
});

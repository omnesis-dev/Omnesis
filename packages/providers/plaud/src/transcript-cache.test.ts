// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { fileTranscriptCache, memoryTranscriptCache } from "./transcript-cache.js";

const created: string[] = [];
afterEach(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  created.length = 0;
});

function dirs() {
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-plaud-cache-"));
  created.push(configDir);
  return { configDir, stateDir: join(configDir, "plaud", "maya.reeves@example.com") };
}

describe.each([
  ["memory", () => memoryTranscriptCache()],
  [
    "file",
    () => {
      const { configDir, stateDir } = dirs();
      return fileTranscriptCache(stateDir, configDir);
    },
  ],
])("%s transcript cache", (_name, make) => {
  test("returns a transcript only for the audio it was made from", async () => {
    const cache = make();
    await cache.set("rec-1", { audioKey: "k1", text: "Morning.", language: "en" });
    await expect(cache.get("rec-1", "k1")).resolves.toEqual({
      audioKey: "k1",
      text: "Morning.",
      language: "en",
    });
    await expect(cache.get("rec-1", "k2")).resolves.toBeUndefined();
    await expect(cache.get("rec-2", "k1")).resolves.toBeUndefined();
  });

  test("prune forgets recordings that are gone", async () => {
    const cache = make();
    await cache.set("rec-1", { audioKey: "k", text: "One." });
    await cache.set("rec-2", { audioKey: "k", text: "Two." });
    await cache.prune(new Set(["rec-2"]));
    await expect(cache.get("rec-1", "k")).resolves.toBeUndefined();
    await expect(cache.get("rec-2", "k")).resolves.toMatchObject({ text: "Two." });
  });
});

test("the file cache keeps no recording id or text in its file names", async () => {
  const { configDir, stateDir } = dirs();
  const cache = fileTranscriptCache(stateDir, configDir);
  await cache.set("rec-1", { audioKey: "k", text: "Morning." });
  const names = readdirSync(join(stateDir, "transcripts"));
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^[0-9a-f]{32}\.json$/);
});

test("pruning a cache that was never written does nothing", async () => {
  const { configDir, stateDir } = dirs();
  await expect(fileTranscriptCache(stateDir, configDir).prune(new Set())).resolves.toBeUndefined();
});

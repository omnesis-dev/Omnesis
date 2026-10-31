// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileAlbumStore } from "./album-store.js";

let configDir: string;
let stateDir: string;
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "omnesis-immich-albums-"));
  stateDir = join(configDir, "state", "immich", "maya.reeves@example.com");
});
afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe("fileAlbumStore", () => {
  const index = { names: { a1: "Harbour Weekend" }, byAsset: { x: ["a1"] } };

  it("has nothing before the first save, then reads back what it saved", async () => {
    const store = fileAlbumStore(stateDir, configDir);
    expect(await store.load()).toBeUndefined();
    await store.save(index);
    expect(await fileAlbumStore(stateDir, configDir).load()).toEqual(index);
    expect(await readdir(stateDir)).toEqual(["albums.json"]);
  });

  it("treats a damaged file as lost, so the index is read again", async () => {
    const store = fileAlbumStore(stateDir, configDir);
    await store.save(index);
    await writeFile(join(stateDir, "albums.json"), "{ not json");
    expect(await store.load()).toBeUndefined();
    await writeFile(join(stateDir, "albums.json"), JSON.stringify({ names: {}, byAsset: [] }));
    expect(await store.load()).toBeUndefined();
  });
});

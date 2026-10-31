// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { resetActiveUniverseCache } from "@omnesis/providers-synth-common";

const SELF = "maya.reeves@example.com";

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-immich-synth-"));
  vi.stubEnv("OMNESIS_CONFIG_DIR", configDir);
  vi.stubEnv("OMNESIS_SYNTH_PRE_DISCOVERED", "1");
  vi.resetModules();
  resetActiveUniverseCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetActiveUniverseCache();
  rmSync(configDir, { recursive: true, force: true });
});

async function load() {
  const { default: definition, getImmichWrapsRealController } = await import("./index.js");
  return { definition, getImmichWrapsRealController };
}

test("discovers the universe's account, and nothing in a universe without a corpus", async () => {
  vi.stubEnv("OMNESIS_SYNTH_UNIVERSE", "immich-sync");
  expect(await (await load()).definition.discover?.({ configDir })).toEqual([SELF]);

  vi.resetModules();
  resetActiveUniverseCache();
  vi.stubEnv("OMNESIS_SYNTH_UNIVERSE", "default");
  expect(await (await load()).definition.discover?.({ configDir })).toEqual([]);
});

test("runs the real source over the simulated server and indexes only the owned, visible assets", async () => {
  vi.stubEnv("OMNESIS_SYNTH_UNIVERSE", "immich-sync");
  const { definition, getImmichWrapsRealController } = await load();
  expect(definition.authenticate).toBeUndefined();
  expect(definition.credentials).toBeUndefined();

  const sourceId = SourceId(`immich:${SELF}`);
  const ctx = await definition.createContext!({ accountId: SELF } as never);
  const entry = definition.sources[0]!;
  expect(entry.contract).toBeUndefined();
  const instance = await entry.create!(
    {
      sourceId,
      providerId: ProviderId(`immich:${SELF}`),
      accountId: SELF,
      config: {},
    } as never,
    ctx,
  );
  expect(getImmichWrapsRealController(String(sourceId))?.server).toBeDefined();

  const page = await instance.sync(null);
  expect(page.hasMore).toBe(false);
  const ids = page.documents.map((d) => d.externalId).sort();
  expect(ids).toEqual([
    "5c3f4e5a-0000-4000-8000-00000000c001",
    "5c3f4e5a-0000-4000-8000-00000000c002",
    "5c3f4e5a-0000-4000-8000-00000000c003",
    "5c3f4e5a-0000-4000-8000-00000000c004",
  ]);
  expect(page.presentExternalIds?.sort()).toEqual(ids);
  const kite = page.documents.find((d) => d.externalId.endsWith("c001"))!;
  expect(kite.title).toBe("Kite festival on the harbour wall");
  expect(kite.metadata.extra?.albums).toEqual(["Harbour Weekend"]);
  expect(kite.metadata.sourceUrl).toBe(
    "http://immich.example.com:2283/photos/5c3f4e5a-0000-4000-8000-00000000c001",
  );

  await instance.dispose?.();
  expect(getImmichWrapsRealController(String(sourceId))).toBeUndefined();
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ConfigStore } from "./config-store.js";

let dir: string;
let path: string;
let store: ConfigStore;
const policy = { sourceId: "fictional-notes:one", maxAgeDays: 365 };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "storage-config-upgrade-"));
  path = join(dir, "omnesis.json");
  writeFileSync(
    path,
    JSON.stringify({ gateway: { storage: { retention: [{ ...policy, sourceCreatedAt: 123 }] } } }),
  );
  store = new ConfigStore({ filePath: path });
});
afterEach(() => {
  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

it("keeps upgrade authority out of get/getRaw and on disk until durable-binding acknowledgement", async () => {
  await store.load();
  expect(store.get().gateway?.storage?.retention).toEqual([policy]);
  expect(JSON.parse(store.getRaw()).gateway.storage.retention).toEqual([policy]);
  expect(store.takeLegacyStorageRetentionBindings()).toEqual([{ ...policy, sourceCreatedAt: 123 }]);
  expect(JSON.parse(readFileSync(path, "utf8")).gateway.storage.retention[0].sourceCreatedAt).toBe(
    123,
  );
  await store.patch({ gateway: { storage: { maxBytes: 1024 } } });
  expect(store.get().gateway?.storage?.retention).toEqual([policy]);
  expect(JSON.parse(store.getRaw()).gateway.storage.retention).toEqual([policy]);
  expect(JSON.parse(readFileSync(path, "utf8")).gateway.storage.retention[0].sourceCreatedAt).toBe(
    123,
  );
  const fence = store.captureRevisionFence();
  expect(await store.finishLegacyStorageRetentionUpgrade(fence)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).gateway.storage.retention).toEqual([policy]);
  expect(store.takeLegacyStorageRetentionBindings()).toEqual([]);
});

it("a stale acknowledgement cannot erase legacy authority needed by a newer config", async () => {
  await store.load();
  const before = store.captureRevisionFence();
  await store.patch({ gateway: { storage: { maxBytes: 2048 } } });
  expect(await store.finishLegacyStorageRetentionUpgrade(before)).toBe(false);
  expect(store.takeLegacyStorageRetentionBindings()).toHaveLength(1);
  const restarted = new ConfigStore({ filePath: path });
  await restarted.load();
  expect(restarted.takeLegacyStorageRetentionBindings()).toEqual([
    { ...policy, sourceCreatedAt: 123 },
  ]);
  restarted.stop();
});

it("normalization cannot overwrite a raw file edit still awaiting the watcher", async () => {
  await store.load();
  const fence = store.captureRevisionFence();
  const external = {
    gateway: { storage: { retention: [{ ...policy, maxAgeDays: 30, sourceCreatedAt: 123 }] } },
  };
  writeFileSync(path, JSON.stringify(external));
  expect(await store.finishLegacyStorageRetentionUpgrade(fence)).toBe(false);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(external);
  expect(store.takeLegacyStorageRetentionBindings()).toHaveLength(1);
});

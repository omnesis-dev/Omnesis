// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
const state = vi.hoisted(() => ({ fixture: [] as unknown }));
vi.mock("@omnesis/providers-synth-common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnesis/providers-synth-common")>()),
  loadSourceFixtureJson: () => state.fixture,
  loadActiveUniverse: () => ({}),
  universeAccounts: () => ["synthetic"],
}));
import source from "./index.js";
import type { SourceInstance, SyncCursor } from "@omnesis/source-sdk";
let root: string;
const instances: SourceInstance[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "synthetic-input-test-"));
});
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose?.();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const options = () => ({
  sourceId: SourceId("photos:synthetic"),
  providerId: ProviderId("photos:synthetic"),
  accountId: "synthetic",
  host: { stateDir: root },
  sourceConfig: {},
});
async function create() {
  const instance = await source.create!(options() as never);
  instances.push(instance);
  return instance;
}
async function drain(instance: SourceInstance, cursor: SyncCursor | null = null) {
  const documents = [];
  let result;
  do {
    result = await instance.sync(cursor);
    documents.push(...result.documents);
    cursor = result.cursor;
  } while (result.hasMore);
  return { documents, cursor, result };
}
describe("photos synthetic fixtures", () => {
  beforeEach(() => {
    state.fixture = [
      {
        id: "photo-1",
        createdAt: "2026-10-03T12:00:00Z",
        modifiedAt: "2026-10-03T12:00:00Z",
        placeName: "fictional garden",
        textLines: ["Invented garden workshop sign"],
        tags: ["garden"],
      },
    ];
  });
  test("bootstrap emits native-shaped evidence and repeated incremental page is empty", async () => {
    const instance = await create();
    const first = await drain(instance);
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0]?.metadata.documentType).toBe("photo");
    expect(first.documents[0]?.content).toContain("Place: fictional garden");
    expect((await drain(instance, first.cursor)).documents).toEqual([]);
    expect(first.result.presentExternalIds).toEqual(first.documents.map((doc) => doc.externalId));
  });
  test("invalid source-native input fails loudly", async () => {
    state.fixture = [{ invalid: true }];
    await expect(create()).rejects.toThrow();
  });
});

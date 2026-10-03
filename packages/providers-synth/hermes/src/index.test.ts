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
  sourceId: SourceId("hermes:synthetic"),
  providerId: ProviderId("hermes:synthetic"),
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
describe("hermes synthetic fixtures", () => {
  beforeEach(() => {
    state.fixture = [
      {
        chatId: "fictional-chat",
        platform: "cli",
        day: "2026-10-03",
        messages: [
          { role: "user", text: "Find the invented garden note", at: "2026-10-03T12:00:00Z" },
          {
            role: "assistant",
            text: "The garden note has a watering checklist.",
            at: "2026-10-03T12:01:00Z",
          },
        ],
      },
    ];
  });
  test("bootstrap emits native-shaped evidence and repeated incremental page is empty", async () => {
    const instance = await create();
    const first = await drain(instance);
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0]?.metadata.extra?.provenance).toBe("harness-pushed");
    expect(first.documents[0]?.content).toContain("watering checklist");
    expect((await drain(instance, first.cursor)).documents).toEqual([]);
    expect(first.result.presentExternalIds).toEqual(first.documents.map((doc) => doc.externalId));
  });
  test("duplicate chat/day/platform aggregates fail before silently replacing history", async () => {
    const first = (state.fixture as Array<Record<string, unknown>>)[0]!;
    state.fixture = [
      first,
      {
        ...first,
        messages: [
          {
            role: "user",
            text: "A separate message that must not replace the first",
            at: "2026-10-03T13:00:00Z",
          },
        ],
      },
    ];
    await expect(create()).rejects.toThrow("Duplicate synthetic conversation aggregate");
  });
  test("distinct platforms retain separate conversation histories", async () => {
    const first = (state.fixture as Array<Record<string, unknown>>)[0]!;
    state.fixture = [first, { ...first, platform: "mobile" }];
    const { documents } = await drain(await create());
    expect(documents).toHaveLength(2);
    expect(new Set(documents.map((document) => document.externalId)).size).toBe(2);
  });
  test("invalid source-native input fails loudly", async () => {
    state.fixture = [{ invalid: true }];
    await expect(create()).rejects.toThrow();
  });
});

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
  sourceId: SourceId("codex:synthetic"),
  providerId: ProviderId("codex:synthetic"),
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
describe("codex synthetic source", () => {
  beforeEach(() => {
    state.fixture = [
      {
        id: "fictional-session",
        createdAt: "2026-10-03T12:00:00Z",
        prompt: "Inspect the fictional household checklist",
        answer: "The checklist contains filter, plants and torch checks.",
      },
    ];
  });
  test("bootstrap uses the real normalizer and incremental sync emits no unchanged data", async () => {
    const instance = await create();
    const first = await drain(instance);
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0]?.metadata.documentType).toBe("conversation");
    expect(first.documents[0]?.content).toContain("Inspect the fictional household checklist");
    expect(first.documents[0]?.content).toContain("filter, plants and torch");
    const unchanged = await drain(instance, first.cursor);
    expect(unchanged.documents).toEqual([]);
  });
  test("a newly materialized input appears on incremental sync", async () => {
    const first = await drain(await create());
    state.fixture = [
      ...(state.fixture as unknown[]),
      {
        id: "second-session",
        createdAt: "2026-10-04T12:00:00Z",
        prompt: "Check the invented lamp list",
        answer: "The living room bulb needs replacing.",
      },
    ];
    const second = await drain(await create(), first.cursor);
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0]?.content).toContain("lamp");
  });
  test("invalid fixture paths or identities fail before any real host reader runs", async () => {
    state.fixture = [
      { id: "../escape", createdAt: "2026-10-03T12:00:00Z", prompt: "invalid", answer: "invalid" },
    ];
    await expect(create()).rejects.toThrow();
  });
  test("missing host state directory cannot fall back to operator defaults", async () => {
    await expect(source.create!({ ...options(), host: undefined } as never)).rejects.toThrow(
      "host state directory",
    );
  });
});

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
import realSource from "@omnesis/provider-local-files";
import {
  withVersionedState,
  isStateEnvelope,
  type StateOutcome,
  type SourceInstance,
  type SyncCursor,
} from "@omnesis/source-sdk";
import source from "./index.js";
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
  sourceId: SourceId("local-files:synthetic"),
  providerId: ProviderId("local-files:synthetic"),
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
describe("local-files synthetic source", () => {
  beforeEach(() => {
    state.fixture = [
      {
        path: "Household/checklist.txt",
        content:
          "Invented household checklist. Replace the kitchen filter, water the balcony plants, check the emergency torch and recycle packaging. This is synthetic text.",
        modifiedAt: "2026-10-03T12:00:00Z",
      },
    ];
  });
  test("a persisted production-version envelope resumes through the twin's host state boundary", async () => {
    const realState = realSource.contract!.state!;
    const twinState = source.contract!.state!;
    expect(twinState).not.toBe(realState);
    const oldHost = withVersionedState(await create(), realState, { sourceId: options().sourceId });
    const first = await drain(oldHost);
    expect(isStateEnvelope(first.cursor)).toBe(true);
    const outcomes: StateOutcome[] = [];
    const restartedHost = withVersionedState(await create(), twinState, {
      sourceId: options().sourceId,
      onResolve: (outcome) => outcomes.push(outcome),
    });
    const persisted = JSON.parse(JSON.stringify(first.cursor));
    expect((await drain(restartedHost, persisted)).documents).toEqual([]);
    expect(outcomes[0]?.kind).toBe("resume");
    expect(twinState.decode({ offset: 1 })).toBeNull();
  });
  test("native cursor survives persistence with its independently declared native state", async () => {
    const first = await drain(await create());
    const persisted = JSON.parse(JSON.stringify(first.cursor)) as SyncCursor;
    expect(source.contract?.state?.decode(persisted)).toEqual(persisted);
    expect(persisted).toHaveProperty("fileMap");
    expect(persisted).toHaveProperty("version", 1);
    expect(persisted).not.toHaveProperty("offset");
    expect((await drain(await create(), persisted)).documents).toEqual([]);
  });
  test("bootstrap uses the real normalizer and incremental sync emits no unchanged data", async () => {
    const instance = await create();
    const first = await drain(instance);
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0]?.metadata.documentType).toBe("file");
    const unchanged = await drain(instance, first.cursor);
    expect(unchanged.documents).toEqual([]);
  });
  test("a newly materialized input appears on incremental sync", async () => {
    const first = await drain(await create());
    state.fixture = [
      ...(state.fixture as unknown[]),
      {
        path: "Household/second.txt",
        content:
          "An additional independently invented household record for an incremental scan. The living room lamp needs its bulb changed. This is synthetic text.",
        modifiedAt: "2026-10-04T12:00:00Z",
      },
    ];
    const second = await drain(await create(), first.cursor);
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0]?.content).toContain("lamp");
  });
  test("invalid fixture paths or identities fail before any real host reader runs", async () => {
    state.fixture = [{ path: "../escape.txt", content: "forbidden" }];
    await expect(create()).rejects.toThrow();
  });
  test("missing host state directory cannot fall back to operator defaults", async () => {
    await expect(source.create!({ ...options(), host: undefined } as never)).rejects.toThrow(
      "host state directory",
    );
  });
});

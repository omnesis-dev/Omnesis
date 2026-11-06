// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { withFixtureScopeRefresh } from "./scope-refresh.js";
import type { SyncOptions } from "@omnesis/source-sdk";
import type { SynthCursor } from "./types.js";
const options = (epoch?: string, requestId?: string): SyncOptions => ({
  scopeFactsSupported: true,
  scopeRefreshEpochsSupported: true,
  scopeRefreshEpochs: { label: epoch },
  scopeRefreshRequestIds: { label: requestId },
  scopeRefreshActorId: "collector-a",
});
function fixture() {
  let digest = "initial";
  const source = withFixtureScopeRefresh<SynthCursor>(
    {
      sync: (cursor) =>
        Promise.resolve({
          documents: [],
          deletedExternalIds: [],
          cursor: cursor ?? {},
          hasMore: false,
        }),
    },
    {
      sourceId: "fixture:one",
      kind: "label",
      fingerprint: () => digest,
      rows: (epoch) =>
        Array.from({ length: 201 }, (_, i) => ({
          work: 50,
          updates: {
            documents: [
              {
                externalId: `native-${i}`,
                kinds: ["label"],
                facts: {
                  kinds: ["label"],
                  facts: [],
                  complete: ["label"],
                  refreshEpochs: { label: epoch },
                },
              },
            ],
          },
        })),
      decorate: () => {},
      ready: () => true,
    },
  );
  return {
    source,
    change: () => {
      digest = "changed";
    },
  };
}
describe("generic synthetic native refresh orchestration", () => {
  it("requests a required epoch before publishing initial native observations", async () => {
    const { source } = fixture();
    const first = await source.sync({ offset: 12 }, options());
    expect(first.documents).toEqual([]);
    expect(first.scopeUpdates?.documents).toBeUndefined();
    expect(first.scopeUpdates?.refreshes?.[0]).toMatchObject({
      active: true,
      requestId: expect.any(String),
    });
    const handshake = await source.sync(
      first.cursor,
      options("cut-b", first.scopeUpdates?.refreshes?.[0]?.requestId),
    );
    expect(handshake.scopeUpdates?.refreshes?.[0]?.restart).toBe(true);
    expect(handshake.cursor.offset).toBe(12);
  });
  it("bounds aggregate metadata work and makes rejected pages replayable", async () => {
    const { source } = fixture();
    const first = await source.sync({ offset: 12 }, options("cut-b"));
    const opts = options("cut-c", first.scopeUpdates?.refreshes?.[0]?.requestId);
    const page = await source.sync(first.cursor, opts);
    const replay = await source.sync(first.cursor, opts);
    expect(page).toEqual(replay);
    expect(page.scopeUpdates?.documents).toHaveLength(81);
    expect(page.scopeUpdates?.refreshes).toBeUndefined();
    expect(page.cursor.offset).toBe(12);
  });
  it("restarts a lost/corrupt metadata offset instead of declaring omitted subjects complete", async () => {
    const { source } = fixture();
    const first = await source.sync(null, options("cut-b"));
    const next = await source.sync(
      first.cursor,
      options("cut-c", first.scopeUpdates?.refreshes?.[0]?.requestId),
    );
    const state = next.cursor.scopeFixtureRefresh as {
      bookmark: Record<string, unknown>;
      digest: string;
    };
    const corrupted = {
      ...next.cursor,
      scopeFixtureRefresh: { ...state, bookmark: { ...state.bookmark, after: "999999" } },
    };
    const result = await source.sync(corrupted, options("cut-c"));
    expect(result.scopeUpdates?.refreshes?.[0]?.restart).toBe(true);
    expect(result.scopeUpdates?.documents).toBeUndefined();
  });
  it("requires a fresh cut on native input changes and strips protocol2 progress after rollback", async () => {
    const { source, change } = fixture();
    const first = await source.sync(null, options("cut-b"));
    const next = await source.sync(
      first.cursor,
      options("cut-c", first.scopeUpdates?.refreshes?.[0]?.requestId),
    );
    change();
    const changed = await source.sync(next.cursor, options("cut-c"));
    expect(changed.scopeUpdates?.refreshes?.[0]?.restart).toBe(true);
    const legacy = await source.sync(changed.cursor, { scopeFactsSupported: true });
    expect(legacy.cursor.scopeFixtureRefresh).toBeUndefined();
    expect(legacy.cursor.scopeFixtureInitialPulse).toBeUndefined();
  });
  it("members never rotate or release global refresh authority", async () => {
    const { source } = fixture();
    const result = await source.sync(null, {
      ...options("cut-b"),
      run: { id: "member", reason: "scheduled", start: "resume", page: 0, role: "member" },
    });
    expect(result.scopeUpdates?.documents?.length).toBeGreaterThan(0);
    expect(result.scopeUpdates?.refreshes).toBeUndefined();
    expect(result.scopeUpdates?.readiness).toBeUndefined();
  });
});

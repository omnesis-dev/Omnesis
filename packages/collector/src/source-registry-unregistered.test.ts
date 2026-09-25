// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An unregistered source must stay unregistered.
 *
 * A sync already paging a source is not cancelled when the source is
 * unregistered — the page loop only notices between pages, and it notices by
 * looking the source's status up in the registry's map. So anything that puts
 * a status back for an id with no registration hands that abandoned loop
 * permission to keep writing.
 *
 * `markNeedsAuth` did exactly that: it created a status unconditionally. A
 * source that was already erroring — the one most likely to raise an auth
 * failure on a later page — could therefore resurrect itself after removal and
 * keep pushing documents at a source the operator had deleted.
 */

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { SourceRegistry } from "./source-registry.js";
import { SyncScheduler } from "./sync-scheduler.js";
import { FileWatcherManager } from "./file-watcher-manager.js";
import type { RegisteredSource } from "./source-registry.js";

function makeRegistry(): SourceRegistry {
  return new SourceRegistry(new SyncScheduler(), new FileWatcherManager(() => {}));
}

function makeSource(id: string): RegisteredSource {
  return {
    id: SourceId(id),
    name: "Test source",
    providerId: ProviderId("test-provider"),
    instance: { sync: async () => ({ documents: [], hasMore: false, cursor: {} }) },
  } as unknown as RegisteredSource;
}

const SOURCE_ID = "gmail:maya.reeves@example.com";

describe("markNeedsAuth on a source that is no longer registered", () => {
  test("does not create a status for it", () => {
    // Nothing was ever registered under this id — the state an abandoned page
    // loop finds itself in after its source is removed.
    const registry = makeRegistry();
    registry.markNeedsAuth(makeSource(SOURCE_ID), "test-provider");
    expect(registry.getStatus(SOURCE_ID)).toBeUndefined();
  });

  test("emits nothing, so the gateway is not told about a source that is gone", () => {
    const registry = makeRegistry();
    const events: unknown[] = [];
    registry.onStatusChange((e) => events.push(e));
    registry.markNeedsAuth(makeSource(SOURCE_ID), "test-provider");
    expect(events).toEqual([]);
  });

  test("the page loop's between-pages check therefore stops the loop", () => {
    // This is the property the guard protects: `getStatus` returning undefined
    // is what `SourceSyncRunner` reads as "aborted".
    const registry = makeRegistry();
    registry.markNeedsAuth(makeSource(SOURCE_ID), "test-provider");
    const status = registry.getStatus(SOURCE_ID);
    expect(status === undefined || status.state === "disabled").toBe(true);
  });
});

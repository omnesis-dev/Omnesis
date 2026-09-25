// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Removing a source splits into a fast phase the caller waits for and a data
 * purge that outlives the request. These tests pin the three things that split
 * has to guarantee: the caller is not held for the purge, the purge is
 * reported until it finishes, and an interrupted purge is picked back up.
 *
 * The purge is gated behind a controllable index delete, standing in for the
 * indexer worker — the real reason a removal can take minutes.
 */

import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountId, SourceId, SourceType, type DeviceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import {
  isSourceCleanupPending,
  listPendingSourceRemovals,
  markSourceRemoved,
} from "../../data/repositories/SourceRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { SourceWriteEpochFence, epochScope } from "../../source-write-epoch-fence.js";
import {
  SourceDataRemovalService,
  type SourceDataRemovalDeps,
} from "./SourceDataRemovalService.js";
import { SourceService } from "./SourceService.js";
import { StatusCache } from "./StatusCache.js";
import type Database from "better-sqlite3";

let DEVICE: DeviceId;
const SOURCE = SourceId("gmail:maya.reeves@example.com");

let dbPath: string;
let db: Database.Database;

/** One document belonging to SOURCE, so a sweep has something to delete. */
function seedDocument(id: string): void {
  db.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'google', ?, ?, 'Quarterly review', 'body', 'hash', '', '', '', '')`,
  ).run(id, SOURCE, id);
}

/** A latch the fake index delete blocks on, so a purge can be held open. */
function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A removal service over the direct gate, with the stores a test wants to observe. */
function removal(
  writeGate = directWriteGate(db),
  stores: Pick<SourceDataRemovalDeps, "analyticsDb" | "sourceWriteEpochFence"> = {},
): SourceDataRemovalService {
  return new SourceDataRemovalService({
    db,
    writeGate,
    purgeAnnotationsFor: async () => {},
    ...stores,
  });
}

function buildService(opts: { deleteIndexBySource?: () => Promise<number> } = {}): SourceService {
  const writeGate = directWriteGate(db);
  return new SourceService({
    db,
    writeGate,
    sourceDataRemoval: removal(writeGate),
    statusCache: new StatusCache(db),
    indexWriteGate: opts.deleteIndexBySource
      ? ({ deleteIndexBySource: opts.deleteIndexBySource } as never)
      : undefined,
    listDevices: () => [],
    notifySourceChange: () => {},
    syncSourceSettingsToConfig: async () => {},
  });
}

async function seedSource(service: SourceService): Promise<void> {
  await service.createSource({
    type: SourceType("gmail"),
    accountId: AccountId("maya.reeves@example.com"),
    deviceId: DEVICE,
  });
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  DEVICE = createDevice(db, { name: "test-host", kind: "collector" }).id;
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix, { force: true });
  }
});

describe("the request returns before the purge does", () => {
  test("deleteSource resolves while the index delete is still running", async () => {
    const held = latch();
    const service = buildService({ deleteIndexBySource: () => held.promise.then(() => 0) });
    await seedSource(service);

    // Resolving at all is the assertion: the index delete is still blocked,
    // so a call that waited for the purge could not return here.
    const result = await service.deleteSource(SOURCE);
    expect(result?.source.id).toBe(SOURCE);
    expect(isSourceCleanupPending(db, SOURCE)).toBe(true);

    held.release();
  });

  test("the source stops being a source immediately, purge or no purge", async () => {
    const held = latch();
    const service = buildService({ deleteIndexBySource: () => held.promise.then(() => 0) });
    await seedSource(service);

    await service.deleteSource(SOURCE);

    // No row, so nothing syncs it and nothing lists it as live.
    expect(service.getById(SOURCE)).toBeNull();
    // But it is still accounted for, rather than silently gone.
    expect(service.listPendingRemovals().map((r) => r.id)).toEqual([SOURCE]);

    held.release();
  });
});

describe("the pending removal clears when the purge finishes", () => {
  test("revokes the source epoch before deleting analytics", async () => {
    const order: string[] = [];
    const baseGate = directWriteGate(db);
    const service = new SourceService({
      db,
      writeGate: {
        ...baseGate,
        deleteAllBySource: async (sourceId) => {
          order.push("epoch");
          return baseGate.deleteAllBySource(sourceId);
        },
      },
      sourceDataRemoval: removal(baseGate, {
        analyticsDb: {
          prepareSourceRemoval: async () => {},
          deleteAnalyticsForSource: async () => {
            order.push("analytics");
            return [];
          },
        } as never,
      }),
      statusCache: new StatusCache(db),
      listDevices: () => [],
      notifySourceChange: () => {},
      syncSourceSettingsToConfig: async () => {},
    });
    await seedSource(service);

    await service.deleteSource(SOURCE);
    await vi.waitFor(() => expect(isSourceCleanupPending(db, SOURCE)).toBe(false));

    expect(order.slice(0, 2)).toEqual(["epoch", "analytics"]);
  });
  test("cleanup_done_at is stamped and the entry disappears", async () => {
    const service = buildService({ deleteIndexBySource: async () => 0 });
    await seedSource(service);

    await service.deleteSource(SOURCE);
    await vi.waitFor(() => expect(isSourceCleanupPending(db, SOURCE)).toBe(false));
    expect(service.listPendingRemovals()).toEqual([]);
  });

  test("a failed purge stays pending rather than reporting a removal that did not happen", async () => {
    const service = buildService({
      deleteIndexBySource: async () => {
        throw new Error("indexer unavailable");
      },
    });
    await seedSource(service);

    await service.deleteSource(SOURCE);
    // Give the detached sweep a turn to fail.
    await vi.waitFor(() => expect(service.listPendingRemovals()).toHaveLength(1));
    expect(isSourceCleanupPending(db, SOURCE)).toBe(true);
    service.dispose();
  });

  test("analytics purge waits for an in-flight fenced ingest on a member's row", async () => {
    const held = latch();
    const fence = new SourceWriteEpochFence();
    // The ingest is fenced on the row it claimed — here the owner's own row,
    // as a replicated or partitioned member's pages are — not on the source.
    const inFlight = fence.run(epochScope(SOURCE, DEVICE), () => held.promise);
    const deleteAnalyticsForSource = vi.fn(async () => []);
    const service = new SourceService({
      db,
      writeGate: directWriteGate(db),
      sourceDataRemoval: removal(undefined, {
        analyticsDb: { prepareSourceRemoval: async () => {}, deleteAnalyticsForSource } as never,
        sourceWriteEpochFence: fence,
      }),
      statusCache: new StatusCache(db),
      listDevices: () => [],
      notifySourceChange: () => {},
      syncSourceSettingsToConfig: async () => {},
    });
    await seedSource(service);

    await service.deleteSource(SOURCE);
    await Promise.resolve();
    expect(deleteAnalyticsForSource).not.toHaveBeenCalled();

    held.release();
    await inFlight;
    await vi.waitFor(() => expect(deleteAnalyticsForSource).toHaveBeenCalledWith(SOURCE));
    await vi.waitFor(() => expect(isSourceCleanupPending(db, SOURCE)).toBe(false));
  });

  test("an analytics purge failure keeps removal pending", async () => {
    const service = new SourceService({
      db,
      writeGate: directWriteGate(db),
      sourceDataRemoval: removal(undefined, {
        analyticsDb: {
          prepareSourceRemoval: async () => {},
          deleteAnalyticsForSource: async () => {
            throw new Error("analytics unavailable");
          },
        } as never,
      }),
      statusCache: new StatusCache(db),
      listDevices: () => [],
      notifySourceChange: () => {},
      syncSourceSettingsToConfig: async () => {},
    });
    await seedSource(service);

    await service.deleteSource(SOURCE);
    await vi.waitFor(() => expect(service.listPendingRemovals()).toHaveLength(1));
    expect(isSourceCleanupPending(db, SOURCE)).toBe(true);
    service.dispose();
  });

  test("a failed purge retries itself instead of waiting for the next boot", async () => {
    // The step that fails in practice is the index delete, which gives up on
    // its own timeout whenever the indexer is inside a long backfill cycle.
    // Without a retry the source sits in `removing` until the gateway is
    // restarted, with nothing an operator can do about it.
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const service = buildService({
        deleteIndexBySource: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("deleteSourceIndex timed out");
          return 0;
        },
      });
      await seedSource(service);
      await service.deleteSource(SOURCE);

      await vi.waitUntil(() => attempts === 1, { timeout: 1000, interval: 1 });
      expect(isSourceCleanupPending(db, SOURCE)).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitUntil(() => attempts === 2, { timeout: 1000, interval: 1 });
      await vi.waitUntil(() => !isSourceCleanupPending(db, SOURCE), { timeout: 1000, interval: 1 });
      expect(service.listPendingRemovals()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an interrupted purge is resumed", () => {
  test("a tombstone left pending by a previous run is swept on the next boot", async () => {
    // What a gateway killed mid-purge leaves behind: no source row, a pending
    // tombstone, and documents still on disk.
    markSourceRemoved(db, SOURCE, { cleanupPending: true });
    seedDocument("doc-1");

    const deleteIndexBySource = vi.fn(async () => 0);
    // What `createServer` calls once the service is wired.
    buildService({ deleteIndexBySource }).resumePendingRemovals();

    await vi.waitFor(() => expect(isSourceCleanupPending(db, SOURCE)).toBe(false));
    expect(deleteIndexBySource).toHaveBeenCalledWith(SOURCE);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM documents WHERE source_id = ?").get(SOURCE),
    ).toEqual({ n: 0 });
  });

  test("a completed tombstone is left alone", async () => {
    markSourceRemoved(db, SOURCE);
    const deleteIndexBySource = vi.fn(async () => 0);
    buildService({ deleteIndexBySource }).resumePendingRemovals();

    expect(listPendingSourceRemovals(db)).toEqual([]);
    expect(deleteIndexBySource).not.toHaveBeenCalled();
  });
});

describe("re-adding a source whose purge is still draining", () => {
  test("rejects re-registration until every removal step finishes", async () => {
    const held = latch();
    const service = buildService({ deleteIndexBySource: () => held.promise.then(() => 0) });
    await seedSource(service);
    await service.deleteSource(SOURCE);

    await expect(
      service.createSource({
        type: SourceType("gmail"),
        accountId: AccountId("maya.reeves@example.com"),
        deviceId: DEVICE,
      }),
    ).rejects.toMatchObject({ status: 409, code: "SOURCE_REMOVAL_IN_PROGRESS" });
    expect(isSourceCleanupPending(db, SOURCE)).toBe(true);
    await service.clearRemovedForDeviceTypes(["gmail"]);
    expect(isSourceCleanupPending(db, SOURCE)).toBe(true);

    held.release();
    await vi.waitFor(() => expect(isSourceCleanupPending(db, SOURCE)).toBe(false));
    const recreated = await service.createSource({
      type: SourceType("gmail"),
      accountId: AccountId("maya.reeves@example.com"),
      deviceId: DEVICE,
    });
    expect(recreated.id).toBe(SOURCE);
  });

  test("rejects a collector bulk reconcile atomically while cleanup is pending", async () => {
    const held = latch();
    const service = buildService({ deleteIndexBySource: () => held.promise.then(() => 0) });
    await seedSource(service);
    await service.deleteSource(SOURCE);

    await expect(
      service.bulkUpsertForDevice(DEVICE, [
        { type: "gmail", accountId: "maya.reeves@example.com" },
      ]),
    ).rejects.toMatchObject({ status: 409, code: "SOURCE_REMOVAL_IN_PROGRESS" });
    expect(service.getById(SOURCE)).toBeNull();
    const gate = directWriteGate(db);
    await gate.setSourceMeta(SOURCE, { label: "Removed source" });
    await gate.setSyncState(SOURCE, { revision: 99 });
    expect(db.prepare("SELECT 1 FROM sync_state WHERE source_id = ?").get(SOURCE)).toBeUndefined();

    held.release();
    await vi.waitFor(() => expect(isSourceCleanupPending(db, SOURCE)).toBe(false));
  });

  test("a sweep whose tombstone was cleared underneath it deletes nothing further", async () => {
    const held = latch();
    const service = buildService({ deleteIndexBySource: () => held.promise.then(() => 0) });
    await seedSource(service);

    markSourceRemoved(db, SOURCE, { cleanupPending: true });
    seedDocument("doc-1");
    db.prepare("DELETE FROM removed_sources WHERE id = ?").run(SOURCE);

    service.resumePendingRemovals();
    await new Promise((r) => setTimeout(r, 20));

    expect(
      db.prepare("SELECT COUNT(*) AS n FROM documents WHERE source_id = ?").get(SOURCE),
    ).toEqual({ n: 1 });

    held.release();
  });
});

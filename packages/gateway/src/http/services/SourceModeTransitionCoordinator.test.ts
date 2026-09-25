// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, unlinkSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { beginSyncAttempt, createDatabase, getWipeEpoch } from "../../db.js";
import {
  createDevice,
  updateDeviceCapabilities,
} from "../../data/repositories/DeviceRepository.js";
import { createSource, getSource } from "../../data/repositories/SourceRepository.js";
import {
  getSourceModeTransition,
  prepareSourceModeTransition,
} from "../../data/repositories/SourceModeTransitionRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import { AnalyticsDb } from "../../analytics-db.js";
import { SourceModeTransitionCoordinator } from "./SourceModeTransitionCoordinator.js";
import { AnalyticsSourceModeTransitionAdoption } from "./AnalyticsSourceModeTransitionAdoption.js";
import { AnalyticsService } from "./AnalyticsService.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const owner = createDevice(db, {
    name: "collector-west",
    kind: "collector",
    capabilities: {
      hostableSourceTypes: [SourceType("notes-synth")],
      multiDeviceModes: { "notes-synth": "partitioned" },
      memberScopedParams: { "notes-synth": [] },
    },
  });
  const source = createSource(db, {
    type: SourceType("notes-synth"),
    accountId: AccountId("fictional"),
    deviceId: owner.id,
    multiDeviceMode: "exclusive",
  });
  return { db, owner, source, writeGate: directWriteGate(db) };
}

describe("SourceModeTransitionCoordinator", () => {
  test("transition does not resolve until its async completion publication finishes", async () => {
    const { db, owner, source, writeGate } = fixture();
    let release!: () => void;
    const publication = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new SourceModeTransitionCoordinator({
      db,
      writeGate,
      adoption: { adoptExclusiveToPartitioned: async () => {} },
      onCompleted: async () => publication,
    });
    let resolved = false;

    const transition = coordinator.transition(source.id, "partitioned", owner.id, []).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(getSource(db, source.id)?.multiDeviceMode).toBe("partitioned"));
    expect(resolved).toBe(false);

    release();
    await transition;
    expect(resolved).toBe(true);
  });

  test("a resumed transition publishes its completed source through the shared callback", async () => {
    const { db, owner, source, writeGate } = fixture();
    prepareSourceModeTransition(db, source.id, "partitioned", owner.id);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = vi.fn();
    const restarted = new SourceModeTransitionCoordinator({
      db,
      writeGate,
      adoption: { adoptExclusiveToPartitioned: async () => blocked },
      onCompleted: completed,
    });

    restarted.resumePending();
    await vi.waitFor(() => expect(getSourceModeTransition(db, source.id)).not.toBeNull());
    expect(completed).not.toHaveBeenCalled();
    release();

    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    expect(completed).toHaveBeenCalledWith(source.id);
  });

  test("a resumed replicated transition keeps shared analytics in place", async () => {
    const { db, owner, source, writeGate } = fixture();
    updateDeviceCapabilities(db, owner.id, {
      hostableSourceTypes: [SourceType("notes-synth")],
      multiDeviceModes: { "notes-synth": "replicated" },
      memberScopedParams: { "notes-synth": [] },
      syncLease: true,
    });
    prepareSourceModeTransition(db, source.id, "replicated", owner.id);
    const analyticsAdoption = vi.fn(() =>
      Promise.reject(new Error("replicated history must remain shared")),
    );
    const restarted = new SourceModeTransitionCoordinator({
      db,
      writeGate,
      adoption: { adoptExclusiveToPartitioned: analyticsAdoption },
    });

    restarted.resumePending();

    await vi.waitFor(() => expect(getSource(db, source.id)?.multiDeviceMode).toBe("replicated"));
    expect(analyticsAdoption).not.toHaveBeenCalled();
    expect(getSourceModeTransition(db, source.id)).toBeNull();
    restarted.dispose();
  });

  test("a resumed transition retries transient failures with bounded backoff until it succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { db, owner, source, writeGate } = fixture();
      prepareSourceModeTransition(db, source.id, "partitioned", owner.id);
      const adopt = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("synthetic outage one"))
        .mockRejectedValueOnce(new Error("synthetic outage two"))
        .mockResolvedValue(undefined);
      const completed = vi.fn();
      const restarted = new SourceModeTransitionCoordinator({
        db,
        writeGate,
        adoption: { adoptExclusiveToPartitioned: adopt },
        onCompleted: completed,
        retryBaseMs: 10,
        retryMaxMs: 20,
      });

      restarted.resumePending();
      await vi.advanceTimersByTimeAsync(0);
      expect(adopt).toHaveBeenCalledTimes(1);
      expect(getSourceModeTransition(db, source.id)?.lastError).toBe("synthetic outage one");
      await vi.advanceTimersByTimeAsync(9);
      expect(adopt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(adopt).toHaveBeenCalledTimes(2);
      expect(getSourceModeTransition(db, source.id)?.lastError).toBe("synthetic outage two");
      await vi.advanceTimersByTimeAsync(19);
      expect(adopt).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(adopt).toHaveBeenCalledTimes(3);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(getSource(db, source.id)?.multiDeviceMode).toBe("partitioned");
      expect(getSourceModeTransition(db, source.id)).toBeNull();
      restarted.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed completion publication is resumed from its durable journal after restart", async () => {
    const { db, owner, source, writeGate } = fixture();
    const failedPublication = vi.fn(async () => {
      throw new Error("synthetic config mirror outage");
    });
    const first = new SourceModeTransitionCoordinator({
      db,
      writeGate,
      adoption: { adoptExclusiveToPartitioned: async () => {} },
      onCompleted: failedPublication,
      retryBaseMs: 60_000,
    });

    await first.transition(source.id, "partitioned", owner.id, []);
    first.dispose();
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("partitioned");
    expect(failedPublication).toHaveBeenCalledTimes(1);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM source_mode_transition_publications").get(),
    ).toEqual({ count: 1 });

    const recoveredPublication = vi.fn(async () => {});
    const restarted = new SourceModeTransitionCoordinator({
      db,
      writeGate,
      adoption: { adoptExclusiveToPartitioned: async () => {} },
      onCompleted: recoveredPublication,
    });
    restarted.resumePending();

    await vi.waitFor(() => expect(recoveredPublication).toHaveBeenCalledTimes(1));
    expect(recoveredPublication).toHaveBeenCalledWith(source.id);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM source_mode_transition_publications").get(),
    ).toEqual({ count: 0 });
    restarted.dispose();
  });

  test("concurrent requests await the same adoption instead of reporting an exclusive source as complete", async () => {
    const { db, owner, source, writeGate } = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adopt = vi.fn(async () => blocked);
    const coordinator = new SourceModeTransitionCoordinator({
      db,
      writeGate,
      adoption: { adoptExclusiveToPartitioned: adopt },
    });

    const first = coordinator.transition(source.id, "partitioned", owner.id, []);
    await vi.waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));
    let secondSettled = false;
    const second = coordinator.transition(source.id, "partitioned", owner.id, []).finally(() => {
      secondSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("partitioned");
  });

  test("an analytics adoption failure leaves a durable pending journal and exclusive source", async () => {
    const { db, owner, source, writeGate } = fixture();
    const coordinator = new SourceModeTransitionCoordinator({
      db,
      writeGate,
      adoption: {
        adoptExclusiveToPartitioned: vi.fn(async () => {
          throw new Error("synthetic analytics outage");
        }),
      },
    });

    await expect(coordinator.transition(source.id, "partitioned", owner.id, [])).rejects.toThrow(
      "synthetic analytics outage",
    );
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
    expect(getSourceModeTransition(db, source.id)).toMatchObject({
      sourceId: source.id,
      lastError: "synthetic analytics outage",
    });
  });

  test("a structured page carrying the old shared epoch stays stale after owner-scope rerouting", async () => {
    const { db, owner, source, writeGate } = fixture();
    const oldSharedEpoch = beginSyncAttempt(db, source.id, "");
    const coordinator = new SourceModeTransitionCoordinator({
      db,
      writeGate,
      adoption: { adoptExclusiveToPartitioned: () => Promise.resolve() },
    });
    await coordinator.transition(source.id, "partitioned", owner.id, []);

    const ingestPage = vi.fn(() => Promise.resolve({ ingested: 1, deleted: 0 }));
    const analytics = new AnalyticsService(
      { ingestPage } as unknown as AnalyticsDb,
      undefined,
      false,
      (sourceId, cursorRow) => getWipeEpoch(db, sourceId, cursorRow),
      new SourceWriteEpochFence(),
    );
    const result = await analytics.ingest({
      tableName: "fictional_transition_rows",
      records: [{ id: "stale-row" }],
      sourceId: source.id,
      cursorRow: owner.id,
      streamId: owner.id,
      writeEpoch: oldSharedEpoch,
    });

    expect(result).toEqual({ ingested: 0, deleted: 0 });
    expect(ingestPage).not.toHaveBeenCalled();
  });

  test("a new coordinator resumes the durable journal through the idempotent adoption seam", async () => {
    const { db, owner, source, writeGate } = fixture();
    prepareSourceModeTransition(db, source.id, "partitioned", owner.id);
    const adopt = vi.fn(async () => {});
    const restarted = new SourceModeTransitionCoordinator({
      db,
      writeGate,
      adoption: { adoptExclusiveToPartitioned: adopt },
    });

    restarted.resumePending();

    await vi.waitFor(() => expect(getSource(db, source.id)?.multiDeviceMode).toBe("partitioned"));
    expect(adopt).toHaveBeenCalledWith(source.id, owner.id);
    expect(getSourceModeTransition(db, source.id)).toBeNull();
  });

  test("a new coordinator resumes after a crash between bounded SQLite batches", async () => {
    const { db, owner, source, writeGate } = fixture();
    const insert = db.prepare(
      `INSERT INTO removed_documents
         (provider_id, source_id, external_id, stream_id, removed_at)
       VALUES ('notes-synth', ?, ?, '', 10)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 101; index += 1) insert.run(source.id, `entry-${index}`);
    })();
    let batchCalls = 0;
    const crashingGate = {
      ...writeGate,
      adoptSourceModeTransitionBatch: async (sourceId: typeof source.id) => {
        batchCalls += 1;
        if (batchCalls === 2) throw new Error("synthetic process stop");
        return writeGate.adoptSourceModeTransitionBatch(sourceId);
      },
    };
    const firstAdoption = vi.fn(async () => {});
    const first = new SourceModeTransitionCoordinator({
      db,
      writeGate: crashingGate,
      adoption: { adoptExclusiveToPartitioned: firstAdoption },
    });

    await expect(first.transition(source.id, "partitioned", owner.id, [])).rejects.toThrow(
      "synthetic process stop",
    );
    expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
    expect(getSourceModeTransition(db, source.id)).not.toBeNull();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM removed_documents WHERE source_id = ? AND stream_id = ''",
        )
        .get(source.id),
    ).toEqual({ n: 1 });

    const resumedAdoption = vi.fn(async () => {});
    const restarted = new SourceModeTransitionCoordinator({
      db,
      writeGate,
      adoption: { adoptExclusiveToPartitioned: resumedAdoption },
    });
    restarted.resumePending();

    await vi.waitFor(() => expect(getSource(db, source.id)?.multiDeviceMode).toBe("partitioned"));
    expect(firstAdoption).toHaveBeenCalledTimes(1);
    expect(resumedAdoption).toHaveBeenCalledWith(source.id, owner.id);
    expect(getSourceModeTransition(db, source.id)).toBeNull();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM removed_documents WHERE source_id = ? AND stream_id = ?",
        )
        .get(source.id, owner.id),
    ).toEqual({ n: 101 });
  });

  test("restart recovers after DuckDB commits but before SQLite finalizes without duplicates", async () => {
    const sqlitePath = `/tmp/omnesis-transition-recovery-${crypto.randomUUID()}.sqlite`;
    const analyticsPath = `/tmp/omnesis-transition-recovery-${crypto.randomUUID()}.duckdb`;
    let db = createDatabase(sqlitePath);
    let analytics = new AnalyticsDb(analyticsPath);
    let first: SourceModeTransitionCoordinator | null = null;
    let restarted: SourceModeTransitionCoordinator | null = null;
    const schema: AnalyticsTableSchema = {
      tableName: "fictional_transition_rows",
      displayName: "Transition rows",
      description: "Synthetic transition recovery rows",
      columns: [
        { name: "id", type: "VARCHAR", description: "Stable id" },
        { name: "value", type: "BIGINT", description: "Synthetic value" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id"] },
    };

    try {
      const owner = createDevice(db, {
        name: "collector-restart",
        kind: "collector",
        capabilities: {
          hostableSourceTypes: [SourceType("notes-synth")],
          multiDeviceModes: { "notes-synth": "partitioned" },
          memberScopedParams: { "notes-synth": [] },
        },
      });
      const source = createSource(db, {
        type: SourceType("notes-synth"),
        accountId: AccountId("restart-fictional"),
        deviceId: owner.id,
        multiDeviceMode: "exclusive",
      });
      await analytics.open();
      await analytics.ingestPage({
        tableName: schema.tableName,
        records: [{ id: "row-1", value: 1 }],
        schema,
        sourceId: source.id,
      });
      const bridge = new AnalyticsSourceModeTransitionAdoption({
        db,
        analyticsDb: analytics,
        writeEpochFence: new SourceWriteEpochFence(),
      });
      first = new SourceModeTransitionCoordinator({
        db,
        writeGate: directWriteGate(db),
        adoption: {
          adoptExclusiveToPartitioned: async (sourceId, ownerDeviceId) => {
            await bridge.adoptExclusiveToPartitioned(sourceId, ownerDeviceId);
            throw new Error("synthetic stop after DuckDB commit");
          },
        },
      });

      await expect(first.transition(source.id, "partitioned", owner.id, [])).rejects.toThrow(
        "synthetic stop after DuckDB commit",
      );
      expect(getSource(db, source.id)?.multiDeviceMode).toBe("exclusive");
      expect(getSourceModeTransition(db, source.id)).not.toBeNull();
      expect(
        (await analytics.executeQuery("SELECT id, _stream_id FROM fictional_transition_rows")).rows,
      ).toEqual([["row-1", owner.id]]);
      expect(
        (
          await analytics.executeQuery(
            "SELECT stream_keyed FROM _analytics_catalog WHERE table_name = 'fictional_transition_rows'",
          )
        ).rows,
      ).toEqual([[true]]);

      first.dispose();
      first = null;
      await analytics.close();
      db.close();

      db = createDatabase(sqlitePath);
      analytics = new AnalyticsDb(analyticsPath);
      await analytics.open();
      expect(
        (
          await analytics.executeQuery(
            "SELECT stream_keyed FROM _analytics_catalog WHERE table_name = 'fictional_transition_rows'",
          )
        ).rows,
      ).toEqual([[true]]);
      const reopenedBridge = new AnalyticsSourceModeTransitionAdoption({
        db,
        analyticsDb: analytics,
        writeEpochFence: new SourceWriteEpochFence(),
      });
      restarted = new SourceModeTransitionCoordinator({
        db,
        writeGate: directWriteGate(db),
        adoption: reopenedBridge,
      });
      restarted.resumePending();
      await vi.waitFor(() => expect(getSource(db, source.id)?.multiDeviceMode).toBe("partitioned"));
      expect(
        (await analytics.executeQuery("SELECT id, _stream_id FROM fictional_transition_rows")).rows,
      ).toEqual([["row-1", owner.id]]);
      expect(getSourceModeTransition(db, source.id)).toBeNull();
    } finally {
      first?.dispose();
      restarted?.dispose();
      await analytics.close();
      db.close();
      for (const path of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
        if (existsSync(path)) unlinkSync(path);
      }
      if (existsSync(analyticsPath)) unlinkSync(analyticsPath);
      if (existsSync(`${analyticsPath}.wal`)) unlinkSync(`${analyticsPath}.wal`);
    }
  });
});

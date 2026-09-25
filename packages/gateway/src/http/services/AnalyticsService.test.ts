// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the analytics-ingest service. The DuckDB engine itself is
 * exercised in `analytics-db.test.ts`; here we lock the service-level
 * orchestration — schema-ensure → upsert → tombstone delete → catalog stats —
 * with a fake `AnalyticsDb` that records calls. The deletion path
 * (`deletedIds` → `deleteRecords`) is the structured-source tombstone wiring
 * a Health Connect / Apple Health source relies on.
 */
import { describe, expect, it, vi } from "vitest";
import { encodeRowKey, RowKeyError } from "@omnesis/source-sdk";
import { BadRequestError } from "../errors.js";
import { SourceWriteEpochFence, epochScope } from "../../source-write-epoch-fence.js";
import { EventBus } from "../../events.js";
import { AnalyticsService } from "./AnalyticsService.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { AnalyticsDb } from "../../analytics-db.js";
import type { AnalyticsReplicaHooks } from "../../analytics/table-manager.js";
import type { AnalyticsReplicaLedger } from "./AnalyticsService.js";

const schema: AnalyticsTableSchema = {
  tableName: "hc_body",
  displayName: "Body",
  description: "Body measurements",
  columns: [
    { name: "id", type: "VARCHAR", description: "Record id" },
    { name: "value", type: "DOUBLE", description: "Reading", nullable: true },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["id"], keyColumns: ["id", "value"] },
};

function fakeDb(overrides: Partial<AnalyticsDb> = {}) {
  return {
    // The columns a table is addressed by, as the real façade answers from the
    // persisted declaration. The fixtures below are keyed on `(item_id, id)`
    // wherever they name rows as records.
    rowKeyColumns: vi.fn(async (_table: string, schema?: AnalyticsTableSchema) =>
      schema ? (schema.deleteKey ?? schema.primaryKey) : ["item_id", "id"],
    ),
    pageRowKeys: vi.fn(async (page: Parameters<AnalyticsDb["pageRowKeys"]>[0]) => {
      const columns = page.schema
        ? (page.schema.deleteKey ?? page.schema.primaryKey)
        : ["item_id", "id"];
      return {
        deleted: page.deletedKeys?.map((key) => encodeRowKey(columns, key)) ?? page.deletedIds,
        present: page.presentKeys?.map((key) => encodeRowKey(columns, key)) ?? page.presentIds,
      };
    }),
    ingestPage: vi.fn(
      async (input: {
        records: unknown[];
        deletedIds?: string[];
        ledgerDeletedKeys?: string[];
        schema?: AnalyticsTableSchema;
        deleteKeyColumn?: string;
        replica?: AnalyticsReplicaHooks;
      }) => {
        if (
          input.deletedIds?.length &&
          !input.deleteKeyColumn &&
          (input.schema?.primaryKey.length ?? 1) > 1
        ) {
          throw new Error("Cannot delete from table: it has a composite primary key");
        }
        if (input.deleteKeyColumn && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.deleteKeyColumn)) {
          throw new Error(`Invalid identifier: ${input.deleteKeyColumn}`);
        }
        if (input.replica && input.records.length > 0) {
          await input.replica.recordPresence(
            input.records.map((record) => String((record as { id: string }).id)),
          );
        }
        // The manager applies the page's own deletions and the ones the
        // gateway derived from the ledger as one set, so the double counts
        // them the same way.
        const named = [...(input.deletedIds ?? []), ...(input.ledgerDeletedKeys ?? [])];
        const deleted = input.replica
          ? named.length
            ? (await input.replica.judgeDeletions(named)).apply.length
            : 0
          : named.length;
        return { ingested: input.records.length, deleted };
      },
    ),
    ...overrides,
  } as unknown as AnalyticsDb;
}

describe("AnalyticsService.ingest", () => {
  it("refuses analytics and Watch outbox writes below the disk floor", async () => {
    const analytics = fakeDb();
    const svc = new AnalyticsService(
      analytics,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        dbPath: "/tmp/omnesis-test.db",
        minFreeBytes: 500 * 1024 * 1024,
        check: () => ({ ok: false, freeBytes: 100 * 1024 * 1024 }),
      },
    );

    await expect(
      svc.ingest({ tableName: "hc_body", sourceId: "health-connect:local", schema, records: [] }),
    ).rejects.toMatchObject({ status: 507, code: "INSUFFICIENT_STORAGE" });
    expect(analytics.ingestPage).not.toHaveBeenCalled();
  });

  it("does not copy committed rows onto the synchronous event bus", async () => {
    // Watch consumes the transactional DuckDB outbox. Copying each row onto
    // the synchronous bus adds request-path work and recreates the lossy RAM
    // hand-off the outbox replaced.
    const bus = new EventBus();
    const seen: Record<string, unknown>[] = [];
    bus.on("analytics_row.inserted", (e) => seen.push(e.row));
    const svc = new AnalyticsService(fakeDb(), bus, false);

    await svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      schema,
      records: [{ id: "row-1", value: 70 }],
      streamId: "device-a",
    });
    await svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      schema,
      records: [{ id: "row-1", value: 70 }],
      streamId: "",
    });

    expect(seen).toEqual([]);
  });

  it.each([2, 4])("rejects unclaimed analytics epoch %s when current is 3", async (writeEpoch) => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false, () => 3);

    await expect(
      svc.ingest({
        tableName: "hc_body",
        sourceId: "health-connect:local",
        schema,
        records: [{ id: "stale", value: 70 }],
        writeEpoch,
      }),
    ).resolves.toEqual({ ingested: 0, deleted: 0 });
    expect(db.ingestPage).not.toHaveBeenCalled();
  });

  it("rejects an omitted epoch after a modern attempt claims the source", async () => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false, () => 3);

    await expect(
      svc.ingest({
        tableName: "hc_body",
        sourceId: "health-connect:local",
        schema,
        records: [{ id: "stale", value: 70 }],
      }),
    ).resolves.toEqual({ ingested: 0, deleted: 0 });
    expect(db.ingestPage).not.toHaveBeenCalled();
  });

  it("allows schema-only catalog refresh without a sync epoch", async () => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false, () => 3);

    await expect(
      svc.ingest({
        tableName: "hc_body",
        sourceId: "health-connect:local",
        schema,
        records: [],
      }),
    ).resolves.toEqual({ ingested: 0, deleted: 0 });
    expect(db.ingestPage).toHaveBeenCalledOnce();
  });

  it("rejects a schema-only refresh carrying a stale supplied epoch", async () => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false, () => 3);

    await expect(
      svc.ingest({
        tableName: "hc_body",
        sourceId: "health-connect:local",
        schema,
        records: [],
        writeEpoch: 2,
      }),
    ).resolves.toEqual({ ingested: 0, deleted: 0 });
    expect(db.ingestPage).not.toHaveBeenCalled();
  });

  it("serializes analytics writes with the next epoch claim", async () => {
    let releaseIngest!: () => void;
    const ingestBlocked = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    const db = fakeDb({
      ingestPage: vi.fn(async () => {
        await ingestBlocked;
        return { ingested: 1, deleted: 0 };
      }),
    });
    let epoch = 1;
    const fence = new SourceWriteEpochFence();
    const svc = new AnalyticsService(db, undefined, false, () => epoch, fence);
    const ingest = svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      schema,
      records: [{ id: "current", value: 71 }],
      writeEpoch: 1,
    });
    await vi.waitFor(() => expect(db.ingestPage).toHaveBeenCalled());

    let claimed = false;
    const claim = fence.run(epochScope("health-connect:local"), async () => {
      epoch = 2;
      claimed = true;
    });
    await Promise.resolve();
    expect(claimed).toBe(false);

    releaseIngest();
    await expect(ingest).resolves.toEqual({ ingested: 1, deleted: 0 });
    await claim;
    expect(claimed).toBe(true);
  });

  /** A ledger fake whose verdicts the test scripts; every call is recorded in order. */
  function fakeLedger(opts: {
    order?: string[];
    verdict?: (args: { existingIds: readonly string[]; deletionAuthority: boolean }) => {
      apply: string[];
      deferred?: string[];
      disputed?: string[];
      newlyDisputed?: number;
    };
    restored?: string[];
    matured?: string[];
    /** Keys with a history in the ledger; every key, when unset. */
    claimed?: string[];
    onJudge?: () => void;
  }) {
    const calls = {
      judge: [] as Array<{ existingIds: readonly string[]; deletionAuthority: boolean }>,
      presence: [] as Array<readonly string[]>,
      omissions: [] as Array<{ named: readonly string[]; omitted: readonly string[] }>,
    };
    const ledger: AnalyticsReplicaLedger = {
      cursorRows: () => ["", "alpha", "beta"],
      omissionCandidates: () => opts.restored ?? [],
      claimedKeys: (_sourceId, _tableName, keys) =>
        opts.claimed ? keys.filter((key) => opts.claimed!.includes(key)) : [...keys],
      judgeTombstones: async (args) => {
        calls.judge.push({
          existingIds: args.existingIds,
          deletionAuthority: args.deletionAuthority,
        });
        opts.onJudge?.();
        opts.order?.push("judge");
        const verdict = opts.verdict?.(args) ?? { apply: [...args.existingIds] };
        return {
          apply: verdict.apply,
          deferred: verdict.deferred ?? [],
          disputed: verdict.disputed ?? [],
          newlyDisputed: verdict.newlyDisputed ?? 0,
        };
      },
      recordPresence: async (args) => {
        calls.presence.push(args.keyValues);
      },
      recordRestorerOmissions: async (args) => {
        calls.omissions.push(args.snapshot);
        return opts.matured ?? [];
      },
    };
    return { ledger, calls };
  }
  const policy = () => ({ minObservations: 3, minAgeMs: 60_000, maxMarksPerSnapshot: 200 });

  it("returns a bad request for invalid keys during replica snapshot preflight", async () => {
    const db = fakeDb({
      pageRowKeys: vi.fn(async () => {
        throw new RowKeyError("Row key value cannot be represented by the declared column");
      }),
    });
    const { ledger, calls } = fakeLedger({ restored: ["kept"] });
    const svc = new AnalyticsService(db, undefined, false, undefined, undefined, policy, ledger);

    await expect(
      svc.ingest({
        tableName: "hc_body",
        sourceId: "health-connect:local",
        records: [],
        presentKeys: [{ id: "invalid" }],
        replicaClaimDeviceId: "alpha",
        deletionAuthority: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(db.ingestPage).not.toHaveBeenCalled();
    expect(calls.omissions).toEqual([]);
  });

  it("fences every sibling write while a replicated tombstone is judged before deletion", async () => {
    let releaseSibling!: () => void;
    const siblingBlocked = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const order: string[] = [];
    const db = fakeDb({
      ingestPage: vi.fn(async (input: Parameters<AnalyticsDb["ingestPage"]>[0]) => {
        if (input.records.some((record) => record.id === "sibling")) {
          await siblingBlocked;
          order.push("sibling-write");
        }
        let deleted = 0;
        if (input.deletedIds?.length) {
          deleted = (await input.replica!.judgeDeletions(input.deletedIds)).apply.length;
          order.push("holder-delete");
        }
        return { ingested: input.records.length, deleted };
      }),
    });
    const epochs = new Map([
      ["alpha", 1],
      ["beta", 1],
    ]);
    // The holder's verdict resets its sibling, the way the writer op does.
    const { ledger, calls } = fakeLedger({ order, onJudge: () => epochs.set("beta", 2) });
    const svc = new AnalyticsService(
      db,
      undefined,
      false,
      (_sourceId, cursorRow) => epochs.get(cursorRow) ?? 0,
      new SourceWriteEpochFence(),
      undefined,
      ledger,
    );

    const sibling = svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      cursorRow: "beta",
      records: [{ id: "sibling", value: 72 }],
      writeEpoch: 1,
    });
    await vi.waitFor(() => expect(db.ingestPage).toHaveBeenCalledTimes(1));
    const holder = svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      cursorRow: "alpha",
      records: [],
      deletedIds: ["shared"],
      writeEpoch: 1,
      replicaClaimDeviceId: "alpha",
      deletionAuthority: true,
    });
    await Promise.resolve();
    expect(calls.judge).toEqual([]);

    releaseSibling();
    await expect(sibling).resolves.toMatchObject({ ingested: 1 });
    await expect(holder).resolves.toEqual({ ingested: 0, deleted: 1 });
    expect(order).toEqual(["sibling-write", "judge", "holder-delete"]);
    expect(calls.judge).toEqual([{ existingIds: ["shared"], deletionAuthority: true }]);
  });

  it("a member's rows are its presence claims, and a fresh deletion it may not lead is deferred", async () => {
    const db = fakeDb();
    const { ledger, calls } = fakeLedger({
      verdict: ({ existingIds, deletionAuthority }) =>
        deletionAuthority ? { apply: [...existingIds] } : { apply: [], deferred: [...existingIds] },
    });
    const svc = new AnalyticsService(db, undefined, false, undefined, undefined, undefined, ledger);

    const result = await svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      cursorRow: "beta",
      records: [{ id: "held", value: 1 }],
      deletedIds: ["fresh"],
      replicaClaimDeviceId: "beta",
      deletionAuthority: false,
    });

    // The rows land; the tombstone waits for the holder; the page says so.
    expect(result).toEqual({ ingested: 1, deleted: 0, deletionDeferred: true });
    expect(calls.presence).toEqual([["held"]]);
    expect(calls.judge).toEqual([{ existingIds: ["fresh"], deletionAuthority: false }]);
  });

  it("reports the tombstones a dispute kept from taking effect", async () => {
    const db = fakeDb();
    const { ledger } = fakeLedger({
      verdict: () => ({ apply: ["settled"], disputed: ["kept"], newlyDisputed: 1 }),
    });
    const svc = new AnalyticsService(db, undefined, false, undefined, undefined, undefined, ledger);

    const result = await svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      cursorRow: "alpha",
      records: [],
      deletedIds: ["settled", "kept"],
      replicaClaimDeviceId: "alpha",
      deletionAuthority: true,
    });

    expect(result).toEqual({ ingested: 0, deleted: 1, deletionDisputed: 1 });
  });

  it("a member's snapshot speaks for the rows it keeps alive; matured omissions join its tombstones", async () => {
    const db = fakeDb();
    const { ledger, calls } = fakeLedger({ restored: ["r-1", "r-2", "r-3"], matured: ["r-3"] });
    const svc = new AnalyticsService(db, undefined, false, undefined, undefined, policy, ledger);

    // Without deletion authority the snapshot is not reconciled, only read.
    const nonHolder = await svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      cursorRow: "beta",
      records: [],
      presentIds: ["r-1", "other"],
      observationId: "obs-1",
      replicaClaimDeviceId: "beta",
      deletionAuthority: false,
    });
    expect(calls.omissions).toEqual([{ named: ["r-1"], omitted: ["r-2", "r-3"] }]);
    // The matured omission rides as a ledger key rather than as one of the
    // page's own: it came out of the ledger already canonical, and a page that
    // named its rows as records could not have carried it.
    expect(db.ingestPage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ledgerDeletedKeys: ["r-3"],
        presentIds: undefined,
        observedBy: "beta",
      }),
    );
    expect(nonHolder).toEqual({ ingested: 0, deleted: 1 });

    // The holder's snapshot is reconciled as well, attributed to it.
    await svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      cursorRow: "alpha",
      records: [],
      presentIds: ["r-1", "r-2", "r-3"],
      observationId: "obs-2",
      replicaClaimDeviceId: "alpha",
      deletionAuthority: true,
    });
    expect(db.ingestPage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentIds: ["r-1", "r-2", "r-3"],
        observationId: "obs-2",
        observedBy: "alpha",
      }),
    );
  });

  it("a stale attempt's replicated page neither counts omissions nor judges anything", async () => {
    const db = fakeDb();
    const { ledger, calls } = fakeLedger({ restored: ["r-1"] });
    const svc = new AnalyticsService(
      db,
      undefined,
      false,
      () => 5,
      new SourceWriteEpochFence(),
      policy,
      ledger,
    );

    const result = await svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      cursorRow: "beta",
      records: [{ id: "late", value: 1 }],
      deletedIds: ["r-1"],
      presentIds: [],
      writeEpoch: 4,
      replicaClaimDeviceId: "beta",
      deletionAuthority: false,
    });

    expect(result).toEqual({ ingested: 0, deleted: 0 });
    expect(db.ingestPage).not.toHaveBeenCalled();
    expect(calls.omissions).toEqual([]);
    expect(calls.judge).toEqual([]);
  });

  it("upserts records and ensures the table from the attached schema", async () => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false);

    const result = await svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      schema,
      records: [{ id: "a", value: 72.4 }],
    });

    expect(result).toEqual({ ingested: 1, deleted: 0 });
    expect(db.ingestPage).toHaveBeenCalledWith({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      schema,
      records: [{ id: "a", value: 72.4 }],
      deletedIds: undefined,
      deleteKeyColumn: undefined,
      presentIds: undefined,
    });
  });

  it("hands the page's device stream to the store", async () => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false);

    await svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      schema,
      records: [{ id: "a", value: 72.4 }],
      streamId: "device-a",
    });

    expect(db.ingestPage).toHaveBeenCalledWith(expect.objectContaining({ streamId: "device-a" }));
  });

  it("applies tombstones: deletedIds are removed via the single-column primary key", async () => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false);

    const result = await svc.ingest({
      tableName: "hc_body",
      sourceId: "health-connect:local",
      schema,
      records: [],
      deletedIds: ["x", "y"],
    });

    expect(result).toEqual({ ingested: 0, deleted: 2 });
    expect(db.ingestPage).toHaveBeenCalledWith(
      expect.objectContaining({ tableName: "hc_body", deletedIds: ["x", "y"] }),
    );
  });

  it("upserts then deletes in one page, so a record updated+deleted ends up gone", async () => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false);

    await svc.ingest({
      tableName: "hc_body",
      schema,
      records: [{ id: "a", value: 1 }],
      deletedIds: ["a"],
    });

    expect(db.ingestPage).toHaveBeenCalledWith(
      expect.objectContaining({ records: [{ id: "a", value: 1 }], deletedIds: ["a"] }),
    );
  });

  it("resolves the primary key from the table when no schema is attached (deletion-only page)", async () => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false);

    const result = await svc.ingest({
      tableName: "hc_body",
      records: [],
      deletedIds: ["gone"],
    });

    expect(db.ingestPage).toHaveBeenCalledWith(
      expect.objectContaining({ tableName: "hc_body", deletedIds: ["gone"] }),
    );
    expect(result.deleted).toBe(1);
  });

  it("deletes on deleteKeyColumn when given, so fanned-out rows share one tombstone", async () => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false);

    const result = await svc.ingest({
      tableName: "hc_vitals",
      records: [],
      deletedIds: ["hr-record-1"],
      deleteKeyColumn: "record_id",
    });

    expect(db.ingestPage).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: "hc_vitals",
        deletedIds: ["hr-record-1"],
        deleteKeyColumn: "record_id",
      }),
    );
    expect(result.deleted).toBe(1);
  });

  it("rejects a composite-PK delete with no explicit deleteKeyColumn (no silent over-delete)", async () => {
    // #669: matching `deletedIds` on `primaryKey[0]` alone would delete every row
    // sharing the first key column's value — data loss. Fail loud instead.
    const compositeSchema: AnalyticsTableSchema = {
      tableName: "fin_transactions",
      displayName: "Transactions",
      description: "Per-account transactions",
      columns: [
        { name: "account_key", type: "VARCHAR", description: "Account id" },
        { name: "transaction_key", type: "VARCHAR", description: "Transaction id" },
      ],
      primaryKey: ["account_key", "transaction_key"],
      semanticTimeColumn: null,
      record: { titleColumns: ["account_key"], keyColumns: ["account_key", "transaction_key"] },
    };
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false);

    await expect(
      svc.ingest({
        tableName: "fin_transactions",
        schema: compositeSchema,
        records: [],
        deletedIds: ["acct-1"],
      }),
      // A BadRequestError so the route surfaces a 400 carrying the message,
      // not a sanitized 500 (#669).
    ).rejects.toThrowError(BadRequestError);
    expect(db.ingestPage).toHaveBeenCalledOnce();
  });

  it("a row named by the wrong columns is a bad request, whatever the wording", async () => {
    // The classification used to be the first words of the message, so a
    // refusal phrased any other way became a sanitized 500: the client was told
    // nothing, and its own mistake was filed as a gateway bug. A refusal that
    // says so by its type cannot drift out of the list by being reworded.
    const db = fakeDb({
      ingestPage: vi.fn(() => {
        throw new RowKeyError("A row key for this table names (item_id, id); got (id)");
      }),
    });
    const svc = new AnalyticsService(db, undefined, false);

    await expect(
      svc.ingest({
        tableName: "fin_transactions",
        records: [],
        deletedKeys: [{ id: "e1" }],
      }),
    ).rejects.toThrowError(BadRequestError);
  });

  it("does not reject a composite-PK page that has no deletes (upsert-only)", async () => {
    // The composite-PK guard only fires on a delete; a page with records and no
    // `deletedIds` must upsert cleanly without tripping it.
    const compositeSchema: AnalyticsTableSchema = {
      tableName: "fin_transactions",
      displayName: "Transactions",
      description: "Per-account transactions",
      columns: [
        { name: "account_key", type: "VARCHAR", description: "Account id" },
        { name: "transaction_key", type: "VARCHAR", description: "Transaction id" },
      ],
      primaryKey: ["account_key", "transaction_key"],
      semanticTimeColumn: null,
      record: { titleColumns: ["account_key"], keyColumns: ["account_key", "transaction_key"] },
    };
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false);

    const result = await svc.ingest({
      tableName: "fin_transactions",
      schema: compositeSchema,
      records: [{ account_key: "acct-1", transaction_key: "txn-1" }],
    });

    expect(result.deleted).toBe(0);
    expect(db.ingestPage).toHaveBeenCalledOnce();
  });

  it("accepts a composite-PK delete when an explicit deleteKeyColumn is given", async () => {
    const compositeSchema: AnalyticsTableSchema = {
      tableName: "fin_transactions",
      displayName: "Transactions",
      description: "Per-account transactions",
      columns: [
        { name: "account_key", type: "VARCHAR", description: "Account id" },
        { name: "transaction_key", type: "VARCHAR", description: "Transaction id" },
      ],
      primaryKey: ["account_key", "transaction_key"],
      semanticTimeColumn: null,
      record: { titleColumns: ["account_key"], keyColumns: ["account_key", "transaction_key"] },
    };
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false);

    const result = await svc.ingest({
      tableName: "fin_transactions",
      schema: compositeSchema,
      records: [],
      deletedIds: ["acct-1"],
      deleteKeyColumn: "account_key",
    });

    expect(db.ingestPage).toHaveBeenCalledWith(
      expect.objectContaining({ deletedIds: ["acct-1"], deleteKeyColumn: "account_key" }),
    );
    expect(result.deleted).toBe(1);
  });

  it("rejects a delete key column that is not a plain identifier", async () => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false);

    await expect(
      svc.ingest({
        tableName: "hc_vitals",
        records: [],
        deletedIds: ["x"],
        deleteKeyColumn: 'id" OR 1=1 --',
      }),
    ).rejects.toThrow(/Invalid identifier/);
    expect(db.ingestPage).toHaveBeenCalledOnce();
  });

  it("is a no-op delete when deletedIds is empty or absent", async () => {
    const db = fakeDb();
    const svc = new AnalyticsService(db, undefined, false);

    await svc.ingest({ tableName: "hc_body", schema, records: [{ id: "a" }], deletedIds: [] });
    expect(db.ingestPage).toHaveBeenCalledOnce();
  });
});

/**
 * A replicated member's page whose rows are named as records.
 *
 * The replica ledger speaks canonical row keys — that is what it stores — and
 * a page naming its rows by column has to be translated before it can be
 * compared with one. Untranslated, a restorer's snapshot reads as naming
 * nothing, so every row it keeps alive is counted as omitted, or none of them
 * are; either way the member's own evidence is not what the ledger judged.
 */
describe("AnalyticsService.ingest — a member's page keyed by record", () => {
  const REST = '["i1","kept"]';
  const GONE = '["i1","gone"]';

  it("compares a record-named snapshot with the ledger in the ledger's own keys", async () => {
    const db = fakeDb();
    const seen: Array<{ named: readonly string[]; omitted: readonly string[] }> = [];
    const ledger: AnalyticsReplicaLedger = {
      cursorRows: () => [""],
      omissionCandidates: () => [REST, GONE],
      claimedKeys: (_s, _t, keys) => [...keys],
      judgeTombstones: async (args) => ({
        apply: [...args.existingIds],
        deferred: [],
        disputed: [],
        newlyDisputed: 0,
      }),
      recordPresence: async () => {},
      recordRestorerOmissions: async (args) => {
        seen.push(args.snapshot);
        return ['["i1","matured"]'];
      },
    };
    const svc = new AnalyticsService(
      db,
      undefined,
      false,
      undefined,
      undefined,
      () => ({
        minObservations: 1,
        minAgeMs: 0,
        maxMarksPerSnapshot: 100,
      }),
      ledger,
    );

    await svc.ingest({
      tableName: "entries",
      records: [],
      sourceId: "example-bank:one",
      replicaClaimDeviceId: "device-a",
      deletionAuthority: true,
      presentKeys: [{ item_id: "i1", id: "kept" }],
    });

    // The kept row is named, the other is the omission the ledger judges.
    expect(seen).toEqual([{ named: [REST], omitted: [GONE] }]);
  });

  it("sends the matured omissions beside the page's own deletions, not merged into them", async () => {
    const db = fakeDb();
    const ledger: AnalyticsReplicaLedger = {
      cursorRows: () => [""],
      omissionCandidates: () => [GONE],
      claimedKeys: (_s, _t, keys) => [...keys],
      judgeTombstones: async (args) => ({
        apply: [...args.existingIds],
        deferred: [],
        disputed: [],
        newlyDisputed: 0,
      }),
      recordPresence: async () => {},
      recordRestorerOmissions: async () => [GONE],
    };
    const svc = new AnalyticsService(
      db,
      undefined,
      false,
      undefined,
      undefined,
      () => ({
        minObservations: 1,
        minAgeMs: 0,
        maxMarksPerSnapshot: 100,
      }),
      ledger,
    );

    await svc.ingest({
      tableName: "entries",
      records: [],
      sourceId: "example-bank:one",
      replicaClaimDeviceId: "device-a",
      deletionAuthority: true,
      presentKeys: [{ item_id: "i1", id: "kept" }],
      deletedKeys: [{ item_id: "i1", id: "named" }],
    });

    // A canonical key cannot be spelled as a record, so merging the two would
    // either lose the matured verdict or send a page naming its rows twice.
    expect(db.ingestPage).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedKeys: [{ item_id: "i1", id: "named" }],
        ledgerDeletedKeys: [GONE],
      }),
    );
  });
});

describe("AnalyticsService.sql — what a source may reach", () => {
  function serviceRecordingQueryScope() {
    const executeQuery = vi.fn(
      async (
        _sql: string,
        _opts?: { limit?: number; permittedSourceIds?: ReadonlySet<string> },
      ) => ({ rows: [], columns: [] }),
    );
    const svc = new AnalyticsService(
      fakeDb({ executeQuery } as unknown as Partial<AnalyticsDb>),
      undefined,
      false,
    );
    return { svc, executeQuery };
  }

  it("names both spellings of the caller's identity", async () => {
    // The catalog records a table one account owns outright under the full
    // `<type>:<account>` id, and a table its sibling accounts share under the
    // bare type. Naming only the full id denies a source the very table its
    // own rows live in.
    const { svc, executeQuery } = serviceRecordingQueryScope();
    await svc.sql("SELECT 1", 10, "lunchflow:personal");
    expect(executeQuery.mock.calls[0]?.[1]).toEqual({
      limit: 10,
      permittedSourceIds: new Set(["lunchflow:personal", "lunchflow"]),
    });
  });

  it("an unnamed caller is unrestricted — the gate is for named sources only", async () => {
    const { svc, executeQuery } = serviceRecordingQueryScope();
    await svc.sql("SELECT 1", 10);
    expect(executeQuery.mock.calls[0]?.[1]).toEqual({ limit: 10 });
  });
});

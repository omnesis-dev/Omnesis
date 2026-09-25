// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { AccountId, SourceType } from "@omnesis/types";
import { AnalyticsDb } from "../../analytics-db.js";
import { createDatabase } from "../../db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createSource, getSource } from "../../data/repositories/SourceRepository.js";
import { getSourceModeTransition } from "../../data/repositories/SourceModeTransitionRepository.js";
import { createServer } from "../../server.js";
import { SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import { directWriteGate } from "../../write-gate.js";
import { AnalyticsSourceModeTransitionAdoption } from "./AnalyticsSourceModeTransitionAdoption.js";
import { SourceModeTransitionCoordinator } from "./SourceModeTransitionCoordinator.js";
import type { StatusCache } from "./StatusCache.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("source mode transition durability", () => {
  test("the production boot hook resumes after both stores close past the DuckDB commit boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-mode-transition-durability-"));
    dirs.push(dir);
    const sqlitePath = join(dir, "omnesis.db");
    const analyticsPath = join(dir, "analytics.db");
    const schema: AnalyticsTableSchema = {
      tableName: "fictional_durable_rows",
      displayName: "Durable rows",
      description: "Synthetic rows for restart recovery",
      columns: [
        { name: "id", type: "VARCHAR", description: "Stable id" },
        { name: "value", type: "BIGINT", description: "Synthetic value" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id"] },
    };

    let sqlite = createDatabase(sqlitePath);
    let analytics = new AnalyticsDb(analyticsPath);
    await analytics.open();
    const owner = createDevice(sqlite, {
      name: "fictional-transition-host",
      kind: "collector",
      capabilities: {
        hostableSourceTypes: [SourceType("notes-synth")],
        multiDeviceModes: { "notes-synth": "partitioned" },
        memberScopedParams: { "notes-synth": [] },
      },
    });
    const source = createSource(sqlite, {
      type: SourceType("notes-synth"),
      accountId: AccountId("fictional-durable"),
      deviceId: owner.id,
      multiDeviceMode: "exclusive",
    });
    await analytics.ingestPage({
      tableName: schema.tableName,
      records: [{ id: "row-1", value: 1 }],
      schema,
      sourceId: source.id,
    });
    const firstBridge = new AnalyticsSourceModeTransitionAdoption({
      db: sqlite,
      analyticsDb: analytics,
      writeEpochFence: new SourceWriteEpochFence(),
    });
    const interrupted = new SourceModeTransitionCoordinator({
      db: sqlite,
      writeGate: directWriteGate(sqlite),
      adoption: {
        adoptExclusiveToPartitioned: async (sourceId, ownerDeviceId) => {
          await firstBridge.adoptExclusiveToPartitioned(sourceId, ownerDeviceId);
          throw new Error("synthetic process stop after durable analytics commit");
        },
      },
    });

    await expect(interrupted.transition(source.id, "partitioned", owner.id, [])).rejects.toThrow(
      "synthetic process stop after durable analytics commit",
    );
    expect(getSource(sqlite, source.id)?.multiDeviceMode).toBe("exclusive");
    expect(getSourceModeTransition(sqlite, source.id)).not.toBeNull();
    expect(
      (await analytics.executeQuery(`SELECT id, _stream_id FROM ${schema.tableName}`)).rows,
    ).toEqual([["row-1", owner.id]]);
    expect(
      (
        await analytics.executeQuery(
          "SELECT stream_keyed FROM _analytics_catalog WHERE table_name = 'fictional_durable_rows'",
        )
      ).rows,
    ).toEqual([[true]]);

    await analytics.close();
    sqlite.close();

    const raw = await DuckDBInstance.create(analyticsPath);
    const rawConn = await raw.connect();
    const persisted = await rawConn.runAndReadAll(
      "SELECT stream_keyed FROM _analytics_catalog WHERE table_name = 'fictional_durable_rows'",
    );
    expect(persisted.getRows()).toEqual([[true]]);
    rawConn.closeSync();
    raw.closeSync();

    sqlite = createDatabase(sqlitePath);
    analytics = new AnalyticsDb(analyticsPath);
    await analytics.open();
    expect(
      (
        await analytics.executeQuery(
          "SELECT stream_keyed FROM _analytics_catalog WHERE table_name = 'fictional_durable_rows'",
        )
      ).rows,
    ).toEqual([[true]]);
    let statusCache: StatusCache | undefined;
    // Construction is the production boot path. It creates fresh epoch and
    // coordinator instances, then invokes SourceService's durable resume hook.
    createServer(sqlite, sqlitePath, {
      analyticsDb: analytics,
      onStatusCache: (cache) => {
        statusCache = cache;
      },
    });

    try {
      await vi.waitFor(() =>
        expect(getSource(sqlite, source.id)?.multiDeviceMode).toBe("partitioned"),
      );
      expect(getSourceModeTransition(sqlite, source.id)).toBeNull();
      expect(
        (await analytics.executeQuery(`SELECT id, _stream_id FROM ${schema.tableName}`)).rows,
      ).toEqual([["row-1", owner.id]]);
    } finally {
      statusCache?.stop();
      await analytics.close();
      sqlite.close();
    }
  });
});

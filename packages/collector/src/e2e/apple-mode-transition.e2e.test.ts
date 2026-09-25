// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Acceptance coverage for upgrading an existing single-Mac hybrid Apple
 * source. The fixture is deliberately staged in the persisted legacy shape:
 * shared documents, analytics rows and cursor authority, with one exclusive
 * owner. The transition must preserve both stores across restart, then allow
 * a second real SyncEngine to join, sync and detach without changing the
 * shared corpus.
 */
import "./synth-env.js";
import SqliteDatabase from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { SyntheticE2EHarness, type HarnessDevice } from "./synth-harness.js";
import { getDocumentCount } from "./helpers.js";

const SOURCE_TYPE = "apple-call-log";
const ACCOUNT_ID = "john.smith@icloud.example";
const SOURCE_ID = `${SOURCE_TYPE}:${ACCOUNT_ID}`;

interface SourceRow {
  id: string;
  deviceId: string;
  members?: string[];
  multiDeviceMode?: string;
}

interface CursorRow {
  device_id: string;
  cursor: string;
  last_synced_at: string | null;
}

describe("Apple hybrid source mode transition", () => {
  let harness: SyntheticE2EHarness;
  let owner: HarnessDevice;
  let member: HarnessDevice;

  const sourceRow = async (): Promise<SourceRow> => {
    const { items } = await harness.gatewayJson<{ items: SourceRow[] }>("/admin/sources");
    const source = items.find((item) => item.id === SOURCE_ID);
    if (!source) throw new Error(`Missing source ${SOURCE_ID}`);
    return source;
  };

  const analyticsRows = async (): Promise<number> => {
    const { rows } = await harness.gatewayJson<{ rows: unknown[][] }>("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT COUNT(*) FROM apple_call_log" }),
    });
    return Number(rows[0]?.[0] ?? 0);
  };

  const sqliteState = (): { sharedDocuments: number; cursors: CursorRow[] } => {
    const db = new SqliteDatabase(harness.getDbPath(), { readonly: true });
    try {
      return {
        sharedDocuments: db
          .prepare<
            [string],
            { count: number }
          >("SELECT COUNT(*) AS count FROM documents WHERE source_id = ? AND stream_id = ''")
          .get(SOURCE_ID)!.count,
        cursors: db
          .prepare<[string], CursorRow>(
            `SELECT device_id, cursor, last_synced_at
               FROM sync_state
              WHERE source_id = ?
              ORDER BY device_id`,
          )
          .all(SOURCE_ID),
      };
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "replicated" });
    await harness.start();
    [owner, member] = harness.devicesForSource(SOURCE_ID) as [HarnessDevice, HarnessDevice];

    // Boot from the staged database exactly as an upgraded installation
    // would. The gateway is fully stopped while the fixture is rewritten, so
    // no second writer can race the legacy-state setup.
    await harness.restartGateway(() => {
      const db = new SqliteDatabase(harness.getDbPath());
      try {
        db.transaction(() => {
          db.prepare("UPDATE sources SET multi_device_mode = 'exclusive' WHERE id = ?").run(
            SOURCE_ID,
          );
          db.prepare("DELETE FROM source_devices WHERE source_id = ? AND device_id = ?").run(
            SOURCE_ID,
            member.deviceId,
          );
          db.prepare("DELETE FROM sync_state WHERE source_id = ? AND device_id = ?").run(
            SOURCE_ID,
            member.deviceId,
          );
          db.prepare("DELETE FROM source_wipe_epoch WHERE source_id = ? AND device_id = ?").run(
            SOURCE_ID,
            member.deviceId,
          );
        }).immediate();
      } finally {
        db.close();
      }
    });
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("adopts shared documents, analytics and cursor before restart, replica join and detach", async () => {
    expect(await sourceRow()).toMatchObject({
      deviceId: owner.deviceId,
      members: [owner.deviceId],
      multiDeviceMode: "exclusive",
    });

    await harness.triggerSyncAndWait(SOURCE_ID, 60_000, owner);
    const legacyDocumentCount = await getDocumentCount(
      harness.gatewayUrl,
      harness.apiKey,
      SOURCE_ID,
    );
    const legacyAnalyticsCount = await analyticsRows();
    const legacyState = sqliteState();
    const legacySharedCursor = legacyState.cursors.find((row) => row.device_id === "");
    expect(legacyDocumentCount).toBeGreaterThan(0);
    expect(legacyAnalyticsCount).toBeGreaterThan(0);
    expect(legacyState.sharedDocuments).toBe(legacyDocumentCount);
    expect(legacySharedCursor?.last_synced_at).not.toBeNull();
    expect(legacySharedCursor?.cursor).not.toBe("{}");

    await harness.gatewayJson(`/admin/sources/${encodeURIComponent(SOURCE_ID)}`, {
      method: "PATCH",
      body: JSON.stringify({ multiDeviceMode: "replicated" }),
    });

    expect(await sourceRow()).toMatchObject({
      deviceId: owner.deviceId,
      members: [owner.deviceId],
      multiDeviceMode: "replicated",
    });
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(
      legacyDocumentCount,
    );
    expect(await analyticsRows()).toBe(legacyAnalyticsCount);
    const adoptedState = sqliteState();
    expect(adoptedState.sharedDocuments).toBe(legacyDocumentCount);
    expect(adoptedState.cursors).toEqual([
      expect.objectContaining({ device_id: "", cursor: "{}", last_synced_at: null }),
      expect.objectContaining({
        device_id: owner.deviceId,
        cursor: legacySharedCursor!.cursor,
        last_synced_at: legacySharedCursor!.last_synced_at,
      }),
    ]);

    await harness.restartGateway();
    expect(await sourceRow()).toMatchObject({
      members: [owner.deviceId],
      multiDeviceMode: "replicated",
    });
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(
      legacyDocumentCount,
    );
    expect(await analyticsRows()).toBe(legacyAnalyticsCount);

    const joined = await member.gateway.bulkUpsertSources([
      {
        type: SourceType(SOURCE_TYPE),
        accountId: AccountId(ACCOUNT_ID),
        enabled: true,
      },
    ]);
    expect(joined.errors).toEqual([]);
    expect((await sourceRow()).members).toEqual([owner.deviceId, member.deviceId]);

    await harness.triggerSyncAndWait(SOURCE_ID, 60_000, member);
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(
      legacyDocumentCount,
    );
    expect(await analyticsRows()).toBe(legacyAnalyticsCount);
    expect(sqliteState().cursors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ device_id: owner.deviceId }),
        expect.objectContaining({ device_id: member.deviceId, last_synced_at: expect.any(String) }),
      ]),
    );

    const detached = await harness.gatewayJson<{ members: string[] }>(
      `/admin/sources/${encodeURIComponent(SOURCE_ID)}/members/${member.deviceId}`,
      { method: "DELETE" },
    );
    expect(detached.members).toEqual([owner.deviceId]);
    expect(await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID)).toBe(
      legacyDocumentCount,
    );
    expect(await analyticsRows()).toBe(legacyAnalyticsCount);
  }, 240_000);
});

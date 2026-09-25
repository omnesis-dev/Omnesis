// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * Structured-source coverage. The four analytics-shaped synth sources
 * (apple-health, screen-time, browser-history, notion-databases) declare
 * DuckDB schemas and emit records via `syncStructured()`. After initial
 * sync the gateway should:
 *  - register the source
 *  - persist its cursor
 *  - have non-empty analytics tables in the analytics catalogue
 *
 * The test queries the gateway's analytics catalogue (`/admin/analytics/tables`)
 * rather than the DuckDB file directly so we exercise the wire path.
 */
describe("Synthetic providers — structured sources", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    // The canonical calendar HTTP surface is experimental and shares the
    // Brain gate. The replay backend provisions the universe fixtures, and
    // assigning it to the background role opens the gate without a real model.
    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      agentBackend: "replay",
      extraInference: { assignments: { "background-agent": "replay" } },
    });
    await harness.start();
    const status = await harness.gatewayJson<{ briefs: { active: boolean } }>("/status");
    expect(status.briefs.active).toBe(true);
    const ids = harness.getSourceIds().filter((id) => {
      const t = id.split(":")[0];
      return (
        t === "gmail" ||
        t === "apple-health" ||
        t === "health-connect" ||
        t === "screen-time" ||
        t === "browser-history" ||
        t === "notion-databases" ||
        t === "google-calendar" ||
        t === "apple-calendar" ||
        t === "outlook-calendar" ||
        t === "core-location-visits" ||
        t === "apple-reminders" ||
        t === "things"
      );
    });
    await Promise.all(ids.map((id) => harness.triggerSyncAndWait(id, 60000)));
  }, 180000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  async function listAnalyticsTables(): Promise<Array<{ tableName: string; rowCount: number }>> {
    const data = (await harness.gatewayJson("/analytics/catalog")) as {
      tables: Array<{ tableName: string; recordCount: number }>;
    };
    return data.tables.map((t) => ({ tableName: t.tableName, rowCount: t.recordCount }));
  }

  test("apple-health publishes the 8 HealthKit tables with rows", async () => {
    const tables = await listAnalyticsTables();
    const expected = [
      "health_body",
      "health_activity",
      "health_vitals",
      "health_sleep",
      "health_nutrition",
      "health_mindful",
      "health_environment",
      "health_workouts",
    ];
    for (const name of expected) {
      const t = tables.find((x) => x.tableName === name);
      expect(t, `${name} should exist in the analytics catalogue`).toBeDefined();
      expect(t!.rowCount, `${name} should have at least 1 record`).toBeGreaterThan(0);
    }
  });

  async function currentWriteEpoch(sourceId: string): Promise<number> {
    const state = await harness.gatewayJson<{ wipeEpoch: number }>(
      `/sync-state/${encodeURIComponent(sourceId)}`,
    );
    return state.wipeEpoch;
  }

  async function sqlQuery(sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
    return (await harness.gatewayJson("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql }),
    })) as { columns: string[]; rows: unknown[][] };
  }

  test("health-connect publishes the 7 Health Connect tables with rows", async () => {
    const tables = await listAnalyticsTables();
    const expected = [
      "hc_body",
      "hc_activity",
      "hc_vitals",
      "hc_sleep",
      "hc_nutrition",
      "hc_mindfulness",
      "hc_exercise",
    ];
    for (const name of expected) {
      const t = tables.find((x) => x.tableName === name);
      expect(t, `${name} should exist in the analytics catalogue`).toBeDefined();
      expect(t!.rowCount, `${name} should have at least 1 record`).toBeGreaterThan(0);
    }
  });

  test("re-ingesting an identical health-connect page is idempotent (PK upsert)", async () => {
    // Read one full row back, then re-send it through /analytics/ingest exactly
    // as a device retrying an already-uploaded page would. The deterministic-id
    // + primary-key-upsert contract means the row count must not change.
    const before = await sqlQuery("SELECT COUNT(*) FROM hc_vitals");
    const count0 = Number(before.rows[0]![0]);
    expect(count0).toBeGreaterThan(0);

    const sel = await sqlQuery("SELECT * FROM hc_vitals LIMIT 1");
    const record = Object.fromEntries(sel.columns.map((c, i) => [c, sel.rows[0]![i]]));

    const res = (await harness.gatewayJson("/analytics/ingest", {
      method: "POST",
      body: JSON.stringify({
        tableName: "hc_vitals",
        records: [record],
        sourceId: "health-connect:android-synth-johnsmith",
        writeEpoch: await currentWriteEpoch("health-connect:android-synth-johnsmith"),
      }),
    })) as { ingested: number };
    expect(res.ingested).toBe(1);

    const after = await sqlQuery("SELECT COUNT(*) FROM hc_vitals");
    expect(Number(after.rows[0]![0]), "re-sent page must not duplicate rows").toBe(count0);
  });

  test("health-connect deletions propagate (deletedIds removes the row)", async () => {
    // A Health Connect DeletionChange reaches the gateway as `deletedIds` on the
    // ingest page. Pick a real row, tombstone it, and verify it is gone.
    const sel = await sqlQuery("SELECT id FROM hc_body LIMIT 1");
    const id = String(sel.rows[0]![0]);
    const before = await sqlQuery("SELECT COUNT(*) FROM hc_body");
    const count0 = Number(before.rows[0]![0]);

    const res = (await harness.gatewayJson("/analytics/ingest", {
      method: "POST",
      body: JSON.stringify({
        tableName: "hc_body",
        records: [],
        deletedIds: [id],
        sourceId: "health-connect:android-synth-johnsmith",
        writeEpoch: await currentWriteEpoch("health-connect:android-synth-johnsmith"),
      }),
    })) as { ingested: number; deleted: number };
    expect(res.deleted).toBe(1);

    const gone = await sqlQuery(`SELECT COUNT(*) FROM hc_body WHERE id = '${id}'`);
    expect(Number(gone.rows[0]![0]), "tombstoned row must be deleted").toBe(0);
    const after = await sqlQuery("SELECT COUNT(*) FROM hc_body");
    expect(Number(after.rows[0]![0])).toBe(count0 - 1);
  });

  test("deleteKeyColumn removes every row fanned out from one upstream record", async () => {
    // One Health Connect record can fan out into several rows (heart-rate samples,
    // blood-pressure components) that share its `record_id` — a DeletionChange
    // carries only that parent id, so deletion is keyed on the record_id column.
    const sel = await sqlQuery("SELECT record_id FROM hc_vitals LIMIT 1");
    const recordId = String(sel.rows[0]![0]);

    const res = (await harness.gatewayJson("/analytics/ingest", {
      method: "POST",
      body: JSON.stringify({
        tableName: "hc_vitals",
        records: [],
        deletedIds: [recordId],
        deleteKeyColumn: "record_id",
        sourceId: "health-connect:android-synth-johnsmith",
        writeEpoch: await currentWriteEpoch("health-connect:android-synth-johnsmith"),
      }),
    })) as { deleted: number };
    expect(res.deleted).toBe(1);

    const gone = await sqlQuery(`SELECT COUNT(*) FROM hc_vitals WHERE record_id = '${recordId}'`);
    expect(Number(gone.rows[0]![0]), "all rows of the deleted record must be gone").toBe(0);
  });

  test("screen-time publishes sessions + daily aggregates", async () => {
    const tables = await listAnalyticsTables();
    const sessions = tables.find((t) => t.tableName === "screen_time_sessions");
    const daily = tables.find((t) => t.tableName === "screen_time_daily");
    expect(sessions, "screen_time_sessions must exist").toBeDefined();
    expect(daily, "screen_time_daily must exist").toBeDefined();
    expect(sessions!.rowCount).toBeGreaterThan(0);
    expect(daily!.rowCount).toBeGreaterThan(0);
    // Daily is at most one row per (bundle, day) — should be fewer rows than sessions.
    expect(daily!.rowCount).toBeLessThanOrEqual(sessions!.rowCount);
  });

  test("browser-history publishes visits + daily + search-term tables", async () => {
    const tables = await listAnalyticsTables();
    for (const name of ["browser_visits", "browser_daily", "browser_search_terms"]) {
      const t = tables.find((x) => x.tableName === name);
      expect(t, `${name} must exist`).toBeDefined();
      expect(t!.rowCount, `${name} should have ≥ 1 row`).toBeGreaterThan(0);
    }
  });

  async function scopedSql(
    sql: string,
    sourceId: string,
  ): Promise<{ status: number; body: unknown }> {
    const res = await harness.gatewayFetch("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql, sourceId }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  test("a source's query reaches its own tables and no others", async () => {
    // The handle a source holds is documented as scoped to the tables it
    // declares. The gateway derives that set from the catalog rows the
    // source's own schemas created, so the check runs against real ownership
    // rather than a list the caller supplied.
    const browser = harness.getSourceIds().find((id) => id.startsWith("browser-history:"))!;

    const own = await scopedSql("SELECT count(*) AS n FROM browser_visits", browser);
    expect(own.status).toBe(200);

    // A table another source owns, named by a source that does not.
    const other = await scopedSql("SELECT count(*) AS n FROM health_body", browser);
    expect(other.status).toBe(400);
    expect(JSON.stringify(other.body)).toContain("health_body");

    // And it cannot be reached by burying it either.
    const buried = await scopedSql(
      "SELECT * FROM browser_visits WHERE 1 = (SELECT count(*) FROM health_body)",
      browser,
    );
    expect(buried.status).toBe(400);
  });

  test("the operator's own SQL still reaches every table", async () => {
    // The narrowing applies to a query asked on a source's behalf, not to the
    // SQL surfaces the operator drives; those would be useless scoped.
    const across = await sqlQuery(
      "SELECT (SELECT count(*) FROM browser_visits) AS a, (SELECT count(*) FROM health_body) AS b",
    );
    expect(across.rows[0]).toHaveLength(2);
  });

  test("the three browser tables are one page, so one cursor covers all of them", async () => {
    // Visits, their daily rollups and the searches behind them come from one
    // read of the corpus, and the source writes all three on a single page.
    // What proves it end to end is the cursor: it goes straight from unsynced
    // to the page that follows the rows, never resting between the tables. A
    // phase per table would have left an intermediate value here, and a crash
    // at that point would have stranded the tables it had not reached.
    const sourceId = harness.getSourceIds().find((id) => id.startsWith("browser-history:"))!;
    const state = await harness.gatewayJson<{ cursor: { phase?: string } | null }>(
      `/sync-state/${encodeURIComponent(sourceId)}`,
    );
    expect(state.cursor?.phase).toBe("done");

    // And every table carries the source's own rows, not a subset that a
    // partially-applied page would leave.
    const counts = await sqlQuery(
      "SELECT (SELECT count(*) FROM browser_visits) AS visits," +
        " (SELECT count(*) FROM browser_daily) AS daily," +
        " (SELECT count(*) FROM browser_search_terms) AS searches",
    );
    for (const [index, column] of counts.columns.entries()) {
      expect(Number(counts.rows[0]![index]), `${column} should be populated`).toBeGreaterThan(0);
    }
  });

  test("calendar and location-visit twins publish projection-eligible hybrid rows", async () => {
    const expectedTables = [
      "google_calendar_events",
      "apple_calendar_events",
      "outlook_calendar_events",
      "location_visits",
    ];
    const tables = await listAnalyticsTables();
    for (const name of expectedTables) {
      const table = tables.find((entry) => entry.tableName === name);
      expect(table, `${name} should exist in the analytics catalogue`).toBeDefined();
      expect(table!.rowCount, `${name} should have fixture rows`).toBeGreaterThan(0);
    }

    for (const name of expectedTables.slice(0, 3)) {
      const rows = await sqlQuery(
        `SELECT id, temporal_projection_eligible FROM ${name} ORDER BY id`,
      );
      expect(rows.rows.length, `${name} should have calendar occurrences`).toBeGreaterThan(0);
      expect(
        rows.rows.every((row) => row[1] === true),
        `${name} fixtures should contain concrete, projection-eligible occurrences`,
      ).toBe(true);
    }

    const visits = await sqlQuery(
      "SELECT id, place_name, arrival_time, departure_time FROM location_visits ORDER BY arrival_time",
    );
    expect(visits.rows.length).toBeGreaterThan(0);
    expect(visits.rows.every((row) => String(row[1]).length > 0)).toBe(true);
    expect(
      visits.rows.every((row) => Date.parse(String(row[3])) > Date.parse(String(row[2]))),
    ).toBe(true);

    const projections = await sqlQuery(
      "SELECT source_id, table_name, slot, kind, modality, status, bound_document_external_id FROM _temporal_projections ORDER BY source_id, start_ms",
    );
    const expectedBySource = new Map([
      ["google-calendar:john.smith@example.com", ["google_calendar_events", "calendar"]],
      ["apple-calendar:john.smith@icloud.example", ["apple_calendar_events", "calendar"]],
      ["outlook-calendar:john.smith@example.com", ["outlook_calendar_events", "calendar"]],
      ["core-location-visits:ios-synth-johnsmith", ["location_visits", "visit"]],
    ]);
    expect(new Set(projections.rows.map((row) => row[0]))).toEqual(
      new Set(expectedBySource.keys()),
    );
    for (const [sourceId, [tableName, slot]] of expectedBySource) {
      const sourceRows = projections.rows.filter((row) => row[0] === sourceId);
      expect(sourceRows.length, `${sourceId} should materialize projections`).toBeGreaterThan(0);
      expect(
        sourceRows.every(
          (row) =>
            row[1] === tableName &&
            row[2] === slot &&
            typeof row[6] === "string" &&
            String(row[6]).length > 0,
        ),
      ).toBe(true);
    }
    const visitProjections = projections.rows.filter(
      (row) => row[0] === "core-location-visits:ios-synth-johnsmith",
    );
    expect(visitProjections.every((row) => row[3] === "visit")).toBe(true);
    expect(visitProjections.every((row) => row[4] === "observed")).toBe(true);
    expect(visitProjections.every((row) => row[5] === "completed")).toBe(true);
  });

  test("the unified temporal API returns document and analytics projections with coverage", async () => {
    const result = await harness.gatewayJson<{
      window: { start: string; endExclusive: string; timeZone: string };
      items: Array<{
        id: string;
        origin: string;
        kind: string | null;
        status: string;
        allDay: boolean;
        projection?: {
          sourceId: string;
          documentId?: string;
          documentExternalId?: string;
          tableName?: string;
          slot: string;
          revision: string;
        };
      }>;
      coverage: {
        projectionSources: Array<{ sourceId: string; slots: string[] }>;
        specialistSources: Array<{ sourceId: string }>;
        annotations: { selective: boolean };
      };
      truncated: boolean;
    }>(
      "/briefs/temporal/window?from=1756684800000&to=1758153600000&timeZone=Europe%2FLondon&origins=projection&limit=100",
    );

    expect(result.window).toEqual({
      start: "2025-09-01T00:00:00.000Z",
      endExclusive: "2025-09-18T00:00:00.000Z",
      timeZone: "Europe/London",
    });
    expect(result.truncated).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((item) => item.origin === "projection")).toBe(true);
    expect(result.items.every((item) => item.id.startsWith("tp_"))).toBe(true);
    expect(
      result.items.every(
        (item) =>
          typeof item.projection?.revision === "string" && item.projection.revision.length > 0,
      ),
    ).toBe(true);

    const projectedSources = new Set(
      result.coverage.projectionSources.map((source) => source.sourceId),
    );
    expect(projectedSources).toEqual(
      new Set([
        "gmail:john.smith@example.com",
        "google-calendar:john.smith@example.com",
        "apple-calendar:john.smith@icloud.example",
        "outlook-calendar:john.smith@example.com",
        "core-location-visits:ios-synth-johnsmith",
        "apple-reminders:john.smith@icloud.example",
        "things:local",
      ]),
    );
    expect(
      result.coverage.projectionSources.find(
        (source) => source.sourceId === "apple-reminders:john.smith@icloud.example",
      )?.slots,
    ).toEqual(["due"]);
    expect(
      result.coverage.projectionSources
        .find((source) => source.sourceId === "things:local")
        ?.slots.toSorted(),
    ).toEqual(["due", "scheduled"]);
    expect(
      result.items.some(
        (item) =>
          item.projection?.sourceId === "apple-reminders:john.smith@icloud.example" &&
          item.kind === "deadline" &&
          item.status === "completed",
      ),
    ).toBe(true);
    const bothDateTask = result.items.filter(
      (item) =>
        item.projection?.sourceId === "things:local" &&
        item.projection.documentExternalId === "synth-things-001",
    );
    expect(
      bothDateTask.map((item) => ({
        slot: item.projection?.slot,
        kind: item.kind,
        allDay: item.allDay,
      })),
    ).toEqual([
      { slot: "scheduled", kind: "event", allDay: true },
      { slot: "due", kind: "deadline", allDay: true },
    ]);
    expect(
      result.items.some(
        (item) =>
          item.projection?.sourceId === "things:local" &&
          item.kind === "deadline" &&
          item.status === "completed",
      ),
    ).toBe(true);
    expect(
      result.items.some(
        (item) =>
          item.projection?.sourceId === "gmail:john.smith@example.com" &&
          typeof item.projection.documentId === "string",
      ),
    ).toBe(true);
    expect(
      result.items.some(
        (item) =>
          item.projection?.sourceId === "core-location-visits:ios-synth-johnsmith" &&
          item.projection.tableName === "location_visits" &&
          item.kind === "visit",
      ),
    ).toBe(true);

    // High-volume/timeless sources remain discoverable through their
    // specialist tables, but they never become projection rows.
    const specialistSources = new Set(
      result.coverage.specialistSources.map((source) => source.sourceId),
    );
    expect(specialistSources.has("apple-health:ios-synth-johnsmith")).toBe(true);
    expect(specialistSources.has("browser-history:chrome")).toBe(true);
    expect(specialistSources.has("apple-reminders:john.smith@icloud.example")).toBe(false);
    expect(specialistSources.has("things:local")).toBe(false);
    expect(
      result.items.some(
        (item) =>
          item.projection?.sourceId.startsWith("apple-health:") ||
          item.projection?.sourceId.startsWith("browser-history:"),
      ),
    ).toBe(false);
    expect(result.coverage.annotations.selective).toBe(true);
  });

  test("notion-databases publishes one DuckDB table per database with linked Documents", async () => {
    const tables = await listAnalyticsTables();
    // 4 fixture databases → 4 `notion_<dbId>` tables.
    const notionTables = tables.filter((t) => t.tableName.startsWith("notion_"));
    expect(notionTables.length, "expected ≥ 4 notion_* tables").toBeGreaterThanOrEqual(4);
    for (const t of notionTables) {
      expect(t.rowCount, `${t.tableName} must have rows`).toBeGreaterThan(0);
    }

    // The source also emits Documents: one summary per database + one per row.
    // Use /documents/search (which supports the `sources` filter) to confirm
    // both shapes land in the doc store.
    const sid = "notion-databases:user_john_smith";
    const dbDocs = (await harness.gatewayJson(
      `/documents/search?q=Db&sources=${encodeURIComponent(sid)}&limit=200`,
    )) as { results?: Array<{ title: string }> };
    expect(
      (dbDocs.results ?? []).some((d) => d.title.startsWith("[Db]")),
      "expected at least one `[Db] …` summary document",
    ).toBe(true);

    // Row-level doc titles look like "<Database name> > <Row title>".
    const rowDocs = (await harness.gatewayJson(
      `/documents/search?q=Globex&sources=${encodeURIComponent(sid)}&limit=50`,
    )) as { results?: Array<{ title: string }> };
    expect(
      (rowDocs.results ?? []).some((d) => d.title.includes(" > ")),
      "expected a row-level document referencing its parent database",
    ).toBe(true);
  });
});

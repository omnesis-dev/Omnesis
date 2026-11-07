// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Two linked Google accounts that both see one shared calendar list the same
 * event under the same `calendarId:eventId`. Each account's google-calendar
 * source writes its own row for it into the one provider-owned
 * `google_calendar_events` table, so the account is part of that table's key.
 *
 *   1. under the key the table used to have (`id` alone), the second account's
 *      row is refused as another account's — the failure that parked the
 *      second source in `error`;
 *   2. the current schema rebuilds that table with the account in its key and
 *      keeps every row it held; both accounts then ingest the shared event,
 *      each with its own RSVP;
 *   3. one account's tombstone for the shared id removes that account's row
 *      alone;
 *   4. a collector rolled back to the old declaration keeps ingesting: the
 *      table keeps its wider key, and the old page's rows land under it.
 *
 * Pages go over the real `/analytics/ingest` route as a paired collector
 * sends them, against a real gateway subprocess.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { googleCalendarEventsSchema } from "@omnesis/provider-google/src/calendar-schema.js";
import { MultiCollectorHarness, type PairedCollector } from "./multi-collector-harness.js";

const TYPE = "google-calendar";
const TABLE = googleCalendarEventsSchema.tableName;
const ACCOUNT_A = "jamie.lopez@example.com";
const ACCOUNT_B = "jamie.lopez@example.org";
const SHARED_ID = "team-calendar@group.example.com:evt0001";

/** The table's declaration before the account joined its key. */
const legacySchema = {
  ...googleCalendarEventsSchema,
  primaryKey: ["id"],
  deleteKey: undefined,
  boundDocument: { externalIdColumns: ["id"] },
};

const row = (account: string, id: string, responseStatus: string) => ({
  id,
  source_account: account,
  calendar_id: id.split(":")[0],
  calendar_name: "Team calendar",
  event_id: id.split(":")[1],
  ical_uid: `${id.split(":")[1]}@example.com`,
  title: "Quarterly roadmap review",
  start_time: "2026-09-14T15:00:00.000Z",
  end_time: "2026-09-14T16:00:00.000Z",
  duration_minutes: 60,
  all_day: false,
  recurring: false,
  temporal_projection_eligible: true,
  organizer_email: "sarah.mendez@example.com",
  attendee_count: 4,
  response_status: responseStatus,
  location: "Room 4B",
  status: "confirmed",
});

describe("google calendar: two accounts sharing an event id", () => {
  let harness: MultiCollectorHarness;
  let collector: PairedCollector;

  const ingest = (account: string, body: Record<string, unknown>) =>
    fetch(`${collector.gatewayBase}/analytics/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${collector.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tableName: TABLE, sourceId: `${TYPE}:${account}`, ...body }),
    });
  const ingestOk = async (account: string, body: Record<string, unknown>) => {
    const res = await ingest(account, body);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { ingested: number; deleted: number };
  };
  const sql = async (query: string) =>
    (
      await harness.json<{ rows: unknown[][] }>("/analytics/sql", {
        method: "POST",
        body: JSON.stringify({ sql: query }),
      })
    ).rows;
  const held = () =>
    sql(`SELECT source_account, id, response_status FROM ${TABLE} ORDER BY source_account, id`);

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    collector = await harness.addCollector({ name: "mac-one", hostableSourceTypes: [TYPE] });
    const res = await fetch(`${collector.gatewayBase}/devices/sources/bulk-upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${collector.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [
          { type: TYPE, accountId: ACCOUNT_A, enabled: true },
          { type: TYPE, accountId: ACCOUNT_B, enabled: true },
        ],
      }),
    });
    expect(res.status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await harness?.destroy();
  }, 15_000);

  test("1. keyed by id alone, the second account's copy of the shared event is refused", async () => {
    await ingestOk(ACCOUNT_A, {
      schema: legacySchema,
      records: [
        row(ACCOUNT_A, SHARED_ID, "accepted"),
        row(ACCOUNT_A, "jamie.lopez@example.com:evt0002", "accepted"),
      ],
    });
    const refused = await ingest(ACCOUNT_B, {
      schema: legacySchema,
      records: [row(ACCOUNT_B, SHARED_ID, "needsAction")],
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toMatch(/primary key belongs to a different source account/);
  }, 30_000);

  test("2. the current schema re-keys the table and both accounts ingest the shared event", async () => {
    await ingestOk(ACCOUNT_B, {
      schema: googleCalendarEventsSchema,
      records: [row(ACCOUNT_B, SHARED_ID, "needsAction")],
    });
    await ingestOk(ACCOUNT_A, {
      schema: googleCalendarEventsSchema,
      records: [row(ACCOUNT_A, SHARED_ID, "tentative")],
    });
    expect(await held()).toEqual([
      [ACCOUNT_A, "jamie.lopez@example.com:evt0002", "accepted"],
      [ACCOUNT_A, SHARED_ID, "tentative"],
      [ACCOUNT_B, SHARED_ID, "needsAction"],
    ]);
    const projections = await sql(
      `SELECT source_id, count(*) FROM _temporal_projections WHERE table_name = '${TABLE}' GROUP BY 1 ORDER BY 1`,
    );
    expect(projections.map(([source, count]) => [source, Number(count)])).toEqual([
      [`${TYPE}:${ACCOUNT_A}`, 2],
      [`${TYPE}:${ACCOUNT_B}`, 1],
    ]);
  }, 30_000);

  test("3. one account's tombstone for the shared id removes only its own row", async () => {
    const result = await ingestOk(ACCOUNT_B, { records: [], deletedIds: [SHARED_ID] });
    expect(result.deleted).toBe(1);
    expect(await held()).toEqual([
      [ACCOUNT_A, "jamie.lopez@example.com:evt0002", "accepted"],
      [ACCOUNT_A, SHARED_ID, "tentative"],
    ]);
  }, 30_000);

  test("4. a collector still sending the id-keyed declaration keeps ingesting under the wider key", async () => {
    await ingestOk(ACCOUNT_B, {
      schema: legacySchema,
      records: [row(ACCOUNT_B, SHARED_ID, "declined")],
    });
    expect(await held()).toEqual([
      [ACCOUNT_A, "jamie.lopez@example.com:evt0002", "accepted"],
      [ACCOUNT_A, SHARED_ID, "tentative"],
      [ACCOUNT_B, SHARED_ID, "declined"],
    ]);
    const key = await sql(
      `SELECT constraint_column_names FROM duckdb_constraints() WHERE table_name = '${TABLE}' AND constraint_type = 'PRIMARY KEY'`,
    );
    expect(JSON.stringify(key[0]?.[0])).toContain("source_account");
  }, 30_000);
});

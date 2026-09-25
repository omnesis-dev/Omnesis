// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The shared temporal substrate, end-to-end on a real spawned gateway.
 *
 * Every assertion here rides the production path — `POST /analytics/ingest`
 * through `AnalyticsService` → `ensureTable` → the projection derivation →
 * DuckDB, then out through `GET /briefs/temporal/window`'s federation of the
 * analytics store, the document store and the annotation store.
 *
 * What this file exists to pin:
 *  - a mapped `kind` resolves per row, so one spec can describe two natures;
 *  - the vocabulary is shared by both producers — a kind asserted by a source
 *    projection and the same kind asserted by an annotation come back from one
 *    filter, so filtering by kind never silently filters by origin;
 *  - a retired spelling sent by a client resolves to its canonical kind;
 *  - a fact with no duration is stored as an empty interval and still overlaps
 *    a window that starts on its instant;
 *  - a schema whose anchor cannot yield a stable instant is downgraded to
 *    timeless rather than failing the ingest.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { startScriptedLoopModelServer, type ScriptedLoopModelServer } from "./fake-loop-model.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface TemporalItemDto {
  id: string;
  origin: "projection" | "annotation";
  start: string;
  endExclusive: string;
  precision: string;
  allDay: boolean;
  label: string;
  kind: string;
  projection?: { sourceId: string; slot: string };
}

interface WindowDto {
  items: TemporalItemDto[];
  truncated: boolean;
}

/**
 * A calendar-shaped table. The `kind` is mapped off the row's own all-day
 * flag — an all-day entry is an observance, a timed one a booking — which is
 * the shape the shipped calendar providers use.
 */
const CALENDAR_SCHEMA: AnalyticsTableSchema = {
  tableName: "e2e_calendar_events",
  displayName: "E2E Calendar Events",
  description: "Calendar entries used to exercise the temporal substrate",
  columns: [
    { name: "id", type: "VARCHAR", description: "Event id" },
    { name: "title", type: "VARCHAR", description: "Event title" },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Start (UTC)" },
    { name: "end_time", type: "TIMESTAMPTZ", description: "End (UTC)", nullable: true },
    { name: "all_day", type: "BOOLEAN", description: "Whether the entry spans whole days" },
    { name: "status", type: "VARCHAR", description: "Provider lifecycle", nullable: true },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "start_time",
  record: { titleColumns: ["title"], keyColumns: ["title", "start_time"] },
  temporalProjection: {
    slot: "calendar",
    start: "$semanticTime",
    end: "end_time",
    label: "title",
    kind: { from: "all_day", map: { true: "event" }, default: "appointment" },
    modality: "scheduled",
    status: { from: "status", map: { cancelled: "cancelled" }, default: "active" },
    allDay: "all_day",
  },
};

/** An episode a source observes — the kind an annotation can also assert. */
const EPISODE_SCHEMA: AnalyticsTableSchema = {
  tableName: "e2e_focus_episodes",
  displayName: "E2E Focus Episodes",
  description: "Observed episodes used to exercise cross-producer kind filtering",
  columns: [
    { name: "id", type: "VARCHAR", description: "Episode id" },
    { name: "label", type: "VARCHAR", description: "What was observed" },
    { name: "began_at", type: "TIMESTAMPTZ", description: "Episode start (UTC)" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "began_at",
  record: { titleColumns: ["label"], keyColumns: ["label", "began_at"] },
  // No `end`: the fact is a point in time, and is stored as an empty interval.
  temporalProjection: {
    slot: "episode",
    start: "$semanticTime",
    label: "label",
    kind: "episode",
    modality: "observed",
  },
};

describe("shared temporal substrate (real gateway)", () => {
  let harness: SyntheticE2EHarness;
  let server: ScriptedLoopModelServer;
  const now = Date.UTC(2026, 6, 20, 12, 0, 0);
  const annotationId = `ta_sub_${randomUUID().slice(0, 8)}`;

  const timedStart = now + 3 * DAY_MS;
  const allDayStart = "2026-07-25";
  const episodeStart = now + 5 * DAY_MS;

  beforeAll(async () => {
    server = await startScriptedLoopModelServer({ behaviors: new Map() });
    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      universe: "e2e-minimal",
      embedderBackend: "fake",
      // The unified temporal window sits behind the Brain gate; assigning a
      // background agent is what opens it. No model is ever sent a message here.
      extraInference: {
        backends: { scripted: { type: "http", url: server.url } },
        assignments: { "background-agent": `scripted/${server.modelId}` },
      },
    });
    await harness.start();

    const sourceId = "synthetic:calendar@example.com";

    // One timed entry and one all-day entry through the SAME spec — the only
    // difference is the row's own all_day value.
    await harness.pushAnalyticsRow(
      CALENDAR_SCHEMA.tableName,
      {
        id: "evt_timed",
        title: "Quarterly planning with Maya Reeves",
        start_time: new Date(timedStart).toISOString(),
        end_time: new Date(timedStart + HOUR_MS).toISOString(),
        all_day: false,
        status: "confirmed",
      },
      { schema: CALENDAR_SCHEMA, sourceId },
    );
    await harness.pushAnalyticsRow(
      CALENDAR_SCHEMA.tableName,
      {
        id: "evt_allday",
        title: "Studio closed",
        start_time: `${allDayStart}T00:00:00.000Z`,
        end_time: "2026-07-27T00:00:00.000Z",
        all_day: true,
        status: "confirmed",
      },
      { schema: CALENDAR_SCHEMA, sourceId },
    );
    await harness.pushAnalyticsRow(
      EPISODE_SCHEMA.tableName,
      {
        id: "epi_focus",
        label: "Deep work block",
        began_at: new Date(episodeStart).toISOString(),
      },
      { schema: EPISODE_SCHEMA, sourceId: "synthetic:episodes@example.com" },
    );

    // An annotation asserting the same kind a source projection can assert.
    // Before the vocabulary was shared, `episode` was projection-only and the
    // annotation producer had to spell it differently.
    const db = new Database(harness.getDbPath());
    db.pragma("busy_timeout = 10000");
    try {
      db.prepare(
        `INSERT INTO temporal_annotations
           (id, interval_start_ms, interval_end_ms, precision, canonical, sentence, kind,
            created_by_run, created_at, updated_at, invalidated_at)
         VALUES (?, ?, ?, 'day', ?, ?, 'episode', 'run_e2e_substrate', ?, ?, NULL)`,
      ).run(
        annotationId,
        episodeStart,
        episodeStart + DAY_MS - 1,
        new Date(episodeStart).toISOString().slice(0, 10),
        "A long stretch of uninterrupted work.",
        now,
        now,
      );
    } finally {
      db.close();
    }
  }, 240_000);

  afterAll(async () => {
    await harness?.destroy();
    await server?.close();
  }, 30_000);

  const windowUrl = (extra = "", timeZone = "UTC"): string =>
    `/briefs/temporal/window?from=${now - DAY_MS}&to=${now + 20 * DAY_MS}` +
    `&timeZone=${encodeURIComponent(timeZone)}${extra}`;

  test("one spec maps a kind per row from the row's own values", async () => {
    const body = await harness.gatewayJson<WindowDto>(windowUrl());
    const byLabel = new Map(body.items.map((item) => [item.label, item]));

    const timed = byLabel.get("Quarterly planning with Maya Reeves");
    const allDay = byLabel.get("Studio closed");
    expect(timed, "timed calendar row should project").toBeDefined();
    expect(allDay, "all-day calendar row should project").toBeDefined();

    // The nature of the fact, not where it came from.
    expect(timed!.kind).toBe("appointment");
    expect(timed!.allDay).toBe(false);
    expect(timed!.precision).toBe("instant");

    expect(allDay!.kind).toBe("event");
    expect(allDay!.allDay).toBe(true);
    expect(allDay!.precision).toBe("day");
  });

  test("a kind filter spans both producers", async () => {
    const body = await harness.gatewayJson<WindowDto>(windowUrl("&kinds=episode"));
    const origins = body.items.map((item) => item.origin).sort();

    // The projection AND the annotation both answer to `episode`. A vocabulary
    // partitioned by producer would return only one of them.
    expect(origins).toEqual(["annotation", "projection"]);
    expect(body.items.every((item) => item.kind === "episode")).toBe(true);
    expect(body.items.map((item) => item.label).sort()).toEqual([
      "A long stretch of uninterrupted work.",
      "Deep work block",
    ]);
  });

  test("a retired kind spelling resolves to its canonical kind", async () => {
    const retired = await harness.gatewayJson<WindowDto>(windowUrl("&kinds=calendar_event"));
    const canonical = await harness.gatewayJson<WindowDto>(windowUrl("&kinds=appointment"));

    expect(retired.items.map((item) => item.id)).toEqual(canonical.items.map((item) => item.id));
    expect(retired.items.map((item) => item.kind)).toEqual(["appointment"]);
  });

  test("a fact with no duration is an empty interval and still lands in a window", async () => {
    const body = await harness.gatewayJson<WindowDto>(
      windowUrl("&kinds=episode&origins=projection"),
    );
    const episode = body.items.find((item) => item.label === "Deep work block");
    expect(episode).toBeDefined();

    // Honest zero, not a one-millisecond stand-in.
    expect(episode!.endExclusive).toBe(episode!.start);
    expect(Date.parse(episode!.endExclusive) - Date.parse(episode!.start)).toBe(0);

    // A point overlaps a window that begins exactly on it — the case a plain
    // half-open test (`end > from`) drops.
    const edge = await harness.gatewayJson<WindowDto>(
      `/briefs/temporal/window?from=${episodeStart}&to=${episodeStart + HOUR_MS}` +
        `&timeZone=UTC&origins=projection&kinds=episode`,
    );
    expect(edge.items.map((item) => item.label)).toContain("Deep work block");
  });

  test("an all-day fact keeps its calendar day in a far-eastern zone", async () => {
    // +14 is the largest offset in use; a day stored on a UTC anchor must not
    // slide out of the window when the caller reads it from there.
    const body = await harness.gatewayJson<WindowDto>(
      windowUrl("&origins=projection", "Pacific/Kiritimati"),
    );
    const allDay = body.items.find((item) => item.label === "Studio closed");
    expect(allDay, "all-day row should survive a +14 read").toBeDefined();
    expect(allDay!.allDay).toBe(true);
    expect(allDay!.precision).toBe("day");
  });

  test("an anchor with no stable instant downgrades to timeless instead of failing ingest", async () => {
    const ambiguous: AnalyticsTableSchema = {
      tableName: "e2e_ambiguous_anchor",
      displayName: "E2E Ambiguous Anchor",
      description: "A device-shaped schema whose anchor carries no zone",
      columns: [
        { name: "id", type: "VARCHAR", description: "Row id" },
        { name: "title", type: "VARCHAR", description: "Row title" },
        { name: "recorded_at", type: "TIMESTAMP", description: "Wall clock, no zone" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: "recorded_at",
      record: { titleColumns: ["title"], keyColumns: ["title", "recorded_at"] },
    };

    // The ingest succeeds — a metadata detail an older client cannot express
    // must not cost it the whole page.
    await expect(
      harness.pushAnalyticsRow(
        ambiguous.tableName,
        { id: "amb_1", title: "Ambient reading", recorded_at: "2026-07-22T09:00:00" },
        { schema: ambiguous, sourceId: "synthetic:device@example.com" },
      ),
    ).resolves.toBeUndefined();

    // …and the row is queryable, it simply cannot be placed on a timeline.
    const queried = await harness.gatewayJson<{ columns: string[]; rows: unknown[][] }>(
      "/analytics/sql",
      { method: "POST", body: JSON.stringify({ sql: "SELECT id FROM e2e_ambiguous_anchor" }) },
    );
    expect(queried.rows.flat()).toEqual(["amb_1"]);

    const body = await harness.gatewayJson<WindowDto>(
      `/briefs/temporal/window?from=${Date.UTC(2026, 6, 21)}&to=${Date.UTC(2026, 6, 24)}` +
        `&timeZone=UTC&origins=projection`,
    );
    expect(body.items.map((item) => item.label)).not.toContain("Ambient reading");
  });
});

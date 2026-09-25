// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../db.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { replaceDocumentTemporalProjections } from "../../enrichment/temporal-projections/document-storage.js";
import { TemporalQueryService } from "../../enrichment/temporal/temporal-query-service.js";
import { resolveBrainSettings } from "../config.js";
import { buildCognitionRunPrompt } from "./prompts.js";
import {
  DIGEST_HORIZON_DAYS,
  DIGEST_HORIZON_MAX_ENTRIES,
  loadDigestHorizon,
  renderDigestHorizonLines,
  type DigestHorizon,
} from "./digest-horizon.js";
import type { ProviderId, SourceId, DocumentInput } from "@omnesis/types";
import type Database from "better-sqlite3";
import type {
  TemporalItem,
  TemporalKind,
  TemporalQueryInput,
  TemporalQueryResult,
} from "@omnesis/core";

const NOW = Date.parse("2026-07-02T06:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function item(o: {
  id: string;
  startMs: number;
  endMs?: number;
  label?: string;
  kind?: TemporalKind;
  origin?: "projection" | "annotation";
  allDay?: boolean;
  precision?: TemporalItem["precision"];
  documentId?: string;
}): TemporalItem {
  const origin = o.origin ?? "projection";
  const base: TemporalItem = {
    id: o.id,
    origin,
    start: new Date(o.startMs).toISOString(),
    endExclusive: new Date(o.endMs ?? o.startMs + HOUR).toISOString(),
    precision: o.precision ?? "instant",
    allDay: o.allDay ?? false,
    label: o.label ?? o.id,
    kind: o.kind ?? "appointment",
    modality: origin === "projection" ? "scheduled" : "inferred",
    status: "active",
  };
  return origin === "projection"
    ? {
        ...base,
        projection: {
          sourceId: "calendar:test",
          slot: "calendar",
          projectedAt: new Date(o.startMs).toISOString(),
          revision: "r1",
          ...(o.documentId ? { documentId: o.documentId } : {}),
        },
      }
    : {
        ...base,
        annotation: {
          documentIds: o.documentId ? [o.documentId] : [],
          personIds: [],
          loopIds: [],
          projectionIds: [],
          createdByRun: "run_seed",
          revision: 1,
          createdAt: new Date(o.startMs).toISOString(),
          updatedAt: new Date(o.startMs).toISOString(),
        },
      };
}

/** A render-ready horizon around a fixed item list. */
function horizonOf(items: TemporalItem[], timeZone = "UTC"): DigestHorizon {
  return { items, timeZone, truncated: false };
}

/** The window bounds the stub reports back, so the loader can rank against them. */
function stubWindow(input: TemporalQueryInput): { start: string; endExclusive: string } {
  return {
    start: new Date(NOW).toISOString(),
    endExclusive: new Date(NOW + DIGEST_HORIZON_DAYS * DAY).toISOString(),
    ...(typeof input.from === "string" && input.from.startsWith("2") ? { start: input.from } : {}),
  };
}

/**
 * Replays one page per entry in `pages`, cursor-wired exactly as the service
 * does: every page but the last reports `truncated` with a `nextCursor`.
 * Records every input so a test can assert what the loader actually asked for.
 */
function stubPagedQuery(pages: TemporalItem[][]): {
  query: (input: TemporalQueryInput) => Promise<TemporalQueryResult>;
  calls: TemporalQueryInput[];
} {
  const calls: TemporalQueryInput[] = [];
  return {
    calls,
    query: (input) => {
      const index = input.cursor === undefined ? 0 : Number(input.cursor);
      calls.push(input);
      const items = pages[index] ?? [];
      const hasMore = index + 1 < pages.length;
      return Promise.resolve({
        type: "temporal.results",
        window: { ...stubWindow(input), timeZone: input.timeZone },
        items,
        summary: { anchored: items.length, spanning: 0 },
        coverage: {
          projectionSources: [],
          specialistSources: [],
          annotations: { selective: true },
        },
        truncated: hasMore,
        ...(hasMore ? { nextCursor: String(index + 1) } : {}),
      } satisfies TemporalQueryResult);
    },
  };
}

/** Replays `items` as a single, complete page. */
function stubQuery(items: TemporalItem[]): ReturnType<typeof stubPagedQuery> {
  return stubPagedQuery([items]);
}

describe("digest horizon query", () => {
  test("reads BOTH origins — an annotations-only horizon cannot see a calendar event", async () => {
    const stub = stubQuery([]);
    await loadDigestHorizon(stub, NOW, "Europe/London");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.origins).toEqual(["projection", "annotation"]);
    expect(stub.calls[0]!.timeZone).toBe("Europe/London");
  });

  // The service silently clamps any larger limit to its own ceiling, so asking
  // for more would read as an over-fetch while buying nothing.
  test("asks for no more per page than the service will return", async () => {
    const stub = stubQuery([]);
    await loadDigestHorizon(stub, NOW, "UTC");
    expect(stub.calls[0]!.limit).toBeLessThanOrEqual(100);
  });

  // "What is coming" must not include what is already done or called off; the
  // rendered line carries no status, so such an item would look live.
  test("asks only for active items", async () => {
    const stub = stubQuery([]);
    await loadDigestHorizon(stub, NOW, "UTC");
    expect(stub.calls[0]!.statuses).toEqual(["active"]);
  });

  // A fixed span of milliseconds drifts an hour against the local day across a
  // DST transition; the relative form is resolved by calendar arithmetic.
  test("bounds the window with a zone-resolved relative end", async () => {
    const stub = stubQuery([]);
    await loadDigestHorizon(stub, NOW, "Europe/London");
    expect(stub.calls[0]!.from).toBe(new Date(NOW).toISOString());
    expect(stub.calls[0]!.to).toBe(`+${DIGEST_HORIZON_DAYS}d`);
  });

  // The single most important property: the query pages in interval-start
  // order, so an imminent meeting can sit entirely behind the first page of a
  // window crowded with long-running background spans. Ranking one page would
  // reproduce the very bug the ranking exists to fix.
  test("walks past the first page, so a later-paged meeting still lands", async () => {
    const background = Array.from({ length: 100 }, (_, i) =>
      item({
        id: `warranty_${String(i).padStart(3, "0")}`,
        startMs: NOW - 200 * DAY,
        endMs: NOW + 900 * DAY,
        label: `Warranty ${i}`,
        kind: "expiry",
      }),
    );
    const imminent = item({ id: "tp_meeting", startMs: NOW + 2 * DAY, label: "Planning sync" });
    const stub = stubPagedQuery([background, [imminent]]);
    const horizon = await loadDigestHorizon(stub, NOW, "UTC");
    expect(stub.calls).toHaveLength(2);
    expect(horizon.items[0]!.id).toBe("tp_meeting");
    expect(horizon.truncated).toBe(false);
  });

  test("reports truncation when the page budget runs out before the window does", async () => {
    const page = () => [item({ id: `i_${randomUUID()}`, startMs: NOW + HOUR })];
    const horizon = await loadDigestHorizon(
      stubPagedQuery([page(), page(), page(), page(), page(), page(), page()]),
      NOW,
      "UTC",
    );
    expect(horizon.truncated).toBe(true);
  });

  test("does not report truncation when the walk completes", async () => {
    const horizon = await loadDigestHorizon(
      stubPagedQuery([[item({ id: "a", startMs: NOW + HOUR })], [item({ id: "b", startMs: NOW })]]),
      NOW,
      "UTC",
    );
    expect(horizon.truncated).toBe(false);
  });
});

describe("digest horizon ranking", () => {
  test("items starting inside the window outrank long spans already underway", async () => {
    const ongoing = Array.from({ length: DIGEST_HORIZON_MAX_ENTRIES }, (_, i) =>
      item({
        id: `warranty_${i}`,
        startMs: NOW - 200 * DAY,
        endMs: NOW + 900 * DAY,
        label: `Warranty ${i}`,
        kind: "expiry",
      }),
    );
    const imminent = item({ id: "tp_meeting", startMs: NOW + 2 * DAY, label: "Planning sync" });
    const { items } = await loadDigestHorizon(stubQuery([...ongoing, imminent]), NOW, "UTC");
    // 30 background spans against a cap of 30: an unranked horizon drops the
    // meeting entirely, so surviving the cap is the property under test.
    expect(items[0]!.id).toBe("tp_meeting");
    expect(items).toHaveLength(DIGEST_HORIZON_MAX_ENTRIES);
  });

  // A warranty signed two years ago that expires on Thursday is a Thursday
  // item. Ranking it by its start would bury it behind every trivial meeting —
  // the opposite of what the digest is for.
  test("a long span ENDING inside the window ranks with the imminent items", async () => {
    const expiring = item({
      id: "tp_expiry",
      startMs: NOW - 700 * DAY,
      endMs: NOW + 2 * DAY,
      label: "Permit expires",
      kind: "expiry",
    });
    const background = Array.from({ length: DIGEST_HORIZON_MAX_ENTRIES }, (_, i) =>
      item({
        id: `bg_${i}`,
        startMs: NOW - 300 * DAY,
        endMs: NOW + 900 * DAY,
        label: `Background ${i}`,
        kind: "expiry",
      }),
    );
    const { items } = await loadDigestHorizon(stubQuery([...background, expiring]), NOW, "UTC");
    expect(items[0]!.id).toBe("tp_expiry");
  });

  test("caps the horizon at the display limit", async () => {
    const many = Array.from({ length: DIGEST_HORIZON_MAX_ENTRIES + 25 }, (_, i) =>
      item({ id: `i_${i}`, startMs: NOW + i * HOUR }),
    );
    const { items } = await loadDigestHorizon(stubQuery(many), NOW, "UTC");
    expect(items).toHaveLength(DIGEST_HORIZON_MAX_ENTRIES);
  });

  test("orders same-group items soonest first", async () => {
    const { items } = await loadDigestHorizon(
      stubQuery([
        item({ id: "later", startMs: NOW + 2 * DAY }),
        item({ id: "sooner", startMs: NOW + 1 * HOUR }),
      ]),
      NOW,
      "UTC",
    );
    expect(items.map((i) => i.id)).toEqual(["sooner", "later"]);
  });

  // The rendering is at pains to mark which lines are authoritative; a tie that
  // dropped the projection would cut the authoritative one first.
  test("a projection outranks an annotation at the same instant", async () => {
    const at = NOW + HOUR;
    const { items } = await loadDigestHorizon(
      stubQuery([
        item({ id: "aaa_annotation", startMs: at, origin: "annotation" }),
        item({ id: "zzz_projection", startMs: at, origin: "projection" }),
      ]),
      NOW,
      "UTC",
    );
    expect(items.map((i) => i.origin)).toEqual(["projection", "annotation"]);
  });
});

describe("digest horizon rendering", () => {
  test("renders a timed item in local wall-clock, not UTC", () => {
    const lines = renderDigestHorizonLines(
      horizonOf(
        [
          item({
            id: "tp",
            startMs: Date.parse("2026-07-02T14:00:00.000Z"),
            endMs: Date.parse("2026-07-02T15:00:00.000Z"),
            label: "Afternoon sync",
          }),
        ],
        "Europe/London",
      ),
    );
    expect(lines[0]).toContain("2026-07-02 15:00–16:00");
  });

  test("renders the same instant differently per zone", () => {
    const at = [
      item({
        id: "tp",
        startMs: Date.parse("2026-07-02T14:00:00.000Z"),
        endMs: Date.parse("2026-07-02T15:00:00.000Z"),
      }),
    ];
    expect(renderDigestHorizonLines(horizonOf(at, "UTC"))[0]).toContain("14:00–15:00");
    expect(renderDigestHorizonLines(horizonOf(at, "America/New_York"))[0]).toContain("10:00–11:00");
  });

  test("an all-day item renders as a bare date, with no misleading clock time", () => {
    const lines = renderDigestHorizonLines(
      horizonOf([
        item({
          id: "tp",
          startMs: Date.parse("2026-07-04T00:00:00.000Z"),
          endMs: Date.parse("2026-07-05T00:00:00.000Z"),
          allDay: true,
          label: "Public holiday",
          kind: "event",
        }),
      ]),
    );
    expect(lines[0]).toBe("- 2026-07-04 [event] (source-owned): Public holiday");
  });

  test("a multi-day span renders its inclusive last day, not the exclusive end", () => {
    const lines = renderDigestHorizonLines(
      horizonOf([
        item({
          id: "tp",
          startMs: Date.parse("2026-07-04T00:00:00.000Z"),
          endMs: Date.parse("2026-07-07T00:00:00.000Z"),
          allDay: true,
          label: "Trip",
          kind: "event",
        }),
      ]),
    );
    expect(lines[0]).toContain("2026-07-04 .. 2026-07-06");
  });

  // A `range`-precision annotation can be a genuine timed span. Folding it in
  // with the whole-day precisions would silently discard its clock times.
  test("a range-precision timed annotation keeps its clock times", () => {
    const lines = renderDigestHorizonLines(
      horizonOf([
        item({
          id: "ta",
          startMs: Date.parse("2026-07-03T14:00:00.000Z"),
          endMs: Date.parse("2026-07-03T16:00:00.000Z"),
          precision: "range",
          allDay: false,
          origin: "annotation",
          label: "Focus block",
        }),
      ]),
    );
    expect(lines[0]).toContain("14:00–16:00");
  });

  // A fact with no declared end is stored as an empty interval. Rendering it as
  // a span produces a meeting that starts and finishes at the same minute.
  test("a point-in-time fact renders as an instant, not a zero-length span", () => {
    const at = Date.parse("2026-07-03T15:00:00.000Z");
    const lines = renderDigestHorizonLines(
      horizonOf([item({ id: "tp", startMs: at, endMs: at, label: "Reminder" })]),
    );
    expect(lines[0]).toBe("- 2026-07-03 15:00 [appointment] (source-owned): Reminder");
    expect(lines[0]).not.toContain("15:00–15:00");
  });

  test("an interval crossing midnight names its end day", () => {
    const lines = renderDigestHorizonLines(
      horizonOf([
        item({
          id: "tp",
          startMs: Date.parse("2026-07-03T22:00:00.000Z"),
          endMs: Date.parse("2026-07-04T06:00:00.000Z"),
          label: "Night shift",
        }),
      ]),
    );
    expect(lines[0]).toContain("2026-07-03 22:00 – 2026-07-04 06:00");
  });

  test("marks origin and cites grounding documents from either origin", () => {
    const [projected, inferred] = renderDigestHorizonLines(
      horizonOf([
        item({ id: "tp", startMs: NOW + HOUR, label: "Dentist", documentId: "doc_a" }),
        item({
          id: "ta",
          startMs: NOW + 2 * HOUR,
          label: "Deposit likely clears",
          origin: "annotation",
          kind: "deadline",
          documentId: "doc_b",
        }),
      ]),
    );
    expect(projected).toContain("(source-owned): Dentist (docs: doc_a)");
    expect(inferred).toContain("(inferred): Deposit likely clears (docs: doc_b)");
  });
});

// A source-owned dated fact with NO annotation must reach the composed digest
// prompt. The intake lane is barred from restating a projection as an
// annotation, so a horizon that reads annotations only leaves such a document
// invisible to the user's morning read however well the rest of the pipeline
// worked. This drives the real query service over its SQLite projection store;
// the analytics-backed projection lane that calendar sources populate is
// covered in `enrichment/temporal/temporal-query-service.test.ts`.
describe("digest horizon over the real temporal query service", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
  });

  test("a projected, un-annotated event reaches the composed digest prompt", async () => {
    const now = Date.parse("2026-07-02T06:00:00.000Z");
    const invite: DocumentInput = {
      providerId: "synthetic" as ProviderId,
      sourceId: "synthetic-calendar:planner@example.com" as SourceId,
      externalId: "evt-1",
      title: "Quarterly planning sync",
      content: "An invented calendar invite.",
      contentHash: "evt-hash-1",
      metadata: { scheduledAt: "2026-07-03T14:00:00.000Z" },
      sourceCreatedAt: "2026-07-01T09:00:00.000Z",
      sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
    };
    upsertDocuments(db, [invite]);
    replaceDocumentTemporalProjections(
      db,
      invite,
      [{ slot: "calendar", start: "scheduledAt", kind: "appointment", modality: "scheduled" }],
      "2026-07-01T09:00:00.000Z",
    );
    // No annotation is created for it — exactly as the intake lane is told.
    expect(db.prepare("SELECT COUNT(*) AS n FROM temporal_annotations").get()).toEqual({ n: 0 });

    const horizon = await loadDigestHorizon(
      new TemporalQueryService(db, undefined),
      now,
      "Europe/London",
    );
    expect(horizon.items.map((i) => i.label)).toContain("Quarterly planning sync");

    const prompt = buildCognitionRunPrompt(
      {
        id: "run_digest",
        kind: "daily",
        payload: { digest: true, date: "2026-07-02" },
        payloadJson: '{"digest":true,"date":"2026-07-02"}',
        attempts: 1,
      },
      { db, clock: () => now, cfg: resolveBrainSettings(), digestHorizon: horizon },
    );
    expect(prompt).toContain("Quarterly planning sync");
    // 14:00Z in July is 15:00 in London — the time the user actually has.
    expect(prompt).toContain("2026-07-03 15:00");
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An invented store holding every shape the temporal window reads: document
 * projections, annotations of each precision (instants near midnight, days,
 * a month, a year, short and multi-year ranges, an open-ended range, a
 * vague canonical the reader cannot resolve, an invalidated row, one without
 * a kind) and mentions (days, a month, a span reaching back before a window,
 * a deadline, a date a document names twice, a thread repeating a date, a
 * document judged not worth recording). The windows and zones the tests read
 * it through sit around its dates, where the time-zone shift decides whether
 * an item is anchored.
 */

import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { applyExtractedDates } from "../dates/storage.js";
import { mentionDays } from "../dates/mention-bounds.js";
import { expandCanonical, insertTemporalAnnotation } from "../temporal-annotations/storage.js";
import { replaceDocumentTemporalProjections } from "../temporal-projections/document-storage.js";
import type { Db } from "../../data/types.js";
import type { DocumentInput, ExtractedDate } from "@omnesis/types";
import type { TemporalPrecision, TemporalQueryInput } from "@omnesis/core";

const FIXTURE_SOURCES = {
  mail: "fictional-mail:primary",
  notes: "fictional-notes",
  chat: "fictional-chat",
} as const;

const FIXTURE_PERSON = "person-maya-reeves";

/** Zones from UTC-11 to UTC+14, with India's half hour and Chile's midnight DST. */
export const FIXTURE_ZONES = [
  "UTC",
  "Europe/London",
  "America/Los_Angeles",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
  "Asia/Kolkata",
  "America/Santiago",
] as const;

/** Windows around the fixture's dates, some starting mid-day. */
export const FIXTURE_WINDOWS: ReadonlyArray<{ from: string; to?: string }> = [
  { from: "2026-10-12" },
  { from: "2026-10-13" },
  { from: "2026-10-12T09:00:00Z", to: "2026-10-12T18:00:00Z" },
  { from: "2026-10-12T20:00:00Z", to: "2026-10-14T04:00:00Z" },
  { from: "2026-10-05", to: "2026-10-19" },
  { from: "2026-10", to: "2026-11" },
  { from: "2026-09-01", to: "2026-12-01" },
];

/** Scopes a reader may narrow a window by. */
export function fixtureScopes(
  ids: FixtureIds,
): Array<Pick<TemporalQueryInput, "sourceIds" | "documentIds" | "entityIds" | "kinds">> {
  return [
    {},
    { sourceIds: [FIXTURE_SOURCES.mail] },
    { sourceIds: [FIXTURE_SOURCES.mail, FIXTURE_SOURCES.notes, FIXTURE_SOURCES.chat] },
    { documentIds: [ids.booking] },
    { entityIds: [FIXTURE_PERSON] },
    { kinds: ["deadline"] },
  ];
}

export interface FixtureIds {
  booking: string;
  notes: string;
  thread: [string, string];
  promo: string;
}

function doc(externalId: string, overrides: Partial<DocumentInput> = {}): DocumentInput {
  return {
    providerId: "synthetic" as DocumentInput["providerId"],
    sourceId: FIXTURE_SOURCES.mail as DocumentInput["sourceId"],
    externalId,
    title: `Invented ${externalId}`,
    content: "Invented body.",
    contentHash: `hash-${externalId}`,
    metadata: {},
    sourceCreatedAt: "2026-09-20T09:00:00.000Z",
    sourceUpdatedAt: "2026-09-20T09:00:00.000Z",
    ...overrides,
  };
}

function date(resolvedStart: string | null, overrides: Partial<ExtractedDate> = {}): ExtractedDate {
  return {
    kind: "date",
    resolvedStart,
    resolvedEnd: null,
    relative: false,
    text: resolvedStart ?? "a date",
    timex: resolvedStart ?? "XXXX",
    charStart: 0,
    charEnd: 4,
    ...overrides,
  };
}

function idOf(db: Db, externalId: string): string {
  return (
    db.prepare("SELECT id FROM documents WHERE external_id = ?").get(externalId) as { id: string }
  ).id;
}

export function seedTemporalFixture(db: Db): FixtureIds {
  upsertDocuments(db, [
    doc("booking", { title: "Studio booking", metadata: { dueAt: "2026-10-12" } }),
    doc("notes", { sourceId: FIXTURE_SOURCES.notes as DocumentInput["sourceId"] }),
    doc("thread-1", {
      sourceId: FIXTURE_SOURCES.chat as DocumentInput["sourceId"],
      sourceCreatedAt: "2026-09-21T09:00:00.000Z",
    }),
    doc("thread-2", {
      sourceId: FIXTURE_SOURCES.chat as DocumentInput["sourceId"],
      sourceCreatedAt: "2026-09-22T09:00:00.000Z",
    }),
    doc("promo", { title: "Invented sale" }),
  ]);
  const ids: FixtureIds = {
    booking: idOf(db, "booking"),
    notes: idOf(db, "notes"),
    thread: [idOf(db, "thread-1"), idOf(db, "thread-2")],
    promo: idOf(db, "promo"),
  };

  replaceDocumentTemporalProjections(
    db,
    doc("booking", { title: "Studio booking", metadata: { dueAt: "2026-10-12" } }),
    [{ slot: "due", start: "dueAt", kind: "deadline", modality: "scheduled" }],
    "2026-09-20T09:00:00.000Z",
  );

  const dates = (id: string, list: ExtractedDate[], threadKey: string | null = null) =>
    applyExtractedDates(db, [
      { id, dates: list, mentions: list.map((entry) => mentionDays(entry)), threadKey },
    ]);
  dates(ids.booking, [
    date("2026-10-12", { text: "12 October" }),
    date("2026-10-12", { text: "the 12th" }),
    date("2026-10-13", { text: "before 13 October", mod: "before" }),
    date("2026-10", { text: "October 2026" }),
    date("2026-10-08", {
      kind: "range",
      resolvedEnd: "2026-10-12",
      text: "8 to 12 October",
      timex: "(2026-10-08,2026-10-13,P5D)",
    }),
  ]);
  dates(ids.notes, [date("2026-10-14", { text: "14 October" })]);
  dates(ids.thread[0], [date("2026-10-12", { text: "12 October" })], "fictional-chat:thread");
  dates(ids.thread[1], [date("2026-10-12", { text: "12 October" })], "fictional-chat:thread");
  dates(ids.promo, [date("2026-10-12", { text: "sale ends 12 October" })]);
  db.prepare("UPDATE date_mention_judgements SET verdict = 'drop' WHERE document_id = ?").run(
    ids.promo,
  );

  let sequence = 0;
  const annotate = (
    when: string,
    options: {
      until?: string;
      kind?: string | null;
      documentIds?: string[];
      personIds?: string[];
      invalidated?: boolean;
    } = {},
  ) => {
    const start = expandCanonical(when)!;
    const end = options.until ? expandCanonical(options.until)! : start;
    const id = `ta_fixture_${String(++sequence).padStart(2, "0")}`;
    insertTemporalAnnotation(
      db,
      {
        id,
        intervalStartMs: Math.min(start.startMs, end.startMs),
        intervalEndMs: Math.max(start.endMs, end.endMs),
        precision: options.until ? "range" : start.precision,
        canonical: options.until ? `${when} .. ${options.until}` : when,
        sentence: `Invented annotation ${id}`,
        kind: options.kind === undefined ? "event" : options.kind,
        documentIds: options.documentIds ?? [ids.booking],
        ...(options.personIds ? { personIds: options.personIds } : {}),
        createdByRun: "run-fixture",
      },
      Date.parse("2026-09-25T00:00:00Z"),
    );
    if (options.invalidated) {
      db.prepare("UPDATE temporal_annotations SET invalidated_at = 1 WHERE id = ?").run(id);
    }
    return id;
  };
  annotate("2026-10-12");
  annotate("2026-10-13", { kind: "deadline", documentIds: [ids.notes] });
  annotate("2026-10-12T23:30:00Z", { personIds: [FIXTURE_PERSON] });
  annotate("2026-10-12T00:30:00Z", { kind: null });
  annotate("2026-10-11T13:00:00+14:00", { documentIds: [ids.thread[0]] });
  annotate("2026-10");
  annotate("2026");
  annotate("2026-10-01", { until: "2026-10-12" });
  annotate("2026-10-12T09:00:00Z", { until: "2026-10-12T11:00:00Z", kind: "appointment" });
  annotate("2024-01-01", { until: "2031-12-31", kind: "expiry", personIds: [FIXTURE_PERSON] });
  // Open-ended: begins inside the windows and runs to the end of the calendar.
  annotate("2026-10-12T15:00:00Z", { until: "9999-12-31" });
  annotate("2026-10-14", { invalidated: true });

  const raw = (
    id: string,
    precision: TemporalPrecision | string,
    canonical: string | null,
    startMs: number,
    endMs: number,
  ) =>
    insertTemporalAnnotation(
      db,
      {
        id,
        intervalStartMs: startMs,
        intervalEndMs: endMs,
        precision: precision as TemporalPrecision,
        canonical,
        sentence: `Invented annotation ${id}`,
        kind: "reminder",
        documentIds: [ids.booking],
        createdByRun: "run-fixture",
      },
      Date.parse("2026-09-25T00:00:00Z"),
    );
  // Vague: a canonical no reader resolves keeps its stored bounds.
  const monday = expandCanonical("2026-10-12")!;
  raw("ta_fixture_vague", "day", "every Monday", monday.startMs, monday.endMs);
  raw("ta_fixture_vague_range", "range", "next spring .. 2026-10-13", monday.startMs, monday.endMs);
  return ids;
}

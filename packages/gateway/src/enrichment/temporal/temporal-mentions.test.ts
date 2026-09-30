// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../db.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { replaceDocumentTemporalProjections } from "../temporal-projections/document-storage.js";
import { applyExtractedDates, ensureMentionDayColumns } from "../dates/storage.js";
import { mentionDays } from "../dates/mention-bounds.js";
import { insertTemporalAnnotation } from "../temporal-annotations/storage.js";
import { OMNESIS_CHAT_SOURCE_ID } from "../../sources/omnesis-chat/ids.js";
import { MENTION_COUNT_CAP } from "./temporal-mentions.js";
import { TemporalQueryService } from "./temporal-query-service.js";
import type { Db } from "../../data/types.js";
import type { DocumentInput, ExtractedDate } from "@omnesis/types";
import type { TemporalItem, TemporalQueryInput } from "@omnesis/core";

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function doc(externalId: string, overrides: Partial<DocumentInput> = {}): DocumentInput {
  return {
    providerId: "synthetic" as DocumentInput["providerId"],
    sourceId: "fictional-mail:primary" as DocumentInput["sourceId"],
    externalId,
    title: `Invented thread ${externalId}`,
    content: "Invented body.",
    contentHash: `hash-${externalId}`,
    metadata: {},
    sourceCreatedAt: "2026-09-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-09-01T09:00:00.000Z",
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
    timex: resolvedStart ?? overrides.resolvedEnd ?? "XXXX",
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

describe("temporal query — mention layer", () => {
  let path: string;
  let db: ReturnType<typeof createDatabase>;
  let service: TemporalQueryService;

  const mentions = (input: Omit<TemporalQueryInput, "timeZone"> & { timeZone?: string }) =>
    service.query({ timeZone: "UTC", origins: ["mention"], ...input });

  // Dates reach the store the way the extractor hands them over: each with
  // the mention days the production rules give it.
  const seed = (
    externalId: string,
    dates: ExtractedDate[],
    overrides?: Partial<DocumentInput>,
    threadKey: string | null = null,
  ) => {
    upsertDocuments(db, [doc(externalId, overrides)]);
    const id = idOf(db, externalId);
    applyExtractedDates(db, [
      { id, dates, mentions: dates.map((date) => mentionDays(date)), threadKey },
    ]);
    return id;
  };

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    service = new TemporalQueryService(db);
  });

  afterEach(() => {
    db.close();
    cleanup(path);
  });

  it("reads a day mention in its window, with the phrase and the document as provenance", async () => {
    const id = seed("m1", [date("2026-10-12", { text: "12 October", relative: false })], {
      title: "invented booking",
    });

    const result = await mentions({ from: "2026-10-12" });

    expect(result.items).toHaveLength(1);
    const [item] = result.items as [TemporalItem];
    expect(item).toMatchObject({
      origin: "mention",
      start: "2026-10-12T00:00:00.000Z",
      endExclusive: "2026-10-13T00:00:00.000Z",
      precision: "day",
      allDay: true,
      anchored: true,
      kind: "event",
      modality: "asserted",
      status: "active",
      label: "invented booking — “12 October”",
      mention: {
        documentId: id,
        sourceId: "fictional-mail:primary",
        text: "12 October",
        relative: false,
      },
    });
    expect(item.id).toMatch(/^dm_\d{16}$/);
    expect(result.summary).toEqual({ anchored: 1, spanning: 0 });
  });

  it("leaves out mentions from email judged not worth recording while the worth gate is active", async () => {
    const worth = seed("worth", [date("2026-10-12", { text: "12 October" })]);
    const promo = seed("promo", [date("2026-10-12", { text: "sale ends 12 October" })]);
    db.prepare("UPDATE date_mention_judgements SET verdict = 'keep' WHERE document_id = ?").run(
      worth,
    );
    db.prepare("UPDATE date_mention_judgements SET verdict = 'drop' WHERE document_id = ?").run(
      promo,
    );
    let active = true;
    service = new TemporalQueryService(db, undefined, { hideUnworthyMentions: () => active });

    const gated = await mentions({ from: "2026-10-12" });
    expect(gated.items.map((item) => item.mention?.documentId)).toEqual([worth]);
    expect(gated.coverage.mentions).toEqual({ pendingDocuments: 0, unworthyHidden: true });
    // A document the caller names speaks for itself.
    const named = await mentions({ from: "2026-10-12", documentIds: [promo] });
    expect(named.items.map((item) => item.mention?.documentId)).toEqual([promo]);
    expect(named.coverage.mentions?.unworthyHidden).toBeUndefined();
    const byEntity = await mentions({ from: "2026-10-12", entityIds: [promo] });
    expect(byEntity.items.map((item) => item.mention?.documentId)).toEqual([promo]);
    // With the gate inactive every mention is read.
    active = false;
    expect((await mentions({ from: "2026-10-12" })).items).toHaveLength(2);
  });

  it("is read only when asked for", async () => {
    seed("m1", [date("2026-10-12")]);
    const result = await service.query({ from: "2026-10-12", timeZone: "UTC" });
    expect(result.items).toEqual([]);
    expect(result.coverage.mentions).toBeUndefined();
  });

  it("matches only when the mention starts or ends inside the window", async () => {
    seed("month", [date("2026-10", { text: "October 2026" })]);
    seed("range", [
      date("2026-10-01", { kind: "range", resolvedEnd: "2026-10-20", text: "1–20 October" }),
    ]);

    // A week inside October: the month and the range merely span it.
    expect((await mentions({ from: "2026-10-05", to: "2026-10-12" })).items).toEqual([]);
    // The range ends on the 20th, inside this window.
    const endWindow = await mentions({ from: "2026-10-18", to: "2026-10-25" });
    expect(endWindow.items.map((item) => item.mention?.text)).toEqual(["1–20 October"]);
    // Both start on the 1st; the one ending sooner sorts first.
    const startWindow = await mentions({ from: "2026-10-01" });
    expect(startWindow.items.map((item) => [item.mention?.text, item.precision])).toEqual([
      ["1–20 October", "range"],
      ["October 2026", "month"],
    ]);
  });

  it("keeps a named period's exclusive end and closes an explicit span of days on its last day", async () => {
    seed("periods", [
      date("2026-09-28", {
        kind: "range",
        resolvedEnd: "2026-10-05",
        timex: "2026-W40",
        text: "the week of 28 September",
      }),
      date("2026-10-01", {
        kind: "range",
        resolvedEnd: "2026-10-03",
        timex: "(XXXX-10-01,XXXX-10-03,P2D)",
        text: "1 to 3 October",
      }),
    ]);
    const bounds = Object.fromEntries(
      (await mentions({ from: "2026-09-28", to: "2026-10-02" })).items.map((item) => [
        item.mention?.text,
        [item.start.slice(0, 10), item.endExclusive.slice(0, 10)],
      ]),
    );
    expect(bounds).toEqual({
      "the week of 28 September": ["2026-09-28", "2026-10-05"],
      "1 to 3 October": ["2026-10-01", "2026-10-04"],
    });
    // The week's end is the next Monday's start: that Monday does not hold it.
    expect((await mentions({ from: "2026-10-05" })).items).toEqual([]);
    // The explicit span still covers its last named day.
    const third = await mentions({ from: "2026-10-03T12:00:00Z", to: "2026-10-04T12:00:00Z" });
    expect(third.items.map((item) => item.mention?.text)).toEqual(["1 to 3 October"]);
  });

  it("reads a phrase bounding a date from above as a deadline, and filters by it", async () => {
    seed("due", [
      date(null, {
        kind: "range",
        resolvedEnd: "2026-10-12",
        mod: "before",
        timex: "XXXX-10-12",
        text: "before 12 October",
      }),
    ]);
    seed("on", [date("2026-10-12", { text: "12 October" })]);
    const all = await mentions({ from: "2026-10-12" });
    expect(all.items.map((item) => [item.mention?.text, item.kind])).toEqual([
      ["before 12 October", "deadline"],
      ["12 October", "event"],
    ]);
    const deadlines = await mentions({ from: "2026-10-12", kinds: ["deadline"] });
    expect(deadlines.items.map((item) => item.mention?.text)).toEqual(["before 12 October"]);
    expect(deadlines.summary.anchored).toBe(1);
    const events = await mentions({ from: "2026-10-12", kinds: ["event"] });
    expect(events.items.map((item) => item.mention?.text)).toEqual(["12 October"]);
    expect((await mentions({ from: "2026-10-12", kinds: ["appointment"] })).items).toEqual([]);
  });

  it("keeps a deadline and a plain date on the same day apart, in one document and in a thread", async () => {
    const deadline = date(null, {
      kind: "range",
      resolvedEnd: "2026-10-12",
      mod: "before",
      timex: "XXXX-10-12",
      text: "before 12 October",
    });
    const plain = date("2026-10-12", { text: "12 October" });
    // The plain date comes first in the document.
    const both = seed("both", [plain, deadline]);
    const thread = "fictional-mail:primary\u0000deadline-thread";
    const older = seed(
      "older",
      [deadline],
      { sourceCreatedAt: "2026-09-01T09:00:00.000Z" },
      thread,
    );
    seed("newer", [plain], { sourceCreatedAt: "2026-09-02T09:00:00.000Z" }, thread);

    const deadlines = await mentions({ from: "2026-10-12", kinds: ["deadline"] });
    expect(deadlines.items.map((item) => item.mention?.documentId).sort()).toEqual(
      [both, older].sort(),
    );
    const all = await mentions({ from: "2026-10-12" });
    const kinds = all.items
      .filter((item) => item.mention?.documentId === both)
      .map((item) => item.kind)
      .sort();
    expect(kinds).toEqual(["deadline", "event"]);
  });

  it("lets a caller who names a message see its dates even when a later reply repeats them", async () => {
    const thread = "fictional-mail:primary\u0000named-thread";
    const first = seed(
      "named-first",
      [date("2026-10-12", { text: "12 October" })],
      { sourceCreatedAt: "2026-09-01T09:00:00.000Z" },
      thread,
    );
    seed(
      "named-reply",
      [date("2026-10-12", { text: "> 12 October" })],
      {
        sourceCreatedAt: "2026-09-02T09:00:00.000Z",
      },
      thread,
    );
    const named = await mentions({ from: "2026-10-12", documentIds: [first] });
    expect(named.items.map((item) => item.mention?.documentId)).toEqual([first]);
    const asEntity = await mentions({ from: "2026-10-12", entityIds: [first] });
    expect(asEntity.items.map((item) => item.mention?.documentId)).toEqual([first]);
  });

  it("does not let a later month hide an earlier span of days with the same bounds", async () => {
    const thread = "fictional-mail:primary\u0000shape-thread";
    seed(
      "span-first",
      [
        date("2026-10-01", {
          kind: "range",
          resolvedEnd: "2026-10-31",
          timex: "(XXXX-10-01,XXXX-10-31,P30D)",
          text: "1 to 31 October",
        }),
      ],
      { sourceCreatedAt: "2026-09-01T09:00:00.000Z" },
      thread,
    );
    seed(
      "month-later",
      [date("2026-10", { text: "October 2026" })],
      {
        sourceCreatedAt: "2026-09-02T09:00:00.000Z",
      },
      thread,
    );
    // Only the span may match by its end.
    const byEnd = await mentions({ from: "2026-10-20", to: "2026-11-05" });
    expect(byEnd.items.map((item) => item.mention?.text)).toEqual(["1 to 31 October"]);
  });

  it("shows a date a conversation repeats once, from its latest message", async () => {
    const thread = "fictional-mail:primary\u0000invented-thread";
    seed(
      "first",
      [date("2026-10-12", { text: "12 October" })],
      { sourceCreatedAt: "2026-09-01T09:00:00.000Z" },
      thread,
    );
    seed(
      "reply",
      [date("2026-10-12", { text: "> 12 October" })],
      { sourceCreatedAt: "2026-09-02T09:00:00.000Z" },
      thread,
    );
    seed(
      "elsewhere",
      [date("2026-10-12", { text: "12 October" })],
      { sourceCreatedAt: "2026-09-01T09:00:00.000Z" },
      "fictional-mail:primary\u0000other-thread",
    );
    seed("loose", [date("2026-10-12", { text: "12 October" })]);
    const result = await mentions({ from: "2026-10-12" });
    const docs = result.items.map((item) => item.mention?.documentId);
    expect(docs).toHaveLength(3);
    expect(docs).toContain(idOf(db, "reply"));
    expect(docs).not.toContain(idOf(db, "first"));
    expect(result.summary.anchored).toBe(3);
  });

  it("matches today's mentions from a window that starts mid-day, but not a month begun earlier", async () => {
    seed("today", [
      date("2026-10-12", { text: "today" }),
      date("2026-10", { text: "October 2026" }),
    ]);
    const fromNoon = await mentions({ from: "2026-10-12T12:00:00Z", to: "2026-10-19" });
    expect(fromNoon.items.map((item) => item.mention?.text)).toEqual(["today"]);
    expect(fromNoon.summary.anchored).toBe(1);
    // A window reaching into November does not answer "October".
    expect((await mentions({ from: "2026-10-25", to: "2026-11-05" })).items).toEqual([]);
    // Nor does one that starts after October's first midnight, even though
    // October ends inside it.
    expect(
      (await mentions({ from: "2026-10-01T12:00:00Z", to: "2026-11-05" })).items.map(
        (item) => item.mention?.text,
      ),
    ).toEqual(["today"]);
  });

  it("drops a mention of a day the zone skipped instead of failing the query", async () => {
    // Samoa moved across the date line and had no 30 December 2011.
    seed("skipped", [
      date("2011-12-30", { text: "30 December" }),
      date("2011-12-31", { text: "31 December" }),
    ]);
    const result = await mentions({
      from: "2011-12-29T00:00:00Z",
      to: "2012-01-02T00:00:00Z",
      timeZone: "Pacific/Apia",
    });
    expect(result.items.map((item) => item.mention?.text)).toEqual(["31 December"]);
  });

  it("keeps a span of days that shares its bounds with a month in the same document", async () => {
    seed("shapes", [
      date("2026-10", { text: "October 2026" }),
      date("2026-10-01", {
        kind: "range",
        resolvedEnd: "2026-10-31",
        timex: "(XXXX-10-01,XXXX-10-31,P30D)",
        text: "1 to 31 October",
      }),
    ]);
    // Only the span may match by its end.
    const byEnd = await mentions({ from: "2026-10-15", to: "2026-11-15" });
    expect(byEnd.items.map((item) => item.mention?.text)).toEqual(["1 to 31 October"]);
    const byStart = await mentions({ from: "2026-10-01" });
    expect(byStart.items.map((item) => item.mention?.text).sort()).toEqual([
      "1 to 31 October",
      "October 2026",
    ]);
  });

  it("pages past a skipped day without losing or reordering what follows", async () => {
    seed("around-skip", [
      date("2011-12-30", { kind: "range", resolvedEnd: "2012-01-03", text: "30 Dec to 3 Jan" }),
      date("2011-12-31", { text: "31 December" }),
      date("2012-01-01", { text: "1 January" }),
    ]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await mentions({
        from: "2011-12-29T00:00:00Z",
        to: "2012-01-05T00:00:00Z",
        timeZone: "Pacific/Apia",
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((item) => item.mention?.text ?? ""));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["31 December", "1 January"]);
    const whole = await mentions({
      from: "2011-12-29T00:00:00Z",
      to: "2012-01-05T00:00:00Z",
      timeZone: "Pacific/Apia",
    });
    expect(whole.items.map((item) => item.mention?.text)).toEqual(["31 December", "1 January"]);
  });

  it("resumes a mention cursor at its own row on a crowded day", async () => {
    for (let index = 0; index < 30; index++) seed(`crowd-${index}`, [date("2026-10-12")]);
    let pages = 0;
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const page = await mentions({ from: "2026-10-12", limit: 10, ...(cursor ? { cursor } : {}) });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(ids).size).toBe(30);
  });

  it("reads an open-ended phrase as the one bound it names", async () => {
    seed("deadline", [
      date(null, {
        kind: "range",
        resolvedEnd: "2026-10-30",
        mod: "before",
        text: "before 30 October",
      }),
    ]);
    const [item] = (await mentions({ from: "2026-10-30" })).items as [TemporalItem];
    expect(item).toMatchObject({
      start: "2026-10-30T00:00:00.000Z",
      endExclusive: "2026-10-31T00:00:00.000Z",
      precision: "day",
      mention: { mod: "before", text: "before 30 October" },
    });
  });

  it("counts one document naming the same day twice as one mention", async () => {
    seed("twice", [
      date("2026-10-12", { text: "12 October", charStart: 0 }),
      date("2026-10-12", {
        kind: "range",
        resolvedEnd: null,
        mod: "after",
        text: "after the 12th",
      }),
    ]);
    seed("other", [date("2026-10-12", { text: "the 12th" })]);
    const result = await mentions({ from: "2026-10-12" });
    expect(result.items.map((item) => item.mention?.text)).toEqual(["12 October", "the 12th"]);
    expect(result.summary.anchored).toBe(2);
  });

  it("resolves day bounds in the caller's zone", async () => {
    seed("tz", [date("2026-10-12", { text: "12 October" })]);
    const [item] = (await mentions({ from: "2026-10-12", timeZone: "America/New_York" })).items as [
      TemporalItem,
    ];
    expect(item.start).toBe("2026-10-12T04:00:00.000Z");
    expect(item.endExclusive).toBe("2026-10-13T04:00:00.000Z");
    expect(item.timeZone).toBe("America/New_York");

    // Half an hour late on the 11th, local time, ends before the 12th begins
    // in that zone: no match.
    const late = await mentions({
      from: "2026-10-12T03:00:00Z",
      to: "2026-10-12T03:30:00Z",
      timeZone: "America/New_York",
    });
    expect(late.items).toEqual([]);
  });

  it("honours source, document, entity, kind, modality and status filters", async () => {
    const mailId = seed("mail", [date("2026-10-12")]);
    seed("note", [date("2026-10-12")], {
      sourceId: "fictional-notes:primary" as DocumentInput["sourceId"],
    });

    const window = { from: "2026-10-12" };
    const sources = await mentions({ ...window, sourceIds: ["fictional-notes:primary"] });
    expect(sources.items.map((item) => item.mention?.sourceId)).toEqual([
      "fictional-notes:primary",
    ]);
    expect((await mentions({ ...window, documentIds: [mailId] })).items).toHaveLength(1);
    expect((await mentions({ ...window, entityIds: [mailId] })).items).toHaveLength(1);
    expect((await mentions({ ...window, kinds: ["event"] })).items).toHaveLength(2);
    expect((await mentions({ ...window, kinds: ["deadline"] })).items).toEqual([]);
    expect((await mentions({ ...window, modalities: ["scheduled"] })).items).toEqual([]);
    expect((await mentions({ ...window, statuses: ["cancelled"] })).items).toEqual([]);
  });

  it("pages through mentions and projections in one order without gaps or repeats", async () => {
    const days = ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];
    for (const [index, day] of days.entries()) {
      seed(`page-${index}`, [date(day, { text: `mention ${index}` })]);
    }
    // A projection sharing a day with a mention sorts ahead of it on that day.
    const calendar = doc("calendar", {
      title: "Invented review",
      metadata: { dueAt: "2026-10-12" },
    });
    upsertDocuments(db, [calendar]);
    replaceDocumentTemporalProjections(
      db,
      calendar,
      [{ slot: "due", start: "dueAt", kind: "event", modality: "scheduled" }],
      "2026-09-01T09:00:00.000Z",
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.query({
        from: "2026-10-10",
        to: "2026-10-15",
        timeZone: "UTC",
        origins: ["projection", "mention"],
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.summary.anchored).toBe(6);
      seen.push(...page.items.map((item) => item.label));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual([
      "Invented thread page-0 — “mention 0”",
      "Invented thread page-1 — “mention 1”",
      "Invented review",
      "Invented thread page-2 — “mention 2”",
      "Invented thread page-3 — “mention 3”",
      "Invented thread page-4 — “mention 4”",
    ]);
  });

  it("walks a day holding more mentions than one scan batch", async () => {
    for (let index = 0; index < 450; index++) {
      seed(`bulk-${index}`, [date("2026-10-12")]);
    }
    const ids = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await mentions({
        from: "2026-10-12",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) ids.add(item.id);
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(ids.size).toBe(450);
    expect(pages).toBe(5);
  });

  it("reports documents still waiting for the recognizer", async () => {
    seed("scanned", [date("2026-10-12")]);
    upsertDocuments(db, [doc("unscanned")]);
    const result = await mentions({ from: "2026-10-12" });
    expect(result.coverage.mentions).toEqual({ pendingDocuments: 1 });
  });

  it("leaves out documents the gateway's own agent wrote", async () => {
    seed("chat", [date("2026-10-12", { text: "on the 12th" })], {
      sourceId: OMNESIS_CHAT_SOURCE_ID as DocumentInput["sourceId"],
    });
    seed("mail", [date("2026-10-12", { text: "12 October" })]);
    const result = await mentions({ from: "2026-10-12" });
    expect(result.items.map((item) => item.mention?.text)).toEqual(["12 October"]);
    // Naming the source does not bring it back.
    expect(
      (await mentions({ from: "2026-10-12", sourceIds: [OMNESIS_CHAT_SOURCE_ID] })).items,
    ).toEqual([]);
  });

  it("hides an edited document's dates until the recognizer has re-read it", async () => {
    const id = seed("edited", [date("2026-10-12", { text: "12 October" })]);
    upsertDocuments(db, [
      doc("edited", { content: "The date was removed.", contentHash: "edited-2" }),
    ]);
    expect((await mentions({ from: "2026-10-12" })).items).toEqual([]);
    applyExtractedDates(db, [{ id, dates: [] }]);
    expect((await mentions({ from: "2026-10-12" })).items).toEqual([]);
  });

  it("drops a deleted document's mentions", async () => {
    const id = seed("gone", [date("2026-10-12")]);
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM document_extracted_dates WHERE document_id = ?")
        .get(id),
    ).toEqual({ n: 0 });
    expect((await mentions({ from: "2026-10-12" })).items).toEqual([]);
  });

  it("clips a long title in the label", async () => {
    seed("long", [date("2026-10-12", { text: "12 October" })], { title: "word ".repeat(200) });
    const [item] = (await mentions({ from: "2026-10-12" })).items as [TemporalItem];
    expect(item.label.length).toBeLessThan(260);
    expect(item.label).toContain("… — “12 October”");
  });

  it("counts pending documents within the requested sources", async () => {
    upsertDocuments(db, [
      doc("pending-mail"),
      doc("pending-note", { sourceId: "fictional-notes:primary" as DocumentInput["sourceId"] }),
    ]);
    const all = await mentions({ from: "2026-10-12" });
    expect(all.coverage.mentions).toEqual({ pendingDocuments: 2 });
    const notes = await mentions({ from: "2026-10-12", sourceIds: ["fictional-notes:primary"] });
    expect(notes.coverage.mentions).toEqual({ pendingDocuments: 1 });
  });

  it("resumes from a timed projection's cursor mid-day in a daylight-saving zone", async () => {
    seed("before", [date("2026-10-12", { text: "the 12th" })]);
    seed("after", [date("2026-10-13", { text: "the 13th" })]);
    const timed = doc("timed", {
      title: "invented call",
      metadata: { dueAt: "2026-10-12T14:00:00.000Z" },
    });
    upsertDocuments(db, [timed]);
    replaceDocumentTemporalProjections(
      db,
      timed,
      [{ slot: "due", start: "dueAt", kind: "appointment", modality: "scheduled" }],
      "2026-09-01T09:00:00.000Z",
    );
    const query = {
      from: "2026-10-12",
      to: "2026-10-14",
      timeZone: "Europe/London",
      origins: ["projection", "mention"] as TemporalQueryInput["origins"],
    };
    // The day mention starts at local midnight and sorts first; the timed call
    // is second, and the page boundary lands on it.
    const first = await service.query({ ...query, limit: 2 });
    expect(first.items.map((item) => item.label)).toEqual([
      "Invented thread before — “the 12th”",
      "invented call",
    ]);
    const second = await service.query({ ...query, limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.label)).toEqual(["Invented thread after — “the 13th”"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("resumes from an annotation's cursor", async () => {
    seed("first", [date("2026-10-12", { text: "the 12th" })]);
    seed("second", [
      date("2026-10-12", { kind: "range", resolvedEnd: "2026-10-13", text: "12–13 October" }),
    ]);
    insertTemporalAnnotation(
      db,
      {
        id: "ta_between",
        intervalStartMs: Date.parse("2026-10-12T00:00:00.000Z"),
        intervalEndMs: Date.parse("2026-10-12T23:59:59.999Z"),
        precision: "day",
        canonical: "2026-10-12",
        sentence: "An invented interpretation.",
        kind: "event",
        documentIds: [],
        createdByRun: "run_synthetic",
      },
      Date.parse("2026-09-01T09:00:00.000Z"),
    );
    const query = {
      from: "2026-10-12",
      to: "2026-10-14",
      timeZone: "UTC",
      origins: ["annotation", "mention"] as TemporalQueryInput["origins"],
    };
    // Same day bounds: the annotation outranks the mention, the range sorts last.
    const first = await service.query({ ...query, limit: 1 });
    expect(first.items.map((item) => item.origin)).toEqual(["annotation"]);
    const rest = await service.query({ ...query, limit: 5, cursor: first.nextCursor });
    expect(rest.items.map((item) => item.mention?.text)).toEqual(["the 12th", "12–13 October"]);
    expect(first.summary).toEqual({ anchored: 3, spanning: 0 });
  });

  it("counts a spanning projection beside mentions", async () => {
    seed("inside", [date("2026-10-12")]);
    const long = doc("long-span", {
      metadata: { scheduledAt: "2026-10-01", endsAt: "2026-10-31" },
    });
    upsertDocuments(db, [long]);
    replaceDocumentTemporalProjections(
      db,
      long,
      [
        {
          slot: "stay",
          start: "scheduledAt",
          end: "endsAt",
          kind: "episode",
          modality: "scheduled",
        },
      ],
      "2026-09-01T09:00:00.000Z",
    );
    const result = await service.query({
      from: "2026-10-12",
      timeZone: "UTC",
      origins: ["projection", "mention"],
    });
    expect(result.summary).toEqual({ anchored: 1, spanning: 1 });
    expect(result.items.map((item) => item.origin)).toEqual(["projection", "mention"]);
  });

  it("walks the day indexes in query order instead of sorting the window", async () => {
    seed("plan", [date("2026-10-12")]);
    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("document_extracted_dates x")) statements.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);
    await mentions({ from: "2026-10-12T09:00:00Z", to: "2026-10-20" });
    spy.mockRestore();

    const plan = (sql: string) =>
      (
        db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(
            ...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => "2026-10-12"),
          ) as Array<{ detail: string }>
      )
        .map((row) => row.detail)
        .join("\n");
    const walk = statements.find((sql) => sql.includes("ORDER BY"));
    const earlier = statements.find((sql) => sql.includes("x.mention_end_day BETWEEN"));
    expect(walk && earlier).toBeTruthy();
    expect(plan(walk!)).toContain("idx_document_extracted_dates_mention_start");
    expect(plan(walk!)).not.toContain("TEMP B-TREE");
    expect(plan(earlier!)).toContain("idx_document_extracted_dates_mention_range");
  });

  it("counts a window's mentions only up to the cap", async () => {
    for (let index = 0; index < MENTION_COUNT_CAP + 5; index++) {
      seed(`many-${index}`, [date("2026-10-12")]);
    }
    const result = await mentions({ from: "2026-10-12", limit: 3 });
    expect(result.items).toHaveLength(3);
    expect(result.summary.anchored).toBe(MENTION_COUNT_CAP);
    expect(result.coverage.mentions).toEqual({ pendingDocuments: 0, countCapped: true });
  });

  it("adds the day columns and indexes to an existing table, idempotently", () => {
    const legacy = createDatabase(`${path}-legacy`);
    try {
      legacy.exec(`DROP TABLE document_extracted_dates`);
      legacy.exec(`CREATE TABLE document_extracted_dates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        resolved_start TEXT,
        resolved_end TEXT,
        mod TEXT,
        relative INTEGER NOT NULL DEFAULT 0,
        matched_text TEXT NOT NULL,
        timex TEXT NOT NULL,
        char_start INTEGER NOT NULL,
        char_end INTEGER NOT NULL
      )`);
      ensureMentionDayColumns(legacy);
      ensureMentionDayColumns(legacy);
      const columns = (
        legacy
          .prepare("SELECT name FROM pragma_table_info('document_extracted_dates')")
          .all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(columns).toEqual(
        expect.arrayContaining(["mention_start_day", "mention_end_day", "thread_key"]),
      );
      const indexes = (
        legacy
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'document_extracted_dates'",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "idx_document_extracted_dates_mention_start",
          "idx_document_extracted_dates_mention_range",
          "idx_document_extracted_dates_mention_thread",
        ]),
      );
    } finally {
      legacy.close();
      cleanup(`${path}-legacy`);
    }
  });
});

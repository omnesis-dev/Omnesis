// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { JournalFormatError, parseJournal } from "./read.js";

const DOC = {
  op: "created",
  docId: "d0c00000-0000-4000-8000-000000000001",
  sourceId: "gmail",
  providerId: "google",
  documentType: "email",
  title: "Hello",
  semanticTime: "2026-03-02T09:00:00.000Z",
  changedFields: [],
  contentChanged: false,
  metadata: {},
  people: [],
};

function line(seq: number, observedAt: string, occurredAt = observedAt): string {
  return JSON.stringify({ seq, kind: "doc.event", occurredAt, observedAt, payload: DOC });
}

describe("parseJournal", () => {
  it("reads events and ignores blank lines", () => {
    const events = parseJournal(
      [line(1, "2026-03-02T09:00:00.000Z"), "", line(2, "2026-03-02T10:00:00.000Z"), ""].join("\n"),
    );
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("accepts semantic time running backwards — that is a source backfilling", () => {
    const events = parseJournal(
      [
        line(1, "2026-03-02T09:00:00.000Z"),
        line(2, "2026-03-02T10:00:00.000Z", "2026-02-27T08:00:00.000Z"),
      ].join("\n"),
    );
    expect(events).toHaveLength(2);
  });

  it("rejects a gap in the sequence — it is the resume point", () => {
    expect(() =>
      parseJournal(
        [line(1, "2026-03-02T09:00:00.000Z"), line(3, "2026-03-02T10:00:00.000Z")].join("\n"),
      ),
    ).toThrow(/seq is 3 where 2 was expected/);
  });

  it("rejects processing time moving backwards", () => {
    expect(() =>
      parseJournal(
        [line(1, "2026-03-02T10:00:00.000Z"), line(2, "2026-03-02T09:00:00.000Z")].join("\n"),
      ),
    ).toThrow(/observedAt moves backwards/);
  });

  it("rejects a zone-less instant", () => {
    const bad = JSON.stringify({
      seq: 1,
      kind: "doc.event",
      occurredAt: "2026-03-02T09:00:00",
      observedAt: "2026-03-02T09:00:00.000Z",
      payload: DOC,
    });
    expect(() => parseJournal(bad)).toThrow(/ISO-8601 instant with an explicit zone/);
  });

  it("reports every problem, not just the first", () => {
    const text = ["{not json", "also not json"].join("\n");
    try {
      parseJournal(text, "fixture.jsonl");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(JournalFormatError);
      expect((error as JournalFormatError).problems.map((p) => p.line)).toEqual([1, 2]);
      expect((error as JournalFormatError).path).toBe("fixture.jsonl");
    }
  });

  it("does not cascade phantom gaps through a line that failed to parse", () => {
    const text = [
      line(1, "2026-03-02T09:00:00.000Z"),
      "{not json",
      line(3, "2026-03-02T10:00:00.000Z"),
      line(4, "2026-03-02T11:00:00.000Z"),
    ].join("\n");
    try {
      parseJournal(text);
      expect.unreachable("should have thrown");
    } catch (error) {
      // One real problem — the unparseable line — not that plus two invented
      // sequence gaps whose only cause is the hole it left.
      expect((error as JournalFormatError).problems).toHaveLength(1);
      expect((error as JournalFormatError).problems[0]!.line).toBe(2);
    }
  });

  it("counts lines in the file, not events in the journal", () => {
    const text = [
      "",
      "",
      line(1, "2026-03-02T09:00:00.000Z"),
      line(3, "2026-03-02T10:00:00.000Z"),
    ].join("\n");
    try {
      parseJournal(text);
      expect.unreachable("should have thrown");
    } catch (error) {
      // The offending event is the fourth line of the file, not the second event.
      expect((error as JournalFormatError).problems[0]!.line).toBe(4);
    }
  });

  it("accepts a journal that starts at a resume point rather than at one", () => {
    const events = parseJournal(
      [line(940, "2026-03-02T09:00:00.000Z"), line(941, "2026-03-02T10:00:00.000Z")].join("\n"),
    );
    expect(events.map((e) => e.seq)).toEqual([940, 941]);
  });

  it("rejects an instant that matches the shape but is not a real date", () => {
    // `2026-99-99` parses to NaN, and every ordering comparison against NaN is
    // false — so one impossible date would switch the checks off rather than
    // fail them.
    const bad = JSON.stringify({
      seq: 1,
      kind: "doc.event",
      occurredAt: "2026-99-99T00:00:00Z",
      observedAt: "2026-03-02T09:00:00.000Z",
      payload: DOC,
    });
    expect(() => parseJournal(bad)).toThrow(/real calendar instant/);
  });

  it("rejects an unknown event kind rather than passing it through", () => {
    const bad = JSON.stringify({
      seq: 1,
      kind: "doc.deleted",
      occurredAt: "2026-03-02T09:00:00.000Z",
      observedAt: "2026-03-02T09:00:00.000Z",
      payload: {},
    });
    expect(() => parseJournal(bad)).toThrow();
  });
});

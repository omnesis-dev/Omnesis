// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { boundedSelfAuthoredText } from "./document.js";
import type { DocumentMetadata } from "./document.js";

/**
 * `scheduledAt` / `dueAt` are generic, first-class typed dates on the shared
 * document contract. These tests exercise them the way a shared consumer
 * would: reading the typed field off `DocumentMetadata` with NO knowledge of
 * which source produced it (no `if (source === "things")` branch). Any dated
 * source fills whichever of the two it has; consumers coalesce to a single
 * instant without caring about the origin.
 */

/**
 * A generic "when does this matter" resolver a shared consumer (e.g. a brief's
 * `eventAt` default, or a future "what's due today" sweep) would use. It reads
 * only the typed fields — deadline first, else the planned day — and is
 * completely source-agnostic.
 */
function whenItMatters(meta: DocumentMetadata): string | undefined {
  return meta.dueAt ?? meta.scheduledAt;
}

describe("DocumentMetadata scheduled/due dates", () => {
  test("both fields are optional (a document may carry neither)", () => {
    const meta: DocumentMetadata = { documentType: "note" };
    expect(meta.scheduledAt).toBeUndefined();
    expect(meta.dueAt).toBeUndefined();
    expect(whenItMatters(meta)).toBeUndefined();
  });

  test("a source with both a scheduled start and a hard deadline keeps them distinct", () => {
    // Shape a task-like source would emit: planned for the 10th, due by the
    // 15th. The two dates are NOT collapsed.
    const meta: DocumentMetadata = {
      documentType: "task",
      scheduledAt: "2026-03-10",
      dueAt: "2026-03-15",
    };
    expect(meta.scheduledAt).toBe("2026-03-10");
    expect(meta.dueAt).toBe("2026-03-15");
    // Urgency resolver prefers the deadline.
    expect(whenItMatters(meta)).toBe("2026-03-15");
  });

  test("a deadline-only source fills dueAt; the resolver still finds a date", () => {
    const meta: DocumentMetadata = { documentType: "reminder", dueAt: "2026-07-04" };
    expect(whenItMatters(meta)).toBe("2026-07-04");
  });

  test("a scheduled-only source fills scheduledAt; the resolver falls back to it", () => {
    const meta: DocumentMetadata = { documentType: "task", scheduledAt: "2026-07-04" };
    expect(whenItMatters(meta)).toBe("2026-07-04");
  });

  test("full ISO date-times are accepted (a timed source, e.g. an event)", () => {
    const meta: DocumentMetadata = {
      documentType: "event",
      scheduledAt: "2026-07-04T09:00:00.000Z",
    };
    expect(meta.scheduledAt).toBe("2026-07-04T09:00:00.000Z");
  });
});

describe("DocumentMetadata source lifecycle status", () => {
  test("keeps the source-owned vocabulary generic", () => {
    const task: DocumentMetadata = { documentType: "task", status: "canceled" };
    const approval: DocumentMetadata = { documentType: "note", status: "approved" };

    expect(task.status).toBe("canceled");
    expect(approval.status).toBe("approved");
  });
});

describe("bounded self-authored evidence", () => {
  test("keeps the newest segments and ignores invalid dates and blank text", () => {
    const segments = Array.from({ length: 140 }, (_, index) => ({
      text: `word-${index}`,
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));
    const result = boundedSelfAuthoredText([
      ...segments,
      { text: "invalid", recordedAt: "unknown" },
      { text: "  ", recordedAt: "2026-01-02T00:00:00Z" },
    ]);
    expect(result).toHaveLength(128);
    expect(result[0].text).toBe("word-139");
    expect(result[127].text).toBe("word-12");
  });

  test("large unordered input retains newest evidence with stable ties", () => {
    const segments = Array.from({ length: 2000 }, (_, index) => ({
      text: `entry-${index}`,
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, (index * 37) % 2000)).toISOString(),
    }));
    const expected = segments
      .map((segment, index) => ({ ...segment, index }))
      .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || a.index - b.index)
      .slice(0, 128)
      .map(({ text, recordedAt }) => ({ text, recordedAt }));
    expect(boundedSelfAuthoredText(segments)).toEqual(expected);
    const tied = segments.map((segment) => ({
      ...segment,
      recordedAt: "2026-01-01T00:00:00.000Z",
    }));
    expect(boundedSelfAuthoredText(tied)).toEqual(tied.slice(0, 128));
  });

  test("caps total characters without manufacturing a partial final word", () => {
    const result = boundedSelfAuthoredText([
      { text: "word ".repeat(7000), recordedAt: "2026-01-02T00:00:00Z" },
      { text: "older", recordedAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(result.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(32768);
    expect(result[0].text.endsWith("word ")).toBe(true);
    expect(result[0].recordedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach } from "vitest";
import { NotesDayUpserter, buildNotesDayDocument } from "./upsert.js";
import type { DocumentInput, NoteCaptureContext } from "@omnesis/types";

import type { NoteEntry } from "./storage.js";

/**
 * Drain pending microtasks so the upserter's `startRun` chain
 * (Promise.catch().then().catch().finally()) finishes posting to the
 * mocks before assertions.
 */
async function drainMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

class FakeScheduler {
  private nextHandle = 1;
  readonly timers = new Map<number, { fn: () => void; ms: number }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const handle = this.nextHandle++;
    this.timers.set(handle, { fn, ms });
    return handle;
  };
  clearTimeout = (h: unknown): void => {
    this.timers.delete(h as number);
  };
  /** Fire every pending timer in insertion order. */
  fireAll(): void {
    const handles = [...this.timers.keys()];
    for (const h of handles) {
      const t = this.timers.get(h);
      if (!t) continue;
      this.timers.delete(h);
      t.fn();
    }
  }
  size(): number {
    return this.timers.size;
  }
}

function makeEntry(overrides: Partial<NoteEntry> = {}): NoteEntry {
  const capturedAt = overrides.capturedAt ?? "2026-06-15T09:30:00.000Z";
  return {
    id: overrides.id ?? "e-1",
    day: "2026-06-15",
    capturedAt,
    updatedAt: capturedAt,
    text: "Book the ferry for the Riverside Estate visit",
    surface: "cli",
    deviceId: null,
    latitude: null,
    longitude: null,
    placeName: null,
    capturedTimeZoneId: null,
    capturedUtcOffsetSeconds: null,
    receivedAt: null,
    ...overrides,
  };
}

function captureContext(principalId: string, principalName: string): NoteCaptureContext {
  return {
    principalId,
    principalName,
    grantId: `grant_${principalId}`,
    grantRevision: 1,
    credentialId: `cred_${principalId}`,
    oauthClientId: `client_${principalId}`,
    requestId: `req_${principalId}`,
  };
}

interface Harness {
  upserter: NotesDayUpserter;
  ingested: DocumentInput[][];
  deletedDays: string[];
  entriesByDay: Map<string, NoteEntry[]>;
}

function makeHarness(sched: FakeScheduler, opts: { debounceMs?: number } = {}): Harness {
  const ingested: DocumentInput[][] = [];
  const deletedDays: string[] = [];
  const entriesByDay = new Map<string, NoteEntry[]>();
  const upserter = new NotesDayUpserter({
    listEntries: (day) => entriesByDay.get(day) ?? [],
    ingest: async (docs) => {
      ingested.push(docs);
    },
    deleteDayDoc: async (day) => {
      deletedDays.push(day);
    },
    debounceMs: opts.debounceMs ?? 3_000,
    scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
  });
  return { upserter, ingested, deletedDays, entriesByDay };
}

describe("buildNotesDayDocument", () => {
  test("externalId is the day; marker + self author + entry count are set", () => {
    const doc = buildNotesDayDocument("2026-06-15", [
      makeEntry({ id: "a", capturedAt: "2026-06-15T09:00:00.000Z" }),
      makeEntry({ id: "b", capturedAt: "2026-06-15T10:00:00.000Z" }),
    ]);
    expect(doc.providerId).toBe("system");
    expect(doc.sourceId).toBe("omnesis-notes");
    expect(doc.externalId).toBe("2026-06-15");
    expect(doc.title).toBe("Notes — 2026-06-15");
    expect(doc.metadata.documentType).toBe("note");
    expect(doc.metadata.addressedToAgent).toBe(true);
    expect(doc.metadata.addressedEntries).toEqual([
      {
        id: "a",
        capturedAt: "2026-06-15T09:00:00.000Z",
        updatedAt: "2026-06-15T09:00:00.000Z",
        surface: "cli",
      },
      {
        id: "b",
        capturedAt: "2026-06-15T10:00:00.000Z",
        updatedAt: "2026-06-15T10:00:00.000Z",
        surface: "cli",
      },
    ]);
    expect(doc.metadata.sourceUrl).toBeUndefined();
    expect(doc.metadata.appUrl).toBeUndefined();
    expect(doc.metadata.people).toEqual([{ name: "You", role: "author", isSelf: true }]);
    expect(doc.metadata.extra).toEqual({ entryCount: 2 });
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an entry captured through a grant is authored by its principal and received by the operator", () => {
    const doc = buildNotesDayDocument("2026-06-15", [
      makeEntry({ id: "a", capturedAt: "2026-06-15T09:00:00.000Z" }),
      makeEntry({
        id: "b",
        capturedAt: "2026-06-15T10:00:00.000Z",
        surface: "mcp",
        captureContext: captureContext("prn_1", "Aurora planner"),
      }),
    ]);
    expect(doc.metadata.people).toEqual([
      { name: "You", role: "author", isSelf: true },
      { name: "Aurora planner", role: "author", isSelf: false, kind: "agent" },
      { name: "You", role: "recipient", isSelf: true },
    ]);
  });

  test("a day captured only through grants carries no operator author", () => {
    const doc = buildNotesDayDocument("2026-06-15", [
      makeEntry({
        id: "a",
        capturedAt: "2026-06-15T09:00:00.000Z",
        captureContext: captureContext("prn_1", "Aurora  planner"),
      }),
      makeEntry({
        id: "b",
        capturedAt: "2026-06-15T10:00:00.000Z",
        captureContext: captureContext("prn_1", "Aurora planner"),
      }),
      makeEntry({
        id: "c",
        capturedAt: "2026-06-15T11:00:00.000Z",
        captureContext: captureContext("prn_2", "Cobalt dictation"),
      }),
    ]);
    // One author per principal name, as the headings show it; the operator
    // appears once, as the recipient.
    expect(doc.metadata.people).toEqual([
      { name: "Aurora planner", role: "author", isSelf: false, kind: "agent" },
      { name: "Cobalt dictation", role: "author", isSelf: false, kind: "agent" },
      { name: "You", role: "recipient", isSelf: true },
    ]);
  });

  test("sourceCreatedAt = first capture; sourceUpdatedAt = newest capture-or-edit", () => {
    const doc = buildNotesDayDocument("2026-06-15", [
      makeEntry({ id: "a", capturedAt: "2026-06-15T09:00:00.000Z" }),
      makeEntry({
        id: "b",
        capturedAt: "2026-06-15T10:00:00.000Z",
        updatedAt: "2026-06-15T17:45:00.000Z", // edited later
      }),
    ]);
    expect(doc.sourceCreatedAt).toBe("2026-06-15T09:00:00.000Z");
    expect(doc.sourceUpdatedAt).toBe("2026-06-15T17:45:00.000Z");
  });

  test("content hash tracks the rendered body", () => {
    const a = buildNotesDayDocument("2026-06-15", [makeEntry({ text: "one" })]);
    const b = buildNotesDayDocument("2026-06-15", [makeEntry({ text: "two" })]);
    const a2 = buildNotesDayDocument("2026-06-15", [makeEntry({ text: "one" })]);
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(a.contentHash).toBe(a2.contentHash);
  });

  test("throws on zero entries (delete path owns that case)", () => {
    expect(() => buildNotesDayDocument("2026-06-15", [])).toThrow(/no entries/);
  });
});

describe("NotesDayUpserter", () => {
  let sched: FakeScheduler;
  beforeEach(() => {
    sched = new FakeScheduler();
  });

  test("enqueue installs a timer; firing ingests the day document", async () => {
    const h = makeHarness(sched);
    h.entriesByDay.set("2026-06-15", [makeEntry()]);
    h.upserter.enqueue("2026-06-15");
    expect(sched.size()).toBe(1);
    expect(h.ingested).toHaveLength(0);

    sched.fireAll();
    await drainMicrotasks();
    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0]![0]).toMatchObject({
      externalId: "2026-06-15",
      sourceId: "omnesis-notes",
    });
  });

  test("the fired run reads the ledger at flush time, not at enqueue time", async () => {
    const h = makeHarness(sched);
    h.upserter.enqueue("2026-06-15");
    // The entry lands after the enqueue but before the timer fires.
    h.entriesByDay.set("2026-06-15", [makeEntry()]);
    sched.fireAll();
    await drainMicrotasks();
    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0]![0]).toMatchObject({ externalId: "2026-06-15" });
  });

  test("zero entries at flush time → the day document is deleted, nothing ingested", async () => {
    const h = makeHarness(sched);
    // No entries registered for the day (last one was removed).
    h.upserter.enqueue("2026-06-15");
    await h.upserter.flushAll();
    expect(h.ingested).toHaveLength(0);
    expect(h.deletedDays).toEqual(["2026-06-15"]);
  });

  test("flushAll flushes every pending day", async () => {
    const h = makeHarness(sched);
    h.entriesByDay.set("2026-06-15", [makeEntry()]);
    h.entriesByDay.set("2026-06-16", [makeEntry({ day: "2026-06-16" })]);
    h.upserter.enqueue("2026-06-15");
    h.upserter.enqueue("2026-06-16");
    await h.upserter.flushAll();
    expect(h.ingested).toHaveLength(2);
    expect(sched.size()).toBe(0);
  });

  test("an ingest failure doesn't wedge the day — a subsequent enqueue still runs", async () => {
    let calls = 0;
    const ingested: DocumentInput[][] = [];
    const upserter = new NotesDayUpserter({
      listEntries: () => [makeEntry()],
      ingest: async (docs) => {
        calls += 1;
        if (calls === 1) throw new Error("ingest exploded");
        ingested.push(docs);
      },
      deleteDayDoc: async () => {},
      debounceMs: 3_000,
      scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
    });

    upserter.enqueue("2026-06-15");
    await upserter.flushAll();
    expect(ingested).toHaveLength(0); // first run rejected

    upserter.enqueue("2026-06-15");
    await upserter.flushAll();
    expect(ingested).toHaveLength(1); // the day's chain survived the failure
  });

  test("dispose drops pending timers and refuses subsequent enqueues", () => {
    const h = makeHarness(sched);
    h.upserter.enqueue("2026-06-15");
    h.upserter.dispose();
    h.upserter.enqueue("2026-06-16");
    expect(sched.size()).toBe(0);
  });
});

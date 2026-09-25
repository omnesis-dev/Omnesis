// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The waker's hot-path half: the subscriber must do nothing but a pure
 * decision plus an in-memory buffer mutation (criterion 2's "no writer
 * work on the event path"), and the buffer must fold per document,
 * bound its memory, and honor `document.deleted` evictions.
 */

import { describe, test, expect } from "vitest";
import { EventBus, type DocumentProjection, type DocumentUpsertedEvent } from "../../events.js";
import { createBriefsWakerBuffer, subscribeBriefsWaker } from "./event-handler.js";
import type { WakeDecision } from "./eligibility.js";

const NOW = Date.parse("2026-07-02T12:00:00Z");

const CFG = {
  recencyWindowMs: 7 * 24 * 60 * 60_000,
  conversationDebounceMs: 60 * 60_000,
  documentUpdateDebounceMs: 30 * 60_000,
  conversationMaxDeferMs: 6 * 60 * 60_000,
  documentMaxDeferMs: 4 * 60 * 60_000,
};

function projection(overrides: Partial<DocumentProjection> = {}): DocumentProjection {
  return {
    id: "doc-1",
    providerId: "google",
    sourceId: "drive:maya@example.com",
    externalId: "ext-1",
    documentType: "file",
    title: "Trip planning",
    contentHash: "hash-a",
    metadata: {},
    sourceCreatedAt: new Date(NOW - 60_000).toISOString(),
    sourceUpdatedAt: new Date(NOW - 60_000).toISOString(),
    people: [],
    ...overrides,
  };
}

function updateEvent(
  beforeContent: string,
  afterContent: string,
  overrides: Partial<DocumentProjection> = {},
): DocumentUpsertedEvent {
  const after = projection(overrides);
  return {
    before: { ...after, contentHash: `hash-of-${beforeContent}` },
    after: { ...after, contentHash: `hash-of-${afterContent}` },
    afterContent,
    beforeContent,
    changedFields: ["contentHash"],
    contentChanged: true,
  };
}

function decision(overrides: Partial<WakeDecision> = {}): WakeDecision {
  return {
    docId: "doc-1",
    event: "updated",
    datumAt: NOW - 60_000,
    debounceMs: CFG.documentUpdateDebounceMs,
    maxDeferMs: CFG.documentMaxDeferMs,
    captureDiff: true,
    ...overrides,
  };
}

describe("waker buffer", () => {
  test("folds per document: earliest diff base, latest body, latest schedule", () => {
    const buf = createBriefsWakerBuffer();
    buf.add(updateEvent("v0", "v1"), decision());
    buf.add(updateEvent("v1", "v2"), decision({ datumAt: NOW }));
    expect(buf.size()).toBe(1);
    const [entry] = buf.drain();
    expect(entry.beforeContent).toBe("v0");
    expect(entry.afterContent).toBe("v2");
    expect(entry.datumAt).toBe(NOW);
  });

  test("folds changed addressed-entry ids without duplicates", () => {
    const buf = createBriefsWakerBuffer();
    buf.add(
      updateEvent("v0", "v1"),
      decision({ changedAddressedEntryIds: ["entry-a", "entry-b"] }),
    );
    buf.add(
      updateEvent("v1", "v2"),
      decision({ changedAddressedEntryIds: ["entry-b", "entry-c"] }),
    );
    expect(buf.drain()[0]!.changedAddressedEntryIds).toEqual(["entry-a", "entry-b", "entry-c"]);
  });

  test("a doc that entered as created stays created (no diff material)", () => {
    const buf = createBriefsWakerBuffer();
    const insert: DocumentUpsertedEvent = {
      before: null,
      after: projection(),
      afterContent: "v1",
      changedFields: [],
      contentChanged: true,
    };
    buf.add(insert, decision({ event: "created", debounceMs: 0, captureDiff: false }));
    buf.add(updateEvent("v1", "v2"), decision());
    const [entry] = buf.drain();
    expect(entry.event).toBe("created");
    expect(entry.beforeContent).toBeUndefined();
    // The later update's debounce still applies (trailing debounce).
    expect(entry.debounceMs).toBe(CFG.documentUpdateDebounceMs);
  });

  test("content byte budget: over-budget entries keep the wake, lose the bodies", () => {
    const buf = createBriefsWakerBuffer({ maxContentBytes: 8 });
    buf.add(updateEvent("0123456789", "0123456789x"), decision());
    const [entry] = buf.drain();
    expect(entry.docId).toBe("doc-1");
    expect(entry.beforeContent).toBeUndefined();
    expect(entry.afterContent).toBeUndefined();
  });

  test("entry cap: new docs past the cap are dropped", () => {
    const buf = createBriefsWakerBuffer({ maxEntries: 1 });
    buf.add(updateEvent("a", "b"), decision());
    buf.add(updateEvent("a", "b", { id: "doc-2" }), decision({ docId: "doc-2" }));
    expect(buf.size()).toBe(1);
    expect(buf.drain()[0].docId).toBe("doc-1");
  });

  test("evict drops the entry (deleted documents never enqueue)", () => {
    const buf = createBriefsWakerBuffer();
    buf.add(updateEvent("a", "b"), decision());
    buf.evict("doc-1");
    expect(buf.size()).toBe(0);
    expect(buf.drain()).toEqual([]);
  });

  test("restore re-buffers a failed enqueue without duplicating a newer entry", () => {
    const buf = createBriefsWakerBuffer();
    buf.add(updateEvent("v0", "v1"), decision());
    const [entry] = buf.drain();
    buf.restore(entry);
    expect(buf.size()).toBe(1);
    expect(buf.drain()[0].beforeContent).toBe("v0");
  });
});

describe("waker subscriber (hot-path safety)", () => {
  test("an upsert event mutates the buffer synchronously (the drain owns all writer work)", () => {
    const bus = new EventBus();
    const buf = createBriefsWakerBuffer();
    subscribeBriefsWaker({ eventBus: bus, buffer: buf, getConfig: () => CFG, clock: () => NOW });
    bus.emit("document.upserted", updateEvent("v0", "v1"));
    // Buffered immediately on the synchronous emit — the subscriber has
    // no write-gate reference by construction; the companion assertion
    // that nothing is enqueued until the drain runs lives in
    // drain-task.test.ts.
    expect(buf.size()).toBe(1);
  });

  test("ineligible events are not buffered", () => {
    const bus = new EventBus();
    const buf = createBriefsWakerBuffer();
    subscribeBriefsWaker({ eventBus: bus, buffer: buf, getConfig: () => CFG, clock: () => NOW });
    bus.emit("document.upserted", {
      before: null,
      after: projection({ documentType: "webpage" }),
      afterContent: "x",
      changedFields: [],
      contentChanged: true,
    });
    expect(buf.size()).toBe(0);
  });

  test("document.deleted evicts the buffered wake", () => {
    const bus = new EventBus();
    const buf = createBriefsWakerBuffer();
    subscribeBriefsWaker({ eventBus: bus, buffer: buf, getConfig: () => CFG, clock: () => NOW });
    bus.emit("document.upserted", updateEvent("v0", "v1"));
    expect(buf.size()).toBe(1);
    bus.emit("document.deleted", {
      id: "doc-1",
      providerId: "google",
      sourceId: "drive:maya@example.com",
      externalId: "ext-1",
    });
    expect(buf.size()).toBe(0);
  });

  test("unsubscribe detaches both handlers", () => {
    const bus = new EventBus();
    const buf = createBriefsWakerBuffer();
    const off = subscribeBriefsWaker({
      eventBus: bus,
      buffer: buf,
      getConfig: () => CFG,
      clock: () => NOW,
    });
    off();
    bus.emit("document.upserted", updateEvent("v0", "v1"));
    expect(buf.size()).toBe(0);
  });
});

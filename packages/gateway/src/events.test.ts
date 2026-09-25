// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, beforeEach } from "vitest";
import { EventBus, type DocumentProjection, type DocumentUpsertedEvent } from "./events.js";

let bus: EventBus;

beforeEach(() => {
  bus = new EventBus();
});

function makeProjection(overrides: Partial<DocumentProjection> = {}): DocumentProjection {
  return {
    id: "doc-1",
    providerId: "p",
    sourceId: "s:account",
    externalId: "ext",
    documentType: null,
    title: "t",
    contentHash: "h",
    metadata: {},
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
    people: [],
    ...overrides,
  };
}

function makeDocEvent(id = "d1"): DocumentUpsertedEvent {
  const after = makeProjection({ id });
  return {
    before: null,
    after,
    afterContent: "c",
    changedFields: [],
    contentChanged: true,
  };
}

describe("EventBus", () => {
  test("on/emit delivers payload to handler", () => {
    const seen: string[] = [];
    bus.on("document.upserted", (e) => seen.push(e.after.id));
    bus.emit("document.upserted", makeDocEvent("a"));
    bus.emit("document.upserted", makeDocEvent("b"));
    expect(seen).toEqual(["a", "b"]);
  });

  test("multiple handlers all receive the event", () => {
    const a: string[] = [];
    const b: string[] = [];
    bus.on("document.upserted", (e) => a.push(e.after.id));
    bus.on("document.upserted", (e) => b.push(e.after.id));
    bus.emit("document.upserted", makeDocEvent("x"));
    expect(a).toEqual(["x"]);
    expect(b).toEqual(["x"]);
  });

  test("returned unsubscribe function removes the handler", () => {
    const seen: string[] = [];
    const unsub = bus.on("document.upserted", (e) => seen.push(e.after.id));
    bus.emit("document.upserted", makeDocEvent("a"));
    unsub();
    bus.emit("document.upserted", makeDocEvent("b"));
    expect(seen).toEqual(["a"]);
  });

  test("handler exceptions don't poison sibling handlers", () => {
    const reached: string[] = [];
    bus.on("document.upserted", () => {
      throw new Error("boom");
    });
    bus.on("document.upserted", (e) => reached.push(e.after.id));
    expect(() => bus.emit("document.upserted", makeDocEvent("a"))).not.toThrow();
    expect(reached).toEqual(["a"]);
  });

  test("emit on a topic with no handlers is a noop", () => {
    expect(() => bus.emit("document.upserted", makeDocEvent())).not.toThrow();
  });

  test("clear() removes every handler across topics", () => {
    const seen: number[] = [];
    bus.on("document.upserted", () => seen.push(1));
    bus.on("analytics_row.inserted", () => seen.push(2));
    bus.clear();
    bus.emit("document.upserted", makeDocEvent());
    bus.emit("analytics_row.inserted", { table: "t", sourceId: "s", row: {} });
    expect(seen).toEqual([]);
  });

  test("handlers added during emit() do NOT receive the in-flight event", () => {
    const seen: string[] = [];
    bus.on("document.upserted", () => {
      // Adding mid-emit should affect future emits, not the current one.
      bus.on("document.upserted", (e) => seen.push(`late:${e.after.id}`));
    });
    bus.emit("document.upserted", makeDocEvent("a"));
    // The "late" handler should NOT have fired for "a".
    expect(seen).toEqual([]);
    bus.emit("document.upserted", makeDocEvent("b"));
    // It should fire for "b" now.
    expect(seen).toContain("late:b");
  });

  test("topics are independent — emit('x') doesn't fire 'y' handler", () => {
    const seen: number[] = [];
    bus.on("document.upserted", () => seen.push(1));
    bus.on("analytics_row.inserted", () => seen.push(2));
    bus.emit("document.upserted", makeDocEvent());
    expect(seen).toEqual([1]);
  });

  test("unsubscribing one handler leaves others live", () => {
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = bus.on("document.upserted", () => a.push(1));
    bus.on("document.upserted", () => b.push(1));
    unsubA();
    bus.emit("document.upserted", makeDocEvent());
    expect(a).toEqual([]);
    expect(b).toEqual([1]);
  });

  test("repeated unsubscribe is idempotent", () => {
    const seen: number[] = [];
    const unsub = bus.on("document.upserted", () => seen.push(1));
    unsub();
    unsub(); // second call should be a noop
    bus.emit("document.upserted", makeDocEvent());
    expect(seen).toEqual([]);
  });
});

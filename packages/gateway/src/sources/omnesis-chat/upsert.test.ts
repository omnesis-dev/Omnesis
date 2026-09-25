// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach } from "vitest";

import { ConversationUpserter, buildDocumentInput, renderedCitationsToInputs } from "./upsert.js";
import type { ConversationRecord } from "../../agent/conversation-store.js";
import type { WriteGate } from "../../write-gate.js";
import type { ConversationCitationInput } from "./citation-writer.js";

/**
 * Drain pending microtasks so the upserter's `startRun` chain
 * (Promise.catch().then().catch().finally()) finishes posting to the
 * mock writeGate. setImmediate gives every queued microtask a chance
 * to run before the assertion.
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

function makeRecord(id: string, overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id,
    callerId: "token:test",
    model: "claude-test",
    backend: "replay",
    createdAt: "2026-05-23T10:00:00.000Z",
    updatedAt: "2026-05-23T10:01:00.000Z",
    title: "Trip planning",
    pinned: false,
    messages: [
      { role: "user", parts: [{ kind: "text", text: "Hello" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Hi back" }] },
    ],
    ...overrides,
  };
}

function makeGate(): {
  gate: WriteGate;
  upsertCalls: Array<unknown[]>;
  citationCalls: Array<{ docId: string; citations: ReadonlyArray<ConversationCitationInput> }>;
  deleteCalls: Array<{ providerId: string; sourceId: string; externalIds: string[] }>;
} {
  const upsertCalls: Array<unknown[]> = [];
  const citationCalls: Array<{
    docId: string;
    citations: ReadonlyArray<ConversationCitationInput>;
  }> = [];
  const deleteCalls: Array<{ providerId: string; sourceId: string; externalIds: string[] }> = [];
  const gate = {
    upsertDocuments: async (docs: unknown[]) => {
      upsertCalls.push(docs);
    },
    upsertConversationCitations: async (
      docId: string,
      citations: ReadonlyArray<ConversationCitationInput>,
    ) => {
      citationCalls.push({ docId, citations });
      return { removed: 0, inserted: citations.length };
    },
    deleteDocuments: async (providerId: string, sourceId: string, externalIds: string[]) => {
      deleteCalls.push({ providerId, sourceId, externalIds });
      return externalIds;
    },
  } as unknown as WriteGate;
  return { gate, upsertCalls, citationCalls, deleteCalls };
}

describe("buildDocumentInput", () => {
  test("populates source identity and type without inventing an external URL", () => {
    const doc = buildDocumentInput(makeRecord("s_xyz"));
    expect(doc.sourceId).toBe("omnesis-chat");
    expect(doc.providerId).toBe("system");
    expect(doc.externalId).toBe("s_xyz");
    expect(doc.metadata.documentType).toBe("conversation");
    expect(doc.metadata.sourceUrl).toBeUndefined();
    expect(doc.metadata.appUrl).toBeUndefined();
    expect(doc.metadata.people).toEqual([{ name: "You", role: "participant", isSelf: true }]);
    expect(doc.metadata.extra).toMatchObject({ backend: "replay", messageCount: 2 });
  });

  test("title defaults to (untitled) when the record has none", () => {
    const doc = buildDocumentInput(makeRecord("s_x", { title: "" }));
    expect(doc.title).toBe("(untitled)");
  });
});

describe("renderedCitationsToInputs", () => {
  test("forwards a document citation payload as-is", () => {
    const out = renderedCitationsToInputs([
      { kind: "document", documentId: "d1", quote: "q", quoteAuthor: "a", note: "n" },
      { kind: "document", documentId: "d2" },
    ]);
    expect(out).toEqual([
      { kind: "document", targetDocId: "d1", quote: "q", quoteAuthor: "a", note: "n" },
      {
        kind: "document",
        targetDocId: "d2",
        quote: undefined,
        quoteAuthor: undefined,
        note: undefined,
      },
    ]);
  });

  test("maps a record citation to a kind:'record' input (#757)", () => {
    const out = renderedCitationsToInputs([
      {
        kind: "record",
        table: "demo_transactions",
        recordKey: "row:demo_transactions:txn-1",
        primaryKeyColumns: [{ name: "id", value: "txn-1", castType: "VARCHAR" }],
        title: "Stellar Sound",
        keyFields: [{ label: "Merchant", value: "Stellar Sound" }],
        semanticTime: "2026-05-23T10:00:00.000Z",
        snapshot: { id: "txn-1", merchant: "Stellar Sound" },
        sourceId: "demo:acct1",
        sourceType: "demo",
        tableDisplayName: "Demo Transactions",
        boundDocumentId: "doc-7",
      },
    ]);
    expect(out).toEqual([
      {
        kind: "record",
        table: "demo_transactions",
        recordKey: "row:demo_transactions:txn-1",
        primaryKeyColumns: [{ name: "id", value: "txn-1", castType: "VARCHAR" }],
        title: "Stellar Sound",
        keyFields: [{ label: "Merchant", value: "Stellar Sound" }],
        semanticTime: "2026-05-23T10:00:00.000Z",
        snapshot: { id: "txn-1", merchant: "Stellar Sound" },
        sourceId: "demo:acct1",
        sourceType: "demo",
        tableDisplayName: "Demo Transactions",
        boundDocumentId: "doc-7",
      },
    ]);
  });
});

describe("ConversationUpserter debouncing", () => {
  let sched: FakeScheduler;
  beforeEach(() => {
    sched = new FakeScheduler();
  });

  test("enqueue installs a timer; firing triggers an upsert", async () => {
    const { gate, upsertCalls, citationCalls } = makeGate();
    const upserter = new ConversationUpserter({
      writeGate: gate,
      lookupDocId: () => "doc-1",
      debounceMs: 30_000,
      scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
    });

    upserter.enqueue("s_1", async () => makeRecord("s_1"));
    expect(sched.size()).toBe(1);
    expect(upsertCalls).toHaveLength(0);

    sched.fireAll();
    await drainMicrotasks();
    expect(upsertCalls).toHaveLength(1);
    expect(citationCalls).toHaveLength(1);
    expect(citationCalls[0]?.docId).toBe("doc-1");
  });

  test("repeated enqueue coalesces and the fired run sees the freshest loader", async () => {
    const { gate, upsertCalls } = makeGate();
    const upserter = new ConversationUpserter({
      writeGate: gate,
      lookupDocId: () => "doc-1",
      debounceMs: 30_000,
      scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
    });

    upserter.enqueue("s_1", async () => makeRecord("s_1", { title: "stale" }));
    upserter.enqueue("s_1", async () => makeRecord("s_1", { title: "fresh" }));
    // Two enqueues, but only one live timer should remain.
    expect(sched.size()).toBe(1);
    expect(upserter.pendingCount()).toBe(1);

    sched.fireAll();
    await drainMicrotasks();
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]?.[0]).toMatchObject({ title: "fresh" });
  });

  test("flush runs the upsert immediately and removes the timer", async () => {
    const { gate, upsertCalls } = makeGate();
    const upserter = new ConversationUpserter({
      writeGate: gate,
      lookupDocId: () => "doc-1",
      debounceMs: 30_000,
      scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
    });
    upserter.enqueue("s_1", async () => makeRecord("s_1"));
    await upserter.flush("s_1");
    expect(upsertCalls).toHaveLength(1);
    expect(sched.size()).toBe(0);
    expect(upserter.pendingCount()).toBe(0);
  });

  test("cancelPending drops a session's timer without upserting", async () => {
    const { gate, upsertCalls } = makeGate();
    const upserter = new ConversationUpserter({
      writeGate: gate,
      lookupDocId: () => "doc-1",
      debounceMs: 30_000,
      scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
    });
    upserter.enqueue("s_1", async () => makeRecord("s_1"));
    upserter.enqueue("s_2", async () => makeRecord("s_2"));
    await upserter.cancelPending("s_1");
    expect(upserter.pendingCount()).toBe(1);
    expect(sched.size()).toBe(1);
    sched.fireAll();
    await drainMicrotasks();
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]?.[0]).toMatchObject({ externalId: "s_2" });
  });

  test("flushAll awaits both pending timers and in-flight runs", async () => {
    const { gate, upsertCalls } = makeGate();
    const upserter = new ConversationUpserter({
      writeGate: gate,
      lookupDocId: () => "doc-1",
      debounceMs: 30_000,
      scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
    });
    upserter.enqueue("s_a", async () => makeRecord("s_a"));
    upserter.enqueue("s_b", async () => makeRecord("s_b"));
    await upserter.flushAll();
    expect(upsertCalls).toHaveLength(2);
    expect(upserter.pendingCount()).toBe(0);
    expect(upserter.inflightCount()).toBe(0);
  });

  test("loader returning null is a no-op", async () => {
    const { gate, upsertCalls } = makeGate();
    const upserter = new ConversationUpserter({
      writeGate: gate,
      lookupDocId: () => "doc-1",
      debounceMs: 30_000,
      scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
    });
    upserter.enqueue("s_missing", async () => null);
    await upserter.flush("s_missing");
    expect(upsertCalls).toHaveLength(0);
  });

  test("lookupDocId returning null skips the citation write", async () => {
    const { gate, upsertCalls, citationCalls } = makeGate();
    const upserter = new ConversationUpserter({
      writeGate: gate,
      lookupDocId: () => null,
      debounceMs: 30_000,
      scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
    });
    upserter.enqueue("s_1", async () => makeRecord("s_1"));
    await upserter.flush("s_1");
    expect(upsertCalls).toHaveLength(1);
    expect(citationCalls).toHaveLength(0);
  });
});

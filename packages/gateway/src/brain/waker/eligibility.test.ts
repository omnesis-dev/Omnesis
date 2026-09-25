// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Success-criteria 2 and 10 at the pure-decision level: every V1 wake
 * heuristic class (web ephemera, bulk mail, daily-batch samples, the
 * recency gate, metadata-only churn), the self-trigger guard, and the
 * debounce selection — all via generic document-type / projection /
 * metadata signals, no source-name branching anywhere.
 */

import { describe, test, expect } from "vitest";
import { OPEN_LOOP_SOURCE_ID } from "../open-loop-source/source-meta.js";
import { decideWake, type WakerHeuristicsConfig } from "./eligibility.js";
import type { DocumentProjection, DocumentUpsertedEvent } from "../../events.js";

const NOW = Date.parse("2026-07-02T12:00:00Z");

const CFG: WakerHeuristicsConfig = {
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
    sourceId: "gmail:maya@example.com",
    externalId: "ext-1",
    documentType: "email",
    title: "Quarterly budget review",
    contentHash: "hash-a",
    metadata: {},
    sourceCreatedAt: new Date(NOW - 60_000).toISOString(),
    sourceUpdatedAt: new Date(NOW - 60_000).toISOString(),
    people: [],
    ...overrides,
  };
}

function insertEvent(overrides: Partial<DocumentProjection> = {}): DocumentUpsertedEvent {
  return {
    before: null,
    after: projection(overrides),
    afterContent: "hello",
    changedFields: [],
    contentChanged: true,
  };
}

function updateEvent(
  overrides: Partial<DocumentProjection> = {},
  opts: { contentChanged?: boolean } = {},
): DocumentUpsertedEvent {
  const after = projection(overrides);
  const contentChanged = opts.contentChanged ?? true;
  return {
    before: { ...after, contentHash: contentChanged ? "hash-before" : after.contentHash },
    after,
    afterContent: "hello v2",
    beforeContent: "hello v1",
    changedFields: contentChanged ? ["contentHash"] : ["metadata"],
    contentChanged,
  };
}

describe("waker eligibility (criterion 2)", () => {
  test("eligible fresh email wakes with no debounce", () => {
    const d = decideWake(insertEvent(), CFG, NOW);
    expect(d).not.toBeNull();
    expect(d).toMatchObject({ docId: "doc-1", event: "created", debounceMs: 0 });
    expect(d!.datumAt).toBe(NOW - 60_000);
  });

  test.each(["webpage", "web-page", "bookmark", "browsing-history"])(
    "web ephemera doc type %s never wakes",
    (documentType) => {
      expect(decideWake(insertEvent({ documentType }), CFG, NOW)).toBeNull();
    },
  );

  test.each(["transaction", "activity"])(
    "high-throughput sample doc type %s is left to the daily runs",
    (documentType) => {
      expect(decideWake(insertEvent({ documentType }), CFG, NOW)).toBeNull();
    },
  );

  test("bulk mail (generic metadata marker) never wakes", () => {
    expect(decideWake(insertEvent({ metadata: { bulkMail: true } }), CFG, NOW)).toBeNull();
  });

  test("automated-notification mail (generic metadata marker) never wakes", () => {
    // A machine notification (no-reply / Auto-Submitted) carries no
    // unsubscribe signal — the generic automatedSender marker is what gates it.
    expect(decideWake(insertEvent({ metadata: { automatedSender: true } }), CFG, NOW)).toBeNull();
  });

  test("actionable-transactional override: a promoted due/scheduled date wakes despite bulkMail + automatedSender", () => {
    // A booking / invoice confirmation from a no-reply, bulk-flagged sender that
    // would otherwise be dropped — but it carries a typed dueAt (the #1168
    // promotion), the transactional signal that makes it worth a run.
    expect(
      decideWake(
        insertEvent({ metadata: { automatedSender: true, bulkMail: true, dueAt: "2026-07-10" } }),
        CFG,
        NOW,
      ),
    ).not.toBeNull();
    // A promoted scheduledAt alone overrides too.
    expect(
      decideWake(
        insertEvent({ metadata: { automatedSender: true, scheduledAt: "2026-07-10T09:00:00Z" } }),
        CFG,
        NOW,
      ),
    ).not.toBeNull();
  });

  test("the override bypasses ONLY the bulk/automated gates — recency, rolling-aggregate still apply", () => {
    // A stale promoted-date automated doc is still dropped by the recency gate.
    expect(
      decideWake(
        insertEvent({
          metadata: { automatedSender: true, dueAt: "2026-07-10" },
          sourceCreatedAt: new Date(NOW - 30 * 24 * 60 * 60_000).toISOString(),
          sourceUpdatedAt: new Date(NOW - 30 * 24 * 60 * 60_000).toISOString(),
        }),
        CFG,
        NOW,
      ),
    ).toBeNull();
    // A rolling aggregate with a promoted date is still batched, not woken.
    expect(
      decideWake(
        insertEvent({ metadata: { rollingAggregate: true, dueAt: "2026-07-10" } }),
        CFG,
        NOW,
      ),
    ).toBeNull();
  });

  test("a genuine personal email (a real sender, no automated marker) still wakes", () => {
    const d = decideWake(
      insertEvent({
        metadata: {},
        people: [{ role: "sender", personId: null, name: "Maya", emails: ["maya@example.com"] }],
      }),
      CFG,
      NOW,
    );
    expect(d).not.toBeNull();
    expect(d).toMatchObject({ event: "created", debounceMs: 0 });
  });

  test("rolling-aggregate summary (generic metadata marker) never wakes — left to the daily batch", () => {
    expect(
      decideWake(
        insertEvent({ documentType: "summary", metadata: { rollingAggregate: true } }),
        CFG,
        NOW,
      ),
    ).toBeNull();
  });

  test("low-signal document (generic metadata marker) never wakes — e.g. a caption-less, text-less photo", () => {
    expect(
      decideWake(insertEvent({ documentType: "photo", metadata: { lowSignal: true } }), CFG, NOW),
    ).toBeNull();
  });

  test("attachments are eligible", () => {
    const d = decideWake(insertEvent({ documentType: "attachment" }), CFG, NOW);
    expect(d).toMatchObject({ event: "created", debounceMs: 0 });
  });

  test("documents without a documentType are eligible (default-process)", () => {
    expect(decideWake(insertEvent({ documentType: null }), CFG, NOW)).not.toBeNull();
  });

  test("recency gate: backfilled old data never wakes (source timestamp, not ingest time)", () => {
    const old = new Date(NOW - 30 * 24 * 60 * 60_000).toISOString();
    // Ingested right now — only the SOURCE timestamps are old.
    expect(
      decideWake(insertEvent({ sourceCreatedAt: old, sourceUpdatedAt: old }), CFG, NOW),
    ).toBeNull();
  });

  test("recency gate: future-dated datum (clock skew) is live", () => {
    const future = new Date(NOW + 60 * 60_000).toISOString();
    expect(
      decideWake(insertEvent({ sourceCreatedAt: future, sourceUpdatedAt: future }), CFG, NOW),
    ).not.toBeNull();
  });

  test("recency gate: unparsable source timestamps fail closed", () => {
    expect(
      decideWake(
        insertEvent({ sourceCreatedAt: "not-a-date", sourceUpdatedAt: "also-not" }),
        CFG,
        NOW,
      ),
    ).toBeNull();
  });

  test("recency gate falls back to sourceCreatedAt when sourceUpdatedAt is unparsable", () => {
    const d = decideWake(
      insertEvent({
        sourceUpdatedAt: "garbage",
        sourceCreatedAt: new Date(NOW - 1_000).toISOString(),
      }),
      CFG,
      NOW,
    );
    expect(d).not.toBeNull();
    expect(d!.datumAt).toBe(NOW - 1_000);
  });

  test("conversation events use the conversation debounce (insert and update)", () => {
    const ins = decideWake(insertEvent({ documentType: "conversation" }), CFG, NOW);
    expect(ins).toMatchObject({ debounceMs: CFG.conversationDebounceMs });
    const upd = decideWake(updateEvent({ documentType: "conversation" }), CFG, NOW);
    expect(upd).toMatchObject({ debounceMs: CFG.conversationDebounceMs, event: "updated" });
  });

  test("a threaded email is conversation-like: conversation debounce + ceiling + thread key", () => {
    // An email carries a generic metadata.extra.threadId — the same thread
    // convention the link graph keys on. It debounces like a conversation and
    // folds on a source-scoped thread key (not the per-document key), so a
    // burst of same-thread arrivals batches into one run.
    const d = decideWake(
      insertEvent({
        id: "email-1",
        sourceId: "gmail:maya@example.com",
        documentType: "email",
        metadata: { extra: { threadId: "thread-xyz" } },
      }),
      CFG,
      NOW,
    );
    expect(d).toMatchObject({
      docId: "email-1",
      debounceMs: CFG.conversationDebounceMs,
      maxDeferMs: CFG.conversationMaxDeferMs,
      threadKey: "gmail:maya@example.com:thread-xyz",
    });
  });

  test("a non-threaded email keeps the per-document (no thread key) behavior", () => {
    const d = decideWake(insertEvent({ documentType: "email", metadata: {} }), CFG, NOW);
    expect(d).not.toBeNull();
    expect(d!.threadKey).toBeUndefined();
    expect(d!.debounceMs).toBe(0); // fresh insert, no debounce
  });

  test("a conversation document is NOT rerouted onto a thread key (already collapses per-doc)", () => {
    // Even if a conversation doc carried a threadId, it stays on the per-doc
    // key — a single conversation document already coalesces its own updates.
    const d = decideWake(
      insertEvent({ documentType: "conversation", metadata: { extra: { threadId: "t-1" } } }),
      CFG,
      NOW,
    );
    expect(d).toMatchObject({ debounceMs: CFG.conversationDebounceMs });
    expect(d!.threadKey).toBeUndefined();
  });

  test("document updates use the per-document update debounce and capture the diff", () => {
    const d = decideWake(updateEvent({ documentType: "file" }), CFG, NOW);
    expect(d).toMatchObject({
      event: "updated",
      debounceMs: CFG.documentUpdateDebounceMs,
      captureDiff: true,
    });
  });

  test("metadata-only updates (content unchanged) never wake", () => {
    expect(
      decideWake(updateEvent({ documentType: "file" }, { contentChanged: false }), CFG, NOW),
    ).toBeNull();
  });
});

describe("explicitly-addressed documents (generic addressedToAgent marker)", () => {
  const entry = (id: string, updatedAt = "2026-07-02T11:59:00.000Z") => ({
    id,
    capturedAt: "2026-07-02T11:58:00.000Z",
    updatedAt,
    capturedTimeZoneId: "Europe/London",
  });

  test("an insert wakes immediately: zero debounce, zero defer ceiling, no thread key", () => {
    const d = decideWake(insertEvent({ metadata: { addressedToAgent: true } }), CFG, NOW);
    expect(d).toMatchObject({
      docId: "doc-1",
      event: "created",
      debounceMs: 0,
      maxDeferMs: 0,
      captureDiff: false,
    });
    expect(d!.threadKey).toBeUndefined();
  });

  test("an update with contentChanged wakes immediately and captures the diff", () => {
    const d = decideWake(updateEvent({ metadata: { addressedToAgent: true } }), CFG, NOW);
    expect(d).toMatchObject({
      event: "updated",
      debounceMs: 0,
      maxDeferMs: 0,
      captureDiff: true,
    });
  });

  test("attributes only added or edited addressed entry ids", () => {
    const event = updateEvent({
      metadata: {
        addressedToAgent: true,
        addressedEntries: [
          entry("unchanged"),
          entry("edited", "2026-07-02T12:00:00.000Z"),
          entry("added"),
        ],
      },
    });
    event.before = {
      ...event.before!,
      metadata: {
        addressedToAgent: true,
        addressedEntries: [entry("unchanged"), entry("edited")],
      },
    };
    expect(decideWake(event, CFG, NOW)?.changedAddressedEntryIds).toEqual(["edited", "added"]);
  });

  test("an update without contentChanged still drops (metadata-only churn)", () => {
    expect(
      decideWake(
        updateEvent({ metadata: { addressedToAgent: true } }, { contentChanged: false }),
        CFG,
        NOW,
      ),
    ).toBeNull();
  });

  test("the marker bypasses the bulk-mail / automated-sender / low-signal metadata gates", () => {
    const d = decideWake(
      insertEvent({
        metadata: {
          addressedToAgent: true,
          bulkMail: true,
          automatedSender: true,
          lowSignal: true,
          rollingAggregate: true,
        },
      }),
      CFG,
      NOW,
    );
    expect(d).toMatchObject({ event: "created", debounceMs: 0 });
  });

  test("the marker bypasses the daily-batch doc-type gate", () => {
    const d = decideWake(
      insertEvent({ documentType: "transaction", metadata: { addressedToAgent: true } }),
      CFG,
      NOW,
    );
    expect(d).toMatchObject({ event: "created", debounceMs: 0 });
  });

  test("the marker bypasses the web-ephemera skip set and the recency gate", () => {
    const old = new Date(NOW - 30 * 24 * 60 * 60_000).toISOString();
    const d = decideWake(
      insertEvent({
        documentType: "webpage",
        metadata: { addressedToAgent: true },
        sourceCreatedAt: old,
        sourceUpdatedAt: old,
      }),
      CFG,
      NOW,
    );
    expect(d).toMatchObject({ event: "created", debounceMs: 0 });
    expect(d!.datumAt).toBe(Date.parse(old));
  });

  test("the marker does NOT bypass the self-trigger guard", () => {
    expect(
      decideWake(
        insertEvent({ sourceId: OPEN_LOOP_SOURCE_ID, metadata: { addressedToAgent: true } }),
        CFG,
        NOW,
      ),
    ).toBeNull();
  });
});

describe("self-trigger guard (criterion 10)", () => {
  test("documents from the open-loops system source never wake the agent", () => {
    expect(
      decideWake(
        insertEvent({ sourceId: OPEN_LOOP_SOURCE_ID, documentType: "open-loop" }),
        CFG,
        NOW,
      ),
    ).toBeNull();
  });

  test("open-loop typed documents never wake the agent regardless of source id", () => {
    expect(decideWake(insertEvent({ documentType: "open-loop" }), CFG, NOW)).toBeNull();
  });

  test("agent transcripts never wake the agent", () => {
    // Half of an omnesis-chat transcript is the agent's own prose, itself
    // derived from the corpus, so a run over one derives cognitive state from
    // cognitive state.
    expect(
      decideWake(
        insertEvent({
          sourceId: "omnesis-chat",
          providerId: "system",
          documentType: "conversation",
        }),
        CFG,
        NOW,
      ),
    ).toBeNull();
  });

  test("a real messaging conversation still wakes the agent", () => {
    // The transcript is gated by source id, never by its `conversation` type —
    // every messaging source emits that type, and gating it would deafen the
    // engine to the operator's actual messages.
    expect(
      decideWake(
        insertEvent({
          sourceId: "whatsapp-messages:+15550100123",
          providerId: "whatsapp",
          documentType: "conversation",
        }),
        CFG,
        NOW,
      ),
    ).not.toBeNull();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderConversationDay } from "@omnesis/core";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import {
  createAgentMessagesTables,
  insertAgentMessage,
  listBucketMessages,
  type AgentMessageRow,
  type Bucket,
} from "./storage.js";
import { bootAgentConversations, type PushMessageInput } from "./wiring.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  createAgentMessagesTables(db);
  return db;
}

function row(over: Partial<AgentMessageRow> = {}): AgentMessageRow {
  return {
    id: over.id ?? "id-1",
    harness: "openclaw",
    channel: "whatsapp",
    chatId: "peer-1",
    chatName: "Assistant",
    chatType: "dm",
    day: "2026-07-20",
    role: "user",
    text: "hi",
    occurredAt: "2026-07-20T09:00:00.000Z",
    provenance: "harness-pushed",
    ...over,
  };
}

describe("agent_messages storage", () => {
  let db: Database.Database;
  beforeEach(() => (db = makeDb()));
  afterEach(() => db.close());

  it("dedups on id (idempotent re-push)", () => {
    expect(insertAgentMessage(db, row())).toBe(true);
    expect(insertAgentMessage(db, row())).toBe(false);
    const bucket: Bucket = {
      harness: "openclaw",
      channel: "whatsapp",
      chatId: "peer-1",
      day: "2026-07-20",
    };
    expect(listBucketMessages(db, bucket)).toHaveLength(1);
  });

  it("lists a bucket in occurrence order", () => {
    insertAgentMessage(
      db,
      row({ id: "b", text: "second", occurredAt: "2026-07-20T09:05:00.000Z" }),
    );
    insertAgentMessage(db, row({ id: "a", text: "first", occurredAt: "2026-07-20T09:00:00.000Z" }));
    const bucket: Bucket = {
      harness: "openclaw",
      channel: "whatsapp",
      chatId: "peer-1",
      day: "2026-07-20",
    };
    expect(listBucketMessages(db, bucket).map((m) => m.text)).toEqual(["first", "second"]);
  });
});

/** Fake WriteGate exposing only appendAgentMessage, backed by the real store. */
function fakeWriteGate(db: Database.Database) {
  return {
    appendAgentMessage: async (m: AgentMessageRow) => insertAgentMessage(db, m),
    setSourceMeta: async () => {},
  } as unknown as Parameters<typeof bootAgentConversations>[0]["writeGate"];
}

describe("bootAgentConversations — ingest → projection", () => {
  let db: Database.Database;
  let ingested: DocumentInput[][];
  let deleted: Array<{ providerId: string; sourceId: string; externalIds: string[] }>;

  function boot() {
    return bootAgentConversations({
      writeGate: fakeWriteGate(db),
      readDb: db,
      ingest: async (docs) => {
        ingested.push(docs);
      },
      deleteByIds: async (providerId, sourceId, externalIds) => {
        deleted.push({ providerId, sourceId, externalIds });
      },
      debounceMs: 0,
    });
  }

  const msg = (over: Partial<PushMessageInput> = {}): PushMessageInput => ({
    harness: "openclaw",
    channel: "whatsapp",
    chatId: "peer-1",
    chatName: "Assistant",
    chatType: "dm",
    role: "user",
    text: "what's my flight tomorrow?",
    occurredAt: "2026-07-20T09:14:00.000Z",
    ...over,
  });

  beforeEach(() => {
    db = makeDb();
    ingested = [];
    deleted = [];
  });
  afterEach(() => db.close());

  it("projects a pushed batch into a byte-identical day document", async () => {
    const runtime = boot();
    const messages = [
      msg({
        id: "m1",
        role: "user",
        text: "what's my flight tomorrow?",
        occurredAt: "2026-07-20T09:14:00.000Z",
      }),
      msg({
        id: "m2",
        role: "assistant",
        text: "You're on flight XY123 at 08:40.",
        occurredAt: "2026-07-20T09:14:20.000Z",
      }),
    ];
    const res = await runtime.ingest(messages);
    expect(res).toEqual({ accepted: 2, buckets: 1 });
    await runtime.flushAll();

    expect(ingested).toHaveLength(1);
    const doc = ingested[0][0];
    expect(doc.externalId).toBe("whatsapp:peer-1:2026-07-20");

    // Byte-identical to the shared reader renderer over the same turns — this
    // is the whole point of server-side projection.
    const expected = renderConversationDay({
      chat: { platform: "whatsapp", chatId: "peer-1", chatName: "Assistant", chatType: "dm" },
      dayKey: "2026-07-20",
      messages: [
        {
          role: "user",
          text: "what's my flight tomorrow?",
          atMs: Date.parse("2026-07-20T09:14:00.000Z"),
        },
        {
          role: "assistant",
          text: "You're on flight XY123 at 08:40.",
          atMs: Date.parse("2026-07-20T09:14:20.000Z"),
        },
      ],
      providerId: ProviderId("openclaw"),
      sourceId: SourceId("openclaw:local"),
      agentName: "OpenClaw",
      harnessId: "openclaw",
    });
    expect(doc.contentHash).toBe(expected.contentHash);
    expect(doc.content).toBe(expected.content);
    expect(doc.metadata.extra).toMatchObject({ provenance: "harness-pushed", channel: "whatsapp" });
    runtime.dispose();
  });

  it("a re-pushed batch is idempotent (dedup, no second projection change)", async () => {
    const runtime = boot();
    const batch = [msg({ id: "m1" })];
    const first = await runtime.ingest(batch);
    expect(first.accepted).toBe(1);
    const second = await runtime.ingest(batch);
    expect(second.accepted).toBe(0);
    await runtime.flushAll();
    runtime.dispose();
  });

  it("synthesizes a stable id when the push omits one", async () => {
    const runtime = boot();
    const withoutId = msg({ id: undefined });
    expect((await runtime.ingest([withoutId])).accepted).toBe(1);
    // Same content again → same synthesized id → dedup.
    expect((await runtime.ingest([withoutId])).accepted).toBe(0);
    await runtime.flushAll();
    runtime.dispose();
  });

  it("splits distinct harnesses / channels / days into distinct documents", async () => {
    const runtime = boot();
    await runtime.ingest([
      msg({
        id: "a",
        harness: "openclaw",
        channel: "whatsapp",
        chatId: "p",
        occurredAt: "2026-07-20T09:00:00Z",
      }),
      msg({
        id: "b",
        harness: "hermes",
        channel: "slack",
        chatId: "C1",
        occurredAt: "2026-07-20T09:00:00Z",
      }),
      msg({
        id: "c",
        harness: "openclaw",
        channel: "whatsapp",
        chatId: "p",
        occurredAt: "2026-07-19T09:00:00Z",
      }),
    ]);
    await runtime.flushAll();
    const ids = ingested
      .flat()
      .map((d) => d.externalId)
      .sort();
    expect(ids).toEqual(["slack:C1:2026-07-20", "whatsapp:p:2026-07-19", "whatsapp:p:2026-07-20"]);
    runtime.dispose();
  });
});

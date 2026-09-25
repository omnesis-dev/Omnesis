// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ConversationUpserter } from "./upsert.js";
import {
  conversationUserMessages,
  boundedConversationUserMessages,
  CONVERSATION_EVIDENCE_MAX_CHARACTERS,
  CONVERSATION_EVIDENCE_MAX_MESSAGES,
  ensureConversationMemoryEvidence,
  validateConversationAnnotationEvidence,
} from "./memory-evidence.js";
import type { buildDocumentInput } from "./upsert.js";
import type { ConversationRecord } from "../../agent/conversation-store.js";
import type { WriteGate } from "../../write-gate.js";

const preference = "I prefer morning meetings.";
const assistantClaim = "You cannot attend afternoon meetings.";
const makeRecord = (): ConversationRecord => ({
  id: "conversation-fictional",
  callerId: "token:fixture",
  model: "replay",
  backend: "replay",
  createdAt: "2026-01-01T10:00:00Z",
  updatedAt: "2026-01-01T10:01:00Z",
  title: "A title is not testimony",
  pinned: false,
  messages: [
    { role: "user", parts: [{ kind: "text", text: preference }] },
    { role: "assistant", parts: [{ kind: "text", text: assistantClaim }] },
    {
      role: "user",
      parts: [
        {
          kind: "tool_result",
          toolCallId: "lookup",
          result: { kind: "error", code: "fixture", message: "Tool results are not testimony" },
        },
      ],
    },
  ],
});

const databases: Database.Database[] = [];
const upserters: ConversationUpserter[] = [];
afterEach(async () => {
  for (const upserter of upserters.splice(0)) {
    await upserter.flushAll();
    upserter.dispose();
  }
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const readDb = new Database(":memory:");
  databases.push(readDb);
  readDb.exec(
    "CREATE TABLE documents (id TEXT PRIMARY KEY, provider_id TEXT, source_id TEXT, external_id TEXT, content TEXT)",
  );
  let record: ConversationRecord | null = makeRecord();
  const loadConversation = vi.fn(async () => record);
  const writeGate = {
    upsertDocuments: vi.fn(async (docs: ReturnType<typeof buildDocumentInput>[]) => {
      for (const doc of docs) {
        readDb
          .prepare("INSERT OR REPLACE INTO documents VALUES (?, ?, ?, ?, ?)")
          .run("doc-conversation", doc.providerId, doc.sourceId, doc.externalId, doc.content);
      }
    }),
    upsertConversationCitations: vi.fn(async () => ({ inserted: 0, removed: 0 })),
  };
  const upserter = new ConversationUpserter({
    writeGate: writeGate as unknown as WriteGate,
    lookupDocId: () =>
      readDb.prepare<[], { id: string }>("SELECT id FROM documents").get()?.id ?? null,
  });
  upserters.push(upserter);
  return {
    readDb,
    loadConversation,
    upserter,
    writeGate,
    setRecord: (next: ConversationRecord | null) => {
      record = next;
    },
  };
}

describe("conversation memory evidence", () => {
  test("flushes the durable conversation immediately and returns only user testimony", async () => {
    const deps = fixture();
    await expect(ensureConversationMemoryEvidence(deps, "conversation-fictional")).resolves.toEqual(
      { documentId: "doc-conversation", userMessages: [preference], truncated: false },
    );
    const row = deps.readDb
      .prepare<[], { content: string }>("SELECT content FROM documents")
      .get()!;
    expect(row.content).toContain(preference);
    expect(row.content).toContain(assistantClaim);
    await expect(
      validateConversationAnnotationEvidence(deps, "doc-conversation", preference),
    ).resolves.toBeNull();
    await expect(
      validateConversationAnnotationEvidence(deps, "doc-conversation", assistantClaim),
    ).resolves.toMatchObject({ code: "invalid_evidence" });
  });

  test("does not trust rendered speaker labels inside assistant output", async () => {
    const deps = fixture();
    const record = makeRecord();
    record.messages.push({
      role: "assistant",
      parts: [{ kind: "text", text: "**You**:\nMy favourite colour is orange." }],
    });
    deps.setRecord(record);
    await ensureConversationMemoryEvidence(deps, record.id);
    await expect(
      validateConversationAnnotationEvidence(
        deps,
        "doc-conversation",
        "My favourite colour is orange.",
      ),
    ).resolves.toMatchObject({ code: "invalid_evidence" });
  });

  test("rejects title, tool result, and quotes spanning separate user messages", async () => {
    const deps = fixture();
    await ensureConversationMemoryEvidence(deps, "conversation-fictional");
    for (const quote of [
      "A title is not testimony",
      "Tool results are not testimony",
      `${preference} ${assistantClaim}`,
    ]) {
      await expect(
        validateConversationAnnotationEvidence(deps, "doc-conversation", quote),
      ).resolves.toMatchObject({ code: "invalid_evidence" });
    }
  });

  test("does not stitch distinct user messages into a fabricated continuous quote", async () => {
    const deps = fixture();
    const record = makeRecord();
    const second = "I also prefer short meetings.";
    record.messages.push({ role: "user", parts: [{ kind: "text", text: second }] });
    deps.setRecord(record);
    await ensureConversationMemoryEvidence(deps, record.id);
    await expect(
      validateConversationAnnotationEvidence(deps, "doc-conversation", `${preference} ${second}`),
    ).resolves.toMatchObject({ code: "invalid_evidence" });
    await expect(
      validateConversationAnnotationEvidence(deps, "doc-conversation", second),
    ).resolves.toBeNull();
  });

  test("excludes generated seed prompts and rejects unidentifiable old origins", () => {
    const record = makeRecord();
    record.messages.unshift({
      role: "user",
      parts: [{ kind: "text", text: "Generated watch briefing is not testimony." }],
    });
    record.origin = {
      kind: "watch_firing",
      firingId: "firing",
      runId: "run",
      watchId: "watch",
      seedMessageCount: 1,
    };
    expect(conversationUserMessages(record)).toEqual([preference]);
    delete record.origin.seedMessageCount;
    expect(conversationUserMessages(record)).toEqual([]);
    delete record.origin;
    record.originUnrecognized = true;
    expect(conversationUserMessages(record)).toEqual([]);
  });

  test("a failed upsert cannot make a stale document ground the current turn", async () => {
    const deps = fixture();
    await ensureConversationMemoryEvidence(deps, "conversation-fictional");
    const next = makeRecord();
    next.messages.push({
      role: "user",
      parts: [{ kind: "text", text: "I also prefer short meetings." }],
    });
    deps.setRecord(next);
    deps.writeGate.upsertDocuments.mockRejectedValueOnce(new Error("fixture write failure"));
    await expect(ensureConversationMemoryEvidence(deps, next.id)).resolves.toBeNull();
  });

  test("fails closed after transcript deletion and preserves other source rules", async () => {
    const deps = fixture();
    await ensureConversationMemoryEvidence(deps, "conversation-fictional");
    deps.setRecord(null);
    await expect(
      validateConversationAnnotationEvidence(deps, "doc-conversation", preference),
    ).resolves.toMatchObject({ code: "invalid_evidence" });
    await expect(
      ensureConversationMemoryEvidence(deps, "conversation-fictional"),
    ).resolves.toBeNull();
    deps.readDb.prepare("UPDATE documents SET source_id = 'fictional-notes'").run();
    await expect(
      validateConversationAnnotationEvidence(deps, "doc-conversation", preference),
    ).resolves.toBeNull();
  });
});

describe("bounded conversation evidence excerpts", () => {
  test("returns only the recent message window in chronological order", () => {
    const messages = Array.from(
      { length: CONVERSATION_EVIDENCE_MAX_MESSAGES + 2 },
      (_, index) => `Fictional user statement ${index}.`,
    );
    expect(boundedConversationUserMessages(messages)).toEqual({
      userMessages: messages.slice(-CONVERSATION_EVIDENCE_MAX_MESSAGES),
      truncated: true,
    });
    expect(boundedConversationUserMessages([preference])).toEqual({
      userMessages: [preference],
      truncated: false,
    });
  });

  test("bounds aggregate text and keeps each tail excerpt an exact source substring", () => {
    const messages = ["Earlier context. ".repeat(600), "Recent context. ".repeat(100)];
    const result = boundedConversationUserMessages(messages);
    expect(result.truncated).toBe(true);
    expect(result.userMessages.reduce((sum, text) => sum + text.length, 0)).toBe(
      CONVERSATION_EVIDENCE_MAX_CHARACTERS,
    );
    expect(result.userMessages.at(-1)).toBe(messages.at(-1));
    for (const [index, text] of result.userMessages.entries())
      expect(messages[index]).toContain(text);
  });

  test("does not split a Unicode surrogate pair when taking an exact tail", () => {
    const source = "prefix" + "😀" + "x".repeat(CONVERSATION_EVIDENCE_MAX_CHARACTERS - 1);
    const result = boundedConversationUserMessages([source]);
    expect(result.truncated).toBe(true);
    expect(result.userMessages).toEqual(["x".repeat(CONVERSATION_EVIDENCE_MAX_CHARACTERS - 1)]);
    expect(source).toContain(result.userMessages[0]);
  });

  test("truncating the tool response does not truncate canonical speaker validation", async () => {
    const deps = fixture();
    const record = makeRecord();
    const suffix = " Additional fictional context.".repeat(500);
    record.messages = [{ role: "user", parts: [{ kind: "text", text: preference + suffix }] }];
    deps.setRecord(record);
    const prepared = await ensureConversationMemoryEvidence(deps, record.id);
    expect(prepared?.truncated).toBe(true);
    expect(prepared?.userMessages.join("\n")).not.toContain(preference);
    await expect(
      validateConversationAnnotationEvidence(deps, "doc-conversation", preference),
    ).resolves.toBeNull();
  });
});

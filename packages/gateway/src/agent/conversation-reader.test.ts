// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";

import { StoredConversationReader } from "./conversation-reader.js";
import type {
  ConversationRecord,
  ConversationStore,
  ConversationSummary,
} from "./conversation-store.js";

function summary(id: string, updatedAt: string): ConversationSummary {
  return {
    id,
    title: id,
    model: "fictional-model",
    backend: "http",
    createdAt: updatedAt,
    updatedAt,
    messageCount: 2,
    pinned: false,
  };
}

function storeWith(record: ConversationRecord | null): ConversationStore {
  return {
    save: vi.fn(async () => {}),
    load: vi.fn(async () => record),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => false),
    setPinned: vi.fn(async () => false),
  };
}

describe("StoredConversationReader", () => {
  it("keeps a list cursor valid when the active summary source changes", async () => {
    let summaries = [
      summary("newest", "2026-01-03T00:00:00.000Z"),
      summary("middle", "2026-01-02T00:00:00.000Z"),
      summary("oldest", "2026-01-01T00:00:00.000Z"),
    ];
    const reader = new StoredConversationReader(storeWith(null), async () => summaries);

    const first = await reader.listConversationPage({ limit: 1 });
    summaries = [summary("replacement", "2026-01-04T00:00:00.000Z")];
    const second = await reader.listConversationPage({ limit: 1, cursor: first.nextCursor! });

    expect(first.conversations.map((item) => item.id)).toEqual(["newest"]);
    expect(second.conversations.map((item) => item.id)).toEqual(["middle"]);
  });

  it("normalizes dangling HTTP turns and hides anchored seed messages", async () => {
    const record: ConversationRecord = {
      id: "anchored",
      callerId: "token:example",
      model: "fictional-model",
      backend: "http",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      title: "Visible question",
      pinned: false,
      origin: {
        kind: "brief",
        briefId: "brief-example",
        runId: "run-example",
        seedMessageCount: 2,
      },
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Hidden seed question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Hidden seed answer" }] },
        { role: "user", parts: [{ kind: "text", text: "Visible question" }] },
      ],
    };
    const reader = new StoredConversationReader(storeWith(record));

    const page = await reader.listConversationMessages("anchored", { limit: 10 });

    expect(page?.messages).toHaveLength(2);
    expect(page?.messages[0]).toMatchObject({ role: "user" });
    expect(page?.messages[1]).toMatchObject({ role: "assistant" });
    expect(page).toMatchObject({ model: "fictional-model", backend: "http", messageCount: 2 });
  });
});

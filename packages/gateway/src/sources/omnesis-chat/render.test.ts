// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";

import { renderConversation } from "./render.js";
import type { ConversationRecord } from "../../agent/conversation-store.js";

function makeRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: "s_abc",
    callerId: "token:test",
    model: "claude-test",
    backend: "replay",
    createdAt: "2026-05-23T10:14:00.000Z",
    updatedAt: "2026-05-23T10:20:00.000Z",
    title: "Paris apartment plans",
    pinned: false,
    messages: [],
    ...overrides,
  };
}

describe("renderConversation — body shape", () => {
  test("includes user and assistant text, drops thinking + tool_use + tool_result", () => {
    const { body } = renderConversation(
      makeRecord({
        messages: [
          {
            role: "user",
            parts: [{ kind: "text", text: "What did we figure out about the Riverside quote?" }],
          },
          {
            role: "assistant",
            parts: [
              { kind: "thinking", text: "Hmm, let me search the threads about Riverside…" },
              {
                kind: "tool_use",
                toolCallId: "tc1",
                tool: "search_documents",
                args: { query: "Riverside quote" },
              },
              {
                kind: "text",
                text: "The latest quote is £2,400/mo with a 6-month break clause.",
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                kind: "tool_result",
                toolCallId: "tc1",
                result: { kind: "search.results", results: [] },
              },
              { kind: "text", text: "Great — draft a yes to her." },
            ],
          },
        ],
      }),
    );

    expect(body).toContain("# Paris apartment plans");
    expect(body).toContain("**You** (2026-05-23):");
    expect(body).toContain("What did we figure out about the Riverside quote?");
    expect(body).toContain("**Omnesis**:");
    expect(body).toContain("The latest quote is £2,400/mo with a 6-month break clause.");
    expect(body).toContain("Great — draft a yes to her.");
    // Excluded blocks
    expect(body).not.toContain("Hmm, let me search");
    expect(body).not.toContain("search_documents");
    expect(body).not.toContain("search.results");
  });

  test("drops empty turns and uses (untitled) fallback when title is empty", () => {
    const { body } = renderConversation(
      makeRecord({
        title: "",
        messages: [
          { role: "user", parts: [{ kind: "text", text: "   " }] }, // whitespace-only — drop
          { role: "assistant", parts: [{ kind: "text", text: "Hi" }] },
        ],
      }),
    );
    expect(body.startsWith("# (untitled)")).toBe(true);
    // Whitespace-only user turn must NOT produce a "**You**:" header.
    expect(body).not.toContain("**You**");
    expect(body).toContain("**Omnesis**:\nHi");
  });

  test("date stamp appears on the first user turn only", () => {
    const { body } = renderConversation(
      makeRecord({
        messages: [
          { role: "user", parts: [{ kind: "text", text: "First question" }] },
          { role: "assistant", parts: [{ kind: "text", text: "Answer A" }] },
          { role: "user", parts: [{ kind: "text", text: "Follow-up" }] },
        ],
      }),
    );
    const matches = body.match(/\*\*You\*\* \(2026-05-23\)/g);
    expect(matches?.length ?? 0).toBe(1);
    expect(body).toContain("**You**:\nFollow-up");
  });

  test("drops the breadcrumb a stopped or failed turn ends on and keeps the answer before it", () => {
    const { body } = renderConversation(
      makeRecord({
        messages: [
          { role: "user", parts: [{ kind: "text", text: "Summarize the Riverside thread." }] },
          {
            role: "assistant",
            parts: [
              {
                kind: "text",
                text: "The quote went up.\n\nModel request failed: canceled: You stopped this reply.",
              },
            ],
          },
          { role: "user", parts: [{ kind: "text", text: "Try again." }] },
          {
            role: "assistant",
            parts: [
              {
                kind: "text",
                text: "Model request failed: http_api_error: The provider has no such model.",
              },
            ],
          },
          { role: "user", parts: [{ kind: "text", text: "What does this log line mean?" }] },
          {
            role: "assistant",
            parts: [
              {
                kind: "text",
                text: "That line — Model request failed: http_api_error: no such model — means the id is wrong.",
              },
            ],
          },
        ],
      }),
    );

    expect(body).toContain("The quote went up.");
    expect(body).not.toContain("You stopped this reply.");
    expect(body).not.toContain("The provider has no such model.");
    // A turn that produced nothing before it died contributes no assistant entry.
    expect(body.match(/\*\*Omnesis\*\*:/g)).toHaveLength(2);
    // Prose that quotes the phrase mid-sentence is an answer, and stays.
    expect(body).toContain(
      "That line — Model request failed: http_api_error: no such model — means the id is wrong.",
    );
  });
});

describe("renderConversation — citation harvest", () => {
  test("collects annotate.recorded tool results, preserves order, ignores other kinds", () => {
    const { citations } = renderConversation(
      makeRecord({
        messages: [
          { role: "user", parts: [{ kind: "text", text: "Q1" }] },
          {
            role: "assistant",
            parts: [
              { kind: "tool_use", toolCallId: "tc1", tool: "annotate", args: { documentId: "d1" } },
              { kind: "text", text: "A1" },
            ],
          },
          {
            role: "user",
            parts: [
              {
                kind: "tool_result",
                toolCallId: "tc1",
                result: {
                  kind: "annotate.recorded",
                  documentId: "d1",
                  ref: { sourceType: "email" },
                  quote: "hold the quote",
                  quoteAuthor: "Sarah",
                  note: "confirms hold",
                },
              },
              {
                kind: "tool_result",
                toolCallId: "tc2",
                // search results — must be ignored
                result: { kind: "search.results", results: [] },
              },
              {
                kind: "tool_result",
                toolCallId: "tc3",
                result: {
                  kind: "annotate.recorded",
                  documentId: "d2",
                  ref: { sourceType: "calendar" },
                },
              },
            ],
          },
        ],
      }),
    );

    expect(citations).toEqual([
      {
        kind: "document",
        documentId: "d1",
        quote: "hold the quote",
        quoteAuthor: "Sarah",
        note: "confirms hold",
      },
      {
        kind: "document",
        documentId: "d2",
        quote: undefined,
        quoteAuthor: undefined,
        note: undefined,
      },
    ]);
  });

  test("fans an annotate.batch (annotate_many) result into one citation per child", () => {
    const { citations } = renderConversation(
      makeRecord({
        messages: [
          { role: "user", parts: [{ kind: "text", text: "Q" }] },
          {
            role: "assistant",
            parts: [
              {
                kind: "tool_use",
                toolCallId: "tc1",
                tool: "annotate_many",
                args: { annotations: [{ documentId: "d1" }, { documentId: "d2" }] },
              },
              { kind: "text", text: "A" },
            ],
          },
          {
            role: "user",
            parts: [
              {
                kind: "tool_result",
                toolCallId: "tc1",
                result: {
                  kind: "annotate.batch",
                  items: [
                    {
                      kind: "annotate.recorded",
                      documentId: "d1",
                      ref: { sourceType: "email" },
                      quote: "quarterly review moved",
                      quoteAuthor: "Priya",
                    },
                    // A failed child in the middle is skipped, not fatal.
                    { kind: "error", code: "batch_child_failed", message: "boom" },
                    {
                      kind: "annotate.recorded",
                      documentId: "d2",
                      ref: { sourceType: "calendar" },
                      note: "on the shared calendar",
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    expect(citations).toEqual([
      {
        kind: "document",
        documentId: "d1",
        quote: "quarterly review moved",
        quoteAuthor: "Priya",
        note: undefined,
      },
      {
        kind: "document",
        documentId: "d2",
        quote: undefined,
        quoteAuthor: undefined,
        note: "on the shared calendar",
      },
    ]);
  });

  test("harvests a cite_record.recorded result as a record citation", () => {
    const { citations } = renderConversation(
      makeRecord({
        messages: [
          { role: "user", parts: [{ kind: "text", text: "What did I spend at Stellar Sound?" }] },
          { role: "assistant", parts: [{ kind: "text", text: "42.00" }] },
          {
            role: "user",
            parts: [
              {
                kind: "tool_result",
                toolCallId: "tc1",
                result: {
                  kind: "cite_record.recorded",
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
                  boundDocumentId: null,
                },
              },
            ],
          },
        ],
      }),
    );
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      kind: "record",
      table: "demo_transactions",
      recordKey: "row:demo_transactions:txn-1",
      semanticTime: "2026-05-23T10:00:00.000Z",
      boundDocumentId: null,
    });
  });

  test("annotated snippet does NOT leak into the body", () => {
    const { body } = renderConversation(
      makeRecord({
        messages: [
          { role: "user", parts: [{ kind: "text", text: "Anything from the landlord?" }] },
          { role: "assistant", parts: [{ kind: "text", text: "Sarah confirmed the quote." }] },
          {
            role: "user",
            parts: [
              {
                kind: "tool_result",
                toolCallId: "tc1",
                result: {
                  kind: "annotate.recorded",
                  documentId: "d1",
                  ref: { sourceType: "email" },
                  quote: "SECRET_VERBATIM_SNIPPET",
                  note: "SECRET_NOTE",
                },
              },
            ],
          },
        ],
      }),
    );
    expect(body).not.toContain("SECRET_VERBATIM_SNIPPET");
    expect(body).not.toContain("SECRET_NOTE");
  });

  test("malformed tool results are dropped silently", () => {
    const { citations } = renderConversation(
      makeRecord({
        messages: [
          {
            role: "user",
            parts: [
              {
                kind: "tool_result",
                toolCallId: "tc1",
                // missing documentId
                result: { kind: "annotate.recorded", ref: { sourceType: "x" } } as unknown,
              } as never,
              {
                kind: "tool_result",
                toolCallId: "tc2",
                // documentId not a string
                result: { kind: "annotate.recorded", documentId: 42, ref: {} } as unknown,
              } as never,
            ],
          },
        ],
      }),
    );
    expect(citations).toEqual([]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { chatMessageSchema } from "@omnesis/core";

import { slimPersistedHistory } from "./persist-slim.js";
import type { ChatMessage } from "@omnesis/agent";

type UserMessage = Extract<ChatMessage, { role: "user" }>;

function trailResult(nEvents: number) {
  return {
    kind: "event_trail.built" as const,
    seeds: ["doc:s1"],
    events: Array.from({ length: nEvents }, (_, i) => ({
      at: "2026-03-12T09:00:00Z",
      kind: "seed" as const,
      doc: { documentId: `d${i}`, title: `Doc ${i}`, sourceId: "gmail:u@example.com" },
      attachments: [],
      people: [],
      related: [],
    })),
    truncated: false,
    stats: { visited: nEvents, elapsedMs: 5, maxDepthReached: 1 },
  };
}

describe("slimPersistedHistory", () => {
  it("empties events[] on an event_trail.built result, keeping seeds/stats/truncated", () => {
    const history: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
      { role: "assistant", parts: [{ kind: "text", text: "answer" }] },
      { role: "user", parts: [{ kind: "tool_result", toolCallId: "t1", result: trailResult(54) }] },
    ];
    const slim = slimPersistedHistory(history);
    const part = (slim[2] as UserMessage).parts[0]!;
    expect(part.kind).toBe("tool_result");
    if (part.kind === "tool_result" && part.result.kind === "event_trail.built") {
      expect(part.result.events).toHaveLength(0);
      expect(part.result.seeds).toEqual(["doc:s1"]);
      expect(part.result.truncated).toBe(false);
      expect(part.result.stats?.visited).toBe(54);
    }
  });

  it("clones rather than mutating — the original result keeps its events", () => {
    const original = trailResult(3);
    const history: ChatMessage[] = [
      { role: "user", parts: [{ kind: "tool_result", toolCallId: "t1", result: original }] },
    ];
    const slim = slimPersistedHistory(history);
    expect(original.events).toHaveLength(3); // original object untouched
    const part = (slim[0] as UserMessage).parts[0]!;
    if (part.kind === "tool_result" && part.result.kind === "event_trail.built") {
      expect(part.result.events).toHaveLength(0);
    }
    expect(slim[0]).not.toBe(history[0]); // the changed message is a fresh object
  });

  it("passes messages with no heavy trail through by reference (no needless cloning)", () => {
    const history: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
      { role: "assistant", parts: [{ kind: "text", text: "yo" }] },
    ];
    const slim = slimPersistedHistory(history);
    expect(slim[0]).toBe(history[0]);
    expect(slim[1]).toBe(history[1]);
  });

  it("leaves an already-empty trail untouched (idempotent, same reference)", () => {
    const history: ChatMessage[] = [
      { role: "user", parts: [{ kind: "tool_result", toolCallId: "t1", result: trailResult(0) }] },
    ];
    const slim = slimPersistedHistory(history);
    expect(slim[0]).toBe(history[0]);
  });

  it("slims only the trail part, leaving sibling parts in the same message by reference", () => {
    const text = { kind: "text" as const, text: "here you go" };
    const other = {
      kind: "tool_result" as const,
      toolCallId: "t0",
      result: { kind: "error" as const, code: "x", message: "y" },
    };
    const history: ChatMessage[] = [
      {
        role: "user",
        parts: [text, other, { kind: "tool_result", toolCallId: "t1", result: trailResult(20) }],
      },
    ];
    const parts = (slimPersistedHistory(history)[0] as UserMessage).parts;
    expect(parts[0]).toBe(text); // sibling text — same reference
    expect(parts[1]).toBe(other); // sibling non-trail result — same reference
    const trail = parts[2]!;
    if (trail.kind === "tool_result" && trail.result.kind === "event_trail.built") {
      expect(trail.result.events).toHaveLength(0);
    }
  });

  it("keeps the slimmed result valid against the wire schema (events:[] not dropped)", () => {
    const [slimMsg] = slimPersistedHistory([
      { role: "user", parts: [{ kind: "tool_result", toolCallId: "t1", result: trailResult(80) }] },
    ]);
    // `events` is emptied, not deleted, precisely so the slimmed result still
    // decodes as an `event_trail.built` on reload — parse throws otherwise.
    const parsed = chatMessageSchema.parse(slimMsg);
    if (parsed.role !== "user") throw new Error("expected a user message");
    const part = parsed.parts[0]!;
    if (part.kind !== "tool_result" || part.result.kind !== "event_trail.built") {
      throw new Error("expected an event_trail.built tool_result");
    }
    expect(part.result.events).toHaveLength(0);
    expect(part.result.seeds).toEqual(["doc:s1"]);
  });
});

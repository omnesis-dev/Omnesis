// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
import { reducer, initialState, timelineScopeStart, timelineMessages, visibleMessages, briefTurnBreaks, chatMessagesToTurns } from "./agent-reducer.js";
import { describe, expect, it } from "vitest";

type State = ReturnType<typeof initialState>;
const r: (s: State, a: any) => State = reducer as any;

// One cited document per exchange: the assistant annotates `docId`, so the
// Timeline gains one row for it when the exchange is in scope.
function citedExchange(question: string, docId: string, callId: string) {
  const ref = { documentId: docId, sourceType: "notes", sourceId: "notes:self" };
  return [
    { role: "user", parts: [{ kind: "text", text: question }] },
    {
      role: "assistant",
      parts: [{ kind: "tool_use", toolCallId: callId, tool: "annotate", args: { documentId: docId, note: "cited" } }],
    },
    {
      role: "user",
      parts: [
        {
          kind: "tool_result",
          toolCallId: callId,
          result: { kind: "annotate.recorded", documentId: docId, ref, note: "cited" },
        },
      ],
    },
    { role: "assistant", parts: [{ kind: "text", text: `About ${docId}.` }] },
  ];
}

const brief = (text: string) => ({ role: "assistant", parts: [{ kind: "text", text }] });

// Day one's brief at 0, a cited reply exchange (1–4), day two's brief at 5
// and a cited reply exchange after it (6–9).
const transcript = [
  brief("Good morning. The dentist moved to Thursday."),
  ...citedExchange("Which dentist?", "doc-yesterday", "t1"),
  brief("Good morning. The library books are due Friday."),
  ...citedExchange("Which books?", "doc-today", "t2"),
];

const origin = {
  kind: "daily_brief",
  runId: "run_2",
  briefs: [
    { day: "2026-10-11", messageIndex: 0, messageId: "mb_1" },
    { day: "2026-10-12", messageIndex: 5, messageId: "mb_2" },
  ],
};

describe("Morning brief Timeline scope", () => {
  it("starts at the latest brief's message index", () => {
    expect(timelineScopeStart(origin)).toBe(5);
    expect(timelineScopeStart({ ...origin, briefs: [] })).toBe(0);
    expect(timelineScopeStart({ kind: "watch_firing", firingId: "f", runId: "f", watchId: "w" })).toBe(0);
    expect(timelineScopeStart(null)).toBe(0);
  });

  it("slices a page by absolute position", () => {
    expect(timelineMessages(transcript, 0, origin)).toEqual(transcript.slice(5));
    // A page that already starts after the brief keeps every message.
    expect(timelineMessages(transcript.slice(6), 6, origin)).toEqual(transcript.slice(6));
    // A page that ends before the brief contributes nothing.
    expect(timelineMessages(transcript.slice(0, 5), 0, origin)).toEqual([]);
  });

  it("keeps every day in the transcript", () => {
    expect(visibleMessages(transcript, origin)).toBe(transcript);
  });

  it("builds the Timeline from the latest brief onward when the whole transcript loads", () => {
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-morning",
      model: "demo",
      backend: "replay",
      origin,
      messagesAreVisible: true,
      messageCount: transcript.length,
      messages: transcript,
    });
    expect(Object.keys((s as any).trailAnnotations.byDoc)).toEqual(["doc-today"]);
    // Both days stay readable.
    expect(s.turns.length).toBeGreaterThanOrEqual(4);
    // Inline citation numbering still spans the whole transcript.
    expect((s as any).citationsByDocId.has("doc-yesterday")).toBe(true);
  });

  it("scopes a tail page and an older page by their absolute positions", () => {
    // The first page is the tail from the second exchange of day one onward.
    let s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-morning",
      model: "demo",
      backend: "replay",
      origin,
      messagesAreVisible: true,
      messageCount: transcript.length,
      messagePageInfo: { nextCursor: "older-1" },
      messages: transcript.slice(5),
    });
    expect((s as any).loadedMessageStart).toBe(5);
    expect(Object.keys((s as any).trailAnnotations.byDoc)).toEqual(["doc-today"]);

    s = r(s, {
      kind: "prepend-conversation-history",
      sessionId: "sess-morning",
      pageKey: "older-1",
      pageInfo: { nextCursor: null },
      messagesAreVisible: true,
      messages: transcript.slice(0, 5),
    });
    expect((s as any).loadedMessageStart).toBe(0);
    expect(Object.keys((s as any).trailAnnotations.byDoc)).toEqual(["doc-today"]);
    expect(s.turns[0].parts[0].text).toBe("Good morning. The dentist moved to Thursday.");
  });

  it("leaves other conversations' Timeline unscoped", () => {
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-plain",
      model: "demo",
      backend: "replay",
      messagesAreVisible: true,
      messageCount: transcript.length,
      messages: transcript,
    });
    expect(Object.keys((s as any).trailAnnotations.byDoc).sort()).toEqual(["doc-today", "doc-yesterday"]);
  });
});

const turnTexts = (turns: any[]) =>
  turns.map((turn) => [turn.role, turn.parts.filter((p: any) => p.kind === "text").map((p: any) => p.text).join(" ")]);

describe("each Morning brief is its own turn", () => {
  it("splits two briefs sent back to back", () => {
    const messages = [brief("Day one brief."), brief("Day two brief.")];
    const briefs = {
      kind: "daily_brief",
      runId: "run_2",
      briefs: [
        { day: "2026-10-11", messageIndex: 0, messageId: "mb_1" },
        { day: "2026-10-12", messageIndex: 1, messageId: "mb_2" },
      ],
    };
    expect(turnTexts(chatMessagesToTurns(messages))).toEqual([["assistant", "Day one brief. Day two brief."]]);
    expect(
      turnTexts(chatMessagesToTurns(messages, { turnBreaks: briefTurnBreaks(briefs, 0, messages.length) })),
    ).toEqual([
      ["assistant", "Day one brief."],
      ["assistant", "Day two brief."],
    ]);
  });

  it("starts the next day's brief after a reply exchange", () => {
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-morning",
      model: "demo",
      backend: "replay",
      origin,
      messagesAreVisible: true,
      messageCount: transcript.length,
      messages: transcript,
    });
    expect(turnTexts(s.turns)).toEqual([
      ["assistant", "Good morning. The dentist moved to Thursday."],
      ["user", "Which dentist?"],
      ["assistant", "About doc-yesterday."],
      ["assistant", "Good morning. The library books are due Friday."],
      ["user", "Which books?"],
      ["assistant", "About doc-today."],
    ]);
  });

  it("tags each turn a brief opens with that brief, and only those turns", () => {
    const withSent = {
      ...origin,
      briefs: [origin.briefs[0], { ...origin.briefs[1], sentAt: "2026-10-12T06:02:40.055Z" }],
    };
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-morning",
      model: "demo",
      backend: "replay",
      origin: withSent,
      messagesAreVisible: true,
      messageCount: transcript.length,
      messages: transcript,
    });
    expect(s.turns.map((turn: { brief?: unknown }) => turn.brief ?? null)).toEqual([
      { day: "2026-10-11", messageId: "mb_1", sentAt: null },
      null,
      null,
      { day: "2026-10-12", messageId: "mb_2", sentAt: "2026-10-12T06:02:40.055Z" },
      null,
      null,
    ]);
  });

  it("finds the break at its absolute index in a paged load and an older page", () => {
    // Tail page from index 4: the previous day's last reply, then the brief.
    let s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-morning",
      model: "demo",
      backend: "replay",
      origin,
      messagesAreVisible: true,
      messageCount: transcript.length,
      messagePageInfo: { nextCursor: "older-1" },
      messages: transcript.slice(4),
    });
    expect(turnTexts(s.turns).slice(0, 2)).toEqual([
      ["assistant", "About doc-yesterday."],
      ["assistant", "Good morning. The library books are due Friday."],
    ]);
    s = r(s, {
      kind: "prepend-conversation-history",
      sessionId: "sess-morning",
      pageKey: "older-1",
      pageInfo: { nextCursor: null },
      messagesAreVisible: true,
      messages: transcript.slice(0, 4),
    });
    expect(turnTexts(s.turns).slice(0, 2)).toEqual([
      ["assistant", "Good morning. The dentist moved to Thursday."],
      ["user", "Which dentist?"],
    ]);
  });

  it("leaves ordinary conversations' consecutive assistant messages in one turn", () => {
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-plain",
      model: "demo",
      backend: "replay",
      messagesAreVisible: true,
      messages: [brief("First part."), brief("Second part.")],
    });
    expect(turnTexts(s.turns)).toEqual([["assistant", "First part. Second part."]]);
    expect(briefTurnBreaks(null, 0, 2)).toBeNull();
  });
});

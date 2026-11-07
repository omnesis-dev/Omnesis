// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { AgentSession, type TurnFollowUp } from "./session.js";
import { CITATION_FOLLOW_UP_MESSAGE, citationFollowUp } from "./tools/registry.js";
import type { AgentEvent, AgentMessageEndEvent, DocRef, ToolResult } from "@omnesis/core";

import type { ChatBackend, ToolHandle, TurnInput } from "./backend.js";

const REF: DocRef = {
  documentId: "doc1",
  sourceType: "gmail",
  sourceId: "gmail:me",
  title: "Quarterly budget review",
};

type Run = (input: TurnInput) => AgentEvent[] | AsyncIterable<AgentEvent>;

/** A backend that plays one scripted run per `runTurn` call and records every input. */
function scripted(runs: Run[]): { backend: ChatBackend; inputs: TurnInput[] } {
  const inputs: TurnInput[] = [];
  const backend: ChatBackend = {
    name: "scripted",
    model: "scripted",
    async *runTurn(input) {
      inputs.push(input);
      const run = runs[inputs.length - 1];
      if (!run) throw new Error(`unexpected run ${inputs.length}`);
      yield* run(input);
    },
  };
  return { backend, inputs };
}

const start = (i: TurnInput): AgentEvent => ({
  type: "agent.message.start",
  payload: { sessionId: i.sessionId, messageId: i.messageId, role: "assistant" },
});
const text = (i: TurnInput, delta: string): AgentEvent => ({
  type: "agent.text.delta",
  payload: { sessionId: i.sessionId, messageId: i.messageId, delta },
});
const call = (i: TurnInput, id: string, tool: string, result: ToolResult): AgentEvent[] => [
  {
    type: "agent.tool.start",
    payload: { sessionId: i.sessionId, messageId: i.messageId, toolCallId: id, tool, args: {} },
  },
  {
    type: "agent.tool.result",
    payload: {
      sessionId: i.sessionId,
      messageId: i.messageId,
      toolCallId: id,
      result,
      durationMs: 1,
    },
  },
];
const end = (
  i: TurnInput,
  stopReason: AgentMessageEndEvent["stopReason"],
  outputTokens = 1,
): AgentEvent => ({
  type: "agent.message.end",
  payload: {
    sessionId: i.sessionId,
    messageId: i.messageId,
    stopReason,
    usage: { inputTokens: 10, outputTokens },
  },
});

const SEARCH_HITS: ToolResult = { kind: "search.batch", items: [] } as unknown as ToolResult;
const SEARCH_FAILED: ToolResult = { kind: "error", code: "invalid_args", message: "bad query" };
const ANNOTATED: ToolResult = {
  kind: "annotate.recorded",
  documentId: "doc1",
  ref: REF,
  quote: "the budget is approved",
} as unknown as ToolResult;

const FETCHED: ToolResult = { kind: "document.batch", items: [] } as unknown as ToolResult;

const ANSWER = "The budget was approved.";

/** The first run: one search, then an uncited answer. */
const answersFromSearch: Run = (i) => [
  start(i),
  ...call(i, "tc_search", "search_many", SEARCH_HITS),
  end(i, "tool_use"),
  text(i, ANSWER),
  end(i, "end_turn"),
];

/** A follow-up run that reads, then cites in a later iteration, then stops. */
const cites: Run = (i) => [
  start(i),
  {
    type: "agent.thinking.delta",
    payload: { sessionId: i.sessionId, messageId: i.messageId, delta: "Citing." },
  },
  ...call(i, "tc_fetch", "fetch_many", FETCHED),
  end(i, "tool_use"),
  ...call(i, "tc_cite", "annotate_many", ANNOTATED),
  end(i, "tool_use"),
  end(i, "end_turn"),
];

const annotateHandle = { name: "annotate_many" } as ToolHandle;

function session(backend: ChatBackend, turnFollowUp?: TurnFollowUp) {
  const s = new AgentSession({
    sessionId: "S",
    backend,
    tools: [],
    systemPrompt: "test",
    idGen: () => "M",
    ...(turnFollowUp ? { turnFollowUp } : {}),
  });
  const events: AgentEvent[] = [];
  s.subscribe((e) => events.push(e));
  return { s, events };
}

const follow = citationFollowUp([annotateHandle])!;

describe("AgentSession follow-up run", () => {
  it("asks an uncited answer to cite once and puts the citation on the Timeline", async () => {
    const { backend, inputs } = scripted([answersFromSearch, cites]);
    const { s, events } = session(backend, follow);

    const ended = await s.send("Was the budget approved?").completion;

    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.userMessage).toBe(CITATION_FOLLOW_UP_MESSAGE);
    expect(inputs[1]!.history.at(-1)).toEqual({
      role: "assistant",
      parts: [{ kind: "text", text: ANSWER }],
    });
    expect(ended.stopReason).toBe("end_turn");
    // Usage of both runs, every boundary counted once.
    expect(ended.usage).toMatchObject({ inputTokens: 50, outputTokens: 5 });

    // After the answer, clients see only the citation landing and the end.
    const afterAnswer = events.slice(events.findIndex((e) => e.type === "agent.text.delta") + 1);
    expect(afterAnswer.map((e) => e.type)).toEqual([
      "agent.citation",
      "agent.citations.update",
      "agent.message.end",
    ]);
    expect(events.find((e) => e.type === "agent.citations.update")?.payload).toMatchObject({
      added: [REF],
    });
    expect(s.citationsSnapshot().map((c) => c.documentId)).toEqual(["doc1"]);

    // Only the citation joins the answer's message: no read, no thinking, no follow-up text.
    const history = s.historySnapshot();
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(history[3]!.parts).toEqual([
      { kind: "text", text: ANSWER },
      expect.objectContaining({ kind: "tool_use", tool: "annotate_many" }),
    ]);
    expect(history[4]!.parts).toEqual([
      expect.objectContaining({ kind: "tool_result", toolCallId: "tc_cite" }),
    ]);
    expect(JSON.stringify(history)).not.toContain("tc_fetch");
    expect(JSON.stringify(history)).not.toContain(CITATION_FOLLOW_UP_MESSAGE);
    expect(JSON.stringify(events)).not.toContain(CITATION_FOLLOW_UP_MESSAGE);
  });

  it("ends after one follow-up run when the model ignores it", async () => {
    const { backend, inputs } = scripted([
      answersFromSearch,
      (i) => [start(i), text(i, "Yes, it was approved."), end(i, "end_turn")],
    ]);
    const { s, events } = session(backend, follow);

    const ended = await s.send("Was the budget approved?").completion;

    expect(inputs).toHaveLength(2);
    expect(ended.stopReason).toBe("end_turn");
    expect(s.citationsSnapshot()).toEqual([]);
    // Whatever it writes in reply is neither shown nor kept.
    const deltas = events.flatMap((e) => (e.type === "agent.text.delta" ? [e.payload.delta] : []));
    expect(deltas).toEqual([ANSWER]);
    expect(s.historySnapshot().at(-1)).toEqual({
      role: "assistant",
      parts: [{ kind: "text", text: ANSWER }],
    });
  });

  it("does not follow up a turn that already cited", async () => {
    const { backend, inputs } = scripted([
      (i) => [
        start(i),
        ...call(i, "tc_search", "search_many", SEARCH_HITS),
        ...call(i, "tc_cite", "annotate_many", ANNOTATED),
        end(i, "tool_use"),
        text(i, ANSWER),
        end(i, "end_turn"),
      ],
    ]);
    const { s } = session(backend, follow);
    const ended = await s.send("Was the budget approved?").completion;
    expect(inputs).toHaveLength(1);
    expect(ended.usage).toMatchObject({ inputTokens: 20, outputTokens: 2 });
  });

  it.each([
    ["no retrieval", (i: TurnInput) => [start(i), text(i, "Hello!"), end(i, "end_turn")]],
    [
      "only failed retrieval",
      (i: TurnInput) => [
        start(i),
        ...call(i, "tc_search", "search_many", SEARCH_FAILED),
        end(i, "tool_use"),
        text(i, "I could not search."),
        end(i, "end_turn"),
      ],
    ],
    [
      "no answer text",
      (i: TurnInput) => [
        start(i),
        ...call(i, "tc_search", "search_many", SEARCH_HITS),
        end(i, "tool_use"),
        end(i, "end_turn"),
      ],
    ],
    [
      "a truncated answer",
      (i: TurnInput) => [
        start(i),
        ...call(i, "tc_search", "search_many", SEARCH_HITS),
        end(i, "tool_use"),
        text(i, ANSWER),
        end(i, "max_tokens"),
      ],
    ],
  ])("does not follow up %s", async (_label, run) => {
    const { backend, inputs } = scripted([run]);
    const { s } = session(backend, follow);
    await s.send("hi").completion;
    expect(inputs).toHaveLength(1);
  });

  it("does not follow up a turn run on a transport-owned backend", async () => {
    const own = scripted([]);
    const transport = scripted([answersFromSearch]);
    const { s } = session(own.backend, follow);
    await s.send("Was the budget approved?", { backend: transport.backend }).completion;
    expect(transport.inputs).toHaveLength(1);
    expect(own.inputs).toHaveLength(0);
  });

  it("does not follow up without a turnFollowUp", async () => {
    const { backend, inputs } = scripted([answersFromSearch]);
    const { s } = session(backend);
    await s.send("Was the budget approved?").completion;
    expect(inputs).toHaveLength(1);
  });

  it("keeps the answer when the follow-up run fails", async () => {
    const { backend } = scripted([
      answersFromSearch,
      (i) => [
        start(i),
        {
          type: "agent.error",
          payload: {
            sessionId: i.sessionId,
            messageId: i.messageId,
            code: "provider_error",
            message: "overloaded",
          },
        },
        end(i, "error"),
      ],
    ]);
    const { s, events } = session(backend, follow);

    const ended = await s.send("Was the budget approved?").completion;

    expect(ended.stopReason).toBe("end_turn");
    expect(ended.failure).toBeUndefined();
    expect(events.some((e) => e.type === "agent.error")).toBe(false);
    expect(s.historySnapshot().at(-1)).toEqual({
      role: "assistant",
      parts: [{ kind: "text", text: ANSWER }],
    });
  });

  it("keeps the answer when the follow-up run throws mid-call", async () => {
    const { backend } = scripted([
      answersFromSearch,

      async function* (i) {
        yield start(i);
        yield {
          type: "agent.tool.start",
          payload: {
            sessionId: i.sessionId,
            messageId: i.messageId,
            toolCallId: "tc_fetch",
            tool: "fetch_many",
            args: {},
          },
        };
        throw new Error("connection reset");
      },
    ]);
    const { s } = session(backend, follow);

    const ended = await s.send("Was the budget approved?").completion;

    expect(ended.stopReason).toBe("end_turn");
    // The unrecorded read leaves nothing open behind it.
    expect(s.historySnapshot().at(-1)).toEqual({
      role: "assistant",
      parts: [{ kind: "text", text: ANSWER }],
    });
  });

  it("pairs a recorded citation call the follow-up run never finished", async () => {
    const { backend } = scripted([
      answersFromSearch,

      async function* (i) {
        yield {
          type: "agent.tool.start",
          payload: {
            sessionId: i.sessionId,
            messageId: i.messageId,
            toolCallId: "tc_cite",
            tool: "annotate_many",
            args: {},
          },
        };
        throw new Error("connection reset");
      },
    ]);
    const { s } = session(backend, follow);

    const ended = await s.send("Was the budget approved?").completion;

    expect(ended.stopReason).toBe("end_turn");
    const history = s.historySnapshot();
    expect(history[3]!.parts.map((p) => p.kind)).toEqual(["text", "tool_use"]);
    expect(history[4]!.parts).toEqual([
      expect.objectContaining({ kind: "tool_result", toolCallId: "tc_cite" }),
    ]);
  });

  it("cancels during the follow-up run like any other turn", async () => {
    const gate = Promise.withResolvers<void>();
    const { backend } = scripted([
      answersFromSearch,
      async function* (i) {
        yield start(i);
        await gate.promise;
        yield end(i, "end_turn");
      },
    ]);
    const { s } = session(backend, follow);
    const sent = s.send("Was the budget approved?");
    while (!s.liveHistorySnapshot().some((m) => JSON.stringify(m).includes(ANSWER))) {
      await new Promise((r) => setTimeout(r, 1));
    }
    s.cancel("user");
    gate.resolve();
    const ended = await sent.completion;
    expect(ended.stopReason).toBe("canceled");
  });
});

describe("citationFollowUp", () => {
  const ok = (tool: string) => ({ tool, result: SEARCH_HITS });

  it("is absent for a toolset without annotate_many", () => {
    expect(citationFollowUp([{ name: "search_many" } as ToolHandle])).toBeUndefined();
  });

  it("asks only when a document retrieval succeeded and nothing was cited", () => {
    for (const tool of [
      "search_many",
      "fetch_many",
      "temporal_query",
      "trace_connections",
      "lookup_document_by_url",
      "run_sql",
    ]) {
      expect(follow.ask([ok(tool)])).toBe(CITATION_FOLLOW_UP_MESSAGE);
    }
    expect(follow.ask([])).toBeUndefined();
    expect(follow.ask([ok("lookup_people")])).toBeUndefined();
    expect(follow.ask([{ tool: "search_many", result: SEARCH_FAILED }])).toBeUndefined();
    expect(follow.ask([ok("search_many"), ok("annotate_many")])).toBeUndefined();
    expect(follow.ask([ok("run_sql"), ok("cite_record")])).toBeUndefined();
  });

  it("records only the citation calls of its run", () => {
    expect(follow.records("annotate_many")).toBe(true);
    expect(follow.records("cite_record")).toBe(true);
    expect(follow.records("fetch_many")).toBe(false);
  });
});

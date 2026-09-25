// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The compiler, answering from a session that can look things up.
 *
 * Two properties carry this file. **What a compiler may touch** is a policy,
 * and it is the difference between a compiler that reads the corpus and one
 * that changes it while deciding what to watch for. And **the bridge between a
 * stateless caller and a stateful session** rests on an invariant of the
 * caller — that it only ever appends — whose violation is invisible: the
 * session would answer from a conversation nobody is having any more, and the
 * reply would look entirely ordinary.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { compilerTools, createCompilerSession } from "./compiler-session.js";
import type { ToolHandle } from "@omnesis/agent";

function tool(name: string, mutates?: boolean): ToolHandle {
  return {
    name,
    description: name,
    schema: { parse: (v: unknown) => v } as unknown as ToolHandle["schema"],
    ...(mutates === undefined ? {} : { mutates }),
    invoke: () => Promise.resolve({ content: "" }) as unknown as ReturnType<ToolHandle["invoke"]>,
  };
}

describe("what a compiler may touch", () => {
  it("keeps every read tool, so it can find out what a request means here", () => {
    const names = compilerTools([
      tool("search_many"),
      tool("fetch_many"),
      tool("lookup_people"),
      tool("run_sql"),
      tool("list_loops"),
      tool("temporal_query"),
      tool("entity_context"),
    ]).map((t) => t.name);

    expect(names).toEqual([
      "search_many",
      "fetch_many",
      "lookup_people",
      "run_sql",
      "list_loops",
      "temporal_query",
      "entity_context",
    ]);
  });

  it("drops anything that declares it writes", () => {
    // The handle's own declaration is the whole test — there is no list of
    // writer names kept here to fall back on, so a write tool added next month
    // is excluded by saying what it does rather than by being remembered.
    // (`builtin-tools.mutates.test.ts` is what holds the built-ins to that.)
    const names = compilerTools([
      tool("search_many"),
      tool("watch_create", true),
      tool("some_new_writer", true),
    ]).map((t) => t.name);

    expect(names).toEqual(["search_many"]);
  });

  it("drops the citation tools, which have nowhere to put a citation", () => {
    // A compile is a throwaway session with no conversation behind it, so a
    // citation row it wrote would hang off nothing. `annotate_many` does not
    // declare `mutates` — a delegated worker needs it to hand evidence back —
    // so nothing but this excludes it here.
    const names = compilerTools([
      tool("search_many"),
      tool("annotate_many"),
      tool("cite_record", true),
    ]).map((t) => t.name);

    expect(names).toEqual(["search_many"]);
  });

  it("drops delegation, which is read-only but is not retrieval", () => {
    // A compiler that could spawn workers turns one request into a tree of
    // them, each holding the corpus open, for a call whose product is one JSON
    // document.
    const names = compilerTools([tool("search_many"), tool("spawn_subagent"), tool("plan")]).map(
      (t) => t.name,
    );

    expect(names).toEqual(["search_many"]);
  });

  it("admits a read tool nobody has written yet", () => {
    // The point of asking `mutates` rather than consulting a list: a retrieval
    // tool added next month is available without anyone remembering.
    expect(compilerTools([tool("a_tool_from_the_future")]).map((t) => t.name)).toEqual([
      "a_tool_from_the_future",
    ]);
  });
});

/**
 * A backend that replies with fixed text, one turn at a time.
 *
 * Scripted rather than reached for: a test whose result depends on a model's
 * mood is not a test of the bridge, which is the only thing here worth pinning.
 */
function backendReplying(replies: string[]) {
  let turn = 0;
  return {
    name: "scripted",
    model: "scripted-model",
    dispose: () => Promise.resolve(),
    async *runTurn() {
      const text = replies[turn++] ?? "";
      yield { type: "agent.text.delta", payload: { delta: text } };
      yield {
        type: "agent.message.end",
        payload: { sessionId: "s", messageId: "m", stopReason: "end_turn" },
      };
    },
  };
}

describe("what the host is handed", () => {
  it("names the tools it attached, so the prompt can say what they are", () => {
    // The names and the handles come from one filter. Assembled separately,
    // the prompt would eventually promise a tool the session does not hold —
    // and the model would plan around a call it cannot make.
    const session = createCompilerSession(
      {
        backend: () => backendReplying([]) as never,
        tools: () => [tool("search_many"), tool("watch_create", true), tool("lookup_people")],
        timeoutMs: 60_000,
      },
      "compile-names",
    );

    expect(session?.toolNames).toEqual(["search_many", "lookup_people"]);
  });

  it("answers null when no model is assigned, rather than throwing", () => {
    // The caller has a single-shot path to fall back to. A throw here would
    // turn an install that can still compile — with less to go on — into a
    // failed request.
    expect(
      createCompilerSession(
        { backend: () => null, tools: () => [], timeoutMs: 60_000 },
        "compile-none",
      ),
    ).toBe(null);
  });
});

describe("a stateless caller over a stateful session", () => {
  it("refuses a caller that rewrote what it already said", async () => {
    // The invariant the bridge rests on. Rewriting history would leave the
    // session answering the question it remembers rather than the one being
    // asked — and nothing about that reply would look wrong, which is why this
    // throws rather than quietly resynchronising.
    const { model } = createCompilerSession(
      {
        backend: () => backendReplying(["{}", "{}"]) as never,
        tools: () => [],
        timeoutMs: 60_000,
      },
      "compile-1",
    )!;

    await model.complete([
      { role: "system", content: "the contract" },
      { role: "user", content: "Request: tell me when a parcel ships" },
    ]);

    await expect(
      model.complete([
        { role: "system", content: "the contract" },
        { role: "user", content: "Request: something else entirely" },
        { role: "user", content: "and a follow-up" },
      ]),
    ).rejects.toThrow(/rewrote message/);
  });

  it("refuses a caller that dropped what it already said", async () => {
    const { model } = createCompilerSession(
      { backend: () => backendReplying(["{}"]) as never, tools: () => [], timeoutMs: 60_000 },
      "compile-2",
    )!;

    await model.complete([
      { role: "system", content: "the contract" },
      { role: "user", content: "Request: tell me when a parcel ships" },
    ]);

    await expect(model.complete([{ role: "system", content: "the contract" }])).rejects.toThrow(
      /dropped earlier messages/,
    );
  });
});

/**
 * A backend that starts a turn and never finishes it, unless it is aborted.
 *
 * The shape a stalled compile actually has: a model that streamed a token and
 * then stopped, or a tool call that never returns. Nothing about it errors, so
 * the only thing that can end it is the caller's own deadline.
 *
 * `endsWith` is how the backend reports being torn down, and the two shipped
 * answers differ. Aborted between tool iterations, the Anthropic backend yields
 * `canceled`; aborted mid-stream it sees the broken connection first and yields
 * `error` with whatever partial text it had. A session that recognised only the
 * first would, on the common path, hand the compiler an empty reply to repair —
 * spending the whole repair budget and reporting the request uncompilable
 * rather than reporting that this install ran out of time. `"none"` is the
 * third answer: a generator that just returns, which the session turns into a
 * synthesised terminal event.
 */
function backendThatStalls(endsWith: "error" | "canceled" | "none" = "error"): {
  backend: unknown;
  aborted: () => boolean;
} {
  let sawAbort = false;
  return {
    aborted: () => sawAbort,
    backend: {
      name: "stalling",
      model: "stalling-model",
      dispose: () => Promise.resolve(),
      async *runTurn(_input: unknown, signal?: AbortSignal) {
        yield { type: "agent.text.delta", payload: { delta: "{" } };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        sawAbort = signal?.aborted === true;
        if (endsWith === "none") return;
        yield {
          type: "agent.message.end",
          payload: { sessionId: "s", messageId: "m", stopReason: endsWith },
        };
      },
    },
  };
}

/** A backend that cancels itself, with nobody having asked it to. */
function backendThatCancelsItself() {
  return {
    name: "self-cancelling",
    model: "self-cancelling-model",
    dispose: () => Promise.resolve(),
    async *runTurn() {
      yield {
        type: "agent.message.end",
        payload: { sessionId: "s", messageId: "m", stopReason: "canceled" },
      };
    },
  };
}

describe("the compile turn's reasoning ceiling", () => {
  /** A backend that records the `reasoning` field of every turn it is given. */
  function backendRecordingReasoning(seen: unknown[]) {
    return {
      name: "scripted",
      model: "scripted-model",
      dispose: () => Promise.resolve(),
      async *runTurn(input: { reasoning?: unknown }) {
        seen.push(input.reasoning);
        yield { type: "agent.text.delta", payload: { delta: "{}" } };
        yield {
          type: "agent.message.end",
          payload: { sessionId: "s", messageId: "m", stopReason: "end_turn" },
        };
      },
    };
  }

  it("asks the turn to stop reasoning when the host set a ceiling", async () => {
    // Measured over 88 compiles: a run that missed its deadline made the same
    // handful of tool calls as one that finished and then reasoned about three
    // times as long, emitting almost no answer. It ran out of time deciding,
    // so a ceiling is what converts some of those into answers at all.
    const seen: unknown[] = [];
    const { model } = createCompilerSession(
      {
        backend: () => backendRecordingReasoning(seen) as never,
        tools: () => [],
        timeoutMs: 60_000,
        reasoningTokens: 8_000,
      },
      "compile-bounded",
    )!;

    await model.complete([
      { role: "system", content: "the contract" },
      { role: "user", content: "Request: tell me when a parcel ships" },
    ]);

    expect(seen).toEqual([{ maxTokens: 8_000 }]);
  });

  it("leaves the turn alone when the host set none", async () => {
    // The discriminating half: an install that never configured a ceiling gets
    // exactly the turn it got before, rather than a default nobody chose.
    const seen: unknown[] = [];
    const { model } = createCompilerSession(
      {
        backend: () => backendRecordingReasoning(seen) as never,
        tools: () => [],
        timeoutMs: 60_000,
      },
      "compile-unbounded",
    )!;

    await model.complete([
      { role: "system", content: "the contract" },
      { role: "user", content: "Request: tell me when a parcel ships" },
    ]);

    expect(seen).toEqual([undefined]);
  });
});

describe("the caller's deadline", () => {
  /** Run one turn against a session and return how it failed, if it did. */
  async function turnAgainst(backend: unknown, sessionId: string): Promise<Error | null> {
    const { model } = createCompilerSession(
      { backend: () => backend as never, tools: () => [], timeoutMs: 20 },
      sessionId,
    )!;
    return model
      .complete([
        { role: "system", content: "the contract" },
        { role: "user", content: "Request: tell me when a parcel ships" },
      ])
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
  }

  // Whatever the backend says on the way down. The deadline is the thing that
  // happened, and the signal is what knows it: a check on the backend's stop
  // reason recognises one of these and silently repairs the other two.
  it.each(["error", "canceled", "none"] as const)(
    "ends a turn that never finishes, and says it was the clock (backend ends with %s)",
    async (endsWith) => {
      // A turn here is a model reply plus however many tool calls it decides to
      // make, so no provider-level timeout bounds it. Without this the request
      // hangs for as long as the connection does — the bug #1800 fixed on the
      // single-shot path, which this path never had.
      const failure = await turnAgainst(backendThatStalls(endsWith).backend, `slow-${endsWith}`);

      // The name is the contract: `isTimeout` in the compile port reads it, and
      // a timeout has to come back as its own outcome rather than as a refusal
      // — an agent told its condition was unsupported stops asking.
      expect(failure?.name).toBe("TimeoutError");
      expect(failure?.message).toContain("20ms");
    },
  );

  it("reports a cancellation nobody asked for as an abort, not as an answer", async () => {
    // Not this deadline, so not a timeout — but still a turn that produced no
    // reply. Handing its empty text to the compiler would spend the repair
    // budget on nothing; the port maps an abort to `timed-out`, which says
    // truthfully that the condition was never decided.
    const failure = await turnAgainst(backendThatCancelsItself(), "self-cancelled");

    expect(failure?.name).toBe("AbortError");
  });

  it("cancels the turn rather than racing it", async () => {
    // A race would resolve the caller and leave the session running: tools
    // still reading the corpus and tokens still being billed for a compile
    // nobody is waiting on.
    const stalling = backendThatStalls();
    const { model } = createCompilerSession(
      { backend: () => stalling.backend as never, tools: () => [], timeoutMs: 20 },
      "compile-cancel",
    )!;

    await model
      .complete([
        { role: "system", content: "the contract" },
        { role: "user", content: "Request: tell me when a parcel ships" },
      ])
      .catch(() => undefined);

    expect(stalling.aborted(), "the stalled turn was left running").toBe(true);
  });
});

/**
 * A backend that reads something before answering.
 *
 * The tool call is the point: its arguments and its result are what a compile
 * transcript is *for* — a compiler that bound a watch to the wrong source did
 * so because of something it read, and nothing else records what that was.
 */
function backendThatLooksSomethingUp() {
  return {
    name: "scripted",
    model: "scripted-model",
    dispose: () => Promise.resolve(),
    async *runTurn() {
      yield {
        type: "agent.tool.start",
        payload: {
          sessionId: "s",
          messageId: "m",
          toolCallId: "call-1",
          tool: "lookup_people",
          args: { query: "Maya Reeves" },
        },
      };
      yield {
        type: "agent.tool.result",
        payload: {
          sessionId: "s",
          messageId: "m",
          toolCallId: "call-1",
          result: { kind: "structured", data: { matches: 1 } },
          durationMs: 12,
        },
      };
      yield { type: "agent.text.delta", payload: { delta: "{}" } };
      yield {
        type: "agent.message.end",
        payload: {
          sessionId: "s",
          messageId: "m",
          stopReason: "end_turn",
          usage: { inputTokens: 40, outputTokens: 5 },
        },
      };
    },
  };
}

describe("what a compile leaves behind", () => {
  it("forwards every event, so a recorder sees what the compiler looked at", async () => {
    // The session's own subscriber keeps a name and a text delta, which is
    // enough for one log line and nothing else. A transcript needs the whole
    // stream — the arguments a tool was called with and what came back — and
    // the only place that stream exists is here.
    const seen: Array<{ type: string; payload: unknown }> = [];
    const { model } = createCompilerSession(
      {
        backend: () => backendThatLooksSomethingUp() as never,
        tools: () => [],
        timeoutMs: 60_000,
        onEvent: (event) => seen.push({ type: event.type, payload: event.payload }),
      },
      "compile-observed",
    )!;

    await model.complete([
      { role: "system", content: "the contract" },
      { role: "user", content: "Request: tell me when a parcel ships" },
    ]);

    expect(seen.map((e) => e.type)).toEqual([
      "agent.user.message",
      "agent.tool.start",
      "agent.tool.result",
      "agent.text.delta",
      "agent.message.end",
    ]);
    // Verbatim, not summarised: the viewer reads the wire payloads.
    expect(seen[1]?.payload).toMatchObject({
      tool: "lookup_people",
      args: { query: "Maya Reeves" },
    });
    expect(seen[2]?.payload).toMatchObject({
      result: { kind: "structured", data: { matches: 1 } },
    });
  });

  it("still answers when nobody is recording", async () => {
    // The observer is optional on purpose — the eval harness and this file's
    // own tests run the session with no ledger behind it.
    const { model } = createCompilerSession(
      { backend: () => backendReplying(["{}"]) as never, tools: () => [], timeoutMs: 60_000 },
      "compile-unobserved",
    )!;

    expect(
      (
        await model.complete([
          { role: "system", content: "the contract" },
          { role: "user", content: "Request: tell me when a parcel ships" },
        ])
      ).text,
    ).toBe("{}");
  });
});

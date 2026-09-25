// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a turn that asked to stop reasoning is actually told to.
 *
 * Adaptive thinking hands the model the decision about how long to think,
 * which is right for a conversation someone is watching and wrong for a turn
 * on a deadline with one document to produce. Measured over 88 watch compiles,
 * the runs that missed their deadline had made the same handful of tool calls
 * as the ones that finished and then reasoned roughly three times as long,
 * emitting six text deltas against a median of nine hundred and fifty — they
 * ran out of time deciding, not working.
 *
 * So what is asserted here is not "the option exists" but that it reaches the
 * provider request, that it does not leak into the turns that did not ask for
 * it, and that a caller cannot accidentally ask for a budget the API would
 * reject or one that would eat the answer.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import {
  AnthropicBackend,
  supportsThinkingBudget,
  type AnthropicClientLike,
} from "./anthropic-backend.js";
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { TurnInput } from "./backend.js";

/** A model that thinks at length AND still accepts an explicit budget. */
const THINKING_MODEL = "claude-opus-4-6";

/**
 * A model that thinks at length but has retired the explicit budget.
 *
 * The two are different sets, and the gap is the whole point: sending a budget
 * here is answered with an HTTP 400 that fails the turn, so a caller who asked
 * for less thinking would get no answer at all.
 */
const BUDGETLESS_MODEL = "claude-sonnet-5";

/** The captured request, and a stream that ends the turn immediately. */
function recordingClient(): {
  client: AnthropicClientLike;
  sent: MessageCreateParamsStreaming[];
  opts: Array<{ headers?: Record<string, string> } | undefined>;
} {
  const sent: MessageCreateParamsStreaming[] = [];
  const opts: Array<{ headers?: Record<string, string> } | undefined> = [];
  const client: AnthropicClientLike = {
    messages: {
      create(params, requestOptions) {
        sent.push(params);
        opts.push(requestOptions);
        return (async function* (): AsyncIterable<RawMessageStreamEvent> {
          yield {
            type: "message_start",
            message: {
              id: "msg_test",
              type: "message",
              role: "assistant",
              model: THINKING_MODEL,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          } as unknown as RawMessageStreamEvent;
          yield {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          } as unknown as RawMessageStreamEvent;
          yield { type: "message_stop" } as unknown as RawMessageStreamEvent;
        })();
      },
    },
  };
  return { client, sent, opts };
}

function turn(reasoning?: { maxTokens: number }): TurnInput {
  return {
    sessionId: "s_test",
    messageId: "m_test",
    history: [],
    userMessage: "compile something",
    tools: [],
    systemPrompt: "a contract",
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

async function thinkingSentFor(
  reasoning: { maxTokens: number } | undefined,
  opts: { maxTokens?: number } = {},
): Promise<Record<string, unknown> | undefined> {
  const { client, sent } = recordingClient();
  const backend = new AnthropicBackend({
    apiKey: "k",
    model: THINKING_MODEL,
    client,
    modelLimits: { maxOutputTokens: 32_000 },
    ...opts,
  });
  for await (const _event of backend.runTurn(turn(reasoning))) {
    // Drain: the request is captured on the first create() call.
  }
  return sent[0]?.thinking as Record<string, unknown> | undefined;
}

/** The `anthropic-beta` header the first request carried, if any. */
async function betaHeaderFor(reasoning?: { maxTokens: number }): Promise<string | undefined> {
  const { client, opts } = recordingClient();
  const backend = new AnthropicBackend({
    apiKey: "k",
    model: THINKING_MODEL,
    client,
    modelLimits: { maxOutputTokens: 32_000 },
  });
  for await (const _event of backend.runTurn(turn(reasoning))) {
    // Drain.
  }
  return opts[0]?.headers?.["anthropic-beta"];
}

describe("a reasoning bound on one turn", () => {
  it("reaches the provider as a budget rather than an adaptive think", async () => {
    expect(await thinkingSentFor({ maxTokens: 8_000 })).toEqual({
      type: "enabled",
      budget_tokens: 8_000,
      // Stated rather than defaulted: the reasoning stream is how a compile's
      // transcript shows where its time went, and that measurement is the only
      // reason this bound exists.
      display: "summarized",
    });
  });

  it("leaves a turn that asked for nothing exactly as it was", async () => {
    // The discriminating half. Every interactive turn takes this path, and a
    // bound that leaked into them would quietly change the product's headline
    // behaviour to buy a compile a few seconds.
    expect(await thinkingSentFor(undefined)).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("raises a budget under the API's floor instead of failing the turn", async () => {
    // A bound exists to make a turn finish. Refusing the request would be the
    // one outcome worse than thinking too long, so a caller asking for less
    // than the API accepts gets the floor.
    expect(await thinkingSentFor({ maxTokens: 10 })).toEqual({
      type: "enabled",
      budget_tokens: 1_024,
      display: "summarized",
    });
  });

  it("keeps room for the answer when asked for more than the turn can spend", async () => {
    // Reasoning and the visible answer share `max_tokens`. A budget equal to it
    // is a turn that may spend everything thinking and stream nothing — which
    // is precisely the failure this mechanism exists to prevent, arrived at
    // from the other direction.
    // The exact figure, not merely "less than the ceiling": a headroom mutated
    // to one token would leave one token for the answer and still pass a
    // less-than assertion, which is the very failure this names.
    expect(await thinkingSentFor({ maxTokens: 1_000_000 }, { maxTokens: 16_000 })).toEqual({
      type: "enabled",
      budget_tokens: 16_000 - 4_096,
      display: "summarized",
    });
  });

  it("is ignored by a model that does not think at all", async () => {
    // A bound is only meaningful where thinking is on. On a model without it
    // the config would be one the API rejects, bought in exchange for nothing.
    const { client, sent } = recordingClient();
    const backend = new AnthropicBackend({
      apiKey: "k",
      model: "claude-haiku-3-5-20241022",
      client,
      adaptiveThinking: false,
    });
    for await (const _event of backend.runTurn(turn({ maxTokens: 8_000 }))) {
      // Drain.
    }
    expect(sent, "no request was made, so the assertion below proves nothing").toHaveLength(1);
    expect(sent[0]?.thinking).toBeUndefined();
  });

  it("leaves the turn unbounded when the output ceiling has no room for a budget", async () => {
    // The answer's share is half the pool at these sizes, so a ceiling this
    // small leaves less than the API's floor. Clamping anyway would silently
    // hand the model a far tighter bound than anyone chose, on exactly the path
    // this exists to improve — so the turn keeps the backend's own config.
    const thinking = await thinkingSentFor({ maxTokens: 8_000 }, { maxTokens: 2_000 });
    expect(thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("sends no budget to a model that has retired the shape", async () => {
    // The discriminating case, and the expensive one to get wrong: this model
    // answers a budget with an HTTP 400 naming `thinking.type.enabled`, which
    // fails the whole turn. A caller asking for less thinking would get no
    // answer at all — strictly worse than the unbounded turn they were trying
    // to improve on. So the bound is dropped and the model decides, as it did
    // before anyone asked.
    const { client, sent } = recordingClient();
    const backend = new AnthropicBackend({
      apiKey: "k",
      model: BUDGETLESS_MODEL,
      client,
      modelLimits: { maxOutputTokens: 32_000 },
    });
    for await (const _event of backend.runTurn(turn({ maxTokens: 8_000 }))) {
      // Drain.
    }
    expect(sent[0]?.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });
});

describe("interleaved thinking under a bound", () => {
  it("asks for the interleaving back when the turn is bounded", async () => {
    // Bounding the turn swaps adaptive thinking for a fixed budget, and
    // adaptive is what auto-enables reasoning BETWEEN tool calls. Without the
    // beta the bound would also stop the model thinking after each thing it
    // reads — for a compiler whose job is to find out what a request means on
    // this install before choosing a predicate, the more damaging half of the
    // trade, and one nobody asked for.
    expect(await betaHeaderFor({ maxTokens: 8_000 })).toBe("interleaved-thinking-2025-05-14");
  });

  it("sends no beta on a turn that asked for nothing", async () => {
    // Adaptive interleaves on its own. A header here would request a beta the
    // turn does not use, on every interactive turn the product runs.
    expect(await betaHeaderFor(undefined)).toBeUndefined();
  });

  it("sends no beta to a model that never receives the block", async () => {
    const { client, opts } = recordingClient();
    const backend = new AnthropicBackend({
      apiKey: "k",
      model: BUDGETLESS_MODEL,
      client,
      modelLimits: { maxOutputTokens: 32_000 },
    });
    for await (const _event of backend.runTurn(turn({ maxTokens: 8_000 }))) {
      // Drain.
    }
    expect(opts[0]?.headers?.["anthropic-beta"]).toBeUndefined();
  });

  it("sends no beta when the bound could not be applied", async () => {
    // Too small a ceiling to fit a budget beside the answer's share, so the
    // turn stays adaptive — and a header without the `enabled` block it exists
    // to repair would be a beta requested for a shape that was never sent.
    const { client, opts } = recordingClient();
    const backend = new AnthropicBackend({
      apiKey: "k",
      model: THINKING_MODEL,
      client,
      maxTokens: 2_000,
    });
    for await (const _event of backend.runTurn(turn({ maxTokens: 8_000 }))) {
      // Drain.
    }
    expect(opts[0]?.headers?.["anthropic-beta"]).toBeUndefined();
  });
});

describe("which models still take an explicit budget", () => {
  it.each(["claude-opus-4-6", "claude-sonnet-4-6"])("%s does", (model) => {
    expect(supportsThinkingBudget(model)).toBe(true);
  });

  it.each([
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
  ])("%s does not — it answers a budget with a 400", (model) => {
    expect(supportsThinkingBudget(model)).toBe(false);
  });

  it("is narrower than the set that thinks at length, which is the whole point", () => {
    // Every model that takes a budget also thinks adaptively; the reverse does
    // not hold, and the gap is the set this exists to keep a budget away from.
    expect(supportsThinkingBudget("claude-sonnet-5")).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `HttpAgentBackend` — the agent backend the gateway constructs for any
 * `http` inference assignment. It routes a turn to the right OpenAI-compatible
 * wire protocol:
 *
 *   - `chat-completions` ({@link HttpChatBackend}) — the default; every
 *     OpenAI-compatible server speaks it.
 *   - `responses` ({@link OpenAIResponsesBackend}) — for OpenAI models served
 *     only via the Responses API (`o1-pro`, `gpt-5-pro`, deep-research, …),
 *     which 404 on chat-completions.
 *
 * Selection: saved reasoning effort on OpenAI's own endpoint uses Responses,
 * whose nested reasoning field is accepted across current reasoning models.
 * Otherwise an explicit `protocol` pins the choice. When unset, the first turn
 * tries chat-completions and, if the model 404s as "not a chat model",
 * transparently re-runs that turn against Responses and remembers the decision
 * for the rest of the session. (Systematic, probe-driven capability detection
 * is tracked separately.)
 */

import { createLogger, type AgentEvent, type AgentProtocol } from "@omnesis/core";

import { HttpChatBackend } from "./http-backend.js";
import { preferredReasoningWireProtocol } from "./model-reasoning-wire.js";
import { OpenAIResponsesBackend } from "./openai-responses-backend.js";
import type { ModelTokenLimits, ModelControls, ModelBehaviorValues } from "@omnesis/core/models";
import type { ChatBackend, TurnInput } from "./backend.js";

const log = createLogger("agent:http");

export interface HttpAgentBackendOptions {
  baseUrl: string;
  model: string;
  apiPathPrefix?: string;
  maxToolIterations?: number;
  timeoutMs?: number;
  apiKey?: string;
  allowRemoteInference?: boolean;
  /** Pin the wire protocol; omit to auto-detect on the first turn. */
  protocol?: AgentProtocol;
  modelLimits?: ModelTokenLimits;
  /** Exact serving-provider controls from the Models.dev catalog. */
  modelControls?: ModelControls;
  /** Assignment-scoped values saved by the user. */
  modelBehavior?: ModelBehaviorValues;
}

/**
 * Does this error event signal that the model isn't served on chat-completions
 * (i.e. it's a Responses-only model)? OpenAI returns one of two 404 bodies
 * depending on the model:
 *   - "This model is only supported in v1/responses and not in v1/chat/completions."
 *   - "This is not a chat model and thus not supported in the v1/chat/completions endpoint…"
 * Key off the stable signals — a pointer to `v1/responses`, or "not a chat
 * model" — rather than the exact wording.
 */
function isProtocolMismatch(event: AgentEvent): boolean {
  if (event.type !== "agent.error") return false;
  if (event.payload.code === "http_protocol_mismatch") return true;
  const msg = (event.payload as { message?: string }).message ?? "";
  return /v1\/responses/i.test(msg) || /not a chat model/i.test(msg);
}

export class HttpAgentBackend implements ChatBackend {
  readonly name = "http";
  readonly model: string;

  private readonly chat: HttpChatBackend;
  private readonly responses: OpenAIResponsesBackend;
  /** Memoized once known; seeded from explicit config when present. */
  private decided?: AgentProtocol;

  constructor(opts: HttpAgentBackendOptions) {
    this.model = opts.model;
    this.chat = new HttpChatBackend(opts);
    this.responses = new OpenAIResponsesBackend(opts);
    this.decided =
      opts.protocol ??
      preferredReasoningWireProtocol(opts.baseUrl, opts.modelControls, opts.modelBehavior);
  }

  async *runTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.decided === "responses") {
      yield* this.responses.runTurn(input, signal);
      return;
    }
    if (this.decided === "chat-completions") {
      yield* this.chat.runTurn(input, signal);
      return;
    }
    yield* this.runAutoDetect(input, signal);
  }

  /**
   * First turn with no pinned protocol: stream chat-completions, but buffer the
   * pre-content events so that if the model turns out to be Responses-only (a
   * "not a chat model" 404 before any output), we can silently discard them and
   * re-run the turn against the Responses API instead.
   */
  private async *runAutoDetect(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const buffered: AgentEvent[] = [];
    let sawContent = false;
    let mismatch = false;

    for await (const ev of this.chat.runTurn(input, signal)) {
      const t = ev.type;
      if (t === "agent.text.delta" || t === "agent.thinking.delta" || t.startsWith("agent.tool.")) {
        sawContent = true;
      }
      if (!sawContent && isProtocolMismatch(ev)) {
        // Responses-only model: abandon the chat-completions attempt before
        // surfacing its error or message.end, and reroute below.
        mismatch = true;
        break;
      }
      if (sawContent) {
        for (const b of buffered) yield b;
        buffered.length = 0;
        yield ev;
      } else {
        buffered.push(ev);
      }
    }

    if (mismatch) {
      this.decided = "responses";
      log.info(`agent protocol auto-detected as responses (model=${this.model})`);
      yield* this.responses.runTurn(input, signal);
      return;
    }

    // Chat-completions confirmed (content streamed, or the turn ended for an
    // unrelated reason). Flush whatever we held back so nothing is swallowed.
    this.decided = "chat-completions";
    for (const b of buffered) yield b;
  }
}

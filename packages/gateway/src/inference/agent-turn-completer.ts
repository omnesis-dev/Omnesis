// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { classifyAgentTurn, type ChatBackend, type TurnInput } from "@omnesis/agent";
import type { AgentMessageEndEvent, CompleteCapability } from "@omnesis/core";
import type { HttpCompletion } from "./http-completer.js";

interface AgentTurnCompletionOptions {
  /** Agent runtimes expose no hard output-token cap or temperature control. */
  maxTokens?: number;
  temperature?: number;
  /** Applied to the completed text; does not reduce upstream token usage. */
  stop?: readonly string[];
  images?: TurnInput["images"];
  signal?: AbortSignal;
}

/**
 * A fresh, tool-free agent turn for single-shot inference, over a subscription
 * runtime (Codex, Claude Code) that offers no plain completion endpoint. The
 * runtime is shared; disposing this adapter cancels only its own calls, never
 * the runtime itself.
 */
export class AgentTurnCompleter implements CompleteCapability {
  readonly name: string;
  readonly modelId: string;
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly opts: { backend: ChatBackend; timeoutMs?: number }) {
    this.name = opts.backend.name;
    this.modelId = opts.backend.model;
  }

  async complete(prompt: string, opts?: AgentTurnCompletionOptions): Promise<string> {
    return (await this.completeWithUsage(prompt, opts)).text;
  }

  async completeWithUsage(
    prompt: string,
    opts?: AgentTurnCompletionOptions,
  ): Promise<HttpCompletion> {
    return this.runCompletion(prompt, opts, false);
  }

  /** Verifier lifecycle lease: settle only after this call's iterator cleanup. */
  async completeWithUsageSettled(
    prompt: string,
    opts?: AgentTurnCompletionOptions,
  ): Promise<HttpCompletion> {
    return this.runCompletion(prompt, opts, true);
  }

  private async runCompletion(
    prompt: string,
    opts: AgentTurnCompletionOptions | undefined,
    awaitSettlement: boolean,
  ): Promise<HttpCompletion> {
    if (this.disposed) throw new Error("Agent turn completer is disposed");
    opts?.signal?.throwIfAborted();
    const controller = new AbortController();
    this.active.add(controller);
    const cancel = () => controller.abort(opts?.signal?.reason);
    opts?.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("Completion timed out")),
      this.opts.timeoutMs ?? 45_000,
    );
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      if (!awaitSettlement)
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      const consuming = this.consume(prompt, opts, controller.signal);
      return await (awaitSettlement ? consuming : Promise.race([consuming, aborted]));
    } finally {
      clearTimeout(timeout);
      opts?.signal?.removeEventListener("abort", cancel);
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
      this.active.delete(controller);
    }
  }

  private async consume(
    prompt: string,
    opts: AgentTurnCompletionOptions | undefined,
    signal: AbortSignal,
  ): Promise<HttpCompletion> {
    let text = "";
    let terminal: AgentMessageEndEvent | undefined;
    for await (const event of this.opts.backend.runTurn(
      {
        sessionId: randomUUID(),
        messageId: randomUUID(),
        history: [],
        finalAnswerOnly: true,
        tools: [],
        systemPrompt: "Complete the user's request directly. Return only the requested output.",
        userMessage: prompt,
        ...(opts?.images ? { images: opts.images } : {}),
      },
      signal,
    )) {
      signal.throwIfAborted();
      if (event.type === "agent.text.delta") text += event.payload.delta;
      if (event.type === "agent.message.end") terminal = event.payload;
    }
    signal.throwIfAborted();
    if (!terminal) throw new Error("Completion ended without a terminal result");
    const outcome = classifyAgentTurn(terminal);
    if (outcome.status === "failed") throw new Error(outcome.failure.message);
    if (terminal.stopReason !== "end_turn") {
      throw new Error("Completion ended without a complete answer");
    }
    for (const stop of opts?.stop ?? []) {
      if (!stop) continue;
      const index = text.indexOf(stop);
      if (index >= 0) text = text.slice(0, index);
    }
    return {
      text,
      usage: terminal.usage
        ? {
            // The backend reports fresh and cached input apart; a completion's
            // prompt count is all input it consumed, as other completers report.
            promptTokens:
              (terminal.usage.inputTokens ?? 0) +
              (terminal.usage.cacheReadTokens ?? 0) +
              (terminal.usage.cacheCreationTokens ?? 0),
            ...(terminal.usage.cacheReadTokens !== undefined
              ? { cacheReadTokens: terminal.usage.cacheReadTokens }
              : {}),
            ...(terminal.usage.cacheCreationTokens !== undefined
              ? { cacheCreationTokens: terminal.usage.cacheCreationTokens }
              : {}),
            completionTokens: terminal.usage.outputTokens ?? 0,
          }
        : null,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active) {
      controller.abort(new Error("Agent turn completer is disposed"));
    }
  }
}

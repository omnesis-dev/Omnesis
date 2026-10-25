// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The conversation puppet — an OpenAI-compatible server assigned to the
 * interactive `agent` role, standing in for the model in a conversation turn.
 *
 * It is the steward puppet's sibling for the other seam: a reply in a
 * conversation (the Morning brief thread included) runs through the real
 * agent service, toolset and write gates, and only the reasoning that picks
 * the tool calls is scripted. A behavior matches the user's latest message;
 * its plan runs strictly in order with `ref()` reading real results, exactly
 * like a steward plan (`emitNextPlanned`).
 *
 * Stateless per request: the whole conversation arrives with each call, and
 * only the tool round-trips after the latest user message count towards the
 * plan, so an earlier turn's calls never consume a later turn's plan.
 */

import { startOpenAiServer, type OpenAiServerHandle } from "./openai-server.js";
import {
  collectToolSteps,
  emitNextPlanned,
  type NextTurn,
  type PuppetPlan,
  type WireMessage,
} from "./puppet-plan.js";

/** What a conversation behavior sees of the turn it is asked to perform. */
export interface ConversationContext {
  /** The user's latest message, as the model received it. */
  message: string;
  /** Every system message, joined — where per-conversation context lands. */
  systemPrompt: string;
  /** The conversation as the model received it (its context window). */
  history: readonly WireMessage[];
}

/** Match a turn to a plan by a substring of the user's latest message. */
export interface ConversationBehavior {
  messageContains: string;
  plan: PuppetPlan | ((ctx: ConversationContext) => PuppetPlan);
}

/** One completion the conversation puppet served. */
export interface ConversationPuppetCall {
  at: number;
  context: ConversationContext;
  emitted: NextTurn;
}

export interface ConversationPuppetServer extends OpenAiServerHandle {
  calls: ConversationPuppetCall[];
}

const CONVERSATION_PUPPET_MODEL_ID = "brain-bench-conversation-v1";

function contentOf(message: WireMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

/** Read one conversation turn from the wire messages. */
export function readConversationContext(messages: readonly WireMessage[]): ConversationContext {
  const userIndex = messages.findLastIndex((m) => m.role === "user");
  return {
    message: contentOf(messages[userIndex]),
    systemPrompt: messages
      .filter((m) => m.role === "system")
      .map(contentOf)
      .join("\n"),
    history: messages,
  };
}

/** Decide the next turn for a conversation. Pure; the server wraps it. */
export function decideConversationTurn(
  messages: readonly WireMessage[],
  behaviors: readonly ConversationBehavior[],
): NextTurn {
  const ctx = readConversationContext(messages);
  const behavior = behaviors.find((b) => ctx.message.includes(b.messageContains));
  if (!behavior)
    return { kind: "final", text: "No scripted conversation behavior; nothing to do." };
  const plan = typeof behavior.plan === "function" ? behavior.plan(ctx) : behavior.plan;
  const userIndex = messages.findLastIndex((m) => m.role === "user");
  return emitNextPlanned(plan, collectToolSteps(messages.slice(userIndex + 1)), false);
}

export async function startConversationPuppet(opts: {
  behaviors: readonly ConversationBehavior[];
}): Promise<ConversationPuppetServer> {
  const calls: ConversationPuppetCall[] = [];
  const handle = await startOpenAiServer({
    modelId: CONVERSATION_PUPPET_MODEL_ID,
    respond: (messages) => {
      const turn = decideConversationTurn(messages, opts.behaviors);
      calls.push({ at: Date.now(), context: readConversationContext(messages), emitted: turn });
      return turn.kind === "tool"
        ? { kind: "tool", name: turn.name, args: turn.args }
        : { kind: "text", text: turn.text };
    },
  });
  return { ...handle, calls };
}

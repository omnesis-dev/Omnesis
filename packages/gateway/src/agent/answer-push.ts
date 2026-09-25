// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Slow-answer push delivery. When an agent turn requested with
 * `notifyAfterMs` outlives that budget, the finished answer is pushed to
 * every registered notification device so a voice caller (whose assistant
 * gave up waiting) still receives it. This module only shapes the message —
 * banner text clipping and the agent-answer envelope, with a collapse id
 * per conversation so a repeat ask replaces the banner instead of
 * stacking it; delivery discipline (never throws, short-circuits,
 * per-device isolation, gone-token clearing) lives in the shared push
 * broadcaster.
 */

import type { AgentAnswerNotification } from "./service.js";
import type { NotificationPublisher } from "../push/broadcast.js";

export interface AgentAnswerPushDeps {
  publisher: NotificationPublisher;
}

/**
 * Cap on the visible alert body. Carrier services truncate long alerts, but a
 * banner only shows a couple of lines — clip to roughly that much and mark
 * the cut with an ellipsis so the alert reads as a preview, not a cliff.
 */
const MAX_ANSWER_PUSH_BODY_CHARS = 175;

const FAILED_ANSWER_BODY = "The agent couldn't finish your answer. Open Omnesis to retry.";

/** Collapse the answer to a single line and clip it to alert length. */
function alertBody(answer: string): string {
  const collapsed = answer.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_ANSWER_PUSH_BODY_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_ANSWER_PUSH_BODY_CHARS - 1)}…`;
}

/**
 * Push one finished (or failed — `answer: null`) slow answer to every
 * registered notification device. Never throws — a push failure must not fail
 * the turn that produced the answer.
 */
export async function sendAgentAnswerPush(
  deps: AgentAnswerPushDeps,
  notification: AgentAnswerNotification,
): Promise<void> {
  const { conversationId, answer } = notification;
  await deps.publisher.publish({
    kind: "agent-answer",
    title: answer !== null ? "Answer ready" : "Answer failed",
    body: answer !== null ? alertBody(answer) : FAILED_ANSWER_BODY,
    data: { conversationId },
    collapseId: `agent-answer:${conversationId}`,
  });
}

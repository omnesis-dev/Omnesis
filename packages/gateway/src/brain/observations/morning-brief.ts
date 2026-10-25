// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Sending the morning brief: the one message a day the Brain writes to the
 * user, appended to the standing "Morning brief" conversation.
 *
 * The morning run composes the text and calls `morning_brief_send`. The tool
 * appends the message through the conversation port, then records the send
 * and ships that morning's ranked observations in one writer transaction. A
 * day can be sent at most once.
 */

import { z } from "zod";
import { listMorningBriefItems, morningBriefSent } from "../storage/morning-brief-items.js";
import type { ToolHandle } from "@omnesis/agent";
import type { Logger, ToolResult } from "@omnesis/core";
import type { MarkMorningBriefSentResult } from "../storage/morning-brief-items.js";
import type Database from "better-sqlite3";

/** Appends the brief to the standing conversation; implemented by the agent service. */
export interface MorningBriefConversationPort {
  appendMorningBrief(input: {
    day: string;
    runId: string;
    text: string;
    /** Send the conversation notification for this message. */
    notify: boolean;
  }): Promise<{ conversationId: string; messageId: string }>;
}

export interface MorningBriefSenderDeps {
  db: Database.Database;
  getPort: () => MorningBriefConversationPort | null;
  markSent: (
    input: { day: string; runId: string; conversationId: string; messageId: string },
    now: number,
  ) => Promise<MarkMorningBriefSentResult>;
  /** Drop an observation the composer left out because of a stated preference. */
  suppressObservation: (id: string, now: number) => Promise<boolean>;
  /** Whether sending the brief also notifies the user's devices. */
  getPushEnabled: () => boolean;
  clock: () => number;
  log: Logger;
}

export type SendMorningBriefResult =
  | { sent: true; conversationId: string; messageId: string; shipped: string[] }
  | { sent: false; reason: "already_sent" | "conversation_unavailable" };

export async function sendMorningBrief(
  deps: MorningBriefSenderDeps,
  input: { day: string; runId: string; text: string; omittedObservationIds?: readonly string[] },
): Promise<SendMorningBriefResult> {
  if (morningBriefSent(deps.db, input.day)) return { sent: false, reason: "already_sent" };
  const port = deps.getPort();
  if (!port) return { sent: false, reason: "conversation_unavailable" };
  const listed = new Set(listMorningBriefItems(deps.db, input.day).map((i) => i.observationId));
  for (const id of input.omittedObservationIds ?? [])
    if (listed.has(id)) await deps.suppressObservation(id, deps.clock());
  const { conversationId, messageId } = await port.appendMorningBrief({
    day: input.day,
    runId: input.runId,
    text: input.text,
    notify: deps.getPushEnabled(),
  });
  const marked = await deps.markSent(
    { day: input.day, runId: input.runId, conversationId, messageId },
    deps.clock(),
  );
  if (!marked.ok) {
    deps.log.warn(`morning brief for ${input.day} was already recorded as sent`);
    return { sent: false, reason: "already_sent" };
  }
  deps.log.info(
    `Morning brief for ${input.day} sent as ${messageId} (${marked.shippedObservationIds.length} observation(s))`,
  );
  return { sent: true, conversationId, messageId, shipped: marked.shippedObservationIds };
}

/** Longest morning brief the tool accepts; a brief that needs more is too long. */
export const MORNING_BRIEF_MAX_CHARS = 6000;

const schema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(MORNING_BRIEF_MAX_CHARS)
      .describe("The complete morning brief message, in Markdown."),
    omittedObservationIds: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        "Ranked observations deliberately left out because the user's profile states a preference against them.",
      ),
  })
  .strict();

/** The morning run's one write: send today's brief. */
export function buildMorningBriefSendTool(
  deps: MorningBriefSenderDeps,
  run: { day: string; runId: string },
): ToolHandle {
  return {
    name: "morning_brief_send",
    description:
      "Send today's morning brief to the user. Call exactly once, with the complete message. " +
      "It is appended to the user's Morning brief conversation and the listed observations " +
      "are marked as shown.",
    schema,
    mutates: true,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success)
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      const result = await sendMorningBrief(deps, {
        ...run,
        text: parsed.data.text,
        ...(parsed.data.omittedObservationIds
          ? { omittedObservationIds: parsed.data.omittedObservationIds }
          : {}),
      });
      if (!result.sent)
        return {
          kind: "error",
          code: result.reason,
          message:
            result.reason === "already_sent"
              ? "Today's morning brief has already been sent. Do not send another."
              : "The conversation is unavailable right now; the run will retry.",
        };
      return {
        kind: "structured",
        resultType: "morning_brief.sent",
        data: { conversationId: result.conversationId, shippedObservations: result.shipped.length },
      };
    },
  };
}

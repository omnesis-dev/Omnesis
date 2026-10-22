// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `count_messages` — how many messages the user exchanged with each person
 * over a window, counted across every messaging source.
 *
 * A ranking question ("who have I been messaging most this week?") cannot be
 * answered from search hits: search returns the best-matching documents, and a
 * chat that rolls a day's hundred messages into one document is one hit, the
 * same as a day with a single message. This tool counts every message document
 * in the window instead, so the ranking is a count and not a sample.
 *
 * READ-ONLY. The window grammar is `temporal_query`'s.
 */

import { z } from "zod";
import { hostTimeZone } from "@omnesis/core";

import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";
import type { MessageCountPort } from "./types.js";

/** Hard cap on people returned by one call. */
export const COUNT_MESSAGES_MAX_LIMIT = 50;

export const countMessagesArgsSchema = z
  .object({
    from: z
      .string()
      .min(1)
      .describe(
        "Window start: an offset/Z ISO instant, YYYY-MM-DD, YYYY-MM, YYYY, " +
          'or a relative calendar expression such as -7d. "This week" is its Monday.',
      ),
    to: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Exclusive window end in the same formats, including "now" and relative "+7d". ' +
          "Omit to cover the whole `from` day, month or year, or, for any other " +
          "`from`, everything up to now.",
      ),
    timeZone: z
      .string()
      .min(1)
      .optional()
      .describe(
        "IANA time zone for dates and relative expressions. Defaults to the " +
          "caller's own zone — pass one only to ask about a different zone.",
      ),
    sourceIds: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        "Count only these sources. Omit to count every messaging source, which " +
          "is what a question that names no source wants.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(COUNT_MESSAGES_MAX_LIMIT)
      .optional()
      .describe("How many people to return, most messaged first (default 10)."),
  })
  .strict();

export type CountMessagesArgs = z.infer<typeof countMessagesArgsSchema>;

export interface CountMessagesToolDeps {
  port: MessageCountPort;
  /** Override the default number of people returned (default 10). */
  defaultLimit?: number;
}

export function createCountMessagesTool(deps: CountMessagesToolDeps): ToolHandle {
  const defaultLimit = deps.defaultLimit ?? 10;
  return {
    name: "count_messages",
    mutates: false,
    description:
      "Count the messages the user exchanged with each person over a date window, " +
      "across every messaging source (chats and email), and rank people by that " +
      "count. Use it for any question about who the user communicates with most or " +
      "least, or how much they talked with someone in a period — never rank people " +
      "by which documents a search happened to return. Each person carries " +
      "`messages` (their one-to-one conversations and the messages they were on), " +
      "`groupMessages` (activity in group conversations they belong to, shared by " +
      "the whole group — report it apart from `messages`), `documents`, and, where " +
      "the source records a sender, `sentByYou` / `sentByThem`: someone who only ever " +
      "sent to the user (sentByYou 0) is usually a newsletter or a notification " +
      "sender rather than a correspondent. `sources` lists what each source " +
      "contributed and whether it records a message count per document. Search or " +
      "fetch afterwards only to quote what was said. READ-ONLY.",
    schema: countMessagesArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      if (typeof a.from !== "string") return undefined;
      return typeof a.to === "string" ? `${a.from} … ${a.to}` : a.from;
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = countMessagesArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const args = parsed.data;
      try {
        const result = await deps.port.count(
          {
            from: args.from,
            ...(args.to ? { to: args.to } : {}),
            // The caller's zone, not the host's: "this week" is the asker's week.
            timeZone: args.timeZone ?? ctx.timeZone ?? hostTimeZone(),
            ...(args.sourceIds ? { sourceIds: args.sourceIds } : {}),
            limit: args.limit ?? defaultLimit,
          },
          ctx.abortSignal,
        );
        return { kind: "structured", resultType: "messages.counted", data: result };
      } catch (err) {
        return {
          kind: "error",
          code: "count_failed",
          message: (err as Error).message ?? "count_messages failed",
        };
      }
    },
  };
}

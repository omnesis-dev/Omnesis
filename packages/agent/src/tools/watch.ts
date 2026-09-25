// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The agent's watches: `watches_list`, `watch_get`, `watch_create`,
 * `watch_update`, `watch_delete`.
 *
 * The three write tools take the condition in **natural language** and let the
 * gateway's compiler turn it into an executable plan. The agent never writes a
 * predicate, a SQL string, or a spec: it says what to watch for, and reads back
 * the compiler's plain-language `interpretation` of what it understood. That
 * interpretation is the iteration loop — when it doesn't match what the user
 * meant, the agent restates the request and calls again, in the same
 * conversation, instead of guessing at spec syntax.
 *
 * A watch always reacts by pushing a notification to the user's own devices;
 * that is the only reaction this surface can express. Watches are live the
 * moment the call returns — no approval step, because the request came from the
 * user and the notification goes back to the user.
 *
 * The watch's name comes from the compiler rather than from the agent, so the
 * name spoken in the conversation is the one the phone, the portal and the CLI
 * all show.
 *
 * Every client renders a small "lightning" card from this result as soon as
 * the watch lands, so the user sees what was set up without asking.
 */

import { z } from "zod";

import { UNATTRIBUTED_CALLER } from "../backend.js";
import { WatchPortError, type WatchPort, type WatchPortResult } from "./types.js";
import type { ToolResult } from "@omnesis/core";

import type { ToolCaller, ToolContext, ToolHandle } from "../backend.js";

const NAME_MAX = 80;
const REQUEST_MAX = 2_000;
const SUMMARY_MAX = 120;

const notifySchema = z
  .object({
    title: z
      .string()
      .max(NAME_MAX)
      .optional()
      .describe("Notification title. Defaults to a neutral one."),
    body: z
      .string()
      .max(200)
      .optional()
      .describe(
        "Notification body. Keep it short — it lands on a lock screen, and it " +
          "should say what the user asked to be told about rather than what " +
          "the watch found.",
      ),
  })
  .strict();

const requestField = z
  .string()
  .min(1)
  .max(REQUEST_MAX)
  .describe(
    'What to watch for, in plain language — e.g. "when an email arrives about a ' +
      'contract renewal" or "when my resting heart rate over the last week is 10% ' +
      'above the previous three months". State the condition only; do not write a ' +
      "predicate, SQL, or any spec JSON. The gateway compiles this and returns its " +
      "reading of it, which you should relay to the user.",
  );

const summaryField = z
  .string()
  .max(SUMMARY_MAX)
  .optional()
  .describe(
    "Optional one-line caption for the card shown in the transcript. Omit it and " +
      "the compiler's own reading of the request is used, which is usually better.",
  );

const watchIdField = z
  .string()
  .min(1)
  .describe("Id of the watch, as returned by `watches_list` or `watch_create`.");

export const watchCreateArgsSchema = z
  .object({
    request: requestField,
    notify: notifySchema.optional(),
    summary: summaryField,
  })
  .strict();
export type WatchCreateArgs = z.infer<typeof watchCreateArgsSchema>;

export const watchUpdateArgsSchema = z
  .object({
    watchId: watchIdField,
    request: requestField,
    notify: notifySchema.optional(),
    summary: summaryField,
  })
  .strict();
export type WatchUpdateArgs = z.infer<typeof watchUpdateArgsSchema>;

export const watchDeleteArgsSchema = z.object({ watchId: watchIdField }).strict();
export const watchGetArgsSchema = z.object({ watchId: watchIdField }).strict();
export const watchesListArgsSchema = z.object({}).strict();

export interface WatchToolDeps {
  port: WatchPort;
}

/**
 * Who the port should answer for this call.
 *
 * A turn whose boundary could not say who opened it speaks for nobody — see
 * {@link UNATTRIBUTED_CALLER} for why that, and not the operator, is the safe
 * reading of an unidentified caller.
 */
function callerOf(ctx: ToolContext): ToolCaller {
  return ctx.caller ?? UNATTRIBUTED_CALLER;
}

/**
 * Shape a port result into the wire result the transcript cards render. The
 * card's secondary line falls back to the compiler's interpretation so the
 * user sees what was actually understood, not just the label.
 */
function toToolResult(result: WatchPortResult, summary: string | undefined): ToolResult {
  return {
    kind: "watch.upserted",
    watchId: result.watchId,
    name: result.name,
    action: result.action,
    enabled: result.enabled,
    summary: summary ?? result.interpretation,
    interpretation: result.interpretation,
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
}

function toErrorResult(err: unknown, fallback: string): ToolResult {
  if (err instanceof WatchPortError) {
    const { rejection } = err;
    return {
      kind: "error",
      code: rejection.reason === "uncompilable" ? rejection.code : rejection.reason,
      message: err.message,
    };
  }
  return {
    kind: "error",
    code: "internal_error",
    message: err instanceof Error ? err.message : fallback,
  };
}

/** Parse, or the tool-error result a bad call gets back. */
function parseArgs<T>(schema: z.ZodType<T>, raw: unknown): { ok: true; args: T } | ToolResult {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, args: parsed.data };
  return {
    kind: "error",
    code: "invalid_args",
    message: parsed.error.issues[0]?.message ?? "invalid arguments",
  };
}

function isParsed<T>(v: { ok: true; args: T } | ToolResult): v is { ok: true; args: T } {
  return "ok" in v;
}

export function createWatchCreateTool(deps: WatchToolDeps): ToolHandle {
  return {
    name: "watch_create",
    mutates: true,
    description:
      "Set up a new watch: describe in plain language what should be watched " +
      "for, and the gateway compiles it and starts watching immediately. The " +
      "reaction is always a push notification to the user's own devices. " +
      "Returns `watch.upserted` carrying `interpretation` — the gateway's " +
      "reading of your request — and the name it chose. ALWAYS relay both back " +
      "to the user so they can correct a misreading; if it's wrong, call this " +
      "again with a clearer request rather than trying to encode the condition " +
      "yourself. Errors with an `unsupported_condition` code mean the condition " +
      "can't be expressed — explain that plainly instead of retrying the same " +
      "phrasing. A `timed_out` error is worth one retry.",
    schema: watchCreateArgsSchema,
    summarize(): string {
      return "create";
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseArgs(watchCreateArgsSchema, rawArgs);
      if (!isParsed(parsed)) return parsed;
      try {
        const result = await deps.port.create(callerOf(ctx), {
          request: parsed.args.request,
          ...(parsed.args.notify ? { notify: parsed.args.notify } : {}),
        });
        return toToolResult(result, parsed.args.summary);
      } catch (err) {
        return toErrorResult(err, "watch create failed");
      }
    },
  };
}

export function createWatchUpdateTool(deps: WatchToolDeps): ToolHandle {
  return {
    name: "watch_update",
    mutates: true,
    description:
      "Rewrite an existing watch: supply the full condition in plain language " +
      "again (this replaces the old one, it does not merge with it) and " +
      "optionally new notification text. Only watches marked " +
      "`manageable: true` by `watches_list` can be rewritten. The watch keeps " +
      "its id. A rewrite starts watching from now, so it will not fire on " +
      "anything that has already happened. Returns the same `interpretation` " +
      "as `watch_create`; relay it.",
    schema: watchUpdateArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const id = (args as { watchId?: unknown }).watchId;
      return typeof id === "string" ? `update ${id}` : "update";
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseArgs(watchUpdateArgsSchema, rawArgs);
      if (!isParsed(parsed)) return parsed;
      try {
        const result = await deps.port.update(callerOf(ctx), {
          watchId: parsed.args.watchId,
          request: parsed.args.request,
          ...(parsed.args.notify ? { notify: parsed.args.notify } : {}),
        });
        return toToolResult(result, parsed.args.summary);
      } catch (err) {
        return toErrorResult(err, "watch update failed");
      }
    },
  };
}

export function createWatchDeleteTool(deps: WatchToolDeps): ToolHandle {
  return {
    name: "watch_delete",
    mutates: true,
    description:
      "Stop watching, and forget what this watch has said. Use it when the " +
      "user says they no longer want to be told about something. Irreversible " +
      "— the condition would have to be described again to bring it back — so " +
      "confirm which watch is meant when more than one could fit.",
    schema: watchDeleteArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const id = (args as { watchId?: unknown }).watchId;
      return typeof id === "string" ? `delete ${id}` : "delete";
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseArgs(watchDeleteArgsSchema, rawArgs);
      if (!isParsed(parsed)) return parsed;
      try {
        await deps.port.remove(callerOf(ctx), parsed.args.watchId);
        // No card for a removal: the transcript already shows the call, and a
        // card announcing something that is gone reads as something that is.
        return {
          kind: "structured",
          resultType: "watch.removed",
          data: { watchId: parsed.args.watchId },
        };
      } catch (err) {
        return toErrorResult(err, "watch delete failed");
      }
    },
  };
}

export function createWatchesListTool(deps: WatchToolDeps): ToolHandle {
  return {
    name: "watches_list",
    description:
      "List the user's watches: what each is watching for, whether it is " +
      "running, how many times it has fired and when it last did. Read this " +
      "before creating a watch the user may already have, and to find the id " +
      "`watch_update` / `watch_delete` need. Watches an external integration " +
      "asked for are not listed here.",
    schema: watchesListArgsSchema,
    summarize(): string {
      return "list";
    },
    async invoke(_rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      try {
        const watches = await deps.port.list(callerOf(ctx));
        return { kind: "watches.listed", watches: watches.map((w) => ({ ...w })) };
      } catch (err) {
        return toErrorResult(err, "listing watches failed");
      }
    },
  };
}

export function createWatchGetTool(deps: WatchToolDeps): ToolHandle {
  return {
    name: "watch_get",
    description:
      "Read one watch in full, including the condition the gateway is actually " +
      "deciding on and its recent firings. Use it to answer 'is my watch " +
      "working?' — a watch that has never fired is either waiting or " +
      "mis-stated, and the condition shown here is what tells the two apart.",
    schema: watchGetArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const id = (args as { watchId?: unknown }).watchId;
      return typeof id === "string" ? `get ${id}` : "get";
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseArgs(watchGetArgsSchema, rawArgs);
      if (!isParsed(parsed)) return parsed;
      try {
        const watch = await deps.port.get(callerOf(ctx), parsed.args.watchId);
        if (!watch) {
          return {
            kind: "error",
            code: "not_found",
            message: `no watch with id ${parsed.args.watchId}`,
          };
        }
        return { kind: "watch.fetched", watch: { ...watch, firings: [...watch.firings] } };
      } catch (err) {
        return toErrorResult(err, "reading the watch failed");
      }
    },
  };
}

/**
 * The verb that lets this surface check its own work.
 *
 * Writing a watch is the easy half. Knowing whether it will ever catch
 * anything is the hard one: a watch starts at the journal head, so its first
 * evidence arrives with its first match — and a watch whose filter admits
 * nothing produces exactly the silence of a quiet week. Without this, "your
 * watch is set up" was a claim with nothing behind it.
 */
export function createWatchProbeTool(deps: WatchToolDeps): ToolHandle {
  return {
    name: "watch_probe",
    description:
      "Try a watch against the recent past and see what it would have decided, " +
      "without waiting for it to fire. Use it right after creating or " +
      "rewriting one, before telling the user it is set up: it reports, per " +
      "node, how many events reached it and how many it took up, so a " +
      "condition that catches nothing is visible now rather than after a month " +
      "of silence. It stores nothing and asks no model, so a node with a judge " +
      "reports what would have reached the model rather than what it would say.",
    schema: watchGetArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const id = (args as { watchId?: unknown }).watchId;
      return typeof id === "string" ? `probe ${id}` : "probe";
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseArgs(watchGetArgsSchema, rawArgs);
      if (!isParsed(parsed)) return parsed;
      try {
        const probe = await deps.port.probe(callerOf(ctx), parsed.args.watchId);
        return {
          kind: "watch.probed",
          watchId: parsed.args.watchId,
          events: probe.events,
          from: probe.from,
          to: probe.to,
          firings: probe.firings,
          judgeGated: probe.judgeGated,
          nodes: probe.nodes.map((node) => ({
            nodeId: node.nodeId,
            evaluated: node.evaluated,
            matched: node.matched,
            wouldAsk: node.wouldAsk,
            diagnostics: [...node.diagnostics],
            samples: node.samples.map((sample) => ({ ...sample })),
          })),
        };
      } catch (err) {
        return toErrorResult(err, "trying the watch failed");
      }
    },
  };
}

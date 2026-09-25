// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Wire protocol between `auth-subprocess.ts` (NDJSON producer) and
 * `source-ws-handlers.ts` (consumer that forwards events to the gateway
 * as `auth.update` / `auth.complete`).
 *
 * Per-variant validation: the older discriminator-only
 * validator passed `{ type: "url" }` (no `url` field) as well-formed,
 * leaving the handler to spread `undefined` into the `auth.update` event.
 * `parseAuthSubprocessEvent()` runs zod against the full discriminated
 * union and returns null on shape mismatch so the consumer can log + drop
 * a malformed line instead of forwarding ghost events to the gateway.
 */
import { isAuthErrorCode, type AuthErrorCode } from "@omnesis/core";
import { z } from "zod";
import type { ConnectionState, WireChallenge } from "@omnesis/source-sdk";

export type AuthSubprocessEvent =
  | { type: "url"; url: string }
  | { type: "qr"; data: string }
  // Hosted-widget config handed to the client to render (auth type
  // `link-widget`). `kind` is the opaque source-declared widget id; `payload`
  // carries the string fields the widget needs (e.g. a `link_token`).
  | { type: "widget"; kind: string; payload: Record<string, string> }
  // A typed challenge from a provider that declares `authenticate`. One event
  // covers every kind, and `id` is what an answer refers back to — a flow can
  // put several questions to the operator, so a bare "the answer" would be
  // ambiguous the first time one arrived late.
  //
  // `expectsAnswer` distinguishes `show` from `ask`, which a client cannot
  // derive from the kind: a redirect is shown by a provider that reads its own
  // loopback callback and asked by one that will also take a pasted URL, and
  // they are the same kind carrying the same fields. Offering a client's answer
  // box on a shown challenge is worse than not offering it — nothing is reading
  // that side, so the operator types into a flow that then hangs.
  | { type: "challenge"; id: string; challenge: WireChallenge; expectsAnswer: boolean }
  // A single auth session resolves one or more account ids. The subprocess
  // always emits the `accountIds` array form (a scalar `authFlow` return is
  // normalised to a one-element array), so the consumer has one shape.
  //
  // `accountStates` is what the typed flow reported about each credential it
  // just established, keyed by account id. It is the one moment some platforms
  // state a consent deadline — an open-banking grant says how long it lasts
  // during the exchange and never again — so dropping it here meant the
  // contract's promise that the deadline is "not lost" was false. The older
  // entry point reports nothing and omits it.
  | {
      type: "complete";
      accountIds: string[];
      accountStates?: Record<string, ConnectionState>;
      // What went wrong without stopping the connection. A flow returns or it
      // throws; without this there is nowhere to report a step that could only
      // be taken once and was not, on an account that is otherwise connected.
      notices?: Array<{ title: string; detail?: string }>;
    }
  | {
      type: "error";
      error: string;
      code?: AuthErrorCode;
      fileKey?: string;
      providerName?: string;
      // What the operator could do about it. A code says what class of thing
      // went wrong; this is the sentence only the source can write — "sign out
      // of the app in your browser first", "create a read-only key". Without
      // it a typed failure is a category with no way out of it.
      remedy?: string;
      // How long to wait before trying again, when the platform said.
      retryAfterMs?: number;
    };

const urlEvent = z.object({
  type: z.literal("url"),
  url: z.string().min(1),
});

const qrEvent = z.object({
  type: z.literal("qr"),
  data: z.string().min(1),
});

const widgetEvent = z.object({
  type: z.literal("widget"),
  kind: z.string().min(1),
  payload: z.record(z.string(), z.string()),
});

// Validated per kind, not just structurally. A discriminator-only check is
// what let `{ type: "url" }` through without a `url` — the hole this module's
// header says the per-variant schemas were written to close — and the same
// hole reopens for a challenge whose kind promises a field it does not carry:
// the portal would render a link to `undefined`.
const challengeCommon = { title: z.string().min(1), instructions: z.string().optional() };

const wireChallenge = z.discriminatedUnion("kind", [
  z.object({
    ...challengeCommon,
    kind: z.literal("redirect"),
    url: z.string().min(1),
    via: z.enum({
      loopback: "loopback",
      gateway: "gateway",
      elsewhere: "elsewhere",
    } satisfies { [K in Extract<WireChallenge, { kind: "redirect" }>["via"]]: K }),
    expiresAt: z.string().optional(),
  }),
  z.object({
    ...challengeCommon,
    kind: z.literal("code"),
    pattern: z.string().optional(),
    patternHint: z.string().optional(),
  }),
  z.object({
    ...challengeCommon,
    kind: z.literal("qr"),
    data: z.string().min(1),
    expiresAt: z.string().optional(),
  }),
  z.object({
    ...challengeCommon,
    kind: z.literal("fields"),
    // The field shapes are the descriptor's own and are checked where they are
    // built; what matters here is that there is at least one to render.
    fields: z.array(z.object({ name: z.string().min(1) }).loose()).min(1),
    prefill: z.record(z.string().max(64), z.string().max(8192)).optional(),
  }),
  z.object({
    ...challengeCommon,
    kind: z.literal("widget"),
    renderer: z.string().min(1),
    payload: z.record(z.string(), z.string()),
  }),
  z.object({ ...challengeCommon, kind: z.literal("wait") }),
]);

const challengeEvent = z.object({
  type: z.literal("challenge"),
  id: z.string().min(1),
  challenge: wireChallenge,
  expectsAnswer: z.boolean(),
});

const completeEvent = z.object({
  type: z.literal("complete"),
  accountIds: z.array(z.string().min(1)).min(1),
  // Shape-checked only as far as the discriminator, because the state union
  // lives in the SDK and re-declaring it here would be a second copy to keep
  // in step. What consumes it reads one field.
  accountStates: z
    .record(z.string(), z.object({ status: z.string() }).passthrough())
    .optional()
    .catch(undefined),
  // `.catch(undefined)`: this rides on the terminal event. A title one
  // character too long would otherwise fail the whole parse, and a connected
  // account would be reported as a subprocess that crashed. Losing the
  // decoration costs only the decoration.
  notices: z
    .array(z.object({ title: z.string().min(1).max(200), detail: z.string().max(2000).optional() }))
    .max(8)
    .optional()
    .catch(undefined),
});

const errorEvent = z.object({
  type: z.literal("error"),
  error: z.string(),
  code: z
    .string()
    .optional()
    .refine((c) => c === undefined || isAuthErrorCode(c), { message: "invalid AuthErrorCode" }),
  fileKey: z.string().optional(),
  providerName: z.string().optional(),
  remedy: z.string().optional(),
  retryAfterMs: z
    .number()
    .int()
    .nonnegative()
    .max(7 * 24 * 3600_000)
    .optional(),
});

const authSubprocessEventSchema = z.discriminatedUnion("type", [
  urlEvent,
  qrEvent,
  widgetEvent,
  challengeEvent,
  completeEvent,
  errorEvent,
]);

/**
 * Per-variant validation. Returns the typed event on success, `null` on
 * any shape mismatch — caller logs and drops. Replaces the previous
 * `isAuthSubprocessEvent()` discriminator-only check.
 */
export function parseAuthSubprocessEvent(value: unknown): AuthSubprocessEvent | null {
  const result = authSubprocessEventSchema.safeParse(value);
  if (!result.success) return null;
  return result.data as AuthSubprocessEvent;
}

/** Back-compat boolean predicate. Prefer `parseAuthSubprocessEvent` at new call sites. */
export function isAuthSubprocessEvent(value: unknown): value is AuthSubprocessEvent {
  return parseAuthSubprocessEvent(value) !== null;
}

// ─── Inbound (parent → subprocess, NDJSON over stdin) ──────────────────────

/**
 * Messages the collector writes to the auth subprocess's stdin, one JSON
 * object per line:
 *
 *   - `init` is written immediately after spawn and carries the gateway
 *     flow id the subprocess exposes to the provider as
 *     `AuthFlowCallbacks.flowId` (for `state=` in authorize URLs), plus —
 *     on re-auth flows — the accountId being re-authenticated, exposed as
 *     `AuthFlowCallbacks.accountId`, plus — when the operator configured one
 *     — the gateway's externally-reachable HTTPS base URL, exposed as
 *     `AuthFlowCallbacks.publicBaseUrl` (so OAuth/aggregator providers build
 *     `${publicBaseUrl}/oauth/callback`).
 *   - `code` delivers a decoded, single-use authorization code that
 *     arrived at the gateway (`/oauth/callback` redirect, code POST, or
 *     CLI paste) and resolves the provider's pending `receiveCode()`.
 *   - `widget-result` delivers an opaque result token (e.g. a Plaid
 *     `public_token`) plus optional metadata that the client's hosted
 *     widget yielded, and resolves the provider's pending
 *     `receiveWidgetResult()`. A widget that yields several results delivers
 *     one `widget-result` per result.
 */
export type AuthSubprocessInbound =
  | {
      type: "init";
      flowId: string;
      accountId?: string;
      credentials?: Record<string, string>;
      publicBaseUrl?: string;
      // Which challenge kinds the client that started this flow can draw.
      // Omitted uses legacy capabilities; an empty list means none.
      renders?: string[];
    }
  // The flow is over and no answer is coming. Delivered rather than signalled,
  // so the provider's own failure path runs: one that has just created
  // something at a third party — a live, billed item it holds the only handle
  // to — has to be able to undo it, and a killed process undoes nothing.
  | { type: "abort"; reason: "cancelled" | "denied"; detail?: string }
  | { type: "code"; code: string }
  | { type: "widget-result"; token: string; metadata?: Record<string, unknown> }
  // The operator's answer to one typed challenge, addressed by the id the
  // `challenge` event carried.
  | { type: "answer"; id: string; answer: Record<string, unknown> };

const abortMessage = z.object({
  type: z.literal("abort"),
  reason: z.enum(["cancelled", "denied"]),
  detail: z.string().max(500).optional(),
});

const initMessage = z.object({
  type: z.literal("init"),
  flowId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  renders: z.array(z.string().min(1)).max(16).optional(),
  // Fields the user pasted for a `perAccount` credentials spec. Arrives on the
  // private stdin pipe rather than argv, which `/proc/<pid>/cmdline` exposes to
  // any local process. Already validated against the spec by the collector.
  credentials: z.record(z.string().min(1).max(64), z.string().max(8192)).optional(),
  // Externally-reachable HTTPS base URL of the gateway (no trailing slash),
  // from `gateway.publicBaseUrl`. Exposed to the provider's authFlow as
  // `callbacks.publicBaseUrl` so OAuth/aggregator sources build
  // `${publicBaseUrl}/oauth/callback`. Absent → local-only fallback.
  publicBaseUrl: z.string().url().optional(),
});

const codeMessage = z.object({
  type: z.literal("code"),
  code: z.string().min(1),
});

const widgetResultMessage = z.object({
  type: z.literal("widget-result"),
  token: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// One answered field. The same ceiling the pasted credential fields use, for
// the same reason: this is a channel a client fills, and an answer nobody can
// deliver is a flow that waits until it expires. A nested object is admitted
// only for a widget's metadata, which is the one shape that is not a scalar.
const answerValue = z.union([
  z.string().max(8192),
  z.number(),
  z.boolean(),
  z.null(),
  z.record(z.string().max(64), z.unknown()),
]);

const answerMessage = z.object({
  type: z.literal("answer"),
  id: z.string().min(1),
  // Bounded like the credential fields above and for the same reason: this
  // pipe carries whatever a client posted, and a flow that is waiting is a
  // flow an unbounded write would keep waiting.
  answer: z
    .record(z.string().min(1).max(64), answerValue)
    .refine((a) => Object.keys(a).length <= 32, {
      message: "an answer may carry at most 32 fields",
    }),
});

const authSubprocessInboundSchema = z.discriminatedUnion("type", [
  initMessage,
  abortMessage,
  codeMessage,
  widgetResultMessage,
  answerMessage,
]);

/**
 * Per-variant validation for inbound stdin messages. Returns the typed
 * message on success, `null` on any shape mismatch — the stdin receiver
 * ignores malformed lines.
 */
export function parseAuthSubprocessInbound(value: unknown): AuthSubprocessInbound | null {
  const result = authSubprocessInboundSchema.safeParse(value);
  if (!result.success) return null;
  return result.data;
}

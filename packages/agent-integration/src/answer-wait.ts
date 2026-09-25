// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import {
  GatewayRequestTimeoutError,
  IntegrationHttpError,
  type GatewayRequestOptions,
} from "./http.js";

/**
 * Asking Omnesis a question runs a full agent turn behind the privacy
 * boundary — a corpus search plus several model round-trips, then a privacy
 * review — so it is the one gateway call whose cost is measured in tens of
 * seconds rather than milliseconds. Two properties follow, and this module
 * exists to hold them together for every caller:
 *
 *  - The wait must be bounded by a budget that reflects that cost, not by the
 *    budget sized for ordinary reads.
 *  - Waiting longer must never mean paying twice. The request id is derived
 *    from the ask, so every repeat of the same ask — a retry after the socket
 *    budget elapsed, a re-delivered wake, a model calling the tool again —
 *    attaches to the turn already running instead of starting a second one.
 *    Repeating the request is therefore how you poll.
 *
 * Two asks use this contract. A firing answer is bound to the firing that
 * woke the agent; an integration answer is an ordinary question asked from a
 * harness conversation or a scheduled run. They differ only in what they post
 * and in how their identity is derived.
 */

/**
 * Budget for the first attempt. Wide enough that the answer normally arrives
 * on this one request, so the common case makes exactly one round trip.
 */
export const ANSWER_SUBMIT_TIMEOUT_MS = 180_000;
/** Budget for a poll. A poll either returns the finished answer or refuses fast. */
export const ANSWER_POLL_TIMEOUT_MS = 30_000;
/** Ceiling on the whole ask, across the first attempt and every poll after it. */
export const ANSWER_DEADLINE_MS = 420_000;

/** Canonical MCP path every ordinary integration answer posts to. */
const INTEGRATION_ANSWER_ENDPOINT = "/mcp";

/** How many times one blip may be re-attempted before it settles the ask. */
const TRANSIENT_RETRY_LIMIT = 2;
/** Long enough to clear a blip, short enough that a settled failure stays fast. */
const TRANSIENT_RETRY_DELAY_MS = 2_000;

const POLL_MIN_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 15_000;

/** Gateway code for "the turn for this request id is still running". */
const ANSWER_IN_PROGRESS = "ANSWER_IN_PROGRESS";
/**
 * Gateway code for "the turn limit is full right now". Distinct from a
 * gateway that is not serving, which is also a 503 and wants the opposite
 * response: this one means the work is about to be possible.
 */
const ANSWER_CAPACITY = "ANSWER_CAPACITY";

/** One ask, ready to post: where it goes, what it says, and who it is. */
interface AnswerWaitRequest {
  /** Gateway path this ask posts to. */
  endpoint: string;
  /**
   * The request body without its idempotency key. Every attempt posts this
   * same object, so nothing that varies per attempt may appear in it.
   */
  body: Record<string, unknown>;
  /** Derived identity for this one ask. Never invented per attempt. */
  requestId: string;
}

export interface AnswerWaitOptions {
  submitTimeoutMs?: number;
  pollTimeoutMs?: number;
  deadlineMs?: number;
  pollIntervalMs?: number;
  pollMaxIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Poster shape of {@link import("./http.js").PinnedGatewayHttpClient}. */
export interface AnswerPoster {
  postJson<T = unknown>(
    path: string,
    value: unknown,
    signal?: AbortSignal,
    options?: GatewayRequestOptions,
  ): Promise<T>;
}

/**
 * The deadline elapsed with the turn still running. The work is not lost: it
 * keeps running and asking the same question again returns its result.
 */
export class AnswerPendingError extends Error {
  constructor(readonly waitedMs: number) {
    super(
      "NOT AN ANSWER, AND NOT A FAILURE — DO NOT REPORT THIS TO THE USER. " +
        `Omnesis is still preparing the answer after ${Math.round(waitedMs / 1000)}s and the ` +
        "work is still running. Call this tool again now with the identical question. The " +
        "repeat attaches to the answer already being prepared rather than starting new work, " +
        "so it costs nothing and one of those repeats returns the answer. Keep calling until " +
        "you get one; telling the user the answer is still being prepared is never the right " +
        "next step.",
    );
    this.name = "AnswerPendingError";
  }
}

function digest(parts: readonly (string | null)[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 48);
}

/** Ask bound to the firing that woke the agent. */
export interface FiringAnswerRequest {
  /** Firing-bound answer endpoint carried by the wake. */
  endpoint: string;
  question: string;
  /** Set when asking a follow-up within an existing answer conversation. */
  conversationId?: string;
}

/**
 * Idempotency key for one firing ask — derived, never invented, so a repeat of
 * the same ask is recognisable as the same ask.
 *
 * A current gateway derives this identity itself and ignores whatever key it is
 * sent, which is what makes the no-second-turn guarantee hold for every client
 * rather than only well-behaved ones. Sending a derived key anyway costs
 * nothing and carries the same guarantee against a gateway that predates that
 * behavior — agent hosts run their own upgrade cycle, so the two sides of this
 * conversation are routinely on different versions.
 */
export function firingAnswerRequestId(request: FiringAnswerRequest): string {
  return `firing_${digest([request.endpoint, request.question, request.conversationId ?? null])}`;
}

/** Ordinary ask from a harness conversation or a scheduled run. */
export interface IntegrationAnswerRequest {
  /**
   * The harness run this ask belongs to. It is what separates one scheduled
   * run from the next: today's cron run and tomorrow's ask the same question,
   * and only a per-run generation stops the second one from being served
   * yesterday's stored answer.
   */
  runGeneration: string;
  /**
   * What makes this ask distinct within its run.
   *
   * A scheduled run leaves it unset, so every ask it makes for one question is
   * the same ask: a model that re-asks to hurry the answer along attaches to
   * the turn already running instead of buying a second one.
   *
   * A conversation sets it per tool call, because a person who asks the same
   * question again an hour later wants today's answer, not the stored one. A
   * conversation lasts as long as the person keeps talking, so keying on it
   * alone would serve the first answer for the life of the session.
   */
  askId?: string;
  question: string;
  /** Set when asking a follow-up within an existing answer conversation. */
  conversationId?: string;
  workflowId?: string;
  workflowName?: string;
  workflowPurpose?: string;
  /**
   * Whether this ask may be held for a human decision. A scheduled run has
   * nobody present to decide, so it asks for a settled outcome instead.
   */
  approval?: "allow" | "never";
}

/**
 * Idempotency key for one ordinary ask. Derived from the run, what makes the
 * ask distinct within it, the question, and the answer conversation — so every
 * attempt at one ask attaches to the turn already running, while the next run
 * of a schedule, and a person asking again later, each get a fresh answer.
 */
export function integrationAnswerRequestId(request: IntegrationAnswerRequest): string {
  // Every field the gateway folds into its own request fingerprint must be
  // here too. A repeat that varied one of them would carry this same id with
  // different content, which the gateway rejects as a conflict rather than
  // recognising as the poll it is.
  return `integration_${digest([
    request.runGeneration,
    request.askId ?? null,
    request.question,
    request.conversationId ?? null,
    request.workflowId ?? null,
    request.workflowName ?? null,
    request.workflowPurpose ?? null,
    request.approval ?? null,
  ])}`;
}

/**
 * The handle a completion route is filed under for one ordinary ask. Derived
 * from the same identity as the request, so a repeat inside one run binds the
 * route it already prepared rather than orphaning it and opening another.
 */
export function integrationAnswerConversationHandle(request: IntegrationAnswerRequest): string {
  return `native_${digest(["native", integrationAnswerRequestId(request)])}`;
}

/**
 * The handle a firing ask leaves behind so a held answer can find its way back.
 *
 * A firing answer runs in a one-shot background turn that ends the moment the
 * gateway says the answer is held for approval. Without a handle the approval
 * lands later with nowhere to go and the answer waits forever — the run that
 * asked is gone, and nothing else is responsible for it.
 *
 * Derived from the ask rather than invented, for the same reason its request id
 * is: the same firing asked the same question twice must produce the same
 * handle, so a repeat resumes one route instead of opening a second.
 */
export function firingAnswerConversationHandle(request: FiringAnswerRequest): string {
  return `native_${digest(["native-firing", firingAnswerRequestId(request)])}`;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * True when the gateway is still working on this exact ask. Both shapes mean
 * the same thing — the turn is running — and both are resolved by asking
 * again, because the derived request id attaches the repeat to that same turn.
 */
function stillRunning(err: unknown): boolean {
  if (err instanceof GatewayRequestTimeoutError) return true;
  if (!(err instanceof IntegrationHttpError)) return false;
  if (err.status === 409 && err.code === ANSWER_IN_PROGRESS) return true;
  // At capacity is a "not yet", not a "no": the gateway is saying a turn
  // will be free shortly, which is what the wait budget is for. Treated as
  // settled, it ends a scheduled ask with minutes of that budget unspent.
  return (err.status === 503 || err.status === 429) && err.code === ANSWER_CAPACITY;
}

/**
 * A rejection worth one more attempt rather than one that settles the ask.
 *
 * A healthy gateway occasionally rejects a single attempt in a way that cannot
 * be explained by the ask: a 404 on a route that is serving requests either
 * side of it, or a server-side error. Asking again immediately has succeeded
 * every time it has been observed. Left unretried, one such blip ends a
 * scheduled report with "Omnesis is unavailable" for the day.
 *
 * Retries are few and quick, so a rejection that really is settled — the
 * feature genuinely disabled, say — still reaches the caller in seconds
 * rather than being hidden behind a long wait.
 */
function worthAnotherAttempt(err: unknown): boolean {
  if (!(err instanceof IntegrationHttpError)) return false;
  return err.status === 404 || err.status >= 500;
}

/**
 * Post one ask and wait for it, without ever paying for it twice. Resolves
 * with the gateway's answer response — released, reduced, held for approval,
 * or denied — and throws only when the ask cannot be completed at all.
 */
async function waitForAnswer(
  http: AnswerPoster,
  request: AnswerWaitRequest,
  options: AnswerWaitOptions = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const submitTimeoutMs = options.submitTimeoutMs ?? ANSWER_SUBMIT_TIMEOUT_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? ANSWER_POLL_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? ANSWER_DEADLINE_MS;
  const minIntervalMs = options.pollIntervalMs ?? POLL_MIN_INTERVAL_MS;
  const maxIntervalMs = options.pollMaxIntervalMs ?? POLL_MAX_INTERVAL_MS;

  const body = { ...request.body, clientRequestId: request.requestId };

  const startedAt = now();
  const deadline = startedAt + deadlineMs;
  let interval = minIntervalMs;
  let retriesLeft = TRANSIENT_RETRY_LIMIT;

  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new AnswerPendingError(now() - startedAt);
    const budget = Math.min(attempt === 0 ? submitTimeoutMs : pollTimeoutMs, remaining);
    try {
      return await http.postJson<unknown>(request.endpoint, body, signal, { timeoutMs: budget });
    } catch (err) {
      if (!stillRunning(err)) {
        if (retriesLeft <= 0 || !worthAnotherAttempt(err)) throw err;
        retriesLeft -= 1;
        const untilDeadline = deadline - now();
        if (untilDeadline <= 0) throw err;
        await sleep(Math.min(TRANSIENT_RETRY_DELAY_MS, untilDeadline), signal);
        continue;
      }
      const untilDeadline = deadline - now();
      if (untilDeadline <= 0) throw new AnswerPendingError(now() - startedAt);
      await sleep(Math.min(interval, untilDeadline), signal);
      interval = Math.min(interval * 2, maxIntervalMs);
    }
  }
}

/** Ask a firing what it saw, under the shared contract. */
export function requestFiringAnswer(
  http: AnswerPoster,
  request: FiringAnswerRequest,
  options: AnswerWaitOptions = {},
  signal?: AbortSignal,
): Promise<unknown> {
  return waitForAnswer(
    http,
    {
      endpoint: request.endpoint,
      requestId: firingAnswerRequestId(request),
      body: {
        question: request.question,
        // Where an answer held for approval is delivered once it is released.
        // The gateway binds this to the authenticated device, so it says which
        // conversation to resume and never who may be resumed.
        nativeConversationId: firingAnswerConversationHandle(request),
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      },
    },
    options,
    signal,
  );
}

/**
 * Ask an ordinary question from a harness conversation or a scheduled run,
 * under the shared contract. The native MCP client carries the completion
 * route handle as trusted request metadata, outside the model-facing tool
 * arguments, so a result that resolves after this call still knows where it
 * belongs.
 */
export function requestIntegrationAnswer(
  http: AnswerPoster,
  request: IntegrationAnswerRequest,
  options: AnswerWaitOptions = {},
  signal?: AbortSignal,
): Promise<unknown> {
  return waitForAnswer(
    http,
    {
      endpoint: INTEGRATION_ANSWER_ENDPOINT,
      requestId: integrationAnswerRequestId(request),
      body: {
        question: request.question,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.workflowId ? { workflowId: request.workflowId } : {}),
        ...(request.workflowName ? { workflowName: request.workflowName } : {}),
        ...(request.workflowPurpose ? { workflowPurpose: request.workflowPurpose } : {}),
        ...(request.approval ? { approval: request.approval } : {}),
      },
    },
    options,
    signal,
  );
}

/**
 * What a non-released outcome means, in words an agent can relay. A held or
 * denied answer is a decision the privacy boundary made, not a fault — an
 * agent that reports it as a failure tells the user their watch is broken
 * when in fact it is waiting on them.
 */
export function describeAnswerOutcome(response: unknown): string | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const record = response as Record<string, unknown>;
  switch (record.status) {
    case "approval_required":
      return (
        "Omnesis is holding this answer for the user's approval and has already asked them " +
        "for it in the Omnesis app. This is not a failure and asking again will not release " +
        "it. You have NOT been told what Omnesis found, so do not state or imply that you " +
        "know it — anything you say about the cause would be your own guess from the wake, " +
        "not Omnesis's answer. Say only that the detail is waiting on their approval, and " +
        "that it will reach you once they give it."
      );
    case "denied":
      // A run that asked for a settled outcome gets this instead of a hold.
      // It is the privacy boundary working, so the surrounding work should
      // still finish rather than report the run as broken.
      return record.reason === "approval_not_available"
        ? "Omnesis could not include this without an interactive approval, and this run has " +
            "nobody present to give one. Complete the rest of the work and say only that one " +
            "part could not be included without the user's approval."
        : "Omnesis withheld this answer under the user's privacy policy. This is a settled " +
            "decision, not a failure: do not ask again or try to work around it. Complete the " +
            "rest of the work and tell the user Omnesis kept that detail private.";
    case "released_with_reductions":
      return "Omnesis released this answer with some detail removed under the user's privacy policy.";
    default:
      return null;
  }
}

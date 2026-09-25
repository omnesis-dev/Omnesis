// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * NDJSON stdin receiver used by `auth-subprocess.ts`. Mirrors
 * `auth-subprocess-emit.ts` on the inbound side: the collector parent
 * writes `init` / `code` messages (see `AuthSubprocessInbound` in
 * `auth-subprocess-protocol.ts`) to the subprocess's stdin, and this
 * module turns them into the `flowId` / `receiveCode` values the
 * provider's `AuthFlowCallbacks` consume.
 *
 * Extracted to its own module so the framing and timeout semantics can
 * be unit-tested without importing the subprocess script (which runs
 * `await` and `process.exit` at module-load time).
 */

import { parseAuthSubprocessInbound } from "./auth-subprocess-protocol.js";
import type { Readable } from "node:stream";

/** Default wait for the parent's `init` line before giving up on a flow id. */
const DEFAULT_INIT_TIMEOUT_MS = 5_000;

/** Default wait for an authorization code once a provider asks for one. */
const DEFAULT_CODE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Why a wait for an answer ended without one.
 *
 * Named rather than described, because the caller has to choose a failure code
 * and these take different ones. Nobody came back in time is worth retrying;
 * the channel being torn down under the wait is the flow having been stopped;
 * and someone reaching a consent screen and refusing is the opposite of a
 * platform that could not be reached. Reading any of that off the message text
 * is the substring-matching the typed vocabulary exists to remove — moving it
 * from a consumer into a producer would not have made it less of one.
 */
export type AnswerWaitFailure = "closed" | "timed-out" | "cancelled" | "denied";

export class AnswerUnavailable extends Error {
  readonly reason: AnswerWaitFailure;

  constructor(reason: AnswerWaitFailure, message: string) {
    super(message);
    this.name = "AnswerUnavailable";
    this.reason = reason;
  }
}

/** A hosted-widget result token + optional metadata (see `widget-result`). */
export interface WidgetResult {
  token: string;
  metadata?: Record<string, unknown>;
}

export interface StdinReceiver {
  /**
   * The flow id from the parent's `init` message. Resolves `undefined`
   * when no init arrives within the timeout or the stream ends first —
   * providers that run their own localhost callback listener don't need
   * one, so absence is not an error.
   */
  flowId(): Promise<string | undefined>;
  /**
   * The accountId from the parent's `init` message — set when the flow
   * is a re-auth of an existing account. Resolves `undefined` on
   * first-time add flows and under the same timeout / stream-end rules
   * as `flowId()`.
   */
  accountId(): Promise<string | undefined>;
  /**
   * Fields the user pasted for a `perAccount` credentials spec, from the
   * parent's `init` message. Resolves `undefined` for every provider whose
   * credential is shared across accounts, under the same timeout /
   * stream-end rules as `flowId()`.
   */
  credentials(): Promise<Record<string, string> | undefined>;
  /**
   * The gateway's externally-reachable HTTPS base URL (no trailing slash)
   * from the parent's `init` message — set only when the operator
   * configured `gateway.publicBaseUrl`. OAuth/aggregator providers build
   * `${publicBaseUrl}/oauth/callback` from it. Resolves `undefined` when
   * unset (provider keeps the local-only fallback) under the same timeout /
   * stream-end rules as `flowId()`.
   */
  publicBaseUrl(): Promise<string | undefined>;
  /**
   * Which challenge kinds the client that started this flow can draw.
   *
   * `undefined` when the client did not say, which a caller reads as the
   * default set rather than as none.
   */
  renders(): Promise<string[] | undefined>;
  /**
   * The first `code` message on the stream (duplicates are ignored —
   * first wins). Rejects after the code timeout, or when the stream
   * ends before any code arrived.
   */
  receiveCode(): Promise<string>;
  /**
   * The next unconsumed `widget-result` message (FIFO). Unlike
   * `receiveCode`, a hosted-widget session can deliver several results —
   * one per selected institution — so each call consumes one. A result
   * that arrives before any waiter is buffered for the next call. Rejects
   * after the code timeout, or when the stream ends before a result
   * arrives for a pending call.
   */
  receiveWidgetResult(): Promise<WidgetResult>;

  /**
   * Wait for the answer to one typed challenge.
   *
   * Addressed by id rather than taken from a queue: a flow can put several
   * questions to the operator, and an answer that arrives after the operator
   * went back and changed an earlier one would otherwise resolve the wrong
   * wait.
   */
  receiveAnswer(id: string): Promise<Record<string, unknown>>;
}

export interface StdinReceiverOptions {
  /** Override the 5s init wait (tests). */
  initTimeoutMs?: number;
  /** Override the 10-minute code wait (tests). */
  codeTimeoutMs?: number;
}

/**
 * Start consuming NDJSON frames from `stream` immediately. Frames may be
 * split across chunks; malformed lines are ignored. Safe to call
 * `flowId()` / `receiveCode()` before or after the corresponding message
 * arrives — early messages are buffered.
 */
/**
 * Largest partial (newline-less) stdin line held before it is discarded.
 * Bounds memory against a parent that opens a line and never closes it.
 */
const MAX_PENDING_LINE_BYTES = 1_000_000;

export function createStdinReceiver(
  stream: Readable,
  options: StdinReceiverOptions = {},
): StdinReceiver {
  const initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  const codeTimeoutMs = options.codeTimeoutMs ?? DEFAULT_CODE_TIMEOUT_MS;

  let receivedCode: string | undefined;
  let ended = false;
  let buffer = "";

  const codeWaiters: Array<{ resolve: (code: string) => void; reject: (err: Error) => void }> = [];

  // Hosted-widget results are a FIFO queue, not a first-wins latch: one
  // session can deliver N results (one per institution). A result that
  const answerWaiters = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  const answerQueue = new Map<string, Record<string, unknown>>();
  // arrives with no pending waiter is buffered; a `receiveWidgetResult()`
  // with no buffered result parks a waiter.
  const widgetResultQueue: WidgetResult[] = [];
  const widgetWaiters: Array<{
    resolve: (r: WidgetResult) => void;
    reject: (err: Error) => void;
  }> = [];

  // Shared init promise: settles on the init message, stream end, or the
  // init timeout — whichever comes first. The timer is unref'd so an
  // idle wait can't pin the subprocess alive on its own.
  interface InitFields {
    flowId?: string;
    accountId?: string;
    credentials?: Record<string, string>;
    publicBaseUrl?: string;
    renders?: string[];
  }
  let settleInit: (init: InitFields) => void;
  const initPromise = new Promise<InitFields>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({});
      }
    }, initTimeoutMs);
    timer.unref?.();
    settleInit = (init) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(init);
    };
  });

  const handleLine = (line: string): void => {
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // malformed line — ignore
    }
    const message = parseAuthSubprocessInbound(parsed);
    if (!message) return; // wrong shape — ignore
    if (message.type === "init") {
      settleInit({
        flowId: message.flowId,
        accountId: message.accountId,
        credentials: message.credentials,
        publicBaseUrl: message.publicBaseUrl,
        renders: message.renders,
      });
      return;
    }
    if (message.type === "answer") {
      const waiter = answerWaiters.get(message.id);
      if (waiter) {
        answerWaiters.delete(message.id);
        waiter.resolve(message.answer);
      } else {
        // The answer beat the wait. Held rather than dropped, because the
        // provider is about to ask for exactly this id.
        answerQueue.set(message.id, message.answer);
      }
      return;
    }
    if (message.type === "abort") {
      abortWaiters(message.reason, message.detail);
      return;
    }
    if (message.type === "widget-result") {
      const result: WidgetResult = { token: message.token, metadata: message.metadata };
      const waiter = widgetWaiters.shift();
      if (waiter) waiter.resolve(result);
      else widgetResultQueue.push(result);
      return;
    }
    // code: first wins, duplicates ignored.
    if (receivedCode !== undefined) return;
    receivedCode = message.code;
    for (const waiter of codeWaiters.splice(0)) waiter.resolve(message.code);
  };

  /**
   * The flow is over and no answer is coming.
   *
   * Every wait rejects with the reason, so the provider's own failure path runs
   * — a provider that has just created something at a third party has to be
   * able to undo it, and until this existed the only way to end a flow early
   * was to kill the process, which undoes nothing.
   */
  const abortWaiters = (reason: AnswerWaitFailure, detail?: string): void => {
    const message = detail ?? (reason === "denied" ? "access was refused" : "the flow was stopped");
    // Latched, so a wait *started* after this rejects at once. A provider's
    // failure path may well ask again — that is what the grace period is for —
    // and without the latch it would park for the full answer timeout on a
    // channel nobody is going to write to.
    aborted = { reason, message };
    const err = new AnswerUnavailable(reason, message);
    for (const waiter of codeWaiters.splice(0)) waiter.reject(err);
    for (const waiter of widgetWaiters.splice(0)) waiter.reject(err);
    for (const waiter of answerWaiters.values()) waiter.reject(err);
    answerWaiters.clear();
  };

  let aborted: { reason: AnswerWaitFailure; message: string } | null = null;

  const handleEnd = (): void => {
    if (ended) return;
    ended = true;
    if (buffer.trim()) handleLine(buffer.trim());
    buffer = "";
    settleInit({});
    if (receivedCode === undefined) {
      const err = new AnswerUnavailable("closed", "auth code channel closed before a code arrived");
      for (const waiter of codeWaiters.splice(0)) waiter.reject(err);
    }
    if (widgetWaiters.length > 0) {
      const err = new AnswerUnavailable(
        "closed",
        "widget-result channel closed before a result arrived",
      );
      for (const waiter of widgetWaiters.splice(0)) waiter.reject(err);
    }
    if (answerWaiters.size > 0) {
      const err = new AnswerUnavailable("closed", "answer channel closed before an answer arrived");
      for (const waiter of answerWaiters.values()) waiter.reject(err);
      answerWaiters.clear();
    }
  };

  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      handleLine(buffer.slice(0, idx).trim());
      buffer = buffer.slice(idx + 1);
    }
    // A line only completes at a newline, so an unterminated one accumulates
    // unbounded. Every legitimate message is far below this; a partial line
    // past it can never become valid, so drop it rather than grow.
    if (buffer.length > MAX_PENDING_LINE_BYTES) {
      buffer = "";
    }
  });
  stream.on("end", handleEnd);
  stream.on("error", handleEnd);

  return {
    flowId: () => initPromise.then((init) => init.flowId),
    accountId: () => initPromise.then((init) => init.accountId),
    credentials: () => initPromise.then((init) => init.credentials),
    publicBaseUrl: () => initPromise.then((init) => init.publicBaseUrl),
    renders: () => initPromise.then((init) => init.renders),
    receiveAnswer: (id: string) => {
      if (aborted) return Promise.reject(new AnswerUnavailable(aborted.reason, aborted.message));
      const queued = answerQueue.get(id);
      if (queued !== undefined) {
        answerQueue.delete(id);
        return Promise.resolve(queued);
      }
      if (ended) {
        return Promise.reject(
          new AnswerUnavailable("closed", "answer channel closed before an answer arrived"),
        );
      }
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        // The same deadline the code channel keeps. Without one the only bound
        // is the parent's thirty-minute inactivity watchdog, so an operator
        // who closed the tab leaves the flow parked three times as long and
        // the failure they eventually see says "timeout" rather than what was
        // being waited for.
        const timer = setTimeout(() => {
          answerWaiters.delete(id);
          reject(
            new AnswerUnavailable(
              "timed-out",
              `timed out after ${Math.round(codeTimeoutMs / 60_000)}m waiting for an answer`,
            ),
          );
        }, codeTimeoutMs);
        timer.unref?.();
        answerWaiters.set(id, {
          resolve: (value: Record<string, unknown>) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    },
    receiveCode: () => {
      if (aborted) return Promise.reject(new AnswerUnavailable(aborted.reason, aborted.message));
      if (receivedCode !== undefined) return Promise.resolve(receivedCode);
      if (ended) {
        return Promise.reject(
          new AnswerUnavailable("closed", "auth code channel closed before a code arrived"),
        );
      }
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = codeWaiters.indexOf(waiter);
          if (i !== -1) codeWaiters.splice(i, 1);
          reject(
            new AnswerUnavailable(
              "timed-out",
              `timed out after ${Math.round(codeTimeoutMs / 60_000)}m waiting for the authorization code`,
            ),
          );
        }, codeTimeoutMs);
        timer.unref?.();
        const waiter = {
          resolve: (code: string) => {
            clearTimeout(timer);
            resolve(code);
          },
          reject: (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        codeWaiters.push(waiter);
      });
    },
    receiveWidgetResult: () => {
      if (aborted) return Promise.reject(new AnswerUnavailable(aborted.reason, aborted.message));
      const buffered = widgetResultQueue.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (ended) {
        return Promise.reject(
          new AnswerUnavailable("closed", "widget-result channel closed before a result arrived"),
        );
      }
      return new Promise<WidgetResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = widgetWaiters.indexOf(waiter);
          if (i !== -1) widgetWaiters.splice(i, 1);
          reject(
            new AnswerUnavailable(
              "timed-out",
              `timed out after ${Math.round(codeTimeoutMs / 60_000)}m waiting for the widget result`,
            ),
          );
        }, codeTimeoutMs);
        timer.unref?.();
        const waiter = {
          resolve: (r: WidgetResult) => {
            clearTimeout(timer);
            resolve(r);
          },
          reject: (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        widgetWaiters.push(waiter);
      });
    },
  };
}

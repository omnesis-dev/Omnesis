// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * In-memory registry of cross-device auth flows.
 *
 * A flow is started by an admin client (CLI / portal / iOS) calling
 * POST /admin/auth-flows. The gateway forwards an `auth.begin`
 * command to the target collector, which:
 *
 *   - Browser-OAuth providers (Google today): spawns the auth subprocess and
 *     streams `auth.update` events ({type: "url"|"qr", ...}) followed by an
 *     `auth.complete` event (ok=true with accountId, or ok=false with error).
 *   - Device-grant providers (Google/Microsoft, follow-up): returns a
 *     verification URL + user code via `auth.update`.
 *   - PKCE + custom URL scheme (Notion, Strava, follow-up): returns an
 *     `authUrl`; iOS catches `omnesis://oauth/callback` and POSTs the code to
 *     `/admin/auth-flows/:id/code`.
 *   - LAN-local callback (gateway hosts `/oauth/callback`): routes by
 *     `flowId` query param.
 *
 * Subscribers (typically the SSE endpoint per flowId) get re-emitted every
 * collector event so admin UIs can stream URL/QR/error/complete in real time.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@omnesis/core";
import type { WireChallenge } from "@omnesis/source-sdk";
import type { AuthErrorCode } from "@omnesis/core";
import type { DeviceId, SourceType, AccountId } from "@omnesis/types";

const log = createLogger("gateway:auth-flows");

export type AuthFlowState =
  | "starting"
  | "awaiting-user" // user must enter code / open URL
  | "awaiting-callback" // PKCE: gateway is waiting for the code POST
  | "completing" // exchanging code for tokens
  | "completed"
  | "error";

/** Event types emitted to SSE subscribers. Mirrors the collector's auth-subprocess output. */
export type AuthFlowEventType =
  | "url"
  | "qr"
  | "widget"
  | "challenge"
  | "info"
  | "complete"
  | "error"
  | "snapshot";

export interface AuthFlowEvent {
  type: AuthFlowEventType;
  /** OAuth URL the user must open (for type="url"). */
  url?: string;
  /** QR payload (for type="qr"). */
  data?: string;
  /**
   * Hosted-widget id (for type="widget") — the opaque, source-declared widget
   * kind the client renders generically (e.g. "snaptrade-connect").
   */
  kind?: string;
  /**
   * Hosted-widget config payload (for type="widget") — the string fields the
   * widget needs (e.g. a short-lived `link_token`).
   */
  payload?: Record<string, string>;
  /** Free-form message. */
  message?: string;
  /**
   * A typed challenge from a flow that declares `authenticate` (type
   * "challenge"). Carried whole: it names its own kind and carries its own
   * words, so nothing between the source and the operator has to know which
   * platform produced it.
   */
  challenge?: WireChallenge;
  /**
   * Whether an answer is expected back (type "challenge").
   *
   * `show` and `ask` produce the same event with the same kind, so this is the
   * only thing telling a client whether to offer a way to answer. A client
   * that guesses from the kind gets a redirect wrong in both directions: one
   * provider reads its own loopback callback and wants nothing back, another
   * also takes the redirect URL pasted by hand.
   */
  expectsAnswer?: boolean;
  /**
   * Identifies the challenge an answer refers back to (type "challenge").
   *
   * Named `id`, not `challengeId`, because the field a client reads has to be
   * the field the producer wrote. Renaming it in the middle is one way a
   * challenge reaches a client with everything intact except the one value it
   * needs to answer.
   *
   * Forgetting it is the other, and the likelier: the handler that ingests
   * this event does not forward it whole. It builds a new object from a fixed
   * list of fields, so a field added to the event and not to that list is
   * dropped in the middle of a path whose every other hop carries it. See
   * `WsEventHandler`, and the suite that asserts the crossing field by field.
   */
  id?: string;
  /** First account ID resolved on success (for type="complete"). */
  accountId?: string;
  /**
   * All account IDs resolved on success (for type="complete"). A
   * one-session → many-institutions hosted-widget flow resolves several;
   * single-account flows resolve one. `accountId` mirrors the first.
   */
  accountIds?: string[];
  /**
   * What the flow said about each credential it established, keyed by account
   * id (type "complete", typed flows only).
   *
   * A client shows it: after renewing an open-banking consent the operator is
   * told how long the new one lasts, which is stated during the exchange and
   * nowhere else. It is not the durable record of that deadline — a source
   * reports that on its sync pages, which is the channel the expiry warning
   * already reads.
   */
  accountStates?: Record<string, { status: string; [key: string]: unknown }>;
  /**
   * What went wrong without stopping the connection (type "complete").
   *
   * A flow returns or it throws, and one step in one source can only be taken
   * once, in a window minutes wide, at a cost the operator would want to hear
   * about. Shown beside the success, because someone told only "connected" has
   * no reason to look again.
   */
  notices?: Array<{ title: string; detail?: string }>;
  /** Error string (for type="error" or type="complete" + ok=false). */
  error?: string;
  /**
   * Structured error code from `AUTH_ERROR_CODES` in core. Lets admin
   * clients exhaustively switch on the code (with `assertNever` over the
   * `AuthErrorCode` union) and route to the right recovery — rather than
   * string-comparing a producer-coupled magic literal.
   */
  code?: AuthErrorCode;
  /**
   * What the operator could do about a failure, in the source's own words.
   *
   * The code says what class of thing went wrong and a client can act on it;
   * this is the sentence only the source can write. For a platform with no
   * account chooser, "sign out in your browser first" is not advice — it is
   * the entire recovery, and a code cannot carry it.
   */
  remedy?: string;
  /**
   * How long to wait before trying again, when the platform said (type
   * "complete" / "error"). The difference between telling an operator to come
   * back and telling them when.
   */
  retryAfterMs?: number;
  /** Credentials fileKey (set with code === "missing-credentials"). */
  fileKey?: string;
  /** Provider name (set with code === "missing-credentials"). */
  providerName?: string;
  /** Final outcome marker; only set on the terminal `complete` event. */
  ok?: boolean;
  /** Snapshot of the current AuthFlow record (for type="snapshot"). */
  flow?: AuthFlow;
}

export interface AuthFlow {
  id: string;
  sourceType: SourceType;
  accountId?: AccountId;
  deviceId: DeviceId;
  state: AuthFlowState;
  /** OAuth authorization URL for the user to open. */
  authUrl?: string;
  /** Latest QR payload, if any. */
  qrData?: string;
  /** Collector-supplied human-readable status text. */
  message?: string;
  /** Created timestamp (ms). */
  createdAt: number;
  /** Last update timestamp (ms). */
  updatedAt: number;
  /** Latest hosted-widget config (kind + payload), if the flow emitted one. */
  widget?: { kind: string; payload: Record<string, string> };
  /**
   * The challenge the flow is currently waiting on, and its id.
   *
   * One at a time: a flow asks, waits, and asks again, so a second challenge
   * replaces the first rather than joining it. The id is what an answer is
   * addressed to.
   */
  pendingChallenge?: { id: string; challenge: WireChallenge; expectsAnswer: boolean };
  /** Error message if state === "error". */
  errorMessage?: string;
  /**
   * The rest of what the failing event carried, kept so a subscriber that
   * arrives after the failure is told what the one watching live was told.
   *
   * Without it a client that opens the flow a moment too late — or reconnects
   * across a dropped stream — gets a bare sentence: no code to switch on, no
   * credential to route to a wizard, and no remedy. Which is to say, exactly
   * the failure this all exists to avoid, reached by being slow.
   */
  errorDetail?: {
    code?: AuthErrorCode;
    fileKey?: string;
    providerName?: string;
    remedy?: string;
    retryAfterMs?: number;
  };
  /** First resolved account ID, if state === "completed". */
  resolvedAccountId?: string;
  /**
   * All resolved account IDs, if state === "completed". A one-session →
   * many-institutions hosted-widget flow resolves several; single-account
   * flows resolve one. `resolvedAccountId` mirrors the first.
   */
  resolvedAccountIds?: string[];
  /** What the flow reported about each credential, if it reported anything. */
  resolvedAccountStates?: Record<string, { status: string; [key: string]: unknown }>;
  /** What went wrong without stopping it. */
  resolvedNotices?: Array<{ title: string; detail?: string }>;
}

type Subscriber = (event: AuthFlowEvent) => void;

/**
 * States from which a single-use authorization code may be accepted —
 * the user has been shown the authorize URL (`awaiting-user`) or the
 * gateway is explicitly parked on the callback (`awaiting-callback`).
 * Any other state means the code is early (starting), a duplicate
 * (completing/completed), or pointless (error).
 */
export function isAwaitingCode(state: AuthFlowState): boolean {
  return state === "awaiting-user" || state === "awaiting-callback";
}

/** Result of {@link AuthFlowRegistry.acceptCodeDelivery}. */
export type CodeDeliveryResult =
  | { ok: true; flow: AuthFlow }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "wrong-state"; state: AuthFlowState }
  | { ok: false; reason: "not-a-question" };

export class AuthFlowRegistry {
  private flows = new Map<string, AuthFlow>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private readonly ttlMs: number;
  private readonly onExpire?: (flow: AuthFlow) => void | Promise<void>;

  constructor(opts?: { ttlMs?: number; onExpire?: (flow: AuthFlow) => void | Promise<void> }) {
    this.ttlMs = opts?.ttlMs ?? 15 * 60 * 1000;
    this.onExpire = opts?.onExpire;
  }

  start(opts: { sourceType: SourceType; deviceId: DeviceId; accountId?: AccountId }): AuthFlow {
    const flow: AuthFlow = {
      id: randomUUID(),
      sourceType: opts.sourceType,
      accountId: opts.accountId,
      deviceId: opts.deviceId,
      state: "starting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.flows.set(flow.id, flow);
    return flow;
  }

  update(id: string, patch: Partial<Omit<AuthFlow, "id" | "createdAt">>): AuthFlow | null {
    const flow = this.get(id);
    if (!flow) return null;
    if (flow.state === "completed" || flow.state === "error") return flow;
    Object.assign(flow, patch, { updatedAt: Date.now() });
    return flow;
  }

  /**
   * Single-use code-delivery latch. Moves a flow from an awaiting state
   * (see {@link isAwaitingCode}) to `completing` and returns it, so the
   * caller can forward the code to the collector exactly once. The
   * check-and-set is synchronous — on the single-threaded event loop
   * that makes it atomic with respect to a concurrent second delivery,
   * which observes `completing` and is rejected as `wrong-state`.
   */
  acceptCodeDelivery(id: string): CodeDeliveryResult {
    const flow = this.get(id);
    if (!flow) return { ok: false, reason: "not-found" };
    if (!isAwaitingCode(flow.state)) {
      return { ok: false, reason: "wrong-state", state: flow.state };
    }
    // A challenge that was shown rather than asked has nobody waiting on the
    // other end. Forwarding a code to it latches the flow to `completing`, the
    // code lands in a receiver nothing is reading, and the provider's own
    // listener goes on waiting — so the record now says the flow is finishing
    // while the operator watches a page that will time out. The state alone
    // cannot tell the two apart: showing a challenge parks a flow in exactly
    // the same `awaiting-user` that asking one does.
    if (flow.pendingChallenge && !flow.pendingChallenge.expectsAnswer) {
      return { ok: false, reason: "not-a-question" };
    }
    flow.state = "completing";
    flow.updatedAt = Date.now();
    return { ok: true, flow };
  }

  get(id: string): AuthFlow | null {
    const flow = this.flows.get(id);
    if (!flow) return null;
    if (Date.now() - flow.updatedAt > this.ttlMs) {
      this.expire(id);
      return null;
    }
    return flow;
  }

  remove(id: string): void {
    this.flows.delete(id);
    this.subscribers.delete(id);
  }

  list(): AuthFlow[] {
    return Array.from(this.flows.values());
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, flow] of this.flows) {
      if (now - flow.updatedAt > this.ttlMs) {
        this.expire(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Drop a flow and notify any in-flight SSE subscribers with a
   * synthesised `auth.complete{ok:false, error:"expired"}` event so
   * they close the socket cleanly instead of holding it open until
   * the client disconnects. Used by both `get()`'s lazy expire-on-read
   * and the periodic `cleanup()` sweep.
   */
  private expire(id: string): void {
    const flow = this.flows.get(id);
    const subs = this.subscribers.get(id);
    // Remove first: subscriber callbacks and collector replies cannot revive it.
    this.flows.delete(id);
    this.subscribers.delete(id);
    if (flow && flow.state !== "completed" && flow.state !== "error" && this.onExpire) {
      try {
        void Promise.resolve(this.onExpire(flow)).catch(() => {
          log.warn(`Could not cancel expired auth flow ${id}`);
        });
      } catch {
        log.warn(`Could not cancel expired auth flow ${id}`);
      }
    }
    if (subs) {
      const event: AuthFlowEvent = {
        type: "complete",
        ok: false,
        error: "expired",
      };
      for (const sub of subs) {
        try {
          sub(event);
        } catch (err) {
          log.warn(
            `SSE subscriber for flow ${id} threw on expiry: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  // ── subscribe / emit ────────────────────────────────────────────────────

  /** Subscribe to events for a flow. Returns an unsubscribe function. */
  subscribe(flowId: string, handler: Subscriber): () => void {
    let set = this.subscribers.get(flowId);
    if (!set) {
      set = new Set<Subscriber>();
      this.subscribers.set(flowId, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set?.size === 0) this.subscribers.delete(flowId);
    };
  }

  /**
   * Apply an event from a collector (auth.update / auth.complete) to the
   * stored flow record and fan it out to subscribers.
   *
   * - `url` events set `authUrl` and move state to `awaiting-user`.
   * - `qr` events set `qrData`.
   * - `complete` events with ok=true set `state="completed"` + `resolvedAccountId`.
   * - `complete` events with ok=false set `state="error"` + `errorMessage`.
   */
  ingestEvent(flowId: string, event: AuthFlowEvent): AuthFlow | null {
    const flow = this.get(flowId);
    if (!flow) return null;
    if (flow.state === "completed" || flow.state === "error") return flow;

    if (event.type === "url" && event.url) {
      flow.authUrl = event.url;
      flow.state = "awaiting-user";
    } else if (event.type === "qr" && event.data) {
      flow.qrData = event.data;
      flow.state = "awaiting-user";
    } else if (event.type === "challenge" && event.challenge && event.id) {
      // A notice is not a question. It says what is happening while something
      // else is being asked, so it updates the message and leaves the pending
      // question alone — overwriting it would make the operator's answer
      // arrive for a challenge the flow is no longer waiting on, which the
      // answer route then refuses.
      if (event.challenge.kind === "wait") {
        flow.message = event.challenge.title;
      } else {
        flow.pendingChallenge = {
          id: event.id,
          challenge: event.challenge,
          // A collector that predates the field says nothing, and the safe
          // reading is that an answer is wanted: the kinds a client renders an
          // input for are the kinds it rendered one for before this field
          // existed, so the default changes nothing for them, and the kinds it
          // does not — a pairing code, a notice — are unaffected either way.
          expectsAnswer: event.expectsAnswer ?? true,
        };
        flow.state = "awaiting-user";
      }
    } else if (event.type === "widget" && event.kind && event.payload) {
      flow.widget = { kind: event.kind, payload: event.payload };
      flow.state = "awaiting-user";
    } else if (event.type === "complete") {
      // Whatever was being asked is over. A pairing payload or a half-filled
      // form left on the record would sit there until the flow expires, and
      // the admin listing hands every flow to every caller.
      flow.pendingChallenge = undefined;
      if (event.ok === false) {
        flow.state = "error";
        flow.errorMessage = event.error;
        flow.errorDetail = {
          code: event.code,
          fileKey: event.fileKey,
          providerName: event.providerName,
          remedy: event.remedy,
          retryAfterMs: event.retryAfterMs,
        };
      } else {
        flow.state = "completed";
        // `accountIds` is the authoritative full set; `accountId` is the
        // back-compat first id. Prefer the array, fall back to the scalar.
        const ids = event.accountIds ?? (event.accountId ? [event.accountId] : undefined);
        flow.resolvedAccountIds = ids;
        flow.resolvedAccountId = ids?.[0] ?? event.accountId;
        flow.resolvedAccountStates = event.accountStates;
        flow.resolvedNotices = event.notices;
      }
    } else if (event.type === "error" && event.error) {
      flow.pendingChallenge = undefined;
      flow.state = "error";
      flow.errorMessage = event.error;
      flow.errorDetail = {
        code: event.code,
        fileKey: event.fileKey,
        providerName: event.providerName,
        remedy: event.remedy,
        retryAfterMs: event.retryAfterMs,
      };
    }
    flow.updatedAt = Date.now();

    for (const sub of this.subscribers.get(flowId) ?? []) {
      try {
        sub(event);
      } catch (err) {
        // Don't let one subscriber break the others — but do surface the
        // throw so a buggy SSE consumer is visible rather than silent.
        log.warn(
          `SSE subscriber for flow ${flowId} threw on ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return flow;
  }
}

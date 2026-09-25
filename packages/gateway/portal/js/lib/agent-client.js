// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Agent client — HTTP for commands, SSE for the event stream.
 *
 * Why SSE rather than WS: /device/ws requires a device-bound token at the
 * HTTP upgrade, which the portal doesn't hold in JavaScript (it authenticates
 * by session cookie, not by a paired device token). Cookie auth flows
 * naturally through fetch + EventSource so the SSE endpoint just works
 * here.
 *
 * Public API:
 *
 *   const client = createAgentClient();
 *   const session = await client.createSession();
 *   const unsubscribe = client.onEvent(session.sessionId, (event) => …);
 *   await client.sendMessage(session.sessionId, "find emails from Q");
 *   await client.cancel(session.sessionId);
 *   client.close();
 */

import { apiFetch } from "../api.js";

const AGENT_EVENT_PREFIX = "agent.";
const MAX_PENDING_DELTA_CHUNKS = 512;

/**
 * Append an event received before a session listener attaches. Streaming text
 * can produce hundreds of frames during the resume HTTP round-trip; collapse
 * adjacent deltas so they cannot evict the message/tool/sub-agent boundaries
 * the reducer needs to reconstruct a coherent live turn.
 */
function appendPendingEvent(pending, msg, eventId, maxEvents) {
  const childType = msg?.payload?.event?.type;
  if (
    msg?.type === "agent.subagent.event" &&
    (childType === "agent.text.delta" || childType === "agent.thinking.delta")
  ) {
    // The compact child progress card deliberately does not retain prose or
    // reasoning deltas, so these frames carry no portal state while detached.
    return;
  }

  const previous = pending[pending.length - 1];
  const isDelta = msg?.type === "agent.text.delta" || msg?.type === "agent.thinking.delta";
  if (
    isDelta &&
    previous?.msg?.type === msg.type &&
    previous.msg.payload?.sessionId === msg.payload?.sessionId &&
    previous.msg.payload?.messageId === msg.payload?.messageId &&
    typeof previous.msg.payload?.delta === "string" &&
    typeof msg.payload?.delta === "string"
  ) {
    let deltaChunks = [
      ...(previous.deltaChunks ?? [
        {
          firstEventId: previous.eventId,
          lastEventId: previous.eventId,
          delta: previous.msg.payload.delta,
        },
      ]),
      { firstEventId: eventId, lastEventId: eventId, delta: msg.payload.delta },
    ];
    if (deltaChunks.length > MAX_PENDING_DELTA_CHUNKS) {
      const compactCount = deltaChunks.length - MAX_PENDING_DELTA_CHUNKS + 1;
      const compacted = deltaChunks.slice(0, compactCount);
      deltaChunks = [
        {
          firstEventId: compacted[0].firstEventId,
          lastEventId: compacted.at(-1).lastEventId,
          delta: compacted.map((chunk) => chunk.delta).join(""),
        },
        ...deltaChunks.slice(compactCount),
      ];
    }
    pending[pending.length - 1] = {
      eventId,
      msg: previous.msg,
      // Bound per-frame metadata without dropping text. If a future snapshot
      // cursor intersects the compacted prefix, onEvent skips that ambiguous
      // range and requests a fresh snapshot rather than duplicating its prefix.
      deltaChunks,
    };
    return;
  }

  pending.push({ eventId, msg });
  if (pending.length > maxEvents) {
    const dropped = pending.splice(0, pending.length - maxEvents);
    for (const event of dropped) {
      const droppedEventId = event.deltaChunks?.at(-1)?.lastEventId ?? event.eventId;
      if (Number.isSafeInteger(droppedEventId)) {
        pending.droppedThroughEventId = Math.max(
          pending.droppedThroughEventId ?? Number.MIN_SAFE_INTEGER,
          droppedEventId,
        );
      } else {
        pending.droppedEventWithoutId = true;
      }
    }
  }
}

/**
 * The browser's IANA zone, or `undefined` where the runtime reports none.
 * Read fresh per session rather than cached at module load: a laptop that
 * travels changes zone while the tab stays open.
 *
 * @returns {string | undefined}
 */
function resolveBrowserTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.length > 0 ? zone : undefined;
  } catch {
    return undefined;
  }
}

export function createAgentClient() {
  /** @type {Map<string, Set<(event: any) => void>>} sessionId → listeners */
  const listeners = new Map();
  /** @type {Map<string, any[]>} sessionId → events received before attachment */
  const pendingEvents = new Map();
  const MAX_PENDING_SESSIONS = 64;
  const MAX_PENDING_EVENTS_PER_SESSION = 128;
  /** @type {Set<() => void>} resync (reload-transcript) listeners */
  const resyncListeners = new Set();
  let es = null;
  let cancelled = false;
  let backoffMs = 500;
  let retryTimer = null;
  // SSE id of the last event seen, used to resume past it on reconnect.
  // We close + reopen the EventSource to control backoff (below), which
  // resets the browser's native Last-Event-ID resume — so we carry the
  // cursor ourselves and pass it as the `?since=` query param the gateway
  // also accepts. Null until the first event arrives (fresh attach).
  let lastEventId = null;
  // Resetting backoff on every `onopen` lets a flapping gateway burn a tight
  // reconnect loop. We only zero the counter after the connection has either
  // delivered at least one event OR stayed up for 5 s — past that point the
  // server is plausibly healthy again.
  let stableTimer = null;
  let eventReceivedSinceOpen = false;

  function resetBackoffIfStable() {
    backoffMs = 500;
  }

  function clearStableTimer() {
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  }

  function open() {
    if (cancelled) return;
    eventReceivedSinceOpen = false;
    // Resume past the last event we saw. The gateway replays buffered
    // events newer than `since` before attaching the live feed, or sends
    // an `agent.resync` control event when the gap predates its buffer.
    const url = lastEventId
      ? `/agent/events?since=${encodeURIComponent(lastEventId)}`
      : "/agent/events";
    es = new EventSource(url, { withCredentials: true });
    es.onopen = () => {
      clearStableTimer();
      stableTimer = setTimeout(() => {
        stableTimer = null;
        resetBackoffIfStable();
      }, 5_000);
    };
    es.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      // Track the SSE id so a reconnect can resume past it. Per the SSE
      // spec EventSource keeps a persistent last-event-id that only a
      // frame's `id:` line updates, so `ev.lastEventId` reports the most
      // recent id even on the id-less `agent.resync` control frame (it
      // carries the prior id, harmlessly re-assigned here). The truthiness
      // guard keeps a genuinely-empty id — a resync leading a brand-new
      // connection before any id was seen — from clobbering our cursor.
      if (ev.lastEventId) lastEventId = ev.lastEventId;
      if (!eventReceivedSinceOpen) {
        eventReceivedSinceOpen = true;
        resetBackoffIfStable();
      }
      const type = msg?.type;
      if (typeof type !== "string" || !type.startsWith(AGENT_EVENT_PREFIX)) return;
      // Resync is connection-control, not a session event: the gateway
      // couldn't replay what we missed, so tell the view to reload the
      // active conversation from its persisted transcript. It carries no
      // sessionId, so dispatch it before the per-session routing below.
      if (type === "agent.resync") {
        for (const fn of resyncListeners) {
          try {
            fn();
          } catch (err) {
            console.error("[agent-client] resync listener threw", err);
          }
        }
        return;
      }
      const sessionId = msg?.payload?.sessionId;
      if (!sessionId) return;
      // Events are delivered only to the listener for their own session, so
      // activity on any other session (e.g. a conversation advanced on another
      // device) is dropped here rather than refreshing the sidebar live.
      // See #1445 — planned: a list-level SSE event handled before this per-
      // session dispatch so the conversation list updates without interaction.
      const subs = listeners.get(sessionId);
      if (!subs) {
        let pending = pendingEvents.get(sessionId);
        if (!pending) {
          if (pendingEvents.size >= MAX_PENDING_SESSIONS) {
            pendingEvents.delete(pendingEvents.keys().next().value);
          }
          pending = [];
          pendingEvents.set(sessionId, pending);
        }
        const parsedEventId = Number.parseInt(ev.lastEventId, 10);
        appendPendingEvent(
          pending,
          msg,
          Number.isSafeInteger(parsedEventId) ? parsedEventId : undefined,
          MAX_PENDING_EVENTS_PER_SESSION,
        );
        return;
      }
      for (const fn of subs) {
        try {
          fn(msg);
        } catch (err) {
          console.error("[agent-client] listener threw", err);
        }
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects on retriable errors, but we close + retry
      // ourselves to keep backoff under our control and to recover from a
      // dead server cleanly.
      clearStableTimer();
      try {
        es?.close();
      } catch {
        /* noop */
      }
      es = null;
      if (cancelled) return;
      // ±25% jitter so simultaneous tabs/devices don't stampede a recovering
      // gateway with synchronised retries.
      const base = Math.min(backoffMs, 30_000);
      const jittered = base * (0.75 + Math.random() * 0.5);
      retryTimer = setTimeout(open, jittered);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    };
  }
  open();

  async function api(path, init) {
    const res = await apiFetch(path, init);
    if (!res.ok) {
      let detail = "";
      let code = "";
      try {
        // Gateway HTTP errors serialise as `{ error, code, detail? }`.
        const body = await res.json();
        detail = body?.error || body?.message || "";
        code = body?.code || "";
      } catch {
        /* noop */
      }
      // For configuration errors (e.g. agent disabled, no Anthropic key)
      // throw the operator-facing message verbatim so the agent view can
      // pattern-match it and render an actionable CTA. The status code
      // is attached so callers can distinguish 404 (resume a deleted
      // conversation) from 500-class fatals.
      const err = new Error(detail || `${res.status} ${res.statusText}`);
      err.status = res.status;
      err.code = code;
      throw err;
    }
    return res.json();
  }

  return {
    // Canonical agent-harness status: { backend, enabled, disabledReason }.
    // Always 200 (even when the harness is disabled) so the view can render
    // configuration guidance proactively without first attempting a session.
    async getConfig() {
      return api("/admin/agent/config", { method: "GET" });
    },
    async createSession({ resumeFromId, transcriptLimit } = {}) {
      // Every portal session is a visual chat session. Naming the profile is
      // especially important on resume: omission preserves a live voice
      // session's profile, which would leave follow-up turns without the
      // Timeline citation tools this surface renders.
      const body = { profile: "interactive" };
      if (resumeFromId) body.resumeFromId = resumeFromId;
      // The browser's zone, so the agent answers in the clock the person
      // reading it is on. The gateway may be on another machine in another
      // country; its own zone would be a guess. Omitted when the runtime
      // resolves none, and the gateway then falls back to its own.
      const timeZone = resolveBrowserTimeZone();
      if (timeZone) body.timeZone = timeZone;
      const path =
        transcriptLimit === undefined
          ? "/agent/sessions"
          : `/agent/sessions?transcriptLimit=${encodeURIComponent(String(transcriptLimit))}`;
      return api(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    async listConversations({ limit = 50, cursor } = {}) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set("cursor", cursor);
      return api(`/agent/conversations?${params}`, { method: "GET" });
    },
    async deleteConversation(id) {
      return api(`/agent/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async listConversationMessages(id, { limit = 25, cursor } = {}) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set("cursor", cursor);
      const data = await api(
        `/agent/conversations/${encodeURIComponent(id)}/messages?${params}`,
        { method: "GET" },
      );
      return {
        ...data,
        items: data.items ?? data.messages ?? [],
        pageInfo: data.pageInfo ?? data.messagePageInfo ?? {},
      };
    },
    // `options` carries per-message slash-command flags folded into the POST
    // body — today just `{ deepResearch: true }` from an armed Deep Research
    // pill. With no options this is an ordinary turn. Only known string keys
    // are forwarded so a stray option never bloats the request.
    async sendMessage(sessionId, text, options = {}) {
      const body = { text };
      if (options && options.deepResearch === true) body.deepResearch = true;
      return api(`/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    async cancel(sessionId) {
      return api(`/agent/sessions/${encodeURIComponent(sessionId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
    onEvent(sessionId, fn, { afterEventId, onGap } = {}) {
      let subs = listeners.get(sessionId);
      if (!subs) {
        subs = new Set();
        listeners.set(sessionId, subs);
      }
      subs.add(fn);
      // `createSession(resumeFromId)` returns a snapshot before AgentView can
      // attach. Buffering closes that interval without losing an SSE event
      // whose cursor has already advanced past the server-side replay.
      const pending = pendingEvents.get(sessionId);
      if (pending) {
        pendingEvents.delete(sessionId);
        let replayGap =
          pending.droppedEventWithoutId === true ||
          (Number.isSafeInteger(pending.droppedThroughEventId) &&
            (!Number.isSafeInteger(afterEventId) || pending.droppedThroughEventId > afterEventId));
        for (const event of pending) {
          let message = event.msg;
          if (event.deltaChunks) {
            const chunks = event.deltaChunks.filter((chunk) => {
              if (!Number.isSafeInteger(afterEventId)) return true;
              if (
                !Number.isSafeInteger(chunk.firstEventId) ||
                !Number.isSafeInteger(chunk.lastEventId)
              ) {
                replayGap = true;
                return false;
              }
              if (chunk.lastEventId <= afterEventId) return false;
              if (chunk.firstEventId <= afterEventId) {
                // Compaction discarded the per-frame boundary needed to extract
                // an exact suffix. Skip the ambiguous range and ask the view for
                // a fresh snapshot rather than duplicating its represented prefix.
                replayGap = true;
                return false;
              }
              return true;
            });
            if (chunks.length === 0) continue;
            message = {
              ...message,
              payload: {
                ...message.payload,
                delta: chunks.map((chunk) => chunk.delta).join(""),
              },
            };
          } else if (
            Number.isSafeInteger(afterEventId) &&
            Number.isSafeInteger(event.eventId) &&
            event.eventId <= afterEventId
          ) {
            continue;
          }
          fn(message);
        }
        if (replayGap) onGap?.();
      }
      return () => {
        const set = listeners.get(sessionId);
        if (!set) return;
        set.delete(fn);
        if (set.size === 0) listeners.delete(sessionId);
      };
    },
    // Register a handler invoked when the gateway sends `agent.resync` —
    // the signal that the live stream couldn't be caught up incrementally
    // and the caller should reload the active conversation's transcript.
    onResync(fn) {
      resyncListeners.add(fn);
      return () => {
        resyncListeners.delete(fn);
      };
    },
    close() {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearStableTimer();
      try {
        es?.close();
      } catch {
        /* noop */
      }
      es = null;
    },
  };
}

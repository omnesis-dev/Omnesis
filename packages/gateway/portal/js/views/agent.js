// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Agent view — the chat surface.
 *
 * Owns the conversation state, subscribes to the agent client's event
 * stream, and feeds structured turn parts into the renderer components.
 * The reducer + transcript helpers live in `agent-reducer.js` so they
 * can be unit-tested without Preact / DOM.
 *
 * URL contract:
 *   /portal/agent            landing — mints a fresh hero session. The URL
 *                            is silently replaced with `/portal/agent/<id>`
 *                            the first time the user sends a message in it
 *                            (that's the point the gateway persists the
 *                            transcript and the link becomes resumable).
 *                            "+ New" transitions back here mint a fresh
 *                            session.
 *   /portal/agent/<convoId>  load that specific transcript; 404 surfaces a
 *                            "conversation not found" inline banner instead
 *                            of redirecting.
 */

import { html } from "htm/preact";
import { useEffect, useReducer, useRef, useState } from "preact/hooks";

import { createAgentClient } from "../lib/agent-client.js";
import {
  Composer,
  MessageBubble,
  TimelinePanel,
  PlanPanel,
  WorkingIndicator,
} from "../components/agent/parts.js";
import {
  reducer,
  initialState,
  workingIndicatorActive,
  hasContextCard,
} from "./agent-reducer.js";
import { navigate, replaceRoute, replaceUrl } from "../lib/router.js";
import {
  conversationAgentTarget,
  freshAgentTarget,
  isAgentReturnStateRecent,
  readAgentReturnState,
  resolveAgentReturnTarget,
  writeAgentReturnState,
} from "../lib/agent-return-policy.js";
import { renderMarkdown } from "../lib/markdown.js";
import { getAgentModel } from "../api.js";
import { AgentCloudInferenceRecovery, cloudInferenceRecovery } from "./agent-cloud-inference.js";
import { ProviderIcon } from "../components/provider-icon.js";

export function loadPersistedConversation(client, id) {
  return client.listConversationMessages(id, { limit: 25 });
}

export function activatePendingSession(client, pending) {
  return client.createSession({
    ...pending,
    ...(pending.resumeFromId ? { transcriptLimit: 25 } : {}),
  });
}

export function agentComposerDisabled(sessionId, agentConfig) {
  return !sessionId && agentConfig?.enabled !== false;
}

/** Require the gateway to acknowledge a stop request before treating it as accepted. */
export async function requestAgentCancel(client, sessionId) {
  const result = await client.cancel(sessionId);
  if (result?.ok !== true) {
    throw new Error("The gateway did not confirm the stop request.");
  }
  return result;
}

export function agentRequestIsCurrent(
  requestGeneration,
  currentGeneration,
  requestSessionId,
  activeSessionId,
) {
  return requestGeneration === currentGeneration && requestSessionId === activeSessionId;
}

/** A terminal settles stop authority without invalidating its still-pending send acknowledgment. */
export function settleAgentTerminal(cancelGenerationRef) {
  cancelGenerationRef.current += 1;
}

export function AgentActionError({ message, onDismiss }) {
  return html`<div class="agent-action-error" role="alert">
    <span>${message}</span>
    <button
      type="button"
      aria-label="Dismiss stop error"
      onClick=${onDismiss}
    >×</button>
  </div>`;
}

export function resumedConversationAction(session) {
  return {
    kind: "load-conversation",
    sessionId: session.sessionId,
    model: session.model,
    backend: session.backend,
    messages: session.messages || [],
    origin: session.origin ?? null,
    busy: session.busy === true,
    messagePageInfo: session.messagePageInfo,
    messageCount: session.messageCount,
    messagesAreVisible: session.messagesAreVisible === true,
    terminalFailure: session.terminalFailure ?? null,
    lastTurnFailure: session.lastTurnFailure ?? null,
  };
}

/** Attach with the HTTP snapshot cursor so represented buffered events are not replayed twice. */
export function subscribeToSessionEvents(client, sessionId, eventCursor, onEvent, onGap) {
  return client.onEvent(sessionId, onEvent, { afterEventId: eventCursor, onGap });
}

/** Apply every server-projected active-turn event before draining post-cursor SSE. */
export function dispatchSessionReplay(dispatch, replayEvents = []) {
  for (const event of replayEvents) {
    dispatch({ kind: event.type, payload: event.payload });
  }
}

/** Coalesce replay-gap callbacks and reconcile only while their session remains active. */
export function scheduleReplayGapReconcile(
  pendingSessionIds,
  sessionId,
  getActiveSessionId,
  reconcile,
  schedule = (fn) => setTimeout(fn, 0),
) {
  if (pendingSessionIds.has(sessionId)) return;
  pendingSessionIds.add(sessionId);
  schedule(() => {
    pendingSessionIds.delete(sessionId);
    if (getActiveSessionId() === sessionId) reconcile(sessionId);
  });
}
import { DevAnnotateButton } from "../components/dev-annotate-button.js";
import { LoadMore } from "../components/load-more.js";

// Pushpin glyph marking a pinned conversation in the rail. The pin/unpin
// action itself lives in the global sidebar's "…" menu (app.js); the rail
// only reflects the resulting pinned-first order + marker.
const RAIL_PIN_ICON = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;
const CONTEXT_WINDOW_MESSAGE =
  "This conversation no longer fits in the selected model's context window. Start a new conversation to continue.";

/** Landing routes mint a session on first send, then become shareable links. */
export function shouldReplaceLandingUrl(pathname) {
  return (
    pathname === "/portal" ||
    pathname === "/portal/" ||
    pathname === "/portal/agent" ||
    pathname === "/portal/agent/"
  );
}

// A freshly minted hero session (no turns sent, and not addressed by a URL
// convoId) was never persisted server-side — the gateway only writes a
// transcript the first time the user sends a message. Reconciling it (on
// tab-focus or an `agent.resync` signal) has nothing to resume against: the
// in-memory session may already be evicted after its idle timeout, and even
// when it isn't, there's no durable state to catch up on. Skipping the
// reconcile there avoids a spurious 404 that would surface the "Conversation
// not found" banner over an otherwise-empty hero composer.
//
// `turnCount > 0` alone isn't a reliable signal: a talk-back thread opened
// from a brief or watch firing carries a seeded prefix
// that's hidden from `turns` until the user's first reply (see
// `visibleMessages`), so a real, already-persisted conversation can also
// have zero visible turns. `convoId` (the route's addressed conversation)
// covers that case — it's non-null exactly when the session was reached via
// an existing conversation's URL rather than minted fresh.
export function shouldReconcileSession(sessionId, turnCount, convoId) {
  return Boolean(sessionId) && (turnCount > 0 || convoId != null);
}

function ContextWindowExceededCard({ onNewConversation }) {
  return html`
    <div class="agent-context-limit" role="status">
      <div>
        <strong>Context window reached</strong>
        <p>${CONTEXT_WINDOW_MESSAGE}</p>
      </div>
      <button type="button" onClick=${onNewConversation}>New conversation</button>
    </div>
  `;
}

/**
 * A cheap content signature that changes on every streamed token or tool beat, so the working
 * indicator's reveal debounce re-arms during streaming and settles only in a genuine gap. Covers
 * the turn/part counts plus the trailing part's growth — everything that mutates while a turn is in
 * flight. Mirrors the iOS `transcriptVersion` / Android `agentWorkingRevision` debounce key.
 */
function workingIndicatorRev(state) {
  const turns = state.turns ?? [];
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant") return turns.length;
  const parts = last.parts ?? [];
  const tail = parts[parts.length - 1];
  let sig = turns.length * 31 + parts.length;
  if (tail) {
    if (tail.kind === "text" || tail.kind === "thinking") {
      sig = sig * 31 + (tail.text?.length ?? 0);
    } else if (tail.kind === "tool") {
      sig = sig * 31 + (tail.children?.length ?? 0) * 2 + (tail.result != null ? 1 : 0);
    }
  }
  return sig;
}

export function AgentView({ convoId, experimental = false, developer = false }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const clientRef = useRef(null);
  const conversationRef = useRef(null);
  const unsubscribeRef = useRef(() => {});
  // Tracks whether the user was within ~80px of the bottom before the latest
  // turn change. If they were, we keep them pinned; if they had scrolled up
  // to read history we don't yank them back down on every delta.
  const pinnedToBottomRef = useRef(true);
  // Guards the "first mount auto-resumes the most recent" branch from
  // re-firing later when the URL bounces back to `/portal/agent` via "+ New".
  // Without this, clicking "+ New" would always re-resume the last
  // conversation instead of minting a fresh session.
  const didInitialAutoResumeRef = useRef(false);
  // Latest convoId seen by the URL-driven effect — used to short-circuit
  // re-fires (e.g. when the rail dispatches `pushState` for the already
  // active conversation) without taking the round-trip through the server.
  const lastLoadedConvoIdRef = useRef(null);
  // Cached promise for the one-shot agent-config probe. Every session-mint
  // path awaits this first so an unconfigured harness surfaces setup
  // guidance instead of a doomed session attempt.
  const configPromiseRef = useRef(null);
  // Monotonic guard for async session loads. Visibility/resync reloads and URL
  // changes can overlap; only the latest create/resume response is allowed to
  // attach listeners or replace reducer state.
  const sessionLoadSeqRef = useRef(0);
  const activeSessionIdRef = useRef(null);
  // When inference is unavailable, the composer and persisted transcript can
  // still render without minting a live session. The first send retries that
  // mint (resuming the stored id when present) before posting the message.
  const pendingSessionRef = useRef(null);
  const pendingActivationRef = useRef(null);
  // If we had to resume a still-busy session, its in-flight history snapshot
  // may be thinner than the SSE state (or may have missed an unreplayable
  // EventSource gap). Reload once more after the terminal event so the UI
  // reconciles to the canonical completed transcript.
  const reloadAfterEndRef = useRef(new Set());
  // A direct link can be opened during the small interval after the parent
  // turn starts but before the first researcher is spawned. The response is
  // correctly busy but has no replayable cards yet; make one bounded refresh
  // so that tab still reconstructs the working set if its SSE attachment
  // missed the following live events.
  const researchReplayRetryRef = useRef(new Set());
  const olderHistoryScrollHeightRef = useRef(null);
  // Synchronous ownership for the older-history request. Render state alone
  // cannot close the window between a click and Preact applying setState.
  const historyRequestRef = useRef(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [actionFailure, setActionFailure] = useState(null);

  // The model that would answer right now — the current agent assignment,
  // independent of any one conversation's history. Shown in a small header
  // above the transcript. Refetched whenever a session is (re)created so a
  // mid-session model reassignment is reflected on the next conversation.
  const [agentModel, setAgentModel] = useState(null);
  const replayGapSessionsRef = useRef(new Set());
  const sendGenerationRef = useRef(0);
  const cancelGenerationRef = useRef(0);

  function reconcileAfterReplayGap(sessionId) {
    scheduleReplayGapReconcile(
      replayGapSessionsRef.current,
      sessionId,
      () => activeSessionIdRef.current,
      resumeConversation,
    );
  }

  function attachToSession(sessionId, afterEventId) {
    // Drop any prior listener so events from the previous session
    // don't leak into the new one's reducer.
    unsubscribeRef.current?.();
    unsubscribeRef.current = subscribeToSessionEvents(
      clientRef.current,
      sessionId,
      afterEventId,
      (msg) => {
        if (
          msg.type === "agent.message.end" &&
          msg.payload?.sessionId === activeSessionIdRef.current
        ) {
          settleAgentTerminal(cancelGenerationRef);
          setActionFailure(null);
        }
        dispatch({ kind: msg.type, payload: msg.payload });
        // After each completed turn, refresh the conversations list so
        // the sidebar reflects the new updatedAt + messageCount.
        if (msg.type === "agent.message.end") {
          refreshConversations();
          const endedSessionId = msg.payload?.sessionId;
          if (
            endedSessionId &&
            reloadAfterEndRef.current.delete(endedSessionId) &&
            activeSessionIdRef.current === endedSessionId
          ) {
            setTimeout(() => resumeConversation(endedSessionId), 0);
          }
        }
      },
      () => reconcileAfterReplayGap(sessionId),
    );
  }

  async function refreshConversations() {
    if (!clientRef.current) return [];
    try {
      const { conversations } = await clientRef.current.listConversations();
      const list = conversations || [];
      dispatch({ kind: "conversations-list", list });
      // Tell the sidebar to re-fetch so its conversation rail stays in
      // sync (new conversation just appeared, title updated, etc.).
      window.dispatchEvent(new Event("omnesis:conversations-changed"));
      return list;
    } catch {
      // Silent — listing fails harmlessly when persistence is misconfigured.
      return [];
    }
  }

  // One-shot, cached agent-config probe. Resolves to the config snapshot
  // ({ backend, enabled, disabledReason }) or null when the probe itself
  // fails (gateway unreachable) — in which case callers fall through to a
  // normal session attempt that surfaces its own error.
  function ensureAgentConfig() {
    if (!clientRef.current) return Promise.resolve(null);
    if (!configPromiseRef.current) {
      configPromiseRef.current = clientRef.current.getConfig().catch(() => {
        // Don't cache the rejection — a later mint can re-probe.
        configPromiseRef.current = null;
        return null;
      });
    }
    return configPromiseRef.current;
  }

  async function createFreshSession() {
    if (!clientRef.current) return;
    sendGenerationRef.current += 1;
    cancelGenerationRef.current += 1;
    setActionFailure(null);
    const loadSeq = ++sessionLoadSeqRef.current;
    writeAgentReturnState(freshAgentTarget());
    pendingActivationRef.current = null;
    historyRequestRef.current = null;
    setHistoryLoading(false);
    setHistoryError(null);
    const cfg = await ensureAgentConfig();
    if (cfg && !cfg.enabled) {
      pendingSessionRef.current = {};
      activeSessionIdRef.current = null;
      unsubscribeRef.current?.();
      dispatch({ kind: "agent-unconfigured", config: cfg });
      dispatch({ kind: "reset-conversation", sessionId: null, model: "", backend: cfg.backend });
      return;
    }
    try {
      const session = await clientRef.current.createSession();
      if (loadSeq !== sessionLoadSeqRef.current) return;
      pendingSessionRef.current = null;
      activeSessionIdRef.current = session.sessionId;
      attachToSession(session.sessionId, session.eventCursor);
      dispatch({
        kind: "reset-conversation",
        sessionId: session.sessionId,
        model: session.model,
        backend: session.backend,
      });
      setHistoryLoading(false);
      setHistoryError(null);
      lastLoadedConvoIdRef.current = null;
      // Fresh session — no conversation is highlighted in the sidebar
      // yet. (Once the user sends a turn, the new convo appears.)
      window.dispatchEvent(new CustomEvent("omnesis:agent-active-convo", { detail: { id: null } }));
    } catch (err) {
      dispatch({ kind: "session-failed", error: err.message ?? String(err) });
    }
  }

  // "+ New" — push back to the bare landing URL.
  //
  // Subtlety: the auto-resume path uses `replaceUrl` (silently rewrites
  // the URL to /portal/agent/<id> without firing route-change), so the
  // parent's `route.convoId` can be null even when the URL points at a
  // resumed conversation. In that case `navigate("/portal/agent")`
  // doesn't change the prop, so the `[convoId]` effect doesn't re-fire
  // — and the view stays stuck on the resumed conversation. Detect
  // that case (prop already null) and mint the fresh session directly.
  // When the prop IS non-null, the navigate WILL change the prop, the
  // effect re-fires, falls through to createFreshSession — so one mint.
  function newConversation() {
    sendGenerationRef.current += 1;
    cancelGenerationRef.current += 1;
    setActionFailure(null);
    if (convoId == null) {
      lastLoadedConvoIdRef.current = null;
      navigate("/portal/agent");
      createFreshSession();
    } else {
      navigate("/portal/agent");
    }
  }

  async function resumeConversation(id) {
    if (!clientRef.current) return;
    sendGenerationRef.current += 1;
    cancelGenerationRef.current += 1;
    setActionFailure(null);
    const loadSeq = ++sessionLoadSeqRef.current;
    pendingActivationRef.current = null;
    historyRequestRef.current = null;
    setHistoryLoading(false);
    setHistoryError(null);
    const cfg = await ensureAgentConfig();
    if (cfg && !cfg.enabled) {
      // Durable history does not depend on inference. Keep a pending resume
      // so the first send can establish the live session if the backend has
      // recovered, or surface its current probe error if it has not.
      pendingSessionRef.current = { resumeFromId: id };
      unsubscribeRef.current?.();
      try {
        const page = await loadPersistedConversation(clientRef.current, id);
        if (loadSeq !== sessionLoadSeqRef.current) return;
        activeSessionIdRef.current = id;
        dispatch({
          kind: "load-conversation",
          sessionId: id,
          model: page.model,
          backend: page.backend,
          messages: page.items || [],
          origin: page.origin ?? null,
          busy: false,
          messagePageInfo: page.pageInfo,
          messageCount: page.messageCount,
          messagesAreVisible: true,
          terminalFailure: page.terminalFailure ?? null,
          lastTurnFailure: page.lastTurnFailure ?? null,
        });
        setHistoryLoading(false);
        setHistoryError(null);
        lastLoadedConvoIdRef.current = id;
        window.dispatchEvent(new CustomEvent("omnesis:agent-active-convo", { detail: { id } }));
      } catch (err) {
        if (loadSeq !== sessionLoadSeqRef.current) return;
        if (err?.status === 404) {
          dispatch({ kind: "conversation-not-found", convoId: id });
          lastLoadedConvoIdRef.current = id;
          return;
        }
        dispatch({ kind: "session-failed", error: err.message ?? String(err) });
      }
      return;
    }
    // Turn the already-open SSE subscription into a detached queue before
    // taking the snapshot. This gives same-session resyncs the same atomic
    // snapshot → replay → post-cursor drain ordering as first-time opens.
    const previouslyActiveSessionId = activeSessionIdRef.current;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    try {
      const session = await clientRef.current.createSession({
        resumeFromId: id,
        transcriptLimit: 25,
      });
      if (loadSeq !== sessionLoadSeqRef.current) return;
      pendingSessionRef.current = null;
      activeSessionIdRef.current = session.sessionId;
      if (session.busy === true) reloadAfterEndRef.current.add(session.sessionId);
      else reloadAfterEndRef.current.delete(session.sessionId);
      dispatch({
        kind: "load-conversation",
        sessionId: session.sessionId,
        model: session.model,
        backend: session.backend,
        messages: session.messages || [],
        origin: session.origin ?? null,
        busy: session.busy === true,
        messagePageInfo: session.messagePageInfo,
        messageCount: session.messageCount,
        messagesAreVisible: session.messagesAreVisible === true,
        terminalFailure: session.terminalFailure ?? null,
        lastTurnFailure: session.lastTurnFailure ?? null,
      });
      // A busy turn can be reopened after derived SSE events have already
      // passed. Apply the server-projected active-turn replay after the parent
      // runtime snapshot, then drain only post-cursor buffered SSE below.
      dispatchSessionReplay(dispatch, session.replayEvents);
      const hasResearchCard = (session.replayEvents ?? []).some(
        (event) => event.type === "agent.subagent.spawned",
      );
      if (session.busy === true && !hasResearchCard && !researchReplayRetryRef.current.has(id)) {
        researchReplayRetryRef.current.add(id);
        setTimeout(() => {
          if (activeSessionIdRef.current === id) resumeConversation(id);
        }, 750);
      }
      // Install the durable snapshot and its compact researcher replay before
      // draining events that arrived while the resume request was in flight.
      // `onEvent` synchronously flushes that pending SSE queue, so attaching
      // it earlier would apply those cards to the old view state and then
      // overwrite them with `load-conversation` above.
      attachToSession(session.sessionId, session.eventCursor);
      setHistoryLoading(false);
      setHistoryError(null);
      lastLoadedConvoIdRef.current = id;
      window.dispatchEvent(new CustomEvent("omnesis:agent-active-convo", { detail: { id } }));
    } catch (err) {
      if (loadSeq !== sessionLoadSeqRef.current) return;
      if (previouslyActiveSessionId) attachToSession(previouslyActiveSessionId);
      // 404 means the conversation was deleted (or never existed for this
      // caller). Surface a friendly inline banner rather than a fatal
      // page — the user can either click "+ New" or pick another from
      // the rail.
      if (err?.status === 404) {
        dispatch({ kind: "conversation-not-found", convoId: id });
        lastLoadedConvoIdRef.current = id;
        return;
      }
      dispatch({ kind: "session-failed", error: err.message ?? String(err) });
    }
  }

  async function loadEarlierMessages() {
    const sessionId = state.sessionId;
    const cursor = state.messageNextCursor;
    const loadSeq = sessionLoadSeqRef.current;
    if (!clientRef.current || !sessionId || !cursor || historyRequestRef.current) return;
    const request = { sessionId, cursor, loadSeq };
    historyRequestRef.current = request;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const page = await clientRef.current.listConversationMessages(sessionId, {
        limit: 25,
        cursor,
      });
      if (
        historyRequestRef.current !== request ||
        activeSessionIdRef.current !== sessionId ||
        sessionLoadSeqRef.current !== loadSeq
      ) {
        return;
      }
      olderHistoryScrollHeightRef.current =
        conversationRef.current?.scrollHeight ?? null;
      dispatch({
        kind: "prepend-conversation-history",
        sessionId,
        messages: page.items ?? page.messages ?? [],
        pageInfo: page.messagePageInfo ?? page.pageInfo,
        messagesAreVisible: page.messagesAreVisible === true,
        pageKey: cursor,
      });
    } catch (err) {
      if (
        historyRequestRef.current === request &&
        activeSessionIdRef.current === sessionId &&
        sessionLoadSeqRef.current === loadSeq
      ) {
        setHistoryError(err);
      }
    } finally {
      if (historyRequestRef.current === request) {
        historyRequestRef.current = null;
      }
      if (
        activeSessionIdRef.current === sessionId &&
        sessionLoadSeqRef.current === loadSeq
      ) {
        setHistoryLoading(false);
      }
    }
  }

  // Rail click — push the URL, let the URL-change effect drive the load.
  // Pushing (rather than replacing) keeps the browser back button useful.
  function selectConversation(id) {
    if (id === lastLoadedConvoIdRef.current) return;
    navigate(`/portal/agent/${encodeURIComponent(id)}`);
  }

  async function deleteConversation(id) {
    if (!clientRef.current) return;
    try {
      await clientRef.current.deleteConversation(id);
      // If the user deleted the active conversation, navigate back to
      // the landing URL — that will either auto-resume the new most
      // recent or mint a fresh session.
      if (id === state.sessionId) navigate("/portal/agent");
      await refreshConversations();
    } catch (err) {
      // Surface the failure inline next to the rail and reconcile the
      // list — without this the row "vanishes" optimistically in some
      // browsers and never comes back when the delete actually fails.
      console.error("[agent] deleteConversation failed", err);
      dispatch({
        kind: "conversation-error",
        message: `Couldn't delete conversation: ${err.message ?? String(err)}`,
      });
      await refreshConversations();
    }
  }

  // One-time client construction + SSE wiring. Conversation load is
  // handled by the URL-driven effect below so the same code path serves
  // initial mount and later route changes.
  useEffect(() => {
    const client = createAgentClient();
    clientRef.current = client;
    return () => {
      unsubscribeRef.current?.();
      client.close();
    };
  }, []);

  // Resolve the current agent model for the header. Runs on mount and again
  // each time the session id changes (a fresh/resumed session). Failures are
  // swallowed — the header simply doesn't render.
  useEffect(() => {
    let cancelled = false;
    getAgentModel()
      .then((m) => { if (!cancelled) setAgentModel(m); })
      .catch(() => { if (!cancelled) setAgentModel(null); });
    return () => { cancelled = true; };
  }, [state.sessionId]);

  // Reload the active conversation when the gateway signals `agent.resync`
  // — the live stream couldn't be caught up incrementally (the gap predates
  // the replay buffer), so re-pull the persisted transcript. Keyed on
  // sessionId so the handler always targets the current conversation.
  // Reuses `resumeConversation`, so it inherits the same config gate (a
  // resync after the agent was disabled tears the client down) and 404
  // handling (a since-deleted conversation surfaces the not-found banner).
  // Guarded by shouldReconcileSession — see its doc comment.
  useEffect(() => {
    if (!clientRef.current) return undefined;
    return clientRef.current.onResync(() => {
      if (shouldReconcileSession(state.sessionId, state.turns.length, convoId)) {
        resumeConversation(state.sessionId);
      }
    });
  }, [state.sessionId, state.turns.length, convoId]);

  // Reconcile when the tab returns to the foreground. The last-visible target
  // is durable across a tab/browser restart: under an hour, a bare Ask route
  // resumes the exact conversation (or preserves the fresh-empty hero); at an
  // hour or more, the old context is replaced by a clean focused composer.
  //
  // The conversation list can go stale while the tab is backgrounded: the SSE
  // stream is scoped to the active session, so a conversation created or
  // advanced on another device never pushes to us. Refresh the sidebar on
  // return — unconditionally, so a cross-device conversation appears even on the
  // hero screen with nothing open.
  //
  // Then reconcile the active transcript, if any: a backgrounded tab's SSE
  // connection is often a zombie on resume — and after a gateway restart the
  // reconnect's stale `Last-Event-ID` is ahead of the reset sequence, so the
  // live stream can't catch us up incrementally. Reloading the persisted
  // transcript clears any stale "running…" / busy state from a turn that
  // finished while we were away. Reuses `resumeConversation` (same path
  // `onResync` triggers), keyed on sessionId so it targets the current convo.
  // Guarded by shouldReconcileSession — see its doc comment.
  useEffect(() => {
    function currentTarget() {
      const id = lastLoadedConvoIdRef.current;
      return id ? conversationAgentTarget(id) : freshAgentTarget();
    }

    function startFreshAfterInactivity() {
      lastLoadedConvoIdRef.current = null;
      writeAgentReturnState(freshAgentTarget());
      if (shouldReplaceLandingUrl(window.location.pathname)) createFreshSession();
      else replaceRoute("/portal/agent");
    }

    function onVisibility() {
      if (document.visibilityState !== "visible") {
        writeAgentReturnState(currentTarget());
        return;
      }
      refreshConversations();
      const saved = readAgentReturnState();
      if (!convoId && !isAgentReturnStateRecent(saved, Date.now())) {
        startFreshAfterInactivity();
        return;
      }
      const target = resolveAgentReturnTarget({
        directConversationId: convoId,
        saved,
        now: Date.now(),
      });
      if (target.kind === "fresh") {
        // A recent fresh target is already the exact intended state unless a
        // different conversation was activated while this tab was hidden.
        if (lastLoadedConvoIdRef.current) startFreshAfterInactivity();
        return;
      }
      if (target.id !== lastLoadedConvoIdRef.current) {
        replaceRoute(`/portal/agent/${encodeURIComponent(target.id)}`);
        return;
      }
      if (shouldReconcileSession(state.sessionId, state.turns.length, convoId)) {
        resumeConversation(state.sessionId);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    const onPageHide = () => writeAgentReturnState(currentTarget());
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [state.sessionId, state.turns.length, convoId]);

  // URL is the source of truth. Re-runs on every convoId transition.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!clientRef.current) {
        // Effect can fire before the mount effect populates clientRef on
        // the very first render. Queue a microtask retry — by the next
        // tick clientRef is set.
        await Promise.resolve();
        if (cancelled || !clientRef.current) return;
      }

      // Already loaded — rail click on the active conversation, or
      // synthetic re-fire — short-circuit without re-fetching.
      if (convoId && convoId === lastLoadedConvoIdRef.current) return;

      if (convoId) {
        writeAgentReturnState(conversationAgentTarget(convoId));
        // Kick the rail fetch in parallel: without this a refresh (or
        // direct deep-link) on /portal/agent/<id> renders the
        // conversation but leaves the rail empty.
        const railP = refreshConversations();
        await resumeConversation(convoId);
        if (cancelled) return;
        didInitialAutoResumeRef.current = true;
        await railP;
        return;
      }

      // convoId == null — on the first landing, restore a target that was
      // visible less than an hour ago. Later transitions to the landing are
      // explicit "+ New" actions and always stay fresh.
      if (!didInitialAutoResumeRef.current) {
        const target = resolveAgentReturnTarget({
          directConversationId: null,
          saved: readAgentReturnState(),
          now: Date.now(),
        });
        if (target.kind === "conversation") {
          didInitialAutoResumeRef.current = true;
          replaceRoute(`/portal/agent/${encodeURIComponent(target.id)}`);
          return;
        }
      }
      refreshConversations();
      didInitialAutoResumeRef.current = true;
      await createFreshSession();
    }
    run();
    return () => { cancelled = true; };
  }, [convoId]);

  // Sidebar "+ New" — when the user is already at /portal/agent (no
  // convoId in the URL), navigate doesn't re-fire the URL effect, so
  // we explicitly mint a fresh session here.
  useEffect(() => {
    const onNew = () => {
      if (convoId == null) {
        lastLoadedConvoIdRef.current = null;
        createFreshSession();
      }
    };
    window.addEventListener("omnesis:new-conversation", onNew);
    return () => window.removeEventListener("omnesis:new-conversation", onNew);
  }, [convoId]);

  useEffect(() => {
    activeSessionIdRef.current = state.sessionId;
    setActionFailure(null);
  }, [state.sessionId]);

  useEffect(() => {
    // Only follow new turns when the user is already at (or near) the
    // bottom. If they've scrolled up to read earlier history, leave their
    // scroll position alone — yanking them back on every delta is hostile.
    const el = conversationRef.current;
    if (!el) return;
    if (olderHistoryScrollHeightRef.current !== null) {
      el.scrollTop += el.scrollHeight - olderHistoryScrollHeightRef.current;
      olderHistoryScrollHeightRef.current = null;
      return;
    }
    if (pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.turns]);

  // Grace-period clear for the plan panel: when a turn finishes (`busy`
  // flips true → false), wait ~700ms so the final ✓ animation reads,
  // then wipe `planItems`. The 1s-per-item timers inside `PlanPanel`
  // will usually empty the list before this fires; this is the safety
  // net for stalled turns that ended without marking every item done.
  // Also cancels on cancel/reset so a re-send doesn't double-clear.
  const planClearTimerRef = useRef(null);
  const prevBusyRef = useRef(false);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = state.busy;
    if (wasBusy && !state.busy && state.planItems.length > 0) {
      if (planClearTimerRef.current) clearTimeout(planClearTimerRef.current);
      planClearTimerRef.current = setTimeout(() => {
        planClearTimerRef.current = null;
        dispatch({ kind: "plan-clear" });
      }, 700);
    }
    if (state.busy && planClearTimerRef.current) {
      // New turn starting (e.g. user sent another message before the
      // grace period fired) — cancel the pending clear so the fresh
      // plan items don't get wiped by a stale timer.
      clearTimeout(planClearTimerRef.current);
      planClearTimerRef.current = null;
    }
  }, [state.busy, state.planItems.length]);
  // Session id change (new conversation / resume) → cancel any pending
  // grace-period clear; the reducer already wiped `planItems` on
  // reset/load-conversation.
  useEffect(() => {
    if (planClearTimerRef.current) {
      clearTimeout(planClearTimerRef.current);
      planClearTimerRef.current = null;
    }
  }, [state.sessionId]);

  const scrollbarHideTimerRef = useRef(null);
  function handleConversationScroll(e) {
    // 80px tolerance — anything within a screenful of the bottom counts as
    // "still following along".
    const el = e.currentTarget;
    pinnedToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
    // Show the scrollbar while the user is actively scrolling, then
    // fade it back out 800 ms after the last scroll event.
    el.classList.add("is-scrolling");
    if (scrollbarHideTimerRef.current) clearTimeout(scrollbarHideTimerRef.current);
    scrollbarHideTimerRef.current = setTimeout(() => {
      el.classList.remove("is-scrolling");
    }, 800);
  }

  // `options` carries per-message slash-command flags (e.g. an armed Deep
  // Research pill contributes `{ deepResearch: true }`); the Composer clears
  // its pill after handing them off so the next send is an ordinary turn.
  async function send(text, options = {}) {
    if (!clientRef.current || state.terminalFailure) return;
    const sendGeneration = ++sendGenerationRef.current;
    cancelGenerationRef.current += 1;
    setActionFailure(null);
    let sessionId = state.sessionId;
    const pending = pendingSessionRef.current;
    if (pending) {
      if (pendingActivationRef.current) return;
      const loadSeq = sessionLoadSeqRef.current;
      const activation = activatePendingSession(clientRef.current, pending);
      pendingActivationRef.current = activation;
      try {
        const session = await activation;
        if (
          loadSeq !== sessionLoadSeqRef.current ||
          pendingSessionRef.current !== pending
        ) {
          return;
        }
        pendingSessionRef.current = null;
        sessionId = session.sessionId;
        activeSessionIdRef.current = sessionId;
        if (pending.resumeFromId) {
          dispatch(resumedConversationAction(session));
          dispatchSessionReplay(dispatch, session.replayEvents);
        } else {
          dispatch({
            kind: "reset-conversation",
            sessionId,
            model: session.model,
            backend: session.backend,
          });
        }
        attachToSession(sessionId, session.eventCursor);
      } catch (err) {
        if (
          loadSeq !== sessionLoadSeqRef.current ||
          pendingSessionRef.current !== pending
        ) {
          return;
        }
        const failedId =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? `u-pending-${crypto.randomUUID()}`
            : `u-pending-${Date.now()}-${Math.random()}`;
        dispatch({
          kind: "user-send",
          text,
          optimisticId: failedId,
          deepResearch: options.deepResearch === true,
        });
        dispatch({
          kind: "agent.error",
          payload: { code: err?.code === "remote_inference_disabled" ? err.code : "send_failed", message: err.message ?? String(err) },
        });
        return;
      } finally {
        if (pendingActivationRef.current === activation) pendingActivationRef.current = null;
      }
    }
    if (!sessionId) return;
    // First message in a fresh hero session — stamp the URL with the
    // session id so a refresh or a shared link resumes this conversation,
    // and tell the sidebar it's now the active row. (refreshConversations
    // on message.end would eventually highlight it too, but waiting until
    // the agent replies before the URL reflects reality feels laggy.)
    // Read the browser location rather than the route prop here. `replaceUrl`
    // intentionally does not dispatch a route-change, so a stale prop must
    // never prevent the first durable conversation URL from being written.
    if (shouldReplaceLandingUrl(window.location.pathname)) {
      replaceUrl(`/portal/agent/${encodeURIComponent(sessionId)}`);
      lastLoadedConvoIdRef.current = sessionId;
      writeAgentReturnState(conversationAgentTarget(sessionId));
      window.dispatchEvent(
        new CustomEvent("omnesis:agent-active-convo", { detail: { id: sessionId } }),
      );
    }
    // UUID-based optimistic id so the eventual `agent.user.message` event
    // (which carries the server-assigned `userMessageId`) can be deduped
    // against this placeholder without colliding on a turn-index counter.
    const optimisticId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? `u-pending-${crypto.randomUUID()}`
        : `u-pending-${Date.now()}-${Math.random()}`;
    dispatch({ kind: "user-send", text, optimisticId, deepResearch: options.deepResearch === true });
    clientRef.current
      .sendMessage(sessionId, text, options)
      .then((resp) => {
        if (!agentRequestIsCurrent(
          sendGeneration,
          sendGenerationRef.current,
          sessionId,
          activeSessionIdRef.current,
        )) return;
        // The send response is the gateway's authoritative confirmation that
        // this session is now a durable conversation. Repeat the landing-URL
        // stamp here in case an earlier render raced the first optimistic send.
        if (
          activeSessionIdRef.current === sessionId &&
          shouldReplaceLandingUrl(window.location.pathname)
        ) {
          replaceUrl(`/portal/agent/${encodeURIComponent(resp?.conversationId ?? sessionId)}`);
        }
        if (resp && resp.userMessageId) {
          dispatch({ kind: "stamp-user-message", optimisticId, userMessageId: resp.userMessageId });
        }
      })
      .catch((err) => {
        if (!agentRequestIsCurrent(
          sendGeneration,
          sendGenerationRef.current,
          sessionId,
          activeSessionIdRef.current,
        )) return;
        if (err?.code === "CONTEXT_WINDOW_EXCEEDED") {
          // The gateway is authoritative. Re-resume to discard the stale
          // optimistic bubble and load its persisted terminalFailure.
          resumeConversation(sessionId);
          return;
        }
        dispatch({
          kind: "agent.error",
          payload: {
            code: err?.code === "remote_inference_disabled" ? err.code : "send_failed",
            message: err.message ?? String(err),
          },
        });
      });
  }
  function cancel() {
    if (!state.busy || !state.sessionId || !clientRef.current) return;
    const sessionId = state.sessionId;
    const cancelGeneration = ++cancelGenerationRef.current;
    setActionFailure(null);
    requestAgentCancel(clientRef.current, sessionId).catch((err) => {
      if (!agentRequestIsCurrent(
        cancelGeneration,
        cancelGenerationRef.current,
        sessionId,
        activeSessionIdRef.current,
      )) return;
      setActionFailure({
        sessionId,
        message: `Stop failed. ${err?.message ?? String(err)}`,
      });
    });
  }

  if (state.fatalError) {
    return html`
      <div class="agent-error-page">
        <h2>Agent unavailable</h2>
        <p class="agent-error-detail">${state.fatalError}</p>
      </div>
    `;
  }

  const cloudRecovery = cloudInferenceRecovery(state);
  const isHero = state.turns.length === 0 && !state.terminalFailure;
  return html`
    <div class=${`agent-page${isHero ? " agent-page-hero" : ""}`}>
      <div class=${`agent-layout${isHero ? " agent-layout-hero" : ""}`}>
        <section class="agent-main">
          ${cloudRecovery ? html`<${AgentCloudInferenceRecovery}
            key=${`${state.sessionId ?? "pending"}:${cloudRecovery.key}`}
            recovery=${cloudRecovery}
            model=${agentModel}
            busy=${state.busy}
            getConfig=${() => clientRef.current.getConfig()}
            onEnabled=${(config) => {
              configPromiseRef.current = Promise.resolve(config);
              dispatch({ kind: "agent-unconfigured", config });
              if (!state.sessionId && !state.turns.length) void createFreshSession();
            }}
            onRetry=${send}
          />` : null}
          ${agentModel && agentModel.configured && agentModel.modelName
            ? html`
              <div class="agent-model-header">
                <${ProviderIcon} providerId=${agentModel.providerId} />
                <span>${agentModel.providerLabel} · ${agentModel.modelName}</span>
                ${developer && state.sessionId
                  ? html`<${DevAnnotateButton}
                      target=${{
                        targetType: "conversation",
                        targetId: state.sessionId,
                        label: `Conversation ${state.sessionId}`,
                      }}
                      developer=${true}
                      title="Flag this conversation"
                    />`
                  : null}
              </div>
            `
            : null}
          ${state.notFoundConvoId
            ? html`
              <div class="agent-notfound-banner">
                <span>Conversation not found. It may have been deleted.</span>
                <button onClick=${newConversation}>+ New</button>
              </div>
            `
            : null}
          ${state.turns.length === 0 &&
          !state.terminalFailure &&
          !hasContextCard(state.briefOrigin)
            ? html`
              <div class="agent-hero">
                <span class="agent-hero-mark" aria-hidden="true"></span>
                <h1 class="agent-hero-headline">Ask Omnesis about your corpus</h1>
                <div class="agent-hero-composer">
                  <${Composer}
                    key=${state.sessionId ?? "fresh-pending"}
                    disabled=${agentComposerDisabled(state.sessionId, state.agentConfig)}
                    busy=${state.busy}
                    onSubmit=${send}
                    onCancel=${cancel}
                    variant="hero"
                    autoFocus=${true}
                    experimental=${experimental}
                  />
                </div>
              </div>
            `
            : html`
              <div class="agent-conversation" ref=${conversationRef} onScroll=${handleConversationScroll}>
                ${state.briefOrigin?.brief
                  ? html`<${BriefContextCard} snapshot=${state.briefOrigin.brief} />`
                  : null}
                ${state.briefOrigin?.watch
                  ? html`<${WatchFiringContextCard}
                      snapshot=${state.briefOrigin.watch}
                      watchId=${state.briefOrigin.watchId} />`
                  : null}
                <${LoadMore}
                  hasMore=${!state.busy && Boolean(state.messageNextCursor)}
                  loading=${historyLoading}
                  error=${historyError}
                  onLoadMore=${loadEarlierMessages}
                  label="Load earlier messages"
                />
                ${state.turns.map((turn) => html`
                  <${MessageBubble} key=${turn.id} turn=${turn} citations=${state.citations} dispatch=${dispatch} />
                `)}
                <${WorkingIndicator}
                  active=${workingIndicatorActive(state)}
                  rev=${workingIndicatorRev(state)} />
              </div>
              <${PlanPanel} items=${state.planItems} />
              ${actionFailure?.sessionId === state.sessionId
                ? html`<${AgentActionError}
                    message=${actionFailure.message}
                    onDismiss=${() => setActionFailure(null)}
                  />`
                : null}
              ${state.terminalFailure
                ? html`<${ContextWindowExceededCard}
                    onNewConversation=${newConversation}
                  />`
                : html`<${Composer}
                    disabled=${agentComposerDisabled(state.sessionId, state.agentConfig)}
                    busy=${state.busy}
                    onSubmit=${send}
                    onCancel=${cancel}
                    experimental=${experimental}
                  />`}
            `}
        </section>

        ${Object.keys(state.trailAnnotations?.byDoc ?? {}).length > 0 ||
        (state.recordCitations?.length ?? 0) > 0
          ? html`<${TimelinePanel}
              trailAnnotations=${state.trailAnnotations}
              records=${state.recordCitations}
            />`
          : null}
      </div>
    </div>
  `;
}

function ConversationsRail({ collapsed, onToggle, conversations, activeId, onSelect, onNew, onDelete, error }) {
  return html`
    <aside class=${`agent-rail${collapsed ? " collapsed" : ""}`}>
      <div class="agent-rail-header">
        <button class="agent-rail-toggle" title=${collapsed ? "Expand" : "Collapse"} onClick=${onToggle}>
          ${collapsed ? "›" : "‹"}
        </button>
        ${!collapsed ? html`<span>Conversations</span>` : null}
        ${!collapsed
          ? html`<button class="agent-rail-new" onClick=${onNew} title="Start a fresh conversation">+ New</button>`
          : null}
      </div>
      ${!collapsed && error
        ? html`<div class="agent-rail-error">${error}</div>`
        : null}
      ${!collapsed
        ? html`
          <div class="agent-rail-list">
            ${(conversations?.length ?? 0) === 0
              ? html`<div class="agent-rail-empty">No prior conversations yet.</div>`
              : conversations.map((c) => html`
                <div
                  key=${c.id}
                  class=${`agent-rail-item${c.id === activeId ? " active" : ""}${c.pinned ? " pinned" : ""}`}
                  onClick=${() => onSelect(c.id)}
                  title=${c.title}
                >
                  <div class="agent-rail-item-title">
                    ${c.pinned
                      ? html`<span class="agent-rail-item-pin" aria-label="Pinned" title="Pinned">${RAIL_PIN_ICON}</span>`
                      : null}
                    ${c.title || "(untitled)"}
                  </div>
                  <div class="agent-rail-item-meta">
                    <span>${fmtRelative(c.updatedAt)}</span>
                    <span>·</span>
                    <span>${c.messageCount} msg</span>
                  </div>
                  <button
                    class="agent-rail-item-delete"
                    onClick=${(e) => { e.stopPropagation(); if (confirm("Delete this conversation?")) onDelete(c.id); }}
                    title="Delete"
                    aria-label="Delete">
                    ×
                  </button>
                </div>
              `)}
          </div>
        `
        : null}
    </aside>
  `;
}

function fmtRelative(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, (Date.now() - then) / 1000);
  if (sec < 60) return "now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// The brief a talk-back thread replies to, pinned above the messages.
// Content is the snapshot stamped at thread creation — it survives the
// brief's expiry/dismissal, and the folded run transcript it visually
// replaces is hidden by `visibleMessages`. The long-form body folds
// behind "Show details" so re-anchoring stays a glance. Mirrors iOS's
// BriefContextCard.
// The watch firing that made the agent open this conversation, pinned
// above the messages. This thread arrives unprompted, and the briefing
// that produced its first message is hidden — the card is what answers
// "why am I reading this". Snapshot semantics as above: stamped at thread
// creation, so it survives the watch being renamed or deleted. Mirrors
// iOS's WatchFiringContextCard.
export function WatchFiringContextCard({ snapshot, watchId }) {
  const firedAt = new Date(snapshot.firedAt);
  const href = typeof watchId === "string" && watchId.length > 0
    ? `/portal/watches/${encodeURIComponent(watchId)}`
    : null;
  function onClick(e) {
    if (!href || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    navigate(href);
  }
  const content = html`
    <div class="agent-brief-card-kicker">
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
           stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 2a4 4 0 0 0-4 4c0 2.5-1 3.5-1 3.5h10S12 8.5 12 6a4 4 0 0 0-4-4Z" />
        <path d="M6.5 12a1.5 1.5 0 0 0 3 0" />
      </svg>
      <span>Watch fired</span>
      ${href ? html`<span class="agent-brief-card-open" aria-hidden="true">View watch ›</span>` : null}
    </div>
    <div class="agent-brief-card-title">${snapshot.name}</div>
    <div class="agent-brief-card-description">
      <!-- A heading, not a sentence stem: the condition is quoted verbatim
           in the operator's own words, often first person. -->
      <strong>Watching for</strong> ${snapshot.condition}
    </div>
    <div class="agent-brief-card-description">
      <code>${Number.isNaN(firedAt.getTime()) ? "" : firedAt.toLocaleString()}</code>
    </div>
  `;
  if (!href) return html`<div class="agent-brief-card">${content}</div>`;
  return html`
    <a class="agent-brief-card agent-brief-card-link"
       href=${href}
       onClick=${onClick}>
      ${content}
    </a>
  `;
}

function BriefContextCard({ snapshot }) {
  const [bodyOpen, setBodyOpen] = useState(false);
  const hasBody = typeof snapshot.body === "string" && snapshot.body.length > 0;
  return html`
    <div class="agent-brief-card">
      <div class="agent-brief-card-kicker">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="6" width="10" height="7" rx="1" />
          <path d="M4.5 4h7 M6 2h4" />
        </svg>
        <span>Brief</span>
      </div>
      <div class="agent-brief-card-title">${snapshot.title}</div>
      <div class="agent-brief-card-description"
           dangerouslySetInnerHTML=${{ __html: renderMarkdown(snapshot.description || "") }} />
      ${hasBody
        ? html`
          ${bodyOpen
            ? html`<div class="agent-brief-card-body"
                dangerouslySetInnerHTML=${{ __html: renderMarkdown(snapshot.body) }} />`
            : null}
          <button type="button" class="agent-brief-card-toggle"
                  onClick=${() => setBodyOpen((v) => !v)}>
            ${bodyOpen ? "Hide details" : "Show details"}
          </button>
        `
        : null}
    </div>
  `;
}

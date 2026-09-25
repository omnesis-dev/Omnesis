// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Direct half of the Audit view: raw corpus reads by external agents,
 * grouped into transcript sessions. Unlike the Answer feed — reviewed
 * releases — these rows are unreviewed reads, so they never reuse the
 * release vocabulary (shared, held, denied).
 *
 * Sessions come from the gateway newest first; opening one lists its tool
 * calls oldest first with expandable bounded arguments and results.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  deleteDirectAuditSession,
  getDirectAuditEvent,
  listDirectAuditSessions,
  listDirectSessionEvents,
} from "../../api.js";
import { renderPart } from "../../components/agent/parts.js";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { Loading } from "../../components/loading.js";
import { navigate } from "../../lib/router.js";
import { PrivacyDetailOverflow } from "./exchange-detail.js";
import {
  errorMessage,
  formatPrivacyDate,
  formatPrivacyTimeOfDay,
  privacyDateTimeAttribute,
} from "../shared/privacy-vocabulary.js";

const DIRECT_SESSION_LIMIT = 50;
const DIRECT_EVENT_LIMIT = 100;

function sessionLabel(session) {
  if (session.explicitKey) {
    const key = String(session.explicitKey);
    const separator = key.indexOf(":");
    if (separator > 0) {
      const kind = key.slice(0, separator);
      const id = key.slice(separator + 1);
      if (kind === "workflow" || kind === "conversation") {
        return `${kind === "workflow" ? "Workflow" : "Conversation"} ${id}`;
      }
    }
    // A key from a newer gateway than this client: show it verbatim rather
    // than guessing a friendlier label.
    return key;
  }
  return "Grouped by activity";
}

function DirectSessionRow({ session, onOpen }) {
  const at = session.lastEventAt ?? session.createdAt;
  const agentName =
    typeof session.principalName === "string" && session.principalName.trim()
      ? session.principalName.trim()
      : "External agent";
  return html`<button
    type="button"
    class="privacy-feed-row privacy-direct-row"
    onClick=${() => onOpen(session)}
  >
    <span class="privacy-feed-main">
      <span class="privacy-feed-question">${agentName}</span>
      <span class="privacy-feed-meta">
        <span>${sessionLabel(session)}</span>
        <span>${session.eventCount} ${session.eventCount === 1 ? "call" : "calls"}</span>
        ${!session.explicitKey
          ? html`<span title="No caller grouping key was sent; calls grouped while idle gaps stay under an hour.">heuristic</span>`
          : null}
      </span>
    </span>
    <time
      class="privacy-feed-time"
      datetime=${privacyDateTimeAttribute(at)}
      title=${formatPrivacyDate(at)}
    >${formatPrivacyTimeOfDay(at)}</time>
    <span class="privacy-row-chevron" aria-hidden="true">›</span>
  </button>`;
}

/**
 * A stored transcript payload as the transcript part the agent views render.
 * The shared tool cards (search/fetch rows with source icons and titles,
 * SQL/trail/people cards) read exactly these fields, so a Direct call renders
 * like the same call in a cognition transcript — with `live` off so nothing
 * animates away in this after-the-fact view. The call's instant and full
 * payload ride along as the shared card's opt-in trailing affordances.
 */
function toTranscriptPart(event, payload) {
  if (!payload || typeof payload.tool !== "string") return null;
  return {
    kind: "tool",
    toolCallId:
      typeof event?.requestId === "string" && event.requestId
        ? event.requestId
        : event?.id ?? payload.tool,
    tool: payload.tool,
    args: payload.args ?? null,
    argsSummary: "",
    result: payload.result ?? null,
    durationMs: null,
    timeText: formatPrivacyTimeOfDay(event?.createdAt),
    rawPayload: payload,
  };
}

/**
 * One transcript call, rendered linearly: the shared tool card is the whole
 * item, timestamped on the right. No nested expand step — the card is already
 * the summary — and no success chip: only failures speak, through the same
 * collapsed error card the Answer and cognition transcripts use.
 */
function DirectCallItem({ event }) {
  const [payload, setPayload] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [visible, setVisible] = useState(false);
  const anchor = useRef(null);

  // Payloads load when the call scrolls into view — a session holds up to
  // DIRECT_EVENT_LIMIT calls and firing all payload fetches on mount
  // thunders the gateway. Above-the-fold cards intersect immediately, so
  // the visible transcript still renders without an extra tap.
  useEffect(() => {
    const node = anchor.current;
    if (!node || typeof IntersectionObserver !== "function") {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    getDirectAuditEvent(event.id)
      .then((detail) => {
        if (cancelled) return;
        setPayload(detail?.event?.payload ?? null);
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err));
      });
    return () => { cancelled = true; };
  }, [event.id, visible]);

  if (error) {
    return html`<div ref=${anchor} class="privacy-banner error" role="alert">${error}</div>`;
  }
  if (!loaded) {
    return html`<div ref=${anchor}><${Loading} label="Loading call…" /></div>`;
  }
  const part = toTranscriptPart(event, payload);
  if (!part || part.result == null) {
    return html`<div ref=${anchor}><p class="privacy-feed-meta">No result recorded.</p></div>`;
  }
  return html`<div ref=${anchor}>${renderPart(part, `${event.id}-card`, null, null, null, false, false)}</div>`;
}

function DirectSessionDetail({ session, onBack, onDeleted }) {
  const sessionId = session?.id;
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(null);
    listDirectSessionEvents(sessionId, { limit: DIRECT_EVENT_LIMIT })
      .then((payload) => {
        if (!cancelled) setEvents(payload?.events ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  async function remove() {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteDirectAuditSession(sessionId);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      setConfirmDelete(false);
      setDeleting(false);
    }
  }

  const agentName =
    typeof session?.principalName === "string" && session.principalName.trim()
      ? session.principalName.trim()
      : "External agent";
  const callCount =
    typeof session?.eventCount === "number"
      ? ` · ${session.eventCount} ${session.eventCount === 1 ? "call" : "calls"}`
      : "";
  return html`<div class="privacy-direct-detail">
    <a
      class="doc-back"
      href="/portal/audit/direct"
      onClick=${(event) => { event.preventDefault(); onBack(); }}
    >← Sessions</a>
    <header class="privacy-detail-header">
      <div>
        <h1>${sessionLabel(session ?? {})}</h1>
        <p>${agentName}${callCount}</p>
      </div>
      <${PrivacyDetailOverflow}
        itemLabel="Delete transcript"
        onDelete=${() => setConfirmDelete(true)}
      />
    </header>
    ${error ? html`<div class="privacy-banner error" role="alert">${error}</div>` : null}
    ${events === null
      ? (error ? null : html`<${Loading} label="Loading transcript…" />`)
      : html`<ol class="privacy-direct-events">
          ${events.map((event) => html`<li key=${event.id}><${DirectCallItem} event=${event} /></li>`)}
        </ol>`}
    ${events && events.length === 0
      ? html`<div class="privacy-empty-state"><strong>No calls in this session</strong></div>`
      : null}
    ${events && events.length >= DIRECT_EVENT_LIMIT
      ? html`<p class="privacy-feed-foot">Showing the ${DIRECT_EVENT_LIMIT} most recent calls.</p>`
      : null}
    <${ConfirmModal}
      open=${confirmDelete}
      title="Delete transcript"
      body="This removes the transcript of every tool call in this session. This cannot be undone."
      confirmLabel=${deleting ? "Deleting…" : "Delete"}
      destructive=${true}
      onConfirm=${remove}
      onCancel=${() => { if (!deleting) setConfirmDelete(false); }}
    />
  </div>`;
}

/**
 * A session's transcript as its own page — like the Answer conversation
 * detail, with no Audit title or tabs above it. The session re-resolves
 * against the reloaded feed so a refresh lands back here; a session older
 * than the feed page probes its events directly, and only a truly unknown
 * id renders the not-found view.
 */
export function DirectSessionDetailRoute({ sessionId }) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);
  // The list page is capped, so a session older than the page is simply
  // past it — probe its events directly instead of crying not-found.
  // undefined = unprobed, true = exists, false = unknown id.
  const [probe, setProbe] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    listDirectAuditSessions({ limit: DIRECT_SESSION_LIMIT })
      .then((payload) => {
        if (!cancelled) setSessions(payload?.sessions ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  const session = sessions
    ? (sessions.find((candidate) => candidate.id === sessionId) ?? null)
    : null;

  useEffect(() => {
    setProbe(undefined);
    if (!sessions || sessions.some((candidate) => candidate.id === sessionId)) return;
    let cancelled = false;
    listDirectSessionEvents(sessionId, { limit: 1 })
      .then(() => { if (!cancelled) setProbe(true); })
      .catch(() => { if (!cancelled) setProbe(false); });
    return () => { cancelled = true; };
  }, [sessions, sessionId]);

  const resolved = session ?? (probe ? { id: sessionId } : null);
  return html`<div class="privacy-view">
    ${error ? html`<div class="privacy-banner error" role="alert">${error}</div>` : null}
    ${sessions === null || (resolved === null && probe === undefined)
      ? (error ? null : html`<${Loading} label="Loading transcript…" />`)
      : !resolved
        ? html`<div class="privacy-empty-state">
            <strong>Session not found</strong>
            <span>This transcript may have been deleted.</span>
          </div>
          <a
            class="doc-back"
            href="/portal/audit/direct"
            onClick=${(event) => { event.preventDefault(); navigate("/portal/audit/direct"); }}
          >← Sessions</a>`
        : html`<${DirectSessionDetail}
            session=${resolved}
            onBack=${() => navigate("/portal/audit/direct")}
            onDeleted=${() => navigate("/portal/audit/direct")}
          />`}
  </div>`;
}

export function DirectAuditPane() {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setSessions(null);
    setError(null);
    listDirectAuditSessions({ limit: DIRECT_SESSION_LIMIT })
      .then((payload) => {
        if (!cancelled) setSessions(payload?.sessions ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => { cancelled = true; };
  }, []);

  return html`<div class="privacy-direct-pane">
    ${error ? html`<div class="privacy-banner error" role="alert">${error}</div>` : null}
    ${sessions === null
      ? (error ? null : html`<${Loading} label="Loading Direct sessions…" />`)
      : sessions.length === 0
        ? html`<div class="privacy-empty-state">
            <strong>No Direct reads recorded</strong>
            <span>Every Direct tool call an external agent makes appears here, grouped into sessions.</span>
          </div>`
        : html`<div class="privacy-feed">
            ${sessions.map((session) => html`<${DirectSessionRow}
              key=${session.id}
              session=${session}
              onOpen=${(opened) => navigate(
                `/portal/audit/direct/${encodeURIComponent(opened.id)}`,
              )}
            />`)}
          </div>`}
    ${sessions && sessions.length >= DIRECT_SESSION_LIMIT
      ? html`<p class="privacy-feed-foot">
          Showing the ${DIRECT_SESSION_LIMIT} most recent sessions.
        </p>`
      : null}
  </div>`;
}

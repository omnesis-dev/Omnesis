// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One firing's trusted audit. Everything on this page is operator-only — the
 * subscriber's surface stops at "the approved condition occurred".
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { getPrivacySubscription, getPrivacySubscriptionFiring } from "../../api.js";
import { navigate } from "../../lib/router.js";
import { watchDebugHref } from "../../lib/watch-trace.js";
import { DocChip } from "../../components/doc-chip.js";
import { Loading } from "../../components/loading.js";
import {
  PrivacyStatus,
  errorMessage,
  formatPrivacyDate,
  formatPrivacyRelativeDate,
  shortId,
} from "../shared/privacy-vocabulary.js";
import {
  firingDeliveryStatusLabel,
  privacySubscriptionDocument,
  privacySubscriptionFiringDocument,
  subscriptionSummary,
} from "./vocabulary.js";

// Outbox states of the wake that carries one firing to the paired integration.
function deliveryStatusLabel(status) {
  const labels = {
    pending: "Queued",
    claimed: "Being prepared",
    retry: "Retrying",
    cancel_pending: "Cancelling",
    commit_authorized: "Cleared to run",
    manual_review: "Needs your attention",
    delivered: "Accepted by the agent",
    failed: "Failed",
  };
  return labels[status] ?? "Unknown";
}

function goToConversation(event, conversationId) {
  event.preventDefault();
  navigate(`/portal/audit/conversations/${encodeURIComponent(conversationId)}`);
}

/**
 * The trusted audit behind one firing: what was nominated, how the precision
 * pass ruled, how the wake was delivered, and which answer conversations the
 * agent opened against it.
 */
export function PrivacySubscriptionFiringDetail({ subscription, firing }) {
  const delivery = firing.delivery ?? null;
  const documents = Array.isArray(firing.evidenceDocuments) ? firing.evidenceDocuments : [];
  const answerTasks = Array.isArray(firing.answerTasks) ? firing.answerTasks : [];
  const firedAt = Number.isFinite(firing.firedAt) ? firing.firedAt : firing.createdAt;
  /**
   * The moment in the watch runtime this firing is, when the record carries it.
   *
   * A wake and an installed watch's firing are the same event seen from two
   * sides, and the canvas addresses one by `(watch, seq)`. Both parts or
   * neither: a firing written before the runtime stamped its identity has no
   * sequence, and a link built on a guess opens somebody else's moment.
   */
  const debugHref =
    typeof firing.watchId === "string" && Number.isFinite(firing.seq)
      ? watchDebugHref(firing.watchId, firing.seq)
      : null;
  return html`<div class="privacy-conversation-detail privacy-subscription-detail">
    <header class="privacy-detail-header">
      <div>
        <h1>Firing ${shortId(firing.id)}</h1>
        <p>${subscriptionSummary(subscription)} · ${formatPrivacyDate(firedAt)}</p>
      </div>
      <span class=${`privacy-item-status ${firing.status === "delivered" ? "success" : "muted"}`}>
        ${firingDeliveryStatusLabel(firing.status)}
      </span>
    </header>
    <dl class="privacy-meta-grid">
      <div><dt>Fired</dt><dd>${formatPrivacyDate(firedAt)}</dd></div>
      <div><dt>Revision</dt><dd>${firing.revision}</dd></div>
      <div><dt>Delivery</dt><dd>${delivery ? deliveryStatusLabel(delivery.status) : "Never queued"}</dd></div>
      <div><dt>Attempts</dt><dd>${delivery ? delivery.attempts : 0}</dd></div>
      <div>
        <dt>Accepted</dt>
        <dd>${Number.isFinite(delivery?.acceptedAt)
          ? formatPrivacyDate(delivery.acceptedAt)
          : "Not accepted yet"}</dd>
      </div>
      <div>
        <dt>Agent run</dt>
        <dd>${delivery?.localRunId ? html`<code>${delivery.localRunId}</code>` : "None reported"}</dd>
      </div>
      ${debugHref
        ? html`<div>
            <dt>In the runtime</dt>
            <dd><a
              class="watch-link"
              href=${debugHref}
              onClick=${(event) => {
                if (
                  event.metaKey
                  || event.ctrlKey
                  || event.shiftKey
                  || event.altKey
                  || event.button !== 0
                ) return;
                event.preventDefault();
                navigate(debugHref);
              }}
            >Open the canvas</a></dd>
          </div>`
        : null}
    </dl>
    ${delivery?.lastError
      ? html`<div class="privacy-banner error" role="alert">${delivery.lastError}</div>`
      : null}
    <section class="privacy-section">
      <header class="privacy-section-head"><h2>What made it fire</h2></header>
      ${documents.length === 0
        ? html`<p class="privacy-empty">
            Nothing in the corpus is behind this one — it came true on a clock,
            a row, or a deadline passing.
          </p>`
        : html`<div class="watch-firing-evidence">
            ${documents.map(
              (document) =>
                html`<${DocChip}
                  key=${document.id}
                  documentId=${document.id}
                  title=${document.title}
                  sourceId=${document.sourceId}
                />`,
            )}
          </div>`}
    </section>
    <section class="privacy-section">
      <header class="privacy-section-head"><h2>What the agent asked back</h2></header>
      ${answerTasks.length === 0
        ? html`<p class="privacy-empty">
            The agent has not come back through the answer boundary for this firing. Its reaction
            runs in a background session of its own, which Omnesis does not record.
          </p>`
        : html`<div class="privacy-conversation-list">
            ${answerTasks.map((task) => {
              const href = `/portal/audit/conversations/${encodeURIComponent(task.conversationId)}`;
              return html`<a
                key=${task.taskId}
                class="privacy-conversation-row"
                href=${href}
                onClick=${(event) => goToConversation(event, task.conversationId)}
              >
                <span class="privacy-conversation-main">
                  <strong>Answer conversation</strong>
                  <span><code>${shortId(task.conversationId)}</code></span>
                </span>
                <span class="privacy-conversation-meta">
                  <span>${formatPrivacyRelativeDate(task.createdAt)}</span>
                </span>
                <${PrivacyStatus} status=${task.status} />
                <span class="privacy-row-chevron" aria-hidden="true">›</span>
              </a>`;
            })}
          </div>`}
    </section>
  </div>`;
}

export function PrivacySubscriptionFiringRoute({ subscriptionId, firingId }) {
  const [subscription, setSubscription] = useState(null);
  const [firing, setFiring] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const generation = useRef(0);
  const backHref = `/portal/watches/${encodeURIComponent(subscriptionId)}`;

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    Promise.all([
      getPrivacySubscription(subscriptionId),
      getPrivacySubscriptionFiring(subscriptionId, firingId),
    ])
      .then(([subscriptionPayload, firingPayload]) => {
        if (generation.current !== current) return;
        const detail = privacySubscriptionDocument(subscriptionPayload);
        const firingDetail = privacySubscriptionFiringDocument(firingPayload);
        if (!detail || !firingDetail) throw new Error("Firing response was incomplete.");
        setSubscription(detail);
        setFiring(firingDetail);
      })
      .catch((err) => {
        if (generation.current === current) setError(errorMessage(err));
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      if (generation.current === current) generation.current += 1;
    };
  }, [subscriptionId, firingId]);

  return html`<div class="privacy-view">
    <a class="doc-back" href=${backHref} onClick=${(event) => {
      event.preventDefault();
      navigate(backHref);
    }}>← Watch</a>
    ${loading ? html`<${Loading} label="Loading firing…" />` : null}
    ${!loading && subscription && firing
      ? html`<${PrivacySubscriptionFiringDetail} subscription=${subscription} firing=${firing} />`
      : null}
    ${!loading && (!subscription || !firing) && error
      ? html`<div class="privacy-banner error" role="alert">Failed to load firing: ${error}</div>`
      : null}
  </div>`;
}

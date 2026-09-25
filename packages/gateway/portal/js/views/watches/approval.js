// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The approval half of a watch's lifecycle: the inbox rows, the request an
 * integration made in full, and the decision the operator takes on it.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  approveSubscriptionApproval,
  denySubscriptionApproval,
  getSubscriptionApproval,
} from "../../api.js";
import { Loading } from "../../components/loading.js";
import { navigate } from "../../lib/router.js";
import {
  PrivacyStatus,
  errorMessage,
  formatPrivacyDate,
  formatPrivacyRelativeDate,
  shortId,
} from "../shared/privacy-vocabulary.js";
import {
  subscriptionApprovalDocument,
  subscriptionGrounding,
  subscriptionGroundingCopy,
  subscriptionGroundingIsQuiet,
  subscriptionIntegrationName,
  subscriptionReactionText,
  subscriptionSummary,
} from "./vocabulary.js";

/**
 * Resolves a watch request, and treats a failed POST as undecided unless one
 * authoritative read proves otherwise: a decision that may have committed is
 * worse to misreport than a decision that plainly failed.
 */
export async function resolveSubscriptionApprovalRequest(approvalId, action) {
  let actionError;
  try {
    const payload = action === "approve"
      ? await approveSubscriptionApproval(approvalId)
      : await denySubscriptionApproval(approvalId);
    const approval = subscriptionApprovalDocument(payload);
    if (!approval) throw new Error("Subscription approval response was incomplete.");
    return approval;
  } catch (error) {
    actionError = error;
  }

  try {
    const approval = subscriptionApprovalDocument(await getSubscriptionApproval(approvalId));
    if (approval && approval.status !== "pending") return approval;
  } catch {
    // Preserve the action failure if current state cannot prove that it committed.
  }
  throw actionError;
}

export function SubscriptionApprovalList({ approvals }) {
  if (approvals.length === 0) return null;
  return html`<ul class="privacy-approval-list privacy-subscription-approval-list">
    ${approvals.map((approval) => html`<li key=${approval.id}>
      <a
        class="privacy-approval-row"
        href=${`/portal/watches/approvals/${encodeURIComponent(approval.id)}`}
        onClick=${(event) => {
          event.preventDefault();
          navigate(`/portal/watches/approvals/${encodeURIComponent(approval.id)}`);
        }}
      >
        <span class="privacy-approval-main">
          <strong>${subscriptionIntegrationName(approval)} wants a new watch</strong>
          <span>${subscriptionSummary(approval)}</span>
        </span>
        <span class="privacy-conversation-meta">${formatPrivacyRelativeDate(approval.createdAt)}</span>
        <${PrivacyStatus} status=${approval.status} />
      </a>
    </li>`)}
  </ul>`;
}

export function SubscriptionApprovalDetail({ approval, busy, error, onApprove, onDeny }) {
  const pending = approval.status === "pending";
  const grounding = subscriptionGrounding(approval);
  return html`<div class="privacy-approval-detail privacy-subscription-detail">
    <header class="privacy-detail-header">
      <div>
        <h1>${approval.revision > 1 ? `Approve watch revision ${approval.revision}?` : "Approve this watch?"}</h1>
        <p>${subscriptionIntegrationName(approval)} wants Omnesis to watch your private index.</p>
      </div>
      <${PrivacyStatus} status=${approval.status} />
    </header>
    <div class="privacy-banner warning">
      Your privacy policy requires approval before this integration can learn that the condition
      occurred. Document identifiers, titles, content, people, source metadata, and private
      evidence stay inside Omnesis.
    </div>
    <section class="privacy-section">
      <header class="privacy-section-head"><h2>What to watch for</h2></header>
      <p class="privacy-subscription-exact">${approval.condition?.description || subscriptionSummary(approval)}</p>
      <p class="privacy-subscription-interpretation">${subscriptionSummary(approval)}</p>
      ${grounding
        ? html`<p
            class=${`privacy-subscription-grounding ${subscriptionGroundingIsQuiet(grounding) ? "warning" : ""}`}
          >${subscriptionGroundingCopy(grounding)}</p>`
        : null}
    </section>
    <section class="privacy-section">
      <header class="privacy-section-head"><h2>What the agent says it will do</h2></header>
      <p class="privacy-subscription-exact">${subscriptionReactionText(approval.reaction)}</p>
      <p class="privacy-subscription-note">This is exact subscriber-authored text. Omnesis never adds corpus-derived instructions to it.</p>
    </section>
    <dl class="privacy-meta-grid">
      <div><dt>Owner</dt><dd>${subscriptionIntegrationName(approval)}</dd></div>
      <div><dt>Owner device</dt><dd>${approval.integrationDevice.name}</dd></div>
      <div><dt>Workflow</dt><dd>${approval.workflow.name}</dd></div>
      <div><dt>Workflow purpose</dt><dd>${approval.workflow.purpose}</dd></div>
      <div><dt>Workflow handle</dt><dd><code>${shortId(approval.workflowHandle)}</code></dd></div>
      <div><dt>Revision</dt><dd>${approval.revision}</dd></div>
      <div><dt>Push detail</dt><dd>${approval.interpretedCondition?.pushDetail || "existence"}</dd></div>
      <div><dt>Expires</dt><dd>${formatPrivacyDate(approval.expiresAt)}</dd></div>
      <div><dt>Policy revision</dt><dd><code>${shortId(approval.policyRevision)}</code></dd></div>
    </dl>
    ${Array.isArray(approval.categories) && approval.categories.length > 0
      ? html`<p class="privacy-subscription-note">Privacy categories: ${approval.categories.join(", ")}</p>`
      : null}
    ${error ? html`<div class="privacy-banner error" role="alert">${error}</div>` : null}
    ${pending
      ? html`<div class="privacy-approval-actions">
          <button type="button" class="btn-primary" disabled=${!!busy} onClick=${onApprove}>
            ${busy === "approve" ? "Approving…" : "Approve watch"}
          </button>
          <button type="button" class="privacy-deny-button" disabled=${!!busy} onClick=${onDeny}>
            ${busy === "deny" ? "Declining…" : "Don’t allow"}
          </button>
        </div>`
      : null}
  </div>`;
}

export function SubscriptionApprovalRoute({ approvalId }) {
  const [approval, setApproval] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    getSubscriptionApproval(approvalId)
      .then((payload) => {
        if (generation.current !== current) return;
        const detail = subscriptionApprovalDocument(payload);
        if (!detail) throw new Error("Watch request response was incomplete.");
        setApproval(detail);
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
  }, [approvalId]);

  async function resolve(action) {
    if (busy) return;
    const current = generation.current;
    setBusy(action);
    setError(null);
    try {
      const resolvedApproval = await resolveSubscriptionApprovalRequest(approvalId, action);
      if (generation.current !== current) return;
      navigate(resolvedApproval.status === "approved"
        ? `/portal/watches/${encodeURIComponent(resolvedApproval.subscriptionId)}`
        : "/portal/watches");
    } catch (err) {
      if (generation.current === current) setError(errorMessage(err));
    } finally {
      if (generation.current === current) setBusy(null);
    }
  }

  return html`<div class="privacy-view">
    <a class="doc-back" href="/portal/watches" onClick=${(event) => {
      event.preventDefault();
      navigate("/portal/watches");
    }}>← Watches</a>
    ${loading ? html`<${Loading} label="Loading watch request…" />` : null}
    ${!loading && approval
      ? html`<${SubscriptionApprovalDetail}
          approval=${approval}
          busy=${busy}
          error=${error}
          onApprove=${() => resolve("approve")}
          onDeny=${() => resolve("deny")}
        />`
      : null}
    ${!loading && !approval && error
      ? html`<div class="privacy-banner error" role="alert">Failed to load watch request: ${error}</div>`
      : null}
  </div>`;
}

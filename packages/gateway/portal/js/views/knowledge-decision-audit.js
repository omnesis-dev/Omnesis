// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { useCursorPage } from "../lib/use-cursor-page.js";
import { DecisionSubject } from "./knowledge-decision-subject.js";
import { LoadMore } from "../components/load-more.js";
import { getKnowledgeDecisionAudit } from "../api.js";
import { DecisionInputInspection, KnowledgeDecisionCard } from "./cognition-knowledge-decisions.js";

export const decisionAuditPurposes = [
  ["", "All judgements"], ["discovery", "Discovery admission"], ["impact", "Change impact"],
  ["review", "Review timing"], ["urgency", "Scheduling urgency"],
  ["worth-gate", "Worth admission"], ["record-check", "Record check"],
];
export function decisionAuditQuery(purpose, { limit, cursor }) {
  return { ...(purpose ? { purpose } : {}), limit, ...(cursor ? { cursor } : {}) };
}
export function LegacyDecisionAuditCard({ decision }) {
  const score = (value) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "Unavailable";
  const outcome = decision.reusedFrom ? "Reused a prior judgement; no model call was made for this entry."
    : decision.verdict === "pass" ? "Gate allowed this attempt."
      : decision.verdict === "skip" ? decision.enforced ? "Gate blocked this attempt." : "Shadow check: would block; did not enforce."
        : "Allowed without a usable verdict.";
  return html`<article class="cognition-decision">
    <div class="cognition-decision-head"><strong>${decision.purpose === "worth-gate" ? "Worth admission" : "Record check"}</strong>
      <span>Score ${score(decision.score)} · scale 0–3 · threshold ${score(decision.threshold)}</span></div>
    <p>${outcome}</p>
    <dl class="kn-facts">${decision.subjectRef && html`<dt>About</dt><dd><${DecisionSubject} subject=${decision.subjectRef} /></dd>`}<dt>Model</dt><dd>${decision.modelId || "Not recorded"}</dd>
      <dt>Decided</dt><dd>${new Date(decision.createdAt).toLocaleString()}</dd>
      <dt>Run</dt><dd>${decision.runAvailable
        ? html`<a href=${`/portal/debug/cognition/runs/${encodeURIComponent(decision.runId)}`}>View run</a>`
        : "No longer retained"}</dd>
    </dl>
    <details class="cognition-decision-details"><summary>Decision metadata</summary><dl class="kn-facts">
      <dt>Rubric</dt><dd>${decision.rubricVersion}</dd>
      <dt>Latency</dt><dd>${decision.latencyMs == null ? "Not recorded" : `${decision.latencyMs} ms`}</dd>
      <dt>Input tokens</dt><dd>${decision.inputTokens ?? "Not recorded"}</dd>
      ${decision.subjectDocumentId && html`<dt>Subject</dt><dd><code>${decision.subjectDocumentId}</code></dd>`}
      ${decision.reusedFrom && html`<dt>Reused decision</dt><dd><code>${decision.reusedFrom}</code></dd>`}
      <dt>Decision ID</dt><dd><code>${decision.id}</code></dd>
    </dl></details>
    <${DecisionInputInspection} id=${decision.id} legacy=${true} />
  </article>`;
}
function DecisionAuditContents() {
  const [purpose, setPurpose] = useState("");
  const page = useCursorPage({
    resetKey: purpose, pageSize: 20, itemKey: (item) => `${item.kind}:${item.id}`,
    loadPage: (paging) => getKnowledgeDecisionAudit(decisionAuditQuery(purpose, paging)),
  });
  return html`<label class="debug-operations-kind">Judgement type
    <select aria-label="Judgement type" value=${purpose} onChange=${(event) => setPurpose(event.target.value)}>
      ${decisionAuditPurposes.map(([value, label]) => html`<option value=${value}>${label}</option>`)}
    </select></label>
    ${page.loading && html`<p role="status">Loading decision audit…</p>`}
    ${page.error && html`<p role="alert">Decision audit could not be loaded.</p><button class="kn-button" onClick=${page.reload}>Retry audit</button>`}
    ${!page.loading && !page.error && !page.items.length && html`<p class="cognition-dim">No recorded judgements match this filter. This does not establish that a gate was bypassed.</p>`}
    <div class="km-audit-rows">${page.items.map((decision) => html`<details class="cognition-decision-details" key=${`${decision.kind}:${decision.id}`}>
      <summary>${decisionAuditPurposes.find(([value]) => value === decision.purpose)?.[1] ?? decision.purpose} · ${new Date(decision.createdAt).toLocaleString()} · ${Number.isFinite(decision.score) ? decision.score.toFixed(2) : "Unavailable"} / ${decision.kind === "legacy" ? "3" : "1"}</summary>
      <${decision.kind === "legacy" ? LegacyDecisionAuditCard : KnowledgeDecisionCard} decision=${decision} />
    </details>`)}</div>
    <${LoadMore} hasMore=${page.hasMore} loading=${page.loadingMore} error=${page.loadMoreError} onLoadMore=${page.loadMore} label="Load more judgements" />`;
}
/** Keeping the contents unmounted avoids fetching an audit the operator has not requested. */
export function KnowledgeDecisionAudit() {
  const [open, setOpen] = useState(false);
  return html`<details class="km-decision-audit" onToggle=${(event) => setOpen(event.currentTarget.open)}>
    <summary>Retained decision history</summary>
    ${open && html`<${DecisionAuditContents} />`}
  </details>`;
}

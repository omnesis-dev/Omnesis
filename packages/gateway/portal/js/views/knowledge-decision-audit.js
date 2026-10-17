// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { useCursorPage } from "../lib/use-cursor-page.js";
import { LoadMore } from "../components/load-more.js";
import { DecisionCard, DECISION_PURPOSES } from "../components/decision-card.js";
import { getKnowledgeDecisionAudit } from "../api.js";

export const decisionAuditPurposes = [["", "All judgements"], ...DECISION_PURPOSES];
export function decisionAuditQuery(purpose, { limit, cursor }) {
  return { ...(purpose ? { purpose } : {}), limit, ...(cursor ? { cursor } : {}) };
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
    <div class="km-audit-rows">${page.items.map((decision) => html`<${DecisionCard} key=${`${decision.kind}:${decision.id}`} decision=${decision} layout="compact" />`)}</div>
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

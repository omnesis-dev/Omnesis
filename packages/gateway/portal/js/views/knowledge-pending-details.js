// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { LoadMore } from "../components/load-more.js";
import { useCursorPage } from "../lib/use-cursor-page.js";
import { getKnowledgePendingWork } from "../api.js";
import { DecisionSubject } from "./knowledge-decision-subject.js";
import { KnowledgeDecisionCard } from "./cognition-knowledge-decisions.js";

export function pendingWorkQuery(group, paging) {
  return { reason: group.reason, tier: group.tier, ...(group.readiness ? { readiness: group.readiness } : {}), ...paging };
}
function PendingGroupContents({ group }) {
  const page = useCursorPage({ resetKey: JSON.stringify([group.reason, group.tier, group.readiness]), pageSize: 20,
    loadPage: (paging) => getKnowledgePendingWork(pendingWorkQuery(group, paging)) });
  return html`${page.loading && html`<p role="status">Loading pending inputs…</p>`}
    ${page.error && html`<p role="alert">Pending inputs could not be loaded.</p><button class="kn-button" onClick=${page.reload}>Retry</button>`}
    ${!page.loading && !page.error && !page.items.length && html`<p class="cognition-dim">No inputs remain in this pending group.</p>`}
    ${page.items.map((work) => html`<details class="cognition-decision-details" key=${work.id}>
      <summary><${DecisionSubject} subject=${work.subjectRef} /> · Eligible ${new Date(work.dueAt).toLocaleString()}</summary>
      ${work.decisions.items.length ? work.decisions.items.map((item) => html`<${KnowledgeDecisionCard} key=${item.id} decision=${item} showSubject=${false} />`)
        : html`<p class="cognition-dim">No recorded judgement is associated with this work. This does not establish that a gate was bypassed.</p>`}
      ${work.decisions.truncated && html`<p class="cognition-dim">Additional recorded checks are not shown.</p>`}
    </details>`)}
    <${LoadMore} hasMore=${page.hasMore} loading=${page.loadingMore} error=${page.loadMoreError} onLoadMore=${page.loadMore} label="Load more pending inputs" />`;
}
export function PendingWorkDetails({ group }) {
  const [open, setOpen] = useState(false);
  const key = JSON.stringify([group.reason, group.tier, group.readiness]);
  return html`<details class="cognition-decision-details" onToggle=${(event) => setOpen(event.currentTarget.open)}>
    <summary>Decision details</summary>
    ${open && html`<${PendingGroupContents} key=${key} group=${group} />`}
  </details>`;
}

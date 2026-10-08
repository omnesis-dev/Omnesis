// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { PendingWorkDetails } from "./knowledge-pending-details.js";
import { html } from "htm/preact";
import { KnowledgeDecisionAudit } from "./knowledge-decision-audit.js";
import { DecisionContextDetails } from "./knowledge-decision-context.js";
import { ContextualDecisions } from "./cognition-knowledge-decisions.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { navigate } from "../lib/router.js";
import { LoadMore } from "../components/load-more.js";
import { useCursorPage } from "../lib/use-cursor-page.js";
import { Segmented } from "../components/segmented.js";
import { KnowledgeIcon } from "../lib/knowledge-link-icons.js";
import { getKnowledgeStatus, getKnowledgeBatches, getKnowledgeBatch, getKnowledgeNode, getDocumentSummariesBulk } from "../api.js";
import { knowledgeReferenceHref, knowledgePath, readable } from "./knowledge-reader.js";
import { summarizeMaintenance, batchStatusLabel, maintenanceTierLabel, maintenanceReasonLabel } from "./knowledge-maintenance-model.js";

const maintenancePath = (id) => `/portal/debug/cognition/maintenance${id ? `/${encodeURIComponent(id)}` : ""}`;
const timestamp = (value) => value == null ? "Not scheduled" : new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", year: "numeric" });
function follow(event) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href"));
}
export function decisionsForFrontierItem(decisions, frontier, item) {
  const repeated = frontier.filter((entry) => entry.nodeId === item.nodeId).length > 1;
  return decisions.filter((decision) => decision.nodeId === item.nodeId && (!repeated || decision.inputFingerprint === item.inputFingerprint));
}
const resultLabel = (value) => ({ changed: "Updated", unchanged: "Unchanged", skipped: "Skipped", pending: "Waiting", offered: "Offered to agent", deferred: "Deferred" })[value] ?? readable(value);
function BatchBadge({ status }) {
  return html`<span class=${`km-badge km-badge--${["completed", "abandoned", "running"].includes(status) ? status : "pending"}`}>${batchStatusLabel(status)}</span>`;
}
export function MaintenancePills({ tier, reasons = [] }) {
  return html`<span class="km-pills"><span class="km-badge">${maintenanceTierLabel(tier)}</span>${[...new Set(reasons)].map((reason) => html`<span class="km-badge">${maintenanceReasonLabel(reason)}</span>`)}</span>`;
}
export function WaitingWork({ status, reason, tier }) {
  const summary = summarizeMaintenance(status, { reason, tier });
  return html`<section class="km-queue" aria-label="Pending work">
    <div class="km-section-heading"><div><h2>Pending work <span class="km-count">${summary.waiting}</span></h2>
      <p>Inputs waiting to be grouped into a maintenance batch.</p></div></div>
    ${summary.waitingGroups.length ? html`<table class="km-work-table">
      <thead><tr><th scope="col">Work</th><th scope="col" class="km-input-count">Inputs</th><th scope="col">Readiness</th></tr></thead>
      <tbody>${summary.waitingGroups.map((row) => html`<tr key=${JSON.stringify([row.reason, row.tier, row.readiness])}>
        <td><${MaintenancePills} tier=${row.tier} reasons=${[row.reason]} /></td>
        <td class="km-input-count">${row.count}</td>
        <td class="km-readiness">${row.readiness === "pending_content" ? "Awaiting content" : row.readiness === "derivation" ? "Processing document" : row.readiness ? "Awaiting retry" : "Scheduled"}
          ${row.nextDueAt != null && html`<time datetime=${new Date(row.nextDueAt).toISOString()}>Eligible ${timestamp(row.nextDueAt)}</time>`}
        </td>
      </tr><tr class="km-work-explanation"><td colspan="3"><${PendingWorkDetails} key=${JSON.stringify([row.reason, row.tier, row.readiness])} group=${row} /></td></tr>`)}</tbody>
    </table>` : html`<p class="km-clear">No inputs waiting.</p>`}
    ${(summary.assigned > 0 || summary.cascades > 0) && html`<div class="km-queue-followup">
      ${summary.assigned > 0 && html`<span>${summary.assigned} ${summary.assigned === 1 ? "input assigned" : "inputs assigned"} to batches</span>`}
      ${summary.cascades > 0 && html`<span>${summary.cascades} dependency ${summary.cascades === 1 ? "update" : "updates"} awaiting propagation</span>`}
    </div>`}
  </section>`;
}
function BatchDetail({ id, summary }) {
  const [names, setNames] = useState({});
  const [references, setReferences] = useState({});
  const [state, setState] = useState({ loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    setNames({});
    setReferences({});
    getKnowledgeBatch(id).then(async (data) => {
      if (!alive) return;
      setState({ data });
      const ids = [...new Set((data.frontier ?? []).map((item) => item.nodeId))].slice(0, 50);
      const sourceIds = ids.filter((item) => item.startsWith("source:")).map((item) => item.slice(7));
      const [sources, nodes] = await Promise.all([
        getDocumentSummariesBulk(sourceIds).catch(() => ({ docs: {} })),
        Promise.allSettled(ids.filter((item) => !item.startsWith("source:")).map((item) => getKnowledgeNode(item))),
      ]);
      if (!alive) return;
      const next = {}, metadata = {};
      for (const [sourceId, doc] of Object.entries(sources.docs ?? {})) {
        next[`source:${sourceId}`] = doc.title;
        metadata[`source:${sourceId}`] = { kind: "source", sourceId: doc.source_id };
      }
      for (const result of nodes) if (result.status === "fulfilled") {
        next[result.value.id] = result.value.title;
        metadata[result.value.id] = { kind: result.value.kind };
      }
      setNames(next);
      setReferences(metadata);
    }).catch((error) => { if (alive) setState({ error: error.message }); });
    return () => { alive = false; };
  }, [id, retry]);
  if (state.loading) return html`<div class="km-detail-state" role="status">Loading batch…</div>`;
  if (state.error) return html`<div class="km-detail-state" role="alert"><p>This batch could not be loaded. ${state.error}</p><button class="kn-button" onClick=${() => setRetry((value) => value + 1)}>Retry</button></div>`;
  const result = state.data;
  const frontier = result.frontier ?? [];
  const counts = frontier.reduce((all, item) => ({ ...all, [item.status]: (all[item.status] ?? 0) + 1 }), {});
  return html`<section class="kn-batch-detail km-detail" aria-label="Batch details">
    <header class="km-detail-header">
      <div class="km-section-heading"><h2>Maintenance batch</h2><${BatchBadge} status=${result.status} /></div>
      <${MaintenancePills} tier=${result.tier} reasons=${result.reasons ?? []} />
      ${summary && html`<p class="km-detail-date">Created ${timestamp(summary.createdAt)}${summary.finishedAt ? ` · Finished ${timestamp(summary.finishedAt)}` : ""}</p>`}
      ${result.runId ? html`<a class="km-transcript" href=${`/portal/debug/cognition/runs/${encodeURIComponent(result.runId)}`}>View agent transcript ↗</a>` : html`<p class="kn-caption">No agent run assigned.</p>`}
    </header>
    <div class="km-detail-body">
      ${frontier.length > 0 && html`<div class="km-outcomes" aria-label="Check outcomes">${Object.entries(counts).map(([status, count]) => html`<span><strong>${count}</strong> ${resultLabel(status)}</span>`)}</div>`}
      ${result.decisions?.truncated && html`<p class="cognition-dim">Additional recorded decisions are not shown in this bounded batch view.</p>`}
      ${result.decisions?.legacyIncomplete && html`<p class="cognition-dim">Historical decision associations are incomplete.</p>`}
      <h3>Inputs and outcomes</h3>
      ${frontier.length > 0 ? html`<ul class="km-node-list">${frontier.map((item) => html`<li key=${`${item.nodeId}:${item.inputFingerprint}`}>
        <a href=${item.nodeId.startsWith("source:") ? knowledgeReferenceHref(item.nodeId) : knowledgePath(item.nodeId)}><${KnowledgeIcon} ...${references[item.nodeId] ?? {}} />${names[item.nodeId] ?? (item.nodeId.startsWith("source:") ? "Source document" : "Knowledge page")}</a>
        <${DecisionContextDetails} key=${item.inputFingerprint} contextKey=${item.nodeId} title=${names[item.nodeId] ?? "Input checks"} decisions=${decisionsForFrontierItem(result.decisions?.items ?? [], frontier, item)} />
        <span class=${`km-node-result ${item.status === "changed" ? "is-changed" : ""}`}>${resultLabel(item.status)}</span>
      </li>`)}</ul>` : html`<p class="kn-caption">No checks recorded for this batch.</p>`}
      ${(result.decisions?.items ?? []).some((decision) => !frontier.some((item) => decisionsForFrontierItem([decision], frontier, item).length)) && html`<${ContextualDecisions} title="Other batch checks" decisions=${result.decisions.items.filter((decision) => !frontier.some((item) => decisionsForFrontierItem([decision], frontier, item).length))} audit=${result.decisions} />`}
    </div>
  </section>`;
}
export function KnowledgeMaintenanceTab({ selectedId } = {}) {
  const pageRef = useRef(null);
  const listRef = useRef(null);
  const inspectorRef = useRef(null);
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState("all");
  const [reason, setReason] = useState("");
  const [tier, setTier] = useState("");
  const page = useCursorPage({
    resetKey: JSON.stringify([filter, reason, tier, refresh]),
    pageSize: 30,
    loadPage: ({ limit, cursor }) => getKnowledgeBatches({ status: filter, reason: reason || undefined, tier: tier || undefined, limit, cursor }),
  });
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    getKnowledgeStatus().then((value) => {
      if (alive) setState({ status: { status: "fulfilled", value }, loading: false });
    }, () => { if (alive) setState({ status: { status: "rejected" }, loading: false }); });
    return () => { alive = false; };
  }, [refresh]);
  useEffect(() => {
    if (!state.loading && pageRef.current?.getBoundingClientRect().width <= 760)
      (selectedId ? inspectorRef : listRef).current?.focus();
  }, [selectedId, state.loading]);
  const batches = page.items;
  const changeFilter = (setter, value) => { setter(value); if (selectedId) navigate(maintenancePath()); };
  return html`<div class="knowledge-library km-page" ref=${pageRef}>
    <header class="kn-header"><div><h1>Maintenance</h1><p>Pending inputs and the batches that keep your knowledge up to date.</p></div>
      <button class="kn-button" disabled=${state.loading} onClick=${() => setRefresh((value) => value + 1)}>Refresh</button>
    </header>
    <div class="km-filter" aria-label="Maintenance filters">
          <label class="debug-operations-kind">Reason <select aria-label="Maintenance reason" value=${reason} onChange=${(event) => changeFilter(setReason, event.target.value)}><option value="">All reasons</option>${["change", "discovery", "review", "root", "upgrade"].map((value) => html`<option value=${value}>${maintenanceReasonLabel(value)}</option>`)}</select></label>
          <label class="debug-operations-kind">Tier <select aria-label="Maintenance tier" value=${tier} onChange=${(event) => changeFilter(setTier, event.target.value)}><option value="">All tiers</option>${["immediate", "soon", "routine"].map((value) => html`<option value=${value}>${maintenanceTierLabel(value)}</option>`)}</select></label>
    </div>
    ${state.loading ? html`<p role="status">Loading maintenance…</p>` : html`
      ${state.status.status === "fulfilled" ? html`<${WaitingWork} status=${state.status.value} reason=${reason} tier=${tier} />` : html`<p role="alert">Pending work could not be loaded. Refresh to try again.</p>`}
      <section class="km-batches" aria-label="Maintenance batches">
        <div class="km-section-heading"><div><h2>Maintenance batches</h2><p>${batches.length} loaded${page.isPartial ? " · More available" : ""}. A batch can group inputs with several reasons.</p></div></div>
        <div class="km-filter">
          <${Segmented} options=${[{value:"all",label:"All"},{value:"active",label:"Active"},{value:"history",label:"History"}]} value=${filter} onChange=${(value) => changeFilter(setFilter, value)} />

        </div>
        ${page.error ? html`<p role="alert">Batches could not be loaded. Refresh to try again.</p>` : html`
          ${page.loading && html`<p role="status">Loading batches…</p>`}
          <div class=${`km-workspace ${selectedId ? "has-selection" : ""}`}>
            <nav class="km-batch-list" aria-label="Maintenance batch list" ref=${listRef} tabindex="-1">
              ${batches.map((item) => html`<a class=${`km-batch-row ${selectedId === item.id ? "is-selected" : ""}`} key=${item.id}
                href=${maintenancePath(item.id)} onClick=${follow} aria-current=${selectedId === item.id ? "true" : undefined}>
                <div><strong>Maintenance batch</strong><${BatchBadge} status=${item.status} /></div>
                <${MaintenancePills} tier=${item.tier} reasons=${item.reasons ?? []} />
                <time>${timestamp(item.createdAt)}</time>
              </a>`)}
              ${!batches.length && !page.loading && html`<p class="km-list-empty">No batches match these filters.</p>`}
              <${LoadMore} hasMore=${page.hasMore} loading=${page.loadingMore} error=${page.loadMoreError} onLoadMore=${page.loadMore} label="Load more batches" />
            </nav>
            <div class="km-inspector" ref=${inspectorRef} tabindex="-1" aria-label="Selected batch">
              ${selectedId ? html`<a class="km-back" href=${maintenancePath()} onClick=${follow}>← Back to batches</a><${BatchDetail} key=${`${selectedId}:${refresh}`} id=${selectedId} summary=${batches.find((item) => item.id === selectedId)} />` : html`<div class="km-selection-empty"><span aria-hidden="true">↖</span><h3>Select a batch</h3><p>See which inputs were checked, what changed, and the agent transcript.</p></div>`}
            </div>
          </div>`}
      </section>
      <details class="km-advanced"><summary>Advanced</summary><${KnowledgeDecisionAudit} /></details>`}
  </div>`;
}

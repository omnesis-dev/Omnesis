// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { navigate } from "../lib/router.js";
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
const resultLabel = (value) => ({ changed: "Updated", unchanged: "Unchanged", skipped: "Skipped", pending: "Waiting", offered: "Offered to agent", deferred: "Deferred" })[value] ?? readable(value);
function BatchBadge({ status }) {
  return html`<span class=${`km-badge km-badge--${["completed", "abandoned", "running"].includes(status) ? status : "pending"}`}>${batchStatusLabel(status)}</span>`;
}
function WaitingWork({ status }) {
  const summary = summarizeMaintenance(status);
  return html`<section class="km-queue" aria-label="Pending work">
    <div class="km-section-heading"><div><h2>Pending work <span class="km-count">${summary.waiting}</span></h2>
      <p>Inputs waiting to be grouped into a maintenance batch.</p></div></div>
    ${summary.waitingGroups.length ? html`<ul class="km-work-list">${summary.waitingGroups.map((row) => html`<li>
      <div><strong>${maintenanceReasonLabel(row.reason)}</strong>
        <span class="km-work-meta">${maintenanceTierLabel(row.tier)} · ${row.count} ${row.count === 1 ? "input" : "inputs"}</span>
      </div>
      <div class="km-work-schedule">${row.readiness === "pending_content" ? "Waiting for source content" : row.readiness === "derivation" ? "Waiting for document processing" : row.readiness ? "Waiting for retry" : "Scheduled"}
        ${row.nextDueAt != null && html`<time>Eligible from ${timestamp(row.nextDueAt)}</time>`}
      </div>
    </li>`)}</ul>` : html`<p class="km-clear">No inputs waiting.</p>`}
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
      <div class="km-section-heading"><h2>${maintenanceTierLabel(result.tier)} maintenance</h2><${BatchBadge} status=${result.status} /></div>
      ${summary && html`<p class="km-detail-date">Created ${timestamp(summary.createdAt)}${summary.finishedAt ? ` · Finished ${timestamp(summary.finishedAt)}` : ""}</p>`}
      ${result.runId ? html`<a class="km-transcript" href=${`/portal/debug/cognition/runs/${encodeURIComponent(result.runId)}`}>View agent transcript ↗</a>` : html`<p class="kn-caption">No agent run assigned.</p>`}
    </header>
    <div class="km-detail-body">
      ${frontier.length > 0 && html`<div class="km-outcomes" aria-label="Check outcomes">${Object.entries(counts).map(([status, count]) => html`<span><strong>${count}</strong> ${resultLabel(status)}</span>`)}</div>`}
      <h3>Inputs and outcomes</h3>
      ${frontier.length > 0 ? html`<ul class="km-node-list">${frontier.map((item) => html`<li key=${`${item.nodeId}:${item.inputFingerprint}`}>
        <a href=${item.nodeId.startsWith("source:") ? knowledgeReferenceHref(item.nodeId) : knowledgePath(item.nodeId)}><${KnowledgeIcon} ...${references[item.nodeId] ?? {}} />${names[item.nodeId] ?? (item.nodeId.startsWith("source:") ? "Source document" : "Knowledge page")}</a>
        <span class=${`km-node-result ${item.status === "changed" ? "is-changed" : ""}`}>${resultLabel(item.status)}</span>
      </li>`)}</ul>` : html`<p class="kn-caption">No checks recorded for this batch.</p>`}
    </div>
  </section>`;
}
export function KnowledgeMaintenanceTab({ selectedId } = {}) {
  const pageRef = useRef(null);
  const listRef = useRef(null);
  const inspectorRef = useRef(null);
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState("all");
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    Promise.allSettled([getKnowledgeStatus(), getKnowledgeBatches()]).then(([status, batches]) => {
      if (alive) setState({ status, batches, loading: false });
    });
    return () => { alive = false; };
  }, [refresh]);
  useEffect(() => {
    if (!state.loading && pageRef.current?.getBoundingClientRect().width <= 760)
      (selectedId ? inspectorRef : listRef).current?.focus();
  }, [selectedId, state.loading]);
  const batches = state.batches?.status === "fulfilled" ? state.batches.value.items : [];
  const active = batches.filter((batch) => ["pending", "running"].includes(batch.status));
  const history = batches.filter((batch) => !["pending", "running"].includes(batch.status));
  const visible = filter === "active" ? active : filter === "history" ? history : batches;
  return html`<div class="knowledge-library km-page" ref=${pageRef}>
    <header class="kn-header"><div><h1>Maintenance</h1><p>Pending inputs and the batches that keep your knowledge up to date.</p></div>
      <button class="kn-button" disabled=${state.loading} onClick=${() => setRefresh((value) => value + 1)}>Refresh</button>
    </header>
    ${state.loading ? html`<p role="status">Loading maintenance…</p>` : html`
      ${state.status.status === "fulfilled" ? html`<${WaitingWork} status=${state.status.value} />` : html`<p role="alert">Pending work could not be loaded. Refresh to try again.</p>`}
      <section class="km-batches" aria-label="Maintenance batches">
        <div class="km-section-heading"><div><h2>Recent batches</h2>${state.batches.status === "fulfilled" && html`<p>Latest ${batches.length} batches, including completed history. A batch can group several inputs.</p>`}</div></div>
        ${state.batches.status !== "fulfilled" ? html`<p role="alert">Batches could not be loaded. Refresh to try again.</p>` : html`
          <div class="km-filter"><${Segmented} options=${[{value:"all",label:"All",count:batches.length},{value:"active",label:"Active",count:active.length},{value:"history",label:"History",count:history.length}]} value=${filter} onChange=${(value) => { setFilter(value); if (selectedId) navigate(maintenancePath()); }} /></div>
          <div class=${`km-workspace ${selectedId ? "has-selection" : ""}`}>
            <nav class="km-batch-list" aria-label="Maintenance batch list" ref=${listRef} tabindex="-1">
              ${visible.map((item) => html`<a class=${`km-batch-row ${selectedId === item.id ? "is-selected" : ""}`} key=${item.id}
                href=${maintenancePath(item.id)} onClick=${follow} aria-current=${selectedId === item.id ? "true" : undefined}>
                <div><strong>${maintenanceTierLabel(item.tier)} maintenance</strong><${BatchBadge} status=${item.status} /></div>
                <time>${timestamp(item.createdAt)}</time>
              </a>`)}
              ${!visible.length && html`<p class="km-list-empty">${filter === "active" ? "No active batches in recent history." : filter === "history" ? "No finished batches in recent history." : "No maintenance batches yet."}</p>`}
            </nav>
            <div class="km-inspector" ref=${inspectorRef} tabindex="-1" aria-label="Selected batch">
              ${selectedId ? html`<a class="km-back" href=${maintenancePath()} onClick=${follow}>← Back to batches</a><${BatchDetail} key=${`${selectedId}:${refresh}`} id=${selectedId} summary=${batches.find((item) => item.id === selectedId)} />` : html`<div class="km-selection-empty"><span aria-hidden="true">↖</span><h3>Select a batch</h3><p>See which inputs were checked, what changed, and the agent transcript.</p></div>`}
            </div>
          </div>`}
      </section>`}
  </div>`;
}

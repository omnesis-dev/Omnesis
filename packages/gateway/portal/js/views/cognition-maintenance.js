// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { navigate } from "../lib/router.js";
import { KnowledgeIcon } from "../lib/knowledge-link-icons.js";
import {
  getKnowledgeStatus,
  getKnowledgeBatches,
  getKnowledgeBatch,
  getKnowledgeNode,
  getDocumentSummariesBulk,
} from "../api.js";
import {
  KnowledgeStatus,
  knowledgeReferenceHref,
  knowledgePath,
  readable,
} from "./knowledge-reader.js";
function BatchDetail({ id }) {
  const [names, setNames] = useState({});
  const [references, setReferences] = useState({});
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    getKnowledgeBatch(id)
      .then(async (data) => {
        if (!alive) return;
        setState({ data });
        setNames({});
        setReferences({});
        const ids = [...new Set((data.frontier ?? []).map((item) => item.nodeId))].slice(0, 50);
        const sourceIds = ids.filter((id) => id.startsWith("source:")).map((id) => id.slice(7));
        const [sources, nodes] = await Promise.all([
          getDocumentSummariesBulk(sourceIds).catch(() => ({ docs: {} })),
          Promise.allSettled(
            ids.filter((id) => !id.startsWith("source:")).map((id) => getKnowledgeNode(id)),
          ),
        ]);
        if (!alive) return;
        const next = {}, metadata = {};
        for (const [id, doc] of Object.entries(sources.docs ?? {}))
          { next[`node:source:${id}`] = doc.title; metadata[`source:${id}`] = { kind: "source", sourceId: doc.source_id }; }
        for (const result of nodes)
          if (result.status === "fulfilled") { next[`node:${result.value.id}`] = result.value.title; metadata[result.value.id] = { kind: result.value.kind }; }
        setNames(next);
        setReferences(metadata);
      })
      .catch((error) => {
        if (alive) setState({ error: error.message });
      });
    return () => {
      alive = false;
    };
  }, [id]);
  if (state.loading) return html`<p role="status">Loading maintenance details…</p>`;
  if (state.error)
    return html`<p role="alert">Could not load this maintenance run. ${state.error}</p>`;
  const result = state.data;
  return html`<section class="kn-batch-detail">
    <p>
      ${readable(result.tier)} · ${readable(result.status)} ·
      ${result.runId
        ? html`<a href=${`/portal/debug/cognition/runs/${encodeURIComponent(result.runId)}`}
            >Open agent run ↗</a
          >`
        : html`<span>No agent run assigned yet</span>`}
    </p>
    <ul>
      ${(result.frontier ?? []).map(
        (item) =>
          html`<li key=${`${item.nodeId}:${item.inputFingerprint}`}>
            <a
              href=${item.nodeId.startsWith("source:")
                ? knowledgeReferenceHref(item.nodeId)
                : knowledgePath(item.nodeId)}
              ><${KnowledgeIcon} ...${references[item.nodeId] ?? {}} />${names[`node:${item.nodeId}`] ??
              (item.nodeId.startsWith("source:") ? "Source document" : "Knowledge page")}</a
            ><span>${readable(item.status)}</span>
          </li>`,
      )}
    </ul>
  </section>`;
}
export function KnowledgeMaintenanceTab({ selectedId } = {}) {
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState({ loading: true });
  const batch = selectedId ?? null;
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    Promise.allSettled([getKnowledgeStatus(), getKnowledgeBatches()]).then(([status, batches]) => {
      if (alive) setState({ status, batches, loading: false });
    });
    return () => {
      alive = false;
    };
  }, [refresh]);
  return html`<div class="knowledge-library">
    <header class="kn-header">
      <div>
        <h1>Maintenance</h1>
        <p>Evidence changes, scheduled repairs, and recent batches.</p>
      </div>
      <button
        class="kn-button"
        disabled=${state.loading}
        onClick=${() => setRefresh((value) => value + 1)}
      >
        Refresh
      </button>
    </header>
    ${state.loading
      ? html`<p role="status">Loading maintenance…</p>`
      : html` ${state.status.status === "fulfilled"
            ? html`<${KnowledgeStatus} status=${state.status.value} />`
            : html`<p role="alert">Work queue could not be loaded. Refresh to try again.</p>`}
          <section class="kn-runs">
            <h2>Recent maintenance batches</h2>
            <p class="kn-caption">
              Latest 30 batches. A batch may be waiting before an agent run is assigned.
            </p>
            ${state.batches.status !== "fulfilled"
              ? html`<p role="alert">Recent batches could not be loaded. Refresh to try again.</p>`
              : !state.batches.value.items.length
                ? html`<p>No maintenance batches recorded yet.</p>`
                : html`<div class="kn-run-list">
                    ${state.batches.value.items.map(
                      (item) =>
                        html`<button
                          key=${item.id}
                          aria-pressed=${batch === item.id}
                          class=${batch === item.id ? "is-active" : ""}
                          onClick=${() =>
                            navigate(
                              `/portal/debug/cognition/maintenance/${encodeURIComponent(item.id)}`,
                            )}
                        >
                          <span>${readable(item.tier)} maintenance</span
                          ><small
                            >${readable(item.status)} ·
                            ${new Date(item.createdAt).toLocaleString()}</small
                          >
                        </button>`,
                    )}
                  </div>`}
            ${batch && html`<${BatchDetail} key=${`${batch}:${refresh}`} id=${batch} />`}
          </section>`}
  </div>`;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Canonical read-only inspector. Text stays text: generated markup is never executable HTML.
import { html } from "htm/preact";
import { useEffect, useState, useRef } from "preact/hooks";
import {
  getKnowledgeNodes,
  getKnowledgeNode,
  getKnowledgeHistory,
  getKnowledgeStatus,
  getKnowledgeBatches,
  getKnowledgeBatch,
} from "../api.js";

const path = (id) => `/portal/debug/cognition/knowledge/${encodeURIComponent(id)}`;
export function knowledgeReferenceHref(ref) {
  const match =
    /^(source|wiki|loop|annotation|brief):([^#]+)(?:#(?:claim|field|evidence):(.+))?$/.exec(ref);
  if (!match) return null;
  return match[1] === "source" ? `/portal/doc/${encodeURIComponent(match[2])}` : path(match[2]);
}
function Reference({ value }) {
  const href = knowledgeReferenceHref(value);
  return href ? html`<a href=${href}>${value}</a>` : html`<span>${value}</span>`;
}
export function KnowledgeDetail({ node, history = [] }) {
  return html`<article class="cognition-detail-body">
    <h3 class="cognition-detail-title">${node.title}</h3>
    <p>${node.kind} · edit ${node.revision} · meaning ${node.meaningRevision} · ${node.validity}</p>
    ${node.kind === "root" &&
    html`<p class="debug-sub">Compact root wiki used as untrusted agent orientation.</p>`}
    <pre class="knowledge-prose">${node.plainText}</pre>
    <details>
      <summary>Tagged source</summary>
      <pre class="knowledge-prose">${node.markdown}</pre>
    </details>
    <h4 class="cognition-section">Claims and provenance</h4>
    <p class="debug-sub">
      Verification applies to tagged claims. Untagged text is unchecked context.
    </p>
    ${!node.claims?.length && html`<p>No tagged claims.</p>`}
    ${(node.claims ?? []).map(
      (claim) =>
        html`<section class="knowledge-claim" key=${claim.id}>
          <strong>${claim.id}</strong> · meaning ${claim.meaningRevision} · ${claim.verification} ·
          support: ${claim.supportLogic}
          <p class="knowledge-prose">${claim.text}</p>
          <ul>
            ${(node.dependencies ?? [])
              .filter((dep) => dep.claimId === claim.id)
              .map(
                (dep) =>
                  html`<li key=${dep.ref}>
                    ${dep.relation}: <${Reference} value=${dep.ref} /> · input
                    ${String(dep.inputVersion)}
                  </li>`,
              )}
          </ul>
        </section>`,
    )}
    <h4 class="cognition-section">Organization links</h4>
    ${(node.links ?? []).length
      ? html`<ul>
          ${node.links.map(
            (link) =>
              html`<li>
                ${link.relation ?? link.kind}:
                <a href=${path(link.fromId === node.id ? link.toId : link.fromId)}
                  >${link.fromId === node.id ? link.toId : link.fromId}</a
                >
              </li>`,
          )}
        </ul>`
      : html`<p>No organization links.</p>`}
    <details>
      <summary>Canonical fields and review metadata</summary>
      <pre class="knowledge-prose">
${JSON.stringify({ fields: node.canonicalFields, review: node.metadata }, null, 2)}</pre
      >
    </details>
    <h4 class="cognition-section">Revision history</h4>
    ${history.map(
      (revision) =>
        html`<details key=${revision.revision}>
          <summary>
            Edit ${revision.revision} · ${new Date(revision.createdAt).toLocaleString()} ·
            ${revision.validity}
          </summary>
          <pre class="knowledge-prose">${JSON.stringify(revision.diff, null, 2)}</pre>
          <pre class="knowledge-prose">${revision.plainText}</pre>
        </details>`,
    )}
  </article>`;
}
export function KnowledgeStatus({ status }) {
  if (!status) return null;
  return html`<details>
    <summary>Maintenance status · ${status.cascades?.pending ?? 0} pending cascade steps</summary>
    <h4>Scheduled work</h4>
    ${status.work.length
      ? html`<ul>
          ${status.work.map(
            (row) =>
              html`<li>
                ${row.count} ${row.status} · ${row.tier} ·
                ${row.reason}${row.nextDueAt != null
                  ? ` · next ${new Date(row.nextDueAt).toLocaleString()}`
                  : ""}
              </li>`,
          )}
        </ul>`
      : html`<p>No scheduled work.</p>`}
    <h4>Discovery coverage</h4>
    ${status.coverage.length
      ? html`<ul>
          ${status.coverage.map(
            (row) =>
              html`<li>
                ${row.phase} · ${row.status} · ${row.count} subjects · policy ${row.policyVersion}
              </li>`,
          )}
        </ul>`
      : html`<p>No discovery coverage yet.</p>`}
  </details>`;
}
function BatchDetail({ id }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setResult(null);
    setError("");
    getKnowledgeBatch(id)
      .then((data) => {
        if (alive) setResult(data);
      })
      .catch((failure) => {
        if (alive) setError(failure.message);
      });
    return () => {
      alive = false;
    };
  }, [id]);
  if (error) return html`<p role="alert">${error}</p>`;
  if (!result) return html`<p>Loading batch…</p>`;
  return html`<section>
    <p>
      ${result.tier} · ${result.status} ·
      <a href=${`/portal/debug/cognition/runs/${encodeURIComponent(result.runId)}`}>Agent run</a>
    </p>
    <ul>
      ${result.frontier.map(
        (item) =>
          html`<li key=${item.nodeId}>
            <a
              href=${item.nodeId.startsWith("source:")
                ? knowledgeReferenceHref(item.nodeId)
                : path(item.nodeId)}
              >${item.nodeId}</a
            >
            · depth ${item.depth} · ${item.status} · attempts ${item.attempts}
          </li>`,
      )}
    </ul>
  </section>`;
}
export function KnowledgeTab({ selectedId }) {
  const generation = useRef(0);
  const [kind, setKind] = useState("");
  const [page, setPage] = useState({ items: [], more: false });
  const [status, setStatus] = useState(null);
  const [batches, setBatches] = useState([]);
  const [batch, setBatch] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    generation.current++;
    setLoading(true);
    setError("");
    setPage({ items: [], more: false });
    Promise.all([
      getKnowledgeNodes({ kind: kind || undefined, limit: 30 }),
      getKnowledgeStatus(),
      getKnowledgeBatches(),
    ])
      .then(([nodes, state, runs]) => {
        if (alive) {
          setPage({ items: nodes.items, more: nodes.items.length === 30 });
          setStatus(state);
          setBatches(runs.items);
        }
      })
      .catch((failure) => {
        if (alive) setError(failure.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      generation.current++;
    };
  }, [kind, refresh]);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    if (selectedId)
      Promise.all([getKnowledgeNode(selectedId), getKnowledgeHistory(selectedId)])
        .then(([node, history]) => {
          if (alive) setDetail({ node, history: history.items });
        })
        .catch((failure) => {
          if (alive) setError(failure.message);
        });
    return () => {
      alive = false;
    };
  }, [selectedId, refresh]);
  async function more() {
    const current = generation.current;
    setLoading(true);
    try {
      const data = await getKnowledgeNodes({
        kind: kind || undefined,
        limit: 30,
        afterId: page.items.at(-1)?.id,
      });
      if (current === generation.current)
        setPage({ items: [...page.items, ...data.items], more: data.items.length === 30 });
    } catch (failure) {
      if (current === generation.current) setError(failure.message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  return html`<div class="knowledge-inspector">
    <div class="cognition-filters">
      <label
        >Kind
        <select value=${kind} onChange=${(event) => setKind(event.target.value)}>
          ${[
            ["", "All synthesis"],
            ["root", "Root wiki"],
            ["wiki", "Wikis"],
            ["loop", "Loops"],
            ["doc_annotation", "Document annotations"],
            ["person_annotation", "Person annotations"],
            ["brief", "Briefs"],
          ].map(([value, label]) => html`<option value=${value}>${label}</option>`)}
        </select></label
      ><button disabled=${loading} onClick=${() => setRefresh(refresh + 1)}>Refresh</button>
    </div>
    ${error && html`<p role="alert">${error}</p>`}
    <${KnowledgeStatus} status=${status} />
    <details>
      <summary>Recent maintenance batches (${batches.length})</summary>
      <ul>
        ${batches.map(
          (item) =>
            html`<li key=${item.id}>
              <button onClick=${() => setBatch(item.id)}>
                ${item.tier} · ${item.status} · ${new Date(item.createdAt).toLocaleString()}
              </button>
            </li>`,
        )}
      </ul>
      ${batch && html`<${BatchDetail} key=${batch} id=${batch} />`}
    </details>
    <div class="cognition-master-detail">
      <div class="cognition-list">
        ${page.items.map(
          (node) =>
            html`<a
              class="cognition-row"
              href=${path(node.id)}
              aria-current=${selectedId === node.id ? "page" : undefined}
              key=${node.id}
              ><strong>${node.title}</strong>
              <div>${node.kind} · ${node.validity} · edit ${node.revision}</div></a
            >`,
        )}${loading && html`<p>Loading…</p>`}${!loading &&
        !page.items.length &&
        html`<p>No synthesis nodes in this selection.</p>`}${page.more &&
        html`<button disabled=${loading} onClick=${more}>Load more</button>`}
      </div>
      <div class="cognition-detail">
        ${detail
          ? html`<${KnowledgeDetail} ...${detail} />`
          : html`<p>
              ${selectedId
                ? "Loading synthesis…"
                : "Select a page, loop, annotation, or brief to inspect its claims."}
            </p>`}
      </div>
    </div>
  </div>`;
}

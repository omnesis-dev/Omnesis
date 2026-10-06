// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useState, useRef } from "preact/hooks";
import {
  getKnowledgeNodes,
  getKnowledgeNode,
  getKnowledgeHistory,
  getKnowledgeStatus,
  getDocumentSummariesBulk,
} from "../api.js";
import {
  KnowledgeDetail,
  KnowledgeStatus,
  KnowledgeBadge,
  knowledgePath,
  knowledgeKinds,
  kindLabel,
  dateLabel,
} from "./knowledge-reader.js";
export { KnowledgeDetail, KnowledgeStatus, knowledgeReferenceHref } from "./knowledge-reader.js";

const preview = (text) =>
  String(text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*`_]/g, "")
    .trim();
function PageCard({ node, selectedId }) {
  return html`<a
    class=${`kn-card ${selectedId === node.id ? "is-selected" : ""}`}
    href=${knowledgePath(node.id)}
    aria-current=${selectedId === node.id ? "page" : undefined}
    ><div class="kn-card-meta">
      <span>${kindLabel(node.kind)}</span>${node.validity === "stale" &&
      html`<span class="kn-needs-review">Needs review</span>`}
    </div>
    <h3>${node.title}</h3>
    <p>${preview(node.plainText).slice(0, 140) || "A page waiting to take shape."}</p>
    <span class="kn-card-date"
      >Updated ${dateLabel(node.updatedAt)} <span aria-hidden="true">↗</span></span
    ></a
  >`;
}
export function KnowledgeTab({ selectedId }) {
  const generation = useRef(0);
  const [kind, setKind] = useState(""),
    [query, setQuery] = useState(""),
    [validity, setValidity] = useState("");
  const [page, setPage] = useState({ items: [], more: false }),
    [root, setRoot] = useState(null);
  const [status, setStatus] = useState(null);
  const [detail, setDetail] = useState(null),
    [detailError, setDetailError] = useState(""),
    [names, setNames] = useState({});
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [activeTab, setActiveTab] = useState("overview");
  const [maintenanceError, setMaintenanceError] = useState(false);
  const [rootState, setRootState] = useState("loading");
  useEffect(() => setActiveTab(new URLSearchParams(window.location.search).has("field") ? "advanced" : "overview"), [selectedId]);
  useEffect(() => {
    let alive = true;
    generation.current++;
    setLoading(true);
    setError("");
    setPage({ items: [], more: false });
    getKnowledgeNodes({ kind: kind || undefined, limit: 30 })
      .then((nodes) => {
        if (alive) setPage({ items: nodes.items, more: nodes.items.length === 30 });
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
    setMaintenanceError(false);
    setRootState("loading");
    Promise.allSettled([getKnowledgeNodes({ kind: "root", limit: 1 }), getKnowledgeStatus()]).then(
      ([overview, state]) => {
        if (!alive) return;
        setRootState(overview.status === "fulfilled" ? "ready" : "error");
        setRoot(overview.status === "fulfilled" ? (overview.value.items[0] ?? null) : null);
        setStatus(state.status === "fulfilled" ? state.value : null);
        setMaintenanceError(state.status !== "fulfilled");
      },
    );
    return () => {
      alive = false;
    };
  }, [refresh]);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailError("");
    setNames({});
    if (selectedId)
      getKnowledgeNode(selectedId)
        .then(async (node) => {
          if (!alive) return;
          setDetail({ node, history: [], historyLoading: true });
          getKnowledgeHistory(selectedId)
            .then((history) => {
              if (alive)
                setDetail((value) => ({ ...value, history: history.items, historyLoading: false }));
            })
            .catch(() => {
              if (alive)
                setDetail((value) => ({ ...value, historyLoading: false, historyError: true }));
            });
          const refs = [...new Set((node.dependencies ?? []).map((dep) => dep.ref))];
          const sources = refs
            .filter((ref) => ref.startsWith("source:"))
            .map((ref) => ref.slice(7).split("#")[0]);
          const ids = [
            ...new Set([
              ...refs
                .filter((ref) => !ref.startsWith("source:"))
                .map((ref) => ref.split(":").slice(1).join(":").split("#")[0]),
              ...(node.links ?? []).map((link) =>
                link.fromId === node.id ? link.toId : link.fromId,
              ),
            ]),
          ].slice(0, 24);
          const [documents, related] = await Promise.all([
            getDocumentSummariesBulk([...new Set(sources)].slice(0, 100)).catch(() => ({
              docs: {},
            })),
            Promise.allSettled(ids.map((id) => getKnowledgeNode(id))),
          ]);
          if (!alive) return;
          const next = {};
          for (const [id, doc] of Object.entries(documents.docs ?? {}))
            for (const ref of refs)
              if (ref.split("#")[0] === `source:${id}`) next[ref] = doc.title || "Source document";
          related.forEach((result) => {
            if (result.status !== "fulfilled") return;
            const item = result.value;
            next[`node:${item.id}`] = item.title;
            for (const ref of refs)
              if (ref.split("#")[0].split(":").slice(1).join(":") === item.id)
                next[ref] = item.title;
          });
          setNames(next);
        })
        .catch((failure) => {
          if (alive) setDetailError(failure.message);
        });
    return () => {
      alive = false;
    };
  }, [selectedId, refresh]);
  async function more() {
    const current = generation.current;
    setError("");
    setLoading(true);
    try {
      const data = await getKnowledgeNodes({
        kind: kind || undefined,
        limit: 30,
        afterId: page.items.at(-1)?.id,
      });
      if (current === generation.current)
        setPage((value) => ({
          items: [...value.items, ...data.items],
          more: data.items.length === 30,
        }));
    } catch (failure) {
      if (current === generation.current) setError(failure.message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  const filtered = page.items.filter(
    (node) =>
      (!validity || node.validity === validity) &&
      (!query ||
        `${node.title} ${node.plainText ?? ""}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  const libraryNames = {
    ...Object.fromEntries(page.items.map((node) => [`node:${node.id}`, node.title])),
    ...names,
  };
  return html`<div class=${`knowledge-library ${selectedId ? "has-selection" : ""}`}>
    <header class="kn-header">
      <div>
        <p class="kn-eyebrow">BRAIN / KNOWLEDGE</p>
        <h1>Your knowledge</h1>
        <p>What matters, what connects, and what is changing.</p>
      </div>
      <button
        class="kn-button kn-refresh"
        disabled=${loading}
        onClick=${() => setRefresh((value) => value + 1)}
      >
        ↻ Refresh
      </button>
    </header>
    <${KnowledgeStatus} status=${status} compact=${true} />${maintenanceError &&
    html`<p class="kn-caption" role="status">
      Maintenance status is unavailable. Refresh to try again.
    </p>`}
    <div class="kn-workspace">
      <aside class="kn-library" aria-label="Knowledge library">
        <div class="kn-library-tools">
          <label class="kn-search"
            ><span aria-hidden="true">⌕</span
            ><input
              type="search"
              aria-label="Search knowledge"
              placeholder="Find a page or idea…"
              value=${query}
              onInput=${(event) => setQuery(event.target.value)}
          /></label>
          <div class="kn-filters">
            <select
              aria-label="Knowledge type"
              value=${kind}
              onChange=${(event) => setKind(event.target.value)}
            >
              ${knowledgeKinds.map(
                ([value, label]) => html`<option value=${value}>${label}</option>`,
              )}</select
            ><select
              aria-label="Page status"
              value=${validity}
              onChange=${(event) => setValidity(event.target.value)}
            >
              <option value="">Any status</option>
              <option value="current">Inputs current</option>
              <option value="stale">Needs review</option>
            </select>
          </div>
          <p class="kn-caption">
            ${filtered.length} of ${page.items.length} loaded
            pages${query ? " · searching loaded pages" : ""}
          </p>
        </div>
        ${error &&
        html`<div class="kn-error" role="alert">
          <strong>Knowledge could not be loaded</strong>
          <p>${error}</p>
          <button class="kn-button" onClick=${() => setRefresh((value) => value + 1)}>Retry</button>
        </div>`}
        <nav class="kn-card-list" aria-label="Knowledge pages">
          ${filtered.map(
            (node) => html`<${PageCard} key=${node.id} node=${node} selectedId=${selectedId} />`,
          )}${loading &&
          html`<div class="kn-loading" role="status">
            <span></span><span></span>
            <p>Loading your knowledge…</p>
          </div>`}${!loading &&
          !error &&
          !filtered.length &&
          html`<div class="kn-empty kn-empty-small">
            <h3>
              ${query || validity || kind ? "No matching pages" : "Your knowledge starts here"}
            </h3>
            <p>
              ${query || validity || kind
                ? "Try another search or filter. You can load more pages below."
                : "As the Brain learns from your sources, its pages and notes will appear here."}
            </p>
            ${(query || validity || kind) &&
            html`<button
              class="kn-button"
              onClick=${() => {
                setQuery("");
                setKind("");
                setValidity("");
              }}
            >
              Clear filters
            </button>`}
          </div>`}
        </nav>
        ${page.more &&
        html`<button class="kn-button kn-load-more" disabled=${loading} onClick=${more}>
          Load more pages
        </button>`}
      </aside>
      <main class="kn-reading-pane">
        ${selectedId
          ? html`<a class="kn-back" href="/portal/debug/cognition/knowledge">← Back to library</a
              >${detailError
                ? html`<div class="kn-empty kn-error" role="alert">
                    <h2>This page could not be opened</h2>
                    <p>It may have been removed or access may have changed.</p>
                    <p class="kn-caption">${detailError}</p>
                    <button class="kn-button" onClick=${() => setRefresh((value) => value + 1)}>
                      Retry
                    </button>
                  </div>`
                : detail
                  ? html`<${KnowledgeDetail}
                        ...${detail}
                        names=${libraryNames}
                        activeTab=${activeTab}
                        onTab=${setActiveTab}
                      />${activeTab === "history" &&
                      detail.historyLoading &&
                      html`<p class="kn-history-status" role="status">
                        Loading revision history…
                      </p>`}${activeTab === "history" &&
                      detail.historyError &&
                      html`<p class="kn-history-status" role="alert">
                        Revision history could not be loaded.
                        <button class="kn-button" onClick=${() => setRefresh((value) => value + 1)}>
                          Retry
                        </button>
                      </p>`}`
                  : html`<div class="kn-empty" role="status">
                      <span class="kn-orbit" aria-hidden="true">◌</span>
                      <h2>Opening your page…</h2>
                    </div>`}`
          : html` <section class="kn-home">
              <div class="kn-home-intro">
                <h2>Your overview</h2>
                <p>
                  Read the big picture, explore a project, or follow an idea back to the evidence
                  that supports it.
                </p>
              </div>
              ${rootState === "loading"
                ? html`<div class="kn-root-placeholder" role="status">
                    Loading your life overview…
                  </div>`
                : rootState === "error"
                  ? html`<div class="kn-root-placeholder" role="alert">
                      <h3>Your life overview is unavailable</h3>
                      <p>Refresh to try again.</p>
                    </div>`
                  : root
                    ? html`<a class="kn-root-card" href=${knowledgePath(root.id)}
                        ><div class="kn-eyebrow">
                          YOUR LIFE AT A GLANCE <span aria-hidden="true">↗</span>
                        </div>
                        <h3>${root.title}</h3>
                        <p>
                          ${preview(root.plainText).slice(0, 380) ||
                          "Your compact life overview is taking shape."}
                        </p>
                        <div>
                          <${KnowledgeBadge} value=${root.validity} /><span class="kn-caption"
                            >Open life overview</span
                          >
                        </div></a
                      >`
                    : html`<div class="kn-root-placeholder">
                        <h3>Your life at a glance</h3>
                        <p>
                          A compact overview will appear here once the Brain has enough
                          context.${" "}
                          ${page.items.length
                            ? "Explore the pages in your library while it takes shape."
                            : "Pages will appear as your sources are considered."}
                        </p>
                      </div>`}
              ${page.items.filter((node) => node.kind !== "root").length > 0 &&
              html`<section class="kn-home-recent">
                <h3>Explore your library</h3>
                <div>
                  ${[...page.items]
                    .filter((node) => node.kind !== "root")
                    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                    .slice(0, 3)
                    .map((node) => html`<${PageCard} node=${node} />`)}
                </div>
              </section>`}
            </section>`}
      </main>
    </div>
  </div>`;
}

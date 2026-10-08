// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { getKnowledgeConnections } from "../api.js";

const kinds = {
  root: "Life overview",
  wiki: "Wiki page",
  loop: "Loop",
  doc_annotation: "Document note",
  person_annotation: "Person note",
  brief: "Brief",
  source: "Source document",
};
export function connectionHref(node) {
  return node.id.startsWith("source:")
    ? `/portal/doc/${encodeURIComponent(node.id.slice(7))}`
    : `/portal/debug/cognition/knowledge/${encodeURIComponent(node.id)}`;
}
export function connectionLabel(edge) {
  const incoming = edge.direction === "incoming";
  const labels = {
    supports: ["Supports this page", "Uses this page as support"],
    contradicts: ["Contradicts a claim here", "Uses this page as counterevidence"],
    context: ["Provides context here", "Uses this page as context"],
    depends_on: ["This page depends on it", "Depends on this page"],
    related_to: ["Related to this page", "Related to this page"],
    belongs_to_project: ["Project containing this page", "Belongs to this project"],
    part_of: ["Parent of this page", "Part of this page"],
    supersedes: ["Replaced by this page", "Replaces this page"],
    duplicate_of: ["This page duplicates it", "Duplicates this page"],
  };
  return (
    labels[edge.relationship]?.[incoming ? 1 : 0] ?? String(edge.relationship).replaceAll("_", " ")
  );
}
export function groupConnectionEdges(edges) {
  const groups = new Map();
  for (const edge of edges) {
    const key = JSON.stringify([edge.direction, edge.node.id, edge.relationship, edge.dependency]);
    const group = groups.get(key);
    if (group) group.edges.push(edge);
    else groups.set(key, { ...edge, key, edges: [edge] });
  }
  return [...groups.values()];
}
export function ConnectionCard({ edge }) {
  const edges = edge.edges ?? [edge];
  const refs = edges.filter((item) => item.claimId || item.targetClaimId || item.ref);
  const category =
    edge.relationship === "context" && edge.ref
      ? "Context reference"
      : edge.dependency
        ? "Claim dependency"
        : "Organization link";
  return html`<li class="kn-connection-card">
    <p class="kn-connection-relation">${connectionLabel(edge)}</p>
    <a href=${connectionHref(edge.node)}>${edge.node.title || "Untitled record"}</a>
    <p class="kn-caption">${`${kinds[edge.node.kind] ?? "Knowledge record"} · ${category}`}</p>
    ${refs.length > 0 &&
    html`<details>
      <summary>${refs.length} claim reference${refs.length === 1 ? "" : "s"}</summary>
      ${refs.map(
        (item) =>
          html`<dl class="kn-facts" key=${item.id ?? item.ref}>
            ${item.claimId &&
            html`<dt>Claim using the reference</dt>
              <dd>${item.claimId}</dd>`}
            ${item.targetClaimId &&
            html`<dt>Referenced claim</dt>
              <dd>${item.targetClaimId}</dd>`}
            ${item.ref &&
            html`<dt>Reference</dt>
              <dd>${item.ref}</dd>`}
          </dl>`,
      )}
    </details>`}
  </li>`;
}
export function KnowledgeConnections({ node }) {
  const generation = useRef(0);
  const [state, setState] = useState({ items: [], nextCursor: null, loading: true, error: null });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const current = ++generation.current;
    setState({ items: [], nextCursor: null, loading: true, error: null });
    getKnowledgeConnections(node.id)
      .then((result) => {
        if (generation.current === current) setState({ ...result, loading: false, error: null });
      })
      .catch((error) => {
        if (generation.current === current)
          setState({ items: [], nextCursor: null, loading: false, error: error.message });
      });
    return () => {
      generation.current++;
    };
  }, [node.id, node.revision, refresh]);
  async function loadMore() {
    const current = generation.current;
    setState((value) => ({ ...value, loading: true, error: null }));
    try {
      const result = await getKnowledgeConnections(node.id, { cursor: state.nextCursor });
      if (generation.current === current)
        setState((value) => ({
          ...result,
          items: [...value.items, ...result.items],
          loading: false,
          error: null,
        }));
    } catch (error) {
      if (generation.current === current)
        setState((value) => ({ ...value, loading: false, error: error.message }));
    }
  }
  const incoming = state.items.filter((edge) => edge.direction === "incoming");
  const outgoing = state.items.filter((edge) => edge.direction === "outgoing");
  return html`<section class="kn-connections">
    <div class="kn-section-intro">
      <h3>How this page connects</h3>
      <p>
        Claim dependencies explain what informs a page. Organization links connect projects, tasks,
        and related pages without making them evidence.
      </p>
      <p>
        References run from a claim to its source. Context references add background; they do not
        establish proof or trigger synthesis maintenance.
      </p>
    </div>
    <div class="kn-connection-focus">
      <span>${kinds[node.kind] ?? "Knowledge record"}</span><strong>${node.title}</strong>
    </div>
    ${state.error &&
    html`<p role="alert">
      Connections could not be loaded. ${state.error}
      <button
        class="kn-button"
        onClick=${() =>
          state.items.length && state.nextCursor ? loadMore() : setRefresh((value) => value + 1)}
      >
        Retry
      </button>
    </p>`}
    ${state.items.length > 0 &&
    html`<div class="kn-connection-columns">
      ${[
        ["References from this page", outgoing],
        ["References to this page", incoming],
      ].map(
        ([title, edges]) =>
          html`<section>
            <h4>${title}<span class="kn-caption">${edges.length} edges loaded</span></h4>
            <ul>
              ${groupConnectionEdges(edges).map(
                (edge) =>
                  html`<${ConnectionCard}
                    key=${edge.id ?? edge.key ?? JSON.stringify(edge)}
                    edge=${edge}
                  />`,
              )}
            </ul>
            ${!edges.length &&
            html`<p class="kn-caption">No connections in the loaded results.</p>`}
          </section>`,
      )}
    </div>`}
    ${state.loading && html`<p role="status">Loading connections…</p>`}
    ${!state.loading &&
    !state.error &&
    !state.items.length &&
    !state.nextCursor &&
    html`<div class="kn-empty">
      <h4>No connections recorded</h4>
      <p>This page has no visible claim references or organization links yet.</p>
    </div>`}
    ${state.nextCursor &&
    html`<button class="kn-button" disabled=${state.loading} onClick=${loadMore}>
      Load more connections
    </button>`}
    ${state.items.length > 0 &&
    html`<p class="kn-caption">
      ${state.items.length} connections
      loaded${state.nextCursor ? " · More available" : " · All visible connections loaded"}. Private
      or unavailable records are omitted.
    </p>`}
  </section>`;
}

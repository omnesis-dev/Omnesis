// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { getKnowledgeConnections, getDocumentSummariesBulk } from "../api.js";
import { KnowledgeIcon } from "../lib/knowledge-link-icons.js";

export function connectionHref(node) {
  return node.id.startsWith("source:")
    ? `/portal/doc/${encodeURIComponent(node.id.slice(7))}`
    : `/portal/debug/cognition/knowledge/${encodeURIComponent(node.id)}`;
}
export function groupConnectionEdges(edges) {
  const groups = new Map();
  for (const edge of edges) {
    const key = JSON.stringify([edge.direction, edge.node.id]);
    const group = groups.get(key);
    if (group) group.edges.push(edge);
    else groups.set(key, { ...edge, key, edges: [edge] });
  }
  return [...groups.values()];
}
async function loadConnections(id, options) {
  const result = await getKnowledgeConnections(id, options);
  const ids = [
    ...new Set(
      result.items
        .filter((edge) => edge.node.kind === "source")
        .map((edge) => edge.node.id.slice(7)),
    ),
  ];
  const { docs } = await getDocumentSummariesBulk(ids).catch(() => ({ docs: {} }));
  return {
    ...result,
    items: result.items.map((edge) =>
      edge.node.kind === "source"
        ? { ...edge, node: { ...edge.node, sourceId: docs[edge.node.id.slice(7)]?.source_id } }
        : edge,
    ),
  };
}
export function ConnectionReference({ edge, references = {} }) {
  return html`<li class="kn-connection-reference">
    <a href=${connectionHref(edge.node)}
      ><${KnowledgeIcon} ...${references[edge.node.id] ?? {}} ...${edge.node} />${edge.node.title ||
      "Untitled record"}</a
    >
  </li>`;
}
export function KnowledgeConnections({ node, references = {} }) {
  const generation = useRef(0);
  const [state, setState] = useState({ items: [], nextCursor: null, loading: true, error: null });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const current = ++generation.current;
    setState({ items: [], nextCursor: null, loading: true, error: null });
    loadConnections(node.id)
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
      const result = await loadConnections(node.id, { cursor: state.nextCursor });
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
  const visible = state.items;
  const incoming = visible.filter((edge) => edge.direction === "incoming");
  const outgoing = visible.filter((edge) => edge.direction === "outgoing");
  return html`<section class="kn-connections">
    <div class="kn-section-intro">
      <h3>Connections</h3>
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
    ${visible.length > 0 &&
    html`<div class="kn-connection-columns">
      ${[
        ["References from this page", outgoing],
        ["References to this page", incoming],
      ].map(
        ([title, edges]) =>
          html`<section>
            <h4>${title}</h4>
            <ul>
              ${groupConnectionEdges(edges).map(
                (edge) =>
                  html`<${ConnectionReference}
                    key=${edge.id ?? edge.key ?? JSON.stringify(edge)}
                    edge=${edge}
                    references=${references}
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
    !visible.length &&
    !state.nextCursor &&
    html`<div class="kn-empty">
      <h4>No connections recorded</h4>
      <p>This page has no visible references yet.</p>
    </div>`}
    ${!state.loading &&
    !visible.length &&
    state.nextCursor &&
    html`<p class="kn-caption">
      No references in the loaded results. Load more connections to continue.
    </p>`}
    ${state.nextCursor &&
    html`<button class="kn-button" disabled=${state.loading} onClick=${loadMore}>
      Load more connections
    </button>`}
  </section>`;
}

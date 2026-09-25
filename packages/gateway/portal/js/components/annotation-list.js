// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { timeAgo } from "../lib/format.js";
import { getAnnotationDependents } from "../api.js";
import { LoadMore } from "./load-more.js";
import { useCursorPage } from "../lib/use-cursor-page.js";

// Small accent-tinted sparkle marking an Omnesis-derived (agent) section,
// distinct from source-provided data. Tinted via currentColor.
export const OmnesisSparkle = html`
  <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
    <path d="M8 0l1.6 4.9L14.5 6.5 9.6 8.1 8 13 6.4 8.1 1.5 6.5 6.4 4.9z" />
  </svg>
`;

// Consumption provenance for one annotation: the briefs/loops the agent
// built on this prior (served inline on the annotations payload). Rendered
// as a native <details> disclosure — stateless, so the list stays a pure
// component — with each dependent linking into the cognition debug view.
function DependentsDisclosure({ label, dependents, children }) {
  return html`
    <details class="meta-annotation-dependents">
      <summary title="Briefs/loops the agent built while this prior was in front of it — if this prior dies, they are re-examined">
        ${label}
      </summary>
      ${dependents.map((d) => html`
        <a
          key=${`${d.kind}:${d.id}`}
          class="meta-annotation-dependent"
          href=${`/portal/debug/cognition/${d.kind === "brief" ? "briefs" : "loops"}/${encodeURIComponent(d.id)}`}
          style="display:block;"
        >
          ${d.kind}: ${d.title || d.id}
        </a>
      `)}
      ${children}
    </details>
  `;
}

function EmbeddedAnnotationDependents({ dependents }) {
  const label = `${dependents.length} dependent ${dependents.length === 1 ? "output" : "outputs"}`;
  return html`<${DependentsDisclosure} label=${label} dependents=${dependents} />`;
}

function AnnotationDependents({ annotation, store }) {
  const [open, setOpen] = useState(false);
  const page = useCursorPage({
    enabled: open,
    resetKey: `${store}:${annotation.id}`,
    pageSize: 25,
    loadPage: ({ limit, cursor }) =>
      getAnnotationDependents(store, annotation.id, { limit, cursor }),
    selectItems: (payload) => payload.items ?? payload.dependents ?? [],
    itemKey: (dependent) => `${dependent.kind}:${dependent.id}`,
  });
  const dependents = page.items;
  const count = annotation.dependentCount;
  const label = `${count} dependent ${count === 1 ? "output" : "outputs"}`;
  return html`
    <details
      class="meta-annotation-dependents"
      onToggle=${(event) => setOpen(event.currentTarget.open)}
    >
      <summary title="Briefs/loops the agent built while this prior was in front of it — if this prior dies, they are re-examined">
        ${label}
      </summary>
      ${page.loading && html`<div class="debug-loading">Loading…</div>`}
      ${page.error && html`<div class="debug-error">${page.error.message}</div>`}
      ${open && !page.loading && dependents.length === 0 &&
      html`<div class="debug-empty">No dependent outputs.</div>`}
      ${dependents.map((d) => html`
        <a
          key=${`${d.kind}:${d.id}`}
          class="meta-annotation-dependent"
          href=${`/portal/debug/cognition/${d.kind === "brief" ? "briefs" : "loops"}/${encodeURIComponent(d.id)}`}
          style="display:block;"
        >
          ${d.kind}: ${d.title || d.id}
        </a>
      `)}
      <${LoadMore}
        hasMore=${page.hasMore}
        loading=${page.loadingMore}
        error=${page.loadMoreError}
        onLoadMore=${page.loadMore}
        label="Load more outputs"
      />
    </details>
  `;
}

/**
 * The agent's durable LLM-derived observations, rendered as a list. Person
 * annotations (about a person) and document annotations (grounded on a
 * document) share the same wire shape — `claimType`, `claimText`,
 * `confidence`, `evidenceQuote` — so one component serves both. Confidence is
 * surfaced verbatim: these are defeasible observations, not hard facts. The
 * head line also carries the claim basis (how far the claim reasons from its
 * evidence) and, when the entailment verifier stamped the row, its
 * verification state with the recency of the last check. Rows carrying
 * consumption provenance (`dependents`) get a disclosure listing the
 * briefs/loops built on them.
 */
export function AnnotationList({ annotations = [], store }) {
  return html`${(annotations ?? []).map((a) => html`
    <div class="meta-annotation" key=${a.id}>
      <div class="meta-annotation-head">
        <span class="meta-enriched-value">${a.claimType}</span>
        ${a.claimBasis && html`
          <span class="meta-annotation-basis" title="Claim basis — quoted: the evidence states it; inferred: one deduction from the source; synthesized: assembled across sources">${a.claimBasis}</span>
        `}
        ${a.verificationState && html`
          <span class="meta-annotation-verify" title="Entailment check — whether the evidence quote was last judged to establish the claim">
            ${a.verificationState}${a.lastVerifiedAt ? ` · ${timeAgo(a.lastVerifiedAt)}` : ""}
          </span>
        `}
        <span class="meta-annotation-confidence" title="Agent confidence — a derived observation, not a hard fact">
          ${Math.round(a.confidence * 100)}%
        </span>
      </div>
      <div class="meta-annotation-claim">${a.claimText}</div>
      ${a.evidenceQuote && html`
        <div class="meta-enriched-phrase meta-annotation-quote" title=${a.evidenceQuote}>“${a.evidenceQuote}”</div>
      `}
      ${Array.isArray(a.dependents) && a.dependents.length > 0
        ? html`<${EmbeddedAnnotationDependents} dependents=${a.dependents} />`
        : store && a.dependentCount > 0
          ? html`<${AnnotationDependents} annotation=${a} store=${store} />`
          : null}
    </div>
  `)}`;
}

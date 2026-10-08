// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getKnowledgeNodeDecisions } from "../api.js";
import { KnowledgeDecisionCard } from "./cognition-knowledge-decisions.js";


/** Metadata is loaded only while this native contextual disclosure is open. */
export function DecisionContextDetails({ contextKey, decisions = [], audit, load, note }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({});
  useEffect(() => {
    if (!open || !load) return undefined;
    let alive = true;
    setState({ loading: true });
    load().then((data) => { if (alive) setState({ data }); }, () => { if (alive) setState({ error: true }); });
    return () => { alive = false; };
  }, [open, contextKey]);
  const data = load ? state.data : { items: decisions, ...audit };
  return html`<details class="cognition-decision-details km-input-decisions" onToggle=${(event) => setOpen(event.currentTarget.open)}>
    <summary>Decision details</summary>
    ${open && (load && state.loading ? html`<p role="status">Loading checks…</p>`
      : load && state.error ? html`<p role="alert">Checks could not be loaded. Close and reopen to retry.</p>`
        : html`${note && html`<p class="cognition-dim">${note}</p>`}${!(data?.items?.length) && html`<p class="cognition-dim">No recorded judgement for this context.</p>`}${(data?.items ?? []).map((decision) => html`<${KnowledgeDecisionCard} key=${decision.id} decision=${decision} showSubject=${false} />`)}${data?.truncated && html`<p class="cognition-dim">Additional recorded checks are not shown.</p>`}`)}
  </details>`;
}
export function NodeReviewDetails({ node }) {
  return html`<${DecisionContextDetails} key=${`${node.id}:${node.revision}:${node.metadata?.nextReviewAt}`} contextKey=${`${node.id}:${node.revision}:${node.metadata?.nextReviewAt}`} note="These are historical judgements for this page. Later scheduling changes may determine its current next review date." load=${() => getKnowledgeNodeDecisions(node.id)} />`;
}

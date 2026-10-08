// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { DecisionSubject } from "./knowledge-decision-subject.js";
import { getCognitionDecisionInput, getKnowledgeDecision } from "../api.js";

const PURPOSES = {
  discovery: "Discovery admission",
  impact: "Change impact",
  urgency: "Scheduling urgency",
  review: "Review timing",
};
const RECOMMENDATIONS = { inspect: "Inspect", skip: "Skip", unavailable: "Unavailable" };
const normalizedScore = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value.toFixed(2) : "Unavailable";
const recordedNumber = (value, suffix = "") =>
  typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString()}${suffix}` : "Not recorded";
const decidedAt = (value) => {
  const date = new Date(value);
  return value != null && Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not recorded";
};

export function DecisionInputContent({ input, normalized = true }) {
  if (!input || input.availability !== "available") return html`<p class="cognition-dim">${input?.availability === "oversized"
    ? "The recorded request or result exceeds the inspection limit."
    : "The exact request and result are unavailable; they have not been reconstructed."}</p>`;
  return html`<p class="cognition-dim">Captured model input and answer. ${normalized ? "Answer scores retain the original model scale; the summary above uses 0–1." : "Scores retain the original model scale."}</p>
    ${Object.entries(input.response?.answers ?? {}).map(([key, answer]) => html`<section class="cognition-decision-answer">
      ${typeof answer?.score === "number" && html`<p>Model score: ${answer.score}</p>`}
      ${typeof answer?.explanation === "string" && html`<p>${answer.explanation}</p>`}
      <details class="cognition-decision-details"><summary>Question and criteria</summary>
        <p>${typeof input.request?.questions?.[key]?.instructions === "string" ? input.request.questions[key].instructions : key}</p>
        ${Array.isArray(input.request?.questions?.[key]?.criteria) && html`<ol start="0">${input.request.questions[key].criteria.map((criterion) => html`<li>${typeof criterion === "string" ? criterion : JSON.stringify(criterion)}</li>`)}</ol>`}
      </details>
    </section>`)}
    <h4>Request sent</h4><pre class="cognition-decision-pre">${JSON.stringify(input.request, null, 2)}</pre>
    <h4>Result received</h4><pre class="cognition-decision-pre">${JSON.stringify(input.response, null, 2)}</pre>
    ${input.error != null && html`<h4>Recorded failure</h4><pre class="cognition-decision-pre">${typeof input.error === "string" ? input.error : JSON.stringify(input.error, null, 2)}</pre>`}`;
}
export function DecisionRetainedContent({ retained }) {
  return html`<p class="cognition-dim">An exact snapshot is unavailable. This is the retained decision ledger.</p>
    ${retained.requestFidelity === "redacted" && html`<p class="cognition-dim">Source context was redacted from the recorded request.</p>`}
    ${retained.responseFidelity === "score-only" && html`<p class="cognition-dim">Only the resulting score was retained, not the complete model answer.</p>`}
    <h4>Recorded request</h4><pre class="cognition-decision-pre">${retained.request == null ? "Not retained" : JSON.stringify(retained.request, null, 2)}</pre>
    <h4>Recorded answer</h4><pre class="cognition-decision-pre">${retained.response == null ? "Not retained" : JSON.stringify(retained.response, null, 2)}</pre>`;
}
export function DecisionInputInspection({ id, legacy = false }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setState({ loading: true });
    (legacy ? getCognitionDecisionInput(id) : getKnowledgeDecision(id)).then((data) => { if (alive) setState({ data }); },
      () => { if (alive) setState({ error: true }); });
    return () => { alive = false; };
  }, [open, id, legacy]);
  return html`<details class="cognition-decision-details" onToggle=${(event) => setOpen(event.currentTarget.open)}>
    <summary>${legacy ? "Captured request and result" : "Request and result"}</summary>
    ${open && (state.loading ? html`<p role="status">Loading decision…</p>` : state.error
      ? html`<p role="alert">Decision inspection could not be loaded. Close and reopen to retry.</p>`
      : state.data?.retained ? html`<${DecisionRetainedContent} retained=${state.data.retained} />`
        : html`<${DecisionInputContent} input=${state.data?.input} normalized=${!legacy} />`)}
  </details>`;
}
export function DecisionScheduling({ scheduling }) {
  if (!scheduling) return null;
  const { applied, proposed, policy } = scheduling;
  const differs = proposed && (!applied || proposed.tier !== applied.tier || proposed.dueAt !== applied.dueAt);
  const delay = (milliseconds) => {
    if (!Number.isFinite(milliseconds)) return "Not recorded";
    const [divisor, unit] = milliseconds >= 3_600_000 && milliseconds % 3_600_000 === 0 ? [3_600_000, "h"]
      : milliseconds >= 60_000 && milliseconds % 60_000 === 0 ? [60_000, "min"]
        : milliseconds >= 1000 && milliseconds % 1000 === 0 ? [1000, "s"] : [1, "ms"];
    return `${(milliseconds / divisor).toLocaleString()} ${unit}`;
  };
  return html`<dl class="kn-facts">
    <dt>Scheduling</dt><dd>${scheduling.status === "scheduled" ? "Scheduled at this attempt" : "No schedule applied at this attempt"}</dd>
    ${policy && html`<dt>Recorded policy</dt><dd>Immediate ≥ ${normalizedScore(policy.immediateThreshold)}; Soon ≥ ${normalizedScore(policy.soonThreshold)}; otherwise Routine.</dd>
      <dt>Configured delays</dt><dd>Soon: ${delay(policy.soonDelayMs)}; Routine: ${delay(policy.routineDelayMs)}</dd>`}
    ${differs && html`<dt>Proposed schedule</dt><dd>${proposed.tier} · ${decidedAt(proposed.dueAt)}</dd>`}
    ${applied && html`<dt>Applied tier</dt><dd>${applied.tier}</dd><dt>Eligible from</dt><dd>${decidedAt(applied.dueAt)}</dd>`}
    ${differs && applied && html`<dt>Schedule adjustment</dt><dd>The applied schedule incorporates existing work obligations.</dd>`}
    ${scheduling.fallbackSoon && html`<dt>Fallback</dt><dd>Soon, without a usable urgency verdict</dd>`}
  </dl>`;
}

/** Scheduling recommendations use normalized scores, independently of legacy record/worth gates. */
export function KnowledgeDecisionCard({ decision, showSubject = true }) {
  const recommendation = RECOMMENDATIONS[decision.recommendation];
  return html`<article class="cognition-decision">
    <div class="cognition-decision-head">
      <strong>${PURPOSES[decision.purpose] ?? decision.purpose}</strong>
      <span class="cognition-decision-score">Score <strong>${normalizedScore(decision.score)}</strong> · scale 0–1</span>
      ${decision.threshold != null && html`<span class="cognition-dim">Threshold ${normalizedScore(decision.threshold)}</span>`}
    </div>
    ${recommendation && html`<p>Recommendation: <strong>${recommendation}</strong></p>`}
    ${decision.recommendation === "skip" || decision.recommendation === "inspect"
      ? html`<p class="cognition-dim">Other work requirements can override this recommendation.</p>` : null}
    <dl class="kn-facts">
      ${showSubject && decision.subjectRef && html`<dt>About</dt><dd><${DecisionSubject} subject=${decision.subjectRef} /></dd>`}
      <dt>Model</dt><dd>${decision.modelId || "Not recorded"}</dd>
      <dt>Decided</dt><dd>${decidedAt(decision.createdAt)}</dd>
    </dl>
    <${DecisionScheduling} scheduling=${decision.scheduling} />
    <details class="cognition-decision-details">
      <summary>Decision metadata</summary>
      <dl class="kn-facts">
        <dt>Association</dt><dd>${decision.association === "historical-matched"
      ? "Historical match: associated using stored inputs and timing, not linked when recorded."
      : decision.association === "recorded"
        ? decision.workId ? "Linked through scheduled work." : "Linked to this run when recorded."
        : "Run association was not recorded."}</dd>
        <dt>Rubric</dt><dd><code>${decision.rubricVersion || "Not recorded"}</code></dd>
        <dt>Latency</dt><dd>${recordedNumber(decision.latencyMs, " ms")}</dd>
        <dt>Input tokens</dt><dd>${recordedNumber(decision.inputTokens)}</dd>
        ${decision.nodeId && html`<dt>Subject</dt><dd><code>${decision.nodeId}</code></dd>`}
        ${decision.batchId && html`<dt>Batch</dt><dd><code>${decision.batchId}</code></dd>`}
        ${decision.workId && html`<dt>Work</dt><dd><code>${decision.workId}</code></dd>`}
        ${decision.runId && decision.runAvailable !== false && html`<dt>Run</dt><dd><a href=${`/portal/debug/cognition/runs/${encodeURIComponent(decision.runId)}`}>View run</a></dd>`}
        ${decision.runId && decision.runAvailable === false && html`<dt>Run</dt><dd>No longer retained</dd>`}
        ${decision.batchId && html`<dt>Maintenance</dt><dd><a href=${`/portal/debug/cognition/maintenance/${encodeURIComponent(decision.batchId)}`}>View batch</a></dd>`}
        <dt>Decision ID</dt><dd><code>${decision.id}</code></dd>
      </dl>
    </details>
    ${decision.inputInspection !== undefined && html`<${DecisionInputInspection} id=${decision.id} />`}
  </article>`;
}

/** A native disclosure keeps each judgement beside the work it explains. */
export function DecisionDisclosure({ decision }) {
  const [open, setOpen] = useState(false);
  return html`<details class="cognition-decision-details km-context-check" onToggle=${(event) => setOpen(event.currentTarget.open)}>
    <summary>${PURPOSES[decision.purpose] ?? decision.purpose} · ${normalizedScore(decision.score)}${decision.recommendation ? ` · Recommendation: ${RECOMMENDATIONS[decision.recommendation] ?? decision.recommendation}` : ""}</summary>
    ${open && html`<${KnowledgeDecisionCard} decision=${decision} />`}
  </details>`;
}
export function ContextualDecisions({ decisions = [], audit, title = "Checks" }) {
  return html`<section class="km-context-decisions" aria-label=${title}>
    <h3>${title}</h3>
    ${!decisions.length && html`<p class="cognition-dim">No recorded judgement for this context. This does not establish that a gate was bypassed.</p>`}
    ${decisions.map((decision) => html`<${DecisionDisclosure} key=${decision.id} decision=${decision} />`)}
    ${audit?.truncated && html`<p class="cognition-dim">Additional recorded checks are not shown.</p>`}
    ${audit?.legacyIncomplete && html`<p class="cognition-dim">Historical associations are incomplete.</p>`}
  </section>`;
}

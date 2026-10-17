// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one way the portal shows a judgement made by the decision model.
 *
 * Every surface that shows a decision (a run's detail, the decision audit, a
 * maintenance batch, a knowledge page's review history, pending work, an
 * observation) renders it through `DecisionCard`, so a decision reads the
 * same everywhere and is recognisable at a glance by the scale icon in its
 * header. Callers pass the decision as the gateway serves it plus a layout:
 * `full` lays the card out in place, `compact` folds it into a one-line
 * disclosure for lists.
 *
 * Two ledgers feed it. The run ledger (`cognition_decisions`: worth gate,
 * record check, task check, observation salience, date mention worth, search
 * routing) carries a verdict on the model's own ordinal scale; the knowledge
 * ledger (discovery, impact, review, urgency) carries a score normalized to
 * 0–1 and a recommendation the engine may override. `decisionView` reads
 * either into one shape; each purpose's wording is data in the tables below,
 * not a separate renderer.
 */

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getCognitionDecisionInput, getKnowledgeDecision } from "../api.js";
import { internalKnowledgeHref } from "../views/knowledge-claim-markdown.js";
import { DecisionSubject } from "../views/knowledge-decision-subject.js";

/** Lucide "scale" (https://lucide.dev/icons/scale, ISC), the decision model's mark. */
export function DecisionIcon() {
  return html`<svg class="decision-icon" role="img" aria-label="Decision model" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" /><path d="M7 21h10" /><path d="M12 3v18" /><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" /></svg>`;
}

/** Every purpose the decision model is asked for, in the order the audit filter lists them. */
export const DECISION_PURPOSES = [
  ["discovery", "Discovery admission"],
  ["impact", "Change impact"],
  ["review", "Review timing"],
  ["urgency", "Scheduling urgency"],
  ["worth-gate", "Worth admission"],
  ["record-check", "Record check"],
  ["task-check", "Task check"],
  ["observation-salience", "Observation salience"],
  ["mention-worth", "Date mention worth"],
  ["find-route", "Search routing"],
];
const PURPOSE_LABELS = Object.fromEntries(DECISION_PURPOSES);
export const decisionPurposeLabel = (purpose) => PURPOSE_LABELS[purpose] ?? purpose;

const KNOWLEDGE_PURPOSES = new Set(["discovery", "impact", "review", "urgency"]);

/**
 * What a run-ledger verdict meant for the work it judged, by purpose (and,
 * for the task check, by question). `label` is the verdict as a word,
 * `sentence` what happened because of it.
 */
const LEDGER_OUTCOMES = {
  "worth-gate": {
    pass: ["pass", "Admitted for agent review."],
    skip: ["skip", "Gate declined admission for this attempt."],
    unavailable: ["unavailable", "Admitted for agent review without a verdict."],
  },
  "record-check": {
    pass: ["allowed", "Gate allowed this record."],
    skip: ["blocked", "Gate blocked this save attempt."],
    shadowSkip: ["would reject", "Shadow check: would reject; did not block saving."],
    unavailable: ["unavailable", "Allowed without a verdict; no usable decision score was recorded."],
  },
  "task-check:same_task": {
    pass: ["same task", "The new title still names the accepted task, so the change could apply on its own."],
    skip: ["different task", "The new title may name another task, so the change waits for the user."],
    unavailable: ["unavailable", "Not judged; the change waits for the user."],
  },
  "task-check:adds_new": {
    pass: ["new", "The note adds to the task's history and was recorded."],
    skip: ["repeats", "The note only repeats the task's history, so it was left out."],
    unavailable: ["unavailable", "Not judged; the note was recorded."],
  },
  "observation-salience": {
    pass: ["ship", "Belongs in the morning brief."],
    skip: ["hold", "Held out of the morning brief."],
    unavailable: ["unavailable", "Not judged; the observation stays eligible."],
  },
  "mention-worth": {
    pass: ["keep", "The email's date mentions are kept for date queries."],
    skip: ["drop", "The email's date mentions are left out of date queries."],
    unavailable: ["unavailable", "Not judged yet; its date mentions show meanwhile."],
  },
  "find-route:agentic": { pass: ["agent research", "Routed to agent research."] },
  "find-route:direct": { pass: ["index search", "Routed to index search."] },
  "find-route:unavailable": { unavailable: ["unavailable", "Not judged; the search used the index."] },
};
const RECOMMENDATIONS = { inspect: "inspect", skip: "skip", unavailable: "unavailable" };
const TONES = { pass: "pass", inspect: "pass", skip: "skip", unavailable: "warn" };

function ledgerOutcome(d) {
  if (d.reusedFrom)
    return { label: d.verdict, tone: TONES[d.verdict] ?? "neutral", sentence: "Reused a prior judgement; no model call was made for this entry." };
  const table = LEDGER_OUTCOMES[`${d.purpose}:${d.lane}`] ?? LEDGER_OUTCOMES[d.purpose];
  const key = d.verdict === "skip" && d.enforced === false ? "shadowSkip" : d.verdict;
  const entry = table?.[key] ?? table?.[d.verdict];
  if (!entry) return { label: d.verdict, tone: "neutral", sentence: null };
  const tone = d.purpose === "find-route" && d.verdict === "pass" ? "neutral" : TONES[d.verdict] ?? "neutral";
  return { label: entry[0], tone, sentence: entry[1] };
}

const fixed = (value) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : null);
const recorded = (value, suffix = "") =>
  typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString()}${suffix}` : "Not recorded";
const timestamp = (value) => {
  const date = new Date(value);
  return value != null && Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not recorded";
};

/**
 * Read a decision from either ledger into the one shape the card renders.
 * The run ledger is recognised by its verdict; the knowledge ledger by its
 * normalized score scale.
 */
export function decisionView(d) {
  const knowledge = d.kind === "knowledge" || d.scoreScale === "normalized-0-1" || (KNOWLEDGE_PURPOSES.has(d.purpose) && d.verdict === undefined);
  const score = knowledge && d.score != null && !(d.score >= 0 && d.score <= 1) ? null : fixed(d.score);
  const threshold = fixed(d.threshold);
  let outcome;
  if (knowledge) {
    const label = d.bypass ? "engine bypass" : RECOMMENDATIONS[d.recommendation] ?? null;
    outcome = {
      label,
      tone: d.bypass ? "neutral" : TONES[d.recommendation] ?? "neutral",
      sentence: d.recommendation === "skip" || d.recommendation === "inspect" ? "Other work requirements can override this recommendation." : null,
    };
  } else outcome = ledgerOutcome(d);
  const response = d.response ?? (d.answers != null ? { answers: d.answers } : null);
  return {
    id: d.id,
    knowledge,
    purpose: d.purpose,
    title: decisionPurposeLabel(d.purpose),
    lane: d.lane ?? null,
    outcome,
    score: d.bypass ? null : score,
    threshold: d.bypass ? null : threshold,
    scale: knowledge ? "0–1" : null,
    comparison: score !== null && threshold !== null && !d.bypass ? (Number(score) >= Number(threshold) ? "≥" : "<") : null,
    choice: d.purpose === "find-route" && d.lane !== "unavailable" ? d.lane : null,
    error: d.error ?? null,
    reusedFrom: d.reusedFrom ?? null,
    subjectRef: d.subjectRef ?? null,
    subjectDoc: d.subjectDoc ?? null,
    subjectDocumentId: d.subjectDocumentId ?? null,
    inheritedFromParent: d.inheritedFromParent === true,
    recordId: d.recordId ?? null,
    recordText: typeof d.request?.state?.record === "string" ? d.request.state.record : null,
    modelId: d.modelId && d.modelId !== "unavailable" ? d.modelId : null,
    createdAt: d.createdAt,
    latencyMs: d.latencyMs,
    inputTokens: d.inputTokens,
    rubricVersion: d.rubricVersion ?? null,
    runId: d.runId ?? null,
    runAvailable: d.runAvailable,
    batchId: d.batchId ?? null,
    workId: d.workId ?? null,
    nodeId: d.nodeId ?? null,
    association: d.association ?? null,
    bypass: d.bypass ?? null,
    scheduling: d.scheduling ?? null,
    request: d.request ?? null,
    response,
    redacted: d.request?.state?.document_context?.redacted === true,
    inspectable: d.inputInspection === true,
  };
}

function Verdict({ view }) {
  if (!view.outcome.label) return null;
  return html`<span class=${`decision-verdict decision-verdict--${view.outcome.tone}`}>${view.outcome.label}</span>`;
}

function ScoreLine({ view }) {
  if (view.bypass) return html`<span class="decision-card-score">No model call</span>`;
  if (view.choice) return null;
  if (view.score === null) return html`<span class="decision-card-score">No score</span>`;
  return html`<span class="decision-card-score">score <strong>${view.score}</strong>${view.threshold !== null ? html` ${view.comparison} threshold ${view.threshold}` : null}${view.scale ? ` · scale ${view.scale}` : ""}</span>`;
}

function Header({ view, as: Tag = "div", when = false }) {
  return html`<${Tag} class="decision-card-head">
    <${DecisionIcon} />
    <strong class="decision-card-title">${view.title}</strong>
    <${Verdict} view=${view} />
    <${ScoreLine} view=${view} />
    ${view.lane && !view.knowledge && view.purpose !== "find-route" && html`<span class="cognition-dim">${view.lane}</span>`}
    ${when && html`<span class="cognition-dim decision-card-when">${timestamp(view.createdAt)}</span>`}
  </${Tag}>`;
}

function Subject({ view }) {
  if (view.subjectRef) return html`<${DecisionSubject} subject=${view.subjectRef} />`;
  const id = view.subjectDoc?.id ?? view.subjectDocumentId;
  if (!id) return null;
  const link = html`<a href=${`/portal/doc/${encodeURIComponent(id)}`}>${view.subjectDoc?.title || id}</a>`;
  return view.inheritedFromParent
    ? html`the document that contains it ${link}<span class="cognition-dim"> — this attachment inherits its email's judgement</span>`
    : link;
}

function RecordRef({ view }) {
  if (!view.recordId) return null;
  if (view.purpose === "task-check")
    return html`<a href=${internalKnowledgeHref(`loop:${view.recordId}`)}>Task <code>${view.recordId}</code></a>`;
  if (view.purpose === "observation-salience")
    return html`<a href=${`/portal/debug/cognition/observations/${encodeURIComponent(view.recordId)}`}>Observation <code>${view.recordId}</code></a>`;
  return html`${view.recordText && html`<span class="cognition-decision-record">${view.recordText}</span> `}<code>${view.recordId}</code>`;
}

function RunRef({ view }) {
  if (!view.runId) return view.knowledge ? null : html`Made outside any Brain run`;
  if (view.runAvailable === false) return html`No longer retained`;
  return html`<a href=${`/portal/debug/cognition/runs/${encodeURIComponent(view.runId)}`}>View run</a>`;
}

const delay = (milliseconds) => {
  if (!Number.isFinite(milliseconds)) return "Not recorded";
  const [divisor, unit] = milliseconds >= 3_600_000 && milliseconds % 3_600_000 === 0 ? [3_600_000, "h"]
    : milliseconds >= 60_000 && milliseconds % 60_000 === 0 ? [60_000, "min"]
      : milliseconds >= 1000 && milliseconds % 1000 === 0 ? [1000, "s"] : [1, "ms"];
  return `${(milliseconds / divisor).toLocaleString()} ${unit}`;
};

/** The schedule an urgency judgement produced, as it stood at that attempt. */
export function DecisionScheduling({ scheduling }) {
  if (!scheduling) return null;
  const { applied, proposed, policy } = scheduling;
  const differs = proposed && (!applied || proposed.tier !== applied.tier || proposed.dueAt !== applied.dueAt);
  return html`<dl class="kn-facts">
    <dt>Scheduling</dt><dd>${scheduling.status === "scheduled" ? "Scheduled at this attempt" : "No schedule applied at this attempt"}</dd>
    ${policy && html`<dt>Recorded policy</dt><dd>Immediate ≥ ${fixed(policy.immediateThreshold)}; Soon ≥ ${fixed(policy.soonThreshold)}; otherwise Routine.</dd>
      <dt>Configured delays</dt><dd>Soon: ${delay(policy.soonDelayMs)}; Routine: ${delay(policy.routineDelayMs)}</dd>`}
    ${differs && html`<dt>Proposed schedule</dt><dd>${proposed.tier} · ${timestamp(proposed.dueAt)}</dd>`}
    ${applied && html`<dt>Applied tier</dt><dd>${applied.tier}</dd><dt>Eligible from</dt><dd>${timestamp(applied.dueAt)}</dd>`}
    ${differs && applied && html`<dt>Schedule adjustment</dt><dd>The applied schedule incorporates existing work obligations.</dd>`}
    ${scheduling.fallbackSoon && html`<dt>Fallback</dt><dd>Soon, without a usable urgency verdict</dd>`}
  </dl>`;
}

const bypassReason = (bypass) =>
  bypass.reason === "request_budget_exceeded" ? "the complete decision input exceeds the application budget"
    : bypass.reason === "empty_source" ? "the source is empty" : "the decision model is unavailable";

const associationText = (view) =>
  view.association === "historical-matched" ? "Historical match: associated using stored inputs and timing, not linked when recorded."
    : view.association === "recorded" ? view.workId ? "Linked through scheduled work." : "Linked to this run when recorded."
      : "Run association was not recorded.";

/** Instructions or criteria: prose as prose, a structured reference as JSON. */
function prose(value) {
  if (value == null) return null;
  return typeof value === "string" ? value : html`<code>${JSON.stringify(value)}</code>`;
}

const percent = (n) => (typeof n === "number" ? `${Math.round(n * 100)}%` : "—");

/** The state and questions sent to the model. */
export function DecisionRequestView({ request }) {
  const state = request?.state;
  const fields = state && typeof state === "object" && !Array.isArray(state) ? Object.entries(state) : null;
  const questions = request?.questions && typeof request.questions === "object" && !Array.isArray(request.questions) ? Object.entries(request.questions) : [];
  return html`<div class="cognition-decision-request">
    <div class="cognition-decision-sub">State</div>
    ${fields
      ? fields.map(([key, value]) => html`<div key=${key} class="cognition-decision-state">
          <span class="cognition-decision-state-key">${key}</span>
          <span class="cognition-decision-state-value">${typeof value === "string" ? value : JSON.stringify(value)}</span>
        </div>`)
      : html`<pre class="cognition-decision-pre">${typeof state === "string" ? state : JSON.stringify(state, null, 2)}</pre>`}
    ${questions.map(([qid, q]) => html`<div key=${qid}>
      <div class="cognition-decision-sub">Question <code>${qid}</code>${q?.type ? ` · ${q.type}` : ""}</div>
      <div class="cognition-decision-instructions">${prose(q?.instructions)}</div>
      ${Array.isArray(q?.criteria)
        ? html`<ol class="cognition-decision-criteria" start="0">${q.criteria.map((c, i) => html`<li key=${i}>${prose(c)}</li>`)}</ol>`
        : q?.criteria && typeof q.criteria === "object"
          ? html`<ul class="cognition-decision-criteria">${Object.entries(q.criteria).map(([k, c]) => html`<li key=${k}><strong>${k}</strong>${c == null ? "" : html` — ${prose(c)}`}</li>`)}</ul>`
          : null}
    </div>`)}
  </div>`;
}

/** What the model answered: each answer and its per-level probabilities, named by criterion. */
export function DecisionAnswerView({ response, request }) {
  const answers = response?.answers && typeof response.answers === "object" && !Array.isArray(response.answers) ? Object.entries(response.answers) : [];
  return html`<div class="cognition-decision-answer">
    ${response?.model ? html`<div class="cognition-dim">answered by <code>${response.model}</code></div>` : null}
    ${answers.map(([qid, a]) => {
      const criteria = request?.questions?.[qid]?.criteria;
      const probabilities = Object.entries(a?.probabilities ?? {});
      return html`<div key=${qid}>
        <div class="cognition-decision-sub"><code>${qid}</code> ·
          ${a?.type === "noul" ? html` yes ${percent(a.noul)}` : a?.type === "choice" ? html` ${a.choice}` : html` score ${fixed(a?.score) ?? "—"}`}
          ${typeof a?.confidence === "number" ? html` · confidence ${percent(a.confidence)}` : null}
        </div>
        ${typeof a?.explanation === "string" && html`<p>${a.explanation}</p>`}
        ${probabilities.length > 0 && html`<div class="cognition-decision-bars">
          ${probabilities.map(([key, p]) => {
            const index = /^\d+$/.test(key) ? Number(key) : NaN;
            const text = Array.isArray(criteria) ? criteria[index] : criteria?.[key];
            const described = typeof text === "string" ? text : text == null ? null : JSON.stringify(text);
            return html`<div key=${key} class="cognition-decision-bar" title=${described ?? key}>
              <span class="cognition-decision-bar-label"><strong>${key}</strong>${described ? html` ${described}` : null}</span>
              <span class="cognition-decision-bar-track"><span class="cognition-decision-bar-fill" style=${`width:${Math.max(0, Math.min(100, p * 100))}%;`}></span></span>
              <span class="cognition-decision-bar-pct">${percent(p)}</span>
            </div>`;
          })}
        </div>`}
      </div>`;
    })}
  </div>`;
}

/**
 * A request and answer, whichever store they came from: `exact` is the
 * payload store's capture, `retained` the ledger row's own copy (cleared
 * past the retention window, and redacted for older source context).
 */
export function DecisionPayload({ request, response, error, fidelity = "exact", redacted = false }) {
  return html`${fidelity === "retained" && html`<p class="cognition-dim">An exact snapshot is unavailable. This is the retained decision ledger.</p>`}
    ${redacted && html`<p class="cognition-dim">Source context was redacted from the recorded request; it is not an exact replay of the model input.</p>`}
    ${redacted && html`<p class="cognition-dim">Only the resulting score was retained, not the complete model answer.</p>`}
    ${request != null && html`<h4>Request sent</h4><${DecisionRequestView} request=${request} />`}
    ${response != null && html`<h4>Answer received</h4><${DecisionAnswerView} response=${response} request=${request} />`}
    ${request == null && html`<p class="cognition-dim">No model request is retained for this judgement.</p>`}
    ${response == null && html`<p class="cognition-dim">No model answer is retained for this judgement.</p>`}
    ${error != null && html`<h4>Recorded failure</h4><pre class="cognition-decision-pre">${typeof error === "string" ? error : JSON.stringify(error, null, 2)}</pre>`}
    <details class="cognition-decision-details"><summary>Raw request and answer</summary>
      <pre class="cognition-decision-pre">${JSON.stringify({ request: request ?? null, response: response ?? null }, null, 2)}</pre>
    </details>`;
}

/** What an inspection endpoint returned, read into `DecisionPayload`. */
export function DecisionInspection({ data }) {
  if (data?.retained)
    return html`<${DecisionPayload} request=${data.retained.request} response=${data.retained.response} fidelity="retained" redacted=${data.retained.requestFidelity === "redacted"} />`;
  const input = data?.input;
  if (!input || input.availability !== "available")
    return html`<p class="cognition-dim">${input?.availability === "oversized"
      ? "The recorded request or result exceeds the inspection limit."
      : "The exact request and result are unavailable; they have not been reconstructed."}</p>`;
  return html`<${DecisionPayload} request=${input.request} response=${input.response} error=${input.error} />`;
}

/** Loads the exact request and answer only while the disclosure is open. */
export function DecisionPayloadLoader({ id, knowledge }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setState({ loading: true });
    (knowledge ? getKnowledgeDecision(id) : getCognitionDecisionInput(id)).then(
      (data) => { if (alive) setState({ data }); },
      () => { if (alive) setState({ error: true }); },
    );
    return () => { alive = false; };
  }, [open, id, knowledge]);
  return html`<details class="cognition-decision-details" onToggle=${(event) => setOpen(event.currentTarget.open)}>
    <summary>Request and answer</summary>
    ${open && (state.loading ? html`<p role="status">Loading decision…</p>`
      : state.error ? html`<p role="alert">Decision inspection could not be loaded. Close and reopen to retry.</p>`
        : html`<${DecisionInspection} data=${state.data} />`)}
  </details>`;
}

/**
 * The request and answer behind a decision. An inspectable decision loads
 * them on demand (the exact capture where one exists, else the ledger row's
 * retained copy); a decision served with its retained copy inline shows that.
 */
function PayloadSection({ view }) {
  if (view.reusedFrom) return null;
  if (view.inspectable) return html`<${DecisionPayloadLoader} id=${view.id} knowledge=${view.knowledge} />`;
  if (view.request || view.response)
    return html`<details class="cognition-decision-details"><summary>Request and answer</summary>
      <${DecisionPayload} request=${view.request} response=${view.response} fidelity="retained" redacted=${view.redacted} />
    </details>`;
  return html`<p class="cognition-dim">No model request or answer is retained for this judgement.</p>`;
}

function Body({ view, showSubject }) {
  const about = showSubject ? html`<${Subject} view=${view} />` : null;
  const record = html`<${RecordRef} view=${view} />`;
  const run = html`<${RunRef} view=${view} />`;
  return html`${view.outcome.sentence && html`<p class="decision-card-sentence">${view.outcome.sentence}</p>`}
    ${view.error && html`<p class="decision-card-error">${view.error}</p>`}
    <dl class="kn-facts">
      ${about && (view.subjectRef || view.subjectDoc || view.subjectDocumentId) && html`<dt>About</dt><dd>${about}</dd>`}
      ${view.recordId && html`<dt>Record</dt><dd>${record}</dd>`}
      ${view.reusedFrom && html`<dt>Reused</dt><dd>decision <code>${view.reusedFrom}</code><span class="cognition-dim"> — same content under the same rubric</span></dd>`}
      <dt>Model</dt><dd>${view.modelId ? html`<code>${view.modelId}</code>` : "Not recorded"}</dd>
      <dt>Decided</dt><dd>${timestamp(view.createdAt)}</dd>
      ${(view.runId || !view.knowledge) && html`<dt>Run</dt><dd>${run}</dd>`}
      ${view.batchId && html`<dt>Maintenance</dt><dd><a href=${`/portal/debug/cognition/maintenance/${encodeURIComponent(view.batchId)}`}>View batch</a></dd>`}
    </dl>
    ${view.bypass && html`<p>No model call: ${bypassReason(view.bypass)}. Work was admitted for inspection. ${view.bypass.inputBytes} input bytes / ${view.bypass.budgetBytes} budget bytes.</p>`}
    <${DecisionScheduling} scheduling=${view.scheduling} />
    <details class="cognition-decision-details"><summary>Decision metadata</summary><dl class="kn-facts">
      ${view.knowledge && html`<dt>Association</dt><dd>${associationText(view)}</dd>`}
      ${view.lane && html`<dt>Lane</dt><dd><code>${view.lane}</code></dd>`}
      <dt>Rubric</dt><dd><code>${view.rubricVersion || "Not recorded"}</code></dd>
      <dt>Latency</dt><dd>${recorded(view.latencyMs, " ms")}</dd>
      <dt>Input tokens</dt><dd>${recorded(view.inputTokens)}</dd>
      ${(view.nodeId || view.subjectDocumentId) && html`<dt>Subject</dt><dd><code>${view.nodeId ?? view.subjectDocumentId}</code></dd>`}
      ${view.batchId && html`<dt>Batch</dt><dd><code>${view.batchId}</code></dd>`}
      ${view.workId && html`<dt>Work</dt><dd><code>${view.workId}</code></dd>`}
      <dt>Decision ID</dt><dd><code>${view.id}</code></dd>
    </dl></details>
    <${PayloadSection} view=${view} />`;
}

/**
 * One decision-model judgement. `layout="full"` renders the card in place;
 * `layout="compact"` folds it into a disclosure whose summary is the header.
 * `showSubject={false}` leaves out what the decision was about, for a surface
 * that is already about it.
 */
export function DecisionCard({ decision, layout = "full", showSubject = true }) {
  const view = decisionView(decision);
  if (layout === "compact")
    return html`<details class="decision-card decision-card--compact" data-decision-id=${view.id}>
      <${Header} view=${view} as="summary" when=${true} />
      <div class="decision-card-body">
        <${Body} view=${view} showSubject=${showSubject} />
      </div>
    </details>`;
  return html`<article class="decision-card" data-decision-id=${view.id}>
    <${Header} view=${view} />
    <${Body} view=${view} showSubject=${showSubject} />
  </article>`;
}

/**
 * Decisions recorded for one context (a run's synthesis, a maintenance batch,
 * a page's review history), each a compact card. An empty list says only that
 * nothing was recorded.
 */
export function DecisionList({ decisions = [], audit, title, layout = "compact", showSubject = true, emptyText = "No recorded judgement for this context. This does not establish that a gate was bypassed." }) {
  return html`<section class="decision-list" aria-label=${title ?? "Decisions"}>
    ${title && html`<h3>${title}</h3>`}
    ${!decisions.length && html`<p class="cognition-dim">${emptyText}</p>`}
    ${decisions.map((decision) => html`<${DecisionCard} key=${decision.id} decision=${decision} layout=${layout} showSubject=${showSubject} />`)}
    ${audit?.truncated && html`<p class="cognition-dim">Additional recorded checks are not shown.</p>`}
    ${audit?.legacyIncomplete && html`<p class="cognition-dim">Historical associations are incomplete.</p>`}
  </section>`;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Interest — the ledger of what the owner told Omnesis they care about, on
// the Cognition debug page. Every signal is one deliberate reaction (a task
// accepted, created or ignored; a thumbs on a brief item; a statement in the
// Morning brief conversation), kept with the text it was about and, once the
// embedder has seen it, a vector. The tab shows the ledger, whether each
// signal has its vector yet, a probe that runs one lookup the way a decision
// gate does, and the suggestion-gate verdicts the ledger fed. Read-only: a
// reaction is only ever written through the product surfaces.
//
// Self-contained module (own loader, own formatting) so its host,
// cognition.js, carries only an import and a mount line.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { getBrainInterest, probeBrainInterest } from "../api.js";
import { DecisionList } from "../components/decision-card.js";
import { internalKnowledgeHref } from "./knowledge-claim-markdown.js";
import { BrainInactiveBanner, LoadState, Pill, cognitionPath, fmtRel, fmtTs, useLoader } from "./cognition.js";

// ── Pure helpers (exported for tests) ────────────────────────────────

const SOURCE_LABELS = {
  task_accepted: "accepted a suggestion",
  task_created: "created a task",
  task_ignored: "ignored a suggestion",
  task_adopt_undone: "undid an adopted task",
  brief_thumbs_up: "brief item thumbs up",
  brief_not_interested: "brief item not interested",
  statement: "said so in the brief",
};

/** What the owner did, in words; an unknown source renders as itself. */
export function sourceLabel(source) {
  return SOURCE_LABELS[source] ?? source;
}

/** The polarity badge: what it says and the colour it wears. */
export function polarityBadge(signal) {
  if (signal.kind === "statement")
    return signal.polarity === 1 ? { label: "more", color: "#86efac" } : { label: "less", color: "#fca5a5" };
  return signal.polarity === 1 ? { label: "wanted", color: "#86efac" } : { label: "not wanted", color: "#fca5a5" };
}

/** Where a signal's subject lives: its task or its observation, when it has one. */
export function signalHref(signal) {
  if (signal.loopId) return { label: "Task", href: internalKnowledgeHref(`loop:${signal.loopId}`) };
  if (signal.observationId)
    return { label: "Observation", href: cognitionPath("observations", signal.observationId) };
  return null;
}

/** "3 signals waiting for a vector", or null when nothing waits. */
export function backlogLabel(backlog) {
  if (!Number.isInteger(backlog) || backlog <= 0) return null;
  return `${backlog} ${backlog === 1 ? "signal" : "signals"} waiting for a vector`;
}

/** "12 live · 3 superseded · 8 wanted · 3 not wanted · 1 statement". */
export function countsLine(counts) {
  const c = counts ?? {};
  const n = (value) => (Number.isInteger(value) ? value : 0);
  return [
    `${n(c.live)} live`,
    `${n(c.superseded)} superseded`,
    `${n(c.positive)} wanted`,
    `${n(c.negative)} not wanted`,
    `${n(c.statements)} ${n(c.statements) === 1 ? "statement" : "statements"}`,
  ].join(" · ");
}

/** "3d" / "today" from an example's age in days. */
export function ageDaysLabel(ageDays) {
  if (!Number.isInteger(ageDays) || ageDays < 0) return "—";
  return ageDays === 0 ? "today" : `${ageDays}d ago`;
}

/** Two-decimal similarity, or an em dash. */
export function similarityLabel(similarity) {
  return typeof similarity === "number" && Number.isFinite(similarity) ? similarity.toFixed(2) : "—";
}

/**
 * The probe's answer as the three lists the gate state carries. Every list
 * is present, empty when nothing of that kind resembled the text, so a null
 * result reads as three empty lists rather than a missing one.
 */
export function probeSections(result) {
  return [
    { key: "positive", title: "Wanted things like it", items: result?.positive ?? [] },
    { key: "negative", title: "Did not want things like it", items: result?.negative ?? [] },
    { key: "statements", title: "Said about things like it", items: result?.statements ?? [] },
  ];
}

export const EMPTY_LEDGER_TEXT =
  "Accept or ignore a suggestion, or give a brief item a thumbs, to teach Omnesis what you care about.";

// ── Panel ────────────────────────────────────────────────────────────

function LookupProbe() {
  const [text, setText] = useState("");
  const [probe, setProbe] = useState(null); // { status, text, result?, error? }
  const run = (e) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setProbe({ status: "loading", text: trimmed });
    probeBrainInterest(trimmed).then(
      (data) => setProbe({ status: "ok", text: data.text, result: data.result }),
      (err) => setProbe({ status: "error", text: trimmed, error: err?.message ?? String(err) }),
    );
  };
  return html`<section class="cognition-interest-probe">
    <h3 class="cognition-section">Try a lookup</h3>
    <p class="debug-sub" style="margin:0 0 8px;">
      Type something a gate might judge — a suggested task, a brief item — and see which past reactions it would be shown.
    </p>
    <form class="cognition-filters" onSubmit=${run}>
      <input
        class="cognition-interest-probe-input"
        type="text"
        aria-label="Text to look up"
        placeholder="e.g. Renew the parking permit before the end of the month"
        value=${text}
        onInput=${(e) => setText(e.currentTarget.value)}
      />
      <button type="submit" class="btn-secondary" disabled=${!text.trim() || probe?.status === "loading"}>
        ${probe?.status === "loading" ? "Looking…" : "Look up"}
      </button>
    </form>
    ${probe?.status === "error" && html`<div class="debug-error">⚠️ ${probe.error}</div>`}
    ${probe?.status === "ok" && html`<div class="cognition-interest-probe-result">
      ${probe.result === null
        ? html`<div class="debug-empty">Nothing in the ledger resembles “${probe.text}”. A gate would judge it without owner interest.</div>`
        : probeSections(probe.result).map((section) => html`<div key=${section.key}>
            <h4 class="cognition-interest-probe-title">${section.title} (${section.items.length})</h4>
            ${section.items.length === 0
              ? html`<p class="cognition-dim">None.</p>`
              : html`<ul class="cognition-interest-examples">
                  ${section.items.map((example, index) => html`<li key=${index}>
                    <span class="cognition-interest-example-text">${example.text}</span>
                    ${example.note && html`<span class="cognition-dim"> — “${example.note}”</span>`}
                    <span class="cognition-dim"> · ${example.direction ?? sourceLabel(example.source)} · ${ageDaysLabel(example.ageDays)} · similarity ${similarityLabel(example.similarity)}</span>
                  </li>`)}
                </ul>`}
          </div>`)}
    </div>`}
  </section>`;
}

function SignalRow({ signal, nowMs }) {
  const badge = polarityBadge(signal);
  const link = signalHref(signal);
  return html`<tr class=${signal.supersededAt ? "cognition-interest-superseded" : ""}>
    <td><${Pill} color=${badge.color}>${badge.label}</${Pill}></td>
    <td>${signal.kind}</td>
    <td>${sourceLabel(signal.source)}</td>
    <td class="cognition-interest-text">
      <span>${signal.text}</span>
      ${signal.note && html`<div class="cognition-dim">“${signal.note}”</div>`}
    </td>
    <td title=${fmtTs(signal.createdAt)}>${fmtRel(signal.createdAt, nowMs)}</td>
    <td class="num" title=${signal.embedded ? "Has its vector" : "No vector yet; matched by words"}>${signal.embedded ? "✓" : "—"}</td>
    <td>
      ${link?.href && html`<a href=${link.href}>${link.label}</a>`}
      ${signal.supersededAt && html`<div class="cognition-dim" title=${fmtTs(signal.supersededAt)}>superseded ${fmtRel(signal.supersededAt, nowMs)}</div>`}
    </td>
  </tr>`;
}

export function InterestTab() {
  const { data, error, loading, reload } = useLoader(() => getBrainInterest({ limit: 200 }), []);
  const nowMs = Date.now();
  const signals = data?.signals ?? [];
  const decisions = data?.decisions ?? [];
  const backlog = backlogLabel(data?.backlog);
  return html`<div class="cognition-interest">
    <${BrainInactiveBanner} />
    <${LoadState} loading=${loading} error=${error} />
    ${data && html`
      <p class="debug-sub cognition-interest-status" style="margin:0 0 12px;">
        <strong>${data.enabled ? "Interest ledger on" : "Interest ledger off"}</strong>
        ${!data.enabled && html`<span class="cognition-dim"> — nothing is recorded and gates decide without it (brain.interest.enabled)</span>`}
        <span class="cognition-dim"> · ${countsLine(data.counts)}</span>
        ${backlog && html`<span class="cognition-interest-backlog"> · ${backlog}</span>`}
        <button type="button" class="btn-tiny" style="margin-left:8px;" onClick=${reload}>Refresh</button>
      </p>
      <${LookupProbe} />
      <h3 class="cognition-section">Signals (${signals.length}${data.counts && signals.length < data.counts.live + data.counts.superseded ? " newest" : ""})</h3>
      ${signals.length === 0
        ? html`<div class="debug-empty">${EMPTY_LEDGER_TEXT}</div>`
        : html`<div class="portal-table-wrap" style="overflow-x:auto;">
            <table class="debug-table cognition-interest-table">
              <thead>
                <tr>
                  <th>Reaction</th>
                  <th>Kind</th>
                  <th>How</th>
                  <th>What it was about</th>
                  <th>When</th>
                  <th class="num" title="Has its vector">Vector</th>
                  <th>Where</th>
                </tr>
              </thead>
              <tbody>
                ${signals.map((signal) => html`<${SignalRow} key=${signal.id} signal=${signal} nowMs=${nowMs} />`)}
              </tbody>
            </table>
          </div>`}
      <h3 class="cognition-section">Suggestion gate decisions (${decisions.length})</h3>
      <p class="debug-sub" style="margin:0 0 8px;">
        How the decision model judged each new Brain suggestion against these reactions: withheld, suggested or adopted.
      </p>
      <${DecisionList}
        decisions=${decisions}
        showSubject=${false}
        emptyText="No suggestion has been judged yet. The gate asks only when the ledger holds something the suggestion resembles."
      />
    `}
  </div>`;
}

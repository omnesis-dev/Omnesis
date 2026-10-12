// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Observations — the Cognition inspector's view of what agent runs noted for
// the morning brief. An observation is never shown to the user directly: the
// morning run rechecks every live or held one, ships the best into that
// morning's message, holds the rest below the bar, or drops one with a
// reason. This view lists them with the decision model's scores, opens one
// with its decisions and provenance, shows the "would have pushed" log, and
// shows the item list one day's morning brief carried. Strictly read-only.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { Segmented } from "../components/segmented.js";
import { LoadMore } from "../components/load-more.js";
import { navigate } from "../lib/router.js";
import { useCursorPage } from "../lib/use-cursor-page.js";
import {
  getCognitionMorningBrief,
  getCognitionObservation,
  getCognitionWouldPush,
  getCognitionObservations,
} from "../api.js";
import {
  ArtifactProvenance,
  BrainInactiveBanner,
  DocList,
  EmptyDetail,
  EntityId,
  Field,
  ListRow,
  LoadState,
  MasterDetail,
  Pill,
  annotate,
  cognitionPath,
  fmtRel,
  fmtTs,
  useLoader,
} from "./cognition.js";

// ── Pure helpers (exported for tests) ────────────────────────────────

export const OBSERVATION_STATE_FILTERS = [
  { value: "open", label: "Open" },
  { value: "live", label: "Live" },
  { value: "held", label: "Held" },
  { value: "shipped", label: "Shipped" },
  { value: "dropped", label: "Dropped" },
  { value: "all", label: "All" },
];

export function observationStateColor(state) {
  switch (state) {
    case "live": return "#86efac";
    case "held": return "#fde68a";
    case "shipped": return "#93c5fd";
    case "dropped": return "#cbd5e1";
    default: return "#94a3b8";
  }
}

const CLOSE_REASONS = {
  below_bar: "Below the bar this morning",
  expired: "Its window ended before it shipped",
  stale: "Cited evidence changed or disappeared",
  superseded: "Its loops resolved or a newer observation replaced it",
  already_known: "The user already knows it",
  unsupported: "The entailment check rejected its claims",
  suppressed: "The user asked not to see it",
  withdrawn: "The noting agent withdrew it",
};

/** Why an observation waits or closed, as a sentence; null without a reason. */
export function closeReasonLabel(reason) {
  if (!reason) return null;
  return CLOSE_REASONS[reason] ?? String(reason).replaceAll("_", " ");
}

const levelText = (value, max) => (typeof value === "number" ? `${value}/${max}` : "—");

/**
 * The decision model's three judgements as display parts: consequence
 * (0–4), timing (0–3) and the probability the user already knows it.
 * Null scores — no judgement yet, or the judgement was unavailable —
 * read as dashes.
 */
export function observationScoreParts(scores) {
  return [
    { key: "consequence", label: "Consequence", value: levelText(scores?.consequence, 4) },
    { key: "timing", label: "Timing", value: levelText(scores?.timing, 3) },
    {
      key: "alreadyKnown",
      label: "Already known",
      value: typeof scores?.alreadyKnown === "number" ? `${Math.round(scores.alreadyKnown * 100)}%` : "—",
    },
  ];
}

/** "C 3/4 · T 2/3 · K 20%" — the compact score line a list row shows. */
export function observationScoreSummary(scores) {
  if (!scores) return "not scored";
  const [c, t, k] = observationScoreParts(scores);
  return `C ${c.value} · T ${t.value} · K ${k.value}`;
}

/** Where the brief message an observation shipped in opens; null when it never shipped. */
export function shippedMessageHref(observation) {
  const id = observation?.shippedConversationId;
  return id ? `/portal/agent/${encodeURIComponent(id)}` : null;
}

function navigateTo(href) {
  return (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
}

// ── Components ───────────────────────────────────────────────────────

const VIEWS = [
  { value: "observations", label: "Observations" },
  { value: "brief", label: "Morning brief" },
  { value: "would-push", label: "Would have pushed" },
];

export function ObservationsTab({ selectedId }) {
  const [view, setView] = useState("observations");
  return html`
    <section class=${`debug-operations${selectedId ? " has-selection" : ""}`}>
      <${BrainInactiveBanner} />
      <div class="cognition-filters">
        <${Segmented} options=${VIEWS} value=${selectedId ? "observations" : view} onChange=${(next) => {
          setView(next);
          if (selectedId) navigate(cognitionPath("observations"));
        }} />
      </div>
      ${selectedId || view === "observations"
        ? html`<${ObservationList} selectedId=${selectedId} />`
        : view === "brief"
          ? html`<${MorningBriefPanel} />`
          : html`<${WouldPushLog} />`}
    </section>
  `;
}

function ObservationList({ selectedId }) {
  const [state, setState] = useState("open");
  const page = useCursorPage({
    resetKey: `observations:${state}`,
    pageSize: 50,
    loadPage: ({ limit, cursor }) =>
      getCognitionObservations({ ...(state === "all" ? {} : { state }), limit, cursor }),
  });
  const items = page.items;
  const nowMs = Date.now();
  const list = html`<div>
    ${page.loaded && items.length === 0
      ? html`<div class="debug-empty" style="padding:16px;">No observations in this state.</div>`
      : items.map((o) => html`
        <${ListRow} key=${o.id} section="observations" id=${o.id} selected=${o.id === selectedId}>
          <div class="cognition-row-top">
            <span class="cognition-row-pills">
              <${Pill} color=${observationStateColor(o.state)}>${o.state}</${Pill}>
              <span class="cognition-row-kind">${observationScoreSummary(o.scores ?? o.notedScores)}</span>
            </span>
            <span class="cognition-row-time" title=${fmtTs(o.createdAt)}>${fmtRel(o.createdAt, nowMs)}</span>
          </div>
          <div class="cognition-row-title">${o.summary || "Untitled observation"}</div>
          ${o.closeReason && html`<div class="cognition-row-sub">${closeReasonLabel(o.closeReason)}</div>`}
        </${ListRow}>`)}
    <${LoadMore}
      hasMore=${page.hasMore}
      loading=${page.loadingMore}
      error=${page.loadMoreError}
      onLoadMore=${page.loadMore}
      label="Load more observations"
    />
  </div>`;
  return html`
    <div class="cognition-filters">
      <${Segmented} options=${OBSERVATION_STATE_FILTERS} value=${state} onChange=${setState} />
    </div>
    <${LoadState} loading=${page.loading} error=${page.error} />
    ${selectedId && html`<a class="debug-operations-back" href=${cognitionPath("observations")} onClick=${navigateTo(cognitionPath("observations"))}>← Back to observations</a>`}
    <${MasterDetail}
      list=${list}
      detail=${selectedId
        ? html`<${ObservationDetail} id=${selectedId} />`
        : items.length ? html`<${EmptyDetail} noun="observation" />` : null}
    />
  `;
}

function ScoresField({ label, scores }) {
  if (!scores) return html`<${Field} label=${label}><span class="cognition-id-empty">not scored</span></${Field}>`;
  return html`<${Field} label=${label}>
    <span class="cognition-observation-scores">
      ${observationScoreParts(scores).map((part) => html`<span key=${part.key}>${part.label} <strong>${part.value}</strong></span>`)}
    </span>
    <div class="cognition-dim">${scores.modelId ? html`<code>${scores.modelId}</code> · ` : ""}${fmtTs(scores.at)}</div>
  </${Field}>`;
}

function ClaimList({ claims }) {
  if (!claims || claims.length === 0) return html`<span class="cognition-id-empty">—</span>`;
  return html`<div>
    ${claims.map((c, i) => html`<div class="meta-annotation" key=${`${c.docId}:${i}`}>
      <div class="meta-annotation-head">
        <span class="meta-annotation-verify" title="Entailment verdict from the morning recheck">${c.verification}</span>
      </div>
      <div class="meta-enriched-phrase meta-annotation-quote" title=${c.quote}>“${c.quote}”</div>
      <${EntityId} kind="doc" id=${c.docId} />
    </div>`)}
  </div>`;
}

function DecisionList({ decisions }) {
  if (!decisions || decisions.length === 0) return html`<div class="debug-empty">No salience judgements recorded.</div>`;
  return html`<div>
    ${decisions.map((d) => html`<div key=${d.id} class="cognition-decision">
      <div class="cognition-decision-head">
        <${Pill} color=${d.verdict === "pass" ? "#86efac" : d.verdict === "unavailable" ? "#fdba74" : "#d2a8ff"}>${d.verdict}</${Pill}>
        <span class="cognition-decision-score">
          score <strong>${typeof d.score === "number" ? d.score.toFixed(2) : "—"}</strong> · threshold ${typeof d.threshold === "number" ? d.threshold.toFixed(2) : "—"}
        </span>
        <span class="cognition-dim">${d.lane}</span>
      </div>
      ${d.error && html`<div class="debug-error" style="margin:6px 0;">⚠️ ${d.error}</div>`}
      <${Field} label="Run"><${EntityId} kind="run" id=${d.runId} /></${Field}>
      <${Field} label="Model">${d.modelId ? html`<code>${d.modelId}</code>` : "—"}</${Field}>
      <${Field} label="Decided">${fmtTs(d.createdAt)}</${Field}>
      ${d.answers != null && html`<details class="cognition-decision-details">
        <summary>Recorded answers</summary>
        <pre class="cognition-mono">${JSON.stringify(d.answers, null, 2)}</pre>
      </details>`}
    </div>`)}
  </div>`;
}

/**
 * One observation: its scores, claims, the brief message it shipped in,
 * related loops, the run that noted it, and every salience decision. The
 * Library embeds it (`embedded`, with the synthesis as `content`).
 */
export function ObservationDetail({ id, content = null, embedded = false }) {
  const { data, error, loading } = useLoader(() => getCognitionObservation(id), [id]);
  if (loading || error) return html`<div style="padding:8px;"><${LoadState} loading=${loading} error=${error} /></div>`;
  const { observation: o, relatedLoops, decisions, provenance } = data;
  const shippedHref = shippedMessageHref(o);
  return html`
    <div class="cognition-detail-body">
      <div class="cognition-detail-titlebar">
        ${!embedded && html`<h2 class="cognition-detail-title">${o.summary || "(untitled)"}</h2>`}
        ${annotate({ targetType: "route", label: `Observation ${o.id}`, deepLink: cognitionPath("observations", o.id) })}
      </div>
      <div style="margin-bottom:12px;">
        <${Pill} color=${observationStateColor(o.state)}>${o.state}</${Pill}>
        ${o.closeReason && html`<span style="color:var(--text-secondary);">${closeReasonLabel(o.closeReason)}</span>`}
      </div>
      ${content ?? html`<${Field} label="Why it matters">${o.why || "—"}</${Field}>`}
      <${ScoresField} label="Latest scores" scores=${o.scores} />
      <${ScoresField} label="Scores when noted" scores=${o.notedScores} />
      <${Field} label="Shipped in">
        ${shippedHref
          ? html`<a href=${shippedHref} onClick=${navigateTo(shippedHref)}>Morning brief message</a>
              <span class="cognition-dim"> · ${fmtTs(o.shippedAt)}${o.shippedMessageId ? html` · <code>${o.shippedMessageId}</code>` : ""}</span>`
          : html`<span class="cognition-id-empty">not shipped</span>`}
      </${Field}>
      <${Field} label="Window">
        ${o.windowStart ? fmtTs(o.windowStart) : "from noting"} → ${o.relevantUntil ? fmtTs(o.relevantUntil) : "no end"}
      </${Field}>
      ${o.wouldPushAt && html`<${Field} label="Would have pushed">${fmtTs(o.wouldPushAt)}</${Field}>`}
      ${o.userAction && html`<${Field} label="User action">${o.userAction}</${Field}>`}
      <${Field} label="Citations"><${DocList} docs=${o.citations} /></${Field}>
      <${Field} label="Claims"><${ClaimList} claims=${o.claims} /></${Field}>
      <${Field} label="Related loops">
        ${relatedLoops?.length
          ? html`<span class="cognition-idlist">${relatedLoops.map((loop) => html`<span key=${loop.id}>
              <${EntityId} kind="loop" id=${loop.id} />${loop.title ? ` ${loop.title}` : ""}${loop.state ? html` <span class="cognition-dim">(${loop.state})</span>` : ""}
            </span>`)}</span>`
          : html`<span class="cognition-id-empty">—</span>`}
      </${Field}>
      <${Field} label="Noted by run"><${EntityId} kind="run" id=${o.createdByRun} /></${Field}>
      <${Field} label="Why am I seeing this?"><${ArtifactProvenance} provenance=${provenance} /></${Field}>
      <${Field} label="User's own writing">${o.userAuthored ? "Yes — every citation is the user's" : "No"}</${Field}>
      <${Field} label="Created">${fmtTs(o.createdAt)}</${Field}>
      <${Field} label="Updated">${fmtTs(o.updatedAt)}</${Field}>
      ${o.closedAt && html`<${Field} label="Closed">${fmtTs(o.closedAt)}</${Field}>`}
      <h3 class="cognition-section">Salience decisions (${decisions?.length ?? 0})</h3>
      <${DecisionList} decisions=${decisions} />
      <details class="debug-operations-advanced"><summary>Advanced</summary>
        <${Field} label="Id"><span class="cognition-mono">${o.id}</span></${Field}>
      </details>
    </div>
  `;
}

function ObservationLink({ id, children }) {
  const href = cognitionPath("observations", id);
  return html`<a href=${href} onClick=${navigateTo(href)}>${children}</a>`;
}

function MorningBriefPanel() {
  const [day, setDay] = useState("");
  const { data, error, loading } = useLoader(() => getCognitionMorningBrief(day || undefined), [day]);
  const sent = data?.sent ?? null;
  const items = data?.items ?? [];
  return html`<div class="cognition-morning-brief">
    <div class="cognition-filters">
      <label class="debug-operations-kind">Day
        <input class="cognition-date-input" type="date" aria-label="Morning brief day" value=${day} onInput=${(e) => setDay(e.currentTarget.value)} />
      </label>
      ${day && html`<button type="button" class="btn-tiny" onClick=${() => setDay("")}>Latest</button>`}
    </div>
    <${LoadState} loading=${loading} error=${error} />
    ${!loading && !error && html`
      ${sent
        ? html`<p class="debug-sub">
            Sent ${fmtTs(sent.sentAt)} for ${sent.day} with ${sent.itemCount} ${sent.itemCount === 1 ? "item" : "items"} ·
            run <${EntityId} kind="run" id=${sent.runId} /> ·
            <a href=${`/portal/agent/${encodeURIComponent(sent.conversationId)}`} onClick=${navigateTo(`/portal/agent/${encodeURIComponent(sent.conversationId)}`)}>open the conversation</a>
          </p>`
        : html`<p class="debug-sub">${day ? `No morning brief was sent for ${day}.` : "No morning brief has been sent yet."}${items.length ? " The ranked items below are waiting to be sent." : ""}</p>`}
      ${items.length === 0
        ? sent ? html`<div class="debug-empty">No items.</div>` : null
        : html`<div class="debug-table-scroll" role="region" aria-label="Morning brief items" tabindex="0"><table class="debug-table">
            <thead><tr><th class="num">Rank</th><th>Observation</th><th>State</th><th>Scores</th></tr></thead>
            <tbody>
              ${items.map((item) => html`<tr key=${`${item.rank}:${item.observationId}`}>
                <td class="num">${item.rank}</td>
                <td><${ObservationLink} id=${item.observationId}>${item.observation?.summary ?? item.observationId}</${ObservationLink}></td>
                <td>${item.observation ? html`<${Pill} color=${observationStateColor(item.observation.state)}>${item.observation.state}</${Pill}>` : "pruned"}</td>
                <td class="cognition-dim">${observationScoreSummary(item.observation?.scores)}</td>
              </tr>`)}
            </tbody>
          </table></div>`}
    `}
  </div>`;
}

function WouldPushLog() {
  const { data, error, loading } = useLoader(() => getCognitionWouldPush({ limit: 200 }), []);
  const items = data?.items ?? [];
  return html`<div>
    <p class="debug-sub">
      Observations noted at the top consequence level with a deadline before the next morning brief.
      Omnesis sends no same-day push; this log records when one would have fired.
    </p>
    <${LoadState} loading=${loading} error=${error} />
    ${!loading && !error && (items.length === 0
      ? html`<div class="debug-empty">No observation would have pushed.</div>`
      : html`<div class="debug-table-scroll" role="region" aria-label="Would have pushed" tabindex="0"><table class="debug-table">
          <thead><tr><th>Observation</th><th>Would push</th><th>State</th><th>Shipped</th><th>Relevant until</th><th>Scores when noted</th></tr></thead>
          <tbody>
            ${items.map((entry) => html`<tr key=${entry.id}>
              <td><${ObservationLink} id=${entry.id}>${entry.summary}</${ObservationLink}></td>
              <td title=${fmtTs(entry.wouldPushAt)}>${fmtRel(entry.wouldPushAt)}</td>
              <td><${Pill} color=${observationStateColor(entry.state)}>${entry.state}</${Pill}></td>
              <td>${entry.shippedAt ? fmtTs(entry.shippedAt) : "—"}</td>
              <td>${entry.relevantUntil ? fmtTs(entry.relevantUntil) : "—"}</td>
              <td class="cognition-dim">${observationScoreSummary(entry.notedScores)}</td>
            </tr>`)}
          </tbody>
        </table></div>`)}
  </div>`;
}

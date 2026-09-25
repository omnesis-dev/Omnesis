// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Cognition — the read-only Cognition Steward cognitive-state inspector, a sub-area
// of the Debug view (experimental-gated, mounted only when the gateway
// advertises experimental mode). A left rail of sections (with live counts)
// beside the section's content:
//   - Overview:  the agent's vital signs — what is running right now, the
//                queue, next wake, open loops, unread briefs, spend — plus
//                recent activity and upcoming checks.
//   - Loops:     the open loops the agent tracks (state, ledger, docs, briefs,
//                people, scheduled checks).
//   - Runs:      the whole run queue in one place — executing now, queued,
//                scheduled for later (the former "Scheduled" tab; same rows,
//                same store), and the settled history with costs and full
//                transcripts.
//   - Briefs:    ALL briefs incl. dismissed/snoozed/expired (the user feed
//                shows only active ones).
//   - Memory:    the agent-notes text + the consolidation store (retired loops).
//
// Strictly READ-ONLY: no edit / dismiss / wipe controls, and it consumes only
// GET endpoints (`api.js` exposes no mutating counterpart). Every id that
// references another entity is a link, so the whole cognitive graph is
// clickable (loop → loop, run → run, doc → the document page, brief → brief,
// person → the person page).

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Segmented } from "../components/segmented.js";
import { LoadMore } from "../components/load-more.js";
import { navigate, replaceRoute } from "../lib/router.js";
import { useCursorPage } from "../lib/use-cursor-page.js";
import { sourceIconUrl } from "../lib/format.js";
import { renderPart } from "../components/agent/parts.js";
import { transcriptEventsToTurns } from "./agent-reducer.js";
import {
  getCognitionBrief,
  getCognitionBriefs,
  openBriefThread,
  getCognitionLoop,
  getCognitionLoopBriefs,
  getCognitionLoopLedger,
  getCognitionLoopScheduled,
  getCognitionLoops,
  getCognitionPulse,
  getCognitionNotes,
  getCognitionRetiredLoops,
  getCognitionRun,
  getCognitionRunKinds,
  getCognitionRuns,
  getCognitionCoverage,
  getCognitionSpend,
  getCognitionMechanismSpend,
  getStatus,
  getCognitionTranscript,
} from "../api.js";
import { DevAnnotateButton } from "../components/dev-annotate-button.js";
import { CalibrationTab } from "./cognition-calibration.js";
import { BootstrapTab } from "./cognition-bootstrap.js";
import { CalendarTab } from "./cognition-calendar.js";

// Developer mode for this page, mirrored from `CognitionView`'s `developer`
// prop so the per-item ⚑ annotate buttons in the detail panes and rows don't
// need prop-drilling through every tab. Set once at the top of each
// `CognitionView` render (synchronous, before children render); only ever true
// when the gateway runs with OMNESIS_DEV_MODE.
let pageDevMode = false;

/**
 * A per-item developer-annotation ⚑ for one cognition entity, or nothing when
 * not in developer mode. `target` is `{ targetType, targetId?, label? }`.
 */
function annotate(target) {
  return pageDevMode ? html`<${DevAnnotateButton} target=${target} developer=${true} />` : null;
}

const SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "loops", label: "Loops" },
  { key: "runs", label: "Runs" },
  { key: "briefs", label: "Briefs" },
  { key: "calendar", label: "Calendar" },
  { key: "memory", label: "Memory" },
  { key: "calibration", label: "Calibration" },
  { key: "bootstrap", label: "Bootstrap" },
];
const VALID_SECTIONS = new Set(SECTIONS.map((s) => s.key));

/**
 * Resolve the routed sub-tab to a rail section. "scheduled" is the legacy
 * alias from when future checks had their own tab — those rows live on the
 * Runs surface now (same ids, same store), so old deep links land there.
 * Exported for tests.
 */
export function resolveSection(subTab) {
  if (subTab === "scheduled") return "runs";
  // Compatibility for deep links from both annotation-only predecessors.
  if (subTab === "time-index" || subTab === "temporal-annotations") return "calendar";
  return subTab && VALID_SECTIONS.has(subTab) ? subTab : "overview";
}

function cognitionPath(section, id) {
  return id
    ? `/portal/debug/cognition/${section}/${encodeURIComponent(id)}`
    : `/portal/debug/cognition/${section}`;
}

// ── Shared bits ──────────────────────────────────────────────────────

export function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

/**
 * Compact relative time, past or future: "12s ago", "3m 20s ago",
 * "in 2h 05m", "in 3d 4h". Two units max; the absolute time belongs in the
 * tooltip. Exported for tests.
 */
export function fmtRel(iso, nowMs = Date.now()) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso);
  const diff = t - nowMs;
  const abs = Math.abs(diff);
  const s = Math.floor(abs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  let span;
  if (s < 60) span = `${s}s`;
  else if (m < 60) span = s % 60 && m < 10 ? `${m}m ${s % 60}s` : `${m}m`;
  else if (h < 24) span = m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  else span = h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  return diff < 0 ? `${span} ago` : `in ${span}`;
}

function fmt01(n) {
  return typeof n === "number" ? n.toFixed(2) : "—";
}

function fmtTokens(n) {
  if (typeof n !== "number") return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// " · 38% cached" when the day's prompt tokens include cache hits; "" before
// the split existed (or when the provider returned no cache credit).
function cacheHitLabel(spendRow) {
  const read = spendRow.cacheReadTokens ?? 0;
  if (!read || !spendRow.promptTokens) return "";
  return ` · ${Math.round((read / spendRow.promptTokens) * 100)}% cached`;
}

function Pill({ color, children }) {
  return html`<span class="debug-pill" style=${`background:${color}25; color:${color}`}>${children}</span>`;
}

function loopStateColor(state) {
  switch (state) {
    case "open": return "#86efac";
    case "snoozed": return "#fde68a";
    case "done": return "#93c5fd";
    case "dismissed": return "#cbd5e1";
    default: return "#94a3b8";
  }
}

/**
 * The queue's three stored statuses fanned out into the states an operator
 * actually distinguishes. `pending` splits on the drainer's live word and
 * the row's schedule:
 *   - running:   the drainer is executing it this instant (`run.running`);
 *   - retrying:  claimed at least once, soft-failed, waiting out back-off;
 *   - scheduled: never claimed, fire time in the future (a future check);
 *   - queued:    claimable now, waiting for the next drain tick.
 * Exported for tests.
 */
export function runDisplayStatus(run, nowMs = Date.now()) {
  if (run.status !== "pending") return run.status; // completed | failed
  if (run.running) return "running";
  const due = run.nextAttemptAt ? new Date(run.nextAttemptAt).getTime() : 0;
  if (due > nowMs) return run.attempts > 0 ? "retrying" : "scheduled";
  return "queued";
}

const RUN_STATUS_COLOR = {
  running: "#7ee787",
  queued: "#fde68a",
  scheduled: "#93c5fd",
  retrying: "#fdba74",
  completed: "#86efac",
  failed: "#fca5a5",
};

function runStatusColor(displayStatus) {
  return RUN_STATUS_COLOR[displayStatus] ?? "#94a3b8";
}

/**
 * The one timestamp a run row should lead with, per display state: when it
 * fires (scheduled/retrying), when it settled (completed/failed), when it
 * started (running) or entered the queue (queued). Exported for tests.
 */
export function runTimeLabel(run, nowMs = Date.now()) {
  switch (runDisplayStatus(run, nowMs)) {
    case "running":
      return { label: `started ${fmtRel(run.lastAttemptAt, nowMs)}`, iso: run.lastAttemptAt };
    case "scheduled":
      return { label: `fires ${fmtRel(run.nextAttemptAt, nowMs)}`, iso: run.nextAttemptAt };
    case "retrying":
      return { label: `retries ${fmtRel(run.nextAttemptAt, nowMs)}`, iso: run.nextAttemptAt };
    case "queued":
      return { label: `queued ${fmtRel(run.enqueuedAt, nowMs)}`, iso: run.enqueuedAt };
    case "failed": {
      const iso = run.completedAt ?? run.lastAttemptAt;
      return { label: `failed ${fmtRel(iso, nowMs)}`, iso };
    }
    default:
      return { label: `completed ${fmtRel(run.completedAt, nowMs)}`, iso: run.completedAt };
  }
}

function briefStateColor(state) {
  if (state === "unread") return "#86efac";
  if (state === "read") return "#93c5fd";
  if (state === "dismissed_snoozed") return "#fde68a";
  return "#cbd5e1"; // the four terminal dismissed states
}

// A clickable entity id. `kind` names the target so the link points at the
// right surface — cross-entity navigation is the whole point of this view.
function entityHref(kind, id) {
  switch (kind) {
    case "loop": return cognitionPath("loops", id);
    case "run": return cognitionPath("runs", id);
    case "brief": return cognitionPath("briefs", id);
    case "temporal-annotation": return cognitionPath("calendar", id);
    case "doc": return `/portal/doc/${encodeURIComponent(id)}`;
    case "person": return `/portal/people/${encodeURIComponent(id)}`;
    default: return "#";
  }
}

function EntityId({ kind, id }) {
  if (!id) return html`<span class="cognition-id-empty">—</span>`;
  const href = entityHref(kind, id);
  return html`<a
    class="cognition-id"
    href=${href}
    title=${`${kind}: ${id}`}
    onClick=${(e) => { e.preventDefault(); navigate(href); }}
  >${id}</a>`;
}

// A person reference rendered as its name linking to the person page. The
// backend enriches loop person refs to { id, name }; a value that resolves
// to no person (a legacy raw email) keeps name null and renders as plain
// dim text — a dead person link would 404. A plain-string ref (older
// response shape) falls back to the bare-id link.
function PersonChip({ person }) {
  if (typeof person === "string") return html`<${EntityId} kind="person" id=${person} />`;
  const id = person?.id;
  if (!id) return html`<span class="cognition-id-empty">—</span>`;
  if (!person.name) {
    return html`<span
      class="cognition-person-unresolved"
      title="matches no person entity"
    >${id}</span>`;
  }
  const href = entityHref("person", id);
  return html`<a
    class="cognition-person-chip"
    href=${href}
    title=${`person: ${id}`}
    onClick=${(e) => { e.preventDefault(); navigate(href); }}
  >${person.name}</a>`;
}

// A list of person chips. Empty renders a dash. Exported for the
// structural render test.
export function PersonList({ people }) {
  if (!people || people.length === 0) return html`<span class="cognition-id-empty">—</span>`;
  return html`<span class="cognition-idlist">
    ${people.map(
      (p) => html`<${PersonChip} key=${typeof p === "string" ? p : p.id} person=${p} />`,
    )}
  </span>`;
}

// A list of clickable ids (loops / people / …). Empty renders a dash.
function IdList({ kind, ids }) {
  if (!ids || ids.length === 0) return html`<span class="cognition-id-empty">—</span>`;
  return html`<span class="cognition-idlist">
    ${ids.map((id) => html`<${EntityId} key=${id} kind=${kind} id=${id} />`)}
  </span>`;
}

// A linked document reference rendered as its source icon + title, still
// linking to the doc page. The icon comes from the source registry via
// `sourceIconUrl` (no hardcoded per-source glyphs); a doc whose enrichment
// is missing — a deleted document, or a plain-string id — falls back to the
// bare-id link, exactly like every other id in this view.
function DocChip({ doc }) {
  const id = typeof doc === "string" ? doc : doc?.id;
  if (!id) return html`<span class="cognition-id-empty">—</span>`;
  const title = typeof doc === "string" ? null : doc?.title;
  const sourceType = typeof doc === "string" ? null : doc?.sourceType;
  if (!title) return html`<${EntityId} kind="doc" id=${id} />`;
  const href = entityHref("doc", id);
  const iconUrl = sourceType ? sourceIconUrl(sourceType) : null;
  return html`<a
    class="cognition-doc-chip"
    href=${href}
    title=${`doc: ${id}`}
    onClick=${(e) => {
      e.preventDefault();
      navigate(href);
    }}
  >
    ${iconUrl
      ? html`<img class="source-icon" src=${iconUrl} alt=${sourceType} />`
      : html`<span class="cognition-doc-icon-fallback" aria-hidden="true">📄</span>`}
    <span class="cognition-doc-chip-title">${title}</span>
  </a>`;
}

// A vertical list of document chips ([icon] title), each linking to the doc
// page. Empty renders a dash. Exported for the structural render test.
export function DocList({ docs }) {
  if (!docs || docs.length === 0) return html`<span class="cognition-id-empty">—</span>`;
  return html`<span class="cognition-doclist">
    ${docs.map(
      (doc) => html`<${DocChip} key=${typeof doc === "string" ? doc : doc.id} doc=${doc} />`,
    )}
  </span>`;
}

// The brief's asserted claims — each factual statement the card makes, with
// its basis chip, confidence, write-time verification marker, evidence
// quote, and a chip linking to the evidence document. Mirrors the
// annotation-list rendering conventions (same .meta-annotation classes),
// including hiding the verification marker when the state is null (written
// with no verifier configured — no gate ran, so there is nothing to show).
// "unverified" is informational, not a defect: it means the configured
// verifier was unavailable at write time, and brief claims are stamped at
// write time only. Empty renders a dash. Exported for the structural render
// test.
export function BriefClaimList({ claims }) {
  if (!claims || claims.length === 0) return html`<span class="cognition-id-empty">—</span>`;
  return html`<div>
    ${claims.map(
      (c) => html`
        <div class="meta-annotation" key=${c.id}>
          <div class="meta-annotation-head">
            ${c.claimBasis &&
            html`<span
              class="meta-annotation-basis"
              title="Claim basis — quoted: the evidence essentially states the claim; inferred: one deduction from the source; synthesized: assembled across sources"
              >${c.claimBasis}</span
            >`}
            ${c.verificationState &&
            html`<span
              class="meta-annotation-verify"
              title="Write-time entailment check of the evidence quote against the claim — 'unverified' means the verifier was unavailable when the claim was written (claims are checked at write time only; the quote-in-document check always ran)"
              >${c.verificationState}</span
            >`}
            <span class="meta-annotation-confidence" title="Agent confidence in this claim"
              >${Math.round(c.confidence * 100)}%</span
            >
          </div>
          <div class="meta-annotation-claim">${c.claimText}</div>
          ${c.evidenceQuote &&
          html`<div class="meta-enriched-phrase meta-annotation-quote" title=${c.evidenceQuote}>
            “${c.evidenceQuote}”
          </div>`}
          ${c.evidenceDoc && html`<${DocChip} doc=${c.evidenceDoc} />`}
        </div>
      `,
    )}
  </div>`;
}

// One labelled field row in a detail pane.
function Field({ label, children }) {
  return html`
    <div class="cognition-field">
      <div class="cognition-field-label">${label}</div>
      <div class="cognition-field-value">${children}</div>
    </div>
  `;
}

// The two-column master-detail frame shared by loops/runs/briefs.
function MasterDetail({ list, detail }) {
  return html`
    <div class="cognition-master-detail">
      <div class="cognition-list">${list}</div>
      <div class="cognition-detail">${detail}</div>
    </div>
  `;
}

function EmptyDetail({ noun }) {
  return html`<div class="cognition-detail-empty debug-empty">
    Select a ${noun} on the left to see everything about it.
  </div>`;
}

function ListRow({ section, id, selected, children }) {
  const href = cognitionPath(section, id);
  return html`
    <a
      class=${`cognition-row${selected ? " selected" : ""}`}
      href=${href}
      onClick=${(e) => { e.preventDefault(); navigate(href); }}
    >${children}</a>
  `;
}

// A generic async loader: runs `fetcher` on `deps` change, exposes
// {data, error, loading, reload}. Keeps every section's fetch boilerplate
// small. A `deps` change (a different entity selected, a filter switched)
// drops the old data and shows the loading state — stale rows must never
// masquerade as the new selection; a `reload` tick refreshes in place —
// what the pollers need so auto-refresh never blanks the pane.
function useLoader(fetcher, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const depsKey = JSON.stringify(deps);
  const lastDepsKey = useRef(depsKey);
  useEffect(() => {
    let cancelled = false;
    const depsChanged = lastDepsKey.current !== depsKey;
    lastDepsKey.current = depsKey;
    if (depsChanged || nonce === 0) {
      setData(null);
      setLoading(true);
    }
    setError(null);
    fetcher()
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.message ?? String(err));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, nonce]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

// Re-run `reload` every `ms` while the document is visible. The interval
// keeps ticking when hidden but skips the fetch, so backgrounded tabs stay
// cheap and the next visible tick catches up.
function useAutoReload(reload, ms) {
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) reload();
    }, ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms]);
}

/**
 * `suppressed` hides the raw error when something on the page already explains
 * it in words. Every one of these routes 404s while the Brain is inactive, and
 * three copies of a raw JSON body beside a notice that says "Omnesis Brain is
 * not running" teaches nothing the notice has not already said — it just makes
 * an expected state look broken.
 */
function LoadState({ loading, error, suppressed }) {
  if (error && !suppressed) {
    const detail = error instanceof Error ? error.message : String(error);
    return html`<div class="debug-error">⚠️ ${detail}</div>`;
  }
  if (loading) return html`<div class="debug-loading">Loading…</div>`;
  return null;
}

// ── Brain feature gate ─────────────────────────────────────────────
//
// Read-only `/admin/brain/*` history serves whenever the feature is
// visible, even while the Brain is inactive (no background-agent model
// assigned) — past loops, runs, briefs and notes are audit history, not
// live engine state. So each tab that reads them checks `GET /status`
// first: when the gate says inactive the tab renders its stored items
// beneath the notice below instead of hiding them; on an empty store the
// notice stands alone. Endpoint errors are always shown — with history
// served, a failure is real (the gateway itself is unreachable), never
// an expected 404.
/**
 * Read the Brain gate verdict out of a `GET /status` payload. `null` is
 * "unknown" (still loading or predates the field) — never blocked, so
 * the tab renders normally until the verdict arrives. Exported for tests.
 */
export function brainGateFromStatus(data) {
  const gate = data?.brain ?? data?.briefs ?? null;
  return { briefsGate: gate, brainBlocked: gate !== null && gate.active === false };
}

// One shared poll of the gate verdict per mounted tab on the 60s gate
// cadence, so a model removed mid-session flips the tab to the disabled
// wording without a refresh.
function useBrainGate() {
  const gate = useLoader(() => getStatus(), []);
  useAutoReload(gate.reload, 60_000);
  const { briefsGate, brainBlocked } = brainGateFromStatus(gate.data);
  return { gate, briefsGate, brainBlocked };
}

function BrainInactiveNotice({ gate }) {
  return html`<div class="cognition-gate-notice">
    <strong>Omnesis Brain is not running.</strong>
    ${gate?.reason ?? "Showing stored history below — nothing is running."}
  </div>`;
}

/**
 * Self-sufficient disabled-Brain banner: polls the gate itself and renders
 * the notice only while blocked, so list sections (and sections hosted in
 * other modules, like CalendarTab) render it with no props and no hook.
 */
export function BrainInactiveBanner() {
  const { briefsGate, brainBlocked } = useBrainGate();
  if (!brainBlocked) return null;
  return html`<${BrainInactiveNotice} gate=${briefsGate} />`;
}

// ── The pulse — one shared poll of the agent's live state ────────────
//
// The rail badges, the Overview cards, and the Runs "executing now" strip
// all read the same picture: the pending queue, the loops, the briefs.
// One poller owns that picture so the page fires three GETs per tick
// total, not three per consumer.

const PULSE_MS = 15_000;

function useCognitionPulse() {
  const { data, error, loading, reload } = useLoader(getCognitionPulse, []);
  useAutoReload(reload, PULSE_MS);
  const counts = data?.counts ?? {};
  return {
    ready: data !== null,
    error,
    loading,
    reload,
    running: data?.runningRuns ?? [],
    upcoming: data?.upcomingRuns ?? [],
    recentSettled: data?.recentSettledRuns ?? [],
    queuedCount: counts.queuedRuns ?? 0,
    upcomingCount: counts.upcomingRuns ?? 0,
    totalRunCount: counts.totalRuns ?? 0,
    openLoopCount: counts.openLoops ?? 0,
    snoozedLoopCount: counts.snoozedLoops ?? 0,
    totalLoopCount: counts.totalLoops ?? 0,
    unreadBriefCount: counts.unreadBriefs ?? 0,
    briefsTotal: counts.totalBriefs ?? 0,
    failed24hCount: counts.failedRuns24h ?? 0,
  };
}

// ── Trigger rendering (shared by runs + overview) ────────────────────

function triggerSummary(trigger) {
  if (!trigger) return "—";
  switch (trigger.type) {
    case "data":
      return trigger.docId
        ? `data · ${trigger.docId}${trigger.event ? ` (${trigger.event})` : ""}`
        : "data · (thread)";
    case "daily-source": return `daily · ${trigger.sourceId}`;
    case "daily-mayday": return `may-day · ${trigger.date}`;
    case "daily-digest": return `morning digest · ${trigger.date}`;
    case "scheduled": return trigger.prompt;
    case "decay-check": return `decay-check · ${trigger.loopId}`;
    case "feedback": return `feedback · ${trigger.briefId}`;
    case "provenance-recheck": return `provenance re-check · ${trigger.dependentKind} ${trigger.dependentId}`;
    case "synthesis-noticing": return `noticing · ${trigger.date ?? "?"}`;
    case "synthesis-collision": return `collision judge · ${[...(trigger.loopIds ?? []), ...(trigger.temporalAnnotationIds ?? [])].length} member(s)`;
    case "synthesis-annotation-contradiction": return `contradiction judge · ${(trigger.annotationIds ?? []).length} annotation(s)`;
    case "sweep": return `sweep · ${trigger.sweepId}${trigger.date ? ` (${trigger.date})` : ""}`;
    case "bootstrap": return trigger.docId ? `bootstrap · ${trigger.docId}` : "bootstrap";
    case "verification": return `re-verify · ${(trigger.annotationIds ?? []).length} annotation(s)`;
    case "merge-adjudication": return `merge candidate · ${trigger.candidateId}`;
    case "notes-compaction": return trigger.reason ? `notes compaction · ${trigger.reason}` : "notes compaction";
    case "subscription-compile": return `watch compile · ${trigger.request}`;
    default: return "trigger unavailable";
  }
}

function TriggerDetail({ trigger }) {
  if (!trigger || trigger.type === "unknown") {
    return html`<span class="cognition-id-empty">unavailable (settled before trigger retention shipped)</span>`;
  }
  switch (trigger.type) {
    case "data":
      if (!trigger.docId) return html`thread datum (doc unknown)`;
      // The detail endpoint enriches the doc to { id, title, sourceType }
      // (source icon + title chip); a bare id degrades to the id link.
      return html`document <${DocChip} doc=${trigger.doc ?? trigger.docId} />${
        trigger.event ? html` · ${trigger.event}` : ""}${
        trigger.diff ? html` · diff +${trigger.diff.added}/-${trigger.diff.removed}` : ""}`;
    case "daily-source":
      return html`source <code>${trigger.sourceId}</code>${
        trigger.dateFrom ? html` · ${trigger.dateFrom} → ${trigger.dateTo}` : ""}`;
    case "daily-mayday":
      return html`may-day lookahead · ${trigger.date}`;
    case "daily-digest":
      return html`morning digest · ${trigger.date}`;
    case "scheduled":
      return html`scheduled prompt: <span style="white-space:pre-wrap;">${trigger.prompt}</span>`;
    case "decay-check":
      return html`decay check on loop <${EntityId} kind="loop" id=${trigger.loopId} />`;
    case "feedback":
      return html`feedback on brief <${EntityId} kind="brief" id=${trigger.briefId} />`;
    case "provenance-recheck":
      return html`provenance re-check (a consumed prior died) on ${trigger.dependentKind} <${EntityId} kind=${trigger.dependentKind} id=${trigger.dependentId} />`;
    case "synthesis-noticing":
      return html`synthesis noticing pass${trigger.date ? html` · ${trigger.date}` : ""}`;
    case "synthesis-collision":
      return html`collision judge over ${
        [...(trigger.loopIds ?? []), ...(trigger.temporalAnnotationIds ?? [])].map((id) => html`<${EntityId} kind=${(trigger.loopIds ?? []).includes(id) ? "loop" : "temporal-annotation"} id=${id} /> `)
      }`;
    case "synthesis-annotation-contradiction":
      return html`annotation-contradiction judge${trigger.store ? html` (${trigger.store} store)` : ""} over ${
        (trigger.annotationIds ?? []).map((id) => html`<code>${id}</code> `)
      }`;
    case "sweep":
      return html`scheduled sweep <code>${trigger.sweepId}</code>${trigger.date ? html` · ${trigger.date}` : ""}`;
    case "bootstrap":
      return trigger.docId
        ? html`bootstrap over document <${DocChip} doc=${trigger.doc ?? trigger.docId} />`
        : html`bootstrap pass`;
    case "verification":
      return html`re-verification${trigger.store ? html` (${trigger.store} store)` : ""} over ${
        (trigger.annotationIds ?? []).map((id) => html`<code>${id}</code> `)
      }`;
    case "notes-compaction":
      return html`notes compaction${trigger.reason ? html` · ${trigger.reason}` : ""}`;
    case "subscription-compile":
      return html`watch compilation asked for by the ${trigger.authoredBy}${
        trigger.compileOnly ? ", a preview — nothing was installed" : ""}${
        trigger.path === "single-shot" ? ", from one prompt (no tools)" : ""}${
        trigger.attempts > 1 ? html` · ${trigger.attempts} attempts` : ""} ·
        request: <span style="white-space:pre-wrap;">${trigger.request}</span>${
        trigger.replaces
          ? html` · rewrites watch <code>${trigger.replaces}</code>`
          : ""}${
        (trigger.refusalCodes ?? []).length > 0
          ? html` · refused: ${(trigger.refusalCodes ?? []).join(", ")}`
          : ""}`;
    default:
      return html`<code>${JSON.stringify(trigger)}</code>`;
  }
}

// The pulsing "executing right now" strip, pinned above the Runs list and
// on the Overview whenever the drainer has a run in flight.
function RunningNowStrip({ running }) {
  if (running.length === 0) return null;
  return html`
    <div class="cognition-running-strip">
      ${running.map((r) => {
        const href = cognitionPath("runs", r.id);
        return html`
          <a
            key=${r.id}
            class="cognition-running-strip-row"
            href=${href}
            onClick=${(e) => { e.preventDefault(); navigate(href); }}
          >
            <span class="cognition-live-dot" aria-hidden="true"></span>
            <span class="cognition-running-strip-label">Running now</span>
            <span class="cognition-running-strip-trigger">${triggerSummary(r.trigger)}</span>
            <span class="cognition-running-strip-time" title=${fmtTs(r.lastAttemptAt)}>
              started ${fmtRel(r.lastAttemptAt)}
            </span>
          </a>
        `;
      })}
    </div>
  `;
}

// ── Overview ─────────────────────────────────────────────────────────

export function StatCard({ label, value, sub, tone }) {
  return html`
    <div class="cognition-card">
      <div class="debug-card-label">${label}</div>
      <div class=${`debug-card-value${tone ? ` cognition-card-${tone}` : ""}`}>${value}</div>
      ${sub && html`<div class="cognition-card-sub">${sub}</div>`}
    </div>
  `;
}

function OverviewRunRow({ run }) {
  const status = runDisplayStatus(run);
  const time = runTimeLabel(run);
  const href = cognitionPath("runs", run.id);
  return html`
    <a
      class="cognition-mini-row"
      href=${href}
      onClick=${(e) => { e.preventDefault(); navigate(href); }}
    >
      <${Pill} color=${runStatusColor(status)}>${status}</${Pill}>
      <span class="cognition-mini-row-main">${triggerSummary(run.trigger)}</span>
      <span class="cognition-mini-row-time" title=${fmtTs(time.iso)}>${time.label}</span>
    </a>
  `;
}

// Fold per-(day, mechanism, model) spend rows into one row per mechanism
// (runs + prompt/completion token totals), biggest spender first. The gateway
// supplies each mechanism's display label; fall back to the raw id so a row
// from a build the server labels differently still renders.
export function aggregateSpendByMechanism(rows) {
  const byMechanism = new Map();
  for (const row of rows) {
    const agg = byMechanism.get(row.mechanism) ?? {
      mechanism: row.mechanism,
      label: row.mechanismLabel || row.mechanism,
      runs: 0,
      tokens: 0,
    };
    agg.runs += row.runs;
    agg.tokens += row.promptTokens + row.completionTokens;
    byMechanism.set(row.mechanism, agg);
  }
  return [...byMechanism.values()].sort((a, b) => b.tokens - a.tokens);
}

function OverviewTab({ pulse }) {
  // The pulse provides bounded recent/upcoming samples plus exact counts;
  // spend is slower-moving, so it refreshes once a minute.
  const spend = useLoader(() => getCognitionSpend({ days: 1 }), []);
  const mechanismSpend = useLoader(() => getCognitionMechanismSpend({ days: 14 }), []);
  // Per-source coverage — a tally of work done. Keep the loaded cursor pages
  // stable while the operator inspects them rather than collapsing back to
  // page one on the spend figures' refresh cadence. The heading's figure
  // counts DOCUMENTS carrying the reviewed marker corpus-wide; the table's
  // counters are per-(source, workflow) runs. The two are different units and
  // will not agree, which is why the heading says "marked".
  const coverage = useCursorPage({
    resetKey: "overview-coverage",
    pageSize: 50,
    loadPage: ({ limit, cursor }) => getCognitionCoverage({ limit, cursor }),
    selectMeta: (payload) => ({
      bootstrapProcessedDocs: payload.bootstrapProcessedDocs ?? 0,
    }),
    mergeMeta: (previous, next) => next ?? previous,
    itemKey: (row) => `${row.sourceId}:${row.workflowId}:${row.workflowVersion}`,
  });
  // The gate's own verdict. When the Brain is idle because its model cannot
  // run, that is the first thing worth saying — an "Idle" tile over a parked
  // queue reads as "nothing to do" rather than "nothing can be done".
  const { gate, briefsGate, brainBlocked } = useBrainGate();
  useAutoReload(gate.reload, 60_000);
  useAutoReload(spend.reload, 60_000);
  useAutoReload(mechanismSpend.reload, 60_000);

  const settled = pulse.recentSettled;
  const nextWake = pulse.upcoming[0] ?? null;
  const spendToday = spend.data?.items?.[0] ?? null;
  const spendByMechanism = aggregateSpendByMechanism(mechanismSpend.data?.rows ?? []);

  const agentValue = brainBlocked
    ? "Inactive"
    : pulse.running.length > 0
      ? "Running"
      : pulse.queuedCount > 0
        ? "Waking"
        : "Idle";
  const agentSub = brainBlocked
    ? "not running"
    : pulse.running.length > 0
      ? triggerSummary(pulse.running[0].trigger)
      : pulse.queuedCount > 0
        ? `${pulse.queuedCount} run${pulse.queuedCount === 1 ? "" : "s"} due now`
        : nextWake
          ? `next wake ${fmtRel(nextWake.nextAttemptAt)}`
          : "nothing scheduled";

  return html`
    <div class="cognition-overview">
      <${LoadState}
        loading=${!pulse.ready && pulse.loading}
        error=${pulse.error}
      />
      <${BrainInactiveBanner} />
      <div class="cognition-cards">
        <${StatCard}
          label="Agent"
          value=${agentValue}
          sub=${agentSub}
          tone=${pulse.running.length > 0 ? "live" : null}
        />
        <${StatCard}
          label="Queue"
          value=${pulse.queuedCount + pulse.upcomingCount}
          sub=${`${pulse.queuedCount} due · ${pulse.upcomingCount} scheduled`}
        />
        <${StatCard}
          label="Open loops"
          value=${pulse.openLoopCount}
          sub=${`${pulse.snoozedLoopCount} snoozed`}
        />
        <${StatCard}
          label="Unread briefs"
          value=${pulse.unreadBriefCount}
          sub=${`${pulse.briefsTotal} total`}
        />
        <${StatCard}
          label="Spend"
          value=${spendToday ? fmtTokens(spendToday.promptTokens + spendToday.completionTokens) : "0"}
          sub=${spendToday
            ? `${spendToday.runs} run${spendToday.runs === 1 ? "" : "s"}${cacheHitLabel(spendToday)} · ${spendToday.day}`
            : "no runs recorded"}
        />
      </div>

      <${RunningNowStrip} running=${pulse.running} />

      ${pulse.failed24hCount > 0 &&
      html`
        <div class="cognition-failed-callout">
          ⚠️ ${pulse.failed24hCount} run${pulse.failed24hCount === 1 ? "" : "s"} failed in the last 24h —${" "}
          <a
            href=${cognitionPath("runs")}
            onClick=${(e) => { e.preventDefault(); navigate(cognitionPath("runs")); }}
          >inspect</a>
        </div>
      `}

      <div class="cognition-overview-columns">
        <section>
          <h3 class="cognition-section">Recent activity</h3>
          <${LoadState} loading=${pulse.loading} error=${pulse.error} />
          ${pulse.ready && settled.length === 0
            ? html`<div class="debug-empty">No settled runs yet.</div>`
            : settled.slice(0, 10).map((r) => html`<${OverviewRunRow} key=${r.id} run=${r} />`)}
        </section>
        <section>
          <h3 class="cognition-section">Upcoming checks</h3>
          ${pulse.ready && pulse.upcoming.length === 0
            ? html`<div class="debug-empty">Nothing scheduled.</div>`
            : pulse.upcoming.slice(0, 10).map((r) => html`<${OverviewRunRow} key=${r.id} run=${r} />`)}
        </section>
      </div>

      <section>
        <h3 class="cognition-section">Spend by mechanism · last 14 recorded days</h3>
        <${LoadState} loading=${mechanismSpend.loading} error=${mechanismSpend.error} />
        ${!mechanismSpend.loading && spendByMechanism.length === 0
          ? html`<div class="debug-empty">No spend recorded.</div>`
          : html`
            <table class="debug-table">
              <thead>
                <tr><th>Mechanism</th><th class="num">Runs</th><th class="num">Tokens</th></tr>
              </thead>
              <tbody>
                ${spendByMechanism.map(
                  (m) => html`
                    <tr key=${m.mechanism}>
                      <td title=${m.mechanism}>${m.label}</td>
                      <td class="num">${m.runs}</td>
                      <td class="num">${fmtTokens(m.tokens)}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
      </section>

      <section>
        <h3 class="cognition-section">
          Source coverage
          ${coverage.meta
            ? html`<span class="cognition-section-sub">
                ${coverage.meta.bootstrapProcessedDocs} document${
                  coverage.meta.bootstrapProcessedDocs === 1 ? "" : "s"
                } marked reviewed
              </span>`
            : null}
        </h3>
        <${LoadState} loading=${coverage.loading} error=${coverage.error} />
        ${!coverage.loading && coverage.items.length === 0
          ? html`<div class="debug-empty">No source has been reviewed yet.</div>`
          : html`
            <table class="debug-table">
              <thead>
                <tr>
                  <th>Source</th><th>Workflow</th><th>Status</th>
                  <th class="num">Eligible</th><th class="num">Processed</th>
                </tr>
              </thead>
              <tbody>
                ${coverage.items.map(
                  (row) => html`
                    <tr key=${`${row.sourceId}:${row.workflowId}:${row.workflowVersion}`}>
                      <td><${SourceChip} sourceId=${row.sourceId} sourceType=${row.sourceType} /></td>
                      <td title=${row.workflowId}>${row.workflowLabel}</td>
                      <td>${row.status}</td>
                      <td class="num">${row.eligible || "—"}</td>
                      <td class="num">${row.processed}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
        <${LoadMore}
          hasMore=${coverage.hasMore}
          loading=${coverage.loadingMore}
          error=${coverage.loadMoreError}
          onLoadMore=${coverage.loadMore}
          label="Load more coverage"
        />
      </section>
    </div>
  `;
}

// A source rendered as its registry icon + id. The icon comes from
// `sourceIconUrl`, like every other source glyph in this view; a source id the
// registry cannot type renders as the bare id. Deliberately not link-coloured —
// it names a source rather than navigating to one.
function SourceChip({ sourceId, sourceType }) {
  const iconUrl = sourceType ? sourceIconUrl(sourceType) : null;
  return html`<span class="cognition-doc-chip cognition-source-chip">
    ${iconUrl
      ? html`<img class="source-icon" src=${iconUrl} alt=${sourceType} />`
      : html`<span class="cognition-doc-icon-fallback" aria-hidden="true">📄</span>`}
    <span class="cognition-doc-chip-title">${sourceId}</span>
  </span>`;
}

// ── Loops ────────────────────────────────────────────────────────────

const LOOP_FILTERS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "resolved", label: "Resolved" },
];

function loopMatchesFilter(loop, filter) {
  if (filter === "active") return loop.state === "open" || loop.state === "snoozed";
  if (filter === "resolved") return loop.state === "done" || loop.state === "dismissed";
  return true;
}

function LoopsTab({ selectedId }) {
  const [filter, setFilter] = useState("all");
  // The disabled-Brain banner below polls the gate itself.
  const page = useCursorPage({
    resetKey: filter,
    pageSize: 50,
    loadPage: ({ limit, cursor }) =>
      getCognitionLoops({
        limit,
        cursor,
        ...(filter === "all" ? {} : { state: filter }),
      }),
  });
  const loops = page.items.filter((loop) => loopMatchesFilter(loop, filter));

  const list = html`
    <div>
      ${page.items.length === 0 && !page.loading
        ? html`<div class="debug-empty" style="padding:16px;">No loops yet.</div>`
        : loops.length === 0
        ? html`<div class="debug-empty" style="padding:16px;">No ${filter} loops.</div>`
        : loops.map((l) => html`
          <${ListRow} section="loops" id=${l.id} selected=${l.id === selectedId}>
            <div class="cognition-row-top">
              <${Pill} color=${loopStateColor(l.state)}>${l.state}</${Pill}>
              <span class="cognition-row-time" title=${fmtTs(l.lastUpdate)}>${fmtRel(l.lastUpdate)}</span>
            </div>
            <div class="cognition-row-title">${l.title || "(untitled)"}</div>
          </${ListRow}>
        `)}
      <${LoadMore}
        hasMore=${page.hasMore}
        loading=${page.loadingMore}
        error=${page.loadMoreError}
        onLoadMore=${page.loadMore}
        label="Load more loops"
      />
    </div>
  `;

  return html`
    <div>
      <${BrainInactiveBanner} />
      <div class="cognition-filters">
        <${Segmented} options=${LOOP_FILTERS} value=${filter} onChange=${setFilter} />
      </div>
      <${LoadState} loading=${page.loading} error=${page.error} />
      <${MasterDetail}
        list=${list}
        detail=${selectedId ? html`<${LoopDetail} id=${selectedId} />` : html`<${EmptyDetail} noun="loop" />`}
      />
    </div>
  `;
}

function LoopDetail({ id }) {
  const { data, error, loading } = useLoader(
    () => getCognitionLoop(id, { includeChildren: false }),
    [id],
  );
  const briefPage = useCursorPage({
    resetKey: `loop-briefs:${id}`,
    pageSize: 25,
    loadPage: ({ limit, cursor }) => getCognitionLoopBriefs(id, { limit, cursor }),
  });
  const ledgerPage = useCursorPage({
    resetKey: `loop-ledger:${id}`,
    pageSize: 25,
    loadPage: ({ limit, cursor }) => getCognitionLoopLedger(id, { limit, cursor }),
    itemKey: (entry) => entry.seq,
  });
  const scheduledPage = useCursorPage({
    resetKey: `loop-scheduled:${id}`,
    pageSize: 25,
    loadPage: ({ limit, cursor }) => getCognitionLoopScheduled(id, { limit, cursor }),
  });
  if (loading || error) return html`<div style="padding:8px;"><${LoadState} loading=${loading} error=${error} /></div>`;
  const { loop, provenance } = data;
  const briefs = briefPage.items;
  const ledger = ledgerPage.items;
  const scheduledRuns = scheduledPage.items;
  return html`
    <div class="cognition-detail-body">
      <div class="cognition-detail-titlebar">
        <h2 class="cognition-detail-title">${loop.title || "(untitled)"}</h2>
        ${annotate({ targetType: "open_loop", targetId: loop.id, label: loop.title || `Loop ${loop.id}` })}
      </div>
      <div style="margin-bottom:12px;"><${Pill} color=${loopStateColor(loop.state)}>${loop.state}</${Pill}></div>
      <${Field} label="Id"><span class="cognition-mono">${loop.id}</span></${Field}>
      <${Field} label="Description">${loop.description || "—"}</${Field}>
      <${Field} label="Confidence">${fmt01(loop.confidence)}</${Field}>
      <${Field} label="Importance">${fmt01(loop.importance)}</${Field}>
      <${Field} label="Deadline">${loop.deadline ? html`<code>${JSON.stringify(loop.deadline)}</code>` : "—"}</${Field}>
      <${Field} label="Created by run"><${EntityId} kind="run" id=${loop.createdByRun} /></${Field}>
      <${Field} label="Actors"><${PersonList} people=${loop.actors} /></${Field}>
      <${Field} label="Why am I seeing this?"
        ><${ArtifactProvenance} provenance=${provenance}
      /></${Field}>
      <${Field} label="Involved"><${PersonList} people=${loop.involved} /></${Field}>
      <${Field} label="Documents"><${DocList} docs=${loop.docs} /></${Field}>
      <${Field} label="Blocked by"><${IdList} kind="loop" ids=${loop.blockedBy} /></${Field}>
      <${Field} label="Created">${fmtTs(loop.createdAt)}</${Field}>
      <${Field} label="Last update">${fmtTs(loop.lastUpdate)}</${Field}>
      <${Field} label="Last decay check">${fmtTs(loop.lastDecayCheck)}</${Field}>
      <${Field} label="Decay checks">${loop.decayCheckCount}</${Field}>

      <h3 class="cognition-section">Briefs (${briefs.length}${briefPage.isPartial ? " loaded" : ""})</h3>
      <${LoadState} loading=${briefPage.loading} error=${briefPage.error} />
      ${briefPage.loaded && briefs.length === 0
        ? html`<div class="debug-empty">No briefs attached.</div>`
        : briefs.map((b) => html`
          <div key=${b.id} class="cognition-inline-row">
            <${Pill} color=${briefStateColor(b.state)}>${b.state}</${Pill}>
            <${EntityId} kind="brief" id=${b.id} />
            <span class="cognition-inline-row-sub">${b.title}</span>
          </div>
        `)}
      <${LoadMore}
        hasMore=${briefPage.hasMore}
        loading=${briefPage.loadingMore}
        error=${briefPage.loadMoreError}
        onLoadMore=${briefPage.loadMore}
        label="Load more briefs"
      />

      <h3 class="cognition-section">Scheduled checks (${scheduledRuns.length}${scheduledPage.isPartial ? " loaded" : ""})</h3>
      <${LoadState} loading=${scheduledPage.loading} error=${scheduledPage.error} />
      ${scheduledPage.loaded && scheduledRuns.length === 0
        ? html`<div class="debug-empty">None queued.</div>`
        : scheduledRuns.map((r) => html`
          <div key=${r.id} class="cognition-inline-row">
            <span class="cognition-inline-row-sub" title=${fmtTs(r.fireAt)}>fires ${fmtRel(r.fireAt)}</span>
            <${EntityId} kind="run" id=${r.id} />
          </div>
        `)}
      <${LoadMore}
        hasMore=${scheduledPage.hasMore}
        loading=${scheduledPage.loadingMore}
        error=${scheduledPage.loadMoreError}
        onLoadMore=${scheduledPage.loadMore}
        label="Load more scheduled checks"
      />

      <h3 class="cognition-section">Ledger (${ledger.length}${ledgerPage.isPartial ? " loaded" : ""})</h3>
      <${LoadState} loading=${ledgerPage.loading} error=${ledgerPage.error} />
      ${ledgerPage.loaded && ledger.length === 0
        ? html`<div class="debug-empty">No ledger entries.</div>`
        : html`<div class="cognition-ledger">
          ${ledger.map((e) => html`
            <div key=${e.seq} class="cognition-ledger-entry">
              <div class="cognition-ledger-meta">
                #${e.seq} · ${fmtTs(e.at)} · run <${EntityId} kind="run" id=${e.runId} />
              </div>
              <div class="cognition-ledger-note">${e.note}</div>
            </div>
          `)}
        </div>`}
      <${LoadMore}
        hasMore=${ledgerPage.hasMore}
        loading=${ledgerPage.loadingMore}
        error=${ledgerPage.loadMoreError}
        onLoadMore=${ledgerPage.loadMore}
        label="Load more ledger entries"
      />
    </div>
  `;
}

// ── Runs (the whole queue: running / queued / scheduled / history) ───

const RUN_VIEW_FILTERS = [
  { value: "all", label: "All" },
  { value: "upcoming", label: "Upcoming" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];
const ALL_RUN_KINDS_FILTER = { value: "all", label: "All kinds" };

/**
 * A real filter change leaves run-detail mode and returns to the runs index.
 * Clicking an already-active segment is a no-op, and the list route has
 * nothing to clear. Exported for tests.
 */
export function runFilterChangePath(selectedId, currentValue, nextValue) {
  return selectedId && currentValue !== nextValue ? cognitionPath("runs") : null;
}

/**
 * Apply one run-filter change. The setter runs before route replacement so the
 * chosen filter survives the detail-to-list render. Exported for tests.
 */
export function applyRunFilterChange(selectedId, currentValue, nextValue, setValue) {
  if (currentValue === nextValue) return false;
  setValue(nextValue);
  const path = runFilterChangePath(selectedId, currentValue, nextValue);
  if (path) replaceRoute(path);
  return true;
}

/** Build the kind control directly from the canonical server descriptors. */
export function runKindFilterOptions(definitions) {
  return [
    ALL_RUN_KINDS_FILTER,
    ...definitions.map(({ kind: value, label }) => ({ value, label })),
  ];
}

/** Explanation shown only for a concrete queue kind, never for "All kinds". */
export function RunKindDescription({ definition }) {
  if (!definition) return null;
  return html`<p class="debug-sub cognition-run-kind-description" aria-live="polite">
    <strong>${definition.label} runs.</strong> ${definition.description}
  </p>`;
}

function RunListRow({ run, selectedId, nowMs }) {
  const status = runDisplayStatus(run, nowMs);
  const time = runTimeLabel(run, nowMs);
  return html`
    <${ListRow} section="runs" id=${run.id} selected=${run.id === selectedId}>
      <div class="cognition-row-top">
        <span class="cognition-row-pills">
          ${status === "running" && html`<span class="cognition-live-dot" aria-hidden="true"></span>`}
          <${Pill} color=${runStatusColor(status)}>${status}</${Pill}>
          <span class="cognition-row-kind">${run.kind}</span>
        </span>
        <span class="cognition-row-time" title=${fmtTs(time.iso)}>${time.label}</span>
      </div>
      <div class="cognition-row-sub">${triggerSummary(run.trigger)}</div>
      ${run.usage &&
      html`<div class="cognition-row-tokens">
        ${fmtTokens(run.usage.promptTokens + run.usage.completionTokens)} tok
      </div>`}
    </${ListRow}>
  `;
}

function RunsTab({ selectedId, pulse }) {
  const [view, setView] = useState("all");
  const [kind, setKind] = useState("all");
  // The disabled-Brain banner below polls the gate itself.
  const {
    data: kindData,
    error: kindError,
    loading: kindsLoading,
  } = useLoader(getCognitionRunKinds, []);
  const kindDefinitions = kindData?.items ?? [];
  const kindFilters = runKindFilterOptions(kindDefinitions);
  const selectedKind = kindDefinitions.find((definition) => definition.kind === kind);
  const query = {};
  if (view === "completed" || view === "failed") query.status = view;
  if (view === "upcoming") {
    query.status = "pending";
    query.order = "nextAttemptAt";
  }
  if (kind !== "all") query.kind = kind;
  const page = useCursorPage({
    resetKey: `${view}:${kind}`,
    pageSize: 50,
    loadPage: ({ limit, cursor }) => getCognitionRuns({ ...query, limit, cursor }),
  });

  const nowMs = Date.now();
  // Preserve the endpoint's cursor order. Re-sorting only the loaded subset
  // would move rows above the viewport whenever a later page arrived.
  const runs = page.items;

  const list = html`
    <div>
      ${runs.length === 0 && !page.loading
        ? html`<div class="debug-empty" style="padding:16px;">No runs match.</div>`
        : runs.map(
            (r) => html`<${RunListRow} key=${r.id} run=${r} selectedId=${selectedId} nowMs=${nowMs} />`,
          )}
      <${LoadMore}
        hasMore=${page.hasMore}
        loading=${page.loadingMore}
        error=${page.loadMoreError}
        onLoadMore=${page.loadMore}
        label="Load more runs"
      />
    </div>
  `;

  return html`
    <div>
      <${BrainInactiveBanner} />
      <div class="cognition-filters">
        <${Segmented}
          options=${RUN_VIEW_FILTERS}
          value=${view}
          onChange=${(nextView) => applyRunFilterChange(selectedId, view, nextView, setView)}
        />
        <${Segmented}
          options=${kindFilters}
          value=${kind}
          onChange=${(nextKind) => applyRunFilterChange(selectedId, kind, nextKind, setKind)}
        />
      </div>
      <${RunKindDescription} definition=${selectedKind} />
      <${RunningNowStrip} running=${pulse.running} />
      <${LoadState} loading=${page.loading || kindsLoading} error=${page.error || kindError} />
      <${MasterDetail}
        list=${list}
        detail=${selectedId ? html`<${RunDetail} id=${selectedId} />` : html`<${EmptyDetail} noun="run" />`}
      />
    </div>
  `;
}

function RunDetail({ id }) {
  const { data, error, loading, reload } = useLoader(() => getCognitionRun(id), [id]);
  useAutoReload(reload, 10_000);
  if (loading || error) return html`<div style="padding:8px;"><${LoadState} loading=${loading} error=${error} /></div>`;
  const { run, transcripts } = data;
  const status = run ? runDisplayStatus(run) : null;
  return html`
    <div class="cognition-detail-body">
      <div class="cognition-detail-titlebar">
        <h2 class="cognition-detail-title">Run <span class="cognition-mono" style="font-size:16px;">${id}</span></h2>
        ${annotate({ targetType: "agent_run", targetId: id, label: run ? `${run.kind} run ${id}` : `Run ${id}` })}
      </div>
      ${run
        ? html`
          <div style="margin-bottom:12px; display:flex; align-items:center; gap:8px;">
            ${status === "running" && html`<span class="cognition-live-dot" aria-hidden="true"></span>`}
            <${Pill} color=${runStatusColor(status)}>${status}</${Pill}>
            <span style="color:var(--text-secondary);">${run.kind}</span>
          </div>
          ${run.status === "failed" && run.lastError
            ? html`<div class="debug-error" style="margin-bottom:12px;">
                ⚠️ FAILED: ${run.lastError}
                ${run.failureCode
                  ? html`<span class="agent-msg-error-codes"><code>${run.failureCode}</code></span>`
                  : null}
              </div>`
            : ""}
          <${Field} label="Triggered by"><${TriggerDetail} trigger=${run.trigger} /></${Field}>
          ${run.loopId && html`<${Field} label="Checks loop"><${EntityId} kind="loop" id=${run.loopId} /></${Field}>`}
          <${Field} label="Attempts">${run.attempts}</${Field}>
          <${Field} label="Tokens">${
            run.usage
              ? `${run.usage.promptTokens} in${
                  run.usage.cacheReadTokens ? ` (${run.usage.cacheReadTokens} cached)` : ""
                } / ${run.usage.completionTokens} out`
              : "—"}</${Field}>
          <${Field} label="Enqueued">${fmtTs(run.enqueuedAt)}</${Field}>
          ${status === "scheduled" || status === "retrying"
            ? html`<${Field} label=${status === "retrying" ? "Retries at" : "Fires at"}>
                ${fmtTs(run.nextAttemptAt)}
                <span class="cognition-dim"> (${fmtRel(run.nextAttemptAt)})</span>
              </${Field}>`
            : ""}
          <${Field} label="Last attempt">${fmtTs(run.lastAttemptAt)}</${Field}>
          <${Field} label="Completed">${fmtTs(run.completedAt)}</${Field}>
          <${Field} label="Dedupe key">${run.dedupeKey ? html`<code>${run.dedupeKey}</code>` : "—"}</${Field}>
        `
        : html`<div class="debug-empty" style="margin-bottom:12px;">The run row was pruned (retention window) — its transcript survives below.</div>`}

      <h3 class="cognition-section">Transcript${transcripts.length > 1 ? "s" : ""} (${transcripts.length})</h3>
      ${transcripts.length === 0
        ? html`<div class="debug-empty">No transcript stored for this run.</div>`
        : html`<${TranscriptViewer} key=${id} refs=${transcripts} />`}
    </div>
  `;
}

// Loads + renders the newest transcript for a run (attempt-picker if several).
// The transcript rectangle has two views, toggled just above it:
//   - Formatted (default): a readable turn-by-turn conversation, matching the
//     interactive `/portal/agent` view (thinking, tool calls, tool results,
//     assistant text — text as text, not JSON).
//   - Raw: the full-fidelity event-type + JSON-payload dump + final text.
// The mode is component state (a per-view default of Formatted; Raw is one
// click away). The attempt-picker sits above the toggle and switches attempts
// under BOTH modes.
function TranscriptViewer({ refs }) {
  const [fileName, setFileName] = useState(refs[0]?.fileName ?? null);
  const [mode, setMode] = useState("formatted");
  const { data, error, loading } = useLoader(
    () => (fileName ? getCognitionTranscript(fileName) : Promise.resolve({ transcript: null })),
    [fileName],
  );
  const t = data?.transcript;
  return html`
    <div>
      ${refs.length > 1 && html`
        <div style="margin-bottom:10px;">
          <${Segmented}
            options=${refs.map((r) => ({ value: r.fileName, label: `attempt ${r.attempt}` }))}
            value=${fileName}
            onChange=${setFileName}
          />
        </div>
      `}
      <${LoadState} loading=${loading} error=${error} />
      ${t && html`
        <div class="cognition-transcript-block">
          <div class="cognition-transcript-toolbar">
            <span class="cognition-transcript-toolbar-label">Transcript</span>
            <${Segmented}
              className="cognition-transcript-mode"
              options=${[
                { value: "formatted", label: "Formatted" },
                { value: "raw", label: "Raw" },
              ]}
              value=${mode}
              onChange=${setMode}
            />
          </div>
          <div class="cognition-transcript">
            <div class="cognition-transcript-meta">
              attempt ${t.attempt} · ${t.kind} · ${fmtTs(new Date(t.startedAt).toISOString())} → ${fmtTs(new Date(t.finishedAt).toISOString())} · ${t.outcome}
            </div>
            ${mode === "raw"
              ? html`<${RawTranscriptBody} t=${t} />`
              : html`<${FormattedTranscript} t=${t} />`}
          </div>
        </div>
      `}
    </div>
  `;
}

// Raw view — the full-fidelity event dump: one line per event (its type +
// JSON payload), then the assistant's final text. The debugging fallback.
function RawTranscriptBody({ t }) {
  return html`
    ${(t.events ?? []).length > 0 && html`
      <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:10px;">
        ${t.events.map((ev, i) => html`
          <div key=${i} class="cognition-transcript-raw-line">
            <span style="color:var(--accent);">${ev.type}</span> ${ev.payload ? JSON.stringify(ev.payload) : ""}
          </div>
        `)}
      </div>
    `}
    <div class="cognition-transcript-final-label">Final text</div>
    <div style="white-space:pre-wrap; font-size:13px;">${t.finalText || "—"}</div>
  `;
}

// A dimmed, collapsible reasoning block. The interactive view's `ThinkingBlock`
// is a live-stream affordance that renders nothing once its turn has settled,
// so a settled transcript needs its own always-showable rendering.
function TranscriptThinking({ text }) {
  return html`
    <details class="cognition-transcript-thinking" style="margin:4px 0;">
      <summary style="cursor:pointer; color:var(--text-secondary); font-size:12px;">Thinking</summary>
      <div style="white-space:pre-wrap; color:var(--text-secondary); font-size:12px; margin-top:4px; padding-left:8px; border-left:2px solid var(--border-subtle,rgba(255,255,255,0.12));">${text}</div>
    </details>
  `;
}

// Graceful degradation for any event the fold doesn't model: one dim monospace
// line carrying the event type (and a short payload preview). Visible, never
// blank — the requirement the Formatted view must honour on an unknown type.
function TranscriptUnknownPart({ type, payload }) {
  let preview = "";
  try {
    preview = payload && Object.keys(payload).length > 0 ? JSON.stringify(payload) : "";
  } catch {
    preview = "";
  }
  if (preview.length > 120) preview = preview.slice(0, 117) + "…";
  return html`
    <div class="cognition-transcript-unknown" style="font-family:var(--font-mono,monospace); font-size:11px; color:var(--text-secondary); opacity:0.7; padding:2px 0;">
      <span style="color:var(--accent);">${type}</span>${preview ? ` ${preview}` : ""}
    </div>
  `;
}

const TRANSCRIPT_NOOP = () => {};

// One folded turn, rendered in the interactive agent's chat-bubble language.
// Text + tool parts reuse `renderPart` from the agent components at `live=false`
// (static chips — no rolling-card timers, no causality gate), so tool calls and
// results look identical to the `/portal/agent` view. Thinking and unknown
// parts are rendered here (the interactive renderer has no static counterpart).
function FormattedTurn({ turn }) {
  return html`
    <div class=${`agent-msg agent-msg-${turn.role}`}>
      <div class="agent-msg-body">
        ${turn.parts.map((part, i) => {
          if (part.kind === "thinking") {
            return html`<${TranscriptThinking} key=${i} text=${part.text} />`;
          }
          if (part.kind === "unknown") {
            return html`<${TranscriptUnknownPart} key=${i} type=${part.type} payload=${part.payload} />`;
          }
          // text + tool parts → the shared static renderer.
          return renderPart(part, i, [], TRANSCRIPT_NOOP, null, false, false, true);
        })}
        ${turn.error
          ? html`<div class="agent-msg-error">
              <span>${turn.error}</span>
              ${turn.failure?.code || turn.failure?.detail
                ? html`<span class="agent-msg-error-codes">
                    ${turn.failure.code ? html`<code>${turn.failure.code}</code>` : null}
                    ${turn.failure.detail ? html`<span>${turn.failure.detail}</span>` : null}
                  </span>`
                : null}
            </div>`
          : null}
      </div>
    </div>
  `;
}

// Formatted view — the event stream folded into readable turns. When the fold
// produced no assistant text (e.g. a tool-only run, or a backend that emitted
// only a final answer) the stored `finalText` is surfaced as a highlighted
// final-answer block so the answer is never lost.
function FormattedTranscript({ t }) {
  const turns = transcriptEventsToTurns(t.events ?? []);
  const hasText = turns.some((turn) => turn.parts.some((p) => p.kind === "text"));
  const finalText = t.finalText || "";
  const isEmpty = turns.length === 0 && !finalText;
  return html`
    <div class="cognition-transcript-formatted">
      ${isEmpty
        ? html`<div class="debug-empty">This run produced no transcript events.</div>`
        : turns.map((turn, i) => html`<${FormattedTurn} key=${i} turn=${turn} />`)}
      ${!hasText && finalText
        ? html`
          <div class="cognition-transcript-final" style="margin-top:10px;">
            <div class="cognition-transcript-final-label">Final answer</div>
            <div class="agent-msg agent-msg-assistant">
              <div class="agent-msg-body">
                <div class="agent-part-text" style="white-space:pre-wrap;">${finalText}</div>
              </div>
            </div>
          </div>`
        : null}
    </div>
  `;
}

// ── Briefs ───────────────────────────────────────────────────────────

// The eight stored states, folded into the five buckets an operator scans
// by; the precise `dismissed_*` state stays visible on each row's pill.
const BRIEF_FILTERS = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "read", label: "Read" },
  { value: "snoozed", label: "Snoozed" },
  { value: "dismissed", label: "Dismissed" },
];

/** Whether a brief belongs to a filter bucket. Exported for tests. */
export function briefMatchesFilter(brief, filter) {
  switch (filter) {
    case "unread": return brief.state === "unread";
    case "read": return brief.state === "read";
    case "snoozed": return brief.state === "dismissed_snoozed";
    case "dismissed":
      return brief.state.startsWith("dismissed_") && brief.state !== "dismissed_snoozed";
    default: return true;
  }
}

function BriefsTab({ selectedId }) {
  const [filter, setFilter] = useState("all");
  // The disabled-Brain banner below polls the gate itself.
  const page = useCursorPage({
    resetKey: filter,
    pageSize: 50,
    loadPage: ({ limit, cursor }) =>
      getCognitionBriefs({
        limit,
        cursor,
        ...(filter === "all" ? {} : { state: filter }),
      }),
  });
  const briefs = page.items.filter((brief) => briefMatchesFilter(brief, filter));

  const list = html`
    <div>
      ${page.items.length === 0 && !page.loading
        ? html`<div class="debug-empty" style="padding:16px;">No briefs yet.</div>`
        : briefs.length === 0
        ? html`<div class="debug-empty" style="padding:16px;">No briefs in this state.</div>`
        : briefs.map((b) => html`
          <${ListRow} section="briefs" id=${b.id} selected=${b.id === selectedId}>
            <div class="cognition-row-top">
              <span class="cognition-row-pills">
                <${Pill} color=${briefStateColor(b.state)}>${b.state.replace(/^dismissed_/, "")}</${Pill}>
                <span class="cognition-row-kind">${b.kind}</span>
              </span>
              <span class="cognition-row-time" title=${fmtTs(b.createdAt)}>${fmtRel(b.createdAt)}</span>
            </div>
            <div class="cognition-row-title">${b.title || "(untitled)"}</div>
          </${ListRow}>
        `)}
      <${LoadMore}
        hasMore=${page.hasMore}
        loading=${page.loadingMore}
        error=${page.loadMoreError}
        onLoadMore=${page.loadMore}
        label="Load more briefs"
      />
    </div>
  `;

  return html`
    <div>
      <${BrainInactiveBanner} />
      <div class="cognition-filters">
        <${Segmented} options=${BRIEF_FILTERS} value=${filter} onChange=${setFilter} />
      </div>
      <${LoadState} loading=${page.loading} error=${page.error} />
      <${MasterDetail}
        list=${list}
        detail=${selectedId ? html`<${BriefDetail} id=${selectedId} />` : html`<${EmptyDetail} noun="brief" />`}
      />
    </div>
  `;
}

// "Why am I seeing this?" — the procedure behind a durable artifact, named.
// A run id alone answers nothing: it is opaque, and its queue row is pruned.
// An artifact created before attribution existed reports that plainly rather
// than showing a plausible-looking guess.
export function ArtifactProvenance({ provenance }) {
  if (!provenance) return html`<span class="cognition-id-empty">—</span>`;
  const { workflow, modelId, settledAt, runId } = provenance;
  if (!workflow) {
    return html`<span class="cognition-id-empty"
      >not recorded — this predates run attribution (${runId})</span
    >`;
  }
  return html`
    <span>
      <strong>${workflow.label}</strong>
      <span class="cognition-provenance-meta">
        ${` v${workflow.version}`}${modelId ? ` · ${modelId}` : ""}${settledAt
          ? ` · ${fmtTs(settledAt)}`
          : ""}
      </span>
    </span>
  `;
}

function BriefDetail({ id }) {
  const { data, error, loading } = useLoader(() => getCognitionBrief(id), [id]);
  const [threadBusy, setThreadBusy] = useState(false);
  const [threadError, setThreadError] = useState(null);
  if (loading || error) return html`<div style="padding:8px;"><${LoadState} loading=${loading} error=${error} /></div>`;
  const { brief, feedTier, claims, provenance } = data;
  const openThread = async () => {
    setThreadBusy(true);
    setThreadError(null);
    try {
      const out = await openBriefThread(brief.id);
      navigate(`/portal/agent/${encodeURIComponent(out.conversationId)}`);
    } catch (err) {
      setThreadError(err?.message ?? String(err));
      setThreadBusy(false);
    }
  };
  return html`
    <div class="cognition-detail-body">
      <div class="cognition-detail-titlebar">
        <h2 class="cognition-detail-title">${brief.title || "(untitled)"}</h2>
        ${annotate({ targetType: "brief", targetId: brief.id, label: brief.title || `Brief ${brief.id}` })}
      </div>
      <div style="margin-bottom:12px;">
        <${Pill} color=${briefStateColor(brief.state)}>${brief.state}</${Pill}>
        <span style="color:var(--text-secondary);">${brief.kind}</span>
      </div>
      <${Field} label="Id"><span class="cognition-mono">${brief.id}</span></${Field}>
      <${Field} label="Description">${brief.description || "—"}</${Field}>
      <${Field} label="Body">${brief.body ? html`<span style="white-space:pre-wrap;">${brief.body}</span>` : "—"}</${Field}>
      <${Field} label="Citations"><${DocList} docs=${brief.citations} /></${Field}>
      <${Field} label="Asserted claims"><${BriefClaimList} claims=${claims} /></${Field}>
      <${Field} label="Why am I seeing this?"
        ><${ArtifactProvenance} provenance=${provenance}
      /></${Field}>
      <${Field} label="Related loops"><${IdList} kind="loop" ids=${brief.relatedLoopIds} /></${Field}>
      <${Field} label="Thread">
        ${brief.threadConversationId
          ? html`<a
              href=${`/portal/agent/${encodeURIComponent(brief.threadConversationId)}`}
              onClick=${(e) => {
                e.preventDefault();
                navigate(`/portal/agent/${encodeURIComponent(brief.threadConversationId)}`);
              }}
              >open conversation</a
            >`
          : html`<button class="btn" disabled=${threadBusy} onClick=${openThread}>
              ${threadBusy ? "Opening…" : "Talk to the agent about this brief"}
            </button>`}
        ${threadError && html`<div class="debug-error">${threadError}</div>`}
      </${Field}>
      <${Field} label="Created by run"><${EntityId} kind="run" id=${brief.createdByRun} /></${Field}>
      <${Field} label="Confidence">${fmt01(brief.confidence)}</${Field}>
      <${Field} label="Urgency">${fmt01(brief.urgency)}</${Field}>
      <${Field} label="Feed tier">${feedTier ? html`<code>${feedTier.label}</code> (rank ${feedTier.rank})` : "—"}</${Field}>
      <${Field} label="Event at">${fmtTs(brief.eventAt)}</${Field}>
      <${Field} label="Next show">${fmtTs(brief.nextShow)}</${Field}>
      <${Field} label="Relevant until">${fmtTs(brief.relevantUntil)}</${Field}>
      <${Field} label="User feedback">${brief.userFeedback || "—"}</${Field}>
      <${Field} label="Created">${fmtTs(brief.createdAt)}</${Field}>
      <${Field} label="Updated">${fmtTs(brief.updatedAt)}</${Field}>
    </div>
  `;
}

// ── Memory ───────────────────────────────────────────────────────────

const RETIRED_OUTCOME_COLOR = {
  done: "#86efac",
  dismissed: "#cbd5e1",
  decayed: "#fde68a",
  deleted: "#fca5a5",
};

function MemoryTab() {
  // The disabled-Brain banner below polls the gate itself.
  const notes = useLoader(() => getCognitionNotes(), []);
  const retired = useCursorPage({
    resetKey: "retired-loops",
    pageSize: 50,
    loadPage: ({ limit, cursor }) => getCognitionRetiredLoops({ limit, cursor }),
  });
  const notesText = notes.data?.content ?? "";
  const rows = retired.items;

  return html`
    <div class="cognition-memory">
      <${BrainInactiveBanner} />
      <section style="margin-bottom:24px;">
        <div class="cognition-detail-titlebar">
          <h2 class="cognition-detail-title">Agent notes</h2>
          ${annotate({ targetType: "agent_notes", label: "Agent notes" })}
        </div>
        <p class="debug-sub" style="margin:0 0 10px;">
          The durable, agent-curated notes injected into every run's prompt.
        </p>
        <${LoadState} loading=${notes.loading} error=${notes.error} />
        ${!notes.loading && !notes.error && html`
          <pre class="cognition-notes">${
            notesText.length > 0 ? notesText : "(the notes file is empty)"}</pre>
        `}
      </section>

      <section>
        <h2 class="cognition-detail-title">Consolidation store</h2>
        <p class="debug-sub" style="margin:0 0 10px;">
          The append-only <code>retired_loops</code> record — every loop the
          agent resolved or removed, with its recurrence cadence. The agent's
          learned-recurrence memory.
        </p>
        <${LoadState} loading=${retired.loading} error=${retired.error} />
        ${!retired.loading && !retired.error && (rows.length === 0
          ? html`<div class="debug-empty">No retired loops yet.</div>`
          : html`
            <table class="debug-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Outcome</th>
                  <th class="num">Recurrences</th>
                  <th class="num">Cadence (days)</th>
                  <th>Retired</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((r) => html`
                  <tr key=${r.id}>
                    <td>
                      <span class="cognition-retired-title">
                        ${r.title}
                        ${annotate({ targetType: "retired_loop", targetId: r.id, label: r.title || `Retired loop ${r.id}` })}
                      </span>
                    </td>
                    <td><${Pill} color=${RETIRED_OUTCOME_COLOR[r.outcome] ?? "#94a3b8"}>${r.outcome}</${Pill}></td>
                    <td class="num">${r.recurrenceCount}</td>
                    <td class="num">${r.cadenceDays == null ? "—" : r.cadenceDays}</td>
                    <td>${fmtTs(r.retiredAt)}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `)}
        <${LoadMore}
          hasMore=${retired.hasMore}
          loading=${retired.loadingMore}
          error=${retired.loadMoreError}
          onLoadMore=${retired.loadMore}
          label="Load more retired loops"
        />
      </section>
    </div>
  `;
}

// ── Rail + root ──────────────────────────────────────────────────────

function RailItem({ section, label, active, badge, live }) {
  const href = cognitionPath(section);
  return html`
    <a
      class=${`cognition-rail-item${active ? " active" : ""}`}
      href=${href}
      onClick=${(e) => { e.preventDefault(); navigate(href); }}
    >
      <span class="cognition-rail-label">${label}</span>
      ${live && html`<span class="cognition-live-dot" aria-hidden="true"></span>`}
      ${badge != null && badge > 0 && html`<span class="cognition-rail-badge">${badge}</span>`}
    </a>
  `;
}

/** Exact collection totals for the rail; activity subsets stay on Overview. */
export function cognitionRailBadge(pulse, key) {
  if (!pulse.ready) return { badge: null, live: false };
  switch (key) {
    case "loops":
      return { badge: pulse.totalLoopCount, live: false };
    case "runs":
      return {
        badge: pulse.totalRunCount,
        live: pulse.running.length > 0,
      };
    case "briefs":
      return { badge: pulse.briefsTotal, live: false };
    default:
      return { badge: null, live: false };
  }
}

export function CognitionView({ subTab, selectedId, developer = false } = {}) {
  // Mirror developer mode for the per-item annotate buttons rendered deep in
  // this page's detail panes (see `pageDevMode` / `annotate`). Synchronous,
  // before children render.
  pageDevMode = developer;
  const section = resolveSection(subTab);
  const pulse = useCognitionPulse();

  return html`
    <div class="cognition-view">
      <p class="debug-sub" style="margin: 0 0 16px;">
        Read-only inspector for the Cognition Steward's cognitive state — what it is
        doing right now, its open loops, the run queue (including future
        checks), briefs, the calendar, and memory. Nothing here mutates; every id links to
        the entity it references.
      </p>
      <div class="cognition-layout">
        <nav class="cognition-rail">
          ${SECTIONS.map((s) => {
            const { badge, live } = cognitionRailBadge(pulse, s.key);
            return html`<${RailItem}
              key=${s.key}
              section=${s.key}
              label=${s.label}
              active=${section === s.key}
              badge=${badge}
              live=${live}
            />`;
          })}
        </nav>
        <div class="cognition-content">
          ${section === "overview" && html`<${OverviewTab} pulse=${pulse} />`}
          ${section === "loops" && html`<${LoopsTab} selectedId=${selectedId} />`}
          ${section === "runs" && html`<${RunsTab} selectedId=${selectedId} pulse=${pulse} />`}
          ${section === "briefs" && html`<${BriefsTab} selectedId=${selectedId} />`}
          ${section === "calendar" && html`<${CalendarTab}
            selectedId=${selectedId}
            developer=${developer}
          />`}
          ${section === "memory" && html`<${MemoryTab} />`}
          ${section === "calibration" && html`<${CalibrationTab} />`}
          ${section === "bootstrap" && html`<${BootstrapTab} />`}
        </div>
      </div>
    </div>
  `;
}

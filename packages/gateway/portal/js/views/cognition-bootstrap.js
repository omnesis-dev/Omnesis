// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Bootstrap — the retrospective lane's own panel on the Cognition debug page.
//
// The lane reviews PAST documents that still carry a future-dated semantic
// time, seeding temporal annotations and open loops from history. It keeps its
// whole lifecycle in engine state, and until this panel none of it reached a
// surface: an install could sit parked with a backlog it would never touch and
// the only evidence was a log line printed once.
//
// Two loaders on purpose, because the two halves cost different amounts. The
// status is key reads and indexed counts — polled while the tab is visible.
// The backlog is a corpus scan measured in seconds: the page opens on whatever
// snapshot the gateway already holds, so viewing this panel is never itself
// what triggers a scan, and the figure always carries when it was taken.
//
// Strictly read-only. Nothing here changes a knob; every actionable sentence
// names the config key for the operator to change themselves.
//
// Self-contained module (own loaders) so its host, cognition.js, carries only
// an import and a mount line.

import { html } from "htm/preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  getCognitionBootstrap,
  getCognitionBootstrapBacklog,
  getCognitionBootstrapTimeline,
  getCognitionBudget,
  getStatus,
  patchAdminConfig,
  startCognitionBootstrap,
} from "../api.js";
import { TimelineHero } from "./cognition-timeline.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import { StatCard, fmtRel, fmtTs } from "./cognition.js";

// ── Pure helpers (exported for tests) ────────────────────────────────

/** Colour for a lane state, from the portal's semantic tokens. */
export function stateColor(state) {
  switch (state) {
    case "running":
      return "var(--success)";
    case "parked":
      return "var(--danger)";
    case "drained":
    case "holding":
    // Deliberately quiet, on the operator's own instruction — the same tone as
    // the boot hold rather than the fault tone `parked` carries.
    case "waiting":
      return "var(--warning)";
    // Awaiting a decision, not a fault and not progress.
    case "unstarted":
      return "var(--accent)";
    default:
      return "var(--text-secondary)";
  }
}

/** Sentence-case label for a lane state. */
export function stateLabel(state) {
  const names = {
    off: "Off",
    unstarted: "Not started",
    holding: "Holding",
    waiting: "Waiting",
    running: "Running",
    drained: "Drained",
    parked: "Parked",
  };
  return names[state] ?? state;
}

/**
 * Days to work through the backlog, or null when no honest answer exists.
 *
 * A projection only means something for a lane that is actually moving. A
 * parked or switched-off lane has a pace on paper and a throughput of zero, so
 * dividing by that pace would print a confident number directly beneath a
 * banner saying the lane will never move — the exact species of misleading
 * figure this panel exists to remove.
 *
 * The lifetime backstop bounds it too: a lane owing 3,000 documents with only
 * 100 runs left before `maxRuns` parks it will not work through 3,000.
 */
export function etaDays(status, remaining) {
  if (!status || status.state !== "running") return null;
  if (typeof remaining !== "number" || remaining <= 0) return null;
  const perDay = status.settings?.maxRunsPerDay;
  if (typeof perDay !== "number" || perDay <= 0) return null;
  const headroom = status.settings.maxRuns - status.totalEnqueued;
  const reachable = Number.isFinite(headroom)
    ? Math.min(remaining, Math.max(0, headroom))
    : remaining;
  if (reachable <= 0) return null;
  return Math.ceil(reachable / perDay);
}

/** "19 days" / "1 day" / null. */
export function formatEta(days) {
  if (days === null) return null;
  return `${days.toLocaleString()} day${days === 1 ? "" : "s"}`;
}

/** Thousands-separated, or an em dash while a figure is absent. */
export function fmtCount(n) {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

/**
 * Whether the backlog figure is currently trustworthy as a denominator.
 *
 * A document that has not been date-scanned carries no extracted dates, so it
 * cannot satisfy the lane's future-date predicate and is invisible to the
 * count. While the scan is still running, previously-invisible documents keep
 * ENTERING the candidate set — so the backlog rises, and a falling number
 * against a non-zero scan queue is not progress. Saying so is the difference
 * between a number and a misleading number.
 */
export function backlogIsSettled(backlog) {
  return !!backlog && backlog.dateScanPending === 0;
}

/**
 * Whether asking again would actually recompute.
 *
 * The gateway caches the scan and serves `staleAfter` with every snapshot, so
 * the button can be honest rather than flipping to "Counting…" and handing
 * back the identical numbers it already had.
 */
export function canRecount(backlog, nowMs = Date.now()) {
  if (!backlog?.staleAfter) return true;
  const at = Date.parse(backlog.staleAfter);
  return Number.isNaN(at) ? true : nowMs >= at;
}

// ── Components ───────────────────────────────────────────────────────
//
// The sections are exported so a render test can drive each one with
// fabricated state — the populated panel is otherwise only reachable on an
// install whose Brain is actually running.

/**
 * The model backend refusing every call.
 *
 * Rendered above the lane state and in the danger tone, because it outranks
 * it: while this is up nothing executes whatever the lane's own state says,
 * and the lane state alone would read as healthy. Names the backend's own
 * error verbatim — an operator diagnosing "no credit" needs the provider's
 * words, not ours.
 */
export function ProviderOutageBanner({ status }) {
  const outage = status?.providerOutage;
  if (!outage) return null;
  return html`
    <div class="cognition-card" style="border-left: 3px solid var(--danger);">
      <div class="debug-card-label">Model backend</div>
      <div class="debug-card-value" style="color:var(--danger);">Failing</div>
      <div class="cognition-card-sub" style="margin-top:6px; line-height:1.5;">
        The brain has stopped claiming work after
        ${" "}${outage.consecutiveFailures} consecutive backend failures. It retries
        ${" "}${fmtRel(outage.openUntil)}. Nothing is lost while this lasts — runs keep their
        attempts and documents keep their place in the queue.
      </div>
      ${outage.lastError &&
      html`<div class="cognition-card-sub debug-err" style="margin-top:6px; line-height:1.5;">
        ${outage.lastError}
      </div>`}
    </div>
  `;
}

/**
 * What the Brain has spent today, against whatever ceiling is set.
 *
 * Tokens and runs, never money. No inference API the Brain talks to exposes a
 * price, so a figure in currency would be an estimate the gateway could not
 * verify — and an unverifiable number is a poor thing to stand between an
 * operator and a large spend.
 *
 * An install with no ceiling is the case worth designing for: it is the
 * default, it is invisible from the config file, and it is the state in which
 * a backfill wave runs for days. So "no ceiling" is stated outright rather
 * than rendered as a blank, and today's own figures are offered as the number
 * to set one from — the operator's own data rather than a guess of ours.
 */
/**
 * Stop or restart the lane.
 *
 * Rendered as the lane's own control rather than buried in the config editor,
 * because stopping a backfill wave is the thing an operator most urgently
 * wants when they notice one running. It writes the same
 * `brain.bootstrap.enabled` key the config editor does — one fact, one place.
 *
 * The copy states the resume semantics, because the question an operator
 * actually has before pressing it is whether stopping costs them the work
 * already done. It does not.
 */
/**
 * Begin the backfill.
 *
 * Assigning a background-agent model is a capability choice — which model does
 * the Brain use — and starting to spend for days working through history is a
 * different decision. Separating them is the whole point of the `unstarted`
 * state, and this is where the second decision is made.
 *
 * It quantifies the job before asking for it. That is only possible because
 * the backlog count and the measured throughput exist: "3,296 documents, about
 * 3 days" is a decision an operator can actually make, where "start the
 * backfill?" is not. And it says the thing worth knowing first — that adding
 * the rest of your sources before starting produces better conclusions, not
 * merely fewer of them.
 */
export function StartControl({ status, backlog, busy, onStart, disabled = false }) {
  if (!status || status.state !== "unstarted") return null;
  const remaining = backlog?.remaining;
  const days = etaDays({ ...status, state: "running" }, remaining);
  return html`
    <div class="cognition-card" style="border-left: 3px solid var(--accent);">
      <div class="debug-card-label">Reviewing your history</div>
      <div class="cognition-card-sub" style="margin-top:6px; line-height:1.55;">
        ${typeof remaining === "number"
          ? html`There are <strong>${fmtCount(remaining)}</strong> documents in your past worth
              reading${days ? html` — about ${formatEta(days)} at the configured pace` : null}.`
          : html`The Brain has not started reading your history yet.`}
      </div>
      <div class="cognition-card-sub" style="margin-top:8px; line-height:1.55;">
        Adding your main sources first gives better results: a document read before the
        conversation that already settled it can raise a loop that should never have opened.
        Sources added later are still picked up.
      </div>
      <div style="margin-top:10px;">
        <button
          class="btn-primary"
          disabled=${busy || disabled}
          title=${disabled ? "Assign a background-agent model before starting the backfill." : undefined}
          onClick=${onStart}
        >
          ${busy ? "Starting…" : "Start reading history"}
        </button>
        ${disabled
          ? html`<div class="cognition-card-sub" style="margin-top:6px;">
              Starting needs a running Brain — the lane stays as it is until one is assigned.
            </div>`
          : null}
      </div>
    </div>
  `;
}

export function PauseControl({ status, busy, error, onToggle }) {
  // A lane that has never started is offered a start, not a resume — see
  // StartControl. Two controls for the same button would be a puzzle.
  if (!status || status.state === "unstarted") return null;
  const off = status.state === "off";
  return html`
    <div class="cognition-card">
      <div class="debug-card-label">Lane control</div>
      <div style="margin-top:8px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <button
          class="btn-secondary"
          disabled=${busy}
          onClick=${() => onToggle(off)}
        >
          ${busy ? "Saving…" : off ? "Resume backfill" : "Pause backfill"}
        </button>
        <span class="debug-sub">
          ${off
            ? "Paused. Resuming picks up exactly where it stopped."
            : "Pausing stops new runs. Work already done is kept, and resuming re-reads nothing."}
        </span>
      </div>
      ${error && html`<div class="debug-err" style="margin-top:8px;">${error}</div>`}
    </div>
  `;
}

/**
 * The cached share of a day's prompt, as a percentage, or null when nothing
 * was read.
 *
 * Worth its own reading because it is the largest cost lever this workload
 * has and the one a flat token count cannot show: a cached prefix is re-read
 * at a fraction of the price of fresh input, so the same token total can cost
 * wildly different amounts depending on this number alone. A prompt change
 * that breaks the cacheable prefix shows up here as a collapse, and nowhere
 * else.
 */
export function cacheHitPercent(breakdown) {
  const rate = breakdown?.cacheHitRate;
  return typeof rate === "number" && Number.isFinite(rate) ? Math.round(rate * 100) : null;
}

export function BudgetSection({ budget }) {
  if (!budget) return null;
  const uncapped = budget.dailyTokens == null && budget.dailyRuns == null;
  return html`
    <section>
      <h3 class="cognition-section">
        Budget
        <span class="cognition-section-sub">today · ${budget.day}</span>
      </h3>
      ${budget.exhausted &&
      html`<div
        class="cognition-card"
        style="border-left: 3px solid var(--warning); margin-bottom:12px;"
      >
        <div class="debug-card-label">Paused</div>
        <div class="cognition-card-sub" style="margin-top:6px; line-height:1.5;">
          ${budget.exhausted.reason}
        </div>
      </div>`}
      <div class="cognition-stats">
        <${StatCard}
          label="Tokens today"
          value=${budget.dailyTokens == null
            ? fmtCount(budget.usedTokens)
            : `${fmtCount(budget.usedTokens)} / ${fmtCount(budget.dailyTokens)}`}
          sub=${budget.dailyTokens == null ? "no ceiling" : "brain.budget.dailyTokens"}
        />
        <${StatCard}
          label="Runs today"
          value=${budget.dailyRuns == null
            ? fmtCount(budget.usedRuns)
            : `${fmtCount(budget.usedRuns)} / ${fmtCount(budget.dailyRuns)}`}
          sub=${budget.dailyRuns == null ? "no ceiling" : "brain.budget.dailyRuns"}
        />
      </div>
      ${budget.breakdown &&
      budget.breakdown.promptTokens > 0 &&
      html`<table class="debug-table" style="margin-top:12px;">
        <tbody>
          <tr>
            <td>Read for the first time</td>
            <td class="num">${fmtCount(budget.breakdown.freshInputTokens)}</td>
            <td style="color:var(--text-secondary);">fresh input — the expensive part</td>
          </tr>
          <tr>
            <td>Re-read from cache</td>
            <td class="num">${fmtCount(budget.breakdown.cacheReadTokens)}</td>
            <td style="color:var(--text-secondary);">
              a prefix the provider already held, billed at a fraction of fresh input
              ${cacheHitPercent(budget.breakdown) !== null &&
              html` — <strong>${cacheHitPercent(budget.breakdown)}%</strong> of everything read`}
            </td>
          </tr>
          <tr>
            <td>Written</td>
            <td class="num">${fmtCount(budget.breakdown.completionTokens)}</td>
            <td style="color:var(--text-secondary);">output — usually a rounding error on this lane</td>
          </tr>
        </tbody>
      </table>
      <p class="debug-sub" style="margin: 8px 0 0;">
        The ceiling above counts every token the same, because a limit has to be predictable.
        These three do not cost the same, so a day whose cached share drops gets more expensive
        without the total moving much.
      </p>`}
      ${uncapped &&
      html`<p class="debug-sub" style="margin: 10px 0 0;">
        No ceiling is set, so background cognition works through history for as long as
        there is history left. Today's figures are what a day currently costs — set
        <code>brain.budget.dailyTokens</code> from them to bound it.
      </p>`}
    </section>
  `;
}

export function StateBanner({ status }) {
  const color = stateColor(status.state);
  return html`
    <div class="cognition-card" style=${`border-left: 3px solid ${color};`}>
      <div class="debug-card-label">Lane state</div>
      <div class="debug-card-value" style=${`color:${color};`}>${stateLabel(status.state)}</div>
      <div class="cognition-card-sub" style="margin-top:6px; line-height:1.5;">
        ${status.reason}
      </div>
    </div>
  `;
}

export function BacklogSection({ status, backlog, loading, error, onRefresh }) {
  const settled = backlogIsSettled(backlog);
  const eta = settled ? formatEta(etaDays(status, backlog?.remaining)) : null;
  const recountable = canRecount(backlog);
  return html`
    <section>
      <h3 class="cognition-section">
        Backlog
        ${backlog &&
        html`<span class="cognition-section-sub">taken ${fmtRel(backlog.computedAt)}</span>`}
      </h3>
      <p class="debug-sub" style="margin: 0 0 12px;">
        Counting what the lane still owes is a scan of the corpus, so it is a snapshot rather than
        a live figure — the gateway holds one briefly and serves it to whoever asks.
      </p>
      ${error && html`<div class="debug-error">⚠️ ${error}</div>`}
      ${loading && !backlog && html`<div class="debug-loading">Counting…</div>`}
      ${backlog &&
      html`
        <div class="cognition-cards">
          <${StatCard}
            label="Still owed"
            value=${fmtCount(backlog.remaining)}
            sub=${eta
              ? `~${eta} at ${fmtCount(status?.settings?.maxRunsPerDay)}/day`
              : "documents the lane would still buy"}
          />
          <${StatCard}
            label="Date-scanned"
            value=${fmtCount(backlog.dateScanned)}
            sub=${
              backlog.dateScanPending > 0
                ? `${fmtCount(backlog.dateScanPending)} still to scan`
                : "the scan has caught up"
            }
          />
        </div>
        ${!settled &&
        html`
          <div class="cognition-gate-notice" style="margin-top:14px;">
            <strong>This backlog is still growing.</strong> ${fmtCount(backlog.dateScanPending)}
            documents have not been scanned for dates yet. A document with no extracted dates
            cannot qualify, so it is not counted here — as the scan finishes, more documents enter
            the backlog. A falling number now is not progress.
          </div>
        `}
      `}
      <div class="cognition-backlog-actions">
        <button
          class="btn-secondary"
          onClick=${onRefresh}
          disabled=${loading || !recountable}
          title=${recountable
            ? "Run the count again"
            : "The gateway is still serving this snapshot"}
        >
          ${loading ? "Counting…" : "Recount"}
        </button>
        ${!recountable &&
        !loading &&
        html`<span class="cognition-section-sub">
          recount available ${fmtRel(backlog?.staleAfter)}
        </span>`}
      </div>
    </section>
  `;
}

/**
 * Whether the configured daily cap is above what the lane can actually reach.
 *
 * The drainer works one bootstrap run at a time, so throughput has a ceiling
 * no cap can lift — above it `maxRunsPerDay` is a number that changes nothing.
 * Judged against this install's own measured last-24h figure rather than a
 * constant, because the real ceiling depends on the model, the corpus and
 * whatever else is competing for the drainer.
 *
 * Requires a full day of evidence: a lane that started an hour ago, or that
 * spent the day parked or paused, has a low count for reasons that say nothing
 * about throughput. Only claims the cap is inert when the lane was demonstrably
 * trying — it enqueued its full allowance — and still fell well short.
 */
export function capExceedsThroughput(status) {
  const cap = status?.settings?.maxRunsPerDay;
  const done = status?.completedLast24h;
  if (typeof cap !== "number" || typeof done !== "number") return false;
  if (status.enqueuedToday < cap) return false;
  return done > 0 && cap > done * 1.5;
}

export function PaceSection({ status }) {
  const s = status.settings;
  return html`
    <section>
      <h3 class="cognition-section">Pace</h3>
      <table class="debug-table">
        <tbody>
          <tr>
            <td>Enqueued today</td>
            <td class="num">${fmtCount(status.enqueuedToday)} / ${fmtCount(s.maxRunsPerDay)}</td>
            <td style="color:var(--text-secondary);">
              <code>brain.bootstrap.maxRunsPerDay</code> — the lane's pace, and its spend ceiling
            </td>
          </tr>
          ${status.blockedByHigherPriority > 0 &&
          status.runs.pending > 0 &&
          html`<tr>
            <td>Waiting behind</td>
            <td class="num">${fmtCount(status.blockedByHigherPriority)}</td>
            <td style="color:var(--text-secondary);">
              higher-priority runs due ahead of it — reactions are always claimed first, so the
              lane receives no capacity until these clear
            </td>
          </tr>`}
          <tr>
            <td>Completed in 24h</td>
            <td class="num">${fmtCount(status.completedLast24h)}</td>
            <td style="color:var(--text-secondary);">
              what the drainer actually got through
              ${capExceedsThroughput(status) &&
              html`<span class="debug-err">
                — the cap above is higher than this lane reaches, so raising it further changes
                nothing
              </span>`}
            </td>
          </tr>
          <tr>
            <td>Enqueued ever</td>
            <td class="num">${fmtCount(status.totalEnqueued)} / ${fmtCount(s.maxRuns)}</td>
            <td style="color:var(--text-secondary);">
              <code>brain.bootstrap.maxRuns</code> — runs ever bought, never reset, including
              across source removals. A spend backstop rather than a per-corpus one: reaching it
              parks the lane until the ceiling is raised
            </td>
          </tr>
          <tr>
            <td>Queued now</td>
            <td class="num">${fmtCount(status.runs.pending)} / ${fmtCount(s.backlogTarget)}</td>
            <td style="color:var(--text-secondary);">
              <code>brain.bootstrap.backlogTarget</code> — how many runs it keeps queued ahead
            </td>
          </tr>
          <tr>
            <td>Runs settled</td>
            <td class="num">
              ${fmtCount(status.runs.completed)}${status.runs.failed > 0
                ? html` · <span class="debug-err">${fmtCount(status.runs.failed)} failed</span>`
                : ""}
            </td>
            <td style="color:var(--text-secondary);">
              a failed run's document keeps its marker and is never re-selected
            </td>
          </tr>
          <tr>
            <td>Walk order</td>
            <td>${s.direction}</td>
            <td style="color:var(--text-secondary);">
              <code>brain.bootstrap.direction</code> — recent documents' future dates are likelier
              to still matter
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  `;
}

export function BoundarySection({ status }) {
  return html`
    <section>
      <h3 class="cognition-section">Boundary and wake conditions</h3>
      <table class="debug-table">
        <tbody>
          <tr>
            <td>Recency floor</td>
            <td>${fmtTs(status.recencyFloor)}</td>
            <td style="color:var(--text-secondary);">
              a datum older than this is the retrospective lane's; anything newer belongs to the
              live waker, so no document falls between them
            </td>
          </tr>
          <tr>
            <td>Documents marked reviewed</td>
            <td class="num">${fmtCount(status.processedDocs)}</td>
            <td style="color:var(--text-secondary);">
              set once and never cleared — by selection, by a run opening a document across an arc,
              or by the live lane reasoning over it first
            </td>
          </tr>
          ${status.state === "drained" &&
          html`
            <tr>
              <td>Went quiet on</td>
              <td>${status.drainedDay ?? "—"}</td>
              <td style="color:var(--text-secondary);">
                a new local day is one of the two things that reopens the lane
              </td>
            </tr>
            <tr>
              <td>Source roster then / now</td>
              <td>
                ${status.drainedSourceWatermark === null
                  ? "not recorded"
                  : fmtTs(status.drainedSourceWatermark)}
                → ${fmtTs(status.sourceWatermark)}
              </td>
              <td style="color:var(--text-secondary);">
                a source added since is the other; the lane notices by polling this mark, so no
                code path has to remember to tell it
              </td>
            </tr>
          `}
        </tbody>
      </table>
    </section>
  `;
}

export function BootstrapTab() {
  const [gate, setGate] = useState(null);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [backlog, setBacklog] = useState(null);
  const [backlogError, setBacklogError] = useState(null);
  const [backlogLoading, setBacklogLoading] = useState(true);
  const [budget, setBudget] = useState(null);
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [timelineError, setTimelineError] = useState(null);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  // The feature gate, so a disabled Brain gets its notice rather than its
  // errors. Repolled with the status cadence so the banner tracks a model
  // assigned or removed mid-session.
  const loadGate = useCallback(() => {
    getStatus()
      .then((s) => setGate(s?.brain ?? s?.briefs ?? null))
      .catch(() => {
        /* the status route failing is its own error, surfaced by the page */
      });
  }, []);
  useEffect(() => {
    loadGate();
  }, [loadGate]);
  useVisiblePoll(loadGate, 60_000);

  // The cheap half. `useVisiblePoll` stops the timer while the tab is hidden
  // and fires on return, so coming back to the page does not show a snapshot
  // up to a tick old.
  const loadStatus = useCallback(
    () =>
      getCognitionBootstrap()
        .then((s) => {
          setStatus(s);
          setStatusError(null);
        })
        .catch((err) => setStatusError(err?.message ?? String(err))),
    [],
  );
  useVisiblePoll(loadStatus, 15_000);

  // Spend moves only when a run settles, so it shares the status cadence
  // rather than paying for a poll of its own. A failure here leaves the
  // section unrendered instead of replacing the panel: the lane's own state
  // is still worth reading when the budget read is what broke.
  const loadBudget = useCallback(
    () =>
      getCognitionBudget()
        .then(setBudget)
        .catch(() => {
          /* budget is supplementary — the panel stands without it */
        }),
    [],
  );
  useVisiblePoll(loadBudget, 15_000);

  // The hero picture. Asks for the cached snapshot first, so arriving at the
  // page never itself pays for a corpus scan; if the gateway holds nothing, it
  // computes once and the answer is then good for minutes.
  const loadTimeline = useCallback(() => {
    setTimelineLoading(true);
    return getCognitionBootstrapTimeline({ cached: 1 })
      .then((t) => (t?.pending ? getCognitionBootstrapTimeline() : t))
      .then((t) => {
        setTimeline(t?.pending ? null : t);
        setTimelineError(null);
      })
      .catch((err) => setTimelineError(err?.message ?? String(err)))
      .finally(() => setTimelineLoading(false));
  }, []);
  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline]);

  const beginBackfill = useCallback(async () => {
    setStarting(true);
    try {
      await startCognitionBootstrap();
      await loadStatus();
    } catch (err) {
      setPauseError(err?.message ?? String(err));
    } finally {
      setStarting(false);
    }
  }, [loadStatus]);

  /**
   * Stop or restart the lane.
   *
   * Writes `brain.bootstrap.enabled` rather than introducing a second kind of
   * paused state. The lane already reports `off` for a disabled lane and
   * resumes exactly where it stopped when re-enabled — the processed marker is
   * set once and never cleared, so nothing is re-bought and nothing is lost.
   * A parallel "paused" flag would be a second source of truth for the same
   * fact.
   */
  const togglePaused = useCallback(
    async (nextEnabled) => {
      setPausing(true);
      setPauseError(null);
      try {
        await patchAdminConfig({ brain: { bootstrap: { enabled: nextEnabled } } });
        await loadStatus();
      } catch (err) {
        setPauseError(err?.message ?? String(err));
      } finally {
        setPausing(false);
      }
    },
    [loadStatus],
  );

  // The expensive half. The first load asks only for what the gateway already
  // holds, so opening this panel is never itself what pays for a corpus scan;
  // an empty cache or an explicit recount is.
  const loadBacklog = useCallback((force) => {
    let cancelled = false;
    setBacklogLoading(true);
    const first = force
      ? getCognitionBootstrapBacklog()
      : getCognitionBootstrapBacklog({ cached: 1 });
    const done = first
      .then((b) => (b?.pending ? getCognitionBootstrapBacklog() : b))
      .then((b) => {
        if (cancelled) return;
        setBacklog(b?.pending ? null : b);
        setBacklogError(null);
      })
      .catch((err) => {
        if (!cancelled) setBacklogError(err?.message ?? String(err));
      })
      .finally(() => {
        if (!cancelled) setBacklogLoading(false);
      });
    done.cancel = () => {
      cancelled = true;
    };
    return done;
  }, []);

  useEffect(() => {
    const run = loadBacklog(false);
    return () => run.cancel?.();
  }, [loadBacklog]);

  // A disabled Brain hides no history: the lane status, backlog snapshot and
  // timeline below all serve from stored state, so the panel renders them
  // beneath the same "not running" notice the other Cognition sections show.
  // Only an empty store (no status yet and nothing to show) keeps the
  // notice standing alone.
  const blockedGate = gate && gate.active === false ? gate : null;
  if (!status) {
    return html`<div>
      ${blockedGate
        ? html`<div class="cognition-gate-notice">
            <strong>Omnesis Brain is not running.</strong>
            ${blockedGate.reason ?? "The retrospective lane's state is unavailable until it is."}
          </div>`
        : null}
      ${statusError
        ? html`<div class="debug-error">⚠️ ${statusError}</div>`
        : html`<div class="debug-loading">Loading…</div>`}
    </div>`;
  }

  return html`
    <div>
      ${blockedGate
        ? html`<div class="cognition-gate-notice">
            <strong>Omnesis Brain is not running.</strong>
            ${blockedGate.reason ?? "The retrospective lane's figures below are stored history."}
          </div>`
        : null}
      <p class="debug-sub" style="margin: 0 0 16px;">
        The retrospective lane reviews past documents that still carry a future-dated meaning — a
        renewal, a deadline, an expiry — seeding temporal annotations and open loops from history.
        It claims at the lowest priority, so it only ever uses capacity nothing else wants.
        Read-only: change a figure by changing its config key.
      </p>
      ${
        // A transient failure on the poll must not blank a populated panel: the
        // numbers on screen are still the last thing the gateway said, and are
        // more use than an empty page.
        statusError && html`<div class="debug-error">⚠️ ${statusError}</div>`
      }
      <${TimelineHero}
        timeline=${timeline}
        status=${status}
        loading=${timelineLoading}
        error=${timelineError}
      />
      <div class="cognition-cards" style="margin-bottom:20px;">
        <${ProviderOutageBanner} status=${status} />
        <${StateBanner} status=${status} />
        <${StartControl}
          status=${status}
          backlog=${backlog}
          busy=${starting}
          onStart=${beginBackfill}
          disabled=${blockedGate !== null}
        />
        <${PauseControl}
          status=${status}
          busy=${pausing}
          error=${pauseError}
          onToggle=${togglePaused}
        />
      </div>
      <${BacklogSection}
        status=${status}
        backlog=${backlog}
        loading=${backlogLoading}
        error=${backlogError}
        onRefresh=${() => loadBacklog(true)}
      />
      <${BudgetSection} budget=${budget} />
      <${PaceSection} status=${status} />
      <${BoundarySection} status=${status} />
    </div>
  `;
}

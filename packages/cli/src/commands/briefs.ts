// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis brain` — the operator window into the Cognition Steward
 * engine (experimental). Read-only by contract: loops and briefs are
 * mutated only by the Cognition Steward in V1, so there are no create/resolve
 * subcommands; the agent-notes wipe (`notes --wipe`) is the one
 * sanctioned operator mutation. The iOS Loops screen (over the gateway's
 * `/loops` routes) is the product read surface for open loops; this
 * command is the operator's, with the engine internals included.
 *
 * Every subcommand talks to the gateway's /admin/brain/* routes. Reads
 * serve stored history whenever the feature is visible; writes 404 unless
 * the feature is active (experimental mode on AND a background-agent
 * model assigned) — the gate check below turns that into a clear message
 * instead of a bare 404.
 */

import { defineCommand } from "citty";
import { c, gatewayFetch, gatewayJson, CliError, EXIT_USER_ERROR } from "../utils.js";
import type { RunTrigger } from "@omnesis/core";

// ── DTOs (mirrors of the /admin/brain/* response shapes) ──────────────────

interface OpenLoopDto {
  id: string;
  createdByRun: string;
  state: string;
  confidence: number;
  importance: number;
  title: string;
  description: string;
  deadline: unknown;
  actors: string[];
  involved: string[];
  docs: string[];
  blockedBy: string[];
  createdAt: string | null;
  lastUpdate: string | null;
  lastDecayCheck: string | null;
  decayCheckCount: number;
}

/**
 * A loop's linked document as the loop-detail endpoint enriches it: the id
 * resolved to its title + source type (both null for a doc that no longer
 * exists). The lightweight list endpoint still returns bare id strings.
 */
interface LoopDocRefDto {
  id: string;
  title: string | null;
  sourceType: string | null;
}

interface LoopLedgerEntryDto {
  seq: number;
  runId: string;
  at: string | null;
  note: string;
}

interface LoopBriefSummaryDto {
  id: string;
  kind: string;
  state: string;
  title: string;
  createdAt: string | null;
}

interface RunDto {
  id: string;
  kind: string;
  status: string;
  /** The drainer's live word: this run is executing right now. */
  running: boolean;
  attempts: number;
  loopId: string | null;
  dedupeKey: string | null;
  trigger: RunTrigger;
  lastError: string | null;
  enqueuedAt: string | null;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  completedAt: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  } | null;
}

interface TranscriptRefDto {
  fileName: string;
  runId: string;
  attempt: number;
  finishedAt: string | null;
}

interface TranscriptDto {
  runId: string;
  attempt: number;
  kind: string;
  payload?: unknown;
  startedAt: number;
  finishedAt: number;
  prompt: string;
  events: Array<{ type: string; payload: unknown }>;
  finalText: string;
  outcome: string;
  errorMessage?: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  } | null;
}

interface DecisionDto {
  runId: string;
  attempt: number;
  kind: string;
  finishedAt: number;
  outcome: string;
  errorMessage: string | null;
  subject: string | null;
  docId: string | null;
  actions: Array<{ tool: string; detail: string; ok: boolean }>;
  researchToolCalls: number;
  finalText: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  } | null;
}

interface SpendRowDto {
  day: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  /** Subset of promptTokens served from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Subset of promptTokens written to the cache (Anthropic-style billing). */
  cacheCreationTokens?: number;
}

/** One /admin/cognition/spend row: a (day, mechanism, model) spend bucket. */
interface CognitionSpendRowDto {
  day: string;
  mechanism: string;
  /**
   * The mechanism's display name, resolved by the gateway. Optional so a
   * client pointed at an older gateway falls back to the raw id rather than
   * rendering nothing.
   */
  mechanismLabel?: string;
  modelId: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** One /admin/cognition/calibration reliability bin. */
interface CalibrationBinDto {
  lo: number;
  hi: number;
  n: number;
  meanConfidence: number | null;
  empiricalCorrectness: number | null;
  gap: number | null;
}

/** One /admin/cognition/calibration artifact family. */
export interface CalibrationFamilyDto {
  family: string;
  total: number;
  labeled: number;
  correct: number;
  incorrect: number;
  classCounts: Record<string, number>;
  bins: CalibrationBinDto[];
  ece: number | null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Single-line rendering for multi-line agent text (final text, notes). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function positiveIntArg(raw: unknown, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(`${c.red}${flag} requires a positive integer${c.reset}`, EXIT_USER_ERROR);
  }
  return n;
}

interface BrainGate {
  active?: boolean;
  visible?: boolean;
  modelAssigned?: boolean;
}

async function brainGate(): Promise<BrainGate | null> {
  // `brain` is the current field; `briefs` is the same gate under its previous
  // name, read as a fallback so the CLI keeps working against a gateway that
  // has not been upgraded yet.
  const status = await gatewayJson<{
    brain?: BrainGate;
    briefs?: BrainGate;
  }>("/status");
  return status?.brain ?? status?.briefs ?? null;
}

/**
 * The Briefs feature gate, as the CLI sees it: `/status` advertises the
 * verdict as `briefs.{visible,modelAssigned,active}`. Reads serve stored
 * history whenever the feature is visible, so refuse only when hidden —
 * instead of surfacing a bare "Not found".
 */
export async function assertBrainVisible(): Promise<void> {
  const gate = await brainGate();
  if (gate?.visible === true) return;
  throw new CliError(
    `${c.red}Omnesis Brain is experimental and currently hidden.${c.reset}\nStart the gateway with OMNESIS_EXPERIMENTAL=1 to enable it.`,
    EXIT_USER_ERROR,
  );
}

/**
 * The write gate: /admin/brain/* mutations 404 unless the feature is
 * active, so refuse up front with the reason — which prong is off —
 * instead of surfacing a bare "Not found".
 */
export async function assertBriefsActive(): Promise<void> {
  const gate = await brainGate();
  if (gate?.active === true) return;
  const hint =
    gate?.modelAssigned === true
      ? "Start the gateway with OMNESIS_EXPERIMENTAL=1 to enable it."
      : "Start the gateway with OMNESIS_EXPERIMENTAL=1 and assign a background-agent model.";
  throw new CliError(
    `${c.red}Omnesis Brain is experimental and currently inactive.${c.reset}\n${hint}`,
    EXIT_USER_ERROR,
  );
}

/** Wrap a leaf command so its `run` is gated behind {@link assertBrainVisible}. */
function gateVisible<T extends { run?: (ctx: never) => unknown }>(cmd: T): T {
  const orig = cmd.run?.bind(cmd);
  return {
    ...cmd,
    async run(ctx: never) {
      await assertBrainVisible();
      return orig ? orig(ctx) : undefined;
    },
  };
}

function printDecision(d: DecisionDto): void {
  const when = new Date(d.finishedAt).toISOString();
  const outcome =
    d.outcome === "completed" ? `${c.green}completed${c.reset}` : `${c.red}failed${c.reset}`;
  console.log(`${when}  ${pad(d.kind, 10)} run ${d.runId} (attempt ${d.attempt})  ${outcome}`);
  if (d.subject) console.log(`  about:    ${d.subject}`);
  if (d.actions.length === 0) {
    console.log(`  actions:  ${c.dim}(none — the agent decided to do nothing)${c.reset}`);
  } else {
    console.log(
      `  actions:  ${d.actions.map((a) => (a.ok ? a.detail : `${a.detail} ${c.red}(failed)${c.reset}`)).join("; ")}`,
    );
  }
  if (d.researchToolCalls > 0) console.log(`  research: ${d.researchToolCalls} tool call(s)`);
  if (d.errorMessage) console.log(`  error:    ${c.red}${oneLine(d.errorMessage)}${c.reset}`);
  if (d.finalText) console.log(`  why:      ${truncate(oneLine(d.finalText), 300)}`);
  console.log();
}

/**
 * Compact single-line label for the `runs` table's DOC / TRIGGER column:
 * the most useful identifier per kind (the doc a `data` run reacts to,
 * the source of a daily batch, the loop of a decay check, the brief of a
 * feedback run, or a scheduled run's prompt).
 */
export function triggerLabel(t: RunTrigger): string {
  switch (t.type) {
    case "data":
      return t.docId ?? "-";
    case "daily-source":
      return t.sourceId;
    case "daily-mayday":
      return `may-day ${t.date}`;
    case "daily-digest":
      return `morning digest ${t.date}`;
    case "scheduled":
      return oneLine(t.prompt);
    case "decay-check":
      return `loop ${t.loopId}`;
    case "feedback":
      return `brief ${t.briefId}`;
    case "provenance-recheck":
      return `re-check ${t.dependentKind} ${t.dependentId}`;
    case "synthesis-noticing":
      return `noticing ${t.date ?? "?"}`;
    case "synthesis-collision":
      return `collision ${[...t.loopIds, ...(t.temporalAnnotationIds ?? [])].join(",") || "(no members)"}`;
    case "synthesis-annotation-contradiction":
      return `anno-contradiction ${t.annotationIds.join(",") || "(no members)"}`;
    case "sweep":
      return `sweep ${t.sweepId}${t.date ? ` ${t.date}` : ""}`;
    case "bootstrap":
      return t.docId ? `bootstrap ${t.docId}` : "bootstrap";
    case "verification":
      return `re-verify ${t.annotationIds.join(",") || "(no members)"}`;
    case "merge-adjudication":
      return `candidate ${t.candidateId}`;
    case "notes-compaction":
      return t.reason ? `notes compaction: ${oneLine(t.reason)}` : "notes compaction";
    case "subscription-compile":
      return `compile (${t.authoredBy}): ${oneLine(t.request)}`;
    case "unknown":
      return "-";
  }
}

/**
 * The `runs` table's SCHEDULED column: when the run acts. For a pending run
 * that is its `nextAttemptAt` — the most useful field for a debounced/scheduled
 * run (when a debounced conversation is due, when a scheduled follow-up fires).
 * For a settled (completed/failed) run it is the completion time; blank if
 * neither is set.
 */
function scheduledLabel(run: RunDto): string {
  return (run.status === "pending" ? run.nextAttemptAt : run.completedAt) ?? "-";
}

/** Per-kind decoded payload for `run <id>` — the "what will this run do" block. */
export function renderRunTrigger(t: RunTrigger): string[] {
  const out: string[] = [];
  switch (t.type) {
    case "data":
      out.push(`    doc:        ${t.docId ?? "-"}`);
      if (t.event) out.push(`    event:      ${t.event}`);
      if (t.diff) out.push(`    diff:       +${t.diff.added} / -${t.diff.removed} lines`);
      break;
    case "daily-source":
      out.push(`    source:     ${t.sourceId}`);
      if (t.dateFrom && t.dateTo) out.push(`    range:      ${t.dateFrom} → ${t.dateTo}`);
      break;
    case "daily-mayday":
      out.push(`    may-day:    ${t.date}`);
      break;
    case "daily-digest":
      out.push(`    digest:     ${t.date}`);
      break;
    case "scheduled":
      out.push(`    prompt:     ${oneLine(t.prompt)}`);
      break;
    case "decay-check":
      out.push(`    decay loop: ${t.loopId}`);
      break;
    case "feedback":
      out.push(`    brief:      ${t.briefId}`);
      if (t.snoozeUntil !== null) {
        out.push(`    snooze until: ${new Date(t.snoozeUntil).toISOString()}`);
      }
      break;
    case "provenance-recheck":
      out.push(`    re-check:   ${t.dependentKind} ${t.dependentId} (a consumed prior died)`);
      break;
    case "synthesis-noticing":
      out.push(`    noticing:   ${t.date ?? "-"}`);
      break;
    case "synthesis-collision":
      out.push(
        `    collision:  ${[...t.loopIds, ...(t.temporalAnnotationIds ?? [])].join(", ") || "(no members)"}`,
      );
      break;
    case "synthesis-annotation-contradiction":
      out.push(
        `    contradiction: ${t.annotationIds.join(", ") || "(no members)"}` +
          (t.store ? ` (${t.store} store)` : ""),
      );
      break;
    case "sweep":
      out.push(`    sweep:      ${t.sweepId}${t.date ? ` (${t.date})` : ""}`);
      break;
    case "bootstrap":
      out.push(`    bootstrap:  ${t.docId ?? "(no doc)"}`);
      break;
    case "verification":
      out.push(
        `    re-verify:  ${t.annotationIds.join(", ") || "(no members)"} (${t.store} store)`,
      );
      break;
    case "merge-adjudication":
      out.push(`    candidate:  ${t.candidateId}`);
      break;
    case "notes-compaction":
      if (t.reason) out.push(`    reason:     ${oneLine(t.reason)}`);
      break;
    case "subscription-compile":
      out.push(`    request:    ${oneLine(t.request)}`);
      out.push(`    authored:   ${t.authoredBy}`);
      // `single-shot` means the compiler answered from one prompt with no
      // corpus lookups, which is worth knowing when reading what it produced.
      out.push(`    path:       ${t.path}`);
      // A preview installed nothing, which is otherwise indistinguishable from
      // a compile whose install failed after it.
      if (t.compileOnly) out.push(`    preview:    nothing was installed`);
      // A candidate that skipped the replay never had its behaviour on this
      // install checked, which nothing else in the row would show.
      if (t.withoutBacktest) out.push(`    backtest:   skipped`);
      if (t.replaces) out.push(`    replaces:   ${t.replaces}`);
      if (t.attempts !== null) out.push(`    attempts:   ${t.attempts}`);
      if (t.refusalCodes.length > 0) {
        out.push(`    refused:    ${t.refusalCodes.join(", ")}`);
      }
      break;
    case "unknown":
      out.push(
        `    ${c.dim}(unavailable — settled before payload retention, no dedupe key)${c.reset}`,
      );
      break;
  }
  return out;
}

// ── subcommands ─────────────────────────────────────────────────────────────

const loopsCommand = defineCommand({
  meta: { name: "loops", description: "List tracked open loops" },
  args: {
    state: {
      type: "string",
      description: "Filter by state: open | snoozed | done | dismissed",
    },
    limit: { type: "string", description: "Maximum loops to return (default 100)" },
  },
  async run(ctx) {
    const params = new URLSearchParams();
    if (typeof ctx.args.state === "string" && ctx.args.state) params.set("state", ctx.args.state);
    const limit = positiveIntArg(ctx.args.limit, "--limit");
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.size > 0 ? `?${params}` : "";
    const { items } = await gatewayJson<{ items: OpenLoopDto[] }>(`/admin/brain/loops${qs}`);
    if (items.length === 0) {
      console.log("No open loops.");
      return;
    }
    console.log(
      `\n${pad("ID", 26)} ${pad("STATE", 10)} ${pad("IMP", 5)} ${pad("CONF", 5)} ${pad("UPDATED", 22)} TITLE`,
    );
    console.log("-".repeat(110));
    for (const loop of items) {
      console.log(
        `${pad(loop.id, 26)} ${pad(loop.state, 10)} ${pad(loop.importance.toFixed(2), 5)} ${pad(loop.confidence.toFixed(2), 5)} ${pad(loop.lastUpdate ?? "-", 22)} ${truncate(loop.title, 50)}`,
      );
    }
    console.log();
  },
});

const loopShowCommand = defineCommand({
  meta: { name: "loop", description: "Show one open loop in full: fields, ledger, briefs" },
  args: {
    id: { type: "positional", description: "open-loop id", required: true },
  },
  async run(ctx) {
    const id = ctx.args.id;
    if (!id) throw new CliError(`${c.red}Missing loop id${c.reset}`, EXIT_USER_ERROR);
    const { loop, ledger, briefs } = await gatewayJson<{
      loop: Omit<OpenLoopDto, "docs"> & { docs: LoopDocRefDto[] };
      ledger: LoopLedgerEntryDto[];
      briefs: LoopBriefSummaryDto[];
    }>(`/admin/brain/loops/${encodeURIComponent(id)}`);
    console.log(`\n${c.bold}${loop.title}${c.reset}  (${loop.id})`);
    console.log(`  state:        ${loop.state}`);
    console.log(`  importance:   ${loop.importance}`);
    console.log(`  confidence:   ${loop.confidence}`);
    console.log(`  created:      ${loop.createdAt ?? "-"}  (run ${loop.createdByRun})`);
    console.log(`  last update:  ${loop.lastUpdate ?? "-"}`);
    if (loop.lastDecayCheck) {
      console.log(`  decay check:  ${loop.lastDecayCheck} (kept ${loop.decayCheckCount}x)`);
    }
    if (loop.deadline !== null && loop.deadline !== undefined) {
      console.log(`  deadline:     ${JSON.stringify(loop.deadline)}`);
    }
    if (loop.description) console.log(`  description:  ${oneLine(loop.description)}`);
    if (loop.actors.length > 0) console.log(`  actors:       ${loop.actors.join(", ")}`);
    if (loop.involved.length > 0) console.log(`  involved:     ${loop.involved.join(", ")}`);
    if (loop.docs.length > 0) {
      const docLine = loop.docs
        .map((d) =>
          d.title ? `${d.title}${d.sourceType ? ` [${d.sourceType}]` : ""} (${d.id})` : d.id,
        )
        .join(", ");
      console.log(`  docs:         ${docLine}`);
    }
    if (loop.blockedBy.length > 0) console.log(`  blocked by:   ${loop.blockedBy.join(", ")}`);

    console.log(`\n  ${c.dim}ledger (oldest first):${c.reset}`);
    if (ledger.length === 0) {
      console.log(`  ${c.dim}(empty)${c.reset}`);
    } else {
      for (const entry of ledger) {
        console.log(`  ${entry.at ?? "-"}  [run ${entry.runId}] ${oneLine(entry.note)}`);
      }
    }

    console.log(`\n  ${c.dim}attached briefs:${c.reset}`);
    if (briefs.length === 0) {
      console.log(`  ${c.dim}(none)${c.reset}`);
    } else {
      for (const brief of briefs) {
        console.log(
          `  ${pad(brief.id, 26)} ${pad(brief.kind, 6)} ${pad(brief.state, 26)} ${truncate(brief.title, 40)}`,
        );
      }
    }
    console.log();
  },
});

const runsCommand = defineCommand({
  meta: { name: "runs", description: "List Cognition Steward queue runs (newest first)" },
  args: {
    kind: {
      type: "string",
      description:
        "Filter by kind: data | daily | time_based | feedback | synthesis | sweep | " +
        "bootstrap | verification | merge_adjudication | notes_compaction | subscription_compile",
    },
    status: {
      type: "string",
      description: "Filter by status: pending | completed | failed",
    },
    limit: { type: "string", description: "Maximum runs to return (default 50)" },
  },
  async run(ctx) {
    const params = new URLSearchParams();
    if (typeof ctx.args.kind === "string" && ctx.args.kind) params.set("kind", ctx.args.kind);
    if (typeof ctx.args.status === "string" && ctx.args.status) {
      params.set("status", ctx.args.status);
    }
    const limit = positiveIntArg(ctx.args.limit, "--limit");
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.size > 0 ? `?${params}` : "";
    const { items } = await gatewayJson<{ items: RunDto[] }>(`/admin/brain/runs${qs}`);
    if (items.length === 0) {
      console.log("No runs recorded.");
      return;
    }
    console.log(
      `\n${pad("ID", 40)} ${pad("KIND", 11)} ${pad("STATUS", 10)} ${pad("ATT", 4)} ${pad("ENQUEUED", 22)} ${pad("SCHEDULED", 22)} ${pad("TOKENS", 10)} DOC / TRIGGER`,
    );
    console.log("-".repeat(162));
    for (const run of items) {
      const tokens = run.usage ? `${run.usage.promptTokens}+${run.usage.completionTokens}` : "-";
      console.log(
        `${pad(truncate(run.id, 40), 40)} ${pad(run.kind, 11)} ${pad(run.running ? "running" : run.status, 10)} ${pad(run.attempts, 4)} ${pad(run.enqueuedAt ?? "-", 22)} ${pad(scheduledLabel(run), 22)} ${pad(tokens, 10)} ${truncate(triggerLabel(run.trigger), 44)}`,
      );
    }
    console.log();
  },
});

const runShowCommand = defineCommand({
  meta: { name: "run", description: "Show one queue run + its stored transcripts" },
  args: {
    id: { type: "positional", description: "run id", required: true },
  },
  async run(ctx) {
    const id = ctx.args.id;
    if (!id) throw new CliError(`${c.red}Missing run id${c.reset}`, EXIT_USER_ERROR);
    const { run, transcripts } = await gatewayJson<{
      run: RunDto | null;
      transcripts: TranscriptRefDto[];
    }>(`/admin/brain/runs/${encodeURIComponent(id)}`);
    if (run) {
      console.log(`\n${c.bold}run ${run.id}${c.reset}`);
      console.log(`  kind:         ${run.kind}`);
      console.log(`  status:       ${run.running ? "running (executing now)" : run.status}`);
      console.log(`  attempts:     ${run.attempts}`);
      if (run.dedupeKey) console.log(`  dedupe key:   ${run.dedupeKey}`);
      console.log(`  enqueued:     ${run.enqueuedAt ?? "-"}`);
      if (run.completedAt) console.log(`  completed:    ${run.completedAt}`);
      if (run.usage) {
        const cached = run.usage.cacheReadTokens ? ` (${run.usage.cacheReadTokens} cached)` : "";
        console.log(
          `  tokens:       ${run.usage.promptTokens} prompt${cached} + ${run.usage.completionTokens} completion`,
        );
      }
      if (run.lastError) console.log(`  last error:   ${c.red}${oneLine(run.lastError)}${c.reset}`);
      // The decoded payload — WHAT the run reacts to. Live for pending
      // AND settled runs (settling retains the reference-shaped payload);
      // unavailable only for legacy rows wiped before retention existed.
      console.log(`  payload:`);
      for (const line of renderRunTrigger(run.trigger)) console.log(line);
    } else {
      console.log(
        `\n${c.dim}Run row pruned (transcripts below outlive the queue's retention).${c.reset}`,
      );
    }
    console.log(`\n  ${c.dim}transcripts:${c.reset}`);
    if (transcripts.length === 0) {
      console.log(
        `  ${c.dim}(none — a run that never reached the model writes no transcript)${c.reset}`,
      );
    } else {
      for (const ref of transcripts) {
        console.log(`  attempt ${ref.attempt}  ${ref.finishedAt ?? "-"}  ${ref.fileName}`);
      }
      console.log(
        `\n  ${c.dim}full transcript: omnesis brain transcript ${id} [--attempt N]${c.reset}`,
      );
    }
    console.log();
  },
});

const transcriptCommand = defineCommand({
  meta: {
    name: "transcript",
    description: "Print one run's transcript (prompt, tool timeline, final text)",
  },
  args: {
    id: { type: "positional", description: "run id", required: true },
    attempt: { type: "string", description: "Attempt number (default: the latest)" },
    json: { type: "boolean", description: "Emit the raw transcript JSON (pipe into jq)" },
  },
  async run(ctx) {
    const id = ctx.args.id;
    if (!id) throw new CliError(`${c.red}Missing run id${c.reset}`, EXIT_USER_ERROR);
    const { items } = await gatewayJson<{ items: TranscriptRefDto[] }>(
      `/admin/brain/transcripts?runId=${encodeURIComponent(id)}`,
    );
    if (items.length === 0) {
      throw new CliError(`${c.red}No transcripts stored for run ${id}${c.reset}`, EXIT_USER_ERROR);
    }
    const attempt = positiveIntArg(ctx.args.attempt, "--attempt");
    const ref =
      attempt !== undefined
        ? items.find((r) => r.attempt === attempt)
        : items.reduce((a, b) => (b.attempt > a.attempt ? b : a));
    if (!ref) {
      throw new CliError(
        `${c.red}No attempt ${attempt} transcript for run ${id} (have: ${items.map((r) => r.attempt).join(", ")})${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const { transcript } = await gatewayJson<{ transcript: TranscriptDto }>(
      `/admin/brain/transcripts/${encodeURIComponent(ref.fileName)}`,
    );
    if (ctx.args.json) {
      console.log(JSON.stringify(transcript, null, 2));
      return;
    }
    const durationMs = transcript.finishedAt - transcript.startedAt;
    console.log(`\n${c.bold}run ${transcript.runId} attempt ${transcript.attempt}${c.reset}`);
    console.log(`  kind:      ${transcript.kind}`);
    console.log(`  outcome:   ${transcript.outcome}`);
    console.log(`  finished:  ${new Date(transcript.finishedAt).toISOString()} (${durationMs}ms)`);
    if (transcript.usage) {
      const cached = transcript.usage.cacheReadTokens
        ? ` (${transcript.usage.cacheReadTokens} cached)`
        : "";
      console.log(
        `  tokens:    ${transcript.usage.promptTokens} prompt${cached} + ${transcript.usage.completionTokens} completion`,
      );
    }
    if (transcript.errorMessage) {
      console.log(`  error:     ${c.red}${oneLine(transcript.errorMessage)}${c.reset}`);
    }
    if (transcript.payload !== undefined) {
      console.log(`  payload:   ${truncate(JSON.stringify(transcript.payload), 200)}`);
    }
    console.log(`\n${c.dim}── prompt ──${c.reset}\n${transcript.prompt}`);
    console.log(`\n${c.dim}── events ──${c.reset}`);
    for (const event of transcript.events) {
      if (event.type === "agent.tool.start") {
        const payload = event.payload as { tool?: string; args?: unknown };
        console.log(
          `  → ${payload?.tool ?? "?"} ${truncate(JSON.stringify(payload?.args ?? null), 140)}`,
        );
      } else if (event.type === "agent.tool.result") {
        const payload = event.payload as { result?: { kind?: string } };
        console.log(`  ← ${payload?.result?.kind ?? "?"}`);
      }
    }
    console.log(`\n${c.dim}── final text ──${c.reset}\n${transcript.finalText || "(none)"}\n`);
  },
});

const decisionsCommand = defineCommand({
  meta: {
    name: "decisions",
    description: "Per-datum decision view: what did the agent decide and why (newest first)",
  },
  args: {
    doc: { type: "string", description: "Only decisions about this document id" },
    limit: { type: "string", description: "Maximum decisions to return (default 20)" },
  },
  async run(ctx) {
    const params = new URLSearchParams();
    if (typeof ctx.args.doc === "string" && ctx.args.doc) params.set("doc", ctx.args.doc);
    const limit = positiveIntArg(ctx.args.limit, "--limit");
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.size > 0 ? `?${params}` : "";
    const { items } = await gatewayJson<{ items: DecisionDto[] }>(`/admin/brain/decisions${qs}`);
    if (items.length === 0) {
      console.log("No decisions recorded (no run transcripts stored yet).");
      return;
    }
    console.log();
    for (const decision of items) printDecision(decision);
  },
});

const spendCommand = defineCommand({
  meta: {
    name: "spend",
    description: "Daily Cognition Steward token spend (tracking only; no cap)",
  },
  args: {
    days: { type: "string", description: "How many days back to show (default 30)" },
    "by-mechanism": {
      type: "boolean",
      description: "Break the spend down per (day, mechanism, model) instead of day totals",
    },
  },
  async run(ctx) {
    const days = positiveIntArg(ctx.args.days, "--days");
    const qs = days !== undefined ? `?days=${days}` : "";
    if (ctx.args["by-mechanism"]) {
      // /admin/cognition/spend is deliberately NOT briefs-gated (passive
      // accounting survives the feature being off), so this branch skips
      // the gate check the day-totals branch needs.
      const { rows } = await gatewayJson<{ rows: CognitionSpendRowDto[] }>(
        `/admin/cognition/spend${qs}`,
      );
      if (rows.length === 0) {
        console.log("No spend recorded.");
        return;
      }
      console.log(
        `\n${pad("DAY", 12)} ${pad("MECHANISM", 26)} ${pad("MODEL", 28)} ${pad("RUNS", 6)} ${pad("PROMPT", 10)} ${pad("COMPLETION", 11)} TOTAL`,
      );
      console.log("-".repeat(106));
      for (const row of rows) {
        console.log(
          `${pad(row.day, 12)} ${pad(row.mechanismLabel || row.mechanism, 26)} ${pad(row.modelId || "-", 28)} ${pad(row.runs, 6)} ${pad(row.promptTokens, 10)} ${pad(row.completionTokens, 11)} ${row.promptTokens + row.completionTokens}`,
        );
      }
      console.log();
      return;
    }
    await assertBrainVisible();
    const { items } = await gatewayJson<{ items: SpendRowDto[] }>(`/admin/brain/spend${qs}`);
    if (items.length === 0) {
      console.log("No spend recorded.");
      return;
    }
    console.log(
      `\n${pad("DAY", 12)} ${pad("RUNS", 6)} ${pad("PROMPT", 10)} ${pad("CACHED", 10)} ${pad("COMPLETION", 11)} TOTAL`,
    );
    console.log("-".repeat(67));
    let totalPrompt = 0;
    let totalCached = 0;
    let totalCompletion = 0;
    for (const row of items) {
      const cached = row.cacheReadTokens ?? 0;
      totalPrompt += row.promptTokens;
      totalCached += cached;
      totalCompletion += row.completionTokens;
      console.log(
        `${pad(row.day, 12)} ${pad(row.runs, 6)} ${pad(row.promptTokens, 10)} ${pad(cached, 10)} ${pad(row.completionTokens, 11)} ${row.promptTokens + row.completionTokens}`,
      );
    }
    console.log("-".repeat(67));
    const cachedPct =
      totalPrompt > 0 && totalCached > 0
        ? ` (${Math.round((totalCached / totalPrompt) * 100)}% of prompt cached)`
        : "";
    console.log(
      `${pad("total", 12)} ${pad("", 6)} ${pad(totalPrompt, 10)} ${pad(totalCached, 10)} ${pad(totalCompletion, 11)} ${totalPrompt + totalCompletion}${cachedPct}\n`,
    );
  },
});

/**
 * Render the calibration report as terminal lines — a per-family header
 * (labeled/total + ECE), the label-class counts, and the occupied
 * reliability bins. Data-driven: renders whatever families and classes the
 * gateway reports. Exported (pure) for tests.
 */
export function renderCalibrationReport(families: CalibrationFamilyDto[]): string[] {
  const fmt2 = (v: number | null): string => (v === null ? "-" : v.toFixed(2));
  const fmtGap = (v: number | null): string =>
    v === null ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
  const lines: string[] = [""];
  for (const family of families) {
    lines.push(
      `${c.bold}${family.family}${c.reset} — ${family.labeled} labeled of ${family.total} (${family.correct} correct, ${family.incorrect} incorrect) · ECE ${fmt2(family.ece)}`,
    );
    const classes = Object.entries(family.classCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([cls, n]) => `${cls} ${n}`)
      .join(" · ");
    if (classes) lines.push(`  ${c.dim}${classes}${c.reset}`);
    const occupied = family.bins.filter((b) => b.n > 0);
    if (occupied.length === 0) {
      lines.push(`  ${c.dim}no labeled data yet${c.reset}`, "");
      continue;
    }
    lines.push(
      `  ${pad("CONF", 10)} ${pad("N", 5)} ${pad("MEAN", 6)} ${pad("EMPIRICAL", 10)} GAP`,
      `  ${"-".repeat(40)}`,
    );
    for (const bin of occupied) {
      lines.push(
        `  ${pad(`${bin.lo.toFixed(1)}-${bin.hi.toFixed(1)}`, 10)} ${pad(bin.n, 5)} ${pad(fmt2(bin.meanConfidence), 6)} ${pad(fmt2(bin.empiricalCorrectness), 10)} ${fmtGap(bin.gap)}`,
      );
    }
    lines.push("");
  }
  return lines;
}

const calibrationCommand = defineCommand({
  meta: {
    name: "calibration",
    description:
      "Confidence-calibration report over cognition artifacts (measurement only — nothing recalibrates)",
  },
  args: {
    family: {
      type: "string",
      description: "Restrict to one family (brief | doc-annotation | person-annotation)",
    },
    "since-days": {
      type: "string",
      description: "Only artifacts created in the trailing window, in days (default: all history)",
    },
  },
  async run(ctx) {
    const sinceDays = positiveIntArg(ctx.args["since-days"], "--since-days");
    const params = new URLSearchParams();
    if (typeof ctx.args.family === "string" && ctx.args.family.length > 0) {
      params.set("family", ctx.args.family);
    }
    if (sinceDays !== undefined) params.set("sinceDays", String(sinceDays));
    const qs = params.size > 0 ? `?${params}` : "";
    const { families } = await gatewayJson<{ families: CalibrationFamilyDto[] }>(
      `/admin/cognition/calibration${qs}`,
    );
    for (const line of renderCalibrationReport(families)) console.log(line);
  },
});

const notesCommand = defineCommand({
  meta: {
    name: "notes",
    description: "Print the agent-notes file (--wipe clears it — the one operator mutation)",
  },
  args: {
    wipe: { type: "boolean", description: "Wipe the notes file instead of printing it" },
  },
  async run(ctx) {
    if (ctx.args.wipe) {
      await assertBriefsActive();
      const res = await gatewayFetch("/admin/brain/notes/wipe", { method: "POST" });
      if (!res.ok) {
        throw new CliError(
          `${c.red}Notes wipe failed: ${res.status} ${await res.text()}${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      console.log(`${c.green}Agent notes wiped.${c.reset}`);
      return;
    }
    const { content } = await gatewayJson<{ content: string }>("/admin/brain/notes");
    if (!content) {
      console.log("(agent notes are empty)");
      return;
    }
    console.log(content);
  },
});

export const brainCommand = defineCommand({
  meta: {
    name: "brain",
    description:
      "Inspect the Cognition Steward: open loops, briefs, runs, transcripts, decisions, spend, calibration (operator, read-only)",
  },
  subCommands: {
    loops: gateVisible(loopsCommand),
    loop: gateVisible(loopShowCommand),
    runs: gateVisible(runsCommand),
    run: gateVisible(runShowCommand),
    transcript: gateVisible(transcriptCommand),
    decisions: gateVisible(decisionsCommand),
    // Not gateVisible-wrapped: the --by-mechanism branch reads the ungated
    // /admin/cognition/spend; the day-totals branch asserts the gate itself.
    spend: spendCommand,
    // Not gateVisible-wrapped either: /admin/cognition/calibration is a pure
    // read over the durable stores and answers even with briefs inactive.
    calibration: calibrationCommand,
    // Visible-gated for the print path; the --wipe branch asserts the
    // active gate itself before posting.
    notes: gateVisible(notesCommand),
  },
  // Default to `loops` when no subcommand is given (mirrors `triggers`;
  // `loops` carries the gate, so the bare `omnesis brain` is gated too).
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(gateVisible(loopsCommand), { rawArgs: [] });
    }
  },
});

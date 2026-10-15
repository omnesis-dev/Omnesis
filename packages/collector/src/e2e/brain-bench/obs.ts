// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `BrainObs` — the read half of the brain end-to-end kit.
 *
 * Every assertion a bench test makes goes through the production read
 * surface (`/admin/brain/*`, `/admin/cognition/*`, `/loops`, `/tasks`,
 * `/notes`, `/agent/conversations`),
 * never through a bespoke test query. Two payoffs: the assertions describe
 * what an operator can actually see, and each bench run doubles as a
 * contract test for the routes the portal and CLI depend on.
 *
 * State the HTTP surface deliberately does not expose — consumption edges,
 * engine-state markers, evidence sidecars — is read through `bench.sql` and
 * the probe helpers on `BrainBench`, so the raw-SQL surface stays in one
 * place rather than spreading across the suites.
 */

import { sleep } from "../briefs-scorecard.js";
import type { SyntheticE2EHarness } from "../synth-harness.js";

const MAX_STALE_RUN_PAGE_RETRIES = 5;

function isStalePageCursor(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const response = error as Error & { status?: unknown; body?: unknown };
  if (response.status !== 409 || typeof response.body !== "string") return false;
  try {
    const body = JSON.parse(response.body) as unknown;
    return (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      (body as { code?: unknown }).code === "STALE_PAGE_CURSOR"
    );
  } catch {
    return false;
  }
}

// ── wire shapes (the fields bench assertions actually read) ─────────────────

/** One phase's discovery outcomes for a month of the corpus. */
export interface BootstrapTimelinePhaseCounts {
  considered: number;
  gated: number;
  deferred: number;
  failed: number;
  pending: number;
  outOfScope: number;
  excluded: number;
}

export interface PulseCounts {
  queuedRuns: number;
  upcomingRuns: number;
  totalRuns: number;
  openLoops: number;
  snoozedLoops: number;
  totalLoops: number;
  /** Observations still waiting for a morning brief (`live` or `held`). */
  openObservations: number;
  totalObservations: number;
  failedRuns24h: number;
  /** Wakes the waker accepted but has not yet turned into queue rows. */
  bufferedWakes: number;
}

export interface Pulse {
  counts: PulseCounts;
  runningRuns: Array<{ id: string; kind: string }>;
  upcomingRuns: Array<{ id: string; kind: string; nextAttemptAt: string | null }>;
  recentSettledRuns: Array<{ id: string; kind: string; status: string }>;
}

export interface RunDto {
  id: string;
  kind: string;
  status: "pending" | "completed" | "failed";
  running: boolean;
  attempts: number;
  dedupeKey: string | null;
  trigger: unknown;
  lastError: string | null;
  failureCode: string | null;
  enqueuedAt: string | null;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  completedAt: string | null;
  usage: { promptTokens?: number; completionTokens?: number } | null;
  /** Context-window occupancy and the reason the run handed its work on, if it did. */
  context: {
    peakInputTokens: number | null;
    lastInputTokens: number | null;
    contextWindowTokens: number | null;
    handoffReason: string | null;
  } | null;
  /**
   * The worth gate's verdict for the run (the newest decision's), or null when
   * the gate never judged it. Served on the runs LIST only.
   */
  gateVerdict?: "pass" | "skip" | "unavailable" | null;
}

/**
 * One worth-gate judgement as `GET /admin/brain/runs/:id` serves it — the
 * exact request sent, the reply, and the verdict it produced. A reused
 * judgement carries no request of its own and names the one it repeated.
 */
export interface GateDecisionDto {
  id: string;
  purpose: string;
  lane: string;
  verdict: "pass" | "skip" | "unavailable";
  score: number | null;
  threshold: number;
  modelId: string | null;
  rubricVersion: string;
  documentId: string;
  subjectDocumentId: string;
  inheritedFromParent: boolean;
  subjectDoc: AdminDocRef | null;
  reusedFrom: string | null;
  /** The record a record-check decision judged; null for a document judgement. */
  recordId: string | null;
  /** False when the verdict was only observed (a record check in shadow mode). */
  enforced: boolean;
  error: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  createdAt: string;
  request: { model?: string; state: unknown; questions: unknown } | null;
  response: { model: string; answers: Record<string, unknown> } | null;
}

/**
 * The admin surface echoes a loop's relations as raw id lists; the product
 * surface (`/loops`) enriches them into display refs. They are different
 * shapes on purpose, so they get different types.
 */
export interface LoopDto {
  id: string;
  createdByRun: string;
  state: "open" | "snoozed" | "done" | "dismissed";
  confidence: number;
  importance: number;
  title: string;
  description: string;
  deadline: unknown;
  actors: string[];
  involved: string[];
  docs: string[];
  blockedBy: string[];
  createdAt: string;
  lastUpdate: string;
  lastDecayCheck: string | null;
  decayCheckCount: number;
}

export interface ProductLoopDto extends Omit<LoopDto, "actors" | "involved" | "blockedBy"> {
  actors: Array<{ id: string; name: string | null; isSelf: boolean }>;
  involved: Array<{ id: string; name: string | null }>;
  blockedBy: Array<{ id: string; title: string }>;
}

export interface LedgerEntry {
  seq: number;
  runId: string;
  at: string;
  note: string;
}

/** Documents are echoed as `{id,…}` refs on the admin detail routes. */
export interface AdminDocRef {
  id: string;
  title: string | null;
  sourceType: string | null;
}

/** The salience scores an observation was given (levels; null when unavailable). */
export interface ObservationScoresDto {
  consequence: number | null;
  timing: number | null;
  alreadyKnown: number | null;
  modelId: string | null;
  at: number;
}

/** One observation as `/admin/brain/observations*` serves it. */
export interface ObservationDto {
  id: string;
  createdByRun: string;
  state: "live" | "held" | "shipped" | "dropped";
  closeReason: string | null;
  summary: string;
  why: string;
  userAuthored: boolean;
  windowStart: string | null;
  relevantUntil: string | null;
  /** Raw doc ids on the list route; resolved refs on the detail route. */
  citations: string[];
  relatedLoopIds: string[];
  claims: Array<{ docId: string; quote: string; verification: string }>;
  notedScores: ObservationScoresDto | null;
  scores: ObservationScoresDto | null;
  wouldPushAt: string | null;
  shippedAt: string | null;
  shippedConversationId: string | null;
  shippedMessageId: string | null;
  userAction: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** One sent (or composed) morning brief as `/admin/brain/morning-brief` serves it. */
export interface MorningBriefDto {
  sent: {
    day: string;
    runId: string;
    conversationId: string;
    messageId: string;
    itemCount: number;
    sentAt: string;
  } | null;
  items: Array<{
    rank: number;
    observationId: string;
    runId: string;
    messageId: string | null;
    observation: ObservationDto | null;
  }>;
}

/** What one brief in the Morning brief conversation was based on, as its route serves it. */
export interface BriefDetailDto {
  day: string;
  messageId: string;
  sentAt?: string;
  items: Array<{
    rank: number;
    observationId: string;
    summary: string;
    sources: Array<{
      id: string;
      title: string | null;
      sourceType: string | null;
      createdAt: string | null;
    }>;
    tasks: Array<{ id: string; title: string; state: string }>;
  }>;
}

/** Open tasks per journal view on one day, as `/tasks/counts` and every `/tasks` view serve them. */
export interface TaskCountsDto {
  today: number;
  month: number;
  future: number;
  anytime: number;
  waiting: number;
  suggested: number;
  proposals: number;
  carried: number;
}

/** One task as `/tasks*` serves it. */
export interface TaskDto {
  id: string;
  title: string;
  description: string;
  state: "open" | "snoozed" | "done" | "dismissed";
  origin: "brain" | "note" | "user";
  accepted: boolean;
  /** A suggestion the user ignored: out of Tasks, still tracked by the Brain. */
  ignored: boolean;
  scheduledFor: string | null;
  deadline: unknown;
  dueDay: string | null;
  carried: boolean;
  completionNote: string | null;
  proposedChange: {
    kind: "complete" | "strike" | "edit";
    fields: Record<string, unknown> | null;
    reason: string;
    evidence: string[];
    proposedAt: string | null;
  } | null;
  /** The documents the task refers to that are still there to open. */
  documents: Array<{ id: string; title: string; sourceId: string }>;
  createdAt: string;
  lastUpdate: string;
  resolvedAt: string | null;
}

export interface TaskEventDto {
  seq: number;
  at: string;
  note: string;
  kind: string;
  surface: string;
  conversationId: string | null;
  from: string | null;
  to: string | null;
  /** For `auto_applied`: `complete` or `edit`. */
  change: string | null;
  /** For `auto_applied`: the documents whose quotes established the change. */
  evidence: string[];
}

/** What a task command answers: the task after the change and its undo handle. */
export interface TaskReceiptDto {
  task: TaskDto | null;
  receipt: { text: string; undoSeq: number | null };
}

/** One quick-capture note as `GET /notes` lists it, with the note agent's receipt. */
export interface ListedNoteDto {
  id: string;
  text: string;
  /** The task the note is about, when written while accepting a suggestion. */
  taskId?: string;
  transcription?: string;
  agent?: {
    state: "pending" | "running" | "done" | "failed" | "skipped";
    receipt: {
      text: string;
      changes: Array<{ text: string; taskId: string | null; undoSeq: number | null }>;
    } | null;
  };
}

/** One stored conversation as `GET /agent/conversations/:id` serves it. */
export interface ConversationDto {
  id: string;
  title?: string;
  pinned?: boolean;
  origin?: {
    kind: string;
    runId?: string;
    briefs?: Array<{ day: string; messageIndex: number; messageId: string; sentAt?: string }>;
  };
  messages: Array<{
    role: string;
    parts: Array<{ kind: string; text?: string; tool?: string; result?: unknown }>;
  }>;
}

export interface AnnotationDto {
  id: string;
  claimType: string;
  claimText: string;
  evidenceDocId: string | null;
  evidenceQuote: string | null;
  confidence: number;
  claimBasis: string;
  createdAt: string;
  /** Null when no `entailment-verifier` was configured — unverified, not unverifiable. */
  verificationState: string | null;
  lastVerifiedAt: string | null;
  dependentCount: number;
}

/**
 * One temporal annotation as `/admin/brain/time-index` serves it: the storage
 * row — `precision`, unix-ms timestamps, the revision and the link sets.
 */
export interface AdminTemporalAnnotation {
  id: string;
  intervalStartMs: number;
  intervalEndMs: number;
  precision: string;
  canonical: string | null;
  sentence: string;
  kind: string | null;
  createdByRun: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  loopIds: string[];
  personIds: string[];
  projectionIds: string[];
  documents: Array<{ id: string; title: string | null; sourceType: string | null }>;
}

/** A tool result as the transcript carries it. */
export type ToolResultView = {
  kind?: string;
  resultType?: string;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
} | null;

/** One tool call a run made, paired with the gateway's answer. */
export interface ExecutedTool {
  tool: string;
  args: Record<string, unknown>;
  result: ToolResultView;
}

/** Mirrors `CognitionDecisionAction` in `gateway/src/brain/decision-view.ts`. */
export interface DecisionAction {
  tool: string;
  detail: string;
  ok: boolean;
}

/** Mirrors `CognitionRunDecision` — the per-attempt decision summary. */
export interface DecisionDto {
  runId: string;
  attempt: number;
  kind: string;
  finishedAt: number;
  outcome: "completed" | "failed";
  errorMessage: string | null;
  failureCode: string | null;
  subject: string | null;
  docId: string | null;
  docIds?: string[];
  /** Mutating calls in order. Empty means the run decided to do nothing. */
  actions: DecisionAction[];
  researchToolCalls: number;
  finalText: string;
  usage: unknown;
}

export interface PageOf<T> {
  items: T[];
  pageInfo?: { nextCursor?: string | null; hasMore?: boolean };
}

export class BrainObs {
  constructor(private readonly h: SyntheticE2EHarness) {}

  private q(params: Record<string, string | number | boolean | undefined>): string {
    const parts = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return parts.length > 0 ? `?${parts.join("&")}` : "";
  }

  // ── gate ────────────────────────────────────────────────────────────────

  async status(): Promise<{
    brain: {
      visible: boolean;
      enabled: boolean;
      modelAssigned: boolean;
      active: boolean;
      /** Why the gate is shut, when it is. */
      reason?: string | null;
    };
    experimental: boolean;
    developer: boolean;
    tasks: { available: boolean; noteAgent: boolean };
  }> {
    return this.h.gatewayJson("/status");
  }

  /** Raw status of a route, for the inert-when-off assertions. */
  async statusOf(path: string): Promise<number> {
    const res = await this.h.gatewayFetch(path);
    return res.status;
  }

  // ── runs ────────────────────────────────────────────────────────────────

  async pulse(): Promise<Pulse> {
    return this.h.gatewayJson("/admin/brain/pulse");
  }

  async runs(
    opts: { kind?: string; status?: string; order?: string; limit?: number } = {},
  ): Promise<PageOf<RunDto>> {
    const path = `/admin/brain/runs${this.q({ limit: 200, ...opts })}`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.h.gatewayJson(path);
      } catch (error) {
        if (attempt >= MAX_STALE_RUN_PAGE_RETRIES || !isStalePageCursor(error)) throw error;
        await sleep(10);
      }
    }
  }

  async run(id: string): Promise<{
    run: RunDto;
    transcripts: Array<{ fileName: string }>;
    decisions: GateDecisionDto[];
  }> {
    return this.h.gatewayJson(`/admin/brain/runs/${id}`);
  }

  async runKinds(): Promise<{ items: Array<{ kind: string }> }> {
    return this.h.gatewayJson("/admin/brain/run-kinds");
  }

  /**
   * Pending `time_based` runs, soonest first. This route serves its OWN dto —
   * it carries `loopId`/`fireAt` and has no `dedupeKey`, so a fold-key
   * assertion belongs on `runs()` or `bench.runRow()`.
   */
  async scheduled(): Promise<
    PageOf<{
      id: string;
      kind: string;
      status: string;
      attempts: number;
      loopId: string | null;
      fireAt: string | null;
    }>
  > {
    return this.h.gatewayJson("/admin/brain/scheduled?limit=200");
  }

  /** Settled runs of one kind, newest first. */
  async settledRuns(kind: string): Promise<RunDto[]> {
    const page = await this.runs({ kind, limit: 200 });
    return page.items.filter((r) => r.status !== "pending");
  }

  // ── transcripts & decisions ─────────────────────────────────────────────

  /**
   * Transcript refs, waiting out the filesystem index rebuild the route
   * reports via `rebuilding`.
   */
  async transcripts(
    opts: { runId?: string; limit?: number } = {},
  ): Promise<PageOf<{ fileName: string; runId: string; attempt: number; finishedAt: string }>> {
    for (let i = 0; i < 40; i++) {
      const page = await this.h.gatewayJson<
        PageOf<{ fileName: string; runId: string; attempt: number; finishedAt: string }> & {
          rebuilding?: boolean;
        }
      >(`/admin/brain/transcripts${this.q({ limit: 200, ...opts })}`);
      if (!page.rebuilding) return page;
      await sleep(250);
    }
    throw new Error("transcript index never finished rebuilding");
  }

  async transcript(fileName: string): Promise<{
    transcript: {
      runId: string;
      attempt: number;
      kind: string;
      prompt: string;
      events: Array<{ type: string; payload: unknown }>;
      finalText: string;
      outcome: string;
      failureCode?: string;
      usage: unknown;
    };
  }> {
    return this.h.gatewayJson(`/admin/brain/transcripts/${encodeURIComponent(fileName)}`);
  }

  /** The full prompt text a run was given (its latest attempt). */
  async promptFor(runId: string): Promise<string> {
    const refs = await this.transcripts({ runId });
    const last = refs.items.at(-1);
    if (!last) throw new Error(`no transcript for run ${runId}`);
    const { transcript } = await this.transcript(last.fileName);
    return transcript.prompt;
  }

  /**
   * The tool calls a run made, paired with what the gateway ANSWERED.
   *
   * This is the only way to observe two things that leave no row behind: a
   * structured refusal (`*.conflict_candidates`,
   * `temporal_annotation.overlap_candidates`) and an authority denial — a tool withheld from a
   * run's toolset comes back `unknown_tool` and is otherwise invisible.
   * `puppetCalls` records only what the puppet EMITTED; the answers live in the
   * transcript's event stream.
   */
  async executedTools(runId: string, attempt?: number): Promise<ExecutedTool[]> {
    const refs = await this.transcripts({ runId });
    const steps: ExecutedTool[] = [];
    for (const entry of refs.items) {
      if (attempt !== undefined && entry.attempt !== attempt) continue;
      const { transcript } = await this.transcript(entry.fileName);
      const indexByCallId = new Map<string, number>();
      for (const event of transcript.events) {
        if (event.type === "agent.tool.start") {
          const p = event.payload as {
            toolCallId?: string;
            tool?: string;
            args?: Record<string, unknown>;
          };
          const i = steps.push({ tool: p.tool ?? "", args: p.args ?? {}, result: null }) - 1;
          if (p.toolCallId) indexByCallId.set(p.toolCallId, i);
        } else if (event.type === "agent.tool.result") {
          const p = event.payload as { toolCallId?: string; result?: ToolResultView };
          const i = p.toolCallId ? indexByCallId.get(p.toolCallId) : undefined;
          if (i !== undefined) steps[i]!.result = p.result ?? null;
        }
      }
    }
    return steps;
  }

  /** A legacy datum run only. Maintenance tests use runsForSource instead. */
  async runForDoc(docId: string): Promise<RunDto> {
    const page = await this.runs({ kind: "data", limit: 200 });
    const run = page.items.find((r) => r.dedupeKey === `data:doc:${docId}`);
    if (!run) throw new Error(`no data run for document ${docId}`);
    return run;
  }

  /** Real synthesis runs that processed this source; one batch may contain several sources. */
  async runsForSource(docId: string): Promise<RunDto[]> {
    const page = await this.runs({ kind: "synthesis", limit: 200 });
    const matches: RunDto[] = [];
    for (const run of page.items) {
      const steps = await this.executedTools(run.id);
      if (
        steps.some(
          (step) =>
            step.tool === "knowledge_discovery_complete" &&
            step.args.id === `source:${docId}` &&
            step.result?.kind === "structured",
        )
      )
        matches.push(run);
    }
    return matches;
  }

  /** Latest successful interpretation run, retaining its actual shared-batch identity. */
  async interpretationForSource(docId: string): Promise<RunDto> {
    const runs = await this.runsForSource(docId);
    const run = runs[0];
    if (!run) throw new Error(`no successful maintenance interpretation for source ${docId}`);
    return run;
  }

  /** The `<diff>` block a data run's prompt carried, if any. */
  async diffFor(runId: string): Promise<string | null> {
    const prompt = await this.promptFor(runId);
    return /<diff>\n([\s\S]*?)\n<\/diff>/.exec(prompt)?.[1] ?? null;
  }

  async decisions(opts: { doc?: string; limit?: number } = {}): Promise<PageOf<DecisionDto>> {
    for (let i = 0; i < 40; i++) {
      const page = await this.h.gatewayJson<PageOf<DecisionDto> & { rebuilding?: boolean }>(
        `/admin/brain/decisions${this.q({ limit: 200, ...opts })}`,
      );
      if (!page.rebuilding) return page;
      await sleep(250);
    }
    throw new Error("decision index never finished rebuilding");
  }

  // ── loops ───────────────────────────────────────────────────────────────

  async loops(opts: { state?: string; limit?: number } = {}): Promise<PageOf<LoopDto>> {
    return this.h.gatewayJson(`/admin/brain/loops${this.q({ limit: 500, ...opts })}`);
  }

  async loop(id: string): Promise<{
    // The DETAIL route enriches docs/actors/involved into refs; only the
    // LIST route echoes raw id lists.
    loop: Omit<LoopDto, "docs" | "actors" | "involved"> & {
      docs: AdminDocRef[];
      actors: Array<{ id: string; name: string | null }>;
      involved: Array<{ id: string; name: string | null }>;
    };
    ledger: LedgerEntry[];
    observations: ObservationDto[];
    scheduledRuns: RunDto[];
    provenance: unknown;
  }> {
    return this.h.gatewayJson(`/admin/brain/loops/${id}`);
  }

  async ledger(id: string): Promise<PageOf<LedgerEntry>> {
    return this.h.gatewayJson(`/admin/brain/loops/${id}/ledger?limit=200`);
  }

  async retiredLoops(): Promise<
    PageOf<{
      id: string;
      title: string;
      outcome: string;
      cadenceDays: number | null;
      recurrenceCount: number;
      retiredAt: string;
    }>
  > {
    return this.h.gatewayJson("/admin/brain/retired-loops?limit=200");
  }

  /** Loops whose title contains a marker — the arc-attribution probe. */
  async loopsMatching(marker: string, opts: { state?: string } = {}): Promise<LoopDto[]> {
    const page = await this.loops(opts);
    return page.items.filter((l) => l.title.includes(marker) || l.description.includes(marker));
  }

  /** The product loop feed (a contract no shipped client covers yet). */
  async productLoops(
    opts: { state?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ loops: ProductLoopDto[]; pageInfo: { nextCursor?: string | null } }> {
    return this.h.gatewayJson(`/loops${this.q(opts)}`);
  }

  /** One product loop, with its inline ledger. */
  async productLoop(
    id: string,
    opts: { includeChildren?: number } = {},
  ): Promise<{
    loop: ProductLoopDto;
    /** The product ledger omits `runId` — it is a user-facing view. */
    ledger?: Array<Omit<LedgerEntry, "runId">>;
    ledgerTruncated?: boolean;
  }> {
    return this.h.gatewayJson(`/loops/${id}${this.q(opts)}`);
  }

  // ── observations & the morning brief ───────────────────────────────────

  async observations(
    opts: { state?: string; limit?: number } = {},
  ): Promise<PageOf<ObservationDto>> {
    return this.h.gatewayJson(`/admin/brain/observations${this.q({ limit: 500, ...opts })}`);
  }

  async observation(id: string): Promise<{
    observation: Omit<ObservationDto, "citations"> & { citations: AdminDocRef[] };
    relatedLoops: Array<{ id: string; title: string | null; state: string | null }>;
    decisions: GateDecisionDto[];
    provenance: unknown;
  }> {
    return this.h.gatewayJson(`/admin/brain/observations/${id}`);
  }

  /** Observations whose summary contains a marker — the attribution probe. */
  async observationsMatching(marker: string): Promise<ObservationDto[]> {
    return (await this.observations()).items.filter((o) => o.summary.includes(marker));
  }

  /** The "would have pushed" log, newest first. */
  async wouldPush(): Promise<{
    items: Array<{
      id: string;
      summary: string;
      state: string;
      notedScores: ObservationScoresDto | null;
      createdAt: string;
      wouldPushAt: string;
      shippedAt: string | null;
      relevantUntil: string | null;
    }>;
  }> {
    return this.h.gatewayJson("/admin/brain/observations/would-push");
  }

  /** Closed observations reduced to outcome records by retention. */
  async observationOutcomes(): Promise<{
    items: Array<{
      id: string;
      topic: string;
      sourceKinds: string[];
      state: string;
      closeReason: string | null;
      notedScores: ObservationScoresDto | null;
      userAction: string | null;
      closedAt: string | null;
      prunedAt: string;
    }>;
  }> {
    return this.h.gatewayJson("/admin/brain/observations/outcomes");
  }

  /** A day's morning brief (its ranked items and, once sent, the message); the latest by default. */
  async morningBrief(day?: string): Promise<MorningBriefDto> {
    return this.h.gatewayJson(`/admin/brain/morning-brief${this.q({ day })}`);
  }

  // ── tasks ───────────────────────────────────────────────────────────────

  async tasks(
    view: string,
    opts: { date?: string; limit?: number } = {},
  ): Promise<{
    view: string;
    day: string;
    tasks: TaskDto[];
    counts: TaskCountsDto;
  }> {
    return this.h.gatewayJson(`/tasks${this.q({ view, ...opts })}`);
  }

  async taskCounts(date?: string): Promise<{ day: string; counts: TaskCountsDto }> {
    return this.h.gatewayJson(`/tasks/counts${this.q({ date })}`);
  }

  async task(
    id: string,
  ): Promise<{ task: TaskDto; history: TaskEventDto[]; undoSeq: number | null }> {
    return this.h.gatewayJson(`/tasks/${id}`);
  }

  async createTask(body: Record<string, unknown>): Promise<TaskReceiptDto> {
    return this.h.gatewayJson("/tasks", { method: "POST", body: JSON.stringify(body) });
  }

  /** One task command; the raw response, so a refusal's status is assertable. */
  async taskAction(id: string, body: Record<string, unknown>): Promise<Response> {
    return this.h.gatewayFetch(`/tasks/${id}/actions`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async undoTask(seq: number): Promise<Response> {
    return this.h.gatewayFetch("/tasks/undo", { method: "POST", body: JSON.stringify({ seq }) });
  }

  // ── notes ───────────────────────────────────────────────────────────────

  /** Quick-capture notes captured on `day`, each with the note agent's receipt once it ran. */
  async tellNotes(day: string): Promise<ListedNoteDto[]> {
    const page = await this.h.gatewayJson<{ entries: ListedNoteDto[] }>(`/notes${this.q({ day })}`);
    return page.entries;
  }

  // ── conversations ───────────────────────────────────────────────────────

  async conversations(): Promise<{
    conversations: Array<{
      id: string;
      title?: string;
      pinned?: boolean;
      messageCount?: number;
      origin?: { kind: string };
    }>;
  }> {
    return this.h.gatewayJson("/agent/conversations?limit=100");
  }

  async conversation(id: string): Promise<ConversationDto> {
    return this.h.gatewayJson(`/agent/conversations/${id}`);
  }

  /** One day's brief in the Morning brief conversation: its shipped items, sources and tasks. */
  async briefDetail(conversationId: string, day: string): Promise<BriefDetailDto> {
    return this.h.gatewayJson(`/agent/conversations/${conversationId}/briefs/${day}`);
  }

  // ── annotations ─────────────────────────────────────────────────────────

  async docAnnotations(docId: string): Promise<{ annotations: AnnotationDto[] }> {
    return this.h.gatewayJson(`/documents/${docId}/annotations?limit=100`);
  }

  async personAnnotations(personId: string): Promise<{ annotations: AnnotationDto[] }> {
    return this.h.gatewayJson(`/people/${personId}/annotations?limit=100`);
  }

  async dependents(
    store: "doc" | "person",
    annotationId: string,
  ): Promise<PageOf<{ kind: string; id: string; title: string; runId: string }>> {
    return this.h.gatewayJson(
      `/admin/cognition/annotations/${store}/${annotationId}/dependents?limit=200`,
    );
  }

  // ── time index ──────────────────────────────────────────────────────────

  async timeIndex(
    opts: { limit?: number; order?: string; upcoming?: boolean } = {},
  ): Promise<{ stats: unknown; items: AdminTemporalAnnotation[] }> {
    return this.h.gatewayJson(`/admin/brain/time-index${this.q({ limit: 500, ...opts })}`);
  }

  /**
   * The retrospective lane's live state, as the portal's Bootstrap panel reads
   * it — including `providerOutage`, which reports a model backend the drainer
   * has stopped claiming against.
   */
  async bootstrapStatus(): Promise<{
    mode?: "knowledge";
    liveDiscoveryIndependent?: boolean;
    corpusCompletion?: "not-measured";
    /** History dated before `notBefore` is outside review, not pending. */
    horizon?: { horizonMs: number; notBefore: string };
    /** Sources the Brain never processes (`brain.excludedSources`). */
    excludedSources?: string[];
    admission?: {
      total: number;
      today: number;
      pending: number;
      batched: number;
      completed: number;
      deferred: number;
      remainingLifetime: number;
      remainingToday: number;
      backlogRoom: number;
      windowOpen: boolean;
      windowOpensAt: number | null;
    };
    state: string;
    reason: string;
    runs?: { pending: number; completed: number; failed: number };
    providerOutage: {
      openUntil: string | number;
      consecutiveFailures: number;
      lastError: string;
    } | null;
  }> {
    return this.h.gatewayJson("/admin/brain/bootstrap");
  }

  /**
   * The corpus month by month, as the Bootstrap panel's timeline reads it.
   * Cached server-side for minutes against the cognition clock, so a suite
   * reads it once, after the state it asserts on has settled.
   */
  async bootstrapTimeline(): Promise<{
    mode: "knowledge";
    pending: boolean;
    months: Array<{
      month: string | null;
      interpretation: BootstrapTimelinePhaseCounts;
      organization: BootstrapTimelinePhaseCounts;
    }>;
    computedAt: string;
  }> {
    return this.h.gatewayJson("/admin/brain/bootstrap/timeline");
  }

  /** Exercise the same explicit-consent action the Bootstrap panel exposes. */
  async startBootstrap(): Promise<{ startedAt: string }> {
    return this.h.gatewayJson("/admin/brain/bootstrap/start", { method: "POST" });
  }

  async temporalWindow(opts: {
    from: number;
    to: number;
    timeZone?: string;
    kinds?: string;
    limit?: number;
  }): Promise<{ nowMs: number; items: unknown[]; coverage: unknown; truncated: boolean }> {
    return this.h.gatewayJson(
      `/temporal/window${this.q({ timeZone: "UTC", limit: 100, ...opts })}`,
    );
  }

  // ── accounting ──────────────────────────────────────────────────────────

  async spend(days = 30): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.h.gatewayJson(`/admin/brain/spend?days=${days}`);
  }

  async mechanismSpend(days = 30): Promise<{
    rows: Array<{
      day: string;
      mechanism: string;
      modelId: string;
      promptTokens: number;
      completionTokens: number;
      runs: number;
    }>;
  }> {
    return this.h.gatewayJson(`/admin/cognition/spend?days=${days}`);
  }

  async coverage(): Promise<{
    bootstrapProcessedDocs: number;
    items: Array<{
      sourceId: string;
      workflowId: string;
      workflowVersion?: number;
      unit?: string;
      costAttribution?: string;
      eligible: number;
      processed: number;
      skipped: number;
      promptTokens: number | null;
      completionTokens: number | null;
      lastProgressAt: string | null;
      status: string;
    }>;
  }> {
    return this.h.gatewayJson("/admin/brain/coverage?limit=200");
  }

  async calibration(opts: { family?: string; sinceDays?: number } = {}): Promise<{
    families: Array<{ family: string; total: number; labeled: number; ece: number }>;
  }> {
    return this.h.gatewayJson(`/admin/cognition/calibration${this.q(opts)}`);
  }

  async notes(): Promise<string> {
    const r = await this.h.gatewayJson<{ content: string }>("/admin/brain/notes");
    return r.content;
  }

  async sweeps(): Promise<unknown> {
    return this.h.gatewayJson("/admin/brain/sweeps");
  }
}

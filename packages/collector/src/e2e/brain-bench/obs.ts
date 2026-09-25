// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `BrainObs` — the read half of the brain end-to-end kit.
 *
 * Every assertion a bench test makes goes through the production read
 * surface (`/admin/brain/*`, `/admin/cognition/*`, `/briefs`, `/loops`),
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

export interface PulseCounts {
  queuedRuns: number;
  upcomingRuns: number;
  totalRuns: number;
  openLoops: number;
  snoozedLoops: number;
  totalLoops: number;
  unreadBriefs: number;
  totalBriefs: number;
  failedRuns24h: number;
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

export interface BriefClaim {
  id: string;
  claimText: string;
  claimBasis: string;
  confidence: number;
  verificationState: string;
  evidenceQuote: string | null;
  evidenceDoc: { id: string; title: string; sourceType: string } | null;
  createdAt: string;
}

/** Documents are echoed as `{id,…}` on the admin surface, `{docId,…}` on the product feed. */
export interface AdminDocRef {
  id: string;
  title: string | null;
  sourceType: string | null;
}

export interface FeedDocRef {
  docId: string;
  title: string;
}

export interface BriefDto {
  id: string;
  createdByRun: string;
  kind: "info" | "loop";
  state: string;
  title: string;
  description: string;
  body: string | null;
  /** Raw doc ids on the list route; resolved refs on the detail route. */
  citations: string[];
  relatedLoopIds: string[];
  confidence: number;
  urgency: number;
  relevantUntil: string | null;
  nextShow: string | null;
  eventAt: string | null;
  userFeedback: string | null;
  createdAt: string;
  updatedAt: string;
  threadConversationId: string | null;
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

export interface TemporalAnnotationDto {
  id: string;
  intervalStartMs: number;
  intervalEndMs: number;
  granularity: string;
  canonical: string;
  sentence: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
  documents: Array<{ id: string; title: string }>;
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
    briefs: {
      visible: boolean;
      enabled: boolean;
      modelAssigned: boolean;
      active: boolean;
      /** Why the gate is shut, when it is. */
      reason?: string | null;
    };
    experimental: boolean;
    developer: boolean;
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

  async run(id: string): Promise<{ run: RunDto; transcripts: Array<{ fileName: string }> }> {
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
   * structured refusal (`brief.held_for_verification`, `brief.held_by_judge`,
   * `*.conflict_candidates`) and an authority denial — a tool withheld from a
   * run's toolset comes back `unknown_tool` and is otherwise invisible.
   * `puppetCalls` records only what the puppet EMITTED; the answers live in the
   * transcript's event stream.
   */
  async executedTools(runId: string): Promise<ExecutedTool[]> {
    const refs = await this.transcripts({ runId });
    const steps: ExecutedTool[] = [];
    for (const entry of refs.items) {
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

  /** The settled `data` run a pushed document drove. */
  async runForDoc(docId: string): Promise<RunDto> {
    const page = await this.runs({ kind: "data", limit: 200 });
    const run = page.items.find((r) => r.dedupeKey === `data:doc:${docId}`);
    if (!run) throw new Error(`no data run for document ${docId}`);
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
    briefs: Array<{ id: string; kind: string; state: string; title: string }>;
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

  // ── briefs ──────────────────────────────────────────────────────────────

  async briefs(opts: { state?: string; limit?: number } = {}): Promise<PageOf<BriefDto>> {
    return this.h.gatewayJson(`/admin/brain/briefs${this.q({ limit: 500, ...opts })}`);
  }

  async brief(id: string): Promise<{
    brief: Omit<BriefDto, "citations"> & { citations: AdminDocRef[] };
    feedTier: { rank: number; label: string };
    claims: BriefClaim[];
    provenance: unknown;
  }> {
    return this.h.gatewayJson(`/admin/brain/briefs/${id}`);
  }

  async feed(
    opts: { limit?: number } = {},
  ): Promise<{ briefs: Array<Omit<BriefDto, "citations"> & { citations: FeedDocRef[] }> }> {
    return this.h.gatewayJson(`/briefs/feed${this.q(opts)}`);
  }

  async unreadCount(): Promise<number> {
    const r = await this.h.gatewayJson<{ unread: number }>("/briefs/count");
    return r.unread;
  }

  async readBrief(id: string): Promise<unknown> {
    return this.h.gatewayJson(`/briefs/${id}/read`, { method: "POST" });
  }

  async dismissBrief(
    id: string,
    body: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; state: string; feedbackRunId: string | null }> {
    return this.h.gatewayJson(`/briefs/${id}/dismiss`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async briefsMatching(marker: string): Promise<BriefDto[]> {
    const page = await this.briefs();
    return page.items.filter((b) => b.title.includes(marker) || b.description.includes(marker));
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
  ): Promise<{ stats: unknown; items: TemporalAnnotationDto[] }> {
    return this.h.gatewayJson(`/admin/brain/time-index${this.q({ limit: 500, ...opts })}`);
  }

  /**
   * The retrospective lane's live state, as the portal's Bootstrap panel reads
   * it — including `providerOutage`, which reports a model backend the drainer
   * has stopped claiming against.
   */
  async bootstrapStatus(): Promise<{
    state: string;
    reason: string;
    runs: { pending: number; completed: number; failed: number };
    providerOutage: { openUntil: string; consecutiveFailures: number; lastError: string } | null;
  }> {
    return this.h.gatewayJson("/admin/brain/bootstrap");
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
      `/briefs/temporal/window${this.q({ timeZone: "UTC", limit: 100, ...opts })}`,
    );
  }

  async timeIndexWindow(opts: {
    from: number;
    to: number;
    kinds?: string;
    limit?: number;
  }): Promise<{ nowMs: number; truncated: boolean; entries: TemporalAnnotationDto[] }> {
    return this.h.gatewayJson(`/briefs/time-index/window${this.q(opts)}`);
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
      eligible: number;
      processed: number;
      skipped: number;
      promptTokens: number;
      completionTokens: number;
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

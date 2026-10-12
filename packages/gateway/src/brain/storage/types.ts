// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Storage-layer types for the Cognition Steward: open loops (the user's
 * tasks), observations, the agent run queue, spend tracking, and the
 * agent-notes blob.
 *
 * Naming note: "loop" is an overloaded word in this repo, so every symbol
 * here is prefixed `openLoop` / `observation` / `cognition` — never bare "loop".
 *
 * Time discipline: no function in this module reads the wall clock on its
 * own. Every mutation takes an explicit `now` (unix ms), and services own
 * a {@link Clock} they thread through — so a 1-month decay back-off can
 * compress to milliseconds in tests.
 */

/**
 * Injectable wall clock (unix ms). Services hold one of these instead of
 * calling `Date.now()` inline; tests substitute a fake.
 */
export type Clock = () => number;

/** Default clock for production wiring. */
export const systemClock: Clock = () => Date.now();

// ---------------------------------------------------------------------------
// Open loops
// ---------------------------------------------------------------------------

/**
 * Lifecycle of an open loop. Moving to `snoozed` / `dismissed` is the
 * agent's (or a feedback run's) judgment; `done` means resolved.
 */
export type OpenLoopState = "open" | "snoozed" | "done" | "dismissed";

/**
 * Where a loop came from. `note` and `user` loops are the user's own tasks
 * from the start; a `brain` loop is a suggestion until the user accepts it.
 */
export type TaskOrigin = "note" | "user" | "brain";

/**
 * When the user plans to do a task, separate from its deadline: a day
 * (`YYYY-MM-DD`), a month (`YYYY-MM`) or `someday`.
 */
export type TaskSchedule = string;

/**
 * A change the Brain proposes to one of the user's own tasks. The task keeps
 * its current values until the user confirms; an ignored proposal changes
 * nothing.
 */
export interface ProposedTaskChange {
  kind: "complete" | "strike" | "edit";
  /** For `edit`: the proposed new values. */
  fields?: {
    title?: string;
    description?: string;
    deadline?: unknown | null;
    scheduledFor?: TaskSchedule | null;
  };
  /** Why, in one sentence, citing what changed. */
  reason: string;
  /** Documents that support the proposal. */
  evidence: string[];
  runId: string;
  proposedAt: number;
}

/**
 * A tracked open loop — an unfinished task, unresolved decision, or
 * inconsistency needing the user's attention. The authoritative record
 * lives in the `open_loops` table; a searchable projection of it is
 * mirrored into the document corpus (type `open-loop`) by the open-loop
 * system source.
 *
 * `actors` / `involved` are people ids and `docs` document ids; they are
 * plain arrays here (not formalised into the people/link graphs).
 * `deadline` is an opaque JSON structure owned by the agent layer.
 */
export interface OpenLoopRow {
  id: string;
  /** Agent run that created this loop. */
  createdByRun: string;
  state: OpenLoopState;
  /** Agent's confidence the loop is correct (0-1). */
  confidence: number;
  /** How likely this loop is to matter to the user (0-1). */
  importance: number;
  title: string;
  /** <100-word summary of the loop's current state. */
  description: string;
  /** Opaque deadline structure (agent-owned shape); null = no deadline. */
  deadline: unknown | null;
  /** People ids believed to need to take an action. */
  actors: string[];
  /** People impacted by / with a stake in the loop. */
  involved: string[];
  /** Ids of source documents that are relevant material. */
  docs: string[];
  /** Ids of other open loops that must resolve first. */
  blockedBy: string[];
  createdAt: number;
  /** Bumped by the engine whenever the agent updates the loop in any way. */
  lastUpdate: number;
  /** When an agent last successfully decay-checked this loop; null = never. */
  lastDecayCheck: number | null;
  /**
   * Consecutive decay status-checks kept since the loop was last
   * reinforced (any mutation other than recording a decay keep resets it
   * to 0). Drives the decay engine's exponential back-off: the next
   * check is due `base·2^count` after `lastUpdate`, capped.
   */
  decayCheckCount: number;
  origin: TaskOrigin;
  /** The user accepted this Brain suggestion into their tasks. */
  accepted: boolean;
  scheduledFor: TaskSchedule | null;
  proposedChange: ProposedTaskChange | null;
  /** The user's note on how the task was completed. */
  completionNote: string | null;
  /** When the loop last moved to done or dismissed; null while open. */
  resolvedAt: number | null;
}

/** True when the loop is one of the user's own tasks rather than a Brain suggestion. */
export function isOwnedTask(loop: Pick<OpenLoopRow, "origin" | "accepted">): boolean {
  return loop.origin !== "brain" || loop.accepted;
}

/**
 * Why a loop left the active store, recorded on its consolidation trace.
 * `done` / `dismissed` are resolutions (the agent closed the loop); `decayed`
 * / `deleted` are removals via the write-gated delete (a loop the decay engine
 * had been checking vs. a plain delete). A privacy delete is deliberately NOT
 * an outcome — it purges derived content and must leave no trace behind.
 */
export type RetiredLoopOutcome = "done" | "dismissed" | "decayed" | "deleted";

/**
 * One row of the append-only consolidation store (`retired_loops`): a compact
 * structured trace of a loop that was resolved or removed. Lexical matches
 * from this store surface during reconcile so a commitment that recurs is
 * recognised as a known recurrence rather than minted as a fresh loop.
 *
 * `titleNorm` is the recurrence key (the loop title lower-cased, split on
 * non-alphanumerics, words ≥3 chars kept, sorted, rejoined). `cadenceDays` is
 * the day-gap to the most-recent prior retirement sharing that key (null on the
 * first), and `recurrenceCount` counts how many times this commitment has
 * retired (1 on the first).
 */
export interface RetiredLoopRow {
  id: string;
  title: string;
  titleNorm: string;
  description: string;
  actors: string[];
  involved: string[];
  outcome: RetiredLoopOutcome;
  importance: number;
  deadline: unknown | null;
  createdAt: number;
  retiredAt: number;
  cadenceDays: number | null;
  recurrenceCount: number;
}

/** One `agent_ledger` entry — the traceable history of a loop. */
export interface OpenLoopLedgerEntry {
  /** Monotonic per-table sequence; orders entries oldest → newest. */
  seq: number;
  loopId: string;
  /** Agent run that appended this entry. */
  runId: string;
  at: number;
  note: string;
  /** Structured task event, for entries written by a task mutation. */
  event: TaskEvent | null;
}

/** What a task mutation did, and the values it replaced, for history and undo. */
export interface TaskEvent {
  kind:
    | "created"
    | "accepted"
    | "refused"
    | "migrated"
    | "completed"
    | "struck"
    | "edited"
    | "reopened"
    | "proposal_confirmed"
    | "proposal_kept"
    | "undone";
  /** Where the change was made. */
  surface: "tasks" | "conversation" | "note" | "brain";
  conversationId?: string;
  from?: string | null;
  to?: string | null;
  note?: string;
  /** The task fields before the change, restored by undo. */
  before?: TaskSnapshot;
  /** For `undone`: the ledger entry that was reverted. */
  undoOf?: number;
}

/** The task fields a mutation can change. */
export interface TaskSnapshot {
  state: OpenLoopState;
  title: string;
  description: string;
  deadline: unknown | null;
  scheduledFor: TaskSchedule | null;
  accepted: boolean;
  completionNote: string | null;
  proposedChange: ProposedTaskChange | null;
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * Observation lifecycle. Any agent run may note an observation; the user
 * never sees it directly. The morning brief run rechecks every live or held
 * observation and either ships it (it appears in that morning's message),
 * holds it (below the bar this morning; it stays eligible until its window
 * closes and returns only when its scores change) or drops it with a reason.
 * `shipped` and `dropped` are terminal: a shipped observation is never offered
 * again, and the same subject becoming relevant later is a new observation.
 */
export type ObservationState = "live" | "held" | "shipped" | "dropped";

export const OBSERVATION_STATES: readonly ObservationState[] = [
  "live",
  "held",
  "shipped",
  "dropped",
];

/** Why an observation closed or is waiting. */
export type ObservationCloseReason =
  /** Ranked below the decision bar this morning (state `held`). */
  | "below_bar"
  /** Its relevance window ended before it shipped. */
  | "expired"
  /** Cited evidence changed or disappeared after it was noted. */
  | "stale"
  /** Every related loop resolved, or a newer observation replaced it. */
  | "superseded"
  /** The decision model judged the user already knows it. */
  | "already_known"
  /** The entailment check rejected its claims at the morning recheck. */
  | "unsupported"
  /** The user asked not to see it, in a conversation. */
  | "suppressed"
  /** The noting agent withdrew it. */
  | "withdrawn";

export function isTerminalObservationState(state: ObservationState): boolean {
  return state === "shipped" || state === "dropped";
}

/**
 * The decision model's judgement of one observation. Levels are the raw
 * criterion indexes: `alreadyKnown` is a probability in [0,1], `consequence`
 * 0..4 (nothing → money/legal/health cost), `timing` 0..3 (no deadline →
 * today or tomorrow). A null level means the judgement was unavailable.
 */
export interface ObservationScores {
  alreadyKnown: number | null;
  consequence: number | null;
  timing: number | null;
  modelId: string | null;
  at: number;
}

/** One asserted claim: a verbatim quote of a cited document. */
export interface ObservationClaim {
  docId: string;
  quote: string;
  /** Entailment verdict from the morning recheck; `unverified` until then. */
  verification: "unverified" | "entailed" | "rejected";
}

export interface ObservationRow {
  id: string;
  createdByRun: string;
  /** One-line statement of what was observed. */
  summary: string;
  /** Why it might matter to the user. */
  why: string;
  /** Every cited document is the user's own writing. */
  userAuthored: boolean;
  /** Start of the window in which it matters; null = from now. */
  windowStart: number | null;
  /** End of the window in which it matters; null = no bound. */
  relevantUntil: number | null;
  citations: string[];
  relatedLoopIds: string[];
  claims: ObservationClaim[];
  state: ObservationState;
  closeReason: ObservationCloseReason | null;
  /** Scores taken when the observation was noted. */
  notedScores: ObservationScores | null;
  /** Latest scores, from the most recent morning recheck. */
  scores: ObservationScores | null;
  /**
   * When a same-day push would have fired had pushes been allowed: noted at
   * the top consequence level with a deadline before the next morning brief.
   */
  wouldPushAt: number | null;
  shippedAt: number | null;
  shippedConversationId: string | null;
  shippedMessageId: string | null;
  /** What the user did about it, recorded by the tool that acted. */
  userAction: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

// ---------------------------------------------------------------------------
// Agent run queue
// ---------------------------------------------------------------------------

/**
 * The queue kinds and their operator-facing explanations, as one ordered
 * descriptor list. Code that must cover every kind (the workflow vocabulary,
 * its exhaustiveness tests, and the Cognition inspector) consumes this list
 * instead of restating the union and silently drifting when a kind changes.
 *
 * `subscription_compile` is the one kind that never sits in the queue as
 * pending work: watch compilation executes synchronously inside the
 * authoring request, and its run row is inserted already settled
 * (`recordSettledCognitionRun`) so the ledger carries the transcript
 * without changing the compile path's latency semantics.
 */
export const COGNITION_RUN_KIND_DEFINITIONS = [
  {
    kind: "data",
    label: "Data",
    description:
      "Reviews newly ingested or changed documents and evaluates matching watches, deciding what should update the brain's memory, loops, or observations.",
  },
  {
    kind: "daily",
    label: "Daily",
    description:
      "Reviews a source's day of activity, looks ahead for upcoming commitments, or writes the morning brief.",
  },
  {
    kind: "time_based",
    label: "Time-based",
    description:
      "Runs a follow-up at a scheduled time or rechecks an open loop when its decay cadence comes due.",
  },
  {
    kind: "feedback",
    label: "Feedback",
    description: "Rechecks loops or observations whose supporting evidence has changed.",
  },
  {
    kind: "synthesis",
    label: "Synthesis",
    description:
      "Looks across recent cognition for new patterns, overlapping loops, or conflicting annotations.",
  },
  {
    kind: "sweep",
    label: "Sweep",
    description:
      "Runs a configured thematic prompt over the corpus on its cadence to look for a particular kind of signal.",
  },
  {
    kind: "bootstrap",
    label: "Bootstrap",
    description:
      "Reviews eligible older documents retrospectively so useful future-facing history is not missed when the brain is enabled or a source is added.",
  },
  {
    kind: "verification",
    label: "Verification",
    description:
      "Re-reads current evidence for due document and person annotations, then reaffirms, weakens, supersedes, or retracts them.",
  },
  {
    kind: "merge_adjudication",
    label: "Merge adjudication",
    description:
      "Reviews an uncertain person-identity match and decides whether the candidates are the same person, distinct, or still unclear.",
  },
  {
    kind: "notes_compaction",
    label: "Notes compaction",
    description:
      "Curates the agent's own notes back under their size cap: merges duplicates, drops stale items, and preserves durable facts and lessons.",
  },
  {
    kind: "subscription_compile",
    label: "Watch compile",
    description:
      "Turns a natural-language watch condition into a validated executable specification, or records why the request is unsafe or unsupported.",
  },
] as const;

export type CognitionRunKind = (typeof COGNITION_RUN_KIND_DEFINITIONS)[number]["kind"];

export const COGNITION_RUN_KINDS: readonly CognitionRunKind[] = COGNITION_RUN_KIND_DEFINITIONS.map(
  ({ kind }) => kind,
);

export type CognitionRunStatus = "pending" | "completed" | "failed";

/**
 * One queued (or finished) Cognition Steward run. Payload shape is per-kind and
 * owned by the run-driver layer — the queue stores it opaquely.
 */
export interface CognitionRunRow {
  id: string;
  kind: CognitionRunKind;
  payload: unknown;
  /**
   * Earliest time the run may be claimed (unix ms). Doubles as the
   * back-off horizon after a soft failure.
   */
  nextAttemptAt: number;
  /**
   * Optional fold key: at most one `pending` row exists per key (e.g.
   * one pending `data` run per updatable document). Null = no folding.
   */
  dedupeKey: string | null;
  status: CognitionRunStatus;
  attempts: number;
  lastError: string | null;
  /** Stable code for the most recent failed attempt, when one was available. */
  failureCode: string | null;
  enqueuedAt: number;
  /**
   * Mutable per-cycle anchor (unix ms) for the max-defer ceiling. Set to the
   * enqueue time on INSERT and reset to `now` when an in-flight-fold resurrect
   * starts a fresh cycle; a fold leaves it untouched. A continuously-folded
   * `data` run's `nextAttemptAt` is clamped to `cycleAnchorAt + maxDefer`, so a
   * forever-hot conversation/document becomes claimable within a bounded time.
   */
  cycleAnchorAt: number;
  lastAttemptAt: number | null;
  completedAt: number | null;
  /** Token usage recorded at completion; null until then. */
  usage: CognitionRunUsage | null;
}

/**
 * Per-run token usage, recorded when the run completes.
 *
 * `promptTokens` is the TOTAL input side (fresh + cache reads + cache
 * writes) so day totals stay comparable across rows written before the
 * cache split existed. The cache fields are subsets of that total:
 * `cacheReadTokens` were served from the provider's prompt cache at the
 * discounted rate; `cacheCreationTokens` were written to it (Anthropic
 * bills these at a premium; OpenAI-compat providers report 0). Absent on
 * rows recorded before the split.
 */
export interface CognitionRunUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** A claimed, ready-to-execute run (attempts already bumped). */
export interface ClaimedCognitionRun {
  id: string;
  kind: CognitionRunKind;
  payload: unknown;
  /**
   * Raw `payload_json` as claimed. On a completion, `finalizeCognitionRun`
   * compares it against the row to detect a fold that landed while the run was
   * in flight (in-flight rows stay `pending`, so the waker's fold can replace
   * their payload) — a completion must not freeze a payload it never processed;
   * it resurrects a fresh cycle instead.
   */
  payloadJson: string;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Spend tracking
// ---------------------------------------------------------------------------

/**
 * One `cognition_spend` bucket: token totals keyed
 * (day, mechanism, model). `day` is a `YYYY-MM-DD` string in the gateway
 * machine's local time (the same basis the daily rhythm uses);
 * `mechanism` names the cognitive mechanism that spent the tokens (a run
 * kind today — `data`, `daily`, `synthesis`, `sweep`, … — plus
 * `unattributed` for pre-split history); `modelId` is the resolved
 * backend's model id (`""` when unknown). Tracking only — no enforcement
 * anywhere in the product.
 */
export interface CognitionSpendRow {
  day: string;
  mechanism: string;
  modelId: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  /** Subset of `promptTokens` served from the provider's prompt cache. */
  cacheReadTokens: number;
  /** Subset of `promptTokens` written to the cache (Anthropic-style billing). */
  cacheCreationTokens: number;
}

/**
 * One day's totals aggregated across all mechanisms and models — the
 * one-row-per-day shape `/admin/brain/spend` serves.
 */
export interface CognitionDayTotalRow {
  day: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  /** Subset of `promptTokens` served from the provider's prompt cache. */
  cacheReadTokens: number;
  /** Subset of `promptTokens` written to the cache (Anthropic-style billing). */
  cacheCreationTokens: number;
}

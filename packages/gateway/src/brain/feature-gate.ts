// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Brain feature gate — the single answer to "is the Brain on?".
 *
 * The feature has no per-source enable/disable and no config switch of its
 * own; it is governed by exactly two levers:
 *
 *   - **experimental mode** (`OMNESIS_EXPERIMENTAL`), like every other
 *     experimental surface, and
 *   - **a `background-agent` model assignment**
 *     (`inference.assignments["background-agent"]`) — never assigned by
 *     default, so a fresh install has no proactive intelligence until the
 *     operator deliberately picks a model.
 *
 * Three distinct predicates fall out of that, mirroring the repo-wide
 * enabled-vs-visible split:
 *
 *   - `active` — the engine may execute work. Requires `enabled` AND an
 *     assigned model. With either missing every installed background task
 *     remains idle.
 *   - `enabled` — the operator switched the feature on
 *     (`experimentalEnabled()`). Reported separately from `active` because it
 *     is the predicate that says whether a missing model is worth telling the
 *     operator about: with the feature off, an unassigned model is not a fault.
 *   - `visible` — surfaces (entry points, the `/status` advertisement) may
 *     show the feature. `experimentalVisible()`, so synthetic lanes
 *     (`OMNESIS_SYNTHETIC=1`) light the surfaces up for snapshots and demos
 *     without flipping the experimental switch.
 */

import {
  experimentalEnabled,
  experimentalVisible,
  type CapabilityRole,
  type EntailCapability,
  type ResolvedAssignment,
  type Logger,
  type DecisionCapability,
} from "@omnesis/core";
import { fetchSelfPersonId } from "../domain/InteractionScoreService.js";
import { chatRoleReadiness } from "../models/chat-role-readiness.js";
import { DERIVATION_STAGES, type DerivationStage } from "../domain/DocumentDerivation.js";
import { knowledgeFrontierPreflight } from "./knowledge/engine-frontier.js";
import { cognitionBudgetVerdict } from "./cognition/budget.js";
import { parseCognitionSynthesisRunPayload } from "./run-payloads.js";
import { seedOpenLoopSourceMeta } from "./open-loop-source/source-meta.js";
import { WorthGate, WORTH_GATE_SPEND_MECHANISM } from "./worth-gate/gate.js";
import { RecordCheck } from "./record-check/check.js";
import { RECORD_CHECK_SPEND_MECHANISM } from "./record-check/rubric.js";
import { recordDecisionSpend } from "./decision-call.js";
import {
  TaskChecks,
  TASK_CHECK_SPEND_MECHANISM,
  taskCheckPayloadCapture,
} from "./tasks/task-checks.js";
import { TaskProposeGate, TASK_PROPOSE_SPEND_MECHANISM } from "./tasks/task-propose.js";
import { captureOwnerDecisionPayload } from "./decision-payload.js";
import { settleTaskProposals } from "./tasks/settle-proposals.js";
import { cognitionSpendDay } from "./storage/spend.js";
import type { ChatRoleReadinessDeps } from "../models/chat-role-readiness.js";
import type { ChatBackend, ToolHandle } from "@omnesis/agent";
import type Database from "better-sqlite3";
import type { BackgroundJob } from "../background-jobs/types.js";
import type { EventBus } from "../events.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { WriteGate } from "../write-gate.js";
import type { AnalyticsDb } from "../analytics-db.js";
import type { SearchPipeline } from "../search/pipeline.js";
import type { SyncStatusRegistry } from "../sync-status.js";
import type { PersonLookupGate } from "../domain/person-lookup.js";
import type { ResolvedBrainSettings } from "./config.js";
import type { InterestLookup } from "./interest/engine.js";
import type { SweepService } from "./sweeps/service.js";
import type { CognitionRunActivity } from "./run-activity.js";
import type {
  CognitionContextBudget,
  CognitionPromptBuilder,
  CognitionRunExecutionContext,
} from "./run-driver.js";
import type { ClaimedCognitionRun, Clock } from "./storage/types.js";

/** The capability role the Cognition Steward runs on. */
export const BACKGROUND_AGENT_ROLE: CapabilityRole = "background-agent";

/** The slice of the inference registry the gate consumes. */
export interface BackgroundAgentResolver {
  resolve(role: CapabilityRole): ResolvedAssignment;
}

/**
 * The gate's verdict, advertised verbatim as the `briefs` field on
 * `GET /status` so clients can distinguish "feature hidden" from "feature
 * shown but needs a model". Stored briefs remain a live read/triage surface
 * while the engine is parked.
 */
export interface BriefsFeatureStatus {
  /** Surfaces may show the feature's entry points. */
  visible: boolean;
  /**
   * The operator switched the feature on. Separates "this install wants Briefs
   * and its model is broken" — worth flagging — from "this install only
   * previews Briefs", where an unassigned model is the expected state.
   */
  enabled: boolean;
  /**
   * A background-agent model is assigned AND its backend can actually run —
   * key present, egress permitted, endpoint reachable, fixture resolvable.
   */
  modelAssigned: boolean;
  /** The engine may run: experimental mode on AND a runnable model. */
  active: boolean;
  /**
   * Why the model cannot run, when it cannot. Absent while runnable.
   *
   * Prose for a surface that owns the subject and can act on it: the portal's
   * Cognition tab states it under an "Omnesis Brain is not running" heading.
   * Mobile clients read the booleans only. Their menus keep Briefs reachable,
   * and the Briefs view shows a warning that opens the Background agent model
   * picker, where the capability's readiness and repair live. A misconfigured
   * backend reads as something to fix, not as a feature that was never there.
   */
  reason?: string;
}

/**
 * Compute the live gate verdict. Reads the experimental env fresh and
 * re-resolves the assignment on every call, so a config change (model
 * assigned or removed, key added, egress flipped) is reflected on the next
 * `/status` poll without a gateway restart.
 */
export function briefsFeatureStatus(
  registry: BackgroundAgentResolver,
  deps: ChatRoleReadinessDeps,
): BriefsFeatureStatus {
  const readiness = chatRoleReadiness(registry.resolve(BACKGROUND_AGENT_ROLE), deps);
  const enabled = experimentalEnabled();
  return {
    visible: experimentalVisible(),
    enabled,
    modelAssigned: readiness.runnable,
    active: enabled && readiness.runnable,
    ...(readiness.reason !== undefined ? { reason: readiness.reason } : {}),
  };
}

/**
 * Everything the Agent Run Queue drainer needs beyond the gate's own
 * deps. Kept as one bag so `bootBriefs` stays the feature's single boot
 * touchpoint: the composition root passes this in, and the gate decides
 * whether any of it is used. Storage-only tests may omit it — then no
 * background tasks exist at all.
 */
export interface BriefsRunQueueBootDeps {
  db: Database.Database;
  scheduler: Scheduler;
  backgroundJobs: { registerAll(jobs: BackgroundJob[]): void };
  /** Live briefs settings (worker concurrency, transcript retention). */
  getSettings: () => ResolvedBrainSettings;
  /**
   * Which of these documents still hold content due to be replaced (a voice
   * note awaiting its gateway transcript); their runs wait for it, up to the
   * pending-content barrier. Omitted: nothing is ever pending.
   */
  contentPending?: (docIds: readonly string[]) => Set<string>;
  /** Resolve the `background-agent` chat backend, fresh per run. */
  resolveBackend: () => ChatBackend | null;
  /**
   * The decision capability, resolved fresh per call. When it returns a
   * backend, the worth gate judges each claimed bootstrap/data email before
   * its agent turn; null (or omitted) leaves every claimed run to execute.
   */
  getDecision?: () => DecisionCapability | null;
  /**
   * The interest ledger's lookup: the owner's past reactions that resemble an
   * item, shown to the gates that rank observations, judge a new suggestion
   * and schedule new evidence. Omitted, those gates decide without it.
   */
  interest?: InterestLookup;
  /** The operator's `OMNESIS.md`, re-read per run. Absent without a config dir. */
  getOperatorInstructions?: () => string;
  /** Directory run transcripts persist under (created on demand). */
  transcriptsDir: string;
  /**
   * The sweep set (system definitions layered with the operator's files).
   * Omitted by storage-only tests, which then schedule no sweeps at all.
   */
  sweeps?: SweepService;
  /**
   * Live-run registry shared with the HTTP layer: the drainer marks runs
   * around execution and the waker registers its not-yet-enqueued backlog;
   * `/admin/brain/runs` and `/admin/brain/pulse` read it. The composition root
   * constructs it (the server is created before this boot runs).
   */
  activity?: CognitionRunActivity;
  /**
   * Gateway event bus. When present, the real-time waker subscribes to
   * `document.upserted`/`document.deleted` and registers prior-content
   * interest (the document-diff engine). Omit to run the queue without
   * the waker (storage-only tests).
   */
  eventBus?: Pick<EventBus, "on">;
  clock?: Clock;
  /** Cadence overrides (tests / env tuning). */
  drainIntervalMs?: number;
  drainIdleMs?: number;
  drainStartDelayMs?: number;
  pruneIntervalMs?: number;
  /**
   * The derivation stages the readiness barrier may wait on, re-read per use.
   * Defaults to every registered stage; the composition root narrows it to the
   * producers actually running, since a stage that is switched off never
   * stamps its column and would hold every run for the full barrier.
   */
  activeDerivationStages?: () => readonly DerivationStage[];
  wakerIntervalMs?: number;
  wakerIdleMs?: number;
  wakerStartDelayMs?: number;
  rhythmIntervalMs?: number;
  rhythmIdleMs?: number;
  rhythmStartDelayMs?: number;
  /**
   * Collaborators the real Cognition Steward runtime (tools + per-kind prompts,
   * `loop-agent/runtime.ts`) is assembled from. When present and no
   * explicit seams are passed, `bootBriefs` lazy-loads the runtime and
   * fills the three driver seams with it.
   */
  cognition?: {
    searchPipeline: SearchPipeline;
    syncStatus: SyncStatusRegistry;
    analyticsDb: AnalyticsDb;
    /** index.db handle for the deleted-mirror chunk cascade. Optional. */
    indexDb?: Database.Database;
    /**
     * Read-worker gate for `lookup_people`. When wired the Cognition Steward runs the
     * heavy person assembly off the main event loop (at background priority);
     * absent, it falls back to a synchronous main-thread read.
     */
    personLookupGate?: PersonLookupGate;
    /**
     * Entailment verifier resolver for the annotation firewall. Optional —
     * absent (or resolving to null) leaves the gate off and annotation
     * writes unchanged.
     */
    getEntailmentVerifier?: (signal?: AbortSignal) => Promise<EntailCapability | null>;
    validateAnnotationEvidence?: import("./steward/tools.js").AnnotationToolDeps["validateAnnotationEvidence"];
    /** Live privacy policy used by the mandatory subscription precision barrier. */
    policyStore?: { get(): Promise<{ revision: string }> };
  };
  /** Seam overrides for tests; production uses `cognition` instead. */
  promptBuilder?: CognitionPromptBuilder;
  buildTools?: (run: ClaimedCognitionRun) => ToolHandle[];
  systemPrompt?: (run?: ClaimedCognitionRun) => string;
}

/**
 * Boot-time wiring for the Briefs feature. Experimental mode prepares the
 * runtime exactly once, even before a background model is assigned. Every
 * execution task reads the live `active` verdict, so a hot assignment starts
 * draining without a restart and removal immediately parks future work.
 * With experimental mode off, only durable evidence/privacy cleanup runs.
 * The waker, maintenance and proactive producers share this boot touchpoint
 * and the same live verdict.
 *
 * The one-time preparation avoids duplicate scheduler registrations across
 * model changes; model assignment is never itself a registration event.
 */
export async function bootBriefs(deps: {
  registry: BackgroundAgentResolver;
  /** Runtime-readiness probes for the background-agent backend. */
  readiness: ChatRoleReadinessDeps;
  writeGate: WriteGate;
  log: Logger;
  runQueue?: BriefsRunQueueBootDeps;
  /**
   * Where the morning brief is sent: the agent service's standing Morning
   * brief conversation, resolved per send because the service starts after
   * the Brain boots.
   */
  morningBrief?: {
    getConversationPort():
      | import("./observations/morning-brief.js").MorningBriefConversationPort
      | null;
  };
  /**
   * Top-level interactive-session write access (experimental). When present and
   * the feature is active, bootBriefs installs the interactive-write profile on
   * the agent lifecycle so a top-level chat can write into the substrate
   * (loops/observations/temporal annotations/other annotations) with an interactive-origin run id.
   * Absent ⇒ interactive stays read-only.
   */
  interactiveWrite?: {
    setProfile(profile: import("../agent/service.js").InteractiveWriteProfile): void;
  };
  /**
   * The deprecated `brain.sweeps` config record, read once at boot and
   * converted to sweep files. Omit once the key is gone from the schema.
   */
  getLegacySweepOverrides?: () => Record<string, import("./sweeps/service.js").LegacySweepOverride>;
}): Promise<BriefsFeatureStatus> {
  const status = briefsFeatureStatus(deps.registry, deps.readiness);
  if (deps.runQueue) {
    const { knowledgeCascadeTask } = await import("./knowledge/tasks.js");
    const { createKnowledgeMirror } = await import("./knowledge/mirror.js");
    const indexDb = deps.runQueue.cognition?.indexDb;
    const indexGate = indexDb
      ? (await import("../indexer/index-write-gate.js")).directIndexWriteGate(indexDb)
      : null;
    const mirror = createKnowledgeMirror({
      clock: deps.runQueue.clock ?? Date.now,
      db: deps.runQueue.db,
      writeGate: deps.writeGate,
      ...(indexGate
        ? { deleteIndexChunks: (ids: string[]) => indexGate.deleteChunksByDocuments(ids) }
        : {}),
    });
    const cleanup = knowledgeCascadeTask({
      writeGate: deps.writeGate,
      scheduler: deps.runQueue.scheduler,
      clock: deps.runQueue.clock ?? Date.now,
      removeMirrors: (ids) => mirror.remove(ids),
      drainMirrors: () => mirror.drainCleanup(),
    });
    deps.runQueue.scheduler.schedule(cleanup.task);
    deps.runQueue.backgroundJobs.registerAll([cleanup.job]);
    const { seedKnowledgeSourceMeta } = await import("./knowledge/source-identity.js");
    await seedKnowledgeSourceMeta(deps.writeGate);
  }
  if (!experimentalEnabled()) return status;
  await seedOpenLoopSourceMeta(deps.writeGate);
  deps.log.info(`Briefs runtime prepared — open-loops system source seeded`);
  if (deps.runQueue) {
    const rq = deps.runQueue;
    const log = deps.log.child("loop-agent");
    // Person-ref hygiene: re-resolve every loop's `actors`/`involved`
    // through the same boundary the tools now apply (emails → person ids,
    // merged ids → canonical roots), self-healing rows written before the
    // boundary existed. Idempotent — a clean store is a no-op scan.
    {
      const { normalizeOpenLoopPersonRefs } = await import("./person-refs.js");
      await normalizeOpenLoopPersonRefs({ db: rq.db, writeGate: deps.writeGate, log });
    }
    // Loaded lazily so the drainer/driver modules (and the agent library
    // behind them) never even enter the module graph unless the feature
    // is active — this file sits on the barrel every write-gate consumer
    // (including the writer worker) imports, and it must stay light.
    const [
      { createCognitionDrainerTasks },
      { CognitionRunDriver },
      { FsCognitionTranscriptStore },
    ] = await Promise.all([
      import("./run-drainer.js"),
      import("./run-driver.js"),
      import("./transcripts.js"),
    ]);
    const transcripts = new FsCognitionTranscriptStore(rq.transcriptsDir);
    // The real Cognition Steward (tools + per-kind prompts + notes injection),
    // unless a test passed explicit seam overrides. Lazy-loaded like the
    // drainer so inert builds never pull the agent-ports graph.
    let runtimeSeams: {
      buildTools?: (
        run: ClaimedCognitionRun,
        context?: CognitionRunExecutionContext,
      ) => ToolHandle[];
      preflight?: (run: ClaimedCognitionRun) => Promise<"complete" | "continue" | "defer">;
      promptBuilder?: CognitionPromptBuilder;
      systemPrompt?: (run?: ClaimedCognitionRun) => string;
      buildOwnTools?: (runId: string) => ToolHandle[];
      validateRun?: (run: ClaimedCognitionRun) => string | null | Promise<string | null>;
    } = {};
    let knowledge:
      | {
          service: import("./knowledge/service.js").KnowledgeService;
          engine: import("./knowledge/engine.js").KnowledgeEngine;
        }
      | undefined;
    if (rq.cognition && !rq.buildTools && !rq.promptBuilder && !rq.systemPrompt) {
      const [
        { KnowledgeService },
        { KnowledgeEngine },
        { createKnowledgeMirror },
        { knowledgeMaintenanceTask },
      ] = await Promise.all([
        import("./knowledge/service.js"),
        import("./knowledge/engine.js"),
        import("./knowledge/mirror.js"),
        import("./knowledge/tasks.js"),
      ]);
      const indexGate = rq.cognition.indexDb
        ? (await import("../indexer/index-write-gate.js")).directIndexWriteGate(
            rq.cognition.indexDb,
          )
        : null;
      const mirror = createKnowledgeMirror({
        clock: rq.clock ?? Date.now,
        db: rq.db,
        writeGate: deps.writeGate,
        ...(indexGate
          ? { deleteIndexChunks: (ids: string[]) => indexGate.deleteChunksByDocuments(ids) }
          : {}),
      });
      const service = new KnowledgeService({
        db: rq.db,
        writeGate: deps.writeGate,
        getSettings: rq.getSettings,
        getEntailmentVerifier: rq.cognition.getEntailmentVerifier,
        clock: rq.clock ?? Date.now,
        log: log.child("knowledge"),
        mirror,
      });
      const engine = new KnowledgeEngine({
        publishedRetrievalBoundary: () =>
          rq.cognition?.searchPipeline.retrievalCoverage?.().publishedThrough ?? null,
        db: rq.db,
        writeGate: deps.writeGate,
        service,
        getSettings: rq.getSettings,
        ...(rq.contentPending ? { contentPending: rq.contentPending } : {}),
        activeDerivationStages: rq.activeDerivationStages ?? (() => DERIVATION_STAGES),
        clock: rq.clock ?? Date.now,
        log: log.child("knowledge"),
        ...(rq.interest ? { interest: rq.interest } : {}),
        decisions: {
          getDecision: rq.getDecision,
          log: log.child("knowledge-decision"),
          record: (entry) =>
            deps.writeGate["knowledge.decision"](
              { id: `kd_${crypto.randomUUID()}`, ...entry },
              (rq.clock ?? Date.now)(),
            ),
          recordSpend: (modelId, tokens) =>
            recordDecisionSpend(
              deps.writeGate,
              cognitionSpendDay((rq.clock ?? Date.now)()),
              "knowledge-decision",
              modelId,
              tokens,
            ),
        },
      });
      knowledge = { service, engine };
      const maintenance = knowledgeMaintenanceTask({
        engine,
        scheduler: rq.scheduler,
        isEnabled: () => briefsFeatureStatus(deps.registry, deps.readiness).active,
        intervalMs: rq.wakerIntervalMs,
        idleMs: rq.wakerIdleMs,
        startDelayMs: rq.wakerStartDelayMs,
      });
      rq.scheduler.schedule(maintenance.task);
      rq.backgroundJobs.registerAll([maintenance.job]);
      const { createCognitionRuntime } = await import("./steward/runtime.js");
      const taskChecks = rq.getDecision
        ? new TaskChecks({
            getDecision: rq.getDecision,
            recordDecision: (record) => deps.writeGate.recordCognitionDecision(record),
            capturePayload: (input) => taskCheckPayloadCapture(rq.db, input),
            recordSpend: (modelId, inputTokens) =>
              recordDecisionSpend(
                deps.writeGate,
                cognitionSpendDay((rq.clock ?? Date.now)()),
                TASK_CHECK_SPEND_MECHANISM,
                modelId,
                inputTokens,
              ),
            clock: rq.clock ?? Date.now,
            idGen: () => crypto.randomUUID(),
            log: log.child("task-check"),
            ...(rq.interest ? { interest: rq.interest } : {}),
          })
        : undefined;
      const taskPropose =
        rq.getDecision && rq.interest
          ? new TaskProposeGate({
              getDecision: rq.getDecision,
              getMode: () => rq.getSettings().tasks.proposeGate,
              interest: rq.interest,
              recordDecision: (record) => deps.writeGate.recordCognitionDecision(record),
              // The loop's node does not exist yet, so the subjects are its documents.
              capturePayload: (input) =>
                captureOwnerDecisionPayload(
                  rq.db,
                  { kind: "loop", id: input.loopId },
                  input.documentId === null ? [] : [input.documentId],
                ) ?? undefined,
              recordSpend: (modelId, inputTokens) =>
                recordDecisionSpend(
                  deps.writeGate,
                  cognitionSpendDay((rq.clock ?? Date.now)()),
                  TASK_PROPOSE_SPEND_MECHANISM,
                  modelId,
                  inputTokens,
                ),
              clock: rq.clock ?? Date.now,
              idGen: () => crypto.randomUUID(),
              log: log.child("task-propose"),
            })
          : undefined;
      runtimeSeams = await createCognitionRuntime({
        knowledge,
        db: rq.db,
        writeGate: deps.writeGate,
        searchPipeline: rq.cognition.searchPipeline,
        syncStatus: rq.cognition.syncStatus,
        analyticsDb: rq.cognition.analyticsDb,
        ...(rq.cognition.indexDb ? { indexDb: rq.cognition.indexDb } : {}),
        ...(rq.cognition.personLookupGate
          ? { personLookupGate: rq.cognition.personLookupGate }
          : {}),
        ...(rq.cognition.validateAnnotationEvidence
          ? { validateAnnotationEvidence: rq.cognition.validateAnnotationEvidence }
          : {}),
        ...(rq.cognition.getEntailmentVerifier
          ? { getEntailmentVerifier: rq.cognition.getEntailmentVerifier }
          : {}),
        observations: await observationRuntimeDeps(rq, deps, log),
        ...(rq.getDecision
          ? {
              recordCheck: new RecordCheck({
                getDecision: rq.getDecision,
                getMode: () => rq.getSettings().annotations.recordCheck,
                recordDecision: (record) => deps.writeGate.recordCognitionDecision(record),
                recordSpend: (modelId, inputTokens) =>
                  recordDecisionSpend(
                    deps.writeGate,
                    cognitionSpendDay((rq.clock ?? Date.now)()),
                    RECORD_CHECK_SPEND_MECHANISM,
                    modelId,
                    inputTokens,
                  ),
                clock: rq.clock ?? Date.now,
                idGen: () => crypto.randomUUID(),
                log: log.child("record-check"),
              }),
            }
          : {}),
        ...(taskChecks ? { taskChecks } : {}),
        ...(taskPropose ? { taskPropose } : {}),
        ...(rq.interest ? { interest: rq.interest } : {}),
        ...(rq.cognition.policyStore ? { policyStore: rq.cognition.policyStore } : {}),
        getSettings: rq.getSettings,
        ...(rq.getOperatorInstructions
          ? { getOperatorInstructions: rq.getOperatorInstructions }
          : {}),
        ...(rq.activeDerivationStages ? { activeDerivationStages: rq.activeDerivationStages } : {}),
        ...(rq.clock ? { clock: rq.clock } : {}),
        log,
      });
      // A proposal waiting on a task was judged when it was made; settle the
      // ones the current policy would apply, or that no longer change anything.
      void settleTaskProposals({
        db: rq.db,
        writeGate: deps.writeGate,
        autoApply: rq.getSettings().tasks.autoApply,
        ...(taskChecks ? { taskChecks } : {}),
        clock: rq.clock ?? Date.now,
        log: log.child("tasks"),
      }).catch((err: unknown) =>
        log.warn(
          `Settling waiting task proposals failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    const buildTools = rq.buildTools ?? runtimeSeams.buildTools;
    const promptBuilder = rq.promptBuilder ?? runtimeSeams.promptBuilder;
    const systemPrompt = rq.systemPrompt ?? runtimeSeams.systemPrompt;
    const buildOwnTools = runtimeSeams.buildOwnTools;
    const validateRun = knowledge
      ? (run: ClaimedCognitionRun): string | null | Promise<string | null> => {
          if (run.kind !== "synthesis") return runtimeSeams.validateRun?.(run) ?? null;
          const payload = run.payload as { focus?: unknown; batchId?: unknown };
          if (payload.focus !== "knowledge-maintenance" || typeof payload.batchId !== "string")
            return runtimeSeams.validateRun?.(run) ?? null;
          const batch = rq.db
            .prepare<
              [string, string],
              { status: string }
            >("SELECT status FROM knowledge_batches WHERE id=? AND run_id=?")
            .get(payload.batchId, run.id);
          return batch?.status === "completed" || batch?.status === "abandoned"
            ? null
            : "Knowledge batch still has unresolved input versions; continue the durable frontier on retry";
        }
      : runtimeSeams.validateRun;

    // Top-level interactive-session substrate write access: hand the agent
    // lifecycle a builder for the Cognition Steward's own mutating tools, stamped with
    // an interactive-origin run id. Only wired on the production path (where
    // buildOwnTools is populated) — test seam-override boots leave interactive
    // read-only, which is correct.
    if (deps.interactiveWrite && buildOwnTools) {
      deps.interactiveWrite.setProfile({ buildOwnTools });
      log.info("interactive-agent substrate write access wired");
    }
    const maintenanceEngine = knowledge?.engine;
    const driver = new CognitionRunDriver({
      resolveBackend: rq.resolveBackend,
      transcripts,
      log,
      ...(maintenanceEngine || runtimeSeams.preflight
        ? {
            preflight: async (run: ClaimedCognitionRun) => {
              const runtimeVerdict = await runtimeSeams.preflight?.(run);
              if (runtimeVerdict && runtimeVerdict !== "continue") return runtimeVerdict;
              const payload =
                run.kind === "synthesis" ? parseCognitionSynthesisRunPayload(run.payload) : null;
              if (
                !maintenanceEngine ||
                payload?.focus !== "knowledge-maintenance" ||
                !payload.batchId
              )
                return "continue" as const;
              const frontier = await maintenanceEngine.next(payload.batchId, run.id);
              return knowledgeFrontierPreflight(frontier);
            },
          }
        : {}),
      ...(buildTools ? { buildTools } : {}),
      ...(promptBuilder ? { promptBuilder } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(knowledge
        ? {
            isRunHandedOff: (run: ClaimedCognitionRun): boolean => {
              if (run.kind !== "synthesis") return false;
              const payload = run.payload as { focus?: unknown; batchId?: unknown };
              return (
                payload.focus === "knowledge-maintenance" &&
                typeof payload.batchId === "string" &&
                !!rq.db
                  .prepare(
                    "SELECT 1 FROM knowledge_batches WHERE id=? AND run_id=? AND status='abandoned'",
                  )
                  .get(payload.batchId, run.id)
              );
            },
          }
        : {}),
      ...(validateRun ? { validateRun } : {}),
      ...(knowledge
        ? {
            contextBudget: (run: ClaimedCognitionRun) =>
              maintenanceContextBudget(run, rq.getSettings().knowledge),
          }
        : {}),
      ...(rq.clock ? { clock: rq.clock } : {}),
    });
    const bundle = createCognitionDrainerTasks(
      {
        db: rq.db,
        writeGate: deps.writeGate,
        driver,
        transcripts,
        log,
        getBudgetVerdict: () =>
          cognitionBudgetVerdict(rq.db, rq.getSettings().budget, (rq.clock ?? Date.now)()),
        isEnabled: () => briefsFeatureStatus(deps.registry, deps.readiness).active,
        ...(rq.activity ? { activity: rq.activity } : {}),
        getWorkerConcurrency: () => rq.getSettings().workerConcurrency,
        getMaxStalledHandoffs: () => rq.getSettings().knowledge.maxStalledHandoffs,
        ...(rq.getDecision
          ? {
              worthGate: new WorthGate({
                db: rq.db,
                getDecision: rq.getDecision,
                recordDecision: (record) => deps.writeGate.recordCognitionDecision(record),
                recordSpend: (modelId, inputTokens) =>
                  recordDecisionSpend(
                    deps.writeGate,
                    cognitionSpendDay((rq.clock ?? Date.now)()),
                    WORTH_GATE_SPEND_MECHANISM,
                    modelId,
                    inputTokens,
                  ),
                clock: rq.clock ?? Date.now,
                idGen: () => crypto.randomUUID(),
                log: log.child("worth-gate"),
              }),
            }
          : {}),
        // Re-open the conversation debounce window on an in-flight-fold
        // resurrect — the conservative single choice (resurrects are dominated
        // by hot conversation threads; a rare document resurrect simply waits
        // the longer window). The ceiling, not this, bounds worst-case spend.
        getResurrectDebounceMs: () => rq.getSettings().conversationDebounceMs,
        ...(rq.clock ? { clock: rq.clock } : {}),
        ...(rq.drainIntervalMs !== undefined ? { drainIntervalMs: rq.drainIntervalMs } : {}),
        ...(rq.drainIdleMs !== undefined ? { drainIdleMs: rq.drainIdleMs } : {}),
        ...(rq.drainStartDelayMs !== undefined ? { drainStartDelayMs: rq.drainStartDelayMs } : {}),
        ...(rq.pruneIntervalMs !== undefined ? { pruneIntervalMs: rq.pruneIntervalMs } : {}),
      },
      rq.scheduler,
    );
    for (const task of bundle.tasks) rq.scheduler.schedule(task);
    rq.backgroundJobs.registerAll(bundle.jobs);
    deps.log.info(
      `Cognition Steward run-queue drainer started (transcripts at ${rq.transcriptsDir})`,
    );

    // One-shot: convert any `brain.sweeps` config overrides — the pre-file
    // authoring surface — into sweep files, so the operator has one place to
    // edit a sweep and one place to delete it. Behind a marker, because a
    // later "revert to system" deletes the file and must stay deleted.
    if (rq.sweeps) {
      const { getCognitionEngineState, COGNITION_SWEEP_CONFIG_MIGRATED_KEY } =
        await import("./storage/engine-state.js");
      if (getCognitionEngineState(rq.db, COGNITION_SWEEP_CONFIG_MIGRATED_KEY) === null) {
        const migrated = rq.sweeps.migrateLegacyOverrides(deps.getLegacySweepOverrides?.() ?? {});
        await deps.writeGate.setCognitionEngineState(COGNITION_SWEEP_CONFIG_MIGRATED_KEY, "1");
        if (migrated.length > 0) {
          log.warn(
            `brain.sweeps config overrides are deprecated — ${migrated.length} converted to files in ${rq.sweeps.directory}; the config key can now be deleted`,
          );
        }
      }
    }

    // Daily rhythm + decay sweep — the time-driven enqueuers feeding the
    // same queue the drainer executes. Lazy-loaded like the drainer.
    {
      const { createCognitionRhythmTasks } = await import("./rhythm/rhythm-tasks.js");
      // The analytics plane of daily-batch discovery: a source whose day
      // produced only samples (health, financial) still gets its batch. Only
      // wired when the run-queue carries an analytics store (production; some
      // seam-injected test setups omit it and stay document-only).
      const analyticsDb = rq.cognition?.analyticsDb;
      const rhythmBundle = createCognitionRhythmTasks(
        {
          db: rq.db,
          writeGate: deps.writeGate,
          log: log.child("rhythm"),
          isEnabled: () => briefsFeatureStatus(deps.registry, deps.readiness).active,
          getDailyRunHour: () => rq.getSettings().dailyRunHour,
          getExcludedSources: () => rq.getSettings().excludedSources,
          getDecayBackoff: () => {
            const s = rq.getSettings();
            return {
              backoffBaseMs: s.decayBackoffBaseMs,
              backoffCapMs: s.decayBackoffCapMs,
              datedFloorMs: s.decayDatedFloorMs,
              datedFraction: s.decayDatedFraction,
            };
          },
          // Proactive-lane producers — live knobs, re-read per tick so an
          // operator's disable takes effect without a restart.
          getSynthesisEnabled: () => rq.getSettings().synthesis.enabled,
          getSynthesisCadenceHours: () => rq.getSettings().synthesis.cadenceHours,
          getSynthesisMaxPerDay: () => rq.getSettings().synthesis.maxPerDay,
          getCollisionEnabled: () => rq.getSettings().collision.enabled,
          getCollisionCadenceHours: () => rq.getSettings().collision.cadenceHours,
          getCollisionMaxPerSweep: () => rq.getSettings().collision.maxPerSweep,
          getSelfPersonId: () => fetchSelfPersonId(rq.db),
          getCollisionTimeHorizonDays: () => rq.getSettings().collision.timeHorizonDays,
          getAnnotationContradictionsEnabled: () =>
            rq.getSettings().collision.annotationContradictions.enabled,
          getAnnotationContradictionsMaxPerSweep: () =>
            rq.getSettings().collision.annotationContradictions.maxPerSweep,
          getDigestEnabled: () => rq.getSettings().digest.enabled,
          getDigestHour: () => rq.getSettings().digest.hour,
          getDigestGraceMinutes: () => rq.getSettings().digest.graceMinutes,
          getObservationRetentionDays: () => rq.getSettings().observations.retentionDays,
          ...(rq.activity ? { getActiveRunCount: () => rq.activity!.count } : {}),
          isBudgetExhausted: () =>
            cognitionBudgetVerdict(rq.db, rq.getSettings().budget, (rq.clock ?? Date.now)())
              .exhausted,
          getSweepsEnabled: () => rq.getSettings().sweepsEnabled && rq.sweeps !== undefined,
          getSweeps: () => rq.sweeps?.list() ?? [],
          getMergeAdjudicationEnabled: () => rq.getSettings().mergeAdjudication.enabled,
          getBootstrapSettings: () => ({
            ...rq.getSettings().bootstrap,
            ...(knowledge ? { enabled: false } : {}),
            // One boundary for both lanes: the waker's window decides what is
            // live, and bootstrap takes everything on the other side of it.
            recencyWindowMs: rq.getSettings().recencyWindowMs,
            knowledgeRecentWindowMs: rq.getSettings().knowledge.recentWindowMs,
          }),
          // The re-verification sweep re-grounds ANNOTATIONS, so its
          // effective gate is reverification.enabled AND annotations.enabled:
          // with the annotations layer off, its runs would direct the agent
          // at tools excluded from the toolset. The periodic task's tick
          // gate, its isDisabled surface, and the sweep pass all read this
          // one closure, so they cannot disagree.
          getReverificationSettings: () => {
            const s = rq.getSettings();
            return {
              ...s.reverification,
              enabled: s.reverification.enabled && s.annotations.enabled,
            };
          },
          // The provenance recheck re-examines dependents of ANNOTATION
          // priors, so its effective gate is provenanceRecheck.enabled AND
          // annotations.enabled — same shape as the re-verification gate.
          getProvenanceRecheckSettings: () => {
            const s = rq.getSettings();
            return { enabled: s.provenanceRecheck.enabled && s.annotations.enabled };
          },
          ...(analyticsDb
            ? {
                listAnalyticsSampleSourceIds: (fromMs: number, toMs: number) =>
                  analyticsDb.listSourceIdsWithSamplesInRange(fromMs, toMs),
              }
            : {}),
          ...(rq.clock ? { clock: rq.clock } : {}),
          ...(rq.rhythmIntervalMs !== undefined ? { intervalMs: rq.rhythmIntervalMs } : {}),
          ...(rq.rhythmIdleMs !== undefined ? { idleMs: rq.rhythmIdleMs } : {}),
          ...(rq.rhythmStartDelayMs !== undefined ? { startDelayMs: rq.rhythmStartDelayMs } : {}),
        },
        rq.scheduler,
      );
      for (const task of rhythmBundle.tasks) rq.scheduler.schedule(task);
      rq.backgroundJobs.registerAll(rhythmBundle.jobs);
      deps.log.info(`Cognition Steward daily rhythm + decay sweep started`);
    }

    if (rq.eventBus) {
      // Real-time waker: hot-path-safe subscriber (in-memory buffer
      // only) + a background drain that enqueues debounced `data` runs.
      // Lazy-loaded like the drainer — inert builds never touch it.
      const [
        { createBriefsWakerBuffer, subscribeBriefsWaker },
        { briefsWakerDrainTask },
        { registerPriorContentInterest },
        { subscribeTemporalAnnotationInvalidator },
      ] = await Promise.all([
        import("./waker/event-handler.js"),
        import("./waker/drain-task.js"),
        import("../data/document-prior-content.js"),
        import("./temporal-annotation-invalidator.js"),
      ]);
      // Declare interest in pre-update bodies so `document.upserted`
      // carries `beforeContent` — what the diff engine feeds on.
      registerPriorContentInterest();
      const wakerLog = log.child("waker");
      const buffer = createBriefsWakerBuffer({ log: wakerLog });
      subscribeBriefsWaker({
        eventBus: rq.eventBus,
        buffer,
        getConfig: () => {
          const s = rq.getSettings();
          return {
            recencyWindowMs: s.recencyWindowMs,
            conversationDebounceMs: s.conversationDebounceMs,
            documentUpdateDebounceMs: s.documentUpdateDebounceMs,
            conversationMaxDeferMs: s.conversationMaxDeferMs,
            documentMaxDeferMs: s.documentMaxDeferMs,
            excludedSources: s.excludedSources,
          };
        },
        clock: rq.clock ?? (() => Date.now()),
      });
      // Temporal-annotation invalidation: a document content change drops
      // every live annotation grounded in it — a stale model-authored
      // interpretation is worse than a gap. Always on while cognition is
      // active.
      subscribeTemporalAnnotationInvalidator({
        db: rq.db,
        eventBus: rq.eventBus,
        invalidate: (docId, now) => deps.writeGate.invalidateTemporalAnnotationsForDoc(docId, now),
        isEnabled: () => briefsFeatureStatus(deps.registry, deps.readiness).active,
        clock: rq.clock ?? (() => Date.now()),
        log: log.child("temporal-annotations"),
      });
      const wakerBundle = briefsWakerDrainTask(
        {
          db: rq.db,
          writeGate: deps.writeGate,
          buffer,
          log: wakerLog,
          isEnabled: () => !knowledge && briefsFeatureStatus(deps.registry, deps.readiness).active,
          derivationBarrierMs: () => rq.getSettings().derivationBarrierMs,
          ...(rq.contentPending
            ? {
                contentPending: rq.contentPending,
                pendingContentBarrierMs: () => rq.getSettings().pendingContentBarrierMs,
              }
            : {}),
          activeDerivationStages: rq.activeDerivationStages ?? (() => DERIVATION_STAGES),
          ...(rq.clock ? { clock: rq.clock } : {}),
          ...(rq.wakerIntervalMs !== undefined ? { intervalMs: rq.wakerIntervalMs } : {}),
          ...(rq.wakerIdleMs !== undefined ? { idleMs: rq.wakerIdleMs } : {}),
          ...(rq.wakerStartDelayMs !== undefined ? { startDelayMs: rq.wakerStartDelayMs } : {}),
        },
        rq.scheduler,
      );
      rq.scheduler.schedule(wakerBundle.task);
      rq.backgroundJobs.registerAll([wakerBundle.job]);
      rq.activity?.attachWakeBacklog(wakerBundle.pendingWakes);
      deps.log.info(`Briefs real-time waker started`);
    }
  }
  return status;
}

/**
 * The observation pipeline's seams: the decision model for salience (at note
 * time and at the morning recheck), the entailment verifier for the
 * recheck's claim check, and the morning brief sender.
 */
async function observationRuntimeDeps(
  rq: BriefsRunQueueBootDeps,
  deps: {
    writeGate: WriteGate;
    morningBrief?: {
      getConversationPort():
        | import("./observations/morning-brief.js").MorningBriefConversationPort
        | null;
    };
  },
  log: Logger,
): Promise<NonNullable<import("./steward/runtime.js").CognitionRuntimeDeps["observations"]>> {
  const [
    { createObservationScorer },
    { OBSERVATION_SALIENCE_SPEND_MECHANISM },
    { nextMorningBriefAt },
  ] = await Promise.all([
    import("./observations/noting.js"),
    import("./observations/salience.js"),
    import("./observations/schedule.js"),
  ]);
  const clock = rq.clock ?? Date.now;
  const getDecision = rq.getDecision ?? (() => null);
  const recordSpend = (modelId: string, inputTokens: number) =>
    recordDecisionSpend(
      deps.writeGate,
      cognitionSpendDay(clock()),
      OBSERVATION_SALIENCE_SPEND_MECHANISM,
      modelId,
      inputTokens,
    );
  const thresholds = () => rq.getSettings().observations;
  return {
    recheck: {
      writes: deps.writeGate,
      getDecision,
      recordSpend,
      ...(rq.cognition?.getEntailmentVerifier
        ? { getEntailmentVerifier: rq.cognition.getEntailmentVerifier }
        : {}),
      thresholds,
      ...(rq.interest ? { interest: rq.interest } : {}),
    },
    createScorer: (runId) =>
      createObservationScorer(
        {
          db: rq.db,
          getDecision,
          recordSpend,
          recordDecision: (record) => deps.writeGate.recordCognitionDecision(record),
          thresholds,
          nextBriefAt: (now) => nextMorningBriefAt(now, rq.getSettings().digest.hour),
          log: log.child("observations"),
          ...(rq.interest ? { interest: rq.interest } : {}),
        },
        runId,
      ),
    sender: {
      getPort: () => deps.morningBrief?.getConversationPort() ?? null,
      markSent: (input, now) => deps.writeGate.markMorningBriefSent(input, now),
      suppressObservation: (id, now) =>
        deps.writeGate.transitionObservation(id, { state: "dropped", reason: "suppressed" }, now),
      getPushEnabled: () => rq.getSettings().digest.push,
    },
  };
}

/**
 * The context budget of one run. Only knowledge maintenance can resume from a
 * fresh context — its frontier is durable, so a successor continues where the
 * run stopped — so every other run is left to its backend's own limits.
 */
export function maintenanceContextBudget(
  run: Pick<ClaimedCognitionRun, "kind" | "payload">,
  settings: Pick<
    ResolvedBrainSettings["knowledge"],
    "contextHandoffRatio" | "contextHandoffTokens"
  >,
): CognitionContextBudget | null {
  const payload = run.kind === "synthesis" ? parseCognitionSynthesisRunPayload(run.payload) : null;
  if (payload?.focus !== "knowledge-maintenance" || !payload.batchId) return null;
  return { ratio: settings.contextHandoffRatio, fallbackTokens: settings.contextHandoffTokens };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Briefs feature gate — the single answer to "is Omnesis Briefs on?".
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
} from "@omnesis/core";
import { fetchSelfPersonId } from "../domain/InteractionScoreService.js";
import { chatRoleReadiness } from "../models/chat-role-readiness.js";
import { DERIVATION_STAGES, type DerivationStage } from "../domain/DocumentDerivation.js";
import { cognitionBudgetVerdict } from "./cognition/budget.js";
import { seedOpenLoopSourceMeta } from "./open-loop-source/source-meta.js";
import type { ChatRoleReadinessDeps } from "../models/chat-role-readiness.js";
import type { BriefJudge } from "./steward/brief-judge.js";
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
import type { SweepService } from "./sweeps/service.js";
import type { CognitionRunActivity } from "./run-activity.js";
import type { CognitionPromptBuilder, CognitionRunExecutionContext } from "./run-driver.js";
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
  /** Resolve the `background-agent` chat backend, fresh per run. */
  resolveBackend: () => ChatBackend | null;
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
   * around execution, `/admin/brain/runs` reads it. The composition root
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
    getEntailmentVerifier?: () => Promise<EntailCapability | null>;
    validateAnnotationEvidence?: import("./steward/tools.js").AnnotationToolDeps["validateAnnotationEvidence"];
    /**
     * Brief judge (push bar) resolver for `brief_create`. Optional — absent
     * (or resolving to null when the judge is disabled) leaves briefs
     * unjudged, exactly as before the judge existed.
     */
    getBriefJudge?: () => BriefJudge | null;
    /** Live privacy policy used by the mandatory subscription precision barrier. */
    policyStore?: { get(): Promise<{ revision: string }> };
  };
  /** Seam overrides for tests; production uses `cognition` instead. */
  promptBuilder?: CognitionPromptBuilder;
  buildTools?: (run: ClaimedCognitionRun) => ToolHandle[];
  systemPrompt?: () => string;
}

/**
 * Boot-time wiring for the Briefs feature. Experimental mode prepares the
 * runtime exactly once, even before a background model is assigned. Every
 * execution task reads the live `active` verdict, so a hot assignment starts
 * draining without a restart and removal immediately parks future work.
 * With experimental mode off, boot remains fully inert.
 * The waker and decay engine will start from here behind the same
 * verdict once they exist; this stays the feature's single boot
 * touchpoint.
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
   * Talk-back wiring ("reply to a brief"). When present and the feature is
   * active, bootBriefs installs the anchored-thread session profile on the
   * agent lifecycle and exposes the thread-open port the /briefs routes
   * call. Both callbacks are safe to invoke before the HTTP server exists.
   */
  talkback?: {
    setProfile(profile: import("../agent/service.js").AnchoredThreadProfile): void;
    expose(port: import("./talkback/talkback-service.js").BriefTalkbackPort): void;
    getAgentService(): import("../agent/service.js").AgentService | null;
  };
  /**
   * Top-level interactive-session write access (experimental). When present and
   * the feature is active, bootBriefs installs the interactive-write profile on
   * the agent lifecycle so a top-level chat can write into the substrate
   * (loops/briefs/temporal annotations/other annotations) with an interactive-origin run id.
   * Absent ⇒ interactive stays read-only.
   */
  interactiveWrite?: {
    setProfile(profile: import("../agent/service.js").InteractiveWriteProfile): void;
  };
  /** Carrier-agnostic notification publisher for the digest push tier. */
  push?: import("../push/broadcast.js").NotificationPublisher;
  /**
   * The deprecated `brain.sweeps` config record, read once at boot and
   * converted to sweep files. Omit once the key is gone from the schema.
   */
  getLegacySweepOverrides?: () => Record<string, import("./sweeps/service.js").LegacySweepOverride>;
}): Promise<BriefsFeatureStatus> {
  const status = briefsFeatureStatus(deps.registry, deps.readiness);
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
      promptBuilder?: CognitionPromptBuilder;
      systemPrompt?: () => string;
      buildOwnTools?: (runId: string) => ToolHandle[];
      validateRun?: (run: ClaimedCognitionRun) => string | null;
    } = {};
    if (rq.cognition && !rq.buildTools && !rq.promptBuilder && !rq.systemPrompt) {
      const { createCognitionRuntime } = await import("./steward/runtime.js");
      runtimeSeams = await createCognitionRuntime({
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
        ...(rq.cognition.getBriefJudge ? { getBriefJudge: rq.cognition.getBriefJudge } : {}),
        ...(rq.cognition.policyStore ? { policyStore: rq.cognition.policyStore } : {}),
        getSettings: rq.getSettings,
        ...(rq.getOperatorInstructions
          ? { getOperatorInstructions: rq.getOperatorInstructions }
          : {}),
        ...(rq.activeDerivationStages ? { activeDerivationStages: rq.activeDerivationStages } : {}),
        ...(rq.clock ? { clock: rq.clock } : {}),
        log,
      });
    }
    const buildTools = rq.buildTools ?? runtimeSeams.buildTools;
    const promptBuilder = rq.promptBuilder ?? runtimeSeams.promptBuilder;
    const systemPrompt = rq.systemPrompt ?? runtimeSeams.systemPrompt;
    const buildOwnTools = runtimeSeams.buildOwnTools;
    const validateRun = runtimeSeams.validateRun;

    if (deps.talkback && buildTools) {
      const [
        { createBriefTalkback },
        { buildTalkbackSystemPrompt },
        { readCognitionNotes },
        { resolveSelfMemory },
      ] = await Promise.all([
        import("./talkback/talkback-service.js"),
        import("./talkback/talkback-prompt.js"),
        import("./storage/notes.js"),
        import("./self-memory.js"),
      ]);
      const clock = rq.clock ?? (() => Date.now());
      deps.talkback.setProfile({
        // The thread runs on the Cognition Steward's own toolset; mutations stamp
        // a thread-scoped run id so the audit trail says where they came
        // from (`talkback_<briefId>`). The
        // payload carries the anchor id purely as reference.
        buildTools: (origin) => {
          const anchor = {
            id: `talkback_${origin.briefId}`,
            payload: { briefId: origin.briefId },
          };
          return buildTools({
            id: anchor.id,
            kind: "feedback",
            payload: anchor.payload,
            payloadJson: JSON.stringify(anchor.payload),
            attempts: 1,
          });
        },
        systemPrompt: () =>
          buildTalkbackSystemPrompt({
            notes: readCognitionNotes(rq.db),
            selfMemory: resolveSelfMemory(rq.db, rq.getSettings().annotations.enabled).selfMemory,
            operatorInstructions: rq.getOperatorInstructions?.() ?? "",
            now: new Date(clock()),
          }),
        resolveBackend: rq.resolveBackend,
      });
      deps.talkback.expose(
        createBriefTalkback({
          db: rq.db,
          writeGate: deps.writeGate,
          transcripts,
          getAgentService: deps.talkback.getAgentService,
          clock,
          log: log.child("talkback"),
        }),
      );
      log.info("brief talk-back wired (thread profile + open port)");
    }
    // Top-level interactive-session substrate write access: hand the agent
    // lifecycle a builder for the Cognition Steward's own mutating tools, stamped with
    // an interactive-origin run id. Only wired on the production path (where
    // buildOwnTools is populated) — test seam-override boots leave interactive
    // read-only, which is correct.
    if (deps.interactiveWrite && buildOwnTools) {
      deps.interactiveWrite.setProfile({ buildOwnTools });
      log.info("interactive-agent substrate write access wired");
    }
    const driver = new CognitionRunDriver({
      resolveBackend: rq.resolveBackend,
      transcripts,
      log,
      ...(buildTools ? { buildTools } : {}),
      ...(promptBuilder ? { promptBuilder } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(validateRun ? { validateRun } : {}),
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
        // Re-open the conversation debounce window on an in-flight-fold
        // resurrect — the conservative single choice (resurrects are dominated
        // by hot conversation threads; a rare document resurrect simply waits
        // the longer window). The ceiling, not this, bounds worst-case spend.
        getResurrectDebounceMs: () => rq.getSettings().conversationDebounceMs,
        ...(deps.push
          ? {
              digestPush: {
                getEnabled: () => rq.getSettings().digest.enabled && rq.getSettings().digest.push,
                send: async (brief, day) => {
                  const { sendDigestPush } = await import("./digest-push.js");
                  await sendDigestPush(
                    {
                      publisher: deps.push!,
                    },
                    brief,
                    day,
                    log,
                  );
                },
              },
            }
          : {}),
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
          ...(rq.activity ? { getActiveRunCount: () => rq.activity!.count } : {}),
          getSweepsEnabled: () => rq.getSettings().sweepsEnabled && rq.sweeps !== undefined,
          getSweeps: () => rq.sweeps?.list() ?? [],
          getMergeAdjudicationEnabled: () => rq.getSettings().mergeAdjudication.enabled,
          getBootstrapSettings: () => ({
            ...rq.getSettings().bootstrap,
            // One boundary for both lanes: the waker's window decides what is
            // live, and bootstrap takes everything on the other side of it.
            recencyWindowMs: rq.getSettings().recencyWindowMs,
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
        { subscribeBriefClaimInvalidator },
      ] = await Promise.all([
        import("./waker/event-handler.js"),
        import("./waker/drain-task.js"),
        import("../data/document-prior-content.js"),
        import("./temporal-annotation-invalidator.js"),
        import("./brief-claim-invalidator.js"),
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
      // brief-claim invalidation: a claim is a user-facing assertion resting
      // on a verbatim evidence quote — when the quote no longer appears in
      // the changed document, the claim is soft-dropped from the brief's
      // served set. Always on while the feature is active (claims exist
      // whenever briefs do; no per-subfeature knob).
      subscribeBriefClaimInvalidator({
        db: rq.db,
        eventBus: rq.eventBus,
        invalidate: (docId, now) => deps.writeGate.invalidateBriefClaimsForDoc(docId, now),
        isEnabled: () => briefsFeatureStatus(deps.registry, deps.readiness).active,
        clock: rq.clock ?? (() => Date.now()),
        log: log.child("brief-claims"),
      });
      const wakerBundle = briefsWakerDrainTask(
        {
          db: rq.db,
          writeGate: deps.writeGate,
          buffer,
          log: wakerLog,
          isEnabled: () => briefsFeatureStatus(deps.registry, deps.readiness).active,
          derivationBarrierMs: () => rq.getSettings().derivationBarrierMs,
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
      deps.log.info(`Briefs real-time waker started`);
    }
  }
  return status;
}

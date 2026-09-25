// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Assembly of the Cognition Steward proper — the three seams the run driver
 * takes (`buildTools` / `promptBuilder` / `systemPrompt`), filled with
 * the real toolset and prompts.
 *
 * Toolset contract: the background Cognition Steward gets an explicit ALLOW-LIST
 * of the interactive Omnesis agent's read tools
 * ({@link COGNITION_INTERACTIVE_TOOLS}) — the read set the system prompt
 * advertises plus `plan` — combined with the Cognition Steward's own
 * loop/brief/notes/schedule tools. It is an allow-list, not a denylist:
 * the full interactive registry is built and then filtered down to the
 * named tools, so any interactive-only tool (present or future) is
 * excluded by construction rather than by a carve-out that can drift.
 * The annotation/citation tools (`annotate`, `cite_record`) are the
 * reason this matters — they belong to interactive user sessions, where
 * their results materialize into `document_links` through the
 * omnesis-chat conversation-upsert path; a background transcript run has
 * no such path, so those tools would silently evaporate their output and
 * waste tokens. Trigger management and sub-agent delegation are excluded
 * the same way.
 *
 * `createCognitionRuntime` is the production wiring (gateway
 * collaborators → ports → toolset); `buildCognitionToolset` is the pure
 * composition seam tests drive with fake ports.
 */

import { buildBuiltinTools, PlanStore, type ToolHandle, type ToolPorts } from "@omnesis/agent";
import { experimentalVisible, type EntailCapability, type Logger } from "@omnesis/core";
import { isGrantedMutation } from "../cognition/authority.js";
import { cognitiveWorkflowIdForRun } from "../cognition/workflows.js";

import { runWithPriority } from "../../priority.js";
import { createGatewayTemporalPort } from "../../enrichment/temporal/interactive-temporal-port.js";
import { TemporalQueryService } from "../../enrichment/temporal/temporal-query-service.js";
import { createGatewayEntityContextPort } from "../../domain/cognitive-graph/interactive-entity-context-port.js";
import { readCognitionNotes } from "../storage/notes.js";
import { resolveSelfMemory } from "../self-memory.js";
import {
  parseCognitionDataRunPayload,
  parseCognitionBootstrapRunPayload,
  parseCognitionDigestRunPayload,
  parseCognitionMergeAdjudicationRunPayload,
  parseCognitionSweepRunPayload,
  runScopeLoopId,
  cognitionBriefLane,
  type CognitionBriefLane,
} from "../run-payloads.js";
import { buildMergeAdjudicationTool } from "../merge-adjudication.js";
import { currentEvidenceFingerprint, getMergeCandidateById } from "../../merge-candidates.js";
import { getOpenLoop } from "../storage/open-loops.js";
import { systemClock, type ClaimedCognitionRun, type Clock } from "../storage/types.js";
import { resolveAddressedEntries } from "../addressed-entry-context.js";
import { loadDigestHorizon, localTimeZone } from "./digest-horizon.js";
import {
  loadNearbyTimelineContext,
  type NearbyTimelineContext,
} from "./nearby-timeline-context.js";
import {
  buildCognitionOwnTools,
  COGNITION_MUTATING_TOOL_NAMES,
  type AnnotationToolDeps,
  type CognitionToolDeps,
  type CognitionWriteOps,
} from "./tools.js";
import { buildCognitionRunPrompt, buildCognitionSystemPrompt } from "./prompts.js";
import { RunConsumptionTracker } from "./consumption.js";
import { createOpenLoopMirror, type OpenLoopMirror } from "./mirror.js";
import type { PersonLookupGate } from "../../domain/person-lookup.js";
import type { BriefJudge } from "./brief-judge.js";
import type Database from "better-sqlite3";
import type { AnalyticsDb } from "../../analytics-db.js";
import type { SearchPipeline } from "../../search/pipeline.js";
import type { SyncStatusRegistry } from "../../sync-status.js";
import type { WriteGate } from "../../write-gate.js";
import type { DerivationStage } from "../../domain/DocumentDerivation.js";
import type { ResolvedBrainSettings } from "../config.js";
import type { CognitionRunExecutionContext } from "../run-driver.js";

type Db = Database.Database;

/** The run driver's three injectable seams, filled. */
export interface CognitionRuntime {
  buildTools: (run: ClaimedCognitionRun, context?: CognitionRunExecutionContext) => ToolHandle[];
  promptBuilder: (run: ClaimedCognitionRun) => string | Promise<string>;
  systemPrompt: () => string;
  /**
   * Build ONLY the Cognition Steward's own mutating tools (open loops, briefs, notes,
   * schedule, annotate, temporal annotation), stamped with `runId` as their
   * `created_by_run`. The top-level interactive agent augments its read
   * registry with these so user-provided facts can be written straight into the
   * substrate; the run id (`interactive_<conversationId>`) marks the provenance
   * distinctly. No base read tools (the interactive registry already carries
   * them), no per-run seed docs / triggering loop (an interactive turn is
   * user-driven, not scoped to a single datum). Guardrails live at the tool
   * boundary, so reuse is safe.
   */
  buildOwnTools: (runId: string) => ToolHandle[];
}

/**
 * The interactive Omnesis tools the background Cognition Steward is allowed to
 * have: the read set the steward system prompt advertises
 * (`prompts.ts`) plus `plan`. An allow-list, not a denylist —
 * {@link buildCognitionToolset} builds the full interactive registry and
 * keeps only these names, so any interactive-only tool (annotation and
 * citation — `annotate_many` / `cite_record` — trigger management, sub-agent
 * delegation, or any added later) is excluded by construction. Extend
 * this set only to grant the background agent a genuinely new read tool.
 */
export const COGNITION_INTERACTIVE_TOOLS: ReadonlySet<string> = new Set([
  "search_many",
  "fetch_many",
  "trace_connections",
  "run_sql",
  "lookup_people",
  "lookup_document_by_url",
  "plan",
  // Read-only temporal lookup — shared with the interactive agent (only the
  // LLM-owned annotation mutation surface is a steward own tool).
  "temporal_query",
  // Read-only cognitive reap — shared with the interactive agent.
  "entity_context",
]);

export interface CognitionToolsetDeps {
  db: Db;
  writeGate: CognitionWriteOps;
  /**
   * The interactive agent's tool ports. The full registry is built from
   * these and then filtered to {@link COGNITION_INTERACTIVE_TOOLS}, so
   * only the allow-listed read tools ever survive — however many ports
   * the caller wires. A `subagent` or `record` port passed here yields no
   * tool, because its tool name is not on the list.
   */
  basePorts: ToolPorts;
  /**
   * Plan store for the `plan` tool. Omit to get a fresh one per toolset
   * build — right for background runs, where each run is its own session
   * and per-session plan state must not accumulate across runs.
   */
  planStore?: PlanStore;
  mirror: OpenLoopMirror;
  getNotesMaxBytes: () => number;
  clock: Clock;
  idGen?: () => string;
  log: Logger;
  /** Advertise experimental surfaces to the steward (default: gateway mode). */
  experimental?: boolean;
  /**
   * Live config knobs for `open_loop_search`'s identity reconcile pass. Read
   * per toolset build so a config change takes on the next run. Omitted by
   * pure-composition unit tests — identity then falls back to person + link
   * signals with the graph-service default fanout (deadline signal off).
   */
  getReconcileSettings?: () => { neighborFanout: number; deadlineWindowMs: number };
  /**
   * Live annotation knobs, read per toolset build. Omitted by pure-
   * composition unit tests → the `annotate_durable` tool stays absent.
   */
  getAnnotationSettings?: () => {
    enabled: boolean;
    confidenceCeiling: number;
    basisCeilings: { quoted: number; inferred: number; synthesized: number };
    confidenceFloor: number;
  };
  /**
   * Resolve the entailment verifier for the annotation firewall (fresh per
   * call — the gateway-level service caches per assignment signature).
   * Omitted, or resolving to null (role unset), the gate is absent and
   * annotation writes are unchanged.
   */
  getEntailmentVerifier?: () => Promise<EntailCapability | null>;
  validateAnnotationEvidence?: AnnotationToolDeps["validateAnnotationEvidence"];
  /**
   * Resolve the brief judge (the push bar) for `brief_create`. Omitted, or
   * resolving to null (judge disabled), the gate is absent and briefs ship
   * unjudged.
   */
  getBriefJudge?: () => BriefJudge | null;
}

/**
 * The documents a run reconciles from — its `seedDocIds`. A `data` run seeds
 * from its datum; a loop-scoped check (decay or a `time_based` tied to a
 * loop) seeds from that loop's documents so it re-reconciles the loop's
 * neighbourhood. Every other run kind has no single datum focus → no seeds,
 * and `open_loop_search` stays lexical + semantic.
 */
function cognitionSeedDocIds(db: Db, run: ClaimedCognitionRun): string[] {
  const data = parseCognitionDataRunPayload(run.payload);
  if (data) return [data.docId];
  const boot = parseCognitionBootstrapRunPayload(run.payload);
  if (boot) return [boot.docId];
  const loopId = runScopeLoopId(run.payload);
  if (loopId !== undefined) {
    const loop = getOpenLoop(db, loopId);
    if (loop) return loop.docs;
  }
  return [];
}

/** Compose the full per-run toolset: allow-listed read tools + the Cognition Steward's own. */
export function buildCognitionToolset(
  deps: CognitionToolsetDeps,
  run: ClaimedCognitionRun,
  opts: { consumption?: RunConsumptionTracker } = {},
): ToolHandle[] {
  // Build the full interactive registry, then keep only the allow-listed
  // read tools. Filtering the assembled handles — rather than trusting
  // the caller to withhold ports — is the single, drift-proof gate: an
  // interactive-only tool (annotate / cite_record / subagent) is dropped
  // here even if its port is wired.
  const base = buildBuiltinTools({
    ports: deps.basePorts,
    planStore: deps.planStore ?? new PlanStore(),
    experimental: deps.experimental ?? experimentalVisible(),
  }).filter((t) => COGNITION_INTERACTIVE_TOOLS.has(t.name));
  // The loop this run is itself scoped to (a loop-scoped time_based / decay
  // check), so `schedule_agent_run` can auto-attach it to a follow-up check.
  const triggeringLoopId = runScopeLoopId(run.payload);
  const sweepId = parseCognitionSweepRunPayload(run.payload)?.sweepId;
  const own = buildCognitionOwnTools(
    ownToolsInput(deps, {
      runId: run.id,
      seedDocIds: cognitionSeedDocIds(deps.db, run),
      briefLane: cognitionBriefLane(run),
      // Present only on a sweep run: what the judge held is the one production
      // number that cannot be recovered from `created_by_run` afterwards, so
      // the tool records it against the sweep as it happens.
      ...(sweepId !== undefined ? { sweepId } : {}),
      ...(triggeringLoopId !== undefined ? { triggeringLoopId } : {}),
      ...(opts.consumption ? { consumption: opts.consumption } : {}),
    }),
  );
  // A merge-adjudication run gets its one dedicated verdict tool, scoped to
  // the run's own candidate. Background runs only — the interactive own-tools
  // path never carries it.
  if (run.kind === "merge_adjudication") {
    const payload = parseCognitionMergeAdjudicationRunPayload(run.payload);
    if (payload) {
      // Capture the evidence now, alongside the prompt that presents it, so
      // the verdict is stamped against what the model was actually shown.
      const candidate = getMergeCandidateById(deps.db, payload.candidateId);
      own.push(
        buildMergeAdjudicationTool({
          db: deps.db,
          writeGate: deps.writeGate,
          runId: run.id,
          candidateId: payload.candidateId,
          ...(candidate
            ? { judgedEvidenceFingerprint: currentEvidenceFingerprint(candidate) }
            : {}),
          log: deps.log,
        }),
      );
    }
  }
  // Mutation authority, enforced rather than requested. Each workflow declares
  // which artifacts it may write; every other mutating verb is dropped, so a
  // run cannot call one however its prompt drifts. Reads are untouched — a
  // background run that cannot look widely reasons badly, and reading leaves
  // nothing behind.
  //
  // A tool is kept when it is a read (`mutates` unset) or an explicitly
  // granted mutation. Keying on the tool's own `mutates` flag rather than on
  // a separate name list means a mutating tool added later is withheld until
  // it is granted, instead of being allowed by omission.
  return [...base, ...withGrantedMutationsOnly(own, run)];
}

/**
 * Drop every mutating tool the run's workflow was not granted.
 *
 * Exported so the late-attached tools — the ones the runtime appends after the
 * toolset is composed — pass through the same gate rather than around it.
 */
export function withGrantedMutationsOnly(
  tools: ToolHandle[],
  run: ClaimedCognitionRun,
): ToolHandle[] {
  const workflowId = cognitiveWorkflowIdForRun(run.kind, run.payload);
  return tools.filter((t) => t.mutates !== true || isGrantedMutation(workflowId, t.name));
}

/**
 * Assemble the {@link CognitionToolDeps} for `buildCognitionOwnTools` from the
 * toolset deps + the per-invocation `runId` / `seedDocIds` / optional
 * `triggeringLoopId`. One place so the full-toolset and interactive-own paths
 * can't drift on which settings they thread through.
 */
function ownToolsInput(
  deps: CognitionToolsetDeps,
  opts: {
    runId: string;
    seedDocIds: readonly string[];
    briefLane: CognitionBriefLane;
    sweepId?: string;
    triggeringLoopId?: string;
    consumption?: RunConsumptionTracker;
  },
): CognitionToolDeps {
  const reconcile = deps.getReconcileSettings?.();
  const annotations = deps.getAnnotationSettings?.();
  return {
    db: deps.db,
    writeGate: deps.writeGate,
    searchPort: deps.basePorts.search,
    ...(deps.basePorts.temporal ? { temporalPort: deps.basePorts.temporal } : {}),
    mirror: deps.mirror,
    getNotesMaxBytes: deps.getNotesMaxBytes,
    clock: deps.clock,
    runId: opts.runId,
    seedDocIds: opts.seedDocIds,
    briefLane: opts.briefLane,
    ...(opts.sweepId !== undefined ? { sweepId: opts.sweepId } : {}),
    ...(reconcile
      ? {
          reconcileNeighborFanout: reconcile.neighborFanout,
          reconcileDeadlineWindowMs: reconcile.deadlineWindowMs,
        }
      : {}),
    ...(annotations
      ? {
          annotationsEnabled: annotations.enabled,
          annotationConfidenceCeiling: annotations.confidenceCeiling,
          annotationBasisCeilings: annotations.basisCeilings,
          annotationConfidenceFloor: annotations.confidenceFloor,
        }
      : {}),
    ...(deps.validateAnnotationEvidence
      ? { validateAnnotationEvidence: deps.validateAnnotationEvidence }
      : {}),
    ...(deps.getEntailmentVerifier ? { getEntailmentVerifier: deps.getEntailmentVerifier } : {}),
    ...(deps.getBriefJudge ? { getBriefJudge: deps.getBriefJudge } : {}),
    ...(opts.triggeringLoopId !== undefined ? { triggeringLoopId: opts.triggeringLoopId } : {}),
    ...(opts.consumption ? { consumption: opts.consumption } : {}),
    ...(deps.idGen ? { idGen: deps.idGen } : {}),
    log: deps.log,
  };
}

/**
 * The Cognition Steward's own MUTATING tools stamped with an interactive-origin
 * `runId`, for a TOP-LEVEL interactive session (never a sub-agent). Filtered to
 * the mutating set: the interactive registry already carries its own read tools
 * (search/fetch/loop-read), so only the write surface is added — a user-provided
 * fact flows straight into the substrate. Reuses the exact
 * `buildCognitionOwnTools` implementations, so the boundary guardrails hold
 * whether the writer is the background agent or a user-driven chat.
 */
export function buildCognitionInteractiveOwnTools(
  deps: CognitionToolsetDeps,
  runId: string,
): ToolHandle[] {
  // The mutating verbs, plus annotation_search: the reconcile-before-record
  // discipline (search what you already believe, then revise/supersede by id)
  // needs the read verb wherever the write verbs are callable — revise/retract
  // take an annotation id that no other interactive surface exposes.
  //
  // Consumption provenance runs here too, with a fresh per-toolset tracker
  // seeded only by annotation_search — the interactive session's other prior
  // surfaces live outside this module's reach, and search-then-write is the
  // dominant interactive pattern.
  return buildCognitionOwnTools({
    ...ownToolsInput(deps, {
      runId,
      seedDocIds: [],
      // The interactive surface is not a background lane: its cards face the
      // strict bar, like any reactive one.
      briefLane: "reactive",
      consumption: new RunConsumptionTracker(),
    }),
    // User-directed memory remains available when background annotation
    // creation is disabled. Its search shares this toolset's consumption tracker.
    annotationsEnabled: true,
  }).filter((t) => COGNITION_MUTATING_TOOL_NAMES.has(t.name) || t.name === "annotation_search");
}

export interface CognitionRuntimeDeps {
  db: Db;
  writeGate: WriteGate;
  searchPipeline: SearchPipeline;
  syncStatus: SyncStatusRegistry;
  analyticsDb: AnalyticsDb;
  /** index.db handle for the deleted-mirror chunk cascade. Optional. */
  indexDb?: Db;
  /**
   * Read-worker gate for `lookup_people`. Wired, the background agent's person
   * lookups run off the main event loop at BACKGROUND priority (so they never
   * jump ahead of interactive traffic); absent, they run synchronously.
   */
  personLookupGate?: PersonLookupGate;
  getSettings: () => ResolvedBrainSettings;
  /** Entailment verifier resolver for the annotation firewall. Optional. */
  getEntailmentVerifier?: () => Promise<EntailCapability | null>;
  validateAnnotationEvidence?: AnnotationToolDeps["validateAnnotationEvidence"];
  /** Brief judge (push bar) resolver for `brief_create`. Optional — absent leaves briefs unjudged. */
  getBriefJudge?: () => BriefJudge | null;
  policyStore?: { get(): Promise<{ revision: string }> };
  /** Derivation stages whose producer is running — see CognitionRunPromptDeps. */
  activeDerivationStages?: () => readonly DerivationStage[];
  /**
   * The operator's `OMNESIS.md`, re-read per run so an edit reaches the next
   * one without a restart. Absent on a gateway with no config directory.
   */
  getOperatorInstructions?: () => string;
  clock?: Clock;
  log: Logger;
}

/**
 * Wrap a {@link PersonLookupGate} so every enqueue runs inside a
 * `runWithPriority("background")` scope — the io task defaults to `user`
 * priority, and the background Cognition Steward must not jump its person lookups
 * ahead of interactive requests on the shared read-worker pool.
 *
 * Exported for the QoS-contract test: this demotion is the load-bearing
 * guarantee that background person lookups can't preempt interactive traffic,
 * so it is proven directly rather than left to inspection.
 */
export function backgroundLookupGate(gate: PersonLookupGate): PersonLookupGate {
  return {
    lookupPeople: async (query, limit, opts) =>
      runWithPriority("background", () => gate.lookupPeople(query, limit, opts)),
  };
}

/** Production wiring: gateway collaborators → the driver's three seams. */
export async function createCognitionRuntime(
  deps: CognitionRuntimeDeps,
): Promise<CognitionRuntime> {
  const clock = deps.clock ?? systemClock;
  // Ports and the index-write-gate import stay lazy so the (heavy) agent
  // ports module only enters the graph when the feature is active — this
  // module itself is lazy-loaded by bootBriefs for the same reason.
  const [ports, indexGate] = await Promise.all([
    import("../../agent/ports.js"),
    deps.indexDb ? import("../../indexer/index-write-gate.js") : Promise.resolve(null),
  ]);

  const basePorts: ToolPorts = {
    search: ports.createGatewaySearchPort(deps.searchPipeline, deps.syncStatus, deps.db),
    document: ports.createGatewayDocumentPort(deps.db, deps.syncStatus),
    documentByUrl: ports.createGatewayDocumentByUrlPort(deps.db, deps.syncStatus),
    trail: ports.createGatewayTrailPort(deps.db, deps.analyticsDb),
    sql: ports.createGatewaySqlPort(deps.analyticsDb),
    record: ports.createGatewayRecordPort(deps.db, deps.analyticsDb),
    // Background runs enqueue `lookup_people` at BACKGROUND priority so they
    // never preempt interactive traffic on the read-worker pool. Absent a gate,
    // the port falls back to a synchronous main-thread assembly.
    person: ports.createGatewayPersonPort(
      deps.db,
      deps.personLookupGate ? { lookupGate: backgroundLookupGate(deps.personLookupGate) } : {},
    ),
    // Read-only temporal lookup — surfaced as `temporal_query` via the
    // allow-list, so the background agent can reconcile annotations with
    // source-owned projections and prior annotations.
    temporal: createGatewayTemporalPort(deps.db, deps.analyticsDb),
    // Read-only cognitive reap — surfaced as `entity_context` via the allow-list,
    // so the background agent can pull an entity's linked neighbourhood in one call.
    entityContext: createGatewayEntityContextPort(deps.db),
    // The read ports available to the background agent. The `subagent`
    // port is not wired: delegation from a background run is future work.
    // Which of these ports surface as tools is decided by the allow-list in
    // buildCognitionToolset, not by this set: `record` is wired, but its
    // only tool (`cite_record`) is interactive-only and off the list, so
    // it never reaches the background agent.
  };

  const indexWriteGate =
    indexGate && deps.indexDb ? indexGate.directIndexWriteGate(deps.indexDb) : null;
  const mirror = createOpenLoopMirror({
    db: deps.db,
    writeGate: deps.writeGate,
    ...(indexWriteGate
      ? { deleteIndexChunks: (docIds: string[]) => indexWriteGate.deleteChunksByDocuments(docIds) }
      : {}),
    log: deps.log,
  });

  const toolsetDeps: CognitionToolsetDeps = {
    db: deps.db,
    writeGate: deps.writeGate,
    basePorts,
    mirror,
    getNotesMaxBytes: () => deps.getSettings().notesMaxBytes,
    getReconcileSettings: () => ({
      neighborFanout: deps.getSettings().reconcileNeighborFanout,
      deadlineWindowMs: deps.getSettings().reconcileDeadlineWindowMs,
    }),
    getAnnotationSettings: () => ({
      enabled: deps.getSettings().annotations.enabled,
      confidenceCeiling: deps.getSettings().annotationConfidenceCeiling,
      basisCeilings: deps.getSettings().annotationBasisCeilings,
      confidenceFloor: deps.getSettings().annotationConfidenceFloor,
    }),
    ...(deps.validateAnnotationEvidence
      ? { validateAnnotationEvidence: deps.validateAnnotationEvidence }
      : {}),
    ...(deps.getEntailmentVerifier ? { getEntailmentVerifier: deps.getEntailmentVerifier } : {}),
    ...(deps.getBriefJudge ? { getBriefJudge: deps.getBriefJudge } : {}),
    clock,
    log: deps.log,
  };

  // Per-run consumption trackers, keyed on the claimed-run OBJECT the driver
  // passes to both `buildTools` and `promptBuilder` — the WeakMap shares one
  // tracker across the two seams without any lifecycle bookkeeping (a settled
  // run's tracker is garbage-collected with its row object).
  const consumptionByRun = new WeakMap<ClaimedCognitionRun, RunConsumptionTracker>();
  const temporalQuery = new TemporalQueryService(deps.db, deps.analyticsDb);
  const successfulDocumentReadsByRun = new WeakMap<ClaimedCognitionRun, Set<string>>();
  const consumptionFor = (run: ClaimedCognitionRun): RunConsumptionTracker => {
    let tracker = consumptionByRun.get(run);
    if (!tracker) {
      tracker = new RunConsumptionTracker();
      consumptionByRun.set(run, tracker);
    }
    return tracker;
  };

  return {
    buildTools: (run, executionContext) => {
      const consumption = consumptionFor(run);
      // The injected self-memory counts as consumed on every run — the same
      // read the system prompt renders from, so the seed matches what the
      // model actually sees.
      consumption.note("person", [
        ...resolveSelfMemory(deps.db, deps.getSettings().annotations.enabled).annotationIds,
      ]);
      const tools = buildCognitionToolset(toolsetDeps, run, { consumption });
      let successfulReads = successfulDocumentReadsByRun.get(run);
      if (!successfulReads) {
        successfulReads = new Set<string>();
        successfulDocumentReadsByRun.set(run, successfulReads);
      }
      const fetchManyIndex = tools.findIndex((tool) => tool.name === "fetch_many");
      if (fetchManyIndex >= 0) {
        const fetchMany = tools[fetchManyIndex]!;
        tools[fetchManyIndex] = {
          ...fetchMany,
          async invoke(rawArgs, context) {
            const result = await fetchMany.invoke(rawArgs, context);
            if (
              result.kind === "document.batch" &&
              rawArgs !== null &&
              typeof rawArgs === "object" &&
              Array.isArray((rawArgs as { documents?: unknown }).documents)
            ) {
              const requested = (rawArgs as { documents: Array<{ documentId?: unknown }> })
                .documents;
              result.items.forEach((item, index) => {
                const requestedId = requested[index]?.documentId;
                if (
                  item.kind === "document" &&
                  typeof requestedId === "string" &&
                  item.ref.documentId === requestedId
                ) {
                  successfulReads!.add(requestedId);
                }
              });
            }
            return result;
          },
        };
      }
      return tools;
    },
    buildOwnTools: (runId) => buildCognitionInteractiveOwnTools(toolsetDeps, runId),
    // Read settings live per run so a config change (and the delta-prime caps
    // it carries) takes on the next run, matching getReconcileSettings above.
    promptBuilder: async (run) => {
      const dataPayload = run.kind === "data" ? parseCognitionDataRunPayload(run.payload) : null;
      const datumProjections = dataPayload
        ? (
            await temporalQuery.query({
              from: "1900",
              to: "2300",
              timeZone: "UTC",
              origins: ["projection"],
              documentIds: [dataPayload.docId],
              limit: 100,
            })
          ).items
        : undefined;
      let nearbyTimeline: NearbyTimelineContext | undefined;
      if (dataPayload?.changedAddressedEntryIds !== undefined) {
        const addressed = resolveAddressedEntries(
          deps.db,
          dataPayload.docId,
          dataPayload.changedAddressedEntryIds,
        );
        nearbyTimeline = await loadNearbyTimelineContext(temporalQuery, {
          entries: addressed.entries,
          triggerDocId: dataPayload.docId,
          missingIds: addressed.missingIds,
          entryIdsTruncated: dataPayload.addressedEntriesTruncated,
          metadataUnavailable: addressed.metadataUnavailable,
          now: clock(),
          onError: (entryId, error) => {
            const message = error instanceof Error ? error.message : String(error);
            deps.log.warn(
              `Nearby timeline unavailable for addressed entry ${JSON.stringify(entryId)}: ${JSON.stringify(message)}`,
            );
          },
        });
      }
      // The digest composes editorially and is told not to re-derive the world,
      // so its forward horizon must be resolved here — across BOTH temporal
      // origins, or the brief cannot see a plain calendar event.
      const isDigest = run.kind === "daily" && parseCognitionDigestRunPayload(run.payload) !== null;
      const digestHorizon = isDigest
        ? await loadDigestHorizon(temporalQuery, clock(), localTimeZone()).catch((err: unknown) => {
            // The temporal read rejects an out-of-vocabulary stored row rather
            // than relabelling the fact. That is right for a general read
            // model, but the digest is a once-a-day user-visible artifact
            // whose own readiness barrier already prefers an incomplete brief
            // to none — so one bad row costs the horizon, not the morning.
            deps.log.warn(
              `Digest horizon unavailable, composing without it: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            return undefined;
          })
        : undefined;
      const presentedRefileIds: string[] = [];
      const basePrompt = buildCognitionRunPrompt(run, {
        db: deps.db,
        clock,
        cfg: deps.getSettings(),
        datumProjections,
        nearbyTimeline,
        ...(digestHorizon ? { digestHorizon } : {}),
        // Priors the per-kind prompts inline (the synthesis/sweep delta-prime,
        // verification and contradiction batches) count as consumed too.
        onAnnotationsInlined: (store, ids) => consumptionFor(run).note(store, ids),
        onTemporalRefilePresented: (ids) => presentedRefileIds.push(...ids),
        ...(deps.activeDerivationStages
          ? { activeDerivationStages: deps.activeDerivationStages }
          : {}),
      });
      // Stamp the churn casualties this prompt listed with the run's id — the
      // re-file lookup retires them once THIS run completes, and re-presents
      // them if it fails. Stamped before the model sees the prompt so a
      // duplicate presentation cannot race the run's own writes. If the
      // stamp itself rejects, the whole prompt build throws and the attempt
      // fails through the ordinary retry path — the casualties simply stay
      // pending, which is the safe side.
      if (presentedRefileIds.length > 0) {
        await deps.writeGate.markTemporalAnnotationsRefilePresented(presentedRefileIds, run.id);
      }
      return basePrompt;
    },
    systemPrompt: () => {
      // Self-memory: the self person's live annotations, injected as the
      // standing profile of the user. Gated on the annotation feature (person
      // annotations are part of it); the self id lets the agent write more.
      const annotationsOn = deps.getSettings().annotations.enabled;
      const { selfPersonId, selfMemory } = resolveSelfMemory(deps.db, annotationsOn);
      return buildCognitionSystemPrompt({
        notes: readCognitionNotes(deps.db),
        notesMaxBytes: deps.getSettings().notesMaxBytes,
        now: new Date(clock()),
        annotationsEnabled: annotationsOn,
        selfPersonId,
        selfMemory,
        operatorInstructions: deps.getOperatorInstructions?.() ?? "",
      });
    },
  };
}

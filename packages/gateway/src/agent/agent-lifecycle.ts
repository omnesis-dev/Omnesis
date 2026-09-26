// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Construction of the in-gateway demo {@link AgentService}.
 *
 * Both the boot path and the model-swap path build an `AgentService` the same
 * way — same ports, same system-prompt thunk, same broadcast/store wiring — so
 * that wiring lives here once and the composition root (and the swap handler)
 * just supply the per-assignment `ChatBackend` factory.
 *
 * The dependencies that are created after this module's callers run — the
 * trigger orchestrator and the omnesis-chat runtime — are injected as getters
 * so they resolve lazily at agent-construction time rather than being captured
 * eagerly.
 */

import { join } from "node:path";
import {
  AnthropicBackend,
  HttpAgentBackend,
  buildBuiltinTools,
  createBuiltinSpecialistRegistry,
  type ChatBackend,
} from "@omnesis/agent";
import {
  createLogger,
  resolveModelDisplay,
  experimentalVisible,
  CLOUD_EGRESS_DISABLED_REASON,
  type CapabilityRole,
  type Logger,
} from "@omnesis/core";
import { CONFIG_DEFAULTS } from "@omnesis/config";
import { SCOPE_ADMIN } from "@omnesis/types";

import { resolveAnthropicApiKey } from "../model-credentials.js";
import { directIndexWriteGate } from "../indexer/index-write-gate.js";
import { bootOmnesisChat } from "../sources/omnesis-chat/index.js";
import { listSources } from "../data/repositories/SourceRepository.js";
import { retainOmnesisChatConversation } from "../sources/omnesis-chat/wiring.js";
import { createGatewayLoopReadPort } from "../brain/interactive-loop-port.js";
import { createGatewayTemporalPort } from "../enrichment/temporal/interactive-temporal-port.js";
import { createGatewayEntityContextPort } from "../domain/cognitive-graph/interactive-entity-context-port.js";
import { resolveSelfMemory } from "../brain/self-memory.js";
import { AnswerService } from "../privacy/answer-service.js";
import { PrivacyPolicyStore } from "../privacy/policy-store.js";
import { PrivacyAdminService } from "../privacy/admin-service.js";
import { PrivacyReviewer } from "../privacy/reviewer.js";
import { cognitionSpendDay } from "../brain/storage/spend.js";
import { toCognitionRunUsage } from "../brain/run-driver.js";
import { renderOperatorInstructionsSection } from "../instructions/render.js";
import { makeReplayBackendFactory } from "./replay-factory.js";
import {
  ConversationReadStateService,
  resolveViewingTtlMs,
  type ConversationReadStatePort,
} from "./conversation-read-state-service.js";
import {
  createGatewayDocumentByUrlPort,
  createGatewayDocumentPort,
  createGatewayPersonPort,
  createGatewayRecordPort,
  createGatewaySearchPort,
  createGatewaySqlPort,
  createGatewayTrailPort,
} from "./ports.js";
import { createGatewayWatchPort, type WatchFiringRecord } from "./watch-port.js";
import { AgentService, type AgentAnswerNotification, type AgentPromptContext } from "./service.js";
import { StoredConversationReader } from "./conversation-reader.js";
import {
  buildSystemPrompt,
  renderSourceRestrictedAnswerSection,
  rendersTimeline,
} from "./system-prompt.js";
import type { ConversationNotification } from "./conversation-notifier.js";
import type { WatchDefinition } from "@omnesis/watch";
import type { PreflightOutcome } from "../watch/preflight.js";
import type { AuthorWatchDeps } from "../watch/authoring.js";
import type { AnthropicCatalogEntry, ModelTokenLimits } from "@omnesis/core/models";
import type { FsConversationStore } from "./conversation-store.js";
import type { DeviceWsServer } from "../ws.js";
import type { SyncStatusRegistry } from "../sync-status.js";
import type { OmnesisChatRuntime } from "../sources/omnesis-chat/index.js";
import type { SearchPipeline } from "../search/pipeline.js";
import type { AnalyticsDb } from "../analytics-db.js";
import type { WriteGate } from "../write-gate.js";
import type { InferenceRegistry } from "../inference/registry.js";
import type { ConfigStore } from "../config-store.js";
import type { WsEventHandler } from "../http/services/WsEventHandler.js";
import type { AgentRoutesDeps } from "../http/routes/agent.js";
import type { CodexRuntimeService } from "../models/codex-runtime-service.js";
import type { PersonLookupGate } from "../domain/person-lookup.js";
import type { CorpusAuthorization } from "../access/corpus-authorization.js";
import type Database from "better-sqlite3";
import type { OperatorInstructionsStore } from "../instructions/store.js";
import type { ResolvedSpecialist } from "./subagent-service.js";

export const PRIVACY_STATE_SWEEP_INTERVAL_MS = 60_000;

/** Collaborators the agent's gateway ports and event wiring need. */
export interface AgentServiceDeps {
  db: Database.Database;
  searchPipeline: SearchPipeline;
  syncStatus: SyncStatusRegistry;
  analyticsDb: AnalyticsDb;
  writeGate: WriteGate;
  wsServer: DeviceWsServer;
  conversationStore: FsConversationStore;
  /** Read handle on index.db, where chunk embeddings live. Optional. */
  indexDb?: Database.Database;
  /** Whether a watch that notifies the operator's phones can currently reach one. */
  isApnsConfigured: () => boolean;
  /**
   * Lazy — the watch runtime is assembled after the first agent is built, and
   * an install without one answers null.
   */
  getWatchAuthoring: () => AuthorWatchDeps | null;
  /** What each watch has said, newest first. */
  watchFirings: (watchId: string, limit?: number) => ReadonlyArray<WatchFiringRecord>;
  /** How many times a watch has caught something — organic firings only. */
  watchFiringCount: (watchId: string) => number;
  /**
   * Try a watch against the recent past, so the agent can check its own work
   * before saying a watch is set up. Absent on an install with no runtime.
   */
  watchPreflight?: (watch: WatchDefinition, opts: { events?: number }) => Promise<PreflightOutcome>;
  /** Lazy — the omnesis-chat runtime is booted alongside the first agent. */
  getOmnesisChatRuntime: () => OmnesisChatRuntime | undefined;
  /** Best-effort push delivery for a turn that outlived its `notifyAfterMs` budget. */
  notifyAgentAnswer?: (notification: AgentAnswerNotification) => Promise<void>;
  /** Per-conversation read state, so a turn nobody watched leaves a marker. */
  conversationReadState?: ConversationReadStatePort;
  /** Best-effort push for a conversation that just became unread. */
  notifyConversation?: (notification: ConversationNotification) => void | Promise<void>;
  /** Read-worker gate for `lookup_people`. When wired the person port runs the
   *  heavy assembly off the main event loop; absent, it runs synchronously. */
  personLookupGate?: PersonLookupGate;
  /**
   * The operator's `OMNESIS.md`, re-read per prompt build so an edit made in a
   * terminal editor reaches the next conversation without a restart. Absent on
   * a gateway assembled without a config directory (tests, embedded harnesses).
   */
  getOperatorInstructions?: () => string;
}

/**
 * Resolve a {@link CapabilityRole} to a concrete {@link ChatBackend}, or `null`
 * when the role is unassigned/unresolved. Existing sub-agent callers interpret
 * null as inheriting the parent backend. Security-sensitive callers such as the
 * privacy gate must instead treat null as unavailable and fail closed.
 *
 * `local` GGUF agent models aren't supported, so they resolve to `null` (the
 * caller inherits) rather than throwing. Codex resolves through the gateway's
 * shared runtime service, which isolates nested turns from their callers.
 */
function anthropicModelLimits(
  catalogEntry: AnthropicCatalogEntry | undefined,
): ModelTokenLimits | undefined {
  if (!catalogEntry) return undefined;
  const maxInputTokens = catalogEntry.maxInputTokens;
  // Live catalog entries preserve Anthropic's input-only field separately.
  // Bundled entries predate that field and retain combined-window semantics.
  const contextWindowTokens = maxInputTokens === undefined ? catalogEntry.contextLength : undefined;
  const maxOutputTokens = catalogEntry.maxOutputTokens;
  if (
    maxInputTokens === undefined &&
    contextWindowTokens === undefined &&
    maxOutputTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

export function resolveRoleBackend(
  role: CapabilityRole,
  ctx: {
    inferenceRegistry: InferenceRegistry;
    configDir: string;
    db: Database.Database;
    maxToolIterations: number | undefined;
    log: Logger;
    codexRuntimeService?: CodexRuntimeService | null;
  },
): ChatBackend | null {
  const resolved = ctx.inferenceRegistry.resolve(role);
  switch (resolved.kind) {
    case "anthropic": {
      if (!resolved.allowRemoteInference) return null;
      const apiKey = resolveAnthropicApiKey(ctx.configDir);
      if (!apiKey) return null;
      return new AnthropicBackend({
        apiKey,
        model: resolved.apiModelId,
        maxToolIterations: ctx.maxToolIterations,
        adaptiveThinking: resolved.catalogEntry?.adaptiveThinking,
        modelMaxTokens: resolved.catalogEntry?.maxOutputTokens,
        modelLimits: anthropicModelLimits(resolved.catalogEntry),
      });
    }
    case "http": {
      if (!resolved.available) return null;
      return new HttpAgentBackend({
        baseUrl: resolved.url,
        apiPathPrefix: resolved.apiPathPrefix,
        protocol: resolved.protocol,
        model: resolved.model,
        maxToolIterations: ctx.maxToolIterations,
        apiKey: ctx.inferenceRegistry.getBackendApiKey(resolved.backendKey),
        allowRemoteInference: resolved.allowRemoteInference,
        modelLimits: resolved.modelLimits,
        timeoutMs: resolved.agentTimeoutMs,
        modelControls: resolved.modelControls,
        modelBehavior: resolved.modelBehavior,
      });
    }
    case "replay": {
      const fixturePath = process.env.OMNESIS_AGENT_FIXTURE ?? resolved.fixture;
      if (!fixturePath) return null;
      try {
        // The role picks the scenarios: one fixture directory serves the chat
        // agent and the privacy reviewer from disjoint cassette sets.
        return makeReplayBackendFactory({
          fixturePath,
          db: ctx.db,
          role,
          pacing: process.env.OMNESIS_AGENT_REPLAY_IMMEDIATE === "1" ? "immediate" : "demo",
          log: ctx.log,
        })();
      } catch {
        return null;
      }
    }
    case "codex":
      if (!resolved.allowRemoteInference) return null;
      // `available` is false for a role codex cannot serve, and for an
      // assignment carrying no model id — which would otherwise build a
      // backend that sends every turn to an empty model.
      if (!resolved.available) return null;
      return (
        ctx.codexRuntimeService?.createBackend({
          model: resolved.model,
          ...(resolved.modelBehavior?.reasoningEffort
            ? { reasoningEffort: resolved.modelBehavior.reasoningEffort }
            : {}),
          maxToolIterations: ctx.maxToolIterations,
          lane:
            role === "background-agent"
              ? "background"
              : role === "agent"
                ? "interactive"
                : "inference",
        }) ?? null
      );
    // disabled / unresolved / local → unassigned for sub-agent purposes.
    default:
      return null;
  }
}

/**
 * Wrap a pre-built `agent`-role backend factory into the role-parameterised
 * factory {@link AgentService} now expects. The `agent` role returns the
 * already-resolved parent backend; every other role resolves fresh from the
 * registry (null ⇒ the sub-agent inherits the parent).
 */
function makeRoleAwareFactory(
  agentFactory: () => ChatBackend,
  ctx: {
    inferenceRegistry: InferenceRegistry;
    configDir: string;
    db: Database.Database;
    maxToolIterations: number | undefined;
    log: Logger;
    codexRuntimeService?: CodexRuntimeService | null;
  },
): (role: CapabilityRole) => ChatBackend | null {
  return (role) => (role === "agent" ? agentFactory() : resolveRoleBackend(role, ctx));
}

/**
 * Build an {@link AgentService} from a role-aware backend factory and the
 * gateway collaborators. The factory selects the concrete {@link ChatBackend}
 * (anthropic / http / replay) for each {@link CapabilityRole}, or `null` for an
 * unassigned sub-agent role (the caller then inherits the parent's backend).
 */
/**
 * The v1 built-in specialist registry: `research-planner`,
 * `history-sweep`, `source-digest`, and `citation-verifier`.
 * Deep Research resolves its private stages through this registry to a
 * `{ systemPrompt, modelRole, defaultTools }` descriptor. The ordinary
 * model-facing spawn tool cannot name or discover these profiles.
 */
const specialistRegistry = createBuiltinSpecialistRegistry();

/**
 * Deep-research specialists that JUDGE rather than research, and so are kept
 * free of the operator's standing instructions. `citation-verifier` decides
 * whether a quote really appears in a document — a verdict that has to rest on
 * the text alone, not on how its reader has been told to behave.
 */
const ADJUDICATING_SPECIALISTS: ReadonlySet<string> = new Set(["citation-verifier"]);

/**
 * Put the operator's standing instructions on a specialist's fixed prompt,
 * unless that specialist adjudicates — see {@link ADJUDICATING_SPECIALISTS}.
 * Exported for the test that pins which specialists are on which side.
 */
export function decorateSpecialist(
  specialist: ResolvedSpecialist,
  operatorInstructions: string,
): ResolvedSpecialist {
  if (ADJUDICATING_SPECIALISTS.has(specialist.name)) return specialist;
  const section = renderOperatorInstructionsSection(operatorInstructions);
  return section ? { ...specialist, systemPrompt: specialist.systemPrompt + section } : specialist;
}

/**
 * The `OMNESIS.md` reader, as an optional dep. Absent on a wiring with no
 * config directory, where every prompt simply carries no operator section.
 */
function operatorInstructionsSeam(store: OperatorInstructionsStore | undefined): {
  getOperatorInstructions?: () => string;
} {
  return store ? { getOperatorInstructions: () => store.promptText() } : {};
}

// Logger for the cognition-spend recorder wired into the agent service —
// the lifecycle otherwise threads per-instance loggers through deps.
const spendLog = createLogger("gateway").child("agent-spend");

export interface SubagentCaps {
  depthCap: number;
  concurrencyCap: number;
  /** `undefined` ⇒ unbounded tree-token budget (a warning is logged). */
  treeTokenBudget?: number;
}

export function createAgentService(
  deps: AgentServiceDeps,
  backendFactory: (role: CapabilityRole) => ChatBackend | null,
  subagentCaps: SubagentCaps,
): AgentService {
  const { db, searchPipeline, syncStatus, analyticsDb, writeGate, wsServer, conversationStore } =
    deps;
  const omnesisChatRuntime = deps.getOmnesisChatRuntime();
  /** The configured source types a run may reach; every type when unscoped. */
  const permittedSourceTypes = (authorization?: CorpusAuthorization): string[] => [
    ...new Set(
      listSources(db)
        .filter((source) => !authorization || authorization.allowsSource(source.id))
        .map((source) => source.type),
    ),
  ];
  const buildLiveSystemPrompt = async (
    context: AgentPromptContext,
    options: {
      audience: "interactive" | "subagent";
      citationSurface: boolean;
      authorization?: CorpusAuthorization;
      memoryWrites?: boolean;
    },
  ): Promise<string> => {
    const restricted = options.authorization?.restricted === true;
    const catalog = restricted ? [] : await analyticsDb.getCatalog();
    const sourceTypes = permittedSourceTypes(options.authorization);
    const experimental = restricted ? false : experimentalVisible();
    const { selfMemory, selfPersonId } = resolveSelfMemory(db, !restricted);
    // Deliberately NOT gated on `restricted`, unlike the catalog, the
    // experimental sections and the self-memory above. Those are corpus
    // exposure, which a scoped grant must not widen. This is the operator
    // telling their own agent how to behave, and it applies whoever asked —
    // what may actually leave the machine is still the privacy reviewer's call.
    const operatorInstructions = deps.getOperatorInstructions?.() ?? "";
    return buildSystemPrompt({
      audience: options.audience,
      now: new Date(),
      timeZone: context.timeZone,
      catalog,
      sourceTypes,
      experimental,
      selfMemory,
      selfPersonId,
      memoryWrites: options.memoryWrites === true && !restricted,
      operatorInstructions,
      citationSurface: options.citationSurface,
    });
  };
  return new AgentService({
    backendFactory,
    ports: {
      // `db` is passed so the agent search port can attach the 1-hop
      // breadcrumb to top hits.
      search: createGatewaySearchPort(searchPipeline, syncStatus, db),
      document: createGatewayDocumentPort(db, syncStatus),
      documentByUrl: createGatewayDocumentByUrlPort(db, syncStatus),
      // `trace_connections` surfaces `same-entity` bound rows as point-in-time
      // records, so it needs the same analytics DB `cite_record` uses
      // (for the bound-row resolver + the record-display contract).
      trail: createGatewayTrailPort(db, analyticsDb),
      sql: createGatewaySqlPort(analyticsDb),
      // `cite_record` persists a single analytics row as a record citation.
      //Wired with the same analytics DB as `run_sql` (for the table
      // contract) and the document store (to resolve a bound document id).
      record: createGatewayRecordPort(db, analyticsDb),
      person: createGatewayPersonPort(db, { lookupGate: deps.personLookupGate }),
      watch: experimentalVisible()
        ? createGatewayWatchPort({
            getAuthoring: deps.getWatchAuthoring,
            firings: deps.watchFirings,
            firingCount: deps.watchFiringCount,
            isApnsConfigured: () => deps.isApnsConfigured(),
            ...(deps.watchPreflight ? { preflight: deps.watchPreflight } : {}),
          })
        : undefined,
      // Read-only loop port (experimental): lets the interactive agent find and
      // read the background Cognition Steward's tracked obligations — no mutation, no
      // briefs. Wired only in experimental mode (the loop system exists only
      // then); the registry additionally gates the two tools on experimental.
      loopRead: experimentalVisible() ? createGatewayLoopReadPort(db) : undefined,
      // Read-only temporal port (experimental): lets the interactive agent
      // answer "what's coming up?" from BOTH temporal origins in one call —
      // source-owned dated facts, which the ingest path materializes whether or
      // not the background agent runs, and that agent's own selective
      // interpretations. No write surface.
      temporal: experimentalVisible() ? createGatewayTemporalPort(db, analyticsDb) : undefined,
      // Read-only cognitive-context (reap) port (experimental): lets the
      // interactive agent pull the whole neighbourhood the background agent
      // linked around one entity in a single call — no write surface.
      entityContext: experimentalVisible() ? createGatewayEntityContextPort(db) : undefined,
    },
    // Function form so today's date, the live analytics catalog, and the
    // configured-source list are all fresh on every session-create.
    // Source-specific knowledge (table schemas, available `source:`
    // filter values) is pulled from the registry here so nothing in the
    // prompt template knows about any individual provider.
    // Prompt caching (cache_control: ephemeral) absorbs the per-session token
    // cost. The rendered block varies by calendar date and by the caller's
    // zone, so sessions opened the same day from the same place share a cached
    // prefix; nothing in it changes faster than that.
    systemPrompt: (profile, context) =>
      buildLiveSystemPrompt(context, {
        audience: "interactive",
        citationSurface: rendersTimeline(profile),
        memoryWrites: profile !== "answer",
      }),
    externalAnswerScope: async (authorization) => {
      const safeNames = new Set(["search_many", "fetch_many", "lookup_document_by_url"]);
      const tools = buildBuiltinTools({
        experimental: false,
        ports: {
          search: createGatewaySearchPort(searchPipeline, syncStatus, db, authorization),
          document: createGatewayDocumentPort(db, syncStatus, undefined, authorization),
          documentByUrl: createGatewayDocumentByUrlPort(db, syncStatus, authorization),
        },
      }).filter((tool) => safeNames.has(tool.name));
      const base = await buildLiveSystemPrompt(
        {},
        { audience: "interactive", citationSurface: false, authorization },
      );
      return {
        tools,
        systemPrompt: `${base}\n\n${renderSourceRestrictedAnswerSection(permittedSourceTypes(authorization))}`,
      };
    },
    // v1 demo: every admin-scope WS client sees agent events; clients filter
    // by sessionId payload. Refine to per-caller routing in a future phase
    // once the portal speaks the hello-auth handshake.
    broadcastEvent: (event) => wsServer.broadcast(event, SCOPE_ADMIN),
    // Each turn is flushed atomically to a JSON file in the config dir
    // so conversations survive gateway restarts and a user can come back
    // to them. The portal renders the list of saved transcripts.
    store: conversationStore,
    // Forwards turn-boundary events to the omnesis-chat source so the
    // conversation is debounce-upserted as a corpus document. No-ops
    // cleanly when the runtime is absent.
    onTurnComplete: omnesisChatRuntime?.onTurnEnd,
    ensureConversationEvidence: omnesisChatRuntime
      ? (sessionId) => omnesisChatRuntime.ensureConversationEvidence(sessionId)
      : undefined,
    onSessionClose: omnesisChatRuntime?.onSessionClose,
    onConversationDeleted: omnesisChatRuntime?.onConversationDeleted,
    onConversationRetained: omnesisChatRuntime?.onConversationRetained,
    // Slow-answer push (`notifyAfterMs`) — the composition root supplies the
    // APNs fan-out; absent in minimal wirings, where the option is inert.
    notifyAnswer: deps.notifyAgentAnswer,
    readState: deps.conversationReadState,
    notifyConversation: deps.notifyConversation,
    // Sub-agents. Interactive turns expose one generic worker contract;
    // the built-in specialist registry remains private to Deep Research.
    subagents: {
      // A specialist's prompt is a fixed in-repo string; the operator's
      // standing instructions ride on the end of it, resolved per spawn so an
      // edit reaches the next research stage. Generic workers get theirs
      // through `genericSystemPrompt` below, which builds the whole prompt.
      // Adjudicating specialists are the exception, for the same reason the
      // privacy reviewer, the entailment verifier and the brief judge get
      // nothing: a bar the operator's own prose can move is not a bar.
      resolveSpecialist: (name) =>
        decorateSpecialist(
          specialistRegistry.resolve(name),
          deps.getOperatorInstructions?.() ?? "",
        ),
      genericSystemPrompt: (context) =>
        buildLiveSystemPrompt(context, { audience: "subagent", citationSurface: false }),
      depthCap: subagentCaps.depthCap,
      concurrencyCap: subagentCaps.concurrencyCap,
      treeTokenBudget: subagentCaps.treeTokenBudget,
    },
    // Cognition-spend accounting: fold each settled interactive turn's /
    // sub-agent child's tokens into the durable `cognition_spend` table via
    // the write gate, same day-bucket convention as the background lanes.
    // Best-effort — a lost sample must never fail an agent turn.
    recordSpend: ({ mechanism, modelId, usage, completed }) => {
      writeGate
        .recordCognitionSpend(
          cognitionSpendDay(Date.now()),
          mechanism,
          modelId,
          toCognitionRunUsage(usage),
          completed ? undefined : { countRun: false },
        )
        .catch((err) => {
          spendLog.warn(
            `Failed to record ${mechanism} spend: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    },
  });
}

/** Everything {@link AgentLifecycle} needs beyond the agent's own ports. */
export interface AgentLifecycleDeps {
  inferenceRegistry: InferenceRegistry;
  /** Config snapshot the initial boot resolves the agent from. */
  config: ReturnType<ConfigStore["get"]>;
  /** Read fresh on each swap (assignment + credentials may have changed). */
  configStore: ConfigStore;
  configDir: string;
  /**
   * The operator's `OMNESIS.md`. Absent in minimal wirings (tests, embedded
   * harnesses), where every agent prompt simply carries no operator section.
   */
  operatorInstructions?: OperatorInstructionsStore;
  indexDb: Database.Database;
  wsEventHandler: WsEventHandler;
  log: Logger;
  // Collaborators forwarded to createAgentService.
  db: Database.Database;
  searchPipeline: SearchPipeline;
  syncStatus: SyncStatusRegistry;
  analyticsDb: AnalyticsDb;
  writeGate: WriteGate;
  wsServer: DeviceWsServer;
  conversationStore: FsConversationStore;
  /** Shared policy authority used by every release path in this gateway process. */
  privacyPolicyStore?: PrivacyPolicyStore;
  /** Forwarded to the watch port — whether a push can currently be delivered. */
  isApnsConfigured: () => boolean;
  /** Forwarded to the watch port — where a compiled watch is installed. */
  getWatchAuthoring: () => AuthorWatchDeps | null;
  /** Forwarded to the watch port — what each watch has said. */
  watchFirings: (watchId: string, limit?: number) => ReadonlyArray<WatchFiringRecord>;
  /** How many times a watch has caught something — organic firings only. */
  watchFiringCount: (watchId: string) => number;
  /**
   * Try a watch against the recent past, so the agent can check its own work
   * before saying a watch is set up. Absent on an install with no runtime.
   */
  watchPreflight?: (watch: WatchDefinition, opts: { events?: number }) => Promise<PreflightOutcome>;
  codexRuntimeService?: CodexRuntimeService | null;
  /** Read-worker gate forwarded to the person port for off-thread `lookup_people`. */
  personLookupGate?: PersonLookupGate;
  /** Worker-coordinated bounded index cleanup for activity retention. */
  deleteDocumentIndexBatch?: (
    documentId: string,
    limit: number,
    sourceDeleted: boolean,
  ) => Promise<{
    deletedChunks: number;
    complete: boolean;
    readyForSourceDelete: boolean;
  }>;
  /** Best-effort generic push notification for a newly held answer. */
  notifyPrivacyApproval?: (approvalId: string) => Promise<void>;
  /** Best-effort push delivery for a turn that outlived its `notifyAfterMs` budget. */
  notifyAgentAnswer?: (notification: AgentAnswerNotification) => Promise<void>;
  /** Best-effort push for a conversation that just became unread. */
  notifyConversation?: (notification: ConversationNotification) => void | Promise<void>;
}

/**
 * Owns the in-gateway demo agent's lifecycle: its initial boot, the model
 * swap that re-resolves it when the assignment or credentials change, and its
 * shutdown. The mutable {@link AgentRoutesDeps} it exposes via {@link routeDeps}
 * is the agent route handler's live window onto the service — `bootAgent`
 * populates it and `applyAgentSwap` mutates it in place, so the route always
 * sees the current service/reason without being re-wired.
 *
 * The boot and swap paths deliberately do NOT share their resolve→service
 * switch: they emit different `disabledReason` strings (boot is verbose, swap
 * is terse) and that text is surfaced to the portal, so each switch stays as
 * written.
 */
export class AgentLifecycle {
  /**
   * Brief talk-back session profile,
   * installed by the Briefs feature when it boots active. Held here (not
   * only on the AgentService) because an agent-model swap rebuilds the
   * service, and the new instance must keep serving anchored threads.
   */
  private anchoredThreadProfile: import("./service.js").AnchoredThreadProfile | null = null;

  setAnchoredThreadProfile(profile: import("./service.js").AnchoredThreadProfile | null): void {
    this.anchoredThreadProfile = profile;
    this.routeDeps.agentService?.setAnchoredThreadProfile(profile);
  }

  private interactiveMemoryProfile: import("./service.js").InteractiveWriteProfile | null = null;

  setInteractiveMemoryProfile(
    profile: import("./service.js").InteractiveWriteProfile | null,
  ): void {
    this.interactiveMemoryProfile = profile;
    this.routeDeps.agentService?.setInteractiveMemoryProfile(profile);
  }

  private interactiveWriteProfile: import("./service.js").InteractiveWriteProfile | null = null;

  setInteractiveWriteProfile(profile: import("./service.js").InteractiveWriteProfile | null): void {
    this.interactiveWriteProfile = profile;
    this.routeDeps.agentService?.setInteractiveWriteProfile(profile);
  }

  async pruneConversations(
    cutoffMs: number,
    limit = 1,
  ): Promise<{ deleted: number; hasMore: boolean }> {
    return this.withAgentServiceStable(async () => {
      const active = this.routeDeps.agentService;
      if (active) return active.pruneConversations(cutoffMs, limit);
      const store = this.deps.conversationStore;
      if (!store.listRetentionCandidates || !store.retentionCandidateIsCurrent) {
        return { deleted: 0, hasMore: false };
      }
      const deleteLimit = Math.max(1, limit);
      const page = await store.listRetentionCandidates(cutoffMs, deleteLimit);
      let deleted = 0;
      let incomplete = false;
      // Collected across the batch and forgotten in one write, so a bulk
      // cleanup behind conversations that are already gone does not put one
      // write op per conversation into the queue.
      const forgotten: string[] = [];
      for (let index = 0; index < page.items.length && index < deleteLimit; index += 1) {
        const candidate = page.items[index]!;
        if (!(await store.retentionCandidateIsCurrent(candidate, cutoffMs))) continue;
        try {
          const complete = this.omnesisChatRuntime
            ? await this.omnesisChatRuntime.onConversationRetained(candidate.id)
            : await retainOmnesisChatConversation(
                {
                  writeGate: this.deps.writeGate,
                  indexWriteGate: directIndexWriteGate(this.deps.indexDb),
                  readDb: this.deps.db,
                  ...(this.deps.deleteDocumentIndexBatch
                    ? { retentionIndexDeleteBatch: this.deps.deleteDocumentIndexBatch }
                    : {}),
                },
                candidate.id,
              );
          if (!complete) {
            incomplete = true;
            store.deferRetentionCandidates?.(page.items.slice(index));
            break;
          }
          if (await store.deleteForRetention(candidate.id)) {
            deleted += 1;
            forgotten.push(candidate.id);
          }
        } catch (err) {
          incomplete = true;
          store.deferRetentionCandidates?.(page.items.slice(index));
          this.deps.log.warn(
            `retention could not delete disabled-agent conversation ${candidate.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          break;
        }
      }
      if (forgotten.length > 0) {
        try {
          await this.conversationReadState.forget(forgotten);
        } catch (err) {
          // A badge is not the transcript; a failed cleanup must not abort a
          // sweep that has otherwise done its work.
          this.deps.log.warn(
            `read-state cleanup failed for ${forgotten.length} retired conversation(s): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return { deleted, hasMore: page.hasMore || incomplete };
    });
  }

  private omnesisChatRuntime: OmnesisChatRuntime | undefined;
  private readonly privacyPolicyStore: PrivacyPolicyStore;
  private readonly privacyReviewer: PrivacyReviewer;
  private privacyReviewerMaxToolIterations: number | undefined;
  /** Stable reference handed to the agent route; mutated in place by swaps. */
  readonly routeDeps: AgentRoutesDeps;
  /**
   * Read state outlives every agent swap. It is about what the operator has
   * looked at, which does not change because the backend did — and a service
   * rebuilt per swap would forget who was mid-conversation at the moment of
   * the swap.
   */
  private readonly conversationReadState: ConversationReadStateService;
  private agentSwapInFlight: Promise<void> | null = null;
  private shuttingDown = false;
  /**
   * Lifecycle transitions (config swap, recovery, shutdown) must not change the
   * AgentService while disabled-mode retention owns a conversation's corpus/file
   * deletion. This tiny mutex stabilizes the pointer across those operations;
   * it never serializes ordinary agent turns.
   */
  private agentServiceStabilityTail: Promise<void> = Promise.resolve();
  private privacySweepTimer: ReturnType<typeof setInterval> | null = null;
  private privacyStateRecovered = false;

  constructor(private readonly deps: AgentLifecycleDeps) {
    const privacyPolicyStore =
      deps.privacyPolicyStore ??
      new PrivacyPolicyStore(deps.configDir, { db: deps.db, writeGate: deps.writeGate });
    this.privacyPolicyStore = privacyPolicyStore;
    this.privacyReviewer = new PrivacyReviewer({
      resolveBackend: () =>
        resolveRoleBackend("privacy-reviewer", {
          inferenceRegistry: this.deps.inferenceRegistry,
          configDir: this.deps.configDir,
          db: this.deps.db,
          maxToolIterations: this.privacyReviewerMaxToolIterations,
          log: this.deps.log,
          codexRuntimeService: this.deps.codexRuntimeService,
        }),
    });
    this.conversationReadState = new ConversationReadStateService({
      db: deps.db,
      writer: deps.writeGate,
      // Read fresh so a live config edit lands without a restart; this service
      // is built once and outlives every agent swap.
      viewingTtlMs: () => resolveViewingTtlMs(deps.configStore.get()),
    });
    const conversationReader = new StoredConversationReader(deps.conversationStore, async () => {
      const active = this.routeDeps.agentService;
      return active ? active.listConversations() : deps.conversationStore.list();
    });
    this.routeDeps = {
      agentService: undefined,
      conversationReader,
      conversationReadState: this.conversationReadState,
      answerService: undefined,
      privacyReviewer: this.privacyReviewer,
      privacyAdminService: new PrivacyAdminService({
        db: deps.db,
        policyStore: privacyPolicyStore,
        writeGate: deps.writeGate,
      }),
      disabledReason: undefined,
      agentConfig: {
        backend: deps.inferenceRegistry.resolve("agent").kind,
        enabled: false,
        disabledReason: undefined,
      },
      // Re-resolve the agent assignment on every call so the chat-header
      // model name tracks live config (e.g. after a model swap) without
      // needing to thread a fresh snapshot through every swap path.
      agentModelDisplay: () => resolveModelDisplay(deps.inferenceRegistry.resolve("agent")),
    };
  }

  private makeAnswerService(agentService: AgentService, maxToolIterations: number | undefined) {
    this.privacyReviewerMaxToolIterations = maxToolIterations;
    return new AnswerService({
      db: this.deps.db,
      writeGate: this.deps.writeGate,
      agent: agentService,
      reviewer: this.privacyReviewer,
      policyStore: this.privacyPolicyStore,
      notifyApproval: this.deps.notifyPrivacyApproval,
    });
  }

  /**
   * Build the service from an `agent`-role backend factory. The factory is
   * wrapped into the role-parameterised form {@link AgentService} expects, so
   * the `agent` role uses `agentFactory` and the sub-agent roles resolve fresh
   * from the inference registry (null ⇒ inherit the parent).
   */
  private makeAgentService(
    agentFactory: () => ChatBackend,
    maxToolIterations: number | undefined,
  ): AgentService {
    const roleAware = makeRoleAwareFactory(agentFactory, {
      inferenceRegistry: this.deps.inferenceRegistry,
      configDir: this.deps.configDir,
      db: this.deps.db,
      maxToolIterations,
      log: this.deps.log,
      codexRuntimeService: this.deps.codexRuntimeService,
    });
    return createAgentService(
      {
        db: this.deps.db,
        searchPipeline: this.deps.searchPipeline,
        syncStatus: this.deps.syncStatus,
        analyticsDb: this.deps.analyticsDb,
        writeGate: this.deps.writeGate,
        wsServer: this.deps.wsServer,
        conversationStore: this.deps.conversationStore,
        indexDb: this.deps.indexDb,
        isApnsConfigured: this.deps.isApnsConfigured,
        getWatchAuthoring: this.deps.getWatchAuthoring,
        watchFirings: this.deps.watchFirings,
        watchFiringCount: this.deps.watchFiringCount,
        ...(this.deps.watchPreflight ? { watchPreflight: this.deps.watchPreflight } : {}),
        ...operatorInstructionsSeam(this.deps.operatorInstructions),
        getOmnesisChatRuntime: () => this.omnesisChatRuntime,
        notifyAgentAnswer: this.deps.notifyAgentAnswer,
        conversationReadState: this.conversationReadState,
        notifyConversation: this.deps.notifyConversation,
        personLookupGate: this.deps.personLookupGate,
      },
      roleAware,
      this.resolveSubagentCaps(),
    );
  }

  /**
   * Sub-agent caps from config — depth, concurrency, and the tree-wide token
   * budget. Defaults live in `CONFIG_DEFAULTS` (or, for the budget, are
   * intentionally unset = unbounded); never magic numbers in code, per the
   * frozen sub-agent constraint. Read fresh so a live config edit is picked up on
   * the next agent swap.
   */
  private resolveSubagentCaps(): SubagentCaps {
    const agent = this.deps.configStore.get().agent;
    return {
      depthCap: agent?.subagentDepthCap ?? CONFIG_DEFAULTS.agent.subagentDepthCap,
      concurrencyCap: agent?.subagentConcurrencyCap ?? CONFIG_DEFAULTS.agent.subagentConcurrencyCap,
      // No static default — unset means unbounded (the service logs a warning).
      treeTokenBudget: agent?.subagentTreeTokenBudget,
    };
  }

  /** Resolve the configured agent and install it (or its disabled reason). */
  async bootAgent(): Promise<void> {
    const { inferenceRegistry, config, configDir, db, writeGate, indexDb, conversationStore, log } =
      this.deps;
    if (!this.privacyStateRecovered) {
      const now = Date.now();
      const recovered = await writeGate.recoverInterruptedAnswerTasks(now);
      const expired = await writeGate.expirePrivacyApprovals(now);
      if (recovered > 0 || expired > 0) {
        log.info(
          `privacy state recovered at boot: ${recovered} interrupted task(s), ${expired} expired approval(s)`,
        );
      }
      this.privacyStateRecovered = true;
      this.privacySweepTimer = setInterval(() => {
        void writeGate.expirePrivacyApprovals(Date.now()).catch((err) => {
          log.warn(
            `privacy approval sweep failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, PRIVACY_STATE_SWEEP_INTERVAL_MS);
      this.privacySweepTimer.unref();
    }
    const agentResolved = inferenceRegistry.resolve("agent");
    const maxToolIterations = config.agent?.maxToolIterations;
    // A cloud agent selected while remote inference is off will be refused by
    // the switch below — don't boot the chat runtime for a doomed agent.
    const cloudBlockedByEgress =
      (agentResolved.kind === "anthropic" || agentResolved.kind === "codex") &&
      !agentResolved.allowRemoteInference;
    const agentEnabled =
      agentResolved.kind !== "disabled" &&
      agentResolved.kind !== "unresolved" &&
      !cloudBlockedByEgress &&
      (agentResolved.kind !== "codex" || agentResolved.available);

    if (agentEnabled) {
      const debounceMsRaw = process.env.OMNESIS_CHAT_DEBOUNCE_MS;
      const debounceMs =
        debounceMsRaw !== undefined && /^\d+$/.test(debounceMsRaw)
          ? Number(debounceMsRaw)
          : undefined;
      this.omnesisChatRuntime = await bootOmnesisChat({
        writeGate,
        indexWriteGate: directIndexWriteGate(indexDb),
        readDb: db,
        conversationsDir: join(configDir, "conversations"),
        loadConversation: (id) => conversationStore.load(id),
        ...(this.deps.deleteDocumentIndexBatch
          ? { retentionIndexDeleteBatch: this.deps.deleteDocumentIndexBatch }
          : {}),
        debounceMs,
      });
    }

    let agentService: AgentService | undefined;
    let agentDisabledReason: string | undefined;

    switch (agentResolved.kind) {
      case "disabled":
        agentDisabledReason =
          'Agent disabled. Set inference.assignments.agent in omnesis.json (e.g. "anthropic/claude-sonnet-4-6") to enable it.';
        log.info("agent disabled (assignment null or omitted)");
        break;

      case "unresolved":
        // A typo'd / dangling assignment (points at a model or backend that
        // doesn't resolve) silently disables the agent — escalate to error so
        // it can't hide in the log. Also surfaced as a degraded role on
        // /status (see InferenceRegistry.degradedAssignments).
        agentDisabledReason = `Agent unresolved: ${agentResolved.reason}`;
        log.error(`agent disabled (unresolved assignment): ${agentDisabledReason}`);
        break;

      case "replay": {
        const fixturePath =
          process.env.OMNESIS_AGENT_FIXTURE ?? config.agent?.replay?.fixture ?? undefined;
        if (!fixturePath) {
          agentDisabledReason =
            "Replay backend selected but no fixture configured. Set agent.replay.fixture in omnesis.json.";
          log.warn(`agent disabled: ${agentDisabledReason}`);
        } else {
          try {
            const factory = makeReplayBackendFactory({
              pacing: process.env.OMNESIS_AGENT_REPLAY_IMMEDIATE === "1" ? "immediate" : "demo",
              fixturePath,
              db,
              legacyPlaceholdersPath:
                process.env.OMNESIS_AGENT_FIXTURE_PLACEHOLDERS ??
                config.agent?.replay?.placeholders ??
                undefined,
              log,
            });
            agentService = this.makeAgentService(factory, maxToolIterations);
            log.info(`agent enabled (replay; fixture=${fixturePath})`);
          } catch (err) {
            agentDisabledReason = `Replay fixture failed to load: ${err instanceof Error ? err.message : String(err)}`;
            log.warn(`agent disabled: ${agentDisabledReason}`);
          }
        }
        break;
      }

      case "anthropic": {
        if (!agentResolved.allowRemoteInference) {
          agentDisabledReason = agentResolved.reason ?? CLOUD_EGRESS_DISABLED_REASON;
          log.warn(`agent disabled: ${agentDisabledReason}`);
          break;
        }
        const apiKey = resolveAnthropicApiKey(configDir);
        if (!apiKey) {
          agentDisabledReason =
            "Anthropic API key not configured. Set it from the portal's Settings → Models tab.";
          log.warn(`agent disabled: ${agentDisabledReason}`);
        } else {
          const factory = (): ChatBackend => {
            const current = inferenceRegistry.resolve("agent");
            const catalogEntry =
              current.kind === "anthropic" && current.apiModelId === agentResolved.apiModelId
                ? current.catalogEntry
                : agentResolved.catalogEntry;
            return new AnthropicBackend({
              apiKey,
              model: agentResolved.apiModelId,
              maxToolIterations,
              adaptiveThinking: catalogEntry?.adaptiveThinking,
              modelMaxTokens: catalogEntry?.maxOutputTokens,
              modelLimits: anthropicModelLimits(catalogEntry),
            });
          };
          agentService = this.makeAgentService(factory, maxToolIterations);
          log.info(`agent enabled (anthropic; model=${agentResolved.apiModelId})`);
        }
        break;
      }

      case "http": {
        if (!agentResolved.available) {
          agentDisabledReason =
            agentResolved.reason ?? `HTTP backend "${agentResolved.backendKey}" unreachable`;
          log.warn(`agent disabled: ${agentDisabledReason}`);
        } else {
          const agentApiKey = inferenceRegistry.getBackendApiKey(agentResolved.backendKey);
          const factory = (): ChatBackend =>
            new HttpAgentBackend({
              baseUrl: agentResolved.url,
              apiPathPrefix: agentResolved.apiPathPrefix,
              protocol: agentResolved.protocol,
              model: agentResolved.model,
              maxToolIterations,
              apiKey: agentApiKey,
              allowRemoteInference: agentResolved.allowRemoteInference,
              modelLimits: agentResolved.modelLimits,
              timeoutMs: agentResolved.agentTimeoutMs,
              modelControls: agentResolved.modelControls,
              modelBehavior: agentResolved.modelBehavior,
            });
          agentService = this.makeAgentService(factory, maxToolIterations);
          log.info(
            `agent enabled (http; backend=${agentResolved.backendKey} model=${agentResolved.model})`,
          );
        }
        break;
      }

      case "codex": {
        if (!agentResolved.allowRemoteInference) {
          agentDisabledReason = agentResolved.reason ?? CLOUD_EGRESS_DISABLED_REASON;
          log.warn(`agent disabled: ${agentDisabledReason}`);
        } else if (!agentResolved.available) {
          agentDisabledReason = agentResolved.reason ?? "Codex backend is unavailable.";
          log.warn(`agent disabled: ${agentDisabledReason}`);
        } else if (!this.deps.codexRuntimeService) {
          agentDisabledReason = "Codex runtime is not initialized on this gateway.";
          log.warn(`agent disabled: ${agentDisabledReason}`);
        } else {
          const factory = (): ChatBackend =>
            this.deps.codexRuntimeService!.createBackend({
              model: agentResolved.model,
              ...(agentResolved.modelBehavior?.reasoningEffort
                ? { reasoningEffort: agentResolved.modelBehavior.reasoningEffort }
                : {}),
              maxToolIterations,
            });
          agentService = this.makeAgentService(factory, maxToolIterations);
          log.info(`agent enabled (codex; model=${agentResolved.model})`);
        }
        break;
      }

      case "local":
        agentDisabledReason = "Local GGUF agent models are not yet supported.";
        log.warn(`agent disabled: ${agentDisabledReason}`);
        break;

      default: {
        const _exhaustive: never = agentResolved;
        agentDisabledReason = `Unexpected agent assignment kind: ${(agentResolved as { kind: string }).kind}`;
        log.warn(`agent disabled: ${agentDisabledReason}`);
        break;
      }
    }

    if (agentService) this.deps.wsEventHandler.attachAgentService(agentService);
    if (agentService && this.anchoredThreadProfile) {
      agentService.setAnchoredThreadProfile(this.anchoredThreadProfile);
    }
    if (agentService && this.interactiveMemoryProfile) {
      agentService.setInteractiveMemoryProfile(this.interactiveMemoryProfile);
    }
    if (agentService && this.interactiveWriteProfile) {
      agentService.setInteractiveWriteProfile(this.interactiveWriteProfile);
    }

    this.routeDeps.agentService = agentService;
    this.routeDeps.answerService = agentService
      ? this.makeAnswerService(agentService, maxToolIterations)
      : undefined;
    this.routeDeps.disabledReason = agentDisabledReason;
    this.routeDeps.disabledCode = cloudBlockedByEgress
      ? "remote_inference_disabled"
      : agentResolved.kind === "http"
        ? agentResolved.reasonCode
        : undefined;
    this.routeDeps.agentConfig = {
      backend: inferenceRegistry.resolve("agent").kind,
      enabled: !!agentService,
      disabledReason: agentDisabledReason,
      disabledCode: this.routeDeps.disabledCode,
    };
  }

  /** Serialise swaps so two overlapping assignment changes can't interleave. */
  async applyAgentSwap(): Promise<void> {
    if (this.agentSwapInFlight) {
      await this.agentSwapInFlight;
    }
    this.agentSwapInFlight = this.withAgentServiceStable(async () => {
      if (this.shuttingDown) return;
      await this.runAgentSwap();
    });
    try {
      await this.agentSwapInFlight;
    } finally {
      this.agentSwapInFlight = null;
    }
  }

  /**
   * Recreate an HTTP agent that was disabled when its backend was unreachable
   * at boot. The eligibility check runs inside the lifecycle exclusion and
   * against the latest config, so a concurrent config swap cannot cause a
   * redundant rebuild or resurrect a stale assignment.
   */
  async reactivateAgentIfAvailable(): Promise<boolean> {
    return this.withAgentServiceStable(async () => {
      if (this.shuttingDown || this.routeDeps.agentService) return false;

      const { inferenceRegistry, configStore } = this.deps;
      inferenceRegistry.loadConfig(configStore.get());
      const resolved = inferenceRegistry.resolve("agent");
      if (resolved.kind !== "http" || !resolved.available) return false;

      await this.runAgentSwap();
      return this.routeDeps.agentService !== undefined;
    });
  }

  private async withAgentServiceStable<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.agentServiceStabilityTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.agentServiceStabilityTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async runAgentSwap(): Promise<void> {
    const { inferenceRegistry, configStore, configDir, db, log } = this.deps;
    inferenceRegistry.loadConfig(configStore.get());
    const resolved = inferenceRegistry.resolve("agent");
    const maxToolIterations = configStore.get().agent?.maxToolIterations;

    // Dispose the previous service before installing the new one.
    const previousService = this.routeDeps.agentService;
    if (previousService) {
      try {
        await previousService.dispose();
      } catch {
        /* best-effort */
      }
    }

    let newService: AgentService | undefined;
    let newReason: string | undefined;

    switch (resolved.kind) {
      case "disabled":
        newReason = "Agent disabled. Set inference.assignments.agent in omnesis.json to enable it.";
        log.info("agent swap → disabled");
        break;
      case "unresolved":
        // Typo'd / dangling assignment — escalate to error (also a degraded
        // role on /status). See bootAgent's unresolved case.
        newReason = `Agent unresolved: ${resolved.reason}`;
        log.error(`agent swap → unresolved (dangling assignment): ${resolved.reason}`);
        break;
      case "replay": {
        const cfg = configStore.get();
        const fixturePath = process.env.OMNESIS_AGENT_FIXTURE ?? cfg.agent?.replay?.fixture;
        if (!fixturePath) {
          newReason = "Replay backend selected but no fixture configured.";
        } else {
          try {
            const factory = makeReplayBackendFactory({
              pacing: process.env.OMNESIS_AGENT_REPLAY_IMMEDIATE === "1" ? "immediate" : "demo",
              fixturePath,
              db,
              legacyPlaceholdersPath: cfg.agent?.replay?.placeholders,
              log,
            });
            newService = this.makeAgentService(factory, maxToolIterations);
            log.info(`agent swap → replay (fixture=${fixturePath})`);
          } catch (err) {
            newReason = `Replay fixture failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        break;
      }
      case "anthropic": {
        if (!resolved.allowRemoteInference) {
          newReason = resolved.reason ?? CLOUD_EGRESS_DISABLED_REASON;
          break;
        }
        const apiKey = resolveAnthropicApiKey(configDir);
        if (!apiKey) {
          newReason = "Anthropic API key not configured.";
        } else {
          const factory = (): ChatBackend => {
            const current = inferenceRegistry.resolve("agent");
            const catalogEntry =
              current.kind === "anthropic" && current.apiModelId === resolved.apiModelId
                ? current.catalogEntry
                : resolved.catalogEntry;
            return new AnthropicBackend({
              apiKey,
              model: resolved.apiModelId,
              maxToolIterations,
              adaptiveThinking: catalogEntry?.adaptiveThinking,
              modelMaxTokens: catalogEntry?.maxOutputTokens,
              modelLimits: anthropicModelLimits(catalogEntry),
            });
          };
          newService = this.makeAgentService(factory, maxToolIterations);
          log.info(`agent swap → anthropic (model=${resolved.apiModelId})`);
        }
        break;
      }
      case "http": {
        if (!resolved.available) {
          newReason = resolved.reason ?? `HTTP backend "${resolved.backendKey}" unreachable`;
        } else {
          const apiKey = inferenceRegistry.getBackendApiKey(resolved.backendKey);
          const factory = (): ChatBackend =>
            new HttpAgentBackend({
              baseUrl: resolved.url,
              apiPathPrefix: resolved.apiPathPrefix,
              protocol: resolved.protocol,
              model: resolved.model,
              maxToolIterations,
              apiKey,
              allowRemoteInference: resolved.allowRemoteInference,
              modelLimits: resolved.modelLimits,
              timeoutMs: resolved.agentTimeoutMs,
              modelControls: resolved.modelControls,
              modelBehavior: resolved.modelBehavior,
            });
          newService = this.makeAgentService(factory, maxToolIterations);
          log.info(`agent swap → http (backend=${resolved.backendKey} model=${resolved.model})`);
        }
        break;
      }
      case "codex": {
        if (!resolved.allowRemoteInference) {
          newReason = resolved.reason ?? CLOUD_EGRESS_DISABLED_REASON;
        } else if (!resolved.available) {
          newReason = resolved.reason ?? "Codex backend is unavailable.";
        } else if (!this.deps.codexRuntimeService) {
          newReason = "Codex runtime is not initialized on this gateway.";
        } else {
          const factory = (): ChatBackend =>
            this.deps.codexRuntimeService!.createBackend({
              model: resolved.model,
              ...(resolved.modelBehavior?.reasoningEffort
                ? { reasoningEffort: resolved.modelBehavior.reasoningEffort }
                : {}),
              maxToolIterations,
            });
          newService = this.makeAgentService(factory, maxToolIterations);
          log.info(`agent swap → codex (model=${resolved.model})`);
        }
        break;
      }
      case "local":
        newReason = "Local GGUF agent models are not yet supported.";
        break;
      default: {
        const _exhaustive: never = resolved;
        newReason = `Unexpected agent kind: ${(resolved as { kind: string }).kind}`;
        break;
      }
    }

    if (newService && this.anchoredThreadProfile) {
      newService.setAnchoredThreadProfile(this.anchoredThreadProfile);
    }
    if (newService && this.interactiveMemoryProfile) {
      newService.setInteractiveMemoryProfile(this.interactiveMemoryProfile);
    }
    if (newService && this.interactiveWriteProfile) {
      newService.setInteractiveWriteProfile(this.interactiveWriteProfile);
    }
    this.routeDeps.agentService = newService;
    this.routeDeps.answerService = newService
      ? this.makeAnswerService(newService, maxToolIterations)
      : undefined;
    this.routeDeps.disabledReason = newReason;
    this.routeDeps.disabledCode =
      (resolved.kind === "anthropic" || resolved.kind === "codex") && !resolved.allowRemoteInference
        ? "remote_inference_disabled"
        : resolved.kind === "http"
          ? resolved.reasonCode
          : undefined;
    this.routeDeps.agentConfig = {
      backend: resolved.kind,
      enabled: !!newService,
      disabledReason: newReason,
      disabledCode: this.routeDeps.disabledCode,
    };

    this.deps.wsEventHandler.attachAgentService(newService);
  }

  /** Dispose the agent harness, then flush + dispose the omnesis-chat runtime. */
  async shutdown(): Promise<void> {
    const { log } = this.deps;
    this.shuttingDown = true;
    if (this.privacySweepTimer) {
      clearInterval(this.privacySweepTimer);
      this.privacySweepTimer = null;
    }
    // Tear down the agent harness — clears idle-eviction timers and aborts
    // in-flight turns so shutdown doesn't wait on a long model call.
    await this.withAgentServiceStable(async () => {
      if (this.routeDeps.agentService) {
        try {
          await this.routeDeps.agentService.dispose();
        } catch (err) {
          log.error(
            `agentService.dispose threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
          );
        }
      }
    });
    // Flush any pending conversation upserts so a turn that finished
    // within the debounce window before SIGTERM still lands as a corpus
    // document; then drop timers so the event loop can exit. Each step
    // is independently fault-tolerant — flush failure must not block the
    // timer-clear.
    if (this.omnesisChatRuntime) {
      try {
        await this.omnesisChatRuntime.flushAll();
      } catch (err) {
        log.error(
          `omnesisChatRuntime.flushAll threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      }
      try {
        this.omnesisChatRuntime.dispose();
      } catch (err) {
        log.error(
          `omnesisChatRuntime.dispose threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      }
    }
  }
}

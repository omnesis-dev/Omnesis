// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tool registry — the agent's catalog of callable tools.
 *
 * Each backend turns the registry into its provider-native tool format
 * (Anthropic tool blocks, OpenAI function-call schemas, etc.). The session
 * passes the registry's handles to the backend per turn.
 *
 * `buildBuiltinTools(ports)` is the canonical wiring entry point used by
 * the gateway and the CLI. Tests can compose handles directly.
 */

import { createAnnotateManyTool } from "./annotate-many.js";
import { createCiteRecordTool } from "./cite-record.js";
import { createSpawnSubagentTool } from "./spawn-subagent.js";
import { createJoinSubagentsTool } from "./join-subagents.js";
import { createTraceConnectionsTool } from "./trace-connections.js";
import { createSearchManyTool } from "./search-many.js";
import { createFetchManyTool } from "./fetch-many.js";
import { createLookupDocumentByUrlTool } from "./lookup-document-by-url.js";
import { createLookupPeopleTool } from "./lookup-people.js";
import { createPlanTool, PlanStore } from "./plan.js";
import { createRunSqlTool } from "./run-sql.js";
import {
  createWatchCreateTool,
  createWatchDeleteTool,
  createWatchGetTool,
  createWatchProbeTool,
  createWatchUpdateTool,
  createWatchesListTool,
} from "./watch.js";
import { createSearchLoopsTool, createFetchLoopTool, createListLoopsTool } from "./loops.js";
import { createTemporalQueryTool } from "./temporal.js";
import { createEntityContextTool } from "./entity-context.js";
import type { ToolHandle } from "../backend.js";
import type { ToolPorts } from "./types.js";

export interface BuiltinToolsOptions {
  ports: ToolPorts;
  /** Default limit for search_documents (default: 8). */
  defaultSearchLimit?: number;
  /**
   * Whether the gateway runs in experimental mode. Gates every tool whose
   * feature is hidden behind the experimental flag on the other clients: the
   * watch-authoring tools (`watch_create` / `watch_update`), the
   * read-only loop tools (`list_loops`/`search_loops`/`fetch_loop`), temporal
   * query, and `entity_context`. Defaults to false.
   */
  experimental?: boolean;
  /**
   * Per-process plan store. The same instance must be reused across
   * every tool invocation in a session so the `plan` tool can
   * accumulate state across calls within a turn. Omit to get a fresh
   * `PlanStore()` — fine for tests but wrong for production wiring,
   * where the gateway service holds onto one.
   */
  planStore?: PlanStore;
}

/**
 * Build every shippable tool the agent knows about. Optional ports
 * (person, trail, sql) are skipped when undefined so test rigs can
 * include just the basics without stub implementations.
 */
export function buildBuiltinTools(opts: BuiltinToolsOptions): ToolHandle[] {
  const tools: ToolHandle[] = [];
  // Retrieval + citation are exposed to the model as BATCH tools only
  // (`search_many` / `fetch_many` / `annotate_many`). A batch of one covers the
  // singular case, so the model always emits one tool call for N operations —
  // collapsing the round-trips that dominate turn latency. The singular tools
  // are reused internally by each batch wrapper (validation, port call, result
  // shaping) but are not model-visible.
  tools.push(
    createSearchManyTool({
      port: opts.ports.search,
      defaultLimit: opts.defaultSearchLimit,
    }),
  );
  tools.push(createFetchManyTool({ port: opts.ports.document }));
  // `annotate_many` shares the document port with `fetch_many` — each child
  // loads the doc body to obtain the canonical ref for the citation card.
  tools.push(createAnnotateManyTool({ port: opts.ports.document }));
  tools.push(createPlanTool({ store: opts.planStore ?? new PlanStore() }));
  if (opts.ports.trail) {
    tools.push(createTraceConnectionsTool({ port: opts.ports.trail }));
  }
  if (opts.ports.sql) {
    tools.push(createRunSqlTool({ port: opts.ports.sql }));
  }
  // `cite_record` is the structured twin of `annotate`: it cites a single
  // analytics row the agent obtained from `run_sql` rowIdentities. Gated on a
  // record port being wired (a live analytics DB), like `run_sql`.
  if (opts.ports.record) {
    tools.push(createCiteRecordTool({ port: opts.ports.record }));
  }
  if (opts.ports.person) {
    tools.push(createLookupPeopleTool({ port: opts.ports.person }));
  }
  if (opts.ports.documentByUrl) {
    tools.push(createLookupDocumentByUrlTool({ port: opts.ports.documentByUrl }));
  }
  // The user's own watches, read and written. Natural language in; the gateway
  // compiles it into a notifying watch. Gated on a wired port AND experimental
  // mode, like every other surface the feature has. Raw DSL authoring is
  // deliberately absent — that stays with the operator over HTTP/CLI.
  if (opts.ports.watch && opts.experimental) {
    tools.push(createWatchesListTool({ port: opts.ports.watch }));
    tools.push(createWatchGetTool({ port: opts.ports.watch }));
    tools.push(createWatchProbeTool({ port: opts.ports.watch }));
    tools.push(createWatchCreateTool({ port: opts.ports.watch }));
    tools.push(createWatchUpdateTool({ port: opts.ports.watch }));
    tools.push(createWatchDeleteTool({ port: opts.ports.watch }));
  }
  // `spawn_subagent` + `join_subagents` are gated on a `subagent` port being
  // wired (#748): launch fans out children concurrently, join awaits them. A
  // child session at the depth cap is still built WITH the port (depth gating is
  // at runtime, in `SubagentService.spawn`), so a depth-1 child can spawn a
  // depth-2 child; the spawn throws `subagent_depth_exceeded` past the cap.
  if (opts.ports.subagent) {
    tools.push(createSpawnSubagentTool({ port: opts.ports.subagent }));
    tools.push(createJoinSubagentsTool({ port: opts.ports.subagent }));
  }
  // Read-only loop tools let the interactive agent leverage the background loop
  // agent's tracked obligations. Gated on BOTH a `loopRead` port being wired AND
  // experimental mode — the loop system only exists then, and it stays behind
  // the experimental flag on every client. No mutation surface (see loops.ts).
  if (opts.ports.loopRead && opts.experimental) {
    tools.push(createSearchLoopsTool({ port: opts.ports.loopRead }));
    tools.push(createFetchLoopTool({ port: opts.ports.loopRead }));
    tools.push(createListLoopsTool({ port: opts.ports.loopRead }));
  }
  // Read-only temporal query over deterministic projections and LLM-owned
  // annotations. Gated like loopRead: a wired port AND experimental mode.
  if (opts.ports.temporal && opts.experimental) {
    tools.push(createTemporalQueryTool({ port: opts.ports.temporal }));
  }
  // Read-only cognitive reap — the neighbourhood (loops/docs/people/time-entries)
  // the background agent linked around one entity, in a single call. Gated like
  // loopRead/temporal: a wired port AND experimental mode. Both agents get it.
  if (opts.ports.entityContext && opts.experimental) {
    tools.push(createEntityContextTool({ port: opts.ports.entityContext }));
  }
  return tools;
}

/** Look up a handle by name from a registry. Returns undefined if missing. */
export function findTool(tools: ReadonlyArray<ToolHandle>, name: string): ToolHandle | undefined {
  return tools.find((t) => t.name === name);
}

/**
 * Tools whose only product is a Timeline / citation-sidebar entry. A surface
 * that renders no Timeline gains nothing from them, and citations are a large
 * share of an ordinary turn's tool calls (`annotate_many` batches a turn's
 * citations, but a Timeline-less surface still records for nothing). Dropping
 * them from such a surface is pure latency saved, at
 * the cost of that conversation having no citations if it is later reopened
 * in a client that does render a Timeline.
 */
export const CITATION_TOOL_NAMES: ReadonlySet<string> = new Set(["annotate_many", "cite_record"]);

/**
 * Tools only the operator's own conversation may hold.
 *
 * A name list rather than a predicate on the handle, and for a different
 * reason than {@link selectSubagentTools}'s: these do not *write*, so nothing
 * about the handle distinguishes them. What distinguishes them is what they
 * hand back — corpus content in the runtime's own words, which is fine for the
 * person whose corpus it is and is a disclosure for anyone else.
 *
 * The compile path draws the same line by hand: the operator's agent is given
 * the compiler's free text, an off-host integration only the closed refusal
 * vocabulary.
 */
export const OPERATOR_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["watch_probe"]);

/** Drop the tools that belong to the operator's own conversation. */
export function selectSharedTools(tools: ReadonlyArray<ToolHandle>): ToolHandle[] {
  return tools.filter((t) => !OPERATOR_ONLY_TOOL_NAMES.has(t.name));
}

/** Fixed retrieval/evidence capabilities granted to ordinary generic workers. */
export const GENERIC_SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_many",
  "fetch_many",
  "lookup_document_by_url",
  "trace_connections",
  "run_sql",
  "lookup_people",
  "annotate_many",
  "search_loops",
  "fetch_loop",
  "list_loops",
  "temporal_query",
  "entity_context",
]);

/**
 * Drop the Timeline-only citation tools, for a surface that renders no
 * Timeline.
 */
export function selectNonCitationTools(tools: ReadonlyArray<ToolHandle>): ToolHandle[] {
  return tools.filter((t) => !CITATION_TOOL_NAMES.has(t.name));
}

/**
 * Select the tool set a sub-agent runs with (#748): start from the parent's
 * tools, drop every tool that declares `mutates`, and, when an owned workflow
 * supplies a private specialist allowlist, keep only those named read tools.
 * Ordinary interactive workers use {@link selectGenericSubagentTools} instead.
 *
 * The exclusion is a **predicate over the handle**, not a list of names kept
 * beside it. A name list has to be remembered: a write tool added next month is
 * inherited by every sub-agent until somebody notices. A handle that declares
 * what it does carries its own classification to every selector, and
 * `builtin-tools.mutates.test.ts` reddens when a new tool arrives undeclared.
 */
export function selectSubagentTools(
  parentTools: ReadonlyArray<ToolHandle>,
  allowlist?: ReadonlyArray<string>,
): ToolHandle[] {
  const allow = allowlist === undefined ? null : new Set(allowlist);
  return parentTools.filter((t) => {
    if (t.mutates === true) return false;
    if (allow && !allow.has(t.name)) return false;
    return true;
  });
}

/**
 * Fixed host policy for ordinary interactive workers. They may retrieve and
 * reason over every currently eligible read surface, and may use
 * `annotate_many` to propagate deliberate evidence to their parent. They never
 * receive writes, automation controls, parent presentation/orchestration
 * tools, or delegation tools, so generic fan-out is exactly one level deep.
 */
export function selectGenericSubagentTools(parentTools: ReadonlyArray<ToolHandle>): ToolHandle[] {
  return parentTools
    .filter((tool) => GENERIC_SUBAGENT_TOOL_NAMES.has(tool.name) && tool.mutates !== true)
    .map((tool) =>
      tool.name === "annotate_many"
        ? {
            ...tool,
            description:
              "Report every document this finding relies on as deliberate evidence for the " +
              "parent agent. Batch all document ids into one call. This propagates evidence " +
              "references only and grants no write capability.",
          }
        : tool,
    );
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fixed, read-only tool façade for Direct MCP clients.
 *
 * The façade deliberately reuses the canonical `@omnesis/agent` handles and
 * the same gateway ports as the built-in agent. It does not construct an
 * AgentService or resolve a model: an external agent supplies the reasoning
 * loop and invokes these tools directly over HTTP. The fixed allowlist below
 * is the security boundary — presentation, citation, delegation, automation,
 * admin, and every mutating handle are absent even if the built-in registry
 * grows later.
 */

import { createHash } from "node:crypto";

import {
  buildBuiltinTools,
  renderAnalyticsRetrievalGuidance,
  renderReadOnlyRetrievalPlaybook,
  zodToJsonSchema,
  type ReadOnlyRetrievalPlaybookInput,
  type ToolHandle,
  type ToolContext,
} from "@omnesis/agent";
import { experimentalVisible, type ToolResult } from "@omnesis/core";

import { createGatewayLoopReadPort } from "../brain/interactive-loop-port.js";
import { listSources } from "../data/repositories/SourceRepository.js";
import { permittedSourceIds } from "../access/permitted-sources.js";
import { createGatewayEntityContextPort } from "../domain/cognitive-graph/interactive-entity-context-port.js";
import { createGatewayTemporalPort } from "../enrichment/temporal/interactive-temporal-port.js";
import { createDirectListTablesTool } from "./direct-list-tables.js";
import { DIRECT_MCP_ESSENTIAL_INSTRUCTIONS } from "./direct-instructions.js";
import {
  createGatewayDocumentByUrlPort,
  createGatewayDocumentPort,
  createGatewayPersonPort,
  createGatewaySearchPort,
  createGatewaySqlPort,
  createGatewayTrailPort,
} from "./ports.js";
import type { AnalyticsDb } from "../analytics-db.js";
import type { PersonLookupGate } from "../domain/person-lookup.js";
import type { SearchPipeline } from "../search/pipeline.js";
import type { SyncStatusRegistry } from "../sync-status.js";
import type Database from "better-sqlite3";
import type { CorpusAuthorization } from "../access/corpus-authorization.js";

export const DIRECT_MCP_TOOL_NAMES = [
  "search_many",
  "fetch_many",
  "lookup_document_by_url",
  "lookup_people",
  "trace_connections",
  "run_sql",
  "temporal_query",
  "entity_context",
  "search_loops",
  "list_loops",
  "fetch_loop",
  "list_tables",
] as const;

export type DirectMcpToolName = (typeof DIRECT_MCP_TOOL_NAMES)[number];

/** Generally available Direct tools. The remainder follow the product-wide experimental gate. */
export const STABLE_DIRECT_MCP_TOOL_NAMES = [
  "search_many",
  "fetch_many",
  "lookup_document_by_url",
  "lookup_people",
  "trace_connections",
  "run_sql",
  "list_tables",
] as const satisfies readonly DirectMcpToolName[];

export const RESTRICTED_DIRECT_MCP_TOOL_NAMES = [
  "search_many",
  "fetch_many",
  "lookup_document_by_url",
  "run_sql",
  "list_tables",
] as const satisfies readonly DirectMcpToolName[];

const RESTRICTED_DIRECT_MCP_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  RESTRICTED_DIRECT_MCP_TOOL_NAMES,
);

/** Hard egress ceiling before the HTTP/MCP layers duplicate serialized data. */
export const MAX_DIRECT_MCP_RESULT_BYTES = 1024 * 1024;
export const MAX_DIRECT_MCP_INSTRUCTIONS_BYTES = 128 * 1024;

/**
 * Direct clients receive full document bodies outside the privacy gate. Keep
 * this lower than the built-in agent's generic batch size so a single external
 * request cannot materialize sixteen attachment-sized bodies before the final
 * response ceiling is checked. The external agent can issue another explicit
 * fetch when it genuinely needs more evidence.
 */
export const MAX_DIRECT_MCP_FETCH_DOCUMENTS = 2;
export const MAX_DIRECT_MCP_STORED_DOCUMENT_BYTES = 384 * 1024;
export const MAX_DIRECT_MCP_TEMPORAL_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

const DIRECT_MCP_TOOL_NAME_SET: ReadonlySet<string> = new Set(DIRECT_MCP_TOOL_NAMES);

export function isDirectMcpToolName(value: string): value is DirectMcpToolName {
  return DIRECT_MCP_TOOL_NAME_SET.has(value);
}

export interface DirectMcpToolManifest {
  name: DirectMcpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DirectMcpInvokeContext {
  requestId: string;
  timeZone?: string;
  signal?: AbortSignal;
  authorization?: CorpusAuthorization;
}

/**
 * Optional grouping keys an external agent may attach to any Direct tool
 * call, mirroring the `conversationId`/`workflowId` that `ask_omnesis`
 * accepts. They are audit-only: the transcript writer groups calls carrying
 * the same key into one session, and the service strips them before the
 * canonical handles ever see them. Absent keys fall back to heuristic
 * sessionization, so old agents keep working unchanged.
 */
export const DIRECT_GROUPING_PARAM_NAMES = ["conversationId", "workflowId"] as const;

/**
 * Shape of an audit grouping key, shared with the transcript writer so a
 * schema-accepted key always groups instead of silently falling back.
 * Mirrors the Answer MCP id shape.
 */
export const DIRECT_GROUPING_KEY_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

export type DirectGroupingParams = Partial<
  Record<(typeof DIRECT_GROUPING_PARAM_NAMES)[number], string>
>;

function injectDirectGroupingParams(inputSchema: Record<string, unknown>): void {
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
  for (const name of DIRECT_GROUPING_PARAM_NAMES) {
    if (name in (properties as Record<string, unknown>)) {
      throw new Error(`Direct grouping param '${name}' collides with a canonical tool parameter.`);
    }
    (properties as Record<string, unknown>)[name] = {
      type: "string",
      maxLength: 128,
      pattern: DIRECT_GROUPING_KEY_PATTERN.source,
      description:
        "Optional audit grouping: carry the stable external-agent workflow or conversation id so these calls group into one transcript session in the Audit view. Has no effect on the tool result.",
    };
  }
}

/** Split audit-only grouping keys off the tool arguments. */
export function stripDirectGroupingParams(args: Readonly<Record<string, unknown>>): {
  grouping: DirectGroupingParams;
  args: Record<string, unknown>;
} {
  const grouping: DirectGroupingParams = {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "conversationId" || key === "workflowId") {
      // Audit-only keys never reach the canonical handles. Anything that is
      // not a well-formed grouping key carries no grouping meaning, so drop
      // it outright rather than forwarding it into strict schemas.
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (DIRECT_GROUPING_KEY_PATTERN.test(trimmed)) grouping[key] = trimmed;
      }
    } else {
      cleaned[key] = value;
    }
  }
  return { grouping, args: cleaned };
}

/** Cap for one audited args/result value; larger values keep a digest sentinel. */
export const MAX_DIRECT_AUDIT_VALUE_BYTES = 128 * 1024;

/**
 * Bound one audited args/result value the way Answer traces bound tool
 * payloads. Pure and idempotent: the route applies it before enqueueing so
 * the single writer only ever serializes small normalized values, and the
 * writer re-applies it as a backstop for other callers.
 */
export function boundDirectAuditValue(value: unknown): unknown {
  const raw = JSON.stringify(value);
  if (raw === undefined) return { unavailable: true, reason: "not_json_serializable" };
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes <= MAX_DIRECT_AUDIT_VALUE_BYTES) return JSON.parse(raw) as unknown;
  return {
    truncated: true,
    reason: "tool_payload_limit",
    originalBytes: bytes,
    sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
  };
}

export class DirectMcpService {
  private readonly byName: ReadonlyMap<DirectMcpToolName, ToolHandle>;
  private readonly toolsManifest: readonly DirectMcpToolManifest[];

  constructor(
    handles: readonly ToolHandle[],
    private readonly instructionContext: (
      authorization?: CorpusAuthorization,
    ) => Promise<ReadOnlyRetrievalPlaybookInput> = () => Promise.resolve({}),
    private readonly scopedHandles?: (authorization: CorpusAuthorization) => readonly ToolHandle[],
  ) {
    const available = new Map(handles.map((handle) => [handle.name, handle]));
    available.set("list_tables", this.listTablesHandle());
    const experimentalNames = DIRECT_MCP_TOOL_NAMES.filter(
      (name) =>
        !STABLE_DIRECT_MCP_TOOL_NAMES.includes(
          name as (typeof STABLE_DIRECT_MCP_TOOL_NAMES)[number],
        ),
    );
    const experimentalCount = experimentalNames.filter((name) => available.has(name)).length;
    if (experimentalCount !== 0 && experimentalCount !== experimentalNames.length) {
      throw new Error("Direct MCP experimental tool inventory is only partially wired");
    }
    const advertisedNames =
      experimentalCount === experimentalNames.length
        ? DIRECT_MCP_TOOL_NAMES
        : STABLE_DIRECT_MCP_TOOL_NAMES;
    const selected = advertisedNames.map((name) => {
      const handle = available.get(name);
      if (!handle) throw new Error(`Direct MCP canonical tool is not wired: ${name}`);
      if (handle.mutates === true) {
        throw new Error(`Direct MCP refused mutating canonical tool: ${name}`);
      }
      return [name, handle] as const;
    });
    this.byName = new Map(selected);
    this.toolsManifest = selected.map(([name, handle]) => {
      const inputSchema = zodToJsonSchema(handle.schema) as Record<string, unknown>;
      if (name === "fetch_many") constrainFetchManyManifest(inputSchema);
      injectDirectGroupingParams(inputSchema);
      return {
        name,
        description:
          name === "run_sql"
            ? "Call list_tables first to discover permitted tables and columns (follow nextOffset). " +
              "Run a read-only DuckDB query for aggregates, trends, comparisons, or structured records. " +
              "Use only discovered tables and columns; keep date windows and maxRows bounded. " +
              "Operational SQLite, writes, file reads, and external access are unavailable."
            : handle.description,
        inputSchema,
      };
    });
  }

  private listTablesHandle(authorization?: CorpusAuthorization): ToolHandle {
    return createDirectListTablesTool(
      async () => (await this.instructionContext(authorization)).catalog ?? [],
    );
  }

  manifest(authorization?: CorpusAuthorization): readonly DirectMcpToolManifest[] {
    return authorization?.restricted
      ? this.toolsManifest.filter((tool) => RESTRICTED_DIRECT_MCP_TOOL_NAME_SET.has(tool.name))
      : this.toolsManifest;
  }

  async instructions(authorization?: CorpusAuthorization): Promise<string> {
    if (authorization?.restricted) {
      const context = await this.instructionContext(authorization);
      const sourceTypes = context.sourceTypes?.length
        ? ` Permitted configured source types: ${context.sourceTypes.map((value) => `\`${value}\``).join(", ")}.`
        : "";
      const head =
        "This grant is restricted to selected source instances. Only `search_many`, " +
        "`fetch_many`, `lookup_document_by_url`, `list_tables`, and `run_sql` are available. Source filters may narrow " +
        "the grant but can never widen it. The person filters (`from:`, `by:`, `to:`, `with:`) " +
        "and tag filters (`tag:`, `#tag`) are not available to this grant; a query carrying one " +
        `is refused with an \`unsupported_filter\` error naming the token to remove.${sourceTypes} ` +
        "`run_sql` reads only the permitted tables returned by `list_tables` — a query touching any other " +
        "table, or calling a table function, is refused with a `sql_not_permitted` error naming it.";
      const full = `${DIRECT_MCP_ESSENTIAL_INSTRUCTIONS}${head}\n${renderAnalyticsRetrievalGuidance([], "discovery")}`;
      if (Buffer.byteLength(full, "utf8") > MAX_DIRECT_MCP_INSTRUCTIONS_BYTES) {
        throw new Error("Direct MCP instructions exceeded the safe size limit");
      }
      return full;
    }
    const instructions =
      DIRECT_MCP_ESSENTIAL_INSTRUCTIONS +
      renderReadOnlyRetrievalPlaybook({
        sourceTypes: (await this.instructionContext(authorization)).sourceTypes,
        catalogMode: "discovery",
        fetchBatchLimit: MAX_DIRECT_MCP_FETCH_DOCUMENTS,
        includeTemporal: this.byName.has("temporal_query"),
        includeCognition: this.byName.has("entity_context"),
      });
    if (Buffer.byteLength(instructions, "utf8") > MAX_DIRECT_MCP_INSTRUCTIONS_BYTES) {
      throw new Error("Direct MCP instructions exceeded the safe size limit");
    }
    return instructions;
  }

  async invoke(
    name: DirectMcpToolName,
    args: Record<string, unknown>,
    context: DirectMcpInvokeContext,
  ): Promise<ToolResult> {
    if (context.authorization?.restricted && !RESTRICTED_DIRECT_MCP_TOOL_NAME_SET.has(name)) {
      return { kind: "error", code: "tool_not_found", message: "Direct MCP tool not found" };
    }
    const handle =
      name === "list_tables"
        ? this.listTablesHandle(context.authorization)
        : context.authorization?.restricted
          ? new Map(
              (this.scopedHandles?.(context.authorization) ?? []).map((candidate) => [
                candidate.name,
                candidate,
              ]),
            ).get(name)
          : this.byName.get(name);
    // The route validates the path first. Keep the service fail-closed too so
    // another future caller cannot widen the fixed surface by casting a name.
    if (!handle) {
      return { kind: "error", code: "tool_not_found", message: "Direct MCP tool not found" };
    }
    // Grouping keys are audit-only and never reach the canonical handles:
    // several schemas are strict and would refuse them as invalid_args.
    const stripped = stripDirectGroupingParams(args);
    const toolArgs = stripped.args;
    if (name === "fetch_many" && exceedsDirectFetchLimit(toolArgs)) {
      return {
        kind: "error",
        code: "invalid_args",
        message: `Direct MCP fetch_many accepts at most ${MAX_DIRECT_MCP_FETCH_DOCUMENTS} documents per call.`,
      };
    }
    const toolContext: ToolContext = {
      sessionId: "mcp-direct",
      messageId: context.requestId,
      ...(context.timeZone ? { timeZone: context.timeZone } : {}),
      ...(context.signal ? { abortSignal: context.signal } : {}),
    };
    const rawResult = await handle.invoke(toolArgs, toolContext);
    const result = sanitizeDirectToolResult(
      rawResult.kind === "error" && rawResult.code === "sql_not_permitted"
        ? {
            ...rawResult,
            message:
              rawResult.message + " Call list_tables to discover permitted tables and columns.",
          }
        : rawResult,
    );
    let serialized: string;
    try {
      serialized = JSON.stringify(result);
    } catch {
      return {
        kind: "error",
        code: "result_serialization_failed",
        message: "The Direct MCP tool result could not be serialized.",
      };
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_DIRECT_MCP_RESULT_BYTES) {
      return {
        kind: "error",
        code: "result_too_large",
        message: "The Direct MCP tool result exceeded the response-size limit.",
      };
    }
    return result;
  }
}

function exceedsDirectFetchLimit(args: Record<string, unknown>): boolean {
  return Array.isArray(args.documents) && args.documents.length > MAX_DIRECT_MCP_FETCH_DOCUMENTS;
}

function constrainFetchManyManifest(schema: Record<string, unknown>): void {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("Direct MCP fetch_many schema has no properties object");
  }
  const documents = (properties as Record<string, unknown>).documents;
  if (!documents || typeof documents !== "object" || Array.isArray(documents)) {
    throw new Error("Direct MCP fetch_many schema has no documents array");
  }
  (documents as Record<string, unknown>).maxItems = MAX_DIRECT_MCP_FETCH_DOCUMENTS;
}

/**
 * Canonical tools run in-process for the built-in agent and some include the
 * caught dependency's message in an error result. Direct MCP crosses a trust
 * boundary, so retain only the stable machine code and replace every message
 * with a categorical, path-free string. Batch children need the same treatment
 * because one failed search/fetch is nested inside an otherwise successful
 * batch result.
 */
export function sanitizeDirectToolResult(result: ToolResult): ToolResult {
  if (result.kind === "error") {
    return safeDirectToolError(result);
  }
  if (result.kind === "search.batch") {
    return {
      ...result,
      items: result.items.map((item) => (item.kind === "error" ? safeDirectToolError(item) : item)),
    };
  }
  if (result.kind === "document.batch") {
    return {
      ...result,
      items: result.items.map((item) => (item.kind === "error" ? safeDirectToolError(item) : item)),
    };
  }
  if (result.kind === "annotate.batch") {
    return {
      ...result,
      items: result.items.map((item) => (item.kind === "error" ? safeDirectToolError(item) : item)),
    };
  }
  return result;
}

const DIRECT_MCP_SAFE_ERROR_CODES = new Set([
  "invalid_args",
  "catalog_failed",
  "not_found",
  "seed_not_found",
  "sql_over_cap",
  "sql_not_permitted",
  "sql_failed",
  "search_failed",
  "unsupported_filter",
  "fetch_failed",
  "lookup_failed",
  "trail_walk_failed",
  "temporal_query_failed",
  "entity_context_failed",
  "search_loops_failed",
  "list_loops_failed",
  "fetch_loop_failed",
]);

/**
 * Error codes whose message the gateway composes from the caller's own
 * request and nothing else, so it reaches the client verbatim. Every other
 * message is replaced by a fixed sentence for its code, because a dependency
 * or driver error can quote paths, SQL or corpus text.
 */
const DIRECT_MCP_PASSTHROUGH_MESSAGE_CODES = new Set(["unsupported_filter", "sql_not_permitted"]);

function safeDirectToolError(
  result: Extract<ToolResult, { kind: "error" }>,
): Extract<ToolResult, { kind: "error" }> {
  const code = DIRECT_MCP_SAFE_ERROR_CODES.has(result.code) ? result.code : "tool_failed";
  const message = DIRECT_MCP_PASSTHROUGH_MESSAGE_CODES.has(code)
    ? result.message
    : safeDirectToolErrorMessage(code);
  return { kind: "error", code, message };
}

function safeDirectToolErrorMessage(code: string): string {
  switch (code) {
    case "invalid_args":
      return "Tool arguments were invalid.";
    case "not_found":
      return "The requested item was not found.";
    case "seed_not_found":
      return "A requested connection seed was not found.";
    case "sql_over_cap":
      return "The SQL result exceeded the row limit. Narrow the query and retry.";
    case "catalog_failed":
      return "The analytics catalog could not be read.";
    case "sql_failed":
      return "The read-only SQL query failed.";
    case "sql_not_permitted":
      // Unreachable while the code stays in the passthrough set above;
      // a backstop so a future edit degrades to a scoped message, never
      // to the generic tool failure.
      return "The SQL query touched tables outside this grant.";
    case "search_failed":
      return "The document search failed.";
    case "fetch_failed":
      return "The document fetch failed.";
    case "lookup_failed":
      return "The lookup failed.";
    case "trail_walk_failed":
      return "The connection trace failed.";
    case "temporal_query_failed":
      return "The temporal query failed.";
    case "entity_context_failed":
      return "The entity-context query failed.";
    case "search_loops_failed":
      return "The loop search failed.";
    case "list_loops_failed":
      return "The loop listing failed.";
    case "fetch_loop_failed":
      return "The loop fetch failed.";
    default:
      return "The Direct MCP tool request failed.";
  }
}

export interface GatewayDirectMcpDeps {
  db: Database.Database;
  searchPipeline: SearchPipeline;
  analyticsDb: AnalyticsDb;
  syncStatus?: SyncStatusRegistry;
  personLookupGate?: PersonLookupGate;
}

/** Build the fixed façade without consulting any agent/model assignment. */
export function createGatewayDirectMcpService(deps: GatewayDirectMcpDeps): DirectMcpService {
  const buildHandles = (authorization?: CorpusAuthorization) =>
    buildBuiltinTools({
      experimental: experimentalVisible() && !authorization?.restricted,
      ports: authorization?.restricted
        ? {
            search: createGatewaySearchPort(
              deps.searchPipeline,
              deps.syncStatus,
              deps.db,
              authorization,
            ),
            document: createGatewayDocumentPort(
              deps.db,
              deps.syncStatus,
              { maxStoredDocumentBytes: MAX_DIRECT_MCP_STORED_DOCUMENT_BYTES },
              authorization,
            ),
            documentByUrl: createGatewayDocumentByUrlPort(deps.db, deps.syncStatus, authorization),
            // In this branch the authorization is restricted, so the set
            // below is never null — an empty grant simply denies every table.
            sql: createGatewaySqlPort(deps.analyticsDb, {
              permittedSourceIds: permittedSourceIds(deps.db, authorization) ?? new Set<string>(),
            }),
          }
        : {
            search: createGatewaySearchPort(deps.searchPipeline, deps.syncStatus, deps.db),
            document: createGatewayDocumentPort(deps.db, deps.syncStatus, {
              maxStoredDocumentBytes: MAX_DIRECT_MCP_STORED_DOCUMENT_BYTES,
            }),
            documentByUrl: createGatewayDocumentByUrlPort(deps.db, deps.syncStatus),
            person: createGatewayPersonPort(deps.db, { lookupGate: deps.personLookupGate }),
            trail: createGatewayTrailPort(deps.db, deps.analyticsDb),
            sql: createGatewaySqlPort(deps.analyticsDb),
            temporal: createGatewayTemporalPort(deps.db, deps.analyticsDb, {
              maxWindowMs: MAX_DIRECT_MCP_TEMPORAL_WINDOW_MS,
            }),
            entityContext: createGatewayEntityContextPort(deps.db),
            loopRead: createGatewayLoopReadPort(deps.db),
          },
    });
  return new DirectMcpService(
    buildHandles(),
    async (authorization) => {
      const permitted = authorization ? permittedSourceIds(deps.db, authorization) : null;
      const liveCatalog = await deps.analyticsDb.getCatalog();
      return {
        // Restricted grants see only their permitted sources' tables, so
        // the agent can discover what its scoped `run_sql` may query.
        // `null` (unrestricted) sees the whole catalog, as before.
        catalog: permitted
          ? liveCatalog.filter((entry) => permitted.has(entry.sourceId))
          : liveCatalog,
        sourceTypes: [
          ...new Set(
            listSources(deps.db)
              .filter((source) => !permitted || permitted.has(source.id))
              .map((source) => source.type),
          ),
        ],
      };
    },
    (authorization) => buildHandles(authorization),
  );
}

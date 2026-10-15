// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The read and citation fence a background Brain run sees around sources
 * excluded from the Brain (`brain.excludedSources`, `../source-exclusion.ts`).
 *
 * Two layers, both applied only to background runs — the interactive agent
 * builds its tools without them:
 *
 * - {@link fenceReadPorts} wraps the read ports behind the shared read tools
 *   (`search_many`, `fetch_many`, `lookup_document_by_url`,
 *   `trace_connections`, `temporal_query`, `entity_context`, `run_sql`), so
 *   an excluded source's documents, trail events, time-index items and
 *   analytics tables never reach the model. A direct fetch of one reads as not
 *   found.
 * - {@link fenceExcludedDocumentArguments} refuses any tool call whose
 *   arguments name a document of an excluded source — as an id, a list entry,
 *   an object key, or a `source:<id>` reference inside text — so a run can
 *   neither read one through a Brain-only tool nor cite one as evidence.
 *
 * Both read the exclusion live, so a config change applies to the next call
 * of a run already in flight.
 */

import type { DocRef, EventTrail, TemporalQueryResult, TrailEvent } from "@omnesis/core";
import type { EntityContextResult, SqlPort, ToolHandle, ToolPorts } from "@omnesis/agent";
import type { BrainSourceFence } from "../source-exclusion.js";
import type Database from "better-sqlite3";

/** The error code a fenced tool call answers with. */
export const EXCLUDED_SOURCE_ERROR_CODE = "excluded_source";

/**
 * Drop nested references to excluded documents from one search or fetch hit.
 * Graph-context provenance that touches one in any part (copies, paths, the
 * model context) is dropped whole: rebuilding its summary is not possible here.
 */
function scrubDocRef(ref: DocRef, fence: BrainSourceFence): DocRef {
  const breadcrumb = ref.breadcrumb;
  const provenance = ref.provenance;
  if (!breadcrumb?.length && !provenance) return ref;
  const excluded = fence.excludedDocuments([
    ...(breadcrumb ?? []).map((crumb) => crumb.documentId),
    ...(provenance ? candidateDocumentIds(provenance).ids : []),
  ]);
  if (excluded.size === 0) return ref;
  const { provenance: _dropped, ...rest } = ref;
  const provenanceClean =
    provenance && ![...candidateDocumentIds(provenance).ids].some((id) => excluded.has(id));
  return {
    ...rest,
    ...(breadcrumb
      ? { breadcrumb: breadcrumb.filter((crumb) => !excluded.has(crumb.documentId)) }
      : {}),
    ...(provenance && provenanceClean ? { provenance } : {}),
  };
}

function fenceTrailEvents(events: readonly TrailEvent[], fence: BrainSourceFence): TrailEvent[] {
  return events
    .filter(
      (event) =>
        !(event.doc && fence.excludesSource(event.doc.sourceId)) &&
        !(event.record && fence.excludesSource(event.record.sourceId)),
    )
    .map((event) => ({
      ...event,
      attachments: fenceTrailEvents(event.attachments, fence),
      related: event.related.filter((related) => !fence.excludesSource(related.sourceId)),
    }));
}

const EMPTY_TRAIL: EventTrail = {
  seeds: [],
  events: [],
  truncated: false,
  stats: { visited: 0, elapsedMs: 0, maxDepthReached: 0 },
};

/** A temporal read result without the items and coverage of excluded sources. */
export function fenceTemporalResult(
  result: TemporalQueryResult,
  live: BrainSourceFence,
): TemporalQueryResult {
  const fence = live.snapshot();
  if (fence.entries().length === 0) return result;
  const annotationDocs = result.items.flatMap((item) => item.annotation?.documentIds ?? []);
  const excludedDocs = fence.excludedDocuments(annotationDocs);
  return {
    ...result,
    items: result.items
      .filter(
        (item) =>
          !(item.projection && fence.excludesSource(item.projection.sourceId)) &&
          !(item.mention && fence.excludesSource(item.mention.sourceId)),
      )
      .map((item) =>
        item.annotation && item.annotation.documentIds.some((id) => excludedDocs.has(id))
          ? {
              ...item,
              annotation: {
                ...item.annotation,
                documentIds: item.annotation.documentIds.filter((id) => !excludedDocs.has(id)),
              },
            }
          : item,
      ),
    coverage: {
      ...result.coverage,
      projectionSources: result.coverage.projectionSources.filter(
        (source) => !fence.excludesSource(source.sourceId),
      ),
      specialistSources: result.coverage.specialistSources.filter(
        (source) => !fence.excludesSource(source.sourceId),
      ),
    },
  };
}

/** Wrap a temporal reader (the service behind prompts) with {@link fenceTemporalResult}. */
export function fenceTemporalReader<Args extends unknown[]>(
  reader: { query(...args: Args): Promise<TemporalQueryResult> },
  fence: BrainSourceFence,
): { query(...args: Args): Promise<TemporalQueryResult> } {
  return {
    query: async (...args: Args) => fenceTemporalResult(await reader.query(...args), fence),
  };
}

function fenceEntityContext(
  result: EntityContextResult,
  fence: BrainSourceFence,
): EntityContextResult {
  const unattributed = fence.excludedDocuments(
    result.documents.filter((doc) => doc.sourceId === undefined).map((doc) => doc.documentId),
  );
  const documents = result.documents.filter((doc) =>
    doc.sourceId === undefined
      ? !unattributed.has(doc.documentId)
      : !fence.excludesSource(doc.sourceId),
  );
  const removed = result.documents.length - documents.length;
  return removed === 0
    ? result
    : {
        ...result,
        documents,
        counts: { ...result.counts, documents: Math.max(0, result.counts.documents - removed) },
      };
}

/**
 * The read ports of a background run with excluded sources fenced out.
 * `sqlPortFor` builds a SQL port limited to the given source ids' tables — the
 * same scoping a source-restricted access grant uses.
 */
export function fenceReadPorts(
  ports: ToolPorts,
  live: BrainSourceFence,
  sql?: {
    sqlPortFor: (permittedSourceIds: ReadonlySet<string>) => SqlPort;
    catalogSourceIds: () => Promise<readonly string[]>;
  },
): ToolPorts {
  // Each call checks against one snapshot of the list, read once.
  const current = (): BrainSourceFence | null => {
    const fence = live.snapshot();
    return fence.entries().length > 0 ? fence : null;
  };
  const fenced: ToolPorts = {
    ...ports,
    search: {
      async search(input, signal) {
        const fence = current();
        if (!fence) return ports.search.search(input, signal);
        // Ask for more so hits from excluded sources do not starve the page.
        const limit = input.limit;
        const result = await ports.search.search(
          limit === undefined ? input : { ...input, limit: limit * 2 },
          signal,
        );
        const kept = result.results
          .filter((ref) => !fence.excludesSource(ref.sourceId))
          .slice(0, limit ?? Number.POSITIVE_INFINITY)
          .map((ref) => scrubDocRef(ref, fence));
        return { ...result, results: kept };
      },
    },
    document: {
      ...(ports.document.requiresCitationRead !== undefined
        ? { requiresCitationRead: ports.document.requiresCitationRead }
        : {}),
      ...(ports.document.supportsKnowledgeAliases !== undefined
        ? { supportsKnowledgeAliases: ports.document.supportsKnowledgeAliases }
        : {}),
      async fetch(documentId, opts) {
        const fence = current();
        if (!fence) return ports.document.fetch(documentId, opts);
        if (fence.excludedDocuments([documentId]).size > 0) return null;
        const result = await ports.document.fetch(documentId, opts);
        if (!result) return result;
        if (fence.excludesSource(result.ref.sourceId)) return null;
        return {
          ...result,
          ref: scrubDocRef(result.ref, fence),
          ...(result.neighbors
            ? {
                neighbors: result.neighbors
                  .filter((neighbor) => !fence.excludesSource(neighbor.sourceId))
                  .map((neighbor) => scrubDocRef(neighbor, fence)),
              }
            : {}),
        };
      },
    },
  };
  if (ports.documentByUrl) {
    const port = ports.documentByUrl;
    fenced.documentByUrl = {
      async lookup(url, signal) {
        const fence = current();
        const result = await port.lookup(url, signal);
        if (!fence || !result.ref || !fence.excludesSource(result.ref.sourceId)) return result;
        return { url: result.url, durationMs: result.durationMs };
      },
    };
  }
  if (ports.trail) {
    const port = ports.trail;
    fenced.trail = {
      ...(port.graphContext !== undefined ? { graphContext: port.graphContext } : {}),
      async build(seedIds, opts) {
        const fence = current();
        if (!fence) return port.build(seedIds, opts);
        const excluded = fence.excludedDocuments(seedIds);
        const seeds = seedIds.filter((id) => !excluded.has(id));
        if (seeds.length === 0) return EMPTY_TRAIL;
        const trail = await port.build(seeds, opts);
        return { ...trail, events: fenceTrailEvents(trail.events, fence) };
      },
    };
  }
  if (ports.temporal) {
    const port = ports.temporal;
    fenced.temporal = {
      async query(input, signal) {
        return fenceTemporalResult(await port.query(input, signal), live);
      },
    };
  }
  if (ports.entityContext) {
    const port = ports.entityContext;
    fenced.entityContext = {
      async reap(seed, opts, signal) {
        const fence = current();
        if (fence && seed.kind === "document" && fence.excludedDocuments([seed.id]).size > 0)
          return {
            seed: null,
            loops: [],
            documents: [],
            people: [],
            temporalAnnotations: [],
            truncated: false,
            counts: { loops: 0, documents: 0, people: 0, temporalAnnotations: 0 },
          };
        const result = await port.reap(seed, opts, signal);
        return fence ? fenceEntityContext(result, fence) : result;
      },
    };
  }
  if (ports.sql && sql) {
    const port = ports.sql;
    fenced.sql = {
      async run(statement, opts) {
        const fence = current();
        if (!fence) return port.run(statement, opts);
        const permitted = new Set(
          (await sql.catalogSourceIds()).filter((sourceId) => !fence.excludesSource(sourceId)),
        );
        return sql.sqlPortFor(permitted).run(statement, opts);
      },
    };
  }
  return fenced;
}

/** Longest argument string still considered as a possible document id. */
const MAX_ID_LENGTH = 512;
/** Bound on the candidate strings one call's arguments contribute. */
const MAX_CANDIDATES = 4096;
/** Deepest argument nesting inspected. */
const MAX_DEPTH = 16;
/** `source:<documentId>` inside free text, up to a selector or delimiter. */
const SOURCE_REFERENCE = /source:([^\s#"'<>()[\]{},;`]+)/g;

/**
 * Every string an argument tree names that could be a document id, and
 * whether the walk saw all of it. A tree past the candidate or depth bound is
 * reported incomplete so the caller can refuse it rather than pass it unread.
 */
function candidateDocumentIds(args: unknown): { ids: Set<string>; complete: boolean } {
  const ids = new Set<string>();
  let complete = true;
  const add = (text: string) => {
    if (text.length > 0 && text.length <= MAX_ID_LENGTH && !/\s/.test(text)) ids.add(text);
    for (const match of text.matchAll(SOURCE_REFERENCE)) ids.add(match[1]!);
    if (ids.size > MAX_CANDIDATES) complete = false;
  };
  const visit = (value: unknown, depth: number) => {
    if (!complete) return;
    if (depth > MAX_DEPTH) {
      complete = false;
      return;
    }
    if (typeof value === "string") add(value);
    else if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else if (value !== null && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        add(key);
        visit(item, depth + 1);
      }
  };
  visit(args, 0);
  return { ids, complete };
}

/**
 * Refuse any call whose arguments name a document of an excluded source,
 * before the tool runs. The refusal names the documents so the run can drop
 * them and carry on with the rest of its work.
 *
 * `alreadyCited` names, per call, the excluded documents the call's target
 * already rests on — a page's existing claims, say — which may be carried
 * through unchanged; a new citation of one is still refused.
 */
export function fenceExcludedDocumentArguments(
  tools: readonly ToolHandle[],
  live: BrainSourceFence,
  alreadyCited: (toolName: string, args: unknown) => ReadonlySet<string> = () => new Set(),
): ToolHandle[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    ...(tool.mutates !== undefined ? { mutates: tool.mutates } : {}),
    ...(tool.summarize ? { summarize: (args: unknown) => tool.summarize!(args) } : {}),
    async invoke(args, context) {
      const fence = live.snapshot();
      if (fence.entries().length > 0) {
        const candidates = candidateDocumentIds(args);
        if (!candidates.complete)
          return {
            kind: "error",
            code: EXCLUDED_SOURCE_ERROR_CODE,
            message:
              "These arguments are too large or too deeply nested to check against the sources excluded from the Brain; split the call.",
          };
        const kept = alreadyCited(tool.name, args);
        const named = [...fence.excludedDocuments(candidates.ids)].filter((id) => !kept.has(id));
        if (named.length > 0)
          return {
            kind: "error",
            code: EXCLUDED_SOURCE_ERROR_CODE,
            message:
              `${named.sort().join(", ")} ${named.length === 1 ? "belongs" : "belong"} to a source the operator ` +
              "excluded from the Brain. Background runs may not read or newly cite its documents: " +
              "remove them from this call and continue with the rest.",
          };
      }
      return tool.invoke(args, context);
    },
  }));
}

/**
 * The source documents a knowledge page already cites, for
 * {@link fenceExcludedDocumentArguments}: saving a page may keep its existing
 * claims on an excluded source, though it cannot add one.
 */
export function existingPageCitations(
  db: Database.Database,
): (toolName: string, args: unknown) => ReadonlySet<string> {
  return (toolName, args) => {
    if (toolName !== "knowledge_save") return new Set();
    const nodeId = (args as { node?: { id?: unknown } } | null)?.node?.id;
    if (typeof nodeId !== "string") return new Set();
    return new Set(
      db
        .prepare<[string], { id: string }>(
          "SELECT DISTINCT target_id AS id FROM knowledge_dependencies WHERE node_id=? AND target_kind='source'",
        )
        .all(nodeId)
        .map((row) => row.id),
    );
  };
}

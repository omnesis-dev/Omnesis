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

import { parseClaimMarkup, type ParsedClaim } from "../knowledge/claims.js";
import {
  getKnowledgeClaims,
  getKnowledgeDependencies,
  getKnowledgeNode,
} from "../knowledge/storage-read.js";
import { applyWikiEdits, type WikiEditOp } from "../knowledge/wiki-edit.js";
import type { DocRef, EventTrail, TemporalQueryResult, TrailEvent } from "@omnesis/core";
import type { EntityContextResult, SqlPort, ToolHandle, ToolPorts } from "@omnesis/agent";
import type { BrainSourceFence } from "../source-exclusion.js";
import type { KnowledgeClaim, KnowledgeClaimState } from "../knowledge/types.js";
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

/** What one call does with the documents its target already cites. */
export interface CallCitations {
  /** Documents the target cites only through claims the call carries through unchanged. */
  kept: ReadonlySet<string>;
  /** Documents cited by claims the call adds or changes, whether or not its arguments name them. */
  added: ReadonlySet<string>;
}

const NO_CITATIONS: CallCitations = { kept: new Set(), added: new Set() };

/**
 * Refuse any call whose arguments name a document of an excluded source,
 * before the tool runs. The refusal names the documents so the run can drop
 * them and carry on with the rest of its work.
 *
 * `citations` says, per call, which excluded documents the call's target
 * already rests on through claims the call leaves unchanged — those may be
 * named — and which ones a new or changed claim would cite, which are refused
 * even when the arguments never name them.
 */
export function fenceExcludedDocumentArguments(
  tools: readonly ToolHandle[],
  live: BrainSourceFence,
  citations: (toolName: string, args: unknown) => CallCitations = () => NO_CITATIONS,
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
        const { kept, added } = citations(tool.name, args);
        const named = [...fence.excludedDocuments([...candidates.ids, ...added])].filter(
          (id) => !kept.has(id),
        );
        if (named.length > 0)
          return {
            kind: "error",
            code: EXCLUDED_SOURCE_ERROR_CODE,
            message:
              `${named.sort().join(", ")} ${named.length === 1 ? "belongs" : "belong"} to a source the operator ` +
              "excluded from the Brain. Background runs may not read or newly cite its documents, and keep " +
              "a claim that already cites one exactly as it is: remove them from this call, leave such " +
              "claims unchanged, and continue with the rest.",
          };
      }
      return tool.invoke(args, context);
    },
  }));
}

/** The claim-state fields a save may set; each changes what the claim asserts. */
const CLAIM_STATE_FIELDS = [
  "supportLogic",
  "attribution",
  "modality",
  "epistemicStatus",
  "validFrom",
  "validUntil",
] as const;

/**
 * Whether a proposed claim is the stored one carried through unchanged: the
 * same text, place and references, and no supplied state that differs, as
 * the save applies it (relations given replace the stored ones whole).
 */
function carriedUnchanged(
  claim: ParsedClaim,
  stored: KnowledgeClaim | undefined,
  state: Partial<KnowledgeClaimState> | undefined,
  relations: ReadonlyMap<string, string>,
): boolean {
  if (!stored || stored.text !== claim.text || stored.parentId !== claim.parentId) return false;
  const refs = claim.refs.map((ref) => ref.raw).sort();
  const storedRefs = [...stored.refs].sort();
  if (refs.length !== storedRefs.length || refs.some((ref, i) => ref !== storedRefs[i]))
    return false;
  if (!state) return true;
  return (
    CLAIM_STATE_FIELDS.every(
      (field) => state[field] === undefined || state[field] === stored[field],
    ) &&
    (state.relations === undefined ||
      refs.every(
        (ref) => (state.relations?.[ref] ?? "supports") === relations.get(`${claim.id}\n${ref}`),
      ))
  );
}

/**
 * The page citations of a `knowledge_save` or `knowledge_edit`, for
 * {@link fenceExcludedDocumentArguments}: the call's resulting page is
 * compared, claim by claim, with the stored revision it names. A claim carried
 * through unchanged may keep citing an excluded document, which the verifier
 * then has no reason to read again; a new or changed claim may not cite one.
 */
export function existingPageCitations(
  db: Database.Database,
): (toolName: string, args: unknown) => CallCitations {
  return (toolName, args) => {
    if (toolName !== "knowledge_save" && toolName !== "knowledge_edit") return NO_CITATIONS;
    const node = (args as { node?: Record<string, unknown> } | null)?.node;
    if (typeof node?.id !== "string") return NO_CITATIONS;
    const stored = getKnowledgeNode(db, node.id);
    // A new page, or a call against another revision, carries nothing through.
    if (!stored || stored.revision !== node.expectedRevision) return NO_CITATIONS;
    let claims: ParsedClaim[];
    try {
      const markdown =
        toolName === "knowledge_save"
          ? node.markdown
          : applyWikiEdits(stored.markdown, node.edits as WikiEditOp[]).markdown;
      // The tool refuses what cannot be parsed or applied; nothing is carried through it.
      if (typeof markdown !== "string") return NO_CITATIONS;
      claims = parseClaimMarkup(markdown).claims;
    } catch {
      return NO_CITATIONS;
    }
    const storedClaims = new Map(
      getKnowledgeClaims(db, stored.id).map((claim) => [claim.id, claim]),
    );
    const dependencies = getKnowledgeDependencies(db, stored.id);
    const relations = new Map(
      dependencies.map((dependency) => [
        `${dependency.claimId}\n${dependency.ref}`,
        dependency.relation,
      ]),
    );
    const states = new Map(
      (Array.isArray(node.claims) ? (node.claims as Partial<KnowledgeClaimState>[]) : []).flatMap(
        (state) => (typeof state?.id === "string" ? [[state.id, state] as const] : []),
      ),
    );
    const added = new Set<string>();
    for (const claim of claims)
      if (!carriedUnchanged(claim, storedClaims.get(claim.id), states.get(claim.id), relations))
        for (const ref of claim.refs) if (ref.kind === "source") added.add(ref.id);
    const kept = new Set(
      dependencies
        .filter(
          (dependency) => dependency.targetKind === "source" && !added.has(dependency.targetId),
        )
        .map((dependency) => dependency.targetId),
    );
    return { kept, added };
  };
}

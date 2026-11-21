// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildBuiltinTools, CitationReads } from "@omnesis/agent";
import { permittedAnalyticsSourceIds } from "../access/permitted-sources.js";
import { resolveSelfMemory } from "../brain/self-memory.js";
import {
  createGatewaySearchPort,
  createGatewayDocumentPort,
  createGatewayDocumentByUrlPort,
  createGatewaySqlPort,
} from "./ports.js";
import type { AnswerScopeReadObserver } from "../privacy/answer-scope.js";
import type { CorpusAuthorization } from "../access/corpus-authorization.js";
import type { AnalyticsDb } from "../analytics-db.js";
import type { Db } from "../data/types.js";
import type { SearchPipeline } from "../search/pipeline.js";
import type { SyncStatusRegistry } from "../sync-status.js";

/** Preserve legacy source-only contexts; filters retain independently safe context. */
export async function resolveExternalAnswerContext(
  db: Db,
  analytics: AnalyticsDb,
  authorization?: CorpusAuthorization,
  scopeReads?: AnswerScopeReadObserver,
) {
  const restricted = authorization?.restricted === true;
  const filtered = (authorization?.scopePolicies.length ?? 0) > 0;
  const permitted = authorization ? permittedAnalyticsSourceIds(db, authorization) : null;
  const fullCatalog = !restricted || filtered ? await analytics.getCatalog() : [];
  const catalog = permitted
    ? fullCatalog.filter((entry) => permitted.has(entry.sourceId))
    : fullCatalog;
  const memory = resolveSelfMemory(
    db,
    !restricted || filtered,
    filtered ? authorization : undefined,
  );
  if (memory.evidenceDocumentIds) scopeReads?.recordDocuments(memory.evidenceDocumentIds);
  return { catalog, ...memory };
}

/** Every external tool is constructed with the same immutable corpus authority. */
export function createExternalAnswerTools(deps: {
  db: Db;
  analyticsDb: AnalyticsDb;
  searchPipeline: SearchPipeline;
  syncStatus?: SyncStatusRegistry;
  authorization: CorpusAuthorization;
  knowledgeReads: boolean;
  allowVerifiedAnswers: boolean;
  scopeReads?: AnswerScopeReadObserver;
}) {
  const {
    db,
    analyticsDb,
    searchPipeline,
    syncStatus,
    authorization,
    knowledgeReads,
    allowVerifiedAnswers,
  } = deps;
  const safeNames = new Set([
    "search_many",
    "fetch_many",
    "lookup_document_by_url",
    "annotate_many",
  ]);
  const filtered = authorization.scopePolicies.length > 0;
  const documentKnowledgeReads = knowledgeReads && !filtered;
  // Every tool an Answer run can call is built below with the run's read
  // observer, so the run's read set is complete once they exist.
  deps.scopeReads?.markComplete();
  if (filtered) safeNames.add("run_sql");
  const search = createGatewaySearchPort(
    searchPipeline,
    syncStatus,
    db,
    authorization,
    documentKnowledgeReads,
  );
  const document = createGatewayDocumentPort(
    db,
    syncStatus,
    { knowledgeReads: documentKnowledgeReads, allowVerifiedAnswers },
    authorization,
  );
  const byUrl = createGatewayDocumentByUrlPort(
    db,
    syncStatus,
    authorization,
    documentKnowledgeReads,
  );
  return buildBuiltinTools({
    citationReads: new CitationReads(),
    experimental: false,
    ports: {
      search: {
        ...search,
        async search(...args) {
          const result = await search.search(...args);
          deps.scopeReads?.recordDocuments(result.results.map((ref) => ref.documentId));
          return result;
        },
      },
      document: {
        ...document,
        async fetch(...args) {
          const result = await document.fetch(...args);
          if (result)
            deps.scopeReads?.recordDocuments([
              result.ref.documentId,
              ...(result.neighbors ?? []).map((ref) => ref.documentId),
            ]);
          return result;
        },
      },
      documentByUrl: {
        ...byUrl,
        async lookup(...args) {
          const result = await byUrl.lookup(...args);
          if (result.ref) deps.scopeReads?.recordDocuments([result.ref.documentId]);
          return result;
        },
      },
      ...(filtered
        ? {
            sql: createGatewaySqlPort(analyticsDb, {
              permittedSourceIds:
                permittedAnalyticsSourceIds(db, authorization) ?? new Set<string>(),
            }),
          }
        : {}),
    },
  }).filter((tool) => safeNames.has(tool.name));
}

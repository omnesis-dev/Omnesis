// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { NotFoundError } from "../../http/errors.js";
import {
  readPendingKnowledgeWork,
  type PendingKnowledgeWorkOptions,
} from "./pending-work-query.js";
import { readKnowledgeSubjectRef } from "./subject-ref.js";
import {
  readKnowledgeBatch,
  readKnowledgeBatches,
  type KnowledgeBatchListOptions,
} from "./batch-query.js";
import {
  listKnowledgeDecisionAudit,
  listKnowledgeDecisionAuditPage,
  type KnowledgeDecisionAuditOptions,
  listKnowledgeDecisionsForBatch,
  listKnowledgeDecisionsForNode,
  readKnowledgeDecisionAudit,
} from "./decision-query.js";
import {
  readKnowledgeLibrary,
  readKnowledgeLibraryRetirement,
  type KnowledgeLibraryOptions,
} from "./library.js";
import { readKnowledgeConnections } from "./connections.js";
import {
  getKnowledgeNode,
  getKnowledgeClaims,
  getKnowledgeDependencies,
  listKnowledgeNodes,
} from "./storage.js";
import { listKnowledgeNodeRevisions } from "./storage-history.js";
import { listKnowledgeFrontier } from "./work.js";
import { listKnowledgeLinks } from "./links.js";
import type Database from "better-sqlite3";

/** Operator diagnostics use canonical fenced reads, never the search projection. */
export class KnowledgeQueryService {
  constructor(private readonly db: Database.Database) {}
  list(options: Parameters<typeof listKnowledgeNodes>[1]) {
    return listKnowledgeNodes(this.db, options).map((node) => ({
      ...node,
      markdown: node.plainText,
    }));
  }
  library(options: KnowledgeLibraryOptions = {}) {
    return readKnowledgeLibrary(this.db, options);
  }
  libraryRetirement(id: string) {
    return readKnowledgeLibraryRetirement(this.db, id);
  }
  fetch(id: string, editing = false) {
    return this.db.transaction(() => {
      const node = getKnowledgeNode(this.db, id);
      if (!node) throw new NotFoundError("Knowledge node not found");
      return {
        ...node,
        subjectRef: readKnowledgeSubjectRef(this.db, id, node.kind),
        markdown: editing ? node.markdown : node.plainText,
        claims: getKnowledgeClaims(this.db, id),
        dependencies: getKnowledgeDependencies(this.db, id),
        links: listKnowledgeLinks(this.db, id),
      };
    })();
  }

  connections(id: string, options: { cursor?: string; limit?: number } = {}) {
    return readKnowledgeConnections(this.db, id, options);
  }
  history(id: string, beforeRevision?: number) {
    this.fetch(id);
    // The portal displays thirty revisions and compares the oldest with this extra predecessor.
    return listKnowledgeNodeRevisions(this.db, id, { beforeRevision, limit: 31 });
  }
  pendingWork(options: PendingKnowledgeWorkOptions) {
    return readPendingKnowledgeWork(this.db, options);
  }
  status() {
    return {
      nodes: this.db
        .prepare(
          "SELECT kind,validity,COUNT(*) AS count FROM knowledge_nodes GROUP BY kind,validity",
        )
        .all(),
      work: this.db
        .prepare(
          "SELECT status,tier,reason,last_error AS readiness,COUNT(*) AS count,MIN(due_at) AS nextDueAt FROM knowledge_work GROUP BY status,tier,reason,last_error",
        )
        .all(),
      coverage: this.db
        .prepare(
          "SELECT phase,policy_version AS policyVersion,status,COUNT(*) AS count FROM knowledge_discovery_coverage GROUP BY phase,policy_version,status",
        )
        .all(),
      cascades: this.db
        .prepare("SELECT COUNT(*) AS pending FROM knowledge_cascade_frontier WHERE done=0")
        .get(),
    };
  }
  nodeDecisions(id: string) {
    return listKnowledgeDecisionsForNode(this.db, id);
  }
  decision(id: string) {
    return readKnowledgeDecisionAudit(this.db, id);
  }
  decisions(limit = 100) {
    return listKnowledgeDecisionAudit(this.db, limit);
  }
  decisionsPage(options: KnowledgeDecisionAuditOptions = {}) {
    return listKnowledgeDecisionAuditPage(this.db, options);
  }
  batches(limit = 30) {
    return readKnowledgeBatches(this.db, { limit }).items;
  }
  batchesPage(options: KnowledgeBatchListOptions = {}) {
    return readKnowledgeBatches(this.db, options);
  }
  batch(id: string) {
    const row = readKnowledgeBatch(this.db, id);
    if (!row) throw new NotFoundError("Knowledge batch not found");
    return {
      ...row,
      frontier: listKnowledgeFrontier(this.db, id),
      decisions: listKnowledgeDecisionsForBatch(this.db, id),
    };
  }
}

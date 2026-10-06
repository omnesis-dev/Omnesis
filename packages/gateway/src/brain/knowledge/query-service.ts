// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { NotFoundError } from "../../http/errors.js";
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
  fetch(id: string, editing = false) {
    const node = getKnowledgeNode(this.db, id);
    if (!node) throw new NotFoundError("Knowledge node not found");
    return {
      ...node,
      markdown: editing ? node.markdown : node.plainText,
      claims: getKnowledgeClaims(this.db, id),
      dependencies: getKnowledgeDependencies(this.db, id),
      links: listKnowledgeLinks(this.db, id),
    };
  }
  history(id: string, beforeRevision?: number) {
    this.fetch(id);
    return listKnowledgeNodeRevisions(this.db, id, { beforeRevision, limit: 30 });
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
  decisions(limit = 100) {
    return this.db
      .prepare(
        "SELECT id,purpose,input_fingerprint AS inputFingerprint,score,model_id AS modelId,latency_ms AS latencyMs,input_tokens AS inputTokens,rubric_version AS rubricVersion,created_at AS createdAt FROM knowledge_decisions ORDER BY created_at DESC,id LIMIT ?",
      )
      .all(limit);
  }
  batches(limit = 30) {
    return this.db
      .prepare(
        "SELECT id,run_id AS runId,tier,status,revision,created_at AS createdAt,updated_at AS updatedAt,finished_at AS finishedAt FROM knowledge_batches ORDER BY created_at DESC,id LIMIT ?",
      )
      .all(limit);
  }
  batch(id: string) {
    const row = this.db
      .prepare("SELECT id,run_id AS runId,tier,status,revision FROM knowledge_batches WHERE id=?")
      .get(id);
    if (!row) throw new NotFoundError("Knowledge batch not found");
    return { ...row, frontier: listKnowledgeFrontier(this.db, id) };
  }
}

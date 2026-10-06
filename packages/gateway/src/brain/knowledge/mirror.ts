// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { OPEN_LOOP_SOURCE_ID, OPEN_LOOP_PROVIDER_ID } from "../open-loop-source/source-meta.js";
import { getKnowledgeNode } from "./storage-read.js";
import {
  KNOWLEDGE_DOCUMENT_TYPE,
  KNOWLEDGE_PROVIDER_ID,
  KNOWLEDGE_SOURCE_ID,
} from "./source-meta.js";
import { listKnowledgeProjectionCleanup } from "./mirror-storage.js";
import type Database from "better-sqlite3";
import type { WriteGate } from "../../write-gate.js";
import type { KnowledgeNode } from "./types.js";

export function buildKnowledgeDocumentInput(node: KnowledgeNode): DocumentInput {
  const content = [
    `# ${node.title}`,
    "",
    `Derived synthesis: ${node.kind}; revision ${node.revision}; ${node.validity}.`,
    "This is maintained context, not independent source evidence.",
    ...(Object.keys(node.canonicalFields).length
      ? [`Canonical state: ${JSON.stringify(node.canonicalFields)}`]
      : []),
    "",
    node.plainText,
  ].join("\n");
  return {
    providerId: ProviderId(KNOWLEDGE_PROVIDER_ID),
    sourceId: SourceId(KNOWLEDGE_SOURCE_ID),
    externalId: node.id,
    title: node.title,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    sourceCreatedAt: new Date(node.createdAt).toISOString(),
    sourceUpdatedAt: new Date(node.updatedAt).toISOString(),
    metadata: {
      documentType: KNOWLEDGE_DOCUMENT_TYPE,
      extra: {
        knowledgeNodeId: node.id,
        knowledgeRevision: node.revision,
        knowledgeKind: node.kind,
        knowledgeValidity: node.validity,
      },
    },
  };
}
export interface KnowledgeMirror {
  refresh(nodeId: string): Promise<void>;
  remove(nodeIds: readonly string[]): Promise<void>;
  drainCleanup(): Promise<boolean>;
}
export function createKnowledgeMirror(deps: {
  db: Database.Database;
  clock: () => number;
  writeGate: Pick<
    WriteGate,
    | "upsertDocuments"
    | "deleteDocuments"
    | "knowledge.queueProjectionCleanup"
    | "knowledge.ackProjectionCleanup"
  >;
  deleteIndexChunks?: (ids: string[]) => Promise<unknown>;
}): KnowledgeMirror {
  return {
    async refresh(nodeId) {
      // A concurrent writer may advance/delete the node during the asynchronous
      // mirror upsert. Recheck it; retrieval fences reject obsolete projections.
      for (let attempt = 0; attempt < 3; attempt++) {
        const node = getKnowledgeNode(deps.db, nodeId);
        if (!node) {
          await this.remove([nodeId]);
          return;
        }
        await deps.writeGate.upsertDocuments([buildKnowledgeDocumentInput(node)]);
        if (getKnowledgeNode(deps.db, nodeId)?.revision === node.revision) return;
      }
      throw new Error("Knowledge projection changed during refresh; retry required");
    },
    async remove(nodeIds) {
      for (let offset = 0; offset < nodeIds.length; offset += 100)
        await deps.writeGate["knowledge.queueProjectionCleanup"](
          nodeIds.slice(offset, offset + 100),
          deps.clock(),
        );
      await this.drainCleanup();
    },
    async drainCleanup() {
      const rows = listKnowledgeProjectionCleanup(deps.db);
      if (!rows.length) return false;
      const nodeIds = [...new Set(rows.map((row) => row.nodeId))];
      for (const [provider, source] of [
        [KNOWLEDGE_PROVIDER_ID, KNOWLEDGE_SOURCE_ID],
        [OPEN_LOOP_PROVIDER_ID, OPEN_LOOP_SOURCE_ID],
      ] as const)
        await deps.writeGate.deleteDocuments(provider, source, nodeIds);
      // A missing index writer must not acknowledge cleanup of an index it cannot reach.
      if (!deps.deleteIndexChunks) return true;
      const documentIds = rows.map((row) => row.documentId);
      await deps.deleteIndexChunks(documentIds);
      await deps.writeGate["knowledge.ackProjectionCleanup"](documentIds);
      return listKnowledgeProjectionCleanup(deps.db, 1).length > 0;
    },
  };
}

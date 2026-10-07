// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  assertKnowledgeReconciliation,
  readKnowledgeCollectionRevision,
  type KnowledgeReconciliationReceipt,
} from "./reconciliation.js";
import { KnowledgeStorageError } from "./types.js";
import type { ToolResult } from "@omnesis/core";
import type Database from "better-sqlite3";

/** A run's temporal read authority, refreshed only by its exact writer receipt. */
export class TemporalReconciliation {
  private receipt: KnowledgeReconciliationReceipt | undefined;
  private readonly annotations = new Map<string, number>();

  async read(db: Database.Database, query: () => Promise<ToolResult>): Promise<ToolResult> {
    const receipt: KnowledgeReconciliationReceipt = {
      collection: "temporal",
      revision: readKnowledgeCollectionRevision(db, "temporal"),
    };
    const result = await query();
    if (result.kind === "structured") {
      assertKnowledgeReconciliation(db, receipt);
      this.receipt = receipt;
      const data = result.data;
      const items = data && typeof data === "object" && "items" in data ? data.items : undefined;
      if (Array.isArray(items))
        for (const item of items)
          if (
            item &&
            typeof item === "object" &&
            item.origin === "annotation" &&
            typeof item.id === "string"
          )
            this.annotations.set(item.id, receipt.revision);
    }
    return result;
  }

  require(annotationId?: string): KnowledgeReconciliationReceipt {
    if (!this.receipt)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Read temporal_query before adding, revising or deleting a temporal annotation.",
      );
    if (annotationId !== undefined && this.annotations.get(annotationId) !== this.receipt.revision)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Read this annotation through temporal_query at the current temporal generation before revising or deleting it.",
      );
    return { ...this.receipt };
  }

  acceptOwnWrite(
    receipts: readonly KnowledgeReconciliationReceipt[] | undefined,
    result?: ToolResult,
  ): void {
    const receipt = receipts?.find((entry) => entry.collection === "temporal");
    if (!receipt) return;
    this.receipt = { ...receipt };
    if (result?.kind !== "structured" || !result.data || typeof result.data !== "object") return;
    const data = result.data as Record<string, unknown>;
    if (result.resultType === "temporal_annotation.added" && typeof data.id === "string")
      this.annotations.set(data.id, receipt.revision);
    if (
      result.resultType === "temporal_annotation.updated" &&
      typeof data.annotationId === "string"
    )
      this.annotations.set(data.annotationId, receipt.revision);
    if (
      result.resultType === "temporal_annotation.deleted" &&
      typeof data.annotationId === "string"
    )
      this.annotations.delete(data.annotationId);
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  canonicalTemporalKind,
  type ToolResult,
  type TemporalQueryInput,
  type TemporalQueryResult,
} from "@omnesis/core";
import {
  assertKnowledgeReconciliation,
  readKnowledgeCollectionRevision,
  type KnowledgeReconciliationReceipt,
} from "./reconciliation.js";
import { captureTemporalDocumentReceipt } from "./temporal-document-epochs.js";
import { KnowledgeStorageError } from "./types.js";

import type { AnnotationScope } from "../../enrichment/temporal/annotation-scope.js";
import type Database from "better-sqlite3";

/** A run's temporal read authority, refreshed only by its exact writer receipt. */
export class TemporalReconciliation {
  private observedScope: AnnotationScope | undefined;
  private receipt: KnowledgeReconciliationReceipt | undefined;
  private readonly annotations = new Map<string, number>();

  async read(
    db: Database.Database,
    args: unknown,
    query: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const input = structuredClone(
      args && typeof args === "object" ? args : {},
    ) as Partial<TemporalQueryInput>;
    const receipt: KnowledgeReconciliationReceipt = db.transaction(() => {
      const temporalDocuments =
        !input.cursor &&
        input.sourceIds === undefined &&
        (!input.origins || (Array.isArray(input.origins) && input.origins.includes("annotation")))
          ? captureTemporalDocumentReceipt(db, input.documentIds)
          : null;
      return {
        collection: "temporal" as const,
        revision: readKnowledgeCollectionRevision(db, "temporal"),
        ...(temporalDocuments ? { temporalDocuments } : {}),
      };
    })();
    const result = await query();
    if (result.kind === "structured") {
      assertKnowledgeReconciliation(db, receipt);
      const dataResult = result.data as TemporalQueryResult;
      this.observedScope =
        dataResult.type === "temporal.results" &&
        !dataResult.truncated &&
        !input.cursor &&
        dataResult.window
          ? {
              ...input,
              fromMs: Date.parse(dataResult.window.start),
              toExclusiveMs: Date.parse(dataResult.window.endExclusive),
              timeZone: dataResult.window.timeZone,
              ...(input.kinds
                ? { kinds: input.kinds.map((k) => canonicalTemporalKind(k)!).filter(Boolean) }
                : {}),
            }
          : undefined;
      // A target observation belongs to this exact complete query, not merely
      // to the collection generation shared by several unrelated reads.
      this.annotations.clear();
      this.receipt = receipt;
      const data = result.data;
      const items = data && typeof data === "object" && "items" in data ? data.items : undefined;
      if (
        this.observedScope &&
        (!this.observedScope.origins || this.observedScope.origins.includes("annotation")) &&
        Array.isArray(items)
      )
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
    if (
      !this.observedScope ||
      !Number.isFinite(this.observedScope.fromMs) ||
      !Number.isFinite(this.observedScope.toExclusiveMs) ||
      (this.observedScope.origins && !this.observedScope.origins.includes("annotation"))
    )
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Read a complete annotation-inclusive temporal_query for the intended time and subject before changing annotations; narrow a truncated query, preferably with documentIds. Only the latest query supplies the active scope, and it must be complete; separate queries are not combined. Read then mutate within that scope, or query one complete window covering the whole batch.",
      );
    return structuredClone(this.receipt);
  }

  scope(): AnnotationScope {
    this.require();
    return structuredClone(this.observedScope!);
  }

  acceptOwnWrite(
    receipts: readonly KnowledgeReconciliationReceipt[] | undefined,
    result?: ToolResult,
  ): void {
    const receipt = receipts?.find((entry) => entry.collection === "temporal");
    if (!receipt) return;
    this.receipt = structuredClone(receipt);
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

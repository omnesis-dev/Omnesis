// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  assertKnowledgeReconciliation,
  knowledgeReconciliationConflict,
  readKnowledgeCollectionRevision,
  type KnowledgeReconciliationReceipt,
} from "./reconciliation.js";
import type { KnowledgeRunFence } from "./run-fence.js";
import type Database from "better-sqlite3";

/** Trusted read receipts belong to one maintenance tool set, never model arguments.
 * These fence observed revisions, not semantic coverage: bounded first-page
 * reads cannot prove that a differently worded duplicate is absent elsewhere. */
export class WikiToolReconciliation {
  private readonly reads = new Map<string, number>();
  private readonly nodeReads = new Map<string, number>();

  constructor(
    private readonly db: Database.Database,
    private readonly run: KnowledgeRunFence,
  ) {}

  read<T>(read: () => T, keys: (result: T) => string[]): T {
    const revision = readKnowledgeCollectionRevision(this.db, "wiki");
    const result = read();
    assertKnowledgeReconciliation(this.db, { collection: "wiki", revision });
    for (const key of keys(result)) this.reads.set(key, revision);
    return result;
  }

  /** Keep the revision actually returned, not a later collection snapshot. */
  readNode<T extends { id: string; kind: string; revision: number } | null>(read: () => T): T {
    const node = read();
    if (node && ["wiki", "root"].includes(node.kind)) this.nodeReads.set(node.id, node.revision);
    return node;
  }

  nodeFence(id: string, expectedRevision: number): KnowledgeRunFence {
    if (this.nodeReads.get(id) !== expectedRevision)
      throw knowledgeReconciliationConflict(
        "wiki",
        "Read the existing target wiki with knowledge_fetch({id:targetId,editing:true}) and use its returned revision as expectedRevision; a guessed revision is not a read receipt.",
      );
    // The writer atomically checks this same expectedRevision and all dependencies.
    // Unrelated page or candidate writes do not invalidate this node read.
    return { ...this.run };
  }

  acceptNode<T extends { node: { id: string; revision: number } }>(result: T): T {
    this.nodeReads.set(result.node.id, result.node.revision);
    return result;
  }

  /** Placement judges observed context; unrelated writes do not invalidate it. */
  placementFence(fence: KnowledgeRunFence): KnowledgeRunFence {
    const revision = this.reads.get("pages");
    if (revision === undefined)
      throw knowledgeReconciliationConflict(
        "wiki",
        'Read knowledge_list({kind:"wiki"}) before assessing placement.',
      );
    return {
      ...fence,
      placementLibrary: { collection: "wiki", revision },
      placementNodeReads: Object.fromEntries(this.nodeReads),
    };
  }

  fence(keys: readonly string[]): KnowledgeRunFence {
    const repair = [
      ...(keys.includes("pages")
        ? ['Read current wiki pages with knowledge_list({kind:"wiki"}) without afterId.']
        : []),
      ...(keys.includes("candidates")
        ? ["Read knowledge_candidates({}) without status or afterId."]
        : []),
      ...(keys.some((key) => key.startsWith("candidate:"))
        ? [
            "Read knowledge_candidates and follow nextCursor until the intended candidate is returned.",
          ]
        : []),
      ...(keys.some((key) => key.startsWith("node:"))
        ? ["Read the existing target wiki with knowledge_fetch({id:targetId,editing:true})."]
        : []),
    ].join(" ");
    const revision = this.reads.get(keys[0]!);
    if (revision === undefined || keys.some((key) => this.reads.get(key) !== revision))
      throw knowledgeReconciliationConflict("wiki", repair);
    const reconciliation: KnowledgeReconciliationReceipt = { collection: "wiki", revision };
    assertKnowledgeReconciliation(this.db, reconciliation, repair);
    return { ...this.run, reconciliation };
  }

  /** Advance only observed generations changed by this exact committed write.
   *  A competing commit after the writer returns must remain detectable. */
  accept<T extends { reconciliationReceipt?: KnowledgeReconciliationReceipt }>(
    result: T,
    fence: KnowledgeRunFence,
    returnedKeys: readonly string[] = [],
  ): Omit<T, "reconciliationReceipt"> {
    const { reconciliationReceipt: receipt, ...visible } = result;
    if (receipt && fence.reconciliation) {
      for (const [key, revision] of this.reads) {
        // A write may invalidate other nodes. Only the returned entity is a
        // fresh entity read; collection reconciliation can retain our own edit.
        if (key === "pages" || key === "candidates") {
          if (revision === fence.reconciliation.revision) this.reads.set(key, receipt.revision);
        } else this.reads.delete(key);
      }
      for (const key of returnedKeys) this.reads.set(key, receipt.revision);
    }
    return visible;
  }
}

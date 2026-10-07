// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  assertKnowledgeReconciliation,
  readKnowledgeCollectionRevision,
  type KnowledgeReconciliationReceipt,
} from "./reconciliation.js";
import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeRunFence } from "./run-fence.js";
import type Database from "better-sqlite3";

/** Trusted read receipts belong to one maintenance tool set, never model arguments.
 * These fence observed revisions, not semantic coverage: bounded first-page
 * reads cannot prove that a differently worded duplicate is absent elsewhere. */
export class WikiToolReconciliation {
  private readonly reads = new Map<string, number>();

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

  fence(keys: readonly string[]): KnowledgeRunFence {
    const revision = this.reads.get(keys[0]!);
    if (revision === undefined || keys.some((key) => this.reads.get(key) !== revision))
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Read current wiki pages with knowledge_list and candidates with knowledge_candidates before proposing or publishing; fetch an existing wiki before revising it.",
      );
    const reconciliation: KnowledgeReconciliationReceipt = { collection: "wiki", revision };
    assertKnowledgeReconciliation(this.db, reconciliation);
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeFrontierView } from "./engine.js";
import type { KnowledgeEditingSnapshot, KnowledgeReceiptProposal } from "./dependency-receipts.js";

/** No offered fingerprint and no frontier-then-editing read to supply one. */
export class FrontierReceiptMissing extends KnowledgeStorageError {
  constructor() {
    super(
      "claim_invalid",
      "Supply inputFingerprint at the top level beside node, or first read this node's current knowledge_next_frontier offer and then knowledge_fetch({id, editing:true}) in this run. Only a complete matching editing read supplies an omitted fingerprint; explicit blank or wrong fingerprints are never repaired.",
    );
  }
}

/** Run-local observations, never reconstructed from the database's current frontier. */
export class FrontierEditingReceipts {
  private readonly offers = new Map<string, string>();
  private readonly reads = new Map<
    string,
    {
      fingerprint: string;
      revision: number;
      kind: string;
      ownerId: string | null;
    }
  >();
  private generation: number | undefined;

  constructor(private readonly privacyGeneration: () => number) {}

  private refreshPrivacy(): void {
    const generation = this.privacyGeneration();
    if (generation !== this.generation) {
      this.offers.clear();
      this.reads.clear();
      this.generation = generation;
    }
  }

  offered(items: KnowledgeFrontierView["items"]): void {
    this.refreshPrivacy();
    for (const item of items) {
      if (item.source || item.id.startsWith("source:")) continue;
      if (this.offers.get(item.id) !== item.inputFingerprint) this.reads.delete(item.id);
      this.offers.delete(item.id);
      this.offers.set(item.id, item.inputFingerprint);
      while (this.offers.size > 64) {
        const oldest = this.offers.keys().next().value!;
        this.offers.delete(oldest);
        this.reads.delete(oldest);
      }
    }
  }

  editing(snapshot: KnowledgeEditingSnapshot, assertCurrent: (fingerprint: string) => void): void {
    this.refreshPrivacy();
    const node = snapshot.node;
    this.reads.delete(node.id);
    const fingerprint = this.offers.get(node.id);
    if (!fingerprint || "contentTruncated" in node || "fetchRequired" in node) return;
    // A stale offer must not prevent an ordinary editing read, but grants no save receipt.
    try {
      assertCurrent(fingerprint);
    } catch (error) {
      if (error instanceof KnowledgeStorageError) return;
      throw error;
    }
    this.reads.set(node.id, {
      fingerprint,
      revision: node.revision,
      kind: node.kind,
      ownerId: node.ownerId,
    });
  }

  resolve(node: KnowledgeReceiptProposal, explicit: string | undefined): string {
    this.refreshPrivacy();
    if (explicit !== undefined) {
      if (explicit.trim()) return explicit;
    } else {
      const read = this.reads.get(node.id);
      if (
        read &&
        read.fingerprint === this.offers.get(node.id) &&
        read.revision === node.expectedRevision &&
        read.kind === node.kind &&
        read.ownerId === (node.ownerId ?? null)
      )
        return read.fingerprint;
    }
    throw new FrontierReceiptMissing();
  }
}

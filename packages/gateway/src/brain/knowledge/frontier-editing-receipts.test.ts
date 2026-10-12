// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, vi } from "vitest";
import { FrontierEditingReceipts } from "./frontier-editing-receipts.js";
import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeEditingSnapshot, KnowledgeReceiptProposal } from "./dependency-receipts.js";

const snapshot: KnowledgeEditingSnapshot = {
  node: {
    id: "atlas",
    kind: "wiki",
    ownerId: null,
    title: "Atlas",
    markdown: "",
    plainText: "",
    revision: 2,
    meaningRevision: 1,
    validity: "current",
    metadata: {},
    canonicalFields: {},
    createdAt: 1,
    updatedAt: 2,
    claims: [],
  },
  dependencies: [],
};
const proposal = {
  id: "atlas",
  kind: "wiki" as const,
  title: "Atlas",
  markdown: "",
  expectedRevision: 2,
};
const offer = {
  id: "atlas",
  inputFingerprint: "exact-offer",
  pendingClaimIds: [],
  inputVersions: {},
  depth: 0,
};

it("requires a returned offer followed by a complete editing read; equivalent offers retain it", () => {
  const receipts = new FrontierEditingReceipts(() => 0);
  receipts.editing(snapshot, () => {});
  receipts.offered([offer]);
  expect(() => receipts.resolve(proposal, undefined)).toThrow("complete matching editing read");
  const check = vi.fn();
  receipts.editing(snapshot, check);
  expect(check).toHaveBeenCalledExactlyOnceWith("exact-offer");
  receipts.offered([offer]);
  expect(receipts.resolve(proposal, undefined)).toBe("exact-offer");
  expect(receipts.resolve(proposal, "explicit-typo")).toBe("explicit-typo");
  for (const blank of ["", " \n"]) expect(() => receipts.resolve(proposal, blank)).toThrow();
});

it.each(["revision", "kind", "owner", "offer", "privacy", "partial", "stale", "retired"])(
  "cannot infer authority after %s changes",
  (change) => {
    let generation = 0;
    const receipts = new FrontierEditingReceipts(() => generation);
    receipts.offered([offer]);
    receipts.editing(snapshot, () => {});
    let next: KnowledgeReceiptProposal = { ...proposal };
    if (change === "revision") next.expectedRevision++;
    if (change === "kind") next = { ...next, kind: "root" };
    if (change === "owner") Object.assign(next, { ownerId: "other" });
    if (change === "offer") receipts.offered([{ ...offer, inputFingerprint: "new" }]);
    if (change === "privacy") generation++;
    if (change === "partial")
      receipts.editing(
        { ...snapshot, node: Object.assign({}, snapshot.node, { contentTruncated: true }) },
        () => {},
      );
    if (change === "stale" || change === "retired")
      receipts.editing(snapshot, () => {
        throw new KnowledgeStorageError("revision_conflict", "No current offered authority");
      });
    expect(() => receipts.resolve(next, undefined)).toThrow();
  },
);

it("evicts bounded observations instead of recovering unseen authority", () => {
  const receipts = new FrontierEditingReceipts(() => 0);
  receipts.offered([offer]);
  receipts.editing(snapshot, () => {});
  receipts.offered(Array.from({ length: 64 }, (_, i) => ({ ...offer, id: `other-${i}` })));
  expect(() => receipts.resolve(proposal, undefined)).toThrow();
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ClaimMarkupError, parseClaimMarkup, type ParsedClaim } from "./claims.js";
import { knowledgeHash } from "./storage-validation.js";
import type { KnowledgeProposal, KnowledgeReferenceView } from "./service.js";
import type {
  KnowledgeClaim,
  KnowledgeDependency,
  KnowledgeNode,
  KnowledgeRevision,
} from "./types.js";

export interface KnowledgeEditingSnapshot {
  node: KnowledgeNode & { claims: KnowledgeClaim[] };
  dependencies: KnowledgeDependency[];
}
export type KnowledgeReceiptProposal = Omit<KnowledgeProposal, "inputVersions"> & {
  inputVersions?: KnowledgeProposal["inputVersions"];
};

/** Finite run-local read state; eviction requires another actual read, never a DB refresh. */
export class KnowledgeDependencyReceipts {
  private readonly snapshots = new Map<
    string,
    { snapshot: KnowledgeEditingSnapshot; bytes: number }
  >();
  private readonly references = new Map<string, KnowledgeRevision>();
  private bytes = 0;

  constructor(
    private readonly limits = { snapshots: 16, snapshotBytes: 2 * 1024 * 1024, references: 1024 },
  ) {}

  rememberEditing(snapshot: KnowledgeEditingSnapshot): void {
    const prior = this.snapshots.get(snapshot.node.id);
    if (prior) {
      this.bytes -= prior.bytes;
      this.snapshots.delete(snapshot.node.id);
    }
    if ("contentTruncated" in snapshot.node || "fetchRequired" in snapshot.node) return;
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (bytes > this.limits.snapshotBytes) return;
    while (
      this.snapshots.size >= this.limits.snapshots ||
      this.bytes + bytes > this.limits.snapshotBytes
    ) {
      const oldest = this.snapshots.entries().next().value;
      if (!oldest) return;
      this.bytes -= oldest[1].bytes;
      this.snapshots.delete(oldest[0]);
    }
    this.snapshots.set(snapshot.node.id, { snapshot: structuredClone(snapshot), bytes });
    this.bytes += bytes;
  }

  rememberReference(view: KnowledgeReferenceView): void {
    this.references.delete(view.ref);
    this.references.set(view.ref, view.revision);
    if (this.references.size > this.limits.references)
      this.references.delete(this.references.keys().next().value!);
  }

  complete(input: KnowledgeReceiptProposal): KnowledgeProposal {
    const versions = { ...input.inputVersions };
    const parsed = parseClaimMarkup(input.markdown);
    const snapshot = this.snapshots.get(input.id)?.snapshot;
    const baseline = snapshot?.node.revision === input.expectedRevision ? snapshot : undefined;
    const dependencies = new Map<string, Map<string, KnowledgeDependency>>();
    for (const dependency of baseline?.dependencies ?? []) {
      const refs = dependencies.get(dependency.claimId) ?? new Map<string, KnowledgeDependency>();
      refs.set(dependency.ref, dependency);
      dependencies.set(dependency.claimId, refs);
    }
    const signatures = baseline
      ? unchangedClaimSignatures(baseline, input, parsed.claims, dependencies)
      : new Set<string>();
    const uses = new Map<string, ParsedClaim[]>();
    for (const claim of parsed.claims)
      for (const ref of claim.refs) {
        const claims = uses.get(ref.raw) ?? [];
        claims.push(claim);
        uses.set(ref.raw, claims);
      }
    for (const [ref, claims] of uses) {
      // Explicit stale overrides remain stale. Never silently substitute newer reads.
      if (Object.hasOwn(versions, ref)) continue;
      const observed = this.references.get(ref);
      if (observed !== undefined) {
        versions[ref] = observed;
        continue;
      }
      if (!baseline || !claims.every((claim) => signatures.has(claim.id))) continue;
      const inherited = claims.map((claim) => dependencies.get(claim.id)?.get(ref)?.inputVersion);
      const version = inherited[0];
      if (version !== undefined && inherited.every((value) => value === version))
        versions[ref] = version;
    }
    return { ...input, inputVersions: versions };
  }
}

/** Compare full tagged trees, including ancestors and every effective semantic state.
 * A matching leaf's text alone cannot grant inheritance after moving it or changing
 * a containing claim. Sibling top-level claims remain independently eligible. */
function unchangedClaimSignatures(
  baseline: KnowledgeEditingSnapshot,
  input: KnowledgeReceiptProposal,
  proposed: ParsedClaim[],
  dependencies: Map<string, Map<string, KnowledgeDependency>>,
): Set<string> {
  let old: ParsedClaim[];
  try {
    old = parseClaimMarkup(baseline.node.markdown).claims;
  } catch (error) {
    if (error instanceof ClaimMarkupError) return new Set();
    throw error;
  }
  const previous = new Map(baseline.node.claims.map((claim) => [claim.id, claim]));
  const supplied = new Map(input.claims?.map((claim) => [claim.id, claim]));
  const signatures = (markdown: string, claims: ParsedClaim[], editing: boolean) => {
    const byId = new Map(claims.map((claim) => [claim.id, claim]));
    const roots = new Map<string, ParsedClaim[]>();
    for (const claim of claims) {
      let root = claim;
      while (root.parentId) root = byId.get(root.parentId)!;
      const members = roots.get(root.id) ?? [];
      members.push(claim);
      roots.set(root.id, members);
    }
    const result = new Map<string, string>();
    for (const [rootId, members] of roots) {
      const root = byId.get(rootId)!;
      const state = members.map((claim) => {
        const prior = previous.get(claim.id);
        const update = editing ? supplied.get(claim.id) : undefined;
        const relations = Object.fromEntries(
          [...(dependencies.get(claim.id)?.values() ?? [])].map((dep) => [dep.ref, dep.relation]),
        );
        return [
          claim.id,
          {
            supportLogic: update?.supportLogic ?? prior?.supportLogic ?? "all",
            modality: update?.modality ?? prior?.modality ?? "observation",
            epistemicStatus: update?.epistemicStatus ?? prior?.epistemicStatus ?? "asserted",
            attribution:
              update?.attribution === undefined ? (prior?.attribution ?? null) : update.attribution,
            validFrom:
              update?.validFrom === undefined ? (prior?.validFrom ?? null) : update.validFrom,
            validUntil:
              update?.validUntil === undefined ? (prior?.validUntil ?? null) : update.validUntil,
            relations: Object.fromEntries(
              claim.refs.map((ref) => [
                ref.raw,
                (update?.relations ?? relations)[ref.raw] ?? "supports",
              ]),
            ),
          },
        ];
      });
      const signature = knowledgeHash([
        rootId,
        markdown.slice(root.sourceSpan.start, root.sourceSpan.end),
        state,
      ]);
      for (const claim of members) result.set(claim.id, signature);
    }
    return result;
  };
  const before = signatures(baseline.node.markdown, old, false);
  const after = signatures(input.markdown, proposed, true);
  return new Set(
    proposed
      .filter((claim) => before.get(claim.id) === after.get(claim.id))
      .map((claim) => claim.id),
  );
}

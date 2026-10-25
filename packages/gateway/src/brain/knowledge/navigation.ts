// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Marked } from "marked";
import { parseClaimMarkup } from "./claims.js";
import { getKnowledgeDependencies, readKnowledgeNodeRow } from "./storage-read.js";
import { isClaimIdentifier } from "./references.js";
import { knowledgeNodeFence } from "./storage-fence.js";
import { KnowledgeStorageError, type SaveKnowledgeNodeInput } from "./types.js";
import type Database from "better-sqlite3";

type NavigationTarget = { id: string; kind: "wiki" | "loop" | "root" | "node" };

/** Match portal navigation, not arbitrary URLs or ordinary relative Markdown links. */
function navigationTarget(href: string): NavigationTarget | null {
  const typed = /^(wiki|loop):([^#]+)(?:#.*)?$/.exec(href);
  if (typed) return { id: typed[2]!, kind: typed[1] as "wiki" | "loop" };
  const bare = /^(wiki|loop|root)_[A-Za-z0-9_-]+(?:#(?:claim|field):[A-Za-z0-9_-]+)?$/.exec(href);
  if (bare) return { id: href.split("#", 1)[0]!, kind: bare[1] as "wiki" | "loop" | "root" };
  const portal = /^\/portal\/debug\/cognition\/knowledge\/([^/?#]+)(?:\?([^#]*))?(?:#.*)?$/.exec(
    href,
  );
  if (!portal) return null;
  const hint = new URLSearchParams(portal[2]).get("kind");
  const kind = hint === "wiki" || hint === "loop" || hint === "root" ? hint : "node";
  try {
    return { id: decodeURIComponent(portal[1]!), kind };
  } catch {
    return { id: "", kind };
  }
}

export function navigationTargets(text: string): Map<string, NavigationTarget> {
  const parser = new Marked();
  const targets = new Map<string, NavigationTarget>();
  parser.walkTokens(parser.lexer(text), (token) => {
    if (token.type !== "link") return;
    const target = navigationTarget(token.href);
    if (target) targets.set(JSON.stringify([target.kind, target.id]), target);
  });
  return targets;
}

type NavigationInput = Pick<
  SaveKnowledgeNodeInput,
  | "id"
  | "kind"
  | "title"
  | "markdown"
  | "claims"
  | "maintenance"
  | "expectedRevision"
  | "navigationRemovals"
>;

/** Removal intent is not a relevance verdict or permission to restore old content. */
function assertRootNavigationRetention(
  db: Database.Database,
  input: NavigationInput,
  nextText: string,
): void {
  const removals = input.navigationRemovals ?? [];
  if (input.kind !== "root") {
    if (removals.length)
      throw new KnowledgeStorageError(
        "claim_invalid",
        "navigationRemovals applies only to existing roots",
      );
    return;
  }
  // Share one read snapshot before paid verification; the writer repeats this
  // within its own transaction after all asynchronous work.
  db.transaction(() => {
    const current = readKnowledgeNodeRow(db, input.id);
    if (
      (current && knowledgeNodeFence(db, input.id).hidden) ||
      db.prepare("SELECT 1 FROM knowledge_node_tombstones WHERE id=?").get(input.id) ||
      (!current && input.expectedRevision > 0)
    )
      throw new KnowledgeStorageError("reference_invalid", "Synthesis page is unavailable");
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Node revision changed; fetch the current page before revising it",
      );
    const previous = new Set(
      [...navigationTargets(current?.plain_text ?? "").values()].map((target) => target.id),
    );
    const retained = new Set([...navigationTargets(nextText).values()].map((target) => target.id));
    const explicit = new Set<string>();
    const invalid = () =>
      new KnowledgeStorageError(
        "claim_invalid",
        "Each navigationRemovals entry must name a distinct prior target omitted from this root and give a nonblank reason of at most 1000 characters; at most 128 entries are allowed. Do not declare retained or unknown targets removed.",
      );
    if (removals.length > 128 || (!current && removals.length)) throw invalid();
    for (const removal of removals) {
      if (
        typeof removal.targetId !== "string" ||
        typeof removal.reason !== "string" ||
        !removal.reason.trim() ||
        removal.reason.length > 1000 ||
        explicit.has(removal.targetId) ||
        !previous.has(removal.targetId) ||
        retained.has(removal.targetId)
      )
        throw invalid();
      const target = readKnowledgeNodeRow(db, removal.targetId);
      if (
        target &&
        !knowledgeNodeFence(db, target.id).hidden &&
        JSON.parse(target.fields_json).withdrawn !== true &&
        target.kind !== "wiki"
      )
        throw invalid();
      explicit.add(removal.targetId);
    }
    const omitted: string[] = [];
    for (const targetId of previous) {
      if (retained.has(targetId) || explicit.has(targetId)) continue;
      const target = readKnowledgeNodeRow(db, targetId);
      // Never enumerate hidden/unavailable targets in diagnostics or force them
      // back into the root. Stale but readable pages can still be navigation.
      if (
        !target ||
        target.kind !== "wiki" ||
        JSON.parse(target.fields_json).withdrawn === true ||
        knowledgeNodeFence(db, targetId).hidden
      )
        continue;
      omitted.push(targetId);
    }
    if (omitted.length)
      throw new KnowledgeStorageError(
        "claim_invalid",
        `This root replacement removes readable wiki navigation without explicit intent: ${JSON.stringify(omitted.slice(0, 128).sort())}. Preserve independently useful links while correcting unsupported factual wording, or add node.navigationRemovals:[{targetId,reason}] for each deliberate removal from this orientation. A link is navigation, not factual support; do not retain an unsupported association merely to preserve a link.`,
      );
  })();
}

/**
 * Model-facing full-page saves validate newly introduced navigation targets.
 * Existing dangling links do not block unrelated repairs. Navigation supplies
 * neither evidence nor mutation authority; selectors are not evidence reads.
 */
export function assertKnowledgeNavigation(
  db: Database.Database,
  input: NavigationInput,
  nextText: string,
): void {
  assertRootNavigationRetention(db, input, nextText);
  if (input.kind !== "wiki" && input.kind !== "root") return;
  const previousNode = readKnowledgeNodeRow(db, input.id);
  const previous = navigationTargets(previousNode?.plain_text ?? "");
  const next = navigationTargets(nextText);
  for (const [key, target] of next) {
    if (previous.has(key)) continue;
    const node = isClaimIdentifier(target.id) ? readKnowledgeNodeRow(db, target.id) : undefined;
    const matchesKind =
      node &&
      (target.kind === "node" ||
        node.kind === target.kind ||
        (target.kind === "wiki" && node.kind === "root"));
    if (
      !node ||
      !matchesKind ||
      knowledgeNodeFence(db, target.id).hidden ||
      JSON.parse(node.fields_json).withdrawn === true
    )
      throw new KnowledgeStorageError(
        "reference_invalid",
        `Internal navigation target is unavailable: ${JSON.stringify(target.id)}. Read the intended page with knowledge_fetch and copy its exact ID and kind; do not guess or substitute a similar ID.`,
      );
  }
  // Selection comes from actual supporting dependencies, not every page in the
  // library. Preserve unrelated legacy proof refreshes; root orientation runs
  // must make their selected detail navigable even when prose is retained.
  if (
    input.kind !== "root" ||
    (!input.maintenance &&
      previousNode?.markdown === input.markdown &&
      previousNode.title === input.title)
  )
    return;
  const priorRelations = new Map(
    getKnowledgeDependencies(db, input.id).map((dependency) => [
      JSON.stringify([dependency.claimId, dependency.ref]),
      dependency.relation,
    ]),
  );
  const states = new Map(input.claims?.map((state) => [state.id, state]));
  const linkedWikiIds = new Set(
    [...next.values()]
      .filter((target) => target.kind === "wiki" || target.kind === "node")
      .map((target) => target.id),
  );
  const required = new Set<string>();
  for (const claim of parseClaimMarkup(input.markdown).claims) {
    const proposed = states.get(claim.id)?.relations;
    for (const ref of claim.refs) {
      const relation = proposed
        ? (proposed[ref.raw] ?? "supports")
        : (priorRelations.get(JSON.stringify([claim.id, ref.raw])) ?? "supports");
      if (ref.kind === "wiki" && relation === "supports") required.add(ref.id);
    }
  }
  for (const id of required)
    if (!linkedWikiIds.has(id))
      throw new KnowledgeStorageError(
        "claim_invalid",
        `Root orientation uses wiki:${id} as supporting detail but has no navigation to it. Add a meaningful inline [Page title](wiki:${id}) link to the supported summary. A claim reference is evidence, not a clickable navigation link; do not add unrelated pages or invent stronger claims.`,
      );
}

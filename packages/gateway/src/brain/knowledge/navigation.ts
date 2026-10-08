// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Marked } from "marked";
import { isClaimIdentifier } from "./references.js";
import { readKnowledgeNodeRow } from "./storage-read.js";
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

function navigationTargets(text: string): Map<string, NavigationTarget> {
  const parser = new Marked();
  const targets = new Map<string, NavigationTarget>();
  parser.walkTokens(parser.lexer(text), (token) => {
    if (token.type !== "link") return;
    const target = navigationTarget(token.href);
    if (target) targets.set(JSON.stringify([target.kind, target.id]), target);
  });
  return targets;
}

/**
 * Model-facing full-page saves validate newly introduced navigation targets.
 * Existing dangling links do not block unrelated repairs. Navigation supplies
 * neither evidence nor mutation authority; selectors are not evidence reads.
 */
export function assertKnowledgeNavigation(
  db: Database.Database,
  input: Pick<SaveKnowledgeNodeInput, "id" | "kind">,
  nextText: string,
): void {
  if (input.kind !== "wiki" && input.kind !== "root") return;
  const previous = navigationTargets(readKnowledgeNodeRow(db, input.id)?.plain_text ?? "");
  for (const [key, target] of navigationTargets(nextText)) {
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
}

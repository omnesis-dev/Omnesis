// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SOURCE_HOSTING_DEVICE_KINDS, type SourceScopeUpdates } from "@omnesis/types";

import { getWipeEpoch } from "../data/repositories/SyncStateRepository.js";
import {
  drainScopeFactRebuilds,
  hasScopeFactRebuilds,
  captureScopeFactRebuildTargets,
  type ScopeFactRebuildTarget,
} from "./scope-fact-rebuilds.js";
import { applySourceScopeUpdates } from "./scope-updates.js";
import { requireScopeRefreshForHost } from "./scope-refresh-requirements.js";
import {
  drainConversationScopeRebuilds,
  hasConversationScopeRebuilds,
  type ConversationScopeContext,
} from "./scope-conversations.js";
import type { Db } from "../data/types.js";

export interface ScopePageContext extends ConversationScopeContext {
  cursorDeviceId?: string;
  /** Captured admission policy, never supplied by a collector payload. */
  requiredHostingAuthority?: boolean;
}

/** Recheck durable authority on every writer continuation, including legacy pages. */
export function scopePageAuthorityRejected(db: Db, context: ScopePageContext): boolean {
  const epoch = getWipeEpoch(db, context.sourceId, context.cursorDeviceId ?? "");
  if ((context.writeEpoch !== undefined || epoch > 0) && context.writeEpoch !== epoch) return true;
  if (!context.authorityId) return false;
  if (context.requiredHostingAuthority === false)
    return !db
      .prepare("SELECT 1 FROM devices WHERE id=? AND revoked_at IS NULL")
      .get(context.authorityId);
  return !db
    .prepare(
      `SELECT 1 FROM devices d WHERE d.id = ? AND d.revoked_at IS NULL AND (
         d.kind NOT IN (SELECT value FROM json_each(?))
         OR NOT EXISTS (SELECT 1 FROM sources WHERE id=?)
         OR EXISTS (SELECT 1 FROM sources s WHERE s.id=? AND (s.device_id=d.id
           OR EXISTS (SELECT 1 FROM source_devices m WHERE m.source_id=s.id AND m.device_id=d.id))))`,
    )
    .get(
      context.authorityId,
      JSON.stringify(SOURCE_HOSTING_DEVICE_KINDS),
      context.sourceId,
      context.sourceId,
    );
}

/** Privacy revocations precede partial publication; permission to reopen stays final. */
export function beginScopePageWork(
  db: Db,
  context: ScopePageContext,
  updates: SourceScopeUpdates | undefined,
): void {
  if (context.authorityId) requireScopeRefreshForHost(db, context.authorityId, context.sourceId);
  const refreshes = updates?.refreshes?.filter((item) => item.active);
  const readiness = updates?.readiness?.filter((item) => !item.complete);
  const hierarchy =
    updates?.hierarchy?.snapshot?.phase === "begin"
      ? {
          kind: updates.hierarchy.kind,
          snapshot: updates.hierarchy.snapshot,
          refreshEpoch: updates.hierarchy.refreshEpoch,
        }
      : undefined;
  if (!refreshes?.length && !readiness?.length && !hierarchy) return;
  db.transaction(() => {
    if (scopePageAuthorityRejected(db, context)) return;
    applySourceScopeUpdates(db, context, { refreshes, readiness, hierarchy });
  })();
}

/** Each metadata item and each bounded roster drain owns a physical transaction. */
export function advanceScopePageWork(
  db: Db,
  context: ScopePageContext,
  updates: SourceScopeUpdates | undefined,
  token: { requested(): boolean },
):
  | { kind: "done"; updates: SourceScopeUpdates | undefined; factTargets: ScopeFactRebuildTarget[] }
  | {
      kind: "yield";
      updates: SourceScopeUpdates | undefined;
      factTargets: ScopeFactRebuildTarget[];
    }
  | { kind: "rejected" } {
  const factTargets: ScopeFactRebuildTarget[] = [];
  let documents = updates?.documents ?? [];
  let conversations = updates?.conversations ?? [];
  let nodes = updates?.hierarchy?.nodes ?? [];
  let edges = updates?.hierarchy?.documents ?? [];
  let replaceKinds = updates?.replaceEntityKinds ?? [];
  let entities = updates?.entities ?? [];
  const remaining = (): SourceScopeUpdates | undefined =>
    updates === undefined
      ? undefined
      : {
          ...updates,
          documents: documents.length ? documents : undefined,
          conversations: conversations.length ? conversations : undefined,
          replaceEntityKinds: replaceKinds.length ? replaceKinds : undefined,
          entities: entities.length ? entities : undefined,
          hierarchy: updates.hierarchy
            ? {
                ...updates.hierarchy,
                nodes: nodes.length ? nodes : undefined,
                documents: edges.length ? edges : undefined,
              }
            : undefined,
        };
  while (
    documents.length ||
    conversations.length ||
    nodes.length ||
    edges.length ||
    replaceKinds.length ||
    entities.length ||
    hasConversationScopeRebuilds(db, context)
  ) {
    const accepted = db.transaction(() => {
      if (scopePageAuthorityRejected(db, context)) return false;
      if (documents.length) {
        applySourceScopeUpdates(db, context, { documents: documents.slice(0, 1) });
        factTargets.push(
          ...captureScopeFactRebuildTargets(db, context, [documents[0]!.externalId]),
        );
        documents = documents.slice(1);
      } else if (conversations.length) {
        applySourceScopeUpdates(db, context, { conversations: conversations.slice(0, 1) });
        conversations = conversations.slice(1);
      } else if (nodes.length) {
        applySourceScopeUpdates(db, context, {
          hierarchy: {
            kind: "folder",
            refreshEpoch: updates?.hierarchy?.refreshEpoch,
            nodes: nodes.slice(0, 1),
          },
        });
        nodes = nodes.slice(1);
      } else if (edges.length) {
        applySourceScopeUpdates(db, context, {
          hierarchy: {
            kind: "folder",
            refreshEpoch: updates?.hierarchy?.refreshEpoch,
            documents: edges.slice(0, 1),
          },
        });
        factTargets.push(...captureScopeFactRebuildTargets(db, context, [edges[0]!.externalId]));
        edges = edges.slice(1);
      } else if (replaceKinds.length) {
        const kind = replaceKinds[0]!;
        const rows = db
          .prepare<[string, string], { entity_id: string }>(
            "SELECT entity_id FROM scope_entities WHERE source_id=? AND kind=? ORDER BY entity_id LIMIT 128",
          )
          .all(context.sourceId, kind);
        db.prepare(
          "DELETE FROM scope_entities WHERE source_id=? AND kind=? AND entity_id IN (SELECT value FROM json_each(?))",
        ).run(context.sourceId, kind, JSON.stringify(rows.map((row) => row.entity_id)));
        if (rows.length < 128) replaceKinds = replaceKinds.slice(1);
      } else if (entities.length) {
        applySourceScopeUpdates(db, context, { entities: entities.slice(0, 128) });
        entities = entities.slice(128);
      } else {
        const drain = drainConversationScopeRebuilds(db, context, 128);
        if (drain.pending && drain.processed === 0)
          throw new Error("Native scope rebuild did not advance.");
      }
      return true;
    })();
    if (!accepted) return { kind: "rejected" };
    if (token.requested()) return { kind: "yield", updates: remaining(), factTargets };
  }
  return { kind: "done", updates: remaining(), factTargets };
}

/** Drain only captured page revisions; newer sibling work cannot delay this cursor. */
export function advanceScopeFactPageWork(
  db: Db,
  context: ScopePageContext,
  targets: readonly ScopeFactRebuildTarget[],
  token: { requested(): boolean },
): "done" | "yield" | "rejected" {
  while (hasScopeFactRebuilds(db, context.sourceId, targets)) {
    const accepted = db.transaction(() => {
      if (scopePageAuthorityRejected(db, context)) return false;
      const drain = drainScopeFactRebuilds(db, context.sourceId, 128, targets);
      if (drain.pending && drain.processed === 0)
        throw new Error("Document scope rebuild did not advance.");
      return true;
    })();
    if (!accepted) return "rejected";
    if (token.requested()) return "yield";
  }
  return "done";
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { experimentalEnabled } from "@omnesis/core";
import { sourceFilterOwnersRevision, sourceFiltersInUse } from "./source-filters-in-use.js";
import { seedPackagedSourceScopes } from "./packaged-source-scopes.js";
import { initializeScopeGenerationEpoch } from "./scope-generations.js";
import {
  requireScopeRefreshForStoredHosts,
  restartEveryNativeScopeRefresh,
} from "./scope-refresh-requirements.js";
import {
  createScopeFactsDocumentTriggers,
  dropScopeFactTriggers,
  scopeFactTriggersInstalled,
} from "./scope-schema.js";
import type { Db } from "../data/types.js";

/**
 * Source filters are either active on a corpus or not, and the fact triggers
 * are the mark of it. Active: the triggers on documents, sources and the fact
 * tables exist, ingest projects each document's facts, and the backfill and
 * the index mirror run. Inactive: none of the triggers exist, the fact tables
 * are empty, and a document write touches nothing that belongs to filters.
 *
 * Going inactive empties the fact state rather than letting it age, so
 * becoming active again is the first activation over again: every source is
 * prepared from its first document and is unavailable to a filter until that
 * ends. Saved filters, source declarations and Answer source proofs are
 * configuration and history, not fact state, and are kept.
 */

/** Everything derived from documents and from what collectors report about them. */
const FACT_STATE_TABLES = [
  "document_scope_completeness",
  "document_scope_conversations",
  "document_scope_facts",
  "document_scope_subjects",
  "scope_conversation_identifier_counts",
  "scope_conversation_members",
  "scope_conversation_rebuilds",
  "scope_conversations",
  "scope_document_hierarchy",
  "scope_entities",
  "scope_fact_backfill",
  "scope_fact_rebuilds",
  "scope_hierarchy_catalogues",
  "scope_hierarchy_dependencies",
  "scope_hierarchy_dirty",
  "scope_hierarchy_nodes",
  "scope_native_desired_witnesses",
  "scope_native_kinds",
  "scope_native_publication_context",
  "scope_native_refresh_witnesses",
  "scope_native_reprojection",
  "scope_native_reprojection_sources",
  "scope_replay_dirty",
  "scope_source_generations",
  "source_scope_host_support",
] as const;

function activate(db: Db): void {
  createScopeFactsDocumentTriggers(db);
  // Refresh requirements outlive an inactive spell without their source's
  // cleanup trigger; the ones of sources removed meanwhile go now.
  for (const table of [
    "source_scope_refresh_requirements",
    "source_scope_refreshes",
    "source_scope_kind_readiness",
  ])
    db.exec(`DELETE FROM ${table} WHERE source_id NOT IN (SELECT id FROM sources)`);
  // A new epoch makes the index discard whatever it mirrored before.
  initializeScopeGenerationEpoch(db);
}

function deactivate(db: Db): void {
  // What collectors reported is about to be forgotten, and their own
  // bookmarks say it was delivered: each such kind is left needing a new
  // refresh, which is what makes them report it again once filters return.
  restartEveryNativeScopeRefresh(db);
  dropScopeFactTriggers(db);
  // With no trigger left on them the tables are emptied without a row visit.
  for (const table of FACT_STATE_TABLES) db.exec(`DELETE FROM ${table}`);
  db.exec(`UPDATE scope_backfill_cursor SET last_source_id = '';
    UPDATE scope_subject_retries SET cursor_rowid = 0;
    UPDATE scope_native_reprojection_cursor SET document_id = '';
    UPDATE scope_fact_rebuild_cursor SET document_id = '';
    UPDATE scope_hierarchy_work_cursor SET source_id = '', entity_id = '', catalogue_source_id = '';`);
}

/**
 * Make the corpus match whether source filters are in use, and answer whether
 * they are. A corpus that already matches is left untouched, so this costs one
 * read of the schema on an install without filters.
 */
function reconcile(db: Db): boolean {
  const inUse = sourceFiltersInUse(db);
  if (inUse !== scopeFactTriggersInstalled(db)) db.transaction(inUse ? activate : deactivate)(db);
  return inUse;
}

/**
 * Bring a corpus in line with whether source filters are in use, after its
 * schema is in place. Safe on any connection that may write, at any time.
 */
export function reconcileScopeFactState(db: Db): void {
  reconcile(db);
}

const remembered = new WeakMap<
  Db,
  { experimental: boolean; ownersRevision: number; active: boolean }
>();

/**
 * Whether source filters are active on the writer's corpus, for the paths
 * that run on every write. The answer is remembered per connection and read
 * again only when experimental mode differs or a write may have changed which
 * live levels hold a filter; reading it again also activates or deactivates
 * the corpus to match. Only a connection that writes may ask.
 *
 * An answer formed inside a transaction is not remembered: if that
 * transaction rolls back, so does whatever the reconcile did.
 */
export function sourceFiltersActive(db: Db): boolean {
  const experimental = experimentalEnabled();
  const ownersRevision = sourceFilterOwnersRevision();
  const known = remembered.get(db);
  if (known && known.experimental === experimental && known.ownersRevision === ownersRevision)
    return known.active;
  const active = reconcile(db);
  if (db.inTransaction) remembered.delete(db);
  else remembered.set(db, { experimental, ownersRevision, active });
  return active;
}

/**
 * The gateway start: reconcile the corpus, and while filters are in use make
 * sure the packaged declarations are present, hosts that cannot report facts
 * are fenced, and the generation epoch is new for this boot. An install
 * without filters is not written to.
 */
export function reconcileSourceFilterActivation(db: Db): void {
  if (!reconcile(db)) return;
  seedPackagedSourceScopes(db);
  requireScopeRefreshForStoredHosts(db);
  initializeScopeGenerationEpoch(db);
}

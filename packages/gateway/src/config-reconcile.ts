// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { resolveSourceSettings, sourceSettingKeys, type OmnesisConfig } from "@omnesis/config";
import { listSources } from "./data/repositories/SourceRepository.js";
import { getSourceMemberConfigContract } from "./data/repositories/SourceMemberConfigContractRepository.js";
import { splitMemberScopedParams } from "./multi-device-mode.js";
import type { SourceId } from "@omnesis/types";
import type { WriteGate } from "./write-gate.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("gateway:config-reconcile");

export interface ReconcileReport {
  /** Number of DB source rows whose `config` JSON was rewritten. */
  sourcesUpdated: number;
  /** IDs whose effective configs must be refreshed on connected members. */
  updatedSourceIds: SourceId[];
  /** Source-id blocks in the file that address no live DB source. */
  orphanedSourceBlocks: string[];
}

/**
 * Project the file's authoritative per-source settings onto the DB's
 * `sources.config` column so runtime code can keep reading from the DB row.
 * For each DB source:
 *
 *   • compose `sources.default` + `sources.<id>` (override-wins-per-field)
 *   • remove params pinned by that source's member-local contract
 *   • write the composed object to the source row's `config` column
 *
 * Blocks in the file without a matching DB row are kept as-is in the file
 * (the user may have added them preemptively, or a source was removed); we
 * just log them.
 */
export async function reconcileConfig(
  db: Db,
  w: WriteGate,
  config: OmnesisConfig,
): Promise<ReconcileReport> {
  // Orphaned-block detection — purely informational. A block is orphaned only
  // when no live source is addressed by its key: a descriptor-id block reaches
  // every account under that type, so it is in effect even though no row
  // carries that id verbatim.
  const sources = listSources(db);
  const addressedKeys = new Set<string>();
  for (const s of sources) {
    for (const key of sourceSettingKeys(s.id as string)) addressedKeys.add(key);
  }
  const orphanedSourceBlocks: string[] = [];
  for (const key of Object.keys(config.sources ?? {})) {
    if (key === "default") continue;
    if (!addressedKeys.has(key)) orphanedSourceBlocks.push(key);
  }
  for (const id of orphanedSourceBlocks) {
    log.info(`sources.${id}: no live source is addressed by this key — settings held in reserve`);
  }

  // Project each DB row's config to match the file. Only fields declared in
  // the sources-settings schema are written; the rest of the column is left
  // alone (today there's nothing else on it, but future-us may add fields
  // that don't belong in the user-facing file).
  let sourcesUpdated = 0;
  const updatedSourceIds: SourceId[] = [];
  for (const source of sources) {
    const resolved = resolveSourceSettings(config, source.id as string) as Record<string, unknown>;
    const memberContract = getSourceMemberConfigContract(db, source.id);
    if (memberContract) {
      const localNames = Object.keys(
        splitMemberScopedParams(resolved, memberContract).memberParams,
      );
      if (localNames.length) {
        log.warn(
          `sources.${source.id}: member-local params (${localNames.join(", ")}) cannot be assigned from the shared config file; update the specific source member instead`,
        );
      }
    }
    const settings = memberContract
      ? splitMemberScopedParams(resolved, memberContract).sharedConfig
      : resolved;
    const current = source.config ?? {};
    const next = { ...current, ...settings };
    // Drop fields that used to be in `settings` but are now unset — otherwise
    // removing `extractAttachments` from the file wouldn't propagate.
    for (const key of Object.keys(current)) {
      if (key in settings) continue;
      // Only prune keys that the schema owns; leave unknown legacy keys alone.
      if (SCHEMA_OWNED_KEYS.has(key)) delete (next as Record<string, unknown>)[key];
    }
    if (!shallowEqual(current, next)) {
      const updated = await w.updateSource(source.id, { config: next });
      if (updated) {
        sourcesUpdated++;
        updatedSourceIds.push(source.id);
      }
    }
  }

  return { sourcesUpdated, updatedSourceIds, orphanedSourceBlocks };
}

/**
 * Fields the new schema "owns" on the per-source settings block. A row's DB
 * config column may carry additional keys written by legacy code paths —
 * those pass through reconciliation untouched until a follow-up cleanup.
 */
const SCHEMA_OWNED_KEYS: ReadonlySet<string> = new Set([
  "params",
  "syncInterval",
  "extractAttachments",
  "attachmentMaxSizeBytes",
  "attachmentTypes",
  "attachmentMaxTextLength",
]);

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

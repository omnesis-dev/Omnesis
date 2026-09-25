// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * File-backed per-capability model history for the "Recently used" picker
 * section.
 *
 * The live assignments in `omnesis.json` only say what each capability uses
 * *now*; the picker also wants what it used *before* (so switching back is
 * one tap). This store keeps that memory: role → up to two recent assignment
 * values, most-recent-first, persisted as `<configDir>/model-history.json`
 * next to the config so it survives gateway restarts and upgrades.
 *
 * Recording hooks into `configStore.onChange` (see `index.ts`), which sees
 * every path that changes an assignment — `PATCH /admin/config`, `POST
 * /admin/models/activate`, and hand edits — so no mutation site needs its
 * own bookkeeping. The store only ever writes its sidecar file, never the
 * config, so the hook cannot loop back into itself.
 *
 * One blind spot by design: edits made while the gateway is stopped are
 * invisible (there is no transition to observe). The picker still shows the
 * live assignments — only the "previously used" memory for an offline change
 * is lost, until the next live transition records it.
 *
 * Reads are crash-safe like the model manifest: a missing or malformed file
 * yields empty history (a fresh upgrade starts with no history, and the
 * picker still shows the currently assigned sibling models).
 */

import { existsSync, readFileSync } from "node:fs";
import {
  atomicWriteFileSync,
  createLogger,
  recordRecentHistory,
  CAPABILITY_ROLES,
  type CapabilityRole,
  type RecentModelHistory,
} from "@omnesis/core";
import type { OmnesisConfig } from "@omnesis/config";

const log = createLogger("gateway:model-history");

interface ModelHistoryFile {
  version: 1;
  roles: Partial<Record<string, string[]>>;
}

export class ModelHistoryStore {
  private readonly filePath: string;
  private history: RecentModelHistory = {};

  constructor(opts: { filePath: string }) {
    this.filePath = opts.filePath;
  }

  /** Read the sidecar file into memory. Never throws — corruption → empty. */
  load(): void {
    this.history = readHistoryFile(this.filePath);
  }

  /** Current in-memory history (a deep copy — callers must not mutate store state). */
  snapshot(): RecentModelHistory {
    return Object.fromEntries(
      Object.entries(this.history).map(([role, values]) => [role, [...values]]),
    );
  }

  /**
   * Fold one assignment change into history and persist. Returns true when
   * the stored history changed.
   */
  record(
    role: CapabilityRole,
    before: string | null | undefined,
    after: string | null | undefined,
  ): boolean {
    const next = recordRecentHistory(this.history, role, before, after);
    if (next === this.history) return false;
    this.history = next;
    this.persist();
    return true;
  }

  /**
   * Diff two config snapshots and record every assignment change. The
   * `configStore.onChange` hook calls this with (before, after).
   */
  recordChanges(before: OmnesisConfig, after: OmnesisConfig): void {
    let changed = false;
    for (const role of CAPABILITY_ROLES) {
      const beforeValue = before.inference?.assignments?.[role] ?? undefined;
      const afterValue = after.inference?.assignments?.[role] ?? undefined;
      if (beforeValue === afterValue) continue;
      const next = recordRecentHistory(this.history, role, beforeValue, afterValue);
      if (next !== this.history) {
        this.history = next;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    const file: ModelHistoryFile = { version: 1, roles: this.history };
    try {
      atomicWriteFileSync(this.filePath, JSON.stringify(file, null, 2), { ensureDir: true });
    } catch (err) {
      log.warn(
        `Failed to persist model history to ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function readHistoryFile(path: string): RecentModelHistory {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    log.warn(
      `Model history at ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); starting empty`,
    );
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  if ((parsed as { version?: unknown }).version !== 1) return {};
  const roles = (parsed as { roles?: unknown }).roles;
  if (typeof roles !== "object" || roles === null) return {};
  const out: RecentModelHistory = {};
  for (const [role, values] of Object.entries(roles)) {
    if (!(CAPABILITY_ROLES as readonly string[]).includes(role)) continue;
    if (!Array.isArray(values)) continue;
    const clean = values.filter((v): v is string => typeof v === "string" && v.length > 0);
    if (clean.length === 0) continue;
    out[role as CapabilityRole] = clean.slice(0, 2);
  }
  return out;
}

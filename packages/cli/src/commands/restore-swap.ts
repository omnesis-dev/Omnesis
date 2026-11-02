// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The last step of `omnesis restore`: move a fully inflated stage into a
 * config dir, entry by entry, inside that directory alone.
 *
 * The config dir itself is never renamed and nothing is written beside it. A
 * Docker install bind-mounts it into the container the restore runs in, where
 * the mount point cannot be renamed and the directory above it is not the
 * restore's to write; and the directory holds what the machine owns, which a
 * restore carries across rather than rebuilds. So every entry the restore
 * touches — each one it places and each backup-owned one it removes — is first
 * moved aside into a directory inside the target, on the same filesystem, and
 * only then is the staged entry renamed into place. A failure at any step
 * moves everything back, so the target is either the old one or the new one.
 */

import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type RenameFn = (from: string, to: string) => void;

/** A failed swap that could not put everything back: its work dir holds the rest. */
export class SwapRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapRollbackError";
  }
}

export interface SwapPlan {
  target: string;
  /** Scratch directory inside `target` the swap may use; removed afterwards. */
  workDir: string;
  /** Entries to put in place: their path relative to `target`, and where each is staged now. */
  place: Array<{ rel: string; from: string }>;
  /** Entries of `target` to remove, relative to it. */
  remove: string[];
  /**
   * The last step that can fail, run once every entry is in place: a failure
   * here rolls the swap back too.
   */
  commit?: () => Promise<void>;
  rename?: RenameFn;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Create the missing ancestors of `path` up to `root`, returning the ones created, outermost first. */
function ensureParents(root: string, path: string): string[] {
  const missing: string[] = [];
  for (let dir = dirname(path); dir !== root && !existsSync(dir); dir = dirname(dir)) {
    missing.unshift(dir);
  }
  for (const dir of missing) mkdirSync(dir, { mode: 0o700 });
  return missing;
}

export async function swapIntoPlace(plan: SwapPlan): Promise<void> {
  const rename = plan.rename ?? renameSync;
  const aside = join(plan.workDir, "superseded");
  mkdirSync(aside, { recursive: true, mode: 0o700 });

  const movedAside: Array<{ from: string; to: string }> = [];
  const placed: Array<{ from: string; to: string }> = [];
  const createdDirs: string[] = [];

  const rollBack = (cause: unknown): never => {
    const stuck: string[] = [];
    for (const step of placed.reverse()) {
      try {
        rename(step.to, step.from);
      } catch {
        stuck.push(step.to);
      }
    }
    for (const dir of createdDirs.reverse()) {
      try {
        rmdirSync(dir);
      } catch {
        // Not empty (something stuck above) or already gone.
      }
    }
    for (const step of movedAside.reverse()) {
      try {
        rename(step.to, step.from);
      } catch {
        stuck.push(step.from);
      }
    }
    if (stuck.length > 0) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SwapRollbackError(
        `The restore failed (${message}) and could not put back every entry it had moved: ` +
          `${stuck.join(", ")}. The previous files are in ${aside}; move them back by hand.`,
      );
    }
    throw cause;
  };

  try {
    const touched = [...plan.place.map((entry) => entry.rel), ...plan.remove];
    for (const rel of touched) {
      const current = join(plan.target, rel);
      if (!exists(current)) continue;
      const to = join(aside, rel);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      rename(current, to);
      movedAside.push({ from: current, to });
    }
    for (const entry of plan.place) {
      const to = join(plan.target, entry.rel);
      createdDirs.push(...ensureParents(plan.target, to));
      rename(entry.from, to);
      placed.push({ from: entry.from, to });
    }
    await plan.commit?.();
  } catch (err) {
    rollBack(err);
  }
  // Done: what was moved aside is the superseded epoch, and goes.
  rmSync(plan.workDir, { recursive: true, force: true });
}

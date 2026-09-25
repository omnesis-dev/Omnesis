// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What this source persists between runs, and how an older version of it is
 * carried forward.
 *
 * Obsidian tracked its own cursor version before the host offered one: a
 * `version: 2` stamp inside the cursor, and a branch at the top of `sync`
 * that recognised anything else as the path-keyed first shape. That worked,
 * and it put a migration in the hot path — a comparison re-made on every page
 * of every cycle for the lifetime of the install, to answer a question that is
 * settled once.
 *
 * Declaring it here moves the question to where it is asked once. The host
 * resolves the stored value before `sync` is called, so the source only ever
 * receives the current shape, and the one-time re-key happens in a step that
 * names itself.
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { ObsidianFileState, ObsidianSyncCursor } from "./types.js";

/** The shape stored today: notes keyed by stable identity rather than by path. */
export const OBSIDIAN_STATE_VERSION = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileState(value: unknown): value is ObsidianFileState {
  if (!isRecord(value)) return false;
  return (
    typeof value.mtime === "number" &&
    typeof value.contentHash === "string" &&
    typeof value.size === "number" &&
    typeof value.inode === "number" &&
    typeof value.stableId === "string" &&
    (value.renderVersion === undefined || typeof value.renderVersion === "number")
  );
}

function isFileMap(value: unknown): value is Record<string, ObsidianFileState> {
  return isRecord(value) && Object.values(value).every(isFileState);
}

export const obsidianStateSpec: SourceStateSpec<ObsidianSyncCursor> = {
  version: OBSIDIAN_STATE_VERSION,

  /**
   * Accepts every cursor a cycle can produce, not only a settled one.
   *
   * The host stores a returned value unwrapped when this rejects it, which
   * would leave a mid-cycle cursor classified as legacy and re-migrated on the
   * next page — re-queueing the whole re-key each time. The two optional
   * fields below are exactly the ones a partial page carries, so they are
   * spelled out rather than left to a "settled shape" check.
   */
  decode(value: unknown): ObsidianSyncCursor | null {
    if (!isRecord(value)) return null;
    if (value.version !== OBSIDIAN_STATE_VERSION) return null;
    if (!isFileMap(value.fileMap)) return null;
    if (value.cycleQueueTotal !== undefined && typeof value.cycleQueueTotal !== "number") {
      return null;
    }
    const pending = value.pendingMigrationDeletes;
    if (
      pending !== undefined &&
      !(Array.isArray(pending) && pending.every((id) => typeof id === "string"))
    ) {
      return null;
    }
    return value as unknown as ObsidianSyncCursor;
  },

  /**
   * A value written before envelopes existed carried the source's own stamp.
   * `version: 2` is the current shape; anything else is the path-keyed first
   * one, including a cursor with no stamp at all.
   */
  legacyVersion(value: unknown): number | null {
    if (!isRecord(value)) return null;
    return value.version === OBSIDIAN_STATE_VERSION ? OBSIDIAN_STATE_VERSION : 1;
  },

  migrate: {
    /**
     * Path-keyed to identity-keyed.
     *
     * The first shape used a note's path as both the map key and the
     * `externalId` it emitted, so every stored document is addressed by
     * something a rename invalidates. There is no way to derive the new
     * identity from the old value — the identity comes from the note's
     * frontmatter, its content hash or its inode, none of which the cursor
     * kept — so the re-key is a re-read: every old path is named for deletion
     * and the vault is walked again under the new identities.
     *
     * The deletions ride in the state rather than being emitted here, because
     * a migration produces a value and cannot emit anything. The next cycle
     * drains them.
     */
    1: (prior: unknown): ObsidianSyncCursor => {
      const fileMap = isRecord(prior) && isRecord(prior.fileMap) ? prior.fileMap : {};
      const oldExternalIds = Object.keys(fileMap);
      return {
        version: OBSIDIAN_STATE_VERSION,
        fileMap: {},
        ...(oldExternalIds.length > 0 ? { pendingMigrationDeletes: oldExternalIds } : {}),
      };
    },
  },

  /**
   * A runaway guard, not a capacity limit.
   *
   * One entry per note is proportional to the vault by design, and the ceiling
   * is set well above any vault a person writes by hand so that tripping it
   * means something is wrong — a map that stopped pruning deleted notes, an
   * identity that changes on every read and accumulates a new entry each
   * cycle. Those failures otherwise present as the writer thread gradually
   * slowing down, months after the change that caused them.
   */
  maxBytes: 32 * 1024 * 1024,

  /**
   * A vault is a directory this source can re-read in full at any time, so
   * discarding an unreadable bookmark costs a re-walk and loses nothing.
   */
  onUnreadable: "rebootstrap",
};

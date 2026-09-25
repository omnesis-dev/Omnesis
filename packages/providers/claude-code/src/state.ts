// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What this source persists between runs, and why a lost cursor loses no
 * transcripts.
 *
 * `createLocalAgentSessionSource` (`@omnesis/source-sdk/local-agent-sessions`)
 * re-lists Claude Code's `~/.claude/projects` tree from disk on every cycle —
 * it never trusts the cursor to say which session files exist, only which
 * ones can skip re-parsing because they are unchanged. On a cycle that
 * finishes a full pass (`hasMore: false` with a safe scan), it reports every
 * session's ids as `presentExternalIds`, which is this source's corpus-wide
 * "here is everything upstream currently holds" signal — the same
 * reconciliation Obsidian's vault walk and the browser-history database read
 * perform, not the screen-time case's append-only watermark with nothing to
 * reconcile against. A stored cursor lost between cycles forces the next
 * cycle to re-parse every session file currently on disk instead of skipping
 * the unchanged ones, which is slower; it does not change what that cycle
 * concludes, because the conclusion comes from the filesystem, not the
 * cursor.
 *
 * This source separately declares `contentRetention: "best-effort"`: Claude
 * Code can rewrite a session file's own content between cycles (compaction,
 * `/clear`, and the other `NON_TREE_RECORD_TYPES` bookkeeping this source's
 * parser already tolerates), so a healthy cursor can already fail to see the
 * same message twice. That risk is about a session file's *content* on a
 * given read; it does not depend on the sync cursor at all, and a cursor
 * loss does not add to it — the next cycle reads whatever the file holds at
 * that moment, exactly as a normal incremental cycle would. Whatever project
 * directory Claude Code has fully removed by the time of the loss was
 * equally unrecoverable with a healthy cursor. `onUnreadable: "rebootstrap"`
 * matches what a normal complete cycle already does.
 *
 * The shared cursor's `version: 2` is a fixed discriminant on the shape
 * itself (present since the module's introduction, with no `version: 1`
 * shape ever written) rather than a value this source's own history has
 * moved through, so there is nothing for `legacyVersion` to translate.
 * `state.version` here starts at 1 and stays there until this source's own
 * declared shape changes.
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { LocalAgentSessionCursor } from "@omnesis/source-sdk/local-agent-sessions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isFileState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.size !== "number") return false;
  if (typeof value.mtimeMs !== "number") return false;
  if (typeof value.ctimeMs !== "number") return false;
  if (typeof value.ino !== "number") return false;
  if (value.dev !== undefined && typeof value.dev !== "number") return false;
  if (value.nlink !== undefined && typeof value.nlink !== "number") return false;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return false;
  if (!isStringArray(value.externalIds)) return false;
  if (typeof value.complete !== "boolean") return false;
  return true;
}

function isFileMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isFileState);
}

/**
 * Accepts every phase a cycle can be paused in. `pendingFileKeys`,
 * `cycleTotal`, `cyclePhase` and `snapshotSafe` are all present together on a
 * mid-cycle page and all absent on a settled one — decoding both the same way
 * is what keeps a page mid-walk from being reclassified as legacy and
 * re-migrated on the next page.
 */
function decode(value: unknown): LocalAgentSessionCursor | null {
  if (!isRecord(value)) return null;
  if (value.version !== 2) return null;
  if (typeof value.scanKey !== "string") return null;
  if (!isFileMap(value.files)) return null;
  if (value.pendingFileKeys !== undefined && !isStringArray(value.pendingFileKeys)) return null;
  if (value.cycleTotal !== undefined && typeof value.cycleTotal !== "number") return null;
  if (
    value.cyclePhase !== undefined &&
    value.cyclePhase !== "bootstrap" &&
    value.cyclePhase !== "incremental"
  ) {
    return null;
  }
  if (value.snapshotSafe !== undefined && typeof value.snapshotSafe !== "boolean") return null;
  return value as unknown as LocalAgentSessionCursor;
}

export const claudeCodeStateSpec: SourceStateSpec<LocalAgentSessionCursor> = {
  version: 1,

  decode,

  /**
   * A runaway guard, not a capacity limit.
   *
   * `files` holds one entry per session file currently found under the
   * configured project directory; a complete scan rebuilds it from what is
   * on disk right now, so a file Claude Code has since removed drops out on
   * the next settled cycle rather than accumulating forever. The instance
   * already refuses to return a cursor over 16 MiB before this envelope wraps
   * it (`MAX_CURSOR_BYTES` in `@omnesis/source-sdk`'s
   * `local-agent-sessions.ts`); this mirrors that ceiling at the host layer,
   * with headroom for the envelope, so tripping it means the inner guard was
   * bypassed or removed rather than that a session archive grew.
   */
  maxBytes: 20 * 1024 * 1024,

  onUnreadable: "rebootstrap",
};

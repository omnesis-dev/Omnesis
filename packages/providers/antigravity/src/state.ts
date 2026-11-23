// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What this source persists between runs, and why a lost cursor loses no
 * transcripts.
 *
 * `createLocalAgentSessionSource` (`@omnesis/source-sdk/local-agent-sessions`)
 * re-lists Antigravity's brain directories from disk on every cycle — it never
 * trusts the cursor to say which files exist, only which ones can skip
 * re-parsing because they are unchanged. On a cycle that finishes a full pass
 * (`hasMore: false` with a safe scan), it reports every session's ids as
 * `presentExternalIds`. A lost cursor forces the next cycle to re-parse every
 * transcript currently on disk instead of skipping unchanged ones, which is
 * slower without changing what that cycle concludes. `onUnreadable:
 * "rebootstrap"` matches what a normal complete cycle already does.
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

export const antigravityStateSpec: SourceStateSpec<LocalAgentSessionCursor> = {
  version: 1,
  decode,
  maxBytes: 20 * 1024 * 1024,
  onUnreadable: "rebootstrap",
};

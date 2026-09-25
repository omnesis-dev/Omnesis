// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile, stat } from "node:fs/promises";

export interface ConversationRetentionFile {
  id: string;
  path: string;
}

export interface ConversationRetentionCandidate {
  id: string;
  updatedAt: string;
  /** Exact inode identity + nanosecond timestamps, serialized for worker IPC. */
  fileIdentity: string;
}

/** Shared eligibility rule used by both typed runtime origins and worker JSON. */
export function originUsesAnchoredThreadProfile(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = (value as Record<string, unknown>).kind;
  return kind === "brief";
}

/**
 * Parse a bounded group of transcript files for the retention drip.
 *
 * Production dispatches this function on the reserved-slot IO pool. The
 * before/after fingerprint rejects a file that changed while it was read; the
 * main-thread deletion path checks the same fingerprint again after acquiring
 * the conversation mutation lock.
 */
export async function readConversationRetentionCandidates(
  files: readonly ConversationRetentionFile[],
  cutoffMs: number,
): Promise<ConversationRetentionCandidate[]> {
  const candidates: ConversationRetentionCandidate[] = [];
  for (const file of files) {
    try {
      const before = await stat(file.path, { bigint: true });
      const parsed: unknown = JSON.parse(await readFile(file.path, "utf8"));
      const after = await stat(file.path, { bigint: true });
      if (
        fileIdentity(before) !== fileIdentity(after) ||
        !isRetentionEligible(parsed, file.id, cutoffMs)
      ) {
        continue;
      }
      const record = parsed as { updatedAt: string };
      candidates.push({
        id: file.id,
        updatedAt: record.updatedAt,
        fileIdentity: fileIdentity(after),
      });
    } catch {
      // A concurrently removed or malformed transcript is not a retention
      // candidate. Normal conversation reads retain their existing warning.
    }
  }
  return candidates;
}

function isRetentionEligible(value: unknown, expectedId: string, cutoffMs: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.id !== expectedId ||
    record.pinned === true ||
    typeof record.updatedAt !== "string" ||
    !Array.isArray(record.messages)
  ) {
    return false;
  }
  if (originUsesAnchoredThreadProfile(record.origin)) return false;
  const updatedAt = Date.parse(record.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt < cutoffMs;
}

export function fileIdentity(value: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): string {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}

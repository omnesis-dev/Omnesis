// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { ManagedTextFiles } from "../managed-text-files.js";

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

/**
 * Origins the retention drip never deletes: the standing Morning brief
 * conversation is permanent. Shared by typed runtime origins and worker JSON.
 */
export function originIsPermanent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).kind === "daily_brief";
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
  const inspected = await readConversationCleanupCandidates(files, cutoffMs);
  return inspected.flatMap((file) => (file.candidate ? [file.candidate] : []));
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

export interface ConversationCleanupInspection {
  id: string;
  candidate?: ConversationRetentionCandidate;
  bytesEstimate: number;
  protectedReason?: string;
}
/** Shared eligibility inspection for manual cleanup and automatic retention. */
export async function readConversationCleanupCandidates(
  files: readonly ConversationRetentionFile[],
  cutoffMs: number,
): Promise<ConversationCleanupInspection[]> {
  const out: ConversationCleanupInspection[] = [];
  for (const file of files) {
    try {
      const before = await lstat(file.path, { bigint: true });
      if (!before.isFile()) {
        out.push({ id: file.id, bytesEstimate: 0, protectedReason: "unsafe" });
        continue;
      }
      const parsed: unknown = JSON.parse(
        await new ManagedTextFiles(dirname(dirname(file.path))).decode(
          file.path,
          await readFile(file.path, "utf8"),
        ),
      );
      const after = await lstat(file.path, { bigint: true });
      if (fileIdentity(before) !== fileIdentity(after)) {
        out.push({ id: file.id, bytesEstimate: 0, protectedReason: "changed" });
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        out.push({ id: file.id, bytesEstimate: 0, protectedReason: "invalid" });
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const updated = typeof record.updatedAt === "string" ? Date.parse(record.updatedAt) : NaN;
      if (record.id !== file.id || !Number.isFinite(updated) || !Array.isArray(record.messages)) {
        out.push({ id: file.id, bytesEstimate: 0, protectedReason: "invalid" });
        continue;
      }
      if (!(updated < cutoffMs)) continue;
      const protectedReason =
        record.pinned === true
          ? "pinned"
          : originIsPermanent(record.origin)
            ? "permanent"
            : undefined;
      out.push({
        id: file.id,
        bytesEstimate: Number(after.size),
        ...(protectedReason
          ? { protectedReason }
          : {
              candidate: {
                id: file.id,
                updatedAt: record.updatedAt as string,
                fileIdentity: fileIdentity(after),
              },
            }),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        out.push({ id: file.id, bytesEstimate: 0, protectedReason: "invalid" });
    }
  }
  return out;
}

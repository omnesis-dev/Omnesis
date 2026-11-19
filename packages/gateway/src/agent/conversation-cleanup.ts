// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  fileIdentity,
  type ConversationCleanupInspection,
  type ConversationRetentionFile,
} from "./conversation-retention.js";
import type { Dir } from "node:fs";
import type {
  HistoryCleanupPage,
  StoredHistoryCleanupJob,
} from "../storage/history-cleanup-types.js";
export type ConversationCleanupRead = (
  files: readonly ConversationRetentionFile[],
  cutoff: number,
) => Promise<ConversationCleanupInspection[]>;
/** Independent directory ownership; a quiet complete verification pass proves EOF despite deletion. */
export class ConversationCleanupScanner {
  private dir: Dir | null = null;
  private initialIdentity: string | null = null;
  private initialRemoved = 0;
  private queue: ConversationCleanupInspection[] = [];
  private newPass = true;
  private exhausted = false;
  constructor(
    private readonly path: string,
    private readonly read: ConversationCleanupRead,
  ) {}
  async next(job: StoredHistoryCleanupJob): Promise<HistoryCleanupPage> {
    let scanned = 0;
    const reasons: Record<string, number> = {};
    const resetProtected = this.newPass;
    this.newPass = false;
    if (!this.dir) {
      try {
        this.initialIdentity = fileIdentity(await stat(this.path, { bigint: true }));
        this.dir = await opendir(this.path);
        this.initialRemoved = job.removed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { cursor: null, scanned: 0, protectedReasons: {}, done: true, resetProtected };
        throw error;
      }
    }
    if (this.queue.length === 0) {
      const files: ConversationRetentionFile[] = [];
      for (let i = 0; i < 20; i++) {
        const entry = await this.dir.read();
        if (!entry) {
          this.exhausted = true;
          break;
        }
        scanned++;
        if (!entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -5);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) || !entry.isFile()) {
          reasons.unsafe = (reasons.unsafe ?? 0) + 1;
          continue;
        }
        files.push({ id, path: join(this.path, entry.name) });
      }
      this.queue = await this.read(files, Date.parse(job.before));
    }
    while (this.queue.length) {
      const item = this.queue.shift()!;
      if (item.protectedReason) {
        reasons[item.protectedReason] = (reasons[item.protectedReason] ?? 0) + 1;
        continue;
      }
      if (item.candidate)
        return {
          cursor: null,
          scanned,
          protectedReasons: reasons,
          done: false,
          resetProtected,
          candidate: {
            id: item.id,
            identity: item.candidate.fileIdentity,
            bytesEstimate: item.bytesEstimate,
            detail: item.candidate.updatedAt,
          },
        };
    }
    if (this.exhausted) {
      const changed =
        this.initialIdentity !== fileIdentity(await stat(this.path, { bigint: true }));
      const removed = job.removed !== this.initialRemoved;
      await this.close();
      if (changed || removed) this.newPass = true;
      return {
        cursor: null,
        scanned,
        protectedReasons: reasons,
        done: !changed && !removed,
        progressed: removed,
        resetProtected,
      };
    }
    return { cursor: null, scanned, protectedReasons: reasons, done: false, resetProtected };
  }
  async close(): Promise<void> {
    await this.dir?.close().catch(() => {});
    this.dir = null;
    this.queue = [];
    this.exhausted = false;
  }
}

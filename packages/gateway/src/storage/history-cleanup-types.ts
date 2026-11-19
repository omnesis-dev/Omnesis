// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export type HistoryCleanupTarget = "brain-transcripts" | "conversations" | "backups";
export type HistoryCleanupState = "queued" | "running" | "completed" | "failed" | "cancelled";
export type HistoryCleanupRequest =
  | { target: "brain-transcripts" | "conversations"; before: string }
  | { target: "backups"; before: string; keepNewest?: boolean };
export interface HistoryCleanupCandidate {
  id: string;
  identity: string;
  bytesEstimate: number;
  /** Store-owned restart information; never supplied by the HTTP caller. */
  detail?: string;
}
export interface HistoryCleanupJob {
  id: string;
  target: HistoryCleanupTarget;
  before: string;
  keepNewest?: boolean;
  state: HistoryCleanupState;
  scanned: number;
  removed: number;
  protected: number;
  protectedReasons: Record<string, number>;
  removedBytesEstimate: number;
  cancelRequested: boolean;
  /** True while durable removal authority remains, including retryable failures. */
  hasPendingRemoval: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  error: string | null;
}
export interface StoredHistoryCleanupJob extends Omit<HistoryCleanupJob, "hasPendingRemoval"> {
  revision: number;
  cursor: string | null;
  pending: HistoryCleanupCandidate | null;
}
export interface HistoryCleanupPage {
  candidate?: HistoryCleanupCandidate;
  resetProtected?: boolean;
  progressed?: boolean;
  cursor: string | null;
  scanned: number;
  protectedReasons: Record<string, number>;
  done: boolean;
}
export type HistoryCleanupOutcome =
  | { state: "removed"; bytesEstimate: number }
  | { state: "protected"; reason: string }
  | { state: "pending"; candidate?: HistoryCleanupCandidate };
export interface HistoryCleanupAdapter {
  reserve?(job: StoredHistoryCleanupJob, candidate: HistoryCleanupCandidate): Promise<boolean>;
  next(job: StoredHistoryCleanupJob): Promise<HistoryCleanupPage>;
  remove(
    job: StoredHistoryCleanupJob,
    candidate: HistoryCleanupCandidate,
  ): Promise<HistoryCleanupOutcome>;
  acknowledge?(job: StoredHistoryCleanupJob, candidate: HistoryCleanupCandidate): Promise<void>;
  close?(jobId: string): Promise<void>;
}

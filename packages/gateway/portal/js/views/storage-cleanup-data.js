// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { storageBytes } from "./storage-data.js";

const TARGETS = {
  "brain-transcripts": {
    label: "Brain run logs", action: "Trim run logs",
    explanation: "Remove saved logs for Brain runs that finished before the selected date. Running and unfinished runs are kept. Knowledge and tasks are kept.",
  },
  conversations: {
    label: "Chat history", action: "Trim chat history",
    explanation: "Remove chat history whose last activity was before the selected date. Pinned, permanent and active conversations are kept.",
  },
  backups: {
    label: "Backups", action: "Delete old backups",
    explanation: "Remove completed backups before the selected date. Backups that are running or incomplete are always kept.",
  },
};

export function storageCleanupTarget(target) {
  return Object.hasOwn(TARGETS, target) ? TARGETS[target] : null;
}

export function storageCleanupTargetForStore(storeId) {
  if (storeId === "transcripts") return "brain-transcripts";
  return ["conversations", "backups"].includes(storeId) ? storeId : null;
}

/** Validate calendar dates before deriving an exclusive UTC boundary. */
export function storageCleanupCutoff(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const cutoff = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(cutoff.getTime()) && cutoff.toISOString().slice(0, 10) === date ? cutoff.toISOString() : null;
}

export function storageCleanupActive(job) {
  return ["queued", "running"].includes(job.state) || (job.state === "failed" && job.hasPendingRemoval === true);
}

export function visibleStorageCleanupJobs(jobs, target) {
  const matching = jobs.filter((job) => job.target === target);
  const active = matching.filter(storageCleanupActive);
  const terminal = matching.filter((job) => !storageCleanupActive(job))
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))[0];
  return active.length ? active : terminal ? [terminal] : [];
}

export function storageCleanupStatus(job) {
  const count = (value) => Number.isFinite(value) && value >= 0 ? value.toLocaleString() : "0";
  const label = job.state === "running" && job.cancelRequested ? "Stopping after current cleanup"
    : job.state === "failed" && job.hasPendingRemoval ? "Cleanup paused; retrying automatically"
    : job.state === "completed" ? "Cleanup completed" : job.state === "failed" ? "Cleanup stopped"
    : job.state === "cancelled" ? "Cleanup cancelled" : job.state === "queued" ? "Cleanup queued" : "Cleaning up";
  const bytes = Number.isFinite(job.removedBytesEstimate) && job.removedBytesEstimate >= 0
    ? ` · ${storageBytes(job.removedBytesEstimate)} estimated file data removed` : "";
  return `${label} · ${count(job.removed)} removed · ${count(job.protected)} protected${bytes}${job.error ? ` · ${job.error}` : ""}`;
}

/** Keep progress and completion visible after a category's last file disappears. */
export function storageCleanupRows(rows, jobs) {
  const result = [...rows];
  for (const [id, target] of [["transcripts", "brain-transcripts"], ["conversations", "conversations"], ["backups", "backups"]]) {
    if (!result.some((row) => row.id === id) && jobs.some((job) => job.target === target)) {
      result.push({id, label: storageCleanupTarget(target).label, bytes: 0, sourceBytes: 0, remainderBytes: 0, state: "ready", attributed: false});
    }
  }
  return result;
}

export function storageCleanupProtectedReasons(job) {
  const labels = {active: "Active", pinned: "Pinned", permanent: "Permanent", newest: "Newest backup",
    incomplete: "Incomplete", changed: "Changed during cleanup", unsafe: "Unsafe to remove", "already-removed": "Already removed", invalid: "Missing or invalid metadata"};
  return Object.entries(job.protectedReasons ?? {}).filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([reason, count]) => ({label: Object.hasOwn(labels, reason) ? labels[reason] : "Other protected", count}));
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { FsConversationStore } from "../agent/conversation-store.js";
import type { AgentLifecycle } from "../agent/agent-lifecycle.js";
import type { ConversationCleanupScanner } from "../agent/conversation-cleanup.js";
import type { HistoryCleanupAdapter } from "./history-cleanup-types.js";
export function conversationCleanupAdapter(
  store: Pick<FsConversationStore, "createCleanupScanner">,
  lifecycle: Pick<
    AgentLifecycle,
    "cleanupConversation" | "reserveHistoryCleanup" | "releaseHistoryCleanup"
  >,
): HistoryCleanupAdapter {
  const scans = new Map<string, ConversationCleanupScanner>();
  const owners = new Map<string, string>();
  return {
    reserve: async (job, candidate) => {
      const reserved = lifecycle.reserveHistoryCleanup(candidate.id);
      if (reserved) owners.set(job.id, candidate.id);
      return reserved;
    },
    next: (job) => {
      let scan = scans.get(job.id);
      if (!scan) {
        scan = store.createCleanupScanner();
        scans.set(job.id, scan);
      }
      return scan.next(job);
    },
    remove: async (job, candidate) => {
      owners.set(job.id, candidate.id);
      return lifecycle.cleanupConversation(candidate, Date.parse(job.before));
    },
    acknowledge: async (job, candidate) => {
      lifecycle.releaseHistoryCleanup(candidate.id);
      if (owners.get(job.id) === candidate.id) owners.delete(job.id);
    },
    close: async (id) => {
      await scans.get(id)?.close();
      scans.delete(id);
      const owner = owners.get(id);
      if (owner) lifecycle.releaseHistoryCleanup(owner);
      owners.delete(id);
    },
  };
}

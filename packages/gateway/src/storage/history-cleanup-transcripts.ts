// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { FsCognitionTranscriptStore } from "../brain/transcripts.js";
import type { HistoryCleanupAdapter } from "./history-cleanup-types.js";
export function transcriptCleanupAdapter(store: FsCognitionTranscriptStore): HistoryCleanupAdapter {
  return {
    next: (job) => store.cleanupPage(Date.parse(job.before), job.cursor),
    remove: (job, candidate) => store.cleanupRemove(candidate, Date.parse(job.before)),
  };
}

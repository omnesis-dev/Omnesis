// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, isTransientSyncError } from "@omnesis/core";
import { syncPage } from "@omnesis/source-sdk";
import {
  BACKFILL_BATCH_SIZE,
  FULL_SELECT,
  type GraphMessage,
  type OutlookEmailCursor,
} from "./outlook-types.js";
import type { SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type { GraphClient } from "./graph-client.js";

const log = createLogger("source:outlook-email");

export interface BodyBackfillDeps {
  graph: GraphClient;
  normalize: (msg: GraphMessage) => Promise<DocumentInput[]>;
}

export async function bodyBackfillSync(
  state: OutlookEmailCursor,
  deps: BodyBackfillDeps,
): Promise<SyncResult<OutlookEmailCursor>> {
  const ids = state.backfillIds ?? [];
  const startIdx = state.backfillIndex ?? 0;
  const endIdx = Math.min(startIdx + BACKFILL_BATCH_SIZE, ids.length);
  const batch = ids.slice(startIdx, endIdx);

  const documents: DocumentInput[] = [];
  let failed = 0;
  for (const id of batch) {
    try {
      const msg = await deps.graph.get<GraphMessage>(`/me/messages/${id}?$select=${FULL_SELECT}`);
      const docs = await deps.normalize(msg);
      documents.push(...docs);
    } catch (err) {
      // A transient non-OCR extraction blip must NOT be swallowed into a
      // permanent drop:
      // re-throw so the backfill page fails and retries next tick with the
      // cursor un-advanced, rather than skipping the message's body/attachment
      // for good.
      if (isTransientSyncError(err)) throw err;
      // Permanent per-message failures are logged at `warn` with a per-batch
      // info summary so the failure rate is visible (without spamming on a
      // noisy mailbox); the message is skipped and the backfill advances.
      failed++;
      log.warn(`body-backfill: ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed > 0) {
    log.info(
      `body-backfill batch: ${documents.length} succeeded, ${failed} failed out of ${batch.length} requested`,
    );
  }

  const isComplete = endIdx >= ids.length;
  if (isComplete) {
    log.info(`Bootstrap pass 2 complete (backfilled ${ids.length} bodies)`);
    return syncPage<OutlookEmailCursor>(documents, {
      phase: "incremental",
      folderDeltas: state.folderDeltas,
    });
  }

  return syncPage<OutlookEmailCursor>(
    documents,
    { ...state, backfillIndex: endIdx },
    {
      hasMore: true,
      progress: {
        phase: "body-backfill",
        total: ids.length,
        processed: endIdx,
      },
    },
  );
}

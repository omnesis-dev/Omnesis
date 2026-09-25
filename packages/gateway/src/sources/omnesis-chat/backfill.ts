// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One-shot backfill of existing conversation transcripts on first boot
 * after the omnesis-chat source ships. Reads every `<id>.json` in the
 * configured conversations directory, upserts each as a document, and
 * records a completion flag in `gateway_meta` so subsequent boots are
 * no-ops.
 *
 * The flag is keyed `omnesis-chat:backfill-complete:v1` — bumping the
 * suffix in a future change forces a re-backfill (e.g. if the
 * rendering rules change). Idempotent at the row level too: a partial
 * backfill that crashes mid-way leaves committed conversation docs
 * in place; the next boot resumes from where it stopped because the
 * flag isn't written until every record processed cleanly.
 *
 * Runs on the main thread at boot, not as a periodic task — we want
 * the corpus to be searchable on day one, and the conversation count
 * is small (tens or low hundreds) so the synchronous-at-boot cost is
 * negligible.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createLogger } from "@omnesis/core";

import { buildDocumentInput, renderedCitationsToInputs } from "./upsert.js";
import { renderConversation } from "./render.js";
import type { ConversationRecord } from "../../agent/conversation-store.js";
import type { WriteGate } from "../../write-gate.js";

const log = createLogger("gateway:omnesis-chat").child("backfill");

export const BACKFILL_FLAG_KEY = "omnesis-chat:backfill-complete:v1";

export interface BackfillDeps {
  /** Directory containing `<id>.json` transcripts. */
  conversationsDir: string;
  writeGate: WriteGate;
  /**
   * Reads the persisted backfill flag (any truthy value short-circuits
   * the run). Returns null when unset. Wired to a tiny `gateway_meta`
   * helper at the call site.
   */
  hasFlag: () => boolean;
  /** Persists the backfill flag once the sweep completes cleanly. */
  setFlag: () => void;
  /**
   * Same lookup the live upserter uses — resolves the gateway-assigned
   * `documents.id` for a (providerId, sourceId, externalId) triple. The
   * backfill needs it for the per-conversation citation write that
   * follows the doc upsert.
   */
  lookupDocId: (providerId: string, sourceId: string, externalId: string) => string | null;
}

export interface BackfillResult {
  /** Returns null when the flag was already set — no work done. */
  upserted: number | null;
  skipped: number;
  failed: number;
}

export async function runConversationBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  if (deps.hasFlag()) {
    log.info("backfill already complete — skipping");
    return { upserted: null, skipped: 0, failed: 0 };
  }
  let names: string[];
  try {
    names = await readdir(deps.conversationsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No conversations dir → no prior transcripts → mark complete and
      // stop the next boot from rescanning a non-existent path.
      deps.setFlag();
      log.info("no conversations directory present — marking backfill complete");
      return { upserted: 0, skipped: 0, failed: 0 };
    }
    throw err;
  }

  let upserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const name of names) {
    if (!name.endsWith(".json")) {
      skipped++;
      continue;
    }
    const path = join(deps.conversationsDir, name);
    try {
      const body = await readFile(path, "utf8");
      const record = JSON.parse(body) as ConversationRecord;
      if (!record.id || !Array.isArray(record.messages) || record.messages.length === 0) {
        skipped++;
        continue;
      }
      // Origin-anchored conversations (brief/entry threads) are seeded from loop
      // agent run transcripts — never corpus material (see persistAndNotify).
      if ((record as { origin?: unknown }).origin) {
        skipped++;
        continue;
      }
      const doc = buildDocumentInput(record);
      await deps.writeGate.upsertDocuments([doc]);
      const docId = deps.lookupDocId(doc.providerId, doc.sourceId, doc.externalId);
      if (docId) {
        const { citations } = renderConversation(record);
        await deps.writeGate.upsertConversationCitations(
          docId,
          renderedCitationsToInputs(citations),
        );
      }
      upserted++;
    } catch (err) {
      failed++;
      log.warn(`backfill failed for ${name}: ${(err as Error).message ?? err}`);
    }
  }

  if (failed === 0) {
    deps.setFlag();
    log.info(`backfill complete — upserted ${upserted}, skipped ${skipped}`);
  } else {
    log.warn(`backfill finished with ${failed} failures — flag NOT set; next boot will re-attempt`);
  }

  return { upserted, skipped, failed };
}

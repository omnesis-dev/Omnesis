// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { lookupDocumentIdsByExternal } from "../../db.js";
import { yieldToEventLoop, DEFAULT_INGEST_YIELD_BATCH } from "../../async-yield.js";
import {
  computeChangedFields,
  eventBus as defaultEventBus,
  extractPeopleFromMetadata,
  type DocumentProjection,
  type EventBus,
} from "../../events.js";
import type Database from "better-sqlite3";
import type { DocumentInput } from "@omnesis/types";

type Db = Database.Database;

const log = createLogger("gateway:http").child("events");

/**
 * Emits one `document.upserted` event per ingested document, carrying
 * the before/after projection so subscribers (match evaluator,
 * change-trigger evaluator) can decide what to do with inserts vs
 * field-level updates.
 *
 * `before` is the pre-write projection if the (provider, source,
 * external) tuple already existed, or `null` for fresh inserts.
 * `after` is built from the `DocumentInput` plus the gateway-assigned
 * `documents.id` (resolved post-write so we always carry the real
 * UUID, even for inserts).
 */
export class EventService {
  constructor(
    private readonly db: Db,
    private readonly eventBus: EventBus | undefined,
    private readonly hasOrchestrator: boolean,
    private readonly ingestYieldBatch: number = DEFAULT_INGEST_YIELD_BATCH,
  ) {}

  get wantsEmit(): boolean {
    return this.hasOrchestrator || !!this.eventBus;
  }

  async emitDocumentUpserted(
    docs: readonly DocumentInput[],
    before: ReadonlyMap<string, DocumentProjection>,
    /**
     * Pre-write content bodies for content-changed updates, keyed by the
     * same `providerId|sourceId|externalId` triple as `before`. Provided
     * only while a prior-content subscriber is registered (see
     * `collectPriorContents`); each body is attached to its event as
     * `beforeContent` and discarded with it.
     */
    beforeContents?: ReadonlyMap<string, string>,
    /** The stream each source's documents belong to (`""` = the source's one stream). */
    streams?: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (!this.wantsEmit || docs.length === 0) return;
    const bus = this.eventBus ?? defaultEventBus;

    // Walk the batch in sub-batches with an event-loop yield between them so a
    // large emit (the per-doc projection build + field diff is synchronous CPU,
    // plus the id-lookup SELECT) can't freeze the interactive read path for the
    // length of the whole batch. Within a sub-batch, resolve the gateway-side
    // UUIDs with a post-write lookup (one SELECT per provider/source pair): a
    // doc that did not survive the write — deleted or re-keyed by this write or
    // a concurrent one — has no id here and is skipped rather than emitted with
    // a dangling id.
    let inserts = 0;
    let updates = 0;
    let suppressed = 0;
    for (let i = 0; i < docs.length; i += this.ingestYieldBatch) {
      const sub = docs.slice(i, i + this.ingestYieldBatch);

      const dbIdsByTriple = new Map<string, string>();
      const byPair = new Map<string, string[]>();
      for (const d of sub) {
        const pairKey = `${d.providerId}|${d.sourceId}`;
        const arr = byPair.get(pairKey);
        if (arr) arr.push(d.externalId);
        else byPair.set(pairKey, [d.externalId]);
      }
      for (const [pairKey, externalIds] of byPair) {
        const [providerId, sourceId] = pairKey.split("|", 2);
        const idMap = lookupDocumentIdsByExternal(
          this.db,
          providerId,
          sourceId,
          externalIds,
          streams?.[sourceId] ?? "",
        );
        for (const [extId, dbId] of idMap) {
          dbIdsByTriple.set(`${providerId}|${sourceId}|${extId}`, dbId);
        }
      }

      for (const d of sub) {
        const tripleKey = `${d.providerId}|${d.sourceId}|${d.externalId}`;
        const dbId = dbIdsByTriple.get(tripleKey);
        if (!dbId) {
          // Doc didn't survive the write (deleted/re-keyed). Skip — there's
          // no consistent event we could fire.
          continue;
        }
        const beforeProjection = before.get(tripleKey) ?? null;
        const after = buildProjectionFromInput(d, dbId);
        const changedFields = computeChangedFields(beforeProjection, after);
        const contentChanged =
          beforeProjection === null || beforeProjection.contentHash !== after.contentHash;

        // Suppress no-op updates: if the doc existed before and nothing
        // we project differs, the SQLite UPSERT itself was a no-op (the
        // statement's WHERE clause only fires on hash/title/metadata
        // diffs). Emitting an event here would force every subscriber
        // to re-do its predicate work for nothing — avoid the wake.
        if (beforeProjection !== null && changedFields.length === 0) {
          suppressed += 1;
          continue;
        }

        if (beforeProjection === null) inserts += 1;
        else updates += 1;

        const beforeContent =
          beforeProjection !== null && contentChanged ? beforeContents?.get(tripleKey) : undefined;
        bus.emit("document.upserted", {
          before: beforeProjection,
          after,
          afterContent: d.content,
          ...(beforeContent !== undefined ? { beforeContent } : {}),
          changedFields,
          contentChanged,
        });
      }

      if (i + this.ingestYieldBatch < docs.length) await yieldToEventLoop();
    }
    if (suppressed > 0) {
      log.debug(
        `Suppressed ${suppressed} no-op upsert event${suppressed === 1 ? "" : "s"} (no projection fields changed)`,
      );
    }
    if (inserts > 0 || updates > 0) {
      log.debug(
        `Emitted document.upserted: ${inserts} insert${inserts === 1 ? "" : "s"}, ${updates} update${updates === 1 ? "" : "s"}`,
      );
    }
  }
}

function buildProjectionFromInput(doc: DocumentInput, dbId: string): DocumentProjection {
  const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
  const documentType =
    typeof metadata["documentType"] === "string" ? (metadata["documentType"] as string) : null;
  return {
    id: dbId,
    providerId: doc.providerId,
    sourceId: doc.sourceId,
    externalId: doc.externalId,
    documentType,
    title: doc.title,
    contentHash: doc.contentHash,
    metadata,
    sourceCreatedAt: doc.sourceCreatedAt,
    sourceUpdatedAt: doc.sourceUpdatedAt,
    people: extractPeopleFromMetadata(metadata),
  };
}

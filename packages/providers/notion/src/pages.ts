// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { syncPage, emptySync, SnapshotEnumeration } from "@omnesis/source-sdk";
import { SyncError } from "@omnesis/types";
import { mapNotionApiError } from "./api-error.js";
import { pageToDocument } from "./normalizer.js";
import {
  INCREMENTAL_MARGIN_MS,
  shouldEnterSnapshotMode,
  accumulateSnapshotIds,
  truncateIsoToMinute,
} from "./snapshot-state.js";
import type { SyncResult } from "@omnesis/source-sdk";
import type { ProviderId, SourceId } from "@omnesis/types";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { NotionPagesCursor, UserMap } from "./types.js";
import type { NotionClient } from "./client.js";

const log = createLogger("source:notion-pages");

function isFullPage(result: unknown): result is PageObjectResponse {
  return (
    typeof result === "object" &&
    result !== null &&
    "properties" in result &&
    (result as { object?: string }).object === "page"
  );
}

export class NotionPagesSource {
  private client: NotionClient;
  private sourceId: SourceId;
  private providerId: ProviderId;
  private dataCutoff?: string;
  private userMap?: UserMap;

  constructor(
    client: NotionClient,
    sourceId: SourceId,
    providerId: ProviderId,
    dataCutoff?: string,
    userMap?: UserMap,
  ) {
    this.client = client;
    this.sourceId = sourceId;
    this.providerId = providerId;
    this.dataCutoff = dataCutoff;
    this.userMap = userMap;
  }

  /**
   * The collector reads this call's failures to decide a source's state, so
   * every escaping error carries its classification rather than leaving the
   * collector to infer one from Notion's prose.
   */
  async sync(cursor: NotionPagesCursor | null): Promise<SyncResult<NotionPagesCursor>> {
    try {
      return await this.runSync(cursor);
    } catch (err) {
      throw mapNotionApiError(err);
    }
  }

  private async runSync(cursor: NotionPagesCursor | null): Promise<SyncResult<NotionPagesCursor>> {
    // Snapshot mode: walk the entire search list (ignoring incremental
    // cutoff) and accumulate every page ID. On completion (has_more=false),
    // we emit `presentExternalIds` so the gateway can delete pages that
    // were archived/trashed in Notion. Triggered by cadence; persists
    // across multi-page sync runs via cursor.snapshotMode + snapshotIds.
    const snapshotMode = shouldEnterSnapshotMode(cursor);

    const response = await this.client.searchPages(cursor?.startCursor);
    const nextCursor = response.next_cursor;
    const pageCursors = cursor?.pageCursors ?? [];
    if (
      typeof response.has_more !== "boolean" ||
      (response.has_more
        ? typeof nextCursor !== "string" ||
          nextCursor.trim().length === 0 ||
          nextCursor.length > 1024 ||
          nextCursor === cursor?.startCursor ||
          pageCursors.includes(nextCursor) ||
          pageCursors.length >= 10_000
        : nextCursor !== null && nextCursor !== undefined)
    ) {
      throw new SyncError(
        "transient",
        "Notion search returned invalid or repeated pagination; reconciliation withheld",
      );
    }

    const documents = [];
    let newestEditedTime = cursor?.lastEditedTime;
    let reachedCutoff = false;
    const snapshotIdsThisPage: string[] = [];

    // Compute the incremental cutoff time (with safety margin)
    let incrementalCutoff: string | undefined;
    if (!snapshotMode && cursor?.lastEditedTime) {
      const cutoffMs = new Date(cursor.lastEditedTime).getTime() - INCREMENTAL_MARGIN_MS;
      incrementalCutoff = new Date(cutoffMs).toISOString();
    }

    log.info(
      `Search returned ${response.results.length} results, has_more=${response.has_more}, snapshotMode=${snapshotMode}`,
    );

    let skippedPartial = 0;
    let skippedDbRow = 0;
    let skippedArchived = 0;

    for (const result of response.results) {
      if (!isFullPage(result)) {
        skippedPartial++;
        continue;
      }

      const page = result;

      // Skip database rows — handled by databases source
      if (page.parent.type === "database_id") {
        skippedDbRow++;
        continue;
      }

      // Skip archived or trashed pages
      if (page.archived || ("in_trash" in page && page.in_trash)) {
        skippedArchived++;
        continue;
      }

      // Snapshot mode records every reachable page ID so the gateway
      // can diff against its known set. Order matters: this happens
      // BEFORE the incremental cutoff check so a page edited long ago
      // (skipped by the cutoff in normal runs) still counts as "present".
      //
      // CRITICAL: must format the ID exactly the same way `pageToDocument`
      // does (`page-${page.id.replace(/-/g, "")}`). Notion's API returns
      // hyphenated UUIDs (`a1b0ccee-9dcd-498d-…`) while we store docs
      // under prefixed hyphenless externalIds (`page-a1b0ccee9dcd498d…`).
      // Pushing the raw `page.id` here would make every reconcile compare
      // hyphenated UUIDs against prefixed-hyphenless externalIds, match
      // nothing, and delete every notion-pages doc. Caught live during
      // Tier 4 of the sources-qa Phase 4 validation.
      if (snapshotMode) {
        snapshotIdsThisPage.push(`page-${page.id.replace(/-/g, "")}`);
      }

      // Incremental sync: stop when we reach pages older than the cutoff
      if (incrementalCutoff && page.last_edited_time < incrementalCutoff) {
        reachedCutoff = true;
        break;
      }

      // Apply data retention cutoff. This is a per-document skip, NOT a
      // stop-paging signal: search is sorted by `last_edited_time`, so an
      // old-created page can sit anywhere in the stream (e.g. an old note
      // edited recently). Halting here would drop in-retention,
      // recently-edited pages on later search pages. Only the monotonic
      // `last_edited_time` cutoff above may short-circuit pagination.
      if (this.dataCutoff && page.created_time < this.dataCutoff) {
        continue;
      }

      // Track the newest edited time for the next cursor
      if (!newestEditedTime || page.last_edited_time > newestEditedTime) {
        newestEditedTime = page.last_edited_time;
      }

      const { markdown, linkedPageIds } = await this.client.getPageContent(page.id);
      const doc = pageToDocument(
        page,
        markdown,
        this.sourceId,
        this.providerId,
        this.userMap,
        linkedPageIds,
      );
      documents.push(doc);
    }

    if (skippedPartial || skippedDbRow || skippedArchived) {
      log.info(
        `Skipped: ${skippedPartial} partial, ${skippedDbRow} db rows, ${skippedArchived} archived`,
      );
    }

    // Snapshot accumulation across the multi-page run. The IDs are kept on
    // the cursor so the next sync() call can pick up where we left off.
    const accumulatedSnapshotIds = accumulateSnapshotIds(
      cursor?.snapshotIds,
      snapshotIdsThisPage,
      snapshotMode,
    );

    // A partial object is a page Notion acknowledged but would not describe.
    // It is invisible to the enumeration and indistinguishable, from the
    // snapshot's side, from a page that no longer exists — so it poisons the
    // whole rewalk rather than quietly shrinking it.
    const snapshotDirty = snapshotMode && (skippedPartial > 0 || Boolean(cursor?.snapshotDirty));

    // hasMore: keep paging if Notion has more results AND we haven't
    // short-circuited on the incremental cutoff. In snapshot mode we
    // never short-circuit, so hasMore == response.has_more.
    const hasMore = response.has_more && (snapshotMode || !reachedCutoff);

    // Persist the watermark truncated to the minute boundary — Notion's
    // `last_edited_time` is minute-granular at the source, so any
    // sub-minute precision we'd otherwise carry forward is illusory and
    // makes the next cycle's `>` comparison inconsistent across reboots.
    const persistedEditedTime = newestEditedTime
      ? truncateIsoToMinute(newestEditedTime)
      : newestEditedTime;

    if (snapshotMode && !hasMore) {
      // Snapshot complete — emit presentExternalIds and stamp lastSnapshotAt.
      // Empty arrays are meaningful here: an emptied workspace tells the
      // gateway to delete every Notion page doc. A rewalk that could not read
      // every result it was handed is a different thing entirely, and says
      // nothing at all.
      const newCursor: NotionPagesCursor = {
        lastEditedTime: persistedEditedTime,
        startCursor: undefined,
        lastSnapshotAt: new Date().toISOString(),
        // Clear snapshot transients.
        snapshotMode: false,
        snapshotIds: undefined,
        snapshotDirty: undefined,
      };
      if (snapshotDirty) {
        const issue = new SnapshotEnumeration(["pages"])
          .gap("pages", "Notion search returned partial page objects")
          .withheldIssue();
        log.warn(
          `Snapshot rewalk finished with ${accumulatedSnapshotIds?.length ?? 0} pages enumerated ` +
            `but at least one search result came back partial — withholding presentExternalIds. ` +
            `The rewalk will be re-attempted on the next cycle.`,
        );
        // `lastSnapshotAt` is the "a snapshot happened" mark that gates the
        // rewalk cadence, so stamping it here would put deletion detection off
        // for a full interval on the strength of a rewalk that produced
        // nothing. Leave it where the last completed rewalk left it, exactly as
        // the databases source does, so the next cycle rewalks again.
        return syncPage(
          documents,
          { ...newCursor, lastSnapshotAt: cursor?.lastSnapshotAt },
          { hasMore: false, issues: issue ? [issue] : [] },
        );
      }
      const presentExternalIds = accumulatedSnapshotIds ?? [];
      log.info(
        `Snapshot complete: ${presentExternalIds.length} pages enumerated, ${documents.length} updated this page`,
      );
      return syncPage(documents, newCursor, {
        hasMore: false,
        presentExternalIds,
        issues: [],
      });
    }

    if (documents.length === 0 && !response.has_more && !snapshotMode) {
      return emptySync({ ...cursor, startCursor: undefined, pageCursors: undefined });
    }

    const newCursor: NotionPagesCursor = {
      lastEditedTime: persistedEditedTime,
      startCursor: hasMore ? (nextCursor ?? undefined) : undefined,
      pageCursors: hasMore ? [...pageCursors, nextCursor!] : undefined,
      lastSnapshotAt: cursor?.lastSnapshotAt,
      snapshotMode,
      snapshotIds: accumulatedSnapshotIds,
      snapshotDirty: snapshotDirty ? true : undefined,
    };

    log.info(
      `Synced ${documents.length} pages (hasMore=${hasMore}, cursor=${newCursor.startCursor ?? "none"}, snapshot=${snapshotMode ? (accumulatedSnapshotIds?.length ?? 0) : "off"})`,
    );

    return syncPage(documents, newCursor, { hasMore });
  }
}

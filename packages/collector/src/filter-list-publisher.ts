// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Publishes the lists a source produces for its filterable fields, as part of
 * the source's ordinary sync.
 *
 * Once per sync cycle, after the cycle's first page has committed, the
 * publisher runs each of the source's producers, compares the digest of what
 * it got with the digest the gateway reports for that list, and sends only
 * the lists that differ. They travel on sync pages that carry no documents and
 * repeat the cursor just committed, so nothing about the source's position
 * changes. A sync whose lists are unchanged sends nothing.
 *
 * Nothing here can fail a sync. A producer that throws, a list that breaks
 * the contract and a gateway that refuses a page are each logged and left for
 * the next cycle; the gateway keeps the list it has, because a list it never
 * finished receiving is never switched to.
 */

import { createLogger, toErrorMessage } from "@omnesis/core";
import {
  collectFilterList,
  filterListDigest,
  filterListRefreshDue,
  packFilterListPages,
  splitFilterList,
  type GatewayClient,
  type SyncCursor,
} from "@omnesis/source-sdk";
import type { FilterListPublication, FilterListReceipt, SourceId } from "@omnesis/types";
import type { RegisteredSource } from "./sync-engine-types.js";

const log = createLogger("collector:sync").child("filter-lists");

/** How long one producer may take to list an account. */
const FILTER_LIST_PRODUCER_TIMEOUT_MS = 10 * 60 * 1000;

/** The sync page a publication follows: its position and its write authority. */
export interface CommittedPage {
  cursor: SyncCursor;
  hasMore: boolean;
  wipeEpoch: number | undefined;
  /** Aborts when the source stops or its sync runs out of time. */
  signal: AbortSignal;
  /**
   * False when the source is replicated across devices and another device
   * holds its sync lease. The lists of such a source are shared by its
   * devices, and only the holder publishes them.
   */
  holder: boolean;
}

/** Outcomes after which the rest of a list's pages are still wanted. */
const CONTINUES: ReadonlySet<FilterListReceipt["outcome"]> = new Set(["staged", "published"]);

export class FilterListPublisher {
  /** When each source's producers last all ran to the end. */
  private readonly lastRefreshedAt = new Map<SourceId, number>();
  /** Refusals already reported, so a standing one is logged once. */
  private readonly reported = new Set<string>();

  constructor(
    private readonly gateway: Pick<GatewayClient, "getFilterListDigests" | "upsertWithCursor">,
    private readonly options: { now?: () => number; producerTimeoutMs?: number } = {},
  ) {}

  /** Refresh the lists of `source` if they are due. Never throws. */
  async publish(
    source: Pick<RegisteredSource, "id" | "providerId" | "instance">,
    page: CommittedPage,
  ): Promise<void> {
    const producers = source.instance.filterLists;
    if (!producers || !page.holder || !this.gateway.getFilterListDigests) return;
    const now = (this.options.now ?? Date.now)();
    if (!filterListRefreshDue(this.lastRefreshedAt.get(source.id), now)) return;
    try {
      const held = await this.gateway.getFilterListDigests(source.id);
      // A gateway that reports no digests does not store lists.
      if (held === undefined || page.signal.aborted) return;

      const publications: FilterListPublication[] = [];
      let everyProducerRan = true;
      for (const [field, producer] of Object.entries(producers)) {
        try {
          const signal = AbortSignal.any([
            page.signal,
            AbortSignal.timeout(this.options.producerTimeoutMs ?? FILTER_LIST_PRODUCER_TIMEOUT_MS),
          ]);
          const items = await collectFilterList(producer, { signal });
          const digest = filterListDigest(items);
          if (held[field] !== digest) publications.push(...splitFilterList(field, items, digest));
        } catch (error) {
          everyProducerRan = false;
          if (page.signal.aborted) return;
          log.warn(
            `Could not list "${field}" for ${source.id}; the gateway keeps the list it has: ${toErrorMessage(error)}`,
          );
        }
      }
      await this.send(source, page, publications);
      if (everyProducerRan) this.lastRefreshedAt.set(source.id, now);
    } catch (error) {
      if (page.signal.aborted) return;
      log.warn(`Could not publish the lists of ${source.id}: ${toErrorMessage(error)}`);
    }
  }

  private async send(
    source: Pick<RegisteredSource, "id" | "providerId">,
    page: CommittedPage,
    publications: FilterListPublication[],
  ): Promise<void> {
    /** Fields whose remaining pages are no longer wanted. */
    const settled = new Set<string>();
    for (const batch of packFilterListPages(publications)) {
      const wanted = batch.filter((publication) => !settled.has(publication.field));
      if (wanted.length === 0) continue;
      if (page.signal.aborted) return;
      const response = await this.gateway.upsertWithCursor({
        providerId: source.providerId,
        sourceId: source.id,
        documents: [],
        hasMore: page.hasMore,
        cursor: page.cursor,
        wipeEpoch: page.wipeEpoch,
        filterLists: wanted,
      });
      // A refused page, or a gateway that ignored the lists: the next cycle
      // compares digests again and sends whatever is still missing.
      if (response.rejected || response.rejectedAsRemoved || !response.filterLists) return;
      for (const receipt of response.filterLists) {
        if (CONTINUES.has(receipt.outcome)) continue;
        settled.add(receipt.field);
        this.report(source.id, receipt);
      }
    }
  }

  private report(sourceId: SourceId, receipt: FilterListReceipt): void {
    // The gateway already held this list; another publication of it got there first.
    if (receipt.outcome === "current") return;
    const key = `${sourceId}\n${receipt.field}\n${receipt.outcome}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    log.warn(
      `The gateway did not store the list of ${sourceId} for "${receipt.field}" (${receipt.outcome}); it is sent again on the next sync`,
    );
  }
}

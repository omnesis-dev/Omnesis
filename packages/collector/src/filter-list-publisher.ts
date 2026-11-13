// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Publishes the lists a source produces for its filterable fields, as part of
 * the source's ordinary sync.
 *
 * A sync cycle offers its lists after its first page has committed, and once
 * more after its last page for the lists the first offer left open. At each
 * offer the publisher runs the producers of the fields still open, compares
 * the digest of what it got with the digest the gateway reports for that list,
 * and sends only the lists that differ. They travel on sync pages that carry
 * no documents and repeat the cursor just committed, so nothing about the
 * source's position changes. A sync whose lists are unchanged sends nothing.
 *
 * A field is closed for the cycle once the gateway holds the list its
 * producer returned. A producer that says its list is not ready yet leaves
 * the field open without a word in the log; that is how a source whose list
 * is only whole once its last page is read publishes it in the same cycle.
 *
 * Nothing here can fail a sync. A producer that throws, a list that breaks
 * the contract and a gateway that refuses a page are each logged and left
 * open; the gateway keeps the list it has, because a list it never finished
 * receiving is never switched to.
 */

import { createLogger, toErrorMessage } from "@omnesis/core";
import {
  collectFilterList,
  FilterListNotReadyError,
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
  /**
   * The source version the host runs. Every page of a sync carries it, a
   * list page included: the gateway reads a page without one as written by
   * a build before versions.
   */
  sourceVersion: number | undefined;
  /** Aborts when the source stops or its sync runs out of time. */
  signal: AbortSignal;
  /**
   * False when the source is replicated across devices and another device
   * holds its sync lease. The lists of such a source are shared by its
   * devices, and only the holder publishes them.
   */
  holder: boolean;
}

/**
 * What one sync cycle has done about its source's lists. The sync creates one
 * per cycle with {@link newFilterListCycle} and passes it to every offer.
 */
export interface FilterListCycle {
  /** The fields whose list the gateway is known to hold, as of this cycle. */
  readonly closed: Set<string>;
  /** Whether this cycle refreshes lists at all; decided at its first offer. */
  due?: boolean;
}

export function newFilterListCycle(): FilterListCycle {
  return { closed: new Set() };
}

/** Outcomes after which the rest of a list's pages are still wanted. */
const CONTINUES: ReadonlySet<FilterListReceipt["outcome"]> = new Set(["staged", "published"]);

/** Outcomes that say the gateway now holds the whole list. */
const HELD: ReadonlySet<FilterListReceipt["outcome"]> = new Set(["published", "current"]);

export class FilterListPublisher {
  /** When each source's producers last all ran to the end. */
  private readonly lastRefreshedAt = new Map<SourceId, number>();
  /** Refusals already reported, so a standing one is logged once. */
  private readonly reported = new Set<string>();

  constructor(
    private readonly gateway: Pick<GatewayClient, "getFilterListDigests" | "upsertWithCursor">,
    private readonly options: { now?: () => number; producerTimeoutMs?: number } = {},
  ) {}

  /**
   * Refresh the lists of `source` that `cycle` has not closed yet, if they
   * are due. Never throws.
   */
  async publish(
    source: Pick<RegisteredSource, "id" | "providerId" | "instance">,
    page: CommittedPage,
    cycle: FilterListCycle = newFilterListCycle(),
  ): Promise<void> {
    const producers = source.instance.filterLists;
    if (!producers || !page.holder || !this.gateway.getFilterListDigests) return;
    const now = (this.options.now ?? Date.now)();
    cycle.due ??= filterListRefreshDue(this.lastRefreshedAt.get(source.id), now);
    if (!cycle.due) return;
    const open = Object.entries(producers).filter(([field]) => !cycle.closed.has(field));
    if (open.length === 0) return;
    try {
      const held = await this.gateway.getFilterListDigests(source.id);
      // A gateway that reports no digests does not store lists.
      if (held === undefined || page.signal.aborted) return;

      const publications: FilterListPublication[] = [];
      let everyProducerRan = true;
      for (const [field, producer] of open) {
        try {
          const signal = AbortSignal.any([
            page.signal,
            AbortSignal.timeout(this.options.producerTimeoutMs ?? FILTER_LIST_PRODUCER_TIMEOUT_MS),
          ]);
          const items = await collectFilterList(producer, { signal });
          const digest = filterListDigest(items);
          if (held[field] === digest) cycle.closed.add(field);
          else publications.push(...splitFilterList(field, items, digest));
        } catch (error) {
          everyProducerRan = false;
          if (page.signal.aborted) return;
          if (error instanceof FilterListNotReadyError) {
            log.debug(`The list of ${source.id} for "${field}" is not ready yet: ${error.message}`);
            continue;
          }
          log.warn(
            `Could not list "${field}" for ${source.id}; the gateway keeps the list it has: ${toErrorMessage(error)}`,
          );
        }
      }
      await this.send(source, page, publications, cycle);
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
    cycle: FilterListCycle,
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
        sourceVersion: page.sourceVersion,
        filterLists: wanted,
      });
      // A refused page, or a gateway that ignored the lists: the next offer
      // compares digests again and sends whatever is still missing.
      if (response.rejected || response.rejectedAsRemoved || !response.filterLists) return;
      for (const receipt of response.filterLists) {
        if (HELD.has(receipt.outcome)) cycle.closed.add(receipt.field);
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

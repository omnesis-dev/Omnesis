// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The list of what exists in an account for a filterable field: the labels,
 * the folders and which folder each sits in, the chats and their members.
 *
 * A record carries only the id of what it belongs to. The names, the tree and
 * the members live in this list, which a source produces and its host
 * publishes to the gateway as part of an ordinary sync. The list says nothing
 * about any record, so its cost grows with the number of labels or folders,
 * never with the number of records.
 *
 * A source attaches one producer per filterable field with
 * {@link withFilterLists}. The host runs each producer, puts the result in a
 * canonical order, and sends it only when its digest differs from the one the
 * gateway holds. Everything here is pure; the host owns the gateway calls.
 */

import { createHash } from "node:crypto";
import {
  FILTER_IDENTIFIER_TYPES,
  FILTER_LIST_LIMITS,
  type FilterIdentifier,
  type FilterListItem,
  type FilterListPublication,
} from "@omnesis/types";
import type { SourceInstance } from "./define-source.js";

/**
 * When a host refreshes the lists of a source. This constant is the one place
 * that decides it; {@link filterListRefreshDue} is the one place that reads it.
 *
 * - `every-sync-when-changed` — the producers run once in every sync cycle,
 *   and a list is sent only when it differs from the one the gateway holds.
 * - `at-most-every` — the same, but the producers run no more often than
 *   `intervalMs`, for when listing upstream on every sync costs too much.
 */
export type FilterListRefresh =
  { mode: "every-sync-when-changed" } | { mode: "at-most-every"; intervalMs: number };

export const FILTER_LIST_REFRESH: FilterListRefresh = { mode: "every-sync-when-changed" };

/**
 * Whether a sync cycle should refresh a source's lists.
 *
 * `lastRefreshedAt` is when this host last ran the source's producers to the
 * end, or `undefined` when it has not since it started.
 */
export function filterListRefreshDue(
  lastRefreshedAt: number | undefined,
  now: number,
  refresh: FilterListRefresh = FILTER_LIST_REFRESH,
): boolean {
  if (refresh.mode === "every-sync-when-changed" || lastRefreshedAt === undefined) return true;
  return now - lastRefreshedAt >= refresh.intervalMs;
}

/** What a producer may read while it lists. */
export interface FilterListContext {
  /** Aborts when the source stops or the listing runs out of time. */
  signal: AbortSignal;
}

/**
 * Lists everything that exists in the account for one filterable field.
 *
 * The result must be the whole list or a thrown error, never a part of it: an
 * item missing from a published list reads as no longer existing, and the
 * records that belong to it stop matching any filter. A producer that cannot
 * finish (a failed page, a rate limit) throws, and the gateway keeps the list
 * it has.
 *
 * In a tree, an item whose parent is not itself listed is a root: leave
 * `parentId` out rather than naming something the list does not contain.
 */
export type FilterListProducer = (
  context: FilterListContext,
) => AsyncIterable<FilterListItem> | Iterable<FilterListItem> | Promise<Iterable<FilterListItem>>;

/** A producer for each filterable field, keyed by the field's path in the profile. */
export type FilterListProducers = Readonly<Record<string, FilterListProducer>>;

/** A list a producer returned that cannot be published as it is. */
export class FilterListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterListError";
  }
}

/**
 * Attach list producers to a source instance, one per filterable field of the
 * source's profile. Returns the same instance.
 */
export function withFilterLists<T extends SourceInstance>(
  instance: T,
  producers: FilterListProducers,
): T {
  const fields = Object.keys(producers);
  if (fields.length > FILTER_LIST_LIMITS.publicationsPerPage) {
    throw new FilterListError(
      `A source lists at most ${FILTER_LIST_LIMITS.publicationsPerPage} filterable fields, got ${fields.length}`,
    );
  }
  for (const field of fields) {
    if (field.length === 0 || field.length > FILTER_LIST_LIMITS.idLength) {
      throw new FilterListError(`"${field}" is not a usable field path for a list`);
    }
  }
  instance.filterLists = { ...producers };
  return instance;
}

/**
 * Run a producer to the end and return its list in canonical form: checked,
 * members deduplicated and sorted, items sorted by id.
 *
 * Throws {@link FilterListError} when the list breaks the contract, and
 * whatever the producer throws when it fails; either way nothing is published.
 */
export async function collectFilterList(
  producer: FilterListProducer,
  context: FilterListContext,
): Promise<FilterListItem[]> {
  const produced = await producer(context);
  const items: FilterListItem[] = [];
  const seen = new Set<string>();
  for await (const raw of produced) {
    context.signal.throwIfAborted();
    const item = canonicalItem(raw);
    if (seen.has(item.id)) throw new FilterListError(`item "${item.id}" is listed twice`);
    seen.add(item.id);
    items.push(item);
  }
  assertTree(items, seen);
  return items.sort((a, b) => compare(a.id, b.id));
}

/** sha256 of a canonical list, as the wire and the gateway spell a list's version. */
export function filterListDigest(canonicalItems: readonly FilterListItem[]): string {
  const hash = createHash("sha256");
  hash.update("omnesis-filter-list-v1\n");
  for (const item of canonicalItems) {
    hash.update(
      JSON.stringify([
        item.id,
        item.label,
        item.parentId ?? null,
        (item.members ?? []).map((member) => [member.type, member.value]),
      ]),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Cut a canonical list into the pages it is sent as. Every page stays within
 * the item and size bounds; an empty list is one empty, final page.
 */
export function splitFilterList(
  field: string,
  canonicalItems: readonly FilterListItem[],
  digest: string = filterListDigest(canonicalItems),
): FilterListPublication[] {
  const parts: FilterListItem[][] = [[]];
  let bytes = 0;
  for (const item of canonicalItems) {
    const size = Buffer.byteLength(JSON.stringify(item));
    const current = parts[parts.length - 1]!;
    if (
      current.length > 0 &&
      (current.length >= FILTER_LIST_LIMITS.itemsPerPart ||
        bytes + size > FILTER_LIST_LIMITS.partBytes - PART_OVERHEAD_BYTES)
    ) {
      parts.push([item]);
      bytes = size;
    } else {
      current.push(item);
      bytes += size;
    }
  }
  if (parts.length > FILTER_LIST_LIMITS.parts) {
    throw new FilterListError(
      `the list for "${field}" needs ${parts.length} pages, more than the ${FILTER_LIST_LIMITS.parts} a list may span`,
    );
  }
  return parts.map((items, part) => ({
    field,
    digest,
    part,
    final: part === parts.length - 1,
    items,
  }));
}

/**
 * Group list pages into the sets one sync page carries, keeping their order,
 * so no sync page exceeds the count or size a gateway accepts.
 */
export function packFilterListPages(
  publications: readonly FilterListPublication[],
): FilterListPublication[][] {
  const pages: FilterListPublication[][] = [];
  let current: FilterListPublication[] = [];
  let bytes = 0;
  for (const publication of publications) {
    const size = Buffer.byteLength(JSON.stringify(publication));
    if (
      current.length > 0 &&
      (current.length >= FILTER_LIST_LIMITS.publicationsPerPage ||
        bytes + size > FILTER_LIST_LIMITS.partBytes)
    ) {
      pages.push(current);
      current = [];
      bytes = 0;
    }
    current.push(publication);
    bytes += size;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

/** Room left in a page for its envelope: field, digest, part and final. */
const PART_OVERHEAD_BYTES = 2048;

const IDENTIFIER_TYPES: ReadonlySet<string> = new Set(FILTER_IDENTIFIER_TYPES);

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalItem(raw: FilterListItem): FilterListItem {
  if (typeof raw !== "object" || raw === null) {
    throw new FilterListError("a list item must be an object");
  }
  const { id, label, parentId, members } = raw;
  if (typeof id !== "string" || id.length === 0 || id.length > FILTER_LIST_LIMITS.idLength) {
    throw new FilterListError(
      `an item id must be a string of 1 to ${FILTER_LIST_LIMITS.idLength} characters`,
    );
  }
  if (typeof label !== "string") {
    throw new FilterListError(`item "${id}" has no label`);
  }
  if (parentId !== undefined) {
    if (
      typeof parentId !== "string" ||
      parentId.length === 0 ||
      parentId.length > FILTER_LIST_LIMITS.idLength
    ) {
      throw new FilterListError(`item "${id}" has an unusable parent id`);
    }
    if (parentId === id) throw new FilterListError(`item "${id}" names itself as its parent`);
  }
  const item: FilterListItem = {
    id,
    // A label is for display only, so an overlong one is cut rather than refused.
    label: label.slice(0, FILTER_LIST_LIMITS.labelLength),
  };
  if (parentId !== undefined) item.parentId = parentId;
  if (members !== undefined) item.members = canonicalMembers(id, members);
  return item;
}

function canonicalMembers(
  itemId: string,
  members: readonly FilterIdentifier[],
): FilterIdentifier[] {
  if (!Array.isArray(members)) {
    throw new FilterListError(`item "${itemId}" has members that are not a list`);
  }
  const byKey = new Map<string, FilterIdentifier>();
  for (const member of members) {
    if (
      typeof member !== "object" ||
      member === null ||
      !IDENTIFIER_TYPES.has(member.type) ||
      typeof member.value !== "string" ||
      member.value.length === 0 ||
      member.value.length > FILTER_LIST_LIMITS.identifierLength
    ) {
      throw new FilterListError(`item "${itemId}" has a member that is not a usable identifier`);
    }
    byKey.set(`${member.type}\n${member.value}`, { type: member.type, value: member.value });
  }
  // Dropping members would make the item match fewer people than it involves,
  // so a list over the bound is refused rather than cut.
  if (byKey.size > FILTER_LIST_LIMITS.membersPerItem) {
    throw new FilterListError(
      `item "${itemId}" has ${byKey.size} members, more than the ${FILTER_LIST_LIMITS.membersPerItem} an item may carry`,
    );
  }
  return [...byKey.values()].sort((a, b) => compare(a.type, b.type) || compare(a.value, b.value));
}

/** Every parent is listed and no item is its own ancestor. */
function assertTree(items: readonly FilterListItem[], ids: ReadonlySet<string>): void {
  const parentOf = new Map<string, string>();
  for (const item of items) {
    if (item.parentId === undefined) continue;
    if (!ids.has(item.parentId)) {
      throw new FilterListError(
        `item "${item.id}" names parent "${item.parentId}", which the list does not contain`,
      );
    }
    parentOf.set(item.id, item.parentId);
  }
  // Each item is walked towards its root once; `settled` holds the items
  // already known to reach one.
  const settled = new Set<string>();
  for (const start of parentOf.keys()) {
    const path = new Set<string>();
    let at: string | undefined = start;
    while (at !== undefined && !settled.has(at)) {
      if (path.has(at)) throw new FilterListError(`item "${at}" is its own ancestor`);
      path.add(at);
      at = parentOf.get(at);
    }
    for (const id of path) settled.add(id);
  }
}

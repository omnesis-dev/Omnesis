// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The lists collectors publish for a source's filterable fields, as the rest
 * of the gateway reaches them.
 *
 * A collector sends a list on the pages of an ordinary sync, and only when the
 * digest it computed differs from the one the gateway reports on the
 * collector's own sync-state read. The gateway never asks a collector for a
 * list. A gateway that lost its lists therefore reports no digest and is sent
 * them again on each source's next sync.
 *
 * Which list a page belongs to comes from the source's stored profile, through
 * {@link filterFieldsFor}: a field whose ids mean the same on every device has
 * one list for the account, and a field whose ids only mean something on the
 * device that produced them has one list per device. A list for a field the
 * profile does not mark as filterable is not stored.
 *
 * Storage, the atomic switch between versions and the reads live in
 * `data/repositories/SourceFilterListRepository.ts`; the reads are re-exported
 * here so enforcement and pickers depend on this module alone.
 */

import { createLogger } from "@omnesis/core";
import { sourceTypeOf, type FilterListPublication, type FilterListReceipt } from "@omnesis/types";
import {
  listFilterListDigests,
  type FilterListStagedRow,
} from "../data/repositories/SourceFilterListRepository.js";
import { filterFieldsFor, type FilterField } from "./filter-fields.js";
import type { Db } from "../data/types.js";
import type { WriteGate } from "../write-gate.js";

export {
  FILTER_LIST_MAX_DEPTH,
  getFilterListAncestors,
  getFilterListDescendants,
  getFilterListItems,
  getFilterListMembers,
  getFilterListVersion,
  listFilterListItemsByParent,
  type FilterListEntry,
  type FilterListKey,
  type FilterListVersion,
} from "../data/repositories/SourceFilterListRepository.js";

const log = createLogger("gateway").child("filter-lists");

type ReadyField = Extract<FilterField, { state: "ready" }>;

/** The filterable fields of a source this gateway can apply, keyed by path. */
function readyFields(db: Db, sourceId: string): Map<string, ReadyField> {
  const declared = filterFieldsFor(db, sourceTypeOf(sourceId));
  const ready = new Map<string, ReadyField>();
  if (declared.state !== "declared") return ready;
  for (const field of declared.fields) {
    if (field.state === "ready") ready.set(field.path, field);
  }
  return ready;
}

/**
 * The device a field's list is stored under: the stream of the publishing
 * device when the field's ids belong to a device, `''` when every device of
 * the source shares them.
 */
function filterListDeviceFor(field: ReadyField, streamId: string): string {
  return field.filter.scope === "device" ? streamId : "";
}

/**
 * The digest of each list the gateway holds for a source, as the device
 * behind `streamId` should compare its own against: keyed by field path, with
 * no entry for a list that has never been published.
 */
export function filterListDigestsFor(
  db: Db,
  sourceId: string,
  streamId: string,
): Record<string, string> {
  const digests: Record<string, string> = {};
  // Most sources publish no list; for them this is one index seek and no
  // profile is read.
  const published = listFilterListDigests(db, sourceId);
  if (published.length === 0) return digests;
  const fields = readyFields(db, sourceId);
  for (const row of published) {
    const field = fields.get(row.field);
    if (field && filterListDeviceFor(field, streamId) === row.deviceId) {
      digests[row.field] = row.digest;
    }
  }
  return digests;
}

/** Undeclared lists already reported, so a collector that keeps sending one logs once. */
const reportedUndeclared = new Set<string>();
const REPORTED_UNDECLARED_MAX = 1000;

/**
 * Store the list pages one sync page carried, in order, and say what became
 * of each.
 *
 * `holder` is false when the publishing device is a member of a source whose
 * sync lease another device holds. Such a device may publish the lists of its
 * own device, but not a list every device shares: two devices listing the same
 * account a moment apart would otherwise replace each other's list on every
 * sync.
 */
export async function publishFilterLists(
  deps: { db: Db; writeGate: Pick<WriteGate, "stageFilterListPart">; now?: () => number },
  sourceId: string,
  publications: readonly FilterListPublication[],
  authority: { streamId: string; holder: boolean },
): Promise<FilterListReceipt[]> {
  const fields = readyFields(deps.db, sourceId);
  const receipts: FilterListReceipt[] = [];
  for (const publication of publications) {
    const receipt = (outcome: FilterListReceipt["outcome"]): FilterListReceipt => ({
      field: publication.field,
      digest: publication.digest,
      part: publication.part,
      outcome,
    });
    const field = fields.get(publication.field);
    if (!field) {
      const key = `${sourceTypeOf(sourceId)}\n${publication.field}`;
      if (!reportedUndeclared.has(key)) {
        if (reportedUndeclared.size >= REPORTED_UNDECLARED_MAX) reportedUndeclared.clear();
        reportedUndeclared.add(key);
        log.warn(
          `Ignoring the list ${sourceId} published for "${publication.field}": its stored profile does not declare that field as one this gateway can filter on`,
        );
      }
      receipts.push(receipt("undeclared"));
      continue;
    }
    const deviceId = filterListDeviceFor(field, authority.streamId);
    if (deviceId === "" && !authority.holder) {
      receipts.push(receipt("not-holder"));
      continue;
    }
    const outcome = await deps.writeGate.stageFilterListPart({
      key: { sourceId, field: publication.field, deviceId },
      digest: publication.digest,
      part: publication.part,
      final: publication.final,
      rows: stagedRows(field, publication),
      now: (deps.now ?? Date.now)(),
    });
    if (outcome === "published") {
      log.info(
        `Published the list of ${sourceId} for "${publication.field}"${deviceId ? ` on device ${deviceId}` : ""}: ${publication.part + 1} page${publication.part === 0 ? "" : "s"}`,
      );
    }
    receipts.push(receipt(outcome));
  }
  return receipts;
}

/**
 * The rows a page writes, reduced to what the field's declaration gives a
 * meaning to: a parent only in a tree, members only where the field lists them.
 */
function stagedRows(field: ReadyField, publication: FilterListPublication): FilterListStagedRow[] {
  const tree = field.filter.capability === "tree";
  const listsMembers = field.filter.listsMembers === true;
  const rows: FilterListStagedRow[] = [];
  for (const item of publication.items) {
    rows.push(["item", item.id, tree ? (item.parentId ?? null) : null, item.label]);
    if (!listsMembers || !item.members) continue;
    for (const member of item.members) rows.push(["member", item.id, member.type, member.value]);
  }
  return rows;
}

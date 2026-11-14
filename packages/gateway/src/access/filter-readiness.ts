// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a filter can be created on a field of a source account, and how
 * many of the account's records such a filter would leave hidden.
 *
 * A filter on a field can be created once the account has been read in full
 * by a host new enough to write the field, and the list of what exists for
 * the field has arrived. Until then the state says what is missing, in the
 * order a person would fix it: update this gateway, update a device, wait for
 * a first read or a resync in progress, start a resync, wait for the list.
 *
 * This gate is for the editor only. What a saved filter shows never depends
 * on it: every record is checked on its own version and details at each read.
 *
 * **"Read in full at version V"** is a property of the enumerations the
 * gateway records (`source_inventories`): one whose source said it had read
 * everything, and whose lowest page version is at least V. It is required of
 * every cursor row that feeds the account: the one shared row of a source
 * hosted by one device at a time, and the row of each member device of a
 * source whose devices each keep their own.
 *
 * Reading the state is a handful of indexed rows. The count of records that
 * cannot be placed ({@link countUnmatchedRecords}) reads every record of the
 * account and belongs on a reader.
 */

import {
  hasPerDeviceCursor,
  sourceTypeOf,
  type DocumentFieldFilterSpec,
  type FilterIdentifierType,
  type FilterNoun,
  type MultiDeviceMode,
} from "@omnesis/types";
import { countDocumentsBySourceVersion } from "../data/repositories/DocumentRepository.js";
import { getSourceResyncCost } from "../data/repositories/SourceFamilyMetaRepository.js";
import {
  listSourceFullReads,
  listSourceOpenReads,
} from "../data/repositories/SourceInventoryRepository.js";
import { filterFieldsFor } from "./filter-fields.js";
import { registerFilterSqlFunctions } from "./filter-people.js";
import { FILTER_PEOPLE_FIELD, compileFieldProbe, filterVerdictSql } from "./filter-sql.js";
import { PERSON_NOUN } from "./filter-wording.js";
import type { Db } from "../data/types.js";

export interface FilterDevice {
  id: string;
  name: string;
}

export type FilterFieldState =
  /** The source declares the field with a capability this gateway does not have. */
  | { status: "gateway-behind" }
  /** A device hosting the account runs a build that does not write the field. */
  | { status: "collector-behind"; devices: FilterDevice[] }
  /**
   * A read of the whole account by a new enough host is under way, or about
   * to start on an account whose first sync has stored nothing yet.
   * `processed` counts the records at the current version; `total` counts
   * every record of the account, the size its previous full read left it at.
   * `total` is `null` on a first read: nothing has been read in full before,
   * so there is no size to compare with.
   */
  | { status: "resyncing"; processed: number; total: number | null }
  /** The account must be resynced; `cost` is the source's own sentence about what that takes. */
  | { status: "needs-resync"; cost: string | null }
  /** The account is read; the list of what exists for the field has not arrived. */
  | { status: "list-pending" }
  | { status: "ready" };

export interface FilterFieldReadiness {
  /** The field's path, or `$people`. */
  field: string;
  capability: "membership" | "tree" | "person";
  noun: FilterNoun;
  /** The first source version whose records carry the field. */
  minVersion: number;
  /** Present on a declared field. */
  declaration?: DocumentFieldFilterSpec;
  /** Present on `$people`: the identifier kinds a person can be named by. */
  identifiers?: FilterIdentifierType[];
  state: FilterFieldState;
  /** Records of the account below `minVersion`: hidden from any filter using the field. */
  tooOld: number;
}

export interface SourceFilterReadiness {
  sourceId: string;
  sourceType: string;
  /** The devices that host the account, in the order they joined. */
  devices: FilterDevice[];
  /**
   * `declared` when the source's profile can be read. Otherwise no field is
   * listed: no host has published a profile, or the one stored predates
   * filter declarations and the devices named must be updated.
   */
  profile: "declared" | "no-profile" | "collector-behind";
  fields: FilterFieldReadiness[];
}

interface SourceRow {
  type: string;
  device_id: string;
  multi_device_mode: MultiDeviceMode;
}

/** The readiness of every filterable field of an account, or `null` when the account does not exist. */
export function readSourceFilterReadiness(db: Db, sourceId: string): SourceFilterReadiness | null {
  return db.transaction((): SourceFilterReadiness | null => {
    const source = db
      .prepare<[string], SourceRow>(
        "SELECT type, device_id, multi_device_mode FROM sources WHERE id = ?",
      )
      .get(sourceId);
    if (!source) return null;
    const devices = hostingDevices(db, sourceId, source.device_id);
    const declared = filterFieldsFor(db, sourceTypeOf(sourceId));
    const readiness: SourceFilterReadiness = {
      sourceId,
      sourceType: source.type,
      devices,
      profile: declared.state,
      fields: [],
    };
    if (declared.state !== "declared") return readiness;

    // The cursor rows that feed the account, and the devices behind each.
    const perDevice = hasPerDeviceCursor(source.multi_device_mode);
    const cursorRows = perDevice ? devices.map((device) => device.id) : [""];
    const rowDevices = (cursorRow: string): FilterDevice[] =>
      cursorRow === "" ? devices : devices.filter((device) => device.id === cursorRow);
    // The version each cursor row's host reported with its last page. A row
    // can exist before any page has been committed on it — the account's
    // display details, or an error from its first sync, are stored there
    // too — and its version then reads 0 without anyone having reported it.
    // A row whose cursor was reset keeps the version its host last sent.
    const rowVersions = new Map(
      db
        .prepare<[string], { device_id: string; source_version: number }>(
          `SELECT device_id, source_version FROM sync_state
            WHERE source_id = ? AND (last_synced_at IS NOT NULL OR source_version > 0)`,
        )
        .all(sourceId)
        .map((row) => [row.device_id, row.source_version]),
    );
    const fullReads = new Map(
      listSourceFullReads(db, sourceId).map((read) => [read.cursorRow, read.minSourceVersion]),
    );
    const openReads = new Map(
      listSourceOpenReads(db, sourceId).map((read) => [read.cursorRow, read.minSourceVersion]),
    );
    const versionCounts = countDocumentsBySourceVersion(db, sourceId);
    const total = versionCounts.reduce((sum, row) => sum + row.count, 0);
    const currentVersion = Math.max(0, ...rowVersions.values());
    const published = new Set(
      db
        .prepare<[string], { field: string }>(
          "SELECT DISTINCT field FROM source_filter_lists WHERE source_id = ? AND generation > 0",
        )
        .all(sourceId)
        .map((row) => row.field),
    );
    let cost: string | null | undefined;

    const stateFor = (minVersion: number, list: string | null): FilterFieldState => {
      if (minVersion > 0) {
        // Only a version a host has reported says its build is too old. A
        // cursor row with no reported version belongs to a host whose first
        // sync has not stored a page yet: it is starting its first read.
        const behind = cursorRows
          .filter((row) => {
            const version = rowVersions.get(row);
            return version !== undefined && version < minVersion;
          })
          .flatMap(rowDevices);
        if (behind.length > 0) {
          return { status: "collector-behind", devices: uniqueDevices(behind) };
        }
        const unread = cursorRows.filter((row) => (fullReads.get(row) ?? -1) < minVersion);
        if (unread.length > 0) {
          // Every row still to be read is being read now, by a host that
          // writes the field or by one whose first sync is starting: the
          // read the field needs is under way.
          if (
            unread.every((row) => !rowVersions.has(row) || (openReads.get(row) ?? -1) >= minVersion)
          ) {
            const processed = versionCounts
              .filter((row) => row.sourceVersion >= currentVersion)
              .reduce((sum, row) => sum + row.count, 0);
            // The account's size is a total only when every row being read
            // was read in full before; a first read has nothing to compare with.
            const known = unread.every((row) => fullReads.has(row));
            return { status: "resyncing", processed, total: known ? total : null };
          }
          cost ??= getSourceResyncCost(db, source.type);
          return { status: "needs-resync", cost };
        }
      }
      if (list !== null && !published.has(list)) return { status: "list-pending" };
      return { status: "ready" };
    };
    const tooOld = (minVersion: number): number =>
      versionCounts
        .filter((row) => row.sourceVersion < minVersion)
        .reduce((sum, row) => sum + row.count, 0);

    for (const field of declared.fields) {
      if (field.state === "gateway-behind") {
        readiness.fields.push({
          field: field.path,
          capability: "membership",
          noun: { one: field.path, many: field.path },
          minVersion: 0,
          state: { status: "gateway-behind" },
          tooOld: 0,
        });
        continue;
      }
      // A declaration that breaks the contract came from a host's build;
      // nothing can be done with the field until that build changes.
      if (field.state === "invalid") continue;
      readiness.fields.push({
        field: field.path,
        capability: field.filter.capability,
        noun: field.filter.noun,
        minVersion: field.filter.minVersion,
        declaration: field.filter,
        state: stateFor(field.filter.minVersion, field.path),
        tooOld: tooOld(field.filter.minVersion),
      });
    }
    if (declared.person?.state === "ready") {
      const person = declared.person.filter;
      // People filtered through a chat's members need that chat field's
      // version and list as well as their own.
      const members =
        person.membersOf === undefined
          ? undefined
          : declared.fields.find((field) => field.path === person.membersOf);
      const membersMin = members?.state === "ready" ? members.filter.minVersion : 0;
      const minVersion = Math.max(person.minVersion, membersMin);
      readiness.fields.push({
        field: FILTER_PEOPLE_FIELD,
        capability: "person",
        noun: PERSON_NOUN,
        minVersion,
        identifiers: [...person.identifiers],
        state: stateFor(minVersion, person.membersOf ?? null),
        tooOld: tooOld(minVersion),
      });
    }
    return readiness;
  })();
}

function uniqueDevices(devices: FilterDevice[]): FilterDevice[] {
  return [...new Map(devices.map((device) => [device.id, device])).values()];
}

/** The devices that host an account: its first host, then the members in the order they joined. */
function hostingDevices(db: Db, sourceId: string, primaryDeviceId: string): FilterDevice[] {
  return db
    .prepare<[{ sourceId: string; primary: string }], FilterDevice>(
      `SELECT d.id AS id, d.name AS name
         FROM devices d
        WHERE d.revoked_at IS NULL
          AND (d.id = @primary
               OR d.id IN (SELECT device_id FROM source_devices WHERE source_id = @sourceId))
        ORDER BY d.id = @primary DESC,
                 (SELECT m.added_at FROM source_devices m
                   WHERE m.source_id = @sourceId AND m.device_id = d.id),
                 d.id`,
    )
    .all({ sourceId, primary: primaryDeviceId });
}

/**
 * How many records of an account cannot be placed for a field although they
 * are new enough to carry it: the ones a filter using the field hides as
 * "unknown". `field` is a declared path or `$people`.
 *
 * Counted with the conditions of the real check, over every record of the
 * account; run it on a reader. `null` when the field cannot be applied.
 */
export function countUnmatchedRecords(db: Db, sourceId: string, field: string): number | null {
  const compiled = compileFieldProbe(sourceId, filterFieldsFor(db, sourceTypeOf(sourceId)), field);
  if (compiled.unusable !== null) return null;
  registerFilterSqlFunctions(db);
  const verdict = filterVerdictSql(compiled, { row: "d" });
  return db
    .prepare<unknown[], { n: number }>(
      `SELECT count(*) AS n FROM documents d WHERE d.source_id = ? AND (${verdict.sql}) = 'U'`,
    )
    .get(sourceId, ...verdict.params)!.n;
}

/** The name a sentence calls an account by: its source's name, else the account's. */
export function filterSourceName(db: Db, sourceId: string, sourceType: string): string {
  const row = db
    .prepare<[string, string], { family: string | null; account: string | null }>(
      `SELECT (SELECT label FROM source_family_meta WHERE source_type = ?) AS family,
              (SELECT label FROM sync_state WHERE source_id = ? AND label IS NOT NULL
                ORDER BY device_id LIMIT 1) AS account`,
    )
    .get(sourceType, sourceId);
  return row?.family?.trim() || row?.account?.trim() || sourceType;
}

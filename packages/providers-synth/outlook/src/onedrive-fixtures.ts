// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic OneDrive backend.
 *
 * Rather than re-implement the OneDrive sync (which would let fixture semantics
 * drift from production), the twin feeds canned Microsoft Graph `driveItem`
 * delta pages + file content into the REAL `OneDriveSource` via an injected
 * `GraphClientLike`. The real source still walks `/me/drive/root/delta`,
 * normalizes `driveItem`→`DocumentInput`, downloads bytes through the same
 * `getBytes` path, routes binaries through the shared attachment extractor, and
 * runs the bounded re-walk on a 410 — so the synth path exercises the
 * production delta machine, normalizer, keying, deletion handling, and
 * cursor-recovery code unchanged. Only the network is replaced.
 *
 * The fixtures are an array of files loaded from the active universe
 * (`sources/onedrive/items.json`). All ids, names, and content are invented.
 *
 * Two env switches let an E2E drive the incremental + recovery paths against a
 * single running gateway, mutating the synthetic drive between sync ticks:
 *
 * - `OMNESIS_ONEDRIVE_SYNTH_DELETE=<externalId>[,<externalId>…]` — those files
 *   are gone from the drive and the next delta tick reports them removed (the
 *   `deleted` facet), proving end-to-end deletion. A list, so a later phase can
 *   keep an earlier phase's deletion in force while adding its own.
 * - `OMNESIS_ONEDRIVE_SYNTH_EXPIRE_DELTA=1` — the next deltaLink fetch throws a
 *   410 `DeltaExpiredError`, forcing the bounded re-walk. The re-walk then
 *   re-enumerates the full (post-deletion) drive metadata; with
 *   `OMNESIS_ONEDRIVE_SYNTH_REWALK_CHANGE=<externalId>` one file's content is
 *   bumped so the re-walk re-extracts exactly that file and nothing else.
 */

import {
  resolvePerson,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";
import { DeltaExpiredError } from "@omnesis/provider-outlook";
import type { DriveDeltaResponse, DriveItem, GraphClientLike } from "@omnesis/provider-outlook";

/** One synthetic OneDrive file as authored in the universe fixture. */
export interface OneDriveItemEntry {
  externalId: string;
  name: string;
  mimeType: string;
  size: number;
  eTag: string;
  webUrl: string;
  folderPath: string;
  createdAt: string;
  modifiedAt: string;
  content: string;
  /** A cast person ref whose resolved email owns/shared the file, or null. */
  sharedBy: string | null;
}

let cached: OneDriveItemEntry[] | null = null;

export function loadOneDriveItems(): OneDriveItemEntry[] {
  if (cached) return cached;
  cached = loadSourceFixtureJson<OneDriveItemEntry[]>(
    loadActiveUniverse(),
    "onedrive",
    "items.json",
  );
  return cached;
}

/** Reset the per-process fixture cache (test-only). */
export function resetOneDriveFixtureCache(): void {
  cached = null;
}

/**
 * The suffix `OMNESIS_ONEDRIVE_SYNTH_REWALK_CHANGE` appends to a file's eTag and
 * content, so an E2E can assert the exact post-bump body rather than a string
 * the unbumped fixture already contains.
 */
export const REWALK_BUMP = "-v2";

/**
 * Build a Graph `driveItem` from a fixture entry. `contentSuffix` (used by the
 * re-walk-change override) bumps the eTag + content so the source's fingerprint
 * detects a change and re-downloads exactly that file.
 */
function toDriveItem(e: OneDriveItemEntry, bumped: boolean): DriveItem {
  const item: DriveItem = {
    id: e.externalId,
    name: e.name,
    webUrl: e.webUrl,
    size: e.size,
    eTag: bumped ? `${e.eTag}${REWALK_BUMP}` : e.eTag,
    createdDateTime: e.createdAt,
    lastModifiedDateTime: e.modifiedAt,
    file: { mimeType: e.mimeType },
    parentReference: { driveId: "drive-synth", path: `/drive/root:${e.folderPath}` },
  };
  if (e.sharedBy) {
    const resolved = resolvePerson(e.sharedBy);
    const email = resolved.emails[0];
    if (email) {
      item.shared = { sharedBy: { user: { displayName: resolved.name, email } } };
    }
  }
  return item;
}

function deletedItem(externalId: string): DriveItem {
  return { id: externalId, deleted: { state: "deleted" } };
}

/** The externalIds the DELETE switch currently removes from the drive. */
function deletedIds(): string[] {
  return (process.env.OMNESIS_ONEDRIVE_SYNTH_DELETE ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Marker the synth delta-link carries so the fake recognizes an incremental tick. */
const DELTA_TOKEN = "synth-onedrive-delta";

/**
 * A fixture-backed `GraphClientLike`. Serves one bootstrap page enumerating
 * every file (then a deltaLink), empty incremental ticks by default, and honors
 * the env switches that mutate the drive between ticks.
 */
export function syntheticOneDriveGraph(items: OneDriveItemEntry[]): GraphClientLike {
  function contentBumped(externalId: string): boolean {
    return process.env.OMNESIS_ONEDRIVE_SYNTH_REWALK_CHANGE === externalId;
  }

  function liveItems(): OneDriveItemEntry[] {
    const deleted = new Set(deletedIds());
    return items.filter((i) => !deleted.has(i.externalId));
  }

  function bootstrapPage(): DriveDeltaResponse {
    return {
      value: liveItems().map((e) => toDriveItem(e, contentBumped(e.externalId))),
      "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/drive/root/delta?token=${DELTA_TOKEN}`,
    };
  }

  function incrementalPage(): DriveDeltaResponse {
    // An incremental tick reports only what changed since the last delta. The
    // `DELETE` switch surfaces a tombstone; otherwise the tick is empty (no
    // duplicate re-emission — proves idempotency end-to-end).
    const value: DriveItem[] = deletedIds().map(deletedItem);
    return {
      value,
      "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/drive/root/delta?token=${DELTA_TOKEN}`,
    };
  }

  return {
    async get<T>(path: string): Promise<T> {
      const isDeltaLink = path.includes(DELTA_TOKEN);
      if (isDeltaLink) {
        // The persisted deltaLink — an incremental tick or a forced 410.
        if (process.env.OMNESIS_ONEDRIVE_SYNTH_EXPIRE_DELTA === "1") {
          throw new DeltaExpiredError();
        }
        return incrementalPage() as T;
      }
      // The bootstrap root `/me/drive/root/delta` (no token) AND the fresh
      // enumeration the bounded re-walk issues after a 410 both land here —
      // both want the full current drive.
      return bootstrapPage() as T;
    },

    async getBytes(path: string): Promise<Uint8Array> {
      // path: /me/drive/items/{externalId}/content
      const match = path.match(/\/me\/drive\/items\/([^/]+)\/content/);
      const externalId = match?.[1];
      const entry = items.find((i) => i.externalId === externalId);
      if (!entry) return new Uint8Array(0);
      const text = contentBumped(entry.externalId)
        ? `${entry.content}${REWALK_BUMP}`
        : entry.content;
      return new TextEncoder().encode(text);
    },
  };
}

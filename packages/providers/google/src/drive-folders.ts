// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The folders of a Google Drive account as a filter sees them.
 *
 * A file record carries the ids of the folders it sits in directly, under
 * {@link DRIVE_FOLDERS_FIELD}. The names and the tree live here: the list an
 * account publishes of every folder it can see and the folder each sits in.
 * Its roots are My Drive, each shared drive, and any folder whose own parent
 * the account cannot see (a folder someone shared on its own).
 */

import { SyncError, type FilterListItem } from "@omnesis/types";
import { googleApiStatus } from "./api-error.js";
import type { drive_v3 } from "googleapis";

/** Profile path of the ids of the folders a file sits in directly. */
export const DRIVE_FOLDERS_FIELD = "extra.folderIds";

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

/** Folders asked for per listing page; Drive may return fewer. */
const DRIVE_FOLDER_PAGE_SIZE = 1000;
/** Shared drives asked for per listing page, the most Drive allows. */
const DRIVE_SHARED_DRIVE_PAGE_SIZE = 100;

/**
 * The folders a file sits in directly. Every file request names `parents`, so
 * a file Drive returns none for sits in no folder the account can see — one
 * shared on its own — and that is an empty list, not an unknown.
 */
export function driveParentIds(file: Pick<drive_v3.Schema$File, "parents">): string[] {
  return [...new Set((file.parents ?? []).filter((id) => typeof id === "string" && id.length > 0))];
}

/** What the listing found, before it is shaped into a tree. */
export interface DriveFolderListing {
  /** My Drive's root folder; absent for an account that has none. */
  root?: { id: string; name?: string | null };
  sharedDrives: ReadonlyArray<{ id: string; name?: string | null }>;
  folders: ReadonlyArray<Pick<drive_v3.Schema$File, "id" | "name" | "parents">>;
}

/**
 * The folder tree of an account. A folder is placed under the first of its
 * parents that is itself listed; one with no listed parent is a root.
 */
export function driveFolderItems(listing: DriveFolderListing): FilterListItem[] {
  const nodes = new Map<string, { label: string; parents: string[] }>();
  if (listing.root) {
    nodes.set(listing.root.id, { label: listing.root.name || "My Drive", parents: [] });
  }
  for (const drive of listing.sharedDrives) {
    if (!nodes.has(drive.id)) nodes.set(drive.id, { label: drive.name || drive.id, parents: [] });
  }
  for (const folder of listing.folders) {
    if (!folder.id || nodes.has(folder.id)) continue;
    nodes.set(folder.id, { label: folder.name || folder.id, parents: driveParentIds(folder) });
  }
  return [...nodes].map(([id, node]) => {
    const parentId = node.parents.find((parent) => parent !== id && nodes.has(parent));
    return { id, label: node.label, ...(parentId === undefined ? {} : { parentId }) };
  });
}

/**
 * List every folder the account can see, with My Drive and the shared drives
 * as roots. The cost grows with the number of folders and shared drives, never
 * with the number of files: one request for My Drive's root, one per
 * {@link DRIVE_SHARED_DRIVE_PAGE_SIZE} shared drives, and one per page of
 * folders. The folders are listed over the same corpus the file walk lists,
 * so a folder is here whenever a file the source indexes names it.
 *
 * Throws when any request fails or Drive says a page is incomplete: a list
 * with folders missing would read as those folders no longer existing.
 */
export async function listDriveFolders(
  drive: drive_v3.Drive,
  signal: AbortSignal,
): Promise<FilterListItem[]> {
  const rootRes = await drive.files
    .get({ fileId: "root", fields: "id,name", supportsAllDrives: true }, { signal })
    .catch((error: unknown) => {
      // An account with no My Drive of its own.
      if (googleApiStatus(error) === 404) return null;
      throw error;
    });
  const root = rootRes?.data.id ? { id: rootRes.data.id, name: rootRes.data.name } : undefined;

  const sharedDrives: Array<{ id: string; name?: string | null }> = [];
  let drivesPageToken: string | undefined;
  do {
    signal.throwIfAborted();
    const res = await drive.drives.list(
      {
        pageSize: DRIVE_SHARED_DRIVE_PAGE_SIZE,
        pageToken: drivesPageToken,
        fields: "nextPageToken,drives(id,name)",
      },
      { signal },
    );
    for (const shared of res.data.drives ?? []) {
      if (shared.id) sharedDrives.push({ id: shared.id, name: shared.name });
    }
    drivesPageToken = res.data.nextPageToken ?? undefined;
  } while (drivesPageToken);

  const folders: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    signal.throwIfAborted();
    const res = await drive.files.list(
      {
        q: `mimeType = '${DRIVE_FOLDER_MIME}' and trashed = false`,
        pageSize: DRIVE_FOLDER_PAGE_SIZE,
        pageToken,
        fields: "nextPageToken,incompleteSearch,files(id,name,parents)",
        spaces: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      },
      { signal },
    );
    if (res.data.incompleteSearch) {
      throw new SyncError("transient", "Drive returned an incomplete list of folders.");
    }
    folders.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return driveFolderItems({ ...(root ? { root } : {}), sharedDrives, folders });
}

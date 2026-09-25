// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Sync cursor for Chrome Bookmarks source.
 * Uses the file's checksum to detect changes.
 */
export interface ChromeBookmarksCursor {
  fileChecksum: string;
  /** Set of known externalIds for deletion detection */
  knownIds: string[];
  [key: string]: unknown;
}

/**
 * Raw bookmark entry from Chrome's Bookmarks JSON file.
 */
export interface ChromeBookmarkEntry {
  name: string;
  url?: string;
  date_added: string;
  date_last_used?: string;
  date_modified?: string;
  id: string;
  guid?: string;
  type: "url" | "folder";
  children?: ChromeBookmarkEntry[];
  meta_info?: Record<string, string>;
}

/**
 * Top-level structure of Chrome's Bookmarks JSON file.
 */
export interface ChromeBookmarksFile {
  checksum: string;
  roots: {
    bookmark_bar: ChromeBookmarkEntry;
    other: ChromeBookmarkEntry;
    synced: ChromeBookmarkEntry;
  };
  version: number;
}

/**
 * Flattened bookmark with resolved folder path.
 */
export interface FlatBookmark {
  title: string;
  url: string;
  dateAdded: Date;
  dateLastUsed: Date | null;
  folderPath: string;
  guid: string | undefined;
}

/**
 * Chrome profile info from Local State file.
 */
export interface ChromeProfileInfo {
  dir: string;
  name: string;
  email: string | undefined;
}

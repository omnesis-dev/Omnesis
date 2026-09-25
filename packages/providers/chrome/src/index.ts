// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger, toErrorMessage } from "@omnesis/core";
import {
  defineSource,
  probeFileReadAccess,
  syncPage,
  config as configSchema,
  SnapshotEnumeration,
} from "@omnesis/source-sdk";
import { chromeBookmarksIconUrl } from "./icons.js";
import { normalizeBookmark, bookmarkWebpageEdge, chromeTimestampToDate } from "./normalizer.js";
import { chromeBookmarksStateSpec } from "./state.js";
import type { SourceInstance } from "@omnesis/source-sdk";
import type { EdgeDeclaration } from "@omnesis/core";
import type {
  ChromeBookmarksCursor,
  ChromeBookmarkEntry,
  ChromeBookmarksFile,
  ChromeProfileInfo,
  FlatBookmark,
} from "./types.js";

export { normalizeBookmark, bookmarkWebpageEdge, chromeTimestampToDate } from "./normalizer.js";

const log = createLogger("source:chrome-bookmarks");

function getChromeBaseDir(): string | null {
  switch (process.platform) {
    case "darwin":
      return join(process.env.HOME ?? "~", "Library", "Application Support", "Google", "Chrome");
    case "linux":
      return join(process.env.HOME ?? "~", ".config", "google-chrome");
    case "win32": {
      const appData = process.env.LOCALAPPDATA ?? process.env.APPDATA;
      if (!appData) return null;
      return join(appData, "Google", "Chrome", "User Data");
    }
    default:
      return null;
  }
}

/**
 * Discover Chrome profiles from the Local State file.
 */
export function discoverProfiles(basePath: string): ChromeProfileInfo[] {
  const localStatePath = join(basePath, "Local State");
  if (!existsSync(localStatePath)) return [];

  try {
    const localState = JSON.parse(readFileSync(localStatePath, "utf-8"));
    const infoCache = localState?.profile?.info_cache;
    if (!infoCache || typeof infoCache !== "object") return [];

    return Object.entries(infoCache).map(([dir, info]: [string, unknown]) => {
      const profileInfo = info as Record<string, string>;
      const email = profileInfo.user_name || undefined;
      return {
        dir,
        name: email || profileInfo.name || dir,
        email,
      };
    });
  } catch (err) {
    log.debug(`Failed to read Chrome Local State: ${toErrorMessage(err)}`);
    return [];
  }
}

/**
 * Read and parse a Chrome Bookmarks JSON file.
 */
export function readBookmarksFile(filePath: string): ChromeBookmarksFile | null {
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as ChromeBookmarksFile;
  } catch (err) {
    log.warn(`Failed to parse Chrome bookmarks file ${filePath}: ${toErrorMessage(err)}`);
    return null;
  }
}

/**
 * Recursively flatten a Chrome bookmark tree into a flat list.
 */
function flattenBookmarks(node: ChromeBookmarkEntry, path = ""): FlatBookmark[] {
  // A readable JSON file is not necessarily a complete bookmark tree. Never
  // turn malformed folders or URL entries into evidence that bookmarks vanished.
  if (
    !node ||
    (node.type !== "folder" && node.type !== "url") ||
    (node.type === "folder" && !Array.isArray(node.children)) ||
    (node.type === "url" && (typeof node.url !== "string" || node.url.length === 0))
  ) {
    throw new Error("Invalid Chrome bookmark tree; withholding reconciliation");
  }
  const results: FlatBookmark[] = [];
  const currentPath = path ? `${path} / ${node.name}` : node.name;

  if (node.type === "url" && node.url) {
    const dateAdded = chromeTimestampToDate(node.date_added);
    const dateLastUsed =
      node.date_last_used && node.date_last_used !== "0"
        ? chromeTimestampToDate(node.date_last_used)
        : null;

    results.push({
      title: node.name,
      url: node.url,
      dateAdded,
      dateLastUsed,
      folderPath: path,
      guid: node.guid,
    });
  }

  if (node.children) {
    for (const child of node.children) {
      results.push(...flattenBookmarks(child, currentPath));
    }
  }

  return results;
}

export default defineSource({
  id: "chrome-bookmarks",
  name: "Chrome Bookmarks",
  description: "Bookmarks from Google Chrome",
  provider: { id: "chrome", name: "Google Chrome" },
  authType: "local",
  unitName: "bookmarks",
  contract: {
    // The host resolves the stored cursor against this before `sync` runs,
    // so an unrecognised value is refused as unreadable rather than read as
    // "no bookmarks yet".
    state: chromeBookmarksStateSpec,
    requires: ["state-envelope"],
  },
  icon: {
    sfSymbol: "bookmark.fill",
    color: "#4285F4",
    bgColor: "#16213A",
    url: chromeBookmarksIconUrl,
  },
  // Bookmarks are a referential URL bag — let the gateway skip `url`
  // edges through them in graph subgraph walks.
  urlHub: true,
  // A bookmark's sourceUrl is the resource it refers to, not the identity of
  // an alternate representation. It must never claim inbound URL edges or
  // receive `same-resource` identity links.
  urlTargetRole: "reference",
  // Deliberately exclusive. Two local Chrome profiles may be independent,
  // partially synced, or delayed replicas of one Google account. Partitioning
  // duplicates synced URLs, while replication can let an incomplete profile
  // delete device-local bookmarks. A future mode must first identify the
  // synced profile authoritatively and define its deletion contract.

  config: configSchema.object({
    basePath: configSchema.path({
      label: "Chrome user-data folder",
      // Member-scoped: it names a folder on one machine, and a second machine
      // hosting this source has Chrome's data in its own place.
      scope: "member",
      // Not a setup question. The folder is in a standard location per
      // platform, and this exists for an operator whose Chrome is not in it.
      advanced: true,
      mustExist: "directory",
      help: "Leave blank to use this machine's standard Chrome location",
    }),
    profileDir: configSchema.string({
      label: "Profile folder",
      scope: "member",
      advanced: true,
      help: "Leave blank to pick the profile whose signed-in user matches the account",
    }),
  }),

  async discover() {
    const chromeBaseDir = getChromeBaseDir();
    if (!chromeBaseDir) return [];
    const profiles = discoverProfiles(chromeBaseDir);
    return profiles.map((p) => p.email ?? p.name);
  },

  async create({
    sourceId,
    providerId,
    accountId,
    dataCutoff,
    config,
  }): Promise<SourceInstance<ChromeBookmarksCursor>> {
    // Resolve the bookmarks file path. Without this, every Chrome profile's
    // source instance silently read `<base>/Default/Bookmarks` regardless of
    // accountId — Profile 1..N got the Default profile's bookmarks under the
    // wrong account-id (cross-profile data confusion + silent data loss).
    //
    // Resolution order: an explicitly configured profile folder wins
    // (operator override / migration aid); otherwise look up the profile whose
    // user_name matches the accountId; final fallback is Default with a
    // warning so the misconfiguration is at least visible in logs.
    const basePath = config?.basePath ?? getChromeBaseDir();
    let profileDir = config?.profileDir;
    if (!profileDir && basePath) {
      const profiles = discoverProfiles(basePath);
      const matched = profiles.find((p) => p.email === accountId || p.name === accountId);
      if (matched) {
        profileDir = matched.dir;
      } else if (profiles.length > 0) {
        log.warn(`No Chrome profile matched accountId '${accountId}', falling back to Default`);
      }
    }
    profileDir = profileDir ?? "Default";
    const bookmarksPath = basePath ? join(basePath, profileDir, "Bookmarks") : null;
    const withheldPage = (cursor: ChromeBookmarksCursor | null) => {
      const issue = new SnapshotEnumeration(["bookmarks"])
        .gap("bookmarks", "the configured bookmark file is unavailable or unreadable")
        .withheldIssue();
      return {
        ...syncPage([], cursor ?? { fileChecksum: "", knownIds: [] }),
        issues: issue ? [issue] : undefined,
      };
    };

    return {
      async probeReadAccess(options) {
        return bookmarksPath
          ? probeFileReadAccess(bookmarksPath, options)
          : { status: "unavailable" };
      },
      watchPaths: bookmarksPath && existsSync(bookmarksPath) ? [bookmarksPath] : [],

      async sync(cursor) {
        if (!bookmarksPath) {
          return withheldPage(cursor);
        }

        const bookmarksFile = readBookmarksFile(bookmarksPath);
        if (!bookmarksFile) {
          return withheldPage(cursor);
        }

        // Flatten all bookmarks
        const flatBookmarks = [
          ...flattenBookmarks(bookmarksFile.roots.bookmark_bar),
          ...flattenBookmarks(bookmarksFile.roots.other),
          ...flattenBookmarks(bookmarksFile.roots.synced),
        ];

        // File mtime — passed to normalizeBookmark as the sourceUpdatedAt
        // floor so renames/moves (which Chrome doesn't timestamp per-
        // bookmark) at least bump the doc's update time when the file is
        // rewritten.
        let fileMtime: Date | undefined;
        try {
          fileMtime = statSync(bookmarksPath).mtime;
        } catch {
          /* ignore — sourceUpdatedAt falls back to dateAdded */
        }

        // Filter by data cutoff if configured
        const cutoffDate = dataCutoff ? new Date(dataCutoff) : null;

        // Group bookmarks by URL so the same page filed in multiple
        // folders becomes one document carrying every folder as a tag,
        // rather than the previous silent dedup which dropped all but
        // the last instance and lost folder context.
        const byUrl = new Map<
          string,
          { primary: (typeof flatBookmarks)[number]; folderPaths: string[] }
        >();
        for (const bookmark of flatBookmarks) {
          if (cutoffDate && bookmark.dateAdded < cutoffDate) continue;
          const entry = byUrl.get(bookmark.url);
          if (entry) {
            if (bookmark.folderPath) entry.folderPaths.push(bookmark.folderPath);
            // Keep the earliest dateAdded as the canonical creation time
            // — the user filed it once and re-filed; the original date
            // is the more honest signal.
            if (bookmark.dateAdded < entry.primary.dateAdded) entry.primary = bookmark;
          } else {
            byUrl.set(bookmark.url, {
              primary: bookmark,
              folderPaths: bookmark.folderPath ? [bookmark.folderPath] : [],
            });
          }
        }

        const presentExternalIds = [...byUrl.keys()];
        // Re-read presence even when content is unchanged: a lost cursor may
        // leave old documents that no longer appear in the tombstone diff.
        if (
          cursor?.fileChecksum &&
          cursor.fileChecksum === bookmarksFile.checksum &&
          cursor.knownIds.length === byUrl.size &&
          cursor.knownIds.every((id) => byUrl.has(id))
        ) {
          return syncPage([], cursor, { presentExternalIds, issues: [] });
        }

        const documents = [];
        const edges: EdgeDeclaration[] = [];
        const currentIds = new Set<string>();

        for (const { primary, folderPaths } of byUrl.values()) {
          currentIds.add(primary.url);
          const doc = normalizeBookmark(primary, providerId, sourceId, fileMtime, folderPaths);
          documents.push(doc);
          // Each bookmark declares a `bookmark → webpage` edge: the
          // bookmark stays its own document and joins the canonical `web` page
          // it points at, resolving now or via `pending_edges` once the
          // extension captures the page.
          edges.push(bookmarkWebpageEdge(primary));
        }

        // Detect deletions
        const previousIds = new Set(cursor?.knownIds ?? []);
        const deletedExternalIds: string[] = [];
        for (const id of previousIds) {
          if (!currentIds.has(id)) {
            deletedExternalIds.push(id);
          }
        }

        const newCursor: ChromeBookmarksCursor = {
          fileChecksum: bookmarksFile.checksum,
          knownIds: [...currentIds],
        };

        log.info(`Sync produced ${documents.length} docs, -${deletedExternalIds.length}`);

        return syncPage(documents, newCursor, {
          deletedExternalIds,
          presentExternalIds,
          edges,
          issues: [],
        });
      },
    };
  },
});

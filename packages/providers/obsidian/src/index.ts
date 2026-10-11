// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import picomatch from "picomatch";
import { createLogger, computeContentHash } from "@omnesis/core";
import {
  defineSource,
  probeTreeReadAccess,
  syncPage,
  SnapshotEnumeration,
  config as configSchema,
  expandHostPath,
  type SourceInstance,
  type SyncProgress,
} from "@omnesis/source-sdk";
import { SyncError, type DocumentInput } from "@omnesis/types";
import { obsidianIconUrl } from "./icons.js";
import { OBSIDIAN_STATE_VERSION, obsidianStateSpec } from "./state.js";
import {
  parseFrontmatter,
  stripFrontmatter,
  extractInlineTags,
  extractWikilinks,
  OBSIDIAN_RENDER_VERSION,
  mergeTags,
  normalizeNote,
  frontmatterStableId,
} from "./normalizer.js";
import type { ObsidianSyncCursor, ObsidianFileState, ParsedNote } from "./types.js";

const log = createLogger("source:obsidian-notes");

const PAGE_SIZE = 200;

/** Default directories to skip */
const DEFAULT_SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

interface FileEntry {
  relativePath: string;
  absolutePath: string;
  mtime: number;
  ctime: number;
  size: number;
  inode: number;
  device: number;
}

// The cursor type is pinned on `create`'s return rather than as a type
// argument to `defineSource`. TypeScript infers all type arguments or none,
// so naming the cursor here would silently default the configuration schema's
// type and hand `create` an untyped bag — the exact thing declaring a schema
// is meant to remove.
export default defineSource({
  id: "obsidian-notes",
  name: "Obsidian Notes",
  description: "Notes from your Obsidian vault",
  provider: { id: "obsidian", name: "Obsidian" },
  authType: "local",
  resolveAccountId(params, existing) {
    const vaultPath = params.vaultPath;
    if (!vaultPath) throw new Error("Vault path is required to resolve its identity");
    const canonical = realpathSync(expandHostPath(vaultPath));
    // A configured source keeps its original id, including legacy basename ids.
    for (const account of existing) {
      const configuredPath = account.params?.vaultPath;
      if (!configuredPath) continue;
      let configuredCanonical: string;
      try {
        configuredCanonical = realpathSync(expandHostPath(configuredPath));
      } catch {
        configuredCanonical = expandHostPath(configuredPath);
      }
      if (configuredCanonical === canonical) return account.accountId;
    }
    // The suffix distinguishes same-named vaults on this host.
    const suffix = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
    const label = basename(canonical)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 80);
    return `${label || "vault"}-${suffix}`;
  },
  unitName: "notes",
  contract: {
    // The host resolves the stored bookmark against this before `sync` runs,
    // so the sync below only ever receives the current shape.
    state: obsidianStateSpec,
    // Declared because the migration chain is what carries an install off the
    // path-keyed shape. A host without envelope support would hand the raw
    // stored value to a decoder that rejects it, which reads as a first run.
    requires: ["state-envelope"],
  },
  icon: { sfSymbol: "doc.text", color: "#7C3AED", bgColor: "#1F1734", url: obsidianIconUrl },
  config: configSchema.object({
    vaultPath: configSchema.path({
      label: "Vault path",
      // Member-scoped: it names a folder on one machine. A second machine
      // hosting this vault — a laptop syncing the same notes through iCloud or
      // Obsidian Sync — keeps it somewhere of its own, and a shared value
      // would hand that machine a path it cannot open.
      scope: "member",
      required: true,
      placeholder: "/path/to/vault",
      mustExist: "directory",
      // A vault is a folder Obsidian has opened at least once, and the only
      // durable evidence of that is the settings directory it writes. Pointing
      // the source at an ordinary folder of Markdown would sync, which is what
      // makes the distinction worth stating: it would sync the wrong thing.
      mustContain: ".obsidian",
      containsHint: "Not an Obsidian vault: that folder has no .obsidian directory",
    }),
    exclude: configSchema.list(configSchema.string({ label: "Glob pattern" }), {
      label: "Exclude",
      help: "Vault-relative glob patterns to skip, one per line",
      // Vault-relative, so it describes the notes rather than the machine and
      // stays shared across every host of this vault.
      // Not a setup question. An operator adding a vault does not yet know
      // which parts of it they want to leave out, and the answer only becomes
      // obvious after a first sync.
      advanced: true,
      default: [],
    }),
  }),

  async create({
    sourceId,
    providerId,
    dataCutoff,
    config,
  }): Promise<SourceInstance<ObsidianSyncCursor>> {
    // Widened back to a plain string after the guard: the narrowing a guard
    // produces does not reach the nested walkers below, which close over it.
    const configuredVault = config?.vaultPath;
    if (!configuredVault) throw new Error("vaultPath is required for Obsidian source");
    const vaultPath: string = configuredVault;

    const vaultName = basename(vaultPath);
    const canonicalVaultPath = realpathSync(vaultPath);
    const isInsideVault = (path: string): boolean => {
      const fromVault = relative(canonicalVaultPath, path);
      return fromVault !== ".." && !fromVault.startsWith(`..${sep}`) && !isAbsolute(fromVault);
    };
    const excludeMatchers = (config?.exclude ?? []).map((p) => picomatch(p));

    function isExcluded(relPath: string): boolean {
      return excludeMatchers.some((m) => m(relPath));
    }

    /**
     * Raise a vault root that will not read as the typed error it owes the
     * collector, so a revoked permission or a dropped mount is reported
     * rather than mistaken for an empty vault.
     */
    function vaultReadError(err: unknown, dir: string): SyncError {
      const code = (err as { code?: unknown } | null)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === "EACCES" || code === "EPERM") {
        return new SyncError(
          "permission",
          `Cannot read the Obsidian vault at ${dir}: ${msg}. Grant read access to this folder, or move the vault somewhere the collector can read.`,
        );
      }
      return new SyncError("unknown", `Cannot read the Obsidian vault at ${dir}: ${msg}`);
    }

    /**
     * Walk a directory recursively, following symlinked subdirectories
     * with cycle detection. `Dirent.isDirectory()` is false for a symlink
     * to a directory, so symlinks are resolved with `statSync` and each
     * walked `realpath` is remembered, which keeps symlinked folders in the
     * walk without looping on a cyclic layout.
     *
     * A symlink to a file is skipped wherever it points, as hard links are.
     * One inside the vault is a second path to a note the walk reaches at
     * its real path, and a second path would be a second document under the
     * note's identity (inode or frontmatter id), a page the gateway refuses.
     *
     * A nested directory going unreadable mid-walk (a permission change on
     * one subfolder, a submount dropping) is recorded rather than ignored.
     * The walk continues over the rest of the vault, but every note under
     * that directory is now missing from the result, and a missing note is
     * indistinguishable from a deleted one: it would be tombstoned, and a
     * tombstone deletes on the spot rather than earning a deadline in the
     * gateway's absence ledger. So the gap travels with the walk and the
     * deletion pass retains notes under that gap while reconciling readable
     * siblings normally.
     *
     * The vault root is different: nothing this cycle would represent the
     * vault, and reading that as "found nothing" is indistinguishable
     * downstream from the vault having gone empty. Only the root call sets
     * `isRoot`, and it throws rather than returning a gap, because there is
     * no partial answer to give. */
    function walkDir(
      dir: string,
      files: FileEntry[],
      visited: Set<string>,
      unreadable: string[],
      isRoot = false,
    ): void {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        if (isRoot) throw vaultReadError(err, dir);
        unreadable.push(relative(vaultPath, dir) || dir);
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith(".") && DEFAULT_SKIP_DIRS.has(entry.name)) {
          continue;
        }

        const fullPath = join(dir, entry.name);
        const relPath = relative(vaultPath, fullPath);

        // For symlinks, fall through to the resolved-target stat; for
        // regular entries the `Dirent` flags are authoritative.
        let isDir = entry.isDirectory();
        const isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            const resolvedTarget = realpathSync(fullPath);
            if (!isInsideVault(resolvedTarget)) {
              log.debug(`Skipping symlink outside vault: ${relPath}`);
              continue;
            }
            isDir = statSync(resolvedTarget).isDirectory();
            if (!isDir) {
              log.debug(`Skipping file symlink inside the vault: ${relPath}`);
              continue;
            }
          } catch (err) {
            log.debug(
              `Skipping unresolvable symlink ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
            // A symlink that stops resolving is a gap, not a skip. This is the
            // submount case: the link is still in the listing, everything it
            // pointed at is absent from the walk, and absence is how this
            // source detects deletion. `readdirSync` never runs for it, so
            // without this the walk looks complete.
            unreadable.push(relPath || fullPath);
            continue;
          }
        }

        if (isDir) {
          if (DEFAULT_SKIP_DIRS.has(entry.name)) continue;
          if (isExcluded(relPath)) continue;
          // Cycle-guard via realpath: if two paths resolve to the same
          // inode we only want to walk one of them. Use the resolved
          // path so symlinks pointing at already-visited directories
          // are recognised.
          let resolved: string;
          try {
            resolved = realpathSync(fullPath);
          } catch {
            resolved = fullPath;
          }
          if (visited.has(resolved)) {
            log.debug(`Skipping symlink cycle at ${relPath} → ${resolved}`);
            continue;
          }
          visited.add(resolved);
          walkDir(fullPath, files, visited, unreadable);
        } else if (isFile && entry.name.endsWith(".md")) {
          if (isExcluded(relPath)) continue;
          try {
            const resolvedPath = realpathSync(fullPath);
            if (!isInsideVault(resolvedPath)) {
              log.debug(`Skipping note outside vault: ${relPath}`);
              continue;
            }
            const stat = statSync(resolvedPath);
            if (stat.nlink !== 1) {
              log.debug(`Skipping hard-linked note: ${relPath}`);
              continue;
            }
            files.push({
              relativePath: relPath,
              absolutePath: resolvedPath,
              mtime: stat.mtimeMs,
              ctime: stat.ctimeMs,
              size: stat.size,
              // `ino` is 0 on Windows for some volumes. Identity resolution
              // treats a taken `inode:<n>` as unavailable, so notes sharing
              // that 0 fall back to a path-derived identity instead of
              // colliding.
              inode: stat.ino,
              device: stat.dev,
            });
          } catch {
            // A note that will not stat is missing from the walk for the same
            // reason a folder that will not open is, and costs the same thing:
            // it would be read as deleted. One file rather than a subtree, and
            // that path is retained just the same.
            unreadable.push(relPath || fullPath);
          }
        }
      }
    }

    /** The vault's notes, and any directory the walk could not open. */
    interface VaultWalk {
      files: FileEntry[];
      unreadable: string[];
    }

    function walkVault(): VaultWalk {
      const files: FileEntry[] = [];
      const unreadable: string[] = [];
      const visited = new Set<string>();
      try {
        visited.add(realpathSync(vaultPath));
      } catch {
        visited.add(vaultPath);
      }
      walkDir(vaultPath, files, visited, unreadable, true);
      return { files, unreadable };
    }

    interface ReadNoteResult {
      note: Omit<ParsedNote, "stableId">;
      contentHash: string;
    }

    function readNote(file: FileEntry): ReadNoteResult {
      const fd = openSync(file.absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let rawContent: string;
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.dev !== file.device ||
          stat.ino !== file.inode ||
          stat.size !== file.size ||
          stat.mtimeMs !== file.mtime ||
          stat.ctimeMs !== file.ctime
        ) {
          throw new Error("Obsidian note changed after discovery");
        }
        rawContent = readFileSync(fd, "utf-8");
      } finally {
        closeSync(fd);
      }
      const frontmatter = parseFrontmatter(rawContent);
      const content = stripFrontmatter(rawContent);
      const inlineTags = extractInlineTags(content);
      const tags = mergeTags(frontmatter, inlineTags);
      const links = extractWikilinks(content);
      const title = basename(file.relativePath, ".md");

      return {
        note: {
          relativePath: file.relativePath,
          title,
          content,
          rawContent,
          frontmatter,
          tags,
          links,
          ctime: file.ctime,
          mtime: file.mtime,
        },
        contentHash: computeContentHash(content),
      };
    }

    /**
     * Resolve a stable identity for a note in priority order:
     *   1. `frontmatter.id` / `uid` / `uuid` if present and non-empty.
     *   2. A stableId from a just-disappeared previous file with matching
     *      `(size, contentHash)` — the path moved, content didn't change.
     *      The matched previous path is removed from `disappearedByHash`
     *      so a second new file with the same content can't claim the
     *      same stableId twice.
     *   3. A previous entry with the same inode that disappeared this
     *      cycle (rename + edit case where the content hash differs).
     *   4. `inode:<n>` for newly-discovered notes.
     *   5. `path:<relativePath>` when even that inode is taken: a volume
     *      reporting every inode as 0, or a frontmatter id spelled like one.
     *
     * A candidate another note present in this walk already holds is passed
     * over, whatever step produced it: two live notes under one externalId
     * is a page the gateway refuses, and a refused page blocks the whole
     * vault. A duplicated note repeating its original's frontmatter id is
     * the usual way this happens; it is tracked by its inode instead, as a
     * note of its own. A note that moved holds its own identity before any
     * note is read (see `heldStableIds` in `sync`), so a duplicate read first
     * cannot take it.
     */
    function resolveStableId(
      frontmatter: Record<string, unknown> | null,
      contentHash: string,
      file: FileEntry,
      disappearedByHash: Map<string, ObsidianFileState[]>,
      disappearedByInode: Map<number, ObsidianFileState>,
      heldStableIds: Map<string, string>,
    ): string {
      const available = (stableId: string): boolean => {
        const holder = heldStableIds.get(stableId);
        return holder === undefined || holder === file.relativePath;
      };

      const fmId = frontmatterStableId(frontmatter);
      if (fmId) {
        const holder = heldStableIds.get(fmId);
        if (holder === undefined || holder === file.relativePath) return fmId;
        log.warn(
          `Frontmatter id "${fmId}" in ${file.relativePath} already identifies ${holder}; tracking ${file.relativePath} by its inode instead`,
        );
      }

      const candidates = disappearedByHash.get(contentHash);
      if (candidates) {
        const idx = candidates.findIndex((c) => c.size === file.size && available(c.stableId));
        if (idx !== -1) {
          const matched = candidates.splice(idx, 1)[0]!;
          if (candidates.length === 0) disappearedByHash.delete(contentHash);
          return matched.stableId;
        }
      }

      const inodeMatch = file.inode > 0 ? disappearedByInode.get(file.inode) : undefined;
      if (inodeMatch && available(inodeMatch.stableId)) {
        disappearedByInode.delete(file.inode);
        return inodeMatch.stableId;
      }

      const inodeId = `inode:${file.inode}`;
      return available(inodeId) ? inodeId : `path:${file.relativePath}`;
    }

    return {
      probeReadAccess: ({ signal }) =>
        probeTreeReadAccess({
          signal,
          roots: [{ path: canonicalVaultPath }],
          fileExtensions: [".md"],
          exclude: (path, directory) =>
            isExcluded(path) || (directory && DEFAULT_SKIP_DIRS.has(basename(path))),
        }),
      watchPaths: [vaultPath],
      watchDirectoryPaths: [vaultPath],
      watchFileExtensions: [".md"],

      async sync(cursor) {
        // Always the current shape: the state declaration resolved and, where
        // needed, migrated the stored value before this ran.
        const previousFileMap: Record<string, ObsidianFileState> = cursor?.fileMap ?? {};
        const isBootstrap = !cursor;

        // Old path-shaped externalIds left by the re-key, pinned across pages
        // so the gateway sees the full set on the final page
        // (`hasMore: false`). A vault that never held the earlier shape has
        // none and the list stays empty.
        const accumulatedMigrationDeletes: string[] = cursor?.pendingMigrationDeletes ?? [];

        // Walk vault and collect all .md files
        const walk = walkVault();
        // Unknown paths protect their own previous entries. Readable siblings
        // still provide deletion and rename evidence.
        let withholding = walk.unreadable.length > 0;
        const unreadablePath = (path: string): boolean =>
          walk.unreadable.some((gap) => path === gap || path.startsWith(gap + sep));
        let allFiles = walk.files;

        // Filter by data cutoff (mtime) if configured
        if (dataCutoff) {
          const cutoffMs = new Date(dataCutoff).getTime();
          allFiles = allFiles.filter((f) => f.mtime >= cutoffMs);
        }

        const totalFiles = allFiles.length;

        // Sort by mtime for consistent ordering
        allFiles.sort((a, b) => a.mtime - b.mtime);

        // Determine which files need processing (changed or new). Track
        // current paths so we can detect deletions in the same pass.
        const filesToProcess: FileEntry[] = [];
        const currentPaths = new Set<string>();

        for (const file of allFiles) {
          currentPaths.add(file.relativePath);
          const prev = previousFileMap[file.relativePath];
          // A note last emitted under an older render is re-read even though
          // it has not changed: the document it would produce now differs
          // from the one the gateway holds.
          if (
            !prev ||
            prev.mtime !== file.mtime ||
            prev.renderVersion !== OBSIDIAN_RENDER_VERSION
          ) {
            filesToProcess.push(file);
          }
        }

        // Build the rename-candidate maps from previous entries whose
        // paths are no longer present. `disappearedByHash` lets us match
        // unchanged-content moves; `disappearedByInode` catches
        // rename-and-edit (content hash differs but inode is the same).
        const disappearedByHash = new Map<string, ObsidianFileState[]>();
        const disappearedByInode = new Map<number, ObsidianFileState>();
        const disappearedPaths: string[] = [];
        for (const [path, state] of Object.entries(previousFileMap)) {
          if (currentPaths.has(path)) continue;
          if (unreadablePath(path)) continue;
          disappearedPaths.push(path);
          // A note missing because the walk could not reach it is not a rename
          // candidate. Offering it as one lets a new note elsewhere adopt its
          // identity, and then the original comes back under a different one —
          // two live notes disagreeing about who they are.
          const list = disappearedByHash.get(state.contentHash);
          if (list) list.push(state);
          else disappearedByHash.set(state.contentHash, [state]);
          if (state.inode > 0) disappearedByInode.set(state.inode, state);
        }

        // Paginate: process up to PAGE_SIZE files
        const batch = filesToProcess.slice(0, PAGE_SIZE);
        const hasMore = filesToProcess.length > PAGE_SIZE;

        // Read and normalize files in this batch
        const documents: DocumentInput[] = [];
        const newFileMap: Record<string, ObsidianFileState> = { ...previousFileMap };

        // Remove disappeared paths from the new map. Renamed entries
        // will be re-added below at their new path with the same
        // stableId (so the externalId carries through unchanged).
        //
        // Keep disappearance evidence until the final page. Earlier pages
        // may still discover the destination of a rename.
        if (!hasMore) {
          for (const deleted of disappearedPaths) {
            delete newFileMap[deleted];
          }
        }

        // Track which previous stableIds were claimed by a rename so we
        // don't emit them as deletions on the final page.
        const claimedStableIds = new Set<string>();

        // Identities held by live notes, by the path holding each: notes
        // present in this walk, and notes retained under an unreadable gap,
        // which are still indexed. Entries carried across pages for paths that
        // disappeared this cycle hold nothing: they are rename evidence.
        const heldStableIds = new Map<string, string>();
        for (const [path, state] of Object.entries(newFileMap)) {
          if (currentPaths.has(path) || unreadablePath(path)) {
            heldStableIds.set(state.stableId, path);
          }
        }
        // A disappeared note whose inode now sits at a new path moved there,
        // and its identity is held for that path before any note is read.
        // Otherwise a copy of it with the same frontmatter id, read first or
        // on an earlier page, would take the identity and leave the moved note
        // a stranger to its own history. Only the inode distinguishes a move
        // from a copy; matching content does not.
        const newPathByInode = new Map<number, string>();
        for (const file of allFiles) {
          if (file.inode > 0 && !previousFileMap[file.relativePath]) {
            newPathByInode.set(file.inode, file.relativePath);
          }
        }
        for (const state of disappearedByInode.values()) {
          const movedTo = newPathByInode.get(state.inode);
          if (movedTo) heldStableIds.set(state.stableId, movedTo);
        }

        // Identities a note at a tracked path stopped using this cycle. The
        // document under each is settled on the final page like a disappeared
        // path's: deleted unless another live note holds it by then.
        const supersededStableIds: string[] = cursor?.supersededStableIds ?? [];

        for (const file of batch) {
          try {
            const { note, contentHash } = readNote(file);

            const stableId = resolveStableId(
              note.frontmatter,
              contentHash,
              file,
              disappearedByHash,
              disappearedByInode,
              heldStableIds,
            );
            heldStableIds.set(stableId, file.relativePath);

            const prevAtThisPath = previousFileMap[file.relativePath];
            if (prevAtThisPath && prevAtThisPath.stableId !== stableId) {
              supersededStableIds.push(prevAtThisPath.stableId);
            }

            // Mark this stableId as claimed so genuine deletions at the
            // end of the cycle don't include it. We also have to walk
            // disappearedPaths so a path-stableId we just adopted via
            // rename-detection isn't flagged as deleted.
            claimedStableIds.add(stableId);

            const fileState: ObsidianFileState = {
              mtime: file.mtime,
              contentHash,
              size: file.size,
              inode: file.inode,
              stableId,
              renderVersion: OBSIDIAN_RENDER_VERSION,
            };

            // Check if content actually changed (mtime may change without
            // content change — e.g. `touch` or a folder-move that bumps
            // mtime). If hash + stableId both match, no doc emit needed.
            if (
              prevAtThisPath &&
              prevAtThisPath.contentHash === contentHash &&
              prevAtThisPath.stableId === stableId &&
              prevAtThisPath.renderVersion === OBSIDIAN_RENDER_VERSION
            ) {
              newFileMap[file.relativePath] = fileState;
              continue;
            }

            const doc = normalizeNote(
              { ...note, stableId },
              providerId,
              sourceId,
              vaultName,
              vaultPath,
            );
            documents.push(doc);
            newFileMap[file.relativePath] = fileState;
          } catch (err) {
            // A legacy path ID must survive until its replacement was read.
            // Discovery alone does not establish that the re-key completed.
            withholding = true;
            log.warn(
              `Failed to read note ${file.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Genuine deletions — disappeared-path entries whose stableId was
        // not claimed by any new path on the final page of this cycle.
        // Anything claimed earlier in the cycle is still in
        // `claimedStableIds` because the cursor-thread carries the new
        // map across pages.
        // Paths under unreadable entries never entered disappearedPaths, so
        // their IDs remain untouched while readable siblings reconcile.
        const realDeletions: string[] = [];
        if (!hasMore && walk.unreadable.length > 0) {
          log.warn(
            `Deletion detection incomplete: ${walk.unreadable.length} path(s) could not be read (${walk.unreadable.slice(0, 3).join(", ")}${
              walk.unreadable.length > 3 ? ", …" : ""
            }). Notes under them are kept until those paths read cleanly.`,
          );
        }
        if (!hasMore) {
          const candidates = new Set([
            ...disappearedPaths.map((path) => previousFileMap[path]!.stableId),
            ...supersededStableIds,
          ]);
          for (const stableId of candidates) {
            if (claimedStableIds.has(stableId)) continue;
            // Also skip if the same stableId is still tracked at another
            // current path in newFileMap (rename detected on an earlier page).
            const stillTracked = Object.values(newFileMap).some((s) => s.stableId === stableId);
            if (stillTracked) continue;
            realDeletions.push(stableId);
          }
        }

        // Per-cycle progress: `total` is the queue size for THIS sync
        // (files needing processing right now), not the whole vault.
        // Pinned in the cursor on the first page of a cycle and carried
        // through subsequent pages so the bar's `total` stays stable. The
        // collector overwrites `processed`/`percentComplete` with its
        // cumulative-this-cycle counters; we still fill them in for any
        // direct consumer.
        const cycleTotal = cursor?.cycleQueueTotal ?? filesToProcess.length;

        const updatedCursor: ObsidianSyncCursor = {
          version: OBSIDIAN_STATE_VERSION,
          fileMap: newFileMap,
          cycleQueueTotal: hasMore ? cycleTotal : undefined,
          supersededStableIds:
            hasMore && supersededStableIds.length > 0 ? supersededStableIds : undefined,
          // Carried while the cycle continues, and also when the walk was
          // incomplete: the deletes were withheld rather than issued, so they
          // have to survive until a clean walk can pair each tombstone with
          // the re-keyed note that replaces it.
          pendingMigrationDeletes:
            (hasMore || withholding) && accumulatedMigrationDeletes.length > 0
              ? accumulatedMigrationDeletes
              : undefined,
        };

        const progress: SyncProgress | undefined =
          cycleTotal > 0
            ? {
                phase: isBootstrap ? "bootstrap" : "incremental",
                total: cycleTotal,
                processed: documents.length,
                percentComplete: Math.round((documents.length / cycleTotal) * 100),
              }
            : undefined;

        // Migration deletes are withheld on an incomplete walk for a sharper
        // reason than the absence-derived ones. A re-key tombstones a note's
        // old identity and re-emits it under the new one from the same walk —
        // so if the walk missed the note, the tombstone lands and the
        // replacement never does, and the note is gone rather than merely
        // undetected. They are carried forward on the cursor and reissued once
        // the vault reads cleanly.
        const finalDeletions = hasMore
          ? []
          : [...(withholding ? [] : accumulatedMigrationDeletes), ...realDeletions];

        log.info(
          `Sync page: ${documents.length} docs, -${finalDeletions.length}, ${documents.length}/${cycleTotal} queue (vault: ${totalFiles}, hasMore: ${hasMore})`,
        );

        return syncPage(documents, updatedCursor, {
          hasMore,
          deletedExternalIds: finalDeletions,
          progress,
          issues: hasMore
            ? undefined
            : withholding
              ? [
                  new SnapshotEnumeration(["vault"])
                    .gap(
                      "vault",
                      "some note paths could not be read; their previous identities are retained",
                    )
                    .withheldIssue()!,
                ]
              : [],
        });
      },
    };
  },
});

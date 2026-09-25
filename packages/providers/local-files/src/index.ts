// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import {
  createLogger,
  computeContentHash,
  resolveAttachmentConfig,
  shouldExtractAttachment,
  type AttachmentExtractionConfig,
} from "@omnesis/core";
import {
  defineSource,
  probeTreeReadAccess,
  syncPage,
  SnapshotEnumeration,
  config as configSchema,
  type SourceInstance,
  type SyncProgress,
} from "@omnesis/source-sdk";
import { type DocumentInput } from "@omnesis/types";
import {
  ALLOWED_EXTENSIONS,
  icloudPlaceholderTarget,
  isIcloudPlaceholder,
  MAX_DIRECT_TEXT_BYTES,
  MAX_INDEXED_FILES,
  MAX_SCAN_DEPTH,
  MAX_SCAN_ENTRIES,
  MIN_FILE_BYTES,
  classifyFile,
  isRefusedPath,
  subtreePruneReason,
} from "./policy.js";
import { normalizeFile } from "./normalizer.js";
import { localFilesIconDataUri } from "./icons.js";
import { localFilesDocumentEventProfile } from "./document-event-profile.js";
import { localFilesStateSpec } from "./state.js";
import { SKIP_RETRY_MS } from "./types.js";
import type { LocalFileEntry, LocalFileState, LocalFilesSyncCursor } from "./types.js";

const log = createLogger("source:local-files");

const CURSOR_VERSION = 1;
/**
 * Binary extraction is the expensive path (extract, embed, link, resolve
 * people per document on a single-threaded writer), so pages stay small and
 * the first full scan is a background project measured in hours, not a sync
 * that must complete.
 */
const PAGE_SIZE = 50;

/** MIME types routed through the extraction pipeline (everything allow-listed but plain text). */
const EXTRACT_MIME_TYPES = Object.values(ALLOWED_EXTENSIONS).filter(
  (m) => !["text/plain", "text/markdown", "text/csv", "application/json"].includes(m),
);

function displayPath(absolutePath: string): string {
  const home = homedir();
  return absolutePath === home || absolutePath.startsWith(home + sep)
    ? `~${sep}${relative(home, absolutePath)}`.split(sep).join("/")
    : absolutePath;
}

/**
 * Refusal reason when a root is itself a repo or vault, null otherwise. A
 * root pointed at one would index nothing — the walk prunes those subtrees
 * — so callers refuse it with the reason instead of a silently empty
 * source. No walk-up: a folder inside a repo the operator names explicitly
 * is their choice. Both the literal path and its target are checked so a
 * symlinked root into a repo cannot slip past validation only to prune to
 * empty at walk time.
 */
function repoOrVaultRefusal(path: string, label: string): string | null {
  const candidates = new Set([path]);
  try {
    candidates.add(realpathSync(path));
  } catch {
    // Unresolvable here: the existence check reports it, not this one.
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, ".git"))) {
      return `Directory is a git repository, which Local Files never indexes: ${label}`;
    }
    if (existsSync(join(candidate, ".obsidian"))) {
      return `Directory is an Obsidian vault, indexed by the Obsidian source instead: ${label}`;
    }
  }
  return null;
}

interface ScanResult {
  files: LocalFileEntry[];
  /**
   * Absolute paths of files that are present but were not indexed this cycle:
   * iCloud placeholders, and anything the walk could not read for a reason
   * that is not the operator asking for it to be left out. Never emitted,
   * never treated as gone.
   */
  placeholders: string[];
  /**
   * Why each root the scan could not read in full stopped short, by root.
   *
   * Attributed rather than pooled into one flag, because "the external drive
   * holding one root is unmounted" and "the whole disk is unreadable" are
   * different facts and only the second one should stop this source noticing
   * that a file in an unaffected folder was deleted.
   */
  gaps: Map<string, string>;
  stats: { skipped: Record<string, number>; unreadable: number };
}

interface WalkState {
  files: LocalFileEntry[];
  placeholders: string[];
  /**
   * Files the walk saw but did not index, for a reason that says nothing
   * about whether they should stay in the corpus.
   *
   * Kept apart from the deliberate exclusions: an operator who excludes a
   * folder means those documents to go, while a file that was momentarily
   * unstattable, gained a hard link, or was caught mid-rewrite is simply
   * there. Both look identical to a scan that only records what it indexed,
   * and under a snapshot the difference is whether the document survives.
   */
  presentButUnread: string[];
  entries: number;
  /**
   * Why the root currently being walked stopped short. Set once and read as
   * the signal to unwind that root's recursion; cleared before the next root.
   */
  rootFailure?: string;
  /**
   * A ceiling that applies to the scan as a whole rather than to one root.
   *
   * The entry and file counters are shared, so whichever root is being walked
   * when one runs out is not the root at fault. Once this is set no remaining
   * root can be vouched for either, since the walk stops before reaching them.
   */
  ceiling?: string;
  skipped: Record<string, number>;
  unreadable: number;
  /** Resolved absolute paths already collected (symlink alias dedupe). */
  seen: Set<string>;
}

function countSkip(state: WalkState, reason: string): void {
  state.skipped[reason] = (state.skipped[reason] ?? 0) + 1;
}

/**
 * Walk one root, collecting allow-listed files. Symlinked subdirectories are
 * followed with cycle detection but must resolve inside a declared root;
 * symlinked files resolving outside are refused. Every early exit that hides
 * part of the tree marks the scan incomplete so no deletions are asserted.
 */
function walkDir(
  dir: string,
  root: string,
  depth: number,
  visited: Set<string>,
  isInside: (path: string) => string | null,
  isExcluded: (relToCwd: string) => boolean,
  state: WalkState,
): void {
  if (state.rootFailure || state.ceiling) return;
  if (depth > MAX_SCAN_DEPTH) {
    state.rootFailure = `Max depth ${MAX_SCAN_DEPTH} exceeded under ${displayPath(dir)}`;
    return;
  }
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    state.unreadable += 1;
    state.rootFailure = `Unreadable directory ${displayPath(dir)}`;
    return;
  }
  // Policy prune, not an error: the scan stays complete, so pruned files
  // simply read as disappeared and previously indexed ones are cleaned up
  // by the cautious-deletion path.
  const pruneReason = subtreePruneReason(dirents.map((d) => d.name));
  if (pruneReason) {
    countSkip(state, pruneReason);
    return;
  }

  for (const entry of dirents) {
    if (state.rootFailure || state.ceiling) return;
    state.entries += 1;
    if (state.entries > MAX_SCAN_ENTRIES) {
      state.ceiling = `Scan entry ceiling ${MAX_SCAN_ENTRIES} hit`;
      return;
    }
    if (state.files.length >= MAX_INDEXED_FILES) {
      state.ceiling = `File ceiling ${MAX_INDEXED_FILES} hit`;
      return;
    }

    const fullPath = join(dir, entry.name);
    // Root-relative, slash-separated: the policy and the exclude globs both
    // read this shape.
    const relPath = relative(root, fullPath).split(sep).join("/");

    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      let resolvedTarget: string;
      try {
        resolvedTarget = realpathSync(fullPath);
      } catch {
        countSkip(state, "dangling-symlink");
        continue;
      }
      if (!isInside(resolvedTarget)) {
        countSkip(state, "symlink-outside-root");
        continue;
      }
      try {
        const target = statSync(resolvedTarget);
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        countSkip(state, "dangling-symlink");
        continue;
      }
    }

    if (isDir) {
      if (isRefusedPath(relPath)) {
        countSkip(state, "refused-dir");
        continue;
      }
      if (isExcluded(relPath)) {
        countSkip(state, "excluded");
        continue;
      }
      let resolved: string;
      try {
        resolved = realpathSync(fullPath);
      } catch {
        countSkip(state, "dangling-symlink");
        continue;
      }
      if (visited.has(resolved)) {
        countSkip(state, "symlink-cycle");
        continue;
      }
      visited.add(resolved);
      walkDir(fullPath, root, depth + 1, visited, isInside, isExcluded, state);
    } else if (isFile) {
      // Ahead of every refusal below, because an evicted iCloud file is a
      // hidden file by construction and `isRefusedPath` refuses hidden files.
      // Reaching this only after that gate meant no placeholder was ever
      // recognised, and an evicted file read as a deleted one.
      if (isIcloudPlaceholder(entry.name)) {
        try {
          // Recorded under the name the file has when its bytes come back,
          // which is the name everything this source stored is keyed on.
          state.placeholders.push(join(realpathSync(dir), icloudPlaceholderTarget(entry.name)));
        } catch {
          countSkip(state, "dangling-symlink");
        }
        continue;
      }
      if (isRefusedPath(relPath)) {
        countSkip(state, "refused");
        continue;
      }
      if (isExcluded(relPath)) {
        countSkip(state, "excluded");
        continue;
      }
      const verdict = classifyFile(entry.name);
      if (verdict.kind === "skip") {
        countSkip(state, verdict.reason);
        continue;
      }
      let resolvedPath: string;
      try {
        resolvedPath = realpathSync(fullPath);
      } catch {
        countSkip(state, "dangling-symlink");
        continue;
      }
      if (!isInside(resolvedPath)) {
        countSkip(state, "symlink-outside-root");
        continue;
      }
      let stat;
      try {
        stat = statSync(resolvedPath);
      } catch {
        // There, and momentarily unreadable — a permission that changed, an
        // I/O error. Carried as present so a transient failure cannot be
        // mistaken for the file being gone.
        state.presentButUnread.push(resolvedPath);
        countSkip(state, "unstatable");
        continue;
      }
      if (stat.nlink !== 1) {
        // A second name appeared for a file this source may already have
        // indexed — a backup tool, an `ln`. The file itself is untouched.
        state.presentButUnread.push(resolvedPath);
        countSkip(state, "hardlink");
        continue;
      }
      if (state.seen.has(resolvedPath)) {
        // Same bytes reachable twice (symlink alias inside the roots):
        // indexing both would emit two documents with one stableId and the
        // gateway rejects the page. First path wins.
        countSkip(state, "duplicate-path");
        continue;
      }
      state.seen.add(resolvedPath);
      if (stat.size < MIN_FILE_BYTES) {
        // Truncated to nothing rather than removed — a file being rewritten,
        // a download in flight. It is on the disk, so it is not a deletion.
        state.presentButUnread.push(resolvedPath);
        countSkip(state, "empty");
        continue;
      }
      const dirRel = relative(root, dir).split(sep).join("/");
      state.files.push({
        absolutePath: resolvedPath,
        displayPath: displayPath(resolvedPath),
        dirSegments: dirRel === "" ? [] : dirRel.split("/"),
        mimeType: verdict.mimeType,
        via: verdict.via,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
        size: stat.size,
        inode: stat.ino,
        device: stat.dev,
      });
    }
  }
}

/** Which canonical root contains `path`, or null when none does. */
function createContainmentChecker(roots: string[]): (path: string) => string | null {
  return (path: string): string | null => {
    for (const root of roots) {
      const rel = relative(root, path);
      if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return root;
    }
    return null;
  };
}

/**
 * Stable identity ladder, mirroring Obsidian minus frontmatter: a
 * just-vanished file with a matching `(rawHash, size)` is a pure move (the
 * bytes didn't change — the rendered content hash can't be used here because
 * it embeds the display path); a matching inode is a rename-plus-edit; a new
 * inode at a path whose old inode is gone from the scan is the same file saved
 * the way most editors save — a temporary file renamed over the original —
 * and keeps the identity the path had; otherwise a fresh `ino:<dev>:<ino>`.
 */
function resolveStableId(
  rawHash: string,
  inode: number,
  device: number,
  size: number,
  disappearedByHash: Map<string, LocalFileState[]>,
  disappearedByInode: Map<string, LocalFileState>,
  replaced: LocalFileState | undefined,
): string {
  const candidates = disappearedByHash.get(rawHash);
  if (candidates) {
    const idx = candidates.findIndex((c) => c.size === size);
    if (idx !== -1) {
      const matched = candidates.splice(idx, 1)[0]!;
      if (candidates.length === 0) disappearedByHash.delete(rawHash);
      return matched.stableId;
    }
  }
  if (inode > 0) {
    const inodeMatch = disappearedByInode.get(`${device}:${inode}`);
    if (inodeMatch) {
      disappearedByInode.delete(`${device}:${inode}`);
      return inodeMatch.stableId;
    }
  }
  if (replaced) return replaced.stableId;
  return `ino:${device}:${inode}`;
}

/** Read bytes with TOCTOU guards: the file must be unchanged since discovery. */
function readFileBytes(file: LocalFileEntry): Uint8Array {
  const fd = openSync(file.absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== file.device ||
      stat.ino !== file.inode ||
      stat.size !== file.size ||
      stat.mtimeMs !== file.mtime
    ) {
      throw new Error(`Local file changed after discovery: ${file.displayPath}`);
    }
    const buf = readFileSync(fd);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } finally {
    closeSync(fd);
  }
}

export default defineSource({
  id: "local-files",
  name: "Local Files",
  description: "Files on this machine — your documents, joined to what arrived by mail and cloud",
  provider: { id: "local-files", name: "Local Files" },
  authType: "local",
  unitName: "files",
  // Not yet battle-tested (relevance at volume is unsolved): hidden from the
  // Add-source picker until the operator opts in with OMNESIS_EXPERIMENTAL=1.
  experimental: true,
  singleInstance: true,
  // Pinned at creation: each machine observes a genuinely distinct stream,
  // the union is the truth, and identical paths on two machines are two
  // different files. Ship partitioned — never replicated, which would let
  // two machines overwrite and delete each other's rows.
  multiDevice: { mode: "partitioned" },
  supportedPlatforms: ["darwin", "linux"],
  // Deliberately under-weighted until relevance is proven against a real
  // corpus: the disk must not swamp every search result on day one.
  defaultSourcePrior: -0.15,
  defaultSyncInterval: "60m",
  documentEventProfile: localFilesDocumentEventProfile,
  icon: {
    sfSymbol: "folder",
    color: "#64748B",
    bgColor: "#1E293B",
    imageDataUri: localFilesIconDataUri,
  },
  contract: {
    // Checked once by the host before `sync` runs, rather than re-derived on
    // every page for the lifetime of the install.
    state: localFilesStateSpec,
    apiVersion: 2,
    requires: ["snapshot-sessions"],
  },
  config: configSchema.object({
    roots: configSchema.list(
      configSchema.path({
        label: "Folder",
        mustExist: "directory",
        // Refused while the operator is still looking at the field. Naming a
        // repository or a vault here is not a small mistake: the walk prunes
        // both, so the source would be configured, valid, and permanently
        // empty — which reads as a bug rather than a refusal.
        check: (value, probe) => repoOrVaultRefusal(probe.resolve(value), value.trim()),
      }),
      {
        label: "Folders to index",
        help: "One folder per line",
        // Member-scoped: these name directories on one machine, and a second
        // machine hosting this source indexes its own disk, not this one's.
        scope: "member",
        required: true,
        placeholder: "~/Documents",
      },
    ),
    exclude: configSchema.list(configSchema.string({ label: "Glob pattern" }), {
      separator: "newline",
      label: "Exclude",
      help: "Glob patterns to skip, relative to a folder, one per line",
      // Not a setup question: which parts of a folder are worth leaving out
      // only becomes clear after seeing what a first sync brought in.
      advanced: true,
      scope: "member",
      default: [],
    }),
  }),

  async create({
    sourceId,
    providerId,
    dataCutoff,
    config,
    sourceConfig,
    host,
  }): Promise<SourceInstance<LocalFilesSyncCursor>> {
    // The host expands a tilde and makes a relative path absolute, and it has
    // already confirmed each one is a directory. It does not canonicalise, and
    // every file this source sees has been through `realpathSync` — so a
    // trailing slash, a `.` segment, or a folder that is itself a symlink
    // would leave the two sides of every path comparison below in different
    // spellings of the same place. Canonicalising here, once, is what makes
    // "is this file in that folder?" answerable at all.
    const roots = [
      ...new Set(
        (config?.roots ?? []).map((root) => {
          try {
            return realpathSync(root);
          } catch {
            // Unreachable in practice — the host checked the folder exists —
            // but a folder that vanished between the check and here must not
            // take the source down with it. The scan reports it as a gap.
            return resolve(root);
          }
        }),
      ),
    ];
    if (roots.length === 0) throw new Error("roots is required for the Local Files source");
    for (const root of roots) {
      // The host has already confirmed the folder exists. This is the check no
      // declarative constraint expresses: a folder that became a repository
      // since it was configured would prune to nothing and read as an empty
      // source rather than a refused one.
      const refusal = repoOrVaultRefusal(root, root);
      if (refusal) throw new Error(refusal);
    }
    const isInside = createContainmentChecker(roots);
    const excludeMatchers = (config?.exclude ?? [])
      .filter((p) => p.length > 0)
      .map((p) => picomatch(p));
    const isExcluded = (relPath: string): boolean => excludeMatchers.some((m) => m(relPath));
    const extractAttachment = host?.extractAttachment;

    const attachmentConfig: AttachmentExtractionConfig = resolveAttachmentConfig(
      sourceConfig as
        | {
            extractAttachments?: boolean;
            attachmentMaxSizeBytes?: number;
            attachmentTypes?: string[];
            attachmentMaxTextLength?: number;
          }
        | undefined,
      // Extraction is the point of this source; images stay out (the
      // screenshot carve-out ships separately) and audio stays out (this is
      // a document source, not a conversation).
      { defaultEnabled: true, includeAudioTypes: false },
    );
    // Constrain the pipeline to what the allow-list admits. An explicit
    // per-source `attachmentTypes` still wins (the operator opted in).
    const explicitTypes = (sourceConfig as { attachmentTypes?: unknown } | undefined)
      ?.attachmentTypes;
    if (!explicitTypes) {
      attachmentConfig.allowedTypes = EXTRACT_MIME_TYPES;
    }

    /**
     * Which configured folder a path belongs to.
     *
     * The longest match wins, so a folder nested inside another names itself
     * rather than its parent — the two are separate claims, and a file has to
     * be in exactly one of them or the same document would be vouched for
     * twice.
     */
    const rootOf = (absolutePath: string): string | null => {
      let best: string | null = null;
      for (const root of roots) {
        if (absolutePath !== root && !absolutePath.startsWith(root + sep)) continue;
        if (best === null || root.length > best.length) best = root;
      }
      return best;
    };
    // Keep existing short keys stable. Deep paths cannot fit the wire's key
    // limit, and use a deterministic identity instead of truncating collisions.
    const partitionOf = (root: string): string =>
      root.length <= 256 ? root : `root:${computeContentHash(root)}`;

    function scanRoots(): ScanResult {
      const state: WalkState = {
        files: [],
        placeholders: [],
        presentButUnread: [],
        entries: 0,
        skipped: {},
        unreadable: 0,
        seen: new Set<string>(),
      };
      const gaps = new Map<string, string>();
      for (const root of roots) {
        // Per root: the set exists to stop a walk looping on a symlink cycle
        // within one tree. Sharing it across roots makes a directory the
        // previous root already descended into read as a cycle in this one —
        // silently skipped rather than reported, which for a folder nested
        // inside another means its whole subtree vanishes from the claim.
        // Files reachable from two roots are deduped by `state.seen`.
        const visited = new Set<string>();
        if (state.ceiling) {
          // Not walked at all, so nothing about it is known this cycle.
          gaps.set(root, state.ceiling);
          continue;
        }
        state.rootFailure = undefined;
        try {
          visited.add(realpathSync(root));
        } catch {
          gaps.set(root, `Root unreadable: ${displayPath(root)}`);
          continue;
        }
        walkDir(root, root, 0, visited, isInside, isExcluded, state);
        const failure = state.rootFailure ?? state.ceiling;
        if (failure) gaps.set(root, failure);
      }
      return {
        files: state.files,
        placeholders: [...state.placeholders, ...state.presentButUnread],
        gaps,
        stats: { skipped: state.skipped, unreadable: state.unreadable },
      };
    }

    return {
      probeReadAccess: ({ signal }) =>
        probeTreeReadAccess({
          signal,
          roots: roots.map((path) => ({ path })),
          fileExtensions: Object.keys(ALLOWED_EXTENSIONS).map((e) => `.${e}`),
          exclude: (path) => isExcluded(path) || isRefusedPath(path),
        }),
      watchPaths: roots,
      watchDirectoryPaths: roots,
      watchFileExtensions: Object.keys(ALLOWED_EXTENSIONS).map((e) => `.${e}`),

      async sync(cursor) {
        const isV1Cursor = cursor?.version === CURSOR_VERSION;
        const previousFileMap: Record<string, LocalFileState> =
          isV1Cursor && cursor ? cursor.fileMap : {};
        const isBootstrap = !cursor;

        const scan = scanRoots();
        // The cutoff decides what is worth reading. It does not decide what is
        // on the disk, so it is applied to the queue and not to the scan: a
        // file whose mtime moved below the window — restored from a backup,
        // unzipped over, touched — is still present, and dropping it from the
        // enumeration would ask for the deletion of a document that is fine.
        const allFiles = [...scan.files].sort((a, b) => a.mtime - b.mtime);
        const cutoffMs = dataCutoff ? new Date(dataCutoff).getTime() : null;

        const nowMs = Date.now();
        const filesToProcess: LocalFileEntry[] = [];
        for (const file of allFiles) {
          const prev = previousFileMap[file.absolutePath];
          const needsPartition =
            prev !== undefined &&
            !prev.skipped &&
            prev.partitionKey !== partitionOf(rootOf(file.absolutePath)!);
          if (cutoffMs !== null && file.mtime < cutoffMs && !needsPartition) continue;
          if (!prev || prev.mtime !== file.mtime || needsPartition) {
            filesToProcess.push(file);
          } else if (prev.skipped && nowMs - (prev.skippedAt ?? 0) > SKIP_RETRY_MS) {
            // A terminal skip ages out: the operator may have raised a cap
            // or installed an extraction backend since.
            filesToProcess.push(file);
          }
        }

        // Present-but-unread (iCloud placeholders, oversized or
        // currently-unextractable files): carried forward, never emitted,
        // never deleted. Otherwise the snapshot machinery would eventually
        // delete every evicted document from the corpus.
        const newFileMap: Record<string, LocalFileState> = { ...previousFileMap };
        // Terminal outcome: record the skip with the current mtime so the
        // file leaves the queue instead of pinning it forever. Retried when
        // the file changes or the skip ages out.
        const recordSkip = (file: LocalFileEntry, reason: string): void => {
          const prev = previousFileMap[file.absolutePath];
          newFileMap[file.absolutePath] = {
            mtime: file.mtime,
            contentHash: "",
            rawHash: "",
            size: file.size,
            inode: file.inode,
            device: file.device,
            stableId: prev?.stableId ?? `ino:${file.device}:${file.inode}`,
            skipped: reason,
            skippedAt: nowMs,
          };
        };
        const placeholderSet = new Set(scan.placeholders);
        // Untracked placeholders stay unknown until the bytes are local.

        // A folder the scan could not read in full holds no information about
        // what is missing from it, and that is true before the identity ladder
        // runs as well as after: a file under a dark folder is not gone, so
        // letting a file elsewhere inherit its identity would rewrite a
        // document that is about to come back unchanged.
        const gappedRoots = new Set(scan.gaps.keys());

        const disappearedByHash = new Map<string, LocalFileState[]>();
        const disappearedByInode = new Map<string, LocalFileState>();
        const disappearedPaths: string[] = [];
        const currentSet = new Set(allFiles.map((f) => f.absolutePath));
        const currentInodes = new Set(allFiles.map((f) => `${f.device}:${f.inode}`));
        /**
         * The file this path held before, when it has been replaced in place:
         * its inode is no longer anywhere in the scan. An inode still present
         * elsewhere is that file moved away, and the identity goes with it.
         */
        const replacedAt = (file: LocalFileEntry): LocalFileState | undefined => {
          const prev = previousFileMap[file.absolutePath];
          if (!prev || prev.inode <= 0) return undefined;
          if (prev.device === file.device && prev.inode === file.inode) return undefined;
          return currentInodes.has(`${prev.device}:${prev.inode}`) ? undefined : prev;
        };
        for (const [path, stateOf] of Object.entries(previousFileMap)) {
          if (currentSet.has(path)) continue;
          if (placeholderSet.has(path)) continue;
          const root = rootOf(path);
          if (root !== null && gappedRoots.has(root)) continue;
          disappearedPaths.push(path);
          // Skipped files carry no raw hash; matching an empty hash against
          // an unrelated skipped file of the same size would steal identity.
          if (stateOf.rawHash !== "") {
            const list = disappearedByHash.get(stateOf.rawHash);
            if (list) list.push(stateOf);
            else disappearedByHash.set(stateOf.rawHash, [stateOf]);
          }
          if (stateOf.inode > 0)
            disappearedByInode.set(`${stateOf.device}:${stateOf.inode}`, stateOf);
        }
        // Disappeared paths leave the cursor only where their deletions are
        // asserted below. Anything else forgets files an incomplete scan
        // refused to delete and leaks their documents forever.

        // Slice from zero: resolved files (indexed or recorded skipped)
        // leave the recomputed queue, so each page advances. Terminal skips
        // are recorded precisely so a page of them cannot repeat forever.
        const batch = filesToProcess.slice(0, PAGE_SIZE);
        const hasMore = filesToProcess.length > PAGE_SIZE;
        const documents: DocumentInput[] = [];
        /** Folders holding a file this cycle could not read. */
        const failedRoots = new Set<string>();

        for (const file of batch) {
          let text: string;
          let extra: Record<string, unknown> | undefined;
          try {
            if (file.via === "text") {
              if (file.size > MAX_DIRECT_TEXT_BYTES) {
                log.debug(`Skipping oversized text file ${file.displayPath} (${file.size} bytes)`);
                recordSkip(file, "too-large");
                continue;
              }
              text = new TextDecoder("utf-8", { fatal: false }).decode(readFileBytes(file));
            } else {
              if (!extractAttachment || !attachmentConfig.enabled) {
                // No extractor wired: recorded, retried when one is (or the
                // skip ages out) rather than re-attempted every page.
                recordSkip(file, "unextractable");
                continue;
              }
              const check = shouldExtractAttachment(file.mimeType, file.size, attachmentConfig);
              if (!check.extract) {
                if (check.reason === "too-large") {
                  log.debug(`Skipping oversized file ${file.displayPath} (${file.size} bytes)`);
                }
                recordSkip(file, check.reason ?? "excluded");
                continue;
              }
              const bytes = readFileBytes(file);
              if (bytes.length === 0) {
                recordSkip(file, "empty");
                continue;
              }
              // A transient extraction-backend failure throws out of here;
              // it is recorded below as unreadable and retried when the file
              // changes or the skip ages out. Null / no-text is terminal.
              const result = await extractAttachment(bytes, file.mimeType, {
                maxTextLength: attachmentConfig.maxTextLength,
              });
              if (result === null || result.noText) {
                recordSkip(file, result === null ? "unextractable" : "no-text");
                continue;
              }
              text = result.text;
              extra = result.extra;
              if (typeof result.pages === "number") {
                extra = { ...(extra ?? {}), pages: result.pages };
              }
            }
          } catch (err) {
            const root = rootOf(file.absolutePath);
            const previous = previousFileMap[file.absolutePath];
            if (root !== null && !previous) failedRoots.add(root);
            log.warn(
              `Failed to read file ${file.displayPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
            if (previous) {
              newFileMap[file.absolutePath] = {
                ...previous,
                mtime: file.mtime,
                skipped: "unreadable",
                skippedAt: nowMs,
              };
            } else recordSkip(file, "unreadable");
            continue;
          }
          const rawHash = computeContentHash(text);
          const stableId = resolveStableId(
            rawHash,
            file.inode,
            file.device,
            file.size,
            disappearedByHash,
            disappearedByInode,
            replacedAt(file),
          );
          // The stableId moved here: any other path still carrying it is the
          // rename source, not a second file (true duplicates never share —
          // the ladder only matches just-vanished paths). Collapse so the
          // cursor can't accumulate stale entries across incomplete scans.
          for (const [otherPath, otherState] of Object.entries(newFileMap)) {
            if (otherPath !== file.absolutePath && otherState.stableId === stableId) {
              delete newFileMap[otherPath];
            }
          }
          const { doc, contentHash } = normalizeFile(file, text, extra, providerId, sourceId);
          doc.externalId = stableId;
          doc.partitionKey = partitionOf(rootOf(file.absolutePath)!);
          const prevAtPath = previousFileMap[file.absolutePath];
          if (
            prevAtPath &&
            prevAtPath.contentHash === contentHash &&
            prevAtPath.partitionKey === doc.partitionKey &&
            prevAtPath.stableId === stableId
          ) {
            newFileMap[file.absolutePath] = {
              mtime: file.mtime,
              contentHash,
              rawHash,
              size: file.size,
              inode: file.inode,
              device: file.device,
              stableId,
              partitionKey: doc.partitionKey,
            };
            continue;
          }
          documents.push(doc);
          newFileMap[file.absolutePath] = {
            mtime: file.mtime,
            contentHash,
            rawHash,
            size: file.size,
            inode: file.inode,
            device: file.device,
            stableId,
            partitionKey: doc.partitionKey,
          };
        }

        // What each folder holds, folder by folder. A folder whose walk
        // stopped short vouches for nothing; the ones that read cleanly still
        // do, so a file deleted in an unaffected folder is noticed this cycle
        // rather than waiting on whatever went wrong elsewhere.
        const enumeration = new SnapshotEnumeration(roots.map(partitionOf));
        for (const [root, reason] of scan.gaps) enumeration.gap(partitionOf(root), reason);
        // A file this cycle could not read is a hole in the folder holding it:
        // its identity is unknown, so naming the rest of that folder would ask
        // for its document to be swept.
        for (const root of failedRoots) {
          if (gappedRoots.has(root)) continue;
          enumeration.gap(
            partitionOf(root),
            "A file under this folder could not be read this cycle",
          );
          gappedRoots.add(root);
        }
        // A folder is only vouched for once the last page of the cycle has
        // run: until then the queue still holds files whose identity has not
        // been computed, and a claim naming the rest is an instruction to
        // delete them.
        if (!hasMore) {
          // A tracked path that is gone from a folder that read cleanly is
          // genuinely gone, and drops out of the state with the claim. One in
          // a folder that did not is left exactly as it was.
          for (const path of disappearedPaths) {
            const root = rootOf(path);
            if (root === null ? scan.gaps.size > 0 : gappedRoots.has(root)) continue;
            delete newFileMap[path];
          }
          let unattributed = 0;
          for (const [path, stateOf] of Object.entries(newFileMap)) {
            const root = rootOf(path);
            if (root === null) {
              // An unavailable configured symlink may have lost its canonical
              // spelling. Until its root can be read, this is not evidence of
              // an intentional scope removal.
              unattributed += 1;
              continue;
            }
            if (gappedRoots.has(root)) continue;
            enumeration.add(partitionOf(root), [stateOf.stableId]);
          }
          if (unattributed > 0) {
            enumeration.blindSpot(`${unattributed} tracked file(s) are under no configured folder`);
          }
          for (const root of roots) {
            if (!gappedRoots.has(root)) enumeration.cover(partitionOf(root));
          }
        }
        const withheld = enumeration.withheldReason();
        if (!hasMore && withheld) log.warn(`Local Files: ${withheld}`);

        // The collector refuses a claiming page carrying a document from a
        // folder that page does not vouch for, and it is right to: the two
        // statements contradict each other. Rather than lose the page, the
        // cycle keeps the documents and says nothing about what is present.
        const claims = enumeration.claims();
        const strayDocument = documents.some((doc) => {
          const partition = doc.partitionKey;
          return (
            partition === undefined ||
            [...gappedRoots].some((root) => partitionOf(root) === partition)
          );
        });
        // The enumeration's own verdict, not a count of claims: a hole in the
        // list of folders is not a gapped folder, and only it knows that.
        const snapshot = !hasMore && !strayDocument ? enumeration.result() : undefined;

        const cycleTotal = cursor?.cycleQueueTotal ?? filesToProcess.length;
        // Running total of emitted documents, not this page's count.
        // Terminally skipped files drain the queue without emitting, so a
        // cycle with skips honestly ends below 100% — the same accounting
        // the collector applies downstream.
        const processed = (cursor?.cycleProcessed ?? 0) + documents.length;
        const updatedCursor: LocalFilesSyncCursor = {
          version: CURSOR_VERSION,
          fileMap: newFileMap,
          cycleQueueTotal: hasMore ? cycleTotal : undefined,
          cycleProcessed: hasMore ? processed : undefined,
        };
        const progress: SyncProgress | undefined =
          cycleTotal > 0
            ? {
                phase: isBootstrap ? "bootstrap" : "incremental",
                total: cycleTotal,
                processed,
                percentComplete: Math.min(100, Math.round((processed / cycleTotal) * 100)),
              }
            : undefined;

        if (!hasMore && snapshot === undefined && (strayDocument || claims.length === 0)) {
          // Not covered by the enumeration's own reason: it can be complete
          // while this page still says nothing, because a document from a
          // folder it does not vouch for would contradict the claims.
          log.warn(
            "Local Files: nothing vouched for this cycle, so no deletion is detected. " +
              (strayDocument
                ? "A document on this page came from a folder that did not read in full."
                : "No folder read in full."),
          );
        }
        log.info(
          `Sync page: ${documents.length} docs, ${processed}/${cycleTotal} queue ` +
            `(tree: ${allFiles.length}, hasMore: ${hasMore}, folders vouched for: ` +
            `${strayDocument ? 0 : claims.length}/${roots.length})`,
        );
        const issue = !hasMore ? enumeration.withheldIssue() : undefined;
        return syncPage(documents, updatedCursor, {
          hasMore,
          issues: hasMore ? undefined : issue ? [issue] : [],
          // The whole-source form when the read was complete; folder by folder
          // when it was not but some folders still read cleanly; and nothing
          // at all otherwise, which an empty claim list would state as if it
          // were a finding.
          ...(snapshot !== undefined
            ? { presentExternalIds: snapshot }
            : !hasMore && !strayDocument && claims.length > 0
              ? { presentClaims: claims }
              : {}),
          progress,
        });
      },
    };
  },
});

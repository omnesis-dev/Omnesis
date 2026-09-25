// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { Transform, type Readable } from "node:stream";
import { createGunzip, createZstdDecompress } from "node:zlib";

const MAX_FILES = 10_000;
const MAX_SCAN_ENTRIES = 100_000;
const MAX_SCAN_DEPTH = 64;
/**
 * The largest session file read at all. Parsing streams line by line and what
 * a session keeps is bounded by the retention caps below, so this bounds time
 * rather than memory: a real 727 MiB, 126,000-line coding session parses in
 * about four seconds. Below that size, one long session made the whole root
 * unreadable — its own days were never indexed, and because the scan could not
 * vouch for the root, no deletion under it was ever detected either.
 */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_LINES_PER_FILE = 1_000_000;
/**
 * How many conversation nodes one session may hold in memory while it is
 * parsed. The byte cap below bounds the text a node retains; this bounds the
 * per-node object overhead the byte count does not see.
 *
 * A long coding session is tens of thousands of nodes — every tool call and
 * result is one — and a real 39,000-line transcript peaks at roughly 56 MiB of
 * heap to parse in full. A cap an order of magnitude below that turned such
 * sessions away whole, so a fresh install indexed none of their days. This
 * leaves headroom for sessions two to three times that long while still
 * refusing a file that is a node graph rather than a conversation.
 */
/** A line holding nothing but NUL bytes and whitespace. */
const CRASH_PADDING = /^[\0\s]*$/;

export const MAX_RETAINED_SESSION_RECORDS = 100_000;
export const MAX_RETAINED_SESSION_BYTES = 32 * 1024 * 1024;

export interface LocalAgentSessionRoot {
  path: string;
  /** Missing optional roots do not make snapshot reconciliation unsafe. */
  optional?: boolean;
  /**
   * What to call this root when the source vouches for it separately from the
   * others. Defaults to the path's last segment.
   *
   * A name, not the path: the path is where this machine happens to keep the
   * root, and it is what a snapshot claim is matched against. These sources are
   * partitioned across devices — each machine's documents live in their own
   * stream — so the name never has to mean the same thing on two machines. It
   * does have to mean the same thing across runs on one, which an absolute path
   * under a home directory does not survive.
   */
  id?: string;
}

/**
 * What one scan of a source's roots found, and what it could not read.
 *
 * `complete` is the whole-source answer it has always been. `rootFailures`
 * narrows it: the roots that could not be read, each with a reason, so a source
 * can vouch for the ones that could. `truncated` is the incompleteness no
 * per-root record can carry — a cap stopped the walk before every root was
 * reached, so the list of roots the scan covered is itself short.
 */
export interface LocalAgentSessionScan {
  files: ScannedLocalAgentSessionFile[];
  complete: boolean;
  rootFailures: Record<string, string>;
  truncated?: string;
}

/** The name a root is claimed under. See {@link LocalAgentSessionRoot.id}. */
export function localAgentRootId(root: LocalAgentSessionRoot): string {
  const id = root.id ?? basename(root.path);
  if (id === "") {
    // The empty string is what the gateway stores for a document that names no
    // partition, so a claim on it would sweep every document from before this
    // source named its roots. A root whose path ends in a separator, or an
    // adapter that passes an empty id, must not land there.
    throw new Error(`Local agent session root has no name: ${root.path}`);
  }
  return id;
}

export interface LocalAgentSessionFileRevision {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
  nlink: number;
  /** Canonical opt-in root used to reject ancestor symlink escapes. */
  rootPath?: string;
}

export interface LocalAgentSessionFileState {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev?: number;
  nlink?: number;
  sessionId?: string;
  externalIds: string[];
  complete: boolean;
  /** A failed parse retains IDs from an earlier complete parse of this file. */
  lastKnownComplete?: boolean;
  /**
   * The root this file was found under, so the ids it holds can be attributed
   * to a partition when the source vouches for its roots separately.
   *
   * Optional because a state written before roots were named carries none. The
   * scan re-derives it when a file is read successfully, re-reading legacy
   * entries so their documents receive the matching partition. A stored
   * file the scan no longer sees keeps its ids out of every claim, which is the
   * safe direction.
   */
  rootId?: string;
}

export interface LocalAgentSessionParseOptions {
  signal?: AbortSignal;
  expectedFile?: LocalAgentSessionFileRevision;
}

export interface JsonLineReadResult {
  malformedLines: number;
  /** An unfinished final JSON record, excluded from malformedLines for active transcripts. */
  trailingPartial: boolean;
}

export interface ScannedLocalAgentSessionFile extends LocalAgentSessionFileRevision {
  key: string;
  path: string;
  rootPath: string;
  /** The root this file was found under. See {@link LocalAgentSessionRoot.id}. */
  rootId: string;
}

function endsWithNewline(filePath: string, fd: number, size: number): boolean {
  if (filePath.endsWith(".gz") || filePath.endsWith(".zst") || size === 0) return true;
  const byte = Buffer.allocUnsafe(1);
  readSync(fd, byte, 0, 1, size - 1);
  return byte[0] === 0x0a || byte[0] === 0x0d;
}

export interface LocalAgentSessionRetentionGuard {
  (...retainedValues: Array<string | undefined>): void;
  /** Count one retained record per key while accounting for replacement bytes. */
  upsert(key: string, ...retainedValues: Array<string | undefined>): void;
}

export function createLocalAgentSessionRetentionGuard(): LocalAgentSessionRetentionGuard {
  let records = 0;
  let retainedBytes = 0;
  const keyedBytes = new Map<string, number>();
  const bytesFor = (retainedValues: Array<string | undefined>): number =>
    retainedValues.reduce((bytes, value) => bytes + (value ? Buffer.byteLength(value) : 0), 0);
  const assertWithinLimits = (nextRecords: number, nextBytes: number): void => {
    if (nextRecords > MAX_RETAINED_SESSION_RECORDS) {
      throw new Error(`Session parser exceeds ${MAX_RETAINED_SESSION_RECORDS} retained records`);
    }
    if (nextBytes > MAX_RETAINED_SESSION_BYTES) {
      throw new Error(`Session parser exceeds ${MAX_RETAINED_SESSION_BYTES} retained bytes`);
    }
  };
  const retain = ((...retainedValues: Array<string | undefined>): void => {
    const nextRecords = records + 1;
    const nextBytes = retainedBytes + bytesFor(retainedValues);
    assertWithinLimits(nextRecords, nextBytes);
    records = nextRecords;
    retainedBytes = nextBytes;
  }) as LocalAgentSessionRetentionGuard;
  retain.upsert = (key, ...retainedValues): void => {
    const previousBytes = keyedBytes.get(key);
    const replacementBytes = Buffer.byteLength(key) + bytesFor(retainedValues);
    const nextRecords = records + (previousBytes === undefined ? 1 : 0);
    const nextBytes = retainedBytes - (previousBytes ?? 0) + replacementBytes;
    assertWithinLimits(nextRecords, nextBytes);
    keyedBytes.set(key, replacementBytes);
    records = nextRecords;
    retainedBytes = nextBytes;
  };
  return retain;
}

/**
 * Split a byte stream into JSONL records. Records end at "\n" alone:
 * `readline` also breaks lines at "\r", U+2028 and U+2029, and the last two
 * are legal unescaped inside a JSON string, so a record quoting either would
 * be cut into fragments that each fail to parse, and the whole session would
 * read as damaged.
 */
async function* jsonLines(input: AsyncIterable<Buffer>): AsyncGenerator<string, void, undefined> {
  let pending: Buffer[] = [];
  for await (const chunk of input) {
    let offset = 0;
    let newline = chunk.indexOf(0x0a);
    while (newline >= 0) {
      pending.push(chunk.subarray(offset, newline));
      yield Buffer.concat(pending).toString("utf8");
      pending = [];
      offset = newline + 1;
      newline = chunk.indexOf(0x0a, offset);
    }
    if (offset < chunk.length) pending.push(chunk.subarray(offset));
  }
  if (pending.length > 0) yield Buffer.concat(pending).toString("utf8");
}

/** Stream JSONL without retaining tool-heavy source files in memory. */
export async function readJsonLines(
  filePath: string,
  visit: (value: unknown) => void | boolean,
  options: LocalAgentSessionParseOptions = {},
): Promise<JsonLineReadResult> {
  const expected = options.expectedFile;
  const resolveInsideRoot = (): string | undefined => {
    if (!expected?.rootPath) return undefined;
    const resolved = realpathSync(filePath);
    const fromRoot = relative(expected.rootPath, resolved);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("Session file escaped its configured root");
    }
    return resolved;
  };
  const resolvedBeforeOpen = resolveInsideRoot();
  const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let stat: ReturnType<typeof fstatSync>;
  try {
    stat = fstatSync(fd);
    const resolvedAfterOpen = resolveInsideRoot();
    if (resolvedBeforeOpen !== resolvedAfterOpen) {
      throw new Error("Session file changed after discovery");
    }
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_FILE_BYTES ||
      (expected !== undefined &&
        (stat.size !== expected.size ||
          stat.mtimeMs !== expected.mtimeMs ||
          stat.ctimeMs !== expected.ctimeMs ||
          stat.ino !== expected.ino ||
          stat.dev !== expected.dev ||
          stat.nlink !== expected.nlink))
    ) {
      throw new Error("Session file changed after discovery");
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const terminalNewline = endsWithNewline(filePath, fd, stat.size);
  const file = createReadStream(filePath, { fd, autoClose: true, signal: options.signal });
  const decoded: Readable = filePath.endsWith(".gz")
    ? file.pipe(createGunzip())
    : filePath.endsWith(".zst")
      ? file.pipe(createZstdDecompress())
      : file;
  let decodedBytes = 0;
  let currentLineBytes = 0;
  const input = decoded.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        decodedBytes += chunk.length;
        if (decodedBytes > MAX_DECOMPRESSED_BYTES) {
          callback(new Error(`Session file exceeds ${MAX_DECOMPRESSED_BYTES} decompressed bytes`));
          return;
        }

        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(0x0a, offset);
          if (newline < 0) {
            currentLineBytes += chunk.length - offset;
            break;
          }
          currentLineBytes += newline - offset;
          if (currentLineBytes > MAX_LINE_BYTES) {
            callback(new Error(`Session JSONL line exceeds ${MAX_LINE_BYTES} bytes`));
            return;
          }
          currentLineBytes = 0;
          offset = newline + 1;
        }
        if (currentLineBytes > MAX_LINE_BYTES) {
          callback(new Error(`Session JSONL line exceeds ${MAX_LINE_BYTES} bytes`));
          return;
        }
        callback(null, chunk);
      },
    }),
  );
  decoded.on("error", (error: Error) => input.destroy(error));
  if (decoded !== file) file.on("error", (error: Error) => decoded.destroy(error));
  const lines = jsonLines(input);
  let lineNumber = 0;
  let malformedLines = 0;
  let lastMalformedLine = 0;

  try {
    for await (const line of lines) {
      if (options.signal?.aborted) throw options.signal.reason;
      lineNumber += 1;
      if (lineNumber > MAX_LINES_PER_FILE) {
        throw new Error(`Session file exceeds ${MAX_LINES_PER_FILE} lines`);
      }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        throw new Error(`Session JSONL line exceeds ${MAX_LINE_BYTES} bytes`);
      }
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // A crash can leave a run of NUL bytes where the filesystem had
        // allocated space for a write that never reached the disk. The run
        // holds no record and the file is never rewritten to replace it, so
        // counting it as damage kept every record around it unreadable for
        // good — and deletion detection paused for the whole root with it.
        if (CRASH_PADDING.test(line)) continue;
        malformedLines += 1;
        lastMalformedLine = lineNumber;
        continue;
      }
      if (visit(value) === false) break;
    }
  } finally {
    await lines.return(undefined);
    input.destroy();
    decoded.destroy();
    file.destroy();
  }

  const trailingPartial =
    !terminalNewline && lastMalformedLine > 0 && lastMalformedLine === lineNumber;
  if (trailingPartial) malformedLines -= 1;
  return { malformedLines, trailingPartial };
}

export function sameLocalAgentSessionFileRevision(
  state: LocalAgentSessionFileState,
  file: ScannedLocalAgentSessionFile,
): boolean {
  return (
    state.size === file.size &&
    state.mtimeMs === file.mtimeMs &&
    state.ctimeMs === file.ctimeMs &&
    state.ino === file.ino &&
    state.dev === file.dev &&
    state.nlink === file.nlink
  );
}

export function scanLocalAgentSessionFiles(
  roots: readonly LocalAgentSessionRoot[],
  extensions: readonly string[],
): LocalAgentSessionScan {
  const files: ScannedLocalAgentSessionFile[] = [];
  let complete = true;
  let scannedEntries = 0;
  let limitReached = false;
  // Why each root cannot be vouched for, when it cannot. A root absent from
  // this map was walked to its end.
  const rootFailures = new Map<string, string>();
  // Set before any root is touched, so a failure can always be attributed.
  // `localAgentRootId` refuses an empty name, which is what makes that true.
  let currentRootId = "";
  const failRoot = (reason: string): void => {
    complete = false;
    if (!rootFailures.has(currentRootId)) rootFailures.set(currentRootId, reason);
  };

  const walk = (dir: string, rootPath: string, rootIndex: number, depth: number): void => {
    if (limitReached) return;
    const firstFileIndex = files.length;
    if (depth > MAX_SCAN_DEPTH) {
      failRoot("the directory tree is deeper than the scan will follow");
      limitReached = true;
      return;
    }

    let directory: ReturnType<typeof opendirSync>;
    let directoryStat: ReturnType<typeof lstatSync>;
    try {
      directoryStat = lstatSync(dir);
      if (!directoryStat.isDirectory()) {
        failRoot("a directory in it is not a directory");
        return;
      }
      directory = opendirSync(dir);
    } catch {
      failRoot("a directory in it would not open");
      return;
    }

    try {
      const openedPathStat = lstatSync(dir);
      if (
        !openedPathStat.isDirectory() ||
        openedPathStat.dev !== directoryStat.dev ||
        openedPathStat.ino !== directoryStat.ino
      ) {
        failRoot("a directory in it was replaced while it was being read");
        return;
      }
      let entry: Dirent | null;
      while (!limitReached && (entry = directory.readSync()) !== null) {
        scannedEntries += 1;
        if (scannedEntries > MAX_SCAN_ENTRIES) {
          failRoot("the scan reached its entry limit");
          limitReached = true;
          return;
        }

        const name = entry.name;
        const path = join(dir, name);
        if (entry.isDirectory()) {
          walk(path, rootPath, rootIndex, depth + 1);
          continue;
        }
        if (!entry.isFile() || !extensions.some((extension) => name.endsWith(extension))) {
          continue;
        }
        try {
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.nlink !== 1) {
            failRoot("an entry in it is not a plain file");
            continue;
          }
          if (stat.size > MAX_FILE_BYTES || files.length >= MAX_FILES) {
            const capped = files.length >= MAX_FILES;
            failRoot(
              capped ? "the scan reached its file limit" : "a file in it is over the size limit",
            );
            if (capped) limitReached = true;
            continue;
          }
          files.push({
            key: createHash("sha256")
              .update(`${rootIndex}\0${relative(rootPath, path)}`)
              .digest("hex"),
            path,
            rootPath,
            rootId: currentRootId,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            ino: stat.ino,
            dev: stat.dev,
            nlink: stat.nlink,
          });
        } catch {
          failRoot("a file in it could not be inspected");
        }
      }
    } finally {
      try {
        const finalDirectoryStat = lstatSync(dir);
        if (
          !finalDirectoryStat.isDirectory() ||
          finalDirectoryStat.dev !== directoryStat.dev ||
          finalDirectoryStat.ino !== directoryStat.ino
        ) {
          files.splice(firstFileIndex);
          failRoot("a directory in it was replaced while it was being read");
        }
      } catch {
        files.splice(firstFileIndex);
        failRoot("a directory in it could not be re-checked after reading");
      }
      directory.closeSync();
    }
  };

  for (const [rootIndex, root] of roots.entries()) {
    currentRootId = localAgentRootId(root);
    if (!existsSync(root.path)) {
      // A missing optional root is a root that holds nothing, not one that
      // could not be read: the adapter declared it may not exist. A required
      // one that is missing is a failure, and is attributed to itself.
      if (!root.optional) failRoot("the root does not exist");
      continue;
    }
    let rootPath: string;
    try {
      rootPath = realpathSync(root.path);
    } catch {
      failRoot("the root path would not resolve");
      continue;
    }
    walk(rootPath, rootPath, rootIndex, 0);
    if (limitReached) {
      // Every root after this one is left unopened. Recorded as their own
      // failures rather than left to the blind spot below: a blind spot
      // withholds the whole-source form and says nothing about a named root,
      // so an unopened root would otherwise be covered — vouched for on the
      // strength of a walk that never happened.
      for (const remaining of roots.slice(rootIndex + 1)) {
        const id = localAgentRootId(remaining);
        if (!rootFailures.has(id)) {
          rootFailures.set(id, "the scan stopped before reaching this root");
        }
      }
      break;
    }
  }

  // The caps stop the walk across roots, not inside one, so the list of roots
  // this scan covered is itself short — an incompleteness no per-root record
  // can express, on top of the per-root failures recorded above.
  const truncated = limitReached
    ? "the scan hit a depth, entry or file limit and stopped before every root was walked"
    : undefined;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  return {
    files,
    complete,
    rootFailures: Object.fromEntries(rootFailures),
    ...(truncated ? { truncated } : {}),
  };
}

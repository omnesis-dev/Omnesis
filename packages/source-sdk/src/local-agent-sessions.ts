// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  AGENT_CONVERSATION_RENDER_VERSION,
  createLogger,
  localDayKey,
  renderConversationDay,
  toErrorMessage,
} from "@omnesis/core";
import {
  localAgentRootId,
  scanLocalAgentSessionFiles,
  sameLocalAgentSessionFileRevision,
  type LocalAgentSessionFileState,
  type LocalAgentSessionParseOptions,
  type LocalAgentSessionRoot,
} from "./local-agent-session-files.js";
import { SnapshotEnumeration } from "./snapshot.js";
import { syncPage } from "./source.js";
import { probeTreeReadAccess } from "./read-access-tree.js";
import type { SnapshotClaim } from "./snapshot.js";
import type { ConversationMessage } from "@omnesis/core";
import type { DocumentInput, ProviderId, SourceId, SyncIssue } from "@omnesis/types";
import type { SourceInstance } from "./define-source.js";
import type { SyncCursor } from "./source.js";

export { createLocalAgentSessionDocumentEventProfile } from "./local-agent-session-profile.js";
export {
  createLocalAgentSessionRetentionGuard,
  MAX_RETAINED_SESSION_BYTES,
  MAX_RETAINED_SESSION_RECORDS,
  readJsonLines,
  type JsonLineReadResult,
  type LocalAgentSessionFileRevision,
  type LocalAgentSessionParseOptions,
  type LocalAgentSessionRoot,
} from "./local-agent-session-files.js";

const log = createLogger("source:agent-sessions");
const PAGE_SIZE = 10;

// Hard safety ceilings, not tuning knobs. Current observed stores stay far
// below these values; malformed sessions fail before output/cursors grow without bound.
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENTS_PER_SESSION = 4_000;
const MAX_DOCUMENTS_PER_PAGE = 5_000;
const MAX_PAGE_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_CURSOR_EXTERNAL_IDS = 100_000;
const MAX_SESSION_ID_BYTES = 256;
const MAX_SESSION_METADATA_FIELD_BYTES = 16 * 1024;
const MAX_SESSION_METADATA_BYTES = 64 * 1024;
const MAX_CURSOR_BYTES = 16 * 1024 * 1024;

export interface ParsedLocalAgentSession {
  id: string;
  cwd?: string;
  name?: string;
  branch?: string;
  model?: string;
  parentSessionId?: string;
  messages: ConversationMessage[];
  /** Valid source-native file that is not a user-facing root session. */
  ignored?: boolean;
  /** False when parsing skipped malformed, newline-terminated input. */
  complete?: boolean;
}

export interface LocalAgentSessionAdapter {
  harnessId: string;
  agentName: string;
  roots: readonly LocalAgentSessionRoot[];
  fileExtensions: readonly string[];
  /** Bump when this adapter changes normalized session output. */
  parserVersion: number;
  /** Whether a newer immutable file supersedes older files for one session. */
  duplicateSessionPolicy?: "union" | "newest";
  parseSession(
    filePath: string,
    options: LocalAgentSessionParseOptions,
  ): Promise<ParsedLocalAgentSession>;
}

export interface LocalAgentSessionCursor extends SyncCursor {
  version: 2;
  scanKey: string;
  files: Record<string, LocalAgentSessionFileState>;
  pendingFileKeys?: string[];
  cycleTotal?: number;
  cyclePhase?: "bootstrap" | "incremental";
  snapshotSafe?: boolean;
}

export interface CreateLocalAgentSessionSourceOptions {
  adapter: LocalAgentSessionAdapter;
  providerId: ProviderId;
  sourceId: SourceId;
  dataCutoff?: string;
}

function newestFileKeysBySession(
  files: Record<string, LocalAgentSessionFileState>,
): Map<string, string> {
  const newest = new Map<string, string>();
  for (const [key, state] of Object.entries(files)) {
    if (!state.sessionId) continue;
    const currentKey = newest.get(state.sessionId);
    const current = currentKey ? files[currentKey] : undefined;
    if (
      !current ||
      state.mtimeMs > current.mtimeMs ||
      (state.mtimeMs === current.mtimeMs && key > currentKey!)
    ) {
      newest.set(state.sessionId, key);
    }
  }
  return newest;
}

function newestFileKeysByExternalId(
  files: Record<string, LocalAgentSessionFileState>,
): Map<string, string> {
  const newest = new Map<string, string>();
  for (const [key, state] of Object.entries(files)) {
    for (const externalId of state.externalIds) {
      const currentKey = newest.get(externalId);
      const current = currentKey ? files[currentKey] : undefined;
      if (
        !current ||
        state.mtimeMs > current.mtimeMs ||
        (state.mtimeMs === current.mtimeMs && key > currentKey!)
      ) {
        newest.set(externalId, key);
      }
    }
  }
  return newest;
}

function currentExternalIds(
  files: Record<string, LocalAgentSessionFileState>,
  policy: LocalAgentSessionAdapter["duplicateSessionPolicy"],
): string[] {
  return [...new Set(livingFiles(files, policy).flatMap(([, state]) => state.externalIds))];
}

/**
 * The stored files whose ids are currently part of the corpus.
 *
 * Under the `newest` policy a session recorded in several files is represented
 * by one of them, and the others' ids belong to nothing — naming them would
 * vouch for documents that were superseded.
 */
function livingFiles(
  files: Record<string, LocalAgentSessionFileState>,
  policy: LocalAgentSessionAdapter["duplicateSessionPolicy"],
): Array<[string, LocalAgentSessionFileState]> {
  if (policy !== "newest") return Object.entries(files);
  const winners = new Set(newestFileKeysBySession(files).values());
  return Object.entries(files).filter(([key, state]) => !state.sessionId || winners.has(key));
}

/**
 * What each root currently holds, and which roots this cycle may vouch for.
 *
 * A root is vouched for when its own walk reached the end AND every file it
 * holds parsed, or retains a previously complete set of IDs. An unknown
 * malformed session file is confined to the root that holds it, where it
 * used to stop the whole source: for a harness that keeps its
 * archive in a second root, one unreadable archive directory meant no deletion
 * anywhere was detected for as long as it stayed unreadable.
 *
 * A stored file with no root — written before roots were named — is left out
 * of every claim rather than guessed at. It is safe for it to be, and the
 * reason is worth stating because nothing enforces it: a document carries a
 * partition exactly when its file's state carries a root, both written in the
 * same step, so a file with no root has documents the gateway stored with no
 * partition, which no claim names either. The scan re-derives the root for
 * every file it sees, re-reading legacy entries before naming their root.
 */
function rootEnumeration(
  roots: readonly LocalAgentSessionRoot[],
  files: Record<string, LocalAgentSessionFileState>,
  policy: LocalAgentSessionAdapter["duplicateSessionPolicy"],
  scan: { rootFailures: Record<string, string>; truncated?: string },
): SnapshotEnumeration {
  const enumeration = new SnapshotEnumeration(roots.map(localAgentRootId));
  const unparsed = new Set<string>();
  for (const [, state] of Object.entries(files)) {
    if (state.complete === false && !state.lastKnownComplete && state.rootId !== undefined)
      unparsed.add(state.rootId);
  }
  // Grouped by whatever root each file records. Only the declared roots are
  // read back out below, so a group under a root the adapter no longer declares
  // is simply never asked for — its ids reach no claim.
  const held = new Map<string, string[]>();
  for (const [, state] of livingFiles(files, policy)) {
    if (state.rootId === undefined) continue;
    held.set(state.rootId, [...(held.get(state.rootId) ?? []), ...state.externalIds]);
  }
  for (const root of roots) {
    const id = localAgentRootId(root);
    const failure = scan.rootFailures[id];
    if (failure !== undefined) {
      enumeration.gap(id, failure);
      continue;
    }
    if (unparsed.has(id)) {
      enumeration.gap(id, "a session file in it could not be parsed");
      continue;
    }
    enumeration.cover(id, held.get(id) ?? []);
  }
  if (scan.truncated !== undefined) enumeration.blindSpot(scan.truncated);
  return enumeration;
}

function displayName(session: ParsedLocalAgentSession): { chatName?: string; project?: string } {
  const project = session.cwd ? basename(session.cwd) : undefined;
  const parts = [session.name?.trim(), project, session.branch?.trim()].filter(
    (part, index, all): part is string => Boolean(part) && all.indexOf(part) === index,
  );
  return { chatName: parts.length > 0 ? parts.join(" · ") : undefined, project };
}

function renderSession(
  session: ParsedLocalAgentSession,
  options: CreateLocalAgentSessionSourceOptions,
  maxRenderedBytes: number,
): DocumentInput[] {
  if (session.ignored) return [];
  const cutoffMs = options.dataCutoff ? Date.parse(options.dataCutoff) : Number.NEGATIVE_INFINITY;
  const messages = session.messages
    .filter(
      (message) =>
        Number.isFinite(message.atMs) && message.atMs >= cutoffMs && message.text.trim().length > 0,
    )
    .sort((a, b) => a.atMs - b.atMs);
  const byDay = new Map<string, ConversationMessage[]>();
  const bytesByDay = new Map<string, number>();
  for (const message of messages) {
    const day = localDayKey(message.atMs);
    const nextBytes = (bytesByDay.get(day) ?? 0) + Buffer.byteLength(message.text) + 128;
    if (nextBytes > MAX_DOCUMENT_BYTES) {
      throw new Error(`Session day exceeds ${MAX_DOCUMENT_BYTES} rendered bytes`);
    }
    bytesByDay.set(day, nextBytes);
    const bucket = byDay.get(day) ?? [];
    bucket.push(message);
    byDay.set(day, bucket);
  }

  if (byDay.size > MAX_DOCUMENTS_PER_SESSION) {
    throw new Error(`Session file exceeds ${MAX_DOCUMENTS_PER_SESSION} day documents`);
  }

  const { chatName, project } = displayName(session);
  const documents: DocumentInput[] = [];
  let retainedBytes = 0;
  for (const [dayKey, dayMessages] of byDay) {
    const document = renderConversationDay({
      chat: { platform: "cli", chatId: session.id, chatName, chatType: "coding-session" },
      dayKey,
      messages: dayMessages,
      providerId: options.providerId,
      sourceId: options.sourceId,
      agentName: options.adapter.agentName,
      harnessId: options.adapter.harnessId,
      provenance: "local-session-file",
    });
    document.metadata.tags = [options.adapter.harnessId, "cli", ...(project ? [project] : [])];
    document.metadata.extra = {
      ...document.metadata.extra,
      project: project ?? null,
      cwd: session.cwd ?? null,
      branch: session.branch ?? null,
      model: session.model ?? null,
      parentSessionId: session.parentSessionId ?? null,
    };
    const renderedBytes =
      Buffer.byteLength(document.title) +
      Buffer.byteLength(document.content) +
      Buffer.byteLength(JSON.stringify(document.metadata));
    if (renderedBytes > MAX_DOCUMENT_BYTES) {
      throw new Error(`Session day exceeds ${MAX_DOCUMENT_BYTES} rendered bytes`);
    }
    retainedBytes += renderedBytes;
    if (retainedBytes > maxRenderedBytes) {
      throw new Error("Session sync page exceeds its document output limit");
    }
    documents.push(document);
  }
  return documents;
}

/** How long a watched session directory must stay unchanged before it is read. */
export const AGENT_SESSION_WATCH_QUIET_MS = 60_000;

/**
 * Build one collector source instance around a source-native session parser.
 * Source adapters own native JSON shapes; this module owns filesystem scanning,
 * day aggregation, stable IDs, and snapshot reconciliation.
 */
export function createLocalAgentSessionSource(
  options: CreateLocalAgentSessionSourceOptions,
): SourceInstance<LocalAgentSessionCursor> {
  const roots = options.adapter.roots.map((root) => root.path);

  return {
    probeReadAccess: ({ signal }) =>
      probeTreeReadAccess({
        signal,
        roots: options.adapter.roots,
        fileExtensions: options.adapter.fileExtensions,
      }),
    watchPaths: roots,
    watchDirectoryPaths: roots,
    watchFileExtensions: [...options.adapter.fileExtensions],
    // A running agent rewrites its transcript after every step, so a change
    // here usually means "still working", not "something to read". Waiting for
    // the files to settle reads a session once per pause instead of once per
    // step — and a long session can take seconds to read in full.
    watchQuietMs: AGENT_SESSION_WATCH_QUIET_MS,

    async sync(cursor, syncOptions) {
      if (syncOptions?.signal?.aborted) throw syncOptions.signal.reason;
      const scan = scanLocalAgentSessionFiles(
        options.adapter.roots,
        options.adapter.fileExtensions,
      );
      if (options.adapter.duplicateSessionPolicy === "newest") {
        scan.files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.key.localeCompare(a.key));
      }
      if (!scan.complete) {
        // The scan already recorded why each root fell short; saying only
        // that it "is incomplete" sends the reader looking for a cause the
        // process is holding.
        const why = Object.entries(scan.rootFailures)
          .map(([root, reason]) => `${root}: ${reason}`)
          .join("; ");
        log.warn(
          `Session file scan incomplete for ${options.sourceId} (${why || "no reason recorded"})` +
            `; preserving prior state`,
        );
      }
      const scanKey = createHash("sha256")
        .update(
          JSON.stringify({
            renderVersion: AGENT_CONVERSATION_RENDER_VERSION,
            parserVersion: options.adapter.parserVersion,
            duplicateSessionPolicy: options.adapter.duplicateSessionPolicy ?? "union",
            dataCutoff: options.dataCutoff ?? null,
            roots: options.adapter.roots,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        )
        .digest("hex");
      const previousFiles = cursor?.version === 2 ? cursor.files : {};
      const previousExternalIdCounts = new Map<string, number>();
      const previousSessionIdCounts = new Map<string, number>();
      for (const state of Object.values(previousFiles)) {
        if (state.sessionId) {
          previousSessionIdCounts.set(
            state.sessionId,
            (previousSessionIdCounts.get(state.sessionId) ?? 0) + 1,
          );
        }
        for (const externalId of state.externalIds) {
          previousExternalIdCounts.set(
            externalId,
            (previousExternalIdCounts.get(externalId) ?? 0) + 1,
          );
        }
      }
      const currentExternalIdCounts = new Map<string, number>();
      const currentSessionIdCounts = new Map<string, number>();
      const currentKnownFiles: Record<string, LocalAgentSessionFileState> = {};
      for (const file of scan.files) {
        const previous = previousFiles[file.key];
        if (!previous) continue;
        currentKnownFiles[file.key] = {
          ...previous,
          size: file.size,
          mtimeMs: file.mtimeMs,
          ctimeMs: file.ctimeMs,
          ino: file.ino,
          dev: file.dev,
          nlink: file.nlink,
          rootId: file.rootId,
        };
        if (previous.sessionId) {
          currentSessionIdCounts.set(
            previous.sessionId,
            (currentSessionIdCounts.get(previous.sessionId) ?? 0) + 1,
          );
        }
        for (const externalId of previous.externalIds) {
          currentExternalIdCounts.set(
            externalId,
            (currentExternalIdCounts.get(externalId) ?? 0) + 1,
          );
        }
      }
      const changedCollisionExternalIds = new Set(
        [...previousExternalIdCounts]
          .filter(([id, count]) => count > 1 && currentExternalIdCounts.get(id) !== count)
          .map(([id]) => id),
      );
      const changedSessionIds = new Set(
        [...previousSessionIdCounts]
          .filter(([id, count]) => count > 1 && currentSessionIdCounts.get(id) !== count)
          .map(([id]) => id),
      );
      for (const file of scan.files) {
        const previous = previousFiles[file.key];
        if (
          previous?.sessionId &&
          (previousSessionIdCounts.get(previous.sessionId) ?? 0) > 1 &&
          !sameLocalAgentSessionFileRevision(previous, file)
        ) {
          changedSessionIds.add(previous.sessionId);
        }
      }
      const previousWinners = newestFileKeysBySession(previousFiles);
      const currentWinners = newestFileKeysBySession(currentKnownFiles);
      for (const [sessionId, winner] of previousWinners) {
        if (currentWinners.get(sessionId) !== winner) changedSessionIds.add(sessionId);
      }
      const continuing =
        cursor?.version === 2 && cursor.scanKey === scanKey && cursor.pendingFileKeys !== undefined;
      const mayReuse = cursor?.version === 2 && cursor.scanKey === scanKey;
      const scannedByKey = new Map(scan.files.map((file) => [file.key, file]));
      // A file the scan no longer sees is gone — but only from a root the scan
      // actually read. Dropping every unseen file whenever the whole scan was
      // clean, and keeping every one otherwise, is the whole-source shape the
      // claims replaced: an unreadable archive would keep a session deleted
      // from the live root alive in the state, and the live root's claim would
      // then vouch for a document that no longer exists.
      const readRoots = new Set(
        options.adapter.roots
          .map(localAgentRootId)
          .filter((id) => scan.rootFailures[id] === undefined),
      );
      const survives = (state: LocalAgentSessionFileState, key: string): boolean =>
        scannedByKey.has(key) ||
        (state.rootId === undefined ? !scan.complete : !readRoots.has(state.rootId));
      const files: Record<string, LocalAgentSessionFileState> = continuing
        ? { ...previousFiles }
        : Object.fromEntries(
            Object.entries(previousFiles).filter(([key, state]) => survives(state, key)),
          );
      let pendingFileKeys: string[];
      let snapshotSafe: boolean;
      let drifted = false;
      let cycleTotal: number;
      let cyclePhase: "bootstrap" | "incremental";

      if (continuing) {
        pendingFileKeys = cursor.pendingFileKeys ?? [];
        snapshotSafe = Boolean(cursor.snapshotSafe) && scan.complete;
        // Only a file whose documents the cycle already holds, gone from a
        // root the scan read, makes its enumeration unsafe: a file that moved
        // takes its documents out of this cycle's snapshot while they still
        // exist elsewhere. A file that grew — an open session appending its
        // transcript — still holds every document already taken from it; a
        // file that appeared, or one still pending, was never claimed; and a
        // file in a root the scan could not read is that root's gap, not
        // drift. All of those are picked up by a later cycle, and treating
        // them as drift would withhold the snapshot on nearly every cycle
        // while the tool is in use.
        const vanished = Object.entries(previousFiles).some(
          ([key, state]) =>
            !scannedByKey.has(key) &&
            (state.rootId === undefined ? scan.complete : readRoots.has(state.rootId)),
        );
        if (vanished) {
          snapshotSafe = false;
          // Which root the file left is not knowable — a file that moved is
          // simply a key the scan no longer has — so no per-root record can
          // carry it and nothing this cycle enumerated can be vouched for.
          drifted = true;
        }
        cycleTotal = cursor.cycleTotal ?? pendingFileKeys.length;
        cyclePhase = cursor.cyclePhase ?? "incremental";
      } else {
        pendingFileKeys = [];
        snapshotSafe = scan.complete;
        cyclePhase = Object.keys(previousFiles).length === 0 ? "bootstrap" : "incremental";
        for (const file of scan.files) {
          const previous = previousFiles[file.key];
          if (
            mayReuse &&
            previous?.complete &&
            previous.rootId === file.rootId &&
            sameLocalAgentSessionFileRevision(previous, file) &&
            !previous.externalIds.some((externalId) =>
              changedCollisionExternalIds.has(externalId),
            ) &&
            !(previous.sessionId && changedSessionIds.has(previous.sessionId))
          ) {
            files[file.key] = { ...previous, rootId: file.rootId };
          } else {
            pendingFileKeys.push(file.key);
          }
        }
        cycleTotal = pendingFileKeys.length;
      }

      const batch = pendingFileKeys.slice(0, PAGE_SIZE);
      const remaining = pendingFileKeys.slice(batch.length);
      const queuedFileKeys = new Set(pendingFileKeys);
      const processedFileKeys = new Set<string>();
      const documents: DocumentInput[] = [];
      const documentFileKeys: string[] = [];
      let pageDocumentBytes = 0;
      let cursorExternalIdCount = Object.values(files).reduce(
        (count, state) => count + state.externalIds.length,
        0,
      );

      for (const fileKey of batch) {
        processedFileKeys.add(fileKey);
        const file = scannedByKey.get(fileKey);
        const previous = previousFiles[fileKey];
        if (!file) {
          cursorExternalIdCount -= files[fileKey]?.externalIds.length ?? 0;
          delete files[fileKey];
          continue;
        }

        try {
          const session = await options.adapter.parseSession(file.path, {
            signal: syncOptions?.signal,
            expectedFile: file,
          });
          if (session.complete === false) {
            const lastKnownComplete =
              previous?.complete === true || previous?.lastKnownComplete === true;
            snapshotSafe = false;
            log.warn(
              `Session file contains malformed records: ${basename(file.path)}; preserving prior document state`,
            );
            files[fileKey] = {
              size: file.size,
              mtimeMs: file.mtimeMs,
              ctimeMs: file.ctimeMs,
              ino: file.ino,
              dev: file.dev,
              nlink: file.nlink,
              rootId: file.rootId,
              sessionId: previous?.sessionId,
              externalIds: previous?.externalIds ?? [],
              complete: false,
              lastKnownComplete,
            };
            continue;
          }
          if (!session.id.trim() || Buffer.byteLength(session.id) > MAX_SESSION_ID_BYTES) {
            throw new Error(`Session id exceeds ${MAX_SESSION_ID_BYTES} bytes`);
          }
          if (previous?.sessionId !== session.id) {
            let requeueCurrent = false;
            for (const peer of scan.files) {
              const peerSessionId = previousFiles[peer.key]?.sessionId;
              if (
                peer.key !== fileKey &&
                !processedFileKeys.has(peer.key) &&
                !queuedFileKeys.has(peer.key) &&
                (peerSessionId === session.id ||
                  (previous?.sessionId !== undefined && peerSessionId === previous.sessionId))
              ) {
                remaining.push(peer.key);
                queuedFileKeys.add(peer.key);
                cycleTotal += 1;
                if (
                  peerSessionId === session.id &&
                  (peer.mtimeMs < file.mtimeMs ||
                    (peer.mtimeMs === file.mtimeMs && peer.key < file.key))
                ) {
                  requeueCurrent = true;
                }
              }
            }
            if (requeueCurrent) {
              remaining.push(fileKey);
              cycleTotal += 1;
            }
          }
          const metadataFields = [
            session.cwd,
            session.name,
            session.branch,
            session.model,
            session.parentSessionId,
          ].filter((value): value is string => typeof value === "string");
          if (
            metadataFields.some(
              (value) => Buffer.byteLength(value) > MAX_SESSION_METADATA_FIELD_BYTES,
            ) ||
            metadataFields.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) >
              MAX_SESSION_METADATA_BYTES
          ) {
            throw new Error("Session metadata exceeds its size limit");
          }
          const sessionDocuments = renderSession(
            session,
            options,
            MAX_PAGE_DOCUMENT_BYTES - pageDocumentBytes,
          );
          const sessionDocumentBytes = sessionDocuments.reduce(
            (bytes, document) =>
              bytes +
              Buffer.byteLength(document.title) +
              Buffer.byteLength(document.content) +
              Buffer.byteLength(JSON.stringify(document.metadata)),
            0,
          );
          if (
            documents.length + sessionDocuments.length > MAX_DOCUMENTS_PER_PAGE ||
            pageDocumentBytes + sessionDocumentBytes > MAX_PAGE_DOCUMENT_BYTES
          ) {
            throw new Error("Session sync page exceeds its document output limit");
          }
          const nextExternalIdCount =
            cursorExternalIdCount -
            (files[fileKey]?.externalIds.length ?? 0) +
            sessionDocuments.length;
          if (nextExternalIdCount > MAX_CURSOR_EXTERNAL_IDS) {
            throw new Error(`Session cursor exceeds ${MAX_CURSOR_EXTERNAL_IDS} document ids`);
          }
          // The root this session file was found under. A claim only reaches
          // documents that say which root they are in, and a key that appeared
          // the moment a cycle first had to claim would leave every earlier
          // document unreachable by any sweep.
          documents.push(
            ...sessionDocuments.map((document) => ({ ...document, partitionKey: file.rootId })),
          );
          documentFileKeys.push(...sessionDocuments.map(() => fileKey));
          pageDocumentBytes += sessionDocumentBytes;
          cursorExternalIdCount = nextExternalIdCount;
          files[fileKey] = {
            size: file.size,
            mtimeMs: file.mtimeMs,
            ctimeMs: file.ctimeMs,
            ino: file.ino,
            dev: file.dev,
            nlink: file.nlink,
            rootId: file.rootId,
            sessionId: session.ignored ? undefined : session.id,
            externalIds: sessionDocuments.map((document) => document.externalId),
            complete: true,
          };
        } catch (error) {
          if (syncOptions?.signal?.aborted) throw syncOptions.signal.reason;
          const lastKnownComplete =
            previous?.complete === true || previous?.lastKnownComplete === true;
          snapshotSafe = false;
          const detail = toErrorMessage(error).split(file.path).join(basename(file.path));
          log.warn(`Session file parse failed for ${basename(file.path)}: ${detail}`);
          files[fileKey] = {
            size: file.size,
            mtimeMs: file.mtimeMs,
            ctimeMs: file.ctimeMs,
            ino: file.ino,
            dev: file.dev,
            nlink: file.nlink,
            rootId: file.rootId,
            sessionId: previous?.sessionId,
            externalIds: previous?.externalIds ?? [],
            complete: false,
            lastKnownComplete,
          };
        }
      }

      // An immutable session can move to an unreadable archive between scans.
      // Until that root is readable, disappearance from the live root alone
      // cannot distinguish an archive move from a deletion.
      if (options.adapter.duplicateSessionPolicy === "newest" && !snapshotSafe) {
        for (const [key, state] of Object.entries(previousFiles)) {
          if (!scannedByKey.has(key) && !files[key]) files[key] = state;
        }
      }

      let outputDocuments: DocumentInput[];
      if (options.adapter.duplicateSessionPolicy === "newest") {
        const winners = newestFileKeysBySession(files);
        outputDocuments = documents.filter((_, index) => {
          const key = documentFileKeys[index]!;
          const state = files[key];
          return !state?.sessionId || winners.get(state.sessionId) === key;
        });
      } else {
        const winners = newestFileKeysByExternalId(files);
        outputDocuments = documents.filter(
          (document, index) => winners.get(document.externalId) === documentFileKeys[index],
        );
      }
      const hasMore = remaining.length > 0;
      const complete = !hasMore && snapshotSafe;
      // The whole-source form when every root was read; otherwise the roots
      // that were. Only on the page that ends the cycle: an assertion about
      // what exists is valid only when the enumeration it describes is done.
      const presentExternalIds = complete
        ? currentExternalIds(files, options.adapter.duplicateSessionPolicy)
        : undefined;
      // Claims are what a cycle that read some of its roots can still say. Two
      // things stop it saying anything:
      //
      //  - drift, because which root the tree changed in is not knowable, so
      //    nothing this cycle enumerated can be vouched for; and
      //  - a document on this page belonging to a root the cycle gapped. The
      //    host refuses a claiming page carrying a document outside its claims
      //    — rightly, since that document sits in a partition the sweep cannot
      //    judge — and refusing it there discards every claim on the page and
      //    files the source as misbehaving. A root gaps for one malformed
      //    transcript while its healthy siblings are still being ingested, so
      //    this is the ordinary case, not the exotic one.
      let presentClaims: SnapshotClaim[] | undefined;
      let issues: SyncIssue[] | undefined = hasMore ? undefined : [];
      if (!hasMore && !complete) {
        const enumeration = rootEnumeration(
          options.adapter.roots,
          files,
          options.adapter.duplicateSessionPolicy,
          scan,
        );
        const claims = enumeration.claims();
        const claimed = new Set(claims.map((claim) => claim.partition));
        const stray = outputDocuments.find((document) => !claimed.has(document.partitionKey ?? ""));
        if (drifted)
          enumeration.blindSpot("a session file moved or disappeared while it was being read");
        if (stray)
          enumeration.blindSpot("a session belongs to a folder that could not be read in full");
        const issue = enumeration.withheldIssue();
        issues = issue ? [issue] : [];
        if (!drifted && claims.length > 0 && stray === undefined) {
          presentClaims = claims;
          log.warn(enumeration.withheldReason() ?? "Snapshot withheld");
        }
      }
      const nextCursor: LocalAgentSessionCursor = {
        version: 2,
        scanKey,
        files,
        pendingFileKeys: hasMore ? remaining : undefined,
        cycleTotal: hasMore ? cycleTotal : undefined,
        cyclePhase: hasMore ? cyclePhase : undefined,
        snapshotSafe: hasMore ? snapshotSafe : undefined,
      };
      if (Buffer.byteLength(JSON.stringify(nextCursor)) > MAX_CURSOR_BYTES) {
        throw new Error(`Session cursor exceeds ${MAX_CURSOR_BYTES} bytes`);
      }
      return syncPage(outputDocuments, nextCursor, {
        hasMore,
        presentExternalIds,
        presentClaims,
        issues,
        progress:
          cycleTotal > 0
            ? {
                phase: cyclePhase,
                total: cycleTotal,
                processed: cycleTotal - remaining.length,
                percentComplete: Math.round(((cycleTotal - remaining.length) / cycleTotal) * 100),
              }
            : undefined,
        watermark: complete
          ? { guarantee: "best-effort-scan", observedAt: new Date().toISOString() }
          : undefined,
      });
    },
  };
}

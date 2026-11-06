// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID, createHash } from "node:crypto";
import { syncFromFixture, impairEntries, type SynthCursor } from "@omnesis/providers-synth-common";
import { mapDriveFile, type DriveFileEntry } from "./fixtures.js";
import type { SourceInstance } from "@omnesis/source-sdk";
import type { ProviderId, SourceId, SourceScopeHierarchyUpdate } from "@omnesis/types";

export interface DriveFolderEntry {
  id: string;
  name: string;
  parentIds: string[];
}
interface Cursor extends SynthCursor {
  scopeFixtureAwaitingEpoch?: string;
  scopeFixtureRequestId?: string;
  scopeFixtureActorId?: string;
  scopeFixtureEpoch?: string;
  scopeFixtureSnapshot?: string;
  scopeFixtureFolderOffset?: number;
  scopeFixtureFileOffset?: number;
  scopeFixtureReady?: boolean;
  scopeFixtureDigest?: string;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
function clear(cursor: Cursor): Cursor {
  const result = { ...cursor };
  for (const key of Object.keys(result)) if (key.startsWith("scopeFixture")) delete result[key];
  return result;
}

/** The double shares native IDs and bounded graph changes with the real provider. */
export function createDriveFixtureSource(
  entries: DriveFileEntry[],
  folders: DriveFolderEntry[],
  context: { sourceId: SourceId; providerId: ProviderId },
): SourceInstance<Cursor> {
  let lastNodes: Map<string, DriveFolderEntry> | undefined;
  let lastFiles: Map<string, DriveFileEntry> | undefined;
  return {
    async sync(cursor, options) {
      let state: Cursor = cursor ?? { offset: 0 };
      const supported = options?.scopeHierarchySupported === true;
      const epoch = options?.scopeRefreshEpochs?.folder;
      const actorId = options?.scopeRefreshActorId;
      if (!supported || options?.run?.role === "member") {
        const result = syncFromFixture(
          entries,
          clear(state),
          (entry) => mapDriveFile(entry, context),
          { sourceId: context.sourceId },
        );
        return {
          ...result,
          ...(options?.scopeFactsSupported && options?.run?.role !== "member"
            ? {
                scopeUpdates: {
                  refreshes: [{ kind: "folder" as const, active: true }],
                  readiness: [{ kind: "folder" as const, complete: false }],
                },
              }
            : {}),
        };
      }
      if (actorId && state.scopeFixtureActorId !== actorId) state = clear(state);
      const currentNodes = new Map(
        folders.map((folder) => [folder.id, { ...folder, parentIds: [...folder.parentIds] }]),
      );
      const currentFiles = new Map(
        entries.map((file) => [
          file.externalId,
          { ...file, parentIds: file.parentIds ? [...file.parentIds] : undefined },
        ]),
      );
      const digest = hash({
        folders: [...currentNodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
        files: [...currentFiles.values()]
          .map((file) => ({ id: file.externalId, parents: file.parentIds }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      });
      const wait = () => {
        const retry =
          state.scopeFixtureAwaitingEpoch === (epoch ?? "") && !!state.scopeFixtureRequestId;
        const requestId = retry ? state.scopeFixtureRequestId! : randomUUID();
        return {
          documents: [],
          deletedExternalIds: [],
          hasMore: !retry,
          cursor: {
            ...clear(state),
            scopeFixtureAwaitingEpoch: epoch ?? "",
            scopeFixtureRequestId: requestId,
            scopeFixtureActorId: actorId,
          },
          scopeUpdates: {
            refreshes: [
              {
                kind: "folder" as const,
                active: true,
                requestId,
                ...(epoch !== undefined ? { epoch, restart: true } : {}),
              },
            ],
            readiness: [{ kind: "folder" as const, complete: false }],
          },
        };
      };
      if (state.scopeFixtureAwaitingEpoch !== undefined) {
        if (
          state.scopeFixtureAwaitingEpoch === (epoch ?? "") ||
          !state.scopeFixtureRequestId ||
          options?.scopeRefreshRequestIds?.folder !== state.scopeFixtureRequestId
        )
          return wait();
        state = {
          ...clear(state),
          scopeFixtureEpoch: epoch,
          scopeFixtureSnapshot: randomUUID(),
          scopeFixtureFolderOffset: 0,
          scopeFixtureFileOffset: 0,
          scopeFixtureReady: false,
          scopeFixtureDigest: digest,
          scopeFixtureActorId: actorId,
        };
        return {
          documents: [],
          deletedExternalIds: [],
          hasMore: true,
          cursor: state,
          scopeUpdates: {
            hierarchy: {
              kind: "folder",
              refreshEpoch: epoch,
              snapshot: { id: state.scopeFixtureSnapshot!, phase: "begin" },
            },
            refreshes: [{ kind: "folder", active: true, epoch }],
            readiness: [{ kind: "folder", complete: false }],
          },
        };
      }
      if (
        state.scopeFixtureEpoch !== epoch ||
        !state.scopeFixtureSnapshot ||
        (!state.scopeFixtureReady && state.scopeFixtureDigest !== digest)
      )
        return wait();
      const result = syncFromFixture(
        entries,
        state,
        (entry) =>
          mapDriveFile(entry, {
            ...context,
            scopeHierarchySupported: true,
            scopeRefreshEpoch: epoch,
          }),
        { sourceId: context.sourceId },
      );
      const available = impairEntries(
        entries,
        context.sourceId,
        (entry) => entry.externalId,
      ).snapshotAllowed;
      if (!state.scopeFixtureReady) {
        const nodeOffset = state.scopeFixtureFolderOffset ?? 0;
        const fileOffset = state.scopeFixtureFileOffset ?? 0;
        const batch = folders.slice(nodeOffset, nodeOffset + 128);
        const files = entries.slice(fileOffset, fileOffset + 128);
        const done =
          nodeOffset + batch.length >= folders.length &&
          fileOffset + files.length >= entries.length &&
          available;
        if (done) {
          lastNodes = currentNodes;
          lastFiles = currentFiles;
        }
        return {
          ...result,
          hasMore: result.hasMore || !done,
          cursor: {
            ...state,
            ...result.cursor,
            scopeFixtureFolderOffset: nodeOffset + batch.length,
            scopeFixtureFileOffset: fileOffset + files.length,
            scopeFixtureReady: done,
          },
          scopeUpdates: {
            hierarchy: {
              kind: "folder",
              refreshEpoch: epoch,
              nodes: batch.map((folder) => ({
                id: folder.id,
                label: folder.name,
                parentIds: folder.parentIds,
                complete: true,
              })),
              documents: files.map((file) => ({
                externalId: file.externalId,
                parentIds: file.parentIds ?? [],
                complete: file.parentIds !== undefined,
                refreshEpoch: epoch,
              })),
              snapshot: { id: state.scopeFixtureSnapshot, phase: done ? "end" : "scan" },
            },
            refreshes: [{ kind: "folder", active: !done, epoch }],
            readiness: [{ kind: "folder", complete: done }],
          },
        };
      }
      if (state.scopeFixtureDigest !== digest) {
        if (!lastNodes || !lastFiles) return wait();
        const nodes: NonNullable<SourceScopeHierarchyUpdate["nodes"]> = [];
        for (const [id, node] of currentNodes)
          if (hash(lastNodes.get(id)) !== hash(node))
            nodes.push({ id, label: node.name, parentIds: node.parentIds, complete: true });
        for (const id of lastNodes.keys())
          if (!currentNodes.has(id))
            nodes.push({ id, label: id, parentIds: [], complete: false, deleted: true });
        const documents: NonNullable<SourceScopeHierarchyUpdate["documents"]> = [];
        for (const [id, file] of currentFiles)
          if (hash(lastFiles.get(id)?.parentIds) !== hash(file.parentIds))
            documents.push({
              externalId: id,
              parentIds: file.parentIds ?? [],
              complete: file.parentIds !== undefined,
              refreshEpoch: epoch,
            });
        for (const id of lastFiles.keys())
          if (!currentFiles.has(id))
            documents.push({ externalId: id, parentIds: [], complete: false, refreshEpoch: epoch });
        if (nodes.length > 128 || documents.length > 128) return wait();
        lastNodes = currentNodes;
        lastFiles = currentFiles;
        return {
          ...result,
          cursor: { ...result.cursor, scopeFixtureDigest: digest },
          scopeUpdates: { hierarchy: { kind: "folder", refreshEpoch: epoch, nodes, documents } },
        };
      }
      lastNodes = currentNodes;
      lastFiles = currentFiles;
      return result;
    },
  };
}

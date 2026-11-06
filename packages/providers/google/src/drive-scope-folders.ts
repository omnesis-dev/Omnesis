// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { pMap } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { GOOGLE_PAGE_SIZE, GOOGLE_FETCH_CONCURRENCY } from "./constants.js";
import { googleApiStatus } from "./api-error.js";
import type { SourceScopeHierarchyUpdate, SourceScopeUpdates } from "@omnesis/types";
import type { SyncResult } from "@omnesis/source-sdk";
import type { drive_v3 } from "googleapis";
import type { DriveSyncCursor } from "./drive.js";

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const DRIVE_SCOPE_FIELDS = "id,name,mimeType,parents,driveId,trashed";
export interface DriveFolderScopeCursor {
  scopeFoldersVersion?: 1;
  scopeFoldersStage?: "awaiting" | "anchor" | "start" | "scan" | "changes";
  scopeFoldersSnapshotId?: string;
  scopeFoldersPageToken?: string;
  scopeFoldersAnchor?: string;
  scopeFoldersEpoch?: string;
  scopeFoldersCompletedEpoch?: string;
  scopeFoldersYieldToContent?: boolean;
  scopeFoldersRequestId?: string;
  scopeFoldersActorId?: string;
}
export function driveFolderBookmark(state: DriveSyncCursor): DriveFolderScopeCursor {
  const {
    scopeFoldersVersion,
    scopeFoldersStage,
    scopeFoldersSnapshotId,
    scopeFoldersPageToken,
    scopeFoldersAnchor,
    scopeFoldersEpoch,
    scopeFoldersCompletedEpoch,
    scopeFoldersYieldToContent,
    scopeFoldersRequestId,
    scopeFoldersActorId,
  } = state;
  return {
    scopeFoldersVersion,
    scopeFoldersStage,
    scopeFoldersSnapshotId,
    scopeFoldersPageToken,
    scopeFoldersAnchor,
    scopeFoldersEpoch,
    scopeFoldersCompletedEpoch,
    scopeFoldersYieldToContent,
    scopeFoldersRequestId,
    scopeFoldersActorId,
  };
}
export function withoutDriveFolderScopeCursor(state: DriveSyncCursor): DriveSyncCursor {
  const legacy = { ...state };
  for (const key of Object.keys(driveFolderBookmark(state)))
    delete legacy[key as keyof DriveFolderScopeCursor];
  return legacy;
}
export function isDriveFolderScopeCursor(value: Record<string, unknown>): boolean {
  if (value.scopeFoldersVersion !== undefined && value.scopeFoldersVersion !== 1) return false;
  if (
    value.scopeFoldersStage !== undefined &&
    !["awaiting", "anchor", "start", "scan", "changes"].includes(String(value.scopeFoldersStage))
  )
    return false;
  if (
    value.scopeFoldersYieldToContent !== undefined &&
    typeof value.scopeFoldersYieldToContent !== "boolean"
  )
    return false;
  for (const key of [
    "scopeFoldersSnapshotId",
    "scopeFoldersPageToken",
    "scopeFoldersAnchor",
    "scopeFoldersEpoch",
    "scopeFoldersCompletedEpoch",
    "scopeFoldersRequestId",
    "scopeFoldersActorId",
  ])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" ||
        !(value[key] as string).length ||
        (value[key] as string).length >
          (key === "scopeFoldersPageToken" || key === "scopeFoldersAnchor" ? 8192 : 512))
    )
      return false;
  if (
    value.scopeFoldersRequestId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(value.scopeFoldersRequestId),
    )
  )
    return false;
  return value.scopeFoldersStage === undefined || typeof value.scopeFoldersSnapshotId === "string";
}
export function driveDirectParents(
  file: drive_v3.Schema$File,
  knownRoot = false,
): { parentIds: string[]; complete: boolean } {
  const supplied = file.parents;
  if (!Array.isArray(supplied))
    return { parentIds: [], complete: knownRoot || (!!file.id && file.id === file.driveId) };
  const valid =
    supplied.length <= 16 &&
    supplied.every((id) => typeof id === "string" && id.length > 0 && id.length <= 512);
  return { parentIds: valid ? [...new Set(supplied)] : [], complete: valid };
}
export function driveFolderNode(
  file: drive_v3.Schema$File,
  knownRoot = false,
): NonNullable<SourceScopeHierarchyUpdate["nodes"]>[number] | undefined {
  if (!file.id || file.mimeType !== DRIVE_FOLDER_MIME) return undefined;
  return {
    id: file.id,
    label: (file.name || file.id).slice(0, 512),
    ...driveDirectParents(file, knownRoot),
    ...(file.trashed ? { deleted: true, complete: false } : {}),
  };
}

export function driveHierarchyDelta(
  files: readonly drive_v3.Schema$File[],
  deleted: readonly string[],
  epoch?: string,
  includeDocuments = true,
): SourceScopeHierarchyUpdate {
  const nodes = new Map<string, NonNullable<SourceScopeHierarchyUpdate["nodes"]>[number]>();
  const documents = new Map<string, NonNullable<SourceScopeHierarchyUpdate["documents"]>[number]>();
  for (const file of files) {
    if (!file.id) continue;
    const node = driveFolderNode(file);
    if (node) nodes.set(file.id, node);
    else if (includeDocuments)
      documents.set(file.id, {
        externalId: file.id,
        ...driveDirectParents(file),
        refreshEpoch: epoch,
      });
  }
  for (const id of deleted) {
    nodes.set(id, { id, label: id, parentIds: [], complete: false, deleted: true });
    if (includeDocuments)
      documents.set(id, { externalId: id, parentIds: [], complete: false, refreshEpoch: epoch });
  }
  return {
    kind: "folder",
    refreshEpoch: epoch,
    nodes: [...nodes.values()],
    ...(includeDocuments ? { documents: [...documents.values()] } : {}),
  };
}

/** Independent metadata bookmarks never rewind the content changes token. */
export class DriveScopeFolders {
  constructor(private readonly drive: drive_v3.Drive) {}
  async page(
    state: DriveSyncCursor,
    epoch?: string,
    ackRequestId?: string,
    actorId?: string,
  ): Promise<SyncResult> {
    if (actorId && state.scopeFoldersActorId !== actorId)
      state = withoutDriveFolderScopeCursor(state);
    const assigned =
      state.scopeFoldersStage === "awaiting" &&
      state.scopeFoldersEpoch !== epoch &&
      !!state.scopeFoldersRequestId &&
      ackRequestId === state.scopeFoldersRequestId;
    if (assigned) state = withoutDriveFolderScopeCursor(state);
    if ((!state.scopeFoldersStage && !assigned) || state.scopeFoldersStage === "awaiting") {
      const retry =
        state.scopeFoldersStage === "awaiting" &&
        state.scopeFoldersEpoch === epoch &&
        !!state.scopeFoldersRequestId;
      const requestId = retry ? state.scopeFoldersRequestId! : randomUUID();
      return {
        documents: [],
        deletedExternalIds: [],
        hasMore: !retry,
        cursor: {
          ...withoutDriveFolderScopeCursor(state),
          scopeFoldersStage: "awaiting",
          scopeFoldersSnapshotId: randomUUID(),
          scopeFoldersEpoch: epoch,
          scopeFoldersRequestId: requestId,
          scopeFoldersActorId: actorId,
          scopeFoldersYieldToContent: false,
        } satisfies DriveSyncCursor,
        scopeUpdates: {
          refreshes: [
            {
              kind: "folder",
              active: true,
              requestId,
              ...(epoch !== undefined ? { epoch, restart: true } : {}),
            },
          ],
          readiness: [{ kind: "folder", complete: false }],
        },
      };
    }
    if (!state.scopeFoldersStage) {
      const snapshot = randomUUID();
      return {
        documents: [],
        deletedExternalIds: [],
        hasMore: true,
        cursor: {
          ...state,
          scopeFoldersStage: "anchor",
          scopeFoldersSnapshotId: snapshot,
          scopeFoldersEpoch: epoch,
          scopeFoldersActorId: actorId,
          scopeFoldersYieldToContent: false,
        } satisfies DriveSyncCursor,
        scopeUpdates: {
          hierarchy: {
            kind: "folder",
            refreshEpoch: epoch,
            snapshot: { id: snapshot, phase: "begin" },
          },
          refreshes: [{ kind: "folder", active: true, epoch }],
          readiness: [{ kind: "folder", complete: false }],
        },
      };
    }
    const snapshot = state.scopeFoldersSnapshotId!;
    let anchor = state.scopeFoldersAnchor;
    const roots: NonNullable<SourceScopeHierarchyUpdate["nodes"]> = [];
    if (state.scopeFoldersStage === "anchor") {
      const start = await this.drive.changes.getStartPageToken();
      anchor = start.data.startPageToken ?? undefined;
      if (!anchor)
        throw new SyncError("transient", "Drive did not return a metadata changes bookmark.");
      return {
        documents: [],
        deletedExternalIds: [],
        hasMore: true,
        cursor: {
          ...state,
          scopeFoldersAnchor: anchor,
          scopeFoldersStage: "start",
          scopeFoldersYieldToContent: true,
        } satisfies DriveSyncCursor,
        scopeUpdates: {
          refreshes: [{ kind: "folder", active: true, epoch }],
          readiness: [{ kind: "folder", complete: false }],
        },
      };
    }
    if (state.scopeFoldersStage === "start") {
      try {
        const root = await this.drive.files.get({
          fileId: "root",
          fields: DRIVE_SCOPE_FIELDS,
          supportsAllDrives: true,
        });
        const node = driveFolderNode(root.data, true);
        if (node) roots.push(node);
      } catch (error) {
        if (![403, 404].includes(googleApiStatus(error) ?? 0)) throw error;
      }
    }
    if (state.scopeFoldersStage === "start" || state.scopeFoldersStage === "scan") {
      let result;
      try {
        result = await this.drive.files.list({
          q: "trashed=false",
          spaces: "drive",
          pageSize: GOOGLE_PAGE_SIZE,
          pageToken: state.scopeFoldersPageToken,
          fields: `nextPageToken,incompleteSearch,files(${DRIVE_SCOPE_FIELDS})`,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
      } catch (error) {
        if (
          state.scopeFoldersStage !== "scan" ||
          ![400, 404, 410].includes(googleApiStatus(error) ?? 0)
        )
          throw error;
        return {
          documents: [],
          deletedExternalIds: [],
          hasMore: true,
          cursor: withoutDriveFolderScopeCursor(state),
          scopeUpdates: {
            refreshes: [{ kind: "folder", active: true, epoch }],
            readiness: [{ kind: "folder", complete: false }],
          },
        };
      }
      if (result.data.incompleteSearch)
        throw new SyncError(
          "transient",
          "Drive returned an incomplete metadata catalogue; retry the source refresh.",
        );
      const files = result.data.files ?? [];
      const driveIds = [
        ...new Set(files.map((file) => file.driveId).filter((id): id is string => !!id)),
      ];
      const shared = await pMap(
        driveIds,
        async (id) => {
          try {
            return driveFolderNode(
              (
                await this.drive.files.get({
                  fileId: id,
                  fields: DRIVE_SCOPE_FIELDS,
                  supportsAllDrives: true,
                })
              ).data,
              true,
            );
          } catch (error) {
            if (![403, 404].includes(googleApiStatus(error) ?? 0)) throw error;
            return undefined;
          }
        },
        { concurrency: GOOGLE_FETCH_CONCURRENCY },
      );
      const nodes = new Map(
        [
          ...roots,
          ...shared.filter((node): node is NonNullable<typeof node> => !!node),
          ...files
            .map((file) => driveFolderNode(file))
            .filter((node): node is NonNullable<typeof node> => !!node),
        ].map((node) => [node.id, node]),
      );
      const updates: SourceScopeUpdates = {
        hierarchy: {
          kind: "folder",
          refreshEpoch: epoch,
          snapshot: { id: snapshot, phase: "scan" },
          nodes: [...nodes.values()],
          documents: files
            .filter((file) => file.id && file.mimeType !== DRIVE_FOLDER_MIME)
            .map((file) => ({
              externalId: file.id!,
              ...driveDirectParents(file),
              refreshEpoch: epoch,
            })),
        },
        refreshes: [{ kind: "folder", active: true, epoch }],
        readiness: [{ kind: "folder", complete: false }],
      };
      return {
        documents: [],
        deletedExternalIds: [],
        scopeUpdates: updates,
        hasMore: true,
        cursor: {
          ...state,
          scopeFoldersAnchor: anchor,
          scopeFoldersStage: result.data.nextPageToken ? "scan" : "changes",
          scopeFoldersPageToken: result.data.nextPageToken ?? undefined,
          scopeFoldersYieldToContent: true,
        } satisfies DriveSyncCursor,
      };
    }
    try {
      const result = await this.drive.changes.list({
        pageToken: anchor,
        pageSize: GOOGLE_PAGE_SIZE,
        spaces: "drive",
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${DRIVE_SCOPE_FIELDS}))`,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      const nodes = new Map<string, NonNullable<SourceScopeHierarchyUpdate["nodes"]>[number]>();
      const documents = new Map<
        string,
        NonNullable<SourceScopeHierarchyUpdate["documents"]>[number]
      >();
      for (const change of result.data.changes ?? []) {
        if (!change.fileId) continue;
        if (change.removed || change.file?.trashed) {
          nodes.set(change.fileId, {
            id: change.fileId,
            label: change.fileId,
            parentIds: [],
            complete: false,
            deleted: true,
          });
          documents.set(change.fileId, {
            externalId: change.fileId,
            parentIds: [],
            complete: false,
            refreshEpoch: epoch,
          });
        } else if (change.file) {
          const node = driveFolderNode(change.file);
          if (node) nodes.set(node.id, node);
          else
            documents.set(change.fileId, {
              externalId: change.fileId,
              ...driveDirectParents(change.file),
              refreshEpoch: epoch,
            });
        }
      }
      const more = !!result.data.nextPageToken;
      const cursor: DriveSyncCursor = more
        ? {
            ...state,
            scopeFoldersAnchor: result.data.nextPageToken!,
            scopeFoldersYieldToContent: true,
          }
        : {
            ...withoutDriveFolderScopeCursor(state),
            scopeFoldersVersion: 1,
            scopeFoldersCompletedEpoch: epoch,
            scopeFoldersActorId: actorId,
          };
      return {
        documents: [],
        deletedExternalIds: [],
        hasMore: more,
        cursor,
        scopeUpdates: {
          hierarchy: {
            kind: "folder",
            refreshEpoch: epoch,
            nodes: [...nodes.values()],
            documents: [...documents.values()],
            snapshot: { id: snapshot, phase: more ? "scan" : "end" },
          },
          refreshes: [{ kind: "folder", active: more, epoch }],
          readiness: [{ kind: "folder", complete: !more }],
        },
      };
    } catch (error) {
      if (![404, 410].includes(googleApiStatus(error) ?? 0)) throw error;
      return {
        documents: [],
        deletedExternalIds: [],
        hasMore: true,
        cursor: withoutDriveFolderScopeCursor(state),
        scopeUpdates: {
          refreshes: [{ kind: "folder", active: true, epoch }],
          readiness: [{ kind: "folder", complete: false }],
        },
      };
    }
  }
}

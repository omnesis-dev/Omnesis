// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, vi } from "vitest";
import { createMockDrive, createDriveSource, makeDriveFile } from "./testing/mock-google.js";
import { DRIVE_FOLDER_MIME, driveDirectParents, driveFolderNode } from "./drive-scope-folders.js";
import type { DriveSyncCursor } from "./drive.js";
import type { SyncOptions, SyncResult } from "@omnesis/source-sdk";

const options: SyncOptions = {
  scopeFactsSupported: true,
  scopeHierarchySupported: true,
  scopeRefreshEpochsSupported: true,
  scopeRefreshEpochs: { folder: "cut-one" },
};
const existing: DriveSyncCursor = { phase: "incremental", startPageToken: "content-old" };
function state(result: SyncResult): DriveSyncCursor {
  return result.cursor as DriveSyncCursor;
}
function root(id = "native-root") {
  return { id, name: "Fictional Drive", mimeType: DRIVE_FOLDER_MIME };
}

it("interleaves ordinary history and bounded metadata while preserving a pinned catchup anchor and old ancestors", async () => {
  const drive = createMockDrive();
  const source = createDriveSource(drive, { dataCutoff: "2025-01-01T00:00:00Z" });
  drive.files.get = vi.fn(async () => ({ data: root() }));
  drive.files.export = vi.fn(async () => ({ data: "Invented observation log" }));
  drive.changes.getStartPageToken = vi.fn(async () => ({
    data: { startPageToken: "metadata-anchor" },
  }));
  let ordinary = 0;
  drive.changes.list = vi.fn(async (args: { pageToken: string; fields: string }) => {
    if (args.fields.includes("permissions")) {
      ordinary++;
      return {
        data: {
          changes:
            ordinary === 1
              ? [
                  {
                    fileId: "new-file",
                    file: makeDriveFile({
                      id: "new-file",
                      parents: ["old-leaf"],
                      createdTime: "2026-01-01T00:00:00Z",
                    }),
                  },
                ]
              : [],
          newStartPageToken: `content-new-${ordinary}`,
        },
      };
    }
    expect(args.pageToken).toBe("metadata-anchor");
    return {
      data: {
        changes: [
          {
            fileId: "old-leaf",
            file: {
              id: "old-leaf",
              name: "Moved leaf",
              mimeType: DRIVE_FOLDER_MIME,
              parents: ["other-root"],
            },
          },
        ],
        newStartPageToken: "metadata-caught-up",
      },
    };
  });
  drive.files.list = vi.fn(async (args: { q: string; fields: string }) => {
    expect(args.q).toBe("trashed=false");
    expect(args.fields).toContain("parents");
    return {
      data: {
        files: [
          {
            id: "old-leaf",
            name: "Old ancestor",
            mimeType: DRIVE_FOLDER_MIME,
            parents: ["native-root"],
            createdTime: "2010-01-01T00:00:00Z",
          },
          makeDriveFile({ id: "older-stored", parents: ["old-leaf"] }),
        ],
      },
    };
  });
  const start = await source.sync(existing, { ...options, scopeRefreshEpochs: undefined });
  expect(start.scopeUpdates?.refreshes).toEqual([
    { kind: "folder", active: true, requestId: state(start).scopeFoldersRequestId },
  ]);
  expect(drive.files.list).not.toHaveBeenCalled();
  const acknowledged = {
    ...options,
    scopeRefreshRequestIds: { folder: state(start).scopeFoldersRequestId! },
  };
  const assigned = await source.sync(state(start), acknowledged);
  const anchored = await source.sync(state(assigned), options);
  const content = await source.sync(state(anchored), options);
  expect(content.documents.map((doc) => doc.externalId)).toEqual(["new-file"]);
  expect(content.documents[0]!.metadata.scopeHierarchy).toEqual([
    { kind: "folder", parentIds: ["old-leaf"], complete: true, refreshEpoch: "cut-one" },
  ]);
  const scan = await source.sync(state(content), options);
  expect(scan.documents).toEqual([]);
  expect(scan.scopeUpdates?.hierarchy?.nodes?.map((node) => node.id)).toEqual([
    "native-root",
    "old-leaf",
  ]);
  expect(scan.scopeUpdates?.hierarchy?.documents?.[0]).toMatchObject({
    externalId: "older-stored",
    parentIds: ["old-leaf"],
    refreshEpoch: "cut-one",
  });
  const nextContent = await source.sync(state(scan), options);
  expect(state(nextContent).startPageToken).toBe("content-new-2");
  const caught = await source.sync(state(nextContent), options);
  expect(caught.documents).toEqual([]);
  expect(caught.scopeUpdates?.hierarchy?.nodes?.[0]).toMatchObject({
    id: "old-leaf",
    parentIds: ["other-root"],
  });
  expect(caught.scopeUpdates?.refreshes).toEqual([
    { kind: "folder", active: false, epoch: "cut-one" },
  ]);
  expect(state(caught).startPageToken).toBe("content-new-2");
  expect(state(caught).scopeFoldersVersion).toBe(1);
  expect(drive.files.export).toHaveBeenCalledTimes(1);
});

it("follows folder-only moves/renames/recreation without fetching descendant content", async () => {
  const drive = createMockDrive();
  const source = createDriveSource(drive);
  const cursor: DriveSyncCursor = {
    ...existing,
    scopeFoldersVersion: 1,
    scopeFoldersCompletedEpoch: "cut-one",
  };
  drive.changes.list = vi.fn(async () => ({
    data: {
      changes: [
        {
          fileId: "stable-folder",
          file: {
            id: "stable-folder",
            name: "Renamed folder",
            mimeType: DRIVE_FOLDER_MIME,
            parents: ["new-parent"],
          },
        },
      ],
      newStartPageToken: "next",
    },
  }));
  const moved = await source.sync(cursor, options);
  expect(moved.documents).toEqual([]);
  expect(moved.scopeUpdates?.hierarchy?.nodes).toEqual([
    { id: "stable-folder", label: "Renamed folder", parentIds: ["new-parent"], complete: true },
  ]);
  expect(drive.files.export).not.toHaveBeenCalled();
  expect(drive.files.get).not.toHaveBeenCalled();
  drive.changes.list = vi.fn(async () => ({
    data: {
      changes: [
        {
          fileId: "new-folder",
          file: {
            id: "new-folder",
            name: "Renamed folder",
            mimeType: DRIVE_FOLDER_MIME,
            parents: ["new-parent"],
          },
        },
      ],
      newStartPageToken: "next-two",
    },
  }));
  expect((await source.sync(state(moved), options)).scopeUpdates?.hierarchy?.nodes?.[0]?.id).toBe(
    "new-folder",
  );
});

it("emits no hierarchy fields to old gateways, revokes through v1 controls on partial rollback, and refreshes after support returns", async () => {
  const drive = createMockDrive();
  const source = createDriveSource(drive);
  const done: DriveSyncCursor = {
    ...existing,
    scopeFoldersVersion: 1,
    scopeFoldersCompletedEpoch: "cut-one",
  };
  const legacy = await source.sync(done);
  expect(legacy.scopeUpdates).toBeUndefined();
  expect(JSON.stringify(legacy)).not.toContain("scopeFolders");
  expect(drive.changes.list.mock.calls[0][0].fields).not.toContain("parents");
  const partial = await source.sync(done, { scopeFactsSupported: true });
  expect(partial.scopeUpdates).toEqual({
    refreshes: [{ kind: "folder", active: true }],
    readiness: [{ kind: "folder", complete: false }],
  });
  expect(JSON.stringify(partial)).not.toContain("hierarchy");
  const resumed = await source.sync(state(partial), options);
  expect(state(resumed).scopeFoldersStage).toBe("awaiting");
  expect(resumed.scopeUpdates?.refreshes).toEqual([
    {
      kind: "folder",
      active: true,
      epoch: "cut-one",
      restart: true,
      requestId: state(resumed).scopeFoldersRequestId,
    },
  ]);
});

it("rejects incomplete scans under an already-published refresh fence and restarts expired metadata cuts", async () => {
  const drive = createMockDrive();
  const source = createDriveSource(drive);
  drive.files.get = vi.fn(async () => ({ data: root() }));
  const begin = await source.sync(existing, { ...options, scopeRefreshEpochs: undefined });
  const assigned = await source.sync(state(begin), {
    ...options,
    scopeRefreshRequestIds: { folder: state(begin).scopeFoldersRequestId! },
  });
  const anchored = await source.sync(state(assigned), options);
  const ordinary = await source.sync(state(anchored), options);
  drive.files.list = vi.fn(async () => ({ data: { files: [], incompleteSearch: true } }));
  await expect(source.sync(state(ordinary), options)).rejects.toMatchObject({ kind: "transient" });
  expect(state(ordinary).scopeFoldersStage).toBe("start");
  const expired: DriveSyncCursor = {
    ...existing,
    scopeFoldersStage: "changes",
    scopeFoldersSnapshotId: "old-cut",
    scopeFoldersAnchor: "expired",
    scopeFoldersEpoch: "cut-one",
  };
  drive.changes.list = vi.fn(async () => {
    throw Object.assign(new Error("Expired metadata bookmark"), { code: 410 });
  });
  const reset = await source.sync(expired, options);
  expect(reset.scopeUpdates?.refreshes).toEqual([
    { kind: "folder", active: true, epoch: "cut-one" },
  ]);
  expect(state(reset).scopeFoldersStage).toBeUndefined();
});

it("honors a new required epoch despite completed or interrupted bookmarks preserved by an old collector", async () => {
  const drive = createMockDrive();
  const source = createDriveSource(drive);
  const old: DriveSyncCursor = {
    ...existing,
    scopeFoldersVersion: 1,
    scopeFoldersCompletedEpoch: "old-epoch",
  };
  const restarted = await source.sync(old, options);
  expect(state(restarted).scopeFoldersEpoch).toBe("cut-one");
  expect(state(restarted).scopeFoldersStage).toBe("awaiting");
  const newer = await source.sync(state(restarted), {
    ...options,
    scopeRefreshEpochs: { folder: "cut-two" },
  });
  expect(state(newer).scopeFoldersEpoch).toBe("cut-two");
  expect(state(newer).scopeFoldersSnapshotId).not.toBe(state(restarted).scopeFoldersSnapshotId);
  expect(state(newer).startPageToken).toBe("content-old");
});

it("invalidates hierarchy coverage before recovering from a refused changes token", async () => {
  const drive = createMockDrive();
  const source = createDriveSource(drive);
  drive.changes.list = vi.fn(async () => {
    throw Object.assign(new Error("refused changes token"), {
      code: 400,
      errors: [{ domain: "global", reason: "invalid", location: "pageToken" }],
    });
  });
  const result = await source.sync(
    { ...existing, scopeFoldersVersion: 1, scopeFoldersCompletedEpoch: "cut-one" },
    options,
  );
  expect(result.documents).toEqual([]);
  expect(state(result).phase).toBe("bootstrap");
  expect(state(result).scopeFoldersVersion).toBeUndefined();
  expect(result.scopeUpdates?.refreshes).toEqual([{ kind: "folder", active: true }]);
  expect(drive.files.list).not.toHaveBeenCalled();
});

it("requires the requesting actor nonce before observing a replacement cut and retries the same pending request", async () => {
  const drive = createMockDrive();
  const source = createDriveSource(drive);
  const first = await source.sync(existing, { ...options, scopeRefreshActorId: "actor-a" });
  const retry = await source.sync(state(first), { ...options, scopeRefreshActorId: "actor-a" });
  expect(state(retry).scopeFoldersRequestId).toBe(state(first).scopeFoldersRequestId);
  expect(retry.hasMore).toBe(false);
  const wrong = await source.sync(state(retry), {
    ...options,
    scopeRefreshEpochs: { folder: "cut-two" },
    scopeRefreshActorId: "actor-a",
  });
  expect(state(wrong).scopeFoldersStage).toBe("awaiting");
  expect(state(wrong).scopeFoldersRequestId).not.toBe(state(first).scopeFoldersRequestId);
  expect(drive.files.list).not.toHaveBeenCalled();
  const foreign = await source.sync(state(wrong), {
    ...options,
    scopeRefreshEpochs: { folder: "cut-three" },
    scopeRefreshRequestIds: { folder: state(wrong).scopeFoldersRequestId! },
    scopeRefreshActorId: "actor-b",
  });
  expect(state(foreign).scopeFoldersStage).toBe("awaiting");
  expect(foreign.scopeUpdates?.hierarchy).toBeUndefined();
});

it("abandons an expired catalogue page without rewinding ordinary content history", async () => {
  const drive = createMockDrive();
  const source = createDriveSource(drive);
  drive.files.list = vi.fn(async () => {
    throw Object.assign(new Error("Expired page token"), { code: 400 });
  });
  const result = await source.sync(
    {
      ...existing,
      scopeFoldersStage: "scan",
      scopeFoldersEpoch: "cut-one",
      scopeFoldersSnapshotId: "snapshot",
      scopeFoldersAnchor: "anchor",
      scopeFoldersPageToken: "expired",
    },
    options,
  );
  expect(state(result).scopeFoldersStage).toBeUndefined();
  expect(state(result).startPageToken).toBe("content-old");
  expect(result.scopeUpdates?.refreshes).toEqual([
    { kind: "folder", active: true, epoch: "cut-one" },
  ]);
  const restart = await source.sync(state(result), options);
  expect(restart.scopeUpdates?.refreshes?.[0]).toMatchObject({
    epoch: "cut-one",
    restart: true,
    requestId: expect.any(String),
  });
});

it("leaves global metadata refresh and catalogue controls to the lease holder", async () => {
  const drive = createMockDrive();
  const source = createDriveSource(drive);
  const result = await source.sync(existing, {
    ...options,
    run: { id: "fictional-run", reason: "scheduled", start: "resume", page: 0, role: "member" },
  });
  expect(result.scopeUpdates).toBeUndefined();
  expect(drive.files.list).not.toHaveBeenCalled();
  expect(drive.changes.list).toHaveBeenCalledTimes(1);
});

it("places an item Drive reports no parents for in no folder, as a complete answer", async () => {
  expect(driveDirectParents({ id: "shared-note", mimeType: "text/plain" })).toEqual({
    parentIds: [],
    complete: true,
  });
  expect(
    driveFolderNode({ id: "shared-folder", name: "Shared notes", mimeType: DRIVE_FOLDER_MIME }),
  ).toEqual({ id: "shared-folder", label: "Shared notes", parentIds: [], complete: true });
  expect(driveDirectParents({ id: "odd-note", parents: [""] })).toEqual({
    parentIds: [],
    complete: false,
  });

  const drive = createMockDrive();
  const source = createDriveSource(drive);
  drive.changes.list = vi.fn(() =>
    Promise.resolve({
      data: {
        changes: [
          {
            fileId: "shared-note",
            file: { id: "shared-note", name: "Shared note", mimeType: "text/plain" },
          },
        ],
        newStartPageToken: "next",
      },
    }),
  );
  const shared = await source.sync(
    { ...existing, scopeFoldersVersion: 1, scopeFoldersCompletedEpoch: "cut-one" },
    options,
  );
  expect(drive.changes.list.mock.calls[0]![0].fields).toContain("parents");
  expect(shared.scopeUpdates?.hierarchy?.documents).toEqual([
    { externalId: "shared-note", parentIds: [], complete: true, refreshEpoch: "cut-one" },
  ]);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { google } from "googleapis";
import { afterEach, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { DRIVE_FOLDER_MIME } from "./drive-scope-folders.js";
import { createMockDrive, makeDriveFile } from "./testing/mock-google.js";
import googleProvider, { GoogleDriveSource } from "./index.js";
import type { SyncOptions } from "@omnesis/source-sdk";
import type { DriveSyncCursor } from "./drive.js";
import type { GoogleProvider } from "./provider.js";

afterEach(() => vi.restoreAllMocks());

const accountId = "factory-reader@example.org";
const contentCursor: DriveSyncCursor = { phase: "incremental", startPageToken: "content-cut" };

async function createThroughProvider() {
  const drive = createMockDrive();
  vi.spyOn(google, "drive").mockReturnValue(drive);
  const definition = googleProvider.sources.find((source) => source.id === "google-drive")!;
  const source = await definition.create!(
    {
      accountId,
      sourceId: SourceId(`google-drive:${accountId}`),
      providerId: ProviderId(`google:${accountId}`),
    },
    { accountId, auth: new google.auth.OAuth2(), provider: {} as GoogleProvider },
  );
  return { source, drive };
}

test("the provider-created Drive publishes a nonce-bound folder refresh and native file parents", async () => {
  const { source, drive } = await createThroughProvider();
  const nativeSync = vi.spyOn(GoogleDriveSource.prototype, "sync");
  const file = makeDriveFile({ id: "workshop-note", parents: ["workshop-folder"] });
  const folder = {
    id: "workshop-folder",
    name: "Workshop notes",
    mimeType: DRIVE_FOLDER_MIME,
    parents: ["drive-root"],
  };
  drive.files.get = vi.fn(() =>
    Promise.resolve({
      data: { id: "drive-root", name: "Drive root", mimeType: DRIVE_FOLDER_MIME },
    }),
  );
  drive.files.list = vi.fn(() => Promise.resolve({ data: { files: [folder, file] } }));
  drive.files.export = vi.fn(() => Promise.resolve({ data: "Invented workshop agenda" }));
  drive.changes.list = vi.fn((args: { fields: string }) =>
    Promise.resolve({
      data: {
        changes: args.fields.includes("permissions") ? [{ fileId: file.id, file }] : [],
        newStartPageToken: "current-content-cut",
      },
    }),
  );
  const options: SyncOptions = {
    scopeFactsSupported: true,
    scopeHierarchySupported: true,
    scopeRefreshEpochsSupported: true,
    scopeRefreshEpochs: { folder: "previous-cut" },
    scopeRefreshActorId: "registered-collector",
    signal: new AbortController().signal,
  };

  const requested = await source.sync(contentCursor, options);
  const forwardedOptions = nativeSync.mock.calls[0]?.[1];
  nativeSync.mockRestore();
  expect(requested.documents).toEqual([]);
  const requestCursor = requested.cursor as DriveSyncCursor;
  expect(requestCursor).toMatchObject({
    ...contentCursor,
    scopeFoldersStage: "awaiting",
    scopeFoldersActorId: options.scopeRefreshActorId,
  });
  expect(requestCursor.scopeFoldersRequestId).toEqual(expect.any(String));
  expect(requested.scopeUpdates?.refreshes).toEqual([
    {
      kind: "folder",
      active: true,
      requestId: requestCursor.scopeFoldersRequestId,
      epoch: "previous-cut",
      restart: true,
    },
  ]);
  expect(forwardedOptions).toBe(options);
  expect(drive.changes.list).not.toHaveBeenCalled();

  const acknowledged: SyncOptions = {
    ...options,
    scopeRefreshEpochs: { folder: "accepted-cut" },
    scopeRefreshRequestIds: { folder: requestCursor.scopeFoldersRequestId! },
  };
  const accepted = await source.sync(requested.cursor, acknowledged);
  expect(accepted.scopeUpdates?.hierarchy).toMatchObject({
    kind: "folder",
    refreshEpoch: "accepted-cut",
    snapshot: { phase: "begin" },
  });
  const anchored = await source.sync(accepted.cursor, acknowledged);
  const content = await source.sync(anchored.cursor, acknowledged);
  expect(content.documents).toHaveLength(1);
  expect(content.documents[0]).toMatchObject({
    externalId: "workshop-note",
    metadata: {
      scopeHierarchy: [
        {
          kind: "folder",
          parentIds: ["workshop-folder"],
          complete: true,
          refreshEpoch: "accepted-cut",
        },
      ],
    },
  });
  const catalogue = await source.sync(content.cursor, acknowledged);
  expect(catalogue.scopeUpdates?.hierarchy?.nodes).toContainEqual({
    id: "workshop-folder",
    label: "Workshop notes",
    parentIds: ["drive-root"],
    complete: true,
  });
  expect(catalogue.scopeUpdates?.hierarchy?.documents).toContainEqual({
    externalId: "workshop-note",
    parentIds: ["workshop-folder"],
    complete: true,
    refreshEpoch: "accepted-cut",
  });
  const resumed = await source.sync(catalogue.cursor, acknowledged);
  const completed = await source.sync(resumed.cursor, acknowledged);
  expect(completed.scopeUpdates?.refreshes).toEqual([
    { kind: "folder", active: false, epoch: "accepted-cut" },
  ]);
  expect(completed.cursor).toMatchObject({
    phase: "incremental",
    startPageToken: "current-content-cut",
    scopeFoldersVersion: 1,
    scopeFoldersCompletedEpoch: "accepted-cut",
    scopeFoldersActorId: "registered-collector",
  });
});

test("the provider-created Drive preserves content but omits native scope fields without support", async () => {
  const { source, drive } = await createThroughProvider();
  drive.changes.list = vi.fn(() =>
    Promise.resolve({
      data: {
        changes: [
          {
            fileId: "legacy-note",
            file: makeDriveFile({ id: "legacy-note", parents: ["folder"] }),
          },
        ],
        newStartPageToken: "next-content-cut",
      },
    }),
  );
  drive.files.export = vi.fn(() => Promise.resolve({ data: "Invented legacy note" }));
  const result = await source.sync(
    {
      ...contentCursor,
      scopeFoldersVersion: 1,
      scopeFoldersCompletedEpoch: "older-cut",
      scopeFoldersActorId: "registered-collector",
    },
    { scopeFactsSupported: false, scopeHierarchySupported: false },
  );

  expect(result.documents.map((document) => document.externalId)).toEqual(["legacy-note"]);
  expect(result.documents[0]!.metadata.scopeHierarchy).toBeUndefined();
  expect(result.scopeUpdates).toBeUndefined();
  expect(result.cursor).toEqual({ phase: "incremental", startPageToken: "next-content-cut" });
  expect(drive.changes.list.mock.calls[0][0].fields).not.toContain("parents");
});

test("the provider-created Drive withholds folder readiness when only basic facts are negotiated", async () => {
  const { source } = await createThroughProvider();
  const result = await source.sync(contentCursor, {
    scopeFactsSupported: true,
    scopeHierarchySupported: false,
  });
  expect(result.scopeUpdates).toEqual({
    refreshes: [{ kind: "folder", active: true }],
    readiness: [{ kind: "folder", complete: false }],
  });
  expect(result.cursor).toEqual({ phase: "incremental", startPageToken: "start-token-2" });
});

test("the provider-created Drive renews catalogue readiness after an observed incremental catchup", async () => {
  const { source, drive } = await createThroughProvider();
  const result = await source.sync(
    {
      ...contentCursor,
      scopeFoldersVersion: 1,
      scopeFoldersCompletedEpoch: "current-cut",
      scopeFoldersActorId: "registered-collector",
    },
    {
      scopeFactsSupported: true,
      scopeHierarchySupported: true,
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs: { folder: "current-cut" },
      scopeRefreshActorId: "registered-collector",
    },
  );
  expect(drive.changes.list).toHaveBeenCalledTimes(1);
  expect(result.hasMore).toBe(false);
  expect(result.scopeUpdates?.readiness).toEqual([{ kind: "folder", complete: true }]);
  expect(result.cursor).toMatchObject({
    scopeFoldersCompletedEpoch: "current-cut",
    scopeFoldersActorId: "registered-collector",
  });
});

test.each([
  "member",
  "unsupported",
  "stale-epoch",
  "other-actor",
  "more-changes",
  "bootstrap",
  "no-epoch",
  "no-actor",
  "no-content-bookmark",
  "no-terminal-receipt",
] as const)("the provider-created Drive does not renew readiness for %s", async (scenario) => {
  const { source, drive } = await createThroughProvider();
  if (scenario === "more-changes")
    drive.changes.list = vi.fn(() =>
      Promise.resolve({ data: { changes: [], nextPageToken: "more-native-changes" } }),
    );
  if (scenario === "no-terminal-receipt")
    drive.changes.list = vi.fn(() => Promise.resolve({ data: { changes: [] } }));
  const result = await source.sync(
    {
      ...contentCursor,
      ...(scenario === "no-content-bookmark" ? { startPageToken: undefined } : {}),
      phase: scenario === "bootstrap" ? "bootstrap" : "incremental",
      scopeFoldersVersion: 1,
      scopeFoldersCompletedEpoch: "current-cut",
      scopeFoldersActorId: "registered-collector",
    },
    {
      scopeFactsSupported: true,
      scopeHierarchySupported: scenario !== "unsupported",
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs:
        scenario === "no-epoch"
          ? undefined
          : {
              folder: scenario === "stale-epoch" ? "new-required-cut" : "current-cut",
            },
      scopeRefreshActorId:
        scenario === "no-actor"
          ? undefined
          : scenario === "other-actor"
            ? "another-collector"
            : "registered-collector",
      ...(scenario === "member"
        ? {
            run: {
              id: "member-attempt",
              reason: "boot" as const,
              start: "resume" as const,
              page: 0,
              role: "member" as const,
            },
          }
        : {}),
    },
  );
  expect(result.scopeUpdates?.readiness?.some((state) => state.complete)).not.toBe(true);
  if (scenario === "stale-epoch" || scenario === "other-actor") {
    expect(result.scopeUpdates?.refreshes?.[0]?.active).toBe(true);
    expect(drive.changes.list).not.toHaveBeenCalled();
  }
});

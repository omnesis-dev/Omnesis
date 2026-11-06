// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDriveFixtureSource } from "./drive-source.js";
import type { DriveFileEntry } from "./fixtures.js";

const context = {
  sourceId: SourceId("google-drive:fictional@example.com"),
  providerId: ProviderId("google:fictional@example.com"),
};
const file: DriveFileEntry = {
  externalId: "file",
  name: "Invented observatory notes",
  mimeType: "text/plain",
  content: "Fictional star observations",
  owner: "self",
  createdAt: "2026-01-01T00:00:00Z",
  modifiedAt: "2026-01-01T00:00:00Z",
  parentIds: ["leaf"],
};
it("shares native folder identity and emits folder moves without descendant content", async () => {
  const folders = [
    { id: "root", name: "Fictional Drive", parentIds: [] as string[] },
    { id: "leaf", name: "Observations", parentIds: ["root"] },
  ];
  const source = createDriveFixtureSource([file], folders, context);
  const options = {
    scopeHierarchySupported: true,
    scopeRefreshEpochsSupported: true,
    scopeRefreshActorId: "actor-a",
  };
  const pending = await source.sync(null, options);
  const requestId = pending.scopeUpdates!.refreshes![0]!.requestId!;
  const assigned = {
    ...options,
    scopeRefreshEpochs: { folder: "cut-one" },
    scopeRefreshRequestIds: { folder: requestId },
  };
  const begin = await source.sync(pending.cursor, assigned);
  expect(begin.scopeUpdates?.hierarchy?.snapshot?.phase).toBe("begin");
  const scan = await source.sync(begin.cursor, assigned);
  expect(scan.documents[0]?.metadata.scopeHierarchy).toEqual([
    { kind: "folder", parentIds: ["leaf"], complete: true, refreshEpoch: "cut-one" },
  ]);
  expect(scan.scopeUpdates?.hierarchy?.nodes?.map((node) => node.id)).toEqual(["root", "leaf"]);
  folders[1]!.parentIds = [];
  folders[1]!.name = "Renamed observations";
  const moved = await source.sync(scan.cursor, assigned);
  expect(moved.documents).toEqual([]);
  expect(moved.scopeUpdates?.hierarchy?.nodes).toEqual([
    { id: "leaf", label: "Renamed observations", parentIds: [], complete: true },
  ]);
  const foreign = await source.sync(moved.cursor, { ...assigned, scopeRefreshActorId: "actor-b" });
  expect(foreign.scopeUpdates?.hierarchy).toBeUndefined();
  expect(foreign.scopeUpdates?.refreshes?.[0]?.restart).toBe(true);
});
it("omits new native fields on a legacy gateway and preserves the ordinary offset", async () => {
  const source = createDriveFixtureSource([file], [], context);
  const result = await source.sync({ offset: 0, scopeFixtureReady: true } as never);
  expect(result.scopeUpdates).toBeUndefined();
  expect(result.documents[0]?.metadata.scopeHierarchy).toBeUndefined();
  expect(JSON.stringify(result.cursor)).not.toContain("scopeFixture");
});

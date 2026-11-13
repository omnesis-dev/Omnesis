// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { repoFixtureSource } from "./repo-source.js";
import type { SyncOptions } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";

interface Entry {
  repo: string;
  key: string;
}
const WORK = "northstar-labs/atlas-api";
const PERSONAL = "maya-reeves/garden-notes";
const repos = [
  { full_name: WORK, id: 4101, owner: { id: 9001, login: "northstar-labs" } },
  { full_name: PERSONAL, id: 5201, owner: { id: 7001, login: "maya-reeves" } },
];
const entries: Entry[] = [
  ...Array.from({ length: 7 }, (_, index) => ({ repo: WORK, key: `work-${index}` })),
  { repo: PERSONAL, key: "personal-0" },
  { repo: "maya-reeves/sketches", key: "unlisted-0" },
];
const document = (entry: Entry): DocumentInput =>
  ({
    providerId: "github:maya-reeves",
    sourceId: "github:maya-reeves",
    externalId: `${entry.repo}/issues/${entry.key}`,
    title: `Invented ${entry.key}`,
    content: `Invented body of ${entry.key}`,
    contentHash: entry.key,
    metadata: { documentType: "conversation" },
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
  }) as DocumentInput;
const source = () => repoFixtureSource("github:maya-reeves", repos, entries, document);
const supported: SyncOptions = {
  scopeFactsSupported: true,
  scopeHierarchySupported: true,
  scopeRefreshEpochsSupported: true,
  scopeRefreshActorId: "actor-a",
};

it("runs the provider's refresh over the fixture: the tree, the repository on each document, and every stored document listed", async () => {
  const twin = source();
  const ask = await twin.sync(null, supported);
  expect(ask.documents).toEqual([]);
  expect(ask.scopeUpdates?.refreshes).toMatchObject([{ kind: "folder", active: true }]);
  const restart = await twin.sync(ask.cursor, {
    ...supported,
    scopeRefreshEpochs: { folder: "cut-one" },
  });
  expect(restart.scopeUpdates?.refreshes).toMatchObject([
    { kind: "folder", active: true, epoch: "cut-one", restart: true },
  ]);
  const assigned: SyncOptions = {
    ...supported,
    scopeRefreshEpochs: { folder: "cut-two" },
    scopeRefreshRequestIds: { folder: restart.scopeUpdates!.refreshes![0]!.requestId! },
  };
  const first = await twin.sync(restart.cursor, assigned);
  expect(first.scopeUpdates?.hierarchy).toMatchObject({
    refreshEpoch: "cut-two",
    snapshot: { phase: "begin" },
    nodes: [
      { id: "owner:9001", label: "northstar-labs", parentIds: [] },
      { id: "owner:7001", label: "maya-reeves", parentIds: [] },
      { id: "repo:4101", label: WORK, parentIds: ["owner:9001"] },
      { id: "repo:5201", label: PERSONAL, parentIds: ["owner:7001"] },
    ],
  });
  expect(first.scopeUpdates?.hierarchy?.documents).toHaveLength(entries.length);
  expect(first.scopeUpdates?.hierarchy?.documents?.at(-1)).toEqual({
    externalId: "maya-reeves/sketches/issues/unlisted-0",
    parentIds: [],
    complete: false,
    refreshEpoch: "cut-two",
  });
  expect(first.documents.map((doc) => doc.metadata.scopeHierarchy?.[0]?.parentIds)).toEqual(
    Array.from({ length: 5 }, () => ["repo:4101"]),
  );
  expect(first.hasMore).toBe(true);
  const last = await twin.sync(first.cursor, assigned);
  expect(last.documents.map((doc) => doc.metadata.scopeHierarchy?.[0])).toEqual([
    { kind: "folder", parentIds: ["repo:4101"], complete: true, refreshEpoch: "cut-two" },
    { kind: "folder", parentIds: ["repo:4101"], complete: true, refreshEpoch: "cut-two" },
    { kind: "folder", parentIds: ["repo:5201"], complete: true, refreshEpoch: "cut-two" },
    { kind: "folder", parentIds: [], complete: false, refreshEpoch: "cut-two" },
  ]);
  expect(last.hasMore).toBe(false);
  expect(last.presentExternalIds).toHaveLength(entries.length);
  expect(last.scopeUpdates).toMatchObject({
    hierarchy: { snapshot: { phase: "end" } },
    refreshes: [{ kind: "folder", active: false, epoch: "cut-two" }],
    readiness: [{ kind: "folder", complete: true }],
  });
  const quiet = await twin.sync(last.cursor, assigned);
  expect(quiet.scopeUpdates).toBeUndefined();
  expect(quiet.cursor).toEqual(last.cursor);
});

it("pages exactly as before for a gateway that takes no filter facts", async () => {
  const twin = source();
  const first = await twin.sync(null);
  expect(first.scopeUpdates).toBeUndefined();
  expect(first.documents).toHaveLength(5);
  expect(first.documents[0]?.metadata.scopeHierarchy).toBeUndefined();
  expect(first.cursor).toEqual({ offset: 5 });
  const last = await twin.sync({ ...first.cursor, scopeReposAsked: true });
  expect(last.cursor).toEqual({ offset: entries.length });
  expect(last.presentExternalIds).toHaveLength(entries.length);
});

it("attributes a fixture that was paged to its end before filter facts were taken, opening and closing the snapshot on separate pages", async () => {
  const twin = source();
  let stored = (await twin.sync(null)).cursor;
  stored = (await twin.sync(stored)).cursor;
  expect(stored).toEqual({ offset: entries.length });

  const ask = await twin.sync(stored, supported);
  const restart = await twin.sync(ask.cursor, {
    ...supported,
    scopeRefreshEpochs: { folder: "cut-one" },
  });
  const assigned: SyncOptions = {
    ...supported,
    scopeRefreshEpochs: { folder: "cut-two" },
    scopeRefreshRequestIds: { folder: restart.scopeUpdates!.refreshes![0]!.requestId! },
  };
  const pages = [];
  let cursor = restart.cursor;
  for (;;) {
    const page = await twin.sync(cursor, assigned);
    pages.push(page);
    cursor = page.cursor;
    if (!page.hasMore) break;
    expect(pages.length).toBeLessThan(10);
  }
  // No record is sent again; every stored one is listed under its repository.
  expect(pages.flatMap((page) => page.documents)).toEqual([]);
  expect(pages.map((page) => page.scopeUpdates?.hierarchy?.snapshot?.phase)).toEqual([
    "begin",
    "end",
  ]);
  const listed = pages.flatMap((page) => page.scopeUpdates?.hierarchy?.documents ?? []);
  expect(listed.map((item) => item.externalId).sort()).toEqual(
    entries.map((entry) => document(entry).externalId).sort(),
  );
  expect(listed.filter((item) => item.complete)).toHaveLength(entries.length - 1);
  expect(pages.at(-1)!.scopeUpdates).toMatchObject({
    refreshes: [{ kind: "folder", active: false, epoch: "cut-two" }],
    readiness: [{ kind: "folder", complete: true }],
  });
});

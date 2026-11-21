// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { collectFilterList, type SourceInstance, type SyncCursor } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";

const state = vi.hoisted(() => ({ fixture: {} as unknown }));
vi.mock("@omnesis/providers-synth-common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnesis/providers-synth-common")>()),
  loadSourceFixtureJson: () => state.fixture,
  loadActiveUniverse: () => ({}),
  universeAccounts: () => ["northstar"],
}));
import source, { FILING_FOLDERS_FIELD, FILING_GROUP_FIELD, getFilingCabinet } from "./index.js";

const SOURCE_ID = "filing:northstar";
const instances: SourceInstance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose?.();
});

async function create(): Promise<SourceInstance> {
  const instance = await source.create!({
    sourceId: SourceId(SOURCE_ID),
    providerId: ProviderId(SOURCE_ID),
    accountId: "northstar",
    sourceConfig: {},
  } as never);
  instances.push(instance);
  return instance;
}

async function drain(instance: SourceInstance) {
  const documents = [];
  let cursor: SyncCursor | null = null;
  let result;
  do {
    result = await instance.sync(cursor);
    documents.push(...result.documents);
    cursor = result.cursor;
  } while (result.hasMore);
  return documents;
}

const list = (instance: SourceInstance, field: string) =>
  collectFilterList(instance.filterLists![field]!, { signal: new AbortController().signal });

describe("the filing twin", () => {
  beforeEach(() => {
    state.fixture = {
      folders: [
        { id: "f-work", name: "Work" },
        { id: "f-atlas", name: "Atlas API", parentId: "f-work" },
        { id: "f-budget", name: "Budget", parentId: "f-atlas" },
      ],
      groups: [
        {
          id: "g-team",
          name: "Atlas team",
          members: [{ type: "email", value: "maya.reeves@example.com" }],
        },
      ],
      notes: [
        {
          id: "note-1",
          title: "Atlas API rate limits",
          text: "Sixty requests a minute per key.",
          folderIds: ["f-atlas"],
          groupId: "g-team",
          createdAt: "2026-03-02T09:15:00.000Z",
        },
        {
          id: "note-2",
          title: "Unfiled",
          text: "Filed nowhere.",
          folderIds: [],
          groupId: "g-team",
          createdAt: "2026-03-03T09:15:00.000Z",
        },
      ],
    };
  });

  test("declares its two fields as filterable, in the profile a collector publishes", () => {
    const fields = source.documentEventProfile?.metadataFields ?? [];
    expect(fields.map((field) => [field.path, field.filter?.capability])).toEqual([
      [FILING_FOLDERS_FIELD, "tree"],
      [FILING_GROUP_FIELD, "membership"],
    ]);
  });

  test("writes the ids a note belongs to into the note, an empty list when it is filed nowhere", async () => {
    const documents = await drain(await create());
    expect(documents.map((doc) => doc.metadata.extra)).toEqual([
      { folderIds: ["f-atlas"], groupId: "g-team" },
      { folderIds: [], groupId: "g-team" },
    ]);
  });

  test("lists its folders as a tree and its groups with their members", async () => {
    const instance = await create();
    expect(await list(instance, FILING_FOLDERS_FIELD)).toEqual([
      { id: "f-atlas", label: "Atlas API", parentId: "f-work" },
      { id: "f-budget", label: "Budget", parentId: "f-atlas" },
      { id: "f-work", label: "Work" },
    ]);
    expect(await list(instance, FILING_GROUP_FIELD)).toEqual([
      {
        id: "g-team",
        label: "Atlas team",
        members: [{ type: "email", value: "maya.reeves@example.com" }],
      },
    ]);
  });

  test("a change made to the live cabinet shows in the next listing and in no note", async () => {
    const instance = await create();
    const before = await drain(instance);
    const cabinet = getFilingCabinet(SOURCE_ID)!;
    cabinet.renameFolder("f-work", "Office");
    cabinet.moveFolder("f-budget", "f-work");
    cabinet.deleteFolder("f-atlas");
    cabinet.addFolder("f-new", "New", "f-work");
    cabinet.renameGroup("g-team", "Atlas crew");
    cabinet.setGroupMembers("g-team", []);
    expect(await list(instance, FILING_FOLDERS_FIELD)).toEqual([
      { id: "f-budget", label: "Budget", parentId: "f-work" },
      { id: "f-new", label: "New", parentId: "f-work" },
      { id: "f-work", label: "Office" },
    ]);
    expect(await list(instance, FILING_GROUP_FIELD)).toEqual([
      { id: "g-team", label: "Atlas crew", members: [] },
    ]);
    expect(await drain(instance)).toEqual(before);
  });

  test("moves the folders inside a deleted folder to the top level, so the list stays a tree", async () => {
    const instance = await create();
    getFilingCabinet(SOURCE_ID)!.deleteFolder("f-work");
    expect(await list(instance, FILING_FOLDERS_FIELD)).toEqual([
      { id: "f-atlas", label: "Atlas API" },
      { id: "f-budget", label: "Budget", parentId: "f-atlas" },
    ]);
  });

  test("a listing fails whole while the account cannot be reached", async () => {
    const instance = await create();
    const cabinet = getFilingCabinet(SOURCE_ID)!;
    cabinet.failListings(true);
    await expect(list(instance, FILING_FOLDERS_FIELD)).rejects.toThrow("could not be listed");
    cabinet.failListings(false);
    expect(await list(instance, FILING_FOLDERS_FIELD)).toHaveLength(3);
  });

  test("forgets its cabinet when the source is disposed", async () => {
    const instance = await create();
    expect(getFilingCabinet(SOURCE_ID)).toBeDefined();
    await instance.dispose?.();
    expect(getFilingCabinet(SOURCE_ID)).toBeUndefined();
  });

  test("a malformed fixture fails loudly", async () => {
    state.fixture = { folders: [{ invalid: true }], groups: [], notes: [] };
    await expect(create()).rejects.toThrow();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The doubles of the mail and Drive sources write the same filter details the real sources write and
 * publish the same kind of list, from fixture data. All data is invented.
 */

import { expect, test, vi } from "vitest";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
vi.mock("@omnesis/providers-synth-common", async (original) => ({
  ...(await original<typeof import("@omnesis/providers-synth-common")>()),
  personMention: (name: string, role: string) => ({ name, role }),
  getPerson: (name: string) => ({ name }),
}));
import { syncFromFixture } from "@omnesis/providers-synth-common";
import { DriveTwinAccount, GmailTwinMailbox } from "./accounts.js";
import { withChangeReplay, type ReplayCursor } from "./change-replay.js";
import {
  mapDriveFile,
  type DriveFileEntry,
  type DriveFolderEntry,
  type EmailEntry,
} from "./fixtures.js";
import { createGmailFixtureSource } from "./gmail-source.js";

const gmailContext = {
  sourceId: SourceId("gmail:maya.reeves@example.org"),
  providerId: ProviderId("google:maya.reeves@example.org"),
};
const driveContext = {
  sourceId: SourceId("google-drive:maya.reeves@example.org"),
  providerId: ProviderId("google:maya.reeves@example.org"),
};

function email(externalId: string, labels: string[], labelIds?: string[]): EmailEntry {
  return {
    externalId,
    subject: `Subject ${externalId}`,
    from: "p_jamie",
    fromEmail: "jamie.lopez@example.org",
    to: ["self"],
    toEmails: ["maya.reeves@example.org"],
    body: `Body ${externalId}`,
    sentAt: "2026-04-01T09:00:00Z",
    threadId: `thread-${externalId}`,
    labels,
    ...(labelIds ? { labelIds } : {}),
  };
}

function file(externalId: string, parentIds?: string[]): DriveFileEntry {
  return {
    externalId,
    name: `${externalId}.txt`,
    mimeType: "text/plain",
    content: `Content of ${externalId}`,
    owner: "self",
    createdAt: "2026-04-01T09:00:00Z",
    modifiedAt: "2026-04-02T09:00:00Z",
    ...(parentIds ? { parentIds } : {}),
  };
}

const FOLDERS: DriveFolderEntry[] = [
  { id: "root", name: "Synthetic root", parentIds: [] },
  { id: "work", name: "Work", parentIds: ["root"] },
  { id: "reports", name: "Reports", parentIds: ["work"] },
  { id: "archive", name: "Archive", parentIds: ["root"] },
];

const labelIdsOf = (doc: DocumentInput | undefined) =>
  (doc?.metadata.extra as { labelIds?: string[] } | undefined)?.labelIds;
const folderIdsOf = (doc: DocumentInput | undefined) =>
  (doc?.metadata.extra as { folderIds?: string[] } | undefined)?.folderIds;

/** Sync a source to the end of its fixture and return every document it sent. */
async function drain<C extends ReplayCursor>(
  sync: (cursor: C | null) => Promise<{ documents: DocumentInput[]; cursor: C; hasMore: boolean }>,
  from: C | null = null,
): Promise<{ documents: DocumentInput[]; cursor: C }> {
  const documents: DocumentInput[] = [];
  let cursor = from;
  for (;;) {
    const page = await sync(cursor);
    documents.push(...page.documents);
    cursor = page.cursor;
    if (!page.hasMore) return { documents, cursor };
  }
}

test("a message carries label ids: the ones its fixture states, or ones derived from the names", () => {
  const mailbox = new GmailTwinMailbox([
    email("stated", ["INBOX", "Work"], ["INBOX", "Label_work"]),
    email("derived", ["STARRED", "Work", "Travel plans"]),
    email("bare", []),
  ]);

  expect(mailbox.current(email("stated", [])).labelIds).toEqual(["INBOX", "Label_work"]);
  // "Work" keeps the id another message stated for it; a built-in label's id is its name.
  expect(mailbox.current(email("derived", [])).labelIds).toEqual([
    "STARRED",
    "Label_work",
    "Label_travel_plans",
  ]);
  expect(mailbox.current(email("derived", [])).labels).toEqual(["STARRED", "Work", "Travel plans"]);
  // No label is an empty list, not an absent one.
  expect(mailbox.current(email("bare", [])).labelIds).toEqual([]);
});

test("the mailbox lists its labels the way the real source does, and records name only listed ones", () => {
  const entry = email("one", ["INBOX", "UNREAD", "Clients", "Clients/Northstar"]);
  const mailbox = new GmailTwinMailbox([entry]);

  expect(mailbox.listLabels()).toEqual([
    { id: "INBOX", label: "Inbox" },
    { id: "Label_clients", label: "Clients" },
    { id: "Label_clients_northstar", label: "Clients/Northstar", parentId: "Label_clients" },
  ]);
  // Read state is not a label a filter can name, so the record does not carry it.
  expect(mailbox.current(entry).labelIds).toEqual([
    "INBOX",
    "Label_clients",
    "Label_clients_northstar",
  ]);
  expect(mailbox.current(entry).labels).toEqual([
    "INBOX",
    "UNREAD",
    "Clients",
    "Clients/Northstar",
  ]);
  expect(mailbox.listings).toBe(1);

  mailbox.failListings(true);
  expect(() => mailbox.listLabels()).toThrow();
  expect(mailbox.listings).toBe(1);
});

test("every Gmail record of a walk carries its label ids, and a renamed label sends none again", async () => {
  const entries = [
    email("a", ["INBOX", "Work"]),
    email("b", []),
    {
      ...email("c", ["Work"]),
      attachments: [
        { filename: "notes.txt", mimeType: "text/plain", sizeBytes: 12, extractedText: "Notes" },
      ],
    },
  ];
  const mailbox = new GmailTwinMailbox(entries);
  const source = createGmailFixtureSource(entries, gmailContext, {}, mailbox);

  const walk = await drain((cursor) => source.sync(cursor));

  expect(walk.documents.map((doc) => [doc.externalId, labelIdsOf(doc)])).toEqual([
    ["a", ["INBOX", "Label_work"]],
    ["b", []],
    ["c", ["Label_work"]],
    // An attachment record has no labels of its own; it names its message.
    [expect.stringMatching(/^c\/att\//), undefined],
  ]);
  expect(walk.documents[3]?.metadata.extra).toMatchObject({ parentExternalId: "c" });

  mailbox.renameLabel("Label_work", "Office");
  const afterRename = await source.sync(walk.cursor);
  expect(afterRename.documents).toEqual([]);
  expect(mailbox.listLabels()).toContainEqual({ id: "Label_work", label: "Office" });
});

test("a label put on or taken off a message sends that message again, and only that one", async () => {
  const entries = [email("a", ["INBOX"]), email("b", ["Work"]), email("c", [])];
  const mailbox = new GmailTwinMailbox(entries);
  const source = createGmailFixtureSource(entries, gmailContext, {}, mailbox);
  const walk = await drain((cursor) => source.sync(cursor));

  mailbox.createLabel("Label_finance", "Finance");
  mailbox.addLabel("a", "Label_finance");
  mailbox.removeLabel("b", "Label_work");
  const changed = await source.sync(walk.cursor);

  expect(changed.documents.map((doc) => [doc.externalId, labelIdsOf(doc)])).toEqual([
    ["a", ["INBOX", "Label_finance"]],
    ["b", []],
  ]);
  expect(changed.documents[0]?.metadata.tags).toEqual(["INBOX", "Finance"]);
  // Each change is sent once.
  expect((await source.sync(changed.cursor)).documents).toEqual([]);
  // The snapshot of what exists still names every message.
  expect(changed.presentExternalIds?.slice().sort()).toEqual(["a", "b", "c"]);
});

test("a walk from the start reads every record as it is now and owes only later changes", async () => {
  const entries = [email("a", ["INBOX"]), email("b", [])];
  const mailbox = new GmailTwinMailbox(entries);
  const source = createGmailFixtureSource(entries, gmailContext, {}, mailbox);
  const first = await drain((cursor) => source.sync(cursor));
  mailbox.createLabel("Label_finance", "Finance");
  mailbox.addLabel("b", "Label_finance");

  // Sent back to the start with the change still unsent: the walk carries it.
  const again = await drain<ReplayCursor>((cursor) => source.sync(cursor), { offset: 0 });

  expect(again.documents.map((doc) => [doc.externalId, labelIdsOf(doc)])).toEqual([
    ["a", ["INBOX"]],
    ["b", ["Label_finance"]],
  ]);
  expect((await source.sync(again.cursor)).documents).toEqual([]);
  expect(first.documents).toHaveLength(2);
});

test("a cursor ahead of the journal, as after a restart, replays nothing", async () => {
  const page = { documents: [], deletedExternalIds: [], hasMore: false, cursor: { offset: 3 } };
  const emit = vi.fn(() => []);

  const result = await withChangeReplay<ReplayCursor>(
    { offset: 3, changeSeq: 9 },
    ["a"],
    page,
    emit,
  );

  expect(emit).not.toHaveBeenCalled();
  expect(result.cursor.changeSeq).toBe(1);
});

test("the build before filter details wrote records without label or folder ids", () => {
  const mailbox = new GmailTwinMailbox([email("a", ["INBOX"])]);
  const drive = new DriveTwinAccount([file("f", ["work"])], FOLDERS);
  mailbox.beforeFilterDetails = true;
  drive.beforeFilterDetails = true;

  expect(mailbox.current(email("a", []))).not.toHaveProperty("labelIds");
  expect(folderIdsOf(mapDriveFile(drive.current(file("f")), driveContext))).toBeUndefined();
});

test("a Drive file carries the ids of its folders, and the Drive lists the tree", () => {
  const files = [file("in-reports", ["reports"]), file("loose")];
  const drive = new DriveTwinAccount(files, FOLDERS);

  expect(
    files.map((entry) => folderIdsOf(mapDriveFile(drive.current(entry), driveContext))),
  ).toEqual([["reports"], []]);
  expect(drive.listFolders()).toEqual([
    { id: "root", label: "Synthetic root" },
    { id: "work", label: "Work", parentId: "root" },
    { id: "reports", label: "Reports", parentId: "work" },
    { id: "archive", label: "Archive", parentId: "root" },
  ]);
});

test("a moved or renamed folder changes the list only; a moved file is sent again", async () => {
  const files = [file("one", ["reports"]), file("two", ["archive"])];
  const drive = new DriveTwinAccount(files, FOLDERS);
  const documentOf = (entry: DriveFileEntry) => mapDriveFile(drive.current(entry), driveContext);
  const sync = async (cursor: ReplayCursor | null) =>
    withChangeReplay(
      cursor,
      drive.changes,
      syncFromFixture(files, cursor, documentOf, { sourceId: driveContext.sourceId }),
      (changed) => files.filter((entry) => changed.has(entry.externalId)).map(documentOf),
    );
  const walk = await drain(sync);
  expect(walk.documents.map((doc) => [doc.externalId, folderIdsOf(doc)])).toEqual([
    ["one", ["reports"]],
    ["two", ["archive"]],
  ]);

  drive.renameFolder("reports", "Reports 2026");
  drive.moveFolder("reports", "archive");
  const afterFolders = await sync(walk.cursor);
  expect(afterFolders.documents).toEqual([]);
  expect(drive.listFolders()).toContainEqual({
    id: "reports",
    label: "Reports 2026",
    parentId: "archive",
  });

  drive.moveFile("two", []);
  const afterFile = await sync(afterFolders.cursor);
  expect(afterFile.documents.map((doc) => [doc.externalId, folderIdsOf(doc)])).toEqual([
    ["two", []],
  ]);
});

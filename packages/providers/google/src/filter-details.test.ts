// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a mail message record and a Drive file record carry for a filter to match on, and the
 * lists the two sources publish of the labels and folders that exist.
 *
 * Every test drives the real source over a mocked API. All names, addresses
 * and ids are invented.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  collectFilterList,
  validateDocumentEventProfile,
  type SyncCursor,
} from "@omnesis/source-sdk";
import { resolveAttachmentConfig } from "@omnesis/core";
import { SyncError, type DocumentInput } from "@omnesis/types";
import {
  createDriveSource,
  createGmailSource,
  createMockDrive,
  createMockGmail,
  makeDriveChange,
  makeDriveFile,
  makeGmailMessage,
  mockDriveFilesList,
} from "./testing/mock-google.js";
import {
  GMAIL_OUTPUT_REVISION,
  GOOGLE_DRIVE_OUTPUT_REVISION,
  gmailDocumentEventProfile,
  googleDriveDocumentEventProfile,
} from "./document-event-profiles.js";
import {
  GMAIL_MESSAGES_PER_DAY,
  GMAIL_PAGE_SIZE,
  GMAIL_QUOTA_UNITS,
  GMAIL_QUOTA_UNITS_PER_MINUTE,
  GMAIL_SYNC_BUDGET_MS,
} from "./constants.js";
import { MAX_PEOPLE_PER_MESSAGE } from "./gmail-message.js";
import { GMAIL_LABELS_FIELD, gmailLabelItems, gmailListedLabelIds } from "./gmail-labels.js";
import { DRIVE_FOLDERS_FIELD, driveFolderItems } from "./drive-folders.js";
import { QuotaPacer } from "./quota-pacer.js";
import googleProvider from "./index.js";

const signal = new AbortController().signal;

function extra(doc: DocumentInput | undefined): Record<string, unknown> {
  return (doc?.metadata.extra ?? {}) as Record<string, unknown>;
}

function sourceEntry(id: string) {
  const entry = googleProvider.sources.find((source) => source.id === id);
  if (!entry) throw new Error(`no ${id} source`);
  return entry;
}

// ── Gmail ──────────────────────────────────────────────────────────

/** The labels of an invented account: the built-in ones and three the owner made. */
const ACCOUNT_LABELS = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "SPAM", name: "SPAM", type: "system" },
  { id: "TRASH", name: "TRASH", type: "system" },
  { id: "CHAT", name: "CHAT", type: "system" },
  { id: "YELLOW_STAR", name: "YELLOW_STAR", type: "system" },
  { id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL", type: "system" },
  { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
  { id: "Label_7", name: "Finance", type: "user" },
  { id: "Label_8", name: "Clients", type: "user" },
  { id: "Label_9", name: "Clients/Northstar", type: "user" },
];

describe("Gmail: label ids on every message record", () => {
  let gmail: ReturnType<typeof createMockGmail>;

  beforeEach(() => {
    gmail = createMockGmail();
    gmail.users.labels.list = vi.fn(() => Promise.resolve({ data: { labels: ACCOUNT_LABELS } }));
  });

  /** One bootstrap page over `messages`, as a sync from an empty cursor reads it. */
  async function readAll(messages: Array<Record<string, any>>) {
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: messages.map(({ id }) => ({ id })) } }),
    );
    gmail.users.messages.get = vi.fn(({ id }: { id: string }) =>
      Promise.resolve({ data: messages.find((message) => message.id === id) }),
    );
    return createGmailSource(gmail).sync(null);
  }

  test("a message carries Gmail's ids for its labels, and the names only as tags", async () => {
    const result = await readAll([
      makeGmailMessage("m1", { labelIds: ["INBOX", "UNREAD", "Label_7", "Label_9"] }),
    ]);

    const [doc] = result.documents;
    // The ids the account's list contains: read state is not among them.
    expect(extra(doc).labelIds).toEqual(["INBOX", "Label_7", "Label_9"]);
    expect(doc?.metadata.tags).toEqual(["INBOX", "UNREAD", "Finance", "Clients/Northstar"]);
    // No label name appears among the ids.
    expect(extra(doc).labelIds).not.toContain("Finance");
  });

  test("every id a record can carry is in the list the same account publishes", async () => {
    // One message per label of the account, one carrying them all, and one
    // naming a label deleted since: whatever Gmail returns, a record names
    // nothing the list lacks.
    const everyId = ACCOUNT_LABELS.map((label) => label.id);
    const result = await readAll([
      ...everyId.map((id, index) => makeGmailMessage(`m-${index}`, { labelIds: [id] })),
      makeGmailMessage("m-all", { labelIds: everyId }),
      makeGmailMessage("m-gone", { labelIds: ["INBOX", "Label_deleted"] }),
    ]);
    const listed = new Set((await createGmailSource(gmail).listLabels()).map((item) => item.id));

    const carried = new Set(result.documents.flatMap((doc) => extra(doc).labelIds as string[]));
    expect([...carried].filter((id) => !listed.has(id))).toEqual([]);
    // And every listed label reaches the records that have it.
    expect([...carried].sort()).toEqual([...listed].sort());
    for (const unlisted of ["SPAM", "TRASH", "UNREAD", "YELLOW_STAR", "Label_deleted"]) {
      expect(carried.has(unlisted)).toBe(false);
    }
  });

  test("a label made since the last listing is listed again before its id is written", async () => {
    await readAll([makeGmailMessage("m1", { labelIds: ["Label_7"] })]);
    const source = createGmailSource(gmail);
    await source.sync(null);
    const before = gmail.users.labels.list.mock.calls.length;

    gmail.users.labels.list = vi.fn(() =>
      Promise.resolve({
        data: { labels: [...ACCOUNT_LABELS, { id: "Label_30", name: "Taxes", type: "user" }] },
      }),
    );
    gmail.users.messages.get = vi.fn(() =>
      Promise.resolve({ data: makeGmailMessage("m1", { labelIds: ["Label_30"] }) }),
    );
    const result = await source.sync(null);

    expect(before).toBeGreaterThan(0);
    expect(gmail.users.labels.list).toHaveBeenCalledTimes(1);
    expect(extra(result.documents[0]).labelIds).toEqual(["Label_30"]);
  });

  test("a page fails when the listing a new label needs cannot be made", async () => {
    await readAll([makeGmailMessage("m1", { labelIds: ["Label_7"] })]);
    const source = createGmailSource(gmail);
    await source.sync(null);

    gmail.users.labels.list = vi.fn(() => Promise.reject(new Error("unavailable")));
    gmail.users.messages.get = vi.fn(() =>
      Promise.resolve({ data: makeGmailMessage("m1", { labelIds: ["Label_30"] }) }),
    );

    await expect(source.sync(null)).rejects.toThrow();
  });

  test("a message with no label carries an empty list, never an absent one", async () => {
    const bare = makeGmailMessage("m-bare");
    delete bare.labelIds;
    const result = await readAll([bare, makeGmailMessage("m-empty", { labelIds: [] })]);

    expect(result.documents.map((doc) => extra(doc).labelIds)).toEqual([[], []]);
  });

  test("an attachment record carries its parent's id and people, and no labels of its own", async () => {
    gmail.users.messages.attachments.get = vi.fn(() =>
      Promise.resolve({ data: { data: Buffer.from("pdf").toString("base64url") } }),
    );
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "m-att" }] } }),
    );
    gmail.users.messages.get = vi.fn(() =>
      Promise.resolve({
        data: makeGmailMessage("m-att", {
          labelIds: ["INBOX", "Label_7"],
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "Subject", value: "Quarterly invoice" },
              { name: "From", value: "maya.reeves@example.com" },
              { name: "To", value: "jamie.lopez@example.com" },
              { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
            ],
            parts: [
              {
                mimeType: "text/plain",
                body: { data: Buffer.from("See attached.").toString("base64url") },
              },
              {
                mimeType: "application/pdf",
                filename: "invoice.pdf",
                body: { attachmentId: "att-1", size: 2048 },
              },
            ],
          },
        }),
      }),
    );
    const source = createGmailSource(gmail, {
      attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
      extractAttachment: async () => ({ text: "Invoice total 120.00", truncated: false }),
    });

    const result = await source.sync(null);

    const [message, attachment] = result.documents;
    expect(extra(message).labelIds).toEqual(["INBOX", "Label_7"]);
    expect(attachment?.metadata.documentType).toBe("attachment");
    expect(extra(attachment).parentExternalId).toBe("m-att");
    expect(extra(attachment)).not.toHaveProperty("labelIds");
    expect(extra(attachment)).not.toHaveProperty("threadId");
    expect(attachment?.metadata.tags).toBeUndefined();
    expect(
      (attachment?.metadata.people ?? []).map((person) => [person.role, person.emails?.[0]]),
    ).toEqual([
      ["sender", "maya.reeves@example.com"],
      ["recipient", "jamie.lopez@example.com"],
    ]);
  });

  test("a sync from an empty cursor fetches and emits every message again", async () => {
    const messages = [
      makeGmailMessage("m1", { labelIds: ["INBOX"] }),
      makeGmailMessage("m2", { labelIds: ["Label_7"] }),
      makeGmailMessage("m3", { labelIds: [] }),
    ];
    const first = await readAll(messages);
    expect(first.documents.map((doc) => doc.externalId)).toEqual(["m1", "m2", "m3"]);

    // Nothing changed upstream; the second pass still reads every message.
    const second = await readAll(messages);
    expect(gmail.users.messages.get).toHaveBeenCalledTimes(3);
    expect(second.documents.map((doc) => [doc.externalId, extra(doc).labelIds])).toEqual([
      ["m1", ["INBOX"]],
      ["m2", ["Label_7"]],
      ["m3", []],
    ]);
  });
});

describe("Gmail: a label added or removed later re-emits the message", () => {
  const incremental: SyncCursor = { phase: "incremental", historyId: "100" };

  function mailbox(history: unknown[], labelIds: string[]) {
    const gmail = createMockGmail();
    gmail.users.labels.list = vi.fn(() => Promise.resolve({ data: { labels: ACCOUNT_LABELS } }));
    gmail.users.history.list = vi.fn(() =>
      Promise.resolve({ data: { history, historyId: "101" } }),
    );
    gmail.users.messages.get = vi.fn(() =>
      Promise.resolve({ data: makeGmailMessage("m1", { labelIds }) }),
    );
    return gmail;
  }

  test("the history listing asks for label changes", async () => {
    const gmail = mailbox([], []);
    await createGmailSource(gmail).sync(incremental);
    expect(gmail.users.history.list.mock.calls[0][0].historyTypes).toEqual(
      expect.arrayContaining(["labelAdded", "labelRemoved"]),
    );
  });

  test("a message that gains a label comes back with the new id", async () => {
    const gmail = mailbox(
      [{ labelsAdded: [{ message: { id: "m1" }, labelIds: ["Label_7"] }] }],
      ["INBOX", "Label_7"],
    );

    const result = await createGmailSource(gmail).sync(incremental);

    expect(result.deletedExternalIds).toEqual([]);
    expect(result.documents.map((doc) => [doc.externalId, extra(doc).labelIds])).toEqual([
      ["m1", ["INBOX", "Label_7"]],
    ]);
  });

  test("a message that loses its last label comes back with none", async () => {
    const gmail = mailbox(
      [{ labelsRemoved: [{ message: { id: "m1" }, labelIds: ["Label_7"] }] }],
      [],
    );

    const result = await createGmailSource(gmail).sync(incremental);

    expect(result.documents.map((doc) => extra(doc).labelIds)).toEqual([[]]);
  });

  test("the re-fetch is paced like any other message fetch", async () => {
    const gmail = mailbox(
      [{ labelsAdded: [{ message: { id: "m1" }, labelIds: ["Label_7"] }] }],
      ["Label_7"],
    );
    const quota = QuotaPacer.unlimited();
    const acquire = vi.spyOn(quota, "acquire");

    await createGmailSource(gmail, { quota }).sync(incremental);

    const spent = acquire.mock.calls.map(([units]) => units);
    expect(spent).toContain(GMAIL_QUOTA_UNITS.historyList);
    expect(spent.filter((units) => units === GMAIL_QUOTA_UNITS.messagesGetFull)).toHaveLength(1);
  });
});

describe("Gmail: the list of labels", () => {
  test("lists the owner's labels and the recognisable built-in ones, nested by name", () => {
    expect(gmailLabelItems(ACCOUNT_LABELS)).toEqual([
      { id: "INBOX", label: "Inbox" },
      { id: "SENT", label: "Sent" },
      { id: "DRAFT", label: "Drafts" },
      { id: "STARRED", label: "Starred" },
      { id: "IMPORTANT", label: "Important" },
      { id: "CHAT", label: "Chats" },
      { id: "CATEGORY_PERSONAL", label: "Primary" },
      { id: "CATEGORY_PROMOTIONS", label: "Promotions" },
      { id: "Label_7", label: "Finance" },
      { id: "Label_8", label: "Clients" },
      // A nested label keeps its full name and sits inside the label named before its last slash.
      { id: "Label_9", label: "Clients/Northstar", parentId: "Label_8" },
    ]);
  });

  test("a label's parent is the label named before its last slash, and only if the account has it", () => {
    const user = (id: string, name: string) => ({ id, name, type: "user" });
    const items = gmailLabelItems([
      { id: "INBOX", name: "INBOX", type: "system" },
      user("a", "Clients"),
      user("b", "Clients/Northstar"),
      user("c", "Clients/Northstar/2026"),
      // No label is named "Travel", so nothing is invented above this one.
      user("d", "Travel/Japan"),
      // Its nearest existing ancestor by name is not its parent: only the
      // text before the last slash is looked up.
      user("e", "Clients/Missing/Deep"),
      // A built-in label is never a parent, whatever a name starts with.
      user("f", "INBOX/Receipts"),
      user("g", "Inbox/Receipts"),
      user("h", "/leading"),
    ]);

    expect(Object.fromEntries(items.map((item) => [item.id, item.parentId]))).toEqual({
      INBOX: undefined,
      a: undefined,
      b: "a",
      c: "b",
      d: undefined,
      e: undefined,
      f: undefined,
      g: undefined,
      h: undefined,
    });
    expect(items.find((item) => item.id === "c")?.label).toBe("Clients/Northstar/2026");
  });

  test("a rename in Gmail reshapes the tree and touches no record's ids", () => {
    const labels = (outer: string) => [
      { id: "a", name: outer, type: "user" },
      { id: "b", name: "Clients/Northstar", type: "user" },
    ];
    const parentOf = (outer: string) =>
      gmailLabelItems(labels(outer)).find((item) => item.id === "b")?.parentId;

    expect(parentOf("Clients")).toBe("a");
    expect(parentOf("Customers")).toBeUndefined();
    // The same ids are listed either way, so every record still names listed labels.
    expect([...gmailListedLabelIds(labels("Customers"))]).toEqual(["a", "b"]);
  });

  test("costs one paced request, whatever the mailbox holds", async () => {
    const gmail = createMockGmail();
    gmail.users.labels.list = vi.fn(() => Promise.resolve({ data: { labels: ACCOUNT_LABELS } }));
    const quota = QuotaPacer.unlimited();
    const acquire = vi.spyOn(quota, "acquire");
    const source = createGmailSource(gmail, { quota });

    const items = await collectFilterList(() => source.listLabels(), { signal });

    expect(items).toHaveLength(11);
    expect(gmail.users.labels.list).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls).toEqual([[GMAIL_QUOTA_UNITS.labelsList]]);
    expect(gmail.users.messages.list).not.toHaveBeenCalled();
    expect(gmail.users.messages.get).not.toHaveBeenCalled();
    expect(gmail.users.history.list).not.toHaveBeenCalled();
  });

  test("a renamed label changes the list and no record", async () => {
    const gmail = createMockGmail();
    let labels = ACCOUNT_LABELS;
    gmail.users.labels.list = vi.fn(() => Promise.resolve({ data: { labels } }));
    const source = createGmailSource(gmail);
    const before = await source.listLabels();

    labels = ACCOUNT_LABELS.map((label) =>
      label.id === "Label_7" ? { ...label, name: "Money" } : label,
    );
    // Gmail records no history for a rename, so the sync after it emits nothing.
    const synced = await source.sync({ phase: "incremental", historyId: "100" });
    const after = await source.listLabels();

    expect(synced.documents).toEqual([]);
    expect(before.find((item) => item.id === "Label_7")?.label).toBe("Finance");
    expect(after.find((item) => item.id === "Label_7")?.label).toBe("Money");
    expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
  });

  test("a failed request throws instead of publishing part of a list", async () => {
    const gmail = createMockGmail();
    gmail.users.labels.list = vi.fn(() =>
      Promise.reject(Object.assign(new Error("unavailable"), { code: 503 })),
    );
    const source = createGmailSource(gmail);

    await expect(collectFilterList(() => source.listLabels(), { signal })).rejects.toBeInstanceOf(
      SyncError,
    );
  });

  test("the source attaches the producer under the field its profile declares", async () => {
    const instance = await sourceEntry("gmail").create(
      { accountId: "maya.reeves@example.com" } as never,
      { auth: {}, accountId: "maya.reeves@example.com" } as never,
    );
    expect(Object.keys(instance.filterLists ?? {})).toEqual([GMAIL_LABELS_FIELD]);
  });
});

describe("Gmail: the people of a message", () => {
  test("sender and every recipient, Bcc included, are listed by normalized address", async () => {
    const gmail = createMockGmail();
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "m1" }] } }),
    );
    gmail.users.messages.get = vi.fn(() =>
      Promise.resolve({
        data: makeGmailMessage("m1", {
          labelIds: ["SENT"],
          from: "<Maya.Reeves@Example.com>",
          to: "jamie.lopez@example.com",
          cc: "david.lin@example.org",
          extraHeaders: [{ name: "Bcc", value: "<SARAH.MENDEZ@example.io>" }],
        }),
      }),
    );

    const result = await createGmailSource(gmail).sync(null);

    expect(
      (result.documents[0]?.metadata.people ?? []).map((person) => [person.role, person.emails]),
    ).toEqual([
      ["sender", ["maya.reeves@example.com"]],
      ["recipient", ["jamie.lopez@example.com"]],
      ["recipient", ["david.lin@example.org"]],
      ["recipient", ["sarah.mendez@example.io"]],
    ]);
  });

  test("a message stops listing people at the declared cap", async () => {
    const recipients = Array.from(
      { length: MAX_PEOPLE_PER_MESSAGE + 50 },
      (_, index) => `person${index}@example.org`,
    ).join(", ");
    const gmail = createMockGmail();
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "m1" }] } }),
    );
    gmail.users.messages.get = vi.fn(() =>
      Promise.resolve({ data: makeGmailMessage("m1", { to: recipients }) }),
    );

    const result = await createGmailSource(gmail).sync(null);

    expect(result.documents[0]?.metadata.people).toHaveLength(MAX_PEOPLE_PER_MESSAGE);
    expect(gmailDocumentEventProfile.personFilter?.maxPeople).toBe(MAX_PEOPLE_PER_MESSAGE);
  });
});

describe("Gmail: what the source declares", () => {
  test("labels are a tree field and people are matched per message, both from revision 2", () => {
    const entry = sourceEntry("gmail");
    expect(entry.contract?.outputRevision).toBe(GMAIL_OUTPUT_REVISION);
    expect(GMAIL_OUTPUT_REVISION).toBe(2);
    expect(() =>
      validateDocumentEventProfile(gmailDocumentEventProfile, "gmail", {
        outputRevision: GMAIL_OUTPUT_REVISION,
        partitioned: false,
      }),
    ).not.toThrow();

    const labels = gmailDocumentEventProfile.metadataFields?.find(
      (field) => field.path === GMAIL_LABELS_FIELD,
    );
    expect(labels).toMatchObject({
      type: "string-array",
      filter: {
        capability: "tree",
        minVersion: 2,
        scope: "global",
        noun: { one: "label", many: "labels" },
        levels: [{ one: "label", many: "labels" }],
        picker: "tree",
        inside: { one: "label", many: "labels" },
      },
    });
    expect(gmailDocumentEventProfile.personFilter).toEqual({
      minVersion: 2,
      roles: ["sender", "recipient"],
      identifiers: ["email", "domain"],
      maxPeople: 1_000,
    });
  });

  test("the fields a watch could already use are still declared as they were", () => {
    const paths = (gmailDocumentEventProfile.metadataFields ?? []).map((field) => field.path);
    expect(paths).toEqual(
      expect.arrayContaining(["tags", "extra.threadId", "bulkMail", "automatedSender"]),
    );
    expect(gmailDocumentEventProfile.personRoles).toEqual(["sender", "recipient", "mentioned"]);
  });

  test("the resync cost is the pace the quota, the sync budget and the default interval give", () => {
    const unitsPerMessage =
      GMAIL_QUOTA_UNITS.messagesGetFull + GMAIL_QUOTA_UNITS.messagesList / GMAIL_PAGE_SIZE;
    // 4,000 units a minute at 60.2 units a message: about 66 messages a minute while a sync runs.
    const whileRunning = GMAIL_QUOTA_UNITS_PER_MINUTE / unitsPerMessage;
    expect(unitsPerMessage).toBeCloseTo(60.2);
    expect(whileRunning).toBeCloseTo(66.4, 1);
    // A sync runs 20 minutes and the next starts 5 minutes later: about 53 a minute on average.
    const average = (whileRunning * GMAIL_SYNC_BUDGET_MS) / (GMAIL_SYNC_BUDGET_MS + 5 * 60_000);
    expect(average).toBeCloseTo(53.2, 1);
    expect(Math.round(average * 60 * 24)).toBe(76_545);
    expect(GMAIL_MESSAGES_PER_DAY).toBe(75_000);
    expect(sourceEntry("gmail").resyncCost).toBe("This reads about 75,000 messages a day.");
  });
});

// ── Drive ──────────────────────────────────────────────────────────

describe("Drive: folder ids on every file record", () => {
  let drive: ReturnType<typeof createMockDrive>;

  beforeEach(() => {
    drive = createMockDrive();
    drive.files.export = vi.fn(() => Promise.resolve({ data: "text" }));
  });

  test("the file listing and the changes feed both ask Drive for parents", async () => {
    const source = createDriveSource(drive);
    await source.sync(null);
    await source.sync({ phase: "incremental", startPageToken: "t1" });

    expect(drive.files.list.mock.calls[0][0].fields).toMatch(/\bparents\b/);
    expect(drive.changes.list.mock.calls[0][0].fields).toMatch(/file\([^)]*\bparents\b/);
  });

  test("a file carries the ids of the folders it sits in directly, never their names", async () => {
    mockDriveFilesList(drive, [
      makeDriveFile({ id: "f1", parents: ["folder-reports"] }),
      makeDriveFile({ id: "f2", parents: ["folder-a", "folder-b", "folder-a"] }),
    ]);

    const result = await createDriveSource(drive).sync(null);

    expect(result.documents.map((doc) => [doc.externalId, extra(doc).folderIds])).toEqual([
      ["f1", ["folder-reports"]],
      ["f2", ["folder-a", "folder-b"]],
    ]);
  });

  test("a file in no folder the account can see carries an empty list", async () => {
    mockDriveFilesList(drive, [
      makeDriveFile({ id: "shared-alone" }),
      makeDriveFile({ id: "no-parents", parents: [] }),
    ]);

    const result = await createDriveSource(drive).sync(null);

    expect(result.documents.map((doc) => extra(doc).folderIds)).toEqual([[], []]);
  });

  test("a file moved to another folder arrives through the changes feed with its new folder", async () => {
    drive.changes.list = vi.fn(() =>
      Promise.resolve({
        data: {
          changes: [
            makeDriveChange("f1", {
              file: makeDriveFile({ id: "f1", parents: ["folder-archive"] }),
            }),
          ],
          newStartPageToken: "t2",
        },
      }),
    );

    const result = await createDriveSource(drive).sync({
      phase: "incremental",
      startPageToken: "t1",
    });

    expect(result.documents.map((doc) => [doc.externalId, extra(doc).folderIds])).toEqual([
      ["f1", ["folder-archive"]],
    ]);
  });

  test("a folder that is renamed or moved emits no record", async () => {
    drive.changes.list = vi.fn(() =>
      Promise.resolve({
        data: {
          changes: [
            makeDriveChange("folder-reports", {
              file: makeDriveFile({
                id: "folder-reports",
                name: "Reports 2026",
                mimeType: "application/vnd.google-apps.folder",
                parents: ["folder-archive"],
              }),
            }),
          ],
          newStartPageToken: "t2",
        },
      }),
    );

    const result = await createDriveSource(drive).sync({
      phase: "incremental",
      startPageToken: "t1",
    });

    expect(result.documents).toEqual([]);
    expect(result.deletedExternalIds).toEqual([]);
    expect(drive.files.export).not.toHaveBeenCalled();
  });

  test("a sync from an empty cursor downloads and emits every file again", async () => {
    mockDriveFilesList(drive, [
      makeDriveFile({ id: "f1", parents: ["folder-a"] }),
      makeDriveFile({ id: "f2" }),
    ]);
    const source = createDriveSource(drive);

    await source.sync(null);
    const second = await source.sync(null);

    expect(drive.files.export).toHaveBeenCalledTimes(4);
    expect(second.documents.map((doc) => [doc.externalId, extra(doc).folderIds])).toEqual([
      ["f1", ["folder-a"]],
      ["f2", []],
    ]);
  });
});

describe("Drive: the list of folders", () => {
  const FOLDER = "application/vnd.google-apps.folder";

  /** A Drive whose folder listing is served in the given pages. */
  function driveWith(
    pages: Array<{ files: unknown[]; incompleteSearch?: boolean }>,
    opts: { sharedDrives?: Array<{ id: string; name: string }>; root?: unknown } = {},
  ) {
    const drive = createMockDrive();
    drive.files.get = vi.fn(() =>
      opts.root === null
        ? Promise.reject(Object.assign(new Error("File not found"), { code: 404 }))
        : Promise.resolve({ data: opts.root ?? { id: "root-id", name: "My Drive" } }),
    );
    drive.drives = {
      list: vi.fn(() => Promise.resolve({ data: { drives: opts.sharedDrives ?? [] } })),
    };
    let served = 0;
    drive.files.list = vi.fn(() => {
      const page = pages[served++]!;
      return Promise.resolve({
        data: { ...page, nextPageToken: served < pages.length ? `page-${served}` : undefined },
      });
    });
    return drive;
  }

  test("My Drive and each shared drive are roots, and every folder names the folder it sits in", async () => {
    const drive = driveWith(
      [
        {
          files: [
            { id: "work", name: "Work", parents: ["root-id"] },
            { id: "reports", name: "Reports", parents: ["work"] },
            { id: "team-plans", name: "Plans", parents: ["drive-team"] },
            // Shared on its own: the account cannot see what it sits in.
            { id: "shared-folder", name: "shared plans" },
            // Its parent is not among the folders the account can list.
            { id: "orphan", name: "Orphan", parents: ["unseen"] },
            // Two folders may share a name; they are two entries.
            { id: "reports-2", name: "Reports", parents: ["team-plans"] },
          ],
        },
      ],
      { sharedDrives: [{ id: "drive-team", name: "Northstar" }] },
    );
    const source = createDriveSource(drive);

    const items = await collectFilterList((context) => source.listFolders(context.signal), {
      signal,
    });

    expect(items).toEqual([
      { id: "drive-team", label: "Northstar" },
      { id: "orphan", label: "Orphan" },
      { id: "reports", label: "Reports", parentId: "work" },
      { id: "reports-2", label: "Reports", parentId: "team-plans" },
      { id: "root-id", label: "My Drive" },
      { id: "shared-folder", label: "shared plans" },
      { id: "team-plans", label: "Plans", parentId: "drive-team" },
      { id: "work", label: "Work", parentId: "root-id" },
    ]);
  });

  test("the listing asks for folders only and follows every page", async () => {
    const drive = driveWith([
      { files: [{ id: "a", name: "A", parents: ["root-id"] }] },
      { files: [{ id: "b", name: "B", parents: ["a"] }] },
      { files: [{ id: "c", name: "C", parents: ["b"] }] },
    ]);

    const items = await createDriveSource(drive).listFolders(signal);

    expect(items.map((item) => item.id).sort()).toEqual(["a", "b", "c", "root-id"]);
    // One request for the root, one for the shared drives, one per page of
    // folders; no file is listed, exported or downloaded.
    expect(drive.files.get).toHaveBeenCalledTimes(1);
    expect(drive.drives.list).toHaveBeenCalledTimes(1);
    expect(drive.files.list).toHaveBeenCalledTimes(3);
    for (const [params] of drive.files.list.mock.calls) {
      expect(params.q).toBe(`mimeType = '${FOLDER}' and trashed = false`);
      expect(params.pageSize).toBe(1000);
      expect(params.fields).toBe("nextPageToken,incompleteSearch,files(id,name,parents)");
      expect(params.includeItemsFromAllDrives).toBe(true);
    }
    expect(
      drive.files.list.mock.calls.map(([params]: [{ pageToken?: string }]) => params.pageToken),
    ).toEqual([undefined, "page-1", "page-2"]);
    expect(drive.files.export).not.toHaveBeenCalled();
    expect(drive.changes.list).not.toHaveBeenCalled();
  });

  test("a renamed or moved folder changes its entry and nothing else", () => {
    const listing = {
      root: { id: "root-id", name: "My Drive" },
      sharedDrives: [],
      folders: [
        { id: "work", name: "Work", parents: ["root-id"] },
        { id: "reports", name: "Reports", parents: ["work"] },
        { id: "archive", name: "Archive", parents: ["root-id"] },
      ],
    };
    const moved = {
      ...listing,
      folders: listing.folders.map((folder) =>
        folder.id === "reports"
          ? { id: "reports", name: "Reports 2026", parents: ["archive"] }
          : folder,
      ),
    };

    const before = driveFolderItems(listing);
    const after = driveFolderItems(moved);

    expect(after.find((item) => item.id === "reports")).toEqual({
      id: "reports",
      label: "Reports 2026",
      parentId: "archive",
    });
    expect(after.filter((item) => item.id !== "reports")).toEqual(
      before.filter((item) => item.id !== "reports"),
    );
  });

  test("an account with no My Drive lists its folders without that root", async () => {
    const drive = driveWith([{ files: [{ id: "a", name: "A", parents: ["gone-root"] }] }], {
      root: null,
    });

    expect(await createDriveSource(drive).listFolders(signal)).toEqual([{ id: "a", label: "A" }]);
  });

  test("an incomplete page or a failed request throws instead of publishing part of the tree", async () => {
    const incomplete = driveWith([{ files: [{ id: "a", name: "A" }], incompleteSearch: true }]);
    await expect(createDriveSource(incomplete).listFolders(signal)).rejects.toBeInstanceOf(
      SyncError,
    );

    const failing = driveWith([{ files: [] }]);
    failing.files.list = vi.fn(() =>
      Promise.reject(Object.assign(new Error("unavailable"), { code: 500 })),
    );
    await expect(createDriveSource(failing).listFolders(signal)).rejects.toBeInstanceOf(SyncError);

    const noDrives = driveWith([{ files: [] }]);
    noDrives.drives.list = vi.fn(() =>
      Promise.reject(Object.assign(new Error("Forbidden"), { code: 403 })),
    );
    await expect(createDriveSource(noDrives).listFolders(signal)).rejects.toBeInstanceOf(SyncError);
  });

  test("the source attaches the producer under the field its profile declares", async () => {
    const instance = await sourceEntry("google-drive").create(
      { accountId: "maya.reeves@example.com" } as never,
      { auth: {}, accountId: "maya.reeves@example.com" } as never,
    );
    expect(Object.keys(instance.filterLists ?? {})).toEqual([DRIVE_FOLDERS_FIELD]);
  });
});

describe("Drive: what the source declares", () => {
  test("folders are a tree field from revision 2, with the words a picker shows", () => {
    const entry = sourceEntry("google-drive");
    expect(entry.contract?.outputRevision).toBe(GOOGLE_DRIVE_OUTPUT_REVISION);
    expect(GOOGLE_DRIVE_OUTPUT_REVISION).toBe(2);
    expect(entry.documentEventProfile).toBe(googleDriveDocumentEventProfile);
    expect(() =>
      validateDocumentEventProfile(googleDriveDocumentEventProfile, "google-drive", {
        outputRevision: GOOGLE_DRIVE_OUTPUT_REVISION,
        partitioned: false,
      }),
    ).not.toThrow();
    expect(googleDriveDocumentEventProfile.metadataFields).toEqual([
      expect.objectContaining({
        path: DRIVE_FOLDERS_FIELD,
        type: "string-array",
        filter: {
          capability: "tree",
          minVersion: 2,
          scope: "global",
          noun: { one: "folder", many: "folders" },
          levels: [{ one: "folder", many: "folders" }],
          picker: "tree",
          inside: { one: "folder", many: "folders" },
        },
      }),
    ]);
    expect(googleDriveDocumentEventProfile.personFilter).toBeUndefined();
    expect(entry.resyncCost).toBe("This downloads every file in your Drive again.");
  });

  test("the profile names the document type and person roles the normalizer writes", async () => {
    const drive = createMockDrive();
    drive.files.export = vi.fn(() =>
      Promise.resolve({ data: "Ask david.lin@example.org about the venue." }),
    );
    mockDriveFilesList(drive, [
      makeDriveFile({
        permissions: [
          { type: "user", role: "owner", emailAddress: "maya.reeves@example.com" },
          { type: "user", role: "writer", emailAddress: "jamie.lopez@example.com" },
          { type: "user", role: "reader", emailAddress: "sarah.mendez@example.io" },
        ],
      }),
    ]);

    const result = await createDriveSource(drive).sync(null);

    const [doc] = result.documents;
    expect(googleDriveDocumentEventProfile.documentTypes).toEqual([doc?.metadata.documentType]);
    expect([...new Set((doc?.metadata.people ?? []).map((person) => person.role))].sort()).toEqual(
      [...(googleDriveDocumentEventProfile.personRoles ?? [])].sort(),
    );
  });
});

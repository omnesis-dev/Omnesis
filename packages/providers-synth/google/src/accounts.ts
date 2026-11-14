// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The invented Gmail mailbox and Drive behind the Google doubles, as they
 * stand right now.
 *
 * Each starts as the active universe's fixtures and is held in memory, so a
 * test can rename a label, label a message, or move a folder or a file between
 * two syncs and watch the next ordinary sync carry it, the way the real
 * sources do: a change to a label or a folder changes only the list the
 * source publishes, and a change to what a message or a file belongs to sends
 * that one record again.
 */

import {
  driveFolderItems,
  gmailLabelItems,
  gmailListedLabelIds,
  gmailRecordLabelIds,
} from "@omnesis/provider-google";
import type { FilterListItem } from "@omnesis/types";
import type { DriveFileEntry, DriveFolderEntry, EmailEntry } from "./fixtures.js";

/** Label names Gmail reserves; such a label's id is its name. */
const GMAIL_BUILT_IN =
  /^(INBOX|SENT|DRAFT|STARRED|IMPORTANT|UNREAD|CHAT|SPAM|TRASH|CATEGORY_[A-Z]+)$/;

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

abstract class TwinAccount {
  /** The records changed since the account was loaded, oldest first. */
  readonly changes: string[] = [];
  /** How many times the account's list has been read to the end. */
  listings = 0;
  /**
   * When set, records are written the way the build before filter details
   * wrote them: without the ids a filter matches on.
   */
  beforeFilterDetails = false;
  private failing = false;

  /** Make every listing fail until switched back, as an unreachable account would. */
  failListings(failing: boolean): void {
    this.failing = failing;
  }

  protected listed(): void {
    if (this.failing) throw new Error("The account could not be listed");
    this.listings++;
  }
}

/** One Gmail account's labels and the labels on each message. */
export class GmailTwinMailbox extends TwinAccount {
  private readonly labels = new Map<string, { name: string; type: "system" | "user" }>();
  private readonly messageLabels = new Map<string, string[]>();

  constructor(entries: readonly EmailEntry[]) {
    super();
    const idByName = new Map<string, string>();
    // Ids a fixture states win over derived ones, wherever the label appears.
    for (const entry of entries) {
      (entry.labelIds ?? []).forEach((id, index) => {
        const name = entry.labels[index];
        if (name !== undefined && !idByName.has(name)) idByName.set(name, id);
      });
    }
    const idOf = (name: string): string => {
      let id = idByName.get(name);
      if (id === undefined) {
        id = GMAIL_BUILT_IN.test(name) ? name : `Label_${slug(name)}`;
        idByName.set(name, id);
      }
      return id;
    };
    for (const entry of entries) {
      const ids = entry.labelIds ?? entry.labels.map(idOf);
      ids.forEach((id, index) => {
        if (!this.labels.has(id)) this.addLabelEntry(id, entry.labels[index] ?? id);
      });
      this.messageLabels.set(entry.externalId, [...new Set(ids)]);
    }
  }

  /** The fixture entry as the mailbox holds it now: its current label ids and their names. */
  current(entry: EmailEntry): EmailEntry {
    const ids = this.messageLabels.get(entry.externalId) ?? [];
    const { labelIds: _stated, ...rest } = entry;
    return {
      ...rest,
      labels: ids.map((id) => this.labels.get(id)?.name ?? id),
      // As the real source writes them: only the ids the label list contains.
      ...(this.beforeFilterDetails
        ? {}
        : { labelIds: gmailRecordLabelIds(ids, gmailListedLabelIds(this.asGmailLabels())) }),
    };
  }

  createLabel(id: string, name: string): void {
    this.addLabelEntry(id, name);
  }

  renameLabel(id: string, name: string): void {
    this.label(id).name = name;
  }

  /** Put a label on a message; the message is sent again by the next sync. */
  addLabel(messageId: string, labelId: string): void {
    this.label(labelId);
    const ids = this.labelsOf(messageId);
    if (ids.includes(labelId)) return;
    ids.push(labelId);
    this.changes.push(messageId);
  }

  /** Take a label off a message; the message is sent again by the next sync. */
  removeLabel(messageId: string, labelId: string): void {
    const ids = this.labelsOf(messageId);
    const at = ids.indexOf(labelId);
    if (at < 0) return;
    ids.splice(at, 1);
    this.changes.push(messageId);
  }

  listLabels(): FilterListItem[] {
    this.listed();
    return gmailLabelItems(this.asGmailLabels());
  }

  /** The labels as Gmail's API returns them: a built-in label is named by its id. */
  private asGmailLabels(): Array<{ id: string; name: string; type: "system" | "user" }> {
    return [...this.labels].map(([id, label]) => ({
      id,
      name: label.type === "system" ? id : label.name,
      type: label.type,
    }));
  }

  private addLabelEntry(id: string, name: string): void {
    this.labels.set(id, { name, type: GMAIL_BUILT_IN.test(id) ? "system" : "user" });
  }

  private label(id: string): { name: string } {
    const label = this.labels.get(id);
    if (!label) throw new Error(`No label "${id}" in the synthetic mailbox`);
    return label;
  }

  private labelsOf(messageId: string): string[] {
    const ids = this.messageLabels.get(messageId);
    if (!ids) throw new Error(`No message "${messageId}" in the synthetic mailbox`);
    return ids;
  }
}

/** One Drive account's folders and the folders each file sits in. */
export class DriveTwinAccount extends TwinAccount {
  private readonly folders = new Map<string, { name: string; parents: string[] }>();
  private readonly fileParents = new Map<string, string[]>();

  constructor(files: readonly DriveFileEntry[], folders: readonly DriveFolderEntry[]) {
    super();
    for (const folder of folders) {
      this.folders.set(folder.id, { name: folder.name, parents: [...folder.parentIds] });
    }
    // A fixture file that names no folder sits in none.
    for (const file of files) this.fileParents.set(file.externalId, [...(file.parentIds ?? [])]);
  }

  /** The fixture entry as the Drive holds it now: the folders it sits in. */
  current(entry: DriveFileEntry): DriveFileEntry {
    const { parentIds: _stated, ...rest } = entry;
    return {
      ...rest,
      ...(this.beforeFilterDetails
        ? {}
        : { parentIds: [...(this.fileParents.get(entry.externalId) ?? [])] }),
    };
  }

  addFolder(id: string, name: string, parentId?: string): void {
    if (parentId !== undefined) this.folder(parentId);
    this.folders.set(id, { name, parents: parentId === undefined ? [] : [parentId] });
  }

  renameFolder(id: string, name: string): void {
    this.folder(id).name = name;
  }

  /** Move a folder under `parentId`, or to the top level when it is `undefined`. */
  moveFolder(id: string, parentId: string | undefined): void {
    const folder = this.folder(id);
    if (parentId !== undefined) this.folder(parentId);
    folder.parents = parentId === undefined ? [] : [parentId];
  }

  /** Move a file into the given folders; the file is sent again by the next sync. */
  moveFile(fileId: string, parentIds: readonly string[]): void {
    if (!this.fileParents.has(fileId)) {
      throw new Error(`No file "${fileId}" in the synthetic Drive`);
    }
    this.fileParents.set(fileId, [...parentIds]);
    this.changes.push(fileId);
  }

  listFolders(): FilterListItem[] {
    this.listed();
    return driveFolderItems({
      sharedDrives: [],
      folders: [...this.folders].map(([id, folder]) => ({
        id,
        name: folder.name,
        parents: folder.parents,
      })),
    });
  }

  private folder(id: string): { name: string; parents: string[] } {
    const folder = this.folders.get(id);
    if (!folder) throw new Error(`No folder "${id}" in the synthetic Drive`);
    return folder;
  }
}

const mailboxes = new Map<string, GmailTwinMailbox>();
const drives = new Map<string, DriveTwinAccount>();

export function registerGmailTwin(sourceId: string, mailbox: GmailTwinMailbox): void {
  mailboxes.set(sourceId, mailbox);
}

export function registerDriveTwin(sourceId: string, drive: DriveTwinAccount): void {
  drives.set(sourceId, drive);
}

/** Forget a source's account, unless another host of the source has registered its own since. */
export function unregisterGoogleTwin(
  sourceId: string,
  account: GmailTwinMailbox | DriveTwinAccount,
): void {
  if (mailboxes.get(sourceId) === account) mailboxes.delete(sourceId);
  if (drives.get(sourceId) === account) drives.delete(sourceId);
}

/** The live mailbox of a fully qualified `gmail:<account>` source. */
export function getGmailTwin(sourceId: string): GmailTwinMailbox | undefined {
  return mailboxes.get(sourceId);
}

/** The live Drive of a fully qualified `google-drive:<account>` source. */
export function getDriveTwin(sourceId: string): DriveTwinAccount | undefined {
  return drives.get(sourceId);
}

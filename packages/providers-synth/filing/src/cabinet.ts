// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The invented account behind the filing source: notes, the folders they are
 * filed in, and the groups they are shared with.
 *
 * It starts as the active universe's `sources/filing/cabinet.json` and is held
 * in memory, so a test can rename, move or delete a folder or change a group
 * between two syncs and watch the next ordinary sync carry the change. Nothing
 * here touches a note: a change to a folder or a group is a change to a list,
 * never to a record.
 */

import { z } from "zod";
import { loadActiveUniverse, loadSourceFixtureJson } from "@omnesis/providers-synth-common";
import { FILTER_IDENTIFIER_TYPES, type FilterListItem } from "@omnesis/types";

const instant = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const cabinetSchema = z
  .object({
    folders: z.array(
      z
        .object({ id: z.string().min(1), name: z.string(), parentId: z.string().optional() })
        .strict(),
    ),
    groups: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string(),
          members: z.array(
            z.object({ type: z.enum(FILTER_IDENTIFIER_TYPES), value: z.string().min(1) }).strict(),
          ),
        })
        .strict(),
    ),
    notes: z.array(
      z
        .object({
          id: z.string().min(1),
          title: z.string().min(1),
          text: z.string(),
          /** The folders the note is filed in; empty when it is filed nowhere. */
          folderIds: z.array(z.string()),
          groupId: z.string().min(1),
          createdAt: instant,
        })
        .strict(),
    ),
  })
  .strict();
type CabinetFixture = z.infer<typeof cabinetSchema>;
export type FilingNote = CabinetFixture["notes"][number];

export function loadCabinet(): CabinetFixture {
  return cabinetSchema.parse(
    loadSourceFixtureJson<unknown>(loadActiveUniverse(), "filing", "cabinet.json"),
  );
}

/** One account's folders and groups, as they stand right now. */
export class FilingCabinet {
  private readonly folders: Map<string, { name: string; parentId?: string }>;
  private readonly groups: Map<string, { name: string; members: FilterListItem["members"] }>;
  private failing = false;
  /** How many times each list has been read to the end. */
  readonly listings = { folders: 0, groups: 0 };

  constructor(fixture: CabinetFixture) {
    this.folders = new Map(
      fixture.folders.map((folder) => [
        folder.id,
        { name: folder.name, ...(folder.parentId ? { parentId: folder.parentId } : {}) },
      ]),
    );
    this.groups = new Map(
      fixture.groups.map((group) => [group.id, { name: group.name, members: group.members }]),
    );
  }

  renameFolder(id: string, name: string): void {
    this.folder(id).name = name;
  }

  /** Move a folder under `parentId`, or to the top level when it is `undefined`. */
  moveFolder(id: string, parentId: string | undefined): void {
    const folder = this.folder(id);
    if (parentId === undefined) delete folder.parentId;
    else {
      this.folder(parentId);
      folder.parentId = parentId;
    }
  }

  /** Delete a folder; the folders inside it move to the top level. */
  deleteFolder(id: string): void {
    this.folder(id);
    this.folders.delete(id);
    for (const folder of this.folders.values()) {
      if (folder.parentId === id) delete folder.parentId;
    }
  }

  addFolder(id: string, name: string, parentId?: string): void {
    this.folders.set(id, { name, ...(parentId ? { parentId } : {}) });
  }

  renameGroup(id: string, name: string): void {
    this.group(id).name = name;
  }

  setGroupMembers(id: string, members: NonNullable<FilterListItem["members"]>): void {
    this.group(id).members = members;
  }

  /** Make every listing fail until switched back, as an unreachable account would. */
  failListings(failing: boolean): void {
    this.failing = failing;
  }

  listFolders(): FilterListItem[] {
    this.assertReachable();
    this.listings.folders++;
    return [...this.folders].map(([id, folder]) => ({
      id,
      label: folder.name,
      ...(folder.parentId ? { parentId: folder.parentId } : {}),
    }));
  }

  listGroups(): FilterListItem[] {
    this.assertReachable();
    this.listings.groups++;
    return [...this.groups].map(([id, group]) => ({
      id,
      label: group.name,
      members: group.members ?? [],
    }));
  }

  private assertReachable(): void {
    if (this.failing) throw new Error("The filing account could not be listed");
  }

  private folder(id: string): { name: string; parentId?: string } {
    const folder = this.folders.get(id);
    if (!folder) throw new Error(`No folder "${id}" in the filing cabinet`);
    return folder;
  }

  private group(id: string): { name: string; members: FilterListItem["members"] } {
    const group = this.groups.get(id);
    if (!group) throw new Error(`No group "${id}" in the filing cabinet`);
    return group;
  }
}

const cabinets = new Map<string, FilingCabinet>();

export function registerCabinet(sourceId: string, cabinet: FilingCabinet): void {
  cabinets.set(sourceId, cabinet);
}

export function unregisterCabinet(sourceId: string): void {
  cabinets.delete(sourceId);
}

/** The live cabinet of a fully qualified `filing:<account>` source. */
export function getFilingCabinet(sourceId: string): FilingCabinet | undefined {
  return cabinets.get(sourceId);
}

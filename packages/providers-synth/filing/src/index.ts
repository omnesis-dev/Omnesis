// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A synthetic source with nothing real behind it, whose records can be
 * filtered on two fields: the folders a note is filed in, which form a tree,
 * and the group a note is shared with, whose list carries each group's
 * members. It exists so the machinery that publishes and stores those lists
 * can be driven end to end without any real provider.
 *
 * It discovers an account only in a universe that lists it.
 */

import { defineSource, withFilterLists } from "@omnesis/source-sdk";
import { computeContentHash } from "@omnesis/core";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  syncFromFixture,
  universeAccounts,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import {
  FilingCabinet,
  loadCabinet,
  registerCabinet,
  unregisterCabinet,
  type FilingNote,
} from "./cabinet.js";
import { filingIcon } from "./icons.js";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

export { getFilingCabinet, type FilingCabinet } from "./cabinet.js";

/** Profile path of the folders a note is filed in. */
export const FILING_FOLDERS_FIELD = "extra.folderIds";
/** Profile path of the group a note is shared with. */
export const FILING_GROUP_FIELD = "extra.groupId";

function mapNote(note: FilingNote, sourceId: SourceId, providerId: ProviderId): DocumentInput {
  return {
    sourceId,
    providerId,
    externalId: note.id,
    title: note.title,
    content: note.text,
    contentHash: computeContentHash(note.text),
    metadata: {
      documentType: "note",
      extra: { folderIds: [...note.folderIds], groupId: note.groupId },
    },
    sourceCreatedAt: note.createdAt,
    sourceUpdatedAt: note.createdAt,
  };
}

export default defineSource<SynthCursor>({
  id: "filing",
  name: "Filing cabinet",
  description: "Notes filed in folders and shared with groups",
  authType: "local",
  unitName: "notes",
  primaryCount: "documents",
  documentEventProfile: {
    documentTypes: ["note"],
    personRoles: [],
    metadataFields: [
      {
        path: FILING_FOLDERS_FIELD,
        type: "string-array",
        description: "Ids of the folders the note is filed in.",
        filter: {
          capability: "tree",
          minVersion: 0,
          scope: "global",
          noun: { one: "folder", many: "folders" },
          levels: [
            { one: "drawer", many: "drawers" },
            { one: "folder", many: "folders" },
          ],
          picker: "tree",
          inside: { one: "folder", many: "folders" },
        },
      },
      {
        path: FILING_GROUP_FIELD,
        type: "string",
        description: "Id of the group the note is shared with.",
        filter: {
          capability: "membership",
          minVersion: 0,
          scope: "global",
          noun: { one: "group", many: "groups" },
          picker: "search",
          listsMembers: true,
        },
      },
    ],
  },
  singleInstance: true,
  icon: filingIcon,
  discover: async () => preDiscoveredAccounts("filing", universeAccounts("filing")),
  authFlow: async () => fakeLocalFlow("filing", universeAccounts("filing")[0] ?? "synthetic"),
  async create({ sourceId, providerId }) {
    const fixture = loadCabinet();
    const cabinet = new FilingCabinet(fixture);
    registerCabinet(String(sourceId), cabinet);
    return withFilterLists(
      {
        sync: async (cursor) =>
          syncFromFixture(fixture.notes, cursor, (note) => mapNote(note, sourceId, providerId), {
            sourceId,
          }),
        dispose: async () => unregisterCabinet(String(sourceId)),
      },
      {
        [FILING_FOLDERS_FIELD]: () => cabinet.listFolders(),
        [FILING_GROUP_FIELD]: () => cabinet.listGroups(),
      },
    );
  },
});

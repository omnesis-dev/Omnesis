// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  sha256Hex,
  personMention,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

interface NoteEntry {
  externalId: string;
  path: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  modifiedAt: string;
}

let cached: NoteEntry[] | null = null;

export function loadNotes(): NoteEntry[] {
  if (cached) return cached;
  cached = loadSourceFixtureJson<NoteEntry[]>(loadActiveUniverse(), "obsidian-notes", "notes.json");
  return cached;
}

export function mapNote(
  e: NoteEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: e.title,
    content: e.body,
    contentHash: sha256Hex(`${e.externalId}:${e.body}:${e.modifiedAt}`),
    metadata: {
      documentType: "note",
      tags: e.tags,
      people: [personMention("self", "author")],
      extra: {
        path: e.path,
      },
    },
    sourceCreatedAt: e.createdAt,
    sourceUpdatedAt: e.modifiedAt,
  };
}

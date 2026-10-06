// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { defineSource } from "@omnesis/source-sdk";
import { computeContentHash } from "@omnesis/core";
import {
  fakeLocalFlow,
  loadActiveUniverse,
  loadSourceFixtureJson,
  preDiscoveredAccounts,
  universeAccounts,
  syncFromFixture,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import { photosIcon } from "./icons.js";
import type { DocumentInput, SourceId, ProviderId } from "@omnesis/types";
const instant = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const photoSchema = z
  .object({
    id: z.string().min(1),
    createdAt: instant,
    modifiedAt: instant,
    isScreenshot: z.boolean().optional(),
    placeName: z.string().optional(),
    textLines: z.array(z.string()),
    tags: z.array(z.string()).optional(),
  })
  .strict();
export type PhotoFixture = z.infer<typeof photoSchema>;
export function loadPhotos(): PhotoFixture[] {
  const entries = z
    .array(photoSchema)
    .parse(loadSourceFixtureJson<unknown>(loadActiveUniverse(), "photos", "photos.json"));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new Error("Synthetic photos repeat an asset id");
  return entries;
}
/** Mirrors the native PhotosDocumentBuilder analysis-fragment contract, not PhotoKit or image inference. */
export function mapPhoto(
  entry: PhotoFixture,
  sourceId: SourceId,
  providerId: ProviderId,
): DocumentInput {
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(entry.createdAt));
  const title = [entry.isScreenshot ? "Screenshot" : "Photo", entry.placeName, date]
    .filter(Boolean)
    .join(" · ");
  const lines = [...entry.textLines, ...(entry.placeName ? [`Place: ${entry.placeName}`] : [])];
  const content = lines.join("\n") || title;
  const extractedText = entry.textLines.join("\n");
  return {
    sourceId,
    providerId,
    externalId: entry.id,
    title,
    content,
    contentHash: computeContentHash(content),
    ...(extractedText ? { extractedContentHash: computeContentHash(extractedText) } : {}),
    metadata: {
      documentType: entry.isScreenshot ? "screenshot" : "photo",
      tags: [...new Set(entry.tags ?? [])].sort(),
      ...(!entry.textLines.length && !entry.tags?.length && !entry.placeName
        ? { lowSignal: true as const }
        : {}),
    },
    sourceCreatedAt: entry.createdAt,
    sourceUpdatedAt: entry.modifiedAt,
  };
}
export default defineSource<SynthCursor>({
  id: "photos",
  name: "Photos",
  description: "Photos and screenshots from the iPhone photo library",
  authType: "local",
  unitName: "photos",
  primaryCount: "documents",
  documentEventProfile: {
    documentTypes: ["photo", "screenshot"],
    personRoles: [],
    metadataFields: [
      {
        path: "tags",
        type: "string-array",
        description: "Image-analysis tags attached to the asset.",
      },
    ],
  },
  singleInstance: true,
  multiDevice: { mode: "partitioned" },
  icon: photosIcon,
  discover: async () => preDiscoveredAccounts("photos", universeAccounts("photos")),
  authFlow: async () => fakeLocalFlow("photos", universeAccounts("photos")[0] ?? "synthetic-ios"),
  async create({ sourceId, providerId }) {
    const entries = loadPhotos();
    return {
      sync: async (cursor) =>
        syncFromFixture(entries, cursor, (entry) => mapPhoto(entry, sourceId, providerId), {
          sourceId,
        }),
    };
  },
});

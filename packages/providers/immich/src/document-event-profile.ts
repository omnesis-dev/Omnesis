// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the Immich source's documents can be asked about. Every entry
 * describes what `normalizer.ts` really writes; `document-event-profile.test.ts`
 * pins the two together, because a declared value nobody emits compiles a
 * watch that can never fire.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

export const immichDocumentEventProfile: DocumentEventProfile = {
  // One document per photo or video in the user's Immich library.
  documentTypes: ["photo", "video"],
  // The people Immich recognised by face and the user named are participants
  // — they were there. The owner is the user themself, whose library it is.
  personRoles: ["participant", "owner"],
  metadataFields: [
    {
      path: "extra.takenAt",
      type: "string",
      description:
        "When the photo or video was taken, as a UTC ISO 8601 timestamp: the camera's EXIF capture time, or the file's own date when the file carries none.",
    },
    {
      path: "extra.city",
      type: "string",
      description:
        "The city Immich reverse-geocoded from the capture's GPS position. Absent when the asset has no position.",
    },
    {
      path: "extra.country",
      type: "string",
      description:
        "The country Immich reverse-geocoded from the capture's GPS position, by its English name. Absent when the asset has no position.",
    },
    {
      path: "extra.state",
      type: "string",
      description:
        "The state or region Immich reverse-geocoded from the capture's GPS position. Absent when the asset has no position or the place has no region.",
    },
    {
      path: "extra.timeZone",
      type: "string",
      description:
        "The IANA time zone the photo or video was taken in, from its EXIF data, such as 'Europe/Lisbon'. Absent when the file names no zone.",
    },
    {
      path: "extra.albums",
      type: "string-array",
      description:
        "The names of the Immich albums the asset is in, as the user named them — often an event or a trip. Empty when it is in none. Refreshed once a day, so a photo added to an album shows the album by the next day.",
    },
    {
      path: "extra.people",
      type: "string-array",
      description:
        "The names of the people Immich recognised in the photo or video by face and the user named. Unnamed and hidden faces are not listed.",
      identifiesPeople: true,
    },
    {
      path: "extra.cameraMake",
      type: "string",
      description:
        "The camera or phone maker from the file's EXIF data, such as 'Apple' or 'Sony'. Absent when the file names none.",
    },
    {
      path: "extra.cameraModel",
      type: "string",
      description:
        "The camera or phone model from the file's EXIF data. Absent when the file names none.",
    },
    {
      path: "extra.durationMs",
      type: "number",
      description: "A video's length in milliseconds. Absent on photos.",
    },
    {
      path: "extra.isFavorite",
      type: "boolean",
      description: "True when the user marked the asset as a favorite in Immich, otherwise false.",
    },
    {
      path: "extra.isArchived",
      type: "boolean",
      description:
        "True when the user archived the asset in Immich, which hides it from the timeline without deleting it; otherwise false.",
    },
  ],
};

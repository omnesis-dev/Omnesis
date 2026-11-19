// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the Plaud source's documents can be asked about — the document-side
 * declaration contract consumed by subscription compilation.
 *
 * Every entry describes what `normalizer.ts` really writes;
 * `document-event-profile.test.ts` pins these values to its output.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

export const plaudDocumentEventProfile: DocumentEventProfile = {
  // One document per recording made on a Plaud voice recorder.
  documentTypes: ["conversation"],
  // The account owner, who made the recording. Other voices are only the
  // labels Plaud gave them, so they are a field rather than people.
  personRoles: ["owner"],
  metadataFields: [
    {
      path: "extra.durationSeconds",
      type: "number",
      description: "Length of the recording in seconds.",
    },
    {
      path: "extra.device",
      type: "string",
      description:
        "Name of the Plaud recorder that made the recording, as the owner named it in the Plaud app, or its model. Absent when Plaud does not name the device.",
    },
    {
      path: "extra.transcriptSource",
      type: "string",
      description:
        "Where the transcript came from: 'local' when Omnesis's own transcriber transcribed the audio, 'plaud' when Plaud's transcript stands in, 'none' when there is no transcript yet.",
      canonicalValues: ["local", "plaud", "none"],
    },
    {
      path: "extra.hasSummary",
      type: "boolean",
      description: "Whether Plaud produced a summary of the recording.",
    },
    {
      path: "extra.speakers",
      type: "string-array",
      description:
        "Speaker labels in Plaud's transcript, in order of first appearance: names the owner assigned in the Plaud app, or Plaud's own labels such as 'Speaker 1'. Absent when the transcript is not Plaud's.",
      identifiesPeople: true,
    },
    {
      path: "extra.keywords",
      type: "string-array",
      description:
        "Keywords Plaud extracted from the recording, such as topics or project names. Absent when Plaud listed none.",
    },
    {
      path: "extra.language",
      type: "string",
      description:
        "Language the transcriber detected, as an ISO-639-1 code such as 'en'. Present only on a transcript Omnesis made.",
    },
  ],
};

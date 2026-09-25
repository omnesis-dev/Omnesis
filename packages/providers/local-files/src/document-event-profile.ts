// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the Local Files source's documents can be asked about — the
 * document-side declaration contract consumed by subscription compilation.
 *
 * Every entry describes the wire contract of `normalizer.ts`: the `file`
 * document type it emits, the `author` role it really asserts (your own
 * data — no platform identity), and the metadata it really populates.
 */
import type { DocumentEventProfile } from "@omnesis/source-sdk";

export const localFilesDocumentEventProfile: DocumentEventProfile = {
  documentTypes: ["file"],
  // The operator's own files: the source asserts authorship, nothing else.
  personRoles: ["author"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Folder segments of the file's location inside its root, shallowest first — e.g. 'Documents', 'Insurance', '2024'. A hand-built taxonomy the operator already paid for. Binary-extracted and text files alike carry these.",
    },
    {
      path: "extra.path",
      type: "string",
      description:
        "Display path of the file, home-relative (e.g. '~/Downloads/quote.pdf'). Descriptive, not actionable: there is no reliable destination, so sourceUrl is omitted and clients render this with the owning device name plus a copy button.",
    },
    {
      path: "extra.directory",
      type: "string",
      description:
        "The file's directory in display form (e.g. '~/Downloads'). Facetable: conditions about where a file lives match here.",
    },
    {
      path: "extra.mimeType",
      type: "string",
      description: "Canonical MIME type of the file, from the source's allow-list mapping.",
    },
  ],
};

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the Paperless-ngx source's documents can be asked about — the
 * document-side declaration contract consumed by subscription compilation.
 *
 * Every entry describes what `normalizer.ts` really writes;
 * `document-event-profile.test.ts` pins these values to its output.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

export const paperlessDocumentEventProfile: DocumentEventProfile = {
  // One document per archived Paperless-ngx document.
  documentTypes: ["document"],
  // The operator, on the documents they own. The correspondent is a name with
  // nothing to resolve it by, so it is a field rather than a person.
  personRoles: ["owner"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Tag names the operator gave the document in Paperless-ngx, such as 'Tax', 'Insurance' or 'Paid'. Open vocabulary chosen by the operator. Absent when the document has no tags.",
    },
    {
      path: "extra.correspondent",
      type: "string",
      description:
        "Who the document is from, as named in Paperless-ngx — usually an organisation such as a bank, an energy provider or an insurer, sometimes a person such as a doctor. Absent when no correspondent is set.",
      identifiesPeople: true,
    },
    {
      path: "extra.paperlessDocumentType",
      type: "string",
      description:
        "The operator's own document type in Paperless-ngx, such as 'Invoice', 'Contract', 'Receipt' or 'Payslip'. Open vocabulary: Paperless-ngx ships none, so each operator names their own. Absent when no type is set.",
    },
    {
      path: "extra.createdDate",
      type: "string",
      description:
        "The document's own date as YYYY-MM-DD — the date printed on the letter or invoice, not when it was scanned or added.",
    },
    {
      path: "extra.archiveSerialNumber",
      type: "number",
      description:
        "Archive serial number (ASN) the operator stamped on the physical original. Absent when none was assigned.",
    },
    {
      path: "extra.originalFileName",
      type: "string",
      description:
        "The file name the document was uploaded or scanned under, such as 'scan-0315.pdf'. Can carry a person's name when the operator named the file after one.",
      identifiesPeople: true,
    },
    {
      path: "extra.mimeType",
      type: "string",
      description:
        "Media type of the original file, such as 'application/pdf', 'image/jpeg' or 'image/png'.",
      canonicalValues: ["application/pdf", "image/jpeg", "image/png", "image/tiff", "text/plain"],
    },
    {
      path: "extra.pageCount",
      type: "number",
      description:
        "Number of pages in the archived file. Absent when Paperless-ngx did not count them.",
    },
  ],
};

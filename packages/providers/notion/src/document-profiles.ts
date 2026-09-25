// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the two Notion sources' documents can be asked about — the document
 * half of the contract `AnalyticsTableSchema` already covers for rows.
 *
 * Every entry mirrors what the normalizer actually writes. All three document
 * shapes (a standalone page, a database's schema summary, a database row)
 * stamp the `document` type, name `created_by` as `author`, and name a
 * distinct `last_edited_by` as `mentioned`; only the summary document carries
 * a tag. Fields the normalizer fills with an opaque Notion UUID
 * (`extra.notionId`, `extra.notionDatabaseId`) or a derived analytics table
 * name (`extra.duckdbTable`) are deliberately absent: no natural-language
 * phrase yields one of those values, so a condition referencing them could
 * only ever be built from a guess.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

/**
 * Standalone workspace pages. Pages parented by a database are excluded here —
 * the databases source owns those.
 */
export const notionPagesDocumentProfile: DocumentEventProfile = {
  documentTypes: ["document"],
  personRoles: ["author", "mentioned"],
  metadataFields: [
    {
      path: "extra.parentType",
      type: "string",
      description:
        "Where the page sits in the workspace hierarchy: at the workspace root, nested under another page, or nested inside a block such as a toggle or a column. Notion's own parent vocabulary, so other values can appear as the API grows.",
      canonicalValues: ["workspace", "page_id", "block_id"],
      valueAliases: {
        workspace: ["top-level page", "workspace root", "not a subpage"],
        page_id: ["subpage", "child page", "nested under another page"],
        block_id: ["inside a block", "inside a toggle", "inside a column"],
      },
    },
  ],
};

/**
 * Notion databases: one document summarising each database's schema, plus one
 * document per row.
 */
export const notionDatabasesDocumentProfile: DocumentEventProfile = {
  documentTypes: ["document"],
  personRoles: ["author", "mentioned"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Carried only by the document that summarises a database's schema, which is how a database itself is told apart from its rows — row documents carry no tags.",
      allowedValues: ["notion-database"],
      valueAliases: {
        "notion-database": ["a database", "a database's schema", "a table definition"],
      },
    },
  ],
};

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/**
 * One row per Paperless-ngx document. The OCR text rides in as a searchable
 * document on the same page; this table holds the facets SQL filters and
 * groups by — who sent it, what kind of document, its own date, its tags.
 */
export const paperlessDocumentsSchema: AnalyticsTableSchema = {
  tableName: "paperless_documents",
  displayName: "Paperless-ngx Documents",
  description:
    "Archived paper documents in Paperless-ngx — title, correspondent, document type, tags, document date",
  columns: [
    { name: "id", type: "BIGINT", description: "Paperless-ngx document id" },
    { name: "title", type: "VARCHAR", description: "Document title" },
    {
      name: "correspondent",
      type: "VARCHAR",
      description: "Who the document is from — usually an organisation such as a bank or utility",
      nullable: true,
    },
    {
      name: "document_type",
      type: "VARCHAR",
      description: "The operator's own document type, such as Invoice, Contract or Receipt",
      nullable: true,
    },
    {
      name: "tags",
      type: "JSON",
      description: "Tag names on the document, as a JSON array",
      nullable: true,
    },
    {
      name: "created_date",
      type: "DATE",
      description: "The document's own date — the date on the letter or invoice, not the scan date",
      nullable: true,
    },
    {
      name: "added_at",
      type: "TIMESTAMPTZ",
      description: "When the document was added to Paperless-ngx (UTC)",
      nullable: true,
    },
    {
      name: "modified_at",
      type: "TIMESTAMPTZ",
      description: "When the document or its metadata last changed (UTC)",
    },
    {
      name: "archive_serial_number",
      type: "BIGINT",
      description: "Archive serial number (ASN) of the physical original",
      nullable: true,
    },
    {
      name: "original_file_name",
      type: "VARCHAR",
      description: "File name the document was uploaded with",
      nullable: true,
    },
    { name: "page_count", type: "INTEGER", description: "Number of pages", nullable: true },
    {
      name: "mime_type",
      type: "VARCHAR",
      description: "MIME type of the original",
      nullable: true,
    },
    { name: "note_count", type: "INTEGER", description: "Number of notes on the document" },
    {
      name: "web_url",
      type: "VARCHAR",
      description: "Link to the document in the Paperless-ngx web UI",
      references: "url",
    },
    {
      name: "synced_at",
      type: "TIMESTAMPTZ",
      description: "When Omnesis last ingested this row",
      volatile: true,
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      sourceColumnId: "omnesis:source_account_id",
      description:
        "Which Omnesis account wrote this row — discriminates sibling connections sharing the table",
    },
  ],
  // Paperless numbers documents per instance, from 1, so two instances share
  // every small id: the account is part of the key, and removing one deletes
  // only its own rows.
  primaryKey: ["source_account_id", "id"],
  sharedDiscriminatorColumn: "source_account_id",
  // A document is placed at its own date, which is what "my 2025 invoices" means.
  semanticTimeColumn: "created_date",
  record: {
    titleColumns: ["title"],
    keyColumns: ["title", "correspondent", "document_type", "created_date"],
  },
  // Each row co-describes the searchable document with the same id, in the
  // same account's source.
  boundDocument: { externalIdColumns: ["id"], sourceKeyColumns: ["source_account_id"] },
  exampleQueries: [
    "SELECT correspondent, COUNT(*) AS n FROM paperless_documents GROUP BY correspondent ORDER BY n DESC",
    "SELECT title, correspondent, created_date FROM paperless_documents WHERE document_type = 'Invoice' ORDER BY created_date DESC LIMIT 20",
    "SELECT title, created_date FROM paperless_documents WHERE list_contains(CAST(tags AS VARCHAR[]), 'Tax') ORDER BY created_date DESC",
  ],
};

/**
 * One row per custom field value per document — the typed values an operator
 * records on a document, such as an amount due, a due date or a contract end.
 * The typed columns are what makes "what did I pay for electricity this year"
 * a query rather than a reading exercise.
 */
export const paperlessCustomFieldValuesSchema: AnalyticsTableSchema = {
  tableName: "paperless_custom_field_values",
  displayName: "Paperless-ngx Custom Field Values",
  description:
    "Typed custom field values on Paperless-ngx documents — amounts, dates, numbers, selections",
  columns: [
    { name: "document_id", type: "BIGINT", description: "Paperless-ngx document id" },
    { name: "field_id", type: "BIGINT", description: "Paperless-ngx custom field id" },
    { name: "field_name", type: "VARCHAR", description: "Custom field name, such as Amount due" },
    {
      name: "data_type",
      type: "VARCHAR",
      description: "The field's Paperless-ngx data type, which says which value column is filled",
      canonicalValues: [
        "string",
        "longtext",
        "url",
        "date",
        "boolean",
        "integer",
        "float",
        "monetary",
        "documentlink",
        "select",
      ],
    },
    {
      name: "value_text",
      type: "VARCHAR",
      description: "The value as written, for every data type (a select field's chosen label)",
      nullable: true,
    },
    {
      name: "value_number",
      type: "DOUBLE",
      description: "Numeric value for integer, float and monetary fields",
      nullable: true,
    },
    {
      name: "value_date",
      type: "DATE",
      description: "Date value for date fields",
      nullable: true,
    },
    {
      name: "value_boolean",
      type: "BOOLEAN",
      description: "Value of a boolean field",
      nullable: true,
    },
    {
      name: "currency",
      type: "VARCHAR",
      description: "ISO 4217 currency code of a monetary value",
      nullable: true,
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      sourceColumnId: "omnesis:source_account_id",
      description:
        "Which Omnesis account wrote this row — discriminates sibling connections sharing the table",
    },
  ],
  primaryKey: ["source_account_id", "document_id", "field_id"],
  // A document's values are re-read together, so they are replaced together:
  // a field removed from a document must not leave its old value behind.
  deleteKey: ["source_account_id", "document_id"],
  sharedDiscriminatorColumn: "source_account_id",
  // A value describes a document; its own time is the document's.
  semanticTimeColumn: null,
  record: {
    titleColumns: ["field_name", "value_text"],
    titleTemplate: "{field_name}: {value_text}",
    keyColumns: ["field_name", "value_text"],
  },
  exampleQueries: [
    "SELECT d.correspondent, v.currency, SUM(v.value_number) AS total FROM paperless_custom_field_values v JOIN paperless_documents d ON d.id = v.document_id AND d.source_account_id = v.source_account_id WHERE v.data_type = 'monetary' AND d.created_date >= DATE '2026-01-01' GROUP BY d.correspondent, v.currency ORDER BY total DESC",
    "SELECT d.title, v.field_name, v.value_date FROM paperless_custom_field_values v JOIN paperless_documents d ON d.id = v.document_id AND d.source_account_id = v.source_account_id WHERE v.data_type = 'date' AND v.value_date >= current_date ORDER BY v.value_date",
  ],
};

export const allSchemas = [paperlessDocumentsSchema, paperlessCustomFieldValuesSchema];

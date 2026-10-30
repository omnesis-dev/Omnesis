// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash } from "@omnesis/core";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";
import type {
  PaperlessCustomField,
  PaperlessDocument,
  PaperlessLookups,
  PaperlessNote,
} from "./types.js";

/**
 * Longest OCR text a document carries. A scanned book can run to megabytes;
 * past this the head is kept and the cut is said out loud, so a search hit
 * never pretends to have read the whole file.
 */
export const MAX_CONTENT_CHARS = 1_000_000;

export interface NormalizeContext {
  providerId: ProviderId;
  sourceId: SourceId;
  accountId: string;
  /** The Paperless user the token belongs to. */
  selfUserId: number;
  /** The Paperless UI's address for a document id. */
  documentUrl: (id: number) => string;
  syncedAt: string;
}

/** A custom field value in every typed form a column can hold it in. */
export interface CustomFieldValue {
  fieldId: number;
  name: string;
  dataType: string;
  text: string | null;
  number: number | null;
  date: string | null;
  boolean: boolean | null;
  currency: string | null;
}

/** Everything one Paperless document becomes. */
export interface NormalizedDocument {
  document: DocumentInput;
  row: Record<string, unknown>;
  fieldRows: Record<string, unknown>[];
}

export function normalizeDocument(
  doc: PaperlessDocument,
  lookups: PaperlessLookups,
  ctx: NormalizeContext,
): NormalizedDocument {
  const title = doc.title?.trim() || doc.original_file_name?.trim() || `Document ${doc.id}`;
  const correspondent =
    doc.correspondent !== null ? (lookups.correspondents.get(doc.correspondent) ?? null) : null;
  const documentType =
    doc.document_type !== null ? (lookups.documentTypes.get(doc.document_type) ?? null) : null;
  const tags = doc.tags
    .map((id) => lookups.tags.get(id))
    .filter((name): name is string => Boolean(name));
  const fields = (doc.custom_fields ?? []).flatMap((instance) => {
    const definition = lookups.customFields.get(instance.field);
    return definition ? [customFieldValue(definition, instance.value)] : [];
  });
  const notes = Array.isArray(doc.notes) ? doc.notes.filter((n) => n?.note?.trim()) : [];
  const created = parseCreated(doc.created);
  // The sync validates `modified` before a document gets here; the fallback
  // only keeps the type honest.
  const modified = toUtc(doc.modified) ?? ctx.syncedAt;
  const url = ctx.documentUrl(doc.id);

  const content = renderMarkdown({
    title,
    correspondent,
    documentType,
    createdDate: created.date,
    tags,
    fields,
    notes,
    text: doc.content ?? "",
  });

  // The papers are the operator's own when they own them, or when nobody
  // does. On an instance several people share, a token can also see a
  // partner's documents; those are indexed but never attributed to self.
  //
  // The correspondent is not a mention: it is a name and nothing else — no
  // address, no number — and a name alone never resolves to a person. It is
  // carried as `extra.correspondent`, which watches read as naming people.
  const ownedBySelf = doc.owner === null || doc.owner === undefined || doc.owner === ctx.selfUserId;
  const people: PersonMention[] = ownedBySelf ? [{ role: "owner", isSelf: true }] : [];

  const document: DocumentInput = {
    providerId: ctx.providerId,
    sourceId: ctx.sourceId,
    externalId: String(doc.id),
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "document",
      sourceUrl: url,
      ...(tags.length > 0 ? { tags } : {}),
      ...(people.length > 0 ? { people } : {}),
      extra: {
        ...(correspondent ? { correspondent } : {}),
        ...(documentType ? { paperlessDocumentType: documentType } : {}),
        ...(created.date ? { createdDate: created.date } : {}),
        ...(isCount(doc.archive_serial_number)
          ? { archiveSerialNumber: doc.archive_serial_number }
          : {}),
        ...(doc.original_file_name ? { originalFileName: doc.original_file_name } : {}),
        ...(doc.mime_type ? { mimeType: doc.mime_type } : {}),
        ...(isCount(doc.page_count) ? { pageCount: doc.page_count } : {}),
      },
    },
    sourceCreatedAt: created.timestamp ?? toUtc(doc.added) ?? modified,
    sourceUpdatedAt: modified,
  };

  const row: Record<string, unknown> = {
    id: doc.id,
    title,
    correspondent,
    document_type: documentType,
    tags: tags.length > 0 ? JSON.stringify(tags) : null,
    created_date: created.date,
    added_at: toUtc(doc.added) ?? null,
    modified_at: modified,
    archive_serial_number: isCount(doc.archive_serial_number) ? doc.archive_serial_number : null,
    original_file_name: doc.original_file_name ?? null,
    page_count: isCount(doc.page_count) ? doc.page_count : null,
    mime_type: doc.mime_type ?? null,
    note_count: notes.length,
    web_url: url,
    synced_at: ctx.syncedAt,
    source_account_id: ctx.accountId,
  };

  const fieldRows = fields.map((f) => ({
    source_account_id: ctx.accountId,
    document_id: doc.id,
    field_id: f.fieldId,
    field_name: f.name,
    data_type: f.dataType,
    value_text: f.text,
    value_number: f.number,
    value_date: f.date,
    value_boolean: f.boolean,
    currency: f.currency,
  }));

  return { document, row, fieldRows };
}

/**
 * Read one custom field value into every typed form it has. `text` is always
 * the human-readable form, so a field of any type is searchable and citable
 * as written; the typed columns are what SQL sums and compares.
 */
export function customFieldValue(field: PaperlessCustomField, value: unknown): CustomFieldValue {
  const base: CustomFieldValue = {
    fieldId: field.id,
    name: field.name,
    dataType: field.data_type,
    text: null,
    number: null,
    date: null,
    boolean: null,
    currency: null,
  };
  if (value === null || value === undefined || value === "") return base;
  switch (field.data_type) {
    case "integer":
    case "float": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? { ...base, number: n, text: String(n) } : base;
    }
    case "monetary": {
      // "EUR12.50" from current servers, a bare "12.50" (in the field's default
      // currency) from older ones and from a field with no currency chosen.
      const m = /^([A-Za-z]{3})?\s*(-?\d+(?:\.\d+)?)$/.exec(String(value).trim());
      if (!m) return { ...base, text: String(value) };
      const amount = Number(m[2]);
      const currency = (m[1] ?? field.extra_data?.default_currency ?? "").toUpperCase() || null;
      return {
        ...base,
        number: amount,
        currency,
        text: currency ? `${currency} ${m[2]}` : m[2]!,
      };
    }
    case "date": {
      const date =
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
      return { ...base, date, text: date ?? String(value) };
    }
    case "boolean": {
      const b = value === true || value === "true";
      return { ...base, boolean: b, text: b ? "yes" : "no" };
    }
    case "select": {
      const label = selectLabel(field, value);
      return { ...base, text: label };
    }
    case "documentlink": {
      const ids = Array.isArray(value) ? value.filter((v) => typeof v === "number") : [];
      return ids.length > 0 ? { ...base, text: ids.map((id) => `#${id}`).join(", ") } : base;
    }
    default:
      return { ...base, text: typeof value === "string" ? value : JSON.stringify(value) };
  }
}

/**
 * A select value is an option id from API version 7 and an index into the
 * option list before it; the option list itself is bare labels before and
 * `{id, label}` after. Both pairings are read.
 */
function selectLabel(field: PaperlessCustomField, value: unknown): string | null {
  const options = field.extra_data?.select_options ?? [];
  for (const option of options) {
    if (option && typeof option === "object" && option.id === value) return option.label;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    const option = options[value];
    if (typeof option === "string") return option;
    if (option && typeof option === "object") return option.label;
  }
  return typeof value === "string" ? value : null;
}

/**
 * `created` is the document's own date — the date on the letter, not the
 * scan. API version 9 sends a bare date; earlier versions a datetime at the
 * server's local midnight. The date as Paperless shows it is the date part
 * as written, never shifted through UTC.
 */
export function parseCreated(created: string | null | undefined): {
  date: string | null;
  timestamp: string | undefined;
} {
  if (!created || !/^\d{4}-\d{2}-\d{2}/.test(created)) return { date: null, timestamp: undefined };
  const date = created.slice(0, 10);
  const timestamp = created.length > 10 ? toUtc(created) : toUtc(`${date}T00:00:00Z`);
  return { date, timestamp };
}

function toUtc(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function renderMarkdown(parts: {
  title: string;
  correspondent: string | null;
  documentType: string | null;
  createdDate: string | null;
  tags: string[];
  fields: CustomFieldValue[];
  notes: PaperlessNote[];
  text: string;
}): string {
  const lines: string[] = [`# ${parts.title}`, ""];

  const meta: string[] = [];
  if (parts.correspondent) meta.push(`From: ${parts.correspondent}`);
  if (parts.documentType) meta.push(`Type: ${parts.documentType}`);
  if (parts.createdDate) meta.push(`Date: ${parts.createdDate}`);
  if (parts.tags.length > 0) meta.push(`Tags: ${parts.tags.join(", ")}`);
  if (meta.length > 0) lines.push(`> ${meta.join(" · ")}`, "");

  const fields = parts.fields.filter((f) => f.text !== null);
  if (fields.length > 0) {
    lines.push("## Fields", "");
    for (const f of fields) lines.push(`- ${f.name}: ${f.text}`);
    lines.push("");
  }

  if (parts.notes.length > 0) {
    lines.push("## Notes", "");
    for (const note of parts.notes) {
      const date = note.created?.slice(0, 10);
      lines.push(`- ${date ? `${date}: ` : ""}${note.note.trim()}`);
    }
    lines.push("");
  }

  const text = parts.text.trim();
  if (text) {
    lines.push("## Content", "");
    if (text.length > MAX_CONTENT_CHARS) {
      lines.push(text.slice(0, MAX_CONTENT_CHARS), "", "_[Content truncated]_");
    } else {
      lines.push(text);
    }
  }

  return lines.join("\n").trim();
}

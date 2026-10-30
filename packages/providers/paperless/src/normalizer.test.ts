// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  customFieldValue,
  MAX_CONTENT_CHARS,
  normalizeDocument,
  parseCreated,
} from "./normalizer.js";
import type { PaperlessCustomField, PaperlessDocument, PaperlessLookups } from "./types.js";

const lookups: PaperlessLookups = {
  tags: new Map([
    [1, "Tax"],
    [2, "Paid"],
  ]),
  correspondents: new Map([[10, "Stellar Energy"]]),
  documentTypes: new Map([[20, "Invoice"]]),
  customFields: new Map<number, PaperlessCustomField>([
    [30, { id: 30, name: "Amount due", data_type: "monetary" }],
    [31, { id: 31, name: "Due date", data_type: "date" }],
  ]),
};

const ctx = {
  providerId: ProviderId("paperless:maya@paperless.example.com"),
  sourceId: SourceId("paperless-documents:maya@paperless.example.com"),
  accountId: "maya@paperless.example.com",
  selfUserId: 3,
  documentUrl: (id: number) => `https://paperless.example.com/documents/${id}/details`,
  syncedAt: "2026-04-01T08:00:00.000Z",
};

function doc(overrides: Partial<PaperlessDocument> = {}): PaperlessDocument {
  return {
    id: 7,
    title: "March electricity",
    content: "Stellar Energy\nInvoice 2026-0315\nTotal due EUR 84.20",
    correspondent: 10,
    document_type: 20,
    tags: [1, 2],
    created: "2026-03-15",
    added: "2026-03-17T10:12:00+01:00",
    modified: "2026-03-18T08:00:00.123456+01:00",
    archive_serial_number: 512,
    original_file_name: "scan-0315.pdf",
    page_count: 2,
    mime_type: "application/pdf",
    notes: [{ id: 1, note: "Paid by bank transfer", created: "2026-03-20T09:00:00+01:00" }],
    custom_fields: [
      { field: 30, value: "EUR84.20" },
      { field: 31, value: "2026-04-01" },
    ],
    ...overrides,
  };
}

describe("normalizeDocument", () => {
  test("renders a searchable document with its metadata, fields and notes", () => {
    const { document } = normalizeDocument(doc(), lookups, ctx);

    expect(document.externalId).toBe("7");
    expect(document.title).toBe("March electricity");
    expect(document.content).toContain("# March electricity");
    expect(document.content).toContain(
      "From: Stellar Energy · Type: Invoice · Date: 2026-03-15 · Tags: Tax, Paid",
    );
    expect(document.content).toContain("- Amount due: EUR 84.20");
    expect(document.content).toContain("- Due date: 2026-04-01");
    expect(document.content).toContain("- 2026-03-20: Paid by bank transfer");
    expect(document.content).toContain("Total due EUR 84.20");
    expect(document.metadata.sourceUrl).toBe("https://paperless.example.com/documents/7/details");
    expect(document.metadata.tags).toEqual(["Tax", "Paid"]);
    expect(document.metadata.extra).toEqual({
      correspondent: "Stellar Energy",
      paperlessDocumentType: "Invoice",
      createdDate: "2026-03-15",
      archiveSerialNumber: 512,
      originalFileName: "scan-0315.pdf",
      mimeType: "application/pdf",
      pageCount: 2,
    });
  });

  test("dates the document by its own date and stamps edits in UTC", () => {
    const { document } = normalizeDocument(doc(), lookups, ctx);
    expect(document.sourceCreatedAt).toBe("2026-03-15T00:00:00.000Z");
    expect(document.sourceUpdatedAt).toBe("2026-03-18T07:00:00.123Z");
  });

  test("a document the token's user owns, or nobody owns, is the operator's own", () => {
    for (const owner of [3, null, undefined]) {
      const { document } = normalizeDocument(doc({ owner }), lookups, ctx);
      expect(document.metadata.people, String(owner)).toEqual([{ role: "owner", isSelf: true }]);
    }
  });

  test("another user's document on a shared instance is indexed but not attributed to self", () => {
    const { document } = normalizeDocument(doc({ owner: 9 }), lookups, ctx);
    expect(document.metadata.people).toBeUndefined();
    expect(document.metadata.extra?.correspondent).toBe("Stellar Energy");
  });

  test("the correspondent is a field, never a name-only person mention", () => {
    const { document } = normalizeDocument(doc(), lookups, ctx);
    expect(document.metadata.people?.map((p) => p.role)).toEqual(["owner"]);
  });

  test("a document with no correspondent, type, tags or title still reads", () => {
    const { document, row, fieldRows } = normalizeDocument(
      doc({
        title: "",
        correspondent: null,
        document_type: null,
        tags: [],
        notes: [],
        custom_fields: null,
        content: null,
      }),
      lookups,
      ctx,
    );
    expect(document.title).toBe("scan-0315.pdf");
    expect(document.metadata.tags).toBeUndefined();
    expect(document.metadata.people).toEqual([{ role: "owner", isSelf: true }]);
    expect(row.correspondent).toBeNull();
    expect(row.tags).toBeNull();
    expect(row.note_count).toBe(0);
    expect(fieldRows).toEqual([]);
  });

  test("an id no lookup knows is left out rather than shown as a number", () => {
    const { document } = normalizeDocument(doc({ tags: [1, 99], correspondent: 99 }), lookups, ctx);
    expect(document.metadata.tags).toEqual(["Tax"]);
    expect(document.metadata.extra?.correspondent).toBeUndefined();
  });

  test("builds the row and one typed row per custom field value", () => {
    const { row, fieldRows } = normalizeDocument(doc(), lookups, ctx);
    expect(row).toEqual({
      id: 7,
      title: "March electricity",
      correspondent: "Stellar Energy",
      document_type: "Invoice",
      tags: JSON.stringify(["Tax", "Paid"]),
      created_date: "2026-03-15",
      added_at: "2026-03-17T09:12:00.000Z",
      modified_at: "2026-03-18T07:00:00.123Z",
      archive_serial_number: 512,
      original_file_name: "scan-0315.pdf",
      page_count: 2,
      mime_type: "application/pdf",
      note_count: 1,
      web_url: "https://paperless.example.com/documents/7/details",
      synced_at: ctx.syncedAt,
      source_account_id: ctx.accountId,
    });
    expect(fieldRows).toEqual([
      expect.objectContaining({
        document_id: 7,
        field_id: 30,
        data_type: "monetary",
        value_number: 84.2,
        currency: "EUR",
        value_text: "EUR 84.20",
      }),
      expect.objectContaining({
        document_id: 7,
        field_id: 31,
        data_type: "date",
        value_date: "2026-04-01",
        value_text: "2026-04-01",
      }),
    ]);
  });

  test("bounds the OCR text and says it was cut", () => {
    const long = "x".repeat(MAX_CONTENT_CHARS + 10);
    const { document } = normalizeDocument(doc({ content: long }), lookups, ctx);
    expect(document.content).toContain("_[Content truncated]_");
    expect(document.content.length).toBeLessThan(MAX_CONTENT_CHARS + 1_000);
  });

  test("the content hash moves when only a note changes", () => {
    const a = normalizeDocument(doc(), lookups, ctx).document;
    const b = normalizeDocument(
      doc({ notes: [{ id: 1, note: "Disputed", created: "2026-03-21T09:00:00+01:00" }] }),
      lookups,
      ctx,
    ).document;
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

describe("customFieldValue", () => {
  const field = (
    data_type: string,
    extra_data?: PaperlessCustomField["extra_data"],
  ): PaperlessCustomField => ({
    id: 1,
    name: "Field",
    data_type,
    extra_data,
  });

  test.each([
    ["integer", 3, { number: 3, text: "3" }],
    ["float", "2.5", { number: 2.5, text: "2.5" }],
    ["boolean", true, { boolean: true, text: "yes" }],
    ["boolean", false, { boolean: false, text: "no" }],
    ["string", "Policy 42-A", { text: "Policy 42-A" }],
    ["url", "https://example.com/policy", { text: "https://example.com/policy" }],
    ["documentlink", [3, 9], { text: "#3, #9" }],
  ])("%s %j", (type, value, expected) => {
    expect(customFieldValue(field(type), value)).toEqual(expect.objectContaining(expected));
  });

  test("a monetary value without a currency takes the field's default", () => {
    expect(customFieldValue(field("monetary", { default_currency: "GBP" }), "12.50")).toEqual(
      expect.objectContaining({ number: 12.5, currency: "GBP", text: "GBP 12.50" }),
    );
    expect(customFieldValue(field("monetary"), "12.50")).toEqual(
      expect.objectContaining({ number: 12.5, currency: null, text: "12.50" }),
    );
  });

  test("a select value reads as its label, by option id or by index", () => {
    const byId = field("select", {
      select_options: [
        { id: "a1", label: "Monthly" },
        { id: "b2", label: "Yearly" },
      ],
    });
    expect(customFieldValue(byId, "b2").text).toBe("Yearly");
    const byIndex = field("select", { select_options: ["Monthly", "Yearly"] });
    expect(customFieldValue(byIndex, 0).text).toBe("Monthly");
  });

  test("an empty value fills nothing", () => {
    expect(customFieldValue(field("monetary"), null)).toEqual(
      expect.objectContaining({ text: null, number: null, currency: null }),
    );
  });
});

describe("parseCreated", () => {
  test("a bare date is that date", () => {
    expect(parseCreated("2026-03-15")).toEqual({
      date: "2026-03-15",
      timestamp: "2026-03-15T00:00:00.000Z",
    });
  });

  test("a datetime keeps the date as written, not as shifted through UTC", () => {
    expect(parseCreated("2026-03-15T00:00:00+02:00")).toEqual({
      date: "2026-03-15",
      timestamp: "2026-03-14T22:00:00.000Z",
    });
  });

  test("garbage is no date", () => {
    expect(parseCreated("soon")).toEqual({ date: null, timestamp: undefined });
  });
});

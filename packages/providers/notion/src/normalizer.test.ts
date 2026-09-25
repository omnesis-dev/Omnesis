// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { SourceId, ProviderId } from "@omnesis/types";
import { validateDocumentEventProfile } from "@omnesis/source-sdk";
import { pageToDocument, databaseSummaryToDocument, databaseRowToDocument } from "./normalizer.js";
import { notionPagesDocumentProfile, notionDatabasesDocumentProfile } from "./document-profiles.js";
import type { DocumentInput, PersonRole } from "@omnesis/types";

// ── pageToDocument ────────────────────────────────────────────────────

describe("pageToDocument", () => {
  const mockPage = {
    object: "page",
    id: "12345678-1234-1234-1234-123456789abc",
    properties: {
      Name: { type: "title", title: [{ plain_text: "My Page" }] },
    },
    url: "https://www.notion.so/my-page-12345678123412341234123456789abc",
    created_time: "2024-01-01T00:00:00.000Z",
    last_edited_time: "2024-06-15T12:00:00.000Z",
    created_by: { id: "user1", object: "user" },
    last_edited_by: { id: "user2", object: "user" },
    parent: { type: "workspace", workspace: true },
  } as any;

  const sourceId = SourceId("notion-pages:ws1");
  const providerId = ProviderId("notion:ws1");

  test("externalId is page- plus ID without dashes", () => {
    const doc = pageToDocument(mockPage, "# Hello", sourceId, providerId);
    expect(doc.externalId).toBe("page-12345678123412341234123456789abc");
  });

  test("title is extracted from the title property", () => {
    const doc = pageToDocument(mockPage, "# Hello", sourceId, providerId);
    expect(doc.title).toBe("My Page");
  });

  test("content is the provided markdown", () => {
    const doc = pageToDocument(mockPage, "# Hello World", sourceId, providerId);
    expect(doc.content).toBe("# Hello World");
  });

  test("documentType is 'document'", () => {
    const doc = pageToDocument(mockPage, "content", sourceId, providerId);
    expect(doc.metadata.documentType).toBe("document");
  });

  test("sourceUrl matches page URL", () => {
    const doc = pageToDocument(mockPage, "content", sourceId, providerId);
    expect(doc.metadata.sourceUrl).toBe(mockPage.url);
  });

  test("people includes author from created_by", () => {
    const doc = pageToDocument(mockPage, "content", sourceId, providerId);
    expect(doc.metadata.people).toBeDefined();
    expect(doc.metadata.people!.length).toBeGreaterThanOrEqual(1);
    const author = doc.metadata.people!.find((p) => p.role === "author");
    expect(author).toBeDefined();
    // No name on partial user, falls back to user ID
    expect(author!.name).toBe("user1");
  });

  test("people includes last_edited_by when different from created_by", () => {
    const doc = pageToDocument(mockPage, "content", sourceId, providerId);
    expect(doc.metadata.people!.length).toBe(2);
    const editor = doc.metadata.people!.find((p) => p.role === "mentioned");
    expect(editor).toBeDefined();
    expect(editor!.name).toBe("user2");
  });

  test("people has only author when created_by equals last_edited_by", () => {
    const samePage = {
      ...mockPage,
      last_edited_by: { id: "user1", object: "user" },
    } as any;
    const doc = pageToDocument(samePage, "content", sourceId, providerId);
    expect(doc.metadata.people!.length).toBe(1);
  });

  test("sourceCreatedAt and sourceUpdatedAt are set", () => {
    const doc = pageToDocument(mockPage, "content", sourceId, providerId);
    expect(doc.sourceCreatedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(doc.sourceUpdatedAt).toBe("2024-06-15T12:00:00.000Z");
  });

  test("contentHash is computed", () => {
    const doc = pageToDocument(mockPage, "some content", sourceId, providerId);
    expect(doc.contentHash).toBeDefined();
    expect(doc.contentHash.length).toBeGreaterThan(0);
  });

  test("sourceId and providerId are set", () => {
    const doc = pageToDocument(mockPage, "content", sourceId, providerId);
    expect(doc.sourceId).toBe(sourceId);
    expect(doc.providerId).toBe(providerId);
  });

  test("extra contains notionId and parentType", () => {
    const doc = pageToDocument(mockPage, "content", sourceId, providerId);
    expect(doc.metadata.extra).toBeDefined();
    expect(doc.metadata.extra!.notionId).toBe(mockPage.id);
    expect(doc.metadata.extra!.parentType).toBe("workspace");
  });

  test("title falls back to 'Untitled' when no title property text", () => {
    const untitledPage = {
      ...mockPage,
      properties: {
        Name: { type: "title", title: [] },
      },
    } as any;
    const doc = pageToDocument(untitledPage, "content", sourceId, providerId);
    expect(doc.title).toBe("Untitled");
  });
});

// ── databaseSummaryToDocument ─────────────────────────────────────────

describe("databaseSummaryToDocument", () => {
  const mockDatabase = {
    object: "database",
    id: "aabbccdd-1122-3344-5566-778899001122",
    title: [{ plain_text: "Task Tracker" }],
    properties: {
      Name: { type: "title", title: {} },
      Status: { type: "select", select: { options: [] } },
      Priority: { type: "number", number: { format: "number" } },
    },
    created_time: "2024-01-01T00:00:00.000Z",
    last_edited_time: "2024-06-15T12:00:00.000Z",
    url: "https://www.notion.so/task-tracker-aabbccdd112233445566778899001122",
    created_by: { id: "user1", object: "user" },
    last_edited_by: { id: "user2", object: "user" },
    parent: { type: "workspace", workspace: true },
  } as any;

  const schema = {
    tableName: "notion_aabbccdd11223344556677889900",
    displayName: "Task Tracker",
    description: "Notion database: Task Tracker",
    columns: [],
    primaryKey: ["id"],
    semanticTimeColumn: null,
    record: { titleColumns: ["id"], keyColumns: ["id"] },
  };

  const sourceId = SourceId("notion-pages:ws1");
  const providerId = ProviderId("notion:ws1");

  test("title starts with '[Db]'", () => {
    const doc = databaseSummaryToDocument(mockDatabase, schema, sourceId, providerId);
    expect(doc.title.startsWith("[Db]")).toBe(true);
    expect(doc.title).toBe("[Db] Task Tracker");
  });

  test("content contains property table", () => {
    const doc = databaseSummaryToDocument(mockDatabase, schema, sourceId, providerId);
    expect(doc.content).toContain("| Property | Type |");
    expect(doc.content).toContain("| Name | title |");
    expect(doc.content).toContain("| Status | select |");
    expect(doc.content).toContain("| Priority | number |");
  });

  test("content mentions property count", () => {
    const doc = databaseSummaryToDocument(mockDatabase, schema, sourceId, providerId);
    expect(doc.content).toContain("3 properties");
  });

  test("tags contain 'notion-database'", () => {
    const doc = databaseSummaryToDocument(mockDatabase, schema, sourceId, providerId);
    expect(doc.metadata.tags).toBeDefined();
    expect(doc.metadata.tags).toContain("notion-database");
  });

  test("extra contains duckdbTable", () => {
    const doc = databaseSummaryToDocument(mockDatabase, schema, sourceId, providerId);
    expect(doc.metadata.extra).toBeDefined();
    expect(doc.metadata.extra!.duckdbTable).toBe(schema.tableName);
  });

  test("externalId uses db- prefix with ID without dashes", () => {
    const doc = databaseSummaryToDocument(mockDatabase, schema, sourceId, providerId);
    const expected = `db-${mockDatabase.id.replace(/-/g, "")}`;
    expect(doc.externalId).toBe(expected);
  });

  test("documentType is 'document'", () => {
    const doc = databaseSummaryToDocument(mockDatabase, schema, sourceId, providerId);
    expect(doc.metadata.documentType).toBe("document");
  });

  test("content contains DuckDB table reference", () => {
    const doc = databaseSummaryToDocument(mockDatabase, schema, sourceId, providerId);
    expect(doc.content).toContain(schema.tableName);
  });

  test("people includes author from created_by and mentioned from last_edited_by when distinct", () => {
    const doc = databaseSummaryToDocument(mockDatabase, schema, sourceId, providerId);
    expect(doc.metadata.people).toBeDefined();
    expect(doc.metadata.people!.length).toBe(2);
    const author = doc.metadata.people!.find((p) => p.role === "author");
    expect(author).toBeDefined();
    expect(author!.name).toBe("user1");
    const editor = doc.metadata.people!.find((p) => p.role === "mentioned");
    expect(editor).toBeDefined();
    expect(editor!.name).toBe("user2");
  });

  test("people has only author when created_by equals last_edited_by", () => {
    const sameDb = {
      ...mockDatabase,
      last_edited_by: { id: "user1", object: "user" },
    } as any;
    const doc = databaseSummaryToDocument(sameDb, schema, sourceId, providerId);
    expect(doc.metadata.people!.length).toBe(1);
    expect(doc.metadata.people![0].role).toBe("author");
    expect(doc.metadata.people![0].name).toBe("user1");
  });

  test("extra.links contains parent page id when parent.type is 'page_id'", () => {
    const childDb = {
      ...mockDatabase,
      parent: {
        type: "page_id",
        page_id: "ffeeddcc-bbaa-9988-7766-554433221100",
      },
    } as any;
    const doc = databaseSummaryToDocument(childDb, schema, sourceId, providerId);
    expect(doc.metadata.extra).toBeDefined();
    expect(doc.metadata.extra!.links).toBeDefined();
    expect(Array.isArray(doc.metadata.extra!.links)).toBe(true);
    expect(doc.metadata.extra!.links).toEqual(["page-ffeeddccbbaa99887766554433221100"]);
  });

  test("extra.links is omitted when parent is not a page", () => {
    const doc = databaseSummaryToDocument(mockDatabase, schema, sourceId, providerId);
    expect(doc.metadata.extra!.links).toBeUndefined();
  });
});

// ── databaseRowToDocument ─────────────────────────────────────────────

describe("databaseRowToDocument", () => {
  const mockRowPage = {
    object: "page",
    id: "99887766-5544-3322-1100-aabbccddeeff",
    properties: {
      Name: { type: "title", title: [{ plain_text: "Fix login bug" }] },
      Status: { type: "select", select: { name: "In Progress" } },
    },
    url: "https://www.notion.so/fix-login-bug-9988776655443322",
    created_time: "2024-03-01T10:00:00.000Z",
    last_edited_time: "2024-03-15T14:30:00.000Z",
    created_by: { id: "user1", object: "user" },
    last_edited_by: { id: "user1", object: "user" },
    parent: { type: "database_id", database_id: "parent-db-id" },
  } as any;

  const propertySummary = [
    { name: "Status", value: "In Progress" },
    { name: "Priority", value: "High" },
  ];

  const sourceId = SourceId("notion-pages:ws1");
  const providerId = ProviderId("notion:ws1");

  test("title has 'dbTitle > rowTitle' format", () => {
    const doc = databaseRowToDocument(
      mockRowPage,
      propertySummary,
      "Task Tracker",
      sourceId,
      providerId,
    );
    expect(doc.title).toBe("Task Tracker > Fix login bug");
  });

  test("content contains property table", () => {
    const doc = databaseRowToDocument(
      mockRowPage,
      propertySummary,
      "Task Tracker",
      sourceId,
      providerId,
    );
    expect(doc.content).toContain("| Property | Value |");
    expect(doc.content).toContain("| Status | In Progress |");
    expect(doc.content).toContain("| Priority | High |");
  });

  test("externalId uses row- prefix", () => {
    const doc = databaseRowToDocument(mockRowPage, propertySummary, "Tasks", sourceId, providerId);
    const expected = `row-${mockRowPage.id.replace(/-/g, "")}`;
    expect(doc.externalId).toBe(expected);
  });

  test("documentType is 'document'", () => {
    const doc = databaseRowToDocument(mockRowPage, propertySummary, "Tasks", sourceId, providerId);
    expect(doc.metadata.documentType).toBe("document");
  });

  test("extra contains notionDatabaseId for database-parented pages", () => {
    const doc = databaseRowToDocument(mockRowPage, propertySummary, "Tasks", sourceId, providerId);
    expect(doc.metadata.extra).toBeDefined();
    expect(doc.metadata.extra!.notionDatabaseId).toBe("parent-db-id");
  });

  test("sourceCreatedAt and sourceUpdatedAt are set", () => {
    const doc = databaseRowToDocument(mockRowPage, propertySummary, "Tasks", sourceId, providerId);
    expect(doc.sourceCreatedAt).toBe("2024-03-01T10:00:00.000Z");
    expect(doc.sourceUpdatedAt).toBe("2024-03-15T14:30:00.000Z");
  });

  test("contentHash is computed", () => {
    const doc = databaseRowToDocument(mockRowPage, propertySummary, "Tasks", sourceId, providerId);
    expect(doc.contentHash).toBeDefined();
    expect(doc.contentHash.length).toBeGreaterThan(0);
  });

  test("handles empty property summary", () => {
    const doc = databaseRowToDocument(mockRowPage, [], "Tasks", sourceId, providerId);
    expect(doc.content).toContain("| Property | Value |");
    // Should just have the header, no data rows
  });
});

// ── documentEventProfile ──────────────────────────────────────────────

/**
 * The declaration is only useful if it matches what the normalizer emits: a
 * document type, person role, or vocabulary value nothing writes compiles a
 * watch condition that can never match, and the operator approves prose
 * describing a watch that is silently dead. These cases build one document of
 * every shape the two sources produce and hold the declaration against them.
 */
describe("documentEventProfile", () => {
  const sourceId = SourceId("notion-pages:ws1");
  const providerId = ProviderId("notion:ws1");

  /** A full page object with the given parent; author and editor differ. */
  function pageWithParent(parent: Record<string, unknown>): any {
    return {
      object: "page",
      id: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
      properties: {
        Name: { type: "title", title: [{ plain_text: "Release checklist" }] },
      },
      url: "https://www.notion.so/release-checklist-0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      created_time: "2026-02-01T09:00:00.000Z",
      last_edited_time: "2026-02-04T17:30:00.000Z",
      created_by: { id: "user-a1", object: "user" },
      last_edited_by: { id: "user-b2", object: "user" },
      parent,
    };
  }

  const mockDatabase = {
    object: "data_source",
    id: "3c4d5e6f-7081-92a3-b4c5-d6e7f8091a2b",
    title: [{ plain_text: "Q4 launch tracker" }],
    properties: {
      Name: { type: "title", title: {} },
      Owner: { type: "people", people: {} },
    },
    created_time: "2026-01-05T08:00:00.000Z",
    last_edited_time: "2026-02-02T11:15:00.000Z",
    url: "https://www.notion.so/launch-tracker-3c4d5e6f708192a3b4c5d6e7f8091a2b",
    created_by: { id: "user-a1", object: "user" },
    last_edited_by: { id: "user-b2", object: "user" },
    parent: { type: "workspace", workspace: true },
  } as any;

  const mockSchema = {
    tableName: "notion_3c4d5e6f708192a3b4c5d6e7f8091a2b",
    displayName: "Q4 launch tracker",
    description: "Notion database: Q4 launch tracker",
    columns: [],
    primaryKey: ["id"],
    semanticTimeColumn: null,
    record: { titleColumns: ["id"], keyColumns: ["id"] },
  };

  const mockRow = {
    ...pageWithParent({
      type: "database_id",
      database_id: "3c4d5e6f-7081-92a3-b4c5-d6e7f8091a2b",
    }),
    id: "5e6f7081-92a3-b4c5-d6e7-f8091a2b3c4d",
    properties: {
      Name: { type: "title", title: [{ plain_text: "Draft launch notes" }] },
    },
  } as any;

  // One document of every shape `NotionPagesSource` emits. Pages parented by a
  // database are excluded there, so no such fixture belongs in this set.
  const pageDocs: DocumentInput[] = [
    pageWithParent({ type: "workspace", workspace: true }),
    pageWithParent({ type: "page_id", page_id: "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809" }),
    pageWithParent({ type: "block_id", block_id: "2b3c4d5e-6f70-8192-a3b4-c5d6e7f8091a" }),
  ].map((page) => pageToDocument(page, "# Release checklist", sourceId, providerId));

  // One document of every shape `NotionDatabasesSource` emits: the schema
  // summary for a database, and one row inside it.
  const databaseDocs: DocumentInput[] = [
    databaseSummaryToDocument(mockDatabase, mockSchema, sourceId, providerId),
    databaseRowToDocument(
      mockRow,
      [{ name: "Stage", value: "in review" }],
      "Q4 launch tracker",
      sourceId,
      providerId,
    ),
  ];

  function typesOf(docs: DocumentInput[]): Set<string> {
    return new Set(docs.map((doc) => String(doc.metadata.documentType)));
  }

  function rolesOf(docs: DocumentInput[]): Set<PersonRole> {
    return new Set(docs.flatMap((doc) => (doc.metadata.people ?? []).map((p) => p.role)));
  }

  /** Resolve a profile's dotted metadata path against one document. */
  function metadataAt(doc: DocumentInput, path: string): unknown {
    return path
      .split(".")
      .reduce<unknown>(
        (value, key) =>
          value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
        doc.metadata as unknown,
      );
  }

  test("both declarations satisfy the source-boundary contract", () => {
    expect(() =>
      validateDocumentEventProfile(notionPagesDocumentProfile, "notion-pages"),
    ).not.toThrow();
    expect(() =>
      validateDocumentEventProfile(notionDatabasesDocumentProfile, "notion-databases"),
    ).not.toThrow();
  });

  test("declared document types are exactly the ones the normalizer stamps", () => {
    expect(new Set(notionPagesDocumentProfile.documentTypes)).toEqual(typesOf(pageDocs));
    expect(new Set(notionDatabasesDocumentProfile.documentTypes)).toEqual(typesOf(databaseDocs));
  });

  test("declared person roles are exactly the ones the normalizer populates", () => {
    expect(new Set(notionPagesDocumentProfile.personRoles)).toEqual(rolesOf(pageDocs));
    expect(new Set(notionDatabasesDocumentProfile.personRoles)).toEqual(rolesOf(databaseDocs));
  });

  test("every declared parent type is one a page document really carries", () => {
    const field = notionPagesDocumentProfile.metadataFields!.find(
      (f) => f.path === "extra.parentType",
    )!;
    const emitted = new Set(pageDocs.map((doc) => metadataAt(doc, field.path)));
    expect(emitted.size).toBe(pageDocs.length);
    expect(new Set(field.canonicalValues)).toEqual(emitted);
  });

  test("the declared tag vocabulary is exactly what the summary document carries", () => {
    const field = notionDatabasesDocumentProfile.metadataFields!.find((f) => f.path === "tags")!;
    const [summaryDoc, rowDoc] = databaseDocs;
    expect(new Set(field.allowedValues)).toEqual(
      new Set(metadataAt(summaryDoc, "tags") as string[]),
    );
    // The declaration says the tag is what tells a database apart from its rows.
    expect(metadataAt(rowDoc, "tags")).toBeUndefined();
  });
});

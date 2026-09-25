// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * E2E Attachment Extraction Pipeline Tests
 *
 * Validates that email documents with attachment documents are properly
 * ingested, stored, and deduplicated through the full sync pipeline.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { SourceId, ProviderId } from "@omnesis/types";
import { E2EHarness } from "./harness.js";
import { type MockSource } from "./mock-source.js";
import { getDocumentCount, getJson } from "./helpers.js";
import type { DocumentInput } from "@omnesis/types";

const PROVIDER_TYPE = "mock-mail";
const SOURCE_TYPE = "mock-attach";
const ACCOUNT_ID = "attach@test.com";
const SOURCE_ID = `${SOURCE_TYPE}:${ACCOUNT_ID}`;

// Build test documents: an email with an attachment child document
function buildEmailDoc(): DocumentInput {
  return {
    providerId: ProviderId(`${PROVIDER_TYPE}:${ACCOUNT_ID}`),
    sourceId: SourceId(SOURCE_ID),
    externalId: "email-with-attachment-1",
    title: "Important meeting notes",
    content: "Here are the meeting notes from today.\n---\n**Attachments:** notes.pdf (PDF, 150KB)",
    contentHash: computeContentHash(
      "Here are the meeting notes from today.\n---\n**Attachments:** notes.pdf (PDF, 150KB)",
    ),
    metadata: {
      sourceUrl: "https://mail.google.com/mail/u/0/#inbox/abc123",
      documentType: "email",
      people: [
        { role: "sender", name: "Alice", emails: ["alice@example.com"], phones: [] },
        { role: "recipient", name: "Bob", emails: ["bob@example.com"], phones: [] },
      ],
      extra: {
        threadId: "thread-abc123",
      },
    },
    sourceCreatedAt: "2025-06-15T10:30:00Z",
    sourceUpdatedAt: "2025-06-15T10:30:00Z",
  };
}

function buildAttachmentDoc(parentDoc: DocumentInput): DocumentInput {
  const attachmentContent =
    "Extracted text from the PDF attachment:\n\nMeeting Notes - Q2 Planning\n1. Review budget\n2. Assign tasks\n3. Set deadlines";
  return {
    providerId: parentDoc.providerId,
    sourceId: parentDoc.sourceId,
    externalId: `${parentDoc.externalId}/att/notes-pdf`,
    title: "notes.pdf",
    content: attachmentContent,
    contentHash: computeContentHash(attachmentContent),
    metadata: {
      sourceUrl: parentDoc.metadata.sourceUrl,
      documentType: "attachment",
      people: parentDoc.metadata.people ? [...parentDoc.metadata.people] : undefined,
      extra: {
        parentExternalId: parentDoc.externalId,
        originalFilename: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 153600,
        pages: 2,
        truncated: false,
      },
    },
    sourceCreatedAt: parentDoc.sourceCreatedAt,
    sourceUpdatedAt: parentDoc.sourceUpdatedAt,
  };
}

// Typed response shapes for gateway API endpoints
interface RecentDoc {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  documentType: string | null;
}

interface FullDoc {
  id: string;
  provider_id: string;
  source_id: string;
  external_id: string;
  title: string;
  content: string;
  content_hash: string;
  metadata: string; // JSON string
  source_created_at: string;
  source_updated_at: string;
}

/** Fetch recent documents for a source via GET /documents/recent/:sourceId */
async function getRecentDocs(
  gatewayUrl: string,
  apiKey: string,
  sourceId: string,
): Promise<RecentDoc[]> {
  const data = (await getJson(
    `${gatewayUrl}/documents/recent/${encodeURIComponent(sourceId)}?limit=100`,
    apiKey,
  )) as { documents: RecentDoc[] };
  return data.documents;
}

/** Fetch a full document by ID via GET /documents/:id */
async function getFullDoc(gatewayUrl: string, apiKey: string, docId: string): Promise<FullDoc> {
  return (await getJson(`${gatewayUrl}/documents/${encodeURIComponent(docId)}`, apiKey)) as FullDoc;
}

let harness: E2EHarness;
let source: MockSource;

beforeAll(async () => {
  harness = new E2EHarness();

  source = harness.registerMockSource({
    sourceType: SOURCE_TYPE,
    providerType: PROVIDER_TYPE,
    accountId: ACCOUNT_ID,
    unitName: "emails",
  });

  const emailDoc = buildEmailDoc();
  const attachmentDoc = buildAttachmentDoc(emailDoc);

  // The mock source returns both the email and attachment as pre-built DocumentInput[].
  // We use setSyncFn so we can return proper DocumentInput objects (not MockDocument).
  source.setSyncFn(async (_cursor) => {
    return {
      documents: [emailDoc, attachmentDoc],
      deletedExternalIds: [],
      cursor: { page: 0 },
      hasMore: false,
    };
  });

  await harness.start();
}, 30000);

afterAll(async () => {
  await harness.destroy();
}, 15000);

describe("E2E Attachment Extraction Pipeline", () => {
  test("sync ingests both email and attachment documents", async () => {
    await harness.triggerSyncAndWait(SOURCE_ID);

    const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID);
    expect(count).toBe(2);
  }, 30000);

  test("attachment document has correct metadata", async () => {
    const recentDocs = await getRecentDocs(harness.gatewayUrl, harness.apiKey, SOURCE_ID);

    const attachmentRecent = recentDocs.find((d) => d.externalId.includes("/att/"));
    expect(attachmentRecent).toBeDefined();
    expect(attachmentRecent!.title).toBe("notes.pdf");
    expect(attachmentRecent!.documentType).toBe("attachment");

    // Fetch full document to verify extra metadata
    const fullDoc = await getFullDoc(harness.gatewayUrl, harness.apiKey, attachmentRecent!.id);
    const metadata = JSON.parse(fullDoc.metadata);
    expect(metadata.documentType).toBe("attachment");
    expect(metadata.extra.parentExternalId).toBe("email-with-attachment-1");
    expect(metadata.extra.mimeType).toBe("application/pdf");
    expect(metadata.extra.sizeBytes).toBe(153600);
    expect(metadata.extra.pages).toBe(2);
    expect(metadata.extra.truncated).toBe(false);
    expect(metadata.extra.originalFilename).toBe("notes.pdf");
  }, 30000);

  test("email document is also present with correct type", async () => {
    const recentDocs = await getRecentDocs(harness.gatewayUrl, harness.apiKey, SOURCE_ID);

    const emailRecent = recentDocs.find((d) => d.externalId === "email-with-attachment-1");
    expect(emailRecent).toBeDefined();
    expect(emailRecent!.title).toBe("Important meeting notes");
    expect(emailRecent!.documentType).toBe("email");

    // Fetch full document to verify people metadata
    const fullDoc = await getFullDoc(harness.gatewayUrl, harness.apiKey, emailRecent!.id);
    const metadata = JSON.parse(fullDoc.metadata);
    expect(metadata.people).toBeInstanceOf(Array);
    expect(metadata.people.length).toBe(2);
  }, 30000);

  test("attachment inherits people metadata from parent email", async () => {
    const recentDocs = await getRecentDocs(harness.gatewayUrl, harness.apiKey, SOURCE_ID);

    const attachmentRecent = recentDocs.find((d) => d.externalId.includes("/att/"));
    expect(attachmentRecent).toBeDefined();

    const fullDoc = await getFullDoc(harness.gatewayUrl, harness.apiKey, attachmentRecent!.id);
    const metadata = JSON.parse(fullDoc.metadata);
    expect(metadata.people).toBeInstanceOf(Array);
    expect(metadata.people.length).toBe(2);

    const sender = metadata.people.find((p: { role: string }) => p.role === "sender");
    expect(sender).toBeDefined();
    expect(sender.name).toBe("Alice");
    expect(sender.emails).toContain("alice@example.com");
  }, 30000);

  test("re-syncing does not create duplicate documents (idempotence)", async () => {
    // First sync already happened above. Trigger a second sync.
    await harness.triggerSyncAndWait(SOURCE_ID);

    const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID);
    // Should still be exactly 2, not 4
    expect(count).toBe(2);

    // Trigger a third sync for good measure
    await harness.triggerSyncAndWait(SOURCE_ID);

    const countAfterThird = await getDocumentCount(harness.gatewayUrl, harness.apiKey, SOURCE_ID);
    expect(countAfterThird).toBe(2);
  }, 30000);

  test("attachment externalId follows parent/att/id convention", async () => {
    const recentDocs = await getRecentDocs(harness.gatewayUrl, harness.apiKey, SOURCE_ID);

    const attachmentDoc = recentDocs.find((d) => d.externalId.includes("/att/"));
    expect(attachmentDoc).toBeDefined();
    expect(attachmentDoc!.externalId).toBe("email-with-attachment-1/att/notes-pdf");
  }, 30000);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  resolveAttachmentConfig,
  shouldExtractAttachment,
  buildAttachmentDocument,
  deriveAttachmentStableId,
  formatAttachmentMarkers,
} from "@omnesis/core";
import { SourceId, ProviderId } from "@omnesis/types";
import type { AttachmentInfo } from "@omnesis/core";
import type { DocumentInput } from "@omnesis/types";

describe("resolveAttachmentConfig", () => {
  test("returns disabled config when no source config", () => {
    const config = resolveAttachmentConfig();
    expect(config.enabled).toBe(false);
    expect(config.maxSizeBytes).toBe(26_214_400);
    expect(config.allowedTypes).toContain("application/pdf");
    expect(config.allowedTypes.length).toBeGreaterThan(1);
    expect(config.maxTextLength).toBe(512_000);
  });

  test("returns enabled config with defaults", () => {
    const config = resolveAttachmentConfig({ enabled: true, extractAttachments: true });
    expect(config.enabled).toBe(true);
    expect(config.maxSizeBytes).toBe(26_214_400);
  });

  test("respects custom values", () => {
    const config = resolveAttachmentConfig({
      enabled: true,
      extractAttachments: true,
      attachmentMaxSizeBytes: 1000,
      attachmentTypes: ["application/pdf", "text/plain"],
      attachmentMaxTextLength: 100,
    });
    expect(config.maxSizeBytes).toBe(1000);
    expect(config.allowedTypes).toEqual(["application/pdf", "text/plain"]);
    expect(config.maxTextLength).toBe(100);
  });
});

describe("shouldExtractAttachment", () => {
  const config = resolveAttachmentConfig({ enabled: true, extractAttachments: true });

  test("allows PDF within size limit", () => {
    const result = shouldExtractAttachment("application/pdf", 1000, config);
    expect(result.extract).toBe(true);
  });

  test("rejects non-allowed MIME type", () => {
    const result = shouldExtractAttachment("application/zip", 1000, config);
    expect(result.extract).toBe(false);
    expect(result.reason).toBe("type-excluded");
  });

  test("rejects oversized attachment", () => {
    const result = shouldExtractAttachment("application/pdf", 30_000_000, config);
    expect(result.extract).toBe(false);
    expect(result.reason).toBe("too-large");
  });

  test("rejects everything when allowedTypes is empty", () => {
    const emptyConfig = resolveAttachmentConfig({
      enabled: true,
      extractAttachments: true,
      attachmentTypes: [],
    });
    expect(emptyConfig.allowedTypes).toEqual([]);
    const pdf = shouldExtractAttachment("application/pdf", 1000, emptyConfig);
    expect(pdf.extract).toBe(false);
    expect(pdf.reason).toBe("type-excluded");
    const text = shouldExtractAttachment("text/plain", 500, emptyConfig);
    expect(text.extract).toBe(false);
    expect(text.reason).toBe("type-excluded");
  });

  test("rejects all attachments when maxSizeBytes is zero", () => {
    const zeroSizeConfig = resolveAttachmentConfig({
      enabled: true,
      extractAttachments: true,
      attachmentMaxSizeBytes: 0,
    });
    expect(zeroSizeConfig.maxSizeBytes).toBe(0);
    const result = shouldExtractAttachment("application/pdf", 1, zeroSizeConfig);
    expect(result.extract).toBe(false);
    expect(result.reason).toBe("too-large");
  });
});

describe("buildAttachmentDocument", () => {
  const parentDoc: DocumentInput = {
    providerId: ProviderId("google:test@example.com"),
    sourceId: SourceId("gmail:test@example.com"),
    externalId: "msg123",
    title: "Test Email",
    content: "email body",
    contentHash: "abc",
    metadata: {
      sourceUrl: "https://mail.google.com/mail/#inbox/msg123",
      documentType: "email",
      people: [{ role: "sender", name: "Alice", emails: ["alice@example.com"] }],
    },
    sourceCreatedAt: "2026-01-01T00:00:00.000Z",
    sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
  };

  test("builds correct attachment document", () => {
    const doc = buildAttachmentDocument(
      parentDoc,
      "report.pdf",
      { text: "PDF content here", pages: 3, truncated: false },
      { mimeType: "application/pdf", sizeBytes: 12345 },
    );

    expect(doc.sourceId).toBe(parentDoc.sourceId);
    expect(doc.providerId).toBe(parentDoc.providerId);
    // externalId follows <parent>/att/<stable-hash>; assert via the helper
    // rather than hard-coding the hash so the test doesn't drift if we ever
    // swap the hash function.
    const stableId = deriveAttachmentStableId("report.pdf", 12345, "application/pdf");
    expect(doc.externalId).toBe(`msg123/att/${stableId}`);
    expect(doc.title).toBe("report.pdf");
    expect(doc.content).toBe("PDF content here");
    expect(doc.metadata.documentType).toBe("attachment");
    expect(doc.metadata.sourceUrl).toBe(parentDoc.metadata.sourceUrl);
    expect(doc.metadata.extra?.parentExternalId).toBe("msg123");
    expect(doc.metadata.extra?.originalFilename).toBe("report.pdf");
    expect(doc.metadata.extra?.mimeType).toBe("application/pdf");
    expect(doc.metadata.extra?.sizeBytes).toBe(12345);
    expect(doc.metadata.extra?.pages).toBe(3);
    expect(doc.metadata.people).toHaveLength(1);
    expect(doc.sourceCreatedAt).toBe(parentDoc.sourceCreatedAt);
  });

  test("builds attachment document with undefined people when parent has no people", () => {
    const parentNoPeople: DocumentInput = {
      providerId: ProviderId("google:test@example.com"),
      sourceId: SourceId("gmail:test@example.com"),
      externalId: "msg789",
      title: "No People Email",
      content: "body",
      contentHash: "def",
      metadata: {
        sourceUrl: "https://mail.google.com/mail/#inbox/msg789",
        documentType: "email",
      },
      sourceCreatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    };

    const doc = buildAttachmentDocument(
      parentNoPeople,
      "notes.pdf",
      { text: "Some text", pages: 1, truncated: false },
      { mimeType: "application/pdf", sizeBytes: 5000 },
    );

    expect(doc.metadata.people).toBeUndefined();
    const stableId = deriveAttachmentStableId("notes.pdf", 5000, "application/pdf");
    expect(doc.externalId).toBe(`msg789/att/${stableId}`);
  });

  test("inherits sender / recipient from parent but drops mentioned", () => {
    // The parent email mentions a bunch of school addresses in its body
    // (forwarded mailing-list email pattern). Those mentions belong to
    // the email body, not to the attached PDF — the attachment shouldn't
    // inherit them.
    const parent: DocumentInput = {
      providerId: ProviderId("microsoft:jamesbond@outlook.com"),
      sourceId: SourceId("outlook-email:jamesbond@outlook.com"),
      externalId: "msg-fw-1",
      title: "FW: Q4 Budget Review",
      content: "body with lopez_c@example.org ...",
      contentHash: "h",
      metadata: {
        documentType: "email",
        people: [
          { role: "sender", emails: ["sender@example.com"] },
          { role: "recipient", emails: ["recipient@example.com"] },
          { role: "mentioned", emails: ["lopez_c@example.org"] },
          { role: "mentioned", emails: ["nguyen_m@example.org"] },
          { role: "mentioned", emails: ["okafor@example.org"] },
        ],
      },
      sourceCreatedAt: "2009-12-05T09:40:09Z",
      sourceUpdatedAt: "2009-12-05T09:40:09Z",
    };

    const doc = buildAttachmentDocument(
      parent,
      "Contract draft.docx",
      { text: "This is the contract body.", truncated: false },
      {
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 71384,
      },
    );

    const roles = (doc.metadata.people ?? []).map((p) => p.role);
    expect(roles).toContain("sender");
    expect(roles).toContain("recipient");
    expect(roles).not.toContain("mentioned");

    const allEmails = (doc.metadata.people ?? []).flatMap((p) => p.emails ?? []);
    expect(allEmails).toContain("sender@example.com");
    expect(allEmails).toContain("recipient@example.com");
    expect(allEmails).not.toContain("lopez_c@example.org");
    expect(allEmails).not.toContain("okafor@example.org");
  });

  test("re-extracts mentions from the attachment's own content", () => {
    // PDF that itself contains an email — should appear as a mention on
    // the attachment doc.
    const parent: DocumentInput = {
      providerId: ProviderId("google:test@example.com"),
      sourceId: SourceId("gmail:test@example.com"),
      externalId: "msg-x",
      title: "Heads up",
      content: "see attached",
      contentHash: "h",
      metadata: {
        documentType: "email",
        people: [{ role: "sender", emails: ["alice@example.com"] }],
      },
      sourceCreatedAt: "2026-01-01T00:00:00Z",
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    };

    const doc = buildAttachmentDocument(
      parent,
      "contract.pdf",
      {
        text: "Please contact legal@employer.com for questions about this contract.",
        truncated: false,
      },
      { mimeType: "application/pdf", sizeBytes: 5000 },
    );

    const allEmails = (doc.metadata.people ?? []).flatMap((p) => p.emails ?? []);
    expect(allEmails).toContain("alice@example.com"); // inherited (sender)
    expect(allEmails).toContain("legal@employer.com"); // newly mined
    const legal = doc.metadata.people!.find((p) => p.emails?.[0] === "legal@employer.com");
    expect(legal?.role).toBe("mentioned");
  });

  test("does NOT add an inherited person as a mention when their email also appears in the attachment", () => {
    // Sender's email appears in the attachment's signature block.
    // Don't list them twice (once as sender, once as mentioned).
    const parent: DocumentInput = {
      providerId: ProviderId("google:test@example.com"),
      sourceId: SourceId("gmail:test@example.com"),
      externalId: "msg-y",
      title: "Status",
      content: "report attached",
      contentHash: "h",
      metadata: {
        documentType: "email",
        people: [{ role: "sender", emails: ["alice@example.com"] }],
      },
      sourceCreatedAt: "2026-01-01T00:00:00Z",
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    };

    const doc = buildAttachmentDocument(
      parent,
      "status.pdf",
      { text: "Q3 status report.\n\n--\nAlice <alice@example.com>", truncated: false },
      { mimeType: "application/pdf", sizeBytes: 5000 },
    );

    const aliceEntries = (doc.metadata.people ?? []).filter((p) =>
      p.emails?.includes("alice@example.com"),
    );
    expect(aliceEntries).toHaveLength(1);
    expect(aliceEntries[0].role).toBe("sender");
  });
});

describe("formatAttachmentMarkers", () => {
  test("returns empty string for no attachments", () => {
    expect(formatAttachmentMarkers([])).toBe("");
  });

  test("formats single attachment", () => {
    const attachments: AttachmentInfo[] = [
      { filename: "report.pdf", mimeType: "application/pdf", size: 12345, extracted: true },
    ];
    const result = formatAttachmentMarkers(attachments);
    expect(result).toContain("report.pdf");
    expect(result).toContain("PDF");
    expect(result).toContain("12KB");
    expect(result).toContain("**Attachments:**");
  });

  test("formats multiple attachments", () => {
    const attachments: AttachmentInfo[] = [
      { filename: "report.pdf", mimeType: "application/pdf", size: 12345, extracted: true },
      {
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        size: 54321,
        extracted: false,
        reason: "type-excluded",
      },
    ];
    const result = formatAttachmentMarkers(attachments);
    expect(result).toContain("report.pdf");
    expect(result).toContain("photo.jpg");
    expect(result).toContain("JPEG");
  });

  test("formats large file sizes in MB", () => {
    const attachments: AttachmentInfo[] = [
      {
        filename: "big.pdf",
        mimeType: "application/pdf",
        size: 5 * 1024 * 1024 + 200 * 1024,
        extracted: true,
      },
    ];
    const result = formatAttachmentMarkers(attachments);
    expect(result).toContain("big.pdf");
    expect(result).toContain("5.2MB");
  });
});

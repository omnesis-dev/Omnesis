// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { vi } from "vitest";
import { OutlookEmailSource } from "../outlook-email.js";

/**
 * Create a mock GraphClient for testing.
 */
export function createMockGraph(): any {
  return {
    get: vi.fn(() => Promise.resolve({ value: [] })),
  };
}

/**
 * Builder for Graph API message objects with sensible defaults.
 */
export function makeOutlookMessage(
  id: string,
  overrides: {
    subject?: string;
    from?: { name?: string; address: string };
    toRecipients?: Array<{ name?: string; address: string }>;
    ccRecipients?: Array<{ name?: string; address: string }>;
    bccRecipients?: Array<{ name?: string; address: string }>;
    body?: { contentType: "text" | "html"; content: string };
    receivedDateTime?: string;
    sentDateTime?: string;
    lastModifiedDateTime?: string;
    conversationId?: string;
    internetMessageId?: string;
    importance?: "low" | "normal" | "high";
    isRead?: boolean;
    isDraft?: boolean;
    hasAttachments?: boolean;
    webLink?: string;
    parentFolderId?: string;
    categories?: string[];
    flag?: { flagStatus: string };
    removed?: boolean;
  } = {},
): Record<string, any> {
  return {
    id,
    subject: overrides.subject ?? "Test Subject",
    bodyPreview: "Preview text",
    body: overrides.body ?? {
      contentType: "text",
      content: "Hello world",
    },
    from: {
      emailAddress: overrides.from ?? {
        name: "Sender",
        address: "sender@example.com",
      },
    },
    toRecipients: (overrides.toRecipients ?? [{ address: "recipient@example.com" }]).map((r) => ({
      emailAddress: r,
    })),
    ccRecipients: (overrides.ccRecipients ?? []).map((r) => ({
      emailAddress: r,
    })),
    bccRecipients: (overrides.bccRecipients ?? []).map((r) => ({
      emailAddress: r,
    })),
    receivedDateTime: overrides.receivedDateTime ?? "2024-01-01T00:00:00Z",
    sentDateTime: overrides.sentDateTime ?? "2024-01-01T00:00:00Z",
    lastModifiedDateTime: overrides.lastModifiedDateTime ?? "2024-01-01T00:00:00Z",
    conversationId: overrides.conversationId ?? `conv-${id}`,
    internetMessageId: overrides.internetMessageId ?? `<${id}@example.com>`,
    importance: overrides.importance ?? "normal",
    isRead: overrides.isRead ?? false,
    isDraft: overrides.isDraft ?? false,
    hasAttachments: overrides.hasAttachments ?? false,
    webLink: overrides.webLink ?? `https://outlook.live.com/mail/0/id/${id}`,
    parentFolderId: overrides.parentFolderId ?? "inbox-folder-id",
    categories: overrides.categories ?? [],
    flag: overrides.flag ?? { flagStatus: "notFlagged" },
    ...(overrides.removed ? { "@removed": { reason: "deleted" } } : {}),
  };
}

/**
 * Builder for Graph API mail folder objects.
 */
export function makeMailFolder(
  id: string,
  overrides: {
    displayName?: string;
    wellKnownName?: string;
    totalItemCount?: number;
    childFolderCount?: number;
  } = {},
): Record<string, any> {
  return {
    id,
    displayName: overrides.displayName ?? `Folder ${id}`,
    wellKnownName: overrides.wellKnownName,
    totalItemCount: overrides.totalItemCount ?? 10,
    childFolderCount: overrides.childFolderCount ?? 0,
  };
}

/**
 * Create an OutlookEmailSource with an injected mock GraphClient.
 */
export function createOutlookEmailSource(
  mockGraph: any,
  opts?: {
    accountId?: string;
    dataCutoff?: string;
    attachmentConfig?: import("@omnesis/core").AttachmentExtractionConfig;
    extractAttachment?: import("@omnesis/core").AttachmentExtractFn;
  },
): OutlookEmailSource {
  const accountId = opts?.accountId ?? "test@outlook.com";
  const sourceId = `outlook-email:${accountId}`;
  const providerId = `microsoft:${accountId}`;
  const source = new OutlookEmailSource(
    async () => "mock-token",
    sourceId,
    providerId,
    opts?.dataCutoff,
    {
      attachmentConfig: opts?.attachmentConfig,
      extractAttachment: opts?.extractAttachment,
    },
  );
  // Inject mock graph client
  Object.defineProperty(source, "graph", {
    value: mockGraph,
    writable: true,
    configurable: true,
  });
  return source;
}

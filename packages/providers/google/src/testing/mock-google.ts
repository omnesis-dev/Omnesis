// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { vi } from "vitest";
import { GmailSource } from "../gmail.js";
import { GoogleCalendarSource } from "../calendar.js";
import { GoogleDriveSource } from "../drive.js";
import type { gmail_v1, calendar_v3, drive_v3 } from "googleapis";

// ── Gmail ──────────────────────────────────────────────────────────

export function createMockGmail(): any {
  return {
    users: {
      getProfile: vi.fn(() =>
        Promise.resolve({
          data: {
            emailAddress: "test@example.com",
            messagesTotal: 100,
            historyId: "history-1",
          },
        }),
      ),
      messages: {
        list: vi.fn(() =>
          Promise.resolve({
            data: { messages: [], nextPageToken: undefined },
          }),
        ),
        get: vi.fn(() => Promise.resolve({ data: {} })),
        attachments: {
          get: vi.fn(() => Promise.resolve({ data: { data: "" } })),
        },
      },
      history: {
        list: vi.fn(() =>
          Promise.resolve({
            data: { history: [], historyId: "history-2" },
          }),
        ),
      },
      labels: {
        list: vi.fn(() =>
          Promise.resolve({
            data: {
              labels: [
                { id: "INBOX", name: "INBOX", type: "system" },
                { id: "STARRED", name: "STARRED", type: "system" },
                { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
                { id: "TRASH", name: "TRASH", type: "system" },
                { id: "SPAM", name: "SPAM", type: "system" },
                { id: "SENT", name: "SENT", type: "system" },
                { id: "DRAFT", name: "DRAFT", type: "system" },
                { id: "UNREAD", name: "UNREAD", type: "system" },
                { id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL", type: "system" },
                { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
                { id: "CATEGORY_SOCIAL", name: "CATEGORY_SOCIAL", type: "system" },
                { id: "CATEGORY_FORUMS", name: "CATEGORY_FORUMS", type: "system" },
                { id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system" },
              ],
            },
          }),
        ),
      },
    },
  };
}

export function makeGmailMessage(
  id: string,
  overrides: {
    internalDate?: string;
    subject?: string;
    from?: string;
    to?: string;
    cc?: string;
    date?: string;
    labelIds?: string[];
    extraHeaders?: Array<{ name: string; value: string }>;
    payload?: any;
  } = {},
): Record<string, any> {
  const internalDate = overrides.internalDate ?? "1704067200000"; // 2024-01-01
  const subject = overrides.subject ?? "Test Subject";
  const from = overrides.from ?? "sender@example.com";
  const to = overrides.to ?? "recipient@example.com";

  return {
    id,
    threadId: `thread-${id}`,
    internalDate,
    labelIds: overrides.labelIds ?? ["INBOX"],
    payload: overrides.payload ?? {
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: from },
        { name: "To", value: to },
        ...(overrides.cc ? [{ name: "Cc", value: overrides.cc }] : []),
        {
          name: "Date",
          value: overrides.date ?? new Date(parseInt(internalDate, 10)).toUTCString(),
        },
        ...(overrides.extraHeaders ?? []),
      ],
      mimeType: "text/plain",
      body: {
        data: Buffer.from("Hello world").toString("base64url"),
      },
    },
  };
}

export function createGmailSource(
  mockGmail: any,
  opts?: {
    accountId?: string;
    dataCutoff?: string;
    attachmentConfig?: import("@omnesis/core").AttachmentExtractionConfig;
    extractAttachment?: import("@omnesis/core").AttachmentExtractFn;
  },
): GmailSource {
  const accountId = opts?.accountId ?? "test@example.com";
  const source = new GmailSource({} as any, accountId, opts?.dataCutoff, {
    attachmentConfig: opts?.attachmentConfig,
    extractAttachment: opts?.extractAttachment,
  });
  Object.defineProperty(source, "gmail", {
    value: mockGmail,
    writable: true,
    configurable: true,
  });
  return source;
}

// ── Calendar ───────────────────────────────────────────────────────

export function createMockCalendar(): any {
  return {
    calendarList: {
      list: vi.fn(() =>
        Promise.resolve({
          data: { items: [] },
        }),
      ),
    },
    events: {
      list: vi.fn(() =>
        Promise.resolve({
          data: { items: [], nextPageToken: undefined, nextSyncToken: undefined },
        }),
      ),
    },
  };
}

export function makeCalendarEvent(
  id: string,
  overrides: {
    summary?: string;
    status?: string;
    start?: calendar_v3.Schema$EventDateTime;
    end?: calendar_v3.Schema$EventDateTime;
    location?: string;
    description?: string;
    attendees?: calendar_v3.Schema$EventAttendee[];
    organizer?: { displayName?: string; email?: string };
    htmlLink?: string;
    created?: string;
    updated?: string;
    conferenceData?: any;
    iCalUID?: string;
  } = {},
): calendar_v3.Schema$Event {
  return {
    id,
    summary: overrides.summary ?? "Test Event",
    // Google returns one on every event; a fixture without it describes a
    // response the API does not produce.
    iCalUID: overrides.iCalUID ?? `${id}@google.com`,
    status: overrides.status ?? "confirmed",
    start: overrides.start ?? { dateTime: "2025-01-15T10:00:00Z" },
    end: overrides.end ?? { dateTime: "2025-01-15T11:00:00Z" },
    location: overrides.location,
    description: overrides.description,
    attendees: overrides.attendees,
    organizer: overrides.organizer ?? {
      displayName: "Organizer",
      email: "org@example.com",
    },
    htmlLink: overrides.htmlLink ?? `https://calendar.google.com/event?eid=${id}`,
    created: overrides.created ?? "2025-01-01T00:00:00Z",
    updated: overrides.updated ?? "2025-01-01T00:00:00Z",
    conferenceData: overrides.conferenceData,
  };
}

export function makeCalendarListEntry(
  id: string,
  overrides: { summary?: string } = {},
): calendar_v3.Schema$CalendarListEntry {
  return {
    id,
    summary: overrides.summary ?? `Calendar ${id}`,
  };
}

export function createCalendarSource(
  mockCalendar: any,
  opts?: { accountId?: string; dataCutoff?: string },
): GoogleCalendarSource {
  const accountId = opts?.accountId ?? "test@example.com";
  const source = new GoogleCalendarSource({} as any, accountId, opts?.dataCutoff);
  Object.defineProperty(source, "calendar", {
    value: mockCalendar,
    writable: true,
    configurable: true,
  });
  return source;
}

// ── Drive ──────────────────────────────────────────────────────────

export function createMockDrive(): any {
  return {
    files: {
      list: vi.fn(() => Promise.resolve({ data: { files: [], nextPageToken: undefined } })),
      export: vi.fn(() => Promise.resolve({ data: "" })),
      get: vi.fn(() => Promise.resolve({ data: "" })),
    },
    changes: {
      getStartPageToken: vi.fn(() =>
        Promise.resolve({ data: { startPageToken: "start-token-1" } }),
      ),
      list: vi.fn(() =>
        Promise.resolve({
          data: {
            changes: [],
            newStartPageToken: "start-token-2",
            nextPageToken: undefined,
          },
        }),
      ),
    },
  };
}

export function makeDriveFile(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: "file-1",
    name: "Test Doc",
    mimeType: "application/vnd.google-apps.document",
    createdTime: "2025-01-01T00:00:00Z",
    modifiedTime: "2025-01-02T00:00:00Z",
    webViewLink: "https://docs.google.com/document/d/file-1",
    owners: [{ displayName: "Alice", emailAddress: "alice@example.com" }],
    shared: false,
    trashed: false,
    ...overrides,
  };
}

export function makeDriveChange(
  fileId: string,
  overrides: { removed?: boolean; file?: Record<string, any> } = {},
): Record<string, any> {
  return {
    fileId,
    removed: overrides.removed ?? false,
    file: overrides.file ?? makeDriveFile({ id: fileId }),
  };
}

/**
 * Helper to set up files.list mock that returns `syncFiles` for every call.
 * The legacy denominator-estimation pre-call (paginated `files.list` with
 * minimal fields) was removed — Drive bootstrap now reports rolling progress
 * without a precomputed total, so the first call is the real bootstrap page.
 *
 * `estimateCount` is accepted for backwards-source-compat with existing
 * tests but is ignored.
 */
export function mockDriveFilesList(
  drive: any,
  syncFiles: Record<string, any>[],
  opts?: { nextPageToken?: string; estimateCount?: number },
): void {
  void opts?.estimateCount;
  drive.files.list = vi.fn(() =>
    Promise.resolve({
      data: {
        files: syncFiles,
        nextPageToken: opts?.nextPageToken,
      },
    }),
  );
}

export function createDriveSource(
  mockDrive: any,
  opts?: {
    accountId?: string;
    dataCutoff?: string;
    attachmentConfig?: import("@omnesis/core").AttachmentExtractionConfig;
    extractAttachment?: import("@omnesis/core").AttachmentExtractFn;
  },
): GoogleDriveSource {
  const accountId = opts?.accountId ?? "test@example.com";
  const source = new GoogleDriveSource({} as any, accountId, opts?.dataCutoff, {
    attachmentConfig: opts?.attachmentConfig,
    extractAttachment: opts?.extractAttachment,
  });
  Object.defineProperty(source, "drive", {
    value: mockDrive,
    writable: true,
    configurable: true,
  });
  return source;
}

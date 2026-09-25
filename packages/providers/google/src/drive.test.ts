// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, vi } from "vitest";
import { resolveAttachmentConfig } from "@omnesis/core";
import { SourceId, ProviderId, SyncError } from "@omnesis/types";
import { GoogleDriveSource } from "./drive.js";
import {
  createMockDrive,
  createDriveSource,
  makeDriveFile,
  mockDriveFilesList,
} from "./testing/mock-google.js";

describe("GoogleDriveSource", () => {
  let source: GoogleDriveSource;
  let drive: ReturnType<typeof createMockDrive>;

  beforeEach(() => {
    drive = createMockDrive();
    source = createDriveSource(drive);
  });

  test("has correct id and providerId", () => {
    expect(source.id).toBe(SourceId("google-drive:test@example.com"));
    expect(source.providerId).toBe(ProviderId("google:test@example.com"));
  });

  test("has correct id without accountId", () => {
    const p = new GoogleDriveSource({} as any);
    expect(p.id).toBe(SourceId("google-drive"));
    expect(p.providerId).toBe(ProviderId("google"));
  });

  describe("bootstrap sync", () => {
    test("fetches files and captures startPageToken", async () => {
      mockDriveFilesList(drive, [makeDriveFile()]);
      drive.files.export = vi.fn(() => Promise.resolve({ data: "Hello world content" }));

      const result = await source.sync(null);

      expect(drive.changes.getStartPageToken).toHaveBeenCalled();
      expect(drive.files.list).toHaveBeenCalled();
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("file-1");
      expect(result.documents[0].title).toBe("Test Doc");
      expect(result.documents[0].content).toContain("Hello world content");
      expect(result.documents[0].content).toContain("Google Doc");
      expect(result.hasMore).toBe(false);

      const cursor = result.cursor as any;
      expect(cursor.phase).toBe("incremental");
      expect(cursor.startPageToken).toBe("start-token-1");
    });

    test("paginates with hasMore and pageToken", async () => {
      mockDriveFilesList(drive, [makeDriveFile()], {
        nextPageToken: "page-2",
      });
      drive.files.export = vi.fn(() => Promise.resolve({ data: "content" }));

      const result = await source.sync(null);

      expect(result.hasMore).toBe(true);
      const cursor = result.cursor as any;
      expect(cursor.phase).toBe("bootstrap");
      expect(cursor.pageToken).toBe("page-2");
      expect(cursor.startPageToken).toBe("start-token-1");
    });

    test("resumes from pageToken without re-fetching startPageToken", async () => {
      drive.files.list = vi.fn(() => Promise.resolve({ data: { files: [] } }));

      const cursor = {
        phase: "bootstrap",
        pageToken: "page-2",
        startPageToken: "existing-token",
      };

      await source.sync(cursor);

      expect(drive.changes.getStartPageToken).not.toHaveBeenCalled();
      const listCall = drive.files.list.mock.calls[0][0];
      expect(listCall.pageToken).toBe("page-2");
    });

    test("transitions to incremental on last page", async () => {
      drive.files.list = vi.fn(() => Promise.resolve({ data: { files: [] } }));

      const cursor = {
        phase: "bootstrap",
        pageToken: "last-page",
        startPageToken: "token-1",
      };

      const result = await source.sync(cursor);

      expect(result.hasMore).toBe(false);
      const newCursor = result.cursor as any;
      expect(newCursor.phase).toBe("incremental");
      expect(newCursor.startPageToken).toBe("token-1");
      expect(newCursor.pageToken).toBeUndefined();
    });

    test("reports bootstrap progress without a precomputed total", async () => {
      mockDriveFilesList(drive, [makeDriveFile(), makeDriveFile({ id: "file-2" })]);
      drive.files.export = vi.fn(() => Promise.resolve({ data: "content" }));

      const result = await source.sync(null);

      expect(result.progress?.phase).toBe("bootstrap");
      expect(result.progress?.processed).toBe(2);
      // The legacy estimate paginated `files.list` 100+ times before the
      // first real bootstrap page; we now report rolling progress with no
      // total and let the UI render an indeterminate bar.
      expect(result.progress?.total).toBeUndefined();
    });
  });

  describe("incremental sync", () => {
    test("fetches changes since last sync", async () => {
      const file = makeDriveFile({ id: "changed-file" });
      drive.changes.list = vi.fn(() =>
        Promise.resolve({
          data: {
            changes: [{ fileId: "changed-file", file }],
            newStartPageToken: "token-3",
          },
        }),
      );
      drive.files.export = vi.fn(() => Promise.resolve({ data: "updated content" }));

      const cursor = { phase: "incremental", startPageToken: "token-2" };
      const result = await source.sync(cursor);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("changed-file");
      expect(result.hasMore).toBe(false);

      const newCursor = result.cursor as any;
      expect(newCursor.startPageToken).toBe("token-3");
    });

    test("reports deleted files", async () => {
      drive.changes.list = vi.fn(() =>
        Promise.resolve({
          data: {
            changes: [{ fileId: "deleted-file", removed: true }],
            newStartPageToken: "token-3",
          },
        }),
      );

      const cursor = { phase: "incremental", startPageToken: "token-2" };
      const result = await source.sync(cursor);

      expect(result.documents).toHaveLength(0);
      expect(result.deletedExternalIds).toContain("deleted-file");
    });

    test("handles trashed files as deletions", async () => {
      drive.changes.list = vi.fn(() =>
        Promise.resolve({
          data: {
            changes: [
              {
                fileId: "trashed-file",
                file: makeDriveFile({ id: "trashed-file", trashed: true }),
              },
            ],
            newStartPageToken: "token-3",
          },
        }),
      );

      const cursor = { phase: "incremental", startPageToken: "token-2" };
      const result = await source.sync(cursor);

      expect(result.documents).toHaveLength(0);
      expect(result.deletedExternalIds).toContain("trashed-file");
    });

    test("falls back to bootstrap on expired page token (404)", async () => {
      const error: any = new Error("Not Found");
      error.code = 404;
      drive.changes.list = vi.fn(() => Promise.reject(error));

      drive.files.list = vi.fn(() => Promise.resolve({ data: { files: [] } }));

      const cursor = { phase: "incremental", startPageToken: "expired" };
      const result = await source.sync(cursor);

      expect(drive.files.list).toHaveBeenCalled();
      expect(result.hasMore).toBe(false);
    });

    test("falls back to bootstrap on 403 error", async () => {
      const error: any = new Error("Forbidden");
      error.code = 403;
      drive.changes.list = vi.fn(() => Promise.reject(error));

      drive.files.list = vi.fn(() => Promise.resolve({ data: { files: [] } }));

      const cursor = { phase: "incremental", startPageToken: "expired" };
      const result = await source.sync(cursor);

      expect(drive.files.list).toHaveBeenCalled();
      expect(result.hasMore).toBe(false);
    });

    test("updates startPageToken after sync", async () => {
      drive.changes.list = vi.fn(() =>
        Promise.resolve({
          data: {
            changes: [],
            newStartPageToken: "new-token",
          },
        }),
      );

      const cursor = { phase: "incremental", startPageToken: "old-token" };
      const result = await source.sync(cursor);

      const newCursor = result.cursor as any;
      expect(newCursor.startPageToken).toBe("new-token");
    });

    test("paginates via nextPageToken in changes.list", async () => {
      const file1 = makeDriveFile({ id: "file-1" });
      const file2 = makeDriveFile({ id: "file-2" });

      let callCount = 0;
      drive.changes.list = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            data: {
              changes: [{ fileId: "file-1", file: file1 }],
              nextPageToken: "changes-page-2",
            },
          });
        }
        // This won't actually be called since the source returns hasMore=true
        // after the first page — the sync engine calls again. But the cursor
        // should use nextPageToken as startPageToken.
        return Promise.resolve({
          data: {
            changes: [{ fileId: "file-2", file: file2 }],
            newStartPageToken: "final-token",
          },
        });
      });
      drive.files.export = vi.fn(() => Promise.resolve({ data: "content" }));

      const cursor = { phase: "incremental", startPageToken: "token-1" };
      const result = await source.sync(cursor);

      // First page should return the file
      expect(result.documents).toHaveLength(1);
      // Cursor should store the nextPageToken for next call
      const newCursor = result.cursor as any;
      expect(newCursor.startPageToken).toBe("changes-page-2");
      expect(result.hasMore).toBe(true);
    });

    test("newStartPageToken saved to cursor after full scan", async () => {
      drive.changes.list = vi.fn(() =>
        Promise.resolve({
          data: {
            changes: [],
            newStartPageToken: "fresh-start-token",
          },
        }),
      );

      const cursor = { phase: "incremental", startPageToken: "old-token" };
      const result = await source.sync(cursor);

      const newCursor = result.cursor as any;
      expect(newCursor.startPageToken).toBe("fresh-start-token");
      expect(result.hasMore).toBe(false);
    });
  });

  describe("data cutoff", () => {
    test("bootstrap filters files older than cutoff", async () => {
      const recentFile = makeDriveFile({
        id: "recent",
        createdTime: "2025-06-01T00:00:00Z",
      });
      const oldFile = makeDriveFile({
        id: "old",
        createdTime: "2020-01-01T00:00:00Z",
      });

      const sourceWithCutoff = createDriveSource(drive, {
        dataCutoff: "2024-01-01T00:00:00Z",
      });

      mockDriveFilesList(drive, [recentFile, oldFile]);
      drive.files.export = vi.fn(() => Promise.resolve({ data: "content" }));

      const result = await sourceWithCutoff.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("recent");
    });

    test("incremental filters old changes", async () => {
      const sourceWithCutoff = createDriveSource(drive, {
        dataCutoff: "2024-01-01T00:00:00Z",
      });

      const oldFile = makeDriveFile({
        id: "old-change",
        createdTime: "2020-01-01T00:00:00Z",
      });
      const recentFile = makeDriveFile({
        id: "recent-change",
        createdTime: "2025-01-01T00:00:00Z",
      });

      drive.changes.list = vi.fn(() =>
        Promise.resolve({
          data: {
            changes: [
              { fileId: "old-change", file: oldFile },
              { fileId: "recent-change", file: recentFile },
            ],
            newStartPageToken: "token-3",
          },
        }),
      );
      drive.files.export = vi.fn(() => Promise.resolve({ data: "content" }));

      const cursor = { phase: "incremental", startPageToken: "token-2" };
      const result = await sourceWithCutoff.sync(cursor);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("recent-change");
    });

    test("pushes cutoff into files.list `q=` as createdTime filter (#203)", async () => {
      const cutoff = "2024-01-01T00:00:00Z";
      const cutoffIso = new Date(cutoff).toISOString();
      const sourceWithCutoff = createDriveSource(drive, { dataCutoff: cutoff });

      mockDriveFilesList(drive, []);

      await sourceWithCutoff.sync(null);

      // The single bootstrap-page call carries the cutoff in the q= query
      // so the API never returns pre-cutoff files.
      const calls = (drive.files.list as any).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const [arg] of calls) {
        expect(arg.q).toContain(`createdTime >= '${cutoffIso}'`);
        expect(arg.q).toContain("trashed=false");
      }
    });

    test("does not include createdTime in q= when no cutoff is set", async () => {
      mockDriveFilesList(drive, [], { estimateCount: 0 });

      await source.sync(null);

      const calls = (drive.files.list as any).mock.calls;
      for (const [arg] of calls) {
        expect(arg.q).not.toContain("createdTime");
        expect(arg.q).toBe("trashed=false");
      }
    });
  });

  describe("content extraction", () => {
    test("exports Google Docs as plain text", async () => {
      const file = makeDriveFile({
        mimeType: "application/vnd.google-apps.document",
      });
      mockDriveFilesList(drive, [file]);
      drive.files.export = vi.fn(() => Promise.resolve({ data: "Document content here" }));

      const result = await source.sync(null);

      expect(result.documents[0].content).toContain("Document content here");
      expect(drive.files.export).toHaveBeenCalledWith({
        fileId: "file-1",
        mimeType: "text/plain",
      });
    });

    test("exports Google Sheets as CSV", async () => {
      const file = makeDriveFile({
        mimeType: "application/vnd.google-apps.spreadsheet",
        name: "Budget",
      });
      mockDriveFilesList(drive, [file]);
      drive.files.export = vi.fn(() => Promise.resolve({ data: "col1,col2\nval1,val2" }));

      const result = await source.sync(null);

      expect(result.documents[0].content).toContain("col1,col2");
      expect(drive.files.export).toHaveBeenCalledWith({
        fileId: "file-1",
        mimeType: "text/csv",
      });
    });

    test("exports Google Slides as plain text", async () => {
      const file = makeDriveFile({
        mimeType: "application/vnd.google-apps.presentation",
        name: "Slides",
      });
      mockDriveFilesList(drive, [file]);
      drive.files.export = vi.fn(() => Promise.resolve({ data: "Slide 1 text" }));

      const result = await source.sync(null);

      expect(result.documents[0].content).toContain("Slide 1 text");
      expect(drive.files.export).toHaveBeenCalledWith({
        fileId: "file-1",
        mimeType: "text/plain",
      });
    });

    test("downloads uploaded text files directly", async () => {
      const file = makeDriveFile({
        mimeType: "text/plain",
        name: "notes.txt",
      });
      mockDriveFilesList(drive, [file]);
      drive.files.get = vi.fn(() => Promise.resolve({ data: "Plain text file content" }));

      const result = await source.sync(null);

      expect(result.documents[0].content).toContain("Plain text file content");
      expect(drive.files.get).toHaveBeenCalledWith(
        { fileId: "file-1", alt: "media" },
        { responseType: "text" },
      );
    });

    test("downloads JSON files", async () => {
      const file = makeDriveFile({
        mimeType: "application/json",
        name: "config.json",
      });
      mockDriveFilesList(drive, [file]);
      drive.files.get = vi.fn(() => Promise.resolve({ data: '{"key": "value"}' }));

      const result = await source.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].content).toContain('{"key": "value"}');
    });

    test("skips binary MIME types", async () => {
      const files = [
        makeDriveFile({ id: "img", mimeType: "image/png", name: "photo.png" }),
        makeDriveFile({
          id: "vid",
          mimeType: "video/mp4",
          name: "clip.mp4",
        }),
        makeDriveFile({
          id: "aud",
          mimeType: "audio/mpeg",
          name: "song.mp3",
        }),
        makeDriveFile({
          id: "zip",
          mimeType: "application/zip",
          name: "archive.zip",
        }),
        makeDriveFile({
          id: "folder",
          mimeType: "application/vnd.google-apps.folder",
          name: "My Folder",
        }),
      ];
      mockDriveFilesList(drive, files);

      const result = await source.sync(null);

      expect(result.documents).toHaveLength(0);
      expect(drive.files.export).not.toHaveBeenCalled();
      expect(drive.files.get).not.toHaveBeenCalled();
    });

    test("skips files exceeding size limit", async () => {
      const file = makeDriveFile({
        mimeType: "text/plain",
        name: "huge.txt",
        size: String(11 * 1024 * 1024), // 11MB
      });
      mockDriveFilesList(drive, [file]);

      const result = await source.sync(null);

      expect(result.documents).toHaveLength(0);
    });

    test("handles export errors gracefully", async () => {
      mockDriveFilesList(drive, [makeDriveFile()]);
      drive.files.export = vi.fn(() => Promise.reject(new Error("Export failed")));

      const result = await source.sync(null);

      expect(result.documents).toHaveLength(0);
    });
  });

  // #270 — binary file extraction (PDF, Office, …) via the shared
  // attachment pipeline.
  describe("binary file extraction (#270)", () => {
    function createSourceWithExtractor(
      extractAttachment: import("@omnesis/core").AttachmentExtractFn,
    ) {
      return createDriveSource(drive, {
        attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
        extractAttachment,
      });
    }

    test("extracts PDF content via the injected attachment extractor", async () => {
      const pdf = makeDriveFile({
        id: "pdf-1",
        mimeType: "application/pdf",
        name: "Annual Report.pdf",
        size: "12345",
      });
      mockDriveFilesList(drive, [pdf]);
      drive.files.get = vi.fn(() =>
        // Returns ArrayBuffer per `responseType: "arraybuffer"`
        Promise.resolve({ data: new Uint8Array([1, 2, 3, 4]).buffer }),
      );

      const extractAttachment = vi.fn(() =>
        Promise.resolve({ text: "Annual report extracted body", pages: 12, truncated: false }),
      );
      const driveSource = createSourceWithExtractor(extractAttachment);

      const result = await driveSource.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(extractAttachment).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        "application/pdf",
        expect.objectContaining({ maxTextLength: expect.any(Number) }),
      );
      expect(drive.files.get).toHaveBeenCalledWith(
        { fileId: "pdf-1", alt: "media" },
        { responseType: "arraybuffer" },
      );
      const doc = result.documents[0];
      expect(doc.content).toContain("Annual report extracted body");
      expect(doc.content).toContain("PDF");
      expect(doc.metadata.extra?.pages).toBe(12);
      expect(doc.metadata.extra?.mimeType).toBe("application/pdf");
    });

    test("OCRs an image file (#427)", async () => {
      // image/* is in the allow-list (resolveAttachmentConfig), so an image
      // Drive file is not skipped as binary media — it downloads and routes
      // through the shared extractor (which OCRs it on the gateway).
      const img = makeDriveFile({
        id: "img-ocr",
        mimeType: "image/png",
        name: "whiteboard.png",
        size: "4096",
      });
      mockDriveFilesList(drive, [img]);
      drive.files.get = vi.fn(() => Promise.resolve({ data: new Uint8Array([1, 2, 3, 4]).buffer }));
      const extractAttachment = vi.fn(() =>
        Promise.resolve({ text: "Q3 goals: ship OCR", truncated: false, extra: { ocr: true } }),
      );
      const driveSource = createSourceWithExtractor(extractAttachment);

      const result = await driveSource.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(extractAttachment).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        "image/png",
        expect.objectContaining({ maxTextLength: expect.any(Number) }),
      );
      expect(result.documents[0].content).toContain("Q3 goals: ship OCR");
      // The extractor's OCR provenance propagates into the doc's `extra`, so a
      // Drive image carries the same `ocr` marker as a Gmail/Outlook attachment
      // (the shared buildAttachmentDocument does this; Drive builds inline).
      expect(result.documents[0].metadata.extra?.ocr).toBe(true);
      // Drive's own keys still win on collision.
      expect(result.documents[0].metadata.extra?.mimeType).toBe("image/png");
    });

    test("does not index an image when OCR successfully finds no text", async () => {
      const img = makeDriveFile({
        id: "img-no-text",
        mimeType: "image/png",
        name: "blank.png",
        size: "4096",
      });
      mockDriveFilesList(drive, [img]);
      drive.files.get = vi.fn(() => Promise.resolve({ data: new Uint8Array([1, 2, 3]).buffer }));
      const extractAttachment = vi.fn(() =>
        Promise.resolve({ text: "", truncated: false, noText: true as const }),
      );

      const result = await createSourceWithExtractor(extractAttachment).sync(null);

      expect(result.documents).toHaveLength(0);
      expect(extractAttachment).toHaveBeenCalledOnce();
    });

    test("propagates scanned-PDF OCR provenance (ocrPageCount) into extra (#427)", async () => {
      const pdf = makeDriveFile({
        id: "pdf-scanned",
        mimeType: "application/pdf",
        name: "Scanned Contract.pdf",
        size: "54321",
      });
      mockDriveFilesList(drive, [pdf]);
      drive.files.get = vi.fn(() => Promise.resolve({ data: new Uint8Array([1, 2, 3, 4]).buffer }));
      const extractAttachment = vi.fn(() =>
        Promise.resolve({
          text: "OCR'd page text",
          pages: 3,
          truncated: false,
          extra: { ocr: true, ocrPageCount: 2 },
        }),
      );
      const driveSource = createSourceWithExtractor(extractAttachment);

      const result = await driveSource.sync(null);

      const extra = result.documents[0].metadata.extra;
      expect(extra?.ocr).toBe(true);
      expect(extra?.ocrPageCount).toBe(2);
      expect(extra?.pages).toBe(3); // Drive's page count, set alongside provenance
    });

    test("extracts DOCX via the injected attachment extractor", async () => {
      const docx = makeDriveFile({
        id: "docx-1",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        name: "Notes.docx",
        size: "8192",
      });
      mockDriveFilesList(drive, [docx]);
      drive.files.get = vi.fn(() => Promise.resolve({ data: new Uint8Array([5, 6, 7]).buffer }));
      const extractAttachment = vi.fn(() =>
        Promise.resolve({ text: "DOCX body text", truncated: false }),
      );
      const driveSource = createSourceWithExtractor(extractAttachment);

      const result = await driveSource.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].content).toContain("DOCX body text");
      expect(result.documents[0].content).toContain("Word document");
    });

    test("propagates truncated flag onto metadata.extra", async () => {
      const pdf = makeDriveFile({
        id: "pdf-trunc",
        mimeType: "application/pdf",
        name: "huge.pdf",
        size: "100000",
      });
      mockDriveFilesList(drive, [pdf]);
      drive.files.get = vi.fn(() => Promise.resolve({ data: new Uint8Array([1]).buffer }));
      const driveSource = createSourceWithExtractor(
        vi.fn(() => Promise.resolve({ text: "partial body", truncated: true })),
      );

      const result = await driveSource.sync(null);

      expect(result.documents[0].metadata.extra?.truncated).toBe(true);
    });

    test("skips PDF when no extractor is injected (back-compat)", async () => {
      const pdf = makeDriveFile({
        id: "pdf-noex",
        mimeType: "application/pdf",
        name: "ignored.pdf",
        size: "1024",
      });
      mockDriveFilesList(drive, [pdf]);
      // Default source has no extractAttachment — PDF should be skipped
      // entirely (no download, no document emitted).
      const result = await source.sync(null);

      expect(result.documents).toHaveLength(0);
      expect(drive.files.get).not.toHaveBeenCalled();
    });

    test("skips PDF when attachmentConfig opts out (extractAttachments=false)", async () => {
      const pdf = makeDriveFile({
        id: "pdf-disabled",
        mimeType: "application/pdf",
        name: "ignored.pdf",
        size: "1024",
      });
      mockDriveFilesList(drive, [pdf]);
      const driveSource = createDriveSource(drive, {
        attachmentConfig: resolveAttachmentConfig(
          { extractAttachments: false },
          { defaultEnabled: true },
        ),
        extractAttachment: vi.fn(() => Promise.resolve({ text: "x", truncated: false })),
      });

      const result = await driveSource.sync(null);

      expect(result.documents).toHaveLength(0);
    });

    test("skips PDF when MIME type not in allowedTypes", async () => {
      const pdf = makeDriveFile({
        id: "pdf-typed-out",
        mimeType: "application/pdf",
        name: "ignored.pdf",
        size: "1024",
      });
      mockDriveFilesList(drive, [pdf]);
      const driveSource = createDriveSource(drive, {
        attachmentConfig: resolveAttachmentConfig(
          { attachmentTypes: ["text/plain"] },
          { defaultEnabled: true },
        ),
        extractAttachment: vi.fn(() => Promise.resolve({ text: "x", truncated: false })),
      });

      const result = await driveSource.sync(null);

      expect(result.documents).toHaveLength(0);
    });

    test("skips PDF whose size exceeds attachmentConfig.maxSizeBytes", async () => {
      const pdf = makeDriveFile({
        id: "pdf-huge",
        mimeType: "application/pdf",
        name: "monster.pdf",
        size: String(50 * 1024 * 1024), // 50 MB > default 25 MB cap
      });
      mockDriveFilesList(drive, [pdf]);
      const driveSource = createSourceWithExtractor(
        vi.fn(() => Promise.resolve({ text: "x", truncated: false })),
      );

      const result = await driveSource.sync(null);

      expect(result.documents).toHaveLength(0);
    });

    test("treats null extractAttachment result as extraction failure (no doc emitted)", async () => {
      const pdf = makeDriveFile({
        id: "pdf-fail",
        mimeType: "application/pdf",
        name: "scan.pdf",
        size: "2048",
      });
      mockDriveFilesList(drive, [pdf]);
      drive.files.get = vi.fn(() => Promise.resolve({ data: new Uint8Array([1, 2, 3]).buffer }));
      const driveSource = createSourceWithExtractor(vi.fn(() => Promise.resolve(null)));

      const result = await driveSource.sync(null);

      expect(result.documents).toHaveLength(0);
    });

    test("Workspace doc extraction is unchanged when extractor is injected", async () => {
      const doc = makeDriveFile({
        id: "gdoc-1",
        mimeType: "application/vnd.google-apps.document",
        name: "Plain Doc",
      });
      mockDriveFilesList(drive, [doc]);
      drive.files.export = vi.fn(() => Promise.resolve({ data: "Workspace export body" }));
      const extractAttachment = vi.fn();
      const driveSource = createSourceWithExtractor(extractAttachment);

      const result = await driveSource.sync(null);

      expect(result.documents[0].content).toContain("Workspace export body");
      // The shared attachment pipeline must NOT be invoked for Workspace
      // exports — they have a dedicated export path.
      expect(extractAttachment).not.toHaveBeenCalled();
    });

    test("text mime files don't go through the attachment pipeline", async () => {
      const txt = makeDriveFile({
        id: "txt-1",
        mimeType: "text/plain",
        name: "notes.txt",
        size: "100",
      });
      mockDriveFilesList(drive, [txt]);
      drive.files.get = vi.fn(() => Promise.resolve({ data: "Plain text body" }));
      const extractAttachment = vi.fn();
      const driveSource = createSourceWithExtractor(extractAttachment);

      const result = await driveSource.sync(null);

      expect(result.documents[0].content).toContain("Plain text body");
      expect(extractAttachment).not.toHaveBeenCalled();
      expect(drive.files.get).toHaveBeenCalledWith(
        { fileId: "txt-1", alt: "media" },
        { responseType: "text" },
      );
    });
  });

  // #680 — a transient non-OCR failure from the injected attachment contract
  // must NOT be swallowed into a null drop. It propagates out of the page so
  // the sync fails and the cursor is not advanced — the file is retried next
  // tick instead of being lost forever. A permanent extraction failure
  // (extractor returns null) keeps being skipped.
  describe("transient extraction failures retry instead of dropping (#680)", () => {
    function createSourceWithExtractor(
      extractAttachment: import("@omnesis/core").AttachmentExtractFn,
    ) {
      return createDriveSource(drive, {
        attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
        extractAttachment,
      });
    }

    function mockPdf(id = "pdf-transient") {
      const pdf = makeDriveFile({
        id,
        mimeType: "application/pdf",
        name: "scan-001.pdf",
        size: "12345",
      });
      mockDriveFilesList(drive, [pdf]);
      drive.files.get = vi.fn(() => Promise.resolve({ data: new Uint8Array([1, 2, 3, 4]).buffer }));
      return pdf;
    }

    test("rejects the sync page (cursor not advanced) on a transient extractor error", async () => {
      mockPdf();
      const extractAttachment = vi.fn(() =>
        Promise.reject(new SyncError("transient", "attachment processor unavailable")),
      );
      const driveSource = createSourceWithExtractor(extractAttachment);

      // The page must reject — the runner only persists the cursor after a
      // resolved page, so a rejection leaves the cursor where it was and the
      // file is re-walked next tick rather than silently dropped.
      await expect(driveSource.sync(null)).rejects.toBeInstanceOf(SyncError);
    });

    test("preserves the transient kind so the collector classifies it as retryable", async () => {
      mockPdf();
      const extractAttachment = vi.fn(() =>
        Promise.reject(new SyncError("transient", "attachment processor unavailable")),
      );
      const driveSource = createSourceWithExtractor(extractAttachment);

      await expect(driveSource.sync(null)).rejects.toMatchObject({ kind: "transient" });
    });

    test("a permanent extraction failure (extractor returns null) drops the file without failing the page", async () => {
      mockPdf("pdf-permanent");
      // null = genuinely unextractable (corrupt/empty binary, unsupported) — the
      // pre-#680 behavior is unchanged: the file is skipped, the page resolves.
      const extractAttachment = vi.fn(() => Promise.resolve(null));
      const driveSource = createSourceWithExtractor(extractAttachment);

      const result = await driveSource.sync(null);

      expect(result.documents).toHaveLength(0);
      expect(extractAttachment).toHaveBeenCalledTimes(1);
    });

    test("a non-transient thrown error still drops the file without failing the page", async () => {
      mockPdf("pdf-corrupt");
      // A non-SyncError (or a non-transient SyncError) is a permanent local
      // failure — keep skipping it rather than wedging sync on a bad binary.
      const extractAttachment = vi.fn(() => Promise.reject(new Error("corrupt PDF structure")));
      const driveSource = createSourceWithExtractor(extractAttachment);

      const result = await driveSource.sync(null);

      expect(result.documents).toHaveLength(0);
    });
  });

  describe("normalization", () => {
    test("builds correct DocumentInput with metadata", async () => {
      const file = makeDriveFile({
        shared: true,
        size: "1234",
      });
      mockDriveFilesList(drive, [file]);
      drive.files.export = vi.fn(() => Promise.resolve({ data: "Content" }));

      const result = await source.sync(null);
      const doc = result.documents[0];

      expect(doc.providerId).toBe(ProviderId("google:test@example.com"));
      expect(doc.sourceId).toBe(SourceId("google-drive:test@example.com"));
      expect(doc.externalId).toBe("file-1");
      expect(doc.title).toBe("Test Doc");
      expect(doc.contentHash).toBeDefined();
      expect(doc.metadata.sourceUrl).toBe("https://docs.google.com/document/d/file-1");
      expect(doc.metadata.documentType).toBe("file");
      expect(doc.metadata.extra?.mimeType).toBe("application/vnd.google-apps.document");
      expect(doc.metadata.extra?.shared).toBe(true);
      expect(doc.metadata.extra?.fileSize).toBe(1234);
      expect(doc.sourceCreatedAt).toBe("2025-01-01T00:00:00Z");
      expect(doc.sourceUpdatedAt).toBe("2025-01-02T00:00:00Z");
    });

    test("includes owner in people field", async () => {
      mockDriveFilesList(drive, [makeDriveFile()]);
      drive.files.export = vi.fn(() => Promise.resolve({ data: "Some content" }));

      const result = await source.sync(null);
      const doc = result.documents[0];

      expect(doc.metadata.people).toBeDefined();
      expect(doc.metadata.people).toHaveLength(1);
      expect(doc.metadata.people![0]).toEqual({
        role: "owner",
        name: "Alice",
        emails: ["alice@example.com"],
      });
    });

    test("extracts mentioned emails from content, skipping owner", async () => {
      mockDriveFilesList(drive, [makeDriveFile()]);
      drive.files.export = vi.fn(() =>
        Promise.resolve({
          data: "Contact bob@example.com or alice@example.com for details",
        }),
      );

      const result = await source.sync(null);
      const doc = result.documents[0];

      expect(doc.metadata.people).toBeDefined();
      // Owner + one mentioned email (alice@example.com is skipped as owner)
      expect(doc.metadata.people).toHaveLength(2);
      expect(doc.metadata.people![0].role).toBe("owner");
      expect(doc.metadata.people![1]).toEqual({
        role: "mentioned",
        emails: ["bob@example.com"],
      });
    });

    test("people is undefined when file has no owners", async () => {
      const file = makeDriveFile({ owners: [] });
      mockDriveFilesList(drive, [file]);
      drive.files.export = vi.fn(() => Promise.resolve({ data: "No emails here" }));

      const result = await source.sync(null);
      const doc = result.documents[0];

      expect(doc.metadata.people).toBeUndefined();
    });

    test("uses file ID as externalId", async () => {
      const file = makeDriveFile({ id: "unique-drive-id-123" });
      mockDriveFilesList(drive, [file]);
      drive.files.export = vi.fn(() => Promise.resolve({ data: "text" }));

      const result = await source.sync(null);

      expect(result.documents[0].externalId).toBe("unique-drive-id-123");
    });

    test("skips files with missing id, name, or mimeType", async () => {
      const files = [
        makeDriveFile({ id: null }),
        makeDriveFile({ name: null }),
        makeDriveFile({ mimeType: null }),
      ];
      mockDriveFilesList(drive, files);

      const result = await source.sync(null);

      expect(result.documents).toHaveLength(0);
    });
  });
});

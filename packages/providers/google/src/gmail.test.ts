// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  deriveAttachmentStableId,
  extractSchemaOrgDatesFromHtml,
  setDefaultPhoneRegion,
} from "@omnesis/core";
import { SourceId, ProviderId, SyncError } from "@omnesis/types";
import { GmailSource, gmailMessageUrl } from "./gmail.js";
import { createMockGmail, createGmailSource, makeGmailMessage } from "./testing/mock-google.js";

describe("GmailSource", () => {
  let gmail: ReturnType<typeof createMockGmail>;
  let source: GmailSource;

  beforeEach(() => {
    gmail = createMockGmail();
    source = createGmailSource(gmail);
  });

  test("has correct id and providerId", () => {
    expect(source.id).toBe(SourceId("gmail:test@example.com"));
    expect(source.providerId).toBe(ProviderId("google:test@example.com"));
  });

  test("has correct id without accountId", () => {
    const p = new GmailSource({} as any);
    expect(p.id).toBe(SourceId("gmail"));
    expect(p.providerId).toBe(ProviderId("google"));
  });

  describe("bootstrap sync", () => {
    test("fetches messages and returns documents", async () => {
      const msg = makeGmailMessage("msg-1", { internalDate: "1704067200000" });
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: { messages: [{ id: "msg-1" }], nextPageToken: undefined },
        }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("msg-1");
      expect(result.documents[0].title).toBe("Test Subject");
      expect(result.hasMore).toBe(false);

      const cursor = result.cursor as any;
      expect(cursor.phase).toBe("incremental");
      expect(cursor.historyId).toBe("history-1");
    });

    test("paginates with hasMore and pageToken", async () => {
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: {
            messages: [{ id: "msg-1" }],
            nextPageToken: "page-2",
          },
        }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({
          data: makeGmailMessage("msg-1", { internalDate: "1704067200000" }),
        }),
      );

      const result = await source.sync(null);

      expect(result.hasMore).toBe(true);
      const cursor = result.cursor as any;
      expect(cursor.phase).toBe("bootstrap");
      expect(cursor.pageToken).toBe("page-2");
    });

    test("reports bootstrap progress", async () => {
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: { messages: [{ id: "msg-1" }] },
        }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({
          data: makeGmailMessage("msg-1", { internalDate: "1704067200000" }),
        }),
      );

      const result = await source.sync(null);

      expect(result.progress?.phase).toBe("bootstrap");
      expect(result.progress?.processed).toBe(1);
      expect(result.progress?.total).toBe(100);
    });

    test("empty inbox returns no documents with correct progress", async () => {
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: { messages: [] },
        }),
      );
      gmail.users.getProfile = vi.fn(() =>
        Promise.resolve({
          data: {
            emailAddress: "test@example.com",
            messagesTotal: 0,
            historyId: "history-1",
          },
        }),
      );

      const result = await source.sync(null);

      expect(result.documents).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.progress?.total).toBe(0);
    });

    test("transitions to incremental once processed >= messagesTotal even if pagination has more", async () => {
      // Reproduces gmail-cursor-stuck-in-bootstrap-blocks-incremental-sync:
      // Gmail's listMessages keeps serving past messagesTotal due to in-flight
      // churn. Without a count-based escape, the cursor stays in bootstrap
      // forever and never picks up new mail via history.list.
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: { messages: [{ id: "last-1" }], nextPageToken: "page-99" },
        }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({
          data: makeGmailMessage("last-1", { internalDate: "1704067200000" }),
        }),
      );

      const cursor: any = {
        phase: "bootstrap",
        pageToken: "page-50",
        totalMessages: 50,
        processedDocs: 49,
        bootstrapHistoryId: "history-pinned",
      };
      const result = await source.sync(cursor);

      const out = result.cursor as any;
      expect(out.phase).toBe("incremental");
      expect(out.historyId).toBe("history-pinned");
      expect(out.pageToken).toBeUndefined();
      expect(out.bootstrapHistoryId).toBeUndefined();
      expect(result.hasMore).toBe(false);
    });

    test("pins bootstrapHistoryId on the first bootstrap page", async () => {
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: { messages: [{ id: "msg-1" }], nextPageToken: "page-2" },
        }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({
          data: makeGmailMessage("msg-1", { internalDate: "1704067200000" }),
        }),
      );

      const result = await source.sync(null);
      const out = result.cursor as any;
      expect(out.phase).toBe("bootstrap");
      expect(out.bootstrapHistoryId).toBe("history-1");
      expect(out.processedDocs).toBe(1);
      expect(out.totalMessages).toBe(100);
    });
  });

  describe("incremental sync", () => {
    test("fetches history changes", async () => {
      gmail.users.history.list = vi.fn(() =>
        Promise.resolve({
          data: {
            history: [
              {
                messagesAdded: [{ message: { id: "new-msg" } }],
              },
            ],
            historyId: "history-3",
          },
        }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({
          data: makeGmailMessage("new-msg", { internalDate: "1704067200000" }),
        }),
      );

      const cursor = { phase: "incremental", historyId: "history-1" };
      const result = await source.sync(cursor);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("new-msg");
      expect(result.hasMore).toBe(false);
    });

    test("handles deleted messages", async () => {
      gmail.users.history.list = vi.fn(() =>
        Promise.resolve({
          data: {
            history: [
              {
                messagesDeleted: [{ message: { id: "del-msg" } }],
              },
            ],
            historyId: "history-3",
          },
        }),
      );

      const cursor = { phase: "incremental", historyId: "history-1" };
      const result = await source.sync(cursor);

      expect(result.documents).toHaveLength(0);
      expect(result.deletedExternalIds).toContain("del-msg");
    });

    test("404 recovers with a bounded backfill, not a full mailbox re-walk (#111)", async () => {
      // An expired historyId can't be resumed via history.list. We re-bootstrap,
      // but bounded to the recent window (`recoverAfter`) so we backfill only
      // the missed gap rather than re-paging the entire mailbox. recoverAfter is
      // the last-sync watermark minus a 2-day safety overlap.
      const error: any = new Error("Not Found");
      error.code = 404;
      gmail.users.history.list = vi.fn(() => Promise.reject(error));

      const cursor = {
        phase: "incremental",
        historyId: "expired",
        lastSyncAt: "2026-06-01T00:00:00.000Z",
      };
      const result = await source.sync(cursor);

      expect(result.documents).toHaveLength(0);
      const newCursor = result.cursor as any;
      expect(newCursor.phase).toBe("bootstrap");
      expect(newCursor.historyId).toBeUndefined();
      expect(newCursor.pageToken).toBeUndefined();
      expect(result.hasMore).toBe(true);
      expect(newCursor.recoverAfter).toBe("2026-05-30T00:00:00.000Z");
      // The watermark bounds the recovery to a provably-complete window — the
      // gap it backfills is exactly what elapsed since the last successful
      // sync — so this recovery does not report degraded coverage.
      expect(result.progress?.coverage).toBeUndefined();
      // And the walk it hands off to has to reach the same conclusion. Withholding
      // the claim for one page is worth nothing if the next page says "unknown"
      // and settles it into the cursor, where every later page restates it.
      expect(newCursor.recoveryVouched).toBe(true);
    });

    test("a watermarked recovery still settles a mailbox as complete", async () => {
      // One expired history id is the routine consequence of a collector being
      // offline for a week. It must not permanently downgrade a mailbox that
      // had legitimately settled complete — nothing short of a full resync
      // would ever clear that.
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [], nextPageToken: undefined } }),
      ) as never;
      const result = await source.sync({
        phase: "bootstrap",
        recoverAfter: "2026-05-30T00:00:00.000Z",
        lastSyncAt: "2026-05-30T00:00:00.000Z",
        recoveryVouched: true,
      } as never);
      expect(result.hasMore).toBe(false);
      expect((result.cursor as any).coverage).toBe("complete");
      expect(result.progress?.coverage).toBe("complete");
    });

    test("a watermarked recovery still settles complete when it spans more than one page", async () => {
      // The single-page case proves nothing about the field surviving a
      // cursor round-trip, and a recovery worth having is more than one page:
      // a week offline is normally past the page size. Page one dropped the
      // marker, page two re-derived "unknown" from the floor alone, and that
      // is what got settled.
      let page = 0;
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: { messages: [], nextPageToken: page++ === 0 ? "page-2" : undefined },
        }),
      ) as never;

      let cursor: unknown = {
        phase: "bootstrap",
        recoverAfter: "2026-05-30T00:00:00.000Z",
        lastSyncAt: "2026-05-30T00:00:00.000Z",
        recoveryVouched: true,
      };
      let result;
      for (let i = 0; i < 3; i++) {
        result = await source.sync(cursor as never);
        cursor = result.cursor;
        if (!result.hasMore) break;
      }
      expect(page).toBeGreaterThan(1);
      expect((result!.cursor as any).coverage).toBe("complete");
    });

    test("an unwatermarked recovery settles the gap it cannot vouch for", async () => {
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [], nextPageToken: undefined } }),
      ) as never;
      const result = await source.sync({
        phase: "bootstrap",
        recoverAfter: "2026-05-30T00:00:00.000Z",
      } as never);
      expect((result.cursor as any).coverage).toBe("unknown");
    });

    test("404 recovery without a watermark falls back to a bounded look-back (#111)", async () => {
      // A cursor written before `lastSyncAt` existed has no watermark — recovery
      // must still bound the walk (a ~30-day look-back), never re-walk everything.
      const error: any = new Error("Not Found");
      error.code = 404;
      gmail.users.history.list = vi.fn(() => Promise.reject(error));

      const before = Date.now();
      const result = await source.sync({ phase: "incremental", historyId: "expired" });
      const after = Date.now();

      const newCursor = result.cursor as any;
      expect(newCursor.phase).toBe("bootstrap");
      const recoverMs = new Date(newCursor.recoverAfter).getTime();
      const THIRTY_D = 30 * 24 * 60 * 60 * 1000;
      expect(recoverMs).toBeGreaterThanOrEqual(before - THIRTY_D - 1000);
      expect(recoverMs).toBeLessThanOrEqual(after - THIRTY_D + 1000);
      // With no watermark to anchor on, the fixed look-back is a guess that
      // may undershoot the real gap — the source cannot vouch for it.
      expect(result.progress?.coverage).toBe("unknown");
      expect(result.progress?.detail).toBeTruthy();
    });

    test("the recovery bootstrap narrows messages.list to after:<recoverAfter> (#111)", async () => {
      // Feeding the recovery cursor back must page only the bounded window —
      // proven by the `after:` operand — re-ingest the gap message, then
      // transition straight to incremental once the bounded page set exhausts.
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: { messages: [{ id: "gap-msg" }], nextPageToken: undefined },
        }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({
          data: makeGmailMessage("gap-msg", { internalDate: "1717200000000" }),
        }),
      );

      const result = await source.sync({
        phase: "bootstrap",
        recoverAfter: "2026-05-30T00:00:00.000Z",
      });

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("gap-msg");
      const listArg = (gmail.users.messages.list as any).mock.calls[0][0];
      expect(listArg.q).toContain("after:2026/05/30");
      const out = result.cursor as any;
      expect(out.phase).toBe("incremental");
      expect(out.recoverAfter).toBeUndefined();
    });

    test("a recovery bootstrap exhausts on pagination end, not messagesTotal (#111)", async () => {
      // Bounded walks fetch far fewer than messagesTotal, so the count-based
      // early-exit stays disabled; only `nextPageToken` running out ends it.
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: { messages: [{ id: "r-1" }], nextPageToken: "page-2" },
        }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({
          data: makeGmailMessage("r-1", { internalDate: "1717200000000" }),
        }),
      );

      const result = await source.sync({
        phase: "bootstrap",
        recoverAfter: "2026-05-30T00:00:00.000Z",
        pageToken: "page-1",
        totalMessages: 1,
        processedDocs: 5, // already past the count — an unbounded walk would stop
        bootstrapHistoryId: "history-pinned",
      } as any);

      expect(result.hasMore).toBe(true);
      const out = result.cursor as any;
      expect(out.phase).toBe("bootstrap");
      expect(out.recoverAfter).toBe("2026-05-30T00:00:00.000Z");
    });

    test("incremental sync stamps lastSyncAt on the cursor (#111)", async () => {
      gmail.users.history.list = vi.fn(() =>
        Promise.resolve({ data: { history: [], historyId: "history-9" } }),
      );
      const before = Date.now();
      const result = await source.sync({ phase: "incremental", historyId: "history-1" });
      const out = result.cursor as any;
      expect(out.phase).toBe("incremental");
      expect(typeof out.lastSyncAt).toBe("string");
      expect(new Date(out.lastSyncAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    test("message moved to TRASH produces deletedExternalIds", async () => {
      gmail.users.history.list = vi.fn(() =>
        Promise.resolve({
          data: {
            history: [
              {
                labelsAdded: [
                  {
                    message: { id: "trashed-msg" },
                    labelIds: ["TRASH"],
                  },
                ],
              },
            ],
            historyId: "history-3",
          },
        }),
      );

      const cursor = { phase: "incremental", historyId: "history-1" };
      const result = await source.sync(cursor);

      expect(result.deletedExternalIds).toContain("trashed-msg");
      expect(result.documents).toHaveLength(0);
    });

    test("message moved to SPAM produces deletedExternalIds", async () => {
      gmail.users.history.list = vi.fn(() =>
        Promise.resolve({
          data: {
            history: [
              {
                labelsAdded: [
                  {
                    message: { id: "spam-msg" },
                    labelIds: ["SPAM"],
                  },
                ],
              },
            ],
            historyId: "history-3",
          },
        }),
      );

      const cursor = { phase: "incremental", historyId: "history-1" };
      const result = await source.sync(cursor);

      expect(result.deletedExternalIds).toContain("spam-msg");
    });

    test("paginates history.list across multiple pages without dropping events", async () => {
      // Reproduces gmail-history-list-pagination-missing: previously only the
      // first page was processed and historyId advanced, silently dropping
      // every event from pages 2+.
      gmail.users.history.list = vi.fn(() =>
        Promise.resolve({
          data: {
            history: [{ messagesAdded: [{ message: { id: "page-1-msg" } }] }],
            historyId: "history-mid",
            nextPageToken: "history-page-2",
          },
        }),
      );
      gmail.users.messages.get = vi.fn((opts: any) =>
        Promise.resolve({
          data: makeGmailMessage(opts.id, { internalDate: "1704067200000" }),
        }),
      );

      const cursor = { phase: "incremental", historyId: "history-1" };
      const result = await source.sync(cursor);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("page-1-msg");
      expect(result.hasMore).toBe(true);

      const out = result.cursor as any;
      // historyId stays at the old value until we've drained every page,
      // and historyPageToken persists so the next call resumes.
      expect(out.historyId).toBe("history-1");
      expect(out.historyPageToken).toBe("history-page-2");

      // Next call resumes with the saved historyPageToken.
      gmail.users.history.list = vi.fn((opts: any) => {
        expect(opts.pageToken).toBe("history-page-2");
        expect(opts.startHistoryId).toBe("history-1");
        return Promise.resolve({
          data: {
            history: [{ messagesAdded: [{ message: { id: "page-2-msg" } }] }],
            historyId: "history-final",
          },
        });
      });

      const result2 = await source.sync(out);
      expect(result2.documents[0].externalId).toBe("page-2-msg");
      expect(result2.hasMore).toBe(false);

      const out2 = result2.cursor as any;
      // Only on the last page does historyId advance and the page token clear.
      expect(out2.historyId).toBe("history-final");
      expect(out2.historyPageToken).toBeUndefined();
    });

    test("non-TRASH/SPAM label additions trigger re-fetch (e.g. STARRED, IMPORTANT, custom labels)", async () => {
      // Reproduces gmail-label-changes-not-propagated: previously only
      // TRASH/SPAM labelsAdded events triggered any action. Starring a
      // message, applying a custom label, or marking IMPORTANT was silently
      // ignored, leaving metadata.tags frozen at first-ingest values.
      gmail.users.history.list = vi.fn(() =>
        Promise.resolve({
          data: {
            history: [
              {
                labelsAdded: [
                  { message: { id: "msg-starred" }, labelIds: ["STARRED"] },
                  { message: { id: "msg-custom" }, labelIds: ["Label_4567"] },
                ],
              },
            ],
            historyId: "history-3",
          },
        }),
      );
      gmail.users.messages.get = vi.fn((opts: any) =>
        Promise.resolve({
          data: makeGmailMessage(opts.id, { internalDate: "1704067200000" }),
        }),
      );

      const cursor = { phase: "incremental", historyId: "history-1" };
      const result = await source.sync(cursor);

      const ids = result.documents.map((d) => d.externalId).sort();
      expect(ids).toEqual(["msg-custom", "msg-starred"]);
      expect(result.deletedExternalIds).toEqual([]);
    });

    test("non-TRASH/SPAM label removals also trigger re-fetch (e.g. UNREAD cleared)", async () => {
      gmail.users.history.list = vi.fn(() =>
        Promise.resolve({
          data: {
            history: [
              {
                labelsRemoved: [{ message: { id: "msg-read" }, labelIds: ["UNREAD"] }],
              },
            ],
            historyId: "history-3",
          },
        }),
      );
      gmail.users.messages.get = vi.fn((opts: any) =>
        Promise.resolve({
          data: makeGmailMessage(opts.id, { internalDate: "1704067200000" }),
        }),
      );

      const cursor = { phase: "incremental", historyId: "history-1" };
      const result = await source.sync(cursor);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("msg-read");
    });

    test("message removed from TRASH is re-indexed", async () => {
      gmail.users.history.list = vi.fn(() =>
        Promise.resolve({
          data: {
            history: [
              {
                labelsRemoved: [
                  {
                    message: { id: "restored-msg" },
                    labelIds: ["TRASH"],
                  },
                ],
              },
            ],
            historyId: "history-3",
          },
        }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({
          data: makeGmailMessage("restored-msg", {
            internalDate: "1704067200000",
          }),
        }),
      );

      const cursor = { phase: "incremental", historyId: "history-1" };
      const result = await source.sync(cursor);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("restored-msg");
      expect(result.deletedExternalIds).not.toContain("restored-msg");
    });
  });

  describe("custom label resolution", () => {
    test("resolves opaque Label_<id> to its human-readable name in metadata.tags", async () => {
      // Reproduces gmail-custom-label-id-not-resolved: previously msg.labelIds
      // landed verbatim in metadata.tags, so user-created labels surfaced as
      // "Label_2467413876275976159" instead of e.g. "omnesis".
      gmail.users.labels.list = vi.fn(() =>
        Promise.resolve({
          data: {
            labels: [
              { id: "INBOX", name: "INBOX", type: "system" },
              { id: "Label_2467", name: "omnesis", type: "user" },
            ],
          },
        }),
      );
      const msg = makeGmailMessage("msg-1", {
        internalDate: "1704067200000",
        labelIds: ["INBOX", "Label_2467"],
      });
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);
      expect(result.documents[0].metadata.tags).toEqual(["INBOX", "omnesis"]);
    });

    test("refreshes the label cache when an unknown Label_ id is seen", async () => {
      let callCount = 0;
      gmail.users.labels.list = vi.fn(() => {
        callCount++;
        const labels =
          callCount === 1
            ? [{ id: "INBOX", name: "INBOX", type: "system" }]
            : [
                { id: "INBOX", name: "INBOX", type: "system" },
                { id: "Label_999", name: "newly-created", type: "user" },
              ];
        return Promise.resolve({ data: { labels } });
      });
      const msg = makeGmailMessage("msg-1", {
        internalDate: "1704067200000",
        labelIds: ["INBOX", "Label_999"],
      });
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);
      expect(result.documents[0].metadata.tags).toEqual(["INBOX", "newly-created"]);
      expect(callCount).toBe(2);
    });

    test("falls back to the raw id when label fetch fails entirely", async () => {
      gmail.users.labels.list = vi.fn(() => Promise.reject(new Error("API down")));
      const msg = makeGmailMessage("msg-1", {
        internalDate: "1704067200000",
        labelIds: ["INBOX", "Label_xyz"],
      });
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);
      expect(result.documents[0].metadata.tags).toEqual(["INBOX", "Label_xyz"]);
    });
  });

  describe("body extraction", () => {
    test("text/plain is preferred over HTML", async () => {
      const msg = makeGmailMessage("msg-1", {
        internalDate: "1704067200000",
        payload: {
          headers: [
            { name: "Subject", value: "Test" },
            { name: "From", value: "a@b.com" },
            { name: "To", value: "c@d.com" },
            { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 GMT" },
          ],
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              body: {
                data: Buffer.from("Plain text body").toString("base64url"),
              },
            },
            {
              mimeType: "text/html",
              body: {
                data: Buffer.from("<p>HTML body</p>").toString("base64url"),
              },
            },
          ],
        },
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);

      expect(result.documents[0].content).toContain("Plain text body");
      expect(result.documents[0].content).not.toContain("HTML body");
    });

    test("HTML fallback with tag stripping", async () => {
      const msg = makeGmailMessage("msg-1", {
        internalDate: "1704067200000",
        payload: {
          headers: [
            { name: "Subject", value: "Test" },
            { name: "From", value: "a@b.com" },
            { name: "To", value: "c@d.com" },
            { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 GMT" },
          ],
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/html",
              body: {
                data: Buffer.from("<div><p>Hello</p>&nbsp;<b>World</b></div>").toString(
                  "base64url",
                ),
              },
            },
          ],
        },
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);

      expect(result.documents[0].content).toContain("Hello");
      expect(result.documents[0].content).toContain("World");
      expect(result.documents[0].content).not.toContain("<div>");
      expect(result.documents[0].content).not.toContain("<p>");
    });

    test("HTML fallback drops <style>, <script>, and <head> contents", async () => {
      const html = [
        "<html><head><title>X</title>",
        "<style>body { font-size: 50px !important; } @font-face { font-family: 'Gotham'; }</style>",
        "</head><body>",
        "<script>alert('xss')</script>",
        "<p>Visible body text</p>",
        "</body></html>",
      ].join("");
      const msg = makeGmailMessage("msg-1", {
        internalDate: "1704067200000",
        payload: {
          headers: [
            { name: "Subject", value: "Test" },
            { name: "From", value: "a@b.com" },
            { name: "To", value: "c@d.com" },
            { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 GMT" },
          ],
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/html",
              body: { data: Buffer.from(html).toString("base64url") },
            },
          ],
        },
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);
      const content = result.documents[0].content;

      expect(content).toContain("Visible body text");
      expect(content).not.toContain("font-size");
      expect(content).not.toContain("@font-face");
      expect(content).not.toContain("alert(");
      expect(content).not.toContain("<title>");
    });

    test("multipart/mixed with nested parts", async () => {
      const msg = makeGmailMessage("msg-1", {
        internalDate: "1704067200000",
        payload: {
          headers: [
            { name: "Subject", value: "Test" },
            { name: "From", value: "a@b.com" },
            { name: "To", value: "c@d.com" },
            { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 GMT" },
          ],
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                {
                  mimeType: "text/plain",
                  body: {
                    data: Buffer.from("Nested plain text").toString("base64url"),
                  },
                },
              ],
            },
            {
              mimeType: "application/pdf",
              filename: "doc.pdf",
              body: { attachmentId: "att-1" },
            },
          ],
        },
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);

      expect(result.documents[0].content).toContain("Nested plain text");
    });
  });

  describe("document normalization", () => {
    test("correct title, content format, and metadata fields", async () => {
      const msg = makeGmailMessage("msg-1", {
        internalDate: "1704067200000",
        subject: "Important Email",
        from: "alice@example.com",
        to: "bob@example.com",
        cc: "carol@example.com",
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);
      const doc = result.documents[0];

      expect(doc.title).toBe("Important Email");
      expect(doc.content).toContain("# Important Email");
      expect(doc.content).toContain("**From:** alice@example.com");
      expect(doc.content).toContain("**To:** bob@example.com");
      expect(doc.content).toContain("**Cc:** carol@example.com");
      expect(doc.metadata.sourceUrl).toBe(
        "https://mail.google.com/mail/u/0/?authuser=test%40example.com#all/msg-1",
      );
      // Gmail has no working iOS deep link; no appUrl is emitted so the iOS
      // app falls back to the web sourceUrl.
      expect(doc.metadata.appUrl).toBeUndefined();
      expect(doc.metadata.extra?.threadId).toBe("thread-msg-1");
      expect(doc.contentHash).toBeDefined();
      expect(doc.sourceCreatedAt).toBe("2024-01-01T00:00:00.000Z");
    });
  });

  describe("people mentions", () => {
    test("populates sender and recipients with correct roles", async () => {
      const msg = makeGmailMessage("msg-1", {
        internalDate: "1704067200000",
        from: '"Alice Smith" <alice@example.com>',
        to: '"Bob Jones" <bob@example.com>',
        cc: "carol@example.com",
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);
      const doc = result.documents[0];
      const people = doc.metadata.people!;

      expect(people).toBeDefined();
      expect(people.length).toBeGreaterThanOrEqual(3);

      const sender = people.find((p) => p.role === "sender");
      expect(sender).toBeDefined();
      expect(sender!.name).toBe("Alice Smith");
      expect(sender!.emails).toEqual(["alice@example.com"]);

      const recipients = people.filter((p) => p.role === "recipient");
      expect(recipients).toHaveLength(2);
      expect(recipients.map((r) => r.emails![0])).toContain("bob@example.com");
      expect(recipients.map((r) => r.emails![0])).toContain("carol@example.com");

      const bob = recipients.find((r) => r.emails![0] === "bob@example.com");
      expect(bob!.name).toBe("Bob Jones");
    });

    test("extracts mentioned emails from body (not duplicating sender/recipients)", async () => {
      const bodyText = "Please contact dave@example.com or alice@example.com for details.";
      const msg = makeGmailMessage("msg-1", {
        internalDate: "1704067200000",
        from: "alice@example.com",
        to: "bob@example.com",
        payload: {
          headers: [
            { name: "Subject", value: "Test" },
            { name: "From", value: "alice@example.com" },
            { name: "To", value: "bob@example.com" },
            { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 GMT" },
          ],
          mimeType: "text/plain",
          body: {
            data: Buffer.from(bodyText).toString("base64url"),
          },
        },
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);
      const people = result.documents[0].metadata.people!;

      // alice@example.com is sender, bob@example.com is recipient — neither should be "mentioned"
      const mentioned = people.filter((p) => p.role === "mentioned");
      const mentionedEmails = mentioned.flatMap((p) => p.emails ?? []);
      expect(mentionedEmails).toContain("dave@example.com");
      expect(mentionedEmails).not.toContain("alice@example.com");
      expect(mentionedEmails).not.toContain("bob@example.com");
    });

    test("extracts a national-format phone as reference-only with collector context", async () => {
      const bodyText = "For the fictional office call 07700 000000.";
      const msg = makeGmailMessage("msg-phone", {
        internalDate: "1704067200000",
        payload: {
          headers: [
            { name: "Subject", value: "Test" },
            { name: "From", value: "alice@example.com" },
            { name: "To", value: "bob@example.com" },
            { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 GMT" },
          ],
          mimeType: "text/plain",
          body: { data: Buffer.from(bodyText).toString("base64url") },
        },
      });
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-phone" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      setDefaultPhoneRegion("GB");
      try {
        const result = await source.sync(null);
        expect(result.documents[0].metadata.people).toContainEqual({
          role: "mentioned",
          phones: ["+447700000000"],
          allowPersonCreation: false,
        });
      } finally {
        setDefaultPhoneRegion(undefined);
      }
    });

    test("preserves existing author and recipients fields alongside people", async () => {
      const msg = makeGmailMessage("msg-1", {
        internalDate: "1704067200000",
        from: "alice@example.com",
        to: "bob@example.com",
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result = await source.sync(null);
      const doc = result.documents[0];

      // people present
      expect(doc.metadata.people).toBeDefined();
      expect(doc.metadata.people!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("relevance score", () => {
    function setupSingleMessage(msgOverrides: Parameters<typeof makeGmailMessage>[1]) {
      const msg = makeGmailMessage("msg-1", { internalDate: "1704067200000", ...msgOverrides });
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));
    }

    test("sets documentType to email", async () => {
      setupSingleMessage({});
      const result = await source.sync(null);
      expect(result.documents[0].metadata.documentType).toBe("email");
    });

    test("default inbox email gets 0.5", async () => {
      setupSingleMessage({ labelIds: ["INBOX"] });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.relevanceScore).toBe(0.5);
    });

    test("sent email gets ~0.9", async () => {
      setupSingleMessage({ labelIds: ["SENT"] });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.relevanceScore).toBe(0.9);
    });

    test("important + starred gets ~0.8", async () => {
      setupSingleMessage({ labelIds: ["INBOX", "IMPORTANT", "STARRED"] });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.relevanceScore).toBe(0.8);
    });

    test("promotional + List-Unsubscribe gets low score", async () => {
      setupSingleMessage({
        labelIds: ["CATEGORY_PROMOTIONS"],
        extraHeaders: [{ name: "List-Unsubscribe", value: "<mailto:unsub@example.com>" }],
      });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.relevanceScore).toBeLessThanOrEqual(0.1);
    });

    test("List-Unsubscribe sets the generic bulkMail marker", async () => {
      setupSingleMessage({
        labelIds: ["INBOX"],
        extraHeaders: [{ name: "List-Unsubscribe", value: "<mailto:unsub@example.com>" }],
      });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.bulkMail).toBe(true);
    });

    test("no List-Unsubscribe leaves bulkMail unset (never false)", async () => {
      setupSingleMessage({ labelIds: ["INBOX"] });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.bulkMail).toBeUndefined();
    });

    test("a no-reply sender sets the generic automatedSender marker", async () => {
      setupSingleMessage({ labelIds: ["INBOX"], from: "notifications@example.com" });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.automatedSender).toBe(true);
    });

    test("an Auto-Submitted: auto-generated header sets automatedSender even from a normal address", async () => {
      setupSingleMessage({
        labelIds: ["INBOX"],
        from: "builds@example.com",
        extraHeaders: [{ name: "Auto-Submitted", value: "auto-generated" }],
      });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.automatedSender).toBe(true);
    });

    test("a genuine personal email leaves automatedSender unset (never false)", async () => {
      setupSingleMessage({ labelIds: ["INBOX"], from: "maya@example.com" });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.automatedSender).toBeUndefined();
    });

    test("stacked negatives clamp to 0", async () => {
      setupSingleMessage({
        labelIds: ["CATEGORY_PROMOTIONS", "DRAFT"],
        extraHeaders: [
          { name: "List-Unsubscribe", value: "<mailto:unsub@example.com>" },
          { name: "Precedence", value: "bulk" },
          { name: "Auto-Submitted", value: "auto-generated" },
        ],
      });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.relevanceScore).toBe(0);
    });

    test("personal category boosts score", async () => {
      setupSingleMessage({ labelIds: ["INBOX", "CATEGORY_PERSONAL"] });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.relevanceScore).toBe(0.6);
    });

    test("auto-submitted header lowers score", async () => {
      setupSingleMessage({
        labelIds: ["INBOX"],
        extraHeaders: [{ name: "Auto-Submitted", value: "auto-generated" }],
      });
      const result = await source.sync(null);
      expect(result.documents[0].metadata.relevanceScore).toBe(0.2);
    });
  });

  describe("data cutoff", () => {
    test("filters out emails older than cutoff during bootstrap", async () => {
      const recentDate = "1704067200000"; // 2024-01-01
      const oldDate = "1577836800000"; // 2020-01-01
      const cutoff = "2023-01-01T00:00:00Z";

      const sourceWithCutoff = createGmailSource(gmail, {
        dataCutoff: cutoff,
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: {
            messages: [{ id: "recent" }, { id: "old" }],
            nextPageToken: "page-2",
          },
        }),
      );

      let callCount = 0;
      gmail.users.messages.get = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            data: makeGmailMessage("recent", { internalDate: recentDate }),
          });
        }
        return Promise.resolve({
          data: makeGmailMessage("old", { internalDate: oldDate }),
        });
      });

      const result = await sourceWithCutoff.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("recent");
      // The pre-cutoff message gets dropped, but bootstrap continues — leaks
      // are timezone slop / oddball internalDates, not a stop signal.
      expect(result.hasMore).toBe(true);
    });

    test("continues fetching when all emails are newer than cutoff", async () => {
      const recentDate1 = "1704067200000"; // 2024-01-01
      const recentDate2 = "1704153600000"; // 2024-01-02
      const cutoff = "2023-01-01T00:00:00Z";

      const sourceWithCutoff = createGmailSource(gmail, {
        dataCutoff: cutoff,
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: {
            messages: [{ id: "msg-1" }, { id: "msg-2" }],
            nextPageToken: "page-2",
          },
        }),
      );

      let callCount = 0;
      gmail.users.messages.get = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            data: makeGmailMessage("msg-1", { internalDate: recentDate2 }),
          });
        }
        return Promise.resolve({
          data: makeGmailMessage("msg-2", { internalDate: recentDate1 }),
        });
      });

      const result = await sourceWithCutoff.sync(null);

      expect(result.documents).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    test("does not apply cutoff during incremental sync", async () => {
      const oldDate = "1577836800000"; // 2020-01-01
      const cutoff = "2023-01-01T00:00:00Z";

      const sourceWithCutoff = createGmailSource(gmail, {
        dataCutoff: cutoff,
      });

      gmail.users.history.list = vi.fn(() =>
        Promise.resolve({
          data: {
            history: [
              {
                messagesAdded: [{ message: { id: "old-msg" } }],
              },
            ],
            historyId: "history-3",
          },
        }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({
          data: makeGmailMessage("old-msg", { internalDate: oldDate }),
        }),
      );

      const cursor = { phase: "incremental", historyId: "history-1" };
      const result = await sourceWithCutoff.sync(cursor);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("old-msg");
    });

    test("drops pre-cutoff leaks but continues bootstrap (Gmail pushdown is per-day, leaks happen)", async () => {
      // Gmail's `after:YYYY/MM/DD` is per-day in the user's timezone, so a
      // UTC-midnight cutoff can leak a handful of boundary messages. We must
      // drop them but NOT halt the bootstrap — there's a year of post-cutoff
      // history beyond.
      const oldDate1 = "1577836800000"; // 2020-01-01 (leaked)
      const oldDate2 = "1546300800000"; // 2019-01-01 (leaked)
      const cutoff = "2023-01-01T00:00:00Z";

      const sourceWithCutoff = createGmailSource(gmail, {
        dataCutoff: cutoff,
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: {
            messages: [{ id: "old-1" }, { id: "old-2" }],
            nextPageToken: "page-2",
          },
        }),
      );

      let callCount = 0;
      gmail.users.messages.get = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            data: makeGmailMessage("old-1", { internalDate: oldDate1 }),
          });
        }
        return Promise.resolve({
          data: makeGmailMessage("old-2", { internalDate: oldDate2 }),
        });
      });

      const result = await sourceWithCutoff.sync(null);

      expect(result.documents).toHaveLength(0);
      expect(result.hasMore).toBe(true);
      const cursor = result.cursor as any;
      expect(cursor.phase).toBe("bootstrap");
      expect(cursor.pageToken).toBe("page-2");
    });

    test("works without cutoff (default behavior)", async () => {
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: {
            messages: [{ id: "msg-1" }],
            nextPageToken: "page-2",
          },
        }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({
          data: makeGmailMessage("msg-1", {
            internalDate: "1577836800000",
          }),
        }),
      );

      const result = await source.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(result.hasMore).toBe(true);
    });

    test("pushes cutoff into users.messages.list as `after:` (#203)", async () => {
      const cutoff = "2024-06-15T12:34:56Z";
      const sourceWithCutoff = createGmailSource(gmail, { dataCutoff: cutoff });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [], nextPageToken: undefined } }),
      );

      await sourceWithCutoff.sync(null);

      const listCall = (gmail.users.messages.list as any).mock.calls[0][0];
      expect(listCall.q).toContain("after:2024/06/15");
      expect(listCall.q).toContain("-in:spam -in:trash");
    });

    test("does not include `after:` when no cutoff is set", async () => {
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [], nextPageToken: undefined } }),
      );

      await source.sync(null);

      const listCall = (gmail.users.messages.list as any).mock.calls[0][0];
      expect(listCall.q).not.toContain("after:");
    });

    test("uses mailbox-wide messagesTotal as progress denominator even when cutoff is set", async () => {
      // Even with a cutoff, the progress bar uses the stable mailbox-wide
      // total (overcounts the pre-cutoff slice → bar plateaus short of 100%)
      // rather than Gmail's jittery per-query resultSizeEstimate.
      const cutoff = "2024-06-15T00:00:00Z";
      const sourceWithCutoff = createGmailSource(gmail, { dataCutoff: cutoff });

      gmail.users.getProfile = vi.fn(() =>
        Promise.resolve({
          data: {
            emailAddress: "test@example.com",
            messagesTotal: 50000,
            historyId: "history-1",
          },
        }),
      );
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: {
            messages: [{ id: "m" }],
            nextPageToken: "page-2",
            resultSizeEstimate: 4321, // ignored
          },
        }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({
          data: makeGmailMessage("m", { internalDate: "1719000000000" }),
        }),
      );

      const result = await sourceWithCutoff.sync(null);
      expect(result.progress?.total).toBe(50000);
    });

    test("does not terminate bootstrap on resultSizeEstimate when cutoff is set", async () => {
      // Regression: resultSizeEstimate is a best-effort estimate from Gmail
      // and routinely under-counts on the first page of an `after:` query.
      // Using it as a termination denominator (processedDocs >= total) ends
      // bootstrap after a handful of pages even though `nextPageToken` still
      // promises more matching messages. With pushdown, only `exhausted`
      // (no nextPageToken) should end bootstrap.
      const cutoff = "2025-05-07T00:00:00Z";
      const sourceWithCutoff = createGmailSource(gmail, { dataCutoff: cutoff });
      const postCutoffDate = "1746662400000"; // 2025-05-08, well past cutoff

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({
          data: {
            messages: [{ id: "m1" }, { id: "m2" }],
            nextPageToken: "page-2",
            resultSizeEstimate: 1, // wildly low — would have triggered early stop
          },
        }),
      );
      gmail.users.messages.get = vi.fn((req: any) =>
        Promise.resolve({
          data: makeGmailMessage(req.id, { internalDate: postCutoffDate }),
        }),
      );

      const result = await sourceWithCutoff.sync(null);

      expect(result.documents).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      const cursor = result.cursor as any;
      expect(cursor.phase).toBe("bootstrap");
      expect(cursor.pageToken).toBe("page-2");
    });
  });

  describe("attachment extraction", () => {
    const mockExtract = vi.fn(async (_data: Uint8Array, _mimeType: string) => ({
      text: "Extracted PDF text",
      pages: 2,
      truncated: false,
    }));

    function makeMessageWithAttachments(id: string) {
      return {
        id,
        threadId: `thread-${id}`,
        internalDate: "1704067200000",
        labelIds: ["INBOX"],
        payload: {
          headers: [
            { name: "Subject", value: "Email with attachments" },
            { name: "From", value: "sender@example.com" },
            { name: "To", value: "recipient@example.com" },
            { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
          ],
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "text/plain",
              body: {
                data: Buffer.from("Email body text").toString("base64url"),
              },
            },
            {
              filename: "report.pdf",
              mimeType: "application/pdf",
              body: {
                attachmentId: "att-1",
                size: 12345,
              },
            },
            {
              filename: "photo.jpg",
              mimeType: "image/jpeg",
              body: {
                attachmentId: "att-2",
                size: 54321,
              },
            },
          ],
        },
      };
    }

    test("finds attachment parts in MIME tree", () => {
      const msg = makeMessageWithAttachments("msg-1");
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });
      const parts = attSource.findAttachmentParts(msg.payload as any);
      expect(parts).toHaveLength(2);
      expect(parts[0].filename).toBe("report.pdf");
      expect(parts[0].mimeType).toBe("application/pdf");
      expect(parts[0].attachmentId).toBe("att-1");
      expect(parts[1].filename).toBe("photo.jpg");
    });

    test("#267 — dedupes duplicate MIME parts (calendar invite as text/calendar AND application/ics)", () => {
      // Reproduces Gmail's behaviour for calendar invites: the same byte
      // payload appears twice in the MIME tree with different attachmentIds
      // but identical filename + size. Pre-#267 the panel showed two rows;
      // the first matched our extractable types and got Indexed, the
      // second was Type-not-indexed.
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["text/calendar"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });
      const payload = {
        mimeType: "multipart/mixed",
        parts: [
          {
            filename: "invite.ics",
            mimeType: "text/calendar",
            body: { attachmentId: "att-cal", size: 695 },
          },
          {
            filename: "invite.ics",
            mimeType: "application/ics",
            body: { attachmentId: "att-octet", size: 695 },
          },
        ],
      };
      const parts = attSource.findAttachmentParts(payload as any);
      expect(parts).toHaveLength(1);
      expect(parts[0].mimeType).toBe("text/calendar"); // first occurrence wins
      expect(parts[0].attachmentId).toBe("att-cal");
    });

    test("#267 — does NOT dedupe genuine distinct attachments with the same filename but different size", () => {
      // Edge case: same filename, different bytes (different size) is
      // genuinely two different files — must NOT be dedup'd.
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });
      const payload = {
        mimeType: "multipart/mixed",
        parts: [
          {
            filename: "scan.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att-1", size: 1000 },
          },
          {
            filename: "scan.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att-2", size: 2000 },
          },
        ],
      };
      const parts = attSource.findAttachmentParts(payload as any);
      expect(parts).toHaveLength(2);
    });

    test("walkAttachmentParts surfaces null size when Gmail omits body.size", () => {
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });
      const payload = {
        mimeType: "multipart/mixed",
        parts: [
          {
            filename: "mystery.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att-mystery" /* size omitted */ },
          },
        ],
      };
      const parts = attSource.findAttachmentParts(payload as any);
      expect(parts).toHaveLength(1);
      expect(parts[0].size).toBeNull();
    });

    test("extracts PDF attachment and creates separate document", async () => {
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({ data: makeMessageWithAttachments("msg-1") }),
      );
      gmail.users.messages.attachments.get = vi.fn(() =>
        Promise.resolve({
          data: { data: Buffer.from("fake-pdf-data").toString("base64url") },
        }),
      );

      const result = await attSource.sync(null);

      // 1 email + 1 attachment (photo.jpg is type-excluded)
      expect(result.documents).toHaveLength(2);

      const emailDoc = result.documents[0];
      const attDoc = result.documents[1];

      // Email doc should have attachment markers
      expect(emailDoc.content).toContain("**Attachments:**");
      expect(emailDoc.content).toContain("report.pdf");
      expect(emailDoc.content).toContain("photo.jpg");

      // Email metadata should have attachments array
      const attachments = emailDoc.metadata.extra?.attachments as any[];
      expect(attachments).toHaveLength(2);
      expect(attachments[0]).toMatchObject({
        filename: "report.pdf",
        extracted: true,
      });
      expect(attachments[1]).toMatchObject({
        filename: "photo.jpg",
        extracted: false,
        reason: "type-excluded",
      });

      // Attachment document. externalId is the stable hash derived from
      // (filename, size, mimeType) — see #268 for why this isn't Gmail's
      // attachmentId. The makeMessageWithAttachments fixture uses
      // report.pdf @ 12345 bytes, application/pdf.
      expect(attDoc.externalId).toBe(
        `msg-1/att/${deriveAttachmentStableId("report.pdf", 12345, "application/pdf")}`,
      );
      expect(attDoc.title).toBe("report.pdf");
      expect(attDoc.content).toBe("Extracted PDF text");
      expect(attDoc.metadata.documentType).toBe("attachment");
      expect(attDoc.metadata.extra?.parentExternalId).toBe("msg-1");
      expect(attDoc.metadata.extra?.mimeType).toBe("application/pdf");
      expect(attDoc.metadata.people).toHaveLength(2); // inherited from parent
    });

    test("recovers a .pkpass delivered as application/octet-stream", async () => {
      // Gmail (and Outlook) routinely label a .pkpass attachment
      // application/octet-stream. The extension fallback must recover the real
      // type so the gate admits it and it extracts, rather than type-excluding.
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/vnd.apple.pkpass"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });

      const msg = {
        id: "msg-pkpass",
        threadId: "thread-pkpass",
        internalDate: "1704067200000",
        labelIds: ["INBOX"],
        payload: {
          headers: [
            { name: "Subject", value: "Ticket" },
            { name: "From", value: "sender@example.com" },
            { name: "To", value: "recipient@example.com" },
            { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
          ],
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: Buffer.from("body").toString("base64url") } },
            {
              filename: "boarding.pkpass",
              mimeType: "application/octet-stream",
              body: { attachmentId: "att-pk", size: 31270 },
            },
          ],
        },
      };

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-pkpass" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));
      gmail.users.messages.attachments.get = vi.fn(() =>
        Promise.resolve({ data: { data: Buffer.from("fake-pkpass-zip").toString("base64url") } }),
      );

      const result = await attSource.sync(null);

      // Email + the (now-extracted) attachment.
      expect(result.documents).toHaveLength(2);
      const emailDoc = result.documents[0];
      const attachments = emailDoc.metadata.extra?.attachments as any[];
      expect(attachments).toHaveLength(1);
      // Stored type is the RECOVERED one, and it extracted (not type-excluded).
      expect(attachments[0]).toMatchObject({
        filename: "boarding.pkpass",
        mimeType: "application/vnd.apple.pkpass",
        extracted: true,
      });
      const attDoc = result.documents[1];
      expect(attDoc.metadata.extra?.mimeType).toBe("application/vnd.apple.pkpass");
    });

    test("a transient non-OCR extraction failure fails the page instead of recording download-failed (#680)", async () => {
      // The injected attachment contract can still throw SyncError("transient")
      // for a non-OCR processor. The per-message catch must re-throw it so the
      // sync page fails and the cursor is not advanced — otherwise the
      // attachment is silently dropped and never retried (the same bug as
      // Drive #680, via the same shared contract).
      const transientExtract = vi.fn(async () => {
        throw new SyncError("transient", "attachment processor unavailable");
      });
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: transientExtract as any,
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({ data: makeMessageWithAttachments("msg-1") }),
      );
      gmail.users.messages.attachments.get = vi.fn(() =>
        Promise.resolve({
          data: { data: Buffer.from("fake-pdf-data").toString("base64url") },
        }),
      );

      await expect(attSource.sync(null)).rejects.toMatchObject({
        name: "SyncError",
        kind: "transient",
      });
    });

    test("skips attachments exceeding size limit", async () => {
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 1000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({ data: makeMessageWithAttachments("msg-1") }),
      );

      const result = await attSource.sync(null);

      // Only email doc (PDF is 12345 bytes, exceeds 1000 limit)
      expect(result.documents).toHaveLength(1);
      const attachments = result.documents[0].metadata.extra?.attachments as any[];
      expect(attachments[0]).toMatchObject({
        filename: "report.pdf",
        extracted: false,
        reason: "too-large",
      });
    });

    test("does not extract when extractAttachments is disabled", async () => {
      // Default config has extraction disabled
      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({ data: makeMessageWithAttachments("msg-1") }),
      );

      const result = await source.sync(null);

      // Only email doc, no attachments processed
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.extra?.attachments).toBeUndefined();
    });

    test("handles download failure gracefully", async () => {
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({ data: makeMessageWithAttachments("msg-1") }),
      );
      gmail.users.messages.attachments.get = vi.fn(() =>
        Promise.reject(new Error("Download failed")),
      );

      const result = await attSource.sync(null);

      expect(result.documents).toHaveLength(1);
      const attachments = result.documents[0].metadata.extra?.attachments as any[];
      expect(attachments[0]).toMatchObject({
        filename: "report.pdf",
        extracted: false,
        reason: "download-failed",
      });
    });

    test("handles extraction failure gracefully", async () => {
      const failingExtract = vi.fn(async () => null); // returns null = extraction failed

      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: failingExtract as any,
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({ data: makeMessageWithAttachments("msg-1") }),
      );
      gmail.users.messages.attachments.get = vi.fn(() =>
        Promise.resolve({
          data: { data: Buffer.from("encrypted-pdf").toString("base64url") },
        }),
      );

      const result = await attSource.sync(null);

      expect(result.documents).toHaveLength(1);
      const attachments = result.documents[0].metadata.extra?.attachments as any[];
      expect(attachments[0]).toMatchObject({
        filename: "report.pdf",
        extracted: false,
        reason: "extraction-failed",
      });
    });

    test("records successful OCR with no text without creating an attachment document", async () => {
      const noTextExtract = vi.fn(() =>
        Promise.resolve({ text: "", truncated: false, noText: true as const }),
      );
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["image/jpeg"],
          maxTextLength: 500_000,
        },
        extractAttachment: noTextExtract as any,
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-1" }] } }),
      );
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({ data: makeMessageWithAttachments("msg-1") }),
      );
      gmail.users.messages.attachments.get = vi.fn(() =>
        Promise.resolve({ data: { data: Buffer.from("image-data").toString("base64url") } }),
      );

      const result = await attSource.sync(null);

      expect(result.documents).toHaveLength(1);
      const attachments = result.documents[0].metadata.extra?.attachments as any[];
      expect(attachments).toContainEqual(
        expect.objectContaining({
          filename: "photo.jpg",
          extracted: false,
          reason: "no-text",
        }),
      );
    });

    test("partial failure mid-stream: 3 PDFs, second download fails", async () => {
      const msg = {
        id: "msg-3pdf",
        threadId: "thread-msg-3pdf",
        internalDate: "1704067200000",
        labelIds: ["INBOX"],
        payload: {
          headers: [
            { name: "Subject", value: "Three PDFs" },
            { name: "From", value: "sender@example.com" },
            { name: "To", value: "recipient@example.com" },
            { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
          ],
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from("See attached").toString("base64url") },
            },
            {
              filename: "first.pdf",
              mimeType: "application/pdf",
              body: { attachmentId: "att-a", size: 5000 },
            },
            {
              filename: "second.pdf",
              mimeType: "application/pdf",
              body: { attachmentId: "att-b", size: 6000 },
            },
            {
              filename: "third.pdf",
              mimeType: "application/pdf",
              body: { attachmentId: "att-c", size: 7000 },
            },
          ],
        },
      };

      const extractFn = vi.fn(async () => ({
        text: "PDF content",
        pages: 1,
        truncated: false,
      }));

      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: extractFn as any,
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-3pdf" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      let downloadCall = 0;
      gmail.users.messages.attachments.get = vi.fn(() => {
        downloadCall++;
        if (downloadCall === 2) {
          return Promise.reject(new Error("Network timeout"));
        }
        return Promise.resolve({
          data: { data: Buffer.from("fake-pdf").toString("base64url") },
        });
      });

      const result = await attSource.sync(null);

      // 1 email doc + 2 attachment docs (1st and 3rd succeeded)
      expect(result.documents).toHaveLength(3);
      expect(result.documents[1].externalId).toBe(
        `msg-3pdf/att/${deriveAttachmentStableId("first.pdf", 5000, "application/pdf")}`,
      );
      expect(result.documents[2].externalId).toBe(
        `msg-3pdf/att/${deriveAttachmentStableId("third.pdf", 7000, "application/pdf")}`,
      );

      // All 3 tracked in metadata
      const attachments = result.documents[0].metadata.extra?.attachments as any[];
      expect(attachments).toHaveLength(3);
      expect(attachments[0]).toMatchObject({ filename: "first.pdf", extracted: true });
      expect(attachments[1]).toMatchObject({
        filename: "second.pdf",
        extracted: false,
        reason: "download-failed",
      });
      expect(attachments[2]).toMatchObject({ filename: "third.pdf", extracted: true });
    });

    test("#268 — re-sync with rotated Gmail attachmentIds produces stable child externalIds", async () => {
      // Reproduces the production bug: Gmail mints fresh attachmentId values
      // on every messages.get, so the SAME attachment looks "new" each
      // re-sync. With the stable-hash fix the child externalId derives from
      // (filename, size, mimeType) instead, so re-syncs collapse via the
      // gateway's ON CONFLICT (provider_id, source_id, external_id) upsert.
      const makeMsgWithIds = (attId1: string, attId2: string) => ({
        id: "msg-resync",
        threadId: "thread-msg-resync",
        internalDate: "1704067200000",
        labelIds: ["INBOX"],
        payload: {
          headers: [
            { name: "Subject", value: "Resync test" },
            { name: "From", value: "sender@example.com" },
            { name: "To", value: "me@example.com" },
            { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
          ],
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: Buffer.from("body").toString("base64url") } },
            {
              filename: "report.pdf",
              mimeType: "application/pdf",
              body: { attachmentId: attId1, size: 4096 },
            },
            {
              filename: "invoice.pdf",
              mimeType: "application/pdf",
              body: { attachmentId: attId2, size: 8192 },
            },
          ],
        },
      });

      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: vi.fn(async () => ({
          text: "PDF content",
          pages: 1,
          truncated: false,
        })) as any,
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-resync" }] } }),
      );
      gmail.users.messages.attachments.get = vi.fn(() =>
        Promise.resolve({ data: { data: Buffer.from("fake-pdf").toString("base64url") } }),
      );

      // First sync — Gmail returns attachmentId values "ANGjdJ_first1" / "ANGjdJ_first2"
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({ data: makeMsgWithIds("ANGjdJ_first1", "ANGjdJ_first2") }),
      );
      const first = await attSource.sync(null);

      // Second sync — Gmail rotates the IDs but the attachments are byte-identical.
      gmail.users.messages.get = vi.fn(() =>
        Promise.resolve({ data: makeMsgWithIds("ANGjdJ_second1", "ANGjdJ_second2") }),
      );
      const second = await attSource.sync(null);

      // Both syncs produce the same set of child externalIds — the gateway's
      // upsert collapses them on (provider_id, source_id, external_id).
      const ids1 = first.documents
        .filter((d) => d.externalId.includes("/att/"))
        .map((d) => d.externalId)
        .sort();
      const ids2 = second.documents
        .filter((d) => d.externalId.includes("/att/"))
        .map((d) => d.externalId)
        .sort();
      expect(ids1).toHaveLength(2);
      expect(ids2).toHaveLength(2);
      expect(ids2).toEqual(ids1);
    });

    // Note: the seq-based externalId disambiguation in
    // `deriveAttachmentStableId` is unit-tested in
    // `packages/core/src/attachments.test.ts`. There's no Gmail-specific
    // integration test for it because the only way Gmail could surface two
    // attachments with the same (filename, size) is the duplicate-MIME-part
    // pattern (calendar invites), which `findAttachmentParts` now dedupes
    // upstream — see the #267 test above. iMessage and WhatsApp can still
    // legitimately emit collisions and rely on the seq mechanism.

    test("idempotence: calling fetchAndNormalize twice produces same output", async () => {
      const msg = makeGmailMessage("msg-idem", {
        internalDate: "1704067200000",
        subject: "Idempotent Email",
        from: "alice@example.com",
        to: "bob@example.com",
      });

      gmail.users.messages.list = vi.fn(() =>
        Promise.resolve({ data: { messages: [{ id: "msg-idem" }] } }),
      );
      gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: msg }));

      const result1 = await source.sync(null);
      const result2 = await source.sync(null);

      expect(result1.documents).toHaveLength(1);
      expect(result2.documents).toHaveLength(1);
      expect(result1.documents[0].externalId).toBe(result2.documents[0].externalId);
      expect(result1.documents[0].content).toBe(result2.documents[0].content);
      expect(result1.documents[0].contentHash).toBe(result2.documents[0].contentHash);
      expect(result1.documents[0].title).toBe(result2.documents[0].title);
    });

    test("inline image parts are not treated as attachments", () => {
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf", "image/jpeg"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });

      const payload = {
        mimeType: "multipart/related",
        parts: [
          {
            mimeType: "text/html",
            body: {
              data: Buffer.from('<img src="cid:inline-img">').toString("base64url"),
            },
          },
          {
            // Inline image: has no filename, just Content-ID
            mimeType: "image/jpeg",
            headers: [
              { name: "Content-Disposition", value: "inline" },
              { name: "Content-ID", value: "<inline-img>" },
            ],
            body: {
              // No attachmentId — inline images without filename are skipped
              size: 12345,
            },
          },
          {
            // Real attachment: has a filename and attachmentId
            filename: "photo.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att-real", size: 8000 },
          },
        ],
      };

      const parts = attSource.findAttachmentParts(payload as any);
      // Only the real attachment with filename + attachmentId should appear
      expect(parts).toHaveLength(1);
      expect(parts[0].filename).toBe("photo.pdf");
      expect(parts[0].attachmentId).toBe("att-real");
    });

    test("finds nested attachment parts in multipart/mixed > multipart/alternative", () => {
      const attSource = createGmailSource(gmail, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });

      const payload = {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: Buffer.from("body").toString("base64url") } },
              {
                mimeType: "text/html",
                body: { data: Buffer.from("<p>body</p>").toString("base64url") },
              },
            ],
          },
          {
            filename: "nested.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att-nested", size: 5000 },
          },
        ],
      };

      const parts = attSource.findAttachmentParts(payload as any);
      expect(parts).toHaveLength(1);
      expect(parts[0].filename).toBe("nested.pdf");
      expect(parts[0].attachmentId).toBe("att-nested");
    });
  });
});

describe("gmailMessageUrl (#463)", () => {
  test("pins to the account with ?authuser= when an email is given", () => {
    expect(gmailMessageUrl("abc123", "user@gmail.com")).toBe(
      "https://mail.google.com/mail/u/0/?authuser=user%40gmail.com#all/abc123",
    );
  });

  test("URL-encodes the account email", () => {
    expect(gmailMessageUrl("m1", "first.last+tag@example.com")).toBe(
      "https://mail.google.com/mail/u/0/?authuser=first.last%2Btag%40example.com#all/m1",
    );
  });

  test("omits authuser for a single-account / legacy source (unchanged URL)", () => {
    expect(gmailMessageUrl("abc123")).toBe("https://mail.google.com/mail/u/0/#all/abc123");
  });
});

describe("extractSchemaOrgDatesFromHtml (#1168 transactional date promotion)", () => {
  let gmail: ReturnType<typeof createMockGmail>;
  let source: GmailSource;
  beforeEach(() => {
    gmail = createMockGmail();
    source = createGmailSource(gmail);
  });

  const withJsonLd = (obj: unknown): string =>
    `<html><body><script type="application/ld+json">${JSON.stringify(
      obj,
    )}</script><p>details</p></body></html>`;

  test("promotes an Event startDate to scheduledAt", () => {
    const html = withJsonLd({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Team sync",
      startDate: "2026-08-15T09:30:00-04:00",
    });
    expect(extractSchemaOrgDatesFromHtml(html)).toEqual({
      scheduledAt: "2026-08-15T09:30:00-04:00",
    });
  });

  test("promotes a lodging checkinDate to scheduledAt", () => {
    const html = withJsonLd({
      "@type": "LodgingReservation",
      checkinDate: "2026-09-01",
      checkoutDate: "2026-09-04",
    });
    expect(extractSchemaOrgDatesFromHtml(html)).toEqual({ scheduledAt: "2026-09-01" });
  });

  test("promotes an invoice paymentDueDate to dueAt", () => {
    const html = withJsonLd({
      "@type": "Invoice",
      paymentDueDate: "2026-07-20",
      totalPaymentDue: { "@type": "PriceSpecification", price: "42.00" },
    });
    expect(extractSchemaOrgDatesFromHtml(html)).toEqual({ dueAt: "2026-07-20" });
  });

  test("descends into nested reservationFor and takes the earliest of each class", () => {
    const html = withJsonLd({
      "@type": "FlightReservation",
      reservationFor: [
        { "@type": "Flight", departureTime: "2026-10-05T18:00:00Z" },
        { "@type": "Flight", departureTime: "2026-10-02T06:00:00Z" },
      ],
    });
    expect(extractSchemaOrgDatesFromHtml(html)).toEqual({
      scheduledAt: "2026-10-02T06:00:00Z",
    });
  });

  test("skips a malformed JSON-LD block but still reads a valid sibling", () => {
    const html =
      `<script type="application/ld+json">{ not json }</script>` +
      withJsonLd({ "@type": "Event", startDate: "2026-08-15" });
    expect(extractSchemaOrgDatesFromHtml(html)).toEqual({ scheduledAt: "2026-08-15" });
  });

  test("returns {} when there is no schema.org markup", () => {
    expect(extractSchemaOrgDatesFromHtml("<html><body><p>just prose</p></body></html>")).toEqual(
      {},
    );
  });

  test("end-to-end: the promoted dates land in the email doc's metadata", async () => {
    const html = withJsonLd({
      "@type": "Event",
      name: "Appointment",
      startDate: "2026-08-15T09:30:00-04:00",
    });
    const payload = {
      headers: [
        { name: "Subject", value: "Appointment confirmed" },
        { name: "From", value: "no-reply@example.com" },
        { name: "Date", value: "Wed, 01 Jul 2026 10:00:00 GMT" },
      ],
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("Appointment confirmed").toString("base64url") },
        },
        { mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } },
      ],
    };
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "msg-sd" }], nextPageToken: undefined } }),
    );
    gmail.users.messages.get = vi.fn(() =>
      Promise.resolve({ data: makeGmailMessage("msg-sd", { payload }) }),
    );
    const result = await source.sync(null);
    expect(result.documents[0]!.metadata.scheduledAt).toBe("2026-08-15T09:30:00-04:00");
  });
});

describe("schema.org dates are reduced to the shape the metadata contract accepts", () => {
  const ld = (obj: unknown): string =>
    `<html><body><script type="application/ld+json">${JSON.stringify(obj)}</script></body></html>`;

  test("keeps an instant that carries a zone", () => {
    expect(
      extractSchemaOrgDatesFromHtml(
        ld({ "@type": "Reservation", startDate: "2026-08-14T19:00:00Z" }),
      ).scheduledAt,
    ).toBe("2026-08-14T19:00:00Z");
    expect(
      extractSchemaOrgDatesFromHtml(
        ld({ "@type": "Reservation", startDate: "2026-08-14T19:00:00+02:00" }),
      ).scheduledAt,
    ).toBe("2026-08-14T19:00:00+02:00");
  });

  test("keeps a bare calendar day", () => {
    expect(
      extractSchemaOrgDatesFromHtml(ld({ "@type": "Reservation", startDate: "2026-08-14" }))
        .scheduledAt,
    ).toBe("2026-08-14");
  });

  // schema.org's DateTime permits a local wall clock, and senders use it. It
  // names no instant, so the day is the most it establishes.
  test("reduces a zone-less wall clock to its day", () => {
    for (const value of ["2026-08-14T19:00", "2026-08-14T19:00:00", "2026-08-14T19:00:00.000"]) {
      expect(
        extractSchemaOrgDatesFromHtml(ld({ "@type": "Reservation", startDate: value })).scheduledAt,
      ).toBe("2026-08-14");
    }
  });

  test("leaves out a value that describes no date", () => {
    expect(
      extractSchemaOrgDatesFromHtml(ld({ "@type": "Reservation", startDate: "sometime in August" }))
        .scheduledAt,
    ).toBeUndefined();
    expect(
      extractSchemaOrgDatesFromHtml(ld({ "@type": "Reservation", startDate: "2026-02-30" }))
        .scheduledAt,
    ).toBeUndefined();
  });

  test("applies the same reduction to a deadline", () => {
    expect(
      extractSchemaOrgDatesFromHtml(ld({ "@type": "Invoice", paymentDueDate: "2026-09-01T17:30" }))
        .dueAt,
    ).toBe("2026-09-01");
  });
});

describe("GmailSource transport failures", () => {
  let gmail: ReturnType<typeof createMockGmail>;
  let source: GmailSource;

  beforeEach(() => {
    gmail = createMockGmail();
    source = createGmailSource(gmail);
  });

  /** The rejection a fetch produces when the server closes a pooled socket. */
  function socketClosed(): TypeError {
    return Object.assign(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      }),
      { config: { method: "get", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages" } },
    );
  }

  test("a bootstrap-page failure arrives typed, named and classified", async () => {
    // The bootstrap walk is the long one — a 150k-message mailbox lives here
    // for hours. An unclassified throw from it reaches the operator as a red
    // source reading `fetch failed`, with no way to tell a dropped socket
    // from a broken mailbox.
    gmail.users.messages.list = vi.fn(() => Promise.reject(socketClosed()));

    const thrown = await source.sync(null).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(SyncError);
    const err = thrown as SyncError;
    expect(err.kind).toBe("network");
    expect(err.message).toBe(
      "Google API request failed (GET /gmail/v1/users/me/messages): " +
        "fetch failed: other side closed",
    );
  });

  test("a per-message fetch failure inside the page is typed too", async () => {
    // The page fans out message fetches; a failure there never reached the
    // one mapper the file used to have.
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: "msg-1" }], nextPageToken: undefined } }),
    );
    gmail.users.messages.get = vi.fn(() => Promise.reject(socketClosed()));

    const thrown = await source.sync(null).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(SyncError);
    expect((thrown as SyncError).kind).toBe("network");
  });
});

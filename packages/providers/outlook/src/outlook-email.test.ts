// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, vi } from "vitest";
import { deriveAttachmentStableId } from "@omnesis/core";
import { SourceId, ProviderId, SyncError } from "@omnesis/types";
import { OutlookEmailSource } from "./outlook-email.js";
import {
  createMockGraph,
  createOutlookEmailSource,
  makeOutlookMessage,
  makeMailFolder,
} from "./testing/mock-outlook.js";

describe("OutlookEmailSource", () => {
  let graph: ReturnType<typeof createMockGraph>;
  let source: OutlookEmailSource;

  beforeEach(() => {
    graph = createMockGraph();
    source = createOutlookEmailSource(graph);
  });

  // ── ID tests ────────────────────────────────────────────────────

  test("sets correct id and providerId", () => {
    const p = new OutlookEmailSource(
      async () => "token",
      "outlook-email:user@outlook.com",
      "microsoft:user@outlook.com",
    );
    expect(p.id).toBe(SourceId("outlook-email:user@outlook.com"));
    expect(p.providerId).toBe(ProviderId("microsoft:user@outlook.com"));
  });

  test("has correct display properties", () => {
    expect(source.name).toBe("Outlook Email");
    expect(source.unitName).toBe("emails");
  });

  test("urlPatterns extract message ID from Outlook URLs", () => {
    const patterns = source.urlPatterns!.map((p) => new RegExp(p.regex));
    // Personal account URL
    const personal = "https://outlook.live.com/mail/0/id/AAMkADg3NTY";
    expect(personal.match(patterns[0])?.[1]).toBe("AAMkADg3NTY");
    // Office 365 URL
    const office365 = "https://outlook.office365.com/mail/inbox/id/AAMkABC123";
    expect(office365.match(patterns[1])?.[1]).toBe("AAMkABC123");
    // Office.com URL
    const office = "https://outlook.office.com/mail/sentitems/id/AAMkAXYZ";
    expect(office.match(patterns[2])?.[1]).toBe("AAMkAXYZ");
  });

  // ── Bootstrap sync ──────────────────────────────────────────────

  describe("bootstrap sync", () => {
    test("discovers folders and fetches first page", async () => {
      const folders = [
        makeMailFolder("folder-1", {
          displayName: "Inbox",
          wellKnownName: "inbox",
          totalItemCount: 2,
        }),
        makeMailFolder("folder-2", {
          displayName: "Sent",
          wellKnownName: "sentitems",
          totalItemCount: 1,
        }),
      ];
      const msg1 = makeOutlookMessage("msg-1");
      const msg2 = makeOutlookMessage("msg-2");

      let callCount = 0;
      graph.get = vi.fn((url: string) => {
        callCount++;
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        if (url.includes("folder-1") && url.includes("delta")) {
          return Promise.resolve({
            value: [msg1, msg2],
            "@odata.deltaLink": "delta-link-1",
          });
        }
        return Promise.resolve({ value: [] });
      });

      const result = await source.sync(null);

      expect(result.documents).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.documents[0].externalId).toBe("msg-1");
      expect(result.documents[1].externalId).toBe("msg-2");
    });

    test("paginates within a folder", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 3 })];
      const msg1 = makeOutlookMessage("msg-1");
      const msg2 = makeOutlookMessage("msg-2");

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        if (url.includes("delta") && !url.includes("page2")) {
          return Promise.resolve({
            value: [msg1],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/page2",
          });
        }
        if (url.includes("page2")) {
          return Promise.resolve({
            value: [msg2],
            "@odata.deltaLink": "delta-link-1",
          });
        }
        return Promise.resolve({ value: [] });
      });

      // First call — gets first page
      const result1 = await source.sync(null);
      expect(result1.documents).toHaveLength(1);
      expect(result1.hasMore).toBe(true);

      // Second call — gets second page, folder complete
      const result2 = await source.sync(result1.cursor);
      expect(result2.documents).toHaveLength(1);
      // No more folders, so bootstrap complete
      expect(result2.hasMore).toBe(false);
    });

    test("transitions between folders", async () => {
      const folders = [
        makeMailFolder("folder-1", { totalItemCount: 1 }),
        makeMailFolder("folder-2", { totalItemCount: 1 }),
      ];
      const msg1 = makeOutlookMessage("msg-1");
      const msg2 = makeOutlookMessage("msg-2");

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        if (url.includes("folder-1") && url.includes("delta")) {
          return Promise.resolve({
            value: [msg1],
            "@odata.deltaLink": "delta-link-1",
          });
        }
        if (url.includes("folder-2") && url.includes("delta")) {
          return Promise.resolve({
            value: [msg2],
            "@odata.deltaLink": "delta-link-2",
          });
        }
        return Promise.resolve({ value: [] });
      });

      // First call — folder-1
      const result1 = await source.sync(null);
      expect(result1.documents).toHaveLength(1);
      expect(result1.documents[0].externalId).toBe("msg-1");
      expect(result1.hasMore).toBe(true);

      // Second call — folder-2
      const result2 = await source.sync(result1.cursor);
      expect(result2.documents).toHaveLength(1);
      expect(result2.documents[0].externalId).toBe("msg-2");
      expect(result2.hasMore).toBe(false);
    });

    test("skips folders by ID resolved via well-known endpoints (no wellKnownName needed)", async () => {
      // Reproduces outlook-email-skip-folders-broken-v1-no-wellknownname:
      // Graph v1.0 doesn't return `wellKnownName` on the folder list response,
      // so the old name-based filter was dead code. Resolution must go through
      // the `/me/mailFolders/{alias}` endpoints — which return the folder
      // regardless of the user's locale.
      const folders = [
        // Mock now matches Graph v1 reality: wellKnownName is *absent* from
        // list responses. Display names are localized.
        makeMailFolder("folder-inbox", { displayName: "Inbox", totalItemCount: 1 }),
        makeMailFolder("folder-junk", { displayName: "Posta indesiderata", totalItemCount: 5 }),
        makeMailFolder("folder-deleted", { displayName: "Éléments supprimés", totalItemCount: 10 }),
      ];

      graph.get = vi.fn((url: string) => {
        if (url.endsWith("/me/mailFolders/deleteditems")) {
          return Promise.resolve(
            makeMailFolder("folder-deleted", { displayName: "Éléments supprimés" }),
          );
        }
        if (url.endsWith("/me/mailFolders/junkemail")) {
          return Promise.resolve(
            makeMailFolder("folder-junk", { displayName: "Posta indesiderata" }),
          );
        }
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        if (url.includes("folder-inbox") && url.includes("delta")) {
          return Promise.resolve({
            value: [makeOutlookMessage("msg-1")],
            "@odata.deltaLink": "delta-link-inbox",
          });
        }
        if (url.includes("folder-junk") || url.includes("folder-deleted")) {
          throw new Error("Should not fetch from skipped folders");
        }
        return Promise.resolve({ value: [] });
      });

      const result = await source.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.hasMore).toBe(false); // Only one folder kept, so bootstrap is done
    });

    test("missing well-known folder doesn't block sync (account has no Junk)", async () => {
      // Some accounts (e.g., shared mailboxes) legitimately lack one of the
      // well-known folders. Resolver failures should be ignored — the rest of
      // the skip set still applies and sync continues normally.
      graph.get = vi.fn((url: string) => {
        if (url.endsWith("/me/mailFolders/junkemail")) {
          return Promise.reject(new Error("Graph 404: folder not found"));
        }
        if (url.endsWith("/me/mailFolders/deleteditems")) {
          return Promise.resolve(makeMailFolder("folder-deleted"));
        }
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            value: [makeMailFolder("folder-inbox", { totalItemCount: 1 })],
          });
        }
        if (url.includes("folder-inbox") && url.includes("delta")) {
          return Promise.resolve({
            value: [makeOutlookMessage("msg-1")],
            "@odata.deltaLink": "delta-link-inbox",
          });
        }
        return Promise.resolve({ value: [] });
      });

      const result = await source.sync(null);
      expect(result.documents).toHaveLength(1);
    });

    test("bootstrap pass 1 excludes body from $select for throughput", async () => {
      // outlook-email-bootstrap-throughput-and-fragility: Microsoft Graph
      // caps page response by total payload bytes. Including `body` cuts
      // effective page size from ~100 to ~7. Bootstrap pass 1 must request
      // metadata only.
      const captured: string[] = [];
      graph.get = vi.fn((url: string) => {
        captured.push(url);
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: [makeMailFolder("folder-1", { totalItemCount: 1 })] });
        }
        if (url.includes("delta")) {
          return Promise.resolve({
            value: [],
            "@odata.deltaLink": "delta-link",
          });
        }
        return Promise.resolve({ value: [] });
      });
      await source.sync(null);
      const deltaUrl = captured.find((u) => u.includes("/messages/delta"))!;
      const selectClause = decodeURIComponent(deltaUrl.match(/\$select=([^&]+)/)![1]);
      const fields = selectClause.split(",");
      expect(fields).not.toContain("body");
      expect(fields).toContain("bodyPreview");
    });

    test("bootstrap queues message IDs for body backfill when body is omitted", async () => {
      // Build the message directly so msg.body is genuinely absent — going
      // through makeOutlookMessage with `body: undefined` would substitute
      // the default body via ??, defeating the test.
      const bodylessMsg = {
        id: "msg-1",
        subject: "Test",
        bodyPreview: "Preview only",
        from: { emailAddress: { name: "Sender", address: "sender@example.com" } },
        toRecipients: [],
        ccRecipients: [],
        bccRecipients: [],
        receivedDateTime: "2024-01-01T00:00:00Z",
        sentDateTime: "2024-01-01T00:00:00Z",
        lastModifiedDateTime: "2024-01-01T00:00:00Z",
        isDraft: false,
      };
      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: [makeMailFolder("folder-1", { totalItemCount: 1 })] });
        }
        if (url.includes("delta")) {
          return Promise.resolve({
            value: [bodylessMsg],
            "@odata.deltaLink": "delta-link",
          });
        }
        return Promise.resolve({ value: [] });
      });
      const result = await source.sync(null);
      const cursor = result.cursor as any;
      // After bootstrap pass 1 finishes its only folder, transition is to
      // body-backfill (not directly to incremental) so bodies get fetched.
      expect(cursor.phase).toBe("body-backfill");
      expect(cursor.backfillIds).toEqual(["msg-1"]);
      expect(result.hasMore).toBe(true);
    });

    test("body-backfill fetches each queued message and transitions to incremental", async () => {
      // Cursor already in body-backfill phase with IDs queued.
      const cursor: any = {
        phase: "body-backfill",
        folderDeltas: { "folder-1": { deltaLink: "delta-link" } },
        backfillIds: ["msg-1", "msg-2"],
        backfillIndex: 0,
      };
      const captured: string[] = [];
      graph.get = vi.fn((url: string) => {
        captured.push(url);
        const match = url.match(/\/me\/messages\/([^?]+)\?\$select=([^&]+)/);
        if (match) {
          const id = match[1];
          // Body-backfill must request the full select (body included).
          expect(decodeURIComponent(match[2])).toContain("body");
          return Promise.resolve(
            makeOutlookMessage(id, {
              body: { contentType: "text", content: `body for ${id}` },
            }),
          );
        }
        return Promise.resolve({ value: [] });
      });
      const result = await source.sync(cursor);
      const out = result.cursor as any;
      expect(out.phase).toBe("incremental");
      expect(result.documents.map((d) => d.externalId).sort()).toEqual(["msg-1", "msg-2"]);
      expect(result.documents[0].content).toContain("body for");
    });

    test("body-backfill batches across syncs (resumes via backfillIndex)", async () => {
      // Force a tiny enough queue that it spans multiple sync calls. We
      // simulate the cursor handing off between calls.
      const ids = Array.from({ length: 75 }, (_, i) => `msg-${i}`);
      const cursor: any = {
        phase: "body-backfill",
        folderDeltas: {},
        backfillIds: ids,
        backfillIndex: 0,
      };
      graph.get = vi.fn((url: string) => {
        const match = url.match(/\/me\/messages\/([^?]+)/);
        if (match) {
          return Promise.resolve(
            makeOutlookMessage(match[1], {
              body: { contentType: "text", content: "body" },
            }),
          );
        }
        return Promise.resolve({ value: [] });
      });

      const r1 = await source.sync(cursor);
      const c1 = r1.cursor as any;
      expect(c1.phase).toBe("body-backfill");
      expect(c1.backfillIndex).toBe(50); // BACKFILL_BATCH_SIZE
      expect(r1.hasMore).toBe(true);

      const r2 = await source.sync(c1);
      const c2 = r2.cursor as any;
      // 75 - 50 = 25 left, all consumed → transition to incremental.
      expect(c2.phase).toBe("incremental");
      expect(r2.hasMore).toBeFalsy();
    });

    test("rejects (cursor not advanced) when non-OCR extraction fails transiently", async () => {
      // A transient non-OCR processor blip during the body-backfill pass must
      // fail the page so it retries — not silently drop the message's
      // attachment and march the backfill index past it.
      const transientExtract = vi.fn(async () => {
        throw new SyncError("transient", "attachment processor unavailable");
      });
      const attSource = createOutlookEmailSource(graph, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: transientExtract as any,
      });
      graph.get = vi.fn((url: string) => {
        if (url.includes("/attachments")) {
          return Promise.resolve({
            value: [
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "att-1",
                name: "invoice.pdf",
                contentType: "application/pdf",
                size: 8000,
                contentBytes: Buffer.from("fake-pdf-data").toString("base64"),
              },
            ],
          });
        }
        const match = url.match(/\/me\/messages\/([^?]+)/);
        if (match) {
          return Promise.resolve(makeOutlookMessage(match[1], { hasAttachments: true }));
        }
        return Promise.resolve({ value: [] });
      });
      const cursor: any = {
        phase: "body-backfill",
        folderDeltas: {},
        backfillIds: ["msg-1"],
        backfillIndex: 0,
      };
      await expect(attSource.sync(cursor)).rejects.toBeInstanceOf(SyncError);
    });

    test("reports bootstrap progress", async () => {
      const folders = [
        makeMailFolder("folder-1", { totalItemCount: 50 }),
        makeMailFolder("folder-2", { totalItemCount: 30 }),
      ];

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        if (url.includes("folder-1") && url.includes("delta")) {
          return Promise.resolve({
            value: [makeOutlookMessage("msg-1"), makeOutlookMessage("msg-2")],
            "@odata.deltaLink": "delta-link-1",
          });
        }
        return Promise.resolve({
          value: [],
          "@odata.deltaLink": "delta-link-2",
        });
      });

      const result = await source.sync(null);
      expect(result.progress).toBeDefined();
      expect(result.progress!.phase).toBe("bootstrap");
      expect(result.progress!.total).toBe(80);
      expect(result.progress!.processed).toBe(2);
    });

    test("skips draft messages", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 2 })];

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        if (url.includes("delta")) {
          return Promise.resolve({
            value: [
              makeOutlookMessage("msg-1"),
              makeOutlookMessage("msg-draft", { isDraft: true }),
            ],
            "@odata.deltaLink": "delta-link",
          });
        }
        return Promise.resolve({ value: [] });
      });

      const result = await source.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("msg-1");
    });

    test("handles child folders", async () => {
      const folders = [makeMailFolder("folder-parent", { totalItemCount: 0, childFolderCount: 1 })];
      const childFolders = [makeMailFolder("folder-child", { totalItemCount: 1 })];

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?") && !url.includes("childFolders")) {
          return Promise.resolve({ value: folders });
        }
        if (url.includes("childFolders")) {
          return Promise.resolve({ value: childFolders });
        }
        if (url.includes("folder-parent") && url.includes("delta")) {
          return Promise.resolve({
            value: [],
            "@odata.deltaLink": "delta-parent",
          });
        }
        if (url.includes("folder-child") && url.includes("delta")) {
          return Promise.resolve({
            value: [makeOutlookMessage("msg-child")],
            "@odata.deltaLink": "delta-child",
          });
        }
        return Promise.resolve({ value: [] });
      });

      // First sync call — folder-parent (empty)
      const result1 = await source.sync(null);
      expect(result1.hasMore).toBe(true);

      // Second sync call — folder-child
      const result2 = await source.sync(result1.cursor);
      expect(result2.documents).toHaveLength(1);
      expect(result2.documents[0].externalId).toBe("msg-child");
      expect(result2.hasMore).toBe(false);
    });

    test("skips @removed tombstones in bootstrap delta response", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 2 })];

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        if (url.includes("delta")) {
          return Promise.resolve({
            value: [
              makeOutlookMessage("msg-tombstone", { removed: true }),
              makeOutlookMessage("msg-real"),
            ],
            "@odata.deltaLink": "delta-link",
          });
        }
        return Promise.resolve({ value: [] });
      });

      const result = await source.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("msg-real");
    });

    test("handles message with missing body field (delta partial update)", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 1 })];
      const partial = makeOutlookMessage("msg-partial");
      delete (partial as any).body;

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [partial],
          "@odata.deltaLink": "delta",
        });
      });

      const result = await source.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("msg-partial");
    });

    test("skips messages with missing receivedDateTime (delta partial update)", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 2 })];
      const partial = makeOutlookMessage("msg-no-date");
      delete (partial as any).receivedDateTime;

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [partial, makeOutlookMessage("msg-real")],
          "@odata.deltaLink": "delta",
        });
      });

      const result = await source.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("msg-real");
    });
  });

  // ── Incremental sync ────────────────────────────────────────────

  describe("incremental sync", () => {
    function makeIncrementalCursor(folderDeltas: Record<string, { deltaLink: string }>): any {
      return {
        phase: "incremental",
        folderDeltas,
      };
    }

    test("fetches delta changes from all folders (yielding between folders)", async () => {
      // Incremental sync now drains one folder's delta page-chain per
      // `sync()` call and yields with `hasMore: true` while folders remain.
      // This lets the engine checkpoint, honour cancellation, and round-
      // robin with other sources between folders. Drain to completion to
      // assert the cumulative result matches the pre-yield contract.
      const cursor = makeIncrementalCursor({
        "folder-1": { deltaLink: "https://graph.microsoft.com/delta-1" },
        "folder-2": { deltaLink: "https://graph.microsoft.com/delta-2" },
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            value: [makeMailFolder("folder-1"), makeMailFolder("folder-2")],
          });
        }
        if (url.includes("delta-1")) {
          return Promise.resolve({
            value: [makeOutlookMessage("msg-new")],
            "@odata.deltaLink": "https://graph.microsoft.com/delta-1-updated",
          });
        }
        if (url.includes("delta-2")) {
          return Promise.resolve({
            value: [],
            "@odata.deltaLink": "https://graph.microsoft.com/delta-2-updated",
          });
        }
        return Promise.resolve({ value: [] });
      });

      const allDocs: any[] = [];
      let next: any = cursor;
      let calls = 0;
      while (true) {
        const result = await source.sync(next);
        calls++;
        allDocs.push(...result.documents);
        next = result.cursor;
        if (!result.hasMore) break;
        if (calls > 10) throw new Error("incremental drain did not terminate");
      }
      expect(allDocs).toHaveLength(1);
      expect(allDocs[0].externalId).toBe("msg-new");
      // Two folders → at minimum two calls (one per folder) plus the
      // terminal "no folders left" call. Either way the loop above
      // exits via hasMore=false.
      expect(calls).toBeGreaterThanOrEqual(2);
    });

    test("yields hasMore=true while folders remain in the cycle", async () => {
      const cursor = makeIncrementalCursor({
        "folder-1": { deltaLink: "https://graph.microsoft.com/delta-1" },
        "folder-2": { deltaLink: "https://graph.microsoft.com/delta-2" },
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            value: [makeMailFolder("folder-1"), makeMailFolder("folder-2")],
          });
        }
        if (url.includes("delta-1")) {
          return Promise.resolve({
            value: [makeOutlookMessage("msg-1")],
            "@odata.deltaLink": "https://graph.microsoft.com/delta-1-updated",
          });
        }
        if (url.includes("delta-2")) {
          return Promise.resolve({
            value: [makeOutlookMessage("msg-2")],
            "@odata.deltaLink": "https://graph.microsoft.com/delta-2-updated",
          });
        }
        return Promise.resolve({ value: [] });
      });

      const first = await source.sync(cursor);
      expect(first.hasMore).toBe(true);
      expect(first.documents).toHaveLength(1);
      // First folder produced one doc; the cursor carries the queue.
      expect((first.cursor as any).pendingIncrementalFolderIds).toEqual(["folder-2"]);

      const second = await source.sync(first.cursor);
      expect(second.hasMore).toBe(false);
      expect(second.documents).toHaveLength(1);
    });

    test("handles deleted messages via @removed", async () => {
      const cursor = makeIncrementalCursor({
        "folder-1": { deltaLink: "https://graph.microsoft.com/delta-1" },
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            value: [makeMailFolder("folder-1")],
          });
        }
        if (url.includes("delta-1")) {
          return Promise.resolve({
            value: [
              makeOutlookMessage("msg-deleted", { removed: true }),
              makeOutlookMessage("msg-updated"),
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/delta-1-updated",
          });
        }
        return Promise.resolve({ value: [] });
      });

      const result = await source.sync(cursor);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("msg-updated");
      expect(result.deletedExternalIds).toContain("msg-deleted");
    });

    test("an auth failure escapes as a connection-scoped SyncError", async () => {
      // Calendar and OneDrive read through the same account token, so a dead
      // credential surfacing here is not a fact about this one folder.
      const { AuthError } = await import("./graph-client.js");
      const cursor = makeIncrementalCursor({
        "folder-1": { deltaLink: "https://graph.microsoft.com/delta-1" },
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: [makeMailFolder("folder-1")] });
        }
        return Promise.reject(new AuthError("token revoked"));
      });

      const error = await source.sync(cursor).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(SyncError);
      expect((error as SyncError).kind).toBe("auth");
      expect((error as SyncError).scope).toBe("connection");
      expect((error as SyncError).cause).toBeInstanceOf(AuthError);
    });

    test("handles 410 Gone by re-bootstrapping affected folder", async () => {
      const { DeltaExpiredError } = await import("./graph-client.js");
      const cursor = makeIncrementalCursor({
        "folder-1": { deltaLink: "https://graph.microsoft.com/delta-expired" },
        "folder-2": { deltaLink: "https://graph.microsoft.com/delta-2" },
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            value: [makeMailFolder("folder-1"), makeMailFolder("folder-2")],
          });
        }
        if (url.includes("delta-expired")) {
          return Promise.reject(new DeltaExpiredError());
        }
        if (url.includes("delta-2")) {
          return Promise.resolve({
            value: [],
            "@odata.deltaLink": "https://graph.microsoft.com/delta-2-updated",
          });
        }
        return Promise.resolve({ value: [] });
      });

      const result = await source.sync(cursor);
      // Should switch to bootstrap phase
      expect((result.cursor as any).phase).toBe("bootstrap");
      // folder-1's delta should be removed, folder-2's preserved
      expect((result.cursor as any).folderDeltas["folder-1"]).toBeUndefined();
      // folder-2 was not processed yet when error happened, its delta remains
      expect((result.cursor as any).folderDeltas["folder-2"]).toBeDefined();
    });

    test("backfills body via per-message GET when delta returns bodyless message", async () => {
      // outlook-email-incremental-bodyless-delta: Microsoft Graph bakes the
      // bootstrap-era $select into $deltatoken and silently ignores any
      // $select on subsequent delta follow-ups. So delta responses arrive
      // without `body` even when our URL asked for it. Incremental must
      // fall back to a per-message GET to populate the body.
      const cursor = makeIncrementalCursor({
        "folder-1": { deltaLink: "https://graph.microsoft.com/delta-1" },
      });

      // Strip body to mimic a real Graph delta response under the
      // bodyless deltatoken.
      const bodyless = makeOutlookMessage("msg-new");
      delete (bodyless as any).body;

      const calledUrls: string[] = [];
      graph.get = vi.fn((url: string) => {
        calledUrls.push(url);
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: [makeMailFolder("folder-1")] });
        }
        if (url.includes("delta-1")) {
          return Promise.resolve({
            value: [bodyless],
            "@odata.deltaLink": "https://graph.microsoft.com/delta-1-updated",
          });
        }
        if (url.match(/\/me\/messages\/msg-new\?\$select=/)) {
          // Per-message GET must request body.
          expect(decodeURIComponent(url)).toContain("body");
          return Promise.resolve(
            makeOutlookMessage("msg-new", {
              body: { contentType: "text", content: "Backfilled body content" },
            }),
          );
        }
        return Promise.resolve({ value: [] });
      });

      const result = await source.sync(cursor);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("msg-new");
      expect(result.documents[0].content).toContain("Backfilled body content");
      // Sanity: per-message GET was actually issued.
      expect(calledUrls.some((u) => u.includes("/me/messages/msg-new"))).toBe(true);
    });

    test("does not refetch body when delta entry already includes body", async () => {
      // Skip the per-message GET when delta does happen to include body —
      // either because the deltatoken's session already had body in $select,
      // or because Graph returned it for some other reason. Refetching wastes
      // quota.
      const cursor = makeIncrementalCursor({
        "folder-1": { deltaLink: "https://graph.microsoft.com/delta-1" },
      });

      const calledUrls: string[] = [];
      graph.get = vi.fn((url: string) => {
        calledUrls.push(url);
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: [makeMailFolder("folder-1")] });
        }
        if (url.includes("delta-1")) {
          return Promise.resolve({
            value: [
              makeOutlookMessage("msg-with-body", {
                body: { contentType: "text", content: "Body in delta" },
              }),
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/delta-1-updated",
          });
        }
        return Promise.resolve({ value: [] });
      });

      const result = await source.sync(cursor);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].content).toContain("Body in delta");
      expect(calledUrls.some((u) => u.match(/\/me\/messages\/msg-with-body\?/))).toBe(false);
    });

    test("emits bodyless doc if per-message backfill GET fails (network error)", async () => {
      // Don't drop the doc just because body backfill failed — emit it with
      // headers so the user still sees the email; next delta cycle gets
      // another shot.
      const cursor = makeIncrementalCursor({
        "folder-1": { deltaLink: "https://graph.microsoft.com/delta-1" },
      });
      const bodyless = makeOutlookMessage("msg-new");
      delete (bodyless as any).body;

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: [makeMailFolder("folder-1")] });
        }
        if (url.includes("delta-1")) {
          return Promise.resolve({
            value: [bodyless],
            "@odata.deltaLink": "https://graph.microsoft.com/delta-1-updated",
          });
        }
        if (url.includes("/me/messages/msg-new")) {
          return Promise.reject(new Error("Graph 503: temporary failure"));
        }
        return Promise.resolve({ value: [] });
      });

      const result = await source.sync(cursor);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("msg-new");
    });

    test("detects new folders and triggers re-bootstrap", async () => {
      const cursor = makeIncrementalCursor({
        "folder-1": { deltaLink: "https://graph.microsoft.com/delta-1" },
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            value: [
              makeMailFolder("folder-1"),
              makeMailFolder("folder-new", { displayName: "New Folder" }),
            ],
          });
        }
        return Promise.resolve({ value: [] });
      });

      const result = await source.sync(cursor);
      expect((result.cursor as any).phase).toBe("bootstrap");
    });
  });

  // ── Document normalization ──────────────────────────────────────

  describe("document normalization", () => {
    test("normalizes message with text body", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 1 })];
      const msg = makeOutlookMessage("msg-1", {
        subject: "Hello World",
        from: { name: "Alice", address: "alice@example.com" },
        toRecipients: [{ name: "Bob", address: "bob@example.com" }],
        body: { contentType: "text", content: "Plain text body" },
        receivedDateTime: "2024-06-15T10:30:00Z",
        webLink: "https://outlook.live.com/mail/0/id/msg-1",
        categories: ["Work"],
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [msg],
          "@odata.deltaLink": "delta",
        });
      });

      const result = await source.sync(null);
      const doc = result.documents[0];

      expect(doc.title).toBe("Hello World");
      expect(doc.content).toContain("# Hello World");
      expect(doc.content).toContain("**From:** Alice <alice@example.com>");
      expect(doc.content).toContain("**To:** Bob <bob@example.com>");
      expect(doc.content).toContain("Plain text body");
      expect(doc.metadata.documentType).toBe("email");
      expect(doc.metadata.sourceUrl).toBe("https://outlook.live.com/mail/0/id/msg-1");
      // No appUrl. Verified on a device: `ms-outlook://` is registered, so iOS
      // hands the URL to Outlook and Outlook opens — on the inbox, whatever
      // path or query the URL carried. An appUrl would therefore trade "the
      // message you tapped, in a browser" for "the app, showing something
      // else". iOS falls back to `sourceUrl` when it is absent, the same way it
      // does for Gmail's compose-only scheme.
      expect(doc.metadata.appUrl).toBeUndefined();
      expect(doc.metadata.tags).toEqual(["Work"]);
      expect(doc.metadata.extra?.threadId).toBe(doc.metadata.extra?.conversationId);
      expect(doc.metadata.extra?.threadId).toBeDefined();
      expect(doc.sourceCreatedAt).toBe("2024-06-15T10:30:00Z");
    });

    test("converts HTML body to markdown", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 1 })];
      const msg = makeOutlookMessage("msg-html", {
        body: {
          contentType: "html",
          content: "<h1>Title</h1><p>Paragraph with <strong>bold</strong> text.</p>",
        },
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [msg],
          "@odata.deltaLink": "delta",
        });
      });

      const result = await source.sync(null);
      const doc = result.documents[0];

      // Turndown should convert HTML to markdown
      expect(doc.content).toContain("Title");
      expect(doc.content).toContain("**bold**");
      expect(doc.content).not.toContain("<h1>");
      expect(doc.content).not.toContain("<strong>");
    });

    test("includes extra metadata fields", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 1 })];
      const msg = makeOutlookMessage("msg-1", {
        conversationId: "conv-123",
        internetMessageId: "<msg@example.com>",
        importance: "high",
        isRead: true,
        hasAttachments: true,
        flag: { flagStatus: "flagged" },
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [msg],
          "@odata.deltaLink": "delta",
        });
      });

      const result = await source.sync(null);
      const extra = result.documents[0].metadata.extra!;

      expect(extra.conversationId).toBe("conv-123");
      expect(extra.internetMessageId).toBe("<msg@example.com>");
      expect(extra.importance).toBe("high");
      expect(extra.isRead).toBe(true);
      expect(extra.hasAttachments).toBe(true);
      expect(extra.flagStatus).toBe("flagged");
    });

    test("handles missing subject", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 1 })];
      const msg = makeOutlookMessage("msg-no-subject", { subject: "" });
      // Clear subject to empty
      msg.subject = "";

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [msg],
          "@odata.deltaLink": "delta",
        });
      });

      const result = await source.sync(null);
      expect(result.documents[0].title).toBe("(no subject)");
    });
  });

  // ── People extraction ───────────────────────────────────────────

  describe("people extraction", () => {
    test("extracts sender and recipients", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 1 })];
      const msg = makeOutlookMessage("msg-1", {
        from: { name: "Alice Smith", address: "alice@example.com" },
        toRecipients: [{ name: "Bob Jones", address: "bob@example.com" }],
        ccRecipients: [{ name: "Charlie", address: "charlie@example.com" }],
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [msg],
          "@odata.deltaLink": "delta",
        });
      });

      const result = await source.sync(null);
      const people = result.documents[0].metadata.people!;

      expect(people).toHaveLength(3);

      const sender = people.find((p) => p.role === "sender");
      expect(sender).toBeDefined();
      expect(sender!.name).toBe("Alice Smith");
      expect(sender!.emails).toEqual(["alice@example.com"]);

      const recipients = people.filter((p) => p.role === "recipient");
      expect(recipients).toHaveLength(2);
      expect(recipients.map((r) => r.emails![0])).toContain("bob@example.com");
      expect(recipients.map((r) => r.emails![0])).toContain("charlie@example.com");
    });

    test("deduplicates people by email", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 1 })];
      const msg = makeOutlookMessage("msg-1", {
        from: { name: "Alice", address: "alice@example.com" },
        toRecipients: [
          { name: "Alice Smith", address: "alice@example.com" }, // Same as sender
          { name: "Bob", address: "bob@example.com" },
        ],
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [msg],
          "@odata.deltaLink": "delta",
        });
      });

      const result = await source.sync(null);
      const people = result.documents[0].metadata.people!;

      // Alice should only appear once (as sender)
      const aliceMentions = people.filter((p) => p.emails?.includes("alice@example.com"));
      expect(aliceMentions).toHaveLength(1);
      expect(aliceMentions[0].role).toBe("sender");
    });

    test("extracts emails and phones from body text", async () => {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 1 })];
      const msg = makeOutlookMessage("msg-1", {
        from: { name: "Alice", address: "alice@example.com" },
        toRecipients: [],
        body: {
          contentType: "text",
          content: "Contact dave@example.com or call +1 (555) 123-4567 for info.",
        },
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [msg],
          "@odata.deltaLink": "delta",
        });
      });

      const result = await source.sync(null);
      const people = result.documents[0].metadata.people!;

      // Should have sender + mentioned email + mentioned phone
      const mentioned = people.filter((p) => p.role === "mentioned");
      expect(mentioned.length).toBeGreaterThanOrEqual(1);

      const emailMention = mentioned.find((p) => p.emails?.includes("dave@example.com"));
      expect(emailMention).toBeDefined();
    });
  });

  // ── Relevance score ─────────────────────────────────────────────

  describe("relevance score", () => {
    function syncSingleMessage(msg: any): Promise<any> {
      const folders = [makeMailFolder("folder-1", { totalItemCount: 1 })];
      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [msg],
          "@odata.deltaLink": "delta",
        });
      });
      return source.sync(null);
    }

    test("base score is 0.5", async () => {
      const result = await syncSingleMessage(makeOutlookMessage("msg-1"));
      expect(result.documents[0].metadata.relevanceScore).toBe(0.5);
    });

    test("high importance boosts score", async () => {
      const result = await syncSingleMessage(makeOutlookMessage("msg-1", { importance: "high" }));
      expect(result.documents[0].metadata.relevanceScore).toBe(0.65);
    });

    test("flagged boosts score", async () => {
      const result = await syncSingleMessage(
        makeOutlookMessage("msg-1", { flag: { flagStatus: "flagged" } }),
      );
      expect(result.documents[0].metadata.relevanceScore).toBe(0.65);
    });

    test("categories boost score", async () => {
      const result = await syncSingleMessage(
        makeOutlookMessage("msg-1", { categories: ["Project Alpha"] }),
      );
      expect(result.documents[0].metadata.relevanceScore).toBe(0.6);
    });

    test("multiple signals stack", async () => {
      const result = await syncSingleMessage(
        makeOutlookMessage("msg-1", {
          importance: "high",
          flag: { flagStatus: "flagged" },
          categories: ["Important"],
        }),
      );
      expect(result.documents[0].metadata.relevanceScore).toBe(0.9);
    });
  });

  // ── Data cutoff ─────────────────────────────────────────────────

  describe("data cutoff", () => {
    test("filters old emails during bootstrap", async () => {
      const cutoffSource = createOutlookEmailSource(graph, {
        dataCutoff: "2024-06-01T00:00:00Z",
      });

      const folders = [makeMailFolder("folder-1", { totalItemCount: 3 })];
      const oldMsg = makeOutlookMessage("msg-old", {
        receivedDateTime: "2024-01-01T00:00:00Z",
      });
      const newMsg = makeOutlookMessage("msg-new", {
        receivedDateTime: "2024-07-01T00:00:00Z",
      });

      graph.get = vi.fn((url: string) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [newMsg, oldMsg],
          "@odata.deltaLink": "delta",
        });
      });

      const result = await cutoffSource.sync(null);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("msg-new");
    });

    test("includes $filter in delta URL when dataCutoff set", async () => {
      const cutoffSource = createOutlookEmailSource(graph, {
        dataCutoff: "2024-06-01T00:00:00.000Z",
      });

      const folders = [makeMailFolder("folder-1", { totalItemCount: 1 })];
      const calledUrls: string[] = [];

      graph.get = vi.fn((url: string) => {
        calledUrls.push(url);
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({ value: folders });
        }
        return Promise.resolve({
          value: [makeOutlookMessage("msg-1", { receivedDateTime: "2024-07-01T00:00:00Z" })],
          "@odata.deltaLink": "delta",
        });
      });

      await cutoffSource.sync(null);

      const deltaUrl = calledUrls.find((u) => u.includes("delta"));
      expect(deltaUrl).toBeDefined();
      expect(deltaUrl).toContain("$filter=receivedDateTime");
    });
  });

  describe("attachment extraction", () => {
    const mockExtract = vi.fn(async (_data: Uint8Array, _mimeType: string) => ({
      text: "Extracted PDF text from Outlook",
      pages: 3,
      truncated: false,
    }));

    function setupGraphWithAttachments() {
      const g = createMockGraph();
      const calledUrls: string[] = [];

      g.get = vi.fn((url: string) => {
        calledUrls.push(url);

        if (url.includes("/mailFolders?")) {
          return Promise.resolve({
            value: [makeMailFolder("folder-1", { totalItemCount: 1 })],
          });
        }

        if (url.includes("/childFolders")) {
          return Promise.resolve({ value: [] });
        }

        if (url.includes("/messages/delta")) {
          return Promise.resolve({
            value: [
              makeOutlookMessage("msg-1", {
                hasAttachments: true,
              }),
            ],
            "@odata.deltaLink": "delta-link",
          });
        }

        if (url.includes("/attachments")) {
          return Promise.resolve({
            value: [
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "att-1",
                name: "invoice.pdf",
                contentType: "application/pdf",
                size: 8000,
                contentBytes: Buffer.from("fake-pdf-data").toString("base64"),
              },
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "att-2",
                name: "image.png",
                contentType: "image/png",
                size: 3000,
                contentBytes: Buffer.from("fake-image").toString("base64"),
              },
              {
                "@odata.type": "#microsoft.graph.itemAttachment",
                id: "att-3",
                name: "embedded.msg",
                contentType: "message/rfc822",
                size: 5000,
              },
            ],
          });
        }

        return Promise.resolve({ value: [] });
      });

      return { graph: g, calledUrls };
    }

    test("extracts PDF and skips non-PDF attachments", async () => {
      const { graph: g } = setupGraphWithAttachments();
      const attSource = createOutlookEmailSource(g, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });

      const result = await attSource.sync(null);

      // 1 email + 1 PDF attachment (image.png excluded, itemAttachment filtered out)
      expect(result.documents).toHaveLength(2);

      const emailDoc = result.documents[0];
      const attDoc = result.documents[1];

      // Email doc should have attachment info
      expect(emailDoc.content).toContain("**Attachments:**");
      expect(emailDoc.content).toContain("invoice.pdf");
      expect(emailDoc.content).toContain("image.png");

      const attachments = emailDoc.metadata.extra?.attachments as any[];
      expect(attachments).toHaveLength(2); // only file attachments
      expect(attachments[0]).toMatchObject({ filename: "invoice.pdf", extracted: true });
      expect(attachments[1]).toMatchObject({
        filename: "image.png",
        extracted: false,
        reason: "type-excluded",
      });

      // Attachment doc — externalId is the stable hash from (filename, size,
      // mimeType); see `deriveAttachmentStableId` for why we don't use Outlook's att-1.
      expect(attDoc.externalId).toBe(
        `msg-1/att/${deriveAttachmentStableId("invoice.pdf", 8000, "application/pdf")}`,
      );
      expect(attDoc.title).toBe("invoice.pdf");
      expect(attDoc.content).toBe("Extracted PDF text from Outlook");
      expect(attDoc.metadata.documentType).toBe("attachment");
      expect(attDoc.metadata.extra?.parentExternalId).toBe("msg-1");
    });

    test("does not extract when disabled", async () => {
      const { graph: g } = setupGraphWithAttachments();
      const noAttSource = createOutlookEmailSource(g);

      const result = await noAttSource.sync(null);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.extra?.attachments).toBeUndefined();
    });

    test("multiple PDF attachments extracted, DOCX skipped", async () => {
      const g = createMockGraph();
      g.get = vi.fn((url: string) => {
        if (url.includes("/mailFolders?")) {
          return Promise.resolve({
            value: [makeMailFolder("folder-1", { totalItemCount: 1 })],
          });
        }
        if (url.includes("/childFolders")) {
          return Promise.resolve({ value: [] });
        }
        if (url.includes("/messages/delta")) {
          return Promise.resolve({
            value: [makeOutlookMessage("msg-multi", { hasAttachments: true })],
            "@odata.deltaLink": "delta-link",
          });
        }
        if (url.includes("/attachments")) {
          return Promise.resolve({
            value: [
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "att-pdf-1",
                name: "report.pdf",
                contentType: "application/pdf",
                size: 5000,
                contentBytes: Buffer.from("pdf-1-data").toString("base64"),
              },
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "att-pdf-2",
                name: "invoice.pdf",
                contentType: "application/pdf",
                size: 7000,
                contentBytes: Buffer.from("pdf-2-data").toString("base64"),
              },
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "att-docx",
                name: "notes.docx",
                contentType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                size: 4000,
                contentBytes: Buffer.from("docx-data").toString("base64"),
              },
            ],
          });
        }
        return Promise.resolve({ value: [] });
      });

      const attSource = createOutlookEmailSource(g, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });

      const result = await attSource.sync(null);

      // 1 email + 2 PDF attachment docs
      expect(result.documents).toHaveLength(3);

      const emailDoc = result.documents[0];
      const attDoc1 = result.documents[1];
      const attDoc2 = result.documents[2];

      // Attachment metadata tracks all 3
      const attachments = emailDoc.metadata.extra?.attachments as any[];
      expect(attachments).toHaveLength(3);
      expect(attachments[0]).toMatchObject({ filename: "report.pdf", extracted: true });
      expect(attachments[1]).toMatchObject({ filename: "invoice.pdf", extracted: true });
      expect(attachments[2]).toMatchObject({
        filename: "notes.docx",
        extracted: false,
        reason: "type-excluded",
      });

      // Both PDF attachment docs created — stable hash IDs
      expect(attDoc1.externalId).toBe(
        `msg-multi/att/${deriveAttachmentStableId("report.pdf", 5000, "application/pdf")}`,
      );
      expect(attDoc1.title).toBe("report.pdf");
      expect(attDoc1.metadata.documentType).toBe("attachment");
      expect(attDoc2.externalId).toBe(
        `msg-multi/att/${deriveAttachmentStableId("invoice.pdf", 7000, "application/pdf")}`,
      );
      expect(attDoc2.title).toBe("invoice.pdf");
    });

    test("partial extraction failure: one PDF succeeds, another returns null", async () => {
      const g = createMockGraph();
      g.get = vi.fn((url: string) => {
        if (url.includes("/mailFolders?")) {
          return Promise.resolve({
            value: [makeMailFolder("folder-1", { totalItemCount: 1 })],
          });
        }
        if (url.includes("/childFolders")) {
          return Promise.resolve({ value: [] });
        }
        if (url.includes("/messages/delta")) {
          return Promise.resolve({
            value: [makeOutlookMessage("msg-partial", { hasAttachments: true })],
            "@odata.deltaLink": "delta-link",
          });
        }
        if (url.includes("/attachments")) {
          return Promise.resolve({
            value: [
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "att-ok",
                name: "good.pdf",
                contentType: "application/pdf",
                size: 5000,
                contentBytes: Buffer.from("good-pdf").toString("base64"),
              },
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "att-bad",
                name: "encrypted.pdf",
                contentType: "application/pdf",
                size: 6000,
                contentBytes: Buffer.from("encrypted-pdf").toString("base64"),
              },
            ],
          });
        }
        return Promise.resolve({ value: [] });
      });

      let extractCall = 0;
      const partialExtract = vi.fn(async () => {
        extractCall++;
        if (extractCall === 2) return null; // second PDF fails extraction
        return { text: "Extracted text", pages: 1, truncated: false };
      });

      const attSource = createOutlookEmailSource(g, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: partialExtract as any,
      });

      const result = await attSource.sync(null);

      // 1 email + 1 successful attachment doc
      expect(result.documents).toHaveLength(2);

      const emailDoc = result.documents[0];
      const attDoc = result.documents[1];

      // Both tracked in metadata
      const attachments = emailDoc.metadata.extra?.attachments as any[];
      expect(attachments).toHaveLength(2);
      expect(attachments[0]).toMatchObject({ filename: "good.pdf", extracted: true });
      expect(attachments[1]).toMatchObject({
        filename: "encrypted.pdf",
        extracted: false,
        reason: "extraction-failed",
      });

      // Only successful one gets a doc — stable hash ID
      expect(attDoc.externalId).toBe(
        `msg-partial/att/${deriveAttachmentStableId("good.pdf", 5000, "application/pdf")}`,
      );
      expect(attDoc.title).toBe("good.pdf");
      expect(attDoc.content).toBe("Extracted text");
    });

    test("records successful OCR with no text without creating an attachment document", async () => {
      const { graph: g } = setupGraphWithAttachments();
      const noTextExtract = vi.fn(() =>
        Promise.resolve({ text: "", truncated: false, noText: true as const }),
      );
      const attSource = createOutlookEmailSource(g, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["image/png"],
          maxTextLength: 500_000,
        },
        extractAttachment: noTextExtract as any,
      });

      const result = await attSource.sync(null);

      expect(result.documents).toHaveLength(1);
      const attachments = result.documents[0].metadata.extra?.attachments as any[];
      expect(attachments).toContainEqual(
        expect.objectContaining({
          filename: "image.png",
          extracted: false,
          reason: "no-text",
        }),
      );
    });

    test("referenceAttachment surfaces as link metadata, not a child doc", async () => {
      const g = createMockGraph();
      g.get = vi.fn((url: string) => {
        if (url.includes("/mailFolders?")) {
          return Promise.resolve({ value: [makeMailFolder("folder-1", { totalItemCount: 1 })] });
        }
        if (url.includes("/childFolders")) return Promise.resolve({ value: [] });
        if (url.includes("/messages/delta")) {
          return Promise.resolve({
            value: [makeOutlookMessage("msg-ref", { hasAttachments: true })],
            "@odata.deltaLink": "delta-link",
          });
        }
        if (url.includes("/attachments")) {
          return Promise.resolve({
            value: [
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "att-pdf",
                name: "report.pdf",
                contentType: "application/pdf",
                size: 4096,
                contentBytes: Buffer.from("pdf-bytes").toString("base64"),
              },
              {
                "@odata.type": "#microsoft.graph.referenceAttachment",
                id: "att-ref",
                name: "Q1 forecast.xlsx",
                contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                size: 12345,
                sourceUrl:
                  "https://contoso-my.sharepoint.com/personal/user/Documents/Q1%20forecast.xlsx",
                providerType: "oneDriveBusiness",
                permission: "view",
                isFolder: false,
              },
              {
                // referenceAttachment with omitted contentType — should still render
                "@odata.type": "#microsoft.graph.referenceAttachment",
                id: "att-ref-bare",
                name: "Project Plan",
                sourceUrl: "https://onedrive.live.com/redir?resid=ABC123",
              },
              {
                // itemAttachment is intentionally dropped (#22).
                "@odata.type": "#microsoft.graph.itemAttachment",
                id: "att-item",
                name: "forwarded.msg",
                contentType: "message/rfc822",
                size: 5000,
              },
            ],
          });
        }
        return Promise.resolve({ value: [] });
      });

      const attSource = createOutlookEmailSource(g, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });

      const result = await attSource.sync(null);

      // 1 email + 1 PDF child doc. References do NOT produce child docs.
      expect(result.documents).toHaveLength(2);
      expect(result.documents.filter((d) => d.metadata.documentType === "attachment")).toHaveLength(
        1,
      );

      const emailDoc = result.documents[0];
      const attachments = emailDoc.metadata.extra?.attachments as any[];
      // 1 PDF + 2 references. itemAttachment dropped.
      expect(attachments).toHaveLength(3);

      const pdfRow = attachments.find((a) => a.filename === "report.pdf");
      expect(pdfRow).toMatchObject({ extracted: true });
      expect(pdfRow.url).toBeUndefined();

      const refRow = attachments.find((a) => a.filename === "Q1 forecast.xlsx");
      expect(refRow).toMatchObject({
        extracted: false,
        reason: "reference-only",
        size: 12345,
        url: "https://contoso-my.sharepoint.com/personal/user/Documents/Q1%20forecast.xlsx",
      });
      expect(refRow.mimeType).toContain("spreadsheetml");

      // referenceAttachment with omitted contentType should still surface
      // (with a fallback mimeType) and carry the URL.
      const refBare = attachments.find((a) => a.filename === "Project Plan");
      expect(refBare).toMatchObject({
        extracted: false,
        reason: "reference-only",
        url: "https://onedrive.live.com/redir?resid=ABC123",
      });
      expect(refBare.mimeType).toBeTruthy();
    });

    test("handles attachment fetch failure gracefully", async () => {
      const g = createMockGraph();
      g.get = vi.fn((url: string) => {
        if (url.includes("/mailFolders?")) {
          return Promise.resolve({
            value: [makeMailFolder("folder-1", { totalItemCount: 1 })],
          });
        }
        if (url.includes("/childFolders")) {
          return Promise.resolve({ value: [] });
        }
        if (url.includes("/messages/delta")) {
          return Promise.resolve({
            value: [makeOutlookMessage("msg-1", { hasAttachments: true })],
            "@odata.deltaLink": "delta-link",
          });
        }
        if (url.includes("/attachments")) {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve({ value: [] });
      });

      const attSource = createOutlookEmailSource(g, {
        attachmentConfig: {
          enabled: true,
          maxSizeBytes: 25_000_000,
          allowedTypes: ["application/pdf"],
          maxTextLength: 500_000,
        },
        extractAttachment: mockExtract as any,
      });

      const result = await attSource.sync(null);

      // Should still produce the email doc
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.documentType).toBe("email");
    });
  });
});

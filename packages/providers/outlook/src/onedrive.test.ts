// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, vi } from "vitest";
import { SourceId, ProviderId, SyncError } from "@omnesis/types";
import { resolveAttachmentConfig } from "@omnesis/core";
import { OneDriveSource } from "./onedrive.js";
import { DeltaExpiredError, AuthError } from "./graph-client.js";
import type { DriveDeltaResponse, DriveItem, OneDriveCursor } from "./onedrive-types.js";
import type { AttachmentExtractFn } from "@omnesis/core";

// ── Test helpers ──────────────────────────────────────────────────────

interface MockGraph {
  get: ReturnType<typeof vi.fn>;
  getBytes: ReturnType<typeof vi.fn>;
}

function makeMockGraph(): MockGraph {
  return {
    get: vi.fn(() => Promise.resolve({ value: [] } as DriveDeltaResponse)),
    getBytes: vi.fn(() => Promise.resolve(new TextEncoder().encode("file body"))),
  };
}

function makeFile(id: string, overrides: Partial<DriveItem> = {}): DriveItem {
  return {
    id,
    name: overrides.name ?? `${id}.txt`,
    webUrl: overrides.webUrl ?? `https://onedrive.live.com/?id=${id}&cid=drive1`,
    size: overrides.size ?? 12,
    eTag: overrides.eTag ?? `etag-${id}-v1`,
    createdDateTime: overrides.createdDateTime ?? "2024-01-01T00:00:00Z",
    lastModifiedDateTime: overrides.lastModifiedDateTime ?? "2024-01-02T00:00:00Z",
    file: overrides.file ?? { mimeType: "text/plain" },
    parentReference: overrides.parentReference ?? {
      driveId: "drive1",
      path: "/drive/root:/Documents",
    },
    ...overrides,
  };
}

function makeFolder(id: string): DriveItem {
  return { id, name: `folder-${id}`, folder: { childCount: 0 } };
}

function makeDeleted(id: string): DriveItem {
  return { id, deleted: { state: "deleted" } };
}

function createSource(
  graph: MockGraph,
  opts: {
    dataCutoff?: string;
    extractAttachment?: AttachmentExtractFn;
    /** Override the default allow-list (e.g. drop images to assert a skip). */
    attachmentTypes?: string[];
  } = {},
): OneDriveSource {
  const source = new OneDriveSource(
    async () => "mock-token",
    "onedrive:user@example.com",
    "microsoft:user@example.com",
    opts.dataCutoff,
    {
      attachmentConfig: resolveAttachmentConfig(
        opts.attachmentTypes ? { attachmentTypes: opts.attachmentTypes } : undefined,
        { defaultEnabled: true },
      ),
      extractAttachment: opts.extractAttachment,
    },
  );
  Object.defineProperty(source, "graph", { value: graph, writable: true, configurable: true });
  return source;
}

// ── ID & display ──────────────────────────────────────────────────────

describe("OneDriveSource — error handling", () => {
  test("an auth failure escapes as a connection-scoped SyncError", async () => {
    // Mail and Calendar read through the same account token, so a dead
    // credential surfacing here is not a fact about this one file.
    const graph = makeMockGraph();
    graph.get.mockRejectedValueOnce(new AuthError("token revoked"));

    const source = createSource(graph);
    const error = await source.sync(null).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).kind).toBe("auth");
    expect((error as SyncError).scope).toBe("connection");
    expect((error as SyncError).cause).toBeInstanceOf(AuthError);
  });
});

describe("OneDriveSource — identity", () => {
  test("sets id and providerId from constructor args", () => {
    const source = createSource(makeMockGraph());
    expect(source.id).toBe(SourceId("onedrive:user@example.com"));
    expect(source.providerId).toBe(ProviderId("microsoft:user@example.com"));
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────

describe("OneDriveSource — bootstrap", () => {
  let graph: MockGraph;
  beforeEach(() => {
    graph = makeMockGraph();
  });

  test("walks /me/drive/root/delta, normalizes files, skips folders", async () => {
    graph.get.mockResolvedValueOnce({
      value: [makeFile("file-1"), makeFolder("folder-1"), makeFile("file-2")],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=delta-1",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync(null);

    // First call hits the root delta endpoint.
    expect(graph.get).toHaveBeenCalledWith(expect.stringContaining("/me/drive/root/delta"));
    expect(result.documents).toHaveLength(2);
    expect(result.documents.map((d) => d.externalId).sort()).toEqual(["file-1", "file-2"]);
    // Folder produced no document.
    expect(result.documents.find((d) => d.externalId === "folder-1")).toBeUndefined();
    // deltaLink → incremental phase, no more pages.
    expect(result.hasMore).toBe(false);
    const cursor = result.cursor as OneDriveCursor;
    expect(cursor.phase).toBe("incremental");
    expect(cursor.link).toContain("token=delta-1");
  });

  test("normalizes per-file metadata: webUrl, mime, size, folder path, content", async () => {
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("file-1", {
          name: "report.txt",
          webUrl: "https://onedrive.live.com/?id=file-1&cid=drive1",
          size: 9,
          parentReference: { driveId: "drive1", path: "/drive/root:/Documents/Reports" },
        }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);
    graph.getBytes.mockResolvedValueOnce(new TextEncoder().encode("hello you"));

    const source = createSource(graph);
    const result = await source.sync(null);

    const doc = result.documents[0];
    expect(doc.title).toBe("report.txt");
    expect(doc.metadata?.sourceUrl).toBe("https://onedrive.live.com/?id=file-1&cid=drive1");
    expect(doc.metadata?.documentType).toBe("file");
    expect(doc.metadata?.extra?.mimeType).toBe("text/plain");
    expect(doc.metadata?.extra?.fileSize).toBe(9);
    expect(doc.metadata?.extra?.folderPath).toBe("/Documents/Reports");
    expect(doc.content).toContain("hello you");
    expect(doc.content).toContain("# report.txt");
  });

  test("extracts owner (createdBy) + author (lastModifiedBy) + mentioned, like Drive", async () => {
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("file-1", {
          createdBy: { user: { displayName: "Maya Reeves", email: "Maya@Example.com" } },
          lastModifiedBy: { user: { displayName: "Jamie Lopez", email: "jamie@example.org" } },
        }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);
    graph.getBytes.mockResolvedValueOnce(
      new TextEncoder().encode("ping david@example.io about it"),
    );

    const source = createSource(graph);
    const result = await source.sync(null);
    const people = result.documents[0].metadata?.people ?? [];
    const byRole = (r: string) => people.filter((p) => p.role === r).flatMap((p) => p.emails ?? []);

    expect(byRole("owner")).toEqual(["maya@example.com"]); // createdBy, lowercased
    expect(byRole("author")).toEqual(["jamie@example.org"]); // lastModifiedBy
    expect(byRole("mentioned")).toContain("david@example.io"); // content
  });

  test("owner falls back to displayName when the identity has no email (consumer OneDrive)", async () => {
    graph.get.mockResolvedValueOnce({
      value: [makeFile("file-1", { createdBy: { user: { displayName: "Sarah Mendez" } } })],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);
    graph.getBytes.mockResolvedValueOnce(new TextEncoder().encode("no emails here"));

    const source = createSource(graph);
    const result = await source.sync(null);
    const owner = (result.documents[0].metadata?.people ?? []).find((p) => p.role === "owner");
    expect(owner?.name).toBe("Sarah Mendez");
    expect(owner?.emails).toBeUndefined();
  });

  test("paginates via @odata.nextLink across calls, then flips to incremental", async () => {
    graph.get
      .mockResolvedValueOnce({
        value: [makeFile("file-1")],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?$skiptoken=p2",
      } as DriveDeltaResponse)
      .mockResolvedValueOnce({
        value: [makeFile("file-2")],
        "@odata.deltaLink": "delta-final",
      } as DriveDeltaResponse);

    const source = createSource(graph);

    const page1 = await source.sync(null);
    expect(page1.hasMore).toBe(true);
    const c1 = page1.cursor as OneDriveCursor;
    expect(c1.phase).toBe("bootstrap");
    expect(c1.link).toContain("$skiptoken=p2");

    const page2 = await source.sync(c1);
    expect(graph.get).toHaveBeenLastCalledWith(expect.stringContaining("$skiptoken=p2"));
    expect(page2.hasMore).toBe(false);
    const c2 = page2.cursor as OneDriveCursor;
    expect(c2.phase).toBe("incremental");
    expect(c2.link).toBe("delta-final");
    // seen carries fingerprints for both files across the two pages.
    expect(Object.keys(c2.seen ?? {}).sort()).toEqual(["file-1", "file-2"]);
  });

  test("applies dataCutoff, dropping files older than the cutoff", async () => {
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("old", { createdDateTime: "2020-01-01T00:00:00Z" }),
        makeFile("new", { createdDateTime: "2025-01-01T00:00:00Z" }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);

    const source = createSource(graph, { dataCutoff: "2023-01-01T00:00:00Z" });
    const result = await source.sync(null);
    expect(result.documents.map((d) => d.externalId)).toEqual(["new"]);
  });
});

// ── Incremental ───────────────────────────────────────────────────────

describe("OneDriveSource — incremental", () => {
  let graph: MockGraph;
  beforeEach(() => {
    graph = makeMockGraph();
  });

  test("follows the persisted deltaLink and applies changes idempotently", async () => {
    graph.get.mockResolvedValueOnce({
      value: [makeFile("file-1", { eTag: "etag-file-1-v2" })],
      "@odata.deltaLink": "delta-2",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const cursor: OneDriveCursor = {
      phase: "incremental",
      link: "delta-1",
      seen: { "file-1": "12|2024-01-02T00:00:00Z|etag-file-1-v1" },
    };
    const result = await source.sync(cursor);

    expect(graph.get).toHaveBeenCalledWith("delta-1");
    expect(result.documents.map((d) => d.externalId)).toEqual(["file-1"]);
    const next = result.cursor as OneDriveCursor;
    expect(next.phase).toBe("incremental");
    expect(next.link).toBe("delta-2");
    // fingerprint updated to the new eTag.
    expect(next.seen?.["file-1"]).toContain("etag-file-1-v2");
  });

  test("a deleted file is removed (deleted facet → deletedExternalIds)", async () => {
    graph.get.mockResolvedValueOnce({
      value: [makeDeleted("file-gone")],
      "@odata.deltaLink": "delta-2",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const cursor: OneDriveCursor = {
      phase: "incremental",
      link: "delta-1",
      seen: { "file-gone": "12|2024-01-02T00:00:00Z|etag-file-gone-v1" },
    };
    const result = await source.sync(cursor);

    expect(result.documents).toHaveLength(0);
    expect(result.deletedExternalIds).toEqual(["file-gone"]);
    // dropped from the seen map.
    expect((result.cursor as OneDriveCursor).seen?.["file-gone"]).toBeUndefined();
  });

  test("a re-sync with no changes neither duplicates nor drops files", async () => {
    graph.get.mockResolvedValueOnce({
      value: [],
      "@odata.deltaLink": "delta-3",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const cursor: OneDriveCursor = {
      phase: "incremental",
      link: "delta-2",
      seen: { "file-1": "12|2024-01-02T00:00:00Z|etag-file-1-v1" },
    };
    const result = await source.sync(cursor);

    expect(result.documents).toHaveLength(0);
    expect(result.deletedExternalIds).toHaveLength(0);
    // seen preserved unchanged.
    expect((result.cursor as OneDriveCursor).seen).toEqual(cursor.seen);
  });
});

// ── Bounded re-walk on 410 ────────────────────────────────────────────

describe("OneDriveSource — expired delta token (410) → bounded re-walk", () => {
  let graph: MockGraph;
  beforeEach(() => {
    graph = makeMockGraph();
  });

  test("re-enumerates metadata but re-extracts content only for changed items", async () => {
    // First call (the persisted deltaLink) throws 410. Then a fresh
    // /me/drive/root/delta enumerates all three current files.
    graph.get.mockRejectedValueOnce(new DeltaExpiredError()).mockResolvedValueOnce({
      value: [
        // unchanged — fingerprint matches `seen`
        makeFile("unchanged", { eTag: "etag-unchanged-v1" }),
        // changed — new eTag
        makeFile("changed", { eTag: "etag-changed-v2" }),
        // brand new — absent from `seen`
        makeFile("fresh", { eTag: "etag-fresh-v1" }),
      ],
      "@odata.deltaLink": "delta-after-rewalk",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const cursor: OneDriveCursor = {
      phase: "incremental",
      link: "expired-delta-link",
      seen: {
        unchanged: "12|2024-01-02T00:00:00Z|etag-unchanged-v1",
        changed: "12|2024-01-02T00:00:00Z|etag-changed-v1",
        // "deleted-since" was in seen but is absent from the fresh enumeration
        "deleted-since": "12|2024-01-02T00:00:00Z|etag-deleted-v1",
      },
    };
    const result = await source.sync(cursor);

    // Bounded: only the changed + fresh items had content downloaded.
    expect(graph.getBytes).toHaveBeenCalledTimes(2);
    // Only changed + fresh produced documents — NOT the unchanged file.
    expect(result.documents.map((d) => d.externalId).sort()).toEqual(["changed", "fresh"]);
    // The cursor stays incremental and carries the fresh deltaLink — NOT a
    // from-zero bootstrap.
    const next = result.cursor as OneDriveCursor;
    expect(next.phase).toBe("incremental");
    expect(next.link).toBe("delta-after-rewalk");
    // seen rebuilt from the fresh enumeration: present files only.
    expect(Object.keys(next.seen ?? {}).sort()).toEqual(["changed", "fresh", "unchanged"]);
    expect(next.seen?.["deleted-since"]).toBeUndefined();
    // Dropping it from `seen` is not enough — the gateway still holds its
    // document. The complete snapshot is what lets the gateway reconcile it
    // away, and it must not claim the file is still present.
    expect(result.presentExternalIds?.sort()).toEqual(["changed", "fresh", "unchanged"]);
  });

  test("a file deleted DURING the outage is reconciled away by the snapshot", async () => {
    // The real recovery shape: the tombstone was published against the token
    // that expired, so the fresh from-zero enumeration carries no `deleted`
    // facet at all — only two live files where `seen` remembers three. The
    // missing file is signalled by its absence from `presentExternalIds`.
    graph.get.mockRejectedValueOnce(new DeltaExpiredError()).mockResolvedValueOnce({
      value: [
        makeFile("kept-a", { eTag: "etag-kept-a-v1" }),
        makeFile("kept-b", { eTag: "etag-kept-b-v1" }),
      ],
      "@odata.deltaLink": "delta-after-rewalk",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync({
      phase: "incremental",
      link: "expired-delta-link",
      seen: {
        "kept-a": "12|2024-01-02T00:00:00Z|etag-kept-a-v1",
        "kept-b": "12|2024-01-02T00:00:00Z|etag-kept-b-v1",
        "gone-during-outage": "12|2024-01-02T00:00:00Z|etag-gone-v1",
      },
    });

    expect(result.presentExternalIds?.sort()).toEqual(["kept-a", "kept-b"]);
    // The snapshot is only honored on a complete enumeration, so the walk must
    // declare itself finished.
    expect(result.hasMore).toBeFalsy();
    // Both survivors are unchanged, so nothing is re-downloaded or re-emitted.
    expect(graph.getBytes).not.toHaveBeenCalled();
    expect(result.documents).toHaveLength(0);
  });

  test("a file the walk still sees stays in the snapshot, even when it changed", async () => {
    graph.get.mockRejectedValueOnce(new DeltaExpiredError()).mockResolvedValueOnce({
      value: [makeFile("edited", { eTag: "etag-edited-v2" })],
      "@odata.deltaLink": "delta-after-rewalk",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync({
      phase: "incremental",
      link: "expired",
      seen: { edited: "12|2024-01-02T00:00:00Z|etag-edited-v1" },
    });

    expect(result.presentExternalIds).toEqual(["edited"]);
    expect(result.documents.map((d) => d.externalId)).toEqual(["edited"]);
  });

  test("a file the walk skips is still claimed present, so it is never reconciled away", async () => {
    // An archive is enumerated but never normalized into a document. It must
    // still appear in the snapshot: a walk that omitted every unprocessable
    // file would delete the operator's whole PDF library on the first expiry.
    graph.get.mockRejectedValueOnce(new DeltaExpiredError()).mockResolvedValueOnce({
      value: [
        makeFile("archive", { name: "backup.zip", file: { mimeType: "application/zip" } }),
        makeFile("huge", { size: 999_999_999 }),
        makeFile("normal", { eTag: "etag-normal-v1" }),
      ],
      "@odata.deltaLink": "delta-after",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync({
      phase: "incremental",
      link: "expired",
      seen: {
        archive: "12|2024-01-02T00:00:00Z|etag-archive-v1",
        huge: "12|2024-01-02T00:00:00Z|etag-huge-v1",
        normal: "12|2024-01-02T00:00:00Z|etag-normal-v1",
      },
    });

    expect(result.presentExternalIds?.sort()).toEqual(["archive", "huge", "normal"]);
    expect(result.documents).toHaveLength(0);
  });

  test("a drive emptied of everything it held reconciles to zero", async () => {
    // An empty walk where the drive was known to hold files could be Graph
    // answering oddly — and it is still published. Refusing would not delay the
    // deletion, it would cancel it: a withheld snapshot is an absent signal,
    // not a late one, so the gateway marks nothing, no deadline runs, and files
    // the operator deleted stay indexed with no way back.
    graph.get.mockRejectedValueOnce(new DeltaExpiredError()).mockResolvedValueOnce({
      value: [],
      "@odata.deltaLink": "delta-after",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync({
      phase: "incremental",
      link: "expired",
      seen: {
        "file-a": "12|2024-01-02T00:00:00Z|etag-a",
        "file-b": "12|2024-01-02T00:00:00Z|etag-b",
      },
    });

    expect(result.presentExternalIds).toEqual([]);
  });

  test("an empty enumeration reconciles when nothing was known to begin with", async () => {
    graph.get.mockRejectedValueOnce(new DeltaExpiredError()).mockResolvedValueOnce({
      value: [],
      "@odata.deltaLink": "delta-after",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync({ phase: "incremental", link: "expired", seen: {} });

    expect(result.presentExternalIds).toEqual([]);
  });

  test("a walk interrupted mid-pagination keeps its progress and publishes no snapshot", async () => {
    // A partial walk that published its snapshot would reconcile away every
    // file it had not yet reached, so the snapshot waits for the last page —
    // but the pages already done must not be thrown away either, or a drive
    // large enough to fail once can never finish recovering.
    graph.get
      .mockRejectedValueOnce(new DeltaExpiredError())
      .mockResolvedValueOnce({
        value: [makeFile("page1-file", { eTag: "etag-p1-v2" })],
        "@odata.nextLink": "rewalk-page-2",
      } as DriveDeltaResponse)
      .mockRejectedValueOnce(new Error("Graph API error 500"));

    const source = createSource(graph);
    const first = await source.sync({
      phase: "incremental",
      link: "expired",
      seen: { "page1-file": "12|2024-01-02T00:00:00Z|etag-p1-v1", "page2-file": "x" },
    });

    expect(first.hasMore).toBe(true);
    expect(first.presentExternalIds).toBeUndefined();
    const walk = (first.cursor as OneDriveCursor).rewalk;
    expect(walk?.link).toBe("rewalk-page-2");
    expect(Object.keys(walk?.seen ?? {})).toEqual(["page1-file"]);
    // The map the walk compares against is untouched until it finishes, or a
    // resumed walk would think every file it already read was unchanged.
    expect((first.cursor as OneDriveCursor).seen?.["page1-file"]).toBe(
      "12|2024-01-02T00:00:00Z|etag-p1-v1",
    );

    await expect(source.sync(first.cursor)).rejects.toThrow("Graph API error 500");
  });

  test("an incremental cursor with no deltaLink re-enumerates one page at a time", async () => {
    // A cursor written before a deltaLink was ever persisted. It goes to the
    // paginating bootstrap, NOT the re-walk: the re-walk drains every page in
    // one call, and with no fingerprints to compare against that would extract
    // the entire drive in a single uninterruptible sync.
    graph.get.mockResolvedValueOnce({
      value: [makeFile("still-here", { eTag: "etag-still-here-v1" })],
      "@odata.nextLink": "page-2",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync({
      phase: "incremental",
      seen: { "still-here": "12|2024-01-02T00:00:00Z|etag-still-here-v1" },
    });

    expect(graph.get).toHaveBeenCalledTimes(1);
    expect(result.hasMore).toBe(true);
    expect((result.cursor as OneDriveCursor).phase).toBe("bootstrap");
    // A partial page must never claim to be a snapshot.
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("a `deleted` facet in the fresh walk is honored as an explicit tombstone", async () => {
    graph.get.mockRejectedValueOnce(new DeltaExpiredError()).mockResolvedValueOnce({
      value: [makeFile("kept", { eTag: "etag-kept-v1" }), makeDeleted("gone")],
      "@odata.deltaLink": "delta-after",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const cursor: OneDriveCursor = {
      phase: "incremental",
      link: "expired",
      seen: { kept: "12|2024-01-02T00:00:00Z|etag-kept-v1" },
    };
    const result = await source.sync(cursor);

    expect(result.deletedExternalIds).toEqual(["gone"]);
    // kept is unchanged → no content download, no document re-emitted.
    expect(graph.getBytes).not.toHaveBeenCalled();
    expect(result.documents).toHaveLength(0);
  });

  test("re-walk paginates the fresh enumeration a page per call, snapshotting only at the end", async () => {
    // One page per sync() call, like every other path. Draining the whole
    // enumeration in one call would make a delta expiry on a large drive a
    // single multi-minute sync that reports no progress.
    graph.get
      .mockRejectedValueOnce(new DeltaExpiredError())
      .mockResolvedValueOnce({
        value: [makeFile("page1-file", { eTag: "etag-p1-v2" })],
        "@odata.nextLink": "rewalk-page-2",
      } as DriveDeltaResponse)
      .mockResolvedValueOnce({
        value: [makeFile("page2-file", { eTag: "etag-p2-v2" })],
        "@odata.deltaLink": "delta-after",
      } as DriveDeltaResponse);

    const source = createSource(graph);
    const first = await source.sync({ phase: "incremental", link: "expired", seen: {} });
    expect(first.documents.map((d) => d.externalId)).toEqual(["page1-file"]);
    expect(first.hasMore).toBe(true);
    // Half the drive named as the whole of it would delete the other half.
    expect(first.presentExternalIds).toBeUndefined();
    expect(first.progress?.processed).toBe(1);

    const second = await source.sync(first.cursor);
    expect(second.documents.map((d) => d.externalId)).toEqual(["page2-file"]);
    expect(second.hasMore).toBe(false);
    // Only now is the set complete enough to reconcile against.
    expect(second.presentExternalIds?.sort()).toEqual(["page1-file", "page2-file"]);
    const cursor = second.cursor as OneDriveCursor;
    expect(cursor.link).toBe("delta-after");
    expect(cursor.rewalk).toBeUndefined();
    // The walk's map replaces the one it compared against, so the next tick
    // measures changes from where the recovery actually landed.
    expect(Object.keys(cursor.seen ?? {}).sort()).toEqual(["page1-file", "page2-file"]);
  });

  test("a deletion seen early in the walk survives to the page that reports it", async () => {
    // Graph announces the deletion on whichever page it falls on, but the
    // walk cannot report it until it is willing to publish the snapshot —
    // holding it on the cursor is what keeps it from being lost.
    graph.get
      .mockRejectedValueOnce(new DeltaExpiredError())
      .mockResolvedValueOnce({
        value: [{ id: "gone", deleted: { state: "deleted" } } as DriveItem],
        "@odata.nextLink": "rewalk-page-2",
      } as DriveDeltaResponse)
      .mockResolvedValueOnce({
        value: [makeFile("survivor")],
        "@odata.deltaLink": "delta-after",
      } as DriveDeltaResponse);

    const source = createSource(graph);
    const first = await source.sync({ phase: "incremental", link: "expired", seen: {} });
    expect(first.deletedExternalIds).toEqual([]);

    const second = await source.sync(first.cursor);
    expect(second.deletedExternalIds).toEqual(["gone"]);
    expect(second.presentExternalIds).toEqual(["survivor"]);
  });
});

// ── Attachment extraction & error handling ────────────────────────────

describe("OneDriveSource — content extraction", () => {
  let graph: MockGraph;
  beforeEach(() => {
    graph = makeMockGraph();
  });

  test("routes binary files through the shared attachment extractor", async () => {
    const extractAttachment = vi.fn(async () =>
      Promise.resolve({ text: "PDF text", truncated: false }),
    );
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("doc-1", {
          name: "spec.pdf",
          file: { mimeType: "application/pdf" },
          size: 2048,
        }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);
    graph.getBytes.mockResolvedValueOnce(new Uint8Array([1, 2, 3, 4]));

    const source = createSource(graph, { extractAttachment });
    const result = await source.sync(null);

    expect(extractAttachment).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "application/pdf",
      expect.objectContaining({ maxTextLength: expect.any(Number) }),
    );
    expect(result.documents[0].content).toContain("PDF text");
  });

  test("a transient extraction failure throws (does not silently drop the file)", async () => {
    const extractAttachment = vi.fn(async () => {
      throw new SyncError("transient", "attachment processor unavailable");
    });
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("doc-1", {
          name: "scan.pdf",
          file: { mimeType: "application/pdf" },
          size: 2048,
        }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);
    graph.getBytes.mockResolvedValueOnce(new Uint8Array([1, 2, 3, 4]));

    const source = createSource(graph, { extractAttachment });
    await expect(source.sync(null)).rejects.toThrow(/processor unavailable/i);
  });

  test("processes an allow-listed image (OCR opt-in via the default allow-set, #427)", async () => {
    const extractAttachment = vi.fn(async () =>
      Promise.resolve({ text: "OCR text", truncated: false }),
    );
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("img-1", { name: "photo.png", file: { mimeType: "image/png" }, size: 4096 }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);
    graph.getBytes.mockResolvedValueOnce(new Uint8Array([9, 9, 9]));

    // Images are in the default attachment allow-set, so the skip-prefix gate is
    // overridden and the image routes through the extractor.
    const source = createSource(graph, { extractAttachment });
    const result = await source.sync(null);
    expect(result.documents.map((d) => d.externalId)).toEqual(["img-1"]);
    expect(result.documents[0].content).toContain("OCR text");
  });

  test("does not index an image when OCR successfully finds no text", async () => {
    const extractAttachment = vi.fn(async () => ({
      text: "",
      truncated: false,
      noText: true as const,
    }));
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("img-empty", { name: "blank.png", file: { mimeType: "image/png" }, size: 4096 }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);
    graph.getBytes.mockResolvedValueOnce(new Uint8Array([9, 9, 9]));

    const result = await createSource(graph, { extractAttachment }).sync(null);

    expect(result.documents).toHaveLength(0);
    expect(extractAttachment).toHaveBeenCalledOnce();
  });

  test("skips an image when the allow-list excludes it", async () => {
    const extractAttachment = vi.fn();
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("img-1", { name: "photo.png", file: { mimeType: "image/png" }, size: 4096 }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);

    // Restrict the allow-list to PDF only — the image is now hard-skipped.
    const source = createSource(graph, { extractAttachment, attachmentTypes: ["application/pdf"] });
    const result = await source.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(graph.getBytes).not.toHaveBeenCalled();
    expect(extractAttachment).not.toHaveBeenCalled();
  });

  test("skips an archive file (never processable)", async () => {
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("zip-1", {
          name: "backup.zip",
          file: { mimeType: "application/zip" },
          size: 1024,
        }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);

    const source = createSource(graph, { extractAttachment: vi.fn() });
    const result = await source.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(graph.getBytes).not.toHaveBeenCalled();
  });
});

// ── The retention cutoff, and how a file's type reads ─────────────────

describe("OneDriveSource — the data cutoff", () => {
  let graph: MockGraph;
  beforeEach(() => {
    graph = makeMockGraph();
  });

  test("a file created before the cutoff is never downloaded", async () => {
    // The document would be dropped either way. Deciding it from the delta
    // page's own `createdDateTime` is the difference between reading a file's
    // metadata and downloading it, OCR-ing it, and discarding the result — on
    // a drive whose whole history predates the cutoff, that is all of it.
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("old", { createdDateTime: "2019-05-01T00:00:00Z" }),
        makeFile("recent", { createdDateTime: "2026-05-01T00:00:00Z" }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);

    const source = createSource(graph, { dataCutoff: "2025-01-01T00:00:00Z" });
    const result = await source.sync(null);

    expect(result.documents.map((d) => d.externalId)).toEqual(["recent"]);
    // The proof it was skipped rather than fetched-then-filtered.
    expect(graph.getBytes).not.toHaveBeenCalledWith(expect.stringContaining("old"));
    expect(graph.getBytes).toHaveBeenCalledWith(expect.stringContaining("recent"));
  });

  test("a dropped file is not claimed present, so the cutoff reaches the index", async () => {
    // Fingerprinting it would list it in the re-walk's snapshot as a file the
    // drive still holds, and a document indexed before the cutoff was set would
    // then never be reconciled away.
    graph.get.mockRejectedValueOnce(new DeltaExpiredError()).mockResolvedValueOnce({
      value: [
        makeFile("old", { createdDateTime: "2019-05-01T00:00:00Z" }),
        makeFile("recent", { createdDateTime: "2026-05-01T00:00:00Z" }),
      ],
      "@odata.deltaLink": "delta-after",
    } as DriveDeltaResponse);

    const source = createSource(graph, { dataCutoff: "2025-01-01T00:00:00Z" });
    const result = await source.sync({ phase: "incremental", link: "expired", seen: {} });

    expect(result.presentExternalIds).toEqual(["recent"]);
    expect((result.cursor as OneDriveCursor).seen?.old).toBeUndefined();
  });

  test("a file whose creation time is missing or unreadable is kept", async () => {
    // An unreadable date is not evidence of age, and dropping on it would
    // silently lose files rather than bound them.
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("undated", { createdDateTime: undefined }),
        makeFile("garbled", { createdDateTime: "not a date" }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);

    const source = createSource(graph, { dataCutoff: "2025-01-01T00:00:00Z" });
    const result = await source.sync(null);
    expect(result.documents.map((d) => d.externalId).sort()).toEqual(["garbled", "undated"]);
  });
});

describe("OneDriveSource — how a file's type reads", () => {
  test("the body names the kind of file, not its MIME type", async () => {
    // The raw type dilutes BM25, reads as machine output in a search snippet,
    // and makes "Word documents" as a natural-language filter miss this source
    // while matching the one beside it.
    const graph = makeMockGraph();
    graph.get.mockResolvedValueOnce({
      value: [
        makeFile("report", {
          name: "Q3 report.docx",
          file: {
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        }),
      ],
      "@odata.deltaLink": "delta-1",
    } as DriveDeltaResponse);

    const source = createSource(graph, {
      extractAttachment: async () => Promise.resolve({ text: "Revenue up.", truncated: false }),
    });
    const result = await source.sync(null);

    expect(result.documents[0]!.content).toContain("**Type:** Word document");
    expect(result.documents[0]!.content).not.toContain("openxmlformats");
  });
});

// ── When a recovery itself goes wrong ─────────────────────────────────

describe("OneDriveSource — a re-walk that cannot finish", () => {
  let graph: MockGraph;
  beforeEach(() => {
    graph = makeMockGraph();
  });

  test("an enumeration invalidated mid-walk restarts from the root instead of wedging", async () => {
    // Graph can disown an in-flight enumeration, which makes the walk's saved
    // nextLink permanently dead. Because that pointer is persisted, retrying it
    // would fail identically on every tick — the source would never sync again.
    graph.get
      .mockRejectedValueOnce(new DeltaExpiredError())
      .mockResolvedValueOnce({
        value: [makeFile("page1-file")],
        "@odata.nextLink": "rewalk-page-2",
      } as DriveDeltaResponse)
      .mockRejectedValueOnce(new DeltaExpiredError())
      .mockResolvedValueOnce({
        value: [makeFile("page1-file"), makeFile("page2-file")],
        "@odata.deltaLink": "delta-after",
      } as DriveDeltaResponse);

    const source = createSource(graph);
    const first = await source.sync({ phase: "incremental", link: "expired", seen: {} });
    expect((first.cursor as OneDriveCursor).rewalk?.link).toBe("rewalk-page-2");

    const restarted = await source.sync(first.cursor);
    expect(restarted.hasMore).toBe(true);
    // The dead pointer is dropped, and what it had collected goes with it: a
    // set half-gathered from an enumeration Graph has disowned is not a set
    // anything may be reconciled against.
    const walk = (restarted.cursor as OneDriveCursor).rewalk;
    expect(walk?.link).toBeUndefined();
    expect(walk?.seen).toEqual({});
    expect(restarted.presentExternalIds).toBeUndefined();

    // And the restarted walk reaches the root, not the dead link.
    const finished = await source.sync(restarted.cursor);
    expect(graph.get).toHaveBeenLastCalledWith(expect.stringContaining("/me/drive/root/delta"));
    expect(finished.presentExternalIds?.sort()).toEqual(["page1-file", "page2-file"]);
  });

  test("a paginated walk accumulates every page into one enumeration", async () => {
    // The shape that actually occurs on a large drive: several pages. The
    // snapshot must name every file across all of them, not just the last
    // page's — publishing only the tail would reconcile away everything the
    // earlier pages found.
    const prior: Record<string, string> = {};
    for (let i = 0; i < 6; i++) prior[`file-${i}`] = `12|2024-01-02T00:00:00Z|etag-file-${i}-v1`;

    graph.get
      .mockRejectedValueOnce(new DeltaExpiredError())
      .mockResolvedValueOnce({
        value: [makeFile("file-0"), makeFile("file-1")],
        "@odata.nextLink": "rewalk-page-2",
      } as DriveDeltaResponse)
      .mockResolvedValueOnce({
        value: [makeFile("file-2"), makeFile("file-3")],
        "@odata.nextLink": "rewalk-page-3",
      } as DriveDeltaResponse)
      .mockResolvedValueOnce({
        value: [makeFile("file-4"), makeFile("file-5")],
        "@odata.deltaLink": "delta-after",
      } as DriveDeltaResponse);

    const source = createSource(graph);
    let cursor: OneDriveCursor = { phase: "incremental", link: "expired", seen: prior };
    const totals: Array<number | undefined> = [];
    let last;
    for (let i = 0; i < 4; i++) {
      last = await source.sync(cursor);
      cursor = last.cursor as OneDriveCursor;
      totals.push(cursor.rewalk?.total);
      if (!last.hasMore) break;
    }

    // Each page adds to the running count rather than replacing it.
    expect(totals).toEqual([2, 4, undefined]);
    expect(last!.presentExternalIds?.sort()).toEqual([
      "file-0",
      "file-1",
      "file-2",
      "file-3",
      "file-4",
      "file-5",
    ]);
  });

  test("a drive that keeps losing the enumeration gives up instead of looping", async () => {
    // The restart returns hasMore, and the collector drains hasMore without
    // pausing — so a remote that disowns every enumeration would spin inside
    // one sync cycle, re-reading page one each time. Failing hands the
    // collector its backoff instead.
    // The drive answers its root fine and disowns every continuation, so each
    // attempt gets exactly one page further before being thrown away.
    graph.get.mockImplementation((url: string) => {
      if (url.includes("/me/drive/root/delta")) {
        return Promise.resolve({
          value: [makeFile("page1-file")],
          "@odata.nextLink": "rewalk-page-2",
        } as DriveDeltaResponse);
      }
      return Promise.reject(new DeltaExpiredError());
    });

    const source = createSource(graph);
    let cursor: OneDriveCursor = { phase: "incremental", link: "expired", seen: {} };
    let threw = false;
    for (let i = 0; i < 12; i++) {
      try {
        cursor = (await source.sync(cursor)).cursor as OneDriveCursor;
      } catch (error) {
        expect(error).toBeInstanceOf(DeltaExpiredError);
        threw = true;
        break;
      }
    }
    expect(threw, "the walk should give up rather than restart forever").toBe(true);
  });

  test("a walk that came back far smaller than the drive was known to be still reconciles", async () => {
    // Two files where twenty were known. A throttled page and a genuine mass
    // deletion look identical from here, and the source has no way to tell
    // them apart — it does not know how many documents the gateway holds. That
    // judgement belongs to the gateway, which marks the absences with a
    // deadline and corroborates across reads instead of vetoing. What this walk
    // owes is an honest completeness answer, which a finished walk gives.
    const prior: Record<string, string> = {};
    for (let i = 0; i < 20; i++) prior[`file-${i}`] = `12|2024-01-02T00:00:00Z|etag-file-${i}-v1`;

    graph.get.mockRejectedValueOnce(new DeltaExpiredError()).mockResolvedValueOnce({
      value: [makeFile("file-0"), makeFile("file-1")],
      "@odata.deltaLink": "delta-after",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync({ phase: "incremental", link: "expired", seen: prior });

    expect(result.presentExternalIds?.sort()).toEqual(["file-0", "file-1"]);
    expect(Object.keys((result.cursor as OneDriveCursor).seen ?? {}).sort()).toEqual([
      "file-0",
      "file-1",
    ]);
  });

  test("a drive that genuinely shrank a little still reconciles", async () => {
    // Nothing may stand between the operator and an ordinary cleanup.
    const prior: Record<string, string> = {};
    for (let i = 0; i < 4; i++) prior[`file-${i}`] = `12|2024-01-02T00:00:00Z|etag-file-${i}-v1`;

    graph.get.mockRejectedValueOnce(new DeltaExpiredError()).mockResolvedValueOnce({
      value: [makeFile("file-0"), makeFile("file-1"), makeFile("file-2")],
      "@odata.deltaLink": "delta-after",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync({ phase: "incremental", link: "expired", seen: prior });

    expect(result.presentExternalIds?.sort()).toEqual(["file-0", "file-1", "file-2"]);
  });

  test("a first-ever walk with nothing known reconciles whatever it finds", async () => {
    // An empty drive is a legitimate answer, and the walk covered it.
    graph.get.mockRejectedValueOnce(new DeltaExpiredError()).mockResolvedValueOnce({
      value: [],
      "@odata.deltaLink": "delta-after",
    } as DriveDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync({ phase: "incremental", link: "expired", seen: {} });
    expect(result.presentExternalIds).toEqual([]);
  });
});

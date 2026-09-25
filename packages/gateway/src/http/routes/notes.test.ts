// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Scope, SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import {
  OMNESIS_NOTES_PROVIDER_ID,
  OMNESIS_NOTES_SOURCE_ID,
  type OmnesisNotesRuntime,
  type NoteEntry,
} from "../../sources/omnesis-notes/index.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;
let token: string;
let notesRuntime: OmnesisNotesRuntime | undefined;
let priorExperimental: string | undefined;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function req(path: string, init: RequestInit = {}, bearer: string = token): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
      ...init.headers,
    },
  });
}

function capture(body: Record<string, unknown>, bearer?: string): Promise<Response> {
  return req("/notes", { method: "POST", body: JSON.stringify(body) }, bearer);
}

beforeEach(() => {
  priorExperimental = process.env.OMNESIS_EXPERIMENTAL;
  delete process.env.OMNESIS_EXPERIMENTAL;
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  token = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
  notesRuntime = undefined;
  app = createServer(db, dbPath, {
    onOmnesisNotesRuntime: (rt) => {
      notesRuntime = rt;
    },
  });
});

afterEach(async () => {
  // Quiesce the runtime's background work (seed + pending upserts)
  // before closing the DB handle it writes through.
  await notesRuntime?.flushAll();
  notesRuntime?.dispose();
  if (priorExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
  else process.env.OMNESIS_EXPERIMENTAL = priorExperimental;
  db.close();
  cleanupDb(dbPath);
});

describe("/notes availability", () => {
  test("boots and captures without experimental mode", async () => {
    expect(notesRuntime).toBeDefined();
    const res = await capture({ text: "Remember the fictional studio booking", surface: "cli" });
    expect(res.status).toBe(201);
  });

  test("still authenticates before accepting a capture", async () => {
    const res = await app.request("/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  test("a server without a lifecycle owner defers notes boot until an authorized request", async () => {
    const lazyPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    const lazyDb = createDatabase(lazyPath);
    try {
      const device = createDevice(lazyDb, { name: "lazy-notes-test", kind: "cli" });
      const lazyToken = createToken(lazyDb, device.id, [SCOPE_READ]).token;
      const lazyApp = createServer(lazyDb, lazyPath);
      const seededCount = (): number =>
        lazyDb
          .prepare<
            [],
            { count: number }
          >(`SELECT COUNT(*) AS count FROM sync_state WHERE source_id = '${OMNESIS_NOTES_SOURCE_ID}'`)
          .get()!.count;

      expect(seededCount()).toBe(0);
      const unauthorized = await lazyApp.request("/notes");
      expect(unauthorized.status).toBe(401);
      expect(seededCount()).toBe(0);

      const authorized = await lazyApp.request("/notes", {
        headers: { Authorization: `Bearer ${lazyToken}` },
      });
      expect(authorized.status).toBe(200);
      await expect.poll(seededCount).toBe(1);
    } finally {
      lazyDb.close();
      cleanupDb(lazyPath);
    }
  });
});

describe("POST /notes", () => {
  test("captures a note: 201, trimmed text, ledger row, projected day doc", async () => {
    const res = await capture({ text: "  Ask Jamie Lopez for the studio quote  ", surface: "cli" });
    expect(res.status).toBe(201);
    const entry = (await res.json()) as NoteEntry;
    expect(entry.text).toBe("Ask Jamie Lopez for the studio quote");
    expect(entry.surface).toBe("cli");
    expect(entry.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const row = db
      .prepare<[string], { text: string }>("SELECT text FROM note_entries WHERE id = ?")
      .get(entry.id);
    expect(row?.text).toBe("Ask Jamie Lopez for the studio quote");

    // The day document projects through DocumentService.ingest.
    await notesRuntime!.flushAll();
    const doc = db
      .prepare<
        [string],
        { external_id: string; metadata: string }
      >(`SELECT external_id, metadata FROM documents WHERE source_id = '${OMNESIS_NOTES_SOURCE_ID}' AND external_id = ?`)
      .get(entry.day);
    expect(doc).toBeTruthy();
    expect(JSON.parse(doc!.metadata)).toMatchObject({
      documentType: "note",
      addressedToAgent: true,
    });
  });

  test("a client id makes POST idempotent — a retry returns the stored entry, no duplicate", async () => {
    const id = "6c1f7f6e-8f7a-4a1a-9b3e-2d4c5e6f7a8b";
    const first = await capture({ id, text: "Renew the domain" });
    expect(first.status).toBe(201);
    const firstEntry = (await first.json()) as NoteEntry;
    expect(firstEntry.id).toBe(id);

    const retry = await capture({ id, text: "Renew the domain" });
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as NoteEntry).id).toBe(id);

    const count = db
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM note_entries WHERE id = ?")
      .get(id);
    expect(count?.n).toBe(1);
  });

  test("preserves capture timezone context and stamps gateway receipt", async () => {
    const res = await capture({
      text: "Late travel note",
      capturedAt: "2026-08-14T23:30:00.000Z",
      capturedTimeZoneId: "Europe/Helsinki",
      capturedUtcOffsetSeconds: 10_800,
    });
    expect(res.status).toBe(201);
    const entry = (await res.json()) as NoteEntry;
    expect(entry.day).toBe("2026-08-15");
    expect(entry.capturedTimeZoneId).toBe("Europe/Helsinki");
    expect(entry.capturedUtcOffsetSeconds).toBe(10_800);
    expect(Number.isNaN(Date.parse(entry.receivedAt!))).toBe(false);
  });

  test("rejects a malformed client id with 400", async () => {
    expect((await capture({ id: "not-a-uuid", text: "x" })).status).toBe(400);
  });

  test("rejects blank / missing / oversized text with 400", async () => {
    expect((await capture({ text: "   " })).status).toBe(400);
    expect((await capture({})).status).toBe(400);
    expect((await capture({ text: "x".repeat(8193) })).status).toBe(400);
  });

  test("rejects a malformed surface slug and unknown fields", async () => {
    expect((await capture({ text: "ok", surface: "Not A Slug!" })).status).toBe(400);
    expect((await capture({ text: "ok", nonsense: true })).status).toBe(400);
  });

  test("rejects incomplete or out-of-range capture timezone context", async () => {
    expect((await capture({ text: "ok", capturedTimeZoneId: "Europe/London" })).status).toBe(400);
    expect((await capture({ text: "ok", capturedUtcOffsetSeconds: 0 })).status).toBe(400);
    expect(
      (
        await capture({
          text: "ok",
          capturedTimeZoneId: "Europe/London",
          capturedUtcOffsetSeconds: 70_000,
        })
      ).status,
    ).toBe(400);
  });

  test("rejects invalid or oversized capture timezone identifiers", async () => {
    expect(
      (
        await capture({
          text: "ok",
          capturedTimeZoneId: "Mars/Olympus_Mons",
          capturedUtcOffsetSeconds: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await capture({
          text: "ok",
          capturedTimeZoneId: "x".repeat(65),
          capturedUtcOffsetSeconds: 0,
        })
      ).status,
    ).toBe(400);
  });

  test("stores a geotagged capture and returns the location on the entry", async () => {
    const res = await capture({
      text: "Scout this venue",
      surface: "ios-siri",
      latitude: 51.5074,
      longitude: -0.1278,
      placeName: "London",
    });
    expect(res.status).toBe(201);
    const entry = (await res.json()) as NoteEntry;
    expect(entry.latitude).toBeCloseTo(51.5074, 4);
    expect(entry.longitude).toBeCloseTo(-0.1278, 4);
    expect(entry.placeName).toBe("London");

    await notesRuntime!.flushAll();
    const doc = db
      .prepare<
        [string],
        { content: string }
      >(`SELECT content FROM documents WHERE source_id = '${OMNESIS_NOTES_SOURCE_ID}' AND external_id = ?`)
      .get(entry.day);
    expect(doc?.content).toContain("· London");
  });

  test("rejects a half-pair, out-of-range coordinates, a null coordinate, and a lone place name", async () => {
    // Either coordinate without the other.
    expect((await capture({ text: "ok", latitude: 51.5 })).status).toBe(400);
    expect((await capture({ text: "ok", longitude: 0.1 })).status).toBe(400);
    // Out of range, both bounds, both axes.
    expect((await capture({ text: "ok", latitude: 91, longitude: 0 })).status).toBe(400);
    expect((await capture({ text: "ok", latitude: -91, longitude: 0 })).status).toBe(400);
    expect((await capture({ text: "ok", latitude: 0, longitude: 181 })).status).toBe(400);
    expect((await capture({ text: "ok", latitude: 0, longitude: -181 })).status).toBe(400);
    // An explicit JSON null (the client omits keys instead — `.optional()`
    // accepts absent, not null).
    expect((await capture({ text: "ok", latitude: null, longitude: null })).status).toBe(400);
    // A place name with no coordinate — it's derived from the fix, so it
    // never travels alone.
    expect((await capture({ text: "ok", placeName: "Nowhere" })).status).toBe(400);
    // A boundary coordinate (exactly ±90/±180) at (0,0) is accepted.
    expect((await capture({ text: "ok", latitude: 90, longitude: -180 })).status).toBe(201);
  });

  test("normalizes newlines/whitespace in placeName so the day-doc heading stays one line", async () => {
    const res = await capture({
      text: "note",
      latitude: 48.8566,
      longitude: 2.3522,
      placeName: "Paris\n## injected",
    });
    expect(res.status).toBe(201);
    const entry = (await res.json()) as NoteEntry;
    expect(entry.placeName).toBe("Paris ## injected");

    await notesRuntime!.flushAll();
    const doc = db
      .prepare<
        [string],
        { content: string }
      >(`SELECT content FROM documents WHERE source_id = '${OMNESIS_NOTES_SOURCE_ID}' AND external_id = ?`)
      .get(entry.day);
    // The heading is a single line — the injected newline can't open a
    // second `##` section.
    const headingLines = (doc?.content ?? "").split("\n").filter((l) => l.startsWith("## "));
    expect(headingLines).toHaveLength(1);
    expect(headingLines[0]).toContain("· Paris ## injected");
  });

  test("requires a write scope: read-only token → 403, wrong write scope → 403", async () => {
    const readOnly = mintToken([SCOPE_READ]);
    expect((await capture({ text: "hi" }, readOnly)).status).toBe(403);
    const wrongWrite = mintToken([SCOPE_READ, Scope("write:gmail")]);
    expect((await capture({ text: "hi" }, wrongWrite)).status).toBe(403);
  });

  test("a write:omnesis-notes token can capture", async () => {
    const scoped = mintToken([Scope("write:omnesis-notes")]);
    expect((await capture({ text: "scoped capture" }, scoped)).status).toBe(201);
  });

  test("requires auth", async () => {
    const res = await app.request("/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /notes", () => {
  test("lists a day's entries in capture order; defaults to today", async () => {
    const a = (await (await capture({ text: "first" })).json()) as NoteEntry;
    const b = (await (await capture({ text: "second" })).json()) as NoteEntry;

    const res = await req(`/notes?day=${a.day}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { day: string; entries: NoteEntry[] };
    expect(body.day).toBe(a.day);
    expect(body.entries.map((e) => e.id)).toEqual([a.id, b.id]);

    const today = await req("/notes");
    expect(today.status).toBe(200);
    const todayBody = (await today.json()) as { day: string; entries: NoteEntry[] };
    expect(todayBody.day).toBe(a.day);
    expect(todayBody.entries).toHaveLength(2);
  });

  test("an empty day returns an empty list, not an error", async () => {
    const res = await req("/notes?day=1999-01-01");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ day: "1999-01-01", entries: [] });
  });

  test("rejects a malformed day param", async () => {
    expect((await req("/notes?day=nonsense")).status).toBe(400);
    expect((await req("/notes?day=2026-6-1")).status).toBe(400);
  });
});

describe("PATCH /notes/:id", () => {
  test("edits the entry text; 404 for an unknown id", async () => {
    const entry = (await (await capture({ text: "Call the plumber" })).json()) as NoteEntry;
    const res = await req(`/notes/${entry.id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "Call the plumber — quote first" }),
    });
    expect(res.status).toBe(200);
    const edited = (await res.json()) as NoteEntry;
    expect(edited.text).toBe("Call the plumber — quote first");

    const missing = await req("/notes/unknown-id", {
      method: "PATCH",
      body: JSON.stringify({ text: "x" }),
    });
    expect(missing.status).toBe(404);
  });

  test("requires a write scope", async () => {
    const entry = (await (await capture({ text: "note" })).json()) as NoteEntry;
    const readOnly = mintToken([SCOPE_READ]);
    const res = await req(
      `/notes/${entry.id}`,
      { method: "PATCH", body: JSON.stringify({ text: "x" }) },
      readOnly,
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /notes/:id", () => {
  test("removes the entry (204); 404 for an unknown id; day doc is dropped when empty", async () => {
    const entry = (await (await capture({ text: "Transient" })).json()) as NoteEntry;
    await notesRuntime!.flushAll();
    const docCount = (): number =>
      (
        db
          .prepare<
            [],
            { n: number }
          >(`SELECT COUNT(*) AS n FROM documents WHERE source_id = '${OMNESIS_NOTES_SOURCE_ID}'`)
          .get() as { n: number }
      ).n;
    expect(docCount()).toBe(1);

    const res = await req(`/notes/${entry.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    await notesRuntime!.flushAll();
    expect(docCount()).toBe(0);

    expect((await req(`/notes/${entry.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("requires a write scope", async () => {
    const entry = (await (await capture({ text: "note" })).json()) as NoteEntry;
    const readOnly = mintToken([SCOPE_READ]);
    const res = await req(`/notes/${entry.id}`, { method: "DELETE" }, readOnly);
    expect(res.status).toBe(403);
  });
});

function notesDocCount(): number {
  return db
    .prepare<
      [],
      { n: number }
    >(`SELECT COUNT(*) AS n FROM documents WHERE source_id = '${OMNESIS_NOTES_SOURCE_ID}'`)
    .get()!.n;
}

function notesDocContent(day: string): string | null {
  const row = db
    .prepare<
      [string],
      { content: string }
    >(`SELECT content FROM documents WHERE source_id = '${OMNESIS_NOTES_SOURCE_ID}' AND external_id = ?`)
    .get(day);
  return row?.content ?? null;
}

function notesDocId(day: string): string {
  const row = db
    .prepare<
      [string],
      { id: string }
    >(`SELECT id FROM documents WHERE source_id = '${OMNESIS_NOTES_SOURCE_ID}' AND external_id = ?`)
    .get(day);
  if (!row) throw new Error(`no projected notes doc for day ${day}`);
  return row.id;
}

function notesTombstoneCount(): number {
  return db
    .prepare<
      [],
      { n: number }
    >(`SELECT COUNT(*) AS n FROM removed_documents WHERE source_id = '${OMNESIS_NOTES_SOURCE_ID}'`)
    .get()!.n;
}

const UTC_DAY = { capturedTimeZoneId: "UTC", capturedUtcOffsetSeconds: 0 };

describe("note edit/delete → day projection", () => {
  test("edit updates, single delete drops, last delete removes, recapture rebuilds", async () => {
    const a = (await (
      await capture({ text: "alpha original", capturedAt: "2026-03-01T10:00:00.000Z", ...UTC_DAY })
    ).json()) as NoteEntry;
    const b = (await (
      await capture({ text: "beta note", capturedAt: "2026-03-01T11:00:00.000Z", ...UTC_DAY })
    ).json()) as NoteEntry;
    expect(a.day).toBe("2026-03-01");
    expect(b.day).toBe("2026-03-01");
    await notesRuntime!.flushAll();

    let content = notesDocContent("2026-03-01");
    expect(content).toContain("alpha original");
    expect(content).toContain("beta note");

    // Edit one of two: the projection carries the new text, sibling kept.
    expect(
      (
        await req(`/notes/${a.id}`, {
          method: "PATCH",
          body: JSON.stringify({ text: "alpha amended" }),
        })
      ).status,
    ).toBe(200);
    await notesRuntime!.flushAll();
    content = notesDocContent("2026-03-01");
    expect(content).toContain("alpha amended");
    expect(content).not.toContain("alpha original");
    expect(content).toContain("beta note");

    // Delete one: removed from the document, sibling retained.
    expect((await req(`/notes/${b.id}`, { method: "DELETE" })).status).toBe(204);
    await notesRuntime!.flushAll();
    content = notesDocContent("2026-03-01");
    expect(content).toContain("alpha amended");
    expect(content).not.toContain("beta note");

    // Delete the last: the generated document goes away.
    expect((await req(`/notes/${a.id}`, { method: "DELETE" })).status).toBe(204);
    await notesRuntime!.flushAll();
    expect(notesDocContent("2026-03-01")).toBeNull();
    expect(notesDocCount()).toBe(0);

    // A later capture the same day rebuilds the document with only the new note.
    const c = (await (
      await capture({ text: "gamma arrives", capturedAt: "2026-03-01T12:00:00.000Z", ...UTC_DAY })
    ).json()) as NoteEntry;
    expect(c.day).toBe("2026-03-01");
    await notesRuntime!.flushAll();
    content = notesDocContent("2026-03-01");
    expect(content).toContain("gamma arrives");
    expect(content).not.toContain("alpha amended");
  });
});

describe("generated day documents are read-only", () => {
  test("direct user deletion is refused without a tombstone; later captures stay searchable", async () => {
    const a = (await (
      await capture({ text: "keep me", capturedAt: "2026-03-02T10:00:00.000Z", ...UTC_DAY })
    ).json()) as NoteEntry;
    await notesRuntime!.flushAll();
    const docId = notesDocId(a.day);

    for (const suffix of ["", "?tombstone=0"]) {
      const res = await req(`/documents/${docId}${suffix}`, { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "MANAGE_ORIGINAL_NOTES" });
    }
    expect(notesTombstoneCount()).toBe(0);
    expect(notesDocContent(a.day)).toContain("keep me");

    // The batch collector path refuses the same way.
    const batch = await req("/documents/delete", {
      method: "POST",
      body: JSON.stringify({
        providerId: OMNESIS_NOTES_PROVIDER_ID,
        sourceId: OMNESIS_NOTES_SOURCE_ID,
        externalIds: [a.day],
      }),
    });
    expect(batch.status).toBe(409);
    expect(await batch.json()).toMatchObject({ code: "MANAGE_ORIGINAL_NOTES" });
    expect(notesTombstoneCount()).toBe(0);

    // No suppression: a later capture the same day still becomes searchable.
    await capture({ text: "still indexed", capturedAt: "2026-03-02T11:00:00.000Z", ...UTC_DAY });
    await notesRuntime!.flushAll();
    const content = notesDocContent(a.day);
    expect(content).toContain("keep me");
    expect(content).toContain("still indexed");
  });

  test("ingest, reconcile, with-cursor and source wipe refuse the internal source", async () => {
    const a = (await (
      await capture({ text: "untouchable", capturedAt: "2026-03-05T10:00:00.000Z", ...UTC_DAY })
    ).json()) as NoteEntry;
    await notesRuntime!.flushAll();
    expect(notesDocContent(a.day)).toContain("untouchable");

    const doc = {
      providerId: OMNESIS_NOTES_PROVIDER_ID,
      sourceId: OMNESIS_NOTES_SOURCE_ID,
      externalId: a.day,
      title: "Notes for 2026-03-05",
      content: "attacker-controlled mirror",
      contentHash: "sha256:forge",
      metadata: {},
      sourceCreatedAt: "2026-03-05T10:00:00.000Z",
      sourceUpdatedAt: "2026-03-05T10:00:00.000Z",
    };
    const ingest = await req("/documents", {
      method: "POST",
      body: JSON.stringify({ documents: [doc] }),
    });
    expect(ingest.status).toBe(409);
    expect(await ingest.json()).toMatchObject({ code: "MANAGE_ORIGINAL_NOTES" });

    const reconcile = await req("/documents/reconcile", {
      method: "POST",
      body: JSON.stringify({
        providerId: OMNESIS_NOTES_PROVIDER_ID,
        sourceId: OMNESIS_NOTES_SOURCE_ID,
        presentExternalIds: [],
      }),
    });
    expect(reconcile.status).toBe(409);
    expect(await reconcile.json()).toMatchObject({ code: "MANAGE_ORIGINAL_NOTES" });

    const page = await req("/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify({
        providerId: OMNESIS_NOTES_PROVIDER_ID,
        sourceId: OMNESIS_NOTES_SOURCE_ID,
        documents: [doc],
        hasMore: false,
        cursor: {},
      }),
    });
    expect(page.status).toBe(409);
    expect(await page.json()).toMatchObject({ code: "MANAGE_ORIGINAL_NOTES" });

    const wipe = await req(`/documents/delete-all/source/${OMNESIS_NOTES_SOURCE_ID}`, {
      method: "POST",
    });
    expect(wipe.status).toBe(409);
    expect(await wipe.json()).toMatchObject({ code: "MANAGE_ORIGINAL_NOTES" });

    // The ledger mirror is exactly as the projection left it.
    expect(notesDocContent(a.day)).toContain("untouchable");
    expect(notesDocContent(a.day)).not.toContain("attacker-controlled");
    expect(notesTombstoneCount()).toBe(0);
  });
});

describe("GET /notes/history", () => {
  async function captureOnDay(text: string, day: string, hour: number): Promise<NoteEntry> {
    const res = await capture({
      text,
      capturedAt: `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`,
      ...UTC_DAY,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as NoteEntry;
  }

  test("newest-first pages across days with stable cursors and no duplicates", async () => {
    await captureOnDay("day one note", "2026-04-01", 10);
    await captureOnDay("day two note", "2026-04-02", 10);
    const newest = await captureOnDay("day three note", "2026-04-03", 10);

    const first = await req("/notes/history?limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      entries: NoteEntry[];
      pageInfo: { hasMore: boolean; limit: number; nextCursor?: string };
    };
    expect(firstBody.entries.map((e) => e.text)).toEqual(["day three note", "day two note"]);
    expect(firstBody.pageInfo.hasMore).toBe(true);
    expect(typeof firstBody.pageInfo.nextCursor).toBe("string");

    const second = await req(
      `/notes/history?limit=2&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor!)}`,
    );
    const secondBody = (await second.json()) as {
      entries: NoteEntry[];
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(secondBody.entries.map((e) => e.text)).toEqual(["day one note"]);
    expect(secondBody.pageInfo.hasMore).toBe(false);
    expect(secondBody.pageInfo.nextCursor).toBeUndefined();
    expect(newest.day).toBe("2026-04-03");
  });

  test("a long single day paginates without duplicates", async () => {
    for (let i = 0; i < 7; i++) {
      await captureOnDay(`bulk note ${i}`, "2026-05-01", 10);
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const res = await req(
        `/notes/history?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        entries: NoteEntry[];
        pageInfo: { hasMore: boolean; nextCursor?: string };
      };
      pages += 1;
      for (const entry of body.entries) {
        expect(entry.day).toBe("2026-05-01");
        expect(seen.has(entry.id)).toBe(false);
        seen.add(entry.id);
      }
      if (!body.pageInfo.hasMore) break;
      cursor = body.pageInfo.nextCursor!;
      expect(pages).toBeLessThan(10);
    }
    expect(seen.size).toBe(7);
    expect(pages).toBe(3);
  });

  test("a concurrent capture never shifts an in-flight page", async () => {
    await captureOnDay("older one", "2026-06-01", 10);
    await captureOnDay("older two", "2026-06-01", 11);
    const first = (await (await req("/notes/history?limit=1")).json()) as {
      entries: NoteEntry[];
      pageInfo: { nextCursor: string };
    };
    await captureOnDay("brand new", "2026-06-02", 10);
    const second = (await (
      await req(`/notes/history?limit=5&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
    ).json()) as { entries: NoteEntry[] };
    expect(second.entries.map((e) => e.text)).toEqual(["older one"]);
  });

  test("a day seed lands on that day and an emptied day falls back to older notes", async () => {
    const oldDay = await captureOnDay("old note", "2026-07-01", 10);
    const mid = await captureOnDay("mid note", "2026-07-02", 10);
    await captureOnDay("new note", "2026-07-03", 10);

    const seeded = (await (await req("/notes/history?limit=5&day=2026-07-02")).json()) as {
      entries: NoteEntry[];
      pageInfo: { hasMore: boolean };
    };
    expect(seeded.entries.map((e) => e.text)).toEqual(["mid note", "old note"]);
    expect(seeded.pageInfo.hasMore).toBe(false);

    // Empty the seeded day entirely: the same link resolves empty rather
    // than failing, and never leaks newer days.
    expect((await req(`/notes/${mid.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await req(`/notes/${oldDay.id}`, { method: "DELETE" })).status).toBe(204);
    const fallback = (await (await req("/notes/history?limit=5&day=2026-07-02")).json()) as {
      entries: NoteEntry[];
    };
    expect(fallback.entries).toEqual([]);

    const fresh = await captureOnDay("fresh note", "2026-07-04", 10);
    expect(fresh.day).toBe("2026-07-04");
    const relinked = (await (await req("/notes/history?limit=5&day=2026-07-02")).json()) as {
      entries: NoteEntry[];
    };
    expect(relinked.entries).toEqual([]);
  });

  test("rejects malformed limit, cursor, and day", async () => {
    expect((await req("/notes/history?limit=0")).status).toBe(400);
    expect((await req("/notes/history?limit=nonsense")).status).toBe(400);
    // parseInt coercions are refused, not silently rounded.
    expect((await req("/notes/history?limit=2.5")).status).toBe(400);
    expect((await req("/notes/history?limit=25abc")).status).toBe(400);
    expect((await req("/notes/history?cursor=!!!not-base64!!!")).status).toBe(400);
    expect(
      (
        await req(
          `/notes/history?cursor=${encodeURIComponent(Buffer.from("{}", "utf8").toString("base64url"))}`,
        )
      ).status,
    ).toBe(400);
    // A well-formed cursor envelope with a non-date position is malformed.
    const forged = Buffer.from(JSON.stringify({ c: "not-a-date", i: "x" }), "utf8").toString(
      "base64url",
    );
    expect((await req(`/notes/history?cursor=${encodeURIComponent(forged)}`)).status).toBe(400);
    expect((await req("/notes/history?day=07-02")).status).toBe(400);
  });

  test("day and cursor are mutually exclusive", async () => {
    await captureOnDay("seeded", "2026-07-10", 10);
    const first = (await (await req("/notes/history?limit=1")).json()) as {
      pageInfo: { nextCursor: string };
    };
    const res = await req(
      `/notes/history?day=2026-07-10&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("mutually exclusive"),
    });
  });

  test("history is readable with a read scope; unauthenticated reads are refused", async () => {
    await captureOnDay("readable", "2026-07-11", 10);
    const readOnly = mintToken([SCOPE_READ]);
    const res = await req("/notes/history?limit=5", {}, readOnly);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: NoteEntry[] };
    expect(body.entries.map((e) => e.text)).toEqual(["readable"]);

    const bare = await app.request("/notes/history");
    expect(bare.status).toBe(401);
  });

  test("an oversized limit clamps to the maximum instead of failing", async () => {
    const res = await req("/notes/history?limit=500");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pageInfo: { limit: 100 } });
  });
});

describe("restart persistence", () => {
  test("deleted notes stay deleted across a gateway restart; live ones rebuild", async () => {
    const restartPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    const boot = (): {
      handle: Db;
      server: ReturnType<typeof createServer>;
      runtime: () => OmnesisNotesRuntime;
      bearer: string;
    } => {
      const handle = createDatabase(restartPath);
      let rt: OmnesisNotesRuntime | undefined;
      const server = createServer(handle, restartPath, {
        onOmnesisNotesRuntime: (r) => {
          rt = r;
        },
      });
      return {
        handle,
        server,
        runtime: () => rt!,
        bearer: createToken(
          handle,
          createDevice(handle, { name: `restart-${randomUUID()}`, kind: "cli" }).id,
          [SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL],
        ).token,
      };
    };
    const call = (
      server: ReturnType<typeof createServer>,
      bearer: string,
      path: string,
      init: RequestInit = {},
    ): Promise<Response> =>
      server.request(path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
          ...init.headers,
        },
      });
    const countDocs = (handle: Db): number =>
      (
        handle
          .prepare<
            [],
            { n: number }
          >(`SELECT COUNT(*) AS n FROM documents WHERE source_id = '${OMNESIS_NOTES_SOURCE_ID}'`)
          .get() as { n: number }
      ).n;

    const first = boot();
    const gone = (await (
      await call(first.server, first.bearer, "/notes", {
        method: "POST",
        body: JSON.stringify({ text: "doomed", capturedAt: "2026-08-01T10:00:00.000Z" }),
      })
    ).json()) as NoteEntry;
    const kept = (await (
      await call(first.server, first.bearer, "/notes", {
        method: "POST",
        body: JSON.stringify({ text: "stays", capturedAt: "2026-08-01T11:00:00.000Z" }),
      })
    ).json()) as NoteEntry;
    await first.runtime().flushAll();
    expect(countDocs(first.handle)).toBe(1);

    // Delete one note, then restart before anything else happens.
    expect(
      (await call(first.server, first.bearer, `/notes/${gone.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    await first.runtime().flushAll();
    first.runtime().dispose();
    first.handle.close();

    // Boot again on the same file: reconciliation must not resurrect the
    // deleted note, and the surviving day keeps its document.
    const second = boot();
    await second.runtime().flushAll();
    expect(countDocs(second.handle)).toBe(1);
    const content = (
      second.handle
        .prepare<
          [string],
          { content: string }
        >(`SELECT content FROM documents WHERE source_id = '${OMNESIS_NOTES_SOURCE_ID}' AND external_id = ?`)
        .get(kept.day) as { content: string }
    ).content;
    expect(content).toContain("stays");
    expect(content).not.toContain("doomed");
    await second.runtime().flushAll();
    second.runtime().dispose();
    second.handle.close();
    cleanupDb(restartPath);
  });
});

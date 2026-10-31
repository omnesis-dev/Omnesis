// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { expectUnchangedUpstreamIsNoOp } from "@omnesis/source-sdk/testing";
import { memoryAlbumStore } from "./album-store.js";
import { ImmichClient } from "./client.js";
import { ImmichAssetSource, type ImmichAssetSourceOptions } from "./source.js";
import { immichStateSpec } from "./state.js";
import { SimulatedImmich, type SimulatedImmichCorpus } from "./testing/simulated-immich.js";
import type { SyncResult } from "@omnesis/source-sdk";
import type { ImmichAsset, ImmichCursor } from "./types.js";

const BASE = "http://immich.example.com:2283";
const SELF = { id: "u-self", email: "maya.reeves@example.com", name: "Maya Reeves" };
const PARTNER = { id: "u-partner", email: "jamie.lopez@example.com", name: "Jamie Lopez" };
const KEY = "simulated-key";
const ALL_READ = ["asset.read", "album.read", "user.read"];

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function asset(n: number, over: Partial<ImmichAsset> = {}): ImmichAsset {
  const day = String(1 + (n % 27)).padStart(2, "0");
  return {
    id: uuid(n),
    ownerId: SELF.id,
    type: "IMAGE",
    originalFileName: `IMG_${String(n).padStart(4, "0")}.HEIC`,
    fileCreatedAt: `2026-05-${day}T09:00:${String(n % 60).padStart(2, "0")}.000Z`,
    localDateTime: `2026-05-${day}T11:00:00.000Z`,
    updatedAt: "2026-06-01T00:00:00.000Z",
    isFavorite: false,
    isArchived: false,
    isTrashed: false,
    visibility: "timeline",
    duration: null,
    checksum: `checksum-${n}`,
    exifInfo: {
      dateTimeOriginal: `2026-05-${day}T09:00:${String(n % 60).padStart(2, "0")}.000Z`,
      timeZone: "Europe/Lisbon",
      city: "Example City",
      country: "Exampleland",
      description: n === 1 ? "Picnic by the river" : null,
    },
    people: n === 1 ? [{ id: "p-sarah", name: "Sarah Mendez" }] : [],
    ...over,
  };
}

function corpus(
  assets: ImmichAsset[],
  extra: Partial<SimulatedImmichCorpus> = {},
): SimulatedImmichCorpus {
  return {
    users: [SELF, PARTNER],
    keys: [{ key: KEY, userId: SELF.id, permissions: ALL_READ }],
    assets,
    albums: [
      {
        id: uuid(900),
        albumName: "Harbour Weekend",
        ownerId: SELF.id,
        assetIds: [uuid(1), uuid(2)],
      },
    ],
    partnerships: [{ sharedBy: PARTNER.id, sharedWith: SELF.id, inTimeline: true }],
    ...extra,
  };
}

class Clock {
  constructor(private t = Date.parse("2026-06-02T00:00:00.000Z")) {}
  now = () => new Date(this.t).toISOString();
  advance(ms: number) {
    this.t += ms;
  }
}

function harness(
  server: SimulatedImmich,
  opts: ImmichAssetSourceOptions = {},
  clock = new Clock(),
) {
  const client = new ImmichClient(BASE, KEY, { fetchImpl: server.fetch });
  const source = new ImmichAssetSource(
    client,
    ProviderId("immich:maya.reeves@example.com"),
    SourceId("immich:maya.reeves@example.com"),
    SELF.email,
    { pageSize: 2, now: clock.now, ...opts },
  );
  return { source, clock };
}

/** Run pages until the cycle ends; return every page. */
async function cycle(
  source: ImmichAssetSource,
  cursor: ImmichCursor | null,
): Promise<{ pages: SyncResult<ImmichCursor>[]; cursor: ImmichCursor }> {
  const pages: SyncResult<ImmichCursor>[] = [];
  let current = cursor;
  for (let i = 0; i < 100; i++) {
    const page = await source.sync(current);
    pages.push(page);
    current = page.cursor;
    if (!page.hasMore) return { pages, cursor: page.cursor };
  }
  throw new Error("sync never finished");
}

/** Mark an asset updated at a given server time; `editAsset` stamps its own clock. */
function touch(server: SimulatedImmich, id: string, at: string): void {
  server.assets.get(id)!.updatedAt = at;
}

const ids = (pages: SyncResult<ImmichCursor>[]) =>
  pages.flatMap((p) => p.documents.map((d) => d.externalId)).sort();

describe("ImmichAssetSource", () => {
  it("bootstraps every own asset over several pages and reports them all present", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3), asset(4), asset(5)]));
    const { source } = harness(server);

    const { pages, cursor } = await cycle(source, null);

    expect(pages.length).toBe(3);
    expect(pages.slice(0, -1).every((p) => p.presentExternalIds === undefined)).toBe(true);
    expect(ids(pages)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)]);
    expect(pages.at(-1)!.presentExternalIds?.sort()).toEqual(ids(pages));
    expect(cursor).toMatchObject({ phase: "incremental", syncedUpTo: "2026-06-02T00:00:00.000Z" });
    expect(cursor.page).toBeUndefined();
    expect(cursor.snapshot).toBeUndefined();
    expect(cursor.lastSnapshotAt).toBe("2026-06-02T00:00:00.000Z");
  });

  it("carries album membership onto every asset of a full sweep", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3)]));
    const { source } = harness(server);
    const { pages } = await cycle(source, null);
    const byId = new Map(pages.flatMap((p) => p.documents).map((d) => [d.externalId, d]));
    expect(byId.get(uuid(1))!.metadata.extra?.albums).toEqual(["Harbour Weekend"]);
    expect(byId.get(uuid(3))!.metadata.extra?.albums).toEqual([]);
  });

  it("an incremental tick over an unchanged library emits nothing", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3)]));
    const { source, clock } = harness(server);
    const first = await cycle(source, null);
    clock.advance(30 * 60 * 1000);

    const second = await cycle(source, first.cursor);

    expect(second.pages.length).toBe(1);
    expect(second.pages[0]!.documents).toEqual([]);
    expect(second.pages[0]!.presentExternalIds).toBeUndefined();
    expect(second.pages[0]!.deletedExternalIds).toEqual([]);
    const search = server.calls.filter((c) => c.path === "/search/metadata").at(-1)!;
    expect(search.body).toMatchObject({
      updatedAfter: "2026-06-01T23:55:00.000Z",
      updatedBefore: "2026-06-02T00:30:00.000Z",
      withDeleted: true,
    });
  });

  it("an incremental tick yields only the asset that changed", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3)]));
    const { source, clock } = harness(server);
    const first = await cycle(source, null);
    clock.advance(30 * 60 * 1000);
    server.editAsset(uuid(2), (a) => {
      a.exifInfo = { ...a.exifInfo, description: "Sunset over the bay" };
      a.updatedAt = "2026-06-02T00:10:00.000Z";
    });
    server.assets.get(uuid(2))!.updatedAt = "2026-06-02T00:10:00.000Z";

    const second = await cycle(source, first.cursor);

    expect(ids(second.pages)).toEqual([uuid(2)]);
    expect(second.pages[0]!.documents[0]!.title).toBe("Sunset over the bay");
  });

  it("reports a trashed asset once, as a deletion, on an incremental tick", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2)]));
    const { source, clock } = harness(server);
    const first = await cycle(source, null);
    clock.advance(30 * 60 * 1000);
    server.trashAsset(uuid(2));
    server.assets.get(uuid(2))!.updatedAt = "2026-06-02T00:10:00.000Z";

    const second = await cycle(source, first.cursor);
    expect(second.pages[0]!.deletedExternalIds).toEqual([uuid(2)]);
    expect(second.pages[0]!.documents).toEqual([]);

    // The daily rewalk leaves it out of the presence list instead of naming
    // the deletion again.
    clock.advance(24 * 60 * 60 * 1000);
    const third = await cycle(source, second.cursor);
    expect(third.pages.flatMap((p) => p.deletedExternalIds)).toEqual([]);
    expect(third.pages.at(-1)!.presentExternalIds).toEqual([uuid(1)]);
  });

  it("finds a hard delete through the daily rewalk", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3)]));
    const { source, clock } = harness(server);
    const first = await cycle(source, null);
    server.deleteAsset(uuid(3));

    clock.advance(60 * 60 * 1000);
    const early = await cycle(source, first.cursor);
    expect(early.pages.at(-1)!.presentExternalIds).toBeUndefined();

    clock.advance(24 * 60 * 60 * 1000);
    const rewalk = await cycle(source, early.cursor);
    expect(rewalk.pages.at(-1)!.presentExternalIds?.sort()).toEqual([uuid(1), uuid(2)]);
    expect(rewalk.cursor.lastSnapshotAt).toBe(clock.now());
  });

  it("leaves a partner's shared assets out of the documents and the presence list", async () => {
    const shared = asset(7, { ownerId: PARTNER.id });
    const server = new SimulatedImmich(corpus([asset(1), shared]));

    const owned = await cycle(harness(server).source, null);
    expect(ids(owned.pages)).toEqual([uuid(1)]);
    expect(owned.pages.at(-1)!.presentExternalIds).toEqual([uuid(1)]);
    // Nothing reads who partners are.
    expect(server.calls.some((c) => c.path.startsWith("/partners"))).toBe(false);
  });

  it("skips live-photo motion parts and locked assets", async () => {
    const server = new SimulatedImmich(
      corpus([
        asset(1),
        asset(2, { type: "VIDEO", visibility: "hidden" }),
        asset(3, { visibility: "locked" }),
      ]),
    );
    const { pages } = await cycle(harness(server).source, null);
    expect(ids(pages)).toEqual([uuid(1)]);
    expect(pages.at(-1)!.presentExternalIds).toEqual([uuid(1)]);
  });

  it("skips a malformed asset but still counts it present", async () => {
    const broken = asset(2, { fileCreatedAt: "not-a-date", updatedAt: "2026-06-01T00:00:00.000Z" });
    const server = new SimulatedImmich(corpus([asset(1), broken]));
    const { pages } = await cycle(harness(server, { pageSize: 10 }).source, null);
    expect(ids(pages)).toEqual([uuid(1)]);
    expect(pages.at(-1)!.presentExternalIds?.sort()).toEqual([uuid(1), uuid(2)]);
  });

  it("keeps the previous album index when albums cannot be read", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2)]));
    const { source, clock } = harness(server);
    const first = await cycle(source, null);

    server.failNext(500, "GET /albums");
    clock.advance(24 * 60 * 60 * 1000);
    const rewalk = await cycle(source, first.cursor);

    const doc = rewalk.pages.flatMap((p) => p.documents).find((d) => d.externalId === uuid(1))!;
    expect(doc.metadata.extra?.albums).toEqual(["Harbour Weekend"]);
    expect(rewalk.pages.at(-1)!.issues).toEqual([
      expect.objectContaining({ subject: "Album names", kind: "transient" }),
    ]);
  });

  it("names the album on an own photo added to an album someone else shared", async () => {
    const server = new SimulatedImmich(
      corpus([asset(1), asset(2), asset(7, { ownerId: PARTNER.id })], {
        albums: [
          {
            id: uuid(901),
            albumName: "Studio Northstar Open Day",
            ownerId: PARTNER.id,
            sharedWith: [SELF.id],
            assetIds: [uuid(2), uuid(7)],
          },
        ],
      }),
    );
    const { pages } = await cycle(harness(server).source, null);
    const byId = new Map(pages.flatMap((p) => p.documents).map((d) => [d.externalId, d]));
    expect(byId.get(uuid(2))!.metadata.extra?.albums).toEqual(["Studio Northstar Open Day"]);
    // The album owner's own photo in it stays theirs.
    expect(byId.has(uuid(7))).toBe(false);
  });

  it("keeps the album index beside the cursor and reads it back after a restart", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3)]));
    const albumStore = memoryAlbumStore();
    const clock = new Clock();
    const first = await cycle(harness(server, { albumStore }, clock).source, null);
    expect(JSON.stringify(first.cursor)).not.toContain("Harbour Weekend");

    // A new instance — a collector restart — over the same store.
    clock.advance(30 * 60 * 1000);
    touch(server, uuid(1), "2026-06-02T00:10:00.000Z");
    const albumReads = server.calls.filter((c) => c.path === "/albums").length;
    const second = await cycle(harness(server, { albumStore }, clock).source, first.cursor);

    expect(server.calls.filter((c) => c.path === "/albums").length).toBe(albumReads);
    expect(second.pages[0]!.documents[0]!.metadata.extra?.albums).toEqual(["Harbour Weekend"]);
  });

  it("reads albums again when the stored index was lost", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3)]));
    const clock = new Clock();
    const first = await cycle(harness(server, {}, clock).source, null);

    clock.advance(30 * 60 * 1000);
    touch(server, uuid(1), "2026-06-02T00:10:00.000Z");
    // A fresh, empty store: the file was deleted or could not be decrypted.
    const second = await cycle(
      harness(server, { albumStore: memoryAlbumStore() }, clock).source,
      first.cursor,
    );
    expect(second.pages[0]!.documents[0]!.metadata.extra?.albums).toEqual(["Harbour Weekend"]);
  });

  it("names a missing album permission with its remedy, and clears it once granted", async () => {
    const server = new SimulatedImmich(
      corpus([asset(1), asset(2)], {
        keys: [{ key: KEY, userId: SELF.id, permissions: ["asset.read", "user.read"] }],
      }),
    );
    const { source, clock } = harness(server);
    const first = await cycle(source, null);

    expect(ids(first.pages)).toEqual([uuid(1), uuid(2)]);
    const [issue] = first.pages.at(-1)!.issues!;
    expect(issue).toMatchObject({ kind: "permission", scope: "partition", subject: "Album names" });
    expect(issue!.message).toContain("without album names");
    expect(issue!.remediation?.summary).toContain("album.read");

    // An incremental tick does not reassess, so the warning stands…
    clock.advance(30 * 60 * 1000);
    const tick = await cycle(source, first.cursor);
    expect(tick.pages.at(-1)!.issues).toBeUndefined();

    // …until a full sweep reads the albums.
    server.keys[0]!.permissions.push("album.read");
    clock.advance(24 * 60 * 60 * 1000);
    const rewalk = await cycle(source, tick.cursor);
    expect(rewalk.pages.at(-1)!.issues).toEqual([]);
  });

  it("walks a multi-page incremental window twice, catching an asset its offsets stepped over", async () => {
    const assets = [1, 2, 3, 4, 5].map((n) => asset(n));
    const server = new SimulatedImmich(corpus(assets));
    const { source, clock } = harness(server);
    const first = await cycle(source, null);

    clock.advance(30 * 60 * 1000);
    for (const a of assets) touch(server, a.id, "2026-06-02T00:10:00.000Z");
    const page1 = await source.sync(first.cursor);
    expect(page1.documents.map((d) => d.externalId)).toEqual([uuid(1), uuid(2)]);

    // Edited again past the window's end: it leaves the window, and every
    // later asset moves up one place, so page 2 starts at asset 4.
    touch(server, uuid(1), "2026-06-02T01:00:00.000Z");
    const rest = await cycle(source, page1.cursor);

    const firstPass = rest.pages[0]!.documents.map((d) => d.externalId);
    expect(firstPass).toEqual([uuid(4), uuid(5)]);
    expect(rest.pages[0]!.cursor).toMatchObject({ page: 1, recheck: true });
    expect(ids(rest.pages)).toContain(uuid(3));
    expect(rest.cursor).toMatchObject({ phase: "incremental", syncedUpTo: clock.now() });
    expect(rest.cursor.recheck).toBeUndefined();
  });

  it("ends a window on the server's clock, so a collector running ahead misses no edit", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2)]));
    const clock = new Clock();
    // The server is ten minutes behind the collector.
    server.serverNow = () => new Date(Date.parse(clock.now()) - 10 * 60 * 1000);
    const { source } = harness(server, {}, clock);
    const first = await cycle(source, null);
    expect(first.cursor.syncedUpTo).toBe("2026-06-01T23:50:00.000Z");

    // Edited one minute later by the server's clock — before the collector's
    // "now" at the end of the first sync, so a window ended on that would
    // already have passed it.
    clock.advance(30 * 60 * 1000);
    touch(server, uuid(2), "2026-06-01T23:51:00.000Z");
    const second = await cycle(source, first.cursor);
    expect(ids(second.pages)).toEqual([uuid(2)]);
  });

  it("does not trust a server Date far from the collector's, such as a cached response", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2)]));
    const clock = new Clock();
    server.serverNow = () => new Date("2026-05-30T00:00:00.000Z");
    const first = await cycle(harness(server, {}, clock).source, null);
    expect(first.cursor.syncedUpTo).toBe(clock.now());
  });

  it("keeps an album failure a restarted sweep hit, instead of reporting the sweep clean", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3)]));
    const clock = new Clock();
    const page1 = await harness(server, {}, clock).source.sync(null);
    expect(page1.hasMore).toBe(true);

    // A restart mid-sweep, with the stored index gone and albums unreadable.
    server.failNext(500, "GET /albums");
    const rest = await cycle(harness(server, {}, clock).source, page1.cursor);
    expect(rest.pages.at(-1)!.issues).toEqual([
      expect.objectContaining({ subject: "Album names" }),
    ]);
  });

  it("checks whose key it is before reading or storing any album", async () => {
    const server = new SimulatedImmich(corpus([asset(1)]));
    const saved: unknown[] = [];
    const albumStore = {
      load: () => Promise.resolve(undefined),
      save: (i: unknown) => {
        saved.push(i);
        return Promise.resolve();
      },
    };
    const { source } = harness(server, { albumStore, expectedUserId: "u-someone-else" });
    await expect(source.sync(null)).rejects.toMatchObject({ kind: "auth" });
    expect(saved).toEqual([]);
    expect(server.calls.some((c) => c.path === "/albums")).toBe(false);
  });

  it("links documents to the configured link address instead of the server address", async () => {
    const server = new SimulatedImmich(corpus([asset(1)]));
    const { pages } = await cycle(
      harness(server, { linkBaseUrl: "https://photos.example.org" }).source,
      null,
    );
    expect(pages[0]!.documents[0]!.metadata.sourceUrl).toBe(
      `https://photos.example.org/photos/${uuid(1)}`,
    );
  });

  it("a server error mid-sweep throws without advancing the cursor", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3), asset(4)]));
    const { source } = harness(server);
    const page1 = await source.sync(null);
    expect(page1.hasMore).toBe(true);

    server.failNext(502, "POST /search/metadata");
    await expect(source.sync(page1.cursor)).rejects.toMatchObject({ kind: "transient" });

    // The same cursor resumes where it stopped.
    const page2 = await source.sync(page1.cursor);
    expect(page2.documents.map((d) => d.externalId)).toEqual([uuid(3), uuid(4)]);
  });

  it("refuses a page bound overrun without asserting absence", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3), asset(4), asset(5)]));
    const { source } = harness(server, { maxSweepPages: 2 });
    let cursor: ImmichCursor | null = null;
    for (let i = 0; i < 2; i++) cursor = (await source.sync(cursor)).cursor;
    await expect(source.sync(cursor)).rejects.toBeInstanceOf(SyncError);
  });

  it("re-emits an asset restored from the trash", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2)]));
    const { source, clock } = harness(server);
    const first = await cycle(source, null);
    clock.advance(30 * 60 * 1000);
    server.trashAsset(uuid(2));
    server.assets.get(uuid(2))!.updatedAt = "2026-06-02T00:10:00.000Z";
    const trashed = await cycle(source, first.cursor);
    expect(trashed.pages[0]!.deletedExternalIds).toEqual([uuid(2)]);

    clock.advance(30 * 60 * 1000);
    server.restoreAsset(uuid(2));
    server.assets.get(uuid(2))!.updatedAt = "2026-06-02T00:40:00.000Z";
    const restored = await cycle(source, trashed.cursor);
    expect(ids(restored.pages)).toEqual([uuid(2)]);
    expect(restored.pages[0]!.deletedExternalIds).toEqual([]);
  });

  it("finishes a sweep too large to vouch for, indexing everything and asserting no absence", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3), asset(4), asset(5)]));
    const { source, clock } = harness(server, { maxSnapshotItems: 3 });
    const first = await cycle(source, null);
    expect(ids(first.pages)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)]);
    expect(first.pages.every((p) => p.presentExternalIds === undefined)).toBe(true);
    expect(first.cursor).toMatchObject({ phase: "incremental", lastSnapshotAt: clock.now() });
    expect(first.cursor.presenceWithheld).toBeUndefined();
    expect(first.pages.at(-1)!.issues).toEqual([
      expect.objectContaining({ code: "snapshot-withheld", subject: "Deletion detection" }),
    ]);

    // Not every tick: the withheld sweep still counts as the day's rewalk.
    clock.advance(30 * 60 * 1000);
    const next = await cycle(source, first.cursor);
    expect(next.pages).toHaveLength(1);
  });

  it("refuses a page token that skips ahead", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3)]));
    const skipping: typeof fetch = async (input, init) => {
      const res = await server.fetch(input, init);
      if (!String(input).endsWith("/search/metadata")) return res;
      const body = (await res.json()) as { assets: { nextPage: string | null } };
      if (body.assets.nextPage) body.assets.nextPage = "5";
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const client = new ImmichClient(BASE, KEY, { fetchImpl: skipping });
    const source = new ImmichAssetSource(
      client,
      ProviderId("immich:maya.reeves@example.com"),
      SourceId("immich:maya.reeves@example.com"),
      SELF.email,
      { pageSize: 2 },
    );
    await expect(source.sync(null)).rejects.toThrow(/did not advance by one page/);
  });

  it("counts an asset with no owner as present instead of deleting it", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2)]));
    const ownerless: typeof fetch = async (input, init) => {
      const res = await server.fetch(input, init);
      if (!String(input).endsWith("/search/metadata")) return res;
      const body = (await res.json()) as { assets: { items: Array<Partial<ImmichAsset>> } };
      for (const item of body.assets.items) if (item.id === uuid(2)) delete item.ownerId;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const source = new ImmichAssetSource(
      new ImmichClient(BASE, KEY, { fetchImpl: ownerless }),
      ProviderId("immich:maya.reeves@example.com"),
      SourceId("immich:maya.reeves@example.com"),
      SELF.email,
      { pageSize: 10 },
    );
    const { pages } = await cycle(source, null);
    expect(ids(pages)).toEqual([uuid(1)]);
    expect(pages.at(-1)!.presentExternalIds?.sort()).toEqual([uuid(1), uuid(2)]);
  });

  it("refuses a key that now answers as a different user than the one connected", async () => {
    const server = new SimulatedImmich(corpus([asset(1)]));
    const { source } = harness(server, { expectedUserId: "u-someone-else" });
    await expect(source.sync(null)).rejects.toMatchObject({ kind: "auth", scope: "connection" });
  });

  it.each([
    [429, "rate-limit"],
    [401, "auth"],
  ])("an HTTP %i mid-sweep throws %s and the same cursor resumes", async (status, kind) => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3), asset(4)]));
    const { source } = harness(server);
    const page1 = await source.sync(null);
    server.failNext(status, "POST /search/metadata");
    await expect(source.sync(page1.cursor)).rejects.toMatchObject({ kind });
    const page2 = await source.sync(page1.cursor);
    expect(page2.documents.map((d) => d.externalId)).toEqual([uuid(3), uuid(4)]);
  });

  it("two accounts on one server sync their own libraries apart", async () => {
    const server = new SimulatedImmich(
      corpus([asset(1), asset(2), asset(7, { ownerId: PARTNER.id })], {
        keys: [
          { key: KEY, userId: SELF.id, permissions: ALL_READ },
          { key: "partner-key", userId: PARTNER.id, permissions: ALL_READ },
        ],
      }),
    );
    const mine = harness(server).source;
    const theirs = new ImmichAssetSource(
      new ImmichClient(BASE, "partner-key", { fetchImpl: server.fetch }),
      ProviderId("immich:jamie.lopez@example.com"),
      SourceId("immich:jamie.lopez@example.com"),
      PARTNER.email,
      { pageSize: 2, now: new Clock().now },
    );
    const [a, b] = await Promise.all([cycle(mine, null), cycle(theirs, null)]);
    expect(ids(a.pages)).toEqual([uuid(1), uuid(2)]);
    expect(ids(b.pages)).toEqual([uuid(7)]);
    expect(b.pages[0]!.documents[0]!.sourceId).toBe("immich:jamie.lopez@example.com");
  });

  it("drops assets captured before the data cutoff", async () => {
    const server = new SimulatedImmich(
      corpus([asset(1), asset(2, { exifInfo: { dateTimeOriginal: "2019-01-01T00:00:00.000Z" } })]),
    );
    const { pages } = await cycle(
      harness(server, { dataCutoff: "2020-01-01T00:00:00.000Z" }).source,
      null,
    );
    expect(ids(pages)).toEqual([uuid(1)]);
  });

  it("refuses a server older than v3 with an upgrade remedy", async () => {
    const server = new SimulatedImmich(
      corpus([asset(1)], { version: { major: 2, minor: 5, patch: 0 } }),
    );
    const err = await harness(server)
      .source.sync(null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).remediation?.summary).toMatch(/v2\.5\.0 is too old/);
  });

  it("refuses a stored key that now belongs to another user", async () => {
    const server = new SimulatedImmich(
      corpus([asset(1)], { keys: [{ key: KEY, userId: PARTNER.id, permissions: ALL_READ }] }),
    );
    await expect(harness(server).source.sync(null)).rejects.toMatchObject({ kind: "auth" });
  });

  it("passes the abort signal to every request", async () => {
    const server = new SimulatedImmich(corpus([asset(1)]));
    const controller = new AbortController();
    controller.abort();
    await expect(harness(server).source.sync(null, { signal: controller.signal })).rejects.toThrow(
      /abort/i,
    );
  });

  it("every cursor it writes is one its state declaration reads back", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3)]));
    const { source } = harness(server);
    let cursor: ImmichCursor | null = null;
    for (;;) {
      const page: SyncResult<ImmichCursor> = await source.sync(cursor);
      const roundTripped = JSON.parse(JSON.stringify(page.cursor)) as unknown;
      expect(immichStateSpec.decode(roundTripped)).toEqual(page.cursor);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
  });

  it("a daily rewalk of an unchanged library re-emits identical documents", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3)]));
    const { source, clock } = harness(server);
    const first = await cycle(source, null);
    clock.advance(24 * 60 * 60 * 1000);
    const rewalk = await cycle(source, first.cursor);
    const hashes = (pages: SyncResult<ImmichCursor>[]) =>
      pages.flatMap((p) =>
        p.documents.map((d) => [d.externalId, d.contentHash, d.sourceUpdatedAt]),
      );
    expect(hashes(rewalk.pages)).toEqual(hashes(first.pages));
  });

  it("settles: cycles over an unchanged library change no stored document", async () => {
    const server = new SimulatedImmich(corpus([asset(1), asset(2), asset(3)]));
    const clock = new Clock();
    const { source } = harness(server, {}, clock);
    await expectUnchangedUpstreamIsNoOp({
      initialCursor: null,
      settleSteps: 6,
      async step(cursor) {
        clock.advance(30 * 60 * 1000);
        const page = await source.sync(cursor as ImmichCursor | null);
        return {
          records: page.documents.map((d) => ({
            table: "documents",
            row: { externalId: d.externalId, contentHash: d.contentHash, title: d.title },
          })),
          cursor: page.cursor,
          hasMore: page.hasMore,
        };
      },
      primaryKey: () => ["externalId"],
    });
  });
});

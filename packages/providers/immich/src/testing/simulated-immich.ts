// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An in-memory Immich server behind a `fetch` function.
 *
 * It answers the endpoints the source calls with the shapes Immich v3 serves,
 * applying the same visibility rules: a user sees their own assets and those
 * of partners whose library they show on their timeline; trashed assets only
 * with `withDeleted`; locked assets never; an album filter reaches an album's
 * assets whoever owns them. Metadata search sorts by capture time then id and
 * pages by offset, as Immich's does. The unit tests and the synthetic twin
 * both drive the real client, source and normalizer through it.
 */

import type {
  ImmichAlbum,
  ImmichAsset,
  ImmichMetadataSearch,
  ImmichServerVersion,
} from "../types.js";

export interface SimulatedUser {
  id: string;
  email: string;
  name: string;
  isAdmin?: boolean;
}

export interface SimulatedKey {
  key: string;
  userId: string;
  permissions: string[];
}

export interface SimulatedAlbum {
  id: string;
  albumName: string;
  ownerId: string;
  assetIds: string[];
  updatedAt?: string;
  /** Users the owner shared the album with; they see it and add to it too. */
  sharedWith?: string[];
}

export interface SimulatedPartnership {
  /** The user whose library is shared. */
  sharedBy: string;
  /** The user it is shared with. */
  sharedWith: string;
  inTimeline: boolean;
}

export interface SimulatedImmichCorpus {
  version?: ImmichServerVersion;
  users: SimulatedUser[];
  keys: SimulatedKey[];
  assets: ImmichAsset[];
  albums?: SimulatedAlbum[];
  partnerships?: SimulatedPartnership[];
}

/** One request the server answered, for assertions. */
export interface SimulatedCall {
  method: string;
  path: string;
  body?: unknown;
}

const PERMISSION_BY_ROUTE: Record<string, string | null> = {
  "GET /server/version": null,
  "GET /api-keys/me": null,
  "GET /users/me": "user.read",
  "GET /partners": "partner.read",
  "GET /albums": "album.read",
  "POST /search/metadata": "asset.read",
};

export class SimulatedImmich {
  version: ImmichServerVersion;
  readonly users: SimulatedUser[];
  readonly keys: SimulatedKey[];
  readonly assets: Map<string, ImmichAsset>;
  readonly albums: SimulatedAlbum[];
  readonly partnerships: SimulatedPartnership[];
  readonly calls: SimulatedCall[] = [];
  /** Statuses to answer the next matching requests with, in order. */
  private readonly failures: Array<{ route?: string; status: number; message?: string }> = [];
  private clock: number;

  constructor(corpus: SimulatedImmichCorpus) {
    this.version = corpus.version ?? { major: 3, minor: 3, patch: 5 };
    this.users = corpus.users.map((u) => ({ ...u }));
    this.keys = corpus.keys.map((k) => ({ ...k, permissions: [...k.permissions] }));
    this.assets = new Map(corpus.assets.map((a) => [a.id, structuredClone(a)]));
    this.albums = (corpus.albums ?? []).map((a) => ({ ...a, assetIds: [...a.assetIds] }));
    this.partnerships = (corpus.partnerships ?? []).map((p) => ({ ...p }));
    this.clock = Math.max(
      Date.parse("2026-01-01T00:00:00.000Z"),
      ...corpus.assets.map((a) => Date.parse(a.updatedAt)),
    );
  }

  /**
   * The server's clock, sent as each response's `Date` header when set. Unset,
   * responses carry no `Date`, which a client must cope with too.
   */
  serverNow?: () => Date;

  /** The `fetch` the client is given. */
  readonly fetch: typeof fetch = (input, init) =>
    // A rejected promise, never a synchronous throw, exactly as fetch behaves.
    Promise.resolve().then(() => {
      const res = this.respond(input, init);
      if (this.serverNow) res.headers.set("date", this.serverNow().toUTCString());
      return res;
    });

  private respond(input: Parameters<typeof fetch>[0], init?: RequestInit): Response {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^.*?\/api(?=\/)/, "");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    this.calls.push({
      method,
      path: `${path}${url.search}`,
      ...(body !== undefined ? { body } : {}),
    });
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");

    const route = `${method} ${path}`;
    const failureIndex = this.failures.findIndex((f) => !f.route || f.route === route);
    if (failureIndex >= 0) {
      const [failure] = this.failures.splice(failureIndex, 1);
      return json(failure!.status, {
        message: failure!.message ?? `Simulated HTTP ${failure!.status}`,
      });
    }

    if (!(route in PERMISSION_BY_ROUTE)) return json(404, { message: `Cannot ${route}` });
    if (route === "GET /server/version") return json(200, this.version);

    const header = new Headers(init?.headers).get("x-api-key");
    const key = this.keys.find((k) => k.key === header);
    if (!key) return json(401, { message: header ? "Invalid API key" : "Authentication required" });
    const user = this.users.find((u) => u.id === key.userId);
    if (!user) return json(401, { message: "Invalid API key" });
    const permission = PERMISSION_BY_ROUTE[route];
    if (permission && !key.permissions.includes("all") && !key.permissions.includes(permission)) {
      return json(403, { message: `Missing required permission: ${permission}` });
    }

    switch (route) {
      case "GET /api-keys/me":
        return json(200, {
          id: `key-${key.userId}`,
          name: "Omnesis",
          permissions: key.permissions,
        });
      case "GET /users/me":
        return json(200, { ...user, isAdmin: user.isAdmin === true });
      case "GET /partners":
        return json(200, this.partnersOf(user.id));
      case "GET /albums":
        return json(200, this.albumsOf(user.id));
      default:
        return json(200, this.search(user.id, body as ImmichMetadataSearch));
    }
  }

  /** Make the next request (on `route`, e.g. `POST /search/metadata`, or any) fail with `status`. */
  failNext(status: number, route?: string, message?: string): void {
    this.failures.push({ status, ...(route ? { route } : {}), ...(message ? { message } : {}) });
  }

  /**
   * The server's time for a write: now, as Immich stamps `updatedAt`, and
   * always later than the previous write, so every write moves it forward.
   */
  tick(): string {
    this.clock = Math.max(this.clock + 1, Date.now());
    return new Date(this.clock).toISOString();
  }

  /** Add or replace an asset, stamping a fresh `updatedAt`. */
  upsertAsset(asset: ImmichAsset): void {
    this.assets.set(asset.id, { ...structuredClone(asset), updatedAt: this.tick() });
  }

  /** Edit an asset in place, as the web UI would. */
  editAsset(id: string, change: (asset: ImmichAsset) => void): void {
    const asset = this.assets.get(id);
    if (!asset) throw new Error(`No simulated asset ${id}`);
    change(asset);
    asset.updatedAt = this.tick();
  }

  /** Move an asset to the trash. */
  trashAsset(id: string): void {
    this.editAsset(id, (asset) => {
      asset.isTrashed = true;
    });
  }

  /** Restore an asset from the trash. */
  restoreAsset(id: string): void {
    this.editAsset(id, (asset) => {
      asset.isTrashed = false;
    });
  }

  /** Delete an asset for good: it simply stops existing. */
  deleteAsset(id: string): void {
    this.assets.delete(id);
    for (const album of this.albums) album.assetIds = album.assetIds.filter((a) => a !== id);
  }

  private visibleOwners(userId: string): Set<string> {
    return new Set([
      userId,
      ...this.partnerships
        .filter((p) => p.sharedWith === userId && p.inTimeline)
        .map((p) => p.sharedBy),
    ]);
  }

  private partnersOf(userId: string) {
    return this.partnerships
      .filter((p) => p.sharedWith === userId)
      .flatMap((p) => {
        const u = this.users.find((candidate) => candidate.id === p.sharedBy);
        return u ? [{ id: u.id, name: u.name, email: u.email, inTimeline: p.inTimeline }] : [];
      });
  }

  private albumsOf(userId: string): ImmichAlbum[] {
    return this.albums
      .filter((a) => canSee(a, userId))
      .map((a) => ({
        id: a.id,
        albumName: a.albumName,
        assetCount: a.assetIds.filter((id) => this.assets.has(id)).length,
        ...(a.updatedAt ? { updatedAt: a.updatedAt } : {}),
      }));
  }

  private search(userId: string, req: ImmichMetadataSearch) {
    const size = req.size ?? 250;
    const page = req.page ?? 1;
    const owners = this.visibleOwners(userId);
    const albumScope = req.albumIds?.length
      ? new Set(
          this.albums
            .filter((a) => req.albumIds!.includes(a.id) && canSee(a, userId))
            .flatMap((a) => a.assetIds),
        )
      : undefined;
    const matched = [...this.assets.values()]
      .filter((a) => (albumScope ? albumScope.has(a.id) : owners.has(a.ownerId)))
      .filter((a) => a.visibility !== "locked")
      .filter((a) => req.withDeleted || !a.isTrashed)
      .filter((a) => !req.updatedAfter || a.updatedAt >= req.updatedAfter)
      .filter((a) => !req.updatedBefore || a.updatedAt <= req.updatedBefore)
      .sort((a, b) => {
        const byTime = a.fileCreatedAt.localeCompare(b.fileCreatedAt);
        return (req.order === "desc" ? -byTime : byTime) || a.id.localeCompare(b.id);
      });
    const items = matched.slice((page - 1) * size, page * size).map((a) => ({
      ...structuredClone(a),
      ...(req.withExif ? {} : { exifInfo: undefined }),
      people: req.withPeople ? structuredClone(a.people ?? []) : [],
    }));
    return {
      albums: { total: 0, count: 0, items: [], facets: [] },
      assets: {
        total: items.length,
        count: items.length,
        items,
        facets: [],
        nextPage: page * size < matched.length ? String(page + 1) : null,
      },
    };
  }
}

/** Immich lists albums a user owns and albums shared with them alike. */
function canSee(album: SimulatedAlbum, userId: string): boolean {
  return album.ownerId === userId || (album.sharedWith ?? []).includes(userId);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, toErrorMessage } from "@omnesis/core";
import {
  SyncError,
  type DocumentInput,
  type ProviderId,
  type SourceId,
  type SyncIssue,
} from "@omnesis/types";
import { applyDataCutoff, SnapshotEnumeration, syncPage } from "@omnesis/source-sdk";
import { memoryAlbumStore, type AlbumIndexStore } from "./album-store.js";
import { formatVersion, isSupportedVersion, parseNextPage } from "./client.js";
import { assetToDocument, isIndexableAsset } from "./normalizer.js";
import type { SyncOptions, SyncResult } from "@omnesis/source-sdk";
import type { ImmichClient } from "./client.js";
import type { ImmichAlbumIndex, ImmichAsset, ImmichCursor } from "./types.js";

const log = createLogger("source:immich");

const ASSETS_PARTITION = "assets";
/** Assets per request unless the source is configured otherwise. */
export const DEFAULT_PAGE_SIZE = 250;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * How far an incremental window reaches back past the previous one. Immich
 * pages by offset over a capture-time sort, so an asset written at the very
 * edge of a window could be missed; re-reading a few minutes is cheap.
 */
const WINDOW_OVERLAP_MS = 5 * 60 * 1000;
/**
 * The most ids one sweep's presence ledger carries. A larger library still
 * syncs in full; its sweep just stops collecting presence past this point
 * and asserts none, so absence is not reconciled for it.
 */
const MAX_SNAPSHOT_ITEMS = 500_000;
/**
 * A guard against a server that never ends its paging, not a library limit:
 * scaled by the page size so a small page size never makes it reachable.
 */
const MAX_SWEEP_ASSETS = 10_000_000;
/** Past this, a server `Date` is not trusted as the server's clock. */
const MAX_CLOCK_SKEW_MS = 60 * 60 * 1000;

export interface ImmichAssetSourceOptions {
  pageSize?: number;
  dataCutoff?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  snapshotIntervalMs?: number;
  maxSnapshotItems?: number;
  maxSweepPages?: number;
  /**
   * The Immich user id the stored key was connected as. When known, a key
   * that now answers as anyone else is refused before anything is read.
   */
  expectedUserId?: string;
  /** Where album membership is kept between sweeps. Defaults to this instance's memory. */
  albumStore?: AlbumIndexStore;
  /**
   * The address documents link to, when it differs from the one the
   * collector reaches the server at — a public name for a phone away from
   * the home network. Normalized, like the server address.
   */
  linkBaseUrl?: string;
}

/**
 * One Immich user's library as documents, one per photo or video.
 *
 * The sync stream Immich's own apps use refuses API keys, so this source
 * polls metadata search: a first full sweep, then windows of recently
 * updated assets, with a full rewalk once a day. Trashing an asset updates
 * it, so an incremental window reports it as deleted. A hard delete leaves no
 * trace at all, and is found by the daily rewalk's complete list of what is
 * still there.
 *
 * Only the user's own assets. Search also returns those partners share onto
 * the user's timeline; they are another person's library, which that person
 * connects with their own key (see #592 for a source of them through this one).
 */
export class ImmichAssetSource {
  private readonly pageSize: number;
  private readonly dataCutoff?: Date;
  private readonly now: () => string;
  private readonly snapshotIntervalMs: number;
  private readonly maxSnapshotItems: number;
  private readonly maxSweepPages: number;
  private readonly expectedUserId?: string;
  private readonly albumStore: AlbumIndexStore;
  private readonly linkBaseUrl?: string;
  /** The key's own Immich user id, read once per instance. */
  private userId?: string;
  /** Album membership as of the last full sweep, once loaded or read. */
  private albums?: ImmichAlbumIndex;
  private albumsLoaded = false;

  constructor(
    private readonly client: ImmichClient,
    private readonly providerId: ProviderId,
    private readonly sourceId: SourceId,
    /** The account email this source was connected as. */
    private readonly accountId: string,
    opts: ImmichAssetSourceOptions = {},
  ) {
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.dataCutoff = opts.dataCutoff ? new Date(opts.dataCutoff) : undefined;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.snapshotIntervalMs = opts.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS;
    this.maxSnapshotItems = opts.maxSnapshotItems ?? MAX_SNAPSHOT_ITEMS;
    this.maxSweepPages = opts.maxSweepPages ?? Math.ceil(MAX_SWEEP_ASSETS / this.pageSize);
    this.expectedUserId = opts.expectedUserId;
    this.albumStore = opts.albumStore ?? memoryAlbumStore();
    this.linkBaseUrl = opts.linkBaseUrl;
  }

  async sync(
    cursor: ImmichCursor | null,
    opts: SyncOptions = {},
  ): Promise<SyncResult<ImmichCursor>> {
    const signal = opts.signal;
    const now = this.now();
    const inSweep = cursor?.page !== undefined;
    const phase: ImmichCursor["phase"] = inSweep
      ? cursor!.phase
      : !cursor || cursor.phase === "backfill"
        ? "backfill"
        : this.snapshotDue(cursor, now)
          ? "snapshot"
          : "incremental";
    const page = cursor?.page ?? 1;
    if (page > this.maxSweepPages) {
      throw new SyncError(
        "unknown",
        `Immich kept returning pages past page ${this.maxSweepPages}; withholding reconciliation`,
      );
    }
    const recheck = inSweep && cursor?.recheck === true;
    let windowEnd = inSweep ? cursor!.windowEnd! : now;
    // Only a full sweep assesses what it could not read; an incremental tick
    // leaves the last sweep's report standing.
    const sweepIssues: SyncIssue[] = inSweep ? [...(cursor?.sweepIssues ?? [])] : [];

    const note = (issue: SyncIssue | undefined): void => {
      // A sweep resumed by a new instance reads again what the first one
      // already reported on; one report per subject.
      if (
        issue &&
        phase !== "incremental" &&
        !sweepIssues.some((i) => i.subject === issue.subject)
      ) {
        sweepIssues.push(issue);
      }
    };

    if (!inSweep) windowEnd = this.windowEnd(await this.checkServer(signal), now);
    // Whose key this is, before anything else is read or stored with it.
    const userId = await this.ownUserId(signal);
    if (!inSweep && phase !== "incremental") note(await this.refreshAlbums(signal));
    const { albums, issue: albumIssue } = await this.albumIndex(signal);
    note(albumIssue);

    const updatedAfter =
      phase === "incremental" && cursor?.syncedUpTo
        ? new Date(Date.parse(cursor.syncedUpTo) - WINDOW_OVERLAP_MS).toISOString()
        : undefined;
    const res = await this.client.searchAssets(
      {
        page,
        size: this.pageSize,
        order: "asc",
        withExif: true,
        withPeople: true,
        withDeleted: true,
        updatedBefore: windowEnd,
        ...(updatedAfter ? { updatedAfter } : {}),
      },
      { signal },
    );
    const items = res?.assets?.items;
    if (!Array.isArray(items) || items.length > this.pageSize) {
      throw new SyncError("unknown", "Immich returned an invalid asset listing");
    }
    const next = parseNextPage(res.assets.nextPage);
    // Exactly the next page: a token that jumped ahead would skip assets and
    // still reach the final page, which would then report them absent.
    if (next !== null && next !== page + 1) {
      throw new SyncError(
        "unknown",
        "Immich pagination did not advance by one page; withholding reconciliation",
      );
    }

    let presenceWithheld = inSweep && cursor?.presenceWithheld === true;
    let enumeration =
      phase === "incremental" || presenceWithheld
        ? undefined
        : SnapshotEnumeration.resume([ASSETS_PARTITION], cursor?.snapshot);
    const documents: DocumentInput[] = [];
    const deleted: string[] = [];
    const seen = new Set<string>();
    for (const asset of items) {
      if (!asset || typeof asset.id !== "string" || !asset.id || asset.id.length > 128) {
        log.warn(`Skipping an asset with no usable id on page ${page}`);
        continue;
      }
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      if (!isWellFormed(asset)) {
        // One malformed asset is not the library: skip it, but still count it
        // as present, so an asset this build cannot read is never deleted.
        log.warn(`Skipping asset ${asset.id}: missing or invalid owner or timestamps`);
        enumeration?.add(ASSETS_PARTITION, [asset.id]);
        continue;
      }
      if (!this.inScope(asset, userId)) continue;
      if (asset.isTrashed) {
        // Only an incremental window names a deletion: a trashed asset sits in
        // the trash for weeks, and a sweep that reported it every day would
        // name the same deletion every day. A sweep leaves it out of the
        // presence list instead, which the gateway reconciles once.
        if (phase === "incremental") deleted.push(asset.id);
        continue;
      }
      if (!isIndexableAsset(asset)) continue;
      let doc: DocumentInput;
      try {
        doc = assetToDocument(asset, {
          providerId: this.providerId,
          sourceId: this.sourceId,
          baseUrl: this.linkBaseUrl ?? this.client.baseUrl,
          userId,
          albums,
        });
      } catch (err) {
        // Counted present for the same reason as a malformed one above.
        log.warn(`Skipping asset ${asset.id}: ${toErrorMessage(err)}`);
        enumeration?.add(ASSETS_PARTITION, [asset.id]);
        continue;
      }
      const [kept] = applyDataCutoff([doc], this.dataCutoff);
      if (!kept) continue;
      enumeration?.add(ASSETS_PARTITION, [asset.id]);
      documents.push(kept);
    }
    if (enumeration && enumeration.size > this.maxSnapshotItems) {
      // Too large to vouch for in one cursor: finish the sweep, keep every
      // document it emits, and assert no absence this cycle.
      log.warn(
        `Immich library for ${this.sourceId} has more than ${this.maxSnapshotItems} assets; ` +
          "this sweep indexes them all but reports no deletions",
      );
      enumeration = undefined;
      presenceWithheld = true;
    }

    const carried = {
      ...(cursor?.syncedUpTo ? { syncedUpTo: cursor.syncedUpTo } : {}),
      ...(cursor?.lastSnapshotAt ? { lastSnapshotAt: cursor.lastSnapshotAt } : {}),
    };
    if (next !== null) {
      return syncPage(
        documents,
        {
          phase,
          page: next,
          windowEnd,
          ...carried,
          ...(enumeration ? { snapshot: enumeration.toLedger() } : {}),
          ...(presenceWithheld ? { presenceWithheld: true as const } : {}),
          ...(recheck ? { recheck: true as const } : {}),
          ...(sweepIssues.length > 0 ? { sweepIssues } : {}),
        },
        { hasMore: true, deletedExternalIds: deleted },
      );
    }
    if (phase === "incremental" && page > 1 && !recheck) {
      // A window that took several pages may have shifted under its own
      // offsets; walk it once more before moving the watermark past it.
      return syncPage(
        documents,
        { phase, page: 1, windowEnd, ...carried, recheck: true },
        { hasMore: true, deletedExternalIds: deleted },
      );
    }

    const presentExternalIds = enumeration?.cover(ASSETS_PARTITION).result();
    if (presenceWithheld) {
      const withheld = new SnapshotEnumeration([ASSETS_PARTITION])
        .gap(
          ASSETS_PARTITION,
          `the library has more than ${this.maxSnapshotItems} assets, more than one sweep can vouch for`,
        )
        .withheldIssue();
      if (withheld) sweepIssues.push(withheld);
    }
    if (phase === "backfill") {
      log.info(`Backfill complete for ${this.sourceId}; switching to incremental`);
    }
    return syncPage(
      documents,
      {
        phase: "incremental",
        syncedUpTo: windowEnd,
        // A sweep that withheld presence still counts as the day's rewalk, or
        // every tick would start another one.
        ...(presentExternalIds !== undefined || presenceWithheld
          ? { lastSnapshotAt: now }
          : cursor?.lastSnapshotAt
            ? { lastSnapshotAt: cursor.lastSnapshotAt }
            : {}),
      },
      {
        hasMore: false,
        deletedExternalIds: deleted,
        ...(presentExternalIds !== undefined ? { presentExternalIds } : {}),
        // A completed sweep reassessed everything it reports on, so it
        // replaces the last report — with nothing, once all is readable.
        ...(phase !== "incremental" ? { issues: sweepIssues } : {}),
      },
    );
  }

  /**
   * Where a new sweep's window ends: the server's clock when it sent one that
   * is plausible. A `Date` far from the collector's is more likely a caching
   * proxy replaying an old response than a clock that wrong, and ending every
   * window on it would stop the source reading new edits. The collector clock
   * is the fallback either way; running ahead of the server, it can miss an
   * edit made just before the window ends until the daily rewalk.
   */
  private windowEnd(serverTime: string | undefined, now: string): string {
    if (!serverTime) return now;
    const skew = Date.parse(serverTime) - Date.parse(now);
    if (Math.abs(skew) > MAX_CLOCK_SKEW_MS) {
      log.warn(
        `Immich's clock reads ${serverTime}, ${Math.round(skew / 60_000)} min from this collector's; ending the window on the collector's clock`,
      );
      return now;
    }
    return serverTime;
  }

  /** A fresh walk is due once the previous complete one is a day old. */
  private snapshotDue(cursor: ImmichCursor, now: string): boolean {
    return (
      !cursor.lastSnapshotAt ||
      Date.parse(now) - Date.parse(cursor.lastSnapshotAt) >= this.snapshotIntervalMs
    );
  }

  /**
   * An asset this source speaks for: one the user owns. A partner's asset in
   * the results is left out of the presence list as well as the documents.
   */
  private inScope(asset: ImmichAsset, userId: string): boolean {
    return asset.ownerId === userId;
  }

  /**
   * Refuse a server too old to read, before any of its data is. Returns the
   * server's clock, when it sent one, to end the sweep's window on.
   */
  private async checkServer(signal?: AbortSignal): Promise<string | undefined> {
    const { version, serverTime } = await this.client.serverClock({ signal });
    if (!isSupportedVersion(version)) {
      throw new SyncError(
        "unknown",
        `Immich ${formatVersion(version)} is older than this source supports (v3.0 or later).`,
        {
          remediation: {
            summary: `Immich ${formatVersion(version)} is too old for Omnesis`,
            steps: ["Upgrade the Immich server to v3.0 or later; the source resumes on its own."],
            restartRequired: false,
          },
        },
      );
    }
    return serverTime;
  }

  private async ownUserId(signal?: AbortSignal): Promise<string> {
    if (this.userId) return this.userId;
    const me = await this.client.me({ signal });
    if (typeof me?.id !== "string" || !me.id) {
      throw new SyncError("unknown", "Immich did not say which user the API key belongs to");
    }
    if (this.expectedUserId) {
      // The id, not the email: a user may change their email in Immich, and
      // another server's user may share it.
      if (me.id !== this.expectedUserId) {
        throw new SyncError(
          "auth",
          `The stored Immich API key now belongs to a different Immich user than ${this.accountId}.`,
          { scope: "connection" },
        );
      }
      this.userId = me.id;
      return me.id;
    }
    // The key on disk must still be this account's. A different user's key
    // would sync someone else's library into this source.
    if (typeof me.email === "string" && me.email.toLowerCase() !== this.accountId.toLowerCase()) {
      throw new SyncError(
        "auth",
        `The stored Immich API key belongs to ${me.email}, not ${this.accountId}.`,
        { scope: "connection" },
      );
    }
    this.userId = me.id;
    return me.id;
  }

  /**
   * The album index for this page: the one this instance already holds, else
   * the stored one, else — when it was lost — read again from Immich.
   */
  private async albumIndex(
    signal?: AbortSignal,
  ): Promise<{ albums?: ImmichAlbumIndex; issue?: SyncIssue }> {
    let issue: SyncIssue | undefined;
    if (!this.albumsLoaded) {
      this.albumsLoaded = true;
      this.albums = await this.albumStore.load();
      if (!this.albums) issue = await this.refreshAlbums(signal);
    }
    return { ...(this.albums ? { albums: this.albums } : {}), ...(issue ? { issue } : {}) };
  }

  /**
   * Album membership, read in full. Adding a photo to an album does not
   * touch the photo, so membership is re-read at the start of every full
   * sweep and the sweep re-emits every asset with it. A failure keeps the
   * previous index — album names a day stale beat a sync that stops — and
   * comes back as the issue the sweep reports.
   */
  private async refreshAlbums(signal?: AbortSignal): Promise<SyncIssue | undefined> {
    let index: ImmichAlbumIndex;
    try {
      const albums = await this.client.listAlbums({ signal });
      if (!Array.isArray(albums)) throw new Error("the album list is not a list");
      index = { names: {}, byAsset: {} };
      for (const album of albums) {
        if (!album || typeof album.id !== "string" || typeof album.albumName !== "string") continue;
        index.names[album.id] = album.albumName;
        if (album.assetCount === 0) continue;
        for (const assetId of await this.client.albumAssetIds(album.id, this.pageSize, {
          signal,
        })) {
          (index.byAsset[assetId] ??= []).push(album.id);
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!this.albumsLoaded) {
        this.albumsLoaded = true;
        this.albums = await this.albumStore.load();
      }
      log.warn(
        `Could not read Immich albums, keeping the previous membership: ${toErrorMessage(err)}`,
      );
      return readIssue(
        err,
        "Album names",
        this.albums
          ? `Albums could not be read, so photos keep the album names from an earlier sync: ${toErrorMessage(err)}`
          : `Albums could not be read, so photos are indexed without album names: ${toErrorMessage(err)}`,
      );
    }
    this.albums = index;
    this.albumsLoaded = true;
    try {
      await this.albumStore.save(index);
    } catch (err) {
      // Only a restart pays for this: the index is read again then.
      log.warn(`Could not store the Immich album index: ${toErrorMessage(err)}`);
    }
    return undefined;
  }
}

/** A read the sweep survived, with the remedy the client found for it (a missing permission). */
function readIssue(err: unknown, subject: string, message: string): SyncIssue {
  const remediation = err instanceof SyncError ? err.remediation : undefined;
  return {
    code: "partial-read",
    scope: "partition",
    kind: err instanceof SyncError ? err.kind : "unknown",
    count: 1,
    subject,
    message,
    ...(remediation ? { remediation } : {}),
  };
}

function isWellFormed(asset: ImmichAsset): boolean {
  return (
    typeof asset.ownerId === "string" &&
    typeof asset.fileCreatedAt === "string" &&
    Number.isFinite(Date.parse(asset.fileCreatedAt)) &&
    typeof asset.updatedAt === "string" &&
    Number.isFinite(Date.parse(asset.updatedAt))
  );
}

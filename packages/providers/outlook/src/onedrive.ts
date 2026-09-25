// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createLogger,
  computeContentHash,
  extractEmailsFromText,
  extractPhonesFromText,
  resolveAttachmentConfig,
  shouldExtractAttachment,
  resolveEffectiveMimeType,
  fileKindName,
  pMap,
} from "@omnesis/core";
import { syncPage } from "@omnesis/source-sdk";
import { SourceId, ProviderId, isTransientSyncError } from "@omnesis/types";
import {
  GraphClient,
  DeltaExpiredError,
  AuthError,
  toConnectionAuthError,
} from "./graph-client.js";
import {
  ONEDRIVE_PAGE_SIZE,
  ONEDRIVE_FETCH_CONCURRENCY,
  ONEDRIVE_MAX_CONTENT_SIZE,
  ONEDRIVE_SKIP_MIME_TYPES,
  ONEDRIVE_SKIP_MIME_PREFIXES,
  ONEDRIVE_TEXT_MIME_PREFIXES,
  ONEDRIVE_TEXT_MIME_TYPES,
  fingerprintDriveItem,
  type DriveDeltaResponse,
  type DriveItem,
  type DriveIdentitySet,
  type GraphClientLike,
  type OneDriveCursor,
  type OneDriveSourceOptions,
} from "./onedrive-types.js";
import type {
  AttachmentExtractionConfig,
  AttachmentExtractFn,
  ExtractionResult,
} from "@omnesis/core";
import type { SyncResult } from "@omnesis/source-sdk";
import type {
  SourceId as SourceIdType,
  ProviderId as ProviderIdType,
  DocumentInput,
  PersonMention,
} from "@omnesis/types";

const log = createLogger("source:onedrive");

/**
 * The root of `/me/drive/root/delta`, including the page size.
 *
 * The user's own drive only. Files other people share reach a personal account
 * solely through Graph's `sharedWithMe`, which Microsoft has deprecated with no
 * parity replacement, so they are deliberately out of scope. Other drives and
 * SharePoint libraries are also not walked.
 */
const DELTA_ROOT = `/me/drive/root/delta?$top=${ONEDRIVE_PAGE_SIZE}`;

/**
 * How many times a re-walk may restart after Graph disowns its enumeration
 * before the sync gives up and lets the collector back off. One retry covers a
 * race; a drive that loses every enumeration is not going to win the next one.
 */
const MAX_REWALK_RESTARTS = 2;

function isTextMimeType(mimeType: string): boolean {
  if (ONEDRIVE_TEXT_MIME_TYPES.has(mimeType)) return true;
  return ONEDRIVE_TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

function shouldSkip(mimeType: string): boolean {
  if (ONEDRIVE_SKIP_MIME_TYPES.has(mimeType)) return true;
  return ONEDRIVE_SKIP_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

/**
 * Whether the file is processable at all — either a verbatim-text MIME type or
 * a binary the shared attachment pipeline can decode (PDF / Office / EML / text
 * family). The actual decision to download binary bytes is gated again by
 * `shouldExtractAttachment` against `attachmentConfig.allowedTypes` at fetch
 * time, so config opt-outs still win — this gate only avoids skipping a file
 * outright. An allow-listed type (e.g. `image/*` once OCR is on, #427) is always
 * processable even when it matches a skip prefix.
 */
function isProcessable(mimeType: string, allowedAttachmentTypes: ReadonlyArray<string>): boolean {
  if (allowedAttachmentTypes.includes(mimeType)) return true;
  if (shouldSkip(mimeType)) return false;
  return isTextMimeType(mimeType);
}

/**
 * Reconstruct a human folder path from `parentReference.path`. Graph returns it
 * as a drive-relative path like `/drive/root:/Documents/Reports`; we strip the
 * `/drive/root:` prefix to yield `/Documents/Reports`. The drive root itself
 * comes back as `/drive/root:` → normalized to `/`.
 */
function folderPath(item: DriveItem): string | undefined {
  const raw = item.parentReference?.path;
  if (!raw) return undefined;
  const marker = "/root:";
  const idx = raw.indexOf(marker);
  if (idx === -1) return raw;
  const tail = raw.slice(idx + marker.length);
  if (tail === "") return "/";
  try {
    return decodeURIComponent(tail);
  } catch {
    // A malformed percent-escape would throw; the raw path is still useful.
    return tail;
  }
}

export class OneDriveSource {
  readonly id: SourceIdType;
  readonly providerId: ProviderIdType;

  private graph: GraphClientLike;
  private dataCutoff?: Date;
  private attachmentConfig: AttachmentExtractionConfig;
  private extractAttachment?: AttachmentExtractFn;

  constructor(
    getAccessToken: () => Promise<string>,
    sourceId: string,
    providerId: string,
    dataCutoff?: string,
    opts?: OneDriveSourceOptions,
  ) {
    this.graph = opts?.graph ?? new GraphClient(getAccessToken);
    this.id = SourceId(sourceId);
    this.providerId = ProviderId(providerId);
    this.attachmentConfig = opts?.attachmentConfig ?? resolveAttachmentConfig();
    this.extractAttachment = opts?.extractAttachment;
    if (dataCutoff) {
      this.dataCutoff = new Date(dataCutoff);
      log.info(`Data cutoff: ${dataCutoff}`);
    }
  }

  async sync(cursor: OneDriveCursor | null): Promise<SyncResult<OneDriveCursor>> {
    const state: OneDriveCursor = cursor ?? { phase: "bootstrap" };
    try {
      // A recovery in progress outranks the phase: the delta stream it would
      // otherwise follow is the one that expired.
      if (state.rewalk) {
        return await this.reWalkPage(state);
      }
      if (state.phase === "incremental") {
        return await this.incrementalSync(state);
      }
      return await this.bootstrapSync(state);
    } catch (error) {
      // Mail, Calendar and OneDrive all read through the same account token
      // (see `toConnectionAuthError`), so a dead credential is never a fact
      // about this one file.
      if (error instanceof AuthError) throw toConnectionAuthError(error);
      throw error;
    }
  }

  // ── Bootstrap ──────────────────────────────────────────────────────

  /**
   * Walk `/me/drive/root/delta` one page at a time. Each page advances the
   * cursor by its `@odata.nextLink` until Graph hands back an `@odata.deltaLink`,
   * at which point we flip to the `incremental` phase. The collector drives one
   * page per `sync()` call (returning `hasMore`), so a large drive paginates
   * across ticks without one mega-call.
   */
  private async bootstrapSync(state: OneDriveCursor): Promise<SyncResult<OneDriveCursor>> {
    const url = state.link ?? DELTA_ROOT;
    const page = await this.graph.get<DriveDeltaResponse>(url);

    const seen = { ...(state.seen ?? {}) };
    const { documents, deletedExternalIds } = await this.processPage(page.value, seen);

    const nextLink = page["@odata.nextLink"];
    const deltaLink = page["@odata.deltaLink"];
    const hasMore = !!nextLink;

    return syncPage<OneDriveCursor>(
      documents,
      {
        phase: hasMore ? "bootstrap" : "incremental",
        link: nextLink ?? deltaLink,
        seen,
      },
      {
        deletedExternalIds,
        hasMore,
        progress: { phase: "bootstrap", processed: documents.length },
      },
    );
  }

  // ── Incremental ────────────────────────────────────────────────────

  /**
   * Follow the persisted `@odata.deltaLink`. On a 410 (`DeltaExpiredError`) the
   * token has aged out; recover with the **bounded re-walk** (`reWalkPage`) —
   * re-enumerate metadata from a fresh `/me/drive/root/delta` but
   * re-download+extract content only for items whose fingerprint changed. NOT a
   * from-zero re-bootstrap (the #111/#593 rule): unchanged files emit nothing
   * and their existing documents stay intact, so a re-walk never re-extracts
   * the whole drive.
   */
  private async incrementalSync(state: OneDriveCursor): Promise<SyncResult<OneDriveCursor>> {
    const url = state.link;
    if (!url) {
      // No deltaLink persisted (e.g. a cursor written before incremental was
      // reached) — fall back to a fresh enumeration. Deliberately NOT the
      // re-walk: with no fingerprint map to compare against, every file would
      // read as changed, so the walk's one economy is gone and it becomes a
      // whole-drive extraction wearing a recovery's name.
      return this.bootstrapSync({ phase: "bootstrap", seen: state.seen });
    }

    let page: DriveDeltaResponse;
    try {
      page = await this.graph.get<DriveDeltaResponse>(url);
    } catch (error) {
      if (error instanceof DeltaExpiredError) {
        log.warn("Delta token expired — running bounded re-walk");
        return this.reWalkPage(state);
      }
      throw error;
    }

    const seen = { ...(state.seen ?? {}) };
    const { documents, deletedExternalIds } = await this.processPage(page.value, seen);

    const nextLink = page["@odata.nextLink"];
    const deltaLink = page["@odata.deltaLink"];
    const hasMore = !!nextLink;

    return syncPage<OneDriveCursor>(
      documents,
      {
        phase: "incremental",
        link: nextLink ?? deltaLink ?? url,
        seen,
      },
      { deletedExternalIds, hasMore },
    );
  }

  /**
   * One page of the bounded re-walk that follows a delta-token expiry.
   *
   * The expired token is exactly the thing that could have told us what changed,
   * so the walk re-enumerates the drive's metadata from scratch and re-downloads
   * content only for items whose fingerprint differs from the map the last good
   * cursor carried. Unchanged files emit nothing — their documents stay as they
   * are — so this is never the from-zero re-bootstrap the cursor-recovery rule
   * forbids.
   *
   * A page per `sync()` call, like every other path here. The collector still
   * drains those pages inside one sync cycle, so the wall-clock is much the
   * same; what changes is that the walk's progress is written to the cursor at
   * every page, so an enumeration interrupted near its end resumes there
   * instead of starting over.
   *
   * Deletions get their own treatment. A from-zero `/me/drive/root/delta`
   * enumerates only the files that currently exist — Graph emits a `deleted`
   * facet solely for changes measured against a token, and the expired token is
   * precisely what is gone. So anything the operator deleted while the stream
   * was down is invisible here as an event and detectable only as an absence.
   * The walk therefore publishes `presentExternalIds` once it has finished: the
   * complete set of ids the drive still holds, which the gateway diffs against
   * what it has stored and deletes the remainder. That is the reviewed
   * snapshot-reconcile path — refused on a partial page by both the collector
   * and the gateway — rather than a tombstone list this source derives on its
   * own. Publishing it before the walk finishes would name a fraction of the
   * drive and delete the rest, which is why it waits for the last page.
   */
  private async reWalkPage(state: OneDriveCursor): Promise<SyncResult<OneDriveCursor>> {
    const walk = state.rewalk ?? { seen: {}, total: 0 };
    const prior = state.seen ?? {};

    let page: DriveDeltaResponse;
    try {
      page = await this.graph.get<DriveDeltaResponse>(walk.link ?? DELTA_ROOT);
    } catch (error) {
      if (error instanceof DeltaExpiredError && walk.link) {
        if ((walk.restarts ?? 0) >= MAX_REWALK_RESTARTS) {
          // Every attempt has been disowned, so this is the drive answering
          // badly rather than a race the next try will win. Letting the error
          // out ends the sync and hands the collector its backoff, where
          // restarting again would re-read page one and re-emit its documents
          // for as long as the condition lasts — inside a single sync cycle,
          // since the collector drains `hasMore` without pausing.
          log.error(
            `Re-walk enumeration expired ${walk.restarts} times running — giving up this cycle`,
          );
          throw error;
        }
        // Graph invalidated the enumeration this walk was following. Its
        // `@odata.nextLink` is now permanently dead, and because the walk's
        // resume pointer is persisted, retrying it would fail identically on
        // every tick from here on — the source would never sync again. Start
        // the walk over from the drive root instead. What it had accumulated
        // goes with the link: a set half-collected from an enumeration Graph
        // has disowned is not a set anything may be reconciled against.
        log.warn("Re-walk enumeration expired mid-flight — restarting it from the drive root");
        return this.emptyRewalkPage({
          ...state,
          rewalk: { seen: {}, total: 0, restarts: (walk.restarts ?? 0) + 1 },
        });
      }
      throw error;
    }

    const nextSeen = { ...walk.seen };
    const deleted = new Set(walk.deleted ?? []);
    const files: DriveItem[] = [];
    let total = walk.total;
    let droppedByCutoff = 0;

    for (const item of page.value) {
      if (item.deleted) {
        deleted.add(item.id);
        continue;
      }
      if (!item.file || !item.name) continue; // folder or facet-less root
      if (!this.withinCutoff(item)) {
        droppedByCutoff++;
        continue;
      }
      total++;
      nextSeen[item.id] = fingerprintDriveItem(item);
      // Bounded: re-extract content ONLY for new or changed items. An unchanged
      // file emits nothing and its existing document is left untouched, which is
      // what keeps a recovery from re-downloading the whole drive.
      if (prior[item.id] !== nextSeen[item.id]) files.push(item);
    }

    const fetched = await pMap(files, (file) => this.fetchAndNormalize(file), {
      concurrency: ONEDRIVE_FETCH_CONCURRENCY,
    });
    const documents = fetched.filter((d): d is DocumentInput => d !== null);

    if (droppedByCutoff > 0) {
      log.info(`Skipped ${droppedByCutoff} files created before the cutoff, without downloading`);
    }

    const nextLink = page["@odata.nextLink"];
    if (nextLink) {
      log.info(`Bounded re-walk: ${total} files enumerated so far, ${files.length} re-extracted`);
      return syncPage<OneDriveCursor>(
        documents,
        {
          phase: "incremental",
          link: state.link,
          seen: prior,
          rewalk: {
            link: nextLink,
            seen: nextSeen,
            deleted: [...deleted],
            total,
            // Carried across pages, or a walk that is disowned once per attempt
            // would reset the count every time it got a page through and never
            // reach the ceiling it exists to hit.
            ...(walk.restarts ? { restarts: walk.restarts } : {}),
          },
        },
        {
          deletedExternalIds: [],
          hasMore: true,
          progress: { phase: "bootstrap", processed: documents.length },
        },
      );
    }

    // A walk that comes back far smaller than the drive was known to be is
    // alarming — a throttled page, a scope narrowed by a re-consent, a drive
    // not yet provisioned all read as mass deletion. It is deliberately not
    // judged here.
    //
    // The tempting move is a coverage floor: refuse to reconcile when the walk
    // found less than some fraction of what was known. It reads as the cautious
    // choice, and it is not, because withholding a snapshot is not a delayed
    // signal — it is an absent one. The gateway is told nothing, so it marks
    // nothing, so no deadline ever runs, and a drive the operator genuinely
    // emptied stays in the index forever with no way back. That is a privacy
    // failure, and it is worse than the mass-delete the floor was guarding
    // against, because at least a wrong deletion is visible.
    //
    // Magnitude is the gateway's judgement in any case: it is the only
    // component that knows how many documents it holds, and it responds by
    // marking absent documents with a deadline and corroborating across reads
    // before removing anything. What this walk owes it is an honest answer
    // about whether the read was complete — which is what the delta-expiry
    // path above provides by discarding its accumulator rather than
    // reconciling from a partial enumeration.
    log.info(`Bounded re-walk complete: ${total} files enumerated`);

    return syncPage<OneDriveCursor>(
      documents,
      { phase: "incremental", link: page["@odata.deltaLink"], seen: nextSeen },
      {
        deletedExternalIds: [...deleted],
        presentExternalIds: Object.keys(nextSeen),
        progress: { phase: "bootstrap", processed: documents.length },
      },
    );
  }

  // ── Page processing ────────────────────────────────────────────────

  /**
   * Split one delta page into deletions and to-fetch files, update the `seen`
   * fingerprint map in place, and normalize the files. Folders and the
   * facet-less drive root are skipped (no content). Deletions are signalled by
   * the `deleted` facet.
   */
  private async processPage(
    items: DriveItem[],
    seen: Record<string, string>,
  ): Promise<{ documents: DocumentInput[]; deletedExternalIds: string[] }> {
    const deletedExternalIds: string[] = [];
    const files: DriveItem[] = [];
    let droppedByCutoff = 0;

    for (const item of items) {
      if (item.deleted) {
        deletedExternalIds.push(item.id);
        delete seen[item.id];
        continue;
      }
      if (!item.file || !item.name) continue; // folder or facet-less root
      if (!this.withinCutoff(item)) {
        // Decided from the delta page's own `createdDateTime`, before any
        // bytes move. The document would be dropped either way, but doing it
        // here is the difference between reading a file's metadata and
        // downloading it, OCR-ing it, and then discarding the result.
        droppedByCutoff++;
        delete seen[item.id];
        continue;
      }
      seen[item.id] = fingerprintDriveItem(item);
      files.push(item);
    }

    if (droppedByCutoff > 0) {
      log.info(`Skipped ${droppedByCutoff} files created before the cutoff, without downloading`);
    }

    const fetched = await pMap(files, (file) => this.fetchAndNormalize(file), {
      concurrency: ONEDRIVE_FETCH_CONCURRENCY,
    });
    const documents: DocumentInput[] = fetched.filter((d): d is DocumentInput => d !== null);
    return { documents, deletedExternalIds };
  }

  /** A page carrying no documents, only the cursor a recovery wants to persist. */
  private emptyRewalkPage(cursor: OneDriveCursor): SyncResult<OneDriveCursor> {
    return syncPage<OneDriveCursor>([], cursor, {
      deletedExternalIds: [],
      hasMore: true,
      progress: { phase: "bootstrap", processed: 0 },
    });
  }

  /**
   * Whether the item is recent enough to index under the configured cutoff.
   *
   * `createdDateTime` arrives on the delta page, so the question is answerable
   * before the file is fetched — `driveItem` delta takes no server-side filter,
   * which makes this the earliest the cutoff can be applied. An item with no
   * creation time is kept: an unreadable date is not evidence of age.
   */
  private withinCutoff(item: DriveItem): boolean {
    if (!this.dataCutoff) return true;
    if (!item.createdDateTime) return true;
    const created = Date.parse(item.createdDateTime);
    return Number.isNaN(created) || created >= this.dataCutoff.getTime();
  }

  // ── Normalization ──────────────────────────────────────────────────

  private async fetchAndNormalize(item: DriveItem): Promise<DocumentInput | null> {
    const rawMime = item.file?.mimeType;
    if (!item.name || !rawMime) return null;
    // Recover the real type when OneDrive stored a generic MIME for a
    // recognizable extension (e.g. a .pkpass stored as application/octet-stream).
    const mimeType = resolveEffectiveMimeType(item.name, rawMime);
    if (!isProcessable(mimeType, this.attachmentConfig.allowedTypes)) return null;

    // Skip oversized files before downloading. Text route is capped by
    // ONEDRIVE_MAX_CONTENT_SIZE; the binary-extraction route by the attachment
    // config's own maxSizeBytes.
    const sizeCap = this.willUseAttachmentPipeline(mimeType)
      ? this.attachmentConfig.maxSizeBytes
      : ONEDRIVE_MAX_CONTENT_SIZE;
    if (item.size && item.size > sizeCap) return null;

    // `extractContent` returns null for a permanent no-content outcome and the
    // file is dropped. A *transient* extraction-backend failure throws instead
    // (it does not collapse to null) so the page fails and retries rather than
    // silently dropping the file forever (#680).
    const extracted = await this.extractContent(item, mimeType);
    if (extracted === null) return null;
    if (extracted.noText) return null;
    if (extracted.text.length > ONEDRIVE_MAX_CONTENT_SIZE) return null;
    const textContent = extracted.text;

    const path = folderPath(item);
    const content = [
      `# ${item.name}`,
      "",
      // The everyday name for the file's type, not its MIME string: the raw
      // type dilutes BM25, reads as machine output in a snippet, and makes
      // "Word documents" as a natural-language filter miss this source.
      `**Type:** ${fileKindName(mimeType)}`,
      path ? `**Folder:** ${path}` : "",
      "",
      "---",
      "",
      textContent,
    ]
      .filter(Boolean)
      .join("\n");

    const contentHash = computeContentHash(content);
    // Hash on the unwrapped extracted text for cross-source dedup — pairs with
    // the same projection on attachment-pipeline producers (Gmail/Outlook/Drive),
    // so the same PDF in OneDrive AND attached to an email links via
    // `duplicate-content`.
    const extractedContentHash = computeContentHash(textContent);

    const people = this.buildPeople(item, textContent);

    return {
      providerId: this.providerId,
      sourceId: this.id,
      externalId: item.id,
      title: item.name,
      content,
      contentHash,
      extractedContentHash,
      metadata: {
        // webUrl → sourceUrl is the same URL Outlook `referenceAttachment`
        // links point at, so the reference graph can auto-resolve
        // email→OneDrive-doc links once both sides exist (#262).
        sourceUrl: item.webUrl ?? undefined,
        tags: [],
        documentType: "file",
        people: people.length > 0 ? people : undefined,
        extra: {
          // Extractor-emitted extras first (e.g. `ocr`/`ocrPageCount`, #427)
          // so OneDrive carries the same provenance as Drive; own keys override.
          ...(extracted.extra ?? {}),
          mimeType,
          folderPath: path,
          shared: !!item.shared,
          fileSize: item.size,
          ...(extracted.pages !== undefined ? { pages: extracted.pages } : {}),
          ...(extracted.truncated ? { truncated: true } : {}),
        },
      },
      sourceCreatedAt: item.createdDateTime ?? new Date().toISOString(),
      sourceUpdatedAt: item.lastModifiedDateTime ?? new Date().toISOString(),
    };
  }

  /**
   * Map the file's actors (creator/editor + sharing facet) and content mentions
   * to person mentions. `createdBy`/`lastModifiedBy` are present on EVERY item —
   * the parity fix with Google Drive, whose `owners`/permissions yield an owner
   * for every file; the `shared` facet alone is empty for the user's own
   * (un-shared) files, so relying on it left OneDrive docs with zero
   * owner/author people.
   */
  private buildPeople(item: DriveItem, textContent: string): PersonMention[] {
    const people: PersonMention[] = [];
    const seen = new Set<string>();

    const add = (idn: DriveIdentitySet | undefined, role: PersonMention["role"]): void => {
      const user = idn?.user;
      if (!user) return;
      const email = user.email?.toLowerCase();
      const name = user.displayName ?? undefined;
      // Dedup by email when present (the strong key), else by name. An identity
      // with neither is unusable — skip it.
      const key = email ?? (name ? `name:${name.toLowerCase()}` : undefined);
      if (!key || seen.has(key)) return;
      seen.add(key);
      people.push({ role, name, emails: email ? [email] : undefined });
    };

    add(item.createdBy, "owner");
    add(item.lastModifiedBy, "author");
    add(item.shared?.owner, "owner");
    add(item.shared?.sharedBy, "author");

    for (const email of extractEmailsFromText(textContent)) {
      if (seen.has(email)) continue;
      seen.add(email);
      people.push({ role: "mentioned", emails: [email] });
    }
    for (const phone of extractPhonesFromText(textContent)) {
      people.push({ role: "mentioned", phones: [phone], allowPersonCreation: false });
    }

    return people;
  }

  /**
   * Whether `extractContent` for this MIME type routes through the shared
   * attachment pipeline (PDF / Office / EML) rather than the verbatim-text
   * download path. Picks the right size cap.
   */
  private willUseAttachmentPipeline(mimeType: string): boolean {
    if (isTextMimeType(mimeType)) return false;
    return this.attachmentConfig.allowedTypes.includes(mimeType);
  }

  private async extractContent(
    item: DriveItem,
    mimeType: string,
  ): Promise<ExtractionResult | null> {
    const contentPath = `/me/drive/items/${item.id}/content`;
    try {
      if (isTextMimeType(mimeType)) {
        const bytes = await this.graph.getBytes(contentPath);
        if (bytes.length === 0) return null;
        return { text: new TextDecoder().decode(bytes), truncated: false };
      }

      // Binary files (PDF, Office, EML, …) — route through the shared attachment
      // pipeline if available and the type is allow-listed.
      if (this.extractAttachment && this.attachmentConfig.enabled) {
        const check = shouldExtractAttachment(mimeType, item.size ?? null, this.attachmentConfig);
        if (!check.extract) return null;

        const bytes = await this.graph.getBytes(contentPath);
        if (bytes.length === 0) {
          log.debug(
            `OneDrive item ${item.id} (${mimeType}, advertised ${item.size} bytes) returned empty bytes — treating as failed extraction`,
          );
          return null;
        }
        return this.extractAttachment(bytes, mimeType, {
          maxTextLength: this.attachmentConfig.maxTextLength,
        });
      }

      return null;
    } catch (error: unknown) {
      // A transient extraction-backend failure must NOT collapse to a null drop
      // — that silently omits the file and advances the cursor past it, never to
      // be retried (#680). Re-throw so the page fails and the cursor stays put.
      // A DeltaExpiredError can't arrive here (content paths aren't delta), but
      // an AuthError should propagate too. Permanent failures stay a null drop.
      if (isTransientSyncError(error)) throw error;
      if (error instanceof DeltaExpiredError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`Failed to extract content from OneDrive item ${item.id} (${mimeType}): ${msg}`);
      return null;
    }
  }
}

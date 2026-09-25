// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { google, type drive_v3 } from "googleapis";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
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
import { makeCursorValidator, applyDataCutoff } from "@omnesis/source-sdk";
import { SourceId, ProviderId, isTransientSyncError } from "@omnesis/types";
import {
  GOOGLE_PAGE_SIZE,
  GOOGLE_FETCH_CONCURRENCY,
  DRIVE_MAX_CONTENT_SIZE,
  DRIVE_FILE_FIELDS,
  DRIVE_EXPORT_MAP,
  DRIVE_SKIP_MIME_TYPES,
  DRIVE_SKIP_MIME_PREFIXES,
  DRIVE_TEXT_MIME_TYPES,
  DRIVE_TEXT_MIME_PREFIXES,
} from "./constants.js";
import { mapGoogleApiError } from "./api-error.js";
import type {
  AttachmentExtractionConfig,
  AttachmentExtractFn,
  ExtractionResult,
} from "@omnesis/core";
import type { SyncCursor, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, PersonMention } from "@omnesis/types";

const log = createLogger("source:google-drive");

export interface DriveSyncCursor extends SyncCursor {
  phase: "bootstrap" | "incremental";
  /** Page token for files.list during bootstrap */
  pageToken?: string;
  /** Start page token for changes.list during incremental sync */
  startPageToken?: string;
}

export function isDriveSyncCursor(v: unknown): v is DriveSyncCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return c.phase === "bootstrap" || c.phase === "incremental";
}

const validateDriveSyncCursor = makeCursorValidator(isDriveSyncCursor);

function isGoogleWorkspaceType(mimeType: string): boolean {
  return mimeType in DRIVE_EXPORT_MAP;
}

function isTextMimeType(mimeType: string): boolean {
  if (DRIVE_TEXT_MIME_TYPES.has(mimeType)) return true;
  return DRIVE_TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

function shouldSkip(mimeType: string): boolean {
  if (DRIVE_SKIP_MIME_TYPES.has(mimeType)) return true;
  return DRIVE_SKIP_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

/**
 * Whether the file is processable at all — either we can extract it directly
 * (Workspace export, text mime) or the shared attachment pipeline can handle
 * the binary (PDF / Office / EML / text-family). The actual decision to
 * download binary bytes is gated again by `shouldExtractAttachment` against
 * `attachmentConfig.allowedTypes` at fetch time, so config opt-outs still
 * win — this gate only prevents skipping a file outright.
 */
function isProcessable(mimeType: string, allowedAttachmentTypes: ReadonlyArray<string>): boolean {
  // An explicitly allow-listed type is always processable, even if it matches
  // a skip prefix. This is what lets image OCR reach Drive files: `image/*` is
  // in the default allow-list (resolveAttachmentConfig), overriding the default
  // skip of binary media (#427). With no OCR backend assigned the image is
  // downloaded but extraction returns null (extraction-failed), retried later.
  if (allowedAttachmentTypes.includes(mimeType)) return true;
  if (shouldSkip(mimeType)) return false;
  return isGoogleWorkspaceType(mimeType) || isTextMimeType(mimeType);
}

/**
 * Drive's own document types, which exist nowhere else. Everything a file could
 * be regardless of where it is stored comes from the shared vocabulary.
 */
const DRIVE_FILE_KINDS: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
};

function friendlyTypeName(mimeType: string): string {
  return fileKindName(mimeType, DRIVE_FILE_KINDS);
}

export interface GoogleDriveSourceOptions {
  attachmentConfig?: AttachmentExtractionConfig;
  extractAttachment?: AttachmentExtractFn;
}

/**
 * Google Drive source.
 * Fetches text content from Google Drive files and normalizes them into Documents.
 */
export class GoogleDriveSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;

  private drive: drive_v3.Drive;
  private dataCutoff?: Date;
  private attachmentConfig: AttachmentExtractionConfig;
  private extractAttachment?: AttachmentExtractFn;

  constructor(
    auth: OAuth2Client,
    accountId?: string,
    dataCutoff?: string,
    opts?: GoogleDriveSourceOptions,
  ) {
    this.drive = google.drive({ version: "v3", auth });
    this.id = SourceId(accountId ? `google-drive:${accountId}` : "google-drive");
    this.providerId = ProviderId(accountId ? `google:${accountId}` : "google");
    this.attachmentConfig = opts?.attachmentConfig ?? resolveAttachmentConfig();
    this.extractAttachment = opts?.extractAttachment;
    if (dataCutoff) {
      this.dataCutoff = new Date(dataCutoff);
      log.info(`Data cutoff: ${dataCutoff}`);
    }
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    const state = validateDriveSyncCursor(cursor) ?? {
      phase: "bootstrap",
    };

    // One typed boundary for every phase. The mapper returns an existing
    // `SyncError` unchanged, so paths that already classify themselves are
    // unaffected; this is what stops an unclassified SDK throw — a transport
    // failure above all — reaching the collector as kind `unknown` with a
    // message that names neither the API nor the request.
    try {
      if (state.phase === "bootstrap" || !state.startPageToken) {
        log.debug("Running bootstrap sync", { pageToken: state.pageToken });
        return await this.bootstrapSync(state);
      }

      log.debug("Running incremental sync", {
        startPageToken: state.startPageToken,
      });
      return await this.incrementalSync(state);
    } catch (error: unknown) {
      throw mapGoogleApiError(error);
    }
  }

  private async bootstrapSync(state: DriveSyncCursor): Promise<SyncResult> {
    // Capture the current changes token on first page so incremental sync
    // picks up from where bootstrap started.
    let startPageToken = state.startPageToken;
    if (!state.pageToken) {
      const tokenRes = await this.drive.changes.getStartPageToken();
      startPageToken = tokenRes.data.startPageToken ?? undefined;
      // Total file count is intentionally omitted — the previous estimate
      // paginated `files.list` 100+ times before fetching the first real
      // bootstrap page, and the count was structurally larger than the
      // indexable subset (folders / images / videos / unsupported binaries
      // all counted), so the progress bar plateaued mid-run anyway. The
      // UI handles missing-total gracefully by rendering an indeterminate
      // bar with "X files indexed".
    }

    // Push dataCutoff into Drive's `q=` so files.list only walks files
    // created after the cutoff. We filter on `createdTime` to match the
    // client-side filter below (which uses `sourceCreatedAt = createdTime`).
    // Drive's query language wants RFC 3339 with single-quoted dates.
    const q = this.dataCutoff
      ? `trashed=false and createdTime >= '${this.dataCutoff.toISOString()}'`
      : "trashed=false";

    const res = await this.drive.files.list({
      q,
      pageSize: GOOGLE_PAGE_SIZE,
      pageToken: state.pageToken ?? undefined,
      fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
      spaces: "drive",
      orderBy: "modifiedTime",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    const files = res.data.files ?? [];
    // RTT-bound: Workspace exports + binary downloads are one round-trip
    // each. Run in parallel with the same concurrency cap as Gmail.
    const fetched = await pMap(files, (file) => this.fetchAndNormalize(file), {
      concurrency: GOOGLE_FETCH_CONCURRENCY,
    });
    const documents: DocumentInput[] = fetched.filter((d): d is DocumentInput => d !== null);

    // The `q=` above already bounds this page by `createdTime`, so this is the
    // backstop for anything the query let through — and the only cutoff the
    // incremental path has, since `changes.list` takes no query.
    const filteredDocuments = applyDataCutoff(documents, this.dataCutoff, log, "files");

    const hasMore = !!res.data.nextPageToken;

    return {
      documents: filteredDocuments,
      deletedExternalIds: [],
      cursor: {
        phase: hasMore ? "bootstrap" : "incremental",
        pageToken: res.data.nextPageToken ?? undefined,
        startPageToken,
      } satisfies DriveSyncCursor,
      hasMore,
      progress: {
        phase: "bootstrap",
        processed: filteredDocuments.length,
      },
    };
  }

  private async incrementalSync(state: DriveSyncCursor): Promise<SyncResult> {
    const documents: DocumentInput[] = [];
    const deletedExternalIds: string[] = [];

    try {
      const res = await this.drive.changes.list({
        pageToken: state.startPageToken!,
        pageSize: GOOGLE_PAGE_SIZE,
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${DRIVE_FILE_FIELDS}))`,
        spaces: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });

      const changes = res.data.changes ?? [];
      const updates: drive_v3.Schema$File[] = [];

      for (const change of changes) {
        if (!change.fileId) continue;

        if (change.removed || change.file?.trashed) {
          deletedExternalIds.push(change.fileId);
          continue;
        }

        if (change.file) updates.push(change.file);
      }

      const fetched = await pMap(updates, (file) => this.fetchAndNormalize(file), {
        concurrency: GOOGLE_FETCH_CONCURRENCY,
      });
      for (const doc of fetched) {
        if (doc) documents.push(doc);
      }

      // Apply data cutoff: filter out files older than the cutoff date
      const filteredDocuments = applyDataCutoff(documents, this.dataCutoff, log, "changed files");

      const hasMore = !!res.data.nextPageToken;

      return {
        documents: filteredDocuments,
        deletedExternalIds,
        cursor: {
          phase: "incremental",
          startPageToken:
            res.data.newStartPageToken ?? res.data.nextPageToken ?? state.startPageToken,
        } satisfies DriveSyncCursor,
        hasMore,
      };
    } catch (error: unknown) {
      const apiError = error as { code?: number };
      // Page token expired — need to re-bootstrap
      if (apiError.code === 404 || apiError.code === 403) {
        log.warn("Drive changes token expired, triggering full re-sync");
        return this.bootstrapSync({ phase: "bootstrap" });
      }
      throw mapGoogleApiError(error);
    }
  }

  private async fetchAndNormalize(file: drive_v3.Schema$File): Promise<DocumentInput | null> {
    if (!file.id || !file.name || !file.mimeType) return null;
    // Recover the real type when Drive stored a generic MIME for a recognizable
    // extension (e.g. a .pkpass uploaded as application/octet-stream).
    const mimeType = resolveEffectiveMimeType(file.name, file.mimeType);
    if (!isProcessable(mimeType, this.attachmentConfig.allowedTypes)) return null;

    // Skip large files before downloading. The Workspace-export and text path
    // is bounded by DRIVE_MAX_CONTENT_SIZE (10 MB historical default); the
    // binary-extraction path is bounded by attachmentConfig.maxSizeBytes
    // (25 MB default). Pick the cap appropriate to the route we'll take.
    const sizeCap = this.willUseAttachmentPipeline(mimeType)
      ? this.attachmentConfig.maxSizeBytes
      : DRIVE_MAX_CONTENT_SIZE;
    if (file.size && parseInt(file.size, 10) > sizeCap) return null;

    // `extractContent` returns null for a permanent no-content outcome
    // (unsupported type, corrupt/empty binary) and the file is dropped from
    // this page. A *transient* extraction-backend failure throws out of here
    // instead (it does not collapse to null) so the page fails and retries
    // rather than silently dropping the file forever (#680).
    const extracted = await this.extractContent(file.id, mimeType, file.size ?? null);
    if (extracted === null) return null;
    if (extracted.noText) return null;
    if (extracted.text.length > DRIVE_MAX_CONTENT_SIZE) return null;
    const textContent = extracted.text;

    const content = [
      `# ${file.name}`,
      "",
      `**Type:** ${friendlyTypeName(mimeType)}`,
      file.owners?.[0]?.displayName ? `**Owner:** ${file.owners[0].displayName}` : "",
      "",
      "---",
      "",
      textContent,
    ]
      .filter(Boolean)
      .join("\n");

    const contentHash = computeContentHash(content);
    // Hash on the unwrapped extracted text for cross-source dedup — pairs
    // with the same projection on attachment-pipeline producers
    // (Gmail/Outlook/iMessage/WhatsApp), so the same PDF in Drive AND
    // attached to an email links via `duplicate-content`.
    const extractedContentHash = computeContentHash(textContent);

    // Build people mentions from permissions
    const people: PersonMention[] = [];
    const seenEmails = new Set<string>();

    for (const perm of file.permissions ?? []) {
      if (perm.type !== "user" || !perm.emailAddress) continue;
      const email = perm.emailAddress.toLowerCase();
      seenEmails.add(email);

      // Map Drive roles to PersonMention roles:
      // owner → owner, writer → author (edit access), reader/commenter → recipient (read access)
      let role: PersonMention["role"];
      if (perm.role === "owner") role = "owner";
      else if (perm.role === "writer") role = "author";
      else role = "recipient";

      people.push({
        role,
        name: perm.displayName ?? undefined,
        emails: [email],
      });
    }

    // Fallback: if no permissions returned, use owners field
    if (people.length === 0 && file.owners?.[0]) {
      const owner = file.owners[0];
      const email = owner.emailAddress?.toLowerCase();
      if (email) seenEmails.add(email);
      people.push({
        role: "owner",
        name: owner.displayName ?? undefined,
        emails: email ? [email] : undefined,
      });
    }

    // Extract mentioned emails/phones from content, skipping people already listed
    const mentionedEmails = extractEmailsFromText(textContent).filter((e) => !seenEmails.has(e));
    const mentionedPhones = extractPhonesFromText(textContent);
    for (const email of mentionedEmails) {
      people.push({ role: "mentioned", emails: [email] });
    }
    for (const phone of mentionedPhones) {
      people.push({ role: "mentioned", phones: [phone], allowPersonCreation: false });
    }

    return {
      providerId: this.providerId,
      sourceId: this.id,
      externalId: file.id,
      title: file.name,
      content,
      contentHash,
      extractedContentHash,
      metadata: {
        sourceUrl: file.webViewLink ?? undefined,
        tags: [],
        documentType: "file",
        people: people.length > 0 ? people : undefined,
        // `extra` does NOT carry folder path / driveLocation today.
        // Adding `path`, `driveLocation`, `driveName`, `parentIds` is gated
        // on extending DRIVE_FILE_FIELDS + a folder-cache resolver.
        extra: {
          // Extractor-emitted extras first (e.g. `ocr`/`ocrPageCount` when a
          // scanned/image-only page was OCR'd, #427) so Drive carries the same
          // provenance as attachment docs from Gmail/Outlook; Drive's own keys
          // below override on collision.
          ...(extracted.extra ?? {}),
          mimeType,
          shared: file.shared ?? false,
          fileSize: file.size ? parseInt(file.size, 10) : undefined,
          ...(extracted.pages !== undefined ? { pages: extracted.pages } : {}),
          ...(extracted.truncated ? { truncated: true } : {}),
        },
      },
      sourceCreatedAt: file.createdTime ?? new Date().toISOString(),
      sourceUpdatedAt: file.modifiedTime ?? new Date().toISOString(),
    };
  }

  /**
   * Whether `extractContent` for this MIME type will route through the shared
   * attachment pipeline (PDF / Office / EML) rather than the Workspace export
   * or direct text-download paths. Used to pick the right size cap.
   */
  private willUseAttachmentPipeline(mimeType: string): boolean {
    if (DRIVE_EXPORT_MAP[mimeType]) return false;
    if (isTextMimeType(mimeType)) return false;
    return this.attachmentConfig.allowedTypes.includes(mimeType);
  }

  private async extractContent(
    fileId: string,
    mimeType: string,
    fileSize: string | null,
  ): Promise<ExtractionResult | null> {
    try {
      const exportMimeType = DRIVE_EXPORT_MAP[mimeType];
      if (exportMimeType) {
        const res = await this.drive.files.export({
          fileId,
          mimeType: exportMimeType,
        });
        const text = typeof res.data === "string" ? res.data : String(res.data);
        return { text, truncated: false };
      }

      if (isTextMimeType(mimeType)) {
        const res = await this.drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
        const text = typeof res.data === "string" ? res.data : String(res.data);
        return { text, truncated: false };
      }

      // Binary files (PDF, Office, EML, …) — route through the shared
      // attachment-extraction pipeline if it's available and the type is
      // allowlisted. #270.
      if (this.extractAttachment && this.attachmentConfig.enabled) {
        const sizeNumber = fileSize !== null ? parseInt(fileSize, 10) : null;
        const check = shouldExtractAttachment(mimeType, sizeNumber, this.attachmentConfig);
        if (!check.extract) return null;

        const bytes = await this.downloadBytes(fileId);
        if (bytes.length === 0) {
          // Drive sometimes returns empty bytes for files that are listed in
          // metadata but have no usable payload (e.g. uploaded as zero-byte
          // stubs, in-flight uploads, or rare quirks of the Drive API). Don't
          // pass empty bytes downstream — extractors log noisy "0 bytes"
          // failures that look like a download bug. Treat as extraction failure.
          log.debug(
            `Drive file ${fileId} (${mimeType}, advertised ${sizeNumber} bytes) returned empty bytes — treating as failed extraction`,
          );
          return null;
        }
        const result = await this.extractAttachment(bytes, mimeType, {
          maxTextLength: this.attachmentConfig.maxTextLength,
        });
        return result;
      }

      return null;
    } catch (error: unknown) {
      // A transient non-OCR extraction failure must NOT be swallowed into a
      // null drop — that silently omits the file and advances the cursor past
      // it, never to be retried (#680). Re-throw so it propagates out of the
      // page's `pMap`, fails the sync page, and leaves the cursor un-advanced
      // for a retry next tick. Optional OCR failures are already normalized to
      // null by the collector's shared extractor; permanent extraction failures
      // (corrupt PDF, unsupported type, genuinely-no-text) also stay null.
      if (isTransientSyncError(error)) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`Failed to extract content from file ${fileId} (${mimeType}): ${msg}`);
      return null;
    }
  }

  /**
   * Download a Drive file's raw bytes. Used by the binary-extraction path —
   * Workspace docs go through `files.export`, plain-text MIME types go
   * through `files.get` with `responseType: "text"`, and only binaries that
   * the shared attachment pipeline can decode (PDF / Office / EML) come
   * through here.
   */
  private async downloadBytes(fileId: string): Promise<Uint8Array> {
    const res = await this.drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    // googleapis returns ArrayBuffer when responseType is "arraybuffer" in
    // Node, but the typings widen it to `any`. The two real-world shapes
    // are ArrayBuffer (production) and Uint8Array (test mocks); Node's
    // Buffer extends Uint8Array, so the Uint8Array branch covers it too.
    // The final warning is a safety net for any unexpected runtime shape.
    const data = res.data as unknown;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    log.warn(
      `downloadBytes ${fileId}: unexpected response shape (${(data as { constructor?: { name?: string } } | null)?.constructor?.name}), returning empty`,
    );
    return new Uint8Array(0);
  }
}

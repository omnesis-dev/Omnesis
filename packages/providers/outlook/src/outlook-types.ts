// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { makeCursorValidator } from "@omnesis/source-sdk";
import type { AttachmentExtractionConfig, AttachmentExtractFn } from "@omnesis/core";
import type { SyncCursor } from "@omnesis/source-sdk";

export const PAGE_SIZE = 100;

/** Body-backfill page size: per-message GETs, sent in batches between cursor saves. */
export const BACKFILL_BATCH_SIZE = 50;

/**
 * Well-known folder aliases we always skip during sync.
 *
 * We resolve these via `/me/mailFolders/{alias}` at folder-enumeration time
 * and match by ID afterwards — Microsoft Graph v1.0 does NOT return
 * `wellKnownName` on the folder list response, so any approach that filters
 * on `wellKnownName` is dead code. Aliases work as a path segment and return
 * the actual folder object regardless of locale ("Deleted Items" /
 * "Éléments supprimés" / "Posta indesiderata" collapse to the same id).
 */
export const SKIP_FOLDER_ALIASES = ["deleteditems", "junkemail"] as const;

export const COMMON_FIELDS = [
  "id",
  "subject",
  "bodyPreview",
  "from",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "receivedDateTime",
  "sentDateTime",
  "lastModifiedDateTime",
  "conversationId",
  "internetMessageId",
  "importance",
  "isRead",
  "isDraft",
  "hasAttachments",
  "webLink",
  "parentFolderId",
  "categories",
  "flag",
];

/**
 * Bootstrap pass 1 omits the heavy `body` field. Microsoft Graph caps each
 * page response by total payload bytes, so including `body` cuts effective
 * page size from ~100 to ~7 messages. We backfill bodies in pass 2 via
 * per-message GETs.
 */
export const BOOTSTRAP_SELECT = COMMON_FIELDS.join(",");

/** Incremental + body-backfill paths request `body` (~full content). */
export const FULL_SELECT = [...COMMON_FIELDS, "body"].join(",");

export interface GraphEmailAddress {
  name?: string;
  address: string;
}

export interface GraphRecipient {
  emailAddress: GraphEmailAddress;
}

export interface GraphMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType: "text" | "html"; content: string };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  lastModifiedDateTime?: string;
  conversationId?: string;
  internetMessageId?: string;
  importance?: "low" | "normal" | "high";
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  webLink?: string;
  parentFolderId?: string;
  categories?: string[];
  flag?: { flagStatus: "notFlagged" | "flagged" | "complete" };
  "@removed"?: { reason: string };
}

export interface GraphMailFolder {
  id: string;
  displayName: string;
  wellKnownName?: string;
  totalItemCount: number;
  childFolderCount: number;
}

export interface GraphDeltaResponse {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export interface GraphFolderListResponse {
  value: GraphMailFolder[];
  "@odata.nextLink"?: string;
}

export interface GraphFileAttachment {
  "@odata.type": string;
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentBytes: string;
}

/**
 * Microsoft Graph reference attachment — a OneDrive / SharePoint link
 * the sender attached as a pointer rather than a file copy. Has no
 * `contentBytes`; the URL lives in `sourceUrl`. We surface these as
 * link-only entries in the parent's metadata.extra.attachments (#262);
 * once the OneDrive/SharePoint source ships (#263) the link graph will
 * resolve them to indexed docs automatically.
 */
export interface GraphReferenceAttachment {
  "@odata.type": string;
  id: string;
  name: string;
  contentType?: string;
  size?: number;
  sourceUrl: string;
  providerType?: string;
  permission?: string;
  isFolder?: boolean;
}

export type GraphAttachment = GraphFileAttachment | GraphReferenceAttachment;

export interface GraphAttachmentListResponse {
  value: GraphAttachment[];
}

export interface OutlookEmailCursor extends SyncCursor {
  phase: "bootstrap" | "body-backfill" | "incremental";
  /** Per-folder delta tokens. Key = folderId */
  folderDeltas: Record<string, { deltaLink: string }>;
  /** Bootstrap: index into folderIds we're currently syncing */
  currentFolderIndex?: number;
  /** Bootstrap: ordered list of folder IDs discovered at start */
  folderIds?: string[];
  /** Bootstrap: pagination link within the current folder */
  currentPageLink?: string;
  /** Bootstrap: total message count for progress */
  totalMessages?: number;
  /** body-backfill: queue of message IDs whose bodies we still need to fetch */
  backfillIds?: string[];
  /** body-backfill: index into backfillIds for resuming after a cursor save */
  backfillIndex?: number;
  /**
   * Incremental: folder IDs left to drain in the current cycle. We process
   * one folder's full delta page-chain per `sync()` call, then yield with
   * `hasMore: true` so the engine can checkpoint, honour cancellation, and
   * round-robin with other sources. Empty / undefined means a new cycle:
   * we re-enumerate folders and refill the queue.
   */
  pendingIncrementalFolderIds?: string[];
}

export interface OutlookEmailSourceOptions {
  attachmentConfig?: AttachmentExtractionConfig;
  extractAttachment?: AttachmentExtractFn;
}

export function isOutlookEmailCursor(v: unknown): v is OutlookEmailCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (c.phase !== "bootstrap" && c.phase !== "body-backfill" && c.phase !== "incremental") {
    return false;
  }
  // `folderDeltas` is non-optional — a cursor missing it would crash later.
  // Reject so we fall back to the `{ phase: "bootstrap", folderDeltas: {} }` default.
  if (!c.folderDeltas || typeof c.folderDeltas !== "object") return false;
  return true;
}

export const validateOutlookEmailCursor = makeCursorValidator(isOutlookEmailCursor);

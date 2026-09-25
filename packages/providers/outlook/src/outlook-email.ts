// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, resolveAttachmentConfig } from "@omnesis/core";
import { syncPage } from "@omnesis/source-sdk";
import { SourceId, ProviderId } from "@omnesis/types";
import { outlookIconUrl } from "./icons.js";
import {
  GraphClient,
  DeltaExpiredError,
  AuthError,
  toConnectionAuthError,
} from "./graph-client.js";
import {
  PAGE_SIZE,
  SKIP_FOLDER_ALIASES,
  BOOTSTRAP_SELECT,
  FULL_SELECT,
  type GraphDeltaResponse,
  type GraphFolderListResponse,
  type GraphMailFolder,
  type GraphMessage,
  type OutlookEmailCursor,
  type OutlookEmailSourceOptions,
} from "./outlook-types.js";
import { normalizeMessage as normalizeOutlookMessage } from "./outlook-normalizer.js";
import { bodyBackfillSync as runBodyBackfillSync } from "./outlook-body-backfill.js";
import type { AttachmentExtractionConfig, AttachmentExtractFn } from "@omnesis/core";
import type { SyncResult } from "@omnesis/source-sdk";
import type {
  SourceId as SourceIdType,
  ProviderId as ProviderIdType,
  DocumentInput,
} from "@omnesis/types";

export type { OutlookEmailCursor, OutlookEmailSourceOptions } from "./outlook-types.js";

const log = createLogger("source:outlook-email");

// NOTE: Graph deltaLinks bake the original `$select` into the `$deltatoken`
// session state and ignore any `$select` modification on subsequent follow-ups.
// Earlier code attempted `rewriteSelect(deltaLink, FULL_SELECT)` to upgrade the
// bootstrap-era (bodyless) select to one that includes `body` — but Graph
// silently kept returning bodyless responses, so post-bootstrap incremental
// docs landed without bodies. The fix is per-message body backfill in
// `incrementalSync` for any delta entry that comes back without `body`.

// TODO: Cross-folder delta — Microsoft Graph beta API supports
// GET /me/messages/delta which tracks changes across ALL folders in a single
// delta token. This would simplify cursor management significantly and reduce
// the number of API calls per sync cycle (currently one per folder).
// https://learn.microsoft.com/en-us/graph/api/message-delta

export class OutlookEmailSource {
  readonly id: SourceIdType;
  readonly name = "Outlook Email";
  readonly providerId: ProviderIdType;
  readonly unitName = "emails";
  readonly icon = { sfSymbol: "envelope.fill", color: "#0078D4", url: outlookIconUrl };
  readonly urlPatterns = [
    { regex: "outlook\\.live\\.com/mail/\\d+/id/([^/]+)" },
    { regex: "outlook\\.office365\\.com/mail/.*?/id/([^/]+)" },
    { regex: "outlook\\.office\\.com/mail/.*?/id/([^/]+)" },
  ];

  private graph: GraphClient;
  private dataCutoff?: Date;
  private attachmentConfig: AttachmentExtractionConfig;
  private extractAttachment?: AttachmentExtractFn;

  constructor(
    getAccessToken: () => Promise<string>,
    sourceId: string,
    providerId: string,
    dataCutoff?: string,
    opts?: OutlookEmailSourceOptions,
  ) {
    this.graph = new GraphClient(getAccessToken);
    this.id = SourceId(sourceId);
    this.providerId = ProviderId(providerId);
    this.attachmentConfig = opts?.attachmentConfig ?? resolveAttachmentConfig();
    this.extractAttachment = opts?.extractAttachment;
    if (dataCutoff) {
      this.dataCutoff = new Date(dataCutoff);
      log.info(`Data cutoff: ${dataCutoff}`);
    }
  }

  async sync(cursor: OutlookEmailCursor | null): Promise<SyncResult<OutlookEmailCursor>> {
    const state = cursor ?? {
      phase: "bootstrap" as const,
      folderDeltas: {},
    };

    try {
      if (state.phase === "bootstrap") {
        return await this.bootstrapSync(state);
      }

      if (state.phase === "body-backfill") {
        return await this.bodyBackfillSync(state);
      }

      return await this.incrementalSync(state);
    } catch (error) {
      // Mail, Calendar and OneDrive all read through the same account token
      // (see `toConnectionAuthError`), so a dead credential is never a fact
      // about this one folder or message.
      if (error instanceof AuthError) throw toConnectionAuthError(error);
      throw error;
    }
  }

  // ── Bootstrap ────────────────────────────────────────────────────

  private async bootstrapSync(state: OutlookEmailCursor): Promise<SyncResult<OutlookEmailCursor>> {
    // First call: discover folders
    if (!state.folderIds) {
      const folders = await this.fetchAllFolders();
      state.folderIds = folders.map((f) => f.id);
      state.currentFolderIndex = 0;
      state.totalMessages = folders.reduce((sum, f) => sum + f.totalItemCount, 0);
      log.info(`Bootstrap: ${folders.length} folders, ~${state.totalMessages} messages`);
    }

    const folderIndex = state.currentFolderIndex ?? 0;

    // All folders done
    if (folderIndex >= state.folderIds.length) {
      log.info("Bootstrap complete");
      return syncPage<OutlookEmailCursor>([], {
        phase: "incremental",
        folderDeltas: state.folderDeltas,
      });
    }

    const folderId = state.folderIds[folderIndex];

    // Build delta URL for this folder. Bootstrap omits `body` from $select so
    // pages return ~100 messages instead of ~7 — the body field dominates the
    // per-page byte budget. Bodies are backfilled in the body-backfill phase.
    let deltaUrl: string;
    if (state.currentPageLink) {
      deltaUrl = state.currentPageLink;
    } else {
      deltaUrl = `/me/mailFolders/${folderId}/messages/delta?$select=${BOOTSTRAP_SELECT}&$top=${PAGE_SIZE}`;
      if (this.dataCutoff) {
        deltaUrl += `&$filter=receivedDateTime ge ${this.dataCutoff.toISOString()}`;
      }
    }

    const res = await this.graph.get<GraphDeltaResponse>(deltaUrl);

    // Normalize messages and queue them for body-backfill so pass 2 can fetch
    // the full body once metadata enumeration is done. Skip the queue for any
    // message whose body is already populated — Graph honors $select but tests
    // and edge cases may surface bodies anyway, and re-fetching them is just
    // wasted Graph quota.
    const documents: DocumentInput[] = [];
    const newBackfillIds: string[] = [];
    for (const msg of res.value) {
      if (msg["@removed"]) continue;
      const docs = await this.normalizeMessage(msg);
      if (docs.length > 0 && !msg.body) newBackfillIds.push(msg.id);
      documents.push(...docs);
    }
    const backfillIds = [...(state.backfillIds ?? []), ...newBackfillIds];

    // Apply data cutoff post-fetch as safety net
    let cutoffReached = false;
    if (this.dataCutoff) {
      const cutoffTime = this.dataCutoff.getTime();
      const beforeCount = documents.length;
      const filtered = documents.filter(
        (doc) => new Date(doc.sourceCreatedAt).getTime() >= cutoffTime,
      );
      if (filtered.length < beforeCount) {
        cutoffReached = true;
        log.info(
          `Data cutoff reached in folder ${folderId}, filtered ${beforeCount - filtered.length} old emails`,
        );
      }
      documents.length = 0;
      documents.push(...filtered);
    }

    // Determine next state
    if (res["@odata.nextLink"] && !cutoffReached) {
      // More pages in this folder
      state.currentPageLink = res["@odata.nextLink"];
      return syncPage<OutlookEmailCursor>(
        documents,
        { ...state, backfillIds },
        {
          hasMore: true,
          progress: {
            phase: "bootstrap",
            total: state.totalMessages,
            processed: documents.length,
          },
        },
      );
    }

    // Folder complete
    if (res["@odata.deltaLink"]) {
      state.folderDeltas[folderId] = { deltaLink: res["@odata.deltaLink"] };
    }
    state.currentFolderIndex = folderIndex + 1;
    state.currentPageLink = undefined;

    const allFoldersDone = (state.currentFolderIndex ?? 0) >= state.folderIds.length;

    if (allFoldersDone) {
      // Pass 1 (metadata) is done. If we collected any IDs, transition to
      // pass 2 (body-backfill) so initial docs get full content. With no IDs
      // (empty mailbox) jump straight to incremental.
      if (backfillIds.length > 0) {
        log.info(
          `Bootstrap pass 1 complete (${backfillIds.length} messages queued for body-backfill)`,
        );
        return syncPage<OutlookEmailCursor>(
          documents,
          {
            phase: "body-backfill",
            folderDeltas: state.folderDeltas,
            backfillIds,
            backfillIndex: 0,
          },
          {
            hasMore: true,
            progress: {
              phase: "bootstrap",
              total: state.totalMessages,
              processed: documents.length,
            },
          },
        );
      }
      log.info("Bootstrap complete");
      return syncPage<OutlookEmailCursor>(documents, {
        phase: "incremental",
        folderDeltas: state.folderDeltas,
      });
    }

    return syncPage<OutlookEmailCursor>(
      documents,
      { ...state, backfillIds },
      {
        hasMore: true,
        progress: {
          phase: "bootstrap",
          total: state.totalMessages,
          processed: documents.length,
        },
      },
    );
  }

  // ── Body backfill ────────────────────────────────────────────────

  /**
   * Pass 2 of bootstrap: per-message GET to fetch each message's body.
   * Bootstrap pass 1 omits `body` from $select to keep pages large; this
   * phase fills in full bodies for messages that landed with `bodyPreview`
   * only. Idempotent — gateway dedups via contentHash so unchanged docs are
   * a no-op write.
   */
  private async bodyBackfillSync(
    state: OutlookEmailCursor,
  ): Promise<SyncResult<OutlookEmailCursor>> {
    return runBodyBackfillSync(state, {
      graph: this.graph,
      normalize: (msg) => this.normalizeMessage(msg),
    });
  }

  // ── Incremental ──────────────────────────────────────────────────

  private async incrementalSync(
    state: OutlookEmailCursor,
  ): Promise<SyncResult<OutlookEmailCursor>> {
    const documents: DocumentInput[] = [];
    const deletedExternalIds: string[] = [];
    const updatedDeltas = { ...state.folderDeltas };

    // Cycle start: no pending queue → re-enumerate folders, detect new/removed,
    // and refill the queue. Mid-cycle: trust the queue and skip re-enumeration
    // (a folder added during the cycle is picked up on the next cycle's start —
    // a small staleness window in exchange for not re-walking the folder tree
    // on every tick).
    let pending = state.pendingIncrementalFolderIds ? [...state.pendingIncrementalFolderIds] : null;

    if (pending === null) {
      let needsRebootstrap = false;
      const currentFolders = await this.fetchAllFolders();
      const currentFolderIds = new Set(currentFolders.map((f) => f.id));

      for (const folder of currentFolders) {
        if (!updatedDeltas[folder.id]) {
          log.info(`New folder detected: ${folder.displayName} (${folder.id}), will bootstrap`);
          needsRebootstrap = true;
        }
      }

      for (const folderId of Object.keys(updatedDeltas)) {
        if (!currentFolderIds.has(folderId)) {
          log.info(`Folder ${folderId} removed, dropping delta token`);
          delete updatedDeltas[folderId];
        }
      }

      if (needsRebootstrap) {
        return syncPage<OutlookEmailCursor>([], {
          phase: "bootstrap",
          folderDeltas: updatedDeltas,
        });
      }

      pending = Object.keys(updatedDeltas);
    }

    const folderId = pending.shift();
    if (folderId === undefined) {
      // Queue drained — cycle complete. Next call will re-enumerate.
      return syncPage<OutlookEmailCursor>([], {
        phase: "incremental",
        folderDeltas: updatedDeltas,
      });
    }

    const entry = updatedDeltas[folderId];
    if (entry) {
      try {
        // Bootstrap saved a deltaLink whose $deltatoken locks in the
        // metadata-only $select. Graph ignores any $select on subsequent
        // delta follow-ups, so delta responses here arrive without `body`.
        // We backfill body via per-message GET below for any message that
        // needs it.
        let nextUrl: string | undefined = entry.deltaLink;
        let newDeltaLink: string | undefined;

        while (nextUrl) {
          const page: GraphDeltaResponse = await this.graph.get<GraphDeltaResponse>(nextUrl);

          for (const msg of page.value) {
            if (msg["@removed"]) {
              deletedExternalIds.push(msg.id);
              continue;
            }
            const enriched = msg.body ? msg : await this.fetchFullMessage(msg);
            const docs = await this.normalizeMessage(enriched);
            documents.push(...docs);
          }

          nextUrl = page["@odata.nextLink"];
          if (page["@odata.deltaLink"]) {
            newDeltaLink = page["@odata.deltaLink"];
          }
        }

        if (newDeltaLink) {
          updatedDeltas[folderId] = { deltaLink: newDeltaLink };
        }
      } catch (error) {
        if (error instanceof DeltaExpiredError) {
          log.warn(`Delta token expired for folder ${folderId}, will re-bootstrap`);
          delete updatedDeltas[folderId];
          // Fall back to bootstrap; drop the pending queue so the
          // post-bootstrap cycle re-enumerates fresh.
          return syncPage<OutlookEmailCursor>(
            documents,
            {
              phase: "bootstrap",
              folderDeltas: updatedDeltas,
            },
            { deletedExternalIds },
          );
        }
        throw error;
      }
    }

    if (documents.length > 0 || deletedExternalIds.length > 0) {
      log.info(
        `Incremental folder ${folderId}: ${documents.length} new/updated, ${deletedExternalIds.length} deleted (${pending.length} folders pending)`,
      );
    }

    if (pending.length > 0) {
      return syncPage<OutlookEmailCursor>(
        documents,
        {
          phase: "incremental",
          folderDeltas: updatedDeltas,
          pendingIncrementalFolderIds: pending,
        },
        { deletedExternalIds, hasMore: true },
      );
    }

    return syncPage<OutlookEmailCursor>(
      documents,
      {
        phase: "incremental",
        folderDeltas: updatedDeltas,
      },
      { deletedExternalIds },
    );
  }

  // ── Folder enumeration ───────────────────────────────────────────

  /**
   * Resolve well-known folder aliases (deleteditems, junkemail, …) to their
   * actual folder IDs so we can skip them by ID rather than by `wellKnownName`
   * — Graph v1.0 doesn't return that property on the folder list response.
   * Aliases work as a path segment regardless of the user's locale.
   */
  private async resolveSkipFolderIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const alias of SKIP_FOLDER_ALIASES) {
      try {
        const folder = await this.graph.get<GraphMailFolder>(`/me/mailFolders/${alias}`);
        if (folder?.id) ids.add(folder.id);
      } catch (err) {
        // Account may not have this folder, or the alias may be unsupported —
        // leave it out of the skip set rather than blocking sync.
        log.debug(
          `Skip-folder alias '${alias}' not resolvable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return ids;
  }

  private async fetchAllFolders(): Promise<GraphMailFolder[]> {
    const skipIds = await this.resolveSkipFolderIds();
    const allFolders: GraphMailFolder[] = [];
    // Cycle guard. Microsoft Graph's mailFolders graph is intended to
    // be a tree, but rule-based or sync-glitch states have surfaced
    // self-referential / repeated `childFolderCount > 0` entries (the
    // Conversations + Sync Issues special folders are the historical
    // offenders). Without this set, an unbounded recursion eats the
    // whole sync tick and pins the source on `syncing` until the
    // newly-added wall-clock timeout (#324) kicks in.
    const visited = new Set<string>();
    let nextUrl: string | undefined = "/me/mailFolders?$top=100";

    while (nextUrl) {
      const page: GraphFolderListResponse = await this.graph.get<GraphFolderListResponse>(nextUrl);
      for (const folder of page.value) {
        if (skipIds.has(folder.id)) continue;
        if (visited.has(folder.id)) {
          log.warn(
            `Outlook folder cycle detected at root: ${folder.displayName} (${folder.id}) — skipping recursion`,
          );
          continue;
        }
        visited.add(folder.id);
        allFolders.push(folder);
        if (folder.childFolderCount > 0) {
          const children = await this.fetchChildFolders(folder.id, skipIds, visited);
          allFolders.push(...children);
        }
      }
      nextUrl = page["@odata.nextLink"];
    }

    return allFolders;
  }

  private async fetchChildFolders(
    parentId: string,
    skipIds: Set<string>,
    visited: Set<string>,
  ): Promise<GraphMailFolder[]> {
    const result: GraphMailFolder[] = [];
    const res = await this.graph.get<GraphFolderListResponse>(
      `/me/mailFolders/${parentId}/childFolders?$top=100`,
    );
    for (const folder of res.value) {
      if (skipIds.has(folder.id)) continue;
      if (visited.has(folder.id)) {
        log.warn(
          `Outlook folder cycle detected under ${parentId}: ${folder.displayName} (${folder.id}) — skipping recursion`,
        );
        continue;
      }
      visited.add(folder.id);
      result.push(folder);
      if (folder.childFolderCount > 0) {
        const children = await this.fetchChildFolders(folder.id, skipIds, visited);
        result.push(...children);
      }
    }
    return result;
  }

  // ── Per-message fetch ───────────────────────────────────────────

  /**
   * Re-fetch a message with FULL_SELECT to obtain the body. Used by
   * incrementalSync when a delta entry arrives without `body` (the bootstrap
   * deltatoken locks in a bodyless $select). Falls back to the original
   * message if the fetch fails so we still emit a doc — the next delta cycle
   * (or a subsequent edit) will get another chance.
   */
  private async fetchFullMessage(msg: GraphMessage): Promise<GraphMessage> {
    try {
      return await this.graph.get<GraphMessage>(`/me/messages/${msg.id}?$select=${FULL_SELECT}`);
    } catch (err) {
      log.debug(
        `Body fetch failed for ${msg.id} (${err instanceof Error ? err.message : String(err)}); emitting bodyless doc`,
      );
      return msg;
    }
  }

  // ── Message normalization ────────────────────────────────────────

  private async normalizeMessage(msg: GraphMessage): Promise<DocumentInput[]> {
    return normalizeOutlookMessage(msg, {
      providerId: this.providerId,
      sourceId: this.id,
      attachmentConfig: this.attachmentConfig,
      extractAttachment: this.extractAttachment,
      graph: this.graph,
    });
  }
}

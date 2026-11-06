// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  isScopeRefreshBookmark,
  type ScopeRefreshBookmark,
  type SyncResult,
} from "@omnesis/source-sdk";
import { computeContentHash, pMap } from "@omnesis/core";
import { GOOGLE_PAGE_SIZE, GOOGLE_FETCH_CONCURRENCY } from "./constants.js";
import { partHeader } from "./gmail-message.js";
import { googleApiStatus } from "./api-error.js";
import type {
  DocumentScopeFacts,
  SourceScopeDocumentUpdate,
  SourceScopeEntity,
  SourceScopeUpdates,
} from "@omnesis/types";
import type { gmail_v1 } from "googleapis";
import type { GmailSyncCursor } from "./gmail.js";

export const GMAIL_LABEL_CATALOGUE_TTL_MS = 5 * 60_000;

export interface GmailLabelScopeCursor {
  scopeLabelsIdSetHash?: string;
  scopeLabelsCatalogueCheckedAt?: number;
  scopeLabelsCatalogueSyncOffset?: number;
  scopeLabelsCatalogueSyncHash?: string;
  scopeLabelsCut?: ScopeRefreshBookmark;
  scopeLabelsVersion?: 1;
  scopeLabelsYieldToContent?: boolean;
  scopeLabelsBootstrap?: boolean;
  scopeLabelsBootstrapCatchup?: boolean;
  scopeLabelsStage?: "catalogue" | "scan" | "history";
  scopeLabelsPageToken?: string;
  scopeLabelsCatalogueOffset?: number;
  scopeLabelsCatalogueHash?: string;
  scopeLabelsHistoryId?: string;
  scopeLabelsHistoryPageToken?: string;
}

/** Validate bounded refresh bookmarks alongside installed legacy mail cursors. */
export function isGmailLabelScopeCursor(value: Record<string, unknown>): boolean {
  for (const field of ["scopeLabelsCatalogueCheckedAt", "scopeLabelsCatalogueSyncOffset"])
    if (
      value[field] !== undefined &&
      (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0)
    )
      return false;
  if (value.scopeLabelsIdSetHash !== undefined && typeof value.scopeLabelsIdSetHash !== "string")
    return false;
  if (
    value.scopeLabelsCatalogueSyncHash !== undefined &&
    typeof value.scopeLabelsCatalogueSyncHash !== "string"
  )
    return false;
  if (value.scopeLabelsCut !== undefined && !isScopeRefreshBookmark(value.scopeLabelsCut))
    return false;
  if (value.scopeLabelsVersion !== undefined && value.scopeLabelsVersion !== 1) return false;
  for (const field of [
    "scopeLabelsYieldToContent",
    "scopeLabelsBootstrap",
    "scopeLabelsBootstrapCatchup",
  ]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") return false;
  }
  if (
    value.scopeLabelsStage !== undefined &&
    !["catalogue", "scan", "history"].includes(String(value.scopeLabelsStage))
  )
    return false;
  for (const field of [
    "scopeLabelsPageToken",
    "scopeLabelsCatalogueHash",
    "scopeLabelsHistoryId",
    "scopeLabelsHistoryPageToken",
  ]) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || value[field].length === 0)
    )
      return false;
  }
  if (
    value.scopeLabelsCatalogueOffset !== undefined &&
    (!Number.isSafeInteger(value.scopeLabelsCatalogueOffset) ||
      Number(value.scopeLabelsCatalogueOffset) < 0)
  )
    return false;
  return value.scopeLabelsStage === undefined || typeof value.scopeLabelsHistoryId === "string";
}

export function gmailLabelScopeBookmark(state: GmailSyncCursor): GmailLabelScopeCursor {
  const {
    scopeLabelsIdSetHash,
    scopeLabelsCatalogueCheckedAt,
    scopeLabelsCatalogueSyncOffset,
    scopeLabelsCatalogueSyncHash,
    scopeLabelsCut,
    scopeLabelsVersion,
    scopeLabelsStage,
    scopeLabelsPageToken,
    scopeLabelsCatalogueOffset,
    scopeLabelsCatalogueHash,
    scopeLabelsHistoryId,
    scopeLabelsHistoryPageToken,
    scopeLabelsYieldToContent,
    scopeLabelsBootstrap,
    scopeLabelsBootstrapCatchup,
  } = state;
  return {
    scopeLabelsIdSetHash,
    scopeLabelsCatalogueCheckedAt,
    scopeLabelsCatalogueSyncOffset,
    scopeLabelsCatalogueSyncHash,
    scopeLabelsCut,
    scopeLabelsVersion,
    scopeLabelsStage,
    scopeLabelsPageToken,
    scopeLabelsCatalogueOffset,
    scopeLabelsCatalogueHash,
    scopeLabelsHistoryId,
    scopeLabelsHistoryPageToken,
    scopeLabelsYieldToContent,
    scopeLabelsBootstrap,
    scopeLabelsBootstrapCatchup,
  };
}

export function gmailLabelFacts(
  labelIds: readonly string[],
  names?: readonly string[],
): DocumentScopeFacts {
  return {
    kinds: ["label"],
    facts: [...new Set(labelIds)].map((id) => ({
      kind: "label",
      id,
      ...(names?.[labelIds.indexOf(id)] ? { label: names[labelIds.indexOf(id)] } : {}),
    })),
    complete: ["label"],
  };
}

/** An unsupported interval invalidates coverage even if an earlier refresh finished. */
export function withoutGmailLabelScopeCursor(state: GmailSyncCursor): GmailSyncCursor {
  const {
    scopeLabelsIdSetHash: _idsHash,
    scopeLabelsCatalogueCheckedAt: _checked,
    scopeLabelsCatalogueSyncOffset: _syncOffset,
    scopeLabelsCatalogueSyncHash: _syncHash,
    scopeLabelsCut: _cut,
    scopeLabelsVersion: _version,
    scopeLabelsStage: _stage,
    scopeLabelsPageToken: _page,
    scopeLabelsCatalogueOffset: _offset,
    scopeLabelsCatalogueHash: _hash,
    scopeLabelsHistoryId: _history,
    scopeLabelsHistoryPageToken: _historyPage,
    scopeLabelsYieldToContent: _yield,
    scopeLabelsBootstrap: _bootstrap,
    scopeLabelsBootstrapCatchup: _catchup,
    ...cursor
  } = state;
  return cursor;
}

/** Gmail metadata reads update authorization metadata without fetching message bodies or attachments. */
export class GmailLabelScopes {
  private catalogue: SourceScopeEntity[] | undefined;
  constructor(
    private readonly gmail: gmail_v1.Gmail,
    private readonly names: (ids: string[]) => Promise<string[]>,
    private readonly relevance: (
      labels: string[],
      headers: { listUnsubscribe: string; precedence: string; autoSubmitted: string },
    ) => number,
    private readonly rememberLabels: (labels: readonly SourceScopeEntity[]) => void,
  ) {}

  async updates(
    ids: readonly string[],
  ): Promise<{ updates: SourceScopeDocumentUpdate[]; deleted: string[] }> {
    const rows = await pMap(
      [...new Set(ids)],
      async (id) => {
        const response = await this.gmail.users.messages
          .get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["List-Unsubscribe", "Precedence", "Auto-Submitted"],
            fields: "id,labelIds,payload/headers",
          })
          .catch((error: unknown) => {
            if (googleApiStatus(error) === 404) return null;
            throw error;
          });
        if (!response) return { deleted: id };
        if (response.data.id !== id) throw new Error("Gmail returned mismatched label metadata.");
        const labels = response.data.labelIds ?? [];
        if (labels.includes("SPAM") || labels.includes("TRASH")) return { deleted: id };
        const names = await this.names(labels);
        return {
          update: {
            externalId: id,
            kinds: ["label"],
            facts: gmailLabelFacts(labels, names),
            tags: names,
            relevanceScore: this.relevance(labels, {
              listUnsubscribe: partHeader(response.data.payload ?? {}, "List-Unsubscribe") ?? "",
              precedence: partHeader(response.data.payload ?? {}, "Precedence") ?? "",
              autoSubmitted: partHeader(response.data.payload ?? {}, "Auto-Submitted") ?? "",
            }),
          } satisfies SourceScopeDocumentUpdate,
        };
      },
      { concurrency: GOOGLE_FETCH_CONCURRENCY },
    );
    return {
      updates: rows.flatMap((row) => (row.update ? [row.update] : [])),
      deleted: rows.flatMap((row) => (row.deleted ? [row.deleted] : [])),
    };
  }

  private async labels(): Promise<SourceScopeEntity[]> {
    if (this.catalogue) return this.catalogue;
    const response = await this.gmail.users.labels.list({ userId: "me" });
    this.catalogue = (response.data.labels ?? [])
      .flatMap((label) =>
        label.id && label.name ? [{ kind: "label" as const, id: label.id, label: label.name }] : [],
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    this.rememberLabels(this.catalogue);
    return this.catalogue;
  }

  /** Catalogue-only changes do not require reading message metadata or bodies. */
  async cataloguePage(
    input: GmailSyncCursor,
    now = Date.now(),
  ): Promise<{
    cursor: GmailLabelScopeCursor;
    updates?: SourceScopeUpdates;
    more: boolean;
    restart?: boolean;
  }> {
    const pending = input.scopeLabelsCatalogueSyncHash !== undefined;
    const checked = input.scopeLabelsCatalogueCheckedAt;
    if (
      !pending &&
      input.scopeLabelsIdSetHash !== undefined &&
      checked !== undefined &&
      now >= checked &&
      now - checked < GMAIL_LABEL_CATALOGUE_TTL_MS
    )
      return {
        cursor: {
          scopeLabelsCatalogueCheckedAt: checked,
          scopeLabelsIdSetHash: input.scopeLabelsIdSetHash,
        },
        more: false,
      };
    if (!pending) this.catalogue = undefined;
    const labels = await this.labels();
    const idSetHash = computeContentHash(JSON.stringify(labels.map((label) => label.id).sort()));
    if (input.scopeLabelsIdSetHash !== idSetHash)
      return {
        cursor: { scopeLabelsCatalogueCheckedAt: now, scopeLabelsIdSetHash: idSetHash },
        updates: {
          refreshes: [{ kind: "label", active: true }],
          readiness: [{ kind: "label", complete: false }],
        },
        more: true,
        restart: true,
      };
    const hash = computeContentHash(JSON.stringify(labels));
    const offset =
      input.scopeLabelsCatalogueSyncHash === hash
        ? Math.min(input.scopeLabelsCatalogueSyncOffset ?? 0, labels.length)
        : 0;
    const end = Math.min(offset + GOOGLE_PAGE_SIZE, labels.length);
    const more = end < labels.length;
    return {
      cursor: more
        ? {
            scopeLabelsIdSetHash: idSetHash,
            scopeLabelsCatalogueCheckedAt: checked,
            scopeLabelsCatalogueSyncHash: hash,
            scopeLabelsCatalogueSyncOffset: end,
          }
        : { scopeLabelsCatalogueCheckedAt: now, scopeLabelsIdSetHash: idSetHash },
      updates: {
        entities: labels.slice(offset, end),
        ...(offset === 0 ? { replaceEntityKinds: ["label"] } : {}),
      },
      more,
    };
  }

  async refresh(input: GmailSyncCursor, query: string): Promise<SyncResult> {
    let state = { ...input };
    if (!state.scopeLabelsStage) {
      const profile = await this.gmail.users.getProfile({ userId: "me" });
      if (!profile.data.historyId)
        throw new Error("Gmail did not provide a label refresh history boundary.");
      this.catalogue = undefined;
      state = {
        ...withoutGmailLabelScopeCursor(state),
        scopeLabelsStage: "catalogue",
        scopeLabelsHistoryId: profile.data.historyId,
      };
    }
    const base = { documents: [], deletedExternalIds: [], hasMore: true };
    const pending = [{ kind: "label" as const, complete: false }];
    if (state.scopeLabelsStage === "catalogue") {
      const labels = await this.labels();
      const hash = computeContentHash(JSON.stringify(labels));
      const offset =
        state.scopeLabelsCatalogueHash === hash ? (state.scopeLabelsCatalogueOffset ?? 0) : 0;
      const end = Math.min(offset + GOOGLE_PAGE_SIZE, labels.length);
      return {
        ...base,
        cursor: {
          ...state,
          scopeLabelsIdSetHash: computeContentHash(
            JSON.stringify(labels.map((label) => label.id).sort()),
          ),
          scopeLabelsCatalogueCheckedAt: Date.now(),
          scopeLabelsCatalogueHash: hash,
          scopeLabelsCatalogueOffset: end,
          scopeLabelsStage: end < labels.length ? "catalogue" : "scan",
        },
        scopeUpdates: {
          entities: labels.slice(offset, end),
          ...(offset === 0 ? { replaceEntityKinds: ["label" as const] } : {}),
          readiness: pending,
          refreshes: [{ kind: "label", active: true }],
        },
      };
    }
    if (state.scopeLabelsStage === "scan") {
      const list = (pageToken?: string) =>
        this.gmail.users.messages.list({
          userId: "me",
          q: query,
          maxResults: GOOGLE_PAGE_SIZE,
          pageToken,
        });
      const response = await list(state.scopeLabelsPageToken).catch((error: unknown) => {
        if (state.scopeLabelsPageToken && googleApiStatus(error) === 400) return list();
        throw error;
      });
      const metadata = await this.updates(
        (response.data.messages ?? []).flatMap((message) => (message.id ? [message.id] : [])),
      );
      return {
        ...base,
        deletedExternalIds: metadata.deleted,
        cursor: {
          ...state,
          scopeLabelsPageToken: response.data.nextPageToken ?? undefined,
          scopeLabelsStage: response.data.nextPageToken ? "scan" : "history",
        },
        scopeUpdates: {
          documents: metadata.updates,
          readiness: pending,
          refreshes: [{ kind: "label", active: true }],
        },
      };
    }
    const response = await this.gmail.users.history
      .list({
        userId: "me",
        startHistoryId: state.scopeLabelsHistoryId,
        pageToken: state.scopeLabelsHistoryPageToken,
        historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
        maxResults: GOOGLE_PAGE_SIZE,
      })
      .catch((error: unknown) => {
        if (googleApiStatus(error) === 404) return null;
        throw error;
      });
    if (!response)
      return {
        ...base,
        cursor: withoutGmailLabelScopeCursor(state),
        scopeUpdates: { readiness: pending, refreshes: [{ kind: "label", active: true }] },
      };
    const ids = new Set<string>();
    const deleted = new Set<string>();
    for (const history of response.data.history ?? []) {
      for (const event of [
        ...(history.messagesAdded ?? []),
        ...(history.labelsAdded ?? []),
        ...(history.labelsRemoved ?? []),
      ]) {
        if (event.message?.id) ids.add(event.message.id);
      }
      for (const event of history.messagesDeleted ?? [])
        if (event.message?.id) deleted.add(event.message.id);
    }
    for (const id of deleted) ids.delete(id);
    if (ids.size > GOOGLE_PAGE_SIZE) {
      // Restart from a fresh history cut: the scan will already include this
      // bulk mutation, and each checkpoint stays within a bounded page.
      return {
        ...base,
        cursor: withoutGmailLabelScopeCursor(state),
        scopeUpdates: { readiness: pending, refreshes: [{ kind: "label", active: true }] },
      };
    }
    const metadata = await this.updates([...ids]);
    const next = response.data.nextPageToken ?? undefined;
    return {
      ...base,
      deletedExternalIds: [...deleted, ...metadata.deleted],
      cursor: next
        ? { ...state, scopeLabelsHistoryPageToken: next }
        : {
            ...withoutGmailLabelScopeCursor(state),
            scopeLabelsVersion: 1,
            scopeLabelsIdSetHash: state.scopeLabelsIdSetHash,
            scopeLabelsCatalogueCheckedAt: state.scopeLabelsCatalogueCheckedAt,
          },
      scopeUpdates: {
        documents: metadata.updates,
        readiness: [{ kind: "label", complete: !next }],
        refreshes: [{ kind: "label", active: !!next }],
      },
    };
  }
}

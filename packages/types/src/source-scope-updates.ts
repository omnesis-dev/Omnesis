// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type {
  DocumentScopeFacts,
  ScopeRef,
  SourceScopeConversationUpdate,
} from "./source-scopes.js";
export type ScopeRefreshEpochs = Partial<Record<ScopeRef["kind"], string>>;
export type ScopeRefreshRequestIds = Partial<Record<ScopeRef["kind"], string>>;
export interface SourceScopeRefreshState {
  epochs: ScopeRefreshEpochs;
  requestIds: ScopeRefreshRequestIds;
}

export interface SourceScopeDocumentUpdate {
  externalId: string;
  /** Kinds replaced by this metadata-only update; all other kinds are retained. */
  kinds: ScopeRef["kind"][];
  facts: DocumentScopeFacts;
  /** Display metadata; never used to match a label filter. */
  tags?: string[];
  relevanceScore?: number;
}
export interface SourceScopeEntity {
  kind: "conversation" | "label" | "folder";
  id: string;
  label: string;
  parentId?: string;
}
/** Native direct edges; omitted metadata is unknown, an empty complete list is a root. */
export interface SourceScopeHierarchyParents {
  kind: "folder";
  parentIds: string[];
  complete: boolean;
  refreshEpoch?: string;
}
export interface SourceScopeHierarchyUpdate {
  kind: "folder";
  refreshEpoch?: string;
  nodes?: Array<{
    id: string;
    label: string;
    parentIds: string[];
    complete: boolean;
    deleted?: boolean;
  }>;
  documents?: Array<{
    externalId: string;
    parentIds: string[];
    complete: boolean;
    refreshEpoch?: string;
  }>;
  /** A bounded catalogue scan marks seen nodes, then prunes omissions in background chunks. */
  snapshot?: { id: string; phase: "begin" | "scan" | "end" };
}
/** Committed with one source/account/stream's sync cursor and write epoch. */
export interface SourceScopeUpdates {
  documents?: SourceScopeDocumentUpdate[];
  entities?: SourceScopeEntity[];
  replaceEntityKinds?: SourceScopeEntity["kind"][];
  readiness?: Array<{ kind: ScopeRef["kind"]; complete: boolean }>;
  /** Explicit full-refresh fence, independent from editor readiness. */
  refreshes?: Array<{
    kind: ScopeRef["kind"];
    active: boolean;
    epoch?: string;
    restart?: boolean;
    requestId?: string;
  }>;
  conversations?: SourceScopeConversationUpdate[];
  hierarchy?: SourceScopeHierarchyUpdate;
}

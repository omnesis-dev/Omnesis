// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ScopeIdentifier, ScopeRef, SourceScopes } from "./source-scopes.js";

export interface SourceScopeKindReadiness {
  kind: ScopeRef["kind"];
  ready: boolean;
  reason?: string;
  message?: string;
  processed?: number;
  pending?: number;
  behindCollectors?: Array<{ deviceId: string; name: string }>;
}

export interface SourceScopeOption {
  ref: ScopeRef;
  label: string;
  count: number;
  parentId?: string;
  hasChildren?: boolean;
  /** How many ancestors the item has, for a kind whose source names its levels. */
  depth?: number;
  /** Transient picker identity. Policies snapshot identifiers, never this ID. */
  personId?: string;
}

export interface SourceScopeOptions {
  sourceId: string;
  sourceType: string;
  scopes: SourceScopes;
  readiness: SourceScopeKindReadiness[];
  items: SourceScopeOption[];
  nextCursor?: string;
}

export interface SourceScopePreview {
  sourceId: string;
  total: number;
  visible: number;
  /** Includes unknown documents. */
  hidden: number;
  unknown: number;
  items: Array<{
    ref: ScopeRef;
    label: string;
    count: number;
    parentId?: string;
    /** How many ancestors the item has, for a kind whose source names its levels. */
    depth?: number;
    missing?: boolean;
  }>;
  samples: Array<{ documentId: string; title: string; visible: boolean; unknown: boolean }>;
  identifierProposals?: Array<{ itemIndex: number; label: string; identifiers: ScopeIdentifier[] }>;
  readiness: SourceScopeKindReadiness[];
}

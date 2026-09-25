// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Moved to `@omnesis/source-sdk`. This shim preserves the
// `from "./gateway-client.js"` and `from "@omnesis/core"` import edges for
// consumers that haven't migrated to the new package yet.
//
// Explicit named re-exports because vite/vitest can't statically follow
// `export * from "@omnesis/source-sdk"` chains (#414 fallout).
export type {
  GatewaySearchQuery,
  GatewaySearchResponse,
  ListedDocument,
  ListDocumentsOptions,
  SyncState,
  SourceStats,
  ReconcileResponse,
  UpsertWithCursorResponse,
  DocumentCountResponse,
  DocumentExistsResponse,
  DeleteAllResponse,
  DocumentIdsResponse,
  DbSizeResponse,
  IngestAnalyticsResponse,
  GatewayClient,
  IndexStats,
} from "@omnesis/source-sdk";

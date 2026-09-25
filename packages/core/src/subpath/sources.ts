// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/core/sources` — source + provider definition contract.
 *
 * Re-exports the `defineSource` / `defineProvider` /
 * `defineStructuredSource` API that every provider package consumes,
 * plus the runtime `SourceInstance` / `Provider` shapes the gateway
 * and collector reason about.
 *
 * Stable contract surface — every provider package depends on this
 * subpath; changes here cascade through the entire ingest plane.
 */

export type {
  SourceIcon,
  SourceAttribution,
  SyncCursor,
  SyncResult,
  SourceWatermark,
  SyncProgress,
} from "../source.js";

export type {
  ColumnDefinition,
  ColumnReference,
  ColumnType,
  AnalyticsTableSchema,
  BoundDocumentSpec,
  StructuredSyncResult,
  AnalyticsCatalogEntry,
} from "../structured-source.js";

export type { SourceMeta, SourceMetaEntry } from "../source-meta.js";

export type { Provider } from "../provider.js";

export type {
  SourceDescriptor,
  SourceParam,
  ProviderInfo,
  AuthType,
  AuthFlowCallbacks,
  WidgetRendererSpec,
  SerializedDescriptor,
} from "../source-descriptor.js";

export { serializeDescriptor } from "../source-descriptor.js";

export {
  defineSource,
  defineProvider,
  defineStructuredSource,
  resolveProvider,
} from "../define-source.js";

export type {
  SourceDefinition,
  ProviderDefinition,
  SourceOrProviderDefinition,
  SourceInstance,
  CreateOptions,
  ProviderSourceEntry,
} from "../define-source.js";

export { syncPage, emptySync, applyDataCutoff } from "../source.js";

export { SyncError, type SyncErrorKind, type SyncErrorOptions } from "../sync-error.js";

export { makeCursorValidator, type CursorValidator } from "../cursor-validator.js";

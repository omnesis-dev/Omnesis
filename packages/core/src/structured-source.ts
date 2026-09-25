// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Moved to `@omnesis/source-sdk`. This shim preserves the
// `from "./structured-source.js"` and `from "@omnesis/core"` import edges for
// consumers that haven't migrated to the new package yet.
//
// Explicit named re-exports because vite/vitest can't statically follow
// `export * from "@omnesis/source-sdk"` chains.
export {
  normalizeAnalyticsColumnType,
  normalizeAnalyticsSchemaColumnTypes,
  validateAnalyticsSchemaColumnTypes,
  validateAnalyticsDeleteKeys,
  validateAnalyticsSchemasHavePrimaryKey,
  validateBoundDocuments,
  validateRecordCitationContract,
  validateTemporalProjectionContracts,
  validateDocumentTemporalProjectionContracts,
  deriveRecordTitle,
  deriveRecordCitationFields,
  REDACTED_VALUE,
} from "@omnesis/source-sdk";
export type {
  ColumnType,
  ColumnReference,
  ColumnDefinition,
  AnalyticsTableSchema,
  BoundDocumentSpec,
  RecordDisplaySpec,
  RecordKeyField,
  RecordCitationFields,
  AnalyticsTemporalProjectionSpec,
  DocumentTemporalProjectionSpec,
  TemporalProjectionSpec,
  DocumentProjectionField,
  MappedProjectionField,
  StructuredSyncResult,
  AnalyticsCatalogEntry,
} from "@omnesis/source-sdk";

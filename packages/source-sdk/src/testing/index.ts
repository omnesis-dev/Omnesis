// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/source-sdk/testing` — contract checks a provider's own tests run
 * against its real sync phases.
 *
 * A separate subpath rather than part of the root: these are for test files,
 * and nothing a provider ships at runtime should be able to reach them.
 */

export {
  runSyncCycleContract,
  expectUnchangedUpstreamIsNoOp,
  type EmittedRow,
  type RewrittenColumn,
  type SyncCycleContract,
  type SyncCycleReport,
  type SyncStepResult,
} from "./sync-cycle.js";

export {
  runSourceConformance,
  runProviderConformance,
  formatConformanceReport,
  type ConformanceFinding,
  type ConformanceReport,
  type SourceConformanceOptions,
} from "./conformance.js";

export {
  allSyntheticShapes,
  chatShape,
  dynamicShape,
  enrichShape,
  ledgerShape,
  mailShape,
  partitionedShape,
  vaultShape,
  type SyntheticShape,
} from "./synthetic-shapes.js";

export {
  fakeProviderHost,
  fakeSourceHost,
  fakeAnalytics,
  recordingLogger,
  type FakeAnalytics,
  type FakeHostOptions,
  type RecordingLogger,
} from "./fake-host.js";

export {
  rowsFor,
  tablesWritten,
  deletionsFor,
  deletionKeysFor,
  writesFor,
  emittedRows,
} from "./page-writes.js";

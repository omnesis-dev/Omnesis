// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/watch` — the Watch DSL and the validator that checks one.
 *
 * This package is deliberately standalone: it does **not** import from the
 * gateway. Everything it knows about the substrate arrives as data — an
 * ontology snapshot — so the language can be proven against a fixture universe
 * before anything is wired into the product.
 *
 * The surface below is what a consumer needs to hold a watch, check one, and
 * act on the result. Internals — the expression parser, the SQL analyzer, the
 * per-node schemas — stay unexported until something outside needs them; a
 * published symbol is a promise, and there is no reason to make one early.
 *
 * The fixture universes are not on that surface. They are development data:
 * `universes/` is not published, so an exported loader that resolved against
 * it would be a promise the installed package cannot keep. In-repo callers
 * reach `universe/paths.js` directly.
 *
 * The journal event contract also has its own subpath, `@omnesis/watch/journal`.
 * A producer of the journal — the gateway's materializer — needs the shapes and
 * nothing else, and importing this root would evaluate the engine, the compiler
 * and the analytics database along with them.
 */

export {
  isSourceNode,
  isNotifyDeliveryKind,
  nodeInputs,
  nodeSchema,
  watchDslSchema,
  CURRENT_NOTIFY_KIND,
  SOURCE_NODE_TYPES,
  type NodeInput,
  type WatchConstant,
  type WatchDefinition,
  type WatchDsl,
  type WatchNode,
  type WatchNodeType,
  type WatchSink,
  type WatchDelivery,
} from "./dsl/schema.js";
export { documentLineage, SINK_LINEAGE_KEY, type DocumentLineage } from "./dsl/lineage.js";

export {
  formatValueType,
  parseValueType,
  typesCompatible,
  type ValueType,
} from "./dsl/value-type.js";

export {
  Ontology,
  ANALYTICS_COLUMN_KEYS,
  ontologySnapshotSchema,
  type AnalyticsTableSnapshot,
  type DocumentEventProfileSnapshot,
  type DocumentMetadataFieldSpecSnapshot,
  type OntologyReads,
  type OntologySnapshot,
  type PersonDirectoryEntry,
  type SourceOntology,
} from "./ontology/snapshot.js";

export { canonicalJson, declaredSource } from "./ontology/canonical.js";
export { RecordingOntology } from "./ontology/recording.js";

export {
  WATCH_DIAGNOSTIC_CODES,
  type DiagnosticSeverity,
  type ValidationResult,
  type WatchDiagnostic,
  type WatchDiagnosticCode,
  type WatchValueTypes,
} from "./validator/diagnostics.js";

export { validateWatch } from "./validator/validate.js";

/**
 * The journal event payloads a source node's `$e.` references resolve against.
 * They are the field sets an event materializer has to produce, so they are
 * published: the producer and the validator must agree on one list.
 */
export {
  ANALYTICS_ROW_FIELDS,
  DOC_EVENT_FIELDS,
  LOOP_EVENT_FIELDS,
  LOOP_SNAPSHOT_FIELDS,
  PERSON_MENTION_FIELDS,
  TIMER_EVENT_FIELDS,
} from "./validator/node-output.js";

export { parseDuration, type Duration, type DurationUnit } from "./time/duration.js";

export { nextCronOccurrence, parseCron, type CronExpression } from "./time/cron.js";

/**
 * The journal is the runtime's only feed and its only clock. These are the
 * event contract — the shapes a materializer has to produce — and the reader
 * that refuses anything that is not one.
 */
export {
  JOURNAL_EVENT_KINDS,
  isKind,
  journalEventSchema,
  toJournalInstant,
  type AnalyticsRowEvent,
  type DocEvent,
  type DocIndexedEvent,
  type JournalEvent,
  type JournalEventKind,
  type LoopEvent,
  type LoopSnapshot,
  type PersonMention,
  type TimerFiredEvent,
} from "./journal/event.js";

export { JournalFormatError, parseJournal, readJournal } from "./journal/read.js";

export {
  AnalyticsDatabase,
  prepareQuery,
  sqlTypeHints,
  type SqlTypeName,
  type PreparedQuery,
  type QueryResult,
  type SqlParameter,
  type SqlParameterValue,
} from "./universe/analytics.js";

/**
 * The evaluation engine and everything needed to drive it. `runWatch` is the
 * façade the goldens and the backtest both call.
 */
export {
  WatchEngine,
  type AnalyticsPort,
  type EngineOptions,
  type JournalDocument,
} from "./runtime/engine.js";
export { loadWatch, runWatch, type RunOptions } from "./runtime/run.js";
export { VirtualClock } from "./runtime/clock.js";
export {
  WatchStateStore,
  hashKey,
  type NodeCell,
  type WatchFailure,
  type WatchLiveState,
} from "./runtime/state.js";
/**
 * Keeping a store's `CREATE TABLE IF NOT EXISTS` half and its additive half in
 * step — the difference between a fresh install and one that booted yesterday.
 */
export {
  addMissingColumns,
  tableColumns,
  type ColumnAdditions,
} from "./runtime/schema-additions.js";
/** Which of a node type's cells are holding something, rather than remembering it. */
export { holdingSpecs, type HoldingKind, type WatchHoldingSpec } from "./runtime/holding.js";
/** What the runtime is holding for one watch, read for a surface that shows it. */
export {
  readWatchState,
  type ReadWatchStateOptions,
  type WatchArmedTimer,
  type ArrivedArm,
  type WatchCellDetail,
  type WatchCellState,
  type WatchNodeState,
  type WatchParkedNomination,
  type WatchStateSnapshot,
} from "./runtime/state-view.js";
export {
  FAILURE_CLASSES,
  SINGLETON_KEY,
  TRANSITIONS,
  renderKey,
  type FailureClass,
  type TraceRecord,
  type Transition,
  type WatchFiring,
  type WatchTrace,
} from "./runtime/trace.js";
export {
  CountingJudge,
  ScriptedJudge,
  ScriptedRecall,
  type JudgeProvider,
  type JudgeRequest,
  type JudgeUnanswered,
  type JudgeVerdict,
  type RecallRequest,
  type RecallScorer,
  type ScriptedJudgement,
  type ScriptedScore,
} from "./runtime/providers.js";

/** Replaying a watch to find out what it would cost. */
export {
  backtest,
  backtestDefinition,
  formatReport,
  type BacktestOptions,
  type BacktestReport,
} from "./backtest/backtest.js";
export { loadScript, type WatchScript } from "./runtime/run.js";

/**
 * The compiler: natural language in, a validated watch or an honest refusal
 * out. The model is a parameter — nothing here reaches the network on its own,
 * and the one implementation that does is configured entirely from the
 * environment.
 */
export {
  DEFAULT_REACH_POLICY,
  compile,
  reachConcern,
  type CompileAttempt,
  type CompileOptions,
  type CompileResult,
  type ReachPolicy,
} from "./compiler/compile.js";
export {
  MODEL_ENV,
  OpenAiCompatibleModel,
  ScriptedModel,
  addUsage,
  modelFromEnv,
  NO_USAGE,
  type ChatMessage,
  type ChatModel,
  type ModelReply,
  type ModelUsage,
} from "./compiler/model.js";
export {
  CORPUS_CONTENT_IS_DATA,
  promptPrefix,
  queryMessage,
  type CompilerContext,
} from "./compiler/prompt.js";
export { examplesFor, type WorkedExample } from "./compiler/examples.js";
export { loadLoops, type LoopDirectoryEntry } from "./compiler/loops.js";
export { parseReply, type ParsedReply } from "./compiler/parse.js";
export {
  disclosableCodes,
  refusalSentence,
  REFUSAL_CODES,
  type RefusalCode,
} from "./compiler/refusal.js";
export { formatBacktest, type LoopBacktest } from "./backtest/loop-backtest.js";

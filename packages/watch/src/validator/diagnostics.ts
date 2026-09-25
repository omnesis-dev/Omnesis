// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Validator diagnostics.
 *
 * These are an **API, not error prose.** The primary consumer is the Watch
 * Compiler, which reads a failed validation and rewrites the DSL — so every
 * diagnostic carries a stable machine-readable `code`, a JSON Pointer at the
 * exact offending location, and, where the fix is mechanical, a `details`
 * payload naming what was expected (the declared metadata fields, the known
 * table names, the legal collision modes). The human-readable `message` is a
 * convenience for operators and test failures; nothing should parse it.
 *
 * Codes are permanent. Renaming one breaks every compiler prompt and golden
 * that references it, so a superseded code is retired rather than reused.
 */

import type { ValueType } from "../dsl/value-type.js";

export const WATCH_DIAGNOSTIC_CODES = [
  // --- Shape -------------------------------------------------------------
  /** The JSON is not a watch: a zod schema failure, reported verbatim. */
  "DSL_SCHEMA_INVALID",
  /** A cross-field rule the shape alone cannot express. */
  "CONSTANT_VALUE_TYPE_MISMATCH",
  "PERSON_PREDICATE_UNBOUND",
  "JUDGE_MODE_HAS_INVESTIGATION_FIELDS",

  // --- Graph -------------------------------------------------------------
  "NODE_ID_DUPLICATE",
  "NODE_MISSING_INPUTS",
  "INPUT_NODE_UNKNOWN",
  "INPUT_SELF_REFERENCE",
  "GRAPH_CYCLE",
  "SINK_INPUT_UNKNOWN",
  "NODE_UNREACHABLE_FROM_SINK",
  "CANCEL_INPUT_NOT_ALLOWED",

  // --- References --------------------------------------------------------
  "EXPRESSION_PARSE_ERROR",
  "EXPRESSION_FUNCTION_UNKNOWN",
  "EXPRESSION_FUNCTION_ARITY",
  "EXPRESSION_DATE_TRUNC_UNIT",
  "EXPRESSION_DATE_TRUNC_VALUE",
  "REF_NODE_UNKNOWN",
  "REF_NODE_NOT_UPSTREAM",
  "REF_FIELD_UNKNOWN",
  "REF_KEY_COMPONENT_UNKNOWN",
  "REF_CONSTANT_UNKNOWN",
  "REF_EVENT_FIELD_UNKNOWN",
  "REF_EVENT_NOT_IN_SCOPE",
  "REF_EDGE_NOT_IN_SCOPE",
  "REF_JUDGE_WITHOUT_SEMANTIC_MATCH",
  "REF_JUDGE_FIELD_UNKNOWN",
  "REF_FIRED_BY_UNSUPPORTED",
  "REF_NULLABLE_UNSAFE",
  "TYPE_MISMATCH",
  "TYPE_EXPRESSION_INVALID",

  // --- Keys --------------------------------------------------------------
  "KEY_COMPONENTS_MISMATCH",
  "KEY_COMPONENT_TYPE_MISMATCH",
  "BROADCAST_REQUIRED",
  "BROADCAST_NOT_ALLOWED",

  // --- Collision / lifecycle --------------------------------------------
  "COLLISION_MODE_REQUIRED",
  "COLLISION_MODE_ILLEGAL",
  "COLLISION_MODE_NOT_APPLICABLE",
  "SPAWN_REQUIRES_MAX_LIVE_INSTANCES",
  "SPAWN_WITH_CANCEL_INPUT",
  "MAX_LIVE_INSTANCES_WITHOUT_SPAWN",
  "DEADLINE_REQUIRED",
  "DURATION_INVALID",
  "CRON_INVALID",
  "TIME_SOURCE_AMBIGUOUS",
  "INSTANT_INVALID",
  "SEQUENCE_ORDER_MISMATCH",
  "THRESHOLD_N_EXCEEDS_INPUTS",
  "INITIAL_LEVEL_WITHOUT_EDGE_DETECTION",

  // --- Ontology ----------------------------------------------------------
  "ONTOLOGY_FINGERPRINT_MISMATCH",
  "SOURCE_UNKNOWN",
  "SOURCE_NOT_WATCHABLE",
  "DOCUMENT_TYPE_UNDECLARED",
  "METADATA_FIELD_UNDECLARED",
  "METADATA_VALUE_NOT_ALLOWED",
  "METADATA_PREDICATE_VALUE_INVALID",
  "PERSON_ROLE_UNDECLARED",
  "PERSON_UNKNOWN",
  "PERSON_NOT_CANONICAL",
  "EVENT_OP_UNSUPPORTED",
  "ANALYTICS_TABLE_UNKNOWN",
  "ANALYTICS_COLUMN_UNKNOWN",

  // --- SQL ---------------------------------------------------------------
  "SQL_TABLE_UNKNOWN",
  "SQL_MISSING_FIRES_COLUMN",
  "SQL_SELECT_ITEM_UNALIASED",
  "SQL_UNPARSEABLE",
  "SQL_FROM_NOT_ALLOWED",
  "SQL_PARAMETER_UNKNOWN",
  "SQL_PREDICATE_NOT_AN_EXPRESSION",
  "SQL_NONDETERMINISTIC_FUNCTION",

  // --- Semantic match ----------------------------------------------------
  "RECALL_SOURCE_NOT_INDEXED",
  "SEMANTIC_ARM_IDENTIFIER_QUERY",
  "LEXICAL_TERM_EMPTY",
  "LEXICAL_TERM_NOT_A_TOKEN",
  "LEXICAL_TERM_FLOOD_PRONE",
  "LEXICAL_TERM_COMMON",

  // --- Lints (warnings) --------------------------------------------------
  "LINT_LLM_BEHIND_FAST_TIMER",
  "LINT_DATED_REFERENT_WITHOUT_EXPIRY",
  "LINT_INVESTIGATION_WITHOUT_BUDGET",
  "LINT_INFINITE_DEADLINE",
  "LINT_METADATA_VALUE_NONCANONICAL",
] as const;

export type WatchDiagnosticCode = (typeof WATCH_DIAGNOSTIC_CODES)[number];

export type DiagnosticSeverity = "error" | "warning";

export interface WatchDiagnostic {
  readonly code: WatchDiagnosticCode;
  readonly severity: DiagnosticSeverity;
  /** JSON Pointer (RFC 6901) into the watch document. */
  readonly path: string;
  readonly message: string;
  /** Machine-actionable context: what was expected, what is available. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly WatchDiagnostic[];
  /**
   * The types the validator worked out, for a runtime that needs them.
   *
   * Absent when the DSL did not parse, since nothing was derived. Everything
   * here is already computed to check that references resolve and that key
   * extractors agree across edges; carrying it out means the runtime binds a
   * value with the type the definition says it has, rather than guessing from
   * its shape at the moment it happens to arrive.
   */
  readonly types?: WatchValueTypes;
}

/** What the validator knows about the values a watch moves around. */
export interface WatchValueTypes {
  /** Each node's output fields, by node id then field name. */
  readonly nodes: ReadonlyMap<string, ReadonlyMap<string, ValueType>>;
  /** Each node's key components, addressable as `$key.<component>`. */
  readonly keys: ReadonlyMap<string, ReadonlyMap<string, ValueType>>;
  /** The compile-time constants, addressable as `$const.<name>`. */
  readonly constants: ReadonlyMap<string, ValueType>;
}

/** Build a JSON Pointer, escaping `~` and `/` per RFC 6901. */
export function pointer(...segments: (string | number)[]): string {
  return segments.map((s) => `/${String(s).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class DiagnosticCollector {
  private readonly items: WatchDiagnostic[] = [];

  error(
    code: WatchDiagnosticCode,
    path: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.items.push({ code, severity: "error", path, message, ...(details ? { details } : {}) });
  }

  warn(
    code: WatchDiagnosticCode,
    path: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.items.push({ code, severity: "warning", path, message, ...(details ? { details } : {}) });
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }

  /**
   * Diagnostics ordered by JSON path, then code, then message, so a golden
   * snapshot does not depend on the order the validator happened to walk the
   * graph in. The comparison is by code unit rather than `localeCompare`:
   * collation is locale- and ICU-dependent, and under some collations an
   * underscore is fully ignorable, which would let two distinct JSON Pointers
   * tie and hand the ordering back to walk order.
   */
  result(): ValidationResult {
    const diagnostics = [...this.items].sort(
      (a, b) => compare(a.path, b.path) || compare(a.code, b.code) || compare(a.message, b.message),
    );
    return { valid: !this.hasErrors, diagnostics };
  }
}

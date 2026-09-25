// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Invalid-DSL goldens.
 *
 * Each case under `universes/poc/invalid/` is a watch that is wrong in one
 * specific way. Two things are asserted about it, and the split matters:
 *
 * - **What it must diagnose** — `EXPECTED_CODES` below, written by hand. This
 *   is the independent oracle. A frozen file cannot check itself, because it
 *   was produced by the very code under test; a hand-written expectation can.
 * - **Exactly what it reports** — the paired `.diagnostics.json`, compared
 *   whole. Diagnostics are the compiler's API, so a message that stops naming
 *   what was expected, or a `details` key that quietly disappears, is a
 *   breaking change and must show up as a diff.
 *
 * The corpus also pins something stronger than any individual case: **every**
 * declared diagnostic code must be reachable. A code nobody can trigger is a
 * lie in the API surface.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadOntology, universeDir } from "../universe/paths.js";
import { UniverseDocumentFrequency } from "../universe/doc-frequency.js";
import { WATCH_DIAGNOSTIC_CODES, type ValidationResult } from "./diagnostics.js";
import { validateWatch } from "./validate.js";

const INVALID_DIR = join(universeDir(), "invalid");

/** Term frequencies from the universe's own journal, for the lexical arm. */
const docFrequency = new UniverseDocumentFrequency();

/**
 * The codes each case must produce, asserted independently of what the
 * validator currently does. Edit this deliberately: a change here is a change
 * to what the DSL considers wrong.
 */
const EXPECTED_CODES: Record<string, readonly string[]> = {
  "analytics-source-errors": ["ANALYTICS_TABLE_UNKNOWN", "SQL_UNPARSEABLE"],
  "broadcast-declared-on-a-keyed-edge": ["BROADCAST_NOT_ALLOWED"],
  "broadcast-not-declared": ["BROADCAST_REQUIRED"],
  "cancel-and-inputs-on-stateless-nodes": [
    "CANCEL_INPUT_NOT_ALLOWED",
    "NODE_MISSING_INPUTS",
    "NODE_UNREACHABLE_FROM_SINK",
  ],
  "collision-mode-on-an-instant-sql-node": [
    "COLLISION_MODE_NOT_APPLICABLE",
    "MAX_LIVE_INSTANCES_WITHOUT_SPAWN",
  ],
  "constant-value-contradicts-its-type": [
    "CONSTANT_VALUE_TYPE_MISMATCH",
    // The same watch is bound to a dated thing and declares no horizon. Both
    // are true of it, and a fixture that recorded only the error it was written
    // for would be hiding what the validator actually says.
    "LINT_DATED_REFERENT_WITHOUT_EXPIRY",
  ],
  "date-trunc-nonsense-arguments": ["EXPRESSION_DATE_TRUNC_UNIT", "EXPRESSION_DATE_TRUNC_VALUE"],
  "deleted-event-op": ["EVENT_OP_UNSUPPORTED"],
  "document-filter-vocabulary-errors": [
    "DOCUMENT_TYPE_UNDECLARED",
    "LINT_METADATA_VALUE_NONCANONICAL",
    "METADATA_PREDICATE_VALUE_INVALID",
    "METADATA_VALUE_NOT_ALLOWED",
  ],
  "duplicate-node-id": ["NODE_ID_DUPLICATE"],
  "event-references-out-of-scope": [
    "REF_EDGE_NOT_IN_SCOPE",
    "REF_EVENT_FIELD_UNKNOWN",
    "REF_EVENT_NOT_IN_SCOPE",
  ],
  "expression-syntax-and-function-errors": [
    "EXPRESSION_FUNCTION_ARITY",
    "EXPRESSION_FUNCTION_UNKNOWN",
    "EXPRESSION_PARSE_ERROR",
  ],
  "field-names-reaching-the-prototype-chain": [
    "EXPRESSION_FUNCTION_UNKNOWN",
    "REF_EVENT_FIELD_UNKNOWN",
  ],
  "fire-when-nested-past-the-parser-limit": ["EXPRESSION_PARSE_ERROR"],
  "fire-when-unknown-enum-member": ["TYPE_MISMATCH"],
  "fired-by-on-a-node-without-branches": ["REF_FIRED_BY_UNSUPPORTED"],
  "graph-cycle": ["GRAPH_CYCLE"],
  "illegal-collision-mode": ["COLLISION_MODE_ILLEGAL"],
  "initial-level-without-edge-detection": ["INITIAL_LEVEL_WITHOUT_EDGE_DETECTION"],
  "inputs-point-nowhere": [
    "INPUT_NODE_UNKNOWN",
    "INPUT_SELF_REFERENCE",
    "NODE_MISSING_INPUTS",
    "SINK_INPUT_UNKNOWN",
  ],
  "investigation-leash-and-unbounded-state": [
    "LINT_INFINITE_DEADLINE",
    "LINT_INVESTIGATION_WITHOUT_BUDGET",
  ],
  "judge-mode-carries-investigation-fields": ["JUDGE_MODE_HAS_INVESTIGATION_FIELDS"],
  "judge-reference-without-semantic-match": ["REF_JUDGE_WITHOUT_SEMANTIC_MATCH"],
  "judge-schema-and-field-errors": ["REF_JUDGE_FIELD_UNKNOWN", "TYPE_EXPRESSION_INVALID"],
  "key-components-mismatch": ["KEY_COMPONENTS_MISMATCH"],
  "key-type-mismatch": ["KEY_COMPONENT_TYPE_MISMATCH"],
  "llm-behind-fast-timer": ["LINT_LLM_BEHIND_FAST_TIMER"],
  "malformed-cron-and-duration": ["CRON_INVALID", "DURATION_INVALID"],
  "max-live-instances-without-spawn": ["MAX_LIVE_INSTANCES_WITHOUT_SPAWN"],
  "merged-person-reference": ["PERSON_NOT_CANONICAL"],
  "missing-collision-mode": ["COLLISION_MODE_REQUIRED"],
  "missing-deadline": ["DEADLINE_REQUIRED"],
  "not-a-watch-at-all": ["DSL_SCHEMA_INVALID"],
  "nullable-reference-into-sql": ["REF_NULLABLE_UNSAFE"],
  "ontology-fingerprint-drift": ["ONTOLOGY_FINGERPRINT_MISMATCH"],
  "person-predicate-names-nobody": ["PERSON_PREDICATE_UNBOUND"],
  "reference-not-upstream": ["NODE_UNREACHABLE_FROM_SINK", "REF_NODE_NOT_UPSTREAM"],
  "reference-targets-do-not-exist": [
    "REF_CONSTANT_UNKNOWN",
    "REF_FIELD_UNKNOWN",
    "REF_KEY_COMPONENT_UNKNOWN",
    "REF_NODE_UNKNOWN",
  ],
  "row-predicate-escapes-into-a-query": ["SQL_PREDICATE_NOT_AN_EXPRESSION"],
  "semantic-identifier-query": ["SEMANTIC_ARM_IDENTIFIER_QUERY"],
  "lexical-terms-that-flood-the-judge": [
    "LEXICAL_TERM_EMPTY",
    "LEXICAL_TERM_COMMON",
    "LEXICAL_TERM_FLOOD_PRONE",
    "LEXICAL_TERM_NOT_A_TOKEN",
  ],
  "semantic-match-on-unindexed-source": ["RECALL_SOURCE_NOT_INDEXED"],
  "sequence-order-mismatch": ["SEQUENCE_ORDER_MISMATCH"],
  "spawn-with-cancel-input": ["SPAWN_WITH_CANCEL_INPUT"],
  "spawn-without-max-live": ["SPAWN_REQUIRES_MAX_LIVE_INSTANCES"],
  "sql-missing-fires-and-alias": ["SQL_MISSING_FIRES_COLUMN", "SQL_SELECT_ITEM_UNALIASED"],
  "sql-parameter-not-bindable-in-a-row-predicate": ["SQL_PARAMETER_UNKNOWN"],
  "sql-reads-a-clock": ["SQL_NONDETERMINISTIC_FUNCTION"],
  "sql-reaches-internal-store": ["SQL_TABLE_UNKNOWN"],
  "threshold-can-never-be-reached": ["THRESHOLD_N_EXCEEDS_INPUTS"],
  "time-source-shape-errors": ["INSTANT_INVALID", "TIME_SOURCE_AMBIGUOUS"],
  "transform-reads-a-table": ["SQL_FROM_NOT_ALLOWED"],
  "undeclared-metadata-field": ["METADATA_FIELD_UNDECLARED"],
  "undeclared-person-role": ["PERSON_ROLE_UNDECLARED"],
  "unknown-analytics-column": ["ANALYTICS_COLUMN_UNKNOWN"],
  "unknown-person": ["PERSON_UNKNOWN"],
  "source-connected-but-unwatchable": ["SOURCE_NOT_WATCHABLE"],
  "unknown-source": ["SOURCE_UNKNOWN"],
  "unreachable-node": ["NODE_UNREACHABLE_FROM_SINK"],
};

function caseNames(): string[] {
  return readdirSync(INVALID_DIR)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".diagnostics.json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

function read(name: string, suffix: string): unknown {
  return JSON.parse(readFileSync(join(INVALID_DIR, `${name}${suffix}`), "utf8"));
}

describe("invalid-DSL goldens", () => {
  const ontology = loadOntology();
  const names = caseNames();

  it("every case carries a hand-written expectation, and vice versa", () => {
    expect(names).toEqual(Object.keys(EXPECTED_CODES).sort());
  });

  it.each(names)("%s diagnoses what it is meant to diagnose", (name) => {
    const result = validateWatch(read(name, ".json"), ontology, { docFrequency });
    const codes = [...new Set(result.diagnostics.map((d) => d.code))].sort();
    expect(codes).toEqual([...(EXPECTED_CODES[name] ?? [])].sort());
  });

  it.each(names)("%s produces its recorded diagnostics", (name) => {
    const { valid, diagnostics } = validateWatch(read(name, ".json"), ontology, { docFrequency });
    const expected = read(name, ".diagnostics.json") as ValidationResult;
    // The verdict and the diagnostics, which is what a golden here is for. A
    // validation result also carries the types the run derived, for a runtime
    // that has to bind these values — a large structure, of no interest to a
    // reviewer reading why a watch was refused, and one that would make every
    // golden here churn whenever an unrelated type resolution changed.
    expect({ valid, diagnostics }).toEqual(expected);
  });

  it("every declared diagnostic code is reachable", () => {
    const produced = new Set<string>();
    for (const name of names) {
      for (const d of validateWatch(read(name, ".json"), ontology, { docFrequency }).diagnostics) {
        produced.add(d.code);
      }
    }
    const unreachable = WATCH_DIAGNOSTIC_CODES.filter((code) => !produced.has(code));
    expect(unreachable).toEqual([]);
  });

  it("never throws — an adversarial document is a diagnostic, not an exception", () => {
    for (const name of names) {
      expect(() => validateWatch(read(name, ".json"), ontology, { docFrequency })).not.toThrow();
    }
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The authoring contract, executed.
 *
 * A source that compiles and syncs can still be wrong in ways nothing catches
 * until a user notices: a descriptor that claims a capability its runtime never
 * implements, a state version with a migration that produces a shape the
 * decoder rejects, a source that can be suspended but not resumed. Each of
 * those is a rule stated in prose somewhere. This turns the rules into checks a
 * provider's own test file runs against its real definition.
 *
 * ## Obligations follow capabilities
 *
 * A bookmark source should not have to fabricate people, analytics or temporal
 * projections to pass. Every check here is gated on something the definition
 * actually declares, so the suite a source runs is the suite its own
 * declarations earn — and declaring more capability means being held to more.
 *
 * ## No test framework
 *
 * This returns a report rather than registering `describe`/`it`, matching
 * {@link runSyncCycleContract}. The SDK stays free of a test-runner dependency,
 * the same checks can run from a CLI doctor command, and a provider asserts on
 * the result with whatever runner it already uses.
 */

import { encodeSourceState, resolveSourceState } from "../source-state.js";
import { checkContractCompatibility, mergeContractDeclarations } from "../source-contract.js";
import { executionModeOf } from "../execution-mode.js";
import type {
  NoConfigFields,
  ProviderDefinition,
  SourceDefinition,
  SourceInstance,
} from "../define-source.js";
import type { ConfigField } from "../config-schema.js";
import type { SyncCursor } from "../source.js";
import type { SourceState } from "../source-state.js";

/** One thing the conformance run found. */
export interface ConformanceFinding {
  /** Stable identifier for the rule, e.g. `state.migration-decodes`. */
  check: string;
  /** `error` fails the run; `warning` is advisory and does not. */
  severity: "error" | "warning";
  /** What is wrong, and what to do about it. */
  message: string;
}

/** The outcome of a conformance run. */
export interface ConformanceReport {
  /** The source id the run covered. */
  source: string;
  /** How many checks actually ran, after capability gating. */
  checks: number;
  /** Everything found, in the order it was checked. */
  findings: ConformanceFinding[];
  /** True when nothing of `error` severity was found. */
  ok: boolean;
}

export interface SourceConformanceOptions<S extends SourceState = SourceState> {
  /**
   * A representative stored value for each historical state version, keyed by
   * the version it represents. Every version from 1 up to the declared current
   * version should have one; a missing fixture is a warning, because an
   * untested migration is the one that breaks.
   *
   * Values are the *inner* state, not the envelope. The run wraps them.
   */
  stateFixtures?: Record<number, unknown>;

  /**
   * Stored values in the pre-envelope shape, exactly as an older release would
   * have written them. Each must be classified by `legacyVersion` and migrate
   * to a decodable current state.
   */
  legacyStateFixtures?: readonly unknown[];

  /**
   * Stored values this source must *refuse* rather than resume from.
   *
   * The mirror of `legacyStateFixtures`, and just as load-bearing. A source
   * that deliberately rejects an old shape — because its watermarks were
   * advanced past items an earlier enumeration never saw, say, so no transform
   * can repair them — is making a claim that deserves a test. Without this
   * slot the only way to express it is to leave the shape out of the suite
   * entirely, which proves nothing.
   */
  refusedStateFixtures?: readonly unknown[];

  /**
   * Extra assertions on a migrated state, keyed by the version migrated from.
   * Throw to fail. Use this to pin the parts of a migration that matter —
   * that an id was carried across, that a field was not silently defaulted.
   */
  expectMigrated?: Record<number, (state: S) => void>;

  /**
   * Build a live instance, so declaration and implementation can be compared.
   * Omitted means only the static declaration checks run.
   */
  instantiate?: () => Promise<SourceInstance> | SourceInstance;
}

/** Render a report as a message worth reading when a test fails. */
export function formatConformanceReport(report: ConformanceReport): string {
  if (report.findings.length === 0) {
    return `${report.source}: ${report.checks} conformance checks passed`;
  }
  const lines = report.findings.map((f) => `  [${f.severity}] ${f.check}: ${f.message}`);
  return `${report.source}: ${report.findings.length} of ${report.checks} conformance checks found problems\n${lines.join("\n")}`;
}

/**
 * Run the conformance suite for one source definition.
 *
 * @example
 * ```typescript
 * const report = await runSourceConformance(fieldnotes, {
 *   stateFixtures: { 1: { cursor: "abc" }, 2: { after: "abc" } },
 *   instantiate: () => makeTestInstance(),
 * });
 * expect(formatConformanceReport(report)).toContain("passed");
 * ```
 */
export async function runSourceConformance<
  C extends SyncCursor = SyncCursor,
  S extends SourceState = SourceState,
  F extends Record<string, ConfigField> = NoConfigFields,
>(
  // Every parameter is inferred from the definition handed in. Pinning the
  // cursor to `never` here, to mean "any cursor", inverts the relationship:
  // a definition whose factory returns an instance of its own cursor type is
  // then not assignable, so the suite could only ever be run against a source
  // that had no cursor type at all.
  def: SourceDefinition<C, S, F>,
  options: SourceConformanceOptions<S> = {},
): Promise<ConformanceReport> {
  const findings: ConformanceFinding[] = [];
  let checks = 0;
  const fail = (check: string, message: string) =>
    findings.push({ check, severity: "error", message });
  const warn = (check: string, message: string) =>
    findings.push({ check, severity: "warning", message });
  const ran = () => {
    checks++;
  };

  // ── The declaration loads on this host ─────────────────────────────────
  ran();
  const incompatible = checkContractCompatibility(def.contract, `source '${def.id}'`);
  if (incompatible) fail("contract.loadable", incompatible.message);

  // ── Versioned state ────────────────────────────────────────────────────
  const state = def.contract?.state;
  if (state) {
    ran();
    const sample = options.stateFixtures?.[state.version];
    if (sample === undefined) {
      warn(
        "state.current-fixture",
        `no stateFixtures entry for the current version ${state.version}. Without one, nothing proves this version's own decoder accepts what this version writes.`,
      );
    } else {
      const decoded = state.decode(sample);
      if (!decoded) {
        fail(
          "state.current-fixture",
          `the version ${state.version} fixture was rejected by this version's own decoder`,
        );
      } else {
        // Round-trip: what the host persists must come back identical.
        ran();
        let envelope;
        try {
          envelope = encodeSourceState(state, decoded, { sourceId: def.id });
        } catch (err) {
          // A declared state ceiling is enforced at encode, so a fixture that
          // exceeds it lands here rather than as a thrown run.
          fail("state.round-trip", err instanceof Error ? err.message : String(err));
          return { source: def.id, checks, findings, ok: false };
        }
        const outcome = resolveSourceState(state, envelope, { sourceId: def.id });
        if (outcome.kind !== "resume") {
          fail(
            "state.round-trip",
            `an encoded current-version state resolved as '${outcome.kind}' instead of 'resume', so a source cannot resume from its own bookmark. A decoder that emits a shape it would not itself accept lands here.`,
          );
        } else if (JSON.stringify(outcome.state) !== JSON.stringify(decoded)) {
          // This is also what catches a decoder that does not settle. The
          // encoded value has already been through decode once, so resolving
          // it runs decode a second time; a decoder that appends, stamps or
          // re-wraps produces a different value here. Left unchecked, every
          // cycle would rewrite the state even with nothing changed upstream,
          // and the drift compounds invisibly because each individual write
          // looks legitimate.
          fail(
            "state.round-trip",
            "a state did not survive a round trip through encode and resolve. Either decode() drops fields, or it does not settle: decoding its own output produced something different, which makes every cycle rewrite the state for no upstream reason.",
          );
        }
      }
    }

    // Every historical version must have a fixture, and must migrate.
    for (let v = 1; v < state.version; v++) {
      ran();
      const fixture = options.stateFixtures?.[v];
      if (fixture === undefined) {
        warn(
          `state.migration-from-${v}`,
          `no stateFixtures entry for version ${v}, so its migration is declared but never exercised. An untested migration is the one that breaks on an old install.`,
        );
        continue;
      }
      const outcome = resolveSourceState(
        state,
        { e: 1 as const, v, state: fixture as SourceState },
        { sourceId: def.id },
      );
      if (outcome.kind !== "migrated") {
        fail(
          `state.migration-from-${v}`,
          `a version ${v} state resolved as '${outcome.kind}' instead of 'migrated'` +
            ("reason" in outcome ? `: ${outcome.reason}` : ""),
        );
        continue;
      }
      if (outcome.to !== state.version) {
        fail(
          `state.migration-from-${v}`,
          `the chain stopped at version ${outcome.to} instead of reaching ${state.version}`,
        );
        continue;
      }
      const extra = options.expectMigrated?.[v];
      if (extra) {
        ran();
        try {
          extra(outcome.state);
        } catch (err) {
          fail(
            `state.migration-from-${v}.expectations`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    // Legacy pre-envelope values.
    for (const [i, legacy] of (options.legacyStateFixtures ?? []).entries()) {
      ran();
      const outcome = resolveSourceState(state, legacy, { sourceId: def.id });
      if (outcome.kind === "rebootstrap" || outcome.kind === "refused") {
        fail(
          `state.legacy-fixture-${i}`,
          `a legacy stored value resolved as '${outcome.kind}': ${outcome.reason}. ` +
            `An installed release wrote this shape, so it must migrate rather than start over.`,
        );
      }
    }

    for (const [i, refused] of (options.refusedStateFixtures ?? []).entries()) {
      ran();
      const outcome = resolveSourceState(state, refused, { sourceId: def.id });
      if (outcome.kind === "resume" || outcome.kind === "migrated") {
        fail(
          `state.refused-fixture-${i}`,
          `a value this source declares it cannot use resolved as '${outcome.kind}'. ` +
            `Resuming from it is exactly what the refusal exists to prevent.`,
        );
      }
    }

    // A newer version must be refused, never overwritten.
    ran();
    const future = resolveSourceState(
      state,
      { e: 1 as const, v: state.version + 1, state: {} },
      { sourceId: def.id },
    );
    if (future.kind !== "refused") {
      fail(
        "state.future-refused",
        `state written by a newer build resolved as '${future.kind}' instead of 'refused'; a downgrade would overwrite it`,
      );
    }

    // A genuine first run must be distinguishable from unreadable state.
    ran();
    if (resolveSourceState(state, null, { sourceId: def.id }).kind !== "fresh") {
      fail("state.fresh", "an absent state did not resolve as 'fresh'");
    }
  } else if ((def.contract?.apiVersion ?? 1) >= 2) {
    ran();
    warn(
      "state.declared",
      "the source targets api version 2 or later but declares no state spec, so an unreadable bookmark is still indistinguishable from a first run",
    );
  }

  // ── Static declaration sanity ──────────────────────────────────────────
  if (def.selfIdentity?.accountPattern) {
    ran();
    try {
      new RegExp(def.selfIdentity.accountPattern);
    } catch (err) {
      fail(
        "self-identity.pattern",
        `accountPattern is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Declaration versus implementation ──────────────────────────────────
  if (options.instantiate) {
    let instance: SourceInstance | undefined;
    ran();
    try {
      instance = await options.instantiate();
    } catch (err) {
      fail(
        "instance.creates",
        `create() threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (instance) {
      const declaresSchemas = Array.isArray(def.analyticsSchemas);
      const hasStructured = typeof instance.syncStructured === "function";

      ran();
      if (declaresSchemas && (def.analyticsSchemas?.length ?? 0) > 0 && !hasStructured) {
        fail(
          "capability.analytics",
          "the definition declares analyticsSchemas but the instance has no syncStructured(), so the tables it promises are never written",
        );
      }

      ran();
      if (hasStructured && !declaresSchemas) {
        fail(
          "capability.analytics",
          "the instance implements syncStructured() but the definition declares no analyticsSchemas. Declare an empty array for a source whose schemas are discovered at runtime, so the capability is still visible.",
        );
      }

      ran();
      if (def.historyImport && typeof instance.importHistory !== "function") {
        fail(
          "capability.history-import",
          "the definition declares historyImport but the instance has no importHistory(), so a client renders a form that cannot run",
        );
      }

      ran();
      if (!def.historyImport && typeof instance.importHistory === "function") {
        warn(
          "capability.history-import",
          "the instance implements importHistory() but the definition declares no historyImport spec, so no client will ever offer it",
        );
      }

      // Suspend and resume are a pair. One without the other leaves a live
      // connection either un-pausable or un-revivable, and the second is worse:
      // a disabled source that can never come back without a restart.
      ran();
      const canSuspend = typeof instance.suspend === "function";
      const canResume = typeof instance.resume === "function";
      if (canSuspend !== canResume) {
        fail(
          "lifecycle.suspend-resume",
          canSuspend
            ? "the instance implements suspend() but not resume(), so disabling the source cannot be undone without recreating it"
            : "the instance implements resume() but not suspend(), so nothing ever pauses the connection resume() revives",
        );
      }

      ran();
      if (executionModeOf(def) === "external") {
        fail(
          "execution.external-instantiated",
          'the definition declares execution: "external", so nothing here drives it and it should have no factory to instantiate',
        );
      }
    }
  }

  return { source: def.id, checks, findings, ok: !findings.some((f) => f.severity === "error") };
}

/**
 * Run the suite for every source entry of a provider package, returning one
 * report per entry.
 */
export async function runProviderConformance(
  def: ProviderDefinition<unknown>,
  options: Record<string, SourceConformanceOptions> = {},
): Promise<ConformanceReport[]> {
  const reports: ConformanceReport[] = [];
  for (const entry of def.sources) {
    // A provider entry is not a full definition; project it onto the shape the
    // source-level checks read, inheriting the provider's declaration for the
    // fields an entry does not carry its own.
    const projected = {
      ...entry,
      type: "source" as const,
      authType: def.authType,
      contract: mergeContractDeclarations(def.contract, entry.contract),
      selfIdentity: entry.selfIdentity,
    } as unknown as SourceDefinition<never, SourceState>;
    reports.push(await runSourceConformance(projected, options[entry.id] ?? {}));
  }
  return reports;
}

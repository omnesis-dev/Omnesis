// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Watch DSL Validator — façade.
 *
 * Input: a candidate watch document and an ontology snapshot. Output: a list of
 * machine-readable diagnostics. It is the compiler's feedback loop, so it aims
 * to be **precise and exhaustive rather than early-exiting** — a compiler that
 * gets one error per round trip converges slowly, so the validator reports
 * every independent problem it can still see after a failure.
 *
 * It refuses to guess. Where the substrate genuinely cannot answer — the type
 * of a SQL result column, a field a source never declared — the validator says
 * so with a specific code instead of inventing a type or waving the reference
 * through.
 *
 * `validateWatch` is the whole public surface. This file owns the order the
 * checks run in and nothing else; each concern lives in a collaborator, all of
 * which read the accumulating `ValidationContext`:
 *
 * | Module                 | Owns                                                                 |
 * | ---------------------- | -------------------------------------------------------------------- |
 * | `context.ts`           | the state one run shares — nodes, outputs, ancestors, keys, constants |
 * | `node-traits.ts`       | what each node type is, in one exhaustive table                       |
 * | `graph.ts`             | ids, edges, cycles, ordering, ancestry, sink reachability             |
 * | `sources.ts`           | trip-wires against the ontology they claim to watch                   |
 * | `lifecycle.ts`         | collision modes, deadlines, instance ceilings, gate reachability      |
 * | `evaluating-nodes.ts`  | the SQL and LLM nodes, and `fire_when`                                |
 * | `references.ts`        | resolving every `$`-reference to what it names, typed and nullable    |
 * | `outputs.ts`           | what each node carries forward, and whether it can arrive null        |
 * | `keys.ts` (here)       | key extractors, their type agreement, and broadcast edges             |
 * | `sql.ts`               | static analysis of a query: tables, projection, bound parameters      |
 * | `diagnostics.ts`       | the diagnostic codes and their deterministic ordering                 |
 *
 * New checks belong in the collaborator that owns the concern, not here.
 */

import { nodeInputs, watchDslSchema, type WatchDefinition, type WatchNode } from "../dsl/schema.js";
import {
  BOOLEAN,
  DATE,
  NUMBER,
  STRING,
  TIMESTAMP,
  formatValueType,
  typesCompatible,
  type ValueType,
} from "../dsl/value-type.js";
import { durationMs, parseDuration } from "../time/duration.js";
import { nextCronOccurrence, parseCron } from "../time/cron.js";
import { ReferenceResolver } from "./references.js";
import { GraphChecker } from "./graph.js";
import { OutputDeriver } from "./outputs.js";
import { LifecycleChecker } from "./lifecycle.js";
import { EvaluatingNodeChecker } from "./evaluating-nodes.js";
import { SourceChecker } from "./sources.js";
import { type ValidationContext } from "./context.js";
import {
  DiagnosticCollector,
  pointer,
  type ValidationResult,
  type WatchValueTypes,
} from "./diagnostics.js";
import { type NodeOutput } from "./node-output.js";
import type { DocumentFrequency } from "../runtime/lexical.js";
import type { OntologyReads } from "../ontology/snapshot.js";

/**
 * A recurring source firing more often than this behind an LLM node is a cost
 * bug, not a design. The lint exists because the compiler will otherwise reach
 * for "just judge every event".
 */
const LLM_TIMER_LINT_MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Fixed instant the cron-cadence lint measures from. A constant, not a clock
 * read: the validator must give the same answer on every machine, forever.
 */
const CADENCE_PROBE_EPOCH_MS = Date.UTC(2026, 0, 1);

export function validateWatch(
  raw: unknown,
  ontology: OntologyReads,
  options: { readonly docFrequency?: DocumentFrequency } = {},
): ValidationResult {
  const collector = new DiagnosticCollector();

  const parsed = watchDslSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      collector.error("DSL_SCHEMA_INVALID", pointer(...issue.path.map(String)), issue.message, {
        zodCode: issue.code,
      });
    }
    return collector.result();
  }

  const validator = new WatchValidator(
    parsed.data.watch,
    ontology,
    collector,
    options.docFrequency,
  );
  validator.run();
  // Carried out even when the watch does not validate: a caller may want to
  // know what the types resolved to in order to explain why it did not.
  return { ...collector.result(), types: validator.valueTypes() };
}

class WatchValidator {
  private readonly nodes: ReadonlyMap<string, WatchNode>;
  private readonly outputs = new Map<string, NodeOutput>();
  private readonly keyComponents = new Map<string, ReadonlyMap<string, ValueType>>();
  private readonly ancestors = new Map<string, ReadonlySet<string>>();
  private readonly constants: ReadonlyMap<string, ValueType>;
  private readonly nodeIndex: ReadonlyMap<string, number>;
  private readonly ctx: ValidationContext;
  private readonly resolver: ReferenceResolver;
  private readonly sources: SourceChecker;
  private readonly graph: GraphChecker;
  private readonly outputsDeriver: OutputDeriver;
  private readonly lifecycle: LifecycleChecker;
  private readonly evaluating: EvaluatingNodeChecker;

  constructor(
    private readonly watch: WatchDefinition,
    private readonly ontology: OntologyReads,
    private readonly diag: DiagnosticCollector,
    private readonly docFrequency?: DocumentFrequency,
  ) {
    const nodes = new Map<string, WatchNode>();
    const index = new Map<string, number>();
    this.watch.nodes.forEach((node, i) => {
      if (!nodes.has(node.id)) {
        nodes.set(node.id, node);
        index.set(node.id, i);
      }
    });
    this.nodes = nodes;
    this.nodeIndex = index;
    this.constants = new Map(
      Object.entries(this.watch.constants ?? {}).map(([name, c]) => [name, constantType(c.type)]),
    );
    this.ctx = {
      watch: this.watch,
      ontology: this.ontology,
      diag: this.diag,
      nodes: this.nodes,
      outputs: this.outputs,
      ancestors: this.ancestors,
      keyComponents: this.keyComponents,
      constants: this.constants,
      ...(this.docFrequency ? { docFrequency: this.docFrequency } : {}),
    };
    this.resolver = new ReferenceResolver(this.ctx);
    this.sources = new SourceChecker(this.ctx);
    this.graph = new GraphChecker(this.ctx);
    this.outputsDeriver = new OutputDeriver(this.ctx, this.resolver);
    this.lifecycle = new LifecycleChecker(this.ctx);
    this.evaluating = new EvaluatingNodeChecker(this.ctx, this.resolver, this.outputsDeriver);
  }

  /**
   * The types this run derived, for a runtime that has to bind these values.
   *
   * The validator computes them to check that references resolve and that key
   * extractors agree across edges. Handing them out means a `sql` node binds
   * `$n.spend.amount` as the number the catalog declares it to be, rather than
   * as whatever shape it happens to arrive in — which, having crossed a journal
   * encoded as JSON, is text.
   */
  valueTypes(): WatchValueTypes {
    const nodes = new Map<string, ReadonlyMap<string, ValueType>>();
    for (const [id, output] of this.ctx.outputs) {
      nodes.set(id, new Map([...output.fields].map(([name, info]) => [name, info.type])));
    }
    return { nodes, keys: new Map(this.keyComponents), constants: this.constants };
  }

  run(): void {
    this.graph.checkFingerprint();
    this.graph.checkConstants();
    this.graph.checkDuplicateIds();
    this.graph.checkEdges();

    const sorted = this.graph.topologicalOrder();
    if (!sorted) return; // A cycle makes every downstream check meaningless.
    this.graph.computeAncestors();

    this.graph.checkSink();

    for (const id of sorted) {
      const node = this.nodes.get(id)!;
      const nodePath = this.graph.pathOf(id);
      this.keyComponents.set(id, this.checkKeys(node, nodePath));
      this.checkNodeSemantics(node, nodePath);
      this.ctx.outputs.set(id, this.outputsDeriver.deriveOutput(node, nodePath));
    }

    this.checkSinkOutputMap();
    this.graph.checkReachability();
    this.checkLints();
  }

  // -------------------------------------------------------------------------
  // Graph shape
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Per-node semantics
  // -------------------------------------------------------------------------

  private checkNodeSemantics(node: WatchNode, path: string): void {
    this.lifecycle.checkCollisionAndLifecycle(node, path);

    switch (node.type) {
      case "source.document_event":
        this.sources.checkDocumentEventSource(node, path);
        break;
      case "source.analytics_row":
        this.sources.checkAnalyticsRowSource(node, path);
        break;
      case "source.open_loop":
        this.sources.checkOpenLoopSource(node, path);
        break;
      case "source.time":
        this.sources.checkTimeSource(node, path);
        break;
      case "stateless.transform":
        this.evaluating.checkSqlBearingNode(node, path);
        break;
      case "sql":
        this.evaluating.checkSqlBearingNode(node, path);
        this.lifecycle.checkEdgeDetection(node, path);
        break;
      case "llm":
        this.evaluating.checkLlmNode(node, path);
        break;
      case "stateful.sequence":
        this.lifecycle.checkSequenceOrder(node, path);
        break;
      case "stateful.threshold":
        this.lifecycle.checkThresholdReachable(node, path);
        break;
      default:
        break;
    }

    this.lifecycle.checkDurationFields(node, path);
  }

  // -------------------------------------------------------------------------
  // Source-node ontology checks
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // SQL and LLM nodes
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  /**
   * Check every key extractor on a node's edges and return the key the node
   * ends up with. The types come back typed rather than re-derived: an arm and
   * a cancel keyed on values that never compare equal is the never-cancel bug,
   * and catching it depends on knowing what each edge actually computes.
   */
  private checkKeys(node: WatchNode, path: string): ReadonlyMap<string, ValueType> {
    const inputs = Object.entries(nodeInputs(node));
    const keyed = inputs.filter(([, input]) => input.key !== undefined);
    const componentTypes = new Map<string, ValueType>();
    if (inputs.length === 0) return componentTypes;

    /** Every type each component was given, with the edge that gave it. */
    const resolvedPerComponent = new Map<string, { inputId: string; type: ValueType }[]>();

    for (const [inputId, input] of keyed) {
      const upstream = this.outputs.get(inputId);
      const inputPath = `${path}/inputs/${inputId}`;

      for (const [component, expression] of Object.entries(input.key!)) {
        const componentPath = `${inputPath}/key/${component}`;
        const resolved = this.resolver.resolveText(expression, componentPath, {
          node,
          path: componentPath,
          event: null,
          edge: upstream ?? null,
          native: null,
          ownKey: new Map(),
          requiresNonNull: true,
          nullableThroughBranch: this.outputsDeriver.nullableAncestors(node.id),
        });
        if (!resolved) continue;

        const seen = resolvedPerComponent.get(component) ?? [];
        // Compare against every edge already seen, not just the first. Type
        // compatibility is not transitive — a string is compatible with both an
        // enum and an id, which are not compatible with each other — so a
        // first-wins comparison lets an incompatible pair through whenever a
        // permissive edge happens to come first.
        for (const previous of seen) {
          if (typesCompatible(previous.type, resolved.type)) continue;
          this.diag.error(
            "KEY_COMPONENT_TYPE_MISMATCH",
            componentPath,
            `Key component '${component}' is ${formatValueType(previous.type)} on edge '${previous.inputId}' and ${formatValueType(resolved.type)} here — instances armed on one would never be found by the other.`,
            {
              component,
              otherInput: previous.inputId,
              expected: formatValueType(previous.type),
              actual: formatValueType(resolved.type),
            },
          );
        }
        seen.push({ inputId, type: resolved.type });
        resolvedPerComponent.set(component, seen);

        // Keep the most specific type any edge gave the component.
        const existing = componentTypes.get(component);
        if (existing === undefined || existing.kind === "unknown") {
          componentTypes.set(component, resolved.type);
        }
      }
    }

    if (keyed.length === 0) return componentTypes;

    // The node's key is the union of what its edges compute, not whichever edge
    // the document happened to list first — otherwise the diagnostic blames an
    // arbitrary side and flips when the inputs are reordered.
    const expected = new Set(keyed.flatMap(([, input]) => Object.keys(input.key!)));
    for (const [inputId, input] of keyed) {
      const declared = new Set(Object.keys(input.key!));
      if (declared.size !== expected.size || [...expected].some((c) => !declared.has(c))) {
        this.diag.error(
          "KEY_COMPONENTS_MISMATCH",
          `${path}/inputs/${inputId}/key`,
          `Every keyed edge into '${node.id}' must compute the same key components; this one computes [${[...declared].sort().join(", ")}] where the node's key is [${[...expected].sort().join(", ")}].`,
          { components: [...declared].sort(), expected: [...expected].sort() },
        );
      }
    }

    for (const [inputId, input] of inputs) {
      if (input.key !== undefined) {
        if (input.broadcast === true) {
          this.diag.error(
            "BROADCAST_NOT_ALLOWED",
            `${path}/inputs/${inputId}/broadcast`,
            `A broadcast edge has no key of its own; this edge declares one.`,
            { inputId },
          );
        }
        continue;
      }
      if (input.broadcast === true) continue;
      this.diag.error(
        "BROADCAST_REQUIRED",
        `${path}/inputs/${inputId}`,
        `Node '${node.id}' is keyed, so a keyless edge must say what it means: declare 'broadcast: true' to fan this input out to every live key.`,
        { inputId, keyComponents: [...expected].sort() },
      );
    }

    return componentTypes;
  }

  // -------------------------------------------------------------------------
  // Outputs and expression resolution
  // -------------------------------------------------------------------------

  private checkSinkOutputMap(): void {
    const sink = this.watch.sink;
    if (sink.output_map === undefined) return;
    const inputNode = this.nodes.get(sink.input);
    if (!inputNode) return;

    for (const [name, expression] of Object.entries(sink.output_map)) {
      const path = pointer("watch", "sink", "output_map", name);
      this.resolver.resolveText(expression, path, {
        node: inputNode,
        path,
        event: null,
        edge: null,
        native: this.outputs.get(sink.input) ?? null,
        ownKey: this.outputs.get(sink.input)?.keyComponents ?? new Map(),
        requiresNonNull: false,
        nullableThroughBranch: this.outputsDeriver.nullableAncestors(sink.input),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Lints
  // -------------------------------------------------------------------------

  private checkLints(): void {
    this.checkDatedReferentHasHorizon();

    for (const [id, node] of this.nodes) {
      if (node.type !== "llm") continue;
      const cadence = this.fastestUpstreamCadenceMs(id);
      if (cadence === null || cadence >= LLM_TIMER_LINT_MIN_INTERVAL_MS) continue;
      this.diag.warn(
        "LINT_LLM_BEHIND_FAST_TIMER",
        this.graph.pathOf(id),
        `'${id}' invokes a model on a cadence of about every ${Math.round(cadence / 60000)} minutes. Put a procedural gate in front of it.`,
        { nodeId: id, intervalMs: cadence },
      );
    }
  }

  /**
   * A watch bound to a dated thing should say when it stops asking.
   *
   * Resolving "the dinner" freezes a date into the plan, and a date is a
   * horizon: after it, the watch is not waiting for an answer, it is waiting
   * for something that has already happened. Left standing it costs a little
   * forever and reports on a question nobody is asking any more, which is what
   * makes "hundreds of standing intentions" expensive rather than cheap.
   *
   * A warning rather than an error, because the horizon is a judgement — a
   * watch bound to a passport's expiry may reasonably outlive it by months —
   * and a compiler that cannot express "no, this one really is open-ended"
   * would be forced to lie.
   */
  private checkDatedReferentHasHorizon(): void {
    if (this.watch.expires_at !== undefined) return;

    const dated = Object.entries(this.watch.constants ?? {}).filter(
      ([, constant]) => constant.type === "date" || constant.type === "timestamp",
    );
    if (dated.length === 0) return;

    const names = dated.map(([name]) => name);
    this.diag.warn(
      "LINT_DATED_REFERENT_WITHOUT_EXPIRY",
      "/watch/expires_at",
      `This watch is bound to something dated (${names.join(", ")}) but declares no 'expires_at'. A watch whose referent has passed is asking a question that has ended.`,
      { constants: names },
    );
  }

  /** The shortest recurring interval reaching a node through its ancestry. */
  private fastestUpstreamCadenceMs(nodeId: string): number | null {
    let fastest: number | null = null;
    const consider = (ms: number | null): void => {
      if (ms === null) return;
      fastest = fastest === null ? ms : Math.min(fastest, ms);
    };

    for (const ancestorId of [nodeId, ...(this.ancestors.get(nodeId) ?? [])]) {
      const node = this.nodes.get(ancestorId);
      if (!node) continue;
      if (node.type === "source.time" && node.recurring !== undefined) {
        consider(cronIntervalMs(node.recurring));
      }
      if (node.type === "sql" && node.timer !== undefined) {
        const timer = parseDuration(node.timer);
        consider(timer === null ? null : durationMs(timer));
      }
    }
    return fastest;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function constantType(declared: string): ValueType {
  switch (declared) {
    case "number":
      return NUMBER;
    case "boolean":
      return BOOLEAN;
    case "date":
      return DATE;
    case "timestamp":
      return TIMESTAMP;
    default:
      return STRING;
  }
}

/**
 * The shortest gap between two firings of a cron schedule, probed over a fixed
 * week from a fixed epoch so the answer never depends on when it was asked.
 */
function cronIntervalMs(expression: string): number | null {
  const cron = parseCron(expression);
  if (!cron) return null;

  // A year, not a week: a schedule can be fast and still restricted to one
  // month, and a week-long probe would see none of its firings at all.
  let cursor = CADENCE_PROBE_EPOCH_MS;
  const horizon = CADENCE_PROBE_EPOCH_MS + 366 * 86_400_000;
  let previous: number | null = null;
  let shortest: number | null = null;

  // 256 consecutive firings is far past what any cadence lint needs — a fast
  // schedule shows its interval in the first few — and bounds the walk.
  for (let i = 0; i < 256; i++) {
    const next = nextCronOccurrence(cron, cursor);
    if (next === null || next > horizon) break;
    if (previous !== null) {
      const gap = next - previous;
      shortest = shortest === null ? gap : Math.min(shortest, gap);
    }
    previous = next;
    cursor = next;
  }
  // A schedule with fewer than two firings in a year has no interval to report.
  return shortest;
}

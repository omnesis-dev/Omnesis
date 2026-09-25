// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The shape of the graph, before anything is asked about what it means.
 *
 * A watch is a DAG whose signal flows one way into exactly one sink. These
 * checks establish that much — unique node ids, edges that point at real nodes,
 * no cycle, a reachable sink, no node that feeds nothing — and along the way
 * build the two structures every later check reads: the topological order, and
 * each node's transitive input closure.
 *
 * Order matters here. A cycle makes every downstream question meaningless
 * (there is no "upstream" to resolve a reference against), so a graph that
 * fails to order is reported and abandoned rather than checked further.
 */

import { isSourceNode, nodeInputs } from "../dsl/schema.js";
import { pointer } from "./diagnostics.js";
import { traitsOf } from "./node-traits.js";
import { isIsoInstant } from "./sources.js";
import type { ValidationContext } from "./context.js";

export class GraphChecker {
  /** Node ids to their index in the document, for JSON pointers. */
  private readonly nodeIndex: ReadonlyMap<string, number>;
  /** Topological order, produced by `topologicalOrder` and read after it. */
  private order: string[] = [];

  constructor(private readonly ctx: ValidationContext) {
    const index = new Map<string, number>();
    this.ctx.watch.nodes.forEach((node, i) => {
      if (!index.has(node.id)) index.set(node.id, i);
    });
    this.nodeIndex = index;
  }

  pathOf(nodeId: string): string {
    return pointer("watch", "nodes", this.nodeIndex.get(nodeId) ?? 0);
  }

  checkFingerprint(): void {
    const declared = this.ctx.watch.ontology_fingerprint;
    if (declared !== undefined && declared !== this.ctx.ontology.fingerprint) {
      this.ctx.diag.error(
        "ONTOLOGY_FINGERPRINT_MISMATCH",
        pointer("watch", "ontology_fingerprint"),
        `Watch was compiled against ontology '${declared}' but the snapshot is '${this.ctx.ontology.fingerprint}'.`,
        { compiledAgainst: declared, snapshot: this.ctx.ontology.fingerprint },
      );
    }
  }

  /**
   * A constant is the one place a watch asserts a value it did not read from an
   * event, so the assertion has to hold: every downstream reference is typed
   * from the declared `type`, and an unchecked mismatch would type-check the
   * whole watch against a type its own value contradicts.
   */
  checkConstants(): void {
    for (const [name, constant] of Object.entries(this.ctx.watch.constants ?? {})) {
      const path = pointer("watch", "constants", name);
      if (constantValueMatches(constant.type, constant.value)) continue;
      this.ctx.diag.error(
        "CONSTANT_VALUE_TYPE_MISMATCH",
        `${path}/value`,
        `Constant '${name}' is declared ${constant.type} but holds ${JSON.stringify(constant.value)}.`,
        { name, declared: constant.type, value: constant.value },
      );
    }
  }

  checkDuplicateIds(): void {
    const seen = new Set<string>();
    this.ctx.watch.nodes.forEach((node, i) => {
      if (seen.has(node.id)) {
        this.ctx.diag.error(
          "NODE_ID_DUPLICATE",
          pointer("watch", "nodes", i, "id"),
          `Duplicate node id '${node.id}'.`,
          { nodeId: node.id },
        );
      }
      seen.add(node.id);
    });
  }

  checkEdges(): void {
    this.ctx.watch.nodes.forEach((node, i) => {
      const base = pointer("watch", "nodes", i);
      const inputs = nodeInputs(node);
      const inputIds = Object.keys(inputs);

      // Source nodes are trip-wires: the schema gives them no `inputs` field
      // at all, so there is no edge to check.
      if (isSourceNode(node)) return;

      if (inputIds.length === 0) {
        this.ctx.diag.error(
          "NODE_MISSING_INPUTS",
          `${base}/inputs`,
          `Node '${node.id}' of type '${node.type}' needs at least one input.`,
          { nodeId: node.id },
        );
        return;
      }

      let armCount = 0;
      let cancelCount = 0;
      for (const [inputId, input] of Object.entries(inputs)) {
        const inputPath = `${base}/inputs/${inputId}`;

        if (inputId === node.id) {
          this.ctx.diag.error(
            "INPUT_SELF_REFERENCE",
            inputPath,
            `Node '${node.id}' cannot be its own input.`,
          );
          continue;
        }
        if (!this.ctx.nodes.has(inputId)) {
          this.ctx.diag.error(
            "INPUT_NODE_UNKNOWN",
            inputPath,
            `Node '${node.id}' names an input '${inputId}' that does not exist.`,
            { nodeId: node.id, missing: inputId, known: [...this.ctx.nodes.keys()] },
          );
          continue;
        }

        if (input.role === "arm") armCount++;
        else cancelCount++;
      }

      if (armCount === 0) {
        this.ctx.diag.error(
          "NODE_MISSING_INPUTS",
          `${base}/inputs`,
          `Node '${node.id}' has no arm input — nothing can instantiate it.`,
          { nodeId: node.id },
        );
      }
      if (cancelCount > 0 && !traitsOf(node).cancellable) {
        this.ctx.diag.error(
          "CANCEL_INPUT_NOT_ALLOWED",
          `${base}/inputs`,
          `A '${node.type}' node evaluates instantly and cannot take a cancel input.`,
          { nodeId: node.id, nodeType: node.type },
        );
      }
      if (cancelCount > 1) {
        this.ctx.diag.error(
          "CANCEL_INPUT_NOT_ALLOWED",
          `${base}/inputs`,
          `Node '${node.id}' declares ${cancelCount} cancel inputs; at most one is allowed.`,
          { nodeId: node.id, cancelCount },
        );
      }
    });
  }

  /** Kahn's algorithm; reports the nodes left over as a cycle. */
  topologicalOrder(): string[] | null {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const id of this.ctx.nodes.keys()) {
      indegree.set(id, 0);
      dependents.set(id, []);
    }
    for (const [id, node] of this.ctx.nodes) {
      for (const inputId of Object.keys(nodeInputs(node))) {
        if (!this.ctx.nodes.has(inputId) || inputId === id) continue;
        indegree.set(id, indegree.get(id)! + 1);
        dependents.get(inputId)!.push(id);
      }
    }

    // Iterate `this.ctx.nodes` (declaration order) so the result is deterministic.
    const queue = [...this.ctx.nodes.keys()].filter((id) => indegree.get(id) === 0);
    const order: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(id);
      for (const dependent of dependents.get(id)!) {
        const remaining = indegree.get(dependent)! - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) queue.push(dependent);
      }
    }

    this.order = order;
    if (order.length !== this.ctx.nodes.size) {
      const cycle = [...this.ctx.nodes.keys()].filter((id) => !order.includes(id));
      this.ctx.diag.error(
        "GRAPH_CYCLE",
        pointer("watch", "nodes"),
        `Signal must flow downstream only, so every node must be orderable. These could not be, because a cycle sits among them or upstream of them: ${cycle.join(", ")}.`,
        { nodes: cycle },
      );
      return null;
    }
    return order;
  }

  computeAncestors(): void {
    for (const id of this.order) {
      const set = new Set<string>();
      for (const inputId of Object.keys(nodeInputs(this.ctx.nodes.get(id)!))) {
        if (!this.ctx.nodes.has(inputId)) continue;
        set.add(inputId);
        for (const inherited of this.ctx.ancestors.get(inputId) ?? []) set.add(inherited);
      }
      this.ctx.ancestors.set(id, set);
    }
  }

  checkSink(): void {
    if (!this.ctx.nodes.has(this.ctx.watch.sink.input)) {
      this.ctx.diag.error(
        "SINK_INPUT_UNKNOWN",
        pointer("watch", "sink", "input"),
        `The sink reads from '${this.ctx.watch.sink.input}', which is not a node.`,
        { missing: this.ctx.watch.sink.input, known: [...this.ctx.nodes.keys()] },
      );
    }
  }

  checkReachability(): void {
    const sinkInput = this.ctx.watch.sink.input;
    if (!this.ctx.nodes.has(sinkInput)) return;

    const reachable = new Set<string>([sinkInput, ...(this.ctx.ancestors.get(sinkInput) ?? [])]);
    for (const [id] of this.ctx.nodes) {
      if (reachable.has(id)) continue;
      this.ctx.diag.error(
        "NODE_UNREACHABLE_FROM_SINK",
        this.pathOf(id),
        `Node '${id}' feeds nothing — signal flows to exactly one sink, so it can never affect a firing.`,
        { nodeId: id },
      );
    }
  }
}

/** Whether a declared constant type actually describes the value it carries. */
function constantValueMatches(declared: string, value: string | number | boolean): boolean {
  switch (declared) {
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case "timestamp":
      return typeof value === "string" && isIsoInstant(value);
    default:
      return typeof value === "string";
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * When a node's instance is born, and when it must die.
 *
 * A stateful node holds an instance between the arm that created it and the
 * fire, cancel or deadline that ends it, and the DSL insists that every part of
 * that lifecycle be an explicit choice rather than an omission: what a colliding
 * arm does, how many parallel instances may live, and when an instance that
 * never fires gives up. The one documented exception is an accumulate cell,
 * which is meant to outlive firings — a deadline would be the wrong concept for
 * it.
 *
 * These rules are what make the difference between a watch that quietly leaks
 * live state forever and one whose cost is visible in the plan.
 */

import { nodeInputs, type SqlNode, type WatchNode } from "../dsl/schema.js";
import { parseDuration } from "../time/duration.js";
import { isStateful, traitsOf } from "./node-traits.js";
import type { ValidationContext } from "./context.js";

export class LifecycleChecker {
  constructor(private readonly ctx: ValidationContext) {}

  checkDurationFields(node: WatchNode, path: string): void {
    const durations: [string, string][] = [];
    if ("duration" in node && typeof node.duration === "string")
      durations.push(["duration", node.duration]);
    if ("min_interval" in node && typeof node.min_interval === "string")
      durations.push(["min_interval", node.min_interval]);
    if ("timer" in node && typeof node.timer === "string") durations.push(["timer", node.timer]);
    if ("persistence" in node && typeof node.persistence === "string")
      durations.push(["persistence", node.persistence]);
    if ("scope" in node && node.scope) durations.push(["scope/horizon", node.scope.horizon]);
    if ("deadline" in node && typeof node.deadline === "string" && node.deadline !== "infinite")
      durations.push(["deadline", node.deadline]);

    for (const [field, text] of durations) {
      if (parseDuration(text) === null) {
        this.ctx.diag.error(
          "DURATION_INVALID",
          `${path}/${field}`,
          `'${text}' is not a duration. Write '<amount> <unit>', e.g. '3 days' or '90 minutes'.`,
          { value: text, units: ["seconds", "minutes", "hours", "days", "weeks", "business_days"] },
        );
      }
    }

    if ("deadline" in node && node.deadline === "infinite") {
      this.ctx.diag.warn(
        "LINT_INFINITE_DEADLINE",
        `${path}/deadline`,
        `Node '${node.id}' holds state forever. The backtest reports its peak live instance count — check it before shipping.`,
        { nodeId: node.id },
      );
    }
  }

  checkCollisionAndLifecycle(node: WatchNode, path: string): void {
    const legal = traitsOf(node).collisionModes;
    const declared = "on_collision" in node ? node.on_collision : undefined;

    if (legal.length === 0) {
      if (declared !== undefined) {
        this.ctx.diag.error(
          "COLLISION_MODE_NOT_APPLICABLE",
          `${path}/on_collision`,
          `A '${node.type}' node evaluates instantly and holds no per-key state.`,
          { nodeType: node.type },
        );
      }
      return;
    }

    const stateful = isStateful(node);
    // Checked before anything can return: a ceiling on parallel instances is
    // meaningless unless the node spawns them, and that stays true whatever
    // else is wrong with the node.
    const maxLive = "max_live_instances" in node ? node.max_live_instances : undefined;
    if (maxLive !== undefined && declared !== "spawn") {
      this.ctx.diag.error(
        "MAX_LIVE_INSTANCES_WITHOUT_SPAWN",
        `${path}/max_live_instances`,
        `Only 'spawn' creates parallel instances per key; ${declared === undefined ? "this node declares no collision mode" : `'${declared}' keeps at most one`}.`,
        { nodeId: node.id, declared: declared ?? null },
      );
    }

    if (declared === undefined) {
      if (stateful && legal.length > 1) {
        this.ctx.diag.error(
          "COLLISION_MODE_REQUIRED",
          `${path}/on_collision`,
          `Node '${node.id}' holds state, so what a colliding arm does must be an explicit choice.`,
          { nodeId: node.id, legal },
        );
      }
      return;
    }

    if (!(legal as readonly string[]).includes(declared)) {
      this.ctx.diag.error(
        "COLLISION_MODE_ILLEGAL",
        `${path}/on_collision`,
        `'${declared}' is not a legal collision mode for a '${node.type}' node.`,
        { nodeType: node.type, declared, legal },
      );
      return;
    }

    if (!stateful) {
      this.ctx.diag.error(
        "COLLISION_MODE_NOT_APPLICABLE",
        `${path}/on_collision`,
        `Node '${node.id}' evaluates instantly on arm — with no timer, persistence or accumulation there is no instance to collide with.`,
        { nodeId: node.id },
      );
      return;
    }

    if (declared === "spawn") {
      if (maxLive === undefined) {
        this.ctx.diag.error(
          "SPAWN_REQUIRES_MAX_LIVE_INSTANCES",
          `${path}/max_live_instances`,
          `'spawn' allows parallel instances per key, so a ceiling is mandatory.`,
          { nodeId: node.id },
        );
      }
      const hasCancel = Object.values(nodeInputs(node)).some((i) => i.role === "cancel");
      if (hasCancel) {
        this.ctx.diag.error(
          "SPAWN_WITH_CANCEL_INPUT",
          `${path}/on_collision`,
          `'spawn' with a cancel input is ambiguous — a cancel for key K cannot name which of K's parallel instances it ends.`,
          { nodeId: node.id },
        );
      }
    }

    // Every temporal instance needs an explicit end. Accumulate cells are the
    // documented exception: they are meant to outlive firings, so a deadline
    // would be the wrong concept for them.
    const needsDeadline =
      declared !== "accumulate" &&
      (node.type === "llm" ||
        (node.type === "sql" && (node.timer !== undefined || node.persistence !== undefined)));
    if (needsDeadline && (!("deadline" in node) || node.deadline === undefined)) {
      this.ctx.diag.error(
        "DEADLINE_REQUIRED",
        `${path}/deadline`,
        `Node '${node.id}' can hold a live instance, so it needs an explicit deadline (or "infinite").`,
        { nodeId: node.id },
      );
    }
  }

  /**
   * `initial_level` says what the level is assumed to be before this node has
   * ever observed one, which only means anything when the node fires on a
   * change in level.
   */
  checkEdgeDetection(node: SqlNode, path: string): void {
    if (node.initial_level === undefined || node.fire_on === "rising_edge") return;
    this.ctx.diag.error(
      "INITIAL_LEVEL_WITHOUT_EDGE_DETECTION",
      `${path}/initial_level`,
      `'initial_level' seeds the level a rising edge is measured against; with fire_on '${node.fire_on ?? "every_true"}' there is no edge and nothing reads it.`,
      { nodeId: node.id, fireOn: node.fire_on ?? "every_true" },
    );
  }

  /** A gate that needs more arms than it has can never fire. */
  checkThresholdReachable(
    node: Extract<WatchNode, { type: "stateful.threshold" }>,
    path: string,
  ): void {
    const arms = Object.values(node.inputs).filter((input) => input.role === "arm").length;
    if (node.n <= arms) return;
    this.ctx.diag.error(
      "THRESHOLD_N_EXCEEDS_INPUTS",
      `${path}/n`,
      `Node '${node.id}' fires when ${node.n} of its inputs have fired, but it only has ${arms}.`,
      { nodeId: node.id, n: node.n, armInputs: arms },
    );
  }

  checkSequenceOrder(
    node: Extract<WatchNode, { type: "stateful.sequence" }>,

    path: string,
  ): void {
    const arms = Object.entries(node.inputs)
      .filter(([, input]) => input.role === "arm")
      .map(([id]) => id)
      .sort();
    const declared = [...node.order].sort();

    if (arms.length !== declared.length || arms.some((id, i) => id !== declared[i])) {
      this.ctx.diag.error(
        "SEQUENCE_ORDER_MISMATCH",
        `${path}/order`,
        `'order' must list every arm input exactly once — otherwise the gate silently degrades into an unordered AND.`,
        { order: node.order, armInputs: arms },
      );
    }
  }
}

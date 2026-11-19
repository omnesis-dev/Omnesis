// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

export type StartupStepId =
  | "launcher"
  | "ownership"
  | "tls"
  | "runtime"
  | "configuration"
  | "storage"
  | "workers"
  | "search"
  | "analytics"
  | "agent"
  | "models"
  | "services"
  | "portal"
  | "repairs"
  | "indexer";

export type StartupStepState =
  "pending" | "running" | "succeeded" | "skipped" | "failed" | "blocked";

interface StepDefinition {
  id: StartupStepId;
  label: string;
  dependsOn: readonly StartupStepId[];
  optional?: boolean;
}

/** Public progress consists only of this fixed vocabulary and numeric timing. */
const STEPS: readonly StepDefinition[] = [
  { id: "launcher", label: "Preparing startup helpers", dependsOn: [] },
  { id: "ownership", label: "Acquiring gateway ownership", dependsOn: ["launcher"] },
  { id: "tls", label: "Preparing secure access", dependsOn: ["ownership"] },
  { id: "runtime", label: "Loading gateway modules", dependsOn: ["tls"] },
  { id: "configuration", label: "Loading configuration", dependsOn: ["runtime"] },
  { id: "storage", label: "Preparing database", dependsOn: ["configuration"] },
  { id: "workers", label: "Starting workers", dependsOn: ["storage"] },
  { id: "search", label: "Preparing search", dependsOn: ["workers"] },
  { id: "analytics", label: "Preparing analytics", dependsOn: ["configuration"] },
  { id: "agent", label: "Preparing agent services", dependsOn: ["search", "analytics"] },
  { id: "models", label: "Checking model inventory", dependsOn: ["configuration"] },
  { id: "services", label: "Preparing gateway services", dependsOn: ["agent", "models"] },
  { id: "portal", label: "Opening the portal", dependsOn: ["services"] },
  { id: "repairs", label: "Finishing data maintenance", dependsOn: ["portal"], optional: true },
  {
    id: "indexer",
    label: "Starting the indexer",
    dependsOn: ["search", "repairs"],
    optional: true,
  },
];

export interface MigrationProgress {
  current: number;
  total: number;
  completed: number;
}

export interface StartupMigrationEvent extends MigrationProgress {
  phase: "planned" | "started" | "committed" | "failed";
  version?: number;
}

export interface StartupStepSnapshot {
  id: StartupStepId;
  label: string;
  dependsOn: StartupStepId[];
  optional: boolean;
  state: StartupStepState;
  startedAt?: number;
  finishedAt?: number;
  code?: "STARTUP_STEP_FAILED";
  progress?: MigrationProgress;
}

export interface StartupSnapshot {
  bootId: string;
  sequence: number;
  startedAt: number;
  state: "starting" | "ready" | "failed" | "stopping";
  steps: StartupStepSnapshot[];
}

export class StartupInterruptedError extends Error {
  constructor() {
    super("Gateway startup was interrupted");
    this.name = "StartupInterruptedError";
  }
}

/** One-time startup tracking. Operations own their resources and cleanup; the
 * ordinary gateway Scheduler continues to own ongoing jobs. No database or
 * subsystem is consulted while taking a public progress snapshot. */
export class StartupManager {
  private readonly now: () => number;
  private readonly data: StartupSnapshot;

  constructor(options: { now?: () => number; bootId?: string } = {}) {
    this.now = options.now ?? Date.now;
    this.data = {
      bootId: options.bootId ?? randomUUID(),
      sequence: 0,
      startedAt: this.now(),
      state: "starting",
      steps: STEPS.map((step) => ({
        id: step.id,
        label: step.label,
        dependsOn: [...step.dependsOn],
        optional: step.optional ?? false,
        state: "pending",
      })),
    };
  }

  snapshot(): StartupSnapshot {
    return {
      ...this.data,
      steps: this.data.steps.map((step) => ({
        ...step,
        dependsOn: [...step.dependsOn],
        ...(step.progress ? { progress: { ...step.progress } } : {}),
      })),
    };
  }

  start(id: StartupStepId): boolean {
    if (this.interrupted()) return false;
    const step = this.step(id);
    if (step.state !== "pending") throw new Error(`Startup step ${id} cannot start twice`);
    if (
      !step.dependsOn.every((dependency) => {
        const state = this.step(dependency).state;
        return state === "succeeded" || state === "skipped";
      })
    ) {
      throw new Error(`Startup step ${id} has unfinished dependencies`);
    }
    step.state = "running";
    step.startedAt = this.now();
    this.changed();
    return true;
  }

  succeed(id: StartupStepId): boolean {
    if (this.interrupted()) return false;
    const step = this.step(id);
    if (step.state === "blocked" || step.state === "failed") return false;
    if (step.state !== "running") throw new Error(`Startup step ${id} is not running`);
    step.state = "succeeded";
    step.finishedAt = this.now();
    this.changed();
    return true;
  }

  /** Skipping is reserved for explicitly optional work, never a schema or auth barrier. */
  skip(id: StartupStepId): boolean {
    if (this.interrupted()) return false;
    const step = this.step(id);
    if (!step.optional || step.state !== "pending") {
      throw new Error(`Startup step ${id} cannot be skipped`);
    }
    step.state = "skipped";
    step.finishedAt = this.now();
    this.changed();
    return true;
  }

  fail(id: StartupStepId): boolean {
    if (this.interrupted()) return false;
    const step = this.step(id);
    if (step.state !== "running") return false;
    step.state = "failed";
    step.code = "STARTUP_STEP_FAILED";
    step.finishedAt = this.now();
    if (!step.optional) {
      this.data.state = "failed";
      this.blockUnfinished();
    } else {
      for (const candidate of this.data.steps) {
        if (candidate.state === "pending" && this.dependsOn(candidate.id, id)) {
          candidate.state = "blocked";
          candidate.finishedAt = this.now();
        }
      }
    }
    this.changed();
    return true;
  }

  async run<T>(id: StartupStepId, operation: () => Promise<T>): Promise<T> {
    if (!this.start(id)) throw new StartupInterruptedError();
    try {
      const value = await operation();
      if (!this.succeed(id)) throw new StartupInterruptedError();
      return value;
    } catch (error) {
      this.fail(id);
      throw error;
    }
  }

  /** Called after the listener's dispatcher has activated the authenticated app. */
  ready(): boolean {
    if (this.interrupted()) return false;
    if (this.data.steps.some((step) => !step.optional && step.state !== "succeeded")) {
      throw new Error("Required gateway startup steps are unfinished");
    }
    if (this.data.state === "ready") return true;
    this.data.state = "ready";
    this.changed();
    return true;
  }

  stop(): void {
    if (this.data.state === "stopping") return;
    this.data.state = "stopping";
    this.blockUnfinished();
    this.changed();
  }

  migration(event: StartupMigrationEvent): void {
    if (this.interrupted()) return;
    const step = this.step("storage");
    if (step.state !== "running") return;
    const { current, total, completed } = event;
    if (
      ![current, total, completed].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      current > total ||
      completed > current ||
      (event.phase === "committed" && completed !== current)
    ) {
      throw new Error("Invalid startup migration progress");
    }
    const previous = step.progress;
    if (
      previous &&
      (total !== previous.total || completed < previous.completed || current < previous.current)
    ) {
      throw new Error("Startup migration progress cannot move backwards");
    }
    step.progress = { current, total, completed };
    this.changed();
  }

  private step(id: StartupStepId): StartupStepSnapshot {
    const step = this.data.steps.find((candidate) => candidate.id === id);
    if (!step) throw new Error("Unknown gateway startup step");
    return step;
  }

  private dependsOn(id: StartupStepId, dependency: StartupStepId): boolean {
    return this.step(id).dependsOn.some(
      (parent) => parent === dependency || this.dependsOn(parent, dependency),
    );
  }

  private blockUnfinished(): void {
    for (const step of this.data.steps) {
      if (step.state === "pending" || step.state === "running") {
        step.state = "blocked";
        step.finishedAt = this.now();
      }
    }
  }

  private interrupted(): boolean {
    return this.data.state === "failed" || this.data.state === "stopping";
  }

  private changed(): void {
    this.data.sequence += 1;
  }
}

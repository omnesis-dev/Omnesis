// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The engine is fully inert when experimental mode is off. With experimental
 * mode on, its runtime is prepared once and every task reads model assignment
 * live, allowing hot assignment/removal without duplicate registrations.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SCOPE_READ } from "@omnesis/types";
import { InferenceRegistry } from "../inference/registry.js";
import { createDatabase } from "../db.js";
import { createServer } from "../server.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { directWriteGate } from "../write-gate.js";
import { EventBus } from "../events.js";
import { priorContentRequested } from "../data/document-prior-content.js";
import { briefsFeatureStatus, bootBriefs, BACKGROUND_AGENT_ROLE } from "./feature-gate.js";
import { resolveBrainSettings, type ResolvedBrainSettings } from "./config.js";
import { createDocAnnotation } from "./storage/annotations.js";
import { enqueueCognitionRun } from "./storage/run-queue.js";
import {
  getCognitionEngineState,
  setCognitionEngineState,
  COGNITION_SWEEP_CONFIG_MIGRATED_KEY,
} from "./storage/engine-state.js";
import { SweepService } from "./sweeps/service.js";
import type { AgentEvent, Manifest, ResolvedAssignment } from "@omnesis/core";
import type { ChatBackend, TurnInput } from "@omnesis/agent";
import type { WriteGate } from "../write-gate.js";
import type { TaskContext, TaskOutcome } from "../scheduler/types.js";
import type { BackgroundJob } from "../background-jobs/types.js";
import type Database from "better-sqlite3";

const ENV_KEYS = ["OMNESIS_EXPERIMENTAL", "OMNESIS_SYNTHETIC"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const assignedResolver = {
  resolve: (): ResolvedAssignment => ({
    role: BACKGROUND_AGENT_ROLE,
    kind: "anthropic",
    catalogId: "anthropic/claude-sonnet-4-6",
    apiModelId: "claude-sonnet-4-6",
    // A cloud backend only runs when config permits leaving the machine.
    allowRemoteInference: true,
    available: true,
  }),
};

const unassignedResolver = {
  resolve: (): ResolvedAssignment => ({ role: BACKGROUND_AGENT_ROLE, kind: "disabled" }),
};

function successfulBackend(): ChatBackend {
  return {
    name: "scripted",
    model: "scripted-model",
    async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      yield {
        type: "agent.message.start",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          role: "assistant",
        },
      };
      yield {
        type: "agent.text.delta",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          delta: "No action required.",
        },
      };
      yield {
        type: "agent.message.end",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          stopReason: "end_turn",
        },
      };
    },
  };
}

/** All runtime probes satisfied — the "nothing else is wrong" baseline. */
/** Fixture paths are treated as resolvable; production probes the filesystem. */
const READY_DEPS: ChatRoleReadinessDeps = {
  hasReplayFixture: (fixture) => (fixture ?? "").length > 0,
};

/** Resolve a fixed assignment through the gate, as the composition root does. */
function statusFor(resolved: ResolvedAssignment, deps: ChatRoleReadinessDeps = READY_DEPS) {
  return briefsFeatureStatus({ resolve: () => resolved }, deps);
}

describe("the gate's model-runnable verdict", () => {
  it("counts a chat backend that can actually run as assigned", () => {
    const cases: ResolvedAssignment[] = [
      assignedResolver.resolve(),
      {
        role: BACKGROUND_AGENT_ROLE,
        kind: "http",
        backendKey: "vllm",
        url: "http://localhost:1",
        model: "some-chat-model",
        allowRemoteInference: false,
        available: true,
      },
      {
        role: BACKGROUND_AGENT_ROLE,
        kind: "codex",
        model: "gpt-5.5",
        allowRemoteInference: true,
        available: true,
      },
      { role: BACKGROUND_AGENT_ROLE, kind: "replay", fixture: "fixture.jsonl" },
    ];
    for (const resolved of cases) {
      expect(statusFor(resolved).modelAssigned, resolved.kind).toBe(true);
    }
  });

  it("counts disabled / unresolved / local as not assigned", () => {
    const cases: ResolvedAssignment[] = [
      { role: BACKGROUND_AGENT_ROLE, kind: "disabled" },
      { role: BACKGROUND_AGENT_ROLE, kind: "unresolved", reason: "unknown backend" },
      // Local GGUF chat backends aren't supported for agent roles.
      {
        role: BACKGROUND_AGENT_ROLE,
        kind: "local",
        catalogId: "some-model",
        modelPath: "/nonexistent",
        available: true,
      },
    ];
    for (const resolved of cases) {
      expect(statusFor(resolved).modelAssigned, resolved.kind).toBe(false);
    }
  });

  it("counts a well-formed assignment whose backend cannot run as NOT assigned", () => {
    // The failure this gate exists to prevent: the assignment looks complete
    // on every surface, `resolveRoleBackend` returns null, and the queue parks
    // on every claim with nothing explaining why.
    const unrunnable: ResolvedAssignment[] = [
      // Anthropic assigned, key the registry could not resolve.
      { ...assignedResolver.resolve(), available: false } as ResolvedAssignment,
      // HTTP endpoint unreachable or no model resolved.
      {
        role: BACKGROUND_AGENT_ROLE,
        kind: "http",
        backendKey: "vllm",
        url: "http://localhost:1",
        model: "some-chat-model",
        allowRemoteInference: true,
        available: false,
        reason: 'Backend "vllm" is unreachable',
      },
      // Codex assigned but egress is off — the runtime is never constructed.
      {
        role: BACKGROUND_AGENT_ROLE,
        kind: "codex",
        model: "gpt-5.5",
        allowRemoteInference: false,
        available: true,
      },
      // Replay assigned with no fixture to replay.
      { role: BACKGROUND_AGENT_ROLE, kind: "replay" },
    ];
    for (const resolved of unrunnable) {
      expect(statusFor(resolved).modelAssigned, resolved.kind).toBe(false);
    }
  });

  it("explains why on the status verdict rather than only reporting off", () => {
    const status = statusFor({
      ...assignedResolver.resolve(),
      available: false,
      reason: "Anthropic API key not configured.",
    } as ResolvedAssignment);
    expect(status.modelAssigned).toBe(false);
    expect(status.reason).toMatch(/Anthropic API key/i);
    // A runnable model carries no reason to show.
    expect(briefsFeatureStatus(assignedResolver, READY_DEPS).reason).toBeUndefined();
  });
});

describe("briefsFeatureStatus — the criterion-1 gating matrix", () => {
  it("prong 1: experimental unset + model assigned → inactive", () => {
    const s = briefsFeatureStatus(assignedResolver, READY_DEPS);
    expect(s).toEqual({ visible: false, enabled: false, modelAssigned: true, active: false });
  });

  it("prong 2: experimental on + no model → inactive (the expected live post-merge state)", () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const s = briefsFeatureStatus(unassignedResolver, READY_DEPS);
    expect(s).toEqual({
      visible: true,
      enabled: true,
      modelAssigned: false,
      active: false,
      reason: "No model is assigned to this capability.",
    });
  });

  it("both prongs satisfied → active", () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const s = briefsFeatureStatus(assignedResolver, READY_DEPS);
    expect(s).toEqual({ visible: true, enabled: true, modelAssigned: true, active: true });
  });

  it("synthetic mode makes the feature visible but never active", () => {
    process.env.OMNESIS_SYNTHETIC = "1";
    expect(briefsFeatureStatus(assignedResolver, READY_DEPS)).toEqual({
      visible: true,
      enabled: false,
      modelAssigned: true,
      active: false,
    });
    expect(briefsFeatureStatus(unassignedResolver, READY_DEPS).visible).toBe(true);
  });

  // `enabled` is what separates "this install asked for Briefs and its model is
  // broken" from "this install only previews Briefs". Without it a client
  // cannot tell the two apart — both report visible, unassigned and inactive —
  // and every demo gateway carries a warning for a repair nobody asked for.
  it("distinguishes a switched-on install with no model from a preview-only one", () => {
    process.env.OMNESIS_SYNTHETIC = "1";
    expect(briefsFeatureStatus(unassignedResolver, READY_DEPS).enabled).toBe(false);

    process.env.OMNESIS_EXPERIMENTAL = "1";
    expect(briefsFeatureStatus(unassignedResolver, READY_DEPS).enabled).toBe(true);
  });
});

describe("background-agent role resolution (real registry)", () => {
  let modelsDir: string;
  let configDir: string;

  beforeEach(() => {
    modelsDir = mkdtempSync(join(tmpdir(), "omnesis-briefs-gate-models-"));
    configDir = mkdtempSync(join(tmpdir(), "omnesis-briefs-gate-config-"));
  });

  afterEach(() => {
    rmSync(modelsDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  function makeRegistry(): InferenceRegistry {
    const manifest: Manifest = { version: 1, models: [] };
    return new InferenceRegistry({
      modelsDir,
      configDir,
      manifest: () => manifest,
      hasAnthropicApiKey: () => true,
    });
  }

  it("has NO default assignment — an empty config resolves to disabled", () => {
    const registry = makeRegistry();
    registry.loadConfig({});
    expect(registry.resolve(BACKGROUND_AGENT_ROLE).kind).toBe("disabled");
    process.env.OMNESIS_EXPERIMENTAL = "1";
    expect(briefsFeatureStatus(registry, READY_DEPS).active).toBe(false);
  });

  it("resolves inference.assignments['background-agent'] generically", () => {
    const registry = makeRegistry();
    registry.loadConfig({
      inference: {
        allowRemoteInference: true,
        assignments: { "background-agent": "anthropic/claude-sonnet-4-6" },
      },
    });
    const resolved = registry.resolve(BACKGROUND_AGENT_ROLE);
    expect(resolved.kind).toBe("anthropic");
    process.env.OMNESIS_EXPERIMENTAL = "1";
    expect(briefsFeatureStatus(registry, READY_DEPS)).toEqual({
      visible: true,
      enabled: true,
      modelAssigned: true,
      active: true,
    });
  });

  it("a cloud assignment with egress disabled stays inactive, and says so", () => {
    // Assigning the model is not the same as permitting the call. Reporting
    // ready here would light up every Brain surface over a queue that parks.
    const registry = makeRegistry();
    registry.loadConfig({
      inference: { assignments: { "background-agent": "anthropic/claude-sonnet-4-6" } },
    });
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const status = briefsFeatureStatus(registry, READY_DEPS);
    expect(status.modelAssigned).toBe(false);
    expect(status.active).toBe(false);
    expect(status.reason).toMatch(/allowRemoteInference/);
  });

  it("a dangling assignment resolves unresolved and stays inactive", () => {
    const registry = makeRegistry();
    registry.loadConfig({
      inference: { assignments: { "background-agent": "nosuchbackend/some-model" } },
    });
    expect(registry.resolve(BACKGROUND_AGENT_ROLE).kind).toBe("unresolved");
    process.env.OMNESIS_EXPERIMENTAL = "1";
    expect(briefsFeatureStatus(registry, READY_DEPS).active).toBe(false);
  });
});

describe("bootBriefs — the runtime prepares behind experimental mode", () => {
  function makeDeps(resolver: { resolve: () => ResolvedAssignment }) {
    const setSourceMeta = vi.fn().mockResolvedValue(undefined);
    const writeGate = { setSourceMeta } as unknown as WriteGate;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    return { registry: resolver, readiness: READY_DEPS, writeGate, log, setSourceMeta };
  }

  it("does not seed when experimental is unset (model assigned)", async () => {
    const deps = makeDeps(assignedResolver);
    const status = await bootBriefs(deps);
    expect(status.active).toBe(false);
    expect(deps.setSourceMeta).not.toHaveBeenCalled();
  });

  it("prepares storage when no model is assigned (experimental on)", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const deps = makeDeps(unassignedResolver);
    const status = await bootBriefs(deps);
    expect(status.active).toBe(false);
    expect(deps.setSourceMeta).toHaveBeenCalledTimes(1);
  });

  it("seeds the open-loops source identity when active", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const deps = makeDeps(assignedResolver);
    const status = await bootBriefs(deps);
    expect(status.active).toBe(true);
    expect(deps.setSourceMeta).toHaveBeenCalledTimes(1);
    expect(deps.setSourceMeta).toHaveBeenCalledWith("open-loops", expect.any(Object));
  });
});

describe("bootBriefs — the run-queue drainer follows the live model gate", () => {
  let db: Database.Database;
  let dbPath: string;
  let transcriptsDir: string;

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
    transcriptsDir = mkdtempSync(join(tmpdir(), "omnesis-briefs-boot-"));
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  function makeBootDeps(
    resolver: { resolve: () => ResolvedAssignment },
    getSettings: () => ResolvedBrainSettings = () => resolveBrainSettings(undefined),
  ) {
    const schedule = vi.fn();
    const registerAll = vi.fn();
    const setSourceMeta = vi.fn().mockResolvedValue(undefined);
    // Enough of the write gate for the boot path plus a manually ticked
    // rhythm task (the enqueuers write runs + engine-state markers).
    const writeGate = {
      setSourceMeta,
      enqueueCognitionRun: async (input: Parameters<typeof enqueueCognitionRun>[1], now: number) =>
        enqueueCognitionRun(db, input, now),
      setCognitionEngineState: async (key: string, value: string) =>
        setCognitionEngineState(db, key, value),
    } as unknown as WriteGate;
    const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as Record<
      string,
      unknown
    >;
    child.child = () => child;
    const log = { ...child, child: () => child } as never;
    const runQueue = {
      db,
      scheduler: {
        schedule,
        // Job observation reads (the `state` derivation in observe()).
        snapshot: () => ({ perTask: [] }),
        getLastTickInfo: () => undefined,
      } as never,
      backgroundJobs: { registerAll },
      getSettings,
      resolveBackend: () => null,
      transcriptsDir,
    };
    return {
      deps: { registry: resolver, readiness: READY_DEPS, writeGate, log, runQueue },
      schedule,
      registerAll,
    };
  }

  it("converts brain.sweeps config overrides to files exactly once", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-sweep-migrate-"));
    try {
      const sweeps = new SweepService({
        configDir,
        getScheduleContext: () => ({
          dailyRunHour: 5,
          digestEnabled: false,
          digestHour: 7,
          digestGraceMinutes: 45,
        }),
      });
      const { deps } = makeBootDeps(assignedResolver);
      const booted = {
        ...deps,
        runQueue: { ...deps.runQueue!, sweeps },
        getLegacySweepOverrides: () => ({
          "reading-list": { cadenceHours: 24, steeringPrompt: "Unread saved articles." },
        }),
      };
      await bootBriefs(booted);
      const file = join(configDir, "sweeps", "reading-list.md");
      expect(existsSync(file)).toBe(true);
      expect(getCognitionEngineState(db, COGNITION_SWEEP_CONFIG_MIGRATED_KEY)).toBe("1");

      // The whole point of the marker: deleting a converted file is the
      // operator reverting a sweep, and the next boot must not undo it.
      rmSync(file, { force: true });
      await bootBriefs(booted);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("marks the conversion done even with nothing to convert", async () => {
    // Otherwise every boot re-runs the scan for a key almost nobody set.
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-sweep-migrate-none-"));
    try {
      const { deps } = makeBootDeps(assignedResolver);
      await bootBriefs({
        ...deps,
        runQueue: {
          ...deps.runQueue!,
          sweeps: new SweepService({
            configDir,
            getScheduleContext: () => ({
              dailyRunHour: 5,
              digestEnabled: false,
              digestHour: 7,
              digestGraceMinutes: 45,
            }),
          }),
        },
      });
      expect(getCognitionEngineState(db, COGNITION_SWEEP_CONFIG_MIGRATED_KEY)).toBe("1");
      expect(existsSync(join(configDir, "sweeps"))).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("prong 1 (experimental unset): no tasks scheduled, no jobs registered", async () => {
    const { deps, schedule, registerAll } = makeBootDeps(assignedResolver);
    await bootBriefs(deps);
    expect(schedule).not.toHaveBeenCalled();
    expect(registerAll).not.toHaveBeenCalled();
  });

  it("experimental on with no model: tasks register once but remain live-gated", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const { deps, schedule, registerAll } = makeBootDeps(unassignedResolver);
    await bootBriefs(deps);
    expect(schedule).toHaveBeenCalledTimes(12);
    expect(registerAll.mock.calls.flatMap((call) => call[0] as unknown[])).toHaveLength(12);
  });

  it("active: schedules the drain + rhythm tasks and registers their jobs", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const { deps, schedule, registerAll } = makeBootDeps(assignedResolver);
    await bootBriefs(deps);
    expect(schedule).toHaveBeenCalledTimes(12);
    const names = schedule.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toEqual([
      "cognition.drain",
      "cognition.dailyRhythm",
      "cognition.digest",
      "cognition.decaySweep",
      "cognition.snoozeResurface",
      "cognition.synthesis",
      "cognition.collisionSweep",
      "cognition.sweeps",
      "cognition.mergeAdjudication",
      "cognition.bootstrap",
      "cognition.reverificationSweep",
      "cognition.provenanceRecheck",
    ]);
    expect(registerAll).toHaveBeenCalledTimes(2);
    const registered = registerAll.mock.calls.flatMap((c) => c[0] as unknown[]);
    expect(registered.length).toBe(12);
  });

  it("drains after a hot model assignment and parks again on removal without re-registering", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    let assigned = false;
    const resolver = {
      resolve: (): ResolvedAssignment =>
        assigned
          ? { role: BACKGROUND_AGENT_ROLE, kind: "replay", fixture: "fictional.jsonl" }
          : { role: BACKGROUND_AGENT_ROLE, kind: "disabled" },
    };
    const scheduled: Array<{
      name: string;
      run(args: unknown, ctx: TaskContext): Promise<TaskOutcome<unknown, unknown>>;
    }> = [];
    const scheduler = {
      schedule: vi.fn((task) => {
        scheduled.push(task);
        return { stop: vi.fn() };
      }),
      snapshot: () => ({ perTask: [] }),
      getLastTickInfo: () => undefined,
    } as never;
    const writeGate = directWriteGate(db);
    await bootBriefs({
      registry: resolver,
      readiness: READY_DEPS,
      writeGate,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child() {
          return this;
        },
      } as never,
      runQueue: {
        db,
        scheduler,
        backgroundJobs: { registerAll: vi.fn() },
        getSettings: () => resolveBrainSettings(undefined),
        resolveBackend: () => (assigned ? successfulBackend() : null),
        transcriptsDir,
        clock: () => 1_000,
        promptBuilder: async () => "Evaluate the fictional queued datum.",
      },
    });
    const drains = scheduled.filter((task) => task.name === "cognition.drain");
    expect(drains).toHaveLength(1);
    const drain = drains[0]!;
    const ctx = { signal: new AbortController().signal } as TaskContext;
    enqueueCognitionRun(
      db,
      { id: "run_hot_assignment", kind: "data", payload: { docId: "doc_fictional" } },
      100,
    );

    expect(await drain.run(undefined, ctx)).toEqual({ kind: "done", value: { idle: true } });
    expect(
      db
        .prepare<
          [],
          { status: string; attempts: number }
        >("SELECT status, attempts FROM cognition_runs WHERE id = 'run_hot_assignment'")
        .get(),
    ).toEqual({ status: "pending", attempts: 0 });

    assigned = true;
    expect(await drain.run(undefined, ctx)).toEqual({ kind: "done", value: { idle: false } });
    expect(
      db
        .prepare<
          [],
          { status: string }
        >("SELECT status FROM cognition_runs WHERE id = 'run_hot_assignment'")
        .get()?.status,
    ).toBe("completed");

    enqueueCognitionRun(
      db,
      { id: "run_after_removal", kind: "data", payload: { docId: "doc_fictional_2" } },
      100,
    );
    assigned = false;
    expect(await drain.run(undefined, ctx)).toEqual({ kind: "done", value: { idle: true } });
    expect(
      db
        .prepare<
          [],
          { status: string; attempts: number }
        >("SELECT status, attempts FROM cognition_runs WHERE id = 'run_after_removal'")
        .get(),
    ).toEqual({ status: "pending", attempts: 0 });
    expect(scheduled.filter((task) => task.name === "cognition.drain")).toHaveLength(1);
  });

  it("annotations knob folds into the re-verification gate: annotations off idles the sweep and reports disabled", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    // A stale, never-verified annotation the sweep WOULD pick up if its
    // effective gate were open.
    createDocAnnotation(
      db,
      {
        id: "anno_due",
        docId: "doc_subject",
        claimType: "topic",
        claimText: "an invented stale claim",
        evidenceDocId: "doc_evidence",
        evidenceQuote: "an invented quote",
        confidence: 0.6,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      Date.now() - 60 * 24 * 3_600_000,
    );
    let annotationsEnabled = false;
    const base = resolveBrainSettings(undefined);
    const { deps, schedule, registerAll } = makeBootDeps(assignedResolver, () => ({
      ...base,
      annotations: { ...base.annotations, enabled: annotationsEnabled },
      reverification: { ...base.reverification, enabled: true },
    }));
    await bootBriefs(deps);
    const task = schedule.mock.calls
      .map(
        (c) =>
          c[0] as {
            name: string;
            run: (args: unknown, ctx: TaskContext) => Promise<TaskOutcome<unknown, unknown>>;
          },
      )
      .find((t) => t.name === "cognition.reverificationSweep")!;
    const job = registerAll.mock.calls
      .flatMap((c) => c[0] as BackgroundJob[])
      .find((j) => j.id === "cognition.reverificationSweep")!;
    const ctx = { signal: new AbortController().signal } as TaskContext;
    const verificationRunCount = () =>
      db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM cognition_runs WHERE kind = 'verification'")
        .get()!.n;

    // reverification.enabled=true but annotations.enabled=false: the sweep's
    // runs would target annotation tools excluded from the toolset, so the
    // effective gate is closed — the tick idles, nothing enqueues, and the
    // job surface says "disabled" (one truth for tick gate + isDisabled).
    expect(await task.run(undefined, ctx)).toEqual({ kind: "done", value: { idle: true } });
    expect(verificationRunCount()).toBe(0);
    expect(job.observe().state).toBe("disabled");

    // Flip the annotations layer on (settings re-read live per tick): the
    // same task now fires the sweep and the job stops reporting disabled.
    annotationsEnabled = true;
    expect(await task.run(undefined, ctx)).toEqual({ kind: "done", value: { idle: false } });
    expect(verificationRunCount()).toBe(1);
    expect(job.observe().state).not.toBe("disabled");
  });

  it("off prongs + event bus: no waker subscription, no prior-content interest", async () => {
    const { deps, schedule } = makeBootDeps(assignedResolver);
    (deps.runQueue as { eventBus?: Pick<EventBus, "on"> }).eventBus = new EventBus();
    await bootBriefs(deps);
    expect(schedule).not.toHaveBeenCalled();
    expect(priorContentRequested()).toBe(false);
  });

  // Declared after the off-prong case: an active boot registers
  // process-lifetime prior-content interest (never released — the
  // gateway boots once), so every test asserting "no interest" must
  // run before this one.
  it("active + event bus: also starts the waker and registers prior-content interest", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const { deps, schedule } = makeBootDeps(assignedResolver);
    const bus = new EventBus();
    (deps.runQueue as { eventBus?: Pick<EventBus, "on"> }).eventBus = bus;
    expect(priorContentRequested()).toBe(false);
    await bootBriefs(deps);
    const names = schedule.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toEqual([
      "cognition.drain",
      "cognition.dailyRhythm",
      "cognition.digest",
      "cognition.decaySweep",
      "cognition.snoozeResurface",
      "cognition.synthesis",
      "cognition.collisionSweep",
      "cognition.sweeps",
      "cognition.mergeAdjudication",
      "cognition.bootstrap",
      "cognition.reverificationSweep",
      "cognition.provenanceRecheck",
      "briefs.wakerDrain",
    ]);
    // The diff engine's pre-write body capture is now requested.
    expect(priorContentRequested()).toBe(true);
  });
});

describe("GET /status advertises the brain gate", () => {
  let db: Database.Database;
  let dbPath: string;
  let token: string;
  let sourceRuntimes: Array<{ flushAll(): Promise<void>; dispose(): void }>;

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
    const dev = createDevice(db, { name: `briefs-gate-${randomUUID()}`, kind: "cli" });
    token = createToken(db, dev.id, [SCOPE_READ]).token;
    sourceRuntimes = [];
  });

  afterEach(async () => {
    // createServer boots experimental built-in sources in the background.
    // Quiesce their seed/reconciliation promises before closing SQLite so a
    // late warning cannot outlive Vitest's console interceptor.
    for (const runtime of sourceRuntimes) {
      await runtime.flushAll();
      runtime.dispose();
    }
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });

  function sourceRuntimeHooks() {
    return {
      onOmnesisNotesRuntime: (runtime: { flushAll(): Promise<void>; dispose(): void }) => {
        sourceRuntimes.push(runtime);
      },
      onAgentConversationsRuntime: (runtime: { flushAll(): Promise<void>; dispose(): void }) => {
        sourceRuntimes.push(runtime);
      },
    };
  }

  async function statusBody(app: ReturnType<typeof createServer>): Promise<{
    briefs: { visible: boolean; enabled: boolean; modelAssigned: boolean; active: boolean };
  }> {
    const res = await app.request("/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  it("reports inactive when no gate is wired (test/minimal gateways)", async () => {
    const app = createServer(db, undefined, sourceRuntimeHooks());
    const body = await statusBody(app);
    expect(body.briefs).toEqual({
      visible: false,
      enabled: false,
      modelAssigned: false,
      active: false,
    });
  });

  it("reflects the wired gate verdict per prong", async () => {
    // Prong 1: model assigned, experimental unset.
    let app = createServer(db, undefined, {
      ...sourceRuntimeHooks(),
      getBriefsStatus: () => briefsFeatureStatus(assignedResolver, READY_DEPS),
    });
    expect((await statusBody(app)).briefs).toEqual({
      visible: false,
      enabled: false,
      modelAssigned: true,
      active: false,
    });

    // Prong 2: experimental on, no model.
    process.env.OMNESIS_EXPERIMENTAL = "1";
    app = createServer(db, undefined, {
      ...sourceRuntimeHooks(),
      getBriefsStatus: () => briefsFeatureStatus(unassignedResolver, READY_DEPS),
    });
    // The reason rides all the way out to the client, so a surface can say
    // what to fix instead of rendering a feature that does nothing.
    expect((await statusBody(app)).briefs).toEqual({
      visible: true,
      enabled: true,
      modelAssigned: false,
      active: false,
      reason: "No model is assigned to this capability.",
    });

    // Both satisfied.
    app = createServer(db, undefined, {
      ...sourceRuntimeHooks(),
      getBriefsStatus: () => briefsFeatureStatus(assignedResolver, READY_DEPS),
    });
    expect((await statusBody(app)).briefs).toEqual({
      visible: true,
      enabled: true,
      modelAssigned: true,
      active: true,
    });
  });
});

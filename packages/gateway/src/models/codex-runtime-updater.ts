// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

import { CODEX_RUNTIME_COMPAT, type CodexRuntimeCommandInfo } from "@omnesis/agent";
import {
  createLogger,
  type CodexBackendStatus,
  type CodexRuntimeStatus,
  type CodexRuntimeUpdateOperation,
  type CodexRuntimeUpdatePlan,
  type CodexRuntimeUpdateSnapshot,
} from "@omnesis/core";
import {
  type CodexGenerationSupervisor,
  disposeCodexGeneration,
  type CodexRuntimeGeneration,
} from "./codex-generation-supervisor.js";
import type { CodexRuntimeInstaller, InstalledCodexRuntime } from "./codex-runtime-installer.js";

const log = createLogger("gateway:models:codex:update");

export class CodexRuntimeUpdateConflictError extends Error {
  readonly code = "CODEX_RUNTIME_UPDATE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "CodexRuntimeUpdateConflictError";
  }
}

interface CodexRuntimeUpdaterOptions {
  installer: CodexRuntimeInstaller;
  supervisor: CodexGenerationSupervisor;
  commandOverride?: string;
  refreshTimeoutMs: number;
  createGeneration(commandInfo?: CodexRuntimeCommandInfo): CodexRuntimeGeneration;
  validateGeneration(generation: CodexRuntimeGeneration): Promise<void>;
  describeRuntime(): Promise<CodexRuntimeStatus | undefined>;
  refresh(): Promise<CodexBackendStatus>;
  status(): CodexBackendStatus;
  loginBusy(): boolean;
}

/** Owns managed-runtime selection and the asynchronous update state machine. */
export class CodexRuntimeUpdater {
  private readonly opts: CodexRuntimeUpdaterOptions;
  private disposed = false;
  private selectedRuntimeInitialized = false;
  private selectedRuntimeInFlight: Promise<void> | null = null;
  private updateInFlight: Promise<void> | null = null;
  private updateAbort: AbortController | null = null;
  private cancelRequested = false;
  private operation: CodexRuntimeUpdateOperation | null = null;
  private lastPlan: CodexRuntimeUpdatePlan | null = null;
  private runtimeSelectionError: string | null = null;

  constructor(opts: CodexRuntimeUpdaterOptions) {
    this.opts = opts;
  }

  get isUpdating(): boolean {
    return this.updateInFlight !== null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelRequested = true;
    this.updateAbort?.abort();
    await Promise.all([this.updateInFlight, this.selectedRuntimeInFlight]);
  }

  async ensureSelectedRuntime(): Promise<void> {
    if (this.disposed || this.opts.commandOverride || this.selectedRuntimeInitialized) return;
    if (this.selectedRuntimeInFlight) return this.selectedRuntimeInFlight;
    this.selectedRuntimeInFlight = (async () => {
      try {
        const installed = await this.opts.installer.readActive();
        if (!installed || this.disposed) return;
        await this.opts.supervisor.exclusive(async (previous, replace) => {
          if (this.disposed) return;
          const replacement = this.opts.createGeneration(installed);
          try {
            // A gateway may have stopped after publishing the immutable
            // generation but before the update path validated it against the
            // real shared Codex home. Repeat that validation on every startup
            // before retiring the known-good process generation.
            await this.opts.validateGeneration(replacement);
          } catch (err) {
            await disposeCodexGeneration(replacement);
            await this.opts.installer.rollbackActivation();
            throw err;
          }
          if (this.disposed) {
            await disposeCodexGeneration(replacement);
            return;
          }
          replace(replacement);
          await disposeCodexGeneration(previous);
        });
      } catch (err) {
        this.runtimeSelectionError = conciseError(err);
        log.warn(
          `Gateway-owned Codex runtime could not be selected: ${this.runtimeSelectionError}`,
        );
      } finally {
        this.selectedRuntimeInitialized = true;
        this.selectedRuntimeInFlight = null;
      }
    })();
    return this.selectedRuntimeInFlight;
  }

  async get(): Promise<CodexRuntimeUpdateSnapshot> {
    await this.ensureSelectedRuntime();
    const plan =
      this.updateInFlight && this.lastPlan
        ? this.lastPlan
        : await this.opts.supervisor.use(() => this.computePlan());
    return { plan, operation: this.operationSnapshot() };
  }

  async start(opts: { dryRun: boolean }): Promise<CodexRuntimeUpdateSnapshot> {
    const snapshot = await this.get();
    if (opts.dryRun || !snapshot.plan.canUpdate || snapshot.plan.action === "none") return snapshot;
    if (this.opts.loginBusy()) {
      throw new CodexRuntimeUpdateConflictError(
        "Finish or cancel the Codex login before updating its runtime.",
      );
    }
    if (!this.updateInFlight) {
      this.cancelRequested = false;
      this.updateAbort = new AbortController();
      this.lastPlan = snapshot.plan;
      this.operation = {
        id: randomUUID(),
        state: "checking",
        fromVersion: snapshot.plan.currentVersion,
        toVersion: snapshot.plan.targetVersion ?? CODEX_RUNTIME_COMPAT.testedVersion,
        activeTurns: this.opts.supervisor.activeUses,
        startedAt: new Date().toISOString(),
      };
      this.updateInFlight = Promise.resolve()
        .then(() => this.execute())
        .finally(() => {
          this.updateInFlight = null;
          this.updateAbort = null;
        });
    }
    return { plan: this.lastPlan ?? snapshot.plan, operation: this.operationSnapshot() };
  }

  async cancel(): Promise<CodexRuntimeUpdateSnapshot> {
    if (
      this.operation &&
      (this.operation.state === "checking" ||
        this.operation.state === "downloading" ||
        this.operation.state === "verifying")
    ) {
      this.cancelRequested = true;
      this.updateAbort?.abort();
    } else if (this.operation && !isTerminalState(this.operation.state)) {
      throw new CodexRuntimeUpdateConflictError(
        "The Codex runtime update can no longer be canceled safely.",
      );
    }
    return this.get();
  }

  async computePlan(): Promise<CodexRuntimeUpdatePlan> {
    const common = {
      targetVersion: CODEX_RUNTIME_COMPAT.testedVersion,
      preservesLogin: true as const,
      preservesAssignments: true as const,
      requiresGatewayRestart: false as const,
    };
    let commandInfo: CodexRuntimeCommandInfo;
    try {
      commandInfo = await this.opts.supervisor.current.runtime.resolveCommandInfo();
    } catch (err) {
      return this.remember({
        ...common,
        state: "repair-needed",
        action: "repair",
        canUpdate: true,
        reason: conciseError(err),
      });
    }
    if (commandInfo.source === "override") {
      return this.remember({
        ...common,
        state: "externally-managed",
        action: "external",
        currentVersion: (await this.opts.describeRuntime())?.version,
        canUpdate: false,
        reason: "OMNESIS_CODEX_COMMAND is managed outside Omnesis.",
      });
    }
    if (this.runtimeSelectionError) {
      return this.remember({
        ...common,
        state: "repair-needed",
        action: "repair",
        currentVersion: commandInfo.packageVersion,
        canUpdate: true,
        reason: this.runtimeSelectionError,
      });
    }
    try {
      const currentVersion = (
        await this.opts.supervisor.current.runtime.probeRuntime(this.opts.refreshTimeoutMs)
      ).version;
      const upToDate = currentVersion === CODEX_RUNTIME_COMPAT.testedVersion;
      return this.remember({
        ...common,
        state: upToDate ? "up-to-date" : "update-available",
        action: upToDate ? "none" : "update",
        currentVersion,
        canUpdate: !upToDate,
      });
    } catch (err) {
      return this.remember({
        ...common,
        state: "repair-needed",
        action: "repair",
        currentVersion: commandInfo.packageVersion,
        canUpdate: true,
        reason: conciseError(err),
      });
    }
  }

  private remember(plan: CodexRuntimeUpdatePlan): CodexRuntimeUpdatePlan {
    this.lastPlan = plan;
    return plan;
  }

  private async execute(): Promise<void> {
    const operation = this.operation;
    if (!operation) return;
    let prepared: Awaited<ReturnType<CodexRuntimeInstaller["prepare"]>> | null = null;
    let oldDisposed = false;
    let committed = false;
    let rolledBack = false;
    let rollbackFailed = false;
    let previousInfo: CodexRuntimeCommandInfo | null = null;
    try {
      prepared = await this.opts.installer.prepare(this.updateAbort?.signal, (phase) => {
        operation.state = phase;
      });
      if (this.cancelRequested || this.disposed) {
        await this.opts.installer.discard(prepared);
        prepared = null;
        operation.state = "canceled";
        operation.finishedAt = new Date().toISOString();
        return;
      }

      operation.state = "waiting-for-turns";
      operation.activeTurns = this.opts.supervisor.activeUses;
      await this.opts.supervisor.exclusive(async (previousGeneration, replace) => {
        operation.activeTurns = 0;
        if (this.disposed) throw new Error("Gateway stopped before Codex runtime activation.");
        previousInfo = await previousGeneration.runtime.resolveCommandInfo();
        operation.state = "activating";
        await disposeCodexGeneration(previousGeneration);
        oldDisposed = true;
        try {
          if (this.disposed) throw new Error("Gateway stopped before Codex runtime activation.");
          const installed: InstalledCodexRuntime = await this.opts.installer.commit(prepared!);
          prepared = null;
          committed = true;
          const replacement = this.opts.createGeneration(installed);
          replace(replacement);
          try {
            await this.opts.validateGeneration(replacement);
          } catch (err) {
            await disposeCodexGeneration(replacement);
            throw err;
          }
          this.runtimeSelectionError = null;
        } catch (err) {
          if (committed) {
            try {
              await this.opts.installer.rollbackActivation();
              committed = false;
              rolledBack = true;
            } catch (rollbackError) {
              rollbackFailed = true;
              this.runtimeSelectionError = conciseError(rollbackError);
            }
          }
          if (previousInfo && !this.disposed) replace(this.opts.createGeneration(previousInfo));
          throw err;
        }
      }, this.updateAbort?.signal);

      operation.state = "refreshing-models";
      const previousModels = new Set(this.opts.status().models);
      const status = await this.opts.refresh();
      operation.newModels = status.models.filter((model) => !previousModels.has(model));
      operation.state = "complete";
      operation.finishedAt = new Date().toISOString();
      this.lastPlan = await this.computePlan();
    } catch (err) {
      if (prepared) await this.opts.installer.discard(prepared).catch(() => {});
      if (this.cancelRequested && !oldDisposed) {
        operation.state = "canceled";
        operation.finishedAt = new Date().toISOString();
        return;
      }
      operation.state = rolledBack && oldDisposed ? "rolled-back" : "failed";
      operation.reason = conciseError(err);
      operation.finishedAt = new Date().toISOString();
      if (!rollbackFailed) this.runtimeSelectionError = null;
      this.lastPlan = null;
      log.warn(`Codex runtime update ${operation.state}: ${operation.reason}`);
    }
  }

  private operationSnapshot(): CodexRuntimeUpdateOperation | null {
    if (!this.operation) return null;
    return {
      ...this.operation,
      activeTurns:
        this.operation.state === "waiting-for-turns"
          ? this.opts.supervisor.activeUses
          : this.operation.activeTurns,
      ...(this.operation.newModels ? { newModels: [...this.operation.newModels] } : {}),
    };
  }
}

function conciseError(err: unknown): string {
  const value = err instanceof Error ? err.message : String(err);
  return value.replace(/\s+/g, " ").trim() || "unknown error";
}

function isTerminalState(state: CodexRuntimeUpdateOperation["state"]): boolean {
  return ["complete", "failed", "rolled-back", "canceled"].includes(state);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Ordered transaction for moving an installer-managed checkout to npm. */

import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CliError, EXIT_FAILURE } from "../utils.js";
import {
  serviceGatewayBind,
  serviceGatewayPort,
  serviceUnitReferencesPath,
} from "../service/rebind.js";
import {
  CLI_PACKAGE,
  detectInstallMethod,
  sourceHeadSpec,
  sourceManagedSpec,
  sourceRefShaSpec,
  sourceStatusSpec,
  UPDATE_STATE_FILE,
} from "./detect.js";
import {
  assertFileContent,
  assertFileSnapshot,
  assertOptionalFileSnapshot,
  assertSafeCheckoutRemoval,
  canonicalPackageRoot,
  captureOptionalRegularFile,
  quarantineCheckout,
  replaceFileSnapshot,
  restoreFileSnapshot,
  type FileIdentity,
  type FileSnapshot,
} from "./package-migration-files.js";
import {
  assertCompletedSourceState,
  assertMigrationServiceDefinitions,
  buildMigrationPlan,
  captureMigrationCommand,
  packageInstallSpec,
  packageUninstallSpec,
  printMigrationPlan,
  throwMigrationCommandFailure,
  type MigrationPlan,
} from "./package-migration-plan.js";
import type { ServiceComponent } from "@omnesis/core";
import type {
  MigrationRunControl,
  SourceToPackageDeps,
  SourceToPackageOptions,
} from "./package-migration-types.js";
import type { UpdateSignal } from "./interruption.js";

export { assertSafeCheckoutRemoval } from "./package-migration-files.js";
export {
  canWritePrefix,
  packageInstallSpec,
  packageLauncher,
  packageUninstallSpec,
} from "./package-migration-plan.js";
export type {
  MigrationRunControl,
  MigrationRunner,
  MigrationRunOutcome,
  SourceToPackageDeps,
  SourceToPackageOptions,
} from "./package-migration-types.js";

function assertNoCheckoutReferences(plan: MigrationPlan, deps: SourceToPackageDeps): void {
  if (readFileSync(plan.launcherPath, "utf8").includes(plan.rootDir)) {
    throw new Error("the active PATH launcher still references the source checkout");
  }
  for (const unit of plan.unitChanges) {
    if (serviceUnitReferencesPath(deps.platform, readFileSync(unit.path, "utf8"), plan.rootDir)) {
      throw new Error(`${unit.component} still references the source checkout`);
    }
  }
}

async function restoreMigration(
  plan: MigrationPlan,
  deps: SourceToPackageDeps,
  healthTimeoutMs: number,
  changedUnits: ReadonlyMap<ServiceComponent, FileIdentity>,
  launcherIdentity: FileIdentity | null,
): Promise<string[]> {
  const errors: string[] = [];
  const attempt = async (label: string, action: () => void | Promise<void>): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  if (launcherIdentity) {
    await attempt("source launcher", () =>
      restoreFileSnapshot(
        plan.launcherPath,
        plan.launcherBefore,
        plan.launcherAfter,
        launcherIdentity,
        0o755,
      ),
    );
  }
  const restoredUnits = new Set<ServiceComponent>();
  for (const unit of plan.unitChanges) {
    const afterIdentity = changedUnits.get(unit.component);
    if (!afterIdentity) continue;
    const restored = await attempt(`${unit.component} unit`, () =>
      restoreFileSnapshot(unit.path, unit.before, unit.after, afterIdentity, 0o600),
    );
    if (restored) restoredUnits.add(unit.component);
  }
  let serviceDefinitionsSafe = true;
  try {
    await assertMigrationServiceDefinitions(plan, deps);
  } catch (error) {
    serviceDefinitionsSafe = false;
    errors.push(
      `service-manager definition: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (restoredUnits.has("gateway") && serviceDefinitionsSafe) {
    const gatewayUnit = plan.unitChanges.find((unit) => unit.component === "gateway");
    let rollbackEndpoint: { bind: string; port: number } | null = null;
    let rollbackEnvSnapshot: FileSnapshot | null = null;
    await attempt("gateway endpoint", () => {
      if (!gatewayUnit || !plan.gatewayEnv) throw new Error("gateway rollback plan is incomplete");
      rollbackEnvSnapshot = captureOptionalRegularFile(plan.gatewayEnv.path);
      rollbackEndpoint = {
        bind: serviceGatewayBind(deps.platform, gatewayUnit.before, rollbackEnvSnapshot?.content),
        port: serviceGatewayPort(deps.platform, gatewayUnit.before, rollbackEnvSnapshot?.content),
      };
    });
    await attempt("gateway reload", () => deps.supervisor.reload("gateway"));
    if (plan.gatewayEnv && rollbackEndpoint) {
      await attempt("gateway environment", () =>
        assertOptionalFileSnapshot(plan.gatewayEnv!.path, rollbackEnvSnapshot),
      );
    }
    await attempt("gateway service", () => verifyServiceRunning("gateway", deps, healthTimeoutMs));
    if (rollbackEndpoint) {
      const healthy = await attempt("gateway health", () =>
        deps.awaitHealth(
          plan.version,
          rollbackEndpoint!.bind,
          rollbackEndpoint!.port,
          healthTimeoutMs,
        ),
      );
      if (healthy) {
        await attempt("gateway service after health", () =>
          verifyServiceRunning("gateway", deps, healthTimeoutMs),
        );
      }
    }
  }
  if (restoredUnits.has("collector") && serviceDefinitionsSafe) {
    await attempt("collector reload", () => deps.supervisor.reload("collector"));
    await attempt("collector service", () =>
      verifyServiceRunning("collector", deps, healthTimeoutMs),
    );
  }
  if (!plan.packagePreexisting && errors.length === 0) {
    const referenced = [plan.launcherPath, ...plan.unitChanges.map((unit) => unit.path)].find(
      (path) => {
        try {
          return readFileSync(path, "utf8").includes(plan.packageExecutable);
        } catch {
          return true;
        }
      },
    );
    if (referenced) {
      errors.push(`package cleanup: ${referenced} may still reference the package executable`);
      return errors;
    }
    await attempt("package cleanup", async () => {
      const outcome = await deps.run(packageUninstallSpec(plan.prefix), "inherit");
      if (outcome.code !== 0) throwMigrationCommandFailure("Package cleanup", outcome);
    });
  }
  return errors;
}

async function verifyPackage(
  plan: MigrationPlan,
  deps: SourceToPackageDeps,
  control?: MigrationRunControl,
): Promise<void> {
  if (!existsSync(plan.packageExecutable)) {
    throw new Error(`Package install did not create ${plan.packageExecutable}`);
  }
  const real = realpathSync(plan.packageExecutable);
  const normalized = real.replaceAll("\\", "/");
  const expected = `${canonicalPackageRoot(plan.prefix, CLI_PACKAGE).replaceAll("\\", "/")}/`;
  if (!normalized.startsWith(expected)) {
    throw new Error(
      `${plan.packageExecutable} does not resolve into the installed omnesis package`,
    );
  }
  const detected = detectInstallMethod(plan.packageExecutable);
  if (detected.method !== "npm-global") {
    throw new Error(`${plan.packageExecutable} is not recognized as an npm package install`);
  }
  const answer = await deps.run(
    { command: plan.packageExecutable, args: ["--version"] },
    "capture",
    control,
  );
  if (answer.code !== 0 || answer.stdout.trim() !== plan.version) {
    throw new Error(`${plan.packageExecutable} did not report version ${plan.version}`);
  }
}

async function verifyPathResolution(
  plan: MigrationPlan,
  deps: SourceToPackageDeps,
  control?: MigrationRunControl,
): Promise<void> {
  const resolved = await captureMigrationCommand(
    deps.run,
    { command: "sh", args: ["-c", "command -v omnesis"] },
    "PATH resolution check",
    control,
  );
  if (!isAbsolute(resolved)) {
    throw new Error(`PATH resolved omnesis to non-absolute location '${resolved}'`);
  }
  const candidate = realpathSync(resolved);
  const launcher = realpathSync(plan.launcherPath);
  const packageBin = realpathSync(plan.packageExecutable);
  if (candidate !== launcher && candidate !== packageBin) {
    throw new Error(`PATH resolves omnesis to unrelated executable ${resolved}`);
  }
}

class MigrationInterrupted extends Error {
  constructor(readonly signal: UpdateSignal) {
    super(`Migration interrupted by ${signal}`);
  }
}

function signalExitCode(signal: UpdateSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

function throwIfInterrupted(signal: UpdateSignal | null): void {
  if (signal) throw new MigrationInterrupted(signal);
}

async function verifyServiceRunning(
  component: ServiceComponent,
  deps: SourceToPackageDeps,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = deps.now() + timeoutMs;
  let consecutiveRunning = 0;
  for (;;) {
    if (signal?.aborted) throw new Error(`${component} status wait aborted`);
    const status = await deps.supervisor.status(component);
    if (status.state === "running") {
      consecutiveRunning += 1;
      if (consecutiveRunning >= 2) return;
    } else {
      consecutiveRunning = 0;
      if (status.state === "failed" || status.state === "stopped") {
        throw new Error(`${component} service is ${status.state}, not running`);
      }
    }
    if (deps.now() >= deadline) {
      throw new Error(`${component} service did not remain running before the health timeout`);
    }
    await deps.sleep(Math.min(250, Math.max(1, deadline - deps.now())));
  }
}

/** Execute one ordered migration. The caller owns the host update lock. */
export async function migrateSourceToPackage(
  opts: SourceToPackageOptions,
  deps: SourceToPackageDeps,
): Promise<void> {
  const plan = await buildMigrationPlan(opts, deps);
  printMigrationPlan(plan, opts, deps.log);
  if (opts.dryRun) {
    deps.log("Dry run — nothing executed.");
    return;
  }
  await deps.confirm(`Move this host to ${CLI_PACKAGE}@${plan.version}?`);

  const changedUnits = new Map<ServiceComponent, FileIdentity>();
  let launcherIdentity: FileIdentity | null = null;
  let committed = false;
  const controller = new AbortController();
  let interrupted: UpdateSignal | null = null;
  const releaseInterruption = deps.interruptions.claim((signal) => {
    if (interrupted) return;
    interrupted = signal;
    controller.abort();
  });
  try {
    try {
      deps.updateLock?.setStep(
        plan.packagePreexisting
          ? "verifying existing package release"
          : "installing exact package release",
      );
      if (!plan.packagePreexisting) {
        const install = await deps.run(
          packageInstallSpec(plan.version, plan.prefix, opts.registry),
          "inherit",
          {
            signal: controller.signal,
            onProcessGroup: (pid) => deps.updateLock?.setProcessGroup(pid),
          },
        );
        throwIfInterrupted(interrupted);
        if (install.code !== 0) throwMigrationCommandFailure("Package install", install);
      }
      const runControl: MigrationRunControl = {
        signal: controller.signal,
        onProcessGroup: (pid) => deps.updateLock?.setProcessGroup(pid),
      };
      await verifyPackage(plan, deps, runControl);
      throwIfInterrupted(interrupted);

      // npm may run for minutes, so reject any operator edit since preflight.
      assertFileSnapshot(plan.launcherPath, {
        content: plan.launcherBefore,
        identity: plan.launcherIdentity,
      });
      for (const unit of plan.unitChanges) {
        assertFileSnapshot(unit.path, { content: unit.before, identity: unit.identity });
      }
      if (plan.gatewayEnv) {
        assertOptionalFileSnapshot(plan.gatewayEnv.path, plan.gatewayEnv.snapshot);
      }
      await assertMigrationServiceDefinitions(plan, deps);
      deps.updateLock?.setStep("rebinding supervised services");
      for (const unit of plan.unitChanges) {
        const afterIdentity = replaceFileSnapshot(
          unit.path,
          { content: unit.before, identity: unit.identity },
          unit.after,
          0o600,
        );
        changedUnits.set(unit.component, afterIdentity);
        throwIfInterrupted(interrupted);
      }
      if (deps.roles.gateway.present) {
        const gateway = plan.unitChanges.find((unit) => unit.component === "gateway");
        if (!gateway) throw new Error("gateway service plan is missing");
        assertFileContent(gateway.path, gateway.after);
        if (plan.gatewayEnv) {
          assertOptionalFileSnapshot(plan.gatewayEnv.path, plan.gatewayEnv.snapshot);
        }
        await deps.supervisor.reload("gateway");
        throwIfInterrupted(interrupted);
        await verifyServiceRunning("gateway", deps, opts.healthTimeoutMs, controller.signal);
        throwIfInterrupted(interrupted);
        await deps.awaitHealth(
          plan.version,
          plan.gatewayBind,
          plan.gatewayPort,
          opts.healthTimeoutMs,
          controller.signal,
        );
        throwIfInterrupted(interrupted);
        await verifyServiceRunning("gateway", deps, opts.healthTimeoutMs, controller.signal);
        throwIfInterrupted(interrupted);
        if (plan.gatewayEnv) {
          assertOptionalFileSnapshot(plan.gatewayEnv.path, plan.gatewayEnv.snapshot);
        }
      }
      if (deps.roles.collector.present) {
        const collector = plan.unitChanges.find((unit) => unit.component === "collector");
        if (!collector) throw new Error("collector service plan is missing");
        assertFileContent(collector.path, collector.after);
        await deps.supervisor.reload("collector");
        throwIfInterrupted(interrupted);
        await verifyServiceRunning("collector", deps, opts.healthTimeoutMs, controller.signal);
        throwIfInterrupted(interrupted);
      }

      await assertMigrationServiceDefinitions(plan, deps);

      deps.updateLock?.setStep("switching the PATH launcher");
      launcherIdentity = replaceFileSnapshot(
        plan.launcherPath,
        { content: plan.launcherBefore, identity: plan.launcherIdentity },
        plan.launcherAfter,
        0o755,
      );
      throwIfInterrupted(interrupted);
      if (readFileSync(plan.launcherPath, "utf8") !== plan.launcherAfter) {
        throw new Error(`Could not verify package launcher ${plan.launcherPath}`);
      }
      await verifyPathResolution(plan, deps, runControl);
      throwIfInterrupted(interrupted);
      for (const unit of plan.unitChanges) {
        assertFileContent(unit.path, unit.after);
      }
      assertFileContent(plan.launcherPath, plan.launcherAfter);
      if (plan.gatewayEnv) {
        assertOptionalFileSnapshot(plan.gatewayEnv.path, plan.gatewayEnv.snapshot);
      }
      committed = true;
    } catch (error) {
      if (!committed) {
        const rollbackErrors = await restoreMigration(
          plan,
          deps,
          opts.healthTimeoutMs,
          changedUnits,
          launcherIdentity,
        );
        if (rollbackErrors.length > 0) {
          const failure = error instanceof Error ? error.message : String(error);
          throw new CliError(
            `Migration failed (${failure}), and rollback was incomplete: ${rollbackErrors.join("; ")}`,
            EXIT_FAILURE,
          );
        }
      }
      if (interrupted) {
        throw new CliError(
          `Migration interrupted by ${interrupted}; the source launcher and services were restored.`,
          signalExitCode(interrupted),
        );
      }
      throw error;
    }
  } finally {
    releaseInterruption();
  }

  deps.log(`Migration complete. ${CLI_PACKAGE}@${plan.version} now runs this host.`);
  if (opts.keepCheckout) {
    deps.log(`Source checkout retained at ${plan.rootDir}.`);
    return;
  }
  const remove = await deps.approve(`Remove the retired source checkout at ${plan.rootDir}?`);
  if (!remove) {
    deps.log(`Source checkout retained at ${plan.rootDir}.`);
    return;
  }
  let retiredCheckout: string | null = null;
  let cleanupInterrupted: UpdateSignal | null = null;
  const releaseCleanupInterruption = deps.interruptions.claim((signal) => {
    cleanupInterrupted ??= signal;
  });
  const checkCleanupInterruption = (): void => {
    if (cleanupInterrupted) throw new MigrationInterrupted(cleanupInterrupted);
  };
  try {
    try {
      assertSafeCheckoutRemoval(plan.rootDir, deps.homeDir, deps.configDir, deps.cwd);
      const finalHead = await captureMigrationCommand(
        deps.run,
        sourceHeadSpec(plan.rootDir),
        "Final source-state check",
      );
      checkCleanupInterruption();
      assertCompletedSourceState(deps.configDir, plan.rootDir, finalHead);
      await assertMigrationServiceDefinitions(plan, deps);
      assertNoCheckoutReferences(plan, deps);
      retiredCheckout = quarantineCheckout(plan.rootDir, plan.rootIdentity);
      checkCleanupInterruption();
      const status = await captureMigrationCommand(
        deps.run,
        sourceStatusSpec(retiredCheckout),
        "Final cleanliness check",
      );
      checkCleanupInterruption();
      const managed = await captureMigrationCommand(
        deps.run,
        sourceManagedSpec(retiredCheckout),
        "Final ownership check",
      );
      checkCleanupInterruption();
      const head = await captureMigrationCommand(
        deps.run,
        sourceHeadSpec(retiredCheckout),
        "Final release check",
      );
      checkCleanupInterruption();
      const release = await captureMigrationCommand(
        deps.run,
        sourceRefShaSpec(retiredCheckout, `v${plan.version}`),
        "Final release tag check",
      );
      checkCleanupInterruption();
      if (status || managed !== "managed" || head !== release) {
        throw new Error("the checkout changed after preflight");
      }
      assertNoCheckoutReferences(plan, deps);
    } catch (error) {
      const location = retiredCheckout
        ? `moved tree preserved at ${retiredCheckout}`
        : `checkout remains at ${plan.rootDir}`;
      if (cleanupInterrupted) {
        throw new CliError(
          `Checkout cleanup interrupted by ${cleanupInterrupted}; ${location}.`,
          signalExitCode(cleanupInterrupted),
        );
      }
      throw new CliError(
        `Package migration succeeded, but source checkout cleanup was refused (${String(error)}); ${location}.`,
        EXIT_FAILURE,
      );
    }
    try {
      rmSync(retiredCheckout, { recursive: true });
    } catch (error) {
      throw new CliError(
        `Package migration succeeded, but checkout cleanup did not finish at ${retiredCheckout}: ${String(error)}`,
        EXIT_FAILURE,
      );
    }
    try {
      rmSync(join(deps.configDir, UPDATE_STATE_FILE), { force: true });
    } catch (error) {
      throw new CliError(
        `Package migration and checkout removal succeeded, but the retired source state could not be removed: ${String(error)}`,
        EXIT_FAILURE,
      );
    }
    deps.log(`Removed retired source checkout ${plan.rootDir}.`);
  } finally {
    releaseCleanupInterruption();
  }
}

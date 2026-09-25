// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis update` — one command per host. Updates are always explicit:
 * there is no background update check, no automatic self-update, and no
 * phone-home. The command detects how the CLI was installed and runs the
 * matching upgrade:
 *
 *   npm-global       the channel's dist-tag, then npm install -g
 *   source checkout  newest stable vX.Y.Z tag, then npm ci + build
 *   docker           newest published release as an image tag, then compose pull
 *
 * It then does whatever this host's roles need, in an order that matters.
 * On a gateway host the backup is taken through the gateway API before
 * anything irreversible happens; the gateway restarts and has to answer
 * `/health` — proving its forward-only migrations finished — before the
 * collector it serves is restarted. A host that only collects just restarts
 * its collector. A host with an agent-harness integration refreshes the
 * installed plugin and asks before restarting the harness, because that
 * interrupts a running agent.
 *
 * If the build fails, or the gateway never comes back, the installation is
 * returned to the ref it was running and restarted there: a half-applied
 * update is the failure mode this command exists to remove.
 *
 * Only the first half runs in the build already installed: resolving the
 * target and putting its code in place. Once that apply succeeds and the
 * target is a release that knows how (`../update/continuation.ts`), the rest —
 * a backup that can wait for it, the restarts, the health wait, the harness
 * refresh, the completion record and any rollback — is handed, with the host
 * update lock, to the `omnesis update` the apply installed, so a fix to those
 * steps applies to the update that delivers it.
 *
 * `--channel stable|beta` picks the dist-tag a package install tracks and
 * `--registry` points it at a registry other than the default; both are
 * meaningless for a source checkout, which resolves tags from its own origin,
 * and for a container install, which resolves images from a container
 * registry. `--edge` follows the main branch — `origin/main` for a source
 * checkout, the `main` image tag for a container install — and is refused on
 * a package install, since a branch has no published package. `--dry-run`
 * prints the plan without mutating anything, `--yes` skips every prompt
 * (required when stdin/stdout aren't TTYs), and `--no-backup` skips the
 * pre-update backup on a gateway host.
 *
 * Pure logic (detection, channel mapping, version compare, host roles, the
 * ordered plan and its rollback) lives in `../update/detect.ts`; this file
 * owns process spawning, the gateway API calls, prompts, and console output.
 * The flow functions take their effects as an injected `UpdateFlowDeps` so
 * tests drive them with a fake runner and a fake supervisor.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defineCommand } from "citty";
import {
  acquireUpdateLock,
  adoptUpdateLock,
  atomicWriteFileSync,
  compareProductVersions,
  assertNever,
  DEFAULT_CONFIG_DIR,
  ensureGatewayTrust,
  readPackageVersion,
  SOURCE_COMMIT_PATTERN,
  UPDATE_LOCK_ENV,
  UpdateLockBusyError,
  updateLockHolderLabel,
  waitForUpdateLock,
  type UpdateLock,
  type FleetUpdateOutcome,
  type FleetUpdatePlan,
  type ServiceComponent,
} from "@omnesis/core";
import { upsertDotEnv } from "@omnesis/config";
import {
  c,
  CliError,
  EXIT_CANCELLED,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  gatewayJson,
  GATEWAY_REQUEST_URL,
} from "../utils.js";
import { HARNESSES, type Harness } from "../harness-skills.js";
// The supervisor and `runBackup` below are imported eagerly rather than
// lazily: the update runs `npm ci` in the very tree this process loads from,
// so a module first resolved after that would be resolved against a
// node_modules the install has just rewritten.
import {
  hardenedGatewayUpdateCommand,
  repositoryNeedsCredential,
  updateTarget,
} from "../service/hardened-bootstrap.js";
import { createSupervisor } from "../service/supervisor.js";
import { stableNodeBinDir } from "../service/node-bin-dir.js";
import {
  serviceDefinitionUpdater,
  type ServiceDefinitionOutcome,
  type ServiceDefinitionUpdater,
} from "../update/service-definitions.js";
import {
  assertImageTag,
  assessDockerApplyEvidence,
  assessSourceApplyEvidence,
  assessUpdate,
  channelToDistTag,
  CLI_PACKAGE,
  completedDockerApplyState,
  detectDockerInstall,
  detectDockerRoles,
  detectHostRoles,
  detectInstallMethod,
  DOCKER_ENV_FILE,
  dockerApplyPlan,
  dockerRestartSpec,
  formatCommandSpec,
  harnessRefreshSpec,
  harnessRestartSpec,
  IMAGE_TAG_KEY,
  isResolvedVersion,
  isUpToDate,
  manualAuthorizeCommand,
  manualRestartCommand,
  manualUpdateInstructions,
  newestStableTag,
  normalizeVersion,
  npmGlobalApplyPlan,
  npmViewVersionSpec,
  packageIndexUrl,
  planHostUpdate,
  planUpdate,
  readImageTag,
  runsInstalledBuild,
  serializeUpdateApplyState,
  sourceAncestrySpec,
  sourceLeftBehindSpec,
  sourceIsShallowSpec,
  sourceMergeBaseSpec,
  sourceApplyPlan,
  sourceFetchSpec,
  sourceFetchCommitSpec,
  sourceHeadSpec,
  sourceManagedSpec,
  sourceRefShaSpec,
  sourceRemoteTagsSpec,
  sourceStatusSpec,
  sourceTargetVersionSpec,
  sourceUpdateSpecs,
  stableTagForVersion,
  UPDATE_CHANNELS,
  UPDATE_STATE_FILE,
  versionFromStableTag,
  type ApplyPlan,
  type CommandSpec,
  type HostPlanOptions,
  type HostRoles,
  type InstallMethod,
  type UpdateApplyState,
  type UpdateChannel,
  type UpdateStep,
} from "../update/detect.js";
import {
  acceptContinuation,
  applyPlanForSubject,
  claimContinuation,
  CONTINUATION_SUBCOMMAND,
  ContinuationRefused,
  continuationCommand,
  continuationTarget,
  deferredBackupFor,
  handOverAfterApply,
  installedPackageEntry,
  launchContinuation,
  orderForHandoff,
  planForSubject,
  supportsContinuation,
  type ContinuationOffer,
  type ContinuationOutcome,
  type ContinuationSubject,
  type InstallTarget,
  type SignalRelay,
  type UpdateContinuation,
} from "../update/continuation.js";
import { reportHarnessUpdateResult, type HarnessUpdateResult } from "../update/harness-report.js";
import {
  gatewayRunning,
  gatewayStartedAt,
  packageInstalledAt,
  processStartedAt,
  sourceInstalledAt,
  takeOfflineGatewayBackup,
  type OfflineBackupOutcome,
} from "../update/host-state.js";
import {
  type UpdateInterruptionRouter,
  type UpdateSignal,
  updateInterruptionRouter,
} from "../update/interruption.js";
import { prepareSourceRecoveryLauncher } from "../update/source-launcher.js";
import { buildHeapEnv, buildMemoryTight } from "../update/build-heap.js";
import {
  buildToolsInstallCommand,
  buildToolsRefusal,
  missingBuildTools,
  nodeBuildToolProbe,
  type BuildTool,
} from "../update/build-tools.js";
import { adoptSourceCheckout } from "../update/source-adoption.js";
import { canWritePrefix, migrateSourceToPackage } from "../update/package-migration.js";
import {
  FleetUpdateRefused,
  fleetUpdateSucceeded,
  runFleetUpdate,
  type FleetUpdateSummary,
} from "../update/fleet.js";
import { runBackup } from "./backup.js";
import type { Writable } from "node:stream";

// ── Exec seam ───────────────────────────────────────────────────────────

export interface RunOutcome {
  code: number;
  /** The signal that ended the process, when one did. */
  signal?: NodeJS.Signals | null;
  stdout: string;
}

/**
 * Run one command. `"capture"` pipes stdout for parsing (the npm view
 * query); `"inherit"` streams everything to the user's terminal (the
 * update commands themselves). Resolves with the exit code — callers decide
 * what a non-zero code means. Rejects only when the process can't spawn.
 */
export interface RunControl {
  signal?: AbortSignal;
  onProcessGroup?(pid: number | null): void;
}

export type CommandRunner = (
  spec: CommandSpec,
  mode: "capture" | "inherit",
  control?: RunControl,
) => Promise<RunOutcome>;

function signalChildTree(
  child: ChildProcess,
  groupPid: number | null,
  signal: NodeJS.Signals,
): void {
  if (groupPid !== null) {
    try {
      process.kill(-groupPid, signal);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child already exited between the caller's check and this signal.
  }
}

function processGroupExists(groupPid: number): boolean {
  try {
    process.kill(-groupPid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroup(groupPid: number): Promise<void> {
  while (processGroupExists(groupPid)) {
    await delay(10);
  }
}

export const spawnRunner: CommandRunner = (spec, mode, control) =>
  new Promise((resolve, reject) => {
    // A controlled update command uses a fresh POSIX process group so aborting
    // npm or Compose also reaches lifecycle scripts, shells, and workers. A
    // pipe gate keeps that group from executing until its identity has been
    // durably published in the host lock. Windows retains direct-child
    // behavior.
    const grouped = control?.signal !== undefined && process.platform !== "win32";
    const command = grouped ? "/bin/sh" : spec.command;
    const args = grouped
      ? [
          "-c",
          'if IFS= read -r _ <&3; then exec "$@"; else exit 125; fi',
          "omnesis-update-gate",
          spec.command,
          ...spec.args,
        ]
      : spec.args;
    const child = spawn(command, args, {
      cwd: spec.cwd,
      ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}),
      stdio: grouped
        ? mode === "capture"
          ? ["ignore", "pipe", "inherit", "pipe"]
          : ["inherit", "inherit", "inherit", "pipe"]
        : mode === "capture"
          ? ["ignore", "pipe", "inherit"]
          : "inherit",
      detached: grouped,
    });
    const gate = grouped ? (child.stdio[3] as Writable | null) : null;
    gate?.on("error", () => {
      // A killed or failed child can close the gate before it is opened.
    });
    const groupPid = grouped && child.pid !== undefined ? child.pid : null;
    let aborted = false;
    let publicationError: unknown = null;
    let escalation: NodeJS.Timeout | null = null;
    let stdout = "";
    const abort = (): void => {
      if (aborted) return;
      aborted = true;
      signalChildTree(child, groupPid, "SIGTERM");
      // npm should get a short chance to forward TERM and clean up, but an
      // unresponsive group leader must not prevent rollback indefinitely.
      escalation = setTimeout(() => signalChildTree(child, groupPid, "SIGKILL"), 2_000);
      escalation.unref();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", (err) => {
      // Aborting a spawned process emits `error` before `close`. Keep the
      // promise pending until close so rollback never races a still-running
      // npm install or build. Ordinary spawn failures can reject at once.
      if (aborted || publicationError) return;
      try {
        control?.onProcessGroup?.(null);
      } catch (clearError) {
        publicationError = clearError;
      }
      reject(publicationError ?? err);
    });
    child.on("close", (code, signal) => {
      control?.signal?.removeEventListener("abort", abort);
      void (async () => {
        if ((aborted || publicationError) && groupPid !== null) {
          await waitForProcessGroup(groupPid);
        }
        try {
          control?.onProcessGroup?.(null);
        } catch (err) {
          publicationError ??= err;
        }
        if (escalation) clearTimeout(escalation);
        if (publicationError) reject(publicationError);
        else resolve({ code: code ?? 1, signal, stdout });
      })();
    });
    try {
      control?.onProcessGroup?.(groupPid);
    } catch (err) {
      publicationError = err;
      signalChildTree(child, groupPid, "SIGKILL");
    }
    if (!publicationError) {
      control?.signal?.addEventListener("abort", abort, { once: true });
      if (control?.signal?.aborted) abort();
      if (!aborted) gate?.end("go\n");
    }
  });

export interface UpdateApplyStateStore {
  read(): string | null;
  write(state: UpdateApplyState): void;
}

function updateApplyStateStore(configDir: string): UpdateApplyStateStore {
  const path = join(configDir, UPDATE_STATE_FILE);
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    write: (state) => {
      atomicWriteFileSync(path, serializeUpdateApplyState(state), {
        ensureDir: true,
        mode: 0o600,
      });
    },
  };
}

/** Effects the update flows need — injected so tests can fake them. */
export interface UpdateFlowDeps {
  run: CommandRunner;
  /** Completion proof for installer-managed source and container applies. */
  applyState: UpdateApplyStateStore;
  /** Signal ownership transferred while an apply and what follows it are mutable. */
  interruptions: UpdateInterruptionRouter;
  /** Install the source launcher that remains runnable through npm ci. */
  prepareSourceLauncher?(rootDir: string): void | Promise<void>;
  /** The environment a source build runs with: the heap sized for this machine. */
  buildEnv?(): Record<string, string> | undefined;
  /** Version of the running CLI (`readPackageVersion`). */
  currentVersion: string;
  /**
   * False when this run restarts nothing itself (`--no-restart`). One flag for
   * the whole run: the plan's steps and the rollback's revive both read it
   * from here, so they cannot disagree about whether this host restarts
   * anything.
   */
  restart?: boolean;
  /**
   * The root command that moves this host's dedicated gateway to the update's
   * target. It reads the checkout and asks the repository whether a token is
   * needed, so tests supply their own.
   */
  hardenedGatewayCommand?(expectVersion: string | null, adminInstalled: boolean): string;
  /**
   * Record a harness plugin's update result on the gateway, as that harness's
   * device, so it outlives this terminal. Absent on hosts with no harness.
   */
  reportHarnessResult?(harness: Harness, result: HarnessUpdateResult): Promise<void>;
  /** Resolves when the user approved the update; throws `CliError` otherwise. */
  confirm(message: string): Promise<void>;
  /** A skippable interruption: resolves true to go ahead, false to skip it. */
  approve(message: string): Promise<boolean>;
  /** What this host runs, as read off the host. */
  roles: HostRoles;
  /** Take an online pre-update backup through the gateway's API. */
  backup(note: string, purpose: "pre-update"): Promise<void>;
  /**
   * Copy the closed stores of this host's gateway into a backup, for a
   * gateway role known not to be running. Absent where no local copy is
   * possible; the online backup is then the only one.
   */
  offlineBackup?(note: string, purpose: "pre-update"): Promise<OfflineBackupOutcome>;
  /**
   * Whether a present daemon started from the build installed now, asked only
   * by a run that applies nothing. Null when that cannot be told.
   */
  runsInstalledBuild?(component: ServiceComponent): Promise<boolean | null>;
  /** Restart one Omnesis daemon through its service manager. */
  restartService(component: ServiceComponent): Promise<void>;
  /**
   * Stop one of this account's daemons so a build has the machine's memory,
   * and start it again after; starting leaves a daemon already running alone.
   * Absent where the update never stops a daemon for its build.
   */
  stopService?(component: ServiceComponent): Promise<void>;
  startService?(component: ServiceComponent): Promise<void>;
  /** Whether the build leaves this machine no memory for a running collector. */
  buildMemoryTight?(): boolean;
  /**
   * The native-build tools this machine is missing, and the command that
   * installs them. Absent where nothing is built from source.
   */
  missingBuildTools?(): { missing: BuildTool[]; installCommand: string | null };
  /**
   * The unit files `omnesis service install` wrote for this account's
   * daemons, brought to this build's generator ahead of their restarts and put
   * back by a rollback. Absent where no launchd or systemd unit runs them.
   */
  serviceDefinitions?: ServiceDefinitionUpdater;
  /**
   * Resolve once the gateway answers `/health` again — and, when a version
   * is known, once it reports that version, so a still-draining old process
   * cannot be mistaken for the new one.
   */
  awaitHealth(expectVersion: string | null, signal?: AbortSignal): Promise<void>;
  /**
   * The version the gateway serves right now, or null when it does not
   * answer. A container install whose record predates completion tracking
   * asks this before trusting the tag on file.
   */
  servedVersion?(): Promise<string | null>;
  /**
   * Point the installation at the version an apply plan names, before that
   * plan's commands run. A docker install resolves its images from a tag
   * recorded beside the compose file, so the tag is written first and written
   * back by the rollback. The source and package flows carry their target in
   * the commands themselves and leave this undefined.
   */
  select?(version: string): Promise<void>;
  /** Newest published version for a dist-tag, for installs with no npm binary. */
  latestPublished?(distTag: string): Promise<string>;
  /**
   * How to invoke this CLI again for the harness refresh. `process.argv[1]`
   * is the TypeScript entry point on a source install and cannot be spawned,
   * so this is the name the installer put on PATH.
   */
  cliPath: string;
  /** Host-wide update transaction, when this is an apply rather than a preview. */
  updateLock?: Pick<UpdateLock, "setProcessGroup" | "setStep" | "reclaim">;
  /**
   * Run the installed build's `omnesis update` on the steps after a successful
   * apply, relaying this process's signals to it, and report whether it took
   * them. Absent where every step runs in this process.
   */
  continueAfterApply?(offer: ContinuationOffer, relay: SignalRelay): Promise<ContinuationOutcome>;
}

async function runStep(deps: UpdateFlowDeps, spec: CommandSpec): Promise<RunOutcome> {
  try {
    return await deps.run(spec, "inherit");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `${c.red}Failed to run \`${formatCommandSpec(spec)}\`: ${msg}${c.reset}`,
      EXIT_FAILURE,
    );
  }
}

/** Run one command, turning a spawn failure into a non-zero outcome. */
async function attempt(
  deps: UpdateFlowDeps,
  spec: CommandSpec,
  control?: RunControl,
): Promise<RunOutcome> {
  try {
    return await deps.run(spec, "inherit", control);
  } catch (err) {
    return { code: 1, stdout: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether a dependency install or build was killed outright — by the kernel,
 * almost always, for want of memory. npm reports a killed child as exit 137.
 */
function killedBuildStep(spec: CommandSpec, outcome: RunOutcome): boolean {
  const step = spec.args.join(" ");
  return (
    spec.command === "npm" &&
    (step === "ci" || step === "run build") &&
    (outcome.signal === "SIGKILL" || outcome.code === 137)
  );
}

function applyFailure(spec: CommandSpec, outcome: RunOutcome): string {
  return killedBuildStep(spec, outcome)
    ? `\`${formatCommandSpec(spec)}\` was killed (${outcome.signal ?? `exit ${outcome.code}`}), ` +
        `most likely because this machine ran out of memory.`
    : `\`${formatCommandSpec(spec)}\` failed (exit ${outcome.code}).`;
}

const KILLED_BUILD_REMEDY =
  "To update, stop this machine's collector and gateway first (`omnesis service stop collector`, " +
  "`omnesis service stop gateway`), add swap, or free memory, then run `omnesis update`.";

/**
 * This account's daemons an update stopped so a build had the machine's
 * memory, and their way back. Each is started again once that build is done —
 * unless a rollback did not finish: until the update does, the source launcher
 * refuses to start any daemon, so they stay stopped for `omnesis update`, which
 * restarts them.
 */
class StoppedForBuild {
  private readonly stopped = new Set<ServiceComponent>();
  private held = false;

  constructor(private readonly deps: UpdateFlowDeps) {}

  get components(): ServiceComponent[] {
    return [...this.stopped];
  }

  async stop(component: ServiceComponent): Promise<void> {
    if (!this.deps.stopService || !this.deps.startService || this.stopped.has(component)) return;
    try {
      await this.deps.stopService(component);
      this.stopped.add(component);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.log(`${c.yellow}! Could not stop the ${component}: ${detail}.${c.reset}`);
    }
  }

  /** Started again by the step or the rollback that restarts it. */
  forget(component: ServiceComponent): void {
    this.stopped.delete(component);
  }

  /** Leave them stopped: the rollback did not finish. */
  hold(): void {
    this.held = true;
  }

  async startAll(): Promise<void> {
    if (this.held || !this.deps.startService) return;
    for (const component of this.components) {
      this.stopped.delete(component);
      try {
        await this.deps.startService(component);
        console.log(`${c.green}✔${c.reset} Started the ${component} again.`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.log(
          `${c.yellow}! The ${component} did not start again: ${detail}. ` +
            `Run ${c.bold}${manualRestartCommand(component)}${c.reset}${c.yellow}.${c.reset}`,
        );
      }
    }
  }
}

/** What a rollback knows about the memory the build it undoes had. */
interface RollbackMemory {
  /** Daemons stopped for a build: stopped for the rebuild too, and brought back. */
  daemons?: StoppedForBuild;
  /** The apply's install or build was killed, most likely for want of memory. */
  killed?: boolean;
  /** The plan stopped the collector because the build is short of memory. */
  pausedForBuild?: boolean;
}

// ── The per-host plan ───────────────────────────────────────────────────

/** One line of the plan, as the operator reads it before confirming. */
function describeStep(step: UpdateStep, targetLabel: string): string {
  switch (step.kind) {
    case "backup":
      return step.offline
        ? "back up the gateway's databases by copying them, since it is not running"
        : "back up the gateway's databases through its API";
    case "pause-collector":
      return "stop the collector while the build runs, so the build has this machine's memory, and start it again after";
    case "apply":
      return `move this installation to ${targetLabel}`;
    case "service-definition":
      return `rewrite the ${step.component}'s service definition where ${targetLabel} changes it`;
    case "restart":
      return `restart the ${step.component}`;
    case "await-health":
      return "wait for the gateway to serve again (schema migrations run at boot)";
    case "restart-hint":
      return step.uncertain
        ? `report that the ${step.component} may need restarting by hand`
        : `report that the ${step.component} needs restarting by hand`;
    case "gateway-stopped":
      return "note that the stopped gateway migrates its databases when it next starts";
    case "harness-refresh":
      return `refresh the ${step.harness} plugin`;
    case "harness-authorize":
      return `report that the ${step.harness} integration needs re-authorizing`;
    case "harness-restart":
      return `offer to restart ${step.harness}`;
    case "harness-restart-hint":
      return `report that ${step.harness} needs restarting to load the new plugin`;
    default:
      return assertNever(step);
  }
}

/**
 * Return the installation to what it was running, then fail. Called when the
 * apply sequence failed or the gateway never came back: leaving new code on
 * disk with nothing serving it is worse than either outcome on its own.
 *
 * `booted` says whether the new gateway got as far as opening the store. If
 * it did, its forward-only migrations may already have run, and the restored
 * build meets a schema ahead of it — which it survives by clearing the sync
 * cursors that schema wrote, so those sources resync. The operator is told
 * that, and told that the backup taken minutes earlier is the exact way back.
 */
async function rollBackAndFail(
  applyPlan: ApplyPlan,
  deps: UpdateFlowDeps,
  reason: string,
  booted = false,
  exitCode = EXIT_FAILURE,
  memory: RollbackMemory = {},
): Promise<never> {
  const { daemons, killed = false } = memory;
  deps.updateLock?.setStep("rolling back");
  console.log();
  console.log(`${c.red}${reason}${c.reset}`);
  console.log(`${c.yellow}Rolling back to ${applyPlan.previous}.${c.reset}`);

  let rollbackStateError: string | null = null;
  if (applyPlan.applyState) {
    try {
      deps.applyState.write(applyPlan.applyState.rollingBack);
    } catch (err) {
      rollbackStateError = err instanceof Error ? err.message : String(err);
    }
  }

  await deps.select?.(applyPlan.previous);
  // The previous build runs under the unit it was installed with, so a unit
  // this run rewrote goes back before anything of that build starts again.
  const restoredDefinitions = await restoreServiceDefinitions(deps);
  // The rebuild needs the memory the build lacked. A run that restarts nothing
  // stops nothing either: there this command is the collector's child.
  if (daemons && deps.restart !== false && (killed || memory.pausedForBuild)) {
    const { gateway, collector } = deps.roles;
    let stopping: ServiceComponent[] = [];
    // A running gateway is stopped only once a build was killed beside it.
    if (killed && gateway.present && gateway.supervised && !gateway.hardened && !gateway.stopped) {
      stopping.push("gateway");
    }
    if (collector.present && collector.supervised) stopping.push("collector");
    // One the plan already stopped for the build is still stopped.
    stopping = stopping.filter((component) => !daemons.components.includes(component));
    if (stopping.length > 0) {
      console.log(
        `Stopping the ${stopping.join(" and ")} so the rebuild has this machine's memory…`,
      );
      for (const component of stopping) await daemons.stop(component);
    }
  }
  for (const spec of applyPlan.rollback) {
    console.log(`${c.dim}$ ${formatCommandSpec(spec)}${c.reset}`);
    // The transaction signal is already aborted; rollback is the recovery
    // work that must still run after the interrupted process tree is gone.
    const result = await attempt(deps, spec, {});
    if (result.code !== 0) {
      daemons?.hold();
      const left = daemons?.components ?? [];
      const stoppedNote =
        left.length > 0
          ? ` The ${left.join(" and ")} stopped for the rebuild ${left.length > 1 ? "stay" : "stays"} ` +
            `stopped until the update finishes, and \`omnesis update\` starts ` +
            `${left.length > 1 ? "them" : "it"} again.`
          : "";
      throw new CliError(
        `${c.red}${reason}\nThe rollback also failed at \`${formatCommandSpec(spec)}\`` +
          (killedBuildStep(spec, result)
            ? `, which was killed too, most likely because this machine ran out of memory. ` +
              `Stop the collector and gateway, then run \`omnesis update\` to finish the recovery.`
            : `. This installation may be built inconsistently — re-run that command by hand ` +
              `and check its output.`) +
          `${stoppedNote}${
            rollbackStateError
              ? ` The update state also could not be recorded: ${rollbackStateError}.`
              : ""
          }${c.reset}`,
        EXIT_FAILURE,
      );
    }
  }

  if (applyPlan.applyState) {
    try {
      deps.applyState.write(applyPlan.applyState.rolledBack);
      rollbackStateError = null;
    } catch (err) {
      rollbackStateError = err instanceof Error ? err.message : String(err);
    }
  }

  // Bring the restored build back up. Best effort: the operator is already
  // being told the update failed, and a supervisor error here must not
  // replace that message with a less useful one. A run that restarts nothing
  // does not start here either — on such a host this command is a child of
  // the very daemon it would restart.
  // A dedicated gateway runs its own release, which this account's update never
  // touched, so there is nothing of it to restart here.
  if (deps.restart === false && deps.roles.gateway.present && !deps.roles.gateway.hardened) {
    // Named the way the plan's own hints name it: a role that carries its own
    // command owns the restart (a container is recreated), and a supervised
    // one without falls back to the canonical service command.
    const how =
      deps.roles.gateway.manualRestart ??
      (deps.roles.gateway.supervised ? manualRestartCommand("gateway") : null);
    console.log(
      `${c.yellow}! ${applyPlan.previous} is on disk again, but the gateway was not restarted ` +
        `by this run.${how ? ` Restart it with ${c.bold}${how}${c.reset}${c.yellow}.` : ""}${c.reset}`,
    );
  } else if (deps.roles.gateway.present && deps.roles.gateway.supervised) {
    try {
      await (restoredDefinitions.includes("gateway") && deps.serviceDefinitions
        ? deps.serviceDefinitions.reload("gateway")
        : deps.restartService("gateway"));
      // The version being restored is the one this command started from, so
      // demanding it is what distinguishes "the old build is serving again"
      // from "the process answering is still the new one".
      await deps.awaitHealth(normalizeVersion(deps.currentVersion));
      console.log(`${c.green}✔${c.reset} ${applyPlan.previous} is serving again.`);
    } catch {
      console.log(
        `${c.yellow}! Rolled back to ${applyPlan.previous}, but the gateway did not come back. ` +
          `Check ${c.bold}omnesis service status${c.reset}${c.yellow}.${c.reset}`,
      );
    }
  }
  daemons?.forget("gateway");
  if (booted) {
    console.log(
      `${c.yellow}! The new build had already opened the store, so its forward-only migrations ` +
        `may have run. The restored build clears the sync cursors that newer schema wrote and ` +
        `those sources resync; restore the backup taken at the start of this run if you need ` +
        `the exact prior state (${c.bold}omnesis backup --list${c.reset}${c.yellow}, then ` +
        `${c.bold}omnesis restore <backup-dir> --force${c.reset}${c.yellow}).${c.reset}`,
    );
  }

  if (rollbackStateError) {
    throw new CliError(
      `${c.red}${reason} Rolled back to ${applyPlan.previous}, but could not record the ` +
        `completed rollback: ${rollbackStateError}. The next update will safely rebuild it.` +
        `${killed ? ` ${KILLED_BUILD_REMEDY}` : ""}${c.reset}`,
      EXIT_FAILURE,
    );
  }

  throw new CliError(
    `${c.red}${reason} Rolled back to ${applyPlan.previous}.${killed ? ` ${KILLED_BUILD_REMEDY}` : ""}${c.reset}`,
    exitCode,
  );
}

function signalExitCode(signal: UpdateSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

/**
 * Bring one daemon's service definition to the build running this step, ahead
 * of the restart that loads it. Never fails the update: a unit that cannot be
 * rewritten without losing something is left as it is and named, with the
 * command that writes the release's own. Returns whether the unit was rewritten.
 */
async function applyServiceDefinition(
  component: ServiceComponent,
  targetLabel: string,
  restartFollows: boolean,
  deps: UpdateFlowDeps,
): Promise<boolean> {
  const definitions = deps.serviceDefinitions;
  if (!definitions) return false;
  let outcome: ServiceDefinitionOutcome;
  try {
    outcome = await definitions.refresh(component);
  } catch (err) {
    outcome = { kind: "refused", reason: err instanceof Error ? err.message : String(err) };
  }
  if (outcome.kind === "unchanged") return false;
  if (outcome.kind === "refused") {
    console.log(
      `${c.yellow}! The ${component}'s service definition was left as it is: ${outcome.reason}. ` +
        `${c.bold}omnesis service install ${component}${c.reset}${c.yellow}, with the flags it was ` +
        `installed with, writes the one ${targetLabel} generates.${c.reset}`,
    );
    return false;
  }
  console.log(
    `${c.green}✔${c.reset} Rewrote the ${component}'s service definition for ${targetLabel}.`,
  );
  if (restartFollows) return true;
  // Nothing in this run restarts it — on a commanded device this process is
  // its child — so the manager reads the unit now, for the restart it is owed.
  try {
    console.log(
      (await definitions.loadDefinition(component))
        ? `${c.dim}The service manager has read it; the ${component} runs under it from its next restart.${c.reset}`
        : `${c.dim}launchd loads it at the next login, or when the ${component} is next stopped and started.${c.reset}`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(
      `${c.yellow}! The service manager did not read it yet: ${detail}. It applies once the ` +
        `manager reloads its units.${c.reset}`,
    );
  }
  return true;
}

/** Put back the units this run rewrote, for a rollback; returns whose it restored. */
async function restoreServiceDefinitions(deps: UpdateFlowDeps): Promise<ServiceComponent[]> {
  if (!deps.serviceDefinitions) return [];
  try {
    const restored = await deps.serviceDefinitions.restore();
    for (const component of restored) {
      console.log(`${c.dim}Put back the ${component}'s previous service definition.${c.reset}`);
    }
    return restored;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(
      `${c.yellow}! Could not put back the previous service definition: ${detail}.${c.reset}`,
    );
    return [];
  }
}

/**
 * Refresh one harness's installed plugin. A failure here never fails the
 * update: the harness is a consumer of this gateway, not part of it, and the
 * operator can re-run the one command the message names.
 */
async function refreshHarness(
  harness: Harness,
  targetVersion: string | null,
  deps: UpdateFlowDeps,
): Promise<boolean> {
  const spec = harnessRefreshSpec(harness, deps.cliPath);
  console.log(`${c.dim}$ ${formatCommandSpec(spec)}${c.reset}`);
  const result = await attempt(deps, spec);
  if (result.code !== 0) {
    console.log(
      `${c.yellow}! The ${harness} plugin was not refreshed. Run ` +
        `${c.bold}${manualAuthorizeCommand(harness)}${c.reset}${c.yellow} yourself — ` +
        `until then ${harness} runs the previous plugin against the updated gateway.${c.reset}`,
    );
    await recordHarnessResult(harness, targetVersion, deps, {
      state: "failed",
      detail: `Plugin refresh failed on its host (${formatCommandSpec(spec)} exited ${result.code}); ${harness} still runs the previous plugin.`,
    });
    return false;
  }
  await recordHarnessResult(harness, targetVersion, deps, {
    state: "restart-pending",
    detail: `Plugin ${targetVersion ?? "from the current build"} installed; restart owed: ${formatCommandSpec(harnessRestartSpec(harness))}`,
  });
  return true;
}

/**
 * Put a harness plugin's update result on its device row, against the
 * version this run installed: the release the update targeted, which is the
 * plugin `connect --refresh` packs from it. An edge build has no release
 * version to report, so nothing is recorded and the operator is told. Best
 * effort otherwise: the gateway being unreachable from here must not turn a
 * finished update into a failed one, so a report that cannot be delivered is
 * said and let go.
 */
async function recordHarnessResult(
  harness: Harness,
  targetVersion: string | null,
  deps: UpdateFlowDeps,
  result: Omit<HarnessUpdateResult, "version">,
): Promise<void> {
  if (!deps.reportHarnessResult) return;
  if (targetVersion === null) {
    console.log(
      `${c.dim}An edge build has no release version to record the ${harness} plugin's update against; ` +
        `\`omnesis devices list\` will not show it.${c.reset}`,
    );
    return;
  }
  try {
    await deps.reportHarnessResult(harness, { version: targetVersion, ...result });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(
      `${c.dim}Could not record the ${harness} plugin's update on the gateway (${detail}); ` +
        `\`omnesis devices list\` will not show it.${c.reset}`,
    );
  }
}

/**
 * Restart a harness after its plugin changed, having asked first. Omnesis
 * does not supervise these processes — the harness owns that surface — so a
 * missing binary or an unknown subcommand is not a failure; it is the point
 * at which the operator is told exactly what to run.
 */
async function restartHarness(
  harness: Harness,
  targetVersion: string | null,
  deps: UpdateFlowDeps,
): Promise<void> {
  const manual = `Restart ${harness} to load the refreshed plugin (it reads its config and plugins at startup).`;
  const approved = await deps.approve(
    `Restart ${harness} now? This interrupts any run it is in the middle of.`,
  );
  if (!approved) {
    console.log(`${c.dim}${manual}${c.reset}`);
    return;
  }
  const spec = harnessRestartSpec(harness);
  console.log(`${c.dim}$ ${formatCommandSpec(spec)}${c.reset}`);
  const result = await attempt(deps, spec);
  if (result.code !== 0) {
    console.log(`${c.yellow}! Could not restart ${harness}. ${manual}${c.reset}`);
    await recordHarnessResult(harness, targetVersion, deps, {
      state: "restart-pending",
      detail: `Plugin ${targetVersion ?? "from the current build"} installed; the restart failed on its host (${formatCommandSpec(spec)} exited ${result.code}), so it is still owed.`,
    });
  }
}

/**
 * The real `hardenedGatewayCommand`: the update's target, or this checkout's
 * commit for an edge update, and a token clause only while the repository
 * refuses an anonymous read.
 */
function defaultHardenedGatewayCommand(
  currentVersion: string,
): (expectVersion: string | null, adminInstalled: boolean) => string {
  return (expectVersion, adminInstalled) =>
    hardenedGatewayUpdateCommand(
      updateTarget(expectVersion, currentVersion),
      adminInstalled,
      repositoryNeedsCredential(),
    );
}

/** Where one run of a host plan starts, and whether it hands over. */
interface HostPlanPhase {
  /** Offered to the installed build once the apply succeeds. */
  offer?: ContinuationOffer;
  /**
   * This process is the installed build continuing an update: the apply was
   * run, and its record written, by the process that offered the rest.
   */
  applied?: boolean;
}

/**
 * Run the ordered plan. Everything before the apply step is reversible on its
 * own; from the apply step on, a failure — a backup deferred behind the apply
 * included — goes through `rollBackAndFail`. With `phase.offer`, the steps
 * after a successful apply are offered to the build it installed; with
 * `phase.applied`, this process is that build and starts at the apply another
 * process ran.
 */
async function executeHostPlan(
  steps: readonly UpdateStep[],
  applyPlan: ApplyPlan,
  targetLabel: string,
  expectVersion: string | null,
  deps: UpdateFlowDeps,
  phase: HostPlanPhase = {},
): Promise<void> {
  // A harness whose plugin could not be reinstalled has nothing new to load,
  // so its restart — which interrupts a running agent — is skipped.
  const unrefreshed = new Set<Harness>();
  // Daemons whose unit this run rewrote: their restart has to load it.
  const rewritten = new Set<ServiceComponent>();
  const applyState = applyPlan.apply.length > 0 || phase.applied ? applyPlan.applyState : undefined;
  const applyIndex = steps.findIndex((step) => step.kind === "apply");
  const daemons = new StoppedForBuild(deps);
  const pausedForBuild = steps.some((step) => step.kind === "pause-collector");
  const rollBack = (
    reason: string,
    booted = false,
    exitCode: number = EXIT_FAILURE,
    killed = false,
  ): Promise<never> =>
    rollBackAndFail(applyPlan, deps, reason, booted, exitCode, { daemons, killed, pausedForBuild });

  // The transaction: from the first thing that moves the host to the point
  // of no return, which is the gateway serving the target — the health wait
  // when the plan has one, the gateway's restart when it does not, and the
  // apply, or a backup waiting behind it, when this run restarts nothing.
  // Signals in that span go back the same way a failure does. After it, a
  // migrated gateway is the half worth keeping: a signal stops the run the
  // ordinary way and the collector is reported, as it is when its restart
  // fails.
  const lastIndex = (pick: (step: UpdateStep) => boolean): number => {
    for (let index = steps.length - 1; index >= 0; index -= 1)
      if (pick(steps[index]!)) return index;
    return -1;
  };
  const commitIndex = [
    lastIndex((step) => step.kind === "await-health"),
    lastIndex((step) => step.kind === "restart" && step.component === "gateway"),
    lastIndex((step) => step.kind === "apply" || step.kind === "backup"),
  ].find((index) => index >= 0);

  const controller = new AbortController();
  let interrupted: UpdateSignal | null = null;
  let release: (() => void) | null = null;
  let committed = false;
  const onSignal = (signal: UpdateSignal): void => {
    if (interrupted) return;
    interrupted = signal;
    controller.abort();
  };
  const rollBackIfInterrupted = async (booted: boolean): Promise<void> => {
    if (!interrupted || committed) return;
    await rollBack(`Update interrupted by ${interrupted}.`, booted, signalExitCode(interrupted));
  };
  const commit = (): void => {
    committed = true;
    // Only a plan whose gateway was restarted sees it on the new image; one
    // that restarts nothing leaves the record unfinished for the next run to
    // verify.
    const point = steps[commitIndex!]?.kind;
    if (applyState?.completeAt === "end" && (point === "await-health" || point === "restart")) {
      // The gateway answered on the new image: only now does the recorded
      // tag mean an update that finished.
      try {
        deps.applyState.write(applyState.complete);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.log(
          `${c.yellow}! Updated to ${targetLabel}, but its completion could not be recorded: ` +
            `${detail}. The next update will verify what is served before trusting the recorded tag.${c.reset}`,
        );
      }
    }
    release?.();
    release = null;
  };

  try {
    for (const [index, step] of steps.entries()) {
      deps.updateLock?.setStep(describeStep(step, targetLabel));
      switch (step.kind) {
        case "pause-collector": {
          console.log(
            "Stopping the collector while the build runs, so the build has this machine's memory; " +
              "it starts again once the new build is in place.",
          );
          await daemons.stop("collector");
          break;
        }
        case "backup": {
          // Past the apply, a backup that cannot be taken undoes the apply:
          // nothing has restarted yet, so the host returns to exactly what it
          // ran. Before it, nothing has changed and the refusal alone stands.
          const afterApply = applyIndex >= 0 && index > applyIndex;
          const backupFailure = async (reason: string, booted = false): Promise<CliError> => {
            if (afterApply) await rollBack(reason, booted);
            return new CliError(`${c.red}${reason}${c.reset}`, EXIT_FAILURE);
          };
          const when = afterApply ? `before restarting onto ${targetLabel}` : "before updating";
          if (afterApply) await rollBackIfInterrupted(false);
          const note = `pre-update ${normalizeVersion(deps.currentVersion)} to ${targetLabel}`;
          let taken = false;
          if (step.offline && deps.offlineBackup) {
            let outcome: OfflineBackupOutcome;
            try {
              outcome = await deps.offlineBackup(note, "pre-update");
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              throw await backupFailure(
                `Could not copy the stopped gateway's databases into a backup ${when}: ${detail}\n` +
                  `This upgrade runs forward-only schema migrations, so the backup is the only way ` +
                  `back. Fix the cause and run the update again, or pass --no-backup to accept that risk.`,
              );
            }
            if (outcome.kind === "copied") {
              console.log(
                `${c.green}✔${c.reset} The gateway on this host is not running, so its databases were copied into ${outcome.path}.`,
              );
              taken = true;
            } else if (outcome.kind === "nothing-to-copy") {
              console.log(
                `${c.dim}The gateway on this host is not running and has no databases yet — nothing to back up.${c.reset}`,
              );
              taken = true;
            } else if (afterApply) {
              // It started while the target was being put in place, so it may
              // be running that target already, over stores it has migrated.
              throw await backupFailure(
                `The gateway on this host started while ${targetLabel} was being installed, so it may ` +
                  `already run the new build and have migrated its databases. No pre-update backup was taken.`,
                true,
              );
            }
            // Otherwise a gateway started since the plan was made; it takes the backup.
          }
          if (!taken) {
            try {
              await deps.backup(note, "pre-update");
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              throw await backupFailure(
                `Could not take a backup through ${GATEWAY_REQUEST_URL} ${when}: ${detail}\n` +
                  `This upgrade runs forward-only schema migrations, so the backup is the only way ` +
                  `back. Check that the gateway is running and that OMNESIS_GATEWAY_URL names it, ` +
                  `or pass --no-backup to accept that risk.`,
              );
            }
          }
          if (afterApply) await rollBackIfInterrupted(false);
          if (index === commitIndex) commit();
          break;
        }
        case "apply": {
          release = deps.interruptions.claim(onSignal);
          if (phase.applied) {
            // The offering process put the target in place and recorded it;
            // from here its way back is this process's to take.
            await rollBackIfInterrupted(false);
            if (index === commitIndex) commit();
            break;
          }
          // The record goes down before anything moves — before the tag a
          // container install pulls from is rewritten — so a process killed
          // from here on leaves proof that this apply began and did not end.
          if (applyState) {
            try {
              deps.applyState.write(applyState.applying);
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              throw new CliError(
                `${c.red}Could not record the update before changing the installation: ${detail}${c.reset}`,
                EXIT_FAILURE,
              );
            }
          }
          await deps.select?.(applyPlan.target);
          for (const spec of applyPlan.apply) {
            await rollBackIfInterrupted(false);
            console.log(`${c.dim}$ ${formatCommandSpec(spec)}${c.reset}`);
            const result = await attempt(deps, spec, {
              signal: controller.signal,
              onProcessGroup: (pid) => deps.updateLock?.setProcessGroup(pid),
            });
            await rollBackIfInterrupted(false);
            if (result.code !== 0) {
              await rollBack(
                applyFailure(spec, result),
                false,
                EXIT_FAILURE,
                killedBuildStep(spec, result),
              );
            }
          }
          if (applyState?.completeAt === "apply") {
            try {
              deps.applyState.write(applyState.complete);
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              await rollBack(
                `The source build finished, but its completion could not be recorded: ${detail}.`,
              );
            }
          }
          console.log(
            applyPlan.apply.length === 0
              ? `${c.green}✔${c.reset} Already on ${targetLabel}.`
              : `${c.green}✔${c.reset} Updated to ${targetLabel}.`,
          );
          // A collector no later step restarts comes back once the build is in place.
          if (
            !steps.some(
              (later, at) =>
                at > index && later.kind === "restart" && later.component === "collector",
            )
          ) {
            await daemons.startAll();
          }
          if (index === commitIndex) commit();
          if (phase.offer && deps.continueAfterApply && applyPlan.apply.length > 0) {
            release?.();
            release = null;
            const handed = await handOverAfterApply({
              offer: phase.offer,
              continueAfterApply: deps.continueAfterApply,
              interruptions: deps.interruptions,
              ...(deps.updateLock ? { lock: deps.updateLock } : {}),
              targetLabel,
            });
            if (handed.finished) return;
            if (!committed) release = deps.interruptions.claim(onSignal);
            if (handed.signal) {
              if (committed) throw new CliError("", signalExitCode(handed.signal));
              onSignal(handed.signal);
              await rollBackIfInterrupted(false);
            }
          }
          break;
        }
        case "service-definition": {
          await rollBackIfInterrupted(false);
          const restartFollows = steps.some(
            (later, at) =>
              at > index && later.kind === "restart" && later.component === step.component,
          );
          if (await applyServiceDefinition(step.component, targetLabel, restartFollows, deps)) {
            rewritten.add(step.component);
          }
          break;
        }
        case "restart": {
          await rollBackIfInterrupted(true);
          console.log(`Restarting the ${step.component}…`);
          try {
            await (rewritten.has(step.component) && deps.serviceDefinitions
              ? deps.serviceDefinitions.reload(step.component)
              : deps.restartService(step.component));
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            if (step.component === "gateway") {
              // A restart fails when the unit never starts, and equally when it
              // starts, migrates, and then exits — so the store may be open.
              await rollBack(`The gateway would not restart: ${detail}`, true);
            }
            // A collector that will not restart leaves the gateway serving the
            // new build, which is the half worth keeping. Say so rather than
            // undoing an upgrade that succeeded.
            console.log(
              `${c.yellow}! The ${step.component} did not restart: ${detail}. ` +
                `Run ${c.bold}${manualRestartCommand(step.component)}${c.reset}${c.yellow}.${c.reset}`,
            );
          }
          daemons.forget(step.component);
          await rollBackIfInterrupted(true);
          if (index === commitIndex) commit();
          break;
        }
        case "await-health": {
          await rollBackIfInterrupted(true);
          try {
            await deps.awaitHealth(expectVersion, controller.signal);
          } catch (err) {
            await rollBackIfInterrupted(true);
            const detail = err instanceof Error ? err.message : String(err);
            // The process started; only its health is unproven, so the store
            // may already be migrated.
            await rollBack(`The gateway did not come back: ${detail}`, true);
          }
          console.log(`${c.green}✔${c.reset} Gateway is serving again.`);
          if (index === commitIndex) commit();
          break;
        }
        case "restart-hint": {
          const hardened = step.component === "gateway" ? deps.roles.gateway.hardened : undefined;
          if (hardened) {
            // A dedicated gateway runs from a release root owns, which this
            // account's update does not touch; root moves it to the target.
            console.log(
              `${c.yellow}! The dedicated gateway on this host still runs its own release. Move it to ` +
                `${targetLabel} as root with ${c.bold}` +
                `${(deps.hardenedGatewayCommand ?? defaultHardenedGatewayCommand(deps.currentVersion))(expectVersion, hardened.adminInstalled)}` +
                `${c.reset}${c.yellow}.${c.reset}`,
            );
            break;
          }
          const how = step.command
            ? `Restart it with ${c.bold}${step.command}${c.reset}${c.yellow}.`
            : `It is not registered as a service here, so restart it the way you started it.`;
          console.log(
            `${c.yellow}! The ${step.component} on this host ${step.uncertain ? "may still run" : "still runs"} the previous build. ${how}${c.reset}`,
          );
          break;
        }
        case "gateway-stopped": {
          console.log(
            `${c.dim}The gateway on this host is not running, so nothing serves the previous build; ` +
              `its databases migrate to ${targetLabel} when it next starts.${c.reset}`,
          );
          break;
        }
        case "harness-refresh": {
          if (await refreshHarness(step.harness, expectVersion, deps)) {
            console.log(`${c.green}✔${c.reset} Refreshed the ${step.harness} plugin.`);
          } else {
            unrefreshed.add(step.harness);
          }
          break;
        }
        case "harness-authorize": {
          console.log(
            `${c.yellow}! The ${step.harness} integration needs a browser to re-authorize, which ` +
              `this update will not do unattended. Run ` +
              `${c.bold}${manualAuthorizeCommand(step.harness)}${c.reset}${c.yellow} and approve it ` +
              `in the portal.${c.reset}`,
          );
          break;
        }
        case "harness-restart": {
          if (!unrefreshed.has(step.harness)) {
            await restartHarness(step.harness, expectVersion, deps);
          }
          break;
        }
        case "harness-restart-hint": {
          if (!unrefreshed.has(step.harness)) {
            console.log(
              `${c.yellow}! ${step.harness} is still running the previous plugin. Restart it with ` +
                `${c.bold}${step.command}${c.reset}${c.yellow} when the agent is idle.${c.reset}`,
            );
          }
          break;
        }
        default:
          assertNever(step);
      }
    }
  } finally {
    release?.();
    await daemons.startAll();
  }
}

/**
 * The offer an apply makes to the build it installs, or undefined when this
 * run finishes every step itself: there is nothing to hand to, or the target
 * is a release too old to take it.
 */
function continuationOffer(
  deps: UpdateFlowDeps,
  subject: ContinuationSubject,
  targetVersion: string | null,
  steps: readonly UpdateStep[],
): ContinuationOffer | undefined {
  if (!deps.continueAfterApply || !supportsContinuation(targetVersion)) return undefined;
  return {
    subject,
    targetVersion: normalizeVersion(targetVersion),
    previousVersion: normalizeVersion(deps.currentVersion),
    deferredBackup: deferredBackupFor(subject.method, deps.roles.gateway, steps),
    restart: deps.restart !== false,
  };
}

/** The backup a hand-over would defer, for a plan printed before its offer exists. */
function handoffBackup(
  deps: UpdateFlowDeps,
  method: ContinuationSubject["method"],
  targetVersion: string | null,
  steps: readonly UpdateStep[],
): ReturnType<typeof deferredBackupFor> {
  return deps.continueAfterApply && supportsContinuation(targetVersion)
    ? deferredBackupFor(method, deps.roles.gateway, steps)
    : null;
}

/**
 * Finish an update whose apply the previous build ran: the installed build's
 * half of a hand-over. The plan is this build's own reading of the host, the
 * apply plan and its rollback are rebuilt from what the offer says was
 * installed, and a backup the offer deferred runs first, ahead of any restart.
 */
export async function runUpdateContinuation(
  offer: ContinuationOffer,
  deps: UpdateFlowDeps,
): Promise<void> {
  const { label, expectVersion } = continuationTarget(offer.subject);
  const steps = orderForHandoff(
    planHostUpdate(deps.roles, {
      backup: offer.deferredBackup !== null,
      restart: deps.restart,
      serviceDefinitions: deps.serviceDefinitions !== undefined,
    }),
    offer.deferredBackup,
  );
  console.log(`Continuing the update to ${c.bold}${label}${c.reset} with its own updater.`);
  await executeHostPlan(
    steps,
    applyPlanForSubject(offer.subject, deps.buildEnv?.()),
    label,
    expectVersion,
    deps,
    { applied: true },
  );
}

/**
 * For a run that applies nothing: whether each present daemon already runs the
 * installed build, so the plan claims no restart that is not owed.
 */
async function runningBuilds(deps: UpdateFlowDeps): Promise<HostPlanOptions["runningBuild"]> {
  if (!deps.runsInstalledBuild) return undefined;
  const known: NonNullable<HostPlanOptions["runningBuild"]> = {};
  for (const component of ["gateway", "collector"] as const) {
    if (deps.roles[component].present) known[component] = await deps.runsInstalledBuild(component);
  }
  return known;
}

function printPlan(steps: readonly UpdateStep[], targetLabel: string): void {
  console.log("This host will:");
  for (const step of steps) {
    console.log(`  ${c.cyan}-${c.reset} ${describeStep(step, targetLabel)}`);
  }
}

/**
 * Hold the host lock around one complete local transaction, never a preview.
 *
 * With `waitForLockMs`, another update holding the lock is waited for rather
 * than refused: the lock is tried again until that update releases it or is
 * proven dead, for at most that long. `waitedMs` tells the action a wait
 * happened, since the update it waited for may already have changed the
 * installation. A lock handed over by the process that started this one is
 * adopted and never waited for.
 *
 * `continuation` is the installed build finishing an update another process
 * applied. It runs only on the lock that process handed over, and returns it
 * to that process rather than past it, because the offering process still has
 * work of its own after this one exits.
 */
export async function runWithUpdateLock<T>(
  configDir: string,
  dryRun: boolean,
  action: (lock: UpdateLock | undefined, context: { waitedMs: number }) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    waitForLockMs?: number;
    sleep?: (ms: number) => Promise<void>;
    continuation?: boolean;
  } = {},
): Promise<T> {
  if (dryRun) return action(undefined, { waitedMs: 0 });
  const handedOffId = env[UPDATE_LOCK_ENV]?.trim();
  if (opts.continuation && !handedOffId) {
    throw new CliError(
      `${c.red}An update continuation runs only on the lock the update it continues handed over.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const acquire = (): UpdateLock =>
    acquireUpdateLock(configDir, {
      owner: "operator update",
      currentStep: "resolving target",
    });
  let lock: UpdateLock;
  let waitedMs = 0;
  try {
    if (handedOffId) {
      lock = adoptUpdateLock(
        configDir,
        handedOffId,
        opts.continuation
          ? { owner: "Omnesis update (installed build)", returnToHolder: true }
          : { owner: "Omnesis update" },
      );
    } else if (opts.waitForLockMs) {
      ({ lock, waitedMs } = await waitForUpdateLock(acquire, {
        waitMs: opts.waitForLockMs,
        onWaiting: (holder) =>
          console.log(
            `Waiting for ${holder ? updateLockHolderLabel(holder) : "another Omnesis update"} to finish…`,
          ),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
      }));
    } else {
      lock = acquire();
    }
  } catch (err) {
    if (err instanceof UpdateLockBusyError) {
      throw new CliError(`${c.red}${err.message}${c.reset}`, EXIT_USER_ERROR);
    }
    throw err;
  }
  let result: T;
  try {
    result = await action(lock, { waitedMs });
  } catch (err) {
    // The action's own failure is what the caller must see; a lock that could
    // not be returned as well is said, not substituted for it.
    try {
      finishLock(lock, handedOffId !== undefined && handedOffId !== "", opts.continuation);
    } catch (lockErr) {
      const detail = lockErr instanceof Error ? lockErr.message : String(lockErr);
      console.log(`${c.yellow}! The host update lock could not be returned: ${detail}${c.reset}`);
    }
    throw err;
  }
  finishLock(lock, handedOffId !== undefined && handedOffId !== "", opts.continuation);
  return result;
}

/** Return an adopted lock to the process it came from, or release one this process took. */
function finishLock(lock: UpdateLock, handedOff: boolean, continuation = false): void {
  if (!handedOff) {
    lock.release();
    return;
  }
  try {
    lock.handBack(continuation ? "finishing the update" : undefined);
  } finally {
    lock.release();
  }
}

/**
 * Refuse a target version that is not a release. The string reaches a git ref
 * and an npm install spec, so its shape is checked at every entry point
 * rather than trusted from one.
 */
function assertPinnedTarget(targetVersion: string | undefined): void {
  if (targetVersion === undefined) return;
  if (!isResolvedVersion(targetVersion)) {
    throw new CliError(
      `${c.red}Invalid target version '${targetVersion}' — expected a release like 1.2.3.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
}

// ── npm-global flow ─────────────────────────────────────────────────────

export async function updateNpmGlobal(
  opts: {
    channel: UpdateChannel;
    registry?: string;
    dryRun: boolean;
    force?: boolean;
    backup?: boolean;
    /**
     * An exact version to move to instead of whatever the channel points at.
     * Resolved through the registry like any other target, so a version that
     * was never published fails here rather than reaching `npm install`.
     */
    targetVersion?: string;
    /**
     * This run waited for another update on the host. An install that is
     * already on the target then still gets the rest of its host plan — the
     * harness plugin refreshed, the daemons reported — because that other
     * update was not necessarily run for this host's roles.
     */
    afterConcurrentUpdate?: boolean;
  },
  deps: UpdateFlowDeps,
): Promise<string | null> {
  // A pinned target is looked up as itself; the channel's dist-tag is only
  // consulted when no version was named. Validated here rather than only at
  // the command's own boundary, because this value becomes part of an npm
  // install spec and this flow is exported.
  assertPinnedTarget(opts.targetVersion);
  const tag = opts.targetVersion
    ? normalizeVersion(opts.targetVersion)
    : channelToDistTag(opts.channel);
  const viewSpec = npmViewVersionSpec(tag, opts.registry);

  let view: RunOutcome;
  try {
    view = await deps.run(viewSpec, "capture");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `${c.red}Failed to run \`${formatCommandSpec(viewSpec)}\`: ${msg}${c.reset}`,
      EXIT_FAILURE,
    );
  }
  if (view.code !== 0 || !view.stdout.trim()) {
    throw new CliError(
      `${c.red}Could not resolve ${CLI_PACKAGE}@${tag}` +
        `${opts.registry ? ` from ${opts.registry}` : ""} — check the channel and registry.${c.reset}`,
      EXIT_FAILURE,
    );
  }

  const target = normalizeVersion(view.stdout);
  // Everything downstream treats this as a version: it is compared, shown to
  // the user, and passed to npm as an install spec. Anything else is a broken
  // registry answer, not something to act on.
  if (!isResolvedVersion(target)) {
    throw new CliError(
      `${c.red}\`${formatCommandSpec(viewSpec)}\` did not return a version: ${target}${c.reset}`,
      EXIT_FAILURE,
    );
  }
  // A pinned target must come back as itself. The registry answering with
  // anything else means the version asked for is not the version that would
  // be installed, which is exactly the substitution this refusal exists for.
  if (opts.targetVersion && target !== normalizeVersion(opts.targetVersion)) {
    throw new CliError(
      `${c.red}${CLI_PACKAGE}@${normalizeVersion(opts.targetVersion)} resolves to ${target}. ` +
        `Refusing to install a version other than the one asked for.${c.reset}`,
      EXIT_FAILURE,
    );
  }
  if (isUpToDate(deps.currentVersion, target)) {
    if (!opts.afterConcurrentUpdate) {
      console.log(`Already up to date (${normalizeVersion(deps.currentVersion)}).`);
      return target;
    }
    const steps = planHostUpdate(deps.roles, {
      backup: false,
      restart: deps.restart,
      runningBuild: await runningBuilds(deps),
      serviceDefinitions: deps.serviceDefinitions !== undefined,
    });
    console.log(
      `Another update on this host already installed ${target} — nothing to install, ` +
        `and no backup taken since nothing irreversible follows.`,
    );
    printPlan(steps, target);
    await executeHostPlan(
      steps,
      { ...npmGlobalApplyPlan(target, target, opts.registry), apply: [] },
      target,
      target,
      deps,
    );
    return target;
  }

  // Installed by exact version, not by dist-tag: everything the user was shown
  // and confirmed — the target, the upgrade/downgrade verdict, the --force
  // guard — is about the version `npm view` just resolved. A dist-tag that
  // moves between the two calls would otherwise deliver something else.
  const applyPlan = npmGlobalApplyPlan(
    target,
    normalizeVersion(deps.currentVersion),
    opts.registry,
  );
  const assessment = assessUpdate(deps.currentVersion, target);
  const arrow = assessment.direction === "downgrade" ? "↓" : "→";
  console.log(
    `${assessment.direction === "downgrade" ? "Downgrade" : "Update"} on the ${opts.channel} channel: ` +
      `${c.bold}${assessment.current}${c.reset} ${arrow} ${c.bold}${target}${c.reset}`,
  );
  console.log(`Will run: ${c.cyan}${formatCommandSpec(applyPlan.apply[0]!)}${c.reset}`);
  const planned = planHostUpdate(deps.roles, {
    backup: opts.backup !== false,
    restart: deps.restart,
    serviceDefinitions: deps.serviceDefinitions !== undefined,
  });
  const offer = continuationOffer(
    deps,
    {
      method: "npm-global",
      target,
      previous: normalizeVersion(deps.currentVersion),
      ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
    },
    target,
    planned,
  );
  const steps = orderForHandoff(planned, offer?.deferredBackup ?? null);
  printPlan(steps, target);
  for (const note of assessment.notes) {
    console.log(`${c.yellow}! ${note}${c.reset}`);
  }
  if (opts.dryRun) {
    if (assessment.requiresForce && !opts.force) {
      console.log(
        `${c.dim}Downgrade — re-run without --dry-run and pass --force to proceed.${c.reset}`,
      );
    }
    console.log(`${c.dim}Dry run — nothing executed.${c.reset}`);
    return null;
  }
  if (assessment.requiresForce && !opts.force) {
    throw new CliError(
      `${c.red}Refusing to downgrade ${assessment.current} → ${target} without --force. ` +
        `Re-run with --force if this is intentional.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }

  await deps.confirm(`Update ${CLI_PACKAGE} to ${target}?`);
  await executeHostPlan(steps, applyPlan, target, target, deps, offer ? { offer } : {});
  return target;
}

// ── Source-checkout flow ────────────────────────────────────────────────

/** How many left-behind commits an update names before summarising the rest. */
const LEFT_BEHIND_LISTED = 10;

async function productVersionAt(
  deps: UpdateFlowDeps,
  rootDir: string,
  ref: string,
): Promise<string | null> {
  const manifest = await deps
    .run(sourceTargetVersionSpec(rootDir, ref), "capture")
    .catch(() => ({ code: 1, stdout: "" }));
  if (manifest.code !== 0) return null;
  try {
    const declared = (JSON.parse(manifest.stdout) as { version?: unknown }).version;
    return typeof declared === "string" && isResolvedVersion(declared)
      ? normalizeVersion(declared)
      : null;
  } catch {
    return null;
  }
}

/**
 * Decide an update whose target does not contain the last completed build.
 *
 * That happens after an exact-commit rollout of an unmerged commit: the next
 * release is newer but was cut without it. Moving to a higher product version
 * is a forward update, and the commits it leaves behind are named. A target at
 * the same or a lower version is a rewind, refused unless the operator allowed
 * one, with the commits it would drop in the refusal.
 *
 * It also happens when the repository's history was replaced by a new root:
 * the two commits then share no history, the version decides the direction in
 * the same way, and listing "left behind" commits would only name the old
 * history, so the message says the history was replaced instead.
 */
async function judgeNonAncestorTarget(
  deps: UpdateFlowDeps,
  opts: { rootDir: string; target: string; previousRef: string; allowRewind: boolean },
): Promise<void> {
  const [installed, targeted, leftBehind, mergeBase, shallow] = await Promise.all([
    productVersionAt(deps, opts.rootDir, opts.previousRef),
    productVersionAt(deps, opts.rootDir, opts.target),
    deps
      .run(
        sourceLeftBehindSpec(opts.rootDir, opts.target, opts.previousRef, LEFT_BEHIND_LISTED + 1),
        "capture",
      )
      .catch(() => ({ code: 1, stdout: "" })),
    deps
      .run(sourceMergeBaseSpec(opts.rootDir, opts.target, opts.previousRef), "capture")
      .catch(() => ({ code: 2, stdout: "" })),
    deps.run(sourceIsShallowSpec(opts.rootDir), "capture").catch(() => ({ code: 1, stdout: "" })),
  ]);
  const unrelated =
    mergeBase.code === 1 &&
    mergeBase.stdout.trim() === "" &&
    shallow.code === 0 &&
    shallow.stdout.trim() === "false";
  const commits = leftBehind.code === 0 ? leftBehind.stdout.split("\n").filter(Boolean) : [];
  const listed = commits
    .slice(0, LEFT_BEHIND_LISTED)
    .map((line) => `\n    ${line}`)
    .join("");
  const more = commits.length > LEFT_BEHIND_LISTED ? "\n    …and more" : "";
  const forward =
    installed !== null &&
    targeted !== null &&
    (compareProductVersions(targeted, installed) ?? 0) > 0;
  const versions =
    installed && targeted ? ` (${targeted}, the last completed build is ${installed})` : "";
  if (unrelated) {
    const from = installed ? ` (${installed})` : "";
    if (forward || opts.allowRewind) {
      console.log(
        `${c.yellow}! ${opts.target} shares no history with the last completed build${from}: ` +
          `the repository's history was replaced. Moving ${forward ? "forward" : "back"} to it.${c.reset}`,
      );
      return;
    }
    throw new CliError(
      `${c.red}${opts.target} shares no history with the last completed source build and is not ` +
        `newer${versions}.\nRe-run with --allow-rewind only if moving to it is intentional.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (forward) {
    console.log(
      `${c.yellow}! ${opts.target} (${targeted}) is newer than the last completed build ` +
        `(${installed}) but does not contain all of it. Left behind:${listed}${more}${c.reset}`,
    );
    return;
  }
  if (opts.allowRewind) {
    console.log(
      `${c.yellow}! Moving back to ${opts.target}${versions}. Dropped:${listed}${more}${c.reset}`,
    );
    return;
  }
  throw new CliError(
    `${c.red}${opts.target} is not a forward update from the last completed source build${versions}. ` +
      `It would drop:${listed}${more}\nRe-run with --allow-rewind only if moving back is intentional.${c.reset}`,
    EXIT_USER_ERROR,
  );
}

export async function updateSourceCheckout(
  opts: {
    rootDir: string;
    edge: boolean;
    dryRun: boolean;
    force?: boolean;
    /** Allow a target that neither contains the last completed build nor is a newer release. */
    allowRewind?: boolean;
    backup?: boolean;
    /**
     * An exact version to move to instead of the newest release. It has to
     * resolve to a real tag on this checkout's own remote, which is what
     * makes a target arriving from somewhere else safe to act on.
     */
    targetVersion?: string;
    /** Exact full commit to fetch from origin and build. */
    targetCommit?: string;
  },
  deps: UpdateFlowDeps,
): Promise<string | null> {
  // Validated here as well as at the command's boundary: this value becomes
  // a git ref, and this flow is exported.
  assertPinnedTarget(opts.targetVersion);
  if (opts.targetCommit !== undefined && !SOURCE_COMMIT_PATTERN.test(opts.targetCommit)) {
    throw new CliError(
      `${c.red}Invalid target commit '${opts.targetCommit}' — expected a full 40-character lowercase commit id.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (opts.targetCommit && (opts.targetVersion || opts.edge)) {
    throw new CliError(
      `${c.red}--commit cannot be combined with --target-version or --edge.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const managedSpec = sourceManagedSpec(opts.rootDir);
  const managed = await deps.run(managedSpec, "capture").catch(() => ({ code: 1, stdout: "" }));
  if (managed.code !== 0 || managed.stdout.trim() !== "managed") {
    throw new CliError(
      `${c.red}This source checkout is not managed. Refusing to detach a development checkout. ` +
        `From its root, run \`npm run cli -- update adopt-source\` to verify and adopt a hand-made ` +
        `install, or re-run the source installer to create or repair the managed installation.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const statusSpec = sourceStatusSpec(opts.rootDir);
  let status: RunOutcome;
  try {
    status = await deps.run(statusSpec, "capture");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `${c.red}Could not inspect the source checkout: ${msg}${c.reset}`,
      EXIT_FAILURE,
    );
  }
  if (status.code !== 0) {
    throw new CliError(`${c.red}Could not inspect the source checkout.${c.reset}`, EXIT_FAILURE);
  }
  if (status.stdout.trim()) {
    throw new CliError(
      `${c.red}The source checkout has local changes. Commit or stash them before updating.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }

  let target = opts.targetCommit ?? "origin/main";
  let assessment: ReturnType<typeof assessUpdate> | undefined;
  if (!opts.edge && !opts.targetCommit) {
    const tagsSpec = sourceRemoteTagsSpec(opts.rootDir);
    let tags: RunOutcome;
    try {
      tags = await deps.run(tagsSpec, "capture");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(
        `${c.red}Could not read stable release tags: ${msg}${c.reset}`,
        EXIT_FAILURE,
      );
    }
    if (tags.code !== 0) {
      throw new CliError(
        `${c.red}Could not read stable release tags. Check repository access and your network connection.${c.reset}`,
        EXIT_FAILURE,
      );
    }
    const stableTag = opts.targetVersion
      ? stableTagForVersion(tags.stdout, opts.targetVersion)
      : newestStableTag(tags.stdout);
    if (!stableTag) {
      throw new CliError(
        opts.targetVersion
          ? `${c.red}No release v${normalizeVersion(opts.targetVersion)} exists on this ` +
              `installation's remote. Refusing to update to a version that does not resolve ` +
              `to a real tag.${c.reset}`
          : `${c.red}No stable source release exists yet (expected a vX.Y.Z tag).${c.reset}`,
        EXIT_FAILURE,
      );
    }
    target = stableTag;
    assessment = assessUpdate(deps.currentVersion, versionFromStableTag(stableTag)!);
  }

  const targetLabel = opts.edge
    ? "origin/main (edge)"
    : opts.targetCommit
      ? `commit ${opts.targetCommit.slice(0, 12)}`
      : target;
  const specs = [
    opts.targetCommit
      ? sourceFetchCommitSpec(opts.rootDir, opts.targetCommit)
      : sourceFetchSpec(opts.rootDir, opts.edge, target),
    ...sourceUpdateSpecs(opts.rootDir, target),
  ];
  console.log(
    `Source checkout detected at ${c.bold}${opts.rootDir}${c.reset}. ` +
      `Target: ${c.bold}${targetLabel}${c.reset}. Will run:`,
  );
  for (const spec of specs) {
    console.log(`  ${c.cyan}${formatCommandSpec(spec)}${c.reset}`);
  }
  // A real run prints its plan once the checkout's completion evidence is
  // read, right before the confirmation: only then is it known whether the
  // build is skipped and whether each daemon already runs it.
  if (opts.dryRun) {
    const planned = planHostUpdate(deps.roles, {
      backup: opts.backup !== false,
      restart: deps.restart,
      serviceDefinitions: deps.serviceDefinitions !== undefined,
      pauseCollectorForBuild: deps.buildMemoryTight?.() === true,
    });
    // A preview fetches nothing, so an edge target's manifest version is not
    // known here and its preview shows the order without a hand-over.
    printPlan(
      orderForHandoff(
        planned,
        handoffBackup(
          deps,
          "source",
          opts.edge || opts.targetCommit ? null : versionFromStableTag(target),
          planned,
        ),
      ),
      targetLabel,
    );
  }
  const notes = assessment?.notes ?? [
    "Edge can contain unreleased changes. Back up before running it: omnesis backup --note pre-upgrade",
  ];
  for (const note of notes) console.log(`${c.yellow}! ${note}${c.reset}`);
  if (opts.dryRun) {
    if (assessment?.requiresForce && !opts.force) {
      console.log(
        `${c.dim}Downgrade — re-run without --dry-run and pass --force to proceed.${c.reset}`,
      );
    }
    console.log(
      `${c.dim}Commit ancestry is checked after fetching during a real update; ` +
        `a backwards or divergent target may require --force.${c.reset}`,
    );
    const toolsPreview = deps.missingBuildTools?.();
    if (toolsPreview && toolsPreview.missing.length > 0) {
      console.log(
        `${c.yellow}! ${buildToolsRefusal(toolsPreview.missing, toolsPreview.installCommand)}${c.reset}`,
      );
    }
    console.log(`${c.dim}Dry run — nothing executed.${c.reset}`);
    return null;
  }
  if (assessment?.requiresForce && !opts.force) {
    throw new CliError(
      `${c.red}Refusing to downgrade ${assessment.current} → ${assessment.target} without --force.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }

  // Before the fetch, because once the checkout moves a missing compiler is a
  // failed `npm ci` and a rollback rather than a machine still sitting on its
  // own release. The tools are named here; nothing acquires root to install
  // them in the middle of an update.
  const tools = deps.missingBuildTools?.();
  if (tools && tools.missing.length > 0) {
    throw new CliError(
      `${c.red}${buildToolsRefusal(tools.missing, tools.installCommand)}${c.reset}`,
      EXIT_USER_ERROR,
    );
  }

  const fetchSpec = specs[0]!;
  console.log(`${c.dim}$ ${formatCommandSpec(fetchSpec)}${c.reset}`);
  const fetch = await runStep(deps, fetchSpec);
  if (fetch.code !== 0) {
    throw new CliError(
      `${c.red}\`${formatCommandSpec(fetchSpec)}\` failed (exit ${fetch.code}).${c.reset}`,
      EXIT_FAILURE,
    );
  }

  // The version the target's manifest declares decides whether its updater
  // takes the rest of this update. A release tag's is checked just below; an
  // edge build carries no tag, so its manifest is read on its own.
  let unreleasedVersion: string | null = null;
  if ((opts.edge || opts.targetCommit) && deps.continueAfterApply) {
    const manifest = await deps
      .run(sourceTargetVersionSpec(opts.rootDir, target), "capture")
      .catch(() => ({ code: 1, stdout: "" }));
    try {
      const declared = (JSON.parse(manifest.stdout) as { version?: unknown }).version;
      if (manifest.code === 0 && typeof declared === "string" && isResolvedVersion(declared)) {
        unreleasedVersion = normalizeVersion(declared);
      }
    } catch {
      // No readable version: the update finishes in this process.
    }
  }

  if (!opts.edge && !opts.targetCommit) {
    const versionSpec = sourceTargetVersionSpec(opts.rootDir, target);
    const versionResult = await deps.run(versionSpec, "capture");
    let targetVersion: string | undefined;
    try {
      targetVersion = (JSON.parse(versionResult.stdout) as { version?: string }).version;
    } catch {
      // Handled by the consistency refusal below.
    }
    if (versionResult.code !== 0 || `v${targetVersion}` !== target) {
      throw new CliError(
        `${c.red}Release tag ${target} does not contain matching CLI version metadata. Refusing to execute it.${c.reset}`,
        EXIT_FAILURE,
      );
    }
  }

  // The way back, resolved before the way forward is executed: once the
  // checkout moves, HEAD no longer names the tree on disk. The durable state
  // distinguishes that tree from the last build known to have completed.
  const head = await deps
    .run(sourceHeadSpec(opts.rootDir), "capture")
    .catch(() => ({ code: 1, stdout: "" }));
  const headCommit = head.code === 0 ? head.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(headCommit)) {
    throw new CliError(
      `${c.red}Could not resolve the commit this checkout is on, so a failed update could not be ` +
        `rolled back. Check \`git -C ${opts.rootDir} rev-parse HEAD\`.${c.reset}`,
      EXIT_FAILURE,
    );
  }

  const targetResult = await deps
    .run(sourceRefShaSpec(opts.rootDir, target), "capture")
    .catch(() => ({ code: 1, stdout: "" }));
  const targetCommit = targetResult.code === 0 ? targetResult.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(targetCommit)) {
    throw new CliError(
      `${c.red}Could not resolve ${target} to an exact commit. The checkout may be incomplete or corrupt.${c.reset}`,
      EXIT_FAILURE,
    );
  }
  if (opts.targetCommit && targetCommit !== opts.targetCommit) {
    throw new CliError(
      `${c.red}Origin resolved ${opts.targetCommit} to ${targetCommit}. Refusing to install a different commit.${c.reset}`,
      EXIT_FAILURE,
    );
  }

  let rawState: string | null;
  try {
    rawState = deps.applyState.read();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `${c.red}Could not read the source update completion record: ${detail}${c.reset}`,
      EXIT_FAILURE,
    );
  }
  const evidence = assessSourceApplyEvidence(opts.rootDir, headCommit, targetCommit, rawState);
  const previousRef = evidence.previousCommit;

  const ancestry = await deps.run(sourceAncestrySpec(opts.rootDir, target, previousRef), "capture");
  if (ancestry.code > 1) {
    throw new CliError(
      `${c.red}Could not compare the last completed source build with ${target}. ` +
        `The checkout may be incomplete or corrupt.${c.reset}`,
      EXIT_FAILURE,
    );
  }
  if (ancestry.code === 1) {
    await judgeNonAncestorTarget(deps, {
      rootDir: opts.rootDir,
      target,
      previousRef,
      allowRewind: opts.force === true || opts.allowRewind === true,
    });
  }

  if (evidence.recovery === "unfinished") {
    console.log(
      `${c.yellow}! The previous source update did not finish. Reapplying ${targetLabel} from ` +
        `the last completed build (${previousRef}).${c.reset}`,
    );
  } else if (evidence.recovery === "unrecorded") {
    console.log(
      `${c.yellow}! The checkout is on ${targetLabel}, but no completed apply is recorded. ` +
        `Rebuilding because an earlier update may not have finished or may predate completion tracking.${c.reset}`,
    );
  } else if (evidence.recovery === "mismatch") {
    console.log(
      `${c.yellow}! The source update record does not match this checkout. Reapplying ${targetLabel} ` +
        `instead of assuming the build completed.${c.reset}`,
    );
  }

  // A checkout with matching durable completion proof still has restarts and
  // a plugin refresh to do. Skipping only its build keeps a re-run cheap; the
  // backup goes with it because nothing irreversible follows an empty apply.
  const alreadyOnTarget = evidence.complete;
  const planned = planHostUpdate(deps.roles, {
    backup: opts.backup !== false && !alreadyOnTarget,
    pauseCollectorForBuild: !alreadyOnTarget && deps.buildMemoryTight?.() === true,
    restart: deps.restart,
    serviceDefinitions: deps.serviceDefinitions !== undefined,
    ...(alreadyOnTarget ? { runningBuild: await runningBuilds(deps) } : {}),
  });
  const offer = alreadyOnTarget
    ? undefined
    : continuationOffer(
        deps,
        {
          method: "source",
          rootDir: opts.rootDir,
          edge: opts.edge,
          target,
          targetCommit,
          previous: previousRef,
        },
        opts.edge || opts.targetCommit ? unreleasedVersion : versionFromStableTag(target),
        planned,
      );
  const steps = orderForHandoff(planned, offer?.deferredBackup ?? null);
  if (alreadyOnTarget) {
    console.log(
      `${c.dim}The checkout is already on ${target} — nothing to build, and no backup taken ` +
        `since nothing irreversible follows.${c.reset}`,
    );
  }
  printPlan(steps, targetLabel);

  await deps.confirm(`Update the checkout at ${opts.rootDir} to ${target}?`);
  try {
    await deps.prepareSourceLauncher?.(opts.rootDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `${c.red}Could not prepare the source update recovery launcher: ${detail}. ` +
        `Re-run the source installer before updating this checkout.${c.reset}`,
      EXIT_FAILURE,
    );
  }
  const applyPlan = sourceApplyPlan(
    opts.rootDir,
    target,
    targetCommit,
    previousRef,
    deps.buildEnv?.(),
  );
  await executeHostPlan(
    steps,
    // The way back is still computed even with nothing to apply, because the
    // restarts that follow can fail.
    alreadyOnTarget ? { ...applyPlan, apply: [] } : applyPlan,
    targetLabel,
    opts.edge || opts.targetCommit ? null : versionFromStableTag(target),
    deps,
    offer ? { offer } : {},
  );
  return opts.edge || opts.targetCommit ? null : versionFromStableTag(target);
}

// ── Docker flow ─────────────────────────────────────────────────────────

/** The image tag the release pipeline moves with the main branch. */
const DOCKER_EDGE_TAG = "main";

/**
 * Update a container install: record the image tag its compose project
 * resolves every service at, pull that tag, and recreate the containers in
 * the order this host's roles imply. The way back is the same pull at the tag
 * that was recorded before, which for a release tag is the image still in the
 * local store.
 *
 * The recorded tag says what this installation is *meant* to run, not what it
 * is running: it is written before the pull, because the pull and the
 * container recreations both resolve their images from it. Between that write
 * and a gateway answering `/health` on the new image there are minutes in
 * which a killed process leaves the file naming a version nothing serves. The
 * completion record beside the compose file is what closes that window: it is
 * written as "applying" before the tag moves and completed only once the
 * gateway serves the new image, so a later run reads an unfinished record —
 * or, on an install that predates the record, asks the gateway what it
 * serves — and reapplies rather than trusting the tag.
 */
export async function updateDocker(
  opts: {
    composeFile: string;
    projectDir: string;
    edge: boolean;
    dryRun: boolean;
    force?: boolean;
    backup?: boolean;
    /**
     * An exact release to move to instead of the newest published one. It
     * becomes an image tag, so its shape is checked here as well as at the
     * command's own boundary.
     */
    targetVersion?: string;
  },
  deps: UpdateFlowDeps,
): Promise<string | null> {
  assertPinnedTarget(opts.targetVersion);

  // The seam that records the tag is what moves a container install: the apply
  // and the rollback run the same `compose pull`, and only the recorded tag
  // decides which images it fetches. Unwired, this flow would pull the tag
  // already on file, recreate the containers on the images they are already
  // running, and report success.
  const select = deps.select;
  if (!select) {
    throw new CliError(
      `${c.red}This container update was not given a way to record the image tag, so it would ` +
        `pull and recreate the containers at the tag they already run. Refusing to report an ` +
        `update that would not happen.${c.reset}`,
      EXIT_FAILURE,
    );
  }

  // The recorded tag is the only account of what these containers run: an
  // image carries no version this command can read back, and the CLI it runs
  // as belongs to the updater image rather than to the gateway's. Read first,
  // because without it a failed update has no tag to return to.
  const envPath = join(opts.projectDir, DOCKER_ENV_FILE);
  let previous: string | null = null;
  try {
    previous = readImageTag(readFileSync(envPath, "utf8"));
  } catch {
    // Absent and unreadable are the same answer here, and the refusal below
    // says the same thing for both.
  }
  if (previous === null) {
    throw new CliError(
      `${c.red}Could not read ${IMAGE_TAG_KEY} from ${envPath}, so a failed update could not be ` +
        `rolled back to the images this host is running. Re-run the installer to repair this ` +
        `installation.${c.reset}`,
      EXIT_FAILURE,
    );
  }

  let composeText: string;
  try {
    composeText = readFileSync(opts.composeFile, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `${c.red}Could not read the compose project at ${opts.composeFile}: ${detail}${c.reset}`,
      EXIT_FAILURE,
    );
  }

  // The compose project itself says which daemons this host runs, so the
  // ordered plan comes from what is declared there rather than from a scan of
  // service units no container install has.
  const roles = detectDockerRoles(composeText, opts.composeFile);
  // The scan reads one compose dialect, and a project written in another —
  // quoted service names, flow style — yields no services at all. Left to
  // stand, that silence would produce a plan with nothing in it but the apply:
  // no backup, no container recreated, no health wait, and an "Updated to X"
  // over a host still running the old images.
  if (!roles.gateway.present && !roles.collector.present) {
    throw new CliError(
      `${c.red}No gateway or collector service is declared in ${opts.composeFile}, so this ` +
        `update has nothing to restart and cannot verify what it changed. Re-run the installer ` +
        `to repair this installation.${c.reset}`,
      EXIT_FAILURE,
    );
  }

  let target: string;
  if (opts.edge) {
    target = DOCKER_EDGE_TAG;
  } else if (opts.targetVersion) {
    target = normalizeVersion(opts.targetVersion);
  } else {
    // The product versions are lockstep, so the published CLI version is the
    // tag every Omnesis image is published under. Resolved over the package
    // index's HTTP API because the updater container carries no npm binary.
    const resolve = deps.latestPublished;
    if (!resolve) {
      throw new CliError(
        `${c.red}No way to resolve the newest release. Pass --target-version to name one.${c.reset}`,
        EXIT_FAILURE,
      );
    }
    const distTag = channelToDistTag("stable");
    let published: string;
    try {
      published = await resolve(distTag);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new CliError(
        `${c.red}Could not resolve ${CLI_PACKAGE}@${distTag}: ${detail}${c.reset}`,
        EXIT_FAILURE,
      );
    }
    target = normalizeVersion(published);
    // Everything downstream treats this as a version: it is compared, shown
    // to the user, and becomes an image tag. Anything else is a broken
    // registry answer, not something to act on.
    if (!isResolvedVersion(target)) {
      throw new CliError(
        `${c.red}${CLI_PACKAGE}@${distTag} did not resolve to a version: ${target}${c.reset}`,
        EXIT_FAILURE,
      );
    }
  }

  // What this host runs is the images, so the tag they last served is the
  // version being moved from — not the CLI version of the updater image this
  // command happens to run as. Carried on the deps every step below reads, so
  // that the rollback's health wait demands the version it is restoring rather
  // than the updater's own. An edge install's tag is a branch and not a
  // version, so there is nothing to assess and the edge note stands instead.
  // The tag on file is what the last apply meant to run; whether it finished
  // is the record's to say, or failing a record, the gateway's. The rollback
  // baseline is the tag known to have been served, which after an
  // interrupted apply is not the one on file.
  let rawState: string | null;
  try {
    rawState = deps.applyState.read();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `${c.red}Could not read the update completion record: ${detail}${c.reset}`,
      EXIT_FAILURE,
    );
  }
  const servedVersion = opts.edge ? null : ((await deps.servedVersion?.()) ?? null);
  const evidence = opts.edge
    ? null
    : assessDockerApplyEvidence(opts.projectDir, previous, target, rawState, servedVersion);
  const baseline = evidence?.previousTag ?? previous;
  const flowDeps: UpdateFlowDeps = {
    ...deps,
    currentVersion: isResolvedVersion(baseline) ? normalizeVersion(baseline) : deps.currentVersion,
    roles,
    select,
  };
  const assessment = opts.edge ? undefined : assessUpdate(flowDeps.currentVersion, target);

  if (evidence?.recovery === "unfinished") {
    console.log(
      `${c.yellow}! The previous container update did not finish: ${previous} is recorded but ` +
        `${baseline} is what these containers last served. Reapplying ${target}.${c.reset}`,
    );
  } else if (evidence?.recovery === "unrecorded") {
    console.log(
      `${c.yellow}! ${previous} is the recorded tag, but nothing proves the containers were ` +
        `recreated on it${
          servedVersion
            ? ` — the gateway serves ${servedVersion}`
            : " and the gateway is not answering"
        }. Reapplying ${target} instead of assuming it finished.${c.reset}`,
    );
  } else if (evidence?.recovery === "mismatch") {
    console.log(
      `${c.yellow}! The update record does not match what these containers serve. Reapplying ` +
        `${target} instead of assuming it finished.${c.reset}`,
    );
  }

  // The main tag moves with the branch, so an edge install is never "already
  // there" — the same tag names a different image on the next pull.
  if (evidence?.complete && !opts.force) {
    if (evidence.attested) {
      // The gateway's own answer stood in for a record written before
      // completion tracking; leave the record so the next run need not ask.
      try {
        deps.applyState.write(completedDockerApplyState(opts.projectDir, target));
      } catch {
        // The served version will answer again next time.
      }
    }
    console.log(
      `Already up to date (${normalizeVersion(previous)}): the gateway serves it. Pass --force ` +
        `to pull and recreate the containers at that tag anyway.`,
    );
    return target;
  }

  const applyPlan = dockerApplyPlan(opts.composeFile, opts.projectDir, target, baseline);
  const arrow = assessment?.direction === "downgrade" ? "↓" : "→";
  console.log(
    `${assessment?.direction === "downgrade" ? "Downgrade" : "Update"} of the container images: ` +
      `${c.bold}${baseline}${c.reset} ${arrow} ${c.bold}${target}${c.reset}`,
  );
  console.log(`Will run: ${c.cyan}${formatCommandSpec(applyPlan.apply[0]!)}${c.reset}`);
  const planned = planHostUpdate(roles, {
    backup: opts.backup !== false,
    restart: flowDeps.restart,
  });
  // The main tag has no release number to tell whether its updater takes an
  // offer, so an edge update finishes in this process.
  const offer = opts.edge
    ? undefined
    : continuationOffer(
        flowDeps,
        {
          method: "docker",
          composeFile: opts.composeFile,
          projectDir: opts.projectDir,
          target,
          previous: baseline,
        },
        target,
        planned,
      );
  const steps = orderForHandoff(planned, offer?.deferredBackup ?? null);
  printPlan(steps, target);
  const notes = assessment?.notes ?? [
    `The ${DOCKER_EDGE_TAG} tag moves with the branch and can contain unreleased changes. ` +
      "Back up before running it: omnesis backup --note pre-upgrade",
    // Both directions of the plan pull the same moving tag, so the rollback is
    // not the way back an edge failure needs.
    `Rolling this back re-pulls ${DOCKER_EDGE_TAG}, which by then is the build that just ` +
      "failed — the backup taken before the update is the way back from it.",
  ];
  for (const note of notes) console.log(`${c.yellow}! ${note}${c.reset}`);
  if (opts.dryRun) {
    if (assessment?.requiresForce && !opts.force) {
      console.log(
        `${c.dim}Downgrade — re-run without --dry-run and pass --force to proceed.${c.reset}`,
      );
    }
    console.log(`${c.dim}Dry run — nothing executed.${c.reset}`);
    return null;
  }
  if (assessment?.requiresForce && !opts.force) {
    throw new CliError(
      `${c.red}Refusing to downgrade ${assessment.current} → ${target} without --force. ` +
        `Re-run with --force if this is intentional.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }

  await flowDeps.confirm(`Update the containers in ${opts.composeFile} to ${target}?`);
  await executeHostPlan(
    steps,
    applyPlan,
    target,
    opts.edge ? null : target,
    flowDeps,
    offer ? { offer } : {},
  );
  return opts.edge ? null : target;
}

// ── Effects ─────────────────────────────────────────────────────────────

async function confirmInteractive(message: string, skip: boolean): Promise<void> {
  if (skip) return;
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new CliError(
      `${c.red}Not a TTY — pass --yes to update without a confirmation prompt.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const prompts = await import("@clack/prompts");
  const confirmed = await prompts.confirm({ message });
  if (prompts.isCancel(confirmed) || !confirmed) {
    prompts.cancel("Cancelled.");
    throw new CliError("", EXIT_CANCELLED);
  }
}

/**
 * A prompt whose "no" is a legitimate answer: declining leaves the update
 * complete and prints what the operator can do later. Without a terminal
 * there is nobody to ask, so it declines rather than blocking on a prompt
 * that could never be answered.
 */
export async function approveInteractive(message: string, skip: boolean): Promise<boolean> {
  if (skip) return true;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  // Reached only on a terminal without `--yes`, which is exactly the path on
  // which `confirmInteractive` already resolved this module — so this import
  // is served from the module cache rather than from a node_modules the
  // update has since rewritten.
  const prompts = await import("@clack/prompts");
  const confirmed = await prompts.confirm({ message });
  return !prompts.isCancel(confirmed) && confirmed === true;
}

/** How long to wait between `/health` probes while the gateway boots. */
const HEALTH_POLL_MS = 2_000;

/** How long one `/health` probe may hang before it counts as no answer. */
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

/** Default ceiling on the whole wait, in seconds; `--health-timeout` overrides it. */
const DEFAULT_HEALTH_TIMEOUT_SEC = 600;

/** Effects the health wait needs — injected so it is testable without a gateway. */
export interface HealthWaitDeps {
  /** Fetch `url` and resolve its status and reported version. */
  probe(url: string): Promise<{ ok: boolean; status: number; version?: string }>;
  /** Wall clock, in milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

const nodeHealthWaitDeps: HealthWaitDeps = {
  probe: async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { version?: string };
    return { ok: true, status: res.status, version: body.version };
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const nodeLocalHealthWaitDeps: HealthWaitDeps = {
  probe: (url) =>
    new Promise((resolve, reject) => {
      // This local self-signed gateway probe is followed by a pinned-certificate update.
      // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      const requestOptions = {
        rejectUnauthorized: false,
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      };
      const request = httpsRequest(url, requestOptions, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length <= 1024 * 1024) body += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            resolve({ ok: false, status });
            return;
          }
          try {
            const parsed = JSON.parse(body) as { version?: string };
            resolve({ ok: true, status, version: parsed.version });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on("error", reject);
      request.end();
    }),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Local rebound gateway endpoint derived from the service's effective listener. */
export function resolveLocalGatewayHealthUrl(bind: string, port: number): string {
  const host = bind === "0.0.0.0" ? "127.0.0.1" : bind === "::" ? "::1" : bind;
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  const url = new URL(`https://${authority}`);
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Invalid local gateway bind address '${bind}'`);
  }
  url.port = String(port);
  return url.origin;
}

/**
 * Poll `/health` until the gateway answers. When the target version is known,
 * the answer must also report it: a gateway that has not finished shutting
 * down still answers 200 from the old build, and treating that as success
 * would restart the collector against a schema mid-migration. `--edge` has no
 * release version to demand, so there the first healthy answer is taken.
 */
export async function awaitGatewayHealth(
  gatewayUrl: string,
  expectVersion: string | null,
  timeoutMs: number,
  deps: HealthWaitDeps = nodeHealthWaitDeps,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${gatewayUrl}/health`;
  const deadline = deps.now() + timeoutMs;
  // Assigned on every path through the loop body that does not return.
  let lastError: string;
  for (;;) {
    if (signal?.aborted) throw new Error("Gateway health wait aborted");
    try {
      const answer = await deps.probe(url);
      if (answer.ok) {
        if (!expectVersion || answer.version === expectVersion) return;
        lastError = `still serving ${answer.version ?? "an unknown version"}`;
      } else {
        lastError = `HTTP ${answer.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (signal?.aborted) throw new Error("Gateway health wait aborted");
    if (deps.now() >= deadline) {
      throw new Error(
        `${url} did not report ${expectVersion ?? "a healthy gateway"} within ` +
          `${Math.round(timeoutMs / 1000)}s (${lastError})`,
      );
    }
    await deps.sleep(HEALTH_POLL_MS);
  }
}

/**
 * Parse `--health-timeout`. Strict: `10min` is a value an operator meant as
 * ten minutes, and silently reading it as ten seconds would time out a
 * healthy migration and roll back a good update.
 */
export function parseHealthTimeoutSeconds(raw: unknown): number | null {
  const text = String(raw ?? DEFAULT_HEALTH_TIMEOUT_SEC).trim();
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const seconds = Number.parseInt(text, 10);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/**
 * Parse `--wait-for-lock`: whole minutes, strictly. Undefined when the flag is
 * absent, null when its value is not a usable number of minutes — including
 * the next flag, which the argument parser takes as the value of a bare
 * `--wait-for-lock`.
 */
export function parseWaitForLockMinutes(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  const text = String(raw).trim();
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const minutes = Number.parseInt(text, 10);
  return Number.isSafeInteger(minutes) && minutes <= MAX_WAIT_FOR_LOCK_MINUTES ? minutes : null;
}

/** A day: past that, a wait is a stuck update rather than a busy one. */
const MAX_WAIT_FOR_LOCK_MINUTES = 24 * 60;

/** How long a registry lookup may hang before it counts as no answer. */
const REGISTRY_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The newest published version for a dist-tag, read from the package index's
 * HTTP API. A container install has no npm binary to ask, and the product
 * versions are lockstep, so the CLI package's version is the tag every
 * Omnesis image is published under. The index is the one the installer
 * resolves the same number from, `OMNESIS_PACKAGE_INDEX_URL` included, so a
 * fork or a mirror answers for the install and for every update after it.
 */
async function latestPublishedVersion(distTag: string): Promise<string> {
  const url = packageIndexUrl(distTag);
  const res = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  const body = (await res.json()) as { version?: string };
  if (typeof body.version !== "string" || !body.version) {
    throw new Error(`${url} returned no version`);
  }
  return body.version;
}

/**
 * Recreate one container so it comes up on the image the recorded tag now
 * resolves to. A non-zero exit throws, which is what the plan's gateway
 * restart treats as "the gateway would not restart" and rolls back on.
 */
export function dockerRestarter(
  composeFile: string,
  run: CommandRunner,
): (component: ServiceComponent) => Promise<void> {
  return async (component) => {
    const spec = dockerRestartSpec(composeFile, component);
    console.log(`${c.dim}$ ${formatCommandSpec(spec)}${c.reset}`);
    const result = await run(spec, "inherit");
    if (result.code !== 0) {
      throw new Error(`\`${formatCommandSpec(spec)}\` failed (exit ${result.code})`);
    }
  };
}

/**
 * Record the image tag compose resolves every Omnesis service at. This is
 * what moves a container install: the pull and the container recreation that
 * follow both resolve their image from it.
 *
 * It is recorded twice, because compose reads two places and prefers the
 * environment. The file is what an operator's own `docker compose` picks up
 * later; this process's environment is what the compose commands spawned
 * below inherit — and this CLI loaded that same file into its environment at
 * startup, so without the second write every child would keep resolving the
 * tag this update is moving away from.
 *
 * The file is written through the shared `.env` upsert rather than rewritten
 * here, because it is not this command's: the gateway loads it as its own
 * environment, so it can carry the secret-store settings that decide whether
 * the corpus opens at all. Only this key is touched, and every other line —
 * comments, blanks, quoting, unrelated keys — is left as it stands.
 */
export async function selectImageTag(projectDir: string, tag: string): Promise<void> {
  // The value becomes the tag half of an image reference, so it is checked
  // before it reaches a file compose reads.
  assertImageTag(tag);
  upsertDotEnv(projectDir, { [IMAGE_TAG_KEY]: tag });
  process.env[IMAGE_TAG_KEY] = tag;
}

/**
 * The compose project's text, or an empty project when it cannot be read. Only
 * a placeholder: the docker flow reads the file itself, fails loudly on one it
 * cannot open, and carries the roles it derived on the deps every step of it
 * uses — so a project this pre-read could not open decides nothing.
 */
function readComposeText(composeFile: string): string {
  try {
    return readFileSync(composeFile, "utf8");
  } catch {
    return "";
  }
}

/**
 * Resolve every harness home this CLI knows about. `harnessHome` reads the
 * harness's own env overrides and refuses an invalid one; a bad override is
 * not a reason to fail an update that may have nothing to do with that
 * harness, so it is treated as "no harness here".
 */
async function resolveHarnessHomes(): Promise<Array<{ harness: Harness; home: string }>> {
  const { harnessHome } = await import("./connect.js");
  const homes: Array<{ harness: Harness; home: string }> = [];
  for (const harness of HARNESSES) {
    try {
      homes.push({ harness, home: harnessHome(harness) });
    } catch {
      // An unusable override means this host cannot address that harness.
    }
  }
  return homes;
}

// ── Command ─────────────────────────────────────────────────────────────

export function resolveUpdateConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
}

export const adoptSourceCommand = defineCommand({
  meta: {
    name: "adopt-source",
    description: "Verify and adopt the source checkout running this command",
  },
  async run() {
    const install = detectInstallMethod(process.argv[1] ?? "");
    if (install.method !== "source") {
      throw new CliError(
        `${c.red}Run this from the checkout to adopt with ` +
          `\`npm run cli -- update adopt-source\`.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const configDir = resolveUpdateConfigDir();
    await runWithUpdateLock(configDir, false, async (lock) => {
      lock?.setStep("verifying source checkout");
      await adoptSourceCheckout(install.rootDir, {
        run: (spec) => spawnRunner(spec, "capture"),
        log: (message) => console.log(message),
      });
    });
  },
});

export const migrateToPackageCommand = defineCommand({
  meta: {
    name: "migrate-to-package",
    description: "Replace an installer-managed source checkout with the same package release",
  },
  args: {
    registry: {
      type: "string",
      description: "npm registry that carries the exact current release",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Print the migration plan without changing the host",
    },
    yes: {
      type: "boolean",
      default: false,
      description: "Confirm the migration and retired-checkout removal",
    },
    "keep-checkout": {
      type: "boolean",
      default: false,
      description: "Keep the retired source checkout after a successful migration",
    },
    "health-timeout": {
      type: "string",
      default: String(DEFAULT_HEALTH_TIMEOUT_SEC),
      description: "Seconds to wait for a rebound gateway to serve the expected version",
    },
  },
  async run(ctx) {
    const dryRun = Boolean(ctx.args["dry-run"]);
    const yes = Boolean(ctx.args.yes);
    const healthTimeoutSec = parseHealthTimeoutSeconds(ctx.args["health-timeout"]);
    if (healthTimeoutSec === null) {
      throw new CliError(
        `${c.red}Invalid --health-timeout '${String(ctx.args["health-timeout"])}' — expected a whole number of seconds.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const configDir = resolveUpdateConfigDir();
    const supervisor = createSupervisor();
    await runWithUpdateLock(configDir, dryRun, async (lock) => {
      const roles = detectHostRoles({
        platform: process.platform,
        homeDir: homedir(),
        configDir,
        harnessHomes: await resolveHarnessHomes(),
      });
      await migrateSourceToPackage(
        {
          registry: typeof ctx.args.registry === "string" ? ctx.args.registry : undefined,
          dryRun,
          keepCheckout: Boolean(ctx.args["keep-checkout"]),
          healthTimeoutMs: healthTimeoutSec * 1_000,
        },
        {
          run: spawnRunner,
          supervisor,
          roles,
          platform: process.platform,
          homeDir: homedir(),
          configDir,
          argv1: process.argv[1] ?? "",
          cwd: process.cwd(),
          currentVersion: readPackageVersion(import.meta.url),
          confirm: (message) => confirmInteractive(message, yes),
          approve: (message) => approveInteractive(message, yes),
          awaitHealth: (expectVersion, bind, port, timeoutMs, signal) =>
            awaitGatewayHealth(
              resolveLocalGatewayHealthUrl(bind, port),
              expectVersion,
              timeoutMs,
              nodeLocalHealthWaitDeps,
              signal,
            ),
          canWrite: canWritePrefix,
          now: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          log: (message) => console.log(message),
          interruptions: updateInterruptionRouter,
          updateLock: lock,
        },
      );
    });
  },
});

/** What one host's update flows run with, however the command was reached. */
interface HostUpdateContext {
  plan: InstallTarget;
  configDir: string;
  roles: HostRoles;
  yes: boolean;
  restart: boolean;
  healthTimeoutSec: number;
  /**
   * The version this host ran before the update: the running CLI's own, except
   * in a continuation, where the running CLI is already the target.
   */
  currentVersion: string;
}

/**
 * The real effects behind the update flows, and the gateway-trust step the
 * fan-out shares with them.
 */
function hostUpdateDeps(ctx: HostUpdateContext): {
  deps: UpdateFlowDeps;
  ensureTrust(): Promise<void>;
} {
  const { plan, configDir, roles, yes, restart, healthTimeoutSec } = ctx;
  // `update` is exempt from the eager TOFU preflight because most hosts it
  // runs on never call the gateway. A gateway host does — for the backup and
  // the health wait — so trust is established here instead, once.
  let trusted = false;
  const ensureTrust = async (): Promise<void> => {
    if (trusted) return;
    await ensureGatewayTrust({ gatewayUrl: GATEWAY_REQUEST_URL, configDir });
    trusted = true;
  };

  const deps: UpdateFlowDeps = {
    run: spawnRunner,
    applyState: updateApplyStateStore(configDir),
    interruptions: updateInterruptionRouter,
    prepareSourceLauncher: (rootDir) => {
      prepareSourceRecoveryLauncher(rootDir, configDir, homedir());
    },
    buildEnv: () => buildHeapEnv(),
    currentVersion: ctx.currentVersion,
    reportHarnessResult: async (harness, result) => {
      const role = roles.harnesses.find((candidate) => candidate.harness === harness);
      if (role) await reportHarnessUpdateResult(role.home, result);
    },
    confirm: (message) => confirmInteractive(message, yes),
    approve: (message) => approveInteractive(message, yes),
    roles,
    backup: async (note, purpose) => {
      await ensureTrust();
      // index.db is derivable from omnesis.db and is the largest file in a
      // backup; skipping it keeps the pre-update snapshot fast enough that
      // an operator leaves it on.
      await runBackup({ includeIndex: false, note, purpose });
    },
    offlineBackup:
      plan.kind === "docker"
        ? undefined
        : (note, purpose) =>
            takeOfflineGatewayBackup({
              configDir,
              note,
              purpose,
              version: ctx.currentVersion,
              log: {
                info: (message) => console.log(`${c.dim}${message}${c.reset}`),
                warn: (message) => console.log(`${c.yellow}! ${message}${c.reset}`),
              },
            }),
    runsInstalledBuild:
      plan.kind === "docker"
        ? undefined
        : async (component) => {
            const installedAt =
              plan.kind === "source"
                ? sourceInstalledAt(configDir, plan.rootDir)
                : packageInstalledAt(import.meta.url);
            if (component === "gateway") {
              return runsInstalledBuild(gatewayStartedAt(configDir), installedAt);
            }
            const status = await createSupervisor()
              .status(component)
              .catch(() => null);
            const startedAt =
              status?.state === "running" && status.pid !== null
                ? processStartedAt(status.pid)
                : null;
            return runsInstalledBuild(startedAt, installedAt);
          },
    restart,
    restartService:
      plan.kind === "docker"
        ? dockerRestarter(plan.composeFile, spawnRunner)
        : (component) => createSupervisor().restart(component),
    stopService:
      plan.kind === "docker" ? undefined : (component) => createSupervisor().stop(component),
    startService:
      plan.kind === "docker"
        ? undefined
        : async (component) => {
            const supervisor = createSupervisor();
            // launchd's start restarts a running job; one already back is left alone.
            if ((await supervisor.status(component)).state !== "running") {
              await supervisor.start(component);
            }
          },
    buildMemoryTight: plan.kind === "source" ? () => buildMemoryTight() : undefined,
    missingBuildTools:
      plan.kind === "source"
        ? () => ({
            missing: missingBuildTools(nodeBuildToolProbe),
            installCommand: buildToolsInstallCommand(nodeBuildToolProbe),
          })
        : undefined,
    serviceDefinitions:
      plan.kind !== "docker" && (process.platform === "darwin" || process.platform === "linux")
        ? serviceDefinitionUpdater({
            supervisor: createSupervisor(),
            homeDir: homedir(),
            nodeBinDir: stableNodeBinDir(process.execPath),
          })
        : undefined,
    select: plan.kind === "docker" ? (tag) => selectImageTag(plan.projectDir, tag) : undefined,
    latestPublished: latestPublishedVersion,
    awaitHealth: async (expectVersion, signal) => {
      await ensureTrust();
      await awaitGatewayHealth(
        GATEWAY_REQUEST_URL,
        expectVersion,
        healthTimeoutSec * 1_000,
        undefined,
        signal,
      );
    },
    servedVersion: async () => {
      try {
        await ensureTrust();
        const answer = await nodeHealthWaitDeps.probe(`${GATEWAY_REQUEST_URL}/health`);
        return answer.ok && answer.version ? normalizeVersion(answer.version) : null;
      } catch {
        return null;
      }
    },
    cliPath: "omnesis",
  };
  return { deps, ensureTrust };
}

/** What taking an offer reads and does, injected so tests drive it on a real lock. */
export interface ContinuationRun {
  configDir: string;
  id: string;
  env: NodeJS.ProcessEnv;
  /** This build's own version. */
  ownVersion: string;
  /** How the installation this build runs from was detected. */
  detection: InstallMethod;
  interruptions: UpdateInterruptionRouter;
  /** Read the host and build the update's effects, holding the adopted lock. */
  prepare(
    install: InstallTarget,
    offer: UpdateContinuation,
    lock: UpdateLock | undefined,
  ): Promise<UpdateFlowDeps>;
}

/**
 * Take an offer from the updater that installed this build and finish its
 * update.
 *
 * Every refusal comes before the offer is marked accepted, so a refused offer
 * leaves the offering process to finish the update itself with the lock handed
 * back. Signals are held from the start: before acceptance one is a refusal,
 * returning the lock; acceptance is the last thing before the plan takes the
 * signals over, with nothing awaited in between, so from then on one rolls
 * back.
 */
export async function continueOffer(run: ContinuationRun): Promise<void> {
  const early: { signal: UpdateSignal | null } = { signal: null };
  let releaseEarly: (() => void) | null = run.interruptions.claim((signal) => {
    early.signal ??= signal;
  });
  const refusal = (err: unknown): unknown =>
    err instanceof ContinuationRefused
      ? new CliError(`${c.red}${err.message}${c.reset}`, EXIT_FAILURE)
      : err;
  try {
    let offer: UpdateContinuation;
    let install: InstallTarget;
    try {
      offer = claimContinuation(run.configDir, run.id, {
        lockId: run.env[UPDATE_LOCK_ENV],
        ownVersion: run.ownVersion,
      });
      install = planForSubject(run.detection, offer.subject);
    } catch (err) {
      throw refusal(err);
    }
    await runWithUpdateLock(
      run.configDir,
      false,
      async (lock) => {
        const deps = await run.prepare(install, offer, lock);
        if (early.signal) {
          throw new CliError(
            `${c.yellow}Stopped by ${early.signal} before taking over the update.${c.reset}`,
            signalExitCode(early.signal),
          );
        }
        releaseEarly?.();
        releaseEarly = null;
        try {
          acceptContinuation(run.configDir, offer);
        } catch (err) {
          throw refusal(err);
        }
        await runUpdateContinuation(offer, deps);
      },
      run.env,
      { continuation: true },
    );
  } finally {
    releaseEarly?.();
  }
}

/**
 * The installed build's side of a hand-over. Hidden: the updater that
 * installed this build runs it with an offer it just wrote; nobody else has
 * one to give it.
 */
export const continueAfterApplyCommand = defineCommand({
  meta: {
    name: CONTINUATION_SUBCOMMAND,
    description: "Finish an update the previously installed build applied",
    hidden: true,
  },
  args: {
    id: { type: "positional", required: true, description: "The update offer to take" },
  },
  async run(ctx) {
    const configDir = resolveUpdateConfigDir();
    await continueOffer({
      configDir,
      id: String(ctx.args.id),
      env: process.env,
      ownVersion: readPackageVersion(import.meta.url),
      detection: detectDockerInstall(configDir) ?? detectInstallMethod(process.argv[1] ?? ""),
      interruptions: updateInterruptionRouter,
      prepare: async (install, offer, lock) => {
        lock?.setStep("continuing after the apply");
        const roles =
          install.kind === "docker"
            ? detectDockerRoles(readComposeText(install.composeFile), install.composeFile)
            : detectHostRoles({
                platform: process.platform,
                homeDir: homedir(),
                configDir,
                harnessHomes: await resolveHarnessHomes(),
                gatewayRunning: gatewayRunning(configDir),
              });
        const { deps } = hostUpdateDeps({
          plan: install,
          configDir,
          roles,
          yes: offer.yes,
          restart: offer.restart,
          healthTimeoutSec: offer.healthTimeoutSec,
          currentVersion: offer.previousVersion,
        });
        deps.updateLock = lock;
        return deps;
      },
    });
  },
});

export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Update this host to the latest release and restart what it runs",
  },
  subCommands: {
    "adopt-source": adoptSourceCommand,
    "migrate-to-package": migrateToPackageCommand,
    [CONTINUATION_SUBCOMMAND]: continueAfterApplyCommand,
  },
  args: {
    edge: {
      type: "boolean",
      default: false,
      description:
        "Update to the current main build instead of a stable release (source and docker installs)",
    },
    channel: {
      type: "string",
      default: "stable",
      description: `Release channel a package install tracks (${UPDATE_CHANNELS.join(" | ")})`,
    },
    registry: {
      type: "string",
      description: "npm registry a package install resolves against",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Print the plan without running it",
    },
    yes: {
      type: "boolean",
      default: false,
      description: "Skip every confirmation prompt",
    },
    force: {
      type: "boolean",
      default: false,
      description: "Proceed with an unsafe transition (e.g. a downgrade)",
    },
    "allow-rewind": {
      type: "boolean",
      default: false,
      description:
        "Allow a source target that is not a newer release and does not contain this build (implied by --force)",
    },
    backup: {
      type: "boolean",
      default: true,
      description: "Back up before updating a gateway host (pass --no-backup to skip)",
    },
    "health-timeout": {
      type: "string",
      default: String(DEFAULT_HEALTH_TIMEOUT_SEC),
      description: "Seconds to wait for the restarted gateway to serve again",
    },
    "target-version": {
      type: "string",
      description: "Move to this exact release instead of the newest one",
    },
    commit: {
      type: "string",
      description: "Source only: move to this exact full commit id",
    },
    "wait-for-lock": {
      type: "string",
      description:
        "Minutes to wait for another update on this host to finish, instead of refusing (--wait-for-lock=30)",
    },
    restart: {
      type: "boolean",
      default: true,
      description: "Restart what this host runs (pass --no-restart to report them instead)",
    },
    fleet: {
      type: "boolean",
      default: false,
      description: "After this host, tell the gateway's devices to update themselves",
    },
  },
  async run(ctx) {
    // Citty runs a parent command after its subcommand. Only a bare `update`
    // invocation should enter the host update flow.
    const subcommand = (ctx.args._ as string[] | undefined)?.[0];
    if (
      subcommand === "adopt-source" ||
      subcommand === "migrate-to-package" ||
      subcommand === CONTINUATION_SUBCOMMAND
    ) {
      return;
    }

    const dryRun = Boolean(ctx.args["dry-run"]);
    const yes = Boolean(ctx.args.yes);
    const force = Boolean(ctx.args.force);
    const allowRewind = force || Boolean(ctx.args["allow-rewind"]);
    const backup = ctx.args.backup !== false;
    const healthTimeoutSec = parseHealthTimeoutSeconds(ctx.args["health-timeout"]);
    if (healthTimeoutSec === null) {
      throw new CliError(
        `${c.red}Invalid --health-timeout '${String(ctx.args["health-timeout"])}' — expected a whole number of seconds.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const waitForLockMinutes = parseWaitForLockMinutes(ctx.args["wait-for-lock"]);
    if (waitForLockMinutes === null) {
      throw new CliError(
        `${c.red}Invalid --wait-for-lock '${String(ctx.args["wait-for-lock"])}' — expected a whole number ` +
          `of minutes up to ${MAX_WAIT_FOR_LOCK_MINUTES}, as in --wait-for-lock=30.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const configDir = resolveUpdateConfigDir();
    // A container install is read off the operator's config dir, and wins over
    // the path-based detection: this command runs inside a one-shot updater
    // container, so where its own entry script lives says nothing about how
    // the daemons on this host are installed.
    const plan = planUpdate(
      detectDockerInstall(configDir) ?? detectInstallMethod(process.argv[1] ?? ""),
      {
        edge: Boolean(ctx.args.edge),
        channel: String(ctx.args.channel ?? "stable"),
        registry: typeof ctx.args.registry === "string" ? ctx.args.registry : undefined,
      },
    );
    if (plan.kind === "manual") {
      for (const line of manualUpdateInstructions()) {
        console.log(line);
      }
      throw new CliError("", EXIT_USER_ERROR);
    }
    if (plan.kind === "refuse") {
      throw new CliError(`${c.red}${plan.message}${c.reset}`, EXIT_USER_ERROR);
    }

    const restart = ctx.args.restart !== false;
    // A container install's daemons are the services its compose project
    // declares; every other install is read off the host's own service units
    // and state files.
    const roles =
      plan.kind === "docker"
        ? detectDockerRoles(readComposeText(plan.composeFile), plan.composeFile)
        : detectHostRoles({
            platform: process.platform,
            homeDir: homedir(),
            configDir,
            harnessHomes: await resolveHarnessHomes(),
            gatewayRunning: gatewayRunning(configDir),
          });

    const { deps, ensureTrust } = hostUpdateDeps({
      plan,
      configDir,
      roles,
      yes,
      restart,
      healthTimeoutSec,
      currentVersion: readPackageVersion(import.meta.url),
    });
    // The lock this run holds, which is what an offer to the installed build
    // hands over.
    let hostLock: UpdateLock | undefined;
    deps.continueAfterApply = (offer, relay) => {
      const lockId = hostLock?.id;
      if (!lockId) {
        return Promise.resolve({
          accepted: false,
          code: EXIT_FAILURE,
          signal: null,
          detail: "this run holds no update lock to hand over",
        });
      }
      const doc: UpdateContinuation = {
        ...offer,
        version: 1,
        id: randomUUID(),
        lockId,
        state: "offered",
        yes,
        healthTimeoutSec,
      };
      return launchContinuation({
        configDir,
        doc,
        relay,
        command: continuationCommand(offer.subject, doc.id, lockId, {
          env: process.env,
          execPath: process.execPath,
          packageEntry: () => installedPackageEntry(process.argv[1] ?? ""),
          interactive: Boolean(process.stdin.isTTY),
        }),
      });
    };

    const targetVersion =
      typeof ctx.args["target-version"] === "string" && ctx.args["target-version"].trim()
        ? normalizeVersion(ctx.args["target-version"])
        : undefined;
    const targetCommit =
      typeof ctx.args.commit === "string" && ctx.args.commit.trim()
        ? ctx.args.commit.trim()
        : undefined;
    if (targetVersion && !isResolvedVersion(targetVersion)) {
      throw new CliError(
        `${c.red}Invalid --target-version '${targetVersion}' — expected a release like 1.2.3.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (targetVersion && Boolean(ctx.args.edge)) {
      throw new CliError(
        `${c.red}--target-version names a release; --edge follows a branch. Pick one.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (targetCommit && !SOURCE_COMMIT_PATTERN.test(targetCommit)) {
      throw new CliError(
        `${c.red}Invalid --commit '${targetCommit}' — expected a full 40-character lowercase commit id.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (targetCommit && (targetVersion || Boolean(ctx.args.edge))) {
      throw new CliError(
        `${c.red}--commit cannot be combined with --target-version or --edge.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (targetCommit && plan.kind !== "source") {
      throw new CliError(
        `${c.red}--commit is available only for an installer-managed source checkout.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    // What the host actually landed on, filled by `updateHost`. It is what
    // the served-version check compares against, so a fleet is never sent to
    // a version the gateway process has not started serving.
    let landedVersion: string | null = null;
    let landedCommit: string | null = null;
    const updateHost = async (): Promise<void> => {
      await runWithUpdateLock(
        configDir,
        dryRun,
        async (lock, { waitedMs }) => {
          deps.updateLock = lock;
          hostLock = lock;
          lock?.setStep("resolving target");
          if (waitedMs > 0) {
            // The update this run waited for may have replaced the installation
            // this process started from.
            deps.currentVersion = readPackageVersion(import.meta.url, { fresh: true });
          }
          if (plan.kind === "npm-global") {
            landedVersion = await updateNpmGlobal(
              {
                channel: plan.channel,
                registry: plan.registry,
                dryRun,
                force,
                backup,
                targetVersion,
                afterConcurrentUpdate: waitedMs > 0,
              },
              deps,
            );
          } else if (plan.kind === "docker") {
            landedVersion = await updateDocker(
              {
                composeFile: plan.composeFile,
                projectDir: plan.projectDir,
                edge: plan.edge,
                dryRun,
                force,
                backup,
                targetVersion,
              },
              deps,
            );
          } else if (plan.kind === "source") {
            landedVersion = await updateSourceCheckout(
              {
                rootDir: plan.rootDir,
                edge: plan.edge,
                dryRun,
                force,
                allowRewind,
                backup,
                targetVersion,
                targetCommit,
              },
              deps,
            );
            landedCommit = targetCommit ?? null;
          } else {
            assertNever(plan);
          }
        },
        process.env,
        waitForLockMinutes ? { waitForLockMs: waitForLockMinutes * 60_000 } : {},
      );
    };

    if (!ctx.args.fleet) {
      await updateHost();
      return;
    }
    if (plan.kind !== "npm-global" && plan.edge) {
      // The fan-out is only safe because the host's landed release can be
      // compared against the version the gateway is serving. A branch build —
      // a source checkout on origin/main, or a container install on the main
      // image tag — has no release number, so there is nothing to compare and
      // the ordering guarantee would be a formality. A container install on a
      // release tag does have one, and fans out like any other host.
      throw new CliError(
        `${c.red}--fleet needs a release to compare against, which --edge does not have. ` +
          `Update this host with --edge, restart its gateway, then run --fleet.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (dryRun) {
      // The plan is a live read from the gateway, so there is nothing
      // truthful to print before the host has actually moved.
      throw new CliError(
        `${c.red}--dry-run covers this host only; drop --fleet to preview it.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    await ensureTrust();
    const summary = await runFleetUpdate({
      updateHost,
      servedVersion: async () => {
        const health = await gatewayJson<{ version?: string }>("/health");
        if (!health.version)
          throw new CliError(`${c.red}The gateway reported no version.${c.reset}`, EXIT_FAILURE);
        return health.version;
      },
      // On `--edge` there is no release number to compare against, so the
      // served-version check is skipped and the gateway's own target stands.
      hostVersion: () => landedVersion,
      hostCommit: () => landedCommit,
      plan: () =>
        targetCommit
          ? gatewayJson<FleetUpdatePlan>("/admin/fleet/update/plan", {
              method: "POST",
              body: JSON.stringify({ commit: targetCommit }),
            })
          : gatewayJson<FleetUpdatePlan>("/admin/fleet/update"),
      connectedPlan: () => gatewayJson<FleetUpdatePlan>("/admin/fleet/update"),
      command: async (deviceIds) =>
        (
          await gatewayJson<{ devices: FleetUpdateOutcome[] }>("/admin/fleet/update", {
            method: "POST",
            body: JSON.stringify({
              deviceIds,
              ...(targetCommit ? { commit: targetCommit } : {}),
              ...(allowRewind ? { allowRewind: true } : {}),
            }),
          })
        ).devices,
      approve: (message) => approveInteractive(message, yes),
      log: (line) => console.log(line),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }).catch((err) => {
      if (err instanceof FleetUpdateRefused) {
        throw new CliError(`${c.red}${err.message}${c.reset}`, EXIT_USER_ERROR);
      }
      throw err;
    });
    console.log(fleetSummaryLine(summary));
    if (!fleetUpdateSucceeded(summary)) {
      const names = [...summary.failed.map((f) => f.name), ...summary.unanswered].join(", ");
      throw new CliError(
        `${c.red}The fleet update did not finish on ${names}. Each row above says why; ` +
          `fix it on that host or run \`omnesis update --fleet\` again.${c.reset}`,
        EXIT_FAILURE,
      );
    }
  },
});

/** One line accounting for every device the fleet update commanded. */
function fleetSummaryLine(summary: FleetUpdateSummary): string {
  const parts = [
    `${summary.updated.length} updated`,
    ...(summary.restartPending.length ? [`${summary.restartPending.length} restart pending`] : []),
    ...(summary.pending.length ? [`${summary.pending.length} offline (sent on reconnect)`] : []),
    ...(summary.failed.length ? [`${summary.failed.length} failed`] : []),
    ...(summary.unanswered.length ? [`${summary.unanswered.length} without a result`] : []),
  ];
  return `Fleet: ${parts.join(", ")}.`;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The collector's half of a fleet update: run the host's own `omnesis
 * update`, say how it went, and get out of the way so the supervisor brings
 * the process back on the new build.
 *
 * The updater is a port with two implementations. The real one spawns the
 * CLI already installed beside this daemon; the recording one answers from a
 * script, which is what lets the E2E suite prove the whole dispatch path —
 * gateway command, acknowledgement, result event, reconnect — without a git
 * remote or a build anywhere near it.
 *
 * Three properties are load-bearing:
 *
 *   - The command carries a version, never code, and the CLI it invokes
 *     refuses a version that does not resolve to a real tag on this host's
 *     own remote. Nothing here re-implements that check; it belongs where
 *     the remote is.
 *   - `--no-restart` is not an optimisation. The update runs on behalf of the
 *     very daemon its plan would restart, so a restart from inside it would
 *     kill the build half-done. The daemon reports first, then hands itself
 *     over to its service manager for the restart (see `service-restart.ts`).
 *   - Under systemd the update is started by the service manager rather than
 *     forked from this process. A collector unit runs with
 *     `ProtectSystem=strict` and `ProtectHome=read-only`, and a child
 *     inherits that mount namespace — so `git checkout`, `npm ci` and the
 *     build would all meet a read-only filesystem.
 *   - The acknowledgement is immediate. An update is minutes of `npm ci`
 *     and a build, far past any command timeout, so the gateway is told the
 *     work started and learns the outcome from the event that follows.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  capDeviceUpdateDetail,
  createLogger,
  DEFAULT_CONFIG_DIR,
  getUpdateLockProcessGroup,
  summarizeCommandFailure,
  UPDATE_LOCK_ENV,
  UpdateLockBusyError,
  updateLockHolderLabel,
  waitForUpdateLock,
  type UpdateLock,
  type WsEventPayload,
  type WsResponsePayload,
} from "@omnesis/core";
import type { CommandDispatch } from "./ws-command-dispatch.js";

const log = createLogger("collector").child("self-update");

/** How a self-update ended, in the vocabulary the gateway records. */
export interface SelfUpdateAttempt {
  state: "installed" | "restart-pending" | "failed";
  /** One line for the operator: the failure, or the restart still owed. */
  detail?: string;
  /** Keep the host fenced when a timed-out updater could not be proven stopped. */
  retainLock?: boolean;
  /** A later service-manager close can prove a retained fence is safe to release. */
  releaseFenceWhenStopped?: Promise<void>;
}

/** Runs one local update. The seam the E2E replaces. */
export interface SelfUpdater {
  run(
    target: ({ version: string } | { commit: string }) & {
      /** The operator allowed a target that neither contains this build nor is a newer release. */
      allowRewind?: boolean;
      lockId: string;
      /**
       * What is left of the command's overall deadline once this host's update
       * lock was free, when waiting for it used some. Absent means all of it.
       */
      budgetMs?: number;
    },
  ): Promise<SelfUpdateAttempt>;
}

/**
 * The `omnesis` this daemon updates through.
 *
 * A service manager starts a daemon with a minimal environment, so PATH here
 * is systemd's default or launchd's — neither of which carries `~/.local/bin`,
 * where the source installer puts its wrapper. Looking there first is what
 * makes a supervised collector able to update itself at all; `OMNESIS_CLI_BIN`
 * is the override for a layout neither guess fits, and a bare `omnesis` is the
 * last resort that works for a package install under `/usr/local/bin`.
 */
export function resolveCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMNESIS_CLI_BIN?.trim();
  if (override) return override;
  const wrapper = join(env.HOME ?? homedir(), ".local", "bin", "omnesis");
  return existsSync(wrapper) ? wrapper : "omnesis";
}

/**
 * How the update is invoked from a daemon.
 *
 * The version is passed as a single `--target-version=<v>` token so that a
 * value can never be read as a separate flag, whatever the argument parser
 * does with a string that begins with a dash.
 *
 * Under systemd the command is handed to the service manager as a transient
 * unit rather than forked from this process. A collector unit is sandboxed
 * (`ProtectSystem=strict`, `ProtectHome=read-only`) and a child inherits its
 * mount namespace, so an update forked from here would find the checkout and
 * the package prefix read-only. `INVOCATION_ID` is set by systemd on exactly
 * the invocations that have that sandbox; `--wait --pipe` give back the
 * transient unit's exit status and its output, `--quiet` keeps systemd-run's
 * own status lines out of that output, and `--collect` reaps it.
 *
 * `--wait-for-lock` is carried for the CLI's own acquisition. This daemon
 * takes the host update lock itself and hands it to the CLI, which then has
 * nothing to wait for; the flag is what keeps the command a waiter on any path
 * that reaches the CLI without that hand-off.
 *
 * A transient unit starts from the user manager's environment rather than
 * this process's, so what the update needs is carried across explicitly —
 * see `forwardedEnvironment`.
 *
 * A launchd agent has no equivalent sandbox, and a daemon started by hand has
 * none either, so both run the CLI directly.
 */
export function updateInvocation(
  cliPath: string,
  requested: string | (({ version: string } | { commit: string }) & { allowRewind?: boolean }),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  waitForLockMinutes = lockWaitMinutes(SELF_UPDATE_DEADLINE_MS),
): {
  command: string;
  args: string[];
  stop?: { command: string; args: string[]; force: { command: string; args: string[] } };
} {
  const target = typeof requested === "string" ? { version: requested } : requested;
  const args = [
    "update",
    "--yes",
    "--no-restart",
    "version" in target ? `--target-version=${target.version}` : `--commit=${target.commit}`,
    ...(typeof requested !== "string" && requested.allowRewind ? ["--allow-rewind"] : []),
    `--wait-for-lock=${waitForLockMinutes}`,
  ];
  if (platform === "linux" && env.INVOCATION_ID) {
    const lockSuffix = env[UPDATE_LOCK_ENV]?.replaceAll(/[^a-zA-Z0-9_-]/g, "");
    const unit = lockSuffix ? `omnesis-update-${lockSuffix}.service` : undefined;
    return {
      command: "systemd-run",
      args: [
        "--user",
        "--wait",
        "--pipe",
        "--quiet",
        "--collect",
        ...(unit ? [`--unit=${unit}`] : []),
        ...(unit ? ["--property=KillMode=control-group"] : []),
        ...forwardedEnvironment(env).map((pair) => `--setenv=${pair}`),
        "--",
        cliPath,
        ...args,
      ],
      ...(unit
        ? {
            stop: {
              command: "systemctl",
              args: ["--user", "stop", unit],
              force: {
                command: "systemctl",
                args: ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit],
              },
            },
          }
        : {}),
    };
  }
  return { command: cliPath, args };
}

/**
 * The environment a transient unit needs carried across to it.
 *
 * A transient unit inherits the user manager's environment, not this
 * process's, and the collector unit deliberately bakes in two things the
 * update cannot do without: a PATH that can find node, and the config
 * directory that tells the update which installation it is looking at. On a
 * host where either is non-default, an update that lost them would build with
 * the wrong node or inspect the wrong install.
 *
 * Values that look like a secret rather than a path are deliberately left
 * behind: a transient unit's properties are readable through `systemctl
 * show`, and nothing the update does needs one — the CLI reads its credentials
 * from the config directory it is given.
 */
function forwardedEnvironment(env: NodeJS.ProcessEnv): string[] {
  const carried = ["HOME", "PATH", "LANG", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"];
  const pairs = ["NO_COLOR=1"];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!carried.includes(name) && !name.startsWith("OMNESIS_")) continue;
    if (SECRET_ENV.test(name)) continue;
    // `--setenv=NAME=value` is one argv token; a newline in a value would end
    // the unit property early, so such a value is not carried at all.
    if (/[\r\n]/.test(value)) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs;
}

/** Names whose value is a credential rather than a path to one. */
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|_KEY)$|PASSPHRASE(?!_FILE)/u;

/**
 * How much of the update's output is kept for the summary that comes back to
 * the gateway. A failing build is verbose and only its tail explains itself.
 */
const CAPTURED_OUTPUT_BYTES = 8_000;

/**
 * How long the update may run before this daemon stops believing in it. A
 * cold `npm ci` plus a full build on a small host is minutes, so the budget
 * is generous — but unbounded is worse than long: a wedged child never
 * settles, no result is ever reported, and the gateway's row reads
 * "dispatched" forever.
 */
export const SELF_UPDATE_DEADLINE_MS = 45 * 60 * 1_000;

/**
 * How long a command waits for another update on this host — a harness
 * plugin's, commanded by the same fleet update — to release the host lock.
 * The wait counts against `SELF_UPDATE_DEADLINE_MS`, and this leaves a third
 * of it for the update itself, which is ample when the other update already
 * installed the target and there is nothing left to build.
 */
export const SELF_UPDATE_LOCK_WAIT_MS = lockWaitMinutes(SELF_UPDATE_DEADLINE_MS) * 60_000;

/** Two thirds of a deadline, in whole minutes: the part a lock wait may use. */
export function lockWaitMinutes(deadlineMs: number): number {
  return Math.max(1, Math.floor((deadlineMs * 2) / 3 / 60_000));
}

function signalUpdaterTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill(signal);
}

function signalPublishedApplyGroup(configDir: string, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32") return true;
  const group = getUpdateLockProcessGroup(configDir);
  if (group.state === "none") {
    log.warn("The unresponsive updater published no apply process group");
    return false;
  }
  if (group.state === "gone") return true;
  if (group.state === "unverified") {
    log.warn(`Refusing to signal reused or unverifiable update process group ${group.pid}`);
    return false;
  }
  try {
    process.kill(-group.pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
    log.warn(`Could not signal update process group ${group.pid} with ${signal}`);
    return false;
  }
}

/**
 * The real updater: the CLI installed on this host, run against this host's
 * own remote.
 *
 * The whole output is captured rather than streamed, because the useful part
 * of a failure is its last few lines and there is no terminal here to stream
 * to — the daemon's log is where this ends up either way.
 */
export function createCliUpdater(
  opts: {
    cliPath?: string;
    spawnFn?: typeof spawn;
    deadlineMs?: number;
    stopGraceMs?: number;
    configDir?: string;
    /** Test seams: production intentionally follows the daemon's real host context. */
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): SelfUpdater {
  const hostEnv = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const cliPath = opts.cliPath ?? resolveCliPath(hostEnv);
  const spawnProcess = opts.spawnFn ?? spawn;
  const deadlineMs = opts.deadlineMs ?? SELF_UPDATE_DEADLINE_MS;
  const stopGraceMs = opts.stopGraceMs ?? 10_000;
  const configDir = opts.configDir ?? hostEnv.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  return {
    run: ({ lockId, budgetMs, ...target }) =>
      new Promise<SelfUpdateAttempt>((resolve) => {
        const limitMs = Math.max(0, Math.min(deadlineMs, budgetMs ?? deadlineMs));
        const limitMinutes = Math.round(limitMs / 60_000);
        const env = {
          ...hostEnv,
          NO_COLOR: "1",
          [UPDATE_LOCK_ENV]: lockId,
        };
        const invocation = updateInvocation(
          cliPath,
          target,
          env,
          platform,
          lockWaitMinutes(limitMs),
        );
        log.info(`Running ${invocation.command} ${invocation.args.join(" ")}`);
        const child = spawnProcess(invocation.command, invocation.args, {
          stdio: ["ignore", "pipe", "pipe"],
          env,
          detached: invocation.command !== "systemd-run" && platform !== "win32",
        });
        let confirmStopped!: () => void;
        const stopped = new Promise<void>((resolveStopped) => {
          confirmStopped = resolveStopped;
        });
        let settled = false;
        let timedOut = false;
        let escalation: NodeJS.Timeout | null = null;
        const settle = (attempt: SelfUpdateAttempt): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (escalation) clearTimeout(escalation);
          resolve(attempt);
        };
        const deadline = setTimeout(() => {
          timedOut = true;
          if (invocation.stop) {
            let forceRequested = false;
            const retainFence = (): void => {
              settle({
                state: "failed",
                retainLock: true,
                releaseFenceWhenStopped: stopped,
                detail:
                  `The update exceeded ${limitMinutes} minutes, and systemd ` +
                  "could not prove its transient unit stopped. The host update lock remains held.",
              });
            };
            const stopWaiter = (): void => {
              child.kill("SIGKILL");
            };
            const force = (): void => {
              if (forceRequested) return;
              forceRequested = true;
              let killer: ReturnType<typeof spawn>;
              try {
                killer = spawnProcess(invocation.stop!.force.command, invocation.stop!.force.args, {
                  stdio: "ignore",
                  env,
                });
              } catch {
                retainFence();
                return;
              }
              killer.on("error", () => {
                retainFence();
              });
              killer.on("close", () => {
                // `systemctl kill` returning only proves the signal was
                // dispatched. The systemd-run waiter must close before the
                // unit is known to be gone and the fence can be released.
                retainFence();
              });
            };
            let stopper: ReturnType<typeof spawn>;
            try {
              stopper = spawnProcess(invocation.stop.command, invocation.stop.args, {
                stdio: "ignore",
                env,
              });
            } catch {
              force();
              return;
            }
            stopper.on("error", force);
            stopper.on("close", (code) => {
              if (code === 0) stopWaiter();
              else force();
            });
            escalation = setTimeout(force, stopGraceMs);
          } else {
            signalUpdaterTree(child, "SIGTERM");
            escalation = setTimeout(() => {
              if (!signalPublishedApplyGroup(configDir, "SIGKILL")) {
                settle({
                  state: "failed",
                  retainLock: true,
                  detail:
                    `The update exceeded ${limitMinutes} minutes, and its ` +
                    "apply process group could not be safely identified. The host update lock remains held.",
                });
                return;
              }
              signalUpdaterTree(child, "SIGKILL");
            }, stopGraceMs);
          }
          escalation?.unref();
        }, limitMs);
        deadline.unref();
        // Everything, for context, and stderr alone, where the CLI writes its
        // refusal: the summary prefers the latter so progress lines printed
        // just before a failure never stand in for it.
        let output = "";
        let errors = "";
        const collect = (chunk: Buffer): void => {
          output = `${output}${chunk.toString()}`.slice(-CAPTURED_OUTPUT_BYTES);
        };
        child.stdout?.on("data", collect);
        child.stderr?.on("data", (chunk: Buffer) => {
          collect(chunk);
          errors = `${errors}${chunk.toString()}`.slice(-CAPTURED_OUTPUT_BYTES);
        });
        child.on("error", (err) => {
          settle({
            state: "failed",
            detail:
              `Could not start \`${invocation.command}\` on this host: ${err.message}. ` +
              `Set OMNESIS_CLI_BIN if the CLI is installed elsewhere.`,
          });
        });
        child.on("close", (code) => {
          confirmStopped();
          if (timedOut) {
            const group = getUpdateLockProcessGroup(configDir);
            if (!invocation.stop && group.state !== "none" && group.state !== "gone") {
              settle({
                state: "failed",
                retainLock: true,
                detail:
                  `The update exceeded ${limitMinutes} minutes, and its ` +
                  "detached apply process has not been proven stopped. The host update lock remains held.",
              });
              return;
            }
            settle({
              state: "failed",
              detail: `The update did not finish within ${limitMinutes} minutes and was stopped.`,
            });
            return;
          }
          if (code === 0) {
            const label =
              "version" in target ? target.version : `commit ${target.commit.slice(0, 12)}`;
            settle({ state: "installed", detail: `Installed ${label}; restarting.` });
            return;
          }
          const summary = summarizeCommandFailure(errors) || summarizeCommandFailure(output);
          settle({
            state: "failed",
            detail:
              `\`${invocation.command} … update\` exited ${code ?? "with no code"}. ${summary}`.trimEnd(),
          });
        });
      }),
  };
}

/** A `SelfUpdater` that records what it was asked and answers from a script. */
export interface RecordingUpdater extends SelfUpdater {
  /** Every version this updater was asked for, in order. */
  readonly calls: string[];
  /** What the next run answers with. */
  answer: SelfUpdateAttempt;
}

export function createRecordingUpdater(
  answer: SelfUpdateAttempt = { state: "installed" },
): RecordingUpdater {
  const calls: string[] = [];
  const updater: RecordingUpdater = {
    calls,
    answer,
    run: async (target) => {
      calls.push("version" in target ? target.version : target.commit);
      return updater.answer;
    },
  };
  return updater;
}

export interface SelfUpdateDeps {
  updater: SelfUpdater;
  /** The product version this process is running. */
  currentVersion: string;
  /**
   * Acquire the same config-directory lock used by operator updates. Throws
   * `UpdateLockBusyError` while another update holds it.
   */
  acquireLock(): Pick<UpdateLock, "id" | "release">;
  /** How long a command waits for that lock. Defaults to `SELF_UPDATE_LOCK_WAIT_MS`. */
  lockWaitMs?: number;
  /** Test seam for the pause between attempts on the lock. */
  sleep?(ms: number): Promise<void>;
  /** Report the outcome to the gateway. */
  emitResult(payload: WsEventPayload<"device.update.result">): void;
  /**
   * Hand the process over to its supervisor once the new build is on disk.
   * Production asks its own service unit for a restart, and exits non-zero
   * where it runs under none it can identify — a clean exit parks the unit
   * under both systemd's `Restart=on-failure` and launchd's `KeepAlive`, and
   * this process must come back. Omitted where nothing should exit.
   */
  handOver?(): void;
}

/**
 * Register the `device.update` handler.
 *
 * The version's shape is not re-checked here: `device.update`'s request
 * schema accepts a release version and nothing else, and the dispatch parses
 * every payload against it before a handler sees it.
 *
 * Only one update runs in this process at a time: a second command while one
 * is in flight is refused rather than queued, because the gateway asks again
 * on the next reconnect. Another process's update on this host — a harness
 * plugin commanded by the same fleet update — is waited for instead: the
 * command is accepted, the host lock is taken once that update releases it or
 * is proven dead, and the wait counts against the update's deadline. Two
 * `npm ci` runs in one checkout corrupt each other, so the lock is never
 * shared.
 */
export function registerSelfUpdateCommand(dispatch: CommandDispatch, deps: SelfUpdateDeps): void {
  let handoverPending = false;
  let inFlight = false;
  dispatch.register("device.update", (target): WsResponsePayload<"device.update"> => {
    const label = "version" in target ? target.version : `commit ${target.commit.slice(0, 12)}`;
    if ("version" in target && target.version === deps.currentVersion) {
      return { accepted: false, reason: `Already running ${target.version}.` };
    }
    if (handoverPending) {
      return { accepted: false, reason: "This host is restarting after its completed update." };
    }
    if (inFlight) {
      return { accepted: false, reason: "An update is already running on this collector." };
    }
    let lock: Pick<UpdateLock, "id" | "release"> | null = null;
    let busy: UpdateLockBusyError | null = null;
    try {
      lock = deps.acquireLock();
    } catch (err) {
      if (!(err instanceof UpdateLockBusyError)) {
        return {
          accepted: false,
          reason: err instanceof Error ? err.message : "Another update is running on this host.",
        };
      }
      busy = err;
    }
    inFlight = true;
    log.info(`Gateway asked this host to update itself to ${label}`);

    void (async () => {
      let held = lock;
      let waitedMs = 0;
      let attempt: SelfUpdateAttempt;
      if (!held) {
        const holder = busy?.holder ? updateLockHolderLabel(busy.holder) : "another update";
        log.info(`Waiting for ${holder} to finish before updating to ${label}`);
        try {
          const acquired = await waitForUpdateLock(deps.acquireLock, {
            waitMs: deps.lockWaitMs ?? SELF_UPDATE_LOCK_WAIT_MS,
            ...(deps.sleep ? { sleep: deps.sleep } : {}),
          });
          held = acquired.lock;
          waitedMs = acquired.waitedMs;
        } catch (err) {
          held = null;
          attempt = {
            state: "failed",
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }
      if (held) {
        try {
          attempt = await deps.updater.run({
            ...target,
            lockId: held.id,
            ...(waitedMs > 0 ? { budgetMs: SELF_UPDATE_DEADLINE_MS - waitedMs } : {}),
          });
        } catch (err) {
          attempt = {
            state: "failed",
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }
      const outcome = attempt!;
      const release = (): void => {
        held?.release();
        inFlight = false;
      };
      let handOver = false;
      try {
        // Reported before the hand-over, because the process is about to stop
        // and this is the only account of what happened that survives it.
        // Capped to what the gateway accepts: a longer detail fails the event's
        // schema, and the row would read "dispatched" with no result at all.
        deps.emitResult({
          ...("version" in target ? { version: target.version } : { commit: target.commit }),
          state: outcome.state,
          detail: outcome.detail === undefined ? undefined : capDeviceUpdateDetail(outcome.detail),
        });
        if (outcome.state === "failed") {
          log.error(`Self-update to ${label} failed: ${outcome.detail ?? "no detail"}`);
          return;
        }
        log.info(`Self-update to ${label}: ${outcome.state}`);
        handOver = true;
        handoverPending = true;
      } finally {
        // A successful production hand-over exits the process; the lock's
        // exit hook releases it then. Ordinary failures release immediately
        // for a retry. An updater that could not be proven stopped keeps the
        // lock as a deliberate safety fence, and this process counts as still
        // updating until that fence comes down.
        if (!handOver && !outcome.retainLock) release();
        if (!handOver && outcome.retainLock && outcome.releaseFenceWhenStopped) {
          void outcome.releaseFenceWhenStopped.then(release);
        }
      }
      if (handOver) {
        if (!deps.handOver) {
          handoverPending = false;
          release();
          return;
        }
        try {
          deps.handOver();
        } catch (err) {
          handoverPending = false;
          release();
          throw err;
        }
      }
    })();

    return { accepted: true };
  });
}

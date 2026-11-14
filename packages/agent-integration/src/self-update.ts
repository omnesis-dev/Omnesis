// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A harness plugin's half of a fleet update.
 *
 * The gateway names a version; the `omnesis` CLI installed on this harness
 * machine does the work, including reinstalling the plugin into the harness's
 * own extension directory. The CLI stops there, and the plugin then restarts
 * the harness itself so the new build is loaded straight away — interrupting
 * any agent run in progress, which is the price of an update that needs no
 * one at the machine. The restart is launched detached, because it stops the
 * very process that launches it. When it cannot be started, the plugin
 * reports the restart still owed and names the command.
 *
 * This package depends on nothing else in the workspace at runtime, because
 * it is installed on a machine with no Omnesis checkout. The port below is
 * therefore its own, and the restart command is spelled out here rather than
 * imported from the CLI's plan builder.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { summarizeCommandFailure } from "./command-output.js";
import {
  resolveHarnessBinary,
  resolveHarnessCommand,
  harnessSearchPath,
} from "./harness-command.js";
import { runHarnessUpdateProcess } from "./harness-update-process.js";
import type { Harness } from "./protocol.js";
export { resolveHarnessBinary } from "./harness-command.js";

/** How a self-update ended, in the vocabulary the gateway records. */
export interface HarnessUpdateAttempt {
  state: "installed" | "restart-pending" | "failed";
  detail?: string;
  /**
   * The harness restart that loads the installed plugin. Present only on an
   * `installed` attempt; the caller starts it once that result is on the wire.
   */
  restart?: HarnessRestart;
}

/** A harness restart, resolved and ready to launch. */
export interface HarnessRestart {
  /** The command line as it will run, for the log. */
  command: string;
  /**
   * Launch the restart detached from this process. `onFailure` receives the
   * `restart-pending` detail when the command cannot be started, or exits
   * non-zero while this process is still alive to hear it; it is called at
   * most once, and never when the restart goes ahead.
   */
  start(onFailure: (detail: string) => void): void;
}

/** Runs one local update. Replaced wholesale in tests. */
export interface HarnessSelfUpdater {
  run(
    target: ({ version: string } | { commit: string }) & { allowRewind?: boolean },
  ): Promise<HarnessUpdateAttempt>;
}

export type HarnessUpdateTarget = Parameters<HarnessSelfUpdater["run"]>[0];

export function updateTargetLabel(target: HarnessUpdateTarget): string {
  return "version" in target ? target.version : `commit ${target.commit}`;
}

/**
 * What an operator runs to load a refreshed plugin.
 *
 * The CLI's `harnessRestartSpec` builds the same line for the plan it prints
 * on the harness host; both are asserted against this literal by their own
 * suites.
 */
export function harnessRestartCommand(harness: Harness): string {
  return `${harness} gateway restart`;
}

/**
 * What a `restart-pending` result says when the plugin could not restart the
 * harness itself: why, then the command the operator runs instead.
 */
export function restartOwedDetail(harness: Harness, version: string, reason: string): string {
  return (
    `Installed ${version}. Restarting ${harness} failed: ${reason}. ` +
    `Restart ${harness} to load it: ${harnessRestartCommand(harness)}`
  );
}

/**
 * The harness executable a restart runs. A harness started by a service
 * manager inherits a minimal PATH, so after PATH come the places an install
 * lands without being on it: beside the Node running this plugin (a global
 * npm install), the npm user prefix, `~/.local/bin`, and the Homebrew and
 * `/usr/local` prefixes. Null when none holds an executable.
 */
/**
 * Prepare `<binary> gateway restart` to run detached: its own process group,
 * no stdio, unreferenced, so it outlives the harness it stops and nothing in
 * this process waits for it. The binary's directory and this Node's lead
 * PATH, so a harness executable that starts with `#!/usr/bin/env node` still
 * finds an interpreter under a service manager's PATH.
 */
export function detachedHarnessRestart(opts: {
  harness: Harness;
  version: string;
  binary: string;
  spawnFn?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}): HarnessRestart {
  const spawnProcess = opts.spawnFn ?? spawn;
  const env = opts.env ?? process.env;
  const args = ["gateway", "restart"];
  const command = [opts.binary, ...args].join(" ");
  return {
    command,
    start(onFailure) {
      let reported = false;
      const fail = (reason: string): void => {
        if (reported) return;
        reported = true;
        onFailure(restartOwedDetail(opts.harness, opts.version, reason));
      };
      const path = [
        dirname(opts.binary),
        dirname(opts.execPath ?? process.execPath),
        harnessSearchPath(env),
      ]
        .filter((entry): entry is string => Boolean(entry))
        .join(delimiter);
      let child: ReturnType<typeof spawn>;
      try {
        const invocation = resolveHarnessCommand(opts.binary, args, {
          env,
          execPath: opts.execPath,
        });
        child = spawnProcess(invocation.command, invocation.args, {
          detached: true,
          stdio: "ignore",
          env: { ...env, PATH: path },
        });
      } catch (error) {
        fail(`\`${command}\` could not be started (${errorMessage(error)})`);
        return;
      }
      child.once("error", (error) => {
        fail(`\`${command}\` could not be started (${error.message})`);
      });
      // A signal means the restart was stopped along with the harness it
      // restarts, which is not evidence it failed; only an exit code is.
      child.once("exit", (code) => {
        if (code !== null && code !== 0) fail(`\`${command}\` exited ${code}`);
      });
      child.unref();
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `omnesis` this plugin updates through. The source installer's wrapper
 * lives at `~/.local/bin/omnesis`, which a harness started by a service
 * manager will not have on PATH; `OMNESIS_CLI_BIN` overrides both guesses.
 */
export function resolveCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMNESIS_CLI_BIN?.trim();
  if (override) return override;
  const wrapper = join(env.HOME ?? homedir(), ".local", "bin", "omnesis");
  if (process.platform === "win32")
    return [wrapper + ".exe", wrapper + ".cmd"].find((path) => existsSync(path)) ?? "omnesis";
  return existsSync(wrapper) ? wrapper : "omnesis";
}

/**
 * How long the update may run before this plugin stops believing in it. A
 * cold install plus a build is minutes, so the budget is generous — but
 * unbounded is worse than long: a wedged child never settles, no result is
 * ever reported, and the gateway's row reads "dispatched" forever.
 */
const UPDATE_DEADLINE_MS = 45 * 60 * 1_000;

/**
 * How long the CLI may wait for another update on this machine — typically
 * the collector's, commanded by the same fleet update — before it gives up.
 * Two thirds of the deadline, which the wait counts against, so what is left
 * still covers an install when the other update did not already do it.
 */
export function lockWaitMinutes(deadlineMs: number): number {
  return Math.max(1, Math.floor((deadlineMs * 2) / 3 / 60_000));
}

/**
 * The real updater: the CLI installed on this harness machine.
 *
 * `--no-restart` covers both daemons and the harness itself, so what comes
 * back is a plugin on disk. A clean exit is `installed` with the harness
 * restart attached for the caller to start, or `restart-pending` when no
 * harness executable can be found to run it. The target is one
 * `--target-version=<v>` or `--commit=<sha>` token, so it can never be read as
 * a separate flag whatever the argument parser does with its value.
 * `--wait-for-lock` makes an update already running here — the collector's,
 * commanded by the same fleet update — something to wait for rather than a
 * refusal.
 */
export function createHarnessCliUpdater(opts: {
  harness: Harness;
  cliPath?: string;
  spawnFn?: typeof spawn;
  deadlineMs?: number;
  /** Explicit cancellation by the host; ordinary plugin stop does not cancel an update. */
  signal?: AbortSignal;
  resolveHarness?: (harness: Harness) => string | null;
}): HarnessSelfUpdater {
  const cliPath = opts.cliPath ?? resolveCliPath();
  const resolveHarness = opts.resolveHarness ?? ((harness) => resolveHarnessBinary(harness));
  const spawnProcess = opts.spawnFn ?? spawn;
  const deadlineMs = opts.deadlineMs ?? UPDATE_DEADLINE_MS;
  return {
    run: async (target) => {
      const label = updateTargetLabel(target);
      const targetArg =
        "version" in target ? `--target-version=${target.version}` : `--commit=${target.commit}`;
      const result = await runHarnessUpdateProcess(
        cliPath,
        [
          "update",
          "--yes",
          "--no-restart",
          targetArg,
          ...(target.allowRewind ? ["--allow-rewind"] : []),
          `--wait-for-lock=${lockWaitMinutes(deadlineMs)}`,
        ],
        { deadlineMs, signal: opts.signal, spawnFn: opts.spawnFn },
      );
      if (result.failure === "timeout")
        return {
          state: "failed",
          detail: `The update did not finish within ${Math.round(deadlineMs / 60_000)} minutes and was stopped.`,
        };
      if (result.failure === "cancelled")
        return { state: "failed", detail: "The update was cancelled and its process was stopped." };
      if (result.failure === "spawn")
        return {
          state: "failed",
          detail: `Could not run \`${cliPath} update\` on this machine: ${errorMessage(result.cause)}. Set OMNESIS_CLI_BIN if the CLI is installed elsewhere.`,
        };
      if (result.code === 0) {
        const binary = resolveHarness(opts.harness);
        if (binary === null)
          return {
            state: "restart-pending",
            detail: restartOwedDetail(
              opts.harness,
              label,
              `\`${opts.harness}\` was not found on this machine`,
            ),
          };
        const restart = detachedHarnessRestart({
          harness: opts.harness,
          version: label,
          binary,
          spawnFn: spawnProcess,
        });
        return {
          state: "installed",
          detail: `Installed ${label}; restarting ${opts.harness} now: ${restart.command}`,
          restart,
        };
      }
      const summary =
        summarizeCommandFailure(result.errors) || summarizeCommandFailure(result.output);
      return {
        state: "failed",
        detail:
          `\`${cliPath} update\` exited ${result.code ?? "with no code"}. ${summary}`.trimEnd(),
      };
    },
  };
}

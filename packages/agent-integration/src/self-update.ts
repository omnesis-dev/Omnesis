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
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { summarizeCommandFailure } from "./command-output.js";
import type { Harness } from "./protocol.js";

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
export function resolveHarnessBinary(
  harness: Harness,
  opts: {
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    isExecutable?: (path: string) => boolean;
  } = {},
): string | null {
  const env = opts.env ?? process.env;
  const home = env.HOME ?? homedir();
  const isExecutable = opts.isExecutable ?? executableFile;
  const directories = [
    ...(env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0),
    dirname(opts.execPath ?? process.execPath),
    join(home, ".npm-global", "bin"),
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const directory of directories) {
    const candidate = join(directory, harness);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

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
      const path = [dirname(opts.binary), dirname(opts.execPath ?? process.execPath), env.PATH]
        .filter((entry): entry is string => Boolean(entry))
        .join(delimiter);
      let child: ReturnType<typeof spawn>;
      try {
        child = spawnProcess(opts.binary, args, {
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
  return existsSync(wrapper) ? wrapper : "omnesis";
}

/**
 * How much of the update's output is kept for the summary reported back. A
 * failing build is verbose and only its tail explains itself.
 */
const CAPTURED_OUTPUT_BYTES = 8_000;

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
  resolveHarness?: (harness: Harness) => string | null;
}): HarnessSelfUpdater {
  const cliPath = opts.cliPath ?? resolveCliPath();
  const resolveHarness = opts.resolveHarness ?? ((harness) => resolveHarnessBinary(harness));
  const spawnProcess = opts.spawnFn ?? spawn;
  const deadlineMs = opts.deadlineMs ?? UPDATE_DEADLINE_MS;
  return {
    run: (target) =>
      new Promise<HarnessUpdateAttempt>((resolve) => {
        const label = updateTargetLabel(target);
        const targetArg =
          "version" in target ? `--target-version=${target.version}` : `--commit=${target.commit}`;
        const child = spawnProcess(
          cliPath,
          [
            "update",
            "--yes",
            "--no-restart",
            targetArg,
            ...(target.allowRewind ? ["--allow-rewind"] : []),
            `--wait-for-lock=${lockWaitMinutes(deadlineMs)}`,
          ],
          { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
        );
        let settled = false;
        const settle = (attempt: HarnessUpdateAttempt): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve(attempt);
        };
        const deadline = setTimeout(() => {
          child.kill("SIGKILL");
          settle({
            state: "failed",
            detail: `The update did not finish within ${Math.round(deadlineMs / 60_000)} minutes and was stopped.`,
          });
        }, deadlineMs);
        deadline.unref?.();
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
        child.on("error", (error) => {
          settle({
            state: "failed",
            detail:
              `Could not run \`${cliPath} update\` on this machine: ${error.message}. ` +
              `Set OMNESIS_CLI_BIN if the CLI is installed elsewhere.`,
          });
        });
        child.on("close", (code) => {
          if (code === 0) {
            const binary = resolveHarness(opts.harness);
            if (binary === null) {
              settle({
                state: "restart-pending",
                detail: restartOwedDetail(
                  opts.harness,
                  label,
                  `\`${opts.harness}\` was not found on this machine`,
                ),
              });
              return;
            }
            const restart = detachedHarnessRestart({
              harness: opts.harness,
              version: label,
              binary,
              spawnFn: spawnProcess,
            });
            settle({
              state: "installed",
              detail: `Installed ${label}; restarting ${opts.harness} now: ${restart.command}`,
              restart,
            });
            return;
          }
          const summary = summarizeCommandFailure(errors) || summarizeCommandFailure(output);
          settle({
            state: "failed",
            detail: `\`${cliPath} update\` exited ${code ?? "with no code"}. ${summary}`.trimEnd(),
          });
        });
      }),
  };
}

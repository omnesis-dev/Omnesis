// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Bring a Docker install's host launcher — the `omnesis` command the
 * installer writes to `~/.local/bin` — up to the release an update installed.
 *
 * The launcher is the one part of a container install that lives on the host
 * rather than in an image, so pulling new images leaves it as the release
 * that installed it wrote it. Commands that need the host's help (`secure`
 * restarts the containers it changed) would then run new code behind an old
 * launcher. The updater refreshes it after the containers are on the new
 * release: it renders the launcher with the installer's own renderer
 * (`install.sh --print-docker-launcher`, shipped in the updater image), and
 * reads and replaces the file through a one-shot container of the updater
 * service that mounts that one host directory — the updater itself sees only
 * the config directory and the Docker socket.
 *
 * Only a file that is demonstrably this install's launcher is replaced: the
 * installer's header, naming this compose file. Anything else at that path is
 * left alone and the operator told how to refresh it.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The launcher's host path, which the installer gives the updater service. */
export const DOCKER_LAUNCHER_ENV = "OMNESIS_DOCKER_LAUNCHER";
/** The installer's second line in every launcher it writes. */
export const LAUNCHER_HEADER = "# Omnesis in Docker — written by install.sh --docker.";

export interface LauncherRun {
  command: string;
  args: string[];
  input?: string;
}

export interface LauncherDeps {
  run(spec: LauncherRun): Promise<{ code: number; stdout: string; stderr: string }>;
  /** The installer that renders the launcher, or null when this build has none. */
  installScript(): string | null;
  env: NodeJS.ProcessEnv;
  log(line: string): void;
}

export type LauncherRefresh = "refreshed" | "current" | "skipped";

/**
 * Where this install's launcher is on the host: recorded by the installer in
 * the updater's environment, or — for an install that predates the record —
 * where the installer always writes it, `$HOME/.local/bin/omnesis`, when the
 * config directory is the default one under that same home.
 */
export function dockerLauncherPath(projectDir: string, env: NodeJS.ProcessEnv): string | null {
  const recorded = env[DOCKER_LAUNCHER_ENV];
  if (recorded && isAbsolute(recorded)) return recorded;
  const home = projectDir.match(/^(\/.+)\/\.config\/omnesis\/?$/u)?.[1];
  return home ? join(home, ".local", "bin", "omnesis") : null;
}

/** The service a launcher runs its commands in, when it is this install's launcher. */
export function launcherService(text: string, composeFile: string): "gateway" | "collector" | null {
  const [shebang, header, compose, service] = text.split("\n");
  if (shebang !== "#!/bin/sh" || header !== LAUNCHER_HEADER) return null;
  if (compose !== `COMPOSE_FILE='${composeFile}'`) return null;
  const match = service?.match(/^SERVICE='(gateway|collector)'$/u);
  return match ? (match[1] as "gateway" | "collector") : null;
}

/** A one-shot container of the updater service with the launcher's directory mounted. */
function launcherContainer(composeFile: string, launcher: string, tail: string[]): LauncherRun {
  const dir = dirname(launcher);
  return {
    command: "docker",
    args: [
      "compose",
      "-f",
      composeFile,
      "--profile",
      "update",
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--volume",
      `${dir}:${dir}`,
      ...tail,
    ],
  };
}

/** Replace the launcher in one rename, so a shell starting it sees one whole file. */
const WRITE_SCRIPT = 'set -eu; t="$1.omnesis-update"; cat > "$t"; chmod 755 "$t"; mv -f "$t" "$1"';

export async function refreshDockerLauncher(
  opts: { composeFile: string; projectDir: string },
  deps: LauncherDeps,
): Promise<LauncherRefresh> {
  const rerun = "re-run the installer with the options you installed with";
  const launcher = dockerLauncherPath(opts.projectDir, deps.env);
  if (!launcher) {
    deps.log(
      `! The omnesis command on this host was not refreshed: this install does not record where it is. To bring it up to this release, ${rerun}.`,
    );
    return "skipped";
  }
  const read = await deps.run(
    launcherContainer(opts.composeFile, launcher, ["--entrypoint", "cat", "updater", launcher]),
  );
  const service = read.code === 0 ? launcherService(read.stdout, opts.composeFile) : null;
  if (!service) {
    deps.log(
      read.code === 0
        ? `! ${launcher} is not the launcher this install wrote, so it was left as it is.`
        : `! Could not read the omnesis command at ${launcher}; it was not refreshed. To bring it up to this release, ${rerun}.`,
    );
    return "skipped";
  }
  const script = deps.installScript();
  const rendered = script
    ? await deps.run({
        command: "sh",
        args: [script, "--print-docker-launcher", opts.composeFile, service],
      })
    : null;
  if (!rendered || rendered.code !== 0 || !rendered.stdout.startsWith("#!/bin/sh\n")) {
    deps.log(
      `! Could not render this release's omnesis command, so ${launcher} was left as it is. To bring it up to this release, ${rerun}.`,
    );
    return "skipped";
  }
  if (rendered.stdout === read.stdout) return "current";
  const written = await deps.run({
    ...launcherContainer(opts.composeFile, launcher, [
      "--entrypoint",
      "sh",
      "updater",
      "-c",
      WRITE_SCRIPT,
      "sh",
      launcher,
    ]),
    input: rendered.stdout,
  });
  if (written.code !== 0) {
    deps.log(
      `! Could not replace the omnesis command at ${launcher}${written.stderr.trim() ? ` (${written.stderr.trim()})` : ""}. To bring it up to this release, ${rerun}.`,
    );
    return "skipped";
  }
  deps.log(`Refreshed the omnesis command at ${launcher} for this release.`);
  return "refreshed";
}

/** The installer this build carries: in the image at /app/scripts, in a checkout at its root. */
export function bundledInstallScript(from: string = import.meta.url): string | null {
  let dir = dirname(fileURLToPath(from));
  for (;;) {
    const candidate = join(dir, "scripts", "install.sh");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Run a command to completion, feeding it `input`, never throwing on a non-zero exit. */
export function runLauncherCommand(
  spec: LauncherRun,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(spec.input ?? "");
  });
}

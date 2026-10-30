// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The updater bringing a Docker install's host launcher up to its release.
 * Docker is faked at the command seam; the launcher text is rendered by the
 * real installer in this checkout, which is what the updater image ships.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  bundledInstallScript,
  dockerLauncherPath,
  launcherService,
  refreshDockerLauncher,
  runLauncherCommand,
  type LauncherDeps,
  type LauncherRun,
} from "./docker-launcher.js";

const PROJECT = "/home/maya/.config/omnesis";
const COMPOSE = `${PROJECT}/docker-compose.yml`;
const LAUNCHER = "/home/maya/.local/bin/omnesis";

function render(service: "gateway" | "collector", compose = COMPOSE): string {
  const script = bundledInstallScript();
  if (!script) throw new Error("no installer in this checkout");
  const out = spawnSync("sh", [script, "--print-docker-launcher", compose, service], {
    encoding: "utf8",
  });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout;
}

/** The launcher an older release wrote: the same header, older body. */
function olderLauncher(service: "gateway" | "collector" = "gateway"): string {
  return [
    "#!/bin/sh",
    "# Omnesis in Docker — written by install.sh --docker.",
    `COMPOSE_FILE='${COMPOSE}'`,
    `SERVICE='${service}'`,
    "set -eu",
    'exec docker compose -f "$COMPOSE_FILE" exec "$SERVICE" omnesis "$@"',
    "",
  ].join("\n");
}

function fakeDocker(onHost: string | null, opts: { writeFails?: boolean } = {}) {
  const calls: LauncherRun[] = [];
  const logs: string[] = [];
  const deps: LauncherDeps = {
    env: { OMNESIS_DOCKER_LAUNCHER: LAUNCHER },
    installScript: () => bundledInstallScript(),
    log: (line) => logs.push(line),
    run: async (spec) => {
      calls.push(spec);
      if (spec.command === "sh") return runLauncherCommand(spec);
      const entry = spec.args[spec.args.indexOf("--entrypoint") + 1];
      if (entry === "cat") {
        return onHost === null
          ? { code: 1, stdout: "", stderr: "cat: No such file or directory" }
          : { code: 0, stdout: onHost, stderr: "" };
      }
      if (opts.writeFails) return { code: 1, stdout: "", stderr: "Permission denied" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, calls, logs };
}

describe("where the launcher is", () => {
  test("the path the installer recorded for the updater", () => {
    expect(
      dockerLauncherPath("/srv/omnesis", { OMNESIS_DOCKER_LAUNCHER: "/opt/bin/omnesis" }),
    ).toBe("/opt/bin/omnesis");
  });

  test("an install that predates the record: beside the default config directory's home", () => {
    expect(dockerLauncherPath(PROJECT, {})).toBe(LAUNCHER);
    expect(dockerLauncherPath("/root/.config/omnesis/", {})).toBe("/root/.local/bin/omnesis");
  });

  test("a config directory elsewhere, with no record, has no known launcher", () => {
    expect(dockerLauncherPath("/srv/omnesis", {})).toBeNull();
    expect(dockerLauncherPath(PROJECT, { OMNESIS_DOCKER_LAUNCHER: "relative/omnesis" })).toBe(
      LAUNCHER,
    );
  });
});

describe("whose launcher it is", () => {
  test("this install's, by the installer's header and compose file", () => {
    expect(launcherService(render("gateway"), COMPOSE)).toBe("gateway");
    expect(launcherService(render("collector"), COMPOSE)).toBe("collector");
  });

  test("another install's, or something else at that path, is not", () => {
    expect(launcherService(render("gateway", "/srv/other/docker-compose.yml"), COMPOSE)).toBeNull();
    expect(launcherService('#!/bin/sh\nexec omnesis-native "$@"\n', COMPOSE)).toBeNull();
  });
});

describe("refreshDockerLauncher", () => {
  test("replaces an older launcher with this release's, through a container that mounts its directory", async () => {
    const { deps, calls, logs } = fakeDocker(olderLauncher());

    await expect(
      refreshDockerLauncher({ composeFile: COMPOSE, projectDir: PROJECT }, deps),
    ).resolves.toBe("refreshed");

    const write = calls.at(-1)!;
    expect(write.command).toBe("docker");
    expect(write.args).toEqual(
      expect.arrayContaining([
        "--profile",
        "update",
        "run",
        "--rm",
        "--volume",
        "/home/maya/.local/bin:/home/maya/.local/bin",
        "updater",
      ]),
    );
    expect(write.args.at(-1)).toBe(LAUNCHER);
    // Byte for byte what the installer writes, for the same service.
    expect(write.input).toBe(render("gateway"));
    expect(write.input).toContain("OMNESIS_DOCKER_HOST_RESTART");
    expect(logs).toEqual([`Refreshed the omnesis command at ${LAUNCHER} for this release.`]);
  });

  test("keeps a collector-only host's service", async () => {
    const { deps, calls } = fakeDocker(olderLauncher("collector"));
    await refreshDockerLauncher({ composeFile: COMPOSE, projectDir: PROJECT }, deps);
    expect(calls.at(-1)!.input).toBe(render("collector"));
  });

  test("a launcher already current is left untouched", async () => {
    const { deps, calls } = fakeDocker(render("gateway"));
    await expect(
      refreshDockerLauncher({ composeFile: COMPOSE, projectDir: PROJECT }, deps),
    ).resolves.toBe("current");
    expect(calls.filter((c) => c.input !== undefined)).toEqual([]);
  });

  test("a file that is not this install's launcher is never overwritten", async () => {
    const { deps, calls, logs } = fakeDocker("#!/bin/sh\necho mine\n");
    await expect(
      refreshDockerLauncher({ composeFile: COMPOSE, projectDir: PROJECT }, deps),
    ).resolves.toBe("skipped");
    expect(calls.some((c) => c.input !== undefined)).toBe(false);
    expect(logs[0]).toContain("is not the launcher this install wrote");
  });

  test("an unknown location, a missing file, or a failed write say how to refresh it", async () => {
    const unknown = fakeDocker(olderLauncher());
    unknown.deps.env = {};
    await expect(
      refreshDockerLauncher(
        { composeFile: "/srv/omnesis/docker-compose.yml", projectDir: "/srv/omnesis" },
        unknown.deps,
      ),
    ).resolves.toBe("skipped");
    expect(unknown.calls).toEqual([]);
    expect(unknown.logs[0]).toContain("re-run the installer");

    const missing = fakeDocker(null);
    await expect(
      refreshDockerLauncher({ composeFile: COMPOSE, projectDir: PROJECT }, missing.deps),
    ).resolves.toBe("skipped");
    expect(missing.logs[0]).toContain(`Could not read the omnesis command at ${LAUNCHER}`);

    const refused = fakeDocker(olderLauncher(), { writeFails: true });
    await expect(
      refreshDockerLauncher({ composeFile: COMPOSE, projectDir: PROJECT }, refused.deps),
    ).resolves.toBe("skipped");
    expect(refused.logs[0]).toContain("Permission denied");
  });

  test("a build without the installer refreshes nothing", async () => {
    const { deps, calls, logs } = fakeDocker(olderLauncher());
    deps.installScript = () => null;
    await expect(
      refreshDockerLauncher({ composeFile: COMPOSE, projectDir: PROJECT }, deps),
    ).resolves.toBe("skipped");
    expect(calls.some((c) => c.input !== undefined)).toBe(false);
    expect(logs[0]).toContain("Could not render");
  });
});

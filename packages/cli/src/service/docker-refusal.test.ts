// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { refuseInsideDockerWithoutLauncher } from "../commands/restore.js";
import { dockerServiceRefusal } from "./docker-refusal.js";
import { currentUsername } from "./username.js";
import type { DockerContext } from "../docker-install.js";

const split: DockerContext = {
  projectDir: "/srv/example/omnesis",
  composeFile: "/srv/example/omnesis/docker-compose.yml",
  services: ["gateway", "collector"],
  collectorOnly: false,
};
const combined: DockerContext = { ...split, services: ["gateway"] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A config dir the installer marked as a Docker install's. */
function dockerConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-docker-ctx-"));
  dirs.push(dir);
  writeFileSync(join(dir, "install-method"), "docker\n");
  writeFileSync(join(dir, "docker-compose.yml"), "services:\n  gateway:\n    image: x\n");
  return dir;
}

describe("omnesis service inside a Docker install", () => {
  test("names the compose command that does it on the host", () => {
    const refusal = dockerServiceRefusal("/srv/example/omnesis", "stop", "collector", () => split);
    expect(refusal?.message).toContain(
      "docker compose -f /srv/example/omnesis/docker-compose.yml stop collector",
    );
    expect(refusal?.message).toContain("`omnesis service stop collector`");
    expect(refusal?.message).toContain("`omnesis update` refreshes it");
    expect(dockerServiceRefusal("/x", "start", undefined, () => split)?.message).toContain(
      "up -d --no-deps gateway collector",
    );
    expect(dockerServiceRefusal("/x", "logs", "gateway", () => split)?.message).toContain(
      "docker-compose.yml logs gateway",
    );
  });

  test("a combined install's collector is the gateway's container", () => {
    expect(dockerServiceRefusal("/x", "restart", "collector", () => combined)?.message).toContain(
      "docker-compose.yml restart gateway",
    );
  });

  test("install and uninstall point at the installer", () => {
    const refusal = dockerServiceRefusal("/x", "install", undefined, () => split);
    expect(refusal?.message).toContain("re-run it with the options you installed with");
    expect(refusal?.message).toContain("`omnesis uninstall`");
  });

  test("leaves every other install to its service manager", () => {
    expect(dockerServiceRefusal("/x", "stop", "gateway", () => null)).toBeNull();
  });

  test("reads the install from the config dir", () => {
    const dir = dockerConfigDir();
    expect(dockerServiceRefusal(dir, "status", undefined)?.message).toContain(
      `docker compose -f ${join(dir, "docker-compose.yml")} ps --all gateway`,
    );
  });
});

describe("omnesis restore inside a Docker install", () => {
  test("runs only when the host launcher stopped the containers for it", () => {
    const dir = dockerConfigDir();
    expect(() => refuseInsideDockerWithoutLauncher(dir, {})).toThrow(/runs from the host/);
    expect(() => refuseInsideDockerWithoutLauncher(dir, {})).toThrow(/omnesis update/);
    expect(() =>
      refuseInsideDockerWithoutLauncher(dir, { OMNESIS_DOCKER_HOST_RESTART: "1" }),
    ).not.toThrow();
  });

  test("a native config dir restores as before", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-native-ctx-"));
    dirs.push(dir);
    expect(() => refuseInsideDockerWithoutLauncher(dir, {})).not.toThrow();
  });
});

describe("the account name", () => {
  test("an account the password database does not know falls back to the login environment", () => {
    const missing = () => {
      throw Object.assign(new Error("uv_os_get_passwd returned ENOENT"), {
        code: "ERR_SYSTEM_ERROR",
      });
    };
    expect(currentUsername(() => "maya", {}, 10001)).toBe("maya");
    expect(currentUsername(missing, { USER: "maya" }, 10001)).toBe("maya");
    expect(currentUsername(missing, { LOGNAME: "jamie" }, 10001)).toBe("jamie");
    expect(currentUsername(missing, {}, 10001)).toBe("10001");
  });
});

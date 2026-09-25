// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Round-trip between the two halves of the service-unit contract: this
 * package *generates* unit files, and the doctor's security collector in
 * `@omnesis/core` *reads them back* to audit an install's hardening.
 *
 * Neither side alone can catch a drift between them — the collector's own
 * tests drive hand-written fixtures so they stay generator-independent, and
 * the generator's tests assert on rendered text. This file closes the loop:
 * a freshly generated unit must satisfy every directive the collector
 * requires. It lives here, with the generator, because that is the side
 * that changes when a directive is added or renamed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { collectSecurityData, type SecurityCommandRunner } from "@omnesis/core/doctor";
import { generateSystemdUnit } from "./units.js";
import { HARDENED_CONFIG_DIR, generateHardenedSystemdUnit } from "./hardened.js";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const runner: SecurityCommandRunner = async (cmd) => {
  if (cmd === "findmnt") return { code: 0, stdout: "/dev/mapper/cryptroot ext4 rw", stderr: "" };
  return { code: 127, stdout: "", stderr: "not found" };
};

describe("generated systemd user unit satisfies the doctor's hardening audit", () => {
  test("every required directive is present and correct", async () => {
    const homeDir = tmp("omnesis-home-");
    const configDir = join(homeDir, ".config", "omnesis");
    const unitDir = join(homeDir, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "omnesis-gateway.service"),
      generateSystemdUnit({
        component: "gateway",
        configDir,
        exec: ["/usr/local/bin/omnesis", "gateway", "serve"],
        env: { OMNESIS_CONFIG_DIR: configDir },
        logsDir: join(homeDir, ".local", "state", "omnesis", "logs"),
      }),
    );

    const data = await collectSecurityData({
      configDir,
      fixPermissions: false,
      platform: "linux",
      homeDir,
      runCommand: runner,
    });

    const gateway = data.serviceUnits.find((unit) => unit.component === "gateway");
    expect(gateway?.installed).toBe(true);
    const failing = gateway?.directives.filter((directive) => !directive.ok) ?? [];
    expect(failing).toEqual([]);
  });

  test("extra writable paths from the spec still satisfy ReadWritePaths", async () => {
    const homeDir = tmp("omnesis-home-");
    const configDir = join(homeDir, ".config", "omnesis");
    const unitDir = join(homeDir, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "omnesis-gateway.service"),
      generateSystemdUnit({
        component: "gateway",
        configDir,
        exec: ["/usr/local/bin/omnesis", "gateway", "serve"],
        env: {
          OMNESIS_CONFIG_DIR: configDir,
          OMNESIS_DB_PATH: "/srv/omnesis/omnesis.db",
        },
        logsDir: join(homeDir, ".local", "state", "omnesis", "logs"),
      }),
    );

    const data = await collectSecurityData({
      configDir,
      fixPermissions: false,
      platform: "linux",
      homeDir,
      runCommand: runner,
    });

    const readWritePaths = data.serviceUnits
      .find((unit) => unit.component === "gateway")
      ?.directives.find((directive) => directive.key === "ReadWritePaths");
    expect(readWritePaths?.ok).toBe(true);
    expect(readWritePaths?.actual).toContain("/srv/omnesis");
  });
});

describe("generated hardened system unit satisfies the doctor's isolation audit", () => {
  test("is classified as running under a dedicated user", async () => {
    const homeDir = tmp("omnesis-home-");
    const hardenedUnitPath = join(tmp("omnesis-etc-"), "omnesis-gateway.service");
    writeFileSync(
      hardenedUnitPath,
      generateHardenedSystemdUnit({
        exec: ["/usr/local/bin/omnesis", "gateway", "serve"],
        env: { OMNESIS_CONFIG_DIR: HARDENED_CONFIG_DIR },
      }),
    );

    const data = await collectSecurityData({
      configDir: join(homeDir, ".config", "omnesis"),
      fixPermissions: false,
      platform: "linux",
      homeDir,
      hardenedUnitPath,
      runCommand: runner,
    });

    expect(data.gatewayIsolation.status).toBe("dedicated-user");
    expect(data.gatewayIsolation.detail).toContain("DynamicUser");
  });
});

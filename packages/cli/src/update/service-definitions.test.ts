// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHardenedGatewaySpec, generateHardenedSystemdUnit } from "../service/hardened.js";
import {
  buildServiceSpec,
  generateLaunchdPlist,
  generateSystemdUnit,
  systemdUnitPath,
  type BuildServiceSpecInput,
} from "../service/units.js";
import {
  regenerateServiceDefinition,
  serviceDefinitionUpdater,
  type RegenerateServiceDefinitionInput,
} from "./service-definitions.js";
import type { Supervisor } from "../service/supervisor.js";

const HOME = "/home/maya";
const CONFIG = "/home/maya/.config/omnesis";
const GATEWAY_EXEC = ["/home/maya/.local/bin/omnesis", "gateway", "serve"];
const COLLECTOR_EXEC = ["/home/maya/.local/bin/omnesis", "collector", "run"];

/** The unit `omnesis service install` writes for these inputs. */
function install(
  platform: "darwin" | "linux",
  overrides: Partial<BuildServiceSpecInput> = {},
  afterUnit?: string,
): string {
  const spec = buildServiceSpec({
    component: "gateway",
    configDir: CONFIG,
    exec: GATEWAY_EXEC,
    extraEnv: {},
    platform,
    homeDir: HOME,
    nodeBinDir: "/opt/node/bin",
    ...overrides,
  });
  return platform === "darwin"
    ? generateLaunchdPlist(spec)
    : generateSystemdUnit(spec, afterUnit ? { afterUnit } : {});
}

function regenerate(
  platform: "darwin" | "linux",
  content: string,
  overrides: Partial<RegenerateServiceDefinitionInput> = {},
) {
  return regenerateServiceDefinition({
    platform,
    component: "gateway",
    content,
    homeDir: HOME,
    // A different node than the unit was installed with: the unit's PATH stays.
    nodeBinDir: "/opt/newer-node/bin",
    gatewayInstalled: true,
    configEnv: () => undefined,
    coversLocalhost: () => true,
    ...overrides,
  });
}

describe("regenerateServiceDefinition round-trips what install wrote", () => {
  it("a systemd gateway with a passphrase credential and awkward environment values", () => {
    const unit = install("linux", {
      exec: ["/opt/omnesis app/bin/omnesis", "gateway", "serve"],
      secretStore: "passphrase",
      passphraseCredentialPath: "/etc/omnesis/key 100%",
      extraEnv: {
        OMNESIS_GATEWAY_PORT: "17600",
        OMNESIS_DB_PATH: "/srv/omnesis data/omnesis.db",
        OMNESIS_NOTE: `50% "quoted" \\ kept`,
      },
    });
    expect(regenerate("linux", unit)).toEqual({ kind: "unchanged" });
  });

  it("a systemd collector ordered after its gateway, with a passphrase file and loopback URL", () => {
    const unit = install(
      "linux",
      {
        component: "collector",
        exec: COLLECTOR_EXEC,
        secretStore: "passphrase",
        passphraseFilePath: `${CONFIG}/passphrase`,
        extraEnv: { OMNESIS_GATEWAY_URL: "https://localhost:7600" },
      },
      "omnesis-gateway.service",
    );
    expect(regenerate("linux", unit, { component: "collector" })).toEqual({ kind: "unchanged" });
  });

  it("a launchd gateway with a passphrase file and values that need XML escaping", () => {
    const plist = install("darwin", {
      exec: ["/Users/maya/Omnesis & Co/omnesis", "gateway", "serve"],
      secretStore: "passphrase",
      passphraseFilePath: "/Users/maya/.config/omnesis/pass'phrase",
      extraEnv: { OMNESIS_NOTE: `<kept> & "quoted"`, OMNESIS_GATEWAY_PORT: "17600" },
    });
    expect(regenerate("darwin", plist)).toEqual({ kind: "unchanged" });
  });

  it("a launchd collector that already carries the loopback URL", () => {
    const plist = install("darwin", {
      component: "collector",
      exec: COLLECTOR_EXEC,
      extraEnv: { OMNESIS_GATEWAY_URL: "https://localhost:7600" },
    });
    expect(regenerate("darwin", plist, { component: "collector" })).toEqual({ kind: "unchanged" });
  });
});

describe("regenerateServiceDefinition applies what a release changed", () => {
  it("adds AF_NETLINK to a gateway unit installed by 0.4.17", () => {
    const current = install("linux", { extraEnv: { OMNESIS_GATEWAY_PORT: "17600" } });
    const installedBy0417 = current.replace(
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    );
    expect(installedBy0417).not.toBe(current);
    expect(regenerate("linux", installedBy0417)).toEqual({ kind: "changed", content: current });
  });

  describe("a collector plist installed beside its gateway without a gateway URL", () => {
    const plist = install("darwin", { component: "collector", exec: COLLECTOR_EXEC });
    const configEnv = () =>
      "OMNESIS_GATEWAY_URL=https://omnesis.local:17600\nOMNESIS_GATEWAY_PORT=17600\n";

    it("gets the loopback URL when the served certificate names localhost", () => {
      const coversLocalhost = vi.fn(() => true);
      const verdict = regenerate("darwin", plist, {
        component: "collector",
        configEnv,
        coversLocalhost,
      });
      expect(verdict).toEqual({
        kind: "changed",
        content: install("darwin", {
          component: "collector",
          exec: COLLECTOR_EXEC,
          extraEnv: { OMNESIS_GATEWAY_URL: "https://localhost:17600" },
        }),
      });
      expect(coversLocalhost).toHaveBeenCalledWith(
        CONFIG,
        expect.objectContaining({ OMNESIS_GATEWAY_PORT: "17600" }),
      );
    });

    it("keeps the recorded address when the certificate does not name localhost", () => {
      expect(
        regenerate("darwin", plist, {
          component: "collector",
          configEnv,
          coversLocalhost: () => false,
        }),
      ).toEqual({ kind: "unchanged" });
    });

    it("is left alone on a host with no gateway unit", () => {
      expect(
        regenerate("darwin", plist, { component: "collector", gatewayInstalled: false }),
      ).toEqual({ kind: "unchanged" });
    });
  });

  describe("a collector unit carrying a loopback URL", () => {
    const plist = install("darwin", {
      component: "collector",
      exec: COLLECTOR_EXEC,
      extraEnv: { OMNESIS_GATEWAY_URL: "https://localhost:7600" },
    });
    // The address this host's certificate actually names.
    const configEnv = () => "OMNESIS_GATEWAY_URL=https://gateway.example.test:7600\n";

    it("drops it when the served certificate does not name localhost", () => {
      // 0.4.18 wrote this URL into every collector unit whatever the
      // certificate said, so on such a host it is an artefact, not a choice —
      // and keeping it leaves a collector that can never shake hands.
      expect(
        regenerate("darwin", plist, {
          component: "collector",
          configEnv,
          coversLocalhost: () => false,
        }),
      ).toEqual({
        kind: "changed",
        content: install("darwin", { component: "collector", exec: COLLECTOR_EXEC }),
      });
    });

    it("keeps it when the served certificate names localhost", () => {
      expect(
        regenerate("darwin", plist, {
          component: "collector",
          configEnv,
          coversLocalhost: () => true,
        }),
      ).toEqual({ kind: "unchanged" });
    });

    it("drops it from a systemd unit too", () => {
      const unit = install("linux", {
        component: "collector",
        exec: COLLECTOR_EXEC,
        extraEnv: { OMNESIS_GATEWAY_URL: "https://127.0.0.1:7600" },
      });
      expect(
        regenerate("linux", unit, {
          component: "collector",
          configEnv,
          coversLocalhost: () => false,
        }),
      ).toEqual({
        kind: "changed",
        // A Linux collector beside its gateway is also ordered after it.
        content: install(
          "linux",
          { component: "collector", exec: COLLECTOR_EXEC },
          "omnesis-gateway.service",
        ),
      });
    });
  });

  it("keeps the gateway URL a collector's unit already names", () => {
    const coversLocalhost = vi.fn(() => true);
    const plist = install("darwin", {
      component: "collector",
      exec: COLLECTOR_EXEC,
      extraEnv: { OMNESIS_GATEWAY_URL: "https://gateway.example.com:7600" },
    });
    expect(regenerate("darwin", plist, { component: "collector", coversLocalhost })).toEqual({
      kind: "unchanged",
    });
    expect(coversLocalhost).not.toHaveBeenCalled();
  });
});

describe("regenerateServiceDefinition leaves alone what it cannot rewrite safely", () => {
  const unit = install("linux");
  const plist = install("darwin");

  it.each([
    ["an EnvironmentFile", "EnvironmentFile=/home/maya/.config/omnesis/extra.env"],
    ["a passed-through environment", "PassEnvironment=OMNESIS_GATEWAY_URL"],
    ["a directive install never writes", "MemoryMax=2G"],
    ["a second credential", "LoadCredential=tailnet-key:/etc/omnesis/tailnet.key"],
  ])("a systemd unit with %s", (_what, line) => {
    const edited = unit.replace(/^(ExecStart=.*)$/mu, `$1\n${line}`);
    const verdict = regenerate("linux", edited);
    expect(verdict).toMatchObject({ kind: "refused" });
    expect(verdict.kind === "refused" && verdict.reason).toContain(line.split("=")[0]);
  });

  it("a systemd unit ordered after a unit of the operator's", () => {
    const edited = unit.replace("Wants=network-online.target", "$&\nAfter=vpn.service");
    expect(regenerate("linux", edited)).toMatchObject({ kind: "refused" });
  });

  it("a systemd unit carrying a comment", () => {
    const edited = unit.replace("[Service]", "[Service]\n# pinned by hand");
    expect(regenerate("linux", edited)).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("could not be read"),
    });
  });

  it("a named instance's unit, on either platform", () => {
    expect(regenerate("linux", install("linux", { instance: "staging" }))).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("Description"),
    });
    expect(regenerate("darwin", install("darwin", { instance: "staging" }))).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("Label"),
    });
  });

  it("a hardened system unit", () => {
    const hardened = generateHardenedSystemdUnit(
      buildHardenedGatewaySpec({ exec: GATEWAY_EXEC, extraEnv: {}, nodeBinDir: "/usr/bin" }),
    );
    expect(regenerate("linux", hardened)).toMatchObject({ kind: "refused" });
  });

  it("a plist with a Program key", () => {
    const edited = plist.replace(
      "<key>Label</key>",
      "<key>Program</key>\n    <string>/usr/local/bin/other</string>\n    <key>Label</key>",
    );
    expect(regenerate("darwin", edited)).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("Program"),
    });
  });

  it("content that is not a unit this command wrote", () => {
    expect(regenerate("linux", "not a unit\n")).toMatchObject({ kind: "refused" });
    expect(regenerate("darwin", "<plist><dict><date>2026</date>")).toMatchObject({
      kind: "refused",
    });
    expect(regenerate("linux", unit.replace(/^Environment=OMNESIS_CONFIG_DIR=.*\n/mu, ""))).toEqual(
      { kind: "refused", reason: "it names no OMNESIS_CONFIG_DIR" },
    );
  });
});

describe("serviceDefinitionUpdater", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function host(transform: (unit: string) => string, overridePaths: string[] = []) {
    const home = mkdtempSync(join(tmpdir(), "omnesis-definitions-"));
    homes.push(home);
    const path = systemdUnitPath(home, "gateway");
    const current = install("linux", {
      homeDir: home,
      configDir: join(home, ".config", "omnesis"),
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, transform(current), { mode: 0o600 });
    const supervisor = {
      platform: "linux",
      unitPath: (component: string) => systemdUnitPath(home, component as "gateway"),
      isInstalled: (component: string) => component === "gateway",
      inspectDefinition: () =>
        Promise.resolve({
          fragmentPath: path,
          overridePaths,
          inheritedEnvironment: [],
          inheritedEnvironmentText: "",
        }),
      loadDefinition: vi.fn(() => Promise.resolve(true)),
      reload: vi.fn(() => Promise.resolve()),
    } as unknown as Supervisor;
    const updater = serviceDefinitionUpdater({
      supervisor,
      homeDir: home,
      nodeBinDir: "/opt/node/bin",
      coversLocalhost: () => true,
    });
    return { path, current, updater };
  }

  const drop0417 = (unit: string) => unit.replace(" AF_NETLINK", "");

  it("rewrites a stale unit in place and puts its exact bytes back", async () => {
    const { path, current, updater } = host(drop0417);
    const before = readFileSync(path, "utf8");
    await expect(updater.refresh("gateway")).resolves.toEqual({ kind: "replaced" });
    expect(readFileSync(path, "utf8")).toBe(current);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    await expect(updater.restore()).resolves.toEqual(["gateway"]);
    expect(readFileSync(path, "utf8")).toBe(before);
    // Restored once: a second rollback has nothing of this run's to put back.
    await expect(updater.restore()).resolves.toEqual([]);
  });

  it("does not touch a unit that is already current", async () => {
    const { path, updater } = host((unit) => unit);
    const inode = statSync(path).ino;
    await expect(updater.refresh("gateway")).resolves.toEqual({ kind: "unchanged" });
    expect(statSync(path).ino).toBe(inode);
  });

  it("leaves a unit that drop-ins change exactly as it is", async () => {
    const dropIn = "/home/maya/.config/systemd/user/omnesis-gateway.service.d/override.conf";
    const { path, updater } = host(drop0417, [dropIn]);
    const before = readFileSync(path, "utf8");
    await expect(updater.refresh("gateway")).resolves.toEqual({
      kind: "refused",
      reason: `drop-ins change it (${dropIn})`,
    });
    expect(readFileSync(path, "utf8")).toBe(before);
    await expect(updater.restore()).resolves.toEqual([]);
  });
});

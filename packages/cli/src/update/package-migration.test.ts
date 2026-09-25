// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { UpdateInterruptionRouter } from "./interruption.js";
import { sourceRecoveryLauncher } from "./source-launcher.js";
import {
  assertSafeCheckoutRemoval,
  migrateSourceToPackage,
  packageInstallSpec,
  packageLauncher,
  packageUninstallSpec,
  type MigrationRunner,
  type SourceToPackageDeps,
} from "./package-migration.js";
import type { Supervisor } from "../service/supervisor.js";
import type { HostRoles } from "./detect.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(withServices = false, aliased = false) {
  const physicalHome = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-package-migration-")));
  const home = aliased ? `${physicalHome}-alias` : physicalHome;
  if (aliased) {
    symlinkSync(physicalHome, home, "dir");
    roots.push(home);
  }
  roots.push(physicalHome);
  const lexicalRootDir = join(home, "source");
  const configDir = join(home, ".config", "omnesis");
  const argv1 = join(lexicalRootDir, "packages", "cli", "src", "index.ts");
  const launcher = join(home, ".local", "bin", "omnesis");
  mkdirSync(join(lexicalRootDir, ".git"), { recursive: true });
  mkdirSync(join(lexicalRootDir, "packages", "cli", "src"), { recursive: true });
  mkdirSync(join(lexicalRootDir, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const rootDir = realpathSync(lexicalRootDir);
  writeFileSync(join(rootDir, "package.json"), '{"name":"omnesis"}\n');
  writeFileSync(argv1, "// fixture\n");
  writeFileSync(
    join(configDir, "update-state.json"),
    `${JSON.stringify({ version: 1, method: "source", rootDir, phase: "complete", commit: "a".repeat(40) })}\n`,
  );
  writeFileSync(
    launcher,
    sourceRecoveryLauncher(
      rootDir,
      configDir,
      join(home, ".local", "lib", "omnesis", "update-lock.cjs"),
    ),
    { mode: 0o755 },
  );
  const unitDir = join(home, ".config", "systemd", "user");
  if (withServices) mkdirSync(unitDir, { recursive: true });
  const unit = (component: "gateway" | "collector") =>
    join(unitDir, `omnesis-${component}.service`);
  const unitText = (component: string) =>
    `[Unit]\nDescription=${component}\n[Service]\nEnvironment=KEEP=exactly\nExecStart=${launcher} ${component} run\n[Install]\nWantedBy=default.target\n`;
  if (withServices) {
    writeFileSync(unit("gateway"), unitText("gateway"));
    writeFileSync(unit("collector"), unitText("collector"));
  }
  return { home, rootDir, configDir, argv1, launcher, unit, unitText };
}

function roles(withServices: boolean): HostRoles {
  const role = { present: withServices, supervised: withServices, manualRestart: null };
  return { gateway: role, collector: role, harnesses: [] };
}

function findRetiredCheckout(rootDir: string): string {
  const name = readdirSync(dirname(rootDir)).find((entry) =>
    entry.startsWith(`${basename(rootDir)}.omnesis-migration-`),
  );
  if (!name) throw new Error(`No retired checkout beside ${rootDir}`);
  return join(dirname(rootDir), name);
}

function harness(withServices = false, aliased = false) {
  const fx = fixture(withServices, aliased);
  const events: string[] = [];
  const prefix = join(realpathSync(fx.home), ".npm-global");
  const packageExecutable = join(prefix, "bin", "omnesis");
  const head = "a".repeat(40);
  let dirty = false;
  let clock = 0;
  const installPackage = () => {
    const real = join(prefix, "lib", "node_modules", "omnesis", "dist", "index.js");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(prefix, "lib", "node_modules", "omnesis", "dist"), { recursive: true });
    writeFileSync(real, "#!/usr/bin/env node\n", { mode: 0o755 });
    chmodSync(real, 0o755);
    symlinkSync(real, packageExecutable);
  };
  const run: MigrationRunner = async (spec, mode) => {
    events.push(`${mode}:${spec.command} ${spec.args.join(" ")}`);
    if (spec.command === "git" && spec.args[0] === "config")
      return { code: 0, stdout: "managed\n" };
    if (spec.command === "git" && spec.args[0] === "status") {
      return { code: 0, stdout: dirty ? " M file\n" : "" };
    }
    if (spec.command === "git" && spec.args[0] === "rev-parse")
      return { code: 0, stdout: `${head}\n` };
    if (spec.command === "git" && spec.args[0] === "rev-list")
      return { code: 0, stdout: `${head}\n` };
    if (spec.command === "npm" && spec.args[0] === "view") return { code: 0, stdout: "0.4.5\n" };
    if (spec.command === "npm" && spec.args[0] === "prefix")
      return { code: 0, stdout: "/root-owned\n" };
    if (spec.command === "npm" && spec.args[0] === "install") {
      installPackage();
      return { code: 0, stdout: "" };
    }
    if (spec.command === "npm" && spec.args[0] === "uninstall") {
      rmSync(prefix, { recursive: true, force: true });
      return { code: 0, stdout: "" };
    }
    if (spec.command === "sh") return { code: 0, stdout: `${fx.launcher}\n` };
    if (spec.command === packageExecutable) return { code: 0, stdout: "0.4.5\n" };
    return { code: 1, stdout: "unexpected" };
  };
  const supervisor = {
    platform: "linux",
    unitPath: (component: "gateway" | "collector") => fx.unit(component),
    reload: async (component: "gateway" | "collector") => {
      events.push(`reload:${component}`);
    },
    inspectDefinition: async (component: "gateway" | "collector") => ({
      fragmentPath: fx.unit(component),
      overridePaths: [],
      inheritedEnvironment: [],
      inheritedEnvironmentText: "",
    }),
    status: async (component: "gateway" | "collector") => ({
      component,
      unit: `omnesis-${component}.service`,
      installed: true,
      state: "running",
      pid: 123,
    }),
  } as unknown as Supervisor;
  const interruptions = new UpdateInterruptionRouter((code) => events.push(`exit:${code}`));
  const deps: SourceToPackageDeps = {
    run,
    supervisor,
    roles: roles(withServices),
    platform: "linux",
    homeDir: fx.home,
    configDir: fx.configDir,
    argv1: fx.argv1,
    cwd: fx.home,
    currentVersion: "0.4.5",
    confirm: async () => {
      events.push("confirm");
    },
    approve: async () => false,
    awaitHealth: async () => {
      events.push("health");
    },
    canWrite: async () => false,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: (line) => events.push(`log:${line}`),
    interruptions,
  };
  return {
    fx,
    deps,
    events,
    packageExecutable,
    interruptions,
    setDirty: (value: boolean) => (dirty = value),
  };
}

describe("source-to-package migration", () => {
  test("accepts canonical installer ownership when invoked through a symlinked ancestor", async () => {
    const { fx, deps } = harness(false, true);
    expect(fx.argv1).not.toBe(join(fx.rootDir, "packages", "cli", "src", "index.ts"));
    expect(JSON.parse(readFileSync(join(fx.configDir, "update-state.json"), "utf8")).rootDir).toBe(
      fx.rootDir,
    );

    await migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps);

    expect(readFileSync(fx.launcher, "utf8")).toContain("npm-global");
  });

  test("pins the exact version and writes a package launcher on a client-only host", async () => {
    const { fx, deps, events, packageExecutable } = harness();
    await migrateSourceToPackage(
      {
        registry: "https://registry.example",
        dryRun: false,
        keepCheckout: true,
        healthTimeoutMs: 1,
      },
      deps,
    );

    expect(events).toContain(
      "inherit:npm install -g omnesis@0.4.5 --prefix " +
        join(fx.home, ".npm-global") +
        " --registry https://registry.example",
    );
    expect(readFileSync(fx.launcher, "utf8")).toBe(
      packageLauncher(join(fx.home, ".npm-global"), packageExecutable),
    );
    expect(events).not.toContain("reload:gateway");
  });

  test("never selects an npm package prefix inside the retiring source checkout", async () => {
    const { fx, deps, events } = harness();
    const baseRun = deps.run;
    deps.canWrite = async () => true;
    deps.run = async (spec, mode, control) =>
      spec.command === "npm" && spec.args[0] === "prefix"
        ? { code: 0, stdout: `${join(fx.rootDir, "global")}\n` }
        : baseRun(spec, mode, control);
    await migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps);
    expect(events).toContain(
      `inherit:npm install -g omnesis@0.4.5 --prefix ${join(fx.home, ".npm-global")}`,
    );
  });

  test("never selects an npm prefix symlink that resolves into the retiring checkout", async () => {
    const { fx, deps, events } = harness();
    const embedded = join(fx.rootDir, "global");
    const reported = join(fx.home, "outside-prefix");
    mkdirSync(embedded);
    symlinkSync(embedded, reported);
    const baseRun = deps.run;
    deps.canWrite = async () => true;
    deps.run = async (spec, mode, control) =>
      spec.command === "npm" && spec.args[0] === "prefix"
        ? { code: 0, stdout: `${reported}\n` }
        : baseRun(spec, mode, control);
    await migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps);
    expect(events).toContain(
      `inherit:npm install -g omnesis@0.4.5 --prefix ${join(fx.home, ".npm-global")}`,
    );
  });

  test("an npm prefix sharing the source-launcher path falls back safely", async () => {
    const { fx, deps, events } = harness();
    const baseRun = deps.run;
    deps.canWrite = async () => true;
    deps.run = async (spec, mode, control) =>
      spec.command === "npm" && spec.args[0] === "prefix"
        ? { code: 0, stdout: `${join(fx.home, ".local")}\n` }
        : baseRun(spec, mode, control);
    await migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps);
    expect(events).toContain(
      `inherit:npm install -g omnesis@0.4.5 --prefix ${join(fx.home, ".npm-global")}`,
    );
  });

  test("preserves unit bytes and proves gateway health before collector reload", async () => {
    const { fx, deps, events, packageExecutable } = harness(true);
    await migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps);

    const gateway = readFileSync(fx.unit("gateway"), "utf8");
    expect(gateway).toBe(fx.unitText("gateway").replace(fx.launcher, packageExecutable));
    expect(events.indexOf("reload:gateway")).toBeLessThan(events.indexOf("health"));
    expect(events.indexOf("health")).toBeLessThan(events.indexOf("reload:collector"));
  });

  test("probes the gateway port preserved in the config environment", async () => {
    const { fx, deps } = harness(true);
    writeFileSync(
      join(fx.configDir, ".env"),
      "OMNESIS_GATEWAY_PORT=17600\nOMNESIS_BIND=192.0.2.10\n",
    );
    writeFileSync(
      fx.unit("gateway"),
      fx
        .unitText("gateway")
        .replace("Environment=KEEP=exactly", `Environment=OMNESIS_CONFIG_DIR=${fx.configDir}`),
    );
    const healthCalls: Array<[string, string, number]> = [];
    deps.awaitHealth = async (version, bind, port) => {
      healthCalls.push([version, bind, port]);
    };

    await migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps);

    expect(healthCalls).toEqual([["0.4.5", "192.0.2.10", 17_600]]);
  });

  test("refuses a service bound to another config directory before installation", async () => {
    const { fx, deps, events } = harness(true);
    const serviceConfigDir = join(fx.home, "service-config");
    mkdirSync(serviceConfigDir);
    writeFileSync(
      fx.unit("gateway"),
      fx
        .unitText("gateway")
        .replace("Environment=KEEP=exactly", `Environment=OMNESIS_CONFIG_DIR=${serviceConfigDir}`),
    );

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/Re-run with OMNESIS_CONFIG_DIR/u);
    expect(events.some((event) => event.startsWith("inherit:npm install"))).toBe(false);
  });

  test.each([
    ["a foreign effective fragment", { fragmentPath: "/tmp/foreign.service" }],
    ["a systemd drop-in", { overridePaths: ["/etc/systemd/user/override.conf"] }],
    ["service-manager environment", { inheritedEnvironment: ["OMNESIS_BIND"] }],
  ])("refuses %s before installation", async (_label, replacement) => {
    const { deps, events } = harness(true);
    const baseInspect = deps.supervisor.inspectDefinition.bind(deps.supervisor);
    deps.supervisor.inspectDefinition = async (component, instance) => ({
      ...(await baseInspect(component, instance)),
      ...replacement,
    });

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/effective|overrides|inherits/u);
    expect(events.some((event) => event.startsWith("inherit:npm install"))).toBe(false);
  });

  test("revalidates service-manager overrides after package installation", async () => {
    const { deps, events } = harness(true);
    const baseInspect = deps.supervisor.inspectDefinition.bind(deps.supervisor);
    let inspections = 0;
    deps.supervisor.inspectDefinition = async (component, instance) => ({
      ...(await baseInspect(component, instance)),
      overridePaths: ++inspections > 2 ? ["/run/user/1000/systemd/transient.conf"] : [],
    });

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/unsupported overrides/u);
    expect(events.some((event) => event.startsWith("inherit:npm install"))).toBe(true);
    expect(events.some((event) => event.startsWith("reload:"))).toBe(false);
  });

  test("refuses a non-listener manager environment reference into the checkout", async () => {
    const { fx, deps, events } = harness(true);
    const baseInspect = deps.supervisor.inspectDefinition.bind(deps.supervisor);
    deps.supervisor.inspectDefinition = async (component, instance) => ({
      ...(await baseInspect(component, instance)),
      inheritedEnvironmentText: `NODE_OPTIONS=--require=${fx.rootDir}/hook.js\n`,
    });

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/environment still references the source checkout/u);
    expect(events.some((event) => event.startsWith("inherit:npm install"))).toBe(false);
  });

  test("external definition drift makes rollback refuse reload and package removal", async () => {
    const { deps, events } = harness(true);
    const baseInspect = deps.supervisor.inspectDefinition.bind(deps.supervisor);
    let inspections = 0;
    deps.supervisor.inspectDefinition = async (component, instance) => ({
      ...(await baseInspect(component, instance)),
      overridePaths: ++inspections > 4 ? ["/run/user/1000/systemd/late.conf"] : [],
    });

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/rollback was incomplete.*service-manager definition/su);
    expect(events.filter((event) => event === "reload:gateway")).toHaveLength(1);
    expect(events.filter((event) => event === "reload:collector")).toHaveLength(1);
    expect(events.some((event) => event.startsWith("inherit:npm uninstall"))).toBe(false);
  });

  test("rolls back if the gateway environment changes during migration", async () => {
    const { fx, deps } = harness(true);
    const envPath = join(fx.configDir, ".env");
    writeFileSync(envPath, "OMNESIS_GATEWAY_PORT=17600\n");
    const healthCalls: Array<[string, number]> = [];
    deps.awaitHealth = async (_version, bind, port) => {
      healthCalls.push([bind, port]);
      if (healthCalls.length === 1) writeFileSync(envPath, "OMNESIS_GATEWAY_PORT=17601\n");
    };

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/changed after migration preflight/u);

    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(fx.unitText("gateway"));
    expect(readFileSync(fx.unit("collector"), "utf8")).toBe(fx.unitText("collector"));
    expect(healthCalls).toEqual([
      ["0.0.0.0", 17_600],
      ["0.0.0.0", 17_601],
    ]);
  });

  test("restores original units when the rebound gateway fails its proof", async () => {
    const { fx, deps, events } = harness(true);
    deps.awaitHealth = async () => {
      events.push("health");
      if (events.filter((event) => event === "health").length === 1) throw new Error("not healthy");
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/not healthy/u);

    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(fx.unitText("gateway"));
    expect(readFileSync(fx.unit("collector"), "utf8")).toBe(fx.unitText("collector"));
    expect(events.filter((event) => event === "reload:gateway")).toHaveLength(2);
    expect(events.filter((event) => event === "reload:collector")).toHaveLength(1);
  });

  test("dry-run stops before confirmation or mutation", async () => {
    const { fx, deps, events } = harness(true);
    const before = readFileSync(fx.launcher, "utf8");
    await migrateSourceToPackage({ dryRun: true, keepCheckout: false, healthTimeoutMs: 10 }, deps);
    expect(readFileSync(fx.launcher, "utf8")).toBe(before);
    expect(events).not.toContain("confirm");
    expect(events.some((event) => event.startsWith("inherit:"))).toBe(false);
  });

  test("dirty checkout is refused before package installation", async () => {
    const { deps, events, setDirty } = harness();
    setDirty(true);
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/local changes/u);
    expect(events.some((event) => event.startsWith("inherit:"))).toBe(false);
  });

  test("an operator-customized source launcher is never treated as installer-owned", async () => {
    const { fx, deps, events } = harness();
    const customized = `${readFileSync(fx.launcher, "utf8")}# operator customization\n`;
    writeFileSync(fx.launcher, customized, { mode: 0o755 });
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/not the installer-owned launcher/u);
    expect(readFileSync(fx.launcher, "utf8")).toBe(customized);
    expect(events.some((event) => event.startsWith("inherit:"))).toBe(false);
  });

  test("an install failure stops before any service or launcher mutation", async () => {
    const { fx, deps, events } = harness(true);
    const before = readFileSync(fx.launcher, "utf8");
    const baseRun = deps.run;
    deps.run = async (spec, mode) =>
      spec.command === "npm" && spec.args[0] === "install"
        ? { code: 9, stdout: "registry unavailable" }
        : baseRun(spec, mode);

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/registry unavailable/u);
    expect(readFileSync(fx.launcher, "utf8")).toBe(before);
    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(fx.unitText("gateway"));
    expect(events.some((event) => event.startsWith("reload:"))).toBe(false);
  });

  test("a foreign PATH result after rebinding restores launcher and units", async () => {
    const { fx, deps } = harness(true);
    const before = readFileSync(fx.launcher, "utf8");
    const foreign = join(fx.home, "foreign-omnesis");
    writeFileSync(foreign, "#!/bin/sh\n", { mode: 0o755 });
    const baseRun = deps.run;
    let pathChecks = 0;
    deps.run = async (spec, mode) => {
      if (spec.command === "sh") {
        pathChecks += 1;
        if (pathChecks === 2) return { code: 0, stdout: `${foreign}\n` };
      }
      return baseRun(spec, mode);
    };

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/unrelated executable/u);
    expect(readFileSync(fx.launcher, "utf8")).toBe(before);
    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(fx.unitText("gateway"));
  });

  test("removes only the revalidated retired checkout after separate approval", async () => {
    const { fx, deps } = harness();
    const sourceState = join(fx.configDir, "update-state.json");
    deps.approve = async () => true;
    await migrateSourceToPackage({ dryRun: false, keepCheckout: false, healthTimeoutMs: 10 }, deps);
    expect(existsSync(fx.rootDir)).toBe(false);
    expect(existsSync(sourceState)).toBe(false);
  });

  test("refuses checkout cleanup before quarantine when a unit retains another reference", async () => {
    const { fx, deps } = harness(true);
    writeFileSync(
      fx.unit("gateway"),
      fx
        .unitText("gateway")
        .replace("Environment=KEEP=exactly", `Environment=SOURCE_HELPER=${fx.rootDir}/tool`),
    );
    deps.approve = async () => true;

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: false, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/gateway still references the source checkout/u);
    expect(existsSync(fx.rootDir)).toBe(true);
    expect(
      readdirSync(dirname(fx.rootDir)).some((entry) =>
        entry.startsWith(`${basename(fx.rootDir)}.omnesis-migration-`),
      ),
    ).toBe(false);
  });

  test("refuses checkout cleanup before quarantine when a service override appears", async () => {
    const { fx, deps } = harness(true);
    const baseInspect = deps.supervisor.inspectDefinition.bind(deps.supervisor);
    deps.approve = async () => {
      deps.supervisor.inspectDefinition = async (component, instance) => ({
        ...(await baseInspect(component, instance)),
        overridePaths: ["/run/user/1000/systemd/cleanup.conf"],
      });
      return true;
    };

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: false, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/checkout cleanup was refused.*unsupported overrides/su);
    expect(existsSync(fx.rootDir)).toBe(true);
    expect(
      readdirSync(dirname(fx.rootDir)).some((entry) =>
        entry.startsWith(`${basename(fx.rootDir)}.omnesis-migration-`),
      ),
    ).toBe(false);
  });

  test("refuses a manual daemon layout before installation", async () => {
    const { deps, events } = harness();
    deps.roles = {
      ...deps.roles,
      gateway: { present: true, supervised: false, manualRestart: "custom command" },
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/unsupported manual/u);
    expect(events.some((event) => event.startsWith("inherit:"))).toBe(false);
  });

  test("SIGINT during package installation rolls back through the claimed signal route", async () => {
    const { fx, deps, interruptions } = harness(true);
    const before = readFileSync(fx.launcher, "utf8");
    const baseRun = deps.run;
    let releaseInstall!: () => void;
    let installControl: Parameters<MigrationRunner>[2];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const processGroups: Array<number | null> = [];
    deps.updateLock = {
      setStep: () => {},
      setProcessGroup: (pid) => processGroups.push(pid),
    };
    deps.run = async (spec, mode, control) => {
      if (spec.command !== "npm" || spec.args[0] !== "install") {
        return baseRun(spec, mode, control);
      }
      installControl = control;
      control?.onProcessGroup?.(321);
      markStarted();
      await new Promise<void>((resolve) => {
        releaseInstall = resolve;
      });
      const outcome = await baseRun(spec, mode, control);
      control?.onProcessGroup?.(null);
      return outcome;
    };
    const migration = migrateSourceToPackage(
      { dryRun: false, keepCheckout: true, healthTimeoutMs: 10 },
      deps,
    );
    await started;
    expect(installControl?.signal?.aborted).toBe(false);
    interruptions.dispatch("SIGINT");
    expect(installControl?.signal?.aborted).toBe(true);
    releaseInstall();
    await expect(migration).rejects.toMatchObject({ exitCode: 130 });
    expect(processGroups).toEqual([321, null]);
    expect(readFileSync(fx.launcher, "utf8")).toBe(before);
    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(fx.unitText("gateway"));
  });

  test("SIGTERM after gateway reload restores both rebound unit files", async () => {
    const { fx, deps, interruptions } = harness(true);
    const baseReload = deps.supervisor.reload.bind(deps.supervisor);
    deps.supervisor.reload = async (component, instance) => {
      await baseReload(component, instance);
      if (component === "gateway") interruptions.dispatch("SIGTERM");
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toMatchObject({ exitCode: 143 });
    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(fx.unitText("gateway"));
    expect(readFileSync(fx.unit("collector"), "utf8")).toBe(fx.unitText("collector"));
  });

  test("interruption after launcher replacement restores the source front door", async () => {
    const { fx, deps, interruptions } = harness(true);
    const sourceLauncher = readFileSync(fx.launcher, "utf8");
    const baseRun = deps.run;
    let pathChecks = 0;
    deps.run = async (spec, mode, control) => {
      if (spec.command === "sh") {
        pathChecks += 1;
        if (pathChecks === 2) interruptions.dispatch("SIGINT");
      }
      return baseRun(spec, mode, control);
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toMatchObject({ exitCode: 130 });
    expect(readFileSync(fx.launcher, "utf8")).toBe(sourceLauncher);
    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(fx.unitText("gateway"));
  });

  test("a service-unit edit during npm install is preserved and aborts all rebinding", async () => {
    const { fx, deps } = harness(true);
    const changed = `${fx.unitText("gateway")}# operator edit\n`;
    const baseRun = deps.run;
    deps.run = async (spec, mode, control) => {
      const outcome = await baseRun(spec, mode, control);
      if (spec.command === "npm" && spec.args[0] === "install") {
        writeFileSync(fx.unit("gateway"), changed);
      }
      return outcome;
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/changed after migration preflight/u);
    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(changed);
    expect(readFileSync(fx.unit("collector"), "utf8")).toBe(fx.unitText("collector"));
  });

  test("a service-unit edit during health proof prevents migration success", async () => {
    const { fx, deps, events } = harness(true);
    const changed = `${fx.unitText("gateway")}# operator edit during health\n`;
    deps.awaitHealth = async () => {
      writeFileSync(fx.unit("gateway"), changed);
    };

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/rollback was incomplete/u);
    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(changed);
    expect(events.filter((event) => event === "reload:gateway")).toHaveLength(1);
  });

  test("a launcher edit during PATH proof prevents migration success", async () => {
    const { fx, deps } = harness(true);
    const changed = "#!/bin/sh\n# operator edit during PATH proof\n";
    const baseRun = deps.run;
    let pathChecks = 0;
    deps.run = async (spec, mode, control) => {
      const outcome = await baseRun(spec, mode, control);
      if (spec.command === "sh" && ++pathChecks === 2) writeFileSync(fx.launcher, changed);
      return outcome;
    };

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/rollback was incomplete/u);
    expect(readFileSync(fx.launcher, "utf8")).toBe(changed);
  });

  test("collector restart failure restores both service units", async () => {
    const { fx, deps } = harness(true);
    const baseReload = deps.supervisor.reload.bind(deps.supervisor);
    deps.supervisor.reload = async (component, instance) => {
      if (component === "collector") throw new Error("collector restart failed");
      return baseReload(component, instance);
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/rollback was incomplete/u);
    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(fx.unitText("gateway"));
    expect(readFileSync(fx.unit("collector"), "utf8")).toBe(fx.unitText("collector"));
  });

  test("collector must remain running after its package-backed restart", async () => {
    const { fx, deps } = harness(true);
    deps.supervisor.status = async (component) => ({
      component,
      unit: `omnesis-${component}.service`,
      installed: true,
      state: component === "collector" ? "failed" : "running",
      pid: component === "collector" ? null : 123,
    });
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/collector service is failed/u);
    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(fx.unitText("gateway"));
    expect(readFileSync(fx.unit("collector"), "utf8")).toBe(fx.unitText("collector"));
  });

  test("gateway health cannot mask a stopped rebound local service", async () => {
    const { fx, deps, events } = harness(true);
    let firstGatewayStatus = true;
    deps.supervisor.status = async (component) => {
      const failed = component === "gateway" && firstGatewayStatus;
      if (component === "gateway") firstGatewayStatus = false;
      return {
        component,
        unit: `omnesis-${component}.service`,
        installed: true,
        state: failed ? "failed" : "running",
        pid: failed ? null : 123,
      };
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/gateway service is failed/u);
    expect(events.filter((event) => event === "health")).toHaveLength(1);
    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(fx.unitText("gateway"));
    expect(readFileSync(fx.unit("collector"), "utf8")).toBe(fx.unitText("collector"));
  });

  test("gateway must still be supervised after its exact-version health proof", async () => {
    const { fx, deps, events } = harness(true);
    let gatewayChecks = 0;
    deps.supervisor.status = async (component) => {
      const failed = component === "gateway" && ++gatewayChecks === 3;
      return {
        component,
        unit: `omnesis-${component}.service`,
        installed: true,
        state: failed ? "failed" : "running",
        pid: failed ? null : 123,
      };
    };

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/gateway service is failed/u);
    expect(events.filter((event) => event === "health")).toHaveLength(2);
    expect(readFileSync(fx.unit("gateway"), "utf8")).toBe(fx.unitText("gateway"));
    expect(readFileSync(fx.unit("collector"), "utf8")).toBe(fx.unitText("collector"));
  });

  test("rollback reports a restored collector that does not remain running", async () => {
    const { deps, events } = harness(true);
    deps.awaitHealth = async () => {
      events.push("health");
      throw new Error("forward health failed");
    };
    deps.supervisor.status = async (component) => ({
      component,
      unit: `omnesis-${component}.service`,
      installed: true,
      state: component === "collector" ? "failed" : "running",
      pid: component === "collector" ? null : 123,
    });
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/collector service is failed/u);
    expect(events.some((event) => event.startsWith("inherit:npm uninstall"))).toBe(false);
  });

  test("rollback requires the source gateway to remain supervised after health", async () => {
    const { deps, events } = harness(true);
    let healthChecks = 0;
    deps.awaitHealth = async () => {
      events.push("health");
      if (++healthChecks === 1) throw new Error("forward health failed");
    };
    let gatewayChecks = 0;
    deps.supervisor.status = async (component) => {
      const failed = component === "gateway" && ++gatewayChecks === 5;
      return {
        component,
        unit: `omnesis-${component}.service`,
        installed: true,
        state: failed ? "failed" : "running",
        pid: failed ? null : 123,
      };
    };

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/gateway service after health/u);
    expect(events.filter((event) => event === "health")).toHaveLength(2);
    expect(events.some((event) => event.startsWith("inherit:npm uninstall"))).toBe(false);
  });

  test("rollback attempts every recovery action after an earlier rollback failure", async () => {
    const { deps, events } = harness(true);
    deps.awaitHealth = async () => {
      events.push("health");
      throw new Error("health proof failed");
    };
    deps.supervisor.reload = async (component) => {
      events.push(`reload:${component}`);
      if (events.filter((event) => event === "reload:gateway").length > 1) {
        throw new Error("rollback gateway reload failed");
      }
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/rollback was incomplete/u);
    expect(events).toContain("reload:collector");
    expect(events.some((event) => event.startsWith("inherit:npm uninstall"))).toBe(false);
  });

  test("refuses to overwrite another package version in the selected prefix", async () => {
    const { deps, packageExecutable, events } = harness();
    await deps.run(packageInstallSpec("0.4.5", join(deps.homeDir, ".npm-global")), "inherit");
    const baseRun = deps.run;
    deps.run = async (spec, mode, control) =>
      spec.command === packageExecutable
        ? { code: 0, stdout: "0.3.0\n" }
        : baseRun(spec, mode, control);
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/already contains Omnesis 0.3.0/u);
    expect(events.filter((event) => event.startsWith("inherit:npm install"))).toHaveLength(1);
  });

  test("refuses a package binary backed by a lookalike directory", async () => {
    const { fx, deps, packageExecutable, events } = harness();
    const lookalike = join(fx.home, ".npm-global-other", "node_modules", "omnesis", "index.js");
    mkdirSync(dirname(lookalike), { recursive: true });
    mkdirSync(dirname(packageExecutable), { recursive: true });
    writeFileSync(lookalike, "#!/usr/bin/env node\n", { mode: 0o755 });
    symlinkSync(lookalike, packageExecutable);

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/not backed by the selected prefix/u);
    expect(events.some((event) => event.startsWith("inherit:npm install"))).toBe(false);
  });

  test("refuses a selected package root that is a symlink outside its prefix", async () => {
    const { fx, deps, packageExecutable, events } = harness();
    const packageRoot = join(fx.home, ".npm-global", "lib", "node_modules", "omnesis");
    const outsideRoot = join(fx.home, "outside-package");
    const outsideExecutable = join(outsideRoot, "dist", "index.js");
    mkdirSync(dirname(packageRoot), { recursive: true });
    mkdirSync(dirname(outsideExecutable), { recursive: true });
    mkdirSync(dirname(packageExecutable), { recursive: true });
    writeFileSync(outsideExecutable, "#!/usr/bin/env node\n", { mode: 0o755 });
    symlinkSync(outsideRoot, packageRoot);
    symlinkSync(outsideExecutable, packageExecutable);

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/must be a real directory/u);
    expect(events.some((event) => event.startsWith("inherit:npm install"))).toBe(false);
  });

  test("refuses a modules directory that is a symlink outside its prefix", async () => {
    const { fx, deps, packageExecutable, events } = harness();
    const prefix = join(fx.home, ".npm-global");
    const modulesRoot = join(prefix, "lib", "node_modules");
    const outsideModules = join(fx.home, "outside-modules");
    const outsideExecutable = join(outsideModules, "omnesis", "dist", "index.js");
    mkdirSync(join(prefix, "lib"), { recursive: true });
    mkdirSync(dirname(outsideExecutable), { recursive: true });
    mkdirSync(dirname(packageExecutable), { recursive: true });
    writeFileSync(outsideExecutable, "#!/usr/bin/env node\n", { mode: 0o755 });
    symlinkSync(outsideModules, modulesRoot);
    symlinkSync(outsideExecutable, packageExecutable);

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/must be a real directory/u);
    expect(events.some((event) => event.startsWith("inherit:npm install"))).toBe(false);
  });

  test("refuses a dangling package-root symlink before installation", async () => {
    const { fx, deps, events } = harness();
    const packageRoot = join(fx.home, ".npm-global", "lib", "node_modules", "omnesis");
    mkdirSync(dirname(packageRoot), { recursive: true });
    symlinkSync(join(fx.home, "missing-package"), packageRoot);

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/must be a real directory/u);
    expect(events.some((event) => event.startsWith("inherit:npm install"))).toBe(false);
  });

  test("refuses a dangling package executable before installation", async () => {
    const { fx, deps, packageExecutable, events } = harness();
    mkdirSync(dirname(packageExecutable), { recursive: true });
    symlinkSync(join(fx.home, "missing-executable"), packageExecutable);

    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/Cannot resolve existing package binary/u);
    expect(events.some((event) => event.startsWith("inherit:npm install"))).toBe(false);
  });

  test("a custom registry refuses an existing package of unprovable origin", async () => {
    const { deps, events } = harness();
    await deps.run(packageInstallSpec("0.4.5", join(deps.homeDir, ".npm-global")), "inherit");
    await expect(
      migrateSourceToPackage(
        {
          registry: "https://registry.example",
          dryRun: false,
          keepCheckout: true,
          healthTimeoutMs: 10,
        },
        deps,
      ),
    ).rejects.toThrow(/remove it before using --registry/u);
    expect(events.filter((event) => event.startsWith("inherit:npm install"))).toHaveLength(1);
  });

  test("refuses coexisting service layouts before installation", async () => {
    const { deps, events } = harness(true);
    deps.roles = {
      ...deps.roles,
      gateway: {
        ...deps.roles.gateway,
        conflictingServices: ["gateway --instance staging"],
      },
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/additional service layouts/u);
    expect(events.some((event) => event.startsWith("inherit:"))).toBe(false);
  });

  test("reuses an exact pre-existing package without reinstalling or uninstalling it", async () => {
    const { deps, events } = harness(true);
    await deps.run(packageInstallSpec("0.4.5", join(deps.homeDir, ".npm-global")), "inherit");
    deps.awaitHealth = async () => {
      throw new Error("health proof failed");
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: true, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/health proof failed/u);
    expect(events.filter((event) => event.startsWith("inherit:npm install"))).toHaveLength(1);
    expect(events.some((event) => event.startsWith("inherit:npm uninstall"))).toBe(false);
  });

  test("checkout cleanup never deletes a replacement directory at the original path", async () => {
    const { fx, deps } = harness();
    const original = `${fx.rootDir}-operator-moved`;
    const marker = join(fx.rootDir, "operator-file");
    deps.approve = async () => {
      renameSync(fx.rootDir, original);
      mkdirSync(join(fx.rootDir, ".git"), { recursive: true });
      writeFileSync(marker, "preserve\n");
      return true;
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: false, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/moved tree preserved/u);
    const retired = findRetiredCheckout(fx.rootDir);
    expect(readFileSync(join(retired, "operator-file"), "utf8")).toBe("preserve\n");
    expect(existsSync(fx.rootDir)).toBe(false);
    expect(existsSync(original)).toBe(true);
  });

  test("checkout cleanup preserves a quarantined tree that became dirty", async () => {
    const { fx, deps } = harness();
    const baseRun = deps.run;
    let statusChecks = 0;
    deps.run = async (spec, mode, control) => {
      if (spec.command === "git" && spec.args[0] === "status") {
        statusChecks += 1;
        if (statusChecks > 1) return { code: 0, stdout: "?? operator-file\n" };
      }
      return baseRun(spec, mode, control);
    };
    deps.approve = async () => {
      writeFileSync(join(fx.rootDir, "operator-file"), "preserve\n");
      return true;
    };
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: false, healthTimeoutMs: 10 }, deps),
    ).rejects.toThrow(/moved tree preserved/u);
    const retired = findRetiredCheckout(fx.rootDir);
    expect(readFileSync(join(retired, "operator-file"), "utf8")).toBe("preserve\n");
  });

  test("a post-quarantine command failure reports the preserved tree location", async () => {
    const { fx, deps } = harness();
    const baseRun = deps.run;
    deps.run = async (spec, mode, control) => {
      if (spec.command === "git" && spec.cwd?.includes(".retired")) {
        return { code: 9, stdout: "inspection failed" };
      }
      return baseRun(spec, mode, control);
    };
    deps.approve = async () => true;
    const migration = migrateSourceToPackage(
      { dryRun: false, keepCheckout: false, healthTimeoutMs: 10 },
      deps,
    );
    await expect(migration).rejects.toThrow(/moved tree preserved at/u);
    expect(existsSync(findRetiredCheckout(fx.rootDir))).toBe(true);
  });

  test("SIGINT during quarantined validation reports where the tree was preserved", async () => {
    const { fx, deps, interruptions } = harness();
    const baseRun = deps.run;
    deps.run = async (spec, mode, control) => {
      const outcome = await baseRun(spec, mode, control);
      if (spec.command === "git" && spec.cwd?.includes(".retired")) {
        interruptions.dispatch("SIGINT");
      }
      return outcome;
    };
    deps.approve = async () => true;
    await expect(
      migrateSourceToPackage({ dryRun: false, keepCheckout: false, healthTimeoutMs: 10 }, deps),
    ).rejects.toMatchObject({ exitCode: 130 });
    expect(existsSync(findRetiredCheckout(fx.rootDir))).toBe(true);
  });
});

describe("migration helpers", () => {
  test("package install pins the prefix, version, and optional registry", () => {
    expect(packageInstallSpec("1.2.3", "/prefix", "https://registry.example")).toEqual({
      command: "npm",
      args: [
        "install",
        "-g",
        "omnesis@1.2.3",
        "--prefix",
        "/prefix",
        "--registry",
        "https://registry.example",
      ],
    });
    expect(packageUninstallSpec("/prefix")).toEqual({
      command: "npm",
      args: ["uninstall", "-g", "omnesis", "--prefix", "/prefix"],
    });
  });

  test("checkout removal refuses the current working tree", () => {
    const { rootDir, home, configDir } = fixture();
    expect(() => assertSafeCheckoutRemoval(rootDir, home, configDir, rootDir)).toThrow(
      /shell is inside/u,
    );
  });

  test("checkout removal refuses a config symlink into the checkout", () => {
    const { rootDir, home, configDir } = fixture();
    rmSync(configDir, { recursive: true });
    const embeddedConfig = join(rootDir, "operator-config");
    mkdirSync(embeddedConfig);
    symlinkSync(embeddedConfig, configDir);
    expect(() => assertSafeCheckoutRemoval(rootDir, home, configDir, home)).toThrow(/overlapping/u);
  });
});

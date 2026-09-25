// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CODEX_RUNTIME_COMPAT } from "@omnesis/agent";
import { codexPaths } from "@omnesis/core";

import {
  CodexRuntimeInstaller,
  type CodexInstallCommandRunner,
} from "./codex-runtime-installer.js";
import { CODEX_RUNTIME_LOCK } from "./codex-runtime-lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempConfig(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnesis-codex-installer-"));
  roots.push(root);
  return root;
}

async function materializeRuntime(prefix: string, opts: { bin?: string; version?: string } = {}) {
  const packageDir = join(prefix, "node_modules", "@openai", "codex");
  await mkdir(join(packageDir, "bin"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: opts.version ?? CODEX_RUNTIME_COMPAT.testedVersion,
      bin: { codex: opts.bin ?? "bin/codex.js" },
    }),
  );
  await writeFile(join(packageDir, "bin", "codex.js"), "#!/usr/bin/env node\n");
  await chmod(join(packageDir, "bin", "codex.js"), 0o700);
}

function fakeRunner(
  calls: Array<{ command: string; args: readonly string[] }>,
): CodexInstallCommandRunner {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "synthetic-npm") {
      const prefix = args[args.indexOf("--prefix") + 1];
      if (!prefix) throw new Error("missing prefix");
      await materializeRuntime(prefix);
      return { stdout: "", stderr: "" };
    }
    return { stdout: `codex-cli ${CODEX_RUNTIME_COMPAT.testedVersion}\n`, stderr: "" };
  };
}

describe("CodexRuntimeInstaller", () => {
  it("pins the wrapper and every platform payload to release-owned SRI digests", () => {
    expect(CODEX_RUNTIME_LOCK.packages[""].dependencies["@openai/codex"]).toBe(
      CODEX_RUNTIME_COMPAT.testedVersion,
    );
    for (const [path, entry] of Object.entries(CODEX_RUNTIME_LOCK.packages)) {
      if (!path) continue;
      expect("integrity" in entry ? entry.integrity : undefined).toMatch(/^sha512-/);
      expect("resolved" in entry ? entry.resolved : undefined).toMatch(
        /^https:\/\/registry\.npmjs\.org\/@openai\/codex\//,
      );
    }
  });

  it("installs the single compiled target with argv execution and atomically selects it", async () => {
    const configDir = await tempConfig();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const installer = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner: fakeRunner(calls),
      compatibilityProbe: async () => {},
      id: (() => {
        let n = 0;
        return () => `operation-${++n}`;
      })(),
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });

    expect(await installer.readActive()).toBeNull();
    const prepared = await installer.prepare();
    expect(calls[0]).toEqual({
      command: "synthetic-npm",
      args: [
        "ci",
        "--prefix",
        prepared.stagingDir,
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
      ],
    });
    expect(calls[1]?.args).toEqual(["--version"]);

    const installed = await installer.commit(prepared);
    expect(installed.version).toBe("0.151.0");
    expect(installed.command).toContain(join("versions", "0.151.0"));
    await expect(installer.readActive()).resolves.toMatchObject({
      version: "0.151.0",
      packageVersion: "0.151.0",
    });
    const pointer = JSON.parse(
      await readFile(codexPaths(configDir).runtimeCurrent, "utf8"),
    ) as Record<string, unknown>;
    expect(pointer).toEqual({
      schemaVersion: 1,
      version: "0.151.0",
      generation: expect.stringMatching(/^0\.151\.0--operation-/),
      activatedAt: "2026-09-03T12:00:00.000Z",
    });
    expect((await lstat(installed.installDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(installed.command)).mode & 0o777).toBe(0o700);
    expect(
      (await lstat(join(installed.installDir, "node_modules/@openai/codex/package.json"))).mode &
        0o777,
    ).toBe(0o600);
  });

  it("runs an isolated app-server compatibility probe with no shared Codex home", async () => {
    const configDir = await tempConfig();
    const probes: Array<{ command: string; home: string; workspace: string }> = [];
    const installer = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner: fakeRunner([]),
      id: () => "isolated-probe",
      compatibilityProbe: async (commandInfo, opts) => {
        probes.push({
          command: commandInfo.command,
          home: opts.codexHome,
          workspace: opts.workspaceDir,
        });
      },
    });

    const prepared = await installer.prepare();
    expect(probes).toHaveLength(1);
    expect(probes[0]?.command).toContain(prepared.stagingDir);
    expect(probes[0]?.home).toBe(join(prepared.stagingDir, ".omnesis-compat-probe", "home"));
    expect(probes[0]?.home).not.toContain("codex-home");
    await installer.discard(prepared);
  });

  it("runs npm with a fixed registry and without gateway secrets or user npm config", async () => {
    const configDir = await tempConfig();
    let npmEnv: NodeJS.ProcessEnv | undefined;
    const runner: CodexInstallCommandRunner = async (command, args, opts) => {
      if (command === "synthetic-npm") {
        npmEnv = opts.env;
        await materializeRuntime(args[args.indexOf("--prefix") + 1]!);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "codex-cli 0.151.0", stderr: "" };
    };
    const installer = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner,
      compatibilityProbe: async () => {},
      env: {
        PATH: process.env.PATH,
        HOME: "/synthetic/operator-home",
        OPENAI_API_KEY: "must-not-leak",
        OMNESIS_TOKEN: "must-not-leak",
        npm_config_registry: "https://packages.example.invalid/",
      },
      id: () => "safe-env",
    });

    const prepared = await installer.prepare();
    expect(npmEnv).toMatchObject({ npm_config_registry: "https://registry.npmjs.org/" });
    expect(npmEnv?.HOME).toContain(prepared.stagingDir);
    expect(npmEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(npmEnv).not.toHaveProperty("OMNESIS_TOKEN");
    expect(npmEnv?.HOME).not.toBe("/synthetic/operator-home");
    await installer.discard(prepared);
  });

  it("rejects a package whose identity does not match the tested target", async () => {
    const configDir = await tempConfig();
    const runner: CodexInstallCommandRunner = async (command, args) => {
      if (command === "synthetic-npm") {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        await materializeRuntime(prefix, { version: "0.151.1" });
      }
      return { stdout: "codex-cli 0.151.1", stderr: "" };
    };
    const installer = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner,
      compatibilityProbe: async () => {},
      id: () => "wrong-version",
    });

    await expect(installer.prepare()).rejects.toThrow("package identity mismatch");
    await expect(readFile(codexPaths(configDir).runtimeUpdateLock)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects dot-segment operation ids without removing the runtime store", async () => {
    const configDir = await tempConfig();
    const paths = codexPaths(configDir);
    const installer = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner: fakeRunner([]),
      compatibilityProbe: async () => {},
      id: () => "..",
    });
    await installer.readActive();

    await expect(installer.prepare()).rejects.toThrow("unsafe path characters");
    expect((await lstat(paths.runtimeStore)).isDirectory()).toBe(true);
    expect((await lstat(paths.runtimeVersions)).isDirectory()).toBe(true);
  });

  it("rejects an unsafe pointer temp id after staging without escaping the store", async () => {
    const configDir = await tempConfig();
    const ids = ["safe-prepare", "../outside"];
    const installer = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner: fakeRunner([]),
      compatibilityProbe: async () => {},
      id: () => ids.shift() ?? "safe-fallback",
    });
    const prepared = await installer.prepare();

    await expect(installer.commit(prepared)).rejects.toThrow("pointer id contains unsafe");
    await expect(lstat(join(configDir, "outside.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(codexPaths(configDir).runtimeStore)).isDirectory()).toBe(true);
  });

  it("rejects a bin that escapes the installed package", async () => {
    const configDir = await tempConfig();
    const runner: CodexInstallCommandRunner = async (command, args) => {
      if (command === "synthetic-npm") {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        await materializeRuntime(prefix, { bin: "../../../outside.js" });
        await writeFile(join(prefix, "outside.js"), "synthetic");
      }
      return { stdout: "codex-cli 0.151.0", stderr: "" };
    };
    const installer = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner,
      compatibilityProbe: async () => {},
      id: () => "escaping-bin",
    });

    await expect(installer.prepare()).rejects.toThrow(/regular file|escapes/);
  });

  it("removes npm bin links and rejects every other installed symlink", async () => {
    const configDir = await tempConfig();
    const runner: CodexInstallCommandRunner = async (command, args) => {
      if (command === "synthetic-npm") {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        await materializeRuntime(prefix);
        const binDir = join(prefix, "node_modules", ".bin");
        await mkdir(binDir, { recursive: true });
        await symlink("../@openai/codex/bin/codex.js", join(binDir, "codex"));
        await symlink("package.json", join(prefix, "node_modules/@openai/codex/unexpected"));
      }
      return { stdout: "codex-cli 0.151.0", stderr: "" };
    };
    const installer = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner,
      compatibilityProbe: async () => {},
      id: () => "linked-runtime",
    });

    await expect(installer.prepare()).rejects.toThrow("unexpected symlink");
  });

  it("refuses a symlinked pointer instead of following it", async () => {
    const configDir = await tempConfig();
    const paths = codexPaths(configDir);
    await mkdir(paths.runtimeStore, { recursive: true });
    const target = join(configDir, "synthetic-pointer.json");
    await writeFile(target, "{}\n");
    await symlink(target, paths.runtimeCurrent);
    const installer = new CodexRuntimeInstaller({
      configDir,
      runner: fakeRunner([]),
      compatibilityProbe: async () => {},
    });

    await expect(installer.readActive()).rejects.toThrow("not a regular file");
  });

  it("holds an owner-only update lock until prepared bits are committed or discarded", async () => {
    const configDir = await tempConfig();
    const first = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner: fakeRunner([]),
      compatibilityProbe: async () => {},
      id: () => "first",
    });
    const second = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner: fakeRunner([]),
      compatibilityProbe: async () => {},
      id: () => "second",
    });
    const prepared = await first.prepare();
    expect((await lstat(codexPaths(configDir).runtimeUpdateLock)).mode & 0o777).toBe(0o700);

    await expect(second.prepare()).rejects.toThrow("already in progress");
    await first.discard(prepared);
    const next = await second.prepare();
    await second.discard(next);
  });

  it("recovers a stale lock without deleting an interrupted staging directory", async () => {
    const configDir = await tempConfig();
    const paths = codexPaths(configDir);
    const installer = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner: fakeRunner([]),
      compatibilityProbe: async () => {},
      id: () => "replacement",
    });
    await installer.readActive();
    await mkdir(paths.runtimeUpdateLock);
    const stale = new Date(Date.now() - 120_000);
    await utimes(paths.runtimeUpdateLock, stale, stale);
    await mkdir(join(paths.runtimeStaging, "interrupted"), { recursive: true });
    await writeFile(join(paths.runtimeStaging, "interrupted", "partial"), "synthetic");

    const prepared = await installer.prepare();
    expect((await lstat(join(paths.runtimeStaging, "interrupted"))).isDirectory()).toBe(true);
    await installer.discard(prepared);
  });

  it("repairs the same version as a new immutable generation and retains its predecessor", async () => {
    const configDir = await tempConfig();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    let id = 0;
    const installer = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner: fakeRunner(calls),
      compatibilityProbe: async () => {},
      id: () => `same-version-${++id}`,
    });
    const paths = codexPaths(configDir);
    const first = await installer.commit(await installer.prepare());
    const second = await installer.commit(await installer.prepare());
    const pointer = JSON.parse(await readFile(paths.runtimeCurrent, "utf8")) as {
      generation: string;
      previousGeneration: string;
    };

    expect(second.installDir).not.toBe(first.installDir);
    expect(pointer.generation).toBe(second.installDir.split("/").at(-1));
    expect(pointer.previousGeneration).toBe(first.installDir.split("/").at(-1));
    expect((await lstat(first.installDir)).isDirectory()).toBe(true);
  });

  it("retains a crash orphan rather than risking deletion after lock compromise", async () => {
    const configDir = await tempConfig();
    const paths = codexPaths(configDir);
    const currentGeneration = "0.151.0--current";
    const orphanGeneration = "0.151.0--orphan";
    for (const generation of [currentGeneration, orphanGeneration]) {
      const dir = join(paths.runtimeVersions, generation);
      await mkdir(dir, { recursive: true });
      await materializeRuntime(dir);
    }
    await mkdir(paths.runtimeStore, { recursive: true });
    await writeFile(
      paths.runtimeCurrent,
      `${JSON.stringify({
        schemaVersion: 1,
        version: "0.151.0",
        generation: currentGeneration,
        activatedAt: "2026-09-03T12:00:00.000Z",
      })}\n`,
    );
    const installer = new CodexRuntimeInstaller({
      configDir,
      runner: fakeRunner([]),
      compatibilityProbe: async () => {},
    });

    expect((await installer.readActive())?.installDir).toBe(
      join(paths.runtimeVersions, currentGeneration),
    );
    expect((await lstat(join(paths.runtimeVersions, orphanGeneration))).isDirectory()).toBe(true);
  });

  it("recovers a corrupt selected generation through the retained previous pointer", async () => {
    const configDir = await tempConfig();
    const paths = codexPaths(configDir);
    const previousGeneration = "0.151.0--previous";
    await mkdir(join(paths.runtimeVersions, previousGeneration), { recursive: true });
    await materializeRuntime(join(paths.runtimeVersions, previousGeneration));
    await mkdir(paths.runtimeStore, { recursive: true });
    await writeFile(
      paths.runtimeCurrent,
      `${JSON.stringify({
        schemaVersion: 1,
        version: "0.151.0",
        generation: "0.151.0--missing",
        previousVersion: "0.151.0",
        previousGeneration,
        activatedAt: "2026-09-03T12:00:00.000Z",
      })}\n`,
    );
    const installer = new CodexRuntimeInstaller({
      configDir,
      runner: fakeRunner([]),
      compatibilityProbe: async () => {},
      id: () => "recovery-read",
    });

    const active = await installer.readActive();
    expect(active?.installDir).toBe(join(paths.runtimeVersions, previousGeneration));
    expect(JSON.parse(await readFile(paths.runtimeCurrent, "utf8"))).toMatchObject({
      generation: previousGeneration,
      version: "0.151.0",
    });
  });

  it("keeps published and interrupted artifacts for fenced external maintenance", async () => {
    const configDir = await tempConfig();
    const paths = codexPaths(configDir);
    const currentGeneration = "0.151.0--published";
    const previousGeneration = "0.151.0--rollback";
    const orphanGeneration = "0.151.0--unpublished";
    for (const generation of [currentGeneration, previousGeneration, orphanGeneration]) {
      const dir = join(paths.runtimeVersions, generation);
      await mkdir(dir, { recursive: true });
      await materializeRuntime(dir);
    }
    await mkdir(paths.runtimeStaging, { recursive: true });
    await mkdir(join(paths.runtimeStaging, "interrupted"));
    await writeFile(join(paths.runtimeStore, ".current-interrupted.tmp"), "partial");
    await writeFile(
      paths.runtimeCurrent,
      `${JSON.stringify({
        schemaVersion: 1,
        version: "0.151.0",
        generation: currentGeneration,
        previousVersion: "0.151.0",
        previousGeneration,
        activatedAt: "2026-09-03T12:00:00.000Z",
      })}\n`,
    );
    const installer = new CodexRuntimeInstaller({
      configDir,
      runner: fakeRunner([]),
      compatibilityProbe: async () => {},
    });

    expect((await installer.readActive())?.installDir).toBe(
      join(paths.runtimeVersions, currentGeneration),
    );
    expect((await lstat(join(paths.runtimeVersions, currentGeneration))).isDirectory()).toBe(true);
    expect((await lstat(join(paths.runtimeVersions, previousGeneration))).isDirectory()).toBe(true);
    expect((await lstat(join(paths.runtimeVersions, orphanGeneration))).isDirectory()).toBe(true);
    expect((await lstat(join(paths.runtimeStaging, "interrupted"))).isDirectory()).toBe(true);
    expect((await lstat(join(paths.runtimeStore, ".current-interrupted.tmp"))).isFile()).toBe(true);
  });

  it("admits exactly one of two concurrent installers", async () => {
    const configDir = await tempConfig();
    const first = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner: fakeRunner([]),
      compatibilityProbe: async () => {},
      id: () => "concurrent-first",
    });
    const second = new CodexRuntimeInstaller({
      configDir,
      npmCommand: "synthetic-npm",
      runner: fakeRunner([]),
      compatibilityProbe: async () => {},
      id: () => "concurrent-second",
    });

    const results = await Promise.allSettled([first.prepare(), second.prepare()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof first.prepare>>> =>
        result.status === "fulfilled",
    );
    expect(winner).toBeDefined();
    if (winner?.value.id === "concurrent-first") await first.discard(winner.value);
    else if (winner) await second.discard(winner.value);
  });
});

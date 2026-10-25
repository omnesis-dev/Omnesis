// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis uninstall` end to end over a disposable home: real unit files read
 * by the real systemd and launchd supervisors, real launchers and harness
 * configs written the way the installer and `connect` write them, and a
 * scripted command runner standing in for systemctl, launchctl, git, npm,
 * docker, sudo and the harness CLIs. Every scenario asserts on the disk
 * afterwards, not just on what was printed.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { acquireUpdateLock, type GatewayLockHolder } from "@omnesis/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CliError } from "@omnesis/cli-shared";
import { LaunchdSupervisor, SystemdSupervisor, type ExecResult } from "../service/supervisor.js";
import { buildServiceSpec, generateLaunchdPlist, generateSystemdUnit } from "../service/units.js";
import { packageLauncher } from "../update/package-migration-plan.js";
import { sourceRecoveryLauncher } from "../update/source-launcher.js";
import { DOCKER_WRAPPER_MARKER } from "../uninstall/launcher.js";
import { PROFILE_MARKER } from "../uninstall/profile.js";
import {
  isDockerInstallImage,
  type RunOptions,
  type UninstallContext,
} from "../uninstall/context.js";
import { mergeOpenClawSkillEnv } from "./connect.js";
import {
  parseComponents,
  runUninstall,
  uninstallCommand,
  type UninstallIo,
  type UninstallOptions,
} from "./uninstall.js";
import type { UninstallComponent } from "../uninstall/types.js";

// ── The machine ────────────────────────────────────────────────────────

type Reply = Partial<ExecResult> | undefined;
type Handler = (argv: string[], opts: RunOptions) => Reply;

interface Call {
  argv: string[];
  opts: RunOptions;
}

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  // Harness homes resolve from the environment, as `connect` resolves them.
  for (const key of [
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_HOME",
    "OPENCLAW_PROFILE",
    "HERMES_HOME",
  ]) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

class Machine {
  readonly root = mkdtempSync(join(tmpdir(), "omnesis-uninstall-"));
  readonly home = join(this.root, "home");
  readonly system = join(this.root, "system");
  readonly configDir = join(this.home, ".config", "omnesis");
  readonly calls: Call[] = [];
  readonly interactiveCalls: string[][] = [];
  readonly handlers: Handler[] = [];
  holder: GatewayLockHolder | null = null;
  isRoot = false;
  interactive = false;
  inContainer = false;
  /** Whether each unit is running, as systemctl/launchctl would report it. */
  readonly running = new Set<string>();

  constructor(readonly platform: "linux" | "darwin") {
    roots.push(this.root);
    mkdirSync(this.home, { recursive: true });
    vi.stubEnv("HOME", this.home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined as unknown as string);
  }

  /** Reply to commands starting with `prefix`; later registrations win. */
  on(prefix: string[], reply: Reply | ((argv: string[], opts: RunOptions) => Reply)): this {
    this.handlers.unshift((argv, opts) => {
      if (
        !prefix.every(
          (token, index) =>
            argv[index] === token || (index === 0 && argv[0]!.endsWith(`/${token}`)),
        )
      ) {
        return undefined;
      }
      return typeof reply === "function" ? (reply(argv, opts) ?? {}) : (reply ?? {});
    });
    return this;
  }

  run = (cmd: string, args: string[], opts: RunOptions = {}): Promise<ExecResult> => {
    const argv = [cmd, ...args];
    this.calls.push({ argv, opts });
    for (const handler of this.handlers) {
      const reply = handler(argv, opts);
      if (reply) return Promise.resolve({ code: 0, stdout: "", stderr: "", ...reply });
    }
    return Promise.resolve(this.defaultReply(argv));
  };

  private defaultReply(argv: string[]): ExecResult {
    const [cmd, ...args] = argv;
    const ok = { code: 0, stdout: "", stderr: "" };
    const missing = { code: 127, stdout: "", stderr: `spawn ${cmd} ENOENT` };
    switch (cmd) {
      case "systemctl":
        if (args[1] === "is-active") {
          return this.running.has(args[2]!)
            ? { code: 0, stdout: "active\n", stderr: "" }
            : { code: 3, stdout: "inactive\n", stderr: "" };
        }
        if (args[1] === "disable") this.running.delete(args[3]!);
        return ok;
      case "launchctl":
        if (args[0] === "print") {
          const label = args[1]!.split("/").pop()!;
          return this.running.has(label)
            ? { code: 0, stdout: "state = running\n", stderr: "" }
            : { code: 113, stdout: "", stderr: "Could not find service" };
        }
        if (args[0] === "bootout") this.running.delete(args[1]!.split("/").pop()!);
        return ok;
      case "git":
        return ok;
      case "npm":
        if (args[0] === "prefix")
          return { code: 0, stdout: join(this.root, "usr-local") + "\n", stderr: "" };
        return ok;
      case "claude":
      case "codex":
        return missing;
      default:
        return ok;
    }
  }

  context(): UninstallContext {
    const exec = (cmd: string, args: string[]) => this.run(cmd, args);
    const supervisor =
      this.platform === "darwin"
        ? new LaunchdSupervisor({
            exec,
            stream: () => Promise.resolve(0),
            home: this.home,
            uid: 501,
            sleep: () => Promise.resolve(),
            gatewayHolder: () => null,
          })
        : new SystemdSupervisor({
            exec,
            stream: () => Promise.resolve(0),
            home: this.home,
            username: "maya",
          });
    return {
      platform: this.platform,
      home: this.home,
      env: { HOME: this.home },
      uid: this.isRoot ? 0 : 501,
      isRoot: this.isRoot,
      interactive: this.interactive,
      run: this.run,
      runInteractive: async (cmd, args) => {
        this.interactiveCalls.push([cmd, ...args]);
        return (await this.run(`${cmd}:interactive`, args)).code;
      },
      supervisor: () => supervisor,
      gatewayHolder: () => this.holder,
      secretStoreOptions: (configDir) => ({ configDir, backend: "file", platform: this.platform }),
      inContainer: this.inContainer,
      systemRoot: this.system,
    };
  }

  path(...parts: string[]): string {
    return join(this.home, ...parts);
  }

  write(path: string, content: string, mode = 0o644): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode });
    return path;
  }

  /** Every path under the home, for asserting a run changed nothing. */
  tree(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        out.push(`${relative(this.root, full)}:${statSync(full).size}`);
        if (statSync(full).isDirectory()) walk(full);
      }
    };
    walk(this.root);
    return out;
  }

  argvs(): string[][] {
    return this.calls.map((call) => call.argv);
  }

  ran(...prefix: string[]): Call[] {
    return this.calls.filter((call) => prefix.every((token, index) => call.argv[index] === token));
  }

  // ── What an install leaves ──

  config(): this {
    this.write(join(this.configDir, "omnesis.json"), "{}\n");
    this.write(join(this.configDir, ".env"), "OMNESIS_GATEWAY_PORT=7600\n", 0o600);
    this.write(join(this.configDir, "omnesis.db"), "fictional corpus");
    return this;
  }

  unit(component: "gateway" | "collector", instance?: string, configDir = this.configDir): this {
    const spec = buildServiceSpec({
      component,
      ...(instance ? { instance } : {}),
      configDir,
      exec: [
        this.path(".local", "bin", "omnesis"),
        component === "gateway" ? "gateway" : "collector",
        component === "gateway" ? "serve" : "run",
      ],
      extraEnv: {},
      platform: this.platform,
      homeDir: this.home,
      nodeBinDir: "/usr/bin",
    });
    if (this.platform === "linux") {
      const name = instance
        ? `omnesis-${component}-${instance}.service`
        : `omnesis-${component}.service`;
      this.write(this.path(".config", "systemd", "user", name), generateSystemdUnit(spec), 0o600);
      this.running.add(name);
    } else {
      const label = instance ? `dev.omnesis.${component}.${instance}` : `dev.omnesis.${component}`;
      this.write(
        this.path("Library", "LaunchAgents", `${label}.plist`),
        generateLaunchdPlist(spec),
        0o600,
      );
      this.running.add(label);
    }
    return this;
  }

  services(): this {
    return this.unit("gateway").unit("collector");
  }

  /** The default source install: managed checkout, launcher, lock helper, update record, PATH line. */
  sourceInstall(opts: { managed?: boolean; dirty?: boolean } = {}): this {
    const root = this.path("omnesis");
    this.write(join(root, "packages", "cli", "package.json"), '{"name":"omnesis"}\n');
    mkdirSync(join(root, ".git"), { recursive: true });
    this.write(join(root, "node_modules", ".bin", "tsx"), "#!/bin/sh\n", 0o755);
    const lockHelper = this.path(".local", "lib", "omnesis", "update-lock.cjs");
    this.write(lockHelper, "// lock helper\n", 0o755);
    this.write(
      this.path(".local", "bin", "omnesis"),
      sourceRecoveryLauncher(root, this.configDir, lockHelper),
      0o755,
    );
    this.write(
      join(this.configDir, "update-state.json"),
      JSON.stringify({
        version: 1,
        method: "source",
        rootDir: root,
        phase: "complete",
        commit: "a".repeat(40),
      }),
      0o600,
    );
    this.on(
      ["git", "-C", root, "config"],
      opts.managed === false ? { code: 1 } : { stdout: "managed\n" },
    );
    this.on(["git", "-C", root, "status"], {
      stdout: opts.dirty ? " M packages/cli/src/index.ts\n" : "",
    });
    return this;
  }

  packageInstall(prefix = this.path(".npm-global")): this {
    const packageDir = join(prefix, "lib", "node_modules", "omnesis");
    this.write(join(packageDir, "package.json"), '{"name":"omnesis","version":"9.9.9"}\n');
    this.write(join(packageDir, "dist", "index.js"), "#!/usr/bin/env node\n", 0o755);
    mkdirSync(join(prefix, "bin"), { recursive: true });
    symlinkSync(
      join("..", "lib", "node_modules", "omnesis", "dist", "index.js"),
      join(prefix, "bin", "omnesis"),
    );
    this.write(
      this.path(".local", "bin", "omnesis"),
      packageLauncher(prefix, join(prefix, "bin", "omnesis")),
      0o755,
    );
    this.on(["npm", "uninstall"], (argv) => {
      rmSync(join(argv[argv.indexOf("--prefix") + 1]!, "lib", "node_modules", "omnesis"), {
        recursive: true,
        force: true,
      });
      return {};
    });
    return this;
  }

  profile(name = ".zshrc", before = 'export EDITOR="vim"\n'): string {
    const path = this.path(name);
    const line = name.endsWith("config.fish")
      ? `fish_add_path ${this.path(".local", "bin")}`
      : `export PATH="${this.path(".local", "bin")}:$PATH"`;
    this.write(path, `${before}\n${PROFILE_MARKER}\n${line}\n`);
    return before;
  }

  openclaw(): string {
    const home = this.path(".openclaw");
    const operator = `${JSON.stringify({ update: { checkOnStart: false } }, null, 2)}\n`;
    this.write(
      join(home, "openclaw.json"),
      mergeOpenClawSkillEnv(operator, { OMNESIS_AGENT_HARNESS: "openclaw" }),
    );
    this.write(join(home, "openclaw.json.bak-omnesis"), operator);
    this.write(join(home, ".env"), "UNRELATED=keep\nOMNESIS_AGENT_HARNESS=openclaw\n", 0o600);
    this.write(join(home, "skills", "omnesis", "SKILL.md"), "# Omnesis\n");
    this.write(join(home, "skills", "weather", "SKILL.md"), "# Weather\n");
    this.write(join(home, "omnesis", "integration.json"), "{}\n", 0o600);
    this.write(
      join(home, "omnesis", "integration-identity.json"),
      JSON.stringify({
        version: 1,
        harness: "openclaw",
        suggestedName: "omnesis-openclaw-0123456789ab",
      }),
      0o600,
    );
    // An executable where resolveHarnessBinary looks.
    this.write(this.path(".npm-global", "bin", "openclaw"), "#!/bin/sh\n", 0o755);
    vi.stubEnv("PATH", this.path(".npm-global", "bin"));
    return operator;
  }

  hermes(): string {
    const home = this.path(".hermes");
    const config =
      "display:\n  background_process_notifications: all\nplugins:\n  enabled:\n    - omnesis-integration\n    - weather-tools\n";
    this.write(join(home, "config.yaml"), config);
    for (const file of ["__init__.py", "adapter.py", "plugin.yaml"]) {
      this.write(join(home, "plugins", "omnesis-integration", file), "# plugin\n");
    }
    this.write(join(home, "plugins", "weather-tools", "plugin.yaml"), "name: weather-tools\n");
    this.write(join(home, ".env"), "OMNESIS_AGENT_HARNESS=hermes\n", 0o600);
    this.write(join(home, "skills", "productivity", "omnesis", "SKILL.md"), "# Omnesis\n");
    this.write(join(home, "skills", "productivity", "todo", "SKILL.md"), "# Todo\n");
    this.write(join(home, "omnesis", "integration.json"), "{}\n", 0o600);
    return config;
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function recorder(answers: { choose?: UninstallComponent[] | null; confirm?: boolean } = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const io: UninstallIo = {
    out: (line) => lines.push(line),
    colors: new Proxy({}, { get: () => "" }) as Record<string, string>,
    choose: (present) => {
      asked.push(`choose:${present.join(",")}`);
      return Promise.resolve(answers.choose === undefined ? present : answers.choose);
    },
    confirm: (message) => {
      asked.push(`confirm:${message}`);
      return Promise.resolve(answers.confirm ?? true);
    },
  };
  return { io, lines, asked, text: () => lines.join("\n") };
}

function options(overrides: Partial<UninstallOptions> = {}): UninstallOptions {
  return {
    components: [],
    purge: false,
    yes: true,
    dryRun: false,
    json: false,
    discardLocalChanges: false,
    ...overrides,
  };
}

async function uninstall(
  machine: Machine,
  overrides: Partial<UninstallOptions> = {},
  answers = {},
) {
  const out = recorder(answers);
  const code = await runUninstall(
    options({ configDir: machine.configDir, ...overrides }),
    machine.context(),
    out.io,
  );
  return { code, ...out };
}

// ── Scenarios ──────────────────────────────────────────────────────────

describe("a full uninstall on Linux, source install", () => {
  test("removes services, harness, checkout, launcher and PATH line, and keeps the data", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    const zshrcBefore = m.profile(".zshrc");
    const openclawConfig = m.openclaw();

    const { code, text } = await uninstall(m);

    expect(code).toBe(0);
    // Services: stopped through systemd, collector before gateway, files gone.
    const disables = m.ran("systemctl", "--user", "disable").map((c) => c.argv[4]);
    expect(disables).toEqual(["omnesis-collector.service", "omnesis-gateway.service"]);
    expect(existsSync(m.path(".config", "systemd", "user", "omnesis-gateway.service"))).toBe(false);
    expect(existsSync(m.path(".config", "systemd", "user", "omnesis-collector.service"))).toBe(
      false,
    );
    // The CLI.
    expect(existsSync(m.path("omnesis"))).toBe(false);
    expect(existsSync(m.path(".local", "bin", "omnesis"))).toBe(false);
    expect(existsSync(m.path(".local", "lib", "omnesis"))).toBe(false);
    expect(readFileSync(m.path(".zshrc"), "utf8")).toBe(zshrcBefore);
    // OpenClaw: unregistered through its own CLI, every Omnesis file gone, the rest kept.
    const unregister = m.calls.filter((c) => c.argv[0]!.endsWith("/openclaw"));
    expect(unregister.map((c) => c.argv.slice(1))).toEqual([
      ["plugins", "uninstall", "omnesis-integration", "--force"],
      ["plugins", "uninstall", "omnesis-bridge", "--force"],
    ]);
    expect(unregister[0]!.opts.env).toMatchObject({ OPENCLAW_STATE_DIR: m.path(".openclaw") });
    expect(readFileSync(m.path(".openclaw", "openclaw.json"), "utf8")).toBe(openclawConfig);
    expect(readFileSync(m.path(".openclaw", ".env"), "utf8")).toBe("UNRELATED=keep\n");
    expect(existsSync(m.path(".openclaw", "skills", "omnesis"))).toBe(false);
    expect(existsSync(m.path(".openclaw", "skills", "weather", "SKILL.md"))).toBe(true);
    expect(existsSync(m.path(".openclaw", "omnesis"))).toBe(false);
    expect(existsSync(m.path(".openclaw", "openclaw.json.bak-omnesis"))).toBe(false);
    // The data stays, and the report says how to remove it later.
    expect(readFileSync(join(m.configDir, "omnesis.db"), "utf8")).toBe("fictional corpus");
    expect(text()).toContain("Your data stays in");
    expect(text()).toContain("npx omnesis uninstall --purge");
    // The update lock taken for the run is released.
    expect(existsSync(join(m.configDir, "update.lock"))).toBe(false);
  });

  test("running it again finds nothing left to remove", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    m.profile();
    expect((await uninstall(m)).code).toBe(0);
    const again = await uninstall(m);
    expect(again.code).toBe(0);
    expect(again.text()).toContain("Nothing of Omnesis to remove");
  });

  test("--purge also deletes the config directory, the logs and the keyring entries", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    m.write(m.path(".local", "state", "omnesis", "logs", "gateway.log"), "log line\n");
    m.write(join(m.configDir, "tls", "mkcert.crt"), "cert");

    const { code, text } = await uninstall(m, { purge: true });

    expect(code).toBe(0);
    expect(existsSync(m.configDir)).toBe(false);
    expect(existsSync(m.path(".local", "state", "omnesis"))).toBe(false);
    expect(m.ran("secret-tool", "clear", "service", "dev.omnesis")).toHaveLength(1);
    expect(text()).toContain("mkcert -uninstall");
  });

  test("--purge deletes nothing while a gateway still runs against the directory", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    m.holder = { pid: 4242 } as GatewayLockHolder;

    const { code, text } = await uninstall(m, { purge: true });

    expect(code).not.toBe(0);
    expect(existsSync(join(m.configDir, "omnesis.db"))).toBe(true);
    expect(text()).toContain("pid 4242");
    // Everything else still went.
    expect(existsSync(m.path(".local", "bin", "omnesis"))).toBe(false);
  });
});

describe("choosing what to remove", () => {
  test("one component leaves every other one in place", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    m.openclaw();

    const { code } = await uninstall(m, { components: ["openclaw"] });

    expect(code).toBe(0);
    expect(existsSync(m.path(".openclaw", "omnesis"))).toBe(false);
    expect(existsSync(m.path(".config", "systemd", "user", "omnesis-gateway.service"))).toBe(true);
    expect(existsSync(m.path(".local", "bin", "omnesis"))).toBe(true);
    expect(m.ran("systemctl")).toHaveLength(0);
  });

  test("the collector alone keeps the gateway and says what to do on the gateway host", async () => {
    const m = new Machine("linux").config().unit("collector").sourceInstall();
    const { code, text } = await uninstall(m, { components: ["collector"] });
    expect(code).toBe(0);
    expect(existsSync(m.path(".config", "systemd", "user", "omnesis-collector.service"))).toBe(
      false,
    );
    expect(text()).toContain("omnesis devices revoke");
  });

  test("a named component that is not installed is reported, not an error", async () => {
    const m = new Machine("linux").config().services();
    const { code, text } = await uninstall(m, { components: ["hermes", "collector"] });
    expect(code).toBe(0);
    expect(text()).toContain("Nothing of the hermes integration was found here");
  });

  test("--purge is refused while something that uses the data would stay", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    await expect(uninstall(m, { components: ["gateway"], purge: true })).rejects.toThrow(
      /--purge deletes .* omnesis-collector.service, the omnesis command would still use/,
    );
    expect(existsSync(m.path(".config", "systemd", "user", "omnesis-gateway.service"))).toBe(true);
  });

  test("the interactive picker narrows the plan to what was chosen", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    m.interactive = true;
    const { code, asked } = await uninstall(m, { yes: false }, { choose: ["collector"] });
    expect(code).toBe(0);
    expect(asked[0]).toBe("choose:collector,gateway,cli");
    expect(existsSync(m.path(".config", "systemd", "user", "omnesis-collector.service"))).toBe(
      false,
    );
    expect(existsSync(m.path(".config", "systemd", "user", "omnesis-gateway.service"))).toBe(true);
  });

  test("declining the confirmation changes nothing", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    m.interactive = true;
    const before = m.tree();
    await expect(uninstall(m, { yes: false }, { confirm: false })).rejects.toBeInstanceOf(CliError);
    expect(m.tree()).toEqual(before);
  });

  test("without a terminal it refuses to run unconfirmed", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    await expect(uninstall(m, { yes: false })).rejects.toThrow(/--yes/);
  });

  test("--dry-run lists every step and changes nothing", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    m.profile();
    m.openclaw();
    const before = m.tree();
    const { code, text } = await uninstall(m, { dryRun: true, purge: true, yes: false });
    expect(code).toBe(0);
    expect(m.tree()).toEqual(before);
    expect(text()).toContain("Stop and remove the gateway service omnesis-gateway.service");
    expect(text()).toContain("Delete the data, tokens and keys in");
    expect(text()).toContain("Dry run: nothing was changed.");
    expect(m.ran("systemctl")).toHaveLength(0);
  });

  test("--json reports each step and its outcome", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    const { code, lines } = await uninstall(m, { json: true });
    expect(code).toBe(0);
    const report = JSON.parse(lines.join("\n"));
    expect(report.components).toEqual(["collector", "gateway", "cli"]);
    expect(report.steps.every((s: { status: string }) => s.status === "done")).toBe(true);
    expect(report.kept[0]).toContain("Your data stays");
  });

  test("components parse from names, comma lists and all", () => {
    expect(parseComponents(["cli,gateway", "openclaw"])).toEqual(["openclaw", "gateway", "cli"]);
    expect(parseComponents(["all"])).toEqual([]);
    expect(parseComponents([])).toEqual([]);
    expect(() => parseComponents(["gatway"])).toThrow(/Unknown component: gatway/);
  });

  test("the command declares the flags the docs describe", () => {
    expect(Object.keys(uninstallCommand.args ?? {})).toEqual([
      "component",
      "purge",
      "yes",
      "dry-run",
      "json",
      "instance",
      "dir",
      "discard-local-changes",
    ]);
  });
});

describe("the CLI's own install", () => {
  test("a checkout with local changes stays unless they are discarded", async () => {
    const m = new Machine("linux").config().sourceInstall({ dirty: true });
    const kept = await uninstall(m, { components: ["cli"] });
    expect(kept.code).toBe(0);
    expect(existsSync(m.path("omnesis"))).toBe(true);
    expect(kept.text()).toContain("--discard-local-changes");
    expect(existsSync(m.path(".local", "bin", "omnesis"))).toBe(false);

    // The record still names the checkout, so a second run can remove it.
    const removed = await uninstall(m, { components: ["cli"], discardLocalChanges: true });
    expect(removed.code).toBe(0);
    expect(existsSync(m.path("omnesis"))).toBe(false);
  });

  test("a checkout the installer did not make is never deleted", async () => {
    const m = new Machine("linux").config().sourceInstall({ managed: false });
    const { text } = await uninstall(m, { components: ["cli"], discardLocalChanges: true });
    expect(existsSync(m.path("omnesis", "packages", "cli", "package.json"))).toBe(true);
    expect(text()).toContain("not a checkout the installer made");
  });

  test("a package install is uninstalled through npm with its own prefix", async () => {
    const m = new Machine("linux").config().packageInstall();
    m.profile(".bashrc");
    const { code } = await uninstall(m, { components: ["cli"] });
    expect(code).toBe(0);
    const npm = m.ran("npm", "uninstall");
    expect(npm.map((c) => c.argv)).toEqual([
      ["npm", "uninstall", "-g", "omnesis", "--prefix", m.path(".npm-global")],
    ]);
    expect(existsSync(m.path(".npm-global", "lib", "node_modules", "omnesis"))).toBe(false);
    expect(existsSync(m.path(".local", "bin", "omnesis"))).toBe(false);
    expect(readFileSync(m.path(".bashrc"), "utf8")).not.toContain(PROFILE_MARKER);
  });

  test("a package in a root-owned prefix is uninstalled through sudo", async () => {
    const m = new Machine("linux").config().packageInstall();
    m.on(["npm", "uninstall"], { code: 243, stderr: "npm error code EACCES" });
    m.on(["sudo", "-n", "npm", "uninstall"], (argv) => {
      rmSync(join(argv[argv.indexOf("--prefix") + 1]!, "lib", "node_modules", "omnesis"), {
        recursive: true,
        force: true,
      });
      return {};
    });
    expect((await uninstall(m, { components: ["cli"] })).code).toBe(0);
    expect(existsSync(m.path(".npm-global", "lib", "node_modules", "omnesis"))).toBe(false);
  });

  test("without npm, the package's files are removed directly", async () => {
    const m = new Machine("linux").config().packageInstall();
    m.on(["npm"], { code: 127, stderr: "spawn npm ENOENT" });
    expect((await uninstall(m, { components: ["cli"] })).code).toBe(0);
    expect(existsSync(m.path(".npm-global", "lib", "node_modules", "omnesis"))).toBe(false);
    expect(lstatOrNull(m.path(".npm-global", "bin", "omnesis"))).toBeNull();
  });

  test("a launcher of the operator's own and its PATH line stay", async () => {
    const m = new Machine("linux").config();
    m.write(
      m.path(".local", "bin", "omnesis"),
      '#!/bin/bash\nexec node ~/dev/omnesis/cli.js "$@"\n',
      0o755,
    );
    m.write(m.path(".local", "lib", "omnesis", "update-lock.cjs"), "//\n");
    m.profile();
    const { text } = await uninstall(m, { components: ["cli"] });
    expect(existsSync(m.path(".local", "bin", "omnesis"))).toBe(true);
    expect(readFileSync(m.path(".zshrc"), "utf8")).toContain(PROFILE_MARKER);
    expect(text()).toContain("it is not a launcher the installer writes");
  });

  test("the PATH line stays while other programs live in ~/.local/bin", async () => {
    const m = new Machine("linux").config().sourceInstall();
    m.write(m.path(".local", "bin", "uv"), "#!/bin/sh\n", 0o755);
    m.profile(".config/fish/config.fish", "set -gx EDITOR vim\n");
    const { text } = await uninstall(m, { components: ["cli"] });
    expect(readFileSync(m.path(".config", "fish", "config.fish"), "utf8")).toContain(
      PROFILE_MARKER,
    );
    expect(text()).toContain("other programs live there");
    expect(existsSync(m.path(".local", "bin", "uv"))).toBe(true);
  });

  test("leftover launchers of an interrupted install are swept up", async () => {
    const m = new Machine("linux").config().packageInstall();
    m.write(m.path(".local", "bin", "omnesis.omnesis-migration-1234.previous"), "#!/bin/sh\n");
    m.write(m.path(".local", "bin", ".omnesis-package.Ab12Cd"), "#!/bin/sh\n");
    m.profile();
    expect((await uninstall(m, { components: ["cli"] })).code).toBe(0);
    expect(readdirSync(m.path(".local", "bin"))).toEqual([]);
    expect(readFileSync(m.path(".zshrc"), "utf8")).not.toContain(PROFILE_MARKER);
  });
});

describe("services", () => {
  test("without the systemd user manager a unit is left in place, and the rest still goes", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    m.on(["systemctl", "--user", "show-environment"], {
      code: 1,
      stderr: "Failed to connect to bus: No medium found",
    });
    const { code, text } = await uninstall(m);
    expect(code).not.toBe(0);
    expect(existsSync(m.path(".config", "systemd", "user", "omnesis-gateway.service"))).toBe(true);
    expect(text()).toContain("Cannot reach your systemd user manager");
    expect(existsSync(m.path(".local", "bin", "omnesis"))).toBe(false);
  });

  test("a unit that keeps running is reported", async () => {
    const m = new Machine("linux").config().unit("gateway");
    m.on(["systemctl", "--user", "is-active"], { stdout: "active\n" });
    const { code, text } = await uninstall(m, { components: ["gateway"] });
    expect(code).not.toBe(0);
    expect(text()).toContain("still active");
  });

  test("--instance removes that instance alone", async () => {
    const m = new Machine("linux").config().services();
    const staging = join(m.home, ".config", "omnesis-staging");
    m.write(join(staging, "omnesis.json"), "{}\n");
    m.unit("gateway", "staging", staging).unit("collector", "staging", staging);

    const { code } = await uninstall(m, {
      instance: "staging",
      configDir: staging,
      purge: true,
      components: ["gateway", "collector"],
    });

    expect(code).toBe(0);
    const units = readdirSync(m.path(".config", "systemd", "user"));
    expect(units.sort()).toEqual(["omnesis-collector.service", "omnesis-gateway.service"]);
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(m.configDir)).toBe(true);
    // Another instance remains, so the shared root key stays in the keyring.
    expect(m.ran("secret-tool")).toHaveLength(0);
  });

  test("--instance alone touches that instance's services and nothing machine-wide", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    m.openclaw();
    const staging = join(m.home, ".config", "omnesis-staging");
    m.write(join(staging, "omnesis.json"), "{}\n");
    m.unit("gateway", "staging", staging);

    const { code } = await uninstall(m, { instance: "staging", configDir: staging });

    expect(code).toBe(0);
    expect(readdirSync(m.path(".config", "systemd", "user")).sort()).toEqual([
      "omnesis-collector.service",
      "omnesis-gateway.service",
    ]);
    expect(existsSync(m.path(".local", "bin", "omnesis"))).toBe(true);
    expect(existsSync(m.path("omnesis"))).toBe(true);
    expect(existsSync(m.path(".openclaw", "omnesis"))).toBe(true);
    expect(existsSync(staging)).toBe(true);
  });

  test("--purge is refused when another instance runs against the same directory", async () => {
    const m = new Machine("linux").config().services();
    m.unit("gateway", "mirror", m.configDir);
    await expect(
      uninstall(m, { purge: true, components: ["gateway", "collector"] }),
    ).rejects.toThrow(/another instance/);
  });

  test("the retired runner unit goes with the collector", async () => {
    const m = new Machine("linux").config().unit("collector");
    m.write(m.path(".config", "systemd", "user", "omnesis-runner.service"), "[Service]\n");
    expect((await uninstall(m, { components: ["collector"] })).code).toBe(0);
    expect(existsSync(m.path(".config", "systemd", "user", "omnesis-runner.service"))).toBe(false);
  });
});

describe("macOS", () => {
  test("LaunchAgents are booted out and removed; the keychain is swept on --purge", async () => {
    const m = new Machine("darwin").config().services().packageInstall();
    m.profile(".bash_profile");
    let deletes = 0;
    m.on(["security", "find-generic-password"], { code: 44, stderr: "could not be found" });
    m.on(["security", "delete-generic-password"], () =>
      ++deletes <= 2 ? {} : { code: 44, stderr: "could not be found" },
    );

    const { code, text } = await uninstall(m, { purge: true });

    expect(code).toBe(0);
    const bootouts = m.ran("launchctl", "bootout").map((c) => c.argv[2]);
    expect(bootouts).toEqual(["gui/501/dev.omnesis.collector", "gui/501/dev.omnesis.gateway"]);
    expect(readdirSync(m.path("Library", "LaunchAgents"))).toEqual([]);
    expect(deletes).toBe(3);
    expect(existsSync(m.configDir)).toBe(false);
    expect(readFileSync(m.path(".bash_profile"), "utf8")).not.toContain(PROFILE_MARKER);
    expect(text()).toMatch(/full disk access/i);
  });
});

describe("the hardened gateway", () => {
  function hardened(m: Machine, admin: boolean): void {
    m.write(join(m.system, "etc", "systemd", "system", "omnesis-gateway.service"), "[Service]\n");
    if (admin) {
      m.write(
        join(m.system, "usr", "local", "sbin", "omnesis-gateway-admin"),
        "#!/bin/sh\n",
        0o755,
      );
      m.write(
        join(m.system, "etc", "omnesis-gateway", "install.env"),
        "OMNESIS_HARDENED_PORT=7600\n",
      );
    }
  }

  test("is removed by its admin command through passwordless sudo", async () => {
    const m = new Machine("linux").config();
    hardened(m, true);
    const { code } = await uninstall(m, { components: ["gateway"] });
    expect(code).toBe(0);
    expect(m.ran("sudo", "-n", "/usr/local/sbin/omnesis-gateway-admin", "uninstall")).toHaveLength(
      1,
    );
  });

  test("asks for the sudo password when a terminal can answer", async () => {
    const m = new Machine("linux").config();
    hardened(m, true);
    m.interactive = true;
    m.on(["sudo", "-n"], { code: 1, stderr: "sudo: a password is required" });
    const { code } = await uninstall(m, { components: ["gateway"] });
    expect(code).toBe(0);
    expect(m.interactiveCalls).toEqual([
      ["sudo", "/usr/local/sbin/omnesis-gateway-admin", "uninstall"],
    ]);
  });

  test("hands over the commands when nothing can answer sudo", async () => {
    const m = new Machine("linux").config();
    hardened(m, false);
    m.on(["sudo", "-n"], { code: 1, stderr: "sudo: a password is required" });
    const { code, text } = await uninstall(m, { components: ["gateway"] });
    expect(code).not.toBe(0);
    expect(text()).toContain("sudo systemctl disable --now omnesis-gateway.service");
    expect(text()).toContain("sudo rm -f /etc/systemd/system/omnesis-gateway.service");
  });

  test("runs directly as root, and --purge deletes its state and passphrase", async () => {
    const m = new Machine("linux").config();
    hardened(m, true);
    m.isRoot = true;
    expect((await uninstall(m, { purge: true })).code).toBe(0);
    expect(m.ran("/usr/local/sbin/omnesis-gateway-admin", "uninstall")).toHaveLength(1);
    expect(m.ran("rm", "-rf", "/var/lib/omnesis-gateway")[0]!.argv).toEqual([
      "rm",
      "-rf",
      "/var/lib/omnesis-gateway",
      "/var/lib/private/omnesis-gateway",
      "/etc/omnesis-gateway",
      "/var/cache/private/omnesis-gateway-build",
    ]);
    expect(m.ran("sudo")).toHaveLength(0);
  });

  test("without --purge its corpus is said to stay", async () => {
    const m = new Machine("linux").config();
    hardened(m, true);
    const { text } = await uninstall(m, { components: ["gateway"] });
    expect(text()).toContain("/var/lib/omnesis-gateway");
  });
});

describe("Docker", () => {
  function docker(m: Machine): string {
    const compose = m.write(
      join(m.configDir, "docker-compose.yml"),
      "name: omnesis\nservices: {}\n",
    );
    m.write(join(m.configDir, "install-method"), "docker\n");
    m.write(
      m.path(".local", "bin", "omnesis"),
      `#!/bin/sh\n${DOCKER_WRAPPER_MARKER}\nCOMPOSE_FILE='${compose}'\nSERVICE='gateway'\nset -eu\n`,
      0o755,
    );
    return compose;
  }

  test("is taken down whole: containers, images, compose file and launcher", async () => {
    const m = new Machine("linux").config();
    const compose = docker(m);
    const { code } = await uninstall(m);
    expect(code).toBe(0);
    expect(m.ran("docker")[0]!.argv).toEqual([
      "docker",
      "compose",
      "-f",
      compose,
      "--profile",
      "update",
      "down",
      "--rmi",
      "all",
      "--remove-orphans",
    ]);
    expect(existsSync(compose)).toBe(false);
    expect(existsSync(join(m.configDir, "install-method"))).toBe(false);
    expect(existsSync(m.path(".local", "bin", "omnesis"))).toBe(false);
    expect(existsSync(join(m.configDir, "omnesis.db"))).toBe(true);
  });

  test("refuses to take only part of it", async () => {
    const m = new Machine("linux").config();
    docker(m);
    await expect(uninstall(m, { components: ["collector"] })).rejects.toThrow(/removed as a whole/);
  });

  test("inside one of its containers, points at the host", async () => {
    const m = new Machine("linux").config();
    docker(m);
    m.inContainer = true;
    await expect(uninstall(m)).rejects.toThrow(/on the host/);
  });

  test("only the image's own CLI counts as inside the Docker install", () => {
    expect(isDockerInstallImage("/app/packages/cli/dist/uninstall/context.js", true)).toBe(true);
    // systemd in a container, running a hardened release's CLI
    expect(
      isDockerInstallImage(
        "/opt/omnesis-gateway/releases/a/packages/cli/dist/uninstall/context.js",
        true,
      ),
    ).toBe(false);
    expect(isDockerInstallImage("/app/packages/cli/dist/uninstall/context.js", false)).toBe(false);
  });
});

describe("Hermes", () => {
  test("loses the plugin, its config entries, skill and settings; everything else stays", async () => {
    const m = new Machine("linux");
    m.hermes();
    const { code } = await uninstall(m, { components: ["hermes"] });
    expect(code).toBe(0);
    const home = m.path(".hermes");
    expect(existsSync(join(home, "plugins", "omnesis-integration"))).toBe(false);
    expect(existsSync(join(home, "plugins", "weather-tools", "plugin.yaml"))).toBe(true);
    const config = readFileSync(join(home, "config.yaml"), "utf8");
    expect(config).not.toContain("omnesis");
    expect(config).toContain("weather-tools");
    expect(config).toContain("background_process_notifications: all");
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(existsSync(join(home, "skills", "productivity", "omnesis"))).toBe(false);
    expect(existsSync(join(home, "skills", "productivity", "todo", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "omnesis"))).toBe(false);
  });

  test("--dir points at a harness home elsewhere", async () => {
    const m = new Machine("linux");
    m.hermes();
    const elsewhere = join(m.root, "srv-hermes");
    rmSync(elsewhere, { recursive: true, force: true });
    // Move the fixture home to a non-default place.
    m.write(join(elsewhere, "omnesis", "integration.json"), "{}\n");
    rmSync(m.path(".hermes"), { recursive: true, force: true });
    expect((await uninstall(m, { components: ["hermes"], dir: elsewhere })).code).toBe(0);
    expect(existsSync(join(elsewhere, "omnesis"))).toBe(false);
    await expect(uninstall(m, { dir: elsewhere })).rejects.toThrow(
      /exactly one of openclaw or hermes/,
    );
  });
});

describe("OpenClaw", () => {
  test("a plugin OpenClaw no longer knows of counts as removed", async () => {
    const m = new Machine("linux");
    m.openclaw();
    m.on(["openclaw", "plugins", "uninstall"], {
      code: 1,
      stderr: "Plugin not found: omnesis-integration",
    });
    expect((await uninstall(m, { components: ["openclaw"] })).code).toBe(0);
  });

  test("a failing OpenClaw is reported, and Omnesis's own files still go", async () => {
    const m = new Machine("linux");
    m.openclaw();
    m.on(["openclaw", "plugins", "uninstall"], { code: 1, stderr: "registry locked" });
    const { code, text } = await uninstall(m, { components: ["openclaw"] });
    expect(code).not.toBe(0);
    expect(text()).toContain("registry locked");
    expect(existsSync(m.path(".openclaw", "omnesis"))).toBe(false);
  });

  test("names the device to revoke when the gateway is elsewhere", async () => {
    const m = new Machine("linux");
    m.openclaw();
    const { text } = await uninstall(m, { components: ["openclaw"] });
    expect(text()).toContain("omnesis devices revoke omnesis-openclaw-0123456789ab --forget");
    expect(text()).toContain("openclaw gateway restart");
  });
});

describe("the claude and codex clients", () => {
  function clients(m: Machine): string {
    const project = m.path("work", "riverside");
    mkdirSync(project, { recursive: true });
    // Both tools are installed; anything not scripted below succeeds.
    m.on(["claude"], {}).on(["codex"], {});
    m.on(["claude", "--version"], { stdout: "2.1.310\n" });
    m.on(["claude", "plugin", "list", "--json"], {
      stdout: JSON.stringify([
        { id: "omnesis@omnesis", scope: "user" },
        { id: "omnesis@omnesis", scope: "project", projectPath: project },
        { id: "weather@other", scope: "user" },
      ]),
    });
    m.on(["claude", "plugin", "marketplace", "list", "--json"], {
      stdout: JSON.stringify([
        { name: "omnesis", source: "github", repo: "omnesis-dev/Omnesis" },
        { name: "other", source: "github", repo: "example/other" },
      ]),
    });
    m.write(
      m.path(".claude.json"),
      JSON.stringify({
        mcpServers: { omnesis: { type: "http" }, weather: { type: "http" } },
        projects: { [project]: { mcpServers: { omnesis: { type: "http" } } } },
      }),
    );
    m.on(["codex", "--version"], { stdout: "codex-cli 0.164.0\n" });
    m.on(["codex", "mcp", "list", "--json"], {
      stdout: JSON.stringify([{ name: "omnesis" }, { name: "docs" }]),
    });
    m.on(["codex", "plugin", "list", "--json"], {
      stdout: JSON.stringify({
        installed: [
          { pluginId: "omnesis@omnesis", name: "omnesis", marketplaceName: "omnesis" },
          { pluginId: "omnesis@personal", name: "omnesis", marketplaceName: "personal" },
        ],
      }),
    });
    m.on(["codex", "plugin", "marketplace", "list", "--json"], {
      stdout: JSON.stringify({
        marketplaces: [
          {
            name: "omnesis",
            marketplaceSource: { source: "https://github.com/omnesis-dev/Omnesis.git" },
          },
          { name: "personal", root: "/home" },
        ],
      }),
    });
    return project;
  }

  test("each removes exactly its Omnesis entries, through its own CLI", async () => {
    const m = new Machine("linux");
    const project = clients(m);
    const { code, text } = await uninstall(m, { components: ["claude-code", "codex"] });
    expect(code, text()).toBe(0);
    const removals = m.calls
      .filter(
        (c) =>
          (c.argv[0] === "claude" || c.argv[0] === "codex") &&
          !c.argv.includes("--json") &&
          c.argv[1] !== "--version",
      )
      .map((c) => [...c.argv, ...(c.opts.cwd ? [`(in ${c.opts.cwd})`] : [])]);
    expect(removals).toEqual([
      ["claude", "plugin", "uninstall", "omnesis@omnesis", "--scope", "user"],
      ["claude", "plugin", "uninstall", "omnesis@omnesis", "--scope", "project", `(in ${project})`],
      ["claude", "mcp", "remove", "omnesis", "--scope", "user"],
      ["claude", "mcp", "remove", "omnesis", "--scope", "local", `(in ${project})`],
      ["claude", "plugin", "marketplace", "remove", "omnesis"],
      ["codex", "plugin", "remove", "omnesis@omnesis"],
      ["codex", "mcp", "logout", "omnesis"],
      ["codex", "mcp", "remove", "omnesis"],
      ["codex", "plugin", "marketplace", "remove", "omnesis"],
    ]);
  });

  test("an entry that is already gone, or a sign-out with no session, is not a failure", async () => {
    const m = new Machine("linux");
    clients(m);
    m.on(["codex", "mcp", "logout"], { code: 1, stderr: "No OAuth credentials stored" });
    m.on(["claude", "mcp", "remove"], {
      code: 1,
      stderr: 'No MCP server found with name: "omnesis"',
    });
    expect((await uninstall(m, { components: ["claude-code", "codex"] })).code).toBe(0);
  });

  test("a tool that is not installed is simply not there", async () => {
    const m = new Machine("linux");
    const { code, text } = await uninstall(m, { components: ["claude-code"] });
    expect(code).toBe(0);
    expect(text()).toContain("Nothing of the claude code plugin and mcp server was found here");
  });
});

describe("safety", () => {
  test("an update in progress blocks the uninstall", async () => {
    const m = new Machine("linux").config().services();
    const lock = acquireUpdateLock(m.configDir, { owner: "omnesis update" });
    try {
      await expect(uninstall(m)).rejects.toThrow(/is running on this host/);
      expect(existsSync(m.path(".config", "systemd", "user", "omnesis-gateway.service"))).toBe(
        true,
      );
    } finally {
      lock.release();
    }
  });

  test("a client's empty config directory and its keys go on --purge, despite the run's own lock", async () => {
    // A client-only install leaves the directory empty; the uninstall's update
    // lock is then the only thing in it while the keys are deleted.
    const m = new Machine("linux").packageInstall();
    mkdirSync(m.configDir, { recursive: true });
    const { code, text } = await uninstall(m, { purge: true });
    expect(code, text()).toBe(0);
    expect(existsSync(m.configDir)).toBe(false);
    expect(m.ran("secret-tool", "clear", "service", "dev.omnesis")).toHaveLength(1);
  });

  test("a config directory that does not look like Omnesis's is never purged", async () => {
    const m = new Machine("linux");
    const projects = m.path("projects");
    m.write(join(projects, "thesis.tex"), "\\documentclass{article}\n");
    m.unit("gateway", undefined, projects);
    const { code, text } = await uninstall(m, { configDir: projects, purge: true });
    expect(code).not.toBe(0);
    expect(existsSync(join(projects, "thesis.tex"))).toBe(true);
    expect(text()).toContain("Refusing to delete");
  });

  test("the home directory itself is never purged", async () => {
    const m = new Machine("linux");
    m.write(m.path(".env"), "X=1\n");
    m.unit("gateway", undefined, m.home);
    const { code } = await uninstall(m, { configDir: m.home, purge: true });
    expect(code).not.toBe(0);
    expect(existsSync(m.path(".env"))).toBe(true);
  });

  test("file modes survive an edit", async () => {
    const m = new Machine("linux");
    m.openclaw();
    chmodSync(m.path(".openclaw", "openclaw.json"), 0o600);
    await uninstall(m, { components: ["openclaw"] });
    expect(statSync(m.path(".openclaw", "openclaw.json")).mode & 0o777).toBe(0o600);
  });
});

describe("what the review found", () => {
  test("--instance never falls back to the default config directory", async () => {
    const m = new Machine("linux").config().sourceInstall();
    const { code } = await uninstall(m, { instance: "typo", purge: true, configDir: undefined });
    expect(code).toBe(0);
    expect(existsSync(join(m.configDir, "omnesis.db"))).toBe(true);
    expect(existsSync(m.path(".local", "bin", "omnesis"))).toBe(true);
  });

  test("an instance's kept data names the instance in the later purge command", async () => {
    const m = new Machine("linux").config().services();
    const staging = join(m.home, ".config", "omnesis-staging");
    m.write(join(staging, "omnesis.json"), "{}\n");
    m.unit("gateway", "staging", staging);
    const { text } = await uninstall(m, { instance: "staging", configDir: undefined });
    expect(text()).toContain(
      `OMNESIS_CONFIG_DIR=${staging} npx omnesis uninstall --instance staging --purge`,
    );
  });

  test("the keyring's root key stays while another Omnesis config directory exists", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    const other = m.write(join(m.home, ".config", "omnesis-test", "omnesis.json"), "{}\n");
    const { code, text } = await uninstall(m, { purge: true });
    expect(code).toBe(0);
    expect(existsSync(m.configDir)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(m.ran("secret-tool")).toHaveLength(0);
    expect(text()).toContain("The keyring's root key stays");
  });

  test("no key is touched when the data it opens cannot be purged", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    m.holder = { pid: 4242 } as GatewayLockHolder;
    await uninstall(m, { purge: true });
    expect(m.ran("secret-tool")).toHaveLength(0);
  });

  test("a service that could not be stopped keeps the data and the keys", async () => {
    const m = new Machine("linux").config().services().sourceInstall();
    m.on(["systemctl", "--user", "show-environment"], {
      code: 1,
      stderr: "Failed to connect to bus",
    });
    const { code, text } = await uninstall(m, { purge: true });
    expect(code).not.toBe(0);
    expect(existsSync(join(m.configDir, "omnesis.db"))).toBe(true);
    expect(m.ran("secret-tool")).toHaveLength(0);
    expect(text()).toContain("not attempted");
  });

  test("a failed compose down keeps the compose file and the launcher", async () => {
    const m = new Machine("linux").config();
    const compose = m.write(join(m.configDir, "docker-compose.yml"), "name: omnesis\n");
    m.write(join(m.configDir, "install-method"), "docker\n");
    m.write(
      m.path(".local", "bin", "omnesis"),
      `#!/bin/sh\n${DOCKER_WRAPPER_MARKER}\nCOMPOSE_FILE='${compose}'\nSERVICE='gateway'\n`,
      0o755,
    );
    m.on(["docker"], { code: 1, stderr: "Cannot connect to the Docker daemon" });
    const { code } = await uninstall(m);
    expect(code).not.toBe(0);
    expect(existsSync(compose)).toBe(true);
    expect(existsSync(m.path(".local", "bin", "omnesis"))).toBe(true);
  });

  test("a Docker install whose launcher is gone can still be removed", async () => {
    const m = new Machine("linux").config();
    const compose = m.write(join(m.configDir, "docker-compose.yml"), "name: omnesis\n");
    m.write(join(m.configDir, "install-method"), "docker\n");
    const { code } = await uninstall(m);
    expect(code).toBe(0);
    expect(m.ran("docker", "compose", "-f", compose)).toHaveLength(1);
    expect(existsSync(compose)).toBe(false);
  });

  test("the command stays while another instance's service runs it", async () => {
    const m = new Machine("linux").config().services().packageInstall();
    const staging = join(m.home, ".config", "omnesis-b");
    m.write(join(staging, "omnesis.json"), "{}\n");
    m.unit("gateway", "b", staging);

    const { code, text } = await uninstall(m);
    expect(code).toBe(0);
    expect(existsSync(m.path(".npm-global", "lib", "node_modules", "omnesis"))).toBe(true);
    expect(text()).toContain("The omnesis command stays: omnesis-gateway-b.service still run it");
    await expect(uninstall(m, { components: ["cli"] })).rejects.toThrow(/still run it/);
  });

  test("a profile linked from a dotfiles repository is edited where it lives", async () => {
    const m = new Machine("linux").config().sourceInstall();
    const repo = m.path("dotfiles", "zshrc");
    m.write(
      repo,
      `export EDITOR=vim\n\n${PROFILE_MARKER}\nexport PATH="${m.path(".local", "bin")}:$PATH"\n`,
    );
    symlinkSync(repo, m.path(".zshrc"));
    expect((await uninstall(m, { components: ["cli"] })).code).toBe(0);
    expect(lstatSync(m.path(".zshrc")).isSymbolicLink()).toBe(true);
    expect(readFileSync(repo, "utf8")).toBe("export EDITOR=vim\n");
  });

  test("a claude project directory that no longer exists is reported, not failed on", async () => {
    const m = new Machine("linux");
    m.on(["claude"], {}).on(["claude", "plugin"], { stdout: "[]" });
    m.write(
      m.path(".claude.json"),
      JSON.stringify({
        mcpServers: { omnesis: {} },
        projects: { [m.path("gone")]: { mcpServers: { omnesis: {} } } },
      }),
    );
    const { code, text } = await uninstall(m, { components: ["claude-code"] });
    expect(code).toBe(0);
    expect(m.ran("claude", "mcp", "remove")).toHaveLength(1);
    expect(text()).toContain("no longer exists");
  });

  test("a hardened gateway's purge goes ahead while the client CLI keeps its directory", async () => {
    const m = new Machine("linux").config().sourceInstall();
    m.write(join(m.system, "etc", "systemd", "system", "omnesis-gateway.service"), "[Service]\n");
    m.write(join(m.system, "usr", "local", "sbin", "omnesis-gateway-admin"), "#!/bin/sh\n", 0o755);
    const { code, text } = await uninstall(m, { components: ["gateway"], purge: true });
    expect(code).toBe(0);
    expect(m.ran("sudo", "-n", "rm", "-rf", "/var/lib/omnesis-gateway")).toHaveLength(1);
    expect(existsSync(join(m.configDir, "omnesis.db"))).toBe(true);
    expect(text()).toContain("the omnesis command still use it");
  });

  test("a keychain that refuses the deletion is reported", async () => {
    const m = new Machine("darwin").config().services().packageInstall();
    m.on(["security", "delete-generic-password"], {
      code: 36,
      stderr: "User interaction is not allowed.",
    });
    const { code, text } = await uninstall(m, { purge: true });
    expect(code).not.toBe(0);
    expect(text()).toContain("unlock it");
  });

  test("operator drop-ins are kept and named", async () => {
    const m = new Machine("linux").config().unit("gateway");
    m.write(
      m.path(".config", "systemd", "user", "omnesis-gateway.service.d", "dev.conf"),
      "[Service]\n",
    );
    const { text } = await uninstall(m, { components: ["gateway"] });
    expect(text()).toContain("omnesis-gateway.service.d stays: your own overrides");
    expect(
      existsSync(m.path(".config", "systemd", "user", "omnesis-gateway.service.d", "dev.conf")),
    ).toBe(true);
  });

  test("a directory with only a .env is not taken for a config directory", async () => {
    const m = new Machine("linux");
    const project = m.path("site");
    m.write(join(project, ".env"), "PORT=8080\n");
    m.write(join(project, "index.html"), "<p>hello</p>\n");
    m.unit("gateway", undefined, project);
    const { code } = await uninstall(m, { configDir: project, purge: true });
    expect(code).not.toBe(0);
    expect(existsSync(join(project, "index.html"))).toBe(true);
  });
});

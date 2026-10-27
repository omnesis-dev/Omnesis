// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Carry out one planned step. Every action is idempotent — a step whose
 * target is already gone is done — and none throws: a failure becomes that
 * step's result, so one stuck piece never strands the rest of a removal half
 * done, and the report says exactly what is left.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  atomicWriteFileSync,
  clearMarkerKeyringState,
  createSecretStore,
  OMNESIS_INSTALL_ROOT_KEY,
  OMNESIS_SECRET_SERVICE,
  type SecureMarkerKind,
} from "@omnesis/core";
import { uninstallLegacyRunnerService } from "../commands/service.js";
import {
  INTEGRATION_PLUGIN_ID,
  LEGACY_PLUGIN_ID,
  stripHarnessEnv,
  stripHermesConfig,
  stripOpenClawConfig,
} from "./harness-config.js";
import { removeInstallerPathLines } from "./profile.js";
import type { UninstallContext } from "./context.js";
import type { Action, PrivilegedCommand, Step, StepResult } from "./types.js";

const SECURE_MARKER_KINDS: readonly SecureMarkerKind[] = ["storage-encryption", "secret-files"];

/**
 * Files only an Omnesis config directory holds; one of them must be there
 * before a purge. Names any project could have (`.env`, `tls/`, `models/`)
 * prove nothing on their own.
 */
const CONFIG_DIR_EVIDENCE = [
  "omnesis.json",
  "omnesis.db",
  "keyring",
  "collector-token",
  "collector-pairing-state.json",
  "update-state.json",
  "install-method",
  join("tls", "cert.pem"),
];

/** Where `acquireUpdateLock` keeps the lock this run holds, inside the config directory. */
const UPDATE_LOCK_DIR = "update.lock";

class StepFailure extends Error {
  constructor(
    message: string,
    readonly status: "failed" | "needs-action" = "failed",
  ) {
    super(message);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function output(res: { stdout: string; stderr: string }): string {
  return `${res.stderr}\n${res.stdout}`.trim();
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

/** Refuse a recursive delete of `/`, the home directory or anything above it. */
function assertRemovable(ctx: UninstallContext, path: string): void {
  const target = canonical(path);
  const home = canonical(ctx.home);
  if (target === resolve("/") || isInside(home, target)) {
    throw new StepFailure(`Refusing to delete ${path}: it contains your home directory.`);
  }
}

function removePath(ctx: UninstallContext, path: string): void {
  assertRemovable(ctx, path);
  rmSync(path, { recursive: true, force: true });
  if (existsSync(path)) throw new StepFailure(`${path} is still there after removing it.`);
}

function editFile(path: string, edit: (text: string) => string | null): string | undefined {
  if (!existsSync(path)) return "already gone";
  // A dotfile linked from a dotfiles repository is edited where it lives, so
  // the link stays a link.
  const target = canonical(path);
  const text = readFileSync(target, "utf8");
  const next = edit(text);
  if (next === text) return "nothing of Omnesis left in it";
  if (next === null) {
    rmSync(target, { force: true });
    if (target !== path) rmSync(path, { force: true });
    return "it held only Omnesis settings, so it was removed";
  }
  atomicWriteFileSync(target, next, { mode: statSync(target).mode & 0o7777 });
  return undefined;
}

// ── Harnesses ─────────────────────────────────────────────────────────

/** OpenClaw's diagnostics for a plugin id it has no install record of — one wording per release line. */
const OPENCLAW_PLUGIN_ABSENT = /Plugin not found|is not associated with a tracked package install/;

async function unregisterOpenClawPlugin(
  ctx: UninstallContext,
  binary: string,
  env: Record<string, string>,
): Promise<void> {
  for (const id of [INTEGRATION_PLUGIN_ID, LEGACY_PLUGIN_ID]) {
    const res = await ctx.run(binary, ["plugins", "uninstall", id, "--force"], { env });
    if (res.code === 0 || OPENCLAW_PLUGIN_ABSENT.test(output(res))) continue;
    throw new StepFailure(
      `openclaw plugins uninstall ${id} failed (${res.code}): ${output(res) || "no output"}`,
    );
  }
}

// ── Services ───────────────────────────────────────────────────────────

async function removeService(
  ctx: UninstallContext,
  action: Extract<Action, { type: "service" }>,
): Promise<string | undefined> {
  const supervisor = ctx.supervisor();
  const unit = supervisor.unitName(action.component, action.instance);
  if (!supervisor.isInstalled(action.component, action.instance)) return "already gone";
  if (ctx.platform === "linux") {
    // Without the user manager there is nothing to stop the daemon through:
    // deleting its unit would leave it running with no way to reach it.
    const manager = await ctx.run("systemctl", ["--user", "show-environment"]);
    if (manager.code !== 0) {
      throw new StepFailure(
        `Cannot reach your systemd user manager (${output(manager) || `exit ${manager.code}`}), so ${unit} was left in place. ` +
          "Run this from a login session of this account (or with XDG_RUNTIME_DIR set) and try again.",
      );
    }
  }
  await supervisor.uninstall(action.component, action.instance);
  if (ctx.platform === "linux") {
    const active = await ctx.run("systemctl", ["--user", "is-active", unit]);
    const state = active.stdout.trim();
    if (state === "active" || state === "activating" || state === "deactivating") {
      throw new StepFailure(`${unit} is still ${state} after it was disabled.`);
    }
  }
  if (supervisor.isInstalled(action.component, action.instance)) {
    throw new StepFailure(
      `${supervisor.unitPath(action.component, action.instance)} is still there.`,
    );
  }
  return undefined;
}

// ── Root ───────────────────────────────────────────────────────────────

function sudoHint(commands: PrivilegedCommand[]): string {
  return commands.map((c) => `sudo ${c.argv.join(" ")}`).join("\n");
}

/**
 * Run commands as root: directly when this is root, through `sudo -n` when
 * sudo needs no password, and through an interactive `sudo` when a terminal
 * can answer its prompt. Otherwise the step hands the operator the commands.
 */
async function runPrivileged(ctx: UninstallContext, commands: PrivilegedCommand[]): Promise<void> {
  let viaInteractiveSudo = false;
  for (const [index, command] of commands.entries()) {
    const [cmd, ...args] = command.argv as [string, ...string[]];
    let code: number;
    let detail = "";
    if (ctx.isRoot) {
      const res = await ctx.run(cmd, args);
      code = res.code;
      detail = output(res);
    } else if (viaInteractiveSudo) {
      code = await ctx.runInteractive("sudo", [cmd, ...args]);
    } else {
      const res = await ctx.run("sudo", ["-n", cmd, ...args]);
      code = res.code;
      detail = output(res);
      const needsPassword = res.code !== 0 && /password|a terminal is required/i.test(detail);
      if (res.code === 127 || needsPassword) {
        if (!ctx.interactive || res.code === 127) {
          throw new StepFailure(
            `This needs root. Run:\n${sudoHint(commands.slice(index))}`,
            "needs-action",
          );
        }
        viaInteractiveSudo = true;
        code = await ctx.runInteractive("sudo", [cmd, ...args]);
        detail = "";
      }
    }
    if (code !== 0 && !command.tolerateFailure) {
      throw new StepFailure(
        `\`${command.argv.join(" ")}\` failed (${code})${detail ? `: ${detail}` : ""}. Finish by hand:\n${sudoHint(commands.slice(index))}`,
      );
    }
  }
}

// ── The package and the checkout ───────────────────────────────────────

async function uninstallPackage(
  ctx: UninstallContext,
  action: Extract<Action, { type: "npm-uninstall" }>,
): Promise<string | undefined> {
  if (!existsSync(action.packageDir)) return "already gone";
  const args = ["uninstall", "-g", "omnesis", "--prefix", action.prefix];
  const res = await ctx.run("npm", args, { env: { NPM_CONFIG_PREFIX: action.prefix } });
  if (res.code === 0 && !existsSync(action.packageDir)) return undefined;
  if (res.code !== 127 && /EACCES|EPERM|permission denied/i.test(output(res))) {
    await runPrivileged(ctx, [{ argv: ["npm", ...args] }]);
    return existsSync(action.packageDir)
      ? "npm reported success but the package is still there"
      : undefined;
  }
  if (res.code === 127) {
    // No npm on PATH (a host whose Node install went away): remove what npm
    // would — the package, and the bin link npm made into it.
    const shim = join(action.prefix, "bin", "omnesis");
    let shimIntoPackage = false;
    try {
      shimIntoPackage =
        lstatSync(shim).isSymbolicLink() && isInside(canonical(shim), canonical(action.packageDir));
    } catch {
      // No shim: nothing to remove.
    }
    removePath(ctx, action.packageDir);
    if (shimIntoPackage) rmSync(shim, { force: true });
    return "npm was not found, so the package's files were removed directly";
  }
  throw new StepFailure(`npm uninstall failed (${res.code}): ${output(res) || "no output"}`);
}

function removeCheckout(ctx: UninstallContext, root: string, configDir: string): void {
  if (!existsSync(root)) return;
  const target = canonical(root);
  if (existsSync(configDir) && isInside(canonical(configDir), target)) {
    throw new StepFailure(
      `Refusing to delete ${root}: it contains the config directory ${configDir}.`,
    );
  }
  if (!existsSync(join(target, ".git")) || !existsSync(join(target, "packages", "cli"))) {
    throw new StepFailure(`Refusing to delete ${root}: it is no longer an Omnesis checkout.`);
  }
  // This process may be running from the checkout; leave it before deleting it.
  if (isInside(canonical(process.cwd()), target)) process.chdir(ctx.home);
  removePath(ctx, target);
}

// ── Data ───────────────────────────────────────────────────────────────

/** Why `dir` must not be purged now, or null when it may. Checked before any key is touched. */
function purgeRefusal(ctx: UninstallContext, dir: string): string | null {
  if (!existsSync(dir)) return null;
  // The update lock this run holds is not the operator's content.
  const entries = readdirSync(dir).filter((name) => name !== UPDATE_LOCK_DIR);
  if (entries.length > 0 && !CONFIG_DIR_EVIDENCE.some((name) => existsSync(join(dir, name)))) {
    return `Refusing to delete ${dir}: it holds none of the files an Omnesis config directory has (${entries.slice(0, 5).join(", ")}).`;
  }
  const target = canonical(dir);
  if (target === resolve("/") || isInside(canonical(ctx.home), target)) {
    return `Refusing to delete ${dir}: it contains your home directory.`;
  }
  const holder = ctx.gatewayHolder(dir);
  if (holder) {
    return `A gateway (pid ${holder.pid}) still runs against ${dir}; stop it, then re-run with --purge.`;
  }
  return null;
}

function purgeConfigDir(ctx: UninstallContext, dir: string): string | undefined {
  if (!existsSync(dir)) return "already gone";
  const refusal = purgeRefusal(ctx, dir);
  if (refusal) throw new StepFailure(refusal);
  removePath(ctx, dir);
  return undefined;
}

async function purgeKeyring(
  ctx: UninstallContext,
  action: Extract<Action, { type: "keyring" }>,
): Promise<string | undefined> {
  // The keys go only with data that can go: a directory a purge would refuse
  // keeps the keys that open it.
  const refusals = action.configDirs.flatMap((dir) => purgeRefusal(ctx, dir) ?? []);
  if (refusals.length > 0) throw new StepFailure(`${refusals.join(" ")} The keys were kept.`);
  const notes: string[] = [];
  for (const dir of action.configDirs) {
    for (const kind of SECURE_MARKER_KINDS) {
      try {
        await clearMarkerKeyringState(kind, ctx.secretStoreOptions(dir));
      } catch (err) {
        notes.push(`could not clear the ${kind} entry for ${dir}: ${errorText(err)}`);
      }
    }
  }
  if (action.rootKey) {
    try {
      const store = createSecretStore(
        ctx.secretStoreOptions(action.configDirs[0] ?? join(ctx.home, ".config", "omnesis")),
      );
      if ((await store.status()).available) await store.delete(OMNESIS_INSTALL_ROOT_KEY);
    } catch (err) {
      notes.push(`could not delete the install root key: ${errorText(err)}`);
    }
    // Entries an earlier install, or one with another config directory, left
    // under the same service name: the docs' manual sweep, done here.
    if (ctx.platform === "darwin") {
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const res = await ctx.run(
          "security",
          ["delete-generic-password", "-s", OMNESIS_SECRET_SERVICE],
          { timeoutMs: 15_000 },
        );
        if (res.code === 0) continue;
        // 44: nothing (left) under the service name — the sweep is done.
        if (res.code !== 44 && res.code !== 127) {
          notes.push(
            `the login keychain refused the deletion (${output(res) || `exit ${res.code}`}); unlock it (security unlock-keychain) and re-run`,
          );
        }
        break;
      }
      const left = await ctx.run(
        "security",
        ["find-generic-password", "-s", OMNESIS_SECRET_SERVICE],
        {
          timeoutMs: 15_000,
        },
      );
      if (left.code === 0 && notes.length === 0) {
        notes.push("the login keychain still holds dev.omnesis entries; unlock it and re-run");
      }
    } else if (ctx.platform === "linux") {
      const cleared = await ctx.run("secret-tool", ["clear", "service", OMNESIS_SECRET_SERVICE], {
        timeoutMs: 15_000,
      });
      if (cleared.code !== 127) {
        const left = await ctx.run(
          "secret-tool",
          ["lookup", "service", OMNESIS_SECRET_SERVICE, "account", OMNESIS_INSTALL_ROOT_KEY],
          { timeoutMs: 15_000 },
        );
        if (left.code === 0 && left.stdout.trim() !== "") {
          notes.push(
            "the Secret Service still holds the install root key; unlock the keyring and re-run",
          );
        }
      }
    }
  }
  if (notes.length > 0) throw new StepFailure(notes.join("; "));
  return undefined;
}

// ── Dispatch ───────────────────────────────────────────────────────────

async function perform(ctx: UninstallContext, action: Action): Promise<string | undefined> {
  switch (action.type) {
    case "harness-unregister":
      await unregisterOpenClawPlugin(ctx, action.binary, action.env);
      return undefined;
    case "edit":
      switch (action.edit) {
        case "openclaw-config":
          return editFile(action.path, stripOpenClawConfig);
        case "hermes-config":
          return editFile(action.path, stripHermesConfig);
        case "harness-env":
          return editFile(action.path, stripHarnessEnv);
        case "profile":
          return editFile(
            action.path,
            (text) => removeInstallerPathLines(text, action.binDir!).text,
          );
      }
      return undefined;
    case "remove":
      if (!existsSync(action.path)) return "already gone";
      removePath(ctx, action.path);
      return undefined;
    case "exec": {
      if (action.cwd && !existsSync(action.cwd)) {
        throw new StepFailure(`${action.cwd}, where this entry belongs, no longer exists.`);
      }
      const res = await ctx.run(action.command, action.args, action.cwd ? { cwd: action.cwd } : {});
      if (res.code === 0) return undefined;
      if (action.bestEffort) return `skipped: ${output(res).split("\n")[0] || `exit ${res.code}`}`;
      if (action.absent?.test(output(res))) return "already gone";
      if (res.code === 127) throw new StepFailure(`${action.command} was not found.`);
      throw new StepFailure(
        `\`${action.command} ${action.args.join(" ")}\` failed (${res.code}): ${output(res) || "no output"}`,
      );
    }
    case "service":
      return removeService(ctx, action);
    case "legacy-runner":
      await uninstallLegacyRunnerService({
        platform: ctx.platform,
        home: ctx.home,
        uid: ctx.uid,
        exec: (cmd, args) => ctx.run(cmd, args),
        ...(action.instance ? { instance: action.instance } : {}),
      });
      return undefined;
    case "privileged":
      await runPrivileged(ctx, action.commands);
      return undefined;
    case "docker-down": {
      if (!existsSync(action.composeFile)) return "already gone";
      const res = await ctx.run(
        "docker",
        [
          "compose",
          "-f",
          action.composeFile,
          "--profile",
          "update",
          "down",
          "--rmi",
          "all",
          "--remove-orphans",
        ],
        { timeoutMs: 600_000 },
      );
      if (res.code !== 0) {
        throw new StepFailure(
          `docker compose down failed (${res.code}): ${output(res) || "no output"}`,
        );
      }
      return undefined;
    }
    case "npm-uninstall":
      return uninstallPackage(ctx, action);
    case "remove-checkout":
      removeCheckout(ctx, action.root, action.configDir);
      return undefined;
    case "purge-config":
      return purgeConfigDir(ctx, action.dir);
    case "keyring":
      return purgeKeyring(ctx, action);
  }
}

export async function executeStep(ctx: UninstallContext, step: Step): Promise<StepResult> {
  try {
    const detail = await perform(ctx, step.action);
    return { step, status: "done", ...(detail ? { detail } : {}) };
  } catch (err) {
    const status = err instanceof StepFailure ? err.status : "failed";
    return { step, status, detail: errorText(err) };
  }
}

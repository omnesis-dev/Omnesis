// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Find everything of Omnesis on this machine from what is on disk, not from
 * how this CLI happens to be running: the uninstaller may be the installed CLI,
 * a checkout's own entry, or `npx omnesis` on a host whose install no longer
 * starts. Nothing here changes anything.
 */

import { existsSync, globSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  HARDENED_ADMIN_PATH,
  HARDENED_UNIT_PATH,
  SERVICE_COMPONENTS,
  launchdLabelInstance,
  systemdUnitInstance,
} from "@omnesis/core";
import { detectDockerInstall } from "@omnesis/core/release-check";
import {
  harnessHome,
  harnessInvocation,
  openClawConfigPath,
  skillFilePath,
} from "../commands/connect.js";
import { HARNESSES, type Harness } from "../harness-skills.js";
import { serviceConfigDir } from "../service/rebind.js";
import { parseSourceApplyState, UPDATE_STATE_FILE } from "../update/detect.js";
import {
  harnessEnvHasOmnesisKeys,
  INTEGRATION_PLUGIN_ID,
  LEGACY_PLUGIN_ID,
  stripHermesConfig,
  stripOpenClawConfig,
} from "./harness-config.js";
import { readLauncher } from "./launcher.js";
import { profileCandidates, removeInstallerPathLines } from "./profile.js";
import type { UninstallContext } from "./context.js";
import type {
  ClientEntry,
  FoundCheckout,
  FoundClient,
  FoundHardened,
  FoundHarness,
  FoundPackage,
  FoundProfile,
  FoundUnit,
  Inventory,
} from "./types.js";

/** The receipt `scripts/hardened-gateway.sh` writes for the gateway it installed. */
export const HARDENED_RECEIPT_PATH = "/etc/omnesis-gateway/install.env";

/** The npm package name of the CLI, whose global install is the package method. */
const CLI_PACKAGE = "omnesis";

/** The repository the Omnesis plugin marketplaces are published from. */
const OMNESIS_REPOSITORY = "omnesis-dev/Omnesis";

export interface DiscoverOptions {
  /** OMNESIS_CONFIG_DIR as the operator set it, if they did. */
  configDir?: string;
  instance?: string;
  /** A harness home given on the command line instead of the harness's own default. */
  harnessDirs?: Partial<Record<Harness, string>>;
  /** Ask Claude Code and Codex what they hold (runs their CLIs). */
  probeClients?: boolean;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Service units ──────────────────────────────────────────────────────

function unitConfigDir(platform: NodeJS.Platform, content: string): string | null {
  try {
    return serviceConfigDir(platform, content);
  } catch {
    return null;
  }
}

function foundUnit(
  platform: NodeJS.Platform,
  component: FoundUnit["component"],
  match: { instance?: string },
  unitName: string,
  unitPath: string,
): FoundUnit {
  const definition = readText(unitPath) ?? "";
  const dropIns = `${unitPath}.d`;
  return {
    component,
    ...match,
    unitName,
    unitPath,
    configDir: unitConfigDir(platform, definition),
    definition,
    ...(platform === "linux" && existsSync(dropIns) ? { dropIns } : {}),
  };
}

/** Every Omnesis unit this account has registered, whichever instance. */
export function findUnits(platform: NodeJS.Platform, home: string): FoundUnit[] {
  const units: FoundUnit[] = [];
  if (platform === "linux") {
    const dir = join(home, ".config", "systemd", "user");
    for (const name of listDir(dir).sort()) {
      for (const component of SERVICE_COMPONENTS) {
        const match = systemdUnitInstance(component, name);
        if (!match) continue;
        units.push(foundUnit(platform, component, match, name, join(dir, name)));
      }
    }
  } else if (platform === "darwin") {
    const dir = join(home, "Library", "LaunchAgents");
    for (const name of listDir(dir).sort()) {
      if (!name.endsWith(".plist")) continue;
      const label = name.slice(0, -".plist".length);
      for (const component of SERVICE_COMPONENTS) {
        const match = launchdLabelInstance(component, label);
        if (!match) continue;
        units.push(foundUnit(platform, component, match, label, join(dir, name)));
      }
    }
  }
  return units;
}

function legacyRunnerInstalled(
  platform: NodeJS.Platform,
  home: string,
  instance?: string,
): boolean {
  if (platform === "linux") {
    const unit = instance ? `omnesis-runner-${instance}.service` : "omnesis-runner.service";
    return existsSync(join(home, ".config", "systemd", "user", unit));
  }
  if (platform === "darwin") {
    const label = instance ? `dev.omnesis.runner.${instance}` : "dev.omnesis.runner";
    return existsSync(join(home, "Library", "LaunchAgents", `${label}.plist`));
  }
  return false;
}

function findHardened(platform: NodeJS.Platform, systemRoot: string): FoundHardened | null {
  if (platform !== "linux") return null;
  const found = {
    unitInstalled: existsSync(systemRoot + HARDENED_UNIT_PATH),
    adminInstalled: lexists(systemRoot + HARDENED_ADMIN_PATH),
    receipt: existsSync(systemRoot + HARDENED_RECEIPT_PATH),
  };
  return found.unitInstalled || found.adminInstalled || found.receipt ? found : null;
}

// ── The CLI's own install ──────────────────────────────────────────────

async function inspectCheckout(ctx: UninstallContext, root: string): Promise<FoundCheckout | null> {
  if (!existsSync(join(root, "packages", "cli", "package.json"))) return null;
  const managed = await ctx.run("git", [
    "-C",
    root,
    "config",
    "--local",
    "--no-includes",
    "--get",
    "omnesis.install",
  ]);
  const status = await ctx.run("git", ["-C", root, "status", "--porcelain"]);
  let worktree = false;
  try {
    worktree = lstatSync(join(root, ".git")).isFile();
  } catch {
    // No .git at all: not a checkout git can vouch for, so not managed either.
  }
  return {
    root,
    managed: managed.code === 0 && managed.stdout.trim() === "managed",
    // A status that cannot be read is treated as holding changes: nothing is lost by keeping it.
    dirty: status.code !== 0 || status.stdout.trim() !== "",
    worktree,
  };
}

function recordedSourceRoot(configDir: string): string | null {
  const state = parseSourceApplyState(readText(join(configDir, UPDATE_STATE_FILE)));
  return state?.rootDir ?? null;
}

async function findPackages(
  ctx: UninstallContext,
  launcherPrefix: string | null,
): Promise<FoundPackage[]> {
  const prefixes = new Set<string>();
  if (launcherPrefix) prefixes.add(launcherPrefix);
  if (ctx.env.NPM_CONFIG_PREFIX) prefixes.add(ctx.env.NPM_CONFIG_PREFIX);
  prefixes.add(join(ctx.home, ".npm-global"));
  const global = await ctx.run("npm", ["prefix", "-g"], { timeoutMs: 30_000 });
  if (global.code === 0 && global.stdout.trim()) prefixes.add(global.stdout.trim());

  const found = new Map<string, FoundPackage>();
  for (const prefix of prefixes) {
    const packageDir = join(prefix, "lib", "node_modules", CLI_PACKAGE);
    const manifest = parseJson(readText(join(packageDir, "package.json")) ?? "");
    if (!isRecord(manifest) || manifest.name !== CLI_PACKAGE) continue;
    const key = canonical(packageDir);
    if (!found.has(key)) found.set(key, { prefix, packageDir });
  }
  return [...found.values()];
}

// ── Agent harnesses ────────────────────────────────────────────────────

function findHarness(harness: Harness, override: string | undefined): FoundHarness | null {
  const home = harnessHome(harness, override);
  if (!existsSync(home)) return null;
  const artifacts: string[] = [];
  const integrationDir = join(home, "omnesis");
  if (existsSync(integrationDir)) artifacts.push(integrationDir);
  const skillDir = dirname(skillFilePath(harness, home));
  if (existsSync(skillDir)) artifacts.push(skillDir);
  const envPath = join(home, ".env");
  const envText = readText(envPath);
  if (envText !== null && harnessEnvHasOmnesisKeys(envText)) artifacts.push(envPath);

  let configPath: string | null = null;
  if (harness === "openclaw") {
    configPath = openClawConfigPath(home);
    const text = readText(configPath);
    try {
      if (text !== null && stripOpenClawConfig(text) !== text) artifacts.push(configPath);
    } catch {
      artifacts.push(configPath);
    }
    if (existsSync(`${configPath}.bak-omnesis`)) artifacts.push(`${configPath}.bak-omnesis`);
    // OpenClaw's own install of the plugin package.
    for (const entry of globSync("npm/projects/*/node_modules/@omnesis/agent-integration", {
      cwd: home,
    })) {
      artifacts.push(join(home, entry));
    }
  } else {
    for (const id of [INTEGRATION_PLUGIN_ID, LEGACY_PLUGIN_ID]) {
      const plugin = join(home, "plugins", id);
      if (existsSync(plugin)) artifacts.push(plugin);
    }
    const hermesConfig = join(home, "config.yaml");
    const text = readText(hermesConfig);
    try {
      if (text !== null && stripHermesConfig(text) !== text) artifacts.push(hermesConfig);
    } catch {
      artifacts.push(hermesConfig);
    }
  }
  if (artifacts.length === 0) return null;

  const identity = parseJson(readText(join(integrationDir, "integration-identity.json")) ?? "");
  const deviceName =
    isRecord(identity) && typeof identity.suggestedName === "string"
      ? identity.suggestedName
      : null;
  const invocation = harnessInvocation(
    harness,
    home,
    configPath ? { openClawConfigPath: configPath } : {},
  );
  return {
    harness,
    home,
    configPath,
    binary: invocation.binary,
    env: invocation.env ?? {},
    artifacts,
    deviceName,
  };
}

// ── Claude Code and Codex ──────────────────────────────────────────────

async function listJson(
  ctx: UninstallContext,
  command: string,
  args: string[],
  warnings: string[],
): Promise<unknown> {
  const res = await ctx.run(command, args, { timeoutMs: 60_000 });
  if (res.code === 127) return undefined;
  const parsed = res.code === 0 ? parseJson(res.stdout) : undefined;
  if (parsed === undefined) {
    warnings.push(`Could not read \`${command} ${args.join(" ")}\`; nothing of it was changed.`);
  }
  return parsed;
}

async function findClaudeCode(
  ctx: UninstallContext,
  warnings: string[],
): Promise<FoundClient | null> {
  const version = await ctx.run("claude", ["--version"], { timeoutMs: 30_000 });
  if (version.code === 127) return null;
  const entries: ClientEntry[] = [];
  const plugins = await listJson(ctx, "claude", ["plugin", "list", "--json"], warnings);
  if (Array.isArray(plugins)) {
    for (const plugin of plugins) {
      if (!isRecord(plugin) || plugin.id !== "omnesis@omnesis") continue;
      const scope = typeof plugin.scope === "string" ? plugin.scope : "user";
      entries.push({
        kind: "plugin",
        name: "omnesis@omnesis",
        scope,
        ...(scope !== "user" && typeof plugin.projectPath === "string"
          ? { cwd: plugin.projectPath }
          : {}),
      });
    }
  }
  const marketplaces = await listJson(
    ctx,
    "claude",
    ["plugin", "marketplace", "list", "--json"],
    warnings,
  );
  if (Array.isArray(marketplaces)) {
    for (const market of marketplaces) {
      if (!isRecord(market) || market.name !== "omnesis") continue;
      if (JSON.stringify(market).includes(OMNESIS_REPOSITORY)) {
        entries.push({ kind: "marketplace", name: "omnesis" });
      }
    }
  }
  // `claude mcp list` health-checks every server; the settings file answers instantly.
  const configHome = ctx.env.CLAUDE_CONFIG_DIR ?? ctx.home;
  const settings = parseJson(readText(join(configHome, ".claude.json")) ?? "");
  if (isRecord(settings)) {
    if (isRecord(settings.mcpServers) && Object.hasOwn(settings.mcpServers, "omnesis")) {
      entries.push({ kind: "mcp", name: "omnesis", scope: "user" });
    }
    if (isRecord(settings.projects)) {
      for (const [project, config] of Object.entries(settings.projects)) {
        if (
          isRecord(config) &&
          isRecord(config.mcpServers) &&
          Object.hasOwn(config.mcpServers, "omnesis")
        ) {
          // Claude Code can only remove a local-scope server from inside its
          // project; one recorded for a directory that is gone is left alone.
          if (existsSync(project)) {
            entries.push({ kind: "mcp", name: "omnesis", scope: "local", cwd: project });
          } else {
            warnings.push(
              `Claude Code lists an omnesis MCP server for ${project}, which no longer exists; it was left in ${join(configHome, ".claude.json")}.`,
            );
          }
        }
      }
    }
  }
  return { binary: "claude", entries };
}

/** Marketplace names Omnesis has published its Codex plugin under. */
const CODEX_MARKETPLACES: ReadonlySet<string> = new Set(["omnesis", "omnesis-openai"]);

async function findCodex(ctx: UninstallContext, warnings: string[]): Promise<FoundClient | null> {
  const version = await ctx.run("codex", ["--version"], { timeoutMs: 30_000 });
  if (version.code === 127) return null;
  const entries: ClientEntry[] = [];
  const servers = await listJson(ctx, "codex", ["mcp", "list", "--json"], warnings);
  if (Array.isArray(servers) && servers.some((s) => isRecord(s) && s.name === "omnesis")) {
    entries.push({ kind: "mcp", name: "omnesis" });
  }
  const plugins = await listJson(ctx, "codex", ["plugin", "list", "--json"], warnings);
  if (isRecord(plugins) && Array.isArray(plugins.installed)) {
    for (const plugin of plugins.installed) {
      if (
        isRecord(plugin) &&
        plugin.name === "omnesis" &&
        typeof plugin.marketplaceName === "string" &&
        CODEX_MARKETPLACES.has(plugin.marketplaceName)
      ) {
        entries.push({ kind: "plugin", name: `omnesis@${plugin.marketplaceName}` });
      }
    }
  }
  const markets = await listJson(
    ctx,
    "codex",
    ["plugin", "marketplace", "list", "--json"],
    warnings,
  );
  if (isRecord(markets) && Array.isArray(markets.marketplaces)) {
    for (const market of markets.marketplaces) {
      if (
        isRecord(market) &&
        typeof market.name === "string" &&
        CODEX_MARKETPLACES.has(market.name) &&
        JSON.stringify(market).includes(OMNESIS_REPOSITORY)
      ) {
        entries.push({ kind: "marketplace", name: market.name });
      }
    }
  }
  return { binary: "codex", entries };
}

// ── Everything ─────────────────────────────────────────────────────────

export async function discoverInventory(
  ctx: UninstallContext,
  opts: DiscoverOptions = {},
): Promise<Inventory> {
  const warnings: string[] = [];
  const { platform, home } = ctx;
  const binDir = join(home, ".local", "bin");
  const launcher = readLauncher(join(binDir, "omnesis"));
  const units = findUnits(platform, home);
  const instanceUnits = units.filter((unit) => unit.instance === opts.instance);

  // A named instance's data is wherever its units say, or where the operator
  // points: never the default directory by elimination, which belongs to
  // another install.
  const instanceConfigDir = instanceUnits.find((unit) => unit.configDir)?.configDir ?? null;
  const knownConfigDir =
    opts.configDir ??
    instanceConfigDir ??
    (opts.instance ? null : launcher.kind === "source" ? launcher.configDir : null);
  const configDir = resolve(knownConfigDir ?? join(home, ".config", "omnesis"));
  if (opts.instance && !knownConfigDir) {
    warnings.push(
      `No unit of instance ${opts.instance} names a config directory; set OMNESIS_CONFIG_DIR to the instance's directory to remove its data.`,
    );
  }
  if (opts.configDir) {
    for (const unit of instanceUnits) {
      if (unit.configDir && resolve(unit.configDir) !== resolve(opts.configDir)) {
        warnings.push(
          `${unit.unitName} runs against ${unit.configDir}, not OMNESIS_CONFIG_DIR (${opts.configDir}).`,
        );
      }
    }
  }

  const detected = detectDockerInstall(configDir);
  const docker =
    detected?.method === "docker"
      ? { composeFile: detected.composeFile, projectDir: detected.projectDir }
      : launcher.kind === "docker"
        ? { composeFile: launcher.composeFile, projectDir: dirname(launcher.composeFile) }
        : null;

  const sourceRoot =
    launcher.kind === "source" ? launcher.sourceRoot : recordedSourceRoot(configDir);
  const checkout = sourceRoot ? await inspectCheckout(ctx, sourceRoot) : null;
  const packages = await findPackages(ctx, launcher.kind === "package" ? launcher.prefix : null);
  const libDir = join(home, ".local", "lib", "omnesis");

  const harnesses: FoundHarness[] = [];
  for (const harness of HARNESSES) {
    try {
      const found = findHarness(harness, opts.harnessDirs?.[harness]);
      if (found) harnesses.push(found);
    } catch (err) {
      warnings.push(
        `Could not locate the ${harness} home: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const clients: Inventory["clients"] = {};
  if (opts.probeClients !== false && !ctx.inContainer) {
    const claude = await findClaudeCode(ctx, warnings);
    if (claude && claude.entries.length > 0) clients["claude-code"] = claude;
    const codex = await findCodex(ctx, warnings);
    if (codex && codex.entries.length > 0) clients.codex = codex;
  }

  const profiles: FoundProfile[] = [];
  for (const path of profileCandidates(home)) {
    const text = readText(path);
    if (text === null) continue;
    const { removed } = removeInstallerPathLines(text, binDir);
    if (removed > 0) profiles.push({ path, blocks: removed });
  }

  const configDirs = [
    ...new Set([
      ...(opts.instance && !knownConfigDir ? [] : [configDir]),
      ...instanceUnits.flatMap((u) => (u.configDir ? [resolve(u.configDir)] : [])),
    ]),
  ].filter((dir) => existsSync(dir));

  // Other config directories this account's keyring entries may belong to:
  // the account-wide root key stays while any of them does.
  const configParent = join(home, ".config");
  const otherConfigDirs = [
    ...new Set([
      ...listDir(configParent)
        .filter((name) => name.startsWith("omnesis"))
        .map((name) => join(configParent, name))
        .filter((dir) =>
          ["omnesis.json", "omnesis.db", "keyring"].some((f) => existsSync(join(dir, f))),
        ),
      ...units.flatMap((u) =>
        u.configDir && u.instance !== opts.instance ? [resolve(u.configDir)] : [],
      ),
    ]),
  ].filter((dir) => !configDirs.includes(resolve(dir)) && existsSync(dir));

  const logDirs = (
    platform === "darwin"
      ? [join(home, "Library", "Logs", "Omnesis")]
      : [join(home, ".local", "state", "omnesis")]
  ).filter((dir) => existsSync(dir));

  const binEntries = listDir(binDir).filter((name) => name !== "omnesis");
  const binDirLeftovers = binEntries
    .filter((name) => /^(?:\.omnesis-|omnesis\.omnesis-migration-)/u.test(name))
    .map((name) => join(binDir, name));
  const binDirOthers = binEntries.filter((name) => !binDirLeftovers.includes(join(binDir, name)));

  return {
    platform,
    home,
    configDir,
    ...(opts.instance ? { instance: opts.instance } : {}),
    binDir,
    binDirOthers,
    binDirLeftovers,
    launcher,
    checkout,
    packages,
    libDir: existsSync(libDir) ? libDir : null,
    units,
    legacyRunner: legacyRunnerInstalled(platform, home, opts.instance),
    hardened: findHardened(platform, ctx.systemRoot),
    docker,
    inContainer: ctx.inContainer,
    harnesses,
    clients,
    profiles,
    configDirs,
    otherConfigDirs,
    logDirs,
    mkcert: existsSync(join(configDir, "tls", "mkcert.crt")),
    warnings,
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import { isScalar, isSeq, parse as parseYaml, parseDocument } from "yaml";
import {
  assertNever,
  applyCaTrustInProcess,
  atomicWriteFileSync,
  DEFAULT_CONFIG_DIR,
  ensureGatewayTrust,
  fetchPeerCert,
  normalizeCertFingerprint,
} from "@omnesis/core";
import {
  IntegrationHttpError,
  loadIntegrationCredentials,
  PinnedGatewayHttpClient,
  upgradeLegacyIntegrationCredentials,
  writeIntegrationCredentials,
  type GatewayCapabilities,
  type IntegrationCredentials,
  type TlsTrust,
} from "@omnesis/agent-integration";
import { c, CliError, EXIT_USER_ERROR } from "../utils.js";
import {
  buildHarnessSkill,
  HARNESSES,
  SKILL_NAME,
  type Harness,
  type HarnessSkillCapabilities,
} from "../harness-skills.js";
import {
  installedSubscriptionsCapability,
  persistGatewayCapabilities,
  persistGatewayTrust,
  readIntegrationCapabilities,
  warnOnVersionDrift,
} from "../connect-gateway-facts.js";
import { authorizeHarness } from "./connect-oauth.js";
import { redeemAgentIntegrationPairingCode } from "./devices.js";

/** `~/`-expansion for user-supplied paths (flags are never shell-expanded). */
function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function trimmedEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizedHomeEnvPath(value: string | undefined): string | undefined {
  const normalized = trimmedEnvValue(value);
  return normalized !== "undefined" && normalized !== "null" ? normalized : undefined;
}

function openClawOsHome(): string {
  const configured =
    normalizedHomeEnvPath(process.env.HOME) ?? normalizedHomeEnvPath(process.env.USERPROFILE);
  if (configured) return resolve(configured);
  const prefix = normalizedHomeEnvPath(process.env.PREFIX);
  if (
    prefix &&
    normalizedHomeEnvPath(process.env.ANDROID_DATA) &&
    /(?:^|\/)com\.termux\/files\/usr\/?$/u.test(prefix.replaceAll("\\", "/"))
  ) {
    return resolve(prefix, "..", "home");
  }
  return resolve(homedir());
}

/** Mirror OpenClaw's OPENCLAW_HOME-aware user-path semantics. */
function openClawEffectiveHome(): string {
  const configured = normalizedHomeEnvPath(process.env.OPENCLAW_HOME);
  if (!configured) return openClawOsHome();
  const expanded =
    configured === "~" || configured.startsWith("~/") || configured.startsWith("~\\")
      ? configured.replace(/^~(?=$|[\\/])/, openClawOsHome())
      : configured;
  return resolve(expanded);
}

function resolveOpenClawUserPath(path: string): string {
  const trimmed = path.trim();
  const expanded = trimmed.startsWith("~")
    ? trimmed.replace(/^~(?=$|[\\/])/, openClawEffectiveHome())
    : trimmed;
  return resolve(expanded);
}

export function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}

/** The harness's state/home directory, honoring its own env override. */
export function harnessHome(harness: Harness, override?: string): string {
  if (override) return expandHome(override);
  switch (harness) {
    case "openclaw": {
      const stateOverride = trimmedEnvValue(process.env.OPENCLAW_STATE_DIR);
      if (stateOverride) return resolveOpenClawUserPath(stateOverride);
      const profile = trimmedEnvValue(process.env.OPENCLAW_PROFILE);
      if (profile && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile)) {
        throw new CliError(
          `${c.red}Invalid OPENCLAW_PROFILE — use only letters, numbers, "_" and "-".${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      const suffix = profile && profile.toLowerCase() !== "default" ? `-${profile}` : "";
      const preferred = join(openClawEffectiveHome(), `.openclaw${suffix}`);
      if (suffix || existsSync(preferred)) return preferred;
      const legacy = join(openClawEffectiveHome(), ".clawdbot");
      return existsSync(legacy) ? legacy : preferred;
    }
    case "hermes":
      return process.env.HERMES_HOME ?? join(homedir(), ".hermes");
    default:
      return assertNever(harness);
  }
}

/** Resolve the one config file both Omnesis and the OpenClaw installer mutate. */
export function openClawConfigPath(home: string): string {
  const override = trimmedEnvValue(process.env.OPENCLAW_CONFIG_PATH);
  if (override) return resolveOpenClawUserPath(override);
  return (
    [join(home, "openclaw.json"), join(home, "clawdbot.json")].find(existsSync) ??
    join(home, "openclaw.json")
  );
}

function openClawInstallerEnvironment(home: string, configPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: home,
    OPENCLAW_CONFIG_PATH: configPath,
  };
}

/**
 * Where the skill file lands. OpenClaw discovers `<state>/skills/<name>/`
 * (its managed root); Hermes discovers `~/.hermes/skills/<category>/<name>/`.
 */
export function skillFilePath(harness: Harness, home: string): string {
  switch (harness) {
    case "openclaw":
      return join(home, "skills", SKILL_NAME, "SKILL.md");
    case "hermes":
      return join(home, "skills", "productivity", SKILL_NAME, "SKILL.md");
    default:
      return assertNever(harness);
  }
}

/**
 * Upsert `KEY=value` lines in a dotenv-style file body: existing assignments
 * for the given keys are replaced in place, missing ones are appended, and
 * every other line is preserved byte-for-byte.
 */
export function upsertEnvLines(
  existing: string,
  vars: Record<string, string>,
  remove: readonly string[] = [],
): string {
  const desired = new Map(Object.entries(vars));
  const removed = new Set(remove);
  const written = new Set<string>();
  const lines = existing.length > 0 ? existing.split("\n") : [];
  // Drop a single trailing empty segment so we can re-append a clean newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out = lines.flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) return [line];
    const key = match[1];
    if (removed.has(key)) return [];
    const value = desired.get(key);
    if (value === undefined) return [line];
    if (written.has(key)) return [];
    written.add(key);
    return [`${key}=${encodeDotenvValue(value)}`];
  });
  for (const [key, value] of desired) {
    if (!written.has(key)) out.push(`${key}=${encodeDotenvValue(value)}`);
  }
  return out.join("\n") + "\n";
}

/**
 * Serialize a dotenv value without allowing whitespace, comments, variable
 * expansion, or quotes in an opaque chat identifier to change its meaning.
 * Simple tokens stay unquoted for readable diffs; everything else uses the
 * single-quoted form understood by both OpenClaw and python-dotenv.
 */
export function encodeDotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,-]*$/.test(value)) return value;
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openClawConfigError(detail: string): CliError {
  return new CliError(
    `${c.red}Could not update openclaw.json: ${detail}. Add this yourself under ` +
      `skills.entries:\n  "${SKILL_NAME}": { "env": { ` +
      `"OMNESIS_AGENT_HARNESS": "openclaw" } }${c.reset}`,
    EXIT_USER_ERROR,
  );
}

function parseOpenClawConfig(configText: string): Record<string, unknown> {
  const trimmed = configText.trim();
  if (trimmed === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw openClawConfigError("the file is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw openClawConfigError("the root must be a JSON object");
  }
  return parsed;
}

function objectChild(
  parent: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const existing = parent[key];
  if (existing === undefined) {
    const child: Record<string, unknown> = {};
    parent[key] = child;
    return child;
  }
  if (!isPlainObject(existing)) throw openClawConfigError(`${path} must be a JSON object`);
  return existing;
}

function isKnownLegacyOpenClawOmnesisPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name === "openclaw-omnesis-plugin" || name === "omnesis-bridge";
}

export function retireLegacyOpenClawConfig(configText: string): string {
  const config = parseOpenClawConfig(configText);
  const plugins = config.plugins;
  if (!isPlainObject(plugins)) return configText;
  let changed = false;
  const entries = plugins.entries;
  if (isPlainObject(entries) && Object.hasOwn(entries, "omnesis-bridge")) {
    delete entries["omnesis-bridge"];
    changed = true;
  }
  const load = plugins.load;
  if (isPlainObject(load) && Array.isArray(load.paths)) {
    const filtered = load.paths.filter(
      (path) => typeof path !== "string" || !isKnownLegacyOpenClawOmnesisPath(path),
    );
    if (filtered.length !== load.paths.length) {
      load.paths = filtered;
      changed = true;
    }
  }
  if (Array.isArray(plugins.allow)) {
    const filtered = plugins.allow.filter((id) => id !== "omnesis-bridge");
    if (filtered.length !== plugins.allow.length) {
      plugins.allow = filtered;
      changed = true;
    }
  }
  return changed ? JSON.stringify(config, null, 2) + "\n" : configText;
}

export function assertOpenClawCompletionNotifications(configText: string): void {
  const config = parseOpenClawConfig(configText);
  const tools = config.tools;
  const exec = isPlainObject(tools) ? tools.exec : undefined;
  if (isPlainObject(exec) && exec.notifyOnExit === false) {
    throw new CliError(
      `${c.red}OpenClaw tools.exec.notifyOnExit is disabled. Enable it before connecting ` +
        `so approval completion can wake the agent.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
}

export function dotenvSetting(envText: string, key: string): string | undefined {
  let value: string | undefined;
  for (const line of envText.split("\n")) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match || match[1] !== key) continue;
    const raw = match[2].trim();
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
      value = raw.slice(1, -1).replace(/\\([\\'])/g, "$1");
    } else if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      value = raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
    } else {
      value = (raw.split(/\s+#/, 1)[0] ?? "").trim();
    }
  }
  return value;
}

function hermesConfigNotificationSetting(configText: string): unknown {
  if (configText.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(configText);
  } catch {
    throw new CliError(
      `${c.red}Could not read Hermes config.yaml as YAML.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new CliError(
      `${c.red}Hermes config.yaml must contain a YAML mapping.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const display = parsed.display;
  if (display === undefined) return undefined;
  if (!isPlainObject(display)) {
    throw new CliError(
      `${c.red}Hermes config.yaml display must be a YAML mapping.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return display.background_process_notifications;
}

/**
 * The Hermes notification modes that report every finished background
 * process, successful or not. "concise" is Hermes's default since v0.21 (its
 * installer writes it, and its config migration moves "all" to it): a
 * one-line status instead of the output tail, delivered on the same
 * completions as "all" and "result". "error" stays silent on success and
 * "off" says nothing, so neither is accepted.
 */
const HERMES_COMPLETION_NOTIFICATION_MODES = ["concise", "all", "result"];

function hermesNotificationRefusal(): CliError {
  return new CliError(
    `${c.red}Hermes background process notifications must be "concise", "all" or "result" ` +
      `so a successful approval can wake the agent. Set display.background_process_notifications ` +
      `or HERMES_BACKGROUND_NOTIFICATIONS accordingly before connecting.${c.reset}`,
    EXIT_USER_ERROR,
  );
}

export function assertHermesCompletionNotifications(
  configText: string,
  envText = "",
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): void {
  const runtimeOverride = runtimeEnv.HERMES_BACKGROUND_NOTIFICATIONS?.trim();
  const fileOverride = dotenvSetting(envText, "HERMES_BACKGROUND_NOTIFICATIONS")?.trim();
  const configSetting = hermesConfigNotificationSetting(configText);
  for (const override of [runtimeOverride, fileOverride]) {
    if (override && !HERMES_COMPLETION_NOTIFICATION_MODES.includes(override.toLowerCase())) {
      throw hermesNotificationRefusal();
    }
  }
  const envOverride = runtimeOverride || fileOverride;
  const configured = envOverride || configSetting;
  const setting =
    configured === false
      ? "off"
      : String(configured ?? "concise")
          .trim()
          .toLowerCase();
  if (!HERMES_COMPLETION_NOTIFICATION_MODES.includes(setting)) {
    throw hermesNotificationRefusal();
  }
}

export function retireLegacyHermesConfig(configText: string): string {
  if (configText.trim() === "") return configText;
  const document = parseDocument(configText);
  if (document.errors.length > 0) {
    throw new CliError(
      `${c.red}Could not read Hermes config.yaml as YAML.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const enabled = document.getIn(["plugins", "enabled"], true);
  if (!isSeq(enabled)) return configText;
  const before = enabled.items.length;
  enabled.items = enabled.items.filter(
    (item) => !(isScalar(item) && item.value === "omnesis-bridge"),
  );
  return enabled.items.length === before ? configText : document.toString();
}

/** Move the retired bridge outside Hermes' plugin discovery tree. */
export function retireLegacyHermesPlugin(home: string): void {
  const legacy = join(home, "plugins", "omnesis-bridge");
  if (!existsSync(legacy)) return;
  const retired = join(home, "omnesis", "retired-plugins", "omnesis-bridge");
  if (existsSync(retired)) {
    throw new CliError(
      `${c.red}Cannot retire the legacy Hermes Omnesis bridge because ${retired} already exists.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  mkdirSync(dirname(retired), { recursive: true });
  renameSync(legacy, retired);
}

/**
 * Merge the omnesis skill's env into an OpenClaw `openclaw.json` config text:
 * sets `skills.entries.omnesis.env`, preserving every other key. The env
 * declaration satisfies the skill's `requires.env` eligibility gate and
 * allowlists the explicit agent/skill authority past OpenClaw's sensitive-env
 * sanitizer. Native delivery and ingestion credentials are omitted from
 * config/env, although current same-user harness shells can still read their
 * state-directory file unless separately sandboxed.
 */
export function mergeOpenClawSkillEnv(configText: string, env: Record<string, string>): string {
  const config = parseOpenClawConfig(retireLegacyOpenClawConfig(configText));
  assertOpenClawCompletionNotifications(configText);
  const skills = objectChild(config, "skills", "skills");
  const entries = objectChild(skills, "entries", "skills.entries");
  const entry = objectChild(entries, SKILL_NAME, `skills.entries.${SKILL_NAME}`);
  const existingEnv = entry.env;
  if (existingEnv !== undefined && !isPlainObject(existingEnv)) {
    throw openClawConfigError(`skills.entries.${SKILL_NAME}.env must be a JSON object`);
  }
  const mergedEnv = { ...(existingEnv ?? {}), ...env };
  delete mergedEnv.OMNESIS_INTEGRATION_CREDENTIALS;
  delete mergedEnv.OMNESIS_GATEWAY_URL;
  delete mergedEnv.OMNESIS_TOKEN;
  entry.env = mergedEnv;
  const plugins = objectChild(config, "plugins", "plugins");
  const pluginEntries = objectChild(plugins, "entries", "plugins.entries");
  const plugin = objectChild(
    pluginEntries,
    "omnesis-integration",
    "plugins.entries.omnesis-integration",
  );
  const pluginConfig = plugin.config;
  if (pluginConfig !== undefined && !isPlainObject(pluginConfig)) {
    throw openClawConfigError("plugins.entries.omnesis-integration.config must be a JSON object");
  }
  if (pluginConfig) {
    delete pluginConfig.credentialsPath;
    if (Object.keys(pluginConfig).length === 0) delete plugin.config;
  }
  plugin.enabled = true;
  return JSON.stringify(config, null, 2) + "\n";
}

export function writePlaintextSecretFile(path: string, content: string): void {
  atomicWriteFileSync(path, content, { ensureDir: true, mode: 0o600 });
}

interface IntegrationIdentity {
  version: 1;
  harness: Harness;
  suggestedName: string;
}

function parseIntegrationIdentity(raw: string, harness: Harness): IntegrationIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      `${c.red}The saved ${harness} Omnesis integration identity is not valid JSON.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (
    !isPlainObject(parsed) ||
    parsed.version !== 1 ||
    parsed.harness !== harness ||
    typeof parsed.suggestedName !== "string" ||
    !new RegExp(`^omnesis-${harness}-[a-f0-9]{12}$`).test(parsed.suggestedName)
  ) {
    throw new CliError(
      `${c.red}The saved ${harness} Omnesis integration identity is malformed.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return parsed as unknown as IntegrationIdentity;
}

/**
 * A stable, non-secret suggested name for fresh unnamed pairings. Repairs are
 * never selected by this caller-controlled value; the administrator must bind
 * the pairing code to an exact existing device when minting it.
 */
export function loadOrCreateIntegrationIdentity(
  home: string,
  harness: Harness,
  persist = true,
): IntegrationIdentity {
  const path = join(home, "omnesis", "integration-identity.json");
  if (existsSync(path)) return parseIntegrationIdentity(readFileSync(path, "utf8"), harness);
  const identity: IntegrationIdentity = {
    version: 1,
    harness,
    suggestedName: `omnesis-${harness}-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  };
  if (persist) {
    atomicWriteFileSync(path, JSON.stringify(identity, null, 2) + "\n", {
      ensureDir: true,
      mode: 0o600,
    });
  }
  return identity;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.split(".", 1)[0] === "127";
}

export function normalizeHarnessGatewayUrl(raw: string): string {
  if (/[\0\r\n]/.test(raw)) {
    throw new CliError("Gateway URL contains invalid control characters.", EXIT_USER_ERROR);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("Gateway URL must be a valid http:// or https:// URL.", EXIT_USER_ERROR);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError("Gateway URL must use https:// (or http:// on loopback).", EXIT_USER_ERROR);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError(
      "Gateway URL must not contain credentials, query parameters, or a fragment.",
      EXIT_USER_ERROR,
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new CliError(
      "Gateway URL must not contain a path; use the gateway origin only.",
      EXIT_USER_ERROR,
    );
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new CliError(
      "Remote Omnesis connections require HTTPS; HTTP is allowed only on loopback.",
      EXIT_USER_ERROR,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function integrationPackageEntry(): string {
  return fileURLToPath(import.meta.resolve("@omnesis/agent-integration"));
}

function integrationPackageRoot(): string {
  return dirname(dirname(integrationPackageEntry()));
}

/** Exact clean checkout represented by a locally packed integration plugin. */
export function integrationSourceCommit(packageRoot: string): string | undefined {
  try {
    const repository = execFileSync("git", ["-C", packageRoot, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["-C", repository, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (dirty) return undefined;
    const commit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD^{commit}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/u.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

export function publishManifestForLocalInstall(
  manifest: Record<string, unknown>,
  sourceCommit?: string,
): Record<string, unknown> {
  return {
    ...manifest,
    ...(sourceCommit ? { omnesisSourceCommit: sourceCommit } : {}),
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./openclaw": {
        types: "./dist/openclaw.d.ts",
        default: "./dist/openclaw.js",
      },
    },
    files: [
      "dist",
      "openclaw.plugin.json",
      "openclaw-entry.mjs",
      "hermes/__init__.py",
      "hermes/adapter.py",
      "hermes/plugin.yaml",
    ],
    devDependencies: undefined,
    scripts: undefined,
  };
}

/**
 * Build a fresh npm-pack artifact when running from a source checkout. A local
 * OpenClaw path install only copies files and does not install runtime
 * dependencies, while an archive install does both. Published installs are
 * packed as-is; source installs compile into an isolated temp directory and
 * never read the checkout's possibly absent or stale dist/.
 */
export function prepareOpenClawInstallArchive(
  sourceOverride: { packageRoot: string; entry: string } | undefined = undefined,
): {
  archivePath: string;
  cleanup(): void;
} {
  const packageRoot = sourceOverride?.packageRoot ?? integrationPackageRoot();
  const entry = sourceOverride?.entry ?? integrationPackageEntry();
  const sourceCommit = integrationSourceCommit(packageRoot);
  const tempRoot = mkdtempSync(join(tmpdir(), "omnesis-openclaw-plugin-"));
  let packRoot = packageRoot;
  try {
    if (entry.endsWith(join("src", "index.ts"))) {
      packRoot = join(tempRoot, "package");
      mkdirSync(join(packRoot, "dist"), { recursive: true });
      const typescriptEntry = fileURLToPath(import.meta.resolve("typescript"));
      const tsc = join(dirname(typescriptEntry), "..", "bin", "tsc");
      execFileSync(
        process.execPath,
        [
          tsc,
          "--project",
          join(packageRoot, "tsconfig.json"),
          "--outDir",
          join(packRoot, "dist"),
          "--tsBuildInfoFile",
          join(tempRoot, "agent-integration.tsbuildinfo"),
          "--composite",
          "false",
          "--declaration",
          "--declarationMap",
          "false",
          "--sourceMap",
          "false",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      // Enumerated, not the whole `hermes` directory: the adapter's test suite
      // lives beside it and has no business on an operator's machine. The
      // published tarball's own asset list (`scripts/release/stage-packages.mjs`)
      // names the same three files.
      for (const asset of [
        "openclaw-entry.mjs",
        "openclaw.plugin.json",
        join("hermes", "__init__.py"),
        join("hermes", "adapter.py"),
        join("hermes", "plugin.yaml"),
      ]) {
        const destination = join(packRoot, asset);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(packageRoot, asset), destination);
      }
      const sourceManifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      const publishManifest = publishManifestForLocalInstall(sourceManifest, sourceCommit);
      delete publishManifest.devDependencies;
      delete publishManifest.scripts;
      writeFileSync(
        join(packRoot, "package.json"),
        JSON.stringify(publishManifest, null, 2) + "\n",
      );
    }
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", tempRoot, packRoot], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const archives = readdirSync(tempRoot)
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => join(tempRoot, name));
    if (archives.length !== 1) {
      throw new Error(`expected one npm archive, found ${archives.length}`);
    }
    return {
      archivePath: archives[0]!,
      cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new CliError(
      `${c.red}Could not build the current OpenClaw integration artifact: ${
        error instanceof Error ? error.message : String(error)
      }${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
}

function runInstaller(command: string, args: string[], environment: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ||
      result.stderr.trim() ||
      `${command} exited with status ${result.status ?? "unknown"}`;
    throw new CliError(
      `${c.red}Could not install the Omnesis integration plugin: ${detail}${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
}

function retirePersistedLegacyOpenClawPlugin(environment: NodeJS.ProcessEnv): void {
  const result = spawnSync("openclaw", ["plugins", "uninstall", "omnesis-bridge", "--force"], {
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!result.error && result.status === 0) return;
  // Fresh installs have no legacy record. OpenClaw reports that benign case
  // as exit 1, so distinguish its exact diagnostic from a real registry or
  // config failure. Node's color-environment warning is unrelated to the
  // uninstall; remove only that known warning and its optional trace hint.
  const diagnostic = result.stderr?.replace(
    /^\(node:\d+\) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\.\r?\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?/gm,
    "",
  );
  if (
    !result.error &&
    result.status === 1 &&
    diagnostic?.trim() === "Plugin not found: omnesis-bridge"
  ) {
    return;
  }
  const detail =
    result.error?.message ||
    result.stderr.trim() ||
    result.stdout.trim() ||
    `openclaw exited with status ${result.status ?? "unknown"}`;
  throw new CliError(
    `${c.red}Could not retire the legacy OpenClaw Omnesis registry entry: ${detail}${c.reset}`,
    EXIT_USER_ERROR,
  );
}

interface PreparedHarnessPlugin {
  install(): void;
  cleanup(): void;
}

/**
 * Build/read every plugin artifact before a one-time pairing code is redeemed.
 * Preparation is side-effect free outside a temporary directory; activation
 * happens only after the new credentials are durably journaled.
 */
function prepareHarnessPlugin(
  harness: Harness,
  home: string,
  selectedOpenClawConfigPath?: string,
): PreparedHarnessPlugin {
  const packageRoot = integrationPackageRoot();
  const sourceCommit = integrationSourceCommit(packageRoot);
  switch (harness) {
    case "openclaw": {
      const artifact = prepareOpenClawInstallArchive();
      return {
        install: () => {
          const normalEnvironment = openClawInstallerEnvironment(
            home,
            selectedOpenClawConfigPath ?? openClawConfigPath(home),
          );
          delete normalEnvironment.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY;
          const migrationEnvironment = {
            ...normalEnvironment,
            // A legacy bridge can survive in OpenClaw's persisted plugin
            // registry after its temporary install root disappears. Force
            // this migration install to discover current manifests.
            OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
          };
          // Known bug: #112 — OpenClaw 2026.8.1+ refuses this install without capability consent.
          runInstaller(
            "openclaw",
            ["plugins", "install", "--force", `npm-pack:${artifact.archivePath}`],
            migrationEnvironment,
          );
          retirePersistedLegacyOpenClawPlugin(migrationEnvironment);
          // Rebuild without the bypass after removing the stale install
          // record, so subsequent normal OpenClaw processes see the new
          // integration and no cached missing-manifest diagnostic.
          runInstaller(
            "openclaw",
            ["plugins", "registry", "--refresh", "--json"],
            normalEnvironment,
          );
        },
        cleanup: artifact.cleanup,
      };
    }
    case "hermes": {
      const source = join(packageRoot, "hermes");
      const destination = join(home, "plugins", "omnesis-integration");
      const files = ["__init__.py", "adapter.py", "plugin.yaml"].map((file) => ({
        file,
        content:
          file === "plugin.yaml" && sourceCommit
            ? Buffer.from(
                `${readFileSync(join(source, file), "utf8").trimEnd()}\nsource_commit: ${sourceCommit}\n`,
              )
            : readFileSync(join(source, file)),
      }));
      const hermesCommand = [
        join(home, "hermes-agent", "venv", "bin", "hermes"),
        join(home, "hermes-agent", "hermes"),
      ].find((candidate) => existsSync(candidate));
      return {
        install: () => {
          for (const { file, content } of files) {
            atomicWriteFileSync(join(destination, file), content, {
              ensureDir: true,
              mode: 0o644,
            });
          }
          runInstaller(
            hermesCommand ?? "hermes",
            ["plugins", "enable", "--no-allow-tool-override", "omnesis-integration"],
            {
              ...process.env,
              HERMES_HOME: home,
            },
          );
          // Keep the working legacy integration intact until its replacement
          // has actually been enabled.
          retireLegacyHermesPlugin(home);
        },
        cleanup: () => {},
      };
    }
    default:
      return assertNever(harness);
  }
}

export function installHarnessPlugin(harness: Harness, home: string): void {
  const prepared = prepareHarnessPlugin(harness, home);
  try {
    prepared.install();
  } finally {
    prepared.cleanup();
  }
}

export async function buildTlsTrust(
  gatewayUrl: string,
  configDir = DEFAULT_CONFIG_DIR,
  options: {
    interactive?: boolean;
    confirmRotation?: (message: string) => Promise<boolean>;
    /**
     * Interrogate the gateway over the freshly observed certificate, before
     * any trust or harness file is touched. Anything it refuses leaves the
     * installation exactly as it was.
     */
    preflight?: (tls: TlsTrust | undefined) => Promise<void>;
    /**
     * A fingerprint the caller was told to expect. It is a claim about *which*
     * gateway is on the other end, so the certificate this function goes on to
     * bind every request to is the one checked against it — and it is checked
     * on every run, before the gateway is asked anything. It outranks the saved
     * certificate, the rotation prompt, `OMNESIS_TRUST_FINGERPRINT` and an
     * `http://` URL, each of which would otherwise let it pass unkept.
     */
    expectedFingerprint?: string;
  } = {},
): Promise<TlsTrust | undefined> {
  // Normalized here so a malformed pin is refused before a socket is opened,
  // rather than surfacing as a certificate that matches nothing.
  const pin =
    options.expectedFingerprint === undefined
      ? undefined
      : (normalizeCertFingerprint(options.expectedFingerprint) ?? undefined);
  if (options.expectedFingerprint !== undefined && pin === undefined) {
    throw new CliError(
      `${c.red}Not a SHA-256 certificate fingerprint: ${options.expectedFingerprint}${c.reset}\n` +
        `${c.dim}Expected 64 hex characters, optionally prefixed with "sha256:".${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const url = new URL(gatewayUrl);
  if (url.protocol !== "https:") {
    if (pin) {
      // There is no certificate on a plaintext connection, so the pin is a
      // promise this transport cannot keep.
      throw new CliError(
        `${c.red}Refusing to verify a certificate fingerprint over ${gatewayUrl}. ` +
          `A pinned gateway must be addressed over https://.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    await options.preflight?.(undefined);
    return undefined;
  }
  const host = url.hostname;
  const port = Number(url.port) || 443;
  const before = await fetchPeerCert(host, port);
  // The certificate every request below is pinned to is this one, so it is
  // this one the promise is checked against — a separate verified observation
  // would leave the connections that actually carry the pairing code bound to
  // something nobody checked.
  if (pin && before.fingerprint !== pin) {
    throw new CliError(
      `${c.red}Certificate fingerprint mismatch for ${gatewayUrl}.\n` +
        `  Expected: sha256:${pin}\n  Got:      sha256:${before.fingerprint}\n` +
        `Refusing to connect; nothing was changed. Check the fingerprint the gateway ` +
        `printed, and that the URL names the machine you meant.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  await options.preflight?.({
    caPem: before.pem,
    leafFingerprintSha256: before.fingerprint,
  });
  const certPath = join(configDir, "tls", "cert.pem");
  // A verified certificate is saved like a rotation is: at the end, once the
  // gateway has answered, so a run this function refuses leaves the trust every
  // other command on this host reads exactly as it was.
  let replaceSavedCertificate = pin !== undefined;
  // Both branches below are unpinned paths — adopt the saved certificate, or
  // trust on first sight. A pin is stronger evidence about which gateway is on
  // the other end than either, so it runs instead of them, not after them.
  if (!pin && existsSync(certPath)) {
    let savedFingerprint: string;
    try {
      savedFingerprint = new X509Certificate(readFileSync(certPath, "utf8")).fingerprint256
        .replaceAll(":", "")
        .toLowerCase();
    } catch {
      throw new CliError(
        `${c.red}Saved gateway certificate at ${certPath} is invalid; no trust was changed.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (savedFingerprint !== before.fingerprint) {
      const expected = process.env.OMNESIS_TRUST_FINGERPRINT?.replaceAll(":", "").toLowerCase();
      let approved = false;
      if (expected) {
        if (expected !== before.fingerprint) {
          throw new CliError(
            `${c.red}Gateway certificate rotation fingerprint mismatch.\n` +
              `  Expected: ${expected}\n  Received: ${before.fingerprint}\n` +
              `The saved certificate and all harness files were left unchanged.${c.reset}`,
            EXIT_USER_ERROR,
          );
        }
        approved = true;
      } else if (options.interactive ?? process.stdin.isTTY === true) {
        const message =
          `The gateway TLS certificate changed.\n\n` +
          `  Previous SHA-256: ${savedFingerprint}\n` +
          `  New SHA-256:      ${before.fingerprint}\n\n` +
          `Only approve after verifying the new fingerprint on the gateway.`;
        const confirm =
          options.confirmRotation ??
          (async (prompt: string) => {
            const prompts = await import("@clack/prompts");
            const answer = await prompts.confirm({ message: prompt, initialValue: false });
            return !prompts.isCancel(answer) && answer === true;
          });
        approved = await confirm(message);
      }
      if (!approved) {
        throw new CliError(
          `${c.red}Gateway certificate changed. Verify the new SHA-256 fingerprint and retry ` +
            `with OMNESIS_TRUST_FINGERPRINT=${before.fingerprint}; no trust or harness files ` +
            `were changed.${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      replaceSavedCertificate = true;
    } else {
      applyCaTrustInProcess(certPath);
    }
  } else if (!pin) {
    await ensureGatewayTrust({ gatewayUrl, configDir });
  }
  const trust: TlsTrust = {
    caPem: before.pem,
    leafFingerprintSha256: before.fingerprint,
  };
  try {
    await new PinnedGatewayHttpClient(gatewayUrl, "", trust).requestJson("GET", "/health");
  } catch (error) {
    const status = error instanceof IntegrationHttpError ? ` with HTTP ${error.status}` : "";
    throw new CliError(
      `${c.red}Gateway health check failed${status}; no credentials were written.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const after = await fetchPeerCert(host, port);
  if (before.fingerprint !== after.fingerprint || before.pem !== after.pem) {
    throw new CliError(
      `${c.red}Gateway TLS certificate changed during setup; no credentials were written.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (replaceSavedCertificate) {
    atomicWriteFileSync(certPath, before.pem, { ensureDir: true, mode: 0o600 });
    applyCaTrustInProcess(certPath);
  }
  return trust;
}

interface ConnectRecovery {
  version: 1;
  harness: Harness;
  gatewayUrl: string;
  tls?: TlsTrust;
  identity: IntegrationIdentity;
  pairingDeviceName: string;
  openClawConfigPath?: string;
}

interface ConnectRedemptionJournal {
  version: 1;
  harness: Harness;
  gatewayUrl: string;
  tls?: TlsTrust;
  identity: IntegrationIdentity;
  pairingCode: string;
  idempotencyKey: string;
  maxConcurrentRuns: number;
  openClawConfigPath?: string;
}

function connectRecoveryPath(home: string): string {
  return join(home, "omnesis", "connect-recovery.json");
}

function connectRedemptionPath(home: string): string {
  return join(home, "omnesis", "connect-redemption.json");
}

function parseConnectTls(value: unknown, label: string): TlsTrust | undefined {
  if (value === undefined) return undefined;
  if (
    !isPlainObject(value) ||
    typeof value.caPem !== "string" ||
    typeof value.leafFingerprintSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.leafFingerprintSha256)
  ) {
    throw new CliError(
      `${c.red}The pending ${label} TLS data is malformed.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return {
    caPem: value.caPem,
    leafFingerprintSha256: value.leafFingerprintSha256,
  };
}

function parseConnectRecovery(raw: string, harness: Harness): ConnectRecovery {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CliError(
      `${c.red}The pending ${harness} connect recovery journal is not valid JSON.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    value.harness !== harness ||
    typeof value.gatewayUrl !== "string" ||
    typeof value.pairingDeviceName !== "string" ||
    (value.openClawConfigPath !== undefined &&
      (typeof value.openClawConfigPath !== "string" || value.openClawConfigPath.trim() === ""))
  ) {
    throw new CliError(
      `${c.red}The pending ${harness} connect recovery journal is malformed.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const identity = parseIntegrationIdentity(JSON.stringify(value.identity), harness);
  const gatewayUrl = normalizeHarnessGatewayUrl(value.gatewayUrl);
  const tls = parseConnectTls(value.tls, `${harness} connect recovery`);
  return {
    version: 1,
    harness,
    gatewayUrl,
    ...(tls ? { tls } : {}),
    identity,
    pairingDeviceName: value.pairingDeviceName,
    ...(value.openClawConfigPath !== undefined
      ? { openClawConfigPath: resolve(value.openClawConfigPath) }
      : {}),
  };
}

function loadConnectRecovery(home: string, harness: Harness): ConnectRecovery | null {
  const path = connectRecoveryPath(home);
  return existsSync(path) ? parseConnectRecovery(readFileSync(path, "utf8"), harness) : null;
}

function writeConnectRecovery(home: string, recovery: ConnectRecovery): void {
  writePlaintextSecretFile(connectRecoveryPath(home), JSON.stringify(recovery, null, 2) + "\n");
}

function parseConnectRedemptionJournal(raw: string, harness: Harness): ConnectRedemptionJournal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CliError(
      `${c.red}The pending ${harness} redemption journal is not valid JSON.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    value.harness !== harness ||
    typeof value.gatewayUrl !== "string" ||
    typeof value.pairingCode !== "string" ||
    value.pairingCode.trim() === "" ||
    typeof value.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(value.idempotencyKey) ||
    typeof value.maxConcurrentRuns !== "number" ||
    !Number.isInteger(value.maxConcurrentRuns) ||
    value.maxConcurrentRuns < 1 ||
    (value.openClawConfigPath !== undefined &&
      (typeof value.openClawConfigPath !== "string" || value.openClawConfigPath.trim() === ""))
  ) {
    throw new CliError(
      `${c.red}The pending ${harness} redemption journal is malformed.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  const tls = parseConnectTls(value.tls, `${harness} redemption journal`);
  return {
    version: 1,
    harness,
    gatewayUrl: normalizeHarnessGatewayUrl(value.gatewayUrl),
    ...(tls ? { tls } : {}),
    identity: parseIntegrationIdentity(JSON.stringify(value.identity), harness),
    pairingCode: value.pairingCode,
    idempotencyKey: value.idempotencyKey,
    maxConcurrentRuns: value.maxConcurrentRuns,
    ...(value.openClawConfigPath !== undefined
      ? { openClawConfigPath: resolve(value.openClawConfigPath) }
      : {}),
  };
}

function loadConnectRedemptionJournal(
  home: string,
  harness: Harness,
): ConnectRedemptionJournal | null {
  const path = connectRedemptionPath(home);
  return existsSync(path)
    ? parseConnectRedemptionJournal(readFileSync(path, "utf8"), harness)
    : null;
}

function writeConnectRedemptionJournal(home: string, journal: ConnectRedemptionJournal): void {
  writePlaintextSecretFile(connectRedemptionPath(home), JSON.stringify(journal, null, 2) + "\n");
}

/**
 * Finish a redeemed connect journal. New secrets are durable before plugin
 * activation; legacy configuration is retired only after activation succeeds.
 * On any failure the journal remains, so rerunning `omnesis connect` resumes
 * without consuming another pairing code.
 */
function applyConnectRecovery(
  home: string,
  recovery: ConnectRecovery,
  prepared: PreparedHarnessPlugin,
  capabilities: HarnessSkillCapabilities,
): void {
  writePlaintextSecretFile(
    join(home, "omnesis", "integration-identity.json"),
    JSON.stringify(recovery.identity, null, 2) + "\n",
  );
  loadIntegrationCredentials(join(home, "omnesis", "integration.json"));
  readFileSync(join(home, ".env"), "utf8");

  // OpenClaw validates every configured load path before its plugin installer
  // runs. A retired bridge often points at a temporary directory that no
  // longer exists, which would otherwise prevent installing its replacement.
  // Remove only the known legacy registration for activation, and restore the
  // exact original config if activation fails.
  const openClawConfigPath =
    recovery.harness === "openclaw"
      ? (recovery.openClawConfigPath ?? join(home, "openclaw.json"))
      : undefined;
  const openClawConfigBeforeInstall =
    openClawConfigPath && existsSync(openClawConfigPath)
      ? readFileSync(openClawConfigPath, "utf8")
      : undefined;
  if (openClawConfigPath && openClawConfigBeforeInstall !== undefined) {
    const retiredConfig = retireLegacyOpenClawConfig(openClawConfigBeforeInstall);
    if (retiredConfig !== openClawConfigBeforeInstall) {
      writePlaintextSecretFile(openClawConfigPath, retiredConfig);
    }
  }
  try {
    prepared.install();
  } catch (error) {
    if (openClawConfigPath && openClawConfigBeforeInstall !== undefined) {
      writePlaintextSecretFile(openClawConfigPath, openClawConfigBeforeInstall);
    }
    throw error;
  }

  switch (recovery.harness) {
    case "openclaw": {
      const configPath = recovery.openClawConfigPath ?? join(home, "openclaw.json");
      // The official installer may add its own plugin registration to this
      // file. Merge into that post-install state instead of overwriting it
      // with a snapshot captured before activation.
      const installedConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
      writePlaintextSecretFile(
        configPath,
        mergeOpenClawSkillEnv(installedConfig, {
          OMNESIS_AGENT_HARNESS: "openclaw",
        }),
      );
      break;
    }
    case "hermes": {
      const configPath = join(home, "config.yaml");
      if (existsSync(configPath)) {
        // `hermes plugins enable` mutates this file. Retire only the legacy
        // bridge from that post-install state so the newly enabled plugin and
        // unrelated concurrent installer changes survive the migration.
        const installedConfig = readFileSync(configPath, "utf8");
        const retiredConfig = retireLegacyHermesConfig(installedConfig);
        if (retiredConfig !== installedConfig) {
          writePlaintextSecretFile(configPath, retiredConfig);
        }
      }
      break;
    }
    default:
      assertNever(recovery.harness);
  }

  atomicWriteFileSync(
    skillFilePath(recovery.harness, home),
    buildHarnessSkill(recovery.harness, capabilities),
    { ensureDir: true, mode: 0o644 },
  );
  rmSync(connectRecoveryPath(home), { force: true });
  rmSync(connectRedemptionPath(home), { force: true });
}

function loadRefreshState(
  home: string,
  harness: Harness,
  stateEnv: string,
): {
  credentials: IntegrationCredentials;
  skillEnv: { OMNESIS_AGENT_HARNESS: string };
  upgradedLegacyCredentials: boolean;
} {
  const credentialsPath = join(home, "omnesis", "integration.json");
  if (!existsSync(credentialsPath)) {
    throw new CliError(
      `${c.red}This ${harness} installation has no saved Omnesis integration credentials. ` +
        `Run a full \`omnesis connect ${harness}\` with a pairing code.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  let credentials: IntegrationCredentials;
  let upgradedLegacyCredentials = false;
  try {
    credentials = loadIntegrationCredentials(credentialsPath);
  } catch {
    const legacyManagementToken = dotenvSetting(stateEnv, "OMNESIS_TOKEN")?.trim();
    if (!legacyManagementToken) {
      throw new CliError(
        `${c.red}The saved ${harness} Omnesis integration credentials are malformed and ` +
          `the legacy management credential is unavailable. Repair the pairing before ` +
          `refreshing the plugin.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    try {
      credentials = upgradeLegacyIntegrationCredentials(credentialsPath, legacyManagementToken);
      upgradedLegacyCredentials = true;
    } catch {
      throw new CliError(
        `${c.red}The saved ${harness} Omnesis integration credentials are malformed. ` +
          `Repair the pairing before refreshing the plugin.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
  }
  return {
    credentials,
    skillEnv: { OMNESIS_AGENT_HARNESS: harness },
    upgradedLegacyCredentials,
  };
}

export const connectCommand = defineCommand({
  meta: {
    name: "connect",
    description:
      "Connect an external agent harness (OpenClaw, Hermes) to this user's Omnesis: " +
      "provision least-privilege credentials, install the plugin + skill, and verify health",
  },
  args: {
    harness: {
      type: "positional",
      description: `harness to connect (${HARNESSES.join(", ")})`,
      required: true,
    },
    "gateway-url": {
      type: "string",
      description: "Omnesis gateway URL the harness should talk to (e.g. https://gateway:7600)",
    },
    code: {
      type: "string",
      description:
        "Pairing code minted on a trusted Omnesis machine with " +
        "`omnesis devices pair --kind agent` (prompted for interactively when omitted)",
    },
    "trust-fingerprint": {
      type: "string",
      description:
        "Pin the gateway's certificate: verify it against this SHA-256 fingerprint (sha256:… or bare hex) instead of trusting it on sight",
    },
    dir: {
      type: "string",
      description: "Harness home directory (default: ~/.openclaw or ~/.hermes)",
    },
    "print-home": {
      type: "boolean",
      description:
        "Print the harness home directory this command would use, and exit without touching it",
    },
    "skill-only": {
      type: "boolean",
      description: "Only (re)write the skill file; skip pairing and env wiring",
    },
    refresh: {
      type: "boolean",
      description:
        "Refresh the installed plugin, skill, and the connection's OAuth authorization without re-pairing the operational device",
    },
  },
  async run(ctx) {
    const harnessArg = typeof ctx.args.harness === "string" ? ctx.args.harness.trim() : "";
    if (!isHarness(harnessArg)) {
      throw new CliError(
        `${c.red}Unknown harness "${harnessArg}" — expected one of: ${HARNESSES.join(", ")}.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const harness: Harness = harnessArg;

    const dirFlag = typeof ctx.args.dir === "string" ? ctx.args.dir : undefined;
    const home = harnessHome(harness, dirFlag);
    // Answered before the existence check below, because the caller most in
    // need of the answer is one deciding whether the harness is there at all.
    // This is the one path that resolves the home without acting on it, so a
    // script never has to re-derive the profile and legacy-directory rules.
    if (ctx.args["print-home"] === true) {
      // It connects nothing, so a run that also carries a connect flag is
      // asking for two different things and would silently get the cheaper one.
      const acting = ["code", "gateway-url", "trust-fingerprint", "skill-only", "refresh"].filter(
        (flag) => ctx.args[flag] !== undefined && ctx.args[flag] !== false,
      );
      if (acting.length > 0) {
        throw new CliError(
          `--print-home only resolves a path; drop ${acting.map((flag) => `--${flag}`).join(", ")} ` +
            `to print it, or drop --print-home to connect.`,
          EXIT_USER_ERROR,
        );
      }
      console.log(home);
      return;
    }
    if (!existsSync(home)) {
      throw new CliError(
        `${c.red}${harness} does not look installed here (missing ${home}). ` +
          `Pass --dir if its home lives elsewhere.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const stateEnvPath = join(home, ".env");
    const initialStateEnv = existsSync(stateEnvPath) ? readFileSync(stateEnvPath, "utf8") : "";
    const skillOnly = ctx.args["skill-only"] === true;
    const refresh = ctx.args.refresh === true;
    if (skillOnly && refresh) {
      throw new CliError("Use either --refresh or --skill-only, not both.", EXIT_USER_ERROR);
    }
    if (
      refresh &&
      (typeof ctx.args.code === "string" || typeof ctx.args["gateway-url"] === "string")
    ) {
      throw new CliError(
        "--refresh uses the existing pairing; do not pass --code or --gateway-url.",
        EXIT_USER_ERROR,
      );
    }
    // Normalized once, here rather than at the TLS layer, so a typo leaves as a
    // usage error carrying the exit code that says so. An empty value is a
    // refusal too: a script whose `--trust-fingerprint "$FP"` lost its variable
    // would otherwise be quietly downgraded to trusting whatever answers.
    const fingerprintFlag =
      typeof ctx.args["trust-fingerprint"] === "string"
        ? ctx.args["trust-fingerprint"].trim()
        : undefined;
    const pin =
      fingerprintFlag === undefined
        ? undefined
        : (normalizeCertFingerprint(fingerprintFlag) ?? undefined);
    if (fingerprintFlag !== undefined && pin === undefined) {
      throw new CliError(
        `${c.red}--trust-fingerprint is not a SHA-256 certificate fingerprint: ${fingerprintFlag}${c.reset}\n` +
          `${c.dim}Expected 64 hex characters, optionally prefixed with "sha256:".${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (pin !== undefined && skillOnly) {
      throw new CliError(
        "--skill-only reaches no gateway, so --trust-fingerprint has no certificate to verify.",
        EXIT_USER_ERROR,
      );
    }
    const pinOption = pin === undefined ? {} : { expectedFingerprint: pin };
    const loadedRecovery = skillOnly || refresh ? null : loadConnectRecovery(home, harness);
    const pendingRedemption =
      skillOnly || refresh ? null : loadConnectRedemptionJournal(home, harness);
    // Journals written before custom-config support always targeted the
    // config inside the selected state dir. Preserve that exact destination
    // even if the recovery shell now exports a different config override.
    const pendingRecovery =
      loadedRecovery?.harness === "openclaw" && !loadedRecovery.openClawConfigPath
        ? { ...loadedRecovery, openClawConfigPath: join(home, "openclaw.json") }
        : loadedRecovery;
    const selectedOpenClawConfigPath =
      harness === "openclaw"
        ? (pendingRecovery?.openClawConfigPath ??
          pendingRedemption?.openClawConfigPath ??
          openClawConfigPath(home))
        : undefined;
    let initialConfigText = "";

    switch (harness) {
      case "openclaw": {
        const configPath = selectedOpenClawConfigPath!;
        initialConfigText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
        // Validate every config node we will later traverse before redeeming a
        // token or writing any file. An empty env mutates only the throwaway
        // parsed object returned inside this call.
        mergeOpenClawSkillEnv(initialConfigText, {});
        break;
      }
      case "hermes": {
        const configPath = join(home, "config.yaml");
        initialConfigText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
        assertHermesCompletionNotifications(initialConfigText, initialStateEnv);
        break;
      }
      default:
        assertNever(harness);
    }

    const interactive = process.stdin.isTTY === true;
    const configDir = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
    const credentialsPath = join(home, "omnesis", "integration.json");
    // What the skill will describe and the plugin will register. Starts from
    // what this installation was last told, so `--skill-only` — which never
    // reaches a gateway — cannot quietly change it, and is replaced by the
    // live answer on every path that does reach one.
    let skillCapabilities: HarnessSkillCapabilities = {
      subscriptions: installedSubscriptionsCapability(home),
    };

    if (refresh) {
      const existing = loadRefreshState(home, harness, initialStateEnv);
      if (existing.upgradedLegacyCredentials) {
        console.log(
          `Preserved the existing ${c.bold}${harness}${c.reset} operational device pairing; ` +
            "OAuth approval will add its separate corpus-access connection.",
        );
      }
      // Re-establish trust the way a first connect does. Validating against
      // the stored pin first would make a rotated gateway certificate the one
      // failure `--refresh` cannot repair — and a renewed certificate is a
      // poor reason to spend a fresh pairing code.
      let capabilities: GatewayCapabilities | undefined;
      const tls = await buildTlsTrust(existing.credentials.gatewayUrl, configDir, {
        ...pinOption,
        preflight: async (trust) => {
          capabilities = await readIntegrationCapabilities(existing.credentials.gatewayUrl, trust);
        },
      });
      capabilities ??= await readIntegrationCapabilities(existing.credentials.gatewayUrl, tls);
      warnOnVersionDrift(capabilities, harness);
      skillCapabilities = { subscriptions: capabilities.subscriptions };
      const credentials = persistGatewayTrust(credentialsPath, existing.credentials, tls);
      await authorizeHarness(home, harness, credentials);
      const prepared = prepareHarnessPlugin(harness, home, selectedOpenClawConfigPath);
      try {
        prepared.install();
      } finally {
        prepared.cleanup();
      }
      if (harness === "openclaw") {
        const configPath = selectedOpenClawConfigPath!;
        const installedConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
        writePlaintextSecretFile(
          configPath,
          mergeOpenClawSkillEnv(installedConfig, existing.skillEnv),
        );
      } else {
        const configPath = join(home, "config.yaml");
        const installedConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
        const retiredConfig = retireLegacyHermesConfig(installedConfig);
        if (retiredConfig !== installedConfig) {
          writePlaintextSecretFile(configPath, retiredConfig);
        }
      }
      persistGatewayCapabilities(credentialsPath, skillCapabilities);
      console.log(
        `Refreshed the ${c.bold}${harness}${c.reset} Omnesis plugin without changing its operational device pairing.`,
      );
    } else if (!skillOnly) {
      if (pendingRecovery) {
        // A journalled connect can be resumed days later, so re-establish
        // trust here for the same reason `--refresh` does: the certificate may
        // have been renewed since the journal was written, and a resume must
        // not be the one path that cannot survive that.
        let capabilities: GatewayCapabilities | undefined;
        const recoveryTls = await buildTlsTrust(pendingRecovery.gatewayUrl, configDir, {
          ...pinOption,
          preflight: async (trust) => {
            capabilities = await readIntegrationCapabilities(pendingRecovery.gatewayUrl, trust);
          },
        });
        capabilities ??= await readIntegrationCapabilities(pendingRecovery.gatewayUrl, recoveryTls);
        warnOnVersionDrift(capabilities, harness);
        skillCapabilities = { subscriptions: capabilities.subscriptions };
        const prepared = prepareHarnessPlugin(harness, home, selectedOpenClawConfigPath);
        try {
          const credentials = persistGatewayTrust(
            credentialsPath,
            loadIntegrationCredentials(credentialsPath),
            recoveryTls,
          );
          await authorizeHarness(home, harness, credentials);
          applyConnectRecovery(home, pendingRecovery, prepared, skillCapabilities);
          persistGatewayCapabilities(credentialsPath, skillCapabilities);
        } finally {
          prepared.cleanup();
        }
        console.log(
          `Recovered ${c.bold}${pendingRecovery.pairingDeviceName}${c.reset} from the pending ` +
            `connect journal; no new pairing code was consumed.`,
        );
      } else {
        // Resolve where the harness should reach the gateway. The CLI's own
        // localhost default is almost never right on a harness machine, so the
        // URL must come from the flag, the env, or an interactive prompt.
        let gatewayUrl = pendingRedemption
          ? pendingRedemption.gatewayUrl
          : typeof ctx.args["gateway-url"] === "string"
            ? ctx.args["gateway-url"].trim()
            : (process.env.OMNESIS_GATEWAY_URL ?? "");
        let code = pendingRedemption
          ? pendingRedemption.pairingCode
          : typeof ctx.args.code === "string"
            ? ctx.args.code.trim()
            : "";

        if ((!gatewayUrl || !code) && !interactive) {
          throw new CliError(
            `${c.red}Non-interactive run needs --gateway-url and --code. ` +
              `Mint a code on a trusted Omnesis machine with:\n` +
              `  omnesis devices pair --kind agent${c.reset}`,
            EXIT_USER_ERROR,
          );
        }
        if (!gatewayUrl || !code) {
          const prompts = await import("@clack/prompts");
          prompts.intro(`Connect ${harness} to Omnesis`);
          if (!gatewayUrl) {
            const answer = await prompts.text({
              message: "Omnesis gateway URL (as reachable from this machine):",
              placeholder: "https://your-gateway:7600",
              validate: (v) => (!v || v.trim() === "" ? "Required" : undefined),
            });
            if (prompts.isCancel(answer)) throw new CliError("Cancelled.", EXIT_USER_ERROR);
            gatewayUrl = String(answer).trim();
          }
          if (!code) {
            const answer = await prompts.text({
              message:
                "Pairing code — mint one on a trusted Omnesis machine with " +
                "`omnesis devices pair --kind agent` " +
                "(or from the portal's Settings → Devices tab):",
              validate: (v) => (!v || v.trim() === "" ? "Required" : undefined),
            });
            if (prompts.isCancel(answer)) throw new CliError("Cancelled.", EXIT_USER_ERROR);
            code = String(answer).trim();
          }
        }
        gatewayUrl = normalizeHarnessGatewayUrl(gatewayUrl);

        // A resumed redemption reuses the certificate its journal recorded and
        // never observes one, so a pin brought to the resume is checked against
        // that record — otherwise it would be the one path where the promise
        // passes unkept. The journal's certificate is what the redeem connects
        // with, so a matching record is a kept promise, not merely a note.
        if (pin !== undefined && pendingRedemption) {
          const journalled = pendingRedemption.tls?.leafFingerprintSha256;
          if (journalled === undefined) {
            throw new CliError(
              `${c.red}The pending connect journal is for ${pendingRedemption.gatewayUrl}, which ` +
                `has no certificate to verify. Re-run without --trust-fingerprint to resume it, ` +
                `or delete ${connectRedemptionPath(home)} to start over.${c.reset}`,
              EXIT_USER_ERROR,
            );
          }
          if (journalled !== pin) {
            throw new CliError(
              `${c.red}The pending connect journal recorded a different gateway certificate ` +
                `(sha256:${journalled}) than --trust-fingerprint promises (sha256:${pin}); ` +
                `nothing was changed.${c.reset}`,
              EXIT_USER_ERROR,
            );
          }
        }
        let capabilities: GatewayCapabilities | undefined;
        const tls = pendingRedemption
          ? pendingRedemption.tls
          : await buildTlsTrust(gatewayUrl, configDir, {
              ...pinOption,
              preflight: async (trust) => {
                capabilities = await readIntegrationCapabilities(gatewayUrl, trust);
              },
            });
        capabilities ??= await readIntegrationCapabilities(gatewayUrl, tls);
        warnOnVersionDrift(capabilities, harness);
        skillCapabilities = { subscriptions: capabilities.subscriptions };
        const identity =
          pendingRedemption?.identity ?? loadOrCreateIntegrationIdentity(home, harness, false);
        const maxConcurrentRuns =
          pendingRedemption?.maxConcurrentRuns ?? (harness === "hermes" ? 1 : 2);
        const prepared = prepareHarnessPlugin(harness, home, selectedOpenClawConfigPath);
        const redemptionJournal: ConnectRedemptionJournal = pendingRedemption ?? {
          version: 1,
          harness,
          gatewayUrl,
          ...(tls ? { tls } : {}),
          identity,
          pairingCode: code,
          idempotencyKey: randomBytes(32).toString("base64url"),
          maxConcurrentRuns,
          ...(selectedOpenClawConfigPath ? { openClawConfigPath: selectedOpenClawConfigPath } : {}),
        };
        if (!pendingRedemption) writeConnectRedemptionJournal(home, redemptionJournal);
        try {
          let pairing: Awaited<ReturnType<typeof redeemAgentIntegrationPairingCode>>;
          try {
            pairing = await redeemAgentIntegrationPairingCode(gatewayUrl, code, harness, {
              idempotencyKey: redemptionJournal.idempotencyKey,
              maxConcurrentRuns,
              suggestedName: identity.suggestedName,
              ...(tls ? { tls } : {}),
            });
          } catch (error) {
            if (
              error instanceof Error &&
              /Invalid or expired agent pairing code/u.test(error.message)
            ) {
              rmSync(connectRedemptionPath(home), { force: true });
            }
            throw error;
          }

          const runtimeCredentials: IntegrationCredentials = {
            gatewayUrl,
            deliveryToken: pairing.credentials.delivery.token,
            ingestionToken: pairing.credentials.ingestion.token,
            managementToken: pairing.credentials.management.token,
            oauth: {
              redirectUri: "http://127.0.0.1/callback",
              clientInformation: {},
              tokens: {},
            },
            ...(tls ? { tls } : {}),
            maxConcurrentRuns,
          };
          const env = {
            // Every shell the harness spawns inherits this, which is how the
            // CLI knows it is being asked a question from inside an agent turn
            // and can point at the native tool instead.
            OMNESIS_AGENT_HARNESS: harness,
          };
          const envText = upsertEnvLines(initialStateEnv, env, [
            "OMNESIS_INTEGRATION_CREDENTIALS",
            "OMNESIS_HERMES_OWNER_IDS",
            "OMNESIS_GATEWAY_URL",
            "OMNESIS_TOKEN",
          ]);
          const recovery: ConnectRecovery = {
            version: 1,
            harness,
            gatewayUrl,
            ...(tls ? { tls } : {}),
            identity,
            pairingDeviceName: pairing.device.name,
            ...(selectedOpenClawConfigPath
              ? { openClawConfigPath: selectedOpenClawConfigPath }
              : {}),
          };
          writeIntegrationCredentials(credentialsPath, runtimeCredentials);
          writePlaintextSecretFile(join(home, ".env"), envText);
          if (harness === "openclaw" && initialConfigText !== "") {
            writePlaintextSecretFile(
              `${selectedOpenClawConfigPath!}.bak-omnesis`,
              retireLegacyOpenClawConfig(initialConfigText),
            );
          }
          writeConnectRecovery(home, recovery);
          rmSync(connectRedemptionPath(home), { force: true });
          try {
            await authorizeHarness(home, harness, runtimeCredentials);
            applyConnectRecovery(home, recovery, prepared, skillCapabilities);
            persistGatewayCapabilities(credentialsPath, skillCapabilities);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new CliError(
              `${detail}\n${c.yellow}The redeemed credentials are saved in their private ` +
                `runtime files and a non-secret recovery marker is present. Fix the local ` +
                `installation problem, then rerun the same connect command without a new ` +
                `pairing code.${c.reset}`,
              EXIT_USER_ERROR,
            );
          }
          console.log(
            `Paired ${c.bold}${pairing.device.name}${c.reset} as an operational agent device ` +
              `and authorized its separate MCP connection.`,
          );
        } finally {
          prepared.cleanup();
        }
      }
    }

    // The harness marker is not a credential and carries no pairing state, so
    // refreshing the skill refreshes it too. Without this an installation that
    // upgrades without re-pairing would take the new skill — which sends every
    // ask to the native tool — while its shells stayed silent about which
    // harness they belong to.
    const stateEnvAfterInstall = existsSync(stateEnvPath) ? readFileSync(stateEnvPath, "utf8") : "";
    const markedStateEnv = upsertEnvLines(
      stateEnvAfterInstall,
      { OMNESIS_AGENT_HARNESS: harness },
      [
        "OMNESIS_HERMES_OWNER_IDS",
        "OMNESIS_INTEGRATION_CREDENTIALS",
        "OMNESIS_GATEWAY_URL",
        "OMNESIS_TOKEN",
      ],
    );
    if (markedStateEnv !== stateEnvAfterInstall) {
      writePlaintextSecretFile(stateEnvPath, markedStateEnv);
    }

    const skillPath = skillFilePath(harness, home);
    atomicWriteFileSync(skillPath, buildHarnessSkill(harness, skillCapabilities), {
      ensureDir: true,
      mode: 0o644,
    });
    console.log(`Installed the Omnesis skill at ${skillPath}.`);

    console.log();
    switch (harness) {
      case "openclaw":
        console.log(
          `Verify with ${c.bold}openclaw skills check${c.reset} — the omnesis skill should be ` +
            `ready. Restart the OpenClaw gateway if it was running (config + env are read at startup).`,
        );
        break;
      case "hermes":
        console.log(
          `Restart the Hermes gateway, then start a ${c.bold}new session${c.reset} — the plugin, ` +
            `platform adapter, and skills index are loaded at startup.`,
        );
        break;
      default:
        assertNever(harness);
    }
    if (skillCapabilities.subscriptions) {
      console.log(`Then ask your agent a question, or to create or inspect an Omnesis watch.`);
    } else {
      console.log(
        `Then ask your agent a question about your Omnesis knowledge base. Watches are not ` +
          `available on this gateway, so neither the skill nor the plugin offers them.`,
      );
    }
  },
});

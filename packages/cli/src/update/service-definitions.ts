// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Bring an installed service definition to the running build's generator.
 *
 * `omnesis service install` writes a launchd plist or a systemd unit once, and
 * a restart never reads the generator again, so a hardening directive or an
 * environment variable a release adds would otherwise reach only machines
 * installed after it. The update reads the unit back into the inputs that
 * install took — the executable, the environment, the keyring credential —
 * applies the rules install applies, and regenerates.
 *
 * Operator state is never traded for currency. The settings a release owns
 * (restart policy, hardening) are rewritten; everything else the old unit says
 * must survive into the new one exactly, or the unit is left as it is. A
 * directive install never writes, a drop-in, a comment, or anything this
 * reader cannot parse is therefore a refusal, not a loss.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDotEnv } from "@omnesis/config";
import {
  PASSPHRASE_CREDENTIAL_NAME,
  servedCertificateCoversLocalhost,
  type ServiceComponent,
} from "@omnesis/core";
import { collectorAfterUnit, collectorGatewayUrl } from "../commands/service.js";
import { decodeXml } from "../service/rebind.js";
import {
  buildServiceSpec,
  generateLaunchdPlist,
  generateSystemdUnit,
  systemdUnitName,
} from "../service/units.js";
import {
  captureRegularFile,
  replaceFileSnapshot,
  restoreFileSnapshot,
  type FileIdentity,
} from "./package-migration-files.js";
import type { Supervisor } from "../service/supervisor.js";

export type ServiceDefinitionVerdict =
  | { kind: "unchanged" }
  | { kind: "changed"; content: string }
  | { kind: "refused"; reason: string };

type CoversLocalhost = NonNullable<Parameters<typeof collectorGatewayUrl>[0]["coversLocalhost"]>;

export interface RegenerateServiceDefinitionInput {
  platform: "darwin" | "linux";
  component: ServiceComponent;
  /** The installed unit, as read from disk. */
  content: string;
  homeDir: string;
  /** Heads a PATH the generator writes; the unit's own PATH, when it has one, wins. */
  nodeBinDir: string;
  /** Whether this account's gateway unit is installed beside this one. */
  gatewayInstalled: boolean;
  /** The config directory's `.env`, when it has one. */
  configEnv(configDir: string): string | undefined;
  coversLocalhost?: CoversLocalhost;
}

/** The inputs `omnesis service install` took, read back from its unit. */
interface InstalledInputs {
  exec: string[];
  env: Record<string, string>;
  passphraseCredentialPath?: string;
  /** systemd only: the units this one is ordered after. */
  after: string[];
}

class Unreadable extends Error {}

// ── systemd ────────────────────────────────────────────────────────────

interface Directive {
  section: string;
  key: string;
  value: string;
}

/** Settings whose value the release decides; any earlier value is replaced. */
const SYSTEMD_RELEASE_OWNED = new Set([
  "Documentation",
  "UMask",
  "Restart",
  "RestartSec",
  "NoNewPrivileges",
  "PrivateTmp",
  "ProtectSystem",
  "ProtectHome",
  "RestrictAddressFamilies",
]);

/** Space-separated lists: an old entry survives when the new list still has it. */
const SYSTEMD_LIST_SETTINGS = new Set(["After", "Wants", "WantedBy", "ReadWritePaths"]);

function systemdDirectives(content: string): Directive[] {
  const directives: Directive[] = [];
  let section: string | null = null;
  for (const line of content.split("\n")) {
    if (line === "") continue;
    const header = /^\[([A-Za-z]+)\]$/u.exec(line);
    if (header) {
      section = header[1]!;
      continue;
    }
    const assignment = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/u.exec(line);
    if (!section || !assignment || line.endsWith("\\")) {
      throw new Unreadable(`unrecognised line ${JSON.stringify(line)}`);
    }
    directives.push({ section, key: assignment[1]!, value: assignment[2]! });
  }
  return directives;
}

/** Undo `systemdEscapeArg` on each word of a command line. */
function systemdWords(value: string): string[] {
  return [...value.matchAll(/"((?:[^"\\]|\\["\\])*)"|[^\s"]+/gu)].map((match) =>
    (match[1] !== undefined ? match[1].replace(/\\(["\\])/gu, "$1") : match[0]).replaceAll(
      "%%",
      "%",
    ),
  );
}

function readSystemdInputs(content: string): InstalledInputs {
  const service = systemdDirectives(content).filter((d) => d.section === "Service");
  const execStart = service.filter((d) => d.key === "ExecStart");
  if (execStart.length !== 1) throw new Unreadable("it does not have exactly one ExecStart=");
  const env: Record<string, string> = {};
  for (const { value } of service.filter((d) => d.key === "Environment")) {
    let assignment = value;
    if (assignment.startsWith('"')) {
      if (assignment.length < 2 || !assignment.endsWith('"')) {
        throw new Unreadable(`unterminated Environment=${value}`);
      }
      assignment = assignment.slice(1, -1).replace(/\\(["\\])/gu, "$1");
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(assignment.replaceAll("%%", "%"));
    if (!match) throw new Unreadable(`unrecognised Environment=${value}`);
    if (match[1]! in env) throw new Unreadable(`it sets ${match[1]} twice`);
    env[match[1]!] = match[2]!;
  }
  const inputs: InstalledInputs = {
    exec: systemdWords(execStart[0]!.value),
    env,
    after: systemdDirectives(content)
      .filter((d) => d.section === "Unit" && d.key === "After")
      .flatMap((d) => d.value.split(/\s+/u)),
  };
  const credentials = service.filter((d) => d.key === "LoadCredential");
  const credential = /^([^:]*):(.*)$/su.exec(credentials[0]?.value.replaceAll("%%", "%") ?? "");
  // Anything but the one keyring credential install writes is not passed on,
  // so the survival check below refuses the unit rather than dropping it.
  if (credentials.length === 1 && credential?.[1] === PASSPHRASE_CREDENTIAL_NAME) {
    inputs.passphraseCredentialPath = credential[2]!;
  }
  return inputs;
}

/** What the new unit would drop of the old one, or null when nothing. */
function systemdLoss(before: string, after: string, dropped: ReadonlySet<string>): string | null {
  const next = systemdDirectives(after);
  for (const old of systemdDirectives(before)) {
    if (SYSTEMD_RELEASE_OWNED.has(old.key)) continue;
    // A variable this rewrite removed deliberately is not a setting lost: see
    // the loopback rule in regenerateServiceDefinition.
    if (old.key === "Environment" && dropped.has(old.value.split("=")[0])) continue;
    const same = next.filter((d) => d.section === old.section && d.key === old.key);
    const kept = SYSTEMD_LIST_SETTINGS.has(old.key)
      ? old.value
          .split(/\s+/u)
          .every((entry) => same.some((d) => d.value.split(/\s+/u).includes(entry)))
      : same.some((d) => d.value === old.value);
    if (!kept) return `its ${old.key}=${old.value} would not survive`;
  }
  return null;
}

// ── launchd ────────────────────────────────────────────────────────────

type PlistValue = string | number | boolean | PlistValue[] | Map<string, PlistValue>;

/** Plist keys whose value the release decides; any earlier value is replaced. */
const LAUNCHD_RELEASE_OWNED = new Set([
  "RunAtLoad",
  "KeepAlive",
  "ThrottleInterval",
  "ExitTimeOut",
  "ProcessType",
  "Umask",
]);

/**
 * The subset of the property-list format the generator writes: dicts,
 * arrays, strings, integers and booleans. Anything else — a comment, a date,
 * data, an entity the generator never emits — is refused rather than guessed.
 */
function parsePlist(content: string): Map<string, PlistValue> {
  if (content.includes("<!--")) throw new Unreadable("it carries a comment");
  const body = content.replace(/^<\?xml[^>]*\?>\s*<!DOCTYPE[^>]*>\s*/u, "");
  const tokens = [...body.matchAll(/<(\/?)([A-Za-z]+)(?: version="1\.0")?(\/?)>|([^<]+)/gu)];
  let at = 0;
  const tag = (): { name: string; kind: "open" | "close" | "empty" } => {
    while (tokens[at]?.[4] !== undefined && tokens[at]![4]!.trim() === "") at += 1;
    const token = tokens[at++];
    if (!token || token[2] === undefined) throw new Unreadable("it is not a property list");
    return { name: token[2], kind: token[1] ? "close" : token[3] ? "empty" : "open" };
  };
  const expect = (name: string, kind: "open" | "close"): void => {
    const next = tag();
    if (next.name !== name || next.kind !== kind) {
      throw new Unreadable(`expected <${kind === "close" ? "/" : ""}${name}>`);
    }
  };
  const text = (): string => (tokens[at]?.[4] !== undefined ? tokens[at++]![4]! : "");
  const closes = (name: string): boolean => {
    const saved = at;
    const next = tag();
    at = saved;
    return next.name === name && next.kind === "close";
  };
  const value = (): PlistValue => {
    const next = tag();
    if (next.kind === "empty" && (next.name === "true" || next.name === "false")) {
      return next.name === "true";
    }
    if (next.kind !== "open") throw new Unreadable(`unexpected <${next.name}>`);
    switch (next.name) {
      case "string": {
        const raw = text();
        expect("string", "close");
        return decodeXml(raw);
      }
      case "integer": {
        const raw = text();
        expect("integer", "close");
        if (!/^-?\d+$/u.test(raw)) throw new Unreadable(`unrecognised integer ${raw}`);
        return Number(raw);
      }
      case "array": {
        const items: PlistValue[] = [];
        while (!closes("array")) items.push(value());
        expect("array", "close");
        return items;
      }
      case "dict": {
        const entries = new Map<string, PlistValue>();
        while (!closes("dict")) {
          expect("key", "open");
          const key = decodeXml(text());
          expect("key", "close");
          if (entries.has(key)) throw new Unreadable(`it sets ${key} twice`);
          entries.set(key, value());
        }
        expect("dict", "close");
        return entries;
      }
      default:
        throw new Unreadable(`unsupported <${next.name}>`);
    }
  };
  expect("plist", "open");
  const root = value();
  expect("plist", "close");
  if (at < tokens.length && tokens.slice(at).some((token) => token[0].trim() !== "")) {
    throw new Unreadable("it has content after the property list");
  }
  if (!(root instanceof Map)) throw new Unreadable("its top level is not a dict");
  return root;
}

function readLaunchdInputs(content: string): InstalledInputs {
  const plist = parsePlist(content);
  const args = plist.get("ProgramArguments");
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === "string")) {
    throw new Unreadable("it has no ProgramArguments to run");
  }
  const variables = plist.get("EnvironmentVariables") ?? new Map<string, PlistValue>();
  if (!(variables instanceof Map)) throw new Unreadable("its EnvironmentVariables is not a dict");
  const env: Record<string, string> = {};
  for (const [key, entry] of variables) {
    if (typeof entry !== "string") throw new Unreadable(`its ${key} is not a string`);
    env[key] = entry;
  }
  return { exec: args, env, after: [] };
}

/** What the new plist would drop of the old one, or null when nothing. */
function launchdLoss(before: string, after: string, dropped: ReadonlySet<string>): string | null {
  const next = parsePlist(after);
  for (const [key, old] of parsePlist(before)) {
    if (LAUNCHD_RELEASE_OWNED.has(key)) continue;
    const replacement = next.get(key);
    const kept =
      key === "EnvironmentVariables" && old instanceof Map && replacement instanceof Map
        ? [...old].every(([name, entry]) => dropped.has(name) || replacement.get(name) === entry)
        : isDeepStrictEqual(old, replacement);
    if (!kept) return `its ${key} would not survive`;
  }
  return null;
}

// ── Regeneration ───────────────────────────────────────────────────────

/** Is this URL one only the gateway's own machine can dial? */
function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * The unit the running build's `omnesis service install` would write for this
 * one's inputs, or why it cannot be written without losing something. Pure
 * apart from the certificate and `.env` reads the collector rule makes.
 */
export function regenerateServiceDefinition(
  input: RegenerateServiceDefinitionInput,
): ServiceDefinitionVerdict {
  try {
    const installed =
      input.platform === "darwin"
        ? readLaunchdInputs(input.content)
        : readSystemdInputs(input.content);
    const configDir = installed.env.OMNESIS_CONFIG_DIR;
    if (!configDir) return { kind: "refused", reason: "it names no OMNESIS_CONFIG_DIR" };
    // Provenance is release-owned, not an operator extra. Remove the parsed
    // values before rebuilding so buildServiceSpec re-appends the canonical
    // marker after every inherited or newly-derived environment variable.
    // Besides preventing an old unit from choosing its own provenance, this
    // keeps regenerated plist bytes identical to a fresh install.
    delete installed.env.OMNESIS_SERVICE_MANAGER;
    delete installed.env.OMNESIS_SERVICE_INSTANCE;
    /** Environment variables this rewrite removes on purpose, not by loss. */
    const dropped = new Set<string>();
    // A loopback URL the served certificate cannot satisfy is not a choice
    // anyone made: 0.4.18 wrote https://localhost into every collector unit
    // regardless of the certificate, and a host with an operator or tailnet
    // certificate has a collector that can never complete a handshake. Updating
    // such a host kept that URL as "the operator's" and left it broken for good.
    // Dropping it lets the address recorded in .env — the one the certificate
    // names — apply again. An address that is not loopback is left alone.
    const inheritedUrl = installed.env.OMNESIS_GATEWAY_URL;
    if (
      input.component === "collector" &&
      inheritedUrl !== undefined &&
      isLoopbackUrl(inheritedUrl)
    ) {
      const configEnvContent = input.configEnv(configDir);
      const env = {
        ...(configEnvContent === undefined ? {} : parseDotEnv(configEnvContent)),
        ...installed.env,
      };
      const covers = input.coversLocalhost ?? servedCertificateCoversLocalhost;
      if (!covers(configDir, env)) {
        delete installed.env.OMNESIS_GATEWAY_URL;
        dropped.add("OMNESIS_GATEWAY_URL");
      }
    }
    // The rule install applies to a collector beside its gateway, with the
    // unit's environment standing in for the `--env` flags: a URL the unit
    // already carries is the operator's and is kept.
    const loopbackUrl = collectorGatewayUrl({
      component: input.component,
      installingAlongsideGateway: false,
      gatewayAlreadyInstalled: input.gatewayInstalled,
      extraEnv: installed.env,
      configEnvContent: input.configEnv(configDir),
      configDir,
      ...(input.coversLocalhost ? { coversLocalhost: input.coversLocalhost } : {}),
    });
    const spec = buildServiceSpec({
      component: input.component,
      configDir,
      exec: installed.exec,
      extraEnv:
        loopbackUrl === undefined
          ? installed.env
          : { ...installed.env, OMNESIS_GATEWAY_URL: loopbackUrl },
      platform: input.platform,
      homeDir: input.homeDir,
      nodeBinDir: input.nodeBinDir,
      ...(installed.passphraseCredentialPath
        ? { passphraseCredentialPath: installed.passphraseCredentialPath }
        : {}),
    });
    let content: string;
    let loss: string | null;
    if (input.platform === "darwin") {
      content = generateLaunchdPlist(spec);
      loss = launchdLoss(input.content, content, dropped);
    } else {
      const gatewayUnit = systemdUnitName("gateway");
      const afterUnit = collectorAfterUnit({
        platform: "linux",
        component: input.component,
        installingAlongsideGateway: false,
        gatewayAlreadyInstalled: input.gatewayInstalled || installed.after.includes(gatewayUnit),
        gatewayUnitName: gatewayUnit,
      });
      content = generateSystemdUnit(spec, afterUnit ? { afterUnit } : {});
      loss = systemdLoss(input.content, content, dropped);
    }
    if (loss) return { kind: "refused", reason: loss };
    return content === input.content ? { kind: "unchanged" } : { kind: "changed", content };
  } catch (err) {
    if (!(err instanceof Unreadable)) throw err;
    return { kind: "refused", reason: `it could not be read: ${err.message}` };
  }
}

// ── On the host ────────────────────────────────────────────────────────

export type ServiceDefinitionOutcome =
  | { kind: "unchanged" }
  | { kind: "replaced" }
  | { kind: "refused"; reason: string };

/** An update's hold on the service definitions of this account's daemons. */
export interface ServiceDefinitionUpdater {
  /** Rewrite a daemon's unit when this build generates different bytes. */
  refresh(component: ServiceComponent): Promise<ServiceDefinitionOutcome>;
  /** Have the manager read a rewritten unit without restarting; false where it cannot. */
  loadDefinition(component: ServiceComponent): Promise<boolean>;
  /** Restart a daemon so it runs under its rewritten unit. */
  reload(component: ServiceComponent): Promise<void>;
  /** Put back every unit this update rewrote; returns the daemons whose unit it restored. */
  restore(): Promise<ServiceComponent[]>;
}

interface Replacement {
  path: string;
  before: string;
  after: string;
  identity: FileIdentity;
}

/** The mode `omnesis service install` writes units with. */
const UNIT_MODE = 0o600;

export function serviceDefinitionUpdater(opts: {
  supervisor: Supervisor;
  homeDir: string;
  nodeBinDir: string;
  coversLocalhost?: CoversLocalhost;
}): ServiceDefinitionUpdater {
  const { supervisor } = opts;
  const replaced = new Map<ServiceComponent, Replacement>();
  return {
    async refresh(component) {
      const path = supervisor.unitPath(component);
      if (supervisor.platform === "linux") {
        // A drop-in or a fragment elsewhere changes the unit in ways its file
        // does not show, so a regenerated file could not account for them.
        const layers = await supervisor.inspectDefinition(component);
        if (layers.overridePaths.length > 0) {
          return {
            kind: "refused",
            reason: `drop-ins change it (${layers.overridePaths.join(", ")})`,
          };
        }
        if (layers.fragmentPath !== path) {
          return {
            kind: "refused",
            reason: `systemd loads it from ${layers.fragmentPath || "elsewhere"}`,
          };
        }
      }
      const snapshot = captureRegularFile(path);
      const verdict = regenerateServiceDefinition({
        platform: supervisor.platform,
        component,
        content: snapshot.content,
        homeDir: opts.homeDir,
        nodeBinDir: opts.nodeBinDir,
        gatewayInstalled: supervisor.isInstalled("gateway"),
        configEnv: (configDir) => {
          const envPath = join(configDir, ".env");
          return existsSync(envPath) ? readFileSync(envPath, "utf8") : undefined;
        },
        ...(opts.coversLocalhost ? { coversLocalhost: opts.coversLocalhost } : {}),
      });
      if (verdict.kind !== "changed") return verdict;
      const identity = replaceFileSnapshot(path, snapshot, verdict.content, UNIT_MODE);
      replaced.set(component, { path, before: snapshot.content, after: verdict.content, identity });
      return { kind: "replaced" };
    },
    loadDefinition: (component) => supervisor.loadDefinition(component),
    reload: (component) => supervisor.reload(component),
    restore() {
      const restored: ServiceComponent[] = [];
      for (const [component, unit] of replaced) {
        restoreFileSnapshot(unit.path, unit.before, unit.after, unit.identity, UNIT_MODE);
        replaced.delete(component);
        restored.push(component);
      }
      return Promise.resolve(restored);
    },
  };
}

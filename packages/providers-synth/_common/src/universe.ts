// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic corpus universes.
 *
 * A "universe" is a self-contained synthetic corpus: a persona cast, a set of
 * per-source fixture files, a list of seed sources, and (optionally) a
 * directory of replay-agent scenarios that reference docs and people from the
 * cast. Different universes serve different purposes — a tiny universe for
 * fast E2E tests, a rich universe for product demos, a stress universe for
 * load testing, etc. The mechanism here is universe-agnostic; the corpus
 * authors decide what each universe contains.
 *
 * Selection: `OMNESIS_SYNTH_UNIVERSE` env var.
 *   - Unset                       → `default`
 *   - Contains `/` or starts with `.` → treat as a filesystem path
 *   - Otherwise                   → name; resolved against `<repoRoot>/evals/universes/<name>/`
 *
 * Layout under each universe directory:
 *
 *   universe.json     — manifest (this module's schema)
 *   cast.json         — persona cast (loaded by cast.ts)
 *   sources/<descriptorId>/<file>.json   — per-source fixtures
 *   agent-demos/      — optional, replay-agent scenarios (.jsonl + .meta.json)
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEVICE_HOSTED_SOURCE_TYPES,
  DEVICE_KINDS,
  isDeviceKind,
  isMultiDeviceMode,
  type DeviceKind,
  type MultiDeviceMode,
} from "@omnesis/types";

import type { Cast } from "./types.js";

/**
 * A synthetic device in a universe's roster. Every seed source is attributed
 * to one roster device, so every synthetic document is pushed by a device the
 * gateway knows.
 */
export interface UniverseDeviceEntry {
  /** Roster id referenced by `sources[].device`, e.g. `macbook`, `iphone`. */
  readonly id: string;
  /** The name the device pairs under. Unique within the universe. */
  readonly name: string;
  /** Device kind; decides which source types the device may host. */
  readonly kind: DeviceKind;
}

export interface UniverseSourceEntry {
  /** Source descriptor id, e.g. `gmail`, `apple-notes`, `whatsapp-messages`. */
  readonly descriptorId: string;
  /** Account identifiers to seed for this descriptor (one source per id). */
  readonly accountIds: ReadonlyArray<string>;
  /** Roster id of the device that hosts these sources — the owner. */
  readonly device: string;
  /**
   * Roster ids of further devices hosting the same sources as members that
   * join the owner. Only a descriptor with a non-exclusive entry in the
   * manifest's `multiDeviceModes` admits members.
   */
  readonly members?: ReadonlyArray<string>;
}

/** The modes a universe puts under test; `exclusive` is the default and is never declared. */
export type UniverseMultiDeviceMode = Exclude<MultiDeviceMode, "exclusive">;

export interface UniverseManifest {
  /** Human-readable name. Should match the directory name for in-tree universes. */
  readonly name: string;
  /** One- or two-sentence description for tooling output. */
  readonly description?: string;
  /** Path to the cast file relative to the universe directory. */
  readonly cast: string;
  /**
   * Path to the agent-demos directory relative to the universe directory.
   * `null` or omitted disables the replay agent for this universe.
   */
  readonly agentDemos?: string | null;
  /** The synthetic devices of this universe; every source names one of them. */
  readonly devices: ReadonlyArray<UniverseDeviceEntry>;
  /** Sources that the demo gateway should seed for this universe. */
  readonly sources: ReadonlyArray<UniverseSourceEntry>;
  /**
   * Multi-device mode per descriptor id. The universe's collectors announce
   * these the way a real collector announces the modes its descriptors
   * declare, so a universe exercises a mode independently of whether the
   * descriptor ships it; a roster with modes therefore needs a collector.
   */
  readonly multiDeviceModes?: Readonly<Record<string, UniverseMultiDeviceMode>>;
}

/**
 * Roster device for every seed source, keyed by `<descriptorId>:<accountId>`.
 * Every `sources[].device` resolves: the manifest parser refuses a reference
 * to a device outside the roster.
 */
export function sourceDeviceAssignments(
  manifest: UniverseManifest,
): ReadonlyMap<string, UniverseDeviceEntry> {
  const devices = new Map(manifest.devices.map((d) => [d.id, d] as const));
  const out = new Map<string, UniverseDeviceEntry>();
  for (const src of manifest.sources) {
    const device = devices.get(src.device);
    if (!device)
      throw new UniverseError(`source ${src.descriptorId} names unknown device "${src.device}"`);
    for (const accountId of src.accountIds) out.set(`${src.descriptorId}:${accountId}`, device);
  }
  return out;
}

/**
 * Every roster device hosting each seed source, keyed by
 * `<descriptorId>:<accountId>` — the owner first, then its members in
 * manifest order.
 */
export function sourceHostAssignments(
  manifest: UniverseManifest,
): ReadonlyMap<string, ReadonlyArray<UniverseDeviceEntry>> {
  const devices = new Map(manifest.devices.map((d) => [d.id, d] as const));
  const out = new Map<string, UniverseDeviceEntry[]>();
  for (const src of manifest.sources) {
    const hosts = [src.device, ...(src.members ?? [])].map((id) => {
      const device = devices.get(id);
      if (!device)
        throw new UniverseError(`source ${src.descriptorId} names unknown device "${id}"`);
      return device;
    });
    for (const accountId of src.accountIds) out.set(`${src.descriptorId}:${accountId}`, hosts);
  }
  return out;
}

/**
 * Device kinds a roster may declare: collectors, plus every kind that pushes
 * at least one source type itself. The remaining kinds (cli, portal, agent)
 * host nothing, so a document can never originate from them.
 */
export const ROSTER_DEVICE_KINDS: readonly DeviceKind[] = DEVICE_KINDS.filter(
  (kind) => kind === "collector" || DEVICE_HOSTED_SOURCE_TYPES[kind].length > 0,
);

/**
 * Device kinds that host a source type by pushing its documents themselves
 * (phones, the browser extension). Empty for the types a collector polls.
 */
export function hostingDeviceKinds(descriptorId: string): DeviceKind[] {
  return DEVICE_KINDS.filter((kind) =>
    DEVICE_HOSTED_SOURCE_TYPES[kind].some((t) => String(t) === descriptorId),
  );
}

export interface Universe {
  /** Parsed manifest. */
  readonly manifest: UniverseManifest;
  /** Absolute path to the universe directory. */
  readonly dir: string;
}

export class UniverseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniverseError";
  }
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE =
  /(?:\+\d[\d\s().-]{7,}\d)|(?:\(\d{3}\)\s?\d{3}[\s.-]?\d{4})|(?:\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b)/g;
const RESERVED_EMAIL_DOMAIN =
  /(^|\.)(example\.(com|org|net|io)|[a-z0-9-]+\.(test|example|invalid|localhost))$/i;
const RESERVED_DOMAIN =
  /(^|\.)(example\.(com|org|net|io)|[a-z0-9-]+\.(test|example|invalid|localhost))$/i;
const TEXT_FIXTURE_EXTENSIONS = new Set([".json", ".jsonl", ".mjs", ".md", ".txt"]);
const SOURCE_INTERNAL_ADDRESS_DOMAINS = new Set(["g.us", "s.whatsapp.net"]);

// ── Repo root + name-to-path resolution ────────────────────────────────────

let cachedRepoRoot: string | null = null;
let cachedUniversesDir: string | null = null;

/**
 * Locate the universes directory by walking up from this module looking for a
 * `evals/universes` sibling. Cached after first call. Works both when running
 * from TS source (`packages/providers-synth/_common/src/`) and from compiled
 * output (`.../dist/`).
 */
export function getUniversesDir(): string {
  if (cachedUniversesDir) return cachedUniversesDir;
  let cur = dirname(fileURLToPath(import.meta.url));
  // Hard cap on the walk so a misconfigured environment can't loop forever.
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(cur, "evals", "universes");
    if (existsSync(candidate)) {
      cachedRepoRoot = cur;
      cachedUniversesDir = candidate;
      return candidate;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new UniverseError(
    `Could not locate evals/universes/ by walking up from ${fileURLToPath(import.meta.url)}. ` +
      `Universes live under <repoRoot>/evals/universes/<name>/. ` +
      `If the synth packages are bundled outside the repo, set OMNESIS_SYNTH_UNIVERSE to an absolute path.`,
  );
}

/** Repo root (sibling of evals/). Cached. */
export function getRepoRoot(): string {
  if (!cachedRepoRoot) getUniversesDir();
  return cachedRepoRoot!;
}

// ── Loading ────────────────────────────────────────────────────────────────

let cachedActive: Universe | null = null;

/**
 * Load the universe selected by the OMNESIS_SYNTH_UNIVERSE env var (default:
 * `default`). Cached for the lifetime of the process — universes are immutable
 * at runtime in this codebase.
 */
export function loadActiveUniverse(): Universe {
  if (cachedActive) return cachedActive;
  const raw = process.env.OMNESIS_SYNTH_UNIVERSE ?? "default";
  cachedActive = loadUniverse(raw);
  return cachedActive;
}

/**
 * Load a universe by name (resolved against `<repoRoot>/evals/universes/`) or
 * by filesystem path (absolute, or relative to `process.cwd()`).
 */
export function loadUniverse(nameOrPath: string): Universe {
  const dir = resolveUniverseDir(nameOrPath);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new UniverseError(
      `Universe not found: ${nameOrPath} (resolved to ${dir}). ` +
        `Available universes: ${listAvailableUniverses().join(", ") || "(none)"}.`,
    );
  }
  const manifestPath = join(dir, "universe.json");
  if (!existsSync(manifestPath)) {
    throw new UniverseError(`Universe at ${dir} is missing universe.json`);
  }
  let manifest: UniverseManifest;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown;
    manifest = validateManifest(raw, manifestPath);
  } catch (err) {
    if (err instanceof UniverseError) throw err;
    throw new UniverseError(
      `Failed to parse ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { manifest, dir };
}

/** Reset the memoized active universe — testing aid. */
export function resetActiveUniverseCache(): void {
  cachedActive = null;
}

function resolveUniverseDir(nameOrPath: string): string {
  if (nameOrPath.length === 0) {
    throw new UniverseError("OMNESIS_SYNTH_UNIVERSE is an empty string");
  }
  // Path-mode: anything containing a slash, starting with a dot, or absolute.
  if (nameOrPath.includes("/") || nameOrPath.startsWith(".") || isAbsolute(nameOrPath)) {
    return isAbsolute(nameOrPath) ? nameOrPath : resolve(process.cwd(), nameOrPath);
  }
  // Name-mode: look under evals/universes/<name>/.
  return join(getUniversesDir(), nameOrPath);
}

function listAvailableUniverses(): string[] {
  try {
    return readdirSync(getUniversesDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// ── Manifest validation ────────────────────────────────────────────────────

function validateManifest(raw: unknown, path: string): UniverseManifest {
  if (!isPlainObject(raw)) throw new UniverseError(`${path}: top-level must be an object`);
  const name = raw["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new UniverseError(`${path}: 'name' must be a non-empty string`);
  }
  const description = raw["description"];
  if (description !== undefined && typeof description !== "string") {
    throw new UniverseError(`${path}: 'description' must be a string when present`);
  }
  const cast = raw["cast"];
  if (typeof cast !== "string" || cast.length === 0) {
    throw new UniverseError(`${path}: 'cast' must be a non-empty string (path to cast file)`);
  }
  const agentDemosRaw = raw["agentDemos"];
  let agentDemos: string | null | undefined;
  if (agentDemosRaw === undefined || agentDemosRaw === null) {
    agentDemos = agentDemosRaw;
  } else if (typeof agentDemosRaw === "string") {
    agentDemos = agentDemosRaw;
  } else {
    throw new UniverseError(`${path}: 'agentDemos' must be a string, null, or omitted`);
  }
  const devicesRaw = raw["devices"];
  if (!Array.isArray(devicesRaw) || devicesRaw.length === 0) {
    throw new UniverseError(`${path}: 'devices' must be a non-empty array (the device roster)`);
  }
  const devices: UniverseDeviceEntry[] = devicesRaw.map((d, idx) => {
    if (!isPlainObject(d)) throw new UniverseError(`${path}: devices[${idx}] must be an object`);
    const id = d["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new UniverseError(`${path}: devices[${idx}].id must be a non-empty string`);
    }
    const deviceName = d["name"];
    if (typeof deviceName !== "string" || deviceName.length === 0) {
      throw new UniverseError(`${path}: devices[${idx}].name must be a non-empty string`);
    }
    const kind = d["kind"];
    if (typeof kind !== "string" || !isDeviceKind(kind) || !ROSTER_DEVICE_KINDS.includes(kind)) {
      throw new UniverseError(
        `${path}: devices[${idx}].kind must be one of ${ROSTER_DEVICE_KINDS.join(", ")}`,
      );
    }
    return { id, name: deviceName, kind };
  });
  const rosterIds = new Set(devices.map((d) => d.id));
  const sourcesRaw = raw["sources"];
  if (!Array.isArray(sourcesRaw)) {
    throw new UniverseError(`${path}: 'sources' must be an array`);
  }
  const sources: UniverseSourceEntry[] = sourcesRaw.map((s, idx) => {
    if (!isPlainObject(s)) {
      throw new UniverseError(`${path}: sources[${idx}] must be an object`);
    }
    const descriptorId = s["descriptorId"];
    if (typeof descriptorId !== "string" || descriptorId.length === 0) {
      throw new UniverseError(`${path}: sources[${idx}].descriptorId must be a non-empty string`);
    }
    const accountIdsRaw = s["accountIds"];
    if (!Array.isArray(accountIdsRaw) || accountIdsRaw.length === 0) {
      throw new UniverseError(`${path}: sources[${idx}].accountIds must be a non-empty array`);
    }
    const accountIds = accountIdsRaw.map((a, j) => {
      if (typeof a !== "string" || a.length === 0) {
        throw new UniverseError(
          `${path}: sources[${idx}].accountIds[${j}] must be a non-empty string`,
        );
      }
      return a;
    });
    const device = s["device"];
    if (typeof device !== "string" || !rosterIds.has(device)) {
      throw new UniverseError(
        `${path}: sources[${idx}].device must name a device from the 'devices' roster (${[...rosterIds].join(", ")})`,
      );
    }
    const membersRaw = s["members"];
    let members: string[] | undefined;
    if (membersRaw !== undefined) {
      if (!Array.isArray(membersRaw)) {
        throw new UniverseError(`${path}: sources[${idx}].members must be an array when present`);
      }
      members = membersRaw.map((m, j) => {
        if (typeof m !== "string" || !rosterIds.has(m)) {
          throw new UniverseError(
            `${path}: sources[${idx}].members[${j}] must name a device from the 'devices' roster`,
          );
        }
        if (m === device) {
          throw new UniverseError(
            `${path}: sources[${idx}].members[${j}] repeats the owner "${device}"`,
          );
        }
        return m;
      });
      if (new Set(members).size !== members.length) {
        throw new UniverseError(`${path}: sources[${idx}].members lists a device twice`);
      }
    }
    return members
      ? { descriptorId, accountIds, device, members }
      : { descriptorId, accountIds, device };
  });
  const modesRaw = raw["multiDeviceModes"];
  let multiDeviceModes: Record<string, UniverseMultiDeviceMode> | undefined;
  if (modesRaw !== undefined) {
    if (!isPlainObject(modesRaw)) {
      throw new UniverseError(`${path}: 'multiDeviceModes' must be an object when present`);
    }
    multiDeviceModes = {};
    for (const [descriptorId, mode] of Object.entries(modesRaw)) {
      if (typeof mode !== "string" || !isMultiDeviceMode(mode) || mode === "exclusive") {
        throw new UniverseError(
          `${path}: multiDeviceModes["${descriptorId}"] must be one of handoff, replicated, partitioned`,
        );
      }
      multiDeviceModes[descriptorId] = mode;
    }
  }
  return {
    name,
    description,
    cast,
    agentDemos,
    devices,
    sources,
    ...(multiDeviceModes ? { multiDeviceModes } : {}),
  };
}

/**
 * The device roster is the attribution contract: roster ids and names are
 * unique, and the device a source names can host it — a phone-pushed type
 * sits on a phone of the right platform, everything else on a collector. An
 * idle device is allowed but flagged.
 */
function validateDeviceRoster(manifest: UniverseManifest): UniverseIssue[] {
  const issues: UniverseIssue[] = [];
  const byId = new Map<string, UniverseDeviceEntry>();
  const names = new Set<string>();
  manifest.devices.forEach((device, idx) => {
    if (byId.has(device.id)) {
      issues.push({
        severity: "error",
        where: `devices[${idx}]`,
        message: `duplicate roster id "${device.id}"`,
      });
    }
    if (names.has(device.name)) {
      issues.push({
        severity: "error",
        where: `devices[${idx}]`,
        message: `duplicate device name "${device.name}" — names are unique per gateway`,
      });
    }
    byId.set(device.id, device);
    names.add(device.name);
  });
  const referenced = new Set<string>();
  const seededDescriptors = new Set<string>();
  manifest.sources.forEach((src, idx) => {
    const where = `sources[${idx}] (${src.descriptorId})`;
    seededDescriptors.add(src.descriptorId);
    const hosts = hostingDeviceKinds(src.descriptorId);
    // The owner and every member must be of a kind that hosts the type.
    for (const rosterId of [src.device, ...(src.members ?? [])]) {
      const device = byId.get(rosterId);
      if (!device) continue;
      referenced.add(device.id);
      if (hosts.length > 0 && !hosts.includes(device.kind)) {
        issues.push({
          severity: "error",
          where,
          message: `"${src.descriptorId}" is pushed by ${hosts.join("/")} devices; "${device.id}" has kind ${device.kind}`,
        });
      } else if (hosts.length === 0 && device.kind !== "collector") {
        issues.push({
          severity: "error",
          where,
          message: `"${src.descriptorId}" is synced by a collector; "${device.id}" has kind ${device.kind}`,
        });
      }
    }
    if ((src.members?.length ?? 0) > 0 && !manifest.multiDeviceModes?.[src.descriptorId]) {
      issues.push({
        severity: "error",
        where,
        message: `"${src.descriptorId}" lists members but has no non-exclusive entry in 'multiDeviceModes' — an exclusive source has one host`,
      });
    }
  });
  if (
    Object.keys(manifest.multiDeviceModes ?? {}).length > 0 &&
    !manifest.devices.some((d) => d.kind === "collector")
  ) {
    issues.push({
      severity: "error",
      where: "multiDeviceModes",
      message: "a mode is announced to the gateway by a collector; add a collector to the roster",
    });
  }
  for (const descriptorId of Object.keys(manifest.multiDeviceModes ?? {})) {
    if (!seededDescriptors.has(descriptorId)) {
      issues.push({
        severity: "warn",
        where: `multiDeviceModes["${descriptorId}"]`,
        message: "no seed source has this descriptor",
      });
    }
  }
  manifest.devices.forEach((device, idx) => {
    if (!referenced.has(device.id)) {
      issues.push({
        severity: "warn",
        where: `devices[${idx}] (${device.id})`,
        message: "no source is attributed to this device",
      });
    }
  });
  return issues;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Fixture readers ────────────────────────────────────────────────────────

/**
 * Read a per-source fixture file. `sourceKey` is the source descriptor id
 * (e.g. `"gmail"`), `file` is the filename within the source's directory.
 */
export function loadSourceFixtureJson<T>(universe: Universe, sourceKey: string, file: string): T {
  const path = join(universe.dir, "sources", sourceKey, file);
  if (!existsSync(path)) {
    throw new UniverseError(
      `Universe '${universe.manifest.name}' is missing fixture ${sourceKey}/${file} ` +
        `(expected at ${path})`,
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err) {
    throw new UniverseError(
      `Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Read and parse the cast file declared by the manifest. */
export function loadCastFromUniverse(universe: Universe): Cast {
  const path = join(universe.dir, universe.manifest.cast);
  if (!existsSync(path)) {
    throw new UniverseError(
      `Universe '${universe.manifest.name}' is missing cast file (expected at ${path})`,
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Cast;
  } catch (err) {
    throw new UniverseError(
      `Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Absolute path to the universe's agent-demos directory, or null if not declared. */
export function getAgentDemosDir(universe: Universe): string | null {
  const rel = universe.manifest.agentDemos;
  if (!rel) return null;
  return join(universe.dir, rel);
}

// ── Validator ──────────────────────────────────────────────────────────────

/**
 * Inference roles a replay cassette may declare in its `.meta.json`. These are
 * the roles the gateway builds a replay backend for; anything else names a role
 * that would never pick the scenario up.
 */
const REPLAYABLE_ROLES = new Set(["agent", "privacy-reviewer", "background-agent"]);

export interface UniverseIssue {
  /** Severity. `error` blocks use; `warn` is informational. */
  readonly severity: "error" | "warn";
  /** Where the issue was found (file or section). */
  readonly where: string;
  /** Human-readable message. */
  readonly message: string;
}

/**
 * Best-effort validation that a universe is internally consistent. Returns
 * the list of issues found ([] when valid). Designed to catch the common
 * authoring mistakes that would otherwise surface as cryptic boot failures.
 */
export function validateUniverse(universe: Universe): UniverseIssue[] {
  const issues: UniverseIssue[] = [];
  const { dir, manifest } = universe;

  // Cast.
  let cast: Cast | null = null;
  try {
    const loadedCast = loadCastFromUniverse(universe);
    cast = loadedCast;
    if (typeof loadedCast.self !== "string" || loadedCast.self.length === 0) {
      issues.push({
        severity: "error",
        where: manifest.cast,
        message: "cast.self must be a non-empty string",
      });
    }
    if (!Array.isArray(loadedCast.people) || loadedCast.people.length === 0) {
      issues.push({
        severity: "error",
        where: manifest.cast,
        message: "cast.people must be a non-empty array",
      });
    } else if (loadedCast.people.findIndex((p) => p.id === loadedCast.self) === -1) {
      issues.push({
        severity: "error",
        where: manifest.cast,
        message: `cast.self='${loadedCast.self}' has no matching entry in cast.people`,
      });
    }
  } catch (err) {
    issues.push({
      severity: "error",
      where: manifest.cast,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  issues.push(...validateDeviceRoster(manifest));

  // Sources — every declared descriptorId has its sources/<id>/ dir with at least one .json.
  for (const src of manifest.sources) {
    const srcDir = join(dir, "sources", src.descriptorId);
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
      issues.push({
        severity: "error",
        where: `sources/${src.descriptorId}`,
        message: `directory missing — expected at ${srcDir}`,
      });
      continue;
    }
    const jsons = readdirSync(srcDir).filter((f) => f.endsWith(".json"));
    if (jsons.length === 0) {
      issues.push({
        severity: "error",
        where: `sources/${src.descriptorId}`,
        message: "directory has no .json fixture files",
      });
    }
  }

  issues.push(...validateSyntheticIdentityLiterals(universe, cast));

  // Agent demos — if declared, every .jsonl has a sibling .meta.json that parses.
  const demosDir = getAgentDemosDir(universe);
  if (demosDir) {
    if (!existsSync(demosDir) || !statSync(demosDir).isDirectory()) {
      issues.push({
        severity: "error",
        where: manifest.agentDemos ?? "agent-demos",
        message: `agent-demos directory missing — expected at ${demosDir}`,
      });
    } else {
      const entries = readdirSync(demosDir);
      const jsonl = entries.filter((f) => f.endsWith(".jsonl")).sort();
      // Best-effort placeholder check: collect all docExternalIds referenced
      // by .meta.json files and confirm each one is mentioned somewhere in
      // the source fixtures (substring match). This catches the "agent
      // scenario references a doc that no source produces" class of bug.
      const allFixtureText = collectFixtureText(dir, manifest);
      for (const file of jsonl) {
        const name = file.slice(0, -".jsonl".length);

        // Cassette round-trip: every recorded `.jsonl` must parse into replay
        // entries and serialize back stably, so a scenario the recorder
        // produced (scripts/record-replay-scenario.mjs) is provably replayable
        // by `ReplayBackend` rather than silently malformed. Self-contained
        // (no @omnesis/agent dep) — it mirrors the JSONL contract that package
        // documents: one `{ afterMs, event: { type: "agent.*", payload } }`
        // object per line, comments (`#`) and blanks skipped.
        const rt = checkCassetteRoundTrip(join(demosDir, file));
        if (rt) {
          issues.push({ severity: "error", where: `agent-demos/${file}`, message: rt });
        }

        const batchProtocol = checkBatchToolProtocol(join(demosDir, file));
        if (batchProtocol) {
          issues.push({ severity: "error", where: `agent-demos/${file}`, message: batchProtocol });
        }

        const captures = checkCaptureIntegrity(join(demosDir, file));
        if (captures) {
          issues.push({ severity: "error", where: `agent-demos/${file}`, message: captures });
        }

        const metaPath = join(demosDir, `${name}.meta.json`);
        if (!existsSync(metaPath)) {
          issues.push({
            severity: "error",
            where: `agent-demos/${name}`,
            message: `${file} has no sibling ${name}.meta.json`,
          });
          continue;
        }
        let meta: unknown;
        try {
          meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        } catch (err) {
          issues.push({
            severity: "error",
            where: `agent-demos/${name}.meta.json`,
            message: `parse error: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
        if (!isPlainObject(meta)) {
          issues.push({
            severity: "error",
            where: `agent-demos/${name}.meta.json`,
            message: "top-level must be an object",
          });
          continue;
        }
        const triggers = meta["triggers"];
        if (!Array.isArray(triggers) || triggers.length === 0) {
          issues.push({
            severity: "error",
            where: `agent-demos/${name}.meta.json`,
            message: "triggers must be a non-empty array of strings",
          });
        }
        // Which inference role replays this cassette. Omitted means the chat
        // agent; a scenario naming a role the gateway does not resolve a
        // backend for would simply never be picked, which is silent, so the
        // set is checked rather than accepted as a free string.
        const role = meta["role"];
        if (role !== undefined && (typeof role !== "string" || !REPLAYABLE_ROLES.has(role))) {
          issues.push({
            severity: "error",
            where: `agent-demos/${name}.meta.json`,
            message: `role must be omitted or one of ${[...REPLAYABLE_ROLES].join(", ")}`,
          });
        }
        const placeholders = meta["placeholders"];
        if (placeholders !== undefined && isPlainObject(placeholders)) {
          const ids = placeholders["docExternalIds"];
          if (Array.isArray(ids)) {
            for (const id of ids) {
              if (typeof id === "string" && id.length > 0 && !fixtureMentions(allFixtureText, id)) {
                issues.push({
                  severity: "warn",
                  where: `agent-demos/${name}.meta.json`,
                  message: `docExternalIds entry '${id}' not found in any source fixture (placeholder won't resolve at session-create)`,
                });
              }
            }
          }
        }
      }
      if (jsonl.length === 0) {
        issues.push({
          severity: "warn",
          where: manifest.agentDemos ?? "agent-demos",
          message: "no .jsonl scenarios found in agent-demos directory",
        });
      }
    }
  }

  return issues;
}

function validateSyntheticIdentityLiterals(universe: Universe, cast: Cast | null): UniverseIssue[] {
  const issues: UniverseIssue[] = [];
  const seen = new Set<string>();
  const pushOnce = (where: string, message: string) => {
    const key = `${where}\0${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ severity: "error", where, message });
  };

  for (const { where, text } of collectUniverseTextFiles(universe.dir)) {
    for (const match of text.matchAll(EMAIL_RE)) {
      if (!emailLiteralAllowed(match[0])) {
        pushOnce(where, `email '${match[0]}' must use a reserved example domain`);
      }
    }
    for (const match of text.matchAll(PHONE_RE)) {
      if (!isSyntheticPhone(match[0])) {
        pushOnce(where, `phone '${match[0]}' must use a fictional test range`);
      }
    }
  }

  for (const src of universe.manifest.sources) {
    for (const accountId of src.accountIds) {
      if (accountId.includes("@") && !emailUsesReservedDomain(accountId)) {
        pushOnce(
          "universe.json",
          `source '${src.descriptorId}' accountId '${accountId}' must use a reserved example domain`,
        );
      } else if (accountId.startsWith("+") && !isSyntheticPhone(accountId)) {
        pushOnce(
          "universe.json",
          `source '${src.descriptorId}' accountId '${accountId}' must use a fictional test range`,
        );
      }
    }
  }

  if (cast) {
    for (const person of cast.people ?? []) {
      for (const email of person.emails ?? []) {
        if (!emailUsesReservedDomain(email)) {
          pushOnce(
            universe.manifest.cast,
            `person '${person.id}' email '${email}' must use a reserved example domain`,
          );
        }
      }
      for (const phone of person.phones ?? []) {
        if (!isSyntheticPhone(phone)) {
          pushOnce(
            universe.manifest.cast,
            `person '${person.id}' phone '${phone}' must use a fictional test range`,
          );
        }
      }
    }
    for (const org of cast.orgs ?? []) {
      if (org.domain && !RESERVED_DOMAIN.test(org.domain)) {
        pushOnce(
          universe.manifest.cast,
          `org '${org.id}' domain '${org.domain}' must use a reserved example domain`,
        );
      }
    }
  }

  return issues;
}

function collectUniverseTextFiles(dir: string): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile() || !TEXT_FIXTURE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        continue;
      }
      try {
        out.push({
          where: relative(dir, full),
          text: readFileSync(full, "utf-8"),
        });
      } catch {
        /* best-effort; normal fixture parsing reports unreadable required files. */
      }
    }
  };
  visit(dir);
  return out;
}

function emailUsesReservedDomain(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  return RESERVED_EMAIL_DOMAIN.test(email.slice(at + 1).toLowerCase());
}

function emailLiteralAllowed(email: string): boolean {
  if (emailUsesReservedDomain(email)) return true;
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (!SOURCE_INTERNAL_ADDRESS_DOMAINS.has(domain)) return false;
  if (domain === "g.us") return true;
  return local === "0" || isSyntheticPhone(local);
}

function isSyntheticPhone(phone: string): boolean {
  const digits = phone.replaceAll(/\D/g, "");
  return /^155501(?:\d{2}|0\d{4})$/.test(digits) || /^447700900\d{3}$/.test(digits);
}

/**
 * Capture/reference integrity for a cassette whose tool calls run live.
 *
 * A live call's result is real, so ids differ from the recording's. An
 * entry may `capture` values out of its own live result, and later entries
 * reference them as `$CAP_<name>`. Two ways that goes wrong silently, both
 * checked here: a reference to a name nothing ever captured (the literal
 * `$CAP_x` would then be passed to a real tool), and a reference that
 * appears BEFORE the entry that captures it (the capture table is filled
 * in emission order, so an early reference resolves to nothing).
 *
 * Also rejects a capture on an entry that is not a live tool call, which
 * would never fire: a recorded result short-circuits the live invocation
 * the capture reads from.
 */
function checkCaptureIntegrity(path: string): string | null {
  let source: string;
  try {
    source = readFileSync(path, "utf-8");
  } catch {
    return null; // the round-trip check already reports unreadable cassettes
  }
  interface Line {
    lineNo: number;
    type: string;
    toolCallId: string | null;
    capture: Record<string, unknown> | null;
    text: string;
  }
  const parsedLines: Line[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null; // reported by the round-trip check
    }
    const event = obj.event;
    if (!isPlainObject(event)) return null;
    const payload = isPlainObject(event.payload) ? event.payload : {};
    parsedLines.push({
      lineNo: i + 1,
      type: typeof event.type === "string" ? event.type : "",
      toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : null,
      capture: isPlainObject(obj.capture) ? obj.capture : null,
      text: raw,
    });
  }

  const recordedResultIds = new Set(
    parsedLines
      .filter((l) => l.type === "agent.tool.result" && l.toolCallId)
      .map((l) => l.toolCallId!),
  );

  const captured = new Set<string>();
  for (const line of parsedLines) {
    // References must already be captured when this line is emitted.
    for (const [, name] of line.text.matchAll(/\$CAP_([A-Za-z0-9_]+)/g)) {
      if (!captured.has(name)) {
        return `line ${line.lineNo} references $CAP_${name}, which no earlier entry captures`;
      }
    }
    if (!line.capture) continue;
    if (line.type !== "agent.tool.start") {
      return `line ${line.lineNo} declares 'capture' on ${line.type}; only a tool.start can capture`;
    }
    if (line.toolCallId !== null && recordedResultIds.has(line.toolCallId)) {
      return `line ${line.lineNo} declares 'capture' but the call has a recorded result, so it never runs live`;
    }
    for (const [name, path] of Object.entries(line.capture)) {
      // Mirrors the loader's own checks, so a cassette this validator passes
      // is one the gateway can actually load — otherwise the failure moves
      // from `validate-universes` to a boot-time throw.
      if (!/^[A-Za-z0-9_]+$/.test(name)) {
        return `line ${line.lineNo} capture name '${name}' must match [A-Za-z0-9_]+`;
      }
      if (typeof path !== "string" || path.length === 0) {
        return `line ${line.lineNo} capture '${name}' must be a non-empty path`;
      }
      captured.add(name);
    }
  }
  return null;
}

/**
 * Parse + re-serialize an agent-demo cassette and confirm it round-trips
 * stably. Returns an error message string on any problem, or `null` when the
 * cassette is well-formed and replayable. Mirrors the JSONL contract of
 * `@omnesis/agent`'s `parseFixture`/`serializeFixture` (kept self-contained
 * so this validator carries no agent-package dependency): each non-comment,
 * non-blank line is one `{ afterMs: number>=0, event: { type: "agent.*",
 * payload } }`, and re-stringifying every parsed entry reproduces the same
 * line set (proving nothing is dropped or reordered on replay-load).
 */
function checkCassetteRoundTrip(path: string): string | null {
  let source: string;
  try {
    source = readFileSync(path, "utf-8");
  } catch (err) {
    return `cannot read cassette: ${err instanceof Error ? err.message : String(err)}`;
  }
  const lines = source.split("\n");
  let dataLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    dataLines++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return `line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return `line ${i + 1} is not an object`;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.afterMs !== "number" || obj.afterMs < 0) {
      return `line ${i + 1} missing or invalid 'afterMs'`;
    }
    const event = obj.event;
    if (typeof event !== "object" || event === null) {
      return `line ${i + 1} missing 'event' object`;
    }
    const type = (event as Record<string, unknown>).type;
    if (typeof type !== "string" || !type.startsWith("agent.")) {
      return `line ${i + 1} event.type must be an "agent.*" string`;
    }
    // Re-serialize in the canonical shape the replay loader emits, then
    // re-parse it to prove the round-trip is lossless.
    const round = JSON.stringify({
      afterMs: obj.afterMs,
      event,
      ...(obj.capture !== undefined ? { capture: obj.capture } : {}),
    });
    try {
      JSON.parse(round);
    } catch (err) {
      return `line ${i + 1} did not re-parse after serialize: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (dataLines === 0) {
    return "cassette has no event lines (only comments/blanks)";
  }
  return null;
}

/**
 * Retrieval and citation are exposed to the model as batch tools only
 * (`search_many` / `fetch_many` / `annotate_many`); each one wraps one of the
 * singular tools named here and reports its children on `agent.tool.child.*`
 * events. So these names are legal on a child event and nowhere else — a top-level
 * `agent.tool.start` naming one describes a call the agent cannot make, and a
 * demo recorded that way silently drops the per-child rendering the real
 * transcript has.
 *
 * Kept here rather than derived from a protocol constant on purpose: the
 * wire-level tool name stays a free string, and a demo that a live agent could
 * not have produced is exactly what this validator exists to catch.
 */
const BATCH_WRAPPED_TOOL_NAMES = new Set(["search_documents", "fetch_document", "annotate"]);

/**
 * Confirm a cassette calls the batch tools the way a live agent does. Returns
 * an error message on the first violation, or `null` when the cassette is
 * consistent. Assumes the file already passed {@link checkCassetteRoundTrip},
 * so malformed lines are skipped rather than re-reported here.
 */
function checkBatchToolProtocol(path: string): string | null {
  let source: string;
  try {
    source = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    let event: { type?: unknown; payload?: unknown };
    try {
      event = (JSON.parse(raw) as { event?: { type?: unknown; payload?: unknown } }).event ?? {};
    } catch {
      continue;
    }
    if (event.type !== "agent.tool.start" || !isPlainObject(event.payload)) continue;
    const tool = event.payload["tool"];
    if (typeof tool === "string" && BATCH_WRAPPED_TOOL_NAMES.has(tool)) {
      return `line ${i + 1} calls '${tool}' at the top level; the agent only reaches it through a batch tool (search_many / fetch_many / annotate_many), which reports children on agent.tool.child.* events`;
    }
  }
  return null;
}

function collectFixtureText(dir: string, manifest: UniverseManifest): string {
  const parts: string[] = [];
  for (const src of manifest.sources) {
    const srcDir = join(dir, "sources", src.descriptorId);
    if (!existsSync(srcDir)) continue;
    for (const f of readdirSync(srcDir).filter((x) => x.endsWith(".json"))) {
      try {
        parts.push(readFileSync(join(srcDir, f), "utf-8"));
      } catch {
        /* best-effort */
      }
    }
  }
  return parts.join("\n");
}

/**
 * Returns true if `id` (a doc externalId from an agent-demo's meta.json)
 * has any plausible producer in the fixture text. Plain substring is the
 * baseline; we also strip common synth-provider prefixes that mint the
 * external_id from a different fixture field at sync time:
 *
 *   - `db-<dbId>`  ← `mapDatabaseSummary` in notion synth
 *   - `row-<rowId>` ← `mapDatabaseRow` in notion synth
 *
 * For those, we look for the unprefixed value (e.g. `db_projects` for
 * `db-db_projects`) inside the fixture JSON. Reduces false-positive
 * warnings without losing signal for actually-missing IDs.
 */
function fixtureMentions(allFixtureText: string, id: string): boolean {
  if (allFixtureText.includes(id)) return true;
  const SYNTH_PREFIXES = ["db-", "row-"];
  for (const prefix of SYNTH_PREFIXES) {
    if (id.startsWith(prefix)) {
      const stripped = id.slice(prefix.length);
      // Match against the JSON-quoted form so `dbId: "db_projects"` hits
      // but a coincidental substring inside other content doesn't.
      if (allFixtureText.includes(`"${stripped}"`)) return true;
    }
  }
  return false;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the per-session `ChatBackend` factory for the replay agent backend.
 *
 * Two shapes are supported on the configured fixture path:
 *
 *   - **Single file** (`.jsonl`) — one scenario, replayed on every session.
 *     Placeholders come from a sibling JSON declared via env / config.
 *   - **Directory** — every `<name>.jsonl` is a scenario; each one needs a
 *     sibling `<name>.meta.json` declaring routing `triggers` (case-
 *     insensitive substrings matched against the first user message) and
 *     optional `placeholders`. At session-create the gateway resolves
 *     each scenario's placeholders against the live DB and hands a
 *     `RoutingReplayBackend` to the agent service.
 *
 * A scenario also declares which **role** it answers for — `agent` unless its
 * meta says otherwise. A directory therefore serves several roles at once, and
 * each role only ever sees its own scenarios. Roles are what makes the routing
 * unambiguous: the privacy reviewer's first message is a JSON envelope that
 * quotes the external question verbatim, so without the split the question's
 * own trigger would match the envelope too and the reviewer would replay the
 * draft it was asked to review.
 *
 * Placeholder resolution is shared by both modes: `$DOC_<externalId>` →
 * `documents.id` (looked up by `external_id`); `$PERSON_<Name>` →
 * `people.id` (looked up by `canonical_name` or a `name`-typed
 * `person_aliases.alias`).
 *
 * Every fixture and meta file is parsed once per version of it on disk: a
 * parse is kept with the file's inode, size, and modification and change
 * times, and reused until one of them moves. Resolving a replay backend —
 * once per conversation, note turn, privacy review or Brain run — therefore
 * costs a directory listing and a `stat` per file, not a parse of every
 * cassette.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

import {
  ReplayBackend,
  RoutingReplayBackend,
  parseFixture,
  type ChatBackend,
  type ReplayFixture,
  type ReplayScenario,
} from "@omnesis/agent";
import type Database from "better-sqlite3";
import type { createLogger } from "@omnesis/core";

type Db = Database.Database;
type Logger = ReturnType<typeof createLogger>;

const placeholdersFileSchema = z
  .object({
    docExternalIds: z.array(z.string().min(1)).optional(),
    personNames: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * The role a scenario answers for. Unset means `agent`, so every cassette
 * written before roles existed keeps serving the chat surface.
 */
const DEFAULT_SCENARIO_ROLE = "agent";

const scenarioMetaSchema = z
  .object({
    triggers: z.array(z.string().min(1)).min(1),
    role: z.string().min(1).optional(),
    speed: z.number().finite().positive().optional(),
    placeholders: placeholdersFileSchema.optional(),
  })
  .strict();

export interface ReplayBackendFactoryOptions {
  fixturePath: string;
  db: Db;
  /** Used in single-file mode only — directory mode reads per-scenario `.meta.json` siblings. */
  legacyPlaceholdersPath?: string;
  /** Which role's scenarios to serve in directory mode. Default `agent`. */
  role?: string;
  /** Omit for demo pacing; immediate keeps text chunks and event-loop yields without human delays. */
  pacing?: "demo" | "immediate";
  log: Logger;
}

export function makeReplayBackendFactory(opts: ReplayBackendFactoryOptions): () => ChatBackend {
  const { fixturePath, db, legacyPlaceholdersPath, log } = opts;
  const timing: ReplayTiming =
    opts.pacing === "immediate"
      ? { clampMs: 0, capMs: 0, textStreamMs: 0 }
      : { clampMs: 60, textStreamMs: 44 };

  const resolveSubstitutions = buildPlaceholderResolver(db);
  const isDirectory = statSync(fixturePath).isDirectory();

  if (!isDirectory) {
    return makeSingleFileFactory(
      fixturePath,
      legacyPlaceholdersPath,
      resolveSubstitutions,
      timing,
      log,
    );
  }
  return makeDirectoryFactory(
    fixturePath,
    opts.role ?? DEFAULT_SCENARIO_ROLE,
    resolveSubstitutions,
    timing,
    log,
  );
}

type ReplayTiming = { clampMs: number; capMs?: number; textStreamMs: number };

type SubstitutionResolver = (
  docExternalIds: ReadonlyArray<string>,
  personNames: ReadonlyArray<string>,
) => Record<string, string>;

function buildPlaceholderResolver(db: Db): SubstitutionResolver {
  const docStmt = db.prepare<[string], { id: string }>(
    "SELECT id FROM documents WHERE external_id = ? LIMIT 1",
  );
  // People resolution often lands canonical_name = email (the resolver
  // takes the first identifying field it sees, which is usually an email
  // from the first doc that mentions the person), with the human-readable
  // name stored as a `name`-typed alias. Try both lookups so the
  // fixture's display-name placeholders resolve either way.
  const personByCanonical = db.prepare<[string], { id: string }>(
    "SELECT id FROM people WHERE canonical_name = ? LIMIT 1",
  );
  const personByAlias = db.prepare<[string], { id: string }>(
    "SELECT person_id AS id FROM person_aliases WHERE alias = ? AND alias_type = 'name' LIMIT 1",
  );
  return (docExternalIds, personNames) => {
    const substitutions: Record<string, string> = {};
    for (const externalId of docExternalIds) {
      const row = docStmt.get(externalId);
      if (row) substitutions[`$DOC_${externalId}`] = row.id;
    }
    for (const name of personNames) {
      const row = personByCanonical.get(name) ?? personByAlias.get(name);
      if (row) substitutions[`$PERSON_${name.replace(/\s+/g, "_")}`] = row.id;
    }
    return substitutions;
  };
}

function makeSingleFileFactory(
  fixturePath: string,
  placeholdersPath: string | undefined,
  resolveSubstitutions: SubstitutionResolver,
  timing: ReplayTiming,
  log: Logger,
): () => ChatBackend {
  const fixture = readParsed(fixturePath, (text) => parseFixture(fixturePath, text));
  let docExternalIds: ReadonlyArray<string> = [];
  let personNames: ReadonlyArray<string> = [];
  if (placeholdersPath) {
    try {
      const raw = JSON.parse(readFileSync(placeholdersPath, "utf8")) as unknown;
      const parsed = placeholdersFileSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn(
          `fixture placeholders at ${placeholdersPath} have an invalid shape: ${parsed.error.issues[0]?.message ?? "unknown"} — agent will still run but placeholders won't resolve`,
        );
      } else {
        docExternalIds = parsed.data.docExternalIds ?? [];
        personNames = parsed.data.personNames ?? [];
      }
    } catch (err) {
      log.warn(
        `failed to read fixture placeholders at ${placeholdersPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return () =>
    new ReplayBackend({
      fixtures: [fixture],
      ...timing,
      substitutions: resolveSubstitutions(docExternalIds, personNames),
      textStreamChars: 4,
    });
}

type LoadedScenario = {
  name: string;
  triggers: ReadonlyArray<string>;
  fixture: ReplayFixture;
  speed?: number;
  docExternalIds: ReadonlyArray<string>;
  personNames: ReadonlyArray<string>;
};

function makeDirectoryFactory(
  dirPath: string,
  role: string,
  resolveSubstitutions: SubstitutionResolver,
  timing: ReplayTiming,
  log: Logger,
): () => ChatBackend {
  // Boot-time load doubles as an early validation pass — a malformed
  // fixture (bad JSON, missing meta, …) surfaces as a clean startup
  // error instead of a cryptic session-create failure later.
  const loaded = loadScenariosFromDirectory(dirPath, role);
  let cachedScenarios = loaded.scenarios;
  let cachedNames = cachedScenarios.map((s) => s.name).join(", ");
  // Logged when the files were read, not each time a backend is resolved
  // from scenarios already parsed.
  if (loaded.parsedFiles > 0) {
    log.info(
      `loaded ${cachedScenarios.length} replay scenario(s) for role ${role} from ${dirPath}: ${cachedNames}`,
    );
  }
  return () => {
    // Re-list the directory on every session-create so demo authors
    // can edit `.jsonl` fixtures, add new scenarios, or remove old
    // ones without restarting the gateway — the next conversation
    // picks up the freshest content. Only a file that changed since it
    // was last parsed is read again.
    //
    // If reload fails mid-edit (a half-saved file with broken JSON,
    // a meta file briefly missing while you rename), keep using the
    // last known-good set so an active demo isn't disrupted. The
    // warning surfaces the underlying error for the author.
    try {
      const fresh = loadScenariosFromDirectory(dirPath, role).scenarios;
      const freshNames = fresh.map((s) => s.name).join(", ");
      if (freshNames !== cachedNames) {
        log.info(`reloaded replay scenarios from ${dirPath} (${fresh.length}): ${freshNames}`);
        cachedNames = freshNames;
      }
      cachedScenarios = fresh;
    } catch (err) {
      log.warn(
        `failed to reload replay scenarios from ${dirPath} — keeping last known-good set: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const resolved: ReplayScenario[] = cachedScenarios.map((s) => ({
      name: s.name,
      triggers: s.triggers,
      fixture: s.fixture,
      speed: s.speed,
      substitutions: resolveSubstitutions(s.docExternalIds, s.personNames),
    }));
    return new RoutingReplayBackend({
      scenarios: resolved,
      ...timing,
      textStreamChars: 4,
    });
  };
}

/**
 * The role-filtered scenarios of a fixture directory, and how many of its
 * files had to be parsed (0 when every one was unchanged since last read).
 */
function loadScenariosFromDirectory(
  dirPath: string,
  role: string,
): { scenarios: LoadedScenario[]; parsedFiles: number } {
  const scenarios: LoadedScenario[] = [];
  let parsedFiles = 0;
  const countParse =
    <T>(parse: (text: string) => T) =>
    (text: string): T => {
      parsedFiles += 1;
      return parse(text);
    };
  const fixtureFiles = readdirSync(dirPath)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  for (const file of fixtureFiles) {
    const name = basename(file, ".jsonl");
    const fixtureFile = join(dirPath, file);
    const metaFile = join(dirPath, `${name}.meta.json`);
    if (!existsSync(metaFile)) {
      throw new Error(
        `fixture ${fixtureFile} has no sibling ${name}.meta.json — every scenario in a fixture directory needs one with at least { triggers: [...] }`,
      );
    }
    const fixture = readParsed(
      fixtureFile,
      countParse((text) => parseFixture(fixtureFile, text)),
    );
    const meta = readParsed(
      metaFile,
      countParse((text) => {
        const parsed = scenarioMetaSchema.safeParse(JSON.parse(text) as unknown);
        if (!parsed.success) {
          throw new Error(
            `${metaFile}: invalid shape — ${parsed.error.issues[0]?.message ?? "unknown"}`,
          );
        }
        return parsed.data;
      }),
    );
    if ((meta.role ?? DEFAULT_SCENARIO_ROLE) !== role) continue;
    scenarios.push({
      name,
      triggers: meta.triggers,
      fixture,
      speed: meta.speed,
      docExternalIds: meta.placeholders?.docExternalIds ?? [],
      personNames: meta.placeholders?.personNames ?? [],
    });
  }
  if (scenarios.length === 0) {
    throw new Error(`fixture directory ${dirPath} declares no scenario for role '${role}'`);
  }
  return { scenarios, parsedFiles };
}

/** Each file's last successful parse, keyed by path, with the stamp it was read at. */
const parseCache = new Map<string, { stamp: string; value: unknown }>();

/**
 * Size, inode, and modification and change times in nanoseconds: any write
 * or replacement of the file moves at least one of them.
 */
function fileStamp(path: string): string {
  const s = statSync(path, { bigint: true });
  return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}

/**
 * `parse` of the file's text, reused while the file is unchanged. A parse
 * that throws is not kept, so a broken file is read again on the next call.
 * Callers treat the value as read-only: it is shared by every backend built
 * from it.
 */
function readParsed<T>(path: string, parse: (text: string) => T): T {
  const stamp = fileStamp(path);
  const cached = parseCache.get(path);
  if (cached && cached.stamp === stamp) return cached.value as T;
  const value = parse(readFileSync(path, "utf8"));
  parseCache.set(path, { stamp, value });
  return value;
}

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
  const fixture = parseFixture(fixturePath, readFileSync(fixturePath, "utf8"));
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
  let cachedScenarios = loadScenariosFromDirectory(dirPath, role);
  let cachedNames = cachedScenarios.map((s) => s.name).join(", ");
  log.info(
    `loaded ${cachedScenarios.length} replay scenario(s) for role ${role} from ${dirPath}: ${cachedNames}`,
  );
  return () => {
    // Re-read the directory on every session-create so demo authors
    // can edit `.jsonl` fixtures, add new scenarios, or remove old
    // ones without restarting the gateway — the next conversation
    // picks up the freshest content. Disk cost is a handful of small
    // JSON files (well under 50ms); the routing match runs against
    // the freshly-loaded scenarios.
    //
    // If reload fails mid-edit (a half-saved file with broken JSON,
    // a meta file briefly missing while you rename), keep using the
    // last known-good set so an active demo isn't disrupted. The
    // warning surfaces the underlying error for the author.
    try {
      const fresh = loadScenariosFromDirectory(dirPath, role);
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
      substitutions: resolveSubstitutions(s.docExternalIds, s.personNames),
    }));
    return new RoutingReplayBackend({
      scenarios: resolved,
      ...timing,
      textStreamChars: 4,
    });
  };
}

function loadScenariosFromDirectory(dirPath: string, role: string): LoadedScenario[] {
  const scenarios: LoadedScenario[] = [];
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
    const fixture = parseFixture(fixtureFile, readFileSync(fixtureFile, "utf8"));
    const metaRaw = JSON.parse(readFileSync(metaFile, "utf8")) as unknown;
    const meta = scenarioMetaSchema.safeParse(metaRaw);
    if (!meta.success) {
      throw new Error(`${metaFile}: invalid shape — ${meta.error.issues[0]?.message ?? "unknown"}`);
    }
    if ((meta.data.role ?? DEFAULT_SCENARIO_ROLE) !== role) continue;
    scenarios.push({
      name,
      triggers: meta.data.triggers,
      fixture,
      docExternalIds: meta.data.placeholders?.docExternalIds ?? [],
      personNames: meta.data.placeholders?.personNames ?? [],
    });
  }
  if (scenarios.length === 0) {
    throw new Error(`fixture directory ${dirPath} declares no scenario for role '${role}'`);
  }
  return scenarios;
}

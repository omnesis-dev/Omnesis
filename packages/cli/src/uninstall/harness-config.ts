// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The surgical reverse of what `omnesis connect` writes into a harness's own
 * configuration. Each function takes the file's text and returns the text with
 * only the Omnesis keys gone, or the same string when there was nothing of
 * Omnesis in it — so a caller writes a file only when it actually changes, and
 * every setting the operator made themselves survives.
 */

import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { retireLegacyOpenClawConfig, upsertEnvLines } from "../commands/connect.js";

/** The plugin id the integration registers with both harnesses. */
export const INTEGRATION_PLUGIN_ID = "omnesis-integration";
/** The plugin id releases before the integration package used. */
export const LEGACY_PLUGIN_ID = "omnesis-bridge";
/** The skill directory name `connect` installs. */
export const SKILL_NAME = "omnesis";

/**
 * Every key `connect` sets in a harness's `.env`, or scrubs there as a legacy
 * spelling. None of them means anything once the integration is gone.
 */
export const HARNESS_ENV_KEYS = [
  "OMNESIS_AGENT_HARNESS",
  "OMNESIS_INTEGRATION_CREDENTIALS",
  "OMNESIS_HERMES_OWNER_IDS",
  "OMNESIS_GATEWAY_URL",
  "OMNESIS_TOKEN",
] as const;

const PLUGIN_IDS: ReadonlySet<string> = new Set([INTEGRATION_PLUGIN_ID, LEGACY_PLUGIN_ID]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Delete `parent[key]` when it is an object left with nothing in it. */
function dropIfEmpty(parent: Record<string, unknown>, key: string): void {
  const child = parent[key];
  if (isPlainObject(child) && Object.keys(child).length === 0) delete parent[key];
}

/**
 * `openclaw.json` without the Omnesis skill entry, the integration's plugin
 * entry and its allow/deny listings, and the legacy bridge's references.
 * Throws when the file is not a JSON object, as `connect` does.
 */
export function stripOpenClawConfig(configText: string): string {
  const retired = retireLegacyOpenClawConfig(configText);
  if (retired.trim() === "") return configText;
  const config = JSON.parse(retired) as Record<string, unknown>;
  let changed = retired !== configText;

  const skills = config.skills;
  if (isPlainObject(skills) && isPlainObject(skills.entries)) {
    if (Object.hasOwn(skills.entries, SKILL_NAME)) {
      delete skills.entries[SKILL_NAME];
      dropIfEmpty(skills, "entries");
      dropIfEmpty(config, "skills");
      changed = true;
    }
  }

  const plugins = config.plugins;
  if (isPlainObject(plugins)) {
    if (isPlainObject(plugins.entries) && Object.hasOwn(plugins.entries, INTEGRATION_PLUGIN_ID)) {
      delete plugins.entries[INTEGRATION_PLUGIN_ID];
      dropIfEmpty(plugins, "entries");
      changed = true;
    }
    for (const list of ["allow", "deny"] as const) {
      const ids = plugins[list];
      if (!Array.isArray(ids)) continue;
      const kept = ids.filter((id) => typeof id !== "string" || !PLUGIN_IDS.has(id));
      if (kept.length !== ids.length) {
        plugins[list] = kept;
        changed = true;
      }
    }
    if (changed) {
      dropIfEmpty(plugins, "entries");
      dropIfEmpty(config, "plugins");
    }
  }

  return changed ? JSON.stringify(config, null, 2) + "\n" : configText;
}

/**
 * Hermes `config.yaml` without the integration (or the legacy bridge) in
 * `plugins.enabled` / `plugins.disabled`, and without its
 * `plugins.entries.omnesis-integration` settings. Comments and layout of the
 * rest survive. Throws on a file that is not YAML.
 */
export function stripHermesConfig(configText: string): string {
  if (configText.trim() === "") return configText;
  const document = parseDocument(configText);
  if (document.errors.length > 0) throw new Error("config.yaml is not valid YAML");
  let changed = false;
  for (const list of ["enabled", "disabled"]) {
    const ids = document.getIn(["plugins", list], true);
    if (!isSeq(ids)) continue;
    const before = ids.items.length;
    ids.items = ids.items.filter(
      (item) => !(isScalar(item) && typeof item.value === "string" && PLUGIN_IDS.has(item.value)),
    );
    if (ids.items.length !== before) changed = true;
  }
  const entries = document.getIn(["plugins", "entries"], true);
  if (isMap(entries) && entries.has(INTEGRATION_PLUGIN_ID)) {
    entries.delete(INTEGRATION_PLUGIN_ID);
    changed = true;
  }
  return changed ? document.toString() : configText;
}

/** Whether a harness `.env` body carries any key `connect` owns. */
export function harnessEnvHasOmnesisKeys(envText: string): boolean {
  return envText
    .split("\n")
    .some((line) =>
      HARNESS_ENV_KEYS.some((key) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)),
    );
}

/**
 * The harness `.env` without the Omnesis keys, every other line byte-for-byte,
 * or null when nothing else was in it — a file `connect` created for these
 * keys alone is removed rather than left empty.
 */
export function stripHarnessEnv(envText: string): string | null {
  if (!harnessEnvHasOmnesisKeys(envText)) return envText;
  const stripped = upsertEnvLines(envText, {}, HARNESS_ENV_KEYS);
  return stripped.trim() === "" ? null : stripped;
}

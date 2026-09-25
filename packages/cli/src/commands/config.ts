// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineCommand } from "citty";
import { SOURCE_SETTINGS_KEYS } from "@omnesis/config";
import { c, gatewayJson, CliError, EXIT_FAILURE, EXIT_USER_ERROR } from "../utils.js";
import {
  FileConfigTarget,
  resolveConfigTarget,
  type ConfigMutation,
  type ConfigTarget,
} from "./config-target.js";

// Per-source knobs that are inert for a push-based source (one hosted on a
// phone app — its data is uploaded, not pulled by a collector sync loop):
// no sync timer, no document/attachment pipeline. `params` is excluded — it
// can still carry source-specific config. Mirrors the portal Config form gate.
const INERT_PUSH_SOURCE_KNOBS = new Set<string>(SOURCE_SETTINGS_KEYS.filter((k) => k !== "params"));

/**
 * Parse a user-typed path into an array of segments. Two shapes accepted:
 *   - JSON Pointer: `/sources/gmail:jamesbond@gmail.com/syncInterval`
 *     (RFC 6901 — segments can contain dots; `~0`/`~1` escape for `~`/`/`).
 *   - Dot-path shorthand: `inference.assignments.embedder` → `["inference","assignments","embedder"]`
 *
 * For keys that genuinely contain dots (source IDs with email TLDs), the
 * dot-path shorthand gets ambiguous — use the pointer form. Both forms are
 * documented in the usage help.
 */
export function parseConfigPath(input: string): string[] {
  if (input === "" || input === "/") return [];
  if (input.startsWith("/")) {
    return input
      .slice(1)
      .split("/")
      .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  // Dot-path shorthand.
  return input.split(".").filter((s) => s.length > 0);
}

/**
 * Build a minimal object that, read at the given segments, holds `value`.
 * `{a,b,c}` + 42 → `{ a: { b: { c: 42 } } }`. `null` is preserved (RFC 7396
 * merge-patch uses null to mean "delete this key"). Empty segments return the
 * value as-is.
 */
export function buildNestedPatch(segments: readonly string[], value: unknown): unknown {
  if (segments.length === 0) return value;
  const out: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = out;
  for (let i = 0; i < segments.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cursor[segments[i]] = next;
    cursor = next;
  }
  cursor[segments[segments.length - 1]] = value;
  return out;
}

/**
 * Navigate a parsed config object to the sub-tree at the given path. Returns
 * `undefined` if any segment is missing.
 */
export function navigate(config: unknown, segments: readonly string[]): unknown {
  let cursor: unknown = config;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/**
 * Coerce a raw CLI argument into the value we'll drop into a merge patch.
 * Strategy (in order):
 *   - `null` → null (delete semantics in RFC 7396)
 *   - `true` / `false` → boolean
 *   - leading `[` or `{` → JSON parse (arrays / nested objects)
 *   - all-digits / decimal → number
 *   - anything else → string (unquoted)
 *
 * Users can always force a string literal with wrapping quotes: `'"5m"'`.
 */
export function coerceValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "") return "";
  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through */
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
  }
  return raw;
}

/**
 * Compose the comment-block header inserted at the top of the editor scratch
 * file when another process changed the config under us. Exported for the
 * unit test that pins the wording.
 */
export function buildVersionConflictHeader(wasVersion: number, nowVersion: number): string {
  return [
    "// ERROR: another process changed the config while you were editing",
    `//        (was version ${wasVersion}, now ${nowVersion}). The file has`,
    "//        been reloaded with the latest contents — review and re-save",
    "//        to apply your edit on top, or exit without saving to abort.",
  ].join("\n");
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function printValidationErrors(failure: Extract<ConfigMutation, { ok: false }>): void {
  console.error(`${c.red}${failure.error}${c.reset}`);
  if (failure.errors) {
    for (const e of failure.errors) {
      console.error(`  ${c.dim}${e.path || "/"}${c.reset}  ${e.message}`);
    }
  }
}

/** Tell the operator a command worked on the file because the gateway is stopped. */
function noteFileTarget(target: ConfigTarget, message: (path: string) => string): void {
  if (target instanceof FileConfigTarget) {
    console.error(`${c.yellow}${message(target.path)}${c.reset}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-commands
// ────────────────────────────────────────────────────────────────────────────

async function configGet(target: ConfigTarget, pathArg?: string): Promise<void> {
  const { config, version } = await target.load();
  const segments = pathArg ? parseConfigPath(pathArg) : [];
  const value = navigate(config, segments);
  if (value === undefined) {
    throw new CliError(`${c.red}No value at ${pathArg ?? "/"}${c.reset}`, EXIT_USER_ERROR);
  }
  print(value);
  if (target.kind === "gateway") console.error(`${c.dim}(version ${version})${c.reset}`);
  noteFileTarget(target, (path) => `The gateway is not running — read from ${path}.`);
}

/**
 * If `segments` target a per-source ingestion knob that is inert for a
 * push-based source, return the knob name; otherwise null. Pure path-shape
 * check (the push-based lookup happens separately). Exported for testing.
 */
export function inertSourceKnobAt(segments: readonly string[]): string | null {
  if (segments[0] !== "sources" || segments.length < 3) return null;
  const knob = segments[2];
  return INERT_PUSH_SOURCE_KNOBS.has(knob) ? knob : null;
}

/**
 * Warn (don't block) when setting a per-source ingestion knob that has no
 * effect because the source is push-based. The gateway reports `pushBased`
 * per source on GET /admin/sources; we read it generically rather than
 * naming any specific source. Best-effort — if the lookup fails we stay
 * silent and let the patch proceed.
 */
async function warnIfInertSourceKnob(segments: readonly string[]): Promise<void> {
  const knob = inertSourceKnobAt(segments);
  if (!knob) return;
  const sourceId = segments[1];
  try {
    const res = await gatewayJson<{ items?: Array<{ id: string; pushBased?: boolean }> }>(
      "/admin/sources",
    );
    const pushBased = (res.items ?? []).some((s) => s.id === sourceId && s.pushBased === true);
    if (pushBased) {
      console.error(
        `${c.yellow}note: '${knob}' has no effect for ${sourceId} — it is push-based (its device uploads the data; no collector sync loop or document/attachment pipeline).${c.reset}`,
      );
    }
  } catch {
    /* best-effort warning — proceed without it */
  }
}

async function configSet(target: ConfigTarget, pathArg: string, rawValue: string): Promise<void> {
  const segments = parseConfigPath(pathArg);
  if (segments.length === 0) {
    throw new CliError(
      `${c.red}Path required.${c.reset} Use '/' as the root only when replacing wholesale (use 'config edit' for that).`,
      EXIT_USER_ERROR,
    );
  }
  if (target.kind === "gateway") await warnIfInertSourceKnob(segments);
  const value = coerceValue(rawValue);
  const patch = buildNestedPatch(segments, value);
  const res = await target.patch(patch);
  if (!res.ok) {
    printValidationErrors(res);
    throw new CliError("", EXIT_FAILURE);
  }
  if (res.changedPaths.length === 0) {
    console.log(`${c.dim}No change (value already matched).${c.reset}`);
    noteFileTarget(target, (path) => `The gateway is not running — ${path} was left as it was.`);
    return;
  }
  console.log(`${c.green}Updated.${c.reset} Changed:`);
  for (const p of res.changedPaths) {
    console.log(`  ${c.dim}${p}${c.reset}`);
  }
  if (target.kind === "gateway") console.error(`${c.dim}(version ${res.version})${c.reset}`);
  noteFileTarget(
    target,
    (path) => `The gateway is not running — wrote ${path}. The change applies when it starts.`,
  );
}

async function configEdit(target: ConfigTarget): Promise<void> {
  const editor = process.env.EDITOR || process.env.VISUAL || "nano";
  noteFileTarget(target, (path) => `The gateway is not running — editing ${path} directly.`);
  const initial = await target.loadRaw();
  // Capture the version at fetch time so we can detect a concurrent
  // mutation from another process before we PUT. If a peer
  // updates the config while the user is in $EDITOR, blindly PUTting would
  // overwrite that change without warning.
  let editStartVersion = await target.version();
  const scratchDir = mkdtempSync(join(tmpdir(), "omnesis-config-edit-"));
  const scratchPath = join(scratchDir, "omnesis.json");
  writeFileSync(scratchPath, initial);
  let lastErrorHeader = "";

  while (true) {
    // Prepend any previous validation error to the top of the file (as a
    // comment block in a JSON-with-comments tradition) so the user sees it
    // right where they're editing.
    if (lastErrorHeader) {
      const prefix = lastErrorHeader + "\n";
      writeFileSync(
        scratchPath,
        prefix + readFileSync(scratchPath, "utf-8").replace(/^\/\/[^\n]*\n(\/\/[^\n]*\n)*/, ""),
      );
    }
    const mtimeBefore = statSync(scratchPath).mtimeMs;
    await runInteractive(editor, [scratchPath]);
    const mtimeAfter = statSync(scratchPath).mtimeMs;

    if (mtimeAfter === mtimeBefore) {
      console.log(`${c.dim}No changes saved. Aborted.${c.reset}`);
      return;
    }

    // Strip any leading // comment lines (our injected error prelude).
    const content = readFileSync(scratchPath, "utf-8").replace(/^\/\/[^\n]*\n(\/\/[^\n]*\n)*/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      lastErrorHeader = `// ERROR: not valid JSON — ${err instanceof Error ? err.message : String(err)}\n// Fix the file and save to retry, or exit the editor without saving to abort.`;
      console.error(`${c.red}Invalid JSON — reopening.${c.reset}`);
      continue;
    }

    // Re-check the version right before PUT. If it moved,
    // someone else changed the file under us — reload the latest contents
    // into the scratch file with a header explaining the conflict and let
    // the user re-merge their edit on top.
    const currentVersion = await target.version();
    if (currentVersion !== editStartVersion) {
      const wasVersion = editStartVersion;
      const conflictHeader = buildVersionConflictHeader(wasVersion, currentVersion);
      const fresh = await target.loadRaw();
      writeFileSync(scratchPath, conflictHeader + "\n" + fresh);
      editStartVersion = currentVersion;
      // Suppress the validation-error prelude — the conflict header is now
      // the active prelude. (Don't double-stack comment blocks.)
      lastErrorHeader = "";
      console.error(
        `${c.yellow}Config was changed by another process (was version ${wasVersion}, now ${currentVersion}) — reloaded; re-save to apply your edit on top.${c.reset}`,
      );
      continue;
    }

    const res = await target.replace(parsed);
    if (res.ok) {
      if (res.changedPaths.length === 0) {
        console.log(`${c.dim}No change.${c.reset}`);
      } else {
        console.log(
          `${c.green}Applied.${c.reset} Changed ${res.changedPaths.length} path${res.changedPaths.length === 1 ? "" : "s"}:`,
        );
        for (const p of res.changedPaths) console.log(`  ${c.dim}${p}${c.reset}`);
        noteFileTarget(target, () => "The change applies when the gateway starts.");
      }
      return;
    }

    const errors = (res.errors ?? []).map((e) => `//   ${e.path || "/"}: ${e.message}`).join("\n");
    lastErrorHeader = `// ERROR: validation failed (saving again will retry):\n${errors}`;
    // The successful PUT path bumps the version on the gateway side; on a
    // failure (no write) the version doesn't move, so editStartVersion
    // stays correct for the next loop iteration.
    console.error(`${c.red}Validation failed — reopening.${c.reset}`);
    for (const e of res.errors ?? []) {
      console.error(`  ${c.dim}${e.path || "/"}${c.reset}  ${e.message}`);
    }
  }
}

async function configLs(target: ConfigTarget): Promise<void> {
  const { config } = await target.load();
  noteFileTarget(target, (path) => `The gateway is not running — read from ${path}.`);
  if (Object.keys(config).length === 0) {
    console.log(`${c.dim}Config is empty — every value is at its code default.${c.reset}`);
    return;
  }
  console.log(`${c.bold}Explicitly set in omnesis.json:${c.reset}`);
  // Simple tree walk, one line per leaf. Paths are JSON Pointer form so the
  // output is copy-paste-compatible with `config get` / `config set`.
  walkAndPrint(config, []);
}

function walkAndPrint(value: unknown, prefix: string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const path = "/" + prefix.map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
    console.log(`  ${c.dim}${path}${c.reset}  ${JSON.stringify(value)}`);
    return;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    const path = "/" + prefix.map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
    console.log(`  ${c.dim}${path}${c.reset}  {}`);
    return;
  }
  for (const k of keys) walkAndPrint(obj[k], [...prefix, k]);
}

function runInteractive(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0 || code === null ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
    child.on("error", reject);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Citty command tree
// ────────────────────────────────────────────────────────────────────────────

const configGetCommand = defineCommand({
  meta: {
    name: "get",
    description: "Print the config (or a sub-tree at <path>)",
  },
  args: {
    path: {
      type: "positional",
      description:
        "JSON Pointer (e.g. /inference/assignments/embedder) or dot-path (e.g. inference.assignments.embedder)",
      required: false,
    },
  },
  async run(ctx) {
    const pathArg = ctx.args.path;
    await configGet(await resolveConfigTarget(), typeof pathArg === "string" ? pathArg : undefined);
  },
});

const configSetCommand = defineCommand({
  meta: {
    name: "set",
    description: "Mutate a single value (path = JSON pointer or dot-path)",
  },
  args: {
    path: {
      type: "positional",
      description: "JSON Pointer (e.g. /sources/default/syncInterval) or dot-path",
      required: true,
    },
    value: {
      type: "positional",
      description: "Value (booleans, null, numbers, [...] / {...} parsed; everything else string)",
      required: true,
    },
  },
  async run(ctx) {
    const pathArg = ctx.args.path;
    const value = ctx.args.value;
    if (!pathArg || value === undefined) {
      throw new CliError(
        `${c.red}Usage: omnesis config set <path> <value>${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    await configSet(await resolveConfigTarget(), pathArg, String(value));
  },
});

const configEditCommand = defineCommand({
  meta: {
    name: "edit",
    description:
      "Open omnesis.json in $EDITOR; saves go through schema validation (works on the file while this machine's gateway is stopped)",
  },
  async run() {
    await configEdit(await resolveConfigTarget());
  },
});

const configLsCommand = defineCommand({
  meta: {
    name: "ls",
    description: "List every value explicitly set in the file (one path per line)",
  },
  async run() {
    await configLs(await resolveConfigTarget());
  },
});

export const configCommand = defineCommand({
  meta: {
    name: "config",
    description: "View and edit the gateway's omnesis.json config",
  },
  subCommands: {
    get: configGetCommand,
    set: configSetCommand,
    edit: configEditCommand,
    ls: configLsCommand,
  },
  // Default to `get` (whole tree) when no subcommand is given. The legacy
  // help text printed usage; citty's auto-help on `--help` now does that.
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(configGetCommand, { rawArgs: [] });
    }
  },
});

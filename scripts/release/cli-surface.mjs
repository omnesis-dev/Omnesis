#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The command-line surface of one Omnesis tree: every command path the `omnesis`
 * CLI dispatches, with the flags each declares, its positional arguments and
 * its subcommands.
 *
 *   node scripts/release/cli-surface.mjs [--tree <checkout>] [--write <file>]
 *   node scripts/release/cli-surface.mjs --tree <checkout> --check <file>
 *
 * The tree is read through its own command definitions — the citty tree in
 * `packages/cli/src/subcommands.ts`, which loads without running the CLI — so
 * the surface is the one that tree's CLI enforces, not one inferred from help
 * text. The tree needs its dependencies installed (`npm ci --ignore-scripts`
 * is enough: nothing native is loaded by defining a command).
 *
 * `released-cli-surface.json` beside this script is that surface for the
 * newest release. The installer served from `main` installs that release, so
 * `installer-cli-contract.mjs` checks every CLI call the installer makes
 * against it. `npm run release -- version` rewrites it from the release tree,
 * and the tag preflight refuses a release whose file is not its own surface.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..");
export const RELEASED_SURFACE_FILE = join(here, "released-cli-surface.json");

async function resolveEntry(entry) {
  const value = typeof entry === "function" ? await entry() : await entry;
  return value;
}

async function resolveField(command, field) {
  const value = command?.[field];
  if (!value) return undefined;
  return typeof value === "function" ? await value() : await value;
}

/**
 * One command's own declarations. Flags keep the spelling and type the
 * command declares; the checker derives the spellings the parser accepts
 * (kebab, camel, `--no-`) the way `packages/cli/src/unknown-flags.ts` does.
 */
async function describe(command) {
  const args = (await resolveField(command, "args")) ?? {};
  const flags = {};
  let positionals = 0;
  for (const [key, def] of Object.entries(args)) {
    const type = def?.type ?? "boolean";
    if (type === "positional") {
      positionals += 1;
      continue;
    }
    const alias = def?.alias;
    const aliases = typeof alias === "string" ? [alias] : Array.isArray(alias) ? alias : [];
    flags[key] = aliases.length ? { type, alias: aliases } : { type };
  }
  const subs = (await resolveField(command, "subCommands")) ?? {};
  return {
    flags,
    positionals,
    subcommands: Object.keys(subs).sort(),
    runs: typeof command?.run === "function",
    subs,
  };
}

/** Walk a citty command tree into `{ "<path>": declarations }`. */
export async function surfaceOfTree(subCommands) {
  const commands = {};
  const seen = new Map();
  commands[""] = {
    flags: {},
    positionals: 0,
    subcommands: Object.keys(subCommands).sort(),
    runs: false,
  };
  const visit = async (path, entry) => {
    const command = await resolveEntry(entry);
    const { subs, ...own } = await describe(command);
    commands[path] = own;
    // An alias (`models` / `model`) is the same object: record it under both
    // names, walk its children under both, but never loop.
    const depth = path.split(" ").length;
    if (depth > 6 || seen.get(command) === path) return;
    seen.set(command, path);
    for (const [name, child] of Object.entries(subs)) await visit(`${path} ${name}`, child);
  };
  for (const [name, entry] of Object.entries(subCommands)) await visit(name, entry);
  return Object.fromEntries(Object.entries(commands).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * The surface of the tree at `treeRoot`, read through that tree's own tsx so
 * its TypeScript sources load as its CLI loads them.
 */
export async function cliSurface(treeRoot = repoRoot) {
  const root = resolve(treeRoot);
  const tsx = createRequire(join(root, "package.json")).resolve("tsx/esm/api");
  const { register } = await import(pathToFileURL(tsx).href);
  const unregister = register();
  try {
    const { SUB_COMMANDS } = await import(
      pathToFileURL(join(root, "packages", "cli", "src", "subcommands.ts")).href
    );
    if (!SUB_COMMANDS || typeof SUB_COMMANDS !== "object") {
      throw new Error(`${root}: packages/cli/src/subcommands.ts exports no SUB_COMMANDS`);
    }
    const version = JSON.parse(
      readFileSync(join(root, "packages", "cli", "package.json"), "utf8"),
    ).version;
    return { version, commands: await surfaceOfTree(SUB_COMMANDS) };
  } finally {
    await unregister?.();
  }
}

/** The file's text: what `--write` stores and `--check` compares. */
export async function formatSurface(surface) {
  const text = `${JSON.stringify(
    {
      $comment:
        "Generated by scripts/release/cli-surface.mjs from the newest release. Do not edit: `npm run release -- version` rewrites it.",
      ...surface,
    },
    null,
    2,
  )}\n`;
  try {
    const prettier = await import("prettier");
    const options = (await prettier.resolveConfig(RELEASED_SURFACE_FILE)) ?? {};
    return await prettier.format(text, { ...options, parser: "json" });
  } catch {
    return text;
  }
}

export function readReleasedSurface(file = RELEASED_SURFACE_FILE) {
  const { $comment: _comment, ...surface } = JSON.parse(readFileSync(file, "utf8"));
  return surface;
}

/** Whether two surfaces declare the same commands, ignoring key order. */
export function sameSurface(a, b) {
  const canonical = (value) =>
    JSON.stringify(value, (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)))
        : v,
    );
  return canonical(a) === canonical(b);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!["--tree", "--write", "--check"].includes(name) || argv[i + 1] === undefined) {
      throw new Error(
        "Usage: cli-surface.mjs [--tree <checkout>] [--write <file> | --check <file>]",
      );
    }
    flags[name.slice(2)] = argv[(i += 1)];
  }
  return flags;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = parseFlags(process.argv.slice(2));
  const surface = await cliSurface(flags.tree ?? repoRoot);
  if (flags.check) {
    const stored = readReleasedSurface(resolve(flags.check));
    if (!sameSurface(stored, surface)) {
      process.stderr.write(
        `${flags.check} is not the CLI surface of ${flags.tree ?? repoRoot} (v${surface.version}; ` +
          `the file says v${stored.version}). Regenerate it: ` +
          `node scripts/release/cli-surface.mjs --write ${flags.check}\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${flags.check} matches the CLI surface of v${surface.version}.\n`);
  } else if (flags.write) {
    writeFileSync(resolve(flags.write), await formatSurface(surface));
    process.stdout.write(
      `Wrote the CLI surface of v${surface.version} (${Object.keys(surface.commands).length} commands) to ${flags.write}\n`,
    );
  } else {
    process.stdout.write(await formatSurface(surface));
  }
  // Command modules may open handles (timers, sockets) at import; the surface
  // is complete, so nothing else is waited for.
  process.exit(0);
}

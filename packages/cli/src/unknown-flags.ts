// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Refuse a flag the command does not have.
 *
 * The parser underneath is deliberately permissive: it is asked to keep
 * arguments it was not told about rather than reject them, so `--from` on a
 * command that has no such flag does not fail — it becomes a truthy key nobody
 * reads, and its VALUE is promoted into the next free positional. A search for
 * a person's documents therefore runs as a free-text search for the person's
 * id, returns a full and confident result set, and exits 0. Nothing in the
 * output is wrong-looking; the constraint simply is not there.
 *
 * That is worse than a crash for a read command whose output people and agents
 * act on, so an unrecognised flag is a usage error here, once, for every
 * command — rather than a check each command would have to remember.
 *
 * Three things the check must not break, all of them real:
 *
 *   - **`--json` is honoured everywhere without being declared.** It is read
 *     straight off argv so that any command can be machine-read, and several
 *     declare no `json` argument at all.
 *   - **A group either dispatches to a child or forwards its own argv to one.**
 *     The flags it accepts are therefore its children's, so a group is checked
 *     against the union.
 *   - **A declared string flag swallows a dash-leading value.** `--limit -5`
 *     passes `-5` as the limit, and that token must not be read as a flag.
 */

import { CliError, EXIT_USER_ERROR } from "@omnesis/cli-shared";
import type { ArgsDef, CommandDef, SubCommandsDef } from "citty";

/**
 * Flags every command answers to, whatever it declares.
 *
 * `--help`/`-h` and `--version`/`-V` are handled before the parser ever runs;
 * `--json` is read from raw argv by the output helpers, so a command that never
 * declared it still honours it.
 */
const UNIVERSAL_FLAGS = ["--help", "-h", "--version", "-V", "--json"];

/**
 * How close a guess has to be to be worth suggesting.
 *
 * Two, not three: at three, `--from` on `search` suggests `--json`, which is
 * not what the caller meant and sends them further from the answer than the
 * list of real options does. A typo is one or two characters; an invented flag
 * is a different word.
 */
const MAX_SUGGESTION_DISTANCE = 2;

interface AcceptedFlags {
  /** Every spelling the command answers to, long and short. */
  readonly names: ReadonlySet<string>;
  /** Long flags that take a value, so the token after one is not a flag. */
  readonly valueTaking: ReadonlySet<string>;
}

/**
 * Refuse the first unrecognised flag in `rawArgs`, or return having found none.
 *
 * Only the first: a caller who mistyped two flags fixes one, re-runs, and is
 * told about the other. Listing both would be tidier and is not worth the
 * chance of burying the one they meant.
 */
export async function assertKnownFlags(root: CommandDef, rawArgs: string[]): Promise<void> {
  const command = await resolveDeepestCommand(root, rawArgs);
  const accepted = await acceptedFlags(command);

  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index]!;
    if (!token.startsWith("-") || token === "-" || token === "--") continue;

    const [name] = splitFlag(token);
    if (accepted.names.has(name)) {
      // A declared value-taking flag written `--limit 5` consumes the next
      // token, which may itself begin with a dash.
      if (!token.includes("=") && accepted.valueTaking.has(name)) index += 1;
      continue;
    }
    throw new CliError(refusal(name, accepted.names), EXIT_USER_ERROR);
  }
}

/** The message a mistyped flag gets, and the only place it is worded. */
function refusal(name: string, accepted: ReadonlySet<string>): string {
  // Negations are accepted but not advertised: `--no-verbose` beside
  // `--verbose` doubles the list without telling the reader anything the
  // positive form did not.
  const longFlags = [...accepted]
    .filter((flag) => flag.startsWith("--") && !flag.startsWith("--no-"))
    .sort();
  const suggestion = nearest(name, longFlags);
  const lines = [`Unknown option: ${name}`];
  if (suggestion) lines.push(`Did you mean ${suggestion}?`);
  // Never empty: every command answers to the universal flags, so a command
  // that declares none of its own still has something true to list.
  lines.push(`Available options: ${longFlags.join(", ")}`);
  return lines.join("\n");
}

/** `--limit=5` → `["--limit", "5"]`; `--limit` → `["--limit"]`. */
function splitFlag(token: string): [string, string | undefined] {
  const eq = token.indexOf("=");
  return eq === -1 ? [token, undefined] : [token.slice(0, eq), token.slice(eq + 1)];
}

/**
 * Every spelling the command answers to.
 *
 * Both the kebab and camel forms of each name, because the parser aliases them
 * to each other, and `--no-<name>` for booleans, which it rewrites to a false
 * value before any command sees it.
 */
async function acceptedFlags(command: CommandDef): Promise<AcceptedFlags> {
  const names = new Set(UNIVERSAL_FLAGS);
  const valueTaking = new Set<string>();

  const collect = (args: ArgsDef | undefined) => {
    for (const [key, def] of Object.entries(args ?? {})) {
      const type = (def as { type?: string }).type;
      if (type === "positional") continue;
      for (const spelling of new Set([key, camelCase(key), kebabCase(key)])) {
        names.add(`--${spelling}`);
        if (type === "boolean" || type === undefined) names.add(`--no-${spelling}`);
        if (type === "string" || type === "enum") valueTaking.add(`--${spelling}`);
      }
      const alias = (def as { alias?: string | string[] }).alias;
      for (const one of typeof alias === "string" ? [alias] : (alias ?? [])) {
        names.add(`-${one}`);
        if (type === "string" || type === "enum") valueTaking.add(`-${one}`);
      }
    }
  };

  collect(await resolveArgs(command));
  // A group node's own argv reaches whichever child runs, so the flags it
  // accepts are its children's.
  for (const child of Object.values((await resolveSubCommands(command)) ?? {})) {
    collect(await resolveArgs(await resolveCommand(child)));
  }
  return { names, valueTaking };
}

/**
 * Walk the leading positional tokens to the command that will actually run.
 *
 * Stops at the first token that is a flag or matches no subcommand, which is
 * how the parser routes too — so the command checked is the command invoked.
 */
async function resolveDeepestCommand(root: CommandDef, rawArgs: string[]): Promise<CommandDef> {
  let current = root;
  for (const token of rawArgs) {
    if (token.startsWith("-")) break;
    const subs = await resolveSubCommands(current);
    const next = subs?.[token];
    if (!next) break;
    current = await resolveCommand(next);
  }
  return current;
}

async function resolveCommand(entry: unknown): Promise<CommandDef> {
  return (
    typeof entry === "function" ? await (entry as () => Promise<CommandDef>)() : await entry
  ) as CommandDef;
}

async function resolveSubCommands(command: CommandDef): Promise<SubCommandsDef | undefined> {
  const subs = command.subCommands;
  if (!subs) return undefined;
  return (
    typeof subs === "function" ? await (subs as () => Promise<SubCommandsDef>)() : await subs
  ) as SubCommandsDef;
}

async function resolveArgs(command: CommandDef): Promise<ArgsDef | undefined> {
  const args = command.args;
  if (!args) return undefined;
  return (
    typeof args === "function" ? await (args as () => Promise<ArgsDef>)() : await args
  ) as ArgsDef;
}

function camelCase(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/**
 * The closest accepted flag, when one is close enough to be a likely typo.
 *
 * Deliberately quiet on a miss: the flags a caller reasonably invents for a
 * command whose filters are inline query syntax — `--from`, `--source` — are
 * near nothing, and inventing a suggestion for them would send them further
 * from the answer than the list of real options does.
 */
function nearest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= MAX_SUGGESTION_DISTANCE ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const candidate = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = previous[j]!;
      previous[j] = candidate;
    }
  }
  return previous[b.length]!;
}

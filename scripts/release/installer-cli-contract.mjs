#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The installer's contract with the CLI it installs.
 *
 *   node scripts/release/installer-cli-contract.mjs [--surface <file>]...
 *        [--installer <install.sh>]
 *
 * `website/install.sh` is deployed from `main` on every push, and it installs
 * the newest RELEASED CLI: a checkout of the newest stable tag, the package of
 * that version, or that release's images. So every command and flag the
 * installer hands the CLI it installed — directly, through the Docker launcher
 * and the beside-Docker collector shim it writes, or in a command it prints for
 * the operator to run — must exist in the newest release, and must still exist
 * in the next one (the CLI of this tree). A call to something newer has to be
 * guarded by a capability probe of the release's own help:
 *
 *   if "$OMNESIS_BIN" pair --help 2>/dev/null | grep -q -- '--name'; then
 *     set -- "$@" --name "$NAME"
 *   fi
 *
 * The extraction is deliberately literal, not a shell interpreter: it finds
 * every place the script runs one of the CLI variables (`CLI_VARIABLES`) or
 * `omnesis` inside a container, takes the words up to the next shell operator,
 * expands a `"$@"` from the `set --` lines above it in the same function (and,
 * where those leave the function's own arguments, from its call sites), and
 * checks the literal words against a surface `cli-surface.mjs` produced. A
 * quoted variable is a value; it never becomes a flag here. A probe guards a
 * call in the same function, in a function it calls, or in one that calls it.
 *
 * Exits 1 with one line per violation, naming the installer line.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

/** Shell variables that hold an `omnesis` the installer runs. */
export const CLI_VARIABLES = [
  "OMNESIS_BIN",
  "LAUNCHER",
  "DOCKER_LAUNCHER",
  "EXISTING_CLI",
  "HARNESS_EXISTING_CLI",
];

/**
 * Commands the installer's own launchers answer without the CLI: the Docker
 * launcher's `folders` and `uninstall`, and the beside-Docker shim's
 * `uninstall`. Printed hints for them are not CLI calls.
 */
const LAUNCHER_COMMANDS = {
  omnesis: new Set(["folders"]),
  "omnesis-collector": new Set(["uninstall"]),
};

/** Flags every command answers to (packages/cli/src/unknown-flags.ts). */
const UNIVERSAL_FLAGS = ["--help", "-h", "--version", "-V", "--json"];
const HELP_FLAGS = new Set(["--help", "-h"]);

// ── Reading the script ────────────────────────────────────────────────────

/**
 * Logical lines: backslash continuations joined, each with the 1-based line
 * it starts on and the function it sits in. Function bodies are the
 * `name() {` … `}` blocks at column 0, which is how the installer writes
 * every one; the templates the installer emits through heredocs keep their
 * own functions at column 0 too, and their top-level code belongs to none.
 */
export function logicalLines(text) {
  const raw = text.split("\n");
  const lines = [];
  let fn = null;
  for (let i = 0; i < raw.length; i += 1) {
    const start = i;
    let line = raw[i];
    while (line.endsWith("\\") && i + 1 < raw.length) {
      line = `${line.slice(0, -1)} ${raw[(i += 1)].trimStart()}`;
    }
    const opens = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/.exec(line);
    if (opens) fn = opens[1];
    // Heredoc bodies written with an unquoted delimiter escape their `$`.
    const unescaped = line.replace(/\\([$"`])/g, "$1");
    lines.push({ line: start + 1, text: unescaped, fn });
    if (/^\}\s*$/.test(line)) fn = null;
  }
  return lines;
}

/**
 * The shell words of `text` from `from`, up to the first unquoted operator
 * (`|`, `&`, `;`, a redirection, a comment, or the `)` closing the command
 * substitution the words started in). Each word is `{ value, literal }`:
 * `literal` when it holds no expansion, so its value is exactly what the
 * command receives. `"$@"` is its own marker word.
 */
export function shellWords(text, from = 0) {
  const words = [];
  let i = from;
  let current = null;
  const push = () => {
    if (current) words.push(current);
    current = null;
  };
  const extend = (value, literal) => {
    current ??= { value: "", literal: true, raw: "" };
    current.value += value;
    current.literal &&= literal;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") {
      push();
      i += 1;
      continue;
    }
    if (!current && /[|&;)<>]/.test(c)) break;
    if (!current && c === "#") break;
    if (!current && /\d/.test(c) && /^\d+[<>]/.test(text.slice(i))) break;
    if (current && /[|&;)<>]/.test(c)) break;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      extend(text.slice(i + 1, stop), true);
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      let literal = true;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) {
          value += text[j + 1];
          j += 2;
          continue;
        }
        if (text[j] === "$" || text[j] === "`") {
          literal = false;
          if (text.startsWith("$(", j)) {
            const end = matchingParen(text, j + 1);
            value += text.slice(j, end + 1);
            j = end + 1;
            continue;
          }
        }
        value += text[j];
        j += 1;
      }
      if (!current && value === "$@" && text[j + 1] !== undefined && /[\s;|&)]/.test(text[j + 1])) {
        words.push({ value: "$@", literal: false, splat: true });
        i = j + 1;
        continue;
      }
      if (!current && value === "$@" && j + 1 >= text.length) {
        words.push({ value: "$@", literal: false, splat: true });
        i = j + 1;
        continue;
      }
      extend(value, literal);
      i = j + 1;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      const end = matchingParen(text, i + 1);
      extend(text.slice(i, end + 1), false);
      i = end + 1;
      continue;
    }
    if (c === "$" || c === "`") {
      const m = /^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[@*#?$!0-9-])/.exec(text.slice(i));
      const length = m ? m[0].length : 1;
      extend(text.slice(i, i + length), false);
      if (current) current.unquoted = true;
      i += length;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      extend(text[i + 1], true);
      i += 2;
      continue;
    }
    extend(c, true);
    i += 1;
  }
  push();
  return words;
}

function matchingParen(text, open) {
  let depth = 0;
  for (let j = open; j < text.length; j += 1) {
    if (text[j] === "(") depth += 1;
    else if (text[j] === ")") {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return text.length - 1;
}

const COMMAND_POSITION =
  /(?:^|[;&|({!]|\$\(|(?:^|\s)(?:then|do|else|elif|if|while|until|exec|time))\s*$/;
const ASSIGNMENTS = /(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*))+\s*$/;
const ENV_PREFIX = /\benv(?:\s+-u\s+[A-Za-z_][A-Za-z0-9_]*)*\s*$/;

/** Whether the text before a word puts that word in command position. */
function inCommandPosition(before) {
  let rest = before.replace(/\s+$/, "");
  for (let round = 0; round < 4; round += 1) {
    const stripped = rest.replace(ASSIGNMENTS, "").replace(ENV_PREFIX, "").replace(/\s+$/, "");
    if (stripped === rest) break;
    rest = stripped;
  }
  return COMMAND_POSITION.test(rest);
}

// ── Finding the calls ─────────────────────────────────────────────────────

/**
 * Every CLI call in the script: `{ line, fn, words, kind }`, with `"$@"`
 * resolved where the script says what it holds. `kind` is `call` for code the
 * script runs and `hint` for a command it prints for the operator.
 */
export function extractCalls(text) {
  const lines = logicalLines(text);
  const functions = new Map();
  for (const entry of lines) {
    if (!entry.fn) continue;
    if (!functions.has(entry.fn)) functions.set(entry.fn, []);
    functions.get(entry.fn).push(entry);
  }
  const calls = [];
  const cliToken = new RegExp(
    `"\\$(?:${CLI_VARIABLES.join("|")})"|"\\$SERVICE" (?=omnesis\\b)`,
    "g",
  );
  for (const entry of lines) {
    if (/^\s*#/.test(entry.text)) continue;
    for (const match of entry.text.matchAll(cliToken)) {
      const container = match[0].startsWith('"$SERVICE"');
      // `docker compose exec … "$SERVICE" omnesis` names the command inside
      // the container as arguments to docker, so it is never in position.
      if (!container && !inCommandPosition(entry.text.slice(0, match.index))) continue;
      let from = match.index + match[0].length;
      // `"$SERVICE" omnesis …` inside the Docker launcher: the words after
      // `omnesis` are the container CLI's.
      if (container) from += "omnesis".length;
      const words = shellWords(entry.text, from);
      // A bare `"$OMNESIS_BIN"` in an assignment or a test is a path, not a
      // call; one with no words would only print the usage anyway.
      if (!words.length) continue;
      for (const resolved of resolveSplat(words, entry, functions, lines)) {
        calls.push({
          line: entry.line,
          fn: entry.fn,
          words: resolved.words,
          kind: "call",
          source: entry.text.trim(),
        });
      }
    }
    for (const hint of printedHints(entry)) calls.push(hint);
  }
  return calls;
}

/**
 * A call whose words include `"$@"`: what the `set --` lines before it in
 * the same function made of the positional parameters, and where that still
 * names the function's own arguments, what each call site passes. Without a
 * `set --` in the function the parameters are the function's arguments.
 */
function resolveSplat(words, entry, functions, lines) {
  if (!words.some((w) => w.splat)) return [{ words }];
  let params = [{ value: "$@", literal: false, splat: true }];
  const body = entry.fn ? (functions.get(entry.fn) ?? []) : [];
  for (const prior of body) {
    if (prior.line >= entry.line) break;
    const at = prior.text.search(/(?:^|[\s;&|]|\bthen|\belse)set -- /);
    if (at === -1) continue;
    const setWords = shellWords(prior.text, prior.text.indexOf("set -- ", at) + "set -- ".length);
    if (setWords[0]?.splat) params = [...params, ...setWords.slice(1)];
    else params = setWords;
  }
  const expanded = words.flatMap((w) => (w.splat ? params : [w]));
  if (!expanded.some((w) => w.splat) || !entry.fn) return [{ words: expanded }];
  const sites = callSites(entry.fn, lines);
  if (!sites.length) return [{ words: expanded }];
  return sites.map((args) => ({ words: expanded.flatMap((w) => (w.splat ? args : [w])) }));
}

/** The argument words of every place `fn` is run as a command. */
function callSites(fn, lines) {
  const sites = [];
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_-])${fn}(?=[\\s;|&)]|$)`, "g");
  for (const entry of lines) {
    if (/^\s*#/.test(entry.text) || new RegExp(`^${fn}\\(\\)`).test(entry.text)) continue;
    for (const match of entry.text.matchAll(pattern)) {
      const start = match.index + match[0].length - fn.length;
      if (!inCommandPosition(entry.text.slice(0, start))) continue;
      sites.push(shellWords(entry.text, start + fn.length));
    }
  }
  return sites;
}

/**
 * The commands a line prints for the operator to type: `omnesis <command> …`
 * or `omnesis-collector <command> …` inside a quoted string. A word only
 * counts as a command when the CLI has it (or the launcher answers it), so
 * prose that happens to follow the word "omnesis" is not read as a call.
 */
function printedHints(entry) {
  if (!/["']/.test(entry.text) || /^\s*#/.test(entry.text)) return [];
  const hints = [];
  const pattern = /(?:^|[\s'"`(:])(omnesis(?:-collector)?) ([a-z][a-z0-9-]*)((?: [^\s'"`;|]+)*)/g;
  for (const match of entry.text.matchAll(pattern)) {
    const [, program, command, rest] = match;
    // Code, not text: the CLI calls above already cover it.
    const before = entry.text.slice(0, match.index + 1);
    if (/"\$SERVICE"\s*$/.test(before)) continue;
    if (
      (before.match(/"/g)?.length ?? 0) % 2 === 0 &&
      (before.match(/'/g)?.length ?? 0) % 2 === 0
    ) {
      continue;
    }
    const words = [{ value: command, literal: true }];
    for (const raw of rest.trim().split(/\s+/).filter(Boolean)) {
      if (/^(?:—|–|\/|#|\||&&|or|and|then|to|on|from|in)$/.test(raw) || /^[[(]/.test(raw)) break;
      const word = raw.replace(/\\n.*$/, "").replace(/[.,:;)]+$/, "");
      if (!word) break;
      const literal = !/[$<>%]|\\/.test(word) && !/^'.*'$/.test(word);
      words.push({ value: word, literal });
      if (word !== raw.replace(/\\n.*$/, "")) break;
      if (/\\n/.test(raw)) break;
    }
    hints.push({
      line: entry.line,
      fn: entry.fn,
      words,
      kind: "hint",
      program,
      source: entry.text.trim(),
    });
  }
  return hints;
}

/**
 * Capability probes: a call that asks for help, with every literal the script
 * greps that help for — on the same line, or through the variable the help
 * was captured into, anywhere in the same function.
 */
export function extractProbes(text, calls = extractCalls(text)) {
  const lines = logicalLines(text);
  const probes = [];
  for (const call of calls) {
    if (call.kind !== "call") continue;
    const helpAt = call.words.findIndex((w) => w.literal && HELP_FLAGS.has(w.value));
    if (helpAt === -1) continue;
    const path = [];
    for (const w of call.words.slice(0, helpAt)) {
      if (!w.literal || w.value.startsWith("-")) break;
      path.push(w.value);
    }
    const patterns = new Set(grepPatterns(call.source));
    const captured = /([A-Za-z_][A-Za-z0-9_]*)="\$\(/.exec(call.source);
    if (captured) {
      for (const entry of lines) {
        if (entry.fn !== call.fn || !entry.text.includes(`"$${captured[1]}"`)) continue;
        for (const p of grepPatterns(entry.text)) patterns.add(p);
      }
    }
    probes.push({ line: call.line, fn: call.fn, path: path.join(" "), patterns: [...patterns] });
  }
  return probes;
}

function grepPatterns(text) {
  const patterns = [];
  for (const match of text.matchAll(/\bgrep\b/g)) {
    const words = shellWords(text, match.index + 4);
    let afterDashes = false;
    for (const w of words) {
      if (!afterDashes && w.value === "--") {
        afterDashes = true;
        continue;
      }
      if (!afterDashes && w.value.startsWith("-")) continue;
      if (w.literal) patterns.push(w.value.replace(/\\/g, ""));
      break;
    }
  }
  return patterns;
}

/** Which functions each function runs, from the names the body mentions. */
function callGraph(text) {
  const lines = logicalLines(text);
  const names = new Set(lines.filter((l) => l.fn).map((l) => l.fn));
  const calls = new Map([...names].map((n) => [n, new Set()]));
  for (const entry of lines) {
    if (!entry.fn) continue;
    for (const word of entry.text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      if (word !== entry.fn && names.has(word)) calls.get(entry.fn).add(word);
    }
  }
  return calls;
}

// ── Checking against a surface ────────────────────────────────────────────

function spellings(key) {
  const camel = key.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
  const kebab = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return new Set([key, camel, kebab]);
}

/** The flags a command accepts: its own, and a group's children's too. */
function accepted(surface, path) {
  const names = new Set(UNIVERSAL_FLAGS);
  const valueTaking = new Set();
  const collect = (command) => {
    for (const [key, def] of Object.entries(command?.flags ?? {})) {
      for (const spelling of spellings(key)) {
        names.add(`--${spelling}`);
        if (def.type === "boolean") names.add(`--no-${spelling}`);
        if (def.type === "string" || def.type === "enum") valueTaking.add(`--${spelling}`);
      }
      for (const alias of def.alias ?? []) {
        names.add(`-${alias}`);
        if (def.type === "string" || def.type === "enum") valueTaking.add(`-${alias}`);
      }
    }
  };
  const command = surface.commands[path];
  collect(command);
  for (const child of command?.subcommands ?? [])
    collect(surface.commands[`${path} ${child}`.trim()]);
  return { names, valueTaking };
}

/**
 * What the released CLI would refuse in one call, as `{ missing, parent, kind }`
 * entries: an unknown subcommand (`kind: "command"`, under `parent`) or an
 * unknown flag (`kind: "flag"`, on the command `parent`). Mirrors the CLI: the
 * leading words choose the command (citty refuses a word that names no
 * subcommand of a group), then every flag must be one that command accepts.
 * A call asking for help is never refused.
 */
export function refusals(words, surface) {
  if (words.some((w) => w.literal && HELP_FLAGS.has(w.value))) return [];
  const problems = [];
  let path = "";
  let index = 0;
  for (; index < words.length; index += 1) {
    const w = words[index];
    if (w.value.startsWith("-") && w.literal) break;
    const command = surface.commands[path];
    if (!command?.subcommands?.length) break;
    if (!w.literal) {
      path = null;
      break;
    }
    if (!command.subcommands.includes(w.value)) {
      problems.push({ kind: "command", missing: w.value, parent: path });
      return problems;
    }
    path = `${path} ${w.value}`.trim();
  }
  if (path === null) return problems;
  const { names, valueTaking } = accepted(surface, path);
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (!w.literal || !w.value.startsWith("-") || w.value === "-" || w.value === "--") continue;
    const name = w.value.split("=")[0];
    if (names.has(name)) {
      if (!w.value.includes("=") && valueTaking.has(name)) i += 1;
      continue;
    }
    problems.push({ kind: "flag", missing: name, parent: path });
  }
  return problems;
}

/** Whether a probe in reach of the call vouches for the missing piece. */
function guarded(problem, call, probes, graph) {
  const reach = new Set([call.fn]);
  if (call.fn) {
    for (const callee of graph.get(call.fn) ?? []) reach.add(callee);
    for (const [caller, callees] of graph) if (callees.has(call.fn)) reach.add(caller);
  }
  return probes.some((probe) => {
    if (!reach.has(probe.fn)) return false;
    const target =
      problem.kind === "command"
        ? [problem.parent, `${problem.parent} ${problem.missing}`.trim()]
        : [problem.parent];
    return target.includes(probe.path) && probe.patterns.some((p) => p.includes(problem.missing));
  });
}

/**
 * Every unguarded call `surface` would refuse:
 * `[{ line, kind, words, problem, version }]`. A printed hint is read as a
 * command when its first word is one of `known` (by default the surface's own
 * top-level commands).
 */
export function checkInstaller(text, surface, known = surface.commands[""]?.subcommands ?? []) {
  const knownCommands = new Set(known);
  const calls = extractCalls(text);
  const probes = extractProbes(text, calls);
  const graph = callGraph(text);
  const violations = [];
  for (const call of calls) {
    if (call.kind === "hint") {
      const command = call.words[0].value;
      if (LAUNCHER_COMMANDS[call.program]?.has(command)) continue;
      // Prose, unless the word after "omnesis" is a command some CLI has.
      if (!knownCommands.has(command)) continue;
    }
    for (const problem of refusals(call.words, surface)) {
      if (guarded(problem, call, probes, graph)) continue;
      violations.push({
        line: call.line,
        kind: call.kind,
        words: call.words.map((w) => (w.literal ? w.value : `<${w.value}>`)).join(" "),
        problem,
        cli: surface.label ?? `v${surface.version}`,
      });
    }
  }
  return violations;
}

/**
 * Check against several surfaces at once — the newest release, and this
 * tree's CLI as the next one. A hint whose first word any of them has is
 * checked against all of them, so a command only the newer CLI has is still
 * refused for the older one.
 */
export function checkInstallerAgainst(text, surfaces) {
  const known = surfaces.flatMap((s) => s.commands[""]?.subcommands ?? []);
  return surfaces.flatMap((surface) => checkInstaller(text, surface, known));
}

export function formatViolation(v, installer = "scripts/install.sh") {
  const command = `omnesis ${v.problem.parent ? `${v.problem.parent} ` : ""}`;
  const what =
    v.problem.kind === "command"
      ? `\`${command}${v.problem.missing}\` is not a command of ${v.cli}`
      : `\`${command.trim()}\` has no ${v.problem.missing} in ${v.cli}`;
  const how =
    v.kind === "hint"
      ? "the installer prints this for the operator to run"
      : `guard the call with a probe of \`${command}--help\``;
  return `${installer}:${v.line}: ${what} (${v.words}); ${how}.`;
}

/**
 * The words one recorded CLI process received, checked like a call: every
 * word is literal, because it is what the process was actually given.
 */
export function refusalsOfArgv(argv, surface) {
  return refusals(
    argv.map((value) => ({ value, literal: true })),
    surface,
  );
}

const USAGE =
  "Usage: installer-cli-contract.mjs [--surface <file>]... [--tree <checkout>]... [--installer <file>]";

function parseArgs(argv) {
  const flags = { surface: [], tree: [], installer: join(repoRoot, "scripts", "install.sh") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--surface" && argv[i + 1]) flags.surface.push(argv[(i += 1)]);
    else if (argv[i] === "--tree" && argv[i + 1]) flags.tree.push(argv[(i += 1)]);
    else if (argv[i] === "--installer" && argv[i + 1]) flags.installer = argv[(i += 1)];
    else throw new Error(USAGE);
  }
  // By default: the newest release, and this tree's CLI as the next one.
  if (!flags.surface.length && !flags.tree.length) {
    flags.surface.push(join(here, "released-cli-surface.json"));
    flags.tree.push(repoRoot);
  }
  return flags;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = parseArgs(process.argv.slice(2));
  const { cliSurface, readReleasedSurface } = await import("./cli-surface.mjs");
  const text = readFileSync(flags.installer, "utf8");
  const surfaces = flags.surface.map((file) => {
    const surface = readReleasedSurface(resolve(file));
    return { ...surface, label: `v${surface.version} (${file})` };
  });
  for (const tree of flags.tree) {
    const surface = await cliSurface(tree);
    const label = resolve(tree) === repoRoot ? "this tree's CLI" : `the CLI of ${tree}`;
    surfaces.push({ ...surface, label: `${label} (v${surface.version})` });
  }
  const violations = checkInstallerAgainst(text, surfaces);
  for (const v of violations) process.stderr.write(`${formatViolation(v, flags.installer)}\n`);
  if (violations.length) process.exit(1);
  process.stdout.write(
    `${flags.installer}: every CLI call is accepted by ${surfaces.map((s) => s.label).join(" and ")}, or guarded by a capability probe.\n`,
  );
  process.exit(0);
}

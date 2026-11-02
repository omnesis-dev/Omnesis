#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The release-skew lane's helpers: does the installer on this branch work
 * with the newest RELEASED CLI, which is the one omnesis.dev's copy installs?
 *
 *   node scripts/install-e2e/release-skew.mjs contract [--work <dir>]
 *   node scripts/install-e2e/release-skew.mjs newest-tag [--remote <git dir>]
 *   node scripts/install-e2e/release-skew.mjs trace --trace <file.jsonl> --tree <checkout>
 *        [--min <n>]
 *   node scripts/install-e2e/release-skew.mjs scan <log>...
 *   node scripts/install-e2e/release-skew.mjs fingerprint <cert.pem>
 *   node scripts/install-e2e/release-skew.mjs tty [--log <file>] [--timeout <s>] -- <command>...
 *
 * `contract` is the static half: it checks out the newest `vX.Y.Z` tag beside
 * this checkout, reads that release's CLI surface from its own command tree,
 * and checks every CLI call in this branch's install.sh against it and against
 * this tree's CLI (`scripts/release/installer-cli-contract.mjs`). It also holds
 * `scripts/release/released-cli-surface.json` to the newest release — or, on a
 * release commit whose tag is not pushed yet, to this tree.
 *
 * `trace` is the dynamic half's verdict: every CLI process a real installer
 * run started (recorded by `cli-trace.cjs`) must be one the installed
 * release's CLI accepts, and none may have printed a refusal. `scan` is the
 * same verdict for output only (the Docker launcher runs the CLI inside the
 * released images, where no preload reaches).
 *
 * `tty` runs a command on a pseudo-terminal through script(1) and answers the
 * installer's and the CLI's prompts as an operator taking the defaults would,
 * with the pairing code from `$RELEASE_SKEW_PAIR_CODE` and the encryption
 * choice from `$RELEASE_SKEW_KEYRING_CHOICE`. A prompt it has no answer for
 * fails the run instead of hanging it.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommand } from "./args.mjs";
import { newestStableTag } from "./fixture.mjs";
import {
  RELEASED_SURFACE_FILE,
  cliSurface,
  readReleasedSurface,
  sameSurface,
} from "../release/cli-surface.mjs";
import {
  checkInstallerAgainst,
  formatViolation,
  refusalsOfArgv,
} from "../release/installer-cli-contract.mjs";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
/** What the CLI prints when it refuses a command line. */
export const REFUSAL = /Unknown option: \S+|Unknown command \S+|No command specified\./;

function git(args, cwd = repoRoot) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tags(cwd) {
  return git(["tag", "-l"], cwd).split("\n").filter(Boolean);
}

// ── contract ──────────────────────────────────────────────────────────────

/**
 * Which surface `released-cli-surface.json` must record: the newest
 * release's, or — on a release commit before its tag exists — this tree's, at
 * this tree's version. Returns the problem, or null.
 */
export function storedSurfaceProblem({ stored, newest, tree, tagExists }) {
  if (sameSurface(stored, newest)) return null;
  const pending = stored.version === tree.version && !tagExists(`v${stored.version}`);
  if (pending && sameSurface(stored, tree)) return null;
  return (
    `scripts/release/released-cli-surface.json records v${stored.version}, which is neither ` +
    `the CLI surface of the newest release v${newest.version} nor that of this tree's pending ` +
    `release. Regenerate it from a checkout of v${newest.version}: node ` +
    `scripts/release/cli-surface.mjs --tree <checkout> --write ${RELEASED_SURFACE_FILE}`
  );
}

async function contract({ work }) {
  const newestTag = newestStableTag(tags(repoRoot));
  if (!newestTag) {
    throw new Error("No vX.Y.Z tag in this checkout; fetch with tags (fetch-depth: 0).");
  }
  const scratch = work ? resolve(work) : mkdtempSync(join(tmpdir(), "omnesis-release-skew-"));
  const tree = join(scratch, newestTag);
  console.log(`release-skew: the newest release is ${newestTag}; reading its CLI surface…`);
  git(["worktree", "add", "--detach", "--force", tree, newestTag]);
  try {
    const install = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: tree,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (install.status !== 0) throw new Error(`npm ci failed in the ${newestTag} checkout`);
    const newest = await cliSurface(tree);
    const current = await cliSurface(repoRoot);
    writeFileSync(join(scratch, "newest-surface.json"), `${JSON.stringify(newest, null, 2)}\n`);

    const installer = readFileSync(join(repoRoot, "scripts", "install.sh"), "utf8");
    const violations = checkInstallerAgainst(installer, [
      { ...newest, label: `${newestTag} (the newest release)` },
      { ...current, label: `this tree's CLI (v${current.version})` },
    ]);
    for (const v of violations) console.error(`::error::${formatViolation(v)}`);

    const problem = storedSurfaceProblem({
      stored: readReleasedSurface(),
      newest,
      tree: current,
      tagExists: (tag) => tags(repoRoot).includes(tag),
    });
    if (problem) console.error(`::error::${problem}`);
    if (violations.length || problem) return false;
    console.log(
      `release-skew: every CLI call in scripts/install.sh is accepted by ${newestTag} and by ` +
        `this tree's CLI, or guarded by a capability probe.`,
    );
    return true;
  } finally {
    if (!work) {
      git(["worktree", "remove", "--force", tree]);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

// ── trace / scan ──────────────────────────────────────────────────────────

/** A command line with its values elided: a pairing code is an argument. */
function shapeOf(argv) {
  const words = [];
  for (const word of argv) {
    if (word.startsWith("-")) words.push(word.split("=")[0]);
    else if (
      words.length < 3 &&
      !words.some((w) => w.startsWith("-")) &&
      /^[a-z][a-z0-9-]*$/.test(word)
    ) {
      words.push(word);
    } else if (words.at(-1) !== "…") words.push("…");
  }
  return words.join(" ");
}

/**
 * The verdict on a trace: `{ calls, commands, problems }`. A problem names the
 * command path, its flags and what was refused, never a value.
 */
export function traceVerdict(records, surface) {
  const problems = [];
  const commands = new Set();
  for (const { argv, code, refused } of records) {
    const shape = shapeOf(argv);
    commands.add(shape);
    for (const refusal of refusalsOfArgv(argv, surface)) {
      const where = refusal.parent ? `\`omnesis ${refusal.parent}\`` : "the CLI";
      problems.push(
        `\`omnesis ${shape}\`: ${where} in v${surface.version} has no ${refusal.kind} ${refusal.missing}`,
      );
    }
    if (refused) problems.push(`\`omnesis ${shape}\` exited ${code} after printing "${refused}"`);
  }
  return { calls: records.length, commands: [...commands].sort(), problems };
}

async function trace({ trace: file, tree, min = 1 }) {
  const records = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const surface = await cliSurface(tree);
  const verdict = traceVerdict(records, surface);
  console.log(
    `release-skew: the installer ran the v${surface.version} CLI ${verdict.calls} times, as:\n` +
      verdict.commands.map((c) => `  omnesis ${c}`).join("\n"),
  );
  for (const problem of verdict.problems) console.error(`::error::${problem}`);
  if (verdict.calls < min) {
    console.error(
      `::error::only ${verdict.calls} CLI calls were recorded (expected at least ${min}); the trace preload did not run`,
    );
    return false;
  }
  return verdict.problems.length === 0;
}

/** Every refusal the CLI printed in these logs. */
export function refusalsIn(text) {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  return plain
    .split("\n")
    .map((line) => REFUSAL.exec(line)?.[0])
    .filter(Boolean);
}

function scan(files) {
  let ok = true;
  for (const file of files) {
    for (const refusal of refusalsIn(readFileSync(file, "utf8"))) {
      console.error(`::error::${file}: the CLI refused a command: ${refusal}`);
      ok = false;
    }
  }
  return ok;
}

// ── fingerprint ───────────────────────────────────────────────────────────

/** `sha256:<hex>` of a PEM certificate, the form --trust-fingerprint takes. */
export function fingerprintOf(pem) {
  return `sha256:${new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase()}`;
}

// ── tty ───────────────────────────────────────────────────────────────────

/**
 * The answer an operator taking the defaults gives the prompt `tail` ends
 * with, or undefined when `tail` does not end in a prompt this lane knows.
 */
export function answerFor(tail, env = process.env) {
  const text = tail.replace(/\s+$/, " ");
  if (/Pairing code: $/.test(text)) return env.RELEASE_SKEW_PAIR_CODE ?? "";
  if (/Trust this certificate\? \[y\/N\] $/.test(text)) return "y";
  if (/Choice \[\d\]: $/.test(text)) return env.RELEASE_SKEW_KEYRING_CHOICE ?? "";
  if (/\[[Yy]\/[Nn]\] $/.test(text)) return "";
  if (/(?:Address|Model) \[\d+\]: $/.test(text)) return "";
  return undefined;
}

const LOOKS_LIKE_PROMPT = /[?:\]] $/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function tty({ log, timeout = 2400 }, command) {
  if (!command.length) throw new Error("tty: name the command after --");
  const quote = (word) => `'${word.replaceAll("'", `'\\''`)}'`;
  const child = spawn("script", ["-qefc", command.map(quote).join(" "), "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  let tail = "";
  let lastOutput = Date.now();
  let failure = "";
  const answered = [];
  const onData = (chunk) => {
    const text = chunk.toString("utf8");
    process.stdout.write(text);
    if (log) appendFileSync(log, text);
    lastOutput = Date.now();
    tail = (tail + text.replace(ANSI, "").replace(/\r/g, "")).slice(-400);
    const answer = answerFor(tail);
    if (answer === undefined) return;
    // The prompt is recorded, never the answer: one of them is a pairing code.
    answered.push(tail.trimEnd().split("\n").at(-1));
    tail = "";
    child.stdin.write(`${answer}\n`);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const started = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastOutput > 120_000 && LOOKS_LIKE_PROMPT.test(tail.replace(/\s+$/, " "))) {
      failure = `an unanswered prompt: ${JSON.stringify(tail.trimEnd().split("\n").at(-1))}`;
      child.kill("SIGTERM");
    } else if (Date.now() - started > timeout * 1000) {
      failure = `no exit after ${timeout}s`;
      child.kill("SIGTERM");
    }
  }, 5000);
  return new Promise((done) => {
    child.on("exit", (code) => {
      clearInterval(watchdog);
      console.log(`\nrelease-skew: answered ${answered.length} prompts on the terminal:`);
      for (const prompt of answered) console.log(`  ${prompt}`);
      if (failure) console.error(`::error::the run on a terminal stopped at ${failure}`);
      done(!failure && code === 0 ? 0 : code || 1);
    });
  });
}

// ── entry ─────────────────────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const dashes = argv.indexOf("--");
  const own = dashes === -1 ? argv : argv.slice(0, dashes);
  const rest = dashes === -1 ? [] : argv.slice(dashes + 1);
  // `scan` and `fingerprint` take file names, which parseCommand does not.
  const takesFiles = ["scan", "fingerprint"].includes(own[0]);
  const files = takesFiles ? own.slice(1) : [];
  const { command, flags } = parseCommand(takesFiles ? own.slice(0, 1) : own, {
    contract: { values: ["work"] },
    "newest-tag": { values: ["remote"] },
    trace: { values: ["trace", "tree"], numbers: ["min"], required: ["trace", "tree"] },
    scan: {},
    fingerprint: {},
    tty: { values: ["log"], numbers: ["timeout"] },
  });
  let ok = true;
  if (command === "contract") ok = await contract(flags);
  else if (command === "newest-tag") {
    const tag = newestStableTag(tags(flags.remote ? resolve(flags.remote) : repoRoot));
    if (!tag) throw new Error("no vX.Y.Z tag");
    console.log(tag);
  } else if (command === "trace") ok = await trace(flags);
  else if (command === "scan") ok = scan(files);
  else if (command === "fingerprint") console.log(fingerprintOf(readFileSync(files[0], "utf8")));
  else if (command === "tty") process.exit(await tty(flags, rest));
  process.exit(ok ? 0 : 1);
}

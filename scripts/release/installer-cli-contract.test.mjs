// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readReleasedSurface, repoRoot } from "./cli-surface.mjs";
import {
  checkInstaller,
  checkInstallerAgainst,
  extractCalls,
  extractProbes,
  refusalsOfArgv,
  shellWords,
} from "./installer-cli-contract.mjs";

const installer = readFileSync(join(repoRoot, "scripts", "install.sh"), "utf8");
const released = readReleasedSurface();

/** This tree's CLI, read the way the CI lane reads the newest release's. */
function treeSurface() {
  const out = execFileSync(process.execPath, [join(repoRoot, "scripts/release/cli-surface.mjs")], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const { $comment: _comment, ...surface } = JSON.parse(out);
  return surface;
}

/** A small surface for the extractor's own tests. */
const surface = {
  version: "1.0.0",
  commands: {
    "": { flags: {}, positionals: 0, subcommands: ["keyring", "pair", "service"] },
    pair: {
      flags: { "gateway-url": { type: "string" }, save: { type: "string" } },
      positionals: 1,
      subcommands: [],
    },
    keyring: { flags: {}, positionals: 0, subcommands: ["init", "status"] },
    "keyring init": { flags: { backend: { type: "string" } }, positionals: 0, subcommands: [] },
    "keyring status": { flags: {}, positionals: 0, subcommands: [] },
    service: { flags: {}, positionals: 0, subcommands: ["install"] },
    "service install": {
      flags: { exec: { type: "string" }, "no-keyring": { type: "boolean" } },
      positionals: 1,
      subcommands: [],
    },
  },
};

const problems = (script, against = surface) =>
  checkInstaller(script, against).map((v) => `${v.line} ${v.problem.kind} ${v.problem.missing}`);

describe("the installer served from main", () => {
  test("calls only what the newest release's CLI accepts, or probes for it first", () => {
    expect(checkInstaller(installer, released)).toEqual([]);
  });

  test("calls only what this tree's CLI — the next release — still accepts", () => {
    const next = treeSurface();
    expect(checkInstallerAgainst(installer, [released, next])).toEqual([]);
  });

  test("the recorded release is the one this tree's lockstep version names", () => {
    // `npm run release -- version` rewrites the file with the version; a
    // release whose file still names the previous one fails here and in the
    // lockstep guard the release workflow runs.
    const product = JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8"));
    expect(released.version).toBe(product.version);
  });

  test("the extraction reaches the calls this contract exists for", () => {
    const calls = extractCalls(installer).filter((c) => c.kind === "call");
    const said = calls.map((c) =>
      c.words
        .filter((w) => w.literal)
        .map((w) => w.value)
        .join(" "),
    );
    // The collector's pairing, with every flag its `set --` lines add.
    expect(said).toContainEqual(expect.stringMatching(/^pair --gateway-url .*--save --name$/));
    // The beside-Docker shim's uninstall, and the Docker launcher's calls
    // into the container.
    expect(said).toContain("keyring purge --yes");
    expect(said).toContain("secure --verify");
    // A function's own arguments, from its call site.
    expect(said).toContainEqual(expect.stringMatching(/^service install collector --env /));
    expect(extractProbes(installer).map((p) => `${p.path} ${p.patterns.join(",")}`)).toContain(
      "pair --name",
    );
  });

  // #640: main's installer started passing `pair --name` while the newest
  // release had no such flag, and every collector install from omnesis.dev
  // failed at pairing. Its fix probes `pair --help` first.
  test("refuses the #640 pairing call without the probe that fixed it", () => {
    const withoutName = structuredClone(released);
    delete withoutName.commands.pair.flags.name;
    expect(checkInstaller(installer, withoutName)).toEqual([]);

    const probe = `"$OMNESIS_BIN" pair --help 2>/dev/null | grep -q -- '--name'`;
    expect(installer).toContain(probe);
    const unguarded = installer.replace(
      `[ -n "$COLLECTOR_PAIR_NAME" ] && ${probe}`,
      `[ -n "$COLLECTOR_PAIR_NAME" ]`,
    );
    const violations = checkInstaller(unguarded, withoutName);
    expect(violations.length).toBeGreaterThan(0);
    expect(
      violations.every((v) => v.problem.kind === "flag" && v.problem.missing === "--name"),
    ).toBe(true);
    expect(violations.every((v) => v.problem.parent === "pair")).toBe(true);
  });
});

describe("reading a call", () => {
  test("stops at the shell operator after its words", () => {
    const words = shellWords(`"$X" keyring status --json 2>/dev/null || true`, 4);
    expect(words.map((w) => w.value)).toEqual(["keyring", "status", "--json"]);
  });

  test("a quoted expansion is a value, never a flag", () => {
    const [, value] = shellWords(`pair "$CODE" --save "$DIR/token"`);
    expect(value).toMatchObject({ literal: false });
    expect(problems(`"$OMNESIS_BIN" pair "$CODE" --save "$DIR/token"\n`)).toEqual([]);
  });

  test("finds calls inside a command substitution and after env assignments", () => {
    const script = [
      `A="$("$OMNESIS_BIN" keyring status --wide 2>/dev/null)"`,
      `OMNESIS_CONFIG_DIR="$C" FOO=1 "$LAUNCHER" keyring purge --yes`,
    ].join("\n");
    expect(problems(script)).toEqual(["1 flag --wide", "2 command purge"]);
  });

  test("a CLI path as an argument or in a test is not a call", () => {
    const script = [
      `set -- service install "$@" --exec "$OMNESIS_BIN"`,
      `[ -x "$OMNESIS_BIN" ] || fail "no $OMNESIS_BIN"`,
      `PLAN_TARGET="$OMNESIS_BIN"`,
    ].join("\n");
    expect(extractCalls(script).filter((c) => c.kind === "call")).toEqual([]);
  });

  test('expands "$@" from the set -- lines above it, then from call sites', () => {
    const script = [
      "install_it() {",
      `  set -- service install "$@" --exec "$OMNESIS_BIN"`,
      `  [ "$X" = 1 ] && set -- "$@" --keyring-file "$F"`,
      `  "$OMNESIS_BIN" "$@"`,
      "}",
      "main() {",
      "  install_it gateway --no-keyring",
      "  if ! install_it collector --wide; then :; fi",
      "}",
    ].join("\n");
    expect(problems(script)).toEqual([
      "4 flag --keyring-file",
      "4 flag --wide",
      "4 flag --keyring-file",
    ]);
  });

  test("a value-taking flag swallows its value, even one starting with a dash", () => {
    expect(refusalsOfArgv(["keyring", "init", "--backend", "-x"], surface)).toEqual([]);
    expect(refusalsOfArgv(["keyring", "init", "--backend=passphrase"], surface)).toEqual([]);
    expect(refusalsOfArgv(["keyring", "init", "--force"], surface)).toEqual([
      { kind: "flag", missing: "--force", parent: "keyring init" },
    ]);
  });

  test("a group's flags are its children's, and help is never refused", () => {
    expect(refusalsOfArgv(["keyring", "--backend", "x", "--json"], surface)).toEqual([]);
    expect(refusalsOfArgv(["keyring", "purge", "--help"], surface)).toEqual([]);
    expect(refusalsOfArgv(["keyring", "purge"], surface)).toEqual([
      { kind: "command", missing: "purge", parent: "keyring" },
    ]);
  });

  test("an unquoted kebab flag matches its camel declaration and its negation", () => {
    const camel = structuredClone(surface);
    camel.commands.pair.flags = { gatewayUrl: { type: "string" }, wait: { type: "boolean" } };
    expect(refusalsOfArgv(["pair", "C", "--gateway-url", "u", "--no-wait"], camel)).toEqual([]);
  });
});

describe("capability probes", () => {
  const guardedPair = (probeLine) =>
    [
      "pair_it() {",
      `  set -- pair "$CODE" --save "$F"`,
      probeLine,
      `  "$OMNESIS_BIN" "$@" </dev/null`,
      "}",
    ].join("\n");

  test("a probe of the command's help for the flag guards the call", () => {
    const script = guardedPair(
      `  if "$OMNESIS_BIN" pair --help 2>/dev/null | grep -q -- '--name'; then set -- "$@" --name "$N"; fi`,
    );
    expect(problems(script)).toEqual([]);
  });

  test("a probe for another flag, or of another command, does not", () => {
    expect(
      problems(
        guardedPair(
          `  if "$OMNESIS_BIN" pair --help | grep -q -- '--nick'; then set -- "$@" --name "$N"; fi`,
        ),
      ),
    ).toEqual(["4 flag --name"]);
    expect(
      problems(
        guardedPair(
          `  if "$OMNESIS_BIN" keyring --help | grep -q -- '--name'; then set -- "$@" --name "$N"; fi`,
        ),
      ),
    ).toEqual(["4 flag --name"]);
  });

  test("help captured into a variable and grepped later still guards", () => {
    const script = [
      "supported() {",
      `  HELP="$("$OMNESIS_BIN" keyring --help 2>/dev/null </dev/null)" || return 1`,
      `  printf '%s\\n' "$HELP" | grep -q -- 'purge' || return 1`,
      "}",
      "purge_it() {",
      "  supported || return 0",
      `  "$OMNESIS_BIN" keyring purge`,
      "}",
    ].join("\n");
    expect(problems(script)).toEqual([]);
  });

  test("a probe in an unrelated function guards nothing", () => {
    const script = [
      "probe() {",
      `  "$OMNESIS_BIN" keyring --help | grep -q purge`,
      "}",
      "purge_it() {",
      `  "$OMNESIS_BIN" keyring purge`,
      "}",
    ].join("\n");
    expect(problems(script)).toEqual(["5 command purge"]);
  });
});

describe("printed commands", () => {
  test("a command the installer tells the operator to run is checked", () => {
    const script = [
      `warn "Arm it later with: omnesis keyring init --strong"`,
      `echo "    omnesis pair <code> --save ~/token"`,
    ].join("\n");
    expect(problems(script)).toEqual(["1 flag --strong"]);
  });

  test("prose after the word omnesis is not a command", () => {
    const script = [
      `info "The omnesis command here runs in a container"`,
      `info "omnesis-collector uninstall --purge removes it"`,
      `printf 'omnesis folders share %s\\n' "$P"`,
    ].join("\n");
    expect(problems(script)).toEqual([]);
  });
});

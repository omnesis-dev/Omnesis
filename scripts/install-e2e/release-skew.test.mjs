// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  answerFor,
  fingerprintOf,
  refusalsIn,
  storedSurfaceProblem,
  traceVerdict,
} from "./release-skew.mjs";

const surface = (version, flags = { "gateway-url": { type: "string" } }) => ({
  version,
  commands: {
    "": { flags: {}, positionals: 0, subcommands: ["pair", "keyring"] },
    pair: { flags, positionals: 1, subcommands: [] },
    keyring: { flags: {}, positionals: 0, subcommands: ["status"] },
    "keyring status": { flags: {}, positionals: 0, subcommands: [] },
  },
});

describe("the recorded release surface", () => {
  const newest = surface("0.7.4");
  const next = surface("0.7.5", { "gateway-url": { type: "string" }, name: { type: "string" } });

  test("is the newest release's", () => {
    expect(
      storedSurfaceProblem({ stored: newest, newest, tree: next, tagExists: () => true }),
    ).toBeNull();
  });

  test("may be this tree's on a release commit whose tag is not pushed yet", () => {
    const pending = { stored: next, newest, tree: next };
    expect(storedSurfaceProblem({ ...pending, tagExists: () => false })).toBeNull();
    // Once the tag exists, the newest release is that tag, and a file that
    // still differs from it is stale.
    expect(storedSurfaceProblem({ ...pending, tagExists: () => true })).toMatch(
      /records v0\.7\.5, which is neither/u,
    );
  });

  test("is refused when it is an older release's", () => {
    const older = surface("0.7.3", {});
    expect(
      storedSurfaceProblem({ stored: older, newest, tree: next, tagExists: () => true }),
    ).toMatch(/newest release v0\.7\.4/u);
  });
});

describe("a trace of the installer's CLI calls", () => {
  test("passes calls the installed release accepts, naming each command once", () => {
    const verdict = traceVerdict(
      [
        {
          argv: ["pair", "ABCDE12345", "--gateway-url", "https://gw.example.com:7600"],
          code: 0,
          refused: "",
        },
        { argv: ["pair", "--help"], code: 0, refused: "" },
        { argv: ["keyring", "status", "--json"], code: 0, refused: "" },
      ],
      surface("0.7.4"),
    );
    expect(verdict.problems).toEqual([]);
    expect(verdict.calls).toBe(3);
    // Values never reach the log: a pairing code is an argument.
    expect(verdict.commands.join("\n")).not.toContain("ABCDE12345");
    expect(verdict.commands).toContain("pair … --gateway-url …");
  });

  test("fails a flag or a subcommand the release does not have, and a printed refusal", () => {
    const verdict = traceVerdict(
      [
        {
          argv: ["pair", "ABCDE12345", "--name", "laptop"],
          code: 2,
          refused: "Unknown option: --name",
        },
        { argv: ["keyring", "purge", "--yes"], code: 0, refused: "" },
      ],
      surface("0.7.3"),
    );
    expect(verdict.problems).toEqual([
      "`omnesis pair … --name …`: `omnesis pair` in v0.7.3 has no flag --name",
      '`omnesis pair … --name …` exited 2 after printing "Unknown option: --name"',
      "`omnesis keyring purge --yes`: `omnesis keyring` in v0.7.3 has no command purge",
    ]);
  });

  test("output is scanned for the refusals the CLI prints, colored or not", () => {
    expect(
      refusalsIn(
        "ok\n\u001b[31mUnknown option: --name\u001b[0m\nUnknown command \u001b[36mpurge\u001b[39m\n",
      ),
    ).toEqual(["Unknown option: --name", "Unknown command purge"]);
    expect(refusalsIn("Pairing with https://gw.example.com:7600...\nPaired.\n")).toEqual([]);
  });
});

describe("the terminal driver", () => {
  const env = { RELEASE_SKEW_PAIR_CODE: "ABCDE12345", RELEASE_SKEW_KEYRING_CHOICE: "2" };

  test.each([
    ["Pairing code: ", "ABCDE12345"],
    ["Trust this certificate? [y/N] ", "y"],
    ["   3) Stop\n\nChoice [1]: ", "2"],
    ["Replace the launcher? [y/N] ", ""],
    ["Update this machine's Omnesis now with omnesis update? [Y/n] ", ""],
    ["Address [1]: ", ""],
  ])("answers %j", (prompt, answer) => {
    expect(answerFor(prompt, env)).toBe(answer);
  });

  test("does not answer output that is not a prompt", () => {
    expect(answerFor("Installing the CLI\n", env)).toBeUndefined();
    expect(answerFor("Pairing code: ABCDE12345\nPairing with gw…\n", env)).toBeUndefined();
  });
});

describe("the certificate fingerprint", () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  test("is the form --trust-fingerprint takes", () => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-release-skew-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ].concat(["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")]),
      { stdio: "ignore" },
    );
    const expected = execFileSync(
      "openssl",
      ["x509", "-in", join(dir, "cert.pem"), "-noout", "-fingerprint", "-sha256"],
      { encoding: "utf8" },
    )
      .split("=")[1]
      .trim()
      .replaceAll(":", "")
      .toLowerCase();
    expect(fingerprintOf(readFileSync(join(dir, "cert.pem"), "utf8"))).toBe(`sha256:${expected}`);
  });
});

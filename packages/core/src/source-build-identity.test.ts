// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { runningSourceCommit } from "./source-build-identity.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omnesis-source-identity-"));
  roots.push(root);
  const configDir = join(root, "config");
  const sourceRoot = join(root, "source");
  const modulePath = join(sourceRoot, "packages", "gateway", "main.js");
  mkdirSync(join(sourceRoot, "packages", "gateway"), { recursive: true });
  mkdirSync(configDir);
  writeFileSync(modulePath, "");
  execFileSync("git", ["init", "-q", "-b", "main", sourceRoot]);
  execFileSync("git", ["-C", sourceRoot, "config", "user.name", "fixture"]);
  execFileSync("git", ["-C", sourceRoot, "config", "user.email", "maya@example.com"]);
  execFileSync("git", ["-C", sourceRoot, "add", "."]);
  execFileSync("git", ["-C", sourceRoot, "commit", "-q", "-m", "fixture"]);
  const commit = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const statePath = join(configDir, "update-state.json");
  writeFileSync(
    statePath,
    `${JSON.stringify({
      version: 1,
      method: "source",
      rootDir: sourceRoot,
      phase: "complete",
      commit,
    })}\n`,
  );
  return { configDir, sourceRoot, modulePath, statePath, commit };
}

describe("runningSourceCommit", () => {
  test("attests a complete source state written before this process loaded the module", () => {
    const { configDir, modulePath, commit } = fixture();
    expect(runningSourceCommit(configDir, pathToFileURL(modulePath).href, Date.now() + 1_000)).toBe(
      commit,
    );
  });

  test("refuses a checkout moved away from its completed source state", () => {
    const { configDir, sourceRoot, modulePath } = fixture();
    writeFileSync(join(sourceRoot, "next"), "next\n");
    execFileSync("git", ["-C", sourceRoot, "add", "."]);
    execFileSync("git", ["-C", sourceRoot, "commit", "-q", "-m", "next fixture"]);

    expect(
      runningSourceCommit(configDir, pathToFileURL(modulePath).href, Date.now() + 1_000),
    ).toBeNull();
  });

  test("refuses stale processes, modules outside the checkout, and malformed commits", () => {
    const { configDir, modulePath, statePath } = fixture();
    const future = new Date(Date.now() + 10_000);
    utimesSync(statePath, future, future);
    expect(runningSourceCommit(configDir, pathToFileURL(modulePath).href, Date.now())).toBeNull();

    const outside = join(configDir, "outside.js");
    writeFileSync(outside, "");
    expect(
      runningSourceCommit(configDir, pathToFileURL(outside).href, Date.now() + 20_000),
    ).toBeNull();

    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        method: "source",
        rootDir: join(configDir, "..", "source"),
        phase: "complete",
        commit: "abc",
      })}\n`,
    );
    expect(
      runningSourceCommit(configDir, pathToFileURL(modulePath).href, Date.now() + 20_000),
    ).toBeNull();
  });
});

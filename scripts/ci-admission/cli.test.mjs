// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots = [];
const cli = new URL("./cli.mjs", import.meta.url);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("CI admission CLI", () => {
  it("reads a piped payload from stdin", () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-ci-admission-cli-"));
    roots.push(root);
    const sha = "1".repeat(40);
    const result = spawnSync(
      process.execPath,
      [cli.pathname, "initialize", "--state", root, "--sha", sha],
      {
        encoding: "utf8",
        input: "{}",
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      frontier: { scannedHeadSha: sha, lastSuccessfulFullSha: null },
    });
    expect(JSON.parse(readFileSync(join(root, "ledger.json"), "utf8")).frontier).toMatchObject({
      scannedHeadSha: sha,
      lastSuccessfulFullSha: null,
    });
  });
});

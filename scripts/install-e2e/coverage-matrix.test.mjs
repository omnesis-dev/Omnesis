// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { installerCoverageMatrix } from "./coverage-matrix.mjs";

describe("installer coverage selection", () => {
  test("pull requests run the real isolation journey on one arm64 host", () => {
    expect(installerCoverageMatrix(false)).toEqual({
      include: [{ os: "macos-15", arch: "arm64", major: "15", scenario: "isolation" }],
    });
  });

  test("extended runs cover two macOS versions, Intel, and both dependency absences", () => {
    const rows = installerCoverageMatrix(true).include;
    expect([...new Set(rows.map(({ os }) => os))].sort()).toEqual([
      "macos-15",
      "macos-15-intel",
      "macos-26",
    ]);
    expect(new Set(rows.map(({ os, scenario }) => `${os}/${scenario}`)).size).toBe(rows.length);
    expect(rows.filter(({ scenario }) => scenario === "isolation").map(({ arch }) => arch)).toEqual(
      ["arm64", "arm64", "x86_64"],
    );
    expect(
      rows.filter(({ scenario }) => scenario === "isolation").map(({ major }) => major),
    ).toEqual(["15", "26", "15"]);
    expect(
      rows.filter(({ scenario }) => scenario !== "isolation").map(({ scenario }) => scenario),
    ).toEqual(["missing-node", "missing-homebrew"]);
  });

  test("ambiguous mode input cannot silently select weaker coverage", () => {
    for (const value of [undefined, "false", "true", 0, 1, null]) {
      expect(() => installerCoverageMatrix(value)).toThrow("extended must be a boolean");
    }
  });

  test("the workflow's real CLI emits its matrix and refuses ambiguous environment values", () => {
    const directory = mkdtempSync(join(tmpdir(), "installer-matrix-"));
    try {
      for (const [index, [mode, expected]] of [
        ["false", 1],
        ["true", 5],
        ["TRUE", null],
        ["", null],
      ].entries()) {
        // APFS commonly treats true/TRUE as the same filename.
        const output = join(directory, `output-${index}`);
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(new URL("./coverage-matrix.mjs", import.meta.url))],
          {
            env: { ...process.env, EXTENDED: mode, GITHUB_OUTPUT: output },
            encoding: "utf8",
          },
        );
        if (expected === null) {
          expect(result.status).not.toBe(0);
          expect(existsSync(output)).toBe(false);
        } else {
          expect(result.status, result.stderr).toBe(0);
          const line = readFileSync(output, "utf8");
          expect(line.startsWith("macos=")).toBe(true);
          expect(JSON.parse(line.slice("macos=".length)).include).toHaveLength(expected);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

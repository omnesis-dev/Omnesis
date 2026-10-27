// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Keep the PR floor small; nightly/manual runs exercise both architectures. */
export function installerCoverageMatrix(extended) {
  if (typeof extended !== "boolean") throw new TypeError("extended must be a boolean");
  const baseline = { os: "macos-15", arch: "arm64", major: "15", scenario: "isolation" };
  return {
    include: extended
      ? [
          baseline,
          { os: "macos-26", arch: "arm64", major: "26", scenario: "isolation" },
          { os: "macos-15-intel", arch: "x86_64", major: "15", scenario: "isolation" },
          { ...baseline, scenario: "missing-node" },
          { ...baseline, scenario: "missing-homebrew" },
        ]
      : [baseline],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!["true", "false"].includes(process.env.EXTENDED)) {
    throw new Error("EXTENDED must be exactly true or false");
  }
  const matrix = JSON.stringify(installerCoverageMatrix(process.env.EXTENDED === "true"));
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, `macos=${matrix}\n`);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { waitForChild } from "../lib/check-process.mjs";
assert.equal(process.platform, "linux");
const selection = JSON.parse(
  readFileSync(new URL("./relay-producer-baseline-selection.json", import.meta.url), "utf8"),
);
const child = spawn(
  process.execPath,
  [
    "scripts/run-check.mjs",
    "unit",
    ...selection.testFiles,
    "--testNamePattern",
    selection.testNamePattern,
  ],
  { stdio: "inherit", detached: true },
);
process.exitCode = await waitForChild(child);

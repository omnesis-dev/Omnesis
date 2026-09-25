// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { waitForChild } from "../lib/check-process.mjs";
import { assertTreeFingerprint } from "./tree-state.mjs";

async function run(command, args) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  return waitForChild(child);
}

if (process.env.OMNESIS_TREE_FINGERPRINT) {
  assertTreeFingerprint(process.env.OMNESIS_TREE_BASE, process.env.OMNESIS_TREE_FINGERPRINT);
}

let code = await run("npm", ["run", "format:check"]);
if (code === 0) code = await run("npm", ["run", "privacy:scan"]);
if (code === 0) code = await run("npm", ["run", "validate-universes"]);
process.exitCode = code;

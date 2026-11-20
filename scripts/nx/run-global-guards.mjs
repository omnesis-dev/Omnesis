// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { runCheckCommand, checkFailureMessage } from "../lib/check-process.mjs";
import { assertTreeFingerprint } from "./tree-state.mjs";

async function run(command, args) {
  return runCheckCommand(command, args, { env: process.env, detached: false });
}

if (process.env.OMNESIS_TREE_FINGERPRINT) {
  assertTreeFingerprint(process.env.OMNESIS_TREE_BASE, process.env.OMNESIS_TREE_FINGERPRINT);
}

try {
  let code = await run("npm", ["run", "format:check"]);
  if (code === 0) code = await run("npm", ["run", "privacy:scan"]);
  if (code === 0) code = await run("npm", ["run", "validate-universes"]);
  process.exitCode = code;
} catch (error) {
  process.stderr.write(`${checkFailureMessage(error)}\n`);
  process.exitCode = 1;
}

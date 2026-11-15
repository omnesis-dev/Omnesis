// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { runCheckCommand, checkFailureMessage } from "../lib/check-process.mjs";
import { allNativeBundles } from "./bundles.mjs";
import { assertTreeFingerprint } from "./tree-state.mjs";

async function run(command, args) {
  return runCheckCommand(command, args, { env: process.env, detached: false });
}

const commands = [
  ["npm", ["run", "format:check"]],
  ["npm", ["run", "privacy:scan"]],
  ["npm", ["run", "audit:prod"]],
  ["npm", ["run", "lint"]],
  ["npm", ["run", "checks:deadcode"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "typecheck:tests"]],
  ["npm", ["run", "validate-universes"]],
  ["npm", ["run", "parity:check"]],
  ["npm", ["run", "build", "--workspace", "@omnesis/extension"]],
  ["npm", ["run", "test"]],
  ["npm", ["run", "test:e2e:portal"]],
  ...allNativeBundles.map((name) => [process.execPath, ["scripts/nx/run-bundle.mjs", name]]),
];

try {
  for (const [command, args] of commands) {
    if (process.env.OMNESIS_TREE_FINGERPRINT) {
      assertTreeFingerprint(process.env.OMNESIS_TREE_BASE, process.env.OMNESIS_TREE_FINGERPRINT);
    }
    const code = await run(command, args);
    if (code !== 0) {
      process.exitCode = code;
      break;
    }
  }
} catch (error) {
  process.stderr.write(`${checkFailureMessage(error)}\n`);
  process.exitCode = 1;
}

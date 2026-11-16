// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { runCheckCommand } from "../lib/check-process.mjs";
for (let index = 0; index < 10; index++) {
  process.stdout.write(`[boundary-proof] repetition ${index + 1}/10\n`);
  const code = await runCheckCommand(process.execPath, [
    "scripts/run-check.mjs",
    "unit",
    "packages/collector/src/e2e/enrollment-terminal-cohort.windows.test.ts",
    "packages/cloud-relay/src/tls-router.test.ts",
  ]);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}

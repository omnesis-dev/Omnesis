// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { runCheckCommand } from "../lib/check-process.mjs";
for (let index = 0; index < 5; index++) {
  process.stdout.write(`[token-setup-proof] repetition ${index + 1}/5\n`);
  const code = await runCheckCommand(process.execPath, [
    "scripts/run-check.mjs",
    "unit",
    "packages/gateway/src/data/repositories/TokenRepository.test.ts",
  ]);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}

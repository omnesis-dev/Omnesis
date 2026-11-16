// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { runCheckCommand } from "../lib/check-process.mjs";
for (let index = 0; index < 5; index++) {
  process.stdout.write(`[boundary-proof] repetition ${index + 1}/5\n`);
  const code = await runCheckCommand(process.execPath, [
    "scripts/run-check.mjs",
    "unit",
    "packages/collector/src/e2e/enrollment-terminal-cohort.windows.test.ts",
    "packages/cloud-relay/src/tls-router.test.ts",
    "packages/gateway/src/data/repositories/TokenRepository.test.ts",
    "packages/gateway/src/bootstrap/upgrade-placeholder-canonical-names.test.ts",
    ...(index === 0 ? ["scripts/ci/windows-checks.test.mjs"] : []),
  ]);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}

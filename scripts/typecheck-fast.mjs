// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { main } from "./run-check.mjs";

const args = process.argv.slice(2);
process.exitCode = await main([
  "typecheck",
  ...(args.length ? args : ["packages/gateway", "packages/collector", "packages/cli"]),
]);

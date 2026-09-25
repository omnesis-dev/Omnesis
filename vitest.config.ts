// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // Fork pool gives each test file a fresh process — important for the
    // many suites that open unique per-test SQLite paths and hold native
    // handles (better-sqlite3, duckdb, node-llama-cpp).
    pool: "forks",
    // Direct focused invocations also need a bounded budget on shared hosts.
    maxWorkers: 4,
    // Let child processes write logs directly. Routing every line through the
    // worker RPC can leave an onUserConsoleLog call pending while a short-lived
    // fork exits, which Vitest reports as an EnvironmentTeardownError even
    // though every assertion passed.
    disableConsoleIntercept: true,
    testTimeout: 30000,
    // scripts/codemod-core-imports.test.mjs deliberately uses node:test, so it
    // is not globbed here; the release tooling tests and the PII guard run
    // under vitest from scripts/.
    include: [
      "evals/briefs/src/**/*.test.ts",
      "extension/src/**/*.test.ts",
      "extension/scripts/**/*.test.mjs",
      "packages/**/*.test.ts",
      "plugins/**/*.test.ts",
      "skills/**/*.test.ts",
      "scripts/release/**/*.test.mjs",
      "scripts/nx/**/*.test.mjs",
      "scripts/ci-admission/**/*.test.mjs",
      "scripts/pii-scan.test.mjs",
      "scripts/text-files.test.mjs",
      "scripts/typecheck-lanes.test.mjs",
      "scripts/dev-scripts-smoke.test.mjs",
      "scripts/ios-identity.test.mjs",
      "scripts/gateway-boot-budget.test.mjs",
      "scripts/run-e2e.test.mjs",
      "scripts/run-e2e-status.test.mjs",
      "scripts/run-check.test.mjs",
      "scripts/check-reporter.test.mjs",
      "scripts/check-parity.test.mjs",
      "scripts/record-replay-scenario.test.mjs",
      "scripts/lib/brain-cassette.test.mjs",
      "scripts/website-docs.test.mjs",
      "scripts/render-arch-substrate.test.mjs",
      "scripts/render-watch-examples.test.mjs",
      "scripts/render-sweep-examples.test.mjs",
    ],
  },
});

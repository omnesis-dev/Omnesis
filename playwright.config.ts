// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineConfig } from "@playwright/test";

// Isolated high-port instance — never the live gateway (7600). A fresh temp
// config dir per run means the gateway auto-generates its own token + self-
// signed TLS cert there; the spec reads the token from this same dir.
const port = Number(process.env.OMNESIS_PORTAL_TEST_PORT ?? 17800);

// Share ONE isolated config dir between the gateway (webServer subprocess) and
// the test workers: the gateway auto-generates its token + TLS cert under
// here, and the spec reads that token to authenticate its seeding fetch.
//
// Playwright evaluates this config file once in the parent and AGAIN in each
// forked worker, so a fresh `mkdtempSync` per evaluation would hand the
// workers a different (empty) dir than the one the gateway booted into. We
// allocate the dir exactly once in the parent and hand it down via a
// dedicated handoff env var (NOT OMNESIS_CONFIG_DIR — a developer may have
// that exported at their live config, which we must never touch). Each later
// evaluation reuses the handed-down dir.
const tempDir =
  process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR ??
  (process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "omnesis-playwright-")));
// The spec resolves its config dir from this same handoff var.
process.env.OMNESIS_CONFIG_DIR = tempDir;

// The gateway ALWAYS serves HTTPS (auto-generated self-signed cert by
// default — see packages/gateway/src/index.ts), so the baseURL is https and
// we trust the self-signed cert via ignoreHTTPSErrors. The webServer
// readiness probe hits the public, unauthenticated /health route and must
// likewise ignore the self-signed cert.
const baseURL = `https://localhost:${port}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  // Generous per-test budget: the SQL view mounts a heavy CodeMirror bundle
  // and a single shared gateway serves the suite serially, so view mounts can
  // be slow under load. One retry absorbs the residual timing flakiness
  // inherent to browser-driven e2e without masking a real DOM regression.
  timeout: 60000,
  retries: 1,
  use: {
    baseURL,
    headless: true,
    // Trust the gateway's self-signed cert for every browser request.
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    // Boot the real gateway under tsx — the same `npm run gateway` entrypoint
    // dev uses. NOT bun: there is no bun on the dev box or the CI runner.
    command: [
      `OMNESIS_GATEWAY_PORT=${port}`,
      `OMNESIS_LOG_LEVEL=warn`,
      `OMNESIS_CONFIG_DIR=${tempDir}`,
      `OMNESIS_DB_PATH=${join(tempDir, "omnesis.db")}`,
      `OMNESIS_ANALYTICS_DB_PATH=${join(tempDir, "analytics.db")}`,
      `npx tsx packages/gateway/src/index.ts`,
    ].join(" "),
    // Wait on the public /health route over HTTPS — a deterministic readiness
    // signal, never `networkidle` (which never fires on the portal's SSE/WS
    // pages). ignoreHTTPSErrors lets the probe trust the self-signed cert.
    url: `${baseURL}/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});

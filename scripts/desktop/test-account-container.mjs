// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (!process.env.OMNESIS_TEST_SCHEDULER_ACTIVE && process.env.CI !== "true") {
  throw new Error("Run this fixture through the installed E2E admission queue");
}
const root = await realpath(resolve("."));
const require = createRequire(import.meta.url);
const playwright = require("playwright/package.json").version;
const modules = dirname(dirname(await realpath(require.resolve("vitest/package.json"))));
const mountedDependencies = "/run/desktop-account-dependencies/node_modules";
const dependencyAliases = modules.startsWith(root + "/")
  ? []
  : ["--mount", `type=bind,source=${modules},target=${modules},readonly`];
const dockerfile = join(root, "scripts/desktop/account-test.Dockerfile");
const image =
  "omnesis-desktop-account-e2e:" +
  createHash("sha256")
    .update(await readFile(dockerfile))
    .update(playwright)
    .digest("hex")
    .slice(0, 16);
const nonce = randomUUID();
const name = "omnesis-desktop-e2e-" + nonce;
const scratch = await mkdtemp(join(tmpdir(), "omnesis-account-container-"));
const marker = join(scratch, "container.json");
await writeFile(
  marker,
  JSON.stringify({ format: 1, owner: "omnesis-desktop-account-e2e", nonce, hostname: name }),
  { mode: 0o600 },
);
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGTERM", abort);
process.once("SIGINT", abort);
async function command(args, cancellable = true) {
  await new Promise((done, reject) => {
    const child = spawn("docker", args, {
      stdio: "inherit",
      ...(cancellable ? { signal: controller.signal } : {}),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? done()
        : reject(new Error(`Desktop account fixture command failed (${code ?? signal})`)),
    );
  });
}
try {
  process.stdout.write("Preparing the isolated browser and Node fixture image.\n");
  await command([
    "build",
    "--file",
    dockerfile,
    "--build-arg",
    `PLAYWRIGHT_VERSION=${playwright}`,
    "--tag",
    image,
    join(root, "scripts/desktop"),
  ]);
  const entry = `set -euo pipefail
mkdir -p "$OMNESIS_ACCOUNT_SOURCE_ROOT"
tar -C /input --exclude=.git --exclude=.nx --exclude=node_modules --exclude=macos/build --exclude=macos/.node-fixture --exclude=macos/.codex-keychain-fixture --exclude=macos/.codex-backend-fixture --exclude=macos/.analytics-build-fixture -cf - . | tar -C "$OMNESIS_ACCOUNT_SOURCE_ROOT" -xf -
cd "$OMNESIS_ACCOUNT_SOURCE_ROOT"
node scripts/desktop/container-workspace.mjs
exec timeout --foreground 900 npm run test:e2e -- packages/collector/src/e2e/desktop-account.e2e.test.ts`;
  process.stdout.write("Running actual account onboarding with container-owned DNS and trust.\n");
  await command([
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--memory",
    "8g",
    "--cpus",
    "4",
    "--name",
    name,
    "--hostname",
    name,
    "--mount",
    `type=bind,source=${root},target=/input,readonly`,
    "--mount",
    `type=bind,source=${modules},target=${mountedDependencies},readonly`,
    ...dependencyAliases,
    "--mount",
    `type=bind,source=${marker},target=/run/desktop-account-container.json,readonly`,
    "--env",
    `OMNESIS_ACCOUNT_SOURCE_ROOT=${root}`,
    "--env",
    `OMNESIS_ACCOUNT_DEPENDENCIES=${mountedDependencies}`,
    "--env",
    "OMNESIS_ACCOUNT_INPUT_ROOT=/input",
    "--env",
    `OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE=${nonce}`,
    "--env",
    "OMNESIS_TEST_SCHEDULER_ACTIVE",
    "--env",
    "OMNESIS_E2E_WORKERS=1",
    image,
    "bash",
    "-c",
    entry,
  ]);
} finally {
  await command(["rm", "--force", name], false).catch(() => {});
  await rm(scratch, { recursive: true, force: true });
  process.off("SIGTERM", abort);
  process.off("SIGINT", abort);
}

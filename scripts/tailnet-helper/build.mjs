#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Build the Tailscale helper program into packages/tailnet-helper/dist/bin,
 * where the gateway finds it and offers its own Tailscale device. Go is the one
 * already installed when it is recent enough, else the pinned toolchain this
 * build downloads and checks (toolchain.mjs).
 *
 *   node scripts/tailnet-helper/build.mjs [--os linux --arch arm64] [--out path] [--best-effort]
 *
 * Without --os/--arch it builds for this machine. `npm run build` runs it with
 * --best-effort, so an install or update whose helper cannot be built still
 * completes, without the device, and says why; the next update tries again.
 * OMNESIS_TAILNET_HELPER_BUILD=0 skips it, for builds that package the
 * TypeScript alone. OMNESIS_TAILNET_HELPER_GO=pinned builds with the pinned
 * toolchain even where Go is installed.
 *
 * Everything it writes stays under the package's dist/ (outputs.mjs).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GO_CACHE_DIR, HELPER_DIR, helperProgram } from "./outputs.mjs";
import { goEnv, installedGo, pinnedGo, requiredGoVersion } from "./toolchain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const helperDir = join(root, HELPER_DIR);

const { values } = parseArgs({
  options: {
    os: { type: "string" },
    arch: { type: "string" },
    out: { type: "string" },
    "best-effort": { type: "boolean", default: false },
  },
});
const bestEffort = values["best-effort"];

function fail(message) {
  if (!bestEffort) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `Warning: the Tailscale helper was not built: ${message}\n` +
      "The gateway will not offer its own Tailscale device until it is. Everything else is unaffected; " +
      "the next update tries again, or run `npm run tailnet-helper:build` in this checkout.\n",
  );
  process.exit(0);
}

if (process.env.OMNESIS_TAILNET_HELPER_BUILD === "0") {
  process.stdout.write("Skipping the Tailscale helper (OMNESIS_TAILNET_HELPER_BUILD=0).\n");
  process.exit(0);
}

try {
  // The helper ships with the gateway and carries its product version.
  const version = JSON.parse(
    readFileSync(join(root, "packages/gateway/package.json"), "utf8"),
  ).version;
  const required = requiredGoVersion(readFileSync(join(helperDir, "go.mod"), "utf8"));
  const toolchain = JSON.parse(
    readFileSync(join(root, "scripts/tailnet-helper/go-toolchain.json"), "utf8"),
  );
  const cacheDir = join(root, GO_CACHE_DIR);
  // Nothing this build makes belongs outside dist/: a bin/ or .go/ beside it is
  // removed, so the checkout holds one toolchain and Git sees no stray files.
  for (const stale of ["bin", ".go"])
    rmSync(join(helperDir, stale), { recursive: true, force: true });
  const go =
    (process.env.OMNESIS_TAILNET_HELPER_GO === "pinned" ? null : installedGo(required)) ??
    (await pinnedGo({
      cacheDir,
      toolchain,
      log: (line) => process.stdout.write(`${line}\n`),
    }));

  const goos = values.os;
  const windows = goos === "windows" || (!goos && process.platform === "win32");
  const out = resolve(values.out ?? join(root, helperProgram(windows)));
  mkdirSync(dirname(out), { recursive: true });
  // Built beside its final name and moved into place, so a gateway starting the helper
  // meanwhile finds the old program or the new one, never half of one.
  const partial = `${out}.partial`;
  const env = { ...process.env, ...goEnv(cacheDir) };
  if (goos) env.GOOS = goos;
  if (values.arch) env.GOARCH = values.arch;

  process.stdout.write("Building the Tailscale helper...\n");
  const result = spawnSync(
    go,
    ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", partial, "."],
    { cwd: helperDir, env, stdio: "inherit" },
  );
  if (result.error) throw new Error(`could not run Go (${result.error.message})`);
  if (result.status !== 0) {
    rmSync(partial, { force: true });
    throw new Error(`go build exited ${result.status ?? result.signal}`);
  }
  renameSync(partial, out);
  process.stdout.write(`Built ${out}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

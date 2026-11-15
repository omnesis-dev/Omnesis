#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Build the Tailscale helper program into packages/tailnet-helper/bin, where
 * the gateway finds it. Needs the Go toolchain named in the helper's go.mod.
 *
 *   node scripts/tailnet-helper/build.mjs [--os linux --arch arm64] [--out path]
 *
 * Without --os/--arch it builds for this machine.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const helperDir = join(root, "packages/tailnet-helper");

const { values } = parseArgs({
  options: {
    os: { type: "string" },
    arch: { type: "string" },
    out: { type: "string" },
  },
});

// The helper ships with the gateway and carries its product version.
const version = JSON.parse(
  readFileSync(join(root, "packages/gateway/package.json"), "utf8"),
).version;
const goos = values.os;
const exe = goos === "windows" || (!goos && process.platform === "win32") ? ".exe" : "";
const out = resolve(values.out ?? join(helperDir, "bin", `omnesis-tailnet${exe}`));
mkdirSync(dirname(out), { recursive: true });

const env = { ...process.env, CGO_ENABLED: "0" };
if (goos) env.GOOS = goos;
if (values.arch) env.GOARCH = values.arch;

const result = spawnSync(
  "go",
  ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", out, "."],
  { cwd: helperDir, env, stdio: "inherit" },
);
if (result.error) {
  process.stderr.write(
    `Could not run the Go toolchain (${result.error.message}). Install Go (see go.mod in packages/tailnet-helper) and try again.\n`,
  );
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write(`Built ${out}\n`);

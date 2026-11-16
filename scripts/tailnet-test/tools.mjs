#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The programs the embedded-Tailscale end-to-end suites run as a private,
 * local tailnet: headscale (an open-source coordination server), Tailscale's
 * relay server (derper), Tailscale's own daemon and command line for the test
 * "machines", and the gateway's helper program built from this tree.
 *
 * headscale is downloaded at a pinned version and checked against its
 * published SHA-256. The Tailscale programs are built with the Go toolchain at
 * the version the helper's go.mod pins, so the test tailnet speaks exactly
 * what the helper does.
 *
 *   node scripts/tailnet-test/tools.mjs          # provision, print the paths as JSON
 *
 * Cached under OMNESIS_TAILNET_TOOLS_DIR, or ~/.cache/omnesis-tailnet-tools.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_DIR = join(ROOT, "packages/tailnet-helper");

export const HEADSCALE_VERSION = "0.29.7";
const HEADSCALE_SHA256 = {
  "darwin-amd64": "9e82977644388d4a61d460d6ff7d8207f4894dea9fc02e75c9d8f23576bf360b",
  "darwin-arm64": "1c2e772f35a61142a1582fba5e8919adaeace9a9b2abddd039f9872141585df0",
  "linux-amd64": "e827fc9b12d958bc95b081c4401dd63f8e0471d025b45b508535a920532150a8",
  "linux-arm64": "4357b38ac63c1e425f190819fd2ee078f13e01a6d7559b15811154e2475df5e4",
};

/** The Tailscale version the helper is built against, read from its go.mod. */
export function tailscaleVersion() {
  const mod = readFileSync(join(HELPER_DIR, "go.mod"), "utf8");
  const match = /^\s*(?:require\s+)?tailscale\.com\s+(v\S+)/m.exec(mod);
  if (!match) throw new Error("packages/tailnet-helper/go.mod does not require tailscale.com");
  return match[1];
}

function platform() {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!os || !arch)
    throw new Error(`No test tailnet tools for ${process.platform}/${process.arch}`);
  return `${os}-${arch}`;
}

/** Whether the Go toolchain these tools need can be run. */
export function goAvailable() {
  const result = spawnSync("go", ["version"], { encoding: "utf8" });
  return result.status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function headscale(cacheDir) {
  const key = platform();
  const target = join(cacheDir, `headscale-${HEADSCALE_VERSION}`);
  const expected = HEADSCALE_SHA256[key];
  if (existsSync(target) && sha256(target) === expected) return target;
  const asset = `headscale_${HEADSCALE_VERSION}_${key.replace("-", "_")}`;
  const url = `https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/${asset}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      const partial = `${target}.partial`;
      writeFileSync(partial, Buffer.from(await res.arrayBuffer()));
      const actual = sha256(partial);
      if (actual !== expected)
        throw new Error(`headscale checksum mismatch: ${actual} != ${expected}`);
      chmodSync(partial, 0o755);
      renameSync(partial, target);
      return target;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function tailscalePrograms(cacheDir) {
  const version = tailscaleVersion();
  const bin = join(cacheDir, `tailscale-${version}`);
  const names = ["tailscale", "tailscaled", "derper"];
  if (names.every((name) => existsSync(join(bin, name)))) {
    return Object.fromEntries(names.map((name) => [name, join(bin, name)]));
  }
  mkdirSync(bin, { recursive: true });
  run("go", ["install", ...names.map((name) => `tailscale.com/cmd/${name}@${version}`)], {
    env: { ...process.env, GOBIN: bin, CGO_ENABLED: "0", GOFLAGS: "-mod=mod" },
  });
  return Object.fromEntries(names.map((name) => [name, join(bin, name)]));
}

function helper() {
  run(process.execPath, [join(ROOT, "scripts/tailnet-helper/build.mjs")]);
  return join(
    HELPER_DIR,
    "bin",
    process.platform === "win32" ? "omnesis-tailnet.exe" : "omnesis-tailnet",
  );
}

/** Provision every tool and return their paths. Builds and downloads only what is missing. */
export async function ensureTailnetTools() {
  const cacheDir =
    process.env.OMNESIS_TAILNET_TOOLS_DIR ?? join(homedir(), ".cache", "omnesis-tailnet-tools");
  mkdirSync(cacheDir, { recursive: true });
  if (process.platform === "win32" || process.env.OMNESIS_TEST_PORTABLE_TAILNET === "1") {
    const { ensurePortableTailnetTools } = await import("./portable-tools.mjs");
    return ensurePortableTailnetTools(cacheDir);
  }
  return {
    headscale: await headscale(cacheDir),
    ...tailscalePrograms(cacheDir),
    helper: helper(),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tools = await ensureTailnetTools();
  process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
}

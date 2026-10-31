#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fetch the DuckDB extensions the gateway ships, verified against the pins in
 * `<package-dir>/duckdb-extensions/manifest.json`.
 *
 * Encrypted analytics storage needs DuckDB's `httpfs` extension (it carries
 * the OpenSSL-backed module that writes encrypted files), and DuckDB does not
 * link it in. Rather than letting DuckDB download it at run time — which an
 * offline gateway, a blocked egress or a read-only filesystem cannot do — the
 * product carries the exact binary DuckDB's repository serves for the pinned
 * DuckDB version, laid out the way DuckDB lays out an extension directory:
 *
 *   <package-dir>/duckdb-extensions/<duckdb version>/<platform>/<name>.duckdb_extension
 *
 * The gateway LOADs it from there by path. DuckDB still checks its signature
 * (unsigned extensions stay disabled) and refuses a build for another version
 * or platform; the pinned checksum makes the fetch reproducible on top.
 *
 * Usage:
 *   node scripts/duckdb-extensions.mjs --package-dir <dir> [--platform <p>]... [--best-effort]
 *     Fetch what is missing for this host's DuckDB (or each named platform).
 *     A copy already present is kept when it matches its pin. With
 *     --best-effort a failure is a warning and the exit status stays 0 — the
 *     gateway then falls back to downloading at run time, and says so.
 *   node scripts/duckdb-extensions.mjs pin --package-dir <dir> --duckdb-version vX.Y.Z
 *     Maintainers: download every supported platform's build for a new DuckDB
 *     version and rewrite the manifest's pins.
 *
 * OMNESIS_DUCKDB_EXTENSION_REPOSITORY replaces the manifest's repository (a
 * mirror); the pins are enforced either way.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";

/** The platforms Omnesis runs its gateway on: the Linux images and hosts, and macOS. */
export const SUPPORTED_PLATFORMS = ["linux_amd64", "linux_arm64", "osx_amd64", "osx_arm64"];

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;

export function manifestPath(packageDir) {
  return join(packageDir, "duckdb-extensions", "manifest.json");
}

export function readManifest(packageDir) {
  return JSON.parse(readFileSync(manifestPath(packageDir), "utf8"));
}

/** Where the gateway looks for a bundled extension — DuckDB's own extension-directory layout. */
export function bundledExtensionPath(packageDir, duckdbVersion, platform, name) {
  return join(packageDir, "duckdb-extensions", duckdbVersion, platform, `${name}.duckdb_extension`);
}

/** The DuckDB version and platform the package's own DuckDB reports — what LOAD will accept. */
export async function hostDuckDb(packageDir) {
  const require = createRequire(join(resolve(packageDir), "package.json"));
  const { DuckDBInstance } = require("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(
      "SELECT version(), (SELECT platform FROM pragma_platform())",
    );
    const [[version, platform]] = reader.getRows();
    return { version: String(version), platform: String(platform) };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function matchesPin(path, pin) {
  if (!existsSync(path)) return false;
  const content = readFileSync(path);
  return content.length === pin.size && sha256(content) === pin.sha256;
}

function extensionUrl(repository, duckdbVersion, platform, name) {
  return `${repository.replace(/\/+$/u, "")}/${duckdbVersion}/${platform}/${name}.duckdb_extension.gz`;
}

/**
 * Download one gzipped extension and return the decompressed binary. Every
 * attempt is checked against `pin` when one is given, so a truncated transfer
 * is retried like a dropped connection; a 404 is not retried.
 */
async function downloadExtension(url, pin, opts) {
  const {
    fetchImpl = fetch,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 404) {
        throw Object.assign(new Error(`${url} does not exist (HTTP 404)`), { final: true });
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const binary = gunzipSync(Buffer.from(await response.arrayBuffer()));
      if (pin && (binary.length !== pin.size || sha256(binary) !== pin.sha256)) {
        throw new Error(
          `checksum mismatch: got ${binary.length} bytes with SHA-256 ${sha256(binary)}, ` +
            `pinned ${pin.size} bytes with SHA-256 ${pin.sha256}`,
        );
      }
      return binary;
    } catch (error) {
      lastError = error;
      if (error.final) break;
      if (attempt < attempts) await delay(retryDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Could not fetch ${url}: ${lastError?.message ?? lastError}`, {
    cause: lastError,
  });
}

/** Write through a sibling temporary file so a reader never sees a half-written binary. */
function writeAtomically(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content);
    // Readable by every account, whatever the umask: an image's daemon runs
    // as an unprivileged user that did not build it.
    chmodSync(temporary, 0o644);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Make sure every pinned extension exists for each platform. `platforms`
 * defaults to the host DuckDB's own, whose version must be the manifest's.
 * Returns one entry per extension and platform.
 */
export async function ensureBundledExtensions({
  packageDir,
  platforms,
  manifest = readManifest(packageDir),
  host,
  repository = process.env.OMNESIS_DUCKDB_EXTENSION_REPOSITORY || manifest.repository,
  log = () => {},
  ...downloadOpts
}) {
  let targets = platforms;
  if (!targets || targets.length === 0) {
    const reported = host ?? (await hostDuckDb(packageDir));
    if (reported.version !== manifest.duckdbVersion) {
      throw new Error(
        `DuckDB ${reported.version} is installed, but ${manifestPath(packageDir)} pins extensions ` +
          `for DuckDB ${manifest.duckdbVersion}. Run \`node scripts/duckdb-extensions.mjs pin ` +
          `--package-dir <gateway package> --duckdb-version ${reported.version}\` and commit the manifest.`,
      );
    }
    targets = [reported.platform];
  }
  const results = [];
  for (const [name, pins] of Object.entries(manifest.extensions)) {
    for (const platform of targets) {
      const pin = pins[platform];
      if (!pin) {
        throw new Error(
          `${manifestPath(packageDir)} pins no ${name} build for ${platform} ` +
            `(pinned: ${Object.keys(pins).join(", ")})`,
        );
      }
      const path = bundledExtensionPath(packageDir, manifest.duckdbVersion, platform, name);
      if (matchesPin(path, pin)) {
        results.push({ name, platform, path, status: "present" });
        continue;
      }
      const url = extensionUrl(repository, manifest.duckdbVersion, platform, name);
      log(`Fetching DuckDB ${name} ${manifest.duckdbVersion} for ${platform} from ${url}`);
      writeAtomically(path, await downloadExtension(url, pin, downloadOpts));
      results.push({ name, platform, path, status: "fetched" });
    }
  }
  return results;
}

/** Download each supported platform's build for `duckdbVersion` and write its pins. */
export async function pinManifest({
  packageDir,
  duckdbVersion,
  platforms = SUPPORTED_PLATFORMS,
  manifest = readManifest(packageDir),
  repository = process.env.OMNESIS_DUCKDB_EXTENSION_REPOSITORY || manifest.repository,
  log = () => {},
  ...downloadOpts
}) {
  if (!/^v\d+\.\d+\.\d+$/u.test(duckdbVersion ?? "")) {
    throw new Error(`--duckdb-version must look like v1.2.3, got ${duckdbVersion}`);
  }
  const extensions = {};
  for (const name of Object.keys(manifest.extensions)) {
    extensions[name] = {};
    for (const platform of platforms) {
      const url = extensionUrl(repository, duckdbVersion, platform, name);
      log(`Pinning ${url}`);
      const binary = await downloadExtension(url, null, downloadOpts);
      extensions[name][platform] = { sha256: sha256(binary), size: binary.length };
    }
  }
  const next = { ...manifest, duckdbVersion, extensions };
  writeFileSync(manifestPath(packageDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function flagValues(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.push(value);
  }
  return values;
}

export async function main(argv, { log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const [packageDir] = flagValues(argv, "--package-dir");
  if (!packageDir) throw new Error("--package-dir <gateway package directory> is required");
  if (argv[0] === "pin") {
    const [duckdbVersion] = flagValues(argv, "--duckdb-version");
    await pinManifest({ packageDir, duckdbVersion, log });
    log(`Pinned DuckDB ${duckdbVersion} extensions in ${manifestPath(packageDir)}`);
    return 0;
  }
  const bestEffort = argv.includes("--best-effort");
  try {
    const results = await ensureBundledExtensions({
      packageDir,
      platforms: flagValues(argv, "--platform"),
      log,
    });
    for (const { name, platform, path, status } of results) {
      log(
        `DuckDB ${name} for ${platform}: ${status === "present" ? "verified" : "fetched"} at ${path}`,
      );
    }
    return 0;
  } catch (error) {
    if (!bestEffort) throw error;
    log(
      `WARNING: the DuckDB extensions Omnesis ships could not be put in place (${error.message}). ` +
        "Encrypted analytics storage will try to download DuckDB's httpfs extension the first " +
        "time it opens, which needs network access. Re-run this step with network access to fix it.",
    );
    return 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}

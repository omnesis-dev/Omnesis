// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  SUPPORTED_PLATFORMS,
  bundledExtensionPath,
  ensureBundledExtensions,
  hostDuckDb,
  main,
  pinManifest,
  readManifest,
} from "../duckdb-extensions.mjs";

const gatewayDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "gateway");
const binary = Buffer.from("an invented stand-in for an extension binary\n".repeat(64));
const pin = { sha256: createHash("sha256").update(binary).digest("hex"), size: binary.length };
const fast = { retryDelayMs: 0 };

let packageDir;

function writeManifest(manifest) {
  mkdirSync(join(packageDir, "duckdb-extensions"), { recursive: true });
  writeFileSync(join(packageDir, "duckdb-extensions", "manifest.json"), JSON.stringify(manifest));
}

const manifest = {
  duckdbVersion: "v9.8.7",
  repository: "https://extensions.example.org/",
  extensions: { httpfs: { linux_amd64: pin, osx_arm64: pin } },
};

/** A fetch that answers from a script of responses and records each URL. */
function scriptedFetch(responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return new Response(next.body, { status: next.status ?? 200 });
  };
  return { fetchImpl, calls };
}

beforeEach(() => {
  packageDir = mkdtempSync(join(tmpdir(), "omnesis-duckdb-extensions-"));
  writeManifest(manifest);
});

afterEach(() => {
  rmSync(packageDir, { recursive: true, force: true });
});

test("the gateway's pins cover every supported platform for the DuckDB it depends on", async () => {
  const pinned = readManifest(gatewayDir);
  expect(Object.keys(pinned.extensions.httpfs).sort()).toEqual([...SUPPORTED_PLATFORMS].sort());
  for (const entry of Object.values(pinned.extensions.httpfs)) {
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(entry.size).toBeGreaterThan(1_000_000);
  }
  expect((await hostDuckDb(gatewayDir)).version).toBe(pinned.duckdbVersion);
});

test("fetches a missing build into DuckDB's layout, then keeps a verified copy", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ body: gzipSync(binary) }]);
  const first = await ensureBundledExtensions({
    packageDir,
    platforms: ["linux_amd64"],
    fetchImpl,
    ...fast,
  });
  const path = bundledExtensionPath(packageDir, "v9.8.7", "linux_amd64", "httpfs");
  expect(first).toEqual([{ name: "httpfs", platform: "linux_amd64", path, status: "fetched" }]);
  expect(calls).toEqual([
    "https://extensions.example.org/v9.8.7/linux_amd64/httpfs.duckdb_extension.gz",
  ]);
  expect(readFileSync(path)).toEqual(binary);
  expect(statSync(path).mode & 0o777).toBe(0o644);

  const second = await ensureBundledExtensions({
    packageDir,
    platforms: ["linux_amd64"],
    fetchImpl,
  });
  expect(second[0].status).toBe("present");
  expect(calls).toHaveLength(1);
});

test("replaces a copy that no longer matches its pin", async () => {
  const path = bundledExtensionPath(packageDir, "v9.8.7", "osx_arm64", "httpfs");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "stale");
  const { fetchImpl } = scriptedFetch([{ body: gzipSync(binary) }]);
  const [result] = await ensureBundledExtensions({
    packageDir,
    platforms: ["osx_arm64"],
    fetchImpl,
    ...fast,
  });
  expect(result.status).toBe("fetched");
  expect(readFileSync(path)).toEqual(binary);
});

test("retries a dropped connection and a server error", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    new TypeError("fetch failed"),
    { status: 503, body: "busy" },
    { body: gzipSync(binary) },
  ]);
  await ensureBundledExtensions({ packageDir, platforms: ["linux_amd64"], fetchImpl, ...fast });
  expect(calls).toHaveLength(3);
});

test("refuses a download that does not match its pin and leaves nothing behind", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ body: gzipSync(Buffer.from("tampered")) }]);
  await expect(
    ensureBundledExtensions({
      packageDir,
      platforms: ["linux_amd64"],
      fetchImpl,
      attempts: 2,
      ...fast,
    }),
  ).rejects.toThrow(/checksum mismatch/u);
  expect(calls).toHaveLength(2);
  expect(readdirSync(join(packageDir, "duckdb-extensions"))).toEqual(["manifest.json"]);
});

test("does not retry a build the repository does not have", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 404, body: "" }]);
  await expect(
    ensureBundledExtensions({ packageDir, platforms: ["linux_amd64"], fetchImpl, ...fast }),
  ).rejects.toThrow(/HTTP 404/u);
  expect(calls).toHaveLength(1);
});

test("defaults to the host DuckDB's platform and refuses a version the manifest does not pin", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ body: gzipSync(binary) }]);
  await ensureBundledExtensions({
    packageDir,
    host: { version: "v9.8.7", platform: "osx_arm64" },
    fetchImpl,
  });
  expect(calls[0]).toContain("/v9.8.7/osx_arm64/");
  await expect(
    ensureBundledExtensions({
      packageDir,
      host: { version: "v9.9.0", platform: "osx_arm64" },
      fetchImpl,
    }),
  ).rejects.toThrow(/DuckDB v9\.9\.0 is installed.*pins extensions for DuckDB v9\.8\.7.*pin/su);
  await expect(
    ensureBundledExtensions({
      packageDir,
      host: { version: "v9.8.7", platform: "linux_arm64" },
      fetchImpl,
    }),
  ).rejects.toThrow(/pins no httpfs build for linux_arm64/u);
});

test("best effort turns a failure into a warning; the default fails", async () => {
  const lines = [];
  const log = (line) => lines.push(line);
  const args = ["--package-dir", packageDir, "--platform", "windows_amd64"];
  await expect(main(args, { log })).rejects.toThrow(/pins no httpfs build for windows_amd64/u);
  expect(await main([...args, "--best-effort"], { log })).toBe(0);
  expect(lines.at(-1)).toMatch(/^WARNING: .*needs network access/u);
  expect(existsSync(join(packageDir, "duckdb-extensions", "windows_amd64"))).toBe(false);
});

test("pin records each platform's checksum and size for a new DuckDB version", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ body: gzipSync(binary) }]);
  const next = await pinManifest({
    packageDir,
    duckdbVersion: "v9.9.0",
    platforms: ["linux_amd64", "osx_amd64"],
    fetchImpl,
  });
  expect(calls).toEqual([
    "https://extensions.example.org/v9.9.0/linux_amd64/httpfs.duckdb_extension.gz",
    "https://extensions.example.org/v9.9.0/osx_amd64/httpfs.duckdb_extension.gz",
  ]);
  expect(next.extensions).toEqual({ httpfs: { linux_amd64: pin, osx_amd64: pin } });
  expect(readManifest(packageDir)).toEqual(next);
  await expect(pinManifest({ packageDir, duckdbVersion: "1.2", fetchImpl })).rejects.toThrow(
    /v1\.2\.3/u,
  );
});

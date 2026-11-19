// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckCommand } from "../lib/check-process.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = join(ROOT, "scripts/tailnet-test/control");
const HELPER = join(ROOT, "packages/tailnet-helper");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "bin" ? [] : sourceFiles(path);
      return entry.name.endsWith(".go") || entry.name === "go.mod" || entry.name === "go.sum"
        ? [path]
        : [];
    });
}

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

/** Build fixture tools without a shell, with each compiler's complete cohort owned. */
export async function ensurePortableTailnetTools(cacheDirectory) {
  const goos = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform];
  const goarch = { x64: "amd64", arm64: "arm64" }[process.arch];
  if (!goos || !goarch)
    throw new Error(`Unsupported portable tailnet tool target ${process.platform}/${process.arch}`);
  const suffix = goos === "windows" ? ".exe" : "";
  const compiler = spawnSync("go", ["version"], {
    env: { ...process.env, GOTOOLCHAIN: "local" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 4096,
  });
  if (compiler.error || compiler.status !== 0)
    throw new Error("The local Go toolchain did not identify itself", { cause: compiler.error });
  const fingerprint = createHash("sha256")
    .update(`${goos}/${goarch}\n`)
    .update(compiler.stdout)
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .update(process.env.GOFLAGS ?? "")
    .update(process.env.GOTOOLCHAIN ?? "auto");
  for (const path of [...sourceFiles(FIXTURE), ...sourceFiles(HELPER)])
    fingerprint
      .update(path.slice(ROOT.length))
      .update("\0")
      .update(readFileSync(path))
      .update("\0");
  const digest = fingerprint.digest("hex");
  const directory = join(cacheDirectory, `portable-${goos}-${goarch}-${digest}`);
  const actor = join(directory, `tailnet-fixture${suffix}`);
  const cli = join(directory, `tailscale${suffix}`);
  const manifest = join(directory, "complete.json");
  const env = {
    ...process.env,
    GOMAXPROCS: "2",
    CGO_ENABLED: "0",
    GOOS: goos,
    GOARCH: goarch,
    GOWORK: "off",
    GOFLAGS: `${process.env.GOFLAGS ?? ""} -p=2`.trim(),
  };
  let complete = false;
  try {
    const record = JSON.parse(readFileSync(manifest, "utf8"));
    complete =
      record.source === digest &&
      existsSync(actor) &&
      existsSync(cli) &&
      record.actor === (await fileHash(actor)) &&
      record.cli === (await fileHash(cli));
  } catch {
    /* Missing or incomplete builds are never reusable. */
  }
  mkdirSync(directory, { recursive: true });
  if (!complete) {
    for (const args of [
      ["test", "-c", "-mod=readonly", "-p", "2", "-o", actor, "."],
      ["build", "-mod=readonly", "-p", "2", "-o", cli, "tailscale.com/cmd/tailscale"],
    ]) {
      const code = await runCheckCommand("go", args, { cwd: FIXTURE, env });
      if (code !== 0) throw new Error(`Portable tailnet tool build failed (${code})`);
    }
    writeFileSync(
      manifest,
      JSON.stringify({ source: digest, actor: await fileHash(actor), cli: await fileHash(cli) }),
    );
  }
  const code = await runCheckCommand(
    process.execPath,
    [join(ROOT, "scripts/tailnet-helper/build.mjs")],
    { cwd: ROOT, env },
  );
  if (code !== 0) throw new Error(`Gateway tailnet helper build failed (${code})`);
  return {
    headscale: "",
    tailscale: cli,
    tailscaled: "",
    derper: "",
    helper: join(HELPER, "bin", `omnesis-tailnet${suffix}`),
    portable: { actor, cliDirectory: directory },
  };
}

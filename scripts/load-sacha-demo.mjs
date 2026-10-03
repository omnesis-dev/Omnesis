#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  cp,
  mkdir,
  readFile,
  realpath,
  readdir,
  symlink,
  writeFile,
  open,
  access,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:https";
import { recordingWeek } from "../evals/universes/sacha-bellamy/_build/shared.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marker = "sacha-demo-instance.json";
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );

async function canonicalLocation(path) {
  let ancestor = resolve(path);
  const suffix = [];
  while (!(await exists(ancestor))) {
    suffix.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(await realpath(ancestor), ...suffix);
}

export async function assertIsolated(path) {
  const candidate = await canonicalLocation(path),
    live = await canonicalLocation(join(homedir(), ".config", "omnesis"));
  if (candidate === live || candidate.startsWith(live + "/"))
    throw new Error("Refusing the live Omnesis configuration directory");
  return candidate;
}

export function assertPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 7600)
    throw new Error("Choose an explicit high port other than 7600");
}

/** Copy settings and authentication into a newly created directory; never copy stores. */
export async function prepareInstance({ template, dir, port, asOf }) {
  if (!template || !dir) throw new Error("Explicit --template and --dir are required");
  assertPort(port);
  const source = await assertIsolated(template),
    destination = await assertIsolated(dir);
  const day =
    asOf ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  recordingWeek(day);
  // Exclusive mkdir makes an existing directory (including an empty one) a refusal.
  await mkdir(destination, { mode: 0o700 });
  const config = JSON.parse(await readFile(join(source, "omnesis.json"), "utf8"));
  await writeFile(join(destination, "omnesis.json"), JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  for (const item of ["token", ".env", "tls", "privacy-policy.md", "codex-runtimes"])
    if (await exists(join(source, item)))
      await cp(join(source, item), join(destination, item), { recursive: true, dereference: true });
  if (await exists(join(source, "codex-home", "auth.json"))) {
    await mkdir(join(destination, "codex-home"), { mode: 0o700 });
    await cp(
      join(source, "codex-home", "auth.json"),
      join(destination, "codex-home", "auth.json"),
      { dereference: true },
    );
  }
  await mkdir(join(destination, "models"), { mode: 0o700 });
  if (await exists(join(source, "models")))
    for (const item of await readdir(join(source, "models"))) {
      if (item === "manifest.json")
        await cp(join(source, "models", item), join(destination, "models", item), {
          dereference: true,
        });
      else if (/\.(?:bin|gguf)$/.test(item))
        await symlink(
          await realpath(join(source, "models", item)),
          join(destination, "models", item),
        );
    }
  await writeFile(
    join(destination, marker),
    JSON.stringify({
      kind: "sacha-demo",
      port,
      asOf: day,
      universe: join(destination, "universe"),
    }),
    { mode: 0o600 },
  );
  return destination;
}

export async function demoEnvironment(dir) {
  const configDir = await assertIsolated(dir);
  const info = JSON.parse(await readFile(join(configDir, marker), "utf8"));
  if (info.kind !== "sacha-demo" || info.universe !== join(configDir, "universe"))
    throw new Error("Invalid demo instance marker");
  assertPort(info.port);
  const token = (await readFile(join(configDir, "token"), "utf8")).trim();
  if (!token) throw new Error("The template must contain an admin token");
  return {
    info,
    env: {
      ...process.env,
      OMNESIS_CONFIG_DIR: configDir,
      OMNESIS_DB_PATH: join(configDir, "omnesis.db"),
      OMNESIS_INDEX_DB_PATH: join(configDir, "index.db"),
      OMNESIS_ANALYTICS_DB_PATH: join(configDir, "analytics.db"),
      OMNESIS_LOG_FILE: join(configDir, "runtime.log"),
      OMNESIS_MODEL_HASH_CACHE_DIR: join(configDir, "cache", "model-hashes"),
      OMNESIS_LLAMA_GPU: process.env.OMNESIS_LLAMA_GPU ?? "false",
      OMNESIS_GATEWAY_PORT: String(info.port),
      OMNESIS_GATEWAY_URL: `https://localhost:${info.port}`,
      OMNESIS_TOKEN: token,
      OMNESIS_BIND: "0.0.0.0",
      OMNESIS_SYNTHETIC: "1",
      OMNESIS_TEST_INSTANCE: "1",
      OMNESIS_SYNTH_PRE_DISCOVERED: "1",
      OMNESIS_SYNTH_UNIVERSE: info.universe,
      OMNESIS_TLS_CERT: join(configDir, "tls", "cert.pem"),
      OMNESIS_TLS_KEY: join(configDir, "tls", "key.pem"),
      NODE_EXTRA_CA_CERTS: join(configDir, "tls", "cert.pem"),
      OMNESIS_AGENT_FIXTURE: "",
    },
  };
}

async function startGateway(dir) {
  const { info, env } = await demoEnvironment(dir);
  if (await exists(join(dir, "omnesis.db")))
    throw new Error("Start requires a fresh prepared directory; choose a new --dir");
  // Reserve this generation before asynchronous work; competing launches must fail.
  const reservation = await open(join(dir, "start.guard"), "wx", 0o600);
  await reservation.close();
  const { buildUniverse } = await import("../evals/universes/sacha-bellamy/_build/build.mjs");
  await buildUniverse({ asOf: info.asOf, outDir: info.universe });
  await new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(info.port, "0.0.0.0", () => probe.close(resolvePromise));
  });
  const log = await open(join(dir, "gateway.log"), "a", 0o600);
  try {
    const child = spawn(
      "setsid",
      [
        process.execPath,
        "--import",
        "tsx",
        join(root, "packages/cli/src/index.ts"),
        "gateway",
        "serve",
      ],
      { cwd: root, env, stdio: ["ignore", log.fd, log.fd] },
    );
    await new Promise((ok, fail) => {
      child.once("spawn", ok);
      child.once("error", fail);
    });
    await writeFile(join(dir, "launcher.pid"), String(child.pid), { mode: 0o600 });
    child.unref();
  } finally {
    await log.close();
  }
  process.stdout.write(`Gateway launched; inspect ${join(dir, "gateway.log")} before seeding.\n`);
}

export async function seed(dir, { spawnProcess = spawn } = {}) {
  const { env } = await demoEnvironment(dir);
  const child = spawnProcess(
    process.execPath,
    ["--import", "tsx", join(root, "packages/collector/src/synthetic-demo-host.ts")],
    { cwd: root, env: { ...env, OMNESIS_SYNTH_RESIDENT: "1" }, stdio: "inherit" },
  );
  await new Promise((ok, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => (code === 0 ? ok() : fail(new Error(`Seed exited ${code}`))));
  });
}

export function summarizeReadiness(status, background, now = Date.now()) {
  const parser = background?.jobs?.find((job) => job.id === "enrichment.extractDates")?.observation;
  const links = background?.jobs?.find(
    (job) => job.id === "backfill.derivationSla.links",
  )?.observation;
  const linksPending = links?.progress?.kind === "queue" ? links.progress.remaining : null;
  const linksGroundTruthAt = links?.progress?.groundTruthAt ?? null;
  const linksFresh =
    Number.isFinite(linksGroundTruthAt) &&
    linksGroundTruthAt <= now &&
    now - linksGroundTruthAt <= 600_000;
  const documents = status.documents?.total ?? null,
    indexed = status.index?.totalIndexed ?? null;
  const parserPending = parser?.progress?.kind === "queue" ? parser.progress.remaining : null;
  const ready =
    Number.isSafeInteger(documents) &&
    documents > 0 &&
    status.index?.enabled === true &&
    Number.isSafeInteger(indexed) &&
    indexed >= documents &&
    parserPending === 0 &&
    ["idle", "running"].includes(parser.state) &&
    parser.inFlight === false &&
    linksPending === 0 &&
    linksFresh &&
    ["idle", "running"].includes(links.state) &&
    links.inFlight === false;
  return {
    documents,
    indexed,
    parserPending,
    parserState: parser?.state ?? "unknown",
    parserInFlight: parser?.inFlight ?? null,
    linksPending,
    linksState: links?.state ?? "unknown",
    linksInFlight: links?.inFlight ?? null,
    linksGroundTruthAt,
    linksFresh,
    ready,
  };
}

async function tlsJson(url, env) {
  const ca = await readFile(env.NODE_EXTRA_CA_CERTS);
  return new Promise((ok, fail) => {
    const req = request(
      url,
      { ca, headers: { Authorization: `Bearer ${env.OMNESIS_TOKEN}` } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) res.destroy(new Error("Status response exceeds limit"));
          else chunks.push(chunk);
        });
        res.on("error", fail);
        res.on("end", () => {
          if (res.statusCode !== 200)
            return fail(new Error(`Status endpoint returned HTTP ${res.statusCode}`));
          try {
            ok(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            fail(error);
          }
        });
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("Status request timed out")));
    req.on("error", fail);
    req.end();
  });
}

export async function readReadiness(dir, { getJson } = {}) {
  const { env } = await demoEnvironment(dir);
  const get = getJson ?? ((url) => tlsJson(url, env));
  const status = await get(new URL("/status", env.OMNESIS_GATEWAY_URL));
  if (!status.testInstance || !status.experimental)
    throw new Error("Refusing a gateway without synthetic/test identity");
  const jobs = await get(new URL("/admin/background-jobs", env.OMNESIS_GATEWAY_URL)).catch(
    () => null,
  );
  return summarizeReadiness(status, jobs);
}

export async function waitReady(
  dir,
  {
    timeoutMs = 1_800_000,
    pollMs = 5000,
    read = readReadiness,
    print = (line) => process.stdout.write(line + "\n"),
  } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(pollMs) || pollMs < 1)
    throw new Error("Positive timeout and poll interval required");
  const deadline = Date.now() + timeoutMs;
  let previous;
  while (true) {
    const status = await read(dir),
      line = JSON.stringify(status);
    if (line !== previous) {
      print(line);
      previous = line;
    }
    if (Date.now() >= deadline)
      throw new Error(
        "Readiness timed out; indexing, date parsing or graph derivation is incomplete",
      );
    if (status.ready) return status;
    await new Promise((ok) => setTimeout(ok, Math.min(pollMs, deadline - Date.now())));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--template", "--dir", "--port", "--as-of", "--timeout-ms"].includes(args[i]) ||
      !args[i + 1]
    )
      throw new Error(
        "Usage: load-sacha-demo.mjs prepare|start|seed|status|wait-ready --dir DIRECTORY [--template DIRECTORY --port HIGH_PORT --as-of YYYY-MM-DD --timeout-ms MILLISECONDS]",
      );
    options[args[i].slice(2).replace("as-of", "asOf").replace("timeout-ms", "timeoutMs")] =
      args[i + 1];
  }
  if (command === "prepare") await prepareInstance({ ...options, port: Number(options.port) });
  else if (command === "start" && options.dir) await startGateway(options.dir);
  else if (command === "seed" && options.dir) await seed(options.dir);
  else if (command === "status" && options.dir)
    process.stdout.write(JSON.stringify(await readReadiness(options.dir)) + "\n");
  else if (command === "wait-ready" && options.dir)
    await waitReady(options.dir, options.timeoutMs ? { timeoutMs: Number(options.timeoutMs) } : {});
  else throw new Error("Use prepare, start, seed, status or wait-ready with explicit --dir");
}

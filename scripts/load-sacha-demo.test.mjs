// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { test } from "node:test";
import os, { tmpdir, homedir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  assertIsolated,
  assertPort,
  prepareInstance,
  demoEnvironment,
  summarizeReadiness,
  waitReady,
  seed,
} from "./load-sacha-demo.mjs";

test("fresh configuration preserves assignments/auth but excludes stores and mutable pools", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnesis-launcher-test-"));
  try {
    const template = join(root, "template"),
      dir = join(root, "fresh");
    await mkdir(join(template, "codex-home"), { recursive: true });
    await mkdir(join(template, "models"));
    const config = {
      inference: {
        assignments: {
          agent: "codex/demo-model",
          ocr: "tesseract",
          transcriber: "local/whisper-small",
        },
      },
    };
    await writeFile(join(template, "omnesis.json"), JSON.stringify(config));
    await writeFile(join(template, "token"), "fictional-admin-token");
    await writeFile(
      join(template, ".env"),
      `OMNESIS_DB_PATH=${join(template, "old.db")}\nOMNESIS_INDEX_DB_PATH=${join(template, "old-index.db")}\nOMNESIS_ANALYTICS_DB_PATH=${join(template, "old-analytics.db")}\nOMNESIS_LOG_FILE=${join(template, "old.log")}\nOMNESIS_LLAMA_GPU=true\n`,
    );
    await writeFile(join(root, "owner-auth.json"), '{"fictional":true}');
    await symlink(join(root, "owner-auth.json"), join(template, "codex-home/auth.json"));
    await writeFile(join(template, "models/manifest.json"), '{"models":[]}');
    await writeFile(join(template, "models/example.gguf"), "fictional-weight-bytes");
    await writeFile(join(template, "omnesis.db"), "must not be copied");
    await writeFile(join(template, "collector-token"), "must not be copied");
    await prepareInstance({ template, dir, port: 18762, asOf: "2026-12-31" });
    assert.deepEqual(JSON.parse(await readFile(join(dir, "omnesis.json"), "utf8")), config);
    assert.equal(await readFile(join(dir, "codex-home/auth.json"), "utf8"), '{"fictional":true}');
    await writeFile(join(dir, "codex-home/auth.json"), '{"independent":true}');
    assert.equal(await readFile(join(root, "owner-auth.json"), "utf8"), '{"fictional":true}');
    assert.equal((await readdir(dir)).includes("omnesis.db"), false);
    assert.equal((await readdir(dir)).includes("collector-token"), false);
    assert.equal(
      await realpath(join(dir, "models/example.gguf")),
      join(template, "models/example.gguf"),
    );
    await writeFile(join(dir, "models/manifest.json"), "independent manifest");
    assert.equal(await readFile(join(template, "models/manifest.json"), "utf8"), '{"models":[]}');
    const { env, info } = await demoEnvironment(dir);
    assert.equal(env.OMNESIS_GATEWAY_URL, "https://localhost:18762");
    assert.equal(env.OMNESIS_CONFIG_DIR, dir);
    assert.equal(env.OMNESIS_DB_PATH, join(dir, "omnesis.db"));
    assert.equal(env.OMNESIS_INDEX_DB_PATH, join(dir, "index.db"));
    assert.equal(env.OMNESIS_ANALYTICS_DB_PATH, join(dir, "analytics.db"));
    assert.equal(env.OMNESIS_LOG_FILE, join(dir, "runtime.log"));
    assert.equal(env.OMNESIS_LLAMA_GPU, process.env.OMNESIS_LLAMA_GPU ?? "false");
    const dotenv = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const {loadDotEnv}=await import(process.argv[1]);loadDotEnv();process.stdout.write(JSON.stringify({db:process.env.OMNESIS_DB_PATH,index:process.env.OMNESIS_INDEX_DB_PATH,analytics:process.env.OMNESIS_ANALYTICS_DB_PATH,log:process.env.OMNESIS_LOG_FILE,gpu:process.env.OMNESIS_LLAMA_GPU}));`,
        new URL("../packages/config/src/load-dotenv.ts", import.meta.url).href,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(dotenv.status, 0, dotenv.stderr);
    assert.deepEqual(JSON.parse(dotenv.stdout), {
      db: join(dir, "omnesis.db"),
      index: join(dir, "index.db"),
      analytics: join(dir, "analytics.db"),
      log: join(dir, "runtime.log"),
      gpu: process.env.OMNESIS_LLAMA_GPU ?? "false",
    });
    assert.equal(env.OMNESIS_SYNTHETIC, "1");
    assert.equal(info.asOf, "2026-12-31");
    await seed(dir, {
      spawnProcess: (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.ok(args.at(-1).endsWith("/scripts/demo-host/synthetic-demo-host.ts"));
        assert.equal(options.env.OMNESIS_SYNTH_RESIDENT, "1");
        assert.equal(options.env.OMNESIS_CONFIG_DIR, dir);
        assert.equal(options.stdio, "inherit");
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    });
    await assert.rejects(prepareInstance({ template, dir, port: 18762 }), /EEXIST/);
    await assert.rejects(
      prepareInstance({
        template,
        dir: join(root, "invalid-date"),
        port: 18762,
        asOf: "2026-02-30",
      }),
    );
    assert.equal((await readdir(root)).includes("invalid-date"), false);
    await assert.rejects(demoEnvironment(template), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production location and invalid ports fail before process launch", async () => {
  for (const port of [7600, 80, 65536, NaN, 18761.5]) assert.throws(() => assertPort(port));
  assert.doesNotThrow(() => assertPort(18762));
  await assert.rejects(assertIsolated(join(homedir(), ".config/omnesis")), /live/);
  await assert.rejects(assertIsolated(join(homedir(), ".config/omnesis/child")), /live/);
});

test("readiness requires warm vectors and an enabled idle date parser and current derived links; missing counts stay unknown", () => {
  const status = { documents: { total: 100 }, index: { enabled: true, totalIndexed: 80 } };
  const background = {
    jobs: [
      {
        id: "backfill.derivationSla.links",
        observation: {
          state: "idle",
          inFlight: false,
          progress: { kind: "queue", remaining: 0, groundTruthAt: Date.now() },
        },
      },
      {
        id: "enrichment.extractDates",
        observation: { state: "idle", inFlight: false, progress: { kind: "queue", remaining: 0 } },
      },
    ],
  };
  assert.equal(summarizeReadiness(status, background).ready, false);
  status.index.totalIndexed = 100;
  assert.equal(summarizeReadiness(status, background).ready, true);
  background.jobs[1].observation.progress.remaining = 1;
  assert.equal(summarizeReadiness(status, background).ready, false);
  assert.equal(summarizeReadiness(status, null).parserPending, null);
  assert.equal(summarizeReadiness(status, null).ready, false);
  background.jobs[1].observation.progress.remaining = 0;
  background.jobs[1].observation.state = "disabled";
  assert.equal(summarizeReadiness(status, background).ready, false);
});

test("link throughput cannot replace authoritative backlog or fresh ground truth", () => {
  const now = 1_000_000;
  const status = { documents: { total: 100 }, index: { enabled: true, totalIndexed: 100 } };
  const parser = {
    id: "enrichment.extractDates",
    observation: { state: "idle", inFlight: false, progress: { kind: "queue", remaining: 0 } },
  };
  const links = {
    id: "backfill.derivationSla.links",
    observation: {
      state: "running",
      inFlight: false,
      progress: { kind: "queue", remaining: 0, groundTruthAt: now },
    },
  };
  const background = {
    jobs: [
      parser,
      links,
      {
        id: "backfill.linkBatch",
        observation: { state: "idle", inFlight: false, progress: { kind: "queue", remaining: 0 } },
      },
    ],
  };
  assert.equal(summarizeReadiness(status, background, now).ready, true);
  links.observation.progress.remaining = 27_707;
  assert.equal(summarizeReadiness(status, background, now).linksPending, 27_707);
  assert.equal(summarizeReadiness(status, background, now).ready, false);
  links.observation.progress.remaining = 0;
  for (const groundTruthAt of [undefined, now - 600_001, now + 1]) {
    links.observation.progress.groundTruthAt = groundTruthAt;
    assert.equal(summarizeReadiness(status, background, now).ready, false);
  }
  links.observation.progress.groundTruthAt = now;
  links.observation.inFlight = true;
  assert.equal(summarizeReadiness(status, background, now).ready, false);
  links.observation.inFlight = false;
  for (const state of ["disabled", "error", "paused"]) {
    links.observation.state = state;
    assert.equal(summarizeReadiness(status, background, now).ready, false);
  }
  background.jobs.splice(1, 1);
  assert.equal(summarizeReadiness(status, background, now).linksPending, null);
  assert.equal(summarizeReadiness(status, background, now).ready, false);
});

test("foreground readiness wait prints changed counts and rejects incomplete timeout", async () => {
  let calls = 0;
  const lines = [];
  await waitReady("unused-fixture-path", {
    timeoutMs: 1000,
    pollMs: 1,
    print: (line) => lines.push(line),
    read: async () => ({
      documents: 100,
      indexed: ++calls < 3 ? 80 : 100,
      parserPending: 0,
      ready: calls >= 3,
    }),
  });
  assert.equal(lines.length, 2);
  await assert.rejects(
    waitReady("unused-fixture-path", {
      timeoutMs: 5,
      pollMs: 1,
      print: () => {},
      read: async () => ({ ready: false }),
    }),
    /timed out/,
  );
});

test("missing live root remains protected beneath a symlinked home config parent", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "fictional-home-isolation-"));
  const originalHome = os.homedir;
  try {
    const home = join(fixtureRoot, "home"),
      target = join(fixtureRoot, "config-target");
    await mkdir(home);
    await mkdir(target);
    await symlink(target, join(home, ".config"));
    os.homedir = () => home;
    syncBuiltinESMExports();
    await assert.rejects(assertIsolated(join(home, ".config", "omnesis")), /live/);
    await assert.rejects(assertIsolated(join(target, "omnesis")), /live/);
    await assert.rejects(assertIsolated(join(target, "omnesis", "not-created")), /live/);
    const alias = join(fixtureRoot, "home-alias");
    await symlink(home, alias);
    await assert.rejects(assertIsolated(join(alias, ".config", "omnesis")), /live/);
    assert.equal(
      await assertIsolated(join(target, "separate-demo")),
      join(target, "separate-demo"),
    );
    assert.equal((await readdir(target)).includes("omnesis"), false);
  } finally {
    os.homedir = originalHome;
    syncBuiltinESMExports();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

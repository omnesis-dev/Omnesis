// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { desktopProfile } from "./environment.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bridge(input: string, occupied = false) {
  const home = await mkdtemp(join(tmpdir(), "omnesis-desktop-process-"));
  roots.push(home);
  const foreign = join(home, "headless");
  await mkdir(foreign);
  await writeFile(join(foreign, "token"), "omn_test\n");
  await writeFile(join(foreign, ".env"), "OMNESIS_GATEWAY_URL=https://unreachable.example.test\n");
  const profile = desktopProfile(home);
  if (occupied) {
    await mkdir(profile.configDir, { recursive: true });
    await writeFile(
      join(profile.configDir, "desktop-install.json"),
      JSON.stringify({
        version: 1,
        owner: "another-application",
        mode: "home",
      }),
    );
  }
  const child = execFile(
    process.execPath,
    ["--import", "tsx", resolve("packages/cli/src/index.ts"), "desktop", "bridge"],
    {
      cwd: resolve("."),
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OMNESIS_CONFIG_DIR: foreign,
        OMNESIS_TOKEN: "omn_test",
        OMNESIS_GATEWAY_URL: "https://unreachable.example.test",
        OMNESIS_SECRET_SERVICE: "fictional-headless-keychain",
        OMNESIS_CLOUD_RELAY_URL: "https://unreachable.example.test",
        OMNESIS_CLOUD_RELAY_DEVICE_FILE: join(foreign, "absent-pair.json"),
      },
    },
  );
  const output = new Promise<{ stdout: string; stderr: string }>((resolveOutput, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.split("\n").length - 1 >= input.trim().split("\n").length) child.stdin!.end();
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveOutput({ stdout, stderr })
        : reject(new Error(`Desktop bridge exited ${code}: ${stderr}`)),
    );
  });
  // Keep stdin open until all replies arrive: EOF deliberately cancels work.
  child.stdin!.write(input);
  try {
    const result = await output;
    expect(await readFile(join(foreign, "token"), "utf8")).toBe("omn_test\n");
    expect((await readdir(foreign)).sort()).toEqual([".env", "token"]);
    return { ...result, profile };
  } finally {
    child.stdin!.end();
  }
}

test("real desktop CLI serves its framed protocol without adopting headless authority", async () => {
  const { stdout, stderr } = await bridge(
    [
      JSON.stringify({ version: 1, id: "fresh-status", command: "status" }),
      JSON.stringify({ version: 2, id: "unsupported-version", command: "status" }),
      JSON.stringify({ version: 1, id: "stop-empty", command: "stop" }),
      "",
    ].join("\n"),
  );
  const messages = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        version: 1,
        id: "fresh-status",
        ok: true,
        result: { phase: "welcome" },
      }),
      expect.objectContaining({
        version: 1,
        ok: false,
        error: expect.objectContaining({ code: "INVALID_REQUEST" }),
      }),
      expect.objectContaining({
        version: 1,
        id: "stop-empty",
        ok: true,
        result: { phase: "welcome" },
      }),
    ]),
  );
  expect(stdout + stderr).not.toContain("omn_test");
}, 30_000);

test("real desktop CLI refuses an unowned install record without starting a replacement", async () => {
  const { stdout, profile } = await bridge(
    JSON.stringify({ version: 1, id: "foreign-status", command: "status" }) + "\n",
    true,
  );
  expect(JSON.parse(stdout).result.phase).toBe("error");
  expect(
    JSON.parse(await readFile(join(profile.configDir, "desktop-install.json"), "utf8")).owner,
  ).toBe("another-application");
  expect(await readdir(profile.configDir)).toEqual(["desktop-install.json"]);
}, 30_000);

// Only dispatch and the transport are local fakes: index, environment selection,
// and dotenv loading execute normally against this test's private home.
test.each([
  ["desktop", "bridge"],
  ["--", "desktop", "bridge"],
  ["--", "--", "desktop", "--", "bridge"],
  ["status"],
  ["--", "--", "status"],
])(
  "bootstrap isolates only the effective desktop command: %j",
  async (...args) => {
    const home = await mkdtemp(join(tmpdir(), "omnesis-bootstrap-isolation-"));
    roots.push(home);
    const headless = join(home, "headless");
    await mkdir(headless, { mode: 0o700 });
    const dotenv = "FICTIONAL_BOOTSTRAP_VALUE=headless-only\n";
    await writeFile(join(headless, ".env"), dotenv, { mode: 0o600 });
    await writeFile(join(headless, "token"), "fictional-token\n", { mode: 0o600 });
    const result = join(home, "result.json");
    const main = join(home, "main.mjs");
    await writeFile(
      main,
      `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.TEST_RESULT, JSON.stringify({
  config: process.env.OMNESIS_CONFIG_DIR,
  service: process.env.OMNESIS_SECRET_SERVICE,
  value: process.env.FICTIONAL_BOOTSTRAP_VALUE ?? null,
  reads: globalThis.fixtureReads,
  transports: globalThis.fixtureTransports,
}));
`,
    );
    const transport = join(home, "transport.mjs");
    await writeFile(
      transport,
      `
export async function initializePairedDeviceTransport() { globalThis.fixtureTransports++; }
`,
    );
    const entry = join(home, "entry.mjs");
    const index = pathToFileURL(resolve("packages/cli/src/index.ts")).href;
    await writeFile(
      entry,
      `
import fs from 'node:fs';
import { sep } from 'node:path';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
globalThis.fixtureReads = [];
globalThis.fixtureTransports = 0;
const originalRead = fs.readFileSync;
const watchedDirectory = process.env.OMNESIS_CONFIG_DIR + sep;
fs.readFileSync = function(path, ...options) {
  if (typeof path === 'string' && path.startsWith(watchedDirectory))
    globalThis.fixtureReads.push(path);
  return originalRead.call(this, path, ...options);
};
syncBuiltinESMExports();
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === ${JSON.stringify(index)} && specifier === './main.js')
    return { url: ${JSON.stringify(pathToFileURL(main).href)}, shortCircuit: true };
  if (specifier === '@omnesis/cloud-relay/bootstrap')
    return { url: ${JSON.stringify(pathToFileURL(transport).href)}, shortCircuit: true };
  return nextResolve(specifier, context);
}});
process.argv = [process.execPath, 'omnesis', ...JSON.parse(process.env.TEST_ARGS)];
await import(${JSON.stringify(index)});
`,
    );
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      OMNESIS_CONFIG_DIR: headless,
      OMNESIS_SECRET_SERVICE: "fictional-headless-service",
      OMNESIS_CLOUD_RELAY_DEVICE_FILE: join(headless, "absent-device.json"),
      OMNESIS_RUNTIME_MODE: "test",
      OMNESIS_TELEMETRY: "0",
      OMNESIS_E2E_BOOTSTRAP: "1",
      TEST_RESULT: result,
      TEST_ARGS: JSON.stringify(args),
    });
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--import", createRequire(import.meta.url).resolve("tsx"), entry],
      { cwd: resolve("."), env, timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    const state = JSON.parse(await readFile(result, "utf8"));
    if (args.find((argument) => argument !== "--") === "desktop") {
      const profile = desktopProfile(home);
      expect(state).toEqual({
        config: profile.configDir,
        service: profile.secretService,
        value: null,
        reads: [],
        transports: 0,
      });
    } else {
      expect(state).toEqual({
        config: headless,
        service: "fictional-headless-service",
        value: "headless-only",
        reads: expect.any(Array),
        transports: 1,
      });
      // Windows validates and reads through its native private-file primitive.
      if (process.platform !== "win32") expect(state.reads).toEqual([join(headless, ".env")]);
    }
    expect(await readFile(join(headless, ".env"), "utf8")).toBe(dotenv);
    expect(await readFile(join(headless, "token"), "utf8")).toBe("fictional-token\n");
    expect((await readdir(headless)).sort()).toEqual([".env", "token"]);
  },
  30_000,
);

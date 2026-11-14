// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const tsx = pathToFileURL(require.resolve("tsx")).href;
const bootstrap = new URL("./load-env.ts", import.meta.url).href;
const roots: string[] = [];
const unsafe = "OMNESIS_BOOTSTRAP_INVENTED_VALUE=untrusted\nOMNESIS_CLOUD_RELAY_ENABLED=1\n";
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], platform = "win32", repairFailure = false, safe = false) {
  const dir = mkdtempSync(join(tmpdir(), "cli-bootstrap-test-"));
  roots.push(dir);
  const dotenv = join(dir, ".env");
  writeFileSync(
    dotenv,
    platform === "win32" && !safe ? unsafe : "OMNESIS_BOOTSTRAP_INVENTED_VALUE=trusted\n",
  );
  const primitive = join(dir, "private-reader.mjs");
  writeFileSync(
    primitive,
    `
import { appendFileSync, readFileSync } from 'node:fs';
const record = (entry) => appendFileSync(process.env.TEST_LOG, JSON.stringify(entry) + '\\n');
export function readWindowsPrivateFileContentsSync(path) {
  record({ kind: 'read-request', path });
  if (process.env.TEST_BOOTSTRAP_SAFE === '1') return readFileSync(path);
  throw Object.assign(new Error('Fictional unsafe access controls'), { code: 'EPRIVATE' });
}
export function secureWindowsPrivatePathSync(path, kind) {
  record({ kind, path });
  if (process.env.TEST_REPAIR_FAILURE === '1') throw new Error('Fictional unsafe owner');
}
`,
  );
  const entry = join(dir, "entry.mjs");
  writeFileSync(
    entry,
    `
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@omnesis/platform/windows-private-file')
    return { url: ${JSON.stringify(pathToFileURL(primitive).href)}, shortCircuit: true };
  if (specifier === '@omnesis/cloud-relay/bootstrap')
    throw new Error('UNTRUSTED_BOOTSTRAP_GADGET_REACHED');
  return nextResolve(specifier, context);
}});
process.argv = [process.execPath, 'omnesis', ...JSON.parse(process.env.TEST_ARGS)];
Object.defineProperty(process, 'platform', { value: process.env.TEST_PLATFORM });
let continued = false;
process.on('exit', () => writeFileSync(process.env.TEST_RESULT, JSON.stringify({
  continued,
  value: process.env.OMNESIS_BOOTSTRAP_INVENTED_VALUE ?? null,
  relay: process.env.OMNESIS_CLOUD_RELAY_ENABLED ?? null,
})));
await import(${JSON.stringify(bootstrap)});
continued = true;
`,
  );
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TEMP", "TMP"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, {
    OMNESIS_CONFIG_DIR: dir,
    TEST_LOG: join(dir, "calls.jsonl"),
    TEST_RESULT: join(dir, "result.json"),
    TEST_ARGS: JSON.stringify(args),
    TEST_PLATFORM: platform,
    TEST_REPAIR_FAILURE: repairFailure ? "1" : "0",
    TEST_BOOTSTRAP_SAFE: safe ? "1" : "0",
  });
  const result = spawnSync(process.execPath, ["--import", tsx, entry], {
    env,
    encoding: "utf8",
    timeout: 15_000,
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
  });
  expect(result.error).toBeUndefined();
  const state = JSON.parse(readFileSync(env.TEST_RESULT!, "utf8"));
  let calls: Array<{ kind: string; path: string }> = [];
  try {
    calls = readFileSync(env.TEST_LOG!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { result, state, calls, dir, dotenv, contents: readFileSync(dotenv, "utf8") };
}

describe("CLI bootstrap permission repair", () => {
  test("exact local doctor repair delegates safe replacement and exits before parsing unsafe env", () => {
    const { result, state, calls, dir, dotenv, contents } = run(["doctor", "--fix-permissions"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Review the file, then rerun doctor --fix-permissions");
    expect(state).toEqual({ continued: false, value: null, relay: null });
    expect(calls).toEqual([
      { kind: "read-request", path: dotenv },
      { kind: "directory", path: dir },
      { kind: "file", path: dotenv },
    ]);
    expect(contents).toBe(unsafe);
  });

  test.each([
    ["doctor"],
    ["--help"],
    ["--fix-permissions", "doctor"],
    ["doctor", "--fix-permissions=true"],
    ["doctor", "--fix-permissions", "--fleet"],
    ["doctor", "--fix-permissions", "--device", "fictional-collector"],
    ["doctor", "--fix-permissions", "--gateway", "https://gateway.example.invalid"],
    ["doctor", "--fix-permissions", "--unknown"],
    ["gateway", "serve", "doctor", "--fix-permissions"],
    ["collector", "run", "doctor", "--fix-permissions"],
    ["sources", "doctor", "--fix-permissions"],
  ])("refuses bootstrap repair for other command arguments: %j", (...args) => {
    const { result, state, calls } = run(args);
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBe(2);
    expect(result.stderr).toContain("Windows access controls were not verified");
    expect(result.stderr).not.toContain("UNTRUSTED_BOOTSTRAP_GADGET_REACHED");
    expect(state).toEqual({ continued: false, value: null, relay: null });
    expect(calls.map((call) => call.kind)).toEqual(["read-request"]);
  });

  test("a verified Windows env continues normal bootstrap without permission repair", () => {
    const { result, state, calls, dotenv } = run(
      ["doctor", "--fix-permissions"],
      "win32",
      false,
      true,
    );
    expect(result.status).toBe(0);
    expect(state).toEqual({ continued: true, value: "trusted", relay: null });
    expect(calls).toEqual([{ kind: "read-request", path: dotenv }]);
  });

  test("failed access repair still exits without applying env values", () => {
    const { result, state, calls } = run(["doctor", "--fix-permissions"], "win32", true);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not be repaired");
    expect(state).toEqual({ continued: false, value: null, relay: null });
    expect(calls.map((call) => call.kind)).toEqual(["read-request", "directory"]);
  });

  test.each(["linux", "darwin"])("keeps ordinary %s dotenv bootstrap behavior", (platform) => {
    const { result, state, calls } = run(["doctor", "--fix-permissions"], platform);
    expect(result.status).toBe(0);
    expect(state).toEqual({ continued: true, value: "trusted", relay: null });
    expect(calls).toEqual([]);
  });
});

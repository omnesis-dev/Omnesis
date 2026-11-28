// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { qualifyDesktopAnalytics, qualifyDesktopAnalyticsRestore } from "./qualify-analytics.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-analytics-qualification-")));
  roots.push(scratch);
  return {
    input: join(scratch, "upstream"),
    target: join(scratch, "desktop"),
    node: process.execPath,
    architecture: "arm64",
    scratch,
    env: { OMNESIS_TOKEN: "invented-inherited-token" },
  };
}
function stageExtensions({ target }) {
  const assets = join(target, "packages/gateway/duckdb-extensions");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "manifest.json"), JSON.stringify({ duckdbVersion: "v1.5.6" }));
}

test("compatibility probes carry their fresh fixture key only on bounded private stdin", () => {
  const run = vi.fn().mockReturnValue({ status: 0, stdout: "qualified\n" });
  const f = fixture();
  qualifyDesktopAnalytics(f, { run, stageExtensions });
  expect(run).toHaveBeenCalledTimes(3);
  const inputs = run.mock.calls.map(([, , options]) => JSON.parse(options.input));
  expect(inputs.map(({ step }) => step)).toEqual([1, 2, 3]);
  expect(inputs.map(({ engineVersion }) => engineVersion)).toEqual(["v1.5.6", "v1.5.6", "v1.5.6"]);
  expect(new Set(inputs.map(({ key }) => key)).size).toBe(1);
  expect(inputs[0].key).toMatch(/^[a-f0-9]{64}$/u);
  expect(inputs[0].extension).toContain("osx_arm64/httpfs.duckdb_extension");
  expect(inputs[1].extension).toBeUndefined();
  expect(inputs[2].extension).toBe(inputs[0].extension);
  for (const [, args, options] of run.mock.calls) {
    expect(() => new Script(args[1])).not.toThrow();
    expect(JSON.stringify([args, options.env])).not.toContain(inputs[0].key);
    expect(options.env.OMNESIS_TOKEN).toBeUndefined();
    expect(options.timeout).toBe(60_000);
    expect(options.killSignal).toBe("SIGKILL");
  }
});

test("a failed native probe stops qualification and never includes its diagnostics in the build error", () => {
  const run = vi.fn().mockImplementation((_node, _args, options) => ({
    status: 1,
    stdout: options.input,
    stderr: options.input,
    error: new Error(options.input),
  }));
  expect(() => qualifyDesktopAnalytics(fixture(), { run, stageExtensions })).toThrow(
    /^The packaged analytics engine failed upstream encrypted-file interoperability$/u,
  );
  expect(run).toHaveBeenCalledTimes(1);
});

function restoreFixture() {
  const f = fixture();
  const home = join(f.scratch, "home"),
    runtime = join(f.scratch, "runtime"),
    configDir = join(home, "profile");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  const scope = {
    format: 1,
    configDir,
    instance: "desktop-" + "a".repeat(16),
    secretService: "dev.omnesis.desktop." + "a".repeat(64),
  };
  return {
    ...f,
    runtime,
    home,
    scope,
    upstreamNode: process.execPath,
    upstream: { extension: join(f.scratch, "httpfs.duckdb_extension"), engineVersion: "v1.5.6" },
  };
}

test("compiled restore dispatch uses sealed native data authority and never carries keys in argv/environment", async () => {
  const f = restoreFixture();
  const run = vi
    .fn()
    .mockResolvedValueOnce("restore-source-ready\n")
    .mockResolvedValueOnce("compiled-restore-qualified\n");
  await qualifyDesktopAnalyticsRestore(f, { run });
  expect(run).toHaveBeenCalledTimes(2);
  const [[upstream, args, source], [launcher, targetArgs, target]] = run.mock.calls;
  expect(upstream).toBe(process.execPath);
  expect(args[2]).toBe(f.input);
  expect(launcher).toBe(join(f.runtime, "runtime-exec"));
  expect(targetArgs.slice(0, 3)).toEqual([
    "--data-use",
    Buffer.from(JSON.stringify(f.scope)).toString("base64url"),
    "--node",
  ]);
  expect(targetArgs.at(-1)).toBe(f.runtime);
  expect(() => new Script(args[1])).not.toThrow();
  expect(() => new Script(targetArgs[4])).not.toThrow();
  const input = JSON.parse(source.input),
    restore = JSON.parse(target.input);
  expect(input.key).toMatch(/^[a-f0-9]{64}$/u);
  expect(restore.sourceKey).toBe(input.key);
  expect(restore.destinationKey).not.toBe(input.key);
  for (const [executable, argv, options] of run.mock.calls) {
    expect(JSON.stringify([executable, argv, options.env])).not.toContain(input.key);
    expect(JSON.stringify([executable, argv, options.env])).not.toContain(restore.destinationKey);
    expect(options.env.OMNESIS_RUNTIME_MODE).toBe("test");
    expect(options.env.OMNESIS_TELEMETRY).toBe("0");
    expect(options.env.OMNESIS_E2E_ANALYTICS_RESTORE).toBe("1");
  }
});

test.each(["source", "target"])(
  "restore %s failure is latched without a later success marker",
  async (role) => {
    const f = restoreFixture(),
      failure = Object.assign(new Error("Invented ownership failure"), {
        cleanupFailure: "invented-owned-client",
      });
    const run = vi.fn();
    if (role === "target") run.mockResolvedValueOnce("restore-source-ready\n");
    run.mockRejectedValueOnce(failure);
    await expect(qualifyDesktopAnalyticsRestore(f, { run })).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(role === "source" ? 1 : 2);
  },
);

test("a wrong source marker cannot dispatch the compiled target", async () => {
  const run = vi.fn().mockResolvedValue("invented-private-output");
  await expect(qualifyDesktopAnalyticsRestore(restoreFixture(), { run })).rejects.toThrow(
    /^Analytics restore source did not qualify$/u,
  );
  expect(run).toHaveBeenCalledTimes(1);
});

test.skipIf(process.platform === "win32")(
  "a real closed child with failed tree observation retains an unconfirmed process receipt",
  async () => {
    const f = restoreFixture(),
      bin = join(f.home, "bin"),
      failed = join(f.home, "observation-failed"),
      calls = join(f.home, "calls");
    mkdirSync(bin, { mode: 0o700 });
    const fake = join(bin, "node");
    writeFileSync(
      fake,
      `#!${process.execPath}
 const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(failed)},'failed');fs.appendFileSync(${JSON.stringify(calls)},'source');process.stdout.write('restore-source-ready\\n');});
 `,
      { mode: 0o700 },
    );
    chmodSync(fake, 0o700);
    const ps = join(bin, "ps");
    writeFileSync(
      ps,
      `#!${process.execPath}
process.exit(1);
`,
      { mode: 0o700 },
    );
    chmodSync(ps, 0o700);
    // This test-local PATH is restored after its exact owned operation settles.
    const previous = process.env.PATH;
    process.env.PATH = bin + ":" + previous;
    try {
      const failure = await qualifyDesktopAnalyticsRestore({ ...f, upstreamNode: fake }).then(
        () => null,
        (error) => error,
      );
      expect(failure?.cleanupFailure).toBe("analytics-qualification-client");
      expect(readFileSync(calls, "utf8")).toBe("source");
      expect(existsSync(failed)).toBe(true);
      const receipt = JSON.parse(
        readFileSync(join(f.home, "analytics-restore-source-process.json"), "utf8"),
      );
      expect(receipt).toMatchObject({ rootClosed: true, treeJoined: false });
    } finally {
      // Retain this tiny private fixture evidence after unconfirmed descendant observation.
      roots.splice(roots.indexOf(f.scratch), 1);
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "both real fixture clients join before successful control-plane qualification returns",
  async () => {
    const f = restoreFixture();
    const fake = join(f.home, "fixture-node");
    const script = `#!${process.execPath}
const target=process.argv[2]==='--data-use';
process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(target?'compiled-restore-qualified\\n':'restore-source-ready\\n'));
`;
    writeFileSync(fake, script, { mode: 0o700 });
    writeFileSync(join(f.runtime, "runtime-exec"), script, { mode: 0o700 });
    let failure;
    try {
      await qualifyDesktopAnalyticsRestore({ ...f, upstreamNode: fake });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (failure?.cleanupFailure !== undefined) roots.splice(roots.indexOf(f.scratch), 1);
    }
    for (const role of ["source", "target"]) {
      const receipt = JSON.parse(
        readFileSync(join(f.home, `analytics-restore-${role}-process.json`), "utf8"),
      );
      expect(receipt).toMatchObject({ rootClosed: true, treeJoined: true, code: 0, forced: false });
    }
  },
);

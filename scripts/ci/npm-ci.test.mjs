// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { npmJavaScriptEntry } from "./npm-ci.mjs";
import { npmCiFixture } from "../test-fixtures/npm-ci-fixture.mjs";

const SCRIPT = join(import.meta.dirname, "npm-ci.sh");
const dirs = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-npm-ci-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the wrapper in a scratch directory against a fake `npm`. Each entry of
 * `installs` scripts one `npm ci`: "ok" installs cleanly, "dropped" exits 0
 * but records two optional packages as failed in its debug log, the way npm
 * treats an optional package it could not fetch or build, "uncompiled" records
 * smart-whisper and the dependency nested under it the way npm does when its
 * native build fails, "both" records all four, "fail" exits 1, and "hang"
 * starts a child, the way an install script would, and waits on it forever.
 * `path` replaces the directories searched after the fake's own.
 */
function runShell({ installs, args = [], env = {}, path = process.env.PATH }) {
  const dir = scratch();
  writeFileSync(
    join(dir, "npm"),
    `#!/bin/sh
printf '%s|%s' "$npm_package_config_node_gyp_nodedir" "$npm_config_nodedir" > header-env
n=$(($(cat count 2>/dev/null || echo 0) + 1)); echo "$n" > count
logs=; prev=
for arg in "$@"; do [ "$prev" = --logs-dir ] && logs="$arg"; prev="$arg"; done
[ -d "$logs" ] || { echo "no log directory: $*" >&2; exit 9; }
echo "$*" | sed "s| --logs-dir $logs||" >> calls
log="$logs/2026-01-01T00_00_00_000Z-debug-0.log"
echo "1 verbose cli ci" > "$log"
kind="$(sed -n "\${n}p" script)"
case "$kind" in
  dropped|both)
    echo "2 verbose reify failed optional dependency $PWD/node_modules/@scope/binding" >> "$log"
    echo "3 verbose reify failed optional dependency $PWD/node_modules/ffmpeg-static" >> "$log" ;;
  fail) exit 1 ;;
  hang)
    sleep 300 &
    echo "$!" > "hung-$n"
    wait
    exit 0 ;;
esac
case "$kind" in
  uncompiled|both)
    echo "4 verbose reify failed optional dependency $PWD/node_modules/smart-whisper" >> "$log"
    echo "5 verbose reify failed optional dependency $PWD/node_modules/smart-whisper/node_modules/node-addon-api" >> "$log" ;;
esac
`,
  );
  chmodSync(join(dir, "npm"), 0o755);
  writeFileSync(join(dir, "script"), `${installs.join("\n")}\n`);
  const result = spawnSync("sh", [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${path}`, NPM_CI_RETRY_SECONDS: "0", ...env },
    // Only a safety net: the wrapper under test bounds every attempt itself.
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  const [headers, legacy] = readFileSync(join(dir, "header-env"), "utf8").split("|");
  expect(existsSync(join(headers, "include", "node", "common.gypi"))).toBe(true);
  expect(legacy).toBe("");
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  const hung = calls
    .map((_, i) => join(dir, `hung-${i + 1}`))
    .filter((file) => existsSync(file))
    .map((file) => Number(readFileSync(file, "utf8")));
  return { status: result.status, stderr: result.stderr, calls, hung };
}

const runtimes = [
  [
    "portable Node",
    async ({ installs, args = [], env = {} }) => {
      const f = npmCiFixture(
        scratch(),
        installs.map((kind) => ({ dropped: "drop", uncompiled: "whisper" })[kind] ?? kind),
      );
      const outcome = await f.start(args, env).result;
      const calls = readFileSync(f.events, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((row) => row.stage === "ci")
        .map((row) => [row.args[0], ...row.args.slice(3)].join(" "));
      return { status: outcome.code, stderr: outcome.stderr, calls };
    },
  ],
  // This implementation targets Docker's POSIX environment and bundled headers;
  // every policy assertion also runs through the native Node implementation.
  ...(process.platform === "win32" ? [] : [["POSIX shell", runShell]]),
];

describe.each(runtimes)("%s dependency bootstrap", (_name, run) => {
  test("a clean install runs once", async () => {
    const { status, calls, stderr } = await run({ installs: ["ok"], args: ["--no-audit"] });
    expect(status).toBe(0);
    expect(calls).toEqual(["ci --no-audit"]);
    expect(stderr).toBe("");
  });

  test("installs again when npm dropped optional packages, and stops once they are back", async () => {
    const { status, calls, stderr } = await run({ installs: ["dropped", "dropped", "ok"] });
    expect(status).toBe(0);
    expect(calls).toHaveLength(3);
    expect(stderr).toContain(
      "npm ci dropped optional packages that failed to install: @scope/binding ffmpeg-static (attempt 1 of 3)",
    );
    expect(stderr).not.toContain("::warning::");
  });

  test("warns and carries on when the packages stay dropped", async () => {
    const { status, calls, stderr } = await run({ installs: ["dropped", "dropped", "dropped"] });
    expect(status).toBe(0);
    expect(calls).toHaveLength(3);
    expect(stderr).toContain("::warning::npm ci dropped optional packages");
    expect(stderr).toContain("after 3 attempts; this tree lacks them");
  });

  test("fails a build that requires its optional packages when they stay dropped", async () => {
    const { status, calls, stderr } = await run({
      installs: ["dropped", "dropped", "dropped"],
      env: { NPM_CI_REQUIRE_OPTIONAL: "1" },
    });
    expect(status).toBe(1);
    expect(calls).toHaveLength(3);
    expect(stderr).toContain("@scope/binding ffmpeg-static, after 3 attempts");
    expect(stderr).toContain("this build requires them");
    expect(stderr).not.toContain("::warning::");
  });

  test("a build that requires its optional packages passes once they are back", async () => {
    const { status, calls } = await run({
      installs: ["dropped", "ok"],
      env: { NPM_CI_REQUIRE_OPTIONAL: "1" },
    });
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
  });

  test("a package that failed to compile is reported once and never retried", async () => {
    const { status, calls, stderr } = await run({ installs: ["uncompiled"] });
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(stderr).toBe(
      "::notice::npm ci could not build smart-whisper on this host; this tree runs without it\n",
    );
  });

  test("retries only for the packages that can come back", async () => {
    const { status, calls, stderr } = await run({ installs: ["both", "uncompiled"] });
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(stderr).toContain(
      "npm ci dropped optional packages that failed to install: @scope/binding ffmpeg-static (attempt 1 of 3)",
    );
    expect(stderr).not.toContain("node-addon-api");
    expect(stderr).not.toContain("::warning::");
    expect(stderr).toContain("::notice::npm ci could not build smart-whisper on this host");
  });

  test("a build that requires its optional packages requires that one too", async () => {
    const { status, calls, stderr } = await run({
      installs: ["uncompiled", "uncompiled", "uncompiled"],
      env: { NPM_CI_REQUIRE_OPTIONAL: "1" },
    });
    expect(status).toBe(1);
    expect(calls).toHaveLength(3);
    expect(stderr).toContain(
      "node-addon-api smart-whisper, after 3 attempts, and this build requires them",
    );
    expect(stderr).not.toContain("::notice::");
  });

  test("still fails when npm ci keeps failing", async () => {
    const { status, calls, stderr } = await run({ installs: ["fail", "fail", "fail"] });
    expect(status).toBe(1);
    expect(calls).toHaveLength(3);
    expect(stderr).toContain("npm ci failed after 3 attempts");
  });

  test("recovers from a failed install followed by a good one", async () => {
    const { status, calls } = await run({ installs: ["fail", "ok"] });
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
  });
});

/** Whether a command is on this host's PATH. */
const onPath = (name) => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;

/** Wait until a process has exited and been reaped. */
async function gone(pid) {
  await vi.waitFor(
    () => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return;
        throw error;
      }
      throw new Error(`process ${pid} is still running`);
    },
    { timeout: 10_000, interval: 50 },
  );
}

// The deadline needs `timeout` (or `gtimeout`), which a stock macOS lacks; the
// Docker build image and the Linux runners have it.
describe.runIf(process.platform !== "win32" && (onPath("timeout") || onPath("gtimeout")))(
  "POSIX shell attempt deadline",
  () => {
    const env = { NPM_CI_ATTEMPT_TIMEOUT_SECONDS: "1" };

    test("ends an attempt that hangs, with its install scripts, and installs again", async () => {
      const { status, calls, stderr, hung } = runShell({ installs: ["hang", "ok"], env });
      expect(status).toBe(0);
      expect(calls).toHaveLength(2);
      expect(stderr).toContain("npm ci did not finish within 1s; the end of its debug log:");
      expect(stderr).toContain("1 verbose cli ci");
      expect(stderr).toContain("npm ci did not finish within 1s (attempt 1 of 3); retrying in 0s");
      expect(stderr).not.toContain("npm ci failed");
      expect(hung).toHaveLength(1);
      await gone(hung[0]);
    });

    test("gives up when every attempt hangs", async () => {
      const { status, calls, stderr, hung } = runShell({
        installs: ["hang", "hang"],
        env: { ...env, NPM_CI_ATTEMPTS: "2" },
      });
      expect(status).toBe(1);
      expect(calls).toHaveLength(2);
      expect(stderr.match(/npm ci did not finish within 1s; the end/gu)).toHaveLength(2);
      expect(stderr).toContain("npm ci did not finish within 1s (attempt 1 of 2)");
      expect(stderr).toContain("npm ci failed after 2 attempts");
      expect(hung).toHaveLength(2);
      for (const pid of hung) await gone(pid);
    });

    test("a failure inside the deadline is an ordinary failure", () => {
      const { status, calls, stderr } = runShell({
        installs: ["fail", "ok"],
        env: { NPM_CI_ATTEMPT_TIMEOUT_SECONDS: "60" },
      });
      expect(status).toBe(0);
      expect(calls).toHaveLength(2);
      expect(stderr).toContain("npm ci failed (attempt 1 of 3)");
      expect(stderr).not.toContain("did not finish");
    });
  },
);

describe.runIf(process.platform !== "win32")("POSIX shell without a deadline", () => {
  /** A PATH holding only the commands the wrapper uses, so no `timeout`. */
  function withoutTimeout() {
    const bin = scratch();
    for (const name of [
      "sh",
      "node",
      "cat",
      "date",
      "grep",
      "mktemp",
      "rm",
      "sed",
      "sleep",
      "sort",
      "tail",
      "tr",
    ]) {
      const found = spawnSync("sh", ["-c", `command -v ${name}`], {
        encoding: "utf8",
      }).stdout.trim();
      symlinkSync(found, join(bin, name));
    }
    return bin;
  }

  test("installs unbounded on a host with no timeout command", () => {
    const { status, calls, stderr } = runShell({
      installs: ["fail", "ok"],
      path: withoutTimeout(),
    });
    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(stderr).toContain("npm ci failed (attempt 1 of 3)");
  });

  test("installs unbounded when the deadline is off", () => {
    const { status, calls, stderr } = runShell({
      installs: ["ok"],
      env: { NPM_CI_ATTEMPT_TIMEOUT_SECONDS: "0" },
    });
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(stderr).toBe("");
  });

  test("refuses a deadline that is not a whole number of seconds", () => {
    const result = spawnSync("sh", [SCRIPT], {
      cwd: scratch(),
      encoding: "utf8",
      env: { ...process.env, NPM_CI_ATTEMPT_TIMEOUT_SECONDS: "15m" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      "NPM_CI_ATTEMPT_TIMEOUT_SECONDS must be a whole number of seconds: 15m\n",
    );
  });
});

/** A gzipped npm tarball holding only `package/package.json`. */
function packTarball(dir, manifest) {
  const source = join(dir, "src", manifest.name);
  mkdirSync(join(source, "package"), { recursive: true });
  writeFileSync(join(source, "package", "package.json"), JSON.stringify(manifest));
  const file = join(dir, `${manifest.name}.tgz`);
  const tar = spawnSync(
    process.platform === "win32" ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar",
    ["-czf", file, "-C", source, "package"],
    { encoding: "utf8" },
  );
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return readFileSync(file);
}

/**
 * A project whose lockfile resolves one required and one optional package
 * from a local registry that answers 503 to the optional package's tarball
 * for its first `failures` requests.
 */
async function projectWithFlakyOptional(failures) {
  const dir = scratch();
  const tarballs = new Map(
    ["kept", "binding"].map((name) => [
      `/${name}/-/${name}-1.0.0.tgz`,
      packTarball(dir, { name, version: "1.0.0" }),
    ]),
  );
  let remaining = failures;
  const server = createServer((req, res) => {
    const body = tarballs.get(req.url);
    if (body && req.url.startsWith("/binding/") && remaining > 0) {
      remaining -= 1;
      res.writeHead(503).end();
    } else if (body) {
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const registry = `http://127.0.0.1:${server.address().port}`;
  const entry = (name) => {
    const url = `/${name}/-/${name}-1.0.0.tgz`;
    const integrity = `sha512-${createHash("sha512").update(tarballs.get(url)).digest("base64")}`;
    return { version: "1.0.0", resolved: `${registry}${url}`, integrity };
  };
  const project = join(dir, "project");
  mkdirSync(project);
  const root = {
    name: "project",
    version: "1.0.0",
    dependencies: { kept: "1.0.0" },
    optionalDependencies: { binding: "1.0.0" },
  };
  writeFileSync(join(project, "package.json"), JSON.stringify(root));
  writeFileSync(
    join(project, "package-lock.json"),
    JSON.stringify({
      name: "project",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": root,
        "node_modules/binding": { ...entry("binding"), optional: true },
        "node_modules/kept": entry("kept"),
      },
    }),
  );
  return { project, cache: join(dir, "cache"), registry, close: () => server.close() };
}

/** Run a command to completion without blocking the registry in this process. */
async function exec(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.resume();
  const [status] = await once(child, "close");
  return { status, stderr };
}

/** Keep real npm tarball/retry behavior, with offline headers for packages that compile no native code. */
async function execBootstrap(fixture, args, env) {
  const actualNpm = await npmJavaScriptEntry(env);
  const runtime = npmCiFixture(fixture.project);
  writeFileSync(runtime.npmCli, `require(${JSON.stringify(actualNpm)});\n`);
  const started = runtime.start(args, { ...env, npm_execpath: runtime.npmCli });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // The production entry owns and joins its npm/header descendants on IPC disconnect.
    if (started.child.connected) started.child.disconnect();
  }, 45_000);
  try {
    const result = await started.result;
    if (timedOut)
      throw new Error(`Real npm bootstrap exceeded its fixture deadline: ${result.stderr}`);
    return { status: result.code, stderr: result.stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe("portable Node bootstrap against the real npm", () => {
  const npmArgs = (fixture) => [
    "--no-audit",
    "--no-fund",
    "--fetch-retries=0",
    `--cache=${fixture.cache}`,
    `--registry=${fixture.registry}/`,
  ];
  const env = {
    ...process.env,
    NPM_CI_RETRY_SECONDS: "0",
    npm_config_update_notifier: "false",
  };

  test("npm ci exits 0 without an optional package whose tarball failed", async () => {
    const fixture = await projectWithFlakyOptional(Infinity);
    try {
      const result = await exec(
        process.execPath,
        [await npmJavaScriptEntry(env), "ci", ...npmArgs(fixture)],
        { cwd: fixture.project, env },
      );
      expect(result.status).toBe(0);
      expect(existsSync(join(fixture.project, "node_modules/kept/package.json"))).toBe(true);
      expect(existsSync(join(fixture.project, "node_modules/binding"))).toBe(false);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("the wrapper installs again and gets the optional package back", async () => {
    const fixture = await projectWithFlakyOptional(1);
    try {
      const result = await execBootstrap(fixture, npmArgs(fixture), {
        ...env,
        NPM_CI_REQUIRE_OPTIONAL: "1",
      });
      expect(result.stderr).toContain(
        "npm ci dropped optional packages that failed to install: binding (attempt 1 of 3)",
      );
      expect(result.status).toBe(0);
      expect(existsSync(join(fixture.project, "node_modules/binding/package.json"))).toBe(true);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("the wrapper fails a build that requires it when the package stays missing", async () => {
    const fixture = await projectWithFlakyOptional(Infinity);
    try {
      const result = await execBootstrap(fixture, npmArgs(fixture), {
        ...env,
        NPM_CI_ATTEMPTS: "2",
        NPM_CI_REQUIRE_OPTIONAL: "1",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("binding, after 2 attempts, and this build requires them");
    } finally {
      fixture.close();
    }
  }, 60_000);
});

describe("images that require their optional packages", () => {
  const root = join(import.meta.dirname, "..", "..");
  const workflow = (name) =>
    parse(readFileSync(join(root, ".github", "workflows", name), "utf8")).jobs;
  const stepsOf = (jobs) => Object.values(jobs).flatMap((job) => job.steps ?? []);

  test("the published image's dependency stage reads the requirement", () => {
    const stage = readFileSync(join(root, "Dockerfile"), "utf8")
      .split(/^FROM /mu)
      .find((text) => text.startsWith("base AS runtime-dependencies"));
    expect(stage).toMatch(/^ARG NPM_CI_REQUIRE_OPTIONAL=0$/mu);
    expect(stage).toMatch(/sh scripts\/ci\/npm-ci\.sh/u);
  });

  test.each(["release.yml", "docker-publish.yml"])("%s requires them", (name) => {
    const steps = stepsOf(workflow(name));
    const pushes = steps.filter((step) => /docker\/build-push-action/u.test(step.uses ?? ""));
    expect(pushes.length).toBeGreaterThan(0);
    for (const step of pushes) expect(step.with["build-args"]).toBe("NPM_CI_REQUIRE_OPTIONAL=1");
    for (const step of steps.filter((s) => /docker buildx build/u.test(s.run ?? "")))
      expect(step.run).toContain("--build-arg NPM_CI_REQUIRE_OPTIONAL=1");
  });

  test("an emulated image build installs without the attempt deadline", () => {
    const stages = readFileSync(join(root, "Dockerfile"), "utf8")
      .split(/^FROM /mu)
      .filter((text) => /sh scripts\/ci\/npm-ci\.sh/u.test(text));
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) {
      expect(stage).toMatch(/^ARG BUILDPLATFORM$/mu);
      expect(stage).toMatch(/^ARG TARGETPLATFORM$/mu);
      expect(stage).toMatch(
        /^RUN if \[ "\$TARGETPLATFORM" != "\$BUILDPLATFORM" \]; then export NPM_CI_ATTEMPT_TIMEOUT_SECONDS=0; fi \\$/mu,
      );
    }
  });

  test.each(["scripts/docker-e2e/Dockerfile", "scripts/docker-e2e/systemd/Dockerfile"])(
    "the %s test image installs through the wrapper and requires them",
    (path) => {
      const dockerfile = readFileSync(join(root, path), "utf8");
      expect(dockerfile).toMatch(/NPM_CI_REQUIRE_OPTIONAL=1 sh scripts\/ci\/npm-ci\.sh/u);
      expect(dockerfile).not.toMatch(/^\s*(RUN\s+|&&\s+)npm ci\b/mu);
    },
  );
});

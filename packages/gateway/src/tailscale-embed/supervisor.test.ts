// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  spawnOwnedChildProcess,
  ownedProcessCleanupReceipt,
  type OwnedChildProcess,
} from "@omnesis/core";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { helperEnvironment, HelperSupervisor, type SupervisorSnapshot } from "./supervisor.js";

const FAKE = fileURLToPath(new URL("./testing/fake-helper.mjs", import.meta.url));
const launch = {
  binary: FAKE,
  stateDir: "/unused",
  hostname: "omnesis",
  socketPath: "/unused.sock",
  fallbackCert: "c",
  fallbackKey: "k",
};

/** Runs a script with this Node, whatever "binary" names, with extra environment. */
function nodeSpawner(extraEnv: NodeJS.ProcessEnv = {}, script = FAKE) {
  const seen: { env?: NodeJS.ProcessEnv; args?: string[] } = {};
  const spawner = (_binary: string, args: string[], env: NodeJS.ProcessEnv) => {
    seen.env = env;
    seen.args = args;
    return spawnOwnedChildProcess(process.execPath, [script, ...args], {
      env: { ...env, ...extraEnv },
    });
  };
  return { spawner, seen };
}

function until(
  sup: HelperSupervisor,
  predicate: (s: SupervisorSnapshot) => boolean,
  ms = 10_000,
): Promise<SupervisorSnapshot> {
  return new Promise((resolve, reject) => {
    if (predicate(sup.snapshot())) return resolve(sup.snapshot());
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out; last ${JSON.stringify(sup.snapshot())}`));
    }, ms);
    const off = sup.onChange((s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        off();
        resolve(s);
      }
    });
  });
}

const supervisors: HelperSupervisor[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(...args: ConstructorParameters<typeof HelperSupervisor>): HelperSupervisor {
  const sup = new HelperSupervisor(...args);
  supervisors.push(sup);
  return sup;
}

describe("helperEnvironment", () => {
  test("preserves case-sensitive POSIX proxy variables without inheriting Windows paths", () => {
    expect(
      helperEnvironment(
        {
          HTTPS_PROXY: "https://upper.example.com",
          https_proxy: "https://lower.example.com",
          Path: "/other",
          SystemRoot: "C:\\Windows",
        },
        "linux",
      ),
    ).toEqual({
      HTTPS_PROXY: "https://upper.example.com",
      https_proxy: "https://lower.example.com",
    });
  });

  test("passes Windows host paths and canonicalizes allowed names without credentials", () => {
    expect(
      helperEnvironment(
        {
          Path: "C:\\Tools",
          systemroot: "C:\\Windows",
          windir: "C:\\Windows",
          userprofile: "C:\\Users\\Example",
          localappdata: "C:\\Users\\Example\\AppData\\Local",
          appdata: "C:\\Users\\Example\\AppData\\Roaming",
          temp: "C:\\Temp",
          tmp: "C:\\Temp",
          https_proxy: "https://proxy.example.com",
          lc_all: "C.UTF-8",
          ts_authkey: "withheld",
          omnesis_keyring_passphrase: "withheld",
          anthropic_api_key: "withheld",
        },
        "win32",
      ),
    ).toEqual({
      PATH: "C:\\Tools",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      USERPROFILE: "C:\\Users\\Example",
      LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
      APPDATA: "C:\\Users\\Example\\AppData\\Roaming",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      HTTPS_PROXY: "https://proxy.example.com",
      LC_ALL: "C.UTF-8",
    });
  });

  test("passes only what the helper needs: no secrets, no Tailscale variables", () => {
    expect(
      helperEnvironment({
        PATH: "/bin",
        HOME: "/h",
        LC_ALL: "C.UTF-8",
        HTTPS_PROXY: "http://proxy.example.com:3128",
        SSL_CERT_FILE: "/etc/ssl/ca.pem",
        TS_AUTHKEY: "test-auth-key",
        TS_CLIENT_SECRET: "y",
        ANTHROPIC_API_KEY: "sk-example",
        OMNESIS_KEYRING_PASSPHRASE: "hunter2",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "http://proxy.example.com:3128",
      SSL_CERT_FILE: "/etc/ssl/ca.pem",
    });
  });
});

describe("HelperSupervisor", () => {
  test("starts the helper with its launch flags, without TS_ variables, and reports its status", async () => {
    const { spawner, seen } = nodeSpawner({ OMNESIS_FAKE_TAILNET_SCENARIO: "connected" });
    const sup = make(spawner, {
      PATH: process.env.PATH,
      TS_AUTHKEY: "test-auth-key-should-not-pass",
    });
    sup.send({ type: "configure", public: { enabled: true, paths: ["/mcp"] } });
    await sup.start({ ...launch, controlUrl: "http://127.0.0.1:1" });
    const running = await until(sup, (s) => s.status?.public.state === "on");
    expect(running.process).toBe("running");
    expect(running.status).toMatchObject({
      backend: "running",
      node: { dnsName: "omnesis.example-net.ts.net" },
    });
    expect(seen.env).not.toHaveProperty("TS_AUTHKEY");
    expect(seen.args).toEqual([
      "-state-dir",
      "/unused",
      "-hostname",
      "omnesis",
      "-socket",
      "/unused.sock",
      "-fallback-cert",
      "c",
      "-fallback-key",
      "k",
      "-control-url",
      "http://127.0.0.1:1",
    ]);
  });

  test("forwards commands and follows the helper's answers", async () => {
    const { spawner } = nodeSpawner({ OMNESIS_FAKE_TAILNET_SCENARIO: "needs-sign-in" });
    const sup = make(spawner, {});
    await sup.start(launch);
    const waiting = await until(sup, (s) => s.status?.backend === "needs-login");
    expect(waiting.status?.loginUrl).toMatch(/^https:\/\/login\.tailscale\.com\//);
    sup.send({ type: "login" });
    sup.send({ type: "login" });
    await until(sup, (s) => s.status?.backend === "running");
    sup.send({ type: "logout" });
    await until(sup, (s) => s.status?.backend === "needs-login");
  });

  test("restarts a crashed helper and replays its configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-sup-"));
    dirs.push(dir);
    const marker = join(dir, "runs");
    const crashing = join(dir, "crash-once.mjs");
    // Crashes on its first run, then behaves like the fake helper.
    writeFileSync(
      crashing,
      `import { existsSync, writeFileSync } from "node:fs";
       if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, "1"); process.exit(3); }
       await import(${JSON.stringify(pathToFileURL(FAKE).href)});`,
    );
    const { spawner } = nodeSpawner({ OMNESIS_FAKE_TAILNET_SCENARIO: "connected" }, crashing);
    const sup = make(spawner, {}, [20]);
    sup.send({ type: "configure", public: { enabled: true, paths: ["/mcp"] } });
    await sup.start(launch);
    await until(sup, (s) => s.process === "crashed");
    expect(sup.snapshot().reason).toMatch(/exited with status 3/);
    const after = await until(sup, (s) => s.status?.public.state === "on");
    expect(after.process).toBe("running");
  });

  test("stops a helper that speaks another protocol and does not restart it", async () => {
    const { spawner } = nodeSpawner({ OMNESIS_FAKE_TAILNET_PROTOCOL: "99" });
    const sup = make(spawner, {}, [10]);
    await sup.start(launch);
    const stopped = await until(
      sup,
      (s) => s.process === "crashed" && /protocol 99/.test(s.reason ?? ""),
    );
    expect(stopped.status).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(sup.snapshot().process).toBe("crashed");
  });

  test("starting again and again leaves exactly one helper running", async () => {
    const children: ChildProcess[] = [];
    const { spawner } = nodeSpawner();
    const sup = make((binary, args, env) => {
      const child = spawner(binary, args, env);
      children.push(child.child);
      return child;
    }, {});
    await sup.start(launch);
    await until(sup, (s) => s.process === "running");
    await Promise.all([
      sup.start({ ...launch, hostname: "omnesis-2" }),
      sup.start({ ...launch, hostname: "omnesis-3" }),
      sup.start({ ...launch, hostname: "omnesis-4" }),
    ]);
    const running = await until(
      sup,
      (s) => s.status?.node?.dnsName.startsWith("omnesis-4") === true,
    );
    expect(running.process).toBe("running");
    const alive = children.filter((c) => c.exitCode === null && c.signalCode === null);
    expect(alive).toHaveLength(1);
    expect(children).toHaveLength(2);
  });

  test("stop ends the helper and leaves nothing running", async () => {
    const { spawner } = nodeSpawner();
    const sup = make(spawner, {});
    await sup.start(launch);
    await until(sup, (s) => s.process === "running");
    await sup.stop();
    expect(sup.snapshot()).toEqual({ process: "stopped", status: null });
  });

  test("a helper that cannot be started is reported and retried", async () => {
    const sup = make(
      () => {
        throw new Error("ENOENT");
      },
      {},
      [60_000],
    );
    await sup.start(launch);
    expect(sup.snapshot()).toMatchObject({ process: "crashed", reason: "could not start: ENOENT" });
  });
});

/** Separate root events from the owner's independently confirmed physical close. */
function controlledOwner() {
  const closure = Promise.withResolvers<void>();
  let confirmed = false;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  const joined = closure.promise.then(() => {
    confirmed = true;
  });
  const owner: OwnedChildProcess = {
    child: child as unknown as ChildProcess,
    ready: Promise.resolve(),
    joined,
    get joinedConfirmed() {
      return confirmed;
    },
    stop: vi.fn(() => joined),
  };
  return { owner, child, closure };
}

describe("helper ownership", () => {
  test("replacement waits for actual closure after root exit and output EOF", async () => {
    const first = controlledOwner();
    const second = controlledOwner();
    const spawner = vi.fn().mockReturnValueOnce(first.owner).mockReturnValueOnce(second.owner);
    const sup = new HelperSupervisor(spawner, {}, [1]);
    await sup.start(launch);
    first.child.exitCode = 0;
    first.child.stdout.end();
    first.child.stderr.end();
    first.child.emit("exit", 0, null);
    first.child.emit("close", 0, null);
    let replaced = false;
    const replacing = sup.start({ ...launch, hostname: "replacement" }).then(() => {
      replaced = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replaced).toBe(false);
    expect(spawner).toHaveBeenCalledTimes(1);
    expect(ownedProcessCleanupReceipt(sup.cleanupFailure())?.pending).toBe(true);
    first.closure.resolve();
    await replacing;
    expect(spawner).toHaveBeenCalledTimes(2);
    const stopping = sup.stop();
    second.closure.resolve();
    await stopping;
    expect(sup.cleanupFailure()).toBeUndefined();
  });

  test.each([undefined, new Error("invented join failure")])(
    "failed closure blocks automatic and explicit replacement (%s)",
    async (failure) => {
      const current = controlledOwner();
      const spawner = vi.fn(() => current.owner);
      const sup = new HelperSupervisor(spawner, {}, [1]);
      await sup.start(launch);
      current.closure.reject(failure);
      await until(sup, (snapshot) => snapshot.process === "crashed");
      expect(sup.snapshot().retrying).toBe(false);
      expect(ownedProcessCleanupReceipt(sup.cleanupFailure())).toEqual({ failure, pending: false });
      await expect(sup.start(launch)).rejects.toBe(sup.cleanupFailure());
      await expect(sup.stop()).rejects.toSatisfy(
        (error: unknown) => ownedProcessCleanupReceipt(error) !== undefined,
      );
      expect(spawner).toHaveBeenCalledTimes(1);
    },
  );

  test("oversized helper output closes admission and joins before reporting failure", async () => {
    const current = controlledOwner();
    const sup = new HelperSupervisor(() => current.owner, {}, [1]);
    await sup.start(launch);
    current.child.stdout.write("x".repeat(65_537));
    expect(current.child.stdin.writableEnded).toBe(true);
    expect(sup.snapshot().process).toBe("starting");
    current.closure.resolve();
    const snapshot = await until(sup, (state) => state.process === "crashed");
    expect(snapshot.reason).toMatch(/line bound/);
    expect(snapshot.retrying).toBe(false);
    await sup.stop();
    expect(sup.cleanupFailure()).toBeUndefined();
  });
});

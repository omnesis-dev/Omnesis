// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineCommand, runCommand } from "citty";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  acquireUpdateLock,
  adoptUpdateLock,
  getUpdateLockProcessGroup,
  UpdateLockBusyError,
} from "@omnesis/core";
import { CliError, EXIT_CANCELLED, EXIT_FAILURE, EXIT_USER_ERROR } from "../utils.js";
import {
  activeSourceApplyState,
  completedSourceApplyState,
  serializeUpdateApplyState,
  activeDockerApplyState,
  completedDockerApplyState,
} from "../update/detect.js";
import {
  CONTINUATION_SUBCOMMAND,
  readContinuation,
  writeContinuation,
  type UpdateContinuation,
  type ContinuationOffer,
  type ContinuationOutcome,
  type SignalRelay,
} from "../update/continuation.js";
import { UpdateInterruptionRouter } from "../update/interruption.js";
import {
  serviceDefinitionUpdater,
  type ServiceDefinitionOutcome,
  type ServiceDefinitionUpdater,
} from "../update/service-definitions.js";
import { buildServiceSpec, generateSystemdUnit, systemdUnitPath } from "../service/units.js";
import {
  awaitGatewayHealth,
  dockerRestarter,
  parseHealthTimeoutSeconds,
  runWithUpdateLock,
  selectImageTag,
  spawnRunner,
  updateCommand,
  resolveUpdateConfigDir,
  resolveLocalGatewayHealthUrl,
  updateDocker,
  updateNpmGlobal,
  updateSourceCheckout,
  parseWaitForLockMinutes,
  runUpdateContinuation,
  continueOffer,
} from "./update.js";
import type { Supervisor } from "../service/supervisor.js";
import type {
  CommandRunner,
  HealthWaitDeps,
  RunOutcome,
  UpdateApplyStateStore,
  UpdateFlowDeps,
} from "./update.js";
import type {
  CommandSpec,
  HostRoles,
  SourceApplyState,
  UpdateApplyState,
} from "../update/detect.js";
import type { ServiceComponent } from "@omnesis/core";

interface RecordedCall {
  spec: CommandSpec;
  mode: "capture" | "inherit";
}

/** Fake runner: scripted outcomes per call, in order; records every call. */
function fakeRunner(outcomes: Array<RunOutcome | Error>): {
  run: CommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = (spec, mode) => {
    calls.push({ spec, mode });
    const outcome = outcomes[calls.length - 1];
    if (outcome === undefined) throw new Error(`Unexpected call: ${spec.command}`);
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome);
  };
  return { run, calls };
}

function fakeApplyState(initial: string | null = null): {
  store: UpdateApplyStateStore;
  writes: UpdateApplyState[];
} {
  let raw = initial;
  const writes: UpdateApplyState[] = [];
  return {
    store: {
      read: () => raw,
      write: (state) => {
        writes.push(state);
        raw = serializeUpdateApplyState(state);
      },
    },
    writes,
  };
}

describe("spawnRunner environment", () => {
  test.skipIf(process.platform === "win32")(
    "a spec's variables reach the child on top of this process's own",
    async () => {
      const result = await spawnRunner(
        {
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write(`${process.env.OMNESIS_TEST_HEAP}|${process.env.PATH ? 'path' : ''}`)",
          ],
          env: { OMNESIS_TEST_HEAP: "--max-old-space-size=4096" },
        },
        "capture",
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("--max-old-space-size=4096|path");
    },
  );
});

describe("spawnRunner outcome", () => {
  test.skipIf(process.platform === "win32")(
    "a process ended by a signal reports that signal",
    async () => {
      const result = await spawnRunner(
        { command: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGKILL')"] },
        "capture",
      );
      expect(result.signal).toBe("SIGKILL");
      expect(result.code).not.toBe(0);
    },
  );
});

describe("spawnRunner cancellation", () => {
  test.skipIf(process.platform === "win32")(
    "does not execute a gated command when process-group publication fails",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omnesis-update-process-group-"));
      const sentinel = join(dir, "executed");
      const controller = new AbortController();
      try {
        await expect(
          spawnRunner(
            {
              command: process.execPath,
              args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "yes")`],
            },
            "capture",
            {
              signal: controller.signal,
              onProcessGroup: () => {
                throw new Error("lock publication failed");
              },
            },
          ),
        ).rejects.toThrow("lock publication failed");
        expect(existsSync(sentinel)).toBe(false);
      } finally {
        controller.abort();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "waits for an npm-like descendant process before resolving an abort",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "omnesis-update-process-group-"));
      const ready = join(dir, "ready");
      const signaled = join(dir, "signaled");
      const exited = join(dir, "exited");
      const descendant = `
        const fs = require("node:fs");
        const [ready, signaled, exited] = process.argv.slice(1);
        process.on("SIGTERM", () => {
          fs.writeFileSync(signaled, "yes");
          setTimeout(() => {
            fs.writeFileSync(exited, "yes");
            process.exit(0);
          }, 100);
        });
        fs.writeFileSync(ready, "yes");
        setInterval(() => {}, 1000);
      `;
      const parent = `
        const { spawn } = require("node:child_process");
        spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, ${JSON.stringify(ready)}, ${JSON.stringify(signaled)}, ${JSON.stringify(exited)}], { stdio: "ignore" });
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      `;
      const controller = new AbortController();
      const configDir = join(dir, "config");
      const lock = acquireUpdateLock(configDir, { owner: "test update" });
      let settled = false;
      const run = spawnRunner({ command: process.execPath, args: ["-e", parent] }, "capture", {
        signal: controller.signal,
        onProcessGroup: (pid) => lock.setProcessGroup(pid),
      }).finally(() => {
        settled = true;
      });
      try {
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
        expect(getUpdateLockProcessGroup(configDir)).toMatchObject({
          state: "active",
          pid: expect.any(Number),
        });
        controller.abort();
        await vi.waitFor(() => expect(existsSync(signaled)).toBe(true));
        expect(settled).toBe(false);

        await expect(run).resolves.toMatchObject({ code: expect.any(Number) });
        expect(existsSync(exited)).toBe(true);
        expect(getUpdateLockProcessGroup(configDir)).toEqual({ state: "none" });
      } finally {
        controller.abort();
        await run.catch(() => undefined);
        lock.release();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

/** The commit a checkout ran before an update, and the one it moved to. */
const PREVIOUS = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";
const TARGET = "1122334455667788990011223344556677889900";

/** A host with no Omnesis daemons and no harness — the default in this suite. */
const bareHost: HostRoles = {
  gateway: { present: false, supervised: false, manualRestart: null },
  collector: { present: false, supervised: false, manualRestart: null },
  harnesses: [],
};

function hostRoles(over: Partial<HostRoles> = {}): HostRoles {
  return { ...bareHost, ...over };
}

const supervised = { present: true, supervised: true, manualRestart: null };
const unsupervised = { present: true, supervised: false, manualRestart: null };

function makeDeps(
  runner: { run: CommandRunner; calls: RecordedCall[] },
  overrides: Partial<UpdateFlowDeps> = {},
): UpdateFlowDeps {
  const applyState = fakeApplyState();
  return {
    run: runner.run,
    applyState: applyState.store,
    interruptions: new UpdateInterruptionRouter((code) => {
      throw new Error(`Unexpected update signal exit ${code}`);
    }),
    currentVersion: "0.2.0",
    confirm: vi.fn(() => Promise.resolve()),
    approve: vi.fn(() => Promise.resolve(true)),
    roles: bareHost,
    backup: vi.fn(() => Promise.resolve()),
    restartService: vi.fn((_component: ServiceComponent) => Promise.resolve()),
    awaitHealth: vi.fn(() => Promise.resolve()),
    cliCommand: () => ({ command: "/usr/local/bin/omnesis", args: [] }),
    resolveHarness: () => null,
    ...overrides,
  };
}

/** The inherited-stdio commands a flow actually executed, in order. */
const executed = (runner: { calls: RecordedCall[] }): string[] =>
  runner.calls
    .filter((call) => call.mode === "inherit")
    .map((call) => [call.spec.command, ...call.spec.args].join(" "));

let logged: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logged = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

const output = (): string => logged.join("\n");

// ── updateNpmGlobal ─────────────────────────────────────────────────────

describe("updateNpmGlobal", () => {
  test("already up to date: prints version, never installs", async () => {
    const runner = fakeRunner([{ code: 0, stdout: "0.2.0\n" }]);
    await updateNpmGlobal({ channel: "stable", dryRun: false }, makeDeps(runner));

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].spec.args).toEqual(["view", "omnesis@latest", "version"]);
    expect(runner.calls[0].mode).toBe("capture");
    expect(output()).toContain("Already up to date (0.2.0).");
  });

  test("dry run: prints current → target and the install command, never installs", async () => {
    const runner = fakeRunner([{ code: 0, stdout: "0.3.0\n" }]);
    await updateNpmGlobal({ channel: "stable", dryRun: true }, makeDeps(runner));

    expect(runner.calls).toHaveLength(1);
    expect(output()).toContain("0.2.0");
    expect(output()).toContain("0.3.0");
    expect(output()).toContain("npm install -g omnesis@0.3.0");
    expect(output()).toContain("Dry run");
  });

  test("update path: confirms, installs the resolved version, reports success", async () => {
    const runner = fakeRunner([
      { code: 0, stdout: "0.3.0\n" },
      { code: 0, stdout: "" },
    ]);
    const confirm = vi.fn(() => Promise.resolve());
    await updateNpmGlobal({ channel: "stable", dryRun: false }, makeDeps(runner, { confirm }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(runner.calls).toHaveLength(2);
    // The dist-tag resolves the target; the install pins it, so a tag that
    // moves between the two calls cannot deliver a different version.
    expect(runner.calls[1].spec).toEqual({
      command: "npm",
      args: ["install", "-g", "omnesis@0.3.0"],
    });
    expect(runner.calls[1].mode).toBe("inherit");
    expect(output()).toContain("Updated to 0.3.0.");
  });

  test("a signal stops the package process tree before rollback", async () => {
    const interruptions = new UpdateInterruptionRouter((code) => {
      throw new Error(`Unexpected direct exit ${code}`);
    });
    let applyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => (applyStarted = resolve));
    const calls: CommandSpec[] = [];
    const run: CommandRunner = (spec, _mode, control) => {
      calls.push(spec);
      if (calls.length === 1) return Promise.resolve({ code: 0, stdout: "0.3.0\n" });
      if (calls.length === 2) {
        applyStarted();
        return new Promise((resolve) =>
          control?.signal?.addEventListener("abort", () => resolve({ code: 143, stdout: "" }), {
            once: true,
          }),
        );
      }
      return Promise.resolve({ code: 0, stdout: "" });
    };
    const updating = updateNpmGlobal(
      { channel: "stable", dryRun: false },
      makeDeps({ run, calls: [] }, { interruptions }),
    );
    await started;
    interruptions.dispatch("SIGTERM");

    await expect(updating).rejects.toMatchObject({ exitCode: 143 });
    expect(calls.map((spec) => spec.args.join(" "))).toEqual([
      "view omnesis@latest version",
      "install -g omnesis@0.3.0",
      "install -g omnesis@0.2.0",
    ]);
  });

  test("beta channel + registry thread through both npm commands", async () => {
    const runner = fakeRunner([
      { code: 0, stdout: "0.3.0-beta.1\n" },
      { code: 0, stdout: "" },
    ]);
    await updateNpmGlobal(
      { channel: "beta", registry: "https://registry.example.com", dryRun: false },
      makeDeps(runner),
    );

    expect(runner.calls[0].spec.args).toEqual([
      "view",
      "omnesis@beta",
      "version",
      "--registry",
      "https://registry.example.com",
    ]);
    expect(runner.calls[1].spec.args).toEqual([
      "install",
      "-g",
      "omnesis@0.3.0-beta.1",
      "--registry",
      "https://registry.example.com",
    ]);
  });

  test("declined confirmation aborts before the install runs", async () => {
    const runner = fakeRunner([{ code: 0, stdout: "0.3.0\n" }]);
    const confirm = vi.fn(() => Promise.reject(new CliError("", EXIT_CANCELLED)));
    await expect(
      updateNpmGlobal({ channel: "stable", dryRun: false }, makeDeps(runner, { confirm })),
    ).rejects.toMatchObject({ exitCode: EXIT_CANCELLED });
    expect(runner.calls).toHaveLength(1);
  });

  test("npm view failure is a clear error", async () => {
    const runner = fakeRunner([{ code: 1, stdout: "" }]);
    await expect(
      updateNpmGlobal({ channel: "beta", dryRun: false }, makeDeps(runner)),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
    expect(runner.calls).toHaveLength(1);
  });

  test("npm view spawn error (npm missing) is a clear error", async () => {
    const runner = fakeRunner([new Error("spawn npm ENOENT")]);
    await expect(
      updateNpmGlobal({ channel: "stable", dryRun: false }, makeDeps(runner)),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
  });

  test("npm install failure is a clear error", async () => {
    const runner = fakeRunner([
      { code: 0, stdout: "0.3.0\n" },
      { code: 1, stdout: "" },
    ]);
    await expect(
      updateNpmGlobal({ channel: "stable", dryRun: false }, makeDeps(runner)),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
  });

  test("upgrade prints the forward-migration backup reminder", async () => {
    const runner = fakeRunner([
      { code: 0, stdout: "0.3.0\n" },
      { code: 0, stdout: "" },
    ]);
    await updateNpmGlobal({ channel: "stable", dryRun: false }, makeDeps(runner));
    expect(output()).toMatch(/back up first: omnesis backup --note pre-upgrade/);
  });

  test("downgrade is blocked without --force (no install, before confirm)", async () => {
    const runner = fakeRunner([{ code: 0, stdout: "0.1.0\n" }]);
    const confirm = vi.fn(() => Promise.resolve());
    await expect(
      updateNpmGlobal(
        { channel: "stable", dryRun: false },
        makeDeps(runner, { currentVersion: "0.2.0", confirm }),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    expect(runner.calls).toHaveLength(1); // only the `npm view`, never the install
    expect(confirm).not.toHaveBeenCalled();
    expect(output()).toMatch(/Downgrade/);
  });

  test("downgrade proceeds with --force", async () => {
    const runner = fakeRunner([
      { code: 0, stdout: "0.1.0\n" },
      { code: 0, stdout: "" },
    ]);
    const confirm = vi.fn(() => Promise.resolve());
    await updateNpmGlobal(
      { channel: "stable", dryRun: false, force: true },
      makeDeps(runner, { currentVersion: "0.2.0", confirm }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].spec.args).toEqual(["install", "-g", "omnesis@0.1.0"]);
  });

  test("dry-run downgrade warns about --force but does not throw", async () => {
    const runner = fakeRunner([{ code: 0, stdout: "0.1.0\n" }]);
    await updateNpmGlobal(
      { channel: "stable", dryRun: true },
      makeDeps(runner, { currentVersion: "0.2.0" }),
    );
    expect(runner.calls).toHaveLength(1);
    expect(output()).toMatch(/--force/);
    expect(output()).toContain("Dry run");
  });

  test("a pinned target is resolved as itself, not through the channel tag", async () => {
    const runner = fakeRunner([
      { code: 0, stdout: "0.4.0\n" },
      { code: 0, stdout: "" },
    ]);
    await updateNpmGlobal(
      { channel: "stable", dryRun: false, targetVersion: "0.4.0" },
      makeDeps(runner),
    );
    expect(runner.calls[0].spec.args).toEqual(["view", "omnesis@0.4.0", "version"]);
  });

  test("a registry answering with a version other than the one asked for is refused", async () => {
    // The version installed must be the version confirmed. A registry that
    // substitutes is the case this refusal exists for.
    const runner = fakeRunner([{ code: 0, stdout: "0.9.9\n" }]);
    await expect(
      updateNpmGlobal(
        { channel: "stable", dryRun: false, targetVersion: "0.4.0" },
        makeDeps(runner),
      ),
    ).rejects.toThrow(/resolves to 0\.9\.9/);
    expect(executed(runner)).toEqual([]);
  });
});

// ── updateSourceCheckout ────────────────────────────────────────────────

describe("updateSourceCheckout", () => {
  const rootDir = "/home/dev/omnesis";
  const managed = { code: 0, stdout: "managed\n" };
  const clean = { code: 0, stdout: "" };
  const tags = { code: 0, stdout: "abc\trefs/tags/v0.3.0\n" };
  const manifest = { code: 0, stdout: '{"version":"0.3.0"}\n' };
  // `git rev-parse HEAD` — the ref a failed update rolls back to.
  const head = { code: 0, stdout: "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3\n" };
  // `git rev-list -n 1 <tag>` — what the target resolves to. Different from
  // HEAD, so the checkout is genuinely being moved.
  const targetSha = { code: 0, stdout: "1122334455667788990011223344556677889900\n" };
  // The same commit HEAD is on: the checkout is already standing on the tag.
  const targetShaIsHead = head;

  test("fetches and builds an exact commit without consulting release tags", async () => {
    const runner = fakeRunner([managed, clean, clean, head, targetSha, clean, clean, clean, clean]);
    await expect(
      updateSourceCheckout(
        { rootDir, edge: false, dryRun: false, targetCommit: TARGET },
        makeDeps(runner),
      ),
    ).resolves.toBeNull();
    expect(executed(runner)).toEqual([
      `git fetch origin ${TARGET}`,
      `git checkout --detach ${TARGET}`,
      "npm ci",
      "npm run build",
    ]);
    expect(runner.calls.some((call) => call.spec.args.includes("--tags"))).toBe(false);
    expect(output()).toContain(`commit ${TARGET.slice(0, 12)}`);
  });

  test("rejects abbreviated and option-like commit targets before git runs", async () => {
    for (const targetCommit of ["1122334", "--upload-pack=evil", "A".repeat(40)]) {
      const runner = fakeRunner([]);
      await expect(
        updateSourceCheckout(
          { rootDir, edge: false, dryRun: false, targetCommit },
          makeDeps(runner),
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
      expect(runner.calls).toEqual([]);
    }
  });

  test("dry run performs only read-only checks and prints the stable update", async () => {
    const runner = fakeRunner([managed, clean, tags]);
    await updateSourceCheckout({ rootDir, edge: false, dryRun: true }, makeDeps(runner));

    expect(runner.calls).toHaveLength(3);
    expect(runner.calls.every((call) => call.mode === "capture")).toBe(true);
    expect(output()).toContain("git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0");
    expect(output()).toContain("git checkout --detach v0.3.0");
    expect(output()).toContain("npm ci");
    expect(output()).toContain("npm run build");
    expect(output()).toContain("Dry run");
  });

  test("prints the forward-migration backup reminder", async () => {
    const runner = fakeRunner([managed, clean, tags]);
    await updateSourceCheckout({ rootDir, edge: false, dryRun: true }, makeDeps(runner));
    expect(output()).toMatch(/back up first: omnesis backup --note pre-upgrade/);
  });

  test("fetches, checks out the newest stable tag, installs, and builds", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      { code: 0, stdout: "a\trefs/tags/v0.9.0\nb\trefs/tags/v0.10.0\n" },
      clean,
      { code: 0, stdout: '{"version":"0.10.0"}\n' },
      head,
      targetSha,
      clean,
      clean,
      clean,
      clean,
    ]);
    const prepareSourceLauncher = vi.fn();
    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: false },
      makeDeps(runner, { prepareSourceLauncher }),
    );

    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.10.0:refs/tags/v0.10.0",
      "git checkout --detach v0.10.0",
      "npm ci",
      "npm run build",
    ]);
    expect(runner.calls.every((c) => c.spec.cwd === rootDir)).toBe(true);
    expect(prepareSourceLauncher).toHaveBeenCalledExactlyOnceWith(rootDir);
    expect(output()).toContain("Updated to v0.10.0.");
  });

  /**
   * The security property of the fleet update, asserted where it is enforced.
   *
   * A commanded device is handed a version by something it has decided to
   * trust, and that alone is not enough: the version has to name a release
   * on the host's own remote before a single command runs against it. A
   * gateway that has been tampered with can say anything; it cannot create a
   * tag on a repository it does not control.
   */
  test("a target version with no matching tag on the remote is refused", async () => {
    const runner = fakeRunner([managed, clean, tags]);
    await expect(
      updateSourceCheckout(
        { rootDir, edge: false, dryRun: false, targetVersion: "9.9.9" },
        makeDeps(runner),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
    // Refused on the tag listing: nothing was fetched, checked out or built.
    expect(executed(runner)).toEqual([]);
    await expect(
      updateSourceCheckout(
        { rootDir, edge: false, dryRun: false, targetVersion: "9.9.9" },
        makeDeps(fakeRunner([managed, clean, tags])),
      ),
    ).rejects.toThrow(/No release v9\.9\.9 exists/);
  });

  test("a target version that does name a real tag is taken", async () => {
    const remote = { code: 0, stdout: "a\trefs/tags/v0.3.0\nb\trefs/tags/v0.4.0\n" };
    const runner = fakeRunner([
      managed,
      clean,
      remote,
      clean,
      { code: 0, stdout: '{"version":"0.3.0"}\n' },
      head,
      targetSha,
      clean,
      clean,
      clean,
      clean,
    ]);
    // The newest tag is v0.4.0; the named one wins.
    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: false, targetVersion: "0.3.0" },
      makeDeps(runner),
    );
    expect(executed(runner)).toContain("git checkout --detach v0.3.0");
  });

  test("--no-restart reports the daemons instead of restarting them", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      clean,
      clean,
      clean,
      clean,
    ]);
    const restartService = vi.fn(() => Promise.resolve());
    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: false },
      makeDeps(runner, {
        restart: false,
        roles: hostRoles({ gateway: supervised, collector: supervised }),
        restartService,
      }),
    );
    expect(restartService).not.toHaveBeenCalled();
    expect(output()).toContain("omnesis service restart gateway");
    expect(output()).toContain("omnesis service restart collector");
  });

  test("matching completed evidence skips the build while keeping the restarts", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetShaIsHead,
      clean,
    ]);
    const backup = vi.fn(() => Promise.resolve());
    const restartService = vi.fn(() => Promise.resolve());
    const completed = serializeUpdateApplyState(
      completedSourceApplyState(rootDir, head.stdout.trim()),
    );
    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: false },
      makeDeps(runner, {
        applyState: { read: () => completed, write: vi.fn() },
        roles: hostRoles({ gateway: supervised }),
        backup,
        restartService,
      }),
    );
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
    ]);
    // The backup exists to precede something irreversible; with no apply
    // commands, nothing irreversible follows.
    expect(backup).not.toHaveBeenCalled();
    expect(restartService).toHaveBeenCalledWith("gateway");
    expect(output()).toContain("already on v0.3.0");
  });

  test("matching HEAD without completed evidence rebuilds and explains the recovery", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetShaIsHead,
      clean,
      clean,
      clean,
      clean,
    ]);
    const state = fakeApplyState();
    const exit = vi.fn();
    const interruptions = new UpdateInterruptionRouter(exit);

    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: false },
      makeDeps(runner, { applyState: state.store, interruptions }),
    );

    expect(executed(runner)).toContain("npm ci");
    expect(output()).toContain("no completed apply is recorded");
    expect(output()).toContain("may not have finished");
    expect(state.writes.map((value) => value.phase)).toEqual(["applying", "complete"]);
    expect(state.writes.at(-1)).toEqual(completedSourceApplyState(rootDir, head.stdout.trim()));
    interruptions.dispatch("SIGINT");
    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
  });

  test.each(["applying", "rolling-back"] as const)(
    "an interrupted %s state reapplies from its last completed commit",
    async (phase) => {
      const targetCommit = targetSha.stdout.trim();
      const previousCommit = head.stdout.trim();
      const interrupted = serializeUpdateApplyState({
        version: 1,
        method: "source",
        rootDir,
        phase,
        targetCommit,
        lastCompletedCommit: previousCommit,
      });
      const state = fakeApplyState(interrupted);
      const runner = fakeRunner([
        managed,
        clean,
        tags,
        clean,
        manifest,
        targetSha,
        targetSha,
        clean,
        clean,
        clean,
        clean,
      ]);

      await updateSourceCheckout(
        { rootDir, edge: false, dryRun: false },
        makeDeps(runner, { applyState: state.store }),
      );

      expect(runner.calls.find((call) => call.spec.args[0] === "merge-base")?.spec.args).toEqual([
        "merge-base",
        "--is-ancestor",
        previousCommit,
        "v0.3.0",
      ]);
      expect(output()).toContain("previous source update did not finish");
      expect(executed(runner)).toContain("npm run build");
      expect(state.writes.at(-1)).toEqual(completedSourceApplyState(rootDir, targetCommit));
    },
  );

  test("a checkout whose version matches the tag but whose commit does not is still built", async () => {
    // The half-applied case: `package.json` already says the target because
    // an earlier run checked out and then died, or because this is an
    // unreleased commit after the version bump.
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      clean,
      clean,
      clean,
      clean,
    ]);
    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: false },
      makeDeps(runner, { currentVersion: "0.3.0" }),
    );
    expect(executed(runner)).toContain("npm run build");
  });

  test("dirty checkout is refused before network access", async () => {
    const runner = fakeRunner([managed, { code: 0, stdout: " M package.json\n" }]);
    await expect(
      updateSourceCheckout({ rootDir, edge: false, dryRun: false }, makeDeps(runner)),
    ).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
      message: expect.stringContaining("local changes"),
    });
    expect(runner.calls).toHaveLength(2);
  });

  test("build failure surfaces the failing command", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      clean,
      clean,
      clean,
      { code: 1, stdout: "" },
      // the rollback
      clean,
      clean,
      clean,
    ]);
    await expect(
      updateSourceCheckout({ rootDir, edge: false, dryRun: false }, makeDeps(runner)),
    ).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringContaining("npm run build"),
    });
  });

  test("declined confirmation aborts before checkout and build", async () => {
    const runner = fakeRunner([managed, clean, tags, clean, manifest, head, targetSha, clean]);
    const confirm = vi.fn(() => Promise.reject(new CliError("", EXIT_CANCELLED)));
    await expect(
      updateSourceCheckout({ rootDir, edge: false, dryRun: false }, makeDeps(runner, { confirm })),
    ).rejects.toMatchObject({ exitCode: EXIT_CANCELLED });
    expect(runner.calls).toHaveLength(8);
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
    ]);
  });

  test("a recovery launcher failure stops before checkout mutation", async () => {
    const runner = fakeRunner([managed, clean, tags, clean, manifest, head, targetSha, clean]);
    await expect(
      updateSourceCheckout(
        { rootDir, edge: false, dryRun: false },
        makeDeps(runner, {
          prepareSourceLauncher: () => {
            throw new Error("launcher path is occupied");
          },
        }),
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringContaining("source update recovery launcher"),
    });
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
    ]);
  });

  test("edge explicitly follows origin/main", async () => {
    const runner = fakeRunner([managed, clean]);
    await updateSourceCheckout({ rootDir, edge: true, dryRun: true }, makeDeps(runner));
    expect(output()).toContain("origin/main (edge)");
    expect(output()).toContain("git fetch origin +main:refs/remotes/origin/main");
    expect(output()).toContain("git checkout --detach origin/main");
  });

  test("fails clearly when no stable release exists", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      { code: 0, stdout: "a\trefs/tags/v0.3.0-beta.1\n" },
    ]);
    await expect(
      updateSourceCheckout({ rootDir, edge: false, dryRun: true }, makeDeps(runner)),
    ).rejects.toMatchObject({ message: expect.stringContaining("No stable source release") });
  });

  test("refuses an unmanaged development checkout", async () => {
    const runner = fakeRunner([{ code: 1, stdout: "" }]);
    await expect(
      updateSourceCheckout({ rootDir, edge: false, dryRun: true }, makeDeps(runner)),
    ).rejects.toMatchObject({ message: expect.stringContaining("development checkout") });
  });

  // After ancestry fails: the last build's manifest, the target's, and the
  // commits the target lacks.
  const notAncestor = { code: 1, stdout: "" };
  const leftBehind = { code: 0, stdout: "abcd123 Exercise an unmerged rollout\n" };
  // `git merge-base` names a common commit: the histories are related.
  const sharedBase = { code: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n" };
  // No common commit at all: the repository's history was replaced.
  const noSharedBase = { code: 1, stdout: "" };
  // `git rev-parse --is-shallow-repository` on a full clone.
  const fullClone = { code: 0, stdout: "false\n" };

  test("refuses a target that is neither newer nor a descendant, naming what it would drop", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      notAncestor,
      manifest,
      manifest,
      leftBehind,
      sharedBase,
      fullClone,
    ]);
    const refusal = updateSourceCheckout({ rootDir, edge: false, dryRun: false }, makeDeps(runner));
    await expect(refusal).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
      message: expect.stringContaining("not a forward update"),
    });
    await expect(refusal).rejects.toMatchObject({
      message: expect.stringContaining("abcd123 Exercise an unmerged rollout"),
    });
    await expect(refusal).rejects.toMatchObject({
      message: expect.stringContaining("--allow-rewind"),
    });
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
    ]);
  });

  test("moves to a newer release that lacks the last build's unmerged commits", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      notAncestor,
      { code: 0, stdout: '{"version":"0.2.5"}\n' },
      manifest,
      leftBehind,
      sharedBase,
      fullClone,
      clean,
      clean,
      clean,
    ]);
    await updateSourceCheckout({ rootDir, edge: false, dryRun: false }, makeDeps(runner));
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
      "git checkout --detach v0.3.0",
      "npm ci",
      "npm run build",
    ]);
    expect(output()).toContain("is newer than the last completed build (0.2.5)");
    expect(output()).toContain("abcd123 Exercise an unmerged rollout");
  });

  for (const flag of ["allowRewind", "force"] as const) {
    test(`--${flag === "force" ? "force" : "allow-rewind"} moves back, naming what it drops`, async () => {
      const runner = fakeRunner([
        managed,
        clean,
        tags,
        clean,
        manifest,
        head,
        targetSha,
        notAncestor,
        manifest,
        manifest,
        leftBehind,
        sharedBase,
        fullClone,
        clean,
        clean,
        clean,
      ]);
      await updateSourceCheckout(
        { rootDir, edge: false, dryRun: false, [flag]: true },
        makeDeps(runner),
      );
      expect(executed(runner)).toContain("git checkout --detach v0.3.0");
      expect(output()).toContain("Moving back to v0.3.0");
      expect(output()).toContain("abcd123 Exercise an unmerged rollout");
    });
  }

  test("moves forward to a newer release from a replaced history, without listing old commits", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      notAncestor,
      { code: 0, stdout: '{"version":"0.2.5"}\n' },
      manifest,
      leftBehind,
      noSharedBase,
      fullClone,
      clean,
      clean,
      clean,
    ]);
    await updateSourceCheckout({ rootDir, edge: false, dryRun: false }, makeDeps(runner));
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
      "git checkout --detach v0.3.0",
      "npm ci",
      "npm run build",
    ]);
    expect(output()).toContain("the repository's history was replaced. Moving forward to it.");
    expect(output()).not.toContain("abcd123 Exercise an unmerged rollout");
  });

  test("refuses a replaced-history release that is not newer", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      notAncestor,
      manifest,
      manifest,
      leftBehind,
      noSharedBase,
      fullClone,
    ]);
    const refusal = updateSourceCheckout({ rootDir, edge: false, dryRun: false }, makeDeps(runner));
    await expect(refusal).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
      message: expect.stringContaining("shares no history with the last completed source build"),
    });
    await expect(refusal).rejects.toMatchObject({
      message: expect.stringContaining("--allow-rewind"),
    });
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
    ]);
  });

  test("--allow-rewind moves to a replaced-history release that is not newer", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      notAncestor,
      manifest,
      manifest,
      leftBehind,
      noSharedBase,
      fullClone,
      clean,
      clean,
      clean,
    ]);
    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: false, allowRewind: true },
      makeDeps(runner),
    );
    expect(executed(runner)).toContain("git checkout --detach v0.3.0");
    expect(output()).toContain("Moving back to it.");
  });

  test("a shallow exact-commit checkout with no merge base is not reported as a replaced history", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      notAncestor,
      { code: 0, stdout: '{"version":"0.2.5"}\n' },
      manifest,
      leftBehind,
      noSharedBase,
      { code: 0, stdout: "true\n" },
      clean,
      clean,
      clean,
    ]);
    await updateSourceCheckout({ rootDir, edge: false, dryRun: false }, makeDeps(runner));
    expect(output()).toContain("is newer than the last completed build (0.2.5)");
    expect(output()).not.toContain("history was replaced");
  });

  test("a merge-base failure falls back to naming the commits left behind", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      notAncestor,
      { code: 0, stdout: '{"version":"0.2.5"}\n' },
      manifest,
      leftBehind,
      new Error("git merge-base could not run"),
      fullClone,
      clean,
      clean,
      clean,
    ]);
    await updateSourceCheckout({ rootDir, edge: false, dryRun: false }, makeDeps(runner));
    expect(output()).toContain("abcd123 Exercise an unmerged rollout");
    expect(output()).not.toContain("history was replaced");
  });

  test("never force-bypasses an ancestry check error", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      { code: 2, stdout: "" },
    ]);
    await expect(
      updateSourceCheckout({ rootDir, edge: false, dryRun: false, force: true }, makeDeps(runner)),
    ).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringContaining("incomplete or corrupt"),
    });
  });

  test("refuses mismatched tag metadata before checkout", async () => {
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      { code: 0, stdout: '{"version":"0.2.0"}\n' },
    ]);
    await expect(
      updateSourceCheckout({ rootDir, edge: false, dryRun: false }, makeDeps(runner)),
    ).rejects.toMatchObject({ message: expect.stringContaining("matching CLI version") });
    expect(runner.calls.some((call) => call.spec.args[0] === "checkout")).toBe(false);
  });
});

// ── The per-host plan, executed ─────────────────────────────────────────

describe("executing a host's plan", () => {
  const rootDir = "/home/dev/omnesis";
  const managed = { code: 0, stdout: "managed\n" };
  const clean = { code: 0, stdout: "" };
  const tags = { code: 0, stdout: "abc\trefs/tags/v0.3.0\n" };
  const manifest = { code: 0, stdout: '{"version":"0.3.0"}\n' };
  const head = { code: 0, stdout: "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3\n" };
  // `git rev-list -n 1 <tag>`: a different commit, so the checkout is moved.
  const targetSha = { code: 0, stdout: "1122334455667788990011223344556677889900\n" };
  const previousRef = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";

  /** The preflight reads, then the three mutations, all succeeding. */
  const successfulUpdate = [
    managed,
    clean,
    tags,
    clean,
    manifest,
    head,
    targetSha,
    clean,
    clean,
    clean,
    clean,
  ];

  const source = (deps: UpdateFlowDeps) =>
    updateSourceCheckout({ rootDir, edge: false, dryRun: false }, deps);

  // The plan is what the operator reads before confirming, and the container
  // topology lane greps these same lines to tell one host's roles from
  // another's. Both make the wording a contract.
  test("the plan names, in order, what this host is about to do", async () => {
    const runner = fakeRunner([managed, clean, tags, clean, manifest, clean]);
    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: true },
      makeDeps(runner, { roles: hostRoles({ gateway: supervised, collector: supervised }) }),
    );
    const plan = logged.slice(logged.indexOf("This host will:") + 1, -3);
    expect(plan).toEqual([
      "  - back up the gateway's databases through its API",
      "  - move this installation to v0.3.0",
      "  - restart the gateway",
      "  - wait for the gateway to serve again (schema migrations run at boot)",
      "  - restart the collector",
    ]);
  });

  test("a gateway host backs up before it touches the checkout", async () => {
    const order: string[] = [];
    const runner = fakeRunner(successfulUpdate);
    const backup = vi.fn(() => {
      order.push("backup");
      return Promise.resolve();
    });
    const wrapped: CommandRunner = (spec, mode) => {
      if (mode === "inherit") order.push([spec.command, ...spec.args].join(" "));
      return runner.run(spec, mode);
    };
    await source(
      makeDeps(
        { run: wrapped, calls: runner.calls },
        { roles: hostRoles({ gateway: supervised }), backup },
      ),
    );
    expect(backup).toHaveBeenCalledOnce();
    // Only the read-only fetch precedes it; every mutation follows.
    expect(order).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
      "backup",
      "git checkout --detach v0.3.0",
      "npm ci",
      "npm run build",
    ]);
  });

  test("the backup note names the transition it protects", async () => {
    const runner = fakeRunner(successfulUpdate);
    const backup = vi.fn(() => Promise.resolve());
    await source(makeDeps(runner, { roles: hostRoles({ gateway: supervised }), backup }));
    expect(backup).toHaveBeenCalledWith(expect.stringContaining("0.2.0"), "pre-update");
    expect(backup).toHaveBeenCalledWith(expect.stringContaining("v0.3.0"), "pre-update");
  });

  test("a failed backup stops the update before anything irreversible", async () => {
    const runner = fakeRunner([managed, clean, tags, clean, manifest, head, targetSha, clean]);
    const backup = vi.fn(() => Promise.reject(new Error("connection refused")));
    await expect(
      source(makeDeps(runner, { roles: hostRoles({ gateway: supervised }), backup })),
    ).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringContaining("--no-backup"),
    });
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
    ]);
  });

  test("--no-backup skips it and still updates", async () => {
    const runner = fakeRunner(successfulUpdate);
    const backup = vi.fn(() => Promise.resolve());
    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: false, backup: false },
      makeDeps(runner, { roles: hostRoles({ gateway: supervised }), backup }),
    );
    expect(backup).not.toHaveBeenCalled();
    expect(executed(runner)).toContain("npm run build");
  });

  test("the collector restarts only after the gateway is healthy again", async () => {
    const order: string[] = [];
    const runner = fakeRunner(successfulUpdate);
    const deps = makeDeps(runner, {
      roles: hostRoles({ gateway: supervised, collector: supervised }),
      restartService: vi.fn((component: "gateway" | "collector") => {
        order.push(`restart:${component}`);
        return Promise.resolve();
      }),
      awaitHealth: vi.fn(() => {
        order.push("health");
        return Promise.resolve();
      }),
    });
    await source(deps);
    expect(order).toEqual(["restart:gateway", "health", "restart:collector"]);
  });

  test("the health wait is told which version proves the new build is serving", async () => {
    const runner = fakeRunner(successfulUpdate);
    const awaitHealth = vi.fn(() => Promise.resolve());
    await source(makeDeps(runner, { roles: hostRoles({ gateway: supervised }), awaitHealth }));
    expect(awaitHealth).toHaveBeenCalledWith("0.3.0", expect.any(AbortSignal));
  });

  test("an unsupervised gateway is reported rather than restarted", async () => {
    const runner = fakeRunner(successfulUpdate);
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    await source(makeDeps(runner, { roles: hostRoles({ gateway: unsupervised }), restartService }));
    expect(restartService).not.toHaveBeenCalled();
    expect(output()).toMatch(/not registered as a service/u);
  });

  test("a collector-only host just restarts its collector", async () => {
    const runner = fakeRunner(successfulUpdate);
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    const backup = vi.fn(() => Promise.resolve());
    await source(
      makeDeps(runner, { roles: hostRoles({ collector: supervised }), restartService, backup }),
    );
    expect(backup).not.toHaveBeenCalled();
    expect(restartService).toHaveBeenCalledExactlyOnceWith("collector");
  });

  test("a collector that will not restart is reported, not rolled back", async () => {
    const runner = fakeRunner(successfulUpdate);
    const restartService = vi.fn(() => Promise.reject(new Error("unit masked")));
    await source(makeDeps(runner, { roles: hostRoles({ collector: supervised }), restartService }));
    expect(executed(runner)).not.toContain(`git checkout --detach ${previousRef}`);
    expect(output()).toContain("omnesis service restart collector");
  });

  test("a harness is refreshed and its restart is offered", async () => {
    const runner = fakeRunner([...successfulUpdate, clean, clean]);
    const approve = vi.fn(() => Promise.resolve(true));
    const reportHarnessResult = vi.fn(() => Promise.resolve());
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          harnesses: [{ harness: "openclaw", home: "/h", needsAuthorization: false }],
        }),
        approve,
        reportHarnessResult,
      }),
    );
    // The refreshed plugin is on disk but not loaded until the restart, and
    // the gateway is told so as the harness's own device; its next hello on
    // the new version is what clears the notice.
    expect(reportHarnessResult).toHaveBeenCalledOnce();
    // Against the release this run installed, not the CLI that ran it.
    expect(reportHarnessResult).toHaveBeenCalledWith("openclaw", {
      version: "0.3.0",
      state: "restart-pending",
      detail: expect.stringContaining("openclaw gateway restart"),
    });
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
      "git checkout --detach v0.3.0",
      "npm ci",
      "npm run build",
      "/usr/local/bin/omnesis connect openclaw --refresh --no-restart",
      "openclaw gateway restart",
    ]);
    expect(approve).toHaveBeenCalledOnce();
  });

  test("the refresh runs the installed CLI by path, read once the build is in place", async () => {
    const runner = fakeRunner([...successfulUpdate, clean, clean]);
    const tsx = "/opt/omnesis/node_modules/.bin/tsx";
    const entry = "/opt/omnesis/packages/cli/src/index.ts";
    let readAfter: string[] = [];
    const cliCommand = vi.fn(() => {
      readAfter = executed(runner);
      return { command: tsx, args: [entry], env: { PATH: "/opt/node/bin" } };
    });
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          harnesses: [{ harness: "hermes", home: "/h", needsAuthorization: false }],
        }),
        cliCommand,
      }),
    );
    expect(readAfter.at(-1)).toBe("npm run build");
    const refresh = runner.calls.find((call) => call.spec.args.includes("--refresh"));
    expect(refresh?.spec).toEqual({
      command: tsx,
      args: [entry, "connect", "hermes", "--refresh", "--no-restart"],
      env: { PATH: "/opt/node/bin" },
    });
  });

  test("declining the harness restart leaves the update done and says what to run", async () => {
    const runner = fakeRunner([...successfulUpdate, clean]);
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          harnesses: [{ harness: "hermes", home: "/h", needsAuthorization: false }],
        }),
        approve: vi.fn(() => Promise.resolve(false)),
      }),
    );
    expect(executed(runner)).not.toContain("hermes gateway restart");
    expect(output()).toContain("Restart hermes to load the refreshed plugin");
  });

  test("a grant that needs a human prints the command instead of blocking on it", async () => {
    const runner = fakeRunner(successfulUpdate);
    const approve = vi.fn(() => Promise.resolve(true));
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          harnesses: [{ harness: "openclaw", home: "/h", needsAuthorization: true }],
        }),
        approve,
      }),
    );
    expect(executed(runner)).not.toContain(
      "/usr/local/bin/omnesis connect openclaw --refresh --no-restart",
    );
    expect(approve).not.toHaveBeenCalled();
    expect(output()).toContain("omnesis connect openclaw --refresh");
  });

  // A plugin that was not reinstalled gives a restart nothing new to load, so
  // interrupting a running agent for it would cost something and buy nothing.
  test("a failed plugin refresh warns, and does not then interrupt the harness", async () => {
    const runner = fakeRunner([...successfulUpdate, { code: 1, stdout: "" }]);
    const approve = vi.fn(() => Promise.resolve(true));
    const reportHarnessResult = vi.fn(() => Promise.resolve());
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          harnesses: [{ harness: "openclaw", home: "/h", needsAuthorization: false }],
        }),
        approve,
        reportHarnessResult,
      }),
    );
    expect(output()).toContain("was not refreshed");
    expect(approve).not.toHaveBeenCalled();
    expect(executed(runner)).not.toContain("openclaw gateway restart");
    // The failure outlives this terminal: it is on the device's row.
    expect(reportHarnessResult).toHaveBeenCalledWith("openclaw", {
      version: "0.3.0",
      state: "failed",
      detail: expect.stringContaining("exited 1"),
    });
  });

  test("a restart that fails keeps the restart owed on the device's row", async () => {
    const runner = fakeRunner([...successfulUpdate, clean, { code: 127, stdout: "" }]);
    const reportHarnessResult = vi.fn<NonNullable<UpdateFlowDeps["reportHarnessResult"]>>(() =>
      Promise.resolve(),
    );
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          harnesses: [{ harness: "hermes", home: "/h", needsAuthorization: false }],
        }),
        reportHarnessResult,
      }),
    );
    expect(output()).toContain("Could not restart hermes");
    const states = reportHarnessResult.mock.calls.map(([, result]) => result);
    expect(states.map((r) => r.state)).toEqual(["restart-pending", "restart-pending"]);
    expect(states[1]?.detail).toContain("exited 127");
  });

  test("restarts a harness installed off PATH through its resolved executable", async () => {
    const runner = fakeRunner([...successfulUpdate, clean, clean]);
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          harnesses: [{ harness: "hermes", home: "/h", needsAuthorization: false }],
        }),
        resolveHarness: (harness) => `/home/example/.local/bin/${harness}`,
      }),
    );
    expect(executed(runner)).toContain("/home/example/.local/bin/hermes gateway restart");
    const restart = runner.calls.find((call) => call.spec.command.endsWith("/hermes"));
    expect(restart?.spec.env?.PATH?.split(":")[0]).toBe("/home/example/.local/bin");
    expect(output()).not.toContain("Could not restart hermes");
  });

  test("a report the gateway cannot take is said and does not fail the update", async () => {
    const runner = fakeRunner([...successfulUpdate, clean, clean]);
    const reportHarnessResult = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          harnesses: [{ harness: "openclaw", home: "/h", needsAuthorization: false }],
        }),
        reportHarnessResult,
      }),
    );
    expect(output()).toContain("Could not record the openclaw plugin's update");
    expect(output()).toContain("ECONNREFUSED");
    expect(executed(runner)).toContain("openclaw gateway restart");
  });

  test("--no-restart refreshes the plugin and names the restart instead of asking", async () => {
    const runner = fakeRunner([...successfulUpdate, clean]);
    const approve = vi.fn(() => Promise.resolve(true));
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          harnesses: [{ harness: "openclaw", home: "/h", needsAuthorization: false }],
        }),
        approve,
        restart: false,
      }),
    );
    expect(executed(runner)).toContain(
      "/usr/local/bin/omnesis connect openclaw --refresh --no-restart",
    );
    expect(executed(runner)).not.toContain("openclaw gateway restart");
    expect(approve).not.toHaveBeenCalled();
    expect(output()).toContain("Restart it with");
    expect(output()).toContain("openclaw gateway restart");
  });

  test("an unsupervised collector is reported rather than restarted", async () => {
    const runner = fakeRunner(successfulUpdate);
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    await source(
      makeDeps(runner, { roles: hostRoles({ collector: unsupervised }), restartService }),
    );
    expect(restartService).not.toHaveBeenCalled();
    expect(output()).toContain("still runs the previous build");
  });

  test("a hint names the command the host knows for it", async () => {
    const runner = fakeRunner(successfulUpdate);
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          gateway: {
            present: true,
            supervised: false,
            manualRestart: "sudo systemctl restart omnesis-gateway.service",
          },
        }),
      }),
    );
    expect(output()).toContain("sudo systemctl restart omnesis-gateway.service");
  });

  test("a dedicated gateway is named with the root command that moves it, not a restart", async () => {
    const runner = fakeRunner(successfulUpdate);
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    const hardenedGatewayCommand = vi.fn(
      (version: string | null, adminInstalled: boolean) =>
        `sudo omnesis-gateway-admin update --version ${version} (admin: ${adminInstalled})`,
    );
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          gateway: {
            present: true,
            supervised: false,
            manualRestart: "sudo omnesis-gateway-admin update",
            hardened: { adminInstalled: true },
          },
        }),
        restartService,
        hardenedGatewayCommand,
      }),
    );
    expect(restartService).not.toHaveBeenCalled();
    expect(hardenedGatewayCommand).toHaveBeenCalledOnce();
    expect(hardenedGatewayCommand.mock.calls[0]?.[0]).toMatch(/0\.3\.0/);
    expect(hardenedGatewayCommand.mock.calls[0]?.[1]).toBe(true);
    expect(output()).toContain("The dedicated gateway on this host still runs its own release");
    expect(output()).toContain("(admin: true)");
    expect(output()).not.toContain("still runs the previous build");
  });

  test("a dedicated gateway without its admin command is named with the install that moves it", async () => {
    const runner = fakeRunner(successfulUpdate);
    const hardenedGatewayCommand = vi.fn(
      (_version: string | null, adminInstalled: boolean) => `admin installed: ${adminInstalled}`,
    );
    await source(
      makeDeps(runner, {
        roles: hostRoles({
          gateway: {
            present: true,
            supervised: false,
            manualRestart:
              "curl -fsSL https://omnesis.dev/hardened-gateway.sh | sudo sh -s -- install",
            hardened: { adminInstalled: false },
          },
        }),
        hardenedGatewayCommand,
      }),
    );
    expect(output()).toContain("admin installed: false");
  });

  test("a package install runs its host's plan too, waiting on the version it installed", async () => {
    const runner = fakeRunner([
      { code: 0, stdout: "0.3.0\n" },
      { code: 0, stdout: "" },
    ]);
    const backup = vi.fn(() => Promise.resolve());
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    const awaitHealth = vi.fn(() => Promise.resolve());
    await updateNpmGlobal(
      { channel: "stable", dryRun: false },
      makeDeps(runner, {
        roles: hostRoles({ gateway: supervised, collector: supervised }),
        backup,
        restartService,
        awaitHealth,
      }),
    );
    expect(backup).toHaveBeenCalledOnce();
    expect(awaitHealth).toHaveBeenCalledWith("0.3.0", expect.any(AbortSignal));
    expect(restartService.mock.calls.map(([component]) => component)).toEqual([
      "gateway",
      "collector",
    ]);
  });
});

// ── updateDocker ────────────────────────────────────────────────────────

describe("updateDocker", () => {
  /**
   * A compose project with both daemons and the updater this command runs as,
   * beside the env file that records the tag their images are pulled at.
   */
  const COMPOSE = [
    "services:",
    "  gateway:",
    "    image: ghcr.io/omnesis-dev/omnesis-gateway:0.4.1",
    "  collector:",
    "    image: ghcr.io/omnesis-dev/omnesis-collector:0.4.1",
    "  updater:",
    "    profiles: [update]",
    "",
  ].join("\n");

  let projectDir: string;
  let composeFile: string;
  let envFile: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "omnesis-update-docker-"));
    composeFile = join(projectDir, "docker-compose.yml");
    envFile = join(projectDir, ".env");
    writeFileSync(composeFile, COMPOSE, "utf8");
    writeFileSync(envFile, "OMNESIS_GATEWAY_PORT=7600\nOMNESIS_IMAGE_TAG=0.4.1\n", "utf8");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  /**
   * A runner that records every command line and can fail one nominated
   * occurrence of one — the rollback runs the same `pull` as the apply, so
   * "the first pull" is the failure a revert test needs.
   */
  function dockerRunner(events: string[], failAt?: { line: string; nth: number }) {
    const calls: RecordedCall[] = [];
    const seen = new Map<string, number>();
    const run: CommandRunner = (spec, mode) => {
      calls.push({ spec, mode });
      const line = [spec.command, ...spec.args].join(" ");
      events.push(line);
      const nth = (seen.get(line) ?? 0) + 1;
      seen.set(line, nth);
      const failed = failAt !== undefined && failAt.line === line && failAt.nth === nth;
      return Promise.resolve({ code: failed ? 1 : 0, stdout: "" });
    };
    return { run, calls };
  }

  /**
   * Deps wired the way the command wires them for a container install: the
   * real restarter and the real tag write, over a fake runner. Everything the
   * flow does lands in `events`, in order.
   */
  function dockerDeps(
    events: string[],
    runner: { run: CommandRunner; calls: RecordedCall[] },
    overrides: Partial<UpdateFlowDeps> = {},
  ): UpdateFlowDeps {
    const restart = dockerRestarter(composeFile, runner.run);
    return makeDeps(runner, {
      // The CLI version baked into the updater image, deliberately unlike any
      // tag this project is pulled at: what these containers run is the tag on
      // file, and nothing here may fall back to the updater's own number.
      currentVersion: "0.9.0",
      roles: hostRoles({ gateway: supervised, collector: supervised }),
      backup: vi.fn(() => {
        events.push("backup");
        return Promise.resolve();
      }),
      select: vi.fn((tag: string) => {
        events.push(`select ${tag}`);
        return selectImageTag(projectDir, tag);
      }),
      restartService: vi.fn((component: ServiceComponent) => restart(component)),
      awaitHealth: vi.fn((expected: string | null) => {
        events.push(`awaitHealth ${expected}`);
        return Promise.resolve();
      }),
      latestPublished: vi.fn(() => Promise.resolve("0.4.2")),
      ...overrides,
    });
  }

  const opts = (over: Partial<Parameters<typeof updateDocker>[0]> = {}) => ({
    composeFile,
    projectDir,
    edge: false,
    dryRun: false,
    ...over,
  });

  test("the ordered plan: back up, record the tag, pull, gateway, health, collector", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    const landed = await updateDocker(opts(), dockerDeps(events, runner));

    expect(events).toEqual([
      "backup",
      "select 0.4.2",
      `docker compose -f ${composeFile} pull`,
      `docker compose -f ${composeFile} up -d --no-deps gateway`,
      "awaitHealth 0.4.2",
      `docker compose -f ${composeFile} up -d --no-deps collector`,
    ]);
    expect(landed).toBe("0.4.2");
    // The tag is what makes the pull and the recreations resolve the new
    // images, so it is on disk when they run.
    expect(readFileSync(envFile, "utf8")).toBe(
      "OMNESIS_GATEWAY_PORT=7600\nOMNESIS_IMAGE_TAG=0.4.2\n",
    );
  });

  test("the newest published release becomes the image tag", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    const latestPublished = vi.fn(() => Promise.resolve("0.4.2"));
    await updateDocker(opts(), dockerDeps(events, runner, { latestPublished }));
    expect(latestPublished).toHaveBeenCalledWith("latest");
  });

  test("a failed pull records the previous tag again and brings the gateway back", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events, {
      line: `docker compose -f ${composeFile} pull`,
      nth: 1,
    });
    await expect(updateDocker(opts(), dockerDeps(events, runner))).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
    });

    expect(events).toEqual([
      "backup",
      "select 0.4.2",
      `docker compose -f ${composeFile} pull`,
      // The way back is the same pull at the tag that was recorded before.
      "select 0.4.1",
      `docker compose -f ${composeFile} pull`,
      `docker compose -f ${composeFile} up -d --no-deps gateway`,
      // The version demanded of the restored gateway is the tag being put
      // back, not the CLI version of the updater image running this command.
      "awaitHealth 0.4.1",
    ]);
    expect(readFileSync(envFile, "utf8")).toContain("OMNESIS_IMAGE_TAG=0.4.1");
  });

  test("a gateway that never comes back is rolled back to the tag it was on", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    let probed = 0;
    const awaitHealth = vi.fn((expected: string | null) => {
      events.push(`awaitHealth ${expected}`);
      // The wait on the new build fails; the one in the rollback succeeds.
      return probed++ === 0 ? Promise.reject(new Error("timed out")) : Promise.resolve();
    });
    await expect(
      updateDocker(opts(), dockerDeps(events, runner, { awaitHealth })),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });

    expect(events).toEqual([
      "backup",
      "select 0.4.2",
      `docker compose -f ${composeFile} pull`,
      `docker compose -f ${composeFile} up -d --no-deps gateway`,
      "awaitHealth 0.4.2",
      "select 0.4.1",
      `docker compose -f ${composeFile} pull`,
      `docker compose -f ${composeFile} up -d --no-deps gateway`,
      "awaitHealth 0.4.1",
    ]);
    expect(readFileSync(envFile, "utf8")).toContain("OMNESIS_IMAGE_TAG=0.4.1");
    expect(output()).toContain("0.4.1 is serving again.");
  });

  // Without a recorded tag there is no image to return to, and the containers
  // themselves report no version this command can read back.
  test("an env file with no usable tag is refused before anything runs", async () => {
    writeFileSync(envFile, "OMNESIS_GATEWAY_PORT=7600\n", "utf8");
    const events: string[] = [];
    const runner = dockerRunner(events);
    await expect(updateDocker(opts(), dockerDeps(events, runner))).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringMatching(/OMNESIS_IMAGE_TAG/u),
    });
    expect(events).toEqual([]);
  });

  test("--edge moves to the main tag and demands no version of the gateway", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    const landed = await updateDocker(opts({ edge: true }), dockerDeps(events, runner));
    expect(events).toContain("select main");
    expect(events).toContain("awaitHealth null");
    // A branch build has no release number for the fleet fan-out to compare.
    expect(landed).toBeNull();
  });

  test("a dry run prints the plan and touches nothing", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    const landed = await updateDocker(opts({ dryRun: true }), dockerDeps(events, runner));
    expect(landed).toBeNull();
    expect(events).toEqual([]);
    expect(readFileSync(envFile, "utf8")).toContain("OMNESIS_IMAGE_TAG=0.4.1");
    expect(output()).toContain("Dry run");
    expect(output()).toContain(`docker compose -f ${composeFile} pull`);
  });

  test("a downgrade is refused without --force", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    await expect(
      updateDocker(
        opts({ targetVersion: "0.4.0" }),
        dockerDeps(events, runner, { latestPublished: undefined }),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    expect(events).toEqual([]);
  });

  test("a tag already on file is pulled again unless something proves it was served", async () => {
    // The tag is written before the pull, so on its own it is intent, not
    // proof: with no record and no gateway answering, the apply is repeated.
    const events: string[] = [];
    const runner = dockerRunner(events);
    const landed = await updateDocker(
      opts(),
      dockerDeps(events, runner, { latestPublished: () => Promise.resolve("0.4.1") }),
    );
    expect(landed).toBe("0.4.1");
    expect(events).toContain(`docker compose -f ${composeFile} pull`);
    expect(output()).toContain("nothing proves the containers were recreated on it");
    expect(output()).not.toContain("Already up to date");
  });

  test("a complete record for the tag on file is what makes it already up to date", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    const state = fakeApplyState(
      serializeUpdateApplyState(completedDockerApplyState(projectDir, "0.4.1")),
    );
    const landed = await updateDocker(
      opts(),
      dockerDeps(events, runner, {
        latestPublished: () => Promise.resolve("0.4.1"),
        applyState: state.store,
      }),
    );
    expect(landed).toBe("0.4.1");
    expect(events).toEqual([]);
    expect(output()).toContain("Already up to date (0.4.1)");
    expect(state.writes).toEqual([]);
  });

  test("the gateway serving the tag stands in for a record written before completion tracking", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    const state = fakeApplyState();
    const landed = await updateDocker(
      opts(),
      dockerDeps(events, runner, {
        latestPublished: () => Promise.resolve("0.4.1"),
        servedVersion: () => Promise.resolve("0.4.1"),
        applyState: state.store,
      }),
    );
    expect(landed).toBe("0.4.1");
    expect(events).toEqual([]);
    // Left behind so the next run need not ask the gateway.
    expect(state.writes).toEqual([completedDockerApplyState(projectDir, "0.4.1")]);
  });

  test("an update killed during the pull is reapplied on the next run, without --force", async () => {
    // The footprint a kill leaves: the tag moved to the target, the record
    // still says applying from the last served tag, and the gateway still
    // serves that tag.
    writeFileSync(envFile, "OMNESIS_GATEWAY_PORT=7600\nOMNESIS_IMAGE_TAG=0.4.2\n", "utf8");
    const state = fakeApplyState(
      serializeUpdateApplyState(activeDockerApplyState(projectDir, "applying", "0.4.2", "0.4.1")),
    );
    const events: string[] = [];
    const runner = dockerRunner(events);
    const landed = await updateDocker(
      opts({ targetVersion: "0.4.2" }),
      dockerDeps(events, runner, {
        servedVersion: () => Promise.resolve("0.4.1"),
        applyState: state.store,
      }),
    );
    expect(landed).toBe("0.4.2");
    expect(output()).toContain("The previous container update did not finish");
    expect(output()).toContain("0.4.1 is what these containers last served");
    expect(events.slice(0, 3)).toEqual([
      "backup",
      "select 0.4.2",
      `docker compose -f ${composeFile} pull`,
    ]);
    // The baseline the health wait and a rollback use is the served tag, not the file's.
    expect(events).toContain("awaitHealth 0.4.2");
    expect(state.writes.map((value) => value.phase)).toEqual(["applying", "complete"]);
    expect(state.writes.at(-1)).toEqual(completedDockerApplyState(projectDir, "0.4.2"));
  });

  test("a reapply that fails goes back to the tag last served, not the tag on file", async () => {
    writeFileSync(envFile, "OMNESIS_GATEWAY_PORT=7600\nOMNESIS_IMAGE_TAG=0.4.2\n", "utf8");
    const state = fakeApplyState(
      serializeUpdateApplyState(activeDockerApplyState(projectDir, "applying", "0.4.2", "0.4.1")),
    );
    const events: string[] = [];
    const runner = dockerRunner(events, { line: `docker compose -f ${composeFile} pull`, nth: 1 });
    await expect(
      updateDocker(
        opts({ targetVersion: "0.4.2" }),
        dockerDeps(events, runner, {
          servedVersion: () => Promise.resolve("0.4.1"),
          applyState: state.store,
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("Rolled back to 0.4.1") });
    expect(readFileSync(envFile, "utf8")).toContain("OMNESIS_IMAGE_TAG=0.4.1");
    expect(events).toContain("awaitHealth 0.4.1");
    expect(state.writes.map((value) => value.phase)).toEqual([
      "applying",
      "rolling-back",
      "complete",
    ]);
    expect(state.writes.at(-1)).toEqual(completedDockerApplyState(projectDir, "0.4.1"));
  });

  test("completion is recorded only once the gateway serves the new image", async () => {
    const state = fakeApplyState();
    const events: string[] = [];
    const runner = dockerRunner(events);
    const recording: UpdateApplyStateStore = {
      read: () => null,
      write: (value) => {
        events.push(`record ${value.phase}`);
        state.store.write(value);
      },
    };
    await updateDocker(opts(), dockerDeps(events, runner, { applyState: recording }));
    // The record goes down before the tag moves, and completes only after
    // the gateway answered on the new image.
    expect(events.indexOf("record applying")).toBeLessThan(events.indexOf("select 0.4.2"));
    expect(events.indexOf("record complete")).toBeGreaterThan(events.indexOf("awaitHealth 0.4.2"));
    expect(state.writes.map((value) => value.phase)).toEqual(["applying", "complete"]);
    expect(state.writes[0]).toEqual(
      activeDockerApplyState(projectDir, "applying", "0.4.2", "0.4.1"),
    );
  });

  test("a signal once the gateway serves the new image stops the run without undoing it", async () => {
    // The collector's recreation follows the health wait; a migrated gateway
    // is the half worth keeping, so the interrupt is not a rollback.
    const exit = vi.fn();
    const router = new UpdateInterruptionRouter(exit);
    const state = fakeApplyState();
    const events: string[] = [];
    const runner = dockerRunner(events);
    const restart = dockerRestarter(composeFile, runner.run);
    await updateDocker(
      opts(),
      dockerDeps(events, runner, {
        interruptions: router,
        applyState: state.store,
        restartService: vi.fn(async (component: ServiceComponent) => {
          if (component === "collector") router.dispatch("SIGINT");
          await restart(component);
        }),
      }),
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
    expect(readFileSync(envFile, "utf8")).toContain("OMNESIS_IMAGE_TAG=0.4.2");
    expect(events.filter((line) => line.endsWith(" pull"))).toHaveLength(1);
    expect(state.writes.map((value) => value.phase)).toEqual(["applying", "complete"]);
    expect(state.writes.at(-1)).toEqual(completedDockerApplyState(projectDir, "0.4.2"));
  });

  test("with nothing restarted, the record stays applying for the next run to verify", async () => {
    const state = fakeApplyState();
    const events: string[] = [];
    const runner = dockerRunner(events);
    await updateDocker(
      opts(),
      dockerDeps(events, runner, { applyState: state.store, restart: false }),
    );
    expect(events).not.toContain("awaitHealth 0.4.2");
    expect(state.writes.map((value) => value.phase)).toEqual(["applying"]);
  });

  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "%s during the pull rolls the tag back and records the rollback",
    async (signal, exitCode) => {
      const exit = vi.fn();
      const router = new UpdateInterruptionRouter(exit);
      const state = fakeApplyState();
      const events: string[] = [];
      let pulls = 0;
      const run: CommandRunner = (spec, mode) => {
        const line = [spec.command, ...spec.args].join(" ");
        events.push(line);
        if (line.endsWith(" pull") && pulls++ === 0) router.dispatch(signal);
        return Promise.resolve({ code: 0, stdout: "" });
      };
      const runner = { run, calls: [] as RecordedCall[] };
      await expect(
        updateDocker(
          opts(),
          dockerDeps(events, runner, { interruptions: router, applyState: state.store }),
        ),
      ).rejects.toMatchObject({
        exitCode,
        message: expect.stringContaining(`interrupted by ${signal}`),
      });
      expect(readFileSync(envFile, "utf8")).toContain("OMNESIS_IMAGE_TAG=0.4.1");
      expect(state.writes.map((value) => value.phase)).toEqual([
        "applying",
        "rolling-back",
        "complete",
      ]);
      expect(state.writes.at(-1)).toEqual(completedDockerApplyState(projectDir, "0.4.1"));
      expect(exit).not.toHaveBeenCalled();
    },
  );

  test("an interrupt during the health wait rolls back too", async () => {
    const exit = vi.fn();
    const router = new UpdateInterruptionRouter(exit);
    const state = fakeApplyState();
    const events: string[] = [];
    const runner = dockerRunner(events);
    await expect(
      updateDocker(
        opts(),
        dockerDeps(events, runner, {
          interruptions: router,
          applyState: state.store,
          awaitHealth: vi.fn((expected: string | null, signal?: AbortSignal) => {
            events.push(`awaitHealth ${expected}`);
            if (expected === "0.4.2") {
              router.dispatch("SIGINT");
              return Promise.reject(new Error(signal?.aborted ? "aborted" : "not aborted"));
            }
            return Promise.resolve();
          }),
        }),
      ),
    ).rejects.toMatchObject({
      exitCode: 130,
      message: expect.stringContaining("interrupted by SIGINT"),
    });
    expect(readFileSync(envFile, "utf8")).toContain("OMNESIS_IMAGE_TAG=0.4.1");
    expect(events.filter((line) => line.endsWith(" pull"))).toHaveLength(2);
    expect(state.writes.map((value) => value.phase)).toEqual([
      "applying",
      "rolling-back",
      "complete",
    ]);
  });

  test("the plan follows the compose project, not this host's service units", async () => {
    writeFileSync(
      composeFile,
      [
        "services:",
        "  gateway:",
        "    image: g:0.4.1",
        "  updater:",
        "    profiles: [update]",
        "",
      ].join("\n"),
      "utf8",
    );
    const events: string[] = [];
    const runner = dockerRunner(events);
    await updateDocker(opts(), dockerDeps(events, runner));
    // No collector service, so nothing recreates one — even though the roles
    // handed to the flow say this host has one.
    expect(events).not.toContain(`docker compose -f ${composeFile} up -d --no-deps collector`);
  });

  // The shallow compose scan reads one dialect. A project written in another
  // yields no services, and a plan built from that silence would be an apply
  // and nothing else: no backup, no container recreated, no health wait, and a
  // "Updated to X" over a host still running the old images.
  test("a project this scan finds no Omnesis services in is refused", async () => {
    writeFileSync(
      composeFile,
      ["services:", '  "gateway":', "    image: g:0.4.1", ""].join("\n"),
      "utf8",
    );
    const events: string[] = [];
    const runner = dockerRunner(events);
    await expect(updateDocker(opts(), dockerDeps(events, runner))).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringMatching(/No gateway or collector service is declared/u),
    });
    expect(events).toEqual([]);
    expect(readFileSync(envFile, "utf8")).toContain("OMNESIS_IMAGE_TAG=0.4.1");
  });

  test("a compose project that cannot be read is refused", async () => {
    rmSync(composeFile, { force: true });
    const events: string[] = [];
    const runner = dockerRunner(events);
    await expect(updateDocker(opts(), dockerDeps(events, runner))).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringMatching(/Could not read the compose project/u),
    });
    expect(events).toEqual([]);
  });

  // The apply and the rollback run the same `compose pull`; only the recorded
  // tag decides which images it fetches. Unwired, this flow would pull the tag
  // already on file and report an update that did not happen.
  test("a flow with no way to record the tag is refused before anything runs", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    await expect(
      updateDocker(opts(), dockerDeps(events, runner, { select: undefined })),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
    expect(events).toEqual([]);
    expect(readFileSync(envFile, "utf8")).toContain("OMNESIS_IMAGE_TAG=0.4.1");
  });

  // `omnesis service restart gateway` through the docker CLI wrapper runs
  // inside a container that has no service manager.
  test("--no-restart names the compose command, not a service one", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    await updateDocker(opts(), dockerDeps(events, runner, { restart: false }));
    expect(output()).toContain(`docker compose -f ${composeFile} up -d --no-deps gateway`);
    expect(output()).toContain(`docker compose -f ${composeFile} up -d --no-deps collector`);
    expect(output()).not.toContain("omnesis service restart");
  });

  // The tag is recorded before a pull that takes minutes, so a killed process
  // leaves the file naming a version nothing serves. Without this, the only
  // way out of that window is re-running the installer.
  test("--force re-applies a tag already on file", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    const landed = await updateDocker(
      opts({ force: true }),
      dockerDeps(events, runner, { latestPublished: () => Promise.resolve("0.4.1") }),
    );
    expect(landed).toBe("0.4.1");
    expect(events).toEqual([
      "backup",
      "select 0.4.1",
      `docker compose -f ${composeFile} pull`,
      `docker compose -f ${composeFile} up -d --no-deps gateway`,
      "awaitHealth 0.4.1",
      `docker compose -f ${composeFile} up -d --no-deps collector`,
    ]);
  });

  test("the way out of that window is taken, not named", async () => {
    // A tag on file that nothing served is reapplied without any flag; the
    // explanation says why.
    const events: string[] = [];
    const runner = dockerRunner(events);
    await updateDocker(
      opts(),
      dockerDeps(events, runner, {
        latestPublished: () => Promise.resolve("0.4.1"),
        servedVersion: () => Promise.resolve("0.4.0"),
      }),
    );
    expect(output()).toContain("the gateway serves 0.4.0. Reapplying 0.4.1");
    expect(output()).not.toContain("--force");
    expect(events).toContain("awaitHealth 0.4.1");
  });

  // Both directions of an edge plan pull the same moving tag, so the rollback
  // re-fetches the build that just failed.
  test("--edge says the rollback is not the way back", async () => {
    const events: string[] = [];
    const runner = dockerRunner(events);
    await updateDocker(opts({ edge: true }), dockerDeps(events, runner));
    expect(output()).toContain("the build that just failed");
    expect(output()).toContain("backup");
  });

  describe("handing the rest to the updater the pull brought", () => {
    const taken = (): Promise<ContinuationOutcome> =>
      Promise.resolve({ accepted: true, code: 0, signal: null });

    test("the images are pulled first, and the backup waits for the updater they carry", async () => {
      const events: string[] = [];
      const runner = dockerRunner(events);
      const continueAfterApply = vi.fn((offer: ContinuationOffer) => {
        events.push(`hand over (${offer.deferredBackup} backup)`);
        return taken();
      });
      const applyState = fakeApplyState();
      const landed = await updateDocker(
        opts({ targetVersion: "0.5.0" }),
        dockerDeps(events, runner, { continueAfterApply, applyState: applyState.store }),
      );

      // A pull recreates no container, so the gateway still runs its old image
      // and its API backup belongs to the build that follows.
      expect(events).toEqual([
        "select 0.5.0",
        `docker compose -f ${composeFile} pull`,
        "hand over (online backup)",
      ]);
      expect(continueAfterApply).toHaveBeenCalledWith(
        {
          subject: {
            method: "docker",
            composeFile,
            projectDir,
            target: "0.5.0",
            previous: "0.4.1",
          },
          targetVersion: "0.5.0",
          previousVersion: "0.4.1",
          deferredBackup: "online",
          restart: true,
        },
        expect.anything(),
      );
      // Completion is the continuing build's to record once its gateway serves.
      expect(applyState.writes).toEqual([
        activeDockerApplyState(projectDir, "applying", "0.5.0", "0.4.1"),
      ]);
      expect(landed).toBe("0.5.0");
    });

    test("an updater that does not take it leaves this one to back up and restart", async () => {
      const events: string[] = [];
      const runner = dockerRunner(events);
      const continueAfterApply = vi.fn(() => {
        events.push("hand over");
        return Promise.resolve({ accepted: false, code: 1, signal: null, detail: "it exited 1" });
      });
      await updateDocker(
        opts({ targetVersion: "0.5.0" }),
        dockerDeps(events, runner, { continueAfterApply }),
      );
      expect(events).toEqual([
        "select 0.5.0",
        `docker compose -f ${composeFile} pull`,
        "hand over",
        "backup",
        `docker compose -f ${composeFile} up -d --no-deps gateway`,
        "awaitHealth 0.5.0",
        `docker compose -f ${composeFile} up -d --no-deps collector`,
      ]);
      expect(output()).toContain("did not take over the rest of this update (it exited 1)");
    });

    test("the main tag has no release to hand over to, so everything runs here", async () => {
      const events: string[] = [];
      const runner = dockerRunner(events);
      const continueAfterApply = vi.fn(taken);
      await updateDocker(opts({ edge: true }), dockerDeps(events, runner, { continueAfterApply }));
      expect(continueAfterApply).not.toHaveBeenCalled();
      expect(events[0]).toBe("backup");
    });

    test("a release older than the hand-over runs everything here, in the old order", async () => {
      const events: string[] = [];
      const runner = dockerRunner(events);
      const continueAfterApply = vi.fn(taken);
      await updateDocker(opts(), dockerDeps(events, runner, { continueAfterApply }));
      expect(continueAfterApply).not.toHaveBeenCalled();
      expect(events[0]).toBe("backup");
    });
  });

  describe("resolving the newest release", () => {
    test("no resolver at all is refused", async () => {
      const events: string[] = [];
      const runner = dockerRunner(events);
      await expect(
        updateDocker(opts(), dockerDeps(events, runner, { latestPublished: undefined })),
      ).rejects.toMatchObject({
        exitCode: EXIT_FAILURE,
        message: expect.stringMatching(/--target-version/u),
      });
      expect(events).toEqual([]);
    });

    test("a resolver that throws is refused, carrying what it said", async () => {
      const events: string[] = [];
      const runner = dockerRunner(events);
      await expect(
        updateDocker(
          opts(),
          dockerDeps(events, runner, {
            latestPublished: () => Promise.reject(new Error("HTTP 503")),
          }),
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_FAILURE,
        message: expect.stringMatching(/HTTP 503/u),
      });
      expect(events).toEqual([]);
    });

    // The answer becomes an image tag, so anything that is not a version is a
    // broken index rather than something to pull.
    test("an answer that is not a version is refused", async () => {
      const events: string[] = [];
      const runner = dockerRunner(events);
      await expect(
        updateDocker(
          opts(),
          dockerDeps(events, runner, { latestPublished: () => Promise.resolve("latest") }),
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_FAILURE,
        message: expect.stringMatching(/did not resolve to a version/u),
      });
      expect(events).toEqual([]);
    });
  });

  // The gateway loads this same file as its own environment, so it can carry
  // the secret-store settings that decide whether the corpus opens at all.
  describe("recording the tag", () => {
    test("reaches the environment the compose commands inherit", async () => {
      // Compose resolves a variable from the environment before it reads the
      // file, and this CLI loaded that same file into its environment at
      // startup — so a tag written only to disk would be shadowed by the one
      // this update is moving away from, and every pull and recreate would
      // resolve the old image.
      const before = process.env.OMNESIS_IMAGE_TAG;
      try {
        writeFileSync(envFile, "OMNESIS_IMAGE_TAG=0.4.1\n", "utf8");
        process.env.OMNESIS_IMAGE_TAG = "0.4.1";
        await selectImageTag(projectDir, "0.4.2");
        expect(process.env.OMNESIS_IMAGE_TAG).toBe("0.4.2");
        expect(readFileSync(envFile, "utf8")).toContain("OMNESIS_IMAGE_TAG=0.4.2");
      } finally {
        if (before === undefined) delete process.env.OMNESIS_IMAGE_TAG;
        else process.env.OMNESIS_IMAGE_TAG = before;
      }
    });

    test("touches the key and nothing else", async () => {
      writeFileSync(
        envFile,
        [
          "# written by the installer",
          "",
          'OMNESIS_KEYRING_PASSPHRASE_FILE="/cfg/keyring.pass"',
          "export OMNESIS_IMAGE_TAG=0.4.1 # pinned",
          "OMNESIS_GATEWAY_PORT=7600",
          "",
        ].join("\n"),
        "utf8",
      );
      await selectImageTag(projectDir, "0.4.2");
      const written = readFileSync(envFile, "utf8");
      expect(written).toContain("# written by the installer");
      expect(written).toContain('OMNESIS_KEYRING_PASSPHRASE_FILE="/cfg/keyring.pass"');
      expect(written).toContain("OMNESIS_GATEWAY_PORT=7600");
      expect(written).toContain("OMNESIS_IMAGE_TAG=0.4.2");
      expect(written).not.toContain("0.4.1");
    });

    test("appends the key to a file that has none", async () => {
      writeFileSync(envFile, "OMNESIS_GATEWAY_PORT=7600\n", "utf8");
      await selectImageTag(projectDir, "main");
      expect(readFileSync(envFile, "utf8")).toBe(
        "OMNESIS_GATEWAY_PORT=7600\nOMNESIS_IMAGE_TAG=main\n",
      );
    });

    // The value becomes the tag half of an image reference.
    test("a tag that is not a tag never reaches the file", async () => {
      await expect(selectImageTag(projectDir, "0.4.2 --privileged")).rejects.toThrow();
      expect(readFileSync(envFile, "utf8")).toContain("OMNESIS_IMAGE_TAG=0.4.1");
    });
  });

  test("the tag selection is the seam every apply plan runs through", async () => {
    // Docker is the only install that needs it — the package and source flows
    // carry their target in the commands themselves, and the command leaves it
    // undefined for them — but the seam belongs to the plan, so a wired one is
    // handed that plan's target and changes nothing else.
    const select = vi.fn(() => Promise.resolve());
    const runner = fakeRunner([
      { code: 0, stdout: "0.3.0\n" },
      { code: 0, stdout: "" },
    ]);
    await updateNpmGlobal({ channel: "stable", dryRun: false }, makeDeps(runner, { select }));
    expect(select).toHaveBeenCalledExactlyOnceWith("0.3.0");
    expect(executed(runner)).toEqual(["npm install -g omnesis@0.3.0"]);
  });
});

// ── The health wait ─────────────────────────────────────────────────────

describe("awaitGatewayHealth", () => {
  const URL = "https://localhost:7600";

  /** A clock that only advances when the wait sleeps, so no test really waits. */
  function fakeClock(answers: Array<{ ok: boolean; status: number; version?: string } | Error>) {
    let clock = 0;
    const probes: string[] = [];
    const deps: HealthWaitDeps = {
      probe: (url) => {
        probes.push(url);
        const answer = answers[Math.min(probes.length - 1, answers.length - 1)];
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    };
    return { deps, probes };
  }

  test("probes the gateway's own health route", async () => {
    const { deps, probes } = fakeClock([{ ok: true, status: 200, version: "0.3.0" }]);
    await awaitGatewayHealth(URL, "0.3.0", 10_000, deps);
    expect(probes).toEqual(["https://localhost:7600/health"]);
  });

  // The failure this exists to prevent: a gateway that has not finished
  // shutting down answers 200 from the OLD build, and taking that as success
  // would restart the collector against a schema mid-migration.
  test("a healthy answer from the previous version is not the new build", async () => {
    const { deps, probes } = fakeClock([
      { ok: true, status: 200, version: "0.2.0" },
      { ok: true, status: 200, version: "0.2.0" },
      { ok: true, status: 200, version: "0.3.0" },
    ]);
    await awaitGatewayHealth(URL, "0.3.0", 60_000, deps);
    expect(probes).toHaveLength(3);
  });

  test("with no version to demand, the first healthy answer is taken", async () => {
    const { deps, probes } = fakeClock([{ ok: true, status: 200, version: "anything" }]);
    await awaitGatewayHealth(URL, null, 10_000, deps);
    expect(probes).toHaveLength(1);
  });

  test("a non-200 keeps polling until the deadline, and names the status", async () => {
    const { deps } = fakeClock([{ ok: false, status: 503 }]);
    await expect(awaitGatewayHealth(URL, null, 4_000, deps)).rejects.toThrow(/HTTP 503/u);
  });

  test("a refused connection keeps polling until the deadline, and names the error", async () => {
    const { deps } = fakeClock([new Error("ECONNREFUSED")]);
    await expect(awaitGatewayHealth(URL, "0.3.0", 4_000, deps)).rejects.toThrow(/ECONNREFUSED/u);
  });

  test("the timeout message names the version it was waiting for", async () => {
    const { deps } = fakeClock([{ ok: true, status: 200, version: "0.2.0" }]);
    await expect(awaitGatewayHealth(URL, "0.3.0", 4_000, deps)).rejects.toThrow(
      /did not report 0\.3\.0 within 4s \(still serving 0\.2\.0\)/u,
    );
  });

  test("one probe is always made, even with no time left", async () => {
    const { deps, probes } = fakeClock([{ ok: true, status: 200, version: "0.3.0" }]);
    await awaitGatewayHealth(URL, "0.3.0", 0, deps);
    expect(probes).toHaveLength(1);
  });

  test("an aborted migration health wait stops before another probe", async () => {
    const { deps, probes } = fakeClock([{ ok: true, status: 200, version: "0.3.0" }]);
    const controller = new AbortController();
    controller.abort();
    await expect(awaitGatewayHealth(URL, "0.3.0", 10_000, deps, controller.signal)).rejects.toThrow(
      /aborted/u,
    );
    expect(probes).toHaveLength(0);
  });
});

describe("parseHealthTimeoutSeconds", () => {
  test("a whole number of seconds", () => {
    expect(parseHealthTimeoutSeconds("900")).toBe(900);
  });

  test("the default when the flag is absent", () => {
    expect(parseHealthTimeoutSeconds(undefined)).toBe(600);
  });

  // Read leniently, "10min" would become ten seconds and roll back a healthy
  // migration — the exact failure the timeout exists to avoid.
  test("anything that is not a whole number of seconds is refused", () => {
    for (const bad of ["10min", "0", "-30", "", "1.5", "600s", "abc"]) {
      expect(parseHealthTimeoutSeconds(bad)).toBeNull();
    }
  });
});

// ── Rollback ────────────────────────────────────────────────────────────

describe("rolling back a failed update", () => {
  const rootDir = "/home/dev/omnesis";
  const managed = { code: 0, stdout: "managed\n" };
  const clean = { code: 0, stdout: "" };
  const tags = { code: 0, stdout: "abc\trefs/tags/v0.3.0\n" };
  const manifest = { code: 0, stdout: '{"version":"0.3.0"}\n' };
  const head = { code: 0, stdout: "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3\n" };
  const previousRef = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";
  // `git rev-list -n 1 <tag>`: a different commit, so the checkout is moved.
  const targetSha = { code: 0, stdout: "1122334455667788990011223344556677889900\n" };
  const preflight = [managed, clean, tags, clean, manifest, head, targetSha, clean];
  const rollback = [clean, clean, clean];

  const source = (deps: UpdateFlowDeps) =>
    updateSourceCheckout({ rootDir, edge: false, dryRun: false }, deps);

  describe("a machine that cannot compile native modules", () => {
    // A release whose dependency set has no prebuilt binary for this platform
    // compiles better-sqlite3 during `npm ci`. On a machine with no compiler
    // that is a rollback and an npm error naming neither the tool nor the fix,
    // so the toolchain is demanded before the checkout moves.
    const noTools = {
      missing: ["make" as const],
      installCommand: "sudo apt-get install -y build-essential python3",
    };

    test("the update refuses, names the tool and the command, and executes nothing", async () => {
      const runner = fakeRunner([managed, clean, tags, clean, manifest, clean]);
      const failure = await source(makeDeps(runner, { missingBuildTools: () => noTools })).then(
        unexpectedSuccess,
        (err: unknown) => err as Error,
      );
      expect(failure.message).toContain("missing make");
      expect(failure.message).toContain("sudo apt-get install -y build-essential python3");
      expect(failure.message).toContain("still on its current release");
      // Nothing was fetched and nothing was checked out: the refusal is the
      // whole of what this run did.
      expect(executed(runner)).toEqual([]);
    });

    test("a dry run says so without failing, so the operator can see it coming", async () => {
      const runner = fakeRunner([managed, clean, tags, clean, manifest, clean]);
      await updateSourceCheckout(
        { rootDir, edge: false, dryRun: true },
        makeDeps(runner, { missingBuildTools: () => noTools }),
      );
      expect(logged.join("\n")).toContain("missing make");
      expect(executed(runner)).toEqual([]);
    });

    test("a machine with the toolchain is not stopped", async () => {
      const runner = fakeRunner([...preflight, clean, clean, clean]);
      await source(
        makeDeps(runner, { missingBuildTools: () => ({ missing: [], installCommand: null }) }),
      );
      expect(executed(runner)).toContain("npm ci");
    });
  });

  describe("an install that fails over the previous build's node_modules", () => {
    // npm installs over the root node_modules a workspace checkout already
    // has, and some transitions between two lockfiles crash that in-place
    // install the same way every time; an install from an empty tree does not.
    const failed = { code: 1, stdout: "" };

    test("the install is retried once from an empty node_modules, and the update completes", async () => {
      const runner = fakeRunner([...preflight, clean, failed, clean, clean, clean]);
      await source(makeDeps(runner));
      expect(executed(runner).slice(1)).toEqual([
        "git checkout --detach v0.3.0",
        "npm ci",
        "rm -rf node_modules",
        "npm ci",
        "npm run build",
      ]);
      const reset = runner.calls.find((call) => call.spec.command === "rm");
      expect(reset?.spec.cwd).toBe(rootDir);
      expect(logged.join("\n")).toContain(
        "`npm ci` failed (exit 1); installing the dependencies again from an empty node_modules.",
      );
      expect(logged.join("\n")).not.toContain("Rolled back");
    });

    test("a retry that fails too rolls back, and the rollback's own install gets the same retry", async () => {
      const runner = fakeRunner([
        ...preflight,
        clean,
        failed,
        clean,
        failed,
        // The rollback: checkout, a failing install, its reset and retry, build.
        clean,
        failed,
        clean,
        clean,
        clean,
      ]);
      const failure = await source(makeDeps(runner)).then(
        unexpectedSuccess,
        (err: unknown) => err as Error,
      );
      expect(failure.message).toContain("`npm ci` failed (exit 1).");
      expect(failure.message).toContain(`Rolled back to ${previousRef}.`);
      expect(executed(runner).slice(1)).toEqual([
        "git checkout --detach v0.3.0",
        "npm ci",
        "rm -rf node_modules",
        "npm ci",
        `git checkout --detach ${previousRef}`,
        "npm ci",
        "rm -rf node_modules",
        "npm ci",
        "npm run build",
      ]);
    });

    test("a reset that fails reports the install's own failure and rolls back", async () => {
      const runner = fakeRunner([...preflight, clean, failed, failed, ...rollback]);
      const failure = await source(makeDeps(runner)).then(
        unexpectedSuccess,
        (err: unknown) => err as Error,
      );
      expect(failure.message).toContain("`npm ci` failed (exit 1).");
      expect(executed(runner).slice(1, 4)).toEqual([
        "git checkout --detach v0.3.0",
        "npm ci",
        "rm -rf node_modules",
      ]);
    });

    test("a killed install is not retried: a second run meets the same memory shortage", async () => {
      const runner = fakeRunner([...preflight, clean, { code: 137, stdout: "" }, ...rollback]);
      await expect(source(makeDeps(runner))).rejects.toMatchObject({
        message: expect.stringContaining("`npm ci` was killed (exit 137)"),
      });
      expect(executed(runner)).not.toContain("rm -rf node_modules");
    });

    test("a failing build is not a reason to reinstall", async () => {
      const runner = fakeRunner([...preflight, clean, clean, failed, ...rollback]);
      await expect(source(makeDeps(runner))).rejects.toMatchObject({
        message: expect.stringContaining("`npm run build` failed (exit 1)."),
      });
      expect(executed(runner)).not.toContain("rm -rf node_modules");
    });
  });

  describe("a build short of memory", () => {
    const killedBuild = { code: 137, stdout: "" };

    /** Inherited commands and service-manager calls, in the order they happened. */
    function recording(outcomes: RunOutcome[]) {
      const events: string[] = [];
      const inner = fakeRunner(outcomes);
      const run: CommandRunner = (spec, mode, control) => {
        if (mode === "inherit") events.push([spec.command, ...spec.args].join(" "));
        return inner.run(spec, mode, control);
      };
      const service = (verb: string) =>
        vi.fn((component: ServiceComponent) => {
          events.push(`${verb} ${component}`);
          return Promise.resolve();
        });
      return {
        events,
        runner: { run, calls: inner.calls },
        services: {
          stopService: service("stop"),
          startService: service("start"),
          restartService: service("restart"),
        },
      };
    }

    test("a killed build says the machine most likely ran out of memory, and how to update", async () => {
      const { runner } = recording([...preflight, clean, clean, killedBuild, ...rollback]);
      const failure = await source(makeDeps(runner)).then(
        unexpectedSuccess,
        (err: unknown) => err as Error,
      );
      expect(failure.message).toContain(
        "`npm run build` was killed (exit 137), most likely because this machine ran out of memory.",
      );
      expect(failure.message).toContain(`Rolled back to ${previousRef}.`);
      expect(failure.message).toContain("`omnesis service stop collector`");
      expect(failure.message).toContain("add swap, or free memory, then run `omnesis update`");
    });

    test("an install ended by SIGKILL is a kill too; an ordinary failure is not", async () => {
      const signalled = recording([
        ...preflight,
        clean,
        { code: 1, signal: "SIGKILL", stdout: "" },
        ...rollback,
      ]);
      await expect(source(makeDeps(signalled.runner))).rejects.toMatchObject({
        message: expect.stringContaining("`npm ci` was killed (SIGKILL), most likely"),
      });
      const failed = recording([...preflight, clean, clean, { code: 2, stdout: "" }, ...rollback]);
      const failure = await source(makeDeps(failed.runner)).then(
        unexpectedSuccess,
        (err: unknown) => err as Error,
      );
      expect(failure.message).toContain("`npm run build` failed (exit 2).");
      expect(failure.message).not.toContain("out of memory");
    });

    test("the plan names the stopped collector, before the apply", async () => {
      const runner = fakeRunner([managed, clean, tags, clean, manifest, clean]);
      await updateSourceCheckout(
        { rootDir, edge: false, dryRun: true },
        makeDeps(runner, {
          roles: hostRoles({ gateway: supervised, collector: supervised }),
          buildMemoryTight: () => true,
        }),
      );
      const plan = logged.slice(logged.indexOf("This host will:") + 1, -3);
      expect(plan.slice(0, 3)).toEqual([
        "  - back up the gateway's databases through its API",
        "  - stop the collector while the build runs, so the build has this machine's memory, and start it again after",
        "  - move this installation to v0.3.0",
      ]);
    });

    test("the collector is stopped for the build and its own restart brings it back; the gateway serves on", async () => {
      const { events, runner, services } = recording([...preflight, clean, clean, clean]);
      await source(
        makeDeps(runner, {
          roles: hostRoles({ gateway: supervised, collector: supervised }),
          buildMemoryTight: () => true,
          ...services,
        }),
      );
      expect(events).toEqual([
        "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
        "stop collector",
        "git checkout --detach v0.3.0",
        "npm ci",
        "npm run build",
        "restart gateway",
        "restart collector",
      ]);
      expect(services.startService).not.toHaveBeenCalled();
      expect(output()).toContain("Stopping the collector while the build runs");
    });

    test("a collector no step restarts is started again once the build is in place", async () => {
      const { events, runner, services } = recording([...preflight, clean, clean, clean]);
      await source(
        makeDeps(runner, {
          roles: hostRoles({ gateway: unsupervised, collector: supervised }),
          buildMemoryTight: () => true,
          ...services,
        }),
      );
      expect(events.slice(1)).toEqual([
        "stop collector",
        "git checkout --detach v0.3.0",
        "npm ci",
        "npm run build",
        "start collector",
      ]);
      expect(output()).toContain("Started the collector again.");
    });

    test("a failed build rebuilds the previous one with the collector still stopped, then starts it", async () => {
      const { events, runner, services } = recording([
        ...preflight,
        clean,
        clean,
        { code: 1, stdout: "" },
        ...rollback,
      ]);
      await expect(
        source(
          makeDeps(runner, {
            roles: hostRoles({ collector: supervised }),
            buildMemoryTight: () => true,
            ...services,
          }),
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("Rolled back") });
      expect(events.slice(1)).toEqual([
        "stop collector",
        "git checkout --detach v0.3.0",
        "npm ci",
        "npm run build",
        `git checkout --detach ${previousRef}`,
        "npm ci",
        "npm run build",
        "start collector",
      ]);
    });

    test("a machine with room, or a run that restarts nothing, stops no daemon for the build", async () => {
      for (const over of [
        { buildMemoryTight: () => false },
        { buildMemoryTight: () => true, restart: false },
      ]) {
        const { events, runner, services } = recording([...preflight, clean, clean, clean]);
        await source(
          makeDeps(runner, {
            roles: hostRoles({ collector: supervised }),
            ...services,
            ...over,
          }),
        );
        expect(services.stopService).not.toHaveBeenCalled();
        expect(services.startService).not.toHaveBeenCalled();
        expect(events).not.toContain("stop collector");
      }
    });

    test("a run that restarts nothing stops nothing for a killed build's rollback either", async () => {
      const { runner, services } = recording([
        ...preflight,
        clean,
        clean,
        killedBuild,
        ...rollback,
      ]);
      await expect(
        source(
          makeDeps(runner, {
            roles: hostRoles({ gateway: supervised, collector: supervised }),
            restart: false,
            ...services,
          }),
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("Rolled back") });
      expect(services.stopService).not.toHaveBeenCalled();
      expect(services.startService).not.toHaveBeenCalled();
    });

    test("after a killed build the rollback stops the gateway and collector to rebuild, then brings both back", async () => {
      const { events, runner, services } = recording([
        ...preflight,
        clean,
        clean,
        killedBuild,
        ...rollback,
      ]);
      await expect(
        source(
          makeDeps(runner, {
            roles: hostRoles({ gateway: supervised, collector: supervised }),
            ...services,
          }),
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("Rolled back") });
      expect(events.slice(1)).toEqual([
        "git checkout --detach v0.3.0",
        "npm ci",
        "npm run build",
        "stop gateway",
        "stop collector",
        `git checkout --detach ${previousRef}`,
        "npm ci",
        "npm run build",
        "restart gateway",
        "start collector",
      ]);
    });

    test("a rebuild killed too leaves both stopped for the recovery and says how to finish it", async () => {
      const { events, runner, services } = recording([
        ...preflight,
        clean,
        clean,
        killedBuild,
        clean,
        clean,
        killedBuild,
      ]);
      const failure = await source(
        makeDeps(runner, {
          roles: hostRoles({ gateway: supervised, collector: supervised }),
          ...services,
        }),
      ).then(unexpectedSuccess, (err: unknown) => err as Error);
      expect(failure.message).toContain(
        "The rollback also failed at `npm run build`, which was killed too, most likely because this machine ran out of memory.",
      );
      expect(failure.message).toContain(
        "Stop the collector and gateway, then run `omnesis update` to finish the recovery.",
      );
      // Until the update finishes the launcher refuses to start either daemon.
      expect(failure.message).toContain(
        "The gateway and collector stopped for the rebuild stay stopped",
      );
      expect(events.slice(-4)).toEqual([
        "stop collector",
        `git checkout --detach ${previousRef}`,
        "npm ci",
        "npm run build",
      ]);
      expect(services.startService).not.toHaveBeenCalled();
      expect(services.restartService).not.toHaveBeenCalled();
    });
  });

  test.each([
    ["SIGINT", 130, "SIGTERM"],
    ["SIGTERM", 143, "SIGINT"],
  ] as const)(
    "%s during npm ci waits for the child, then rolls back exactly once",
    async (signal, exitCode, repeatedSignal) => {
      const calls: RecordedCall[] = [];
      const exit = vi.fn();
      const router = new UpdateInterruptionRouter(exit);
      const state = fakeApplyState();
      let firstCi = true;
      let ciSignal: AbortSignal | undefined;
      let finishCi!: (outcome: RunOutcome) => void;
      const pendingCi = new Promise<RunOutcome>((resolve) => {
        finishCi = resolve;
      });
      const run: CommandRunner = (spec, mode, control) => {
        calls.push({ spec, mode });
        const [operation] = spec.args;
        if (mode === "capture") {
          if (operation === "config") return Promise.resolve(managed);
          if (operation === "status" || operation === "merge-base") return Promise.resolve(clean);
          if (operation === "ls-remote") return Promise.resolve(tags);
          if (operation === "show") return Promise.resolve(manifest);
          if (operation === "rev-parse") return Promise.resolve(head);
          if (operation === "rev-list") return Promise.resolve(targetSha);
        }
        if (spec.command === "npm" && operation === "ci" && firstCi) {
          firstCi = false;
          ciSignal = control?.signal;
          router.dispatch(signal);
          router.dispatch(repeatedSignal);
          return pendingCi;
        }
        return Promise.resolve(clean);
      };
      const runner = { run, calls };
      const update = source(
        makeDeps(runner, {
          interruptions: router,
          applyState: state.store,
        }),
      );
      const rejection = expect(update).rejects.toMatchObject({
        exitCode,
        message: expect.stringContaining(`interrupted by ${signal}`),
      });

      await vi.waitFor(() => expect(ciSignal?.aborted).toBe(true));
      expect(executed(runner)).not.toContain(`git checkout --detach ${previousRef}`);
      finishCi({ code: 1, stdout: "" });
      await rejection;

      expect(
        executed(runner).filter((line) => line === `git checkout --detach ${previousRef}`),
      ).toHaveLength(1);
      expect(executed(runner).slice(-3)).toEqual([
        `git checkout --detach ${previousRef}`,
        "npm ci",
        "npm run build",
      ]);
      expect(state.writes.map((value) => value.phase)).toEqual([
        "applying",
        "rolling-back",
        "complete",
      ]);
      expect(state.writes.at(-1)).toEqual(completedSourceApplyState(rootDir, previousRef));
      router.dispatch("SIGTERM");
      expect(exit).toHaveBeenCalledExactlyOnceWith(143);
    },
  );

  test("a signal during the source health wait rolls the checkout back", async () => {
    const exit = vi.fn();
    const router = new UpdateInterruptionRouter(exit);
    const state = fakeApplyState();
    const runner = fakeRunner([...preflight, clean, clean, clean, ...rollback]);
    const update = source(
      makeDeps(runner, {
        interruptions: router,
        applyState: state.store,
        roles: hostRoles({ gateway: supervised }),
        awaitHealth: vi.fn((expected: string | null) => {
          if (expected === "0.3.0") {
            router.dispatch("SIGINT");
            return Promise.reject(new Error("aborted"));
          }
          return Promise.resolve();
        }),
      }),
    );
    await expect(update).rejects.toMatchObject({
      exitCode: 130,
      message: expect.stringContaining("interrupted by SIGINT"),
    });
    expect(executed(runner).slice(-3)).toEqual([
      `git checkout --detach ${previousRef}`,
      "npm ci",
      "npm run build",
    ]);
    expect(state.writes.map((value) => value.phase)).toEqual([
      "applying",
      "complete",
      "rolling-back",
      "complete",
    ]);
    expect(exit).not.toHaveBeenCalled();
  });

  test("the build runs with the heap the policy sized for this machine, both ways", async () => {
    // A rollback rebuilds too, and the machine has not changed.
    const runner = fakeRunner([...preflight, clean, clean, clean, ...rollback]);
    await expect(
      source(
        makeDeps(runner, {
          buildEnv: () => ({ NODE_OPTIONS: "--max-old-space-size=4096" }),
          roles: hostRoles({ gateway: supervised }),
          awaitHealth: vi.fn((expected: string | null) =>
            expected === "0.3.0" ? Promise.reject(new Error("never came up")) : Promise.resolve(),
          ),
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("Rolled back") });
    const builds = runner.calls.filter(
      (call) => call.spec.command === "npm" && call.spec.args[0] === "run",
    );
    expect(builds.map((call) => call.spec.env)).toEqual([
      { NODE_OPTIONS: "--max-old-space-size=4096" },
      { NODE_OPTIONS: "--max-old-space-size=4096" },
    ]);
    const ci = runner.calls.find(
      (call) => call.spec.command === "npm" && call.spec.args[0] === "ci",
    );
    expect(ci?.spec.env).toBeUndefined();
  });

  test("failure to record applying stops before checkout mutation", async () => {
    const runner = fakeRunner(preflight);
    const applyState: UpdateApplyStateStore = {
      read: () => null,
      write: () => {
        throw new Error("state disk unavailable");
      },
    };

    await expect(source(makeDeps(runner, { applyState }))).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringContaining("before changing the installation"),
    });
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
    ]);
  });

  test("failure to record a completed target rolls the built checkout back", async () => {
    const runner = fakeRunner([...preflight, clean, clean, clean, ...rollback]);
    const writes: UpdateApplyState[] = [];
    const applyState: UpdateApplyStateStore = {
      read: () => null,
      write: (state) => {
        writes.push(state);
        if (
          state.method === "source" &&
          state.phase === "complete" &&
          state.commit === targetSha.stdout.trim()
        ) {
          throw new Error("completion fsync failed");
        }
      },
    };

    await expect(source(makeDeps(runner, { applyState }))).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringContaining("completion could not be recorded"),
    });
    expect(executed(runner).slice(-3)).toEqual([
      `git checkout --detach ${previousRef}`,
      "npm ci",
      "npm run build",
    ]);
    expect(writes.at(-1)).toEqual(completedSourceApplyState(rootDir, previousRef));
  });

  test("a rolling-back state write failure still restores and records the previous build", async () => {
    const runner = fakeRunner([...preflight, clean, clean, { code: 1, stdout: "" }, ...rollback]);
    const writes: UpdateApplyState[] = [];
    const applyState: UpdateApplyStateStore = {
      read: () => null,
      write: (state) => {
        writes.push(state);
        if (state.phase === "rolling-back") throw new Error("transient state failure");
      },
    };

    await expect(source(makeDeps(runner, { applyState }))).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringContaining(`Rolled back to ${previousRef}`),
    });
    expect(writes.at(-1)).toEqual(completedSourceApplyState(rootDir, previousRef));
  });

  test("failure to record the completed rollback remains conservative", async () => {
    const runner = fakeRunner([...preflight, clean, clean, { code: 1, stdout: "" }, ...rollback]);
    const applyState: UpdateApplyStateStore = {
      read: () => null,
      write: (state) => {
        if (
          state.method === "source" &&
          state.phase === "complete" &&
          state.commit === previousRef
        ) {
          throw new Error("rollback marker fsync failed");
        }
      },
    };

    await expect(source(makeDeps(runner, { applyState }))).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringContaining("could not record the completed rollback"),
    });
    expect(executed(runner).slice(-3)).toEqual([
      `git checkout --detach ${previousRef}`,
      "npm ci",
      "npm run build",
    ]);
  });

  test("a failed build returns the checkout to the ref it was on", async () => {
    const runner = fakeRunner([...preflight, clean, clean, { code: 1, stdout: "" }, ...rollback]);
    await expect(source(makeDeps(runner))).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringContaining(previousRef),
    });
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
      "git checkout --detach v0.3.0",
      "npm ci",
      "npm run build",
      `git checkout --detach ${previousRef}`,
      "npm ci",
      "npm run build",
    ]);
  });

  test("a gateway that never comes back is rolled back and restarted on the old build", async () => {
    const runner = fakeRunner([...preflight, clean, clean, clean, ...rollback]);
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    const awaitHealth = vi
      .fn<(expect: string | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValue(undefined);
    await expect(
      source(
        makeDeps(runner, {
          roles: hostRoles({ gateway: supervised }),
          restartService,
          awaitHealth,
        }),
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringContaining("did not come back"),
    });
    expect(executed(runner).slice(-3)).toEqual([
      `git checkout --detach ${previousRef}`,
      "npm ci",
      "npm run build",
    ]);
    // Restarted twice: once onto the new build, once back onto the old one.
    expect(restartService).toHaveBeenCalledTimes(2);
    expect(restartService).toHaveBeenLastCalledWith("gateway");
    // The recovery wait demands the version being restored, so a new build
    // that is somehow still answering cannot be read as a successful rollback.
    expect(awaitHealth).toHaveBeenLastCalledWith("0.2.0");
  });

  test("a gateway that refuses to restart is rolled back too", async () => {
    const runner = fakeRunner([...preflight, clean, clean, clean, ...rollback]);
    const restartService = vi
      .fn<(component: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Job failed"))
      .mockResolvedValue(undefined);
    await expect(
      source(makeDeps(runner, { roles: hostRoles({ gateway: supervised }), restartService })),
    ).rejects.toMatchObject({ message: expect.stringContaining("would not restart") });
    expect(executed(runner).slice(-3)).toEqual([
      `git checkout --detach ${previousRef}`,
      "npm ci",
      "npm run build",
    ]);
  });

  test("the collector is never restarted when the gateway failed", async () => {
    const runner = fakeRunner([...preflight, clean, clean, { code: 1, stdout: "" }, ...rollback]);
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    await expect(
      source(
        makeDeps(runner, {
          roles: hostRoles({ gateway: supervised, collector: supervised }),
          restartService,
        }),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
    expect(restartService).not.toHaveBeenCalledWith("collector");
  });

  // The gateway that failed its health check had already opened the store, so
  // its forward-only migrations may have run and the restored build meets a
  // schema ahead of it. The operator has to be told, and pointed at the
  // backup this same command took minutes earlier.
  test("a rollback after the new build booted names the migrations and the backup", async () => {
    const runner = fakeRunner([...preflight, clean, clean, clean, ...rollback]);
    const awaitHealth = vi
      .fn<(expected: string | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValue(undefined);
    await expect(
      source(makeDeps(runner, { roles: hostRoles({ gateway: supervised }), awaitHealth })),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
    expect(output()).toContain("forward-only migrations");
    expect(output()).toContain("omnesis restore");
  });

  test("a gateway that refuses to restart names them too — it may have migrated and exited", async () => {
    const runner = fakeRunner([...preflight, clean, clean, clean, ...rollback]);
    const restartService = vi
      .fn<(component: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Job failed"))
      .mockResolvedValue(undefined);
    await expect(
      source(makeDeps(runner, { roles: hostRoles({ gateway: supervised }), restartService })),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
    expect(output()).toContain("forward-only migrations");
  });

  // A build that never ran cannot have migrated anything, so the note would
  // only be noise.
  test("a rollback after a failed build says nothing about migrations", async () => {
    const runner = fakeRunner([...preflight, clean, clean, { code: 1, stdout: "" }, ...rollback]);
    await expect(
      source(makeDeps(runner, { roles: hostRoles({ gateway: supervised }) })),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
    expect(output()).not.toContain("forward-only migrations");
  });

  test("a rollback that itself fails says so instead of claiming a clean recovery", async () => {
    const runner = fakeRunner([
      ...preflight,
      clean,
      clean,
      { code: 1, stdout: "" },
      { code: 1, stdout: "" },
    ]);
    await expect(source(makeDeps(runner))).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringContaining("The rollback also failed"),
    });
  });

  test("a package install that fails reinstalls the version that was running", async () => {
    const runner = fakeRunner([
      { code: 0, stdout: "0.3.0\n" },
      { code: 1, stdout: "" },
      { code: 0, stdout: "" },
    ]);
    await expect(
      updateNpmGlobal({ channel: "stable", dryRun: false }, makeDeps(runner)),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
    expect(executed(runner)).toEqual([
      "npm install -g omnesis@0.3.0",
      "npm install -g omnesis@0.2.0",
    ]);
  });
});

// ── Command surface ─────────────────────────────────────────────────────

describe("updateCommand", () => {
  test("binds migration health checks to the local gateway port", () => {
    expect(resolveLocalGatewayHealthUrl("0.0.0.0", 7600)).toBe("https://127.0.0.1:7600");
    expect(resolveLocalGatewayHealthUrl("::", 17600)).toBe("https://[::1]:17600");
    expect(resolveLocalGatewayHealthUrl("192.0.2.10", 17600)).toBe("https://192.0.2.10:17600");
    expect(() => resolveLocalGatewayHealthUrl("localhost:1234", 17600)).toThrow(/Invalid/u);
  });

  test("uses the supported custom config directory for every update subcommand", () => {
    expect(resolveUpdateConfigDir({ OMNESIS_CONFIG_DIR: "/srv/omnesis-config" })).toBe(
      "/srv/omnesis-config",
    );
  });

  test("exposes source-to-package migration as a discoverable subcommand", () => {
    const command = (
      updateCommand.subCommands as Record<string, { args?: Record<string, unknown> }>
    )["migrate-to-package"];
    expect(command).toBeDefined();
    expect(command?.args).toHaveProperty("registry");
    expect(command?.args).toHaveProperty("dry-run");
    expect(command?.args).toHaveProperty("yes");
    expect(command?.args).toHaveProperty("keep-checkout");
    expect(command?.args).toHaveProperty("health-timeout");
  });

  test("exposes source-checkout adoption as a discoverable subcommand", () => {
    const command = (
      updateCommand.subCommands as Record<string, { args?: Record<string, unknown> }>
    )["adopt-source"];
    expect(command).toBeDefined();
    expect(command?.args ?? {}).toEqual({});
  });

  test("exposes the channel and registry a package install needs", () => {
    const args = updateCommand.args as Record<
      string,
      { type: string; default?: unknown; description?: string }
    >;
    expect(args.channel).toMatchObject({ type: "string", default: "stable" });
    expect(args.registry).toMatchObject({ type: "string" });
    expect(args.commit).toMatchObject({ type: "string" });
  });

  test("keeps the installed build's continuation out of the help", () => {
    const command = (updateCommand.subCommands as Record<string, { meta?: { hidden?: boolean } }>)[
      CONTINUATION_SUBCOMMAND
    ];
    expect(command?.meta?.hidden).toBe(true);
  });

  test.each(["adopt-source", "migrate-to-package", CONTINUATION_SUBCOMMAND])(
    "runs only the %s subcommand",
    async (name) => {
      const child = vi.fn();
      const command = defineCommand({
        ...updateCommand,
        subCommands: {
          [name]: defineCommand({
            meta: { name },
            args: { registry: { type: "string" } },
            run: child,
          }),
        },
      });
      await runCommand(command, {
        rawArgs:
          name === "migrate-to-package" ? [name, "--registry", "http://example.org"] : [name],
      });
      expect(child).toHaveBeenCalledOnce();
    },
  );

  // `run` owns only the dispatch; the flows themselves are covered above. It
  // reads the real process.argv[1], so these drive it through the two paths
  // that never reach a flow: an unrecognized install and a rejected flag.
  const invoke = (args: Record<string, unknown>) =>
    (updateCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<void>)({
      args: { "dry-run": false, yes: true, force: false, edge: false, channel: "stable", ...args },
    });

  test("a rejected flag combination fails without running anything", async () => {
    await expect(invoke({ channel: "nightly" })).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
      message: expect.stringMatching(/Unknown --channel: nightly/u),
    });
  });

  test("an exact commit must be full lowercase hex and cannot be mixed with a release selector", async () => {
    await expect(invoke({ commit: "abc" })).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
      message: expect.stringMatching(/full 40-character lowercase commit id/u),
    });
    await expect(
      invoke({ commit: "a".repeat(40), "target-version": "0.5.0" }),
    ).rejects.toMatchObject({
      exitCode: EXIT_USER_ERROR,
      message: expect.stringMatching(/cannot be combined/u),
    });
  });

  test("an unrecognized install prints the manual instructions", async () => {
    // The suite runs from the monorepo, so detection lands on "source" — force
    // the unknown branch by pointing argv[1] at a path that is neither layout.
    const argv1 = process.argv[1];
    process.argv[1] = "/nonexistent/omnesis-cli-shim";
    try {
      await expect(invoke({})).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
      expect(output()).toContain("curl -fsSL https://omnesis.dev/install.sh | sh");
    } finally {
      process.argv[1] = argv1;
    }
  });
});

describe("runWithUpdateLock", () => {
  test("holds one lock for the whole transaction and releases it afterward", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-cli-update-lock-"));
    try {
      await runWithUpdateLock(configDir, false, async (lock) => {
        expect(lock).toBeDefined();
        lock?.setStep("applying package");
        expect(() => acquireUpdateLock(configDir, { owner: "second" })).toThrow(
          /currently applying package/,
        );
      });
      const next = acquireUpdateLock(configDir, { owner: "next" });
      next.release();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("releases after a failed transaction", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-cli-update-lock-"));
    try {
      await expect(
        runWithUpdateLock(configDir, false, async () => {
          throw new Error("apply failed");
        }),
      ).rejects.toThrow("apply failed");
      const next = acquireUpdateLock(configDir, { owner: "next" });
      next.release();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("does not take a lock for a dry run", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-cli-update-lock-"));
    const held = acquireUpdateLock(configDir, { owner: "real update" });
    try {
      await expect(
        runWithUpdateLock(configDir, true, async (lock) => lock),
      ).resolves.toBeUndefined();
      expect(() => acquireUpdateLock(configDir, { owner: "second" })).toThrow(UpdateLockBusyError);
    } finally {
      held.release();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("returns ownership to the collector after the child transaction", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-cli-update-lock-"));
    const parent = acquireUpdateLock(configDir, { owner: "collector self-update" });
    try {
      await runWithUpdateLock(configDir, false, async (lock) => lock?.setStep("building"), {
        OMNESIS_UPDATE_LOCK_ID: parent.id,
      });
      expect(() => acquireUpdateLock(configDir, { owner: "operator" })).toThrow(
        /finishing collector self-update/,
      );
      parent.release();
      const next = acquireUpdateLock(configDir, { owner: "operator" });
      next.release();
    } finally {
      parent.release();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
  test("a continuation hands the lock back to the updater that offered it", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-cli-update-lock-"));
    // The offering updater was itself handed the lock by a collector, which is
    // where an ordinary hand-back would skip to.
    const collector = acquireUpdateLock(configDir, { owner: "collector self-update" });
    const offering = adoptUpdateLock(configDir, collector.id, { owner: "Omnesis update" });
    try {
      await runWithUpdateLock(
        configDir,
        false,
        (lock) => {
          lock?.setStep("restarting the gateway");
          // Held by the continuation alone: the offering process cannot act.
          expect(() => offering.setStep("anything")).toThrow(/lost ownership/);
          expect(() => acquireUpdateLock(configDir, { owner: "second" })).toThrow(
            /installed build.*restarting the gateway/,
          );
          return Promise.resolve();
        },
        { OMNESIS_UPDATE_LOCK_ID: offering.id },
        { continuation: true },
      );
      // Back with the offering process, which still has work, and never free
      // in between.
      offering.setStep("fanning out");
      expect(() => acquireUpdateLock(configDir, { owner: "second" })).toThrow(/fanning out/);
      // Its own hand-back still reaches the collector.
      offering.handBack();
      expect(() => acquireUpdateLock(configDir, { owner: "second" })).toThrow(
        /finishing collector self-update/,
      );
      collector.release();
      acquireUpdateLock(configDir, { owner: "next" }).release();
    } finally {
      offering.release();
      collector.release();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("a continuation without a handed-over lock is refused rather than taking a new one", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-cli-update-lock-"));
    try {
      const action = vi.fn();
      await expect(
        runWithUpdateLock(configDir, false, action, {}, { continuation: true }),
      ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
      expect(action).not.toHaveBeenCalled();
      expect(existsSync(join(configDir, "update.lock"))).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// ── The fleet flag ──────────────────────────────────────────────────────

describe("the --fleet flag's own refusals", () => {
  test("a target version that is not a release is refused by every entry point", async () => {
    // The command validates it, and so does each exported flow: the string
    // becomes a git ref and an npm install spec, and a caller that forgot the
    // check must not get either for free.
    const runner = fakeRunner([]);
    await expect(
      updateNpmGlobal(
        { channel: "stable", dryRun: false, targetVersion: "main" },
        makeDeps(runner),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    await expect(
      updateSourceCheckout(
        { rootDir: "/home/dev/omnesis", edge: false, dryRun: false, targetVersion: "--registry=x" },
        makeDeps(runner),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    // Nothing was run in either case.
    expect(runner.calls).toEqual([]);
  });
});

describe("a run that restarts nothing", () => {
  const rootDir = "/home/dev/omnesis";
  const managed = { code: 0, stdout: "managed\n" };
  const clean = { code: 0, stdout: "" };
  const tags = { code: 0, stdout: "abc\trefs/tags/v0.3.0\n" };
  const manifest = { code: 0, stdout: '{"version":"0.3.0"}\n' };
  const head = { code: 0, stdout: "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3\n" };
  const targetSha = { code: 0, stdout: "1122334455667788990011223344556677889900\n" };

  test("a failed build reports the gateway rather than reviving it", async () => {
    // On a commanded device this command is a child of the very daemon it
    // would restart, so reviving from inside the rollback would kill the
    // rollback. The same one flag drives both the plan and this.
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      targetSha,
      clean,
      clean,
      clean,
      { code: 1, stdout: "" },
      clean,
      clean,
      clean,
    ]);
    const restartService = vi.fn(() => Promise.resolve());
    await expect(
      updateSourceCheckout(
        { rootDir, edge: false, dryRun: false },
        makeDeps(runner, {
          restart: false,
          roles: hostRoles({ gateway: supervised }),
          restartService,
        }),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
    expect(restartService).not.toHaveBeenCalled();
    expect(output()).toContain("was not restarted by this run");
    expect(output()).toContain("omnesis service restart gateway");
  });
});

// ── service definitions ─────────────────────────────────────────────────

describe("applying the release's service definitions", () => {
  const rootDir = "/home/dev/omnesis";
  const managed = { code: 0, stdout: "managed\n" };
  const clean = { code: 0, stdout: "" };
  const tags = { code: 0, stdout: "abc\trefs/tags/v0.3.0\n" };
  const manifest = { code: 0, stdout: '{"version":"0.3.0"}\n' };
  const head = { code: 0, stdout: `${PREVIOUS}\n` };
  const targetSha = { code: 0, stdout: `${TARGET}\n` };
  const successfulUpdate = [
    managed,
    clean,
    tags,
    clean,
    manifest,
    head,
    targetSha,
    clean,
    clean,
    clean,
    clean,
  ];
  const both = hostRoles({ gateway: supervised, collector: supervised });
  const source = (deps: UpdateFlowDeps) =>
    updateSourceCheckout({ rootDir, edge: false, dryRun: false }, deps);

  function fakeDefinitions(
    outcomes: Partial<Record<ServiceComponent, ServiceDefinitionOutcome | Error>> = {},
    loads = true,
  ) {
    return {
      refresh: vi.fn((component: ServiceComponent) => {
        const outcome = outcomes[component] ?? { kind: "unchanged" };
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      }),
      loadDefinition: vi.fn((_component: ServiceComponent) => Promise.resolve(loads)),
      reload: vi.fn((_component: ServiceComponent) => Promise.resolve()),
      restore: vi.fn(() => Promise.resolve([] as ServiceComponent[])),
    } satisfies ServiceDefinitionUpdater;
  }

  test("the plan names the step ahead of each restart", async () => {
    const runner = fakeRunner([managed, clean, tags, clean, manifest, clean]);
    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: true },
      makeDeps(runner, { roles: both, serviceDefinitions: fakeDefinitions() }),
    );
    const plan = logged.slice(logged.indexOf("This host will:") + 1, -3);
    expect(plan).toEqual([
      "  - back up the gateway's databases through its API",
      "  - move this installation to v0.3.0",
      "  - rewrite the gateway's service definition where v0.3.0 changes it",
      "  - restart the gateway",
      "  - wait for the gateway to serve again (schema migrations run at boot)",
      "  - rewrite the collector's service definition where v0.3.0 changes it",
      "  - restart the collector",
    ]);
  });

  test("a rewritten unit is loaded by its restart; an unchanged one restarts as before", async () => {
    const definitions = fakeDefinitions({ gateway: { kind: "replaced" } });
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    await source(
      makeDeps(fakeRunner(successfulUpdate), {
        roles: both,
        serviceDefinitions: definitions,
        restartService,
      }),
    );
    expect(definitions.refresh.mock.calls).toEqual([["gateway"], ["collector"]]);
    expect(definitions.reload.mock.calls).toEqual([["gateway"]]);
    expect(definitions.refresh.mock.invocationCallOrder[0]).toBeLessThan(
      definitions.reload.mock.invocationCallOrder[0]!,
    );
    expect(restartService.mock.calls).toEqual([["collector"]]);
    expect(definitions.loadDefinition).not.toHaveBeenCalled();
    expect(output()).toContain("Rewrote the gateway's service definition for v0.3.0.");
  });

  test("a unit it cannot rewrite is named with the install command, and the update goes on", async () => {
    const definitions = fakeDefinitions({
      gateway: { kind: "refused", reason: "drop-ins change it (override.conf)" },
      collector: new Error("EACCES: permission denied"),
    });
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    await source(
      makeDeps(fakeRunner(successfulUpdate), {
        roles: both,
        serviceDefinitions: definitions,
        restartService,
      }),
    );
    expect(restartService.mock.calls).toEqual([["gateway"], ["collector"]]);
    expect(definitions.reload).not.toHaveBeenCalled();
    expect(output()).toContain(
      "The gateway's service definition was left as it is: drop-ins change it (override.conf).",
    );
    expect(output()).toContain("omnesis service install gateway");
    expect(output()).toContain(
      "The collector's service definition was left as it is: EACCES: permission denied.",
    );
  });

  test("a rollback puts the rewritten unit back and revives the previous build under it", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-update-definitions-"));
    try {
      const path = systemdUnitPath(home, "gateway");
      const current = generateSystemdUnit(
        buildServiceSpec({
          component: "gateway",
          configDir: join(home, ".config", "omnesis"),
          exec: ["/usr/local/bin/omnesis", "gateway", "serve"],
          extraEnv: {},
          platform: "linux",
          homeDir: home,
          nodeBinDir: "/usr/bin",
        }),
      );
      const previous = current.replace(" AF_NETLINK", "");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, previous, { mode: 0o600 });
      // What the unit said each time the service manager was asked to load it.
      const loaded: string[] = [];
      const supervisor = {
        platform: "linux",
        unitPath: (component: ServiceComponent) => systemdUnitPath(home, component),
        isInstalled: (component: ServiceComponent) => component === "gateway",
        inspectDefinition: () =>
          Promise.resolve({
            fragmentPath: path,
            overridePaths: [],
            inheritedEnvironment: [],
            inheritedEnvironmentText: "",
          }),
        reload: () => {
          loaded.push(readFileSync(path, "utf8"));
          return Promise.resolve();
        },
      } as unknown as Supervisor;
      const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
      const awaitHealth = vi
        .fn(() => Promise.resolve())
        .mockImplementationOnce(() => Promise.reject(new Error("timed out")));

      await expect(
        source(
          makeDeps(fakeRunner([...successfulUpdate, clean, clean, clean]), {
            roles: hostRoles({ gateway: supervised }),
            restartService,
            awaitHealth,
            serviceDefinitions: serviceDefinitionUpdater({
              supervisor,
              homeDir: home,
              nodeBinDir: "/usr/bin",
              coversLocalhost: () => true,
            }),
          }),
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });

      expect(loaded).toEqual([current, previous]);
      expect(readFileSync(path, "utf8")).toBe(previous);
      expect(restartService).not.toHaveBeenCalled();
      expect(output()).toContain("Put back the gateway's previous service definition.");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  describe("on a run that restarts nothing", () => {
    test("systemd reads the rewritten unit, and nothing is restarted", async () => {
      const definitions = fakeDefinitions({ collector: { kind: "replaced" } }, true);
      const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
      await source(
        makeDeps(fakeRunner(successfulUpdate), {
          restart: false,
          roles: hostRoles({ collector: supervised }),
          serviceDefinitions: definitions,
          restartService,
        }),
      );
      expect(definitions.loadDefinition.mock.calls).toEqual([["collector"]]);
      expect(definitions.reload).not.toHaveBeenCalled();
      expect(restartService).not.toHaveBeenCalled();
      expect(output()).toContain("the collector runs under it from its next restart");
    });

    test("launchd gets the plist on disk, and the operator is told when it loads", async () => {
      const definitions = fakeDefinitions({ collector: { kind: "replaced" } }, false);
      const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
      await source(
        makeDeps(fakeRunner(successfulUpdate), {
          restart: false,
          roles: hostRoles({ collector: supervised }),
          serviceDefinitions: definitions,
          restartService,
        }),
      );
      expect(definitions.reload).not.toHaveBeenCalled();
      expect(restartService).not.toHaveBeenCalled();
      expect(output()).toContain("launchd loads it at the next login");
    });
  });
});

// ── A stopped gateway, a concurrent update, and daemons already on the build ──

describe("a gateway that is not running", () => {
  const rootDir = "/home/dev/omnesis";
  const managed = { code: 0, stdout: "managed\n" };
  const clean = { code: 0, stdout: "" };
  const tags = { code: 0, stdout: "abc\trefs/tags/v0.3.0\n" };
  const manifest = { code: 0, stdout: '{"version":"0.3.0"}\n' };
  const head = { code: 0, stdout: "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3\n" };
  const targetSha = { code: 0, stdout: "1122334455667788990011223344556677889900\n" };
  const successfulUpdate = [
    managed,
    clean,
    tags,
    clean,
    manifest,
    head,
    targetSha,
    clean,
    clean,
    clean,
    clean,
  ];
  const stopped = { present: true, supervised: false, manualRestart: null, stopped: true };
  const backupPath = "/home/dev/.config/omnesis/backups/2026-03-14T09-12-05";
  const source = (deps: UpdateFlowDeps) =>
    updateSourceCheckout({ rootDir, edge: false, dryRun: false }, deps);

  test("its closed databases are copied, and its collector restarts as on any host", async () => {
    const runner = fakeRunner(successfulUpdate);
    const backup = vi.fn(() => Promise.resolve());
    const offlineBackup = vi.fn(() =>
      Promise.resolve({ kind: "copied" as const, path: backupPath }),
    );
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    await source(
      makeDeps(runner, {
        roles: hostRoles({ gateway: stopped, collector: supervised }),
        backup,
        offlineBackup,
        restartService,
      }),
    );
    expect(offlineBackup).toHaveBeenCalledWith(expect.stringContaining("v0.3.0"), "pre-update");
    expect(backup).not.toHaveBeenCalled();
    expect(restartService).toHaveBeenCalledExactlyOnceWith("collector");
    expect(output()).toContain(`its databases were copied into ${backupPath}`);
    expect(output()).toContain(
      "The gateway on this host is not running, so nothing serves the previous build",
    );
    expect(output()).not.toContain("still runs the previous build");
  });

  test("the plan says the backup is a copy and the gateway migrates when it next starts", async () => {
    const runner = fakeRunner([managed, clean, tags, clean, manifest, clean]);
    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: true },
      makeDeps(runner, { roles: hostRoles({ gateway: stopped, collector: supervised }) }),
    );
    const plan = logged.slice(logged.indexOf("This host will:") + 1, -3);
    expect(plan).toEqual([
      "  - back up the gateway's databases by copying them, since it is not running",
      "  - move this installation to v0.3.0",
      "  - note that the stopped gateway migrates its databases when it next starts",
      "  - restart the collector",
    ]);
  });

  test("a gateway started since the plan was made takes the backup through its API", async () => {
    const runner = fakeRunner(successfulUpdate);
    const backup = vi.fn(() => Promise.resolve());
    const offlineBackup = vi.fn(() => Promise.resolve({ kind: "gateway-running" as const }));
    await source(
      makeDeps(runner, { roles: hostRoles({ gateway: stopped }), backup, offlineBackup }),
    );
    expect(offlineBackup).toHaveBeenCalledOnce();
    expect(backup).toHaveBeenCalledOnce();
  });

  test("a copy that fails stops the update before anything irreversible", async () => {
    const runner = fakeRunner([managed, clean, tags, clean, manifest, head, targetSha, clean]);
    const offlineBackup = vi.fn(() =>
      Promise.reject(new Error("Not enough free disk space for a backup: need ~2.0 GB")),
    );
    await expect(
      source(makeDeps(runner, { roles: hostRoles({ gateway: stopped }), offlineBackup })),
    ).rejects.toMatchObject({
      exitCode: EXIT_FAILURE,
      message: expect.stringMatching(
        /Could not copy the stopped gateway's databases into a backup before updating: Not enough free disk space[\s\S]*--no-backup/,
      ),
    });
    expect(executed(runner)).toEqual([
      "git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0",
    ]);
  });

  test("a gateway that never created its databases has nothing to copy", async () => {
    const runner = fakeRunner(successfulUpdate);
    const offlineBackup = vi.fn(() => Promise.resolve({ kind: "nothing-to-copy" as const }));
    await source(makeDeps(runner, { roles: hostRoles({ gateway: stopped }), offlineBackup }));
    expect(output()).toContain("nothing to back up");
    expect(executed(runner)).toContain("npm run build");
  });
});

describe("a daemon on a host already on the target", () => {
  const rootDir = "/home/dev/omnesis";
  const managed = { code: 0, stdout: "managed\n" };
  const clean = { code: 0, stdout: "" };
  const tags = { code: 0, stdout: "abc\trefs/tags/v0.3.0\n" };
  const manifest = { code: 0, stdout: '{"version":"0.3.0"}\n' };
  const head = { code: 0, stdout: "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3\n" };
  const completed = serializeUpdateApplyState(
    completedSourceApplyState(rootDir, head.stdout.trim()),
  );
  const alreadyOnTarget = (runsInstalledBuild: UpdateFlowDeps["runsInstalledBuild"]) =>
    updateSourceCheckout(
      { rootDir, edge: false, dryRun: false },
      makeDeps(fakeRunner([managed, clean, tags, clean, manifest, head, head, clean]), {
        applyState: { read: () => completed, write: vi.fn() },
        restart: false,
        roles: hostRoles({ collector: supervised }),
        ...(runsInstalledBuild ? { runsInstalledBuild } : {}),
      }),
    );

  test("is not reported when it started after the build was installed", async () => {
    const runsInstalledBuild = vi.fn(() => Promise.resolve(true));
    await alreadyOnTarget(runsInstalledBuild);
    expect(runsInstalledBuild).toHaveBeenCalledWith("collector");
    expect(output()).toContain("Already on v0.3.0.");
    expect(output()).not.toMatch(/collector/u);
  });

  test("is said to maybe run the previous build when that cannot be told", async () => {
    await alreadyOnTarget(vi.fn(() => Promise.resolve(null)));
    expect(output()).toContain("report that the collector may need restarting by hand");
    expect(output()).toContain("The collector on this host may still run the previous build.");
  });

  test("is reported when it started before the build was installed", async () => {
    await alreadyOnTarget(vi.fn(() => Promise.resolve(false)));
    expect(output()).toContain("The collector on this host still runs the previous build.");
  });

  test("a run that applies something never asks: every daemon predates it", async () => {
    const runsInstalledBuild = vi.fn(() => Promise.resolve(true));
    const runner = fakeRunner([
      managed,
      clean,
      tags,
      clean,
      manifest,
      head,
      { code: 0, stdout: "1122334455667788990011223344556677889900\n" },
      clean,
      clean,
      clean,
      clean,
    ]);
    await updateSourceCheckout(
      { rootDir, edge: false, dryRun: false },
      makeDeps(runner, {
        restart: false,
        roles: hostRoles({ collector: supervised }),
        runsInstalledBuild,
      }),
    );
    expect(runsInstalledBuild).not.toHaveBeenCalled();
    expect(output()).toContain("The collector on this host still runs the previous build.");
  });
});

describe("a package install another update already moved to the target", () => {
  test("still refreshes the harness plugin, installing and backing up nothing", async () => {
    const runner = fakeRunner([
      { code: 0, stdout: "0.2.0\n" },
      { code: 0, stdout: "" },
    ]);
    const backup = vi.fn(() => Promise.resolve());
    await updateNpmGlobal(
      { channel: "stable", dryRun: false, afterConcurrentUpdate: true },
      makeDeps(runner, {
        restart: false,
        backup,
        roles: hostRoles({
          gateway: supervised,
          harnesses: [
            { harness: "openclaw", home: "/home/dev/.openclaw", needsAuthorization: false },
          ],
        }),
        runsInstalledBuild: vi.fn(() => Promise.resolve(true)),
      }),
    );
    expect(output()).toContain("Another update on this host already installed 0.2.0");
    expect(output()).toContain("Refreshed the openclaw plugin");
    expect(executed(runner).join("\n")).not.toContain("npm install");
    expect(backup).not.toHaveBeenCalled();
    expect(output()).not.toContain("still runs the previous build");
  });
});

describe("waiting for another update on this host", () => {
  test("waits for the holder, saying who it waits for, then runs the transaction", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-cli-update-lock-"));
    const holder = acquireUpdateLock(configDir, {
      owner: "collector self-update",
      currentStep: "building",
    });
    try {
      const seen = await runWithUpdateLock(
        configDir,
        false,
        (lock, context) =>
          Promise.resolve({ held: lock !== undefined, waitedMs: context.waitedMs }),
        {},
        {
          waitForLockMs: 60_000,
          sleep: () => {
            holder.release();
            return Promise.resolve();
          },
        },
      );
      expect(seen).toEqual({ held: true, waitedMs: expect.any(Number) });
      expect(seen.waitedMs).toBeGreaterThan(0);
      expect(output()).toMatch(/^Waiting for collector self-update \(PID \d+\) to finish…$/mu);
      const next = acquireUpdateLock(configDir, { owner: "next" });
      next.release();
    } finally {
      holder.release();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("a free lock is taken without a wait", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-cli-update-lock-"));
    try {
      const waitedMs = await runWithUpdateLock(
        configDir,
        false,
        (_lock, context) => Promise.resolve(context.waitedMs),
        {},
        { waitForLockMs: 60_000 },
      );
      expect(waitedMs).toBe(0);
      expect(output()).not.toContain("Waiting for");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("gives up after the wait, naming the update still running", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-cli-update-lock-"));
    const holder = acquireUpdateLock(configDir, {
      owner: "collector self-update",
      currentStep: "building",
    });
    try {
      await expect(
        runWithUpdateLock(configDir, false, () => Promise.resolve(), {}, { waitForLockMs: 1 }),
      ).rejects.toMatchObject({
        exitCode: EXIT_USER_ERROR,
        message: expect.stringMatching(
          /collector self-update \(PID \d+\), started .*, currently building, was still running on this host after waiting/u,
        ),
      });
    } finally {
      holder.release();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("parseWaitForLockMinutes", () => {
  test("whole minutes up to a day", () => {
    expect(parseWaitForLockMinutes("30")).toBe(30);
    expect(parseWaitForLockMinutes(" 5 ")).toBe(5);
    expect(parseWaitForLockMinutes("1440")).toBe(1440);
  });

  test("absent when the flag is not given", () => {
    expect(parseWaitForLockMinutes(undefined)).toBeUndefined();
  });

  test("anything else is refused, including a flag the parser took as the value", () => {
    for (const raw of ["", "0", "-1", "1.5", "10m", "--yes", "1441"]) {
      expect(parseWaitForLockMinutes(raw)).toBeNull();
    }
  });
});

// ── Handing the rest of an update to the installed build ────────────────

describe("handing the rest of an update to the build it installed", () => {
  const taken: ContinuationOutcome = { accepted: true, code: 0, signal: null };

  describe("from a package install", () => {
    const view = (version: string) => ({ code: 0, stdout: `${version}\n` });
    const ok = { code: 0, stdout: "" };

    /** Every effect in the order it happened. */
    function recorded(outcomes: RunOutcome[], overrides: Partial<UpdateFlowDeps> = {}) {
      const events: string[] = [];
      const runner = fakeRunner(outcomes);
      const run: CommandRunner = (spec, mode, control) => {
        if (mode === "inherit") events.push([spec.command, ...spec.args].join(" "));
        return runner.run(spec, mode, control);
      };
      const deps = makeDeps(
        { run, calls: runner.calls },
        {
          roles: hostRoles({ gateway: supervised, collector: supervised }),
          backup: vi.fn(() => {
            events.push("backup");
            return Promise.resolve();
          }),
          restartService: vi.fn((component: ServiceComponent) => {
            events.push(`restart ${component}`);
            return Promise.resolve();
          }),
          awaitHealth: vi.fn((expected: string | null) => {
            events.push(`awaitHealth ${expected}`);
            return Promise.resolve();
          }),
          ...overrides,
        },
      );
      return { events, deps, runner };
    }

    test("a release that knows how finishes the update with its own updater", async () => {
      const continueAfterApply = vi.fn((_offer: ContinuationOffer) => Promise.resolve(taken));
      const { events, deps } = recorded([view("0.5.0"), ok], { continueAfterApply });
      continueAfterApply.mockImplementation(() => {
        events.push("hand over");
        return Promise.resolve(taken);
      });

      await expect(updateNpmGlobal({ channel: "stable", dryRun: false }, deps)).resolves.toBe(
        "0.5.0",
      );

      // The gateway runs from the package being replaced, so its API backup —
      // which loads a worker from that package — is taken before the install.
      expect(events).toEqual(["backup", "npm install -g omnesis@0.5.0", "hand over"]);
      expect(continueAfterApply).toHaveBeenCalledWith(
        {
          subject: { method: "npm-global", target: "0.5.0", previous: "0.2.0" },
          targetVersion: "0.5.0",
          previousVersion: "0.2.0",
          deferredBackup: null,
          restart: true,
        },
        expect.anything(),
      );
    });

    test("--no-restart and a registry travel with the offer", async () => {
      const continueAfterApply = vi.fn((_offer: ContinuationOffer) => Promise.resolve(taken));
      const { deps } = recorded([view("0.5.0"), ok], { continueAfterApply, restart: false });
      await updateNpmGlobal(
        { channel: "stable", dryRun: false, registry: "https://packages.example.org" },
        deps,
      );
      expect(continueAfterApply.mock.calls[0]![0]).toMatchObject({
        subject: { registry: "https://packages.example.org" },
        restart: false,
      });
    });

    test("a release older than the hand-over is finished here", async () => {
      const continueAfterApply = vi.fn(() => Promise.resolve(taken));
      const { events, deps } = recorded([view("0.4.10"), ok], { continueAfterApply });
      await updateNpmGlobal({ channel: "stable", dryRun: false }, deps);
      expect(continueAfterApply).not.toHaveBeenCalled();
      expect(events).toEqual([
        "backup",
        "npm install -g omnesis@0.4.10",
        "restart gateway",
        "awaitHealth 0.4.10",
        "restart collector",
      ]);
    });

    test("a build that does not take the offer leaves this process to finish", async () => {
      const continueAfterApply = vi.fn(() =>
        Promise.resolve({ accepted: false, code: 1, signal: null, detail: "it exited 1" }),
      );
      const { events, deps } = recorded([view("0.5.0"), ok], { continueAfterApply });
      await updateNpmGlobal({ channel: "stable", dryRun: false }, deps);
      expect(events).toEqual([
        "backup",
        "npm install -g omnesis@0.5.0",
        "restart gateway",
        "awaitHealth 0.5.0",
        "restart collector",
      ]);
    });

    test("a launch that throws is an offer not taken, never a failed update", async () => {
      const continueAfterApply = vi.fn(() => Promise.reject(new Error("spawn EACCES")));
      const { events, deps } = recorded([view("0.5.0"), ok], { continueAfterApply });
      await updateNpmGlobal({ channel: "stable", dryRun: false }, deps);
      expect(events.at(-1)).toBe("restart collector");
      expect(output()).toContain("(spawn EACCES)");
    });

    test("a failure the installed build reports ends the run with its status and undoes nothing here", async () => {
      const continueAfterApply = vi.fn(() =>
        Promise.resolve({ accepted: true, code: EXIT_FAILURE, signal: null }),
      );
      const { events, deps } = recorded([view("0.5.0"), ok], { continueAfterApply });
      await expect(
        updateNpmGlobal({ channel: "stable", dryRun: false }, deps),
      ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
      // Its rollback was its own; this process runs neither a second one nor
      // any restart.
      expect(events).toEqual(["backup", "npm install -g omnesis@0.5.0"]);
    });

    test("an installed build stopped by a signal says the host may be partly updated", async () => {
      const continueAfterApply = vi.fn(() =>
        Promise.resolve({ accepted: true, code: 137, signal: "SIGKILL" as const }),
      );
      const { deps } = recorded([view("0.5.0"), ok], { continueAfterApply });
      await expect(
        updateNpmGlobal({ channel: "stable", dryRun: false }, deps),
      ).rejects.toMatchObject({ exitCode: 137 });
      expect(output()).toContain("stopped (SIGKILL) before it could be known to have finished");
    });

    test("a signal during the hand-over reaches the build, and one it never took rolls back here", async () => {
      const interruptions = new UpdateInterruptionRouter((code) => {
        throw new Error(`Unexpected update signal exit ${code}`);
      });
      const deliver = vi.fn();
      const continueAfterApply = vi.fn((_offer: ContinuationOffer, relay: SignalRelay) => {
        relay.deliver = deliver;
        interruptions.dispatch("SIGINT");
        return Promise.resolve({ accepted: false, code: 130, signal: null });
      });
      const { events, deps } = recorded([view("0.5.0"), ok, ok], {
        continueAfterApply,
        interruptions,
      });
      await expect(
        updateNpmGlobal({ channel: "stable", dryRun: false }, deps),
      ).rejects.toMatchObject({ exitCode: 130 });
      expect(deliver).toHaveBeenCalledWith("SIGINT");
      expect(events).toEqual([
        "backup",
        "npm install -g omnesis@0.5.0",
        "npm install -g omnesis@0.2.0",
        "restart gateway",
        "awaitHealth 0.2.0",
      ]);
    });
  });

  describe("from a source checkout with a stopped gateway", () => {
    const rootDir = "/home/dev/omnesis";
    const managed = { code: 0, stdout: "managed\n" };
    const clean = { code: 0, stdout: "" };
    const tags = { code: 0, stdout: "abc\trefs/tags/v0.5.0\n" };
    const manifest = { code: 0, stdout: '{"version":"0.5.0"}\n' };
    const head = { code: 0, stdout: `${PREVIOUS}\n` };
    const targetSha = { code: 0, stdout: `${TARGET}\n` };
    const successfulUpdate = [managed, clean, tags, clean, manifest, head, targetSha, clean];
    const stopped = { present: true, supervised: false, manualRestart: null, stopped: true };

    function sourceDeps(
      events: string[],
      outcomes: RunOutcome[],
      overrides: Partial<UpdateFlowDeps>,
    ) {
      const runner = fakeRunner(outcomes);
      const run: CommandRunner = (spec, mode, control) => {
        if (mode === "inherit") events.push([spec.command, ...spec.args].join(" "));
        return runner.run(spec, mode, control);
      };
      return makeDeps(
        { run, calls: runner.calls },
        {
          roles: hostRoles({ gateway: stopped, collector: supervised }),
          offlineBackup: vi.fn(() => {
            events.push("copy");
            return Promise.resolve({ kind: "copied" as const, path: "/tmp/backup" });
          }),
          restartService: vi.fn((component: ServiceComponent) => {
            events.push(`restart ${component}`);
            return Promise.resolve();
          }),
          ...overrides,
        },
      );
    }

    test("the copy of its closed stores is the installed build's, taken before any restart", async () => {
      const events: string[] = [];
      const continueAfterApply = vi.fn((_offer: ContinuationOffer) => {
        events.push("hand over");
        return Promise.resolve(taken);
      });
      await updateSourceCheckout(
        { rootDir, edge: false, dryRun: false },
        sourceDeps(events, [...successfulUpdate, clean, clean, clean], { continueAfterApply }),
      );
      expect(events).toEqual([
        "git fetch --no-tags origin refs/tags/v0.5.0:refs/tags/v0.5.0",
        "git checkout --detach v0.5.0",
        "npm ci",
        "npm run build",
        "hand over",
      ]);
      expect(continueAfterApply.mock.calls[0]![0]).toEqual({
        subject: {
          method: "source",
          rootDir,
          edge: false,
          target: "v0.5.0",
          targetCommit: TARGET,
          previous: PREVIOUS,
        },
        targetVersion: "0.5.0",
        previousVersion: "0.2.0",
        deferredBackup: "offline",
        restart: true,
      });
      const plan = logged.slice(
        logged.indexOf("This host will:") + 1,
        logged.indexOf("This host will:") + 3,
      );
      expect(plan).toEqual([
        "  - move this installation to v0.5.0",
        "  - back up the gateway's databases by copying them, since it is not running",
      ]);
    });

    test("finished here, the copy still comes after the build and before the collector", async () => {
      const events: string[] = [];
      const continueAfterApply = vi.fn(() =>
        Promise.resolve({ accepted: false, code: 1, signal: null }),
      );
      await updateSourceCheckout(
        { rootDir, edge: false, dryRun: false },
        sourceDeps(events, [...successfulUpdate, clean, clean, clean], { continueAfterApply }),
      );
      expect(events.slice(3)).toEqual(["npm run build", "copy", "restart collector"]);
    });

    test("an edge build is handed over when its manifest declares a release that knows how", async () => {
      const events: string[] = [];
      const continueAfterApply = vi.fn((_offer: ContinuationOffer) => Promise.resolve(taken));
      await updateSourceCheckout(
        { rootDir, edge: true, dryRun: false },
        sourceDeps(
          events,
          // managed, status, fetch, the edge manifest, HEAD, target sha, ancestry, apply.
          [managed, clean, clean, manifest, head, targetSha, clean, clean, clean, clean],
          { continueAfterApply },
        ),
      );
      expect(continueAfterApply.mock.calls[0]![0]).toMatchObject({
        subject: { edge: true, target: "origin/main" },
        targetVersion: "0.5.0",
      });
    });
  });

  describe("in the installed build", () => {
    const rootDir = "/home/dev/omnesis";
    const sourceOffer = (over: Partial<ContinuationOffer> = {}): ContinuationOffer => ({
      subject: {
        method: "source",
        rootDir,
        edge: false,
        target: "v0.5.0",
        targetCommit: TARGET,
        previous: PREVIOUS,
      },
      targetVersion: "0.5.0",
      previousVersion: "0.4.10",
      deferredBackup: null,
      restart: true,
      ...over,
    });

    test("runs no apply and writes no apply record: it restarts, waits, and restarts again", async () => {
      const events: string[] = [];
      const runner = fakeRunner([]);
      const applyState = fakeApplyState();
      const deps = makeDeps(runner, {
        currentVersion: "0.4.10",
        applyState: applyState.store,
        roles: hostRoles({ gateway: supervised, collector: supervised }),
        restartService: vi.fn((component: ServiceComponent) => {
          events.push(`restart ${component}`);
          return Promise.resolve();
        }),
        awaitHealth: vi.fn((expected: string | null) => {
          events.push(`awaitHealth ${expected}`);
          return Promise.resolve();
        }),
      });
      await runUpdateContinuation(sourceOffer(), deps);
      expect(events).toEqual(["restart gateway", "awaitHealth 0.5.0", "restart collector"]);
      expect(runner.calls).toEqual([]);
      expect(applyState.writes).toEqual([]);
      expect(deps.backup).not.toHaveBeenCalled();
    });

    test("a container install backs up first and records completion once its gateway serves", async () => {
      const events: string[] = [];
      const applyState = fakeApplyState();
      const deps = makeDeps(fakeRunner([]), {
        currentVersion: "0.4.10",
        applyState: applyState.store,
        roles: hostRoles({ gateway: supervised, collector: supervised }),
        backup: vi.fn((note: string) => {
          events.push(`backup ${note}`);
          return Promise.resolve();
        }),
        restartService: vi.fn((component: ServiceComponent) => {
          events.push(`restart ${component}`);
          return Promise.resolve();
        }),
        awaitHealth: vi.fn((expected: string | null) => {
          events.push(`awaitHealth ${expected}`);
          return Promise.resolve();
        }),
      });
      await runUpdateContinuation(
        {
          subject: {
            method: "docker",
            composeFile: "/srv/omnesis/docker-compose.yml",
            projectDir: "/srv/omnesis",
            target: "0.5.0",
            previous: "0.4.10",
          },
          targetVersion: "0.5.0",
          previousVersion: "0.4.10",
          deferredBackup: "online",
          restart: true,
        },
        deps,
      );
      expect(events).toEqual([
        "backup pre-update 0.4.10 to 0.5.0",
        "restart gateway",
        "awaitHealth 0.5.0",
        "restart collector",
      ]);
      expect(applyState.writes).toEqual([completedDockerApplyState("/srv/omnesis", "0.5.0")]);
    });

    test("a gateway that does not come back is rolled back exactly as a single run would", async () => {
      const clean = { code: 0, stdout: "" };
      const runner = fakeRunner([clean, clean, clean]);
      const applyState = fakeApplyState();
      const awaitHealth = vi
        .fn((_expected: string | null) => Promise.resolve())
        .mockRejectedValueOnce(new Error("timed out"));
      const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
      await expect(
        runUpdateContinuation(
          sourceOffer(),
          makeDeps(runner, {
            currentVersion: "0.4.10",
            applyState: applyState.store,
            roles: hostRoles({ gateway: supervised, collector: supervised }),
            awaitHealth,
            restartService,
          }),
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
      expect(executed(runner)).toEqual([
        `git checkout --detach ${PREVIOUS}`,
        "npm ci",
        "npm run build",
      ]);
      expect(applyState.writes).toEqual([
        activeSourceApplyState(rootDir, "rolling-back", TARGET, PREVIOUS),
        completedSourceApplyState(rootDir, PREVIOUS),
      ]);
      // The restored build is the one demanded back, not this build's own.
      expect(awaitHealth).toHaveBeenLastCalledWith("0.4.10");
      expect(restartService).not.toHaveBeenCalledWith("collector");
      expect(output()).toContain("forward-only migrations");
    });

    test("a deferred copy that fails undoes the apply before anything restarted", async () => {
      const clean = { code: 0, stdout: "" };
      const runner = fakeRunner([clean, clean, clean]);
      const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
      await expect(
        runUpdateContinuation(
          sourceOffer({ deferredBackup: "offline" }),
          makeDeps(runner, {
            currentVersion: "0.4.10",
            roles: hostRoles({
              gateway: { present: true, supervised: false, manualRestart: null, stopped: true },
            }),
            offlineBackup: vi.fn(() => Promise.reject(new Error("Not enough free disk space"))),
            restartService,
          }),
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_FAILURE,
        message: expect.stringMatching(
          /before restarting onto v0\.5\.0: Not enough free disk space[\s\S]*--no-backup[\s\S]*Rolled back/,
        ),
      });
      expect(executed(runner)).toEqual([
        `git checkout --detach ${PREVIOUS}`,
        "npm ci",
        "npm run build",
      ]);
      expect(restartService).not.toHaveBeenCalled();
    });

    test("a gateway that started during the apply is never backed up through its API", async () => {
      const clean = { code: 0, stdout: "" };
      const runner = fakeRunner([clean, clean, clean]);
      const backup = vi.fn(() => Promise.resolve());
      await expect(
        runUpdateContinuation(
          sourceOffer({ deferredBackup: "offline" }),
          makeDeps(runner, {
            currentVersion: "0.4.10",
            roles: hostRoles({ gateway: supervised }),
            offlineBackup: vi.fn(() => Promise.resolve({ kind: "gateway-running" as const })),
            backup,
          }),
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
      expect(backup).not.toHaveBeenCalled();
      expect(output()).toContain("may already run the new build");
      expect(output()).toContain("forward-only migrations may have run");
      expect(executed(runner)).toContain("npm run build");
    });
  });
});

describe("hand-over paths a single run never had", () => {
  const rootDir = "/home/dev/omnesis";
  const sourceSubject = {
    method: "source" as const,
    rootDir,
    edge: false,
    target: "v0.5.0",
    targetCommit: TARGET,
    previous: PREVIOUS,
  };
  const dockerOffer = (over: Partial<ContinuationOffer> = {}): ContinuationOffer => ({
    subject: {
      method: "docker",
      composeFile: "/srv/omnesis/docker-compose.yml",
      projectDir: "/srv/omnesis",
      target: "0.5.0",
      previous: "0.4.10",
    },
    targetVersion: "0.5.0",
    previousVersion: "0.4.10",
    deferredBackup: "online",
    restart: true,
    ...over,
  });

  test("--no-restart in the installed build backs up and leaves a container record unfinished", async () => {
    const events: string[] = [];
    const applyState = fakeApplyState();
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    await runUpdateContinuation(
      dockerOffer({ restart: false }),
      makeDeps(fakeRunner([]), {
        currentVersion: "0.4.10",
        restart: false,
        applyState: applyState.store,
        roles: hostRoles({ gateway: supervised, collector: supervised }),
        backup: vi.fn(() => {
          events.push("backup");
          return Promise.resolve();
        }),
        restartService,
      }),
    );
    expect(events).toEqual(["backup"]);
    expect(restartService).not.toHaveBeenCalled();
    // The gateway was never seen on the new image, so nothing says it finished.
    expect(applyState.writes).toEqual([]);
  });

  test("with --no-restart, a signal during a deferred backup still rolls the apply back", async () => {
    const clean = { code: 0, stdout: "" };
    const runner = fakeRunner([clean, clean, clean]);
    const interruptions = new UpdateInterruptionRouter((code) => {
      throw new Error(`Unexpected update signal exit ${code}`);
    });
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    await expect(
      runUpdateContinuation(
        {
          subject: sourceSubject,
          targetVersion: "0.5.0",
          previousVersion: "0.4.10",
          deferredBackup: "offline",
          restart: false,
        },
        makeDeps(runner, {
          currentVersion: "0.4.10",
          restart: false,
          interruptions,
          roles: hostRoles({
            gateway: { present: true, supervised: false, manualRestart: null, stopped: true },
          }),
          offlineBackup: vi.fn(() => {
            interruptions.dispatch("SIGINT");
            return Promise.resolve({ kind: "copied" as const, path: "/tmp/backup" });
          }),
          restartService,
        }),
      ),
    ).rejects.toMatchObject({ exitCode: 130 });
    expect(executed(runner)).toEqual([
      `git checkout --detach ${PREVIOUS}`,
      "npm ci",
      "npm run build",
    ]);
    expect(restartService).not.toHaveBeenCalled();
  });

  test("a signal relayed to a build that accepted and finished undoes nothing here", async () => {
    const interruptions = new UpdateInterruptionRouter((code) => {
      throw new Error(`Unexpected update signal exit ${code}`);
    });
    const deliver = vi.fn();
    const runner = fakeRunner([
      { code: 0, stdout: "0.5.0\n" },
      { code: 0, stdout: "" },
    ]);
    const restartService = vi.fn((_component: ServiceComponent) => Promise.resolve());
    await expect(
      updateNpmGlobal(
        { channel: "stable", dryRun: false },
        makeDeps(runner, {
          interruptions,
          roles: hostRoles({ gateway: supervised }),
          restartService,
          continueAfterApply: (_offer, relay) => {
            relay.deliver = deliver;
            interruptions.dispatch("SIGTERM");
            return Promise.resolve({ accepted: true, code: 0, signal: null });
          },
        }),
      ),
    ).resolves.toBe("0.5.0");
    expect(deliver).toHaveBeenCalledWith("SIGTERM");
    expect(executed(runner)).toEqual(["npm install -g omnesis@0.5.0"]);
    expect(restartService).not.toHaveBeenCalled();
  });

  test("a dedicated gateway's API backup waits behind the package install", async () => {
    const events: string[] = [];
    const runner = fakeRunner([
      { code: 0, stdout: "0.5.0\n" },
      { code: 0, stdout: "" },
    ]);
    const continueAfterApply = vi.fn((offer: ContinuationOffer) => {
      events.push(`hand over (${offer.deferredBackup} backup)`);
      return Promise.resolve({ accepted: true, code: 0, signal: null });
    });
    const run: CommandRunner = (spec, mode, control) => {
      if (mode === "inherit") events.push([spec.command, ...spec.args].join(" "));
      return runner.run(spec, mode, control);
    };
    await updateNpmGlobal(
      { channel: "stable", dryRun: false },
      makeDeps(
        { run, calls: runner.calls },
        {
          roles: hostRoles({
            gateway: {
              present: true,
              supervised: false,
              manualRestart: "sudo omnesis-gateway-admin update",
              hardened: { adminInstalled: true },
            },
          }),
          backup: vi.fn(() => {
            events.push("backup");
            return Promise.resolve();
          }),
          continueAfterApply,
        },
      ),
    );
    expect(events).toEqual(["npm install -g omnesis@0.5.0", "hand over (online backup)"]);
  });

  test.each<[string, RunOutcome | Error]>([
    ["a failed read", { code: 1, stdout: '{"version":"0.5.0"}' }],
    ["an unreadable manifest", { code: 0, stdout: "not json" }],
    ["a version too old", { code: 0, stdout: '{"version":"0.4.10"}' }],
    ["a runner that throws", new Error("git missing")],
  ])("an edge build whose version cannot be told is finished here: %s", async (_name, manifest) => {
    const managed = { code: 0, stdout: "managed\n" };
    const clean = { code: 0, stdout: "" };
    const events: string[] = [];
    const runner = fakeRunner([
      managed,
      clean,
      clean,
      manifest,
      { code: 0, stdout: `${PREVIOUS}\n` },
      { code: 0, stdout: `${TARGET}\n` },
      clean,
      clean,
      clean,
      clean,
    ]);
    const run: CommandRunner = (spec, mode, control) => {
      if (mode === "inherit") events.push([spec.command, ...spec.args].join(" "));
      return runner.run(spec, mode, control);
    };
    const continueAfterApply = vi.fn(() =>
      Promise.resolve({ accepted: true, code: 0, signal: null }),
    );
    await updateSourceCheckout(
      { rootDir, edge: true, dryRun: false },
      makeDeps(
        { run, calls: runner.calls },
        {
          roles: hostRoles({
            gateway: { present: true, supervised: false, manualRestart: null, stopped: true },
          }),
          offlineBackup: vi.fn(() => {
            events.push("copy");
            return Promise.resolve({ kind: "copied" as const, path: "/tmp/backup" });
          }),
          continueAfterApply,
        },
      ),
    );
    expect(continueAfterApply).not.toHaveBeenCalled();
    expect(events.indexOf("copy")).toBeLessThan(
      events.indexOf("git checkout --detach origin/main"),
    );
  });

  test("a handed-off lock lost during the action keeps the action's own failure", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-cli-update-lock-"));
    const collector = acquireUpdateLock(configDir, { owner: "collector self-update" });
    try {
      await expect(
        runWithUpdateLock(
          configDir,
          false,
          (lock) => {
            // Another holder takes it over and never gives it back.
            adoptUpdateLock(configDir, lock!.id, { owner: "somebody else" });
            return Promise.reject(new CliError("", 137));
          },
          { OMNESIS_UPDATE_LOCK_ID: collector.id },
        ),
      ).rejects.toMatchObject({ exitCode: 137 });
      expect(output()).toContain("The host update lock could not be returned");
    } finally {
      collector.release();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  describe("taking an offer", () => {
    const OFFER_ID = "3f1b0c6e-8a2d-4e5f-9b7c-1d2e3f4a5b6c";
    let configDir: string;
    let offering: ReturnType<typeof acquireUpdateLock>;

    beforeEach(() => {
      configDir = mkdtempSync(join(tmpdir(), "omnesis-cli-continuation-"));
      offering = acquireUpdateLock(configDir, { owner: "operator update" });
    });
    afterEach(() => {
      offering.release();
      rmSync(configDir, { recursive: true, force: true });
    });

    const doc = (over: Partial<UpdateContinuation> = {}): UpdateContinuation => ({
      version: 1,
      id: OFFER_ID,
      lockId: offering.id,
      state: "offered",
      subject: sourceSubject,
      targetVersion: "0.5.0",
      previousVersion: "0.4.10",
      deferredBackup: null,
      restart: true,
      yes: true,
      healthTimeoutSec: 600,
      ...over,
    });

    function take(
      overrides: {
        ownVersion?: string;
        prepare?: (lock: unknown) => Promise<void> | void;
        interruptions?: UpdateInterruptionRouter;
      } = {},
    ) {
      const interruptions =
        overrides.interruptions ??
        new UpdateInterruptionRouter((code) => {
          throw new Error(`Unexpected update signal exit ${code}`);
        });
      const prepare = vi.fn(
        async (_install: unknown, _offer: UpdateContinuation, lock: unknown) => {
          await overrides.prepare?.(lock);
          return makeDeps(fakeRunner([]), {
            currentVersion: "0.4.10",
            interruptions,
            updateLock: lock as UpdateFlowDeps["updateLock"],
          });
        },
      );
      const run = continueOffer({
        configDir,
        id: OFFER_ID,
        env: { OMNESIS_UPDATE_LOCK_ID: offering.id },
        ownVersion: overrides.ownVersion ?? "0.5.0",
        detection: { method: "source", rootDir },
        interruptions,
        prepare,
      });
      return { run, prepare, interruptions };
    }

    test("the installed build adopts the lock, accepts, finishes, and hands the lock back", async () => {
      writeContinuation(configDir, doc());
      const { run, prepare } = take();
      await run;
      expect(prepare).toHaveBeenCalledWith(
        { kind: "source", rootDir },
        expect.anything(),
        expect.anything(),
      );
      expect(readContinuation(configDir)?.state).toBe("accepted");
      offering.setStep("fanning out");
      expect(() => acquireUpdateLock(configDir, { owner: "second" })).toThrow(/fanning out/);
    });

    test("a refusal leaves the offer open and the lock with the offering process", async () => {
      writeContinuation(configDir, doc());
      const { run, prepare } = take({ ownVersion: "0.4.10" });
      await expect(run).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
      expect(prepare).not.toHaveBeenCalled();
      expect(readContinuation(configDir)?.state).toBe("offered");
      offering.setStep("finishing here");
    });

    test("a signal before acceptance refuses the offer and returns the lock", async () => {
      writeContinuation(configDir, doc());
      const interruptions = new UpdateInterruptionRouter((code) => {
        throw new Error(`Unexpected update signal exit ${code}`);
      });
      const { run } = take({
        interruptions,
        prepare: () => {
          interruptions.dispatch("SIGTERM");
        },
      });
      await expect(run).rejects.toMatchObject({ exitCode: 143 });
      expect(readContinuation(configDir)?.state).toBe("offered");
      offering.setStep("rolling back here");
    });

    test("an offer replaced while the host was read is not accepted", async () => {
      writeContinuation(configDir, doc());
      const { run } = take({
        prepare: () => {
          writeContinuation(configDir, doc({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }));
        },
      });
      await expect(run).rejects.toMatchObject({ exitCode: EXIT_FAILURE });
      expect(readContinuation(configDir)?.state).toBe("offered");
      offering.setStep("finishing here");
    });
  });
});

/** For a run a test expects to fail: its success is the failure. */
function unexpectedSuccess(): never {
  throw new Error("expected the update to fail");
}

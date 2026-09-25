// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  realpathSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { UPDATE_LOCK_ENV } from "@omnesis/core";
import { UpdateInterruptionRouter } from "./interruption.js";
import {
  CONTAINER_OWN_ENV,
  handOverAfterApply,
  acceptContinuation,
  applyPlanForSubject,
  claimContinuation,
  continuationCommand,
  continuationPath,
  ContinuationRefused,
  continuationTarget,
  deferredBackupFor,
  installedPackageEntry,
  launchContinuation,
  orderForHandoff,
  parseUpdateContinuation,
  planForSubject,
  readContinuation,
  supportsContinuation,
  writeContinuation,
  type ContinuationCommandContext,
  type SignalRelay,
  type UpdateContinuation,
} from "./continuation.js";
import {
  activeDockerApplyState,
  planHostUpdate,
  sourceUpdateSpecs,
  type ComponentRole,
  type HostRoles,
} from "./detect.js";

const TARGET_COMMIT = "1122334455667788990011223344556677889900";
const PREVIOUS_COMMIT = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";
const OFFER_ID = "3f1b0c6e-8a2d-4e5f-9b7c-1d2e3f4a5b6c";
const LOCK_ID = "0c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f";

function offer(over: Partial<UpdateContinuation> = {}): UpdateContinuation {
  return {
    version: 1,
    id: OFFER_ID,
    lockId: LOCK_ID,
    state: "offered",
    subject: {
      method: "source",
      rootDir: "/opt/omnesis",
      edge: false,
      target: "v0.5.0",
      targetCommit: TARGET_COMMIT,
      previous: PREVIOUS_COMMIT,
    },
    targetVersion: "0.5.0",
    previousVersion: "0.4.10",
    deferredBackup: null,
    restart: true,
    yes: true,
    healthTimeoutSec: 600,
    ...over,
  };
}

const dirs: string[] = [];
function tempDir(): string {
  // macOS hands back /var/folders/…, a symlink to /private/var/folders/…, and
  // the code under test resolves symlinks — as it must, since npm reaches a
  // package through a bin symlink. Resolve here too, so these expectations are
  // in the same space as the paths it returns; on Linux this is a no-op.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-continuation-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which targets take the rest of an update", () => {
  test("a release at or after the first that knows how", () => {
    expect(supportsContinuation("0.4.11")).toBe(true);
    expect(supportsContinuation("0.5.0")).toBe(true);
    expect(supportsContinuation("0.4.11-beta.1")).toBe(true);
  });

  test("never an older release, a branch, or no version at all", () => {
    expect(supportsContinuation("0.4.10")).toBe(false);
    expect(supportsContinuation("main")).toBe(false);
    expect(supportsContinuation(null)).toBe(false);
  });
});

describe("where the backup runs", () => {
  const off: ComponentRole = { present: false, supervised: false, manualRestart: null };
  const running: ComponentRole = { present: true, supervised: true, manualRestart: null };
  const roles = (gateway: ComponentRole): HostRoles => ({ gateway, collector: off, harnesses: [] });
  const plan = (gateway: ComponentRole) => planHostUpdate(roles(gateway), { backup: true });

  test("a gateway served from the installation being moved backs up before the apply", () => {
    const steps = plan(running);
    expect(deferredBackupFor("source", running, steps)).toBeNull();
    expect(deferredBackupFor("npm-global", running, steps)).toBeNull();
    expect(orderForHandoff(steps, null)).toEqual(steps);
    expect(steps.slice(0, 2).map((step) => step.kind)).toEqual(["backup", "apply"]);
  });

  test("a stopped gateway is copied after the apply, by the build that apply installed", () => {
    const stopped = { ...running, supervised: false, stopped: true };
    const steps = plan(stopped);
    const deferred = deferredBackupFor("source", stopped, steps);
    expect(deferred).toBe("offline");
    expect(orderForHandoff(steps, deferred).slice(0, 2)).toEqual([
      { kind: "apply" },
      { kind: "backup", offline: true },
    ]);
  });

  test("a container gateway and a dedicated one back up through the API after the apply", () => {
    const steps = plan(running);
    expect(deferredBackupFor("docker", running, steps)).toBe("online");
    const hardened = { ...running, supervised: false, hardened: { adminInstalled: true } };
    expect(deferredBackupFor("npm-global", hardened, plan(hardened))).toBe("online");
    expect(orderForHandoff(steps, "online").map((step) => step.kind)).toEqual([
      "apply",
      "backup",
      "restart",
      "await-health",
    ]);
  });

  test("the deferred kind is the offer's, whatever the continuing build now reads", () => {
    // The offer was made for a stopped gateway; the continuing build sees one
    // running. Its copy must still be attempted, never an API backup of a
    // gateway that may already run the new build.
    const steps = plan(running);
    expect(orderForHandoff(steps, "offline")[1]).toEqual({ kind: "backup", offline: true });
  });

  test("no backup in the plan means none is added", () => {
    const steps = planHostUpdate(roles(running), { backup: false });
    expect(deferredBackupFor("docker", running, steps)).toBeNull();
    expect(orderForHandoff(steps, "online")).toEqual(steps);
  });
});

describe("what the continuing build rebuilds from an offer", () => {
  test("a checkout's rollback returns to the last completed commit", () => {
    const subject = offer().subject;
    const plan = applyPlanForSubject(subject, { NODE_OPTIONS: "--max-old-space-size=2048" });
    expect(plan.rollback).toEqual(
      sourceUpdateSpecs("/opt/omnesis", PREVIOUS_COMMIT, {
        NODE_OPTIONS: "--max-old-space-size=2048",
      }),
    );
    expect(continuationTarget(subject)).toEqual({ label: "v0.5.0", expectVersion: "0.5.0" });
    expect(
      continuationTarget({ ...subject, edge: true, target: "origin/main" } as typeof subject),
    ).toEqual({ label: "origin/main (edge)", expectVersion: null });
  });

  test("a package rolls back to its previous version on the same registry", () => {
    const plan = applyPlanForSubject({
      method: "npm-global",
      target: "0.5.0",
      previous: "0.4.10",
      registry: "https://packages.example.org",
    });
    expect(plan.rollback).toEqual([
      {
        command: "npm",
        args: ["install", "-g", "omnesis@0.4.10", "--registry", "https://packages.example.org"],
      },
    ]);
  });

  test("a container install rolls back to the tag it last served", () => {
    const plan = applyPlanForSubject({
      method: "docker",
      composeFile: "/srv/omnesis/docker-compose.yml",
      projectDir: "/srv/omnesis",
      target: "0.5.0",
      previous: "0.4.10",
    });
    expect(plan.previous).toBe("0.4.10");
    expect(plan.applyState?.rollingBack).toEqual(
      activeDockerApplyState("/srv/omnesis", "rolling-back", "0.5.0", "0.4.10"),
    );
  });
});

describe("reading an offer", () => {
  test("a valid offer reads back as written", () => {
    const doc = offer({ deferredBackup: "offline", restart: false });
    expect(parseUpdateContinuation(JSON.stringify(doc))).toEqual(doc);
  });

  test.each<[string, Record<string, unknown>]>([
    ["an id that is not a uuid", { id: "../elsewhere" }],
    ["an unknown state", { state: "finished" }],
    ["a target version that is not a release", { targetVersion: "main" }],
    ["a timeout of zero", { healthTimeoutSec: 0 }],
    ["a deferred backup of an unknown kind", { deferredBackup: "remote" }],
    ["a commit that is not one", { subject: { ...offer().subject, targetCommit: "HEAD" } }],
    [
      "a stable target that is not a tag",
      { subject: { ...offer().subject, target: "--upload-pack=x" } },
    ],
    ["an edge target other than main", { subject: { ...offer().subject, edge: true } }],
    ["a relative checkout path", { subject: { ...offer().subject, rootDir: "omnesis" } }],
    [
      "a registry that is not a web address",
      {
        subject: {
          method: "npm-global",
          target: "0.5.0",
          previous: "0.4.10",
          registry: "file:///tmp/x",
        },
      },
    ],
    [
      "an image tag no registry would accept",
      {
        subject: {
          method: "docker",
          composeFile: "/srv/omnesis/docker-compose.yml",
          projectDir: "/srv/omnesis",
          target: "0.5.0 --privileged",
          previous: "0.4.10",
        },
      },
    ],
  ])("refuses %s", (_name, over) => {
    expect(parseUpdateContinuation(JSON.stringify({ ...offer(), ...over }))).toBeNull();
  });

  test("an offer is only for the installation it describes", () => {
    const source = offer().subject;
    expect(planForSubject({ method: "source", rootDir: "/opt/omnesis" }, source)).toEqual({
      kind: "source",
      rootDir: "/opt/omnesis",
    });
    expect(() => planForSubject({ method: "source", rootDir: "/opt/other" }, source)).toThrow(
      ContinuationRefused,
    );
    expect(() => planForSubject({ method: "npm-global" }, source)).toThrow(ContinuationRefused);
    expect(
      planForSubject(
        {
          method: "docker",
          composeFile: "/srv/omnesis/docker-compose.yml",
          projectDir: "/srv/omnesis",
        },
        {
          method: "docker",
          composeFile: "/srv/omnesis/docker-compose.yml",
          projectDir: "/srv/omnesis",
          target: "0.5.0",
          previous: "0.4.10",
        },
      ),
    ).toEqual({
      kind: "docker",
      composeFile: "/srv/omnesis/docker-compose.yml",
      projectDir: "/srv/omnesis",
    });
  });
});

describe("taking an offer", () => {
  test("the build the offer names, with the lock the offer names, takes it once", () => {
    const configDir = tempDir();
    writeContinuation(configDir, offer());
    const claimed = claimContinuation(configDir, OFFER_ID, {
      lockId: LOCK_ID,
      ownVersion: "v0.5.0",
    });
    acceptContinuation(configDir, claimed);
    expect(readContinuation(configDir)?.state).toBe("accepted");
    expect(() =>
      claimContinuation(configDir, OFFER_ID, { lockId: LOCK_ID, ownVersion: "0.5.0" }),
    ).toThrow(/already been continued/);
    expect(() => acceptContinuation(configDir, claimed)).toThrow(ContinuationRefused);
  });

  test.each<[string, { id?: string; lockId?: string; ownVersion?: string }, RegExp]>([
    ["another run's id", { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, /No update is waiting/],
    ["a lock that was not handed over", { lockId: undefined }, /lock was not handed/],
    ["another lock", { lockId: "11111111-2222-4333-8444-555555555555" }, /lock was not handed/],
    ["a build of another version", { ownVersion: "0.4.10" }, /This build is 0.4.10, not 0.5.0/],
  ])("refuses %s", (_name, over, message) => {
    const configDir = tempDir();
    writeContinuation(configDir, offer());
    expect(() =>
      claimContinuation(configDir, over.id ?? OFFER_ID, {
        lockId: "lockId" in over ? over.lockId : LOCK_ID,
        ownVersion: over.ownVersion ?? "0.5.0",
      }),
    ).toThrow(message);
    expect(readContinuation(configDir)?.state).toBe("offered");
  });

  test("an offer removed or replaced after it was claimed is not accepted", () => {
    const configDir = tempDir();
    writeContinuation(configDir, offer());
    const claimed = claimContinuation(configDir, OFFER_ID, {
      lockId: LOCK_ID,
      ownVersion: "0.5.0",
    });
    writeContinuation(configDir, offer({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }));
    expect(() => acceptContinuation(configDir, claimed)).toThrow(ContinuationRefused);
    expect(readContinuation(configDir)?.state).toBe("offered");
    rmSync(continuationPath(configDir));
    expect(() => acceptContinuation(configDir, claimed)).toThrow(ContinuationRefused);
    expect(existsSync(continuationPath(configDir))).toBe(false);
  });

  test("the offer is written owner-only, and a symlink in its place is no offer", () => {
    const configDir = tempDir();
    writeContinuation(configDir, offer());
    expect(statSync(continuationPath(configDir)).mode & 0o777).toBe(0o600);

    const elsewhere = tempDir();
    writeContinuation(elsewhere, offer());
    rmSync(continuationPath(configDir));
    symlinkSync(continuationPath(elsewhere), continuationPath(configDir));
    expect(readContinuation(configDir)).toBeNull();
    expect(() =>
      claimContinuation(configDir, OFFER_ID, { lockId: LOCK_ID, ownVersion: "0.5.0" }),
    ).toThrow(ContinuationRefused);
  });

  test("no offer on disk is nothing to take", () => {
    expect(() =>
      claimContinuation(tempDir(), OFFER_ID, { lockId: LOCK_ID, ownVersion: "0.5.0" }),
    ).toThrow(ContinuationRefused);
  });
});

describe("finding the installed build", () => {
  function writePackage(root: string, bin: unknown, name = "omnesis"): void {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name, bin }));
  }

  test("a package's entry is read from the manifest now on disk, wherever it moved", () => {
    const root = tempDir();
    writePackage(root, { omnesis: "dist/index.js" });
    writeFileSync(join(root, "dist", "index.js"), "");
    const argv1 = join(root, "dist", "index.js");
    expect(installedPackageEntry(argv1)).toBe(join(root, "dist", "index.js"));

    writePackage(root, { omnesis: "dist/cli.js" });
    writeFileSync(join(root, "dist", "cli.js"), "");
    expect(installedPackageEntry(argv1)).toBe(join(root, "dist", "cli.js"));
  });

  test("a single-string bin, reached through npm's bin symlink, is the entry", () => {
    const root = tempDir();
    writePackage(root, "dist/index.js");
    writeFileSync(join(root, "dist", "index.js"), "");
    // A package.json nearer the entry that is not the CLI's does not stop the walk.
    writeFileSync(join(root, "dist", "package.json"), JSON.stringify({ type: "module" }));
    const bin = join(tempDir(), "omnesis");
    symlinkSync(join(root, "dist", "index.js"), bin);
    expect(installedPackageEntry(bin)).toBe(join(root, "dist", "index.js"));
  });

  test("an entry that is missing, or a package that is not the CLI, is not found", () => {
    const root = tempDir();
    writePackage(root, { omnesis: "dist/gone.js" });
    writeFileSync(join(root, "dist", "index.js"), "");
    expect(installedPackageEntry(join(root, "dist", "index.js"))).toBeNull();

    const other = tempDir();
    writePackage(other, "dist/index.js", "something-else");
    writeFileSync(join(other, "dist", "index.js"), "");
    expect(installedPackageEntry(join(other, "dist", "index.js"))).toBeNull();
  });

  const ctx = (over: Partial<ContinuationCommandContext> = {}): ContinuationCommandContext => ({
    env: {},
    execPath: "/usr/bin/node",
    packageEntry: () => "/usr/lib/node_modules/omnesis/dist/index.js",
    interactive: true,
    ...over,
  });

  test("a checkout runs its own tsx entry, with the lock id to adopt", () => {
    expect(continuationCommand(offer().subject, OFFER_ID, LOCK_ID, ctx())).toEqual({
      command: "/opt/omnesis/node_modules/.bin/tsx",
      args: ["/opt/omnesis/packages/cli/src/index.ts", "update", "continue-after-apply", OFFER_ID],
      env: { OMNESIS_UPDATE_LOCK_ID: LOCK_ID },
    });
  });

  test("a package runs the entry its manifest names, or nothing when there is none", () => {
    const subject = { method: "npm-global" as const, target: "0.5.0", previous: "0.4.10" };
    expect(continuationCommand(subject, OFFER_ID, LOCK_ID, ctx())).toEqual({
      command: "/usr/bin/node",
      args: [
        "/usr/lib/node_modules/omnesis/dist/index.js",
        "update",
        "continue-after-apply",
        OFFER_ID,
      ],
      env: { OMNESIS_UPDATE_LOCK_ID: LOCK_ID },
    });
    expect(continuationCommand(subject, OFFER_ID, LOCK_ID, ctx({ packageEntry: () => null }))).toBe(
      null,
    );
  });

  test("a container install runs the updater service at the recorded tag, as the wrapper does", () => {
    const subject = {
      method: "docker" as const,
      composeFile: "/srv/omnesis/docker-compose.yml",
      projectDir: "/srv/omnesis",
      target: "0.5.0",
      previous: "0.4.10",
    };
    const spec = continuationCommand(
      subject,
      OFFER_ID,
      LOCK_ID,
      ctx({
        interactive: false,
        env: {
          OMNESIS_LOG_LEVEL: "debug",
          OMNESIS_CONFIG_DIR: "/srv/omnesis",
          OMNESIS_UPDATE_LOCK_ID: "stale-id",
          PATH: "/usr/bin",
        },
      }),
    );
    expect(spec?.command).toBe("docker");
    expect(spec?.args).toEqual([
      "compose",
      "-f",
      "/srv/omnesis/docker-compose.yml",
      "--profile",
      "update",
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--env",
      `OMNESIS_UPDATE_LOCK_ID=${LOCK_ID}`,
      "--env",
      "OMNESIS_LOG_LEVEL=debug",
      "updater",
      "update",
      "continue-after-apply",
      OFFER_ID,
    ]);
    expect(continuationCommand(subject, OFFER_ID, LOCK_ID, ctx())?.args).not.toContain("-T");
  });

  test("a container run leaves out exactly what the host wrapper leaves out", () => {
    const script = readFileSync(new URL("../../../../scripts/install.sh", import.meta.url), "utf8");
    const wrapper = new Set(
      [...script.matchAll(/^\s*((?:OMNESIS_[A-Z_]+\|?)+)\) continue ;;$/gmu)].flatMap((match) =>
        match[1]!.split("|"),
      ),
    );
    expect(wrapper.size).toBeGreaterThan(0);
    expect(new Set(CONTAINER_OWN_ENV)).toEqual(new Set([...wrapper, UPDATE_LOCK_ENV]));
  });
});

describe.skipIf(process.platform === "win32")("running the installed build on an offer", () => {
  test("a build that accepts reports its own exit status, with the lock id it was handed", async () => {
    const configDir = tempDir();
    const seen = join(configDir, "seen-lock");
    const script = `
      const fs = require("node:fs");
      const [path, seen] = process.argv.slice(1);
      const doc = JSON.parse(fs.readFileSync(path, "utf8"));
      doc.state = "accepted";
      fs.writeFileSync(path, JSON.stringify(doc));
      fs.writeFileSync(seen, process.env.OMNESIS_UPDATE_LOCK_ID ?? "");
      process.exit(4);
    `;
    const outcome = await launchContinuation({
      configDir,
      doc: offer(),
      relay: {},
      command: {
        command: process.execPath,
        args: ["-e", script, continuationPath(configDir), seen],
        env: { OMNESIS_UPDATE_LOCK_ID: LOCK_ID },
      },
    });
    expect(outcome).toEqual({ accepted: true, code: 4, signal: null });
    expect(readFileSync(seen, "utf8")).toBe(LOCK_ID);
    // The offer never outlives the run that made it.
    expect(existsSync(continuationPath(configDir))).toBe(false);
  });

  test("a build that accepts and is then killed reports the kill, as accepted", async () => {
    const configDir = tempDir();
    const script = `
      const fs = require("node:fs");
      const path = process.argv[1];
      const doc = JSON.parse(fs.readFileSync(path, "utf8"));
      doc.state = "accepted";
      fs.writeFileSync(path, JSON.stringify(doc));
      process.kill(process.pid, "SIGKILL");
    `;
    const outcome = await launchContinuation({
      configDir,
      doc: offer(),
      relay: {},
      command: { command: process.execPath, args: ["-e", script, continuationPath(configDir)] },
    });
    expect(outcome).toEqual({ accepted: true, code: 137, signal: "SIGKILL" });
    expect(existsSync(continuationPath(configDir))).toBe(false);
  });

  test("a build that exits without accepting leaves the offer untaken", async () => {
    const configDir = tempDir();
    const outcome = await launchContinuation({
      configDir,
      doc: offer(),
      relay: {},
      command: { command: process.execPath, args: ["-e", "process.exit(3)"] },
    });
    expect(outcome).toEqual({ accepted: false, code: 3, signal: null, detail: "it exited 3" });
    expect(existsSync(continuationPath(configDir))).toBe(false);
  });

  test("a build that cannot be found or started takes nothing", async () => {
    const configDir = tempDir();
    await expect(
      launchContinuation({ configDir, doc: offer(), relay: {}, command: null }),
    ).resolves.toMatchObject({ accepted: false, detail: "its CLI could not be found" });
    await expect(
      launchContinuation({
        configDir,
        doc: offer(),
        relay: {},
        command: { command: join(configDir, "no-such-cli"), args: [] },
      }),
    ).resolves.toMatchObject({ accepted: false, code: 1 });
    expect(existsSync(continuationPath(configDir))).toBe(false);
  });

  test("a signal this process receives reaches the build while it runs", async () => {
    const configDir = tempDir();
    const ready = join(configDir, "ready");
    const script = `
      require("node:fs").writeFileSync(process.argv[1], "yes");
      setInterval(() => {}, 1000);
    `;
    const relay: SignalRelay = {};
    const run = launchContinuation({
      configDir,
      doc: offer(),
      relay,
      command: { command: process.execPath, args: ["-e", script, ready] },
    });
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    relay.deliver?.("SIGTERM");
    await expect(run).resolves.toMatchObject({ accepted: false, code: 143, signal: "SIGTERM" });
    expect(relay.deliver).toBeUndefined();
  });
});

describe("handing over after the apply", () => {
  const taken = { accepted: true, code: 0, signal: null } as const;
  const router = () =>
    new UpdateInterruptionRouter((code) => {
      throw new Error(`Unexpected update signal exit ${code}`);
    });

  function lock(overrides: { setStep?: (step: string) => void; reclaim?: () => boolean } = {}) {
    return {
      setStep: vi.fn(overrides.setStep ?? (() => {})),
      reclaim: vi.fn(overrides.reclaim ?? (() => false)),
    };
  }

  test("a build that finished leaves nothing to do, and the signals are the caller's again", async () => {
    const interruptions = router();
    await expect(
      handOverAfterApply({
        offer: offer(),
        continueAfterApply: () => Promise.resolve(taken),
        interruptions,
        lock: lock(),
        targetLabel: "v0.5.0",
      }),
    ).resolves.toEqual({ finished: true });
    // Released: a new claim would throw if the relay still held it.
    interruptions.claim(() => {})();
  });

  test("a lock the declining build did not return is reclaimed before this process goes on", async () => {
    let owned = true;
    const held = lock({
      setStep: () => {
        if (!owned) throw new Error("This update lost ownership of the host lock");
      },
      reclaim: () => {
        owned = true;
        return true;
      },
    });
    const result = await handOverAfterApply({
      offer: offer(),
      continueAfterApply: () => {
        owned = false;
        return Promise.resolve({ accepted: false, code: 1, signal: null });
      },
      interruptions: router(),
      lock: held,
      targetLabel: "v0.5.0",
    });
    expect(result).toEqual({ finished: false, signal: null });
    expect(held.reclaim).toHaveBeenCalledOnce();
  });

  test("a lock that cannot be reclaimed stops the update without restarting anything", async () => {
    let owned = true;
    await expect(
      handOverAfterApply({
        offer: offer(),
        continueAfterApply: () => {
          owned = false;
          return Promise.resolve({ accepted: false, code: 1, signal: null });
        },
        interruptions: router(),
        lock: lock({
          setStep: () => {
            if (!owned) throw new Error("This update lost ownership of the host lock");
          },
        }),
        targetLabel: "v0.5.0",
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(
        /no longer holds the host update lock[\s\S]*Nothing has been restarted/,
      ),
    });
  });

  test("a signal while offering is relayed and handed back when the build did not take over", async () => {
    const interruptions = router();
    const deliver = vi.fn();
    const result = await handOverAfterApply({
      offer: offer(),
      continueAfterApply: (_offer, relay) => {
        relay.deliver = deliver;
        interruptions.dispatch("SIGTERM");
        return Promise.resolve({ accepted: false, code: 143, signal: null });
      },
      interruptions,
      lock: lock(),
      targetLabel: "v0.5.0",
    });
    expect(deliver).toHaveBeenCalledWith("SIGTERM");
    expect(result).toEqual({ finished: false, signal: "SIGTERM" });
  });

  test.each<[string, { code: number; signal: NodeJS.Signals | null }, boolean]>([
    ["a reported failure says nothing more", { code: 1, signal: null }, false],
    ["an exit by signal status warns of a partial update", { code: 143, signal: null }, true],
    ["a kill warns of a partial update", { code: 137, signal: "SIGKILL" }, true],
  ])("an accepted build that fails ends with its status: %s", async (_name, exit, warns) => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    try {
      await expect(
        handOverAfterApply({
          offer: offer(),
          continueAfterApply: () => Promise.resolve({ accepted: true, ...exit }),
          interruptions: router(),
          lock: lock(),
          targetLabel: "v0.5.0",
        }),
      ).rejects.toMatchObject({ exitCode: exit.code });
      expect(logs.some((line) => line.includes("may be only partly updated"))).toBe(warns);
    } finally {
      spy.mockRestore();
    }
  });
});

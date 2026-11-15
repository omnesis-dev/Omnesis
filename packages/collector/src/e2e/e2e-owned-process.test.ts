// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import {
  spawnWindowsJob,
  WindowsProcessTree,
  ownedProcessCleanupReceipt,
  type WindowsJobProcess,
} from "@omnesis/core";
import {
  createE2ESubprocessSpawner,
  getOwnedE2EProcess,
  e2eApplicationPid,
  e2eProcessOutput,
  OwnedE2EProcess,
} from "./e2e-owned-process.js";
import { E2EControlDecoder, encodeE2EControl } from "./e2e-process-protocol.js";
import {
  registerSubprocessGroup,
  killSubprocessGroup,
  liveGroupCountForTest,
} from "./subprocess-reaper.js";

const roots: string[] = [];
const records: ChildProcessWithoutNullStreams[] = [];
const physicalProofs = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
const fixtureRoots = new WeakMap<ChildProcessWithoutNullStreams, string>();
afterEach(async () => {
  const children = records.splice(0);
  const results = await Promise.allSettled(
    children.map((child) => killSubprocessGroup(child, { initialSignal: "SIGKILL" })),
  );
  const retained = new Set(
    children
      .filter((child) => !getOwnedE2EProcess(child)?.joinConfirmed)
      .map((child) => fixtureRoots.get(child)),
  );
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    if (!retained.has(root)) rmSync(root, { recursive: true, force: true });
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) {
    const reasons = failed.map((result) => result.reason as unknown);
    const marked = reasons.find((error) => ownedProcessCleanupReceipt(error) !== undefined);
    const receipt = ownedProcessCleanupReceipt(marked);
    const error = new AggregateError(reasons, "Owned fixture cleanup failed", { cause: marked });
    if (receipt !== undefined) Object.assign(error, { cleanupFailure: receipt.failure });
    throw error;
  }
});

test.each([false, true])(
  "marked preparation dominates positive Job join even after ordinary failure: %s",
  async (ordinaryFirst) => {
    const failure = Object.assign(Error("invented preparation uncertainty"), {
      cleanupFailure: undefined,
    });
    await preparationBoundary(failure, ordinaryFirst, true);
  },
);

test("ordinary preparation refusal with positive Job join remains cleanup eligible", async () => {
  await preparationBoundary(Error("invented joined preparation refusal"), false, false);
});

async function preparationBoundary(failure: Error, ordinaryFirst: boolean, marked: boolean) {
  let refuse!: (error: unknown) => void;
  let proveJoined!: () => void;
  const ready = new Promise<void>((_, reject) => {
    refuse = reject;
  });
  const joined = new Promise<void>((resolve) => {
    proveJoined = resolve;
  });
  const raw = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    jobReady: ready,
    jobClosed: joined,
    kill: vi.fn(() => {
      queueMicrotask(() => {
        raw.emit("close", 0, null);
        proveJoined();
      });
      return true;
    }),
  }) as unknown as WindowsJobProcess;
  const owned = new OwnedE2EProcess(
    raw,
    "a".repeat(64),
    performance.now() + 10000,
    Buffer.from("fixture"),
  );
  if (ordinaryFirst) raw.emit("error", Error("invented earlier ordinary failure"));
  refuse(failure);
  await owned.ready.catch(() => {});
  if (marked) {
    const rejected = await owned.joined.catch((error: unknown) => error);
    expect(ownedProcessCleanupReceipt(rejected)).toEqual({ failure: undefined, pending: false });
    expect(owned.joinConfirmed).toBe(false);
    await expect(owned.stop()).rejects.toBe(rejected);
  } else {
    await owned.joined;
    expect(owned.joinConfirmed).toBe(true);
    await expect(owned.stop()).rejects.toBe(failure);
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "e2e owned literal argv "));
  roots.push(root);
  return root;
}
function launcher(hold: Promise<void> = Promise.resolve()) {
  if (process.platform === "win32")
    return ((command, args, options) => {
      const child = spawnWindowsJob(command, args, options);
      const physicalClosed = child.jobClosed;
      physicalProofs.set(child, physicalClosed);
      child.jobClosed = physicalClosed.then(() => hold);
      return child;
    }) as typeof spawnWindowsJob;
  // Portable protocol proof uses real Node children in one owned POSIX group;
  // the deferred proof models the separate kernel confirmation boundary only.
  return ((command, args, options) => {
    const child = spawn(command, [...args], {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }) as WindowsJobProcess;
    let groupJoined = false;
    const alive = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    child.kill = () => {
      if (!groupJoined && child.pid !== undefined)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      return true;
    };
    child.jobReady = once(child, "spawn").then(() => {});
    const physicalClosed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    ).then(async () => {
      const deadline = performance.now() + 12000;
      while (alive()) {
        if (performance.now() >= deadline)
          throw Object.assign(Error("Portable owned group did not close"), {
            cleanupFailure: undefined,
          });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      groupJoined = true;
    });
    physicalProofs.set(child, physicalClosed);
    child.jobClosed = physicalClosed.then(() => hold);
    return child;
  }) as typeof spawnWindowsJob;
}
function start(program: string, hold?: Promise<void>, args: string[] = []) {
  const root = fixture(),
    file = join(root, "invented target.mjs");
  const cwdContract = `import {statSync as ownedFixtureStat} from 'node:fs';import {dirname as ownedFixtureDir} from 'node:path';import {fileURLToPath as ownedFixtureURL} from 'node:url';const ownedFixtureActual=ownedFixtureStat(process.cwd(),{bigint:true}),ownedFixtureExpected=ownedFixtureStat(ownedFixtureDir(ownedFixtureURL(import.meta.url)),{bigint:true});if(ownedFixtureActual.dev!==ownedFixtureExpected.dev||ownedFixtureActual.ino!==ownedFixtureExpected.ino)process.exit(32);`;
  writeFileSync(file, cwdContract + program);
  const spawnE2E = createE2ESubprocessSpawner({ platform: "win32", spawnOwned: launcher(hold) });
  const child = spawnE2E(process.execPath, [file, ...args], {
    cwd: pathToFileURL(root + sep),
    env: { ...process.env },
    detached: true,
  }) as ChildProcessWithoutNullStreams;
  records.push(child);
  fixtureRoots.set(child, root);
  return child;
}
const service = `process.stdout.write(Buffer.from([0,255,10,65]));process.stderr.write(Buffer.from([0,254,10,66]));process.on('message',m=>{if(m?.type==='omnesis.parent-shutdown'&&m.version===1)process.exit(0)});setInterval(()=>{},1000);`;

test.each(["throw", "callback"])(
  "shutdown write %s marker survives independent physical Job join",
  async (mode) => {
    const child = start(service),
      owned = getOwnedE2EProcess(child)!;
    await owned.ready;
    const failure = Object.assign(Error("invented shutdown write uncertainty"), {
      cleanupFailure: undefined,
    });
    const write = vi.spyOn(child.stdin, "write").mockImplementation((...args: unknown[]) => {
      if (mode === "throw") throw failure;
      const callback = args.at(-1);
      if (typeof callback === "function") queueMicrotask(() => callback(failure));
      return false;
    });
    try {
      expect(await owned.requestShutdown()).toBe(false);
      owned.cancel();
      await physicalProofs.get(child);
      const rejected = await owned.joined.catch((error: unknown) => error);
      expect(ownedProcessCleanupReceipt(rejected)).toEqual({ failure: undefined, pending: false });
      expect(owned.joinConfirmed).toBe(false);
      await expect(owned.stop()).rejects.toBe(rejected);
      records.splice(records.indexOf(child), 1);
      roots.splice(roots.indexOf(fixtureRoots.get(child)!), 1);
    } finally {
      write.mockRestore();
    }
  },
  30000,
);

test("synchronous owned preparation overrun never publishes target launch", async () => {
  const root = fixture(),
    marker = join(root, "target-started");
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const actual = launcher();
  const spawnE2E = createE2ESubprocessSpawner({
    platform: "win32",
    spawnOwned: (command, args, options) => {
      const child = actual(command, args, options);
      now = 24 * 60 * 60 * 1000;
      return child;
    },
  });
  const child = spawnE2E(process.execPath, [
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`,
  ]) as ChildProcessWithoutNullStreams;
  records.push(child);
  fixtureRoots.set(child, root);
  const owned = getOwnedE2EProcess(child)!;
  try {
    await expect(owned.ready).rejects.toThrow("shared boot budget");
    await owned.joined;
    expect(existsSync(marker)).toBe(false);
    await expect(owned.stop()).rejects.toThrow("shared boot budget");
    records.splice(records.indexOf(child), 1);
  } finally {
    clock.mockRestore();
  }
}, 30000);

test("actual application PID and IPC shutdown stay distinct from the owned helper", async () => {
  const argv = ["", "literal $&", 'quote"value', "path\\with\\slashes", "invented-🛰️"];
  const child = start(
    `if(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(argv))})process.exit(31);` +
      service,
    undefined,
    argv,
  );
  const owned = getOwnedE2EProcess(child)!;
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  const output = e2eProcessOutput(child);
  output.stdout!.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  output.stderr!.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  await registerSubprocessGroup(child);
  await owned.ready;
  expect(e2eApplicationPid(child)).toBeGreaterThan(0);
  expect(e2eApplicationPid(child)).not.toBe(child.pid);
  expect(await owned.requestShutdown()).toBe(true);
  await owned.joined;
  expect(owned.applicationExit).toEqual({ code: 0, signal: null });
  expect(Buffer.concat(stdout)).toEqual(Buffer.from([0, 255, 10, 65]));
  expect(Buffer.concat(stderr)).toEqual(Buffer.from([0, 254, 10, 66]));
}, 30000);

test("registered owned Jobs never invoke numeric Windows tree snapshots", async () => {
  const refresh = vi.spyOn(WindowsProcessTree.prototype, "refresh");
  const child = start(service);
  await registerSubprocessGroup(child);
  expect(e2eApplicationPid(child)).toBeGreaterThan(0);
  await killSubprocessGroup(child);
  expect(refresh).not.toHaveBeenCalled();
}, 30000);

test("raw process close cannot retire ownership before its separate joined proof", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const child = start(service, hold),
    owned = getOwnedE2EProcess(child)!;
  try {
    await registerSubprocessGroup(child);
    const closing = killSubprocessGroup(child, { termGraceMs: 5000, killGraceMs: 5000 });
    await owned.rawClosed;
    await physicalProofs.get(child);
    expect(liveGroupCountForTest()).toBeGreaterThan(0);
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await closing;
  } finally {
    release();
  }
}, 30000);

for (const reason of [undefined, new Error("invented unconfirmed cleanup")])
  test("rejected joined proof remains retained, including undefined rejection", async () => {
    let reject!: (reason: unknown) => void;
    const gate = new Promise<void>((_, fail) => {
      reject = fail;
    });
    void gate.catch(() => {});
    const child = start(service, gate),
      owned = getOwnedE2EProcess(child)!;
    await owned.ready;
    expect(await owned.requestShutdown()).toBe(true);
    await owned.rawClosed;
    await physicalProofs.get(child);
    reject(reason);
    const failure = await owned.joined.then(
      () => undefined,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(Object.hasOwn(failure, "cleanupFailure")).toBe(true);
    expect(
      await owned.stop().then(
        () => undefined,
        (error) => error,
      ),
    ).toBe(failure);
    expect(
      await owned.stop().then(
        () => undefined,
        (error) => error,
      ),
    ).toBe(failure);
    // The test seam deliberately rejects after actual raw and physical proof.
    // Never erase a real native rejection merely to remove fixture state.
    records.splice(records.indexOf(child), 1);
    roots.splice(roots.indexOf(fixtureRoots.get(child)!), 1);
  }, 30000);

test("control frames tolerate fragmentation without consuming arbitrary binary stderr", () => {
  const nonce = "a".repeat(64),
    raw = Buffer.from([0, 255, 10, 65, 0]);
  const frames: unknown[] = [],
    bytes: Buffer[] = [];
  const decoder = new E2EControlDecoder(
    nonce,
    (chunk) => bytes.push(Buffer.from(chunk)),
    (frame) => frames.push(frame),
  );
  const frame = encodeE2EControl(nonce, { type: "spawned", pid: 123 });
  expect(frame.includes(Buffer.from(nonce))).toBe(false);
  for (const byte of Buffer.concat([raw, frame, raw])) decoder.write(Buffer.from([byte]));
  decoder.end();
  expect(Buffer.concat(bytes)).toEqual(Buffer.concat([raw, raw]));
  expect(frames).toEqual([{ type: "spawned", pid: 123 }]);
});

test("oversized or truncated authenticated control is refused rather than accepted as application output", () => {
  const nonce = "b".repeat(64),
    valid = encodeE2EControl(nonce, { type: "spawned", pid: 123 });
  const decoder = new E2EControlDecoder(
    nonce,
    () => {},
    () => {},
  );
  decoder.write(valid.subarray(0, -1));
  expect(() => decoder.end()).toThrow("control");
});

test.runIf(process.platform === "win32")(
  "a real Job retains a descendant after its wrapper exits, then joins hard cancellation",
  async () => {
    const { createConnection } = await import("node:net");
    const descendant = `const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})));`;
    const rootProgram = `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','pipe','ignore']});let text='';child.stdout.on('data',bytes=>{text+=String(bytes);try{JSON.parse(text);process.stdout.write(text,()=>process.exit(0))}catch{}});`;
    const child = start(rootProgram),
      owned = getOwnedE2EProcess(child)!;
    let output = "";
    e2eProcessOutput(child).stdout!.on("data", (bytes) => {
      output += String(bytes);
    });
    await registerSubprocessGroup(child);
    await condition(() => owned.applicationExit?.code === 0 && jsonPort(output) !== undefined);
    const { port } = JSON.parse(output) as { port: number };
    let settled = false;
    void owned.joined.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    const accepts = () =>
      new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
    expect(await accepts()).toBe(true);
    await killSubprocessGroup(child, { initialSignal: "SIGKILL" });
    await owned.joined;
    expect(await accepts()).toBe(false);
  },
  60000,
);

function jsonPort(text: string): number | undefined {
  try {
    const value = JSON.parse(text);
    return Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
      ? value.port
      : undefined;
  } catch {
    return undefined;
  }
}
async function condition(check: () => boolean, ms = 10000): Promise<void> {
  const until = performance.now() + ms;
  while (!check()) {
    if (performance.now() >= until) throw Error("Owned E2E fixture condition did not complete");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test.runIf(process.platform === "win32")(
  "parent death closes the inner Job while an outer tree Job only observes",
  async () => {
    const { createConnection } = await import("node:net");
    const { e2eTsxCommand } = await import("./gateway-env.js");
    const root = fixture(),
      parent = join(root, "invented parent.mjs");
    const target = `const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})));`;
    const helperUrl = new URL("./e2e-owned-process.ts", import.meta.url).href;
    writeFileSync(
      parent,
      `import {spawnE2ESubprocess,getOwnedE2EProcess,e2eProcessOutput} from ${JSON.stringify(helperUrl)};const child=spawnE2ESubprocess(process.execPath,['-e',${JSON.stringify(target)}],{cwd:${JSON.stringify(root)},env:process.env,detached:true});e2eProcessOutput(child).stdout.pipe(process.stdout);await getOwnedE2EProcess(child).ready;process.stdin.once('data',()=>process.exit(17));process.stdin.resume();`,
    );
    const command = e2eTsxCommand(parent);
    // Default tree completion cannot itself kill the inner Job on root exit.
    // It is a retained, independently cancellable cleanup backstop for the test.
    const outer = spawnWindowsJob(command.command, command.args, {
      cwd: root,
      env: { ...process.env },
    });
    outer.stdin.on("error", () => {});
    let joined = false,
      primary: unknown,
      failed = false,
      cleanupFailed = false,
      cleanupFailure: unknown,
      output = "";
    outer.stdout.on("data", (bytes) => {
      output += String(bytes);
    });
    outer.stderr.resume();
    try {
      await outer.jobReady;
      await condition(() => jsonPort(output) !== undefined);
      const { port } = JSON.parse(output) as { port: number };
      outer.stdin.write("crash\n");
      let timer: NodeJS.Timeout | undefined;
      let closed: boolean;
      try {
        closed = await Promise.race([
          outer.jobClosed.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      expect(closed).toBe(true);
      await outer.jobClosed;
      joined = true;
      expect(outer.exitCode).toBe(17);
      const accepted = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      expect(accepted).toBe(false);
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      if (!joined) {
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => outer.kill("SIGKILL")),
          outer.jobClosed,
        ]);
        joined = cleanup[1]!.status === "fulfilled";
        const errors = cleanup
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason as unknown);
        if (errors.length) {
          cleanupFailed = true;
          cleanupFailure = new AggregateError(errors, "Parent-death fixture join failed", {
            cause:
              errors.find((error) => ownedProcessCleanupReceipt(error) !== undefined) ?? errors[0],
          });
          roots.splice(roots.indexOf(root), 1);
        }
      }
    }
    if (cleanupFailed) {
      const receipt = ownedProcessCleanupReceipt(cleanupFailure);
      throw Object.assign(
        new AggregateError(
          [...(failed ? [primary] : []), cleanupFailure],
          "Parent-death fixture cleanup was not confirmed",
          { cause: cleanupFailure },
        ),
        { cleanupFailure: receipt === undefined ? cleanupFailure : receipt.failure },
      );
    }
    if (failed) throw primary;
  },
  60000,
);

test.runIf(process.platform === "win32")(
  "immediate hard cancellation joins without admitting a future target",
  async () => {
    const marker = join(fixture(), "must-not-be-created");
    const child = start(
      `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],'invented');setInterval(()=>{},1000);`,
      undefined,
      [marker],
    );
    await killSubprocessGroup(child, { initialSignal: "SIGKILL" });
    await getOwnedE2EProcess(child)!.joined;
    expect(existsSync(marker)).toBe(false);
  },
  30000,
);

test("early control EOF fails the fixture but still joins the whole owned Job", async () => {
  const child = start(service),
    record = getOwnedE2EProcess(child)!;
  await record.ready;
  child.stdin.end();
  await record.joined;
  const failure = await record.stop().then(
    () => undefined,
    (error) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(Object.hasOwn(failure, "cleanupFailure")).toBe(false);
  expect(record.joinConfirmed).toBe(true);
  // The negative protocol expectation has been checked after positive physical
  // proof; there is no pending lifecycle operation for afterEach to retry.
  records.splice(records.indexOf(child), 1);
}, 30000);

test("foreign stderr control lookalikes remain raw bytes and cannot publish a PID", () => {
  const raw = encodeE2EControl("c".repeat(64), { type: "spawned", pid: 123 }),
    output: Buffer[] = [],
    frames: unknown[] = [];
  const decoder = new E2EControlDecoder(
    "d".repeat(64),
    (bytes) => output.push(Buffer.from(bytes)),
    (frame) => frames.push(frame),
  );
  decoder.write(raw);
  decoder.end();
  expect(Buffer.concat(output)).toEqual(raw);
  expect(frames).toEqual([]);
});

test("valid header authentication cannot authorize a changed control payload", () => {
  const nonce = "e".repeat(64),
    frame = encodeE2EControl(nonce, { type: "spawned", pid: 123 });
  frame[frame.length - 1] = frame[frame.length - 1]! ^ 1;
  const decoder = new E2EControlDecoder(
    nonce,
    () => {},
    () => {},
  );
  expect(() => decoder.write(frame)).toThrow("authenticated");
});

test("an authenticated oversized length is rejected before buffering its body", async () => {
  const { createHmac } = await import("node:crypto");
  const nonce = "f".repeat(64),
    frame = encodeE2EControl(nonce, { type: "spawned", pid: 123 });
  const at = Buffer.from("\0OMNESIS_E2E_CONTROL_V1\0").length;
  frame.writeUInt32LE(4097, at);
  createHmac("sha256", Buffer.from(nonce, "hex"))
    .update("OMNESIS_E2E_CONTROL_V1:header\0")
    .update(frame.subarray(at, at + 4))
    .digest()
    .copy(frame, at + 4);
  const decoder = new E2EControlDecoder(
    nonce,
    () => {},
    () => {},
  );
  expect(() => decoder.write(frame)).toThrow("limit");
});

test("hard cancellation joins before an actual fixture writer can run again", async () => {
  const marker = join(fixture(), "invented-writer-state");
  const program = `import {writeFileSync} from 'node:fs';let count=0;const write=()=>writeFileSync(process.argv[2],String(++count));write();setInterval(write,10);`;
  const child = start(program, undefined, [marker]),
    record = getOwnedE2EProcess(child)!;
  await record.ready;
  await condition(() => existsSync(marker));
  await killSubprocessGroup(child, { initialSignal: "SIGKILL" });
  await record.joined;
  const bytes = readFileSync(marker);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(readFileSync(marker)).toEqual(bytes);
}, 30000);

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { atomicWriteFileSync } from "./atomic-write.js";
import * as privateFiles from "./windows-private-file.js";
import {
  acquireUpdateLock,
  adoptUpdateLock,
  beginUpdateLockChildJoin,
  UpdateLockBusyError,
  type UpdateLock,
} from "./update-lock.js";

vi.mock("node:fs", { spy: true });
const actual = await vi.importActual<typeof fs>("node:fs");
const dirs: string[] = [],
  handles: UpdateLock[] = [];
const DEAD = 0x3fffffff;
const lockDir = (config: string) => join(config, "update.lock");
const ownerFile = (config: string) => join(lockDir(config), "owner.json");
const markers = (config: string) =>
  actual.readdirSync(lockDir(config)).filter((n) => n.startsWith(".child-join-"));
const later = () => new Date(Date.now() + 120_000);

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actual.writeFileSync);
  vi.mocked(fs.openSync).mockReset().mockImplementation(actual.openSync);
  vi.mocked(fs.readdirSync).mockReset().mockImplementation(actual.readdirSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(actual.lstatSync);
  for (const handle of handles.splice(0).reverse()) handle.release();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function config(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "update-child-join-"));
  dirs.push(path);
  return path;
}
function take(path: string, owner = "held updater", pid = DEAD): UpdateLock {
  const lock = acquireUpdateLock(path, { owner, pid, heartbeatMs: 60_000 });
  handles.push(lock);
  return lock;
}
function adopt(path: string, from: UpdateLock, owner: string): UpdateLock {
  const lock = adoptUpdateLock(path, from.id, {
    owner,
    pid: DEAD,
    heartbeatMs: 60_000,
    returnToHolder: true,
  });
  handles.push(lock);
  return lock;
}
function plant(path: string, id: string): string {
  const ownerHash = createHash("sha256").update(id).digest("hex"),
    nonce = randomUUID();
  const name = `.child-join-${ownerHash}-${nonce}`;
  atomicWriteFileSync(
    join(lockDir(path), name),
    JSON.stringify({ version: 1, ownerHash, nonce }) + "\n",
    { mode: 0o600 },
  );
  return name;
}

test("a dead stale owner cannot be retired while its pre-launch child has not joined", async () => {
  const path = await config(),
    parent = take(path);
  const scope = beginUpdateLockChildJoin(path, parent.id);
  const saved = actual.readFileSync(ownerFile(path), "utf8");
  expect(() => parent.setStep("unsafe concurrent apply")).toThrow("not been joined");
  expect(parent.reclaim()).toBe(false);
  parent.release();
  expect(() => parent.setStep("unsafe work after deferred release")).toThrow(
    "refusing further work",
  );
  expect(actual.readFileSync(ownerFile(path), "utf8")).toBe(saved);
  expect(() => acquireUpdateLock(path, { owner: "another update", now: later })).toThrow(
    UpdateLockBusyError,
  );
  scope.joined();
  const replacement = acquireUpdateLock(path, { owner: "joined successor", now: later });
  handles.push(replacement);
  expect(replacement.id).not.toBe(parent.id);
});

test("each nested scope clears only its own marker and joined is idempotent", async () => {
  const path = await config(),
    parent = take(path);
  const first = beginUpdateLockChildJoin(path, parent.id),
    second = beginUpdateLockChildJoin(path, parent.id);
  expect(markers(path)).toHaveLength(2);
  first.joined();
  first.joined();
  expect(markers(path)).toHaveLength(1);
  expect(() => parent.setStep("still waiting")).toThrow("not been joined");
  second.joined();
  parent.setStep("all children joined");
  parent.release();
  expect(actual.existsSync(lockDir(path))).toBe(false);
});

test("collector to CLI to continuation resumes under ancestor fences without retiring the transaction", async () => {
  const path = await config(),
    collector = take(path, "collector");
  const outer = beginUpdateLockChildJoin(path, collector.id);
  const cli = adopt(path, collector, "CLI");
  cli.setStep("preparing continuation");
  const inner = beginUpdateLockChildJoin(path, cli.id);
  const continuation = adopt(path, cli, "continuation");
  continuation.setStep("applying continuation");
  expect(() => continuation.handBack()).not.toThrow();
  expect(() => continuation.setStep("unsafe work after deferred hand-back")).toThrow(
    "refusing further work",
  );
  continuation.release();
  expect(JSON.parse(actual.readFileSync(ownerFile(path), "utf8")).id).toBe(continuation.id);
  expect(cli.reclaim()).toBe(false);
  inner.joined();
  expect(cli.reclaim()).toBe(true);
  cli.setStep("finishing joined continuation");
  cli.handBack();
  cli.release();
  expect(JSON.parse(actual.readFileSync(ownerFile(path), "utf8")).id).toBe(cli.id);
  expect(() => acquireUpdateLock(path, { owner: "outsider", now: later })).toThrow(
    UpdateLockBusyError,
  );
  outer.joined();
  expect(collector.reclaim()).toBe(true);
  collector.release();
  expect(actual.existsSync(lockDir(path))).toBe(false);
});

test("a whole handoff cannot discard the pending intermediate holder's verifiable lineage", async () => {
  const path = await config(),
    collector = take(path, "collector");
  const cli = adopt(path, collector, "CLI");
  const scope = beginUpdateLockChildJoin(path, cli.id);
  const before = actual.readFileSync(ownerFile(path), "utf8");
  expect(() =>
    adoptUpdateLock(path, cli.id, { owner: "whole handoff", pid: DEAD, heartbeatMs: 60_000 }),
  ).toThrow("pending child");
  expect(actual.readFileSync(ownerFile(path), "utf8")).toBe(before);
  scope.joined();
  const continuation = adoptUpdateLock(path, cli.id, {
    owner: "joined whole handoff",
    pid: DEAD,
    heartbeatMs: 60_000,
  });
  handles.push(continuation);
  expect(JSON.parse(actual.readFileSync(ownerFile(path), "utf8")).returnTo.id).toBe(collector.id);
  continuation.setStep("whole handoff keeps its verified ancestors");
  continuation.handBack();
  collector.setStep("whole handoff returned");
});

test("a first holder's default child adoption retains that pending holder as a verified ancestor", async () => {
  const path = await config(),
    parent = take(path);
  const scope = beginUpdateLockChildJoin(path, parent.id);
  const child = adoptUpdateLock(path, parent.id, {
    owner: "default first child",
    pid: DEAD,
    heartbeatMs: 60_000,
  });
  handles.push(child);
  child.setStep("working under the retained ancestor");
  child.handBack();
  scope.joined();
  expect(parent.reclaim()).toBe(true);
  parent.setStep("first child joined");
});

test.each(["step", "adopt", "begin"] as const)(
  "an unrelated valid marker refuses %s work without mutating the owner",
  async (action) => {
    const path = await config(),
      owner = take(path);
    plant(path, randomUUID());
    const before = actual.readFileSync(ownerFile(path), "utf8");
    const operation =
      action === "step"
        ? () => owner.setStep("unverified work")
        : action === "adopt"
          ? () => adopt(path, owner, "unverified child")
          : () => beginUpdateLockChildJoin(path, owner.id);
    expect(operation).toThrow();
    expect(actual.readFileSync(ownerFile(path), "utf8")).toBe(before);
    expect(markers(path)).toHaveLength(1);
  },
);

test("an unrelated marker remains unknown beside valid same-owner scopes", async () => {
  const path = await config(),
    owner = take(path);
  const first = beginUpdateLockChildJoin(path, owner.id);
  const unrelated = plant(path, randomUUID());
  expect(() => owner.setProcessGroup(DEAD)).toThrow("not been joined");
  expect(() => beginUpdateLockChildJoin(path, owner.id)).toThrow();
  expect(() => adopt(path, owner, "unverified nested child")).toThrow();
  actual.unlinkSync(join(lockDir(path), unrelated));
  const second = beginUpdateLockChildJoin(path, owner.id);
  expect(markers(path)).toHaveLength(2);
  first.joined();
  expect(() => owner.setStep("second child still pending")).toThrow("not been joined");
  second.joined();
  owner.setStep("both own children joined");
});

test("reclaim refuses current-child and unrelated markers while accepting only verified ancestor markers", async () => {
  const path = await config(),
    ancestor = take(path, "ancestor");
  const outer = beginUpdateLockChildJoin(path, ancestor.id),
    caller = adopt(path, ancestor, "caller");
  const own = beginUpdateLockChildJoin(path, caller.id),
    child = adopt(path, caller, "child");
  own.joined();
  const unrelated = plant(path, randomUUID());
  expect(caller.reclaim()).toBe(false);
  actual.unlinkSync(join(lockDir(path), unrelated));
  const pendingChild = beginUpdateLockChildJoin(path, child.id);
  expect(caller.reclaim()).toBe(false);
  pendingChild.joined();
  expect(caller.reclaim()).toBe(true);
  caller.handBack();
  outer.joined();
});

test("diagnostic group publication cannot clear evidence until the holder's child joins", async () => {
  const path = await config(),
    lock = take(path);
  const scope = beginUpdateLockChildJoin(path, lock.id);
  lock.setProcessGroup(DEAD - 1);
  lock.setProcessGroup(null);
  expect(JSON.parse(actual.readFileSync(ownerFile(path), "utf8")).processGroupPid).toBe(DEAD - 1);
  scope.joined();
  lock.setProcessGroup(null);
  expect(JSON.parse(actual.readFileSync(ownerFile(path), "utf8"))).not.toHaveProperty(
    "processGroupPid",
  );
});

test("a joined child still cannot be reclaimed while its inherited published group may be alive", async () => {
  const path = await config(),
    collector = take(path, "collector");
  collector.setProcessGroup(DEAD - 2);
  const outer = beginUpdateLockChildJoin(path, collector.id),
    cli = adopt(path, collector, "CLI");
  const inner = beginUpdateLockChildJoin(path, cli.id);
  adopt(path, cli, "continuation");
  inner.joined();
  const kill = process.kill.bind(process);
  const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === 0 && (pid === DEAD - 2 || pid === -(DEAD - 2))) return true;
    return kill(pid, signal);
  });
  expect(cli.reclaim()).toBe(false);
  probe.mockRestore();
  expect(cli.reclaim()).toBe(true);
  cli.handBack();
  outer.joined();
});

test("unknown owner JSON never makes a persisted fence stale or prevents its exact joined scope clearing", async () => {
  const path = await config(),
    lock = take(path);
  const scope = beginUpdateLockChildJoin(path, lock.id);
  actual.writeFileSync(ownerFile(path), "{");
  expect(() => acquireUpdateLock(path, { owner: "another update", now: later })).toThrow(
    UpdateLockBusyError,
  );
  scope.joined();
  expect(markers(path)).toEqual([]);
  expect(actual.readFileSync(ownerFile(path), "utf8")).toBe("{");
});

test("malformed markers block adoption, explicit work, reclaim and retirement", async () => {
  const path = await config(),
    lock = take(path);
  actual.writeFileSync(join(lockDir(path), ".child-join-malformed"), "{}", { mode: 0o600 });
  expect(() => adoptUpdateLock(path, lock.id, { owner: "child" })).toThrow();
  expect(() => lock.setStep("apply")).toThrow();
  expect(lock.reclaim()).toBe(false);
  lock.release();
  expect(() => acquireUpdateLock(path, { owner: "another", now: later })).toThrow(
    UpdateLockBusyError,
  );
});

test("directory listing failure cannot authorize release or stale acquisition", async () => {
  const path = await config(),
    lock = take(path);
  const read = vi.spyOn(fs, "readdirSync").mockImplementation(((
    dir: fs.PathLike,
    ...args: unknown[]
  ) => {
    if (dir === lockDir(path))
      throw Object.assign(new Error("Invented inaccessible lock directory"), { code: "EACCES" });
    return Reflect.apply(actual.readdirSync, actual, [dir, ...args]);
  }) as typeof fs.readdirSync);
  expect(() => lock.setStep("apply")).toThrow();
  expect(lock.reclaim()).toBe(false);
  lock.release();
  expect(() => acquireUpdateLock(path, { owner: "another", now: later })).toThrow(
    UpdateLockBusyError,
  );
  read.mockRestore();
  expect(actual.existsSync(ownerFile(path))).toBe(true);
});

test("an unreadable marker is preserved until the exact scope can verify it again", async () => {
  const path = await config(),
    lock = take(path);
  const scope = beginUpdateLockChildJoin(path, lock.id),
    marker = join(lockDir(path), markers(path)[0]!);
  const refused = Object.assign(new Error("Invented unreadable join marker"), { code: "EACCES" });
  const read =
    process.platform === "win32"
      ? vi
          .spyOn(privateFiles, "readWindowsPrivateFileSync")
          .mockImplementation((target, ...args) => {
            if (target === marker) throw refused;
            return privateFilesOriginal.readWindowsPrivateFileSync(target, ...args);
          })
      : vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
          if (target === marker) throw refused;
          return Reflect.apply(actual.openSync, actual, [target, ...args]);
        }) as typeof fs.openSync);
  expect(() => lock.setStep("apply")).toThrow();
  expect(() => scope.joined()).toThrow();
  expect(actual.existsSync(marker)).toBe(true);
  read.mockRestore();
  scope.joined();
});
const privateFilesOriginal = {
  readWindowsPrivateFileSync: privateFiles.readWindowsPrivateFileSync,
};

test("failed private marker publication prevents launching a child and retains partial uncertainty", async () => {
  const path = await config(),
    lock = take(path);
  const write = (target: fs.PathLike) => {
    actual.writeFileSync(target, "{", { flag: "wx", mode: 0o600 });
    throw new Error("Invented marker write failure");
  };
  if (process.platform === "win32")
    vi.spyOn(privateFiles, "createWindowsPrivateFileSync").mockImplementation((target) =>
      write(target),
    );
  else
    vi.spyOn(fs, "writeFileSync").mockImplementation(((
      target: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (typeof target === "string" && target.includes(".child-join-")) return write(target);
      return Reflect.apply(actual.writeFileSync, actual, [target, ...args]);
    }) as typeof fs.writeFileSync);
  const spawn = vi.fn();
  expect(() => {
    beginUpdateLockChildJoin(path, lock.id);
    spawn();
  }).toThrow("marker write failure");
  expect(spawn).not.toHaveBeenCalled();
  expect(markers(path)).toHaveLength(1);
  expect(() => acquireUpdateLock(path, { owner: "another", now: later })).toThrow(
    UpdateLockBusyError,
  );
});

test("a stale holder cannot reserve a child scope after adoption", async () => {
  const path = await config(),
    parent = take(path);
  adopt(path, parent, "child");
  expect(() => beginUpdateLockChildJoin(path, parent.id)).toThrow("ownership");
  expect(markers(path)).toEqual([]);
});

test("an exact scope never removes a replacement directory generation or another marker object", async () => {
  const path = await config(),
    old = take(path);
  const scope = beginUpdateLockChildJoin(path, old.id),
    name = markers(path)[0]!;
  const saved = join(path, "retained-old-lock");
  actual.renameSync(lockDir(path), saved);
  const replacement = take(path, "replacement");
  actual.copyFileSync(join(saved, name), join(lockDir(path), name));
  const before = actual.readFileSync(ownerFile(path), "utf8");
  expect(() => scope.joined()).toThrow("changed");
  expect(actual.readFileSync(ownerFile(path), "utf8")).toBe(before);
  expect(markers(path)).toEqual([name]);
  expect(replacement.id).not.toBe(old.id);
});

test("a scope refuses a replacement marker even if its contents and filename were copied", async () => {
  const path = await config(),
    lock = take(path);
  const scope = beginUpdateLockChildJoin(path, lock.id),
    name = markers(path)[0]!,
    marker = join(lockDir(path), name);
  actual.renameSync(marker, join(lockDir(path), "retained-original-marker"));
  actual.copyFileSync(join(lockDir(path), "retained-original-marker"), marker);
  expect(() => scope.joined()).toThrow("changed");
  expect(actual.existsSync(marker)).toBe(true);
});

test("generation checks retain exact bigint directory identity beyond JavaScript numeric precision", async () => {
  const path = await config(),
    lock = take(path);
  let inode = 2n ** 63n;
  vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, options?: fs.StatOptions) => {
    if (target === lockDir(path) && options?.bigint)
      return Object.assign(actual.lstatSync(target, { bigint: true }), { ino: inode });
    return actual.lstatSync(target, options);
  }) as typeof fs.lstatSync);
  const scope = beginUpdateLockChildJoin(path, lock.id);
  expect(Number(inode)).toBe(Number(inode + 1n));
  inode += 1n;
  expect(() => scope.joined()).toThrow("changed");
  expect(markers(path)).toHaveLength(1);
});

test("normal process exit cannot remove a pre-launch fence left by that process", async () => {
  const path = await config();
  const require = createRequire(import.meta.url),
    tsx = pathToFileURL(require.resolve("tsx")).href;
  const module = new URL("./update-lock.ts", import.meta.url).href;
  const script = `const m=await import(${JSON.stringify(module)});const lock=m.acquireUpdateLock(process.argv[1],{owner:'owned exiting fixture'});m.beginUpdateLockChildJoin(process.argv[1],lock.id);process.stdout.write(lock.id);`;
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", tsx, "--input-type=module", "-e", script, path],
    { timeout: 20_000 },
  );
  expect(result.stdout).toMatch(/^[a-f0-9-]{36}$/);
  expect(markers(path)).toHaveLength(1);
  expect(() => acquireUpdateLock(path, { owner: "another", now: later })).toThrow(
    UpdateLockBusyError,
  );
});

test("an adopted child exits successfully while hand-back is deferred until its parent joins it", async () => {
  const path = await config(),
    parent = take(path);
  const scope = beginUpdateLockChildJoin(path, parent.id);
  const require = createRequire(import.meta.url),
    tsx = pathToFileURL(require.resolve("tsx")).href;
  const module = new URL("./update-lock.ts", import.meta.url).href;
  const script = `const m=await import(${JSON.stringify(module)});const lock=m.adoptUpdateLock(process.argv[1],process.argv[2],{owner:'owned adopted fixture',returnToHolder:true});lock.setStep('finishing fixture');process.stdout.write(lock.id);`;
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", tsx, "--input-type=module", "-e", script, path, parent.id],
    { timeout: 20_000 },
  );
  expect(result.stdout).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.parse(actual.readFileSync(ownerFile(path), "utf8")).id).toBe(result.stdout);
  expect(parent.reclaim()).toBe(false);
  scope.joined();
  expect(parent.reclaim()).toBe(true);
  parent.release();
  expect(actual.existsSync(lockDir(path))).toBe(false);
});

test.skipIf(process.platform !== "win32")(
  "Windows writes a private marker before an owned child can launch",
  async () => {
    const path = await config(),
      lock = take(path);
    const scope = beginUpdateLockChildJoin(path, lock.id),
      marker = join(lockDir(path), markers(path)[0]!);
    expect(privateFiles.inspectWindowsPrivatePathSync(marker, "file").private).toBe(true);
    scope.joined();
  },
);

// FIFO-open semantics are POSIX-specific; regular-file and identity checks run on every OS.
test.skipIf(process.platform === "win32")(
  "a marker swapped to a FIFO after metadata inspection fails without blocking open",
  async () => {
    const path = await config();
    const require = createRequire(import.meta.url),
      tsx = pathToFileURL(require.resolve("tsx")).href;
    const module = new URL("./update-lock.ts", import.meta.url).href;
    const script = `
    import fs from "node:fs";
    import { execFileSync } from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { basename } from "node:path";
    const m = await import(${JSON.stringify(module)});
    const lock = m.acquireUpdateLock(process.argv[1], { owner: "owned FIFO boundary fixture" });
    const original = fs.lstatSync;
    let inspections = 0, replaced = false, refused = false;
    fs.lstatSync = (target, options) => {
      const stat = original(target, options);
      if (typeof target === "string" && basename(target).startsWith(".child-join-") && ++inspections === 2) {
        fs.unlinkSync(target);
        execFileSync("mkfifo", [target]);
        replaced = true;
      }
      return stat;
    };
    syncBuiltinESMExports();
    try { m.beginUpdateLockChildJoin(process.argv[1], lock.id); }
    catch { refused = true; }
    finally { fs.lstatSync = original; syncBuiltinESMExports(); }
    process.stdout.write(JSON.stringify({ replaced, refused }));
  `;
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", tsx, "--input-type=module", "-e", script, path],
      { timeout: 20_000, killSignal: "SIGKILL" },
    );
    expect(JSON.parse(result.stdout)).toEqual({ replaced: true, refused: true });
  },
);

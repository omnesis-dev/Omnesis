// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createConnection } from "node:net";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { desktopProfile } from "./environment.js";
import {
  desktopDaemonSocket,
  startDesktopDaemonControl,
  stopDesktopDaemon,
} from "./daemon-control.js";

const signal = () => new AbortController().signal;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let home: string;
let control: Awaited<ReturnType<typeof startDesktopDaemonControl>> | undefined;
const finishers: (() => void)[] = [];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "omnesis-control-test-"));
});
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish();
  await control?.close();
  control = undefined;
  if (process.platform !== "win32")
    await rm(dirname(desktopDaemonSocket(desktopProfile(home))), { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("private desktop daemon control", () => {
  test("missing listener reports false without inspecting or signaling a recorded PID", async () => {
    expect(await stopDesktopDaemon(desktopProfile(home), signal())).toBe(false);
  });

  test("acknowledges only after the owner's drain promise resolves", async () => {
    const profile = desktopProfile(home);
    const requested = deferred(),
      drained = deferred();
    finishers.push(drained.resolve);
    control = await startDesktopDaemonControl(profile, {
      stop: requested.resolve,
      drained: drained.promise,
    });
    const socket = desktopDaemonSocket(profile);
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(socket))).mode & 0o777).toBe(0o700);
    let acknowledged = false;
    const stopped = stopDesktopDaemon(profile, signal()).then((result) => {
      acknowledged = true;
      return result;
    });
    await requested.promise;
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    drained.resolve();
    expect(await stopped).toBe(true);
  });

  test("an oversized or unsupported command cannot stop the runtime", async () => {
    const profile = desktopProfile(home);
    const stop = vi.fn();
    control = await startDesktopDaemonControl(profile, { stop, drained: Promise.resolve() });
    for (const command of ["erase\n", "stop\nextra", "stop\r\n"]) {
      await new Promise<void>((resolve) => {
        const socket = createConnection(desktopDaemonSocket(profile), () => socket.write(command));
        socket.on("error", () => {});
        socket.once("close", () => resolve());
      });
    }
    expect(stop).not.toHaveBeenCalled();
  });

  test("cancellation refuses to claim a drain that has not finished", async () => {
    const profile = desktopProfile(home);
    const requested = deferred(),
      drained = deferred();
    finishers.push(drained.resolve);
    control = await startDesktopDaemonControl(profile, {
      stop: requested.resolve,
      drained: drained.promise,
    });
    const caller = new AbortController();
    const stopped = stopDesktopDaemon(profile, caller.signal);
    const rejected = expect(stopped).rejects.toThrow();
    await requested.promise;
    caller.abort();
    await rejected;
    drained.resolve();
  });

  test("socket paths stay short even when the application config path is long", () => {
    const profile = desktopProfile(join(home, "long-directory".repeat(20)));
    expect(Buffer.byteLength(desktopDaemonSocket(profile))).toBeLessThan(104);
    expect(desktopDaemonSocket(profile)).not.toContain("long-directory");
  });

  test("an occupied non-socket or symlink is retained and refused", async () => {
    const profile = desktopProfile(home);
    const path = desktopDaemonSocket(profile);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "unowned-file");
    await expect(
      startDesktopDaemonControl(profile, { stop: () => {}, drained: Promise.resolve() }),
    ).rejects.toThrow(/unowned/);
    expect(await readFile(path, "utf8")).toBe("unowned-file");
    await rm(path);
    const target = join(home, "keep");
    await writeFile(target, "unowned-target");
    await symlink(target, path);
    await expect(
      startDesktopDaemonControl(profile, { stop: () => {}, drained: Promise.resolve() }),
    ).rejects.toThrow(/unowned/);
    expect(await readFile(target, "utf8")).toBe("unowned-target");
  });
});

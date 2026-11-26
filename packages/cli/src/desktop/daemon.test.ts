// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { acquireGatewayLock } from "@omnesis/core";
import {
  runDesktopDaemon,
  type DesktopComponent,
  type DesktopDaemonEvent,
  type DesktopOwnedChild,
  type DesktopChildExit,
} from "./daemon.js";
import { desktopProfile } from "./environment.js";

type Dependencies = NonNullable<Parameters<typeof runDesktopDaemon>[2]>;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(mode: "home" | "joined" = "home") {
  const home = await mkdtemp(join(tmpdir(), "omnesis-desktop-daemon-"));
  roots.push(home);
  const profile = desktopProfile(home);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const events: DesktopDaemonEvent[] = [];
  const observers: {
    component: DesktopComponent;
    state: DesktopDaemonEvent["state"];
    after: number;
    resolve: () => void;
  }[] = [];
  const children: {
    component: DesktopComponent;
    env: NodeJS.ProcessEnv;
    child: DesktopOwnedChild;
    exit: (code?: number) => void;
  }[] = [];
  const kills: string[] = [];
  const waits: { ms: number; resolve: () => void; signal: AbortSignal }[] = [];
  const waitObservers: (() => void)[] = [];
  let now = 0,
    linked = false,
    paired = true,
    pairingStamp = "first-pairing";
  const release = vi.fn();
  const deps = {
    restartIdentity: vi.fn(async () => ({
      deviceId: "00000000-0000-4000-8000-000000000004",
      fingerprint: "fictional-fingerprint",
    })),
    watchProtection: vi.fn(
      async (_profile, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    ),
    remoteProtection: vi.fn<NonNullable<Dependencies["remoteProtection"]>>(async () => "encrypted"),
    mayStartEpoch: vi.fn(async () => true),
    epochBlocked: vi.fn(async () => false),
    claimEpoch: vi.fn(async () => true),
    restoreBlocked: vi.fn(async () => false),
    readInstall: vi.fn(async () => ({
      version: 1 as const,
      owner: "omnesis-desktop" as const,
      mode,
      instance: profile.instance,
      secretService: profile.secretService,
      embedder: null,
      memoryLimitMb: 512,
      phase: "configured" as const,
    })),
    retired: vi.fn(async () => false),
    readRuntime: vi.fn(async () => ({ version: 1 as const, port: 18601 })),
    request: vi.fn(async (_profile, path) =>
      path === "/health" ? { status: "ok" } : { account: { linked } },
    ),
    lock: vi.fn<NonNullable<Dependencies["lock"]>>(async () => ({
      path: join(profile.configDir, "runtime-owner", "gateway.lock"),
      release,
    })),
    encrypted: vi.fn(() => true),
    paired: vi.fn(async () => paired),
    pairingStamp: vi.fn(async () => pairingStamp),
    control: vi.fn<NonNullable<Dependencies["control"]>>(async () => ({ close: async () => {} })),
    now: () => now,
    spawn: vi.fn((component, env) => {
      const exit = deferred<DesktopChildExit>();
      const child: DesktopOwnedChild = {
        collectorReady: Promise.resolve("00000000-0000-4000-8000-000000000004"),
        exited: exit.promise,
        kill: (signal) => {
          kills.push(`${component}:${signal}`);
          exit.resolve({ code: null, signal });
        },
      };
      children.push({
        component,
        env,
        child,
        exit: (code = 1) => exit.resolve({ code, signal: null }),
      });
      return child;
    }),
    sleep: vi.fn(
      (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const remove = () => {
            const index = waits.indexOf(wait);
            if (index >= 0) waits.splice(index, 1);
            signal.removeEventListener("abort", abort);
          };
          const wait = {
            ms,
            signal,
            resolve: () => {
              remove();
              now += ms;
              resolve();
            },
          };
          const abort = () => {
            remove();
            reject(new Error("cancelled fixture wait"));
          };
          if (signal.aborted) {
            reject(new Error("cancelled fixture wait"));
            return;
          }
          waits.push(wait);
          signal.addEventListener("abort", abort, { once: true });
          for (const notify of waitObservers.splice(0)) notify();
        }),
    ),
  } satisfies Dependencies;
  const onEvent = (event: DesktopDaemonEvent) => {
    events.push(event);
    for (const observer of [...observers]) {
      if (
        observer.component === event.component &&
        observer.state === event.state &&
        events.filter((item) => item.component === event.component && item.state === event.state)
          .length > observer.after
      ) {
        observers.splice(observers.indexOf(observer), 1);
        observer.resolve();
      }
    }
  };
  const event = (component: DesktopComponent, state: DesktopDaemonEvent["state"], after = 0) => {
    if (
      events.filter((item) => item.component === component && item.state === state).length > after
    )
      return Promise.resolve();
    return new Promise<void>((resolve) => observers.push({ component, state, after, resolve }));
  };
  const nextWait = async () => {
    while (!waits.some((wait) => wait.ms !== 65000))
      await new Promise<void>((resolve) => waitObservers.push(resolve));
    return waits.find((wait) => wait.ms !== 65000)!;
  };
  return {
    profile,
    controller,
    deps,
    events,
    event,
    children,
    kills,
    release,
    nextWait,
    setLinked: (value: boolean) => {
      linked = value;
    },
    setPaired: (value: boolean) => {
      paired = value;
    },
    setStamp: (value: string) => {
      pairingStamp = value;
    },
    run: (onOwned?: () => void | Promise<void>) =>
      runDesktopDaemon(profile, { signal: controller.signal, onEvent, onOwned }, deps),
  };
}

test("home waits for account and encrypted readiness, then drains only its children in reverse order", async () => {
  const f = await fixture();
  const run = f.run();
  await f.event("collector", "waiting-account");
  expect(f.children.map((child) => child.component)).toEqual(["gateway"]);
  f.setLinked(true);
  (await f.nextWait()).resolve();
  await f.event("collector", "starting");
  expect(f.children.map((child) => child.component)).toEqual(["gateway", "collector"]);
  expect(f.children[1]!.env).toMatchObject({
    OMNESIS_GATEWAY_URL: "https://127.0.0.1:18601",
    OMNESIS_CONFIG_DIR: f.profile.configDir,
    NODE_EXTRA_CA_CERTS: join(f.profile.configDir, "tls", "cert.pem"),
  });
  expect(f.children[1]!.env).not.toHaveProperty("OMNESIS_TOKEN");
  f.controller.abort();
  expect(await run).toBe("stopped");
  expect(f.kills).toEqual(["collector:SIGTERM", "gateway:SIGTERM"]);
  expect(f.release).toHaveBeenCalledOnce();
});

test("collector crash uses backoff without restarting the healthy gateway", async () => {
  const f = await fixture();
  f.setLinked(true);
  const run = f.run();
  await f.event("collector", "starting");
  f.children[1]!.exit();
  await f.event("collector", "restarting");
  (await f.nextWait()).resolve();
  await f.event("collector", "starting", 1);
  expect(f.children.map((child) => child.component)).toEqual(["gateway", "collector", "collector"]);
  f.controller.abort();
  await run;
});

test("account unlink stops collection while leaving the owned home available for reconnection", async () => {
  const f = await fixture();
  f.setLinked(true);
  const run = f.run();
  await f.event("collector", "starting");
  f.setLinked(false);
  (await f.nextWait()).resolve();
  await f.event("collector", "waiting-account");
  expect(f.kills).toEqual(["collector:SIGTERM"]);
  f.controller.abort();
  await run;
});

test("gateway crash drains its collector before starting a fresh owned epoch", async () => {
  const f = await fixture();
  f.setLinked(true);
  const run = f.run();
  await f.event("collector", "starting");
  f.children[0]!.exit();
  await f.event("gateway", "restarting");
  expect(f.kills).toEqual(["collector:SIGTERM"]);
  (await f.nextWait()).resolve();
  await f.event("gateway", "starting", 1);
  await f.event("collector", "starting", 1);
  f.controller.abort();
  await run;
  expect(f.children.filter((child) => child.component === "gateway")).toHaveLength(2);
});

test("joined mode starts no gateway and never starts an unpaired collector", async () => {
  const f = await fixture("joined");
  f.setPaired(false);
  expect(await f.run()).toBe("stopped");
  expect(f.children).toEqual([]);
  expect(f.release).toHaveBeenCalledOnce();
});

test("joined collector crashes get increasing bounded retries and cancellation stops the owned child", async () => {
  const f = await fixture("joined");
  const run = f.run();
  await f.event("collector", "starting");
  f.children[0]!.exit();
  await f.event("collector", "restarting");
  const first = await f.nextWait();
  expect(first.ms).toBe(1000);
  first.resolve();
  await f.event("collector", "starting", 1);
  f.children[1]!.exit();
  await f.event("collector", "restarting", 1);
  const second = await f.nextWait();
  expect(second.ms).toBe(2000);
  f.controller.abort();
  await run;
  expect(f.children.every((child) => child.component === "collector")).toBe(true);
});

test("unprotected configuration and symlinked ownership paths cannot start children", async () => {
  const f = await fixture();
  f.deps.encrypted.mockReturnValue(false);
  await expect(f.run()).rejects.toThrow("encrypted");
  expect(f.deps.spawn).not.toHaveBeenCalled();
  f.deps.encrypted.mockReturnValue(true);
  const other = join(f.profile.configDir, "other");
  await mkdir(other, { mode: 0o700 });
  await symlink(other, join(f.profile.configDir, "runtime-owner"));
  await expect(f.run()).rejects.toThrow("private");
  expect(f.deps.spawn).not.toHaveBeenCalled();
});

test("a real runtime lease refuses a second supervisor without starting another child", async () => {
  const f = await fixture("joined");
  f.deps.lock.mockImplementation(() =>
    acquireGatewayLock(join(f.profile.configDir, "runtime-owner"), { waitMs: 0 }),
  );
  const run = f.run();
  await f.event("collector", "starting");
  expect(await f.run()).toBe("already-running");
  expect(f.children).toHaveLength(1);
  f.controller.abort();
  await run;
});

test("shutdown escalates only its owned handle and awaits its exit before releasing ownership", async () => {
  const f = await fixture("joined");
  const exited = deferred<DesktopChildExit>();
  const signals: NodeJS.Signals[] = [];
  f.deps.spawn.mockImplementation(() => ({
    exited: exited.promise,
    kill: (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") exited.resolve({ code: null, signal });
    },
  }));
  const sleep = f.deps.sleep.getMockImplementation()!;
  f.deps.sleep.mockImplementation((ms, signal) =>
    ms === 65000 ? Promise.resolve() : sleep(ms, signal),
  );
  const run = f.run();
  await f.event("collector", "starting");
  f.controller.abort();
  await run;
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(f.release).toHaveBeenCalledOnce();
});

test("a joined collector's clean stop stays suspended until its pairing changes", async () => {
  const f = await fixture("joined");
  const run = f.run();
  await f.event("collector", "starting");
  f.children[0]!.exit(0);
  await f.event("collector", "stopped");
  (await f.nextWait()).resolve();
  await f.nextWait();
  expect(f.children).toHaveLength(1);
  f.setStamp("replacement-pairing");
  (await f.nextWait()).resolve();
  await f.event("collector", "starting", 1);
  f.controller.abort();
  await run;
});

test("a home collector's clean stop is not treated as a crash", async () => {
  const f = await fixture();
  f.setLinked(true);
  const run = f.run();
  await f.event("collector", "starting");
  f.children[1]!.exit(0);
  await f.event("collector", "stopped");
  (await f.nextWait()).resolve();
  await f.nextWait();
  expect(f.children).toHaveLength(2);
  expect(f.events).not.toContainEqual({ component: "collector", state: "restarting" });
  f.setLinked(false);
  (await f.nextWait()).resolve();
  await f.event("collector", "waiting-account");
  f.setLinked(true);
  (await f.nextWait()).resolve();
  await f.event("collector", "starting", 1);
  f.controller.abort();
  await run;
});

test.skipIf(process.platform === "win32")(
  "private control stop drains owned children before acknowledging and releasing the runtime lease",
  async () => {
    const { startDesktopDaemonControl, stopDesktopDaemon } = await import("./daemon-control.js");
    const f = await fixture();
    f.setLinked(true);
    f.deps.control.mockImplementation(startDesktopDaemonControl);
    const run = f.run();
    await f.event("collector", "starting");
    expect(await stopDesktopDaemon(f.profile, new AbortController().signal)).toBe(true);
    expect(await run).toBe("stopped");
    expect(f.kills).toEqual(["collector:SIGTERM", "gateway:SIGTERM"]);
    expect(f.release).toHaveBeenCalledOnce();
  },
);

test("a retired installation cannot restart before or after the ownership lease", async () => {
  const f = await fixture();
  f.deps.retired.mockResolvedValue(true);
  expect(await f.run()).toBe("stopped");
  expect(f.deps.lock).not.toHaveBeenCalled();
  expect(f.deps.spawn).not.toHaveBeenCalled();
  f.deps.retired.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await f.run()).toBe("stopped");
  expect(f.deps.spawn).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});

test("an update fences daemon startup before and after the runtime ownership lease", async () => {
  const f = await fixture();
  f.deps.mayStartEpoch.mockResolvedValue(false);
  expect(await f.run()).toBe("stopped");
  expect(f.deps.lock).not.toHaveBeenCalled();
  f.deps.mayStartEpoch.mockResolvedValue(true);
  f.deps.claimEpoch.mockResolvedValue(false);
  expect(await f.run()).toBe("stopped");
  expect(f.deps.spawn).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});

test("a joined daemon cannot start collection without fresh remote storage protection", async () => {
  const f = await fixture("joined");
  f.deps.remoteProtection.mockResolvedValue("unprotected");
  const run = f.run();
  await f.event("collector", "waiting-protection");
  expect(f.deps.spawn).not.toHaveBeenCalled();
  f.controller.abort();
  await run;
});

test("losing remote protection drains the collector and rechecks before any replacement", async () => {
  const f = await fixture("joined");
  const lost = deferred<void>();
  f.deps.watchProtection.mockImplementation(async () => lost.promise);
  const run = f.run();
  await f.event("collector", "starting");
  f.deps.remoteProtection.mockResolvedValue("unprotected");
  lost.resolve();
  await f.event("collector", "waiting-protection");
  expect(f.kills).toContain("collector:SIGTERM");
  expect(f.children).toHaveLength(1);
  f.controller.abort();
  await run;
});

test("explicit restore starts only its bound gateway and waits for verified completion before collection", async () => {
  const f = await fixture();
  f.setLinked(true);
  f.deps.restoreBlocked.mockResolvedValue(true);
  const activation = {
    operationId: "00000000-0000-4000-8000-000000000001",
    attemptId: "00000000-0000-4000-8000-000000000002",
    epoch: null,
  };
  const run = runDesktopDaemon(
    f.profile,
    {
      signal: f.controller.signal,
      restoreActivation: activation,
      onEvent: (event) => {
        f.events.push(event);
      },
    },
    f.deps,
  );
  await f.nextWait();
  expect(f.deps.mayStartEpoch).toHaveBeenCalledWith(f.profile, null, activation);
  expect(f.deps.claimEpoch).toHaveBeenCalledWith(
    f.profile,
    expect.any(AbortSignal),
    null,
    activation,
  );
  expect(f.deps.spawn).toHaveBeenCalledWith("gateway", expect.any(Object), activation);
  expect(f.children.map((child) => child.component)).toEqual(["gateway"]);
  f.deps.restoreBlocked.mockResolvedValue(false);
  (await f.nextWait()).resolve();
  await f.nextWait();
  expect(f.deps.spawn).toHaveBeenLastCalledWith("collector", expect.any(Object));
  f.controller.abort();
  await run;
});

test.each(["home", "joined"] as const)(
  "%s collector-only restart preserves gateway and uses existing paired identity",
  async (mode) => {
    const f = await fixture(mode);
    f.setLinked(true);
    const run = f.run();
    await f.event("collector", "starting");
    const request = f.deps.control.mock.calls[0]![1].restartCollector!;
    const pending = request(AbortSignal.timeout(2000));
    await vi.waitFor(() =>
      expect(f.deps.restartIdentity.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    if (mode === "home") (await f.nextWait()).resolve();
    const result = await pending;
    expect(result).toMatchObject({
      kind: "desktopCollectorRestart",
      status: "ready",
      permissionRecheckRequired: true,
    });
    expect(f.kills).toEqual(["collector:SIGTERM"]);
    expect(f.children.filter((child) => child.component === "gateway")).toHaveLength(
      mode === "home" ? 1 : 0,
    );
    expect(f.children.filter((child) => child.component === "collector")).toHaveLength(2);
    expect(f.children.at(-1)!.env.OMNESIS_DESKTOP_COLLECTOR_RESTART).toBe("1");
    f.controller.abort();
    await run;
  },
);

test("restart admission failure leaves the gateway and owned collector running", async () => {
  const f = await fixture("home");
  f.setLinked(true);
  const run = f.run();
  await f.event("collector", "starting");
  f.deps.restartIdentity.mockRejectedValue(new Error("blocked"));
  await expect(
    f.deps.control.mock.calls[0]![1].restartCollector!(AbortSignal.timeout(1000)),
  ).rejects.toThrow("blocked");
  expect(f.kills).toEqual([]);
  expect(f.children).toHaveLength(2);
  f.controller.abort();
  await run;
});

test("collector replacement cannot spawn until the exact old child has exited", async () => {
  const f = await fixture("home");
  f.setLinked(true);
  const run = f.run();
  await f.event("collector", "starting");
  const prior = f.children[1]!;
  const kill = vi.fn();
  prior.child.kill = kill;
  const pending = f.deps.control.mock.calls[0]![1].restartCollector!(AbortSignal.timeout(2000));
  await vi.waitFor(() => expect(f.deps.restartIdentity).toHaveBeenCalledOnce());
  (await f.nextWait()).resolve();
  await vi.waitFor(() => expect(kill).toHaveBeenCalledWith("SIGTERM"));
  expect(f.children).toHaveLength(2);
  prior.exit();
  expect(await pending).toMatchObject({ status: "ready" });
  expect(f.children).toHaveLength(3);
  f.controller.abort();
  await run;
});

test("ownership readiness waits for private control admission and never acknowledges a competing owner", async () => {
  const f = await fixture();
  const ready = vi.fn();
  const gate = deferred<void>();
  const original = f.deps.control.getMockImplementation()!;
  f.deps.control.mockImplementation(async (...args) => {
    await gate.promise;
    return original(...args);
  });
  const running = f.run(ready);
  await vi.waitFor(() => expect(f.deps.control).toHaveBeenCalledOnce());
  expect(ready).not.toHaveBeenCalled();
  expect(f.children).toEqual([]);
  gate.resolve();
  await f.event("gateway", "starting");
  expect(ready).toHaveBeenCalledOnce();
  f.controller.abort();
  await running;
  const second = await fixture();
  second.deps.claimEpoch.mockResolvedValue(false);
  const unclaimed = vi.fn();
  expect(await second.run(unclaimed)).toBe("stopped");
  expect(unclaimed).not.toHaveBeenCalled();
});
test("control listener failure cannot announce ready or spawn components", async () => {
  const f = await fixture();
  f.deps.control.mockRejectedValue(new Error("Invented control refusal"));
  const ready = vi.fn();
  await expect(f.run(ready)).rejects.toThrow("control refusal");
  expect(ready).not.toHaveBeenCalled();
  expect(f.children).toEqual([]);
  expect(f.release).toHaveBeenCalledOnce();
});

test("a lifecycle intent arriving during control setup prevents readiness and all component launches", async () => {
  const f = await fixture();
  const original = f.deps.control.getMockImplementation()!;
  f.deps.control.mockImplementation(async (...args) => {
    f.deps.epochBlocked.mockResolvedValue(true);
    return original(...args);
  });
  const ready = vi.fn();
  expect(await f.run(ready)).toBe("stopped");
  expect(ready).not.toHaveBeenCalled();
  expect(f.children).toEqual([]);
  expect(f.release).toHaveBeenCalledOnce();
});

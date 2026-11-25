// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  acquireGatewayLock,
  GatewayLockHeldError,
  resolveSubprocessEntry,
  secretFileEncryptionRequired,
  storageEncryptionRequired,
  readSecretJsonFile,
  readSecretTextFile,
} from "@omnesis/core";
import { readDesktopInstall } from "./bootstrap.js";
import { desktopEnvironment, type DesktopProfile } from "./environment.js";
import { requestDesktopGateway } from "./gateway-access.js";
import { readDesktopRetirement } from "./retirement.js";
import { desktopRestoreBlocked } from "./restore-intent.js";
import {
  desktopRestoreActivationArguments,
  type DesktopRestoreActivation,
} from "./restore-start-arguments.js";
import { desktopRuntimeEpoch } from "./update-state.js";
import { desktopEpochMayStart } from "./update-admission.js";
import { claimDesktopUpdateEpoch } from "./update-claim.js";
import { probeDesktopRemoteProtection, watchDesktopRemoteProtection } from "./remote-protection.js";
import { startDesktopDaemonControl } from "./daemon-control.js";
import { readDesktopRuntime } from "./runtime-state.js";

export type DesktopComponent = "gateway" | "collector";
export interface DesktopChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
export interface DesktopOwnedChild {
  /** Rejects only when no process was created; resolves on the actual exit event. */
  exited: Promise<DesktopChildExit>;
  kill(signal: NodeJS.Signals): void;
}
export interface DesktopDaemonEvent {
  component: DesktopComponent;
  state: "starting" | "ready" | "waiting-account" | "waiting-protection" | "restarting" | "stopped";
}

interface DaemonDependencies {
  watchProtection: typeof watchDesktopRemoteProtection;
  remoteProtection: typeof probeDesktopRemoteProtection;
  mayStartEpoch: typeof desktopEpochMayStart;
  claimEpoch: typeof claimDesktopUpdateEpoch;
  readInstall: typeof readDesktopInstall;
  restoreBlocked: typeof desktopRestoreBlocked;
  retired(profile: DesktopProfile): Promise<boolean>;
  readRuntime: typeof readDesktopRuntime;
  request: typeof requestDesktopGateway;
  lock: typeof acquireGatewayLock;
  encrypted(profile: DesktopProfile): boolean;
  paired(profile: DesktopProfile): Promise<boolean>;
  pairingStamp(profile: DesktopProfile): Promise<string | null>;
  control: typeof startDesktopDaemonControl;
  spawn(
    component: DesktopComponent,
    env: NodeJS.ProcessEnv,
    restoreActivation?: DesktopRestoreActivation,
  ): DesktopOwnedChild;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

const pairingSchema = z.object({
  kind: z.literal("collector"),
  token: z.string().min(1),
  gatewayUrl: z.string().url(),
});
const accountSchema = z.object({ account: z.object({ linked: z.boolean() }) });
const healthSchema = z.object({ status: z.literal("ok") });
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const STABLE_MS = 60_000;

const defaults: DaemonDependencies = {
  watchProtection: watchDesktopRemoteProtection,
  remoteProtection: probeDesktopRemoteProtection,
  mayStartEpoch: desktopEpochMayStart,
  claimEpoch: claimDesktopUpdateEpoch,
  readInstall: readDesktopInstall,
  restoreBlocked: desktopRestoreBlocked,
  retired: async (profile) => (await readDesktopRetirement(profile)) !== null,
  readRuntime: readDesktopRuntime,
  request: requestDesktopGateway,
  lock: acquireGatewayLock,
  encrypted: (profile) =>
    secretFileEncryptionRequired(profile.configDir) && storageEncryptionRequired(profile.configDir),
  paired: async (profile) => {
    const options = {
      configDir: profile.configDir,
      service: profile.secretService,
      backend: "macos-keychain" as const,
    };
    const value = await readSecretJsonFile(
      join(profile.configDir, "cloud-relay", "collector-device.json"),
      options,
    );
    const token = await readSecretTextFile(join(profile.configDir, "collector-token"), options);
    if (!value || !token) return false;
    const parsed = pairingSchema.safeParse(value);
    return parsed.success && parsed.data.token === token.trim();
  },
  pairingStamp: async (profile) => {
    const token = await readSecretTextFile(join(profile.configDir, "collector-token"), {
      configDir: profile.configDir,
      service: profile.secretService,
      backend: "macos-keychain",
    });
    return token?.trim() ? createHash("sha256").update(token.trim()).digest("hex") : null;
  },
  control: startDesktopDaemonControl,
  spawn: (component, env, restoreActivation) => {
    const entry = resolveSubprocessEntry("./component-process.ts", import.meta.url);
    const child = spawn(
      entry.command,
      [...entry.args, component, ...desktopRestoreActivationArguments(restoreActivation)],
      {
        env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const exited = new Promise<DesktopChildExit>((resolve, reject) => {
      child.on("error", (error) => {
        if (child.pid === undefined) reject(error);
      });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    void exited.catch(() => {});
    return {
      exited,
      kill: (signal) => {
        child.kill(signal);
      },
    };
  },
  sleep: async (ms, signal) => {
    await delay(ms, undefined, { signal });
  },
  now: Date.now,
};

/**
 * Owns only children it spawned and a separate runtime lease. Gateway and collector stores retain
 * their normal ownership locks. The host's collector bootstraps its own scoped token through the
 * existing local admin API, after TLS readiness, encryption and the account prerequisite hold.
 */
export async function runDesktopDaemon(
  profile: DesktopProfile,
  options: {
    signal: AbortSignal;
    restoreActivation?: DesktopRestoreActivation;
    onEvent?(event: DesktopDaemonEvent): void;
  },
  overrides: Partial<DaemonDependencies> = {},
): Promise<"stopped" | "already-running"> {
  const deps = { ...defaults, ...overrides };
  options.signal.throwIfAborted();
  if (await deps.retired(profile)) return "stopped";
  if (!(await deps.mayStartEpoch(profile, desktopRuntimeEpoch(), options.restoreActivation)))
    return "stopped";
  const install = await deps.readInstall(profile);
  if (!install || install.phase !== "configured" || !deps.encrypted(profile)) {
    throw new Error("The desktop installation must be configured and encrypted before starting");
  }
  const owner = join(profile.configDir, "runtime-owner");
  try {
    await mkdir(owner, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const ownerStat = await lstat(owner);
  if (
    !ownerStat.isDirectory() ||
    ownerStat.isSymbolicLink() ||
    (ownerStat.mode & 0o077) !== 0 ||
    (process.getuid && ownerStat.uid !== process.getuid())
  ) {
    throw new Error("The desktop runtime owner folder must be private");
  }
  let lease: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lease = await deps.lock(owner, { signal: options.signal, waitMs: 0 });
  } catch (error) {
    if (error instanceof GatewayLockHeldError) return "already-running";
    throw error;
  }
  const emit = (component: DesktopComponent, state: DesktopDaemonEvent["state"]) =>
    options.onEvent?.({ component, state });
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  let drained!: () => void;
  const stopped = new Promise<void>((resolve) => {
    drained = resolve;
  });
  let control: Awaited<ReturnType<typeof startDesktopDaemonControl>> | undefined;
  try {
    if (await deps.retired(profile)) return "stopped";
    if (!(await deps.claimEpoch(profile, signal, desktopRuntimeEpoch(), options.restoreActivation)))
      return "stopped";
    const current = await deps.readInstall(profile);
    if (
      !current ||
      current.phase !== "configured" ||
      current.mode !== install.mode ||
      !deps.encrypted(profile)
    )
      throw new Error("The desktop installation changed before it could start");
    const runtime = await deps.readRuntime(profile);
    if (!runtime) throw new Error("The desktop runtime port has not been assigned");
    control = await deps.control(profile, { stop: () => stop.abort(), drained: stopped });
    const env = { ...desktopEnvironment(profile), OMNESIS_GATEWAY_PORT: String(runtime.port) };
    if (install.mode === "joined") {
      if (!(await deps.paired(profile))) return "stopped";
      await superviseCollector(profile, env, signal, deps, emit);
    } else {
      let attempt = 0;
      while (!signal.aborted) {
        const started = deps.now();
        try {
          await superviseHome(profile, env, signal, deps, emit, options.restoreActivation);
        } catch {
          if (signal.aborted) break;
        }
        if (signal.aborted) break;
        if (deps.now() - started >= STABLE_MS) attempt = 0;
        emit("gateway", "restarting");
        try {
          await deps.sleep(retryDelay(attempt++), signal);
        } catch {
          break;
        }
      }
    }
    return "stopped";
  } finally {
    drained();
    try {
      await control?.close();
    } finally {
      lease.release();
    }
  }
}

async function superviseHome(
  profile: DesktopProfile,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  deps: DaemonDependencies,
  emit: (component: DesktopComponent, state: DesktopDaemonEvent["state"]) => void,
  restoreActivation?: DesktopRestoreActivation,
): Promise<void> {
  emit("gateway", "starting");
  const gateway = deps.spawn("gateway", env, restoreActivation);
  const lifetime = new AbortController();
  const epoch = AbortSignal.any([signal, lifetime.signal]);
  void gateway.exited.then(
    () => lifetime.abort(),
    () => lifetime.abort(),
  );
  let collector: DesktopOwnedChild | undefined;
  let collectorAttempt = 0;
  let retryAt = 0;
  let collectorStarted = 0;
  let waiting = false;
  let suspended = false;
  let suspendedStamp: string | null | undefined;
  try {
    for (;;) {
      epoch.throwIfAborted();
      try {
        healthSchema.parse(await deps.request(profile, "/health", { signal: epoch }));
        break;
      } catch {
        epoch.throwIfAborted();
        await deps.sleep(RETRY_MIN_MS, epoch);
      }
    }
    emit("gateway", "ready");
    for (;;) {
      epoch.throwIfAborted();
      let linked = false;
      try {
        linked =
          !(await deps.restoreBlocked(profile)) &&
          deps.encrypted(profile) &&
          accountSchema.parse(await deps.request(profile, "/admin/cloud-relay", { signal: epoch }))
            .account.linked;
      } catch {
        epoch.throwIfAborted();
      }
      if (!linked) {
        suspended = false;
        suspendedStamp = undefined;
        if (collector) {
          const previous = collector;
          collector = undefined;
          await stopOwnedChild(previous, deps);
          emit("collector", "stopped");
        }
        if (!waiting) {
          emit("collector", "waiting-account");
          waiting = true;
        }
      } else if (!collector && deps.now() >= retryAt) {
        if (suspended) {
          if (suspendedStamp !== undefined) {
            const stamp = await deps.pairingStamp(profile).catch(() => null);
            if (stamp !== null && stamp !== suspendedStamp) suspended = false;
          }
          if (suspended) {
            await deps.sleep(RETRY_MIN_MS, epoch);
            continue;
          }
        }
        waiting = false;
        emit("collector", "starting");
        const child = deps.spawn("collector", {
          ...env,
          OMNESIS_GATEWAY_URL: `https://127.0.0.1:${env.OMNESIS_GATEWAY_PORT}`,
          NODE_EXTRA_CA_CERTS: join(profile.configDir, "tls", "cert.pem"),
        });
        collector = child;
        collectorStarted = deps.now();
        const finished = async (exit?: DesktopChildExit) => {
          if (collector !== child) return;
          collector = undefined;
          if (exit?.code === 0) {
            suspended = true;
            suspendedStamp = undefined;
            suspendedStamp = await deps.pairingStamp(profile).catch(() => null);
            emit("collector", "stopped");
            return;
          }
          if (deps.now() - collectorStarted >= STABLE_MS) collectorAttempt = 0;
          retryAt = deps.now() + retryDelay(collectorAttempt++);
          emit("collector", "restarting");
        };
        void child.exited.then(finished, () => finished());
      }
      await deps.sleep(RETRY_MIN_MS, epoch);
    }
  } finally {
    lifetime.abort();
    const stops: Promise<void>[] = [];
    if (collector) {
      const previous = collector;
      collector = undefined;
      stops.push(stopOwnedChild(previous, deps).then(() => emit("collector", "stopped")));
    }
    // Both children get their grace period concurrently, within one control deadline.
    stops.push(stopOwnedChild(gateway, deps).then(() => emit("gateway", "stopped")));
    await Promise.all(stops);
  }
}

async function superviseCollector(
  profile: DesktopProfile,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  deps: DaemonDependencies,
  emit: (component: DesktopComponent, state: DesktopDaemonEvent["state"]) => void,
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    if (!deps.encrypted(profile) || !(await deps.paired(profile))) return;
    if ((await deps.remoteProtection(profile, signal)) !== "encrypted") {
      emit("collector", "waiting-protection");
      try {
        await deps.sleep(5_000, signal);
      } catch {
        return;
      }
      continue;
    }
    emit("collector", "starting");
    const child = deps.spawn("collector", env);
    const started = deps.now();
    let onAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    let exit: DesktopChildExit | undefined;
    const monitor = new AbortController();
    const monitorSignal = AbortSignal.any([signal, monitor.signal]);
    let protectionLost = false,
      monitorError: unknown;
    const watched = deps.watchProtection(profile, monitorSignal).then(
      () => {
        if (!monitorSignal.aborted) protectionLost = true;
      },
      (error: unknown) => {
        if (!monitorSignal.aborted) {
          protectionLost = true;
          monitorError = error;
        }
      },
    );
    try {
      exit = await Promise.race([
        child.exited,
        aborted.then(() => undefined),
        watched.then(() => undefined),
      ]);
    } catch {
      /* A failed spawn follows the same bounded restart policy as an exit. */
    } finally {
      signal.removeEventListener("abort", onAbort);
      monitor.abort();
      await Promise.all([stopOwnedChild(child, deps), watched]);
      emit("collector", "stopped");
    }
    if (signal.aborted) return;
    if (monitorError !== undefined) throw monitorError;
    if (protectionLost) {
      emit("collector", "waiting-protection");
      continue;
    }
    if (exit?.code === 0) {
      const stoppedStamp = await deps.pairingStamp(profile).catch(() => null);
      while (!signal.aborted) {
        try {
          await deps.sleep(RETRY_MIN_MS, signal);
        } catch {
          return;
        }
        if (!deps.encrypted(profile)) return;
        const current = await deps.pairingStamp(profile).catch(() => null);
        if (current !== null && current !== stoppedStamp && (await deps.paired(profile))) break;
      }
      continue;
    }
    if (deps.now() - started >= STABLE_MS) attempt = 0;
    emit("collector", "restarting");
    try {
      await deps.sleep(retryDelay(attempt++), signal);
    } catch {
      return;
    }
  }
}

/** Escalation addresses this exact owned handle and always waits for its terminal exit. */
async function stopOwnedChild(child: DesktopOwnedChild, deps: DaemonDependencies): Promise<void> {
  let exited = false;
  const done = child.exited.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  await Promise.resolve();
  if (exited) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* Keep ownership until the actual exit. */
  }
  const deadline = new AbortController();
  try {
    await Promise.race([done, deps.sleep(65_000, deadline.signal)]);
  } finally {
    deadline.abort();
  }
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* An unconfirmed kill is never a terminal exit. */
    }
    await done;
  }
}

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(attempt, 5));
}

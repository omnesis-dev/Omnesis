// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./load-env.js";
import {
  acquireGatewayLock,
  applyPrivateUmask,
  createLogger,
  DEFAULT_CONFIG_DIR,
  ensurePrivateDirSync,
  GATEWAY_SHUTDOWN_BUDGET_MS,
} from "@omnesis/core";
import { HostedProcessLauncher, setProcessLauncher } from "./process-launcher/index.js";
import { resolveTlsBundle } from "./tls.js";
import { startParentWatchdogFromEnv } from "./parent-watchdog.js";
import { StartupManager } from "./startup/manager.js";
import { StartupServer } from "./startup/server.js";
import { StartupOperations } from "./startup/operations.js";

// Keep the application import below listen(): even the boot page must not wait
// for the gateway's dependency graph, stores, or model services to evaluate.
const log = createLogger("gateway:startup");
const startup = new StartupManager();
const controller = new AbortController();
const operations = new StartupOperations();
const listener = new StartupServer(startup);
const launcher = new HostedProcessLauncher();
let runtimeShutdown: ((exitCode?: number) => Promise<void>) | undefined;
let stopping = false;

function stop(): void {
  if (stopping) return;
  stopping = true;
  startup.stop();
  controller.abort();
  if (runtimeShutdown) {
    void runtimeShutdown();
  } else {
    launcher.dispose();
    if (listenerIsOpen()) void listener.shutdown.close(listener.server, 1_000);
    // An initializing worker is awaited before boot unwinds. If a native call
    // cannot return, the same bounded shutdown budget as the runtime applies.
    const timeout = setTimeout(() => process.exit(1), GATEWAY_SHUTDOWN_BUDGET_MS);
    timeout.unref();
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
startParentWatchdogFromEnv(process.env, stop);

let fatalPromise: Promise<never> | undefined;
function fatal(error: unknown): Promise<never> {
  fatalPromise ??= finishFatal(error);
  return fatalPromise;
}
async function finishFatal(error: unknown): Promise<never> {
  for (const step of startup.snapshot().steps) {
    if (step.state === "running") startup.fail(step.id);
  }
  if (!stopping) {
    log.error(
      `Cannot start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  controller.abort();
  const timeout = setTimeout(() => process.exit(1), GATEWAY_SHUTDOWN_BUDGET_MS);
  timeout.unref();
  if (listenerIsOpen()) void listener.shutdown.close(listener.server, 1_000);
  const drainingRuntime = runtimeShutdown?.(stopping ? 0 : 1);
  if (!drainingRuntime) launcher.dispose();
  await operations.drain();
  if (drainingRuntime || runtimeShutdown) {
    await (drainingRuntime ?? runtimeShutdown!(stopping ? 0 : 1));
    process.exit(stopping ? 0 : 1);
  }
  launcher.dispose();
  // Keep install ownership until process exit: partial runtime worker handles
  // may still exist, so releasing the lock here would admit another writer.
  if (listenerIsOpen()) await listener.shutdown.close(listener.server, 1_000);
  process.exit(stopping ? 0 : 1);
}
function listenerIsOpen(): boolean {
  try {
    return listener.server.listening;
  } catch {
    return false;
  }
}
const reportFatal = (error: unknown): void => {
  void fatal(error).catch(() => process.exit(1));
};
process.on("unhandledRejection", reportFatal);
process.on("uncaughtException", reportFatal);

try {
  await operations.track(
    startup.run("launcher", async () => {
      await launcher.start();
      setProcessLauncher(launcher);
    }),
  );
  const configDir = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  applyPrivateUmask();
  ensurePrivateDirSync(configDir);
  const lockWait = process.env.OMNESIS_GATEWAY_LOCK_WAIT_MS;
  const lock = await operations.track(
    startup.run("ownership", () =>
      acquireGatewayLock(configDir, {
        signal: controller.signal,
        waitMs: lockWait !== undefined && /^\d+$/.test(lockWait) ? Number(lockWait) : undefined,
        onWaiting: (holder) =>
          log.warn(
            `Gateway PID ${holder.pid} still owns ${configDir}; waiting for it to exit before opening any store`,
          ),
      }),
    ),
  );
  const rawPort = process.env.OMNESIS_GATEWAY_PORT ?? "7600";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("OMNESIS_GATEWAY_PORT must be a valid TCP port");
  }
  const tls = await operations.track(
    startup.run("tls", () =>
      resolveTlsBundle({
        configDir,
        envCertPath: process.env.OMNESIS_TLS_CERT,
        envKeyPath: process.env.OMNESIS_TLS_KEY,
        envExtraNames: process.env.OMNESIS_TLS_EXTRA_NAMES,
        signal: controller.signal,
      }),
    ),
  );
  controller.signal.throwIfAborted();
  await listener.listen({
    port,
    hostname: process.env.OMNESIS_BIND ?? "0.0.0.0",
    cert: tls.cert,
    key: tls.key,
  });
  listener.server.on("error", (error) => void fatal(error));
  log.info(
    `Startup page listening on HTTPS port ${(listener.server.address() as { port: number }).port}`,
  );
  const runtime = await operations.track(startup.run("runtime", () => import("./runtime.js")));
  await operations.track(
    runtime.startGateway({
      configDir,
      port,
      startedAt: startup.snapshot().startedAt,
      launcher,
      lock,
      tls,
      listener,
      startup,
      signal: controller.signal,
      track: (operation) => operations.track(operation),
      setShutdown(shutdown) {
        runtimeShutdown = shutdown;
        if (stopping) void shutdown();
      },
    }),
  );
} catch (error) {
  await fatal(error);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** The production entrypoint must keep serving the startup page while a real
 * SQLite writer lock prevents schema initialization, then hand the same URL
 * over to the authenticated portal without a second listener. */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { acquireGatewayLock, SCOPE_ADMIN, SCOPE_READ } from "@omnesis/core";
import { createDatabase } from "@omnesis/gateway/src/db.js";
import { createDevice } from "@omnesis/gateway/src/data/repositories/DeviceRepository.js";
import { createToken } from "@omnesis/gateway/src/data/repositories/TokenRepository.js";
import { LATEST_SCHEMA_VERSION } from "@omnesis/gateway/src/data/schema-version.js";
import type { StartupSnapshot } from "@omnesis/gateway/src/startup/manager.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";

const ROOT = join(import.meta.dirname, "../../../..");
const BOOT_BUDGET = gatewayBootBudgetMs();
const PROGRESS_PATH = "/.well-known/omnesis-startup";
const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.CI) {
  throw new Error("gateway-startup.e2e: Chromium is required in CI");
}

interface GatewayProcess {
  child: ChildProcess;
  port: number;
  output(): string;
  exited: Promise<number | null>;
}

interface Exchange {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Isolated self-signed gateway; never changes the runner's global TLS policy. */
async function exchange(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        rejectUnauthorized: false,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode!, headers: response.headers, body }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.setTimeout(2_000, () =>
      request.destroy(new Error("Isolated gateway request timed out")),
    );
    request.end(options.body);
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (port < 17_601) throw new Error("The startup fixture needs an isolated high port");
  return port;
}

const gateways: GatewayProcess[] = [];
const fixtures: Array<{ dir: string; close(): void }> = [];
let browser: Browser | undefined;
let context: BrowserContext | undefined;

async function fixture(options: { gate?: boolean; invalidConfig?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-startup-e2e-"));
  await writeFile(join(dir, "omnesis.json"), options.invalidConfig ? "{invalid" : "{}");
  const db = createDatabase(join(dir, "omnesis.db"));
  const device = createDevice(db, { name: "Startup fixture", kind: "cli" });
  const { token } = createToken(db, device.id, [SCOPE_ADMIN, SCOPE_READ]);
  // The head migration is idempotent: keep the current schema but replay its
  // version stamp so this is a real upgrade boot with committed progress.
  db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(LATEST_SCHEMA_VERSION);
  db.pragma(`user_version = ${LATEST_SCHEMA_VERSION - 1}`);
  let gated = options.gate === true;
  if (gated) db.exec("BEGIN IMMEDIATE");
  const release = (): void => {
    if (!gated) return;
    db.exec("ROLLBACK");
    gated = false;
  };
  fixtures.push({
    dir,
    close: () => {
      release();
      if (db.open) db.close();
    },
  });
  return { dir, db, token, release };
}

async function launch(dir: string, requestedPort?: number): Promise<GatewayProcess> {
  const port = requestedPort ?? (await freePort());
  // Eliminate inherited live credentials, addresses and feature flags. Keep
  // host admission/Herdr environment untouched, as the normal harness does.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("OMNESIS_")),
  );
  const command = e2eTsxCommand("packages/gateway/src/index.ts");
  const child = spawn(command.command, command.args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: e2eGatewayEnv({
      ...inherited,
      OMNESIS_CONFIG_DIR: dir,
      OMNESIS_DB_PATH: join(dir, "omnesis.db"),
      OMNESIS_INDEX_DB_PATH: join(dir, "index.db"),
      OMNESIS_ANALYTICS_DB_PATH: join(dir, "analytics.db"),
      OMNESIS_GATEWAY_PORT: String(port),
      OMNESIS_BIND: "127.0.0.1",
      OMNESIS_SECRET_STORE: "file",
      OMNESIS_MDNS_DISABLE: "1",
      OMNESIS_PARENT_PID: String(process.pid),
      OMNESIS_LOG_LEVEL: "info",
    }),
  });
  registerSubprocessGroup(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += String(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => (output += String(chunk)));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const gateway = { child, port, exited, output: () => output };
  gateways.push(gateway);
  return gateway;
}

async function waitFor<T>(
  gateway: GatewayProcess,
  predicate: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + BOOT_BUDGET;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) {
      throw new Error(`Gateway exited while waiting for ${label}:\n${gateway.output()}`);
    }
    try {
      const result = await predicate();
      if (result !== undefined) return result;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/(ECONNREFUSED|ECONNRESET|socket hang up|timed out)/i.test(error.message)
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}:\n${gateway.output()}`);
}

async function progress(gateway: GatewayProcess): Promise<StartupSnapshot> {
  const response = await exchange(gateway.port, PROGRESS_PATH);
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  return JSON.parse(response.body) as StartupSnapshot;
}

async function waitForStorage(gateway: GatewayProcess): Promise<StartupSnapshot> {
  return waitFor(
    gateway,
    async () => {
      const state = await progress(gateway);
      return state.steps.find((step) => step.id === "storage")?.state === "running"
        ? state
        : undefined;
    },
    "the production database initializer",
  );
}

async function waitForReady(gateway: GatewayProcess): Promise<void> {
  await waitFor(
    gateway,
    async () => ((await exchange(gateway.port, "/health")).status === 200 ? true : undefined),
    "gateway readiness",
  );
}

afterEach(async () => {
  await context?.close();
  await browser?.close();
  context = undefined;
  browser = undefined;
  // Release our own SQLite lock before process cleanup, so an initializer
  // blocked inside SQLite can settle rather than wait out its busy timeout.
  for (const fixture of fixtures) fixture.close();
  for (const gateway of gateways) await killSubprocessGroup(gateway.child);
  for (const fixture of fixtures) await rm(fixture.dir, { recursive: true, force: true });
  fixtures.length = 0;
  gateways.length = 0;
}, BOOT_BUDGET);

describe("gateway startup through its production entrypoint", () => {
  test(
    "serves progress during real schema contention, then opens the originally requested portal route",
    async () => {
      const world = await fixture({ gate: true });
      // Launching the browser before the native lock is awaited avoids turning
      // browser installation/cold launch time into SQLite busy-timeout pressure.
      if (browserAvailable) {
        browser = await chromium.launch();
        context = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: "dark" });
      }
      const gateway = await launch(world.dir);
      const initial = await waitForStorage(gateway);
      expect(initial.state).toBe("starting");
      expect(initial.steps.find((step) => step.id === "workers")?.state).toBe("pending");
      const page = await context?.newPage();
      const destination = `/portal/settings/models?startup-fixture=fictional&token=${world.token}#saved-position`;
      const documentRequests: string[] = [];
      page?.on("request", (request) => {
        if (request.resourceType() === "document") documentRequests.push(request.url());
      });
      if (page) {
        await page.goto(`https://127.0.0.1:${gateway.port}${destination}`, {
          waitUntil: "domcontentloaded",
        });
        await expect
          .poll(() => page.locator("#startup-title").textContent(), { timeout: BOOT_BUDGET })
          .toMatch(/gateway is starting up/i);
      }
      if (page) {
        await page
          .locator("#startup-steps li[data-state=running]")
          .first()
          .waitFor({ timeout: BOOT_BUDGET });
        await page.screenshot({
          path: join(tmpdir(), "omnesis-gateway-startup-boot.png"),
          fullPage: true,
        });
      }
      const bootDocument = await exchange(gateway.port, "/any/original/location?fictional=one", {
        headers: { accept: "text/html" },
      });
      expect(bootDocument.status).toBe(200);
      expect(bootDocument.body).toContain("gateway is starting up");
      expect(bootDocument.headers["referrer-policy"]).toBe("no-referrer");
      expect(bootDocument.headers["content-security-policy"]).not.toContain("unsafe-inline");
      for (const [path, method] of [
        ["/health", "GET"],
        ["/portal/api/session", "GET"],
        ["/search", "POST"],
      ]) {
        const response = await exchange(gateway.port, path, { method });
        expect(response.status).toBe(503);
        expect(JSON.parse(response.body)).toMatchObject({ code: "GATEWAY_STARTING" });
        expect(response.headers["retry-after"]).toBe("1");
      }
      // These responses cannot wait for the blocked schema worker to finish.
      for (let read = 0; read < 3; read++) {
        const state = await progress(gateway);
        expect(state.bootId).toBe(initial.bootId);
        expect(state.steps.find((step) => step.id === "storage")?.state).toBe("running");
      }
      world.release();
      await waitForReady(gateway);
      const ready = await progress(gateway);
      expect(ready.state).toBe("ready");
      expect(ready.steps.find((step) => step.id === "storage")).toMatchObject({
        state: "succeeded",
        progress: { total: 1, completed: 1 },
      });
      expect(world.db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(
        world.db
          .prepare("SELECT version FROM schema_migrations WHERE version = ?")
          .get(LATEST_SCHEMA_VERSION),
      ).toMatchObject({ version: LATEST_SCHEMA_VERSION });
      expect((await exchange(gateway.port, "/admin/devices")).status).toBe(401);
      expect(
        (
          await exchange(gateway.port, "/admin/devices", {
            headers: { authorization: `Bearer ${world.token}` },
          })
        ).status,
      ).toBe(200);
      expect(JSON.parse((await exchange(gateway.port, "/portal/api/session")).body)).toMatchObject({
        authenticated: false,
      });
      if (page) {
        await page.waitForFunction(
          () => (document.getElementById("app")?.childElementCount ?? 0) > 0,
          undefined,
          { timeout: BOOT_BUDGET },
        );
        const final = new URL(page.url());
        expect(final.pathname).toBe("/portal/settings/models");
        expect(final.searchParams.get("startup-fixture")).toBe("fictional");
        expect(final.hash).toBe("#saved-position");
        expect(final.searchParams.has("token")).toBe(false);
        expect(documentRequests).toHaveLength(2);
        expect(new URL(documentRequests[1]).searchParams.get("token")).toBe(world.token);
        const session = await page.evaluate(() =>
          fetch("/portal/api/session").then((response) => response.json()),
        );
        expect(session).toMatchObject({ authenticated: true });
        await page.locator(".models-overview").waitFor({ timeout: BOOT_BUDGET });
        await page.screenshot({
          path: join(tmpdir(), "omnesis-gateway-startup-portal.png"),
          fullPage: true,
        });
      }
    },
    BOOT_BUDGET * 2,
  );

  test(
    "SIGTERM during database initialization exits without leaving ownership or a live listener",
    async () => {
      const world = await fixture({ gate: true });
      const gateway = await launch(world.dir);
      await waitForStorage(gateway);
      const owner = JSON.parse(readFileSync(join(world.dir, "gateway.lock"), "utf8")) as {
        pid: number;
      };
      // Signal the actual gateway, not its tsx wrapper or unrelated services.
      process.kill(owner.pid, "SIGTERM");
      expect(await gateway.exited).toBe(0);
      await expect(exchange(gateway.port, PROGRESS_PATH)).rejects.toThrow();
      world.release();
      const replacement = await launch(world.dir, gateway.port);
      await waitForReady(replacement);
      expect((await progress(replacement)).state).toBe("ready");
      expect(replacement.output()).not.toContain("already owns this configuration directory");
    },
    BOOT_BUDGET * 2,
  );

  test(
    "invalid configuration exits nonzero and closes the early listener",
    async () => {
      const world = await fixture({ invalidConfig: true });
      const gateway = await launch(world.dir);
      expect(await gateway.exited).toBe(1);
      expect(gateway.output()).toContain("Cannot start:");
      expect(gateway.output()).toContain("Startup page listening");
      await expect(exchange(gateway.port, PROGRESS_PATH)).rejects.toThrow();
    },
    BOOT_BUDGET,
  );
  test(
    "SIGTERM cancels ownership waiting without later claiming the directory",
    async () => {
      const world = await fixture();
      const port = await freePort();
      const owner = await acquireGatewayLock(world.dir);
      try {
        const gateway = await launch(world.dir, port);
        await waitFor(
          gateway,
          async () => (gateway.output().includes("still owns") ? true : undefined),
          "the second gateway to wait for install ownership",
        );
        // The test owns the first lease. Signal only the waiting process group,
        // whose bootstrap has not yet opened a listener or database handle.
        process.kill(-gateway.child.pid!, "SIGTERM");
        expect(await gateway.exited).toBe(0);
        expect(gateway.output()).not.toContain("Startup page listening");
        expect(gateway.output()).not.toContain("Analytics DB opened");
      } finally {
        owner.release();
      }
      const replacement = await launch(world.dir, port);
      await waitForReady(replacement);
      expect((await progress(replacement)).state).toBe("ready");
    },
    BOOT_BUDGET * 2,
  );
});

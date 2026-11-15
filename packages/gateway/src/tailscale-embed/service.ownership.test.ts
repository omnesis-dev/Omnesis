// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { TailscaleEmbedService } from "./service.js";
import { HelperSupervisor } from "./supervisor.js";
import { OptionalServiceCleanup } from "../optional-service-cleanup.js";
import { OwnedProcessShutdownFence } from "../owned-process-shutdown-fence.js";

const socket = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./socket-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./socket-server.js")>()),
  startTailnetSocketServer: socket.open,
}));
vi.mock("../tls-lifecycle/persistence.js", () => ({
  readTlsPrivateKey: async () => "invented-key",
}));
const dirs: string[] = [];
afterEach(() => {
  socket.open.mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "tailnet-owner-"));
  dirs.push(dir);
  writeFileSync(join(dir, "cert.pem"), "invented-certificate");
  const supervisor = new HelperSupervisor();
  const start = vi.spyOn(supervisor, "start").mockResolvedValue();
  const stop = vi.spyOn(supervisor, "stop").mockResolvedValue();
  const close = vi.fn(async () => {});
  const endpoint = { path: "invented-private-endpoint", close, closedConfirmed: false };
  close.mockImplementation(async () => {
    endpoint.closedConfirmed = true;
  });
  socket.open.mockResolvedValue(endpoint);
  const service = new TailscaleEmbedService({
    configDir: dir,
    supervisor,
    resolveBinary: () => ({ path: "invented-helper" }),
    tlsMaterial: () => ({ cert: join(dir, "cert.pem"), key: "invented-key" }),
    joins: { notifyWaiting: () => {}, notifyJoined: () => {} },
    env: {},
  });
  await service.attach({ listener: (_req, res) => res.end() });
  await service.setEnabled(true);
  return { service, supervisor, start, stop, close, endpoint };
}

test("gateway shutdown closes admission and waits for the independent helper join", async () => {
  const { service, stop, close } = await boot();
  const closure = Promise.withResolvers<void>();
  stop.mockReturnValue(closure.promise);
  const owner = new OptionalServiceCleanup("Tailnet fixture", () => service);
  const release = vi.fn();
  const exit = vi.fn((): never => {
    throw new Error("invented exit sentinel");
  });
  const review = vi.fn(() => new Promise<never>(() => {}));
  const fence = new OwnedProcessShutdownFence(vi.fn(), [owner], review);
  // Closing is also owned when the actor has no running child yet.
  const closing = service.close();
  const finishing = fence.finish(exit).catch((error: unknown) => error);
  expect(service.close()).toBe(closing);
  await Promise.resolve();
  await Promise.resolve();
  fence.releaseLock({ release });
  expect(ownedProcessCleanupReceipt(service.cleanupFailure())?.pending).toBe(true);
  expect(release).not.toHaveBeenCalled();
  await expect(service.setEnabled(true)).rejects.toThrow(/shutting down/);
  expect(() => service.signIn()).toThrow(/shutting down/);
  closure.resolve();
  await closing;
  // The fence saw a pending receipt and joins its retained closure proof.
  await finishing;
  expect(close).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(service.cleanupFailure()).toBeUndefined();
  expect(review).not.toHaveBeenCalled();
  expect(exit).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

test.each([undefined, new Error("invented socket closure failure")])(
  "a failed socket close still stops the helper and retains terminal ownership (%s)",
  async (failure) => {
    const { service, stop, close } = await boot();
    const error = Object.assign(new Error("invented unconfirmed socket close"), {
      cleanupFailure: failure,
    });
    close.mockRejectedValue(error);
    await expect(service.shutdown()).rejects.toBe(error);
    expect(stop).toHaveBeenCalledOnce();
    expect(ownedProcessCleanupReceipt(service.cleanupFailure())).toEqual({
      failure,
      pending: false,
    });
    await expect(service.setEnabled(false)).rejects.toHaveProperty("cleanupFailure", failure);
    expect(close).toHaveBeenCalledOnce();
  },
);

test("an ordinary joined helper failure does not become cleanup uncertainty", async () => {
  const { service, stop, close } = await boot();
  const error = new Error("invented already-joined helper error");
  stop.mockRejectedValue(error);
  await expect(service.shutdown()).rejects.toBe(error);
  expect(close).toHaveBeenCalledOnce();
  expect(service.cleanupFailure()).toBeUndefined();
});

test("disabling closes the private listener despite failed helper cleanup", async () => {
  const { service, stop, close } = await boot();
  const error = Object.assign(new Error("invented uncertain helper"), {
    cleanupFailure: undefined,
  });
  stop.mockRejectedValue(error);
  await expect(service.setEnabled(false)).rejects.toBe(error);
  expect(close).toHaveBeenCalledOnce();
  expect(ownedProcessCleanupReceipt(service.cleanupFailure())?.pending).toBe(false);
  expect(service.state().helper.state).toBe("unavailable");
});

test("a confirmed listener can be replaced after ordinary path cleanup fails", async () => {
  const { service, endpoint, close } = await boot();
  endpoint.closedConfirmed = true;
  const error = new Error("invented joined path cleanup failure");
  close.mockRejectedValue(error);
  await expect(service.setEnabled(false)).rejects.toBe(error);
  expect(service.cleanupFailure()).toBeUndefined();
  await service.setEnabled(true);
  expect(socket.open).toHaveBeenCalledTimes(2);
});

test("an unmarked listener rejection without closure proof still retains ownership", async () => {
  const { service, stop, close } = await boot();
  const error = new Error("invented listener failure before closure");
  close.mockRejectedValue(error);
  await expect(service.shutdown()).rejects.toHaveProperty("cleanupFailure", error);
  expect(stop).toHaveBeenCalledOnce();
  expect(ownedProcessCleanupReceipt(service.cleanupFailure())).toEqual({
    failure: error,
    pending: false,
  });
});

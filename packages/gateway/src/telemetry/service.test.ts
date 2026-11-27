// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../config-store.js";
import { InstallationTelemetry, type TelemetryPayload } from "./service.js";

const DAY = 24 * 60 * 60 * 1000;

describe("installation telemetry lifecycle", () => {
  let directory: string;
  let store: ConfigStore;
  let service: InstallationTelemetry | undefined;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-telemetry-"));
    store = new ConfigStore({ filePath: join(directory, "omnesis.json") });
    await store.load();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
  });
  afterEach(async () => {
    service?.stop();
    store.stop();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  async function create(
    send = vi.fn(async (_payload: TelemetryPayload, _signal: AbortSignal) => {}),
    env: NodeJS.ProcessEnv = {},
    version = "0.1.0",
  ) {
    service = new InstallationTelemetry({
      configDir: directory,
      configStore: store,
      version,
      transport: { send },
      env,
      random: () => 0,
      commit: async () => "custom",
    });
    await service.start();
    return send;
  }

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    // Real filesystem work completes outside the fake timer loop.
    await vi.waitFor(async () => {
      const attempt = await readFile(join(directory, "telemetry-last-attempt-v1"), "utf8").catch(
        () => "",
      );
      expect(Number(attempt)).toBeGreaterThan(0);
    });
    await vi.advanceTimersByTimeAsync(1);
  }

  it("sends only after the first notice and a grace period, with exactly the census fields", async () => {
    const send = await create();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(send).not.toHaveBeenCalled();
    await store.patch({ telemetry: { acknowledged: true } });
    await advance(60_000);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(Object.keys(send.mock.calls[0]![0]).sort()).toEqual(
      [
        "schemaVersion",
        "installationId",
        "gatewayVersion",
        "gitCommit",
        "os",
        "arch",
        "period",
      ].sort(),
    );
    expect(send.mock.calls[0]![0]).toMatchObject({
      schemaVersion: 1,
      period: "2026-11",
      gatewayVersion: "0.1.0",
      gitCommit: "custom",
    });
  });

  it("displaying the portal notice offers opt-out without requiring Agree", async () => {
    const send = await create();
    await store.patch({ telemetry: { noticeShown: true } });
    await advance(60_000);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(store.get().telemetry?.acknowledged).not.toBe(true);
  });

  it("accepts an installer notice without resetting portal acknowledgement", async () => {
    await writeFile(join(directory, "telemetry-notice-v1"), "1", { mode: 0o600 });
    const send = await create();
    await advance(60_000);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(store.get().telemetry?.acknowledged).not.toBe(true);
  });

  it("persists cadence across restart and keeps outages out of the gateway lifecycle", async () => {
    await store.patch({ telemetry: { acknowledged: true } });
    const send = vi.fn(async (_payload: TelemetryPayload, _signal: AbortSignal) => {
      throw new Error("unavailable");
    });
    await create(send);
    await advance(60_000);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    service!.stop();
    await create(send, {}, "0.2.0");
    await vi.advanceTimersByTimeAsync(DAY - 1_000);
    expect(send).toHaveBeenCalledOnce();
    await advance(1_000);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].installationId).toBe(send.mock.calls[0]![0].installationId);
    expect(send.mock.calls[1]![0].gatewayVersion).toBe("0.2.0");
    expect(await readFile(join(directory, "telemetry-last-attempt-v1"), "utf8")).toMatch(/^\d+$/);
  });

  it("disabling aborts an in-flight request and removes future work; re-enabling schedules again", async () => {
    await store.patch({ telemetry: { acknowledged: true } });
    let signal: AbortSignal | undefined;
    const send = vi.fn(async (_payload: TelemetryPayload, requestSignal: AbortSignal) => {
      signal = requestSignal;
      await new Promise<void>((resolve) =>
        requestSignal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    await create(send);
    await advance(60_000);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await store.patch({ telemetry: { enabled: false } });
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(send).toHaveBeenCalledOnce();
    await store.patch({ telemetry: { enabled: true } });
    await advance(1);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });

  it("environment off wins over acknowledged enabled config", async () => {
    await store.patch({ telemetry: { enabled: true, acknowledged: true } });
    const send = await create(undefined, { OMNESIS_TELEMETRY: "off" });
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(send).not.toHaveBeenCalled();
  });

  it("unrelated configuration changes neither postpone reports nor abort their request", async () => {
    await store.patch({ telemetry: { acknowledged: true } });
    let signal: AbortSignal | undefined;
    const send = vi.fn(async (_payload: TelemetryPayload, requestSignal: AbortSignal) => {
      signal = requestSignal;
      await new Promise<void>((resolve) =>
        requestSignal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    await create(send);
    await vi.advanceTimersByTimeAsync(30_000);
    await store.patch({ releaseCheck: false });
    await advance(30_000);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await store.patch({ releaseCheck: true });
    expect(signal?.aborted).toBe(false);
    await store.patch({ telemetry: { enabled: false } });
    expect(signal?.aborted).toBe(true);
  });

  it("an opt-out during asynchronous payload preparation fences the final transport call", async () => {
    await store.patch({ telemetry: { acknowledged: true } });
    let resolveCommit: ((value: string) => void) | undefined;
    const commit = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCommit = resolve;
        }),
    );
    const send = vi.fn(async () => {});
    service = new InstallationTelemetry({
      configDir: directory,
      configStore: store,
      version: "0.1.0",
      transport: { send },
      env: {},
      random: () => 0,
      commit,
    });
    await service.start();
    await advance(60_000);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    await store.patch({ telemetry: { enabled: false } });
    resolveCommit!("custom");
    await vi.advanceTimersByTimeAsync(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("aborts before slower runtime configuration listeners reconcile", async () => {
    await store.patch({ telemetry: { acknowledged: true } });
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    service = new InstallationTelemetry({
      configDir: directory,
      configStore: store,
      version: "0.1.0",
      transport: {
        send: async (_payload, pendingSignal) => {
          signal = pendingSignal;
          await new Promise<void>((resolve) =>
            pendingSignal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      },
      env: {},
      random: () => 0,
      commit: async () => "custom",
    });
    const unsubscribe = store.onChange(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      await service.start();
      await advance(60_000);
      await vi.waitFor(() => expect(signal).toBeDefined());
      await store.patch({ telemetry: { enabled: false } });
      expect(signal?.aborted).toBe(true);
    } finally {
      release?.();
      unsubscribe();
    }
  });
});

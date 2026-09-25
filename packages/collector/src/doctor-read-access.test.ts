// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { DoctorReadAccess } from "./doctor-read-access.js";
import type { SourceReadAccessResult } from "@omnesis/source-sdk";

afterEach(() => vi.useRealTimers());

test("probes afresh after revocation and recovery without invoking sync", async () => {
  let status: SourceReadAccessResult["status"] = "readable";
  const instance = { probeReadAccess: vi.fn(async () => ({ status })), sync: vi.fn() };
  const sources = [{ sourceId: "demo-files:local", instance }];
  const runner = new DoctorReadAccess();
  for (const next of ["readable", "denied", "readable"] as const) {
    status = next;
    expect(await runner.collect(sources, new AbortController().signal)).toEqual([
      { sourceId: "demo-files:local", status: next },
    ]);
  }
  expect(instance.probeReadAccess).toHaveBeenCalledTimes(3);
  expect(instance.sync).not.toHaveBeenCalled();
});

test("unsupported and thrown probes never claim access or expose exception paths", async () => {
  const runner = new DoctorReadAccess();
  const results = await runner.collect(
    [
      { sourceId: "demo-cloud:local", instance: {} },
      {
        sourceId: "demo-files:local",
        instance: {
          probeReadAccess: async () => {
            throw new Error("/private/fixture/input");
          },
        },
      },
    ],
    new AbortController().signal,
  );
  expect(results.map((result) => result.status)).toEqual(["unsupported", "unavailable"]);
  expect(JSON.stringify(results)).not.toContain("/private");
});

test("timeouts abort providers and prevent overlapping retries until late work settles", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<SourceReadAccessResult>();
  let captured: AbortSignal | undefined;
  const instance = {
    probeReadAccess: vi.fn(({ signal }: { signal: AbortSignal }) => {
      captured = signal;
      return gate.promise;
    }),
  };
  const sources = [{ sourceId: "demo-files:local", instance }];
  const runner = new DoctorReadAccess({ probeMs: 10, scanMs: 50 });
  const result = runner.collect(sources, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(11);
  expect(await result).toEqual([{ sourceId: "demo-files:local", status: "unavailable" }]);
  expect(captured?.aborted).toBe(true);
  expect(await runner.collect(sources, new AbortController().signal)).toEqual(await result);
  expect(instance.probeReadAccess).toHaveBeenCalledTimes(1);
  gate.resolve({ status: "readable" });
  await vi.advanceTimersByTimeAsync(0);
  expect(await runner.collect(sources, new AbortController().signal)).toEqual([
    { sourceId: "demo-files:local", status: "readable" },
  ]);
});

test("total deadline bounds concurrency and leaves unstarted sources unverified", async () => {
  vi.useFakeTimers();
  const probe = vi.fn(() => new Promise<SourceReadAccessResult>(() => {}));
  const sources = Array.from({ length: 7 }, (_, index) => ({
    sourceId: `demo-files:fixture-${index}`,
    instance: { probeReadAccess: probe },
  }));
  const runner = new DoctorReadAccess({ probeMs: 100, scanMs: 10 });
  const result = runner.collect(sources, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(11);
  expect(probe).toHaveBeenCalledTimes(2);
  expect((await result).every((entry) => entry.status === "unavailable")).toBe(true);
  const sibling = vi.fn(async (): Promise<SourceReadAccessResult> => ({ status: "readable" }));
  expect(
    await runner.collect(
      [{ sourceId: "demo-files:new", instance: { probeReadAccess: sibling } }],
      new AbortController().signal,
    ),
  ).toEqual([{ sourceId: "demo-files:new", status: "unavailable" }]);
  expect(sibling).not.toHaveBeenCalled();
});

test("caller cancellation stops pending work without starting additional probes", async () => {
  const controller = new AbortController();
  controller.abort();
  const probe = vi.fn(async (): Promise<SourceReadAccessResult> => ({ status: "readable" }));
  const result = await new DoctorReadAccess().collect(
    [{ sourceId: "demo-files:local", instance: { probeReadAccess: probe } }],
    controller.signal,
  );
  expect(result[0]?.status).toBe("unavailable");
  expect(probe).not.toHaveBeenCalled();
});

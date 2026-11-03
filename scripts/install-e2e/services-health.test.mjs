// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { captureServices, waitUnchangedHealthy } from "./services-health.mjs";

const baseline = [
  { component: "gateway", pid: 100, started: "fixture-gateway-start" },
  { component: "collector", pid: 200, started: "fixture-collector-start" },
];

function fixture({ health, services = async () => baseline, timeoutMs = 10_000 } = {}) {
  let time = 0;
  const readServices = vi.fn(services);
  const readHealth = vi.fn(health ?? (async () => {}));
  const sleep = vi.fn(async (ms) => {
    time += ms;
  });
  return {
    readServices,
    readHealth,
    sleep,
    run: () =>
      waitUnchangedHealthy(baseline, {
        readServices,
        readHealth,
        sleep,
        timeoutMs,
        now: () => time,
      }),
    advance: (ms) => {
      time += ms;
    },
  };
}

describe("dry-run services and health", () => {
  it("recovers slow health only while the same two processes remain running", async () => {
    const f = fixture();
    f.readHealth
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new Error("health timed out"));
    await f.run();
    expect(f.readHealth).toHaveBeenCalledTimes(3);
    expect(f.readServices).toHaveBeenCalledTimes(6);
    expect(f.sleep).toHaveBeenCalledTimes(2);
  });

  it.each(["gateway", "collector"])(
    "refuses a changed %s PID even when health succeeds",
    async (component) => {
      const f = fixture();
      f.readServices
        .mockResolvedValueOnce(baseline)
        .mockResolvedValue(
          baseline.map((s) => (s.component === component ? { ...s, pid: s.pid + 1 } : s)),
        );
      await expect(f.run()).rejects.toThrow(`${component} process changed`);
      expect(f.readHealth).toHaveBeenCalledTimes(1);
      expect(f.sleep).not.toHaveBeenCalled();
    },
  );

  it("rejects PID reuse with a different process start identity", async () => {
    const f = fixture({
      services: async () => [{ ...baseline[0], started: "replacement-start" }, baseline[1]],
    });
    await expect(f.run()).rejects.toThrow("gateway process changed");
    expect(f.readHealth).not.toHaveBeenCalled();
  });

  it.each(["gateway", "collector"])(
    "fails immediately when %s disappears between probes",
    async (component) => {
      const f = fixture({
        health: async () => {
          throw new Error("health timed out");
        },
      });
      f.readServices
        .mockResolvedValueOnce(baseline)
        .mockResolvedValue(baseline.filter((s) => s.component !== component));
      await expect(f.run()).rejects.toThrow(`${component} has no running process identity`);
      expect(f.readHealth).toHaveBeenCalledTimes(1);
      expect(f.sleep).not.toHaveBeenCalled();
    },
  );

  it("bounds persistent health failure by the deadline", async () => {
    const f = fixture({
      timeoutMs: 2000,
      health: async () => {
        throw new Error("still unavailable");
      },
    });
    await expect(f.run()).rejects.toThrow(
      "did not become healthy with unchanged services: still unavailable",
    );
    expect(f.readHealth).toHaveBeenCalledTimes(2);
    expect(f.sleep.mock.calls).toEqual([[1000], [1000]]);
  });

  it("does not accept health that completes after the deadline", async () => {
    const f = fixture({ timeoutMs: 2000 });
    f.readHealth.mockImplementation(async () => {
      f.advance(2001);
    });
    await expect(f.run()).rejects.toThrow("did not become healthy");
    expect(f.readHealth).toHaveBeenCalledTimes(1);
  });

  it("does not accept service verification that completes after the deadline", async () => {
    const f = fixture({ timeoutMs: 2000 });
    f.readServices
      .mockImplementationOnce(async () => baseline)
      .mockImplementation(async () => {
        f.advance(2001);
        return baseline;
      });
    await expect(f.run()).rejects.toThrow("did not become healthy");
  });

  it("captures only running supervisor PIDs and their OS start times", async () => {
    const execute = vi.fn(async (command, args) => {
      if (command === "fixture-cli")
        return {
          stdout: JSON.stringify({
            items: baseline.map((s) => ({ ...s, installed: true, state: "running" })),
          }),
        };
      return { stdout: `${args[1] === "100" ? baseline[0].started : baseline[1].started}\n` };
    });
    expect(await captureServices("fixture-cli", undefined, execute)).toEqual(baseline);
    expect(execute.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["fixture-cli", ["service", "status", "--json"]],
      ["ps", ["-p", "100", "-o", "lstart="]],
      ["ps", ["-p", "200", "-o", "lstart="]],
    ]);
  });

  it("refuses a supervisor entry that is registered but not running", async () => {
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify({
        items: baseline.map((s) => ({ ...s, installed: true, state: "stopped" })),
      }),
    }));
    await expect(captureServices("fixture-cli", undefined, execute)).rejects.toThrow(
      "not running under its supervisor",
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

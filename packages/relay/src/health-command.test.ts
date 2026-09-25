// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";

import { runRelayHealthCommand, type RelayHealthCommandIo } from "./health-command.js";

const NOW = 1_700_000_000_000;

function response(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    ok: true,
    status: "ready",
    protocols: { enrolment: [1], wake: [1] },
    carriers: {
      ios: {
        configured: true,
        status: "reachable",
        lastSuccessAt: NOW - 1_000,
        lastFailureAt: null,
      },
      android: {
        configured: true,
        status: "reachable",
        lastSuccessAt: NOW - 1_000,
        lastFailureAt: null,
      },
    },
    ...overrides,
  });
}

function io(result: Response | Error): RelayHealthCommandIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (message) => out.push(message),
    stderr: (message) => err.push(message),
    now: () => NOW,
    fetchFn: vi.fn(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    ),
  };
}

const REQUIRED = ["--url", "https://relay.example.com", "--max-success-age-seconds", "60"] as const;

describe("relay health command", () => {
  it("prints one deterministic success line and exits zero", async () => {
    const output = io(response());
    await expect(runRelayHealthCommand(REQUIRED, output)).resolves.toBe(0);
    expect(output.out).toEqual(["OK: relay is ready and both carrier successes are fresh"]);
    expect(output.err).toEqual([]);
  });

  it("distinguishes unhealthy relays from failed probes", async () => {
    const unhealthy = io(response({ ok: false, status: "degraded" }));
    await expect(runRelayHealthCommand(REQUIRED, unhealthy)).resolves.toBe(1);
    expect(unhealthy.err).toEqual(["ERROR: relay status is degraded"]);

    const failed = io(new Error("private network detail"));
    await expect(runRelayHealthCommand(REQUIRED, failed)).resolves.toBe(2);
    expect(failed.err).toEqual(["ERROR: relay health request failed"]);
  });

  it.each([
    [[], "--url is required"],
    [["--url", "https://relay.example.com"], "--max-success-age-seconds is required"],
    [[...REQUIRED, "--unknown"], "unknown argument: --unknown"],
    [
      ["--url", "https://user:secret@relay.example.com", "--max-success-age-seconds", "60"],
      "--url must be an origin",
    ],
    [
      ["--url", "https://relay.example.com/private", "--max-success-age-seconds", "60"],
      "--url must be an origin",
    ],
    [
      ["--url", "http://relay.example.com", "--max-success-age-seconds", "60"],
      "--url must use HTTPS",
    ],
    [[...REQUIRED.slice(0, 3), "0"], "--max-success-age-seconds must be a positive number"],
    [[...REQUIRED, "--timeout-seconds", "2147484"], "--timeout-seconds is outside"],
  ])("rejects unsafe or invalid arguments", async (args, message) => {
    const output = io(response());
    await expect(runRelayHealthCommand(args, output)).resolves.toBe(64);
    expect(output.err[0]).toContain(message);
    expect(output.fetchFn).not.toHaveBeenCalled();
  });

  it("allows plain HTTP only for loopback checks", async () => {
    const output = io(response());
    await expect(
      runRelayHealthCommand(
        ["--url", "http://127.0.0.1:8080", "--max-success-age-seconds", "60"],
        output,
      ),
    ).resolves.toBe(0);
    expect(output.fetchFn).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8080/health"),
      expect.any(Object),
    );
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Regression guard: `omnesis tokens create` accepts --device / --scopes /
 * --name as named flags. Same shape as the `devices pair` fix — without
 * the `args` declaration citty drops the flags on the floor and the
 * command falls through to its interactive prompts regardless.
 */
import { parseArgs, runCommand } from "citty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError, EXIT_AUTH, gatewayFetch, gatewayJson } from "../utils.js";
import { tokensCommand } from "./tokens.js";

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  gatewayJson: vi.fn(),
  gatewayFetch: vi.fn(),
  withSpinner: async (_label: string, fn: () => Promise<unknown>) => fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function createArgsDef() {
  const sub = await tokensCommand.subCommands!;
  const create = (sub as Record<string, { args?: unknown }>).create;
  const a = create.args;
  return typeof a === "function" ? await (a as () => unknown)() : await a;
}

describe("tokens create — named flag parsing", () => {
  it("surfaces --device, --scopes and --name flags", async () => {
    const def = await createArgsDef();
    const parsed = parseArgs(
      ["--device=ios-iphone", "--scopes=read,admin", "--name=my-token"],
      def as Parameters<typeof parseArgs>[1],
    );
    expect(parsed.device).toBe("ios-iphone");
    expect(parsed.scopes).toBe("read,admin");
    expect(parsed.name).toBe("my-token");
  });
});

describe("gatewayRefusal", () => {
  it("prints the gateway's own sentence", async () => {
    const { gatewayRefusal } = await import("./tokens.js");
    const res = Response.json(
      {
        code: "DEVICE_ON_ACCESS_LEVEL",
        error: 'device "Studio voice" answers under an access level',
      },
      { status: 409 },
    );
    expect(await gatewayRefusal(res)).toBe('device "Studio voice" answers under an access level');
  });

  it("falls back to the status and body when there is no sentence", async () => {
    const { gatewayRefusal } = await import("./tokens.js");
    expect(await gatewayRefusal(new Response("upstream down", { status: 502 }))).toBe(
      "gateway 502: upstream down",
    );
  });
});

describe("tokens create — connection recovery", () => {
  const devices = { items: [{ id: "fixture-device", name: "Fixture", kind: "gateway" }] };
  const args = ["create", "--device=fixture-device", "--scopes=read", "--name=fixture"];

  it("retries failed device reads, then issues exactly one token", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(gatewayJson)
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(devices);
    vi.mocked(gatewayFetch).mockResolvedValue(
      Response.json({
        id: "fixture-token",
        token: "fixture-value",
        expiresAt: null,
      }),
    );

    const run = runCommand(tokensCommand, { rawArgs: args });
    await vi.waitFor(() => expect(gatewayJson).toHaveBeenCalledTimes(1));
    await vi.runAllTimersAsync();
    await run;
    expect(gatewayJson).toHaveBeenCalledTimes(3);
    expect(gatewayJson).toHaveBeenCalledWith("/admin/devices");
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
    expect(gatewayFetch).toHaveBeenCalledWith(
      "/admin/tokens",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("bounds unavailable gateway retries and never starts token issuance", async () => {
    vi.useFakeTimers();
    const failure = new TypeError("fetch failed");
    vi.mocked(gatewayJson).mockRejectedValue(failure);
    const rejected = expect(runCommand(tokensCommand, { rawArgs: args })).rejects.toBe(failure);
    await vi.waitFor(() => expect(gatewayJson).toHaveBeenCalledTimes(1));
    await vi.runAllTimersAsync();
    await rejected;
    expect(gatewayJson).toHaveBeenCalledTimes(4);
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it("fails authentication immediately without retrying", async () => {
    const failure = new CliError("Gateway 401", EXIT_AUTH);
    vi.mocked(gatewayJson).mockRejectedValue(failure);
    await expect(runCommand(tokensCommand, { rawArgs: args })).rejects.toBe(failure);
    expect(gatewayJson).toHaveBeenCalledTimes(1);
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it("does not repeat token issuance after an ambiguous connection failure", async () => {
    vi.mocked(gatewayJson).mockResolvedValue(devices);
    const failure = new TypeError("fetch failed");
    vi.mocked(gatewayFetch).mockRejectedValue(failure);
    await expect(runCommand(tokensCommand, { rawArgs: args })).rejects.toBe(failure);
    expect(gatewayJson).toHaveBeenCalledTimes(1);
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
  });
});

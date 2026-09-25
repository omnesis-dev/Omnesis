// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Contract guard for `omnesis index rebuild` — the swap-mode the command sends
 * to POST /admin/index/rebuild. Default is the graceful, zero-downtime
 * rebuild; `--hard` opts into the immediate cutover. Only the gateway
 * round-trip + spinner are mocked; the command body (arg parsing, JSON body) is
 * the real implementation.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    gatewayFetch: vi.fn(),
    // Run the wrapped fn directly so the fetch still happens under test.
    withSpinner: vi.fn((_label: string, fn: () => unknown) => fn()),
  };
});

import { gatewayFetch } from "../utils.js";
import { indexRebuildCommand } from "./index-rebuild.js";

const okResponse = () => ({ ok: true, json: async () => ({ ok: true }) }) as unknown as Response;

function run(args: Record<string, unknown>) {
  // citty passes a context object; the command only reads ctx.args.
  return (indexRebuildCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<void>)({
    args,
  });
}

function bodyOf(call: number): unknown {
  const opts = (gatewayFetch as Mock).mock.calls[call][1] as { body?: string };
  return JSON.parse(opts.body ?? "{}");
}

beforeEach(() => {
  vi.clearAllMocks();
  (gatewayFetch as Mock).mockResolvedValue(okResponse());
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("omnesis index rebuild", () => {
  it("sends mode=graceful by default (skipping the prompt with --yes)", async () => {
    await run({ yes: true });
    expect(gatewayFetch).toHaveBeenCalledOnce();
    expect((gatewayFetch as Mock).mock.calls[0][0]).toBe("/admin/index/rebuild");
    expect(bodyOf(0)).toEqual({ mode: "graceful" });
  });

  it("sends mode=hard with --hard", async () => {
    await run({ yes: true, hard: true });
    expect(gatewayFetch).toHaveBeenCalledOnce();
    expect(bodyOf(0)).toEqual({ mode: "hard" });
  });
});

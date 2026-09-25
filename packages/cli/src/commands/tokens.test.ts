// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Regression guard: `omnesis tokens create` accepts --device / --scopes /
 * --name as named flags. Same shape as the `devices pair` fix — without
 * the `args` declaration citty drops the flags on the floor and the
 * command falls through to its interactive prompts regardless.
 */
import { parseArgs } from "citty";
import { describe, expect, it } from "vitest";
import { tokensCommand } from "./tokens.js";

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

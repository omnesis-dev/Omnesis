// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The forwardable tool names are stated in several places that nothing at
 * runtime compares: the gateway's Direct inventory and Notes tool, this
 * package's list, the Hermes adapter's copy, and the two OpenClaw manifests
 * that must declare every name before the plugin may offer it. A gateway tool
 * missing from any of them is a tool a granted connection silently never gets.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { FORWARDED_TOOL_NAMES } from "./forwarded-tools.js";
import { OPENCLAW_FORWARDED_TOOL_NAMES } from "./openclaw.js";

function source(url: string): string {
  return readFileSync(fileURLToPath(new URL(url, import.meta.url)), "utf8");
}

function stringsIn(block: string): string[] {
  return [...block.matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]!);
}

describe("the forwardable tools as every copy states them", () => {
  test("are the gateway's full Direct inventory and its Notes tool, in order", () => {
    const direct = /export const DIRECT_TOOL_NAMES = \[([^\]]+)\] as const;/u.exec(
      source("../../gateway/src/mcp/direct-server.ts"),
    );
    if (!direct) throw new Error("DIRECT_TOOL_NAMES is not declared in the gateway");
    expect(source("../../gateway/src/mcp/notes-server.ts")).toMatch(
      /server\.registerTool\(\s*"add_note",/u,
    );
    expect([...FORWARDED_TOOL_NAMES]).toEqual([...stringsIn(direct[1]!), "add_note"]);
  });

  test("the Hermes adapter hosts the same tools", () => {
    const hermes = /^_FORWARDED_TOOL_NAMES = \(([^)]+)\)$/mu.exec(source("../hermes/adapter.py"));
    if (!hermes) throw new Error("_FORWARDED_TOOL_NAMES is not declared in the Hermes adapter");
    expect(stringsIn(hermes[1]!)).toEqual([...FORWARDED_TOOL_NAMES]);
  });

  test("both OpenClaw manifests declare every one", () => {
    for (const manifest of [
      "../openclaw.plugin.json",
      "../../../integrations/openclaw-omnesis-plugin/openclaw.plugin.json",
    ]) {
      const declared = (JSON.parse(source(manifest)) as { contracts: { tools: string[] } })
        .contracts.tools;
      expect(declared).toEqual([
        "omnesis_answer",
        "omnesis_subscription_answer",
        "omnesis_subscriptions",
        ...OPENCLAW_FORWARDED_TOOL_NAMES,
      ]);
    }
  });

  // Hermes registers a user plugin's tools whether or not its manifest names
  // them, and its plugin doctor loads the plugin with no connection, so only the
  // tools every load registers can be declared without a warning.
  test("the Hermes manifest declares only the tools every load registers", () => {
    const provided = /^provides_tools:\n((?: {2}- [a-z_]+\n)+)/mu.exec(
      source("../hermes/plugin.yaml"),
    );
    if (!provided) throw new Error("the Hermes manifest declares no tools");
    expect([...provided[1]!.matchAll(/- ([a-z_]+)/gu)].map((match) => match[1])).toEqual([
      "omnesis_answer",
      "omnesis_subscription_answer",
      "omnesis_subscriptions",
    ]);
  });
});

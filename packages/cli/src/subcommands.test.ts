// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  HIDDEN_COMMAND_ALIASES,
  HIDDEN_INTERNAL_COMMANDS,
  SUB_COMMANDS,
  visibleSubCommands,
} from "./subcommands.js";
import type { CommandDef } from "citty";

async function resolve(name: string): Promise<CommandDef> {
  const entry = SUB_COMMANDS[name];
  expect(entry, `no command registered as \`${name}\``).toBeDefined();
  return (typeof entry === "function" ? await entry() : await entry) as CommandDef;
}

function commandName(command: CommandDef): unknown {
  return command.meta && "name" in command.meta ? command.meta.name : undefined;
}

describe("the omnesis command tree", () => {
  test("`watches` is the name the command answers to", async () => {
    expect(commandName(await resolve("watches"))).toBe("watches");
  });

  test("`subscriptions` still dispatches, to the same command", async () => {
    const [watches, alias] = await Promise.all([resolve("watches"), resolve("subscriptions")]);
    expect(alias).toBe(watches);
    expect(Object.keys(alias.subCommands ?? {})).toEqual(Object.keys(watches.subCommands ?? {}));
  });

  test("`brain` is canonical while `briefs` remains a hidden compatibility alias", async () => {
    const [brain, alias] = await Promise.all([resolve("brain"), resolve("briefs")]);
    expect(commandName(brain)).toBe("brain");
    expect(alias).toBe(brain);
    expect(Object.keys(alias.subCommands ?? {})).toEqual(Object.keys(brain.subCommands ?? {}));
  });

  test("only declared aliases and internal commands are missing from help", () => {
    const visible = new Set(Object.keys(visibleSubCommands()));
    const registered = Object.keys(SUB_COMMANDS);
    expect(registered.filter((name) => !visible.has(name))).toEqual([
      ...HIDDEN_COMMAND_ALIASES,
      ...HIDDEN_INTERNAL_COMMANDS,
    ]);
    expect(visible.has("watches")).toBe(true);
    expect(visible.has("subscriptions")).toBe(false);
    expect(visible.has("brain")).toBe(true);
    expect(visible.has("briefs")).toBe(false);
    expect(visible.has("_portal-fleet-update-run")).toBe(false);
  });
});

describe("the retired watch2 verb", () => {
  test("is gone, and the runtime answers to `watch`", async () => {
    // Dropped rather than aliased: the operator is the only person who typed
    // it, and an alias nobody needs is a second name to keep working.
    expect(Object.keys(SUB_COMMANDS)).toContain("watch");
    expect(Object.keys(SUB_COMMANDS), "the old verb still resolves").not.toContain("watch2");
    expect(Object.keys(HIDDEN_COMMAND_ALIASES), "hidden alias kept it alive").not.toContain(
      "watch2",
    );
  });
});

describe("the sources group", () => {
  test("carries the membership verbs next to move", async () => {
    const sources = await resolve("sources");
    const verbs = Object.keys(sources.subCommands ?? {});
    expect(verbs).toEqual(expect.arrayContaining(["move", "members", "join", "detach"]));
    expect(verbs.indexOf("members")).toBeGreaterThan(verbs.indexOf("move"));
  });
});

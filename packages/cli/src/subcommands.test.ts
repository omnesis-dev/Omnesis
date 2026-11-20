// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderUsage, type CommandDef } from "citty";
import {
  COMMANDS,
  HIDDEN_COMMAND_ALIASES,
  HIDDEN_INTERNAL_COMMANDS,
  SUB_COMMANDS,
  visibleSubCommands,
} from "./subcommands.js";

afterEach(() => vi.unstubAllEnvs());

/** The command tree as a CLI run started with the current environment builds it. */
async function freshTree(): Promise<typeof import("./subcommands.js")> {
  vi.resetModules();
  return import("./subcommands.js");
}

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

  test.each(["0", "1"])("the cloud command is listed with experimental mode %s", async (flag) => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", flag);
    // The tree is built when the module loads, as it is for each CLI run.
    const tree = await freshTree();
    const visible = new Set(Object.keys(tree.visibleSubCommands()));
    const registered = Object.keys(tree.SUB_COMMANDS);
    expect(registered.includes("cloud")).toBe(true);
    expect(registered.filter((name) => !visible.has(name))).toEqual([
      ...tree.HIDDEN_COMMAND_ALIASES,
      ...tree.HIDDEN_INTERNAL_COMMANDS,
    ]);
    expect(visible.has("cloud")).toBe(true);
    expect(visible.has("watches")).toBe(true);
    expect(visible.has("subscriptions")).toBe(false);
    expect(visible.has("brain")).toBe(true);
    expect(visible.has("briefs")).toBe(false);
    expect(visible.has("_portal-fleet-update-run")).toBe(false);
  });
});

test("the optional cloud command resolves without starting a gateway or requiring a Google identity", async () => {
  const entry = (await freshTree()).SUB_COMMANDS.cloud;
  expect(entry, "no command registered as `cloud`").toBeDefined();
  expect(
    commandName((typeof entry === "function" ? await entry() : await entry) as CommandDef),
  ).toBe("cloud");
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

describe("the top-level help", () => {
  test("lists every visible command from inert summaries, so printing it imports no command", async () => {
    const listed = visibleSubCommands();
    for (const [name, entry] of Object.entries(listed)) {
      // citty calls a function entry (or awaits a promise) to read its meta, which
      // would import the command's whole module graph just to print one line.
      expect(typeof entry, `\`${name}\` would be imported to render --help`).toBe("object");
      expect(entry).not.toBeInstanceOf(Promise);
      expect(Object.keys(entry as object), `\`${name}\` is more than a summary`).toEqual(["meta"]);
    }
    const usage = stripVTControlCharacters(
      await renderUsage({ meta: { name: "omnesis" }, subCommands: listed }),
    );
    const lines = usage.split("\n").map((line) => line.trim().split(/\s{2,}/));
    for (const [name, { description }] of Object.entries(COMMANDS)) {
      if (HIDDEN_COMMAND_ALIASES.has(name) || HIDDEN_INTERNAL_COMMANDS.has(name)) {
        expect(Object.keys(listed)).not.toContain(name);
        continue;
      }
      expect(lines, `\`${name}\` is not listed with its summary`).toContainEqual([
        name,
        description,
      ]);
    }
  });

  test("summarises each command with the description its own help prints", async () => {
    for (const [name, entry] of Object.entries(COMMANDS)) {
      const command = (await entry.load()) as CommandDef;
      const meta = await (typeof command.meta === "function" ? command.meta() : command.meta);
      expect(entry.description, `summary of \`${name}\``).toBe(meta?.description);
    }
  });
});

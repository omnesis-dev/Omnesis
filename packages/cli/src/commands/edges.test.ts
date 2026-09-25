// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseArgs, type ArgsDef, type CommandDef } from "citty";
import { describe, expect, it } from "vitest";
import { edgesCommand } from "./edges.js";

async function showArgsDef(): Promise<ArgsDef> {
  const subs = (await edgesCommand.subCommands) as unknown as Record<string, CommandDef>;
  const show = subs.show;
  return (typeof show.args === "function" ? await show.args() : show.args!) as ArgsDef;
}

describe("edges show — arg parsing", () => {
  it("parses the document-id positional", async () => {
    const def = await showArgsDef();
    const parsed = parseArgs(["a3f2c1b8"], def);
    expect(parsed.id).toBe("a3f2c1b8");
  });

  it("parses the --json flag", async () => {
    const def = await showArgsDef();
    const parsed = parseArgs(["a3f2c1b8", "--json"], def);
    expect(parsed.json).toBe(true);
    expect(parsed.id).toBe("a3f2c1b8");
  });
});

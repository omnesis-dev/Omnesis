// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { type ArgsDef, type CommandDef } from "citty";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTALLED_INVOCATION,
  SOURCE_INVOCATION,
  agentInstructions,
  resolveCliInvocation,
} from "../agent-instructions.js";
import { FOREGROUND_ANSWER_WAIT_TIMEOUT_S } from "../answer-wait.js";
import { agentCommand } from "./agent.js";

async function instructionsCommand(): Promise<CommandDef> {
  const subs = (await agentCommand.subCommands) as unknown as Record<string, CommandDef>;
  return subs.instructions;
}

/** Run a leaf command's `run` with the given parsed args, capturing stdout. */
async function runCapturing(
  cmd: CommandDef,
  args: Record<string, unknown>,
): Promise<{ stdout: string }> {
  let stdout = "";
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout += parts.map(String).join(" ") + "\n";
  });
  try {
    // citty's run receives a context; only args/rawArgs/cmd are needed here.
    await (cmd.run as (ctx: { args: Record<string, unknown> }) => unknown)({ args });
  } finally {
    writeSpy.mockRestore();
    logSpy.mockRestore();
  }
  return { stdout };
}

describe("agent instructions — output contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("registers the instructions subcommand under agent", async () => {
    const cmd = await instructionsCommand();
    expect(cmd).toBeDefined();
    expect(cmd.meta && (cmd.meta as { name?: string }).name).toBe("instructions");
  });

  it("exposes a --json flag", async () => {
    const cmd = await instructionsCommand();
    const args = (typeof cmd.args === "function" ? await cmd.args() : cmd.args) as ArgsDef;
    expect(args.json?.type).toBe("boolean");
  });

  it("prints the agent operating instructions as raw markdown by default", async () => {
    const cmd = await instructionsCommand();
    const { stdout } = await runCapturing(cmd, { json: false });
    expect(stdout).toBe(agentInstructions());
  });

  it("renders the workspace-script prefix when invoked via `npm run cli`", async () => {
    // Pins the handler → environment composition: the command must resolve the
    // prefix from the caller's env at run time, not bake in a fixed rendering.
    vi.stubEnv("npm_lifecycle_event", "cli");
    const cmd = await instructionsCommand();
    const { stdout } = await runCapturing(cmd, { json: false });
    expect(stdout).toContain('npm run cli -- answer "What should I prepare for tomorrow?"');
    expect(stdout).not.toContain('omnesis answer "What should I prepare for tomorrow?"');
  });

  it("emits { version, instructions } when --json is set", async () => {
    const cmd = await instructionsCommand();
    const { stdout } = await runCapturing(cmd, { json: true });
    const parsed = JSON.parse(stdout) as { version: string; instructions: string };
    expect(typeof parsed.version).toBe("string");
    expect(parsed.version.length).toBeGreaterThan(0);
    expect(parsed.instructions).toBe(agentInstructions());
  });
});

/**
 * #1209: the catalogue used to hard-code both a `cd ~/Desktop/Projects/Omnesis`
 * preamble and 51 `npm run cli --` commands, so an installed user — who has
 * only the `omnesis` binary on PATH and no checkout — was handed a catalogue of
 * commands they could not run.
 */
describe("agent instructions — CLI invocation prefix", () => {
  it("renders the installed `omnesis` prefix by default", () => {
    const text = agentInstructions(INSTALLED_INVOCATION);
    expect(text).toContain('omnesis answer "What should I prepare for tomorrow?"');
    expect(text).toContain('omnesis answer --task "<taskId>" --wait --json');
    expect(text).toContain(`--wait --wait-timeout ${FOREGROUND_ANSWER_WAIT_TIMEOUT_S} --json`);
    expect(text).not.toContain("omnesis search");
    expect(text).not.toContain("omnesis triggers");
    expect(text).not.toContain("npm run cli --");
  });

  it("renders the workspace-script prefix for a source checkout", () => {
    const text = agentInstructions(SOURCE_INVOCATION);
    expect(text).toContain('npm run cli -- answer "What should I prepare for tomorrow?"');
    expect(text).toContain('npm run cli -- answer --task "<taskId>" --wait --json');
  });

  it("never embeds a hard-coded checkout path", () => {
    for (const text of [
      agentInstructions(INSTALLED_INVOCATION),
      agentInstructions(SOURCE_INVOCATION),
    ]) {
      expect(text).not.toContain("Desktop/Projects");
      expect(text).not.toMatch(/cd\s+~?\//);
    }
  });

  it("selects the prefix from npm_lifecycle_event, not argv", () => {
    // `npm run cli` is the one invocation npm stamps with this variable. A
    // source *install* also execs a .ts entrypoint via an `omnesis` wrapper,
    // so argv[1] cannot discriminate.
    expect(resolveCliInvocation({ npm_lifecycle_event: "cli" })).toBe(SOURCE_INVOCATION);
    expect(resolveCliInvocation({ npm_lifecycle_event: "test" })).toBe(INSTALLED_INVOCATION);
    expect(resolveCliInvocation({})).toBe(INSTALLED_INVOCATION);
  });
});

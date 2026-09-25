// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { readPackageVersion } from "@omnesis/core";
import { agentInstructions } from "../agent-instructions.js";

const CLI_VERSION = readPackageVersion(import.meta.url);

/**
 * `omnesis agent instructions` — print the agent operating instructions for
 * the installed Omnesis version.
 *
 * This is the dynamic source the "Omnesis" OpenClaw skill fetches at
 * invocation time: the skill carries only a relevance bootstrap, then runs
 * this command and follows whatever it prints. Because the instruction text
 * ships inside the CLI package — versioned in lockstep with the rest of
 * Omnesis — the output always matches the installed version, with no skill
 * edits when Omnesis updates.
 *
 * The catalogue is rendered for the invocation the caller actually used, so an
 * installed user reads `omnesis search …` while a contributor running the
 * workspace script reads `npm run cli -- search …`.
 *
 * It is a local command: it prints a bundled string and never calls the
 * gateway, so the bootstrap is robust even when the gateway is unreachable.
 */
const instructionsCommand = defineCommand({
  meta: {
    name: "instructions",
    description: "Print the agent operating instructions for this Omnesis version",
  },
  args: {
    json: {
      type: "boolean",
      description: "Emit { version, instructions } as JSON instead of raw markdown",
    },
  },
  run({ args }) {
    const instructions = agentInstructions();
    if (args.json) {
      console.log(JSON.stringify({ version: CLI_VERSION, instructions }));
    } else {
      process.stdout.write(instructions);
    }
  },
});

export const agentCommand = defineCommand({
  meta: {
    name: "agent",
    description: "Agent integration helpers (operating instructions for AI agents)",
  },
  subCommands: {
    instructions: instructionsCommand,
  },
});

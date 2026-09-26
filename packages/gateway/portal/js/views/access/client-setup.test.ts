// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
import { agentSetups as untypedAgentSetups } from "./client-setup.js";

interface AgentSetup {
  id: string;
  name: string;
  subtitle: string;
  icon: { src?: string; providerId?: string };
  commands: Array<{ label: string; value: string }>;
  note: string;
}
const agentSetups = (resource: string): AgentSetup[] => untypedAgentSetups(resource);

const RESOURCE = "https://gateway.example.org/mcp";
const portalRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function agent(id: string, resource = RESOURCE) {
  const entry = agentSetups(resource).find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no setup for ${id}`);
  return entry;
}
const commands = (id: string, resource = RESOURCE) =>
  agent(id, resource).commands.map((command) => command.value);

describe("agentSetups", () => {
  test("lists the general agents in grid order", () => {
    expect(agentSetups(RESOURCE).map((entry) => entry.id)).toEqual([
      "claude-code",
      "codex",
      "chatgpt",
      "claude-apps",
      "gemini-cli",
      "openclaw",
      "hermes",
    ]);
  });

  test("gives every agent an icon the portal can show", () => {
    for (const entry of agentSetups(RESOURCE)) {
      if (entry.icon.providerId) continue;
      expect(entry.icon.src).toMatch(/^\/portal\/img\/agents\/[a-z-]+\.(?:svg|png)$/u);
      expect(existsSync(join(portalRoot, entry.icon.src!.replace(/^\/portal\//u, "")))).toBe(true);
    }
  });

  test("builds the terminal commands each CLI documents", () => {
    expect(commands("claude-code")).toEqual([
      `claude mcp add --transport http --scope user omnesis ${RESOURCE}`,
      "claude plugin marketplace add omnesis-dev/Omnesis --sparse .claude-plugin plugins/omnesis-claude" +
        ` && claude plugin install omnesis@omnesis --config omnesis_mcp_url=${RESOURCE}`,
    ]);
    expect(commands("codex")).toEqual([
      `codex mcp add omnesis --url ${RESOURCE} --oauth-resource ${RESOURCE}`,
    ]);
    expect(commands("gemini-cli")).toEqual([
      `gemini mcp add --scope user --transport http omnesis ${RESOURCE}`,
    ]);
  });

  test("pairs the managed integrations against the gateway, not its MCP resource", () => {
    expect(commands("openclaw")).toEqual([
      "omnesis connect openclaw --gateway-url https://gateway.example.org",
    ]);
    expect(commands("hermes")).toEqual([
      "omnesis connect hermes --gateway-url https://gateway.example.org",
    ]);
    expect(commands("openclaw", "https://gateway.example.org/omnesis/mcp")).toEqual([
      "omnesis connect openclaw --gateway-url https://gateway.example.org/omnesis",
    ]);
  });

  test("points hosted apps at the address the dialog shows", () => {
    for (const id of ["chatgpt", "claude-apps"]) {
      expect(agent(id).commands).toEqual([]);
      expect(agent(id).note).toMatch(/address above.*reachable from the Internet/u);
    }
  });

  test("quotes a resource that a shell would otherwise split or expand", () => {
    const odd = "https://gateway.example.org/mcp?x=1&y=$HOME it's";
    expect(commands("claude-code", odd)[0]).toBe(
      `claude mcp add --transport http --scope user omnesis 'https://gateway.example.org/mcp?x=1&y=$HOME it'\\''s'`,
    );
  });

  test("carries no credential", () => {
    for (const entry of agentSetups(RESOURCE)) {
      for (const command of entry.commands) {
        expect(command.value).not.toMatch(/token|bearer|authorization:/iu);
      }
    }
  });
});

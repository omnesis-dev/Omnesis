// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

// @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
import { clientSetups as untypedClientSetups } from "./client-setup.js";

interface ClientSetup {
  id: string;
  client: string;
  kind: "command" | "note";
  value: string;
  note: string;
}
const clientSetups = (resource: string): ClientSetup[] => untypedClientSetups(resource);

const RESOURCE = "https://gateway.example.org/mcp";

function setup(id: string, resource = RESOURCE) {
  const entry = clientSetups(resource).find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no setup for ${id}`);
  return entry;
}

describe("clientSetups", () => {
  test("gives every client the gateway's resource and nothing else to authenticate with", () => {
    // Hosted clients are pointed at the address the dialog already shows, and
    // the managed integrations pair against the gateway; their own tests cover them.
    const direct = clientSetups(RESOURCE).filter(
      (candidate) => !["hosted", "openclaw", "hermes"].includes(candidate.id),
    );
    for (const entry of direct) {
      expect(entry.value).toContain(RESOURCE);
      expect(entry.value).not.toMatch(/token|bearer|authorization:/iu);
    }
  });

  test("builds the terminal commands each CLI documents", () => {
    expect(setup("claude-code").value).toBe(
      `claude mcp add --transport http --scope user omnesis ${RESOURCE}`,
    );
    expect(setup("claude-code-plugin").value).toBe(
      "claude plugin marketplace add omnesis-dev/Omnesis --sparse .claude-plugin plugins/omnesis-claude" +
        ` && claude plugin install omnesis@omnesis --config omnesis_mcp_url=${RESOURCE}`,
    );
    expect(setup("codex").value).toBe(
      `codex mcp add omnesis --url ${RESOURCE} --oauth-resource ${RESOURCE}`,
    );
    expect(setup("gemini-cli").value).toBe(
      `gemini mcp add --scope user --transport http omnesis ${RESOURCE}`,
    );
  });

  test("quotes a resource that a shell would otherwise split or expand", () => {
    const odd = "https://gateway.example.org/mcp?x=1&y=$HOME it's";
    expect(setup("claude-code", odd).value).toBe(
      `claude mcp add --transport http --scope user omnesis 'https://gateway.example.org/mcp?x=1&y=$HOME it'\\''s'`,
    );
  });

  test("pairs the managed integrations against the gateway, not its MCP resource", () => {
    expect(setup("openclaw").value).toBe(
      "omnesis connect openclaw --gateway-url https://gateway.example.org",
    );
    expect(setup("hermes").value).toBe(
      "omnesis connect hermes --gateway-url https://gateway.example.org",
    );
    expect(setup("openclaw", "https://gateway.example.org/omnesis/mcp").value).toBe(
      "omnesis connect openclaw --gateway-url https://gateway.example.org/omnesis",
    );
  });

  test("lists general agents only, every one a command or a note", () => {
    expect(clientSetups(RESOURCE).map((entry) => entry.id)).toEqual([
      "claude-code",
      "claude-code-plugin",
      "codex",
      "gemini-cli",
      "openclaw",
      "hermes",
      "hosted",
    ]);
    for (const entry of clientSetups(RESOURCE)) expect(["command", "note"]).toContain(entry.kind);
  });

  test("points hosted clients at the address the dialog shows", () => {
    expect(setup("hosted")).toMatchObject({ kind: "note", value: "" });
    expect(setup("hosted").note).toMatch(/address above.*reachable from the Internet/u);
  });
});

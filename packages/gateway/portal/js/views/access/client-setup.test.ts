// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  agentSetups as untypedAgentSetups,
  harnessAddresses as untypedHarnessAddresses,
  isPrivateAddress as untypedIsPrivateAddress,
  // @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
} from "./client-setup.js";

interface OAuth {
  resource: string;
  resources?: Array<{ resource: string; servedByGateway: boolean }>;
  tlsFingerprintSha256?: string | null;
}
interface Address {
  gatewayUrl: string;
  servedByGateway: boolean;
}
interface AgentSetup {
  id: string;
  name: string;
  icon: { src?: string; providerId?: string };
  commands: Array<{ label: string; value: string }>;
  note: string;
  docs: string;
  needsPublicAddress?: string;
  pairs?: boolean;
  alternatives?: boolean;
  blocked?: boolean;
}
const agentSetups = (
  oauth: OAuth,
  pairing?: { harnessAddress?: Address; pairingCode?: string },
): AgentSetup[] => untypedAgentSetups(oauth, pairing);
const harnessAddresses = (oauth: OAuth): Address[] => untypedHarnessAddresses(oauth);
const isPrivateAddress = (resource: string): boolean => untypedIsPrivateAddress(resource);

const RESOURCE = "https://gateway.example.org/mcp";
const FINGERPRINT = "ab".repeat(32);
const portalRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function agent(id: string, oauth: OAuth = { resource: RESOURCE }, pairing = {}) {
  const entry = agentSetups(oauth, pairing).find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no setup for ${id}`);
  return entry;
}
const commands = (id: string, oauth: OAuth = { resource: RESOURCE }, pairing = {}) =>
  agent(id, oauth, pairing).commands.map((command) => command.value);

describe("agentSetups", () => {
  test("lists the general agents in grid order, each with a docs section", () => {
    const agents = agentSetups({ resource: RESOURCE });
    expect(agents.map((entry) => entry.id)).toEqual([
      "claude-code",
      "codex",
      "chatgpt",
      "claude-apps",
      "gemini-cli",
      "openclaw",
      "hermes",
    ]);
    for (const entry of agents) {
      expect(entry.docs).toMatch(/^https:\/\/omnesis\.dev\/docs\/connect#[a-z-]+$/u);
    }
  });

  test("gives every agent an icon the portal can show", () => {
    for (const entry of agentSetups({ resource: RESOURCE })) {
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
      "codex plugin marketplace add omnesis-dev/Omnesis --sparse .agents/plugins --sparse plugins/omnesis" +
        " && codex plugin add omnesis@omnesis",
    ]);
    expect(agent("codex").alternatives).toBeUndefined();
    expect(commands("gemini-cli")).toEqual([
      `gemini mcp add --scope user --transport http omnesis ${RESOURCE}`,
    ]);
  });

  test("marks the agents that need a public address", () => {
    const needsPublic = agentSetups({ resource: RESOURCE })
      .filter((entry) => entry.needsPublicAddress)
      .map((entry) => entry.id);
    expect(needsPublic).toEqual(["chatgpt", "claude-apps", "gemini-cli"]);
    expect(agent("chatgpt").commands).toEqual([]);
    expect(agent("claude-apps").commands).toEqual([]);
  });

  test("gives the integrations an installer line and a CLI line against the gateway", () => {
    expect(commands("openclaw")).toEqual([
      "curl -fsSL https://omnesis.dev/install.sh | sh -s -- --openclaw --gateway-url https://gateway.example.org",
      "omnesis connect openclaw --gateway-url https://gateway.example.org",
    ]);
    expect(commands("hermes")[1]).toBe("omnesis connect hermes --gateway-url https://gateway.example.org");
    expect(commands("openclaw", { resource: "https://gateway.example.org/omnesis/mcp" })[1]).toBe(
      "omnesis connect openclaw --gateway-url https://gateway.example.org/omnesis",
    );
  });

  test("pins the certificate only where the gateway serves the address itself", () => {
    const oauth = {
      resource: RESOURCE,
      resources: [
        { resource: RESOURCE, servedByGateway: false },
        { resource: "https://gateway.example.org:7600/mcp", servedByGateway: true },
      ],
      tlsFingerprintSha256: FINGERPRINT,
    };
    expect(commands("openclaw", oauth, { pairingCode: "K7Q2-M9XD" })[0]).toBe(
      "curl -fsSL https://omnesis.dev/install.sh | sh -s -- --openclaw --gateway-url https://gateway.example.org:7600" +
        ` --code K7Q2-M9XD --trust-fingerprint sha256:${FINGERPRINT}`,
    );
    const proxied = harnessAddresses(oauth)[1];
    expect(commands("openclaw", oauth, { harnessAddress: proxied })[1]).toBe(
      "omnesis connect openclaw --gateway-url https://gateway.example.org",
    );
  });

  test("offers nothing that could fail when a public-address agent meets a private address", () => {
    const privateOauth = { resource: "https://192.168.1.20:7600/mcp" };
    for (const id of ["chatgpt", "claude-apps", "gemini-cli"]) {
      expect(agent(id, privateOauth)).toMatchObject({ blocked: true, commands: [], note: "" });
      expect(agent(id).blocked).toBeUndefined();
    }
    for (const id of ["claude-code", "codex", "openclaw", "hermes"]) {
      expect(agent(id, privateOauth).blocked).toBeUndefined();
      expect(agent(id, privateOauth).commands.length).toBeGreaterThan(0);
    }
  });

  test("names the Codex version that completes the sign-in", () => {
    expect(agent("codex").note).toMatch(/Codex 0\.147 or later/u);
  });

  test("quotes a value that a shell would otherwise split or expand", () => {
    const odd = "https://gateway.example.org/mcp?x=1&y=$HOME it's";
    expect(commands("claude-code", { resource: odd })[0]).toBe(
      `claude mcp add --transport http --scope user omnesis 'https://gateway.example.org/mcp?x=1&y=$HOME it'\\''s'`,
    );
  });

  test("carries no credential", () => {
    for (const entry of agentSetups({ resource: RESOURCE })) {
      for (const command of entry.commands) {
        expect(command.value).not.toMatch(/token|bearer|authorization:/iu);
      }
    }
  });
});

describe("harnessAddresses", () => {
  test("lists addresses the gateway serves itself first, without /mcp", () => {
    expect(
      harnessAddresses({
        resource: RESOURCE,
        resources: [
          { resource: RESOURCE, servedByGateway: false },
          { resource: "https://gateway.example.org:7600/mcp", servedByGateway: true },
        ],
      }),
    ).toEqual([
      { gatewayUrl: "https://gateway.example.org:7600", servedByGateway: true },
      { gatewayUrl: "https://gateway.example.org", servedByGateway: false },
    ]);
  });

  test("falls back to the main resource when the gateway lists none", () => {
    expect(harnessAddresses({ resource: RESOURCE })).toEqual([
      { gatewayUrl: "https://gateway.example.org", servedByGateway: false },
    ]);
  });
});

describe("isPrivateAddress", () => {
  test.each([
    "https://localhost:7600/mcp",
    "https://127.0.0.1:7600/mcp",
    "https://10.0.0.5/mcp",
    "https://172.20.0.5/mcp",
    "https://192.168.1.20:7600/mcp",
    "https://100.101.102.103:7600/mcp",
    "https://169.254.10.1/mcp",
    "https://omnesis.local:7600/mcp",
    "https://gateway.internal/mcp",
    "https://gateway.home.arpa/mcp",
    "https://[::1]:7600/mcp",
    "https://[fd12:3456::1]/mcp",
  ])("treats %s as private", (resource) => {
    expect(isPrivateAddress(resource)).toBe(true);
  });

  test.each([
    "https://gateway.example.org/mcp",
    "https://studio.tail-example.ts.net/mcp",
    "https://172.32.0.1/mcp",
    "https://100.128.0.1/mcp",
    "https://8.8.8.8/mcp",
  ])("cannot tell that %s is private", (resource) => {
    expect(isPrivateAddress(resource)).toBe(false);
  });
});

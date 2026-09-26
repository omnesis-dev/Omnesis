// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  agentIconForApp,
  AGENT_ICONS,
  // @ts-expect-error — the portal is plain JS.
} from "./agent-brand.js";

import {
  agentSetups as untypedAgentSetups,
  harnessAddresses as untypedHarnessAddresses,
  isPrivateAddress as untypedIsPrivateAddress,
  usesNonStandardPort as untypedUsesNonStandardPort,
  // @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
} from "./client-setup.js";

interface OAuth {
  resource: string;
  resources?: Array<{ resource: string; servedByGateway: boolean; direct: boolean }>;
  tlsFingerprintSha256?: string | null;
}
interface Address {
  gatewayUrl: string;
  servedByGateway: boolean;
  direct: boolean;
}
type NotePart = string | { code: string } | { href: string; text: string };
interface AgentSetup {
  id: string;
  name: string;
  icon: { src?: string; providerId?: string };
  commands: Array<{ label: string; value: string }>;
  note: NotePart[];
  headless?: { note: NotePart[]; command?: string };
  docs: string;
  needsPublicAddress?: string;
  standardPortOnly?: string;
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
const usesNonStandardPort = (resource: string): boolean => untypedUsesNonStandardPort(resource);
const noteText = (parts: NotePart[]) =>
  parts.map((part) => (typeof part === "string" ? part : "code" in part ? part.code : part.text)).join("");

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
      "antigravity",
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
      "claude plugin marketplace add omnesis-dev/Omnesis --sparse .claude-plugin plugins/omnesis-claude" +
        ` && claude plugin install omnesis@omnesis --config omnesis_mcp_url=${RESOURCE}`,
      `claude mcp add --transport http --scope user omnesis ${RESOURCE}`,
    ]);
    expect(agent("claude-code").commands.map((command) => command.label)).toEqual([
      "Install the plugin (recommended)",
      "Only add the server",
    ]);
    expect(commands("codex")).toEqual([
      `codex mcp add omnesis --url ${RESOURCE} --oauth-resource ${RESOURCE}`,
      "codex plugin marketplace add omnesis-dev/Omnesis --sparse .agents/plugins --sparse plugins/omnesis" +
        " && codex plugin add omnesis@omnesis",
    ]);
    expect(agent("codex").alternatives).toBeUndefined();
    expect(commands("antigravity")).toEqual([`agy mcp add omnesis ${RESOURCE}`]);
  });

  test("marks the agents that need a public address", () => {
    const needsPublic = agentSetups({ resource: RESOURCE })
      .filter((entry) => entry.needsPublicAddress)
      .map((entry) => entry.id);
    expect(needsPublic).toEqual(["chatgpt", "claude-apps"]);
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
        { resource: RESOURCE, servedByGateway: false, direct: false },
        { resource: "https://gateway.example.org:7600/mcp", servedByGateway: true, direct: true },
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
    // A proxy that presents the gateway's own certificate is still pinnable.
    const sameCertificate = { gatewayUrl: "https://gateway.example.org", servedByGateway: true, direct: false };
    expect(commands("openclaw", oauth, { harnessAddress: sameCertificate })[1]).toBe(
      `omnesis connect openclaw --gateway-url https://gateway.example.org --trust-fingerprint sha256:${FINGERPRINT}`,
    );
  });

  test("offers nothing that could fail when a public-address agent meets a private address", () => {
    const privateOauth = { resource: "https://192.168.1.20:7600/mcp" };
    for (const id of ["chatgpt", "claude-apps"]) {
      expect(agent(id, privateOauth)).toMatchObject({ blocked: true, commands: [], note: [] });
      expect(agent(id).blocked).toBeUndefined();
    }
    for (const id of ["claude-code", "codex", "antigravity", "openclaw", "hermes"]) {
      expect(agent(id, privateOauth).blocked).toBeUndefined();
      expect(agent(id, privateOauth).commands.length).toBeGreaterThan(0);
    }
  });

  test("blocks ChatGPT on an address off port 443, which it never dials", () => {
    const funnelPort = { resource: "https://gateway.example.org:10000/mcp" };
    expect(agent("chatgpt", funnelPort)).toMatchObject({ blocked: true, commands: [], note: [] });
    expect(agent("claude-apps", funnelPort).blocked).toBeUndefined();
    expect(agent("chatgpt", { resource: "https://gateway.example.org:443/mcp" }).blocked).toBeUndefined();
  });

  test("names the Codex version that completes the sign-in", () => {
    expect(noteText(agent("codex").note)).toMatch(/Codex 0\.147 or later/u);
  });

  test("links developer mode from the ChatGPT note", () => {
    expect(agent("chatgpt").note).toContainEqual({
      href: "https://developers.openai.com/api/docs/guides/developer-mode",
      text: "developer mode",
    });
  });

  test("tells the terminal agents how to sign in without a browser", () => {
    expect(noteText(agent("claude-code").headless!.note)).toMatch(/paste the address/u);
    expect(agent("codex").headless).toMatchObject({ command: "codex mcp login omnesis --no-browser" });
    expect(noteText(agent("antigravity").note)).toMatch(/Antigravity page with an authorization code/u);
    expect(agent("chatgpt").headless).toBeUndefined();
  });

  test("quotes a value that a shell would otherwise split or expand", () => {
    const odd = "https://gateway.example.org/mcp?x=1&y=$HOME it's";
    expect(commands("claude-code", { resource: odd })[1]).toBe(
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
          { resource: RESOURCE, servedByGateway: false, direct: false },
          { resource: "https://gateway.example.org:7600/mcp", servedByGateway: true, direct: true },
        ],
      }),
    ).toEqual([
      { gatewayUrl: "https://gateway.example.org:7600", servedByGateway: true, direct: true },
      { gatewayUrl: "https://gateway.example.org", servedByGateway: false, direct: false },
    ]);
  });

  test("puts the gateway's own listener before a proxy that serves its certificate", () => {
    // A tailnet funnel on 443 presents the same certificate as a gateway on
    // its Tailscale certificate: pinnable, but not the direct address.
    expect(
      harnessAddresses({
        resource: RESOURCE,
        resources: [
          { resource: RESOURCE, servedByGateway: true, direct: false },
          { resource: "https://other.example.org/mcp", servedByGateway: false, direct: false },
          { resource: "https://gateway.example.org:7600/mcp", servedByGateway: true, direct: true },
        ],
      }),
    ).toEqual([
      { gatewayUrl: "https://gateway.example.org:7600", servedByGateway: true, direct: true },
      { gatewayUrl: "https://gateway.example.org", servedByGateway: true, direct: false },
      { gatewayUrl: "https://other.example.org", servedByGateway: false, direct: false },
    ]);
  });

  test("falls back to the main resource when the gateway lists none", () => {
    expect(harnessAddresses({ resource: RESOURCE })).toEqual([
      { gatewayUrl: "https://gateway.example.org", servedByGateway: false, direct: false },
    ]);
  });
});

describe("usesNonStandardPort", () => {
  test.each([
    ["https://gateway.example.org/mcp", false],
    ["https://gateway.example.org:443/mcp", false],
    ["https://gateway.example.org:10000/mcp", true],
    ["https://gateway.example.org:8443/mcp", true],
    ["not a url", false],
  ])("%s → %s", (resource, expected) => {
    expect(usesNonStandardPort(resource)).toBe(expected);
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


describe("connection app logos", () => {
  test.each([
    ["ChatGPT", "chatgpt"], ["  CHATGPT Desktop  ", "chatgpt"],
    ["OpenAI", "chatgpt"], ["OpenAI Codex", "chatgpt"],
    ["Codex CLI", "codex"], ["codex_cli_rs", "codex"],
    ["Claude", "claude-apps"], ["claude desktop", "claude-apps"],
    ["claude code", "claude-code"], ["claude-cli", "claude-code"],
    ["anthropic claude", "claude-apps"], ["claude code 2.0", "claude-apps"],
    ["google antigravity", "antigravity"], ["OpenClaw Agent", "openclaw"],
    ["hermes agent", "hermes"],
  ])("reuses the setup logo for %s", (name, id) => {
    expect(agentIconForApp(name)).toBe(AGENT_ICONS[id]);
  });

  test.each([null, undefined, "", "Guv", "Fictional reader", "My ChatGPT helper", "Claudeish", "OpenAIish"])(
    "leaves unrecognized names text-only: %s", (name) => {
      expect(agentIconForApp(name)).toBeNull();
    },
  );
});

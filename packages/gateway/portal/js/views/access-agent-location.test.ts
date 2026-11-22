// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The connect dialog's first question, where the agent runs: on this computer
// (the plain loopback address, or why it does not answer), on another computer
// at home (allowed by the owner, with what each agent must trust there), or
// somewhere else.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  completeAccessAuthorization: vi.fn(),
  createAccessLevel: vi.fn(),
  decideAccessAuthorization: vi.fn(),
  deleteAccessLevel: vi.fn(),
  getAccessAuthorization: vi.fn(),
  getAccessOverview: vi.fn(),
  listDevices: vi.fn(),
  lookupAccessAuthorization: vi.fn(),
  moveConnectionLevel: vi.fn(),
  pairDevice: vi.fn(),
  renameAccessPrincipal: vi.fn(),
  revokeAccess: vi.fn(),
  updateAccessLevel: vi.fn(),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn(), replaceRoute: vi.fn() }));
const relayApi = vi.hoisted(() => ({ relayManagement: vi.fn() }));
const tailscaleApi = vi.hoisted(() => ({ getTailscale: vi.fn() }));
const remoteApi = vi.hoisted(() => ({ updateRemoteAccess: vi.fn() }));

vi.mock("../api.js", () => api);
vi.mock("../lib/router.js", () => router);
vi.mock("../lib/cloud-relay-api.js", () => relayApi);
vi.mock("../lib/tailscale-api.js", () => tailscaleApi);
vi.mock("../lib/remote-access-api.js", () => remoteApi);
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }));

// @ts-expect-error — portal modules are plain JS.
import { AccessView } from "./access.js";
// @ts-expect-error — portal modules are plain JS.
import { agentSetups } from "./access/client-setup.js";

const LOCAL = "https://localhost:7600/mcp";
const PLAIN = "http://localhost:7601/mcp";
const HOME_NAME = "https://omnesis.local:7600/mcp";
const HOME_IP = "https://192.168.0.20:7600/mcp";
const FINGERPRINT = "ab".repeat(32);

type Overrides = {
  thisComputer?: Record<string, unknown>;
  homeNetwork?: Record<string, unknown> | null;
  certificate?: { kind: string; trustFile: string | null };
  homeTrusted?: boolean;
};

function overview({
  thisComputer = { state: "listening", resource: PLAIN, port: 7601, gatewayUrl: "https://localhost:7600" },
  homeNetwork,
  certificate = { kind: "self-signed", trustFile: "/home/fictional/.config/omnesis/tls/cert.pem" },
  homeTrusted = false,
}: Overrides = {}) {
  const entry = (resource: string, servedByGateway: boolean) => ({
    resource,
    servedByGateway,
    direct: servedByGateway,
    publiclyTrusted: homeTrusted,
  });
  return {
    principals: [],
    levels: [],
    oauth: {
      resource: LOCAL,
      loopbackOnly: true,
      resources: [{ resource: LOCAL, servedByGateway: true, direct: true, publiclyTrusted: false }],
      tlsFingerprintSha256: FINGERPRINT,
      certificate,
      thisComputer,
      ...(homeNetwork === null
        ? {}
        : {
            homeNetwork: homeNetwork ?? {
              allowed: true,
              resources: [entry(HOME_NAME, true), entry(HOME_IP, true)],
            },
          }),
    },
  };
}

describe("where the agent runs", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    api.getAccessAuthorization.mockResolvedValue({ request: null });
    api.listDevices.mockResolvedValue({ items: [] });
    relayApi.relayManagement.mockResolvedValue(null);
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function settle() {
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
  }
  async function mount() {
    await act(async () => { render(h(AccessView, { connectOpen: true }), host); await Promise.resolve(); });
    await settle();
  }
  async function runOn(location: "machine" | "home" | "away") {
    const radio = host.querySelector<HTMLInputElement>(`input[name='access-agent-location'][value='${location}']`)!;
    await act(async () => { radio.dispatchEvent(new window.Event("change", { bubbles: true })); });
  }
  async function select(agent: string) {
    const card = host.querySelector<HTMLButtonElement>(`button[data-agent='${agent}']`)!;
    await act(async () => { card.click(); });
    return host.querySelector(".access-agent-steps")!;
  }
  const shownAddress = () =>
    host.querySelector<HTMLSelectElement>("#access-mcp-address")?.value ??
    host.querySelector(".access-connect-step .access-mcp-resource code")?.textContent;
  const agents = () => [...host.querySelectorAll("button[data-agent]")].map((card) => card.getAttribute("data-agent"));
  const commands = () => [...host.querySelectorAll(".access-agent-command code")].map((code) => code.textContent);
  const warned = (agent: string) =>
    host.querySelector(`button[data-agent='${agent}'] .access-agent-warning`) !== null;
  const text = () => host.querySelector(".access-connect-dialog")?.textContent?.replace(/\s+/gu, " ") ?? "";

  describe("on this computer", () => {
    test("the plain address needs no certificate, so every local agent connects as is", async () => {
      api.getAccessOverview.mockResolvedValue(overview());
      await mount();
      expect(host.querySelector("input[name='access-agent-location'][value='machine']")?.hasAttribute("checked")).toBe(true);
      expect(shownAddress()).toBe(PLAIN);
      expect(text()).toContain("Only programs on this computer can use this address, and it needs no certificate step.");
      // The agents that connect from their own servers can never reach it.
      expect(agents()).not.toContain("chatgpt");
      expect(agents()).not.toContain("claude-apps");
      expect(warned("claude-code")).toBe(false);
      await select("claude-code");
      expect(host.querySelector(".access-agent-trust")).toBeNull();
      expect(commands()[0]).toContain(`--config omnesis_mcp_url=${PLAIN}`);
    });

    test("a managed integration on this computer pairs against the gateway's HTTPS address, never the plain one", async () => {
      api.getAccessOverview.mockResolvedValue(overview());
      await mount();
      await select("openclaw");
      expect(commands()[0]).toContain("--gateway-url https://localhost:7600");
      expect(commands()[0]).toContain(`--trust-fingerprint sha256:${FINGERPRINT}`);
      expect(commands()[0]).not.toContain("http://localhost:7601");
    });

    test("a busy port is said with its config key, and the address shown is one that answers", async () => {
      api.getAccessOverview.mockResolvedValue(
        overview({ thisComputer: { state: "port-in-use", resource: null, port: 7601, gatewayUrl: "https://localhost:7600" } }),
      );
      await mount();
      expect(shownAddress()).toBe(LOCAL);
      expect(text()).not.toContain("http://localhost:7601");
      expect(text()).toContain("port 7601 is in use by another program");
      expect(text()).toContain("gateway.localMcp.port");
      // Over HTTPS a self-signed certificate is back in the way for Claude Code.
      expect(warned("claude-code")).toBe(true);
    });

    test("a gateway in a container says why there is no plain address", async () => {
      api.getAccessOverview.mockResolvedValue(
        overview({ thisComputer: { state: "container", resource: null, gatewayUrl: "https://localhost:7600" } }),
      );
      await mount();
      expect(shownAddress()).toBe(LOCAL);
      expect(text()).toContain("This gateway runs in a container");
    });

    test("hosted apps are simply not listed here, and the dialog opens without an intro", async () => {
      api.getAccessOverview.mockResolvedValue(overview());
      await mount();
      expect(text()).not.toContain("MCP is how agents");
      expect(host.querySelector(".access-connect-dialog > p")).toBeNull();
      expect(agents()).not.toContain("chatgpt");
      expect(text()).not.toContain("Setup for common agents");
      expect(text()).not.toContain("connect from their own servers");
      expect(host.querySelector(".access-agent-elsewhere")).toBeNull();
      // Somewhere else is where they are: with no address away from home yet, the dialog says
      // where to get one.
      await runOn("away");
      expect(text()).toContain("This gateway has no address away from home yet.");
      expect(agents()).toEqual([]);
      // With no address to give, there is no sign-in to enter a code for.
      expect(host.querySelector(".access-code-input")).toBeNull();
    });
  });

  describe("on another computer at home", () => {
    test("a gateway listening on this computer alone says other computers can't reach it", async () => {
      api.getAccessOverview.mockResolvedValue(overview({ homeNetwork: null }));
      await mount();
      await runOn("home");
      expect(text()).toContain("This gateway listens on this computer only");
      expect(host.querySelector(".access-agent-setup")).toBeNull();
    });

    test("while it is off, what allowing it means comes first, and allowing it shows the address", async () => {
      api.getAccessOverview.mockResolvedValue(overview({ homeNetwork: { allowed: false, resources: [] } }));
      remoteApi.updateRemoteAccess.mockResolvedValue({});
      await mount();
      await runOn("home");
      expect(text()).toContain("Agents on your home network can't sign in yet.");
      // The short form, where it is turned on; the docs say the rest.
      expect([...host.querySelectorAll(".access-home-allow li")].map((li) => li.textContent)).toEqual([
        "Any device on your network can reach the sign-in page. You still approve each agent.",
        "The agent's computer has to trust this gateway's certificate.",
        "Hosted apps such as ChatGPT can't use it.",
      ]);
      expect(host.querySelector(".access-home-allow a")?.getAttribute("href")).toBe(
        "https://omnesis.dev/docs/connect#home-network",
      );
      // No address and no agent setup until it answers.
      expect(host.querySelector(".access-mcp-resource")).toBeNull();
      expect(host.querySelector(".access-agent-setup")).toBeNull();
      api.getAccessOverview.mockResolvedValue(overview());
      const allow = [...host.querySelectorAll<HTMLButtonElement>(".access-home-allow button")][0]!;
      await act(async () => { allow.click(); });
      await settle();
      expect(remoteApi.updateRemoteAccess).toHaveBeenCalledWith({ mcp: { home: "on" } });
      expect(shownAddress()).toBe(HOME_NAME);
      expect([...host.querySelectorAll("#access-mcp-address option")].map((option) => option.textContent)).toEqual([
        HOME_NAME,
        HOME_IP,
      ]);
      // The address alone: the warnings informed the choice and the docs keep the explanation.
      expect(text()).not.toContain("Prefer the .local name");
      expect(text()).not.toContain("Anyone on your network can reach this address");
      expect(host.querySelector(".access-home-allow")).toBeNull();
      expect(text()).not.toContain("Setup for common agents");
    });

    test("a refused change, such as a missing passkey, is said where it was asked", async () => {
      api.getAccessOverview.mockResolvedValue(overview({ homeNetwork: { allowed: false, resources: [] } }));
      remoteApi.updateRemoteAccess.mockRejectedValue(
        Object.assign(new Error("Confirm with your passkey to change this."), { stepUp: true }),
      );
      await mount();
      await runOn("home");
      const allow = [...host.querySelectorAll<HTMLButtonElement>(".access-home-allow button")][0]!;
      await act(async () => { allow.click(); });
      await settle();
      expect(host.querySelector(".access-home-allow [role='alert']")?.textContent).toBe(
        "Confirm with your passkey to change this.",
      );
    });

    test("Claude Code can't trust a self-signed certificate there: said first, with what works instead, and no commands", async () => {
      api.getAccessOverview.mockResolvedValue(overview());
      await mount();
      await runOn("home");
      expect(warned("claude-code")).toBe(true);
      const steps = await select("claude-code");
      const notice = steps.querySelector(".access-agent-public")!;
      expect(notice.textContent).toContain("Claude Code can't connect over your home network.");
      expect(notice.textContent).toContain("can't trust a self-signed certificate");
      // What works without Tailscale or an account comes first: this computer, then a certificate it trusts.
      expect([...notice.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
        "https://omnesis.dev/docs/setup#certificates",
        "/portal/settings/connectivity",
      ]);
      expect(commands()).toEqual([]);
      expect(steps.querySelector(".access-agent-trust")).toBeNull();
      // Running it on this computer instead is one click.
      const machine = [...notice.querySelectorAll<HTMLButtonElement>("button")][0]!;
      await act(async () => { machine.click(); });
      expect(shownAddress()).toBe(PLAIN);
    });

    test("with the plain address down, Claude Code is never sent to this computer, where HTTPS would refuse it too", async () => {
      api.getAccessOverview.mockResolvedValue(
        overview({ thisComputer: { state: "port-in-use", resource: null, port: 7601, gatewayUrl: "https://localhost:7600" } }),
      );
      await mount();
      await runOn("home");
      const steps = await select("claude-code");
      const notice = steps.querySelector(".access-agent-public")!;
      expect(notice.textContent).toContain("Claude Code can't connect over your home network.");
      expect(notice.textContent).not.toContain("On this computer");
      expect(notice.querySelectorAll("button")).toHaveLength(0);
      expect(notice.textContent).toContain("give the gateway an mkcert certificate");
      expect(notice.textContent).toContain("Otherwise reach this gateway from away");
    });

    test("Codex is not offered a trust step for another computer: said plainly, with what works instead", async () => {
      for (const certificate of [
        { kind: "self-signed", trustFile: "/home/fictional/.config/omnesis/tls/cert.pem" },
        { kind: "mkcert", trustFile: "/home/fictional/.local/share/mkcert/rootCA.pem" },
      ]) {
        api.getAccessOverview.mockResolvedValue(overview({ certificate }));
        render(null, host);
        await mount();
        await runOn("home");
        expect(warned("codex"), certificate.kind).toBe(true);
        const steps = await select("codex");
        const notice = steps.querySelector(".access-agent-public")!;
        expect(notice.textContent).toContain("Codex can't connect over your home network.");
        expect(notice.textContent).toContain("doesn't offer it for another computer yet");
        expect(notice.textContent).not.toContain("mkcert");
        expect(steps.querySelector(".access-agent-download")).toBeNull();
        expect(commands()).toEqual([]);
      }
      // On the gateway's own computer it connects as is.
      await runOn("machine");
      await select("codex");
      await select("codex");
      expect(warned("codex")).toBe(false);
    });

    test("an mkcert gateway: Claude Code trusts its authority, with no warning", async () => {
      api.getAccessOverview.mockResolvedValue(
        overview({ certificate: { kind: "mkcert", trustFile: "/home/fictional/.local/share/mkcert/rootCA.pem" } }),
      );
      await mount();
      await runOn("home");
      expect(warned("claude-code")).toBe(false);
      const steps = await select("claude-code");
      expect(steps.querySelector(".access-agent-public")).toBeNull();
      expect(steps.querySelector(".access-agent-download")?.getAttribute("download")).toBe("omnesis-gateway-ca.pem");
      expect(commands()[0]).toBe('export NODE_EXTRA_CA_CERTS="$HOME/omnesis-gateway-ca.pem"');
      expect(steps.textContent?.replace(/\s+/gu, " ")).toContain("trusts every other certificate made with it there");
    });

    test("a certificate trusted publicly on the home addresses needs no step and no warning", async () => {
      api.getAccessOverview.mockResolvedValue(
        overview({ certificate: { kind: "external", trustFile: null }, homeTrusted: true }),
      );
      await mount();
      await runOn("home");
      expect(warned("claude-code")).toBe(false);
      const steps = await select("claude-code");
      expect(steps.querySelector(".access-agent-public")).toBeNull();
      expect(steps.querySelector(".access-agent-trust")).toBeNull();
      expect(commands().some((command) => command?.includes(HOME_NAME))).toBe(true);
    });

    test("a managed integration pairs against the chosen home address, pinned", async () => {
      api.getAccessOverview.mockResolvedValue(overview());
      await mount();
      await runOn("home");
      await select("hermes");
      expect(commands()[0]).toContain("--gateway-url https://omnesis.local:7600");
      expect(commands()[0]).toContain(`--trust-fingerprint sha256:${FINGERPRINT}`);
    });
  });
});

test("away from home, the loopback address is never offered as another address to pick", () => {
  const RELAY = "https://g-fictional.relay.example.test/mcp";
  const oauth = {
    resource: RELAY,
    resources: [LOCAL, RELAY].map((resource) => ({ resource, servedByGateway: false, direct: false, publiclyTrusted: true })),
  };
  const relay = { state: "off", url: RELAY };
  const codex = agentSetups(oauth, { relay, location: "away" }).find((agent: { id: string }) => agent.id === "codex");
  const paragraphs = codex.addressNotice.notice.paragraphs.map((parts: unknown[]) =>
    parts.map((part) => (typeof part === "string" ? part : (part as { strong?: string; text?: string }).strong ?? (part as { text?: string }).text)).join(""),
  );
  expect(paragraphs).toEqual([
    "Remote access is turned off. This address does not answer right now.",
    "Turn it on in Settings, Connectivity.",
  ]);
});

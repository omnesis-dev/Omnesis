// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Access page's connect dialog with the optional cloud relay: which
// addresses it offers, which one it starts on, and what each agent is told
// about the selected one, per relay situation.

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

vi.mock("../api.js", () => api);
vi.mock("../lib/router.js", () => router);
vi.mock("../lib/cloud-relay-api.js", () => relayApi);
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }));

// @ts-expect-error — portal modules are plain JS.
import { AccessView } from "./access.js";

const RELAY = "https://g-fictional.relay.example.test/mcp";
const TAILNET = "https://100.64.0.7:7600/mcp";
const LOCAL = "https://localhost:7600/mcp";
const OWN = "https://gateway.example.org/mcp";

const HOSTED = [
  ["claude-apps", "Claude apps", "Claude connects from Anthropic's servers"],
  ["chatgpt", "ChatGPT", "ChatGPT connects from OpenAI's servers"],
] as const;
const LOCAL_AGENTS = ["claude-code", "codex", "grok-bot", "antigravity", "openclaw", "hermes"];

function overview(resource: string, extra: Record<string, unknown> = {}, others: string[] = [RELAY]) {
  return {
    principals: [],
    levels: [],
    oauth: {
      resource,
      resources: [resource, ...others].map((entry) => ({
        resource: entry,
        servedByGateway: false,
        direct: false,
        publiclyTrusted: true,
      })),
      ...extra,
    },
  };
}

function relayStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    configured: true,
    serviceConfigured: true,
    enrollment: { state: "enrolled" },
    tunnel: { state: "online" },
    publicMcp: { ready: true, url: RELAY },
    ...overrides,
  };
}
const OFF = relayStatus({ enabled: false, tunnel: { state: "disabled" }, publicMcp: { ready: false, url: RELAY } });
const CHECKING = relayStatus({ publicMcp: { ready: false, url: RELAY } });
const NOT_CONNECTED = relayStatus({
  enabled: false,
  configured: false,
  enrollment: { state: "unconfigured" },
  tunnel: { state: "disabled" },
  publicMcp: { ready: false },
});

describe("Access page with the cloud relay", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    api.getAccessAuthorization.mockResolvedValue({ request: null });
    api.listDevices.mockResolvedValue({ items: [] });
    relayApi.relayManagement.mockResolvedValue(relayStatus());
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    vi.useRealTimers();
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function mount(props: Record<string, unknown> = {}) {
    await act(async () => { render(h(AccessView, { connectOpen: true, ...props }), host); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
  }

  const card = (id: string) => host.querySelector<HTMLButtonElement>(`button[data-agent='${id}']`)!;
  async function select(id: string) {
    await act(async () => { card(id).click(); });
    await act(async () => { await Promise.resolve(); });
    return host.querySelector(".access-agent-steps")!;
  }
  const warned = () =>
    [...host.querySelectorAll("button[data-agent]")]
      .filter((entry) => entry.querySelector(".access-agent-warning"))
      .map((entry) => entry.getAttribute("data-agent"));
  const notice = () => host.querySelector(".access-agent-public")!;
  const noticeParagraphs = () => [...notice().querySelectorAll("p")].map((entry) => entry.textContent?.trim());
  // The address is picked where it is shown: the drop-down when there is a choice, else plain text.
  const shownAddress = () =>
    host.querySelector<HTMLSelectElement>("#access-mcp-address")?.value ??
    host.querySelector(".access-connect-step .access-mcp-resource code")?.textContent;
  const addressSelect = () => host.querySelector<HTMLSelectElement>("#access-mcp-address");
  const addressOptions = () => [...(addressSelect()?.querySelectorAll("option") ?? [])].map((option) => option.textContent);
  async function pick(resource: string) {
    const element = addressSelect()!;
    await act(async () => {
      // linkedom's select has no settable value; the handler reads this one.
      Object.defineProperty(element, "value", { configurable: true, value: resource });
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  }
  const commands = () => [...host.querySelectorAll(".access-agent-steps .access-agent-command code")].map((entry) => entry.textContent ?? "");

  describe("a gateway that never linked an account", () => {
    beforeEach(() => relayApi.relayManagement.mockResolvedValue(NOT_CONNECTED));

    test("the owner's own public address: publishing advice, and the account offered as one more way", async () => {
      api.getAccessOverview.mockResolvedValue(overview(OWN, {}, []));
      await mount();
      expect(relayApi.relayManagement).toHaveBeenCalledWith("");
      expect(addressSelect()).toBeNull();
      expect(shownAddress()).toBe(OWN);
      for (const [id, , needs] of HOSTED) {
        const steps = await select(id);
        expect(noticeParagraphs()).toEqual([
          `${needs}, so the address above must be reachable from the Internet${id === "chatgpt" ? " on port 443" : ""}.`,
          "Publish the gateway with Tailscale on this computer or a domain of your own, in Settings, Connectivity.",
          "Or connect this gateway to an Omnesis account in Settings, Connectivity to give it a public address.",
        ]);
        expect(notice().classList.contains("is-warning")).toBe(false);
        expect(steps.textContent).toContain("the address above");
        expect(steps.textContent).not.toMatch(/Omnesis address|from the list/u);
        await select(id);
      }
    });

    test("the localhost banner offers the account for hosted apps, and the caption keeps its sentence", async () => {
      api.getAccessOverview.mockResolvedValue(overview(LOCAL, { loopbackOnly: true }, []));
      await mount();
      expect(host.querySelector(".access-oauth-blocker")?.textContent?.replace(/\s+/gu, " ")).toContain(
        "Settings, Connectivity. This can be a private network address. ChatGPT, Claude apps and Grok bot need an Internet-reachable address. Connecting this gateway to an Omnesis account in Settings, Connectivity gives it one.",
      );
      // With no address away from home the dialog opens on this computer, where hosted apps are not offered.
      expect(host.querySelector(".access-connect-dialog")?.textContent).toContain(
        "Paste it into Claude Code, Codex, or another agent on this computer.",
      );
      expect(host.querySelector("button[data-agent='chatgpt']")).toBeNull();
    });

  });

  describe("a single address", () => {
    test("the relay's own, ready: plain display, usable by every agent, no publishing advice", async () => {
      api.getAccessOverview.mockResolvedValue(overview(RELAY, { loopbackOnly: true }, []));
      await mount();
      expect(relayApi.relayManagement).toHaveBeenCalledWith("");
      expect(addressSelect()).toBeNull();
      expect(shownAddress()).toBe(RELAY);
      // The gateway marks every overview without a configured public URL; a relay address is no localhost address.
      expect(host.querySelector(".access-oauth-blocker")).toBeNull();
      expect(host.querySelector(".access-connect-dialog")?.textContent).toContain("Paste it into ChatGPT, Claude, Codex");
      // Away from home, where hosted apps are listed, their setups are named as such.
      expect(host.querySelector(".access-agent-setup-label")?.textContent).toBe("Setup for common agents");
      expect(warned()).toEqual([]);
      for (const [id, , needs] of HOSTED) {
        const steps = await select(id);
        expect(noticeParagraphs()).toEqual([`${needs}, and this address is reachable from the Internet.`]);
        expect(notice().getAttribute("role")).toBeNull();
        expect(steps.textContent).not.toMatch(/must be reachable|Funnel|domain of your own|private/u);
        expect(steps.textContent).toContain("with the address above");
        await select(id);
      }
    });

    test("the relay's own, turned off: every agent is told, and none is blamed on a certificate", async () => {
      relayApi.relayManagement.mockResolvedValue(OFF);
      const unanswered = overview(RELAY, {}, []);
      unanswered.oauth.resources[0]!.publiclyTrusted = false;
      api.getAccessOverview.mockResolvedValue(unanswered);
      await mount();
      expect(addressSelect()).toBeNull();
      expect(warned()).toEqual(["claude-code", "codex", "chatgpt", "claude-apps", "grok-bot", "muse", "antigravity", "openclaw", "hermes"]);
      await select("claude-apps");
      expect(noticeParagraphs()).toEqual([
        "Remote access is turned off. Claude connects from Anthropic's servers, so it cannot reach this address right now.",
        "Turn it on in Settings, Connectivity.",
      ]);
      await select("claude-apps");
      const steps = await select("claude-code");
      expect(noticeParagraphs()).toEqual([
        "Remote access is turned off. This address does not answer right now.",
        "Turn it on in Settings, Connectivity.",
      ]);
      expect(steps.textContent).not.toMatch(/certificate/u);
      expect(commands()).toEqual([]);
    });

    test("a private one on a gateway not connected to an account: the existing options, and one line", async () => {
      relayApi.relayManagement.mockResolvedValue(NOT_CONNECTED);
      api.getAccessOverview.mockResolvedValue(overview(TAILNET, {}, []));
      await mount();
      expect(addressSelect()).toBeNull();
      expect(warned()).toEqual(["chatgpt", "claude-apps", "grok-bot", "muse"]);
      await select("claude-apps");
      expect(noticeParagraphs()).toEqual([
        "This address is private. Claude connects from Anthropic's servers, so it cannot reach this gateway until you publish it.",
        "Publish the gateway with Tailscale on this computer or a domain of your own, in Settings, Connectivity.",
        "Or connect this gateway to an Omnesis account in Settings, Connectivity to give it a public address.",
      ]);
      expect([...notice().querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
        "/portal/settings/host-tailscale",
        "/portal/settings/own-address",
        "/portal/settings/account",
      ]);
    });
  });

  describe("the owner's public address and a ready Omnesis address", () => {
    beforeEach(() => {
      api.getAccessOverview.mockResolvedValue(overview(OWN));
    });

    test("the address is a labelled drop-down that starts on the owner's address", async () => {
      await mount();
      const element = addressSelect()!;
      expect(element.tagName).toBe("SELECT");
      expect(element.getAttribute("aria-label")).toBe("MCP server address");
      expect(addressOptions()).toEqual([
        `${OWN}`,
        `${RELAY}`,
      ]);
      expect(element.querySelector("option[selected]")?.getAttribute("value")).toBe(OWN);
      expect(shownAddress()).toBe(OWN);
      expect(host.querySelector(".access-connect-dialog")?.textContent).toContain("Pick the address the agent will use");
      expect(host.querySelector("button[title='Copy MCP resource']")).not.toBeNull();
      expect(warned()).toEqual([]);
    });

    test.each(HOSTED)("%s: the owner's address has no warning and no publishing advice", async (id, _name, needs) => {
      await mount();
      const steps = await select(id);
      expect(noticeParagraphs()).toEqual([
        `${needs}, so the address above must be reachable from the Internet${id === "chatgpt" ? " on port 443" : ""}.`,
      ]);
      expect(notice().classList.contains("is-warning")).toBe(false);
      expect(steps.textContent).not.toMatch(/Funnel|domain of your own/u);
    });

    test("switching to the Omnesis address rewrites the copied address, the commands and the notice", async () => {
      await mount();
      await select("claude-code");
      expect(commands().every((command) => command.includes(OWN))).toBe(true);
      await pick(RELAY);
      expect(shownAddress()).toBe(RELAY);
      expect(commands().length).toBeGreaterThan(0);
      expect(commands().every((command) => command.includes(RELAY) && !command.includes(OWN))).toBe(true);
      expect(host.querySelector(".access-agent-public")).toBeNull();
      await select("claude-code");
      await select("grok-bot");
      expect(commands()[0]).toContain(`my MCP server at ${RELAY}`);
      await select("grok-bot");
      await select("chatgpt");
      expect(noticeParagraphs()).toEqual([
        "ChatGPT connects from OpenAI's servers, and this address is reachable from the Internet.",
      ]);
      await pick(OWN);
      expect(noticeParagraphs()).toEqual([
        "ChatGPT connects from OpenAI's servers, so the address above must be reachable from the Internet on port 443.",
      ]);
    });

    test("a managed integration pairs against the selected address and offers no second choice", async () => {
      await mount();
      await select("openclaw");
      expect(host.querySelector("#access-agent-address")).toBeNull();
      expect(commands().every((command) => command.includes("--gateway-url https://gateway.example.org"))).toBe(true);
      await pick(RELAY);
      expect(commands().every((command) => command.includes("--gateway-url https://g-fictional.relay.example.test"))).toBe(true);
    });

    test("a choice survives the status being read again", async () => {
      vi.useFakeTimers();
      await mount();
      await pick(RELAY);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(relayApi.relayManagement.mock.calls.length).toBeGreaterThan(1);
      expect(shownAddress()).toBe(RELAY);
    });
  });

  describe("a private address and an Omnesis address", () => {
    test("ready: the dialog starts on the Omnesis address, and a hosted app on the private one is sent back to the list", async () => {
      api.getAccessOverview.mockResolvedValue(overview(LOCAL, { loopbackOnly: true }));
      await mount();
      expect(host.querySelector(".access-oauth-blocker")?.textContent?.replace(/\s+/gu, " ")).toContain(
        "Settings, Connectivity. This can be a private network address. ChatGPT, Claude apps and Grok bot can use this gateway's Omnesis address.",
      );
      // The loopback address is this computer's, not a choice away from home.
      expect(addressSelect()).toBeNull();
      expect(shownAddress()).toBe(RELAY);
      expect(warned()).toEqual([]);
      await select("claude-apps");
      expect(noticeParagraphs()).toEqual([
        "Claude connects from Anthropic's servers, and this address is reachable from the Internet.",
      ]);
      await select("claude-apps");
      const machine = host.querySelector<HTMLInputElement>("input[name='access-agent-location'][value='machine']")!;
      await act(async () => { machine.dispatchEvent(new window.Event("change", { bubbles: true })); });
      expect(shownAddress()).toBe(LOCAL);
      // Hosted apps can never reach it, so they are not offered there.
      expect(host.querySelector("button[data-agent='claude-apps']")).toBeNull();
      await select("claude-code");
      expect(commands().every((command) => command.includes(LOCAL))).toBe(true);
    });

    test.each([
      ["turned off", OFF, "turned off", "Remote access is turned off.", "Turn it on in Settings, Connectivity."],
      ["still being checked", CHECKING, "being checked", "This gateway's Omnesis address is still being checked.", "This takes up to a minute. Follow it in Settings, Connectivity."],
    ])("%s: the option is not selected, and both hosted apps say so with a link to the relay page", async (_name, status, marker, headline, action) => {
      relayApi.relayManagement.mockResolvedValue(status);
      api.getAccessOverview.mockResolvedValue(overview(TAILNET));
      await mount();
      expect(addressOptions()).toEqual([
        `${TAILNET}`,
        `${RELAY}`,
      ]);
      expect(shownAddress()).toBe(TAILNET);
      expect(warned()).toEqual(["chatgpt", "claude-apps", "grok-bot", "muse"]);
      for (const [id, , needs] of HOSTED) {
        const steps = await select(id);
        expect(noticeParagraphs()).toEqual([
          `This address is private. ${needs}, so it cannot reach this gateway until you publish it.`,
          `This gateway has an Omnesis address. ${headline} ${action}`,
        ]);
        expect(steps.textContent).not.toMatch(/Funnel|domain of your own/u);
        const link = notice().querySelector("a")!;
        expect(link.textContent).toBe("Settings, Connectivity");
        expect(link.getAttribute("href")).toBe("/portal/settings/relay");
        await select(id);
      }
      // Still selectable: selecting it says what is wrong with it, for every agent.
      await pick(RELAY);
      expect(shownAddress()).toBe(RELAY);
      expect(warned().length).toBe(9);
      await select("chatgpt");
      expect(noticeParagraphs()).toEqual([
        `${headline} ChatGPT connects from OpenAI's servers, so it cannot reach this address right now.`,
        action,
      ]);
      expect(notice().querySelector("strong")?.textContent).toBe(headline);
      expect(notice().getAttribute("role")).toBe("alert");
      await select("chatgpt");
      await select("codex");
      expect(noticeParagraphs()).toEqual([
        `${headline} This address does not answer right now.`,
        action,
        "Or pick another address from the list above.",
      ]);
      await act(async () => {
        notice().querySelector("a")!.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
      });
      expect(router.navigate).toHaveBeenCalledWith("/portal/settings/relay");
    });

    test("an open dialog follows the check and moves to the Omnesis address once it answers", async () => {
      vi.useFakeTimers();
      relayApi.relayManagement.mockResolvedValue(CHECKING);
      api.getAccessOverview.mockResolvedValue(overview(TAILNET));
      await mount();
      await select("claude-apps");
      expect(shownAddress()).toBe(TAILNET);
      expect(noticeParagraphs()[1]).toMatch(/still being checked/u);
      relayApi.relayManagement.mockResolvedValue(relayStatus());
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(shownAddress()).toBe(RELAY);
      expect(noticeParagraphs()).toEqual(["Claude connects from Anthropic's servers, and this address is reachable from the Internet."]);
    });
  });

  test("the owner's public address beside an Omnesis address that is turned off keeps working, with no advice", async () => {
    relayApi.relayManagement.mockResolvedValue(OFF);
    api.getAccessOverview.mockResolvedValue(overview(OWN));
    await mount();
    expect(addressOptions()[1]).toBe(`${RELAY}`);
    expect(shownAddress()).toBe(OWN);
    expect(warned()).toEqual([]);
    await select("claude-apps");
    expect(noticeParagraphs()).toEqual([
      "Claude connects from Anthropic's servers, so the address above must be reachable from the Internet.",
    ]);
    await pick(RELAY);
    expect(noticeParagraphs()).toEqual([
      "Remote access is turned off. Claude connects from Anthropic's servers, so it cannot reach this address right now.",
      "Turn it on in Settings, Connectivity.",
      "Or pick another address from the list above.",
    ]);
  });

  test("a status that cannot be read leaves the page as it is without the relay", async () => {
    relayApi.relayManagement.mockRejectedValue(new Error("unavailable"));
    api.getAccessOverview.mockResolvedValue(overview(TAILNET));
    await mount();
    expect(addressSelect()).toBeNull();
    expect(shownAddress()).toBe(TAILNET);
    await select("claude-apps");
    expect(noticeParagraphs()).toEqual([
      "This address is private. Claude connects from Anthropic's servers, so it cannot reach this gateway until you publish it.",
      "Publish the gateway with Tailscale on this computer or a domain of your own, in Settings, Connectivity.",
    ]);
  });
});

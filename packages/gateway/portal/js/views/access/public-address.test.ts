// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  ACCOUNT_SETTINGS_ROUTE,
  addressChoices as untypedAddressChoices,
  localClientAddress as untypedLocalClientAddress,
  hostedClientAddress as untypedHostedClientAddress,
  hostedClientsHint as untypedHostedClientsHint,
  leadsWithLocalAddress,
  relayPublicAddress as untypedRelayPublicAddress,
  // @ts-expect-error — portal modules are plain JS.
} from "./public-address.js";
// @ts-expect-error — portal modules are plain JS.
import { agentSetups as untypedAgentSetups } from "./client-setup.js";

type Part = string | { strong: string } | { href: string; text: string } | { route: string; text: string };
interface Relay {
  state: string;
  url?: string;
}
interface Notice {
  usable: boolean;
  notice: { warning: boolean; paragraphs: Part[][] };
}
interface Option {
  resource: string;
  kind: string;
  text: string;
}
interface Choices {
  options: Option[];
  selectable: boolean;
  initial: string;
}
interface Setup {
  id: string;
  blocked?: boolean;
  note: Part[];
  commands: Array<{ value: string }>;
  addressNotice?: Notice;
}
type Oauth = { resource: string; loopbackOnly?: boolean; resources?: Array<{ resource: string }> };
type Agent = { needsPublicAddress: string; standardPortOnly?: string };

const relayPublicAddress = untypedRelayPublicAddress as (
  cloudRelay: boolean,
  status: Record<string, unknown> | null,
  oauth: Oauth | null,
) => Relay;
const addressChoices = untypedAddressChoices as (oauth: Oauth, relay?: Relay) => Choices;
const hostedClientAddress = untypedHostedClientAddress as (
  agent: Agent,
  resource: string,
  relay?: Relay,
  choices?: Choices,
) => Notice;
const localClientAddress = untypedLocalClientAddress as (
  resource: string,
  relay?: Relay,
  choices?: Choices,
) => Notice | null;
const hostedClientsHint = untypedHostedClientsHint as (relay?: Relay) => Part[] | null;
const agentSetups = untypedAgentSetups as (oauth: Oauth, options?: { relay?: Relay }) => Setup[];

const RELAY = "https://g-fictional.relay.example.test/mcp";
const TAILNET = "https://100.64.0.7:7600/mcp";
const LOCAL = "https://localhost:7600/mcp";
const OWN = "https://gateway.example.org/mcp";

const CLAUDE = { needsPublicAddress: "Claude connects from Anthropic's servers" };
const CHATGPT = {
  needsPublicAddress: "ChatGPT connects from OpenAI's servers",
  standardPortOnly: "ChatGPT connects only on the standard HTTPS port, 443",
};

function oauth(resource: string, others: string[] = [RELAY]): Oauth {
  return { resource, resources: [resource, ...others].map((entry) => ({ resource: entry })) };
}

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function text(parts: Part[]): string {
  return parts
    .map((part) => (typeof part === "string" ? part : "strong" in part ? part.strong : part.text))
    .join("");
}
const paragraphs = (notice: Notice) => notice.notice.paragraphs.map(text);
const routes = (notice: Notice) =>
  notice.notice.paragraphs.flat().flatMap((part) => (typeof part === "object" && "route" in part ? [part.route] : []));
const links = (notice: Notice) =>
  notice.notice.paragraphs.flat().flatMap((part) => (typeof part === "object" && "href" in part ? [part.href] : []));

/** The notice for `resource` selected among the addresses of a gateway that leads with `lead`. */
function hosted(agent: Agent, resource: string, relay: Relay, lead = resource, others: string[] = [RELAY]) {
  return hostedClientAddress(agent, resource, relay, addressChoices(oauth(lead, others), relay));
}

const FUNNEL_PARAGRAPH = "Publish the gateway with Tailscale Funnel or use a domain of your own.";

describe("relayPublicAddress", () => {
  test("shows nothing of the relay when the gateway does not advertise it", () => {
    expect(relayPublicAddress(false, status(), oauth(TAILNET))).toEqual({ state: "none" });
  });

  test("shows nothing until the status has been read", () => {
    expect(relayPublicAddress(true, null, oauth(TAILNET))).toEqual({ state: "none" });
  });

  test("a gateway with the feature on and no public address is not connected", () => {
    const unconnected = status({ enabled: false, configured: false, enrollment: { state: "unconfigured" }, tunnel: { state: "disabled" }, publicMcp: { ready: false } });
    expect(relayPublicAddress(true, unconnected, oauth(TAILNET, []))).toEqual({ state: "not-connected" });
  });

  test("an installation that cannot connect to an account is offered nothing", () => {
    const unavailable = status({ enabled: false, serviceConfigured: false, publicMcp: { ready: false } });
    expect(relayPublicAddress(true, unavailable, oauth(TAILNET, []))).toEqual({ state: "none" });
  });

  test.each([
    ["ready", status()],
    ["checking", status({ publicMcp: { ready: false, url: RELAY } })],
    ["unreachable", status({ publicMcp: { ready: false, url: RELAY, lastError: "public-endpoint-unreachable" } })],
    ["disconnected", status({ tunnel: { state: "offline" }, publicMcp: { ready: false, url: RELAY } })],
    ["disconnected", status({ tunnel: { state: "connecting" }, publicMcp: { ready: false, url: RELAY } })],
    ["off", status({ enabled: false, tunnel: { state: "disabled" }, publicMcp: { ready: false, url: RELAY } })],
  ])("a connected gateway's public address is %s", (state, relayStatus) => {
    expect(relayPublicAddress(true, relayStatus, oauth(TAILNET))).toEqual({ state, url: RELAY });
  });

  test("remote access turned off outranks a stale ready answer", () => {
    expect(relayPublicAddress(true, status({ enabled: false }), oauth(TAILNET)).state).toBe("off");
  });

  test("never offers an address the gateway does not authorize", () => {
    expect(relayPublicAddress(true, status(), oauth(TAILNET, []))).toEqual({ state: "none" });
    expect(relayPublicAddress(true, status(), { resource: TAILNET })).toEqual({ state: "none" });
    expect(relayPublicAddress(true, status(), { resource: RELAY })).toEqual({ state: "ready", url: RELAY });
  });

  test("never offers an address that is not plain https", () => {
    const plain = status({ publicMcp: { ready: true, url: "http://g-fictional.relay.example.test/mcp" } });
    expect(relayPublicAddress(true, plain, oauth(TAILNET))).toEqual({ state: "not-connected" });
  });
});

const READY: Relay = { state: "ready", url: RELAY };
const UNAVAILABLE = [
  ["off", "turned off", "Remote access is turned off.", "Turn it on in Settings, Account."],
  ["checking", "being checked", "This gateway's Omnesis address is still being checked.", "This takes up to a minute. Follow it in Settings, Account."],
  ["disconnected", "not connected", "Remote access is not connected right now.", "Check it in Settings, Account."],
  ["unreachable", "not reachable", "This gateway's Omnesis address could not be reached.", "Check remote access in Settings, Account."],
] as const;
const PRIVATE_CLAUDE =
  "This address is private. Claude connects from Anthropic's servers, so it cannot reach this gateway until you publish it.";
const REACHABLE_CLAUDE =
  "Claude connects from Anthropic's servers, so the address above must be reachable from the Internet.";

describe("addressChoices", () => {
  test("without the relay there is one address shown and nothing to pick, however many the gateway lists", () => {
    expect(addressChoices({ resource: OWN })).toMatchObject({ selectable: false, initial: OWN });
    expect(addressChoices(oauth(TAILNET, [OWN]))).toMatchObject({ selectable: false, initial: TAILNET });
    expect(addressChoices(oauth(TAILNET, [OWN]), { state: "none" })).toMatchObject({ selectable: false, initial: TAILNET });
  });

  test("a single address is never a choice, whatever the relay says", () => {
    expect(addressChoices(oauth(RELAY, []), READY)).toMatchObject({ selectable: false, initial: RELAY });
    expect(addressChoices(oauth(TAILNET, []), { state: "not-connected" })).toMatchObject({ selectable: false, initial: TAILNET });
  });

  test("names each address plainly, the one the gateway leads with first and none twice", () => {
    const choices = addressChoices(
      { resource: LOCAL, resources: [OWN, RELAY, LOCAL, TAILNET].map((resource) => ({ resource })) },
      READY,
    );
    expect(choices.selectable).toBe(true);
    expect(choices.options.map((option) => [option.kind, option.text])).toEqual([
      ["machine", `This machine only: ${LOCAL}`],
      ["public", `Your public address: ${OWN}`],
      ["relay", `Omnesis address (remote access): ${RELAY}`],
      ["network", `This network only: ${TAILNET}`],
    ]);
  });

  test.each(UNAVAILABLE)("an Omnesis address that is %s stays in the list, marked", (state, marker) => {
    const choices = addressChoices(oauth(TAILNET), { state, url: RELAY });
    expect(choices.options[1]!.text).toBe(`Omnesis address (${marker}): ${RELAY}`);
    // Nothing that cannot work is selected on the person's behalf.
    expect(choices.initial).toBe(TAILNET);
  });

  test("starts on the owner's public address, else a ready Omnesis address, else the gateway's own lead", () => {
    expect(addressChoices(oauth(OWN), READY).initial).toBe(OWN);
    expect(addressChoices(oauth(LOCAL, [RELAY, OWN]), READY).initial).toBe(OWN);
    expect(addressChoices(oauth(OWN), { state: "off", url: RELAY }).initial).toBe(OWN);
    expect(addressChoices(oauth(TAILNET), READY).initial).toBe(RELAY);
    expect(addressChoices(oauth(LOCAL), READY).initial).toBe(RELAY);
    expect(addressChoices(oauth(LOCAL, [TAILNET]), { state: "not-connected" }).initial).toBe(LOCAL);
  });
});

describe("hostedClientAddress", () => {
  describe("without the relay, as before it existed", () => {
    test("a private address blocks the agent and points at publishing", () => {
      const notice = hostedClientAddress(CLAUDE, TAILNET);
      expect(notice.usable).toBe(false);
      expect(notice.notice.warning).toBe(true);
      expect(paragraphs(notice)).toEqual([PRIVATE_CLAUDE, FUNNEL_PARAGRAPH]);
      expect(links(notice)).toEqual([
        "https://omnesis.dev/docs/connect#tailscale-funnel",
        "https://omnesis.dev/docs/setup#public-domain",
      ]);
      expect(routes(notice)).toEqual([]);
    });

    test("an address the owner published is taken at its word", () => {
      const notice = hostedClientAddress(CLAUDE, OWN);
      expect(notice.usable).toBe(true);
      expect(notice.notice.warning).toBe(false);
      expect(paragraphs(notice)).toEqual([REACHABLE_CLAUDE, FUNNEL_PARAGRAPH]);
    });

    test("an agent that only dials port 443 says so, and is blocked on another port", () => {
      expect(paragraphs(hostedClientAddress(CHATGPT, OWN))[0]).toBe(
        "ChatGPT connects from OpenAI's servers, so the address above must be reachable from the Internet on port 443.",
      );
      const elsewhere = hostedClientAddress(CHATGPT, "https://gateway.example.org:8443/mcp");
      expect(elsewhere.usable).toBe(false);
      expect(paragraphs(elsewhere)).toEqual([
        "This address uses port 8443. ChatGPT connects only on the standard HTTPS port, 443, so it cannot reach this gateway there.",
        FUNNEL_PARAGRAPH,
      ]);
    });

    test("several listed addresses change nothing: there is no list to pick from", () => {
      for (const resource of [TAILNET, LOCAL, OWN]) {
        expect(hosted(CLAUDE, resource, { state: "none" }, resource, [OWN, TAILNET])).toEqual(
          hostedClientAddress(CLAUDE, resource),
        );
      }
    });
  });

  test("a gateway that could connect to an account is told so, beside the existing options", () => {
    const notice = hosted(CLAUDE, TAILNET, { state: "not-connected" }, TAILNET, []);
    expect(notice.usable).toBe(false);
    expect(paragraphs(notice)).toEqual([
      PRIVATE_CLAUDE,
      FUNNEL_PARAGRAPH,
      "Or connect this gateway to an Omnesis account in Settings, Account to give it a public address.",
    ]);
    expect(routes(notice)).toEqual([ACCOUNT_SETTINGS_ROUTE]);
    expect(ACCOUNT_SETTINGS_ROUTE).toBe("/portal/settings/account");
    expect(paragraphs(hosted(CLAUDE, OWN, { state: "not-connected" }, OWN, []))).toEqual([
      REACHABLE_CLAUDE,
      FUNNEL_PARAGRAPH,
      "Or connect this gateway to an Omnesis account in Settings, Account to give it a public address.",
    ]);
  });

  describe("the Omnesis address selected", () => {
    test.each([
      ["the only address", RELAY, [] as string[]],
      ["beside a tailnet address", TAILNET, [RELAY]],
      ["beside the owner's public address", OWN, [RELAY]],
    ])("ready, %s: usable, with no warning and no publishing advice", (_name, lead, others) => {
      const notice = hosted(CLAUDE, RELAY, READY, lead, others);
      expect(notice.usable).toBe(true);
      expect(notice.notice.warning).toBe(false);
      expect(paragraphs(notice)).toEqual([
        "Claude connects from Anthropic's servers, and this address is reachable from the Internet.",
      ]);
      expect(links(notice)).toEqual([]);
      expect(routes(notice)).toEqual([]);
    });

    test.each(UNAVAILABLE)("%s: says so plainly and points at the account settings", (state, _marker, headline, action) => {
      const relay = { state, url: RELAY };
      for (const [lead, others] of [[RELAY, []], [TAILNET, [RELAY]], [LOCAL, [RELAY]]] as const) {
        const notice = hosted(CLAUDE, RELAY, relay, lead, [...others]);
        expect(notice.usable).toBe(false);
        expect(notice.notice.warning).toBe(true);
        expect(paragraphs(notice)).toEqual([
          `${headline} Claude connects from Anthropic's servers, so it cannot reach this address right now.`,
          action,
        ]);
        expect(routes(notice)).toEqual([ACCOUNT_SETTINGS_ROUTE]);
        expect(links(notice)).toEqual([]);
      }
    });

    test.each(UNAVAILABLE)("%s, beside an address that works: that one is suggested too", (state, _marker, headline, action) => {
      expect(paragraphs(hosted(CLAUDE, RELAY, { state, url: RELAY }, OWN))).toEqual([
        `${headline} Claude connects from Anthropic's servers, so it cannot reach this address right now.`,
        action,
        "Or pick another address from the list above.",
      ]);
    });

    test("ready on a port ChatGPT cannot dial: blocked for ChatGPT only", () => {
      const offPort = { state: "ready", url: "https://g-fictional.relay.example.test:8443/mcp" };
      const chatgpt = hosted(CHATGPT, offPort.url, offPort, TAILNET, [offPort.url]);
      expect(chatgpt.usable).toBe(false);
      expect(paragraphs(chatgpt)[0]).toMatch(/^This address uses port 8443\./u);
      expect(hosted(CLAUDE, offPort.url, offPort, TAILNET, [offPort.url]).usable).toBe(true);
    });
  });

  describe("the owner's public address selected", () => {
    test("with an Omnesis address in the list there is no publishing advice, whatever its state", () => {
      for (const state of ["ready", "off", "checking", "disconnected", "unreachable"]) {
        const notice = hosted(CLAUDE, OWN, { state, url: RELAY });
        expect(notice.usable).toBe(true);
        expect(notice.notice.warning).toBe(false);
        expect(paragraphs(notice)).toEqual([REACHABLE_CLAUDE]);
      }
    });
  });

  describe("a private address selected", () => {
    test.each([TAILNET, LOCAL])("%s with a usable address in the list: pick that one, nothing about publishing", (resource) => {
      for (const [relay, others] of [[READY, [RELAY]], [{ state: "off", url: RELAY }, [RELAY, OWN]]] as const) {
        const notice = hosted(CLAUDE, resource, relay, resource, [...others]);
        expect(notice.usable).toBe(false);
        expect(notice.notice.warning).toBe(true);
        expect(paragraphs(notice)).toEqual([PRIVATE_CLAUDE, "Pick another address from the list above."]);
        expect(links(notice)).toEqual([]);
      }
    });

    test.each(UNAVAILABLE)("only an Omnesis address that is %s beside it: turn it on, nothing about publishing", (state, _marker, headline, action) => {
      const notice = hosted(CLAUDE, TAILNET, { state, url: RELAY });
      expect(notice.usable).toBe(false);
      expect(paragraphs(notice)).toEqual([PRIVATE_CLAUDE, `This gateway has an Omnesis address. ${headline} ${action}`]);
      expect(routes(notice)).toEqual([ACCOUNT_SETTINGS_ROUTE]);
      expect(links(notice)).toEqual([]);
    });

    test("only other private addresses beside it: publishing is still the way", () => {
      expect(paragraphs(hosted(CLAUDE, TAILNET, { state: "not-connected" }, TAILNET, [LOCAL]))).toEqual([
        PRIVATE_CLAUDE,
        FUNNEL_PARAGRAPH,
        "Or connect this gateway to an Omnesis account in Settings, Account to give it a public address.",
      ]);
    });

    test("an address on a port ChatGPT cannot dial does not count as usable for it", () => {
      const onPort = "https://gateway.example.org:8443/mcp";
      expect(paragraphs(hosted(CHATGPT, TAILNET, { state: "off", url: RELAY }, TAILNET, [RELAY, onPort]))[1]).toMatch(
        /^This gateway has an Omnesis address\. Remote access is turned off\./u,
      );
      expect(paragraphs(hosted(CLAUDE, TAILNET, { state: "off", url: RELAY }, TAILNET, [RELAY, onPort]))[1]).toBe(
        "Pick another address from the list above.",
      );
    });
  });

  test("every hosted agent reads the same in the same situation", () => {
    const relays: Relay[] = [
      { state: "none" },
      { state: "not-connected" },
      ...["ready", "checking", "off", "disconnected", "unreachable"].map((state) => ({ state, url: RELAY })),
    ];
    const normalize = (notice: Notice, needs: string) =>
      paragraphs(notice).map((paragraph) => paragraph.replace(needs, "It").replace(" on port 443", ""));
    for (const relay of relays) {
      for (const lead of [TAILNET, LOCAL, OWN, RELAY]) {
        for (const resource of new Set([lead, RELAY, OWN])) {
          const others = [RELAY, OWN].filter((entry) => entry !== lead);
          const claude = hosted(CLAUDE, resource, relay, lead, others);
          const chatgpt = hosted(CHATGPT, resource, relay, lead, others);
          expect(normalize(chatgpt, CHATGPT.needsPublicAddress)).toEqual(normalize(claude, CLAUDE.needsPublicAddress));
          expect(chatgpt.usable).toBe(claude.usable);
        }
      }
    }
  });

  test("no sentence about the relay uses an em dash", () => {
    for (const state of ["ready", "checking", "off", "disconnected", "unreachable", "not-connected"]) {
      const relay = { state, url: RELAY };
      for (const resource of [TAILNET, OWN, RELAY]) {
        expect(paragraphs(hosted(CLAUDE, resource, relay, TAILNET, [RELAY, OWN])).join(" ")).not.toMatch(/—/u);
      }
      expect(paragraphs(localClientAddress(RELAY, relay) ?? { usable: true, notice: { warning: false, paragraphs: [] } }).join(" ")).not.toMatch(/—/u);
      expect(text(hostedClientsHint(relay) ?? [])).not.toMatch(/—/u);
      expect(addressChoices(oauth(TAILNET), relay).options.map((option) => option.text).join(" ")).not.toMatch(/—/u);
    }
  });
});

describe("localClientAddress", () => {
  test("an agent on the owner's network has nothing to be told about an address that works", () => {
    for (const resource of [TAILNET, LOCAL, OWN, RELAY]) {
      expect(localClientAddress(resource)).toBeNull();
      expect(localClientAddress(resource, READY, addressChoices(oauth(TAILNET, [RELAY, OWN]), READY))).toBeNull();
    }
    expect(localClientAddress(TAILNET, { state: "off", url: RELAY })).toBeNull();
  });

  test.each(UNAVAILABLE)("an Omnesis address that is %s is no use to it either", (state, _marker, headline, action) => {
    const relay = { state, url: RELAY };
    const alone = localClientAddress(RELAY, relay, addressChoices(oauth(RELAY, []), relay))!;
    expect(alone.usable).toBe(false);
    expect(alone.notice.warning).toBe(true);
    expect(paragraphs(alone)).toEqual([`${headline} This address does not answer right now.`, action]);
    expect(paragraphs(localClientAddress(RELAY, relay, addressChoices(oauth(TAILNET), relay))!)).toEqual([
      `${headline} This address does not answer right now.`,
      action,
      "Or pick another address from the list above.",
    ]);
  });
});

describe("agentSetups with the relay", () => {
  const blocked = (setups: Setup[]) => setups.filter((agent) => agent.blocked).map((agent) => agent.id);
  const trusted = (resource: string, others: string[] = [RELAY]) => ({
    resource,
    resources: [resource, ...others].map((entry) => ({ resource: entry, servedByGateway: false, direct: false, publiclyTrusted: true })),
  });

  test("only the agents that connect from a vendor's servers always carry a notice", () => {
    expect(agentSetups(trusted(TAILNET, [])).filter((agent) => agent.addressNotice).map((agent) => agent.id)).toEqual([
      "chatgpt",
      "claude-apps",
    ]);
  });

  test("with the ready Omnesis address selected every agent's setup is written for it", () => {
    const setups = agentSetups(trusted(RELAY, [TAILNET]), { relay: READY });
    expect(blocked(setups)).toEqual([]);
    for (const agent of setups) {
      for (const command of agent.commands) {
        if (agent.id !== "codex" || command.value.includes("--url")) {
          expect(command.value).toContain("g-fictional.relay.example.test");
        }
        expect(command.value).not.toContain("100.64.0.7");
      }
    }
    expect(text(setups.find((agent) => agent.id === "claude-apps")!.note)).toContain("with the address above");
  });

  test("with a private address selected, hosted agents are blocked and the others are written for it", () => {
    const setups = agentSetups(trusted(TAILNET), { relay: READY });
    expect(blocked(setups)).toEqual(["chatgpt", "claude-apps"]);
    expect(setups.find((agent) => agent.id === "claude-code")!.commands[0]!.value).toContain(TAILNET);
    expect(JSON.stringify(setups.filter((agent) => !agent.addressNotice))).not.toContain("relay.example.test");
  });

  test.each(["off", "checking", "disconnected", "unreachable"])("an Omnesis address that is %s blocks every agent while it is selected, and none otherwise", (state) => {
    const relay = { state, url: RELAY };
    const selected = agentSetups(trusted(RELAY, [OWN]), { relay });
    expect(blocked(selected)).toEqual(selected.map((agent) => agent.id));
    expect(selected.every((agent) => agent.addressNotice?.usable === false && agent.commands.length === 0)).toBe(true);
    expect(blocked(agentSetups(trusted(OWN), { relay }))).toEqual([]);
  });

  test("an address that does not answer is never blamed on its certificate", () => {
    const unanswered = {
      resource: RELAY,
      resources: [{ resource: RELAY, servedByGateway: false, direct: false, publiclyTrusted: false }],
    };
    const claudeCode = agentSetups(unanswered, { relay: { state: "off", url: RELAY } }).find((agent) => agent.id === "claude-code")!;
    expect(claudeCode.blocked).toBe(true);
    expect(paragraphs(claudeCode.addressNotice!)[0]).toBe("Remote access is turned off. This address does not answer right now.");
  });

  test("without the relay every agent is what it was", () => {
    for (const resource of [TAILNET, LOCAL, OWN]) {
      expect(agentSetups(trusted(resource, []), { relay: { state: "none" } })).toEqual(agentSetups(trusted(resource, [])));
      expect(agentSetups(trusted(resource, [])).some((agent) => !agent.addressNotice === Boolean(agent.id.match(/^(chatgpt|claude-apps)$/u)))).toBe(false);
    }
  });
});

describe("hostedClientsHint", () => {
  test("keeps the page's own sentence without the relay", () => {
    expect(hostedClientsHint()).toBeNull();
    expect(hostedClientsHint({ state: "none" })).toBeNull();
  });

  test.each([
    ["ready", "ChatGPT and Claude apps can use this gateway's Omnesis address."],
    ["off", "ChatGPT and Claude apps can use this gateway's Omnesis address. Remote access is turned off. Turn it on in Settings, Account."],
    ["checking", "ChatGPT and Claude apps can use this gateway's Omnesis address. This gateway's Omnesis address is still being checked. This takes up to a minute. Follow it in Settings, Account."],
    ["not-connected", "ChatGPT and Claude apps need an Internet-reachable address. Connecting this gateway to an Omnesis account in Settings, Account gives it one."],
  ])("%s", (state, expected) => {
    expect(text(hostedClientsHint({ state, url: RELAY })!)).toBe(expected);
  });
});

describe("leadsWithLocalAddress", () => {
  test("follows the address, not only the gateway's mark", () => {
    expect(leadsWithLocalAddress({ resource: LOCAL, loopbackOnly: true })).toBe(true);
    expect(leadsWithLocalAddress({ resource: RELAY, loopbackOnly: true })).toBe(false);
    expect(leadsWithLocalAddress({ resource: LOCAL })).toBe(false);
    expect(leadsWithLocalAddress(null)).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Connectivity through its real hooks, with the gateway's routes
// answered by a small in-memory gateway: the relay's, the Tailscale device's,
// the remote-access routes and the config. The page opens on its summary; the
// guided setup is started from there. Fictional data throughout.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const qr = vi.hoisted(() => ({ toCanvas: vi.fn() }));
vi.mock("qrcode", () => ({ default: qr }));

type Json = Record<string, any>;
const gateway = vi.hoisted(() => ({
  relay: null as Json | null,
  tailscale: null as Json | null,
  remote: null as Json | null,
  host: null as Json | null,
  publish: null as Json | null,
  unpublish: null as Json | null,
  check: null as Json | null,
  mcpRefusal: null as Json | null,
  failRemote: false,
  hangHost: false,
  failConfig: false,
  calls: [] as unknown[][],
}));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

vi.mock("../lib/cloud-relay-api.js", async (importOriginal) => ({
  ...(await importOriginal<Json>()),
  gatewayVersion: vi.fn(async () => "1.0.0"),
  relayManagement: vi.fn(async (operation: string, input: unknown, _signal: unknown, method = "POST", options?: unknown) => {
    if (operation === "account/refresh") return {};
    if (operation) gateway.calls.push(["relay", operation, input, method, ...(options ? [options] : [])]);
    const relay = gateway.relay!;
    if (operation === "connect") gateway.relay = waiting();
    if (operation === "connect/cancel") gateway.relay = relayNone();
    if (operation === "enable") gateway.relay = { ...relay, enabled: true, tunnel: { state: "online" }, can: { ...relay.can, enable: false, disable: true } };
    if (operation === "disable") gateway.relay = { ...relay, enabled: false, tunnel: { state: "disabled" }, can: { ...relay.can, enable: true, disable: false } };
    if (operation === "enrollment") gateway.relay = { ...relay, deviceEnrollment: { ...relay.deviceEnrollment, policy: (input as Json).policy } };
    if (operation === "account/unlink") gateway.relay = relayNone();
    return clone(gateway.relay);
  }),
}));
vi.mock("../lib/tailscale-api.js", async (importOriginal) => ({
  ...(await importOriginal<Json>()),
  getTailscale: vi.fn(async () => clone(gateway.tailscale)),
  setTailscaleEnabled: vi.fn(async (enabled: boolean) => {
    gateway.calls.push(["tailscale", "enable", enabled]);
    gateway.tailscale = enabled ? tailscaleSignIn() : tailscaleOff();
    return clone(gateway.tailscale);
  }),
  updateTailscaleSettings: vi.fn(async (patch: Json) => {
    gateway.calls.push(["tailscale", "settings", patch]);
    gateway.tailscale = { ...gateway.tailscale, ...patch };
    return clone(gateway.tailscale);
  }),
}));
vi.mock("../lib/remote-access-api.js", () => ({
  getRemoteAccess: vi.fn(async () => {
    if (gateway.failRemote) throw Object.assign(new Error("down"), { serverMessage: "The gateway is busy." });
    return clone(gateway.remote);
  }),
  updateRemoteAccess: vi.fn(async (patch: Json) => {
    gateway.calls.push(["remote", patch]);
    if (patch.first) gateway.remote!.first = patch.first;
    if (patch.setupCompleted !== undefined) gateway.remote!.setupCompletedAt = patch.setupCompleted ? "2026-11-15T10:00:00Z" : null;
    if (gateway.mcpRefusal) return { ...clone(gateway.remote), mcpRefusal: clone(gateway.mcpRefusal) };
    for (const [id, reach] of Object.entries((patch.mcp ?? {}) as Record<string, string>))
      gateway.remote!.mcpAddresses = gateway.remote!.mcpAddresses.map((row: Json) => (row.id === id ? { ...row, reach } : row));
    return clone(gateway.remote);
  }),
  getHostTailscale: vi.fn(async () => {
    if (gateway.hangHost) return new Promise(() => {});
    gateway.calls.push(["host"]);
    // The gateway says Funnel is on wherever the gateway's pages are public, unless a test says otherwise.
    const found = gateway.host!;
    return clone(found.state === "available" ? { taken: [], funnel: found.publicGateway, ...found } : found);
  }),
  publishHostTailscale: vi.fn(async (isPublic: boolean) => {
    gateway.calls.push(["publish", isPublic]);
    if (gateway.publish!.ok) gateway.host = { ...gateway.host, servesGateway: true, publicGateway: isPublic };
    return clone(gateway.publish);
  }),
  unpublishHostTailscale: vi.fn(async () => {
    gateway.calls.push(["unpublish"]);
    if (gateway.unpublish!.ok) gateway.host = { ...gateway.host, servesGateway: false, publicGateway: false };
    return clone(gateway.unpublish);
  }),
  checkPublicAddress: vi.fn(async (url: string) => {
    gateway.calls.push(["check", url]);
    return clone(gateway.check);
  }),
}));
vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<Json>()),
  patchAdminConfig: vi.fn(async (patch: Json) => {
    gateway.calls.push(["config", patch]);
    if (gateway.failConfig) return { status: 500, ok: false, body: { error: "Couldn't write the configuration file." } };
    const configured = patch.gateway.publicBaseUrl;
    gateway.remote!.publicBaseUrl = { serving: null, configured, restartNeeded: true, way: null };
    return { status: 200, ok: true, body: {} };
  }),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../lib/router.js", () => router);

// @ts-expect-error — portal modules are plain JS.
import { RemoteAccessView } from "./remote-access.js";
// @ts-expect-error — portal modules are plain JS.
import { HostTailscaleView } from "./remote-access/own-pages.js";

function relayNone(): Json {
  return {
    revision: 1, enabled: false, configured: false, serviceConfigured: true, gatewayId: "gw-fictional",
    config: { termsAccepted: false, invitationRequired: false, relayUrl: "https://relay.example.test" },
    enrollment: { state: "unconfigured" }, tunnel: { state: "disabled" }, certificate: { state: "unconfigured" },
    publicMcp: { ready: false }, google: { configured: false },
    can: { configure: true, enable: false, disable: false, reconnect: false, renew: false },
  };
}
function waiting(): Json {
  return {
    ...relayNone(),
    connect: {
      state: "waiting", authorizeUrl: "https://relay.example.test/_relay/sign-in", connectUrl: "https://relay.example.test/connect",
      connectShortUrl: "https://relay.example.test/c", code: "KTPX-4QRD", expiresAt: Date.now() + 600_000,
    },
  };
}
function relayLinked({ enabled = true, policy = "ask", confirmed = true, stepUpRequired = false } = {}): Json {
  return {
    ...relayNone(), enabled, configured: true, hostname: "g-maple.relay.example.test", stepUpRequired,
    enrollment: { state: "enrolled" }, tunnel: { state: enabled ? "online" : "disabled" }, certificate: { state: "valid" },
    account: { activated: true, configured: true, linked: true, canLink: false, canUnlink: true, pendingUnlink: false },
    deviceEnrollment: {
      policy,
      trustedSignIns: [{ type: "passkey", id: "pk-fictional-0001", source: "link-page" }],
      confirmedSignIns: confirmed ? [{ type: "passkey", id: "pk-fictional-0001", via: "gateway-origin" }] : [],
      confirmOrigin: "https://g-maple.relay.example.test",
    },
    can: { configure: false, enable: !enabled, disable: enabled, reconnect: enabled, renew: true },
  };
}
function tailscaleOff(): Json {
  return {
    enabled: false, deviceName: "omnesis", joinPolicy: "ask", helper: { state: "off" }, connection: "off", signInUrl: null,
    url: null, node: null, owner: null, certificate: null, public: { wanted: false, state: "off" }, joinRequests: [],
  };
}
function tailscaleSignIn(): Json {
  return { ...tailscaleOff(), enabled: true, helper: { state: "running" }, connection: "needs-sign-in", signInUrl: "https://login.tailscale.com/a/fictional0" };
}
function tailscaleConnected(joinPolicy = "ask"): Json {
  return {
    ...tailscaleOff(), enabled: true, joinPolicy, helper: { state: "running" }, connection: "connected",
    url: "https://omnesis.example-net.ts.net", node: { dnsName: "omnesis.example-net.ts.net" }, certificate: { source: "tailscale" },
  };
}
const FLAGS = {
  relay: { cloudRelay: true, tailscaleEmbed: false },
  tailscale: { cloudRelay: false, tailscaleEmbed: true },
  both: { cloudRelay: true, tailscaleEmbed: true },
};

let host: HTMLElement;
let storage: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  storage = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
  host = dom.document.querySelector("main") as unknown as HTMLElement;
  qr.toCanvas.mockResolvedValue(undefined);
  Object.assign(gateway, {
    relay: relayNone(),
    tailscale: tailscaleOff(),
    remote: {
      setupCompletedAt: null, first: "tailscale", features: FLAGS.both,
      publicBaseUrl: { configured: null, setByEnvironment: false, way: null },
      mcpAddresses: [],
    },
    host: { state: "available", dnsName: "studio.example-net.ts.net", port: 443, url: "https://studio.example-net.ts.net", servesGateway: false, publicGateway: false },
    publish: { ok: true, url: "https://studio.example-net.ts.net" },
    unpublish: { ok: true },
    check: {
      url: "https://omnesis.example.org", ok: true,
      steps: [
        { id: "resolves", ok: true, detail: "omnesis.example.org resolves to 203.0.113.24." },
        { id: "certificate", ok: true, detail: "The certificate is valid for omnesis.example.org." },
        { id: "answers", ok: true, detail: "This gateway answered at that address." },
      ],
    },
    mcpRefusal: null,
    failRemote: false,
    hangHost: false,
    failConfig: false,
    calls: [],
  });
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
async function mount(flags: Json) {
  gateway.remote!.features = flags;
  await act(async () => render(h(RemoteAccessView, flags), host));
  await settle();
}
async function remount(flags: Json) {
  render(null, host);
  await mount(flags);
}
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const heading = () => host.querySelector(".access-wizard-copy h3")?.textContent?.trim();
const steps = () => [...host.querySelectorAll(".access-wizard-steps button")].map((b) => b.textContent?.trim());
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const link = (label: string) =>
  [...host.querySelectorAll("a")].find((a) => a.textContent?.trim() === label) as HTMLAnchorElement | undefined;
const calls = (kind: string) => gateway.calls.filter((call) => call[0] === kind);
async function click(label: string) {
  const target = button(label);
  expect(target, `button "${label}"`).toBeTruthy();
  await act(async () => target!.click());
  await settle();
}
async function toggle(selector: string, checked: boolean) {
  const input = host.querySelector(selector) as HTMLInputElement;
  expect(input, selector).toBeTruthy();
  await act(async () => {
    input.checked = checked;
    input.dispatchEvent(new (window as any).Event("change"));
  });
  await settle();
}
const way = (key: string) => host.querySelector(`#remote-access-way-${key}`) as HTMLInputElement | null;
/** Whether a box or radio is checked: linkedom keeps Preact's `checked` as an attribute until a test sets the property. */
const isChecked = (input: Element | null | undefined) =>
  input ? (Object.hasOwn(input, "checked") ? (input as HTMLInputElement).checked : input.hasAttribute("checked")) : undefined;
/**
 * Confirm a dialog without bubbling: linkedom calls an ancestor's listener with the
 * clicked element as `this`, so Preact would run the button's handler once per
 * ancestor that also handles clicks, as the dialog's backdrop does.
 */
async function confirmOnce(label: string) {
  const target = button(label);
  expect(target, `button "${label}"`).toBeTruthy();
  await act(async () => void target!.dispatchEvent(new (window as any).Event("click", { bubbles: false })));
  await settle();
}
async function confirmModal() {
  await act(async () => (host.querySelector(".confirm-modal .btn-primary") as HTMLButtonElement).click());
  await settle();
}
async function type(selector: string, value: string) {
  const input = host.querySelector(selector) as HTMLInputElement;
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new (window as any).Event("input"));
  });
}
async function submit(selector: string) {
  await act(async () => {
    (host.querySelector(selector) as HTMLFormElement).dispatchEvent(new (window as any).Event("submit", { cancelable: true }));
  });
  await settle();
}

const HOST_URL = "https://studio.example-net.ts.net";
/** Opens the guided setup from the summary, whichever way the summary words it. */
async function startSetup() {
  await click(button("Set up step by step") ? "Set up step by step" : "Run the setup again");
}
/** A saved setup at `step`, as a reload or a sign-in that left the page would find it. */
function savedSetup(step: string, over: Json = {}) {
  storage.set(
    "omnesis.remote-access.setup",
    JSON.stringify({ mode: "setup", step, resume: null, host: null, domain: false, url: "", ...over }),
  );
}
const items = () => [...host.querySelectorAll(".remote-access-item")];
const item = (title: string) => items().find((li) => li.querySelector(".remote-access-item-title")?.textContent === title);
const mark = (title: string) => item(title)?.className.replace("remote-access-item is-", "");
const detail = (title: string) => item(title)?.querySelector(".remote-access-item-detail")?.textContent?.replace(/\s+/g, " ").trim();
const MCP_CHOICES: Record<string, string[]> = {
  relay: ["off", "public"],
  tailnet: ["off", "private", "public"],
  host: ["off", "private", "public"],
  domain: ["off", "on"],
};
const mcpRow = (id: string, over: Json = {}) => ({
  id,
  url: { relay: "https://g-maple.relay.example.test", host: HOST_URL, domain: "https://omnesis.example.org" }[id] ?? null,
  reach: { relay: "public", tailnet: "private", host: "private", domain: "on" }[id],
  choices: MCP_CHOICES[id],
  available: true,
  ...over,
});

describe("which readers run", () => {
  test("relay only reads nothing of Tailscale; Tailscale only reads nothing of the relay", async () => {
    const relayApi = await import(
      // @ts-expect-error — portal modules are plain JS.
      "../lib/cloud-relay-api.js"
    );
    const tailscaleApi = await import(
      // @ts-expect-error — portal modules are plain JS.
      "../lib/tailscale-api.js"
    );
    await mount(FLAGS.relay);
    expect(tailscaleApi.getTailscale).not.toHaveBeenCalled();
    expect(relayApi.relayManagement).toHaveBeenCalled();
    render(null, host);
    vi.clearAllMocks();
    await mount(FLAGS.tailscale);
    expect(relayApi.relayManagement).not.toHaveBeenCalled();
    expect(tailscaleApi.getTailscale).toHaveBeenCalled();
  });

  test("neither feature reads either, and the page still offers this computer's Tailscale, a domain and MCP", async () => {
    const relayApi = await import(
      // @ts-expect-error — portal modules are plain JS.
      "../lib/cloud-relay-api.js"
    );
    const tailscaleApi = await import(
      // @ts-expect-error — portal modules are plain JS.
      "../lib/tailscale-api.js"
    );
    await mount({ cloudRelay: false, tailscaleEmbed: false });
    expect(relayApi.relayManagement).not.toHaveBeenCalled();
    expect(tailscaleApi.getTailscale).not.toHaveBeenCalled();
    expect(heading()).toBe("Connectivity");
    expect(items().map((li) => li.querySelector(".remote-access-item-title")?.textContent)).toEqual([
      "Tailscale on this computer",
      "Your own domain or reverse proxy",
      "MCP server",
    ]);
    expect(text()).not.toContain("Omnesis account");
    expect(text()).not.toContain("New devices");
    await startSetup();
    expect(steps()).toEqual(["1Remote connection"]);
    expect(way("tailscale")).toBeNull();
    expect(way("relay")).toBeNull();
    expect(way("host")).not.toBeNull();
    expect(way("domain")).not.toBeNull();
    expect(button("Finish")).toBeTruthy();
  });

  test("a failed load says so and tries again", async () => {
    gateway.failRemote = true;
    await mount(FLAGS.both);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The gateway is busy.");
    gateway.failRemote = false;
    await click("Try again");
    expect(heading()).toBe("Connectivity");
  });
});

describe("the summary", () => {
  test("opens first, with one line per way in, each opening its own page", async () => {
    gateway.relay = relayLinked();
    gateway.tailscale = tailscaleConnected();
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: true };
    gateway.remote!.mcpAddresses = [mcpRow("relay"), mcpRow("host", { reach: "off" }), mcpRow("domain", { available: false, url: null })];
    await mount(FLAGS.both);
    expect(heading()).toBe("Connectivity");
    expect(mark("Linked to your Omnesis account")).toBe("on");
    expect(mark("This gateway's own Tailscale device")).toBe("on");
    expect(detail("This gateway's own Tailscale device")).toBe(
      "https://omnesis.example-net.ts.net, with a trusted certificate, on your Tailscale network only. Not public on the Internet.",
    );
    expect(mark("Omnesis relay")).toBe("on");
    expect(mark("Tailscale on this computer")).toBe("on");
    expect(detail("Tailscale on this computer")).toBe(`${HOST_URL}, public on the Internet.`);
    expect(mark("Your own domain or reverse proxy")).toBe("off");
    expect(detail("MCP server")).toBe(["On", "Omnesis relay."].join(" "));
    // Each address opens the portal there, in a new tab.
    const address = item("Tailscale on this computer")!.querySelector("a")!;
    expect(address.getAttribute("href")).toBe(`${HOST_URL}/portal/`);
    expect(address.getAttribute("target")).toBe("_blank");
    for (const [label, page] of [
      ["Omnesis account", "/portal/settings/account"],
      ["This gateway's own Tailscale device", "/portal/settings/tailscale"],
      ["Omnesis relay", "/portal/settings/relay"],
      ["Tailscale on this computer", "/portal/settings/host-tailscale"],
      ["Your own domain", "/portal/settings/own-address"],
      ["MCP server", "/portal/settings/mcp"],
    ]) {
      await act(async () => (host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click());
      expect(router.navigate).toHaveBeenLastCalledWith(page);
    }
    // Both the device and the relay can answer: the order is chosen in place.
    await toggle('input[name="remote-access-first"][value="relay"]', true);
    expect(calls("remote")).toEqual([["remote", { first: "relay" }]]);
    expect(button("Run the setup again")).toBeTruthy();
  });

  test("Tailscale on this computer serving only the tailnet says it is not public", async () => {
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: false };
    await mount({ cloudRelay: false, tailscaleEmbed: false });
    expect(mark("Tailscale on this computer")).toBe("on");
    expect(detail("Tailscale on this computer")).toBe(`${HOST_URL}, on your Tailscale network only. Not public on the Internet.`);
  });

  test("a public address that is Tailscale on this computer's is shown once, on that line", async () => {
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: true };
    gateway.remote!.publicBaseUrl = { configured: HOST_URL, setByEnvironment: false, way: "host" };
    await mount(FLAGS.tailscale);
    expect(mark("Tailscale on this computer")).toBe("on");
    expect(mark("Your own domain or reverse proxy")).toBe("off");
    expect(detail("Your own domain or reverse proxy")).toBe("None.");
    // The setup does not start with the domain open either.
    await startSetup();
    expect(isChecked(way("domain"))).toBe(false);
    expect(isChecked(way("host"))).toBe(true);
  });

  test("the owner's own domain is its own line", async () => {
    gateway.remote!.publicBaseUrl = { configured: "https://omnesis.example.org", setByEnvironment: false, way: null };
    await mount(FLAGS.relay);
    expect(mark("Your own domain or reverse proxy")).toBe("on");
    expect(detail("Your own domain or reverse proxy")).toBe("https://omnesis.example.org.");
    await startSetup();
    await click("Skip for now");
    expect(isChecked(way("domain"))).toBe(true);
    expect((host.querySelector("#remote-access-own-url") as HTMLInputElement).value).toBe("https://omnesis.example.org");
  });
});

describe("relay only", () => {
  test("asks about the account, then the connection without the gateway's own Tailscale", async () => {
    await mount(FLAGS.relay);
    expect(button("Set up step by step")).toBeTruthy();
    await startSetup();
    expect(steps()).toEqual(["1Your Omnesis account", "2Remote connection"]);
    expect(heading()).toBe("Do you want an Omnesis account?");
    // Everything to know before an account is one paragraph, and it says it can wait.
    const blurb = host.querySelector(".access-wizard-copy p")?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(blurb).toContain("None of your data goes to Omnesis");
    expect(blurb).toContain("It's optional: skip it and set it up any time from Settings, Connectivity.");
    await click("Skip for now");
    expect(heading()).toBe("How should your devices reach this gateway when they are away from home?");
    expect(steps()[0]).toBe(["✓Your", "Omnesis", "account"].join(" "));
    expect(way("tailscale")).toBeNull();
    // The relay waits for an account, and says where to get one.
    expect(way("relay")?.disabled).toBe(true);
    expect(text()).toContain("Needs an Omnesis account.");
    await toggle("#remote-access-way-domain", true);
    expect(host.querySelector("#remote-access-own-url")).not.toBeNull();
    await click("Back");
    expect(heading()).toBe("Do you want an Omnesis account?");
  });

  test("creating an account runs the relay's own connect, with its sign-in link and code, and cancels", async () => {
    await mount(FLAGS.relay);
    await startSetup();
    await click("Create an account");
    expect(calls("relay")).toEqual([["relay", "connect", { termsAccepted: true, intent: "create" }, "POST"]]);
    expect(heading()).toBe("Sign in to your Omnesis account");
    expect(link("Open sign-in")?.getAttribute("href")).toBe("https://relay.example.test/_relay/sign-in");
    expect(link("Open sign-in")?.getAttribute("target")).toBe("_blank");
    expect(text()).toContain("KTPX-4QRD");
    await act(async () => (host.querySelector(".relay-view button.btn-secondary, .relay-view button") as HTMLButtonElement).click());
    await settle();
    expect(calls("relay").at(-1)).toEqual(["relay", "connect/cancel", {}, "POST"]);
    expect(heading()).toBe("Do you want an Omnesis account?");
    await click("I already have one");
    expect(calls("relay").at(-1)).toEqual(["relay", "connect", { termsAccepted: true, intent: "existing" }, "POST"]);
  });

  test("the relay's link back to step 1 keeps the choices and returns to step 2, across a reload", async () => {
    await mount(FLAGS.relay);
    await startSetup();
    await click("Skip for now");
    await toggle("#remote-access-way-domain", true);
    await click("Set one up in step 1");
    expect(heading()).toBe("Do you want an Omnesis account?");
    // The sign-in leaves the page; the setup comes back where it was.
    expect(JSON.parse(storage.get("omnesis.remote-access.setup")!)).toMatchObject({ step: "account", resume: "connection", domain: true });
    gateway.relay = relayLinked({ enabled: false });
    await remount(FLAGS.relay);
    expect(heading()).toBe("This gateway is linked to your Omnesis account");
    // With an account linked, new devices can ask to join, so that step is asked too.
    expect(steps()).toEqual(["1Your Omnesis account", "2Remote connection", "3New devices"]);
    await click("Continue");
    expect(heading()).toContain("How should your devices reach");
    expect(isChecked(way("domain"))).toBe(true);
    // Now the relay can be turned on and off.
    expect(way("relay")?.disabled).toBe(false);
    await toggle("#remote-access-way-relay", true);
    expect(calls("relay").at(-1)).toEqual(["relay", "enable", {}, "POST"]);
    expect(isChecked(way("relay"))).toBe(true);
    // The ways in are independent: turning the relay on leaves the owner's domain chosen.
    expect(isChecked(way("domain"))).toBe(true);
    expect(text()).toContain("Connected as g-maple.relay.example.test.");
    await click("Manage relay");
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/relay");
    await toggle("#remote-access-way-relay", false);
    expect(calls("relay").at(-1)).toEqual(["relay", "disable", {}, "POST"]);
    // New devices offers no pairing-code-only answer: the account always lets a device ask.
    await click("Continue");
    expect([...host.querySelectorAll('input[name="remote-access-policy"]')].map((r: any) => r.value)).toEqual(["ask", "automatic"]);
    expect(text()).toContain("A new device can ask to join by signing in with your Omnesis account.");
  });

  test("an unconfirmed passkey keeps the relay's checklist, and moving on is the quieter button", async () => {
    gateway.relay = relayLinked({ confirmed: false });
    savedSetup("account");
    await mount(FLAGS.relay);
    expect(text()).toContain("Finish setting up");
    expect(button("Continue with passkey")).toBeTruthy();
    expect(button("Continue")?.className).toBe("btn-secondary");
    await click("Not now");
    expect(text()).not.toContain("Finish setting up");
    expect(button("Continue")?.className).toBe("btn-primary");
  });

  test("an invite-only relay links to its request-access page in the paragraph, and again after a refused sign-in", async () => {
    const signup = { inviteOnly: true, requestAccessUrl: "https://relay.example.test/request-access" };
    const inline = () => [...host.querySelectorAll<HTMLAnchorElement>(".access-wizard-copy a")].find((a) => a.textContent === "request access");
    const refused = () => [...host.querySelectorAll<HTMLAnchorElement>(".relay-invite a")].find((a) => a.textContent === "Request access");
    gateway.relay = { ...relayNone(), signup };
    savedSetup("account");
    await mount(FLAGS.relay);
    expect(heading()).toBe("Do you want an Omnesis account?");
    expect(inline()?.href).toBe("https://relay.example.test/request-access");
    expect(inline()?.target).toBe("_blank");
    expect(host.querySelector(".access-wizard-copy p")?.textContent?.replace(/\s+/g, " ")).toContain(
      "Accounts are invite-only for now: request access (relay.example.test), then create your account once it's approved.",
    );
    gateway.relay = { ...relayNone(), signup, connect: { state: "failed", error: "not-allowed" } };
    await remount(FLAGS.relay);
    expect(refused()?.href).toBe("https://relay.example.test/request-access");
    // A relay open to everyone, or a link that is not https, shows no invitation.
    gateway.relay = { ...relayNone(), signup: { inviteOnly: false, requestAccessUrl: signup.requestAccessUrl } };
    await remount(FLAGS.relay);
    expect(inline()).toBeUndefined();
    gateway.relay = { ...relayNone(), signup: { inviteOnly: true, requestAccessUrl: "http://relay.example.test/x" } };
    await remount(FLAGS.relay);
    expect(inline()).toBeUndefined();
  });

  test("an unavailable installation and a failed connect say why", async () => {
    gateway.relay = { ...relayNone(), serviceConfigured: false, serviceError: "relay-service-unavailable" };
    savedSetup("account");
    await mount(FLAGS.relay);
    expect(heading()).toBe("Omnesis accounts aren't available here");
    expect(text()).toContain("Set OMNESIS_CLOUD_RELAY_URL for the gateway, then restart it.");
    gateway.relay = { ...relayNone(), connect: { state: "failed", error: "not-allowed" } };
    await remount(FLAGS.relay);
    expect(heading()).toBe("Couldn't connect");
    expect(text()).toContain("hasn't been approved");
    await click("Try again");
    expect(calls("relay").at(-1)).toEqual(["relay", "connect", { termsAccepted: true }, "POST"]);
  });
});

describe("Tailscale only", () => {
  test("starts at the connection, signs in inline, and turns off after a confirmation", async () => {
    await mount(FLAGS.tailscale);
    await startSetup();
    expect(steps()).toEqual(["1Remote connection"]);
    expect(way("relay")).toBeNull();
    await toggle("#remote-access-way-tailscale", true);
    expect(calls("tailscale")).toEqual([["tailscale", "enable", true]]);
    expect(link("Open sign-in page")?.getAttribute("href")).toBe("https://login.tailscale.com/a/fictional0");
    expect(qr.toCanvas).toHaveBeenCalledWith(expect.anything(), "https://login.tailscale.com/a/fictional0", expect.any(Object));
    // With the device on, new devices can ask to join from the tailnet.
    expect(steps()).toEqual(["1Remote connection", "2New devices"]);
    gateway.tailscale = tailscaleConnected();
    await remount(FLAGS.tailscale);
    expect(text()).toContain("Connected as omnesis.example-net.ts.net, with a trusted certificate.");
    await toggle("#remote-access-way-tailscale", false);
    expect(calls("tailscale")).toHaveLength(1);
    expect(host.querySelector(".confirm-modal-title")?.textContent).toBe("Turn off Tailscale?");
    await confirmModal();
    expect(calls("tailscale").at(-1)).toEqual(["tailscale", "enable", false]);
    expect(isChecked(way("tailscale"))).toBe(false);
  });

  test("a device that won't turn on says why under its option", async () => {
    const tailscaleApi = await import(
      // @ts-expect-error — portal modules are plain JS.
      "../lib/tailscale-api.js"
    );
    vi.mocked(tailscaleApi.setTailscaleEnabled).mockRejectedValueOnce(
      Object.assign(new Error("refused"), { serverMessage: "Tailscale can't start on this gateway." }),
    );
    await mount(FLAGS.tailscale);
    await startSetup();
    await toggle("#remote-access-way-tailscale", true);
    expect(host.querySelector(".remote-access-option [role='alert']")?.textContent).toContain("Tailscale can't start on this gateway.");
    expect(isChecked(way("tailscale"))).toBe(false);
  });

  test("devices: each answer maps onto the device's policy, a pairing code only included", async () => {
    gateway.tailscale = tailscaleConnected();
    savedSetup("devices");
    await mount(FLAGS.tailscale);
    expect(text()).toContain("A new device can ask to join from your Tailscale network.");
    const radio = (value: string) => host.querySelector(`input[name="remote-access-policy"][value="${value}"]`) as HTMLInputElement;
    expect(isChecked(radio("ask"))).toBe(true);
    for (const [choice, policy] of [["automatic", "automatic"], ["code", "off"], ["ask", "ask"]]) {
      await toggle(`input[name="remote-access-policy"][value="${choice}"]`, true);
      expect(calls("tailscale").at(-1)).toEqual(["tailscale", "settings", { joinPolicy: policy }]);
      expect(isChecked(radio(choice))).toBe(true);
    }
    expect(calls("relay")).toEqual([]);
  });
});

describe("both", () => {
  test("with both on, the owner says which is tried first", async () => {
    gateway.relay = relayLinked();
    gateway.tailscale = tailscaleConnected();
    savedSetup("connection");
    await mount(FLAGS.both);
    expect(text()).toContain("When both can answer, try first");
    await toggle('input[name="remote-access-first"][value="relay"]', true);
    expect(calls("remote")).toEqual([["remote", { first: "relay" }]]);
    expect(isChecked(host.querySelector('input[name="remote-access-first"][value="relay"]'))).toBe(true);
  });

  test("devices: one answer sets both policies; automatic asks for the passkey as announced", async () => {
    gateway.relay = relayLinked({ stepUpRequired: true });
    gateway.tailscale = tailscaleConnected();
    savedSetup("devices");
    await mount(FLAGS.both);
    expect(text()).toContain("by signing in with your Omnesis account, or from your Tailscale network");
    expect(text()).toContain("Turns on with your passkey.");
    expect(host.querySelector('input[name="remote-access-policy"][value="code"]')).toBeNull();
    await toggle('input[name="remote-access-policy"][value="automatic"]', true);
    expect(gateway.calls.filter((call) => call[0] !== "remote" && call[0] !== "host")).toEqual([
      ["relay", "enrollment", { policy: "automatic" }, "PUT", { stepUpAnnounced: true }],
      ["tailscale", "settings", { joinPolicy: "automatic" }],
    ]);
    gateway.calls = [];
    await toggle('input[name="remote-access-policy"][value="ask"]', true);
    expect(gateway.calls.filter((call) => call[0] !== "host")).toEqual([
      ["relay", "enrollment", { policy: "ask" }, "PUT"],
      ["tailscale", "settings", { joinPolicy: "ask" }],
    ]);
  });

  test("devices: when the two differ nothing is preselected, the difference is said, and one answer sets both", async () => {
    gateway.relay = relayLinked({ policy: "ask" });
    gateway.tailscale = { ...tailscaleConnected(), joinPolicy: "off" };
    savedSetup("devices");
    await mount(FLAGS.both);
    expect([...host.querySelectorAll('input[name="remote-access-policy"]')].some((r) => isChecked(r))).toBe(false);
    expect(text()).toContain("Right now devices that sign in wait for you and Tailscale devices need a pairing code.");
    await toggle('input[name="remote-access-policy"][value="ask"]', true);
    expect(calls("tailscale")).toEqual([["tailscale", "settings", { joinPolicy: "ask" }]]);
    expect(text()).not.toContain("Right now");
  });

  test("every way in sits beside the others, and each that is set up opens its own page", async () => {
    gateway.relay = relayLinked();
    gateway.tailscale = tailscaleConnected();
    savedSetup("connection");
    await mount(FLAGS.both);
    expect(isChecked(way("host"))).toBe(false);
    await toggle("#remote-access-way-host", true);
    await toggle("#remote-access-way-domain", true);
    expect(host.querySelector(".confirm-modal")).toBeNull();
    const changes = () => [...calls("relay"), ...calls("tailscale")];
    expect(changes()).toEqual([]);
    expect(["tailscale", "relay", "host", "domain"].map((key) => isChecked(way(key)))).toEqual([true, true, true, true]);
    expect(text()).toContain("Found: this computer is on your Tailscale network as studio.example-net.ts.net.");
    await click(["Manage", "Tailscale", "device"].join(" "));
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/tailscale");
    await click("Manage relay");
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/relay");
    // Unticking an option of the owner's own only hides its panel: it changes nothing.
    await toggle("#remote-access-way-host", false);
    await toggle("#remote-access-way-domain", false);
    expect(changes()).toEqual([]);
    expect(calls("publish")).toEqual([]);
  });

  test("Tailscale on this computer starts ticked when it already serves the gateway, with its address to open", async () => {
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: false };
    savedSetup("connection");
    await mount(FLAGS.tailscale);
    expect(isChecked(way("host"))).toBe(true);
    expect(text()).toContain(`Serving this gateway at ${HOST_URL}, to your Tailscale devices only.`);
    expect(link(HOST_URL)?.getAttribute("href")).toBe(`${HOST_URL}/portal/`);
    // Not public yet: the Internet is one tick and one press away.
    expect(button("Set it up for me")).toBeUndefined();
    await toggle(".remote-access-check input", true);
    expect(button("Set it up for me")).toBeTruthy();
  });

  test("Tailscale on this computer: refused with the command, then published to the Internet, never as the public address", async () => {
    gateway.publish = { ok: false, reason: "This gateway is not allowed to change Tailscale on this computer.", command: "tailscale serve --bg https+insecure://localhost:7600" };
    savedSetup("connection", { host: true });
    await mount(FLAGS.both);
    await click("Set it up for me");
    expect(calls("publish")).toEqual([["publish", false]]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("not allowed to change Tailscale");
    expect(host.querySelector(".copy-block-code")?.textContent).toBe("tailscale serve --bg https+insecure://localhost:7600");
    gateway.publish = { ok: true, url: HOST_URL };
    // Public needs no setting first: the gateway believes a proxy on its own machine.
    await toggle(".remote-access-check input", true);
    expect(text()).not.toContain("OMNESIS_TRUST_PROXY");
    await click("Set it up for me");
    expect(calls("publish").at(-1)).toEqual(["publish", true]);
    // Its address is a way in of its own: the gateway's public address is left alone.
    expect(calls("config")).toEqual([]);
    expect(text()).toContain(`Serving this gateway at ${HOST_URL}, on your Tailscale network and to the Internet.`);
  });

  test("Tailscale on this computer: a public gateway keeps its ticked box, and unticking it takes the gateway off the Internet", async () => {
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: true };
    gateway.publish = { ok: true, url: HOST_URL };
    savedSetup("connection", { host: true });
    await mount({ cloudRelay: false, tailscaleEmbed: false });
    expect(text()).toContain(`Serving this gateway at ${HOST_URL}, on your Tailscale network and to the Internet.`);
    expect(isChecked(host.querySelector(".remote-access-check input"))).toBe(true);
    // Nothing to apply while the box says what Tailscale does.
    expect(button("Set it up for me")).toBeUndefined();
    expect(button("Take it off the Internet")).toBeUndefined();
    await toggle(".remote-access-check input", false);
    expect(text()).toContain("will no longer reach this gateway");
    await click("Take it off the Internet");
    expect(calls("publish")).toEqual([["publish", false]]);
    // The public address stays: the tailnet still answers at it.
    expect(calls("config")).toEqual([]);
    expect(text()).toContain(`Serving this gateway at ${HOST_URL}, to your Tailscale devices only.`);
    expect(isChecked(host.querySelector(".remote-access-check input"))).toBe(false);
    expect(button("Take it off the Internet")).toBeUndefined();
    // And it can be ticked again.
    await toggle(".remote-access-check input", true);
    await click("Set it up for me");
    expect(calls("publish").at(-1)).toEqual(["publish", true]);
    expect(isChecked(host.querySelector(".remote-access-check input"))).toBe(true);
  });

  test("a refused change offers its check under the command, which says what it found and clears once done", async () => {
    gateway.publish = { ok: false, reason: "This gateway is not allowed to change Tailscale on this computer.", command: "tailscale funnel --bg https+insecure://localhost:7600" };
    savedSetup("connection", { host: true });
    await mount(FLAGS.tailscale);
    // Nothing to check before a command is shown.
    expect(button("I've run it, check it")).toBeUndefined();
    await toggle(".remote-access-check input", true);
    await click("Set it up for me");
    const command = () => host.querySelector(".remote-access-command");
    expect(command()?.querySelector(".copy-block-code")?.textContent).toBe("tailscale funnel --bg https+insecure://localhost:7600");
    expect(command()?.textContent).toContain("I've run it, check it");
    await click("I've run it, check it");
    expect(text()).toContain("Tailscale on this computer isn't serving this gateway yet. Run the command above, then check again.");
    // Served on the tailnet but not public, while the owner wants it public.
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: false };
    await click("I've run it, check it");
    expect(text()).toContain("This gateway isn't reachable from the Internet yet. Run the command above, then check again.");
    // Done: the refusal and its command go, and the public address is left alone.
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: true };
    await click("I've run it, check it");
    expect(command()).toBeNull();
    expect(text()).not.toContain("Run the command above");
    expect(text()).toContain(`Serving this gateway at ${HOST_URL}, on your Tailscale network and to the Internet.`);
    expect(calls("config")).toEqual([]);
  });

  test("the setup goes on only once Tailscale on this computer does what its box says", async () => {
    savedSetup("connection", { host: true });
    await mount({ cloudRelay: false, tailscaleEmbed: false });
    const next = () => host.querySelector(".remote-access-actions .btn-primary") as HTMLButtonElement;
    // Ticked but not set up: Finish waits.
    expect(next().disabled).toBe(true);
    expect(text()).toContain("Set up Tailscale on this computer, or untick it, to continue.");
    // Ticking the box for the Internet without applying it waits too.
    await click("Set it up for me");
    expect(next().disabled).toBe(false);
    await toggle(".remote-access-check input", true);
    expect(next().disabled).toBe(true);
    await click("Set it up for me");
    expect(next().disabled).toBe(false);
    expect(text()).not.toContain("to continue.");
  });

  test("unticking Tailscale on this computer while it serves the gateway stops it, and a public address saved as it goes too", async () => {
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: true };
    gateway.remote!.publicBaseUrl = { configured: HOST_URL, setByEnvironment: false, way: "host" };
    gateway.unpublish = { ok: false, reason: "This gateway is not allowed to change Tailscale on this computer.", command: "tailscale serve --https=443 off" };
    savedSetup("connection");
    await mount({ cloudRelay: false, tailscaleEmbed: false });
    const next = () => host.querySelector(".remote-access-actions .btn-primary") as HTMLButtonElement;
    expect(isChecked(way("host"))).toBe(true);
    expect(next().disabled).toBe(false);
    await toggle("#remote-access-way-host", false);
    expect(text()).toContain(
      `Tailscale on this computer still serves this gateway at ${HOST_URL}, on your Tailscale network and to the Internet. Stop serving it, or tick the option again.`,
    );
    expect(next().disabled).toBe(true);
    expect(text()).toContain("Stop serving this gateway from Tailscale on this computer, or tick it again, to continue.");
    await click("Stop serving this gateway");
    expect(host.querySelector(".confirm-modal")?.textContent).toContain("it is no longer this gateway's public address");
    await confirmOnce("Stop serving");
    expect(calls("unpublish")).toEqual([["unpublish"]]);
    expect(host.querySelector(".copy-block-code")?.textContent).toBe("tailscale serve --https=443 off");
    expect(calls("config")).toEqual([]);
    // The owner runs it, and the check finds it done: the address goes too.
    gateway.host = { ...gateway.host, servesGateway: false, publicGateway: false };
    await click("I've run it, check it");
    // Unticked and served nowhere, its panel goes.
    expect(host.querySelector(".remote-access-command")).toBeNull();
    expect(text()).not.toContain("still serves this gateway");
    expect(calls("config")).toEqual([["config", { gateway: { publicBaseUrl: null } }]]);
    expect(next().disabled).toBe(false);
  });

  test("the setup waits while Tailscale on this computer is still being read", async () => {
    gateway.hangHost = true;
    savedSetup("connection", { host: true });
    await mount({ cloudRelay: false, tailscaleEmbed: false });
    expect(text()).toContain("Looking for Tailscale on this computer");
    expect((host.querySelector(".remote-access-actions .btn-primary") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a check keeps a public address changed elsewhere meanwhile", async () => {
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: true };
    gateway.remote!.publicBaseUrl = { configured: HOST_URL, setByEnvironment: false, way: "host" };
    gateway.unpublish = { ok: false, reason: "This gateway is not allowed to change Tailscale on this computer.", command: "tailscale serve --https=443 off" };
    savedSetup("connection", { host: false });
    await mount({ cloudRelay: false, tailscaleEmbed: false });
    await click("Stop serving this gateway");
    await confirmOnce("Stop serving");
    // Another tab saves the owner's own domain before the check.
    gateway.remote!.publicBaseUrl = { configured: "https://omnesis.example.org", setByEnvironment: false, way: null };
    gateway.host = { ...gateway.host, servesGateway: false, publicGateway: false };
    await click("I've run it, check it");
    expect(calls("config")).toEqual([]);
  });

  test("a public address that could not be removed stays on screen", async () => {
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: true };
    gateway.remote!.publicBaseUrl = { configured: HOST_URL, setByEnvironment: false, way: "host" };
    gateway.failConfig = true;
    savedSetup("connection", { host: false });
    await mount({ cloudRelay: false, tailscaleEmbed: false });
    await click("Stop serving this gateway");
    await confirmOnce("Stop serving");
    expect(calls("unpublish")).toEqual([["unpublish"]]);
    expect(calls("config")).toEqual([["config", { gateway: { publicBaseUrl: null } }]]);
    expect(host.querySelector('.remote-access-option [role="alert"]')?.textContent).toBe("Couldn't write the configuration file.");
  });

  test("stopping keeps a public address that is not this computer's", async () => {
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: false };
    gateway.remote!.publicBaseUrl = { configured: "https://omnesis.example.org", setByEnvironment: false, way: null };
    savedSetup("connection", { host: false });
    await mount({ cloudRelay: false, tailscaleEmbed: false });
    await click("Stop serving this gateway");
    await confirmOnce("Stop serving");
    expect(calls("unpublish")).toEqual([["unpublish"]]);
    expect(calls("config")).toEqual([]);
    expect(text()).not.toContain("still serves this gateway");
  });

  test("Tailscale on this computer: a check re-reads, and a stopped daemon gives the reason", async () => {
    gateway.host = { state: "stopped", reason: "Tailscale is installed on this computer but not running or not signed in." };
    savedSetup("connection", { host: true });
    await mount(FLAGS.both);
    expect(text()).toContain("Tailscale is installed on this computer but not running or not signed in.");
    gateway.host = { state: "available", dnsName: "studio.example-net.ts.net", url: HOST_URL, servesGateway: true, publicGateway: false };
    await click("Check again");
    expect(text()).toContain(`Serving this gateway at ${HOST_URL}, to your Tailscale devices only.`);
    expect(button("Set it up for me")).toBeUndefined();
  });

  test("my own address: checked step by step and saved; a failed step saves nothing", async () => {
    savedSetup("connection", { domain: true });
    await mount(FLAGS.both);
    await type("#remote-access-own-url", "https://omnesis.example.org");
    await submit(".remote-access-address");
    expect(calls("check")).toEqual([["check", "https://omnesis.example.org"]]);
    expect([...host.querySelectorAll(".remote-access-checks li")].map((li) => li.className)).toEqual(["is-ok", "is-ok", "is-ok", "is-unknown"]);
    expect(text()).toContain("This check runs inside your network, so it can't tell whether the address is reachable from outside.");
    await click("Use this address");
    expect(calls("config")).toEqual([["config", { gateway: { publicBaseUrl: "https://omnesis.example.org" } }]]);
    // In use at once: no restart to ask for.
    expect(text()).toContain("This gateway uses this address.");
    expect(text()).not.toContain("Restart the gateway");
    gateway.check = { url: "https://omnesis.example.org", ok: false, steps: [{ id: "resolves", ok: false, detail: "omnesis.example.org does not resolve from this gateway." }] };
    await submit(".remote-access-address");
    expect(host.querySelector(".remote-access-checks li")?.className).toBe("is-failed");
    expect(button("Use this address")).toBeUndefined();
  });

  test("other apps on 443 move the gateway to its own port, saying where each goes, and none free offers nothing to run", async () => {
    const taken = [
      { port: 443, target: "http://127.0.0.1:3000" },
      { port: 8443, target: null },
      { port: 10000, target: "https+insecure://localhost:7600" },
    ];
    gateway.host = { ...gateway.host, port: 8443, url: `${HOST_URL}:8443`, taken: taken.slice(0, 1) };
    savedSetup("connection", { host: true });
    await mount(FLAGS.both);
    const ports = () => [...host.querySelectorAll(".remote-access-ports li")].map((li) => li.textContent?.replace(/\s+/g, " ").trim());
    expect(text()).toContain("Other apps already use this address, so this gateway uses port 8443:");
    expect(ports()).toEqual([`${HOST_URL} goes to http://127.0.0.1:3000`]);
    expect(text()).toContain(`Some agents, such as ChatGPT, connect only on port 443, so ${HOST_URL}:8443/mcp may not work with them.`);
    expect(button("Set it up for me")).toBeTruthy();
    gateway.host = { ...gateway.host, port: 10000, url: `${HOST_URL}:10000`, taken: taken.slice(0, 2) };
    await remount(FLAGS.both);
    expect(text()).toContain("Other apps already use these addresses, so this gateway uses port 10000:");
    expect(ports()).toEqual([`${HOST_URL} goes to http://127.0.0.1:3000`, `${HOST_URL}:8443 is in use`]);
    // Once served there, only the agents' caveat stays.
    gateway.host = { ...gateway.host, servesGateway: true };
    await remount(FLAGS.both);
    expect(text()).not.toContain("Other apps already use");
    expect(text()).toContain(`so ${HOST_URL}:10000/mcp may not work with them.`);
    const blocked = "Tailscale on this computer already serves other apps on 443, 8443 and 10000, the ports it can publish. Free one of them, then check again.";
    gateway.host = { ...gateway.host, servesGateway: false, port: null, url: HOST_URL, blocked, taken };
    await remount(FLAGS.both);
    expect(text()).toContain(blocked);
    expect(ports()).toContain(`${HOST_URL}:10000 goes to https+insecure://localhost:7600`);
    expect(text()).not.toContain("Other apps already use");
    expect(button("Set it up for me")).toBeUndefined();
    expect(text()).not.toContain("Also reachable from the Internet");
    expect(button("Check again")).toBeTruthy();
  });

  test("an address set by the environment is shown, and nothing offers to save another", async () => {
    gateway.remote!.publicBaseUrl = { configured: "https://env.example.org", setByEnvironment: true, way: null };
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: true };
    savedSetup("connection", { domain: true });
    await mount(FLAGS.both);
    expect(text()).toContain(
      "This gateway's public address, https://env.example.org, is set by OMNESIS_PUBLIC_BASE_URL in its environment, so it can't be changed here.",
    );
    expect(host.querySelector("#remote-access-own-url")).toBeNull();
    expect(calls("config")).toEqual([]);
  });

  test("a public address that is another way's leaves the domain empty, and says whose it is", async () => {
    gateway.remote!.publicBaseUrl = { configured: HOST_URL, setByEnvironment: false, way: "host" };
    savedSetup("connection", { domain: true });
    await mount(FLAGS.both);
    expect((host.querySelector("#remote-access-own-url") as HTMLInputElement).value).toBe("");
    expect(text()).toContain(`This gateway's public address is ${HOST_URL}, the address of Tailscale on this computer.`);
  });

  test("a first setup finishes on the summary, and is marked complete once", async () => {
    await mount(FLAGS.both);
    await startSetup();
    expect(heading()).toBe("Do you want an Omnesis account?");
    await click("Skip for now");
    await click("Finish");
    expect(calls("remote")).toEqual([["remote", { setupCompleted: true }]]);
    expect(storage.has("omnesis.remote-access.setup")).toBe(false);
    expect(heading()).toBe("Connectivity");
  });

  test("a setup's step bar opens the steps done and the next one, not beyond", async () => {
    gateway.relay = relayLinked();
    await mount(FLAGS.both);
    await click("Run the setup again");
    await click("Cancel");
    // A review is open everywhere; a setup only up to the next step.
    savedSetup("account");
    await remount(FLAGS.both);
    const stepButton = (n: number) => host.querySelectorAll(".access-wizard-steps button")[n] as HTMLButtonElement;
    expect([0, 1, 2].map((n) => stepButton(n).hasAttribute("disabled"))).toEqual([false, false, true]);
    await act(async () => stepButton(1).click());
    await settle();
    expect(heading()).toContain("How should your devices reach");
    expect([0, 1, 2].map((n) => stepButton(n).hasAttribute("disabled"))).toEqual([false, false, false]);
    await act(async () => stepButton(2).click());
    await settle();
    expect(heading()).toBe("When a new device asks to join, what should happen?");
  });

  test("a review shows each step as it stands, moves by Continue or the step bar, and can be cancelled", async () => {
    gateway.relay = relayLinked();
    gateway.tailscale = tailscaleConnected();
    await mount(FLAGS.both);
    await click("Run the setup again");
    expect(heading()).toBe("This gateway is linked to your Omnesis account");
    const actions = [...host.querySelectorAll(".remote-access-actions button")].map((b) => b.textContent?.trim());
    expect(actions).toEqual(["Cancel", "Unlink this gateway", "Manage account", "Continue"]);
    await click("Continue");
    expect(heading()).toBe("How should your devices reach this gateway when they are away from home?");
    // Every step of a review is open from the step bar.
    const stepButton = (n: number) => host.querySelectorAll(".access-wizard-steps button")[n] as HTMLButtonElement;
    expect([0, 1, 2].map((n) => stepButton(n).hasAttribute("disabled"))).toEqual([false, false, false]);
    await act(async () => stepButton(2).click());
    await settle();
    expect(heading()).toBe("When a new device asks to join, what should happen?");
    await click("Cancel");
    expect(heading()).toBe("Connectivity");
    await click("Run the setup again");
    await click("Continue");
    await click("Continue");
    await click("Finish");
    expect(heading()).toBe("Connectivity");
    // A review completes nothing.
    expect(calls("remote")).toEqual([]);
  });

  test("unlinking from step 1 is confirmed first, and the step then offers an account again", async () => {
    gateway.relay = relayLinked();
    await mount(FLAGS.relay);
    await click("Run the setup again");
    await click("Unlink this gateway");
    expect(host.querySelector(".confirm-modal-body")?.textContent).toContain("This gateway leaves your Omnesis account.");
    expect(calls("relay").filter((call) => call[1] === "account/unlink")).toEqual([]);
    await confirmModal();
    expect(calls("relay").at(-1)).toEqual(["relay", "account/unlink", {}, "POST"]);
    expect(heading()).toBe("Do you want an Omnesis account?");
  });

  test("a saved setup resumes after a reload, and leaving it keeps nothing", async () => {
    savedSetup("connection", { domain: true, url: "https://omnesis.example.org" });
    await mount(FLAGS.both);
    expect(heading()).toContain("How should your devices reach");
    expect((host.querySelector("#remote-access-own-url") as HTMLInputElement).value).toBe("https://omnesis.example.org");
    await click("Cancel");
    expect(heading()).toBe("Connectivity");
    expect(storage.has("omnesis.remote-access.setup")).toBe(false);
  });
});

describe("the MCP server", () => {
  test("is the setup's last step once an address away from home exists, and sets how far each answers", async () => {
    gateway.host = { ...gateway.host, servesGateway: true };
    gateway.remote!.mcpAddresses = [mcpRow("host"), mcpRow("domain", { available: false, url: null })];
    await mount(FLAGS.tailscale);
    expect(detail("MCP server")).toBe(["On", "Tailscale on this computer (your Tailscale network only)."].join(" "));
    await startSetup();
    expect(steps()).toEqual(["1Remote connection", "2MCP server"]);
    await click("Continue");
    expect(heading()).toBe("Where may agents reach your MCP server?");
    const choices = () => [...host.querySelectorAll('input[name="remote-access-mcp-host"]')] as HTMLInputElement[];
    expect(choices().map((r) => r.value)).toEqual(["off", "private", "public"]);
    expect(choices().map((r) => isChecked(r))).toEqual([false, true, false]);
    expect(text()).toContain(`${HOST_URL}/mcp`);
    expect(text()).toContain("Agents on this computer and on your home network can always connect.");
    await toggle('input[name="remote-access-mcp-host"][value="public"]', true);
    expect(calls("remote")).toEqual([["remote", { mcp: { host: "public" } }]]);
    expect(text()).toContain("Only the MCP server goes on the Internet.");
    await toggle('input[name="remote-access-mcp-host"][value="off"]', true);
    expect(calls("remote").at(-1)).toEqual(["remote", { mcp: { host: "off" } }]);
    await click("Finish");
    expect(detail("MCP server")).toBe("Off on every address away from home.");
  });

  test("a change Tailscale refuses shows its command, and a check clears it once done", async () => {
    gateway.host = { ...gateway.host, servesGateway: true };
    gateway.remote!.mcpAddresses = [mcpRow("host")];
    gateway.mcpRefusal = {
      ok: false,
      reason: "This gateway is not allowed to change Tailscale on this computer.",
      command: "tailscale funnel --bg https+insecure://localhost:7600",
    };
    await mount(FLAGS.tailscale);
    await startSetup();
    await click("Continue");
    await toggle('input[name="remote-access-mcp-host"][value="public"]', true);
    expect(host.querySelector(".remote-access-mcp .copy-block-code")?.textContent).toBe(
      "tailscale funnel --bg https+insecure://localhost:7600",
    );
    await click("I've run it, check it");
    expect(text()).toContain("Tailscale on this computer hasn't changed yet.");
    gateway.remote!.mcpAddresses = [mcpRow("host", { reach: "public" })];
    await click("I've run it, check it");
    expect(host.querySelector(".remote-access-mcp .remote-access-command")).toBeNull();
  });

  test("the device's public address says when Tailscale has yet to open it", async () => {
    gateway.tailscale = tailscaleConnected();
    gateway.remote!.mcpAddresses = [mcpRow("tailnet", { url: "https://omnesis.example-net.ts.net", reach: "public", opening: true })];
    await mount(FLAGS.tailscale);
    await startSetup();
    await click("Continue");
    await click("Continue");
    expect(text()).toContain("Tailscale hasn't opened it yet");
    expect(link("this gateway's own Tailscale device")?.getAttribute("href")).toBe("/portal/settings/tailscale");
  });

  test("an address on a port other than 443 says some agents may not reach it", async () => {
    gateway.host = { ...gateway.host, port: 10000, url: `${HOST_URL}:10000`, servesGateway: true };
    gateway.remote!.mcpAddresses = [mcpRow("host", { url: `${HOST_URL}:10000` })];
    await mount(FLAGS.tailscale);
    await startSetup();
    await click("Continue");
    expect(text()).toContain(`${HOST_URL}:10000/mcp`);
    expect(text()).toContain("Some agents, such as ChatGPT, connect only on port 443 and may not reach it.");
  });

  test("without an address away from home, says agents at home still connect", async () => {
    await mount(FLAGS.tailscale);
    expect(detail("MCP server")).toBe("On this computer and your home network only, until an address away from home is set up.");
    await startSetup();
    expect(steps()).toEqual(["1Remote connection"]);
  });
});

describe("Tailscale on this computer's own page", () => {
  test("stops serving the gateway, after a confirmation, and can set it up again", async () => {
    gateway.host = { ...gateway.host, servesGateway: true, publicGateway: true };
    gateway.remote!.publicBaseUrl = { configured: HOST_URL, setByEnvironment: false, way: "host" };
    await act(async () => render(h(HostTailscaleView, {}), host));
    await settle();
    expect(text()).toContain(`Serving this gateway at ${HOST_URL}, on your Tailscale network and to the Internet.`);
    await click("Stop serving this gateway");
    await click("Cancel");
    expect(calls("unpublish")).toEqual([]);
    await click("Stop serving this gateway");
    await confirmOnce("Stop serving");
    expect(calls("unpublish")).toEqual([["unpublish"]]);
    expect(calls("config")).toEqual([["config", { gateway: { publicBaseUrl: null } }]]);
    expect(button("Stop serving this gateway")).toBeUndefined();
    expect(button("Set it up for me")).toBeTruthy();
  });
});

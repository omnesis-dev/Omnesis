// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Remote access through its real hooks, with the gateway's routes
// answered by a small in-memory gateway: the relay's, the Tailscale device's,
// the remote-access routes and the config. Fictional data throughout.

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
  check: null as Json | null,
  failRemote: false,
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
    return clone(gateway.remote);
  }),
  getHostTailscale: vi.fn(async () => {
    gateway.calls.push(["host"]);
    return clone(gateway.host);
  }),
  publishHostTailscale: vi.fn(async (isPublic: boolean) => {
    gateway.calls.push(["publish", isPublic]);
    if (gateway.publish!.ok) gateway.host = { ...gateway.host, servesGateway: true, publicGateway: isPublic };
    return clone(gateway.publish);
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
    const configured = patch.gateway.publicBaseUrl;
    gateway.remote!.publicBaseUrl = { configured, setByEnvironment: false };
    return { status: 200, ok: true, body: {} };
  }),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../lib/router.js", () => router);

// @ts-expect-error — portal modules are plain JS.
import { RemoteAccessView } from "./remote-access.js";

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
      publicBaseUrl: { configured: null, setByEnvironment: false },
    },
    host: { state: "available", dnsName: "studio.example-net.ts.net", port: 443, url: "https://studio.example-net.ts.net", servesGateway: false, publicGateway: false },
    publish: { ok: true, url: "https://studio.example-net.ts.net" },
    check: {
      url: "https://omnesis.example.org", ok: true,
      steps: [
        { id: "resolves", ok: true, detail: "omnesis.example.org resolves to 203.0.113.24." },
        { id: "certificate", ok: true, detail: "The certificate is valid for omnesis.example.org." },
        { id: "answers", ok: true, detail: "This gateway answered at that address." },
      ],
    },
    failRemote: false,
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

  test("a failed load says so and tries again", async () => {
    gateway.failRemote = true;
    await mount(FLAGS.both);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The gateway is busy.");
    gateway.failRemote = false;
    await click("Try again");
    expect(heading()).toBe("Do you want an Omnesis account?");
  });
});

describe("relay only", () => {
  test("asks about the account, then the connection without Tailscale, then devices", async () => {
    await mount(FLAGS.relay);
    expect(steps()).toEqual(["1Your Omnesis account", "2Remote connection", "3New devices"]);
    expect(heading()).toBe("Do you want an Omnesis account?");
    expect(text()).toContain("None of your data goes to Omnesis.");
    await click("Skip for now");
    expect(heading()).toBe("How should your devices reach this gateway when they are away from home?");
    const accountStep = ["✓Your", "Omnesis", "account"].join(" ");
    expect(steps()[0]).toBe(accountStep);
    expect(way("tailscale")).toBeNull();
    // The relay waits for an account, and says where to get one.
    expect(way("relay")?.disabled).toBe(true);
    expect(text()).toContain("Needs an Omnesis account.");
    // With the relay alone, the own setup is only the owner's address: no choice to make.
    await toggle("#remote-access-way-self", true);
    expect(host.querySelector('input[name="remote-access-own"]')).toBeNull();
    expect(host.querySelector("#remote-access-own-url")).not.toBeNull();
    expect(calls("host")).toEqual([]);
    await click("Continue");
    expect(heading()).toBe("When a new device asks to join, what should happen?");
    expect(text()).toContain("Devices pair with a code");
    expect(host.querySelector('input[name="remote-access-policy"]')).toBeNull();
    await click("Back");
    expect(heading()).toContain("How should your devices reach");
  });

  test("creating an account runs the relay's own connect, with its sign-in link and code, and cancels", async () => {
    await mount(FLAGS.relay);
    await click("Create an account");
    expect(calls("relay")).toEqual([["relay", "connect", { termsAccepted: true, intent: "create" }, "POST"]]);
    expect(heading()).toBe("Sign in to your Omnesis account");
    expect(link("Open sign-in")?.getAttribute("href")).toBe("https://relay.example.test/_relay/sign-in");
    expect(link("Open sign-in")?.getAttribute("target")).toBe("_blank");
    expect(text()).toContain("KTPX-4QRD");
    await click("Cancel");
    expect(calls("relay").at(-1)).toEqual(["relay", "connect/cancel", {}, "POST"]);
    expect(heading()).toBe("Do you want an Omnesis account?");
    await click("I already have one");
    expect(calls("relay").at(-1)).toEqual(["relay", "connect", { termsAccepted: true, intent: "existing" }, "POST"]);
  });

  test("the relay's link back to step 1 keeps the choices and returns to step 2, across a reload", async () => {
    await mount(FLAGS.relay);
    await click("Skip for now");
    await toggle("#remote-access-way-self", true);
    await click("Set one up in step 1");
    expect(heading()).toBe("Do you want an Omnesis account?");
    // The sign-in leaves the page; the setup comes back where it was.
    expect(JSON.parse(storage.get("omnesis.remote-access.setup")!)).toMatchObject({ step: "account", resume: "connection", self: true });
    gateway.relay = relayLinked({ enabled: false });
    await remount(FLAGS.relay);
    expect(heading()).toBe("This gateway is linked to your Omnesis account");
    await click("Continue");
    expect(heading()).toContain("How should your devices reach");
    expect(isChecked(way("self"))).toBe(true);
    // Now the relay can be turned on and off.
    expect(way("relay")?.disabled).toBe(false);
    await toggle("#remote-access-way-relay", true);
    expect(calls("relay").at(-1)).toEqual(["relay", "enable", {}, "POST"]);
    expect(isChecked(way("relay"))).toBe(true);
    expect(isChecked(way("self"))).toBe(false);
    expect(text()).toContain("Connected as g-maple.relay.example.test.");
    await toggle("#remote-access-way-relay", false);
    expect(calls("relay").at(-1)).toEqual(["relay", "disable", {}, "POST"]);
    // Step 3 then offers no pairing-code-only answer: the account always lets a device ask.
    await click("Continue");
    expect([...host.querySelectorAll('input[name="remote-access-policy"]')].map((r: any) => r.value)).toEqual(["ask", "automatic"]);
    expect(text()).toContain("A new device can ask to join by signing in with your Omnesis account.");
  });

  test("an unconfirmed passkey keeps the relay's checklist, and moving on is the quieter button", async () => {
    gateway.relay = relayLinked({ confirmed: false });
    await mount(FLAGS.relay);
    expect(text()).toContain("Finish setting up");
    expect(button("Continue with passkey")).toBeTruthy();
    expect(button("Continue")?.className).toBe("btn-secondary");
    await click("Not now");
    expect(text()).not.toContain("Finish setting up");
    expect(button("Continue")?.className).toBe("btn-primary");
  });

  test("an invite-only relay links to its request-access page before an account and after a refused sign-in", async () => {
    const signup = { inviteOnly: true, requestAccessUrl: "https://relay.example.test/request-access" };
    const requestLink = () =>
      [...host.querySelectorAll<HTMLAnchorElement>(".relay-invite a")].find((a) => a.textContent === "Request access");
    gateway.relay = { ...relayNone(), signup };
    await mount(FLAGS.relay);
    expect(heading()).toBe("Do you want an Omnesis account?");
    expect(requestLink()?.href).toBe("https://relay.example.test/request-access");
    expect(requestLink()?.target).toBe("_blank");
    expect(host.querySelector(".relay-invite-host")?.textContent).toBe("(relay.example.test)");
    gateway.relay = { ...relayNone(), signup, connect: { state: "failed", error: "not-allowed" } };
    await remount(FLAGS.relay);
    expect(requestLink()).toBeDefined();
    // A relay open to everyone, or a link that is not https, shows no invitation.
    gateway.relay = { ...relayNone(), signup: { inviteOnly: false, requestAccessUrl: signup.requestAccessUrl } };
    await remount(FLAGS.relay);
    expect(requestLink()).toBeUndefined();
    gateway.relay = { ...relayNone(), signup: { inviteOnly: true, requestAccessUrl: "http://relay.example.test/x" } };
    await remount(FLAGS.relay);
    expect(requestLink()).toBeUndefined();
  });

  test("an unavailable installation and a failed connect say why", async () => {
    gateway.relay = { ...relayNone(), serviceConfigured: false, serviceError: "relay-service-unavailable" };
    await mount(FLAGS.relay);
    expect(heading()).toBe("Omnesis accounts aren't available here");
    expect(text()).toContain("Ask the installation administrator");
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
    expect(steps()).toEqual(["1Remote connection", "2New devices"]);
    expect(way("relay")).toBeNull();
    await toggle("#remote-access-way-tailscale", true);
    expect(calls("tailscale")).toEqual([["tailscale", "enable", true]]);
    expect(link("Open sign-in page")?.getAttribute("href")).toBe("https://login.tailscale.com/a/fictional0");
    expect(qr.toCanvas).toHaveBeenCalledWith(expect.anything(), "https://login.tailscale.com/a/fictional0", expect.any(Object));
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
    await toggle("#remote-access-way-tailscale", true);
    expect(host.querySelector(".remote-access-option [role='alert']")?.textContent).toContain("Tailscale can't start on this gateway.");
    expect(isChecked(way("tailscale"))).toBe(false);
  });

  test("devices: each answer maps onto the device's policy, a pairing code only included", async () => {
    gateway.tailscale = tailscaleConnected();
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "devices", self: false, own: "host", url: "" }));
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
    await mount(FLAGS.both);
    await click("Continue");
    expect(text()).toContain("When both can answer, try first");
    await toggle('input[name="remote-access-first"][value="relay"]', true);
    expect(calls("remote")).toEqual([["remote", { first: "relay" }]]);
    expect(isChecked(host.querySelector('input[name="remote-access-first"][value="relay"]'))).toBe(true);
  });

  test("devices: one answer sets both policies; automatic asks for the passkey as announced", async () => {
    gateway.relay = relayLinked({ stepUpRequired: true });
    gateway.tailscale = tailscaleConnected();
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "devices", self: false, own: "host", url: "" }));
    await mount(FLAGS.both);
    expect(text()).toContain("by signing in with your Omnesis account, or from your Tailscale network");
    expect(text()).toContain("Turns on with your passkey.");
    expect(host.querySelector('input[name="remote-access-policy"][value="code"]')).toBeNull();
    await toggle('input[name="remote-access-policy"][value="automatic"]', true);
    expect(gateway.calls.filter((call) => call[0] !== "remote")).toEqual([
      ["relay", "enrollment", { policy: "automatic" }, "PUT", { stepUpAnnounced: true }],
      ["tailscale", "settings", { joinPolicy: "automatic" }],
    ]);
    gateway.calls = [];
    await toggle('input[name="remote-access-policy"][value="ask"]', true);
    expect(gateway.calls).toEqual([
      ["relay", "enrollment", { policy: "ask" }, "PUT"],
      ["tailscale", "settings", { joinPolicy: "ask" }],
    ]);
  });

  test("devices: with an account linked, a Tailscale device kept at pairing codes stays there", async () => {
    gateway.relay = relayLinked({ policy: "ask" });
    gateway.tailscale = { ...tailscaleConnected(), joinPolicy: "off" };
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "devices", self: false, own: "host", url: "" }));
    await mount(FLAGS.both);
    // The account's answer is the one shown; the device's stays out of it, and says where to change it.
    expect(isChecked(host.querySelector('input[name="remote-access-policy"][value="ask"]'))).toBe(true);
    expect(text()).not.toContain("Right now");
    expect(text()).toContain("A new device can ask to join by signing in with your Omnesis account.");
    expect(text()).toContain("The gateway's Tailscale device still takes only pairing codes.");
    await act(async () => link("Change that on its page")!.click());
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/tailscale");
    for (const choice of ["automatic", "ask"]) {
      await toggle(`input[name="remote-access-policy"][value="${choice}"]`, true);
      expect(calls("relay").at(-1)).toEqual(["relay", "enrollment", { policy: choice }, "PUT"]);
    }
    expect(calls("tailscale")).toEqual([]);
    expect(gateway.tailscale!.joinPolicy).toBe("off");
    await click("Finish");
    expect(text()).toContain(["Ask me first.", "The", "Tailscale device takes only pairing codes."].join(" "));
  });

  test("devices: when the two differ nothing is preselected and the difference is said", async () => {
    gateway.relay = relayLinked({ policy: "automatic" });
    gateway.tailscale = tailscaleConnected("ask");
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "devices", self: false, own: "host", url: "" }));
    await mount(FLAGS.both);
    expect([...host.querySelectorAll('input[name="remote-access-policy"]')].some((r) => isChecked(r))).toBe(false);
    expect(text()).toContain("Right now devices that sign in join automatically and Tailscale devices wait for you.");
  });

  test("choosing my own setup turns the other two off after a confirmation", async () => {
    gateway.relay = relayLinked();
    gateway.tailscale = tailscaleConnected();
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "connection", self: false, own: "host", url: "" }));
    await mount(FLAGS.both);
    await toggle("#remote-access-way-self", true);
    expect(host.querySelector(".confirm-modal-body")?.textContent).toContain(
      "This turns off the gateway's own Tailscale device and the Omnesis relay.",
    );
    await confirmModal();
    expect(calls("relay").at(-1)).toEqual(["relay", "disable", {}, "POST"]);
    expect(calls("tailscale").at(-1)).toEqual(["tailscale", "enable", false]);
    expect(isChecked(way("self"))).toBe(true);
    expect(text()).toContain("Found: this computer is on your Tailscale network as studio.example-net.ts.net.");
  });

  test("my own setup waits when the relay won't turn off", async () => {
    const relayApi = await import(
      // @ts-expect-error — portal modules are plain JS.
      "../lib/cloud-relay-api.js"
    );
    gateway.relay = relayLinked();
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "connection", self: false, own: "host", url: "" }));
    await mount(FLAGS.relay);
    vi.mocked(relayApi.relayManagement).mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "operation-in-progress" }));
    await toggle("#remote-access-way-self", true);
    await confirmModal();
    expect(text()).toContain("Another change is in progress.");
    expect(isChecked(way("self"))).toBe(false);
    expect(isChecked(way("relay"))).toBe(true);
  });

  test("Tailscale on this computer: refused with the command, then public only once the gateway trusts the proxy", async () => {
    gateway.publish = { ok: false, reason: "This gateway is not allowed to change Tailscale on this computer.", command: "tailscale serve --bg https+insecure://localhost:7600" };
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "connection", self: true, own: "host", url: "" }));
    await mount(FLAGS.both);
    await click("Set it up for me");
    expect(calls("publish")).toEqual([["publish", false]]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("not allowed to change Tailscale");
    expect(host.querySelector(".copy-block-code")?.textContent).toBe("tailscale serve --bg https+insecure://localhost:7600");
    gateway.publish = { ok: true, url: "https://studio.example-net.ts.net" };
    // A public address is published straight away: the gateway needs no setting or restart first.
    await toggle(".remote-access-check input", true);
    expect(button("Set it up for me")?.hasAttribute("disabled")).toBe(false);
    await click("Set it up for me");
    expect(calls("publish").at(-1)).toEqual(["publish", true]);
    // Public: the address becomes the gateway's public address at once, with no restart to ask for.
    expect(calls("config")).toEqual([["config", { gateway: { publicBaseUrl: "https://studio.example-net.ts.net" } }]]);
    expect(text()).toContain("Serving this gateway at https://studio.example-net.ts.net, on your Tailscale network and to the Internet.");
    expect(text()).not.toContain("Restart the gateway");
    expect(text()).not.toContain("OMNESIS_TRUST_PROXY");
  });

  test("Tailscale on this computer: a check re-reads, and an unavailable daemon gives the reason", async () => {
    gateway.host = { state: "unavailable", reason: "Tailscale is not running on this computer." };
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "connection", self: true, own: "host", url: "" }));
    await mount(FLAGS.both);
    expect(text()).toContain("Tailscale is not running on this computer.");
    gateway.host = { state: "available", dnsName: "studio.example-net.ts.net", port: 443, url: "https://studio.example-net.ts.net", servesGateway: true, publicGateway: false };
    await click("Check again");
    expect(text()).toContain("Serving this gateway at https://studio.example-net.ts.net, to your Tailscale devices only.");
    expect(calls("host")).toHaveLength(2);
    expect(button("Set it up for me")).toBeUndefined();
  });

  test("Tailscale on this computer: another app on 443 moves the gateway to its own port, and none free offers nothing to run", async () => {
    gateway.host = { state: "available", dnsName: "studio.example-net.ts.net", port: 8443, url: "https://studio.example-net.ts.net:8443", servesGateway: false, publicGateway: false };
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "connection", self: true, own: "host", url: "" }));
    await mount(FLAGS.both);
    expect(text()).toContain("Another app already uses https://studio.example-net.ts.net, so this gateway uses port 8443: https://studio.example-net.ts.net:8443.");
    expect(button("Set it up for me")).toBeDefined();
    const blocked = "Tailscale on this computer already serves other apps on 443, 8443 and 10000, the ports it can publish. Free one of them, then check again.";
    gateway.host = { state: "available", dnsName: "studio.example-net.ts.net", port: null, url: "https://studio.example-net.ts.net", servesGateway: false, publicGateway: false, blocked };
    await click("I have already done it, check it");
    expect(text()).toContain(blocked);
    expect(text()).not.toContain("Another app already uses");
    expect(button("Set it up for me")).toBeUndefined();
    expect(text()).not.toContain("Also a public address");
    expect(button("Check again")).toBeDefined();
  });

  test("my own address: checked step by step and saved, in use at once", async () => {
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "connection", self: true, own: "host", url: "" }));
    await mount(FLAGS.both);
    await toggle('input[name="remote-access-own"][value="url"]', true);
    await type("#remote-access-own-url", "https://omnesis.example.org");
    await submit(".remote-access-address");
    expect(calls("check")).toEqual([["check", "https://omnesis.example.org"]]);
    expect([...host.querySelectorAll(".remote-access-checks li")].map((li) => li.className)).toEqual(["is-ok", "is-ok", "is-ok", "is-unknown"]);
    expect(text()).toContain("This check runs inside your network, so it can't tell whether the address is reachable from outside.");
    await click("Use this address");
    expect(calls("config")).toEqual([["config", { gateway: { publicBaseUrl: "https://omnesis.example.org" } }]]);
    expect(text()).toContain("This gateway uses this address.");
    expect(text()).not.toContain("Restart the gateway");
    // A failing step is shown as failed, and nothing can be saved.
    gateway.check = { url: "https://omnesis.example.org", ok: false, steps: [{ id: "resolves", ok: false, detail: "omnesis.example.org does not resolve from this gateway." }] };
    await submit(".remote-access-address");
    expect(host.querySelector(".remote-access-checks li")?.className).toBe("is-failed");
    expect(button("Use this address")).toBeUndefined();
  });

  test("an address set by the environment is shown, and nothing offers to save another", async () => {
    gateway.remote!.publicBaseUrl = { configured: "https://env.example.org", setByEnvironment: true };
    gateway.host = { state: "available", dnsName: "studio.example-net.ts.net", url: "https://studio.example-net.ts.net", servesGateway: true, publicGateway: true };
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "connection", self: true, own: "url", url: "" }));
    await mount(FLAGS.both);
    expect(text()).toContain("This gateway's public address, https://env.example.org, is set by OMNESIS_PUBLIC_BASE_URL in its environment, so it can't be changed here.");
    expect(host.querySelector("#remote-access-own-url")).toBeNull();
    await toggle('input[name="remote-access-own"][value="host"]', true);
    expect(button("Use https://studio.example-net.ts.net as this gateway's public address")).toBeUndefined();
    expect(calls("config")).toEqual([]);
  });

  test("finish, summary, detail links and a review that keeps everything", async () => {
    gateway.relay = relayLinked();
    gateway.tailscale = tailscaleConnected();
    await mount(FLAGS.both);
    await click("Continue");
    await click("Continue");
    await click("Finish");
    expect(calls("remote")).toEqual([["remote", { setupCompleted: true }]]);
    expect(storage.has("omnesis.remote-access.setup")).toBe(false);
    expect(heading()).toBe("Remote access is set up");
    expect(text()).toContain("This gateway is linked to your Omnesis account.");
    expect(text()).toContain("Tailscale (omnesis.example-net.ts.net) and the Omnesis relay. Home network first, then Tailscale, then the relay.");
    expect(text()).toContain("Ask me first.");
    await act(async () => link("Manage account")!.click());
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/account");
    const manageDevice = ["Manage", "Tailscale", "device"].join(" ");
    await act(async () => link(manageDevice)!.click());
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/tailscale");
    await click("Review settings");
    expect(heading()).toBe("Still good? This gateway is linked to your Omnesis account");
    expect(button("Unlink this gateway")).toBeTruthy();
    await click("Keep it");
    expect(heading()).toBe("Still good? How should your devices reach this gateway when they are away from home?");
    await click("Keep and continue");
    await click("Keep and finish");
    expect(heading()).toBe("Remote access is set up");
    // A review completes nothing again.
    expect(calls("remote")).toHaveLength(1);
  });

  test("a summary visit opens directly, and a stale saved setup is not resumed", async () => {
    gateway.remote!.setupCompletedAt = "2026-11-15T10:00:00Z";
    gateway.remote!.publicBaseUrl = { configured: "https://omnesis.example.org", setByEnvironment: false };
    storage.set("omnesis.remote-access.setup", JSON.stringify({ mode: "setup", step: "devices", self: false, own: "host", url: "" }));
    await mount(FLAGS.both);
    expect(heading()).toBe("Remote access is set up");
    expect(text()).toContain("Not used.");
    expect(text()).toContain("Your own address (https://omnesis.example.org). Your home network comes first.");
    expect(text()).toContain("Only with a pairing code from Settings, Devices.");
  });
});

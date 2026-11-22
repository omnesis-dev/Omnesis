// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  status: null as Record<string, any> | null,
  error: "",
  busy: "",
  run: vi.fn(),
  version: "",
}));
const accountRefresh = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
vi.mock("../lib/router.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  navigate,
}));
const acknowledge = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../lib/cloud-relay-api.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  acknowledgeExistingAccount: acknowledge,
}));
vi.mock("../lib/use-relay-management.js", () => ({
  useRelayManagement: () => state,
  useAccountRefresh: accountRefresh,
}));
// @ts-expect-error portal JS
import { SETUP_COPY } from "../components/gateway-passkey-confirm.js";
// @ts-expect-error portal JS
import { RelayView, relayPhase } from "./relay.js";
// @ts-expect-error portal JS
import { closeConnectWindow } from "../lib/connect-window.js";

let host: HTMLElement;
const HOST = "northstar.relay.example.test";
const AUTHORIZE = "https://relay.example.test/_relay/v3/signup/begin?ticket=fictional";
/** The same link as the portal's own window opens it, marked so the finished page closes it. */
const AUTHORIZE_IN_WINDOW = `${AUTHORIZE}&window=portal`;
function base(): Record<string, any> {
  return {
    enabled: false,
    configured: false,
    serviceConfigured: true,
    gatewayId: "00000000-0000-4000-8000-000000000001",
    config: {
      relayUrl: "https://relay.example.test",
      acmeTermsUrl: "https://ca.example.test/terms",
      termsAccepted: false,
      invitationRequired: false,
    },
    google: { configured: false },
    enrollment: { state: "unconfigured" },
    tunnel: { state: "disabled" },
    certificate: { state: "unconfigured" },
    publicMcp: { ready: false },
    can: { configure: true, enable: true, disable: false, reconnect: false, renew: false },
  };
}
function connected(over: Record<string, any> = {}): Record<string, any> {
  return {
    ...base(),
    enabled: true,
    configured: true,
    hostname: HOST,
    publicOrigin: `https://${HOST}`,
    account: {
      activated: true,
      configured: true,
      linked: true,
      canLink: false,
      canUnlink: true,
      pendingUnlink: false,
    },
    enrollment: { state: "enrolled" },
    tunnel: { state: "online", lastConnectedAt: "2028-01-01T00:00:00Z" },
    certificate: {
      state: "valid",
      expiresAt: "2028-05-01T00:00:00Z",
      lastRenewedAt: "2028-02-01T00:00:00Z",
    },
    publicMcp: { ready: true, url: `https://${HOST}/mcp` },
    can: { configure: false, enable: false, disable: true, reconnect: true, renew: true },
    deviceEnrollment: {
      policy: "automatic",
      trustedSignIns: [
        { type: "google", id: "google:fictional-subject", addedAt: Date.UTC(2028, 0, 3) },
        { type: "passkey", id: "passkey:fictional-credential", addedAt: Date.UTC(2028, 0, 5) },
      ],
      // Set up: the passkey is confirmed here, so the page shows its ordinary headline.
      confirmedSignIns: [
        { type: "passkey", id: "passkey:fictional-credential", at: 1, via: "gateway-origin" },
      ],
    },
    ...over,
  };
}
beforeEach(() => {
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  host = dom.document.querySelector("main") as unknown as HTMLElement;
  state.status = base();
  state.error = "";
  state.busy = "";
  state.version = "";
  state.run.mockReset();
  state.run.mockResolvedValue({});
  navigate.mockReset();
});
afterEach(() => {
  render(null, host);
  closeConnectWindow();
  acknowledge.mockClear();
  vi.unstubAllGlobals();
});
/** The account page by default; `"relay"` for the relay page. */
async function show(part: "account" | "relay" = "account") {
  await act(async () => render(h(RelayView, { part }), host));
}
/** Rendered text with HTML whitespace collapsed, as a browser shows it. */
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (x) => x.textContent?.trim() === label,
  ) as HTMLButtonElement;
const link = (label: string) =>
  [...host.querySelectorAll("a")].find((x) => x.textContent?.trim() === label) as HTMLAnchorElement;
const checked = (radio: HTMLInputElement) => radio.checked ?? radio.hasAttribute("checked");
const headline = () => host.querySelector(".relay-headline")?.textContent?.trim();
async function click(label: string) {
  await act(async () => button(label).click());
}

describe("relayPhase", () => {
  test("maps every status to exactly one state, an active connect first", () => {
    const cases: Array<[Record<string, any> | null, string]> = [
      [null, "loading"],
      [{ ...base(), connect: { state: "waiting" } }, "waiting"],
      [{ ...connected(), connect: { state: "registering" } }, "registering"],
      [{ ...base(), connect: { state: "linking" } }, "linking"],
      [{ ...base(), connect: { state: "failed" } }, "failed"],
      // A connection that never finished outranks how it last failed, but not a refused invite.
      [{ ...base(), unfinished: {} }, "unfinished"],
      [{ ...base(), unfinished: {}, connect: { state: "failed", error: "expired" } }, "unfinished"],
      [{ ...base(), unfinished: {}, enabled: true, enrollment: { state: "failed" } }, "unfinished"],
      [{ ...base(), unfinished: {}, connect: { state: "waiting" } }, "waiting"],
      [{ ...base(), unfinished: {}, connect: { state: "failed", error: "invite-used" } }, "failed"],
      [{ ...base(), serviceConfigured: false }, "unavailable"],
      [{ ...base(), serviceConfigured: undefined }, "unavailable"],
      [{ ...base(), enrollment: { state: "failed" } }, "failed"],
      [{ ...base(), connect: { state: "idle" } }, "not-connected"],
      [{ ...base(), enrollment: undefined }, "not-connected"],
      [connected({ enabled: false }), "off"],
      [{ ...base(), enabled: true, enrollment: { state: "pending" } }, "registering"],
      [connected(), "connected"],
      [connected({ tunnel: { state: "offline" } }), "disconnected"],
      [connected({ tunnel: { state: "connecting" } }), "reconnecting"],
      [connected({ tunnel: undefined }), "reconnecting"],
    ];
    for (const [status, phase] of cases) expect(relayPhase(status)).toBe(phase);
  });
});

test("not connected: the same choice as the setup's first step, and nothing else to fill in", async () => {
  await show();
  expect(headline()).toBe("Do you want an Omnesis account?");
  expect(host.querySelector(".relay-dot")).toBeNull();
  const lede = host.querySelector(".relay-lede")?.textContent?.replace(/\s+/g, " ").trim();
  expect(lede).toContain("None of your data goes to Omnesis");
  expect(lede).toMatch(/It's optional: skip it and set it up any time from Settings, Connectivity\.$/u);
  expect(text()).not.toContain("terms of service");
  expect(host.querySelector("details, form, input")).toBeNull();
  // Creating an account is the primary action; signing in to one is the quieter one beside it.
  expect([...host.querySelectorAll(".btn-primary")].map((x) => x.textContent?.trim())).toEqual([
    "Create an account",
  ]);
  expect(button("I already have one").className).toBe("btn-secondary");
  await click("Create an account");
  expect(state.run).toHaveBeenCalledTimes(1);
  expect(state.run).toHaveBeenLastCalledWith("connect", { termsAccepted: true, intent: "create" });
  await click("I already have one");
  expect(state.run).toHaveBeenCalledTimes(2);
  expect(state.run).toHaveBeenLastCalledWith("connect", {
    termsAccepted: true,
    intent: "existing",
  });
  // No machine jargon and no settings rows before connecting.
  for (const word of ["ACME", "SNI", "tunnel", "recovery receipt", "EXPERIMENTAL"])
    expect(text()).not.toContain(word);
  expect(host.querySelector(".relay-rows")).toBeNull();
  state.busy = "connect";
  await show();
  expect(button("Connecting…").disabled).toBe(true);
  expect(button("I already have one").disabled).toBe(true);
  expect(button("Create an account")).toBeUndefined();
  // A refresh in the background leaves both choices usable.
  state.busy = "refresh";
  await show();
  expect(button("Create an account").disabled).toBe(false);
  expect(button("I already have one").disabled).toBe(false);
});

test("the relay page before an account says the relay needs one and opens the account page", async () => {
  await show("relay");
  expect(headline()).toBe(["The", "Omnesis relay needs an Omnesis account"].join(" "));
  expect(button("Set up your account")).toBeDefined();
  expect(button("Create an account")).toBeUndefined();
  expect(host.querySelector(".relay-rows")).toBeNull();
  await click("Set up your account");
  expect(navigate).toHaveBeenCalledExactlyOnceWith("/portal/settings/account");
});

test("the relay page says why the relay service is unavailable when the gateway knows", async () => {
  state.status = { ...base(), serviceConfigured: false, serviceError: "relay-service-unavailable" };
  await show("relay");
  expect(headline()).toBe(["The", "Omnesis relay isn't available"].join(" "));
  expect(text()).toContain("Set OMNESIS_CLOUD_RELAY_URL for the gateway, then restart it.");
  expect(text()).not.toContain("This installation is not set up for Omnesis accounts.");
});

test("waiting: open sign-in in a new tab, or enter the code on another device, or cancel", async () => {
  const expiresAt = Date.UTC(2028, 0, 1, 16, 42);
  state.status = {
    ...base(),
    connect: {
      state: "waiting",
      authorizeUrl: AUTHORIZE,
      connectUrl: "https://relay.example.test/_relay/connect",
      code: "H7KM-3QPX",
      expiresAt,
    },
  };
  await show();
  expect(headline()).toBe("Sign in to your Omnesis account");
  const open = link("Sign in to your Omnesis account");
  expect(open.getAttribute("href")).toBe(AUTHORIZE);
  expect(open.getAttribute("target")).toBe("_blank");
  expect(text()).toContain("Or on another device, visit");
  expect(link("relay.example.test/_relay/connect").getAttribute("href")).toBe(
    "https://relay.example.test/_relay/connect",
  );
  expect(host.querySelector(".relay-code")?.textContent).toBe("H7KM-3QPX");
  expect(text()).toContain(
    new Date(expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  );
  await click("Cancel");
  expect(state.run).toHaveBeenLastCalledWith("connect/cancel", {});
  state.busy = "connect/cancel";
  await show();
  expect(button("Cancelling…").disabled).toBe(true);
});

test("waiting shows the relay's short address while the link stays on the relay's own page", async () => {
  const connect = {
    state: "waiting",
    authorizeUrl: AUTHORIZE,
    connectUrl: "https://relay.example.test/_relay/connect",
    code: "H7KM-3QPX",
  };
  state.status = {
    ...base(),
    connect: { ...connect, connectShortUrl: "https://front.example.test/connect" },
  };
  await show();
  expect(link("front.example.test/connect").getAttribute("href")).toBe(
    "https://relay.example.test/_relay/connect",
  );
  expect(text()).not.toContain("relay.example.test/_relay/connect");
  for (const connectShortUrl of [
    "http://front.example.test/connect",
    "javascript:alert(1)",
    "https://name:secret@front.example.test/connect",
    7,
  ]) {
    state.status = { ...base(), connect: { ...connect, connectShortUrl } };
    await show();
    expect(link("relay.example.test/_relay/connect")).toBeDefined();
    expect(text()).not.toContain("front.example.test");
  }
});

test("waiting never links to unsafe addresses or shows a malformed code", async () => {
  state.status = {
    ...base(),
    connect: {
      state: "waiting",
      authorizeUrl: "http://relay.example.test/x",
      connectUrl: "https://relay.example.test/",
      code: "<b>bad</b>",
    },
  };
  await show();
  expect(link("Sign in to your Omnesis account")).toBeUndefined();
  expect(host.querySelector(".relay-code")).toBeNull();
  expect(button("Cancel")).toBeDefined();
  state.status = {
    ...base(),
    connect: { state: "waiting", connectUrl: "https://relay.example.test/", code: "H7KM-3QPX" },
  };
  await show();
  expect(link("relay.example.test")).toBeDefined();
  expect(text()).not.toContain("The code works until");
});

test("registering and linking show progress with no actions", async () => {
  for (const [connect, title] of [
    ["registering", "Registering this gateway…"],
    ["linking", "Connecting to your Omnesis account…"],
  ]) {
    state.status = { ...base(), connect: { state: connect } };
    await show();
    expect(headline()).toBe(title);
    expect(host.querySelectorAll("button")).toHaveLength(0);
  }
});

test("failed: a readable reason and one way to try again", async () => {
  state.status = { ...base(), connect: { state: "failed", error: "relay-unreachable" } };
  await show();
  expect(headline()).toBe("Couldn't connect");
  expect(text()).toContain("Omnesis Relay could not be reached");
  // The headline says what failed; the box only offers the details.
  expect(button("Copy details")).toBeDefined();
  await click("Try again");
  expect(state.run).toHaveBeenLastCalledWith("connect", { termsAccepted: true });
  // Trying again makes no choice for the person: the request names no intent.
  expect(JSON.stringify(state.run.mock.lastCall![1])).toBe('{"termsAccepted":true}');
  expect(host.querySelector("details, form, input")).toBeNull();
  state.status = { ...base(), enrollment: { state: "failed", error: "enrollment-refused" } };
  await show();
  expect(text()).toContain("couldn't register with Omnesis Relay");
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
  state.status = { ...base(), connect: { state: "failed" } };
  await show();
  expect(text()).toContain("Nothing on this gateway changed");
  state.busy = "connect";
  await show();
  expect(button("Connecting…").disabled).toBe(true);
});

describe("invite-only relay", () => {
  const INVITE = `${"a".repeat(36)}.${"b".repeat(120)}.${"c".repeat(86)}`;
  const LINK = `https://relay.example.test/invite#${INVITE}`;
  const field = () => host.querySelector("#relay-invite-input") as HTMLInputElement | null;
  async function type(value: string) {
    await act(async () => {
      const input = field()!;
      input.value = value;
      input.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
    });
  }
  test("before connecting, says accounts are private and invite-only, and creates one only with an invite", async () => {
    state.status = { ...base(), signup: { inviteOnly: true } };
    await show();
    expect(host.querySelector(".relay-lede")?.textContent?.replace(/\s+/g, " ")).toContain(
      "Omnesis accounts are private and invite-only for now: creating one needs an invite link.",
    );
    expect(host.querySelector(".relay-private-badge")?.textContent).toBe("Private · invite only");
    expect(field()?.getAttribute("placeholder")).toBe("Paste the invite link you were sent");
    // Nothing is said under the field until there is something wrong with it.
    expect(host.querySelector("#relay-invite-problem")).toBeNull();
    expect(text()).not.toContain("needs no invite");
    // Without an invite there is no account to create, but an existing one can still connect.
    expect(button("Create an account").disabled).toBe(true);
    await click("I already have one");
    expect(state.run).toHaveBeenLastCalledWith("connect", {
      termsAccepted: true,
      intent: "existing",
    });
    await type("https://relay.example.test/invite#cut-short");
    expect(field()?.getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain("That isn't a whole invite link.");
    expect(button("Create an account").disabled).toBe(true);
    await type(`  ${LINK} `);
    expect(field()?.getAttribute("aria-invalid")).toBe("false");
    expect(button("Create an account").disabled).toBe(false);
    await click("Create an account");
    // Only the invite's own token leaves the page.
    expect(state.run).toHaveBeenLastCalledWith("connect", {
      termsAccepted: true,
      intent: "create",
      invite: INVITE,
    });
    // Signing in to an existing account never sends the invite.
    await click("I already have one");
    expect(state.run).toHaveBeenLastCalledWith("connect", {
      termsAccepted: true,
      intent: "existing",
    });
  });
  test("a relay that is not invite-only asks for no invite", async () => {
    for (const signup of [undefined, { inviteOnly: false }, { inviteOnly: "true" }]) {
      state.status = { ...base(), ...(signup ? { signup } : {}) };
      await show();
      expect(text()).not.toContain("invite-only");
      expect(field()).toBeNull();
      expect(button("Create an account").disabled).toBe(false);
    }
  });
  test("is not shown once connecting or connected, or after another failure", async () => {
    const signup = { inviteOnly: true };
    for (const status of [
      { ...base(), signup, connect: { state: "waiting", authorizeUrl: AUTHORIZE } },
      { ...base(), signup, connect: { state: "failed", error: "relay-unreachable" } },
      connected({ signup }),
    ]) {
      state.status = status;
      await show();
      expect(field()).toBeNull();
      expect(host.querySelector(".relay-private-badge")).toBeNull();
    }
  });
  for (const [error, words] of [
    ["invite-invalid", "That invite isn't valid. Check that you pasted the whole invite link."],
    ["invite-expired", "That invite has expired. Ask whoever sent it for a new one."],
    ["invite-used", "That invite was already used to create an account. Ask for a new one."],
  ] as const)
    test(`a refused invite (${error}) says why under the field and offers the choice again`, async () => {
      state.status = { ...base(), signup: { inviteOnly: true }, connect: { state: "failed", error } };
      await show();
      expect(headline()).toBe("Do you want an Omnesis account?");
      // Nothing to diagnose: the problem box with its details stays away.
      expect(text()).not.toContain("Copy details");
      const problem = () => host.querySelector("#relay-invite-problem");
      expect(problem()?.textContent).toBe(words);
      expect(problem()?.getAttribute("role")).toBe("alert");
      expect(problem()?.previousElementSibling).toBe(field());
      expect(field()?.getAttribute("aria-invalid")).toBe("true");
      expect(field()?.getAttribute("aria-describedby")).toBe("relay-invite-problem");
      // Said once, under the field, and still said after the page reads the status again.
      expect(text().split(words)).toHaveLength(2);
      await show();
      expect(problem()?.textContent).toBe(words);
      expect(button("Create an account").disabled).toBe(true);
      expect(button("I already have one")).toBeDefined();
      expect(button("Try again")).toBeUndefined();
      // Editing the invite answers it.
      await type(LINK);
      expect(problem()).toBeNull();
      expect(button("Create an account").disabled).toBe(false);
      await click("Create an account");
      // Connecting again with the same refusal back says it again.
      await show();
      expect(problem()?.textContent).toBe(words);
    });
  test("a refused invite with no invite field to show it under is said where errors always are", async () => {
    const words = "That invite was already used to create an account. Ask for a new one.";
    Object.assign(state, { error: words, errorCode: "invite-used" });
    try {
      state.status = { ...base(), signup: { inviteOnly: false } };
      await show();
      expect(field()).toBeNull();
      expect(host.querySelector(".relay-notice")?.textContent).toBe(words);
    } finally {
      Object.assign(state, { error: "", errorCode: "" });
    }
    state.status = { ...base(), connect: { state: "failed", error: "invite-used" } };
    await show();
    expect(headline()).toBe("Couldn't connect");
    expect(text()).toContain(words);
  });
  test("an invite refused as the person presses to connect is said under the field until they edit it", async () => {
    const clearError = vi.fn();
    Object.assign(state, {
      error: "That invite was already used to create an account. Ask for a new one.",
      errorCode: "invite-used",
      clearError,
    });
    try {
      state.status = { ...base(), signup: { inviteOnly: true } };
      await show();
      const problem = host.querySelector("#relay-invite-problem");
      expect(problem?.textContent).toBe(state.error);
      expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
      await type("https://relay.example.test/invite#another");
      expect(clearError).toHaveBeenCalledOnce();
      // Any other failure is still said above, where it was.
      Object.assign(state, { error: "Couldn't load or update your Omnesis account settings.", errorCode: "" });
      await show();
      expect(host.querySelector(".relay-notice")?.textContent).toBe(state.error);
      expect(host.querySelector("#relay-invite-problem")?.textContent).toBe("That isn't a whole invite link. Copy all of it, including the part after #.");
    } finally {
      Object.assign(state, { error: "", errorCode: "", clearError: undefined });
    }
  });
});

test("unavailable installations explain the situation, offer nothing to press and never show service URLs", async () => {
  state.status = {
    ...base(),
    serviceConfigured: false,
    config: { ...base().config, relayUrl: "https://private-operator.example.test" },
  };
  await show();
  expect(headline()).toBe("Omnesis accounts aren't available here");
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(text()).not.toContain("private-operator.example.test");
  await show("relay");
  expect(headline()).toBe(["The", "Omnesis relay isn't available"].join(" "));
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(text()).not.toContain("private-operator.example.test");
  await show();
  state.status.serviceError = "relay-service-mismatch";
  await show();
  expect(text()).toContain("names a different relay service from the one this gateway is registered with");
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
});

test("the portal link says why it cannot be used yet, and is left out without a public address", async () => {
  state.status = connected({ enabled: false });
  await show("relay");
  // The reason is said once, under the address; the portal link carries no promise meanwhile.
  expect(host.querySelector(".relay-portal + .relay-hint")).toBeNull();
  expect(host.querySelector(".relay-address + .relay-hint")?.textContent?.trim()).toBe(
    "Not reachable while remote access is off.",
  );
  state.status = connected({ publicOrigin: "http://not-https.example.test" });
  await show("relay");
  expect(host.querySelector(".relay-portal")).toBeNull();
  state.status = connected({ publicOrigin: undefined });
  await show("relay");
  expect(host.querySelector(".relay-portal")).toBeNull();
  expect(host.querySelector('button[aria-label="Copy portal link"]')).toBeNull();
  // No confirmed address yet: neither the address nor the portal is offered.
  state.status = connected({ publicMcp: { ready: false } });
  await show("relay");
  expect(host.querySelector(".relay-portal")).toBeNull();
});

test("connected: the account page holds the account, the relay page the connection, each plain", async () => {
  state.status = connected();
  await show();
  expect([...host.querySelectorAll(".relay-section-title")].map((x) => x.textContent)).toEqual([
    "Account",
    "Trusted sign-ins",
  ]);
  expect([...host.querySelectorAll(".relay-row-label")].map((x) => x.textContent)).toEqual(["This gateway"]);
  expect(
    [...host.querySelectorAll("button")].map((x) => x.textContent?.trim()).filter(Boolean),
  ).toEqual(["Unlink this gateway"]);
  expect(host.querySelector(".relay-portal")).toBeNull();

  await show("relay");
  expect(headline()).toBe(`Connected as ${HOST}`);
  expect(host.querySelector(".relay-dot-ok")).not.toBeNull();
  expect(host.querySelector(".btn-primary")).toBeNull();
  const titles = [...host.querySelectorAll(".relay-section-title")];
  expect(titles.map((x) => x.textContent)).toEqual(["Remote access"]);
  expect(new Set(titles.map((x) => x.tagName))).toEqual(new Set(["H3"]));
  expect([...host.querySelectorAll(".relay-row-label")].map((x) => x.textContent)).toEqual([
    "Portal",
    "Address",
    "Status",
  ]);
  expect(text()).toContain(`https://${HOST}/mcp`);
  // The portal itself, at the public address, as a link to open and to copy.
  const portal = host.querySelector<HTMLAnchorElement>(".relay-portal a");
  expect(portal?.getAttribute("href")).toBe(`https://${HOST}/portal/`);
  expect(portal?.textContent).toBe(`${HOST}/portal/`);
  expect(portal?.getAttribute("target")).toBe("_blank");
  expect(portal?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(host.querySelector('button[aria-label="Copy portal link"]')).not.toBeNull();
  expect(text()).toContain(
    "Your portal is now reachable at this link from anywhere, not only at home. A new browser asks you to sign in with your Omnesis account.",
  );
  // A ready address needs no hint under it.
  expect(host.querySelector(".relay-address + .relay-hint")).toBeNull();
  expect(host.querySelector('button[aria-label="Copy address"]')).not.toBeNull();
  // Nothing is wrong, so there is no problem box and no details to copy.
  expect(host.querySelector(".relay-problems")).toBeNull();
  expect(button("Copy details")).toBeUndefined();
  // The debugging record lives in `omnesis cloud status`, not on the page.
  expect(host.querySelector("details, dl")).toBeNull();
  for (const gone of [
    "Connection details",
    "Sign-in methods",
    "ertificate",
    "Gateway ID",
    "Recovery receipt",
    "Reconnect",
  ])
    expect(text()).not.toContain(gone);
  expect(
    [...host.querySelectorAll("button")].map((x) => x.textContent?.trim()).filter(Boolean),
  ).toEqual(["Turn off"]);
  state.status = connected({ hostname: undefined, can: { disable: false } });
  await show("relay");
  expect(headline()).toBe("Connected as your gateway");
  expect(button("Turn off").disabled).toBe(true);
});

test("turning remote access off and on says what it does, to a pointer, a keyboard and a screen reader", async () => {
  state.status = connected();
  await show("relay");
  const off = button("Turn off");
  const offTip =
    "Stops access from outside your home network. This gateway keeps its address and stays in your Omnesis account. You can turn it back on at any time.";
  expect(off.getAttribute("title")).toBe(offTip);
  const described = host.querySelector(`#${off.getAttribute("aria-describedby")}`)!;
  expect(described.getAttribute("role")).toBe("tooltip");
  expect(described.textContent).toBe(offTip);
  await click("Turn off");
  expect(state.run).toHaveBeenLastCalledWith("disable");
  state.busy = "disable";
  await show("relay");
  expect(button("Turning off…").disabled).toBe(true);
  state.busy = "";
  state.status = connected({ enabled: false, tunnel: { state: "disabled" }, can: { enable: true } });
  await show("relay");
  const on = button("Turn on");
  const onTip =
    "Makes this gateway reachable from outside your home network again, at the same address.";
  expect(on.getAttribute("title")).toBe(onTip);
  expect(host.querySelector(`#${on.getAttribute("aria-describedby")}`)!.textContent).toBe(onTip);
});

test("the address says whether it can be used, and calls it unreachable only once the gateway does", async () => {
  const url = `https://${HOST}/mcp`;
  state.status = connected({ publicMcp: { ready: false, url } });
  await show("relay");
  expect(text()).toContain(
    "Checking that this address answers. This takes up to a minute after the gateway connects.",
  );
  // Still checking is not a problem.
  expect(host.querySelector(".relay-problems")).toBeNull();
  expect(text()).not.toContain("does not answer");
  state.status = connected({
    publicMcp: { ready: false, url, lastError: "public-endpoint-unreachable" },
  });
  await show("relay");
  expect(text()).not.toContain("Checking that this address answers");
  expect(text()).toContain("This address does not answer right now.");
  expect(host.querySelector(".relay-problems")!.textContent).toContain(
    "This gateway's address does not answer from outside your home network.",
  );
  state.status = connected({ tunnel: { state: "offline" }, publicMcp: { ready: false, url } });
  await show("relay");
  expect(text()).toContain("Not reachable while this gateway is disconnected from the relay.");
  state.status = connected({
    enabled: false,
    tunnel: { state: "disabled" },
    publicMcp: { ready: false, url },
  });
  await show("relay");
  expect(text()).toContain("Not reachable while remote access is off.");
  state.status = connected({ publicMcp: { ready: false } });
  await show("relay");
  expect([...host.querySelectorAll(".relay-row-label")].map((x) => x.textContent)).toEqual([
    "Status",
  ]);
});

test("reconnecting, disconnected and off each lead with their own state and action", async () => {
  state.status = connected({ tunnel: { state: "connecting" } });
  await show("relay");
  expect(headline()).toBe("Reconnecting…");
  expect(host.querySelector(".relay-dot-warning")).not.toBeNull();
  await click("Turn off");
  expect(state.run).toHaveBeenLastCalledWith("disable");
  state.status = connected({ tunnel: { state: "offline", lastError: "tunnel-disconnected" } });
  await show("relay");
  expect(headline()).toBe("Disconnected");
  expect(text()).toContain("Remote access was interrupted");
  // Said once, in the headline; the box offers the details.
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
  expect(button("Copy details")).toBeDefined();
  await click("Reconnect");
  expect(state.run).toHaveBeenLastCalledWith("reconnect");
  state.status = connected({ tunnel: { state: "offline" }, can: { reconnect: false } });
  await show("relay");
  expect(text()).toContain("Remote access dropped");
  expect(button("Reconnect").disabled).toBe(true);
  state.busy = "reconnect";
  state.status = connected({ tunnel: { state: "offline" } });
  await show("relay");
  expect(button("Reconnecting…").disabled).toBe(true);
  state.busy = "";
  state.status = connected({
    enabled: false,
    tunnel: { state: "disabled" },
    can: { enable: true },
  });
  await show("relay");
  expect(headline()).toBe("Remote access is off");
  // Still in the account: it can be turned on, managed or disconnected from here.
  expect(
    [...host.querySelectorAll("button")].map((x) => x.textContent?.trim()).filter(Boolean),
  ).toEqual(["Turn on"]);
  expect(host.querySelector(
      '[aria-labelledby="relay-remote-access-title"] .relay-row:last-child .relay-row-value',
    )?.textContent).toBe("Off");
  expect(host.querySelector(".relay-problems")).toBeNull();
  await click("Turn on");
  expect(state.run).toHaveBeenLastCalledWith("enable", {});
  state.busy = "enable";
  await show("relay");
  expect(button("Turning on…").disabled).toBe(true);
});

describe("problems", () => {
  const FINGERPRINT = "f".repeat(64);
  const troubled = () =>
    connected({
      enrollment: { state: "enrolled", error: "enrollment-refused" },
      tunnel: {
        state: "online",
        lastConnectedAt: "2028-01-01T00:00:00Z",
        lastError: "relay-unreachable",
      },
      certificate: {
        state: "expiring",
        expiresAt: "2028-05-01T00:00:00Z",
        lastRenewedAt: "2028-02-01T00:00:00Z",
        lastError: "certificate-renewal-failed",
      },
      publicMcp: {
        ready: false,
        url: `https://${HOST}/mcp`,
        lastError: "public-endpoint-unreachable",
      },
      identities: [
        {
          id: "direct",
          names: ["home.example.test"],
          kind: "self-signed",
          state: "valid",
          expiresAt: "2029-01-01T00:00:00Z",
        },
      ],
      certificateMonitor: {
        state: "incident",
        lastCompletedAt: "2028-01-02T00:00:00Z",
        lastError: "relay-unreachable",
        incidents: [
          {
            hostname: HOST,
            spkiFingerprint: FINGERPRINT,
            certificateFingerprint: "e".repeat(64),
            issuer: "Fictional test issuer",
            serial: "ABCD",
            validFrom: "2028-01-01T00:00:00Z",
            validTo: "2028-02-01T00:00:00Z",
            observedAt: "2028-01-02T00:00:00Z",
            providerEntryId: "fixture-entry-1",
          },
        ],
      },
      account: { ...connected().account, lastError: "account-link-failed" },
      recovery: { receipt: "present", expiresAt: 1_900_000_000 },
    });

  test("one box says each problem once in plain words, with the hook's own error kept apart", async () => {
    state.error = "Couldn't load or update your Omnesis account settings.";
    state.status = troubled();
    await show("relay");
    const boxes = host.querySelectorAll(".relay-problems");
    expect(boxes).toHaveLength(1);
    const box = boxes[0]!;
    expect(box.querySelector("h3")?.textContent?.trim()).toBe("Some things need your attention");
    const alerts = [...host.querySelectorAll('[role="alert"]')];
    expect(alerts[0]!.textContent).toBe("Couldn't load or update your Omnesis account settings.");
    expect(alerts[0]!.closest(".relay-problems")).toBeNull();
    const said = alerts.slice(1).map((alert) => alert.textContent);
    expect(said.every((sentence) => box.textContent!.includes(sentence!))).toBe(true);
    expect(said).toEqual([
      "This gateway couldn't register with Omnesis Relay. It keeps trying by itself. If this message stays, try connecting again.",
      "Omnesis Relay could not be reached. Check this gateway's internet connection. It keeps trying by itself.",
      "The certificate for this gateway's address could not be renewed. The gateway tries again by itself.",
      "This gateway's address does not answer from outside your home network. Check that this gateway is online. It checks again by itself.",
      "Couldn't connect this gateway to your Omnesis account. Try again. Existing device access is unchanged.",
      `The certificate for this gateway's address expires on ${new Date("2028-05-01T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}. The gateway renews it by itself. If this message stays for more than a day, ask for help.`,
      "A certificate for this gateway's address was issued with a key this gateway does not hold. Someone else may be able to pose as this gateway. Copy the details and ask for help before you add new devices.",
    ]);
    expect(box.textContent).toContain("omnesis cloud status");
    // Nothing on the page points at a section that is gone, and the evidence stays in the details.
    expect(text()).not.toContain("Connection details");
    expect(text()).not.toContain(FINGERPRINT);
    state.error = "";
    state.status = connected({ certificate: { state: "expiring" } });
    await show("relay");
    expect(text()).toContain("expires on a date soon");
    expect(host.querySelector(".relay-problems h3")?.textContent?.trim()).toBe(
      "Something needs your attention",
    );
    state.status = connected({ certificate: { state: "expired" } });
    await show("relay");
    expect(text()).toContain("has expired, so devices away from home cannot connect");
    // With remote access off, what its certificate, tunnel and address last said is nobody's problem.
    state.status = connected({
      enabled: false,
      tunnel: { state: "disabled", lastError: "tunnel-disconnected" },
      certificate: { state: "expired", lastError: "certificate-renewal-failed" },
      publicMcp: { ready: false, lastError: "public-endpoint-unreachable" },
    });
    await show("relay");
    expect(host.querySelector(".relay-problems")).toBeNull();
  });

  test("Copy details puts the old record on the clipboard as plain text, with no sign-in identifiers", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    state.version = "9.8.7";
    state.status = troubled();
    await show("relay");
    await click("Copy details");
    expect(button("Copied")).toBeDefined();
    const copied = writeText.mock.calls[0]![0];
    expect(copied.split("\n").slice(2)).toEqual([
      "Gateway version: 9.8.7",
      "Page state: connected",
      "Error codes: enrollment-refused (registration), relay-unreachable (tunnel), certificate-renewal-failed (certificate), public-endpoint-unreachable (address), relay-unreachable (certificate monitor), account-link-failed (account), certificate-expiring (certificate), unexpected-certificate (certificate monitor)",
      "Remote access: on",
      `Address: https://${HOST}/mcp (not answering)`,
      "Registration: enrolled, gateway ID 00000000-0000-4000-8000-000000000001",
      "Tunnel: online, last connected 2028-01-01T00:00:00.000Z",
      "Public certificate: expiring, expires 2028-05-01T00:00:00.000Z, last renewed 2028-02-01T00:00:00.000Z",
      "Home certificate: self-signed, valid, expires 2029-01-01T00:00:00.000Z",
      "Certificate monitor: incident, last checked 2028-01-02T00:00:00.000Z",
      `Unexpected certificate: name ${HOST}, public key ${FINGERPRINT}, certificate ${"e".repeat(64)}, issuer Fictional test issuer, serial ABCD, valid 2028-01-01T00:00:00.000Z to 2028-02-01T00:00:00.000Z, seen 2028-01-02T00:00:00.000Z, log entry fixture-entry-1`,
      "Account: linked",
      "New devices: automatic, 1 confirmed sign-ins, 2 on record",
      "Recovery receipt: present, expires 2030-03-17T17:46:40.000Z",
      "Relay: https://relay.example.test",
      "Certificate provider: none",
      "",
    ]);
    expect(copied.split("\n")[0]).toBe("Omnesis account details");
    expect(copied.split("\n")[1]).toMatch(/^Time: \d{4}-\d\d-\d\dT/);
    expect(copied).not.toContain("fictional-subject");
    expect(copied).not.toContain("fictional-credential");
    expect(copied).not.toContain("home.example.test");
  });

  test("without clipboard access the details are shown to select, and sparse or hostile status still prints", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    state.status = {
      ...base(),
      connect: { state: "failed", error: "not-allowed\nInjected: line" },
      tunnel: undefined,
      certificate: undefined,
      publicMcp: undefined,
      enrollment: undefined,
      google: undefined,
      config: undefined,
    };
    await show();
    expect(host.querySelector("textarea")).toBeNull();
    await click("Copy details");
    await act(async () => {});
    expect(text()).toContain("Couldn't copy. Select the text below and copy it.");
    const shown = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(shown.hasAttribute("readonly")).toBe(true);
    const value = String((shown as any).value ?? shown.getAttribute("value"));
    expect(value).toContain("Page state: failed");
    expect(value).toContain("Error codes: not-allowed Injected: line (connect)");
    expect(value).toContain("Address: none (not confirmed)");
    expect(value).toContain("Tunnel: unknown, last connected not recorded");
    expect(value).toContain("Account: not linked");
    expect(value.split("\n")).toHaveLength(17);
  });
});

test("a gateway whose account was deleted says so above the offer to connect again", async () => {
  state.status = { ...base(), notice: "account-deleted" };
  await show();
  expect(headline()).toBe("Do you want an Omnesis account?");
  expect(host.querySelector('[role="status"].relay-notice')?.textContent).toContain(
    "Your Omnesis account was deleted, so this gateway is no longer linked to it",
  );
  expect(button("Create an account")).toBeDefined();
  expect(host.querySelector(".relay-problems")).toBeNull();
  state.status = base();
  await show();
  expect(host.querySelector(".relay-notice")).toBeNull();
});

test("a gateway unlinked on its account page says so above the usual offer to connect", async () => {
  state.status = { ...base(), notice: "gateway-removed" };
  await show();
  expect(headline()).toBe("Do you want an Omnesis account?");
  const notice = host.querySelector('[role="status"].relay-notice')?.textContent ?? "";
  expect(notice).toContain("This gateway was unlinked from your Omnesis account on the account page");
  expect(notice).toContain("Nothing on it was deleted");
  expect(notice).not.toContain("deleted, so");
  expect(button("Create an account")).toBeDefined();
  expect(button("I already have one")).toBeDefined();
  expect(host.querySelector(".relay-problems")).toBeNull();
  state.status = base();
  await show();
  expect(host.querySelector(".relay-notice")).toBeNull();
});

test("an error before an account is said once, in the account choice", async () => {
  state.error = "Couldn't load or update your Omnesis account settings. Check the connection and try again.";
  await show();
  expect([...host.querySelectorAll('[role="alert"]')].map((x) => x.textContent)).toEqual([state.error]);
  expect(button("Create an account").disabled).toBe(false);
  state.status = connected();
  await show();
  expect([...host.querySelectorAll('[role="alert"]')].map((x) => x.textContent)).toEqual([state.error]);
});

test("loading shows a skeleton and a failed first load offers a retry without exception details", async () => {
  state.status = null;
  state.busy = "refresh";
  await show();
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  state.busy = "";
  state.error = "Couldn't load or update your Omnesis account settings. Check the connection and try again.";
  await show();
  expect(headline()).toBe("Couldn't load your Omnesis account");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(state.error);
  await click("Try again");
  expect(state.run).toHaveBeenLastCalledWith();
  state.error = "";
  await show();
  expect(text()).toContain("Check the connection and try again.");
});

describe("account", () => {
  test("a connected gateway offers its account page and a disconnect that asks first and says what happens", async () => {
    state.status = connected({
      config: { ...base().config, relayUrl: "https://relay.example.test/nested?ignored=1" },
    });
    await show();
    expect(text()).toContain("This gateway is linked to your Omnesis account.");
    const manage = link("Manage your account");
    expect(manage.getAttribute("href")).toBe("https://relay.example.test/_relay/account");
    expect(manage.getAttribute("target")).toBe("_blank");
    expect(text()).not.toContain("https://relay.example.test");
    await click("Unlink this gateway");
    expect(state.run).not.toHaveBeenCalled();
    expect(text()).toContain("Unlink this gateway from your Omnesis account?");
    expect(text()).toContain(
      "This gateway leaves your Omnesis account. It can no longer be reached from outside your home network, and devices can no longer join by signing in. Devices already paired keep working on your home network.",
    );
    await click("Cancel");
    expect(state.run).not.toHaveBeenCalled();
    expect(text()).not.toContain("Unlink this gateway from your Omnesis account?");
    await click("Unlink this gateway");
    await click("Unlink");
    expect(state.run.mock.calls).toEqual([["account/unlink"]]);
    await click("Unlink this gateway");
    state.busy = "account/unlink";
    await show();
    expect(button("Unlinking…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
  });
  test("a gateway outside an account can join one, and a removal the account has not seen yet says so", async () => {
    state.status = connected({ account: { activated: true, linked: false, canLink: true } });
    await show();
    expect(text()).toContain("This gateway is not linked to an Omnesis account.");
    expect(link("Manage your account")).toBeUndefined();
    expect(button("Unlink this gateway")).toBeUndefined();
    await click("Connect to your Omnesis account");
    expect(state.run).toHaveBeenLastCalledWith("account/link");
    expect(text()).not.toContain("What happens when a new device signs in");
    state.status = connected({
      account: {
        configured: false,
        linked: false,
        pendingUnlink: true,
        lastError: "account-link-failed",
      },
    });
    await show();
    expect(text()).toContain(
      "Unlinked here. Your Omnesis account updates when the connection returns.",
    );
    // A connected gateway's problems are listed on the relay page.
    await show("relay");
    expect(host.querySelector(".relay-problems")!.textContent).toContain(
      "Existing device access is unchanged",
    );
    state.busy = "account/link";
    state.status = connected({ account: { activated: true, linked: false, canLink: true } });
    await show();
    expect(button("Connect to your Omnesis account").disabled).toBe(true);
  });
  test("the account page link is absent for unsafe service addresses", async () => {
    for (const relayUrl of [
      undefined,
      "javascript:alert(1)",
      "http://relay.example.test",
      "https://user:password@relay.example.test",
    ]) {
      state.status = connected({ config: { ...base().config, relayUrl } });
      await show();
      expect(link("Manage your account")).toBeUndefined();
      expect(button("Unlink this gateway")).toBeDefined();
    }
  });
  test("older Google-only links keep their link, disconnect and cross-origin paths", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "https://gateway.example.test" },
    });
    state.status = connected({
      account: undefined,
      google: {
        configured: true,
        canLink: true,
        linkOrigin: "https://gateway.example.test",
        lastError: "google-link-failed",
      },
    });
    await show("relay");
    expect(host.querySelector(".relay-problems")!.textContent).toContain(
      "Couldn't connect with Google",
    );
    await show();
    expect(button("Connect with Google").querySelector("img")?.getAttribute("src")).toBe(
      "/portal/img/google-sign-in-mark.png",
    );
    await click("Connect with Google");
    expect(state.run).toHaveBeenLastCalledWith("google/link");
    state.status = connected({ account: undefined, google: { configured: true, canLink: true } });
    await show();
    expect(button("Connect with Google")).toBeDefined();
    state.status = connected({
      account: undefined,
      google: { configured: true, canLink: true, linkOrigin: "https://cloud.example.test" },
    });
    await show();
    expect(button("Connect with Google")).toBeUndefined();
    expect(link("Connect with Google on the gateway's address").getAttribute("href")).toBe(
      "https://cloud.example.test/portal/settings/account",
    );
    state.status = connected({
      account: undefined,
      google: { configured: true, linked: true, canLink: true, canUnlink: true },
    });
    await show();
    expect(text()).toContain("This gateway is linked with Google.");
    expect(link("Manage your account")).toBeDefined();
    await click("Unlink this gateway");
    await click("Unlink");
    expect(state.run).toHaveBeenLastCalledWith("google/unlink");
    expect(text()).not.toContain("What happens when a new device signs in");
    state.status = connected({ account: undefined, google: { configured: false } });
    await show();
    // No account of either kind: the page has no Account heading.
    expect(
      [...host.querySelectorAll(".relay-section-title")].map((x) => x.textContent),
    ).not.toContain("Account");
  });
});

describe("certificate incident hold", () => {
  const HELD = {
    since: "2028-01-02T00:00:00.000Z",
    certificates: ["e".repeat(64), "9".repeat(64)],
  };
  test("says new devices wait whatever was chosen, names the one command that lifts it, and locks the choice", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    state.status = connected({
      incidentHold: HELD,
      deviceEnrollment: { policy: "ask", trustedSignIns: [] },
      certificateMonitor: { state: "incident", incidents: [] },
    });
    await show("relay");
    const said = [...host.querySelectorAll('.relay-problems [role="alert"]')].map(
      (alert) => alert.textContent,
    );
    expect(said).toEqual([
      "A certificate for this gateway's address was issued with a key this gateway does not hold, so someone else may be able to pose as this gateway. Until you deal with it, every new device waits for your approval, whatever you chose for new devices. Don't sign in or approve anything from a link you didn't expect. Copy the details and ask for help. Once it is resolved, run omnesis cloud incidents ack on the gateway host.",
    ]);
    // The fingerprints stay in the details, out of the page.
    expect(text()).not.toContain("e".repeat(64));
    await click("Copy details");
    const copied = writeText.mock.calls[0]![0];
    expect(copied).toContain("Error codes: incident-hold (new devices)");
    expect(copied).toContain("Incident hold: since 2028-01-02T00:00:00.000Z, 2 certificates");
    // A hold without its list still prints.
    state.status = connected({ incidentHold: { since: HELD.since } });
    render(null, host);
    await show("relay");
    await click("Copy details");
    expect(writeText.mock.calls[1]![0]).toContain("Incident hold: since 2028-01-02T00:00:00.000Z, 0 certificates");
  });
  test("without a hold, the relay page has no problem and nothing is locked", async () => {
    state.status = connected();
    await show("relay");
    expect(host.querySelector(".relay-problems")).toBeNull();
    await click("Turn off");
    expect(state.run).toHaveBeenLastCalledWith("disable");
  });
});

describe("new devices", () => {
  test("the account page lists the trusted sign-ins, with nothing to remove, and leaves the new-device choice to Connectivity", async () => {
    state.status = connected();
    await show();
    expect(host.querySelectorAll(".relay-sign-in")).toHaveLength(2);
    expect(button("Remove")).toBeUndefined();
    expect(host.querySelector('button[aria-label^="Remove"]')).toBeNull();
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(text()).not.toContain("What happens when a new device signs in");
  });
  test("has no Trusted sign-ins section without an enrollment status or any sign-in", async () => {
    state.status = connected({ deviceEnrollment: undefined });
    await show();
    expect(text()).not.toContain("Trusted sign-ins");
    state.status = connected({ deviceEnrollment: { policy: "ask", trustedSignIns: [] } });
    await show();
    expect(text()).not.toContain("Trusted sign-ins");
  });
});

describe("trusted sign-ins and confirming a passkey", () => {
  const ORIGIN = "https://g-abcdefgh.relay.example.test";
  test("a sign-in shows its state first and when it was added, and a passkey setup waits for reads as a step to take, not a failure", async () => {
    const added = Date.UTC(2028, 0, 3, 12) / 1000;
    state.status = connected({
      deviceEnrollment: {
        policy: "automatic",
        confirmOrigin: ORIGIN,
        trustedSignIns: [
          { type: "google", id: "googlefictional2", addedAt: added, source: "link-page" },
          { type: "passkey", id: "passkeyfictional3a", addedAt: added, source: "endorsed" },
          { type: "passkey", id: "passkeyfictional3b", addedAt: added, source: "endorsed" },
        ],
        confirmedSignIns: [],
      },
    });
    await show();
    const rows = [...host.querySelectorAll(".relay-sign-in")].map((x) =>
      [...x.children].map((line) => (line.textContent ?? "").replace(/\s+/g, " ").trim()).join(" | "),
    );
    const day = new Date(added * 1000).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    expect(rows).toEqual([
      `Google account · added ${day} | Not confirmed on this gateway yet: devices that sign in with it wait for your OK · Used to connect this gateway`,
      `Passkey · added ${day} · ending al3a | Waiting for you to use it once on this gateway · Added to your account later, vouched for by a sign-in trusted here`,
      `Passkey · added ${day} · ending al3b | Waiting for you to use it once on this gateway · Added to your account later, vouched for by a sign-in trusted here`,
    ]);
  });

  test("each trusted sign-in says where it came from and whether it is confirmed here", async () => {
    state.status = connected({
      deviceEnrollment: {
        policy: "automatic",
        trustedSignIns: [
          { type: "passkey", id: "passkeyfictional1", addedAt: 1, source: "link-page", confirmed: true },
          { type: "google", id: "googlefictional2", addedAt: 2, source: "countersigned" },
          { type: "passkey", id: "passkeyfictional3", addedAt: 3, source: "unheard-of" },
        ],
        confirmedSignIns: [
          { type: "passkey", id: "passkeyfictional1", at: 4, via: "gateway-origin" },
          { type: "passkey", id: "passkeyfictional4", at: 5, via: "android-app" },
          { type: "passkey", id: "passkeyfictional5", at: 6, via: "later-way" },
        ],
      },
    });
    await show();
    // Each row is two lines: what the sign-in is, then where it came from.
    const rows = [...host.querySelectorAll(".relay-sign-in")].map((x) =>
      [...x.children].map((line) => (line.textContent ?? "").replace(/\s+/g, " ").trim()).join(" | "),
    );
    // No raw id is shown, only its end where nothing else tells two rows apart (these carry no
    // real add time); the whole id is kept for a hover.
    expect(rows).toEqual([
      "Passkey · ending nal1 | Confirmed on this gateway · Used to connect this gateway",
      "Google account | Not confirmed on this gateway yet: devices that sign in with it wait for your OK · Already on your account, vouched for by one of your passkeys",
      "Passkey · ending nal3 | Not confirmed on this gateway yet: devices that sign in with it wait for your OK · Source not recorded",
      "Passkey · ending nal4 | Confirmed in the Android app",
      "Passkey · ending nal5 | Confirmed",
    ]);
    expect(host.querySelector(".relay-sign-in .relay-row-value")?.getAttribute("title")).toBe(
      "Passkey passkeyfictional1",
    );
    // A passkey is confirmed already, so there is nothing to confirm.
    expect(text()).not.toContain("Confirm your passkey on this gateway");
    state.status = connected({ deviceEnrollment: { policy: "ask", trustedSignIns: [] } });
    await show();
    expect(host.querySelector(".relay-sign-ins")).toBeNull();
    // An older gateway may report neither list.
    state.status = connected({ deviceEnrollment: { policy: "ask" } });
    await show();
    expect(host.querySelector(".relay-sign-ins")).toBeNull();
  });

  /** A gateway just linked: nothing confirmed yet. */
  const fresh = (signIns: Record<string, unknown>[], over: Record<string, unknown> = {}) =>
    connected({
      deviceEnrollment: {
        policy: "automatic",
        confirmationNeeded: true,
        trustedSignIns: signIns,
        confirmedSignIns: [],
        confirmOrigin: ORIGIN,
      },
      ...over,
    });
  const PASSKEY = { type: "passkey", id: "p", addedAt: 1, source: "link-page" };
  const GOOGLE = { type: "google", id: "g".repeat(64), addedAt: 1, source: "link-page" };
  async function showWith(props: Record<string, unknown>) {
    await act(async () => render(h(RelayView, props), host));
  }
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });

  test("right after linking an account with a passkey, setup ends with one passkey use on the gateway's address", async () => {
    state.status = fresh([PASSKEY]);
    const open = vi.fn().mockResolvedValue(undefined);
    const location = { origin: "https://192.0.2.1:7600" };
    await showWith({ open, location });
    // The checklist stands in for the usual headline.
    expect(host.querySelector(".relay-hero")).toBeNull();
    expect(host.querySelector("#relay-setup-title")?.textContent).toBe("Finish setting up");
    expect(text()).toContain("Omnesis account");
    expect(text()).toContain("g-abcdefgh.relay.example.test");
    expect(text()).toContain("Let your passkey add devices");
    // Never "open this address": one button goes there, signed in, and starts the prompt.
    expect(link("g-abcdefgh.relay.example.test")).toBeUndefined();
    await click("Continue with passkey");
    expect(open).toHaveBeenCalledExactlyOnceWith(ORIGIN, { next: "confirm-passkey", location });
  });

  test("an account with Google only is offered a passkey to add, and asked for none it doesn't have", async () => {
    state.status = fresh([GOOGLE]);
    await show();
    expect(text()).not.toMatch(/passkey on this gateway/i);
    expect(button("Continue with passkey")).toBeUndefined();
    expect(text()).toContain(SETUP_COPY.addStep);
    expect(text()).not.toMatch(/phone|Get the app/i);
    expect(link(SETUP_COPY.addButton)?.getAttribute("href")).toBe(
      "https://relay.example.test/_relay/account?add=passkey",
    );
    // A gateway with no address of its own (a custom domain) can use no passkey: no checklist.
    state.status = fresh([PASSKEY]);
    delete state.status.deviceEnrollment.confirmOrigin;
    await show();
    expect(host.querySelector("#relay-setup-title")).toBeNull();
    // Under "ask me first" every device waits by choice: nothing is left to set up.
    state.status = fresh([GOOGLE]);
    state.status.deviceEnrollment.policy = "ask";
    await show();
    expect(host.querySelector("#relay-setup-title")).toBeNull();
    // Once anything is confirmed, the ordinary headline is back.
    state.status = fresh([PASSKEY]);
    state.status.deviceEnrollment.confirmedSignIns = [
      { type: "google", id: "g", at: 1, via: "native-google-approval" },
    ];
    await show();
    expect(host.querySelector("#relay-setup-title")).toBeNull();
    expect(text()).toContain("This gateway is linked to your Omnesis account.");
  });

  test("Not now with no sign-in on record yet leaves the reminder alone under Trusted sign-ins", async () => {
    // A Google account linked under automatic joins, before the gateway lists any sign-in.
    state.status = connected({ deviceEnrollment: { policy: "automatic", confirmOrigin: ORIGIN } });
    await show();
    await click("Not now");
    expect(host.querySelector("#relay-sign-ins-title")?.textContent).toBe("Trusted sign-ins");
    expect(text()).toContain("New devices wait for your OK until you finish setup.");
    expect(host.querySelector(".relay-sign-ins")).toBeNull();
  });

  test("Not now leaves one amber line under Trusted sign-ins, remembered here, and Finish setup brings it back", async () => {
    state.status = fresh([GOOGLE]);
    await show();
    await click("Not now");
    expect(host.querySelector("#relay-setup-title")).toBeNull();
    expect(text()).toContain("This gateway is linked to your Omnesis account.");
    expect(text()).toContain("New devices wait for your OK until you finish setup.");
    expect(storage.get("omnesis.relay.setup-later")).toBe(state.status.gatewayId);
    // Remembered for this gateway on the next visit.
    render(null, host);
    await show();
    expect(host.querySelector("#relay-setup-title")).toBeNull();
    await click("Finish setup");
    expect(host.querySelector("#relay-setup-title")?.textContent).toBe("Finish setting up");
    expect(storage.has("omnesis.relay.setup-later")).toBe(false);
    // Without storage, "Not now" still works for this visit.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    render(null, host);
    await show();
    await click("Not now");
    expect(text()).toContain("New devices wait for your OK until you finish setup.");
    // During a security lock there's nothing to set up or remind about.
    state.status = fresh([GOOGLE], { incidentHold: { since: "2028-01-02T00:00:00Z", certificates: ["e"] } });
    render(null, host);
    await show();
    expect(host.querySelector("#relay-setup-title")).toBeNull();
    expect(text()).not.toContain("until you finish setup");
  });

  test("while the certificate is on its way, step 2 waits and the button can't open the address yet", async () => {
    state.status = fresh([PASSKEY], {
      certificate: { state: "pending" },
    });
    const open = vi.fn().mockResolvedValue(undefined);
    await showWith({ open, location: { origin: "https://192.0.2.1:7600" } });
    expect(text()).toContain("Getting a secure address… usually under a minute");
    expect(button("Continue with passkey").disabled).toBe(true);
  });

  test("connecting from a home address ends on the gateway's own address once it's ready", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const location = { origin: "https://192.0.2.1:7600" };
    state.status = { ...connected(), connect: { state: "linking" } };
    await showWith({ open, location });
    // Ready, linked with a passkey and nothing confirmed: open it there, prompt included.
    state.status = fresh([PASSKEY]);
    await showWith({ open, location });
    expect(open).toHaveBeenCalledExactlyOnceWith(ORIGIN, { next: "confirm-passkey", location });
    // Only once, and never for a page already there, a Google-only account or a later visit.
    await showWith({ open, location });
    expect(open).toHaveBeenCalledOnce();
    for (const [status, where] of [
      [fresh([PASSKEY]), { origin: ORIGIN }],
      [fresh([GOOGLE]), location],
    ] as const) {
      render(null, host);
      state.status = { ...connected(), connect: { state: "registering" } };
      await showWith({ open, location: where });
      state.status = status;
      await showWith({ open, location: where });
    }
    // A connection that dropped on the way doesn't count as having just connected.
    render(null, host);
    state.status = { ...connected(), connect: { state: "linking" } };
    await showWith({ open, location });
    state.status = { ...fresh([PASSKEY]), tunnel: { state: "offline" } };
    await showWith({ open, location });
    state.status = fresh([PASSKEY]);
    await showWith({ open, location });
    expect(open).toHaveBeenCalledOnce();
    // A failed handoff is quiet: the checklist's own button is still there.
    render(null, host);
    const failing = vi.fn().mockRejectedValue(new Error("no"));
    state.status = { ...connected(), connect: { state: "waiting", authorizeUrl: "x" } };
    await showWith({ open: failing, location });
    state.status = fresh([PASSKEY]);
    await showWith({ open: failing, location });
    expect(failing).toHaveBeenCalledOnce();
    expect(button("Continue with passkey")).toBeDefined();
  });
});

test("the page asks the gateway to read the account, and reads its status again once it has", async () => {
  accountRefresh.mockClear();
  state.status = connected();
  await show();
  expect(accountRefresh).toHaveBeenCalled();
  const refreshed = accountRefresh.mock.calls.at(-1)![0] as () => void;
  state.run.mockClear();
  refreshed();
  // A plain status read: no operation, so nothing changes on the gateway.
  expect(state.run).toHaveBeenCalledExactlyOnceWith();
});

test("a new gateway's browser check precedes account sign-in and never asks for operator approval", async () => {
  const url = "https://dns.example.test/_dns/v2/enroll?ticket=fictional";
  state.status = { ...base(), connect: { state: "waiting", verification: { url, expiresAt: Date.now() + 60_000 } } };
  await show();
  expect(headline()).toBe("Verify this gateway's setup");
  expect(link("Open security check").getAttribute("href")).toBe(url);
  expect(link("Open security check").getAttribute("target")).toBe("_blank");
  expect(text()).toContain("Cloudflare usually checks automatically");
  expect(text()).toContain("No approval from Omnesis is needed");
  expect(text()).not.toContain("Open sign-in");
  await click("Cancel");
  expect(state.run).toHaveBeenLastCalledWith("connect/cancel", {});
});

/**
 * A window as the browser opens it for the portal, on the portal's own page. Sent to another
 * origin's page it can no longer be read; `back()` returns it to the portal's page.
 */
function connectWindow() {
  const state = { foreign: false, sent: [] as string[] };
  const guard = () => {
    if (state.foreign) throw new Error("Blocked a frame from accessing a cross-origin frame.");
  };
  return {
    closed: false,
    opener: {} as unknown,
    location: {
      get pathname() {
        guard();
        return "/portal/connect-window.html";
      },
      set href(url: string) {
        state.sent.push(url);
        state.foreign = true;
      },
    },
    document: {
      get readyState() {
        guard();
        return "complete";
      },
    },
    close: vi.fn(),
    focus: vi.fn(),
    sent: state.sent,
    back: () => {
      state.foreign = false;
    },
  };
}
/** Clicks a link as a person does, and says whether the portal kept the browser from following it. */
async function press(anchor: HTMLAnchorElement, modifiers: Record<string, boolean> = {}) {
  const event = new (window as any).Event("click", { bubbles: true, cancelable: true });
  Object.assign(event, { button: 0, ...modifiers });
  await act(async () => {
    anchor.dispatchEvent(event);
  });
  return event.defaultPrevented as boolean;
}

test("the security check and then the sign-in run in one window the portal opens, cut off from the portal", async () => {
  vi.useFakeTimers();
  try {
    const url = "https://dns.example.test/_dns/v2/enroll?ticket=fictional";
    const opened = connectWindow();
    (window as any).open = vi.fn(() => opened);
    state.status = { ...base(), connect: { state: "waiting", intent: "create", verification: { url, expiresAt: Date.now() + 60_000 } } };
    await show();
    // A click with a modifier is the browser's: a new tab or window as the person asked.
    expect(await press(link("Open security check"), { metaKey: true })).toBe(false);
    expect((window as any).open).not.toHaveBeenCalled();
    expect(await press(link("Open security check"))).toBe(true);
    expect((window as any).open).toHaveBeenCalledExactlyOnceWith("/portal/connect-window.html", "omnesis-connect");
    // The check's page can't reach back into the portal, and knows to come back when it passes.
    expect(opened.opener).toBeNull();
    expect(opened.sent).toEqual([`${url}#opened-by-portal`]);
    // Once the check has passed and the window is back on the portal's page, it goes on to
    // creating the account.
    state.status = { ...base(), connect: { state: "waiting", intent: "create", authorizeUrl: AUTHORIZE } };
    await show();
    expect(opened.sent).toHaveLength(1);
    opened.back();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(opened.sent).toEqual([`${url}#opened-by-portal`, AUTHORIZE_IN_WINDOW]);
    // Signed in, the account's own page is the one to close it.
    state.status = { ...base(), connect: { state: "registering", intent: "create" } };
    await show();
    expect(opened.close).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("a browser that refuses the window opens the security check as an ordinary new tab", async () => {
  const url = "https://dns.example.test/_dns/v2/enroll?ticket=fictional";
  state.status = { ...base(), connect: { state: "waiting", verification: { url, expiresAt: Date.now() + 60_000 } } };
  await show();
  for (const refused of [null, { ...connectWindow(), closed: true }]) {
    (window as any).open = vi.fn(() => refused);
    // Not prevented: the link opens the check's own page, which says how to come back.
    expect(await press(link("Open security check"))).toBe(false);
  }
  // With no window of the portal's, the sign-in is a link to press once the check has passed.
  state.status = { ...base(), connect: { state: "waiting", intent: "create", authorizeUrl: AUTHORIZE } };
  await show();
  expect(link("Create your Omnesis account").getAttribute("href")).toBe(AUTHORIZE);
  const opened = connectWindow();
  (window as any).open = vi.fn(() => opened);
  expect(await press(link("Create your Omnesis account"))).toBe(true);
  expect(opened.sent).toEqual([AUTHORIZE_IN_WINDOW]);
});

test("an invalid security check URL remains visible as a recoverable setup error without a link", async () => {
  state.status = { ...base(), connect: { state: "waiting", verification: { url: "javascript:alert(1)", expiresAt: Date.now() + 60_000 } } };
  await show();
  expect(text()).toContain("security check link is unavailable");
  expect([...host.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("javascript:"))).toBe(false);
  expect(button("Cancel")).toBeTruthy();
});


test("cancelling a browser check disables duplicate cancellation and tolerates a missing expiry", async () => {
  state.busy = "connect/cancel";
  state.status = { ...base(), connect: { state: "waiting", verification: {
    url: "https://dns.example.test/_dns/v2/enroll?ticket=fictional",
  } } };
  await show();
  expect(button("Cancelling…").disabled).toBe(true);
  expect(text()).not.toContain("Complete by");
  expect(link("Open security check")).toBeTruthy();
});

test("a connection that never finished leads the account page, with both ways on and the details", async () => {
  state.status = {
    ...base(),
    configured: true,
    gatewayId: "gw-fictional",
    unfinished: { error: "expired" },
    connect: { state: "failed", error: "expired" },
    can: { ...base().can, startOver: true },
  };
  await show();
  expect(headline()).toBe("Connecting didn't finish");
  expect(button("Start over")).toBeTruthy();
  expect(button("Try again")).toBeTruthy();
  // No address is offered for a gateway that never connected.
  expect(text()).not.toContain("/mcp");
  await click("Start over");
  expect(state.run).toHaveBeenLastCalledWith("start-over", {});
});

test("a chosen new account that already existed is said once connected, with the invite unused, and only once", async () => {
  vi.useFakeTimers();
  try {
    state.status = connected({ connect: { state: "done", existingAccount: true } });
    await show();
    const notice =
      "You already had an Omnesis account, so this gateway is now linked to it. Your invite wasn't used.";
    expect(text()).toContain(notice);
    // A glance is not enough: the page in view for a few seconds is.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(acknowledge).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => {
      document.dispatchEvent(new (window as any).Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(acknowledge).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new (window as any).Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(acknowledge).toHaveBeenCalledOnce();
    // Acknowledged, the gateway stops saying it; this page keeps it while it shows the link.
    state.status = connected({ connect: { state: "done" } });
    await show();
    expect(text()).toContain(notice);
    // A later visit or a reload doesn't say it again.
    render(null, host);
    await show();
    expect(text()).not.toContain("Your invite wasn't used");
    // Nor once the page no longer shows a finished connection.
    state.status = connected({ connect: { state: "done", existingAccount: true } });
    await show();
    state.status = connected();
    await show();
    expect(text()).not.toContain("Your invite wasn't used");
  } finally {
    vi.useRealTimers();
  }
});

test("waiting after choosing to create an account names the button for it", async () => {
  state.status = {
    ...base(),
    connect: {
      state: "waiting",
      intent: "create",
      authorizeUrl: AUTHORIZE,
      connectUrl: "https://relay.example.test/_relay/connect",
      code: "H7KM-3QPX",
    },
  };
  await show();
  expect(headline()).toBe("Create your Omnesis account");
  expect(link("Create your Omnesis account").getAttribute("href")).toBe(AUTHORIZE);
  expect(link("Sign in to your Omnesis account")).toBeUndefined();
});

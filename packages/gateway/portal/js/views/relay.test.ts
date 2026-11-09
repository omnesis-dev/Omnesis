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
vi.mock("../lib/use-relay-management.js", () => ({ useRelayManagement: () => state }));
// @ts-expect-error portal JS
import { RelayView, relayPhase } from "./relay.js";

let host: HTMLElement;
const HOST = "northstar.relay.example.test";
const AUTHORIZE = "https://relay.example.test/_relay/v3/signup/begin?ticket=fictional";
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
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});
async function show() {
  await act(async () => render(h(RelayView, {}), host));
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

test("not connected: one headline, creating an account or signing in to one, and nothing else to fill in", async () => {
  await show();
  expect(headline()).toBe("Enroll this gateway in your Omnesis Account");
  expect(host.querySelector(".relay-dot")).toBeNull();
  expect(host.querySelector(".relay-lede")?.textContent).toBe(
    "An Omnesis account lets you reach your gateway from your phone and laptop outside your home network and pair new devices by signing in. Traffic is encrypted end to end, and the keys never leave this gateway. Connecting gives this gateway a public address and a certificate.",
  );
  // The two buttons are the whole page: no terms line, no preview note, no manual form.
  expect(text()).not.toContain("terms of service");
  expect(text()).not.toContain("in preview");
  expect(host.querySelector("details, form, input")).toBeNull();
  expect(host.querySelector(".relay-hero")!.nextElementSibling).toBeNull();
  // Creating an account is the primary action; signing in to one is the quiet one beside it.
  expect([...host.querySelectorAll(".btn-primary")].map((x) => x.textContent?.trim())).toEqual([
    "Create an Omnesis account",
  ]);
  expect(button("I already have one").className).toBe("relay-quiet");
  expect(button("Connect")).toBeUndefined();
  await click("Create an Omnesis account");
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
  expect(button("Create an Omnesis account")).toBeUndefined();
  // A refresh in the background leaves both choices usable.
  state.busy = "refresh";
  await show();
  expect(button("Create an Omnesis account").disabled).toBe(false);
  expect(button("I already have one").disabled).toBe(false);
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
  const open = link("Open sign-in");
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
  expect(link("Open sign-in")).toBeUndefined();
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
    expect(host.querySelector(".relay-dot-progress")).not.toBeNull();
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

test("unavailable installations explain the situation, offer nothing to press and never show service URLs", async () => {
  state.status = {
    ...base(),
    serviceConfigured: false,
    config: { ...base().config, relayUrl: "https://private-operator.example.test" },
  };
  await show();
  expect(headline()).toBe("Remote access isn't available");
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(text()).not.toContain("private-operator.example.test");
  state.status.serviceError = "relay-service-mismatch";
  await show();
  expect(text()).toContain("installation service configuration does not match");
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
});

test("connected: three plain sections, a copyable address and nothing technical", async () => {
  state.status = connected();
  await show();
  expect(headline()).toBe(`Connected as ${HOST}`);
  expect(host.querySelector(".relay-dot-ok")).not.toBeNull();
  expect(host.querySelector(".btn-primary")).toBeNull();
  const titles = [...host.querySelectorAll(".relay-section-title")];
  expect(titles.map((x) => x.textContent)).toEqual(["Account", "Remote access", "New devices"]);
  expect(new Set(titles.map((x) => x.tagName))).toEqual(new Set(["H3"]));
  expect([...host.querySelectorAll(".relay-row-label")].map((x) => x.textContent)).toEqual([
    "This gateway",
    "Address",
    "Status",
  ]);
  expect(text()).toContain(`https://${HOST}/mcp`);
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
    "Trusted sign-ins",
    "Sign-in methods",
    "ertificate",
    "Gateway ID",
    "Recovery receipt",
    "Reconnect",
    "Google account",
    "Passkey",
    "google:fictional-subject",
  ])
    expect(text()).not.toContain(gone);
  expect(
    [...host.querySelectorAll("button")].map((x) => x.textContent?.trim()).filter(Boolean),
  ).toEqual(["Unlink this gateway", "Turn off"]);
  state.status = connected({ hostname: undefined, can: { disable: false } });
  await show();
  expect(headline()).toBe("Connected as your gateway");
  expect(button("Turn off").disabled).toBe(true);
});

test("turning remote access off and on says what it does, to a pointer, a keyboard and a screen reader", async () => {
  state.status = connected();
  await show();
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
  await show();
  expect(button("Turning off…").disabled).toBe(true);
  state.busy = "";
  state.status = connected({ enabled: false, tunnel: { state: "disabled" }, can: { enable: true } });
  await show();
  const on = button("Turn on");
  const onTip =
    "Makes this gateway reachable from outside your home network again, at the same address.";
  expect(on.getAttribute("title")).toBe(onTip);
  expect(host.querySelector(`#${on.getAttribute("aria-describedby")}`)!.textContent).toBe(onTip);
});

test("the address says whether it can be used, and calls it unreachable only once the gateway does", async () => {
  const url = `https://${HOST}/mcp`;
  state.status = connected({ publicMcp: { ready: false, url } });
  await show();
  expect(text()).toContain(
    "Checking that this address answers. This takes up to a minute after the gateway connects.",
  );
  // Still checking is not a problem.
  expect(host.querySelector(".relay-problems")).toBeNull();
  expect(text()).not.toContain("does not answer");
  state.status = connected({
    publicMcp: { ready: false, url, lastError: "public-endpoint-unreachable" },
  });
  await show();
  expect(text()).not.toContain("Checking that this address answers");
  expect(text()).toContain("This address does not answer right now.");
  expect(host.querySelector(".relay-problems")!.textContent).toContain(
    "This gateway's address does not answer from outside your home network.",
  );
  state.status = connected({ tunnel: { state: "offline" }, publicMcp: { ready: false, url } });
  await show();
  expect(text()).toContain("Not reachable while this gateway is disconnected from the relay.");
  state.status = connected({
    enabled: false,
    tunnel: { state: "disabled" },
    publicMcp: { ready: false, url },
  });
  await show();
  expect(text()).toContain("Not reachable while remote access is off.");
  state.status = connected({ publicMcp: { ready: false } });
  await show();
  expect([...host.querySelectorAll(".relay-row-label")].map((x) => x.textContent)).toEqual([
    "This gateway",
    "Status",
  ]);
});

test("reconnecting, disconnected and off each lead with their own state and action", async () => {
  state.status = connected({ tunnel: { state: "connecting" } });
  await show();
  expect(headline()).toBe("Reconnecting…");
  expect(host.querySelector(".relay-dot-warning")).not.toBeNull();
  await click("Turn off");
  expect(state.run).toHaveBeenLastCalledWith("disable");
  state.status = connected({ tunnel: { state: "offline", lastError: "tunnel-disconnected" } });
  await show();
  expect(headline()).toBe("Disconnected");
  expect(text()).toContain("Remote access was interrupted");
  // Said once, in the headline; the box offers the details.
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
  expect(button("Copy details")).toBeDefined();
  await click("Reconnect");
  expect(state.run).toHaveBeenLastCalledWith("reconnect");
  state.status = connected({ tunnel: { state: "offline" }, can: { reconnect: false } });
  await show();
  expect(text()).toContain("Remote access dropped");
  expect(button("Reconnect").disabled).toBe(true);
  state.busy = "reconnect";
  state.status = connected({ tunnel: { state: "offline" } });
  await show();
  expect(button("Reconnecting…").disabled).toBe(true);
  state.busy = "";
  state.status = connected({
    enabled: false,
    tunnel: { state: "disabled" },
    can: { enable: true },
  });
  await show();
  expect(headline()).toBe("Remote access is off");
  // Still in the account: it can be turned on, managed or disconnected from here.
  expect(
    [...host.querySelectorAll("button")].map((x) => x.textContent?.trim()).filter(Boolean),
  ).toEqual(["Turn on", "Unlink this gateway"]);
  expect(link("Manage your account")).toBeDefined();
  expect(host.querySelector(
      '[aria-labelledby="relay-remote-access-title"] .relay-row:last-child .relay-row-value',
    )?.textContent).toBe("Off");
  expect(host.querySelector(".relay-problems")).toBeNull();
  await click("Turn on");
  expect(state.run).toHaveBeenLastCalledWith("enable", {});
  state.busy = "enable";
  await show();
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
    await show();
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
    await show();
    expect(text()).toContain("expires on a date soon");
    expect(host.querySelector(".relay-problems h3")?.textContent?.trim()).toBe(
      "Something needs your attention",
    );
    state.status = connected({ certificate: { state: "expired" } });
    await show();
    expect(text()).toContain("has expired, so devices away from home cannot connect");
    // With remote access off, what its certificate, tunnel and address last said is nobody's problem.
    state.status = connected({
      enabled: false,
      tunnel: { state: "disabled", lastError: "tunnel-disconnected" },
      certificate: { state: "expired", lastError: "certificate-renewal-failed" },
      publicMcp: { ready: false, lastError: "public-endpoint-unreachable" },
    });
    await show();
    expect(host.querySelector(".relay-problems")).toBeNull();
  });

  test("Copy details puts the old record on the clipboard as plain text, with no sign-in identifiers", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    state.version = "9.8.7";
    state.status = troubled();
    await show();
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
      "New devices: automatic, 2 trusted sign-ins",
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
  expect(headline()).toBe("Enroll this gateway in your Omnesis Account");
  expect(host.querySelector('[role="status"].relay-notice')?.textContent).toContain(
    "Your Omnesis account was deleted, so this gateway is no longer linked to it",
  );
  expect(button("Create an Omnesis account")).toBeDefined();
  expect(host.querySelector(".relay-problems")).toBeNull();
  state.status = base();
  await show();
  expect(host.querySelector(".relay-notice")).toBeNull();
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
    await show();
    expect(host.querySelector(".relay-problems")!.textContent).toContain(
      "Couldn't connect with Google",
    );
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
    expect(host.querySelectorAll(".relay-row-label")[0]?.textContent).toBe("Address");
    // No account of either kind: the page has no Account heading.
    expect(
      [...host.querySelectorAll(".relay-section-title")].map((x) => x.textContent),
    ).not.toContain("Account");
  });
});

describe("new devices", () => {
  test("the policy choice saves immediately, and trusted sign-ins are not listed", async () => {
    state.status = connected();
    await show();
    expect(text()).toContain("What happens when a new device signs in");
    expect(text()).toContain(
      "A device joins once you sign in to your Omnesis account with a sign-in this gateway trusts. You're notified and can remove it any time.",
    );
    expect(text()).toContain(
      "A device waits until you approve it on a device you already use, and the codes match. Someone with your Google password still can't get in.",
    );
    const radios = [...host.querySelectorAll('input[name="relay-policy"]')] as HTMLInputElement[];
    expect(radios.map(checked)).toEqual([true, false]);
    await act(async () => {
      radios[0]!.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(state.run).not.toHaveBeenCalled();
    await act(async () => {
      radios[1]!.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(state.run).toHaveBeenLastCalledWith("enrollment", { policy: "ask" }, "PUT");
    expect(host.querySelector("ul, li")).toBeNull();
    expect(button("Remove")).toBeUndefined();
    expect(host.querySelector('button[aria-label^="Remove"]')).toBeNull();
  });
  test("is absent without an enrollment status or before the gateway is connected", async () => {
    state.status = connected({ deviceEnrollment: undefined });
    await show();
    expect(text()).not.toContain("What happens when a new device signs in");
    state.status = { ...connected(), enabled: false, enrollment: { state: "unconfigured" } };
    await show();
    expect(text()).not.toContain("What happens when a new device signs in");
  });
  test("right after linking, the settings show at once with Join automatically selected, and Ask me first is one click", async () => {
    // Exactly what a freshly linked gateway reports: no stored choice, so the policy is automatic.
    state.status = connected({ deviceEnrollment: { policy: "automatic", trustedSignIns: [] } });
    await show();
    expect(host.querySelector(".relay-rows")).not.toBeNull();
    expect(host.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);
    expect(button("Continue")).toBeUndefined();
    const radios = [...host.querySelectorAll('input[name="relay-policy"]')] as HTMLInputElement[];
    expect(radios.map(checked)).toEqual([true, false]);
    await act(async () => {
      radios[1]!.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(state.run).toHaveBeenLastCalledWith("enrollment", { policy: "ask" }, "PUT");
    state.status = connected({ deviceEnrollment: { policy: "ask", trustedSignIns: [] } });
    state.busy = "enrollment";
    await show();
    const saving = [...host.querySelectorAll('input[name="relay-policy"]')] as HTMLInputElement[];
    expect(saving.map(checked)).toEqual([false, true]);
    expect(saving.every((radio) => radio.disabled)).toBe(true);
  });
});

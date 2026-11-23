// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const qr = vi.hoisted(() => ({ toCanvas: vi.fn() }));
vi.mock("qrcode", () => ({ default: qr }));
const api = vi.hoisted(() => ({
  getTailscale: vi.fn(),
  setTailscaleEnabled: vi.fn(),
  tailscaleSignIn: vi.fn(),
  tailscaleSignOut: vi.fn(),
  updateTailscaleSettings: vi.fn(),
  decideTailscaleJoin: vi.fn(),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../lib/router.js", () => router);
vi.mock("../lib/tailscale-api.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));

// @ts-expect-error — portal modules are plain JS.
import { TailscaleView, tailscalePhase, viewedThroughDevice } from "./tailscale.js";

type State = Record<string, any>;

function off(over: State = {}): State {
  return {
    enabled: false,
    deviceName: "omnesis",
    joinPolicy: "ask",
    helper: { state: "off" },
    connection: "off",
    signInUrl: null,
    url: null,
    node: null,
    owner: null,
    certificate: null,
    public: { wanted: false, state: "off" },
    joinRequests: [],
    ...over,
  };
}
function connected(over: State = {}): State {
  return off({
    enabled: true,
    helper: { state: "running" },
    connection: "connected",
    url: "https://omnesis.example-net.ts.net",
    node: { dnsName: "omnesis.example-net.ts.net", tailnet: "example-net.ts.net", ips: [] },
    owner: { login: "maya@example.com", displayName: "Maya" },
    certificate: { source: "tailscale" },
    ...over,
  });
}
const request = {
  id: "req-1",
  name: "studio-laptop",
  kind: "collector",
  machine: "studio-laptop",
  os: "macOS",
  login: "maya@example.com",
  requestedAt: new Date(Date.now() - 120_000).toISOString(),
  expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
};

let host: HTMLElement;
let doc: Document;
beforeEach(() => {
  vi.clearAllMocks();
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  doc = dom.document as unknown as Document;
  host = dom.document.querySelector("main") as unknown as HTMLElement;
  qr.toCanvas.mockResolvedValue(undefined);
});
afterEach(() => {
  render(null, host);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function show(state: State) {
  api.getTailscale.mockResolvedValue(state);
  await act(async () => render(h(TailscaleView, {}), host));
  await act(async () => {});
}
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const link = (label: string) =>
  [...host.querySelectorAll("a")].find((a) => a.textContent?.trim() === label) as HTMLAnchorElement;
const pill = () => host.querySelector(".tailscale-pill")?.textContent?.trim();
async function click(label: string) {
  const target = button(label);
  expect(target, `button "${label}"`).toBeTruthy();
  await act(async () => target.click());
  await act(async () => {});
}

describe("tailscalePhase", () => {
  test("maps every report to one state", () => {
    expect(tailscalePhase(null)).toBe("loading");
    expect(tailscalePhase(off())).toBe("off");
    expect(tailscalePhase(off({ enabled: true, helper: { state: "unavailable", reason: "x" } }))).toBe(
      "unavailable",
    );
    expect(tailscalePhase(off({ enabled: true, helper: { state: "restarting" }, connection: "connected" }))).toBe(
      "restarting",
    );
    expect(tailscalePhase(off({ enabled: true, helper: { state: "starting" }, connection: "starting" }))).toBe(
      "starting",
    );
    for (const connection of ["needs-sign-in", "needs-approval", "connected", "stopped"])
      expect(tailscalePhase(off({ enabled: true, helper: { state: "running" }, connection }))).toBe(connection);
  });
});

describe("TailscaleView", () => {
  test("off: explains and turns on", async () => {
    await show(off());
    expect(pill()).toBe("Off");
    expect(text()).toContain("nothing is installed on this computer");
    expect(host.querySelector("#tailscale-public-title")).toBeNull();
    expect(host.querySelector('input[name="tailscale-join-policy"]')).toBeNull();
    api.setTailscaleEnabled.mockResolvedValue(off({ enabled: true, helper: { state: "starting" }, connection: "starting" }));
    await click("Turn on");
    expect(api.setTailscaleEnabled).toHaveBeenCalledWith(true, expect.anything());
    expect(pill()).toBe("Starting");
    expect(text()).toContain("Connecting this gateway to Tailscale");
  });

  test("helper unavailable: shows the reason calmly and keeps Turn off, confirmed first", async () => {
    const reason = "the helper program is not installed with this gateway.";
    await show(off({ enabled: true, helper: { state: "unavailable", reason }, connection: "starting" }));
    expect(pill()).toBe("Problem");
    expect(host.querySelector(".tailscale-notice")?.textContent).toContain(reason);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    api.setTailscaleEnabled.mockResolvedValue(off());
    await click("Turn off");
    expect(api.setTailscaleEnabled).not.toHaveBeenCalled();
    await act(async () => (host.querySelector(".confirm-modal .btn-primary") as HTMLButtonElement).click());
    await act(async () => {});
    expect(api.setTailscaleEnabled).toHaveBeenCalledWith(false, expect.anything());
    expect(pill()).toBe("Off");
  });

  test("needs sign-in: link, QR code of the same link, and a fresh link on request", async () => {
    const signInUrl = "https://login.tailscale.com/a/fictional0";
    await show(off({ enabled: true, helper: { state: "running" }, connection: "needs-sign-in", signInUrl }));
    expect(pill()).toBe("Sign in needed");
    expect(text()).toContain("Sign in to Tailscale to add this gateway to your network.");
    const open = link("Open sign-in page");
    expect(open.getAttribute("href")).toBe(signInUrl);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(qr.toCanvas).toHaveBeenCalledWith(expect.anything(), signInUrl, expect.any(Object));
    api.tailscaleSignIn.mockResolvedValue(
      off({ enabled: true, helper: { state: "running" }, connection: "needs-sign-in", signInUrl: `${signInUrl}x` }),
    );
    await click("Get a new link");
    expect(api.tailscaleSignIn).toHaveBeenCalledOnce();
    expect(link("Open sign-in page").getAttribute("href")).toBe(`${signInUrl}x`);
  });

  test("needs sign-in without a link yet says it is coming", async () => {
    await show(off({ enabled: true, helper: { state: "running" }, connection: "needs-sign-in", signInUrl: null }));
    expect(text()).toContain("Getting a sign-in link…");
    expect(link("Open sign-in page")).toBeUndefined();
    expect(qr.toCanvas).not.toHaveBeenCalled();
  });

  test("needs approval: names the device and links the admin console", async () => {
    await show(off({ enabled: true, deviceName: "omnesis-home", helper: { state: "running" }, connection: "needs-approval" }));
    expect(pill()).toBe("Waiting for approval");
    expect(text()).toContain('Approve "omnesis-home" in the Tailscale admin console.');
    expect(link("Open the admin console").getAttribute("href")).toBe("https://login.tailscale.com/admin/machines");
  });

  test("connected with a trusted certificate: address to copy, account, certificate", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await show(connected());
    expect(pill()).toBe("Connected");
    const address = host.querySelector("#tailscale-address") as HTMLInputElement;
    expect(address.value ?? address.getAttribute("value")).toBe("https://omnesis.example-net.ts.net");
    expect(host.querySelector(".tailscale-value")?.textContent).toContain("Maya");
    expect(text()).toContain("maya@example.com");
    expect(text()).toContain("Trusted certificate — browsers and apps connect without warnings.");
    await click("Copy");
    expect(writeText).toHaveBeenCalledWith("https://omnesis.example-net.ts.net");
    expect(button("Copied")).toBeTruthy();
  });

  test("connected: links to the portal at the tailnet address and says sign-in still applies", async () => {
    await show(connected({ url: "https://omnesis.example-net.ts.net/" }));
    const portal = link("Open the portal at this address");
    expect(portal.getAttribute("href")).toBe("https://omnesis.example-net.ts.net/portal/");
    expect(portal.getAttribute("target")).toBe("_blank");
    expect(text()).toContain("You sign in there as you do here");
  });

  test("a refused clipboard selects the address for a manual copy", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    await show(connected());
    const address = host.querySelector("#tailscale-address") as HTMLInputElement;
    const select = vi.fn();
    address.select = select;
    await click("Copy");
    expect(select).toHaveBeenCalled();
    expect(text()).toContain("Ctrl+C (⌘C on a Mac) to copy");
  });

  test("certificate states without a trusted certificate", async () => {
    await show(connected({ certificate: { source: "gateway", reason: "https-disabled" } }));
    expect(text()).toContain("HTTPS certificates are turned off in your Tailscale network");
    expect(link("Turn on HTTPS certificates").getAttribute("href")).toBe("https://login.tailscale.com/admin/dns");
    render(null, host);
    await show(connected({ certificate: { source: "gateway", reason: "magicdns-disabled" } }));
    expect(text()).toContain("MagicDNS");
    expect(link("Turn on HTTPS certificates").getAttribute("href")).toBe("https://login.tailscale.com/admin/dns");
    render(null, host);
    await show(connected({ certificate: { source: "gateway", reason: "pending" } }));
    expect(text()).toContain("Getting a trusted certificate…");
    // A wait on Tailscale shows a spinner, announced as a status.
    const waiting = host.querySelector(".tailscale-waiting");
    expect(waiting?.getAttribute("role")).toBe("status");
    expect(waiting?.querySelector(".spinner")).toBeTruthy();
    render(null, host);
    await show(connected({ certificate: { source: "gateway", reason: "failed", error: "acme: rate limited" } }));
    expect(text()).toContain("Couldn't get a trusted certificate");
    expect(host.querySelector(".tailscale-details pre")?.textContent).toBe("acme: rate limited");
  });

  test("the public address is chosen on the MCP server page, and each of its states reads plainly", async () => {
    await show(connected());
    expect(text()).toContain("Off: this device answers on your Tailscale network only.");
    expect(link("MCP server page").getAttribute("href")).toBe("/portal/settings/mcp");
    expect(host.querySelector('[role="switch"]')).toBeNull();

    render(null, host);
    await show(connected({ public: { wanted: true, state: "starting" } }));
    expect(text()).toContain("On: ChatGPT and Claude's cloud connectors can reach your MCP server");
    expect(text()).toContain("Opening…");

    render(null, host);
    await show(
      connected({
        public: { wanted: true, state: "needs-enable", enableUrl: "https://login.tailscale.com/f/funnel?node=fictional", reason: "raw helper text" },
      }),
    );
    expect(text()).toContain("Allow public access for this gateway in Tailscale first.");
    expect(link("Allow in Tailscale").getAttribute("href")).toBe("https://login.tailscale.com/f/funnel?node=fictional");
    expect(text()).not.toContain("raw helper text");

    render(null, host);
    await show(connected({ public: { wanted: true, state: "unavailable", reason: "https-disabled" } }));
    expect(text()).toContain("The public address needs HTTPS certificates");
    render(null, host);
    await show(connected({ public: { wanted: true, state: "unavailable", reason: "not-signed-in" } }));
    expect(text()).toContain("Sign in first.");

    render(null, host);
    await show(connected({ public: { wanted: true, state: "on", url: "https://omnesis.example-net.ts.net" } }));
    const mcp = host.querySelector("#tailscale-public-mcp") as HTMLInputElement;
    expect(mcp.value ?? mcp.getAttribute("value")).toBe("https://omnesis.example-net.ts.net/mcp");
    expect(text()).toContain("create a custom connector in ChatGPT or Claude");
  });

  test("the public address and joining devices wait for the connection", async () => {
    await show(off({ enabled: true, helper: { state: "running" }, connection: "needs-sign-in", public: { wanted: true, state: "off" } }));
    expect(host.querySelector("#tailscale-public-title")).toBeNull();
    expect(host.querySelector('input[name="tailscale-join-policy"]')).toBeNull();
    expect(host.querySelector(".tailscale-panel .tailscale-device #tailscale-device-name")).not.toBeNull();
    expect(host.querySelector("details")).toBeNull();
  });

  test("joining devices are chosen in the Connectivity setup, not on this page", async () => {
    await show(connected({ joinRequests: [request] }));
    expect(host.querySelector('input[name="tailscale-join-policy"]')).toBeNull();
    expect(host.querySelector(".tailscale-waiting-devices")).toBeNull();
    expect(button("Approve")).toBeUndefined();
  });

  test("signing out or turning off warns when this page is open at the device's own address", () => {
    const state = connected();
    const name = state.node.dnsName.replace(/\.$/u, "");
    expect(viewedThroughDevice(state, { hostname: name.toUpperCase() })).toBe(true);
    expect(viewedThroughDevice(state, { hostname: "198.51.100.4" })).toBe(false);
    expect(viewedThroughDevice({ node: null }, { hostname: name })).toBe(false);
  });

  test("the main card renames the device and shows the gateway's validation message", async () => {
    await show(connected());
    expect(host.querySelector("details")).toBeNull();
    expect(host.querySelector(".tailscale-panel .tailscale-device")).not.toBeNull();
    const input = host.querySelector("#tailscale-device-name") as HTMLInputElement;
    const form = input.closest("form") as HTMLFormElement;
    const type = async (value: string) => {
      input.value = value;
      await act(async () => {
      input.dispatchEvent(new (window as any).Event("input"));
    });
    };
    await type("bad_name");
    api.updateTailscaleSettings.mockRejectedValueOnce(
      Object.assign(new Error("Validation failed"), {
        status: 400,
        serverMessage: "Use letters, digits and hyphens, starting and ending with a letter or digit.",
      }),
    );
    await act(async () => {
      form.dispatchEvent(new (window as any).Event("submit", { cancelable: true }));
    });
    await act(async () => {});
    expect(api.updateTailscaleSettings).toHaveBeenCalledWith({ deviceName: "bad_name" }, expect.anything());
    expect(host.querySelector(".tailscale-field-error")?.textContent).toContain("Use letters, digits and hyphens");
    expect(host.querySelector(".tailscale-error")).toBeNull();

    await type("  ");
    api.updateTailscaleSettings.mockClear();
    await act(async () => {
      form.dispatchEvent(new (window as any).Event("submit", { cancelable: true }));
    });
    expect(api.updateTailscaleSettings).not.toHaveBeenCalled();
    expect(host.querySelector(".tailscale-field-error")?.textContent).toBe("Enter a name.");

    await type("studio");
    api.updateTailscaleSettings.mockResolvedValueOnce(connected({ deviceName: "studio" }));
    await act(async () => {
      form.dispatchEvent(new (window as any).Event("submit", { cancelable: true }));
    });
    await act(async () => {});
    expect(api.updateTailscaleSettings).toHaveBeenCalledWith({ deviceName: "studio" }, expect.anything());
    expect(host.querySelector(".tailscale-field-error")).toBeNull();
  });

  test("a connected device shows the name Tailscale gave it, and saving the chosen one asks again", async () => {
    await show(
      connected({
        url: "https://omnesis-1.example-net.ts.net",
        node: { dnsName: "omnesis-1.example-net.ts.net", name: "omnesis-1", naming: "taken", ips: [] },
      }),
    );
    const input = host.querySelector("#tailscale-device-name") as HTMLInputElement;
    expect(input.value ?? input.getAttribute("value")).toBe("omnesis-1");
    expect(button("Save").disabled).toBe(true);
    expect(host.querySelector(".tailscale-name-note")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Tailscale named it omnesis-1 because omnesis is already used on your Tailscale network. Remove the other machine named omnesis in the Tailscale admin console, then rename this one to omnesis here.",
    );
    expect(link("Tailscale admin console").getAttribute("href")).toBe("https://login.tailscale.com/admin/machines");
    input.value = "omnesis";
    await act(async () => {
      input.dispatchEvent(new (window as any).Event("input"));
    });
    expect(button("Save").disabled).toBe(false);
    api.updateTailscaleSettings.mockResolvedValueOnce(
      connected({ node: { dnsName: "omnesis.example-net.ts.net", name: "omnesis", naming: "chosen", ips: [] } }),
    );
    await act(async () => {
      input.closest("form")!.dispatchEvent(new (window as any).Event("submit", { cancelable: true }));
    });
    await act(async () => {});
    expect(api.updateTailscaleSettings).toHaveBeenCalledWith({ deviceName: "omnesis" }, expect.anything());
    expect(host.querySelector(".tailscale-name-note")).toBeNull();
    expect(button("Save").disabled).toBe(true);
  });

  test("a rename Tailscale has not taken yet says so", async () => {
    await show(
      connected({
        deviceName: "studio",
        node: { dnsName: "omnesis.example-net.ts.net", name: "omnesis", naming: "pending", ips: [] },
      }),
    );
    expect(text()).toContain("Renaming to studio…");
  });

  test("a name given in the Tailscale admin console is shown, with where to change it", async () => {
    await show(
      connected({
        url: "https://study-box.example-net.ts.net",
        node: { dnsName: "study-box.example-net.ts.net", name: "study-box", naming: "renamed", ips: [] },
      }),
    );
    expect(host.querySelector("#tailscale-device-name")).toBeNull();
    expect(button("Save")).toBeUndefined();
    expect(text()).toContain("study-box");
    expect(text()).toContain("It was renamed in the Tailscale admin console, and Tailscale keeps that name whatever is set here. Rename it there.");
  });

  test("before it connects, the field holds the name the device will ask for", async () => {
    await show(off({ deviceName: "studio" }));
    const input = host.querySelector("#tailscale-device-name") as HTMLInputElement;
    expect(input.value ?? input.getAttribute("value")).toBe("studio");
    expect(host.querySelector(".tailscale-name-note")).toBeNull();
  });

  test("the main card's sign out and turn off each ask in a dialog first", async () => {
    await show(connected());
    await click("Sign out of Tailscale");
    expect(doc.querySelector(".confirm-modal-title")?.textContent).toBe("Sign out of Tailscale?");
    expect(text()).toContain("leaves your Tailscale network until you sign in again");
    await click("Cancel");
    expect(api.tailscaleSignOut).not.toHaveBeenCalled();
    api.tailscaleSignOut.mockResolvedValue(
      off({ enabled: true, helper: { state: "running" }, connection: "needs-sign-in", signInUrl: null }),
    );
    await click("Sign out of Tailscale");
    await click("Sign out");
    expect(api.tailscaleSignOut).toHaveBeenCalledOnce();
    expect(pill()).toBe("Sign in needed");

    await click("Turn off");
    expect(doc.querySelector(".confirm-modal-title")?.textContent).toBe("Turn off Tailscale?");
    expect(text()).toContain("public address for your MCP server closes");
    api.setTailscaleEnabled.mockResolvedValue(off());
    const confirm = host.querySelector(".confirm-modal .btn-primary") as HTMLButtonElement;
    await act(async () => confirm.click());
    await act(async () => {});
    expect(api.setTailscaleEnabled).toHaveBeenCalledWith(false, expect.anything());
    expect(pill()).toBe("Off");
  });

  test("errors show the gateway's message with Try again, which repeats the call", async () => {
    api.getTailscale.mockRejectedValueOnce(Object.assign(new Error("GET failed"), { serverMessage: "The gateway is busy." }));
    await act(async () => render(h(TailscaleView, {}), host));
    await act(async () => {});
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The gateway is busy.");
    api.getTailscale.mockResolvedValue(off());
    await click("Try again");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(pill()).toBe("Off");

    api.setTailscaleEnabled.mockRejectedValueOnce(new Error("Could not turn on"));
    await click("Turn on");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not turn on");
    api.setTailscaleEnabled.mockResolvedValueOnce(off({ enabled: true, helper: { state: "starting" }, connection: "starting" }));
    await click("Try again");
    expect(api.setTailscaleEnabled).toHaveBeenCalledTimes(2);
    expect(pill()).toBe("Starting");
  });
});

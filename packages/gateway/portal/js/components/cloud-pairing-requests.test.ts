// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({
  askBeforeEveryNewDevice: vi.fn(),
  cloudPairingConfig: vi.fn(),
  cloudPairingRequests: vi.fn(),
  decideCloudPairing: vi.fn(),
}));
const signals = vi.hoisted(() => ({ emit: (_topic: string | null) => {}, setHealthy: (_healthy: boolean) => {} }));
vi.mock("../lib/cloud-pairing-api.js", () => api);
vi.mock("../lib/portal-signals.js", async (importOriginal) =>
  (await import("../lib/portal-signals-fake.js")).mockPortalSignals(await importOriginal(), signals));
import {
  CloudPairingDenied,
  CloudPairingRequest,
  CloudPairingRequests,
  // @ts-expect-error — portal JavaScript has no sibling declarations.
} from "./cloud-pairing-requests.js";
/** Rendered text with HTML whitespace collapsed, as a browser shows it. */
const norm = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ");
let host: HTMLElement;
const request = {
  requestId: "00000000-0000-4000-8000-000000000001",
  name: "Fictional phone",
  kind: "ios",
  status: "pending",
  verificationCode: "AAAA-BBBB-CCCC-DDDD-EEEE",
  expiresAt: Date.now() + 600_000,
};
beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  api.cloudPairingConfig.mockReset();
  api.cloudPairingRequests.mockReset();
  api.decideCloudPairing.mockReset();
  api.decideCloudPairing.mockResolvedValue({ ok: true });
  api.askBeforeEveryNewDevice.mockReset();
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});
type Row = typeof request & {
  signIn?: string;
  canTrustSignIn?: boolean;
  signInEmail?: string;
  rememberByDefault?: boolean;
  otherGoogleAccount?: boolean;
  revokedDevice?: boolean;
  createdAt?: number;
};
async function show(value: Row = request, onDecision = vi.fn(), more: Record<string, unknown> = {}) {
  await act(async () => {
    render(h(CloudPairingRequest, { request: value, onDecision, ...more }), host);
  });
  return onDecision;
}
const remember = () => host.querySelector(".cloud-pairing-trust input") as HTMLInputElement;
const isOn = (box: HTMLInputElement) => box.checked ?? box.hasAttribute("checked");
/** Lets a click's chain of awaits (decide, then refresh) finish. */
async function settle() {
  await act(async () => {
    for (let index = 0; index < 5; index++) await Promise.resolve();
  });
}
async function tick(box: HTMLInputElement, checked: boolean) {
  await act(async () => {
    box.checked = checked;
    box.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  ) as HTMLButtonElement;
}
async function showRequests() {
  await act(async () => render(h(CloudPairingRequests, {}), host));
  await act(async () => {
    await Promise.resolve();
  });
}
const QUESTION = `Does ${request.name} show this code?`;
test("the card asks about the device, shows the gateway's code as sent, and approves in one action", async () => {
  const refreshed = await show();
  // The device, what it is, the question, the code and the two answers. Nothing else.
  expect(
    [...(host.querySelector("article")?.children ?? [])].map((item) =>
      norm(item.textContent).trim(),
    ),
  ).toEqual([
    "Fictional phone wants to connect",
    "iOS app",
    QUESTION,
    request.verificationCode,
    "Yes, approveNo, deny",
  ]);
  expect(host.querySelector("article")?.getAttribute("aria-label")).toBe(
    "Fictional phone wants to connect",
  );
  expect(host.querySelector(".cloud-pairing-code")?.textContent).toBe(request.verificationCode);
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect([...host.querySelectorAll("button")].map((item) => norm(item.textContent).trim())).toEqual([
    "Yes, approve",
    "No, deny",
  ]);
  await act(async () => button("Yes, approve").click());
  expect(api.decideCloudPairing).toHaveBeenCalledExactlyOnceWith(
    request.requestId,
    true,
    undefined,
  );
  expect(refreshed).toHaveBeenCalledOnce();
});
test("a six-digit code is shown in two groups of three; any other code as the gateway sends it", async () => {
  for (const [verificationCode, groups] of [
    ["465 774", ["465", "774"]],
    ["465774", ["465", "774"]],
    ["ZZ", []],
    [request.verificationCode, []],
  ] as const) {
    await show({ ...request, verificationCode });
    const code = host.querySelector(".cloud-pairing-code")!;
    expect([...code.querySelectorAll("span")].map((item) => item.textContent)).toEqual(groups);
    expect(code.textContent).toBe(groups.length ? groups.join(" ") : verificationCode);
  }
});
test("the card reads the same for a collector, and says when and how the device signed in", async () => {
  await show({ ...request, kind: "collector" });
  expect(host.querySelector(".devices-muted")?.textContent?.trim()).toBe("Collector");
  expect(norm(host.textContent)).toContain(QUESTION);
  const at = new Date(2028, 0, 2, 22, 41).getTime();
  await show({
    ...request,
    kind: "portal",
    signIn: "google",
    signInEmail: "maya.reeves@example.com",
    createdAt: at,
  });
  expect(host.querySelector(".devices-muted")?.textContent?.trim()).toBe(
    `Browser · signed in with Google · maya.reeves@example.com · ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
  );
  // An address is only ever shown for a Google sign-in.
  await show({ ...request, signIn: "passkey", signInEmail: "maya.reeves@example.com" });
  expect(host.querySelector(".devices-muted")?.textContent?.trim()).toBe(
    "iOS app · signed in with a passkey",
  );
});
test("can deny without comparison and shows refused or expired decisions without silently approving", async () => {
  await show();
  api.decideCloudPairing.mockRejectedValueOnce(new Error("Request expired"));
  await act(async () => button("No, deny").click());
  expect(api.decideCloudPairing).toHaveBeenCalledWith(request.requestId, false, undefined);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Request expired");
  // A card left on screen past its time, or already answered, offers nothing.
  for (const gone of [
    { ...request, expiresAt: Date.now() - 1 },
    { ...request, status: "denied" },
    { ...request, status: "approved" },
  ]) {
    await show(gone);
    expect(host.querySelector("button, input, .cloud-pairing-code")).toBeNull();
  }
  // An approval still being written keeps its card, with nothing to press twice.
  await show({ ...request, status: "approving" });
  expect(button("Updating").disabled).toBe(true);
  expect(button("No, deny").disabled).toBe(true);
});
test("a request leaves the section once it is approved, denied or out of time", async () => {
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client" });
  const row = (requestId: string, name: string, more: Record<string, unknown> = {}) => ({
    ...request,
    requestId,
    name,
    ...more,
  });
  api.cloudPairingRequests.mockResolvedValue({
    items: [
      row("00000000-0000-4000-8000-00000000000a", "Fictional tablet"),
      row("00000000-0000-4000-8000-00000000000b", "Fictional laptop", { status: "approved" }),
      row("00000000-0000-4000-8000-00000000000c", "Fictional desktop", { status: "denied" }),
      row("00000000-0000-4000-8000-00000000000d", "Fictional watch", { expiresAt: Date.now() - 1 }),
    ],
  });
  await showRequests();
  expect(
    [...host.querySelectorAll(".cloud-pairing-request h3")].map((item) => item.textContent),
  ).toEqual(["Fictional tablet wants to connect"]);
  render(null, host);
  // Only answered requests left: the whole section goes.
  api.cloudPairingRequests.mockResolvedValue({
    items: [row("00000000-0000-4000-8000-00000000000b", "Fictional laptop", { status: "approved" })],
  });
  await showRequests();
  expect(host.textContent).toBe("");
});
test("optional configuration hides the surface, while configured requests show safely escaped names and codes", async () => {
  api.cloudPairingConfig.mockResolvedValue(null);
  await showRequests();
  expect(host.textContent).toBe("");
  render(null, host);
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client", webSignIn: false });
  api.cloudPairingRequests.mockResolvedValue({
    items: [{ ...request, name: "<script>fictional</script>" }],
  });
  await showRequests();
  expect(norm(host.textContent)).toContain("<script>fictional</script>");
  expect(host.querySelector("script")).toBeNull();
  expect(norm(host.textContent)).toContain(request.verificationCode);
});
test("empty, unavailable, and failed polling states stay actionable", async () => {
  api.cloudPairingConfig.mockRejectedValue(new Error("unavailable"));
  await showRequests();
  expect(host.textContent).toBe("");
  render(null, host);
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client" });
  api.cloudPairingRequests.mockRejectedValueOnce(new Error("Couldn't load requests"));
  await showRequests();
  expect(norm(host.textContent)).toContain("Couldn't load requests");
  render(null, host);
  api.cloudPairingRequests.mockResolvedValue({ items: [] });
  await showRequests();
  // Nothing waiting is the normal case: the section stays out of the way.
  expect(host.textContent).toBe("");
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  expect(api.cloudPairingRequests.mock.calls.length).toBeGreaterThan(1);
});

test("the list is read again when the gateway signals devices, on a resync, and just after a request expires", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  signals.setHealthy(true);
  try {
    api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client" });
    api.cloudPairingRequests.mockResolvedValue({ items: [] });
    await showRequests();
    await settle();
    expect(api.cloudPairingRequests).toHaveBeenCalledTimes(1);
    api.cloudPairingRequests.mockResolvedValue({ items: [{ ...request, expiresAt: Date.now() + 30_000 }] });
    signals.emit("devices");
    await settle();
    expect(api.cloudPairingRequests).toHaveBeenCalledTimes(2);
    expect(norm(host.textContent)).toContain(QUESTION);
    signals.emit(null);
    await settle();
    expect(api.cloudPairingRequests).toHaveBeenCalledTimes(3);
    api.cloudPairingRequests.mockResolvedValue({ items: [] });
    await act(async () => {
      vi.advanceTimersByTime(30_500);
    });
    await settle();
    expect(api.cloudPairingRequests).toHaveBeenCalledTimes(4);
    expect(host.textContent).toBe("");
    // While the signals are down the list is read on the fallback interval instead.
    await act(async () => {
      signals.setHealthy(false);
    });
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(api.cloudPairingRequests).toHaveBeenCalledTimes(5);
  } finally {
    signals.setHealthy(false);
    vi.useRealTimers();
  }
});

test("a request that expires after render cannot be approved from a stale button", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const row = { ...request, expiresAt: Date.now() + 1000 };
    await show(row);
    const approve = button("Yes, approve");
    vi.setSystemTime(row.expiresAt + 1);
    await act(async () => approve.click());
    expect(api.decideCloudPairing).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("a verified sign-in can be remembered, only when approving, and starts unticked unless suggested", async () => {
  const row = { ...request, signIn: "google", canTrustSignIn: true };
  await show(row);
  expect(host.querySelector(".devices-muted")?.textContent?.trim()).toBe(
    "iOS app · signed in with Google",
  );
  expect(norm(host.textContent)).toContain("Remember this Google account");
  expect(norm(host.textContent)).toContain(
    "Next time you sign in with it in the Omnesis app, your device connects without asking.",
  );
  expect(norm(host.textContent)).not.toContain("Trust this sign-in");
  expect(isOn(remember())).toBe(false);
  await tick(remember(), true);
  await act(async () => button("Yes, approve").click());
  expect(api.decideCloudPairing).toHaveBeenLastCalledWith(request.requestId, true, true);
  api.decideCloudPairing.mockClear();
  render(null, host);
  await show({ ...row, requestId: "00000000-0000-4000-8000-000000000002" });
  await act(async () => button("Yes, approve").click());
  expect(api.decideCloudPairing).toHaveBeenLastCalledWith(
    "00000000-0000-4000-8000-000000000002",
    true,
    false,
  );
  await show({ ...row, requestId: "00000000-0000-4000-8000-000000000003" });
  await act(async () => button("No, deny").click());
  expect(api.decideCloudPairing).toHaveBeenLastCalledWith(
    "00000000-0000-4000-8000-000000000003",
    false,
    undefined,
  );
});

test("on the first confirmation the gateway's suggestion ticks it, with the verified address in large type", async () => {
  const row = {
    ...request,
    signIn: "google",
    canTrustSignIn: true,
    signInEmail: "maya.reeves@example.com",
    rememberByDefault: true,
  };
  await show(row);
  expect(isOn(remember())).toBe(true);
  expect(host.querySelector(".cloud-pairing-trust .cloud-pairing-email")?.textContent).toBe(
    "maya.reeves@example.com",
  );
  // The owner can still untick it, and that choice holds even if the suggestion changes.
  await tick(remember(), false);
  await show({ ...row, rememberByDefault: true, expiresAt: row.expiresAt });
  expect(isOn(remember())).toBe(false);
  await act(async () => button("Yes, approve").click());
  expect(api.decideCloudPairing).toHaveBeenLastCalledWith(request.requestId, true, false);
  // Untouched, it follows the gateway: once something is confirmed, it is no longer suggested.
  render(null, host);
  await show(row);
  await show({ ...row, rememberByDefault: false });
  expect(isOn(remember())).toBe(false);
});

test("another Google account than the one the gateway was connected with can't be remembered", async () => {
  await show({
    ...request,
    signIn: "google",
    canTrustSignIn: true,
    signInEmail: "jamie.lopez@example.com",
    // Even a suggestion can't tick it.
    rememberByDefault: true,
    otherGoogleAccount: true,
  });
  expect(norm(host.querySelector(".cloud-pairing-other-account")?.textContent).trim()).toBe(
    "This isn't the Google account you connected with.",
  );
  expect(isOn(remember())).toBe(false);
  expect(remember().disabled).toBe(true);
  await act(async () => button("Yes, approve").click());
  expect(api.decideCloudPairing).toHaveBeenLastCalledWith(request.requestId, true, false);
  // Said even when there is nothing to remember.
  await show({ ...request, signIn: "google", otherGoogleAccount: true });
  expect(host.querySelector(".cloud-pairing-other-account")).not.toBeNull();
  expect(host.querySelector(".cloud-pairing-trust")).toBeNull();
});

test("no remember choice for an unverified or already confirmed sign-in, and passkeys are named", async () => {
  await show({ ...request, kind: "android", signIn: "passkey", canTrustSignIn: false });
  expect(host.querySelector(".devices-muted")?.textContent?.trim()).toBe(
    "Android app · signed in with a passkey",
  );
  expect(host.querySelector(".cloud-pairing-trust")).toBeNull();
  await show({ ...request, kind: "portal", canTrustSignIn: true, signIn: "passkey" });
  expect(norm(host.textContent)).toContain("Browser · signed in with a passkey");
  expect(norm(host.textContent)).toContain("Remember this passkey");
  expect(norm(host.textContent)).toContain(
    "Next time you add a device with this passkey, it connects without asking.",
  );
  // An unknown kind is shown as sent; an unknown status is not something to approve.
  await show({ ...request, kind: "watch", status: "mystery" });
  expect(host.querySelector(".devices-muted")?.textContent?.trim()).toBe("watch");
  expect(host.querySelector("button")).toBeNull();
});

test("when approving here needs the passkey, the button says so and no extra note comes before it", async () => {
  await show(request, vi.fn(), { stepUpRequired: true });
  expect(button("Yes, approve with passkey")).toBeDefined();
  await act(async () => button("Yes, approve with passkey").click());
  expect(api.decideCloudPairing).toHaveBeenLastCalledWith(request.requestId, true, undefined, {
    stepUpAnnounced: true,
  });
  // Denying only makes the gateway stricter: it never asks, so nothing is announced.
  await show({ ...request, requestId: "00000000-0000-4000-8000-000000000004" }, vi.fn(), {
    stepUpRequired: true,
  });
  await act(async () => button("No, deny").click());
  expect(api.decideCloudPairing).toHaveBeenLastCalledWith(
    "00000000-0000-4000-8000-000000000004",
    false,
    undefined,
  );
});

test("a request from a device the owner revoked says so before the code", async () => {
  await show({ ...request, revokedDevice: true } as typeof request);
  const note = host.querySelector(".cloud-pairing-revoked");
  expect(norm(note?.textContent).trim()).toBe(
    "You removed this device before. Approve only if it's back in your hands.",
  );
  expect(note?.nextElementSibling?.textContent).toBe(QUESTION);
  await show();
  expect(host.querySelector(".cloud-pairing-revoked")).toBeNull();
});

test("on the gateway's own page an app's request can be approved with a passkey; a browser's cannot", async () => {
  const approve = vi.fn().mockResolvedValue(undefined);
  const onDecision = vi.fn();
  await act(async () => {
    render(
      h(CloudPairingRequest, {
        request: { ...request, signIn: "passkey", canTrustSignIn: true },
        onDecision,
        passkey: true,
        approve,
      }),
      host,
    );
  });
  await tick(remember(), true);
  await act(async () => button("Approve with passkey").click());
  expect(approve).toHaveBeenCalledExactlyOnceWith({
    requestId: request.requestId,
    trustSignIn: true,
  });
  expect(api.decideCloudPairing).not.toHaveBeenCalled();
  expect(onDecision).toHaveBeenCalledOnce();
  approve.mockRejectedValueOnce(new Error("Your gateway didn't accept that passkey."));
  render(null, host);
  await act(async () => {
    render(h(CloudPairingRequest, { request, onDecision, passkey: true, approve }), host);
  });
  await act(async () => button("Approve with passkey").click());
  expect(approve).toHaveBeenLastCalledWith({ requestId: request.requestId });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Your gateway didn't accept that passkey.",
  );
  render(null, host);
  await act(async () => {
    render(
      h(CloudPairingRequest, { request: { ...request, kind: "portal" }, onDecision, passkey: true }),
      host,
    );
  });
  expect(button("Approve with passkey")).toBeUndefined();
});

test("the list offers passkey approval only on the gateway's own origin, when the gateway says a passkey can approve", async () => {
  vi.stubGlobal("location", { origin: "https://g-abcdefgh.relay.example.test", search: "" });
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("navigator", { credentials: { get: vi.fn() } });
  api.cloudPairingRequests.mockResolvedValue({ items: [request] });
  for (const [origin, passkeyApproval, shown] of [
    ["https://g-abcdefgh.relay.example.test", true, true],
    // An owner with no confirmed passkey is never offered a button that can only fail.
    ["https://g-abcdefgh.relay.example.test", false, false],
    ["https://g-abcdefgh.relay.example.test", undefined, false],
    ["https://g-other.relay.example.test", true, false],
  ] as const) {
    api.cloudPairingConfig.mockResolvedValue({
      gatewayPasskey: { rpId: "relay.example.test", origin },
      ...(passkeyApproval === undefined ? {} : { passkeyApproval }),
    });
    await showRequests();
    await act(async () => {
      await Promise.resolve();
    });
    expect(Boolean(button("Approve with passkey"))).toBe(shown);
    render(null, host);
  }
  // When approving here already asks for the passkey, one passkey button is enough.
  api.cloudPairingConfig.mockResolvedValue({
    gatewayPasskey: { rpId: "relay.example.test", origin: "https://g-abcdefgh.relay.example.test" },
    passkeyApproval: true,
  });
  api.cloudPairingRequests.mockResolvedValue({ items: [request], stepUpRequired: true });
  await showRequests();
  expect(button("Approve with passkey")).toBeUndefined();
  expect(button("Yes, approve with passkey")).toBeDefined();
});

test("a notification's link opens its request first", async () => {
  const scrolled = vi.fn();
  const other = { ...request, requestId: "00000000-0000-4000-8000-00000000000e", name: "Fictional tablet" };
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client" });
  api.cloudPairingRequests.mockResolvedValue({ items: [request, other] });
  vi.stubGlobal("location", { origin: "https://gateway.example.test", search: `?request=${other.requestId}` });
  (window as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype.scrollIntoView = scrolled;
  try {
    await showRequests();
    const cards = [...host.querySelectorAll(".cloud-pairing-request")];
    expect(cards.map((card) => card.id)).toEqual([
      `cloud-pairing-request-${other.requestId}`,
      `cloud-pairing-request-${request.requestId}`,
    ]);
    expect(cards[0]!.className).toContain("cloud-pairing-focused");
    expect(cards[1]!.className).not.toContain("cloud-pairing-focused");
    expect(scrolled).toHaveBeenCalledOnce();
  } finally {
    delete (window as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype.scrollIntoView;
  }
  // Without a link, the gateway's order.
  render(null, host);
  vi.stubGlobal("location", { origin: "https://gateway.example.test", search: "" });
  await showRequests();
  expect([...host.querySelectorAll(".cloud-pairing-request h3")].map((item) => item.textContent)).toEqual([
    "Fictional phone wants to connect",
    "Fictional tablet wants to connect",
  ]);
});

test("after a deny the section says what it may mean and offers to make every new device ask", async () => {
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client" });
  api.cloudPairingRequests.mockResolvedValue({ items: [{ ...request, signIn: "google" }] });
  await showRequests();
  api.cloudPairingRequests.mockResolvedValue({ items: [{ ...request, status: "denied" }] });
  await act(async () => button("No, deny").click());
  await settle();
  // The request is gone; what to do next stays.
  expect(host.querySelector(".cloud-pairing-request")).toBeNull();
  const notice = host.querySelector(".cloud-pairing-denied")!;
  expect(norm(notice.textContent)).toContain(
    "Denied. If you didn't try to connect a device, someone may know your Google password.",
  );
  api.askBeforeEveryNewDevice.mockRejectedValueOnce(new Error("Couldn't change this."));
  await act(async () => button("Make new devices always ask me").click());
  expect(host.querySelector('.cloud-pairing-denied [role="alert"]')?.textContent).toBe(
    "Couldn't change this.",
  );
  api.askBeforeEveryNewDevice.mockResolvedValueOnce({});
  await act(async () => button("Make new devices always ask me").click());
  expect(api.askBeforeEveryNewDevice).toHaveBeenCalledTimes(2);
  expect(norm(host.querySelector(".cloud-pairing-denied")?.textContent)).toContain(
    "New devices will now always wait for your OK.",
  );
  expect(button("Make new devices always ask me")).toBeUndefined();
});

test("the deny note fits a passkey sign-in too, and Done puts it away", async () => {
  const onClose = vi.fn();
  await act(async () => render(h(CloudPairingDenied, { denied: { signIn: "passkey" }, onClose }), host));
  expect(norm(host.textContent)).toContain(
    "Denied. If you didn't try to connect a device, someone may be signed in to your Omnesis account.",
  );
  await act(async () => button("Done").click());
  expect(onClose).toHaveBeenCalledOnce();
  // In the list, Done removes the note.
  render(null, host);
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client" });
  api.cloudPairingRequests.mockResolvedValue({ items: [request] });
  await showRequests();
  api.cloudPairingRequests.mockResolvedValue({ items: [] });
  await act(async () => button("No, deny").click());
  await settle();
  expect(host.querySelector(".cloud-pairing-denied")).not.toBeNull();
  await act(async () => button("Done").click());
  expect(host.textContent).toBe("");
});

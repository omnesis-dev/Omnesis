// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const handoff = vi.hoisted(() => ({ next: vi.fn<() => string | null>(() => null) }));
vi.mock("../lib/cloud-pairing-handoff.js", () => ({ takeHandoffNext: handoff.next }));
import {
  accountConfirmation,
  FinishSetup,
  openOnGateway,
  SetupReminder,
  // @ts-expect-error portal JS
} from "./gateway-passkey-confirm.js";
// @ts-expect-error portal JS
import { GatewayPasskeyError } from "../lib/gateway-passkey.js";

const ORIGIN = "https://g-abcdefgh.relay.example.test";
const PASSKEY = { type: "passkey", id: "p", addedAt: 1, source: "link-page", confirmed: false };
const GOOGLE = { type: "google", id: "g".repeat(64), addedAt: 1, source: "link-page", confirmed: false };
const enrollment = {
  policy: "automatic",
  confirmationNeeded: true,
  trustedSignIns: [PASSKEY],
  confirmedSignIns: [],
  confirmOrigin: ORIGIN,
};
const OTHER_ACCOUNT =
  "That passkey is for a different Omnesis account. It may be from an account you deleted. Choose another passkey, or continue with Google.";
let host: HTMLElement;
beforeEach(() => {
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  host = dom.document.querySelector("main") as unknown as HTMLElement;
  handoff.next.mockReset();
  handoff.next.mockReturnValue(null);
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined;
const primary = () => host.querySelector(".btn-primary") as HTMLButtonElement | null;
const alert = () => host.querySelector('[role="alert"]')?.textContent;
const links = () => [...host.querySelectorAll("a")].map((link) => link.getAttribute("href"));
async function show(props: Record<string, unknown>) {
  await act(async () =>
    render(
      h(FinishSetup, {
        enrollment,
        ready: true,
        serviceUrl: "https://relay.example.test",
        busy: "",
        run: vi.fn(),
        onDismiss: vi.fn(),
        location: { origin: ORIGIN },
        supported: true,
        ...props,
      }),
      host,
    ),
  );
}
/** Clicks and lets the request, the prompt and the reply settle. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
async function click(target: HTMLElement | null | undefined) {
  await act(async () => {
    target!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const refusal = (code: string) => Object.assign(new Error("refused"), { code });
const confirming = (failure?: unknown) =>
  vi.fn().mockImplementation(async (operation: string) => {
    if (operation === "passkeys/confirm/options") return { rpId: "relay.example.test" };
    if (failure) throw failure;
    return { revision: 2 };
  });

test("the last step follows the account: a passkey to use, one to add, or nothing", () => {
  expect(accountConfirmation(enrollment)).toBe("passkey");
  // No passkey known here: offer to add one.
  expect(accountConfirmation({ ...enrollment, trustedSignIns: [GOOGLE] })).toBe("add-passkey");
  expect(accountConfirmation({ ...enrollment, trustedSignIns: undefined })).toBe("add-passkey");
  // Without an address of its own no passkey can be used or added here: devices are approved.
  expect(accountConfirmation({ ...enrollment, confirmOrigin: undefined })).toBeNull();
  expect(
    accountConfirmation({ ...enrollment, trustedSignIns: [GOOGLE], confirmOrigin: undefined }),
  ).toBeNull();
  // Under "ask me first" every device waits by choice: adding a passkey changes nothing then.
  expect(accountConfirmation({ ...enrollment, trustedSignIns: [GOOGLE], policy: "ask" })).toBeNull();
  expect(accountConfirmation({ ...enrollment, policy: "ask" })).toBe("passkey");
  // Once anything is confirmed, setup is done.
  for (const confirmed of [
    { type: "google", id: "g", at: 1, via: "native-google-approval" },
    { type: "passkey", id: "p", at: 1, via: "gateway-origin" },
  ])
    expect(accountConfirmation({ ...enrollment, confirmedSignIns: [confirmed] })).toBeNull();
  expect(accountConfirmation({ ...enrollment, confirmedSignIns: undefined })).toBe("passkey");
  expect(accountConfirmation(undefined)).toBeNull();
});

/** A per-tab store like the browser's, or one that refuses every call. */
function storage(blocked = false) {
  const values = new Map<string, string>();
  const refuse = () => {
    throw new Error("blocked");
  };
  return {
    values,
    getItem: blocked ? refuse : (key: string) => values.get(key) ?? null,
    setItem: blocked ? refuse : (key: string, value: string) => void values.set(key, value),
    removeItem: blocked ? refuse : (key: string) => void values.delete(key),
  };
}

test("without a passkey, the last step offers to add one, optional and about nothing else", async () => {
  const onDismiss = vi.fn(),
    session = storage();
  vi.stubGlobal("sessionStorage", session);
  await show({ enrollment: { ...enrollment, trustedSignIns: [GOOGLE] }, onDismiss });
  expect(host.querySelector("#relay-setup-title")?.textContent).toBe("Finish setting up");
  const steps = [...host.querySelectorAll(".relay-setup-step")];
  expect(steps.map((step) => step.classList.contains("relay-setup-done"))).toEqual([
    true,
    true,
    false,
  ]);
  expect(text()).toContain("Secure address g-abcdefgh.relay.example.test");
  expect(text()).toContain("Add a passkey (optional)");
  expect(text()).toContain(
    "Three steps: create the passkey on your Omnesis account page, which opens in a new tab, confirm with a sign-in you already use, then come back here and use it once.",
  );
  // Phones are added from Devices: this step says nothing about them.
  expect(text()).not.toMatch(/phone|app|Google/i);
  // One primary action, which opens the account page to add a passkey, and Not now.
  expect(links()).toEqual(["https://relay.example.test/_relay/account?add=passkey"]);
  const add = host.querySelector("a.btn-primary") as HTMLAnchorElement;
  expect(add.textContent?.trim()).toBe("Add a passkey");
  expect(add.getAttribute("target")).toBe("_blank");
  expect([...host.querySelectorAll("button")].map((item) => item.textContent?.trim())).toEqual([
    "Not now",
  ]);
  // Pressing it remembers, in this tab, that the passkey's last step comes back here.
  await click(add);
  expect(session.values.get("omnesis.relay.adding-passkey")).toBe("1");
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "Finish adding the passkey on the Omnesis account page that opened, then come back to this page.",
  );
  await click(button("Not now"));
  expect(onDismiss).toHaveBeenCalledOnce();
  // Without a usable relay address there's nothing to open.
  await show({ enrollment: { ...enrollment, trustedSignIns: [GOOGLE] }, serviceUrl: "http://x" });
  expect(links()).toEqual([]);
  // Done: nothing to show.
  await show({ enrollment: { ...enrollment, confirmedSignIns: [{ type: "google", id: "g" }] } });
  expect(host.innerHTML).toBe("");
});

test("back from adding a passkey, the last step is the sequence's third, and using it ends it", async () => {
  const session = storage();
  session.values.set("omnesis.relay.adding-passkey", "1");
  vi.stubGlobal("sessionStorage", session);
  const proof = { type: "gateway-passkey", credential: { id: "credential-fictional" } };
  const request = confirming(),
    run = vi.fn().mockResolvedValue({});
  await show({ request, prove: vi.fn().mockResolvedValue(proof), run });
  expect(host.querySelectorAll(".relay-setup-step .relay-strong")[2]?.textContent?.trim()).toBe(
    "Adding a passkey · step 3 of 3",
  );
  expect(text()).toContain(
    "Use your new passkey once on your gateway's secure address. After that, a new device that signs in with it connects straight away.",
  );
  await click(button("Continue with passkey"));
  expect(run).toHaveBeenCalledOnce();
  expect(session.values.has("omnesis.relay.adding-passkey")).toBe(false);
  await show({ request, prove: vi.fn().mockResolvedValue(proof), run });
  expect(text()).toContain("Let your passkey add devices");
  // A browser that keeps nothing reads it as setup's usual passkey step, and the add still opens.
  vi.stubGlobal("sessionStorage", storage(true));
  await show({ request, run });
  expect(text()).toContain("Let your passkey add devices");
  await show({ enrollment: { ...enrollment, trustedSignIns: [GOOGLE] } });
  await click(host.querySelector("a.btn-primary") as HTMLAnchorElement);
  expect(host.querySelector('[role="status"]')).not.toBeNull();
});

test("on the gateway's own address, Continue with passkey confirms the passkey, then refreshes", async () => {
  const proof = { type: "gateway-passkey", credential: { id: "credential-fictional" } };
  const request = confirming();
  const prove = vi.fn().mockResolvedValue(proof);
  const run = vi.fn().mockResolvedValue({});
  await show({ request, prove, run });
  expect(text()).toContain("Let your passkey add devices");
  // The page can't tell which device unlocks the passkey, so it names none.
  expect(text()).toContain("Your device will ask for your face, fingerprint or screen lock.");
  await click(button("Continue with passkey"));
  expect(request.mock.calls).toEqual([
    ["passkeys/confirm/options", {}],
    ["passkeys/confirm", { proof }],
  ]);
  expect(prove).toHaveBeenCalledExactlyOnceWith(
    { rpId: "relay.example.test" },
    { location: { origin: ORIGIN } },
  );
  expect(run).toHaveBeenCalledExactlyOnceWith();
  expect(alert()).toBeUndefined();
  // While the prompt is open the button says so and can't be pressed again.
  let answer!: (value: unknown) => void;
  prove.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  await click(button("Continue with passkey"));
  expect(primary()!.textContent?.trim()).toBe("Waiting for your passkey…");
  expect(primary()!.disabled).toBe(true);
  await act(async () => answer(proof));
});

test("a refused passkey says why, in words that don't blame the person", async () => {
  const cases: Array<[unknown, string]> = [
    [refusal("passkey-not-on-account"), OTHER_ACCOUNT],
    [refusal("passkey-not-confirmed"), "Your gateway couldn't check that passkey. Try again."],
    [new GatewayPasskeyError("Prompt closed."), "Prompt closed."],
    [refusal("passkey-origin-unavailable"), "This gateway has no address of its own"],
    [new Error("offline"), "Couldn't use your passkey. Try again."],
  ];
  for (const [failure, message] of cases) {
    const prove =
      failure instanceof GatewayPasskeyError
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue({});
    await show({ request: confirming(failure), prove });
    await click(button("Continue with passkey"));
    expect(alert()).toContain(message);
  }
});

test("opened by the button elsewhere, the prompt starts by itself once, and a closed prompt stays quiet", async () => {
  const prove = vi.fn().mockRejectedValue(new GatewayPasskeyError("The prompt was closed."));
  handoff.next.mockReturnValueOnce("confirm-passkey");
  await show({ request: confirming(), prove });
  await settle();
  expect(prove).toHaveBeenCalledOnce();
  expect(alert()).toBeUndefined();
  expect(button("Continue with passkey")!.disabled).toBe(false);
  // A real refusal is said even then.
  handoff.next.mockReturnValueOnce("confirm-passkey");
  render(null, host);
  await show({ request: confirming(refusal("passkey-not-on-account")), prove: vi.fn().mockResolvedValue({}) });
  await settle();
  expect(alert()).toBe(OTHER_ACCOUNT);
  // Without that request, nothing starts.
  render(null, host);
  const idle = vi.fn();
  await show({ request: confirming(), prove: idle });
  expect(idle).not.toHaveBeenCalled();
});

test("elsewhere, the same button opens the gateway's address signed in; without passkeys it says so", async () => {
  const open = vi.fn().mockResolvedValue(undefined);
  const elsewhere = { origin: "https://192.0.2.1:7600" };
  handoff.next.mockReturnValue("confirm-passkey");
  await show({ location: elsewhere, open });
  // The handoff's request is only for the gateway's own page.
  expect(handoff.next).not.toHaveBeenCalled();
  expect(links()).toEqual([]);
  await click(button("Continue with passkey"));
  expect(open).toHaveBeenCalledExactlyOnceWith(ORIGIN, {
    next: "confirm-passkey",
    location: elsewhere,
  });
  expect(primary()!.textContent?.trim()).toBe("Opening…");
  expect(primary()!.disabled).toBe(true);
  // A refusal is said, and the button comes back.
  render(null, host);
  await show({ location: elsewhere, open: vi.fn().mockRejectedValue(new Error("nope")) });
  await click(button("Continue with passkey"));
  expect(alert()).toBe("Couldn't open your gateway's secure address. Try again.");
  expect(primary()!.disabled).toBe(false);
  // Until the certificate is ready there is nothing to open, and step 2 says it's coming.
  await show({ location: elsewhere, open, ready: false });
  expect(primary()!.disabled).toBe(true);
  expect(text()).toContain("Getting a secure address… usually under a minute");
  // On the gateway's address in a browser without passkeys.
  await show({ supported: false });
  expect(button("Continue with passkey")).toBeUndefined();
  expect(text()).toContain("This browser can't use passkeys.");
  expect(text()).not.toContain("Your device will ask");
  // Another change in progress holds the button; a refresh does not.
  await show({ busy: "enrollment" });
  expect(primary()!.disabled).toBe(true);
  await show({ busy: "refresh" });
  expect(primary()!.disabled).toBe(false);
});

test("the reminder under New devices brings setup back", async () => {
  const onFinish = vi.fn();
  await act(async () => render(h(SetupReminder, { onFinish }), host));
  expect(text()).toContain("New devices wait for your OK until you finish setup.");
  await click(button("Finish setup"));
  expect(onFinish).toHaveBeenCalledOnce();
});

test("opening the gateway's own page follows only a link to that page", async () => {
  const location = { assign: vi.fn() };
  const reply = (body: unknown, status = 200) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const url = `${ORIGIN}/portal/settings/account#portal-handoff=${"a".repeat(43)}&next=confirm-passkey`;
  const request = reply({ url, expiresAt: 1 });
  await openOnGateway(ORIGIN, { next: "confirm-passkey", request, location });
  expect(request).toHaveBeenCalledExactlyOnceWith("/portal/api/handoff", {
    method: "POST",
    body: JSON.stringify({ next: "confirm-passkey" }),
  });
  expect(location.assign).toHaveBeenCalledExactlyOnceWith(url);
  const plain = reply({ url, expiresAt: 1 });
  await openOnGateway(ORIGIN, { request: plain, location });
  expect(plain.mock.calls[0]![1]).toEqual({ method: "POST", body: "{}" });
  for (const bad of [
    reply({ url: `https://elsewhere.example.test/portal/#portal-handoff=${"a".repeat(43)}` }),
    reply({ url: "http://g-abcdefgh.relay.example.test/portal/" }),
    reply({ url: 42 }),
    reply({ error: "no" }, 409),
  ])
    await expect(openOnGateway(ORIGIN, { request: bad, location })).rejects.toThrow(
      "Couldn't open your gateway's secure address. Try again.",
    );
  expect(location.assign).toHaveBeenCalledTimes(2);
});

test("the portal names the passkey, never one maker's way of unlocking it", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const portal = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const files = (await readdir(portal, { recursive: true })).filter(
    (name) => /\.(js|html|css)$/.test(name) && !name.includes("vendor"),
  );
  expect(files.length).toBeGreaterThan(10);
  const named: string[] = [];
  for (const name of files)
    if (/Face ID|Touch ID/.test(await readFile(join(portal, name), "utf8")))
      named.push(name);
  expect(named).toEqual([]);
});

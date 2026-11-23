// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The answer for new devices through the portal's real request path (api.js's
// step-up retry and the remote-access client), against a small stand-in for
// the gateway that guards loosening the way step-up.ts does: a guarded request
// needs a step-up id issued for it, and each id carries one request once. Only
// the passkey prompt and the note before it are stand-ins, counted. Fictional
// data throughout.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const passkey = vi.hoisted(() => ({ stepUp: vi.fn() }));
const sheet = vi.hoisted(() => ({ confirmStepUp: vi.fn() }));
vi.mock("../../lib/gateway-passkey.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  stepUp: passkey.stepUp,
}));
vi.mock("../../lib/step-up-sheet.js", () => sheet);

// @ts-expect-error — portal modules are plain JS.
import { DevicesChoice } from "./devices-step.js";

type Json = Record<string, any>;

/** The gateway: its two policies, the step-up ids it issued, and every request it answered. */
const gateway = {
  relayPolicy: "ask",
  tailscalePolicy: "ask",
  issued: new Map<string, string>(),
  requests: [] as { method: string; path: string; stepUp: string | null; status: number }[],
};
let nextId = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Loosening needs a step-up issued for this exact request, spent on use: F21. */
function guarded(method: string, path: string, body: Json, header: string | null) {
  if (body.policy !== "automatic") return null;
  const binding = `${method} ${path} ${JSON.stringify(body)}`;
  const ok = header !== null && gateway.issued.get(header) === binding;
  if (header) gateway.issued.delete(header);
  return ok
    ? null
    : json({ error: "x", code: "STEP_UP_REQUIRED", detail: { method, path, bodySha256: binding } }, 428);
}

function fakeFetch(input: string, init: Json = {}) {
  const method = String(init.method ?? "GET").toUpperCase();
  const header = (init.headers?.["X-Omnesis-Step-Up"] as string | undefined) ?? null;
  const body = init.body ? JSON.parse(init.body as string) : {};
  const answer = (response: Response) => {
    gateway.requests.push({ method, path: input, stepUp: header, status: response.status });
    return Promise.resolve(response);
  };
  if (method === "PUT" && input === "/admin/remote-access/new-devices") {
    const refused = guarded(method, input, body, header);
    if (refused) return answer(refused);
    gateway.relayPolicy = body.policy;
    gateway.tailscalePolicy = body.policy === "code" ? "off" : body.policy;
    return answer(
      json({
        relay: relayStatus(gateway.relayPolicy, true),
        tailscale: tailscaleState(gateway.tailscalePolicy),
      }),
    );
  }
  return answer(json({ error: "Not found" }, 404));
}

function relayStatus(policy: string, stepUpRequired: boolean): Json {
  return {
    enabled: true,
    serviceConfigured: true,
    enrollment: { state: "enrolled" },
    tunnel: { state: "online" },
    account: { linked: true },
    stepUpRequired,
    deviceEnrollment: { policy, trustedSignIns: [], confirmedSignIns: [] },
  };
}
const tailscaleState = (joinPolicy: string): Json => ({ enabled: true, joinPolicy, connection: "connected" });

/** The relay's and the Tailscale device's feeds, as Connectivity's hooks hand them over. */
function feeds({ relayPolicy = "ask", tailscalePolicy = "ask", stepUpRequired = true } = {}) {
  gateway.relayPolicy = relayPolicy;
  gateway.tailscalePolicy = tailscalePolicy;
  const relay = { status: relayStatus(relayPolicy, stepUpRequired), error: "", adopt: vi.fn() };
  const tailscale = { state: tailscaleState(tailscalePolicy), error: null, adopt: vi.fn() };
  relay.adopt.mockImplementation((status: Json) => (relay.status = status));
  tailscale.adopt.mockImplementation((state: Json) => (tailscale.state = state));
  return { relay, tailscale };
}

let host: HTMLElement;
beforeEach(() => {
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  // The portal open on the gateway's relay address, as from outside the home.
  Object.defineProperty(dom.window, "location", {
    configurable: true,
    value: new URL("https://g-maple.relay.example.test/portal/settings/connectivity"),
  });
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  host = dom.document.querySelector("main") as unknown as HTMLElement;
  gateway.issued.clear();
  gateway.requests = [];
  passkey.stepUp.mockReset();
  // One passkey prompt: the gateway issues an id bound to the request it was asked for.
  passkey.stepUp.mockImplementation(async (detail: Json) => {
    const id = `step-up-${++nextId}`;
    gateway.issued.set(id, detail.bodySha256);
    return id;
  });
  sheet.confirmStepUp.mockReset();
  sheet.confirmStepUp.mockResolvedValue(true);
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
async function show(props: Json) {
  await act(async () => render(h(DevicesChoice, props), host));
}
async function choose(value: string) {
  const input = host.querySelector(`input[value="${value}"]`) as HTMLInputElement;
  expect(input, value).toBeTruthy();
  await act(async () => {
    input.checked = true;
    input.dispatchEvent(new (window as any).Event("change"));
  });
  await settle();
}
const checked = () =>
  ([...host.querySelectorAll("input[type=radio]")] as HTMLInputElement[])
    .filter((input) => (Object.hasOwn(input, "checked") ? input.checked : input.hasAttribute("checked")))
    .map((input) => input.value);

describe("letting devices join automatically from outside the home", () => {
  test("one choice is one guarded request, so the passkey is asked for once", async () => {
    const { relay, tailscale } = feeds();
    await show({ relay, tailscale });
    await choose("automatic");
    // The two ways' policies change together: one passkey, one step-up id, spent once.
    expect(passkey.stepUp).toHaveBeenCalledTimes(1);
    expect(gateway.requests.map(({ method, path, status }) => `${method} ${path} ${status}`)).toEqual([
      "PUT /admin/remote-access/new-devices 428",
      "PUT /admin/remote-access/new-devices 200",
    ]);
    expect(gateway.requests[1]!.stepUp).toBe("step-up-1");
    expect(gateway.issued.size).toBe(0);
    expect([gateway.relayPolicy, gateway.tailscalePolicy]).toEqual(["automatic", "automatic"]);
    // The choice said "Turns on with your passkey", so no note comes before the prompt.
    expect(sheet.confirmStepUp).not.toHaveBeenCalled();
    expect(relay.adopt).toHaveBeenCalledTimes(1);
    expect(tailscale.adopt).toHaveBeenCalledTimes(1);
    await show({ relay, tailscale });
    expect(checked()).toEqual(["automatic"]);
  });

  test("when the page didn't know a passkey was coming, the note is shown once before the one prompt", async () => {
    const { relay, tailscale } = feeds({ stepUpRequired: false });
    await show({ relay, tailscale });
    await choose("automatic");
    expect(sheet.confirmStepUp).toHaveBeenCalledTimes(1);
    expect(passkey.stepUp).toHaveBeenCalledTimes(1);
    expect([gateway.relayPolicy, gateway.tailscalePolicy]).toEqual(["automatic", "automatic"]);
  });

  test("cancelling the passkey leaves both ways as they were, with one answer still selected", async () => {
    const { relay, tailscale } = feeds();
    sheet.confirmStepUp.mockResolvedValue(false);
    passkey.stepUp.mockRejectedValueOnce(
      Object.assign(new Error("The passkey prompt was closed or timed out. Try again."), { stepUp: true }),
    );
    await show({ relay, tailscale });
    await choose("automatic");
    expect([gateway.relayPolicy, gateway.tailscalePolicy]).toEqual(["ask", "ask"]);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("The passkey prompt was closed or timed out. Try again.");
    expect(checked()).toEqual(["ask"]);
  });

  test("asking first never asks for the passkey", async () => {
    const { relay, tailscale } = feeds({ relayPolicy: "automatic", tailscalePolicy: "automatic" });
    await show({ relay, tailscale });
    await choose("ask");
    expect(passkey.stepUp).not.toHaveBeenCalled();
    expect(gateway.requests.map(({ status }) => status)).toEqual([200]);
  });
});

describe("before both ways have answered", () => {
  test("it says it is loading instead of showing two unselected answers", async () => {
    const { relay } = feeds();
    await show({ relay, tailscale: { state: null, error: null, adopt: vi.fn() } });
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).toContain("Loading…");
    // A feed that failed to read is not loading: the ways it does know about are shown.
    await show({ relay, tailscale: { state: null, error: { message: "down" }, adopt: vi.fn() } });
    expect(checked()).toEqual(["ask"]);
  });
});

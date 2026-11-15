// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const stepUp = vi.hoisted(() => vi.fn());
const confirmStepUp = vi.hoisted(() => vi.fn());
vi.mock("./lib/gateway-passkey.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  stepUp,
}));
vi.mock("./lib/step-up-sheet.js", () => ({ confirmStepUp }));
// @ts-expect-error — portal is plain JS without sibling declarations.
import { apiFetch } from "./api.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { GatewayPasskeyError } from "./lib/gateway-passkey.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const detail = {
  method: "POST",
  path: "/admin/devices/pair",
  bodySha256: "a".repeat(64),
  options: "/admin/step-up/options",
  header: "X-Omnesis-Step-Up",
};
const required = () => json({ error: "x", code: "STEP_UP_REQUIRED", detail }, 428);

beforeEach(() => {
  stepUp.mockReset();
  confirmStepUp.mockReset();
  confirmStepUp.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

test("a request the gateway wants a step-up for runs the passkey once and is sent again with its id", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(required())
    .mockResolvedValueOnce(json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  stepUp.mockResolvedValue("step-up-id");
  const response = await apiFetch("/admin/devices/pair", { method: "POST", body: '{"kind":"cli"}' });
  expect(await response.json()).toEqual({ ok: true });
  expect(stepUp).toHaveBeenCalledWith(detail, expect.objectContaining({ post: expect.any(Function) }));
  expect(fetchMock.mock.calls[1]![0]).toBe("/admin/devices/pair");
  expect(fetchMock.mock.calls[1]![1]).toMatchObject({
    method: "POST",
    body: '{"kind":"cli"}',
    headers: { "X-Omnesis-Step-Up": "step-up-id" },
  });
  // The step-up's own calls go through the same session.
  fetchMock.mockResolvedValueOnce(json({ challenge: "c" }));
  const signal = new AbortController().signal;
  await stepUp.mock.calls[0]![1].post("/admin/step-up/options", { method: "POST" }, signal);
  expect(fetchMock.mock.calls[2]).toEqual([
    "/admin/step-up/options",
    expect.objectContaining({ method: "POST", body: '{"method":"POST"}', signal }),
  ]);
  fetchMock.mockResolvedValueOnce(json({ stepUpId: "x" }));
  await stepUp.mock.calls[0]![1].post("/admin/step-up", {});
  expect(fetchMock.mock.calls[3]![1]).not.toHaveProperty("signal");
});

test("it steps up at most once, and leaves every other refusal to the caller", async () => {
  // A retry the gateway still refuses comes back as it is.
  const fetchMock = vi.fn().mockResolvedValueOnce(required()).mockResolvedValueOnce(required());
  vi.stubGlobal("fetch", fetchMock);
  stepUp.mockResolvedValue("step-up-id");
  const signal = new AbortController().signal;
  expect((await apiFetch("/admin/tokens", { method: "POST", body: "{}", signal })).status).toBe(428);
  expect(stepUp).toHaveBeenCalledTimes(1);
  expect(stepUp.mock.calls[0]![1].signal).toBe(signal);
  for (const response of [
    json({ code: "FORBIDDEN" }, 403),
    json({ code: "STEP_UP_REQUIRED" }, 403),
    new Response("not json", { status: 428 }),
    json({ code: "OTHER" }, 428),
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect((await apiFetch("/admin/tokens", { method: "POST", body: "{}" })).status).toBe(
      response.status,
    );
  }
  // Reads and other origins are never stepped up.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(required()));
  expect((await apiFetch("/admin/tokens")).status).toBe(428);
  expect((await apiFetch("https://elsewhere.example/x", { method: "POST" })).status).toBe(428);
  expect(stepUp).toHaveBeenCalledTimes(1);
});

test("while no step-up can start, the caller gets an error a person can act on", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(json({ error: "x", code: "STEP_UP_UNAVAILABLE" }, 403)),
  );
  await expect(apiFetch("/admin/devices/pair", { method: "POST", body: "{}" })).rejects.toMatchObject({
    message:
      "Face ID can't be used on this gateway right now. Make this change on the computer running Omnesis.",
    stepUp: true,
  });
  // During a certificate incident the gateway says so, and so does the page.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      json({ error: "x", code: "STEP_UP_UNAVAILABLE", detail: { reason: "security-lock" } }, 403),
    ),
  );
  await expect(apiFetch("/admin/devices/pair", { method: "POST", body: "{}" })).rejects.toThrow(
    "Security lock is on. This change can only be made on the computer running Omnesis right now.",
  );
  expect(stepUp).not.toHaveBeenCalled();
  expect(confirmStepUp).not.toHaveBeenCalled();
});

test("an unannounced step-up first says why Face ID is coming; cancelling it changes nothing", async () => {
  const fetchMock = vi.fn().mockResolvedValue(required());
  vi.stubGlobal("fetch", fetchMock);
  confirmStepUp.mockResolvedValueOnce(false);
  const signal = new AbortController().signal;
  await expect(
    apiFetch("/admin/devices/pair", { method: "POST", body: "{}", signal }),
  ).rejects.toMatchObject({ message: "Nothing changed.", stepUp: true });
  expect(confirmStepUp).toHaveBeenCalledExactlyOnceWith({ signal });
  expect(stepUp).not.toHaveBeenCalled();
  // The request was not sent again.
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("a button that already named Face ID goes straight to the passkey, and the flag never reaches the gateway", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(required())
    .mockResolvedValueOnce(json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  stepUp.mockResolvedValue("step-up-id");
  const response = await apiFetch("/admin/devices/pair", {
    method: "POST",
    body: "{}",
    stepUpAnnounced: true,
  });
  expect(response.status).toBe(200);
  expect(confirmStepUp).not.toHaveBeenCalled();
  for (const [, init] of fetchMock.mock.calls) expect(init).not.toHaveProperty("stepUpAnnounced");
  expect(fetchMock.mock.calls[1]![1].headers).toMatchObject({ "X-Omnesis-Step-Up": "step-up-id" });
});

test("a passkey the gateway refuses is said in the owner's words, and every step-up failure is shown as it is", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(required());
  vi.stubGlobal("fetch", fetchMock);
  // Run the real exchange: options, then the assertion the gateway refuses.
  stepUp.mockImplementationOnce(async (_detail, { post }) => {
    expect((await post("/admin/step-up/options", {})).status).toBe(200);
    await post("/admin/step-up", {});
  });
  fetchMock
    .mockResolvedValueOnce(json({ challenge: "c" }))
    .mockResolvedValueOnce(json({ error: "x", code: "STEP_UP_REFUSED" }, 403));
  await expect(apiFetch("/admin/tokens", { method: "POST", body: "{}" })).rejects.toMatchObject({
    message: "That passkey can't approve changes here. Use the passkey you set up for this gateway.",
    stepUp: true,
  });
  // A prompt closed by the person keeps its own message, marked for the page to show.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(required()));
  stepUp.mockRejectedValueOnce(new GatewayPasskeyError("The passkey prompt was closed."));
  await expect(apiFetch("/admin/tokens", { method: "POST", body: "{}" })).rejects.toMatchObject({
    message: "The passkey prompt was closed.",
    stepUp: true,
  });
  // Anything else passes through untouched.
  const network = new TypeError("Failed to fetch");
  stepUp.mockRejectedValueOnce(network);
  await expect(apiFetch("/admin/tokens", { method: "POST", body: "{}" })).rejects.toBe(network);
  expect(network).not.toHaveProperty("stepUp");
});

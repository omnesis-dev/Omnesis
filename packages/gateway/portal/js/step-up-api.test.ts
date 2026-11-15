// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const stepUp = vi.hoisted(() => vi.fn());
vi.mock("./lib/gateway-passkey.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  stepUp,
}));
// @ts-expect-error — portal is plain JS without sibling declarations.
import { apiFetch } from "./api.js";

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

beforeEach(() => stepUp.mockReset());
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
  await expect(apiFetch("/admin/devices/pair", { method: "POST", body: "{}" })).rejects.toThrow(
    "Do it on the gateway itself.",
  );
  expect(stepUp).not.toHaveBeenCalled();
});

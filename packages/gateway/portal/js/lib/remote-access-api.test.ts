// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("../api.js", () => api);

import {
  checkPublicAddress,
  getHostTailscale,
  getRemoteAccess,
  publishHostTailscale,
  updateRemoteAccess,
  // @ts-expect-error — portal modules are plain JS.
} from "./remote-access-api.js";

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
beforeEach(() => api.apiFetch.mockReset());

test("each call reaches its route with its body", async () => {
  api.apiFetch.mockResolvedValue(json(200, { ok: true }));
  await getRemoteAccess();
  await updateRemoteAccess({ setupCompleted: true });
  await checkPublicAddress("https://omnesis.example.org");
  await getHostTailscale();
  await publishHostTailscale(true);
  expect(api.apiFetch.mock.calls.map(([path, init]) => [path, init.method, init.body])).toEqual([
    ["/admin/remote-access", "GET", undefined],
    ["/admin/remote-access", "PATCH", JSON.stringify({ setupCompleted: true })],
    ["/admin/remote-access/check-address", "POST", JSON.stringify({ url: "https://omnesis.example.org" })],
    ["/admin/remote-access/host-tailscale", "GET", undefined],
    ["/admin/remote-access/host-tailscale/publish", "POST", JSON.stringify({ public: true })],
  ]);
  expect(api.apiFetch.mock.calls.every(([, init]) => init.cache === "no-store")).toBe(true);
});

test("a refusal carries the gateway's own sentence, the field's first, and its status and code", async () => {
  api.apiFetch.mockResolvedValue(
    json(400, { code: "VALIDATION", error: "Validation failed", detail: [{ message: "The address must start with https://." }] }),
  );
  await expect(checkPublicAddress("http://x.example")).rejects.toMatchObject({
    status: 400,
    code: "VALIDATION",
    serverMessage: "The address must start with https://.",
    message: "Remote access request failed (400).",
  });
  api.apiFetch.mockResolvedValue(json(404, { error: "Not found" }));
  await expect(getHostTailscale()).rejects.toMatchObject({ status: 404, serverMessage: "Not found" });
  api.apiFetch.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error("html"); } });
  const error = await getRemoteAccess().catch((cause: Error) => cause);
  expect(error).toMatchObject({ status: 502 });
  expect(error.serverMessage).toBeUndefined();
});

test("a signal is passed on when given", async () => {
  api.apiFetch.mockResolvedValue(json(200, {}));
  const signal = new AbortController().signal;
  await getRemoteAccess(signal);
  expect(api.apiFetch.mock.calls[0][1].signal).toBe(signal);
});

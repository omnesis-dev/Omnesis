// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
const apiFetch = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock("../api.js", () => ({ apiFetch }));
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { cloudPairingConfig, cloudPairingRequests, decideCloudPairing } from "./cloud-pairing-api.js";
afterEach(() => { vi.unstubAllGlobals(); apiFetch.mockReset(); });
test("optional configuration handles absence and refuses non-success responses", async () => {
  const transport = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", transport);
  transport.mockResolvedValueOnce(new Response("missing", { status: 404 }));
  expect(await cloudPairingConfig()).toBeNull();
  transport.mockResolvedValueOnce(new Response("private backend detail", { status: 500 }));
  await expect(cloudPairingConfig()).rejects.toThrow("Google sign-in is unavailable");
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ clientId: "fictional-client", webSignIn: true })));
  expect(await cloudPairingConfig()).toEqual({ clientId: "fictional-client", webSignIn: true });
  expect(transport).toHaveBeenLastCalledWith("/devices/google/config", { credentials: "same-origin", cache: "no-store" });
});
test("approval reads and decisions use the shared cookie and CSRF-aware API boundary", async () => {
  apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })));
  expect(await cloudPairingRequests()).toEqual({ items: [] });
  expect(apiFetch).toHaveBeenLastCalledWith("/admin/cloud-pairing/requests", { cache: "no-store" });
  apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
  expect(await decideCloudPairing("fictional-request", false)).toEqual({ ok: true });
  expect(apiFetch).toHaveBeenLastCalledWith("/admin/cloud-pairing/decision", {
    method: "POST", body: JSON.stringify({ requestId: "fictional-request", approve: false }),
  });
  apiFetch.mockResolvedValueOnce(new Response("private backend detail", { status: 503 }));
  await expect(cloudPairingRequests()).rejects.toThrow("Couldn't load device pairing requests");
  apiFetch.mockResolvedValueOnce(new Response("private backend detail", { status: 409 }));
  await expect(decideCloudPairing("fictional-request", true)).rejects.toThrow("It may have expired");
});

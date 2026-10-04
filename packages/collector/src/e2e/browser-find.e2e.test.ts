// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildWebPageDocument, pair, type FetchLike } from "@omnesis/extension";
import { loginPortal, type PortalSession } from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const nodeFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    ...init,
    body: init.method === "GET" ? undefined : init.body,
  });
  return {
    status: response.status,
    headers: { get: (name) => response.headers.get(name) },
    text: () => response.text(),
  };
};

interface Credential {
  token: string;
  tokenId: string;
  deviceId: string;
  scopes: string[];
}

describe("Browser Find owner-approved standard read (spawned gateway)", () => {
  let harness: SyntheticE2EHarness;
  let portal: PortalSession;
  let browser: { token: string; device: { id: string }; scopes: string[] };
  let sibling: typeof browser;
  let credential: Credential;
  const requestId = randomUUID();
  const pageUrl = "https://example.org/orbit-workshop";
  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      embedderBackend: "fake",
    });
    await harness.start();
    portal = await loginPortal({ gatewayUrl: harness.gatewayUrl, apiKey: harness.apiKey });
    async function pairBrowser(name: string) {
      const minted = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({ kind: "browser", name }),
      });
      return pair(harness.gatewayUrl, minted.pairingCode, nodeFetch, name);
    }
    browser = await pairBrowser("Find browser");
    sibling = await pairBrowser("Other browser");
  }, 180_000);
  afterAll(async () => {
    await harness?.destroy();
  }, 30_000);
  function request(path: string, token: string, body?: unknown, method?: string) {
    return fetch(`${harness.gatewayUrl}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  test("negotiates Find without changing the legacy capture grant", async () => {
    expect(await (await fetch(`${harness.gatewayUrl}/health`)).json()).toMatchObject({
      capabilities: { browserFind: { min: 1, max: 1 } },
    });
    expect(browser.scopes).toEqual(["write:web"]);
    expect((await request("/search", browser.token, { text: "orbit", limit: 25 })).status).toBe(
      403,
    );
    expect((await request("/browser/find", browser.token)).status).toBe(403);
  });
  test("only the logged-in owner approves a separate read credential for this browser", async () => {
    const created = await request("/browser/find/authorization", browser.token, { id: requestId });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      approvalPath: `/portal/browser-find?request=${requestId}`,
    });
    expect((await request(`/browser/find/authorization/${requestId}`, sibling.token)).status).toBe(
      404,
    );
    expect(
      (await request(`/admin/browser-find/authorizations/${requestId}/approve`, harness.apiKey, {}))
        .status,
    ).toBe(403);
    const approve = (csrf: string) =>
      fetch(`${harness.gatewayUrl}/admin/browser-find/authorizations/${requestId}/approve`, {
        method: "POST",
        headers: { Cookie: portal.cookie, "X-Omnesis-CSRF": csrf },
      });
    expect((await approve("invalid")).status).toBe(403);
    expect((await approve(portal.csrfToken)).status).toBe(200);
    const approved = await request(`/browser/find/authorization/${requestId}`, browser.token);
    const grant = (await approved.json()) as { credential: Credential };
    credential = grant.credential;
    expect(credential.scopes).toEqual(["read"]);
    expect(credential.deviceId).toBe(browser.device.id);
    expect(await (await request("/browser/find", credential.token)).json()).toMatchObject({
      enabled: true,
      canonicalizers: expect.any(Array),
    });
  });
  test("the read credential searches real indexed pages and retains ordinary corpus read authority", async () => {
    const text = "Orbit workshop describes an invented method for assembling a small telescope.";
    const page = await buildWebPageDocument({
      normalizedUrl: pageUrl,
      title: "Orbit workshop",
      text,
      contentHash: createHash("sha256").update(text).digest("hex"),
      visitedAt: new Date().toISOString(),
      browserProfile: { deviceId: browser.device.id, label: "Find browser" },
    });
    expect((await request("/documents", browser.token, { documents: [page] })).status).toBe(200);
    await expect
      .poll(
        async () => {
          await harness.refreshSearchSnapshot();
          const result = await request("/search", credential.token, {
            text: "Orbit workshop",
            limit: 200,
          });
          expect(result.status).toBe(200);
          return ((await result.json()) as { results: Array<{ sourceUrl?: string }> }).results.some(
            (hit) => hit.sourceUrl === pageUrl,
          );
        },
        { timeout: 120_000, interval: 500 },
      )
      .toBe(true);
    const streamed = await request("/browser/find/search", credential.token, {
      text: "Orbit workshop",
      limit: 50,
      timeZone: "UTC",
    });
    expect(streamed.status).toBe(200);
    const events = (await streamed.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; payload: unknown });
    expect(events).toContainEqual({
      type: "find.decision",
      payload: expect.objectContaining({ mode: "direct", status: "not_configured" }),
    });
    expect(events).toContainEqual({
      type: "find.results",
      payload: expect.objectContaining({
        results: expect.arrayContaining([expect.objectContaining({ sourceUrl: pageUrl })]),
        complete: true,
      }),
    });
    expect(events.at(-1)).toEqual({ type: "find.complete", payload: { mode: "direct" } });
    expect(
      (
        await request("/browser/find/search", credential.token, {
          text: "orbit",
          timeZone: "Invented/Zone",
        })
      ).status,
    ).toBe(400);
    expect((await request("/browser/find/search", browser.token, { text: "orbit" })).status).toBe(
      403,
    );
    // Web-only display does not narrow the approved read credential's authority.
    expect((await request("/documents/search?q=Orbit", credential.token)).status).toBe(200);
    expect((await request("/notes", credential.token)).status).toBe(200);
    expect((await request("/documents", credential.token, { documents: [] })).status).toBe(403);
    expect((await request("/notes", credential.token, { text: "Forbidden write" })).status).toBe(
      403,
    );
    expect(
      (
        await request("/browser/notes", credential.token, {
          version: 1,
          id: randomUUID(),
          text: "Forbidden note",
          page: { url: pageUrl },
        })
      ).status,
    ).toBe(403);
    expect((await request("/admin/devices", credential.token)).status).toBe(403);
    const tokens = await harness.gatewayJson<{ items: Array<{ id: string; scopes: string[] }> }>(
      `/admin/tokens`,
    );
    expect(tokens.items.find((token) => token.id === credential.tokenId)?.scopes).toEqual(["read"]);
  }, 150_000);
  test("revoking Find leaves capture working and invalidates approved request replay", async () => {
    await harness.gatewayJson(`/admin/tokens/${credential.tokenId}`, { method: "DELETE" });
    expect((await request("/search", credential.token, { text: "orbit" })).status).toBe(401);
    expect((await request("/documents", browser.token, { documents: [] })).status).toBe(200);
    expect(
      await (await request(`/browser/find/authorization/${requestId}`, browser.token)).json(),
    ).toEqual({ status: "revoked" });
    const replay = await fetch(
      `${harness.gatewayUrl}/admin/browser-find/authorizations/${requestId}/approve`,
      {
        method: "POST",
        headers: { Cookie: portal.cookie, "X-Omnesis-CSRF": portal.csrfToken },
      },
    );
    expect(replay.status).toBe(404);
  });
});

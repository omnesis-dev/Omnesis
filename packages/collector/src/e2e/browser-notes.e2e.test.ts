// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
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

interface Note {
  id: string;
  day: string;
  text: string;
  surface: string;
  deviceId: string;
}

interface Credential {
  token: string;
  tokenId: string;
  deviceId: string;
  scopes: string[];
}

describe("Browser notes permissions and page attachment (spawned gateway)", () => {
  let harness: SyntheticE2EHarness;
  let portal: PortalSession;
  let browser: { token: string; device: { id: string }; scopes: string[] };
  let sibling: typeof browser;
  let credential: Credential;
  const requestId = randomUUID();
  const noteId = randomUUID();
  const pageUrl = "https://example.org/observatory-logbook";
  const payload = {
    version: 1,
    id: noteId,
    text: "Compare this observation method with the fictional ridge survey.",
    page: {
      url: pageUrl,
      title: "Observatory logbook",
      selection: "An invented passage about measuring distant lights.",
    },
  };

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "e2e-minimal",
      extraGatewayConfig: {
        gateway: {
          backfill: {
            links: { interval: "1s", idleDelay: "1s" },
            linkReconcile: { interval: "1s" },
          },
        },
      },
    });
    await harness.start();
    portal = await loginPortal({
      gatewayUrl: harness.gatewayUrl,
      apiKey: harness.apiKey,
    });
    async function pairBrowser(name: string) {
      const minted = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({ kind: "browser", name }),
      });
      return pair(harness.gatewayUrl, minted.pairingCode, nodeFetch, name);
    }
    browser = await pairBrowser("Notes browser");
    sibling = await pairBrowser("Separate browser");
  }, 180_000);

  afterAll(async () => {
    await harness?.destroy();
  }, 30_000);

  function browserFetch(path: string, token: string, body?: unknown, method?: string) {
    return fetch(`${harness.gatewayUrl}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function approvalFetch(csrf = portal.csrfToken) {
    return fetch(`${harness.gatewayUrl}/admin/browser-notes/authorizations/${requestId}/approve`, {
      method: "POST",
      headers: { Cookie: portal.cookie, "X-Omnesis-CSRF": csrf },
    });
  }

  function linkTarget(): { target_doc_id: string | null } | undefined {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<[string], { target_doc_id: string | null }>(
          `SELECT l.target_doc_id FROM document_links l
           JOIN documents d ON d.id = l.source_doc_id
           WHERE d.source_id = 'omnesis-notes' AND l.link_type = 'url'
             AND l.normalized_target = ?`,
        )
        .get(pageUrl);
    } finally {
      db.close();
    }
  }

  test("advertises a versioned notes contract while preserving exact legacy browser grants", async () => {
    const health = await fetch(`${harness.gatewayUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      capabilities: { browserNotes: { min: 1, max: 1 } },
    });
    expect(browser.scopes).toEqual(["write:web"]);
    expect(sibling.scopes).toEqual(["write:web"]);
    expect((await browserFetch("/documents", browser.token, { documents: [] })).status).toBe(200);
    expect((await browserFetch("/browser/notes", browser.token, payload)).status).toBe(403);
  });

  test("only the owning browser can poll, and owner portal approval requires CSRF", async () => {
    const requested = await browserFetch("/browser/notes/authorization", browser.token, {
      id: requestId,
    });
    expect(requested.status).toBe(201);
    expect(await requested.json()).toMatchObject({ requestId });
    const pending = await browserFetch(`/browser/notes/authorization/${requestId}`, browser.token);
    expect(await pending.json()).toMatchObject({ status: "pending" });
    const wrongBrowser = await browserFetch(
      `/browser/notes/authorization/${requestId}`,
      sibling.token,
    );
    expect([403, 404]).toContain(wrongBrowser.status);
    const bearerApproval = await browserFetch(
      `/admin/browser-notes/authorizations/${requestId}/approve`,
      harness.apiKey,
      undefined,
      "POST",
    );
    expect(bearerApproval.status).toBe(403);
    expect((await approvalFetch("invalid-csrf")).status).toBe(403);
    expect((await approvalFetch()).status).toBe(200);
    const approved = await browserFetch(`/browser/notes/authorization/${requestId}`, browser.token);
    const result = (await approved.json()) as { status: string; credential: Credential };
    expect(result.status).toBe("approved");
    credential = result.credential;
    expect(credential.scopes).toEqual(["notes:create"]);
    expect(credential.deviceId).toBe(browser.device.id);
    expect(credential.token).not.toBe(browser.token);
  });

  test("create-only credentials cannot read, edit, delete, write pages, or request another grant", async () => {
    for (const [path, method, body] of [
      ["/notes", "GET", undefined],
      [`/notes/${noteId}`, "PATCH", { text: "Forbidden modification" }],
      [`/notes/${noteId}`, "DELETE", undefined],
      ["/notes", "POST", { text: "Must use the browser contract" }],
      ["/documents", "POST", { documents: [] }],
      ["/browser/notes/authorization", "POST", { id: randomUUID() }],
    ] as const) {
      const response = await browserFetch(path, credential.token, body, method);
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    const unsupported = await browserFetch("/browser/notes", credential.token, {
      ...payload,
      version: 2,
    });
    expect(unsupported.status).toBe(400);
    const invalidPage = await browserFetch("/browser/notes", credential.token, {
      ...payload,
      page: { url: "javascript:alert(1)" },
    });
    expect(invalidPage.status).toBe(400);
  });

  test("notes persist in capture history, retry once, and retain a URL edge before page capture", async () => {
    const first = await browserFetch("/browser/notes", credential.token, payload);
    expect(first.status).toBe(201);
    const note = (await first.json()) as Note;
    expect(note).toMatchObject({
      id: noteId,
      surface: "chrome-extension",
      deviceId: browser.device.id,
    });
    expect(note.text).toContain(payload.text);
    expect(note.text).toContain(pageUrl);
    expect(note.text).toContain(payload.page.selection);
    const replay = await browserFetch("/browser/notes", credential.token, payload);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(note);
    const entries = await harness.gatewayJson<{ entries: Note[] }>(`/notes?day=${note.day}`);
    expect(entries.entries.filter((entry) => entry.id === noteId)).toHaveLength(1);
    const changed = await browserFetch("/browser/notes", credential.token, {
      ...payload,
      text: "This retry must never replace the saved thought.",
    });
    expect(changed.status).toBe(409);
    try {
      await expect
        .poll(linkTarget, { timeout: 45_000, interval: 250 })
        .toEqual({ target_doc_id: null });
    } catch (error) {
      const db = new Database(harness.getDbPath(), { readonly: true });
      try {
        const documents = db.prepare("SELECT source_id, content, metadata FROM documents").all();
        const links = db.prepare("SELECT * FROM document_links").all();
        throw new Error(
          `Attached page edge missing: ${JSON.stringify({ documents, links })}\n${readFileSync(harness.getGatewayLogPath(), "utf8")}`,
          { cause: error },
        );
      } finally {
        db.close();
      }
    }

    const pageText = "A fictional observatory logbook with a method for measuring distant lights.";
    const page = await buildWebPageDocument({
      normalizedUrl: pageUrl,
      title: payload.page.title,
      text: pageText,
      contentHash: createHash("sha256").update(pageText).digest("hex"),
      visitedAt: new Date().toISOString(),
      browserProfile: { deviceId: browser.device.id, label: "Notes browser" },
    });
    const captured = await browserFetch("/documents", browser.token, { documents: [page] });
    expect(captured.status).toBe(200);
    await expect
      .poll(() => linkTarget()?.target_doc_id, { timeout: 45_000, interval: 250 })
      .toBeTruthy();
  }, 100_000);

  test("revoking only the notes credential leaves legacy page capture authorized", async () => {
    await harness.gatewayJson(`/admin/tokens/${credential.tokenId}`, { method: "DELETE" });
    expect(
      (await browserFetch("/browser/notes", credential.token, { ...payload, id: randomUUID() }))
        .status,
    ).toBe(401);
    expect((await browserFetch("/documents", browser.token, { documents: [] })).status).toBe(200);
    const polled = await browserFetch(`/browser/notes/authorization/${requestId}`, browser.token);
    expect(await polled.json()).toMatchObject({ status: "revoked" });
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { SyncError } from "@omnesis/types";
import { normalizeBaseUrl, PAPERLESS_API_VERSION, PaperlessClient } from "./client.js";
import { FAKE_BASE_URL, FAKE_TOKEN, FakePaperless } from "./fake-paperless.js";

function client(fake = new FakePaperless(), token = FAKE_TOKEN) {
  return { fake, client: new PaperlessClient(FAKE_BASE_URL, token, { fetchImpl: fake.fetch }) };
}

async function failure(promise: Promise<unknown>): Promise<SyncError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SyncError);
  return err as SyncError;
}

describe("normalizeBaseUrl", () => {
  test.each([
    ["http://paperless.local:8000", "http://paperless.local:8000"],
    ["http://paperless.local:8000/", "http://paperless.local:8000"],
    ["https://nas.example.com/paperless/", "https://nas.example.com/paperless"],
    ["https://nas.example.com/paperless/api/", "https://nas.example.com/paperless"],
    ["  https://paperless.example.org  ", "https://paperless.example.org"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  test.each([
    "paperless.local",
    "ftp://paperless.local",
    "http://user:pw@host",
    "https://host/?x=1",
    "",
  ])("refuses %s", (input) => {
    expect(normalizeBaseUrl(input)).toBeUndefined();
  });
});

describe("PaperlessClient", () => {
  test("sends the token and pins the API version", async () => {
    const seen: Headers[] = [];
    const fake = new FakePaperless();
    const c = new PaperlessClient(FAKE_BASE_URL, FAKE_TOKEN, {
      fetchImpl: (input, init) => {
        seen.push(new Headers(init?.headers));
        return fake.fetch(input, init);
      },
    });
    await c.whoami();
    expect(seen[0]!.get("authorization")).toBe(`Token ${FAKE_TOKEN}`);
    expect(seen[0]!.get("accept")).toBe(`application/json; version=${PAPERLESS_API_VERSION}`);
  });

  test("names the user the token belongs to", async () => {
    const { fake, client: c } = client();
    fake.username = "jamie";
    await expect(c.whoami()).resolves.toEqual({ id: 3, username: "jamie" });
  });

  test("builds the web UI address of a document", () => {
    const c = new PaperlessClient("https://nas.example.com/paperless", FAKE_TOKEN);
    expect(c.documentUrl(42)).toBe("https://nas.example.com/paperless/documents/42/details");
  });

  test("lists ids by id keyset across pages, trimmed to id and modified", async () => {
    const fake = new FakePaperless();
    const c = new PaperlessClient(FAKE_BASE_URL, FAKE_TOKEN, {
      fetchImpl: fake.fetch,
      listingPageSize: 2,
    });
    for (const id of [1, 2, 3, 4, 5]) fake.addDocument({ id });
    const listing = await c.listDocuments({});
    expect(listing.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(Object.keys(listing[0]!).sort()).toEqual(["id", "modified"]);
    // Each page continues past the last id seen, never by page number.
    expect(fake.requests.map((r) => new URLSearchParams(r.split("?")[1]).get("id__gt"))).toEqual([
      "0",
      "2",
      "4",
    ]);
    expect(fake.requests.every((r) => !r.includes("page="))).toBe(true);
  });

  test("a snapshot listing carries each document's custom fields", async () => {
    const { fake, client: c } = client();
    fake.addDocument({ id: 1, custom_fields: [{ field: 30, value: "EUR1.00" }] });
    const listing = await c.listDocuments({ withCustomFields: true });
    expect(listing[0]!.custom_fields).toEqual([{ field: 30, value: "EUR1.00" }]);
  });

  test("refuses a listing whose ids do not move past the last one seen", async () => {
    const c = new PaperlessClient(FAKE_BASE_URL, FAKE_TOKEN, {
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ count: 1, next: null, previous: null, results: [{ id: 0 }] }),
          ),
        ),
    });
    const err = await failure(c.listDocuments({}));
    expect(err.message).toMatch(/invalid document listing/);
  });

  test("a document fetch asks for its owner", async () => {
    const { fake, client: c } = client();
    fake.addDocument({ id: 1, owner: 3 });
    const [doc] = await c.getDocuments([1]);
    expect(doc!.owner).toBe(3);
  });

  test("reads every page of a lookup table", async () => {
    const { fake, client: c } = client();
    for (let id = 1; id <= 1_205; id++) fake.tags.set(id, { id, name: `Tag ${id}` });
    const lookups = await c.lookups();
    expect(lookups.tags.size).toBe(1_205);
    expect(lookups.tags.get(1_205)).toBe("Tag 1205");
  });

  test("a rejected token is an auth failure for the whole connection", async () => {
    const { client: c } = client(new FakePaperless(), "wrong-token");
    const err = await failure(c.whoami());
    expect(err.kind).toBe("auth");
    expect(err.scope).toBe("connection");
  });

  test("a forbidden read is a permission failure naming what to grant", async () => {
    const { fake, client: c } = client();
    fake.failNext = { match: "/api/tags/", status: 403 };
    const err = await failure(c.lookups());
    expect(err.kind).toBe("permission");
    expect(err.message).toMatch(/permission to view/);
  });

  test("a missing endpoint points at the address", async () => {
    const { fake, client: c } = client();
    fake.failNext = { match: "/api/ui_settings/", status: 404 };
    const err = await failure(c.whoami());
    expect(err.message).toMatch(/Check the address/);
  });

  test("an API version the server does not serve says which side to update", async () => {
    const { fake, client: c } = client();
    fake.failNext = { match: "/api/ui_settings/", status: 406 };
    const err = await failure(c.whoami());
    expect(err.message).toMatch(/does not serve API version 9/);
    expect(err.remediation?.steps.join(" ")).toMatch(/older than 2\.16.*update Omnesis/);
  });

  test("a refused permission names the grant to make", async () => {
    const { fake, client: c } = client();
    fake.failNext = { match: "/api/tags/", status: 403 };
    const err = await failure(c.lookups());
    expect(err.kind).toBe("permission");
    expect(err.remediation?.steps[0]).toMatch(/View permission/);
  });

  test("a proxy's rate limit carries its Retry-After", async () => {
    const c = new PaperlessClient(FAKE_BASE_URL, FAKE_TOKEN, {
      fetchImpl: () =>
        Promise.resolve(
          new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
        ),
    });
    const err = await failure(c.whoami());
    expect(err.kind).toBe("rate-limit");
    expect(err.retryAfterMs).toBe(7_000);
  });

  test("a server error is transient", async () => {
    const { fake, client: c } = client();
    fake.failNext = { match: "/api/ui_settings/", status: 503 };
    expect((await failure(c.whoami())).kind).toBe("transient");
  });

  test("an unreachable host is a network failure", async () => {
    const c = new PaperlessClient(FAKE_BASE_URL, FAKE_TOKEN, {
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
    });
    const err = await failure(c.whoami());
    expect(err.kind).toBe("network");
    expect(err.message).toContain(FAKE_BASE_URL);
  });

  test("a certificate this host cannot verify says what to change, not to wait", async () => {
    const tlsError = Object.assign(new Error("self-signed certificate"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
    const c = new PaperlessClient("https://paperless.example.com", FAKE_TOKEN, {
      fetchImpl: () => Promise.reject(new TypeError("fetch failed", { cause: tlsError })),
    });
    const err = await failure(c.whoami());
    expect(err.message).toMatch(/could not be verified \(DEPTH_ZERO_SELF_SIGNED_CERT\)/);
    expect(err.remediation?.steps[0]).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  test("an HTML page served with 200 is not mistaken for an answer", async () => {
    const c = new PaperlessClient(FAKE_BASE_URL, FAKE_TOKEN, {
      fetchImpl: () => Promise.resolve(new Response("<html>Sign in</html>", { status: 200 })),
    });
    const err = await failure(c.whoami());
    expect(err.message).toMatch(/did not answer with JSON/);
  });

  test("an abort is passed through, not reported as a network failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const c = new PaperlessClient(FAKE_BASE_URL, FAKE_TOKEN, {
      fetchImpl: (_input, init) => Promise.reject(init?.signal?.reason ?? new Error("aborted")),
    });
    const err = await c.whoami(controller.signal).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SyncError);
  });
});

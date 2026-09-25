// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import realWeb from "@omnesis/provider-web";
import { defaultScopesForDeviceKind } from "@omnesis/types";
import {
  CapturePolicyClient,
  PushClient,
  pair,
  buildWebPageDocument,
  buildPageVisit,
  PAGE_VISITS_SCHEMA,
  type FetchLike,
  type FetchLikeResponse,
  type DurableStore,
} from "@omnesis/extension";
import { judgeCaptureUrl } from "@omnesis/provider-web/capture-policy";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * Headline spawned-gateway E2E for the browser-capture push path.
 *
 * This is the true end-to-end for a push-based producer: it boots a REAL gateway
 * (SyntheticE2EHarness), mints a `browser` device + `write:web` token via the
 * REAL pairing handshake, and then drives the EXACT push module the MV3
 * extension bundles (`@omnesis/extension`) under Node — injecting Node's
 * `fetch` and an in-memory durable store — to POST `webpage` documents and
 * `page_visits` rows to the real `POST /documents` / `POST /analytics/ingest`.
 *
 * The extension pushes to the unified `web` source with
 * `documentType: "webpage"` and keys each doc on
 * `external_id = SHA256(normalizeUrl(url))`, so repeated captures of the same
 * URL collapse to one row.
 *
 * It asserts all six points the frozen Design "Testing & verification"
 * subsection spells out:
 *   (1) the `write:web` token is accepted for `web` docs and rejected
 *       for any other write;
 *   (2) a pushed page is indexed and returned by search;
 *   (3) both planes are queryable (content doc + `page_visits` row carrying
 *       `visited_at`);
 *   (4) re-pushing the same normalized URL upserts (no duplicate) and a changed
 *       text body updates the existing doc;
 *   (5) a host in the aggregated owned-domains set is refused by the capture
 *       policy the gateway serves;
 *   (6) the queue drains across simulated gateway downtime + 429/503 backoff
 *       with no loss;
 *   (7) the capture settings live on the gateway: an exclusion, a pause and a
 *       purge made through the policy client are what the gateway serves back,
 *       and a page deleted for good is named in the policy and refused on
 *       re-push, while a copy-only delete lets the page return.
 *
 * All fixtures are invented (example.com hosts, fictional titles/text) — never
 * real corpus.
 */

/** Adapt Node's global fetch to the push module's minimal `FetchLike`. */
const nodeFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.method === "GET" ? undefined : init.body,
  });
  return {
    status: res.status,
    headers: { get: (name: string) => res.headers.get(name) },
    text: () => res.text(),
  };
};

/** In-memory durable store — survives "restart" by re-instantiating the client. */
class MemStore implements DurableStore {
  readonly data = new Map<string, string>();
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.data.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

/**
 * SHA-256 hex over the same bytes the extension hashes (`TextEncoder` UTF-8) —
 * the gateway's own `computeContentHash` is byte-for-byte equal, so an
 * unchanged-text re-push is a gateway no-op (criterion 4).
 */
async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("Browser-capture push path (spawned gateway)", () => {
  let harness: SyntheticE2EHarness;
  let gatewayUrl: string;
  let webToken: string;
  let scopes: string[];
  let browserProfile: { deviceId: string; label: string };

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable" });
    await harness.start();
    gatewayUrl = harness.gatewayUrl;

    // 1. Mint a `browser` pairing code via the real admin endpoint WITHOUT
    //    naming scopes, so the gateway's own default grant for a browser device
    //    is what the extension receives — exactly what `omnesis devices pair
    //    --kind browser` and the portal do. Spelling the scopes out here would
    //    let the default drift without this suite noticing.
    const minted = (await harness.gatewayJson("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        name: "Browser extension (E2E)",
        kind: "browser",
      }),
    })) as { pairingCode: string };
    expect(minted.pairingCode, "admin pair must mint a code").toBeTruthy();

    // 2. Redeem it through the EXTENSION's own pairing handshake (the same
    //    `pair()` the options page calls) against the real public
    //    POST /devices/pair.
    const result = await pair(gatewayUrl, minted.pairingCode, nodeFetch, "Personal");
    webToken = result.token;
    scopes = result.scopes;
    browserProfile = { deviceId: result.device.id, label: "Personal" };
  }, 180000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  /** A fresh PushClient over a fresh store (the common case). */
  function newClient(store: DurableStore, fetchImpl: FetchLike = nodeFetch, backoff = {}) {
    return new PushClient({
      gatewayUrl,
      token: webToken,
      fetch: fetchImpl,
      store,
      backoff,
    });
  }

  async function sql(query: string): Promise<{ columns: string[]; rows: unknown[][] }> {
    return (await harness.gatewayJson("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql: query }),
    })) as { columns: string[]; rows: unknown[][] };
  }

  async function searchDocs(q: string): Promise<Array<{ id: string; source_id: string }>> {
    const res = (await harness.gatewayJson(
      `/documents/search?q=${encodeURIComponent(q)}&limit=200`,
    )) as { results?: Array<{ id: string; source_id: string }> };
    return res.results ?? [];
  }

  /** Total content docs attributed to the unified `web` source (single-instance). */
  async function webDocCount(): Promise<number> {
    const res = (await harness.gatewayJson("/documents/count/web")) as { count: number };
    return res.count;
  }

  test("(1) the pairing handshake yields a write:web-only token", () => {
    expect(scopes).toEqual(["write:web"]);
    // The grant came from the gateway's default for the `browser` kind (the mint
    // above names no scopes), so this also pins that default to what the
    // extension's `pair()` insists on.
    expect(scopes).toEqual(defaultScopesForDeviceKind("browser"));
  });

  test("(1) the write:web token is rejected for a non-web write", async () => {
    // Attempt a gmail-scoped write with the web token: the gateway's
    // per-source-type scope check must forbid it (403).
    const res = await fetch(`${gatewayUrl}/documents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${webToken}`,
      },
      body: JSON.stringify({
        documents: [
          {
            providerId: "gmail",
            sourceId: "gmail:someone@example.com",
            externalId: "gmail-msg-1",
            title: "Should be forbidden",
            content: "A token scoped to write:web must not write a gmail doc.",
            contentHash: await hashText("forbidden"),
            metadata: { documentType: "email" },
            sourceCreatedAt: new Date().toISOString(),
            sourceUpdatedAt: new Date().toISOString(),
          },
        ],
      }),
    });
    expect(res.status, "a non-web write must be forbidden").toBe(403);
  });

  test("(1b) probeAuth verifies a live token without writing, and flags a dead one", async () => {
    // The proactive liveness probe is what lets an IDLE extension (empty queue)
    // discover a revoked token — the passive model only ever learned that from
    // draining a real document. Prove it against the real gateway on both a live
    // and a dead token.

    // A valid token: the empty-batch probe is accepted, writes nothing, and
    // records reachability with a fresh liveness beacon. It deliberately does
    // not claim page-delivery health: an empty batch proves no page was written.
    const liveStore = new MemStore();
    const liveClient = newClient(liveStore);
    const beforeWebDocs = await webDocCount();
    const ok = await liveClient.probeAuth();
    expect(ok, "a live write:web token probes healthy").toEqual({ reachable: true, auth: "ok" });
    expect(await liveClient.getHealth()).toBeNull();
    expect(await liveClient.getConnectivity()).toMatchObject({ reachable: true });
    expect(await liveClient.getLastCheckedAt(), "the probe stamps the beacon").not.toBeNull();
    expect(await webDocCount(), "the probe writes no document").toBe(beforeWebDocs);

    // A garbage/revoked token: the gateway 401s, so the probe reports auth
    // failed and writes an unhealthy snapshot — the signal the badge/popup turn
    // into a "re-pair this browser" prompt, even with nothing queued.
    const deadClient = new PushClient({
      gatewayUrl,
      token: "omn_deadbeefdeadbeefdeadbeefdeadbeef",
      fetch: nodeFetch,
      store: new MemStore(),
    });
    const bad = await deadClient.probeAuth();
    expect(bad.reachable, "the gateway answered (401), so it's reachable").toBe(true);
    expect(bad.auth, "a revoked/unknown token probes failed").toBe("failed");
    expect(await deadClient.getHealth()).toMatchObject({ ok: false });
  });

  test("(2)+(3) a pushed page is indexed, searchable, and queryable on both planes", async () => {
    const store = new MemStore();
    const client = newClient(store);

    const url = "https://docs.example.com/guides/quasar-ledger";
    const text =
      "The Quasar Ledger reconciliation guide explains how to balance the monthly Stellar Sound ledger and resolve drift between the Northstar accounts.";
    const visitedAt = new Date().toISOString();
    const hash = await hashText(text);

    await client.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: url,
        title: "Quasar Ledger reconciliation guide",
        text,
        contentHash: hash,
        visitedAt,
        browserProfile,
      }),
    );
    await client.enqueueVisit(
      buildPageVisit({
        normalizedUrl: url,
        title: "Quasar Ledger reconciliation guide",
        visitedAt,
        dwellMs: 8200,
        browserProfile,
      }),
    );

    const result = await client.drain();
    expect(result.delivered, "both items delivered, none retained/dropped").toBe(2);
    expect(await client.queueDepth()).toBe(0);

    // Content plane: the doc exists and is attributed to the `web` source.
    const contentDocs = await searchDocs("Quasar Ledger reconciliation");
    const webDoc = contentDocs.find((d) => d.source_id.split(":")[0] === "web");
    expect(webDoc, "the captured page must be returned by search as a web doc").toBeDefined();
    const stored = (await harness.gatewayJson(`/documents/${webDoc!.id}`)) as {
      metadata: string;
    };
    const metadata = JSON.parse(stored.metadata) as { extra?: Record<string, unknown> };
    expect(metadata.extra).toMatchObject({
      browserDeviceId: browserProfile.deviceId,
      browserProfileLabel: "Personal",
    });

    // It is genuinely searchable through the full pipeline too (BM25/LIKE), not
    // just present in the table.
    await harness.refreshSearchSnapshot();
    const reSearch = await searchDocs("Stellar Sound ledger");
    expect(reSearch.some((d) => d.source_id.split(":")[0] === "web")).toBe(true);

    // Analytics plane: the page_visits row carries visited_at.
    const visits = await sql(
      `SELECT url, domain, title, visited_at, dwell_ms, browser_device_id, browser_profile_label FROM page_visits WHERE url = '${url}'`,
    );
    expect(visits.rows.length, "exactly one visit row").toBe(1);
    const row = Object.fromEntries(visits.columns.map((c, i) => [c, visits.rows[0]![i]]));
    expect(row.domain).toBe("docs.example.com");
    expect(row.visited_at, "page_visits row must carry visited_at").toBeTruthy();
    expect(Number(row.dwell_ms)).toBe(8200);
    expect(row.browser_device_id).toBe(browserProfile.deviceId);
    expect(row.browser_profile_label).toBe("Personal");
  });

  test("(3) the extension's page_visits schema matches the real provider's verbatim", () => {
    // The push module carries a browser-bundle-safe mirror of the schema (it
    // can't import @omnesis/source-sdk). It must stay byte-equal to the schema
    // the gateway registers from @omnesis/provider-web (the source that now owns
    // the page_visits plane).
    const realVisits = realWeb.analyticsSchemas?.find((s) => s.tableName === "page_visits");
    expect(realVisits).toBeDefined();
    expect(PAGE_VISITS_SCHEMA).toEqual(realVisits);
  });

  test("(3b) the push source self-registers in the sources list on first ingest", async () => {
    // A push source must surface in the sources list automatically once it
    // ingests — no manual "Add", the way Apple Health appears after the iOS
    // app pushes. Pairing only created the `browser` device; it's the first
    // ingest (in (2)+(3) above) that must register the `web` source row.
    const page = (await harness.gatewayJson("/admin/sources")) as {
      items: Array<{ id: string; type?: string }>;
    };
    const web = page.items.find((s) => s.id.split(":")[0] === "web");
    expect(web, "the web source must auto-register after a push").toBeDefined();
  });

  test("(4) re-pushing the same URL upserts; unchanged text is a no-op, changed text updates", async () => {
    // The `web` source is single-instance, so its total doc count moves by
    // exactly one when a genuinely new URL lands and by zero on any re-push of
    // a URL already captured (upsert by externalId derived from the normalized URL).
    const url = "https://blog.example.org/posts/aurora-release-notes";
    const v1 = "Aurora 1.0 release notes: initial launch of the Aurora workspace sync engine.";

    const before = await webDocCount();

    // First push of a brand-new URL → +1 doc.
    let client = newClient(new MemStore());
    await client.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: url,
        title: "Aurora release notes",
        text: v1,
        contentHash: await hashText(v1),
        visitedAt: new Date().toISOString(),
      }),
    );
    expect((await client.drain()).delivered).toBe(1);
    expect(await webDocCount(), "a new URL adds exactly one doc").toBe(before + 1);

    // Re-push identical text (a fresh client / restart over the same gateway)
    // → upsert, no new doc.
    client = newClient(new MemStore());
    await client.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: url,
        title: "Aurora release notes",
        text: v1,
        contentHash: await hashText(v1),
        visitedAt: new Date().toISOString(),
      }),
    );
    expect((await client.drain()).delivered).toBe(1);
    expect(await webDocCount(), "identical re-push must not duplicate").toBe(before + 1);

    // Push changed text for the SAME normalized URL → still one doc, updated.
    const v2 =
      "Aurora 1.1 release notes: adds conflict-free merge and a faster Aurora workspace sync engine.";
    client = newClient(new MemStore());
    await client.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: url,
        title: "Aurora release notes",
        text: v2,
        contentHash: await hashText(v2),
        visitedAt: new Date().toISOString(),
      }),
    );
    expect((await client.drain()).delivered).toBe(1);
    expect(await webDocCount(), "changed text upserts, still one doc").toBe(before + 1);

    await harness.refreshSearchSnapshot();
    const updated = await searchDocs("conflict-free merge");
    expect(
      updated.some((d) => d.source_id.split(":")[0] === "web"),
      "the updated text must be searchable on the same doc",
    ).toBe(true);
  });

  test("(5) an owned-domains host is refused by the policy the gateway serves", async () => {
    // The gateway aggregates each web-app source's `ownedWebDomains` and folds
    // the union into the capture policy a browser reads with its own token.
    const policy = await new CapturePolicyClient(gatewayUrl, webToken, nodeFetch).read();
    expect(
      policy.ownedDomains.length,
      "the gateway must serve a non-empty owned-domains set",
    ).toBeGreaterThan(0);

    const context = { gatewayHost: new URL(gatewayUrl).hostname, now: Date.now() };
    const ownedHost = policy.ownedDomains[0]!;
    expect(judgeCaptureUrl(policy, `https://${ownedHost}/some/private/page`, context)).toEqual({
      allowed: false,
      reason: "owned-domain",
    });
    expect(judgeCaptureUrl(policy, "https://longtail.example.net/post", context)).toEqual({
      allowed: true,
    });
    // The gateway's own host is refused by the browser, not by the gateway.
    expect(judgeCaptureUrl(policy, `${gatewayUrl}/portal/search`, context)).toEqual({
      allowed: false,
      reason: "gateway-host",
    });
  });

  test("(6) the queue drains across downtime + 429/503 backoff with no loss", async () => {
    const store = new MemStore();
    // Fast backoff so the test doesn't wait real seconds.
    const client = newClient(store, undefined, { baseMs: 1, maxMs: 5, factor: 2 });

    const url = "https://status.example.com/incident/aurora-degradation";
    const text =
      "Incident report: the Aurora sync engine experienced elevated latency for 12 minutes.";
    const visitedAt = new Date().toISOString();
    const docsBefore = await webDocCount();
    await client.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: url,
        title: "Aurora incident report",
        text,
        contentHash: await hashText(text),
        visitedAt,
      }),
    );
    await client.enqueueVisit(
      buildPageVisit({
        normalizedUrl: url,
        title: "Aurora incident report",
        visitedAt,
        dwellMs: 6000,
      }),
    );
    expect(await client.queueDepth(), "two items queued").toBe(2);

    // Phase A — gateway "down": every push is a network error. Nothing delivered,
    // nothing lost (items retained in the durable store).
    const downFetch: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));
    const downClient = new PushClient({
      gatewayUrl,
      token: webToken,
      fetch: downFetch,
      store,
      backoff: { baseMs: 1, maxMs: 5, factor: 2 },
    });
    const downResult = await downClient.drain();
    expect(downResult.delivered).toBe(0);
    expect(await downClient.queueDepth(), "no item lost during downtime").toBe(2);

    // Phase B — gateway returns 429 then 503 before recovering. Wrap the real
    // fetch so the first two attempts per item are throttled/unavailable.
    let throttleBudget = 2;
    const flakyFetch: FetchLike = async (u, init) => {
      if (throttleBudget > 0) {
        throttleBudget -= 1;
        const status = throttleBudget === 1 ? 429 : 503;
        const headers: Record<string, string> = status === 429 ? { "retry-after": "0" } : {};
        const resp: FetchLikeResponse = {
          status,
          headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
          text: () => Promise.resolve('{"error":"slow down"}'),
        };
        return resp;
      }
      return nodeFetch(u, init);
    };
    const flakyClient = new PushClient({
      gatewayUrl,
      token: webToken,
      fetch: flakyFetch,
      store,
      backoff: { baseMs: 1, maxMs: 5, factor: 2 },
    });

    // Drain repeatedly until the queue empties; backoff intervals are ~1-5ms.
    let guard = 0;
    while ((await flakyClient.queueDepth()) > 0 && guard < 50) {
      await flakyClient.drain();
      await new Promise((r) => setTimeout(r, 8));
      guard += 1;
    }
    expect(await flakyClient.queueDepth(), "queue must fully drain after recovery").toBe(0);

    // No loss: the doc landed (one new web doc) and the visit landed.
    expect(await webDocCount(), "the doc survived the outage").toBe(docsBefore + 1);
    const visits = await sql(`SELECT COUNT(*) AS n FROM page_visits WHERE url = '${url}'`);
    expect(Number(visits.rows[0]![0]), "the visit survived the outage").toBe(1);
  });

  test("(7) capture settings live on the gateway and every edit is what it serves back", async () => {
    const client = new CapturePolicyClient(gatewayUrl, webToken, nodeFetch);
    const before = await client.read();
    expect(before.excludedDomains).toEqual([]);
    expect(before.pause).toBeNull();

    // A page captured from a domain about to be excluded.
    const store = new MemStore();
    const push = newClient(store);
    const excludedUrl = "https://ledger.example.net/statements/2026-02";
    const keptUrl = "https://notes.example.org/reading-list";
    for (const url of [excludedUrl, keptUrl]) {
      await push.enqueueDocument(
        await buildWebPageDocument({
          normalizedUrl: url,
          title: `Invented page at ${url}`,
          text: `Invented body for ${url}, long enough to be kept by the extractor and indexed.`,
          contentHash: await hashText(url),
          visitedAt: new Date().toISOString(),
          browserProfile,
        }),
      );
    }
    expect((await push.drain()).delivered).toBe(2);
    const docsBefore = await webDocCount();

    // Excluding with a purge removes the domain's captured pages for good.
    const excluded = await client.addExcludedDomain("https://Ledger.Example.net/x", true);
    expect(excluded.purged).toBe(1);
    expect(excluded.policy.excludedDomains).toEqual(["ledger.example.net"]);
    expect(await webDocCount()).toBe(docsBefore - 1);
    const excludedId = (
      await buildWebPageDocument({
        normalizedUrl: excludedUrl,
        title: "x",
        text: "x",
        contentHash: "x",
        visitedAt: new Date().toISOString(),
        browserProfile,
      })
    ).externalId;
    expect(excluded.policy.removedPages).toContain(excludedId);

    // The pause is shared state too, and reads back with its deadline.
    const until = Date.now() + 60 * 60 * 1000;
    expect((await client.setPause(until)).pause).toEqual({ until });
    expect((await client.read()).pause).toEqual({ until });
    expect((await client.clearPause()).pause).toBeNull();

    // A second reader (another browser) sees the same settings.
    const sibling = await new CapturePolicyClient(gatewayUrl, webToken, nodeFetch).read();
    expect(sibling.excludedDomains).toEqual(["ledger.example.net"]);
    expect((await client.removeExcludedDomain("ledger.example.net")).excludedDomains).toEqual([]);

    // Deleting a page for good names it in the policy and refuses its re-push;
    // deleting a copy only lets the source bring the page back.
    const keptDoc = (await searchDocs("reading-list")).find((d) => d.source_id === "web");
    expect(keptDoc, "the kept page is searchable").toBeDefined();
    await harness.gatewayJson(`/documents/${keptDoc!.id}`, { method: "DELETE" });
    const keptId = (
      await buildWebPageDocument({
        normalizedUrl: keptUrl,
        title: "x",
        text: "x",
        contentHash: "x",
        visitedAt: new Date().toISOString(),
        browserProfile,
      })
    ).externalId;
    expect((await client.read()).removedPages).toContain(keptId);

    const retry = newClient(new MemStore());
    await retry.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: keptUrl,
        title: "Invented reading list, revisited",
        text: "The same invented reading list page, pushed again after it was deleted for good.",
        contentHash: await hashText("revisited"),
        visitedAt: new Date().toISOString(),
        browserProfile,
      }),
    );
    const result = await retry.drain();
    expect(result).toMatchObject({ delivered: 0, suppressed: 1, retained: 0, dropped: 0 });
    expect(await retry.getRecentDeliveries()).toEqual([]);
    expect(await webDocCount()).toBe(docsBefore - 2);

    // A copy-only delete of another page: it comes back on the next push.
    const returningUrl = "https://recipes.example.org/soup";
    const returning = newClient(new MemStore());
    const pushReturning = async (text: string) => {
      await returning.enqueueDocument(
        await buildWebPageDocument({
          normalizedUrl: returningUrl,
          title: "Invented soup recipe",
          text,
          contentHash: await hashText(text),
          visitedAt: new Date().toISOString(),
          browserProfile,
        }),
      );
      return returning.drain();
    };
    expect(
      (await pushReturning("An invented soup recipe with enough words to index.")).delivered,
    ).toBe(1);
    const returningDoc = (await searchDocs("soup recipe")).find((d) => d.source_id === "web");
    expect(returningDoc).toBeDefined();
    await harness.gatewayJson(`/documents/${returningDoc!.id}?tombstone=0`, { method: "DELETE" });
    expect((await client.read()).removedPages).not.toContain(returningDoc!.id);
    expect(
      (await pushReturning("The invented soup recipe, captured again after a copy-only delete."))
        .delivered,
    ).toBe(1);
    expect((await searchDocs("soup recipe")).some((d) => d.source_id === "web")).toBe(true);
  });
});

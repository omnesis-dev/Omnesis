// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { FindService, findSnippet } from "./find-service.js";
import type { ExtensionConfig } from "./storage.js";

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
function harness() {
  let stored: unknown,
    revoked = false;
  let broker: unknown = { min: 1, max: 1 };
  let experimental: unknown = true;
  let capability: unknown = { min: 1, max: 1 };
  let config: ExtensionConfig | null = {
    gatewayUrl: "https://gateway.example.org",
    deviceId: "11111111-1111-4111-8111-111111111111",
    token: "web-token",
    scopes: ["write:web"],
    pairedAt: 1,
  };
  let search: (
    body: { text: string; limit: number },
    signal?: AbortSignal | null,
  ) => Promise<Response> = async () => respond({ results: [] });
  const respond = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/health")
      return respond({
        experimental,
        capabilities: { browserFind: capability, browserFeatures: broker },
      });
    if (path === "/browser/find/enable")
      return revoked
        ? respond({}, 403)
        : respond({
            status: "approved",
            credential: {
              deviceId: config!.deviceId,
              token: "read-token",
              tokenId: "22222222-2222-4222-8222-222222222222",
              scopes: ["read"],
            },
          });
    if (revoked) return respond({}, 401);
    if (path === "/browser/find")
      return respond({
        enabled: true,
        canonicalizers: [],
        sourceLabels: {
          "source-example": "Example source",
          "example-provider": "Example provider",
        },
        sourceAttributions: { "example-provider": "Example attribution" },
      });
    if (path === "/browser/find/search") {
      const body = JSON.parse(String(init?.body));
      const response = await search(body, init?.signal);
      if (response.headers.get("content-type")?.includes("text/event-stream")) return response;
      const value = (await response.json()) as { results: unknown[] };
      return sse([
        {
          type: "find.decision",
          payload: {
            mode: "direct",
            status: "not_configured",
            reason: "Decision model not configured",
          },
        },
        {
          type: "find.results",
          payload: { ...value, complete: true, hasMore: value.results.length >= body.limit },
        },
        { type: "find.complete", payload: { mode: "direct" } },
      ]);
    }
    throw new Error(`Unexpected path ${path}`);
  });
  const deps = {
    config: async () => config,
    read: async () => structuredClone(stored),
    write: async (value: unknown) => {
      stored = structuredClone(value);
    },
    fetch,
  };
  return {
    service: new FindService(deps),
    setExperimental: (value: unknown) => {
      experimental = value;
    },
    deps,
    fetch,
    broker: (value: unknown) => {
      broker = value;
    },
    revoke: () => {
      revoked = true;
    },
    restore: () => {
      revoked = false;
    },
    capability: (value: unknown) => {
      capability = value;
    },
    unpair: () => {
      config = null;
    },
    search: (value: typeof search) => {
      search = value;
    },
    respond,
  };
}
const hit = (id: string, sourceUrl: string) => ({
  id,
  documentId: id,
  title: "Invented article",
  sourceUrl,
  chunkText: "An invented snippet",
  sourceId: "source-example",
});
async function enable(h: ReturnType<typeof harness>): Promise<void> {
  expect((await h.service.status()).enabled).toBe(true);
}

describe("Find authorization and durable results", () => {
  it("centers long snippets around matching words", () => {
    const snippet = findSnippet(
      "An introduction. ".repeat(70) + "invented match" + " trailing context".repeat(80),
      "invented",
    );
    expect(snippet).toContain("invented match");
    expect(snippet.length).toBeLessThanOrEqual(500);
    expect(snippet.startsWith("…")).toBe(true);
  });
  it.each([
    undefined,
    { min: 2, max: 3 },
    { min: 0, max: 1 },
    { min: 1.5, max: 2 },
    { min: 2, max: 1 },
  ])(
    "hides Find on absent/unsupported capability %j while capture pairing is unchanged",
    async (capability) => {
      const h = harness();
      h.capability(capability);
      expect((await h.service.status()).supported).toBe(false);
      expect((await h.service.status()).enabled).toBe(false);
      expect(h.fetch.mock.calls.every(([url]) => new URL(String(url)).pathname === "/health")).toBe(
        true,
      );
    },
  );
  it.each([undefined, { min: 2, max: 3 }, { min: 0, max: 1 }])(
    "hides Find without a compatible automatic broker %j",
    async (broker) => {
      const h = harness();
      h.broker(broker);
      expect(await h.service.status()).toMatchObject({ supported: false, enabled: false });
      expect(h.fetch.mock.calls.every(([url]) => new URL(String(url)).pathname === "/health")).toBe(
        true,
      );
    },
  );
  it("does not treat an old manual grant cache as automatic support when discovery is unavailable", async () => {
    const h = harness();
    await enable(h);
    const state = (await h.deps.read()) as Record<string, unknown>;
    delete state.automatic;
    await h.deps.write(state);
    h.fetch.mockRejectedValue(new Error("Invented network outage"));
    expect(await new FindService(h.deps).status()).toMatchObject({
      supported: false,
      enabled: false,
      results: [],
    });
  });
  it("automatically obtains and validates a device-bound read grant without opening owner approval", async () => {
    const h = harness();
    expect(await h.service.status()).toMatchObject({ enabled: true, pendingApproval: false });
    const grants = h.fetch.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === "/browser/find/enable",
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer web-token" });
    expect(JSON.parse(String(grants[0]?.[1]?.body))).toEqual({
      id: expect.stringMatching(/^[a-f0-9-]{36}$/i),
    });
    await h.service.status();
    expect(
      h.fetch.mock.calls.filter(
        ([url]) => new URL(String(url)).pathname === "/browser/find/enable",
      ),
    ).toHaveLength(1);
    expect(h.fetch.mock.calls.some(([url]) => String(url).includes("/authorization"))).toBe(false);
  });
  it("uses only read for search, filters links client-side, and preserves rank across mixed sources", async () => {
    const h = harness();
    await enable(h);
    h.search(async () =>
      h.respond({
        results: [
          hit("native", "notes://note/1"),
          hit("mail", "https://mail.example.org/message/abc"),
          hit("web", "https://example.org/guide"),
          hit("mail", "https://mail.example.org/message/abc"),
          hit("unsafe", "javascript:alert(1)"),
        ],
      }),
    );
    const view = await h.service.search("invented");
    expect(view.results.map((result) => result.documentId)).toEqual(["mail", "web"]);
    expect(view.results[0]?.source).toBe("Example source");
    const [url, init] = h.fetch.mock.calls.find(([url]) => String(url).endsWith("/search"))!;
    expect(String(url)).toContain("/search");
    expect(init?.headers).toMatchObject({ authorization: "Bearer read-token" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      text: "invented",
      limit: 25,
      timeZone: expect.any(String),
    });
    const reopened = new FindService(h.deps);
    expect(await reopened.status(false)).toMatchObject({
      query: "invented",
      resultsQuery: "invented",
      results: view.results,
    });
  });
  it("hides cached results on explicit revocation or capability downgrade", async () => {
    const h = harness();
    await enable(h);
    h.search(async () => h.respond({ results: [hit("web", "https://example.org/guide")] }));
    await h.service.search("guide");
    h.revoke();
    expect(await h.service.status()).toMatchObject({ enabled: false, results: [] });
    const other = harness();
    await enable(other);
    other.capability(undefined);
    expect(await other.service.status()).toMatchObject({ supported: false, enabled: false });
  });
  it("cancels slow A so B wins promptly, without overwriting durable edits or restoring unpaired results", async () => {
    const h = harness();
    await enable(h);
    let started = false,
      aborted = false;
    h.search(async ({ text }, signal) =>
      text === "A"
        ? new Promise<Response>((_resolve, reject) => {
            started = true;
            signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          })
        : h.respond({ results: [hit("B", "https://example.org/b")] }),
    );
    const a = h.service.search("A");
    await vi.waitFor(() => expect(started).toBe(true));
    await h.service.update("B");
    const b = await h.service.search("B");
    await a;
    expect(aborted).toBe(true);
    expect(b.results[0]?.documentId).toBe("B");
    expect(await h.service.status(false)).toMatchObject({ query: "B", resultsQuery: "B" });
    h.unpair();
    expect(await h.service.status()).toMatchObject({ enabled: false, results: [] });
  });
  it("overfetches bounded ranked results after client filtering rather than claiming pagination", async () => {
    const h = harness();
    await enable(h);
    const limits: number[] = [];
    h.search(async ({ limit }) => {
      limits.push(limit);
      return h.respond({
        results: Array.from({ length: limit }, (_, i) =>
          hit(String(i), i < 25 ? "notes://note/1" : `https://example.org/${i}`),
        ),
      });
    });
    expect(await h.service.search("guide")).toMatchObject({ hasMore: true, results: [] });
    expect((await h.service.search("guide", true)).results).toHaveLength(25);
    await h.service.search("guide", true);
    expect(await h.service.search("guide", true)).toMatchObject({ hasMore: false });
    expect(limits).toEqual([25, 50, 100, 200]);
  });
  it("uses provider type attribution without exposing account identifiers", async () => {
    const h = harness();
    await enable(h);
    h.search(async () =>
      h.respond({
        results: [{ ...hit("card", "https://example.org"), sourceId: "example-provider:account" }],
      }),
    );
    expect((await h.service.search("guide")).results[0]).toMatchObject({
      source: "Example provider",
      attribution: "Example attribution",
    });
  });
  it("deduplicates streamed agent destinations across batches and cached worker restarts", async () => {
    const h = harness();
    await enable(h);
    h.search(async () =>
      sse([
        {
          type: "find.decision",
          payload: { mode: "agentic", status: "decided", reason: "Related evidence" },
        },
        {
          type: "find.results",
          payload: {
            results: [
              hit("first", "https://example.org/guide"),
              hit("other", "https://example.org/other"),
            ],
          },
        },
        {
          type: "find.results",
          payload: {
            results: [
              hit("duplicate", "https://example.org/guide"),
              hit("last", "https://example.org/last"),
            ],
          },
        },
        { type: "find.complete", payload: { mode: "agentic" } },
      ]),
    );
    const result = await h.service.search("guide");
    expect(result.results.map((card) => card.id)).toEqual(["first", "other", "last"]);
    const cached = (await h.deps.read()) as { results: typeof result.results };
    cached.results.push({ ...cached.results[0]!, id: "legacy-duplicate" });
    await h.deps.write(cached);
    expect((await new FindService(h.deps).status(false)).results.map((card) => card.id)).toEqual([
      "first",
      "other",
      "last",
    ]);
  });
  it("keeps one strongest card per direct destination when expanding the ranked pool", async () => {
    const h = harness();
    await enable(h);
    h.search(async ({ limit }) =>
      h.respond({
        results: [
          hit("strongest", "https://example.org/guide"),
          hit("same-page-chunk", "https://example.org/guide/"),
          ...(limit > 25 ? [hit("new-page", "https://example.org/new")] : []),
        ],
      }),
    );
    expect((await h.service.search("guide")).results.map((card) => card.id)).toEqual(["strongest"]);
    expect((await h.service.search("guide", true)).results.map((card) => card.id)).toEqual([
      "strongest",
      "new-page",
    ]);
  });
  it("persists final explanation and decision, without retaining ephemeral tool cards", async () => {
    const h = harness();
    await enable(h);
    h.search(async () =>
      sse([
        {
          type: "find.decision",
          payload: { mode: "agentic", status: "decided", reason: "Related evidence needed" },
        },
        {
          type: "agent.tool.start",
          payload: { toolCallId: "tool-1", tool: "search_documents", args: {} },
        },
        { type: "agent.text.delta", payload: { delta: "Here is the invented guide." } },
        {
          type: "find.results",
          payload: { results: [hit("card", "https://example.org/guide")], complete: false },
        },
        { type: "find.complete", payload: { mode: "agentic" } },
      ]),
    );
    const completed = await h.service.search("guide");
    expect(completed).toMatchObject({
      agentText: "Here is the invented guide.",
      decision: { mode: "agentic" },
      running: false,
    });
    expect(completed.tools?.filter((part) => part.kind === "tool" && !part.tailDismissed)).toEqual(
      [],
    );
    expect(await h.deps.read()).not.toHaveProperty("tools");
    const restored = await new FindService(h.deps).status(false);
    expect(restored).toMatchObject({
      agentText: "Here is the invented guide.",
      results: [{ id: "card" }],
      interrupted: false,
    });
    expect(restored.tools ?? []).toEqual([]);
  });
  it("clears read authority immediately when a live stream reports revocation", async () => {
    const h = harness();
    await enable(h);
    h.search(async () =>
      sse([
        { type: "find.results", payload: { results: [hit("card", "https://example.org/guide")] } },
        {
          type: "find.error",
          payload: { code: "FIND_PERMISSION_REVOKED", message: "Permission revoked" },
        },
      ]),
    );
    expect(await h.service.search("guide")).toMatchObject({
      enabled: false,
      results: [],
      running: false,
    });
    expect(await new FindService(h.deps).status(false)).toMatchObject({
      enabled: false,
      results: [],
    });
    h.restore();
    await enable(h);
    const restored = await h.service.status(false);
    expect(restored).toMatchObject({
      enabled: true,
      query: "guide",
      results: [],
      resultsQuery: "",
      hasMore: false,
    });
    expect(restored.agentText).toBeUndefined();
    expect(restored.decision).toBeUndefined();
  });
  it("clears running state when local persistence fails before fetch", async () => {
    const h = harness();
    await enable(h);
    await h.service.search("guide");
    const original = h.deps.write;
    h.deps.write = async () => {
      throw new Error("Storage unavailable");
    };
    await expect(h.service.search("guide")).rejects.toThrow("Storage unavailable");
    h.deps.write = original;
    expect(await h.service.status(false)).toMatchObject({ running: false });
  });
  it("does not start a paid search when canceled during permission revalidation", async () => {
    const h = harness();
    await enable(h);
    const original = h.fetch.getMockImplementation()!;
    let release: (() => void) | undefined;
    h.fetch.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/health")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return original(input, init);
    });
    const start = h.service.search("guide");
    await vi.waitFor(() => expect(release).toBeDefined());
    const cancel = h.service.cancel();
    release!();
    await start;
    await cancel;
    expect(
      h.fetch.mock.calls.some(([url]) => new URL(String(url)).pathname === "/browser/find/search"),
    ).toBe(false);
    expect(await h.service.status(false)).toMatchObject({ running: false });
  });
  it("erases cached cards and explanation on credential revocation but retains the authored query", async () => {
    const h = harness();
    await enable(h);
    h.search(async () =>
      sse([
        { type: "agent.text.delta", payload: { delta: "Invented explanation" } },
        { type: "find.results", payload: { results: [hit("card", "https://example.org/guide")] } },
        { type: "find.complete", payload: { mode: "direct" } },
      ]),
    );
    await h.service.search("guide");
    h.revoke();
    expect(await h.service.status()).toMatchObject({
      enabled: false,
      query: "guide",
      resultsQuery: "",
      results: [],
    });
    h.restore();
    await enable(h);
    const restored = await new FindService(h.deps).status(false);
    expect(restored).toMatchObject({
      enabled: true,
      query: "guide",
      resultsQuery: "",
      results: [],
    });
    expect(restored.agentText).toBeUndefined();
  });
  it("preserves the previous local search during a network outage", async () => {
    const h = harness();
    await enable(h);
    h.search(async () => h.respond({ results: [hit("card", "https://example.org/guide")] }));
    await h.service.search("guide");
    h.fetch.mockRejectedValue(new Error("Offline"));
    expect(await h.service.status()).toMatchObject({
      enabled: true,
      query: "guide",
      results: [{ id: "card" }],
    });
    expect(await new FindService(h.deps).status(false)).toMatchObject({
      results: [{ id: "card" }],
    });
  });
  it("requires explicit experimental true alongside the Find capability", async () => {
    for (const flag of [undefined, false, null, 1, "true", {}]) {
      const h = harness();
      h.setExperimental(flag);
      expect(await h.service.status()).toMatchObject({ supported: false, enabled: false });
      expect((await h.service.status()).enabled).toBe(false);
    }
  });
  it("hides already approved Find grants and blocks paid requests while the flag is off", async () => {
    const h = harness();
    await enable(h);
    h.search(async () => h.respond({ results: [hit("card", "https://example.org/guide")] }));
    await h.service.search("guide");
    h.setExperimental(false);
    h.fetch.mockClear();
    expect(await h.service.search("another")).toMatchObject({
      supported: false,
      enabled: false,
      results: [],
    });
    expect(
      h.fetch.mock.calls.some(([url]) => new URL(String(url)).pathname === "/browser/find/search"),
    ).toBe(false);
    expect(await new FindService(h.deps).status(false)).toMatchObject({
      enabled: false,
      results: [],
    });
    h.setExperimental(true);
    expect(await h.service.status()).toMatchObject({ enabled: true });
  });
  it("does not trust a legacy cached grant during an unverified outage", async () => {
    const h = harness();
    await enable(h);
    const state = (await h.deps.read()) as Record<string, unknown>;
    delete state.experimental;
    await h.deps.write(state);
    h.fetch.mockRejectedValue(new Error("Offline"));
    expect(await new FindService(h.deps).status()).toMatchObject({
      supported: false,
      enabled: false,
    });
  });
  it("aborts a live search and hides its results when the experimental flag turns off", async () => {
    const h = harness();
    await enable(h);
    let started = false,
      aborted = false;
    h.search(
      async (_body, signal) =>
        new Promise<Response>((_resolve, reject) => {
          started = true;
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const run = h.service.search("guide");
    await vi.waitFor(() => expect(started).toBe(true));
    h.setExperimental(false);
    expect(await h.service.status()).toMatchObject({
      supported: false,
      enabled: false,
      results: [],
      running: false,
    });
    await run;
    expect(aborted).toBe(true);
    expect(await h.service.status(false)).toMatchObject({ supported: false, enabled: false });
  });
  it("closes discovery when health access is explicitly rejected", async () => {
    const h = harness();
    await enable(h);
    const original = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (input, init) =>
      String(input).endsWith("/health")
        ? new Response("{}", { status: 403 })
        : original(input, init),
    );
    expect(await h.service.status()).toMatchObject({ supported: false, enabled: false });
  });
});

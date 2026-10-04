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
    approved = false,
    revoked = false;
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
    if (path === "/status") return respond({ experimental });
    if (path === "/health") return respond({ capabilities: { browserFind: capability } });
    if (path === "/browser/find/authorization")
      return respond({
        requestId: JSON.parse(String(init?.body)).id,
        approvalPath: "/portal/browser-find?request=example",
      });
    if (path.startsWith("/browser/find/authorization/"))
      return respond(
        approved
          ? {
              status: "approved",
              credential: { deviceId: config!.deviceId, token: "read-token", scopes: ["read"] },
            }
          : { status: "pending" },
      );
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
    approve: () => {
      approved = true;
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
  await h.service.activate();
  h.approve();
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
      await expect(h.service.activate()).rejects.toThrow("unavailable");
      expect(h.fetch.mock.calls.every(([url]) => new URL(String(url)).pathname === "/health")).toBe(
        true,
      );
    },
  );
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
  it("persists final explanation and decision, without retaining ephemeral tool cards", async () => {
    const h = harness();
    await enable(h);
    h.search(async () =>
      sse([
        {
          type: "find.decision",
          payload: { mode: "agentic", status: "decided", reason: "Related evidence needed" },
        },
        { type: "agent.tool.start", payload: { toolCallId: "tool-1", tool: "search", args: {} } },
        { type: "agent.text.delta", payload: { delta: "Here is the invented guide." } },
        {
          type: "find.results",
          payload: { results: [hit("card", "https://example.org/guide")], complete: false },
        },
        { type: "find.complete", payload: { mode: "agentic" } },
      ]),
    );
    expect(await h.service.search("guide")).toMatchObject({
      agentText: "Here is the invented guide.",
      decision: { mode: "agentic" },
      running: false,
      tools: [],
    });
    expect(await new FindService(h.deps).status(false)).toMatchObject({
      agentText: "Here is the invented guide.",
      results: [{ id: "card" }],
      interrupted: false,
    });
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
      await expect(h.service.activate()).rejects.toThrow("unavailable");
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
  it("closes discovery when experimental-status access is explicitly rejected", async () => {
    const h = harness();
    await enable(h);
    const original = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (input, init) =>
      String(input).endsWith("/status")
        ? new Response("{}", { status: 403 })
        : original(input, init),
    );
    expect(await h.service.status()).toMatchObject({ supported: false, enabled: false });
  });
});

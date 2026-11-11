// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { DecisionClients } from "./decision-clients.js";
import type { ResolvedAssignment, ResolvedDecisionBackend, ResolvedTypeSafe } from "@omnesis/core";
import type { DecisionEndpointConfig } from "../registry.js";

const BACKEND: ResolvedDecisionBackend = {
  role: "decision",
  kind: "decision",
  backendKey: "box",
  preset: "ollaya",
  model: "kev",
  url: "http://127.0.0.1:9/v1/systemone",
  protocol: "systemone",
  onHost: true,
  allowRemoteInference: false,
  hasApiKey: false,
  available: true,
};
const TYPESAFE: ResolvedTypeSafe = {
  role: "decision",
  kind: "typesafe",
  model: "jev-1.13.0",
  url: "https://api.typesafe.ai/v1/systemone",
  selfHosted: false,
  onHost: false,
  allowRemoteInference: true,
  hasApiKey: false,
  available: true,
};
const VERIFY_REPLY = {
  model: "kev-20261101",
  answers: {
    verify_noul: { type: "noul", noul: 0.9 },
    verify_score: { type: "score", score: 1 },
  },
};

function clients(opts: {
  backends?: Record<string, DecisionEndpointConfig>;
  typesafeKey?: string | null;
  fetchFn?: typeof fetch;
}) {
  return new DecisionClients({
    getDecisionEndpoint: (key) => opts.backends?.[key],
    readTypeSafeApiKey: () => opts.typesafeKey ?? null,
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
}

describe("DecisionClients", () => {
  it("gives every client of one backend the same concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight -= 1;
      return Response.json(VERIFY_REPLY);
    }) as unknown as typeof fetch;
    const c = clients({
      backends: { box: { url: BACKEND.url, maxConcurrency: 2 } },
      fetchFn,
    });
    // The live model and a second client of the same backend, built separately.
    const live = c.backend(BACKEND);
    const other = c.backend(BACKEND, { maxRetries: 0 });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 ? live : other).decide({ state: "x", questions: {} }),
      ),
    );
    expect(peak).toBe(2);
    expect(c.limiter("decision:box", 2)).toBe(c.limiter("decision:box", 2));
    expect(c.limiter("decision:box", 3).max).toBe(3);
  });

  it("builds no TypeSafe client for TypeSafe's own endpoint without a key", () => {
    expect(clients({}).typesafe(TYPESAFE)).toBeNull();
    expect(clients({ typesafeKey: "ts-key" }).typesafe(TYPESAFE)).not.toBeNull();
    expect(clients({}).typesafe({ ...TYPESAFE, selfHosted: true })).not.toBeNull();
  });

  it("refuses to build a client for a backend it no longer has", () => {
    expect(() => clients({}).backend(BACKEND)).toThrow('Backend "box" has no decision API');
  });

  it("verifies an assignment, and reports one it cannot", async () => {
    const fetchFn = vi.fn(async () => Response.json(VERIFY_REPLY)) as unknown as typeof fetch;
    const c = clients({ backends: { box: { url: BACKEND.url } }, fetchFn });
    expect(await c.verify(BACKEND)).toMatchObject({ ok: true, answeredBy: "kev-20261101" });
    expect(await c.verify({ ...BACKEND, available: false, reason: "Ollaya needs a key." })).toEqual(
      { ok: false, failure: "refused", reason: "Ollaya needs a key." },
    );
    expect(await c.verify({ role: "decision", kind: "disabled" })).toMatchObject({ ok: false });
    expect(await c.verify(TYPESAFE)).toEqual({
      ok: false,
      failure: "refused",
      reason: "TypeSafe API key not configured.",
    });
  });
});

describe("DecisionClients.vetAssignment", () => {
  const refusing = vi.fn(
    async () => new Response('{"error":"model not found"}', { status: 404 }),
  ) as unknown as typeof fetch;
  const resolveTo =
    (resolved: ResolvedAssignment) =>
    (_value: string): ResolvedAssignment =>
      resolved;

  it("refuses a model the loaded backend does not have", async () => {
    const c = clients({ backends: { box: { url: BACKEND.url } }, fetchFn: refusing });
    const verdict = await c.vetAssignment("box/kevv", {
      current: "box/kev",
      resolve: resolveTo({ ...BACKEND, model: "kevv" }),
      body: { inference: { assignments: { decision: "box/kevv" } } },
    });
    expect(verdict).toMatchObject({ ok: false });
    expect((verdict as { reason: string }).reason).toContain('The server has no model "kevv"');
  });

  it("does not ask again for the assignment the config already holds", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const c = clients({ backends: { box: { url: BACKEND.url } }, fetchFn });
    expect(
      await c.vetAssignment("box/kev", {
        current: "box/kev",
        resolve: resolveTo(BACKEND),
        body: {},
      }),
    ).toEqual({ ok: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not test the old URL or key when the same write changes the backend", async () => {
    const c = clients({ backends: { box: { url: BACKEND.url } }, fetchFn: refusing });
    const body = {
      inference: {
        backends: { box: { apiKey: "sk-new" } },
        assignments: { decision: "box/kev" },
      },
    };
    expect(
      await c.vetAssignment("box/kev", { current: null, resolve: resolveTo(BACKEND), body }),
    ).toEqual({ ok: true });
    expect(refusing).not.toHaveBeenCalled();
    const typesafeBody = { inference: { typesafe: { url: "http://127.0.0.1:9/v1/systemone" } } };
    expect(
      await c.vetAssignment("typesafe/jev-1.13.0", {
        current: null,
        resolve: resolveTo(TYPESAFE),
        body: typesafeBody,
      }),
    ).toEqual({ ok: true });
  });

  it("lets through what it cannot test: a cleared role, a backend not loaded yet, an unavailable one", async () => {
    const c = clients({ fetchFn: refusing });
    expect(
      await c.vetAssignment(null, { current: "box/kev", resolve: resolveTo(BACKEND), body: {} }),
    ).toEqual({ ok: true });
    expect(
      await c.vetAssignment("new/kev", {
        current: null,
        resolve: resolveTo({
          role: "decision",
          kind: "unresolved",
          reason: 'Unknown backend "new"',
        }),
        body: {},
      }),
    ).toEqual({ ok: true });
    expect(
      await c.vetAssignment("box/kev", {
        current: null,
        resolve: resolveTo({ ...BACKEND, available: false, reason: "needs a key" }),
        body: {},
      }),
    ).toEqual({ ok: true });
  });
});

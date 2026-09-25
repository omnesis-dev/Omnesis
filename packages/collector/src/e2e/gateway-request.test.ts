// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The E2E suite's only HTTP primitive. What it does with a non-2xx decides
 * whether a failing spawned-gateway test names the gateway's answer or reports
 * a missing field on an error envelope, so the contract is pinned here rather
 * than left to whichever suite happens to hit one first.
 */

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { gatewayJson, type GatewayRequestError } from "./gateway-request.js";

const endpoint = { gatewayUrl: "https://localhost:17999", apiKey: "test-key" };

function respond(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gatewayJson", () => {
  test("returns the parsed body of a 2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond('{"window":{"timeZone":"UTC"}}'));

    await expect(gatewayJson(endpoint, "/briefs/temporal/window")).resolves.toEqual({
      window: { timeZone: "UTC" },
    });
  });

  test("sends the harness API key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(respond("{}"));

    await gatewayJson(endpoint, "/status");

    const headers = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer test-key");
  });

  test("throws on a non-2xx, naming the method, path, status and body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond('{"error":"Not found","code":"NOT_FOUND"}', { status: 404 }),
    );

    // The failure a feature-gated route produces. Handing the envelope back
    // would surface downstream as an absent field, naming neither.
    await expect(gatewayJson(endpoint, "/briefs/temporal/window?timeZone=UTC")).rejects.toThrow(
      /gateway GET \/briefs\/temporal\/window\?timeZone=UTC → 404: .*NOT_FOUND/,
    );
  });

  test("carries the status and body on the thrown error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond('{"error":"document seeds only"}', { status: 400 }),
    );

    const error = await gatewayJson(endpoint, "/graph/walk", { method: "POST" }).catch(
      (thrown: GatewayRequestError) => thrown,
    );

    expect(error.status).toBe(400);
    expect(error.body).toBe('{"error":"document seeds only"}');
    expect(error.message).toContain("gateway POST /graph/walk → 400");
  });

  test("accepts a 2xx that carries no body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    await expect(gatewayJson(endpoint, "/notes/abc", { method: "DELETE" })).resolves.toBeNull();
  });

  test("waits out the gateway's writer-queue backpressure before failing", async () => {
    // 503 + Retry-After is documented as transient and self-healing, and the
    // production gateway client honours it. A poll loop must not die on one.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        respond('{"error":"writer queue full","code":"QUEUE_FULL"}', {
          status: 503,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(respond('{"ok":true}'));

    await expect(gatewayJson(endpoint, "/documents", { method: "POST" })).resolves.toEqual({
      ok: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("gives up on unrelenting backpressure and reports it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond('{"code":"QUEUE_FULL"}', { status: 503, headers: { "Retry-After": "0" } }),
    );

    await expect(gatewayJson(endpoint, "/documents", { method: "POST" })).rejects.toThrow(
      /→ 503: .*QUEUE_FULL/,
    );
  });

  test("appends the gateway's log tail to a 5xx, whose body explains nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-gateway-request-test-"));
    const logPath = join(dir, "gateway.log");
    writeFileSync(logPath, "ERROR [gateway:http] no such table: document_temporal_projections\n");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      respond('{"error":"Internal server error","code":"INTERNAL_ERROR","requestId":"r1"}', {
        status: 500,
      }),
    );

    try {
      await expect(gatewayJson({ ...endpoint, gatewayLogPath: logPath }, "/x")).rejects.toThrow(
        /no such table: document_temporal_projections/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

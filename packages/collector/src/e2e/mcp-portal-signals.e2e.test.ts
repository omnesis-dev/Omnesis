// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { beginMcpAuthorization, loginPortal } from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

/** Frames of an open signal stream, read as they arrive. */
class SignalStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(
    body: ReadableStream<Uint8Array>,
    private readonly controller: AbortController,
  ) {
    this.reader = body.getReader();
  }

  /** The next frame that is not a liveness beat, within `timeoutMs`. */
  async next(timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end >= 0) {
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (!frame.startsWith("event: beat")) return frame;
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("No signal arrived in time.");
      const read = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("No signal arrived in time.")), left),
        ),
      ]);
      if (read.done) throw new Error("The signal stream ended.");
      this.buffer += this.decoder.decode(read.value, { stream: true });
    }
  }

  /** Whether the gateway ends the stream within `timeoutMs`, reading past any frames. */
  async endsWithin(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      const read = await Promise.race([
        this.reader.read(),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), left)),
      ]);
      if (read === "waiting") return false;
      if (read.done) return true;
    }
  }

  close(): void {
    this.controller.abort();
  }
}

describe("portal signals — spawned gateway", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "default",
      agentBackend: "replay",
      extraGatewayConfig: ({ gatewayUrl }) => ({ gateway: { publicBaseUrl: gatewayUrl } }),
    });
    await harness.start();
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  async function open(
    headers: Record<string, string> = { Authorization: `Bearer ${harness.apiKey}` },
  ): Promise<SignalStream> {
    const controller = new AbortController();
    const response = await fetch(`${harness.gatewayUrl}/portal/api/signals`, {
      headers,
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    return new SignalStream(response.body!, controller);
  }

  test("every open portal hears at once that an agent asks for access, and nothing more", async () => {
    const first = await open();
    const second = await open();
    try {
      expect(await first.next()).toBe("event: ready\ndata: {}");
      expect(await second.next()).toBe("event: ready\ndata: {}");

      const pending = await beginMcpAuthorization(harness);
      const changed = 'event: changed\ndata: {"topic":"access"}';
      expect(await first.next()).toBe(changed);
      expect(await second.next()).toBe(changed);
      // The signal names the topic only: what is waiting is read through the
      // ordinary route, which lists the request.
      const overview = await fetch(`${harness.gatewayUrl}/admin/access`, {
        headers: { Authorization: `Bearer ${harness.apiKey}` },
      });
      const body = (await overview.json()) as { pendingRequests?: unknown[] };
      expect(body.pendingRequests?.length).toBeGreaterThan(0);
      await Promise.allSettled([pending.client.close(), pending.transport.close()]);
    } finally {
      first.close();
      second.close();
    }
  });

  test("a portal session opens it as the browser does, and logging out ends it", async () => {
    const portal = await loginPortal(harness);
    const stream = await open({ Cookie: portal.cookie });
    try {
      expect(await stream.next()).toBe("event: ready\ndata: {}");
      const logout = await fetch(`${harness.gatewayUrl}/portal/api/logout`, {
        method: "POST",
        headers: { Cookie: portal.cookie, "X-Omnesis-CSRF": portal.csrfToken },
      });
      expect(logout.ok).toBe(true);
      // The next beat finds the session gone and ends the stream.
      expect(await stream.endsWithin(40_000)).toBe(true);
    } finally {
      stream.close();
    }
  }, 60_000);

  test("a stream needs an admin credential", async () => {
    const response = await fetch(`${harness.gatewayUrl}/portal/api/signals`);
    expect(response.status).toBe(401);
  });
});

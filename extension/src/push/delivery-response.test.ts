// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  parseEmptyDocumentProbe,
  parseSuccessfulDelivery,
  responseReason,
} from "./delivery-response.js";
import { jsonResponse } from "./test-fakes.js";
import type { FetchLikeResponse } from "./types.js";

function textResponse(status: number, body: string): FetchLikeResponse {
  return { status, headers: { get: () => null }, text: () => Promise.resolve(body) };
}

describe("parseSuccessfulDelivery", () => {
  it("accepts the exact success contract for each plane", async () => {
    expect(await parseSuccessfulDelivery(jsonResponse(200, { ingested: 1 }), "document")).toEqual({
      kind: "ok",
    });
    expect(
      await parseSuccessfulDelivery(jsonResponse(200, { ingested: 1, deleted: 0 }), "visit"),
    ).toEqual({ kind: "ok" });
  });

  it("recognises a page the gateway names as suppressed, and only that page", async () => {
    const body = { ingested: 0, suppressed: ["page-a"] };
    expect(await parseSuccessfulDelivery(jsonResponse(200, body), "document", "page-a")).toEqual({
      kind: "suppressed",
    });
    expect(await parseSuccessfulDelivery(jsonResponse(200, body), "document", "page-b")).toEqual({
      kind: "ok",
    });
    expect(await parseSuccessfulDelivery(jsonResponse(200, body), "document")).toEqual({
      kind: "ok",
    });
  });

  it("retries a visit acknowledgement that omits the deleted count", async () => {
    expect(await parseSuccessfulDelivery(jsonResponse(200, { ingested: 1 }), "visit")).toEqual({
      kind: "retry",
      status: 200,
      reason: "Invalid gateway success response",
    });
  });

  it("retries non-JSON and non-object bodies", async () => {
    expect(await parseSuccessfulDelivery(textResponse(200, "<html>"), "document")).toMatchObject({
      kind: "retry",
    });
    expect(await parseSuccessfulDelivery(textResponse(200, "42"), "document")).toMatchObject({
      kind: "retry",
    });
  });

  it("turns the two known rejection reasons into server state", async () => {
    for (const reason of ["paused", "removed"] as const) {
      expect(
        await parseSuccessfulDelivery(
          jsonResponse(200, { ingested: 0, rejected: [{ sourceId: "web", reason }] }),
          "document",
        ),
      ).toEqual({ kind: "rejected", state: reason, reason });
    }
  });

  it("drops an item the gateway rejects for a reason this build does not know", async () => {
    // A newer gateway may reject for reasons an older extension has never
    // heard of. That is still a verdict on this one item — it must not be
    // retried every few minutes forever as an "invalid" response.
    const outcome = await parseSuccessfulDelivery(
      jsonResponse(200, { ingested: 0, rejected: [{ sourceId: "web", reason: "tombstoned" }] }),
      "document",
    );
    expect(outcome).toEqual({
      kind: "drop",
      status: 200,
      reason: "Rejected by the gateway: tombstoned",
    });
  });

  it("still retries a rejection whose reason is malformed", async () => {
    expect(
      await parseSuccessfulDelivery(jsonResponse(200, { rejected: [{}] }), "document"),
    ).toMatchObject({ kind: "retry" });
    expect(
      await parseSuccessfulDelivery(jsonResponse(200, { rejected: [] }), "document"),
    ).toMatchObject({
      kind: "retry",
    });
  });
});

describe("parseEmptyDocumentProbe", () => {
  it("accepts only an empty ingest with no rejections", async () => {
    expect(await parseEmptyDocumentProbe(jsonResponse(200, { ingested: 0 }))).toBe(true);
    expect(await parseEmptyDocumentProbe(jsonResponse(200, { ingested: 1 }))).toBe(false);
    expect(await parseEmptyDocumentProbe(jsonResponse(200, { ingested: 0, rejected: [] }))).toBe(
      false,
    );
    expect(await parseEmptyDocumentProbe(textResponse(200, "nope"))).toBe(false);
  });
});

describe("responseReason", () => {
  it("prefers the gateway's error string and falls back to the status line", async () => {
    expect(
      await responseReason(jsonResponse(403, { error: "Forbidden: write:web required" })),
    ).toBe("Forbidden: write:web required");
    expect(await responseReason(textResponse(502, "<html>bad gateway</html>"))).toBe("HTTP 502");
    expect(await responseReason(jsonResponse(500, { error: "" }))).toBe("HTTP 500");
  });
});

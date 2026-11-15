// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  DecisionHttpError,
  DecisionTransport,
  decisionAuthHeaders,
  errorDetail,
} from "./transport.js";

describe("DecisionTransport", () => {
  const URL_ON_HOST = "http://127.0.0.1:9/v1/systemone";
  const transport = (fetchFn: typeof fetch, allowRemoteInference = false) =>
    new DecisionTransport({
      url: URL_ON_HOST,
      label: "Box",
      allowRemoteInference,
      sleep: async () => {},
      fetchFn,
    });

  it("does not retry a request the URL policy refuses", async () => {
    const fetchFn = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    await expect(
      transport(fetchFn).post("http://192.0.2.5:8000/v1/systemone", {}),
    ).rejects.toMatchObject({ name: "InferenceUrlPolicyError" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports a reply that is not JSON as the server's failure, without retrying", async () => {
    const fetchFn = vi.fn(
      async () => new Response("<html>Sign in to the network</html>"),
    ) as unknown as typeof fetch;
    const failure = await transport(fetchFn)
      .post(URL_ON_HOST, {})
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DecisionHttpError);
    expect(failure).toMatchObject({ status: 502, message: "Box reply is not JSON" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("errorDetail", () => {
  it("reads the message out of the error bodies providers send", () => {
    expect(
      errorDetail(
        JSON.stringify({
          error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" },
        }),
      ),
    ).toBe("API key not valid.");
    expect(errorDetail('{"error":"invalid key"}')).toBe("invalid key");
    expect(errorDetail('{"message":"Model is warming up"}')).toBe("Model is warming up");
  });

  it("keeps a body with no message as it was sent", () => {
    expect(errorDetail("upstream unavailable")).toBe("upstream unavailable");
    expect(errorDetail('{"error":{"code":5007}}')).toBe('{"error":{"code":5007}}');
    expect(errorDetail("")).toBe("");
  });
});

describe("decisionAuthHeaders", () => {
  it("puts the key in the header each provider reads, and sends none without a key", () => {
    expect(decisionAuthHeaders("bearer", "k")).toEqual({ authorization: "Bearer k" });
    expect(decisionAuthHeaders("api-key", "k")).toEqual({ "api-key": "k" });
    expect(decisionAuthHeaders("x-api-key", "k")).toEqual({ "x-api-key": "k" });
    expect(decisionAuthHeaders("x-goog-api-key", "k")).toEqual({ "x-goog-api-key": "k" });
    expect(decisionAuthHeaders("x-goog-api-key", undefined)).toEqual({});
  });
});

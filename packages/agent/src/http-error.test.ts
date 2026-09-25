// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  agentFailureScope,
  decodeHttpError,
  describeDecodedHttpError,
  isContextWindowHttpError,
  providerFailureDetail,
} from "./http-error.js";
import { CONTEXT_WINDOW_EXCEEDED_MESSAGE } from "./turn-outcome.js";

function errorResponse(error: Record<string, unknown>, status = 400): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "x-request-id": "req_test",
    },
  });
}

describe("HTTP model error classification", () => {
  it("surfaces a sanitized retry delay for a terminal rate limit", async () => {
    const decoded = await decodeHttpError(
      new Response("limited", { status: 429, headers: { "Retry-After": "30" } }),
    );
    expect(decoded.retryAfterMs).toBe(30_000);
    expect(decoded.publicMessage).toContain("Retry after about 30 seconds.");
    expect(providerFailureDetail(decoded)).toEqual({ status: 429 });
  });

  it.each([
    [{ code: "context_length_exceeded", message: "rejected" }, 400],
    [{ type: "context_window_exceeded", message: "rejected" }, 422],
    [{ message: "This prompt is too long for the model." }, 400],
    [{ message: "Maximum context length exceeded by this request." }, 422],
  ])("recognizes a context-window error %#", async (error, status) => {
    const decoded = await decodeHttpError(errorResponse(error, status));
    expect(decoded.contextWindowExceeded).toBe(true);
    expect(decoded.publicMessage).toBe(CONTEXT_WINDOW_EXCEEDED_MESSAGE);
  });

  it.each([
    [{ code: "rate_limit_exceeded", message: "prompt is too long" }, 429],
    [{ type: "invalid_request_error", param: "max_tokens", message: "must be positive" }, 400],
    [{ type: "invalid_request_error", message: "temperature is invalid" }, 400],
  ])("does not misclassify an unrelated failure %#", async (error, status) => {
    const decoded = await decodeHttpError(errorResponse(error, status));
    expect(decoded.contextWindowExceeded).toBe(false);
    expect(decoded.unsupportedOutputLimitField).toBeUndefined();
  });

  it("negotiates an output field only from a precise unsupported-parameter signal", async () => {
    const decoded = await decodeHttpError(
      errorResponse({
        type: "invalid_request_error",
        code: "unsupported_parameter",
        param: "max_tokens",
        message: "unsupported parameter: max_tokens",
      }),
    );
    expect(decoded.unsupportedOutputLimitField).toBe("max_tokens");
  });

  it("never exposes the upstream body through public or logged metadata", async () => {
    const secret = "private echoed prompt contents";
    const decoded = await decodeHttpError(
      errorResponse({
        type: "invalid_request_error",
        message: `request rejected: ${secret}`,
      }),
    );
    expect(decoded.publicMessage).not.toContain(secret);
    expect(describeDecodedHttpError(decoded)).not.toContain(secret);
    expect(describeDecodedHttpError(decoded)).toContain("requestId=req_test");
  });

  it("does not classify a plain-text body from message substrings alone", async () => {
    const decoded = await decodeHttpError(
      new Response("maximum context length exceeded; unsupported max_tokens", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    expect(decoded.contextWindowExceeded).toBe(false);
    expect(decoded.unsupportedOutputLimitField).toBeUndefined();
    expect(decoded.publicMessage).toBe(
      "The model provider rejected the request as malformed (HTTP 400).",
    );
  });

  it("requires a non-success status for message-only context classification", () => {
    expect(isContextWindowHttpError({ status: 200, message: "prompt is too long" })).toBe(false);
    expect(isContextWindowHttpError({ status: 200, code: "context_length_exceeded" })).toBe(true);
  });

  it("names the condition behind each status rather than restating the number", async () => {
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [401, { type: "authentication_error" }, "credentials"],
      [404, { code: "NOT_FOUND", param: "model" }, "does not have the assigned model"],
      [404, { code: "NOT_FOUND" }, "no such endpoint or model"],
      [429, { code: "rate_limit" }, "rate-limited"],
      [500, { type: "server_error" }, "failed while handling"],
    ];
    for (const [status, error, fragment] of cases) {
      const decoded = await decodeHttpError(errorResponse(error, status));
      expect(decoded.publicMessage).toContain(fragment);
    }
  });
});

describe("provider failure detail", () => {
  it("carries the disposition fields an operator needs to tell failures apart", async () => {
    const detail = providerFailureDetail(
      await decodeHttpError(
        errorResponse({ type: "invalid_request_error", code: "NOT_FOUND", param: "model" }, 404),
      ),
    );
    expect(detail).toEqual({
      status: 404,
      type: "invalid_request_error",
      code: "NOT_FOUND",
      param: "model",
      requestId: "req_test",
    });
  });

  it("drops an envelope field carrying the provider's own prose rather than punctuating it", async () => {
    // Stands in for a backend echoing the submitted prompt back inside its own
    // error envelope — the prompt carries the user's corpus.
    const echoedPrompt = "when did the quarterly review get rescheduled to";
    const decoded = await decodeHttpError(
      errorResponse(
        {
          type: `rejected: ${echoedPrompt}`,
          code: echoedPrompt,
          param: echoedPrompt,
          message: echoedPrompt,
        },
        400,
      ),
    );
    const detail = providerFailureDetail(decoded);
    expect(detail).toEqual({ status: 400, requestId: "req_test" });
    expect(JSON.stringify(detail)).not.toContain("quarterly");
    // The same rule governs the journal, so a laundered prompt cannot reach it
    // through a field the UI refuses.
    expect(describeDecodedHttpError(decoded)).not.toContain("quarterly");
  });

  it("keeps a field that is an identifier, punctuation and all", async () => {
    const detail = providerFailureDetail(
      await decodeHttpError(errorResponse({ code: "model_not_found:v1/chat-completions" }, 404)),
    );
    expect(detail.code).toBe("model_not_found:v1/chat-completions");
  });

  it("omits fields the provider did not report rather than inventing placeholders", async () => {
    const detail = providerFailureDetail(
      await decodeHttpError(
        new Response("", { status: 503, headers: { "Content-Type": "text/plain" } }),
      ),
    );
    expect(detail).toEqual({ status: 503 });
  });
});

describe("a server that will not take a thinking budget", () => {
  it("recognises the rejection so the turn can be re-issued without the field", async () => {
    // The wording one such server actually answers with.
    // It is not in the unsupported/unknown/unrecognized family the output-limit
    // detector matches, which is why it gets its own case rather than a shared
    // one.
    const decoded = await decodeHttpError(
      errorResponse({
        message: "Extra inputs are not permitted, field: 'thinking'",
        type: "invalid_request_error",
      }),
    );
    expect(decoded.unsupportedThinkingField).toBe(true);
  });

  it.each([
    ["unknown parameter 'thinking'"],
    ["Unsupported field: thinking"],
    ["unrecognized request field `thinking`"],
  ])("recognises the OpenAI-style wordings too: %s", async (message) => {
    expect((await decodeHttpError(errorResponse({ message }))).unsupportedThinkingField).toBe(true);
  });

  it("does NOT read a complaint about the budget's value as the field being absent", async () => {
    // The discriminating case. This server DOES take the field — it is telling
    // us the number is too small. Withdrawing the field here would give up a
    // bound the server supports, and it would do so permanently, because the
    // flag is monotonic.
    const decoded = await decodeHttpError(
      errorResponse({
        message: "thinking.budget_tokens must be >= 1024",
        type: "invalid_request_error",
      }),
    );
    expect(decoded.unsupportedThinkingField).toBeUndefined();
  });

  it("reads a structured rejection that names the field as its parameter", async () => {
    // The branch a message regex never reaches: servers that report the
    // offending field in `param` and the kind in `type`, with no prose to
    // match on.
    const decoded = await decodeHttpError(
      errorResponse({
        type: "invalid_request_error",
        code: "unknown_parameter",
        param: "thinking",
      }),
    );
    expect(decoded.unsupportedThinkingField).toBe(true);
  });

  it("does not read a value complaint carrying the field as its parameter", async () => {
    const decoded = await decodeHttpError(
      errorResponse({
        type: "invalid_request_error",
        code: "value_out_of_range",
        param: "thinking",
      }),
    );
    expect(decoded.unsupportedThinkingField).toBeUndefined();
  });

  it("ignores the wording on a status that is not a request-shape complaint", async () => {
    // A 503 body mentioning the field is capacity, not a contract.
    const decoded = await decodeHttpError(errorResponse({ message: "unknown thinking" }, 503));
    expect(decoded.unsupportedThinkingField).toBeUndefined();
  });
});

describe("agentFailureScope", () => {
  const at = (status: number) => agentFailureScope({ code: "http_error", provider: { status } });

  it("an exhausted account is the environment, not the document", () => {
    // The failure this whole classification exists for: a provider answering
    // every call with "no credit" is a billing state a human has to clear, and
    // a caller that consumes its input on failure would destroy one datum per
    // call for as long as it lasted.
    expect(at(402)).toBe("provider"); // payment required
    expect(at(412)).toBe("provider"); // Fireworks' out-of-credit
  });

  it("credentials, quota and outages are the environment", () => {
    for (const status of [401, 403, 404, 408, 429, 500, 502, 503, 504]) {
      expect(at(status)).toBe("provider");
    }
  });

  it("only payload-shaped statuses blame the request", () => {
    expect(at(400)).toBe("request");
    expect(at(413)).toBe("request");
    expect(at(422)).toBe("request");
  });

  it("a too-long prompt blames the request whatever the status", () => {
    // Providers signal it as 400, as 422, or inside a 200 stream, so the code
    // is the only reliable discriminator.
    expect(agentFailureScope({ code: "context_window_exceeded" })).toBe("request");
    expect(agentFailureScope({ code: "context_window_exceeded", provider: { status: 200 } })).toBe(
      "request",
    );
  });

  it("a model that answered blames the request, not the backend", () => {
    // Hitting the output ceiling or our tool-iteration cap means the model was
    // reached and served — the opposite of the environment fault the
    // `provider` scope names. Both arrive with no provider status at all.
    expect(agentFailureScope({ code: "output_truncated" })).toBe("request");
    expect(agentFailureScope({ code: "tool_iteration_cap" })).toBe("request");
  });

  it("a failure that never reached a status is the environment", () => {
    // A dead socket or a deadline means nothing about the payload was ever
    // adjudicated, so blaming the payload would be a guess.
    expect(agentFailureScope({ code: "http_stream_error" })).toBe("provider");
    expect(agentFailureScope({ code: "http_request_timeout" })).toBe("provider");
    expect(agentFailureScope({})).toBe("provider");
  });

  it("an unrecognised status defaults to the environment", () => {
    // The asymmetry that sets the default: mistaking an outage for a request
    // failure discards work permanently; the reverse only costs retries.
    expect(at(418)).toBe("provider");
    expect(at(599)).toBe("provider");
  });
});

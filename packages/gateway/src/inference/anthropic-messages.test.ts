// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  AnthropicTemperature,
  NO_THINKING,
  samplingClient,
  withTemperature,
} from "./anthropic-messages.js";

const request = {
  model: "example-model",
  max_tokens: 16,
  thinking: NO_THINKING,
  messages: [{ role: "user" as const, content: "hello" }],
};

describe("withTemperature", () => {
  it("adds the sampling temperature to the request body", () => {
    expect(withTemperature(request, 0.3)).toEqual({ ...request, temperature: 0.3 });
  });

  it("keeps a zero temperature", () => {
    expect(withTemperature(request, 0)).toMatchObject({ temperature: 0 });
  });

  it("returns the request untouched when there is no temperature", () => {
    expect(withTemperature(request, undefined)).toBe(request);
  });
});

describe("a temperature through the real SDK client", () => {
  /** A client whose requests are recorded and answered by `reply`. */
  function recordingClient(reply: (body: Record<string, unknown>) => Response) {
    const sent: { version: string | null; body: Record<string, unknown> }[] = [];
    const client = samplingClient({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push({ version: new Headers(init?.headers).get("anthropic-version"), body });
        return reply(body);
      },
    });
    return { client, sent };
  }

  const answer = () =>
    Response.json({
      id: "msg_example",
      type: "message",
      role: "assistant",
      model: "example-model",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });

  it("is sent on the API version that accepts it", async () => {
    const { client, sent } = recordingClient(answer);

    await client.messages.create(withTemperature(request, 0));

    expect(sent).toEqual([
      { version: "2023-06-01", body: expect.objectContaining({ temperature: 0 }) },
    ]);
  });

  it("is dropped after a model refuses it", async () => {
    const { client, sent } = recordingClient((body) =>
      "temperature" in body
        ? Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "`temperature` is deprecated for this model.",
              },
            },
            { status: 400 },
          )
        : answer(),
    );
    const sampling = new AnthropicTemperature();
    const call = () =>
      sampling.send(0, (temperature) =>
        client.messages.create(withTemperature(request, temperature)),
      );

    await call();
    await call();

    expect(sent.map(({ body }) => body.temperature)).toEqual([0, undefined, undefined]);
  });
});

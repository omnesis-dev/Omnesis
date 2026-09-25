// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The model boundary.
 *
 * Nothing here reaches the network: the HTTP client takes its `fetch` as an
 * option, so the request it builds and the response it reads can both be
 * checked without one. What is worth checking is exactly the part a live run
 * would hide — that the credential is configured and never logged, that usage
 * is read from whichever field the provider chose to report it in, and that a
 * scripted model refuses to invent an answer it was not given.
 */

import { describe, expect, it, vi } from "vitest";

import {
  MODEL_ENV,
  OpenAiCompatibleModel,
  ScriptedModel,
  addUsage,
  modelFromEnv,
} from "./model.js";
import type { ChatMessage } from "./model.js";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hello" }];

describe("the scripted model", () => {
  it("answers in order and remembers what it was asked", async () => {
    const model = new ScriptedModel(["first", "second"]);
    expect((await model.complete(MESSAGES)).text).toBe("first");
    expect((await model.complete(MESSAGES)).text).toBe("second");
    expect(model.calls).toHaveLength(2);
  });

  it("records each call as it stood, not as the conversation ended", async () => {
    // The caller appends to one array between turns. Storing the reference
    // would make every recorded call look like the last one, and a test
    // checking what the model was told on turn two would silently pass.
    const conversation: ChatMessage[] = [{ role: "user", content: "one" }];
    const model = new ScriptedModel(["a", "b"]);
    await model.complete(conversation);
    conversation.push({ role: "user", content: "two" });
    await model.complete(conversation);

    expect(model.calls[0]).toHaveLength(1);
    expect(model.calls[1]).toHaveLength(2);
  });

  it("throws rather than inventing one more answer", async () => {
    // A loop that asks one more question than the test scripted has taken a
    // path the test does not describe. Returning an empty string would let
    // that pass as a parse failure.
    const model = new ScriptedModel(["only one"]);
    await model.complete(MESSAGES);
    expect(() => model.complete(MESSAGES)).toThrow(/exhausted/);
  });

  it("reports replies it was given and never asked for", async () => {
    const model = new ScriptedModel(["a", "b", "c"]);
    await model.complete(MESSAGES);
    expect(model.unused).toBe(2);
  });
});

describe("configuring the live model", () => {
  const complete = {
    [MODEL_ENV.baseUrl]: "https://models.example.com",
    [MODEL_ENV.apiKey]: "not-a-real-key",
    [MODEL_ENV.model]: "some-model",
  };

  it("names every variable that is missing", () => {
    expect(() => modelFromEnv({})).toThrow(new RegExp(Object.values(MODEL_ENV).join(".*"), "s"));
  });

  it("names only the one that is missing", () => {
    const { [MODEL_ENV.apiKey]: _omitted, ...rest } = complete;
    expect(() => modelFromEnv(rest)).toThrow(new RegExp(MODEL_ENV.apiKey));
    expect(() => modelFromEnv(rest)).not.toThrow(new RegExp(MODEL_ENV.baseUrl));
  });

  it("has no fallback endpoint and no default credential", () => {
    // A default would mean a run that believed it was configured and was
    // quietly talking to something else.
    expect(() => modelFromEnv({ [MODEL_ENV.model]: "some-model" })).toThrow();
    expect(modelFromEnv(complete).name).toBe("some-model");
  });
});

describe("the chat-completions client", () => {
  function stub(body: unknown, ok = true) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok,
        status: ok ? 200 : 500,
        statusText: ok ? "OK" : "upstream failure",
        json: () => Promise.resolve(body),
      } as Response);
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetchImpl };
  }

  function model(fetchImpl: typeof globalThis.fetch): OpenAiCompatibleModel {
    return new OpenAiCompatibleModel({
      baseUrl: "https://models.example.com/v1/",
      apiKey: "not-a-real-key",
      model: "some-model",
      fetchImpl,
    });
  }

  it("posts the messages to the completions path, trailing slash or not", async () => {
    const { calls, fetchImpl } = stub({ choices: [{ message: { content: "hi" } }] });
    await model(fetchImpl).complete(MESSAGES);

    expect(calls[0]!.url).toBe("https://models.example.com/v1/chat/completions");
    const body = JSON.parse(calls[0]!.init.body as string) as { messages: unknown; model: string };
    expect(body.messages).toEqual(MESSAGES);
    expect(body.model).toBe("some-model");
  });

  it("reads usage from the provider's cache fields", async () => {
    const { fetchImpl } = stub({
      choices: [{ message: { content: "hi" } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 20,
        prompt_cache_hit_tokens: 900,
      },
    });
    expect((await model(fetchImpl).complete(MESSAGES)).usage).toEqual({
      promptTokens: 1000,
      cachedPromptTokens: 900,
      completionTokens: 20,
    });
  });

  it("falls back to the other spelling of cached tokens", async () => {
    // Providers are only promised to be OpenAI-*compatible*, and the two
    // spellings are both in the wild. Missing the cache count would make a run
    // look uncached and its cost estimate wrong.
    const { fetchImpl } = stub({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 400 } },
    });
    expect((await model(fetchImpl).complete(MESSAGES)).usage.cachedPromptTokens).toBe(400);
  });

  it("degrades a missing usage block to zeros rather than throwing", async () => {
    const { fetchImpl } = stub({ choices: [{ message: { content: "hi" } }] });
    const reply = await model(fetchImpl).complete(MESSAGES);
    expect(reply.text).toBe("hi");
    expect(reply.usage).toEqual({ promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 });
  });

  it("returns empty text when the provider sent none, rather than failing the run", async () => {
    // Reasoning models can spend their whole completion budget before writing
    // anything. That is a parse failure the loop can feed back, not a crash.
    const { fetchImpl } = stub({ choices: [{ message: {} }] });
    expect((await model(fetchImpl).complete(MESSAGES)).text).toBe("");
  });

  it("sends the token ceiling and temperature it defaults to", async () => {
    // A ceiling sized for the answer alone truncates a reasoning model mid-JSON
    // and the loop reads it as a parse failure — a bug that looks like the
    // model refusing to write valid output.
    const { calls, fetchImpl } = stub({ choices: [{ message: { content: "hi" } }] });
    await model(fetchImpl).complete(MESSAGES);
    const body = JSON.parse(calls[0]!.init.body as string) as {
      max_tokens: number;
      temperature: number;
    };
    expect(body.max_tokens).toBeGreaterThanOrEqual(32_768);
    expect(body.temperature).toBe(0);
  });

  it("says so when a 200 carries something that is not JSON", async () => {
    // A proxy interstitial or an error page from something in front of the
    // model is a transport failure, not an unreadable answer, and a syntax
    // error from a parser the caller never invoked says neither.
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      } as unknown as Response)) as unknown as typeof globalThis.fetch;
    await expect(model(fetchImpl).complete(MESSAGES)).rejects.toThrow(/body that is not JSON/);
  });

  it("refuses a reply whose content is not a string", async () => {
    // Some providers answer with an array of content parts. Cast rather than
    // parsed, that array would travel onwards typed as a string.
    const { fetchImpl } = stub({ choices: [{ message: { content: [{ text: "hi" }] } }] });
    await expect(model(fetchImpl).complete(MESSAGES)).rejects.toThrow();
  });

  it("keeps the credential out of anything that enumerates it", () => {
    // `private` is a compile-time promise. A harness logging what it ran
    // against would write out an own property holding the key.
    const built = model((() =>
      Promise.reject(new Error("unused"))) as unknown as typeof globalThis.fetch);
    expect(JSON.stringify(built)).not.toContain("not-a-real-key");
    expect(Object.values(built).join(" ")).not.toContain("not-a-real-key");
  });

  it("gives up on a request that never answers", async () => {
    // Without this a sweep of hundreds of sequential turns sits forever on one
    // of them, which from the outside is indistinguishable from a dead machine.
    const hung = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof globalThis.fetch;

    const impatient = new OpenAiCompatibleModel({
      baseUrl: "https://models.example.com",
      apiKey: "not-a-real-key",
      model: "some-model",
      timeoutMs: 20,
      fetchImpl: hung,
    });
    await expect(impatient.complete(MESSAGES)).rejects.toThrow(/gave up after 20ms/);
  });

  it("gives up on a body that stalls after the headers arrive", async () => {
    // `fetch` resolves when the headers land. A deadline cleared at that point
    // leaves the body unguarded — and 200-then-silence is the ordinary shape of
    // a hung streaming endpoint, so this is the case most likely to happen.
    const stalling = ((_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      } as unknown as Response)) as unknown as typeof globalThis.fetch;

    const impatient = new OpenAiCompatibleModel({
      baseUrl: "https://models.example.com",
      apiKey: "not-a-real-key",
      model: "some-model",
      timeoutMs: 20,
      fetchImpl: stalling,
    });
    await expect(impatient.complete(MESSAGES)).rejects.toThrow(/gave up after 20ms/);
  });

  it("clears its timer, so a finished run does not hold the process open", async () => {
    // Asserted rather than described: deleting the `finally` left every other
    // test in this file green.
    vi.useFakeTimers();
    try {
      const { fetchImpl } = stub({ choices: [{ message: { content: "hi" } }] });
      await model(fetchImpl).complete(MESSAGES);
      expect(vi.getTimerCount(), "the deadline timer outlived the request").toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the socket rather than only abandoning the promise", async () => {
    // The signal has to reach `fetch`, or the request keeps running and the
    // provider keeps billing for it.
    let signalled = false;
    const hung = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          signalled = true;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof globalThis.fetch;

    const impatient = new OpenAiCompatibleModel({
      baseUrl: "https://models.example.com",
      apiKey: "not-a-real-key",
      model: "some-model",
      timeoutMs: 20,
      fetchImpl: hung,
    });
    await expect(impatient.complete(MESSAGES)).rejects.toThrow();
    expect(signalled, "the abort never reached fetch").toBe(true);
  });

  it("does not report a real failure as a timeout", async () => {
    const refused = (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof globalThis.fetch;
    const model = new OpenAiCompatibleModel({
      baseUrl: "https://models.example.com",
      apiKey: "not-a-real-key",
      model: "some-model",
      fetchImpl: refused,
    });
    await expect(model.complete(MESSAGES)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("reports a failure by status alone, never by echoing the request", async () => {
    // The request carries the credential in a header. Anything that quoted the
    // exchange back into an error message would put it in a log.
    const { fetchImpl } = stub({ error: "not-a-real-key is invalid" }, false);
    await expect(model(fetchImpl).complete(MESSAGES)).rejects.toThrow(/500 upstream failure/);
    await expect(model(fetchImpl).complete(MESSAGES)).rejects.not.toThrow(/not-a-real-key/);
  });
});

describe("accumulating usage", () => {
  it("adds each field", () => {
    expect(
      addUsage(
        { promptTokens: 1, cachedPromptTokens: 2, completionTokens: 3 },
        { promptTokens: 10, cachedPromptTokens: 20, completionTokens: 30 },
      ),
    ).toEqual({ promptTokens: 11, cachedPromptTokens: 22, completionTokens: 33 });
  });
});

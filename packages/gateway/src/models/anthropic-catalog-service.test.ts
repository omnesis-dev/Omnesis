// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  AnthropicCatalogService,
  mapAnthropicModels,
  type AnthropicModelsClient,
} from "./anthropic-catalog-service.js";

function model(
  id: string,
  displayName = id,
  opts: {
    context?: number | null;
    output?: number | null;
    adaptive?: boolean;
    capabilities?: boolean;
  } = {},
) {
  return {
    id,
    display_name: displayName,
    max_input_tokens: opts.context === undefined ? 200_000 : opts.context,
    max_tokens: opts.output === undefined ? 64_000 : opts.output,
    capabilities:
      opts.capabilities === false
        ? null
        : {
            thinking: {
              types: {
                adaptive: { supported: opts.adaptive ?? false },
              },
            },
          },
  };
}

function clientFrom(
  iterable: () => AsyncIterable<ReturnType<typeof model>>,
): AnthropicModelsClient {
  return {
    models: {
      list: vi.fn(() => iterable()),
    },
  };
}

async function* records(...items: ReturnType<typeof model>[]) {
  await Promise.resolve();
  yield* items;
}

function anthropicIds(service: AnthropicCatalogService): string[] {
  return service
    .catalog()
    .filter((entry) => entry.kind === "anthropic-api")
    .map((entry) => entry.id);
}

describe("mapAnthropicModels", () => {
  it("maps every returned model in order with capabilities and removes invalid duplicates", () => {
    const entries = mapAnthropicModels([
      model("claude-sonnet-5", "Claude Sonnet 5", { context: 1_000_000, adaptive: true }),
      model("claude-fable-5", "Claude Fable 5", {
        context: null,
        output: null,
        capabilities: false,
      }),
      model(" claude-sonnet-5 ", "Duplicate"),
      model("   ", "Blank"),
    ]);

    expect(entries).toEqual([
      {
        kind: "anthropic-api",
        id: "anthropic/claude-sonnet-5",
        apiModelId: "claude-sonnet-5",
        name: "Claude Sonnet 5 (Anthropic API)",
        roles: ["agent"],
        author: "Anthropic",
        license: "Anthropic Commercial Terms",
        description:
          "Cloud model reported by the Anthropic Models API. Requires an Anthropic API key and permission for remote inference.",
        contextLength: 1_000_000,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 64_000,
        adaptiveThinking: true,
      },
      {
        kind: "anthropic-api",
        id: "anthropic/claude-fable-5",
        apiModelId: "claude-fable-5",
        name: "Claude Fable 5 (Anthropic API)",
        roles: ["agent"],
        author: "Anthropic",
        license: "Anthropic Commercial Terms",
        description:
          "Cloud model reported by the Anthropic Models API. Requires an Anthropic API key and permission for remote inference.",
      },
    ]);
  });
});

describe("AnthropicCatalogService", () => {
  it("uses the bundled fallback and makes no request without a key", async () => {
    const createClient = vi.fn();
    const service = new AnthropicCatalogService({
      readApiKey: () => null,
      createClient,
      refreshIntervalMs: 0,
    });

    expect(await service.refresh()).toBeUndefined();
    expect(createClient).not.toHaveBeenCalled();
    expect(anthropicIds(service)).toEqual([
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("publishes the complete paginated response as the authoritative live catalog", async () => {
    const client = clientFrom(() =>
      records(
        model("claude-opus-5", "Claude Opus 5", { adaptive: true }),
        model("claude-sonnet-5", "Claude Sonnet 5", { adaptive: true }),
        model("claude-fable-5", "Claude Fable 5", { adaptive: true }),
      ),
    );
    const service = new AnthropicCatalogService({
      readApiKey: () => "test-key",
      createClient: () => client,
      refreshIntervalMs: 0,
    });

    await expect(service.refresh()).resolves.toMatchObject({
      type: "anthropic",
      status: "ok",
      hasApiKey: true,
      models: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"],
    });
    expect(anthropicIds(service)).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-fable-5",
    ]);
  });

  it("reports whether the effective credential comes from the environment or file", async () => {
    const service = new AnthropicCatalogService({
      readApiKey: () => "test-key",
      credentialSource: () => "environment",
      createClient: () => clientFrom(() => records(model("claude-sonnet-5"))),
      refreshIntervalMs: 0,
    });

    await expect(service.refresh()).resolves.toMatchObject({
      status: "ok",
      credentialSource: "environment",
    });
  });

  it("does not publish a partial or empty response", async () => {
    const partialClient = clientFrom(async function* () {
      await Promise.resolve();
      yield model("claude-sonnet-5");
      throw new Error("page two failed");
    });
    const emptyClient = clientFrom(() => records());
    const clients = [partialClient, emptyClient];
    const service = new AnthropicCatalogService({
      readApiKey: () => "test-key",
      createClient: () => clients.shift()!,
      refreshIntervalMs: 0,
    });

    await expect(service.refresh()).resolves.toMatchObject({
      status: "reachable",
      reason: "page two failed",
    });
    expect(anthropicIds(service)).toEqual([
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-sonnet-4-6",
    ]);

    await expect(service.refresh()).resolves.toMatchObject({
      status: "reachable",
      reason: "Anthropic returned an empty model list",
    });
    expect(anthropicIds(service)).toEqual([
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("retains last-known-good entries after a same-key transient failure", async () => {
    const clients = [
      clientFrom(() => records(model("claude-sonnet-5"))),
      clientFrom(async function* () {
        await Promise.resolve();
        yield* [];
        throw new Error("temporary outage");
      }),
    ];
    const service = new AnthropicCatalogService({
      readApiKey: () => "same-key",
      createClient: () => clients.shift()!,
      refreshIntervalMs: 0,
    });

    await service.refresh();
    await expect(service.refresh()).resolves.toMatchObject({
      status: "unreachable",
      models: ["claude-sonnet-5"],
    });
    expect(anthropicIds(service)).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("retains metadata for an assigned model removed from the authoritative picker list", async () => {
    const clients = [
      clientFrom(() =>
        records(model("claude-specialized", "Claude Specialized", { output: 4_096 })),
      ),
      clientFrom(() => records(model("claude-current"))),
    ];
    const service = new AnthropicCatalogService({
      readApiKey: () => "same-key",
      createClient: () => clients.shift()!,
      refreshIntervalMs: 0,
    });

    await service.refresh();
    await service.refresh();

    expect(anthropicIds(service)).toEqual(["anthropic/claude-current"]);
    expect(service.getCatalogEntry("anthropic/claude-specialized")).toMatchObject({
      kind: "anthropic-api",
      maxOutputTokens: 4_096,
    });
  });

  it("distinguishes a responding API failure from auth or transport failure", async () => {
    const httpFailure = Object.assign(new Error("server error"), { status: 500 });
    const authFailure = Object.assign(new Error("unauthorized"), { status: 401 });
    const clients = [
      clientFrom(async function* () {
        await Promise.resolve();
        yield* [];
        throw httpFailure;
      }),
      clientFrom(async function* () {
        await Promise.resolve();
        yield* [];
        throw authFailure;
      }),
    ];
    const service = new AnthropicCatalogService({
      readApiKey: () => "test-key",
      createClient: () => clients.shift()!,
      refreshIntervalMs: 0,
    });

    await expect(service.refresh()).resolves.toMatchObject({
      status: "reachable",
      reason: "Anthropic Models API returned HTTP 500",
    });
    await expect(service.refresh()).resolves.toMatchObject({
      status: "unreachable",
      reason: "Anthropic rejected the API key",
    });
  });

  it("drops old-key live entries immediately when the key changes or clears", async () => {
    let key: string | null = "key-a";
    const service = new AnthropicCatalogService({
      readApiKey: () => key,
      createClient: () => clientFrom(() => records(model("claude-sonnet-5"))),
      refreshIntervalMs: 0,
    });

    await service.refresh();
    expect(anthropicIds(service)).toEqual(["anthropic/claude-sonnet-5"]);

    key = "key-b";
    const changing = service.refresh();
    expect(service.status()).toMatchObject({ status: "probing", hasApiKey: true });
    await changing;

    key = null;
    await service.refresh();
    expect(service.status()).toBeUndefined();
    expect(anthropicIds(service)).toEqual([
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("coalesces concurrent refreshes for the same key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = clientFrom(async function* () {
      await gate;
      yield model("claude-sonnet-5");
    });
    const createClient = vi.fn(() => client);
    const service = new AnthropicCatalogService({
      readApiKey: () => "same-key",
      createClient,
      refreshIntervalMs: 0,
    });

    const first = service.refresh();
    const second = service.refresh();
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("prevents a slow old-key response from overwriting the current key", async () => {
    let key = "key-a";
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const service = new AnthropicCatalogService({
      readApiKey: () => key,
      createClient: (apiKey) =>
        clientFrom(async function* () {
          await (apiKey === "key-a" ? gateA : gateB);
          yield model(apiKey === "key-a" ? "claude-old" : "claude-new");
        }),
      refreshIntervalMs: 0,
    });

    const oldRefresh = service.refresh();
    key = "key-b";
    const newRefresh = service.refresh();
    releaseB();
    await newRefresh;
    releaseA();
    await oldRefresh;

    expect(anthropicIds(service)).toEqual(["anthropic/claude-new"]);
    expect(service.status()).toMatchObject({ status: "ok", models: ["claude-new"] });
  });

  it("aborts an in-flight request when the credential changes", async () => {
    let key = "key-a";
    let oldSignal: AbortSignal | undefined;
    const oldClient: AnthropicModelsClient = {
      models: {
        list(_params, options) {
          oldSignal = options?.signal;
          return (async function* () {
            await new Promise<void>((_resolve, reject) => {
              oldSignal?.addEventListener(
                "abort",
                () => reject(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            });
            yield model("never-published");
          })();
        },
      },
    };
    const newClient = clientFrom(() => records(model("claude-new")));
    const service = new AnthropicCatalogService({
      readApiKey: () => key,
      createClient: (apiKey) => (apiKey === "key-a" ? oldClient : newClient),
      refreshIntervalMs: 0,
    });

    const oldRefresh = service.refresh();
    await Promise.resolve();
    key = "key-b";
    await service.refresh();
    await oldRefresh;

    expect(oldSignal?.aborted).toBe(true);
    expect(anthropicIds(service)).toEqual(["anthropic/claude-new"]);
  });
});

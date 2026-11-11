// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDecisionCassetteEntry,
  type DecisionCapability,
  type DecisionRequest,
  type ResolvedAssignment,
} from "@omnesis/core";
import { DecisionService } from "./decision-service.js";
import { HttpChatDecision } from "./http-chat-decision.js";
import { ReplayDecision } from "./replay-decision.js";
import { TypeSafeDecision } from "./typesafe-client.js";

const request: DecisionRequest = {
  state: {
    subject: "Dentist reminder",
    from: "Clinic <front@example.org>",
    body: "Tuesday 10:00.",
  },
  questions: { worth_score: { type: "score", instructions: "?", criteria: ["a", "b", "c", "d"] } },
};

const typesafe = (
  over: Partial<Extract<ResolvedAssignment, { kind: "typesafe" }>> = {},
): ResolvedAssignment => ({
  role: "decision",
  kind: "typesafe",
  model: "jev-1.13.0",
  url: "http://127.0.0.1:9/v1/systemone",
  selfHosted: true,
  onHost: true,
  allowRemoteInference: true,
  hasApiKey: true,
  available: true,
  ...over,
});

const http = (
  over: Partial<Extract<ResolvedAssignment, { kind: "http" }>> = {},
): ResolvedAssignment => ({
  role: "decision",
  kind: "http",
  backendKey: "llama",
  url: "http://127.0.0.1:9",
  model: "decider-7b",
  allowRemoteInference: false,
  available: true,
  ...over,
});

const local = (
  over: Partial<Extract<ResolvedAssignment, { kind: "local" }>> = {},
): ResolvedAssignment => ({
  role: "decision",
  kind: "local",
  catalogId: "decider-1b",
  modelPath: "/models/decider-1b.gguf",
  available: true,
  ...over,
});

function fakeCapability(
  modelId: string,
): DecisionCapability & { dispose: ReturnType<typeof vi.fn<() => Promise<void>>> } {
  return {
    modelId,
    decide: async () => ({ model: modelId, answers: {} }),
    dispose: vi.fn(async () => {}),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cassetteDir(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-decision-"));
  dirs.push(dir);
  writeFileSync(join(dir, "gate.jsonl"), `${lines.join("\n")}\n`);
  writeFileSync(join(dir, "notes.txt"), "not a cassette");
  return dir;
}

describe("DecisionService", () => {
  it("returns null while the role is unassigned", () => {
    const service = new DecisionService({
      resolveAssignment: () => ({ role: "decision", kind: "disabled" }),
      readTypeSafeApiKey: () => "k",
    });
    expect(service.get()).toBeNull();
  });

  it("returns null for an unavailable TypeSafe assignment (no key, egress off)", () => {
    const service = new DecisionService({
      resolveAssignment: () => typesafe({ available: false, reason: "no key" }),
      readTypeSafeApiKey: () => null,
    });
    expect(service.get()).toBeNull();
  });

  it("builds a TypeSafe client pinned to the assigned model and reuses it until the assignment changes", () => {
    let resolved = typesafe();
    let key = "apikey_one_0123456789";
    const service = new DecisionService({
      resolveAssignment: () => resolved,
      readTypeSafeApiKey: () => key,
    });
    const first = service.get();
    expect(first).toBeInstanceOf(TypeSafeDecision);
    expect(first?.modelId).toBe("jev-1.13.0");
    expect(service.get()).toBe(first);
    key = "apikey_two_0123456789";
    const second = service.get();
    expect(second).not.toBe(first);
    resolved = typesafe({ model: "jev-1.14.0" });
    expect(service.get()?.modelId).toBe("jev-1.14.0");
  });

  it("builds a keyless TypeSafe client for a self-hosted endpoint", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { worth_score: { type: "score", score: 1 } },
          }),
          { status: 200 },
        ),
    );
    const service = new DecisionService({
      resolveAssignment: () => typesafe({ hasApiKey: false }),
      readTypeSafeApiKey: () => null,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const capability = service.get();
    expect(capability).toBeInstanceOf(TypeSafeDecision);
    await capability!.decide(request);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("still needs a key for TypeSafe's own endpoint", () => {
    const service = new DecisionService({
      resolveAssignment: () => typesafe({ selfHosted: false }),
      readTypeSafeApiKey: () => null,
    });
    expect(service.get()).toBeNull();
  });

  it("builds an HTTP chat backend with its key, and rebuilds when the key changes", () => {
    let key: string | undefined = "sk-one-0000";
    const service = new DecisionService({
      resolveAssignment: () => http(),
      readTypeSafeApiKey: () => null,
      getBackendApiKey: (backend) => (backend === "llama" ? key : undefined),
    });
    const first = service.get();
    expect(first).toBeInstanceOf(HttpChatDecision);
    expect(first?.modelId).toBe("http:llama/decider-7b");
    expect(service.get()).toBe(first);
    key = "sk-two-0000";
    expect(service.get()).not.toBe(first);
  });

  it("returns null for an unavailable HTTP or local assignment", () => {
    for (const resolved of [
      http({ available: false, reason: "down" }),
      local({ available: false, reason: "missing" }),
    ]) {
      const service = new DecisionService({
        resolveAssignment: () => resolved,
        readTypeSafeApiKey: () => null,
        createLocal: () => fakeCapability("never"),
      });
      expect(service.get()).toBeNull();
    }
  });

  it("builds the local backend and disposes it when the assignment moves on", () => {
    let resolved = local();
    const built: Array<ReturnType<typeof fakeCapability>> = [];
    const service = new DecisionService({
      resolveAssignment: () => resolved,
      readTypeSafeApiKey: () => null,
      createLocal: (modelPath) => {
        const capability = fakeCapability(`local:${modelPath}`);
        built.push(capability);
        return capability;
      },
    });
    expect(service.get()?.modelId).toBe("local:/models/decider-1b.gguf");
    expect(service.get()?.modelId).toBe("local:/models/decider-1b.gguf");
    expect(built).toHaveLength(1);
    resolved = local({ modelPath: "/models/decider-3b.gguf" });
    expect(service.get()?.modelId).toBe("local:/models/decider-3b.gguf");
    expect(built[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(built[1]!.dispose).not.toHaveBeenCalled();
  });

  it("loads a replay fixture directory and answers recorded requests only", async () => {
    const response = {
      model: "jev-1.13.0",
      answers: { worth_score: { type: "score" as const, score: 2.1 } },
    };
    const dir = cassetteDir([formatDecisionCassetteEntry(request, response)]);
    const service = new DecisionService({
      resolveAssignment: () => ({ role: "decision", kind: "replay" }),
      readTypeSafeApiKey: () => null,
      defaultReplayFixture: () => dir,
    });
    const capability = service.get();
    expect(capability).toBeInstanceOf(ReplayDecision);
    await expect(capability!.decide(request)).resolves.toEqual({
      model: "replay:jev-1.13.0",
      answers: response.answers,
    });
    await expect(
      capability!.decide({ ...request, state: { subject: "unrecorded" } }),
    ).rejects.toThrow(/No recorded decision/);
  });

  it("returns null for replay without a fixture or with an unreadable one", () => {
    expect(
      new DecisionService({
        resolveAssignment: () => ({ role: "decision", kind: "replay" }),
        readTypeSafeApiKey: () => null,
      }).get(),
    ).toBeNull();
    expect(
      new DecisionService({
        resolveAssignment: () => ({
          role: "decision",
          kind: "replay",
          fixture: "/nonexistent/fixture.jsonl",
        }),
        readTypeSafeApiKey: () => null,
      }).get(),
    ).toBeNull();
  });
});

describe("DecisionService — decision backends", () => {
  const backend = (
    over: Partial<Extract<ResolvedAssignment, { kind: "decision" }>> = {},
  ): ResolvedAssignment => ({
    role: "decision",
    kind: "decision",
    backendKey: "ollaya",
    preset: "ollaya",
    model: "kev",
    url: "http://127.0.0.1:9/v1/systemone",
    protocol: "systemone",
    onHost: true,
    allowRemoteInference: false,
    hasApiKey: false,
    calibrated: false,
    available: true,
    ...over,
  });
  const calibration = {
    points: [
      [0.5, 0.25],
      [0.9, 0.8],
    ] as [number, number][],
    reference: "jev-worth/email-worth-v1/jev-1.13.0",
    fittedAt: "2026-11-10T00:00:00.000Z",
  };

  function serve(score: number) {
    return vi.fn(async (_url: string | URL, init?: RequestInit) =>
      Response.json({
        model: (JSON.parse(String(init?.body)) as { model: string }).model,
        answers: { worth_score: { type: "score", score } },
      }),
    ) as unknown as typeof fetch;
  }

  it("answers through the backend's wire format and applies its calibration", async () => {
    let cfg: Record<string, unknown> = { url: "http://127.0.0.1:9/v1/systemone" };
    let resolved = backend();
    const service = new DecisionService({
      resolveAssignment: () => resolved,
      readTypeSafeApiKey: () => null,
      getDecisionEndpoint: () => cfg as never,
      fetchFn: serve(1.5),
    });
    const raw = service.get()!;
    expect((await raw.decide(request)).answers.worth_score).toEqual({ type: "score", score: 1.5 });

    cfg = { ...cfg, calibration: { kev: calibration } };
    resolved = backend({ calibrated: true });
    const calibrated = service.get()!;
    expect(calibrated).not.toBe(raw);
    expect(calibrated.modelId).toBe("kev+cal");
    const answer = (await calibrated.decide(request)).answers.worth_score;
    expect(answer).toEqual({ type: "score", score: 0.75 });
  });

  it("keeps one client while nothing changes, and rebuilds it when the key does", () => {
    let cfg: Record<string, unknown> = { url: "http://127.0.0.1:9/v1/systemone" };
    const service = new DecisionService({
      resolveAssignment: () => backend(),
      readTypeSafeApiKey: () => null,
      getDecisionEndpoint: () => cfg as never,
    });
    const first = service.get();
    expect(service.get()).toBe(first);
    cfg = { ...cfg, apiKey: "sk-new" };
    expect(service.get()).not.toBe(first);
  });

  it("returns null for an unavailable backend", () => {
    const service = new DecisionService({
      resolveAssignment: () => backend({ available: false, reason: "Ollaya needs an API key." }),
      readTypeSafeApiKey: () => null,
      getDecisionEndpoint: () => ({ url: "http://127.0.0.1:9/v1/systemone" }),
    });
    expect(service.get()).toBeNull();
  });

  it("speaks OpenAI Decisions for a backend that uses it", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        model: "gpt-6-luna",
        answers: [{ type: "score", name: "worth_score", score: 2 }],
      }),
    ) as unknown as typeof fetch;
    const service = new DecisionService({
      resolveAssignment: () =>
        backend({
          backendKey: "openai",
          preset: "openai",
          model: "gpt-6-luna",
          url: "http://127.0.0.1:9/v1/decisions",
          protocol: "openai-decisions",
        }),
      readTypeSafeApiKey: () => null,
      getDecisionEndpoint: () => ({
        url: "http://127.0.0.1:9/v1/decisions",
        protocol: "openai-decisions",
        apiKey: "sk",
      }),
      fetchFn,
    });
    expect((await service.get()!.decide(request)).answers.worth_score).toEqual({
      type: "score",
      score: 2,
    });
    const body = JSON.parse(String(vi.mocked(fetchFn).mock.calls[0]![1]!.body)) as {
      questions: unknown[];
    };
    expect(body.questions).toHaveLength(1);
  });
});

describe("DecisionService — a client that cannot be built", () => {
  it("returns null and keeps answering null, without disposing anything twice", () => {
    const resolved: ResolvedAssignment = {
      role: "decision",
      kind: "decision",
      backendKey: "cf",
      model: "@cf/cloudflare/clef",
      url: "http://127.0.0.1:9/ai/run",
      protocol: "workers-ai",
      onHost: true,
      allowRemoteInference: false,
      hasApiKey: false,
      calibrated: false,
      available: true,
    };
    const service = new DecisionService({
      resolveAssignment: () => resolved,
      readTypeSafeApiKey: () => null,
      // The backend vanished between resolution and building its client.
      getDecisionEndpoint: () => undefined,
    });
    expect(service.get()).toBeNull();
    expect(service.get()).toBeNull();
  });
});

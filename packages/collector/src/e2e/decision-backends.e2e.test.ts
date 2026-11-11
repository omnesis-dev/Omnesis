// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  decisionFingerprint,
  parseDecisionCassette,
  type DecisionAnswer,
  type DecisionQuestion,
} from "@omnesis/core";

import { SyntheticE2EHarness } from "./synth-harness.js";
import {
  startDecisionProviderServer,
  type DecisionProviderServer,
} from "./decision-provider-server.js";

/**
 * Backends with a decision API on a stable gateway, end to end: an operator
 * adds providers — or decision models to a backend they already have — through
 * the same config write the portal and the apps make, and the production
 * registry, decision service, clients and gates use them with the backend's
 * one key.
 *
 * One scripted provider speaks every wire format Omnesis supports — System One
 * with each auth header, Fastino's score field, Workers AI's envelope, and
 * OpenAI Decisions — beside an OpenAI-compatible model listing, so each format
 * is exercised through the gateway. Answers are scripted by content: whether a
 * judgement is good is the eval lane's concern, not this suite's.
 *
 * Calibration replays the bundled Jev reference set through the assigned model;
 * the scripted model rates every reference email higher than Jev did, so the
 * fitted map has something to correct.
 */

type Db = InstanceType<typeof Database>;

const KEY = "sk-scripted-provider";
/** The key an operator rotates to. */
const ROTATED_KEY = "sk-scripted-provider-rotated";
const REFERENCE = parseDecisionCassette(
  readFileSync(
    new URL("../../../gateway/decision-reference/jev-worth.jsonl", import.meta.url),
    "utf8",
  ),
);

function subjectOf(state: unknown): string {
  return String((state as { subject?: unknown } | null)?.subject ?? "");
}

/** Universe email: even subject lengths are junk, odd worth recording. */
const lowWorth = (subject: string) => subject.length % 2 === 0;

function answer(id: string, question: DecisionQuestion, state: unknown): DecisionAnswer {
  if (question.type === "score" && id === "worth_score") {
    const reference = REFERENCE.get(decisionFingerprint({ state, questions: { [id]: question } }));
    const jev = reference?.response.answers.worth_score;
    if (jev?.type === "score") return { type: "score", score: 3 * Math.sqrt(jev.score / 3) };
    return { type: "score", score: lowWorth(subjectOf(state)) ? 0.3 : 2.6 };
  }
  if (question.type === "choice") {
    const utterance = String((state as { utterance?: unknown } | null)?.utterance ?? "");
    const keys = Object.keys(question.criteria);
    return { type: "choice", choice: utterance.trim().endsWith("?") ? keys[0]! : keys[1]! };
  }
  if (question.type === "noul") return { type: "noul", noul: 0.9 };
  return { type: "score", score: 1 };
}

async function waitForGate(db: Db): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const { extracting, untried } = db
      .prepare<[], { extracting: number; untried: number }>(
        `SELECT (SELECT COUNT(*) FROM documents WHERE dates_extracted_at IS NULL) AS extracting,
                (SELECT COUNT(*) FROM date_mention_judgements
                  WHERE verdict = 'pending' AND attempts = 0) AS untried`,
      )
      .get()!;
    if (extracting === 0 && untried === 0) return;
    if (Date.now() > deadline) throw new Error(`Still ${extracting} to scan, ${untried} to judge`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface BackendRow {
  url?: string;
  status?: string;
  models?: string[];
  hasApiKey?: boolean;
  preset?: string;
  decision?: { url: string; hasApiKey: boolean; calibrations: Record<string, unknown> };
}

interface Overview {
  presets: Array<{
    id: string;
    defaultUrl?: string;
    builtIn?: string;
    decision?: { url: string; models: Array<{ id: string }> };
  }>;
  assignmentDisplays: Record<string, { providerId: string; modelName: string }>;
  inference: {
    allowRemoteInference?: boolean;
    assignments: Record<string, Record<string, unknown>>;
    backends: Record<string, BackendRow>;
  };
}

describe("backends with a decision API — stable gateway, every wire format", () => {
  let harness: SyntheticE2EHarness;
  let provider: DecisionProviderServer;

  const overview = () => harness.gatewayJson<Overview>("/admin/models");
  const patch = (inference: unknown) =>
    harness.gatewayFetch("/admin/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inference }),
    });
  const post = (path: string, body?: unknown) =>
    harness.gatewayJson<Record<string, unknown>>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const postStatus = async (path: string, body?: unknown) =>
    (
      await harness.gatewayFetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    ).status;
  const capture = async (text: string) => {
    const res = await harness.gatewayFetch("/capture/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { route: string }).route;
  };
  const configOnDisk = () => readFileSync(join(harness.getConfigDir(), "omnesis.json"), "utf8");
  const decisionAt = (path: string) => ({ url: `${provider.url}${path}` });

  beforeAll(async () => {
    provider = await startDecisionProviderServer({
      apiKeys: [KEY, ROTATED_KEY],
      models: [
        "kev",
        "microsoft-decision-1",
        "fastino/GLiDE",
        "gpt-6-luna",
        "@cf/cloudflare/clef-flash",
      ],
      answer,
    });
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "default",
      extraGatewayEnv: { OMNESIS_TYPESAFE_API_KEY: "", TYPESAFE_API_KEY: "" },
      extraGatewayConfig: { enrichment: { dates: { worthGate: true } } },
    });
    await harness.start();
  }, 180_000);

  afterAll(async () => {
    await harness?.destroy();
    await provider?.close();
  }, 15_000);

  test("offers every provider with decision models, with models.dev's models, in the one preset list", async () => {
    const o = await overview();
    expect(o).not.toHaveProperty("decisionPresets");
    expect(o.inference).not.toHaveProperty("decisionBackends");
    const withDecisions = o.presets.filter((p) => p.decision).map((p) => p.id);
    expect(withDecisions).toEqual(
      expect.arrayContaining([
        "ollaya",
        "ollama",
        "typesafe",
        "openrouter",
        "fireworks",
        "cloudflare",
        "openai",
      ]),
    );
    const openrouter = o.presets.find((p) => p.id === "openrouter")!;
    expect(openrouter.defaultUrl).toBe("https://openrouter.ai/api");
    expect(openrouter.decision!.models.length).toBeGreaterThan(10);
    expect(o.presets.find((p) => p.id === "ollaya")).not.toHaveProperty("defaultUrl");
    expect(o.presets.find((p) => p.id === "typesafe")).toMatchObject({ builtIn: "typesafe" });
    expect(o.inference.assignments.decision).toMatchObject({ kind: "disabled" });
  });

  test("refuses a backend with neither API, and a decision API on a backend named typesafe", async () => {
    const empty = await patch({ backends: { nothing: { type: "http", preset: "ollaya" } } });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("A backend needs a url, a decision endpoint, or both");
    const typesafe = await patch({
      backends: { typesafe: { type: "http", decision: decisionAt("/v1/systemone") } },
    });
    expect(typesafe.status).toBe(400);
    expect(await typesafe.text()).toContain(
      'A backend named \\"typesafe\\" cannot serve decision models',
    );
  });

  test("adds a local decision-only backend and assigns it in one write, with no key and no consent", async () => {
    const res = await patch({
      backends: { box: { type: "http", preset: "ollaya", decision: decisionAt("/v1/systemone") } },
      assignments: { decision: "box/kev" },
    });
    expect(res.status).toBe(200);
    const o = await overview();
    expect(o.inference.assignments.decision).toMatchObject({
      kind: "decision",
      backendKey: "box",
      preset: "ollaya",
      model: "kev",
      onHost: true,
      calibrated: false,
      available: true,
    });
    expect(o.inference.backends.box).toEqual({
      type: "http",
      hasApiKey: false,
      preset: "ollaya",
      decision: {
        url: `${provider.url}/v1/systemone`,
        protocol: "systemone",
        auth: "bearer",
        onHost: true,
        hasApiKey: false,
        calibrations: {},
      },
    });
    expect(o.assignmentDisplays.decision).toMatchObject({ providerId: "ollaya", modelName: "kev" });
    expect(o.inference.allowRemoteInference).toBeFalsy();
  });

  test("a decision-only backend serves no other role and has no OpenAI-compatible API to probe", async () => {
    const res = await patch({ assignments: { "watch-judge": "box/kev" } });
    expect(res.status).toBe(200);
    expect((await overview()).inference.assignments["watch-judge"]).toMatchObject({
      kind: "unresolved",
      reason: 'Backend "box" serves only decision models',
    });
    expect((await patch({ assignments: { "watch-judge": null } })).status).toBe(200);
    expect(await postStatus("/admin/inference/backends/box/probe")).toBe(400);
    expect(provider.listings).toEqual([]);
  });

  test("refuses a model the server does not have when it is assigned", async () => {
    const res = await patch({ assignments: { decision: "box/kevv" } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('The server has no model \\"kevv\\"');
    expect((await overview()).inference.assignments.decision).toMatchObject({ model: "kev" });
  });

  test("lists the server's models and verifies one", async () => {
    const probe = await post("/admin/inference/backends/box/decision/probe");
    expect(probe).toMatchObject({ ok: true, listed: true });
    expect(probe.models).toContain("kev");
    const verify = await post("/admin/inference/backends/box/decision/verify", { model: "kev" });
    expect(verify).toMatchObject({ ok: true, answeredBy: "kev-20261101" });
    expect(
      await postStatus("/admin/inference/backends/nope/decision/verify", { model: "kev" }),
    ).toBe(404);
  });

  test("enables decisions on a backend the agent already uses, with its key, and rotates the key for both", async () => {
    // The backend as `omnesis backend add` makes it for a server with only an
    // OpenAI-compatible API: a URL and a key.
    expect(
      (
        await patch({
          backends: { fw: { type: "http", url: `${provider.url}/chat`, apiKey: KEY } },
        })
      ).status,
    ).toBe(200);
    const listed = await until(overview, (o) => o.inference.backends.fw?.status === "ok");
    expect(listed.inference.backends.fw).toMatchObject({ models: ["chat-model"], hasApiKey: true });
    expect(listed.inference.backends.fw).not.toHaveProperty("decision");
    expect(provider.listings.at(-1)).toEqual({ authorization: `Bearer ${KEY}` });

    // One write adds the decision API, with no key in it.
    const enable = await patch({
      backends: {
        fw: {
          decision: {
            url: `${provider.url}/chat/v1/systemone`,
            protocol: "systemone",
            auth: "bearer",
          },
        },
      },
    });
    expect(enable.status).toBe(200);
    const enabled = await overview();
    expect(enabled.inference.backends.fw).toMatchObject({
      url: `${provider.url}/chat`,
      status: "ok",
      hasApiKey: true,
      decision: { url: `${provider.url}/chat/v1/systemone`, hasApiKey: true },
    });

    // Assigning it checks the model with the backend's key, and decisions use it.
    const callsBefore = provider.callsTo("/chat/v1/systemone").length;
    expect((await patch({ assignments: { decision: "fw/kev" } })).status).toBe(200);
    expect(provider.callsTo("/chat/v1/systemone").length).toBeGreaterThan(callsBefore);
    expect(provider.callsTo("/chat/v1/systemone").at(-1)!.headers.authorization).toBe(
      `Bearer ${KEY}`,
    );
    expect(await capture("When is the dentist appointment?")).toBe("ask");
    expect(provider.callsTo("/chat/v1/systemone").at(-1)!.headers.authorization).toBe(
      `Bearer ${KEY}`,
    );

    // Rotating the key moves both APIs to the new one, and keeps both out of the file.
    expect((await patch({ backends: { fw: { apiKey: ROTATED_KEY } } })).status).toBe(200);
    expect(await capture("Remember that the gate code is 4417.")).toBe("note");
    expect(provider.callsTo("/chat/v1/systemone").at(-1)!.headers.authorization).toBe(
      `Bearer ${ROTATED_KEY}`,
    );
    await until(
      async () => provider.listings.at(-1),
      (last) => last?.authorization === `Bearer ${ROTATED_KEY}`,
    );
    expect(configOnDisk()).not.toContain(KEY);
    expect(configOnDisk()).not.toContain(ROTATED_KEY);

    // Removing only the decision API leaves the OpenAI-compatible side as it was.
    expect((await patch({ backends: { fw: { decision: null } } })).status).toBe(200);
    const after = await until(overview, (o) => o.inference.backends.fw?.status === "ok");
    expect(after.inference.backends.fw).toMatchObject({
      url: `${provider.url}/chat`,
      status: "ok",
      models: ["chat-model"],
      hasApiKey: true,
    });
    expect(after.inference.backends.fw).not.toHaveProperty("decision");
    expect(await post("/admin/inference/backends/fw/probe")).toMatchObject({
      ok: true,
      models: ["chat-model"],
    });
    expect(provider.listings.at(-1)).toEqual({ authorization: `Bearer ${ROTATED_KEY}` });
    expect(await postStatus("/admin/inference/backends/fw/decision/verify", { model: "kev" })).toBe(
      404,
    );
    // Without its decision API, "fw/kev" names a chat model, which is experimental.
    expect(after.inference.assignments.decision).toMatchObject({
      kind: "unresolved",
      reason: expect.stringContaining("only in experimental mode"),
    });
    const saved = JSON.parse(configOnDisk()) as {
      inference: { backends: Record<string, Record<string, unknown>> };
    };
    expect(saved.inference.backends.fw).toEqual({
      type: "http",
      url: `${provider.url}/chat`,
      apiKeySecret: expect.stringMatching(/^config-secret:/),
    });
    expect((await patch({ assignments: { decision: "box/kev" } })).status).toBe(200);
  });

  test("keeps every key out of omnesis.json and sends each provider's own auth", async () => {
    const res = await patch({
      backends: {
        router: {
          type: "http",
          apiKey: KEY,
          decision: { url: `${provider.url}/keyed/v1/systemone`, keyRequired: true },
        },
        foundry: {
          type: "http",
          preset: "azure-foundry",
          apiKey: KEY,
          decision: {
            url: `${provider.url}/foundry/providers/microsoft/v1/systemone`,
            auth: "api-key",
          },
        },
        fastino: {
          type: "http",
          preset: "fastino",
          apiKey: KEY,
          decision: {
            url: `${provider.url}/fastino/v1/systemone`,
            auth: "x-api-key",
            scoreField: "expected_level",
          },
        },
        cf: {
          type: "http",
          preset: "cloudflare",
          apiKey: KEY,
          decision: {
            url: `${provider.url}/client/v4/accounts/acct-1/ai/run`,
            protocol: "workers-ai",
          },
        },
        openai: {
          type: "http",
          preset: "openai",
          apiKey: KEY,
          decision: { url: `${provider.url}/v1/decisions`, protocol: "openai-decisions" },
        },
        wrongkey: {
          type: "http",
          apiKey: "sk-wrong",
          decision: { url: `${provider.url}/keyed/v1/systemone` },
        },
      },
    });
    expect(res.status).toBe(200);
    const onDisk = configOnDisk();
    expect(onDisk).not.toContain(KEY);
    expect(onDisk).not.toContain("sk-wrong");
    const backends = (await overview()).inference.backends;
    for (const key of ["router", "foundry", "fastino", "cf", "openai", "wrongkey"]) {
      expect(backends[key], key).toMatchObject({ hasApiKey: true, decision: { hasApiKey: true } });
    }
    expect(JSON.stringify(backends)).not.toContain(KEY);

    for (const [key, model] of [
      ["router", "kev"],
      ["foundry", "microsoft-decision-1"],
      ["fastino", "fastino/GLiDE"],
      ["cf", "@cf/cloudflare/clef-flash"],
      ["openai", "gpt-6-luna"],
    ] as const) {
      const verify = await post(`/admin/inference/backends/${key}/decision/verify`, { model });
      expect(verify, key).toMatchObject({ ok: true });
    }
    expect(provider.callsTo("/keyed").at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(provider.callsTo("/foundry").at(-1)!.headers).toMatchObject({
      "api-key": KEY,
      authorization: undefined,
    });
    expect(provider.callsTo("/fastino").at(-1)!.headers["x-api-key"]).toBe(KEY);
    expect(provider.callsTo("/client/v4").at(-1)!.body.model).toBe("clef-flash");
    expect(provider.callsTo("/v1/decisions").at(-1)!.body.questions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "predicate", name: "verify_noul" })]),
    );

    const refused = await post("/admin/inference/backends/wrongkey/decision/verify", {
      model: "kev",
    });
    expect(refused).toMatchObject({ ok: false, status: 401 });
    expect(String(refused.reason)).toContain("The API key was refused");
  });

  test("saves a corrected key and the assignment in one write, without testing the old key", async () => {
    // `wrongkey` holds a refused key; assigning it alone is refused...
    const alone = await patch({ assignments: { decision: "wrongkey/kev" } });
    expect(alone.status).toBe(400);
    expect(await alone.text()).toContain("The API key was refused");
    // ...but replacing the key in the same write saves, and the new key works.
    const fixed = await patch({
      backends: { wrongkey: { apiKey: KEY } },
      assignments: { decision: "wrongkey/kev" },
    });
    expect(fixed.status).toBe(200);
    const verify = await post("/admin/inference/backends/wrongkey/decision/verify", {
      model: "kev",
    });
    expect(verify).toMatchObject({ ok: true });
  });

  test("lists an unsaved server's models, with a saved backend's key when asked", async () => {
    const probe = await post("/admin/inference/decision/probe", {
      url: `${provider.url}/v1/systemone`,
    });
    expect(probe).toMatchObject({ ok: true, listed: true });
    expect(probe.models).toContain("kev");
    const withKey = await post("/admin/inference/decision/probe", {
      url: `${provider.url}/v1/systemone`,
      backendKey: "router",
    });
    expect(withKey).toMatchObject({ ok: true, listed: true });
    expect(
      await postStatus("/admin/inference/decision/probe", {
        url: `${provider.url}/v1/systemone`,
        backendKey: "gone",
      }),
    ).toBe(404);
  });

  test("leaves a decision API off this host unused until remote inference is allowed", async () => {
    const before = provider.calls.length;
    expect(
      (
        await patch({
          backends: { lan: { type: "http", decision: { url: "http://192.0.2.1:9/v1/systemone" } } },
        })
      ).status,
    ).toBe(200);
    const verify = await post("/admin/inference/backends/lan/decision/verify", { model: "kev" });
    expect(verify).toMatchObject({ ok: false });
    expect(String(verify.reason)).toContain("send data off your machine");
    expect(provider.calls.length).toBe(before);
  });

  test("judges every email through the backend's decision API at the mention worth gate", async () => {
    await harness.syncAllSources();
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      await waitForGate(db);
      const rows = db
        .prepare<
          [],
          { subject: string | null; verdict: string; requested: string; model: string | null }
        >(
          `SELECT d.title AS subject, c.verdict, c.requested_model_id AS requested, c.model_id AS model
             FROM cognition_decisions c LEFT JOIN documents d ON d.id = c.subject_document_id
            WHERE c.purpose = 'mention-worth'`,
        )
        .all();
      const answered = rows.filter((r) => r.verdict === "pass" || r.verdict === "skip");
      expect(answered.length).toBeGreaterThan(0);
      expect(answered.length).toBe(rows.length);
      for (const row of answered) {
        expect(row.requested).toBe("kev");
        expect(row.model).toBe("kev-20261101");
        expect(row.verdict).toBe(lowWorth(row.subject ?? "") ? "skip" : "pass");
      }
    } finally {
      db.close();
    }
  }, 180_000);

  test("routes a voice capture through each wire format", async () => {
    for (const [assignment, path] of [
      ["box/kev", "/v1/systemone"],
      ["foundry/microsoft-decision-1", "/foundry"],
      ["fastino/fastino/GLiDE", "/fastino"],
      ["cf/@cf/cloudflare/clef-flash", "/client/v4"],
      ["openai/gpt-6-luna", "/v1/decisions"],
    ] as const) {
      expect((await patch({ assignments: { decision: assignment } })).status, assignment).toBe(200);
      const before = provider.callsTo(path).length;
      expect(await capture("When is the dentist appointment?"), assignment).toBe("ask");
      expect(await capture("Remember that the gate code is 4417."), assignment).toBe("note");
      expect(provider.callsTo(path).length - before, assignment).toBe(2);
    }
  });

  test("calibrates the assigned model onto Jev's scale and answers with the calibration", async () => {
    expect((await patch({ assignments: { decision: "box/kev" } })).status).toBe(200);
    const started = await harness.gatewayFetch("/admin/models/decision/calibration", {
      method: "POST",
    });
    expect(started.status).toBe(202);
    let status: Record<string, unknown> = await started.json();
    expect(status).toMatchObject({ state: "running", assignment: "box/kev" });
    const deadline = Date.now() + 120_000;
    while (status.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = await harness.gatewayJson("/admin/models/decision/calibration");
    }
    expect(status).toMatchObject({ state: "done", failed: 0 });
    const result = status.result as Record<string, number>;
    expect(result.samples).toBe(REFERENCE.size);
    // The scripted model rates every reference email higher than Jev did:
    // calibrated, it keeps about 95% of what Jev keeps and skips far more of the rest.
    expect(result.keepsBefore).toBe(1);
    expect(result.keeps).toBeGreaterThanOrEqual(0.94);
    expect(result.skips).toBeGreaterThan(result.skipsBefore!);
    expect(result.skips).toBeGreaterThanOrEqual(0.99);

    const o = await overview();
    expect(o.inference.assignments.decision).toMatchObject({ calibrated: true });
    expect(o.inference.backends.box!.decision!.calibrations).toHaveProperty("kev");
    const saved = JSON.parse(configOnDisk()) as {
      inference: { backends: Record<string, { decision?: { calibration?: object } }> };
    };
    expect(saved.inference.backends.box!.decision!.calibration).toHaveProperty("kev");

    // Decisions now carry the calibration: the spend ledger names the model as calibrated.
    expect(await capture("Remember to water the ferns on Friday.")).toBe("note");
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const models = db
        .prepare<[], { model_id: string }>(
          `SELECT model_id FROM cognition_spend WHERE mechanism = 'capture-decision'`,
        )
        .all()
        .map((r) => r.model_id);
      expect(models).toContain("kev-20261101+cal");
    } finally {
      db.close();
    }
  }, 180_000);

  test("refuses to calibrate TypeSafe's Jev, the reference itself", async () => {
    expect((await patch({ assignments: { decision: "typesafe/jev-1.13.0" } })).status).toBe(200);
    const res = await harness.gatewayFetch("/admin/models/decision/calibration", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  test("removing the assigned backend leaves the role unresolved, naming it", async () => {
    expect((await patch({ assignments: { decision: "box/kev" } })).status).toBe(200);
    expect((await patch({ backends: { box: null } })).status).toBe(200);
    const o = await overview();
    expect(o.inference.backends).not.toHaveProperty("box");
    expect(o.inference.assignments.decision).toMatchObject({
      kind: "unresolved",
      reason: 'Unknown backend "box" in assignment "box/kev"',
    });
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A scripted decision provider for end-to-end tests: one loopback server that
 * speaks each decision API Omnesis supports, at the paths the real providers
 * use, so a gateway's decision backends can be pointed at it.
 *
 *   POST /v1/systemone                                   System One, keyless (a local server)
 *   POST /keyed/v1/systemone                             System One behind `Authorization: Bearer`
 *   POST /foundry/providers/microsoft/v1/systemone       System One behind `api-key`
 *   POST /fastino/v1/systemone                           System One behind `X-API-Key`, argmax `score` + `expected_level`
 *   POST /client/v4/accounts/:acct/ai/run/@cf/cloudflare/:model   Workers AI: short model in the body, `{result}` envelope
 *   POST /v1/decisions                                   OpenAI Decisions schema
 *   GET  /api/tags                                       installed models, Ollama-style
 *
 * Every endpoint answers only the models in `models`, with a 404 otherwise, and
 * a wrong or missing key with a 401. Answers come from `answer(questionId,
 * question, state)`, so a test scripts them by content. Every request is
 * recorded.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DecisionAnswer, DecisionQuestion } from "@omnesis/core";

export interface ProviderCall {
  path: string;
  headers: Record<string, string | undefined>;
  body: Record<string, unknown>;
}

export interface DecisionProviderOptions {
  /** Models every endpoint serves. */
  models: readonly string[];
  /** The key the keyed endpoints expect. */
  apiKey: string;
  /** The answer to one question about one state. */
  answer: (questionId: string, question: DecisionQuestion, state: unknown) => DecisionAnswer;
}

export interface DecisionProviderServer {
  url: string;
  calls: ProviderCall[];
  callsTo(pathPrefix: string): ProviderCall[];
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export async function startDecisionProviderServer(
  opts: DecisionProviderOptions,
): Promise<DecisionProviderServer> {
  const calls: ProviderCall[] = [];
  const served = new Set(opts.models);

  const systemOneAnswers = (
    body: Record<string, unknown>,
    scoreField: "score" | "expected_level",
  ) => {
    const questions = body.questions as Record<string, DecisionQuestion>;
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) {
      const a = opts.answer(id, q, body.state);
      answers[id] =
        a.type === "score" && scoreField === "expected_level"
          ? { ...a, score: Math.round(a.score), expected_level: a.score }
          : a;
    }
    return answers;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0]!;
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && path === "/api/tags") {
        send(200, { models: opts.models.map((name) => ({ name })) });
        return;
      }
      if (req.method !== "POST") return send(405, { error: "method" });
      const body = await readJson(req);
      calls.push({
        path,
        headers: {
          authorization: req.headers.authorization,
          "api-key": req.headers["api-key"] as string | undefined,
          "x-api-key": req.headers["x-api-key"] as string | undefined,
        },
        body,
      });
      const needs = (header: string, value: string) => {
        if (req.headers[header] !== value) {
          send(401, { error: "invalid key" });
          return false;
        }
        return true;
      };
      const model = String(body.model ?? "");

      if (
        path === "/v1/systemone" ||
        path === "/keyed/v1/systemone" ||
        path === "/foundry/providers/microsoft/v1/systemone" ||
        path === "/fastino/v1/systemone"
      ) {
        if (path.startsWith("/keyed") && !needs("authorization", `Bearer ${opts.apiKey}`)) return;
        if (path.startsWith("/foundry") && !needs("api-key", opts.apiKey)) return;
        if (path.startsWith("/fastino") && !needs("x-api-key", opts.apiKey)) return;
        if (!served.has(model)) return send(404, { error: `model "${model}" not found` });
        return send(200, {
          model: path.startsWith("/fastino") ? "glide" : `${model}-20261101`,
          answers: systemOneAnswers(body, path.startsWith("/fastino") ? "expected_level" : "score"),
          usage: { input_tokens: 40, output_tokens: 0 },
          provider: "scripted",
        });
      }

      const workers = /^\/client\/v4\/accounts\/[^/]+\/ai\/run\/@cf\/cloudflare\/([^/]+)$/.exec(
        path,
      );
      if (workers) {
        if (!needs("authorization", `Bearer ${opts.apiKey}`)) return;
        if (workers[1] !== model || !served.has(`@cf/cloudflare/${model}`)) {
          return send(404, {
            result: null,
            success: false,
            errors: [{ code: 5007, message: "No such model" }],
            messages: [],
          });
        }
        return send(200, {
          result: {
            model,
            answers: systemOneAnswers(body, "score"),
            usage: { input_tokens: 40, output_tokens: 0 },
          },
          success: true,
          errors: [],
          messages: [],
        });
      }

      if (path === "/v1/decisions") {
        if (!needs("authorization", `Bearer ${opts.apiKey}`)) return;
        if (!served.has(model)) return send(404, { error: { message: "model not found" } });
        const questions = body.questions as Array<Record<string, unknown>>;
        const input = body.input as unknown;
        const state =
          Array.isArray(input) &&
          (input[0] as { content?: Array<{ data?: unknown }> })?.content?.[0]?.data
            ? (input[0] as { content: Array<{ data: unknown }> }).content[0]!.data
            : input;
        const answers = questions.map((q) => {
          const name = String(q.name);
          const kind = q.type === "predicate" ? "noul" : (q.type as "score" | "choice");
          const asked: DecisionQuestion =
            kind === "noul"
              ? { type: "noul", instructions: String(q.instructions) }
              : kind === "score"
                ? {
                    type: "score",
                    instructions: String(q.instructions),
                    criteria: (q.levels as Array<{ label: string }>).map((l) => l.label),
                  }
                : {
                    type: "choice",
                    instructions: String(q.instructions),
                    criteria: Object.fromEntries(
                      (q.choices as Array<{ value: string }>).map((c) => [c.value, null]),
                    ),
                  };
          const a = opts.answer(name, asked, state);
          if (a.type === "noul") return { type: "predicate", name, probability: a.noul };
          if (a.type === "score")
            return { type: "score", name, score: a.score, confidence: 0.5, probabilities: [] };
          return {
            type: "choice",
            name,
            choice: a.choice,
            confidence: 0.9,
            probabilities: [{ value: a.choice, probability: 0.9 }],
          };
        });
        return send(200, {
          model,
          answers,
          usage: { input_tokens: 40, output_tokens: 0, total_tokens: 40 },
        });
      }

      send(404, { error: "no such endpoint" });
    })().catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    callsTo: (prefix) => calls.filter((c) => c.path.startsWith(prefix)),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

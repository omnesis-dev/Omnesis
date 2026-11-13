// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

interface Message {
  role: string;
  content: unknown;
  tool_call_id?: string;
}
interface ObservedDocument {
  id: string;
  content: string;
}
export interface ScopeAgentCase {
  sourceId: string;
  documentIds: string[];
  query: string;
  search?: unknown;
  fetched?: unknown;
  modelInputs: string[];
  toolNames?: string[];
  sqlQueries?: string[];
  sqlResults?: unknown[];
}
export interface ScopeScriptedAgent {
  url: string;
  modelId: string;
  register(input: Omit<ScopeAgentCase, "modelInputs">): {
    question: string;
    observed: ScopeAgentCase;
    parkFinal: () => { entered: Promise<void>; release: () => void };
  };
  close(): Promise<void>;
}
function documents(value: unknown): ObservedDocument[] {
  if (Array.isArray(value)) return value.flatMap(documents);
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  if (item.kind === "document" && item.document && typeof item.document === "object") {
    const doc = item.document as Record<string, unknown>;
    if (typeof doc.id === "string" && typeof doc.content === "string")
      return [{ id: doc.id, content: doc.content }];
  }
  return Object.values(item).flatMap(documents);
}
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
function completion(model: string, message: Record<string, unknown>, tools = false): unknown {
  return {
    id: `scripted-scope-${randomUUID()}`,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message, finish_reason: tools ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 64, completion_tokens: 32 },
  };
}

/** Deterministic model double: its answer is built only from bodies the real tools returned. */
export async function startScopeScriptedAgent(): Promise<ScopeScriptedAgent> {
  const modelId = "scripted-scoped-answer";
  const cases = new Map<string, ScopeAgentCase>();
  const gates = new Map<
    string,
    { entered: () => void; wait: Promise<void>; release: () => void }
  >();
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && /\/(?:v1\/)?models/.test(req.url ?? "")) {
        json(res, 200, {
          object: "list",
          data: [{ id: modelId, object: "model", owned_by: "synthetic-scope-tests" }],
        });
        return;
      }
      if (req.method !== "POST" || !/\/(?:v1\/)?chat\/completions/.test(req.url ?? "")) {
        json(res, 404, { error: { message: "Unknown scripted model route" } });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        stream?: boolean;
        messages?: Message[];
        tools?: Array<{ function?: { name?: string } }>;
      };
      if (body.stream) {
        json(res, 400, {
          error: { message: "stream is not supported by this scripted test model" },
        });
        return;
      }
      if (!Array.isArray(body.messages)) {
        json(res, 400, { error: { message: "Missing messages" } });
        return;
      }
      if (body.tools?.some((tool) => tool.function?.name === "submit_privacy_review")) {
        if (body.messages.some((message) => message.tool_call_id === "scope-review-submit")) {
          json(res, 200, completion(modelId, { role: "assistant", content: "Review submitted." }));
        } else {
          json(
            res,
            200,
            completion(
              modelId,
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "scope-review-submit",
                    type: "function",
                    function: {
                      name: "submit_privacy_review",
                      arguments: JSON.stringify({
                        decision: "ask",
                        confidence: 1,
                        findings: [
                          {
                            category: "business_detail",
                            detailLevel: "exact",
                            subject: "user",
                            disposition: "ask",
                            description: "Invented exact record requires owner review.",
                          },
                        ],
                        rationale:
                          "The scripted reviewer requires approval of this invented answer.",
                      }),
                    },
                  },
                ],
              },
              true,
            ),
          );
        }
        return;
      }
      const question = body.messages
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        )
        .join("\n");
      const entry = [...cases].find(([key]) => question.includes(key));
      if (!entry) {
        json(res, 200, completion(modelId, { role: "assistant", content: "Ready." }));
        return;
      }
      const [key, observed] = entry;
      observed.modelInputs.push(JSON.stringify(body.messages));
      observed.toolNames =
        body.tools?.flatMap((tool) => (tool.function?.name ? [tool.function.name] : [])) ?? [];
      const results = new Map(
        body.messages
          .filter((message) => message.role === "tool")
          .map((message) => [message.tool_call_id, message]),
      );
      const tool = (name: string, args: unknown) =>
        json(
          res,
          200,
          completion(
            modelId,
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `${key}-${name}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
            true,
          ),
        );
      const search = results.get(`${key}-search_many`);
      if (!search) {
        tool("search_many", {
          queries: [
            { query: observed.query, filters: { sourceIds: [observed.sourceId] }, limit: 20 },
          ],
        });
        return;
      }
      observed.search = JSON.parse(String(search.content));
      const fetch = results.get(`${key}-fetch_many`);
      if (!fetch) {
        tool("fetch_many", {
          documents: observed.documentIds.map((documentId) => ({ documentId })),
        });
        return;
      }
      observed.fetched = JSON.parse(String(fetch.content));
      observed.sqlResults = [];
      for (const [index, sql] of (observed.sqlQueries ?? []).entries()) {
        const id = `${key}-sql-${index}`;
        const result = results.get(id);
        if (!result) {
          json(
            res,
            200,
            completion(
              modelId,
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id,
                    type: "function",
                    function: { name: "run_sql", arguments: JSON.stringify({ sql }) },
                  },
                ],
              },
              true,
            ),
          );
          return;
        }
        observed.sqlResults.push(JSON.parse(String(result.content)));
      }
      const actual = documents(observed.fetched);
      if (!results.has(`${key}-annotate_many`) && actual.length) {
        tool("annotate_many", { annotations: actual.map((doc) => ({ documentId: doc.id })) });
        return;
      }
      const gate = gates.get(key);
      if (gate) {
        gate.entered();
        await gate.wait;
      }
      const answer = actual.length
        ? actual.map((doc) => doc.content).join("\n")
        : "No matching documents were returned.";
      json(res, 200, completion(modelId, { role: "assistant", content: answer }));
    })().catch((error: unknown) =>
      json(res, 500, {
        error: { message: error instanceof Error ? error.message : String(error) },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Scripted model did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    modelId,
    register(input) {
      const key = `scope-probe-${randomUUID()}`;
      const observed: ScopeAgentCase = { ...input, modelInputs: [] };
      cases.set(key, observed);
      return {
        question: `Read the invented records for ${key}.`,
        observed,
        parkFinal() {
          let enter!: () => void;
          let release!: () => void;
          const entered = new Promise<void>((resolve) => {
            enter = resolve;
          });
          const wait = new Promise<void>((resolve) => {
            release = resolve;
          });
          gates.set(key, { entered: enter, wait, release });
          return { entered, release };
        },
      };
    },
    async close() {
      for (const gate of gates.values()) gate.release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

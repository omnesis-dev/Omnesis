// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The minimal OpenAI-compatible chat server the bench's scripted model
 * roles are built on (the puppet steward, the entailment verifier, the
 * brief judge).
 *
 * Only non-streamed completions are served: a `stream: true` request is
 * answered with a request-shape 400, which `HttpChatBackend`'s resilience
 * ladder (stream → stream-without-options → non-streamed) retries in the
 * one shape this server speaks. That keeps every scripted role
 * deterministic by construction — no partial-frame timing to reason about.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";

export interface WireToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/** What one served request should answer with. */
export type WireReply =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  /**
   * Refuse the call with a provider error, the way a real backend does when
   * the account is out of credit or the key is rejected. The status reaches
   * the brain as the failure's `provider.status`, which is what decides
   * whether the failure blames the environment or the payload — so a bench
   * that could only ever answer 200 could not exercise that split at all.
   */
  | { kind: "httpError"; status: number; message: string };

export interface OpenAiServerHandle {
  url: string;
  modelId: string;
  close(): Promise<void>;
}

export function safeParse(text: string | null | undefined): unknown | null {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The concatenated text of every message, for prompt-matching policies. */
export function promptTextOf(messages: readonly WireMessage[]): string {
  return messages
    .filter((m) => typeof m.content === "string" && m.content.length > 0)
    .map((m) => m.content as string)
    .join("\n");
}

/** The first user message — the run prompt for a cognition run. */
export function userPromptOf(messages: readonly WireMessage[]): string {
  return messages.find((m) => m.role === "user")?.content ?? "";
}

export async function startOpenAiServer(opts: {
  modelId: string;
  /** Decide the reply for one request. Throwing yields a 500 (the caller's error path). */
  respond: (messages: readonly WireMessage[]) => WireReply;
}): Promise<OpenAiServerHandle> {
  let counter = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (req.method === "GET" && url.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: opts.modelId, object: "model", owned_by: "omnesis-brain-bench" }],
          }),
        );
        return;
      }
      if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
        const body = safeParse(await readBody(req)) as {
          stream?: unknown;
          messages?: WireMessage[];
        } | null;
        if (!body || !Array.isArray(body.messages)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "malformed request body" } }));
          return;
        }
        if (body.stream === true) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "stream is not supported by the brain-bench scripted server" },
            }),
          );
          return;
        }

        const reply = opts.respond(body.messages);
        if (reply.kind === "httpError") {
          res.writeHead(reply.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: reply.message, type: "invalid_request" } }));
          return;
        }
        const usage = {
          prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4),
          completion_tokens: 24,
        };
        const message =
          reply.kind === "tool"
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call_${++counter}`,
                    type: "function",
                    function: { name: reply.name, arguments: JSON.stringify(reply.args) },
                  },
                ],
              }
            : { role: "assistant", content: reply.text };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: `bench-${++counter}`,
            object: "chat.completion",
            model: opts.modelId,
            choices: [
              {
                index: 0,
                message,
                finish_reason: reply.kind === "tool" ? "tool_calls" : "stop",
              },
            ],
            usage,
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url}` } }));
    })().catch(() => {
      try {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "internal brain-bench server error" } }));
      } catch {
        /* response already gone */
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("brain-bench scripted server failed to bind a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    modelId: opts.modelId,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

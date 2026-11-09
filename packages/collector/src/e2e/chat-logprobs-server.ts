// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A scripted OpenAI-compatible chat server that answers with token
 * log-probabilities — the stand-in for llama-server or vLLM behind the
 * `decision` role's `<backend>/<model>` assignment.
 *
 * It lists one model on `GET /v1/models` (so the registry's probe finds the
 * backend `ok`) and answers `POST /v1/chat/completions` with one output token
 * whose `top_logprobs` come from a policy over the request's user message. A
 * policy may instead return `null` to reply without log-probabilities, the
 * way a server that does not support them answers. Every call is recorded.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";

export interface ChatLogprobsCall {
  body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
    logprobs?: boolean;
    top_logprobs?: number;
  };
  /** The user message: the rendered content, question and labels. */
  user: string;
  /** Whether the reply carried log-probabilities. */
  withLogprobs: boolean;
}

/** Candidate first tokens and their probabilities, or null for a reply without logprobs. */
export type ChatLogprobsPolicy = (user: string) => Readonly<Record<string, number>> | null;

export interface ChatLogprobsServer {
  /** Base URL to declare as the HTTP backend's `url`. */
  url: string;
  model: string;
  calls: ChatLogprobsCall[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startChatLogprobsServer(opts: {
  model: string;
  policy: ChatLogprobsPolicy;
}): Promise<ChatLogprobsServer> {
  const calls: ChatLogprobsCall[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && url.endsWith("/models")) {
        res.end(JSON.stringify({ object: "list", data: [{ id: opts.model, object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || !url.endsWith("/chat/completions")) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url}` } }));
        return;
      }
      const body = JSON.parse(await readBody(req)) as ChatLogprobsCall["body"];
      const user = body.messages.find((m) => m.role === "user")?.content ?? "";
      const candidates = opts.policy(user);
      calls.push({ body, user, withLogprobs: candidates !== null });
      const usage = { prompt_tokens: Math.ceil(user.length / 4), completion_tokens: 1 };
      if (candidates === null) {
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: "0" }, logprobs: null }],
            usage,
          }),
        );
        return;
      }
      const top = Object.entries(candidates)
        .sort(([, a], [, b]) => b - a)
        .map(([token, p]) => ({ token, logprob: Math.log(p) }));
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: top[0]!.token },
              logprobs: { content: [{ ...top[0]!, top_logprobs: top }] },
              finish_reason: "length",
            },
          ],
          usage,
        }),
      );
    })().catch(() => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "chat logprobs server error" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    model: opts.model,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

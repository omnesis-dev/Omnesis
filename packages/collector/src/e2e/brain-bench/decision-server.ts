// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A scripted stand-in for TypeSafe System One — the HTTP backend of the
 * `decision` capability (`typesafe/<model>`).
 *
 * The gateway's TypeSafe client posts `{model, state, questions}` with a
 * bearer key and expects `{model, answers, usage: {input_tokens}}` back. This
 * server speaks exactly that, so a bench drives the worth gate through the
 * production client, URL policy, retry ladder and reply validation — only the
 * judgement itself is scripted.
 *
 * Three ways to answer:
 *  - a function of the request (score by subject, refuse one email, …);
 *  - `{ cassetteDir }` — answer from recorded decision cassettes by
 *    fingerprint. A miss is an HTTP 422 naming the fingerprint and the
 *    canonical request, so a drifted request fails the test loudly instead of
 *    reading as a model outage (which the gate would absorb by failing open);
 *  - `refuseWith(status)` — an outage across every call, toggled at runtime.
 *
 * Every call is recorded with its request and what was answered.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  decisionFingerprint,
  parseDecisionCassette,
  type DecisionAnswer,
  type DecisionCassetteEntry,
  type DecisionRequest,
} from "@omnesis/core";

/** The model id the bench assigns: `typesafe/<this>`. */
export const DECISION_SERVER_MODEL_ID = "jev-1.13.0";

/** One request as the server received it. */
export interface DecisionServerRequest extends DecisionRequest {
  readonly model: string;
}

/** What a policy function may answer: the answers map, or a provider error. */
export type DecisionPolicyReply =
  | Readonly<Record<string, DecisionAnswer>>
  | { readonly httpError: number; readonly message?: string };

export type DecisionPolicy =
  | ((request: DecisionServerRequest) => DecisionPolicyReply)
  | { readonly cassetteDir: string };

export interface DecisionServerOptions {
  policy: DecisionPolicy;
  /** Billed input tokens reported per answered call. Defaults to a length estimate. */
  inputTokens?: number;
}

/** One served call, for assertions about what the gate asked. */
export interface DecisionServerCall {
  at: number;
  /** The bearer credential presented, or null when absent. */
  authorization: string | null;
  request: DecisionServerRequest;
  status: number;
  /** The reply body sent back. */
  reply: unknown;
}

export interface DecisionServer {
  /** Base URL (`http://127.0.0.1:<port>`); the endpoint is `${url}/v1/systemone`. */
  url: string;
  /** The System One endpoint the gateway's `inference.typesafe.url` points at. */
  endpoint: string;
  modelId: string;
  calls: DecisionServerCall[];
  /** Calls whose state has this subject — the worth gate's email subject. */
  callsForSubject(subject: string): DecisionServerCall[];
  /** Open (a status) or close (null) an outage across every call. */
  refuseWith(status: number | null, message?: string): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function loadCassettes(dir: string): Map<string, DecisionCassetteEntry> {
  const files = statSync(dir).isDirectory()
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .map((name) => join(dir, name))
    : [dir];
  const entries = new Map<string, DecisionCassetteEntry>();
  for (const file of files) {
    for (const [fp, entry] of parseDecisionCassette(readFileSync(file, "utf8"), file)) {
      entries.set(fp, entry);
    }
  }
  return entries;
}

function subjectOf(request: DecisionRequest): string | null {
  const state = request.state as { subject?: unknown } | null;
  return state && typeof state === "object" && typeof state.subject === "string"
    ? state.subject
    : null;
}

export async function startDecisionServer(opts: DecisionServerOptions): Promise<DecisionServer> {
  const calls: DecisionServerCall[] = [];
  let refusal: { status: number; message: string } | null = null;
  const cassettes =
    typeof opts.policy === "function" ? null : loadCassettes(opts.policy.cassetteDir);

  const answer = (
    request: DecisionServerRequest,
  ): { status: number; body: Record<string, unknown> } => {
    if (refusal) {
      return { status: refusal.status, body: { error: { message: refusal.message } } };
    }
    if (typeof opts.policy === "function") {
      const reply = opts.policy(request);
      if ("httpError" in reply && typeof reply.httpError === "number") {
        return {
          status: reply.httpError,
          body: { error: { message: reply.message ?? `scripted HTTP ${reply.httpError}` } },
        };
      }
      return {
        status: 200,
        body: {
          model: request.model,
          answers: reply,
          usage: { input_tokens: opts.inputTokens ?? Math.ceil(canonicalJson(request).length / 4) },
        },
      };
    }
    const fp = decisionFingerprint(request);
    const entry = cassettes!.get(fp);
    if (!entry) {
      return {
        status: 422,
        body: {
          error: {
            message: `no recorded decision for ${fp}`,
            fp,
            canonicalRequest: canonicalJson({ state: request.state, questions: request.questions }),
          },
        },
      };
    }
    return {
      status: 200,
      body: {
        model: entry.response.model,
        answers: entry.response.answers,
        usage: { input_tokens: entry.response.inputTokens ?? 0 },
      },
    };
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (req.method !== "POST" || !url.startsWith("/v1/systemone")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url}` } }));
        return;
      }
      const authorization = req.headers.authorization ?? null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        parsed = null;
      }
      const body = parsed as Partial<DecisionServerRequest> | null;
      if (
        !body ||
        typeof body.model !== "string" ||
        body.state === undefined ||
        !body.questions ||
        typeof body.questions !== "object"
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "expected {model, state, questions}" } }));
        return;
      }
      const request = body as DecisionServerRequest;
      let status: number;
      let reply: Record<string, unknown>;
      if (!authorization || !/^Bearer \S+$/.test(authorization)) {
        status = 401;
        reply = { error: { message: "missing bearer credential" } };
      } else {
        ({ status, body: reply } = answer(request));
      }
      calls.push({ at: Date.now(), authorization, request, status, reply });
      res.writeHead(status, {
        "Content-Type": "application/json",
        "x-typesafe-request-id": `bench-${calls.length}`,
      });
      res.end(JSON.stringify(reply));
    })().catch((err: unknown) => {
      try {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `decision server error: ${err instanceof Error ? err.message : String(err)}`,
            },
          }),
        );
      } catch {
        /* response already gone */
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("decision server failed to bind a port");
  }
  const base = `http://127.0.0.1:${address.port}`;
  return {
    url: base,
    endpoint: `${base}/v1/systemone`,
    modelId: DECISION_SERVER_MODEL_ID,
    calls,
    callsForSubject: (subject) => calls.filter((c) => subjectOf(c.request) === subject),
    refuseWith(status, message = "scripted decision outage") {
      refusal = status === null ? null : { status, message };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { relayOrigin } from "./network.js";
import { readBoundedJson } from "./google-credentials.js";
import { signInProofSchema } from "./device-enrollment.js";
import { connectShortUrlSchema } from "./connect-short-url.js";
import { omnesisMark } from "./relay-page.js";
import type { AddressInfo } from "node:net";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const startSchema = z
  .object({
    operationId: z.string().uuid(),
    ticket: opaque,
    authorizeUrl: z.string().max(2048),
    connectUrl: z.string().max(2048),
    connectShortUrl: connectShortUrlSchema.optional(),
    code: z.string().regex(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const approvedSchema = z
  .object({
    status: z.literal("approved"),
    discoveryToken: z.string().min(1).max(16384),
    accountId: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
    signInProof: signInProofSchema.optional(),
    credentialPublicKey: z.string().max(4096).optional(),
  })
  .strict();
const pendingSchema = z
  .object({ status: z.literal("pending"), expiresAt: z.number().int().positive() })
  .strict();

/** The launch URL is a fixed Root path. Native PKCE and polling capabilities never enter the browser. */
export async function openAccountBrowser(value: string, origin: string): Promise<void> {
  const url = new URL(value),
    relay = relayOrigin(origin);
  const query = z.object({ operationId: z.string().uuid(), ticket: opaque }).strict();
  if (
    url.origin !== relay.origin ||
    url.pathname !== "/_relay/v3/desktop/begin" ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.size !== 2 ||
    !query.safeParse(Object.fromEntries(url.searchParams)).success
  )
    throw new Error("Invalid account sign-in destination");
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const child = spawn(
    command,
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.href] : [url.href],
    { stdio: "ignore" },
  );
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error("Unable to open the account sign-in browser");
}

export interface LoopbackCompletion {
  port: number;
  /** The relay's completion secret, once this machine's browser has delivered it. */
  completion(): string | undefined;
  /** Only a callback naming this operation is accepted. */
  expect(operationId: string): void;
  close(): void;
}

const CALLBACK_PATH = "/omnesis/callback";
const callbackQuery = z.object({ operationId: z.string().uuid(), completion: opaque }).strict();

/**
 * RFC 8252 §7.3: a single-use listener on 127.0.0.1. The relay sends the browser here once the
 * sign-in is confirmed, so only a desktop on the machine where the sign-in finished learns the
 * secret that releases the sign-in proof. A sign-in phished from elsewhere lands on that person's
 * own machine, never here.
 */
export async function listenForCompletion(): Promise<LoopbackCompletion> {
  let expected: string | undefined, received: string | undefined;
  const page = (res: ServerResponse, status: number, title: string, text: string) => {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      connection: "close",
    });
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><p>${omnesisMark} Omnesis</p><h1>${title}</h1><p>${text}</p></main></body></html>`,
    );
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const query = callbackQuery.safeParse(Object.fromEntries(url.searchParams));
    // The Host check keeps a page that rebinds a DNS name to 127.0.0.1 from reaching this listener.
    if (
      req.method !== "GET" ||
      req.headers.host !== `127.0.0.1:${port}` ||
      url.pathname !== CALLBACK_PATH ||
      url.searchParams.size !== 2 ||
      !query.success ||
      query.data.operationId !== expected ||
      received !== undefined
    )
      return page(res, 404, "Not found", "This address only finishes an Omnesis account sign-in.");
    received = query.data.completion;
    page(
      res,
      200,
      "Sign-in finished",
      "Omnesis on this computer has your sign-in. You can close this page and return to the terminal.",
    );
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    completion: () => received,
    expect: (operationId) => {
      expected = operationId;
    },
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/** Interactive sign-in returns short-lived discovery authority only; no account cookie is saved on the desktop. */
export async function authorizeAccountDesktop(
  options: {
    relayUrl: string;
    nonce: string;
    kind: "cli" | "collector";
    name: string;
    signal: AbortSignal;
    /** `connectShortUrl` is for display only; nothing here fetches or trusts it. */
    onConnectCode?(value: { connectUrl: string; connectShortUrl?: string; code: string }): void;
  },
  dependencies: {
    fetch?: typeof fetch;
    openBrowser?: typeof openAccountBrowser;
    wait?: (signal: AbortSignal) => Promise<void>;
    listen?: typeof listenForCompletion;
  } = {},
) {
  const relay = relayOrigin(options.relayUrl),
    verifier = randomBytes(32).toString("base64url");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]);
  // Without a listener the sign-in still works; it just can't join without approval.
  const loopback = await (dependencies.listen ?? listenForCompletion)().catch(() => undefined);
  try {
    return await authorize(options, dependencies, relay, verifier, signal, loopback);
  } finally {
    loopback?.close();
  }
}

async function authorize(
  options: Parameters<typeof authorizeAccountDesktop>[0],
  dependencies: Parameters<typeof authorizeAccountDesktop>[1] & object,
  relay: URL,
  verifier: string,
  signal: AbortSignal,
  loopback: LoopbackCompletion | undefined,
) {
  const post = async (path: string, body: unknown, currentSignal = signal) => {
    currentSignal.throwIfAborted();
    const response = await (dependencies.fetch ?? fetch)(new URL(path, relay), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([currentSignal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok)
      throw new Error("Omnesis account sign-in is unavailable; try again or pair by QR code");
    return readBoundedJson(response);
  };
  const started = Date.now();
  const operation = startSchema.parse(
    await post("/_relay/v3/desktop/start", {
      nonce: opaque.parse(options.nonce),
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      kind: options.kind,
      name: z.string().trim().min(1).max(80).parse(options.name),
      ...(loopback ? { loopbackPort: loopback.port } : {}),
    }),
  );
  loopback?.expect(operation.operationId);
  let complete = false;
  try {
    if (operation.expiresAt * 1000 <= Date.now() || operation.expiresAt * 1000 > started + 301_000)
      throw new Error("Invalid account sign-in expiry");
    const launch = new URL(operation.authorizeUrl);
    if (
      launch.origin !== relay.origin ||
      launch.pathname !== "/_relay/v3/desktop/begin" ||
      launch.username ||
      launch.password ||
      launch.hash ||
      launch.searchParams.size !== 2 ||
      launch.searchParams.get("operationId") !== operation.operationId ||
      !opaque.safeParse(launch.searchParams.get("ticket")).success ||
      launch.searchParams.get("ticket") === operation.ticket
    )
      throw new Error("Invalid account sign-in destination");
    signal.throwIfAborted();
    const connect = new URL(operation.connectUrl);
    if (connect.origin !== relay.origin || connect.pathname !== "/_relay/connect")
      throw new Error("Invalid account sign-in destination");
    options.onConnectCode?.({
      connectUrl: connect.href,
      ...(operation.connectShortUrl ? { connectShortUrl: operation.connectShortUrl } : {}),
      code: operation.code,
    });
    // Over SSH or in a container there is no browser, and the code printed above is the way in.
    await beforeAbort(
      () =>
        (dependencies.openBrowser ?? openAccountBrowser)(launch.href, relay.href).catch(() => {}),
      signal,
    );
    for (;;) {
      signal.throwIfAborted();
      if (operation.expiresAt * 1000 <= Date.now())
        throw new Error("Omnesis account sign-in expired; try again");
      const completion = loopback?.completion();
      const result = z.union([approvedSchema, pendingSchema]).parse(
        await post("/_relay/v3/desktop/redeem", {
          operationId: operation.operationId,
          ticket: operation.ticket,
          verifier,
          ...(completion ? { completion } : {}),
        }),
      );
      signal.throwIfAborted();
      if (result.expiresAt * 1000 <= Date.now() || result.expiresAt > operation.expiresAt)
        throw new Error("Invalid account sign-in expiry");
      if (result.status === "approved") {
        complete = true;
        return result;
      }
      await beforeAbort(
        () => (dependencies.wait ?? ((signal) => delay(1000, undefined, { signal })))(signal),
        signal,
      );
    }
  } finally {
    if (!complete) {
      // Cancellation must not use the already aborted caller signal or replace the original error.
      await post(
        "/_relay/v3/desktop/cancel",
        { operationId: operation.operationId, ticket: operation.ticket },
        AbortSignal.timeout(2000),
      ).catch(() => {});
    }
  }
}

async function beforeAbort<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

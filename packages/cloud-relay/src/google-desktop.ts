// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import {
  beginGoogleAuthorization,
  completeGoogleAuthorization,
  type GoogleCredentials,
} from "./google-oauth.js";
import { googleIdentityProvider, type IdentityProvider } from "./identity.js";
import type { AddressInfo } from "node:net";

/** Launch an external browser without invoking a shell or embedding a user agent. */
export async function openGoogleBrowser(url: string): Promise<void> {
  const target = new URL(url);
  if (target.origin !== "https://accounts.google.com")
    throw new Error("Invalid sign-in destination");
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", target.href] : [target.href];
  const child = spawn(command, args, { stdio: "ignore" });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error("Unable to open the sign-in browser");
}

/** Desktop clients alone may use Google's loopback callback flow. Mobile clients use native callbacks. */
export async function authorizeGoogleDesktop(options: {
  clientId: string;
  nonce: string;
  clientSecret?: string;
  offline?: boolean;
  identity?: IdentityProvider;
  openBrowser?: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<GoogleCredentials> {
  options.signal?.throwIfAborted();
  const identity = options.identity ?? googleIdentityProvider(options.clientId);
  let callback!: (url: string) => void;
  const received = new Promise<string>((resolve) => {
    callback = resolve;
  });
  let expected!: URL;
  let state = "";
  let claimed = false;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    let url: URL;
    try {
      url = new URL(request.url!, "http://127.0.0.1");
    } catch {
      response.writeHead(400).end("Invalid callback");
      return;
    }
    const candidate = Buffer.from(url.searchParams.get("state") ?? "");
    const wanted = Buffer.from(state);
    if (
      claimed ||
      request.method !== "GET" ||
      request.headers.host !== expected.host ||
      url.pathname !== expected.pathname ||
      candidate.length !== wanted.length ||
      !timingSafeEqual(candidate, wanted) ||
      url.searchParams.getAll("state").length !== 1
    ) {
      response.writeHead(404).end("Sign-in callback not found");
      return;
    }
    claimed = true;
    callback(`${expected.origin}${request.url}`);
    response
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("Return to Omnesis to finish sign-in. You may close this window.");
  });
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Google sign-in timed out")), 300_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
  });
  signal.addEventListener("abort", abort, { once: true });
  // A cancellation may occur while the browser is opening; attach the rejection handler immediately.
  const completion = Promise.race([received, aborted]);
  void completion.catch(() => undefined);
  try {
    signal.throwIfAborted();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const authorization = beginGoogleAuthorization({
      clientId: options.clientId,
      redirectUri: `http://127.0.0.1:${port}/google/callback`,
      nonce: options.nonce,
      offline: options.offline,
    });
    expected = new URL(authorization.redirectUri);
    state = authorization.state;
    await Promise.race([(options.openBrowser ?? openGoogleBrowser)(authorization.url), aborted]);
    const callbackUrl = await completion;
    signal.throwIfAborted();
    return await completeGoogleAuthorization({
      authorization,
      callbackUrl,
      identity,
      clientSecret: options.clientSecret,
      fetch: options.fetch,
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

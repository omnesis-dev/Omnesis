// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { RelayError } from "./tunnels.js";
import { brand } from "./relay-page.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoginAdmission } from "./admission.js";
import type { DesktopAccountBrowser } from "./desktop-account-browser.js";

const launch = z
  .object({ operationId: z.string().uuid(), ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();

/** Native requests use explicit capabilities; browser requests receive only host-bound launch state. */
export class DesktopAccountHttp {
  constructor(
    private readonly broker: DesktopAccountBrowser,
    private readonly admission: LoginAdmission,
  ) {}
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url!, "https://relay.invalid");
    if (!url.pathname.startsWith("/_relay/v3/desktop/")) return false;
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (req.url!.length > 2048) throw new RelayError(414, "Desktop sign-in URL is too large");
    if (url.pathname === "/_relay/v3/desktop/complete") {
      if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
      if (url.search) throw new RelayError(400, "Invalid desktop completion URL");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Omnesis account</title><link rel="stylesheet" href="/_relay/account/style.css"></head><body><main>${brand}<h1>You're signed in to your Omnesis account</h1><p>Return to Omnesis in your terminal to choose a gateway. Because this sign-in did not finish on that machine, the gateway will ask you to approve it on your phone or another paired device. You can close this page.</p><p><a href="/_relay/account">Manage sign-in methods</a></p></main></body></html>`,
      );
      return true;
    }
    if (url.pathname === "/_relay/v3/desktop/begin") {
      if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
      const parsed = launch.safeParse(Object.fromEntries(url.searchParams));
      if (url.searchParams.size !== 2 || !parsed.success)
        throw new RelayError(400, "Invalid desktop browser launch");
      return this.admission.run(async () => {
        const result = this.broker.launch(
          parsed.data.operationId,
          parsed.data.ticket,
          req.headers.cookie ?? "",
        );
        res.writeHead(303, { location: result.location, "set-cookie": result.cookie });
        res.end();
        return true;
      }, req);
    }
    if (
      ![
        "/_relay/v3/desktop/start",
        "/_relay/v3/desktop/redeem",
        "/_relay/v3/desktop/cancel",
      ].includes(url.pathname)
    )
      throw new RelayError(404, "Desktop sign-in operation not found");
    if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
    if (
      url.search ||
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-site"] !== undefined
    )
      throw new RelayError(403, "Use native desktop authentication");
    if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      throw new RelayError(415, "JSON desktop request required");
    // Waiting on an operation already started is not a new sign-in attempt.
    return this.admission[url.pathname.endsWith("/start") ? "run" : "poll"](async () => {
      const body = await readBody(req);
      let value;
      if (url.pathname.endsWith("/start")) value = this.broker.start(body);
      else if (url.pathname.endsWith("/redeem")) value = await this.broker.redeem(body);
      else {
        const input = launch.safeParse(body);
        if (!input.success) throw new RelayError(400, "Invalid desktop cancellation");
        this.broker.cancel(input.data.operationId, input.data.ticket);
        value = { ok: true };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
      return true;
    }, req).catch((error: unknown) => {
      req.resume();
      throw error;
    });
  }
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  const deadline = setTimeout(() => req.destroy(new Error("Desktop sign-in body deadline")), 5000);
  deadline.unref();
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      length += Buffer.byteLength(chunk);
      if (length > 8192) throw new RelayError(413, "Desktop sign-in request too large");
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RelayError(400, "Invalid desktop sign-in JSON");
    }
  } finally {
    clearTimeout(deadline);
  }
}

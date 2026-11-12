// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { GOOGLE_BROWSER_PATH } from "./google-browser-contract.js";
import {
  GoogleBrowserBroker,
  type GoogleBrowserBrokerOptions,
  type GoogleBrowserOwnerAuthorization,
} from "./google-browser-broker.js";
import { RelayError } from "./tunnels.js";
import { relayOrigin } from "./network.js";
import type { LoginAdmission } from "./admission.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface GoogleBrowserRoutesOptions extends GoogleBrowserBrokerOptions {
  authenticate(req: IncomingMessage): Promise<GoogleBrowserOwnerAuthorization>;
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new RelayError(415, "JSON required");
  const timeout = setTimeout(() => req.destroy(new Error("Google broker body deadline")), 5000);
  timeout.unref();
  try {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += Buffer.byteLength(chunk);
      if (size > 8192) throw new RelayError(413, "Google browser request is too large");
      parts.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch (error) {
    throw error instanceof RelayError
      ? error
      : new RelayError(400, "Invalid Google browser request");
  } finally {
    clearTimeout(timeout);
  }
}

/** HTTP carries only broker coordination; application/device credentials never enter redirects. */
export class GoogleBrowserRoutes {
  private readonly broker: GoogleBrowserBroker;
  constructor(
    private readonly options: GoogleBrowserRoutesOptions,
    private readonly admission: LoginAdmission,
  ) {
    this.broker = new GoogleBrowserBroker(options);
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const raw = req.url!;
    const path = raw.split("?")[0]!;
    if (!path.startsWith(GOOGLE_BROWSER_PATH + "/")) return false;
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (raw.length > 16_384) throw new RelayError(414, "Google browser URL is too large");
    const origin = relayOrigin(
      typeof this.options.origin === "string" ? this.options.origin : this.options.origin(),
    ).origin;
    const url = new URL(raw, origin);
    if (path === GOOGLE_BROWSER_PATH + "/config") {
      if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(this.broker.configuration()));
      return true;
    }
    if (path === GOOGLE_BROWSER_PATH + "/begin") {
      if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
      return this.admission.run(async () => {
        const operations = url.searchParams.getAll("operationId"),
          tickets = url.searchParams.getAll("ticket");
        if (
          operations.length !== 1 ||
          tickets.length !== 1 ||
          [...url.searchParams.keys()].length !== 2
        )
          throw new RelayError(400, "Invalid Google browser launch");
        let input: { operationId: string; ticket: string };
        try {
          input = z
            .object({
              operationId: z.string().uuid(),
              ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            })
            .parse({ operationId: operations[0], ticket: tickets[0] });
        } catch {
          throw new RelayError(400, "Invalid Google browser launch");
        }
        const result = this.broker.launch(input.operationId, input.ticket);
        res.writeHead(303, { location: result.authorizeUrl, "set-cookie": result.cookie });
        res.end();
        return true;
      }, req);
    }
    if (path === GOOGLE_BROWSER_PATH + "/callback") {
      if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
      return this.admission.run(async () => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once("close", abort);
        try {
          const result = await this.broker.callback(
            url,
            req.headers.cookie ?? "",
            controller.signal,
          );
          res.writeHead(303, { location: result.redirectUrl, "set-cookie": result.cookie });
          res.end();
          return true;
        } finally {
          res.off("close", abort);
        }
      }, req);
    }
    if (path === GOOGLE_BROWSER_PATH + "/start" || path === GOOGLE_BROWSER_PATH + "/redeem") {
      if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
      return this.admission.run(async () => {
        const owner = await this.options.authenticate(req);
        const body = await jsonBody(req);
        const result = path.endsWith("/start")
          ? this.broker.start(owner, body)
          : this.broker.redeem(owner, body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return true;
      }, req);
    }
    throw new RelayError(404, "Unknown Google browser endpoint");
  }
  close(): void {
    this.broker.close();
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import {
  ACCOUNT_BROWSER_PATH,
  ACCOUNT_CREDENTIALS_EVIDENCE,
  type AccountBrowserOwner,
} from "./account-browser-contract.js";
import { RelayError } from "./tunnels.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountBrowserBroker } from "./account-browser-broker.js";
import type { LoginAdmission } from "./admission.js";

const launch = z
  .object({ operationId: z.string().uuid(), ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const cancel = z.object({ operationId: z.string().uuid() }).strict();
const empty = z.object({}).strict();

/** A gateway authenticates control requests; browser navigation carries a single-use launch capability only. */
export class AccountBrowserHttp {
  constructor(
    private readonly options: {
      broker: AccountBrowserBroker;
      admission: LoginAdmission;
      authenticateOwner(
        req: IncomingMessage,
      ): Promise<AccountBrowserOwner & { sessionExpiresAt: number }>;
    },
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url!, "https://relay.invalid");
    if (!url.pathname.startsWith(ACCOUNT_BROWSER_PATH + "/")) return false;
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (req.url!.length > 4096) throw new RelayError(414, "Account browser URL is too large");
    if (url.pathname === ACCOUNT_BROWSER_PATH + "/begin") {
      if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
      if (
        url.searchParams.size !== 2 ||
        url.searchParams.getAll("operationId").length !== 1 ||
        url.searchParams.getAll("ticket").length !== 1
      )
        throw new RelayError(400, "Invalid account browser launch");
      const input = launch.safeParse(Object.fromEntries(url.searchParams));
      if (!input.success) throw new RelayError(400, "Invalid account browser launch");
      return this.options.admission.run(async () => {
        const result = this.options.broker.launch(input.data.operationId, input.data.ticket);
        res.writeHead(303, { location: result.location, "set-cookie": result.cookie });
        res.end();
        return true;
      }, req);
    }
    if (url.pathname === ACCOUNT_BROWSER_PATH + "/credentials") {
      if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
      if (url.search) throw new RelayError(400, "Account credentials take no query parameters");
      const credentials = this.options.broker.credentials(
        await this.options.authenticateOwner(req),
        {
          countersignatures:
            req.headers[ACCOUNT_CREDENTIALS_EVIDENCE.header] ===
            ACCOUNT_CREDENTIALS_EVIDENCE.countersignatures,
        },
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(credentials));
      return true;
    }
    if (
      !["start", "redeem", "cancel", "unlink"].some(
        (suffix) => url.pathname === `${ACCOUNT_BROWSER_PATH}/${suffix}`,
      )
    )
      throw new RelayError(404, "Account browser operation not found");
    if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
    if (url.search)
      throw new RelayError(400, "Account browser operation does not accept query parameters");
    if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      throw new RelayError(415, "JSON account browser request required");
    return this.options.admission
      .run(async () => {
        const owner = await this.options.authenticateOwner(req),
          body = await jsonBody(req);
        let result: unknown;
        if (url.pathname === ACCOUNT_BROWSER_PATH + "/start")
          result = this.options.broker.start(owner, body);
        else if (url.pathname === ACCOUNT_BROWSER_PATH + "/redeem")
          result = this.options.broker.redeem(owner, body);
        else if (url.pathname === ACCOUNT_BROWSER_PATH + "/unlink") {
          if (!empty.safeParse(body).success)
            throw new RelayError(400, "Invalid account unlink request");
          this.options.broker.unlink(owner);
          result = { ok: true };
        } else {
          const input = cancel.safeParse(body);
          if (!input.success) throw new RelayError(400, "Invalid account browser cancellation");
          this.options.broker.cancel(owner, input.data.operationId);
          result = { ok: true };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return true;
      }, req)
      .catch((error: unknown) => {
        req.resume();
        throw error;
      });
  }
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const deadline = setTimeout(() => req.destroy(new Error("Account browser body deadline")), 5000);
  deadline.unref();
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      length += Buffer.byteLength(chunk);
      if (length > 8192) throw new RelayError(413, "Account browser request too large");
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RelayError(400, "Invalid account browser JSON");
    }
  } finally {
    clearTimeout(deadline);
  }
}

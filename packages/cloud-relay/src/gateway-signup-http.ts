// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { GATEWAY_SIGNUP_PATH } from "./gateway-signup-contract.js";
import { readJsonBody } from "./relay-json-body.js";
import { RelayError } from "./tunnels.js";
import { brand } from "./relay-page.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountBrowserOwner } from "./account-browser-contract.js";
import type { LoginAdmission } from "./admission.js";
import type { GatewaySignup } from "./gateway-signup.js";

const launch = z
  .object({ operationId: z.string().uuid(), ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const complete = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Omnesis account</title><link rel="stylesheet" href="/_relay/account/style.css"></head><body><main>${brand}<h1>You're all set</h1><p>Go back to your gateway. It will finish connecting to your Omnesis account on its own. You can close this page.</p></main></body></html>`;
const refusal = JSON.stringify({
  reason: "invitation-required",
  message: "This relay connects new gateways by invitation only. Ask its operator for one.",
});

/** The gateway has no relay session yet, so its owner signature and redemption secret stand in. */
export class GatewaySignupHttp {
  constructor(
    private readonly options: {
      signup: GatewaySignup;
      admission: LoginAdmission;
      authenticateOwner(req: IncomingMessage): Promise<AccountBrowserOwner>;
    },
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url!, "https://relay.invalid");
    if (!url.pathname.startsWith(GATEWAY_SIGNUP_PATH + "/")) return false;
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (!this.options.signup.enabled()) {
      req.resume();
      res.writeHead(403, { "content-type": "application/json" });
      res.end(refusal);
      return true;
    }
    if (req.url!.length > 2048) throw new RelayError(414, "Gateway signup URL is too large");
    const action = url.pathname.slice(GATEWAY_SIGNUP_PATH.length + 1);
    if (action === "complete") {
      if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
      if (url.search) throw new RelayError(400, "Invalid gateway signup completion URL");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(complete);
      return true;
    }
    if (action === "begin") {
      if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
      const parsed = launch.safeParse(Object.fromEntries(url.searchParams));
      if (url.searchParams.size !== 2 || !parsed.success)
        throw new RelayError(400, "Invalid gateway signup launch");
      return this.options.admission.run(async () => {
        const result = this.options.signup.launch(
          parsed.data.operationId,
          parsed.data.ticket,
          req.headers.cookie ?? "",
        );
        res.writeHead(303, { location: result.location, "set-cookie": result.cookie });
        res.end();
        return true;
      }, req);
    }
    if (!["start", "poll", "link", "cancel"].includes(action))
      throw new RelayError(404, "Gateway signup operation not found");
    if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
    if (
      url.search ||
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-site"] !== undefined
    )
      throw new RelayError(403, "Use your gateway to connect");
    if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      throw new RelayError(415, "JSON gateway signup request required");
    // Waiting on an operation already started is not a new sign-in attempt.
    return this.options.admission[action === "poll" || action === "cancel" ? "poll" : "run"](
      async () => {
        const owner = action === "link" ? await this.options.authenticateOwner(req) : undefined;
        const body = await readJsonBody(req, 8192);
        let value: unknown;
        if (action === "start") value = this.options.signup.start(body);
        else if (action === "poll") value = this.options.signup.poll(body);
        else if (owner) value = await this.options.signup.link(owner, body);
        else {
          this.options.signup.cancel(body);
          value = { ok: true };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
        return true;
      },
      req,
    ).catch((error: unknown) => {
      req.resume();
      throw error;
    });
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { GATEWAY_SIGNUP_ACCESS_PATH, GATEWAY_SIGNUP_PATH } from "./gateway-signup-contract.js";
import { readJsonBody } from "./relay-json-body.js";
import { RelayError } from "./tunnels.js";
import { brand } from "./relay-page.js";
import { LaunchTaken, readLaunchForm, sendLaunchPage, sendTakenPage } from "./browser-launch.js";
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

const restart =
  "To use this browser instead, go back to your gateway, press Cancel and connect again.";

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
    if (url.pathname === GATEWAY_SIGNUP_ACCESS_PATH) {
      // Public: whether accounts need approval and where to ask, so a gateway can say so up front.
      if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
      if (url.search) throw new RelayError(400, "Invalid signup access request");
      const access = this.options.signup.access();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(access ? { signup: access } : {}));
      return true;
    }
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
    if (action === "begin") return this.begin(req, res, url);
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

  /**
   * Opening the link changes nothing; the Continue press binds the sign-up to this browser (F43).
   */
  private async begin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const signup = this.options.signup;
    if (req.method === "GET") {
      const parsed = launch.safeParse(Object.fromEntries(url.searchParams));
      if (url.searchParams.size !== 2 || !parsed.success)
        throw new RelayError(400, "Invalid gateway signup launch");
      // Reading changes nothing, so it is bounded but not counted as a sign-in attempt.
      return this.options.admission.poll(async () => {
        const { operationId, ticket } = parsed.data;
        const view = signup.peekLaunch(operationId, ticket, req.headers.cookie ?? "");
        if (view.state === "here") {
          res.writeHead(303, { location: view.location });
          res.end();
        } else if (view.state === "taken") sendTakenPage(res, restart);
        else sendLaunchPage(res, GATEWAY_SIGNUP_PATH + "/begin", { operationId, ticket });
        return true;
      }, req);
    }
    if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
    if (url.search) throw new RelayError(400, "Invalid gateway signup launch");
    return this.options.admission
      .run(async () => {
        const parsed = launch.safeParse(
          await readLaunchForm(req, signup.origin, { required: ["operationId", "ticket"] }),
        );
        if (!parsed.success) throw new RelayError(400, "Invalid gateway signup launch");
        let result: { location: string; cookie?: string };
        try {
          result = signup.launch(
            parsed.data.operationId,
            parsed.data.ticket,
            req.headers.cookie ?? "",
          );
        } catch (error) {
          if (!(error instanceof LaunchTaken)) throw error;
          sendTakenPage(res, restart);
          return true;
        }
        res.writeHead(303, {
          location: result.location,
          ...(result.cookie ? { "set-cookie": result.cookie } : {}),
        });
        res.end();
        return true;
      }, req)
      .catch((error: unknown) => {
        req.resume();
        throw error;
      });
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { NoAccount } from "./account-admission.js";
import { LoginAdmission } from "./admission.js";
import { RelayError } from "./tunnels.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NativeAccountAuthentication } from "./native-account-authentication.js";

const operation = {
  operationId: z.string().uuid(),
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
};
const verifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const operationSchema = z.object(operation).strict();
const googleSchema = z
  .object({ ...operation, verifier, idToken: z.string().min(1).max(16_384) })
  .strict();
const passkeySchema = z
  .object({
    ...operation,
    verifier,
    ceremonyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    credential: z.unknown(),
  })
  .strict();
const paths = new Set(
  ["start", "google", "passkeys/options", "passkeys/complete", "cancel"].map(
    (value) => `/_relay/v3/native/${value}`,
  ),
);

/** Native credential exchange uses operation capabilities, never ambient browser cookies or redirects. */
export class NativeAccountHttp {
  constructor(
    private readonly authentication: NativeAccountAuthentication,
    private readonly admission = new LoginAdmission(),
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url!, "https://relay.invalid");
    if (!url.pathname.startsWith("/_relay/v3/native/")) return false;
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (!paths.has(url.pathname)) throw new RelayError(404, "Native account operation not found");
    if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
    if (url.search)
      throw new RelayError(400, "Native account operation does not accept query parameters");
    if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined)
      throw new RelayError(403, "Use native account authentication");
    if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      throw new RelayError(415, "JSON native account request required");
    return this.admission
      .run(async () => {
        const body = await jsonBody(req);
        let value: unknown;
        if (url.pathname === "/_relay/v3/native/start") value = this.authentication.start(body);
        else if (url.pathname === "/_relay/v3/native/google") {
          const input = parse(googleSchema, body);
          value = await this.authentication.google(
            input.operationId,
            input.ticket,
            input.verifier,
            input.idToken,
          );
        } else if (url.pathname === "/_relay/v3/native/passkeys/complete") {
          const input = parse(passkeySchema, body);
          value = await this.authentication.passkey(
            input.operationId,
            input.ticket,
            input.verifier,
            input.ceremonyId,
            input.credential,
          );
        } else {
          const input = parse(operationSchema, body);
          if (url.pathname === "/_relay/v3/native/passkeys/options")
            value = await this.authentication.passkeyOptions(input.operationId, input.ticket);
          else {
            this.authentication.cancel(input.operationId, input.ticket);
            value = { ok: true };
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
        return true;
      }, req)
      .catch((error: unknown) => {
        req.resume();
        // The one refusal an app acts on: it offers to create an account instead of failing.
        if (!(error instanceof NoAccount)) throw error;
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no-account" }));
        return true;
      });
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const input = schema.safeParse(value);
  if (!input.success) throw new RelayError(400, "Invalid native account request");
  return input.data;
}
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += Buffer.byteLength(chunk);
    if (length > 65_536) throw new RelayError(413, "Native account request too large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RelayError(400, "Invalid native account JSON");
  }
}

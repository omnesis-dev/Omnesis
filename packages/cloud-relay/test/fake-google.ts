// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { exportJWK, jwtVerify, SignJWT } from "jose";
import { closeServer, listen } from "./support.js";

/** A person signing in at the fake Google: who they are and what Google says about their email. */
export interface FakeGoogleSignIn {
  subject: string;
  email?: string;
  emailVerified?: boolean;
}

/**
 * One loopback server for every Google endpoint the relay calls: the browser sign-in, the token
 * endpoint (authorization code and the service account's JWT bearer grant), the ID token keys and
 * the Cloud Identity Groups API. Each knob is a plain field a test changes between steps.
 */
export class FakeGoogle {
  readonly webClientId = "fictional-relay-web.apps.example.test";
  readonly webClientSecret = "fictional-relay-web-secret";
  readonly serviceAccountEmail = "signup-checker@fictional-project.example.test";
  readonly groupEmail: string;
  readonly groupName = "groups/fixture01";
  /** Direct members, and members only through a nested group. Lower-case, as Google matches. */
  readonly members = new Set<string>();
  readonly nested = new Set<string>();
  /** An HTTP status to answer a step with instead of its normal reply. */
  readonly failures: { token?: number; group?: number; lookup?: number; nested?: number } = {};
  /** Every request's method and raw path, in order. */
  readonly requests: string[] = [];
  /** Every browser authorization request's parameters, in order. */
  readonly authorizations: URLSearchParams[] = [];
  /** Who signs in at the next browser authorization. */
  nextSignIn: FakeGoogleSignIn = { subject: "fictional-google-subject" };
  tokensIssued = 0;
  url = "";
  private readonly serviceKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly accessTokens = new Set<string>();
  private readonly codes = new Map<string, { signIn: FakeGoogleSignIn; nonce: string }>();
  private readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  private constructor(groupEmail: string) {
    this.groupEmail = groupEmail;
  }

  static async start(groupEmail = "testers@example.com"): Promise<FakeGoogle> {
    const google = new FakeGoogle(groupEmail);
    google.url = await listen(google.server);
    return google;
  }

  /** The JSON key Google gives for a service account, as the relay's secret file holds it. */
  serviceAccountKey(): Record<string, string> {
    return {
      type: "service_account",
      project_id: "fictional-project",
      private_key_id: "fixturekey01",
      private_key: this.serviceKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      client_email: this.serviceAccountEmail,
      client_id: "100000000000000000001",
      token_uri: "https://oauth2.googleapis.com/token",
    };
  }

  /** Only the Groups API calls, which a test counts. */
  groupApiRequests(): string[] {
    return this.requests.filter((value) => value.includes(" /v1/"));
  }

  async close(): Promise<void> {
    if (this.server.listening) await closeServer(this.server);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url!, this.url);
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        body === undefined ? JSON.stringify({ error: { code: status } }) : JSON.stringify(body),
      );
    };
    if (req.method === "GET" && url.pathname === "/o/oauth2/v2/auth") {
      this.authorizations.push(url.searchParams);
      const code = randomBytes(16).toString("hex");
      this.codes.set(code, { signIn: this.nextSignIn, nonce: url.searchParams.get("nonce")! });
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.search = new URLSearchParams({
        state: url.searchParams.get("state")!,
        code,
      }).toString();
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/oauth2/v3/certs") {
      const jwk = await exportJWK(this.signingKey.publicKey);
      return send(200, { keys: [{ ...jwk, kid: "fixture-google", alg: "RS256", use: "sig" }] });
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      if (form.get("grant_type") === "authorization_code") {
        const pending = this.codes.get(form.get("code") ?? "");
        this.codes.delete(form.get("code") ?? "");
        if (!pending || form.get("client_id") !== this.webClientId) return send(400);
        const { signIn } = pending;
        const idToken = await new SignJWT({
          nonce: pending.nonce,
          azp: this.webClientId,
          ...(signIn.email === undefined
            ? {}
            : { email: signIn.email, email_verified: signIn.emailVerified ?? true }),
        })
          .setProtectedHeader({ alg: "RS256", kid: "fixture-google" })
          .setIssuer("https://accounts.google.com")
          .setAudience(this.webClientId)
          .setSubject(signIn.subject)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(this.signingKey.privateKey);
        return send(200, { id_token: idToken, access_token: "unused", token_type: "Bearer" });
      }
      if (this.failures.token) return send(this.failures.token);
      try {
        const { payload } = await jwtVerify(
          form.get("assertion") ?? "",
          this.serviceKey.publicKey,
          {
            issuer: this.serviceAccountEmail,
            audience: "https://oauth2.googleapis.com/token",
            algorithms: ["RS256"],
          },
        );
        if (
          form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
          payload.scope !== "https://www.googleapis.com/auth/cloud-identity.groups.readonly"
        )
          throw new Error("unexpected grant");
      } catch {
        return send(400, { error: "invalid_grant" });
      }
      const token = `fixture-access-${++this.tokensIssued}`;
      this.accessTokens.add(token);
      return send(200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
    }
    if (req.method !== "GET" || !url.pathname.startsWith("/v1/")) return send(404);
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    if (!bearer || !this.accessTokens.has(bearer)) return send(401);
    if (url.pathname === "/v1/groups:lookup") {
      if (this.failures.group) return send(this.failures.group);
      return url.searchParams.get("groupKey.id") === this.groupEmail
        ? send(200, { name: this.groupName })
        : send(404);
    }
    if (url.pathname === `/v1/${this.groupName}/memberships:lookup`) {
      if (this.failures.lookup) return send(this.failures.lookup);
      return this.members.has(url.searchParams.get("memberKey.id") ?? "")
        ? send(200, { name: `${this.groupName}/memberships/fixture02` })
        : send(404);
    }
    if (url.pathname === `/v1/${this.groupName}/memberships:checkTransitiveMembership`) {
      if (this.failures.nested) return send(this.failures.nested);
      const match = /^member_key_id == '((?:[^'\\]|\\.)*)'$/.exec(
        url.searchParams.get("query") ?? "",
      );
      if (!match) return send(400);
      const member = match[1]!.replace(/\\(.)/g, "$1");
      // proto3 JSON leaves a false boolean out.
      return send(
        200,
        this.members.has(member) || this.nested.has(member) ? { hasMembership: true } : {},
      );
    }
    return send(404);
  }
}

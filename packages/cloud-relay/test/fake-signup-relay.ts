// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { AccountEnrollmentAuthority } from "../src/account-enrollment-proof.js";
import { passkeyProofChallenge } from "../src/device-enrollment.js";
import { gatewayKeyAccount } from "../src/gateway-key-auth.js";
import { passkeyAuthenticator } from "./passkey-authenticator.js";

export const signupRelayOrigin = "https://relay.example.test";

type PollReply =
  | { status: "pending" }
  | { status: "denied"; reason: "not-allowed" | "capacity" }
  | { status: "approved"; credentialPublicKey?: string }
  | { status: "unavailable" };

/**
 * The relay's side of connecting by sign-in, held in memory. It signs real link
 * attestations and a real passkey registration bound to the gateway's nonce, so
 * the gateway's checks run unmodified.
 */
export function fakeSignupRelay(
  options: {
    accountId?: string;
    /** The account the sign-in approval names, when it should differ from the link. */
    approvedAccountId?: string;
    /** The subject of the link attestation, when it should differ from the link reply. */
    linkedAccountId?: string;
    startedExpiresAt?: (requested: number) => number;
    started?: (body: Record<string, unknown>) => Record<string, unknown>;
  } = {},
) {
  const authority = new AccountEnrollmentAuthority(
    signupRelayOrigin,
    generateKeyPairSync("ed25519").privateKey,
  );
  const accountId = options.accountId ?? "d".repeat(64);
  const authenticator = passkeyAuthenticator();
  const polls: PollReply[] = [];
  let started: Record<string, unknown> | undefined;
  const calls: string[] = [];
  const handlers = new Map<string, (body: Record<string, unknown>) => Response>();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const custom = handlers.get(url.pathname);
    if (custom) return custom(body);
    switch (url.pathname) {
      case "/_relay/v3/signup/start": {
        started = body;
        const reply = {
          protocol: body.protocol,
          operationId: body.operationId,
          authorizeUrl: `${signupRelayOrigin}/_relay/v3/signup/begin?operationId=${String(body.operationId)}`,
          connectUrl: `${signupRelayOrigin}/_relay/connect`,
          code: "ABCD-EF23",
          expiresAt: options.startedExpiresAt?.(body.expiresAt as number) ?? body.expiresAt,
        };
        return Response.json(options.started?.(reply) ?? reply);
      }
      case "/_relay/v3/signup/poll": {
        const next = polls.length > 1 ? polls.shift()! : (polls[0] ?? { status: "pending" });
        if (next.status === "unavailable") return new Response(null, { status: 503 });
        if (next.status === "pending")
          return Response.json({ status: "pending", expiresAt: started!.expiresAt });
        if (next.status === "denied") return Response.json(next);
        const salt = randomBytes(32).toString("base64url"),
          issuedAt = String(Math.floor(Date.now() / 1000));
        return Response.json({
          status: "approved",
          enrollmentToken: "fictional-invitation",
          accountId: options.approvedAccountId ?? accountId,
          signInProof: {
            type: "passkey-registration",
            salt,
            issuedAt,
            credential: authenticator.registration(
              passkeyProofChallenge(salt, issuedAt, String(started!.nonce)),
            ),
          },
          ...(next.credentialPublicKey ? { credentialPublicKey: next.credentialPublicKey } : {}),
        });
      }
      case "/_relay/v3/signup/link": {
        const linked = options.linkedAccountId ?? accountId;
        return Response.json({
          accountId,
          identityToken: await authority.issueGatewayLink({
            accountId: linked,
            gatewayId: String(started!.gatewayId),
            ownerAccountId: gatewayKeyAccount({
              gatewayId: String(started!.gatewayId),
              ownerPublicKey: String(started!.ownerPublicKey),
            }),
            nonce: String(started!.nonce),
          }),
        });
      }
      case "/_relay/v3/signup/cancel":
        return Response.json({ ok: true });
      case "/_relay/v3/account-keys":
        return Response.json(authority.jwks());
      default:
        return new Response(null, { status: 404 });
    }
  };
  return {
    accountId,
    authenticator,
    calls,
    started: () => started,
    /** Replies are used in order; the last one repeats. */
    poll(...replies: PollReply[]) {
      polls.splice(0, polls.length, ...replies);
    },
    handle(path: string, handler: (body: Record<string, unknown>) => Response) {
      handlers.set(path, handler);
    },
    fetch: fetch as typeof globalThis.fetch,
  };
}

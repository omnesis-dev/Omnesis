// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Identity, IdentityProvider } from "./identity.js";

export interface GoogleAuthorization {
  url: string;
  clientId: string;
  redirectUri: string;
  state: string;
  verifier: string;
  nonce: string;
  expiresAt: number;
}
const usedAuthorizations = new WeakSet<GoogleAuthorization>();

/** Native apps use public OAuth clients and a system browser; secrets stay on web backends. */
export function beginGoogleAuthorization(options: {
  clientId: string;
  redirectUri: string;
  nonce: string;
  offline?: boolean;
}): GoogleAuthorization {
  z.string().min(1).max(512).parse(options.clientId);
  z.string().min(16).max(256).parse(options.nonce);
  const redirect = new URL(options.redirectUri);
  if (
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    !(
      (redirect.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(redirect.hostname)) ||
      redirect.protocol === "https:" ||
      (redirect.protocol.startsWith("com.googleusercontent.apps.") && redirect.hostname === "")
    )
  )
    throw new Error("Unsupported Google callback URI");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  for (const [key, value] of Object.entries({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: "openid",
    state,
    nonce: options.nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...(options.offline ? { access_type: "offline", prompt: "consent" } : {}),
  }))
    url.searchParams.set(key, value);
  return {
    url: url.href,
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    state,
    verifier,
    nonce: options.nonce,
    expiresAt: Date.now() + 300_000,
  };
}

const googleTokens = z.object({
  id_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(8192).optional(),
  token_type: z.literal("Bearer"),
});
export interface GoogleCredentials {
  idToken: string;
  identity: Identity;
  refreshToken?: string;
}

export async function completeGoogleAuthorization(options: {
  authorization: GoogleAuthorization;
  callbackUrl: string;
  identity: IdentityProvider;
  clientSecret?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<GoogleCredentials> {
  const { authorization } = options;
  const callback = new URL(options.callbackUrl);
  const expected = new URL(authorization.redirectUri);
  if (
    usedAuthorizations.has(authorization) ||
    callback.origin !== expected.origin ||
    callback.host !== expected.host ||
    callback.protocol !== expected.protocol ||
    callback.pathname !== expected.pathname ||
    callback.hash ||
    callback.username ||
    callback.password ||
    authorization.expiresAt <= Date.now()
  )
    throw new Error("Invalid or expired Google callback");
  for (const key of ["state", "code", "error"]) {
    if (callback.searchParams.getAll(key).length > 1) throw new Error("Ambiguous Google callback");
  }
  const state = Buffer.from(callback.searchParams.get("state") ?? "");
  const wanted = Buffer.from(authorization.state);
  if (state.length !== wanted.length || !timingSafeEqual(state, wanted))
    throw new Error("Google sign-in state mismatch");
  const code = callback.searchParams.get("code");
  if (!code || code.length > 8192 || callback.searchParams.has("error"))
    throw new Error("Google sign-in was not completed");
  const body = new URLSearchParams({
    client_id: authorization.clientId,
    redirect_uri: authorization.redirectUri,
    code,
    code_verifier: authorization.verifier,
    grant_type: "authorization_code",
    ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
  });
  usedAuthorizations.add(authorization);
  return exchange(
    body,
    authorization.nonce,
    options.identity,
    options.fetch ?? fetch,
    options.signal,
  );
}

/** Routing refresh does not establish a gateway key. Supplying a nonce requires a fresh matching proof. */
export async function refreshGoogleAuthorization(options: {
  clientId: string;
  refreshToken: string;
  nonce?: string;
  identity: IdentityProvider;
  clientSecret?: string;
  fetch?: typeof fetch;
}): Promise<GoogleCredentials> {
  const result = await exchange(
    new URLSearchParams({
      client_id: options.clientId,
      refresh_token: options.refreshToken,
      grant_type: "refresh_token",
      ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
    }),
    options.nonce,
    options.identity,
    options.fetch ?? fetch,
  );
  return { ...result, refreshToken: result.refreshToken ?? options.refreshToken };
}

async function exchange(
  body: URLSearchParams,
  nonce: string | undefined,
  identity: IdentityProvider,
  transport: typeof fetch,
  signal?: AbortSignal,
): Promise<GoogleCredentials> {
  const response = await transport("https://oauth2.googleapis.com/token", {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Google token exchange failed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 32_768) throw new Error("Google token response too large");
    chunks.push(chunk);
  }
  const result = googleTokens.parse(JSON.parse(Buffer.concat(chunks).toString()));
  const verified = await identity.verify(result.id_token, nonce);
  return {
    idToken: result.id_token,
    identity: verified,
    ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
  };
}

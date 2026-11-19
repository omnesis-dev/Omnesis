// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile, atomicWriteFileSync, readWindowsPrivateFile } from "@omnesis/core";
import { z } from "zod";
import { accountId, googleIdentityProvider, type IdentityProvider } from "./identity.js";
import { refreshGoogleAuthorization, type GoogleCredentials } from "./google-oauth.js";
import { relayOrigin } from "./network.js";

const storedSchema = z
  .object({
    version: z.literal(1),
    clientId: z.string().min(1).max(512),
    accountId: z.string().regex(/^[a-f0-9]{64}$/),
    idToken: z.string().min(1).max(16_384),
    refreshToken: z.string().min(1).max(8192).optional(),
  })
  .strict();
const relaySessionSchema = z.object({
  token: z.string().min(1).max(4096),
  expiresAt: z.number().int().positive(),
  accountId: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function readPrivateJson(path: string): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (process.platform === "win32") {
    chunks.push(await readWindowsPrivateFile(path, 65_536));
  } else {
    for await (const chunk of createReadStream(path)) {
      size += chunk.length;
      if (size > 65_536) throw new Error("Credential file is too large");
      chunks.push(chunk);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid private credential file");
  }
}

export async function savePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, JSON.stringify(value) + "\n", { mode: 0o600 });
}

export async function readGoogleDesktopSecret(path: string, clientId: string): Promise<string> {
  return z
    .object({
      installed: z.object({
        client_id: z.literal(clientId),
        client_secret: z.string().min(1).max(8192),
      }),
    })
    .parse(await readPrivateJson(path)).installed.client_secret;
}

/** Store only on the user's gateway/desktop, never on a relay or in a mobile bundle. */
export async function saveGoogleCredentials(
  path: string,
  clientId: string,
  credentials: GoogleCredentials,
): Promise<void> {
  await savePrivateJson(
    path,
    storedSchema.parse({
      version: 1,
      clientId,
      accountId: accountId(credentials.identity),
      idToken: credentials.idToken,
      ...(credentials.refreshToken ? { refreshToken: credentials.refreshToken } : {}),
    }),
  );
}

/** Refresh authenticates routing identity only; it cannot establish or replace an encryption pin. */
export function googleRoutingTokenSource(options: {
  credentialsFile: string;
  clientId: string;
  clientSecret?: string;
  clientSecretFile?: string;
  identity?: IdentityProvider;
  fetch?: typeof fetch;
}): () => Promise<{ idToken: string; accountId: string; expiresAt: number }> {
  const identity = options.identity ?? googleIdentityProvider(options.clientId);
  let pending: Promise<{ idToken: string; accountId: string; expiresAt: number }> | undefined;
  const load = async () => {
    const stored = storedSchema.parse(await readPrivateJson(options.credentialsFile));
    if (stored.clientId !== options.clientId)
      throw new Error("Google OAuth client changed; sign in again");
    try {
      const verified = await identity.verify(stored.idToken);
      if (accountId(verified) !== stored.accountId) throw new Error("Google account changed");
      if (verified.expiresAt > Date.now() / 1000 + 60)
        return {
          idToken: stored.idToken,
          accountId: stored.accountId,
          expiresAt: verified.expiresAt,
        };
    } catch {
      // A refreshed, independently verified token must still match the originally paired account.
    }
    if (!stored.refreshToken) throw new Error("Google sign-in expired; sign in again");
    const secret =
      options.clientSecret ??
      (options.clientSecretFile
        ? await readGoogleDesktopSecret(options.clientSecretFile, options.clientId)
        : undefined);
    const refreshed = await refreshGoogleAuthorization({
      clientId: options.clientId,
      refreshToken: stored.refreshToken,
      identity,
      clientSecret: secret,
      fetch: options.fetch,
    });
    if (accountId(refreshed.identity) !== stored.accountId)
      throw new Error("Google account changed; sign in again");
    await saveGoogleCredentials(options.credentialsFile, options.clientId, refreshed);
    return {
      idToken: refreshed.idToken,
      accountId: stored.accountId,
      expiresAt: refreshed.identity.expiresAt,
    };
  };
  return () =>
    (pending ??= load().finally(() => {
      pending = undefined;
    }));
}

/** Relay sessions route encrypted streams; the returned token is never sent to a gateway data connection. */
export async function exchangeRelayIdentity(options: {
  relayUrl: string;
  idToken: string;
  expectedAccountId: string;
  sessionFile: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<z.infer<typeof relaySessionSchema>> {
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(15_000),
  ]);
  signal.throwIfAborted();
  const response = await (options.fetch ?? fetch)(
    new URL("/_relay/v1/login", relayOrigin(options.relayUrl)),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: options.idToken }),
      redirect: "error",
      signal,
    },
  );
  if (!response.ok) throw new Error("Relay sign-in failed");
  const session = relaySessionSchema.parse(await readBoundedJson(response));
  if (session.accountId !== options.expectedAccountId || session.expiresAt <= Date.now() / 1000)
    throw new Error("Relay returned an invalid account session");
  await mkdir(dirname(options.sessionFile), { recursive: true, mode: 0o700 });
  signal.throwIfAborted();
  // Publishing this bounded credential record must not yield between the abort check and rename.
  atomicWriteFileSync(options.sessionFile, JSON.stringify(session) + "\n", { mode: 0o600 });
  return session;
}

export async function readBoundedJson(response: Response, limit = 65_536): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error("Relay response is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** A single-flight source keeps long-running outbound control connections authenticated. */
export function googleRelaySessionSource(options: {
  credentialsFile: string;
  clientId: string;
  clientSecret?: string;
  clientSecretFile?: string;
  relayUrl: string;
  sessionFile: string;
  identity?: IdentityProvider;
  fetch?: typeof fetch;
}): () => Promise<string> {
  const tokens = googleRoutingTokenSource(options);
  let current: z.infer<typeof relaySessionSchema> | undefined;
  let pending: Promise<string> | undefined;
  return () => {
    if (current && current.expiresAt > Date.now() / 1000 + 30)
      return Promise.resolve(current.token);
    return (pending ??= tokens()
      .then((token) =>
        exchangeRelayIdentity({
          ...options,
          idToken: token.idToken,
          expectedAccountId: token.accountId,
        }),
      )
      .then((session) => {
        current = session;
        return session.token;
      })
      .finally(() => {
        pending = undefined;
      }));
  };
}

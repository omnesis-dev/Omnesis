// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { decodeJwt, importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { readPrivateJson } from "./google-credentials.js";

const log = createLogger("cloud-relay:signup-group");

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CLOUD_IDENTITY_URL = "https://cloudidentity.googleapis.com/v1";
export const GROUPS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/cloud-identity.groups.readonly";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
/** A token is renewed this long before Google says it expires. */
const TOKEN_MARGIN_MS = 60_000;
/** How long a refused nested check stays skipped before it is tried again. */
const NESTED_RETRY_MS = 3_600_000;

/** Percent-encodes a query value completely, quotes included, so the request is exactly this. */
const component = (value: string) => encodeURIComponent(value).replace(/'/g, "%27");
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Google compares addresses without case; anything else is not an address to ask about. */
export function normalizeGoogleEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && emailPattern.test(email) && !/\p{Cc}/u.test(email)
    ? email
    : undefined;
}

/**
 * The address a Google ID token vouches for, or nothing when Google did not verify it. Call it only
 * with a token the identity provider has already verified: this reads the claims, it checks nothing.
 */
export function verifiedGoogleEmail(idToken: string): string | undefined {
  let claims;
  try {
    claims = decodeJwt(idToken);
  } catch {
    return undefined;
  }
  return claims.email_verified === true && typeof claims.email === "string"
    ? normalizeGoogleEmail(claims.email)
    : undefined;
}

/** Why a membership check could not answer. The message never names the person. */
export class GoogleGroupUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleGroupUnavailable";
  }
}

/** The one question sign-up asks: is this verified address in the operator's group? */
export interface GoogleGroupGate {
  /** Where a refused person can ask to join; shown on the refusal. */
  readonly joinUrl?: string;
  /** Throws GoogleGroupUnavailable when Google cannot say, so the caller can fail closed. */
  isMember(email: string): Promise<boolean>;
}

const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.string().max(254).regex(emailPattern),
  private_key: z.string().min(1).max(16_384),
  private_key_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().max(86_400),
  token_type: z.string().regex(/^bearer$/i),
});
const groupSchema = z.object({ name: z.string().regex(/^groups\/[A-Za-z0-9_-]{1,128}$/) });
// proto3 JSON leaves out a false boolean, so an empty object means "no".
const transitiveSchema = z.object({ hasMembership: z.boolean().optional() });

/** A public https link, without credentials. */
export function googleGroupJoinUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL must be an https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 512)
    throw new Error(
      "OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL must be an https URL without credentials",
    );
  return url.href;
}

/** Reads and checks the service account key at startup, so a bad key stops the relay there. */
export async function loadGoogleGroupMembership(options: {
  group: string;
  credentialsFile: string;
  joinUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<GoogleGroupMembership> {
  const group = normalizeGoogleEmail(options.group);
  if (!group)
    throw new Error("OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP must be the group's email address");
  const joinUrl = options.joinUrl === undefined ? undefined : googleGroupJoinUrl(options.joinUrl);
  let account: z.infer<typeof serviceAccountSchema>, privateKey: CryptoKey;
  try {
    account = serviceAccountSchema.parse(await readPrivateJson(options.credentialsFile));
    privateKey = await importPKCS8(account.private_key, "RS256");
  } catch {
    throw new Error(
      "OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_CREDENTIALS_FILE must be a readable Google service account JSON key",
    );
  }
  return new GoogleGroupMembership({
    group,
    clientEmail: account.client_email,
    privateKey,
    keyId: account.private_key_id,
    joinUrl,
    fetch: options.fetch,
    now: options.now,
  });
}

/**
 * Membership through the Cloud Identity Groups API, as the service account itself: it needs the
 * Groups Reader admin role, not domain-wide delegation. A direct membership is looked up first,
 * which every Cloud Identity edition answers; nested groups need the transitive check, which only
 * the premium editions answer. Neither request, response nor log line keeps the address.
 */
export class GoogleGroupMembership implements GoogleGroupGate {
  readonly joinUrl?: string;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;
  private groupName?: string;
  private groupRequest?: Promise<string>;
  private nestedUnavailableUntil = 0;
  private readonly now: () => number;
  constructor(
    private readonly options: {
      group: string;
      clientEmail: string;
      privateKey: CryptoKey;
      keyId?: string;
      joinUrl?: string;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.joinUrl = options.joinUrl;
    this.now = options.now ?? Date.now;
  }

  async isMember(input: string): Promise<boolean> {
    const email = normalizeGoogleEmail(input);
    if (!email) return false;
    const group = await this.resolveGroup();
    const direct = await this.get(
      `${CLOUD_IDENTITY_URL}/${group}/memberships:lookup?memberKey.id=${component(email)}`,
      "membership lookup",
    );
    if (direct.status === 200) return true;
    if (direct.status !== 404) throw this.failed("membership lookup", direct.status);
    if (this.now() < this.nestedUnavailableUntil) return false;
    // CEL string literal: quotes and backslashes are escaped, then the whole query is encoded.
    const query = `member_key_id == '${email.replace(/[\\']/g, (c) => `\\${c}`)}'`;
    const nested = await this.get(
      `${CLOUD_IDENTITY_URL}/${group}/memberships:checkTransitiveMembership?query=${component(query)}`,
      "nested membership check",
    );
    // The direct lookup just worked, so this refusal is the edition, not the credentials.
    if (nested.status === 403) {
      this.nestedUnavailableUntil = this.now() + NESTED_RETRY_MS;
      log.warn(
        "Google refused the nested group membership check (it needs a premium Cloud Identity edition); only direct members are admitted",
      );
      return false;
    }
    if (nested.status !== 200) throw this.failed("nested membership check", nested.status);
    const parsed = transitiveSchema.safeParse(nested.body);
    if (!parsed.success) throw this.failed("nested membership check", "an unexpected response");
    return parsed.data.hasMembership === true;
  }

  private resolveGroup(): Promise<string> {
    if (this.groupName) return Promise.resolve(this.groupName);
    this.groupRequest ??= (async () => {
      const response = await this.get(
        `${CLOUD_IDENTITY_URL}/groups:lookup?groupKey.id=${component(this.options.group)}`,
        "group lookup",
      );
      const parsed = response.status === 200 ? groupSchema.safeParse(response.body) : undefined;
      if (!parsed?.success) throw this.failed("group lookup", response.status);
      this.groupName = parsed.data.name;
      return this.groupName;
    })().finally(() => (this.groupRequest = undefined));
    return this.groupRequest;
  }

  private accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return Promise.resolve(this.token.value);
    this.tokenRequest ??= this.mintToken().finally(() => (this.tokenRequest = undefined));
    return this.tokenRequest;
  }

  /** The JWT bearer grant (RFC 7523) Google documents for service accounts. */
  private async mintToken(): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1000);
    const assertion = await new SignJWT({ scope: GROUPS_READONLY_SCOPE })
      .setProtectedHeader({
        alg: "RS256",
        typ: "JWT",
        ...(this.options.keyId ? { kid: this.options.keyId } : {}),
      })
      .setIssuer(this.options.clientEmail)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(this.options.privateKey);
    const response = await this.send(
      GOOGLE_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      },
      "token request",
    );
    const parsed = response.status === 200 ? tokenSchema.safeParse(response.body) : undefined;
    if (!parsed?.success) throw this.failed("token request", response.status);
    this.token = {
      value: parsed.data.access_token,
      expiresAt: this.now() + parsed.data.expires_in * 1000 - TOKEN_MARGIN_MS,
    };
    return parsed.data.access_token;
  }

  private async get(url: string, step: string) {
    const token = await this.accessToken();
    const response = await this.send(
      url,
      { method: "GET", headers: { authorization: `Bearer ${token}` } },
      step,
    );
    // A token Google stopped accepting early is minted again on the next check.
    if (response.status === 401) this.token = undefined;
    return response;
  }

  private async send(url: string, init: RequestInit, step: string) {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (error) {
      throw this.failed(step, error instanceof Error ? error.name : "a network error");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { status: response.status, body: undefined };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = response.body?.getReader();
      for (let read = await reader?.read(); read && !read.done; read = await reader!.read()) {
        size += read.value.length;
        if (size > MAX_RESPONSE_BYTES) {
          await reader!.cancel().catch(() => {});
          throw new Error("too large");
        }
        chunks.push(read.value);
      }
      return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch {
      throw this.failed(step, "an unreadable response");
    }
  }

  private failed(step: string, cause: number | string): GoogleGroupUnavailable {
    const error = new GoogleGroupUnavailable(
      `Google Group ${step} failed with ${typeof cause === "number" ? `HTTP ${cause}` : cause}`,
    );
    log.warn(error.message);
    return error;
  }
}

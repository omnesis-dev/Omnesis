// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Who is behind a request that reached the gateway through its own tailnet
 * device. The helper describes the caller in one header; the gateway believes
 * that header only on requests that arrived through the helper's private
 * socket, and records the result against the Node request object so nothing
 * that reads headers can be fooled by a copy sent to the ordinary listener.
 */

import { z } from "zod";
import type { IncomingMessage } from "node:http";

/** The header the helper sets; any other copy never reaches the socket listener. */
export const TAILNET_CALLER_HEADER = "x-omnesis-tailnet";

const peerSchema = z
  .object({
    nodeId: z.string().max(128),
    nodeName: z.string().max(253),
    os: z.string().max(64).optional(),
    userId: z.string().max(64),
    login: z.string().max(320),
    userName: z.string().max(320).optional(),
    tags: z.array(z.string().max(128)).max(32).optional(),
    sameOwner: z.boolean(),
  })
  .strict();

const callerSchema = z
  .object({
    via: z.enum(["tailnet", "public"]),
    client: z.string().min(1).max(128),
    peer: peerSchema.optional(),
  })
  .strict()
  .refine((caller) => caller.via === "tailnet" || caller.peer === undefined, {
    message: "a public request has no tailnet device",
  });

export type TailnetPeer = z.infer<typeof peerSchema>;
export type TailnetCaller = z.infer<typeof callerSchema>;

/** Decode the helper's header value (unpadded base64url JSON); null when malformed. */
export function decodeTailnetCaller(value: string | undefined): TailnetCaller | null {
  if (!value || value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = callerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const callers = new WeakMap<IncomingMessage, TailnetCaller>();

/** Recorded by the socket listener, and only by it, once it has decoded the header. */
export function recordTailnetCaller(request: IncomingMessage, caller: TailnetCaller): void {
  callers.set(request, caller);
}

/** The caller of a request that came through the gateway's tailnet device, or null. */
export function tailnetCallerOf(request: IncomingMessage | undefined): TailnetCaller | null {
  return request ? (callers.get(request) ?? null) : null;
}

/** The tailnet caller behind a Hono request's Node bindings, or null. */
export function tailnetCallerOfEnv(env: unknown): TailnetCaller | null {
  return tailnetCallerOf((env as { incoming?: IncomingMessage } | undefined)?.incoming);
}

/** The caller's address without its port, for rate limits and logs. */
export function tailnetCallerAddress(caller: TailnetCaller): string {
  const client = caller.client;
  const bracketed = /^\[([^\]]+)\]:\d+$/.exec(client);
  if (bracketed) return bracketed[1]!;
  const lastColon = client.lastIndexOf(":");
  // An IPv4 address with a port has exactly one colon.
  if (lastColon > 0 && client.indexOf(":") === lastColon) return client.slice(0, lastColon);
  return client;
}

/**
 * The paths the public address may serve: what a cloud agent needs to connect
 * and sign in, the address a data source's sign-in redirects back to, and the
 * static files the sign-in page loads. Entries ending in "/" are prefixes.
 * The helper refuses everything else before it reaches the gateway, and the
 * gateway refuses it again.
 */
export const PUBLIC_PATHS: readonly string[] = [
  "/mcp",
  "/mcp/",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/",
  "/.well-known/openid-configuration",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
  "/oauth/authorize",
  "/oauth/authorize/status",
  "/oauth/authorize/complete",
  "/oauth/consent",
  "/oauth/callback",
  "/portal/css/",
  "/portal/vendor/",
  "/portal/js/oauth-consent-controller.js",
  "/portal/js/access-qr-payload.js",
];

/**
 * The helper's rule (exact entries, or prefixes ending in "/"), applied again
 * and more strictly: no public path needs percent-encoding, so any is
 * refused, since the URL parser would otherwise resolve an encoded dot
 * segment out of an allowed prefix.
 */
export function publicPathAllowed(
  path: string,
  allowed: readonly string[] = PUBLIC_PATHS,
): boolean {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("%")) return false;
  const segments = path.split("/");
  if (
    segments.some(
      (segment, index) =>
        segment === "." ||
        segment === ".." ||
        (segment === "" && index > 0 && index < segments.length - 1),
    )
  )
    return false;
  return allowed.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

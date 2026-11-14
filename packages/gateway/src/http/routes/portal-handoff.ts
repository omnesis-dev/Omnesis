// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Opening this gateway's own address already signed in. A passkey works only on the gateway's own
 * page (its `g-*` name under the relay's domain), but the owner often has the portal open at a home
 * address. Instead of a link to a login page, the portal there asks for a one-use handoff and opens
 * the gateway's own page with it in the URL fragment, which no server ever receives.
 *
 * Only with the cloud relay opt-in, and only while the gateway has an origin of its own (linked,
 * and no certificate incident: while one is open, a page on that name may not be the gateway's).
 * A handoff:
 *
 * - is minted by a signed-in portal admin session (cookie + CSRF), for that session's own
 *   credential and scopes, never more;
 * - lasts at most a minute and is spent by any attempt to use it, right or wrong;
 * - is redeemed only from a page on the gateway's own origin, and only while the minting session
 *   is still valid;
 * - is never written to a log.
 *
 * The session it opens is an ordinary portal session for the same credential: requests it makes
 * through the relay still need a step-up (`step-up.ts`) like any other.
 */

import { randomBytes } from "node:crypto";
import { cloudRelayEnabled, createLogger } from "@omnesis/core";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { lookupSession } from "../../data/repositories/TokenRepository.js";
import { IpRateLimiter } from "../../rate-limit.js";
import { buildSessionCookieHeader, getSessionCookie, portalCsrfToken } from "../cookies.js";
import { HttpError } from "../errors.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { clientIp, isLoopbackRequest } from "./admin/internals.js";
import type Database from "better-sqlite3";
import type { Scope } from "@omnesis/types";
import type { RouteApp } from "./types.js";
import type { WriteGate } from "../../write-gate.js";

const log = createLogger("gateway:http").child("portal-handoff");

/** How long a handoff stays usable. */
export const PORTAL_HANDOFF_TTL_MS = 60_000;
/** Where the handoff lands, and the fragment that carries it. */
export const PORTAL_HANDOFF_PATH = "/portal/settings/account";
export const PORTAL_HANDOFF_FRAGMENT = "portal-handoff";
const MAX_OUTSTANDING = 16;

interface Handoff {
  origin: string;
  /** The minting session's cookie value, checked again when the handoff is spent. */
  session: string;
  scopes: readonly Scope[];
  expiresAt: number;
}

/** Handoffs this gateway minted, each for one use within a minute. Memory only. */
export class PortalHandoffs {
  private readonly issued = new Map<string, Handoff>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  issue(value: Omit<Handoff, "expiresAt">): { code: string; expiresAt: number } {
    const now = this.now();
    for (const [code, entry] of this.issued) if (entry.expiresAt <= now) this.issued.delete(code);
    while (this.issued.size >= MAX_OUTSTANDING)
      this.issued.delete(this.issued.keys().next().value!);
    const code = randomBytes(32).toString("base64url");
    const expiresAt = now + PORTAL_HANDOFF_TTL_MS;
    this.issued.set(code, { ...value, expiresAt });
    return { code, expiresAt };
  }

  /** Spends `code` whatever happens next: the handoff, or undefined when unknown or expired. */
  take(code: string): Handoff | undefined {
    const value = this.issued.get(code);
    this.issued.delete(code);
    return value && value.expiresAt > this.now() ? value : undefined;
  }
}

export interface PortalHandoffDeps {
  db: Database.Database;
  writeGate: Pick<WriteGate, "createSession">;
  /** The gateway's own origin under the relay's domain, or undefined when it has none now. */
  gatewayOrigin(): string | undefined;
  sessionCookieName: string;
  sessionTtlMs?: number;
  now?(): number;
}

/** What the opened page does first: `confirm-passkey` starts the setup passkey prompt. */
const mintBody = z.object({ next: z.enum(["confirm-passkey"]).optional() }).strict();
const redeemBody = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

function unavailable(): HttpError {
  return new HttpError(
    409,
    "PORTAL_HANDOFF_UNAVAILABLE",
    "This gateway has no address of its own right now.",
  );
}

export function mountPortalHandoffRoutes(app: RouteApp, deps: PortalHandoffDeps): void {
  if (!cloudRelayEnabled()) return;
  const handoffs = new PortalHandoffs(deps.now);
  const ttlMs = deps.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  const maxAgeS = Math.max(1, Math.floor(ttlMs / 1000));
  const limiter = new IpRateLimiter({
    surface: "/portal/api/handoff/redeem",
    burst: { capacity: 10, windowMs: 60_000 },
    hourly: { capacity: 100, windowMs: 3_600_000 },
  });
  const bounded = bodyLimit({ maxSize: 1024 });

  app.post("/portal/api/handoff", scope.portalAdmin(), bounded, validateJson(mintBody), (c) => {
    c.header("Cache-Control", "no-store");
    const origin = deps.gatewayOrigin();
    const session = getSessionCookie(c.req.header("Cookie"), deps.sessionCookieName);
    if (!origin || !session) throw unavailable();
    const { code, expiresAt } = handoffs.issue({
      origin,
      session,
      scopes: [...c.get("auth").scopes],
    });
    const next = c.req.valid("json").next;
    return c.json({
      url: `${origin}${PORTAL_HANDOFF_PATH}#${PORTAL_HANDOFF_FRAGMENT}=${code}${next ? `&next=${next}` : ""}`,
      expiresAt,
    });
  });

  app.post(
    "/portal/api/handoff/redeem",
    scope.public(),
    bounded,
    validateJson(redeemBody),
    async (c) => {
      c.header("Cache-Control", "no-store");
      if (!isLoopbackRequest(c) && limiter.consume(clientIp(c)))
        return c.json({ error: "Too many attempts. Try again later." }, 429, {
          "Retry-After": "60",
        });
      const refused = () =>
        new HttpError(
          401,
          "PORTAL_HANDOFF_REFUSED",
          "This link expired or was already used. Open it again from the page you came from.",
        );
      // Spent before anything else is checked, so a wrong origin can't keep it for a later try.
      const handoff = handoffs.take(c.req.valid("json").code);
      if (!handoff) throw refused();
      // Bound to this gateway's own page, and only while that page is still the gateway's.
      if (c.req.header("Origin") !== handoff.origin || deps.gatewayOrigin() !== handoff.origin)
        throw refused();
      const minting = lookupSession(deps.db, handoff.session).info;
      if (!minting) throw refused();
      // Never more than the minting session had, even if its credential has more.
      const scopes = minting.scopes.filter((value) => handoff.scopes.includes(value));
      const sessionId = await deps.writeGate.createSession(minting.tokenId, scopes, ttlMs);
      log.info("Opened a portal session on the gateway's own address from a signed-in portal");
      return c.json(
        { ok: true, scopes, csrfToken: portalCsrfToken(sessionId) },
        {
          headers: {
            "Set-Cookie": buildSessionCookieHeader(sessionId, maxAgeS, deps.sessionCookieName),
          },
        },
      );
    },
  );
}

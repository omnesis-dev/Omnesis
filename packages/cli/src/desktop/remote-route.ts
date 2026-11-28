// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
export interface DesktopRemoteRoute {
  state: "ready" | "checking" | "unavailable";
  message: string;
  /** Actual server probe expiry, Unix milliseconds, capped by certificate expiry. */
  validUntil?: number;
}
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const schema = z.object({
  publicOrigin: z
    .string()
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
      } catch {
        return false;
      }
    }),
  account: z.object({ linked: z.literal(true) }),
  tunnel: z.object({ state: z.enum(["disabled", "offline", "connecting", "online"]) }),
  certificate: z.object({
    state: z.enum(["unconfigured", "bootstrap", "valid", "expiring", "expired", "failed"]),
    expiresAt: z.string().datetime().optional(),
  }),
  publicMcp: z.object({
    url: z.string(),
    ready: z.boolean(),
    checkedAt: timestamp.optional(),
    validUntil: timestamp.optional(),
  }),
});
/** Route availability only. This never asserts that an external assistant connected or granted access. */
export function desktopRemoteRoute(value: unknown, now = Date.now()): DesktopRemoteRoute {
  const unavailable: DesktopRemoteRoute = {
    state: "unavailable",
    message:
      "Your library's secure remote route cannot be verified. Check its connection; local search remains available.",
  };
  const parsed = schema.safeParse(value);
  if (!parsed.success || !Number.isSafeInteger(now)) return unavailable;
  const { tunnel, certificate, publicMcp: probe } = parsed.data;
  if (
    probe.url !== `${parsed.data.publicOrigin}/mcp` ||
    ["disabled", "offline"].includes(tunnel.state) ||
    ["bootstrap", "expired", "failed"].includes(certificate.state)
  )
    return unavailable;
  if (tunnel.state === "connecting" || certificate.state === "unconfigured")
    return {
      state: "checking",
      message: "Your library's secure remote connection is being checked.",
    };
  const expiry = certificate.expiresAt ? Date.parse(certificate.expiresAt) : NaN;
  if (
    tunnel.state !== "online" ||
    !["valid", "expiring"].includes(certificate.state) ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    !probe.ready ||
    probe.checkedAt === undefined ||
    probe.validUntil === undefined ||
    probe.checkedAt > now ||
    probe.validUntil <= now ||
    probe.validUntil <= probe.checkedAt ||
    probe.validUntil > expiry ||
    probe.validUntil - probe.checkedAt > 90_000
  )
    return unavailable;
  return {
    state: "ready",
    validUntil: probe.validUntil,
    message: "Your library's secure remote route is available.",
  };
}

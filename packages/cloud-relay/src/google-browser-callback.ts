// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hostname, networkInterfaces } from "node:os";
import { isIP } from "node:net";
import type { X509Certificate } from "node:crypto";

export interface GoogleBrowserCallbackOrigins {
  origins: readonly (string | undefined)[];
  port?: number;
  certificates?: readonly X509Certificate[];
  localNames?: readonly string[];
  localAddresses?: readonly string[];
}

/** Callback destinations come from gateway configuration or actual certified local listeners, never forwarded headers. */
export function googleBrowserCallback(
  requestOrigin: string,
  path: "/admin/cloud-relay/google/callback" | "/devices/google/callback",
  options: GoogleBrowserCallbackOrigins,
): string {
  if (requestOrigin.length > 2048) throw new Error("Google callback origin is unavailable");
  const origin = new URL(requestOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    origin.origin !== requestOrigin
  )
    throw new Error("Google callback origin is unavailable");
  if (options.origins.some((value) => value === origin.origin)) return new URL(path, origin).href;
  const host = origin.hostname.replace(/^\[|\]$/g, "");
  const names = options.localNames ?? ["localhost", hostname(), `${hostname()}.local`];
  const addresses =
    options.localAddresses ??
    Object.values(networkInterfaces()).flatMap(
      // Node lists present interfaces as arrays; absent interfaces are omitted.
      (values) => values!.map((value) => value.address),
    );
  if (
    Number(origin.port || 443) !== options.port ||
    !(isIP(host) ? addresses.includes(host) : names.includes(host)) ||
    !options.certificates?.some((cert) =>
      isIP(host)
        ? cert.checkIP(host) === host
        : cert.checkHost(host, { subject: "never", wildcards: false }) === host,
    )
  )
    throw new Error("Google callback origin is unavailable");
  return new URL(path, origin).href;
}

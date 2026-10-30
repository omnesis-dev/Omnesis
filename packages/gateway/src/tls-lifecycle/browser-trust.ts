// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether the Chrome extension can connect to this gateway, judged from the
 * certificate it serves, and what to say when it cannot.
 *
 * The extension's background worker calls the gateway with `fetch()`, which
 * fails outright on a certificate Chrome does not trust: there is no warning
 * to click through, as a tab has, and no fingerprint to pin, as the phones,
 * the CLI and the collector have. So a browser pairing code minted against a
 * gateway Chrome cannot trust is a code nothing can redeem, and the only
 * message the extension can give is that the connection failed.
 *
 * The verdict is the gateway's, carried on the pairing code it mints, so the
 * CLI (which may run on another machine or inside a container) and the
 * portal say the same thing about the same certificate. It is a judgement of
 * the served certificate only: a browser-trusted certificate still has to be
 * dialled by a name it covers, which the clients say beside it.
 *
 *   - A Tailscale certificate chains to a public authority: trusted.
 *   - An mkcert certificate is trusted only where its authority is installed.
 *   - A certificate the operator supplied may chain anywhere: unknown.
 *   - A self-signed, expired or not-yet-valid certificate: untrusted. Judged
 *     on the served certificate itself, so material that names a trusted tier
 *     but has not replaced the self-signed one yet reads as what is served.
 *
 * A trusted reverse proxy in front of the gateway serves its own certificate
 * for its names, so an untrusted certificate of the gateway's own is not the
 * last word there: the extension can be pointed at the proxy instead.
 */

import { assertNever, type TlsLifecycleSnapshot, type TlsOwnership } from "@omnesis/core";

/** Where the extension's pairing setup is documented. */
export const BROWSER_EXTENSION_DOCS_URL = "https://omnesis.dev/docs/setup#browser-extension";

export type BrowserExtensionTrustStatus =
  /** Chrome trusts the served certificate anywhere. */
  | "trusted"
  /** Chrome trusts it only on a machine where its mkcert authority is installed. */
  | "local-ca"
  /** Nothing Omnesis can tell: an operator's certificate, or a reverse proxy's. */
  | "unknown"
  /** Chrome refuses the served certificate: the extension cannot connect. */
  | "untrusted";

export type BrowserExtensionTrustReason = "self-signed" | "expired" | "not-yet-valid";

/** What a browser pairing code carries about the certificate the extension will meet. */
export interface BrowserExtensionCertificate {
  status: BrowserExtensionTrustStatus;
  /** Who minted the served certificate, as the TLS lifecycle classifies it. */
  certificate: TlsOwnership;
  /** Why the served certificate is untrusted; null otherwise. */
  reason: BrowserExtensionTrustReason | null;
  /** DNS names and addresses the served certificate covers, as written in it. */
  names: string[];
  /** Hosts a trusted reverse proxy serves with its own certificate. */
  proxiedHosts: string[];
  /** A short headline for the warning or note; null when there is nothing to say. */
  title: string | null;
  /** Why, in a sentence or two; null when there is nothing to say. */
  message: string | null;
  /** The concrete fix; null when there is nothing to do here. */
  remedy: string | null;
  docsUrl: string;
}

export interface BrowserExtensionTrustContext {
  /** The gateway runs inside a container, where `omnesis tls provision` refuses to run. */
  inContainer: boolean;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "an unknown date";
}

/** How to replace an untrusted certificate with one Chrome trusts. */
function trustedCertificateRemedy(context: BrowserExtensionTrustContext): string {
  return context.inContainer
    ? "Give the gateway a browser-trusted certificate: re-run the installer on the gateway host — with Tailscale up it sets up a trusted certificate — or mint one on the host and pass it to the installer (https://omnesis.dev/docs/install#docker-tls). Then pair the extension by a name the certificate covers."
    : "Give the gateway a browser-trusted certificate: re-run the installer on the gateway host — with Tailscale up it sets up a trusted certificate — or run `omnesis tls provision` there (Tailscale, or mkcert for that machine's browsers). Then pair the extension by a name the certificate covers.";
}

function untrustedWhy(
  reason: BrowserExtensionTrustReason,
  served: TlsLifecycleSnapshot["served"],
): string {
  switch (reason) {
    case "self-signed":
      return "The gateway serves a self-signed certificate, and the extension cannot click through a certificate warning the way a browser tab can.";
    case "expired":
      return `The gateway's certificate expired on ${day(served.notAfter)}, and Chrome refuses an expired certificate.`;
    case "not-yet-valid":
      return `The gateway's certificate is not valid until ${day(served.notBefore)}, and Chrome refuses it until then.`;
  }
}

function untrustedReason(
  served: TlsLifecycleSnapshot["served"],
): BrowserExtensionTrustReason | null {
  if (served.selfSigned) return "self-signed";
  if (served.state === "expired") return "expired";
  if (served.state === "not-yet-valid") return "not-yet-valid";
  return null;
}

function untrustedRemedy(
  reason: BrowserExtensionTrustReason,
  ownership: TlsOwnership,
  context: BrowserExtensionTrustContext,
): string {
  if (reason === "self-signed") return trustedCertificateRemedy(context);
  if (ownership === "tailscale" || ownership === "mkcert") {
    return reason === "expired"
      ? "Renew it on the gateway host with `omnesis tls renew`, then pair again."
      : "Check the gateway host's clock, then renew the certificate with `omnesis tls renew`.";
  }
  return reason === "expired"
    ? "Replace the certificate you supplied with a current one, then pair again."
    : "Check the gateway host's clock, or replace the certificate you supplied.";
}

/** The verdict for the certificate the gateway serves right now. */
export function browserExtensionTrust(
  snapshot: Pick<TlsLifecycleSnapshot, "ownership" | "served" | "proxiedHosts">,
  context: BrowserExtensionTrustContext,
): BrowserExtensionCertificate {
  const { ownership, served } = snapshot;
  const proxiedHosts = snapshot.proxiedHosts ?? [];
  const base = {
    certificate: ownership,
    names: served.names,
    proxiedHosts,
    docsUrl: BROWSER_EXTENSION_DOCS_URL,
  };
  const reason = untrustedReason(served);
  if (reason) {
    const why = untrustedWhy(reason, served);
    if (proxiedHosts.length > 0) {
      return {
        ...base,
        status: "unknown",
        reason,
        title: "Pair the Chrome extension through your reverse proxy",
        message: `${why} The extension can connect through your reverse proxy (${proxiedHosts.join(", ")}) if Chrome trusts the proxy's certificate.`,
        remedy: `Enter the reverse proxy's address in the extension, not the gateway's own. ${untrustedRemedy(reason, ownership, context)}`,
      };
    }
    return {
      ...base,
      status: "untrusted",
      reason,
      title: "The Chrome extension cannot connect to this gateway",
      message: `${why} Pairing will fail with "The connection to the gateway failed before it answered."`,
      remedy: untrustedRemedy(reason, ownership, context),
    };
  }
  switch (ownership) {
    case "tailscale":
      return {
        ...base,
        status: "trusted",
        reason: null,
        title: null,
        message: null,
        remedy: null,
      };
    case "mkcert":
      return {
        ...base,
        status: "local-ca",
        reason: null,
        title: "The Chrome extension connects only where the mkcert authority is installed",
        message:
          "The gateway's certificate comes from mkcert, so Chrome trusts it only on a machine where that mkcert authority is installed — the gateway host itself, after `mkcert -install`.",
        remedy:
          "To pair a browser on another machine, install the authority's certificate there first (https://omnesis.dev/docs/setup#certificates), or re-run the installer on the gateway host with Tailscale up for a certificate every browser trusts.",
      };
    // A certificate that is not self-signed at the self-signed tier's path was
    // put there by someone else: Omnesis cannot vouch for it either.
    case "external":
    case "self-signed":
      return {
        ...base,
        status: "unknown",
        reason: null,
        title: "Chrome has to trust the certificate you supplied",
        message:
          "The gateway serves a certificate Omnesis did not mint. The Chrome extension connects only if Chrome trusts its issuer.",
        remedy: null,
      };
    default:
      return assertNever(ownership);
  }
}

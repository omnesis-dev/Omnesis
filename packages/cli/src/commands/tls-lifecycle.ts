// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The served certificate from the terminal: `omnesis tls status` reads the
 * gateway's lifecycle snapshot, `renew` asks it to mint and activate a
 * replacement for material Omnesis owns, `reload` makes it activate what a
 * host tool wrote to disk, and `trust` replaces the copy a remote CLI or
 * collector host saved for a gateway whose certificate changed.
 *
 * Renewal and activation happen in the gateway process (`/admin/tls`); the
 * commands here only ask and render, so what they print is what the gateway
 * serves — no restart is involved on either side.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { defineCommand } from "citty";
import {
  DEFAULT_CONFIG_DIR,
  assertNever,
  retrustGateway,
  type TlsLifecycleSnapshot,
} from "@omnesis/core";
import {
  c,
  CliError,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  gatewayJson,
  isJSON,
  GATEWAY_REQUEST_URL,
} from "../utils.js";

/** `POST /admin/tls/renew`'s answer. */
export type TlsRenewOutcome =
  | { ok: true; fingerprintSha256: string; snapshot: TlsLifecycleSnapshot }
  | { ok: false; reason: string; snapshot: TlsLifecycleSnapshot };

export interface TlsLifecycleDeps {
  status(): Promise<TlsLifecycleSnapshot>;
  reload(): Promise<TlsLifecycleSnapshot>;
  renew(force: boolean): Promise<TlsRenewOutcome>;
}

export function defaultTlsLifecycleDeps(): TlsLifecycleDeps {
  return {
    status: () => gatewayJson<TlsLifecycleSnapshot>("/admin/tls"),
    reload: () => gatewayJson<TlsLifecycleSnapshot>("/admin/tls/reload", { method: "POST" }),
    renew: (force) =>
      gatewayJson<TlsRenewOutcome>("/admin/tls/renew", {
        method: "POST",
        body: JSON.stringify({ force }),
      }),
  };
}

function ownershipLabel(snapshot: TlsLifecycleSnapshot): string {
  switch (snapshot.ownership) {
    case "self-signed":
      return "self-signed, minted by the gateway";
    case "tailscale":
      return "Tailscale, minted by Omnesis";
    case "mkcert":
      return "mkcert, minted by Omnesis";
    case "external":
      return "operator-managed";
    default:
      return assertNever(snapshot.ownership);
  }
}

function renewalLabel(snapshot: TlsLifecycleSnapshot): string {
  const { renewal } = snapshot;
  switch (renewal.mode) {
    case "automatic":
      return `automatic, ${renewal.renewBeforeDays} days before expiry`;
    case "host":
      return "on the host (this gateway runs in a container); the gateway activates what appears on disk";
    case "external":
      return "by the tool that issued it; `omnesis tls reload` activates a replacement";
    case "disabled":
      return "switched off (gateway.tls.autoRenew); `omnesis tls renew` renews on request";
    default:
      return assertNever(renewal.mode);
  }
}

/** Render the snapshot the way `omnesis tls status` prints it. */
export function renderTlsStatus(snapshot: TlsLifecycleSnapshot, print = console.log): void {
  const { served } = snapshot;
  const stateColor =
    served.state === "valid" ? c.green : served.state === "expiring" ? c.yellow : c.red;
  print(`${c.bold}Certificate${c.reset}  ${stateColor}${served.state}${c.reset}`);
  print(`  ${c.dim}ownership${c.reset}    ${ownershipLabel(snapshot)}`);
  print(`  ${c.dim}certificate${c.reset}  ${snapshot.certPath}`);
  if (served.fingerprintSha256) {
    print(`  ${c.dim}fingerprint${c.reset}  sha256:${served.fingerprintSha256}`);
  }
  if (served.notAfter) {
    const days = served.daysRemaining ?? 0;
    const when =
      days < 0 ? `expired ${-days} day${days === -1 ? "" : "s"} ago` : `${days} days remaining`;
    print(`  ${c.dim}valid until${c.reset}  ${served.notAfter} (${when})`);
  }
  if (served.names.length > 0) print(`  ${c.dim}names${c.reset}        ${served.names.join(", ")}`);
  if (served.uncoveredHosts.length > 0) {
    print(
      `  ${c.yellow}not covered${c.reset}  ${served.uncoveredHosts.join(", ")} — clients addressing the gateway by these names fail hostname verification`,
    );
  }
  if (snapshot.proxiedHosts && snapshot.proxiedHosts.length > 0) {
    print(
      `  ${c.dim}via proxy${c.reset}    ${snapshot.proxiedHosts.join(", ")} — served by the reverse proxy's certificate, not this one`,
    );
  }
  if (served.error) print(`  ${c.red}problem${c.reset}      ${served.error}`);
  print(`  ${c.dim}renewal${c.reset}      ${renewalLabel(snapshot)}`);
  if (snapshot.renewal.lastRenewedAt) {
    print(`  ${c.dim}last renewed${c.reset} ${snapshot.renewal.lastRenewedAt}`);
  }
  if (snapshot.renewal.lastError) {
    print(
      `  ${c.red}last attempt${c.reset} ${snapshot.renewal.lastAttemptAt ?? "?"} failed: ${snapshot.renewal.lastError}`,
    );
  }
  if (snapshot.pendingReplacement) {
    print(
      `  ${c.yellow}on disk${c.reset}      a replacement was not activated: ${snapshot.pendingReplacement.error}`,
    );
  }
  if (snapshot.rotation) {
    print(
      `  ${c.dim}rotated${c.reset}      ${snapshot.rotation.rotatedAt} (previously sha256:${snapshot.rotation.previousFingerprintSha256}); phones paired by fingerprint before then need \`omnesis devices repair <name>\`, and a collector or CLI host that refuses the new certificate needs \`omnesis tls trust\``,
    );
  }
}

export async function runTlsStatus(deps: TlsLifecycleDeps, json = isJSON): Promise<void> {
  const snapshot = await deps.status();
  if (json) {
    console.log(JSON.stringify(snapshot));
  } else {
    renderTlsStatus(snapshot);
  }
  if (snapshot.served.state !== "valid" && snapshot.served.state !== "expiring") {
    throw new CliError("", EXIT_FAILURE);
  }
}

export async function runTlsRenew(
  deps: TlsLifecycleDeps,
  force: boolean,
  json = isJSON,
): Promise<void> {
  const outcome = await deps.renew(force);
  if (json) {
    console.log(JSON.stringify(outcome));
  } else if (outcome.ok) {
    console.log(
      `${c.green}Renewed and activated${c.reset} — the gateway now serves sha256:${outcome.fingerprintSha256}.`,
    );
    renderTlsStatus(outcome.snapshot);
  } else {
    console.log(`${c.red}Not renewed:${c.reset} ${outcome.reason}`);
    renderTlsStatus(outcome.snapshot);
  }
  if (!outcome.ok) throw new CliError("", EXIT_FAILURE);
}

export async function runTlsReload(deps: TlsLifecycleDeps, json = isJSON): Promise<void> {
  const snapshot = await deps.reload();
  if (json) {
    console.log(JSON.stringify(snapshot));
  } else if (snapshot.pendingReplacement) {
    console.log(
      `${c.red}Not activated:${c.reset} ${snapshot.pendingReplacement.error} — the gateway keeps serving sha256:${snapshot.served.fingerprintSha256}.`,
    );
  } else {
    console.log(
      `${c.green}Serving${c.reset} the material at ${snapshot.certPath} (sha256:${snapshot.served.fingerprintSha256}).`,
    );
  }
  if (snapshot.pendingReplacement) throw new CliError("", EXIT_FAILURE);
}

export interface TlsTrustOptions {
  gatewayUrl: string;
  configDir: string;
  fingerprint?: string | undefined;
}

/**
 * Replace the copy of the gateway's certificate this host trusts. Refused on
 * the gateway host itself: there the saved copy is the gateway's own
 * material, and there is nothing to re-trust.
 */
export async function runTlsTrust(
  options: TlsTrustOptions,
  retrust: typeof retrustGateway = retrustGateway,
  json = isJSON,
): Promise<void> {
  const gatewayKeys = ["key.pem", "tailscale.key", "mkcert.key"];
  if (gatewayKeys.some((name) => existsSync(join(options.configDir, "tls", name)))) {
    throw new CliError(
      `${options.configDir} holds the gateway's own certificate; there is nothing to re-trust here. Run \`omnesis tls trust\` on the host whose saved copy is stale — a collector, or a machine that runs the CLI against this gateway.`,
      EXIT_USER_ERROR,
    );
  }
  if (!options.gatewayUrl.startsWith("https://")) {
    throw new CliError(
      `The gateway URL ${options.gatewayUrl} is not https://; there is no certificate to trust.`,
      EXIT_USER_ERROR,
    );
  }
  const result = await retrust({
    gatewayUrl: options.gatewayUrl,
    configDir: options.configDir,
    expectedFingerprint: options.fingerprint,
  });
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(
    `${c.green}Trusted${c.reset} sha256:${result.fingerprint} for ${options.gatewayUrl}` +
      (result.previousFingerprint ? ` (replacing sha256:${result.previousFingerprint})` : "") +
      `; saved at ${result.certPath}.`,
  );
}

export const tlsStatusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show the certificate the gateway serves, its expiry and how it renews",
  },
  args: { json: { type: "boolean", description: "Machine-readable JSON output" } },
  run: () => runTlsStatus(defaultTlsLifecycleDeps()),
});

export const tlsRenewCommand = defineCommand({
  meta: {
    name: "renew",
    description:
      "Renew the certificate Omnesis minted (self-signed, Tailscale or mkcert) and activate it without a restart",
  },
  args: {
    force: {
      type: "boolean",
      description: "Renew even if the certificate is not yet due, or automatic renewal is off",
      default: false,
    },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  run: (ctx) => runTlsRenew(defaultTlsLifecycleDeps(), ctx.args.force === true),
});

export const tlsReloadCommand = defineCommand({
  meta: {
    name: "reload",
    description: "Activate certificate material replaced on disk, without restarting the gateway",
  },
  args: { json: { type: "boolean", description: "Machine-readable JSON output" } },
  run: () => runTlsReload(defaultTlsLifecycleDeps()),
});

export const tlsTrustCommand = defineCommand({
  meta: {
    name: "trust",
    description:
      "Re-trust a gateway whose certificate changed, replacing the copy saved on this host",
  },
  args: {
    fingerprint: {
      type: "string",
      description:
        "SHA-256 fingerprint the gateway must present (from `omnesis tls status` on the gateway host); required when not interactive",
    },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  run: (ctx) =>
    runTlsTrust({
      gatewayUrl: GATEWAY_REQUEST_URL,
      configDir: process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
      fingerprint: typeof ctx.args.fingerprint === "string" ? ctx.args.fingerprint : undefined,
    }),
});

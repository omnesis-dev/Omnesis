// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis tls provision` — the in-place, idempotent retrofit of the
 * installer's `provision_tls()` (scripts/install.sh) for an EXISTING
 * install. It mints a browser-trusted TLS certificate and wires it into the
 * config dir's `.env`, so the gateway stops serving its self-signed cert —
 * removing the portal's "proceed anyway" warning AND unblocking the MV3
 * browser-capture extension, whose service-worker `fetch()` cannot
 * clear an untrusted-cert prompt at all.
 *
 * Two tiers, matching the installer:
 *   1. Tailscale — when a tailnet is up, `tailscale cert <magicdns-name>`
 *      issues a publicly-chaining cert; the gateway is then addressed by that
 *      MagicDNS name (the cert only covers the name, not a raw IP).
 *   2. mkcert — a locally-trusted CA (`mkcert -install`) issuing a cert for
 *      localhost / 127.0.0.1 / <hostname>.local and the host's current
 *      non-loopback interface addresses.
 * Neither available → a clear message explaining the options, leaving the
 * self-signed default in place (the command never breaks a working setup).
 *
 * The logic is kept pure (`provisionTls`) with every side-effect injected via
 * `TlsProvisionEnv`, so it is unit-tested without ever invoking `tailscale` /
 * `mkcert` or touching the real `~/.config/omnesis`. The shared `.env` upsert
 * (`upsertDotEnv` in `@omnesis/config`) mirrors the installer's `set_env`, so
 * repeated runs never duplicate `OMNESIS_TLS_*` lines.
 *
 * Why this lives in the CLI, not the gateway: provisioning is an operator
 * action against the config dir + the host's `tailscale`/`mkcert` binaries; the
 * gateway only ever *consumes* the resulting `OMNESIS_TLS_CERT/KEY` env vars at
 * boot (see packages/gateway/src/tls.ts). The installer carries equivalent
 * shell wiring; this is the TypeScript path for already-installed setups.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

import { defineCommand } from "citty";
import {
  DEFAULT_CONFIG_DIR,
  ensureGatewayTrust,
  isCertificateIpAddress,
  localMdnsHostname,
  mkcertCliCandidates,
  safeNetworkInterfaces,
  TAILSCALE_STATUS_TIMEOUT_MS,
  tailscaleCliCandidates,
  tailscaleCliEnv,
  tailscaleIsRunningStatus,
  type TailscaleCliCandidate,
  type TlsLifecycleSnapshot,
} from "@omnesis/core";
import { upsertDotEnv } from "@omnesis/config";
import { isFetchConnectionError } from "@omnesis/cli-shared";
import { c, EXIT_USER_ERROR, EXIT_FAILURE, GATEWAY_REQUEST_URL, gatewayJson } from "../utils.js";
import {
  defaultTlsLifecycleDeps,
  tlsReloadCommand,
  tlsRenewCommand,
  tlsStatusCommand,
  tlsTrustCommand,
  type TlsLifecycleDeps,
} from "./tls-lifecycle.js";

/** The certificate-issuing tier that was used (or skipped). */
export type TlsProvisionTier = "tailscale" | "mkcert" | "none";

export interface TlsProvisionOptions {
  /** Force the mkcert tier even when Tailscale is available. */
  mkcert?: boolean;
  /** Re-mint even if a cert already exists at the target paths. */
  force?: boolean;
  /** Plan only: report what would happen, write nothing. */
  dryRun?: boolean;
  /** Gateway port baked into the provisioned `OMNESIS_GATEWAY_URL`. */
  gatewayPort?: number;
}

/**
 * Injected environment: every host interaction the command performs. Tests
 * substitute pure fakes; production wires `defaultTlsProvisionEnv()`.
 */
export interface TlsProvisionEnv {
  configDir: string;
  /** `OMNESIS_TLS_CERT` already pointing at a file (an existing BYO/provisioned cert). */
  existingCertPath?: string;
  /** `OMNESIS_TLS_KEY` already pointing at a file. */
  existingKeyPath?: string;
  /** The gateway URL currently persisted for local clients and join commands. */
  existingGatewayUrl?: string;
  /** The host platform, for guidance that differs by operating system. */
  platform: NodeJS.Platform;
  /** Is a Tailscale CLI available and connected to a tailnet? */
  hasTailscale(): boolean;
  /** The host's MagicDNS name (no trailing dot), or "" if none/unavailable. */
  tailscaleDnsName(): string;
  /**
   * Run `tailscale cert` into the given paths. Throws on failure (the caller
   * turns that into a graceful "needs HTTPS enabled / perms" message).
   */
  runTailscaleCert(dnsName: string, certPath: string, keyPath: string): void;
  /** Is the `mkcert` binary present? */
  hasMkcert(): boolean;
  /** Run `mkcert -install` then issue a cert covering the given names. Throws on failure. */
  runMkcert(certPath: string, keyPath: string, names: string[]): void;
  /** Does a file exist at this path? (cert-already-present check) */
  fileExists(path: string): boolean;
  /** Local hostname as reported by the operating system. */
  hostname(): string;
  /** Non-loopback interface addresses that should be covered by a local cert. */
  networkAddresses(): string[];
  /** Whether the command is running inside a container (Docker). */
  isContainer(): boolean;
}

export interface TlsProvisionResult {
  tier: TlsProvisionTier;
  /** Human-readable lines to print (status, guidance). */
  messages: string[];
  /** `.env` keys that were written (empty on dry-run or no-op / no-path). */
  envWritten: Record<string, string>;
  /** True when a trusted cert is now wired (Tailscale or mkcert succeeded). */
  provisioned: boolean;
  /** The browser-trusted gateway URL the operator should now use, if any. */
  trustedUrl?: string;
  /** Non-zero exit hint for the no-path / blocked cases. */
  exitCode: number;
}

const DEFAULT_GATEWAY_PORT = 7600;

/** Validate, deduplicate, and stabilize the interface addresses handed to mkcert. */
export function mkcertNetworkAddresses(addresses: Iterable<string>): string[] {
  const eligible = new Set<string>();
  for (const address of addresses) {
    if (!isCertificateIpAddress(address)) continue;
    eligible.add(address);
  }
  return [...eligible].sort();
}

/** Keep a covered saved URL after re-minting, or use the certificate's hostname. */
export function mkcertGatewayUrl(
  existingUrl: string | undefined,
  hostLocal: string,
  networkAddresses: readonly string[],
  gatewayPort: number,
): string {
  const fallback = `https://${hostLocal}:${gatewayPort}`;
  if (!existingUrl) return fallback;

  try {
    const url = new URL(existingUrl);
    if (url.protocol !== "https:" || url.username || url.password) return fallback;
    let host = url.hostname.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (host.endsWith(".")) host = host.slice(0, -1);
    const covered = new Set(
      [hostLocal, ...networkAddresses.filter(isCertificateIpAddress)].map((value) => {
        const authority = isIP(value) === 6 ? `[${value}]` : value;
        let normalized = new URL(`https://${authority}`).hostname.toLowerCase();
        if (normalized.startsWith("[") && normalized.endsWith("]")) {
          normalized = normalized.slice(1, -1);
        }
        return normalized;
      }),
    );
    if (!covered.has(host)) return fallback;
    const authority = isIP(host) === 6 ? `[${host}]` : host;
    return `https://${authority}:${gatewayPort}`;
  } catch {
    return fallback;
  }
}

/**
 * Pure core. No process side-effects beyond the cert-issuing + `.env` write,
 * which are themselves injected via `env` (writeEnv) — see `provisionTlsCommand`
 * for the production wiring that performs the real upsert.
 */
export function provisionTls(
  options: TlsProvisionOptions,
  env: TlsProvisionEnv,
  writeEnv: (updates: Record<string, string>) => void,
): TlsProvisionResult {
  const messages: string[] = [];
  const tlsDir = join(env.configDir, "tls");
  const gatewayPort = options.gatewayPort ?? DEFAULT_GATEWAY_PORT;

  // Guard: don't silently clobber a user-provided cert. If OMNESIS_TLS_CERT
  // already points at a real file and the operator didn't ask to re-mint,
  // bail with guidance. (--force overrides; a stale env pointing at a missing
  // file is treated as "nothing to protect".)
  if (
    env.existingCertPath &&
    env.fileExists(env.existingCertPath) &&
    !options.force &&
    !options.dryRun
  ) {
    messages.push(
      `A certificate is already wired: OMNESIS_TLS_CERT=${env.existingCertPath}`,
      "Re-run with --force to re-mint and overwrite it, or leave it as-is.",
    );
    return {
      tier: "none",
      messages,
      envWritten: {},
      provisioned: false,
      exitCode: EXIT_USER_ERROR,
    };
  }

  // Docker: a container can't `mkcert -install` into the host browser's trust
  // store, nor reach the host's tailscaled. Be honest rather than minting a
  // cert nothing trusts.
  if (env.isContainer()) {
    messages.push(
      "Running inside a container — provisioning here can't trust a cert in your",
      "browser or reach the host's Tailscale daemon.",
      "Mint the cert OUTSIDE the container (Tailscale or mkcert on the host) into",
      "the config directory's tls/ folder — it is mounted into the container at",
      "the same path — then re-run the installer with --tls-cert and --tls-key",
      "naming those files (and --tls-ca for mkcert's rootCA.pem), so the collector",
      "container dials the gateway by a name the certificate covers. See",
      "https://omnesis.dev/docs/install#docker-tls.",
    );
    return {
      tier: "none",
      messages,
      envWritten: {},
      provisioned: false,
      exitCode: EXIT_USER_ERROR,
    };
  }

  const wantMkcert = options.mkcert === true;

  // Tier 1: Tailscale (unless --mkcert forces the fallback).
  if (!wantMkcert && env.hasTailscale()) {
    const dnsName = env.tailscaleDnsName();
    if (dnsName) {
      const certPath = join(tlsDir, "tailscale.crt");
      const keyPath = join(tlsDir, "tailscale.key");
      const trustedUrl = `https://${dnsName}:${gatewayPort}`;

      if (env.fileExists(certPath) && !options.force) {
        messages.push(
          `A Tailscale certificate already exists at ${certPath}.`,
          "Re-run with --force / --refresh to re-mint it.",
        );
        const updates = {
          OMNESIS_TLS_CERT: certPath,
          OMNESIS_TLS_KEY: keyPath,
          OMNESIS_GATEWAY_URL: trustedUrl,
        };
        if (!options.dryRun) writeEnv(updates);
        return {
          tier: "tailscale",
          messages,
          envWritten: options.dryRun ? {} : updates,
          provisioned: true,
          trustedUrl,
          exitCode: 0,
        };
      }

      if (options.dryRun) {
        messages.push(
          `Would mint a Tailscale certificate for ${dnsName} into ${tlsDir},`,
          `and set OMNESIS_GATEWAY_URL=${trustedUrl}.`,
        );
        return {
          tier: "tailscale",
          messages,
          envWritten: {},
          provisioned: true,
          trustedUrl,
          exitCode: 0,
        };
      }

      try {
        env.runTailscaleCert(dnsName, certPath, keyPath);
      } catch (err) {
        messages.push(
          `tailscale cert failed: ${err instanceof Error ? err.message : String(err)}`,
          "Nothing on your tailnet was changed. Enable HTTPS certificates and MagicDNS for the",
          "tailnet in the Tailscale admin console: https://tailscale.com/kb/1153/enabling-https",
          ...(env.platform === "linux"
            ? [
                "On Linux, tailscale cert also needs your user to be the Tailscale operator:",
                "  sudo tailscale set --operator=$USER",
              ]
            : []),
          "Continuing without a trusted cert — the gateway keeps its self-signed default.",
        );
        return {
          tier: "none",
          messages,
          envWritten: {},
          provisioned: false,
          exitCode: EXIT_FAILURE,
        };
      }

      const updates = {
        OMNESIS_TLS_CERT: certPath,
        OMNESIS_TLS_KEY: keyPath,
        OMNESIS_GATEWAY_URL: trustedUrl,
      };
      writeEnv(updates);
      messages.push(
        `Minted a Tailscale certificate for ${dnsName}.`,
        `Gateway URL is now ${trustedUrl} (the cert covers the name, not a raw IP).`,
      );
      return {
        tier: "tailscale",
        messages,
        envWritten: updates,
        provisioned: true,
        trustedUrl,
        exitCode: 0,
      };
    }
    // Tailscale is up but reports no MagicDNS name — say what enables one,
    // then fall through to mkcert if available, else the no-path branch.
    messages.push(
      "Tailscale is up but reports no MagicDNS name. A Tailscale certificate needs MagicDNS:",
      "enable it for the tailnet in the Tailscale admin console, then re-run.",
      "Falling back to mkcert.",
    );
  }

  // Tier 2: mkcert (the universal fallback, or when --mkcert is forced).
  if (env.hasMkcert()) {
    const certPath = join(tlsDir, "mkcert.crt");
    const keyPath = join(tlsDir, "mkcert.key");
    const hostLocal = localMdnsHostname(env.hostname());
    let networkAddresses: string[] = [];
    try {
      networkAddresses = mkcertNetworkAddresses(env.networkAddresses());
    } catch {
      // Keep the fixed names when the host cannot enumerate its interfaces.
    }
    const names = ["localhost", "127.0.0.1", "::1", hostLocal, ...networkAddresses];

    if (env.fileExists(certPath) && !options.force) {
      messages.push(
        `An mkcert certificate already exists at ${certPath}.`,
        "Re-run with --force / --refresh to re-mint it.",
      );
      const updates = { OMNESIS_TLS_CERT: certPath, OMNESIS_TLS_KEY: keyPath };
      if (!options.dryRun) writeEnv(updates);
      return {
        tier: "mkcert",
        messages,
        envWritten: options.dryRun ? {} : updates,
        provisioned: true,
        trustedUrl: `https://localhost:${gatewayPort}`,
        exitCode: 0,
      };
    }

    if (options.dryRun) {
      messages.push(
        `Would run mkcert -install and issue a certificate for ${names.join(", ")} into ${tlsDir}.`,
      );
      return {
        tier: "mkcert",
        messages,
        envWritten: {},
        provisioned: true,
        trustedUrl: `https://localhost:${gatewayPort}`,
        exitCode: 0,
      };
    }

    try {
      env.runMkcert(certPath, keyPath, names);
    } catch (err) {
      messages.push(
        `mkcert failed: ${err instanceof Error ? err.message : String(err)}`,
        "Continuing without a trusted cert — the gateway keeps its self-signed default.",
      );
      return {
        tier: "none",
        messages,
        envWritten: {},
        provisioned: false,
        exitCode: EXIT_FAILURE,
      };
    }

    const gatewayUrl = mkcertGatewayUrl(
      env.existingGatewayUrl,
      hostLocal,
      networkAddresses,
      gatewayPort,
    );
    const updates = {
      OMNESIS_TLS_CERT: certPath,
      OMNESIS_TLS_KEY: keyPath,
      OMNESIS_GATEWAY_URL: gatewayUrl,
    };
    writeEnv(updates);
    messages.push(
      "Installed an mkcert certificate — the portal will load without warnings.",
      "To pair a browser on another machine, copy the mkcert root CA there and trust it once.",
    );
    return {
      tier: "mkcert",
      messages,
      envWritten: updates,
      provisioned: true,
      trustedUrl: gatewayUrl,
      exitCode: 0,
    };
  }

  // No trusted-cert path available.
  messages.push(
    wantMkcert
      ? "mkcert is not installed (https://github.com/FiloSottile/mkcert)."
      : "No trusted-certificate path available.",
    "Install one of:",
    ...(env.hasTailscale()
      ? ["  • Tailscale is running: enable MagicDNS for the tailnet as above, then re-run."]
      : [
          "  • Tailscale (https://tailscale.com) — join your tailnet with `tailscale up`, enable HTTPS",
          "    certificates and MagicDNS in its admin console, then re-run; the cert chains to a public",
          "    CA and covers this machine's MagicDNS name, reachable by tailnet members only.",
        ]),
    "  • mkcert (https://github.com/FiloSottile/mkcert) — then re-run, or pass --mkcert.",
    "This command never joins a network or changes tailnet settings for you.",
    "Without one, the gateway keeps its self-signed cert: the portal works with a one-time",
    "browser warning, but the browser-capture extension cannot connect at all.",
  );
  return {
    tier: "none",
    messages,
    envWritten: {},
    provisioned: false,
    exitCode: EXIT_USER_ERROR,
  };
}

/**
 * Wire the real host environment. `tailscale status --json`'s `Self.DNSName`
 * gives the MagicDNS name (mirroring the installer); cert issuance shells out
 * to the same binaries the installer uses.
 */
export function defaultTlsProvisionEnv(
  candidates: TailscaleCliCandidate[] = tailscaleCliCandidates(),
  configDir: string = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
): TlsProvisionEnv {
  let tailscaleCli: TailscaleCliCandidate | undefined;
  let mkcertCli = "mkcert";
  return {
    configDir,
    existingCertPath: process.env.OMNESIS_TLS_CERT,
    existingKeyPath: process.env.OMNESIS_TLS_KEY,
    existingGatewayUrl: process.env.OMNESIS_GATEWAY_URL,
    platform: process.platform,
    hasTailscale() {
      for (const candidate of candidates) {
        try {
          const status = execFileSync(candidate.file, ["status", "--json"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: TAILSCALE_STATUS_TIMEOUT_MS,
            env: tailscaleCliEnv(candidate),
          });
          if (!tailscaleIsRunningStatus(status)) continue;
          tailscaleCli = candidate;
          return true;
        } catch {
          // An installed CLI can be disconnected while the macOS app is connected.
        }
      }
      return false;
    },
    tailscaleDnsName() {
      if (!tailscaleCli) return "";
      try {
        const json = execFileSync(tailscaleCli.file, ["status", "--json"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: TAILSCALE_STATUS_TIMEOUT_MS,
          env: tailscaleCliEnv(tailscaleCli),
        });
        const dns = (JSON.parse(json) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "";
        return dns.replace(/\.$/, "");
      } catch {
        return "";
      }
    },
    runTailscaleCert(dnsName, certPath, keyPath) {
      if (!tailscaleCli) throw new Error("Tailscale is unavailable");
      mkdirSync(join(configDir, "tls"), { recursive: true });
      execFileSync(
        tailscaleCli.file,
        ["cert", "--cert-file", certPath, "--key-file", keyPath, dnsName],
        {
          stdio: ["ignore", "ignore", "pipe"],
          // An ACME order takes seconds; the bound only stops a hung daemon.
          timeout: 5 * 60_000,
          env: tailscaleCliEnv(tailscaleCli),
        },
      );
    },
    hasMkcert() {
      // The same candidates the gateway renews with: PATH, then Homebrew's.
      for (const file of mkcertCliCandidates()) {
        try {
          execFileSync(file, ["-version"], { stdio: "ignore" });
          mkcertCli = file;
          return true;
        } catch {
          // Not this one.
        }
      }
      return false;
    },
    runMkcert(certPath, keyPath, names) {
      mkdirSync(join(configDir, "tls"), { recursive: true });
      execFileSync(mkcertCli, ["-install"], { stdio: ["ignore", "ignore", "pipe"] });
      execFileSync(mkcertCli, ["-cert-file", certPath, "-key-file", keyPath, ...names], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    },
    fileExists(path) {
      return existsSync(path);
    },
    hostname() {
      return osHostname() || "localhost";
    },
    networkAddresses() {
      const addresses: string[] = [];
      for (const list of Object.values(safeNetworkInterfaces())) {
        if (!list) continue;
        for (const entry of list) {
          if (!entry.internal) addresses.push(entry.address);
        }
      }
      return addresses;
    },
    isContainer() {
      return existsSync("/.dockerenv");
    },
  };
}

/**
 * Trust the gateway this command talks to the way every other command's
 * preflight does (`index.ts`), minus its probe. `tls provision` is exempt from
 * that preflight so it works with the gateway down or its certificate
 * changed, but it still reads the gateway before minting and asks it to
 * activate afterwards, and a self-signed gateway is trusted only through the
 * copy saved in the config directory — on the gateway's own machine, the
 * certificate it serves. Without a saved copy nothing is added: this never
 * enters the first-sight prompt, and the gateway calls stay best effort.
 */
export async function trustSavedGatewayCertificate(
  gatewayUrl: string,
  configDir: string,
): Promise<void> {
  if (!existsSync(join(configDir, "tls", "cert.pem"))) return;
  try {
    await ensureGatewayTrust({ gatewayUrl, configDir });
  } catch {
    // Unreadable copy: the calls below fail and fall back to the restart advice.
  }
}

/**
 * Activate freshly provisioned material in the running gateway. It re-reads
 * the config directory's `.env`, so the paths this run wrote are what it
 * loads; a gateway that is down, older, or refuses the material falls back
 * to the restart instruction.
 */
export async function activateProvisionedMaterial(
  certPath: string,
  lifecycle: Pick<TlsLifecycleDeps, "reload">,
): Promise<{ activated: true; fingerprintSha256: string } | { activated: false; reason: string }> {
  try {
    let snapshot: TlsLifecycleSnapshot;
    try {
      snapshot = await lifecycle.reload();
    } catch (err) {
      // The reads before minting leave a keep-alive connection, which the
      // gateway drops while `tailscale cert` runs (an ACME order takes tens of
      // seconds), and fetch does not retry a POST on it. A reload only
      // re-reads and activates what is on disk, so one more try is safe.
      if (!isFetchConnectionError(err)) throw err;
      snapshot = await lifecycle.reload();
    }
    if (snapshot.pendingReplacement) {
      return { activated: false, reason: snapshot.pendingReplacement.error };
    }
    if (snapshot.certPath !== certPath) {
      return { activated: false, reason: `the gateway is serving ${snapshot.certPath}` };
    }
    return { activated: true, fingerprintSha256: snapshot.served.fingerprintSha256 ?? "" };
  } catch (err) {
    return { activated: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** A paired phone, as far as the certificate-change warning needs it. */
export interface PairedPhone {
  name: string;
  kind: "ios" | "android";
}

/** The certificate the gateway served before provisioning, as far as the warning needs it. */
export interface PreviousCertificate {
  fingerprint: string;
  selfSigned: boolean;
}

/**
 * The warning printed when the gateway's certificate is replaced. A phone
 * paired by the previous certificate's fingerprint refuses the new one, so it
 * stops connecting until it is repaired. Every phone paired against a
 * self-signed certificate pinned it; after a trusted certificate, only a
 * phone paired on an address that certificate does not cover did, and the
 * gateway cannot tell which, so those are named as possibly affected. Empty
 * when the certificate did not change or no phone is paired.
 */
export function phoneRepairLines(
  previous: PreviousCertificate | null,
  activation: { activated: true; fingerprintSha256: string } | { activated: false },
  phones: readonly PairedPhone[],
): string[] {
  if (phones.length === 0) return [];
  if (activation.activated && previous?.fingerprint === activation.fingerprintSha256) return [];
  const when = activation.activated ? "now" : "once the gateway restarts";
  const intro =
    previous?.selfSigned === false
      ? [
          `${c.yellow}A phone paired on a home-network address stops connecting ${when}${c.reset} (one paired`,
          "on the trusted name keeps working). Repair any of these that were:",
        ]
      : [
          `${c.yellow}Your paired phones stop connecting ${when}:${c.reset} they trusted the previous certificate`,
          "by its fingerprint. Repair each one:",
        ];
  return [
    "",
    ...intro,
    ...phones.map(
      (phone) =>
        `  ${phone.name} (${phone.kind === "ios" ? "iPhone" : "Android"}): ${c.cyan}omnesis devices repair ${shellQuote(phone.name)}${c.reset}`,
    ),
    "Or open Settings → Devices in the portal and choose Repair on each phone. Repairing keeps the",
    "phone's device, sources and data; the phone then scans a new code.",
  ];
}

/** Quote a device name as one POSIX shell word. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/gu, "'\\''")}'`;
}

/**
 * What the certificate-change warning needs from the gateway, read before the
 * certificate changes: afterwards a client that trusted the previous
 * certificate by fingerprint may no longer connect. Best effort: an
 * unreachable gateway leaves nothing to warn about.
 */
async function certificateChangeContext(): Promise<{
  previous: PreviousCertificate | null;
  phones: PairedPhone[];
}> {
  const previous = await defaultTlsLifecycleDeps()
    .status()
    .then((snapshot): PreviousCertificate | null =>
      snapshot.served.fingerprintSha256
        ? { fingerprint: snapshot.served.fingerprintSha256, selfSigned: snapshot.served.selfSigned }
        : null,
    )
    .catch(() => null);
  const phones = await gatewayJson<{
    items: Array<{ name: string; kind: string; revokedAt?: number | null }>;
  }>("/admin/devices")
    .then(({ items }) =>
      items.flatMap((device): PairedPhone[] =>
        (device.kind === "ios" || device.kind === "android") && !device.revokedAt
          ? [{ name: device.name, kind: device.kind }]
          : [],
      ),
    )
    .catch(() => []);
  return { previous, phones };
}

/** Shared execution path for `provision` and `refresh`. */
async function runProvisionCommand(opts: TlsProvisionOptions): Promise<void> {
  const env = defaultTlsProvisionEnv();
  if (!opts.dryRun) await trustSavedGatewayCertificate(GATEWAY_REQUEST_URL, env.configDir);
  const before = opts.dryRun ? { previous: null, phones: [] } : await certificateChangeContext();
  const gatewayPort = process.env.OMNESIS_GATEWAY_PORT
    ? Number(process.env.OMNESIS_GATEWAY_PORT)
    : undefined;
  const result = provisionTls({ gatewayPort, ...opts }, env, (updates) => {
    upsertDotEnv(env.configDir, updates);
  });

  for (const line of result.messages) {
    process.stdout.write(`${line}\n`);
  }
  if (result.provisioned && !opts.dryRun) {
    const certPath = result.envWritten.OMNESIS_TLS_CERT;
    const activation = certPath
      ? await activateProvisionedMaterial(certPath, defaultTlsLifecycleDeps())
      : { activated: false as const, reason: "nothing new was written" };
    if (activation.activated) {
      process.stdout.write(
        `\n${c.green}Activated:${c.reset} the gateway now serves the new certificate (sha256:${activation.fingerprintSha256}), no restart needed.\n`,
      );
    } else {
      process.stdout.write(
        `\n${c.yellow}Not activated yet${c.reset} (${activation.reason}). Restart the gateway to load the new certificate: omnesis service restart\n`,
      );
    }
    if (result.trustedUrl) {
      process.stdout.write(
        `Open the portal at ${c.cyan}${result.trustedUrl}/portal/${c.reset} — no warning, and the browser extension can connect.\n`,
      );
    }
    for (const line of phoneRepairLines(before.previous, activation, before.phones)) {
      process.stdout.write(`${line}\n`);
    }
    // Loaded here: it pulls in the service manager, which `tls status` never needs.
    const { reconnectLocalCollector } = await import("./tls-local-collector.js");
    const url = result.envWritten.OMNESIS_GATEWAY_URL;
    for (const line of await reconnectLocalCollector(
      url !== undefined && url !== env.existingGatewayUrl,
    )) {
      process.stdout.write(`${line}\n`);
    }
  }
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

const provisionTlsCommand = defineCommand({
  meta: {
    name: "provision",
    description:
      "Mint + wire a browser-trusted TLS certificate (Tailscale or mkcert) for an existing install",
  },
  args: {
    mkcert: {
      type: "boolean",
      description: "Use mkcert even when Tailscale is available",
      default: false,
    },
    force: {
      type: "boolean",
      description: "Re-mint even if a certificate already exists (alias: --refresh)",
      default: false,
    },
    refresh: {
      type: "boolean",
      description: "Alias for --force",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Show what would happen without writing anything",
      default: false,
    },
  },
  run(ctx) {
    return runProvisionCommand({
      mkcert: ctx.args.mkcert === true,
      force: ctx.args.force === true || ctx.args.refresh === true,
      dryRun: ctx.args["dry-run"] === true,
    });
  },
});

const refreshTlsCommand = defineCommand({
  meta: {
    name: "refresh",
    description: "Re-mint the browser-trusted TLS certificate in place (implies --force)",
  },
  args: {
    mkcert: {
      type: "boolean",
      description: "Use mkcert even when Tailscale is available",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Show what would happen without writing anything",
      default: false,
    },
  },
  run(ctx) {
    return runProvisionCommand({
      mkcert: ctx.args.mkcert === true,
      force: true,
      dryRun: ctx.args["dry-run"] === true,
    });
  },
});

export const tlsCommand = defineCommand({
  meta: {
    name: "tls",
    description:
      "Manage the gateway's TLS certificate: provision a browser-trusted cert, inspect, renew, reload, re-trust",
  },
  subCommands: {
    provision: provisionTlsCommand,
    refresh: refreshTlsCommand,
    status: tlsStatusCommand,
    renew: tlsRenewCommand,
    reload: tlsReloadCommand,
    trust: tlsTrustCommand,
  },
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(provisionTlsCommand, { rawArgs: ctx.rawArgs });
    }
  },
});

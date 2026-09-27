// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The file an agent on the gateway's machine can be told to trust so it
 * accepts a certificate no public authority issued.
 *
 * Agents such as Claude Code and Codex read an extra trust file from their
 * environment (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`). Which file works
 * depends on who minted the served certificate: an mkcert certificate is
 * trusted through the mkcert root that issued it, and the gateway's own
 * self-signed certificate only through itself. A Tailscale certificate needs
 * nothing, and an operator's own material names no file Omnesis can vouch for.
 *
 * A file is only ever reported after it is checked against the certificate
 * the gateway serves right now, so the portal never offers a setting that
 * cannot work.
 */

import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { type TlsOwnership } from "@omnesis/core";

/** What the access overview tells a client about trusting the served certificate. */
export interface AgentCertificateTrust {
  /** Who minted the served certificate, as the TLS lifecycle classifies it. */
  kind: TlsOwnership;
  /**
   * Absolute path, on the gateway's machine, of the certificate an agent
   * there trusts to verify the served one; null when there is none to offer.
   */
  trustFile: string | null;
}

/**
 * Where mkcert keeps its root certificate for the account the gateway runs
 * as: `$CAROOT` when set, otherwise mkcert's per-platform default directory.
 */
export function mkcertRootCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const dirs: string[] = [];
  if (env.CAROOT) dirs.push(env.CAROOT);
  if (platform === "darwin") {
    dirs.push(join(home, "Library", "Application Support", "mkcert"));
  } else if (platform === "win32") {
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, "mkcert"));
  } else {
    dirs.push(join(env.XDG_DATA_HOME || join(home, ".local", "share"), "mkcert"));
  }
  return dirs.map((dir) => join(dir, "rootCA.pem"));
}

function readCertificate(path: string, readFile: (path: string) => string): X509Certificate | null {
  try {
    return new X509Certificate(readFile(path));
  } catch {
    return null;
  }
}

/** A certificate authority whose key signed `served`. */
function issued(authority: X509Certificate, served: X509Certificate): boolean {
  try {
    return authority.ca && served.checkIssued(authority) && served.verify(authority.publicKey);
  } catch {
    return false;
  }
}

export interface AgentCertificateTrustInput {
  ownership: TlsOwnership;
  /** Where the served certificate's material lives. */
  certPath: string;
  /** The certificate the gateway presents right now. */
  servedCertPem: string;
  /** Files that may hold the authority behind an mkcert certificate, in order of preference. */
  authorityCandidates: readonly string[];
  readFile?: (path: string) => string;
}

export function resolveAgentCertificateTrust(
  input: AgentCertificateTrustInput,
): AgentCertificateTrust {
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const none = { kind: input.ownership, trustFile: null };
  let served: X509Certificate;
  try {
    served = new X509Certificate(input.servedCertPem);
  } catch {
    return none;
  }
  switch (input.ownership) {
    case "self-signed": {
      // The file on disk is what an agent reads; it must be the served one.
      const onDisk = readCertificate(input.certPath, readFile);
      return onDisk?.fingerprint256 === served.fingerprint256
        ? { kind: input.ownership, trustFile: resolve(input.certPath) }
        : none;
    }
    case "mkcert": {
      for (const candidate of input.authorityCandidates) {
        const authority = readCertificate(candidate, readFile);
        if (authority && issued(authority, served)) {
          return { kind: input.ownership, trustFile: resolve(candidate) };
        }
      }
      return none;
    }
    case "tailscale":
    case "external":
      return none;
  }
}

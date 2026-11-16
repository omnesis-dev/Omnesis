// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Checks an address the owner publishes the gateway at themselves (a domain,
 * a reverse proxy, Tailscale on the host): that its name resolves, that it
 * presents a certificate valid for that name, and that what answers there is
 * this gateway. The last is a one-time challenge: the gateway issues a nonce,
 * asks the address for `/.well-known/omnesis-address-check/<nonce>`, and only
 * this gateway, which issued the nonce moments ago, answers it.
 *
 * Whether the Internet at large reaches the address cannot be told from here:
 * the gateway asks from inside the owner's network, where a name may resolve
 * and answer for reasons that do not hold outside. The result says so rather
 * than guess.
 */

import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { connect as tlsConnect } from "node:tls";

/** How long an issued nonce is answered: one check, with room for a slow proxy. */
const NONCE_TTL_MS = 30_000;
/** The most nonces kept at once; older ones are dropped first. */
const MAX_NONCES = 32;
const STEP_TIMEOUT_MS = 8_000;
/** More than any nonce: what answers is read no further. */
const MAX_ANSWER_BYTES = 128;

export const ADDRESS_CHECK_PATH = "/.well-known/omnesis-address-check";

export type AddressCheckId = "resolves" | "certificate" | "answers";
export interface AddressCheckStep {
  id: AddressCheckId;
  ok: boolean;
  detail: string;
}
export interface AddressCheckResult {
  url: string;
  steps: AddressCheckStep[];
  /** Every step passed. */
  ok: boolean;
}

export interface AddressCheckDeps {
  resolve(host: string): Promise<string>;
  /**
   * Connects with the platform's trust and the name as SNI; resolves with a
   * fixed sentence naming what was wrong, or null when valid. The sentence
   * never carries what the far end sent, such as another certificate's names.
   */
  certificateProblem(host: string, port: number): Promise<string | null>;
  fetch(url: string, signal: AbortSignal): Promise<{ status: number; text(): Promise<string> }>;
  now(): number;
}

const liveDeps: AddressCheckDeps = {
  resolve: async (host) => (await lookup(host)).address,
  certificateProblem: (host, port) =>
    new Promise((resolve) => {
      const socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: true });
      const done = (problem: string | null) => {
        socket.destroy();
        resolve(problem);
      };
      socket.setTimeout(STEP_TIMEOUT_MS, () => done("Nothing answered in time."));
      socket.once("secureConnect", () => done(null));
      socket.once("error", (error) => done(certificateSentence(error)));
    }),
  fetch: async (url, signal) => {
    const response = await fetch(url, { signal, redirect: "manual" });
    return { status: response.status, text: () => readAtMost(response, MAX_ANSWER_BYTES) };
  },
  now: () => Date.now(),
};

/** A TLS failure as one of a few fixed sentences. */
export function certificateSentence(error: Error & { code?: string }): string {
  switch (error.code) {
    case "CERT_HAS_EXPIRED":
      return "It has expired.";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "It is for a different name.";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
      return "It is not from an authority this computer trusts.";
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "Nothing accepted a connection there.";
    default:
      return "It could not be verified.";
  }
}

/** The start of a response body, decoded; the rest is never read. */
async function readAtMost(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}

export class AddressChecks {
  private readonly issued = new Map<string, number>();

  constructor(private readonly deps: AddressCheckDeps = liveDeps) {}

  /** Whether `nonce` was issued here and is still current; answering spends it. */
  answer(nonce: string): boolean {
    const expiresAt = this.issued.get(nonce);
    this.issued.delete(nonce);
    return expiresAt !== undefined && expiresAt > this.deps.now();
  }

  async check(url: string): Promise<AddressCheckResult> {
    const parsed = new URL(url);
    // An IPv6 literal keeps its brackets in a URL, and neither DNS nor TLS takes them.
    const host = parsed.hostname.replace(/^\[(.*)\]$/u, "$1");
    const port = parsed.port ? Number(parsed.port) : 443;
    const steps: AddressCheckStep[] = [];
    const finish = () => ({
      url: parsed.origin,
      steps,
      ok: steps.length === 3 && steps.every((s) => s.ok),
    });

    try {
      const address = await this.deps.resolve(host);
      steps.push({ id: "resolves", ok: true, detail: `${host} resolves to ${address}.` });
    } catch {
      steps.push({
        id: "resolves",
        ok: false,
        detail: `${host} does not resolve from this gateway.`,
      });
      return finish();
    }

    const problem = await this.deps.certificateProblem(host, port);
    steps.push(
      problem === null
        ? { id: "certificate", ok: true, detail: `The certificate is valid for ${host}.` }
        : { id: "certificate", ok: false, detail: `The certificate was not accepted: ${problem}` },
    );
    if (problem !== null) return finish();

    const nonce = this.issue();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
    try {
      const response = await this.deps.fetch(
        `${parsed.origin}${ADDRESS_CHECK_PATH}/${nonce}`,
        controller.signal,
      );
      const body = response.status === 200 ? (await response.text()).trim() : "";
      steps.push(
        body === nonce
          ? { id: "answers", ok: true, detail: "This gateway answered at that address." }
          : {
              id: "answers",
              ok: false,
              detail: `Something answered (${response.status}), but not this gateway. Check where the address forwards to.`,
            },
      );
    } catch {
      steps.push({ id: "answers", ok: false, detail: "The address did not answer in time." });
    } finally {
      clearTimeout(timer);
      this.issued.delete(nonce);
    }
    return finish();
  }

  private issue(): string {
    const now = this.deps.now();
    for (const [nonce, expiresAt] of this.issued) if (expiresAt <= now) this.issued.delete(nonce);
    while (this.issued.size >= MAX_NONCES) this.issued.delete(this.issued.keys().next().value!);
    const nonce = randomBytes(18).toString("base64url");
    this.issued.set(nonce, now + NONCE_TTL_MS);
    return nonce;
  }
}

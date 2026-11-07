// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isIP } from "node:net";
import { z } from "zod";
import { connectOrigin } from "./network.js";

/** Only literal RFC1918/ULA destinations can become local routing hints. They confer no trust. */
export function privateDirectAddress(address: string): boolean {
  if (address.includes("%")) return false;
  if (isIP(address) === 6) return /^f[cd]/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}
export const directCandidateSchema = z
  .object({
    address: z.string().max(45).refine(privateDirectAddress),
    port: z.number().int().min(1).max(65535),
  })
  .strict();
export const directCandidatesSchema = z
  .object({
    version: z.literal(1),
    candidates: z.array(directCandidateSchema).max(8),
  })
  .strict();
export type DirectCandidate = z.infer<typeof directCandidateSchema>;

/** Auth/TLS/protocol failures are never treated as evidence that a LAN route is unavailable. */
export function connectivityFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ECONNRESET",
      "ENOTFOUND",
      "EAI_AGAIN",
    ].includes(String(error.code))
  );
}

export function deadlineFailure(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted && error instanceof Error && "code" in error && error.code === "ABORT_ERR";
}

/** Select an authenticated TLS socket before a single HTTP byte or device credential is forwarded. */
export async function connectPreferredGateway(
  options: {
    origin: URL;
    certificate?: string;
    fingerprint: string;
    tlsSpkiFingerprint?: string;
    candidates: DirectCandidate[];
    signal: AbortSignal;
    connectHost?: string;
  },
  connect: typeof connectOrigin = connectOrigin,
): ReturnType<typeof connectOrigin> {
  const candidates = z.array(directCandidateSchema).max(8).parse(options.candidates);
  const deadline = AbortSignal.any([options.signal, AbortSignal.timeout(5000)]);
  for (const candidate of candidates) {
    options.signal.throwIfAborted();
    if (deadline.aborted) break;
    const attemptSignal = AbortSignal.any([deadline, AbortSignal.timeout(750)]);
    try {
      return await connect(
        options.origin,
        options.certificate,
        attemptSignal,
        false,
        options.fingerprint,
        candidate.address,
        candidate.port,
        options.tlsSpkiFingerprint,
      );
    } catch (error) {
      options.signal.throwIfAborted();
      // A local per-candidate deadline is a reachability timeout, never a certificate error.
      if (!connectivityFailure(error) && !deadlineFailure(attemptSignal, error)) throw error;
    }
  }
  options.signal.throwIfAborted();
  return connect(
    options.origin,
    options.certificate,
    options.signal,
    false,
    options.fingerprint,
    options.connectHost,
    undefined,
    options.tlsSpkiFingerprint,
  );
}

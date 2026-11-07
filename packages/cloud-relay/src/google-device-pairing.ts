// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { Agent, request, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { authorizeGoogleDesktop } from "./google-desktop.js";
import { accountId } from "./identity.js";
import {
  gatewayBindingSchema,
  gatewayBindingNonce,
  validateCertificateDates,
  certificateFingerprint,
  bindingOrigin,
  type GatewayBinding,
} from "./gateway-binding.js";
import { googlePairingNonce, googlePairingVerificationCode } from "./google-pairing.js";
import { exchangeRelayIdentity, readBoundedJson } from "./google-credentials.js";
import {
  directCandidatesSchema,
  connectivityFailure,
  deadlineFailure,
  connectPreferredGateway,
  type DirectCandidate,
} from "./direct-path.js";
import { GatewayTlsIdentityRefused, tlsSpkiFingerprint } from "./pinned-key.js";
import { connectOrigin, relayOrigin } from "./network.js";

const statusSchema = z.object({
  status: z.enum(["pending", "approved", "denied"]),
  verificationCode: z.string(),
  expiresAt: z.number().int().positive(),
  pairingCode: z.string().min(1).max(512).optional(),
});
const credentialSchema = z.object({
  token: z.string().min(1).max(4096),
  device: z.object({ id: z.string().uuid(), kind: z.enum(["cli", "collector"]) }),
  scopes: z.array(z.string().min(1).max(128)).max(128),
});
export type GatewayTlsTarget = Pick<GatewayBinding, "publicOrigin" | "certificate">;

export interface GoogleDevicePairing {
  gatewayUrl: string;
  gatewayFingerprint: string;
  gatewayCertificate: string;
  tlsSpkiFingerprint?: string;
  directCandidates?: DirectCandidate[];
  token: string;
  deviceId: string;
  kind: "cli" | "collector";
  scopes: string[];
}

/** Only the public candidate certificate is provisional. The pairing exchange is gated by local confirmation. */
export async function pairGoogleDevice(
  options: {
    relayUrl: string;
    sessionFile: string;
    clientId: string;
    clientSecret?: string;
    kind: "cli" | "collector";
    name: string;
    confirm(
      value: { gatewayUrl: string; verificationCode: string },
      signal: AbortSignal,
    ): Promise<boolean>;
    signal?: AbortSignal;
  },
  dependencies: {
    authorize?: typeof authorizeGoogleDesktop;
    fetch?: typeof fetch;
    gatewayJson?: typeof pinnedGatewayJson;
    wait?: (signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<GoogleDevicePairing> {
  const relay = relayOrigin(options.relayUrl);
  const value = {
    requestId: randomUUID(),
    secret: randomBytes(32).toString("hex"),
    kind: options.kind,
    name: z.string().trim().min(1).max(80).parse(options.name),
  };
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(600_000),
  ]);
  signal.throwIfAborted();
  const credentials = await (dependencies.authorize ?? authorizeGoogleDesktop)({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    nonce: googlePairingNonce(value),
    signal,
  });
  const session = await exchangeRelayIdentity({
    relayUrl: relay.href,
    sessionFile: options.sessionFile,
    idToken: credentials.idToken,
    expectedAccountId: accountId(credentials.identity),
    fetch: dependencies.fetch,
    signal,
  });
  const directory = await (dependencies.fetch ?? fetch)(new URL("/_relay/v2/gateway", relay), {
    headers: { authorization: `Bearer ${session.token}` },
    redirect: "error",
    signal,
  });
  if (!directory.ok) throw new Error("No gateway is registered for this Google account");
  const candidate = gatewayBindingSchema.parse(await readBoundedJson(directory));
  // This validates the public leaf and its DNS name, without trusting a historical, expired login token.
  // A separate comparison on an already trusted device establishes trust in this candidate key.
  gatewayBindingNonce(candidate);
  const certificate = new X509Certificate(candidate.certificate);
  validateCertificateDates(certificate);
  const gatewayUrl = bindingOrigin(candidate.publicOrigin).origin;
  const fingerprint = certificateFingerprint(candidate.certificate);
  const code = googlePairingVerificationCode(value, fingerprint);
  const json = dependencies.gatewayJson ?? pinnedGatewayJson;
  const check = (input: unknown) => {
    const result = statusSchema.parse(input);
    if (result.verificationCode !== code)
      throw new Error("Gateway comparison code changed; pairing refused");
    if (result.expiresAt <= Date.now()) throw new Error("Google pairing request expired");
    if (result.status === "denied") throw new Error("Gateway owner denied the pairing request");
    return result;
  };
  let status = check(
    await json(
      candidate,
      "/devices/google/request",
      { ...value, identityToken: credentials.idToken },
      signal,
    ),
  );
  if (
    !(await compareBeforeExpiry(
      options.confirm,
      { gatewayUrl, verificationCode: code },
      status.expiresAt,
      signal,
    ))
  )
    throw new Error("Gateway comparison was cancelled");
  signal.throwIfAborted();
  status = check(status);
  while (status.status === "pending") {
    await (dependencies.wait ?? ((signal) => delay(1000, undefined, { signal })))(signal);
    status = check(
      await json(
        candidate,
        "/devices/google/poll",
        { requestId: value.requestId, secret: value.secret },
        signal,
      ),
    );
  }
  if (!status.pairingCode) throw new Error("Gateway approval did not include a pairing code");
  signal.throwIfAborted();
  check(status);
  const paired = credentialSchema.parse(
    await json(
      candidate,
      "/devices/pair",
      {
        pairingCode: status.pairingCode,
        capabilities: {
          platform: options.kind,
          suggestedName: value.name,
          installId: value.requestId,
          tls: { mode: "pinned-key-strict" },
        },
      },
      signal,
    ),
  );
  if (paired.device.kind !== options.kind) throw new Error("Gateway paired the wrong device kind");
  const directCandidates = await discoverDirectCandidates(candidate, paired.token, signal, json);
  return {
    gatewayUrl,
    tlsSpkiFingerprint: tlsSpkiFingerprint(candidate.certificate),
    directCandidates,
    gatewayFingerprint: fingerprint,
    gatewayCertificate: candidate.certificate,
    token: paired.token,
    deviceId: paired.device.id,
    kind: options.kind,
    scopes: paired.scopes,
  };
}

async function compareBeforeExpiry(
  confirm: (
    value: { gatewayUrl: string; verificationCode: string },
    signal: AbortSignal,
  ) => Promise<boolean>,
  value: { gatewayUrl: string; verificationCode: string },
  expiresAt: number,
  signal: AbortSignal,
): Promise<boolean> {
  const expiry = new AbortController();
  const timer = setTimeout(
    () => expiry.abort(new Error("Google pairing request expired")),
    Math.max(1, Math.min(600_000, expiresAt - Date.now())),
  );
  const comparison = AbortSignal.any([signal, expiry.signal]);
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(comparison.reason);
  });
  comparison.addEventListener("abort", abort, { once: true });
  try {
    comparison.throwIfAborted();
    return await Promise.race([confirm(value, comparison), cancelled]);
  } finally {
    clearTimeout(timer);
    comparison.removeEventListener("abort", abort);
  }
}

/** No HTTP byte, cookie or device credential is written until the peer proves possession of the pinned TLS key. */
export async function pinnedGatewayJson(
  candidate: GatewayTlsTarget,
  path: string,
  body: unknown,
  signal: AbortSignal,
  connectHost?: string,
  options?: {
    token?: string;
    connectPort?: number;
    tlsSpkiFingerprint?: string;
    directCandidates?: DirectCandidate[];
  },
): Promise<unknown> {
  if (
    ![
      "/devices/google/request",
      "/devices/google/poll",
      "/devices/pair",
      "/devices/direct-candidates",
      "/whoami",
    ].includes(path)
  )
    throw new Error("Unsupported pairing endpoint");
  const origin = bindingOrigin(candidate.publicOrigin);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  if (options?.directCandidates !== undefined && path !== "/devices/direct-candidates")
    throw new Error("Direct discovery hints require the authenticated discovery endpoint");
  const fingerprint = certificateFingerprint(candidate.certificate);
  let stream;
  if (options?.directCandidates === undefined) {
    stream = await connectOrigin(
      origin,
      candidate.certificate,
      deadline,
      false,
      fingerprint,
      connectHost,
      options?.connectPort,
      options?.tlsSpkiFingerprint,
    );
  } else {
    // The endpoint guard above limits hinted selection to direct-candidate metadata.
    // A reassigned DHCP address is not an authority: recover only this bodyless GET
    // through a fresh canonical dial with the identical saved TLS identity and bearer.
    let rejectedHint = false;
    try {
      stream = await connectPreferredGateway(
        {
          origin,
          certificate: candidate.certificate,
          fingerprint,
          tlsSpkiFingerprint: options.tlsSpkiFingerprint,
          candidates: options.directCandidates,
          signal: deadline,
          connectHost,
        },
        async (...args) => {
          try {
            return await connectOrigin(...args);
          } catch (error) {
            if (args[6] !== undefined && error instanceof GatewayTlsIdentityRefused)
              rejectedHint = true;
            throw error;
          }
        },
      );
    } catch (error) {
      if (body !== undefined || !rejectedHint) throw error;
      deadline.throwIfAborted();
      stream = await connectOrigin(
        origin,
        candidate.certificate,
        deadline,
        false,
        fingerprint,
        connectHost,
        undefined,
        options.tlsSpkiFingerprint,
      );
    }
  }
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => stream;
  try {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const upstream = request({
      path,
      method: body === undefined ? "GET" : "POST",
      agent,
      signal: deadline,
      headers: {
        host: origin.host,
        ...(options?.token ? { authorization: `Bearer ${options.token}` } : {}),
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    });
    const response = once(upstream, "response") as Promise<[IncomingMessage]>;
    upstream.end(payload);
    const [reply] = await response;
    if (reply.statusCode !== 200) {
      reply.destroy();
      throw new GatewayRequestRefused(reply.statusCode);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of reply) {
      size += chunk.length;
      if (size > 65_536) throw new Error("Gateway pairing response is too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    agent.destroy();
    stream.destroy();
  }
}

export class GatewayRequestRefused extends Error {
  constructor(readonly status: number | undefined) {
    super("Gateway pairing request refused");
  }
}

/** Old gateways may omit discovery; only network failures or an explicit absent route retain saved hints. */
export async function discoverDirectCandidates(
  candidate: GatewayTlsTarget,
  token: string,
  signal: AbortSignal,
  json: typeof pinnedGatewayJson = pinnedGatewayJson,
  saved: DirectCandidate[] = [],
  tlsSpkiFingerprint?: string,
): Promise<DirectCandidate[]> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  try {
    return directCandidatesSchema.parse(
      await json(candidate, "/devices/direct-candidates", undefined, requestSignal, undefined, {
        token,
        tlsSpkiFingerprint,
        directCandidates: saved,
      }),
    ).candidates;
  } catch (error) {
    signal.throwIfAborted();
    if (
      connectivityFailure(error) ||
      (error instanceof GatewayRequestRefused &&
        error.status !== undefined &&
        (error.status === 404 ||
          error.status === 429 ||
          (error.status >= 500 && error.status <= 599))) ||
      deadlineFailure(requestSignal, error)
    )
      return saved;
    throw error;
  }
}

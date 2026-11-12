// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { Agent, request, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  gatewayBindingNonce,
  validateCertificateDates,
  certificateFingerprint,
  bindingOrigin,
  type GatewayBinding,
} from "./gateway-binding.js";
import { readBoundedJson } from "./google-credentials.js";
import {
  directCandidatesSchema,
  connectivityFailure,
  deadlineFailure,
  connectPreferredGateway,
  type DirectCandidate,
} from "./direct-path.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import { connectOrigin } from "./network.js";
import {
  enrollmentNonce,
  enrollmentOpaque,
  enrollmentSignatureTranscript,
  pairingCodeCommitment,
  pairingCodeSchema,
  pairingComparisonCode,
  signDeviceTranscript,
  type SignInProof,
} from "./device-enrollment.js";
import { certificateIsPubliclyLogged } from "./public-certificate.js";
import type { DeviceKey } from "./device-key-file.js";

const statusSchema = z.object({
  status: z.enum(["pending", "approved", "denied"]),
  verificationCode: pairingCodeSchema,
  codeNonce: enrollmentOpaque,
  expiresAt: z.number().int().positive(),
  pairingCode: z.string().min(1).max(512).optional(),
});
const credentialSchema = z.object({
  token: z.string().min(1).max(4096),
  device: z.object({ id: z.string().uuid(), kind: z.enum(["cli", "collector"]) }),
  scopes: z.array(z.string().min(1).max(128)).max(128),
});
export type GatewayTlsTarget = Pick<GatewayBinding, "publicOrigin" | "certificate">;

export interface CloudDevicePairing {
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

export interface CloudDevicePairingOptions {
  kind: "cli" | "collector";
  name: string;
  confirm(
    value: { gatewayUrl: string; verificationCode: string },
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Called once when a held request only needs approval elsewhere; pairing then waits by itself. */
  awaitApproval?(value: { gatewayUrl: string; verificationCode: string }): void;
  signal?: AbortSignal;
}
export interface CloudPairingRequest {
  requestId: string;
  secret: string;
  kind: "cli" | "collector";
  name: string;
  /** The value a sign-in commits to, when this install has a device key. */
  enrollmentNonce?: string;
}
const challengeSchema = z.object({
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().positive(),
});

/** Discovery selects a provisional gateway; trusted-device approval establishes the pinned data identity. */
export async function pairCloudDevice(
  options: CloudDevicePairingOptions,
  dependencies: {
    discover(
      value: CloudPairingRequest,
      signal: AbortSignal,
    ): Promise<{
      candidate: GatewayBinding;
      identityToken: string;
      method: "google" | "account";
      proof?: SignInProof;
    }>;
    gatewayJson?: typeof pinnedGatewayJson;
    wait?: (signal: AbortSignal) => Promise<void>;
    deviceKey?: DeviceKey;
    publiclyLogged?: typeof certificateIsPubliclyLogged;
  },
): Promise<CloudDevicePairing> {
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
  const deviceKey = dependencies.deviceKey;
  const discovery = await dependencies.discover(
    deviceKey
      ? {
          ...value,
          enrollmentNonce: enrollmentNonce({ ...value, devicePublicKey: deviceKey.publicKey }),
        }
      : value,
    signal,
  );
  signal.throwIfAborted();
  const candidate = discovery.candidate;
  // This validates the public leaf and its DNS name, without trusting a historical, expired login token.
  // A separate comparison on an already trusted device establishes trust in this candidate key.
  gatewayBindingNonce(candidate);
  const certificate = new X509Certificate(candidate.certificate);
  validateCertificateDates(certificate);
  const gatewayUrl = bindingOrigin(candidate.publicOrigin).origin;
  const fingerprint = certificateFingerprint(candidate.certificate);
  const json = dependencies.gatewayJson ?? pinnedGatewayJson;
  // The gateway commits to its part of the comparison code before it learns this request's
  // secret, and reveals it afterwards. That order is what makes a six-digit code enough: a
  // substitute gateway cannot pick a nonce that reproduces the real gateway's code here.
  const { challenge } = challengeSchema.parse(
    await json(candidate, `/devices/${discovery.method}/challenge`, {}, signal),
  );
  let code: string | undefined;
  const check = (input: unknown) => {
    const result = statusSchema.parse(input);
    if (pairingCodeCommitment(result.codeNonce) !== challenge)
      throw new Error("Gateway did not keep its comparison code commitment; pairing refused");
    // Computed here from the certificate this device connected to, never taken from the reply.
    code ??= pairingComparisonCode({
      ...value,
      gatewayFingerprint: fingerprint,
      codeNonce: result.codeNonce,
    });
    if (result.verificationCode !== code)
      throw new Error("Gateway comparison code changed; pairing refused");
    if (result.expiresAt <= Date.now()) throw new Error("Device pairing request expired");
    if (result.status === "denied") throw new Error("Gateway owner denied the pairing request");
    return result;
  };
  const evidence = deviceKey
    ? await enrollmentEvidence(
        value,
        deviceKey,
        candidate,
        discovery,
        challenge,
        signal,
        dependencies,
      )
    : { challenge };
  let status = check(
    await json(
      candidate,
      `/devices/${discovery.method}/request`,
      { ...value, identityToken: discovery.identityToken, ...evidence },
      signal,
    ),
  );
  // A signed request to a publicly logged certificate cannot have reached a substitute gateway,
  // so it needs no typed comparison: once approved it continues, and while held it only waits
  // for the approval. Any other gateway could be a substitute, so the person compares codes here.
  const admitted = "deviceKey" in evidence && !("requireApproval" in evidence);
  const shown = { gatewayUrl, verificationCode: status.verificationCode };
  if (admitted && status.status === "pending" && options.awaitApproval)
    options.awaitApproval(shown);
  else if (
    !(admitted && status.status === "approved") &&
    !(await compareBeforeExpiry(options.confirm, shown, status.expiresAt, signal))
  )
    throw new Error("Gateway comparison was cancelled");
  signal.throwIfAborted();
  status = check(status);
  while (status.status === "pending") {
    await (dependencies.wait ?? ((signal) => delay(1000, undefined, { signal })))(signal);
    status = check(
      await json(
        candidate,
        `/devices/${discovery.method}/poll`,
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

/** Signs for the key this device was shown, so a substituted certificate makes the real gateway refuse. */
async function enrollmentEvidence(
  value: Omit<CloudPairingRequest, "enrollmentNonce">,
  deviceKey: DeviceKey,
  candidate: GatewayBinding,
  discovery: { proof?: SignInProof },
  challenge: string,
  signal: AbortSignal,
  dependencies: { publiclyLogged?: typeof certificateIsPubliclyLogged },
) {
  const signature = signDeviceTranscript(
    deviceKey.privateKey,
    enrollmentSignatureTranscript({
      requestId: value.requestId,
      kind: value.kind,
      name: value.name,
      gatewaySpkiFingerprint: tlsSpkiFingerprint(candidate.certificate),
      challenge,
      devicePublicKey: deviceKey.publicKey,
    }),
  );
  const logged = await (dependencies.publiclyLogged ?? certificateIsPubliclyLogged)(
    candidate,
    signal,
  );
  return {
    deviceKey: { publicKey: deviceKey.publicKey, challenge, signature },
    ...(discovery.proof ? { proof: discovery.proof } : {}),
    // Without a publicly logged certificate, a person comparing codes takes the place of that check.
    ...(logged ? {} : { requireApproval: true }),
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
    () => expiry.abort(new Error("Device pairing request expired")),
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
      "/devices/account/request",
      "/devices/google/poll",
      "/devices/account/poll",
      "/devices/google/challenge",
      "/devices/account/challenge",
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
    // The endpoint guard above limits hinted selection to direct-candidate metadata. A hint is
    // tried first and skipped when unreachable or held by another machine; the canonical dial
    // that follows requires the identical saved TLS identity before the bearer is written.
    stream = await connectPreferredGateway({
      origin,
      certificate: candidate.certificate,
      fingerprint,
      tlsSpkiFingerprint: options.tlsSpkiFingerprint,
      candidates: options.directCandidates,
      signal: deadline,
      connectHost,
    });
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

/**
 * Old gateways may omit discovery; only network failures or an explicit absent route retain saved hints.
 * `dial` names the hints worth trying before the canonical route: a caller that knows it is away
 * from the gateway's network passes none, and keeps `saved` as the answer to fall back on.
 */
export async function discoverDirectCandidates(
  candidate: GatewayTlsTarget,
  token: string,
  signal: AbortSignal,
  json: typeof pinnedGatewayJson = pinnedGatewayJson,
  saved: DirectCandidate[] = [],
  tlsSpkiFingerprint?: string,
  dial: DirectCandidate[] = saved,
): Promise<DirectCandidate[]> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  try {
    return directCandidatesSchema.parse(
      await json(candidate, "/devices/direct-candidates", undefined, requestSignal, undefined, {
        token,
        tlsSpkiFingerprint,
        directCandidates: dial,
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

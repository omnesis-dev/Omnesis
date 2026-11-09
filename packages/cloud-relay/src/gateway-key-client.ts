// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, link, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile, atomicWriteFileSync } from "@omnesis/core";
import { z } from "zod";
import {
  keyChallengeSchema,
  keyAuthenticationTranscript,
  gatewayKeyAccount,
  publicKeyFingerprint,
  tlsKeySignatureAlgorithm,
  validateKeyRegistration,
  type KeyRegistration,
} from "./gateway-key-auth.js";
import { readBoundedJson, readPrivateJson } from "./google-credentials.js";
import { bindingOrigin } from "./gateway-binding.js";
import { challengeIsFresh, relayOrigin } from "./network.js";
import { gatewayRecoveryDraft, readGatewayRecoveryReceipt } from "./gateway-recovery.js";

export interface GatewayKeySessionOptions {
  relayUrl: string;
  sessionFile: string;
  gatewayId: string;
  publicOrigin: string;
  certificateFile: string;
  privateKeyFile: string;
  ownerKeyFile?: string;
  enrollmentTokenFile?: string;
  recoveryReceiptFile?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}
const sessionSchema = z.object({
  token: z.string().min(1).max(4096),
  accountId: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
});
type Session = z.infer<typeof sessionSchema>;
/**
 * The relay answered a gateway it had registered before, with both keys proven, that it holds no
 * registration for it: its Omnesis account was deleted. Only this answer means that; a relay that
 * is unreachable or failing says something else.
 */
export class GatewayUnregistered extends Error {
  constructor() {
    super("The relay no longer has a registration for this gateway");
  }
}
interface Material {
  registration: KeyRegistration;
  owner: KeyObject;
  tls: KeyObject;
  enrolled: boolean;
}

async function readKeyText(path: string): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > 65_536) throw new Error("Gateway key file is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Exclusive publication keeps a concurrent registration from replacing the stable owner identity. */
export async function readOrCreateGatewayOwnerKey(
  path: string,
  allowCreate = true,
): Promise<KeyObject> {
  let material: string;
  try {
    material = await readKeyText(path);
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
    if (!allowCreate) {
      // Keep private identity paths out of recursively rendered error causes.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Gateway owner identity key is missing; restore the original key");
    }
    const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await atomicWriteFile(temporary, key, { mode: 0o600 });
      try {
        await link(temporary, path);
      } catch (error) {
        if (!(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    material = await readKeyText(path);
  }
  const key = createPrivateKey(material);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Gateway owner identity requires an Ed25519 private key");
  return key;
}

async function readOwnerIdentity(
  options: Pick<GatewayKeySessionOptions, "sessionFile" | "ownerKeyFile" | "recoveryReceiptFile">,
): Promise<{ owner: KeyObject; enrolled: boolean }> {
  let allowCreate = !existsSync(
    options.recoveryReceiptFile ?? `${options.sessionFile}.recovery.json`,
  );
  try {
    const stored = await readPrivateJson(options.sessionFile);
    allowCreate &&= !(
      typeof stored === "object" &&
      stored !== null &&
      "authentication" in stored &&
      stored.authentication === "gateway-key-v2"
    );
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  const owner = await readOrCreateGatewayOwnerKey(
    options.ownerKeyFile ?? `${options.sessionFile}.owner-key`,
    allowCreate,
  );
  return { owner, enrolled: !allowCreate };
}

/** Public DNS enrollment details can be prepared offline; private owner material never leaves its file. */
export async function prepareGatewayOwner(
  options: Pick<GatewayKeySessionOptions, "sessionFile" | "gatewayId" | "ownerKeyFile"> & {
    publicOrigin?: string;
  },
): Promise<{
  gatewayId: string;
  accountId: string;
  publicOrigin?: string;
  dns?: { name: string; value: string };
}> {
  const gatewayId = z.string().uuid().parse(options.gatewayId).toLowerCase();
  const origin = options.publicOrigin ? bindingOrigin(options.publicOrigin) : undefined;
  const { owner } = await readOwnerIdentity(options);
  const accountId = gatewayKeyAccount({
    gatewayId,
    ownerPublicKey: createPublicKey(owner).export({ type: "spki", format: "pem" }).toString(),
  });
  return {
    gatewayId,
    accountId,
    ...(origin
      ? {
          publicOrigin: origin.origin,
          dns: {
            name: `_omnesis-gateway.${origin.hostname}`,
            value: `omnesis-relay-v2:${accountId}:${gatewayId}`,
          },
        }
      : {}),
  };
}

/** Recovery requests use the existing owner only; neither missing keys nor stale session markers authorize replacement. */
export async function prepareGatewayRecoveryRequest(
  options: Pick<
    GatewayKeySessionOptions,
    "sessionFile" | "ownerKeyFile" | "gatewayId" | "publicOrigin" | "relayUrl"
  >,
) {
  const owner = await readOrCreateGatewayOwnerKey(
    options.ownerKeyFile ?? `${options.sessionFile}.owner-key`,
    false,
  );
  return gatewayRecoveryDraft(options, {
    gatewayId: options.gatewayId,
    publicOrigin: options.publicOrigin,
    ownerPublicKey: createPublicKey(owner).export({ type: "spki", format: "pem" }).toString(),
  });
}

async function readMaterial(options: GatewayKeySessionOptions): Promise<Material> {
  options.signal?.throwIfAborted();
  const certificate = await readKeyText(options.certificateFile);
  const tls = createPrivateKey(await readKeyText(options.privateKeyFile));
  const leaf = new X509Certificate(certificate);
  if (publicKeyFingerprint(createPublicKey(tls)) !== publicKeyFingerprint(leaf.publicKey))
    throw new Error("Gateway TLS certificate and private key do not match");
  const { owner, enrolled } = await readOwnerIdentity(options);
  const registration = validateKeyRegistration({
    gatewayId: options.gatewayId,
    publicOrigin: options.publicOrigin,
    certificate: leaf.toString(),
    ownerPublicKey: createPublicKey(owner).export({ type: "spki", format: "pem" }).toString(),
  });
  options.signal?.throwIfAborted();
  return { registration, tls, owner, enrolled };
}

async function exchange(
  options: GatewayKeySessionOptions,
  material: Material,
  attempt = 0,
): Promise<{ session: Session; registration: KeyRegistration }> {
  options.signal?.throwIfAborted();
  const relay = relayOrigin(options.relayUrl);
  const post = async (path: string, body: unknown): Promise<unknown> => {
    options.signal?.throwIfAborted();
    const response = await (options.fetch ?? fetch)(new URL(path, relay), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    if (response.status === 410 && material.enrolled) throw new GatewayUnregistered();
    if (!response.ok) throw new Error("Gateway key registration refused");
    const value = await readBoundedJson(response);
    options.signal?.throwIfAborted();
    return value;
  };
  let enrollmentToken: string | undefined;
  if (options.enrollmentTokenFile && !material.enrolled) {
    try {
      enrollmentToken = z
        .object({ enrollmentToken: z.string().min(1).max(4096) })
        .parse(await readPrivateJson(options.enrollmentTokenFile)).enrollmentToken;
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  const recoveryReceipt = await readGatewayRecoveryReceipt(options, material.registration);
  options.signal?.throwIfAborted();
  const challenge = keyChallengeSchema.parse(
    await post("/_relay/v2/key/challenge", { ...material.registration, relayOrigin: relay.origin }),
  );
  if (challenge.relayOrigin !== relay.origin || !challengeIsFresh(challenge.expiresAt))
    throw new Error("Invalid gateway key challenge expiry");
  options.signal?.throwIfAborted();
  const signature = (purpose: "owner" | "tls", key: KeyObject) =>
    sign(
      purpose === "owner" ? null : tlsKeySignatureAlgorithm(key),
      keyAuthenticationTranscript(material.registration, challenge, purpose),
      key,
    ).toString("base64url");
  const session = sessionSchema.parse(
    await post("/_relay/v2/key/complete", {
      challengeId: challenge.challengeId,
      ownerSignature: signature("owner", material.owner),
      tlsSignature: signature("tls", material.tls),
      ...(enrollmentToken ? { enrollmentToken } : {}),
      ...(recoveryReceipt ? { recoveryReceipt } : {}),
    }),
  );
  if (
    session.accountId !== gatewayKeyAccount(material.registration) ||
    session.expiresAt <= Date.now() / 1000
  )
    throw new Error("Relay returned an invalid owner-key session");
  const current = await readMaterial(options);
  if (JSON.stringify(current.registration) !== JSON.stringify(material.registration)) {
    if (attempt >= 1)
      throw new Error("Gateway key material changed repeatedly during registration");
    return exchange(options, current, attempt + 1);
  }
  await mkdir(dirname(options.sessionFile), { recursive: true, mode: 0o700 });
  options.signal?.throwIfAborted();
  // A cancelled generation cannot publish after a replacement routing session.
  atomicWriteFileSync(
    options.sessionFile,
    JSON.stringify({ ...session, authentication: "gateway-key-v2" }) + "\n",
    { mode: 0o600 },
  );
  return { session, registration: material.registration };
}

/** Register a gateway without SSO. Both private keys remain on its host. */
export async function registerGatewayKey(options: GatewayKeySessionOptions): Promise<Session> {
  return (await exchange(options, await readMaterial(options))).session;
}

export interface GatewayKeySessionSource {
  (signal?: AbortSignal): Promise<string>;
  invalidate(): void;
}

/** Invalidation fences old exchanges and forces fresh owner/TLS proofs after relay authentication resets. */
export function gatewayKeySessionSource(
  options: GatewayKeySessionOptions,
): GatewayKeySessionSource {
  let current:
    { session: Session; certificate: string; accountId: string; origin: string } | undefined;
  let pending: Promise<string> | undefined;
  let generation = 0;
  let abort = new AbortController();
  const source = (signal?: AbortSignal): Promise<string> => {
    const caller = AbortSignal.any([
      abort.signal,
      ...(options.signal ? [options.signal] : []),
      ...(signal ? [signal] : []),
    ]);
    try {
      caller.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }
    if (pending) return pending;
    const version = generation;
    const scoped = { ...options, signal: caller };
    const release = (): void => {
      if (pending === operation) pending = undefined;
    };
    const operation = readMaterial(scoped)
      .then(async (material) => {
        caller.throwIfAborted();
        const id = gatewayKeyAccount(material.registration),
          origin = material.registration.publicOrigin;
        if (
          current &&
          current.session.expiresAt > Date.now() / 1000 + 30 &&
          current.certificate === material.registration.certificate &&
          current.accountId === id &&
          current.origin === origin
        )
          return current.session.token;
        const issued = await exchange(scoped, material);
        caller.throwIfAborted();
        current = {
          session: issued.session,
          certificate: issued.registration.certificate,
          accountId: gatewayKeyAccount(issued.registration),
          origin: issued.registration.publicOrigin,
        };
        return issued.session.token;
      })
      .finally(() => {
        caller.removeEventListener("abort", release);
        if (version === generation) release();
      });
    pending = operation;
    caller.addEventListener("abort", release, { once: true });
    return operation;
  };
  source.invalidate = (): void => {
    generation++;
    abort.abort(new Error("Gateway routing session invalidated"));
    abort = new AbortController();
    current = undefined;
    pending = undefined;
  };
  return source;
}

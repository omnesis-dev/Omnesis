// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Passkey ceremonies on this gateway's own page (`gateway-passkey`, see docs/device-enrollment.md).
// The gateway issues the challenge and names the origin it vouches for; this page only runs the
// ceremony there and sends the assertion back. The relay serves none of it.

import { base64url, fromBase64url } from "./cloud-pairing.js";

/** Whether this browser can make a passkey assertion at all. */
export function passkeysSupported(nav = globalThis.navigator) {
  return (
    typeof globalThis.PublicKeyCredential === "function" &&
    typeof nav?.credentials?.get === "function"
  );
}

/**
 * Whether this page is on the origin the gateway vouches for. A passkey assertion made anywhere
 * else (a local address, another name) is refused by the gateway, so the page offers a link to
 * the right one instead.
 */
export function onGatewayOrigin(ceremonyOrigin, location = globalThis.location) {
  return typeof ceremonyOrigin === "string" && location?.origin === ceremonyOrigin;
}

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

/** Thrown with a message a person can act on. */
export class GatewayPasskeyError extends Error {}

/**
 * Runs the passkey prompt for a ceremony the gateway issued and returns the `gateway-passkey`
 * proof to send back. Any account passkey may answer (discoverable credentials); the gateway
 * decides whether it is one it trusts.
 */
export async function gatewayPasskeyProof(
  ceremony,
  { credentials = globalThis.navigator?.credentials, location = globalThis.location, signal } = {},
) {
  if (
    !ceremony ||
    !OPAQUE.test(ceremony.challenge ?? "") ||
    !OPAQUE.test(ceremony.webauthnChallenge ?? "") ||
    typeof ceremony.rpId !== "string"
  )
    throw new GatewayPasskeyError("This gateway sent an unexpected passkey request. Try again.");
  if (!onGatewayOrigin(ceremony.origin, location))
    throw new GatewayPasskeyError(`Open this page at ${ceremony.origin} to use your passkey.`);
  let credential;
  try {
    credential = await credentials.get({
      publicKey: {
        challenge: fromBase64url(ceremony.webauthnChallenge),
        rpId: ceremony.rpId,
        allowCredentials: [],
        userVerification: "required",
        timeout: 120_000,
      },
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new GatewayPasskeyError("The passkey prompt was closed or timed out. Try again.");
  }
  const response = credential?.response;
  if (!credential || !response?.userHandle)
    throw new GatewayPasskeyError("That passkey can't be used here. Try your Omnesis passkey.");
  return {
    type: "gateway-passkey",
    challenge: ceremony.challenge,
    credential: {
      id: credential.id,
      rawId: base64url(credential.rawId),
      type: "public-key",
      ...(credential.authenticatorAttachment === "platform" ||
      credential.authenticatorAttachment === "cross-platform"
        ? { authenticatorAttachment: credential.authenticatorAttachment }
        : {}),
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(response.clientDataJSON),
        authenticatorData: base64url(response.authenticatorData),
        signature: base64url(response.signature),
        userHandle: base64url(response.userHandle),
      },
    },
  };
}

/** The header a request carries its step-up id in (packages/gateway/src/http/step-up.ts). */
export const STEP_UP_HEADER = "X-Omnesis-Step-Up";

export const STEP_UP_UNAVAILABLE =
  "This action needs your passkey, which can't be used on this gateway right now. Do it on the gateway itself.";

/**
 * The owner confirms one administrative action with a passkey on this gateway's page. The gateway
 * refused the request with 428 and named it in `detail` (method, path and body hash); this runs
 * the ceremony for exactly that request and returns the one-use id to send it again with.
 * `post(path, body, signal)` sends a JSON body with this session's credentials.
 */
export async function stepUp(detail, { post, prove = gatewayPasskeyProof, signal } = {}) {
  const target = { method: detail?.method, path: detail?.path, bodySha256: detail?.bodySha256 };
  const options = await post("/admin/step-up/options", target, signal);
  if (!options.ok) throw new GatewayPasskeyError(STEP_UP_UNAVAILABLE);
  const proof = await prove(await options.json(), signal ? { signal } : {});
  const response = await post("/admin/step-up", { ...target, proof }, signal);
  if (!response.ok)
    throw new GatewayPasskeyError(
      "Your gateway didn't accept that passkey. Use a passkey you confirmed on this gateway.",
    );
  return (await response.json()).stepUpId;
}

/** Byte-for-byte approvalDeviceTranscript from packages/cloud-relay/src/device-enrollment.ts. */
export function approvalDeviceTranscript(requestId, challenge) {
  return JSON.stringify(["omnesis-gateway-approval-device-v1", requestId, challenge]);
}

async function postJson(path, body, signal) {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Approves a held request with the owner's passkey on this gateway's page. A portal's request
 * also needs `deviceKey`, the private key of the browser that asked, which signs the challenge.
 */
export async function approveWithPasskey(
  { requestId, trustSignIn, deviceKey, signal },
  { prove = gatewayPasskeyProof, sign = signApproval } = {},
) {
  const options = await postJson("/devices/account/approval/options", { requestId }, signal);
  if (!options.ok)
    throw new GatewayPasskeyError("This request can't be approved here anymore. It may have expired.");
  const ceremony = await options.json();
  const proof = await prove(ceremony, { ...(signal ? { signal } : {}) });
  const response = await postJson(
    "/devices/account/approval",
    {
      requestId,
      proof,
      ...(trustSignIn === undefined ? {} : { trustSignIn }),
      ...(deviceKey ? { deviceSignature: await sign(deviceKey, requestId, ceremony.challenge) } : {}),
    },
    signal,
  );
  if (response.status === 403)
    throw new GatewayPasskeyError(
      deviceKey === undefined
        ? "Your gateway didn't accept that passkey. Use a passkey you confirmed on this gateway."
        : "Your gateway didn't accept this approval. Use a passkey you confirmed on this gateway, in the browser that asked to join.",
    );
  if (!response.ok) throw new GatewayPasskeyError("Couldn't approve this request. Try again.");
}

/** ECDSA P-256 over the approval transcript, base64url IEEE P1363 as WebCrypto returns it. */
export async function signApproval(privateKey, requestId, challenge) {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(approvalDeviceTranscript(requestId, challenge)),
  );
  return base64url(signature);
}

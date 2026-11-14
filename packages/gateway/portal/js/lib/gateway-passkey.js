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

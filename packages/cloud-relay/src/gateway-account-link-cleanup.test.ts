// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import * as filesystem from "node:fs/promises";
import * as core from "@omnesis/core";
import { afterEach, expect, test, vi } from "vitest";
import { GatewayAccountLink } from "./gateway-account-link.js";
import * as credentials from "./google-credentials.js";
import * as gatewayKeys from "./gateway-key-client.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { markedFileError } from "../test/private-operation-fixture.js";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import { gatewayPasskeyChallenge } from "./device-enrollment.js";

// The real browser client reaches its private registration seam; no filesystem,
// native worker or transport is started by the injected operation receipts.
afterEach(() => vi.restoreAllMocks());

async function fixture(failure: Error, confirmed?: ReturnType<typeof passkeyAuthenticator>) {
  const key = generateKeyPairSync("ed25519").privateKey;
  const gatewayId = "33333333-3333-4333-8333-333333333333";
  const relayOrigin = "https://relay.example.test";
  const origin = `https://${hostedGatewayHostname(gatewayId, "relay.example.test")}`;
  const ownerPublicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  const accountId = "a".repeat(64);
  vi.spyOn(credentials, "readPrivateJson").mockResolvedValue({
    version: 1,
    linked: true,
    accountId,
    binding: {
      relayOrigin,
      gatewayId,
      ownerAccountId: gatewayKeyAccount({ gatewayId, ownerPublicKey }),
    },
    trustedSignIns: [],
    confirmedSignIns: confirmed
      ? [
          {
            type: "passkey",
            id: confirmed.id,
            publicKey: confirmed.publicKey,
            counter: 0,
            at: Math.floor(Date.now() / 1000),
            via: "gateway-origin",
          },
        ]
      : [],
  });
  const readOwner = vi.spyOn(gatewayKeys, "readOrCreateGatewayOwnerKey").mockResolvedValue(key);
  const register = vi.fn<typeof gatewayKeys.registerGatewayKey>().mockRejectedValue(failure);
  const transport = vi.fn<typeof fetch>(() =>
    Promise.reject(new Error("No fixture transport is expected")),
  );
  const env = {
    OMNESIS_CLOUD_RELAY_ENABLED: "1",
    OMNESIS_CLOUD_RELAY_URL: relayOrigin,
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
    OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: origin,
    OMNESIS_CLOUD_RELAY_SESSION_FILE: "fictional-session.json",
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: "fictional-owner.key",
    OMNESIS_TLS_CERT: "fictional-public.pem",
    OMNESIS_TLS_KEY: "fictional-private.key",
  };
  const link = new GatewayAccountLink({
    env: () => env,
    metadataFile: "fictional-account-link.json",
    register,
    fetch: transport,
  });
  await link.initialize();
  expect(link.verifiedAccountId()).toBe(accountId);
  expect(readOwner).toHaveBeenCalledOnce();
  return { link, register, transport, origin };
}

test.each(["own", "cause"] as const)(
  "passkey options preserve explicit private-session uncertainty instead of returning a fallback ceremony (%s)",
  async (placement) => {
    const failure = markedFileError("ENOENT", placement);
    const { link, register, transport } = await fixture(failure);
    try {
      await expect(link.passkeyConfirmationOptions()).rejects.toBe(failure);
      expect(register).toHaveBeenCalledOnce();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      link.cancel();
    }
  },
);

test("ordinary joined listing unavailability retains the existing unfiltered passkey ceremony", async () => {
  const { link, register, transport, origin } = await fixture(
    new Error("Invented joined relay unavailability"),
  );
  try {
    const ceremony = await link.passkeyConfirmationOptions();
    expect(ceremony).toMatchObject({ purpose: "pin-passkey", rpId: "relay.example.test", origin });
    expect(ceremony).not.toHaveProperty("allowCredentials");
    expect(ceremony.challenge).not.toBe("");
    expect(register).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  } finally {
    link.cancel();
  }
});

function confirmation(link: GatewayAccountLink) {
  const ceremony = link.passkeyConfirmation();
  const authenticator = passkeyAuthenticator(ceremony.rpId);
  return {
    type: "gateway-passkey" as const,
    challenge: ceremony.challenge,
    credential: authenticator.authentication(
      ceremony.webauthnChallenge,
      "a".repeat(64),
      0,
      ceremony.origin,
    ),
  };
}

test.each(["own", "cause"] as const)(
  "valid passkey confirmation preserves private-session uncertainty before account-unavailable fallback (%s)",
  async (placement) => {
    const failure = markedFileError("ENOENT", placement);
    const { link, register, transport } = await fixture(failure);
    try {
      await expect(link.confirmPasskey(confirmation(link))).rejects.toBe(failure);
      expect(register).toHaveBeenCalledOnce();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      link.cancel();
    }
  },
);

test("ordinary joined confirmation-listing unavailability retains its public account-unavailable refusal", async () => {
  const { link, register, transport } = await fixture(
    new Error("Invented joined relay unavailability"),
  );
  try {
    await expect(link.confirmPasskey(confirmation(link))).rejects.toMatchObject({
      status: 503,
      code: "account-unavailable",
    });
    expect(register).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  } finally {
    link.cancel();
  }
});

function enrollmentProof(
  origin: string,
  authenticator = passkeyAuthenticator("relay.example.test"),
) {
  const challenge = "c".repeat(43),
    nonce = "d".repeat(43);
  return {
    authenticator,
    challenge,
    nonce,
    proof: {
      type: "gateway-passkey" as const,
      challenge,
      credential: authenticator.authentication(
        gatewayPasskeyChallenge("device-enrollment", origin, challenge, nonce),
        "a".repeat(64),
        1,
        origin,
      ),
    },
  };
}

test.each(["own", "cause"] as const)(
  "gateway enrollment preserves private-session uncertainty before projecting an unverified sign-in (%s)",
  async (placement) => {
    const failure = markedFileError("ENOENT", placement);
    const { link, register, transport, origin } = await fixture(failure);
    try {
      const input = enrollmentProof(origin);
      const enrollment = link.pairingIdentity()!.enrollment;
      await expect(
        enrollment.verifyGatewayPasskey!(input.proof, input.challenge, input.nonce),
      ).rejects.toBe(failure);
      expect(register).toHaveBeenCalledOnce();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      link.cancel();
    }
  },
);

test("ordinary joined enrollment-listing unavailability still leaves a sign-in unverified", async () => {
  const { link, register, transport, origin } = await fixture(
    new Error("Invented joined listing unavailability"),
  );
  try {
    const input = enrollmentProof(origin);
    await expect(
      link.pairingIdentity()!.enrollment.verifyGatewayPasskey!(
        input.proof,
        input.challenge,
        input.nonce,
      ),
    ).resolves.toBeUndefined();
    expect(register).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  } finally {
    link.cancel();
  }
});

async function verifiedUntrusted(failure: Error) {
  const f = await fixture(failure);
  const input = enrollmentProof(f.origin);
  f.register.mockResolvedValueOnce({
    token: "invented-session",
    accountId: "a".repeat(64),
    expiresAt: 4_000_000_000,
  });
  f.transport.mockResolvedValueOnce(
    Response.json({
      accountId: "a".repeat(64),
      google: [],
      passkeys: [{ id: input.authenticator.id, publicKey: input.authenticator.publicKey }],
    }),
  );
  try {
    const signIn = await f.link.pairingIdentity()!.enrollment.verifyGatewayPasskey!(
      input.proof,
      input.challenge,
      input.nonce,
    );
    expect(signIn).toMatchObject({
      trusted: false,
      type: "passkey",
      channel: "gateway-origin",
      id: input.authenticator.id,
    });
    if (!signIn) throw new Error("Synthetic gateway assertion must verify before its trust check");
    return { ...f, signIn };
  } catch (error) {
    f.link.cancel();
    throw error;
  }
}

test.each(["own", "cause"] as const)(
  "trust eligibility preserves private-session uncertainty instead of reporting false (%s)",
  async (placement) => {
    const failure = markedFileError("ENOENT", placement);
    const { link, register, transport, signIn } = await verifiedUntrusted(failure);
    try {
      await expect(link.canTrust(signIn)).rejects.toBe(failure);
      expect(register).toHaveBeenCalledTimes(2);
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      link.cancel();
    }
  },
);

test("ordinary joined trust-listing unavailability keeps the sign-in ineligible", async () => {
  const { link, register, transport, signIn } = await verifiedUntrusted(
    new Error("Invented joined listing unavailability"),
  );
  try {
    await expect(link.canTrust(signIn)).resolves.toBe(false);
    expect(register).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    link.cancel();
  }
});

async function counterPublication(failure: Error) {
  const authenticator = passkeyAuthenticator("relay.example.test");
  const f = await fixture(failure, authenticator);
  vi.spyOn(filesystem, "mkdir").mockResolvedValue(undefined);
  const write = vi.spyOn(core, "atomicWriteFileSync").mockImplementation(() => {
    throw failure;
  });
  return { ...f, input: enrollmentProof(f.origin, authenticator), write };
}

test.each(["own", "cause"] as const)(
  "a verified confirmed passkey cannot hide an unjoined counter publication (%s)",
  async (placement) => {
    const failure = markedFileError("ENOENT", placement);
    const { link, register, transport, input, write } = await counterPublication(failure);
    try {
      await expect(
        link.pairingIdentity()!.enrollment.verifyGatewayPasskey!(
          input.proof,
          input.challenge,
          input.nonce,
        ),
      ).rejects.toBe(failure);
      expect(write).toHaveBeenCalledOnce();
      expect(register).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      link.cancel();
    }
  },
);

test("ordinary joined counter publication failure retains existing best-effort verification", async () => {
  const { link, register, transport, input, write } = await counterPublication(
    new Error("Invented joined counter write refusal"),
  );
  try {
    await expect(
      link.pairingIdentity()!.enrollment.verifyGatewayPasskey!(
        input.proof,
        input.challenge,
        input.nonce,
      ),
    ).resolves.toMatchObject({ trusted: true, id: input.authenticator.id });
    expect(link.confirmedSignIns()).toContainEqual(
      expect.objectContaining({ id: input.authenticator.id, counter: 0 }),
    );
    expect(write).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  } finally {
    link.cancel();
  }
});

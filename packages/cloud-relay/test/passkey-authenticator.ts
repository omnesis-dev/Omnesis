// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";

/** Synthetic FIDO authenticator signs actual WebAuthn messages; the production verifier is never mocked. */
export function passkeyAuthenticator(rpID = "relay.example.test") {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = key.publicKey.export({ format: "jwk" });
  const credential = randomBytes(32);
  const id = credential.toString("base64url");
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  const authData = (flags: number, counter: number) => {
    const suffix = Buffer.alloc(5);
    suffix[0] = flags;
    suffix.writeUInt32BE(counter, 1);
    return Buffer.concat([createHash("sha256").update(rpID).digest(), suffix]);
  };
  const clientData = (
    type: string,
    challenge: string,
    origin: string,
    extra: Record<string, unknown> = {},
  ) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));
  return {
    id,
    /** The COSE public key, base64url, as a relay registers it and a gateway pins it. */
    publicKey: Buffer.from(cose).toString("base64url"),
    registration(
      challenge: string,
      origin = `https://${rpID}`,
      flags = 0x5d,
      attestationFormat: "none" | "invalid-self" = "none",
    ): RegistrationResponseJSON {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credential.length);
      const authenticator = Buffer.concat([
        authData(flags, 0),
        Buffer.alloc(16),
        length,
        credential,
        cose,
      ]);
      const statement = new Map<string, number | Uint8Array>();
      if (attestationFormat === "invalid-self") {
        statement.set("alg", -7);
        statement.set(
          "sig",
          sign("sha256", Buffer.from("fictional-invalid-attestation"), key.privateKey),
        );
      }
      const attestation = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, number | Uint8Array>>([
          ["fmt", attestationFormat === "none" ? "none" : "packed"],
          ["authData", authenticator],
          ["attStmt", statement],
        ]),
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: { credProps: { rk: true } },
        response: {
          clientDataJSON: clientData("webauthn.create", challenge, origin).toString("base64url"),
          attestationObject: Buffer.from(attestation).toString("base64url"),
          transports: ["internal", "hybrid"],
        },
      };
    },
    authentication(
      challenge: string,
      userHandle: string,
      counter = 0,
      origin = `https://${rpID}`,
      flags = 0x1d,
      /** Fields a browser adds to the client data, e.g. inside a cross-site frame. */
      extraClientData: Record<string, unknown> = {},
    ): AuthenticationResponseJSON {
      const client = clientData("webauthn.get", challenge, origin, extraClientData);
      const authenticator = authData(flags, counter);
      const signature = sign(
        "sha256",
        Buffer.concat([authenticator, createHash("sha256").update(client).digest()]),
        key.privateKey,
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString("base64url"),
          authenticatorData: authenticator.toString("base64url"),
          signature: signature.toString("base64url"),
          userHandle,
        },
      };
    },
  };
}

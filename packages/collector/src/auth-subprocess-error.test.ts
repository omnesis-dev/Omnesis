// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One classification for both entry points.
 *
 * The defect these guard against is asymmetry: the older `authFlow` path had a
 * hand-written catch that recognised a missing application credential and told
 * the client which wizard to open, and the typed `authenticate` path had a
 * shorter one that did not. A provider was therefore punished for adopting the
 * new contract — its operator got a sentence instead of the form that fixes
 * the problem.
 */

import { CredentialPersistError, MissingCredentialsError } from "@omnesis/core";
import { AuthFailure } from "@omnesis/source-sdk";
import { describe, expect, it } from "vitest";

import { authErrorPayload } from "./auth-subprocess-error.js";

const routing = { fileKey: "example-cloud", providerName: "example-cloud provider" };
const noSecrets = { secretValues: [] as string[] };

describe("a flow that ended badly", () => {
  it("routes a typed missing-credentials to the wizard, from what the descriptor declares", () => {
    const payload = authErrorPayload(
      new AuthFailure("missing-credentials", "No application credential is configured"),
      { ...noSecrets, routing },
    );
    expect(payload.code).toBe("missing-credentials");
    expect(payload.fileKey).toBe("example-cloud");
    expect(payload.providerName).toBe("example-cloud provider");
  });

  it("routes the shared helper's error the same way, on either entry point", () => {
    const payload = authErrorPayload(
      new MissingCredentialsError("example-cloud", "example-cloud provider"),
      {
        ...noSecrets,
        routing,
      },
    );
    expect(payload.code).toBe("missing-credentials");
    expect(payload.fileKey).toBe("example-cloud");
    expect(payload.providerName).toBe("example-cloud provider");
  });

  it("leaves the routing out for a provider that declares no credential of its own", () => {
    const payload = authErrorPayload(
      new AuthFailure("missing-credentials", "No application credential is configured"),
      noSecrets,
    );
    expect(payload.code).toBe("missing-credentials");
    expect(payload.fileKey).toBeUndefined();
  });

  it("keeps a credential that could not be stored distinct from one that was never there", () => {
    const payload = authErrorPayload(
      new CredentialPersistError("example-cloud", "maya@example.org", "keyring is locked"),
      noSecrets,
    );
    expect(payload.code).toBe("credential-persist-failed");
    // Not routable: the wizard would ask for an application credential that is
    // already configured. What the client does here is offer the retry.
    expect(payload.fileKey).toBeUndefined();
  });

  it("carries the sentence the source wrote about what to do next", () => {
    // A code says which class of thing went wrong; for a platform with no
    // account chooser, "sign out in your browser first" is the entire
    // recovery, and no code can carry it.
    const payload = authErrorPayload(
      new AuthFailure("identity-mismatch", "Signed in as someone else", {
        remedy: "Sign out in your browser, then try again.",
      }),
      noSecrets,
    );
    expect(payload.remedy).toBe("Sign out in your browser, then try again.");
  });

  it("redacts the remedy too — it is a sentence a provider composed", () => {
    const secret = "tok_9f3a2b7c";
    const payload = authErrorPayload(
      new AuthFailure("unknown", "rejected", { remedy: `Revoke ${secret} and paste a new one.` }),
      { secretValues: [secret] },
    );
    expect(payload.remedy).not.toContain(secret);
  });

  it("carries how long the platform said to wait", () => {
    const payload = authErrorPayload(
      new AuthFailure("unavailable", "refusing further requests", { retryAfterMs: 21_600_000 }),
      noSecrets,
    );
    expect(payload.retryAfterMs).toBe(21_600_000);
  });

  it("says nothing about waiting when the platform did not", () => {
    expect(
      authErrorPayload(new AuthFailure("unavailable", "unreachable"), noSecrets).retryAfterMs,
    ).toBeUndefined();
  });

  it("spells cancellation the way the wire has always spelled it", () => {
    expect(authErrorPayload(new AuthFailure("cancelled", "stopped"), noSecrets).code).toBe(
      "user-cancelled",
    );
  });

  it("carries every other typed code through unchanged", () => {
    for (const code of ["denied", "unavailable", "unsupported", "challenge-expired"] as const) {
      expect(authErrorPayload(new AuthFailure(code, "x"), noSecrets).code).toBe(code);
    }
  });

  it("gives an untyped throw no code at all, rather than guessing one", () => {
    const payload = authErrorPayload(new Error("socket hang up"), noSecrets);
    expect(payload.code).toBeUndefined();
    expect(payload.error).toBe("socket hang up");
  });

  it("redacts on every arm, because the message reaches an admin listing", () => {
    const secret = "tok_9f3a2b7c";
    const opts = { secretValues: [secret], routing };
    for (const err of [
      new AuthFailure("unknown", `rejected ${secret}`),
      new MissingCredentialsError("example-cloud", `example-cloud provider ${secret}`),
      new CredentialPersistError("example-cloud", "maya@example.org", secret),
      new Error(`upstream said ${secret}`),
    ]) {
      expect(authErrorPayload(err, opts).error).not.toContain(secret);
    }
  });
});

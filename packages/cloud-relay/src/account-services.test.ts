// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { AccountServices } from "./account-services.js";
import { RelayAccounts } from "./accounts.js";
import { accountId, RelaySessions } from "./identity.js";
import { LoginAdmission } from "./admission.js";
import { RelayError } from "./tunnels.js";
import type { IncomingMessage } from "node:http";

const request = { headers: {} } as IncomingMessage;

test("fresh provider login migrates only independently available gateway associations without moving another account's gateway", async () => {
  const origin = "https://relay.example.test",
    owner = "b".repeat(64);
  for (const mode of [
    "missing",
    "revoked",
    "failure",
    "existing-other",
    "existing-same",
  ] as const) {
    const accounts = new RelayAccounts(":memory:"),
      sessions = new RelaySessions(randomBytes(32));
    let owners: string[] = [];
    const service = new AccountServices({
      origin,
      accounts,
      sessions,
      configuration: {},
      admission: new LoginAdmission(),
      google: {
        verify: async () => ({
          issuer: "https://accounts.google.com",
          subject: "fictional-account-service",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      },
      gatewayAccounts: () => owners,
      gatewayBinding: () => {
        if (mode === "missing") return undefined;
        if (mode === "revoked") throw new RelayError(403, "Synthetic revoked registration");
        if (mode === "failure") throw new Error("Synthetic registry failure");
        return {
          gatewayId: randomUUID(),
          publicOrigin: "https://gateway.example.test",
          certificate: "synthetic-binding-metadata",
          identityToken: "synthetic-owner-metadata",
        };
      },
      currentOwner: () => undefined,
      deleteAccount: () => {},
      deleteGateway: () => {},
      authenticateOwner: async () => {
        throw new RelayError(401, "Synthetic unauthorized owner");
      },
      assertCurrent() {},
    });
    try {
      // This test exercises migration of an existing account, not new-account admission.
      accounts.identities.signInFederated(
        "google",
        accountId({
          issuer: "https://accounts.google.com",
          subject: "fictional-account-service",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      );
      const initial = await service.completeGoogle(
        "synthetic-proof",
        "synthetic-nonce",
        undefined,
        request,
      );
      const token = initial.cookie!.split(";")[0]!.split("=")[1]!;
      const account = await sessions.verifyAccountSession(token, origin);
      owners = [owner];
      if (mode === "existing-other") {
        const other = accounts.identities.signInFederated("google", "a".repeat(64));
        accounts.identities.linkGateway(
          other,
          owner,
          sessions.sealAccountGatewayLink(origin, other, owner),
        );
      }
      if (mode === "existing-same")
        accounts.identities.linkGateway(
          account.accountId,
          owner,
          sessions.sealAccountGatewayLink(origin, account.accountId, owner),
        );
      if (mode === "failure")
        await expect(
          service.completeGoogle("synthetic-proof", "synthetic-nonce", undefined, request),
        ).rejects.toThrow("registry failure");
      else {
        await service.completeGoogle("synthetic-proof", "synthetic-nonce", undefined, request);
        if (mode === "existing-same")
          expect(accounts.identities.gatewayAccount(owner)?.accountId).toBe(account.accountId);
        else
          expect(accounts.identities.gatewayAccount(owner)?.accountId).not.toBe(account.accountId);
      }
    } finally {
      service.close();
      accounts.close();
    }
  }
});

test("legacy account admission skips revoked, spent and untrusted registrations and rechecks ownership at commit", async () => {
  const origin = "https://relay.example.test";
  for (const mode of [
    "revoked",
    "failure",
    "missing",
    "spent",
    "bad-seal",
    "linked",
    "late-key",
    "late-link",
    "late-seal",
    "no-valid",
  ] as const) {
    const accounts = new RelayAccounts(":memory:"),
      sessions = new RelaySessions(randomBytes(32));
    const identity = {
      issuer: "https://accounts.google.com",
      subject: "legacy-admission-fixture",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const digest = accountId(identity);
    const makeOwner = (account: string) => ({
      ownerAccountId: account,
      gatewayId: randomUUID(),
      ownerPublicKey: "synthetic-public-key",
      publicOrigin: "https://gateway.example.test",
      tlsSpkiFingerprint: "a".repeat(64),
    });
    const first = makeOwner("a".repeat(64)),
      healthy = makeOwner("b".repeat(64));
    if (mode === "spent") {
      // An allocation stays spent while its gateway is linked to the account it created.
      const spender = accounts.identities.signInFederated("fixture", "c".repeat(64), {
        gatewayId: first.gatewayId,
        ownerAccountId: first.ownerAccountId,
        assertCurrent() {},
      });
      accounts.identities.linkGateway(
        spender,
        first.ownerAccountId,
        sessions.sealAccountGatewayLink(origin, spender, first.ownerAccountId),
      );
    }
    if (mode === "linked") {
      const existing = accounts.identities.signInFederated("fixture", "d".repeat(64));
      accounts.identities.linkGateway(
        existing,
        first.ownerAccountId,
        sessions.sealAccountGatewayLink(origin, existing, first.ownerAccountId),
      );
    }
    let reads = 0;
    const rows = [first, healthy].map((owner) => ({
      ownerAccount: owner.ownerAccountId,
      seal: sessions.sealGoogleLink(origin, digest, owner.ownerAccountId),
    }));
    if (mode === "bad-seal") rows[0]!.seal = "untrusted";
    vi.spyOn(accounts, "googleGatewayLinks").mockImplementation(() => {
      reads++;
      if (mode === "no-valid") return [];
      if (mode === "late-seal" && reads > 1) return [];
      return rows;
    });
    const service = new AccountServices({
      origin,
      accounts,
      sessions,
      configuration: {},
      admission: new LoginAdmission(),
      google: { verify: async () => identity },
      gatewayAccounts: () => [],
      gatewayBinding: () => undefined,
      deleteAccount: () => {},
      deleteGateway: () => {},
      currentOwner: (id) => {
        if (id === first.ownerAccountId) {
          if (mode === "revoked") throw new RelayError(403, "Revoked registration");
          if (mode === "failure") throw new Error("Registry unavailable");
          if (mode === "missing") return undefined;
          if (reads > 1 && mode === "late-key")
            return { ...first, ownerPublicKey: "changed-public-key" };
          if (reads > 1 && mode === "late-link") {
            const other = accounts.identities.signInFederated("fixture", "e".repeat(64));
            accounts.identities.linkGateway(
              other,
              id,
              sessions.sealAccountGatewayLink(origin, other, id),
            );
          }
          return first;
        }
        return healthy;
      },
      authenticateOwner: async () => {
        throw new RelayError(401, "Owner proof required");
      },
      assertCurrent() {},
    });
    try {
      if (mode === "no-valid") {
        // No registration can admit it, so the sign-in has no account and creates none.
        await expect(service.completeGoogle("proof", "nonce", undefined, request)).resolves.toEqual(
          { location: "/_relay/account?failed=no-account" },
        );
        expect(accounts.identities.snapshot().identityAccounts).toBe(0);
      } else if (mode === "failure")
        await expect(service.completeGoogle("proof", "nonce", undefined, request)).rejects.toThrow(
          "Registry unavailable",
        );
      else if (mode.startsWith("late-"))
        await expect(service.completeGoogle("proof", "nonce", undefined, request)).rejects.toThrow(
          "admission changed",
        );
      else {
        await service.completeGoogle("proof", "nonce", undefined, request);
        // The healthy registration's allocation is spent for as long as it is linked to its account.
        const created = accounts.identities.federatedAccount("google", digest)!;
        expect(accounts.identities.canAdmitGateway(healthy.gatewayId)).toBe(true);
        accounts.identities.linkGateway(
          created,
          healthy.ownerAccountId,
          sessions.sealAccountGatewayLink(origin, created, healthy.ownerAccountId),
        );
        expect(accounts.identities.canAdmitGateway(healthy.gatewayId)).toBe(false);
        if (mode === "spent")
          expect(accounts.identities.federatedAccount("fixture", "c".repeat(64))).toBeDefined();
      }
    } finally {
      service.close();
      accounts.close();
    }
  }
});

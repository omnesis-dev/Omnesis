// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test/recovery-fixture.js";
import {
  loadRelayRecoveryPolicy,
  rotateRelaySessionKey,
  runRelayRecoveryCommand,
} from "./relay-recovery-runtime.js";
import { RelaySessions } from "./identity.js";
import { recoveryPolicyDigest } from "./recovery-contract.js";
import { runRelayCommand } from "./runtime.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-recovery-tools-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

test("offline commands provision an independent authority and a pinned policy without network access", async () => {
  const network = vi.fn(() => {
    throw new Error("Offline operation must not connect");
  });
  vi.stubGlobal("fetch", network);
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const f = await recoveryFixture(directory);
  const privateFile = join(directory, "offline", "authority.key"),
    publicFile = join(directory, "offline", "authority.pub");
  const inputFile = join(directory, "input.json"),
    signedFile = join(directory, "signed.json");
  const operator = {
    OMNESIS_CLOUD_RELAY_RECOVERY_AUTHORITY_KEY_FILE: privateFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_PUBLIC_KEY_FILE: publicFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_INPUT_FILE: inputFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE: signedFile,
  };
  expect(await runRelayRecoveryCommand("unrecognized", {})).toBe(false);
  expect(output).not.toHaveBeenCalled();
  expect(await runRelayRecoveryCommand("recovery-create-authority", operator)).toBe(true);
  const signingKey = await readFile(privateFile, "utf8");
  expect((await stat(privateFile)).mode & 0o777).toBe(0o600);
  await writeFile(inputFile, JSON.stringify(f.receipt().payload));
  await runRelayRecoveryCommand("recovery-sign-receipt", operator);
  expect(JSON.parse(await readFile(signedFile, "utf8")).payload.gatewayId).toBe(
    f.registration.gatewayId,
  );
  const { version, keyId, relayOrigin, relayDomain, issuedAt, expiresAt } = f.receipt().payload;
  await writeFile(
    inputFile,
    JSON.stringify({
      version,
      keyId,
      relayOrigin,
      relayDomain,
      issuedAt,
      expiresAt,
      protocol: "omnesis-relay-recovery-policy",
      epoch: 4,
      minimumReceiptEpoch: 2,
      minimumReceiptVersion: 1,
      revokedGatewayIds: [],
      revokedOwnerSpkiFingerprints: [],
    }),
  );
  await runRelayRecoveryCommand("recovery-sign-policy", operator);
  const digest = recoveryPolicyDigest(JSON.parse(await readFile(signedFile, "utf8")));
  const trust = {
    OMNESIS_CLOUD_RELAY_RECOVERY_PUBLIC_KEY_FILE: publicFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_FILE: signedFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_SHA256: digest,
    OMNESIS_CLOUD_RELAY_RECOVERY_MIN_POLICY_EPOCH: "4",
    OMNESIS_CLOUD_RELAY_RECOVERY_KEY_ID: keyId,
    OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: relayOrigin,
    OMNESIS_CLOUD_RELAY_DOMAIN: relayDomain,
  };
  expect(await loadRelayRecoveryPolicy(trust)).toEqual({ epoch: 4, expiresAt });
  await runRelayCommand("recovery-policy-digest", {
    OMNESIS_CLOUD_RELAY_RECOVERY_INPUT_FILE: signedFile,
  });
  expect(output).toHaveBeenLastCalledWith(JSON.stringify({ policySha256: digest }) + "\n");
  expect(output.mock.calls.flat().join("")).not.toContain(signingKey);
  expect(network).not.toHaveBeenCalled();
  await expect(
    loadRelayRecoveryPolicy({
      ...trust,
      OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_SHA256: "0".repeat(64),
    }),
  ).rejects.toThrow("anchor");
});

test("partial recovery trust and relay installation of the offline signing key are refused", async () => {
  expect(await loadRelayRecoveryPolicy({})).toBeUndefined();
  await expect(
    loadRelayRecoveryPolicy({
      OMNESIS_CLOUD_RELAY_RECOVERY_AUTHORITY_KEY_FILE: "unread-offline.key",
    }),
  ).rejects.toThrow("offline");
  await expect(
    loadRelayRecoveryPolicy({ OMNESIS_CLOUD_RELAY_RECOVERY_KEY_ID: "operator" }),
  ).rejects.toThrow();
  await expect(runRelayRecoveryCommand("recovery-create-authority", {})).rejects.toThrow();
});

test("public recovery requests retain owner identity without TLS files or exported private material", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const f = await recoveryFixture(directory);
  const ownerFile = join(directory, "gateway-owner.key"),
    resultFile = join(directory, "request.json");
  await writeFile(ownerFile, f.owner.privateKey);
  await runRelayRecoveryCommand("recovery-request", {
    OMNESIS_CLOUD_RELAY_URL: "https://control.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session.json"),
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: f.registration.gatewayId,
    OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: f.registration.publicOrigin,
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: ownerFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE: resultFile,
  });
  const request = await readFile(resultFile, "utf8");
  expect(JSON.parse(request)).toMatchObject({
    gatewayId: f.registration.gatewayId,
    accountId: f.account,
    ownerPublicKey: f.owner.publicKey,
  });
  expect(request).not.toContain("PRIVATE KEY");
  expect(await readFile(ownerFile, "utf8")).toBe(f.owner.privateKey);
});

test("relay-only credential rotation invalidates old sessions and invitations while preserving protected identity files", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const keyFile = join(directory, "routing", "session.key");
  const oldSecret = randomBytes(32),
    old = new RelaySessions(oldSecret);
  const identity = {
    issuer: "synthetic-rotation",
    subject: "fixture-owner",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const prior = await old.issue(identity);
  const gatewayId = "00000000-0000-4000-8000-000000000001",
    origin = "https://control.example.test";
  const invitation = await old.issueEnrollmentInvitation(gatewayId, origin);
  await runRelayRecoveryCommand("recovery-rotate-session-key", {
    OMNESIS_CLOUD_RELAY_KEY_FILE: keyFile,
  });
  const secret = await readFile(keyFile),
    fresh = new RelaySessions(secret);
  expect(secret).toHaveLength(32);
  expect(secret.equals(oldSecret)).toBe(false);
  expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
  await expect(fresh.verify(prior.token)).rejects.toThrow();
  await expect(fresh.verifyEnrollmentInvitation(invitation, gatewayId, origin)).rejects.toThrow();
  expect(output.mock.calls.flat().join("")).not.toContain(secret.toString("hex"));
  expect(output).toHaveBeenLastCalledWith('{"restartRequired":true}\n');
  for (const field of [
    "OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_RECOVERY_AUTHORITY_KEY_FILE",
  ]) {
    await expect(
      rotateRelaySessionKey({ OMNESIS_CLOUD_RELAY_KEY_FILE: keyFile, [field]: keyFile }),
    ).rejects.toThrow("cannot replace");
    expect(await readFile(keyFile)).toEqual(secret);
  }
});

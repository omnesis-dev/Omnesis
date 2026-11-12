// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { prepareGatewayOwner, prepareGatewayRecoveryRequest } from "./gateway-key-client.js";
import { createRecoveryAuthority, signRecoveryReceipt } from "./recovery-authority.js";
import { gatewayRecoveryReceiptStatus } from "./gateway-recovery-status.js";
import * as credentials from "./google-credentials.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-recovery-status-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const options = {
    relayUrl: "https://relay.example.test",
    gatewayId: "b714074e-2354-49a9-b6ae-0eccfb7c2f01",
    publicOrigin: "https://gateway.example.test",
    sessionFile: join(directory, "session.json"),
  };
  await prepareGatewayOwner(options);
  const draft = await prepareGatewayRecoveryRequest(options),
    authority = createRecoveryAuthority();
  const issuedAt = Math.floor(Date.now() / 1000) - 1,
    expiresAt = issuedAt + 3600;
  const receipt = signRecoveryReceipt(
    {
      ...draft,
      keyId: "independent",
      relayDomain: "relay.example.test",
      recoveryEpoch: 1,
      issuedAt,
      expiresAt,
    },
    authority.privateKey,
  );
  return {
    options,
    receipt,
    path: `${options.sessionFile}.recovery.json`,
    now: issuedAt + 1,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}
test("optional receipt status reports local artifact health and expiry without pretending to verify independent authority", async () => {
  const f = await fixture();
  expect(await gatewayRecoveryReceiptStatus(f.options)).toEqual({ receipt: "missing" });
  await writeFile(f.path, JSON.stringify(f.receipt));
  const present = { receipt: "present", expiresAt: f.expiresAt };
  expect(await gatewayRecoveryReceiptStatus(f.options)).toEqual(present);
  expect(
    await gatewayRecoveryReceiptStatus({ ...f.options, recoveryReceiptFile: f.path }, f.now),
  ).toEqual(present);
  expect(await gatewayRecoveryReceiptStatus(f.options, f.receipt.payload.expiresAt)).toEqual({
    receipt: "expired",
    expiresAt: f.expiresAt,
  });
  expect(await gatewayRecoveryReceiptStatus(f.options, f.receipt.payload.issuedAt - 1)).toEqual({
    receipt: "invalid",
  });
  expect(await gatewayRecoveryReceiptStatus(f.options, NaN)).toEqual({ receipt: "invalid" });
  // A syntactically valid unverified signature is never labelled verified/protected.
  await writeFile(
    f.path,
    JSON.stringify({ ...f.receipt, signature: Buffer.alloc(64).toString("base64url") }),
  );
  expect(await gatewayRecoveryReceiptStatus(f.options, f.now)).toEqual(present);
  expect(JSON.stringify(present)).not.toMatch(
    /verified|protected|signature|account|key|path|token/,
  );
});
test("identity mismatches, lost owner keys and malformed private artifacts produce fixed sanitized status", async () => {
  const f = await fixture();
  await writeFile(f.path, JSON.stringify(f.receipt));
  for (const change of [
    { gatewayId: "c714074e-2354-49a9-b6ae-0eccfb7c2f01" },
    { publicOrigin: "https://other.example.test" },
    { relayUrl: "https://other.example.test" },
  ])
    expect(await gatewayRecoveryReceiptStatus({ ...f.options, ...change }, f.now)).toEqual({
      receipt: "invalid",
    });
  const otherOwner = join(directory, "other-owner.key");
  await writeFile(otherOwner, createRecoveryAuthority().privateKey);
  expect(
    await gatewayRecoveryReceiptStatus({ ...f.options, ownerKeyFile: otherOwner }, f.now),
  ).toEqual({ receipt: "invalid" });
  await rm(`${f.options.sessionFile}.owner-key`);
  expect(await gatewayRecoveryReceiptStatus(f.options, f.now)).toEqual({ receipt: "invalid" });
  await expect(readFile(`${f.options.sessionFile}.owner-key`)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await writeFile(f.path, "private-invalid-fixture");
  expect(await gatewayRecoveryReceiptStatus(f.options)).toEqual({ receipt: "invalid" });
  const read = vi.spyOn(credentials, "readPrivateJson");
  for (const failure of [
    "unreadable-private-path",
    null,
    new Error("private-key-fixture"),
    Object.assign(new Error("denied"), { code: "EACCES" }),
  ]) {
    read.mockRejectedValueOnce(failure);
    expect(await gatewayRecoveryReceiptStatus(f.options)).toEqual({ receipt: "invalid" });
  }
});

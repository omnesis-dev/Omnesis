// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test/recovery-fixture.js";
import { assertRecoveryArtifactDestination } from "./recovery-artifact-paths.js";
import { runRelayRecoveryCommand, rotateRelaySessionKey } from "./relay-recovery-runtime.js";
import { runRecoveryAuthorityTool } from "./recovery-tool.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-recovery-paths-"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

test("export and rotation preserve configured credentials and implicit gateway identity artifacts byte for byte", async () => {
  const f = await recoveryFixture(directory);
  const session = join(directory, "routing.json"),
    cert = join(directory, "public.pem");
  const fields = [
    "OMNESIS_CLOUD_RELAY_SESSION_FILE",
    "OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE",
    "OMNESIS_CLOUD_RELAY_DB",
    "OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE",
    "OMNESIS_CLOUD_RELAY_RECOVERY_AUTHORITY_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_RECOVERY_PUBLIC_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_FILE",
    "OMNESIS_CLOUD_RELAY_RECOVERY_INPUT_FILE",
    "OMNESIS_CLOUD_RELAY_TLS_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_TLS_CERT_FILE",
    "OMNESIS_TLS_KEY",
    "OMNESIS_TLS_CERT",
    "OMNESIS_ACME_CERT_FILE",
    "OMNESIS_ACME_KEY_FILE",
    "OMNESIS_ACME_ACCOUNT_KEY_FILE",
    "OMNESIS_ACME_DNS_TOKEN_FILE",
    "OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_CERT_FILE",
    "OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE",
    "OMNESIS_CLOUD_RELAY_ACME_JOURNAL",
    "OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE",
    "OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE",
    "OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE",
    "OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE",
    "OMNESIS_CLOUD_RELAY_CERTSPOTTER_API_KEY_FILE",
    "OMNESIS_CLOUD_RELAY_DEVICE_FILE",
    "OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE",
    "OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE",
    "OMNESIS_CLOUD_RELAY_ID_TOKEN_FILE",
    "OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE",
  ];
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    fields.map((field) => [field, join(directory, field)]),
  );
  Object.assign(env, {
    OMNESIS_CONFIG_DIR: join(directory, "gateway"),
    OMNESIS_CLOUD_RELAY_URL: "https://control.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: session,
    OMNESIS_ACME_CERT_FILE: cert,
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: f.registration.gatewayId,
    OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: f.registration.publicOrigin,
  });
  const targets = [
    ...fields.map((field) => env[field]!),
    join(dirname(env.OMNESIS_CLOUD_RELAY_DB!), "account-authority.pem"),
    `${session}.owner-key`,
    `${session}.recovery.json`,
    `${cert}.key`,
    `${cert}.acme-account`,
    `${cert}.acme-account.dns-journal`,
    `${env.OMNESIS_ACME_ACCOUNT_KEY_FILE}.dns-journal`,
    join(env.OMNESIS_CONFIG_DIR!, "tls/key.pem"),
    join(env.OMNESIS_CONFIG_DIR!, "tls/cert.pem"),
    join(env.OMNESIS_CONFIG_DIR!, "cloud-relay/certificate-incidents.json"),
  ];
  for (const path of targets) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      path === `${session}.owner-key` ? f.owner.privateKey : "retained private artifact\n",
    );
  }
  for (const target of targets) {
    const before = await readFile(target);
    await expect(
      runRelayRecoveryCommand("recovery-request", {
        ...env,
        OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE: target,
      }),
    ).rejects.toThrow("cannot replace");
    await expect(
      rotateRelaySessionKey({ ...env, OMNESIS_CLOUD_RELAY_KEY_FILE: target }),
    ).rejects.toThrow("cannot replace");
    expect(await readFile(target)).toEqual(before);
  }
  const routingKey = join(directory, "relay-hmac.key");
  await writeFile(routingKey, "existing routing key");
  await expect(
    runRelayRecoveryCommand("recovery-request", {
      ...env,
      OMNESIS_CLOUD_RELAY_KEY_FILE: routingKey,
      OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE: routingKey,
    }),
  ).rejects.toThrow("cannot replace");
  expect(await readFile(routingKey, "utf8")).toBe("existing routing key");
});

test("parent aliases and a configured owner leaf symlink cannot redirect exports or rotation onto the private key", async () => {
  const f = await recoveryFixture(directory);
  const real = join(directory, "real"),
    alias = join(directory, "alias");
  await mkdir(real);
  await symlink(real, alias, "dir");
  const actual = join(real, "owner.key"),
    ownerLink = join(directory, "owner-link");
  await writeFile(actual, f.owner.privateKey);
  await symlink(actual, ownerLink);
  const env = {
    OMNESIS_CLOUD_RELAY_URL: "https://control.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session.json"),
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: f.registration.gatewayId,
    OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: f.registration.publicOrigin,
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: ownerLink,
  };
  for (const output of [ownerLink, actual, join(alias, "owner.key")]) {
    await expect(
      runRelayRecoveryCommand("recovery-request", {
        ...env,
        OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE: output,
      }),
    ).rejects.toThrow("cannot replace");
    await expect(
      rotateRelaySessionKey({ ...env, OMNESIS_CLOUD_RELAY_KEY_FILE: output }),
    ).rejects.toThrow("cannot replace");
    expect(await readFile(actual, "utf8")).toBe(f.owner.privateKey);
    expect(await readFile(ownerLink, "utf8")).toBe(f.owner.privateKey);
  }
  const outputLeaf = join(directory, "public-export-link");
  await symlink(actual, outputLeaf);
  await runRelayRecoveryCommand("recovery-request", {
    ...env,
    OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE: outputLeaf,
  });
  expect(JSON.parse(await readFile(outputLeaf, "utf8")).ownerPublicKey).toBe(f.owner.publicKey);
  expect(await readFile(actual, "utf8")).toBe(f.owner.privateKey);
});

test("signing outputs preserve key/public/input files through aliases while deliberate receipt/policy publication remains possible", async () => {
  const f = await recoveryFixture(directory);
  const real = join(directory, "authority"),
    alias = join(directory, "authority-alias");
  await mkdir(real);
  await symlink(real, alias, "dir");
  const privateKeyFile = join(real, "private.key"),
    publicKeyFile = join(real, "public.key"),
    inputFile = join(real, "draft.json");
  await writeFile(privateKeyFile, f.authority.privateKey);
  await writeFile(publicKeyFile, f.authority.publicKey);
  await writeFile(inputFile, JSON.stringify(f.receipt().payload));
  for (const path of [privateKeyFile, publicKeyFile, inputFile]) {
    const before = await readFile(path);
    await expect(
      runRecoveryAuthorityTool("receipt", {
        privateKeyFile,
        publicKeyFile,
        inputFile,
        outputFile: join(alias, basename(path)),
      }),
    ).rejects.toThrow("cannot replace");
    expect(await readFile(path)).toEqual(before);
  }
  await expect(
    runRecoveryAuthorityTool("create", {
      privateKeyFile: join(real, "new.key"),
      publicKeyFile: join(alias, "new.key"),
    }),
  ).rejects.toThrow("cannot replace");
  await expect(readFile(join(real, "new.key"))).rejects.toMatchObject({ code: "ENOENT" });
  const receiptFile = join(real, "receipt.json"),
    policyFile = join(real, "policy.json");
  const env = {
    OMNESIS_CLOUD_RELAY_RECOVERY_AUTHORITY_KEY_FILE: privateKeyFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_PUBLIC_KEY_FILE: publicKeyFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_INPUT_FILE: inputFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE: receiptFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_FILE: policyFile,
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: join(real, "owner.key"),
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(real, "session.json"),
  };
  await writeFile(env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE, f.owner.privateKey);
  for (const target of [env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE, policyFile]) {
    await writeFile(target, target === policyFile ? "preserved policy" : f.owner.privateKey);
    const before = await readFile(target);
    await expect(
      runRelayRecoveryCommand("recovery-sign-receipt", {
        ...env,
        OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE: target,
      }),
    ).rejects.toThrow("cannot replace");
    expect(await readFile(target)).toEqual(before);
  }
  await writeFile(receiptFile, "previous receipt");
  await runRelayRecoveryCommand("recovery-sign-receipt", {
    ...env,
    OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE: receiptFile,
  });
  expect(JSON.parse(await readFile(receiptFile, "utf8")).payload.gatewayId).toBe(
    f.registration.gatewayId,
  );
  const now = Math.floor(Date.now() / 1000);
  await writeFile(
    inputFile,
    JSON.stringify({
      ...f.receipt().payload,
      protocol: "omnesis-relay-recovery-policy",
      gatewayId: undefined,
      publicOrigin: undefined,
      ownerPublicKey: undefined,
      ownerSpkiFingerprint: undefined,
      accountId: undefined,
      recoveryEpoch: undefined,
      epoch: 4,
      minimumReceiptEpoch: 2,
      minimumReceiptVersion: 1,
      revokedGatewayIds: [],
      revokedOwnerSpkiFingerprints: [],
      issuedAt: now - 1,
      expiresAt: now + 3600,
    }),
  );
  await runRelayRecoveryCommand("recovery-sign-policy", {
    ...env,
    OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE: policyFile,
  });
  expect(JSON.parse(await readFile(policyFile, "utf8")).payload.epoch).toBe(4);
  expect(await readFile(privateKeyFile, "utf8")).toBe(f.authority.privateKey);
});

test("canonical output paths support new directory trees and sanitize filesystem errors", async () => {
  const output = join(directory, "not-created", "nested", "request.json");
  expect(
    assertRecoveryArtifactDestination(output, [undefined, join(directory, "missing-key")]),
  ).toBe(join(fs.realpathSync(directory), "not-created", "nested", "request.json"));
  const notDirectory = join(directory, "a-file");
  await writeFile(notDirectory, "preserved");
  expect(() => assertRecoveryArtifactDestination(join(notDirectory, "nested", "out"), [])).toThrow(
    "cannot replace",
  );
  for (const error of [null, "private detail", {}, new Error("private detail")]) {
    const lookup = vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
      throw error;
    });
    try {
      expect(() => assertRecoveryArtifactDestination(output, [])).toThrow(
        "Recovery artifacts cannot replace protected identity files or signing keys",
      );
    } finally {
      lookup.mockReset();
      lookup.mockImplementation(
        (await vi.importActual<typeof import("node:fs")>("node:fs")).realpathSync,
      );
    }
  }
});

test("case aliases of existing protected entries are refused without folding distinct entries", async () => {
  const key = join(directory, "mixed-private.key"),
    alias = join(directory, "MIXED-PRIVATE.KEY");
  await writeFile(key, "invented private material");
  try {
    await readFile(alias);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
    // This filesystem supports distinct case-sensitive entries; keep them usable.
    await writeFile(alias, "invented independent material");
    expect(assertRecoveryArtifactDestination(alias, [key])).toBe(alias);
    return;
  }
  expect(() => assertRecoveryArtifactDestination(alias, [key])).toThrow("cannot replace");
  expect(await readFile(key, "utf8")).toBe("invented private material");
});

test("a missing filesystem root stops canonical resolution without revisiting it", async () => {
  let rootLookups = 0;
  const lookup = vi.mocked(fs.realpathSync).mockImplementation((path) => {
    const value = String(path);
    if (dirname(value) === value) {
      rootLookups++;
      if (rootLookups > 1) throw new Error("Repeated missing root lookup");
    }
    throw Object.assign(new Error("invented private path detail"), { code: "ENOENT" });
  });
  try {
    expect(() =>
      assertRecoveryArtifactDestination(join(directory, "nested", "out.json"), []),
    ).toThrow("cannot replace");
    expect(rootLookups).toBe(1);
  } finally {
    lookup.mockImplementation(
      (await vi.importActual<typeof import("node:fs")>("node:fs")).realpathSync,
    );
  }
});

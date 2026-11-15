// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  ensureInstallRootKey,
  primeSecretFileKeyCache,
  isEncryptedSecretFile,
  ownedProcessCleanupReceipt,
  spawnOwnedChildProcess,
} from "@omnesis/core";
import { generateSelfSigned } from "../tls.js";
import { readTlsPrivateKey, writeTlsMaterial } from "../tls-lifecycle/persistence.js";
import { HELPER_PROTOCOL_VERSION } from "./protocol.js";
import { HelperSupervisor } from "./supervisor.js";
import { TailscaleEmbedService } from "./service.js";

const helper = fileURLToPath(new URL("./testing/certificate-helper.mjs", import.meta.url));
let material: Awaited<ReturnType<typeof generateSelfSigned>>;
let rotated: Awaited<ReturnType<typeof generateSelfSigned>>;
beforeAll(async () => {
  material = await generateSelfSigned();
  rotated = await generateSelfSigned();
});
const fixtures: Array<{ service?: TailscaleEmbedService; dir: string; failure?: unknown }> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    let uncertain = ownedProcessCleanupReceipt(fixture.failure) !== undefined;
    if (uncertain) errors.push(fixture.failure);
    try {
      await fixture.service?.shutdown();
    } catch (error) {
      uncertain ||= ownedProcessCleanupReceipt(error) !== undefined;
      errors.push(error);
    }
    const remaining = fixture.service?.cleanupFailure();
    if (ownedProcessCleanupReceipt(remaining)) {
      uncertain = true;
      errors.push(remaining);
    }
    if (!uncertain) rmSync(fixture.dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  if (errors.length) throw new AggregateError(errors, "Certificate helper fixture cleanup failed");
});

async function boot(
  encrypted: boolean,
  servedMaterial?: () => Readonly<{ cert: string; key: string }>,
) {
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  const dir = mkdtempSync(join(tmpdir(), "tailnet-certificate-"));
  const owned: { service?: TailscaleEmbedService; dir: string; failure?: unknown } = { dir };
  fixtures.push(owned);
  try {
    const cert = join(dir, "tls", "cert.pem"),
      key = join(dir, "tls", "key.pem");
    if (encrypted) {
      await ensureInstallRootKey({ backend: "file", configDir: dir });
      await primeSecretFileKeyCache({ backend: "file", configDir: dir });
    }
    await writeTlsMaterial(cert, key, material, dir);
    const serializedKey = readFileSync(key, "utf8");
    expect(isEncryptedSecretFile(serializedKey)).toBe(encrypted);
    expect(await readTlsPrivateKey(key, dir)).toBe(material.key);
    const record = join(dir, "certificate-record.json");
    const launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const children: ReturnType<typeof spawnOwnedChildProcess>[] = [];
    const supervisor = new HelperSupervisor(
      (_binary, args, env) => {
        launches.push({ args, env });
        const child = spawnOwnedChildProcess(process.execPath, [helper, ...args], {
          env: {
            ...env,
            OMNESIS_FAKE_TAILNET_CERT_RECORD: record,
            OMNESIS_FAKE_TAILNET_PROTOCOL: String(HELPER_PROTOCOL_VERSION),
          },
        });
        children.push(child);
        return child;
      },
      process.env,
      [1],
    );
    const service = new TailscaleEmbedService({
      configDir: dir,
      env: process.env,
      supervisor,
      resolveBinary: () => ({ path: process.execPath }),
      tlsMaterial: () => ({ cert, key }),
      ...(servedMaterial ? { servedMaterial } : {}),
      joins: { notifyWaiting: () => {}, notifyJoined: () => {} },
    });
    owned.service = service;
    await service.attach({ listener: (_req, res) => res.end() });
    await service.setEnabled(true);
    await vi.waitFor(
      () => expect(["running", "crashed"]).toContain(supervisor.snapshot().process),
      {
        timeout: 10_000,
      },
    );
    return { service, supervisor, dir, cert, key, record, launches, children, serializedKey };
  } catch (error) {
    owned.failure = error;
    throw error;
  }
}

test("legacy plaintext gateway certificates remain usable by the helper", async () => {
  const f = await boot(false);
  expect(f.supervisor.snapshot().process).toBe("running");
  expect(JSON.parse(readFileSync(f.record, "utf8")).fingerprint).toBe(material.fingerprintSha256);
});

test("wrapped gateway keys reach the helper without rewriting the encrypted file or entering argv/environment", async () => {
  const f = await boot(true);
  expect(f.supervisor.snapshot().process).toBe("running");
  expect(JSON.parse(readFileSync(f.record, "utf8"))).toEqual({
    fingerprint: material.fingerprintSha256,
    from: "bootstrap",
  });
  expect(readFileSync(f.key, "utf8")).toBe(f.serializedKey);
  expect(isEncryptedSecretFile(f.serializedKey)).toBe(true);
  for (const launch of f.launches) {
    expect(launch.args.some((value) => value.includes("PRIVATE KEY"))).toBe(false);
    expect(Object.values(launch.env).some((value) => value?.includes("PRIVATE KEY"))).toBe(false);
  }
});

test("the active pair overrides replacement files and survives public toggles and a joined helper crash", async () => {
  let active = rotated;
  const f = await boot(true, () => active);
  expect(JSON.parse(readFileSync(f.record, "utf8")).fingerprint).toBe(rotated.fingerprintSha256);
  active = material;
  await f.service.refreshGatewayCertificate();
  await vi.waitFor(() =>
    expect(JSON.parse(readFileSync(f.record, "utf8")).fingerprint).toBe(material.fingerprintSha256),
  );
  await f.service.updateSettings({ publicAccess: true });
  const previous = f.children[0]!;
  expect(previous.child.kill("SIGKILL")).toBe(true);
  await previous.joined;
  await vi.waitFor(
    () => {
      expect(f.launches.length).toBe(2);
      expect(f.supervisor.snapshot().process).toBe("running");
      expect(JSON.parse(readFileSync(f.record, "utf8")).fingerprint).toBe(
        material.fingerprintSha256,
      );
    },
    { timeout: 10_000 },
  );
  expect(readFileSync(f.key, "utf8")).toBe(f.serializedKey);
  for (const launch of f.launches) {
    expect(launch.args).toContain("-certificate-bootstrap");
    expect(JSON.stringify({ args: launch.args, env: launch.env })).not.toContain("PRIVATE KEY");
  }
});

test("a failed material read preserves the running helper's accepted certificate", async () => {
  let unavailable = false;
  const f = await boot(true, () => {
    if (unavailable) throw new Error("invented material read failure");
    return material;
  });
  const accepted = readFileSync(f.record, "utf8");
  unavailable = true;
  await expect(f.service.refreshGatewayCertificate()).rejects.toThrow(
    "invented material read failure",
  );
  expect(f.supervisor.snapshot().process).toBe("running");
  expect(f.launches).toHaveLength(1);
  expect(readFileSync(f.record, "utf8")).toBe(accepted);
});

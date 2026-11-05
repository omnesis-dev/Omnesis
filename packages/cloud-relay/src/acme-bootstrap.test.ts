// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { tlsFiles, malformedDateCertificate } from "../test/support.js";
import { ensureAcmeBootstrap } from "./acme-bootstrap.js";

vi.mock("node:fs/promises", async (original) => {
  const module = await original<typeof import("node:fs/promises")>();
  return { ...module, link: vi.fn(module.link), readFile: vi.fn(module.readFile) };
});
const actualFiles = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-acme-bootstrap-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(files.link).mockReset().mockImplementation(actualFiles.link);
  vi.mocked(files.readFile).mockReset().mockImplementation(actualFiles.readFile);
  await rm(directory, { recursive: true, force: true });
});
test("separate public bootstrap uses the existing key, survives concurrent readers and recovers expiry without modifying direct material", async () => {
  const tls = tlsFiles(directory),
    direct = await readFile(tls.certFile, "utf8"),
    key = await readFile(tls.keyFile, "utf8");
  const certificateFile = join(directory, "public.crt"),
    options = {
      publicOrigin: "https://gateway.example.test",
      certificateFile,
      privateKeyFile: tls.keyFile,
      signal: new AbortController().signal,
    };
  await ensureAcmeBootstrap(options);
  const initial = await readFile(certificateFile, "utf8");
  await ensureAcmeBootstrap(options);
  expect(await readFile(certificateFile, "utf8")).toBe(initial);
  expect(new X509Certificate(initial).publicKey.equals(new X509Certificate(direct).publicKey)).toBe(
    true,
  );
  expect((await stat(certificateFile)).mode & 0o777).toBe(0o600);
  execFileSync(
    "openssl",
    [
      "x509",
      "-in",
      certificateFile,
      "-signkey",
      tls.keyFile,
      "-days",
      "-1",
      "-out",
      join(directory, "expired.crt"),
    ],
    { stdio: "ignore" },
  );
  await writeFile(certificateFile, await readFile(join(directory, "expired.crt")));
  expect(Date.parse(new X509Certificate(await readFile(certificateFile)).validTo)).toBeLessThan(
    Date.now(),
  );
  await ensureAcmeBootstrap(options);
  expect(Date.parse(new X509Certificate(await readFile(certificateFile)).validTo)).toBeGreaterThan(
    Date.now(),
  );
  expect(await readFile(tls.certFile, "utf8")).toBe(direct);
  expect(await readFile(tls.keyFile, "utf8")).toBe(key);
});
test("bootstrap rejects wrong host/key, invalid dates, unsupported addresses and filesystem/issuer errors without overwriting existing certificates", async () => {
  const tls = tlsFiles(directory, "gateway.example.test"),
    certificateFile = join(directory, "public.crt");
  const options = {
    publicOrigin: "https://gateway.example.test",
    certificateFile,
    privateKeyFile: tls.keyFile,
    signal: new AbortController().signal,
  };
  const original = await readFile(tls.certFile, "utf8");
  await writeFile(certificateFile, original);
  await expect(
    ensureAcmeBootstrap({ ...options, publicOrigin: "https://other.example.test" }),
  ).rejects.toThrow("hostname");
  await expect(
    ensureAcmeBootstrap({ ...options, publicOrigin: "https://127.0.0.1" }),
  ).rejects.toThrow("DNS");
  for (const which of ["from", "to"] as const) {
    const invalid = malformedDateCertificate(original, which);
    await writeFile(certificateFile, invalid);
    await expect(ensureAcmeBootstrap(options)).rejects.toThrow();
    expect(await readFile(certificateFile, "utf8")).toBe(invalid);
  }
  await writeFile(certificateFile, original);
  const otherDir = join(directory, "other");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(otherDir);
  const other = tlsFiles(otherDir, "gateway.example.test");
  await expect(ensureAcmeBootstrap({ ...options, privateKeyFile: other.keyFile })).rejects.toThrow(
    "key",
  );
  await expect(ensureAcmeBootstrap({ ...options, certificateFile: directory })).rejects.toThrow();
  await rm(certificateFile);
  const abort = new AbortController();
  abort.abort();
  await expect(ensureAcmeBootstrap({ ...options, signal: abort.signal })).rejects.toThrow();
  await expect(stat(certificateFile)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a dedicated public key is generated once with private permissions and an established missing key is never replaced", async () => {
  const tls = tlsFiles(directory),
    certificateFile = join(directory, "isolated-public.crt"),
    privateKeyFile = `${certificateFile}.key`;
  const options = {
    publicOrigin: "https://gateway.example.test",
    certificateFile,
    privateKeyFile,
    signal: new AbortController().signal,
    generatePrivateKey: true,
  };
  const attempts = await Promise.allSettled([
    ensureAcmeBootstrap(options),
    ensureAcmeBootstrap(options),
  ]);
  expect(attempts.some((result) => result.status === "fulfilled")).toBe(true);
  const original = await readFile(privateKeyFile, "utf8");
  expect((await stat(privateKeyFile)).mode & 0o777).toBe(0o600);
  expect(original).not.toBe(await readFile(tls.keyFile, "utf8"));
  await ensureAcmeBootstrap(options);
  expect(await readFile(privateKeyFile, "utf8")).toBe(original);
  await rm(privateKeyFile);
  await expect(ensureAcmeBootstrap(options)).rejects.toThrow("restore the original");
  await expect(stat(privateKeyFile)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    ensureAcmeBootstrap({ ...options, generatePrivateKey: false }),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("private-key publication races retain the winning key; other publication failures leave no key or temporary files", async () => {
  const certificateFile = join(directory, "public.crt"),
    privateKeyFile = `${certificateFile}.key`;
  const options = {
    publicOrigin: "https://gateway.example.test",
    certificateFile,
    privateKeyFile,
    generatePrivateKey: true,
    signal: new AbortController().signal,
  };
  for (const error of [
    null,
    "failure",
    {},
    Object.assign(new Error("disk full"), { code: "ENOSPC" }),
  ]) {
    vi.mocked(files.link).mockRejectedValueOnce(error);
    await expect(ensureAcmeBootstrap(options)).rejects.toBe(error);
    await expect(stat(privateKeyFile)).rejects.toMatchObject({ code: "ENOENT" });
  }
  vi.mocked(files.link).mockImplementationOnce(async (source, target) => {
    await actualFiles.writeFile(target, await actualFiles.readFile(source), {
      mode: 0o600,
      flag: "wx",
    });
    throw Object.assign(new Error("another creator won"), { code: "EEXIST" });
  });
  await ensureAcmeBootstrap(options);
  expect(await stat(certificateFile)).toBeDefined();
  await expect(
    ensureAcmeBootstrap({ ...options, publicOrigin: "https://gateway.1a" }),
  ).rejects.toThrow("DNS hostname");
});

test("key/certificate write races and malformed expired dates never publish a replacement", async () => {
  const tls = tlsFiles(directory, "gateway.example.test"),
    certificateFile = join(directory, "public.crt"),
    key = await readFile(tls.keyFile);
  const options = {
    publicOrigin: "https://gateway.example.test",
    certificateFile,
    privateKeyFile: tls.keyFile,
    signal: new AbortController().signal,
  };
  let reads = 0;
  vi.mocked(files.readFile).mockImplementation((async (path, encoding) => {
    if (String(path) === tls.keyFile && ++reads === 2) return Buffer.from("changed-key");
    return actualFiles.readFile(path, encoding);
  }) as typeof files.readFile);
  await expect(ensureAcmeBootstrap(options)).rejects.toThrow("key changed");
  await expect(stat(certificateFile)).rejects.toMatchObject({ code: "ENOENT" });
  vi.mocked(files.readFile).mockReset().mockImplementation(actualFiles.readFile);
  await ensureAcmeBootstrap(options);
  const expiredFile = join(directory, "expired.crt");
  execFileSync(
    "openssl",
    ["x509", "-in", certificateFile, "-signkey", tls.keyFile, "-days", "-1", "-out", expiredFile],
    { stdio: "ignore" },
  );
  const expired = await readFile(expiredFile, "utf8");
  await writeFile(certificateFile, expired);
  reads = 0;
  vi.mocked(files.readFile).mockImplementation((async (path, encoding) => {
    if (String(path) === certificateFile && ++reads === 2) return "changed-certificate";
    return actualFiles.readFile(path, encoding);
  }) as typeof files.readFile);
  await expect(ensureAcmeBootstrap(options)).rejects.toThrow("certificate changed");
  vi.mocked(files.readFile).mockReset().mockImplementation(actualFiles.readFile);
  await writeFile(certificateFile, malformedDateCertificate(expired, "from"));
  await expect(ensureAcmeBootstrap(options)).rejects.toThrow("Invalid public certificate dates");
  expect(await readFile(tls.keyFile)).toEqual(key);
});

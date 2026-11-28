// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { markedFileError, onWindowsBoundary } from "../test/private-operation-fixture.js";
import { exposeOwnedFixtureRead } from "../test/owned-file-acl.js";
import { tlsFiles, malformedDateCertificate } from "../test/support.js";
import { expiredCertificate } from "../test/expired-certificate.js";
import { ensureAcmeBootstrap } from "./acme-bootstrap.js";
import * as privateInputs from "./private-inputs.js";

vi.mock("node:fs/promises", async (original) => {
  const module = await original<typeof import("node:fs/promises")>();
  return { ...module, link: vi.fn(module.link), readFile: vi.fn(module.readFile) };
});
const actualFiles = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-acme-bootstrap-"));
  if (process.platform === "win32") await core.ensurePrivateDirs([directory]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(files.link).mockReset().mockImplementation(actualFiles.link);
  vi.mocked(files.readFile).mockReset().mockImplementation(actualFiles.readFile);
  await rm(directory, { recursive: true, force: true });
});

test("Windows bootstrap refuses unsafe private key input before using its public certificate", async () => {
  const tls = tlsFiles(directory, "gateway.example.test");
  const refused = Object.assign(new Error("Invented unsafe bootstrap key"), { code: "EPRIVATE" });
  const read = vi.spyOn(core, "readWindowsPrivateFile").mockRejectedValueOnce(refused);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    await expect(
      ensureAcmeBootstrap({
        publicOrigin: "https://gateway.example.test",
        certificateFile: tls.certFile,
        privateKeyFile: tls.keyFile,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(refused);
    expect(read).toHaveBeenCalledWith(tls.keyFile, 65_536);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("managed Windows bootstrap refuses the unsupported private pipe before reading or replacing credentials", async () => {
  directory = await realpath(directory);
  const key = join(directory, "retained.key"),
    certificateFile = join(directory, "not-created.pem");
  const previous = "invented retained private material";
  await writeFile(key, previous, { mode: 0o600 });
  const read = vi.spyOn(core, "readWindowsPrivateFile"),
    openssl = vi.spyOn(core, "runOpenSslWithPrivateInput");
  await onWindowsBoundary(async () => {
    await expect(
      ensureAcmeBootstrap({
        publicOrigin: "https://gateway.example.test",
        certificateFile,
        privateKeyFile: key,
        generatePrivateKey: true,
        secretFileOptions: {
          configDir: directory,
          service: "fictional-managed-acme",
          backend: "file",
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("supported private pipe adapter");
  });
  expect(read).not.toHaveBeenCalled();
  expect(openssl).not.toHaveBeenCalled();
  expect(await readFile(key, "utf8")).toBe(previous);
  await expect(stat(certificateFile)).rejects.toMatchObject({ code: "ENOENT" });
});

test("uncertain certificate publication retains its staged evidence and renewal lock", async () => {
  directory = await realpath(directory);
  const tls = tlsFiles(directory, "gateway.example.test"),
    certificateFile = join(directory, "public.crt"),
    failure = markedFileError("EPRIVATE", "own"),
    acquire = core.acquireGatewayLock;
  let retained: Awaited<ReturnType<typeof acquire>> | undefined;
  const release = vi.fn();
  vi.spyOn(core, "acquireGatewayLock").mockImplementation(async (...args) => {
    retained = await acquire(...args);
    const actualRelease = retained.release.bind(retained);
    release.mockImplementation(actualRelease);
    retained.release = release;
    return retained;
  });
  // The real issuer finishes; uncertainty is injected only at the publication boundary.
  vi.mocked(files.link).mockRejectedValueOnce(failure);
  try {
    await expect(
      ensureAcmeBootstrap({
        publicOrigin: "https://gateway.example.test",
        certificateFile,
        privateKeyFile: tls.keyFile,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure);
    expect(release).not.toHaveBeenCalled();
    const staged = (await readdir(directory)).filter(
      (name) => name.startsWith("public.crt.") && name.endsWith(".tmp"),
    );
    expect(staged).toHaveLength(1);
    expect(
      new X509Certificate(await readFile(join(directory, staged[0]!))).checkHost(
        "gateway.example.test",
      ),
    ).toBe("gateway.example.test");
    await expect(stat(certificateFile)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    // This invented publication receipt owns no child. Join the actual fixture lock explicitly.
    retained?.release();
  }
});

test("a certificate path behind a non-directory ancestor cannot authorize a fresh private key", async () => {
  const blocked = join(directory, "ancestor-file");
  await writeFile(blocked, "invented non-directory ancestor");
  const key = join(directory, "not-created.key");
  await expect(
    ensureAcmeBootstrap({
      publicOrigin: "https://gateway.example.test",
      certificateFile: join(blocked, "certificate.pem"),
      privateKeyFile: key,
      generatePrivateKey: true,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  await expect(readFile(key)).rejects.toMatchObject({ code: "ENOENT" });
});

test.skipIf(process.platform !== "win32")(
  "Windows bootstrap accepts a public certificate but refuses a publicly readable private key",
  async () => {
    const tls = tlsFiles(directory, "gateway.example.test");
    const options = {
      publicOrigin: "https://gateway.example.test",
      certificateFile: tls.certFile,
      privateKeyFile: tls.keyFile,
      signal: new AbortController().signal,
    };
    const previous = await readFile(tls.keyFile, "utf8");
    const certificateExposure = await exposeOwnedFixtureRead(tls.certFile);
    let keyExposure: Awaited<ReturnType<typeof exposeOwnedFixtureRead>> | undefined;
    try {
      expect(core.inspectWindowsPrivatePathSync(tls.certFile, "file").private).toBe(false);
      await ensureAcmeBootstrap(options);
      keyExposure = await exposeOwnedFixtureRead(tls.keyFile);
      await expect(ensureAcmeBootstrap(options)).rejects.toMatchObject({ code: "EPRIVATE" });
      expect(await readFile(tls.keyFile, "utf8")).toBe(previous);
      expect(await keyExposure.snapshot()).toBe(keyExposure.exposed);
      expect(await certificateExposure.snapshot()).toBe(certificateExposure.exposed);
    } finally {
      await keyExposure?.restore();
      await certificateExposure.restore();
    }
    await ensureAcmeBootstrap(options);
  },
);
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
  if (process.platform !== "win32") {
    expect((await stat(certificateFile)).mode & 0o777).toBe(0o600);
  }
  expiredCertificate({
    certificateFile,
    privateKeyFile: tls.keyFile,
    outputFile: join(directory, "expired.crt"),
  });
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
  if (process.platform !== "win32") {
    expect((await stat(privateKeyFile)).mode & 0o777).toBe(0o600);
  } else {
    expect(core.inspectWindowsPrivatePathSync(privateKeyFile, "file").private).toBe(true);
  }
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
  const originalPrivateRead = privateInputs.readPrivateInput;
  const privateRead = vi
    .spyOn(privateInputs, "readPrivateInput")
    .mockImplementation(async (path) => {
      const bytes = await originalPrivateRead(path);
      if (path === tls.keyFile && ++reads === 2) return Buffer.from("changed-key");
      return bytes;
    });
  await expect(ensureAcmeBootstrap(options)).rejects.toThrow("key changed");
  await expect(stat(certificateFile)).rejects.toMatchObject({ code: "ENOENT" });
  privateRead.mockRestore();
  await ensureAcmeBootstrap(options);
  const expiredFile = join(directory, "expired.crt");
  expiredCertificate({ certificateFile, privateKeyFile: tls.keyFile, outputFile: expiredFile });
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

test.each(["key", "certificate"] as const)(
  "marked bootstrap %s absence never authorizes private-key generation",
  async (phase) => {
    const failure = markedFileError("ENOENT", "cause"),
      key = join(directory, "new.key"),
      cert = join(directory, "existing.pem");
    const missing = Object.assign(new Error("Invented key absence"), { code: "ENOENT" });
    vi.spyOn(core, "readWindowsPrivateFile").mockRejectedValueOnce(
      phase === "key" ? failure : missing,
    );
    const metadata = vi
      .spyOn(core, "readWindowsRegularFilePrefix")
      .mockRejectedValueOnce(phase === "certificate" ? failure : missing);
    const writer = vi
      .spyOn(core, "atomicWriteFile")
      .mockRejectedValueOnce(new Error("Invented unexpected key publication"));
    await onWindowsBoundary(async () => {
      await expect(
        ensureAcmeBootstrap({
          publicOrigin: "https://gateway.example.test",
          certificateFile: cert,
          privateKeyFile: key,
          generatePrivateKey: true,
          signal: new AbortController().signal,
        }),
      ).rejects.toBe(failure);
      expect(writer).not.toHaveBeenCalled();
      if (phase === "key") expect(metadata).not.toHaveBeenCalled();
      await expect(stat(key)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

test.each(["own", "cause", "ordinary"] as const)(
  "bootstrap staging survives only explicit helper uncertainty (%s)",
  async (placement) => {
    const key = join(directory, "bootstrap.key"),
      certificateFile = join(directory, "bootstrap.pem");
    const failure =
      placement === "ordinary"
        ? new Error("Invented joined publication failure")
        : markedFileError("EPRIVATE", placement);
    const missing = Object.assign(new Error("Invented absence"), { code: "ENOENT" });
    vi.spyOn(core, "readWindowsPrivateFile").mockRejectedValueOnce(missing);
    vi.spyOn(core, "readWindowsRegularFilePrefix").mockRejectedValueOnce(missing);
    let temporary: string | undefined;
    vi.spyOn(core, "atomicWriteFile").mockImplementationOnce(async (target, bytes) => {
      temporary = target;
      await writeFile(target, bytes, { mode: 0o600 });
      throw failure;
    });
    await onWindowsBoundary(async () => {
      await expect(
        ensureAcmeBootstrap({
          publicOrigin: "https://gateway.example.test",
          certificateFile,
          privateKeyFile: key,
          generatePrivateKey: true,
          signal: new AbortController().signal,
        }),
      ).rejects.toBe(failure);
      expect(temporary).toBeDefined();
      await expect(stat(key)).rejects.toMatchObject({ code: "ENOENT" });
      if (placement === "ordinary")
        await expect(stat(temporary!)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(temporary!, "utf8")).toContain("PRIVATE KEY");
    });
  },
);

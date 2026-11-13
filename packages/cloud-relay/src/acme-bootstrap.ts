// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, link, rm, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  randomUUID,
  generateKeyPairSync,
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { acquireGatewayLock, atomicWriteFile } from "@omnesis/core";
import { publicKeyFingerprint } from "./gateway-key-auth.js";
import { bindingOrigin, validateCertificateDates } from "./gateway-binding.js";

async function privateKey(
  path: string,
  certificateFile: string,
  generate: boolean,
): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    if (
      !generate ||
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    )
      throw error;
    try {
      await readFile(certificateFile);
      // Keep private material paths out of recursively rendered error causes.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Public ACME private key is missing; restore the original key");
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const generated = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      });
      await atomicWriteFile(temporary, generated, { mode: 0o600 });
      try {
        await link(temporary, path);
      } catch (error) {
        if (!(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return readFile(path);
  }
}

/** A public-host bootstrap leaf never overwrites direct TLS material; expired public leaves recover using the same dedicated key. */
export async function ensureAcmeBootstrap(options: {
  publicOrigin: string;
  certificateFile: string;
  privateKeyFile: string;
  signal: AbortSignal;
  generatePrivateKey?: boolean;
}): Promise<void> {
  options.signal.throwIfAborted();
  const hostname = bindingOrigin(options.publicOrigin).hostname;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(hostname))
    throw new Error("ACME requires one DNS hostname");
  const key = await privateKey(
    options.privateKeyFile,
    options.certificateFile,
    options.generatePrivateKey === true,
  );
  const keyFingerprint = publicKeyFingerprint(createPublicKey(createPrivateKey(key)));
  let previous: string | undefined;
  try {
    previous = await readFile(options.certificateFile, "utf8");
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  if (previous !== undefined) {
    const certificate = new X509Certificate(previous);
    if (
      certificate.checkHost(hostname, { subject: "never", wildcards: false }) !== hostname ||
      publicKeyFingerprint(certificate.publicKey) !== keyFingerprint
    )
      throw new Error("Public ACME certificate does not match the gateway key and hostname");
    if (
      !Number.isFinite(Date.parse(certificate.validTo)) ||
      Date.parse(certificate.validTo) > Date.now()
    ) {
      validateCertificateDates(certificate);
      return;
    }
    if (!Number.isFinite(Date.parse(certificate.validFrom)))
      throw new Error("Invalid public certificate dates");
  }
  await mkdir(dirname(options.certificateFile), { recursive: true, mode: 0o700 });
  const lockDirectory = join(dirname(options.certificateFile), ".acme-renewal");
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const lock = await acquireGatewayLock(lockDirectory, { waitMs: 0 });
  const temporary = `${options.certificateFile}.${randomUUID()}.tmp`;
  try {
    await promisify(execFile)(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-key",
        options.privateKeyFile,
        "-out",
        temporary,
        "-days",
        "7",
        "-sha256",
        "-subj",
        `/CN=${hostname}`,
        "-addext",
        `subjectAltName=DNS:${hostname}`,
        "-addext",
        "basicConstraints=critical,CA:FALSE",
      ],
      { signal: options.signal, timeout: 15_000, maxBuffer: 65_536 },
    );
    await chmod(temporary, 0o600);
    if (!(await readFile(options.privateKeyFile)).equals(key))
      throw new Error("Gateway key changed during public certificate bootstrap");
    options.signal.throwIfAborted();
    if (previous === undefined) await link(temporary, options.certificateFile);
    else {
      if ((await readFile(options.certificateFile, "utf8")) !== previous)
        throw new Error("Public certificate changed during bootstrap");
      await atomicWriteFile(options.certificateFile, await readFile(temporary), { mode: 0o600 });
    }
  } finally {
    await rm(temporary, { force: true });
    lock.release();
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, link, rm, chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  randomUUID,
  generateKeyPairSync,
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  acquireGatewayLock,
  atomicWriteFile,
  ownedProcessCleanupReceipt,
  runOpenSslWithPrivateInput,
} from "@omnesis/core";
import {
  gatewayCredentialOptions,
  readOrCreateScopedGatewayKey,
} from "./gateway-secret-storage.js";
import { isJoinedPrivateFileError } from "./private-file-errors.js";
import { publicKeyFingerprint } from "./gateway-key-auth.js";
import { bindingOrigin, validateCertificateDates } from "./gateway-binding.js";
import { readPrivateInput, identityArtifactPresent } from "./private-inputs.js";
import type { SecretFileOptions } from "@omnesis/core";

async function privateKey(
  path: string,
  certificateFile: string,
  generate: boolean,
  options?: SecretFileOptions,
): Promise<Buffer> {
  if (options) {
    const allowCreate = generate && !(await identityArtifactPresent(certificateFile));
    const key = await readOrCreateScopedGatewayKey(path, allowCreate, options, "p256");
    return Buffer.from(key.export({ type: "pkcs8", format: "pem" }));
  }
  try {
    return await readPrivateInput(path);
  } catch (error) {
    if (!generate || !isJoinedPrivateFileError(error, "ENOENT")) throw error;
    if (await identityArtifactPresent(certificateFile)) {
      // Keep private material paths out of recursively rendered error causes.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Public ACME private key is missing; restore the original key");
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    let publicationFailure: unknown;
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
    } catch (error) {
      publicationFailure = error;
      throw error;
    } finally {
      if (ownedProcessCleanupReceipt(publicationFailure) === undefined)
        await rm(temporary, { force: true });
    }
    return readPrivateInput(path);
  }
}

/** A public-host bootstrap leaf never overwrites direct TLS material; expired public leaves recover using the same dedicated key. */
export async function ensureAcmeBootstrap(options: {
  publicOrigin: string;
  certificateFile: string;
  privateKeyFile: string;
  signal: AbortSignal;
  generatePrivateKey?: boolean;
  configDir?: string;
  secretFileOptions?: SecretFileOptions;
}): Promise<void> {
  options.signal.throwIfAborted();
  const hostname = bindingOrigin(options.publicOrigin).hostname;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(hostname))
    throw new Error("ACME requires one DNS hostname");
  const secretFileOptions =
    options.secretFileOptions ?? gatewayCredentialOptions(options.configDir);
  if (secretFileOptions && process.platform === "win32")
    throw new Error("Managed ACME key input requires a supported private pipe adapter");
  const key = await privateKey(
    options.privateKeyFile,
    options.certificateFile,
    options.generatePrivateKey === true,
    secretFileOptions,
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
  const configuration = `${temporary}.cnf`;
  let publicationFailure: unknown;
  try {
    const args = [
      "req",
      "-new",
      "-x509",
      "-key",
      secretFileOptions ? "/dev/stdin" : options.privateKeyFile,
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
    ];
    if (secretFileOptions) {
      // Public metadata only: req's configuration works across OS OpenSSL/LibreSSL
      // variants without requiring their optional -addext argument support.
      await writeFile(
        configuration,
        `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=${hostname}\n[v3]\nsubjectAltName=DNS:${hostname}\nbasicConstraints=critical,CA:FALSE\n`,
        { mode: 0o600, flag: "wx" },
      );
      await runOpenSslWithPrivateInput(
        [
          "req",
          "-new",
          "-x509",
          "-key",
          "/dev/stdin",
          "-out",
          temporary,
          "-days",
          "7",
          "-sha256",
          "-config",
          configuration,
        ],
        key,
        { signal: options.signal },
      );
    } else {
      await promisify(execFile)("openssl", args, {
        signal: options.signal,
        timeout: 15_000,
        maxBuffer: 65_536,
      });
    }
    await chmod(temporary, 0o600);
    if (
      !(
        await privateKey(options.privateKeyFile, options.certificateFile, false, secretFileOptions)
      ).equals(key)
    )
      throw new Error("Gateway key changed during public certificate bootstrap");
    options.signal.throwIfAborted();
    if (previous === undefined) await link(temporary, options.certificateFile);
    else {
      if ((await readFile(options.certificateFile, "utf8")) !== previous)
        throw new Error("Public certificate changed during bootstrap");
      await atomicWriteFile(options.certificateFile, await readFile(temporary), { mode: 0o600 });
    }
  } catch (error) {
    publicationFailure = error;
    throw error;
  } finally {
    if (ownedProcessCleanupReceipt(publicationFailure) === undefined) {
      await rm(temporary, { force: true });
      await rm(configuration, { force: true });
      lock.release();
    }
  }
}

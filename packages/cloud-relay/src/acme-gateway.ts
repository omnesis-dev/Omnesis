// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { readFile, mkdir, mkdtemp, writeFile, link, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rootCertificates } from "node:tls";
import { acquireGatewayLock, atomicWriteFile, ownedProcessCleanupReceipt } from "@omnesis/core";
import { z } from "zod";
import { isJoinedPrivateFileError } from "./private-file-errors.js";
import { issueAcmeCertificate, type AcmeDnsPresenter } from "./acme-client.js";
import { bindingOrigin, validateCertificateDates } from "./gateway-binding.js";
import { publicKeyFingerprint } from "./gateway-key-auth.js";
import { readBoundedJson } from "./google-credentials.js";
import { relayOrigin } from "./network.js";
import { readPrivateText } from "./private-inputs.js";
import { combinedCleanupErrors, OwnedCleanupLifecycle } from "./owned-cleanup-lifecycle.js";

export function relayDnsPresenter(options: {
  relayUrl: string;
  session: (signal?: AbortSignal) => Promise<string>;
  invalidateSession?: () => void;
  fetch?: typeof fetch;
}): AcmeDnsPresenter {
  const relay = relayOrigin(options.relayUrl);
  const request = async (
    method: string,
    body: unknown,
    signal: AbortSignal,
    attempt = 0,
  ): Promise<Response> => {
    const response = await (options.fetch ?? fetch)(new URL("/_relay/v2/acme/challenge", relay), {
      method,
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${await options.session(signal)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401 && attempt === 0 && options.invalidateSession) {
      await response.body?.cancel();
      signal.throwIfAborted();
      options.invalidateSession();
      return request(method, body, signal, 1);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Relay DNS challenge cooperation refused");
    }
    return response;
  };
  return {
    async create(value, signal) {
      return z
        .object({ id: z.string().uuid() })
        .parse(await readBoundedJson(await request("POST", { value }, signal)));
    },
    async remove(id, signal) {
      await request("DELETE", { id }, signal);
    },
  };
}

/** Validate the complete offered chain against public roots before replacing any served material. */
export function validateAcmeCertificate(
  pem: string,
  tlsKey: string,
  hostname: string,
  roots: readonly string[] = rootCertificates,
): X509Certificate {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length > 8 || blocks.join("").replace(/\s/g, "") !== pem.replace(/\s/g, ""))
    throw new Error("Invalid ACME certificate chain");
  const chain = blocks.map((block) => new X509Certificate(block));
  for (const certificate of chain) validateCertificateDates(certificate);
  const leaf = chain[0]!;
  if (
    leaf.ca ||
    leaf.subjectAltName !== `DNS:${hostname}` ||
    publicKeyFingerprint(leaf.publicKey) !==
      publicKeyFingerprint(createPublicKey(createPrivateKey(tlsKey)))
  )
    throw new Error("ACME certificate does not match the gateway key and hostname");
  for (let index = 0; index < chain.length - 1; index++) {
    if (
      !chain[index + 1]!.ca ||
      !chain[index]!.checkIssued(chain[index + 1]!) ||
      !chain[index]!.verify(chain[index + 1]!.publicKey)
    )
      throw new Error("Invalid ACME certificate chain signature");
  }
  const last = chain.at(-1)!;
  if (
    !roots.some((pem) => {
      const root = new X509Certificate(pem);
      return root.ca && last.checkIssued(root) && last.verify(root.publicKey);
    })
  )
    throw new Error("ACME certificate chain is not publicly trusted");
  return leaf;
}

async function verifyChain(
  pem: string,
  hostname: string,
  roots: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "omnesis-acme-chain-"));
  try {
    const chainFile = join(temporary, "chain.pem"),
      rootsFile = join(temporary, "roots.pem");
    await writeFile(chainFile, pem, { mode: 0o600 });
    await writeFile(rootsFile, roots.join("\n"), { mode: 0o600 });
    await promisify(execFile)(
      "openssl",
      [
        "verify",
        "-purpose",
        "sslserver",
        "-verify_hostname",
        hostname,
        "-CAfile",
        rootsFile,
        "-untrusted",
        chainFile,
        chainFile,
      ],
      { signal, timeout: 15_000, maxBuffer: 65_536 },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function accountKey(path: string): Promise<string> {
  try {
    return await readPrivateText(path);
  } catch (error) {
    if (!isJoinedPrivateFileError(error, "ENOENT")) throw error;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    let publicationFailure: unknown;
    try {
      await atomicWriteFile(temporary, key, { mode: 0o600 });
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
    return readPrivateText(path);
  }
}

export interface GatewayAcmeOptions {
  directoryUrl: string;
  publicOrigin: string;
  certificateFile: string;
  privateKeyFile: string;
  accountKeyFile: string;
  presenter: AcmeDnsPresenter;
  /** Existing gateway TLS lifecycle reloads the atomically replaced certificate into its HTTPS server. */
  activate: (signal: AbortSignal) => Promise<void>;
  afterActivation?: (signal: AbortSignal) => Promise<void>;
  /** Runs with the ACME account's URL before each order. */
  beforeOrder?: (accountUri: string, signal: AbortSignal) => Promise<void>;
  issuer?: typeof issueAcmeCertificate;
  trustedRoots?: readonly string[];
}

/** One gateway-owned TLS key, one DNS hostname, and serialized renewal. The relay receives public challenges only. */
export class GatewayAcmeRenewal {
  private readonly abort = new AbortController();
  private readonly cleanup = new OwnedCleanupLifecycle(() => this.abort.abort());
  private readonly retainedLocks = new Set<Awaited<ReturnType<typeof acquireGatewayLock>>>();
  private pending: Promise<boolean> | undefined;
  constructor(private readonly options: GatewayAcmeOptions) {
    bindingOrigin(options.publicOrigin);
  }
  renew(signal: AbortSignal): Promise<boolean> {
    try {
      this.cleanup.assertAdmitting();
    } catch (error) {
      return Promise.reject(error);
    }
    return (this.pending ??= this.cleanup
      .run(() => this.perform(AbortSignal.any([signal, this.abort.signal])))
      .finally(() => {
        this.pending = undefined;
      }));
  }
  cleanupFailure(): unknown | undefined {
    return this.cleanup.receipt();
  }
  close(): Promise<void> {
    this.abort.abort();
    return this.cleanup.close();
  }
  private assertContinuing(signal: AbortSignal): void {
    signal.throwIfAborted();
    this.cleanup.assertAdmitting();
  }
  private async perform(signal: AbortSignal): Promise<boolean> {
    this.assertContinuing(signal);
    const hostname = bindingOrigin(this.options.publicOrigin).hostname;
    const certificate = await readFile(this.options.certificateFile, "utf8");
    this.assertContinuing(signal);
    const tlsKey = await readPrivateText(this.options.privateKeyFile);
    this.assertContinuing(signal);
    const leaf = new X509Certificate(certificate);
    let usable = false;
    try {
      validateAcmeCertificate(certificate, tlsKey, hostname, this.options.trustedRoots);
      usable = true;
    } catch {
      /* Invalid current material must be replaced before it can be served publicly. */
    }
    if (
      usable &&
      !leaf.verify(leaf.publicKey) &&
      Date.parse(leaf.validTo) > Date.now() + 30 * 86400_000
    )
      return false;
    const lockDir = join(dirname(this.options.certificateFile), ".acme-renewal");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    this.assertContinuing(signal);
    const lock = await acquireGatewayLock(lockDir, { waitMs: 0 });
    try {
      this.assertContinuing(signal);
      const key = await accountKey(this.options.accountKeyFile);
      this.assertContinuing(signal);
      const renewed = await (this.options.issuer ?? issueAcmeCertificate)({
        directoryUrl: this.options.directoryUrl,
        hostname,
        accountKey: key,
        tlsKey,
        presenter: this.options.presenter,
        ...(this.options.beforeOrder ? { beforeOrder: this.options.beforeOrder } : {}),
        signal,
      });
      this.assertContinuing(signal);
      const candidate = validateAcmeCertificate(
        renewed,
        tlsKey,
        hostname,
        this.options.trustedRoots,
      );
      await verifyChain(renewed, hostname, this.options.trustedRoots ?? rootCertificates, signal);
      this.assertContinuing(signal);
      if (!leaf.verify(leaf.publicKey) && Date.parse(candidate.validTo) <= Date.parse(leaf.validTo))
        throw new Error("ACME renewal did not extend the certificate lifetime");
      const currentCertificate = await readFile(this.options.certificateFile, "utf8");
      this.assertContinuing(signal);
      if (currentCertificate !== certificate)
        throw new Error("Gateway TLS material changed during ACME issuance");
      const currentKey = await readPrivateText(this.options.privateKeyFile);
      this.assertContinuing(signal);
      if (currentKey !== tlsKey)
        throw new Error("Gateway TLS material changed during ACME issuance");
      await atomicWriteFile(this.options.certificateFile, renewed, { mode: 0o600 });
      try {
        signal.throwIfAborted();
        await this.options.activate(signal);
        if (this.options.afterActivation) {
          this.assertContinuing(signal);
          await this.options.afterActivation(signal);
        }
      } catch (error) {
        if (this.cleanup.observe(error)) throw error;
        try {
          await atomicWriteFile(this.options.certificateFile, certificate, { mode: 0o600 });
          await this.options.activate(AbortSignal.timeout(15_000));
        } catch (rollbackError) {
          throw combinedCleanupErrors([error, rollbackError], "ACME activation rollback failed");
        }
        throw error;
      }
      return true;
    } catch (error) {
      this.cleanup.observe(error);
      throw error;
    } finally {
      if (this.cleanup.uncertain) this.retainedLocks.add(lock);
      else lock.release();
    }
  }
}

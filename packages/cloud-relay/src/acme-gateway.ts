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
import { acquireGatewayLock, atomicWriteFile } from "@omnesis/core";
import { z } from "zod";
import { issueAcmeCertificate, type AcmeDnsPresenter } from "./acme-client.js";
import { bindingOrigin, validateCertificateDates } from "./gateway-binding.js";
import { publicKeyFingerprint } from "./gateway-key-auth.js";
import { readBoundedJson } from "./google-credentials.js";
import { relayOrigin } from "./network.js";

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
    return await readFile(path, "utf8");
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
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
    } finally {
      await rm(temporary, { force: true });
    }
    return readFile(path, "utf8");
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
  issuer?: typeof issueAcmeCertificate;
  trustedRoots?: readonly string[];
}

/** One gateway-owned TLS key, one DNS hostname, and serialized renewal. The relay receives public challenges only. */
export class GatewayAcmeRenewal {
  private pending: Promise<boolean> | undefined;
  constructor(private readonly options: GatewayAcmeOptions) {
    bindingOrigin(options.publicOrigin);
  }
  renew(signal: AbortSignal): Promise<boolean> {
    return (this.pending ??= this.perform(signal).finally(() => {
      this.pending = undefined;
    }));
  }
  private async perform(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const hostname = bindingOrigin(this.options.publicOrigin).hostname;
    const certificate = await readFile(this.options.certificateFile, "utf8"),
      tlsKey = await readFile(this.options.privateKeyFile, "utf8");
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
    const lock = await acquireGatewayLock(lockDir, { waitMs: 0 });
    try {
      const renewed = await (this.options.issuer ?? issueAcmeCertificate)({
        directoryUrl: this.options.directoryUrl,
        hostname,
        accountKey: await accountKey(this.options.accountKeyFile),
        tlsKey,
        presenter: this.options.presenter,
        signal,
      });
      const candidate = validateAcmeCertificate(
        renewed,
        tlsKey,
        hostname,
        this.options.trustedRoots,
      );
      await verifyChain(renewed, hostname, this.options.trustedRoots ?? rootCertificates, signal);
      if (!leaf.verify(leaf.publicKey) && Date.parse(candidate.validTo) <= Date.parse(leaf.validTo))
        throw new Error("ACME renewal did not extend the certificate lifetime");
      if (
        (await readFile(this.options.certificateFile, "utf8")) !== certificate ||
        (await readFile(this.options.privateKeyFile, "utf8")) !== tlsKey
      )
        throw new Error("Gateway TLS material changed during ACME issuance");
      signal.throwIfAborted();
      await atomicWriteFile(this.options.certificateFile, renewed, { mode: 0o600 });
      try {
        signal.throwIfAborted();
        await this.options.activate(signal);
        await this.options.afterActivation?.(signal);
      } catch (error) {
        await atomicWriteFile(this.options.certificateFile, certificate, { mode: 0o600 });
        await this.options.activate(AbortSignal.timeout(15_000));
        throw error;
      }
      return true;
    } finally {
      lock.release();
    }
  }
}

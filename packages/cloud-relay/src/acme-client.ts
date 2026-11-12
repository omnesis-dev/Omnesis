// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Resolver } from "node:dns/promises";
import * as acme from "acme-client";
import { z } from "zod";
import { relayOrigin } from "./network.js";

interface Scope {
  origin: string;
  signal: AbortSignal;
}
const scope = new AsyncLocalStorage<Scope>();
// The library exposes its own Axios instance. Async context keeps concurrent issuers' cancellation/recipient policies separate.
Object.assign(acme.axios.defaults, { acmeSettings: { retryMaxAttempts: 0, retryDefaultDelay: 0 } });
acme.axios.interceptors.request.use((request) => {
  const current = scope.getStore();
  if (!current) throw new Error("ACME request requires an issuance scope");
  const target = new URL(request.url!);
  if (target.origin !== current.origin || target.username || target.password || target.hash)
    throw new Error("ACME response redirected issuance to a different recipient");
  current.signal.throwIfAborted();
  return {
    ...request,
    signal: current.signal,
    timeout: 15_000,
    maxRedirects: 0,
    maxContentLength: 65_536,
    maxBodyLength: 65_536,
  };
});

export interface AcmeDnsPresenter {
  create(value: string, signal: AbortSignal): Promise<{ id: string }>;
  remove(id: string, signal: AbortSignal): Promise<void>;
}
async function dnsContains(hostname: string, value: string, signal: AbortSignal): Promise<boolean> {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return (await resolver.resolveTxt(`_acme-challenge.${hostname}`)).some(
      (parts) => parts.join("") === value,
    );
  } catch {
    signal.throwIfAborted();
    return false;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** RFC8555 account/JWS/CSR operations use the maintained ACME client; all network/polling stays bounded. */
export async function issueAcmeCertificate(options: {
  directoryUrl: string;
  hostname: string;
  accountKey: string;
  tlsKey: string;
  presenter: AcmeDnsPresenter;
  signal: AbortSignal;
  lookup?: typeof dnsContains;
}): Promise<string> {
  const directory = new URL(options.directoryUrl);
  const origin = relayOrigin(directory.origin).origin;
  if (directory.username || directory.password || directory.hash)
    throw new Error("Invalid ACME directory URL");
  const hostname = z
    .string()
    .max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/)
    .parse(options.hostname);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]);
  return scope.run({ origin, signal }, async () => {
    const client = new acme.Client({
      directoryUrl: directory.href,
      accountKey: options.accountKey,
      backoffAttempts: 1,
    });
    const wait = async <T extends { status?: string }>(
      read: () => Promise<T>,
      accepted: string[],
    ): Promise<T> => {
      for (let count = 0; count < 60; count++) {
        signal.throwIfAborted();
        const value = await read();
        if (accepted.includes(value.status ?? "")) return value;
        if (!["pending", "processing"].includes(value.status ?? ""))
          throw new Error("ACME authorization or order failed");
        await delay(1000, undefined, { signal });
      }
      throw new Error("ACME status polling limit exceeded");
    };
    await client.createAccount({ termsOfServiceAgreed: true });
    const [, csr] = await acme.crypto.createCsr(
      { commonName: hostname, altNames: [hostname] },
      options.tlsKey,
    );
    let order = await client.createOrder({ identifiers: [{ type: "dns", value: hostname }] });
    const authorizations = await client.getAuthorizations(order);
    if (
      authorizations.length !== 1 ||
      authorizations[0]!.identifier.type !== "dns" ||
      authorizations[0]!.identifier.value !== hostname ||
      authorizations[0]!.wildcard
    )
      throw new Error("ACME authorization is outside the gateway hostname");
    const authorization = authorizations[0]!;
    if (authorization.status !== "valid") {
      const challenge = authorization.challenges.find((item) => item.type === "dns-01");
      if (!challenge) throw new Error("ACME server did not offer DNS-01");
      const value = await client.getChallengeKeyAuthorization(challenge);
      const lease = await options.presenter.create(value, signal);
      try {
        let visible = false;
        for (let count = 0; count < 60; count++) {
          if (await (options.lookup ?? dnsContains)(hostname, value, signal)) {
            visible = true;
            break;
          }
          await delay(1000, undefined, { signal });
        }
        if (!visible) throw new Error("ACME DNS propagation limit exceeded");
        await client.completeChallenge(challenge);
        await wait(async () => (await client.getAuthorizations(order))[0]!, ["valid"]);
      } finally {
        // Cleanup gets its own short deadline even when issuance itself was cancelled.
        await options.presenter.remove(lease.id, AbortSignal.timeout(15_000));
      }
    }
    order = await wait(() => client.getOrder(order), ["ready", "valid"]);
    if (order.status !== "valid") {
      order = await client.finalizeOrder(order, csr);
      order = await wait(() => client.getOrder(order), ["valid"]);
    }
    const certificate = await client.getCertificate(order);
    if (typeof certificate !== "string" || Buffer.byteLength(certificate) > 65_536)
      throw new Error("Invalid ACME certificate response");
    return certificate;
  });
}

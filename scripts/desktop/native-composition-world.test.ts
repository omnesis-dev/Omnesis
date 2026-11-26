// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import { connect } from "node:net";
import { Resolver } from "node:dns/promises";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import { FlattenedSign } from "jose";
import * as acme from "acme-client";
import { afterEach, expect, test } from "vitest";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import {
  localAcmeAuthority,
  fixtureSubjectAlternativeName,
} from "../../packages/cloud-relay/test/acme-authority.js";
import { issueAcmeCertificate } from "../../packages/cloud-relay/src/acme-client.js";
import { createNativeCompositionWorld } from "./native-composition-world.js";

const roots: string[] = [];
const retainedRoots = new Set<string>();
const posixTest = test.skipIf(process.platform === "win32");
const worlds: Awaited<ReturnType<typeof createNativeCompositionWorld>>[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(worlds.map((world) => world.close()));
  const failed = results.find((result) => result.status === "rejected");
  // Preserve owned files and evidence until every physical service closure is confirmed.
  if (failed?.status === "rejected") throw failed.reason;
  worlds.splice(0);
  for (const root of roots.splice(0))
    if (!retainedRoots.has(root)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "omnesis-native-world-"));
  roots.push(path);
  return path;
}
async function world(observe?: Parameters<typeof createNativeCompositionWorld>[2], root?: string) {
  const controller = new AbortController();
  root ??= await directory();
  try {
    const instance = await createNativeCompositionWorld(root, controller.signal, observe);
    worlds.push(instance);
    return { instance, controller };
  } catch (error) {
    if (ownedProcessCleanupReceipt(error)) retainedRoots.add(root);
    throw error;
  }
}
function relayRead(origin: string, ca: string, family?: 4) {
  return new Promise<{ status: number; body: string }>((done, reject) => {
    const client = request(
      new URL("/healthz", origin),
      {
        ca,
        timeout: 3000,
        ...(family === undefined ? {} : { family }),
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        },
      },
      (response) => {
        let body = "";
        response.on("data", (part) => {
          body += part.toString();
          if (body.length > 16384) client.destroy(new Error("QA response exceeds bound"));
        });
        response.once("end", () => done({ status: response.statusCode!, body }));
        response.once("error", reject);
      },
    );
    client.once("timeout", () => client.destroy(new Error("QA TLS timeout")));
    client.once("error", reject);
    client.end();
  });
}

async function expectListenerRefused(origin: string) {
  const outcome = await new Promise<{ connected: boolean; code?: string }>((done) => {
    let connected = false;
    let code: string | undefined;
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(origin).port) });
    socket.setTimeout(3000);
    socket.once("connect", () => {
      connected = true;
      socket.destroy();
    });
    socket.once("timeout", () => {
      code = "PROBE_TIMEOUT";
      socket.destroy();
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      code = error.code;
    });
    socket.once("close", () => done({ connected, code }));
  });
  expect(outcome).toEqual({ connected: false, code: "ECONNREFUSED" });
}

posixTest(
  "actual TLS relay and guest-local DNS/model use explicit trust without global overrides",
  async () => {
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const previousOptions = process.env.NODE_OPTIONS;
    const { instance } = await world();
    expect((await relayRead(instance.resource.relayOrigin, instance.trust.relayCa)).status).toBe(
      200,
    );
    expect((await relayRead(instance.resource.relayOrigin, instance.trust.relayCa, 4)).status).toBe(
      200,
    );
    await expect(relayRead(instance.resource.relayOrigin, instance.trust.acmeCa)).rejects.toThrow();
    const resolver = new Resolver({ timeout: 1000, tries: 1 });
    resolver.setServers([`127.0.0.1:${instance.trust.dnsPort}`]);
    expect(await resolver.resolve4("relay.example.test")).toEqual(["127.0.0.1"]);
    const models = await fetch(instance.resource.modelOrigin + "/v1/models");
    expect(await models.json()).toMatchObject({ data: [{ id: instance.resource.modelId }] });
    const turn = await fetch(instance.resource.modelOrigin + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: instance.resource.modelId,
        messages: [{ role: "user", content: "Fixture check" }],
        stream: true,
      }),
    });
    expect(await turn.text()).toContain("data: [DONE]");
    expect(instance.evidence.scriptedRequests()).toBe(1);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(previousTls);
    expect(process.env.NODE_OPTIONS).toBe(previousOptions);
    expect(instance.evidence.productionDnsQueries.size).toBe(0);
  },
  30000,
);

posixTest(
  "actual RFC8555 JWS, DNS challenge and CSR yield a verifiable named certificate",
  async () => {
    const { instance } = await world();
    const hostname = "g-abcdefgh.relay.example.test";
    instance.expectGatewayHostname(hostname);
    expect(() => instance.expectGatewayHostname("g-ijklmnop.relay.example.test")).toThrow();
    const invalidJws = await fetch(new URL("/account", instance.resource.acmeDirectoryUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(invalidJws.status).toBe(400);
    const base = instance.services.dnsApiOrigin;
    const records = `${base}/client/v4/zones/${"a".repeat(32)}/dns_records`;
    const headers = {
      authorization: `Bearer ${instance.services.dnsToken}`,
      "content-type": "application/json",
    };
    const certificate = await issueAcmeCertificate({
      directoryUrl: instance.resource.acmeDirectoryUrl,
      hostname,
      accountKey: String(
        generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
      ),
      tlsKey: String(await acme.crypto.createPrivateKey()),
      signal: AbortSignal.timeout(15000),
      presenter: {
        async create(value) {
          const response = await fetch(records, {
            method: "POST",
            headers,
            body: JSON.stringify({
              type: "TXT",
              name: `_acme-challenge.${hostname}`,
              content: value,
            }),
          });
          expect(response.status).toBe(200);
          const result = (await response.json()) as { result: { id: string } };
          return { id: result.result.id };
        },
        async remove(id) {
          expect((await fetch(records + "/" + id, { method: "DELETE", headers })).status).toBe(200);
        },
      },
      async lookup(name, value) {
        const response = await fetch(
          base + "/txt?name=" + encodeURIComponent(`_acme-challenge.${name}`),
        );
        return ((await response.json()) as string[][]).some((parts) => parts.join("") === value);
      },
      caaLookup: () => Promise.resolve(undefined),
    });
    const leaf = new X509Certificate(certificate),
      root = new X509Certificate(instance.trust.acmeCa);
    expect(leaf.verify(root.publicKey)).toBe(true);
    expect(leaf.checkHost(hostname)).toBe(hostname);
    expect(leaf.subjectAltName).toBe(`DNS:${hostname}`);
    // Presence of the actual fixture SCT extension, not a claim of public logging.
    expect(leaf.raw.includes(Buffer.from("060a2b06010401d679020402", "hex"))).toBe(true);
    expect(instance.evidence.acmeRequests).toContain("/finalize");
    expect(
      await (
        await fetch(base + "/txt?name=" + encodeURIComponent(`_acme-challenge.${hostname}`))
      ).json(),
    ).toEqual([]);
  },
  30000,
);

posixTest(
  "cancel joins actual listeners; scope cannot be rebound or adopted on reentry",
  async () => {
    const { instance, controller } = await world();
    controller.abort();
    await instance.close();
    await instance.close();
    await expectListenerRefused(instance.resource.relayOrigin);
    await expectListenerRefused(instance.resource.modelOrigin);
    expect(() => instance.expectGatewayHostname("g-abcdefgh.relay.example.test")).toThrow();
  },
);

posixTest(
  "cancelled, nonempty and alias service directories refuse before creating listeners",
  async () => {
    const cancelled = AbortSignal.abort();
    await expect(createNativeCompositionWorld(await directory(), cancelled)).rejects.toThrow();
    const occupied = await directory();
    await writeFile(join(occupied, "foreign"), "unrelated");
    await expect(
      createNativeCompositionWorld(occupied, new AbortController().signal),
    ).rejects.toThrow("new private owned");
    const parent = await directory(),
      target = await directory(),
      alias = join(parent, "alias");
    await symlink(target, alias);
    await expect(createNativeCompositionWorld(alias, new AbortController().signal)).rejects.toThrow(
      "new private owned",
    );
  },
);

test.runIf(process.platform === "win32")(
  "guest service fixture refuses unsupported ownership before filesystem operations",
  async () => {
    await expect(
      createNativeCompositionWorld("/not-opened", new AbortController().signal),
    ).rejects.toThrow("POSIX ownership");
  },
);

posixTest(
  "constructor cleanup uncertainty preserves its own marker and directory before publication",
  async () => {
    const root = await directory();
    const observed: { resource?: { relayOrigin: string; modelOrigin: string }; closed: string[] } =
      { closed: [] };
    const error = await world(
      {
        beforeReady(resource) {
          observed.resource = resource;
          throw new Error("owned startup interruption");
        },
        afterClose(kind) {
          observed.closed.push(kind);
          // Fault metadata is injected ONLY after the genuine service close returned.
          if (kind === "relay")
            throw Object.assign(new Error("owned uncertain receipt"), {
              cleanupFailure: "owned-test-close",
            });
        },
      },
      root,
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(ownedProcessCleanupReceipt(error)?.failure).toBe("owned-test-close");
    expect(retainedRoots.has(root)).toBe(true);
    expect((await lstat(root)).isDirectory()).toBe(true);
    expect(observed.closed).toEqual(["relay", "resolver", "model", "acme", "dns"]);
    if (!observed.resource) throw new Error("Owned startup observation is missing");
    await expectListenerRefused(observed.resource.relayOrigin);
    await expectListenerRefused(observed.resource.modelOrigin);
    // This test can release its injected uncertainty only after all genuine closes were observed.
    retainedRoots.delete(root);
  },
  30000,
);

posixTest(
  "one-order ACME fixture refuses concurrent finalize before shared CSR writes",
  async () => {
    const root = await directory(),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let authority: Awaited<ReturnType<typeof localAcmeAuthority>> | undefined;
    let first: Promise<string> | undefined;
    let finalizers = 0;
    let gateTimer: ReturnType<typeof setTimeout> | undefined;
    let failure: unknown;
    let failed = false;
    try {
      const hostname = "gateway.example.test",
        dns = new Map<string, string>();
      authority = await localAcmeAuthority(root, hostname, dns, {
        beforeFinalize: async () => {
          finalizers++;
          entered.resolve();
          await release.promise;
        },
      });
      const account = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const tlsKey = String(
        generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
      );
      first = issueAcmeCertificate({
        directoryUrl: authority.directoryUrl,
        hostname,
        accountKey: String(account.privateKey.export({ type: "pkcs8", format: "pem" })),
        tlsKey,
        signal: AbortSignal.timeout(15000),
        presenter: {
          create(value) {
            dns.set("owned", value);
            return Promise.resolve({ id: "owned" });
          },
          remove(id) {
            dns.delete(id);
            return Promise.resolve();
          },
        },
        lookup: (_name, value) => Promise.resolve([...dns.values()].includes(value)),
        caaLookup: () => Promise.resolve([]),
      });
      void first.catch(() => {});
      await Promise.race([
        entered.promise,
        new Promise<never>((_, reject) => {
          gateTimer = setTimeout(
            () => reject(new Error("Owned finalize gate did not start")),
            3000,
          );
        }),
      ]);
      clearTimeout(gateTimer);
      const base = new URL(authority.directoryUrl).origin;
      const nonce = (await fetch(base + "/nonce")).headers.get("replay-nonce");
      if (!nonce) throw new Error("Actual ACME nonce is missing");
      const [, csr] = await acme.crypto.createCsr(
        { commonName: hostname, altNames: [hostname] },
        tlsKey,
      );
      const signed = await new FlattenedSign(
        Buffer.from(JSON.stringify({ csr: csr.toString("base64url") })),
      )
        .setProtectedHeader({
          alg: "ES256",
          kid: base + "/account/1",
          url: base + "/finalize",
          nonce,
        })
        .sign(account.privateKey);
      const second = await fetch(base + "/finalize", {
        method: "POST",
        headers: { "content-type": "application/jose+json" },
        body: JSON.stringify(signed),
      });
      expect(second.status).toBe(409);
      expect(finalizers).toBe(1);
      release.resolve();
      const certificate = new X509Certificate(await first);
      expect(certificate.checkHost(hostname)).toBe(hostname);
      expect(certificate.verify(new X509Certificate(authority.root).publicKey)).toBe(true);
    } catch (error) {
      if (ownedProcessCleanupReceipt(error)) retainedRoots.add(root);
      failure = error;
      failed = true;
    }
    clearTimeout(gateTimer);
    release.resolve();
    if (first) await Promise.allSettled([first]);
    try {
      await authority?.close();
    } catch (cleanupError) {
      retainedRoots.add(root);
      throw Object.assign(
        new AggregateError(
          failed ? [failure, cleanupError] : [cleanupError],
          "ACME test cleanup is unconfirmed",
          { cause: cleanupError },
        ),
        { cleanupFailure: "qa-acme-test" },
      );
    }
    if (failed) throw failure;
  },
  30000,
);

test("literal SAN validation supports existing DNS and IP callers without config injection", () => {
  expect(fixtureSubjectAlternativeName("gateway.example.test")).toBe("DNS:gateway.example.test");
  expect(fixtureSubjectAlternativeName("127.0.0.1")).toBe("IP:127.0.0.1");
  expect(fixtureSubjectAlternativeName("::1")).toBe("IP:::1");
  expect(fixtureSubjectAlternativeName("[::1]")).toBe("IP:::1");
  for (const value of [
    "gateway.example.test\nsubjectAltName=DNS:other.example.test",
    "gateway.example.test,DNS:other.example.test",
    "@section",
    "[section]",
    "example.test\rkey=value",
  ])
    expect(() => fixtureSubjectAlternativeName(value)).toThrow("hostname");
});

posixTest(
  "ACME constructor rejects hostname and extension injection before crypto/files",
  async () => {
    const root = await directory();
    for (const [name, extras] of [
      ["gateway.example.test\n[section]", []],
      ["gateway.example.test", ["1.2.3=ASN1:UTF8:literal\nsubjectAltName=DNS:other.example.test"]],
      ["gateway.example.test", ["subjectAltName=DNS:other.example.test"]],
    ] as const)
      await expect(
        localAcmeAuthority(root, name, new Map(), { leafExtensions: extras }),
      ).rejects.toThrow("Invalid fixture");
    expect(await (await import("node:fs/promises")).readdir(root)).toEqual([]);
  },
);

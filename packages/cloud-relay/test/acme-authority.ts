// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeProtectedHeader,
  importJWK,
  flattenedVerify,
  calculateJwkThumbprint,
  type JWK,
} from "jose";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import {
  runFixtureOpenSsl,
  type FixtureOpenSslOptions,
} from "../../../scripts/desktop/fixture-openssl.mjs";
import { listen, closeServer } from "./support.js";

/** Extension data stays one validated literal, never an OpenSSL configuration section. */
export function fixtureSubjectAlternativeName(value: string): string {
  if (typeof value !== "string" || !value || value.length > 253 || /[\r\n\s\0]/u.test(value))
    throw new Error("Invalid fixture certificate hostname");
  const bracketed = value.startsWith("[") || value.endsWith("]");
  const host = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (bracketed && isIP(host) !== 6) throw new Error("Invalid fixture certificate hostname");
  if (isIP(host)) return `IP:${host}`;
  if (
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/u.test(
      host,
    )
  )
    throw new Error("Invalid fixture certificate hostname");
  return `DNS:${host}`;
}

/**
 * Isolated RFC8555 fixture: verifies real JWS signatures/nonces/CSR possession, then signs through a local CA.
 * `name` may be read lazily, for a gateway whose name exists only once it configures.
 * `leafExtensions` are extra OpenSSL extension lines for issued leaves, such as an embedded SCT list.
 */
export async function localAcmeAuthority(
  directory: string,
  name: string | (() => string),
  dns: Map<string, string>,
  options: {
    leafExtensions?: readonly string[];
    beforeFinalize?: () => Promise<void>;
  } & FixtureOpenSslOptions = {},
) {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const execution = { signal, timeoutMs: options.timeoutMs };
  if (typeof name === "string") fixtureSubjectAlternativeName(name);
  const extras = [...(options.leafExtensions ?? [])];
  if (
    extras.length > 16 ||
    extras.some(
      (line) =>
        typeof line !== "string" ||
        line.length > 4096 ||
        !/^[a-zA-Z0-9][a-zA-Z0-9.]*=[^\r\n\0[\]\\]+$/u.test(line) ||
        /^subjectAltName=/iu.test(line),
    )
  )
    throw new Error("Invalid fixture certificate extensions");
  const host = () => {
    const value = typeof name === "function" ? name() : name;
    fixtureSubjectAlternativeName(value);
    return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  };
  const caKey = join(directory, "ca.key"),
    caCert = join(directory, "ca.crt");
  await runFixtureOpenSsl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-days",
      "365",
      "-subj",
      "/CN=Fictional ACME Test Authority",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    execution,
  );
  const nonces = new Set<string>();
  const requests: string[] = [];
  const payloads: string[] = [];
  let jwk: JWK | undefined,
    authorized = false,
    certificate: string | undefined;
  let identifier: string | undefined;
  let finalizing = false;
  let orderedHost: string | undefined;
  const pending = new Set<Promise<void>>();
  const cleanupFailures: unknown[] = [];
  const server = createServer((req, res) => {
    const task = (async () => {
      const nonce = randomBytes(24).toString("base64url");
      nonces.add(nonce);
      res.setHeader("replay-nonce", nonce);
      requests.push(req.url!);
      res.setHeader("content-type", "application/json");
      const send = (status: number, value: unknown) => {
        res.statusCode = status;
        res.end(JSON.stringify(value));
      };
      const order = () => ({
        status: certificate ? "valid" : authorized ? "ready" : "pending",
        identifiers: [{ type: "dns", value: host() }],
        authorizations: [`${base}/auth`],
        finalize: `${base}/finalize`,
        ...(certificate ? { certificate: `${base}/certificate` } : {}),
      });
      if (req.url === "/directory")
        return send(200, {
          newNonce: `${base}/nonce`,
          newAccount: `${base}/account`,
          newOrder: `${base}/new-order`,
        });
      if (req.url === "/nonce") {
        res.statusCode = 200;
        res.end();
        return;
      }
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      const header = decodeProtectedHeader(body);
      if (
        header.url !== `${base}${req.url}` ||
        typeof header.nonce !== "string" ||
        !nonces.delete(header.nonce)
      )
        throw new Error("Invalid ACME recipient/nonce");
      if (req.url === "/account") jwk = header.jwk;
      else if (header.kid !== `${base}/account/1`) throw new Error("Invalid ACME account");
      if (!jwk) throw new Error("Missing ACME public account key");
      const proof = await flattenedVerify(body, await importJWK(jwk, "ES256"));
      const text = Buffer.from(proof.payload).toString();
      payloads.push(text);
      const value = text ? JSON.parse(text) : undefined;
      if (req.url === "/account") {
        res.setHeader("location", `${base}/account/1`);
        return send(201, { status: "valid" });
      }
      if (req.url === "/new-order") {
        const expected = host();
        if (
          JSON.stringify(value.identifiers) !== JSON.stringify([{ type: "dns", value: expected }])
        )
          throw new Error("Wrong ACME order identifiers");
        orderedHost = expected;
        res.setHeader("location", `${base}/order`);
        return send(201, order());
      }
      if (req.url === "/order") return send(200, order());
      if (req.url === "/auth")
        return send(200, {
          identifier: { type: "dns", value: identifier ?? host() },
          status: authorized ? "valid" : "pending",
          challenges: [
            {
              type: "dns-01",
              url: `${base}/challenge`,
              status: authorized ? "valid" : "pending",
              token: "fixture-dns-token",
            },
          ],
        });
      if (req.url === "/challenge") {
        const { createHash } = await import("node:crypto");
        const expected = createHash("sha256")
          .update(`fixture-dns-token.${await calculateJwkThumbprint(jwk)}`)
          .digest("base64url");
        if (![...dns.values()].includes(expected))
          throw new Error("DNS-01 key authorization not published");
        authorized = true;
        return send(200, {
          status: "valid",
          type: "dns-01",
          url: `${base}/challenge`,
          token: "fixture-dns-token",
        });
      }
      if (req.url === "/finalize") {
        if (!authorized) throw new Error("Finalize before DNS authorization");
        if (finalizing) return send(409, { type: "urn:ietf:params:acme:error:orderNotReady" });
        if (certificate) return send(200, order());
        finalizing = true;
        try {
          await options.beforeFinalize?.();
          signal.throwIfAborted();
          const csr = join(directory, "request.der"),
            leaf = join(directory, "issued.crt"),
            extensionsFile = join(directory, "issued.ext");
          const expected = host();
          if (expected !== orderedHost) throw new Error("ACME expected recipient changed");
          await writeFile(
            extensionsFile,
            [`subjectAltName=${fixtureSubjectAlternativeName(expected)}`, ...extras].join("\n") +
              "\n",
          );
          await writeFile(csr, Buffer.from(value.csr, "base64url"));
          await runFixtureOpenSsl(
            ["req", "-inform", "DER", "-in", csr, "-verify", "-noout"],
            execution,
          );
          await runFixtureOpenSsl(
            [
              "x509",
              "-req",
              "-inform",
              "DER",
              "-in",
              csr,
              "-CA",
              caCert,
              "-CAkey",
              caKey,
              "-CAcreateserial",
              "-out",
              leaf,
              "-days",
              "90",
              "-extfile",
              extensionsFile,
            ],
            execution,
          );
          certificate = (await readFile(leaf, "utf8")) + (await readFile(caCert, "utf8"));
          return send(200, order());
        } finally {
          finalizing = false;
        }
      }
      if (req.url === "/certificate") {
        res.setHeader("content-type", "application/pem-certificate-chain");
        res.end(certificate);
        return;
      }
      send(404, {});
    })().catch((error: unknown) => {
      if (ownedProcessCleanupReceipt(error)) cleanupFailures.push(error);
      res.statusCode = 400;
      res.end('{"type":"urn:ietf:params:acme:error:malformed"}');
    });
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
  });
  const base = await listen(server);
  let closing: Promise<void> | undefined;
  return {
    directoryUrl: `${base}/directory`,
    root: await readFile(caCert, "utf8"),
    requests,
    payloads,
    setIdentifier(value: string) {
      identifier = value;
    },
    close() {
      return (closing ??= (async () => {
        controller.abort();
        try {
          await closeServer(server);
        } catch (error) {
          cleanupFailures.push(error);
        }
        const stopped = await Promise.allSettled(pending);
        for (const result of stopped)
          if (result.status === "rejected") cleanupFailures.push(result.reason);
        if (cleanupFailures.length)
          throw Object.assign(
            new AggregateError(cleanupFailures, "ACME fixture cleanup is unconfirmed"),
            { cleanupFailure: "qa-acme" },
          );
      })());
    },
  };
}

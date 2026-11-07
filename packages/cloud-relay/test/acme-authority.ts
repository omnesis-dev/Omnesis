// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeProtectedHeader,
  importJWK,
  flattenedVerify,
  calculateJwkThumbprint,
  type JWK,
} from "jose";
import { listen, closeServer } from "./support.js";

/** Isolated RFC8555 fixture: verifies real JWS signatures/nonces/CSR possession, then signs through a local CA. */
export async function localAcmeAuthority(
  directory: string,
  hostname: string,
  dns: Map<string, string>,
) {
  const caKey = join(directory, "ca.key"),
    caCert = join(directory, "ca.crt");
  execFileSync(
    "openssl",
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
    { stdio: "ignore" },
  );
  const nonces = new Set<string>();
  const requests: string[] = [];
  const payloads: string[] = [];
  let jwk: JWK | undefined,
    authorized = false,
    certificate: string | undefined;
  let identifier = hostname;
  const server = createServer((req, res) => {
    void (async () => {
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
        identifiers: [{ type: "dns", value: hostname }],
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
        if (
          JSON.stringify(value.identifiers) !== JSON.stringify([{ type: "dns", value: hostname }])
        )
          throw new Error("Wrong ACME order identifiers");
        res.setHeader("location", `${base}/order`);
        return send(201, order());
      }
      if (req.url === "/order") return send(200, order());
      if (req.url === "/auth")
        return send(200, {
          identifier: { type: "dns", value: identifier },
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
        const csr = join(directory, "request.der"),
          leaf = join(directory, "issued.crt");
        await writeFile(csr, Buffer.from(value.csr, "base64url"));
        execFileSync("openssl", ["req", "-inform", "DER", "-in", csr, "-verify", "-noout"], {
          stdio: "ignore",
        });
        execFileSync(
          "openssl",
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
            "-copy_extensions",
            "copy",
          ],
          { stdio: "ignore" },
        );
        certificate = (await readFile(leaf, "utf8")) + (await readFile(caCert, "utf8"));
        return send(200, order());
      }
      if (req.url === "/certificate") {
        res.setHeader("content-type", "application/pem-certificate-chain");
        res.end(certificate);
        return;
      }
      send(404, {});
    })().catch(() => {
      res.statusCode = 400;
      res.end('{"type":"urn:ietf:params:acme:error:malformed"}');
    });
  });
  const base = await listen(server);
  return {
    directoryUrl: `${base}/directory`,
    root: await readFile(caCert, "utf8"),
    requests,
    payloads,
    setIdentifier(value: string) {
      identifier = value;
    },
    async close() {
      await closeServer(server);
    },
  };
}

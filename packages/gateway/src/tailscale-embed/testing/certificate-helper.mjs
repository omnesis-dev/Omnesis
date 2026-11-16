// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Physical helper fixture: validate the actual TLS pair through the same PEM
// boundary as Go's file loader, or the parent's certificate bootstrap frame.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createSecureContext } from "node:tls";
import { X509Certificate, createPrivateKey } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(`-${name}`) + 1];
const record = process.env.OMNESIS_FAKE_TAILNET_CERT_RECORD;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
function accept(certificate, from) {
  try {
    if (typeof certificate?.cert !== "string" || typeof certificate?.key !== "string")
      throw new Error("Missing certificate pair");
    const leaf = new X509Certificate(certificate.cert);
    if (!leaf.checkPrivateKey(createPrivateKey(certificate.key)))
      throw new Error("Mismatched certificate pair");
    createSecureContext(certificate);
    writeFileSync(
      record,
      JSON.stringify({
        fingerprint: leaf.fingerprint256.replaceAll(":", "").toLowerCase(),
        from,
      }),
    );
    emit({
      type: "status",
      protocol: Number(process.env.OMNESIS_FAKE_TAILNET_PROTOCOL),
      backend: "running",
      node: { dnsName: "gateway.example.test", hostName: "gateway", ips: [] },
      certificate: { source: "gateway", reason: "https-disabled" },
      public: { state: "off" },
    });
  } catch {
    emit({ type: "fatal", message: "The gateway certificate could not be loaded" });
    process.exit(2);
  }
}
const lines = createInterface({ input: process.stdin });
let bootstrapped = !args.includes("-certificate-bootstrap");
lines.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    process.exit(2);
  }
  if (command.type === "gateway-certificate") {
    accept(command.certificate, "bootstrap");
    bootstrapped = true;
  } else if (!bootstrapped) {
    emit({ type: "fatal", message: "The first command must provide the gateway certificate" });
    process.exit(2);
  }
});
lines.on("close", () => process.exit(0));
if (bootstrapped) {
  try {
    accept(
      {
        cert: readFileSync(flag("fallback-cert"), "utf8"),
        key: readFileSync(flag("fallback-key"), "utf8"),
      },
      "file",
    );
  } catch {
    emit({ type: "fatal", message: "The gateway certificate files could not be read" });
    process.exit(2);
  }
}

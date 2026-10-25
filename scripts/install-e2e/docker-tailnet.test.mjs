// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as tlsServer } from "node:tls";
import { createServer as httpServer } from "node:http";
import { X509Certificate } from "node:crypto";
import { parse } from "yaml";
import {
  compareNativeRestart,
  comparePersistence,
  projectSnapshot,
  verifyPeer,
  verifyRefusals,
  productPairRefusals,
  revokeUnusedCode,
} from "./docker-tailnet-probe.mjs";

import { inspectIdentity } from "./docker-tailnet-identity.mjs";

const root = new URL("../../", import.meta.url);
const text = (path) => readFileSync(new URL(path, root), "utf8");
const clone = (value) => structuredClone(value);
const health = { status: "ok", version: "0.6.0" };
const status = { documents: { total: 3 } };
const roster = {
  items: [
    {
      id: "fictional-device",
      name: "fixture-mac",
      kind: "collector",
      online: true,
      version: "0.6.0",
    },
  ],
};
const documents = { results: [{ id: "fictional-document", title: "Harbor lantern checklist" }] };
const expected = { version: "0.6.0", title: "Harbor lantern checklist" };

describe("Docker/native persisted identities", () => {
  it("requires actual healthy version, exactly one live device and the complete invented vault", () => {
    const snapshot = projectSnapshot(health, status, roster, documents, expected);
    comparePersistence(snapshot, clone(snapshot));
    for (const mutation of [
      (b) => {
        b[0].status = "error";
      },
      (b) => {
        b[0].version = "other";
      },
      (b) => {
        b[1].documents.total = 0;
      },
      (b) => {
        b[1].documents.total = 4;
      },
      (b) => {
        b[2].items = [];
      },
      (b) => {
        b[2].items.push(clone(b[2].items[0]));
      },
      (b) => {
        b[2].items[0].online = false;
      },
      (b) => {
        b[2].items[0].version = "other";
      },
      (b) => {
        b[3].results[0].id = "";
      },
      (b) => {
        b[3].results = [];
      },
    ]) {
      const data = clone([health, status, roster, documents]);
      mutation(data);
      expect(() => projectSnapshot(...data, expected)).toThrow();
    }
    for (const change of [
      { collectorId: "replacement" },
      { documentId: "replacement" },
      { documentTotal: 4 },
    ])
      expect(() => comparePersistence(snapshot, { ...snapshot, ...change })).toThrow();
  });
  it("requires a changed real native PID and fresh authentication with the same credential", () => {
    const before = { items: [{ component: "collector", state: "running", pid: 123 }] };
    const after = { items: [{ component: "collector", state: "running", pid: 124 }] };
    const pairing = {
      state: "paired",
      deviceName: "fixture-mac",
      gatewayUrl: "https://gateway.example.test",
      tokenFingerprint: "a".repeat(16),
      lastAuthenticatedAt: 1,
    };
    compareNativeRestart(before, after, pairing, { ...pairing, lastAuthenticatedAt: 2 });
    for (const change of [
      { state: "needs-pairing" },
      { tokenFingerprint: "b".repeat(16) },
      { gatewayUrl: "https://other.example.test" },
      { lastAuthenticatedAt: 1 },
    ])
      expect(() =>
        compareNativeRestart(before, after, pairing, {
          ...pairing,
          lastAuthenticatedAt: 2,
          ...change,
        }),
      ).toThrow();
    for (const service of [
      before,
      { items: [] },
      { items: [{ component: "collector", state: "running", pid: 0 }] },
    ])
      expect(() =>
        compareNativeRestart(before, service, pairing, { ...pairing, lastAuthenticatedAt: 2 }),
      ).toThrow();
  });
});

describe("real TLS CA, hostname and additional pin", () => {
  const scratch = mkdtempSync(join(tmpdir(), "docker-tailnet-tls-"));
  let server, url, ca, fingerprint;
  beforeAll(async () => {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-keyout",
        join(scratch, "key.pem"),
        "-out",
        join(scratch, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    ca = readFileSync(join(scratch, "cert.pem"));
    fingerprint =
      "sha256:" + new X509Certificate(ca).fingerprint256.replaceAll(":", "").toLowerCase();
    server = tlsServer({ cert: ca, key: readFileSync(join(scratch, "key.pem")) }, (socket) =>
      socket.on("error", () => {}),
    );
    server.on("tlsClientError", () => {});
    await new Promise((done) => server.listen(0, done));
    url = `https://localhost:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise((done) => server.close(done));
    rmSync(scratch, { recursive: true, force: true });
  });
  it("accepts only the correct CA and pin; a wrong pin is a specific assertion refusal", async () => {
    await verifyPeer(url, fingerprint, { ca });
    await expect(verifyPeer(url, "sha256:" + "0".repeat(64), { ca })).rejects.toThrow(
      "gateway certificate pin",
    );
    await expect(verifyPeer(url, fingerprint)).rejects.toThrow();
    await expect(
      verifyPeer(url.replace("localhost", "127.0.0.1"), fingerprint, { ca }),
    ).rejects.toThrow();
  });
  it("bounds database reads and validates the actual wrapped identity files", () => {
    const config = join(scratch, "identity");
    mkdirSync(join(config, "keyring/storage-keys"), { recursive: true });
    const token = {
      omnesis: "omnesis.secret-file",
      version: 1,
      alg: "aes-256-gcm",
      scope: "config:token",
      ciphertext: "invented-ciphertext",
    };
    const key = {
      omnesis: "omnesis.storage-key",
      version: 1,
      alg: "aes-256-gcm",
      keyName: "main-db",
      ciphertext: "invented-wrapped-key",
    };
    writeFileSync(join(config, "token"), JSON.stringify(token));
    writeFileSync(join(config, "keyring/storage-keys/main-db.json"), JSON.stringify(key));
    writeFileSync(join(config, "omnesis.db"), Buffer.alloc(32, 123));
    const proof = inspectIdentity(config, join(scratch, "cert.pem"), fingerprint);
    expect(proof.pin).toBe(fingerprint);
    expect(JSON.stringify(proof)).not.toContain("invented-ciphertext");
    writeFileSync(join(config, "omnesis.db"), "SQLite format 3\0plaintext");
    expect(() => inspectIdentity(config, join(scratch, "cert.pem"), fingerprint)).toThrow(
      "database encrypted",
    );
    writeFileSync(join(config, "omnesis.db"), Buffer.alloc(32, 123));
    writeFileSync(
      join(config, "keyring/storage-keys/main-db.json"),
      JSON.stringify({ ...key, omnesis: "plaintext" }),
    );
    expect(() => inspectIdentity(config, join(scratch, "cert.pem"), fingerprint)).toThrow();
    writeFileSync(join(config, "keyring/storage-keys/main-db.json"), JSON.stringify(key));
    for (const raw of [
      "FICTIONAL_SECRET_CANARY_not_json",
      JSON.stringify({ ...token, omnesis: "FICTIONAL_SECRET_CANARY" }),
    ]) {
      writeFileSync(join(config, "token"), raw);
      let caught;
      try {
        inspectIdentity(config, join(scratch, "cert.pem"), fingerprint);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught.stack)).not.toContain("FICTIONAL_SECRET_CANARY");
    }
    writeFileSync(join(config, "token"), "x".repeat(65537));
    expect(() => inspectIdentity(config, join(scratch, "cert.pem"), fingerprint)).toThrow(
      "bounded identity",
    );
  });
});

describe("real unauthenticated and invalid-code controls", () => {
  it("requires both actual HTTP refusal statuses and the product pairing refusal reason", async () => {
    let adminStatus = 401,
      pairingStatus = 400,
      reason = "invalid or expired pairing code";
    const requests = [];
    const server = httpServer((request, response) => {
      requests.push(request.url);
      response.setHeader("Content-Type", "application/json");
      response.statusCode = request.url === "/admin/devices" ? adminStatus : pairingStatus;
      response.end(JSON.stringify({ error: reason }));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      await verifyRefusals(url);
      expect(requests).toEqual(["/admin/devices", "/devices/pair"]);
      adminStatus = 200;
      await expect(verifyRefusals(url)).rejects.toThrow();
      adminStatus = 401;
      pairingStatus = 200;
      await expect(verifyRefusals(url)).rejects.toThrow();
      pairingStatus = 400;
      reason = "unrelated validation error";
      await expect(verifyRefusals(url)).rejects.toThrow();
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

describe("actual product CLI negative-control invocation", () => {
  it("isolates both config directories, requires specific refusals, and rejects saved credentials", () => {
    const scratch = mkdtempSync(join(tmpdir(), "t3-product-negative-"));
    const cli = join(scratch, "omnesis"),
      behavior = join(scratch, "behavior"),
      audit = join(scratch, "audit");
    writeFileSync(behavior, "refuse");
    writeFileSync(
      cli,
      `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2),behavior=fs.readFileSync(${JSON.stringify(behavior)},'utf8');
if(args[0]!=='pair'||process.env.OMNESIS_SECRET_STORE!=='file')process.exit(9);
fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({args,config:process.env.OMNESIS_CONFIG_DIR})+'\\n');
const wrongPin=args[args.indexOf('--trust-fingerprint')+1].endsWith('0'.repeat(64));
if(behavior==='success')process.exit(0);
if(behavior==='artifact')fs.writeFileSync(args[args.indexOf('--save')+1],'must-not-be-saved');
console.error(behavior==='unrelated'?'unsupported flag':wrongPin?'certificate fingerprint mismatch':'Invalid or expired pairing code');process.exit(1);
`,
      { mode: 0o700 },
    );
    const options = {
      cli,
      root: join(scratch, "configs"),
      url: "https://gateway.example.test",
      fingerprint: "sha256:" + "a".repeat(64),
      code: "ABCDEF0123",
    };
    try {
      productPairRefusals(options);
      const calls = readFileSync(audit, "utf8").trim().split("\n").map(JSON.parse);
      expect(calls).toHaveLength(2);
      expect(calls[0].config).not.toBe(calls[1].config);
      expect(calls[0].args.slice(0, 2)).toEqual(["pair", "ABCDEF0123"]);
      expect(calls[1].args.slice(0, 2)).toEqual(["pair", "0000000000"]);
      for (const mode of ["success", "unrelated", "artifact"]) {
        writeFileSync(behavior, mode);
        expect(() => productPairRefusals(options)).toThrow();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  it("proves the wrong-pin code remains unused via actual successful revocation", async () => {
    let revoked = true;
    const server = httpServer((request, response) => {
      expect(request.method).toBe("DELETE");
      expect(request.url).toBe("/admin/devices/pair");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ revoked }));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      await revokeUnusedCode(url, "fictional-token", "ABCDEF0123");
      revoked = false;
      await expect(revokeUnusedCode(url, "fictional-token", "ABCDEF0123")).rejects.toThrow(
        "did not consume",
      );
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

describe("T3 workflow and owned lifecycle contracts", () => {
  const workflow = parse(text(".github/workflows/install-e2e.yml"));
  it("extends both guarded paired matrices without changing T1/T2 modes or publishing images", () => {
    const gateway = workflow.jobs["tailnet-gateway"],
      collector = workflow.jobs["tailnet-collector"];
    for (const job of [gateway, collector]) {
      expect(job.strategy.matrix.include.map((row) => [row.lane, row.mode, row.fixture])).toEqual([
        ["T1", "fresh", "fresh"],
        ["T2", "upgrade", "upgrade"],
        ["T3", "docker", "fresh"],
      ]);
      expect(job.environment).toBe("tailnet-e2e");
      expect(job.needs).toBe("tailnet-fixture");
      expect(job.env.NODE_NAME).toContain("matrix.node");
    }
    expect(workflow.jobs["tailnet-plan"].if).toContain("schedule");
    expect(workflow.jobs["tailnet-plan"].steps[0].run).toContain("refs/heads/main");
    expect(workflow.jobs["tailnet-plan"].steps[0].run).toContain("refs/tags/v*");
    const script = text("scripts/install-e2e/docker-tailnet-gateway.sh");
    expect(script).toContain("docker build --target gateway-runtime");
    expect(script).not.toMatch(/docker (?:push|login)|ghcr\.io/);
    expect(script).toContain("GITHUB_ACTIONS");
  });
  it("tracks helper/runtime ownership before failures and bounds exact resource cleanup", () => {
    const script = text("scripts/install-e2e/docker-tailnet-gateway.sh");
    expect(script).toContain('docker ps -aq --filter "label=$LABEL"');
    expect(script).toContain('docker volume create --label "$LABEL"');
    expect(script.match(/docker run --rm --label/g)).toHaveLength(2);
    expect(script).toContain('timeout 30 docker rm -f "$id"');
    expect(script).not.toMatch(/docker (?:system|volume|image) prune|pkill|killall/);
    expect(script).toContain('cmp "$E2E_WORK/identity-before" "$E2E_WORK/identity-after"');
    expect(script).toContain('docker stop --time 60 "$NAME"');
  });
  it("keeps a single native profile branch and captures authentication before acknowledging restart", () => {
    const collector = text("scripts/install-e2e/tailnet-collector.sh");
    expect(collector).toContain("fresh|docker) INSTALL_SH=");
    expect(collector).toContain('[ "$MODE" != upgrade ] || set -- "$@" --version');
    expect(collector).toContain(
      'if [ "$MODE" = docker ]; then docker_native_negatives; docker_native_restart; fi',
    );
    const lifecycle = text("scripts/install-e2e/docker-tailnet-collector.sh");
    expect(lifecycle.indexOf('prior="$(json_get')).toBeLessThan(
      lifecycle.indexOf("--key collector-restarted"),
    );
    expect(lifecycle).toContain('"$OMNESIS" service restart collector');
    expect(lifecycle).toContain("timeout:20000");
    expect(lifecycle).not.toContain("--first-use");
  });
});

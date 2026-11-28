// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Guest-local real services. This module never provisions an OS, trust store or resolver. */
import { randomBytes, randomUUID, generateKeyPairSync, createHash } from "node:crypto";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { startRelayDaemon } from "@omnesis/cloud-relay/runtime";
import { localAcmeAuthority } from "../../packages/cloud-relay/test/acme-authority.js";
import { createTestPki, SCT_EXTENSION_LINE } from "../../packages/collector/src/e2e/fixture-pki.js";
import { startDesktopAccountDns } from "../../packages/collector/src/e2e/desktop-account-dns.js";

const HOST = "relay.example.test";
const MODEL = "fictional-native-model";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function body(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 65536) throw new Error("QA request exceeds bound");
    parts.push(Buffer.from(part));
  }
  return JSON.parse(Buffer.concat(parts).toString());
}
async function listen(server: Server): Promise<string> {
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}
async function relayPorts(): Promise<[number, number]> {
  const held = [createTcpServer(), createTcpServer()];
  try {
    const ports: number[] = [];
    for (const server of held) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      ports.push((server.address() as AddressInfo).port);
    }
    if (ports[0] === ports[1]) throw new Error("QA relay ports must differ");
    return [ports[0]!, ports[1]!];
  } finally {
    await Promise.all(
      held
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise<void>((done, reject) =>
              server.close((error) => (error ? reject(error) : done())),
            ),
        ),
    );
  }
}

/** The local DNS provider is the external-service boundary, not a relay/account substitute. */
async function dnsApi(values: Map<string, string>, token: string) {
  type Record = { id: string; name: string; type: "TXT" | "CAA"; content: string; data?: unknown };
  const records = new Map<string, Record>();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const send = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const selected = [...records.values()].filter(
        (record) => record.name === url.searchParams.get("name"),
      );
      if (request.method === "GET" && url.pathname === "/txt")
        return send(selected.filter((r) => r.type === "TXT").map((r) => [r.content]));
      if (request.method === "GET" && url.pathname === "/caa")
        return send(
          selected
            .filter((r) => r.type === "CAA")
            .map((r) => {
              const data = r.data as { flags: number; tag: string; value: string };
              return { critical: data.flags, [data.tag]: data.value };
            }),
        );
      const match = /^\/client\/v4\/zones\/[a-f0-9]{32}\/dns_records(?:\/([a-f0-9]{32}))?$/u.exec(
        url.pathname,
      );
      if (!match || request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === "POST" && !match[1]) {
        const input = (await body(request)) as Partial<Record>;
        if (
          records.size >= 32 ||
          typeof input.name !== "string" ||
          !/^(?:_acme-challenge\.)?g-[a-z2-7]{8}\.relay\.example\.test$/u.test(input.name) ||
          !["TXT", "CAA"].includes(input.type ?? "") ||
          typeof input.content !== "string" ||
          input.content.length > 2048
        )
          throw new Error("Invalid fixture DNS record");
        const id = randomBytes(16).toString("hex");
        const record = { ...input, id } as Record;
        records.set(id, record);
        if (record.type === "TXT") values.set(id, record.content);
        return send({ success: true, result: record });
      }
      if (request.method === "DELETE" && match[1]) {
        records.delete(match[1]);
        values.delete(match[1]);
        return send({ success: true, result: { id: match[1] } });
      }
      if (request.method === "GET")
        return send({
          success: true,
          result: [...records.values()].filter(
            (r) => !url.searchParams.get("name") || r.name === url.searchParams.get("name"),
          ),
          result_info: { total_pages: 1 },
        });
      response.writeHead(405);
      response.end();
    })().catch(() => {
      response.writeHead(400);
      response.end();
    });
  });
  return { url: await listen(server), close: () => closeServer(server) };
}

async function scriptedModel() {
  let requests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const send = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "GET" && request.url === "/v1/models")
        return send({
          object: "list",
          data: [{ id: MODEL, object: "model", owned_by: "fixture" }],
        });
      if (request.method !== "POST" || request.url !== "/v1/chat/completions" || ++requests > 64) {
        response.writeHead(404);
        response.end();
        return;
      }
      const input = (await body(request)) as {
        model?: unknown;
        messages?: unknown;
        stream?: unknown;
      };
      if (input.model !== MODEL || !Array.isArray(input.messages))
        throw new Error("Invalid scripted turn");
      const message = "The scripted fixture received this request.";
      if (input.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "qa-turn",
            object: "chat.completion.chunk",
            model: MODEL,
            choices: [
              { index: 0, delta: { role: "assistant", content: message }, finish_reason: null },
            ],
          })}\n\n` +
            `data: ${JSON.stringify({
              id: "qa-turn",
              object: "chat.completion.chunk",
              model: MODEL,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`,
        );
      } else
        send({
          id: "qa-turn",
          object: "chat.completion",
          model: MODEL,
          choices: [
            { index: 0, message: { role: "assistant", content: message }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
    })().catch(() => {
      response.writeHead(400);
      response.end();
    });
  });
  return {
    origin: await listen(server),
    requests: () => requests,
    close: () => closeServer(server),
  };
}

interface WorldObserver {
  beforeReady?(resource: { relayOrigin: string; modelOrigin: string }): void;
  afterClose?(resource: "dns" | "acme" | "model" | "resolver" | "relay"): void;
}

export async function createNativeCompositionWorld(
  directory: string,
  signal: AbortSignal,
  observe?: WorldObserver,
) {
  signal.throwIfAborted();
  if (typeof process.getuid !== "function")
    throw new Error("QA services require POSIX ownership checks");
  const uid = process.getuid();
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(directory)) !== resolve(directory) ||
    (await readdir(directory)).length
  )
    throw new Error("QA services require a new private owned directory");
  const cleanup: (() => Promise<void>)[] = [];
  const own = (
    kind: Parameters<NonNullable<WorldObserver["afterClose"]>>[0],
    operation: () => Promise<void>,
  ) => {
    cleanup.push(async () => {
      await operation();
      observe?.afterClose?.(kind);
    });
  };
  let closing: Promise<void> | undefined;
  const abort = () => {
    void close().catch(() => {});
  };
  const close = () =>
    (closing ??= (async () => {
      signal.removeEventListener("abort", abort);
      const failures: unknown[] = [];
      for (const operation of [...cleanup].reverse()) {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw Object.assign(
          new AggregateError(failures, "QA service cleanup failed", { cause: failures[0] }),
          { cleanupFailure: ownedProcessCleanupReceipt(failures[0])?.failure ?? "qa-services" },
        );
    })());
  let gatewayHostname: string | undefined;
  const runId = randomUUID();
  try {
    const pki = await createTestPki(join(directory, "relay-pki"), "qa", { signal });
    signal.throwIfAborted();
    const leaf = await pki.leaf("relay", [HOST], { sct: true });
    const values = new Map<string, string>();
    const dnsToken = randomBytes(32).toString("base64url");
    const dns = await dnsApi(values, dnsToken);
    own("dns", dns.close);
    signal.throwIfAborted();
    await mkdir(join(directory, "acme"), { mode: 0o700 });
    const acme = await localAcmeAuthority(
      join(directory, "acme"),
      () => {
        if (!gatewayHostname) throw new Error("Actual gateway hostname has not been observed");
        return gatewayHostname;
      },
      values,
      { leafExtensions: [SCT_EXTENSION_LINE], signal },
    );
    own("acme", () => acme.close());
    signal.throwIfAborted();
    const model = await scriptedModel();
    own("model", model.close);
    signal.throwIfAborted();
    const resolver = await startDesktopAccountDns(dns.url);
    own("resolver", resolver.close);
    signal.throwIfAborted();
    const [port, dataPort] = await relayPorts();
    const relayOrigin = `https://${HOST}:${port}`;
    await writeFile(join(directory, "session.key"), randomBytes(32), { mode: 0o600 });
    await writeFile(
      join(directory, "account.key"),
      generateKeyPairSync("ed25519").privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
      { mode: 0o600 },
    );
    await writeFile(join(directory, "dns-token.json"), JSON.stringify({ token: dnsToken }), {
      mode: 0o600,
    });
    signal.throwIfAborted();
    const relay = await startRelayDaemon({
      OMNESIS_CLOUD_RELAY_BIND: "127.0.0.1",
      OMNESIS_CLOUD_RELAY_PORT: String(port),
      OMNESIS_CLOUD_RELAY_DATA_PORT: String(dataPort),
      OMNESIS_CLOUD_RELAY_PUBLIC_DATA_PORT: String(dataPort),
      OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: relayOrigin,
      OMNESIS_CLOUD_RELAY_DOMAIN: HOST,
      OMNESIS_CLOUD_RELAY_DB: join(directory, "relay.db"),
      OMNESIS_CLOUD_RELAY_KEY_FILE: join(directory, "session.key"),
      OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE: join(directory, "account.key"),
      OMNESIS_CLOUD_RELAY_TLS_CERT_FILE: leaf.certFile,
      OMNESIS_CLOUD_RELAY_TLS_KEY_FILE: leaf.keyFile,
      OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: "open",
      OMNESIS_SYNTHETIC: "1",
      OMNESIS_CLOUD_RELAY_ACME_ZONE_ID: "a".repeat(32),
      OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME: HOST,
      OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE: join(directory, "dns-token.json"),
      OMNESIS_CLOUD_RELAY_ACME_JOURNAL: join(directory, "dns-journal.json"),
      OMNESIS_CLOUD_RELAY_ACME_DNS_API_URL: dns.url + "/client/v4",
    });
    own("relay", () => relay.close());
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    observe?.beforeReady?.({ relayOrigin, modelOrigin: model.origin });
    return {
      resource: Object.freeze({
        format: 1,
        kind: "omnesis-native-composition",
        runId,
        relayOrigin,
        acmeDirectoryUrl: acme.directoryUrl,
        caSha256: sha(acme.root),
        modelOrigin: model.origin,
        modelId: MODEL,
      }),
      trust: { relayCa: pki.caCert, acmeCa: acme.root, dnsPort: resolver.port },
      services: { dnsApiOrigin: dns.url, dnsToken, relayDataPort: relay.dataPort },
      evidence: {
        acmeRequests: acme.requests,
        productionDnsQueries: resolver.productionQueries,
        scriptedRequests: model.requests,
      },
      expectGatewayHostname(hostname: string) {
        signal.throwIfAborted();
        if (
          closing ||
          !/^g-[a-z2-7]{8}\.relay\.example\.test$/u.test(hostname) ||
          (gatewayHostname && gatewayHostname !== hostname)
        )
          throw new Error("QA gateway identity cannot be changed");
        gatewayHostname = hostname;
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw Object.assign(
        new AggregateError([error, cleanupError], "QA startup and cleanup failed", {
          cause: cleanupError,
        }),
        { cleanupFailure: ownedProcessCleanupReceipt(cleanupError)?.failure ?? "qa-services" },
      );
    }
    throw error;
  }
}

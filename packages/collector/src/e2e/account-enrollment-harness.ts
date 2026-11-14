// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Real processes for sign-in device enrollment (docs/device-enrollment.md):
 * a relay daemon serving HTTPS and account sign-in on a public-looking origin,
 * gateways registered on it and tunnelled through its TLS passthrough port,
 * and a headless Chromium with a virtual passkey authenticator.
 *
 * Nothing in the product is substituted. The only test seams are local to
 * this file: a fixture certificate authority the clients are told to trust
 * (`NODE_EXTRA_CA_CERTS`, `OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE`), a resolver
 * that answers `*.example.test` with the loopback address, and a launcher
 * that refuses to open a desktop browser so the printed connect code is the
 * way in. A world created with `google: true` adds a stand-in for Google's
 * sign-in (`FakeGoogle`): the browser's visit to Google's authorization page
 * is answered by the test, and the relay's and gateways' requests to Google's
 * token and key endpoints reach a local server. Tokens are real RS256 JWTs
 * that the product verifies unchanged. Every name, certificate and account is
 * invented.
 */

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AccountEnrollmentAuthority,
  RelaySessions,
  gatewayKeyAccount,
  hostedGatewayHostname,
} from "@omnesis/cloud-relay";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright";
import { E2EHarness } from "./harness.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";

/** Credential the fake DNS API accepts; invented for this harness. */
const FIXTURE_DNS_TOKEN = "fixture-relay-dns-token";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
export const REPO_ROOT = join(import.meta.dirname, "../../../..");
export const RELAY_HOST = "relay.example.test";
export const browserAvailable = (() => {
  try {
    return require("node:fs").existsSync(chromium.executablePath()) as boolean;
  } catch {
    return false;
  }
})();

/** Passkeys need a real browser. CI must provide it; a dev box without it skips with a notice. */
export function browserSuiteAvailable(suite: string): boolean {
  if (browserAvailable) return true;
  if (process.env.CI)
    throw new Error(
      `${suite}: the Playwright chromium browser is missing; the e2e job must run \`npx playwright install chromium\``,
    );
  console.warn(`${suite}: the Playwright chromium browser is not installed — skipping.`);
  return false;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`, last ? { cause: last } : undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ── Fixture PKI ──────────────────────────────────────────────────────────────

/** The embedded SCT list extension a publicly logged leaf carries (RFC 6962 §3.3). */
export const SCT_EXTENSION_LINE = "1.3.6.1.4.1.11129.2.4.2=ASN1:FORMAT:HEX,OCTETSTRING:00000000";

export interface Leaf {
  certFile: string;
  keyFile: string;
  cert: string;
}

export interface TestPki {
  caCertFile: string;
  caCert: string;
  /** A leaf from this authority. `sct` adds the embedded SCT extension. */
  leaf(name: string, hosts: readonly string[], options?: { sct?: boolean }): Promise<Leaf>;
}

export async function createTestPki(directory: string, label: string): Promise<TestPki> {
  await mkdir(directory, { recursive: true });
  const caKeyFile = join(directory, `${label}-ca.key`),
    caCertFile = join(directory, `${label}-ca.pem`);
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKeyFile,
    "-out",
    caCertFile,
    "-days",
    "2",
    "-subj",
    `/CN=Fictional ${label} authority`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  let serial = 0;
  return {
    caCertFile,
    caCert: await readFile(caCertFile, "utf8"),
    async leaf(name, hosts, options = {}) {
      const base = join(directory, `${label}-${name}-${++serial}`);
      const keyFile = `${base}.key`,
        certFile = `${base}.pem`,
        requestFile = `${base}.csr`,
        extensionsFile = `${base}.ext`;
      await execFileAsync("openssl", [
        "req",
        "-new",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        requestFile,
        "-subj",
        `/CN=${hosts[0]}`,
      ]);
      const names = hosts
        .map((host) => (/^[0-9.]+$/.test(host) ? `IP:${host}` : `DNS:${host}`))
        .join(",");
      await writeFile(
        extensionsFile,
        [
          `subjectAltName=${names}`,
          "basicConstraints=critical,CA:FALSE",
          "keyUsage=critical,digitalSignature",
          "extendedKeyUsage=serverAuth",
          ...(options.sct ? [SCT_EXTENSION_LINE] : []),
          "",
        ].join("\n"),
      );
      await execFileAsync("openssl", [
        "x509",
        "-req",
        "-in",
        requestFile,
        "-CA",
        caCertFile,
        "-CAkey",
        caKeyFile,
        "-set_serial",
        `0x${randomBytes(8).toString("hex")}`,
        "-out",
        certFile,
        "-days",
        "1",
        "-extfile",
        extensionsFile,
      ]);
      await chmod(keyFile, 0o600);
      return { certFile, keyFile, cert: await readFile(certFile, "utf8") };
    },
  };
}

// ── Loopback names ───────────────────────────────────────────────────────────

const LOOPBACK_DNS = `
const dns = require("node:dns");
const original = dns.lookup;
const fixture = (name) => /(^|\\.)example\\.test\\.?$/i.test(String(name));
dns.lookup = function lookup(hostname, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  if (typeof options === "number") options = { family: options };
  if (!fixture(hostname)) return original.call(this, hostname, options, callback);
  if (options && options.all) return process.nextTick(callback, null, [{ address: "127.0.0.1", family: 4 }]);
  return process.nextTick(callback, null, "127.0.0.1", 4);
};
// TXT records for the fixture names come from the test's DNS fixture, as a
// resolver would serve what the relay's DNS provider published.
const resolveTxt = dns.promises.Resolver.prototype.resolveTxt;
dns.promises.Resolver.prototype.resolveTxt = async function (name) {
  const fixtureDns = process.env.OMNESIS_E2E_FIXTURE_DNS_URL;
  if (!fixtureDns || !fixture(name)) return resolveTxt.call(this, name);
  const response = await fetch(fixtureDns + "/txt?name=" + encodeURIComponent(name));
  return response.json();
};
// So do CAA records: none unless a broker published one.
const resolveCaa = dns.promises.Resolver.prototype.resolveCaa;
dns.promises.Resolver.prototype.resolveCaa = async function (name) {
  const fixtureDns = process.env.OMNESIS_E2E_FIXTURE_DNS_URL;
  if (!fixtureDns || !fixture(name)) return resolveCaa.call(this, name);
  const response = await fetch(fixtureDns + "/caa?name=" + encodeURIComponent(name));
  return response.json();
};
`;

/** Answers the fixture names with 127.0.0.1 in this test process. */
export function installLoopbackDns(): void {
  const marker = Symbol.for("omnesis.e2e.loopbackDns");
  const global = globalThis as Record<symbol, unknown>;
  if (global[marker]) return;
  global[marker] = true;
  new Function("require", LOOPBACK_DNS)(require);
}

/** A `--require` preload so spawned relays, gateways and CLIs resolve the fixture names. */
export async function writeLoopbackDnsPreload(directory: string): Promise<string> {
  const file = join(directory, "loopback-dns.cjs");
  await writeFile(file, LOOPBACK_DNS);
  return file;
}

/** A desktop launcher that opens nothing, so a CLI must print its connect code. */
export async function writeNoBrowserLauncher(directory: string): Promise<string> {
  const bin = join(directory, "no-browser-bin");
  await mkdir(bin, { recursive: true });
  const script = join(bin, "xdg-open");
  await writeFile(
    script,
    `#!/bin/sh\necho "$1" >> ${JSON.stringify(join(directory, "launches.txt"))}\nexit 1\n`,
  );
  await chmod(script, 0o755);
  return bin;
}

// ── World: PKI, preload, relay ───────────────────────────────────────────────

export interface WorldOptions {
  signupPolicy: "invitation" | "allowlist" | "open";
  /** Offer Google sign-in, answered by `FakeGoogle` (see the file comment). */
  google?: boolean;
  /** Accounts the `allowlist` policy admits. The file is re-read on every check. */
  allowlist?: { accounts?: string[]; googleSubjects?: string[] };
  /** More relay settings, applied last (for example lower per-client sign-in limits). */
  extraEnv?: NodeJS.ProcessEnv;
}

export class EnrollmentWorld {
  readonly relayPort: number;
  readonly dataPort: number;
  readonly relayOrigin: string;
  readonly relayKeyFile: string;
  readonly accountKeyFile: string;
  readonly allowlistFile: string;
  readonly logs: string[] = [];
  relay?: ChildProcess;
  /** Google's stand-in, when the world offers Google sign-in. */
  google?: FakeGoogle;
  /** DNS-01 values the relay published, by record id: what a local ACME authority checks. */
  readonly dnsRecords = new Map<string, string>();
  private dnsFixture?: { url: string; close(): Promise<void> };
  /** The fixture's stand-in for the Cloudflare API, as a DNS broker is configured with it. */
  dnsApiUrl(): string {
    return `${this.dnsFixture!.url}/client/v4`;
  }
  private relayOutput = "";
  private constructor(
    readonly directory: string,
    readonly pki: TestPki,
    readonly preload: string,
    readonly noBrowserBin: string,
    readonly relayLeaf: Leaf,
    ports: { relay: number; data: number },
    private options: WorldOptions,
  ) {
    this.relayPort = ports.relay;
    this.dataPort = ports.data;
    this.relayOrigin = `https://${RELAY_HOST}:${ports.relay}`;
    this.relayKeyFile = join(directory, "relay-session.key");
    this.accountKeyFile = join(directory, "relay-account-authority.pem");
    this.allowlistFile = join(directory, "relay-allowlist.json");
  }

  static async create(directory: string, options: WorldOptions): Promise<EnrollmentWorld> {
    installLoopbackDns();
    // As E2EHarness does for its gateways: this process reaches the fixture relay
    // over HTTPS without the fixture authority in Node's store. Device-side
    // connections pin their certificate explicitly regardless.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const pki = await createTestPki(join(directory, "pki"), "public");
    const relayLeaf = await pki.leaf("relay", [RELAY_HOST], { sct: true });
    const world = new EnrollmentWorld(
      directory,
      pki,
      await writeLoopbackDnsPreload(directory),
      await writeNoBrowserLauncher(directory),
      relayLeaf,
      { relay: await freePort(), data: await freePort() },
      options,
    );
    await writeFile(world.relayKeyFile, randomBytes(32), { mode: 0o600 });
    await writeFile(
      world.accountKeyFile,
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    await world.setAllowlist(options.allowlist ?? {});
    world.dnsFixture = await startDnsFixture(world.dnsRecords);
    if (options.google) world.google = await FakeGoogle.start(directory, pki);
    await writeFile(
      join(directory, "relay-dns-token.json"),
      JSON.stringify({ token: "fixture-relay-dns-token" }),
      { mode: 0o600 },
    );
    await world.startRelay();
    return world;
  }

  /** Environment for any spawned Node process that talks to the fixture relay and gateways. */
  clientEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const preloads = [this.preload, ...(this.google ? [this.google.preload] : [])];
    return {
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS ?? "",
        ...preloads.map((file) => `--require ${JSON.stringify(file)}`),
      ]
        .join(" ")
        .trim(),
      NODE_EXTRA_CA_CERTS: this.pki.caCertFile,
      ...(this.dnsFixture ? { OMNESIS_E2E_FIXTURE_DNS_URL: this.dnsFixture.url } : {}),
      ...(this.google ? { OMNESIS_E2E_FIXTURE_GOOGLE_URL: this.google.url } : {}),
      ...extra,
    };
  }

  /** What a relay and a gateway are configured with to accept the stand-in's Google sign-ins. */
  googleEnv(): NodeJS.ProcessEnv {
    return this.google
      ? { OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: FIXTURE_GOOGLE_CLIENT_ID }
      : {};
  }

  async setAllowlist(list: { accounts?: string[]; googleSubjects?: string[] }): Promise<void> {
    await writeFile(
      this.allowlistFile,
      JSON.stringify({ accounts: list.accounts ?? [], googleSubjects: list.googleSubjects ?? [] }),
      { mode: 0o600 },
    );
  }

  async startRelay(options: Partial<WorldOptions> = {}): Promise<void> {
    this.options = { ...this.options, ...options };
    const command = e2eTsxCommand("packages/cloud-relay/src/main.ts");
    const proc = spawn(command.command, [...command.args, "serve"], {
      cwd: REPO_ROOT,
      env: {
        ...e2eGatewayEnv(),
        ...this.clientEnv(),
        OMNESIS_CLOUD_RELAY_ENABLED: "1",
        OMNESIS_SYNTHETIC: "1",
        OMNESIS_LOG_LEVEL: "info",
        OMNESIS_CLOUD_RELAY_KEY_FILE: this.relayKeyFile,
        OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE: this.accountKeyFile,
        OMNESIS_CLOUD_RELAY_DB: join(this.directory, "relay.sqlite"),
        OMNESIS_CLOUD_RELAY_PORT: String(this.relayPort),
        OMNESIS_CLOUD_RELAY_DATA_PORT: String(this.dataPort),
        OMNESIS_CLOUD_RELAY_PUBLIC_DATA_PORT: String(this.dataPort),
        OMNESIS_CLOUD_RELAY_DOMAIN: RELAY_HOST,
        OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: this.relayOrigin,
        OMNESIS_CLOUD_RELAY_TLS_CERT_FILE: this.relayLeaf.certFile,
        OMNESIS_CLOUD_RELAY_TLS_KEY_FILE: this.relayLeaf.keyFile,
        OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: this.options.signupPolicy,
        // DNS-01 for gateway certificates, published through the fixture DNS API.
        OMNESIS_CLOUD_RELAY_ACME_ZONE_ID: "a".repeat(32),
        OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME: RELAY_HOST,
        OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE: join(this.directory, "relay-dns-token.json"),
        OMNESIS_CLOUD_RELAY_ACME_JOURNAL: join(this.directory, "relay-dns-journal"),
        OMNESIS_CLOUD_RELAY_ACME_DNS_API_URL: `${this.dnsFixture!.url}/client/v4`,
        // One loopback address stands in for every simulated person and device,
        // so the relay's global sign-in rate (an operator setting) is raised.
        OMNESIS_CLOUD_RELAY_MAX_LOGINS_PER_MINUTE: "1000",
        OMNESIS_CLOUD_RELAY_MAX_CONCURRENT_LOGINS: "32",
        // The same goes for the per-client limits, which would otherwise see one client.
        OMNESIS_CLOUD_RELAY_MAX_LOGINS_PER_MINUTE_PER_CLIENT: "1000",
        OMNESIS_CLOUD_RELAY_MAX_CONCURRENT_LOGINS_PER_CLIENT: "32",
        ...(this.options.signupPolicy === "allowlist"
          ? { OMNESIS_CLOUD_RELAY_SIGNUP_ALLOWLIST_FILE: this.allowlistFile }
          : {}),
        ...this.googleEnv(),
        ...(this.google
          ? { OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE: this.google.secretFile }
          : {}),
        ...this.options.extraEnv,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerSubprocessGroup(proc);
    this.relay = proc;
    this.relayOutput = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Relay did not become ready: ${this.relayOutput}`)),
        gatewayBootBudgetMs(),
      );
      const inspect = (chunk: Buffer): void => {
        this.relayOutput = (this.relayOutput + chunk.toString()).slice(-32_000);
        if (
          /Listening on https:\/\//.test(this.relayOutput) &&
          /TLS passthrough port/.test(this.relayOutput)
        ) {
          clearTimeout(timer);
          resolve();
        }
      };
      proc.stdout!.on("data", inspect);
      proc.stderr!.on("data", inspect);
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Relay exited ${code}: ${this.relayOutput}`));
      });
    });
  }

  relayLog(): string {
    return this.relayOutput;
  }

  async stopRelay(): Promise<void> {
    if (this.relay) await killSubprocessGroup(this.relay);
    this.relay = undefined;
  }

  /** The relay's routing-session root, which the test owns as the relay operator would. */
  async sessions(): Promise<RelaySessions> {
    return new RelaySessions(await readFile(this.relayKeyFile));
  }

  /** The relay's account attestation key: what a compromised relay could sign with. */
  async accountAuthority(): Promise<AccountEnrollmentAuthority> {
    return new AccountEnrollmentAuthority(
      this.relayOrigin,
      createPrivateKey(await readFile(this.accountKeyFile, "utf8")),
    );
  }

  async close(): Promise<void> {
    await this.stopRelay();
    await this.dnsFixture?.close();
    await this.google?.close();
  }
}

// ── Google's stand-in ────────────────────────────────────────────────────────

/** The relay's web OAuth client in the fixture world; invented. */
export const FIXTURE_GOOGLE_CLIENT_ID = "fixture-web.apps.googleusercontent.com";

/**
 * A `--require` preload that sends a process's requests for Google's token and
 * key endpoints to the stand-in. Nothing else is touched.
 */
const FAKE_GOOGLE_PRELOAD = `
const real = globalThis.fetch;
const hosts = new Set(["oauth2.googleapis.com", "www.googleapis.com"]);
globalThis.fetch = function fetch(input, init) {
  const fixture = process.env.OMNESIS_E2E_FIXTURE_GOOGLE_URL;
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!fixture || !hosts.has(url.hostname)) return real.call(this, input, init);
  const target = fixture + url.pathname + url.search;
  return real.call(this, input instanceof Request ? new Request(target, input) : target, init);
};
`;

/**
 * Google, as far as Omnesis sees it: an authorization page that signs the
 * browser in as whichever Google account the test chose and sends it back to
 * the relay's callback with a code, a token endpoint that hands the relay that
 * account's ID token for the code, and the key set the relay and gateways
 * verify tokens against. The browser reaches the authorization page through
 * its resolver rules (`browserHostRule`), the processes reach the rest
 * through the preload; nothing leaves the machine.
 */
export class FakeGoogle {
  private constructor(
    readonly url: string,
    readonly preload: string,
    readonly secretFile: string,
    /** Where the browser's requests for accounts.google.com land. */
    readonly authorizePort: number,
    /** Whom the authorization page signs in as; shared with the page's handler. */
    private readonly chosen: { person?: string },
    private readonly servers: readonly (import("node:http").Server | import("node:https").Server)[],
  ) {}

  static async start(directory: string, pki: TestPki): Promise<FakeGoogle> {
    const { createServer: createHttpServer } = await import("node:http");
    const { createServer: createHttpsServer } = await import("node:https");
    const pair = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "fixture-google-key", alg: "RS256" };
    const preload = join(directory, "fake-google.cjs");
    await writeFile(preload, FAKE_GOOGLE_PRELOAD);
    const secretFile = join(directory, "relay-google-web.json");
    await writeFile(
      secretFile,
      JSON.stringify({
        web: { client_id: FIXTURE_GOOGLE_CLIENT_ID, client_secret: "fixture-google-secret" },
      }),
      { mode: 0o600 },
    );
    const codes = new Map<string, string>();
    const chosen: { person?: string } = {};
    const api = createHttpServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://fixture.invalid");
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const send = (status: number, value: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        if (req.method === "GET" && url.pathname === "/oauth2/v3/certs")
          return send(200, { keys: [jwk] });
        if (req.method === "POST" && url.pathname === "/token") {
          const form = new URLSearchParams(Buffer.concat(chunks).toString());
          const code = form.get("code") ?? "";
          const token = codes.get(code);
          codes.delete(code);
          if (!token || form.get("client_id") !== FIXTURE_GOOGLE_CLIENT_ID)
            return send(400, { error: "invalid_grant" });
          return send(200, { id_token: token, token_type: "Bearer" });
        }
        send(404, {});
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    const leaf = await pki.leaf("google", ["accounts.google.com"]);
    const authorize = createHttpsServer(
      { cert: leaf.cert, key: await readFile(leaf.keyFile) },
      (req, res) => {
        void (async () => {
          const query = new URL(req.url ?? "/", "https://accounts.google.com").searchParams;
          const redirect = new URL(query.get("redirect_uri") ?? "");
          if (!chosen.person || !/\.example\.test$/.test(redirect.hostname))
            throw new Error("No Google account chosen for this sign-in");
          const issuedAt = Math.floor(Date.now() / 1000);
          const token = await new SignJWT({ nonce: query.get("nonce") ?? undefined })
            .setProtectedHeader({ alg: "RS256", kid: "fixture-google-key" })
            .setIssuer("https://accounts.google.com")
            .setAudience(query.get("client_id") ?? "")
            .setSubject(chosen.person)
            .setIssuedAt(issuedAt)
            .setExpirationTime(issuedAt + 3600)
            .sign(pair.privateKey);
          const code = randomBytes(24).toString("base64url");
          codes.set(code, token);
          redirect.searchParams.set("state", query.get("state") ?? "");
          redirect.searchParams.set("code", code);
          res.writeHead(303, { location: redirect.href });
          res.end();
        })().catch(() => {
          res.writeHead(400);
          res.end();
        });
      },
    );
    for (const server of [api, authorize]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    return new FakeGoogle(
      `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      preload,
      secretFile,
      (authorize.address() as AddressInfo).port,
      chosen,
      [api, authorize],
    );
  }

  /** The digest a relay lists and a gateway pins for a Google account. */
  static digest(subject: string): string {
    return sha256Hex(JSON.stringify(["https://accounts.google.com", subject]));
  }

  /** A Chromium resolver rule that sends the browser's visits to Google here. */
  browserHostRule(): string {
    return `MAP accounts.google.com 127.0.0.1:${this.authorizePort}`;
  }

  /** From now on, Google signs the browser in as `subject`. */
  signInAs(subject: string): void {
    this.chosen.person = subject;
  }

  async close(): Promise<void> {
    for (const server of this.servers)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * The DNS provider's API as the relay calls it (create, list and delete TXT
 * records in its zone), plus a TXT lookup for the resolver preload.
 */
async function startDnsFixture(values: Map<string, string>) {
  const { createServer: createHttpServer } = await import("node:http");
  const records = new Map<string, Record<string, unknown> & { name: string; content: string }>();
  const server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fixture.invalid");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const send = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === "/txt") {
        const name = url.searchParams.get("name");
        return send(
          [...records.values()]
            .filter((r) => r.name === name && r.type !== "CAA")
            .map((r) => [r.content]),
        );
      }
      if (url.pathname === "/caa") {
        const name = url.searchParams.get("name");
        return send(
          [...records.values()]
            .filter((r) => r.name === name && r.type === "CAA")
            .map((r) => {
              const data = r.data as { flags: number; tag: string; value: string };
              return { critical: data.flags, [data.tag]: data.value };
            }),
        );
      }
      const match = /^\/client\/v4\/zones\/[a-f0-9]{32}\/dns_records(?:\/([a-f0-9]{32}))?$/.exec(
        url.pathname,
      );
      if (!match || req.headers.authorization !== `Bearer ${FIXTURE_DNS_TOKEN}`) {
        res.writeHead(404);
        return res.end();
      }
      if (req.method === "POST") {
        const id = randomBytes(16).toString("hex");
        const record = { id, ...JSON.parse(Buffer.concat(chunks).toString()) };
        records.set(id, record);
        values.set(id, record.content);
        return send({ success: true, result: record });
      }
      if (req.method === "DELETE" && match[1]) {
        records.delete(match[1]);
        values.delete(match[1]);
        return send({ success: true, result: { id: match[1] } });
      }
      const name = url.searchParams.get("name");
      return send({
        success: true,
        result: [...records.values()].filter((record) => !name || record.name === name),
        result_info: { total_pages: 1 },
      });
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Gateways ─────────────────────────────────────────────────────────────────

export interface CloudRelayStatus {
  enabled: boolean;
  enrollment: { state: string };
  tunnel: { state: string };
  account: { linked: boolean; activated: boolean; lastError?: string };
  connect?: {
    state: "waiting" | "registering" | "linking" | "done" | "failed";
    connectUrl?: string;
    authorizeUrl?: string;
    code?: string;
    error?: string;
  };
  deviceEnrollment: {
    policy: "automatic" | "ask";
    trustedSignIns: Array<{
      type: string;
      id: string;
      addedAt: number;
      source?: string;
      confirmed?: boolean;
    }>;
    confirmedSignIns?: Array<{ type: string; id: string; at: number; via: string }>;
    confirmOrigin?: string;
  };
  certificateMonitor?: { state: string; incidents: Array<{ certificateFingerprint: string }> };
  incidentHold?: { since: string; certificates: string[] };
}

/** What the gateway hands a page for a passkey ceremony on its own origin. */
export interface GatewayPasskeyCeremony {
  purpose: string;
  rpId: string;
  origin: string;
  challenge: string;
  binding: string;
  webauthnChallenge: string;
  expiresAt: number;
}

export interface DeviceRow {
  id: string;
  name: string;
  kind: string;
  revokedAt?: number | null;
  online?: boolean;
  connectionPath?: string;
  enrollment?: {
    method?: string;
    signIn?: string | null;
    joinedAt?: number;
  } | null;
  [key: string]: unknown;
}

/** The longest a device is allowed to take between `pace` and its calls to the gateway. */
const PAIRING_CALL_DELAY_MS = 12_000;

export class EnrollmentGateway {
  readonly gatewayId = randomUUID();
  readonly hostname: string;
  readonly publicOrigin: string;
  readonly sessionFile: string;
  readonly ownerKeyFile: string;
  harness!: E2EHarness;
  leaf!: Leaf;
  private constructor(
    readonly world: EnrollmentWorld,
    readonly directory: string,
  ) {
    this.hostname = hostedGatewayHostname(this.gatewayId, RELAY_HOST);
    this.publicOrigin = `https://${this.hostname}:${world.dataPort}`;
    this.sessionFile = join(directory, "session.json");
    this.ownerKeyFile = `${this.sessionFile}.owner-key`;
  }

  /**
   * Starts an env-configured relay gateway that serves its own certificate:
   * one leaf from the fixture authority covers its public relay name and the
   * direct loopback names, `omnesis cloud register-key` registers it with its
   * owner key and a relay invitation, and the gateway's tunnel comes up.
   * `sct: false` leaves the embedded SCT extension out of that leaf.
   */
  static async start(
    world: EnrollmentWorld,
    name: string,
    options: { sct?: boolean; extraEnv?: NodeJS.ProcessEnv } = {},
  ): Promise<EnrollmentGateway> {
    const directory = join(world.directory, `gateway-${name}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const gateway = new EnrollmentGateway(world, directory);
    gateway.leaf = await world.pki.leaf(
      `gateway-${name}`,
      [gateway.hostname, "localhost", "127.0.0.1"],
      { sct: options.sct ?? true },
    );
    const invitationFile = join(directory, "invitation.json");
    await writeFile(
      invitationFile,
      JSON.stringify({
        enrollmentToken: await (
          await world.sessions()
        ).issueEnrollmentInvitation(gateway.gatewayId, world.relayOrigin),
      }),
      { mode: 0o600 },
    );
    const relayEnv = {
      OMNESIS_CLOUD_RELAY_ENABLED: "1",
      OMNESIS_CLOUD_RELAY_URL: world.relayOrigin,
      OMNESIS_CLOUD_RELAY_SESSION_FILE: gateway.sessionFile,
      OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: gateway.ownerKeyFile,
      OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: invitationFile,
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: gateway.gatewayId,
      OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: gateway.publicOrigin,
      // Certificate Transparency polling would reach a public log service.
      OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED: "0",
      OMNESIS_TLS_CERT: gateway.leaf.certFile,
      OMNESIS_TLS_KEY: gateway.leaf.keyFile,
      ...world.googleEnv(),
    };
    const cli = e2eTsxCommand("packages/cli/src/index.ts");
    try {
      await execFileAsync(cli.command, [...cli.args, "cloud", "register-key"], {
        cwd: REPO_ROOT,
        env: e2eGatewayEnv({
          ...process.env,
          ...world.clientEnv(),
          ...relayEnv,
          OMNESIS_CONFIG_DIR: join(directory, "registration"),
          OMNESIS_LOG_LEVEL: "error",
        }),
        timeout: 60_000,
      });
    } catch (error) {
      throw new Error(`Gateway registration failed. Relay log:\n${world.relayLog().slice(-4000)}`, {
        cause: error,
      });
    }
    gateway.harness = new EnrollmentHarness({
      extraGatewayEnv: {
        ...world.clientEnv(),
        ...relayEnv,
        get OMNESIS_PUBLIC_BASE_URL() {
          return `https://localhost:${gateway.harness.gatewayPort}`;
        },
        ...options.extraEnv,
      },
    });
    // Publishes the mock source type, so a collector that joins later can host it.
    gateway.harness.registerMockSource({
      sourceType: "mock-relay-notes",
      providerType: "mock-relay",
      accountId: "fictional",
    });
    await gateway.harness.start();
    await waitFor(
      async () => (await gateway.status()).tunnel.state === "online",
      "the gateway tunnel to come online",
      gatewayBootBudgetMs(),
    );
    return gateway;
  }

  async json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    return this.harness.gatewayJson<T>(path, init);
  }

  /** Stops the gateway and starts it again with all its state, then waits for its tunnel. */
  async restart(): Promise<void> {
    await this.harness.restartGateway();
    await waitFor(
      async () => (await this.status()).tunnel.state === "online",
      "the gateway tunnel to come back online",
      gatewayBootBudgetMs(),
    );
  }

  /**
   * A request to the gateway's public name through the relay, as any client on the
   * internet would send it: TLS to the relay's data port, passed through to this
   * gateway's tunnel.
   */
  async throughRelay(
    path: string,
    init: { method?: string; body?: string; token?: string } = {},
  ): Promise<{ status: number; body: string }> {
    const { request } = await import("node:https");
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          host: "127.0.0.1",
          port: this.world.dataPort,
          servername: this.hostname,
          ca: this.world.pki.caCert,
          method: init.method ?? "GET",
          path,
          headers: {
            host: `${this.hostname}:${this.world.dataPort}`,
            "content-type": "application/json",
            ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          },
          timeout: 30_000,
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (body += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      outgoing.on("timeout", () => outgoing.destroy(new Error("Relayed request timed out")));
      outgoing.on("error", reject);
      outgoing.end(init.body);
    });
  }

  private pairingTokens = 10;
  private pairingRefilledAt = Date.now();
  /**
   * The gateway admits ten sign-in pairing calls (`authorize`, `challenge`,
   * `request`) per address at once, refilling one every six seconds. Every
   * simulated device here shares one loopback address, so a test waits for
   * room as a person pairing devices one after another would.
   *
   * The calls are counted here before the device signs in, and by the gateway
   * only when the device reaches it afterwards. A full allowance gains nothing
   * while it waits, so the gateway's can trail this count by what refills
   * during that delay. `PAIRING_CALL_DELAY_MS` of refill is therefore kept
   * back: without it a device that signed in slower than a later one found
   * the gateway a fraction of a call short and was refused with 429.
   */
  async pace(calls: number): Promise<void> {
    const refill = () => {
      const now = Date.now();
      this.pairingTokens = Math.min(10, this.pairingTokens + (now - this.pairingRefilledAt) / 6000);
      this.pairingRefilledAt = now;
    };
    refill();
    const needed = calls + PAIRING_CALL_DELAY_MS / 6000;
    if (this.pairingTokens < needed) {
      await new Promise((resolve) =>
        setTimeout(resolve, (needed - this.pairingTokens) * 6000 + 750),
      );
      refill();
    }
    this.pairingTokens -= calls;
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    return this.harness.gatewayFetch(path, init);
  }

  async status(): Promise<CloudRelayStatus> {
    return this.json<CloudRelayStatus>("/admin/cloud-relay");
  }

  async devices(): Promise<DeviceRow[]> {
    return (await this.json<{ items: DeviceRow[] }>("/admin/devices")).items;
  }

  /**
   * What the portal's two buttons send: "Create an Omnesis account" is `create`,
   * "I already have one" is `existing`. Signing in never creates an account.
   */
  async connect(intent: "create" | "existing"): Promise<CloudRelayStatus> {
    return this.json<CloudRelayStatus>("/admin/cloud-relay/connect", {
      method: "POST",
      body: JSON.stringify({ termsAccepted: true, intent }),
    });
  }

  /** Takes this gateway out of its Omnesis account, as the owner would from its settings. */
  async unlinkAccount(): Promise<void> {
    await this.json("/admin/cloud-relay/account/unlink", { method: "POST", body: "{}" });
    await waitFor(
      async () => !(await this.status()).account.linked,
      "the gateway to leave its account",
      60_000,
    );
  }

  /** The owner removes one trusted sign-in on the gateway. */
  async removeTrustedSignIn(id: string): Promise<CloudRelayStatus> {
    return this.json<CloudRelayStatus>(
      `/admin/cloud-relay/trusted-sign-ins/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  /** Starts confirming a passkey on the gateway's page, as the portal's card does. */
  async passkeyConfirmation(): Promise<GatewayPasskeyCeremony> {
    return this.json<GatewayPasskeyCeremony>("/admin/cloud-relay/passkeys/confirm/options", {
      method: "POST",
      body: "{}",
    });
  }

  /** Sends a `gateway-passkey` assertion to confirm; the raw answer, refusals included. */
  async confirmPasskey(proof: unknown): Promise<Response> {
    return this.fetch("/admin/cloud-relay/passkeys/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof }),
    });
  }

  async setPolicy(policy: "automatic" | "ask"): Promise<CloudRelayStatus> {
    return this.json<CloudRelayStatus>("/admin/cloud-relay/enrollment", {
      method: "PUT",
      body: JSON.stringify({ policy }),
    });
  }

  async pendingRequests(): Promise<
    Array<{
      requestId: string;
      name: string;
      kind: string;
      status: string;
      verificationCode: string;
      signIn?: string;
      canTrustSignIn: boolean;
    }>
  > {
    return (await this.json<{ items: never[] }>("/admin/cloud-pairing/requests")).items;
  }

  async decide(requestId: string, approve: boolean, trustSignIn?: boolean): Promise<void> {
    await this.json("/admin/cloud-pairing/decision", {
      method: "POST",
      body: JSON.stringify({
        requestId,
        approve,
        ...(trustSignIn === undefined ? {} : { trustSignIn }),
      }),
    });
  }

  /** The owner identity the relay knows this gateway by. */
  async ownerAccountId(): Promise<string> {
    const { createPublicKey } = await import("node:crypto");
    const key = createPrivateKey(await readFile(this.ownerKeyFile, "utf8"));
    return gatewayKeyAccount({
      gatewayId: this.gatewayId,
      ownerPublicKey: createPublicKey(key).export({ format: "pem", type: "spki" }).toString(),
    });
  }

  async close(): Promise<void> {
    await this.harness?.destroy();
  }
}

/** The shared harness, with no mock sources: its paired collector is the "older device". */
class EnrollmentHarness extends E2EHarness {}

// ── Browser with a virtual passkey authenticator ─────────────────────────────

export interface PasskeySession {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  authenticatorId: string;
  errors: string[];
}

const VIRTUAL_AUTHENTICATOR = {
  protocol: "ctap2",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
} as const;

/** A virtual authenticator's passkey, as the DevTools protocol exports and imports it. */
interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  privateKey: string;
  signCount: number;
  rpId?: string;
  userHandle?: string;
}

async function heldCredentials(session: PasskeySession): Promise<VirtualCredential[]> {
  const { credentials } = await session.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: session.authenticatorId,
  });
  return credentials;
}

/**
 * Replaces a profile's authenticator with one holding `credentials`, and returns
 * what the old one held. An authenticator keeps one passkey per account, so a
 * profile that uses two passkeys of one account holds them on two authenticators,
 * as a person would on two devices or in two password managers.
 */
export async function swapAuthenticator(
  session: PasskeySession,
  credentials: readonly VirtualCredential[] = [],
): Promise<VirtualCredential[]> {
  const held = await heldCredentials(session);
  await session.cdp.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: session.authenticatorId,
  });
  session.authenticatorId = (
    await session.cdp.send("WebAuthn.addVirtualAuthenticator", { options: VIRTUAL_AUTHENTICATOR })
  ).authenticatorId;
  for (const credential of credentials)
    await session.cdp.send("WebAuthn.addCredential", {
      authenticatorId: session.authenticatorId,
      credential,
    });
  return held;
}

export class PasskeyBrowser {
  private constructor(
    readonly browser: Browser,
    readonly world: EnrollmentWorld,
  ) {}

  static async launch(world: EnrollmentWorld): Promise<PasskeyBrowser> {
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-proxy-server",
        `--host-resolver-rules=${[
          `MAP ${RELAY_HOST} 127.0.0.1`,
          `MAP *.${RELAY_HOST} 127.0.0.1`,
          ...(world.google ? [world.google.browserHostRule()] : []),
        ].join(", ")}`,
        "--ignore-certificate-errors",
      ],
    });
    return new PasskeyBrowser(browser, world);
  }

  /** A fresh browser profile holding one virtual platform authenticator. */
  async session(): Promise<PasskeySession> {
    const context = await this.browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: VIRTUAL_AUTHENTICATOR,
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const refusals: string[] = [];
    refusalLog.set(page, refusals);
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const url = new URL(response.url());
      void response
        .text()
        .catch(() => "")
        .then((body) =>
          refusals.push(
            `${response.status()} ${response.request().method()} ${url.pathname} ${body.slice(0, 200)}`,
          ),
        );
    });
    return { context, page, cdp, authenticatorId, errors };
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

/**
 * Runs a passkey prompt in `session` on a page at `origin` for the WebAuthn `challenge`, and
 * returns the assertion as a gateway-passkey proof's `credential`. The page is an empty one the
 * test serves at that origin: what a relay (or any other site the relay domain covers) could
 * serve to steer an owner's passkey, since every account passkey belongs to the relay's host.
 */
export async function assertionOn(
  session: PasskeySession,
  origin: string,
  challenge: string,
  rpId = RELAY_HOST,
): Promise<Record<string, unknown>> {
  // The profile's virtual authenticator is attached to its own page, so the prompt runs there.
  const page = session.page;
  const url = `${origin}/__fixture-passkey-page`;
  await page.route(url, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>.</title>",
    }),
  );
  try {
    await page.goto(url);
    return await page.evaluate(
      async ({ challenge, rpId }) => {
        const decode = (text: string) =>
          Uint8Array.from(
            atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)),
            (char) => char.charCodeAt(0),
          );
        const encode = (buffer: ArrayBuffer) =>
          btoa(String.fromCharCode(...new Uint8Array(buffer)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        const credential = (await navigator.credentials.get({
          publicKey: {
            challenge: decode(challenge),
            rpId,
            allowCredentials: [],
            userVerification: "required",
          },
        })) as PublicKeyCredential;
        const response = credential.response as AuthenticatorAssertionResponse;
        return {
          id: credential.id,
          rawId: encode(credential.rawId),
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: encode(response.clientDataJSON),
            authenticatorData: encode(response.authenticatorData),
            signature: encode(response.signature),
            userHandle: encode(response.userHandle!),
          },
        };
      },
      { challenge, rpId },
    );
  } finally {
    await page.unroute(url);
  }
}

/** The account a browser is signed in to on the relay, from its session cookie. */
export async function signedInAccount(world: EnrollmentWorld, session: PasskeySession) {
  const cookie = (await session.context.cookies()).find(
    (value) => value.name === "__Host-omnesis-account",
  );
  if (!cookie) throw new Error("The browser has no relay account session");
  return (await world.sessions()).verifyAccountSession(cookie.value, world.relayOrigin);
}

const refusalLog = new WeakMap<Page, string[]>();

/** Text of every visible button and heading, and the page's refused requests, for a failure message. */
export async function pageSummary(page: Page): Promise<string> {
  const refused = (refusalLog.get(page) ?? []).slice(-6);
  return (
    (refused.length ? `Refused requests:\n${refused.join("\n")}\n` : "") + (await visibleText(page))
  );
}

async function visibleText(page: Page): Promise<string> {
  return page
    .evaluate(() =>
      [...document.querySelectorAll("h1,h2,h3,button,[role=alert],p")]
        .filter((element) => (element as HTMLElement).offsetParent !== null)
        .map((element) => `${element.tagName}: ${(element.textContent ?? "").trim()}`)
        .join("\n"),
    )
    .catch(() => "(page unavailable)");
}

/** Types a printed connect code on the relay's connect page, as a person on another device would. */
export async function enterConnectCode(page: Page, connectUrl: string, code: string) {
  await page.goto(connectUrl);
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

/**
 * Clicks the first of `names` that becomes visible, then reports which.
 * The relay's pages are a small state machine; this keeps a step readable.
 */
export async function clickFirst(page: Page, names: readonly string[], timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const name of names) {
      const button = page.getByRole("button", { name, exact: true });
      if (await button.isVisible().catch(() => false)) {
        if (await button.isEnabled().catch(() => false)) {
          await button.click();
          return name;
        }
      }
    }
    if (Date.now() >= deadline)
      throw new Error(
        `None of ${names.join(" / ")} appeared on ${page.url()}:\n${await pageSummary(page)}`,
      );
    await page.waitForTimeout(100);
  }
}

export async function expectText(page: Page, text: string | RegExp, timeoutMs = 20_000) {
  try {
    await page.getByText(text).first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    throw new Error(
      `"${String(text)}" did not appear on ${page.url()}:\n${await pageSummary(page)}`,
      {
        cause: error,
      },
    );
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export interface CliRun {
  proc: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
  closed: () => boolean;
}

/** Runs the real `omnesis` CLI with no terminal, the fixture names, and no desktop browser. */
export function runCli(
  world: EnrollmentWorld,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): CliRun {
  const command = e2eTsxCommand("packages/cli/src/index.ts");
  const proc = spawn(command.command, [...command.args, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...e2eGatewayEnv(),
      ...world.clientEnv(),
      PATH: `${world.noBrowserBin}:${process.env.PATH ?? ""}`,
      OMNESIS_LOG_LEVEL: "error",
      OMNESIS_GATEWAY_URL: undefined,
      OMNESIS_TOKEN: undefined,
      ...env,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerSubprocessGroup(proc);
  let stdout = "",
    stderr = "";
  proc.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  proc.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  let closed = false;
  // "close" rather than "exit": output written just before exiting is only read by then.
  const exit = once(proc, "close").then(([code]) => {
    closed = true;
    return code as number | null;
  });
  return { proc, stdout: () => stdout, stderr: () => stderr, exit, closed: () => closed };
}

/** The connect URL and code a CLI prints when no browser opens. */
export async function printedConnectCode(
  run: CliRun,
): Promise<{ connectUrl: string; code: string }> {
  return waitFor(
    () => {
      const match = /visit (\S+) on any device and enter ([A-Z2-7]{4}-[A-Z2-7]{4})/.exec(
        run.stderr(),
      );
      if (match) return { connectUrl: match[1]!, code: match[2]! };
      if (run.closed())
        throw new Error(`CLI exited ${run.proc.exitCode}: ${run.stdout()}\n${run.stderr()}`);
      return undefined;
    },
    "the CLI to print its connect code",
    60_000,
  );
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// ── Flows a person performs in the browser ──────────────────────────────────

/** The relay's sign-in page in its two views: creating an account, or signing in to one. */
export const CREATE_ACCOUNT_HEADING = "Create your Omnesis account";
export const SIGN_IN_HEADING = "Sign in to your Omnesis account";

/**
 * Creates a passkey account on the relay's page for connecting a gateway. The
 * page must already be on its create view: an account is made only there.
 */
export async function createAccountWithPasskey(page: Page): Promise<void> {
  await page.getByRole("heading", { name: CREATE_ACCOUNT_HEADING, exact: true }).waitFor();
  await clickFirst(page, ["Create with a passkey"]);
}

/**
 * Signed in on the page for connecting a gateway, the person compares the name
 * and code and presses to connect it; the page then says it is done. The page
 * never connects a gateway without that press.
 */
export async function connectThisGateway(page: Page): Promise<void> {
  await clickFirst(page, ["Connect this gateway"]);
  await expectText(page, "You're all set");
}

/**
 * Gateway shows a code; the person types it at the relay, creates an account or
 * signs in, and presses to connect the gateway.
 */
export async function connectGatewayBySignIn(
  gateway: EnrollmentGateway,
  session: PasskeySession,
  account: "create" | "existing",
): Promise<CloudRelayStatus> {
  const started = await gateway.connect(account);
  if (started.connect?.state !== "waiting")
    throw new Error(`Connect did not start: ${JSON.stringify(started.connect)}`);
  await enterConnectCode(session.page, started.connect.connectUrl!, started.connect.code!);
  if (account === "create") await createAccountWithPasskey(session.page);
  else await clickFirst(session.page, ["Sign in with Passkey"]);
  await connectThisGateway(session.page);
  return finishedConnect(gateway);
}

export async function finishedConnect(gateway: EnrollmentGateway): Promise<CloudRelayStatus> {
  return waitFor(
    async () => {
      const status = await gateway.status();
      return status.connect?.state === "done" || status.connect?.state === "failed"
        ? status
        : undefined;
    },
    "connect to finish",
    60_000,
  );
}

/** A CLI or collector printed a connect code: sign in on another device and let it continue. */
export async function signInForDevice(
  session: PasskeySession,
  printed: { connectUrl: string; code: string },
): Promise<void> {
  await enterConnectCode(session.page, printed.connectUrl, printed.code);
  await clickFirst(session.page, ["Sign in with Passkey", "Verify with Passkey"]);
  await clickFirst(session.page, ["Continue on this device"]);
  await expectText(session.page, "You're signed in");
}

/**
 * The device's own browser on the device's own machine: it opens the launch URL
 * the client would have opened, signs in, confirms, and the relay sends it on to
 * the client's 127.0.0.1 listener, whose page says the sign-in finished. Only this
 * path can let a CLI or collector join without approval.
 */
export async function signInOnThisMachine(
  session: PasskeySession,
  launchUrl: string,
): Promise<void> {
  await session.page.goto(launchUrl);
  await clickFirst(session.page, ["Sign in with Passkey", "Verify with Passkey"]);
  await clickFirst(session.page, ["Continue on this device"]);
  await expectText(session.page, "Sign-in finished");
}

/**
 * The account-page launch URLs the no-browser launcher was asked to open, oldest
 * first: what a spawned CLI tried to show in a desktop browser.
 */
export async function launchedUrls(world: EnrollmentWorld): Promise<string[]> {
  const text = await readFile(join(world.directory, "launches.txt"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

/**
 * A gateway's signup request sent straight to the relay, as `omnesis cloud connect`
 * sends it, from a throwaway gateway identity. Returns what the relay started and
 * the secret only that gateway holds, to poll or cancel it.
 */
export async function startGatewaySignup(world: EnrollmentWorld, intent: "create" | "existing") {
  const { sign } = await import("node:crypto");
  const {
    GATEWAY_SIGNUP_PATH,
    GATEWAY_SIGNUP_PROTOCOL,
    gatewaySignupStarted,
    gatewaySignupTranscript,
  } = await import("@omnesis/cloud-relay");
  const owner = generateKeyPairSync("ed25519");
  const issuedAt = Math.floor(Date.now() / 1000);
  const redemptionSecret = randomBytes(32).toString("base64url");
  const unsigned = {
    protocol: GATEWAY_SIGNUP_PROTOCOL,
    operationId: randomUUID(),
    gatewayId: randomUUID(),
    ownerPublicKey: owner.publicKey.export({ format: "pem", type: "spki" }).toString(),
    nonce: randomBytes(32).toString("base64url"),
    redemptionSha256: sha256Hex(redemptionSecret),
    issuedAt,
    expiresAt: issuedAt + 300,
  };
  const response = await fetch(`${world.relayOrigin}${GATEWAY_SIGNUP_PATH}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...unsigned,
      ownerSignature: sign(
        null,
        gatewaySignupTranscript(world.relayOrigin, unsigned),
        owner.privateKey,
      ).toString("base64url"),
      intent,
    }),
  });
  if (!response.ok) throw new Error(`Signup start refused: ${response.status}`);
  const started = gatewaySignupStarted.parse(await response.json());
  const call = (path: "poll" | "cancel") =>
    fetch(`${world.relayOrigin}${GATEWAY_SIGNUP_PATH}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: started.operationId, redemptionSecret }),
    });
  return {
    started,
    /** What the gateway's own poll sees. */
    poll: async () => (await call("poll")).json() as Promise<{ status: string; reason?: string }>,
    cancel: () => call("cancel").then(() => undefined),
  };
}

/**
 * Makes a passkey account on the relay and leaves it with no gateway: a
 * throwaway gateway identity starts a signup to create an account, the browser
 * creates it, and that gateway never finishes connecting. Returns the new account id.
 */
export async function createUnlinkedAccount(
  world: EnrollmentWorld,
  session: PasskeySession,
): Promise<string> {
  // An account is created only when the gateway's owner asked to create one.
  const { started, cancel } = await startGatewaySignup(world, "create");
  await enterConnectCode(session.page, started.connectUrl, started.code);
  await createAccountWithPasskey(session.page);
  // The throwaway gateway never collects the result.
  await connectThisGateway(session.page);
  await cancel().catch(() => undefined);
  return (await signedInAccount(world, session)).accountId;
}

/** Copies one browser's passkey into another profile, as a synced passkey would arrive. */
export async function copyPasskey(from: PasskeySession, to: PasskeySession): Promise<string> {
  const { credentials } = await from.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: from.authenticatorId,
  });
  if (credentials.length !== 1)
    throw new Error(`Expected one passkey, found ${credentials.length}`);
  await to.cdp.send("WebAuthn.addCredential", {
    authenticatorId: to.authenticatorId,
    credential: credentials[0]!,
  });
  return credentials[0]!.credentialId;
}

/**
 * Brings one profile's copy of a passkey up to the other's signature counter.
 * The relay refuses an assertion whose counter does not advance, as it would
 * from a cloned authenticator, so a copy used in one profile must be synced
 * back before the original is used again.
 */
export async function syncPasskey(from: PasskeySession, to: PasskeySession, credentialId: string) {
  const { credentials } = await from.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: from.authenticatorId,
  });
  const current = credentials.find((value) => value.credentialId === credentialId);
  if (!current) throw new Error("The passkey to sync is not in the source profile");
  await to.cdp.send("WebAuthn.removeCredential", {
    authenticatorId: to.authenticatorId,
    credentialId,
  });
  await to.cdp.send("WebAuthn.addCredential", {
    authenticatorId: to.authenticatorId,
    credential: current,
  });
}

/** Picks an entry of the account page's "more options" menu: "Sign out" or "Delete account". */
export async function chooseAccountMenu(page: Page, name: string) {
  await clickFirst(page, ["More options"]);
  await page.getByRole("menuitem", { name, exact: true }).click();
}

/** A fresh account-page sign-in, which managing sign-in methods requires. */
export async function freshAccountSignIn(world: EnrollmentWorld, session: PasskeySession) {
  const page = session.page;
  await page.goto(`${world.relayOrigin}/_relay/account`);
  const methods = page.getByRole("heading", { name: "Sign-in methods", exact: true });
  const signIn = page.getByRole("button", { name: "Sign in with Passkey", exact: true });
  await methods.or(signIn).first().waitFor({ timeout: 20_000 });
  if (await methods.isVisible()) await chooseAccountMenu(page, "Sign out");
  await clickFirst(page, ["Sign in with Passkey"]);
  await methods.waitFor({ timeout: 20_000 });
}

/**
 * Presses "Sign in with Passkey" on the signed-out account page with a passkey
 * no account has, and waits for the page to say so and stay signed out.
 */
export async function expectPasskeySignInRefused(session: PasskeySession): Promise<void> {
  const page = session.page;
  await clickFirst(page, ["Sign in with Passkey"]);
  try {
    await page.getByRole("alert").filter({ hasText: /\S/ }).waitFor({ timeout: 20_000 });
  } catch (error) {
    throw new Error(`The page reported no refused sign-in:\n${await pageSummary(page)}`, {
      cause: error,
    });
  }
  await page.getByRole("button", { name: "Sign in with Passkey", exact: true }).waitFor();
  if (await page.getByRole("heading", { name: "Sign-in methods", exact: true }).count())
    throw new Error("A passkey no account has signed in");
}

/** WebAuthn credential ids as the gateway names them (base64url). */
export async function passkeyIds(session: PasskeySession): Promise<string[]> {
  const { credentials } = await session.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: session.authenticatorId,
  });
  return credentials.map((value) =>
    Buffer.from(value.credentialId, "base64").toString("base64url"),
  );
}

/** The account page's panel right after a new passkey is created, before it has signed. */
export const COUNTERSIGN_HEADING = "Use your new passkey once";
/** The account page's panel after a new passkey signed and before a sign-in vouches for it. */
export const ENDORSEMENT_HEADING = "Confirm it's you to finish";
export const PASSKEY_ADDED = "Passkey added. You can now use it to sign in.";

/**
 * Adds a second passkey to the account `signedIn` belongs to, held only by a
 * new browser profile. The new profile signs in with a copy of the first
 * passkey and sets it aside, so "Add a passkey" makes a passkey of its own;
 * the copy then comes back to confirm, as another of the person's passkeys
 * would, and is dropped once the new passkey is listed.
 *
 * `confirm: false` stops at the confirmation panel and cancels: the passkey the
 * browser made is never stored on the account.
 */
export async function addSecondPasskey(
  browser: PasskeyBrowser,
  world: EnrollmentWorld,
  signedIn: PasskeySession,
  options: { confirm?: boolean } = {},
): Promise<PasskeySession> {
  const second = await browser.session();
  const page = second.page;
  const copied = await copyPasskey(signedIn, second);
  await page.goto(`${world.relayOrigin}/_relay/account`);
  await clickFirst(page, ["Sign in with Passkey"]);
  await page.getByRole("heading", { name: "Sign-in methods", exact: true }).waitFor();
  await syncPasskey(second, signedIn, copied);
  // The copy steps aside: the new passkey is made on an authenticator of its own.
  const copy = await swapAuthenticator(second);
  // Passkeys list in creation order; keep the new one strictly later.
  await page.waitForTimeout(1100);
  const remove = page.getByRole("button", { name: "Remove", exact: true });
  const before = await remove.count();
  await clickFirst(page, ["Add a passkey"]);
  // The browser has made the passkey, which signs once for the account's other sign-ins; the
  // account keeps it only once one of those vouches for it.
  await page.getByRole("heading", { name: COUNTERSIGN_HEADING, exact: true }).waitFor();
  await clickFirst(page, ["Use new passkey"]);
  await page.getByRole("heading", { name: ENDORSEMENT_HEADING, exact: true }).waitFor();
  if ((await remove.count()) !== before)
    throw new Error("The new passkey was listed before anyone confirmed it");
  if (options.confirm === false) {
    await clickFirst(page, ["Cancel"]);
    await expectText(page, "No passkey was added.");
    if ((await remove.count()) !== before)
      throw new Error("A cancelled passkey was listed on the account");
    return second;
  }
  const made = await swapAuthenticator(second, copy);
  if (made.length !== 1) throw new Error(`Expected one new passkey, found ${made.length}`);
  await clickFirst(page, ["Confirm with passkey"]);
  await expectText(page, PASSKEY_ADDED);
  await waitFor(async () => (await remove.count()) === before + 1, "the new passkey to be listed");
  await syncPasskey(second, signedIn, copied);
  // From here on the profile holds only its own passkey.
  await swapAuthenticator(second, made);
  if ((await passkeyIds(second)).length !== 1)
    throw new Error("The new profile should hold one passkey");
  return second;
}

// ── A device's own TLS connection to its gateway, through the relay ──────────

export class GatewayRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Gateway answered ${status}: ${body.slice(0, 300)}`);
  }
}

/**
 * The device side of `pinnedGatewayJson`: TLS to the gateway's public name
 * through the relay's passthrough port, trusting only the given certificate.
 * `connectPort` sends the connection somewhere else, such as an interceptor.
 */
export async function devicePinnedJson(
  candidate: { publicOrigin: string; certificate: string },
  path: string,
  body: unknown,
  signal?: AbortSignal,
  _connectHost?: string,
  options: { token?: string; connectPort?: number; [key: string]: unknown } = {},
): Promise<unknown> {
  const { request } = await import("node:https");
  const { X509Certificate } = await import("node:crypto");
  const origin = new URL(candidate.publicOrigin);
  const pinned = new X509Certificate(candidate.certificate).fingerprint256;
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: options.connectPort ?? Number(origin.port || 443),
        servername: origin.hostname,
        path,
        method: body === undefined ? "GET" : "POST",
        ca: candidate.certificate,
        allowPartialTrustChain: true,
        rejectUnauthorized: true,
        checkServerIdentity: (_host, certificate) =>
          certificate.fingerprint256 === pinned
            ? undefined
            : new Error("Gateway certificate pin mismatch"),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
        headers: {
          host: origin.host,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) reject(new GatewayRefused(res.statusCode ?? 0, text));
          else {
            try {
              resolve(JSON.parse(text));
            } catch (error) {
              reject(error);
            }
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** The leaf certificate the relay's passthrough port serves for a gateway's public name, verified against `ca`. */
export async function servedCertificate(world: EnrollmentWorld, hostname: string, ca: string) {
  const tls = await import("node:tls");
  const { X509Certificate } = await import("node:crypto");
  const socket = tls.connect({
    host: "127.0.0.1",
    port: world.dataPort,
    servername: hostname,
    ca,
  });
  try {
    await once(socket, "secureConnect");
    const certificate = new X509Certificate(socket.getPeerCertificate().raw);
    return {
      pem: certificate.toString(),
      issuer: certificate.issuer,
      subjectAltName: certificate.subjectAltName,
    };
  } finally {
    socket.destroy();
  }
}

/**
 * A TLS endpoint presenting `leaf` for the gateway's name, forwarding the
 * plaintext to the real gateway through the relay: what a relay that swapped
 * the certificate it proposes would put in front of the gateway.
 */
export async function certificateSwapProxy(world: EnrollmentWorld, leaf: Leaf, hostname: string) {
  const tls = await import("node:tls");
  const sockets = new Set<import("node:net").Socket>();
  // The interceptor itself verifies the real gateway, as a relay would.
  const ca = await readFile(world.pki.caCertFile, "utf8");
  const server = tls.createServer(
    { cert: leaf.cert, key: await readFile(leaf.keyFile, "utf8") },
    (client) => {
      const upstream = tls.connect({
        host: "127.0.0.1",
        port: world.dataPort,
        servername: hostname,
        ca,
      });
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
        socket.once("close", () => sockets.delete(socket));
      }
      client.pipe(upstream);
      upstream.pipe(client);
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The owner confirms the passkey `session` holds on the gateway's own page, as the portal's
 * account card does: the gateway's challenge, an assertion on its origin, and the confirmation.
 * Returns the status after it.
 */
export async function confirmPasskeyHere(
  gateway: EnrollmentGateway,
  session: PasskeySession,
): Promise<CloudRelayStatus> {
  const ceremony = await gateway.passkeyConfirmation();
  const response = await gateway.confirmPasskey({
    type: "gateway-passkey",
    challenge: ceremony.challenge,
    credential: await assertionOn(session, gateway.publicOrigin, ceremony.webauthnChallenge),
  });
  if (!response.ok)
    throw new Error(`Confirming the passkey failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as CloudRelayStatus;
}

/** The owner approves the pending request from `name` on the gateway, once it is held. */
export async function approveHeld(
  gateway: EnrollmentGateway,
  name: string,
  trustSignIn?: boolean,
): Promise<{ requestId: string; verificationCode: string; canTrustSignIn: boolean }> {
  const held = await waitFor(
    async () =>
      (await gateway.pendingRequests()).find(
        (request) => request.name === name && request.status === "pending",
      ),
    `a held request from ${name}`,
  );
  await gateway.decide(held.requestId, true, trustSignIn);
  return held;
}

/**
 * A CLI or collector that signs in with a passkey on the gateway's own page, as a device of the
 * owner's would through the relay: it asks the gateway for the ceremony, the owner's browser
 * (`session`) makes the assertion on the gateway's origin, and the device signs for the same
 * challenge and sends its request. When the gateway joins it at once, the device redeems its
 * pairing code; otherwise it returns the gateway's answer for a held request.
 */
export async function gatewayPasskeyJoin(
  gateway: EnrollmentGateway,
  session: PasskeySession,
  device: {
    kind: "cli" | "collector";
    name: string;
    key?: { privateKey: KeyObject; publicKey: KeyObject };
  },
): Promise<{
  reply: { status: string; verificationCode: string; pairingCode?: string };
  requestId: string;
  secret: string;
  joined?: { deviceId: string; token: string };
}> {
  const target = { publicOrigin: gateway.publicOrigin, certificate: gateway.leaf.cert };
  const { tlsSpkiFingerprint, enrollmentSignatureTranscript, signDeviceTranscript } =
    await import("@omnesis/cloud-relay");
  const key = device.key ?? generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const devicePublicKey = key.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const fields = {
    requestId: randomUUID(),
    kind: device.kind,
    name: device.name,
    secret: randomBytes(32).toString("hex"),
  };
  await gateway.pace(3);
  const ceremony = (await devicePinnedJson(target, "/devices/account/passkey/options", {
    ...fields,
    devicePublicKey,
  })) as { challenge: string; webauthnChallenge: string };
  const reply = (await devicePinnedJson(target, "/devices/account/request", {
    ...fields,
    deviceKey: {
      publicKey: devicePublicKey,
      challenge: ceremony.challenge,
      signature: signDeviceTranscript(
        key.privateKey,
        enrollmentSignatureTranscript({
          ...fields,
          gatewaySpkiFingerprint: tlsSpkiFingerprint(gateway.leaf.cert),
          challenge: ceremony.challenge,
          devicePublicKey,
        }),
      ),
    },
    proof: {
      type: "gateway-passkey",
      challenge: ceremony.challenge,
      credential: await assertionOn(session, gateway.publicOrigin, ceremony.webauthnChallenge),
    },
  })) as { status: string; verificationCode: string; pairingCode?: string };
  if (reply.status !== "approved" || !reply.pairingCode)
    return { reply, requestId: fields.requestId, secret: fields.secret };
  return {
    reply,
    requestId: fields.requestId,
    secret: fields.secret,
    joined: await redeemPairing(gateway, device, reply.pairingCode),
  };
}

/** Redeems a pairing code the way the device does, over its pinned connection. */
async function redeemPairing(
  gateway: EnrollmentGateway,
  device: { kind: "cli" | "collector"; name: string },
  pairingCode: string,
): Promise<{ deviceId: string; token: string }> {
  const target = { publicOrigin: gateway.publicOrigin, certificate: gateway.leaf.cert };
  const paired = (await devicePinnedJson(target, "/devices/pair", {
    pairingCode,
    capabilities: { platform: device.kind, suggestedName: device.name },
  })) as { token: string; device: { id: string } };
  return { deviceId: paired.device.id, token: paired.token };
}

/** Once the owner approved a held request, the device polls for its code and redeems it. */
export async function joinAfterApproval(
  gateway: EnrollmentGateway,
  device: { kind: "cli" | "collector"; name: string },
  request: { requestId: string; secret: string },
): Promise<{ deviceId: string; token: string }> {
  const target = { publicOrigin: gateway.publicOrigin, certificate: gateway.leaf.cert };
  const polled = (await devicePinnedJson(target, "/devices/account/poll", {
    requestId: request.requestId,
    secret: request.secret,
  })) as {
    status: string;
    pairingCode?: string;
  };
  if (polled.status !== "approved" || !polled.pairingCode)
    throw new Error(`The request was not approved: ${JSON.stringify(polled)}`);
  return redeemPairing(gateway, device, polled.pairingCode);
}

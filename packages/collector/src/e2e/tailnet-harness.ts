// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A private tailnet for end-to-end tests, on this machine only.
 *
 * headscale (an open-source Tailscale coordination server) and Tailscale's
 * own relay server run on loopback. Each test "machine" is a real tailscaled
 * in userspace mode, unprivileged, with its own state, its own Tailscale CLI
 * socket and an HTTP proxy that reaches the tailnet; a program sent through
 * that proxy is, to the tailnet, that machine. The gateway under test runs
 * with the embedded-Tailscale opt-in and the real helper program, which joins
 * this tailnet as its own device.
 *
 * Tailscale's servers are never contacted. Certificates and the public
 * (Funnel) address are Tailscale-hosted features headscale does not offer, so
 * the gateway serves its own certificate on the tailnet here, as it does on
 * any tailnet with HTTPS certificates switched off.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestPki, type TestPki } from "./fixture-pki.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, "../../../..");

/** The tailnet's MagicDNS domain; the gateway's device is `omnesis.<this>`. */
export const TAILNET_DOMAIN = "tailnet.test";
export const GATEWAY_TAILNET_ORIGIN = `https://omnesis.${TAILNET_DOMAIN}`;

export interface TailnetTools {
  headscale: string;
  tailscale: string;
  tailscaled: string;
  derper: string;
  helper: string;
}

/**
 * The tools, or null on a development machine without Go (the suite then
 * skips with a notice). In CI their absence fails the suite.
 */
export async function tailnetTools(suite: string): Promise<TailnetTools | null> {
  const tools = (await import(join(REPO_ROOT, "scripts/tailnet-test/tools.mjs"))) as {
    goAvailable(): boolean;
    ensureTailnetTools(): Promise<TailnetTools>;
  };
  if (!tools.goAvailable()) {
    if (process.env.CI)
      throw new Error(`${suite}: the Go toolchain is missing; the e2e job must set it up`);
    process.stderr.write(`${suite}: the Go toolchain is not installed — skipping.\n`);
    return null;
  }
  return tools.ensureTailnetTools();
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
  timeoutMs = 30_000,
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
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function startProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logFile: string,
): ChildProcess {
  const proc = spawn(command, args, {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  registerSubprocessGroup(proc);
  const append = (chunk: Buffer) => {
    try {
      writeFileSync(logFile, chunk, { flag: "a" });
    } catch {
      // The directory went with teardown.
    }
  };
  proc.stdout!.on("data", append);
  proc.stderr!.on("data", append);
  return proc;
}

/** One machine on the test tailnet. */
export class TailnetMachine {
  constructor(
    readonly name: string,
    readonly dir: string,
    /** The machine's tailscaled socket, for its Tailscale CLI. */
    readonly socket: string,
    /** An HTTP proxy whose connections leave from this machine. */
    readonly proxyUrl: string,
    /** A directory holding a `tailscale` that talks to this machine's daemon. */
    readonly binDir: string,
    private readonly proc: ChildProcess,
  ) {}

  /**
   * The environment that makes a Node program act from this machine: its
   * Tailscale CLI first on PATH, its proxy for every outbound request, and
   * the test authority trusted.
   */
  env(caCertFile: string): NodeJS.ProcessEnv {
    return {
      PATH: `${this.binDir}:${process.env.PATH ?? ""}`,
      HTTPS_PROXY: this.proxyUrl,
      HTTP_PROXY: this.proxyUrl,
      NO_PROXY: "",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: caCertFile,
    };
  }

  async stop(): Promise<void> {
    await killSubprocessGroup(this.proc);
  }
}

export class TestTailnet {
  readonly dir: string;
  private readonly runtimeDir: string;
  private procs: ChildProcess[] = [];
  readonly machines: TailnetMachine[] = [];
  controlUrl = "";
  private configFile = "";
  pki!: TestPki;

  private constructor(readonly tools: TailnetTools) {
    this.dir = mkdtempSync(join(tmpdir(), "omnesis-tailnet-"));
    // Unix socket paths must stay short.
    this.runtimeDir = mkdtempSync(join(tmpdir(), "otn-"));
  }

  static async start(tools: TailnetTools): Promise<TestTailnet> {
    const tailnet = new TestTailnet(tools);
    try {
      await tailnet.boot();
    } catch (err) {
      await tailnet.stop();
      throw err;
    }
    return tailnet;
  }

  private async boot(): Promise<void> {
    this.pki = await createTestPki(join(this.dir, "pki"), "tailnet");
    const [controlPort, derpPort, stunPort, metricsPort, grpcPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
      freePort(),
      freePort(),
    ]);
    const derp = startProcess(
      this.tools.derper,
      [
        "-c",
        join(this.dir, "derper.json"),
        "-a",
        `127.0.0.1:${derpPort}`,
        "-http-port",
        "-1",
        "-stun-port",
        String(stunPort),
        "-hostname",
        "127.0.0.1",
      ],
      { ...process.env, TS_NO_LOGS_NO_SUPPORT: "true" },
      join(this.dir, "derper.log"),
    );
    this.procs.push(derp);
    const derpMap = join(this.dir, "derp.yaml");
    writeFileSync(
      derpMap,
      [
        "regions:",
        "  900:",
        "    regionid: 900",
        "    regioncode: local",
        "    regionname: Local test relay",
        "    nodes:",
        "      - name: 900a",
        "        regionid: 900",
        "        hostname: 127.0.0.1",
        "        ipv4: 127.0.0.1",
        `        stunport: ${stunPort}`,
        `        derpport: ${derpPort}`,
        "",
      ].join("\n"),
    );
    this.controlUrl = `http://127.0.0.1:${controlPort}`;
    this.configFile = join(this.dir, "headscale.yaml");
    writeFileSync(
      this.configFile,
      [
        `server_url: ${this.controlUrl}`,
        `listen_addr: 127.0.0.1:${controlPort}`,
        `metrics_listen_addr: 127.0.0.1:${metricsPort}`,
        `grpc_listen_addr: 127.0.0.1:${grpcPort}`,
        "grpc_allow_insecure: false",
        "noise:",
        `  private_key_path: ${join(this.dir, "noise_private.key")}`,
        "prefixes:",
        "  v4: 100.64.0.0/10",
        "  v6: fd7a:115c:a1e0::/48",
        "  allocation: sequential",
        "derp:",
        "  server:",
        "    enabled: false",
        "  urls: []",
        `  paths: [${derpMap}]`,
        "  auto_update_enabled: false",
        "disable_check_updates: true",
        "database:",
        "  type: sqlite",
        "  sqlite:",
        `    path: ${join(this.dir, "headscale.sqlite")}`,
        "    write_ahead_log: true",
        "log:",
        "  level: warn",
        "policy:",
        "  mode: file",
        '  path: ""',
        "dns:",
        "  magic_dns: true",
        `  base_domain: ${TAILNET_DOMAIN}`,
        "  override_local_dns: false",
        "  nameservers:",
        "    global: []",
        `unix_socket: ${join(this.runtimeDir, "hs.sock")}`,
        'unix_socket_permission: "0700"',
        "logtail:",
        "  enabled: false",
        "",
      ].join("\n"),
    );
    this.procs.push(
      startProcess(
        this.tools.headscale,
        ["-c", this.configFile, "serve"],
        process.env,
        join(this.dir, "headscale.log"),
      ),
    );
    await waitFor(async () => (await fetch(`${this.controlUrl}/health`)).ok, "headscale to answer");
    await this.headscale(["users", "create", "owner"]);
    await this.headscale(["users", "create", "stranger"]);
  }

  /** Run the headscale CLI against this tailnet's server. */
  async headscale(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.tools.headscale, ["-c", this.configFile, ...args], {
      env: process.env,
    });
    return stdout;
  }

  private async userId(name: string): Promise<string> {
    const users = JSON.parse(await this.headscale(["users", "list", "-o", "json"])) as Array<{
      id: number | string;
      name: string;
    }>;
    const user = users.find((u) => u.name === name);
    if (!user) throw new Error(`no headscale user ${name}`);
    return String(user.id);
  }

  /** A one-use key that joins a device as `user`, or as a device carrying `tags`. */
  async authKey(owner: { user: string } | { tags: string[] }): Promise<string> {
    const args =
      "user" in owner
        ? ["preauthkeys", "create", "--user", await this.userId(owner.user), "-o", "json"]
        : ["preauthkeys", "create", "--tags", owner.tags.join(","), "-o", "json"];
    return (JSON.parse(await this.headscale(args)) as { key: string }).key;
  }

  /** Approve an interactive sign-in link as `user`, as the person opening it would. */
  async approveSignIn(signInUrl: string, user: string): Promise<void> {
    const authId = /\/register\/([A-Za-z0-9_-]+)/.exec(signInUrl)?.[1];
    if (!authId) throw new Error(`not a headscale sign-in link: ${signInUrl}`);
    await this.headscale(["auth", "register", "--user", user, "--auth-id", authId]);
  }

  /** Start a machine and sign it in as `user`, or as a tagged device. */
  async machine(
    name: string,
    owner: { user: string } | { tags: string[] },
  ): Promise<TailnetMachine> {
    const dir = join(this.dir, "machines", name);
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const socket = join(this.runtimeDir, `${name}.sock`);
    const proxyPort = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env, TS_NO_LOGS_NO_SUPPORT: "true" };
    for (const key of Object.keys(env)) if (key.startsWith("TS_AUTH")) delete env[key];
    const proc = startProcess(
      this.tools.tailscaled,
      [
        "--tun=userspace-networking",
        `--socket=${socket}`,
        `--statedir=${join(dir, "state")}`,
        "--port=0",
        `--outbound-http-proxy-listen=127.0.0.1:${proxyPort}`,
        "--no-logs-no-support",
      ],
      env,
      join(dir, "tailscaled.log"),
    );
    this.procs.push(proc);
    const wrapper = join(binDir, "tailscale");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${JSON.stringify(this.tools.tailscale)} --socket=${JSON.stringify(socket)} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    await waitFor(async () => {
      await execFileAsync(wrapper, ["status", "--json"]).catch((err: { stdout?: string }) => {
        if (!err.stdout) throw err;
      });
      return true;
    }, `${name}'s tailscaled to answer`);
    await execFileAsync(
      wrapper,
      [
        "up",
        `--login-server=${this.controlUrl}`,
        `--authkey=${await this.authKey(owner)}`,
        `--hostname=${name}`,
        "--accept-dns=false",
        "--timeout=60s",
      ],
      { env },
    );
    const machine = new TailnetMachine(
      name,
      dir,
      socket,
      `http://127.0.0.1:${proxyPort}`,
      binDir,
      proc,
    );
    this.machines.push(machine);
    return machine;
  }

  /** Log files worth reading when a test fails. */
  logs(): string {
    const read = (path: string) => {
      try {
        return readFileSync(path, "utf8").split("\n").slice(-40).join("\n");
      } catch {
        return "";
      }
    };
    return [
      `--- headscale\n${read(join(this.dir, "headscale.log"))}`,
      ...this.machines.map((m) => `--- ${m.name}\n${read(join(m.dir, "tailscaled.log"))}`),
    ].join("\n");
  }

  async stop(): Promise<void> {
    await Promise.all(this.procs.map((proc) => killSubprocessGroup(proc)));
    rmSync(this.dir, { recursive: true, force: true });
    rmSync(this.runtimeDir, { recursive: true, force: true });
  }
}

/** A gateway with the embedded-Tailscale opt-in, pointed at a test tailnet. */
export class TailnetGateway {
  readonly dir: string;
  readonly configDir: string;
  port = 0;
  url = "";
  adminToken = "";
  private proc: ChildProcess | null = null;
  private certFile = "";
  private keyFile = "";

  constructor(
    private readonly tailnet: TestTailnet,
    private readonly extraEnv: NodeJS.ProcessEnv = {},
  ) {
    this.dir = mkdtempSync(join(tmpdir(), "omnesis-tailnet-gw-"));
    this.configDir = join(this.dir, "config");
    mkdirSync(this.configDir, { recursive: true });
  }

  /** Start, or start again with the same state. */
  async start(): Promise<void> {
    if (!this.certFile) {
      // The gateway's own certificate, from the test authority, names both its
      // local address and its tailnet name, so test clients trust it either way.
      const leaf = await this.tailnet.pki.leaf("gateway", [
        "localhost",
        "127.0.0.1",
        `omnesis.${TAILNET_DOMAIN}`,
      ]);
      this.certFile = leaf.certFile;
      this.keyFile = leaf.keyFile;
    }
    this.port ||= await freePort();
    this.url = `https://localhost:${this.port}`;
    const command = e2eTsxCommand("packages/gateway/src/index.ts");
    this.proc = spawn(command.command, command.args, {
      cwd: REPO_ROOT,
      env: {
        ...e2eGatewayEnv(),
        ...this.extraEnv,
        OMNESIS_TAILSCALE_EMBED_ENABLED: "1",
        OMNESIS_TAILSCALE_HELPER: this.tailnet.tools.helper,
        OMNESIS_TAILSCALE_EMBED_TEST_CONTROL_URL: this.tailnet.controlUrl,
        OMNESIS_TLS_CERT: this.certFile,
        OMNESIS_TLS_KEY: this.keyFile,
        OMNESIS_DB_PATH: join(this.dir, "omnesis.db"),
        OMNESIS_GATEWAY_PORT: String(this.port),
        OMNESIS_CONFIG_DIR: this.configDir,
        OMNESIS_LOG_LEVEL: "info",
        OMNESIS_LOG_FILE: join(this.dir, "gateway.log"),
        OMNESIS_PARENT_PID: String(process.pid),
        OMNESIS_MDNS_DISABLE: "1",
      },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    registerSubprocessGroup(this.proc);
    const budget = gatewayBootBudgetMs();
    await waitFor(
      async () => {
        const token = readFileSync(join(this.configDir, "token"), "utf8").trim();
        const res = await httpsJson(this.tailnet.pki.caCert, `${this.url}/whoami`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.status !== 200) return false;
        this.adminToken = token;
        return true;
      },
      "the gateway to start",
      budget,
    );
  }

  /** An admin call on the gateway's local address. */
  async admin<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    const res = await httpsJson(this.tailnet.pki.caCert, `${this.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.adminToken}` },
      ...(body === undefined ? {} : { body }),
    });
    return { status: res.status, json: res.json as T };
  }

  log(): string {
    try {
      return readFileSync(join(this.dir, "gateway.log"), "utf8").split("\n").slice(-80).join("\n");
    } catch {
      return "";
    }
  }

  async stop(): Promise<void> {
    if (this.proc) await killSubprocessGroup(this.proc);
    this.proc = null;
  }

  async remove(): Promise<void> {
    await this.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * Run the Omnesis CLI as `machine` would: through its tailnet, with its own
 * config directory, never toward a gateway on this host.
 */
export function runCliOn(
  machine: TailnetMachine,
  caCertFile: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const configDir = join(machine.dir, "omnesis");
  mkdirSync(configDir, { recursive: true });
  const command = e2eTsxCommand("packages/cli/src/index.ts");
  return new Promise((resolve) => {
    const proc = spawn(command.command, [...command.args, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...e2eGatewayEnv(),
        ...machine.env(caCertFile),
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_TAILSCALE_EMBED_ENABLED: "1",
        OMNESIS_LOG_LEVEL: "error",
        OMNESIS_GATEWAY_URL: GATEWAY_TAILNET_ORIGIN,
        OMNESIS_TOKEN: undefined,
        NODE_TLS_REJECT_UNAUTHORIZED: undefined,
        ...extraEnv,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerSubprocessGroup(proc);
    let stdout = "";
    let stderr = "";
    proc.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export interface JsonResponse {
  status: number;
  json: unknown;
  text: string;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** An HTTPS request trusting only the test authority. */
export function httpsJson(
  caCert: string,
  url: string,
  init: RequestOptions = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpsRequest(
      url,
      {
        method: init.method ?? "GET",
        ca: caCert,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...init.headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: parse(text), text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * An HTTPS request from `machine` through its tailnet: a CONNECT through the
 * machine's proxy, then TLS to the name asked for, trusting the test
 * authority.
 */
export function fetchFrom(
  machine: TailnetMachine,
  caCert: string,
  url: string,
  init: RequestOptions = {},
): Promise<JsonResponse> {
  const target = new URL(url);
  const proxy = new URL(machine.proxyUrl);
  const port = target.port || "443";
  return new Promise((resolve, reject) => {
    const connect = httpRequest({
      host: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}` },
    });
    connect.on("error", reject);
    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${target.host} answered ${res.statusCode}`));
        return;
      }
      const body = init.body === undefined ? undefined : JSON.stringify(init.body);
      const req = httpsRequest(
        url,
        {
          method: init.method ?? "GET",
          headers: { ...(body ? { "content-type": "application/json" } : {}), ...init.headers },
          createConnection: () => tlsConnect({ socket, servername: target.hostname, ca: caCert }),
          agent: false,
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (d: string) => (text += d));
          response.on("end", () => {
            socket.destroy();
            resolve({ status: response.statusCode ?? 0, json: parse(text), text });
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    connect.end();
  });
}

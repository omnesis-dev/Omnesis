// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A private tailnet for end-to-end tests, on this machine only.
 *
 * Headscale or the SDK's test coordinator and Tailscale's own relay run on
 * loopback. Windows uses an owned userspace actor with real SDK peers and
 * the official Tailscale CLI through private named pipes. POSIX machines use
 * real tailscaled processes in unprivileged userspace mode. Each machine has
 * its own state, a private CLI socket and an HTTP proxy reaching the tailnet;
 * a program sent through
 * that proxy is, to the tailnet, that machine. The gateway under test runs
 * with the embedded-Tailscale opt-in and the real helper program, which joins
 * this tailnet as its own device.
 *
 * Tailscale's servers are never contacted. Certificates and the public
 * (Funnel) address are disabled on these local control planes, so
 * the gateway serves its own certificate on the tailnet here, as it does on
 * any tailnet with HTTPS certificates switched off. Headscale lets every
 * device keep its network map on disk between runs, as Tailscale's own
 * coordination server does.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { createTestPki, type TestPki } from "./fixture-pki.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";
import { tailnetMachineEnv, tailnetFixtureEnv } from "./tailnet-machine-env.js";
import type { PortableTestTailnet } from "./portable-tailnet-harness.js";
import { spawnE2ESubprocess } from "./e2e-owned-process.js";
import { stopTailnetCommands, tailnetCleanupError } from "./tailnet-command-processes.js";
import { TAILNET_DOMAIN } from "./tailnet-fixture-addresses.js";
export { TAILNET_DOMAIN, GATEWAY_TAILNET_ORIGIN } from "./tailnet-fixture-addresses.js";
export { runCliOn } from "./tailnet-command-processes.js";
import { httpsJson } from "./tailnet-request.js";
export { httpsJson, fetchFrom, type JsonResponse } from "./tailnet-request.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, "../../../..");

export interface TailnetTools {
  headscale: string;
  tailscale: string;
  tailscaled: string;
  derper: string;
  helper: string;
  portable?: { actor: string; cliDirectory: string };
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
export interface TailnetMachine {
  readonly name: string;
  readonly dir: string;
  readonly socket: string;
  readonly proxyUrl: string;
  readonly binDir: string;
  env(caCertFile: string): NodeJS.ProcessEnv;
}

export class TestTailnet {
  readonly dir: string;
  private readonly runtimeDir: string;
  private procs: ChildProcess[] = [];
  readonly machines: TailnetMachine[] = [];
  readonly ownerLogin = "owner";
  controlUrl = "";
  private configFile = "";
  pki!: TestPki;

  private constructor(readonly tools: TailnetTools) {
    this.dir = mkdtempSync(join(tmpdir(), "omnesis-tailnet-"));
    // Unix socket paths must stay short.
    this.runtimeDir = mkdtempSync(join(tmpdir(), "otn-"));
  }

  static async start(tools: TailnetTools): Promise<TestTailnet | PortableTestTailnet> {
    if (tools.portable) {
      const { PortableTestTailnet } = await import("./portable-tailnet-harness.js");
      return PortableTestTailnet.start(tools);
    }
    const tailnet = new TestTailnet(tools);
    try {
      await tailnet.boot();
    } catch (error) {
      try {
        await tailnet.stop({ retainInputs: ownedProcessCleanupReceipt(error) !== undefined });
      } catch (cleanup) {
        throw tailnetCleanupError([error, cleanup]);
      }
      throw error;
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
    // The relay speaks TLS, as every Tailscale client expects of one, with the
    // certificate derper makes for itself on an IP address; the DERP map pins
    // that certificate by its hash.
    const derpCerts = join(this.dir, "derp-certs");
    mkdirSync(derpCerts, { recursive: true });
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
        "-certmode",
        "manual",
        "-certdir",
        derpCerts,
      ],
      { ...process.env, TS_NO_LOGS_NO_SUPPORT: "true" },
      join(this.dir, "derper.log"),
    );
    this.procs.push(derp);
    const derpCert = join(derpCerts, "127.0.0.1.crt");
    await waitFor(() => existsSync(derpCert), "the relay's certificate", 30_000);
    const derpCertHash = createHash("sha256")
      .update(new X509Certificate(readFileSync(derpCert)).raw)
      .digest("hex");
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
        `        certname: sha256-raw:${derpCertHash}`,
        "",
      ].join("\n"),
    );
    this.controlUrl = `http://127.0.0.1:${controlPort}`;
    // Every device may reach every other, as with no policy at all; tagged
    // devices need an owner; and every device may keep its network map on
    // disk between runs, as Tailscale's own coordination server allows.
    const policy = join(this.dir, "policy.json");
    writeFileSync(
      policy,
      JSON.stringify({
        tagOwners: { "tag:server": [`${this.ownerLogin}@`] },
        acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
        nodeAttrs: [{ target: ["*"], attr: ["cache-network-maps"] }],
      }),
    );
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
        `  path: ${policy}`,
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

  /** Delete the device named `name` on the tailnet, as its owner does in the admin console. */
  async deleteNode(name: string): Promise<void> {
    const nodes = JSON.parse(await this.headscale(["nodes", "list", "-o", "json"])) as Array<{
      id: number | string;
      given_name: string;
    }>;
    const node = nodes.find((n) => n.given_name === name);
    if (!node) throw new Error(`no device named ${name} on the test tailnet`);
    await this.headscale(["nodes", "delete", "--identifier", String(node.id), "--force"]);
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
    const env = tailnetFixtureEnv(process.env);
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
    const machine: TailnetMachine = {
      name,
      dir,
      socket,
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
      binDir,
      env: (caCertFile) => tailnetMachineEnv(binDir, `http://127.0.0.1:${proxyPort}`, caCertFile),
    };
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

  async stop(options: { retainInputs?: boolean } = {}): Promise<void> {
    const results = await Promise.allSettled([
      stopTailnetCommands(this.machines),
      ...this.procs.map((proc) => killSubprocessGroup(proc)),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw tailnetCleanupError(failures.map((failure) => failure.reason as unknown));
    this.procs = [];
    if (options.retainInputs) return;
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
  private readonly startupCleanupErrors: unknown[] = [];

  constructor(
    private readonly tailnet: Pick<TestTailnet, "pki" | "tools" | "controlUrl">,
    private readonly extraEnv: NodeJS.ProcessEnv = {},
  ) {
    this.dir = mkdtempSync(join(tmpdir(), "omnesis-tailnet-gw-"));
    this.configDir = join(this.dir, "config");
    mkdirSync(this.configDir, { recursive: true });
  }

  /** Start, or start again with the same state. */
  async start(): Promise<void> {
    try {
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
      const budget = gatewayBootBudgetMs();
      const deadline = Date.now() + budget;
      this.proc = spawnE2ESubprocess(command.command, command.args, {
        cwd: REPO_ROOT,
        env: tailnetFixtureEnv({
          ...e2eGatewayEnv(),
          ...this.extraEnv,
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
        }),
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });
      await registerSubprocessGroup(this.proc);
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
        Math.max(1, deadline - Date.now()),
      );
    } catch (error) {
      if (ownedProcessCleanupReceipt(error) !== undefined) this.startupCleanupErrors.push(error);
      throw error;
    }
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

  helperPanicked(): boolean {
    return /panic:|fatal error:/u.test(readFileSync(join(this.dir, "gateway.log"), "utf8"));
  }

  async stop(): Promise<void> {
    const failures = [...this.startupCleanupErrors];
    if (this.proc) {
      try {
        await killSubprocessGroup(this.proc);
        this.proc = null;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw tailnetCleanupError(failures);
  }

  async remove(): Promise<void> {
    await this.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

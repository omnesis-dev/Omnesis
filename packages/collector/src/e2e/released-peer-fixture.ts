// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readTokenFile, readCollectorTokenFile } from "@omnesis/core";
import { runRelayCommand } from "@omnesis/cloud-relay/runtime";
import { defaultScopesForDeviceKind } from "@omnesis/types";
import { createTestPki } from "./fixture-pki.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { spawnE2ESubprocess } from "./e2e-owned-process.js";
import { registerSubprocessGroup, killSubprocessGroup } from "./subprocess-reaper.js";
import type { ChildProcess } from "node:child_process";

const devices = z.object({
  items: z.array(
    z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        online: z.boolean(),
        version: z.string().nullable(),
      })
      .passthrough(),
  ),
});
const sources = z.object({
  items: z.array(
    z
      .object({ id: z.string(), deviceId: z.string().nullable(), enabled: z.boolean() })
      .passthrough(),
  ),
});
const status = z
  .object({ sourceId: z.string(), state: z.string(), lastSyncAt: z.string().nullable() })
  .passthrough();
const hits = z.object({
  results: z.array(
    z.object({ documentId: z.string(), sourceId: z.string(), title: z.string() }).passthrough(),
  ),
});
type ChildRole =
  "gateway" | "released-pair" | "current-pair" | "released-collector" | "current-collector";
type Child = {
  process: ChildProcess;
  closed: Promise<void>;
  failed?: boolean;
  role: ChildRole;
  tail: Buffer;
  seenBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  didClose: boolean;
};
export type Peer = {
  kind: "released" | "current";
  config: string;
  home: string;
  vault: string;
  deviceId: string;
  sourceId: string;
  version: string;
};
const markerSchema = z
  .object({
    format: z.literal(1),
    owner: z.literal("omnesis-released-peer"),
    nonce: z.string().uuid(),
    image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    reference: z.string(),
    dependencyAlias: z.string().startsWith("/"),
    direction: z.enum(["released-collector", "released-gateway"]).default("released-collector"),
  })
  .strict();

const unknownTmpMount = () => ({
  state: "unknown" as const,
  filesystem: "unknown" as const,
  noexec: null,
  nosuid: null,
  nodev: null,
  readOnly: null,
});
type TmpMountFacts = {
  state: "observed" | "unknown";
  filesystem: "tmpfs" | "other" | "unknown";
  noexec: boolean | null;
  nosuid: boolean | null;
  nodev: boolean | null;
  readOnly: boolean | null;
};

/** Only this process's exact /tmp mount flags are projected, never mount paths or identities. */
export function releasedTmpMountFacts(text: string): TmpMountFacts {
  if (Buffer.byteLength(text, "utf8") > 65536 || text.includes("\0")) return unknownTmpMount();
  const matches: string[][] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const separator = line.indexOf(" - ");
    if (separator < 0) return unknownTmpMount();
    const fields = line.slice(0, separator).split(" "),
      filesystem = line.slice(separator + 3).split(" ");
    if (
      fields.length < 6 ||
      filesystem.length < 3 ||
      !/^\d+$/.test(fields[0]!) ||
      !/^\d+$/.test(fields[1]!) ||
      !/^\d+:\d+$/.test(fields[2]!) ||
      !fields[3]!.startsWith("/") ||
      !fields[4]!.startsWith("/") ||
      !/^[a-zA-Z0-9._-]+$/.test(filesystem[0]!)
    )
      return unknownTmpMount();
    if (fields[4] === "/tmp") matches.push([fields[5]!, filesystem[0]!]);
  }
  if (matches.length !== 1) return unknownTmpMount();
  const [options, filesystem] = matches[0]!,
    flags = new Set(options!.split(","));
  if (
    flags.has("rw") === flags.has("ro") ||
    flags.has("") ||
    flags.size !== options!.split(",").length ||
    (flags.has("exec") && flags.has("noexec")) ||
    (flags.has("suid") && flags.has("nosuid")) ||
    (flags.has("dev") && flags.has("nodev"))
  )
    return unknownTmpMount();
  return {
    state: "observed",
    filesystem: filesystem === "tmpfs" ? "tmpfs" : "other",
    noexec: flags.has("noexec"),
    nosuid: flags.has("nosuid"),
    nodev: flags.has("nodev"),
    readOnly: flags.has("ro"),
  };
}

/** One real gateway and two real collectors; only the model is absent. */
export class ReleasedPeerFixture {
  readonly children: Child[] = [];
  private readonly diagnosticChildren: Child[] = [];
  private tmpMount: TmpMountFacts = unknownTmpMount();
  private token = "";
  private ca = "";
  private fingerprint = "";
  private gatewayConfig = "";
  private url = "";
  private readonly cwd = process.cwd();
  private readonly require = createRequire(join(this.cwd, "package.json"));
  private readonly transports: { close(): Promise<void>; joined?: Promise<void> }[] = [];
  private certificate = "";
  private certificateFile = "";
  private stopped = false;
  private failureEvidenceAttempted = false;
  private constructor(
    readonly root: string,
    private readonly dependencyAlias: string,
    private readonly direction: "released-collector" | "released-gateway",
  ) {}

  static async create(
    direction: "released-collector" | "released-gateway" = "released-collector",
  ): Promise<ReleasedPeerFixture> {
    if (
      process.platform !== "linux" ||
      !process.env.OMNESIS_E2E_RELEASED_PEER ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
      process.env.OMNESIS_INSECURE_TLS
    )
      throw Error("The isolated strict-TLS released-peer container is required");
    if (process.version !== "v24.22.3")
      throw Error("Released image Node version differs from its observed metadata");
    const marker = markerSchema.parse(
      JSON.parse(await readFile("/run/desktop-c6-container.json", "utf8")),
    );
    if (
      marker.nonce !== process.env.OMNESIS_E2E_RELEASED_PEER ||
      marker.direction !== direction ||
      (process.env.OMNESIS_E2E_RELEASED_DIRECTION ?? "released-collector") !== direction ||
      hostname() !== `omnesis-released-peer-${marker.nonce}`
    )
      throw Error("Released peer container marker does not match this process");
    if ((await realpath(process.cwd())) !== "/tmp/omnesis-c6/current")
      throw Error("Current workspace location refused");
    const fixture = new ReleasedPeerFixture(
      await mkdtemp("/tmp/omnesis-c6/cohort-"),
      marker.dependencyAlias,
      direction,
    );
    try {
      await fixture.start();
      return fixture;
    } catch (error) {
      const failure = await fixture.recordFailure(error);
      try {
        await fixture.close();
      } catch (cleanupFailure) {
        throw Object.assign(
          new AggregateError(
            [failure, cleanupFailure],
            "Released peer startup cleanup unconfirmed",
            {
              cause: failure,
            },
          ),
          { cleanupFailure },
        );
      }
      throw failure;
    }
  }

  private environment(config: string, home: string): NodeJS.ProcessEnv {
    return e2eGatewayEnv({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: "test",
      NODE_EXTRA_CA_CERTS: join(this.root, "pki", "cohort-ca.pem"),
      OMNESIS_CONFIG_DIR: config,
      OMNESIS_GATEWAY_URL: this.url,
      OMNESIS_LOG_LEVEL: "warn",
      OMNESIS_PARENT_PID: String(process.pid),
      OMNESIS_E2E_RELEASED_PEER: process.env.OMNESIS_E2E_RELEASED_PEER,
    });
  }

  private async startChild(
    role: ChildRole,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd = this.cwd,
  ): Promise<Child> {
    if (this.diagnosticChildren.some((child) => child.role === role))
      throw Error("Released fixture child role already used");
    const process = spawnE2ESubprocess(command, args, {
      env,
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const child: Child = {
      process,
      role,
      tail: Buffer.alloc(0),
      seenBytes: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      didClose: false,
      closed: new Promise((done) =>
        process.once("close", () => {
          child.didClose = true;
          done();
        }),
      ),
    };
    this.children.push(child);
    this.diagnosticChildren.push(child);
    process.on("error", () => {
      child.failed = true;
    });
    let bytes = 0;
    for (const stream of [process.stdout!, process.stderr!]) {
      stream.on("error", () => {
        child.failed = true;
      });
      stream.on("data", (part: Buffer) => {
        bytes += part.length;
        child.seenBytes = bytes;
        if (stream === process.stdout) child.stdoutBytes += part.length;
        else child.stderrBytes += part.length;
        child.tail =
          part.length >= 65536
            ? Buffer.from(part.subarray(-65536))
            : Buffer.from(Buffer.concat([child.tail, part]).subarray(-65536));
        if (bytes > 1024 * 1024) {
          child.failed = true;
          void killSubprocessGroup(process).catch(() => {});
        }
      });
    }
    await registerSubprocessGroup(process);
    return child;
  }

  private assertRunning() {
    if (
      this.children.some(
        (child) =>
          child.failed || child.process.exitCode !== null || child.process.signalCode !== null,
      )
    )
      throw Error("An owned released-peer process stopped unexpectedly");
  }

  async wait<T>(
    read: () => Promise<T>,
    accepted: (value: T) => boolean,
    phase: string,
    budget = gatewayBootBudgetMs(),
  ): Promise<T> {
    const end = performance.now() + budget;
    while (performance.now() < end) {
      this.assertRunning();
      const value = await read();
      if (performance.now() >= end) break;
      if (accepted(value)) return value;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw Error(`Released peer phase did not finish: ${phase}`);
  }

  async json(
    path: string,
    method = "GET",
    body?: unknown,
    credential = this.token,
  ): Promise<unknown> {
    const deadline = performance.now() + 30000;
    return new Promise((done, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const client = request(
        new URL(path, this.url),
        {
          method,
          ca: this.ca,
          rejectUnauthorized: true,
          signal: AbortSignal.timeout(30000),
          headers: {
            ...(credential ? { authorization: `Bearer ${credential}` } : {}),
            ...(bytes
              ? { "content-type": "application/json", "content-length": String(bytes.length) }
              : {}),
          },
        },
        (response) => {
          const parts: Buffer[] = [];
          let count = 0;
          response.on("data", (part: Buffer) => {
            count += part.length;
            if (count > 2 * 1024 * 1024)
              response.destroy(Error("Released fixture response exceeds bound"));
            else parts.push(part);
          });
          response.on("error", reject);
          response.on("end", () => {
            if (performance.now() >= deadline)
              return reject(Error("Released fixture HTTP deadline expired"));
            if (response.statusCode !== 200 && response.statusCode !== 201)
              return reject(Error(`Released fixture HTTP status ${response.statusCode}`));
            try {
              done(JSON.parse(Buffer.concat(parts).toString("utf8")));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      client.on("error", reject);
      client.end(bytes);
    });
  }

  private async observeTmpMount() {
    try {
      const file = await open(
        "/proc/self/mountinfo",
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if ((await file.stat()).isFile()) {
          const bytes = Buffer.alloc(65537);
          let used = 0;
          while (used < bytes.length) {
            const part = await file.read(bytes, used, bytes.length - used, null);
            if (part.bytesRead === 0) break;
            used += part.bytesRead;
          }
          if (used <= 65536)
            this.tmpMount = releasedTmpMountFacts(bytes.subarray(0, used).toString("utf8"));
        }
      } finally {
        await file.close();
      }
    } catch {
      this.tmpMount = unknownTmpMount();
    }
    await writeFile(
      "/results/tmp-mount.json",
      JSON.stringify({ format: 1, tmpMount: this.tmpMount }),
      { mode: 0o600, flag: "wx" },
    ).catch(() => {});
  }

  private async start() {
    await this.observeTmpMount();
    for (const name of ["gateway", "gateway-home", "pki"])
      await mkdir(join(this.root, name), { mode: 0o700 });
    // Native dependencies remain the CURRENT mounted dependency closure, not old /app modules.
    for (const name of ["@omnesis/core", "@omnesis/gateway", "@omnesis/collector"]) {
      const entry = await realpath(this.require.resolve(name));
      if (!entry.startsWith(this.cwd + "/packages/"))
        throw Error("Current product module resolved outside copied workspace");
    }
    if (this.direction === "released-collector")
      for (const name of ["better-sqlite3", "@duckdb/node-api"]) {
        const local = createRequire(join(this.cwd, "packages/gateway/package.json"));
        const entry = await realpath(local.resolve(name));
        if (
          ![this.cwd + "/", "/run/c6-dependencies/node_modules/", this.dependencyAlias + "/"].some(
            (root) => entry.startsWith(root),
          )
        )
          throw Error("Current native dependency escaped its copied or mounted closure");
        local(name); // Load current package modules; real gateway startup exercises its stores.
      }
    const old = createRequire("/app/packages/collector/package.json");
    if (!(await realpath(old.resolve("@omnesis/core"))).startsWith("/app/"))
      throw Error("Released product dependency escaped image");
    const oldVersion = z
      .object({ version: z.literal("0.8.1") })
      .parse(JSON.parse(await readFile("/app/packages/collector/package.json", "utf8"))).version;
    if (this.direction === "released-gateway") {
      z.object({ version: z.literal("0.8.1") }).parse(
        JSON.parse(await readFile("/app/packages/gateway/package.json", "utf8")),
      );
      if (!(await realpath(old.resolve("@omnesis/gateway"))).startsWith("/app/"))
        throw Error("Released gateway dependency escaped image");
    }
    const pki = await createTestPki(join(this.root, "pki"), "cohort");
    const leaf = await pki.leaf("gateway", ["127.0.0.1", "localhost"]);
    this.ca = pki.caCert;
    this.certificate = leaf.cert;
    this.certificateFile = leaf.certFile;
    this.fingerprint = new X509Certificate(leaf.cert).fingerprint256
      .replaceAll(":", "")
      .toLowerCase();
    const socket = createServer();
    await new Promise<void>((done, reject) => {
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", done);
    });
    const address = socket.address();
    if (!address || typeof address === "string") throw Error("Owned gateway port missing");
    const port = address.port;
    await new Promise<void>((done, reject) =>
      socket.close((error) => (error ? reject(error) : done())),
    );
    this.url = `https://127.0.0.1:${port}`;
    this.gatewayConfig = join(this.root, "gateway");
    await writeFile(
      join(this.gatewayConfig, "omnesis.json"),
      JSON.stringify({
        inference: {
          assignments: { embedder: null, agent: null, transcriber: null, "background-agent": null },
        },
      }),
      { mode: 0o600 },
    );
    const invocation =
      this.direction === "released-gateway"
        ? { command: process.execPath, args: ["/app/packages/gateway/dist/index.js"] }
        : e2eTsxCommand("packages/gateway/src/index.ts");
    await this.startChild(
      "gateway",
      invocation.command,
      invocation.args,
      {
        ...this.environment(this.gatewayConfig, join(this.root, "gateway-home")),
        OMNESIS_GATEWAY_PORT: String(port),
        OMNESIS_DB_PATH: join(this.gatewayConfig, "gateway.db"),
        OMNESIS_TLS_CERT: leaf.certFile,
        OMNESIS_TLS_KEY: leaf.keyFile,
        OMNESIS_TLS_CA: pki.caCertFile,
      },
      this.direction === "released-gateway" ? "/app" : this.cwd,
    );
    await this.wait(
      async () => {
        this.token = readTokenFile(this.gatewayConfig) ?? "";
        if (!this.token) return false;
        try {
          await this.json("/whoami");
          await this.json("/health");
          return true;
        } catch {
          return false;
        }
      },
      Boolean,
      "gateway-authenticated-readiness",
    );
    await writeFile(
      "/results/runtime.json",
      JSON.stringify({
        format: 1,
        node: process.version,
        tmpMount: this.tmpMount,
        abi: process.versions.modules,
        releasedVersion: oldVersion,
        direction: this.direction,
        currentSourceScope: true,
        currentPackagedNodeQualified: false,
        currentProductResolutionOwned: true,
        releasedProductResolutionOwned: true,
      }),
      { mode: 0o600, flag: "wx" },
    );
  }

  async addPeer(
    kind: "released" | "current",
    initial: { name: string; text: string },
  ): Promise<Peer> {
    const config = join(this.root, kind),
      home = join(this.root, `${kind}-home`),
      vault = join(this.root, `${kind}-vault`);
    for (const directory of [config, home, vault, join(vault, ".obsidian")])
      await mkdir(directory, { mode: 0o700 });
    await writeFile(join(vault, initial.name + ".md"), `# ${initial.name}\n\n${initial.text}\n`, {
      mode: 0o600,
    });
    const env = {
      ...this.environment(config, home),
      OMNESIS_COLLECTOR_HOSTNAME: `fictional-${kind}`,
    };
    const pair = z.object({ pairingCode: z.string() }).parse(
      await this.json("/admin/devices/pair", "POST", {
        kind: "collector",
        name: `Fictional ${kind} collector`,
      }),
    );
    const cli =
      kind === "released"
        ? { command: process.execPath, args: ["/app/packages/cli/dist/index.js"] }
        : e2eTsxCommand("packages/cli/src/index.ts");
    const commandDeadline = performance.now() + 60000;
    const command = await this.startChild(
      `${kind}-pair`,
      cli.command,
      [
        ...cli.args,
        "pair",
        pair.pairingCode,
        "--gateway-url",
        this.url,
        "--trust-fingerprint",
        this.fingerprint,
        "--save",
        join(config, "collector-token"),
      ],
      env,
      kind === "released" ? "/app" : this.cwd,
    );
    let expired = false,
      stopping: Promise<void> | undefined;
    const timer = setTimeout(
      () => {
        expired = true;
        stopping = killSubprocessGroup(command.process);
        void stopping.catch(() => {});
      },
      Math.max(0, commandDeadline - performance.now()),
    );
    await command.closed;
    expired ||= performance.now() >= commandDeadline;
    clearTimeout(timer);
    await stopping;
    await killSubprocessGroup(command.process);
    this.children.splice(this.children.indexOf(command), 1);
    if (expired || command.failed || command.process.exitCode !== 0)
      throw Error("Actual collector pairing command refused");
    const token = readCollectorTokenFile(config);
    if (!token) throw Error("Actual collector pairing credential missing");
    const identity = z
      .object({ deviceId: z.string().uuid(), scopes: z.array(z.string()) })
      .parse(await this.json("/whoami", "GET", undefined, token));
    if (
      JSON.stringify([...identity.scopes].sort()) !==
      JSON.stringify([...defaultScopesForDeviceKind("collector")].sort())
    )
      throw Error("Collector credential identity or default role grant differs");
    const collector =
      kind === "released"
        ? { command: process.execPath, args: ["/app/packages/collector/dist/main.js"] }
        : e2eTsxCommand("packages/collector/src/main.ts");
    await this.startChild(
      `${kind}-collector`,
      collector.command,
      collector.args,
      env,
      kind === "released" ? "/app" : this.cwd,
    );
    const page = await this.wait(
      async () => devices.parse(await this.json("/admin/devices")),
      (value) =>
        value.items.some(
          (item) =>
            item.id === identity.deviceId && item.online && typeof item.version === "string",
        ),
      `${kind}-collector-authenticated-websocket`,
    );
    const device = page.items.find((item) => item.id === identity.deviceId)!;
    const expectedVersion = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(
          await readFile(
            kind === "released"
              ? "/app/packages/collector/package.json"
              : join(this.cwd, "packages/collector/package.json"),
            "utf8",
          ),
        ),
      ).version;
    const advertisedVersion = z.string().parse(device.version);
    if (advertisedVersion !== expectedVersion)
      throw Error("Collector advertised version differs from its actual package");
    const resolved = z.object({ accountId: z.string() }).parse(
      await this.json("/admin/sources/resolve-account", "POST", {
        deviceId: device.id,
        descriptorId: "obsidian-notes",
        params: { vaultPath: vault },
      }),
    );
    await this.json("/admin/sources/add", "POST", {
      deviceId: device.id,
      descriptorId: "obsidian-notes",
      accountIds: [resolved.accountId],
      params: { vaultPath: vault },
    });
    const registered = await this.wait(
      async () => sources.parse(await this.json("/admin/sources")),
      (value) => value.items.some((item) => item.deviceId === device.id),
      `${kind}-source-registration`,
    );
    return {
      kind,
      config,
      home,
      vault,
      deviceId: device.id,
      sourceId: registered.items.find((item) => item.deviceId === device.id)!.id,
      version: advertisedVersion,
    };
  }

  /** Real QR grants prove only role authority; they do not claim account enrollment. */
  async desktopProtectionRefusal() {
    if (this.direction !== "released-gateway") throw Error("Released gateway required");
    const path = await realpath(this.require.resolve("omnesis/src/desktop/remote-protection.ts"));
    if (path !== join(this.cwd, "packages/cli/src/desktop/remote-protection.ts"))
      throw Error("Desktop protection reader escaped current source");
    const module = z
      .object({
        readDesktopRemoteProtection: z.custom<
          (
            transport: { url: string },
            pairing: { token: string },
            signal: AbortSignal,
          ) => Promise<unknown>
        >((value) => typeof value === "function"),
      })
      .parse(await import(pathToFileURL(path).href));
    const identities: string[] = [];
    const outcomes: string[] = [];
    for (const kind of ["cli", "collector"] as const) {
      const pending = z.object({ pairingCode: z.string() }).parse(
        await this.json("/admin/devices/pair", "POST", {
          kind,
          name: `Fictional desktop ${kind}`,
        }),
      );
      const redeemed = z
        .object({
          token: z.string(),
          scopes: z.array(z.string()),
          device: z.object({ id: z.string().uuid(), kind: z.literal(kind) }),
        })
        .parse(await this.json("/devices/pair", "POST", { pairingCode: pending.pairingCode }, ""));
      const identity = z
        .object({ deviceId: z.string().uuid(), scopes: z.array(z.string()) })
        .parse(await this.json("/whoami", "GET", undefined, redeemed.token));
      const scopes = defaultScopesForDeviceKind(kind);
      if (
        identity.deviceId !== redeemed.device.id ||
        JSON.stringify([...identity.scopes].sort()) !== JSON.stringify([...scopes].sort()) ||
        JSON.stringify([...redeemed.scopes].sort()) !== JSON.stringify([...scopes].sort())
      )
        throw Error("Actual desktop role authority differs");
      identities.push(identity.deviceId);
      const transport = await runRelayCommand("client", {
        OMNESIS_CLOUD_RELAY_GATEWAY_URL: this.url,
        OMNESIS_CLOUD_RELAY_GATEWAY_FINGERPRINT: this.fingerprint,
        OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE: this.certificateFile,
        OMNESIS_CLOUD_RELAY_CLIENT_PORT: "0",
      });
      if (!transport) throw Error("Real pinned production transport missing");
      // Retain before the first request; fixture close joins this exact transport too.
      const owner = {
        close: () => transport.close(),
        joined: undefined as Promise<void> | undefined,
      };
      this.transports.push(owner);
      const signal = new AbortController().signal;
      let failure: unknown;
      try {
        const pairedJson = async (path: "/whoami" | "/health") => {
          const deadline = performance.now() + 15000;
          const response = await fetch(new URL(path, transport.url), {
            headers: { authorization: `Bearer ${redeemed.token}` },
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw Error("Pinned role request refused");
          }
          const reader = response.body.getReader();
          const parts: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > 65536) throw Error("Pinned response exceeds bound");
              parts.push(next.value);
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          if (performance.now() >= deadline) throw Error("Pinned response deadline expired");
          return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
        };
        const proxied = z
          .object({ deviceId: z.string().uuid() })
          .parse(await pairedJson("/whoami"));
        if (proxied.deviceId !== identity.deviceId) throw Error("Pinned proxy identity changed");
        const health = z
          .object({
            version: z.literal("0.8.1"),
            compat: z.object({ ws: z.literal(1), pairing: z.literal(4) }),
          })
          .passthrough()
          .parse(await pairedJson("/health"));
        if (Object.hasOwn(health, "storageProtection"))
          throw Error("Released protection contract changed");
        const pairing = {
          kind,
          token: redeemed.token,
          scopes,
          deviceId: identity.deviceId,
          gatewayUrl: this.url,
          gatewayFingerprint: this.fingerprint,
          gatewayCertificate: this.certificate,
        };
        outcomes.push(
          z
            .enum(["encrypted", "unprotected", "unavailable"])
            .parse(await module.readDesktopRemoteProtection(transport, pairing, signal)),
        );
        const after = z.object({ deviceId: z.string().uuid() }).parse(await pairedJson("/whoami"));
        if (after.deviceId !== identity.deviceId)
          throw Error("Pinned proxy authority changed after observation");
      } catch (error) {
        failure = error;
      }
      try {
        owner.joined ??= owner.close();
        await owner.joined;
      } catch (cleanupFailure) {
        throw Object.assign(
          new AggregateError(
            [...(failure ? [failure] : []), cleanupFailure],
            "Pinned observation transport cleanup unconfirmed",
            { cause: failure ?? cleanupFailure },
          ),
          { cleanupFailure },
        );
      }
      if (failure) throw failure;
    }
    if (identities[0] === identities[1]) throw Error("Desktop role grants were merged");
    return { outcomes, independentDesktopGrants: true as const };
  }

  async note(peer: Peer, name: string, text: string) {
    await writeFile(join(peer.vault, name + ".md"), `# ${name}\n\n${text}\n`, { mode: 0o600 });
  }
  async search(text: string) {
    return hits.parse(await this.json("/search", "POST", { text, limit: 20 })).results;
  }
  async sync(peer: Peer) {
    return z
      .object({
        result: z
          .object({
            ok: z.literal(true),
            triggered: z.number(),
            skipped: z.number(),
            disabled: z.number(),
          })
          .passthrough(),
      })
      .parse(await this.json(`/admin/sources/${encodeURIComponent(peer.sourceId)}/sync`, "POST"));
  }
  async sourceStatus(peer: Peer) {
    return status.parse(await this.json(`/admin/sync/status/${encodeURIComponent(peer.sourceId)}`));
  }
  async settled(peer: Peer, after?: string | null) {
    return this.wait(
      () => this.sourceStatus(peer),
      (value) =>
        value.state === "synced" && value.lastSyncAt !== null && value.lastSyncAt !== after,
      `${peer.kind}-sync-settled`,
    );
  }
  async pause(peer: Peer, paused: boolean) {
    await this.json(`/admin/sources/${encodeURIComponent(peer.sourceId)}`, "PATCH", {
      enabled: !paused,
    });
  }

  /** Private failure-only output observations; never a stack, readiness or cleanup proof. */
  async recordFailure(
    failure: unknown,
    boundary: "before-close" | "close-failed" = "before-close",
  ): Promise<unknown> {
    if (this.failureEvidenceAttempted) return failure;
    this.failureEvidenceAttempted = true;
    const observations = this.diagnosticChildren.map((child) => ({
      role: child.role,
      tail: Buffer.from(child.tail),
      seenBytes: child.seenBytes,
      stdoutBytes: child.stdoutBytes,
      stderrBytes: child.stderrBytes,
      rootClosed: child.didClose,
      exitCode: child.process.exitCode,
      signalCode: child.process.signalCode,
      failed: child.failed === true,
    }));
    try {
      const metadata = [];
      for (const observation of observations) {
        const leaf = `child-${observation.role}.log`;
        await writeFile(join("/results", leaf), observation.tail, { mode: 0o600, flag: "wx" });
        const { tail, ...finite } = observation;
        metadata.push({
          ...finite,
          leaf,
          capturedBytes: tail.length,
          truncated: observation.seenBytes > tail.length,
        });
      }
      await writeFile(
        "/results/child-evidence.json",
        JSON.stringify({
          format: 1,
          observations: metadata,
          tmpMount: this.tmpMount,
          causality: "output-observation-only",
          boundary,
          snapshottedBeforeFixtureClose: boundary === "before-close",
        }),
        { mode: 0o600, flag: "wx" },
      );
      return failure;
    } catch (evidenceFailure) {
      return new AggregateError(
        [failure, evidenceFailure],
        "Released fixture failure evidence unavailable",
        { cause: failure },
      );
    }
  }

  async close() {
    if (this.stopped) return;
    const results = await Promise.allSettled([
      ...this.transports.map((owner) => (owner.joined ??= owner.close())),
      ...this.children.map(async (child) => {
        await killSubprocessGroup(child.process);
        await child.closed;
      }),
    ]);
    const failures = results.filter((value) => value.status === "rejected");
    if (failures.length)
      throw Object.assign(
        new AggregateError(
          failures.map((value) => value.reason),
          "Released peer child cleanup unconfirmed",
        ),
        { cleanupFailure: "released-peer-child" },
      );
    this.stopped = true;
    await rm(this.root, { recursive: true });
  }
}

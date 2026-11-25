// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

import { e2eGatewayEnv } from "./gateway-env.js";

const execute = promisify(execFile);
const cli = resolve("packages/cli/src/index.ts");
const bootstrap = new URL("../../../cli/src/desktop/bootstrap.ts", import.meta.url).href;
const runtime = new URL("../../../cli/src/desktop/runtime-state.ts", import.meta.url).href;
const profileModule = new URL("../../../cli/src/desktop/environment.ts", import.meta.url).href;
const access = new URL("../../../cli/src/desktop/gateway-access.ts", import.meta.url).href;

/** Generated stand-in for the external OS command; no production OS credential API is touched. */
export function desktopKeychainFixtureProgram(
  root: string,
  node: string = process.execPath,
): string {
  return `#!${node}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
if (args[0] === '-h') process.exit(0);
if (fs.existsSync(${JSON.stringify(join(root, "keychain-locked"))})) process.exit(36);
const option = flag => args[args.indexOf(flag) + 1];
const key = crypto.createHash('sha256').update(JSON.stringify([option('-s'), option('-a')])).digest('hex');
const file = path.join(${JSON.stringify(join(root, "keychain"))}, key);
if (args[0] === 'find-generic-password') {
  if (!fs.existsSync(file)) process.exit(44);
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  process.stdout.write(String.fromCharCode(10));
} else if (args[0] === 'add-generic-password' && !args.includes('-U')) {
  try { fs.writeFileSync(file, option('-w'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') process.exit(45); throw error; }
} else if (args[0] === 'add-generic-password') {
  const temporary = file + '.' + process.pid;
  fs.writeFileSync(temporary, option('-w'), { mode: 0o600 });
  fs.renameSync(temporary, file);
} else if (args[0] === 'delete-generic-password') fs.rmSync(file, { force: true });
else process.exit(2);
`;
}

/** Only the external OS Keychain executable is substituted; desktop/core/daemons remain real. */
export class DesktopRuntimeFixture {
  private constructor(
    readonly root: string,
    private readonly relay: Server,
    readonly relayUrl: string,
    readonly profile: { configDir: string; instance: string; secretService: string },
  ) {}
  get home() {
    return join(this.root, "home");
  }
  get environment(): NodeJS.ProcessEnv {
    return {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith("OMNESIS_") &&
            key !== "NODE_OPTIONS" &&
            key !== "NODE_EXTRA_CA_CERTS" &&
            key !== "NODE_TLS_REJECT_UNAUTHORIZED",
        ),
      ),
      HOME: this.home,
      USERPROFILE: this.home,
      PATH: join(this.root, "tools") + delimiter + (process.env.PATH ?? ""),
      OMNESIS_CONFIG_DIR: this.profile.configDir,
      OMNESIS_SECRET_SERVICE: this.profile.secretService,
      OMNESIS_SECRET_STORE: "macos-keychain",
    };
  }
  static async create(options: { scriptedAgent?: { url: string; modelId: string } } = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-managed-desktop-e2e-")));
    const relay = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/_relay/v3/signup/access")
        response.end(JSON.stringify({ signup: { inviteOnly: true } }));
      else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    try {
      await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done));
      const address = relay.address();
      if (!address || typeof address === "string") throw new Error("Fixture relay did not bind");
      const selected = await execute(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const {desktopProfile} = await import(${JSON.stringify(profileModule)}); process.stdout.write(JSON.stringify(desktopProfile(${JSON.stringify(join(root, "home"))})));`,
        ],
        { timeout: 10_000 },
      );
      const fixture = new DesktopRuntimeFixture(
        root,
        relay,
        `http://127.0.0.1:${address.port}`,
        JSON.parse(selected.stdout),
      );
      await mkdir(join(root, "tools"), { recursive: true });
      await mkdir(join(root, "keychain"));
      await mkdir(fixture.home);
      // One private file per service/account avoids introducing a mock-store write race.
      const security = desktopKeychainFixtureProgram(root);
      await writeFile(join(root, "tools/security"), security, { mode: 0o700 });
      await chmod(join(root, "tools/security"), 0o700);
      await fixture.script(`
      const { prepareDesktopInstall } = await import(${JSON.stringify(bootstrap)});
      const { prepareDesktopRuntime } = await import(${JSON.stringify(runtime)});
      await prepareDesktopInstall(profile, {mode:'home',totalMemoryBytes:8*1024**3,signal:new AbortController().signal});
      await prepareDesktopRuntime(profile);
    `);
      const configPath = join(fixture.profile.configDir, "omnesis.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      // Existing model-choice policy deliberately permits the owner to disable
      // embeddings. This lifecycle suite performs no model download or inference.
      config.inference.assignments.embedder = null;
      if (options.scriptedAgent) {
        config.inference.backends = {
          ...config.inference.backends,
          scripted: { type: "http", url: options.scriptedAgent.url },
        };
        config.inference.assignments.agent = `scripted/${options.scriptedAgent.modelId}`;
      }
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await writeFile(
        join(fixture.profile.configDir, ".env"),
        [
          ...Object.entries(e2eGatewayEnv({})).map(([key, value]) => `${key}=${value}`),
          `OMNESIS_CLOUD_RELAY_URL=${fixture.relayUrl}`,
          `OMNESIS_ACME_DIRECTORY_URL=${fixture.relayUrl}/directory`,
          "OMNESIS_ACME_TERMS_ACCEPTED=1",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      return fixture;
    } catch (error) {
      if (relay.listening) await new Promise<void>((done) => relay.close(() => done()));
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
  async script(body: string): Promise<string> {
    const program = `const profile = ${JSON.stringify(this.profile)}; ${body}`;
    const result = await execute(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", program],
      {
        env: this.environment,
        cwd: resolve("."),
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return result.stdout.trim();
  }
  async setKeychainLocked(locked: boolean): Promise<void> {
    const path = join(this.root, "keychain-locked");
    if (locked) await writeFile(path, "locked", { mode: 0o600 });
    else await rm(path, { force: true });
  }
  async collectorDeviceId(): Promise<string | null> {
    return JSON.parse(
      await this.script(`
      const {readCollectorPairingState} = await import('@omnesis/core');
      const pairing = await readCollectorPairingState(profile.configDir);
      process.stdout.write(JSON.stringify(pairing?.state === 'paired' ? pairing.deviceId : null));
    `),
    );
  }
  async request(path: string, options: Record<string, unknown> = {}): Promise<unknown> {
    return JSON.parse(
      await this.script(
        `const { requestDesktopGateway } = await import(${JSON.stringify(access)}); process.stdout.write(JSON.stringify(await requestDesktopGateway(profile, ${JSON.stringify(path)}, ${JSON.stringify(options)})));`,
      ),
    );
  }
  async command(
    command: string,
    params?: unknown,
    inherited: NodeJS.ProcessEnv = {},
  ): Promise<Record<string, unknown>> {
    const child = spawn(process.execPath, ["--import", "tsx", cli, "desktop", "bridge"], {
      cwd: resolve("."),
      env: { ...this.environment, ...inherited },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new Promise((done, reject) => {
      let output = "";
      let diagnostic = "";
      let failure: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        failure = new Error("Desktop command timed out");
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      }, 180_000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("\n")) child.stdin.end();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-4096);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (failure) return reject(failure);
        if (code !== 0) return reject(new Error(`Desktop bridge failed: ${diagnostic}`));
        try {
          const reply = JSON.parse(output.trim());
          if (reply.ok !== true) throw new Error("Desktop bridge refused command");
          done(reply.result);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.write(
        JSON.stringify({
          version: 1,
          id: "fixture-command",
          command,
          ...(params === undefined ? {} : { params }),
        }) + "\n",
      );
    });
  }
  async close() {
    try {
      const plan = await this.command("removePreview", { eraseData: true });
      if (plan.available !== true)
        throw new Error("Fixture cleanup could not prove retirement; its state was retained");
      if (plan.available === true) {
        if (typeof plan.confirmationId !== "string")
          throw new Error("Fixture removal was not confirmed");
        const result = await this.command("remove", {
          eraseData: true,
          confirmationId: plan.confirmationId,
        });
        if (result.data !== "erased" || result.keyring !== "cleared")
          throw new Error("Fixture runtime did not finish retiring");
      }
      await rm(this.root, { recursive: true, force: true });
    } finally {
      await new Promise<void>((done, reject) =>
        this.relay.close((error) => (error ? reject(error) : done())),
      );
    }
  }
}

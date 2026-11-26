// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  lstat,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

import { createDesktopNodeAdapter } from "./desktop-node-adapter.js";
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
} else if (args[0] === 'delete-generic-password') {
  if (fs.existsSync(${JSON.stringify(join(root, "keychain-delete-denied"))})) process.exit(77);
  const denied=${JSON.stringify(join(root, "keychain-denied-service"))};
  if(fs.existsSync(denied)&&fs.readFileSync(denied,'utf8')===option('-s'))process.exit(77);
  const noop=${JSON.stringify(join(root, "keychain-noop-service"))};
  if (!fs.existsSync(${JSON.stringify(join(root, "keychain-delete-noop"))})&&
      !(fs.existsSync(noop)&&fs.readFileSync(noop,'utf8')===option('-s')))fs.rmSync(file, { force: true });
}
else process.exit(2);
`;
}

/** Fixed test-owned external command; production purge/absence checks remain real. */
export function desktopFixturePurgeProgram(root: string): string {
  const codex = new URL("../../../cli/src/desktop/codex-keyring.ts", import.meta.url).href;
  const purge = new URL("../../../cli/src/uninstall/keyring-purge.ts", import.meta.url).href;
  return `
    const fixtureFs=await import('node:fs/promises');
    const {execFile:fixtureExecFile}=await import('node:child_process');
    const {promisify:fixturePromisify}=await import('node:util');
    const fixtureCore=await import('@omnesis/core');
    const {purgeDesktopCodexKeyring:fixturePurgeCodex}=await import(${JSON.stringify(codex)});
    const {purgeConfigDirKeyring:fixturePurgeRoot,defaultKeyringPurgeDeps:fixtureDefaultPurge}=await import(${JSON.stringify(purge)});
    const fixtureExecutable=${JSON.stringify(join(root, "tools/security"))};
    const fixtureInfo=await fixtureFs.lstat(fixtureExecutable);
    if(!fixtureInfo.isFile()||fixtureInfo.isSymbolicLink()||fixtureInfo.nlink!==1||
       (fixtureInfo.mode&0o077)!==0||(process.getuid&&fixtureInfo.uid!==process.getuid())||
       await fixtureFs.realpath(fixtureExecutable)!==fixtureExecutable)throw new Error('The fixture OS command is not owned');
    const fixtureExecute=fixturePromisify(fixtureExecFile);
    const fixtureRun=async(command,args)=>{
      if(command!=='security'&&command!=='/usr/bin/security')throw new Error('Unexpected fixture OS command');
      try {
        const result=await fixtureExecute(fixtureExecutable,args,{env:process.env,timeout:10000,maxBuffer:65536});
        return {code:0,stdout:result.stdout,stderr:result.stderr};
      }catch(error){
        if(typeof error.code==='number')return {code:error.code,stdout:error.stdout??'',stderr:error.stderr??''};
        throw new Error('The fixture OS command could not finish',{cause:error});
      }
    };
    const fixturePurge=async(current)=>{
      if(current.configDir!==profile.configDir||current.instance!==profile.instance||current.secretService!==profile.secretService)
        throw new Error('The fixture keyring scope changed');
      await fixturePurgeCodex(current,async(args)=>(await fixtureRun('security',[...args])).code);
      return fixturePurgeRoot(${JSON.stringify(join(root, "home"))},current.configDir,{
        ...fixtureDefaultPurge(${JSON.stringify(join(root, "home"))}),
        clearMarker:(kind,options)=>fixtureCore.clearMarkerKeyringState(kind,{...options,runCommand:fixtureRun}),
        deleteRootKey:async(options)=>{
          const store=fixtureCore.createSecretStore({...options,runCommand:fixtureRun});
          if(store.backend!=='macos-keychain'||!(await store.status()).available)return false;
          await store.delete(fixtureCore.OMNESIS_INSTALL_ROOT_KEY);
          return true;
        },
      },{service:current.secretService,backend:'macos-keychain',exclusiveService:true});
    };
  `;
}

/** Only fixed outcome enums reach test diagnostics; never echo an unexpected response body. */
export function desktopFixtureRetirementFailure(result: {
  status?: unknown;
  data?: unknown;
  keyring?: unknown;
}): Error {
  const status =
    ["retired", "not-installed", "key-cleanup-pending"].find((value) => value === result.status) ??
    "unknown";
  const data = ["erased", "retained", "absent"].find((value) => value === result.data) ?? "unknown";
  const keyring =
    ["cleared", "pending", "retained", "unchanged"].find((value) => value === result.keyring) ??
    "unknown";
  const reason =
    keyring === "pending"
      ? "KEY_CLEANUP_PENDING"
      : data !== "erased"
        ? "DATA_NOT_ERASED"
        : keyring !== "cleared"
          ? "KEY_CLEANUP_UNCONFIRMED"
          : status !== "retired"
            ? "STATUS_UNCONFIRMED"
            : "UNVERIFIED_RETIREMENT";
  return new Error(
    `Fixture retirement incomplete: reason=${reason},data=${data},keyring=${keyring}`,
  );
}

/** Linux source harness: fixed fake OS credentials, real desktop/core/daemons; native macOS proof is separate. */
export class DesktopRuntimeFixture {
  private constructor(
    readonly root: string,
    private readonly relay: Server,
    readonly relayUrl: string,
    private readonly nodeExecutable: string,
    readonly profile: { configDir: string; instance: string; secretService: string },
  ) {}
  private ownedBridgeEntry: string | undefined;
  async useOwnedBridgeEntry(path: string): Promise<void> {
    const owned = await realpath(path);
    if (!owned.startsWith(this.root + "/") || !(await lstat(owned)).isFile())
      throw new Error("A fixture bridge entry must belong to its isolated root");
    this.ownedBridgeEntry = owned;
  }
  private bridgeArguments(): string[] {
    return [
      "--import",
      "tsx",
      ...(this.ownedBridgeEntry ? [this.ownedBridgeEntry] : [cli, "desktop", "bridge"]),
    ];
  }
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
  static async create(
    options: {
      scriptedAgent?: { url: string; modelId: string };
      systemTrustRuntime?: boolean;
      relayUrl?: string;
      prepareInstall?: boolean;
      gatewayEnv?: NodeJS.ProcessEnv;
    } = {},
  ) {
    if (process.platform !== "linux")
      throw new Error(
        "The source desktop fixture requires Linux and its fake OS keyring; use the native macOS qualification separately",
      );
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
      const nodeExecutable = options.systemTrustRuntime
        ? await createDesktopNodeAdapter(join(root, "node-runtime"))
        : process.execPath;
      const selected = await execute(
        nodeExecutable,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `const {desktopProfile} = await import(${JSON.stringify(profileModule)}); process.stdout.write(JSON.stringify(desktopProfile(${JSON.stringify(join(root, "home"))})));`,
        ],
        { timeout: 10_000 },
      );
      const fixture = new DesktopRuntimeFixture(
        root,
        relay,
        options.relayUrl ?? `http://127.0.0.1:${address.port}`,
        nodeExecutable,
        JSON.parse(selected.stdout),
      );
      await mkdir(join(root, "tools"), { recursive: true });
      await mkdir(join(root, "keychain"));
      await mkdir(fixture.home);
      // One private file per service/account avoids introducing a mock-store write race.
      const security = desktopKeychainFixtureProgram(root, nodeExecutable);
      await writeFile(join(root, "tools/security"), security, { mode: 0o700 });
      await chmod(join(root, "tools/security"), 0o700);
      if (options.prepareInstall !== false)
        await fixture.script(`
      const { prepareDesktopInstall } = await import(${JSON.stringify(bootstrap)});
      const { prepareDesktopRuntime } = await import(${JSON.stringify(runtime)});
      await prepareDesktopInstall(profile, {mode:'home',totalMemoryBytes:8*1024**3,signal:new AbortController().signal});
      await prepareDesktopRuntime(profile);
    `);
      if (options.prepareInstall !== false) {
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
      } else {
        await mkdir(fixture.profile.configDir, { recursive: true, mode: 0o700 });
      }
      if (options.prepareInstall !== false)
        await writeFile(
          join(fixture.profile.configDir, ".env"),
          [
            ...Object.entries({ ...e2eGatewayEnv({}), ...options.gatewayEnv })
              .filter((entry) => entry[1] !== undefined)
              .map(([key, value]) => `${key}=${value}`),
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
      this.nodeExecutable,
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
  /** Scan a stopped owned fixture, including conversation/transcript sidecars and database files. */
  async plaintextFiles(needle: string): Promise<string[]> {
    const marker = Buffer.from(needle);
    if (marker.length === 0) throw new Error("A plaintext probe needs a marker");
    const matches: string[] = [];
    let entries = 0;
    const visit = async (path: string, relative: string): Promise<void> => {
      if (++entries > 20_000) throw new Error("The fixture plaintext scan exceeded its bound");
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) {
        for (const name of await readdir(path))
          await visit(join(path, name), relative ? `${relative}/${name}` : name);
      } else if (info.isFile()) {
        let tail: Buffer = Buffer.alloc(0);
        for await (const chunk of createReadStream(path)) {
          const bytes = Buffer.concat([tail, Buffer.from(chunk)]);
          if (bytes.includes(marker)) {
            matches.push(relative);
            break;
          }
          tail = bytes.subarray(Math.max(0, bytes.length - marker.length + 1));
        }
      }
    };
    await visit(this.home, "");
    return matches;
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
    const child = spawn(this.nodeExecutable, this.bridgeArguments(), {
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
  /** Real private bridge interactions, without replacing discovery, pairing or account policy. */
  async interactiveCommand(
    command: string,
    params: unknown,
    interact: (interaction: {
      id: string;
      kind: string;
      [key: string]: unknown;
    }) => Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    const child = spawn(this.nodeExecutable, this.bridgeArguments(), {
      cwd: resolve("."),
      env: this.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new Promise((resolveResult, reject) => {
      let frames = "",
        diagnostic = "",
        result: Record<string, unknown> | undefined,
        failure: Error | undefined;
      let pending = Promise.resolve(),
        force: NodeJS.Timeout | undefined;
      const fail = (error: unknown) => {
        failure ??= error instanceof Error ? error : new Error("The fixture interaction failed");
        child.stdin.end();
        child.kill("SIGTERM");
        force ??= setTimeout(() => child.kill("SIGKILL"), 5000);
      };
      const timeout = setTimeout(
        () => fail(new Error("The fixture desktop interaction timed out")),
        300_000,
      );
      child.stdin.on("error", () => {});
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-4096);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        frames += chunk.toString();
        if (frames.length > 1024 * 1024)
          return fail(new Error("The fixture bridge frame is too large"));
        let end: number;
        while ((end = frames.indexOf("\n")) !== -1) {
          const frame = frames.slice(0, end);
          frames = frames.slice(end + 1);
          pending = pending
            .then(async () => {
              const reply = JSON.parse(frame);
              if (reply.event === "interaction") {
                const interaction = reply.interaction;
                if (
                  !interaction ||
                  typeof interaction.id !== "string" ||
                  typeof interaction.kind !== "string"
                )
                  throw new Error("Invalid fixture interaction");
                const value = await interact(interaction);
                child.stdin.write(
                  JSON.stringify({
                    version: 1,
                    id: `reply-${interaction.id}`,
                    command: "respond",
                    params: { interactionId: interaction.id, value },
                  }) + "\n",
                );
              } else if (reply.id === "fixture-command") {
                if (reply.ok !== true)
                  throw new Error("The desktop bridge refused the fixture command");
                result = reply.result;
                child.stdin.end();
              } else if (reply.ok !== true)
                throw new Error("The desktop bridge refused the fixture response");
            })
            .catch(fail);
        }
      });
      child.once("error", fail);
      child.once("close", (code) => {
        clearTimeout(timeout);
        clearTimeout(force);
        void pending.then(() => {
          if (failure) reject(failure);
          else if (code !== 0 || !result)
            reject(new Error(`The desktop bridge did not finish: ${diagnostic}`));
          else resolveResult(result);
        });
      });
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
      const journal = await lstat(join(this.profile.configDir, "desktop-install.json")).catch(
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        },
      );
      // The actual bootstrap writes this journal before minting keys or permitting any daemon.
      if (!journal) {
        await rm(this.root, { recursive: true, force: true });
        return;
      }
      const plan = await this.command("removePreview", { eraseData: true });
      if (plan.available !== true)
        throw new Error("Fixture cleanup could not prove retirement; its state was retained");
      if (plan.available === true) {
        if (typeof plan.confirmationId !== "string")
          throw new Error("Fixture removal was not confirmed");
        // This source-only fixture substitutes the OS authority adapter explicitly.
        // It runs no vendor SDKs; actual native orphan/descriptor proof belongs to macOS tests.
        const removal = new URL("../../../cli/src/desktop/removal.ts", import.meta.url).href;
        const result = JSON.parse(
          await this.script(`
          const {readFile} = await import('node:fs/promises');
          const config=JSON.parse(await readFile(profile.configDir+'/omnesis.json','utf8'));
          for(const selected of Object.values(config.inference?.assignments??{})) {
            if(typeof selected!=='string')continue;
            const backend=config.inference?.backends?.[selected.split('/')[0]];
            if(['codex','claude-code'].includes(backend?.type))throw new Error('The source fixture cannot prove vendor process ownership');
          }
          const {removeDesktopInstall,finishDesktopErase}=await import(${JSON.stringify(removal)});
          ${desktopFixturePurgeProgram(this.root)}
          const signal=new AbortController().signal;
          const result=await removeDesktopInstall(profile,{eraseData:true,confirmationId:${JSON.stringify(plan.confirmationId)},signal},{
            purge:fixturePurge,
            executeErase:async(current,id,signal,operations)=>finishDesktopErase(current,id,signal,{
              ...operations,
              authorize:(actual,purpose,operationId)=>{
                if(actual.configDir!==profile.configDir||actual.instance!==profile.instance||actual.secretService!==profile.secretService||purpose!=='erase'||operationId!==id)
                  throw new Error('The owned source fixture authority changed');
              },
            }),
          });
          process.stdout.write(JSON.stringify(result));
        `),
        ) as { status?: unknown; data?: unknown; keyring?: unknown };
        if (result.status !== "retired" || result.data !== "erased" || result.keyring !== "cleared")
          throw desktopFixtureRetirementFailure(result);
      }
      await rm(this.root, { recursive: true, force: true });
    } finally {
      await new Promise<void>((done, reject) =>
        this.relay.close((error) => (error ? reject(error) : done())),
      );
    }
  }
}

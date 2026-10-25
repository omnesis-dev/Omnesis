// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  mkdtempSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  encryptedIdentity,
  exhaustTinyFilesystem,
  interruptUpdate,
  seededDocuments,
  signalOwnedProcess,
  damageDependencyTree,
  validateDependencyDamage,
  verifyDependencyRestored,
  withOwnedCleanup,
  newCompletedBackup,
} from "./update-fault.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dirs = [];
const children = [];
const servers = [];
function scratch() {
  const path = mkdtempSync(join(tmpdir(), "update-fault-test-"));
  dirs.push(path);
  return path;
}
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
function compilerFixture(directory) {
  const source = join(directory, "source"),
    file = join(source, "node_modules/typescript/lib/tsc.js");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "fictional compiler entry");
  return realpathSync(source);
}
function gateEnv(directory) {
  return {
    UPDATE_FAULT_HELPER: join(root, "update-fault.mjs"),
    UPDATE_FAULT_SOURCE: compilerFixture(directory),
  };
}
function identityFixture() {
  const config = scratch();
  for (const [name, marker] of [
    [
      `keyring/passphrase/${Buffer.from("install-root-key-v1").toString("base64url")}.json`,
      "omnesis.passphrase-secret",
    ],
    ["keyring/storage-keys/main-db.json", "omnesis.storage-key"],
    ["token", "omnesis.secret-file"],
    ["collector-token", "omnesis.secret-file"],
  ]) {
    mkdirSync(dirname(join(config, name)), { recursive: true });
    writeFileSync(
      join(config, name),
      JSON.stringify({ omnesis: marker, version: 1, ciphertext: "fictional-ciphertext" }),
    );
  }
  mkdirSync(join(config, "tls"));
  writeFileSync(join(config, "tls/cert.pem"), "fictional certificate");
  writeFileSync(join(config, "omnesis.db"), Buffer.alloc(4096, 0xa5));
  return config;
}

describe("updater fault observations", () => {
  it("refuses an ordinary CI host before creating files or touching installed services", () => {
    const work = join(scratch(), "must-not-exist");
    let failure;
    try {
      execFileSync("bash", [join(root, "update-interruption.sh")], {
        env: { ...process.env, CI: "true", GITHUB_ACTIONS: "false", E2E_WORK: work },
        stdio: "pipe",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(2);
    expect(existsSync(work)).toBe(false);
  });
  it("refuses spoofed GitHub markers on a persistent host before creating scratch", () => {
    const home = scratch(),
      work = join(home, "must-not-exist");
    let failure;
    try {
      execFileSync("bash", [join(root, "update-interruption.sh")], {
        env: {
          ...process.env,
          CI: "true",
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
          RUNNER_OS: "Linux",
          HOME: home,
          E2E_WORK: work,
          RUNNER_TEMP: home,
          GITHUB_WORKSPACE: root,
        },
        stdio: "pipe",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(2);
    expect(existsSync(work)).toBe(false);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });
  it("imports and runs portable checks on non-Linux without reading procfs", () => {
    const config = identityFixture();
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const fs=require('node:fs'),read=fs.readFileSync;
      fs.readFileSync=function(path,...args){
        if(String(path).startsWith('/proc/'))throw new Error('portable module accessed procfs');
        return read.call(this,path,...args);
      };
      require('node:module').syncBuiltinESMExports();
      Object.defineProperty(process,'platform',{value:'darwin'});
      import(process.argv[1]).then(module=>{
        if(Object.keys(module.encryptedIdentity(process.argv[2])).length!==5)throw new Error('identity proof missing');
        module.newCompletedBackup({backups:[]},{backups:[{purpose:'pre-update',path:'fictional-backup'}]});
        process.stdout.write('portable checks passed');
      }).catch(error=>{process.stderr.write(error.message);process.exitCode=1;});
    `,
        new URL("update-fault.mjs", import.meta.url).href,
        config,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("portable checks passed");
    expect(result.stderr).toBe("");
  });
  it("fingerprints encrypted identity without returning credential material", () => {
    const config = identityFixture();
    const before = encryptedIdentity(config);
    expect(Object.keys(before)).toHaveLength(5);
    expect(Object.values(before).every((s) => /^[a-f0-9]{64}$/.test(s))).toBe(true);
    expect(JSON.stringify(before)).not.toContain("fictional-ciphertext");
    writeFileSync(join(config, "tls/cert.pem"), "replacement certificate");
    expect(encryptedIdentity(config)).not.toEqual(before);
  });
  it("refuses plaintext database, token and root-key artifacts", () => {
    for (const name of [
      "omnesis.db",
      "token",
      `keyring/passphrase/${Buffer.from("install-root-key-v1").toString("base64url")}.json`,
    ]) {
      const config = identityFixture();
      writeFileSync(
        join(config, name),
        name.endsWith(".db")
          ? Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4096)])
          : "plaintext-secret",
      );
      expect(() => encryptedIdentity(config)).toThrow();
    }
  });
  it("CLI identity failures never print plaintext token or root-key canaries", () => {
    const canary = "fictional-credential-canary-must-never-be-logged";
    for (const name of [
      "token",
      "collector-token",
      `keyring/passphrase/${Buffer.from("install-root-key-v1").toString("base64url")}.json`,
    ]) {
      for (const contents of [
        canary,
        JSON.stringify({ omnesis: "plaintext", version: 1, ciphertext: canary }),
      ]) {
        const config = identityFixture();
        writeFileSync(join(config, name), contents);
        const result = spawnSync(
          process.execPath,
          [join(root, "update-fault.mjs"), "identity", config],
          { encoding: "utf8" },
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("identity artifact is not encrypted");
        expect(result.stdout + result.stderr).not.toContain(canary);
      }
    }
  });
  it("retains the original exception and cleanup failure without returning a false success", async () => {
    const primary = new Error("original transaction failure"),
      retirement = new Error("owned cleanup failed");
    const order = [];
    let caught;
    try {
      await withOwnedCleanup(
        async () => {
          order.push("execute");
          throw primary;
        },
        async () => {
          order.push("cleanup");
          throw retirement;
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(order).toEqual(["execute", "cleanup"]);
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.cause).toBe(retirement);
    expect(caught.errors).toEqual([primary, retirement]);
    await expect(
      withOwnedCleanup(
        async () => "candidate success",
        async () => {
          throw retirement;
        },
      ),
    ).rejects.toBe(retirement);
    await expect(
      withOwnedCleanup(
        async () => {
          throw primary;
        },
        async () => {},
      ),
    ).rejects.toBe(primary);
  });
  it("requires a new completed backup identity even when retention keeps the count unchanged", () => {
    const listing = (names) => ({
      backups: names.map((path) => ({ path, purpose: "pre-update" })),
    });
    expect(newCompletedBackup(listing(["a", "b", "c"]), listing(["b", "c", "d"]))).toEqual({
      newBackup: true,
    });
    expect(() => newCompletedBackup(listing(["a"]), listing(["a"]))).toThrow("no new completed");
    expect(() => newCompletedBackup({}, listing(["d"]))).toThrow("listing is missing");
  });
  it("actually removes one owned dependency and requires its exact hash after real file restoration", () => {
    const source = compilerFixture(scratch()),
      file = join(source, "node_modules/typescript/lib/tsc.js"),
      original = readFileSync(file);
    const proof = damageDependencyTree(source);
    expect(existsSync(file)).toBe(false);
    validateDependencyDamage(source, proof);
    expect(() => verifyDependencyRestored(source, proof)).toThrow();
    writeFileSync(file, "wrong compiler");
    expect(() => verifyDependencyRestored(source, proof)).toThrow("hash");
    writeFileSync(file, original);
    expect(verifyDependencyRestored(source, proof)).toEqual({ restored: true });
    expect(() => validateDependencyDamage(source, proof)).toThrow("not observed");
  });
  it("refuses escaped, symlinked or oversized dependency entries without removing them", () => {
    const outside = join(scratch(), "outside.js");
    writeFileSync(outside, "outside must survive");
    for (const mode of ["symlink", "escape", "oversize"]) {
      const source = compilerFixture(scratch()),
        file = join(source, "node_modules/typescript/lib/tsc.js");
      if (mode === "escape") {
        rmSync(join(source, "node_modules/typescript"), { recursive: true });
        const external = scratch();
        mkdirSync(join(external, "lib"));
        writeFileSync(join(external, "lib/tsc.js"), "external");
        symlinkSync(external, join(source, "node_modules/typescript"));
      } else {
        rmSync(file);
        if (mode === "symlink") symlinkSync(outside, file);
        else writeFileSync(file, Buffer.alloc(8 * 1024 * 1024 + 1));
      }
      expect(() => damageDependencyTree(source)).toThrow();
      expect(existsSync(file)).toBe(true);
    }
    expect(readFileSync(outside, "utf8")).toBe("outside must survive");
  });
  it("refuses to exhaust the host filesystem and writes no filler there", () => {
    const directory = scratch();
    expect(() => exhaustTinyFilesystem(directory)).toThrow("requires a tmpfs");
    expect(() => readFileSync(join(directory, "fault-filler"))).toThrow();
  });
  // These controls exercise Linux procfs birth identity and updater process groups.
  it.runIf(process.platform === "linux")(
    "waits for a real npm child then signals only its updater and verifies child retirement",
    async () => {
      const directory = scratch();
      symlinkSync(join(root, "update-fault-command.sh"), join(directory, "npm"));
      const updater = join(directory, "updater.mjs");
      writeFileSync(
        updater,
        `import {spawn} from 'node:child_process';
const child=spawn('npm',['ci'],{stdio:'inherit'});
process.on('SIGTERM',()=>{child.kill('SIGTERM');child.once('exit',()=>process.exit(143));});
child.once('exit',()=>{});`,
      );
      const stateFile = join(directory, "update-state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({ method: "source", phase: "applying", targetCommit: "a".repeat(40) }),
      );
      const proof = await interruptUpdate(process.execPath, [updater], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          UPDATE_FAULT_DIR: directory,
          ...gateEnv(directory),
          UPDATE_REAL_NPM: process.execPath,
        },
        phaseDirectory: directory,
        stateFile,
        targetCommit: "a".repeat(40),
        timeoutMs: 3000,
      });
      expect(proof).toEqual({
        phase: "npm ci",
        signal: "SIGTERM",
        exitCode: 143,
        childRetired: true,
      });
    },
  );
  it.runIf(process.platform === "linux")(
    "retires the detached gate even when an invalid phase and unresponsive updater force cleanup",
    async () => {
      const directory = scratch();
      symlinkSync(join(root, "update-fault-command.sh"), join(directory, "npm"));
      const updater = join(directory, "unresponsive.mjs");
      writeFileSync(
        updater,
        `import {spawn} from 'node:child_process';
spawn('npm',['ci'],{stdio:'inherit',detached:true});
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
      );
      const stateFile = join(directory, "update-state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({ method: "source", phase: "complete", targetCommit: "a".repeat(40) }),
      );
      await expect(
        interruptUpdate(process.execPath, [updater], {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            UPDATE_FAULT_DIR: directory,
            ...gateEnv(directory),
          },
          phaseDirectory: directory,
          stateFile,
          targetCommit: "a".repeat(40),
          timeoutMs: 3000,
          cleanupTimeoutMs: 100,
        }),
      ).rejects.toThrow("not inside the target source apply transaction");
      const gatePid = Number(readFileSync(join(directory, "entered/pid"), "utf8"));
      // A killed child can remain a zombie briefly while init reaps it; it must never be runnable.
      let running;
      try {
        const stat = readFileSync(`/proc/${gatePid}/stat`, "utf8");
        running = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        running = false;
      }
      expect(running).toBe(false);
    },
  );
  it.runIf(process.platform === "linux")(
    "controller TERM remains a failure and retires its updater and gate",
    async () => {
      const directory = scratch();
      symlinkSync(join(root, "update-fault-command.sh"), join(directory, "npm"));
      const updater = join(directory, "updater");
      writeFileSync(
        updater,
        `#!/usr/bin/env node
const {spawn}=require('node:child_process');
const child=spawn('npm',['ci'],{stdio:'inherit',detached:true});
process.on('SIGTERM',()=>{setTimeout(()=>{child.kill('SIGTERM');child.once('exit',()=>process.exit(143));},300);});`,
      );
      chmodSync(updater, 0o700);
      const helper = spawn(
        process.execPath,
        [join(root, "update-fault.mjs"), "interrupt", updater],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            UPDATE_FAULT_DIR: directory,
            ...gateEnv(directory),
          },
          stdio: "ignore",
        },
      );
      children.push(helper);
      const terminal = once(helper, "exit");
      const deadline = Date.now() + 3000;
      while (!existsSync(join(directory, "entered/pid"))) {
        if (Date.now() > deadline) throw new Error("gate did not start");
        await new Promise((r) => setTimeout(r, 10));
      }
      helper.kill("SIGTERM");
      const [code, signal] = await terminal;
      expect(code).toBe(1);
      expect(signal).toBe(null);
      const gatePid = Number(readFileSync(join(directory, "entered/pid"), "utf8"));
      expect(() => process.kill(gatePid, 0)).toThrow();
    },
  );
  it.runIf(process.platform === "linux")(
    "rejects a process that exits before the actual phase, rather than accepting any nonzero exit",
    async () => {
      await expect(
        interruptUpdate(process.execPath, ["-e", "process.exit(143)"], {
          env: process.env,
          phaseDirectory: scratch(),
          timeoutMs: 1000,
        }),
      ).rejects.toThrow("before npm ci");
    },
  );
  it("reads exact stable document IDs and content, failing on missing or changed content", async () => {
    let missing = false;
    let corrupt = false;
    const queries = ["brindlewick", "Tomatoes along", "bread baking at altitude"];
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      res.setHeader("Content-Type", "application/json");
      if (req.headers.authorization !== "Bearer fictional-token") {
        res.writeHead(401).end("{}");
        return;
      }
      if (url.pathname === "/documents/search") {
        const id = queries.indexOf(url.searchParams.get("q"));
        res.end(JSON.stringify({ results: missing ? [] : [{ id: String(id) }] }));
      } else {
        const id = url.pathname.split("/").at(-1);
        res.end(
          JSON.stringify({
            id,
            content: corrupt ? "wrong fictional content" : queries[Number(id)],
          }),
        );
      }
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    expect(await seededDocuments(url, "fictional-token")).toHaveLength(3);
    await expect(seededDocuments(url, "wrong-token")).rejects.toThrow("HTTP 401");
    corrupt = true;
    await expect(seededDocuments(url, "fictional-token")).rejects.toThrow(
      "content was not preserved",
    );
    corrupt = false;
    missing = true;
    await expect(seededDocuments(url, "fictional-token")).rejects.toThrow("missing or ambiguous");
  });
  it.runIf(process.platform === "linux")(
    "a stale birth identity cannot signal an unrelated live process",
    () => {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
      });
      children.push(child);
      expect(signalOwnedProcess(child.pid, "not-its-start-identity")).toBe(false);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
    },
  );
  it.runIf(process.platform === "linux")(
    "disconnects a real loopback Git server at the actual fetch command",
    async () => {
      const directory = scratch();
      const repo = join(directory, "remote.git");
      execFileSync("git", ["init", "--bare", "--quiet", repo]);
      const server = createServer();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const port = server.address().port;
      await new Promise((r) => server.close(r));
      const daemon = spawn(
        "git",
        [
          "daemon",
          "--export-all",
          `--base-path=${directory}`,
          "--listen=127.0.0.1",
          `--port=${port}`,
        ],
        { stdio: "ignore" },
      );
      children.push(daemon);
      const url = `git://127.0.0.1:${port}/remote.git`;
      let ready = false;
      for (let i = 0; i < 50; i++) {
        try {
          execFileSync("git", ["ls-remote", url], { stdio: "ignore" });
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      expect(ready).toBe(true);
      const local = join(directory, "local");
      execFileSync("git", ["init", "--quiet", local]);
      symlinkSync(join(root, "update-fault-command.sh"), join(directory, "git"));
      let failure;
      try {
        execFileSync(join(directory, "git"), ["fetch", url], {
          cwd: local,
          stdio: "pipe",
          env: {
            ...process.env,
            UPDATE_FAULT_DIR: directory,
            ...gateEnv(directory),
            UPDATE_REAL_GIT: execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
            UPDATE_GIT_DAEMON_PID: String(daemon.pid),
            UPDATE_GIT_DAEMON_START: readFileSync(`/proc/${daemon.pid}/stat`, "utf8")
              .split(") ")[1]
              .split(" ")[19],
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure?.status).not.toBe(0);
      expect(failure?.stderr.toString()).toMatch(/Connection refused|unable to connect/);
      expect(existsSync(join(directory, "fetch-entered"))).toBe(true);
    },
  );
});

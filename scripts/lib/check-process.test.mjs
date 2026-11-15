// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConnection } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { runCheckCommand } from "./check-process.mjs";
import * as bootstrap from "./bootstrap-platform.mjs";
import { ownedProcessCleanupReceipt } from "../../packages/core/src/owned-process-cleanup.ts";

afterEach(() => vi.restoreAllMocks());

const entry = new URL("./check-process.mjs", import.meta.url).href;
const success = { exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderr: "" };

test("Windows npm resolves its actual JavaScript entry and preserves literal argv", async () => {
  const root = mkdtempSync(join(tmpdir(), "check npm literal "));
  const npm = join(root, "npm # literal.mjs");
  writeFileSync(npm, "// Invented npm transport fixture.\n");
  const invocation = vi.fn(async () => success);
  try {
    const args = ["run", "literal $&", 'quote"value', ""];
    expect(
      await runCheckCommand("npm", args, {
        platform: "win32",
        env: { ...process.env, npm_execpath: npm },
        runWindows: invocation,
        signalEmitter: new EventEmitter(),
      }),
    ).toBe(0);
    expect(invocation).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      [npm, ...args],
      expect.objectContaining({ completion: "root" }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32").each([false, true])(
  "POSIX detached=%s retains the caller's actual process-group contract",
  (detached) => {
    const group = `Number(require('node:child_process').execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim())`;
    const target = `process.stdout.write(JSON.stringify({pid:process.pid,group:${group}})+'\\n')`;
    const program = `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);import {runCheckCommand} from ${JSON.stringify(entry)};process.stdout.write(JSON.stringify({parentGroup:${group}})+'\\n');process.exitCode=await runCheckCommand(process.execPath,['-e',${JSON.stringify(target)}],{detached:${detached}});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program]);
    expect(result.status, result.stderr.toString()).toBe(0);
    const [parent, child] = result.stdout
      .toString()
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(child.group).toBe(detached ? child.pid : parent.parentGroup);
  },
);
for (const payload of [undefined, Error("invented unconfirmed cleanup")])
  test.each([0, 7])("own cleanup marker cannot become an ordinary status %s", async (exitCode) => {
    const signals = new EventEmitter();
    const retain = vi.fn();
    const error = await runCheckCommand("invented-program", ["literal"], {
      platform: "win32",
      signalEmitter: signals,
      retainUnconfirmed: retain,
      runWindows: async () => ({ ...success, exitCode, cleanupFailure: payload }),
    }).catch((error) => error);
    expect(Object.hasOwn(error, "cleanupFailure")).toBe(true);
    expect(error.cleanupFailure).toBe(payload);
    expect(retain).toHaveBeenCalledTimes(1);
    expect(signals.eventNames()).toEqual([]);
  });

test.each(["bootstrap", "operation"])(
  "nested own undefined %s rejection retains before being rethrown",
  async (stage) => {
    const error = new Error("invented outer failure", {
      cause: Object.assign(new Error("invented inner failure"), { cleanupFailure: undefined }),
    });
    const retain = vi.fn();
    const signals = new EventEmitter();
    let runWindows;
    if (stage === "bootstrap")
      vi.spyOn(bootstrap, "bootstrapWindowsPlatform").mockRejectedValue(error);
    else
      runWindows = async () => {
        throw error;
      };
    await expect(
      runCheckCommand("invented-program", [], {
        platform: "win32",
        signalEmitter: signals,
        runWindows,
        retainUnconfirmed: retain,
      }),
    ).rejects.toBe(error);
    expect(retain).toHaveBeenCalledExactlyOnceWith(error);
    expect(signals.eventNames()).toEqual([]);
  },
);

test.each(["timeout", "aborted", "spawn"])(
  "positive joined exit0 never erases %s failure",
  async (failure) => {
    const retain = vi.fn();
    const error = await runCheckCommand("invented-program", [], {
      platform: "win32",
      signalEmitter: new EventEmitter(),
      retainUnconfirmed: retain,
      runWindows: async () => ({ ...success, failure }),
    }).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(Object.hasOwn(error, "cleanupFailure")).toBe(false);
    expect(retain).not.toHaveBeenCalled();
  },
);

test.each([0, 7, 126, 127])(
  "joined root status %s is preserved with finite-root ownership",
  async (exitCode) => {
    const signals = new EventEmitter();
    const code = await runCheckCommand("literal-program", ["", "literal $&", 'quote"value'], {
      platform: "win32",
      signalEmitter: signals,
      retainUnconfirmed: () => {
        throw Error("Joined root status must not retain a lane");
      },
      runWindows: async (command, args, options) => {
        expect(command).toBe("literal-program");
        expect(args).toEqual(["", "literal $&", 'quote"value']);
        expect(options.completion).toBe("root");
        expect(options.stdout).toBe("inherit");
        expect(options.inputStream).toBe(process.stdin);
        expect(options).not.toHaveProperty("timeoutMs");
        return { ...success, exitCode };
      },
    });
    expect(code).toBe(exitCode);
    expect(signals.eventNames()).toEqual([]);
  },
);

test("cancellation remains failure after a positive joined root exit0", async () => {
  const signals = new EventEmitter();
  await expect(
    runCheckCommand("invented-program", [], {
      platform: "win32",
      signalEmitter: signals,
      retainUnconfirmed: () => {
        throw Error("Joined cancellation must not retain a lane");
      },
      runWindows: async (_command, _args, options) => {
        signals.emit("SIGTERM");
        expect(options.signal.aborted).toBe(true);
        return success;
      },
    }),
  ).rejects.toThrow("did not complete normally");
  expect(signals.eventNames()).toEqual([]);
});

test("command adapter imports without dependencies or workspace aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "check bootstrap literal "));
  try {
    for (const file of [
      "scripts/lib/check-process.mjs",
      "scripts/lib/check-process-runtime.mjs",
      "scripts/lib/bootstrap-platform.mjs",
      "packages/core/src/parent-shutdown.ts",
      "packages/core/src/owned-process-cleanup.ts",
      "packages/core/src/node-command.ts",
    ]) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(new URL("../../" + file, import.meta.url), path);
    }
    const program = `const {runCheckCommand}=await import(${JSON.stringify(pathToFileURL(join(root, "scripts/lib/check-process.mjs")).href)});if(typeof runCheckCommand!=='function')process.exit(2);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: root,
    });
    expect(result.status, result.stderr.toString()).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default uncertainty hold prevents natural exit until its whole owned fixture is joined", async () => {
  const root = mkdtempSync(join(tmpdir(), "check retained fixture "));
  const marker = join(root, "held.txt");
  const program = `import {runCheckCommand} from ${JSON.stringify(entry)};import {writeFileSync} from 'node:fs';let first;try{await runCheckCommand('invented',[],{platform:'win32',runWindows:async()=>({exitCode:0,signal:null,cleanupFailure:undefined})});}catch(error){first=error;}if(!first||!Object.hasOwn(first,'cleanupFailure'))process.exit(31);let reran=false;try{await runCheckCommand('invented',[],{platform:'win32',runWindows:async()=>{reran=true;return {exitCode:0,signal:null}}});}catch(error){if(!Object.hasOwn(error,'cleanupFailure'))process.exit(32);}if(reran)process.exit(33);writeFileSync(${JSON.stringify(marker)},'held');process.exitCode=7;`;
  const signals = new EventEmitter();
  let settled = false,
    failure;
  const running = runCheckCommand(process.execPath, ["--input-type=module", "-e", program], {
    cwd: root,
    signalEmitter: signals,
  }).then(
    () => {
      settled = true;
    },
    (error) => {
      failure = error;
      settled = true;
    },
  );
  try {
    const deadline = Date.now() + 60000;
    while (!existsSync(marker) && !settled && Date.now() < deadline) await delay(25);
    expect(existsSync(marker)).toBe(true);
    await delay(100);
    expect(settled).toBe(false);
    signals.emit("SIGTERM");
    await running;
    expect(failure).toBeInstanceOf(Error);
    expect(ownedProcessCleanupReceipt(failure)).toBeUndefined();
  } finally {
    if (!settled) signals.emit("SIGTERM");
    await running;
    if (ownedProcessCleanupReceipt(failure) === undefined)
      rmSync(root, { recursive: true, force: true });
  }
}, 90000);

test.each([
  ["../ci/windows-checks.mjs", ["unit"]],
  ["../nx/run-global-guards.mjs", []],
  ["../nx/run-full.mjs", []],
  ["../nx/run-bundle.mjs", ["gateway-core"]],
  ["../nx/run-project-task.mjs", ["unit", "packages/cli"]],
])(
  "actual entry %s catches marked rejection without bypassing its referenced hold",
  async (script, args) => {
    const root = mkdtempSync(join(tmpdir(), "check entry retained fixture "));
    const marker = join(root, "held.txt"),
      preload = join(root, "controlled-result.mjs");
    const replacement = `import {runCheckCommand as real} from ${JSON.stringify(entry + "?owned-fixture-original")};export {checkFailureMessage} from ${JSON.stringify(entry + "?owned-fixture-original")};import {writeFileSync} from 'node:fs';export async function runCheckCommand(command,args,options){try{return await real(command,args,{...options,platform:'win32',runWindows:async()=>({exitCode:0,signal:null,cleanupFailure:undefined})});}catch(error){writeFileSync(${JSON.stringify(marker)},'held');throw error;}}`;
    const npmEntry = join(root, "invented-npm.mjs");
    writeFileSync(npmEntry, "// Invented transport fixture; no package operation runs.\n");
    writeFileSync(
      preload,
      `import {registerHooks} from 'node:module';registerHooks({load(url,context,nextLoad){if(url!==${JSON.stringify(entry)})return nextLoad(url,context);return{format:'module',shortCircuit:true,source:${JSON.stringify(replacement)}}}});`,
    );
    const signals = new EventEmitter();
    const fixtureEnv = {
      ...process.env,
      OMNESIS_WINDOWS_E2E_FILES: "",
      OMNESIS_TREE_FINGERPRINT: "",
      OMNESIS_E2E_ALREADY_SELECTED: "",
    };
    for (const name of Object.keys(fixtureEnv))
      if (name.toLowerCase() === "npm_execpath") delete fixtureEnv[name];
    fixtureEnv.npm_execpath = npmEntry;
    let settled = false,
      failure;
    const running = runCheckCommand(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        fileURLToPath(new URL(script, import.meta.url)),
        ...args,
      ],
      {
        cwd: join(import.meta.dirname, "../.."),
        env: fixtureEnv,
        signalEmitter: signals,
      },
    ).then(
      () => {
        settled = true;
      },
      (error) => {
        failure = error;
        settled = true;
      },
    );
    try {
      const deadline = Date.now() + 60000;
      while (!existsSync(marker) && !settled && Date.now() < deadline) await delay(25);
      expect(existsSync(marker)).toBe(true);
      await delay(100);
      expect(settled).toBe(false);
      signals.emit("SIGTERM");
      await running;
      expect(failure).toBeInstanceOf(Error);
      expect(ownedProcessCleanupReceipt(failure)).toBeUndefined();
    } finally {
      if (!settled) signals.emit("SIGTERM");
      await running;
      if (ownedProcessCleanupReceipt(failure) === undefined)
        rmSync(root, { recursive: true, force: true });
    }
  },
  90000,
);

test("real command boundary preserves literal argv, binary pipes and application status", () => {
  const root = mkdtempSync(join(tmpdir(), "check command literal "));
  const args = ["", "$&", 'quote"value', "雪"];
  const target = `if(JSON.stringify(process.argv.slice(1))!==${JSON.stringify(JSON.stringify(args))})process.exit(31);const bytes=[];for await(const chunk of process.stdin)bytes.push(chunk);process.stdout.write(Buffer.concat(bytes));process.stderr.write(Buffer.from([0,254,10,66]));process.exitCode=7;`;
  const program = `import {runCheckCommand} from ${JSON.stringify(entry)};process.exitCode=await runCheckCommand(process.execPath,['--input-type=module','-e',${JSON.stringify(target)},...${JSON.stringify(args)}],{cwd:${JSON.stringify(root)}});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    input: Buffer.from([0, 255, 10, 65]),
    timeout: 90000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(7);
  expect(result.stdout).toEqual(Buffer.from([0, 255, 10, 65]));
  expect(result.stderr).toEqual(Buffer.from([0, 254, 10, 66]));
  rmSync(root, { recursive: true, force: true });
}, 100000);

test("finite root exit joins a persistent owned TCP descendant before returning its status", async () => {
  const descendant = `const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'));`;
  const target = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:process.platform==='win32',stdio:['ignore','pipe','inherit']});child.stdout.once('data',bytes=>{process.stdout.write(bytes);process.exit(7)});`;
  const program = `import {runCheckCommand} from ${JSON.stringify(entry)};process.exitCode=await runCheckCommand(process.execPath,['-e',${JSON.stringify(target)}]);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    timeout: 90000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(7);
  const port = Number(result.stdout.toString().trim());
  expect(port).toBeGreaterThan(0);
  expect(port).toBeLessThan(65536);
  const accepts = await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
  });
  expect(accepts).toBe(false);
}, 100000);

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const WRITE_MAGIC = Buffer.from("OMNESIS_HERMES_WRITE_V1\0", "ascii");
const WRITE_COMMIT = Buffer.from("\0OMNESIS_HERMES_WRITE_COMMIT_V1\0", "ascii");
function writeFrame(bytes: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([WRITE_MAGIC, length, bytes, WRITE_COMMIT]);
}
const roots: string[] = [];
function fixture(): { root: string; bridge: string } {
  const root = mkdtempSync(join(tmpdir(), "hermes-node-bridge-"));
  roots.push(root);
  mkdirSync(join(root, "runtime"));
  writeFileSync(join(root, "runtime/package.json"), '{"type":"module"}');
  cpSync(new URL("../hermes/windows-files.mjs", import.meta.url), join(root, "windows-files.mjs"));
  for (const name of ["refresh-lease", "request-budgets"])
    writeFileSync(
      join(root, `runtime/${name}.js`),
      stripTypeScriptTypes(readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8")),
    );
  // Only the native filesystem boundary is substituted here. Production ships
  // the canonical generated graph; its ACL behavior has separate native tests.
  writeFileSync(
    join(root, "runtime/windows-files.js"),
    `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
export function privateWindowsFiles(){return {
readWindowsPrivateFileContentsSync: readFileSync,
secureWindowsPrivatePathSync(path,kind){appendFileSync(new URL('./calls.jsonl',import.meta.url),JSON.stringify({path,kind})+'\\n')},
writeWindowsPrivateFileAtomicSync(path,bytes){if(bytes.toString()==='invented-rejected-secret')throw Object.assign(new Error(bytes.toString()),{code:'EPRIVATE'});writeFileSync(path,bytes)}
}}`,
  );
  return { root, bridge: join(root, "windows-files.mjs") };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("standalone bridge passes binary bytes on pipes and sanitizes failed secret writes", () => {
  const { root, bridge } = fixture();
  const path = join(root, "literal [$&] 雪.json");
  const bytes = Buffer.from([0, 255, 10, 65]);
  expect(
    spawnSync(process.execPath, [bridge, "write", path, "framed-v1"], { input: writeFrame(bytes) })
      .status,
  ).toBe(0);
  const read = spawnSync(process.execPath, [bridge, "read", path]);
  expect(read.status).toBe(0);
  expect(read.stdout).toEqual(bytes);
  const failed = spawnSync(process.execPath, [bridge, "write", path, "framed-v1"], {
    input: writeFrame(Buffer.from("invented-rejected-secret")),
  });
  expect(failed.status).toBe(1);
  expect(failed.stdout.length).toBe(0);
  expect(failed.stderr.toString()).not.toContain("invented-rejected-secret");
  expect(readFileSync(path)).toEqual(bytes);
});

test("bridge holds the actual shared lease until release pipe EOF, then joins and removes it", async () => {
  const { root, bridge } = fixture();
  const path = join(root, "credentials.json");
  const child = spawn(process.execPath, [bridge, "lease", path], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    const [ready] = await once(child.stdout, "data");
    expect(ready.toString()).toBe('{"ready":true}\n');
    expect(readFileSync(`${path}.refresh.lock`, "utf8").trim()).toBe(String(child.pid));
    child.stdin.end();
    expect(await exited).toEqual([0, null]);
    expect(existsSync(`${path}.refresh.lock`)).toBe(false);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
  }
});

test("EOF while waiting cancels the bridge without reclaiming another process lease", async () => {
  const { root, bridge } = fixture();
  const path = join(root, "credentials.json");
  const lock = `${path}.refresh.lock`;
  writeFileSync(lock, `${process.pid}\n`);
  const child = spawn(process.execPath, [bridge, "lease", path], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    child.stdin.end();
    expect((await exited)[0]).toBe(1);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
  }
});

test("state preparation secures the directory before existing DB/sidecars and permits missing files", () => {
  const { root, bridge } = fixture();
  const path = join(root, "state.sqlite");
  writeFileSync(path, "invented retained bytes");
  writeFileSync(path + "-shm", "invented retained shared memory");
  const result = spawnSync(process.execPath, [bridge, "state", path]);
  expect(result.status).toBe(0);
  const calls = readFileSync(join(root, "runtime/calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toEqual([
    { path: root, kind: "directory" },
    { path, kind: "file" },
    { path: path + "-shm", kind: "file" },
  ]);
  expect(readFileSync(path, "utf8")).toBe("invented retained bytes");
});

test.each([
  "partial-header",
  "partial-payload",
  "missing-commit",
  "partial-commit",
  "wrong-commit",
  "trailing-data",
  "oversize-header",
] as const)(
  "incomplete or invalid bridge writes preserve existing credentials (%s)",
  (scenario) => {
    const { root, bridge } = fixture();
    const path = join(root, "credentials.json");
    const previous = Buffer.from('{"invented":"preserved credentials"}');
    writeFileSync(path, previous);
    const payload = Buffer.alloc(128 * 1024, 65),
      complete = writeFrame(payload);
    let input: Buffer;
    switch (scenario) {
      case "partial-header":
        input = complete.subarray(0, WRITE_MAGIC.length + 2);
        break;
      case "partial-payload":
        input = complete.subarray(0, WRITE_MAGIC.length + 4 + 512);
        break;
      case "missing-commit":
        input = complete.subarray(0, complete.length - WRITE_COMMIT.length);
        break;
      case "partial-commit":
        input = complete.subarray(0, complete.length - 1);
        break;
      case "wrong-commit":
        input = Buffer.from(complete);
        input[input.length - 2] ^= 1;
        break;
      case "trailing-data":
        input = Buffer.concat([complete, Buffer.from([1])]);
        break;
      case "oversize-header":
        input = Buffer.from(complete.subarray(0, WRITE_MAGIC.length + 4));
        input.writeUInt32LE(1024 * 1024 * 1024 + 1, WRITE_MAGIC.length);
        break;
    }
    const result = spawnSync(process.execPath, [bridge, "write", path, "framed-v1"], {
      input,
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(readFileSync(path)).toEqual(previous);
    expect(result.stderr.toString()).not.toContain(previous.toString());
  },
);

test("fragmented binary frames publish only after exact commit and EOF", async () => {
  const { root, bridge } = fixture(),
    path = join(root, "credentials.json");
  const previous = Buffer.from("invented previous bytes"),
    payload = Buffer.from([0, 255, 1, 10, 13]);
  writeFileSync(path, previous);
  const child = spawn(process.execPath, [bridge, "write", path, "framed-v1"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  try {
    const frame = writeFrame(payload);
    for (const byte of frame)
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(Buffer.from([byte]), (error) => (error ? reject(error) : resolve())),
      );
    expect(readFileSync(path)).toEqual(previous);
    child.stdin.end();
    expect(await closed).toEqual([0, null]);
    expect(readFileSync(path)).toEqual(payload);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});

test("a killed Python write owner cannot commit its partial frame over valid credentials", async () => {
  const { root, bridge } = fixture(),
    path = join(root, "credentials.json");
  const previous = Buffer.from('{"invented":"preserved credentials"}');
  writeFileSync(path, previous);
  const nonce = randomBytes(16).toString("hex");
  let release: Socket | undefined;
  const server = createServer();
  const connected = new Promise<Socket>((resolve, reject) => {
    server.on("connection", (socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString("utf8");
        if (input.length > 128) {
          socket.destroy();
          reject(new Error("Invalid fixture gate"));
        } else if (input.endsWith("\n")) {
          if (input !== nonce + "\n") {
            socket.destroy();
            reject(new Error("Invalid fixture nonce"));
          } else {
            release = socket;
            resolve(socket);
          }
        }
      });
    });
    server.once("error", reject);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const preload = join(root, "pause-first-frame.mjs");
  writeFileSync(
    preload,
    `import {createConnection} from 'node:net';import {once} from 'node:events';
const original=process.stdin[Symbol.asyncIterator].bind(process.stdin);let first=true;
process.stdin[Symbol.asyncIterator]=async function*(){for await(const chunk of original()){if(first){first=false;const socket=createConnection(${address.port},'127.0.0.1');await once(socket,'connect');socket.write(${JSON.stringify(nonce + "\n")});await once(socket,'data');socket.end();}yield chunk;}};`,
  );
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(preload).href, bridge, "write", path, "framed-v1"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const closed = once(child, "close");
  child.stdin.on("error", () => {});
  const adapterTests = fileURLToPath(new URL("../hermes/test_adapter.py", import.meta.url));
  // Exercise Python's actual frame constructor. Substitute only its child
  // transport with stdout so this test retains both physical process handles.
  const driver = `import runpy,sys,types
adapter=runpy.run_path(${JSON.stringify(adapterTests)})['adapter_module']
def transfer(*args,**kwargs):
 sys.stdout.buffer.write(kwargs['input'])
 sys.stdout.buffer.flush()
 return types.SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
adapter.subprocess.run=transfer
adapter._windows_node_command=lambda *_args:['fixture-transport']
adapter._windows_bridge('write',${JSON.stringify(path)},b'A'*(1024*1024))
`;
  const owner = spawn(
    process.platform === "win32" ? "python" : "python3",
    ["-B", "-u", "-c", driver],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const ownerClosed = once(owner, "close");
  const ownerExited = once(owner, "exit");
  owner.stdout.pipe(child.stdin);
  try {
    await Promise.race([
      connected,
      ownerExited.then(() => {
        throw new Error("Python writer exited before frame readiness");
      }),
      closed.then(() => {
        throw new Error("Bridge exited before frame readiness");
      }),
    ]);
    expect(owner.exitCode).toBeNull();
    expect(readFileSync(path)).toEqual(previous);
    owner.kill("SIGKILL");
    await ownerExited;
    release!.end("release\n");
    expect((await closed)[0]).toBe(1);
    expect(readFileSync(path)).toEqual(previous);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.allSettled([ownerClosed, closed]);
    release?.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("unversioned writers fail closed during a mixed-version Hermes installation", () => {
  const { root, bridge } = fixture(),
    path = join(root, "credentials.json");
  const previous = Buffer.from('{"invented":"preserved credentials"}');
  writeFileSync(path, previous);
  for (const input of [
    Buffer.from("legacy unframed bytes"),
    writeFrame(Buffer.from("framed bytes")),
  ]) {
    const result = spawnSync(process.execPath, [bridge, "write", path], { input });
    expect(result.status).toBe(1);
    expect(readFileSync(path)).toEqual(previous);
  }
});

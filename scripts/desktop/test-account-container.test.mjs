// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { watch } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { hostDuckDb } from "../duckdb-extensions.mjs";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const gateway = new URL("../../packages/gateway/", import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(body) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-account-assets-")));
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "omnesis-account-control-")));
  let server;
  try {
    const scripts = join(root, "scripts", "desktop");
    const packageDir = join(root, "packages", "gateway");
    await mkdir(scripts, { recursive: true });
    await mkdir(join(packageDir, "duckdb-extensions"), { recursive: true });
    await mkdir(join(packageDir, "node_modules", "@duckdb"), { recursive: true });
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ type: "module" }));
    const gatewayRequire = createRequire(new URL("package.json", gateway));
    await symlink(
      dirname(gatewayRequire.resolve("@duckdb/node-api/package.json")),
      join(packageDir, "node_modules", "@duckdb", "node-api"),
    );
    for (const name of ["playwright", "vitest"]) {
      await symlink(
        dirname(require.resolve(`${name}/package.json`)),
        join(root, "node_modules", name),
      );
    }
    await symlink(
      await realpath(new URL("../lib/", import.meta.url)),
      join(root, "scripts", "lib"),
    );
    // A single filesystem-boundary fault leaves the complete runner lifecycle real.
    const runner = await readFile(new URL("./test-account-container.mjs", import.meta.url), "utf8");
    await writeFile(
      join(scripts, "test-account-container.mjs"),
      runner.replace('from "node:fs/promises"', 'from "./fixture-filesystem.mjs"'),
    );
    await writeFile(
      join(scripts, "fixture-filesystem.mjs"),
      `
      export * from 'node:fs/promises';
      import {rm as remove} from 'node:fs/promises';
      import {dirname,basename} from 'node:path';
      export function rm(path,options){
        if(process.env.FIXTURE_DOCKER_MODE?.startsWith('scratch-rm-') &&
          dirname(path)===process.env.TMPDIR && basename(path).startsWith('omnesis-account-container-'))
          throw Object.assign(new Error('Invented owned control removal refusal'),{code:'EACCES'});
        return remove(path,options);
      }
    `,
    );
    await writeFile(
      join(root, "bin/ps"),
      `#!${process.execPath}
      import {existsSync} from 'node:fs';import {spawnSync} from 'node:child_process';
      if(existsSync(${JSON.stringify(join(root, "observation-failed"))}))process.exit(1);
      const result=spawnSync('/bin/ps',process.argv.slice(2),{stdio:'inherit'});
      process.exitCode=result.status ?? 1;
    `,
      { mode: 0o700 },
    );
    await copyFile(
      new URL("../duckdb-extensions.mjs", import.meta.url),
      join(root, "scripts", "duckdb-extensions.mjs"),
    );
    await copyFile(
      new URL("./account-test.Dockerfile", import.meta.url),
      join(scripts, "account-test.Dockerfile"),
    );
    const reported = await hostDuckDb(packageDir);
    const bytes = Buffer.from("invented pinned account fixture extension bytes");
    const asset = join(
      packageDir,
      "duckdb-extensions",
      reported.version,
      reported.platform,
      "httpfs.duckdb_extension",
    );
    const calls = join(root, "docker-calls.jsonl");
    const docker = join(root, "bin", "docker");
    await writeFile(
      docker,
      `#!${process.execPath}
import * as fs from 'node:fs';import * as crypto from 'node:crypto';
const base=${JSON.stringify(root)}, asset=${JSON.stringify(asset)}, calls=${JSON.stringify(calls)};
const args=process.argv.slice(2), command=args[0], mode=process.env.FIXTURE_DOCKER_MODE;
const stateFile=base+'/fake-container.json', attach=base+'/attach-live';
const id='c'.repeat(64), image='sha256:'+'d'.repeat(64);
let content;try{content=fs.readFileSync(asset)}catch{}
const record=(command)=>fs.appendFileSync(calls,JSON.stringify({command, args,sha256:content?crypto.createHash('sha256').update(content).digest('hex'):null})+'\\n');
record(command);
if(mode==='observation-failure')fs.writeFileSync(base+'/observation-failed','fail');
if(command==='image') process.stdout.write(JSON.stringify([{Id:image}]));
else if(command==='create') {
 const name=args[args.indexOf('--name')+1], nonce=args[args.indexOf('--label')+1].split('=')[1];
 const marker=args.filter((a)=>a.startsWith('type=bind,')).find((a)=>a.includes('target=/run/desktop-account-container.json'));
 fs.writeFileSync(base+'/marker-path',marker.split(',')[1].slice('source='.length));
 fs.writeFileSync(base+'/docker-config',process.env.DOCKER_CONFIG);
 fs.writeFileSync(stateFile,JSON.stringify({Id:id,Image:image,Name:'/'+name,Config:{Hostname:name,Labels:{'dev.omnesis.test.desktop-account':nonce}},State:{Running:false,Status:'created',ExitCode:0,OOMKilled:false,StartedAt:'0001-01-01T00:00:00Z'}}));
 if(mode==='foreign-create') {const state=JSON.parse(fs.readFileSync(stateFile));state.Config.Labels['dev.omnesis.test.desktop-account']='different invented nonce';fs.writeFileSync(stateFile,JSON.stringify(state));process.exitCode=1}
 else if(mode==='lost-create') process.exitCode=1; else process.stdout.write(id+'\\n');
} else if(command==='container') {
 if(fs.existsSync(attach)) {record('premature-control');process.exitCode=9}
 else {const state=JSON.parse(fs.readFileSync(stateFile));if(![id,state.Name.slice(1)].includes(args[2]))process.exit(10);process.stdout.write(JSON.stringify([state]))}
} else if(command==='start') {
 if(args[2]!==id)process.exit(11);
 const state=JSON.parse(fs.readFileSync(stateFile));
 state.State={Running:mode?.startsWith('cancel')===true,Status:mode?.startsWith('cancel')?'running':'exited',ExitCode:mode==='fail-rm'||mode==='scratch-rm-primary'?7:0,OOMKilled:false,StartedAt:'2026-01-01T00:00:00Z'};
 fs.writeFileSync(stateFile,JSON.stringify(state));
 if(mode?.startsWith('cancel')) {
  fs.writeFileSync(attach,'live');
  const hold=setInterval(()=>{},1000);
  process.on('SIGTERM',()=>{
   if(mode==='cancel-before-marker'){clearInterval(hold);fs.unlinkSync(attach);process.exitCode=143;return;}
   fs.writeFileSync(base+'/attach-term','received');
   const finish=()=>{if(!fs.existsSync(base+'/release-attach'))return;watcher.close();clearInterval(hold);fs.unlinkSync(attach);record('attach-closed');process.exitCode=143};
   const watcher=fs.watch(base,finish);finish();
  });
  process.stdout.write('fake-attach-ready\\n');
 } else if(mode==='fail-rm'||mode==='scratch-rm-primary') process.exitCode=7;
} else if(command==='stop') {
 if(args.at(-1)!==id)process.exit(12);
 const state=JSON.parse(fs.readFileSync(stateFile));state.State.Running=false;state.State.Status='exited';state.State.ExitCode=143;fs.writeFileSync(stateFile,JSON.stringify(state));
} else if(command==='wait') {
 if(args[1]!==id)process.exit(13);
 process.stdout.write(String(mode==='wait-mismatch'?42:JSON.parse(fs.readFileSync(stateFile)).State.ExitCode)+'\\n');
} else if(command==='rm') {
 if(args[1]!==id || args.includes('--force'))process.exit(14);
 else if(mode==='fail-rm')process.exitCode=2;
 else {fs.unlinkSync(stateFile);process.stdout.write(id+'\\n')};
}
`,
      { mode: 0o700 },
    );
    await chmod(docker, 0o700);
    const requests = [];
    const serve = async (payload) => {
      server = createServer((request, response) => {
        requests.push(request.url);
        response.end(gzipSync(payload));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    };
    const configure = async (repository) => {
      await writeFile(
        join(packageDir, "duckdb-extensions", "manifest.json"),
        JSON.stringify({
          duckdbVersion: reported.version,
          repository,
          extensions: {
            httpfs: { [reported.platform]: { size: bytes.length, sha256: hash(bytes) } },
          },
        }),
      );
    };
    const launch = (repository, mode) =>
      execute(process.execPath, [join(scripts, "test-account-container.mjs")], {
        cwd: root,
        env: {
          ...process.env,
          CI: "true",
          TMPDIR: temporary,
          DOCKER_HOST: "",
          DOCKER_CONTEXT: "",
          DOCKER_TLS_VERIFY: "",
          DOCKER_CERT_PATH: "",
          FIXTURE_DOCKER_MODE: mode,
          PATH: join(root, "bin") + delimiter + process.env.PATH,
          OMNESIS_DUCKDB_EXTENSION_REPOSITORY: repository,
        },
        timeout: 25000,
      });
    const recorded = async () =>
      (
        await readFile(calls, "utf8").catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        })
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    await body({
      root,
      temporary,
      bytes,
      asset,
      reported,
      requests,
      serve,
      configure,
      launch,
      recorded,
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")(
  "account launcher prepares actual pinned assets before any image build or container run",
  async () => {
    await fixture(
      async ({ bytes, asset, reported, requests, serve, configure, launch, recorded }) => {
        const repository = await serve(bytes);
        await configure(repository);
        await launch(repository);
        expect(requests).toEqual([
          `/${reported.version}/${reported.platform}/httpfs.duckdb_extension.gz`,
        ]);
        expect(await readFile(asset)).toEqual(bytes);
        expect((await recorded()).map(({ command, sha256 }) => ({ command, sha256 }))).toEqual(
          [
            "build",
            "image",
            "create",
            "container",
            "start",
            "container",
            "wait",
            "container",
            "container",
            "rm",
          ].map((command) => ({ command, sha256: hash(bytes) })),
        );
      },
    );
  },
);

test.skipIf(process.platform === "win32")(
  "account launcher uses a verified cached asset without contacting its unavailable repository",
  async () => {
    await fixture(async ({ bytes, asset, configure, launch, recorded }) => {
      const repository = "http://127.0.0.1:1";
      await configure(repository);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, bytes);
      await launch(repository);
      expect((await recorded()).map(({ command, sha256 }) => ({ command, sha256 }))).toEqual(
        [
          "build",
          "image",
          "create",
          "container",
          "start",
          "container",
          "wait",
          "container",
          "container",
          "rm",
        ].map((command) => ({ command, sha256: hash(bytes) })),
      );
    });
  },
);

test.skipIf(process.platform === "win32")(
  "account launcher refuses checksum-invalid preparation before building or running Docker",
  async () => {
    await fixture(async ({ requests, serve, configure, launch, recorded }) => {
      const repository = await serve(Buffer.from("different invented bytes"));
      await configure(repository);
      await expect(launch(repository)).rejects.toMatchObject({ code: 1 });
      expect(requests).toHaveLength(4);
      expect(await recorded()).toEqual([]);
    });
  },
);

async function present(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function waitForFile(path, terminal) {
  let observe;
  const changed = new Promise((done, reject) => {
    observe = watch(dirname(path), async () => {
      try {
        if (await present(path)) done();
      } catch (error) {
        reject(error);
      }
    });
    observe.on("error", reject);
  });
  try {
    if (!(await present(path)))
      await Promise.race([
        changed,
        terminal.then(() => {
          throw Error("Owned runner ended before the file barrier");
        }),
      ]);
  } finally {
    observe.close();
  }
}

test.skipIf(process.platform === "win32")(
  "account cancellation joins the exact attach client before nonaborted retirement",
  async () => {
    await fixture(async ({ root, temporary, bytes, asset, configure, launch, recorded }) => {
      const repository = "http://127.0.0.1:1";
      await configure(repository);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, bytes);
      const run = launch(repository, "cancel");
      // Attach the rejection handler before the controlled signal can reject execution.
      const outcome = run.then(
        () => null,
        (error) => error,
      );
      try {
        let text = "";
        await new Promise((done, reject) => {
          run.child.stdout.on("data", (part) => {
            text += part;
            if (text.includes("fake-attach-ready")) done();
          });
          run.child.once("exit", () => reject(Error("Runner exited before attach barrier")));
        });
        run.child.kill("SIGTERM");
        await waitForFile(join(root, "attach-term"), outcome);
        // The fake control rejects any inspect while this exact client is still open.
        expect(await present(join(root, "attach-live"))).toBe(true);
      } finally {
        await writeFile(join(root, "release-attach"), "release");
        await outcome;
      }
      expect(await outcome).toMatchObject({ code: 1 });
      const calls = await recorded(),
        stages = calls.map(({ command }) => command);
      expect(stages).not.toContain("premature-control");
      expect(stages.indexOf("attach-closed")).toBeLessThan(stages.indexOf("stop"));
      expect(stages.slice(stages.indexOf("attach-closed") + 1)).toEqual([
        "container",
        "stop",
        "wait",
        "container",
        "container",
        "rm",
      ]);
      for (const call of calls.filter(({ command }) => ["stop", "wait", "rm"].includes(command)))
        expect(call.args.at(-1)).toBe("c".repeat(64));
      expect(await readdir(temporary)).toEqual([]);
      expect(await present(join(root, "fake-container.json"))).toBe(false);
    });
  },
);

test.skipIf(process.platform === "win32")(
  "failed account removal retains unmounted control and both original and cleanup failures",
  async () => {
    await fixture(async ({ root, temporary, bytes, asset, configure, launch, recorded }) => {
      const repository = "http://127.0.0.1:1";
      await configure(repository);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, bytes);
      const outcome = await launch(repository, "fail-rm").then(
        () => null,
        (error) => error,
      );
      expect(outcome).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("cleanup unconfirmed; private control retained"),
      });
      expect((outcome.stderr.match(/Desktop account fixture command failed/g) ?? []).length).toBe(
        2,
      );
      const dirs = await readdir(temporary);
      expect(dirs).toHaveLength(1);
      const control = join(temporary, dirs[0]);
      expect((await stat(control)).mode & 0o777).toBe(0o700);
      for (const leaf of ["identity.json", "cleanup.json"])
        expect((await stat(join(control, leaf))).mode & 0o777).toBe(0o600);
      const receipt = JSON.parse(await readFile(join(control, "cleanup.json"), "utf8"));
      expect(receipt).toMatchObject({
        verified: true,
        stopped: true,
        removed: false,
        cleanupConfirmed: false,
        id: "c".repeat(64),
      });
      expect(receipt.clients.every(({ closed, treeJoined }) => closed && treeJoined)).toBe(true);
      const config = await readFile(join(root, "docker-config"), "utf8");
      expect(config).toBe(join(control, "docker-config"));
      const calls = await recorded();
      const create = calls.find(({ command }) => command === "create");
      expect(create.args.some((arg) => arg.includes("source=" + config))).toBe(false);
      expect(create.args.some((arg) => arg.includes("source=" + control + ","))).toBe(false);
      const marker = await readFile(join(root, "marker-path"), "utf8");
      expect(dirname(marker)).toBe(join(control, "child-input"));
      expect(await present(join(root, "fake-container.json"))).toBe(true);
    });
  },
);

test.skipIf(process.platform === "win32")(
  "lost create reply is recovered only by exact nonce image and name before ID-only removal",
  async () => {
    await fixture(async ({ root, temporary, bytes, asset, configure, launch, recorded }) => {
      const repository = "http://127.0.0.1:1";
      await configure(repository);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, bytes);
      await expect(launch(repository, "lost-create")).rejects.toMatchObject({ code: 1 });
      const calls = await recorded();
      expect(calls.map(({ command }) => command)).toEqual([
        "build",
        "image",
        "create",
        "container",
        "container",
        "container",
        "rm",
      ]);
      expect(calls.at(-1).args).toEqual(["rm", "c".repeat(64)]);
      expect(await present(join(root, "fake-container.json"))).toBe(false);
      expect(await readdir(temporary)).toEqual([]);
    });
  },
);

test.skipIf(process.platform === "win32")(
  "lost create reply never grants control over a different nonce",
  async () => {
    await fixture(async ({ root, temporary, bytes, asset, configure, launch, recorded }) => {
      const repository = "http://127.0.0.1:1";
      await configure(repository);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, bytes);
      await expect(launch(repository, "foreign-create")).rejects.toMatchObject({ code: 1 });
      expect((await recorded()).map(({ command }) => command)).toEqual([
        "build",
        "image",
        "create",
        "container",
      ]);
      expect(await present(join(root, "fake-container.json"))).toBe(true);
      const dirs = await readdir(temporary);
      expect(dirs).toHaveLength(1);
      const control = join(temporary, dirs[0]);
      const receipt = JSON.parse(await readFile(join(control, "cleanup.json"), "utf8"));
      expect(receipt).toMatchObject({
        createAttempted: true,
        verified: false,
        stopped: false,
        removed: false,
        cleanupConfirmed: false,
      });
      expect(await present(join(control, "creation.json"))).toBe(true);
    });
  },
);

test.skipIf(process.platform === "win32")(
  "a mismatched exit receipt retains ownership instead of removing the container",
  async () => {
    await fixture(async ({ root, temporary, bytes, asset, configure, launch, recorded }) => {
      const repository = "http://127.0.0.1:1";
      await configure(repository);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, bytes);
      await expect(launch(repository, "wait-mismatch")).rejects.toMatchObject({ code: 1 });
      expect((await recorded()).some(({ command }) => command === "rm")).toBe(false);
      expect(await present(join(root, "fake-container.json"))).toBe(true);
      const dirs = await readdir(temporary);
      expect(dirs).toHaveLength(1);
      const receipt = JSON.parse(await readFile(join(temporary, dirs[0], "cleanup.json"), "utf8"));
      expect(receipt).toMatchObject({
        verified: true,
        stopped: false,
        removed: false,
        cleanupConfirmed: false,
      });
    });
  },
);

test.skipIf(process.platform === "win32")(
  "root close without a positive tree join retains account control",
  async () => {
    await fixture(async ({ temporary, bytes, asset, configure, launch, recorded }) => {
      const repository = "http://127.0.0.1:1";
      await configure(repository);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, bytes);
      await expect(launch(repository, "observation-failure")).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("client tree retirement unconfirmed"),
      });
      expect((await recorded()).map(({ command }) => command)).toEqual(["build"]);
      const dirs = await readdir(temporary);
      expect(dirs).toHaveLength(1);
      const receipt = JSON.parse(await readFile(join(temporary, dirs[0], "cleanup.json"), "utf8"));
      expect(receipt).toMatchObject({
        createAttempted: false,
        cleanupConfirmed: false,
        cleanupFailed: true,
        clients: [{ stage: "build", closed: true, treeJoined: false }],
      });
    });
  },
);

test.skipIf(process.platform === "win32").each(["success", "primary"])(
  "scratch removal refusal preserves %s outcome and distinct control uncertainty",
  async (outcome) => {
    await fixture(async ({ temporary, bytes, asset, configure, launch, recorded }) => {
      const repository = "http://127.0.0.1:1";
      await configure(repository);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, bytes);
      const failure = await launch(repository, "scratch-rm-" + outcome).then(
        () => null,
        (error) => error,
      );
      expect(failure).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("control cleanup unconfirmed; remaining evidence retained"),
      });
      expect(failure.stderr).toContain("Invented owned control removal refusal");
      if (outcome === "primary")
        expect(failure.stderr).toContain("Desktop account fixture command failed");
      else expect(failure.stderr).not.toContain("Desktop account fixture command failed");
      expect((await recorded()).at(-1).command).toBe("rm");
      const dirs = await readdir(temporary);
      expect(dirs).toHaveLength(1);
      const receipt = JSON.parse(await readFile(join(temporary, dirs[0], "cleanup.json"), "utf8"));
      expect(receipt).toMatchObject({
        stopped: true,
        removed: true,
        cleanupConfirmed: false,
        containerCleanupConfirmed: true,
        controlCleanup: "pending",
        commandFailed: outcome === "primary",
      });
    });
  },
);

test.skipIf(process.platform === "win32")(
  "terminal runner cancels the missing attach marker watcher and is joined",
  async () => {
    await fixture(async ({ root, temporary, bytes, asset, configure, launch, recorded }) => {
      const repository = "http://127.0.0.1:1";
      await configure(repository);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, bytes);
      const run = launch(repository, "cancel-before-marker"),
        outcome = run.then(
          () => null,
          (error) => error,
        );
      try {
        let text = "";
        await new Promise((done, reject) => {
          run.child.stdout.on("data", (part) => {
            text += part;
            if (text.includes("fake-attach-ready")) done();
          });
          run.child.once("exit", () => reject(Error("Runner exited before attach barrier")));
        });
        run.child.kill("SIGTERM");
        await expect(waitForFile(join(root, "attach-term"), outcome)).rejects.toThrow(
          "Owned runner ended before the file barrier",
        );
      } finally {
        await writeFile(join(root, "release-attach"), "release");
        await outcome;
      }
      expect(await present(join(root, "attach-term"))).toBe(false);
      expect((await recorded()).some(({ command }) => command === "rm")).toBe(true);
      expect(await readdir(temporary)).toEqual([]);
    });
  },
);

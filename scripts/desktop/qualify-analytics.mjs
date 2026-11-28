// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { writeFile, mkdir } from "node:fs/promises";
import { stagePinnedDuckDbExtensions } from "./pinned-extensions.mjs";

/** Check the loaded engine and explicit result lifetime before any encrypted-file probe. */
export async function qualifyDesktopAnalyticsLifecycle(conn, engineVersion) {
  const version = (await conn.runAndReadAll("SELECT version() AS version")).getRowObjects()[0]
    ?.version;
  if (version !== engineVersion) throw new Error("unexpected analytics engine");
  const pending = await conn.start("SELECT i FROM range(4096) AS rows(i)");
  pending.closeSync();
  pending.closeSync();
  let pendingClosed = false;
  try {
    pending.runTask();
  } catch {
    pendingClosed = true;
  }
  if (!pendingClosed) throw new Error("pending result remained open");
  const streaming = await conn.stream("SELECT i FROM range(100000) AS rows(i)");
  try {
    const firstChunk = await streaming.fetchChunk();
    if (
      !streaming.isStreaming ||
      !firstChunk ||
      firstChunk.rowCount < 1 ||
      firstChunk.rowCount >= 100000
    )
      throw new Error("stream did not produce a partial result");
  } finally {
    streaming.closeSync();
  }
  streaming.closeSync();
  let streamClosed = false;
  try {
    await streaming.fetchChunk();
  } catch {
    streamClosed = true;
  }
  if (!streamClosed) throw new Error("stream remained open");
  await conn.run("SET threads=1");
  await conn.run("SET streaming_buffer_size='1MB'");
  const failing = await conn.stream(
    "SELECT CASE WHEN i < 999999 THEN i ELSE error('invented qualification failure') END FROM range(1000000) AS rows(i)",
  );
  let fetchFailed = false;
  let deliveredRows = 0;
  try {
    if (!failing.isStreaming) throw new Error("qualification result is not streaming");
    for (;;) {
      const chunk = await failing.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      deliveredRows += chunk.rowCount;
    }
  } catch (error) {
    fetchFailed =
      error instanceof Error && error.message.includes("invented qualification failure");
  } finally {
    failing.closeSync();
  }
  if (!fetchFailed || deliveredRows < 1 || deliveredRows >= 1000000)
    throw new Error("late fetch failure was not reported after rows");
}

const program = String.raw`
const { createRequire } = require('node:module');
const { join } = require('node:path');
const requireFrom = createRequire(join(process.argv[1], 'package.json'));
const { DuckDBInstance } = requireFrom('@duckdb/node-api');
const qualifyLifecycle = ${qualifyDesktopAnalyticsLifecycle.toString()};
(async () => {
  let input = '';
  for await (const block of process.stdin) {
    input += block;
    if (input.length > 16384) throw new Error('invalid fixture input');
  }
  const { database, key, extension, step, engineVersion } = JSON.parse(input);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const instance = await DuckDBInstance.create(':memory:', {
    autoload_known_extensions: 'false', autoinstall_known_extensions: 'false',
  });
  const conn = await instance.connect();
  try {
    await qualifyLifecycle(conn, engineVersion);
    if (extension) await conn.run('LOAD ' + quote(extension));
    else {
      const crypto = await conn.runAndReadAll("SELECT installed,install_mode,install_path FROM duckdb_extensions() WHERE extension_name='httpfs'");
      const row = crypto.getRowObjects()[0];
      if (row?.installed !== true || row.install_mode !== 'STATICALLY_LINKED' || row.install_path !== '(BUILT-IN)')
        throw new Error('missing built-in module');
      await conn.run('LOAD httpfs');
    }
    await conn.run('ATTACH ' + quote(database) + ' AS qualified (ENCRYPTION_KEY ' + quote(key) + ')');
    if (step === 1) await conn.run('CREATE TABLE qualified.proof (value INTEGER CHECK(value=42)); INSERT INTO qualified.proof VALUES (42)');
    const rows = (await conn.runAndReadAll('SELECT value FROM qualified.proof')).getRowObjects();
    if (rows.length !== step || rows.some(row => row.value !== 42)) throw new Error('encrypted fixture differs');
    if (step < 3) await conn.run('INSERT INTO qualified.proof VALUES (42)');
    await conn.run('DETACH qualified');
    process.stdout.write('qualified\n');
  } finally { conn.closeSync(); instance.closeSync(); }
})().catch(() => { process.stderr.write('Analytics compatibility qualification failed\n'); process.exitCode=1; });
`;

/** Three real processes cross the upstream/custom encryption boundary in both directions. */
export function qualifyDesktopAnalytics(
  { input, target, node, architecture, scratch, env },
  { run = spawnSync, stageExtensions = stagePinnedDuckDbExtensions } = {},
) {
  const home = join(scratch, "analytics-qualification");
  mkdirSync(home, { mode: 0o700 });
  stageExtensions({ input, target: home, node, architecture, env });
  const manifest = JSON.parse(
    readFileSync(join(home, "packages/gateway/duckdb-extensions/manifest.json"), "utf8"),
  );
  const platform = architecture === "arm64" ? "osx_arm64" : "osx_amd64";
  const extension = join(
    home,
    "packages/gateway/duckdb-extensions",
    manifest.duckdbVersion,
    platform,
    "httpfs.duckdb_extension",
  );
  const key = randomBytes(32).toString("hex");
  for (const [index, root] of [input, target, input].entries()) {
    const result = run(node, ["--eval", program, root], {
      cwd: home,
      env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin", LANG: "C" },
      input: JSON.stringify({
        database: join(home, "proof.duckdb"),
        key,
        step: index + 1,
        engineVersion: manifest.duckdbVersion,
        extension: index === 1 ? undefined : extension,
      }),
      encoding: "utf8",
      maxBuffer: 16384,
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    if (result.error || result.status !== 0 || result.stdout !== "qualified\n")
      throw new Error(
        "The packaged analytics engine failed upstream encrypted-file interoperability",
      );
  }
  return { extension, engineVersion: manifest.duckdbVersion };
}

const sourceProgram = String.raw`
const {createRequire}=require('node:module');
const requireFrom=createRequire(require('node:path').join(process.argv[1],'package.json'));
(async()=>{
 process.umask(0o077);
 let text='';for await(const block of process.stdin){text+=block;if(text.length>16384)throw Error('input bound');}
 const {database,key,extension,engineVersion}=JSON.parse(text);
 const {DuckDBInstance}=requireFrom('@duckdb/node-api');
 const instance=await DuckDBInstance.create(':memory:',{threads:'1',temp_directory:'',autoload_known_extensions:'false',autoinstall_known_extensions:'false',allow_unsigned_extensions:'false'});
 let connection;
 const quote=value=>"'"+value.replaceAll("'","''")+"'";
 try{
  connection=await instance.connect();
  if((await connection.runAndReadAll('SELECT version() AS version')).getRowObjects()[0]?.version!==engineVersion)throw Error('engine mismatch');
  await connection.run('LOAD '+quote(extension));
  await connection.run('ATTACH '+quote(database)+' AS original (ENCRYPTION_KEY '+quote(key)+')');
  await connection.run('CREATE TABLE original.main.records(id BIGINT PRIMARY KEY, content VARCHAR NOT NULL, enabled BOOLEAN DEFAULT false)');
  await connection.run("INSERT INTO original.main.records(id,content) VALUES (1,'Invented staged analytics record'),(2,'Invented second analytics record')");
  await connection.run('CHECKPOINT original');
  await connection.run('DETACH original');
 }finally{try{connection?.closeSync();}finally{instance.closeSync();}}
 require('node:fs').chmodSync(database,0o600);
 process.stdout.write('restore-source-ready\n');
})().catch(()=>{process.stderr.write('Analytics restore source preparation failed\n');process.exitCode=1;});
`;

const restoreStages = [
  "input",
  "beforeDataFD",
  "modules",
  "readSource",
  "seal",
  "productionRestore",
  "values",
  "output",
  "dataFDDone",
  "receipt",
];
const restoreErrorClasses = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "other",
  "unavailable",
];
const restoreErrorCodes = [
  "none",
  "other",
  "unavailable",
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_DLOPEN_FAILED",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "EACCES",
  "ENOENT",
  "EIO",
  "EPERM",
  "ENOTSUP",
  "EBADF",
  "EINVAL",
  "EEXIST",
  "ENOSPC",
];
const unavailableDiagnostic = () => ({
  stage: "unavailable",
  errorClass: "unavailable",
  errorCode: "unavailable",
});

/** Accept only complete ordered fixed markers; never expose raw tool diagnostics. */
export function analyticsRestoreDiagnostic(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16384 || !text.endsWith("\n"))
    return unavailableDiagnostic();
  let next = 0,
    failure;
  for (const line of text.slice(0, -1).split("\n")) {
    if (failure) return unavailableDiagnostic();
    if (next < restoreStages.length && line === "analytics-restore-stage:" + restoreStages[next]) {
      next += 1;
      continue;
    }
    const parts = line.split(":");
    if (
      parts.length !== 4 ||
      parts[0] !== "analytics-restore-failure" ||
      next === 0 ||
      parts[1] !== restoreStages[next - 1] ||
      !restoreErrorClasses.includes(parts[2]) ||
      !restoreErrorCodes.includes(parts[3])
    )
      return unavailableDiagnostic();
    failure = { stage: parts[1], errorClass: parts[2], errorCode: parts[3] };
  }
  return (
    failure ??
    (next
      ? { ...unavailableDiagnostic(), stage: restoreStages[next - 1] }
      : unavailableDiagnostic())
  );
}

export function projectAnalyticsRestoreFailure(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "errorClass,errorCode,role,stage" ||
    !["source", "target"].includes(value.role) ||
    ![...restoreStages, "unavailable"].includes(value.stage) ||
    !restoreErrorClasses.includes(value.errorClass) ||
    !restoreErrorCodes.includes(value.errorCode)
  )
    return { role: "unavailable", ...unavailableDiagnostic() };
  return {
    role: value.role,
    stage: value.stage,
    errorClass: value.errorClass,
    errorCode: value.errorCode,
  };
}

const restoreProgram = String.raw`
const {createRequire}=require('node:module');
const {join}=require('node:path');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs/promises');
const requireFrom=createRequire(join(process.argv[1],'package.json'));
let restoreStage='input';
const checkpoint=stage=>{restoreStage=stage;process.stderr.write('analytics-restore-stage:'+stage+'\n');};
const failureFact=error=>{
 const classes=['Error','TypeError','RangeError','SyntaxError','AbortError'];
 const codes=['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_DLOPEN_FAILED','ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','EACCES','ENOENT','EIO','EPERM','ENOTSUP','EBADF','EINVAL','EEXIST','ENOSPC'];
 const errorClass=classes.includes(error?.name)?error.name:'other';
 const errorCode=error?.code===undefined?'none':codes.includes(error.code)?error.code:'other';
 process.stderr.write('analytics-restore-failure:'+restoreStage+':'+errorClass+':'+errorCode+'\n');
};
async function privateBytes(path){
 const {constants}=require('node:fs');
 const handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await handle.stat({bigint:true});
  if(!before.isFile() || before.nlink!==1n || before.uid!==BigInt(process.getuid()) || (before.mode&0o777n)!==0o600n || before.size<0n || before.size>16n*1024n*1024n)throw Error('file ownership');
  const buffer=Buffer.alloc(Number(before.size)+1);let size=0;
  while(size<buffer.length){const read=await handle.read(buffer,size,buffer.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead;}
  const after=await handle.stat({bigint:true}),published=await fs.lstat(path,{bigint:true});
  if(BigInt(size)!==before.size || after.size!==before.size || after.dev!==before.dev || after.ino!==before.ino || after.mtimeNs!==before.mtimeNs || after.ctimeNs!==before.ctimeNs || published.dev!==before.dev || published.ino!==before.ino || !published.isFile() || published.isSymbolicLink())throw Error('file changed');
  return buffer.subarray(0,size);
 }finally{await handle.close();}
}
(async()=>{
 process.umask(0o077);
 checkpoint('input');
 let text='';for await(const block of process.stdin){text+=block;if(text.length>16384)throw Error('input bound');}
 const {source,sourceKey,destinationKey,work,engineVersion,scope:expectedScope,architecture}=JSON.parse(text);
 if(process.platform!=='darwin' || process.arch!==architecture)throw Error('target architecture');
 const nativeFs=require('node:fs');
 const dataPath=join(expectedScope.configDir+'.bootstrap','.data-use-'+expectedScope.secretService.slice(-64)+'.lock');
 const dataIdentity=()=>{
  const held=nativeFs.fstatSync(7,{bigint:true}),published=nativeFs.lstatSync(dataPath,{bigint:true});
  if(!held.isFile() || held.uid!==BigInt(process.getuid()) || held.nlink!==1n || (held.mode&0o777n)!==0o600n || held.dev!==published.dev || held.ino!==published.ino || published.isSymbolicLink())throw Error('native data descriptor');
  return {dev:held.dev,ino:held.ino};
 };
 checkpoint('beforeDataFD');
 const beforeData=dataIdentity();
 checkpoint('modules');
 const runtime=await fs.realpath(process.argv[1]);
 const entry=await fs.realpath(requireFrom.resolve('@omnesis/gateway/dist/restore/auxiliary-entry.js'));
 if(entry!==join(runtime,'packages/gateway/dist/restore/auxiliary-entry.js'))throw Error('compiled entry boundary');
 const coreEntry=await fs.realpath(requireFrom.resolve('@omnesis/core'));
 if(coreEntry!==join(runtime,'packages/core/dist/index.js'))throw Error('compiled core boundary');
 try{await fs.lstat(join(runtime,'packages/gateway/duckdb-extensions'));throw Error('external extension directory');}
 catch(error){if(error.code!=='ENOENT')throw error;}
 const {restoreAuxiliaryEntry}=await import(pathToFileURL(entry).href);
 const {produceEncryptedArtifact,generateInstallRootKey,GATEWAY_ANALYTICS_STORE_FILE}=await import(pathToFileURL(coreEntry).href);
 const apiRequire=createRequire(entry);
 const apiEntry=await fs.realpath(apiRequire.resolve('@duckdb/node-api'));
 if(!apiEntry.startsWith(runtime+'/'))throw Error('analytics module boundary');
 const {DuckDBInstance}=apiRequire('@duckdb/node-api');
 checkpoint('readSource');
 const original=await privateBytes(source);
 if(original.length>16*1024*1024 || original.subarray(8,12).toString('ascii')!=='DUCK' || (original.readBigUInt64LE(20)&1n)!==1n)throw Error('source encryption');
 checkpoint('seal');
 const rootKey=generateInstallRootKey(), sealed=join(work,'backup.enc'), staging=join(work,'authenticated.db'), destination=join(work,'restored.db');
 const scope='desktop-restore:analytics-qualification';
 await produceEncryptedArtifact(sealed,{rootKey,scope},async body=>{await new Promise((done,reject)=>body.write(original,error=>error?reject(error):done()));});
 checkpoint('productionRestore');
 const result=await restoreAuxiliaryEntry({kind:'analytics',entry:{path:sealed,scope,targetRootKey:rootKey,sourceRootKey:rootKey,logicalName:GATEWAY_ANALYTICS_STORE_FILE,sourceScope:null,bytes:original.length},sourceKey:Buffer.from(sourceKey,'hex'),sourceCipherPath:staging,destinationPath:destination,destinationKey:Buffer.from(destinationKey,'hex')});
 if(result.rowsPreserved!==2 || result.pendingWorkDiscarded!==0 || result.watchesPaused!==0)throw Error('restore row counts');
 try{await fs.lstat(staging);throw Error('staging remains');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!(await privateBytes(source)).equals(original))throw Error('source changed');
 checkpoint('values');
 const instance=await DuckDBInstance.create(':memory:',{threads:'1',temp_directory:'',autoload_known_extensions:'false',autoinstall_known_extensions:'false',allow_unsigned_extensions:'false'});
 let connection;
 const quote=value=>"'"+value.replaceAll("'","''")+"'";
 try{
  connection=await instance.connect();
  if((await connection.runAndReadAll('SELECT version() AS version')).getRowObjects()[0]?.version!==engineVersion)throw Error('target engine version');
  const rows=(await connection.runAndReadAll("SELECT installed,install_mode,install_path FROM duckdb_extensions() WHERE extension_name='httpfs'")).getRowObjects();
  if(rows.length!==1 || rows[0].installed!==true || rows[0].install_mode!=='STATICALLY_LINKED' || rows[0].install_path!=='(BUILT-IN)')throw Error('static module');
  await connection.run('LOAD httpfs');
  let oldKeyRefused=false;
  try{await connection.run('ATTACH '+quote(destination)+' AS wrong_key (READ_ONLY,ENCRYPTION_KEY '+quote(sourceKey)+')');}catch{oldKeyRefused=true;}
  if(!oldKeyRefused)throw Error('old key accepted');
  await connection.run('ATTACH '+quote(destination)+' AS restored (ENCRYPTION_KEY '+quote(destinationKey)+')');
  const restored=(await connection.runAndReadAll('SELECT id,content,enabled FROM restored.main.records ORDER BY id')).getRows();
  if(restored.length!==2 || restored[0][0]!==1n || restored[0][1]!=='Invented staged analytics record' || restored[1][0]!==2n || restored[1][1]!=='Invented second analytics record' || restored.some(row=>row[2]!==false))throw Error('restored values');
  const constraints=(await connection.runAndReadAll("SELECT constraint_type,to_json(constraint_column_names)::VARCHAR AS columns FROM duckdb_constraints() WHERE database_name='restored' AND table_name='records'")).getRowObjects();
  if(!constraints.some(row=>row.constraint_type==='PRIMARY KEY' && row.columns==='["id"]') || !constraints.some(row=>row.constraint_type==='NOT NULL' && row.columns==='["content"]'))throw Error('restored constraints');
  await connection.run('BEGIN TRANSACTION');
  try{
   await connection.run("INSERT INTO restored.main.records(id,content) VALUES(3,'Invented temporary verification record')");
   if((await connection.runAndReadAll('SELECT enabled FROM restored.main.records WHERE id=3')).getRows()[0]?.[0]!==false)throw Error('restored default');
  }finally{await connection.run('ROLLBACK');}
  await connection.run('DETACH restored');
 }finally{try{connection?.closeSync();}finally{instance.closeSync();}}
 checkpoint('output');
 const allowed=['backup.enc','restored.db'];
 const actual=(await fs.readdir(work)).sort();
 if(JSON.stringify(actual)!==JSON.stringify(allowed))throw Error('unexpected restore output');
 for(const name of allowed){const path=join(work,name),info=await fs.lstat(path);if(!info.isFile() || info.isSymbolicLink() || (info.mode&0o777)!==0o600)throw Error('private output');const bytes=await privateBytes(path);if(bytes.length>16*1024*1024 || bytes.includes(Buffer.from('Invented staged analytics record')) || bytes.includes(Buffer.from('Invented second analytics record')) || bytes.includes(Buffer.from('Invented temporary verification record')))throw Error('plaintext output');}
 const destinationBytes=await privateBytes(destination);
 if(destinationBytes.subarray(8,12).toString('ascii')!=='DUCK' || (destinationBytes.readBigUInt64LE(20)&1n)!==1n)throw Error('destination encryption');
 const afterData=dataIdentity();
 if(beforeData.dev!==afterData.dev || beforeData.ino!==afterData.ino)throw Error('native data descriptor changed');
 checkpoint('dataFDDone');
 checkpoint('receipt');
 await fs.writeFile(join(work,'qualification.json'),JSON.stringify({format:1,compiledEntry:true,staticModule:true,sourceUnchanged:true,keyedRowsAndConstraints:true,encryptedPrivateOutputs:true,authenticatedStagingRemoved:true,nativeDataFdMatched:true}),{flag:'wx',mode:0o600});
 process.stdout.write('compiled-restore-qualified\n');
})().catch(error=>{failureFact(error);process.exitCode=1;});
`;

async function restoreProcess(executable, args, { home, role, env, input, signal }) {
  const deadline = performance.now() + 60000;
  signal?.throwIfAborted();
  const { waitForChild } = await import("../lib/check-process.mjs");
  signal?.throwIfAborted();
  if (performance.now() >= deadline)
    throw new Error("Analytics restore qualification startup expired");
  const child = spawn(executable, args, {
    cwd: home,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((done) => child.once("close", done));
  let treeJoined = false;
  const signals = new EventEmitter();
  const joined = waitForChild(child, {
    signalEmitter: signals,
    onJoined: () => {
      treeJoined = true;
    },
  });
  void joined.catch(() => {});
  let output = "",
    diagnostics = "",
    bytes = 0,
    failure,
    forced = false;
  const stop = () => {
    forced = true;
    signals.emit("SIGTERM");
  };
  const timer = setTimeout(stop, Math.max(0, deadline - performance.now()));
  signal?.addEventListener("abort", stop, { once: true });
  child.stdin.on("error", stop);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("error", stop);
    stream.on("data", (part) => {
      bytes += part.length;
      if (bytes > 16384) stop();
      else if (stream === child.stdout) output += part.toString("utf8");
      else diagnostics += part.toString("utf8");
    });
  }
  child.stdin.end(input);
  let code;
  try {
    if (signal?.aborted) stop();
    code = await joined;
  } catch (error) {
    failure = error;
  }
  await closed;
  clearTimeout(timer);
  signal?.removeEventListener("abort", stop);
  forced ||= performance.now() >= deadline;
  try {
    await writeFile(
      join(home, `analytics-restore-${role}-process.json`),
      JSON.stringify({
        format: 1,
        role,
        rootClosed: true,
        treeJoined,
        code: Number.isInteger(code) ? code : null,
        forced,
      }),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    throw Object.assign(
      new Error("Analytics qualification receipt could not be retained", { cause: error }),
      { cleanupFailure: "analytics-qualification-evidence" },
    );
  }
  const failed = (error) =>
    Object.defineProperty(error, "analyticsRestoreFailure", {
      value: { role, ...analyticsRestoreDiagnostic(bytes > 16384 ? "" : diagnostics) },
    });
  if (!treeJoined)
    throw failed(
      Object.assign(
        new Error("Analytics qualification process ownership remains unconfirmed", {
          cause: failure,
        }),
        { cleanupFailure: "analytics-qualification-client" },
      ),
    );
  if (failure || forced || code !== 0)
    throw failed(new Error("Analytics restore qualification process failed"));
  return output;
}

/** Only the closed analytics smoke mode supplies this sealed runtime/profile owner. */
export async function qualifyDesktopAnalyticsRestore(
  { input, upstreamNode, runtime, home, scope, env, upstream },
  { run = restoreProcess } = {},
) {
  const sourceHome = join(home, "analytics-restore-input");
  const work = join(scope.configDir, "analytics-restore");
  await mkdir(sourceHome, { mode: 0o700 });
  await mkdir(work, { mode: 0o700 });
  const source = join(sourceHome, "source.db"),
    sourceKey = randomBytes(32).toString("hex"),
    destinationKey = randomBytes(32).toString("hex");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, cancel);
  try {
    const sourceReady = await run(upstreamNode, ["--eval", sourceProgram, input], {
      home,
      role: "source",
      env: {
        HOME: sourceHome,
        TMPDIR: sourceHome,
        PATH: "/usr/bin:/bin",
        LANG: "C",
        OMNESIS_RUNTIME_MODE: "test",
        OMNESIS_TELEMETRY: "0",
        OMNESIS_E2E_ANALYTICS_RESTORE: "1",
      },
      input: JSON.stringify({
        database: source,
        key: sourceKey,
        extension: upstream.extension,
        engineVersion: upstream.engineVersion,
      }),
      signal: controller.signal,
    });
    if (sourceReady !== "restore-source-ready\n")
      throw new Error("Analytics restore source did not qualify");
    const result = await run(
      join(runtime, "runtime-exec"),
      [
        "--data-use",
        Buffer.from(JSON.stringify(scope)).toString("base64url"),
        "--node",
        "--eval",
        restoreProgram,
        runtime,
      ],
      {
        home,
        role: "target",
        env: {
          ...env,
          TMPDIR: work,
          OMNESIS_RUNTIME_MODE: "test",
          OMNESIS_TELEMETRY: "0",
          OMNESIS_E2E_ANALYTICS_RESTORE: "1",
        },
        input: JSON.stringify({
          source,
          sourceKey,
          destinationKey,
          work,
          engineVersion: upstream.engineVersion,
          scope,
          architecture: process.arch,
        }),
        signal: controller.signal,
      },
    );
    if (result !== "compiled-restore-qualified\n")
      throw new Error("Compiled analytics restore did not qualify");
    process.stdout.write(
      "Compiled staged analytics restore qualified with joined native data ownership.\n",
    );
  } finally {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.off(signal, cancel);
  }
}

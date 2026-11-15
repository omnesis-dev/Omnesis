// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareHermesRuntimeAssets } from "./integration-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("POSIX Hermes remains Python-only without a compiler or JavaScript runtime graph", () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-python-assets-"));
  roots.push(root);
  mkdirSync(join(root, "hermes"));
  for (const file of ["adapter.py", "__init__.py", "plugin.yaml"])
    writeFileSync(join(root, "hermes", file), `invented ${file}`);
  for (const platform of ["linux", "darwin"] as const) {
    const runtime = prepareHermesRuntimeAssets(
      { packageRoot: root, entry: join(root, "src/index.ts") },
      platform,
    );
    expect(runtime.files.map((f) => f.file)).toEqual(["__init__.py", "adapter.py", "plugin.yaml"]);
    runtime.cleanup();
  }
});

test("Windows source Hermes materializes fresh canonical helpers with no workspace runtime dependency", () => {
  const root = mkdtempSync(join(process.cwd(), ".hermes-artifact-fixture-"));
  roots.push(root);
  const source = join(process.cwd(), "packages/agent-integration");
  for (const name of [
    "src",
    "hermes",
    "package.json",
    "openclaw-entry.mjs",
    "openclaw.plugin.json",
  ])
    cpSync(join(source, name), join(root, name), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: join(process.cwd(), "tsconfig.base.json"),
      compilerOptions: { rootDir: "src" },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    }),
  );
  mkdirSync(join(root, "dist"));
  writeFileSync(
    join(root, "dist/windows-files.js"),
    "throw new Error('stale runtime must not ship')",
  );
  const runtime = prepareHermesRuntimeAssets(
    { packageRoot: root, entry: join(root, "src/index.ts") },
    "win32",
  );
  const deployed = mkdtempSync(join(tmpdir(), "hermes-standalone-assets-"));
  roots.push(deployed);
  try {
    expect(runtime.files.some((f) => f.file.endsWith("test_adapter.py"))).toBe(false);
    expect(
      runtime.files.some(
        (f) => f.file === join("runtime/private-platform/native/windows-worker-source.js"),
      ),
    ).toBe(true);
    for (const { file, content } of runtime.files) {
      const path = join(deployed, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {privateWindowsFiles} from './runtime/windows-files.js'; if(typeof privateWindowsFiles().readWindowsPrivateFileContentsSync !== 'function')throw Error('incomplete graph');console.log('standalone ready')",
      ],
      { cwd: deployed, encoding: "utf8", timeout: 20000 },
    );
    expect(output.trim()).toBe("standalone ready");
    expect(existsSync(join(deployed, "node_modules"))).toBe(false);
  } finally {
    runtime.cleanup();
  }
}, 30000);

test.runIf(process.platform === "win32")(
  "the generated Hermes runtime writes private files and accepts the actual bridge frame",
  () => {
    const source = join(process.cwd(), "packages/agent-integration");
    const runtime = prepareHermesRuntimeAssets(
      { packageRoot: source, entry: join(source, "src", "index.ts") },
      "win32",
    );
    const deployed = mkdtempSync(join(tmpdir(), "hermes-native-artifact-"));
    let passed = false;
    try {
      for (const { file, content } of runtime.files) {
        const path = join(deployed, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
      cpSync(join(source, "hermes", "test_adapter.py"), join(deployed, "test_adapter.py"));
      const pythonProbe = String.raw`
import json,os,runpy,subprocess,sys
adapter=runpy.run_path('test_adapter.py')['adapter_module']
path=os.path.abspath('invented-python-private.bin')
command=adapter._windows_node_command('read',path)
version=subprocess.run([command[0],'-p',"JSON.stringify({major:Number(process.versions.node.split('.')[0]),arch:process.arch})"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10,check=False)
try:
 identity=json.loads(version.stdout)
 if version.returncode or not isinstance(identity.get('major'),int) or identity.get('arch') not in ['x64','arm64','ia32']:raise RuntimeError('invalid identity')
 if sys.argv[1]=='read-write':
  data=bytes([0,255,10,65])
  adapter._windows_bridge('write',path,data)
  if adapter._windows_bridge('read',path)!=data:raise RuntimeError('byte mismatch')
 print(json.dumps({'passed':True,'node':identity}))
except Exception as error:
 print(json.dumps({'passed':False,'node':identity if 'identity' in locals() else {},'errorType':type(error).__name__ if type(error).__name__ in ['PermissionError','FileNotFoundError','RuntimeError','TimeoutExpired'] else 'failed'}))
 sys.exit(1)
`;
      writeFileSync(join(deployed, "python-probe.py"), pythonProbe);
      const script = String.raw`
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
let phase='load',proof={passed:false};
try {
 phase='python-identity';const identity=spawnSync('python',['-B','python-probe.py','identity'],{timeout:30000,encoding:'utf8'});
 if(identity.error||identity.signal||identity.status!==0){proof={...proof,pythonExit:identity.status,cleanupUnconfirmed:!!(identity.error||identity.signal)};throw Error('Python identity refused');}
 const identified=JSON.parse(identity.stdout);if(!identified.passed||!Number.isInteger(identified.node?.major)||!['x64','arm64','ia32'].includes(identified.node?.arch))throw Error('invalid bridge executable identity');
 proof={...proof,pythonNode:{major:identified.node.major,arch:identified.node.arch}};
 const {privateWindowsFiles}=await import('./runtime/windows-files.js');
 const files=privateWindowsFiles(),path=join(process.cwd(),'invented-private.json'),bytes=Buffer.from([0,255,10,65]);
 phase='direct-write';files.writeWindowsPrivateFileAtomicSync(path,bytes);
 phase='direct-read';if(!files.readWindowsPrivateFileContentsSync(path).equals(bytes))throw Error('byte mismatch');
 const magic=Buffer.from('OMNESIS_HERMES_WRITE_V1\0','ascii'),commit=Buffer.from('\0OMNESIS_HERMES_WRITE_COMMIT_V1\0','ascii'),length=Buffer.alloc(4);length.writeUInt32LE(bytes.length);
 phase='bridge-write';const written=spawnSync(process.execPath,['windows-files.mjs','write',path,'framed-v1'],{input:Buffer.concat([magic,length,bytes,commit]),timeout:30000});
 if(written.error||written.signal||written.status!==0){proof={...proof,bridgeExit:written.status,cleanupUnconfirmed:!!(written.error||written.signal)};throw Error('bridge refused');}
 phase='bridge-read';const read=spawnSync(process.execPath,['windows-files.mjs','read',path],{timeout:30000});
 if(read.error||read.signal||read.status!==0||!read.stdout.equals(bytes)){proof={...proof,bridgeExit:read.status,cleanupUnconfirmed:!!(read.error||read.signal)};throw Error('bridge refused');}
 phase='python-bridge';const python=spawnSync('python',['-B','python-probe.py','read-write'],{timeout:30000,encoding:'utf8'});
 if(python.error||python.signal||python.status!==0){proof={...proof,pythonExit:python.status,cleanupUnconfirmed:!!(python.error||python.signal)};throw Error('Python bridge refused');}
 const pythonResult=JSON.parse(python.stdout);if(!pythonResult.passed)throw Error('Python bytes not confirmed');
 proof={...proof,passed:true,phase:'complete',directAndFramedBytesVerified:true,pythonBridgeVerified:true};
} catch(error) {
 const stages=new Set(['resolve','parent','create','validate','write','commit','flush','rename','read','inspect','repair','unsafe-file','seal-private','cleanup']);
 const bootstrap=typeof error?.message==='string'&&error.message.startsWith('Cannot initialize the protected Windows native worker')?/\bEPRIVATE:([a-z-]{1,60}):([0-9]{1,10})\b/u.exec(error.message):null;
 const fixedReasons=new Map([['Cannot verify Windows native worker owner','owner-identity'],['Windows local application directory is unavailable','cache-root']]);
 proof={...proof,phase,...(bootstrap?{bootstrapStage:bootstrap[1],bootstrapNativeCode:Number(bootstrap[2])}:{}),...(fixedReasons.has(error?.message)?{reason:fixedReasons.get(error.message)}:{}),code:['EPRIVATE','EACCES','ENOENT','EEXIST','ERR_REQUIRE_ESM','ERR_REQUIRE_ASYNC_MODULE','ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_UNKNOWN_FILE_EXTENSION','ERR_REQUIRE_CYCLE_MODULE'].includes(error?.code)?error.code:'failed',...(stages.has(error?.stage)?{nativeStage:error.stage}:{}),...(Number.isInteger(error?.nativeCode)&&error.nativeCode>=0&&error.nativeCode<=4294967295?{nativeCode:error.nativeCode}:{}),...((error!==null&&(typeof error==='object'||typeof error==='function')&&Object.hasOwn(error,'cleanupFailure'))?{cleanupUnconfirmed:true}:{})};
 process.exitCode=1;
}
process.stdout.write(JSON.stringify(proof)+'\n');
`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: deployed,
        encoding: "utf8",
        timeout: 60_000,
      });
      // Only the fixed diagnostic record is included in assertions. Native stderr
      // can contain parser details and must never become a fixture error message.
      const proof = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
      const diagnostic = JSON.stringify(proof);
      expect(result.error, diagnostic).toBeUndefined();
      expect(result.signal, diagnostic).toBeNull();
      expect(result.status, diagnostic).toBe(0);
      expect(proof, diagnostic).toMatchObject({
        passed: true,
        directAndFramedBytesVerified: true,
        pythonBridgeVerified: true,
      });
      passed = true;
    } finally {
      // A failed or interrupted native observation does not authorize removing
      // files an unconfirmed child could still own.
      if (passed) {
        runtime.cleanup();
        rmSync(deployed, { recursive: true, force: true });
      }
    }
  },
  75_000,
);

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const helper = resolve("scripts/install-e2e/macos-native-probes.py");
function python(program) {
  return spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `import importlib.util,json,os,pathlib,subprocess,sys,tempfile\ns=importlib.util.spec_from_file_location('native_probes',${JSON.stringify(helper)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n${program}`,
    ],
    {
      encoding: "utf8",
      timeout: 15000,
    },
  );
}
function parsed(result) {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

describe("content-free native crash diagnostics", () => {
  test("uses exact installed loader and production seams without gateway/model entrypoints", () => {
    const result = parsed(
      python(`
with tempfile.TemporaryDirectory() as directory:
 source=pathlib.Path(directory).resolve();loader=source/'node_modules/tsx/dist/loader.mjs';loader.parent.mkdir(parents=True);loader.write_text('')
 commands=m._commands(source,source,'/fixture/node')
 assert [stage for stage,_ in commands]==list(m.STAGES)
 for _,argv in commands:
  assert argv[:6]==['/fixture/node','--import',loader.as_uri(),'--input-type=module','-e',argv[5]]
  assert 'gateway/src/index.ts' not in ' '.join(argv)
  assert 'getLlama' not in ' '.join(argv)
 assert '768' in commands[4][1][5]
 assert '128MiB' in commands[5][1][5]
 assert 'memoryLimitMiB:128' in commands[6][1][5]
 assert commands[3][1][-2]==str(source/'packages/gateway/src/sqlite-encryption.ts')
 assert commands[3][1][-1]==str(source/'sqlite.db')
 assert "openEncryptedSqlite(process.argv[2]" in commands[3][1][5]
 assert commands[4][1][-2]==str(source/'packages/gateway/src/indexer/usearch-index.ts')
 print(json.dumps({'stages':len(commands),'exactLoader':True}))
`),
    );
    expect(result).toEqual({ stages: 7, exactLoader: true });
  });

  test("runs sequential isolated children while discarding output, secrets and prior config", () => {
    const result = python(`
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory).resolve();source=root/'source';source.mkdir();work=root/'work';work.mkdir()
 os.environ['OMNESIS_TOKEN']='fictional-private-canary'
 os.environ['NODE_OPTIONS']='--require=must-never-load'
 os.environ['OMNESIS_CONFIG_DIR']='/must-not-read-existing-corpus'
 def commands(source,scratch,node):
  program="import os,sys;print('fictional-private-canary');print('fictional-private-canary',file=sys.stderr);assert os.getcwd()==sys.argv[1];assert 'OMNESIS_TOKEN' not in os.environ;assert os.environ['OMNESIS_CONFIG_DIR'].startswith(sys.argv[2]);assert os.environ['HOME'].startswith(sys.argv[2]);assert '--require' not in os.environ['NODE_OPTIONS']"
  return [(stage,[sys.executable,'-c',program,str(source),str(scratch)]) for stage in m.STAGES]
 m._commands=commands
 rows=m.native_startup_probes(source,work,timeout_seconds=2)
 assert list(work.iterdir())==[]
 print(json.dumps(rows))
`);
    const rows = parsed(result);
    expect(rows).toHaveLength(7);
    for (const row of rows)
      expect(row).toEqual({ stage: expect.any(String), exit: 0, signal: null, timeout: false });
    expect(result.stdout + result.stderr).not.toContain("fictional-private-canary");
  });

  test("reports only numeric nonzero exit/signal and never raw child errors", () => {
    const rows = parsed(
      python(`
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory).resolve();retire=m._retirer()
 failure=m._run_probe('sqlite-import',[sys.executable,'-c',"import sys;print('fictional-private-canary',file=sys.stderr);sys.exit(7)"],root,dict(os.environ),2,retire)
 signaled=m._run_probe('duckdb-import',[sys.executable,'-c','import os,signal;os.kill(os.getpid(),signal.SIGTERM)'],root,dict(os.environ),2,retire)
 missing=m._run_probe('usearch-import',['/nonexistent/fictional-private-canary'],root,dict(os.environ),2,retire)
 print(json.dumps([failure,signaled,missing]))
`),
    );
    expect(rows).toEqual([
      { stage: "sqlite-import", exit: 7, signal: null, timeout: false },
      { stage: "duckdb-import", exit: null, signal: 15, timeout: false },
      { stage: "usearch-import", exit: 127, signal: null, timeout: false },
    ]);
  });

  test("timeout retires the exact child and grandchild group through the sibling helper", () => {
    const result = parsed(
      python(`
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory).resolve();pidfile=root/'pids.json'
 # An import-name collision in cwd must never replace the owned retirement helper.
 (root/'macos-variants-command.py').write_text("raise RuntimeError('fictional-import-poison')")
 os.chdir(root)
 retire=m._retirer()
 program="import os,signal,subprocess,sys,time,json,pathlib;signal.signal(signal.SIGTERM,signal.SIG_IGN);child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);pathlib.Path(sys.argv[1]).write_text(json.dumps([os.getpid(),child.pid]));time.sleep(60)"
 row=m._run_probe('sqlite-encrypted',[sys.executable,'-c',program,str(pidfile)],root,dict(os.environ),1,retire)
 pids=json.loads(pidfile.read_text())
 assert not retire.__globals__['group_running'](pids[0])
 print(json.dumps({'row':row,'groupRetired':True}))
`),
    );
    expect(result).toEqual({
      row: { stage: "sqlite-encrypted", exit: null, signal: null, timeout: true },
      groupRetired: true,
    });
  });

  test("cleanup also retires an inherited grandchild after its leader exits normally", () => {
    const result = parsed(
      python(`
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory).resolve();pidfile=root/'pid';retire=m._retirer()
 program="import os,subprocess,sys,pathlib;subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))"
 row=m._run_probe('usearch-empty',[sys.executable,'-c',program,str(pidfile)],root,dict(os.environ),2,retire)
 assert not retire.__globals__['group_running'](int(pidfile.read_text()))
 print(json.dumps(row))
`),
    );
    expect(result).toEqual({ stage: "usearch-empty", exit: 0, signal: null, timeout: false });
  });

  test("cancellation during retirement cannot leave the owned grandchild alive", () => {
    const result = parsed(
      python(`
import signal
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory).resolve();pidfile=root/'pid';retire=m._retirer()
 def interrupted(*_):raise InterruptedError('original cancellation')
 signal.signal(signal.SIGTERM,interrupted)
 def cancelled_retire(child,grace):
  os.kill(os.getpid(),signal.SIGTERM)
  retire(child,grace)
 program="import os,subprocess,sys,pathlib;subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))"
 cancelled=False
 try:m._run_probe('usearch-empty',[sys.executable,'-c',program,str(pidfile)],root,dict(os.environ),2,cancelled_retire)
 except InterruptedError:cancelled=True
 assert not retire.__globals__['group_running'](int(pidfile.read_text()))
 print(json.dumps({'cancelled':cancelled,'groupRetired':True}))
`),
    );
    expect(result).toEqual({ cancelled: true, groupRetired: true });
  });

  test("setup and cleanup failures remain content-free and do not become successful probes", () => {
    const result = python(`
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory).resolve()
 rows=m.native_startup_probes(root,root,timeout_seconds=1)
 assert all(row['exit']==127 for row in rows)
 def broken(*args):raise RuntimeError('fictional-private-canary')
 row=m._run_probe('duckdb-memory',[sys.executable,'-c','pass'],root,dict(os.environ),2,broken)
 assert row['exit']==125
 print(json.dumps({'setupFailures':len(rows),'cleanup':row}))
`);
    expect(parsed(result)).toEqual({
      setupFailures: 7,
      cleanup: { stage: "duckdb-memory", exit: 125, signal: null, timeout: false },
    });
    expect(result.stdout + result.stderr).not.toContain("fictional-private-canary");
  });

  test("rejects unbounded timeouts and unknown stage identifiers", () => {
    const result = parsed(
      python(`
failures=0
for timeout in (0,-1,21,float('inf'),float('nan'),True):
 try:m.native_startup_probes(pathlib.Path('/'),pathlib.Path('/'),timeout)
 except ValueError:failures+=1
try:m._run_probe('fictional-private-canary',[],pathlib.Path('/'),{},1,lambda *_:None)
except ValueError:failures+=1
print(json.dumps({'refused':failures}))
`),
    );
    expect(result).toEqual({ refused: 7 });
  });
});

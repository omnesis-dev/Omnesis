// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const helper = resolve("scripts/install-e2e/macos-vector-compat.py");
function python(program, timeout = 20000) {
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `import importlib.util,json,os,pathlib,signal,subprocess,sys,tempfile,time\ns=importlib.util.spec_from_file_location('compat',${JSON.stringify(helper)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n${program}`,
    ],
    { encoding: "utf8", timeout },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

test("refuses a persistent host before any filesystem mutation", () => {
  expect(
    python(`
with tempfile.TemporaryDirectory() as directory:
 base=pathlib.Path(directory).resolve();target=base/'must-not-exist'
 os.environ.update(GITHUB_ACTIONS='true',RUNNER_ENVIRONMENT='github-hosted',RUNNER_OS='macOS',HOME=directory,ImageOS='macos15')
 try:m.matrix(target)
 except RuntimeError:pass
 else:raise AssertionError('host accepted')
 assert not target.exists()
 print(json.dumps(True))
`),
  ).toBe(true);
});

test("isolates all credentials, config, node preloads and bounded build resources", () => {
  expect(
    python(`
with tempfile.TemporaryDirectory() as directory:
 os.environ.update(OPENAI_API_KEY='SECRET-CANARY',NODE_OPTIONS='--require /secret',NPM_TOKEN='SECRET-CANARY',NODE_PATH='/secret')
 env=m.environment(pathlib.Path(directory),'/fixture/bin')
 assert set(env)=={'PATH','HOME','TMPDIR','OMNESIS_CONFIG_DIR','TZ','CI','NODE_OPTIONS','npm_config_jobs','MAKEFLAGS','npm_config_cache','npm_config_audit','npm_config_fund','npm_config_registry'}
 assert env['NODE_OPTIONS']=='--max-old-space-size=512' and env['MAKEFLAGS']=='-j2'
 assert 'SECRET-CANARY' not in json.dumps(env)
 assert all(pathlib.Path(env[key]).is_dir() for key in ('HOME','TMPDIR','OMNESIS_CONFIG_DIR'))
 print(json.dumps(True))
`),
  ).toBe(true);
});

test("fixed matrix classifies actual binary choice, constructor, finalizer and real vectors", () => {
  expect(
    python(`
assert m.CASES==( ('prebuilt-263','2.26.3',False),('prebuilt-264','2.26.4',False),('prebuilt-265','2.26.5',False),('source-264','2.26.4',True))
commands=dict(m.commands('/fixture/node'))
assert '/prebuilds/' in commands['binary-selection'][-1]
assert '/build/Release/' in dict(m.commands('/fixture/node',True))['binary-selection'][-1]
assert 'hardwareAccelerationAvailable()' in commands['hardware-caps'][-1]
assert 'process.exit(0)' in commands['constructor-exit'][-1]
assert 'process.exit(0)' not in commands['finalizer'][-1]
assert "index.add([1n,2n,3n],vectors,1)" in commands['vectors-roundtrip'][-1]
assert 'restored.load' in commands['vectors-roundtrip'][-1]
assert 'ScalarKind.F64' in commands['f64-constructor'][-1]
assert 'MetricKind.L2sq' in commands['l2-constructor'][-1]
print(json.dumps(True))
`),
  ).toBe(true);
});

test("native failure, signal, timeout and stderr remain numeric and owned groups are retired", () => {
  expect(
    python(`
retire=m.sibling('macos-variants-command').retire
with tempfile.TemporaryDirectory() as directory:
 cwd=pathlib.Path(directory);env={'PATH':os.environ['PATH']}
 rows=[]
 for command,timeout in [("import sys;print('SECRET-CANARY',file=sys.stderr);sys.exit(7)",2),("import os,signal;os.kill(os.getpid(),signal.SIGSEGV)",2),("import time;time.sleep(30)",0.1)]:
  rows.append(m.run('constructor-exit',[sys.executable,'-c',command],cwd,env,timeout,retire))
 assert rows[0]==m.record('constructor-exit',7)
 assert rows[1]==m.record('constructor-exit',-11)
 assert rows[2]['timeout'] and rows[2]['exit'] is None
 assert 'SECRET-CANARY' not in json.dumps(rows)
 print(json.dumps(True))
`),
  ).toBe(true);
});

test("drains grandchildren even when the diagnostic leader exits normally", () => {
  expect(
    python(`
retire=m.sibling('macos-variants-command').retire
with tempfile.TemporaryDirectory() as directory:
 cwd=pathlib.Path(directory);pidfile=cwd/'pid'
 command="import subprocess,sys;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);Path(sys.argv[1]).write_text(str(p.pid))"
 row=m.run('constructor-exit',[sys.executable,'-c',command,str(pidfile)],cwd,{'PATH':os.environ['PATH']},2,retire)
 assert row['exit']==0
 pid=int(pidfile.read_text())
 status=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True).stdout.strip()
 assert not status or status.startswith('Z')
 print(json.dumps(True))
`),
  ).toBe(true);
});

test("refuses unknown stages and oversized timeouts before spawning", () => {
  expect(
    python(`
for stage,timeout in [('unknown',1),('constructor-exit',21),('install',481)]:
 try:m.run(stage,['must-never-execute'],pathlib.Path('/'),{},timeout,None)
 except ValueError:pass
 else:raise AssertionError('unbounded command accepted')
print(json.dumps(True))
`),
  ).toBe(true);
});

test.skipIf(process.platform !== "linux")(
  "exact JavaScript diagnostic API works against the Linux production dependency",
  () => {
    expect(
      python(
        `
retire=m.sibling('macos-variants-command').retire
with tempfile.TemporaryDirectory() as directory:
 cwd=pathlib.Path(directory);(cwd/'node_modules').symlink_to(pathlib.Path('node_modules').resolve(),target_is_directory=True)
 rows=[m.run(stage,argv,cwd,{'PATH':os.environ['PATH'],'NODE_OPTIONS':'--max-old-space-size=512'},20,retire) for stage,argv in m.commands(__import__('shutil').which('node')) if stage!='binary-selection']
 assert all(m.success(row) for row in rows),json.dumps(rows)
 print(json.dumps({'stages':len(rows),'passed':True}))
`,
        30000,
      ),
    ).toEqual({ stages: 7, passed: true });
  },
);

test("rejects unsanitized prior artifacts rather than republishing their content", () => {
  expect(
    python(`
m.validate_result({'diagnosticOnly':True,'cases':[]})
for value in [ {'diagnosticOnly':True,'cases':[],'stderr':'SECRET-CANARY'}, {'diagnosticOnly':True,'cases':[{'case':'arbitrary-secret'}]} ]:
 try:m.validate_result(value)
 except ValueError:pass
 else:raise AssertionError('unsanitized artifact accepted')
print(json.dumps(True))
`),
  ).toBe(true);
});

test("summary accepts only complete ordered collection or exact failed setup prefix", () => {
  expect(
    python(`
import copy
full=[m.record(stage,0) for stage in ['install']+list(m.STAGES[2:])]
base={'case':'prebuilt-264','version':'2.26.4','node':'24.19.0','passed':True,'stages':full}
def check(case):m.validate_result({'diagnosticOnly':True,'cases':[case]})
check(base)
failed=copy.deepcopy(base);failed.update(passed=False,stages=[m.record('install',7)]);check(failed)
source=copy.deepcopy(base);source.update(case='source-264',passed=False,stages=[m.record('install',0),m.record('source-build',7)]);check(source)
native=copy.deepcopy(base);native['stages'][3]=m.record(native['stages'][3]['stage'],-11);native['passed']=False;check(native)
invalid=[]
for rows in [full[:-1],full+[full[-1]],list(reversed(full)),[m.record('install',0)],[m.record('install',7)]+full[1:]]:
 case=copy.deepcopy(base);case['stages']=rows;invalid.append(case)
for value in [0,65,True]:
 case=copy.deepcopy(base);case['stages'][3]['exit']=None;case['stages'][3]['signal']=value;case['passed']=False;invalid.append(case)
case=copy.deepcopy(base);case['stages'][3]['signal']=11;case['passed']=False;invalid.append(case)
for case in invalid:
 try:check(case)
 except ValueError:pass
 else:raise AssertionError('partial or ambiguous evidence accepted')
print(json.dumps({'refused':len(invalid)}))
`),
  ).toEqual({ refused: 9 });
});

test("non-Intel hosted architecture is refused before creating scratch", () => {
  expect(
    python(`
from types import SimpleNamespace
with tempfile.TemporaryDirectory() as directory:
 base=pathlib.Path(directory).resolve();target=base/'must-not-exist'
 original=m.sibling
 m.sibling=lambda name: SimpleNamespace(hosted_guard=lambda:base) if name=='macos-variants-tools' else original(name)
 m.platform=SimpleNamespace(machine=lambda:'arm64')
 try:m.matrix(target)
 except ValueError:pass
 else:raise AssertionError('ARM accepted')
 assert not target.exists()
 print(json.dumps(True))
`),
  ).toBe(true);
});

test("mismatched Node architecture is refused before package installation or scratch", () => {
  expect(
    python(`
from types import SimpleNamespace
with tempfile.TemporaryDirectory() as directory:
 base=pathlib.Path(directory).resolve();target=base/'must-not-exist'
 original=m.sibling
 m.sibling=lambda name:SimpleNamespace(hosted_guard=lambda:base) if name=='macos-variants-tools' else original(name)
 m.platform=SimpleNamespace(machine=lambda:'x86_64')
 m.shutil=SimpleNamespace(which=lambda name:'/fixture/'+name)
 calls=[]
 def output(argv,**kwargs):
  calls.append(argv)
  return '24.19.0\\n' if argv[-1]=='process.versions.node' else 'arm64\\n'
 m.subprocess=SimpleNamespace(check_output=output)
 try:m.matrix(target)
 except ValueError:pass
 else:raise AssertionError('ARM Node accepted')
 assert not target.exists() and [argv[-1] for argv in calls]==['process.versions.node','process.arch']
 print(json.dumps(True))
`),
  ).toBe(true);
});

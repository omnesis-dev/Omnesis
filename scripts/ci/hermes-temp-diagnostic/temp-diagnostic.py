# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
import json,os,runpy,subprocess,sys,tempfile
from pathlib import Path

loaded=runpy.run_path(str(Path(__file__).parent/'test_adapter.py'))
adapter=loaded['adapter_module'];write_fixture=loaded['_write_private_fixture']
node_dir=Path(sys.argv[1]);node=sys.argv[2];common_parent=Path(sys.argv[3])
original_run=subprocess.run
rows=[];observations=[];uncertain=False;roots=[];setup_invalid=False
def observe(*args,**kwargs):
 global uncertain
 result=original_run(*args,**kwargs)
 argv=args[0] if args else kwargs.get('args',[])
 if isinstance(argv,list) and len(argv)>1 and str(argv[1]).endswith('windows-files.mjs'):
  try:
   value=json.loads(result.stderr.splitlines()[-1])
   row={key:value[key] for key in ['code','nativeStage','nativeCode','bootstrapStage','bootstrapNativeCode','cleanupUnconfirmed','refusal'] if key in value}
   observations.append(row)
   if row.get('cleanupUnconfirmed') is True:uncertain=True
  except (ValueError,IndexError,TypeError):pass
 return result
adapter.subprocess.run=observe

def metadata(path,parent=None):
 global uncertain
 result=original_run([node,str(Path(__file__).parent/'path-metadata.mjs'),str(path)]+([str(parent)] if parent is not None else []),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60,check=False)
 if result.returncode:uncertain=True;return {'metadataProcessFailed':True}
 value=json.loads(result.stdout)
 if value.get('cleanupUnconfirmed') is True:uncertain=True
 return value

def stage(origin,name,body):
 global uncertain
 if uncertain:rows.append({'origin':origin,'stage':name,'skippedForUnconfirmedCleanup':True});return
 before=len(observations)
 try:body();row={'origin':origin,'stage':name,'passed':True}
 except Exception as error:
  if isinstance(error,subprocess.TimeoutExpired):uncertain=True
  row={'origin':origin,'stage':name,'passed':False,'errorType':type(error).__name__ if type(error).__name__ in ['PermissionError','FileNotFoundError','RuntimeError','TimeoutExpired','AssertionError'] else 'failed'}
 row['native']=observations[before:];rows.append(row)

def execute(origin,root):
 global setup_invalid
 root=Path(root);roots.append(str(root))
 root_metadata=metadata(root,common_parent)
 rows.append({'origin':origin,'stage':'root-before','metadata':root_metadata})
 if root_metadata.get('sameParentIdentity') is not True:setup_invalid=True;return
 if uncertain:return
 for label in ['state-case','write-case']:
  parent=root/label
  if origin=='python-explicit-0700':parent.mkdir(mode=0o700)
  elif origin.startswith('python'):parent.mkdir()
  # Node comparison parents are created by the original Node preparation.
  row=metadata(parent);rows.append({'origin':origin,'stage':label+'-before','metadata':row})
  if uncertain:return
  if label=='state-case':
   def state():
    value=adapter.DurableState(parent/'integration.sqlite')
    try:assert value.connection.execute('SELECT 17').fetchone()[0]==17
    finally:value.close()
   stage(origin,'actual-durable-state',state)
  else:
   def write():
    path=parent/'integration.json';write_fixture(path,'{"invented":true}')
    assert json.loads(adapter._read_private_text(path))=={'invented':True}
   stage(origin,'actual-private-fixture-write',write)
  if not uncertain:rows.append({'origin':origin,'stage':label+'-after','metadata':metadata(parent)})

try:
 execute('node-created',node_dir)
 for origin in ['python-default','python-explicit-0700']:
  if uncertain or setup_invalid:break
  execute(origin,Path(tempfile.mkdtemp(prefix='hermes-owned-temp-',dir=common_parent)))
except Exception as error:
 uncertain=True;rows.append({'origin':'controller','stage':'failure','errorType':type(error).__name__ if type(error).__name__ in ['PermissionError','FileNotFoundError','RuntimeError','TimeoutExpired','AssertionError'] else 'failed'})
finally:
 # Retain even successful fixtures for this one-shot metadata diagnostic. No
 # cleanup assumption or permission repair is introduced by the controller.
 requested=[r for r in rows if r.get('stage') in ['actual-durable-state','actual-private-fixture-write']]
 print(json.dumps({'phase':'hermes-temp-privacy-diagnostic','diagnosticCollected':not uncertain and not setup_invalid and len(requested)==6,'setupInvalid':setup_invalid,'allRequestedCasesPassed':len(requested)==6 and all(r.get('passed') is True for r in requested),'cleanupUnconfirmed':uncertain,'pythonVersion':[sys.version_info.major,sys.version_info.minor,sys.version_info.micro],'rows':rows}))
 if uncertain or setup_invalid:sys.exit(1)

#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Content-free, diagnostic-only USearch compatibility matrix on hosted Intel Macs."""
import argparse
import importlib.util
import json
import os
import platform
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile

CASES = (('prebuilt-263', '2.26.3', False), ('prebuilt-264', '2.26.4', False),
         ('prebuilt-265', '2.26.5', False), ('source-264', '2.26.4', True))
NODES = ('24.19.0', '24.22.1')
STAGES = ('install', 'source-build', 'binary-selection', 'hardware-caps', 'constructor-exit',
          'size-exit', 'finalizer', 'vectors-roundtrip', 'f64-constructor', 'l2-constructor')


def sibling(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def record(stage, code=None, timed_out=False):
    if stage not in STAGES:
        raise ValueError('unknown diagnostic stage')
    return {'stage': stage, 'exit': code if code is not None and code >= 0 else None,
            'signal': -code if code is not None and code < 0 else None, 'timeout': timed_out}


def run(stage, argv, cwd, env, timeout, retire):
    if stage not in STAGES or not 0 < timeout <= (480 if stage in ('install', 'source-build') else 20):
        raise ValueError('invalid bounded diagnostic command')
    child = None
    result = record(stage, 127)
    try:
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            result = record(stage, child.wait(timeout=timeout))
        except subprocess.TimeoutExpired:
            result = record(stage, timed_out=True)
    finally:
        if child is not None:
            # Reuse cancellation-safe, whole-owned-session draining.
            sibling('macos-native-probes')._retire_probe(child, retire)
    return result


def environment(scratch, path):
    for name in ('home', 'tmp', 'config'):
        (scratch / name).mkdir(mode=0o700)
    return {'PATH': path, 'HOME': str(scratch / 'home'), 'TMPDIR': str(scratch / 'tmp'),
            'OMNESIS_CONFIG_DIR': str(scratch / 'config'), 'TZ': 'UTC', 'CI': 'true',
            'NODE_OPTIONS': '--max-old-space-size=512', 'npm_config_jobs': '2', 'MAKEFLAGS': '-j2',
            'npm_config_cache': str(scratch / 'npm-cache'), 'npm_config_audit': 'false',
            'npm_config_fund': 'false', 'npm_config_registry': 'https://registry.npmjs.org/'}


def commands(node, build=False):
    common = "import {Index,MetricKind,ScalarKind} from 'usearch';const config={dimensions:768,metric:MetricKind.Cos,quantization:ScalarKind.F32,connectivity:16,expansion_add:128,expansion_search:64,multi:false};"
    constructor = 'const index=new Index(config);'
    vectors = '''const vectors=[0,1,2].map(n=>{const v=new Float32Array(768);v[n]=1;return v;});
index.add([1n,2n,3n],vectors,1);
function check(value){const result=value.search(vectors[0],3,1);if(value.size()!==3||result.keys[0]!==1n||Math.abs(result.distances[0])>1e-5)throw Error('vector mismatch');}
check(index);index.save('roundtrip.usearch');const restored=new Index(config);restored.load('roundtrip.usearch');check(restored);'''
    selection = "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const root=process.cwd()+'/node_modules/usearch';const binary=require('node-gyp-build').path(root);"
    expected = '/build/Release/' if build else '/prebuilds/'
    programs = [
        ('binary-selection', selection + 'if(!binary.includes(' + json.dumps(expected) + '))process.exitCode=2;'),
        ('hardware-caps', "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const root=process.cwd()+'/node_modules/usearch';const addon=require('node-gyp-build')(root);if(typeof addon.hardwareAccelerationAvailable()!=='string')process.exitCode=2;"),
        ('constructor-exit', common + constructor + 'process.exit(0);'),
        ('size-exit', common + constructor + 'if(index.size()!==0)process.exit(2);process.exit(0);'),
        ('finalizer', common + constructor + 'if(index.size()!==0)process.exitCode=2;'),
        ('vectors-roundtrip', common + constructor + vectors),
        ('f64-constructor', common + 'config.quantization=ScalarKind.F64;' + constructor + 'if(index.size()!==0)process.exit(2);process.exit(0);'),
        ('l2-constructor', common + 'config.metric=MetricKind.L2sq;' + constructor + 'if(index.size()!==0)process.exit(2);process.exit(0);'),
    ]
    return [(stage, [node, '--input-type=module', '-e', program]) for stage, program in programs]


def success(row):
    return row['exit'] == 0 and row['signal'] is None and not row['timeout']


def validate_result(result):
    if not isinstance(result, dict) or set(result) != {'diagnosticOnly', 'cases'} or result['diagnosticOnly'] is not True or not isinstance(result['cases'], list):
        raise ValueError('invalid diagnostic summary')
    seen = set()
    for case in result['cases']:
        if not isinstance(case, dict) or set(case) != {'case', 'version', 'node', 'passed', 'stages'}:
            raise ValueError('invalid diagnostic case')
        if (case['case'], case['version']) not in [(name, version) for name, version, _ in CASES] or case['node'] not in NODES or not isinstance(case['passed'], bool) or not isinstance(case['stages'], list):
            raise ValueError('invalid diagnostic identity')
        identity = (case['case'], case['node'])
        if identity in seen:
            raise ValueError('duplicate diagnostic identity')
        seen.add(identity)
        for row in case['stages']:
            if not isinstance(row, dict) or set(row) != {'stage', 'exit', 'signal', 'timeout'} or row['stage'] not in STAGES or not isinstance(row['timeout'], bool):
                raise ValueError('invalid numeric diagnostic')
            if row['exit'] is not None and (type(row['exit']) is not int or not 0 <= row['exit'] <= 255):
                raise ValueError('invalid numeric exit status')
            if row['signal'] is not None and (type(row['signal']) is not int or not 1 <= row['signal'] <= 64):
                raise ValueError('invalid numeric signal status')
            if (row['exit'] is not None) + (row['signal'] is not None) + row['timeout'] != 1:
                raise ValueError('ambiguous numeric status')
        prefix = ['install'] + (['source-build'] if case['case'] == 'source-264' else [])
        full = prefix + list(STAGES[2:])
        names = [row.get('stage') for row in case['stages'] if isinstance(row, dict)]
        expected = full
        if case['stages'] and not success(case['stages'][0]):
            expected = ['install']
        elif case['case'] == 'source-264' and len(case['stages']) > 1 and not success(case['stages'][1]):
            expected = prefix
        if names != expected:
            raise ValueError('incomplete or unordered diagnostic stages')
        if case['passed'] != (bool(case['stages']) and all(success(row) for row in case['stages'])):
            raise ValueError('inconsistent diagnostic result')


def matrix(work):
    # This must precede all filesystem mutation and package lifecycle execution.
    temp = sibling('macos-variants-tools').hosted_guard()
    if platform.machine() != 'x86_64':
        raise ValueError('diagnostic requires hosted Intel architecture')
    work = Path(work)
    if not work.is_absolute() or work.resolve() != work or work == temp or not work.is_relative_to(temp):
        raise ValueError('diagnostic work must be a canonical runner-temp descendant')
    node, npm = shutil.which('node'), shutil.which('npm')
    if not node or not npm:
        raise ValueError('required tool is absent')
    actual = subprocess.check_output([node, '-p', 'process.versions.node'], env={'PATH': os.environ.get('PATH', '')},
                                     text=True, timeout=10).strip()
    if actual not in NODES:
        raise ValueError('unsupported diagnostic Node version')
    arch = subprocess.check_output([node, '-p', 'process.arch'], env={'PATH': os.environ.get('PATH', '')},
                                   text=True, timeout=10).strip()
    if arch != 'x64':
        raise ValueError('diagnostic Node architecture differs')
    node_version = actual
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    result_path = work / 'result.json'
    if result_path.is_symlink():
        raise ValueError('diagnostic result is not owned')
    result = json.loads(result_path.read_text()) if result_path.exists() else {'diagnosticOnly': True, 'cases': []}
    validate_result(result)
    if any(row['node'] == node_version for row in result['cases']):
        raise ValueError('diagnostic result cannot be overwritten')
    retire = sibling('macos-variants-command').retire
    for case, version, build in CASES:
        with tempfile.TemporaryDirectory(prefix=case + '-', dir=work) as directory:
            scratch = Path(directory)
            env = environment(scratch, os.environ.get('PATH', ''))
            project = scratch / 'project'
            project.mkdir(mode=0o700)
            (project / 'package.json').write_text(json.dumps({'private': True, 'type': 'module'}))
            rows = [run('install', [npm, 'install', '--ignore-scripts', '--save-exact', 'usearch@' + version], project, env, 480, retire)]
            if success(rows[-1]):
                package = json.loads((project / 'node_modules/usearch/package.json').read_text())
                if package['version'] != version:
                    raise ValueError('installed version mismatch')
                if build:
                    env['npm_config_build_from_source'] = 'true'
                    rows.append(run('source-build', [npm, 'rebuild', 'usearch', '--build-from-source'], project, env, 480, retire))
                if success(rows[-1]):
                    rows.extend(run(stage, argv, project, env, 20, retire) for stage, argv in commands(node, build))
            result['cases'].append({'case': case, 'version': version, 'node': node_version,
                                    'passed': all(success(row) for row in rows), 'stages': rows})
            with tempfile.NamedTemporaryFile(mode='w', dir=work, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(json.dumps(result, indent=2) + '\n')
            temporary.replace(result_path)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', required=True)
    args = parser.parse_args()
    def interrupted(*_):
        raise InterruptedError('diagnostic cancelled')
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        matrix(args.work)
    except BaseException:
        # No exception strings: npm paths/environment/native errors are private.
        print('vector compatibility diagnostic did not complete', file=__import__('sys').stderr)
        raise SystemExit(1)

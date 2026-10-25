#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Content-free, isolated native startup diagnostics after a gateway crash."""
import importlib.util
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile

STAGES = ('sqlite-import', 'duckdb-import', 'usearch-import', 'sqlite-encrypted',
          'usearch-empty', 'duckdb-memory', 'duckdb-encrypted')


def _retirer():
    path = Path(__file__).with_name('macos-variants-command.py')
    spec = importlib.util.spec_from_file_location('owned_native_probe_retirement', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.retire


def _commands(source, scratch, node):
    loader = source / 'node_modules/tsx/dist/loader.mjs'
    if not loader.is_file() or loader.is_symlink() or loader.resolve() != loader:
        raise ValueError('installed loader is not canonical')
    prefix = [node, '--import', loader.as_uri(), '--input-type=module', '-e']
    imports = [(stage, prefix + [f'await import("{package}");']) for stage, package in (
        ('sqlite-import', 'better-sqlite3-multiple-ciphers'),
        ('duckdb-import', '@duckdb/node-api'), ('usearch-import', 'usearch'))]
    # Paths are separate argv data, never interpolated into executable source.
    sqlite = '''
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const {openEncryptedSqlite}=await import(pathToFileURL(process.argv[1]));
const db=openEncryptedSqlite(process.argv[2],{key:Buffer.alloc(32,0x51)});
try {db.exec('CREATE TABLE probe(value INTEGER);INSERT INTO probe VALUES(1)');
if(db.prepare('SELECT value FROM probe').get().value!==1)process.exitCode=2;
} finally {db.close();}
const bytes=readFileSync(process.argv[2]);
if(bytes.length<16||bytes.subarray(0,16).toString()==='SQLite format 3\\0')process.exitCode=2;
'''
    usearch = '''
import {pathToFileURL} from 'node:url';
const {UsearchReadHandle}=await import(pathToFileURL(process.argv[1]));
const handle=UsearchReadHandle.open(process.argv[2],768);
try {if(handle.size()!==0||handle.search(new Float32Array(768),1).length!==0)process.exitCode=2;}
finally {handle.close();}
'''
    duckdb = '''
const {DuckDBInstance}=await import('@duckdb/node-api');
const db=await DuckDBInstance.create(':memory:',{memory_limit:'128MiB',threads:'1'});
try {const connection=await db.connect();try {await connection.run('SELECT 1');}
finally {connection.closeSync();}} finally {db.closeSync();}
'''
    encrypted = '''
import {pathToFileURL} from 'node:url';
const {AnalyticsDb}=await import(pathToFileURL(process.argv[1]));
const db=new AnalyticsDb(process.argv[2],{encryptionKeyHex:'51'.repeat(32),memoryLimitMiB:128,maxPoolSize:1,threads:1});
try {await db.open();const result=await db.executeQuery('SELECT 1 AS value');
if(result.rows[0][0]!==1)process.exitCode=2;}finally {await db.close({timeoutMs:1000});}
'''
    return imports + [
        ('sqlite-encrypted', prefix + [sqlite, str(source / 'packages/gateway/src/sqlite-encryption.ts'), str(scratch / 'sqlite.db')]),
        ('usearch-empty', prefix + [usearch, str(source / 'packages/gateway/src/indexer/usearch-index.ts'), str(scratch / 'missing.usearch')]),
        ('duckdb-memory', prefix + [duckdb]),
        ('duckdb-encrypted', prefix + [encrypted, str(source / 'packages/gateway/src/analytics-db.ts'), str(scratch / 'analytics.db')]),
    ]


def _retire_probe(child, retire):
    # Defer repeated cancellation until this bounded owned group is drained.
    pending = []
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    def interrupted(*_):
        pending.append(True)
    try:
        for sig in previous:
            signal.signal(sig, interrupted)
        retire(child, 0)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    if pending:
        raise InterruptedError('native probe cancelled after owned retirement')


def _run_probe(stage, argv, source, env, timeout_seconds, retire):
    if stage not in STAGES:
        raise ValueError('unknown native probe stage')
    record = {'stage': stage, 'exit': None, 'signal': None, 'timeout': False}
    child = None
    try:
        child = subprocess.Popen(argv, cwd=source, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        try:
            code = child.wait(timeout=timeout_seconds)
            if code < 0:
                record['signal'] = -code
            else:
                record['exit'] = code
        except subprocess.TimeoutExpired:
            record['timeout'] = True
    except InterruptedError:
        raise
    except Exception:
        # Never serialize exception messages, source paths, stderr or environment.
        record['exit'] = 127
    finally:
        if child is not None:
            try:
                _retire_probe(child, retire)
            except InterruptedError:
                raise
            except Exception:
                if record['exit'] in (None, 0) and record['signal'] is None:
                    record['exit'] = 125
    return record


def native_startup_probes(source, work, timeout_seconds=20):
    """Diagnostics only: callers retain the original gateway failure regardless of results."""
    if not isinstance(timeout_seconds, (int, float)) or isinstance(timeout_seconds, bool) or not 0 < timeout_seconds <= 20:
        raise ValueError('native probe timeout must be positive and at most twenty seconds')
    try:
        source, work = Path(source), Path(work)
        if source.resolve(strict=True) != source or work.resolve(strict=True) != work:
            raise ValueError('probe paths must be canonical')
        node = shutil.which('node')
        if not node:
            raise ValueError('installed Node is unavailable')
        retire = _retirer()
        with tempfile.TemporaryDirectory(prefix='native-startup-', dir=work) as directory:
            scratch = Path(directory)
            home, temp, config = scratch / 'home', scratch / 'tmp', scratch / 'config'
            for path in (home, temp, config):
                path.mkdir(mode=0o700)
            # Fresh config/HOME and a small allow-list exclude model credentials,
            # existing corpus paths, Node preload flags and loader search overrides.
            env = {'PATH': os.environ.get('PATH', ''), 'HOME': str(home), 'TMPDIR': str(temp),
                   'OMNESIS_CONFIG_DIR': str(config), 'TZ': 'UTC',
                   'NODE_OPTIONS': '--max-old-space-size=512', 'OMNESIS_MDNS_DISABLE': '1'}
            return [_run_probe(stage, argv, source, env, timeout_seconds, retire)
                    for stage, argv in _commands(source, scratch, node)]
    except InterruptedError:
        raise
    except Exception:
        return [{'stage': stage, 'exit': 127, 'signal': None, 'timeout': False} for stage in STAGES]

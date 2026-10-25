#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Foreground daemon proof using only an isolated CI installation and invented notes."""
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import signal
import ssl
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request


def gateway_boot_budget():
    path = Path(__file__).resolve().parents[1] / 'lib/gateway-boot-budget.json'
    seconds = json.loads(path.read_text()).get('seconds')
    if type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds <= 0:
        raise RuntimeError('shared gateway boot budget is invalid')
    return seconds


def wait_for(probe, seconds=180, phase='readiness', children=()):
    deadline = time.monotonic() + seconds
    last_probe = 'not-ready'
    while True:
        for child in children:
            code = child.poll()
            if code is not None:
                role = getattr(child, 'owned_role', 'daemon')
                role = role if role in ('gateway', 'collector') else 'daemon'
                raise RuntimeError(f'isolated {phase}: {role} exited before readiness, exit={code}')
        try:
            value = probe()
            if value:
                return value
            last_probe = 'not-ready'
        except (OSError, ValueError) as error:
            # Report only classification/status; HTTP errors may contain a URL
            # or body, and neither belongs in public CI diagnostics.
            last_probe = type(error).__name__
            status = getattr(error, 'code', None)
            if isinstance(status, int) and 100 <= status <= 599:
                last_probe += f', status={status}'
        if time.monotonic() >= deadline:
            raise RuntimeError(f'isolated {phase} did not become ready: {last_probe}')
        time.sleep(2)


def gateway_token(config, core, node_arguments=(), cwd=None):
    """Unwrap through the installed product seam, retaining the token only in memory."""
    if os.environ.get('OMNESIS_SECRET_STORE') != 'file':
        raise RuntimeError('isolated runtime requires the file secret backend')
    script = ('import {primeSecretFileKeyCache,readTokenFile} from ' + json.dumps(str(core)) + ';'
              'await primeSecretFileKeyCache({configDir:process.argv[1],backend:"file"});'
              'const token=readTokenFile(process.argv[1]);'
              'if(typeof token!=="string"||!token.trim())throw new Error("no token");'
              'process.stdout.write(token);')
    try:
        result = subprocess.run(['node', *node_arguments, '--input-type=module', '-e', script, str(config)],
                                capture_output=True, text=True, timeout=30, cwd=cwd)
        token = result.stdout.strip()
        if result.returncode or not token or '\n' in token or '\r' in token:
            raise RuntimeError('credential reader refused')
        return token
    except (OSError, subprocess.SubprocessError, RuntimeError):
        # Neither partial stdout nor the decoder's exception may reveal a bearer.
        raise RuntimeError('isolated gateway credential could not be read') from None


def source_gateway_token(config, source):
    # Source package exports still name TypeScript even after `npm run build`.
    # Use the same installed tsx loader as the source CLI front door, not bare
    # Node against dist/index.js and its source-pointing workspace dependencies.
    core = source / 'packages/core/src/index.ts'
    loader = source / 'node_modules/tsx/dist/loader.mjs'
    if not core.is_file() or not loader.is_file():
        raise RuntimeError('installed source credential reader is unavailable')
    return gateway_token(config, core.as_uri(), ['--import', loader.as_uri()], cwd=source)


def no_models(config):
    models = config / 'models'
    if models.exists() and any(path.suffix.lower() in ('.gguf', '.partial') for path in models.iterdir()):
        raise RuntimeError('no-model variant contains a model artifact')
    settings = config / 'omnesis.json'
    if settings.exists():
        body = json.loads(settings.read_text())
        assignments = (body.get('inference') or {}).get('assignments') or {}
        if not isinstance(assignments, dict) or any(assignments.values()):
            raise RuntimeError('no-model variant assigned an inference role')


def group_running(group):
    output = subprocess.check_output(['ps', '-axo', 'pgid=,stat='], text=True, timeout=5)
    return any(int(parts[0]) == group and not parts[1].startswith('Z')
               for line in output.splitlines() if len(parts := line.split()) == 2)


def graceful_stop_marker(child, offset):
    role = getattr(child, 'owned_role', None)
    if offset is None or role not in ('collector', 'gateway'):
        return False
    descriptor = None
    try:
        descriptor = os.open(child.owned_log, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        observed = os.fstat(descriptor)
        if not stat.S_ISREG(observed.st_mode) or (observed.st_dev, observed.st_ino) != child.owned_log_identity:
            return False
        # Read a bounded suffix strictly after this stop's observation point.
        os.lseek(descriptor, max(offset, observed.st_size - 65536), os.SEEK_SET)
        tail = os.read(descriptor, 65536)
        message = rb'\[collector\] Collector stopped' if role == 'collector' else rb'\[gateway\] Shutting down\.\.\.'
        return re.search(rb'(?m)^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO  ' + message + rb'\r?$', tail) is not None
    except (OSError, AttributeError):
        return False
    finally:
        if descriptor is not None:
            os.close(descriptor)


def owned_gateway_lock(child):
    descriptor = None
    try:
        descriptor = os.open(child.owned_lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        observed = os.fstat(descriptor)
        if not stat.S_ISREG(observed.st_mode):
            return False
        holder = json.loads(os.read(descriptor, 4096))
        pid = holder.get('pid')
        return isinstance(pid, int) and pid > 0 and os.getpgid(pid) == child.pid
    except (OSError, ValueError, AttributeError):
        return False
    finally:
        if descriptor is not None:
            os.close(descriptor)


def retire_children(children, grace_seconds=30, force_seconds=15, require_success=False):
    errors = []
    for child in reversed(children):
        role = getattr(child, 'owned_role', 'daemon')
        try:
            forced = False
            sent_term = False
            initiated = child.poll() is None
            stop_offset = None
            lock_observed = initiated and role == 'gateway' and owned_gateway_lock(child)
            if initiated and role in ('collector', 'gateway'):
                try:
                    observed = os.lstat(child.owned_log)
                    if stat.S_ISREG(observed.st_mode) and (observed.st_dev, observed.st_ino) == child.owned_log_identity:
                        stop_offset = observed.st_size
                except (OSError, AttributeError):
                    pass
            if group_running(child.pid):
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    sent_term = initiated
                except ProcessLookupError:
                    pass
                deadline = time.monotonic() + grace_seconds
                while group_running(child.pid):
                    child.poll()
                    if time.monotonic() >= deadline:
                        forced = True
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        break
                    time.sleep(0.05)
                deadline = time.monotonic() + force_seconds
                while group_running(child.pid):
                    child.poll()
                    if time.monotonic() >= deadline:
                        raise RuntimeError('owned group survived forced shutdown')
                    time.sleep(0.05)
            child.wait(timeout=force_seconds)
            # tsx's Darwin front door may retain its TERM-shaped exit even
            # after the daemon completes shutdown. Gateway lock removal occurs
            # only after doShutdown closes every store; its start marker alone
            # cannot establish completion.
            term_completed = (sent_term and not forced and child.returncode in (143, -signal.SIGTERM)
                              and graceful_stop_marker(child, stop_offset)
                              and (role == 'collector' or (lock_observed and not os.path.lexists(child.owned_lock))))
            if require_success and (forced or (child.returncode != 0 and not term_completed)):
                errors.append(f'{role}: exit={child.returncode}, forced={forced}')
        except Exception as error:
            errors.append(f'{role}: {type(error).__name__}')
    if errors:
        raise RuntimeError('owned daemon retirement failed: ' + ', '.join(errors))


def record_native_startup_probes(work, source, exit_code, cycle, probe=None):
    if cycle != 1 or exit_code not in (139, -signal.SIGSEGV):
        return
    try:
        if probe is None:
            path = Path(__file__).with_name('macos-native-probes.py')
            spec = importlib.util.spec_from_file_location('native_startup_probes', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            probe = module.native_startup_probes
        records = probe(source, work)
        (work / 'native-startup-probes.json').write_text(json.dumps(records) + '\n')
    except Exception:
        # Diagnostics must never replace the original gateway startup failure.
        pass


def run(work, cli):
    config = Path(os.environ['OMNESIS_CONFIG_DIR'])
    url = os.environ['OMNESIS_GATEWAY_URL']
    credential = None
    children = []
    handles = []
    def start(role):
        log = (work / (role + '.private.log')).open('ab')
        handles.append(log)
        child = subprocess.Popen([cli, *(['gateway', 'serve'] if role == 'gateway' else ['collector', 'run'])],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                 start_new_session=True, env=dict(os.environ, NODE_OPTIONS='--max-old-space-size=' + ('1024' if role == 'collector' else '1536')))
        child.owned_role = role
        child.owned_log = work / (role + '.private.log')
        child.owned_lock = config / 'gateway.lock'
        observed = os.fstat(log.fileno())
        child.owned_log_identity = (observed.st_dev, observed.st_ino)
        children.append(child)
    def stop():
        retire_children(children, grace_seconds=90, require_success=True)
        children.clear()
    def api(path, auth=True):
        nonlocal credential
        if auth and credential is None:
            credential = source_gateway_token(config, work / 'source')
        context = ssl.create_default_context(cafile=str(config / 'tls/cert.pem'))
        headers = {'Authorization': 'Bearer ' + credential} if auth else {}
        with urllib.request.urlopen(urllib.request.Request(url + path, headers=headers), context=context, timeout=5) as response:
            return json.load(response)
    def online():
        body = api('/admin/devices')
        rows = body if isinstance(body, list) else body.get('items', [])
        collectors = [r for r in rows if r.get('kind') == 'collector' and r.get('online') is True]
        if len(collectors) != 1:
            return None
        return collectors[0]['id']
    def lookup():
        body = api('/documents/search?q=' + urllib.parse.quote('ci-isolation-lantern-proof'))
        rows = [r for r in body.get('results', []) if r.get('title') == 'CI lantern note']
        return rows[0]['id'] if len(rows) == 1 else None
    def command(*args):
        result = subprocess.run([cli, *args], capture_output=True, text=True, timeout=360)
        if result.returncode:
            raise RuntimeError('isolated CLI operation failed: ' + args[0])
        return result.stdout
    identity = None
    document = None
    try:
        for cycle in (1, 2):
            no_models(config)
            start('gateway')
            try:
                wait_for(lambda: api('/health', False).get('status') == 'ok', seconds=gateway_boot_budget(), phase='gateway-health', children=children)
            except RuntimeError:
                if cycle == 1:
                    (work / 'startup-failure.json').write_text(json.dumps({'phase': 'gateway-health', 'cycle': 1, 'before_sources': True}) + '\n')
                    record_native_startup_probes(work, work / 'source', children[-1].poll(), cycle)
                raise
            os.environ['NODE_EXTRA_CA_CERTS'] = str(config / 'tls/cert.pem')
            start('collector')
            device = wait_for(online, phase='collector-online', children=children)
            if cycle == 1:
                vault = work / 'vault'
                (vault / '.obsidian').mkdir(parents=True)
                (vault / 'CI lantern note.md').write_text('# CI lantern note\n\nInvented ci-isolation-lantern-proof.\n')
                out = command('sources', 'add', 'obsidian-notes', str(vault), '--device', device)
                match = re.search(r'^\s*Source:\s*(\S+)', out, re.M)
                if not match:
                    raise RuntimeError('CLI omitted the invented source identity')
                command('sources', 'sync', match[1], '--wait', '--timeout', '300')
                document = wait_for(lookup, phase='document-sync', children=children)
                identity = {'device': device, 'document': document,
                            'hashes': {name: hashlib.sha256((config / name).read_bytes()).hexdigest()
                                       for name in ('token', 'collector-token', 'tls/cert.pem')}}
            else:
                current = {name: hashlib.sha256((config / name).read_bytes()).hexdigest() for name in identity['hashes']}
                if device != identity['device'] or wait_for(lookup, phase='document-restart', children=children) != document or current != identity['hashes']:
                    raise RuntimeError('foreground restart changed device, document, token or certificate identity')
            stop()
            no_models(config)
        (work / 'runtime-result.json').write_text(json.dumps({
            'passed': True, 'cycles': 2, 'same_collector_device': True, 'same_document': True,
            'same_tokens_and_certificate': True, 'retrieval': 'raw document content; no embedding/search-index claim',
            'model_inference': 'excluded', 'model_artifacts_and_assignments_absent': True,
        }, indent=2) + '\n')
    finally:
        # Retire only sessions created above; never discover or signal host daemons.
        try:
            retire_children(children)
        finally:
            for handle in handles:
                handle.close()



if __name__ == '__main__':
    def interrupted(*_):
        raise InterruptedError('runtime scenario interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    if sys.argv[1] == '--check-models':
        no_models(Path(sys.argv[2]))
    else:
        run(Path(sys.argv[1]), sys.argv[2])

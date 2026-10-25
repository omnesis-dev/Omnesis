#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Exact tool quarantine journal for disposable GitHub-hosted Mac runners only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess


def hosted_guard(env=None, system=None):
    env = os.environ if env is None else env
    if (system or platform.system()) != 'Darwin' or any(env.get(k) != v for k, v in {
        'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'macOS',
    }.items()):
        raise RuntimeError('requires a disposable GitHub-hosted macOS runner')
    if env.get('HOME') != '/Users/runner' or not env.get('ImageOS', '').startswith('macos'):
        raise RuntimeError('missing hosted runner home/image identity')
    temp = Path(env.get('RUNNER_TEMP', '/')).resolve()
    workspace = Path(env.get('GITHUB_WORKSPACE', '/')).resolve()
    if not temp.is_relative_to('/Users/runner/work') or not workspace.is_relative_to('/Users/runner/work'):
        raise RuntimeError('runner workspace/temp is outside the disposable runner tree')
    return temp


def remove_owned(path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def object_identity(path):
    """Fingerprint tool bytes and metadata without traversing executable aliases."""
    path = Path(path)
    if not path.exists() and not path.is_symlink():
        return None
    def entry(item):
        stat = item.lstat()
        value = {'device': stat.st_dev, 'inode': stat.st_ino, 'mode': stat.st_mode,
                 'uid': stat.st_uid, 'gid': stat.st_gid}
        if item.is_symlink():
            value['link'] = os.readlink(item)
        elif item.is_file():
            digest = hashlib.sha256()
            with item.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            value['sha256'] = digest.hexdigest()
        return value
    result = entry(path)
    if path.is_dir() and not path.is_symlink():
        inventory = []
        for parent, directories, files in os.walk(path, followlinks=False):
            for name in sorted(directories + files):
                item = Path(parent) / name
                inventory.append((str(item.relative_to(path)), entry(item)))
        inventory.sort(key=lambda row: row[0])
        result['tree_sha256'] = hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()
    return result


class Journal:
    """Write intent before moving anything; restore only exact recorded paths."""
    def __init__(self, directory):
        self.directory = Path(directory)
        self.file = self.directory / 'tools-journal.json'
        self.rows = json.loads(self.file.read_text()) if self.file.exists() else []

    def save(self):
        temporary = self.file.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.rows, indent=2) + '\n')
        temporary.chmod(0o600)
        temporary.replace(self.file)

    def move(self, path, generated=False):
        path = Path(path)
        if any(row['path'] == str(path) for row in self.rows):
            return
        present = path.exists() or path.is_symlink()
        backup = self.directory / ('tool-' + str(len(self.rows)))
        row = {'path': str(path), 'backup': str(backup), 'present': present,
               'generated': generated, 'moved': False, 'restored': False,
               'identity': object_identity(path) if present else None}
        self.rows.append(row)
        self.save()
        if present:
            if path.lstat().st_dev != self.directory.stat().st_dev:
                raise RuntimeError('tool backup must remain on the same filesystem')
            path.rename(backup)
            row['moved'] = True
            self.save()

    def verify_original(self, row):
        path = Path(row['path'])
        current = object_identity(path)
        if row['present'] and current != row['identity']:
            raise RuntimeError('original tool identity was not restored')
        if not row['present'] and row['generated'] and current is not None:
            raise RuntimeError('generated formula remained after restoration')

    def restore(self):
        if not self.file.is_file():
            raise RuntimeError('required tool restoration journal is missing')
        for row in reversed(self.rows):
            if row['restored']:
                self.verify_original(row)
                continue
            path, backup = Path(row['path']), Path(row['backup'])
            if backup.exists() or backup.is_symlink():
                identity = object_identity(backup)
                if identity != row['identity']:
                    raise RuntimeError('tool backup identity changed; preserving backup')
                # Only the captured formula path may be recreated by brew.
                if path.exists() or path.is_symlink():
                    if not row['generated']:
                        raise RuntimeError('unexpected tool replacement; preserving backup')
                    remove_owned(path)
                path.parent.mkdir(parents=True, exist_ok=True)
                backup.rename(path)
            elif not row['present'] and row['generated']:
                remove_owned(path)
            elif row['moved']:
                current = object_identity(path)
                if current != row['identity']:
                    raise RuntimeError('tool backup disappeared; refusing false restoration')
            self.verify_original(row)
            row['restored'] = True
            self.save()


def candidate_paths(env, name):
    paths = {Path(entry) / name for entry in env.get('PATH', '').split(os.pathsep) if entry}
    prefixes = (Path('/opt/homebrew'), Path('/usr/local'))
    paths.update(prefix / 'bin' / name for prefix in prefixes)
    if name == 'node':
        paths.update(prefix / 'opt/node@24/bin/node' for prefix in prefixes)
        cache = Path(env.get('RUNNER_TOOL_CACHE', '/nonexistent'))
        if cache.is_dir():
            paths.update(cache.glob('node/*/*/bin/node'))
    return sorted(path for path in paths if path.exists() or path.is_symlink())


def tool_scope(path, temp):
    if not path.is_absolute() or '..' in path.parts:
        raise RuntimeError('tool path must be a normalized absolute entry')
    # Resolve the parent, not the final executable symlink: quarantine the
    # installer-visible alias without ever moving its runner-engine target.
    for entry in (path, path.parent.resolve() / path.name):
        text = str(entry)
        if '/externals/' in text or not any(text.startswith(prefix) for prefix in (
            '/opt/homebrew/', '/usr/local/', '/Users/runner/hostedtoolcache/', '/Users/runner/work/',
        )) or entry.name not in ('node', 'brew', 'node@24'):
            raise RuntimeError('refusing a tool path outside the installer candidate scope')
        if entry.is_relative_to(temp):
            raise RuntimeError('tool path overlaps quarantine scratch')


def quarantine(directory, mode):
    temp = hosted_guard()
    directory = Path(directory).resolve()
    if not directory.is_relative_to(temp) or directory == temp:
        raise RuntimeError('quarantine must be owned runner-temp scratch')
    directory.mkdir(mode=0o700)
    journal = Journal(directory)
    nodes = candidate_paths(os.environ, 'node')
    brews = candidate_paths(os.environ, 'brew')
    if not nodes or not brews:
        raise RuntimeError('expected original Node and Homebrew installations')
    if mode == 'missing-node':
        brew = str(brews[0])
        cellar = Path(subprocess.check_output([brew, '--cellar'], text=True).strip()) / 'node@24'
        prefix = Path(subprocess.check_output([brew, '--prefix'], text=True).strip())
        for path in (cellar, prefix / 'opt/node@24'):
            tool_scope(path, temp)
            journal.move(path, generated=True)
        nodes = [p for p in nodes if not any(p.is_relative_to(q) for q in (cellar, prefix / 'opt/node@24'))]
    for path in nodes + (brews if mode == 'missing-homebrew' else []):
        tool_scope(path, temp)
        journal.move(path)
    if any(os.access(path, os.X_OK) for path in candidate_paths(os.environ, 'node')):
        raise RuntimeError('a real installer Node candidate remains executable')
    if mode == 'missing-homebrew' and any(os.access(path, os.X_OK) for path in candidate_paths(os.environ, 'brew')):
        raise RuntimeError('a real installer Homebrew candidate remains available')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['guard', 'quarantine', 'restore'])
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--mode', choices=['missing-node', 'missing-homebrew'])
    args = parser.parse_args()
    temp = hosted_guard()
    if args.action == 'guard':
        return
    if args.directory is None or not args.directory.resolve().is_relative_to(temp) or args.directory.resolve() == temp:
        raise RuntimeError('invalid quarantine directory')
    if args.action == 'restore':
        journal = Journal(args.directory)
        for row in journal.rows:
            tool_scope(Path(row['path']), temp)
            backup = Path(row['backup'])
            if backup.parent.resolve() != args.directory.resolve() or not backup.name.startswith('tool-'):
                raise RuntimeError('journal backup escaped owned quarantine')
            if row['generated'] and Path(row['path']).name != 'node@24':
                raise RuntimeError('only the owned replacement formula may be removed')
        journal.restore()
    else:
        if not args.mode:
            raise RuntimeError('missing quarantine mode')
        quarantine(args.directory, args.mode)


if __name__ == '__main__':
    main()

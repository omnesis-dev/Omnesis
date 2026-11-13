#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Obtain fixed public detector inputs and build the official comparison CLI.

The model and upstream source remain outside Git. Run compilation through the
host's admission queue when one is configured. No model or binary is published.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request

FILES = {
    'lid.176.ftz': (
        'https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz',
        '8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83'),
    'fastText-v0.9.2.tar.gz': (
        'https://codeload.github.com/facebookresearch/fastText/tar.gz/refs/tags/v0.9.2',
        '7ea4edcdb64bfc6faaaec193ef181bdc108ee62bb6a04e48b2e80b639a99e27e'),
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    destination = args.output_dir.resolve()
    repository = Path(__file__).resolve().parents[3]
    if destination == repository or repository in destination.parents:
        parser.error('Downloaded dependencies must stay outside the checkout')
    destination.mkdir(parents=True, exist_ok=True)
    for name, (url, expected) in FILES.items():
        target = destination / name
        if not target.exists():
            temporary = target.with_suffix(target.suffix + '.part')
            with urllib.request.urlopen(url, timeout=120) as response, temporary.open('wb') as output:
                while block := response.read(1024 * 1024):
                    output.write(block)
            if sha(temporary) != expected:
                temporary.unlink()
                raise ValueError('Downloaded dependency checksum mismatch: ' + name)
            temporary.replace(target)
        if sha(target) != expected:
            raise ValueError('Cached dependency checksum mismatch: ' + name)
    source = destination / 'fastText-0.9.2'
    if not source.exists():
        with tarfile.open(destination / 'fastText-v0.9.2.tar.gz') as archive:
            archive.extractall(destination, filter='data')
    flags = '-pthread -std=c++11 -include cstdint -O3 -funroll-loops -DNDEBUG'
    subprocess.run(['make', '-j2', 'CXXFLAGS=' + flags], cwd=source, check=True)
    report = {'model': {'name': 'lid.176.ftz', 'sha256': sha(destination / 'lid.176.ftz'),
                        'bytes': (destination / 'lid.176.ftz').stat().st_size,
                        'license': 'CC-BY-SA-3.0'},
              'officialSource': {'version': '0.9.2', 'archiveSHA256': FILES['fastText-v0.9.2.tar.gz'][1],
                                 'license': 'MIT', 'buildFlags': flags},
              'officialBinarySHA256': sha(source / 'fasttext')}
    (destination / 'provenance.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()

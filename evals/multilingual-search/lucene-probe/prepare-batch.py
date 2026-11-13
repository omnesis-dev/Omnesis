#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Compile the batched reference against the existing checksum-pinned JARs."""
import argparse
import hashlib
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, required=True)
    args = parser.parse_args()
    parent = Path(__file__).resolve().parent
    result = subprocess.run([sys.executable, str(parent / 'prepare.py'), '--cache-dir', str(args.cache_dir)],
                            text=True, capture_output=True, check=True)
    classpath = result.stdout.strip().splitlines()[-1]
    classes = args.cache_dir / 'classes'
    source = parent / 'LuceneBatch.java'
    signature = hashlib.sha256(source.read_bytes()).hexdigest()
    stamp = classes / 'batch.sha256'
    if not (classes / 'LuceneBatch.class').exists() or not stamp.exists() or stamp.read_text() != signature:
        subprocess.run(['javac', '--release', '17', '-encoding', 'UTF-8', '-cp', classpath,
                        '-d', str(classes), str(source)], check=True)
        stamp.write_text(signature)
    print(classpath)


if __name__ == '__main__':
    main()

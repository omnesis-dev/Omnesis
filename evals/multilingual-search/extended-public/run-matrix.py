#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Join a bounded language matrix, then aggregate only a fully successful study.

This process owns every evaluator child; workers are synchronous and always
joined. Dataset preparation must finish before invoking this wrapper.
"""
import argparse
import concurrent.futures
import json
import re
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--prune-successful-cache', action='store_true',
                        help='Delete only recognized owned language cache files after that report passes')
    parser.add_argument('--languages', nargs='+')
    parser.add_argument('--sizes', nargs='+', type=int, default=[10000, 100000])
    for option in ('icu4x', 'charabia-full', 'charabia-lean', 'prototype'):
        parser.add_argument('--' + option, type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.workers <= 3:
        raise ValueError('This bounded research runner supports one to three workers')
    policy = json.loads((HERE / 'policy.json').read_text())
    amendment = json.loads((HERE / 'amendment-2026-11-13.json').read_text())
    expected = [language for language in policy['languages'] if language not in amendment['excludedPrimaryLanguages']]
    languages = args.languages or expected
    if len(set(languages)) != len(languages) or not set(languages) <= set(expected):
        raise ValueError('Duplicate or excluded language')
    if set(args.sizes) != set(policy['corpusSizes']):
        raise ValueError('The matrix wrapper requires both frozen corpus sizes')
    args.output_dir = args.output_dir.resolve()
    if args.output_dir.is_relative_to(HERE.parents[2]):
        raise ValueError('Logs and intermediate reports must remain outside Git')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    common = ['--data-dir', str(args.data_dir.resolve()), '--cache-dir', str(args.cache_dir.resolve()),
              '--sizes', *map(str, args.sizes)]
    for option in ('icu4x', 'charabia-full', 'charabia-lean', 'prototype'):
        common.extend(['--' + option, str(getattr(args, option.replace('-', '_')).resolve())])

    def evaluate(language):
        output = args.output_dir / (language + '.json')
        log = args.output_dir / (language + '.log')
        command = [sys.executable, str(HERE / 'evaluate.py'), *common,
                   '--languages', language, '--output', str(output)]
        print(json.dumps({'phase': 'language-start', 'language': language}), flush=True)
        with log.open('w') as stream:
            result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, check=False)
        if result.returncode == 0 and args.prune_successful_cache:
            cache_root = args.cache_dir.resolve()
            owned = cache_root / language
            if owned.is_symlink() or owned.resolve().parent != cache_root:
                raise ValueError('Unsafe language cache cleanup target')
            pattern = re.compile(r'(?:(?:icu|full|lean|prototype|exact)-[a-f0-9]{64}\.(?:jsonl|meta\.json|input\.part|response\.part|part)|index-[a-f0-9]{64}\.(?:sqlite|meta\.json|part\.sqlite))')
            removed = 0
            if owned.is_dir():
                for path in owned.iterdir():
                    if path.is_file() and not path.is_symlink() and pattern.fullmatch(path.name):
                        path.unlink()
                        removed += 1
            print(json.dumps({'phase': 'language-cache-pruned', 'language': language, 'ownedFilesRemoved': removed}), flush=True)
        print(json.dumps({'phase': 'language-finished', 'language': language, 'exitCode': result.returncode}), flush=True)
        return language, result.returncode

    # The context manager waits for every running/queued future, including when
    # a sibling fails. An existing report never substitutes for a successful run.
    outcomes = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as workers:
        futures = [workers.submit(evaluate, language) for language in languages]
        for future in concurrent.futures.as_completed(futures):
            outcomes.append(future.result())
    failures = [(language, status) for language, status in outcomes if status]
    if failures:
        print(json.dumps({'phase': 'matrix-failed', 'failures': failures}), file=sys.stderr)
        raise SystemExit(1)
    if set(languages) != set(expected):
        print(json.dumps({'phase': 'subset-complete', 'languages': languages,
                          'aggregate': 'not produced: complete eligible matrix required'}), flush=True)
        return
    subprocess.run([sys.executable, str(HERE / 'aggregate.py'), '--reports',
                    *(str(args.output_dir / (language + '.json')) for language in expected),
                    '--output', str(args.output_dir / 'summary.json')], check=True)
    print(json.dumps({'phase': 'matrix-complete', 'languages': len(languages)}), flush=True)


if __name__ == '__main__':
    main()

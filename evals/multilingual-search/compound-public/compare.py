#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Exploratory Korean compound metadata ablation over unchanged public pools."""
import argparse
import contextlib
import json
from pathlib import Path
import sqlite3
import sys
import time
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent / 'extended-public'
sys.path.insert(0, str(PUBLIC))
from analysis import analyze, expression, quoted, sha  # noqa: E402
from evaluate import ensure_coverage_extension, fuse, index, query_records, report_method, retrieve, tiers  # noqa: E402
from prepare import AMENDMENT, atomic_json  # noqa: E402
from scoring import paired_interval  # noqa: E402


def analyze_variant(args, label, binary, documents, queries, manifest, base_policy):
    configuration = SimpleNamespace(prototype=binary, cache_dir=args.cache_dir / label,
                                    seed=base_policy['seed'])
    configuration.cache_dir.mkdir(parents=True, exist_ok=True)
    paths, profiles, query_tokens = {}, {}, {}
    for mode, family in [('stem', 'prototype'), ('exact', 'exact')]:
        paths[mode], profiles[mode] = analyze(configuration, 'ko', family, documents,
                                             queries, manifest, manifest['policySHA256'])
        query_tokens[mode] = query_records(paths[mode], len(documents))
    return configuration, paths, profiles, query_tokens


def run_variant(args, label, binary, documents, queries, manifest, prepared):
    configuration, paths, profiles, query_tokens = prepared
    extension = ensure_coverage_extension(configuration.cache_dir)
    results = {'binarySHA256': sha(binary), 'profiles': profiles, 'levels': {}}
    for size in args.sizes:
        started, connections = time.perf_counter(), {}
        try:
            for mode in ('stem', 'exact'):
                path, ids, timing = index(configuration, 'ko', mode, size, documents, paths[mode],
                    {'data': manifest['files'], 'compoundProtocolSHA256': sha(HERE / 'policy.json')})
                db = sqlite3.connect(path)
                db.enable_load_extension(True)
                db.load_extension(str(extension))
                db.enable_load_extension(False)
                connections[mode] = db, ids, timing
            methods, stem_rankings = {}, None
            for method in ('stem-or', 'stem-and', 'stem-msm60'):
                db, ids, timing = connections['stem']
                rankings, query_started = [], time.perf_counter()
                for query, tokens in zip(queries, query_tokens['stem'], strict=True):
                    phrase = quoted(query['text'])
                    operation = 'AND' if method == 'stem-and' else 'OR'
                    coverage = ((3 * len(set(tokens)) + 4) // 5
                                if method == 'stem-msm60' and not phrase else None)
                    rankings.append(retrieve(db, ids, expression(tokens, operation, phrase),
                                             1000 if method == 'stem-or' else 100, coverage))
                if method == 'stem-or':
                    stem_rankings = rankings
                methods[method] = report_method(method, queries, rankings,
                    {**timing, 'querySeconds': time.perf_counter() - query_started})
            db, ids, timing = connections['exact']
            row_order = {docid: rank for rank, docid in enumerate(ids)}
            fused, tiered = [], []
            query_started = time.perf_counter()
            for query, tokens, stems in zip(queries, query_tokens['exact'], stem_rankings, strict=True):
                phrase = quoted(query['text'])
                exact_or = retrieve(db, ids, expression(tokens, phrase=phrase), 1000)
                exact_and = retrieve(db, ids, expression(tokens, 'AND', phrase), 1000)
                exact_phrase = retrieve(db, ids, expression(tokens, phrase=True), 1000)
                fused.append(fuse(stems, exact_or, 60, row_order)[:100])
                tiered.append(tiers(stems, exact_phrase, exact_and, row_order)[:100])
            for method, rankings in [('exact-stem-rrf', fused), ('exact-tier', tiered)]:
                methods[method] = report_method(method, queries, rankings,
                    {'exactIndex': timing, 'jointExactQueriesAndFusionSeconds': time.perf_counter() - query_started})
            results['levels'][str(size)] = {'corpus': manifest['corpusLevels'][str(size)],
                'methods': methods, 'wallSeconds': time.perf_counter() - started}
            print(json.dumps({'variant': label, 'size': size, 'methodsCompleted': list(methods)}), flush=True)
        finally:
            for db, _, _ in connections.values():
                db.close()
    return results, paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--challenger', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sizes', type=int, nargs='+', default=[10000, 100000])
    args = parser.parse_args()
    policy = json.loads((HERE / 'policy.json').read_text())
    base_policy = json.loads((PUBLIC / 'policy.json').read_text())
    if not set(args.sizes) <= set(policy['data']['sizes']):
        parser.error('Corpus size outside the frozen exploratory protocol')
    for name in ('data_dir', 'cache_dir', 'output'):
        value = getattr(args, name).resolve()
        if value.is_relative_to(HERE.parents[2]):
            parser.error('Research inputs, caches and outputs must remain outside Git')
        setattr(args, name, value)
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    directory = args.data_dir / 'ko'
    manifest = json.loads((directory / 'manifest.json').read_text())
    if (manifest['policySHA256'] != policy['data']['basePolicySHA256']
            or manifest['amendmentSHA256'] != policy['data']['amendmentSHA256']
            or sha(PUBLIC / 'policy.json') != manifest['policySHA256']
            or sha(AMENDMENT) != manifest['amendmentSHA256']):
        raise ValueError('Korean pools do not match the frozen base protocol')
    for name, digest in manifest['files'].items():
        if sha(directory / name) != digest:
            raise ValueError('Korean source checksum mismatch')
    documents = [json.loads(line) for line in (directory / 'documents.jsonl').open()]
    queries = [json.loads(line) for line in (directory / 'queries.jsonl').open()]
    started = time.perf_counter()
    report = {'policy': policy, 'policySHA256': sha(HERE / 'policy.json'),
        'sourceHashes': {path.name: sha(path) for path in [Path(__file__), PUBLIC / 'analysis.py',
            PUBLIC / 'evaluate.py', PUBLIC / 'scoring.py', PUBLIC / 'run-matrix.py']},
        'dataManifest': manifest, 'sqliteVersion': sqlite3.sqlite_version,
        'qualifications': ['Post-diagnostic exploratory Korean-only comparison, not a primary17 macro.',
            'Exact means unchanged segmented NFKC/lowercase surfaces, not guaranteed literal orthographic whole words in every context.',
            'OR retrieves1000 for fusion reuse; output metrics use100. Timing is not an isolated production latency comparison.'],
        'variants': {}, 'complete': False}
    binaries = {'original-native': args.baseline.resolve(), 'compound-metadata': args.challenger.resolve()}
    prepared = {label: analyze_variant(args, label, binary, documents, queries, manifest, base_policy)
                for label, binary in binaries.items()}
    if sha(prepared['original-native'][1]['exact']) != sha(prepared['compound-metadata'][1]['exact']):
        raise ValueError('Challenger changed exact-lane document or query tokens')
    original_fp = prepared['original-native'][2]['stem']['engineMetadata']['fingerprint']
    challenger_fp = prepared['compound-metadata'][2]['stem']['engineMetadata']['fingerprint']
    if original_fp == challenger_fp:
        raise ValueError('Challenger must expose a distinct semantic fingerprint')
    report['exactLaneTokenEquality'] = True
    for label, binary in binaries.items():
        report['variants'][label], _ = run_variant(args, label, binary,
            documents, queries, manifest, prepared[label])
    report['comparisons'] = {}
    for size in map(str, args.sizes):
        comparison = {}
        baseline = report['variants']['original-native']['levels'][size]['methods']
        candidate = report['variants']['compound-metadata']['levels'][size]['methods']
        for method in policy['methodsPerVariant']:
            original = {row['id']: row['metrics'] for row in baseline[method]['perQuery']
                        if row['split'] == 'test' and row['subset'] == 'relevant'}
            changed = {row['id']: row['metrics'] for row in candidate[method]['perQuery']
                       if row['split'] == 'test' and row['subset'] == 'relevant'}
            intervals = paired_interval(changed, original, base_policy['seed'] + 'compound' + size + method, 1000)
            comparison[method] = {'pairedTestDifferenceVsOriginal': intervals,
                'originalTest': baseline[method]['splits']['test'],
                'challengerTest': candidate[method]['splits']['test'],
                'perQueryTestMetricDifferences': {qid: {key: changed[qid][key] - original[qid][key] for key in changed[qid]}
                                                for qid in sorted(original)}}
        report['comparisons'][size] = comparison
    report['complete'] = True
    report['wallSeconds'] = time.perf_counter() - started
    args.output.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(args.output, report)


if __name__ == '__main__':
    main()

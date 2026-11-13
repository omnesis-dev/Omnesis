#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Exploratory French/Persian boundary and normalization ablation over fixed pools."""
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


def analyze_variant(args, label, binary, language, documents, queries, manifest, base_policy):
    configuration = SimpleNamespace(prototype=binary, cache_dir=args.cache_dir / language / label,
                                    seed=base_policy['seed'])
    configuration.cache_dir.mkdir(parents=True, exist_ok=True)
    paths, profiles, query_tokens = {}, {}, {}
    for mode, family in [('stem', 'prototype'), ('exact', 'exact')]:
        paths[mode], profiles[mode] = analyze(configuration, language, family, documents,
                                             queries, manifest, manifest['policySHA256'])
        query_tokens[mode] = query_records(paths[mode], len(documents))
    return configuration, paths, profiles, query_tokens


def run_variant(args, label, binary, language, documents, queries, manifest, prepared):
    configuration, paths, profiles, query_tokens = prepared
    extension = ensure_coverage_extension(configuration.cache_dir)
    results = {'binarySHA256': sha(binary), 'profiles': profiles, 'levels': {}}
    for size in args.sizes:
        started, connections = time.perf_counter(), {}
        try:
            for mode in ('stem', 'exact'):
                path, ids, timing = index(configuration, language, mode, size, documents, paths[mode],
                    {'data': manifest['files'], 'profileProtocolSHA256': sha(HERE / 'policy.json')})
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
            print(json.dumps({'language': language, 'variant': label, 'size': size, 'methodsCompleted': list(methods)}), flush=True)
        finally:
            for db, _, _ in connections.values():
                db.close()
    return results, paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--boundary', type=Path, required=True)
    parser.add_argument('--normalization', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--languages', nargs='+', default=['fr', 'fa'])
    parser.add_argument('--sizes', type=int, nargs='+', default=[10000, 100000])
    args = parser.parse_args()
    policy = json.loads((HERE / 'policy.json').read_text())
    base_policy = json.loads((PUBLIC / 'policy.json').read_text())
    if (len(args.sizes) != len(set(args.sizes)) or not set(args.sizes) <= set(policy['data']['sizes'])
            or len(args.languages) != len(set(args.languages))
            or not set(args.languages) <= set(policy['data']['languages'])):
        parser.error('Language or corpus size outside the frozen exploratory protocol')
    for name in ('data_dir', 'cache_dir', 'output'):
        path = getattr(args, name).resolve()
        if path.is_relative_to(HERE.parents[2]):
            parser.error('Research inputs, caches and output must remain outside the checkout')
        setattr(args, name, path)
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    binaries = {'original-native': args.baseline.resolve(), 'boundary-only': args.boundary.resolve(),
                'language-normalization': args.normalization.resolve()}
    report = {'policy': policy, 'policySHA256': sha(HERE / 'policy.json'),
        'sourceHashes': {path.name: sha(path) for path in [Path(__file__), PUBLIC / 'analysis.py',
            PUBLIC / 'evaluate.py', PUBLIC / 'scoring.py']},
        'sqliteVersion': sqlite3.sqlite_version, 'languages': {}, 'complete': False,
        'requestedLanguages': args.languages, 'requestedSizes': args.sizes,
        'completePolicyCoverage': set(args.languages) == set(policy['data']['languages']) and set(args.sizes) == set(policy['data']['sizes']),
        'qualifications': ['Post-aggregate exploratory follow-up selected from French/Persian primary regressions; not independent confirmation or a new primary17 macro.',
            'Known split language is an oracle. Same original 0/1 judgments and bounded judgment-augmented pools.',
            'Normalization engineMetadata is a first-record snapshot; processed_spans there is not a corpus total.',
            'OR retrieves1000 for fusion reuse while output metrics use100; not a production timing comparison.',
            'No semantic negation guarantee follows from shared normalized tokens or OR matches.']}
    started = time.perf_counter()
    for language in args.languages:
        directory = args.data_dir / language
        manifest = json.loads((directory / 'manifest.json').read_text())
        if manifest['language'] != language or set(manifest['files']) != {'documents.jsonl', 'queries.jsonl'}:
            raise ValueError('Profile manifest language or file schema mismatch')
        if (manifest['policySHA256'] != policy['data']['basePolicySHA256']
                or manifest['amendmentSHA256'] != policy['data']['amendmentSHA256']
                or sha(PUBLIC / 'policy.json') != manifest['policySHA256'] or sha(AMENDMENT) != manifest['amendmentSHA256']):
            raise ValueError('Profile pools do not match the frozen primary protocol')
        for name, digest in manifest['files'].items():
            if sha(directory / name) != digest:
                raise ValueError('Profile source checksum mismatch')
        documents = [json.loads(line) for line in (directory / 'documents.jsonl').open()]
        queries = [json.loads(line) for line in (directory / 'queries.jsonl').open()]
        if (len({row['id'] for row in documents}) != len(documents)
                or len({(row['split'], row['subset'], row['id']) for row in queries}) != len(queries)):
            raise ValueError('Duplicate profile document or query IDs')
        prepared = {label: analyze_variant(args, label, binary, language, documents, queries, manifest, base_policy)
                    for label, binary in binaries.items()}
        original_exact = sha(prepared['original-native'][1]['exact'])
        fingerprints = [data[2]['stem']['engineMetadata']['fingerprint'] for data in prepared.values()]
        if len(set(fingerprints)) != len(fingerprints):
            raise ValueError('Every profile requires a distinct stable stem fingerprint')
        if any(sha(data[1]['exact']) != original_exact for data in prepared.values()):
            raise ValueError('A normalization profile changed exact-lane document/query tokens')
        result = {'dataManifest': manifest, 'exactLaneTokenEquality': True, 'variants': {}, 'comparisons': {}}
        for label, binary in binaries.items():
            result['variants'][label], _ = run_variant(args, label, binary, language,
                documents, queries, manifest, prepared[label])
        for size in map(str, args.sizes):
            result['comparisons'][size] = {}
            original = result['variants']['original-native']['levels'][size]['methods']
            for label in ('boundary-only', 'language-normalization'):
                result['comparisons'][size][label] = {}
                candidate = result['variants'][label]['levels'][size]['methods']
                for method in policy['methodsPerVariant']:
                    base_rows = {row['id']: row['metrics'] for row in original[method]['perQuery']
                                 if row['split'] == 'test' and row['subset'] == 'relevant'}
                    new_rows = {row['id']: row['metrics'] for row in candidate[method]['perQuery']
                                if row['split'] == 'test' and row['subset'] == 'relevant'}
                    result['comparisons'][size][label][method] = {
                        'pairedTestDifferenceVsOriginal': paired_interval(new_rows, base_rows,
                            base_policy['seed'] + 'profile' + language + label + size + method, 1000),
                        'originalTest': original[method]['splits']['test'],
                        'challengerTest': candidate[method]['splits']['test'],
                        'perQueryTestMetricDifferences': {qid: {metric: new_rows[qid][metric] - base_rows[qid][metric]
                            for metric in new_rows[qid]} for qid in sorted(base_rows)}}
        report['languages'][language] = result
        report['complete'] = len(report['languages']) == len(args.languages)
        report['wallSeconds'] = time.perf_counter() - started
        args.output.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(args.output, report)
    # Two-language summaries remain scoped to this deliberately selected cohort.
    import statistics
    from aggregate import stratified_interval
    report['macro'] = {}
    for size in map(str, args.sizes):
        report['macro'][size] = {}
        for label in binaries:
            report['macro'][size][label] = {}
            for method in policy['methodsPerVariant']:
                relevant = [data['variants'][label]['levels'][size]['methods'][method]['splits']['test']['relevant']
                            for data in report['languages'].values()]
                summary = {metric: statistics.fmean(row[metric] for row in relevant)
                           for metric in ('nDCG@10', 'Recall@100', 'MRR@10')}
                intervals = {}
                if label != 'original-native':
                    for metric in summary:
                        pairs = {language: [row[metric] for _, row in sorted(data['comparisons'][size][label][method]['perQueryTestMetricDifferences'].items())]
                                 for language, data in report['languages'].items()}
                        intervals[metric] = stratified_interval(pairs, base_policy['seed'] + 'profilemacro' + size + label + method + metric, 1000)
                report['macro'][size][label][method] = {'relevant': summary, 'pairedTestDifferenceVsOriginal': intervals}
    atomic_json(args.output, report)


if __name__ == '__main__':
    main()

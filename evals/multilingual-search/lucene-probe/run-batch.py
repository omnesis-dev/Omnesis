#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Batched mature-search reference over the primary study's identical pools."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent / 'extended-public'
sys.path.insert(0, str(PUBLIC))
from analysis import sha  # noqa: E402
from aggregate import stratified_interval  # noqa: E402
from scoring import METRICS, paired_interval, retrieval_metrics, summarize  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--baseline-dir', type=Path)
    parser.add_argument('--languages', nargs='+')
    parser.add_argument('--sizes', type=int, nargs='+', default=[10000, 100000])
    parser.add_argument('--workers', type=int, default=2)
    parser.add_argument('--export-stopwords', type=Path)
    parser.add_argument('--stopwords-only', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.workers <= 3 or not set(args.sizes) <= {10000, 100000}:
        parser.error('Outside bounded worker/corpus protocol')
    policy = json.loads((PUBLIC / 'policy.json').read_text())
    amendment = json.loads((PUBLIC / 'amendment-2026-11-13.json').read_text())
    expected = [lang for lang in policy['languages'] if lang not in amendment['excludedPrimaryLanguages']]
    languages = args.languages or expected
    if len(languages) != len(set(languages)) or not set(languages) <= set(expected):
        parser.error('Duplicate or excluded language')
    for name in ('data_dir', 'cache_dir', 'output_dir'):
        path = getattr(args, name).resolve()
        if path.is_relative_to(HERE.parents[2]):
            parser.error('Research inputs, indexes and reports must remain outside the checkout')
        path.mkdir(parents=True, exist_ok=True)
        setattr(args, name, path)
    if args.export_stopwords:
        args.export_stopwords = args.export_stopwords.resolve()
        if args.export_stopwords.is_relative_to(HERE.parents[2]):
            parser.error('Exported stopword data must remain outside the checkout')
    compilation = subprocess.run([sys.executable, str(HERE / 'prepare-batch.py'), '--cache-dir', str(args.cache_dir / 'jars')],
                                 text=True, capture_output=True, check=True)
    classpath = compilation.stdout.strip().splitlines()[-1]
    if args.export_stopwords:
        args.export_stopwords.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['java', '-Xmx512m', '-XX:ActiveProcessorCount=2', '-cp', classpath,
                        'LuceneBatch', '--stopwords', str(args.export_stopwords)], check=True)
    if args.stopwords_only:
        if not args.export_stopwords:
            parser.error('--stopwords-only requires --export-stopwords')
        return

    def evaluate(language):
        directory = args.data_dir / language
        manifest = json.loads((directory / 'manifest.json').read_text())
        if manifest['policySHA256'] != sha(PUBLIC / 'policy.json') or manifest['amendmentSHA256'] != sha(PUBLIC / 'amendment-2026-11-13.json'):
            raise ValueError('Reference data does not match frozen primary protocol')
        for name, digest in manifest['files'].items():
            if sha(directory / name) != digest:
                raise ValueError('Prepared reference corpus checksum mismatch')
        queries = [json.loads(line) for line in (directory / 'queries.jsonl').open()]
        by_key = {(q['split'], q['subset'], q['id']): q for q in queries}
        if len(by_key) != len(queries):
            raise ValueError('Duplicate reference query key')
        baseline = json.loads((args.baseline_dir / (language + '.json')).read_text()) if args.baseline_dir else None
        levels = {}
        for size in args.sizes:
            count = manifest['corpusLevels'][str(size)]['actual']
            with tempfile.TemporaryDirectory(prefix='lucene-owned-', dir=args.cache_dir) as scratch:
                scratch = Path(scratch)
                raw = scratch / 'rankings.json'
                subprocess.run(['java', '-Xmx2g', '-XX:ActiveProcessorCount=2', '-cp', classpath,
                                'LuceneBatch', language, str(directory / 'documents.jsonl'), str(directory / 'queries.jsonl'),
                                str(count), str(scratch / 'index'), str(raw)], check=True)
                reference = json.loads(raw.read_text())
            rows = []
            for row in reference.pop('rows'):
                query = by_key[(row['split'], row['subset'], row['id'])]
                ranking = row['ranking']
                if len(ranking) != len(set(ranking)):
                    raise ValueError('Duplicate Lucene candidate')
                top = ranking[0] if ranking else None
                status = 'no-result' if top is None else ('unjudged' if top not in query['judgments'] else
                                                         'relevant' if query['judgments'][top] else 'explicit-negative')
                rows.append({'id': row['id'], 'split': row['split'], 'subset': row['subset'],
                             'metrics': retrieval_metrics(ranking, query['judgments']),
                             'score': row['topScore'] if ranking else None, 'top1Judgment': status,
                             'returned': len(ranking)})
            if len(rows) != len(queries):
                raise ValueError('Missing Lucene query result')
            result = {**reference, **summarize(rows), 'perQuery': rows}
            if baseline:
                source = baseline['languages'][language]
                if source['dataManifest']['files'] != manifest['files']:
                    raise ValueError('Reference and baseline used different text pools')
                base = source['levels'][str(size)]['methods']['current-porter-or']['perQuery']
                base = {q['id']: q['metrics'] for q in base if q['split'] == 'test' and q['subset'] == 'relevant'}
                candidate = {q['id']: q['metrics'] for q in rows if q['split'] == 'test' and q['subset'] == 'relevant'}
                result['pairedVersusCurrent'] = paired_interval(candidate, base, policy['seed'] + language + str(size))
            levels[str(size)] = result
        output = {'language': language, 'referencePolicySHA256': sha(HERE / 'reference-policy.json'),
                  'sourceSHA256': sha(Path(__file__)), 'javaSourceSHA256': sha(HERE / 'LuceneBatch.java'),
                  'primaryPolicySHA256': manifest['policySHA256'], 'amendmentSHA256': manifest['amendmentSHA256'],
                  'dataFiles': manifest['files'], 'levels': levels}
        (args.output_dir / (language + '.json')).write_text(json.dumps(output, indent=2) + '\n')
        return language, output

    with ThreadPoolExecutor(max_workers=args.workers) as workers:
        reports = dict(workers.map(evaluate, languages))
    summary = {'referencePolicy': json.loads((HERE / 'reference-policy.json').read_text()),
               'policySHA256': sha(HERE / 'reference-policy.json'), 'languages': sorted(reports),
               'completePrimaryCoverage': set(reports) == set(expected), 'levels': {}}
    for size in map(str, args.sizes):
        selected = {language: report['levels'][size] for language, report in reports.items()}
        macro = {metric: statistics.fmean(value['splits']['test']['relevant'][metric] for value in selected.values()) for metric in METRICS}
        result = {'macro': macro, 'byLanguage': {language: {**value['splits']['test']['relevant'],
                  'noKnownPositive': value['splits']['test']['noKnownPositive'], 'analyzer': value['analyzer']}
                  for language, value in selected.items()}}
        if args.baseline_dir:
            intervals = {}
            for metric in METRICS:
                pairs = {}
                for language, value in selected.items():
                    base_report = json.loads((args.baseline_dir / (language + '.json')).read_text())
                    base = base_report['languages'][language]['levels'][size]['methods']['current-porter-or']['perQuery']
                    base = {row['id']: row['metrics'][metric] for row in base if row['split'] == 'test' and row['subset'] == 'relevant'}
                    candidate = {row['id']: row['metrics'][metric] for row in value['perQuery'] if row['split'] == 'test' and row['subset'] == 'relevant'}
                    if set(candidate) != set(base):
                        raise ValueError('Unpaired reference held-out IDs')
                    pairs[language] = [candidate[qid] - base[qid] for qid in sorted(base)]
                intervals[metric] = stratified_interval(pairs, policy['seed'] + 'lucene' + size + metric, 1000)
            result['pairedVersusCurrent'] = intervals
        summary['levels'][size] = result
    (args.output_dir / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({'languages': len(reports), 'sizes': args.sizes, 'status': 'passed'}))


if __name__ == '__main__':
    main()

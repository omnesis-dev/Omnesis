#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Merge independent per-language reports and compute paired stratified intervals."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import statistics

from analysis import sha
from prepare import AMENDMENT, atomic_json
from scoring import METRICS
from supplements import PROTOCOL

HERE = Path(__file__).resolve().parent


def stratified_interval(pairs, seed, replicates):
    rng = random.Random(hashlib.sha256(seed.encode()).digest())
    estimates = []
    for _ in range(replicates):
        estimates.append(statistics.fmean(statistics.fmean(rng.choices(values, k=len(values)))
                                          for values in pairs.values()))
    estimates.sort()
    return {'meanDifference': statistics.fmean(statistics.fmean(values) for values in pairs.values()),
            'lower95': estimates[int(0.025 * replicates)],
            'upper95': estimates[min(replicates - 1, int(0.975 * replicates))]}


def aggregate_supplements(languages, policy, requested):
    protocol = json.loads(PROTOCOL.read_text())
    result = {'status': 'Predeclared exploratory supplements, outside the primary nine-method study',
              'protocol': protocol, 'protocolSHA256': sha(PROTOCOL), 'analyses': {}}
    for name, enabled in [('stopwords', requested.get('stopwords')), ('lemmatization', requested.get('simplemma'))]:
        if not enabled:
            continue
        eligible = sorted(languages) if name == 'stopwords' else protocol['lemmatization']['languages']
        sizes = policy['corpusSizes'] if name == 'stopwords' else [10000]
        result['analyses'][name] = {}
        if name == 'lemmatization':
            for language, data in languages.items():
                if data.get('lemmaCoverage', {}).get('supported') != (language in eligible):
                    raise ValueError('Lemma coverage differs from the predeclared language subset')
        for size in map(str, sizes):
            records = {language: languages[language]['levels'][size]['supplements'][name] for language in eligible}
            if name == 'stopwords' and len({record['profile']['stopwordExportSHA256'] for record in records.values()}) != 1:
                raise ValueError('Stopword exports differ between languages')
            baseline_name = 'prototype-stem-or-no-stop' if name == 'stopwords' else 'prototype-stem-or-no-lemma'
            method_names = protocol[name]['methods']
            grouped = {}
            for method in method_names:
                per_language, paired = {}, {metric: {} for metric in METRICS}
                for language, record in records.items():
                    source = record['methods'][method]
                    base = record['methods'][baseline_name]
                    base_ids = {query['id']: query['metrics'] for query in base['perQuery']
                                if query['split'] == 'test' and query['subset'] == 'relevant'}
                    chosen = [query for query in source['perQuery'] if query['split'] == 'test' and query['subset'] == 'relevant']
                    if {query['id'] for query in chosen} != set(base_ids):
                        raise ValueError('Supplemental held-out comparisons are not query-paired')
                    for metric in METRICS:
                        paired[metric][language] = [query['metrics'][metric] - base_ids[query['id']][metric] for query in chosen]
                    per_language[language] = {'relevant': source['splits']['test']['relevant'],
                        'noKnownPositive': source['splits']['test']['noKnownPositive'],
                        'calibration': source['calibration'], 'differenceVsNativeStem': source['pairedTestDifferenceVsNativeStem']}
                grouped[method] = {
                    'macroRelevant': {metric: statistics.fmean(row['relevant'][metric] for row in per_language.values()) for metric in METRICS},
                    'macroNoKnownPositive': {metric: statistics.fmean(row['noKnownPositive'][metric] for row in per_language.values())
                        for metric in ('anyResultRate', 'apparentCalibratedFalseAcceptanceRate')},
                    'pairedDifferenceVsNativeStem': {metric: stratified_interval(values, policy['seed'] + name + metric + method + size,
                        policy['uncertainty']['pairedBootstrapReplicates']) for metric, values in paired.items()},
                    'languages': per_language}
            result['analyses'][name][size] = {'eligibleLanguages': eligible, 'methods': grouped,
                'profiles': {language: record['profile'] for language, record in records.items()},
                'availabilityCounts': {status: sum(record['profile'].get('status', 'supported') == status for record in records.values())
                    for status in sorted({record['profile'].get('status', 'supported') for record in records.values()})}}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reports', type=Path, nargs='+', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--supplemental-only', action='store_true')
    args = parser.parse_args()
    policy = json.loads((HERE / 'policy.json').read_text())
    amendment = json.loads(AMENDMENT.read_text())
    languages, source_hashes, sqlite_versions = {}, None, set()
    inputs, supplemental_requested = [], None
    for path in args.reports:
        report = json.loads(path.read_text())
        if not report['complete'] or report['policySHA256'] != sha(HERE / 'policy.json') or report['amendmentSHA256'] != sha(AMENDMENT):
            raise ValueError('Incomplete or incompatible report')
        if bool(report.get('supplementalOnly')) != args.supplemental_only:
            raise ValueError('Primary and supplemental-only reports cannot be mixed')
        flags = report.get('supplementalRequested', {'stopwords': False, 'simplemma': False})
        if supplemental_requested is not None and flags != supplemental_requested:
            raise ValueError('Reports request different supplemental experiments')
        supplemental_requested = flags
        if any(flags.values()) and report.get('supplementalPolicySHA256') != sha(PROTOCOL):
            raise ValueError('Reports use a different supplemental protocol')
        if source_hashes is not None and source_hashes != report['sourceHashes']:
            raise ValueError('Reports use different driver source revisions')
        source_hashes = report['sourceHashes']
        sqlite_versions.add(report['sqliteVersion'])
        for language, data in report['languages'].items():
            if language in languages:
                raise ValueError('Duplicate language report')
            if set(data['levels']) != set(map(str, policy['corpusSizes'])):
                raise ValueError('Primary aggregate requires both frozen corpus sizes')
            languages[language] = data
        inputs.append({'sha256': sha(path), 'languages': sorted(report['languages'])})
    expected = set(policy['languages']) - set(amendment['excludedPrimaryLanguages'])
    if set(languages) != expected:
        raise ValueError('Primary aggregate requires every non-excluded frozen language')
    binaries = {}
    for data in languages.values():
        for family, profile in data['analyzerProfiles'].items():
            binaries.setdefault(family, set()).add(profile['binarySHA256'])
    if any(len(hashes) != 1 for hashes in binaries.values()) or len(sqlite_versions) != 1:
        raise ValueError('Primary aggregate requires identical analyzer binaries and SQLite versions')
    if args.supplemental_only:
        supplemental = aggregate_supplements(languages, policy, supplemental_requested)
        supplemental.update(primaryPolicySHA256=sha(HERE / 'policy.json'), amendmentSHA256=sha(AMENDMENT),
                            sourceHashes=source_hashes, inputs=inputs,
                            confidenceInterpretation='Paired query bootstrap stratified by the fixed supported language subset; 95% intervals are unadjusted and conditional on the sampled corpora.')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(args.output, supplemental)
        return
    summary = {'policySHA256': sha(HERE / 'policy.json'), 'amendmentSHA256': sha(AMENDMENT),
               'sourceHashes': source_hashes, 'aggregateSourceSHA256': sha(Path(__file__)),
               'inputs': inputs, 'sqliteVersions': sorted(sqlite_versions),
               'analyzerBinarySHA256': {family: next(iter(hashes)) for family, hashes in binaries.items()},
               'primaryLanguages': sorted(languages), 'excludedPrimaryLanguages': amendment['excludedPrimaryLanguages'],
               'confidenceInterpretation': 'Paired query bootstrap, stratified by the fixed languages, conditional on these sampled judgment-augmented corpora; 95% intervals are unadjusted for multiple comparisons.',
               'levels': {}}
    for size in map(str, policy['corpusSizes']):
        methods = {}
        for method in policy['methods']:
            language_results, per_metric_pairs = {}, {metric: {} for metric in METRICS}
            for language in sorted(languages):
                data = languages[language]['levels'][size]
                row = data['methods'][method]
                base = data['methods']['current-porter-or']
                relevant = row['splits']['test']['relevant']
                negative = row['splits']['test']['noKnownPositive']
                baseline_by_id = {q['id']: q['metrics'] for q in base['perQuery']
                                  if q['split'] == 'test' and q['subset'] == 'relevant'}
                selected = [q for q in row['perQuery'] if q['split'] == 'test' and q['subset'] == 'relevant']
                if {q['id'] for q in selected} != set(baseline_by_id):
                    raise ValueError('Unpaired held-out query IDs')
                for metric in METRICS:
                    per_metric_pairs[metric][language] = [q['metrics'][metric] - baseline_by_id[q['id']][metric] for q in selected]
                language_results[language] = {'relevant': relevant, 'noKnownPositive': negative,
                    'calibration': row['calibration'], 'differenceVsBaseline': row['pairedTestDifferenceVsBaseline'],
                    'corpus': data['corpus'],
                    'testQueryIds': [q['id'] for q in row['perQuery'] if q['split'] == 'test']}
            methods[method] = {
                'macroRelevant': {metric: statistics.fmean(row['relevant'][metric] for row in language_results.values()) for metric in METRICS},
                'macroNoKnownPositive': {metric: statistics.fmean(row['noKnownPositive'][metric] for row in language_results.values())
                    for metric in ('anyResultRate', 'apparentCalibratedFalseAcceptanceRate')},
                'pairedDifferenceVsBaseline': {metric: stratified_interval(pairs, policy['seed'] + metric + method + size,
                    policy['uncertainty']['pairedBootstrapReplicates']) for metric, pairs in per_metric_pairs.items()},
                'languages': language_results}
        summary['levels'][size] = {'methods': methods,
            'testRelevantQueries': sum(languages[lang]['dataManifest']['queries']['test/relevant'] for lang in languages),
            'testNoKnownPositiveQueries': sum(languages[lang]['dataManifest']['queries']['test/non_relevant'] for lang in languages)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(args.output, summary)
    if any(supplemental_requested.values()):
        supplemental = aggregate_supplements(languages, policy, supplemental_requested)
        supplemental['primaryPolicySHA256'] = summary['policySHA256']
        supplemental['confidenceInterpretation'] = summary['confidenceInterpretation']
        atomic_json(args.output.with_name(args.output.stem + '-supplemental' + args.output.suffix), supplemental)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Re-score original primary reports on the metadata-defined unseen TEST cohort.

No index, corpus, query or threshold is changed. All exclusions come from the
frozen exposure audit, independently of every retrieval outcome.
"""
import argparse
import collections
import json
from pathlib import Path
import statistics
import sys

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent / 'extended-public'
sys.path.insert(0, str(PUBLIC))
from analysis import sha  # noqa: E402
from aggregate import stratified_interval  # noqa: E402
from prepare import AMENDMENT, atomic_json  # noqa: E402
from scoring import METRICS, average, paired_interval, quantiles  # noqa: E402


def query_key(row):
    return row['split'], row['subset'], row['id']


def accepts(row, calibration):
    return not calibration['rejectAll'] and row['score'] is not None and row['score'] >= calibration['threshold']


def test_summary(rows, calibration):
    positive = [row for row in rows if row['subset'] == 'relevant']
    negative = [row for row in rows if row['subset'] == 'non_relevant']
    return {'relevant': {'queries': len(positive), **average([row['metrics'] for row in positive]),
                         'calibratedAcceptanceRate': statistics.fmean(accepts(row, calibration) for row in positive) if positive else None},
            'noKnownPositive': {'queries': len(negative),
                'anyResultRate': statistics.fmean(row['score'] is not None for row in negative) if negative else None,
                'apparentCalibratedFalseAcceptanceRate': statistics.fmean(accepts(row, calibration) for row in negative) if negative else None,
                'top1JudgmentCounts': dict(collections.Counter(row['top1Judgment'] for row in negative)),
                'acceptedTop1JudgmentCounts': dict(collections.Counter(row['top1Judgment'] for row in negative if accepts(row, calibration))),
                'topScoreDistribution': quantiles([row['score'] for row in negative if row['score'] is not None])}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit', type=Path, required=True)
    parser.add_argument('--reports-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    for name in ('audit', 'reports_dir', 'output'):
        path = getattr(args, name).resolve()
        if path.is_relative_to(HERE.parents[2]):
            parser.error('Audit/report inputs and generated sensitivity output must stay outside the checkout')
        setattr(args, name, path)
    audit = json.loads(args.audit.read_text())
    if audit['protocolSHA256'] != sha(HERE / 'policy.json'):
        raise ValueError('Exposure audit uses a different frozen rule')
    base = json.loads((PUBLIC / 'policy.json').read_text())
    amendment = json.loads(AMENDMENT.read_text())
    expected_languages = set(base['languages']) - set(amendment['excludedPrimaryLanguages'])
    if (audit['basePolicySHA256'] != sha(PUBLIC / 'policy.json') or audit['amendmentSHA256'] != sha(AMENDMENT)
            or set(audit['languages']) != expected_languages):
        raise ValueError('Audit must cover every eligible language and the exact frozen primary policy')
    raw, source_hashes, input_files = {}, None, []
    for language, cohort in audit['languages'].items():
        path = args.reports_dir / (language + '.json')
        report = json.loads(path.read_text())
        if (not report.get('complete') or report['policySHA256'] != audit['basePolicySHA256']
                or report['amendmentSHA256'] != audit['amendmentSHA256'] or report.get('supplementalOnly')):
            raise ValueError('Incomplete or incompatible original primary report')
        if source_hashes is not None and report['sourceHashes'] != source_hashes:
            raise ValueError('Original reports use different driver revisions')
        source_hashes = report['sourceHashes']
        data = report['languages'][language]
        if data['dataManifest']['language'] != language or set(data['dataManifest']['files']) != {'documents.jsonl', 'queries.jsonl'}:
            raise ValueError('Original report language or pool schema mismatch')
        if data['dataManifest']['files'] != cohort['newPoolFiles'] or data['dataManifest']['corpusLevels'] != cohort['corpusLevels']:
            raise ValueError('Original reports differ from the audited frozen text pools')
        raw[language] = data
        input_files.append({'language': language, 'sha256': sha(path)})
    result = {'status': 'Separate metadata-only unseen-TEST sensitivity; original experiment retained unchanged',
              'exposureProtocolSHA256': sha(HERE / 'policy.json'), 'auditSHA256': sha(args.audit),
              'sensitivitySourceSHA256': sha(Path(__file__)), 'primaryPolicySHA256': audit['basePolicySHA256'],
              'inputFiles': input_files, 'originalDriverSourceHashes': source_hashes,
              'calibration': 'Retain each original full-DEV fitted threshold; DEV exposure is development, not an unseen-DEV claim. No threshold refit or selection on TEST.',
              'qualifications': ['The original full4250 and separate unseen4244 results must be shown together.',
                  'Exposure is determined by same-language IDs or global normalized query text, never outcomes.',
                  'This excludes detectable text/identity overlap, not unknown semantic paraphrases.',
                  'Paired1000-query bootstrap intervals are conditional on this fixed sampled corpus/cohort and unadjusted for multiple comparisons.',
                  'No-known-positive background may contain unjudged relevant passages; apparent false acceptance is not universal irrelevance.'],
              'exposureTotals': audit['totals'], 'testExposureMappings': audit['testExposureMappings'], 'levels': {}}
    for size in map(str, base['corpusSizes']):
        methods = {}
        for method in base['methods']:
            selected_by_language, base_by_language, language_results = {}, {}, {}
            original_means = []
            for language, data in raw.items():
                audit_language = audit['languages'][language]
                expected_keys = {(group.split('/')[0], group.split('/')[1], qid)
                                 for group, ids in audit_language['unseenQueryIds'].items() for qid in ids}
                expected_keys.update((row['split'], row['subset'], row['id']) for row in audit_language['exposedQueries'])
                source = data['levels'][size]['methods'][method]
                if len(source['perQuery']) != len(expected_keys) or {query_key(row) for row in source['perQuery']} != expected_keys:
                    raise ValueError('Original method report is missing or duplicates audited queries')
                unseen_keys = {(split, subset, qid) for group, ids in audit_language['unseenQueryIds'].items()
                               for split, subset in [group.split('/')] for qid in ids if split == 'test'}
                selected = [row for row in source['perQuery'] if query_key(row) in unseen_keys]
                baseline = data['levels'][size]['methods']['current-porter-or']
                selected_base = [row for row in baseline['perQuery'] if query_key(row) in unseen_keys]
                positive = {row['id']: row['metrics'] for row in selected if row['subset'] == 'relevant'}
                positive_base = {row['id']: row['metrics'] for row in selected_base if row['subset'] == 'relevant'}
                if not positive:
                    language_results[language] = {'unseenPositiveQueries': 0, 'ranking': 'not estimated; excluded from matched-language macro'}
                    continue
                selected_by_language[language], base_by_language[language] = positive, positive_base
                summary = test_summary(selected, source['calibration'])
                original_means.append(source['splits']['test']['relevant'])
                unchanged = len(positive) == source['splits']['test']['relevant']['queries']
                intervals = (source['pairedTestDifferenceVsBaseline'] if unchanged else paired_interval(
                    positive, positive_base, base['seed'] + 'exposure' + language + size + method, 1000))
                language_results[language] = {'test': summary, 'originalFullTest': source['splits']['test'],
                    'calibration': source['calibration'], 'pairedDifferenceVsCurrent': intervals,
                    'unchangedCohortOriginalCIReused': unchanged,
                    'unseenPositiveQueryIds': sorted(positive),
                    'unseenNoKnownPositiveQueryIds': sorted(row['id'] for row in selected if row['subset'] == 'non_relevant')}
            macro = {metric: statistics.fmean(statistics.fmean(row[metric] for row in queries.values())
                     for queries in selected_by_language.values()) for metric in METRICS}
            paired_macro = {}
            for metric in METRICS:
                pairs = {language: [rows[qid][metric] - base_by_language[language][qid][metric] for qid in sorted(rows)]
                         for language, rows in selected_by_language.items()}
                paired_macro[metric] = ({'meanDifference': 0.0, 'lower95': 0.0, 'upper95': 0.0} if method == 'current-porter-or'
                    else stratified_interval(pairs, base['seed'] + 'exposure' + size + method + metric, 1000))
            original_macro = {metric: statistics.fmean(row[metric] for row in original_means) for metric in METRICS}
            methods[method] = {'unseenTestMacro': macro, 'originalFullTestMacroSameLanguages': original_macro,
                'unseenMinusOriginalFullMacro': {metric: macro[metric] - original_macro[metric] for metric in METRICS},
                'pairedDifferenceVsCurrent': paired_macro, 'eligibleLanguages': sorted(selected_by_language),
                'unseenPositiveQueries': sum(map(len, selected_by_language.values())),
                'unseenNoKnownPositiveQueries': sum(row['test']['noKnownPositive']['queries'] for row in language_results.values() if 'test' in row),
                'unseenNoKnownPositiveMacro': {key: statistics.fmean(row['test']['noKnownPositive'][key] for row in language_results.values()
                    if 'test' in row and row['test']['noKnownPositive'][key] is not None)
                    for key in ('anyResultRate', 'apparentCalibratedFalseAcceptanceRate')},
                'unseenRelevantAcceptanceMacro': statistics.fmean(row['test']['relevant']['calibratedAcceptanceRate'] for row in language_results.values() if 'test' in row),
                'languages': language_results}
        result['levels'][size] = {'methods': methods}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(args.output, result)


if __name__ == '__main__':
    main()

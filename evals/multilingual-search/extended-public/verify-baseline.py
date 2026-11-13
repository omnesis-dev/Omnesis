#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Check supplemental native baselines against an independent primary run.

Only report metadata and public query identifiers are read. Binary files may have
been rebuilt; semantic native fingerprints, frozen data, SQLite, and observed
per-query baseline results must agree. Reports are never rewritten.
"""
import argparse
import json
import math
from pathlib import Path

from analysis import sha
from prepare import AMENDMENT, atomic_json


def verify(primary, supplementary):
    for key in ('policySHA256', 'amendmentSHA256', 'sqliteVersion'):
        if primary[key] != supplementary[key]:
            raise ValueError('Primary/supplemental mismatch: ' + key)
    policy = json.loads((Path(__file__).resolve().parent / 'policy.json').read_text())
    amendment = json.loads(AMENDMENT.read_text())
    expected = set(policy['languages']) - set(amendment['excludedPrimaryLanguages'])
    if set(primary['languages']) != expected or set(supplementary['languages']) != expected:
        raise ValueError('Complete eligible primary/supplemental language sets required')
    result = {}
    for language, data in supplementary['languages'].items():
        original = primary['languages'][language]
        for key in ('files', 'corpusLevels'):
            if data['dataManifest'][key] != original['dataManifest'][key]:
                raise ValueError('Primary/supplemental data pool mismatch: ' + language)
        fingerprint = data['analyzerProfiles']['prototype']['engineMetadata']['fingerprint']
        if fingerprint != original['analyzerProfiles']['prototype']['engineMetadata']['fingerprint']:
            raise ValueError('Primary/supplemental native fingerprint mismatch: ' + language)
        checked = {}
        for size, level in data['levels'].items():
            rows = level['methods']['prototype-stem-or']['perQuery']
            baseline = original['levels'][size]['methods']['prototype-stem-or']['perQuery']
            indexed = {(row['split'], row['subset'], row['id']): row for row in baseline}
            row_keys = {(row['split'], row['subset'], row['id']) for row in rows}
            if len(indexed) != len(rows) or len(rows) != len(baseline) or row_keys != set(indexed):
                raise ValueError('Primary/supplemental baseline query sets differ')
            for row in rows:
                before = indexed[(row['split'], row['subset'], row['id'])]
                for key in ('metrics', 'top1Judgment', 'returned', 'positiveJudgments', 'explicitNegativeJudgments'):
                    if row[key] != before[key]:
                        raise ValueError('Primary/supplemental baseline output differs: ' + language + '/' + row['id'])
                if (row['score'] is None) != (before['score'] is None) or (row['score'] is not None
                        and not math.isclose(row['score'], before['score'], rel_tol=1e-12, abs_tol=1e-15)):
                    raise ValueError('Primary/supplemental baseline score differs')
            checked[size] = {'matchedQueries': len(rows), 'allMetricsAndTop1StatusesMatch': True,
                             'scoresAgreeWithinTolerance': True}
        result[language] = {'nativeFingerprint': fingerprint, 'poolHashesMatch': True, 'levels': checked}
    return result


def read_reports(directory):
    combined = None
    for path in sorted(directory.glob('*.json')):
        report = json.loads(path.read_text())
        required = ('policySHA256', 'amendmentSHA256', 'sqliteVersion', 'sourceHashes', 'requestedLanguages')
        if (not all(key in report for key in required) or 'languages' not in report
                or not isinstance(report['languages'], dict) or not report.get('complete')):
            continue
        if combined is None:
            combined = {**report, 'languages': {}}
        for key in ('policySHA256', 'amendmentSHA256', 'sqliteVersion'):
            if report[key] != combined[key]:
                raise ValueError('Inconsistent report directory metadata')
        if set(combined['languages']) & set(report['languages']):
            raise ValueError('Duplicate language in report directory')
        combined['languages'].update(report['languages'])
    if combined is None:
        raise ValueError('No complete per-language reports')
    return combined


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--primary-dir', type=Path, required=True)
    parser.add_argument('--supplemental-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    checks = verify(read_reports(args.primary_dir), read_reports(args.supplemental_dir))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(args.output, {'complete': True, 'verificationSourceSHA256': sha(Path(__file__)),
                             'languages': checks})


if __name__ == '__main__':
    main()

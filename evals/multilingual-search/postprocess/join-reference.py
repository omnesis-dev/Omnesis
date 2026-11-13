#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Pair existing reference reports with frozen primary outputs without reindexing."""
import argparse
import json
from pathlib import Path
import statistics
import sys

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent / 'extended-public'
sys.path.insert(0, str(PUBLIC))
from aggregate import stratified_interval  # noqa: E402
from analysis import sha  # noqa: E402
from scoring import METRICS  # noqa: E402


def keyed(rows):
    result = {(r['split'], r['subset'], r['id']): r for r in rows}
    if len(result) != len(rows):
        raise ValueError('Duplicate report query key')
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--primary-dir', type=Path, required=True)
    p.add_argument('--reference-dir', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    for name in ('primary_dir', 'reference_dir', 'output'):
        value = getattr(args, name).resolve()
        if value.is_relative_to(HERE.parents[2]):
            p.error('Report inputs and outputs must stay outside the checkout')
        setattr(args, name, value)
    policy = json.loads((PUBLIC / 'policy.json').read_text())
    amendment = json.loads((PUBLIC / 'amendment-2026-11-13.json').read_text())
    langs = sorted(set(policy['languages']) - set(amendment['excludedPrimaryLanguages']))
    reference_root = HERE.parent / 'lucene-probe'
    expected_sources = {
        'referencePolicySHA256': sha(reference_root / 'reference-policy.json'),
        'sourceSHA256': sha(reference_root / 'run-batch.py'),
        'javaSourceSHA256': sha(reference_root / 'LuceneBatch.java'),
        'prepareSourceSHA256': sha(reference_root / 'prepare.py'),
        'prepareBatchSourceSHA256': sha(reference_root / 'prepare-batch.py'),
        'scoringSourceSHA256': sha(PUBLIC / 'scoring.py'),
    }
    expected_levels = set(map(str, policy['corpusSizes']))
    loaded, inputs = {}, []
    for lang in langs:
        native_path, reference_path = args.primary_dir / (lang + '.json'), args.reference_dir / (lang + '.json')
        native, reference = json.loads(native_path.read_text()), json.loads(reference_path.read_text())
        if (not native.get('complete') or native.get('supplementalOnly')
                or native['policySHA256'] != sha(PUBLIC / 'policy.json')
                or native['amendmentSHA256'] != sha(PUBLIC / 'amendment-2026-11-13.json')
                or reference['primaryPolicySHA256'] != native['policySHA256']
                or reference['amendmentSHA256'] != native['amendmentSHA256']):
            raise ValueError('Incomplete or incompatible original/reference reports')
        if (reference.get('language') != lang or set(native['languages']) != {lang}
                or native.get('sourceHashes', {}).get('scoring.py') != expected_sources['scoringSourceSHA256']):
            raise ValueError('Wrong language or incompatible primary scoring source')
        if any(reference.get(key) != digest for key, digest in expected_sources.items()):
            raise ValueError('Reference policy or source provenance differs from checked-out reference')
        data = native['languages'][lang]
        if set(data['levels']) != expected_levels:
            raise ValueError('Primary lacks a frozen corpus level')
        if reference['dataFiles'] != data['dataManifest']['files']:
            raise ValueError('Reference and primary used different text pools or queries')
        if set(reference['levels']) != expected_levels:
            raise ValueError('Reference lacks a frozen corpus level')
        loaded[lang] = data, reference
        inputs.append({'language': lang, 'primarySHA256': sha(native_path), 'referenceSHA256': sha(reference_path)})
    output = {'scope': 'Postprocessing matched existing Lucene reports; no reindexing or test-dependent policy selection.',
        'qualification': 'Lucene is a whole-pipeline reference: field statistics, norms, stopwords, graphs, title boosts and repeated terms differ.',
        'sourceSHA256': sha(Path(__file__)), 'primaryPolicySHA256': sha(PUBLIC / 'policy.json'),
        'amendmentSHA256': sha(PUBLIC / 'amendment-2026-11-13.json'),
        'verifiedReferenceSources': expected_sources,
        'postprocessingSourceHashes': {path.name: sha(path) for path in
            (Path(__file__), PUBLIC / 'aggregate.py', PUBLIC / 'analysis.py', PUBLIC / 'scoring.py')},
        'languages': langs, 'inputs': inputs, 'levels': {}, 'complete': False}
    for size in map(str, policy['corpusSizes']):
        metrics, pairs = {}, {method: {metric: {} for metric in METRICS}
                             for method in ('current-porter-or', 'prototype-stem-or')}
        for lang, (native, ref) in loaded.items():
            reference = ref['levels'][size]
            if reference.get('language') != lang or reference['count'] != native['levels'][size]['corpus']['actual']:
                raise ValueError('Reference document count mismatch')
            rows = keyed(reference['perQuery'])
            for method in pairs:
                base = keyed(native['levels'][size]['methods'][method]['perQuery'])
                if set(base) != set(rows):
                    raise ValueError('Reference and primary query cohorts differ')
                keys = sorted(key for key in rows if key[:2] == ('test', 'relevant'))
                for metric in METRICS:
                    pairs[method][metric][lang] = [rows[k]['metrics'][metric] - base[k]['metrics'][metric] for k in keys]
            metrics[lang] = reference['splits']['test']
        output['levels'][size] = {'referenceMacro': {metric: statistics.fmean(v['relevant'][metric] for v in metrics.values()) for metric in METRICS},
            'macroPositiveAcceptance': statistics.fmean(v['relevant']['calibratedAcceptanceRate'] for v in metrics.values()),
            'macroNoKnownPositiveAcceptance': statistics.fmean(v['noKnownPositive']['apparentCalibratedFalseAcceptanceRate'] for v in metrics.values()),
            'pairedReferenceMinusPrimary': {method: {metric: stratified_interval(v, policy['seed'] + 'reference-join' + size + method + metric, 1000)
                                                  for metric, v in per_metric.items()} for method, per_metric in pairs.items()}}
    output['complete'] = True
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + '\n')


if __name__ == '__main__':
    main()

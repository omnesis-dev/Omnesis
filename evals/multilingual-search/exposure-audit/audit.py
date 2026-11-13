#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Audit previously exposed query identities without writing query text to reports."""
import argparse
import collections
import hashlib
import json
import platform
from pathlib import Path
import sys
import unicodedata

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent / 'extended-public'
sys.path.insert(0, str(PUBLIC))
from analysis import sha  # noqa: E402
from prepare import AMENDMENT, atomic_json  # noqa: E402


def normalized(text):
    return ' '.join(unicodedata.normalize('NFKC', text).casefold().split())


def punctuation_insensitive(text):
    value = unicodedata.normalize('NFKC', text).casefold()
    return ' '.join(''.join(character if character.isalnum() or character.isspace()
                           or unicodedata.category(character).startswith('M') else ' '
                           for character in value).split())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prior-dir', type=Path, required=True)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    for name in ('prior_dir', 'data_dir', 'output'):
        path = getattr(args, name).resolve()
        if path.is_relative_to(HERE.parents[2]):
            parser.error('Text-bearing inputs and audit output must remain outside the checkout')
        setattr(args, name, path)
    import pyarrow
    import pyarrow.parquet as parquet
    if pyarrow.__version__ != '23.0.1':
        raise ValueError('The prior frozen parquet reader is pyarrow23.0.1')
    policy = json.loads((HERE / 'policy.json').read_text())
    prior_manifest = json.loads((args.prior_dir / 'manifest.json').read_text())
    if (prior_manifest['dataset'] != policy['priorDataset']['id']
            or prior_manifest['revision'] != policy['priorDataset']['revision']):
        raise ValueError('Unexpected prior dataset revision')
    previous, raw_index, normalized_index, punctuation_index, sources = {}, collections.defaultdict(list), collections.defaultdict(list), collections.defaultdict(list), []
    for source in sorted(prior_manifest['files'], key=lambda row: row['path']):
        relative = Path(source['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Unsafe prior dataset manifest path')
        if not source['path'].startswith('queries/'):
            continue
        path = args.prior_dir / relative
        if sha(path) != source['sha256']:
            raise ValueError('Prior query parquet checksum mismatch')
        language = path.name.split('-')[0]
        rows = parquet.read_table(path).to_pylist()
        indexed = {str(row['_id']): row['text'] for row in rows}
        if language in previous or len(indexed) != len(rows):
            raise ValueError('Duplicate prior language or query IDs')
        previous[language] = indexed
        sources.append({'language': language, 'file': relative.as_posix(), 'sha256': sha(path), 'queries': len(rows)})
        for row in rows:
            record = {'language': language, 'id': str(row['_id']),
                      'textSHA256': hashlib.sha256(row['text'].encode()).hexdigest()}
            raw_index[row['text']].append(record)
            normalized_index[normalized(row['text'])].append(record)
            punctuation_index[punctuation_insensitive(row['text'])].append(record)
    if sum(map(len, previous.values())) != 3403 or len(previous) != 18:
        raise ValueError('Prior source does not contain all3403 previously evaluated queries')
    base_policy = json.loads((PUBLIC / 'policy.json').read_text())
    amendment = json.loads(AMENDMENT.read_text())
    languages = [language for language in base_policy['languages'] if language not in amendment['excludedPrimaryLanguages']]
    report = {'protocolSHA256': sha(HERE / 'policy.json'), 'auditSourceSHA256': sha(Path(__file__)),
              'priorDataset': prior_manifest['dataset'], 'priorRevision': prior_manifest['revision'],
              'priorQueries': 3403, 'priorManifestSHA256': sha(args.prior_dir / 'manifest.json'),
              'priorQueryFiles': sources, 'basePolicySHA256': sha(PUBLIC / 'policy.json'),
              'amendmentSHA256': sha(AMENDMENT),
              'versions': {'python': platform.python_version(), 'unicode': unicodedata.unidata_version, 'pyarrow': pyarrow.__version__},
              'languages': {}, 'testExposureMappings': []}
    totals = collections.Counter()
    for language in languages:
        directory = args.data_dir / language
        manifest_path = directory / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        if manifest['policySHA256'] != report['basePolicySHA256'] or manifest['amendmentSHA256'] != report['amendmentSHA256']:
            raise ValueError('New queries do not match the frozen primary study')
        path = directory / 'queries.jsonl'
        if sha(path) != manifest['files']['queries.jsonl']:
            raise ValueError('New query file checksum mismatch')
        counts, exposed, unseen = collections.Counter(), [], collections.defaultdict(list)
        for line in path.open():
            row = json.loads(line)
            group = row['split'] + '/' + row['subset']
            raw = raw_index.get(row['text'], [])
            norm = normalized_index.get(normalized(row['text']), [])
            punct = punctuation_index.get(punctuation_insensitive(row['text']), [])
            id_match = row['id'] in previous.get(language, {})
            flags = {'sameLanguageId': id_match, 'literalText': bool(raw), 'normalizedText': bool(norm),
                     'punctuationInsensitiveText': bool(punct), 'anyExposure': id_match or bool(norm) or bool(punct)}
            counts[group + '/queries'] += 1
            totals[group + '/queries'] += 1
            for name, value in flags.items():
                if value:
                    counts[group + '/' + name] += 1
                    totals[group + '/' + name] += 1
            if flags['anyExposure']:
                item = {'language': language, 'id': row['id'], 'split': row['split'], 'subset': row['subset'],
                        'matches': flags, 'queryTextSHA256': hashlib.sha256(row['text'].encode()).hexdigest(),
                        'priorIdTextSame': previous.get(language, {}).get(row['id']) == row['text'] if id_match else None,
                        'priorNormalizedMatches': norm, 'priorPunctuationInsensitiveMatches': punct}
                exposed.append(item)
                if row['split'] == 'test':
                    report['testExposureMappings'].append(item)
            else:
                unseen[group].append(row['id'])
        report['languages'][language] = {'newManifestSHA256': sha(manifest_path),
            'newQuerySHA256': manifest['files']['queries.jsonl'], 'newPoolFiles': manifest['files'],
            'corpusLevels': manifest['corpusLevels'], 'counts': dict(counts),
            'exposedQueries': exposed, 'unseenQueryIds': dict(unseen)}
    report['totals'] = dict(totals)
    report['anySelectedTestExposure'] = bool(report['testExposureMappings'])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(args.output, report)
    print(json.dumps({'priorQueries': 3403, 'totals': report['totals'],
                      'testExposureMappings': report['testExposureMappings']}, ensure_ascii=False))


if __name__ == '__main__':
    main()

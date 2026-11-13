#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Prepare a frozen mixed-language operational workload outside the checkout.

The workload retains positives for selected performance queries, then adds
hash-selected documents from the prepared public pools. It is a resource-cost
experiment, not a separate relevance leaderboard or a random personal corpus.
"""
import argparse
import hashlib
import heapq
import json
import math
from pathlib import Path

SEED = 'omnesis-lexical-operation-v1'
LANGUAGES = 'ar bn de en es fa fi fr hi id ja ko ru sw te th zh'.split()


def sha(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def key(*parts):
    return hashlib.sha256('|'.join((SEED, *map(str, parts))).encode()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--count', type=int, default=100000)
    parser.add_argument('--languages', nargs='+', default=LANGUAGES)
    args = parser.parse_args()
    if not 1000 <= args.count <= 1000000:
        parser.error('count must be between 1000 and 1000000')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    quota = math.ceil(args.count / len(args.languages))
    inputs, queries, selected = [], [], []
    for language in args.languages:
        directory = args.data_dir / language
        manifest = json.loads((directory / 'manifest.json').read_text())
        for name in ['documents.jsonl', 'queries.jsonl']:
            if sha(directory / name) != manifest['files'][name]:
                raise ValueError(f'Prepared input checksum mismatch: {language}/{name}')
        candidates = [json.loads(line) for line in (directory / 'queries.jsonl').open()]
        candidates = [q for q in candidates if q['split'] == 'test' and q['subset'] == 'relevant']
        chosen_queries = sorted(candidates, key=lambda q: key(language, q['id']))[:2]
        required = {docid for q in chosen_queries for docid, grade in q['judgments'].items() if grade > 0}
        retained, heap = [], []
        with (directory / 'documents.jsonl').open() as source:
            for line in source:
                record = json.loads(line)
                record['language'] = language
                record['originalId'] = record['id']
                record['id'] = language + ':' + str(record['id'])
                if record['originalId'] in required:
                    retained.append(record)
                else:
                    score = -int(key(language, record['originalId']), 16)
                    item = (score, record['id'], record)
                    if len(heap) < quota:
                        heapq.heappush(heap, item)
                    elif item[:2] > heap[0][:2]:
                        heapq.heapreplace(heap, item)
        if {r['originalId'] for r in retained} != required:
            raise ValueError(f'Selected performance positives missing in {language}')
        background = [r for _, _, r in sorted(heap, reverse=True)][:max(0, quota - len(retained))]
        selected.extend(retained + background)
        queries.extend({'id': language + ':' + q['id'], 'language': language,
                        'text': q['text'], 'positiveIds': [language + ':' + d for d, g in q['judgments'].items() if g > 0]}
                       for q in chosen_queries)
        inputs.append({'language': language, 'documentSHA256': manifest['files']['documents.jsonl'],
                       'querySHA256': manifest['files']['queries.jsonl'],
                       'forcedPositiveDocuments': len(retained), 'selectedDocuments': len(retained) + len(background)})
    # Required positives come first so smaller prefixes retain successful-query
    # opportunities. The rest is mixed deterministically across all languages.
    required_ids = {d for q in queries for d in q['positiveIds']}
    selected.sort(key=lambda d: (d['id'] not in required_ids, key(d['language'], d['originalId'])))
    selected = selected[:args.count]
    corpus = args.output_dir / 'documents.jsonl'
    with corpus.open('w') as output:
        for record in selected:
            output.write(json.dumps(record, ensure_ascii=False) + '\n')
    query_path = args.output_dir / 'queries.json'
    write_json(query_path, queries)
    report = {'seed': SEED, 'documents': len(selected), 'queries': len(queries),
              'languages': args.languages, 'sourcePools': inputs,
              'files': {'documents.jsonl': sha(corpus), 'queries.json': sha(query_path)},
              'selection': 'Retain selected-query positives; hash-sample balanced prepared public pools; required positives precede hash-mixed background.',
              'limitations': ['Public encyclopedic passages, not private personal data.',
                              'Judgment-augmented bounded-shard input pools; not full MIRACL.',
                              'Smaller prefixes preserve positives and are not random samples.']}
    write_json(args.output_dir / 'manifest.json', report)
    print(json.dumps({'documents': len(selected), 'queries': len(queries), 'languages': len(args.languages)}))


if __name__ == '__main__':
    main()

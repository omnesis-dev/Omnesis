#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Prepare pinned public judgments and nested distractor pools outside Git.

Only public identifiers, hashes and counts enter the manifest. The prepared JSONL
contains public benchmark text and MUST remain in the external --data-dir.
"""
import argparse
import collections
import gzip
import hashlib
import heapq
import json
import re
from pathlib import Path
import time
import urllib.request

HERE = Path(__file__).resolve().parent
AMENDMENT = HERE / 'amendment-2026-11-13.json'
NAMES = dict(zip('ar bn de en es fa fi fr hi id ja ko ru sw te th yo zh'.split(),
                 'arabic bengali german english spanish persian finnish french hindi indonesian japanese korean russian swahili telugu thai yoruba chinese'.split()))


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def digest(*parts):
    return hashlib.sha256('|'.join(parts).encode()).hexdigest()


def atomic_json(path, obj):
    temporary = path.with_suffix(path.suffix + '.part')
    temporary.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def download(url, path, expected=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and (expected is None or sha(path) == expected):
        return
    temporary = path.with_suffix(path.suffix + '.part')
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as response, temporary.open('wb') as out:
                while block := response.read(1024 * 1024):
                    out.write(block)
            if expected and sha(temporary) != expected:
                raise ValueError('Downloaded checksum mismatch')
            temporary.replace(path)
            return
        except Exception:
            temporary.unlink(missing_ok=True)
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def tree(spec, root):
    path = root / ('tree-' + spec['id'].split('/')[-1] + '-' + spec['revision'] + '.json')
    download(f"https://huggingface.co/api/datasets/{spec['id']}/tree/{spec['revision']}?recursive=true&expand=false&limit=1000", path)
    rows = json.loads(path.read_text())
    if not isinstance(rows, list):
        raise ValueError('Unexpected dataset tree')
    return {row['path']: row for row in rows if row['type'] == 'file'}


def fetch(spec, relative, entries, root, records):
    if Path(relative).is_absolute() or '..' in Path(relative).parts:
        raise ValueError('Unsafe upstream dataset file path')
    metadata = entries[relative]
    checksum = metadata.get('lfs', {}).get('oid')
    target = root / spec['id'].split('/')[-1] / relative
    download(f"https://huggingface.co/datasets/{spec['id']}/resolve/{spec['revision']}/{relative}", target, checksum)
    if target.stat().st_size != metadata['size']:
        raise ValueError('Downloaded size mismatch: ' + relative)
    if not checksum:
        content = target.read_bytes()
        git_sha = hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()
        if git_sha != metadata['oid']:
            raise ValueError('Pinned Git blob mismatch: ' + relative)
    records.append({'dataset': spec['id'], 'revision': spec['revision'], 'file': relative,
                    'sha256': sha(target), 'bytes': target.stat().st_size})
    return target


def prepare(language, policy, args, entries):
    directory = args.data_dir / language
    directory.mkdir(parents=True, exist_ok=True)
    amendment = json.loads(AMENDMENT.read_text())
    if language in amendment['excludedPrimaryLanguages']:
        raise ValueError('Language excluded by pre-score integrity amendment: ' + language)
    records, queries, wanted, aliases = [], [], set(), []
    full_relevant_dev = {}
    spec = policy['datasets']['judgments']
    all_split_ids = collections.defaultdict(set)
    for split, limit in policy['samplesPerLanguageAndSubset'].items():
        for subset in policy['subsets']:
            prefix = f'data/{NAMES[language]}'
            topic = fetch(spec, f'{prefix}/topics/{split}.{subset}.tsv', entries['judgments'], args.data_dir, records)
            qrels = fetch(spec, f'{prefix}/qrels/{split}.{subset}.tsv', entries['judgments'], args.data_dir, records)
            topic_lines = [line for line in topic.read_text().splitlines() if line]
            texts = dict(line.split('\t', 1) for line in topic_lines)
            if len(texts) != len(topic_lines):
                raise ValueError('Duplicate public query IDs within a topic file')
            judgments = collections.defaultdict(dict)
            for line in qrels.read_text().splitlines():
                qid, _, docid, score = line.split()
                if int(score) not in (0, 1):
                    raise ValueError('Unexpected relevance grade')
                raw_docid = docid
                legacy = re.fullmatch(r'([0-9]+)#([0-9]+)#01', docid) if language == 'zh' else None
                if legacy:
                    docid = legacy.group(1) + '#' + str(int(legacy.group(2)))
                if docid in judgments[qid] and judgments[qid][docid] != int(score):
                    raise ValueError('Conflicting canonical document-ID labels')
                judgments[qid][docid] = int(score)
                if raw_docid != docid:
                    aliases.append({'queryId': qid, 'split': split, 'subset': subset,
                                    'rawDocumentId': raw_docid, 'documentId': docid, 'label': int(score)})
            if split == 'dev' and subset == 'relevant':
                full_relevant_dev = {qid: dict(judgments[qid]) for qid in texts}
            if all_split_ids[split] & set(texts):
                raise ValueError('Relevant and no-known-positive subsets overlap')
            all_split_ids[split].update(texts)
            chosen = sorted(texts, key=lambda qid: digest(policy['seed'], language, split, subset, qid))[:limit]
            for qid in chosen:
                labels = judgments[qid]
                if not labels or bool(max(labels.values())) != (subset == 'relevant'):
                    raise ValueError('Missing or inconsistent judgment subset')
                wanted.update(labels)
                queries.append({'id': qid, 'split': split, 'subset': subset, 'text': texts[qid], 'judgments': labels})
    if all_split_ids['dev'] & all_split_ids['test']:
        raise ValueError('Official development/test overlap')
    validation_spec = amendment['officialValidationDataset']
    official = fetch(validation_spec, f'miracl-v1.0-{language}/qrels/qrels.miracl-v1.0-{language}-dev.tsv',
                     entries['official'], args.data_dir, records)
    labels = collections.defaultdict(dict)
    for line in official.read_text().splitlines():
        qid, _, docid, score = line.split()
        labels[qid][docid] = int(score)
    differing = []
    selected_development = {row['id'] for row in queries if row['split'] == 'dev' and row['subset'] == 'relevant'}
    for qid, values in full_relevant_dev.items():
        if labels[qid] == values:
            continue
        differing.append(qid)
        if (language != 'id' or qid != '1731' or qid in selected_development
                or values != {**labels[qid], '0': 0}):
            raise ValueError('Published development judgments fail official cross-check')
    development_validation = {'queries': len(full_relevant_dev),
                              'identicalOfficialJudgments': len(full_relevant_dev) - len(differing),
                              'unselectedDifferingQueryIds': differing,
                              'allSelectedQueriesMatch': True}
    judged_path = fetch(spec, f'data/{NAMES[language]}/corpus.jsonl.gz', entries['judgments'], args.data_dir, records)
    docs = {}
    with gzip.open(judged_path, 'rt') as stream:
        for line in stream:
            row = json.loads(line)
            if row['docid'] in wanted:
                if row['docid'] in docs and docs[row['docid']] != row:
                    raise ValueError('Conflicting judged passage versions')
                docs[row['docid']] = row
    recovery = []
    if set(docs) != wanted and language == 'zh':
        recovery_name = 'miracl-corpus-v1.0-zh/docs-0.jsonl.gz'
        recovery_path = fetch(policy['datasets']['background'], recovery_name, entries['background'], args.data_dir, records)
        missing = wanted - set(docs)
        with gzip.open(recovery_path, 'rt') as stream:
            for line in stream:
                row = json.loads(line)
                if row['docid'] in missing:
                    docs[row['docid']] = row
                    recovery.append(row['docid'])
        if set(recovery) != missing:
            raise ValueError('Official Chinese text recovery incomplete')
    if set(docs) != wanted:
        raise ValueError('Missing judged passage text')
    required_count = len(docs)
    max_size = max(policy['corpusSizes'])
    if required_count > min(policy['corpusSizes']):
        raise ValueError('Judgment pool exceeds smallest planned corpus')
    background_spec = policy['datasets']['background']
    shard_names = [name for name in entries['background']
                   if name.startswith(f'miracl-corpus-v1.0-{language}/docs-') and name.endswith('.jsonl.gz')]
    shard_names.sort(key=lambda name: digest(policy['seed'], language, name))
    # A bounded heap retains only the lowest document hashes. Whole chosen shards
    # are read before stopping, avoiding a first-lines selection within a shard.
    heap, seen, conflicts, scanned = [], set(docs), 0, 0
    needed = max_size - len(docs)
    consumed = []
    for name in shard_names:
        path = fetch(background_spec, name, entries['background'], args.data_dir, records)
        consumed.append(name)
        with gzip.open(path, 'rt') as stream:
            for line in stream:
                row = json.loads(line)
                docid = row['docid']
                scanned += 1
                if docid in docs:
                    conflicts += int((row.get('text'), row.get('title')) != (docs[docid].get('text'), docs[docid].get('title')))
                    continue
                if docid in seen:
                    continue
                seen.add(docid)
                order = int(digest(policy['seed'], language, docid), 16)
                item = (-order, docid, row)
                if len(heap) < needed:
                    heapq.heappush(heap, item)
                elif item > heap[0]:
                    heapq.heapreplace(heap, item)
        if len(heap) >= needed:
            break
    background = [item[2] for item in sorted(heap, reverse=True)]
    levels = {}
    # One maximal document file, with a manifest of nested docids. Put every
    # judged document first, then hash-ordered sampled background documents.
    ordered = [docs[docid] for docid in sorted(docs, key=lambda docid: digest(policy['seed'], language, docid))] + background
    documents_path = directory / 'documents.jsonl'
    with documents_path.open('w') as out:
        for row in ordered:
            out.write(json.dumps({'id': row['docid'], 'title': row.get('title', ''), 'text': row['text']}, ensure_ascii=False) + '\n')
    query_path = directory / 'queries.jsonl'
    with query_path.open('w') as out:
        for row in queries:
            out.write(json.dumps(row, ensure_ascii=False) + '\n')
    for size in policy['corpusSizes']:
        count = min(size, len(ordered))
        levels[str(size)] = {'requested': size, 'actual': count, 'judgedDocuments': required_count,
                             'backgroundDocuments': count - required_count,
                             'documentIdsSHA256': digest(*(row['docid'] for row in ordered[:count]))}
    selected = {(row['id'], row['split'], row['subset']) for row in queries}
    selected_aliases = [row for row in aliases if (row['queryId'], row['split'], row['subset']) in selected]
    manifest = {'language': language, 'policySHA256': sha(HERE / 'policy.json'),
                'amendmentSHA256': sha(AMENDMENT),
                'developmentOfficialCrosscheck': development_validation,
                'canonicalIdAliases': selected_aliases,
                'canonicalIdAffectedSelectedLabels': dict(collections.Counter(row['split'] for row in selected_aliases)),
                'recoveredOfficialDocumentIds': sorted(recovery), 'sourceFiles': records,
                'queries': dict(collections.Counter(row['split'] + '/' + row['subset'] for row in queries)),
                'judgments': dict(collections.Counter(str(value) for row in queries for value in row['judgments'].values())),
                'corpusLevels': levels, 'backgroundShards': consumed, 'scannedBackgroundDocuments': scanned,
                'judgedVersionConflicts': conflicts,
                'files': {path.name: sha(path) for path in (documents_path, query_path)}}
    atomic_json(directory / 'manifest.json', manifest)
    print(json.dumps({'language': language, 'queries': manifest['queries'], 'levels': levels}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--languages', nargs='+', choices=sorted(NAMES), default=sorted(set(NAMES) - {'yo'}))
    args = parser.parse_args()
    args.data_dir = args.data_dir.resolve()
    if args.data_dir.is_relative_to(HERE.parents[2]):
        raise ValueError('Downloaded corpus text must stay outside the repository')
    args.data_dir.mkdir(parents=True, exist_ok=True)
    policy = json.loads((HERE / 'policy.json').read_text())
    entries = {name: tree(spec, args.data_dir) for name, spec in policy['datasets'].items()}
    entries['official'] = tree(json.loads(AMENDMENT.read_text())['officialValidationDataset'], args.data_dir)
    for language in args.languages:
        prepare(language, policy, args, entries)


if __name__ == '__main__':
    main()

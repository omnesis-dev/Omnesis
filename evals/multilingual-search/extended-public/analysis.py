# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Disk-backed analyzer responses; no corpus text enters research reports."""
import functools
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import unicodedata

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from run import Snowball, encode, fold_latin  # noqa: E402

ISO3 = dict(zip('ar bn de en es fa fi fr hi id ja ko ru sw te th yo zh'.split(),
                'ara ben deu eng spa pes fin fra hin ind jpn kor rus swa tel tha yor cmn'.split()))


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def quoted(text):
    value = text.strip()
    return len(value) > 1 and value.startswith('"') and value.endswith('"')


def query_text(text):
    return text.strip()[1:-1] if quoted(text) else text


def analyze(args, language, family, documents, queries, manifest, policy_hash):
    """Return path containing [title tokens, content tokens] then query tokens.

    Cache identity includes binary, helper and exact source-data hashes. Process
    input/output are files so pipe buffering cannot deadlock or multiply RAM.
    """
    binary = getattr(args, {'icu': 'icu4x', 'full': 'charabia_full',
                            'lean': 'charabia_lean', 'prototype': 'prototype',
                            'exact': 'prototype'}[family]).resolve()
    signature = {'binary': sha(binary), 'source': sha(Path(__file__)),
                 'helpers': sha(HERE.parent / 'run.py'), 'language': language,
                 'family': family, 'data': manifest['files'], 'policy': policy_hash,
                 'snowball': '3.1.1'}
    key = hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()
    directory = args.cache_dir / language
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (family + '-' + key + '.jsonl')
    meta = target.with_suffix('.meta.json')
    if target.exists() and meta.exists():
        record = json.loads(meta.read_text())
        if record['sha256'] == sha(target):
            return target, {**record['timing'], 'cacheHit': True, 'binarySHA256': signature['binary'], 'engineMetadata': record.get('engineMetadata', {})}
    source = target.with_suffix('.input.part')
    response = target.with_suffix('.response.part')
    with source.open('w') as stream:
        for text in (field for row in documents for field in (row['title'], row['text'])):
            options = {'text': unicodedata.normalize('NFKC', text),
                       'language': language if family in ('icu', 'prototype', 'exact') else ISO3[language]}
            if family == 'icu':
                options['mode'] = 'dictionary'
            elif family in ('prototype', 'exact'):
                options['text'] = text
                options['mode'] = 'exact' if family == 'exact' else 'stem'
            stream.write(json.dumps(options, ensure_ascii=False) + '\n')
        for row in queries:
            options = {'text': unicodedata.normalize('NFKC', query_text(row['text'])),
                       'language': language if family in ('icu', 'prototype', 'exact') else ISO3[language]}
            if family == 'icu':
                options['mode'] = 'dictionary'
            elif family in ('prototype', 'exact'):
                options['text'] = query_text(row['text'])
                options['mode'] = 'exact' if family == 'exact' else 'stem'
            stream.write(json.dumps(options, ensure_ascii=False) + '\n')
    started = time.perf_counter()
    with source.open('rb') as stdin, response.open('wb') as stdout:
        subprocess.run([str(binary)], stdin=stdin, stdout=stdout, check=True)
    analysis_seconds = time.perf_counter() - started
    snowball = Snowball('python')
    if snowball.version != '3.1.1':
        raise ValueError('Frozen policy requires snowballstemmer 3.1.1')

    @functools.lru_cache(maxsize=500_000)
    def normalized(token):
        value = snowball.stem(token, language)
        return fold_latin(value) if family == 'icu' else value

    started = time.perf_counter()
    count, pair, engine_metadata = 0, [], {}
    temporary = target.with_suffix('.part')
    with response.open() as stream, temporary.open('w') as out:
        for line in stream:
            record = json.loads(line)
            if count == 0:
                engine_metadata = {key: record[key] for key in ('engine', 'version', 'normalization', 'algorithm', 'dependencies', 'fingerprint', 'snowball_commit', 'korean_dictionary_sha256', 'mode', 'segmenter', 'folding') if key in record}
            elif record.get('fingerprint') != engine_metadata.get('fingerprint'):
                raise ValueError('Analyzer fingerprint changed within one configured language/lane')
            if 'error' in record:
                raise ValueError('Analyzer returned an error')
            tokens = [item['text'] for item in record['tokens']]
            if family not in ('prototype', 'exact'):
                tokens = [normalized(token) for token in tokens]
            tokens = [token for token in tokens if token]
            if count < len(documents) * 2:
                pair.append(tokens)
                if len(pair) == 2:
                    out.write(json.dumps(pair, ensure_ascii=False) + '\n')
                    pair = []
            else:
                out.write(json.dumps(tokens, ensure_ascii=False) + '\n')
            count += 1
    expected = len(documents) * 2 + len(queries)
    if count != expected:
        raise ValueError(f'Analyzer response count {count} differs from {expected}')
    temporary.replace(target)
    timing = {'analyzerProcessSeconds': analysis_seconds,
              'pythonTokenTransformSeconds': time.perf_counter() - started}
    meta.write_text(json.dumps({'signature': signature, 'sha256': sha(target), 'timing': timing, 'engineMetadata': engine_metadata}) + '\n')
    source.unlink()
    response.unlink()
    snowball.close()
    return target, {**timing, 'cacheHit': False, 'binarySHA256': signature['binary'], 'engineMetadata': engine_metadata}


def expression(tokens, operation='OR', phrase=False):
    if phrase:
        return '"' + ' '.join(map(encode, tokens)) + '"' if tokens else ''
    return (' ' + operation + ' ').join('"' + encode(token) + '"' for token in dict.fromkeys(tokens))

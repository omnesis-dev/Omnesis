# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Predeclared, optional query-stopword and dictionary-lemma challengers."""
import functools
import hashlib
import json
from pathlib import Path
import sys
import time

from analysis import query_text, quoted, sha

HERE = Path(__file__).resolve().parent
PROTOCOL = HERE / 'supplemental-policy.json'
sys.path.insert(0, str(HERE.parent))
from run import probe  # noqa: E402


def prepare_stopwords(args, language, queries, expected_tokens, expected_profile):
    document = json.loads(args.stopwords.read_text())
    version = document.get('version', document.get('luceneVersion'))
    if version != '9.12.3' or not isinstance(document.get('languages'), dict):
        raise ValueError('Expected pinned Lucene 9.12.3 stopword export')
    row = document['languages'].get(language)
    if not isinstance(row, dict) or not isinstance(row.get('words'), list) or not all(isinstance(word, str) for word in row['words']):
        raise ValueError('Missing explicit language stopword availability')
    source_words = sorted(set(row['words']))
    requests = [{'text': word, 'language': language, 'mode': 'exact'} for word in source_words]
    requests.extend({'text': query_text(query['text']), 'language': language, 'mode': 'stem'} for query in queries)
    records, elapsed = probe([str(args.prototype.resolve())], requests)
    normalized, ignored_empty, ignored_multiple = set(), 0, 0
    for record in records[:len(source_words)]:
        tokens = record.get('tokens', [])
        if 'error' in record:
            raise ValueError('Stopword normalization returned an error')
        if len(tokens) == 1:
            normalized.add(tokens[0]['surface'])
        elif tokens:
            ignored_multiple += 1
        else:
            ignored_empty += 1
    filtered, query_stats = [], []
    expected_fingerprint = expected_profile['engineMetadata']['fingerprint']
    for query, record, original in zip(queries, records[len(source_words):], expected_tokens, strict=True):
        if record.get('fingerprint') != expected_fingerprint or [token['text'] for token in record['tokens']] != original:
            raise ValueError('Supplemental query analysis differs from the primary prototype analysis')
        is_quoted = quoted(query['text'])
        remaining = [token['text'] for token in record['tokens'] if token['surface'] not in normalized] if not is_quoted else original
        would_remove = len(original) - len(remaining)
        fallback = bool(original) and not remaining
        if fallback:
            remaining = original
        filtered.append(remaining)
        query_stats.append({'id': query['id'], 'split': query['split'], 'subset': query['subset'],
                            'originalTokens': len(original), 'remainingTokens': len(remaining),
                            'removedTokens': len(original) - len(remaining), 'wouldRemoveTokens': would_remove,
                            'quotedUnchanged': is_quoted, 'emptyFallback': fallback})
    profile = {'protocolSHA256': sha(PROTOCOL), 'stopwordExportSHA256': sha(args.stopwords),
               'luceneVersion': version, 'status': row.get('status', 'available' if source_words else 'empty'),
               'analyzer': row.get('analyzer'), 'sourceEntries': len(source_words),
               'normalizedSingleTokenStopwords': len(normalized), 'ignoredEmptyEntries': ignored_empty,
               'ignoredMultiTokenEntries': ignored_multiple,
               'normalizedStopwordsSHA256': hashlib.sha256(json.dumps(sorted(normalized), ensure_ascii=False).encode()).hexdigest(),
               'queryAndStopwordAnalysisSeconds': elapsed, 'perQueryFiltering': query_stats,
               'queriesWithRemoval': sum(row['removedTokens'] > 0 for row in query_stats),
               'emptyFallbackQueries': sum(row['emptyFallback'] for row in query_stats),
               'quotedUnchangedQueries': sum(row['quotedUnchanged'] for row in query_stats)}
    return filtered, profile


def prepare_lemma(args, language, documents, queries, exact_path, exact_queries):
    policy = json.loads(PROTOCOL.read_text())['lemmatization']
    if language not in policy['languages']:
        return None, None, {'supported': False, 'reason': 'Outside predeclared Simplemma 2.0 language coverage',
                            'protocolSHA256': sha(PROTOCOL)}
    from lemma import Lemmatizer
    lemmatizer = Lemmatizer()
    if lemmatizer.version != '2.0.0' or language not in lemmatizer.supported:
        raise ValueError('Expected supported Simplemma 2.0.0 dictionary')
    count = min(policy['corpusSize'], len(documents))
    signature = {'source': sha(Path(__file__)), 'helper': sha(HERE.parent / 'lemma.py'),
                 'protocol': sha(PROTOCOL), 'exactAnalysis': sha(exact_path), 'language': language,
                 'version': lemmatizer.version, 'count': count}
    key = hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()
    target = args.cache_dir / language / ('lemma-' + key + '.jsonl')
    meta = target.with_suffix('.meta.json')
    if target.exists() and meta.exists():
        profile = json.loads(meta.read_text())
        if profile['sha256'] == sha(target):
            with target.open() as stream:
                for _ in range(count):
                    next(stream)
                transformed_queries = [json.loads(line) for line in stream]
            if len(transformed_queries) != len(queries):
                raise ValueError('Cached lemma query count mismatch')
            return target, transformed_queries, {**profile, 'cacheHit': True}
    started = time.perf_counter()

    @functools.lru_cache(maxsize=250_000)
    def lemma(token):
        value = lemmatizer.lemma(token, language)
        if not value or any(character.isspace() or character == '\0' for character in value):
            return token, True
        return value, False

    stats = {'tokenInstances': 0, 'changedTokenInstances': 0, 'fallbackTokenInstances': 0}

    def transform(tokens):
        transformed = []
        for token in tokens:
            value, fallback = lemma(token)
            stats['tokenInstances'] += 1
            stats['changedTokenInstances'] += value != token
            stats['fallbackTokenInstances'] += fallback
            transformed.append(value)
        return transformed

    temporary = target.with_suffix('.part')
    with exact_path.open() as stream, temporary.open('w') as out:
        for _ in range(count):
            title, content = json.loads(next(stream))
            out.write(json.dumps([transform(title), transform(content)], ensure_ascii=False) + '\n')
        transformed_queries = [transform(tokens) for tokens in exact_queries]
        for tokens in transformed_queries:
            out.write(json.dumps(tokens, ensure_ascii=False) + '\n')
    temporary.replace(target)
    profile = {'supported': True, 'version': lemmatizer.version, 'language': language,
               'protocolSHA256': sha(PROTOCOL), 'dictionaryHelperSHA256': signature['helper'],
               'analysisSeconds': time.perf_counter() - started, 'corpusDocuments': count,
               'sha256': sha(target), **stats}
    meta.write_text(json.dumps(profile) + '\n')
    return target, transformed_queries, {**profile, 'cacheHit': False}

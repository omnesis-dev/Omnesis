#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Run the frozen lexical benchmark, one or more independent languages at a time.

Run heavy evaluations through the host's installed test-job queue. Reports contain
public IDs and scores; corpus/query/analyzer caches remain outside Git.
"""
import argparse
import contextlib
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time

from analysis import analyze, encode, expression, quoted, sha
from prepare import AMENDMENT, atomic_json, digest
from scoring import paired_interval, retrieval_metrics, summarize
from supplements import PROTOCOL, prepare_lemma, prepare_stopwords

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from run import words  # noqa: E402


def baseline_expression(text):
    value = text.strip()
    if quoted(value):
        return value
    return ' OR '.join('"' + word + '"' for word in words(value))


def ensure_coverage_extension(cache):
    source = HERE / 'match-count.c'
    path = cache / ('matchcount-' + sha(source) + '.so')
    if not path.exists():
        with tempfile.NamedTemporaryFile(prefix='matchcount-', suffix='.so', dir=cache, delete=False) as stream:
            temporary = Path(stream.name)
        try:
            subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-shared',
                            str(source), '-o', str(temporary)], check=True)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return path


def index(args, language, family, size, documents, analyzed_path, signature):
    count = min(size, len(documents))
    directory = args.cache_dir / language
    directory.mkdir(parents=True, exist_ok=True)
    signature = {**signature, 'family': family, 'count': count,
                 'source': sha(Path(__file__)), 'analysis': sha(analyzed_path) if analyzed_path else None,
                 'sqlite': sqlite3.sqlite_version}
    key = hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()
    target = directory / ('index-' + key + '.sqlite')
    meta = target.with_suffix('.meta.json')
    ids = [row['id'] for row in documents[:count]]
    ids.sort(key=lambda docid: digest(args.seed, language, docid))
    rowids = {docid: rowid for rowid, docid in enumerate(ids, 1)}
    if target.exists() and meta.exists():
        timing = json.loads(meta.read_text())
        with contextlib.closing(sqlite3.connect(target)) as db:
            if db.execute('SELECT count(*) FROM f').fetchone()[0] != count:
                raise ValueError('Cached index document count mismatch')
        return target, ids, {**timing, 'cacheHit': True}
    temporary = target.with_suffix('.part.sqlite')
    temporary.unlink(missing_ok=True)
    started = time.perf_counter()
    with contextlib.closing(sqlite3.connect(temporary)) as db:
        db.execute('PRAGMA journal_mode=OFF')
        db.execute('PRAGMA synchronous=OFF')
        tokenizer = 'porter unicode61 remove_diacritics 2' if family == 'current' else 'unicode61'
        db.execute(f"CREATE VIRTUAL TABLE f USING fts5(content,title,tokenize='{tokenizer}')")
        if analyzed_path:
            with analyzed_path.open() as stream:
                for document in documents[:count]:
                    title, content = json.loads(next(stream))
                    db.execute('INSERT INTO f(rowid,content,title) VALUES (?,?,?)',
                               (rowids[document['id']], ' '.join(map(encode, content)), ' '.join(map(encode, title))))
        else:
            db.executemany('INSERT INTO f(rowid,content,title) VALUES (?,?,?)',
                           ((rowids[row['id']], row['text'], row['title']) for row in documents[:count]))
        db.commit()
        db.execute("INSERT INTO f(f) VALUES ('optimize')")
        db.commit()
    timing = {'indexSeconds': time.perf_counter() - started, 'indexBytes': temporary.stat().st_size}
    temporary.replace(target)
    meta.write_text(json.dumps(timing) + '\n')
    return target, ids, {**timing, 'cacheHit': False}


def retrieve(db, ids, expr, limit, coverage=None):
    if not expr:
        return []
    where, parameters = 'f MATCH ?', [expr]
    if coverage is not None:
        where += ' AND matched_phrases(f) >= ?'
        parameters.append(coverage)
    parameters.append(limit)
    rows = db.execute('SELECT rowid,bm25(f,1.0,2.0) FROM f WHERE ' + where
                      + ' ORDER BY bm25(f,1.0,2.0),rowid LIMIT ?', parameters)
    return [(ids[rowid - 1], -score) for rowid, score in rows]


def fuse(stem, exact, k, row_order):
    scores = {}
    for ranking in (stem, exact):
        for rank, (docid, _) in enumerate(ranking, 1):
            scores[docid] = scores.get(docid, 0.0) + 1 / (k + rank)
    return sorted(scores.items(), key=lambda item: (-item[1], row_order[item[0]]))


def tiers(stem, phrase, exact_and, row_order):
    stem_rank = {docid: rank for rank, (docid, _) in enumerate(stem, 1)}
    categories = {docid: 1 for docid, _ in stem}
    categories.update((docid, 2) for docid, _ in exact_and)
    categories.update((docid, 3) for docid, _ in phrase)
    missing_rank = len(stem) + 1
    ids = sorted(categories, key=lambda docid: (-categories[docid], stem_rank.get(docid, missing_rank), row_order[docid]))
    # This monotone scalar represents the lexicographic tier/rank for dev-only
    # acceptance calibration. No raw BM25 scores from different lanes are added.
    return [(docid, categories[docid] + 1 / (60 + stem_rank.get(docid, missing_rank))) for docid in ids]


def query_records(path, document_count):
    with path.open() as stream:
        for _ in range(document_count):
            next(stream)
        return [json.loads(line) for line in stream]


def report_method(method, queries, rankings, timing):
    rows = []
    for query, found in zip(queries, rankings, strict=True):
        ranking = [docid for docid, _ in found[:100]]
        top = ranking[0] if ranking else None
        status = 'no-result' if top is None else ('unjudged' if top not in query['judgments'] else
                                                'relevant' if query['judgments'][top] else 'explicit-negative')
        rows.append({'id': query['id'], 'split': query['split'], 'subset': query['subset'],
                     'metrics': retrieval_metrics(ranking, query['judgments']),
                     'score': found[0][1] if found else None, 'top1Judgment': status,
                     'returned': len(ranking), 'positiveJudgments': sum(query['judgments'].values()),
                     'explicitNegativeJudgments': sum(value == 0 for value in query['judgments'].values())})
    return {'method': method, **summarize(rows), 'timing': timing, 'perQuery': rows}


def supplemental_results(methods, baseline, policy, seed, profile):
    baseline_rows = {row['id']: row['metrics'] for row in baseline['perQuery']
                     if row['split'] == 'test' and row['subset'] == 'relevant'}
    methods = {method: {**record, 'method': method} for method, record in methods.items()}
    for method, record in methods.items():
        selected = {row['id']: row['metrics'] for row in record['perQuery']
                    if row['split'] == 'test' and row['subset'] == 'relevant'}
        record['pairedTestDifferenceVsNativeStem'] = paired_interval(
            selected, baseline_rows, seed + method,
            policy['uncertainty']['pairedBootstrapReplicates'])
    return {'status': 'predeclared exploratory supplement, outside the primary nine methods',
            'profile': profile, 'methods': methods}


def evaluate_language(args, policy, language):
    directory = args.data_dir / language
    manifest = json.loads((directory / 'manifest.json').read_text())
    policy_hash = sha(HERE / 'policy.json')
    if manifest.get('amendmentSHA256') != sha(AMENDMENT):
        raise ValueError('Prepared data uses a different integrity amendment')
    if manifest['policySHA256'] != policy_hash:
        raise ValueError('Prepared data uses a different frozen policy')
    for name, expected in manifest['files'].items():
        if sha(directory / name) != expected:
            raise ValueError('Prepared text checksum mismatch')
    documents = [json.loads(line) for line in (directory / 'documents.jsonl').open()]
    queries = [json.loads(line) for line in (directory / 'queries.jsonl').open()]
    if len({row['id'] for row in documents}) != len(documents):
        raise ValueError('Duplicate document IDs')
    result = {'dataManifest': manifest, 'levels': {}}
    families = ['prototype', 'exact'] if args.supplemental_only else ['current', 'icu', 'full', 'prototype', 'exact']
    if not args.supplemental_only and language not in ('zh', 'ja'):
        families.insert(3, 'lean')
    analyzed, analysis_timing, query_tokens = {}, {}, {}
    # Maximal analyses are cached once and reused by both nested corpus levels.
    for family in families:
        if family == 'current':
            continue
        print(json.dumps({'phase': 'analysis', 'language': language, 'family': family}), flush=True)
        path, timing = analyze(args, language, family, documents, queries, manifest, policy_hash)
        analyzed[family], analysis_timing[family] = path, timing
        query_tokens[family] = query_records(path, len(documents))
    result['analyzerProfiles'] = analysis_timing
    filtered_queries = stopword_profile = lemma_path = lemma_queries = lemma_profile = None
    if args.stopwords:
        filtered_queries, stopword_profile = prepare_stopwords(
            args, language, queries, query_tokens['prototype'], analysis_timing['prototype'])
    if args.simplemma and 10000 in args.sizes:
        lemma_path, lemma_queries, lemma_profile = prepare_lemma(
            args, language, documents, queries, analyzed['exact'], query_tokens['exact'])
        result['lemmaCoverage'] = lemma_profile
    extension = ensure_coverage_extension(args.cache_dir)
    for size in args.sizes:
        started = time.perf_counter()
        level = {'corpus': manifest['corpusLevels'][str(size)], 'methods': {}}
        indexes = {}
        try:
            for family in families:
                if args.supplemental_only and family == 'exact':
                    continue
                path, ids, timing = index(args, language, family, size, documents,
                                          analyzed.get(family), {'data': manifest['files'], 'policy': policy_hash})
                db = sqlite3.connect(path)
                db.enable_load_extension(True)
                db.load_extension(str(extension))
                db.enable_load_extension(False)
                indexes[family] = (db, ids, timing)
            simple = [('current-porter-or', 'current'), ('icu-snowball-or', 'icu'),
                      ('charabia-full-snowball-or', 'full'),
                      ('lean-icu-snowball-or', 'icu' if language in ('zh', 'ja') else 'lean'),
                      ('prototype-stem-or', 'prototype'), ('prototype-stem-and', 'prototype'),
                      ('prototype-stem-msm60', 'prototype')]
            if args.supplemental_only:
                simple = [('prototype-stem-or', 'prototype')]
            stem_rankings = None
            depth = policy['ranking']['fusionInputDepth']
            for method, family in simple:
                db, ids, timing = indexes[family]
                query_started, rankings = time.perf_counter(), []
                for i, query in enumerate(queries):
                    if family == 'current':
                        expr = baseline_expression(query['text'])
                        coverage = None
                    else:
                        tokens = query_tokens[family][i]
                        operation = 'AND' if method.endswith('-and') else 'OR'
                        expr = expression(tokens, operation, quoted(query['text']))
                        coverage = (math.ceil(policy['ranking']['minimumMatchFraction'] * len(set(tokens)))
                                    if method.endswith('msm60') and not quoted(query['text']) else None)
                    rankings.append(retrieve(db, ids, expr, depth if method == 'prototype-stem-or' else 100, coverage))
                if method == 'prototype-stem-or':
                    stem_rankings = rankings
                method_timing = {**timing, **analysis_timing.get(family, {}),
                                 'querySeconds': time.perf_counter() - query_started}
                level['methods'][method] = report_method(method, queries, rankings, method_timing)
                print(json.dumps({'language': language, 'size': size, 'method': method,
                                  **level['methods'][method]['splits']['test']['relevant']}), flush=True)
            row_order = {docid: rank for rank, docid in enumerate(indexes['prototype'][1])}
            if not args.supplemental_only:
                exact_db, ids, timing = indexes['exact']
                row_order = {docid: rank for rank, docid in enumerate(ids)}
                fused, tiered = [], []
                query_started = time.perf_counter()
                for i, query in enumerate(queries):
                    tokens = query_tokens['exact'][i]
                    is_phrase = quoted(query['text'])
                    exact_or = retrieve(exact_db, ids, expression(tokens, 'OR', is_phrase), depth)
                    exact_and = retrieve(exact_db, ids, expression(tokens, 'AND', is_phrase), depth)
                    exact_phrase = retrieve(exact_db, ids, expression(tokens, phrase=True), depth)
                    fused.append(fuse(stem_rankings[i], exact_or, policy['ranking']['rrfK'], row_order)[:100])
                    tiered.append(tiers(stem_rankings[i], exact_phrase, exact_and, row_order)[:100])
                fused_timing = {'exactLaneIndex': timing, 'exactLaneAnalysis': analysis_timing['exact'],
                                'jointAdditionalExactQueriesAndFusionSeconds': time.perf_counter() - query_started,
                                'requiresStemLane': True}
                for method, rankings in [('prototype-exact-stem-rrf', fused), ('prototype-exact-tier', tiered)]:
                    level['methods'][method] = report_method(method, queries, rankings, fused_timing)
            if args.stopwords or args.simplemma:
                level['supplements'] = {}
            if args.stopwords:
                db, ids, _ = indexes['prototype']
                records = {'prototype-stem-or-no-stop': level['methods']['prototype-stem-or']}
                for method in ('prototype-query-stop-or', 'prototype-query-stop-msm60'):
                    query_started, rankings = time.perf_counter(), []
                    for query, tokens in zip(queries, filtered_queries, strict=True):
                        phrase = quoted(query['text'])
                        coverage = (math.ceil(0.6 * len(set(tokens))) if method.endswith('msm60') and not phrase else None)
                        rankings.append(retrieve(db, ids, expression(tokens, phrase=phrase), 100, coverage))
                    records[method] = report_method(method, queries, rankings,
                        {'querySeconds': time.perf_counter() - query_started, 'reusesPrimaryStemIndex': True})
                level['supplements']['stopwords'] = supplemental_results(
                    records, level['methods']['prototype-stem-or'], policy,
                    policy['seed'] + 'stopwords' + language + str(size), stopword_profile)
            if args.simplemma and size == 10000 and lemma_path:
                lemma_index, lemma_ids, lemma_timing = index(args, language, 'lemma', size,
                    documents, lemma_path, {'data': manifest['files'], 'protocol': sha(PROTOCOL)})
                with contextlib.closing(sqlite3.connect(lemma_index)) as lemma_db:
                    query_started, rankings = time.perf_counter(), []
                    for query, tokens in zip(queries, lemma_queries, strict=True):
                        rankings.append(retrieve(lemma_db, lemma_ids,
                            expression(tokens, phrase=quoted(query['text'])), depth))
                    query_elapsed = time.perf_counter() - query_started
                native = level['methods']['prototype-stem-or']
                fused = [fuse(stem, lemma, policy['ranking']['rrfK'], row_order)[:100]
                         for stem, lemma in zip(stem_rankings, rankings, strict=True)]
                records = {'prototype-stem-or-no-lemma': native,
                    'simplemma-lemma-or': report_method('simplemma-lemma-or', queries, rankings,
                        {**lemma_timing, 'querySeconds': query_elapsed}),
                    'prototype-stem-lemma-rrf': report_method('prototype-stem-lemma-rrf', queries, fused,
                        {'reusesStemAndLemmaRankings': True, 'fusionInputDepth': depth})}
                level['supplements']['lemmatization'] = supplemental_results(
                    records, native, policy,
                    policy['seed'] + 'lemma' + language + str(size), lemma_profile)
            if not args.supplemental_only:
                baseline_rows = {row['id']: row['metrics'] for row in level['methods']['current-porter-or']['perQuery']
                                 if row['split'] == 'test' and row['subset'] == 'relevant'}
                for method, record in level['methods'].items():
                    paired = {row['id']: row['metrics'] for row in record['perQuery']
                              if row['split'] == 'test' and row['subset'] == 'relevant'}
                    record['pairedTestDifferenceVsBaseline'] = paired_interval(
                        paired, baseline_rows, policy['seed'] + language + str(size) + method,
                        policy['uncertainty']['pairedBootstrapReplicates'])
            level['wallSeconds'] = time.perf_counter() - started
            result['levels'][str(size)] = level
        finally:
            for db, _, _ in indexes.values():
                db.close()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--languages', nargs='+')
    parser.add_argument('--sizes', nargs='+', type=int, default=[10000, 100000])
    parser.add_argument('--stopwords', type=Path)
    parser.add_argument('--simplemma', action='store_true')
    parser.add_argument('--supplemental-only', action='store_true')
    for option in ('icu4x', 'charabia-full', 'charabia-lean', 'prototype'):
        parser.add_argument('--' + option, type=Path, required=option == 'prototype')
    args = parser.parse_args()
    if not args.supplemental_only and any(getattr(args, name) is None for name in ('icu4x', 'charabia_full', 'charabia_lean')):
        parser.error('Primary evaluation requires --icu4x, --charabia-full and --charabia-lean')
    if args.supplemental_only and not (args.stopwords or args.simplemma):
        raise ValueError('Supplemental-only mode requires an explicitly enabled supplement')
    policy = json.loads((HERE / 'policy.json').read_text())
    amendment = json.loads(AMENDMENT.read_text())
    args.languages = args.languages or [language for language in policy['languages'] if language not in amendment['excludedPrimaryLanguages']]
    if set(args.languages) & set(amendment['excludedPrimaryLanguages']):
        raise ValueError('Requested language excluded from primary benchmark by integrity amendment')
    args.seed = policy['seed']
    if not set(args.languages) <= set(policy['languages']) or not set(args.sizes) <= set(policy['corpusSizes']):
        raise ValueError('Language or size outside frozen policy')
    args.cache_dir = args.cache_dir.resolve()
    args.data_dir = args.data_dir.resolve()
    for path in (args.cache_dir, args.data_dir):
        if path.is_relative_to(HERE.parents[2]):
            raise ValueError('Corpus and analyzer caches must remain outside Git')
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    report = {'policy': policy, 'policySHA256': sha(HERE / 'policy.json'),
              'integrityAmendment': amendment, 'amendmentSHA256': sha(AMENDMENT),
              'sourceHashes': {path.name: sha(path) for path in sorted([*HERE.glob('*.py'), HERE / 'match-count.c'])},
              'sqliteVersion': sqlite3.sqlite_version, 'requestedLanguages': args.languages,
              'requestedSizes': args.sizes, 'languages': {}, 'complete': False,
              'supplementalRequested': {'stopwords': bool(args.stopwords), 'simplemma': args.simplemma},
              'supplementalOnly': args.supplemental_only,
              'supplementalPolicySHA256': sha(PROTOCOL) if args.stopwords or args.simplemma else None}
    started = time.perf_counter()
    for language in args.languages:
        report['languages'][language] = evaluate_language(args, policy, language)
        report['complete'] = len(report['languages']) == len(args.languages)
        report['wallSeconds'] = time.perf_counter() - started
        args.output.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(args.output, report)


if __name__ == '__main__':
    main()

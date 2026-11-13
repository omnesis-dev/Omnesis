#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Compare lexical analysis on a frozen public, human-labeled retrieval subset.

Downloaded passages and queries remain outside Git. Reports contain only metrics,
public row identifiers, hashes, configuration, and timing summaries.
"""

import argparse
import collections
import contextlib
import functools
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import time
import unicodedata

from run import Snowball, encode, fold_latin, probe, words

HERE = Path(__file__).resolve().parent
REVISION = "6e98c995a5be54ef41d3a016a2f30314dd625619"
ALL_LANGUAGES = "ar bn de en es fa fi fr hi id ja ko ru sw te th yo zh".split()
ISO3 = {"ar": "ara", "bn": "ben", "de": "deu", "en": "eng", "es": "spa",
        "fa": "pes", "fi": "fin", "fr": "fra", "hi": "hin", "id": "ind",
        "ja": "jpn", "ko": "kor", "ru": "rus", "sw": "swa", "te": "tel",
        "th": "tha", "yo": "yor", "zh": "cmn"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_data(root):
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest["revision"] != REVISION or manifest["dataset"] != "hotchpotch/NanoMIRACL":
        raise ValueError("Unexpected public dataset revision")
    for record in manifest["files"]:
        relative = Path(record["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unsafe manifest path")
        if digest(root / relative) != record["sha256"]:
            raise ValueError(f"Dataset checksum mismatch: {relative}")
    return manifest


def metrics(ranking, relevant):
    hits = [index + 1 for index, docid in enumerate(ranking) if docid in relevant]
    dcg = sum(1.0 / math.log2(rank + 1) for rank in hits if rank <= 10)
    ideal = sum(1.0 / math.log2(rank + 1) for rank in range(1, min(10, len(relevant)) + 1))
    return {"nDCG@10": dcg / ideal if ideal else 0.0,
            "Recall@100": sum(rank <= 100 for rank in hits) / len(relevant),
            "MRR@10": 1.0 / hits[0] if hits and hits[0] <= 10 else 0.0}


def average(rows):
    return {key: sum(row[key] for row in rows) / len(rows) for key in rows[0]} if rows else {}


def reciprocal_rank_fusion(rankings, k=60, limit=100):
    scores = collections.defaultdict(float)
    for ranking in rankings:
        for rank, docid in enumerate(ranking, 1):
            scores[docid] += 1.0 / (k + rank)
    return sorted(scores, key=lambda docid: (-scores[docid], hashlib.sha256(docid.encode()).hexdigest()))[:limit]


def expression(groups):
    return " OR ".join('"' + " ".join(map(encode, group)) + '"' for group in groups if group)


def analyzed_expression(groups, quoted, query_mode):
    if query_mode == "analyzed-or" and not quoted:
        groups = [[token] for group in groups for token in group]
    return expression(groups)


def baseline_expression(query):
    query = query.strip()
    if len(query) > 1 and query.startswith('"') and query.endswith('"'):
        return query
    return " OR ".join('"' + word + '"' for word in words(query))


def capability_route(language_results):
    choices = {language: ("icu+snowball-configured" if language in {"zh", "ja"}
                          else "charabia-lean+snowball-configured")
               for language in language_results}
    selected = {language: {"method": choices[language],
                           **{metric: result["methods"][choices[language]][metric]
                              for metric in ("nDCG@10", "Recall@100", "MRR@10")}}
                for language, result in language_results.items()}
    return {"policy": {"zh": "icu-snowball", "ja": "icu-snowball", "default": "lean-snowball"},
            "status": "post-result exploratory capability policy; requires held-out confirmation",
            "routing": "configured monolingual benchmark split language, not automatic or mixed-language routing",
            "rationale": "lean build omits Chinese/Japanese dictionaries; use ICU segmentation for those missing capabilities",
            "macro": average([{metric: row[metric] for metric in ("nDCG@10", "Recall@100", "MRR@10")}
                              for row in selected.values()]),
            "languages": selected}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--charabia-full", type=Path, required=True)
    parser.add_argument("--charabia-lean", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--languages", nargs="+", choices=ALL_LANGUAGES, default=ALL_LANGUAGES)
    parser.add_argument("--max-queries", type=int)
    parser.add_argument("--query-mode", choices=["phrase-groups", "analyzed-or"], default="phrase-groups")
    parser.add_argument("--icu4x", type=Path, help="Use a portable ICU4X dictionary-mode probe instead of Node Intl")
    args = parser.parse_args()
    import pyarrow
    import pyarrow.parquet as parquet

    manifest = validate_data(args.data_dir)
    snowball = Snowball("python")

    @functools.lru_cache(maxsize=500_000)
    def stem(token, language):
        return snowball.stem(token, language)

    binaries = {"full": args.charabia_full.resolve(), "lean": args.charabia_lean.resolve()}
    methods = ["current-porter", "icu+snowball-configured", "charabia-full+snowball-configured",
               "charabia-lean+snowball-configured", "lean+icu-rrf", "current+lean+icu-rrf"]
    report = {
        "dataset": manifest["dataset"], "revision": REVISION,
        "dataFiles": manifest["files"],
        "configuration": {
            "requestedLanguages": args.languages,
            "corpusLanguage": "known benchmark split language, not detected",
            "queryLanguage": "known benchmark split language, not detected",
            "candidateNormalization": "NFKC before analysis; combining marks preserved in query groups",
            "candidateQueryMode": args.query_mode,
            "icuEngine": "icu4x-dictionary" if args.icu4x else "node-intl",
            "querySemantics": ("OR original query words; each word's analyzed segments form an FTS5 phrase"
                               if args.query_mode == "phrase-groups" else
                               "OR individual analyzed tokens for unquoted queries; explicitly quoted input remains an FTS5 phrase"),
            "baseline": "raw document text; current mark-dropping query sanitizer; porter unicode61 remove_diacritics 2",
            "rrf": {"k": 60, "inputDepth": 100, "outputDepth": 100},
            "termEncoding": "UTF8 hex prevents SQLite from altering analyzed token identity",
            "scope": "full downloaded corpus per language; does not use forced-positive bm25 candidate tables",
            "judgments": "positive-only retained qrels; unjudged rows are not confirmed negatives",
            "timing": "analysis wall time includes process startup; SQLite index and SQL query time reported separately",
            "maxQueries": args.max_queries,
        },
        "versions": {"sqlite": sqlite3.sqlite_version, "snowball": snowball.version,
                     "pyarrow": pyarrow.__version__},
        "sourceHashes": {"publicBenchmark": digest(Path(__file__)), "sharedHelpers": digest(HERE / "run.py"),
                         "icuProbe": digest(HERE / "icu-probe.mjs"),
                         **({"icu4xBinary": digest(args.icu4x)} if args.icu4x else {}),
                         **{name + "Binary": digest(binary) for name, binary in binaries.items()}},
        "languages": {},
    }
    started_all = time.perf_counter()
    try:
        for language in args.languages:
            documents = parquet.read_table(args.data_dir / "corpus" / f"{language}-00000-of-00001.parquet").to_pylist()
            documents.sort(key=lambda row: hashlib.sha256(row["_id"].encode()).hexdigest())
            queries = parquet.read_table(args.data_dir / "queries" / f"{language}-00000-of-00001.parquet").to_pylist()
            if args.max_queries is not None:
                queries = queries[:args.max_queries]
            rows = parquet.read_table(args.data_dir / "qrels" / f"{language}-00000-of-00001.parquet").to_pylist()
            judgments = collections.defaultdict(set)
            for row in rows:
                judgments[row["query-id"]].add(row["corpus-id"])
            docids = {row["_id"] for row in documents}
            if len(docids) != len(documents) or len({row["_id"] for row in queries}) != len(queries):
                raise ValueError("Duplicate document or query IDs")
            if any(not judgments[q["_id"]] or not judgments[q["_id"]] <= docids for q in queries):
                raise ValueError("Query has no valid in-corpus positive")
            grouped_queries = []
            quoted_queries = []
            for query in queries:
                normalized = unicodedata.normalize("NFKC", query["text"].strip())
                quoted = len(normalized) > 1 and normalized.startswith('"') and normalized.endswith('"')
                grouped_queries.append([normalized[1:-1]] if quoted else words(normalized, marks=True))
                quoted_queries.append(quoted)
            unique_groups = sorted({group for groups in grouped_queries for group in groups})
            language_result = {"documents": len(documents), "queries": len(queries),
                               "retainedPositiveJudgments": sum(len(judgments[q["_id"]]) for q in queries),
                               "quotedQueries": sum(quoted_queries),
                               "singleOriginalGroupQueries": sum(len(groups) == 1 for groups in grouped_queries),
                               "methods": {}}
            rankings = {}

            for method in methods[:4]:
                family = "icu" if method.startswith("icu") else "full" if "full" in method else "lean"
                timings = {"documentAnalysisSeconds": 0.0, "queryGroupAnalysisSeconds": 0.0}
                doc_records = group_records = None
                if method != "current-porter":
                    command = ([str(args.icu4x.resolve())] if args.icu4x else ["node", str(HERE / "icu-probe.mjs")]) if family == "icu" else [str(binaries[family])]
                    hint = language if family == "icu" else ISO3[language]
                    request_options = {"mode": "dictionary"} if family == "icu" and args.icu4x else {}
                    requests = [{"text": unicodedata.normalize("NFKC", row["text"]), "language": hint, **request_options} for row in documents]
                    doc_records, timings["documentAnalysisSeconds"] = probe(command, requests)
                    group_records_raw, timings["queryGroupAnalysisSeconds"] = probe(command, [
                        {"text": group, "language": hint, **request_options} for group in unique_groups])
                    group_records = dict(zip(unique_groups, group_records_raw))
                    if family == "icu" and doc_records:
                        report["versions"]["icuEngine"] = {key: doc_records[0][key] for key in
                            ("engine", "version", "icu", "mode", "normalization") if key in doc_records[0]}
                    errors = [record["error"] for record in [*doc_records, *group_records_raw] if "error" in record]
                    if errors:
                        raise RuntimeError(f"Analyzer errors for {language}/{method}: {len(errors)}")

                def tokens(record):
                    transformed = [stem(item["text"], language) for item in record["tokens"]]
                    return [fold_latin(token) for token in transformed] if family == "icu" else transformed

                with contextlib.closing(sqlite3.connect(":memory:")) as db:
                    tokenizer = "porter unicode61 remove_diacritics 2" if method == "current-porter" else "unicode61"
                    db.execute(f"CREATE VIRTUAL TABLE f USING fts5(content, tokenize='{tokenizer}')")
                    index_started = time.perf_counter()
                    for rowid, document in enumerate(documents, 1):
                        content = document["text"] if doc_records is None else " ".join(map(encode, tokens(doc_records[rowid - 1])))
                        db.execute("INSERT INTO f(rowid,content) VALUES (?,?)", (rowid, content))
                    db.commit()
                    timings["sqliteIndexAndTokenTransformSeconds"] = time.perf_counter() - index_started
                    expression_started = time.perf_counter()
                    query_stats = {"originalGroups": sum(map(len, grouped_queries))}
                    if group_records is None:
                        expressions = [baseline_expression(query["text"]) for query in queries]
                    else:
                        analyzed_queries = [[tokens(group_records[group]) for group in groups] for groups in grouped_queries]
                        expressions = [analyzed_expression(groups, quoted, args.query_mode)
                                       for groups, quoted in zip(analyzed_queries, quoted_queries)]
                        query_stats["analyzedTokens"] = sum(len(group) for groups in analyzed_queries for group in groups)
                        query_stats["compiledClauses"] = sum(
                            int(any(groups)) if quoted else
                            sum(map(len, groups)) if args.query_mode == "analyzed-or" else
                            sum(bool(group) for group in groups)
                            for groups, quoted in zip(analyzed_queries, quoted_queries))
                    timings["queryExpressionAndTokenTransformSeconds"] = time.perf_counter() - expression_started
                    query_started = time.perf_counter()
                    method_rankings = []
                    malformed_queries = 0
                    for query_expression in expressions:
                        try:
                            found = db.execute("SELECT rowid FROM f WHERE f MATCH ? ORDER BY bm25(f), rowid LIMIT 100",
                                               (query_expression,)).fetchall() if query_expression else []
                        except sqlite3.OperationalError as error:
                            if "fts5: syntax error" not in str(error):
                                raise
                            found = []
                            malformed_queries += 1
                        method_rankings.append([documents[rowid - 1]["_id"] for (rowid,) in found])
                    timings["sqliteQuerySeconds"] = time.perf_counter() - query_started
                    timings["sqliteIndexBytes"] = db.execute("PRAGMA page_count").fetchone()[0] * db.execute("PRAGMA page_size").fetchone()[0]
                rankings[method] = method_rankings
                individual = [metrics(ranking, judgments[query["_id"]]) for query, ranking in zip(queries, method_rankings)]
                query_mode = "unchanged-current" if method == "current-porter" else args.query_mode
                language_result["methods"][method] = {**average(individual), "timing": timings,
                                                       "malformedQueries": malformed_queries,
                                                       "queryMode": query_mode, "queryStatistics": query_stats,
                                                       "perQuery": {query["_id"]: score for query, score in zip(queries, individual)}}
                print(json.dumps({"language": language, "method": method, "queryMode": query_mode, **average(individual)}), flush=True)

            for method, sources in [("lean+icu-rrf", methods[1:2] + methods[3:4]),
                                    ("current+lean+icu-rrf", methods[0:2] + methods[3:4])]:
                fusion_started = time.perf_counter()
                fused = [reciprocal_rank_fusion([rankings[source][i] for source in sources]) for i in range(len(queries))]
                individual = [metrics(ranking, judgments[query["_id"]]) for query, ranking in zip(queries, fused)]
                language_result["methods"][method] = {**average(individual), "sources": sources,
                    "queryMode": "fusion:" + args.query_mode,
                    "timing": {"fusionSeconds": time.perf_counter() - fusion_started},
                    "perQuery": {query["_id"]: score for query, score in zip(queries, individual)}}
                print(json.dumps({"language": language, "method": method, "queryMode": "fusion:" + args.query_mode, **average(individual)}), flush=True)
            report["languages"][language] = language_result
            report["complete"] = len(report["languages"]) == len(args.languages)
            report["exploratoryCapabilityRoute"] = capability_route(report["languages"])
            report["elapsedSeconds"] = time.perf_counter() - started_all
            report["macro"] = {method: average([{key: result["methods"][method][key] for key in ("nDCG@10", "Recall@100", "MRR@10")}
                                                for result in report["languages"].values()]) for method in methods}
            report["unsupportedSnowballAlgorithms"] = sorted(snowball.unsupported)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            pending = args.output.with_suffix(args.output.suffix + ".pending")
            pending.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            pending.replace(args.output)
    finally:
        snowball.close()
    print(json.dumps({"completedLanguages": len(report["languages"]), "queries": sum(row["queries"] for row in report["languages"].values()),
                      "macro": report["macro"], "elapsedSeconds": report["elapsedSeconds"]}, indent=2))


if __name__ == "__main__":
    main()

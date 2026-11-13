# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Contrastive retrieval diagnostics in private, synthetic in-memory FTS5 stores.

This is an analysis experiment, not the production gateway pipeline. Encoded
analyzed tokens prevent unicode61 from reinterpreting another analyzer's output.
Known-language stemming is explicitly labeled as an oracle upper bound.
"""

import argparse
import collections
import ctypes
import ctypes.util
import hashlib
import json
import pathlib
import re
import sqlite3
import subprocess
import time
import unicodedata
import importlib.metadata

HERE = pathlib.Path(__file__).resolve().parent
LANGUAGES = {
    "ar": "arabic", "de": "german", "el": "greek", "en": "english",
    "es": "spanish", "fi": "finnish", "fr": "french", "hi": "hindi",
    "it": "italian", "pt": "portuguese", "ru": "russian", "tr": "turkish",
    "nl": "dutch", "sv": "swedish", "da": "danish", "nb": "norwegian",
    "hu": "hungarian", "id": "indonesian", "ro": "romanian", "cs": "czech",
    "pl": "polish", "fa": "persian",
}
ISO3 = {
    "ar": "ara", "de": "deu", "el": "ell", "en": "eng", "es": "spa",
    "fi": "fin", "fr": "fra", "hi": "hin", "it": "ita", "pt": "por",
    "ru": "rus", "tr": "tur", "nl": "nld", "sv": "swe", "da": "dan",
    "nb": "nob", "hu": "hun", "id": "ind", "ro": "ron", "cs": "ces",
    "pl": "pol", "ko": "kor", "zh": "cmn", "ja": "jpn", "th": "tha",
    "he": "heb", "fa": "pes", "vi": "vie", "uk": "ukr", "km": "khm",
}
DETECTED = {value: key for key, value in ISO3.items()}


class Snowball:
    def __init__(self, backend):
        self.backend = backend
        self.handles = {}
        self.unsupported = set()
        if backend == "python":
            import snowballstemmer
            self.module = snowballstemmer
            self.version = importlib.metadata.version("snowballstemmer")
            return
        library = ctypes.util.find_library("stemmer")
        if not library:
            raise RuntimeError("Install libstemmer to run the Snowball comparisons")
        self.lib = ctypes.CDLL(library)
        self.lib.sb_stemmer_new.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        self.lib.sb_stemmer_new.restype = ctypes.c_void_p
        self.lib.sb_stemmer_stem.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        self.lib.sb_stemmer_stem.restype = ctypes.c_void_p
        self.lib.sb_stemmer_length.argtypes = [ctypes.c_void_p]
        self.lib.sb_stemmer_length.restype = ctypes.c_int
        self.lib.sb_stemmer_delete.argtypes = [ctypes.c_void_p]
        self.version = "system-libstemmer"

    def stem(self, word, language):
        algorithm = LANGUAGES.get(language)
        if not algorithm:
            return word
        if self.backend == "python":
            if algorithm not in self.module.algorithms():
                self.unsupported.add(algorithm)
                return word
            if algorithm not in self.handles:
                self.handles[algorithm] = self.module.stemmer(algorithm)
            return self.handles[algorithm].stemWord(unicodedata.normalize("NFC", word))
        if algorithm not in self.handles:
            handle = self.lib.sb_stemmer_new(algorithm.encode(), b"UTF_8")
            if not handle:
                self.unsupported.add(algorithm)
                return word
            self.handles[algorithm] = handle
        data = unicodedata.normalize("NFC", word).encode()
        handle = self.handles[algorithm]
        result = self.lib.sb_stemmer_stem(handle, data, len(data))
        if not result:
            raise RuntimeError("Snowball failed")
        return ctypes.string_at(result, self.lib.sb_stemmer_length(handle)).decode()

    def close(self):
        if self.backend == "python":
            return
        for handle in self.handles.values():
            self.lib.sb_stemmer_delete(handle)


def words(text, marks=False):
    # Mirror the gateway's plain-text sanitizer; combining marks are deliberately
    # excluded here so its existing Unicode behavior remains visible.
    clean = "".join(c if c.isalnum() or c == "_" or c.isspace() or
                    (marks and unicodedata.category(c).startswith("M")) else " " for c in text)
    return [w for w in clean.split() if w.upper() not in {"AND", "OR", "NOT", "NEAR"}]


def probe(command, requests):
    started = time.perf_counter()
    completed = subprocess.run(command, input="".join(json.dumps(r, ensure_ascii=False) + "\n" for r in requests),
                               text=True, capture_output=True, check=True)
    output = [json.loads(line) for line in completed.stdout.splitlines()]
    if len(output) != len(requests):
        raise RuntimeError(f"Probe returned {len(output)} responses for {len(requests)} inputs")
    return output, time.perf_counter() - started


def encode(token):
    return "t" + token.encode().hex()


def fold_latin(token):
    # Preserve meaningful marks in Indic and other scripts. Fold Latin accents
    # as the current index does; Greek/Arabic choices remain analyzer-owned.
    if any("LATIN" in unicodedata.name(c, "") for c in token):
        return "".join(c for c in unicodedata.normalize("NFD", token) if unicodedata.category(c) != "Mn")
    return token


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--charabia", type=pathlib.Path)
    parser.add_argument("--analyzer-label", default="charabia-full-0.10.0")
    parser.add_argument("--snowball", choices=["system", "python"], default="system")
    parser.add_argument("--lucene", type=pathlib.Path)
    parser.add_argument("--simplemma", action="store_true")
    parser.add_argument("--query-mode", choices=["grouped", "analyzed-or"], default="grouped")
    parser.add_argument("--icu4x", type=pathlib.Path)
    parser.add_argument("--icu4x-mode", choices=["auto", "dictionary"], default="dictionary")
    parser.add_argument("--detector-cache", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    fixture_bytes = (HERE / "cases.json").read_bytes()
    cases = json.loads(fixture_bytes)
    # Canonical pretty JSON keeps the experiment identity stable under the
    # repository formatter. Record the exact file bytes separately as well.
    raw = (json.dumps(cases, ensure_ascii=False, indent=2) + "\n").encode()
    ids = [case["id"] for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate case ids")

    # Analyze both complete text and gateway-sanitized query groups. This lets
    # us distinguish analyzer failures from query-sanitizer failures.
    texts = sorted({text for case in cases for text in [case["query"], *words(case["query"]),
                   *words(case["query"], marks=True), *case["positive"], *case["negative"]]})
    requests = [{"text": text} for text in texts]
    icu_command = [str(args.icu4x)] if args.icu4x else ["node", str(HERE / "icu-probe.mjs")]
    icu_requests = [{**request, "mode": args.icu4x_mode} for request in requests] if args.icu4x else requests
    icu, icu_seconds = probe(icu_command, icu_requests)
    caches = {"icu": dict(zip(texts, icu))}
    detector_provenance = {"implementation": "whatlang-0.18.0"}
    probe_times = {"icu_seconds_including_process_start": icu_seconds}
    variants = [(text, language) for text in texts for language in ISO3]
    icu_hinted, seconds = probe(icu_command, [
        {"text": unicodedata.normalize("NFKC", text), "language": language, "mode": args.icu4x_mode}
        for text, language in variants])
    caches["icu-hinted"] = dict(zip((text + "\0" + language for text, language in variants), icu_hinted))
    probe_times["icu_all_hinted_variants_seconds_including_process_start"] = seconds
    if args.charabia:
        charabia, seconds = probe([str(args.charabia)], requests)
        caches["charabia"] = dict(zip(texts, charabia))
        probe_times["charabia_seconds_including_process_start"] = seconds
        if args.detector_cache:
            detector_bytes = args.detector_cache.read_bytes()
            alternative = json.loads(detector_bytes)
            detector_provenance = {"cache_sha256": hashlib.sha256(detector_bytes).hexdigest(),
                "model_sha256": alternative.get("model_sha256"),
                "implementation": "official-reference-cache" if "official_cache" in alternative else "external-cache"}
            if alternative.get("fixture_sha256", hashlib.sha256(raw).hexdigest()) != hashlib.sha256(raw).hexdigest():
                raise ValueError("Detector cache belongs to different fixtures")
            detector_cache = alternative.get("official_cache", alternative.get("cache", alternative))
            documents = {text for case in cases for text in case["positive"] + case["negative"]}
            if not documents.issubset(detector_cache):
                raise ValueError("Detector cache is missing fixture documents")
            for text, output in caches["charabia"].items():
                if text in detector_cache:
                    detection = dict(detector_cache[text]["detection"])
                    detection["language"] = {"no": "nob"}.get(detection["language"],
                        ISO3.get(detection["language"], detection["language"]))
                    output["detection"] = detection
        normalized, seconds = probe([str(args.charabia)], [
            {"text": unicodedata.normalize("NFKC", text)} for text in texts])
        caches["charabia-nfkc"] = dict(zip(texts, normalized))
        probe_times["charabia_nfkc_seconds_including_process_start"] = seconds

        # Every input gets every supported analyzer variant. Fixture language
        # labels are only used by the explicitly named oracle methods below.
        hinted, seconds = probe([str(args.charabia)], [
            {"text": unicodedata.normalize("NFKC", text), "language": ISO3[language]}
            for text, language in variants])
        caches["hinted"] = dict(zip((text + "\0" + language for text, language in variants), hinted))
        probe_times["all_hinted_variants_seconds_including_process_start"] = seconds

    snowball = Snowball(args.snowball)
    lemmatizer = None
    if args.simplemma:
        from lemma import Lemmatizer
        lemmatizer = Lemmatizer()
    methods = ["current", "current-mark-safe", "hangul-prefix", "all-prefix", "trigram", "icu", "icu+snowball-oracle"]
    if args.charabia:
        methods += ["charabia", "charabia-token-or", "charabia-safe", "charabia-safe-nfkc", "charabia+snowball-detected",
                    "charabia+snowball-oracle", "charabia-hinted-oracle", "charabia-hinted+snowball-oracle",
                    "charabia-doc-detect-fanout", "icu-doc-detect-fanout"]
    if args.simplemma:
        if not args.charabia:
            raise ValueError("--simplemma needs --charabia for the shared document language detector")
        methods += ["icu-simplemma-oracle", "icu-simplemma-doc-detect-fanout"]
    results = []
    errors = []

    def tokens(method, text, language):
        family = "charabia" if method.startswith("charabia") else "icu"
        hinted = method.startswith("charabia-hinted")
        if hinted:
            records = caches["hinted"][text + "\0" + language]
        elif method in {"icu+snowball-oracle", "icu-simplemma-oracle"}:
            records = caches["icu-hinted"][text + "\0" + language]
        else:
            records = caches["charabia-nfkc" if method.endswith("nfkc") else family][text]
        output = []
        for item in records["tokens"]:
            token = item if isinstance(item, str) else item["text"]
            if "+snowball" in method:
                selected = language if method.endswith("oracle") else DETECTED.get(item.get("language"))
                token = snowball.stem(token, selected)
            if "simplemma" in method:
                token = lemmatizer.lemma(token, language)
            output.append(fold_latin(token) if family == "icu" else token)
        return output

    def fanout_tokens(family, text, language, lemma=False):
        records = caches["hinted" if family == "charabia" else "icu-hinted"][text + "\0" + language]
        transformed = [lemmatizer.lemma(item["text"], language) if lemma else snowball.stem(item["text"], language)
                       for item in records["tokens"]]
        return [fold_latin(t) for t in transformed] if family == "icu" else transformed

    for method in methods:
        for case in cases:
            db = sqlite3.connect(":memory:")
            analyzed = method.startswith(("icu", "charabia"))
            tokenizer = "unicode61" if analyzed else "trigram" if method == "trigram" else "porter unicode61 remove_diacritics 2"
            db.execute(f"CREATE VIRTUAL TABLE f USING fts5(content, tokenize='{tokenizer}')")
            docs = case["positive"] + case["negative"]
            tie_keys = {rowid: hashlib.sha256((case["id"] + "\0" + text).encode()).hexdigest()
                        for rowid, text in enumerate(docs, 1)}
            db.create_function("tie_key", 1, lambda rowid: tie_keys[rowid])
            started = time.perf_counter()
            for rowid, text in enumerate(docs, 1):
                if method.endswith("doc-detect-fanout"):
                    selected = DETECTED.get(caches["charabia"][text].get("detection", {}).get("language"), "en")
                    family = "charabia" if method.startswith("charabia") else "icu"
                    content = " ".join(encode(selected + "|" + t) for t in fanout_tokens(family, text, selected, "simplemma" in method))
                else:
                    content = " ".join(map(encode, tokens(method, text, case["language"]))) if analyzed else text
                db.execute("INSERT INTO f(rowid,content) VALUES (?,?)", (rowid, content))
            query = case["query"].strip()
            quoted = len(query) > 1 and query.startswith('"') and query.endswith('"')
            if analyzed:
                # Keep analyzer pieces of each original word together as a
                # phrase, matching FTS5's behavior with custom tokenizers.
                safe = "safe" in method or "hinted" in method or "fanout" in method or "simplemma" in method
                if method.endswith("doc-detect-fanout"):
                    family = "charabia" if method.startswith("charabia") else "icu"
                    groups = [[language + "|" + t for t in fanout_tokens(family, word, language, "simplemma" in method)]
                              for language in ISO3 for word in ([query] if quoted else words(query, marks=True))]
                else:
                    groups = [tokens(method, query, case["language"])] if quoted else [tokens(method, w, case["language"]) for w in words(query, marks=safe)]
                if (method == "charabia-token-or" or args.query_mode == "analyzed-or") and not quoted:
                    groups = [[t] for group in groups for t in group]
                expression = " OR ".join('"' + " ".join(map(encode, group)) + '"' for group in groups if group)
            elif method == "trigram":
                parts = [query.strip('"')] if quoted else words(query)
                expression = " OR ".join('"' + part.replace('"', '""') + '"' for part in parts)
            elif quoted:
                expression = query
            else:
                expression = " OR ".join('"' + word + '"' + ("*" if method == "all-prefix" or
                    (method == "hangul-prefix" and any("HANGUL" in unicodedata.name(c, "") for c in word)) else "") for word in words(query, marks=method == "current-mark-safe"))
            try:
                matches = [r[0] for r in db.execute("SELECT rowid FROM f WHERE f MATCH ? ORDER BY bm25(f),tie_key(rowid)", (expression,))] if expression else []
            except sqlite3.OperationalError as exc:
                errors.append({"method": method, "case": case["id"], "error": str(exc)})
                matches = []
            elapsed = time.perf_counter() - started
            positive_ids = set(range(1, len(case["positive"]) + 1))
            found = positive_ids.intersection(matches)
            false = [r for r in matches if r not in positive_ids]
            first = next((i for i, rowid in enumerate(matches, 1) if rowid in positive_ids), None)
            results.append({"method": method, "id": case["id"], "language": case["language"], "category": case["category"],
                "hit": bool(found), "clean": len(found) == len(positive_ids) and not false,
                "false_positives": len(false), "recall": len(found) / len(positive_ids),
                "reciprocal_rank": 1 / first if first else 0, "matches": matches,
                "expression": expression, "diagnostic_seconds_excluding_cached_segmentation": elapsed})
            db.close()
    snowball.close()

    if args.lucene:
        if not args.charabia:
            raise ValueError("--lucene needs --charabia for the shared document language detector")
        from lucene_reference import evaluate
        reference = evaluate(cases, caches["charabia"], DETECTED, args.lucene, args.query_mode)
        results.extend(reference)
        methods.extend(dict.fromkeys(row["method"] for row in reference))

    def aggregate(rows):
        return {"cases": len(rows), "hits": sum(r["hit"] for r in rows), "clean": sum(r["clean"] for r in rows),
                "false_positives": sum(r["false_positives"] for r in rows),
                "top1": sum(r["reciprocal_rank"] == 1 for r in rows) if not rows[0].get("ranking_not_evaluated") else None,
                "mrr": round(sum(r["reciprocal_rank"] for r in rows) / len(rows), 4) if not rows[0].get("ranking_not_evaluated") else None}

    # Candidate union measures recall/precision only: different analyzers' BM25
    # values are not comparable, so no arbitrary combined relevance score.
    if args.charabia:
        by_key = {(r["method"], r["id"]): r for r in results}
        unions = {
            "icu+charabia-fanout-union": ["icu-doc-detect-fanout", "charabia-doc-detect-fanout"],
            "current+fanout-union": ["current", "icu-doc-detect-fanout", "charabia-doc-detect-fanout"],
        }
        if args.lucene:
            unions["lucene+icu+charabia-fanout-union"] = ["lucene-nfkc-doc-detect-fanout", "icu-doc-detect-fanout", "charabia-doc-detect-fanout"]
        if args.simplemma:
            unions["simplemma+icu+charabia-fanout-union"] = ["icu-simplemma-doc-detect-fanout", "icu-doc-detect-fanout", "charabia-doc-detect-fanout"]
        for name, components in unions.items():
            methods.append(name)
            for case in cases:
                rows = [by_key[(component, case["id"])] for component in components]
                matches = sorted({match for row in rows for match in row["matches"]})
                positive_ids = set(range(1, len(case["positive"]) + 1))
                found = positive_ids.intersection(matches)
                false = [r for r in matches if r not in positive_ids]
                results.append({"method": name, "id": case["id"], "language": case["language"],
                    "category": case["category"], "hit": bool(found), "clean": len(found) == len(positive_ids) and not false,
                    "false_positives": len(false), "recall": len(found) / len(positive_ids),
                    "reciprocal_rank": 0, "matches": matches, "ranking_not_evaluated": True})

    summary = {method: aggregate([r for r in results if r["method"] == method]) for method in methods}
    by_language = {language: {method: aggregate([r for r in results if r["method"] == method and r["language"] == language])
                    for method in methods} for language in sorted({c["language"] for c in cases})}
    report = {"fixture_sha256": hashlib.sha256(raw).hexdigest(),
              "fixture_file_sha256": hashlib.sha256(fixture_bytes).hexdigest(),
              "fixture_hash_format": "UTF-8 JSON, ensure_ascii=False, indent=2, terminal newline",
              "sqlite": sqlite3.sqlite_version,
              "analyzer_label": args.analyzer_label,
              "query_mode": args.query_mode,
              "detector": "external-cache" if args.detector_cache else "whatlang-0.18.0",
              "detector_provenance": detector_provenance,
              "simplemma": {"version": lemmatizer.version, "unsupported_languages": sorted(lemmatizer.unsupported)} if lemmatizer else None,
              "icu": icu[0].get("icu", "ICU4X " + icu[0].get("version", "unknown")),
              "icu4x_mode": args.icu4x_mode if args.icu4x else None,
              "snowball": snowball.version, "unsupported_stemmers": sorted(snowball.unsupported),
              "probe_times": probe_times, "summary": summary,
              "document_detection": {case["id"]: [caches["charabia"][text].get("detection") for text in case["positive"] + case["negative"]]
                                     for case in cases} if args.charabia else None,
              "by_language": by_language, "results": results, "errors": errors,
              "token_cache": caches,
              "limitations": ["Synthetic diagnostic set, no native-speaker review", "Known-language stemming uses fixture metadata",
                  "Contrastive per-case stores, not a representative corpus", "Precomputed token timings exclude analysis and dictionary load",
                  "Current OR query composition preserved except explicitly labeled token-or variant", "Not the full gateway pipeline"]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"summary": summary, "errors": errors, "probe_times": probe_times}, indent=2))
    if errors:
        raise SystemExit("Evaluation encountered SQL errors; inspect the report")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Evaluate frozen synthetic shared collections, lexical routing, and precision.

Local language identification is optional research infrastructure; no LLM,
embedding, remote gateway, or private corpus is accessed.
"""

import argparse
import collections
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import time

from core import (
    FIELDS, Index, aggregate, canonical, detector_text, document_units, expression,
    field_texts, fingerprint, language, query_body, query_kind, query_languages,
    rrf, score, script_spans, surface_priority, surface_tokens, validate,
    validate_analyzer_response,
)

HERE = Path(__file__).resolve().parent


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def batch_probe(command, requests, cache_dir, label):
    identity = {"command": Path(command[0]).name,
                "files": [sha256(Path(value)) for value in command if Path(value).is_file()],
                "arguments": [value for value in command[1:] if not Path(value).is_file()],
                "requests": fingerprint(requests)}
    key = fingerprint(identity)
    cached = cache_dir / (label + "-" + key + ".json") if cache_dir else None
    if cached and cached.exists():
        stored = json.loads(cached.read_text())
        if stored["identity"] != identity:
            raise ValueError("Probe cache identity mismatch")
        return stored["responses"], {"cacheHit": True, "originalProcessSeconds": stored["seconds"], "requests": len(requests)}
    started = time.perf_counter()
    process = subprocess.run(command, input="".join(json.dumps(request, ensure_ascii=False) + "\n" for request in requests),
                             text=True, capture_output=True, check=True)
    responses = [json.loads(line) for line in process.stdout.splitlines()]
    if len(responses) != len(requests) or any("error" in response for response in responses):
        raise ValueError(f"Invalid {label} response count or error response")
    seconds = time.perf_counter() - started
    if cached:
        cache_dir.mkdir(parents=True, exist_ok=True)
        pending = cached.with_suffix(".pending")
        pending.write_text(json.dumps({"identity": identity, "responses": responses, "seconds": seconds}, ensure_ascii=False))
        pending.replace(cached)
    return responses, {"cacheHit": False, "processSeconds": seconds, "requests": len(requests)}


def detections_for(fixture, selected_splits, detector, model, official, cache_dir):
    texts = set()
    for split in selected_splits:
        for document in fixture["splits"][split]["documents"]:
            texts.add(detector_text(document["body"]))
            for value in field_texts(document).values():
                for paragraph in value.splitlines():
                    texts.update(detector_text(span) for span in script_spans(paragraph))
        texts.update(detector_text(query_body(query["text"])) for query in fixture["splits"][split]["queries"])
    texts = sorted(text for text in texts if text)
    output, timing = batch_probe([str(detector), str(model)], [{"text": text} for text in texts], cache_dir, "detector")
    cache = dict(zip(texts, output))
    provenance = {"implementation": "JSONL local detector", "modelSha256": sha256(model),
                  "detectorSha256": sha256(detector), "timing": timing, "inputs": len(texts),
                  "officialParity": {"verified": False}}
    if official:
        started = time.perf_counter()
        result = subprocess.run([str(official), "predict-prob", str(model), "-", "3", "0.0"],
                                input="".join(text + "\n" for text in texts), text=True, capture_output=True, check=True)
        lines = result.stdout.splitlines()
        if len(lines) != len(texts):
            raise ValueError("Official detector returned an invalid response count")
        mismatches, reference = 0, {}
        for text, line in zip(texts, lines):
            parts = line.split()
            predictions = [{"language": parts[index].removeprefix("__label__"), "confidence": float(parts[index + 1])}
                           for index in range(0, len(parts), 2)]
            detection = predictions[0] if predictions else None
            observed = cache[text].get("detection") or {}
            mismatches += language((detection or {}).get("language")) != language(observed.get("language"))
            reference[text] = {"detection": detection, "predictions": predictions}
        cache = reference
        provenance["implementation"] = "official fastText CLI reference"
        provenance["officialSha256"] = sha256(official)
        provenance["officialParity"] = {"verified": True, "top1Disagreements": mismatches,
                                         "inputs": len(texts), "seconds": time.perf_counter() - started}
    return cache, provenance


def analyzer_cache(fixture, selected_splits, detections, enabled, config, analyzer, cache_dir):
    requests = set()
    for split in selected_splits:
        part = fixture["splits"][split]
        for policy in ("hard", "context-script"):
            for document in part["documents"]:
                for field, text, selected in document_units(document, policy, detections, enabled, config):
                    requests.update((text, selected, mode) for mode in ("exact", "stem"))
        for query in part["queries"]:
            for policy in ("hard", "context-script", "fanout"):
                for selected in query_languages(policy, query, detections, enabled, config):
                    requests.update((query_body(query["text"]), selected, mode) for mode in ("exact", "stem"))
    ordered = sorted(requests)
    responses, timing = batch_probe([str(analyzer)], [{"text": text, "language": selected, "mode": mode}
        for text, selected, mode in ordered], cache_dir, "analyzer")
    for request, response in zip(ordered, responses):
        validate_analyzer_response(request[0], response)
    fingerprints = sorted({response.get("fingerprint", "missing") for response in responses})
    return dict(zip(ordered, responses)), {"timing": timing, "fingerprints": fingerprints,
                                          "analyzerSha256": sha256(analyzer),
                                          "versions": sorted({str(response.get("version", "unspecified")) for response in responses})}


def analyzed_tokens(cache, text, selected, mode):
    return [token["text"] for token in cache[(text, selected, mode)]["tokens"] if token["text"]]


def normalized_rows(documents, policy, mode, detections, enabled, config, cache):
    rows, lanes, routing = {}, collections.defaultdict(dict), {}
    for document in documents:
        fields = {field: [] for field in FIELDS}
        language_fields = collections.defaultdict(lambda: {field: [] for field in FIELDS})
        units = document_units(document, policy, detections, enabled, config)
        selected_languages = set()
        for index, (field, text, selected) in enumerate(units):
            tokens = analyzed_tokens(cache, text, selected, mode)
            if not tokens:
                continue
            selected_languages.add(selected)
            # Keep phrase queries from jumping across independent span units.
            separator = "boundary:" + document["id"] + ":" + str(index)
            fields[field].extend([separator, *tokens])
            language_fields[selected][field].extend([separator, *tokens])
        rows[document["id"]] = fields
        routing[document["id"]] = sorted(selected_languages)
        for selected, content in language_fields.items():
            lanes[selected][document["id"]] = content
    return rows, lanes, routing


def normalized_rank(query, policy, mode, layout, indexes, detections, enabled, config, cache):
    choices = query_languages(policy, query, detections, enabled, config)
    texts = {selected: analyzed_tokens(cache, query_body(query["text"]), selected, mode) for selected in choices}
    phrase = query_kind(query["text"]) == "quoted"
    if layout == "global":
        if phrase:
            expressions = list(dict.fromkeys(expression(tokens, phrase=True) for tokens in texts.values() if tokens))
            compiled = " OR ".join(expressions)
        else:
            compiled = expression(token for tokens in texts.values() for token in tokens)
        return indexes["global"].rank(compiled, config["depth"]), choices
    rankings = [indexes[selected].rank(expression(tokens, phrase=phrase), config["depth"])
                for selected, tokens in texts.items() if selected in indexes]
    return rrf(rankings, config["rrf_k"], config["depth"]), choices


def current_expression(text):
    if query_kind(text) == "quoted":
        return text.strip()
    clean = "".join(char if char.isalnum() or char == "_" or char.isspace() else " " for char in text)
    return " OR ".join('"' + part + '"' for part in clean.split() if part.upper() not in {"AND", "OR", "NOT", "NEAR"})


def summarize(rows, query_by_id):
    return {"overall": aggregate([row["metrics"] for row in rows]),
            "byCategory": {category: aggregate([row["metrics"] for row in rows if query_by_id[row["queryId"]]["category"] == category])
                           for category in sorted({query_by_id[row["queryId"]]["category"] for row in rows})},
            "byLanguage": {code: aggregate([row["metrics"] for row in rows if query_by_id[row["queryId"]]["language"] == code])
                           for code in sorted({query_by_id[row["queryId"]]["language"] for row in rows})}}


def evaluate(part, detections, enabled, config, cache):
    documents, queries = part["documents"], part["queries"]
    document_by_id = {document["id"]: document for document in documents}
    query_by_id = {query["id"]: query for query in queries}
    raw = Index(documents, {document["id"]: field_texts(document) for document in documents}, raw=True)
    surface = Index(documents, {document["id"]: {field: surface_tokens(value) for field, value in field_texts(document).items()}
                                for document in documents})
    indexes, route_reports, build_seconds = {}, {}, {}
    started = time.perf_counter()
    try:
        for document_policy in ("hard", "context-script"):
            for mode in ("exact", "stem"):
                at = time.perf_counter()
                global_rows, lane_rows, routes = normalized_rows(documents, document_policy, mode, detections, enabled, config, cache)
                indexes[(document_policy, mode, "global")] = {"global": Index(documents, global_rows)}
                indexes[(document_policy, mode, "lanes")] = {selected: Index(documents, rows) for selected, rows in lane_rows.items()}
                route_reports[document_policy] = routes
                build_seconds[document_policy + "/" + mode] = time.perf_counter() - at
        output = {}
        variants = [("current", None, None, None, None), ("surface", None, None, None, None)]
        variants += [("normalized/" + mode + "/" + policy + "/" + layout, "normalized", mode, policy, layout)
                     for mode in ("exact", "stem") for policy in ("hard", "context-script", "fanout") for layout in ("global", "lanes")]
        variants += [("surface-priority/stem/" + policy + "/" + layout, "surface-priority", "stem", policy, layout)
                     for policy in ("hard", "context-script", "fanout") for layout in ("global", "lanes")]
        for name, strategy, mode, policy, layout in variants:
            rows, at = [], time.perf_counter()
            for query in queries:
                choices = []
                if name == "current":
                    ranking = raw.rank(current_expression(query["text"]), config["depth"])
                else:
                    kind = query_kind(query["text"])
                    surface_terms = surface_tokens(query_body(query["text"]))
                    raw_surface = surface.rank(expression(surface_terms, phrase=kind in {"literal", "quoted"}), config["depth"])
                    if name == "surface":
                        ranking = raw_surface
                    else:
                        document_policy = "hard" if policy == "hard" else "context-script"
                        normalized, choices = normalized_rank(query, policy, mode, layout,
                            indexes[(document_policy, mode, layout)], detections, enabled, config, cache)
                        if strategy == "normalized":
                            ranking = normalized
                        else:
                            complete = list(dict.fromkeys([
                                *surface.rank(expression(surface_terms, phrase=True), config["depth"]),
                                *surface.rank(expression(surface_terms, operation="AND"), config["depth"])]))
                            ranking = surface_priority(complete, raw_surface, normalized, kind, config["rrf_k"], config["depth"])
                rows.append({"queryId": query["id"], "routes": choices,
                             "ranking": ranking, "metrics": score(ranking, query, document_by_id)})
            output[name] = {**summarize(rows, query_by_id), "querySecondsExcludingAnalysis": time.perf_counter() - at,
                            "queryVariants": sum(len(row["routes"]) for row in rows), "rows": rows}
        return {"methods": output, "routing": route_reports,
                "indexBuildSecondsExcludingAnalysis": build_seconds, "retrievalWallSecondsExcludingAnalysis": time.perf_counter() - started}
    finally:
        raw.close()
        surface.close()
        for tables in indexes.values():
            for index in tables.values():
                index.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=HERE / "fixtures.json")
    parser.add_argument("--freeze-file", type=Path, default=HERE / "freeze.json")
    parser.add_argument("--analyzer", type=Path)
    parser.add_argument("--detector", type=Path)
    parser.add_argument("--detector-model", type=Path)
    parser.add_argument("--official-detector", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--split", choices=["development", "heldout", "all"], default="development")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--confidence", type=float, default=0.6)
    parser.add_argument("--minimum-letters", type=int, default=20)
    parser.add_argument("--rrf-k", type=int, default=60)
    parser.add_argument("--depth", type=int, default=100)
    args = parser.parse_args()
    fixture_bytes = args.fixtures.read_bytes()
    fixture = json.loads(fixture_bytes)
    validation = validate(fixture)
    config = {"confidence": args.confidence, "minimum_letters": args.minimum_letters,
              "rrf_k": args.rrf_k, "depth": args.depth}
    if not 0 <= args.confidence <= 1 or args.minimum_letters < 0 or args.rrf_k <= 0 or args.depth < 100:
        parser.error("Invalid routing or retrieval configuration")
    frozen = json.loads(args.freeze_file.read_text())
    if frozen["fixtureCanonicalSha256"] != fingerprint(fixture):
        parser.error("Fixture content differs from its pre-result freeze manifest")
    policy_matches = frozen["policy"] == config
    if args.split in {"heldout", "all"} and not policy_matches:
        parser.error("Heldout evaluation requires the frozen policy parameters")
    provenance = {"fixtureCanonicalSha256": fingerprint(fixture),
                  "fixtureFileSha256": hashlib.sha256(fixture_bytes).hexdigest(),
                  "driverSha256": sha256(Path(__file__)), "coreSha256": sha256(HERE / "core.py"),
                  "policySha256": fingerprint(config), "policy": config,
                  "matchesFrozenPolicy": policy_matches,
                  "freezeFileSha256": sha256(args.freeze_file),
                  "sqlite": sqlite3.sqlite_version, "validation": validation}
    if args.validate_only:
        print(canonical(provenance), end="")
        return
    if not all([args.analyzer, args.detector, args.detector_model, args.output]):
        parser.error("Benchmark requires --analyzer, --detector, --detector-model, and --output")
    splits = ["development", "heldout"] if args.split == "all" else [args.split]
    enabled = fixture["languages"]
    detections, detector_provenance = detections_for(fixture, splits, args.detector.resolve(), args.detector_model.resolve(),
                                                   args.official_detector.resolve() if args.official_detector else None, args.cache_dir)
    cache, analyzer_provenance = analyzer_cache(fixture, splits, detections, enabled, config, args.analyzer.resolve(), args.cache_dir)
    report = {"scope": "synthetic lexical retrieval diagnostics; no LLM, embeddings, or live gateway",
              "provenance": provenance, "detector": detector_provenance, "analyzer": analyzer_provenance,
              "notes": ["No native-speaker review; parallel templates and repeated fragments are diagnostic rather than representative.",
                        "Ground-truth languages never select runtime routing; explicit notebook/query context is a simulated user-surface hint.",
                        "Compatible alternatives are not confirmed negatives; precision bounds and condensed target nDCG are explicitly named.",
                        "Global BM25 uses shared statistics; separate language-lane statistics are combined with rank fusion, never raw-score mixing.",
                        "Encoded token stores on this Python SQLite do not exercise the native per-value locale extension.",
                        "Unqueryable normalized-span sentinels prevent cross-span phrases but contribute to offline FTS document lengths.",
                        "Ordinary-word Unicode case folding can merge spellings such as ß/ss; code atoms and URL paths preserve case.",
                        "Surface-priority ranking is an explicit prototype rule, not a validated production design."],
              "splits": {}}
    for split in splits:
        report["splits"][split] = evaluate(fixture["splits"][split], detections, enabled, config, cache)
        report["complete"] = len(report["splits"]) == len(splits)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        pending = args.output.with_suffix(args.output.suffix + ".pending")
        pending.write_text(canonical(report))
        pending.replace(args.output)
        print(canonical({"split": split, "methods": {name: method["overall"] for name, method in report["splits"][split]["methods"].items()}}), end="", flush=True)


if __name__ == "__main__":
    main()

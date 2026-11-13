# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Actual Lucene retrieval reference, preserving its analyzer token graphs."""

import hashlib
import json
import subprocess
import unicodedata


def evaluate(cases, detection_cache, language_codes, script, query_mode="grouped"):
    requests = []
    keys = []
    for method in ["lucene-nfkc-oracle", "lucene-nfkc-doc-detect-fanout"]:
        for case in cases:
            documents = []
            for rowid, text in enumerate(case["positive"] + case["negative"], 1):
                detected = language_codes.get(detection_cache[text].get("detection", {}).get("language"), "en")
                language = case["language"] if method.endswith("oracle") else detected
                documents.append({"id": rowid, "text": unicodedata.normalize("NFKC", text), "language": language})
            documents.sort(key=lambda doc: hashlib.sha256((case["id"] + "\0" + doc["text"]).encode()).hexdigest())
            requests.append({"query": unicodedata.normalize("NFKC", case["query"]), "documents": documents,
                             "queryMode": query_mode,
                             "queryLanguages": sorted({doc["language"] for doc in documents})})
            keys.append((method, case))
    completed = subprocess.run(["bash", str(script)], input="".join(json.dumps(r, ensure_ascii=False) + "\n" for r in requests),
                               text=True, capture_output=True, check=True)
    outputs = [json.loads(line) for line in completed.stdout.splitlines()]
    if len(outputs) != len(requests):
        raise RuntimeError("Lucene reference returned the wrong number of results")
    rows = []
    for (method, case), output in zip(keys, outputs):
        if "error" in output:
            raise RuntimeError(f"Lucene reference failed for {case['id']}: {output['error']}")
        matches = [item["id"] for item in output["results"]]
        positive = set(range(1, len(case["positive"]) + 1))
        found = positive.intersection(matches)
        false = [rowid for rowid in matches if rowid not in positive]
        first = next((i for i, rowid in enumerate(matches, 1) if rowid in positive), None)
        rows.append({"method": method, "id": case["id"], "language": case["language"], "category": case["category"],
                     "hit": bool(found), "clean": len(found) == len(positive) and not false,
                     "false_positives": len(false), "recall": len(found) / len(positive),
                     "reciprocal_rank": 1 / first if first else 0, "matches": matches,
                     "reference_engine": output.get("version", "9.12.3")})
    return rows

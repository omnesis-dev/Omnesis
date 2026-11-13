# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Bounded synthetic preprocessing and FTS controls, outside public retrieval scoring."""

import argparse
import hashlib
import json
import pathlib
import sqlite3
import subprocess


WORDS = {
    "fr": ["l'avion", "l’avion", "avion", "d'études", "d’études", "études", "aujourd'hui",
           "aujourd’hui", "œuf", "oeuf", "œufs", "oeufs", "cœur", "coeur", "hôpital", "hopital",
           "côte", "cote", "ÉTÉ", "été", "élève", "eleve", "cafe\u0301", "café"],
    "fa": ["کتاب", "كتاب", "علی", "علي", "علیٰ", "کیک", "كيك", "می‌روم", "میروم", "می روم",
           "نمی‌روم", "خانه‌ها", "خانهها", "خانه ها", "۱۲۳", "١٢٣", "123", "کِتاب", "ۀ", "ه", "ی", "ى"],
}
FIXTURES = [
    {"id": "fr-elision", "language": "fr", "query": "avion",
     "documents": {"positive": "L’avion arrive demain.", "negative": "Le train part demain."}},
    {"id": "fr-ligature", "language": "fr", "query": "coeur",
     "documents": {"positive": "Le cœur est dessiné ici.", "negative": "Le cercle est dessiné ici."}},
    {"id": "fr-accent-precision", "language": "fr", "query": "cote",
     "documents": {"positive": "Une cote utile.", "contrast": "Une côte rocheuse."}},
    {"id": "fa-mark", "language": "fa", "query": "کتاب",
     "documents": {"positive": "یک کِتاب تازه اینجاست.", "negative": "یک دفتر تازه اینجاست."}},
    {"id": "fa-digits", "language": "fa", "query": "123",
     "documents": {"positive": "شماره ۱۲۳ ثبت شد.", "negative": "شماره 456 ثبت شد."}},
    {"id": "fa-negation-precision", "language": "fa", "query": "روم",
     "documents": {"positive": "می‌روم", "contrast": "نمی‌روم", "negative": "ماندن"}},
    {"id": "fa-kaf-already-handled", "language": "fa", "query": "کتاب",
     "documents": {"positive": "كتاب", "negative": "دفتر"}},
]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def search(documents, query, operation):
    encode = lambda token: "t" + token["text"].encode().hex()
    terms = [encode(token) for token in query["tokens"]]
    if not terms:
        return []
    expression = ('"' + " ".join(terms) + '"') if operation == "phrase" else (
        f" {operation} ".join('"' + term + '"' for term in terms))
    with sqlite3.connect(":memory:") as db:
        db.execute("CREATE VIRTUAL TABLE f USING fts5(content)")
        ids = list(documents)
        db.executemany("INSERT INTO f(rowid,content) VALUES (?,?)",
                       ((index, " ".join(map(encode, record["tokens"])))
                        for index, record in enumerate(documents.values(), 1)))
        return sorted(ids[rowid - 1] for (rowid,) in db.execute(
            "SELECT rowid FROM f WHERE f MATCH ?", (expression,)))


def validate(text, response):
    if response.get("offset_unit") != "utf8_bytes" or not response.get("fingerprint"):
        raise ValueError("Missing UTF8 offset/fingerprint contract")
    encoded = text.encode()
    previous = (0, 0)
    for index, token in enumerate(response["tokens"]):
        start, end = token["start"], token["end"]
        if not (0 <= start < end <= len(encoded)):
            raise ValueError("Invalid original offset bounds")
        encoded[:start].decode(); encoded[:end].decode()
        if token["position"] != index or token["colocated"] or (start < previous[0] or end < previous[1]):
            raise ValueError("Invalid flat positions or nonmonotone ranges")
        if not token["text"] or any(value in " \t\r\n\v\f\0" for value in token["text"]):
            raise ValueError("Invalid term")
        previous = start, end


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("baseline", "boundary", "language-norm"):
        parser.add_argument("--" + name, type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    here = pathlib.Path(__file__).resolve().parent
    if args.output.resolve().is_relative_to(here.parents[2]):
        raise ValueError("Reports must remain outside the repository")
    cases = {(language, text) for language, words in WORDS.items() for text in words}
    for fixture in FIXTURES:
        cases.update((fixture["language"], text) for text in [fixture["query"], *fixture["documents"].values()])
    cases.update([("vi", "má ọ̀kọ̀"), ("th", "ป่า ปา"), ("fr", "کِتاب"), ("fa", "côte")])
    keys = [(language, text, mode) for language, text in sorted(cases) for mode in ("exact", "stem")]
    requests = [{"text": text, "language": language, "mode": mode} for language, text, mode in keys]
    payload = "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in requests)
    variants = {"original": args.baseline, "boundary": args.boundary, "language-norm": args.language_norm}
    records = {}
    for name, binary in variants.items():
        result = subprocess.run([str(binary.resolve())], input=payload, text=True,
                                capture_output=True, check=True, timeout=120)
        outputs = [json.loads(line) for line in result.stdout.splitlines()]
        if len(outputs) != len(keys):
            raise ValueError("Wrong number of analysis responses")
        records[name] = dict(zip(keys, outputs, strict=True))
        for (_, text, _), response in records[name].items():
            validate(text, response)
    checks = {}
    for name in ("boundary", "language-norm"):
        checks[name + "_exact_token_parity"] = all(
            records[name][key]["tokens"] == records["original"][key]["tokens"] for key in keys if key[2] == "exact")
        checks[name + "_distinct_fingerprints"] = all(
            records[name][key]["fingerprint"] != records["original"][key]["fingerprint"] for key in keys)
    for name in variants:
        checks[name + "_stable_config_fingerprints"] = all(
            len({records[name][key]["fingerprint"] for key in keys
                 if key[0] == language and key[2] == mode}) == 1
            for language in {key[0] for key in keys} for mode in ("exact", "stem"))
    unaffected = [("vi", "má ọ̀kọ̀"), ("th", "ป่า ปา"), ("fr", "کِتاب"), ("fa", "côte")]
    for name in ("boundary", "language-norm"):
        checks[name + "_unrelated_token_parity"] = all(
            records[name][language, text, mode]["tokens"] == records["original"][language, text, mode]["tokens"]
            for language, text in unaffected for mode in ("exact", "stem"))
    fixture_results = []
    for fixture in FIXTURES:
        variants_result = {}
        for name in variants:
            modes = {}
            for mode in ("exact", "stem"):
                query = records[name][fixture["language"], fixture["query"], mode]
                documents = {docid: records[name][fixture["language"], text, mode]
                             for docid, text in fixture["documents"].items()}
                modes[mode] = {operation: search(documents, query, operation) for operation in ("OR", "AND", "phrase")}
            variants_result[name] = modes
        fixture_results.append({**fixture, "results": variants_result})
    by_id = {row["id"]: row["results"] for row in fixture_results}
    for name in ("boundary", "language-norm"):
        checks[name + "_elision_positive"] = by_id["fr-elision"][name]["stem"]["phrase"] == ["positive"]
    for identifier in ("fr-ligature", "fa-mark", "fa-digits"):
        checks[identifier + "_language_norm_positive"] = by_id[identifier]["language-norm"]["stem"]["phrase"] == ["positive"]
    checks["accent_precision_risk_exposed"] = by_id["fr-accent-precision"]["language-norm"]["stem"]["OR"] == ["contrast", "positive"]
    checks["negation_precision_risk_exposed"] = all(
        "contrast" in by_id["fa-negation-precision"][name]["stem"]["OR"] for name in ("boundary", "language-norm"))
    checks["kaf_already_handled_original"] = by_id["fa-kaf-already-handled"]["original"]["stem"]["OR"] == ["positive"]
    report = {"scope": "Post-aggregate exploratory synthetic controls; not public retrieval scores or parameter tuning.",
              "source_sha256": sha(pathlib.Path(__file__)), "protocol_sha256": sha(here / "normalization-policy.json"),
              "binary_sha256": {name: sha(path) for name, path in variants.items()},
              "request_sha256": hashlib.sha256(payload.encode()).hexdigest(), "requests_per_variant": len(keys),
              "raw": [{"request": request, "variants": {name: records[name][key] for name in variants}}
                      for key, request in zip(keys, requests)],
              "fixtures": fixture_results, "checks": checks, "passed": all(checks.values()),
              "limitations": ["FTS stores encoded pre-analyzed terms; native FTS callback integration is not tested here.",
                              "Accent and negation contrasts deliberately expose broad-lane false matches.",
                              "These synthetic mechanisms do not attribute the entire aggregate relevance difference."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"requests_per_variant": len(keys), "checks": checks, "passed": report["passed"]}))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Compare the pinned Rust Snowball facade with Python Snowball 3.1.1.

Official upstream vocabulary inputs stay in an external cache. This diagnostic
reports observed differences; it does not assume snapshots are equivalent.
"""

import argparse
import gzip
import hashlib
import importlib.metadata
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "multilingual-lexical-research"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", type=pathlib.Path, required=True)
    parser.add_argument("--python-package-path", type=pathlib.Path)
    parser.add_argument("--cache", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--per-language", type=int, default=200)
    parser.add_argument("--data-commit")
    args = parser.parse_args()
    if not 1 <= args.per_language <= 10000:
        raise ValueError("per-language must be between 1 and 10000")
    repository = pathlib.Path(__file__).resolve().parents[3]
    for destination in (args.cache, args.output):
        if destination.resolve().is_relative_to(repository):
            raise ValueError("Vocabulary cache and reports must remain outside the repository")
    if args.python_package_path:
        sys.path.insert(0, str(args.python_package_path.resolve()))
    import snowballstemmer
    version = importlib.metadata.version("snowballstemmer")
    if version != "3.1.1":
        raise ValueError(f"Expected Python snowballstemmer 3.1.1, found {version}")
    commit = args.data_commit or json.loads(fetch(
        "https://api.github.com/repos/snowballstem/snowball-data/commits?per_page=1"))[0]["sha"]
    if len(commit) != 40 or any(value not in "0123456789abcdef" for value in commit):
        raise ValueError("Expected a full lowercase Git commit SHA")
    cache = args.cache / commit
    cache.mkdir(parents=True, exist_ok=True)
    inputs = []
    provenance = {}
    unavailable = []
    for algorithm in snowballstemmer.algorithms():
        url = f"https://raw.githubusercontent.com/snowballstem/snowball-data/{commit}/{algorithm}/voc.txt"
        path = cache / f"{algorithm}.txt"
        try:
            if not path.exists():
                path.write_bytes(fetch(url))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                path = cache / f"{algorithm}.txt.gz"
                url += ".gz"
                try:
                    if not path.exists():
                        path.write_bytes(fetch(url))
                except urllib.error.HTTPError as compressed_error:
                    if compressed_error.code == 404:
                        unavailable.append(algorithm)
                        continue
                    raise
            else:
                raise
        raw = path.read_bytes()
        words = (gzip.decompress(raw) if path.suffix == ".gz" else raw).decode("utf8").splitlines()
        # Stable spread across the vocabulary, rather than a prefix-only sample.
        count = min(args.per_language, len(words))
        selected = [words[(index * len(words)) // count] for index in range(count)]
        oracle = snowballstemmer.stemmer(algorithm)
        provenance[algorithm] = {"url": url, "sha256": hashlib.sha256(raw).hexdigest(),
                                 "vocabulary_words": len(words), "sample_words": len(selected)}
        inputs.extend({"language": algorithm, "text": word, "python": oracle.stemWord(word)}
                      for word in selected)
    result = subprocess.run([str(args.probe.resolve())],
        input="".join(json.dumps({"text": row["text"], "language": row["language"]}, ensure_ascii=False) + "\n"
                      for row in inputs), text=True, capture_output=True, check=True)
    outputs = [json.loads(line) for line in result.stdout.splitlines()]
    if len(outputs) != len(inputs):
        raise ValueError("Raw stem probe returned the wrong number of records")
    rows = [{**row, "rust": observed["text"], "rust_algorithm": observed["algorithm"],
             "same": row["python"] == observed["text"]} for row, observed in zip(inputs, outputs)]
    summary = {algorithm: {"samples": sum(row["language"] == algorithm for row in rows),
                          "differences": sum(row["language"] == algorithm and not row["same"] for row in rows),
                          "missing_rust_algorithm": sum(row["language"] == algorithm and row["rust_algorithm"] is None for row in rows)}
               for algorithm in provenance}
    report = {"python_version": version, "rust_version": "frostem=2.20261016.3",
              "snowball_data_commit": commit, "input_provenance": provenance,
              "probe_sha256": hashlib.sha256(args.probe.read_bytes()).hexdigest(),
              "samples": len(rows), "algorithms": len(summary), "summary": summary,
              "differences": [row for row in rows if not row["same"]],
              "missing_upstream_vocabularies": unavailable,
              "limitations": ["Deterministic vocabulary subsample, not exhaustive algorithm equivalence.",
                              "Stemming snapshots can legitimately differ; every observed mismatch is retained."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ("samples", "algorithms", "summary", "missing_upstream_vocabularies")}, indent=2))


if __name__ == "__main__":
    main()

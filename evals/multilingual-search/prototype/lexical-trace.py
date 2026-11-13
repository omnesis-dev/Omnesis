# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Exploratory word-pair traces, separate from frozen relevance evaluation."""

import argparse
import hashlib
import json
import pathlib
import subprocess


PAIRS = [
    ("heldout-korean", "ko", "승차권", "승차권을"),
    ("heldout-greek", "el", "εισιτήριο", "εισιτήρια"),
    ("fresh-korean-entry", "ko", "입장권", "입장권을"),
    ("fresh-korean-boarding", "ko", "탑승권", "탑승권을"),
    ("fresh-korean-admission", "ko", "관람권", "관람권을"),
    ("fresh-korean-library", "ko", "도서관", "도서관을"),
    ("fresh-korean-bicycle", "ko", "자전거", "자전거를"),
    ("fresh-korean-card", "ko", "신용카드", "신용카드를"),
    ("fresh-korean-passport", "ko", "여권", "여권을"),
    ("fresh-korean-postbox", "ko", "우체통", "우체통을"),
    ("fresh-greek-book", "el", "βιβλίο", "βιβλία"),
    ("fresh-greek-office", "el", "γραφείο", "γραφεία"),
    ("fresh-greek-school", "el", "σχολείο", "σχολεία"),
    ("fresh-greek-bus", "el", "λεωφορείο", "λεωφορεία"),
    ("fresh-greek-window", "el", "παράθυρο", "παράθυρα"),
    ("fresh-greek-bicycle", "el", "ποδήλατο", "ποδήλατα"),
    ("fresh-greek-car", "el", "αυτοκίνητο", "αυτοκίνητα"),
    ("greek-accentless-precondition", "el", "εισιτηριο", "εισιτηρια"),
    ("greek-uppercase-precondition", "el", "ΕΙΣΙΤΗΡΙΟ", "ΕΙΣΙΤΗΡΙΑ"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analyzer", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--korean-probe", type=pathlib.Path)
    args = parser.parse_args()
    repository = pathlib.Path(__file__).resolve().parents[3]
    if args.output.resolve().is_relative_to(repository):
        raise ValueError("Diagnostic reports must remain outside the repository")
    requests = []
    for _, language, query, document in PAIRS:
        for mode in ("exact", "stem"):
            requests.extend({"text": text, "language": language, "mode": mode}
                            for text in (query, document))
    # Context distinguishes a word-form choice from whole-document routing.
    requests.extend({"text": text, "language": "ko", "mode": "stem"} for text in (
        "저녁 버스의 승차권을 파란 봉투에 넣었습니다.", "승차권 승차권을", "승차권을 승차권"))
    payload = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in requests)
    process = subprocess.run([str(args.analyzer.resolve())], input=payload, text=True,
                             capture_output=True, check=True, timeout=120)
    outputs = [json.loads(line) for line in process.stdout.splitlines()]
    if len(outputs) != len(requests):
        raise ValueError("Wrong number of analysis responses")
    pairs = []
    for index, (identifier, language, query, document) in enumerate(PAIRS):
        modes = {}
        for offset, mode in ((0, "exact"), (2, "stem")):
            left, right = outputs[4 * index + offset:4 * index + offset + 2]
            query_terms = [token["text"] for token in left["tokens"]]
            document_terms = [token["text"] for token in right["tokens"]]
            modes[mode] = {"query_terms": query_terms, "document_terms": document_terms,
                           "any_shared_term": bool(set(query_terms) & set(document_terms)),
                           "all_query_terms_present": set(query_terms) <= set(document_terms),
                           "query_algorithms": sorted({token["algorithm"] for token in left["tokens"] if token["algorithm"]}),
                           "document_algorithms": sorted({token["algorithm"] for token in right["tokens"] if token["algorithm"]})}
        pairs.append({"id": identifier, "language": language, "query": query,
                      "document": document, "modes": modes})
    report = {"schema": 1, "purpose": "Exploratory failure traces; frozen relevance fixtures and policies unchanged.",
              "analyzer_sha256": hashlib.sha256(args.analyzer.read_bytes()).hexdigest(),
              "request_sha256": hashlib.sha256(payload.encode()).hexdigest(), "pairs": pairs,
              "context_traces": [{"request": request, "analysis": response}
                                 for request, response in zip(requests[-3:], outputs[-3:])],
              "fingerprints": sorted({row["fingerprint"] for row in outputs}),
              "limitations": ["Small fresh control set, not a prevalence estimate or a relevance benchmark.",
                              "Shared-term booleans do not assert phrase or ranked retrieval correctness."]}
    if args.korean_probe:
        korean_texts = sorted({text for _, language, query, document in PAIRS if language == "ko"
                               for text in (query, document)} | {row["text"] for row in requests[-3:]})
        korean_payload = "".join(json.dumps({"text": text}, ensure_ascii=False) + "\n"
                                 for text in korean_texts)
        korean_process = subprocess.run([str(args.korean_probe.resolve())], input=korean_payload,
                                        text=True, capture_output=True, check=True, timeout=120)
        traces = [json.loads(line) for line in korean_process.stdout.splitlines()]
        if len(traces) != len(korean_texts):
            raise ValueError("Wrong number of Korean mode responses")
        for trace in traces:
            trace["input_refs"] = [{"pair": identifier, "role": role}
                                   for identifier, language, query, document in PAIRS if language == "ko"
                                   for role, value in (("query", query), ("document", document))
                                   if value == trace["text"]]
            trace["context_input"] = any(row["text"] == trace["text"] for row in requests[-3:])
        report["raw_korean_modes"] = traces
        report["korean_probe_sha256"] = hashlib.sha256(args.korean_probe.read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"pairs": len(pairs), "report": args.output.name}))


if __name__ == "__main__":
    main()

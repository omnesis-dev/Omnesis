# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Bounded synthetic Unicode/offset stress diagnostic for the analysis CLI."""

import argparse
import hashlib
import json
import pathlib
import random
import subprocess
import time
import unicodedata


def cases():
    result = [
        ("empty", "", "und"), ("punctuation", " !!! 😀 👨‍👩‍👧‍👦 \t\n", "und"),
        ("controls", "alpha\x00beta\tगामा\n終わり", "und"),
        ("korean", "파란고래우체통입니다", "ko"),
        ("compatibility-jamo", "ㄱㅏ ㄴㅏ", "ko"),
        ("ligature", "ﷺ ﬃ ＡＢＣ１２３ ｶﾞ", "ar"),
        ("turkish", "I İ ı i I\u0307", "tr"),
        ("greek", "εισιτήριο εισιτήρια βιβλίο βιβλία", "el"),
        ("arabic", "كِتَابٌ كتاب كتابان", "ar"),
        ("thai", "ป่า ปา ภาษาไทย", "th"),
        ("indic", "किताबों में चित्र हैं কী কি கி", "hi"),
        ("long-word", "a" * 16384, "en"),
        ("long-combining", "a" + "\u0301\u0323" * 512 + " end", "en"),
        ("many-small-words", "alpha beta " * 1024, "en"),
    ]
    randomizer = random.Random(902)
    alphabet = "abcéİıάβ中文日本語한글किताबকিก้မြန်မာកខ😀👩\u200d\u0301\u0323"
    for index in range(48):
        source = " ".join("".join(randomizer.choice(alphabet) for _ in range(randomizer.randint(1, 16)))
                          for _ in range(randomizer.randint(1, 12)))
        result.append((f"unicode-{index}", source, "und"))
    for index, (source, language) in enumerate([
        ("파란고래우체통입니다", "ko"), ("café déjà résumé", "fr"),
        ("Ångström", "sv"), ("άλφα", "el"),
    ]):
        result.extend([(f"canonical-{index}-nfc", unicodedata.normalize("NFC", source), language),
                       (f"canonical-{index}-nfd", unicodedata.normalize("NFD", source), language)])
    return result


def validate(request, response):
    source = request["text"].encode("utf8")
    boundaries = {0}
    offset = 0
    for value in request["text"]:
        offset += len(value.encode("utf8"))
        boundaries.add(offset)
    if response.get("offset_unit") != "utf8_bytes" or not response.get("fingerprint"):
        raise ValueError("Missing byte-offset contract or analyzer fingerprint")
    previous_start = previous_end = 0
    for position, token in enumerate(response["tokens"]):
        start, end, term = token["start"], token["end"], token["text"]
        if not (start in boundaries and end in boundaries and 0 <= start < end <= len(source)):
            raise ValueError(f"Invalid original UTF8 range: {start}:{end}/{len(source)}")
        if start < previous_start or end < previous_end:
            raise ValueError("Token ranges move backwards")
        if token["position"] != position or token["colocated"] is not False:
            raise ValueError("Expected consecutive flat token positions")
        if not term or any(value in " \t\n\r\v\f\0" for value in term):
            raise ValueError("Invalid analyzed term")
        previous_start, previous_end = start, end


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analyzer", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    repository = pathlib.Path(__file__).resolve().parents[3]
    if args.output.resolve().is_relative_to(repository):
        raise ValueError("Diagnostic reports must remain outside the repository")
    if not 1 <= args.timeout <= 600:
        raise ValueError("Timeout must be between1 and600seconds")
    requests = []
    identifiers = []
    for identifier, source, language in cases():
        for mode in ("exact", "stem"):
            identifiers.append((identifier, mode))
            requests.append({"text": source, "language": language, "mode": mode})
    payload = "".join(json.dumps(value, ensure_ascii=False) + "\n" for value in requests)
    started = time.monotonic()
    process = subprocess.run([str(args.analyzer.resolve())], input=payload + payload,
                             text=True, capture_output=True, timeout=args.timeout, check=True)
    elapsed = time.monotonic() - started
    outputs = [json.loads(line) for line in process.stdout.splitlines()]
    if len(outputs) != 2 * len(requests):
        raise ValueError("Wrong number of analyzer responses")
    first, second = outputs[:len(requests)], outputs[len(requests):]
    if first != second:
        raise ValueError("Repeated requests were not deterministic within the same process")
    normalized = {}
    for identity, request, response in zip(identifiers, requests, first):
        validate(request, response)
        normalized[identity] = [token["text"] for token in response["tokens"]]
    for index in range(4):
        for mode in ("exact", "stem"):
            if normalized[(f"canonical-{index}-nfc", mode)] != normalized[(f"canonical-{index}-nfd", mode)]:
                raise ValueError(f"Canonical NFC/NFD mismatch for case{index}/{mode}")
    report = {"schema": 1, "cases": len(requests), "actual_requests_including_repeat": len(outputs),
              "seconds": elapsed, "request_sha256": hashlib.sha256(payload.encode()).hexdigest(),
              "analyzer_sha256": hashlib.sha256(args.analyzer.read_bytes()).hexdigest(),
              "fingerprints": sorted({row["fingerprint"] for row in first}),
              "token_count_first_pass": sum(len(row["tokens"]) for row in first),
              "checks": ["Valid original UTF8 byte boundaries", "Monotone ranges and consecutive flat positions",
                         "Deterministic repeated requests", "Selected NFC/NFD equivalence", "No empty/ASCII-space/NUL terms"],
              "limitations": ["Synthetic bounded inputs; not a proof against every Unicode or resource-exhaustion case.",
                              "No memory/RSS measurement, native FFI fuzzer, or real corpus is included."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

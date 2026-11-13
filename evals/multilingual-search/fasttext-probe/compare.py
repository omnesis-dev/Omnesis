# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Compare document/query language identification; labels never enter a probe.

Mixed-language fixtures are reported separately, not treated as having one
unambiguous true language. Short-query scores are diagnostic, not a proposal
to hard-route production queries.
"""

import argparse
import hashlib
import json
import pathlib
import subprocess
import time


ISO3 = {
    "ara": "ar", "deu": "de", "ell": "el", "eng": "en", "spa": "es",
    "fin": "fi", "fra": "fr", "hin": "hi", "ita": "it", "por": "pt",
    "rus": "ru", "tur": "tr", "nld": "nl", "swe": "sv", "dan": "da",
    "nob": "nb", "hun": "hu", "ind": "id", "ron": "ro", "ces": "cs",
    "pol": "pl", "kor": "ko", "cmn": "zh", "jpn": "ja", "tha": "th",
    "heb": "he", "pes": "fa", "vie": "vi", "ukr": "uk", "khm": "km",
}


def language(code):
    return "nb" if code == "no" else ISO3.get(code, code)


def aggregate(rows):
    return {
        "inputs": len(rows),
        "fasttext_top1_correct": sum(row["fasttext_correct"] for row in rows),
        "fasttext_top3_contains_expected": sum(row["fasttext_top3_correct"] for row in rows),
        "whatlang_top1_correct": sum(row["whatlang_correct"] for row in rows),
        "whatlang_reliable_inputs": sum(row["whatlang_reliable"] for row in rows),
        "whatlang_reliable_and_correct": sum(row["whatlang_reliable"] and row["whatlang_correct"] for row in rows),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", type=pathlib.Path, required=True)
    parser.add_argument("--model", type=pathlib.Path, required=True)
    parser.add_argument("--baseline", type=pathlib.Path, required=True)
    parser.add_argument("--official", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    fixture_bytes = (pathlib.Path(__file__).resolve().parents[1] / "cases.json").read_bytes()
    cases = json.loads(fixture_bytes)
    canonical = (json.dumps(cases, ensure_ascii=False, indent=2) + "\n").encode()
    fixture_hash = hashlib.sha256(canonical).hexdigest()
    baseline = json.loads(args.baseline.read_text())
    if baseline["fixture_sha256"] != fixture_hash:
        raise ValueError("Baseline cache does not match current fixtures")
    whatlang = baseline["token_cache"]["charabia"]
    inputs = []
    for case in cases:
        for role, texts in (("document", case["positive"] + case["negative"]), ("query", [case["query"]])):
            for text in texts:
                inputs.append({"id": case["id"], "language": case["language"], "category": case["category"], "role": role, "text": text})
    unique_texts = sorted({row["text"] for row in inputs})
    started = time.perf_counter()
    result = subprocess.run(
        [str(args.probe.resolve()), str(args.model.resolve())],
        input="".join(json.dumps({"text": text}, ensure_ascii=False) + "\n" for text in unique_texts),
        text=True, capture_output=True, check=True,
    )
    duration = time.perf_counter() - started
    predictions = [json.loads(line) for line in result.stdout.splitlines()]
    if len(predictions) != len(unique_texts):
        raise ValueError("Probe returned the wrong number of responses")
    cache = dict(zip(unique_texts, predictions))
    parity = {"verified": False}
    official_cache = {}
    if args.official:
        if any("\n" in text or "\r" in text for text in unique_texts):
            raise ValueError("Official line-oriented probe requires single-line fixture inputs")
        reference_result = subprocess.run(
            [str(args.official.resolve()), "predict-prob", str(args.model.resolve()), "-", "3", "0.0"],
            input="".join(text + "\n" for text in unique_texts), text=True, capture_output=True, check=True,
        )
        official_lines = reference_result.stdout.splitlines()
        if len(official_lines) != len(unique_texts):
            raise ValueError("Official probe returned the wrong number of responses")
        disagreements = []
        top3_disagreements = 0
        top3_set_disagreements = 0
        maximum_probability_difference = 0.0
        for text, line in zip(unique_texts, official_lines):
            fields = line.split()
            official = [{"language": fields[index].removeprefix("__label__"), "confidence": float(fields[index + 1])}
                        for index in range(0, len(fields), 2)]
            observed = cache[text]["predictions"]
            official_cache[text] = {"detection": official[0] if official else None, "predictions": official}
            if [item["language"] for item in official] != [item["language"] for item in observed]:
                top3_disagreements += 1
            if {item["language"] for item in official} != {item["language"] for item in observed}:
                top3_set_disagreements += 1
            if official and observed and official[0]["language"] != observed[0]["language"]:
                disagreements.append({"text": text, "official": official, "rust": observed})
            official_probabilities = {item["language"]: item["confidence"] for item in official}
            for item in observed:
                if item["language"] in official_probabilities:
                    maximum_probability_difference = max(maximum_probability_difference,
                        abs(item["confidence"] - official_probabilities[item["language"]]))
        parity = {"verified": True, "reference": "facebookresearch/fastText v0.9.2 CLI",
                  "inputs": len(unique_texts), "top1_disagreements": disagreements,
                  "top3_sequence_disagreements": top3_disagreements,
                  "top3_label_set_disagreements": top3_set_disagreements,
                  "maximum_probability_absolute_difference": maximum_probability_difference}
    rows = []
    for item in inputs:
        observed = cache[item["text"]]
        detected = observed["detection"] or {}
        reference = whatlang[item["text"]].get("detection") or {}
        rows.append({
            **item, "fasttext": observed, "whatlang": reference,
            "fasttext_correct": language(detected.get("language")) == item["language"],
            "fasttext_top3_correct": item["language"] in {language(p["language"]) for p in observed["predictions"]},
            "whatlang_correct": language(reference.get("language")) == item["language"],
            "whatlang_reliable": bool(reference.get("reliable")),
        })
    summary = {}
    for role in ("document", "query"):
        selected = [row for row in rows if row["role"] == role]
        summary[role] = {
            "all": aggregate(selected),
            "non_mixed": aggregate([row for row in selected if not row["category"].startswith("mixed")]),
            "mixed_language_or_script": aggregate([row for row in selected if row["category"].startswith("mixed")]),
            "by_language": {code: aggregate([row for row in selected if row["language"] == code]) for code in sorted({row["language"] for row in selected})},
        }
    report = {
        "fixture_sha256": fixture_hash,
        "model_sha256": hashlib.sha256(args.model.read_bytes()).hexdigest(),
        "model_bytes": args.model.stat().st_size,
        "model_source": "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz",
        "model_license": "CC-BY-SA-3.0",
        "inference_crate": "fasttext-pure-rs=0.1.0 (MIT)",
        "unique_inputs": len(unique_texts),
        "seconds_including_process_start_and_model_load": duration,
        "summary": summary, "rows": rows, "cache": cache,
        "official_parity": parity,
        "official_cache": official_cache,
        "limitations": [
            "Synthetic diagnostics without native-speaker review; not a representative language-identification benchmark.",
            "Mixed-language fixture labels describe the target query language, not necessarily the dominant document language.",
            "Document input counts include repeated fixture text; unique input count is reported separately.",
            "Generic Norwegian no is accepted as Norwegian Bokmal nb; Mandarin cmn is compared as zh.",
            "Detector scores are not assumed calibrated; no reliability threshold is invented for fastText.",
            "Short queries are diagnostic only; a production retrieval pipeline should preserve analyzer fanout and raw matching.",
            "Optional official C++ comparison covers only these fixture inputs, not every supported model or language.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"model_sha256": report["model_sha256"], "model_bytes": report["model_bytes"], "unique_inputs": len(unique_texts), "seconds": duration, "summary": summary, "official_parity": parity}, indent=2))


if __name__ == "__main__":
    main()

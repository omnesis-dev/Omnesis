#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Apply explicit annotation errata and run a post-audit lane-universe control."""

import argparse
import copy
import json
from pathlib import Path
import time

from core import (
    Index, canonical, expression, field_texts, fingerprint, query_body,
    query_kind, query_languages, rrf, score, surface_priority, surface_tokens,
    validate,
)
from run import (
    HERE, analyzed_tokens, analyzer_cache, detections_for, normalized_rows,
    sha256, summarize,
)


def apply_errata(fixture, overlay):
    if fingerprint(fixture) != overlay["fixtureCanonicalSha256"]:
        raise ValueError("Annotation overlay applies to a different frozen fixture")
    corrected = copy.deepcopy(fixture)
    for change in overlay["changes"]:
        part = corrected["splits"][change["split"]]
        queries = {query["id"]: query for query in part["queries"]}
        documents = {document["id"]: document for document in part["documents"]}
        query = queries[change["queryId"]]
        compatible = set(query.get("compatible", []))
        for docid in change["addCompatible"]:
            if docid in query["relevance"] or docid in compatible:
                raise ValueError("Erratum must add a previously unjudged compatible alternative")
            if change["evidence"] not in documents[docid]["body"]:
                raise ValueError("Annotation evidence must occur literally in the named document")
            compatible.add(docid)
        query["compatible"] = sorted(compatible)
    validate(corrected)
    return corrected


def correction_report(original, fixture, corrected, overlay):
    result = {"scope": "Annotation errata only; original ranked IDs are unchanged.",
              "originalReportSha256": None,
              "originalProvenance": original["provenance"],
              "errata": overlay, "splits": {}}
    unchanged = ("requiredRecall@10", "requiredRecall@100", "requiredMRR@10", "requiredTop1", "mixedRequiredRecall@10")
    for split, part in original["splits"].items():
        original_queries = {q["id"]: q for q in fixture["splits"][split]["queries"]}
        queries = {q["id"]: q for q in corrected["splits"][split]["queries"]}
        documents = {d["id"]: d for d in fixture["splits"][split]["documents"]}
        result["splits"][split] = {}
        for name, method in part["methods"].items():
            rows, authored_rows, affected = [], [], []
            row_ids = [row["queryId"] for row in method["rows"]]
            if len(row_ids) != len(queries) or set(row_ids) != set(queries):
                raise ValueError("Original method must cover every frozen query exactly once")
            for row in method["rows"]:
                qid = row["queryId"]
                if len(row["ranking"]) != len(set(row["ranking"])) or not set(row["ranking"]) <= set(documents):
                    raise ValueError("Original ranking contains duplicate or unknown document IDs")
                authored = score(row["ranking"], original_queries[qid], documents)
                if authored != row["metrics"]:
                    raise ValueError("Original report metrics do not match its frozen rankings")
                authored_rows.append({"queryId": qid, "metrics": authored})
                metrics = score(row["ranking"], queries[qid], documents)
                if any(authored.get(key) != metrics.get(key) for key in unchanged):
                    raise ValueError("Compatible-only erratum changed required-target metrics")
                rows.append({"queryId": qid, "metrics": metrics})
                if authored != metrics:
                    affected.append({"queryId": qid, "authored": authored, "corrected": metrics})
            authored_summary = summarize(authored_rows, original_queries)
            if any(authored_summary[key] != method[key] for key in authored_summary):
                raise ValueError("Original aggregates do not match the ranked query rows")
            result["splits"][split][name] = {
                "rankedIdsSha256": fingerprint([[row["queryId"], row["ranking"]] for row in method["rows"]]),
                "authored": {key: method[key] for key in ("overall", "byCategory", "byLanguage")},
                "corrected": summarize(rows, queries), "affectedQueries": affected,
                "requiredTargetMetricsUnchanged": True,
            }
    return result


def compiled_union(query, policy, mode, detections, enabled, config, cache):
    choices = query_languages(policy, query, detections, enabled, config)
    tokens = [analyzed_tokens(cache, query_body(query["text"]), selected, mode) for selected in choices]
    if query_kind(query["text"]) == "quoted":
        expressions = list(dict.fromkeys(expression(parts, phrase=True) for parts in tokens if parts))
        return " OR ".join(expressions), choices
    return expression(term for parts in tokens for term in parts), choices


def fair_rank(compiled, indexes, config):
    # Every physical lane sees exactly the global expression. Query-language
    # analysis chooses terms, never a physical candidate-language restriction.
    return rrf([index.rank(compiled, config["depth"]) for index in indexes.values()],
               config["rrf_k"], config["depth"])


def fair_evaluate(part, corrected_part, expected, detections, enabled, config, cache):
    documents, queries = part["documents"], part["queries"]
    query_by_id = {q["id"]: q for q in queries}
    corrected_queries = {q["id"]: q for q in corrected_part["queries"]}
    document_by_id = {d["id"]: d for d in documents}
    surface = Index(documents, {d["id"]: {field: surface_tokens(value)
        for field, value in field_texts(d).items()} for d in documents})
    indexes, methods = {}, {}
    try:
        for document_policy in ("hard", "context-script"):
            for mode in ("exact", "stem"):
                _, lanes, routes = normalized_rows(documents, document_policy, mode, detections, enabled, config, cache)
                if routes != expected["routing"][document_policy]:
                    raise ValueError("Control changed original document routing")
                indexes[(document_policy, mode)] = {selected: Index(documents, rows) for selected, rows in lanes.items()}
        variants = [("normalized/" + mode + "/" + policy + "/fair-lanes", False, mode, policy)
                    for mode in ("exact", "stem") for policy in ("hard", "context-script", "fanout")]
        variants += [("surface-priority/stem/" + policy + "/fair-lanes", True, "stem", policy)
                     for policy in ("hard", "context-script", "fanout")]
        for name, prioritized, mode, policy in variants:
            rows, corrected_rows, started = [], [], time.perf_counter()
            for query in queries:
                compiled, choices = compiled_union(query, policy, mode, detections, enabled, config, cache)
                reference = expected["methods"]["normalized/" + mode + "/" + policy + "/global"]["rows"]
                original_choices = next(row["routes"] for row in reference if row["queryId"] == query["id"])
                if choices != original_choices:
                    raise ValueError("Control changed original query routing")
                physical = indexes[("hard" if policy == "hard" else "context-script", mode)]
                ranking = fair_rank(compiled, physical, config)
                if prioritized:
                    kind = query_kind(query["text"])
                    terms = surface_tokens(query_body(query["text"]))
                    surface_rank = surface.rank(expression(terms, phrase=kind in {"quoted", "literal"}), config["depth"])
                    complete = list(dict.fromkeys([
                        *surface.rank(expression(terms, phrase=True), config["depth"]),
                        *surface.rank(expression(terms, operation="AND"), config["depth"])]))
                    ranking = surface_priority(complete, surface_rank, ranking, kind, config["rrf_k"], config["depth"])
                rows.append({"queryId": query["id"], "routes": choices, "ranking": ranking,
                             "metrics": score(ranking, query, document_by_id)})
                corrected_rows.append({"queryId": query["id"],
                    "metrics": score(ranking, corrected_queries[query["id"]], document_by_id)})
            methods[name] = {"authored": summarize(rows, query_by_id),
                             "corrected": summarize(corrected_rows, corrected_queries),
                             "rows": rows, "queryVariants": sum(len(row["routes"]) for row in rows),
                             "querySecondsExcludingAnalysis": time.perf_counter() - started}
        return {"methods": methods}
    finally:
        surface.close()
        for lanes in indexes.values():
            for index in lanes.values():
                index.close()


def write_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(path.suffix + ".pending")
    pending.write_text(canonical(report))
    pending.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--corrected-output", type=Path)
    parser.add_argument("--fair-output", type=Path)
    parser.add_argument("--analyzer", type=Path)
    parser.add_argument("--detector", type=Path)
    parser.add_argument("--detector-model", type=Path)
    parser.add_argument("--official-detector", type=Path)
    parser.add_argument("--cache-dir", type=Path)
    args = parser.parse_args()
    if not (args.corrected_output or args.fair_output):
        parser.error("Choose --corrected-output and/or --fair-output")
    original = json.loads(args.input.read_text())
    if not original.get("complete") or not original["provenance"]["matchesFrozenPolicy"]:
        raise ValueError("Supplement requires a complete frozen-policy original report")
    fixture = json.loads((HERE / "fixtures.json").read_text())
    overlay = json.loads((HERE / "annotation-errata.json").read_text())
    amendment = json.loads((HERE / "amendment.json").read_text())
    if sha256(HERE / "annotation-errata.json") != amendment["annotationCorrection"]["overlaySha256"]:
        raise ValueError("Annotation overlay differs from the frozen amendment")
    if fingerprint(fixture) != amendment["fixtureCanonicalSha256"]:
        raise ValueError("Fixture differs from the frozen amendment")
    for source, key in (("run.py", "originalDriverSha256"), ("core.py", "originalCoreSha256")):
        if sha256(HERE / source) != amendment[key]:
            raise ValueError("Original experiment implementation changed")
    for reported, frozen in (("driverSha256", "originalDriverSha256"), ("coreSha256", "originalCoreSha256")):
        if original["provenance"][reported] != amendment[frozen]:
            raise ValueError("Original report was generated by a different implementation")
    if original["provenance"]["policySha256"] != amendment["originalPolicySha256"]:
        raise ValueError("Original experiment policy changed")
    if fingerprint(original["provenance"]["policy"]) != original["provenance"]["policySha256"]:
        raise ValueError("Original policy parameters do not match their recorded fingerprint")
    if original["provenance"]["fixtureCanonicalSha256"] != fingerprint(fixture):
        raise ValueError("Original report belongs to another fixture")
    if fingerprint(original["analyzer"]["fingerprints"]) != amendment["originalAnalyzerFingerprintsSha256"]:
        raise ValueError("Original report changed the frozen analyzer implementation")
    if original["detector"]["modelSha256"] != amendment["detectorModelSha256"]:
        raise ValueError("Original report changed the frozen detector model")
    corrected = apply_errata(fixture, overlay)
    provenance = {"originalReportSha256": sha256(args.input),
                  "originalAuditReportSha256": amendment["originalReportSha256"],
                  "matchesOriginalAuditReport": sha256(args.input) == amendment["originalReportSha256"],
                  "amendmentSha256": sha256(HERE / "amendment.json"),
                  "errataSha256": sha256(HERE / "annotation-errata.json"),
                  "auditDriverSha256": sha256(Path(__file__)),
                  "fixtureCanonicalSha256": fingerprint(fixture)}
    corrected_report = correction_report(original, fixture, corrected, overlay)
    corrected_report["originalReportSha256"] = provenance["originalReportSha256"]
    corrected_report["auditProvenance"] = provenance
    if args.corrected_output:
        write_report(args.corrected_output, corrected_report)
        print("Wrote annotation-only report; original rankings and required-target metrics retained.", flush=True)
    if not args.fair_output:
        return
    if not all((args.analyzer, args.detector, args.detector_model, args.official_detector)):
        parser.error("Fair control requires analyzer, detector, model, and official reference")
    splits = list(original["splits"])
    config = original["provenance"]["policy"]
    if config["depth"] != amendment["control"]["depth"] or config["rrf_k"] != amendment["control"]["rrfK"]:
        raise ValueError("Control thresholds differ from the amendment")
    detections, detector_provenance = detections_for(fixture, splits, args.detector.resolve(), args.detector_model.resolve(),
        args.official_detector.resolve(), args.cache_dir)
    cache, analyzer_provenance = analyzer_cache(fixture, splits, detections, fixture["languages"], config,
        args.analyzer.resolve(), args.cache_dir)
    if analyzer_provenance["fingerprints"] != original["analyzer"]["fingerprints"]:
        raise ValueError("Control must use the original analyzer configuration fingerprints")
    if detector_provenance["modelSha256"] != original["detector"]["modelSha256"]:
        raise ValueError("Control must use the original detector model")
    report = {"scope": "Exploratory post-audit candidate-universe control; no policy tuning.",
              "provenance": provenance, "amendment": amendment, "detector": detector_provenance,
              "analyzer": analyzer_provenance, "originalProvenance": original["provenance"], "splits": {}}
    for split in splits:
        report["splits"][split] = fair_evaluate(fixture["splits"][split], corrected["splits"][split], original["splits"][split],
            detections, fixture["languages"], config, cache)
        report["complete"] = len(report["splits"]) == len(splits)
        write_report(args.fair_output, report)
        print("Completed supplemental fair-lanes split " + split, flush=True)


if __name__ == "__main__":
    main()

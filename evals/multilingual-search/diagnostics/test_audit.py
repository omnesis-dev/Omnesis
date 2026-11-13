# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

import copy
import json
from pathlib import Path
import unittest

from audit import apply_errata, compiled_union, correction_report, fair_rank
from core import Index, expression, fingerprint, score
from run import summarize

HERE = Path(__file__).resolve().parent


class AnnotationErrataTests(unittest.TestCase):
    def test_correction_rejects_incomplete_rankings_and_inconsistent_aggregates(self):
        query = {"id": "q", "text": "word", "category": "control", "language": "en",
                 "relevance": {"target": 3}, "compatible": []}
        fixture = {"splits": {"development": {"documents": [{"id": "target"}], "queries": [query]}}}
        row = {"queryId": "q", "ranking": ["target"], "metrics": score(["target"], query, {"target": {}})}
        method = {"rows": [row], **summarize([row], {"q": query})}
        original = {"provenance": {}, "splits": {"development": {"methods": {"control": method}}}}
        correction_report(original, fixture, fixture, {})
        for mutation in ("missing-query", "bad-aggregate", "unknown-document"):
            invalid = copy.deepcopy(original)
            candidate = invalid["splits"]["development"]["methods"]["control"]
            if mutation == "missing-query":
                candidate["rows"] = []
            elif mutation == "bad-aggregate":
                candidate["overall"]["requiredRecall@100"]["mean"] = 0
            else:
                candidate["rows"][0]["ranking"].append("unknown")
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                correction_report(invalid, fixture, fixture, {})

    def test_only_compatible_judgments_change_and_literal_evidence_is_required(self):
        fixture = json.loads((HERE / "fixtures.json").read_text())
        overlay = json.loads((HERE / "annotation-errata.json").read_text())
        corrected = apply_errata(fixture, overlay)
        self.assertEqual(fingerprint(fixture), overlay["fixtureCanonicalSha256"])
        for split in fixture["splits"]:
            before = {q["id"]: q for q in fixture["splits"][split]["queries"]}
            for query in corrected["splits"][split]["queries"]:
                original = before[query["id"]]
                self.assertEqual(query["relevance"], original["relevance"])
                self.assertEqual(query["text"], original["text"])
                self.assertLessEqual(set(original.get("compatible", [])), set(query.get("compatible", [])))
        invalid = copy.deepcopy(overlay)
        invalid["changes"][0]["evidence"] = "This evidence does not occur in the fixture."
        with self.assertRaises(ValueError):
            apply_errata(fixture, invalid)

    def test_compatible_erratum_removes_incorrect_negative_judgment_without_changing_recall(self):
        query = {"relevance": {"target": 3}, "compatible": []}
        corrected = {**query, "compatible": ["alternative"]}
        before = score(["alternative", "target"], query, {"target": {}})
        after = score(["alternative", "target"], corrected, {"target": {}})
        self.assertEqual(before["confirmedNegativeCount@10"], 1)
        self.assertEqual(after["confirmedNegativeCount@10"], 0)
        self.assertEqual(before["requiredRecall@100"], after["requiredRecall@100"])
        self.assertEqual(before["requiredMRR@10"], after["requiredMRR@10"])


class FairLaneControlTests(unittest.TestCase):
    def test_identical_expression_reaches_every_physical_language_lane(self):
        docs = [{"id": "english"}, {"id": "french"}]
        indexes = {"en": Index(docs, {"english": {"body": ["shared-code"]}}),
                   "fr": Index(docs, {"french": {"body": ["shared-code"]}})}
        try:
            self.assertEqual(set(fair_rank(expression(["shared-code"]), indexes, {"depth": 100, "rrf_k": 60})),
                             {"english", "french"})
        finally:
            for index in indexes.values():
                index.close()

    def test_phrase_candidate_universe_matches_global_with_span_sentinels(self):
        docs = [{"id": name} for name in ["adjacent", "separated", "foreign"]]
        en = {"adjacent": {"body": ["quiet", "amber"]},
              "separated": {"body": ["quiet", "boundary:span", "amber"]}}
        fr = {"foreign": {"body": ["quiet", "amber"]}}
        global_index = Index(docs, {**en, **fr})
        lanes = {"en": Index(docs, en), "fr": Index(docs, fr)}
        try:
            compiled = expression(["quiet", "amber"], phrase=True)
            self.assertEqual(set(fair_rank(compiled, lanes, {"depth": 100, "rrf_k": 60})),
                             set(global_index.rank(compiled)))
            self.assertNotIn("separated", global_index.rank(compiled))
        finally:
            global_index.close()
            for index in lanes.values():
                index.close()

    def test_query_analysis_union_is_independent_of_physical_lanes(self):
        query = {"text": "invoice", "context_language": "en"}
        cache = {("invoice", code, "stem"): {"tokens": [{"text": term}]}
                 for code, term in [("en", "invoic"), ("fr", "factur"), ("und", "invoice")]}
        compiled, choices = compiled_union(query, "fanout", "stem", {}, ["en", "fr"],
                                           {"confidence": 0.6, "minimum_letters": 20}, cache)
        self.assertEqual(choices, ["en", "fr", "und"])
        self.assertEqual(compiled, expression(["invoic", "factur", "invoice"]))


if __name__ == "__main__":
    unittest.main()

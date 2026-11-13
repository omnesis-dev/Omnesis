# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

import copy
import json
from pathlib import Path
import unittest

from core import (
    Index, document_units, expression, field_texts, pick_language, protected_atom,
    query_body, query_kind, query_languages, rrf, score, script_spans, surface_priority,
    surface_tokens, surface_words, validate,
    validate_analyzer_response,
)


def document(identity, **fields):
    return {"id": identity, "title": "", "body": "", "author": "", "url": "", "codes": [],
            "truth_languages": ["en"], "notebook_language": "en", **fields}


class SurfacePrecisionTests(unittest.TestCase):
    def test_utf8_contract_rejects_mid_character_offsets_and_colocated_graphs(self):
        valid = {"fingerprint": "stable", "offset_unit": "utf8_bytes",
                 "tokens": [{"text": "메모", "start": 0, "end": 6, "position": 0}]}
        validate_analyzer_response("메모", valid)
        invalid = copy.deepcopy(valid)
        invalid["tokens"][0]["end"] = 2
        with self.assertRaises(ValueError):
            validate_analyzer_response("메모", invalid)
        invalid = copy.deepcopy(valid)
        invalid["tokens"].append({"text": "gap", "start": 0, "end": 6, "position": 2})
        with self.assertRaises(ValueError):
            validate_analyzer_response("메모", invalid)
        invalid = copy.deepcopy(valid)
        invalid["tokens"].append({"text": "alias", "start": 0, "end": 6, "position": 0, "colocated": True})
        with self.assertRaises(ValueError):
            validate_analyzer_response("메모", invalid)

    def test_canonical_equivalence_retains_distinctive_marks(self):
        self.assertEqual(surface_words("naïveté"), surface_words("nai\u0308vete\u0301"))
        self.assertNotEqual(surface_words("papá"), surface_words("papa"))
        self.assertNotEqual(surface_words("bàn"), surface_words("bạn"))
        self.assertEqual(surface_words("क़लम"), surface_words("क़लम"))
        self.assertNotEqual(surface_words("कल"), surface_words("काल"))

    def test_codes_preserve_case_and_whole_identity(self):
        self.assertEqual(query_kind("AB-412"), "literal")
        self.assertEqual(query_kind("PN-DV-FR-001"), "literal")
        self.assertNotEqual(surface_tokens("AB-412"), surface_tokens("AB-412X"))
        self.assertNotEqual(surface_tokens("AB-412"), surface_tokens("ab-412"))
        self.assertEqual(query_kind("silver-canoe"), "natural")

    def test_url_host_case_normalizes_but_path_case_does_not(self):
        self.assertEqual(protected_atom("HTTPS://EXAMPLE.ORG/Notes"), protected_atom("https://example.org/Notes"))
        self.assertNotEqual(protected_atom("https://example.org/Notes"), protected_atom("https://example.org/notes"))
        self.assertNotEqual(surface_tokens("https://example.org/Notes"), surface_tokens("https://example.org/Notes/draft"))

    def test_phrase_does_not_cross_columns_or_accept_a_gap(self):
        documents = [document("adjacent", title="quiet amber"), document("gap", title="quiet blue amber"),
                     document("cross-field", title="quiet", body="amber")]
        index = Index(documents, {row["id"]: {key: surface_tokens(value) for key, value in field_texts(row).items()} for row in documents})
        try:
            self.assertEqual(index.rank(expression(surface_tokens("quiet amber"), phrase=True)), ["adjacent"])
            self.assertEqual(set(index.rank(expression(surface_tokens("quiet amber")))), {"adjacent", "gap", "cross-field"})
        finally:
            index.close()

    def test_safe_literal_and_quote_do_not_admit_normalized_collisions(self):
        self.assertEqual(surface_priority([], ["exact"], ["collision", "exact"], "literal"), ["exact"])
        self.assertEqual(surface_priority([], ["phrase"], ["gap", "phrase"], "quoted"), ["phrase"])
        self.assertEqual(surface_priority(["marked"], ["marked"], ["unmarked", "marked"], "natural")[0], "marked")


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.enabled = ["en", "fr", "ko", "ja", "zh", "ar", "fa", "de"]
        self.config = {"confidence": 0.6, "minimum_letters": 20}

    def test_script_overrides_incompatible_cover_language(self):
        chosen = pick_language("서랍에는 작은 메모를 넣었습니다.", "en", {"language": "en", "confidence": 0.99}, self.enabled)
        self.assertEqual(chosen, "ko")

    def test_short_latin_query_uses_explicit_context_or_safe_unknown(self):
        self.assertEqual(pick_language("facture", "fr", {"language": "en", "confidence": 0.99}, self.enabled), "fr")
        self.assertEqual(pick_language("facture", None, {"language": "en", "confidence": 0.99}, self.enabled), "und")

    def test_long_confident_span_can_override_wrong_latin_context(self):
        text = "Les copies supplémentaires restent dans une petite boîte avec les étiquettes."
        self.assertEqual(pick_language(text, "en", {"language": "fr", "confidence": 0.9}, self.enabled), "fr")

    def test_fanout_is_script_bounded_and_includes_unknown_lane(self):
        query = {"text": "facture", "context_language": None, "language": "ko"}
        selected = query_languages("fanout", query, {}, self.enabled, self.config)
        self.assertEqual(set(selected), {"en", "fr", "de", "und"})
        self.assertNotIn("ko", selected)

    def test_truth_labels_do_not_select_runtime_routes(self):
        query = {"text": "facture", "context_language": "fr", "language": "ko"}
        a = query_languages("context-script", query, {}, self.enabled, self.config)
        query["language"] = "zh"
        self.assertEqual(a, query_languages("context-script", query, {}, self.enabled, self.config))
        doc = document("mixed", body="Some framing text.\n서랍에는 작은 메모를 넣었습니다.", truth_languages=["en", "ko"])
        a = document_units(doc, "context-script", {}, self.enabled, self.config)
        doc["truth_languages"] = ["fr"]
        self.assertEqual(a, document_units(doc, "context-script", {}, self.enabled, self.config))

    def test_script_spans_keep_japanese_han_and_kana_together(self):
        self.assertEqual(script_spans("引き出しにラベル"), ["引き出しにラベル"])
        self.assertEqual(len(script_spans("handover 서랍 note")), 3)


class MetricAndStatisticsTests(unittest.TestCase):
    def test_precision_bounds_do_not_call_compatible_alternatives_false(self):
        query = {"relevance": {"target": 3}, "compatible": ["alternative"]}
        result = score(["alternative", "target", "wrong"], query, {"target": {}})
        self.assertEqual(result["precisionLower@10"], 0.1)
        self.assertEqual(result["precisionUpper@10"], 0.2)
        self.assertEqual(result["confirmedNegativeCount@10"], 1)
        self.assertEqual(result["requiredMRR@10"], 0.5)
        self.assertEqual(result["condensedRequiredNDCG@10"], 1.0)

    def test_no_relevant_queries_report_false_results_without_undefined_recall(self):
        result = score(["wrong"], {"relevance": {}, "compatible": []}, {})
        self.assertEqual(result["noRelevantFalseResult"], 1)
        self.assertNotIn("requiredRecall@100", result)
        self.assertNotIn("precisionLower@10", result)
        self.assertEqual(score([], {"relevance": {}}, {})["noRelevantFalseResult"], 0)

    def test_rank_fusion_uses_rank_agreement_without_mixing_scores(self):
        self.assertEqual(rrf([["a", "b"], ["b", "c"]])[0], "b")
        self.assertEqual(len(rrf([["a", "a"]])), 1)

    def test_global_statistics_change_when_other_language_documents_are_added(self):
        documents = [document("target", body=""), document("local-noise", body="")]
        target = {"target": {"body": ["invoice"]}, "local-noise": {"body": ["garden"]}}
        local = Index(documents, target)
        foreign = [document("other-" + str(i), body="") for i in range(20)]
        pooled = Index(documents + foreign, {**target, **{row["id"]: {"body": ["note"]} for row in foreign}})
        try:
            sql = "SELECT bm25(f) FROM f WHERE f MATCH ?"
            before = local.db.execute(sql, (expression(["invoice"]),)).fetchone()[0]
            after = pooled.db.execute(sql, (expression(["invoice"]),)).fetchone()[0]
            self.assertNotEqual(before, after)
            self.assertEqual(local.rank(expression(["invoice"])), ["target"])
            self.assertEqual(pooled.rank(expression(["invoice"])), ["target"])
        finally:
            local.close()
            pooled.close()


class FixtureContractTests(unittest.TestCase):
    def test_structural_identifier_and_quote_judgments_are_exhaustive(self):
        fixture = json.loads(Path(__file__).with_name("fixtures.json").read_text())
        for split in fixture["splits"].values():
            documents = split["documents"]
            index = Index(documents, {row["id"]: {key: surface_tokens(value)
                for key, value in field_texts(row).items()} for row in documents})
            try:
                for query in split["queries"]:
                    if query_kind(query["text"]) in {"literal", "quoted"}:
                        with self.subTest(query=query["id"]):
                            matches = index.rank(expression(surface_tokens(query_body(query["text"])), phrase=True), len(documents))
                            self.assertEqual(set(matches), set(query["relevance"]))
            finally:
                index.close()

    def test_split_labels_and_references_are_valid(self):
        fixture = json.loads(Path(__file__).with_name("fixtures.json").read_text())
        summary = validate(fixture)
        self.assertEqual(summary["development"]["languages"], 30)
        self.assertEqual(summary["heldout"]["languages"], 30)
        self.assertGreater(summary["development"]["mixedDocuments"], 0)
        self.assertGreater(summary["heldout"]["noRelevantQueries"], 0)
        self.assertFalse({q["text"] for q in fixture["splits"]["development"]["queries"]} &
                         {q["text"] for q in fixture["splits"]["heldout"]["queries"]})

    def test_invalid_relevance_reference_is_rejected(self):
        fixture = json.loads(Path(__file__).with_name("fixtures.json").read_text())
        changed = copy.deepcopy(fixture)
        changed["splits"]["development"]["queries"][0]["relevance"]["missing"] = 3
        with self.assertRaises(ValueError):
            validate(changed)


if __name__ == "__main__":
    unittest.main()

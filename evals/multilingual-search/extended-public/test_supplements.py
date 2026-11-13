#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Synthetic behavioral checks for the optional predeclared supplements."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from supplements import prepare_lemma, prepare_stopwords


class SupplementalTests(unittest.TestCase):
    def test_stopwords_match_surfaces_and_preserve_quotes_and_empty_queries(self):
        queries = [
            {'id': 'a', 'split': 'test', 'subset': 'relevant', 'text': 'the runners run'},
            {'id': 'b', 'split': 'test', 'subset': 'relevant', 'text': '"the run"'},
            {'id': 'c', 'split': 'test', 'subset': 'non_relevant', 'text': 'the is'},
            {'id': 'd', 'split': 'dev', 'subset': 'relevant', 'text': 'not two'}]
        expected = [['the', 'run', 'run'], ['the', 'run'], ['the', 'is'], ['not', 'two']]

        def fake_probe(command, requests):
            records = []
            for request in requests:
                words = request['text'].lower().split()
                records.append({'fingerprint': 'fixed', 'tokens': [
                    {'text': 'run' if word == 'runners' else word, 'surface': word} for word in words]})
            return records, 0.0

        with tempfile.TemporaryDirectory(prefix='omnesis-stopword-method-') as directory:
            path = Path(directory) / 'stopwords.json'
            path.write_text(json.dumps({'version': '9.12.3', 'languages': {'en': {
                'words': ['the', 'is', 'RUN', 'not two'], 'status': 'available', 'analyzer': 'synthetic'}}}))
            args = SimpleNamespace(stopwords=path, prototype=Path('prototype'))
            with patch('supplements.probe', side_effect=fake_probe):
                filtered, profile = prepare_stopwords(args, 'en', queries, expected,
                    {'engineMetadata': {'fingerprint': 'fixed'}})
        self.assertEqual(filtered, [['run'], ['the', 'run'], ['the', 'is'], ['not', 'two']])
        self.assertEqual(profile['ignoredMultiTokenEntries'], 1)
        self.assertEqual(profile['perQueryFiltering'][0]['removedTokens'], 2)
        self.assertTrue(profile['perQueryFiltering'][1]['quotedUnchanged'])
        self.assertTrue(profile['perQueryFiltering'][2]['emptyFallback'])
        self.assertEqual(profile['perQueryFiltering'][2]['removedTokens'], 0)
        self.assertEqual(profile['perQueryFiltering'][2]['wouldRemoveTokens'], 2)

    @unittest.skipUnless(importlib.util.find_spec('simplemma'), 'optional Simplemma 2.0.0 is not installed')
    def test_dictionary_lemma_preserves_positions_and_unknown_words(self):
        with tempfile.TemporaryDirectory(prefix='omnesis-lemma-method-') as directory:
            root = Path(directory)
            (root / 'en').mkdir()
            exact = root / 'exact.jsonl'
            originals = [[['children'], ['mice']], [[], ['mice']], [[], ['notawordzz']]]
            exact.write_text(''.join(json.dumps(row) + '\n' for row in originals))
            args = SimpleNamespace(cache_dir=root)
            documents = [{'id': str(i)} for i in range(3)]
            queries = [{'id': 'a'}, {'id': 'b'}]
            path, transformed, profile = prepare_lemma(args, 'en', documents, queries, exact,
                [['children'], ['mice']])
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(rows[:3], [[['child'], ['mouse']], [[], ['mouse']], [[], ['notawordzz']]])
            self.assertEqual(transformed, [['child'], ['mouse']])
            self.assertEqual(profile['corpusDocuments'], 3)
            cached_path, cached_queries, cached = prepare_lemma(args, 'en', documents, queries, exact,
                [['children'], ['mice']])
            self.assertEqual(cached_path, path)
            self.assertEqual(cached_queries, transformed)
            self.assertTrue(cached['cacheHit'])


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Small synthetic checks for judgment accounting, calibration, fusion and MSM."""
import math
from pathlib import Path
import sqlite3
import tempfile
import unittest

from analysis import expression
from evaluate import ensure_coverage_extension, fuse, retrieve, tiers
from scoring import calibrate, retrieval_metrics


class MethodTests(unittest.TestCase):
    def test_all_positives_and_negatives(self):
        score = retrieval_metrics(['negative', 'a', 'unjudged', 'b'], {'a': 1, 'b': 1, 'negative': 0})
        self.assertEqual(score['Recall@100'], 1.0)
        self.assertEqual(score['MRR@10'], 0.5)
        expected = (1 / math.log2(3) + 1 / math.log2(5)) / (1 + 1 / math.log2(3))
        self.assertAlmostEqual(score['nDCG@10'], expected)
        self.assertIsNone(retrieval_metrics(['a'], {'a': 0}))

    def test_calibration_never_reads_heldout_scores(self):
        dev = [{'split': 'dev', 'subset': 'relevant', 'score': 0.7},
               {'split': 'dev', 'subset': 'non_relevant', 'score': 0.2}]
        expected = calibrate(dev)
        self.assertEqual(expected['threshold'], 0.7)
        self.assertEqual(expected['devBalancedAccuracy'], 1.0)
        self.assertEqual(calibrate(dev + [{'split': 'test', 'subset': 'non_relevant', 'score': 1000}]), expected)
        reject = calibrate([{'split': 'dev', 'subset': 'relevant', 'score': None},
                            {'split': 'dev', 'subset': 'non_relevant', 'score': None}])
        self.assertTrue(reject['rejectAll'])

    def test_fusion_uses_ranks_not_raw_scores(self):
        order = {'a': 0, 'b': 1, 'c': 2}
        stem = [('a', 10000), ('b', 2)]
        exact = [('b', 0.001), ('c', 0.00001)]
        first = fuse(stem, exact, 60, order)
        second = fuse([('a', 0.1), ('b', 0.01)], [('b', 800), ('c', 600)], 60, order)
        self.assertEqual(first, second)
        self.assertEqual(first[0][0], 'b')
        ranked = tiers(stem, [('c', 0.1)], [('b', 0.2)], order)
        self.assertEqual([row[0] for row in ranked], ['c', 'b', 'a'])

    def test_native_coverage_handles_fields_and_deduplication(self):
        with tempfile.TemporaryDirectory(prefix='omnesis-lexical-method-') as directory:
            extension = ensure_coverage_extension(Path(directory))
            with sqlite3.connect(':memory:') as db:
                db.enable_load_extension(True)
                db.load_extension(str(extension))
                db.enable_load_extension(False)
                db.execute('CREATE VIRTUAL TABLE f USING fts5(content,title)')
                tokens = [('a', 'b', 'c'), ('a', 'b'), ('a',), ('x',)]
                for rowid, row in enumerate(tokens, 1):
                    db.execute('INSERT INTO f(rowid,content,title) VALUES (?,?,?)',
                               (rowid, ' '.join('t' + token.encode().hex() for token in row[:-1]),
                                't' + row[-1].encode().hex()))
                expr = expression(['a', 'b', 'c', 'a'])
                result = retrieve(db, ['one', 'two', 'three', 'four'], expr, 100, coverage=2)
                self.assertEqual({docid for docid, _ in result}, {'one', 'two'})
                result = retrieve(db, ['one', 'two', 'three', 'four'], expression(['a', 'b'], phrase=True), 100)
                self.assertEqual([docid for docid, _ in result], ['one'])


if __name__ == '__main__':
    unittest.main()

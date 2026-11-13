#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Actual CLI/FTS5 controls with fresh invented Korean positive/negative text."""
import os
import json
from pathlib import Path
import sqlite3
import sys
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'extended-public'))
from analysis import encode, expression, sha  # noqa: E402
sys.path.insert(0, str(HERE.parent))
from run import probe  # noqa: E402


def analyzed(binary, texts, mode):
    records, _ = probe([binary], [{'text': text, 'language': 'ko', 'mode': mode} for text in texts])
    if any('error' in record for record in records):
        raise AssertionError('Control analysis returned an error')
    return records


def terms(record):
    return [token['text'] for token in record['tokens']]


def search(documents, query, phrase=False, operation='OR'):
    with sqlite3.connect(':memory:') as db:
        db.execute('CREATE VIRTUAL TABLE f USING fts5(content)')
        ids = list(documents)
        for rowid, record in enumerate(documents.values(), 1):
            db.execute('INSERT INTO f(rowid,content) VALUES (?,?)',
                       (rowid, ' '.join(map(encode, terms(record)))))
        query_expression = expression(terms(query), operation, phrase)
        return {ids[rowid - 1] for (rowid,) in db.execute('SELECT rowid FROM f WHERE f MATCH ?', (query_expression,))}


def trace(documents, records):
    indexed = dict(zip(documents, records[:-1], strict=True))
    query = records[-1]
    fields = ('text', 'surface', 'start', 'end', 'position', 'colocated', 'language', 'script', 'algorithm')
    return {'version': query['version'], 'fingerprint': query['fingerprint'],
        'documentTerms': {name: [{key: token[key] for key in fields if key in token} for token in record['tokens']]
                          for name, record in indexed.items()},
        'queryTerms': [{key: token[key] for key in fields if key in token} for token in query['tokens']],
        'candidateIds': {'or': sorted(search(indexed, query)),
                         'and': sorted(search(indexed, query, operation='AND')),
                         'phrase': sorted(search(indexed, query, phrase=True))}}


class KoreanCompoundControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.baseline = os.environ.get('KOREAN_BASELINE_PROBE')
        cls.challenger = os.environ.get('KOREAN_COMPOUND_PROBE')
        cls.controls = []
        if not cls.baseline or not cls.challenger:
            raise unittest.SkipTest('Set KOREAN_BASELINE_PROBE and KOREAN_COMPOUND_PROBE for actual CLI/FTS controls')

    @classmethod
    def tearDownClass(cls):
        target = os.environ.get('KOREAN_COMPOUND_CONTROLS')
        if target:
            path = Path(target).resolve()
            if path.is_relative_to(HERE.parents[2]):
                raise ValueError('Synthetic control reports must remain outside the checkout')
            path.parent.mkdir(parents=True, exist_ok=True)
            report = {'scope': 'Invented synthetic controls only, not public held-out corpus/query text',
                      'complete': len(cls.controls) == 2 and all(row['assertionsPassed'] for row in cls.controls),
                      'policySHA256': sha(HERE / 'policy.json'), 'sourceSHA256': sha(Path(__file__)),
                      'binarySHA256': {'original': sha(Path(cls.baseline)), 'challenger': sha(Path(cls.challenger))},
                      'controls': cls.controls}
            path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

    def test_issue902_phrase_prefix_preserved_by_general_metadata_expansion(self):
        docs = {'positive': '파란고래우체통입니다', 'post-office': '파란고래우체국입니다',
                'partial-one': '파란 고래 그림입니다',
                'partial-two': '고래 우체 업무입니다'}
        texts = [*docs.values(), '파란고래우체통']
        original = analyzed(self.baseline, texts, 'stem')
        changed = analyzed(self.challenger, texts, 'stem')
        original_exact = analyzed(self.baseline, texts, 'exact')
        changed_exact = analyzed(self.challenger, texts, 'exact')
        control = {'id': 'issue902-preservation', 'assertionsPassed': False,
            'original': {'stem': trace(docs, original), 'exact': trace(docs, original_exact)},
            'challenger': {'stem': trace(docs, changed), 'exact': trace(docs, changed_exact)}}
        self.controls.append(control)
        before = dict(zip(docs, original[:-1], strict=True))
        after = dict(zip(docs, changed[:-1], strict=True))
        self.assertIn('positive', search(before, original[-1], phrase=True))
        for documents, query in [(before, original[-1]), (after, changed[-1])]:
            self.assertIn('post-office', search(documents, query))
            self.assertNotIn('post-office', search(documents, query, operation='AND'))
            self.assertNotIn('post-office', search(documents, query, phrase=True))
        self.assertEqual(search(after, changed[-1], phrase=True), {'positive'})
        self.assertEqual(search(after, changed[-1], operation='AND'), {'positive'})
        self.assertNotEqual(original[-1]['fingerprint'], changed[-1]['fingerprint'])
        self.assertEqual([terms(record) for record in original_exact], [terms(record) for record in changed_exact])
        control['assertionsPassed'] = True

    def test_ticket_inflection_whole_word_evidence_and_nonadjacent_negatives(self):
        docs = {'whole': '승차권', 'inflected': '승차권을 확인합니다', 'adjacent-parts': '승차 권',
                'nonadjacent-parts': '승차 기록 권', 'left-only': '승차', 'right-only': '권'}
        texts = [*docs.values(), '승차권']
        original_stem = analyzed(self.baseline, texts, 'stem')
        changed_stem = analyzed(self.challenger, texts, 'stem')
        original_exact = analyzed(self.baseline, texts, 'exact')
        changed_exact = analyzed(self.challenger, texts, 'exact')
        control = {'id': 'ticket-inflection-and-precision', 'assertionsPassed': False,
            'original': {'stem': trace(docs, original_stem), 'exact': trace(docs, original_exact)},
            'challenger': {'stem': trace(docs, changed_stem), 'exact': trace(docs, changed_exact)}}
        self.controls.append(control)
        self.assertEqual([terms(record) for record in original_exact], [terms(record) for record in changed_exact])
        self.assertEqual(terms(changed_stem[-1]), ['승차', '권'])
        original_docs = dict(zip(docs, original_stem[:-1], strict=True))
        changed_docs = dict(zip(docs, changed_stem[:-1], strict=True))
        exact_docs = dict(zip(docs, changed_exact[:-1], strict=True))
        self.assertNotIn('inflected', search(original_docs, original_stem[-1], operation='AND'))
        self.assertIn('inflected', search(changed_docs, changed_stem[-1], operation='AND'))
        stem_phrase = search(changed_docs, changed_stem[-1], phrase=True)
        self.assertIn('inflected', stem_phrase)
        self.assertNotIn('nonadjacent-parts', stem_phrase)
        # Constituent expansion can match adjacent separate words. Expose this
        # precision risk rather than claiming decomposition is always exact.
        self.assertIn('adjacent-parts', stem_phrase)
        precise = search(exact_docs, changed_exact[-1], phrase=True)
        self.assertIn('whole', precise)
        self.assertNotIn('adjacent-parts', precise)
        self.assertNotIn('nonadjacent-parts', precise)
        control['assertionsPassed'] = True


if __name__ == '__main__':
    unittest.main()

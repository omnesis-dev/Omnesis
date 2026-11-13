# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Actual Lucene integration controls, using only invented text."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SEED = 'omnesis-lexical-heldout-v1-2026-11-13'


class BatchReferenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.classpath = os.environ.get('LUCENE_TEST_CLASSPATH')
        if not cls.classpath:
            raise unittest.SkipTest('Set LUCENE_TEST_CLASSPATH from prepare-batch.py for actual reference tests')

    def test_graph_aware_queries_phrases_stemming_and_ties(self):
        documents = [
            {'id': 'a', 'title': '', 'text': 'quartz harbor'},
            {'id': 'b', 'title': 'quartz harbor', 'text': 'plain record'},
            {'id': 'c', 'title': '', 'text': 'quartz distant harbor'},
            {'id': 'd', 'title': '', 'text': 'archival record'},
            {'id': 'e', 'title': 'morning', 'text': 'running quickly'},
            {'id': 'f', 'title': '', 'text': 'identical tie marker'},
            {'id': 'g', 'title': '', 'text': 'identical tie marker'},
        ]
        queries = [
            {'id': 'terms', 'text': 'quartz harbor', 'split': 'test', 'subset': 'relevant'},
            {'id': 'phrase', 'text': '"quartz harbor"', 'split': 'test', 'subset': 'relevant'},
            {'id': 'stem', 'text': 'runs', 'split': 'test', 'subset': 'relevant'},
            {'id': 'none', 'text': 'quasar', 'split': 'test', 'subset': 'non_relevant'},
            {'id': 'stop', 'text': 'the and', 'split': 'test', 'subset': 'non_relevant'},
            {'id': 'ties', 'text': 'marker', 'split': 'test', 'subset': 'relevant'},
        ]
        with tempfile.TemporaryDirectory(prefix='lucene-batch-test-') as directory:
            directory = Path(directory)
            docs, topics, output = directory / 'docs.jsonl', directory / 'queries.jsonl', directory / 'report.json'
            docs.write_text(''.join(json.dumps(row) + '\n' for row in documents))
            topics.write_text(''.join(json.dumps(row) + '\n' for row in queries))
            subprocess.run(['java', '-Xmx512m', '-XX:ActiveProcessorCount=2', '-cp', self.classpath,
                            'LuceneBatch', 'en', str(docs), str(topics), '7', str(directory / 'index'), str(output)], check=True)
            report = json.loads(output.read_text())
            rows = {row['id']: row for row in report['rows']}
            self.assertEqual(set(rows['terms']['ranking']), {'a', 'b', 'c'})
            self.assertEqual(set(rows['phrase']['ranking']), {'a', 'b'})
            self.assertEqual(rows['stem']['ranking'], ['e'])
            self.assertEqual(rows['none']['ranking'], [])
            self.assertEqual(rows['stop']['ranking'], [])
            expected = sorted(['f', 'g'], key=lambda value: hashlib.sha256(f'{SEED}|en|{value}'.encode()).hexdigest())
            self.assertEqual(rows['ties']['ranking'], expected)
            self.assertNotIn('quartz', output.read_text())

    def test_exported_stopwords_are_explicit_by_language(self):
        with tempfile.TemporaryDirectory(prefix='lucene-stopwords-test-') as directory:
            output = Path(directory) / 'stops.json'
            subprocess.run(['java', '-Xmx512m', '-XX:ActiveProcessorCount=2', '-cp', self.classpath,
                            'LuceneBatch', '--stopwords', str(output)], check=True)
            report = json.loads(output.read_text())
            self.assertEqual(len(report['languages']), 17)
            self.assertEqual(report['version'], '9.12.3')
            self.assertIn('the', report['languages']['en']['words'])
            self.assertEqual(report['languages']['ko']['status'], 'unsupported')
            for entry in report['languages'].values():
                self.assertIn(entry['status'], ['available', 'empty', 'unsupported'])
                self.assertEqual(entry['words'], sorted(set(entry['words'])))


if __name__ == '__main__':
    unittest.main()

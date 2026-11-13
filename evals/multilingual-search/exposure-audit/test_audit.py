# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Metadata-only deduplication preserves content distinctions while folding format."""
import unittest
from audit import normalized, punctuation_insensitive


class ExposureNormalizationTests(unittest.TestCase):
    def test_compatibility_case_and_unicode_whitespace(self):
        self.assertEqual(normalized('FLAT\u00a0Ｔｅｓｔ\u2028'), 'flat test')
        self.assertEqual(normalized('flat test'), 'flat test')

    def test_punctuation_is_only_removed_in_conservative_second_form(self):
        self.assertNotEqual(normalized('flat, test?'), normalized('flat test'))
        self.assertEqual(punctuation_insensitive('flat, test?'), punctuation_insensitive('flat test'))

    def test_accent_and_letter_marks_remain_distinct(self):
        self.assertNotEqual(normalized('café'), normalized('cafe'))
        self.assertNotEqual(punctuation_insensitive('café'), punctuation_insensitive('cafe'))
        self.assertNotEqual(punctuation_insensitive('क'), punctuation_insensitive('कि'))


if __name__ == '__main__':
    unittest.main()

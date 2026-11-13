# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Optional dictionary-lemmatization challenger; not a runtime dependency."""

import importlib.metadata
import unicodedata


class Lemmatizer:
    def __init__(self):
        from simplemma import Lemmatizer as Simplemma
        from simplemma.strategies import DefaultStrategy
        from simplemma.strategies.dictionaries.dictionary_factory import DefaultDictionaryFactory, SUPPORTED_LANGUAGES

        self.supported = SUPPORTED_LANGUAGES
        self.version = importlib.metadata.version("simplemma")
        # One cache for the full experiment avoids thrashing its default
        # eight-language dictionary cache during multilingual query fanout.
        factory = DefaultDictionaryFactory(cache_max_size=len(self.supported))
        self.engine = Simplemma(lemmatization_strategy=DefaultStrategy(dictionary_factory=factory))
        self.unsupported = set()

    def lemma(self, word, language):
        if language not in self.supported:
            self.unsupported.add(language)
            return word
        return self.engine.lemmatize(unicodedata.normalize("NFC", word), lang=language).lower()

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

use std::borrow::Cow;

use charabia::{normalizer::NormalizerOption, Normalize, Script, StrDetection, TokenizerBuilder};
use frostem::Stemmer;
use icu_casemap::CaseMapper;
use icu_normalizer::ComposingNormalizer;
use icu_segmenter::{options::WordBreakOptions, WordSegmenter};
use serde::Serialize;

use crate::config::{
    charabia_language, Config, Mode, SegmenterMode, ANALYZER_VERSION, DEPENDENCIES,
    KOREAN_DICTIONARY_SHA256, SNOWBALL_COMMIT,
};

#[derive(Debug, Serialize)]
pub struct AnalyzedToken {
    pub text: String,
    pub surface: String,
    pub start: usize,
    pub end: usize,
    pub position: usize,
    pub colocated: bool,
    pub language: String,
    pub script: String,
    pub algorithm: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Analysis {
    pub tokens: Vec<AnalyzedToken>,
    pub language: String,
    pub fingerprint: String,
    pub version: &'static str,
    pub dependencies: &'static str,
    pub snowball_commit: &'static str,
    pub korean_dictionary_sha256: &'static str,
    pub mode: Mode,
    pub segmenter: SegmenterMode,
    pub offset_unit: &'static str,
    pub prefix_last: bool,
}

struct Segment<'a> {
    source: &'a str,
    start: usize,
    end: usize,
    script: Script,
}

fn detect_script(text: &str) -> Script {
    StrDetection::new(text, None).script()
}

fn matches_language_script(language: &str, script: Script) -> bool {
    match language {
        "ko" => script == Script::Hangul,
        "zh" | "ja" => script == Script::Cj,
        "ar" | "fa" | "ur" => script == Script::Arabic,
        "he" | "yi" => script == Script::Hebrew,
        "ru" | "uk" | "bg" | "be" | "mk" => script == Script::Cyrillic,
        "sr" => matches!(script, Script::Latin | Script::Cyrillic),
        "el" => script == Script::Greek,
        "hi" | "ne" | "mr" => script == Script::Devanagari,
        "hy" => script == Script::Armenian,
        "ta" => script == Script::Tamil,
        "th" => script == Script::Thai,
        "km" => script == Script::Khmer,
        "ka" => script == Script::Georgian,
        "bn" => script == Script::Bengali,
        "my" => script == Script::Myanmar,
        "und" => false,
        _ => script == Script::Latin,
    }
}

fn token_language<'a>(configured: &'a str, script: Script) -> &'a str {
    if script == Script::Hangul {
        "ko"
    } else if matches_language_script(configured, script) {
        configured
    } else {
        "und"
    }
}

fn segment<'a>(text: &'a str, config: &Config) -> Result<Vec<Segment<'a>>, String> {
    let mut options = WordBreakOptions::default();
    options.content_locale = Some(&config.language);
    let segmenter = match config.segmenter {
        SegmenterMode::Auto => WordSegmenter::try_new_auto(options),
        SegmenterMode::Dictionary => WordSegmenter::try_new_dictionary(options),
    }
    .map_err(|error| error.to_string())?;
    let configured = config.language.language.as_str();
    let mut segments = Vec::new();
    let mut start = 0;
    for (end, word_type) in segmenter
        .as_borrowed()
        .segment_str(text)
        .iter_with_word_type()
    {
        let source = &text[start..end];
        // Preserve letter-bearing segments whose trailing combining marks cause
        // ICU4X word status to classify them as nonwords before whitespace.
        if end > start && (word_type.is_word_like() || source.chars().any(char::is_alphanumeric)) {
            let script = detect_script(source);
            let language = token_language(configured, script);
            if script == Script::Hangul || (script == Script::Latin && language == "de") {
                let hints: Vec<_> = charabia_language(language).into_iter().collect();
                let mut builder = TokenizerBuilder::default();
                if !hints.is_empty() {
                    builder.allow_list(&hints);
                }
                let tokenizer = builder.build();
                for token in tokenizer.segment(source) {
                    let value = &source[token.byte_start..token.byte_end];
                    if value.chars().any(char::is_alphanumeric) {
                        segments.push(Segment {
                            source: value,
                            start: start + token.byte_start,
                            end: start + token.byte_end,
                            script: detect_script(value),
                        });
                    }
                }
            } else {
                segments.push(Segment {
                    source,
                    start,
                    end,
                    script,
                });
            }
        }
        start = end;
    }
    Ok(segments)
}

pub fn analyze(text: &str, config: &Config, prefix_last: bool) -> Result<Analysis, String> {
    let segments = segment(text, config)?;
    let normalizer = ComposingNormalizer::new_nfkc();
    let case_mapper = CaseMapper::new();
    let configured = config.language.language.as_str();
    let mut tokens = Vec::with_capacity(segments.len());
    let last = segments.len().saturating_sub(1);
    for (index, segment) in segments.into_iter().enumerate() {
        let language = token_language(configured, segment.script);
        let normalized = normalizer.normalize(segment.source);
        let lowercased = case_mapper.lowercase_to_string(&normalized, &config.language);
        let surfaces: Vec<_> = lowercased.split_ascii_whitespace().collect();
        let last_surface = surfaces.len().saturating_sub(1);
        for (surface_index, surface) in surfaces.into_iter().enumerate() {
            let surface = surface.to_string();
            let stemmer = if config.mode == Mode::Stem
                && !(prefix_last && index == last && surface_index == last_surface)
            {
                Stemmer::try_from_name(language).ok()
            } else {
                None
            };
            let stemmed = stemmer
                .as_ref()
                .map(|stemmer| stemmer.stem(&surface))
                .unwrap_or(Cow::Borrowed(&surface));
            // An empty stem must not erase a position and accidentally turn a
            // nonadjacent phrase into an adjacent phrase.
            let stemmed = if stemmed.is_empty() {
                Cow::Borrowed(surface.as_str())
            } else {
                stemmed
            };
            let lemma = if config.mode == Mode::Stem {
                let token = charabia::Token {
                    lemma: Cow::Owned(stemmed.into_owned()),
                    script: segment.script,
                    language: charabia_language(language),
                    ..Default::default()
                }
                .normalize(&NormalizerOption {
                    lossy: true,
                    ..Default::default()
                });
                normalizer.normalize(token.lemma()).into_owned()
            } else {
                surface.clone()
            };
            let lemma = if lemma.is_empty() {
                surface.clone()
            } else {
                lemma
            };
            if lemma
                .chars()
                .any(|value| value.is_ascii_whitespace() || value == '\0')
            {
                return Err("Analyzed terms cannot contain ASCII whitespace or NUL".into());
            }
            tokens.push(AnalyzedToken {
                text: lemma,
                surface,
                start: segment.start,
                end: segment.end,
                position: tokens.len(),
                colocated: false,
                language: language.to_string(),
                script: format!("{:?}", segment.script),
                algorithm: stemmer.map(|stemmer| stemmer.algorithm().name().to_string()),
            });
        }
    }
    Ok(Analysis {
        tokens,
        language: config.language.to_string(),
        fingerprint: config.fingerprint(),
        version: ANALYZER_VERSION,
        dependencies: DEPENDENCIES,
        snowball_commit: SNOWBALL_COMMIT,
        korean_dictionary_sha256: KOREAN_DICTIONARY_SHA256,
        mode: config.mode,
        segmenter: config.segmenter,
        offset_unit: "utf8_bytes",
        prefix_last,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(language: &str, mode: Mode) -> Config {
        Config::new(language, mode, SegmenterMode::Dictionary).unwrap()
    }

    fn terms(text: &str, language: &str, mode: Mode) -> Vec<String> {
        analyze(text, &config(language, mode), false)
            .unwrap()
            .tokens
            .into_iter()
            .map(|token| token.text)
            .collect()
    }

    #[test]
    fn korean_suffix_and_query_share_adjacent_terms_and_original_offsets() {
        let document = analyze("파란고래우체통입니다", &config("en", Mode::Stem), false).unwrap();
        let query = terms("파란고래우체통", "ko", Mode::Stem);
        assert_eq!(query, vec!["파란", "고래", "우체통"]);
        assert_eq!(
            document
                .tokens
                .iter()
                .take(3)
                .map(|token| &token.text)
                .collect::<Vec<_>>(),
            query.iter().collect::<Vec<_>>()
        );
        assert_eq!(document.tokens[2].start, 12);
        assert_eq!(document.tokens[2].end, 21);
        assert!(document
            .tokens
            .iter()
            .all(|token| token.language == "ko" && token.algorithm.is_none()));
    }

    #[test]
    fn exact_and_stem_lanes_have_distinct_terms_and_fingerprints() {
        assert_eq!(terms("recipes", "en", Mode::Exact), vec!["recipes"]);
        assert_eq!(terms("recipes", "en", Mode::Stem), vec!["recip"]);
        assert_ne!(
            config("en", Mode::Exact).fingerprint(),
            config("en", Mode::Stem).fingerprint()
        );
        assert_eq!(
            config("fra", Mode::Stem).fingerprint(),
            config("fr", Mode::Stem).fingerprint()
        );
    }

    #[test]
    fn icu_handles_missing_cjk_dictionaries_and_preserves_indic_words() {
        assert!(terms("商店今天出售新鲜苹果", "zh", Mode::Exact).contains(&"苹果".into()));
        assert!(terms("日本語の検索", "ja", Mode::Exact).contains(&"検索".into()));
        assert_eq!(terms("किताबों में चित्र हैं", "hi", Mode::Exact).len(), 4);
    }

    #[test]
    fn configured_language_does_not_stem_another_script() {
        let answer = analyze("recipes 우산을", &config("en", Mode::Stem), false).unwrap();
        assert_eq!(answer.tokens[0].text, "recip");
        assert!(answer
            .tokens
            .iter()
            .skip(1)
            .all(|token| token.language == "ko"));
        let russian = analyze("машины", &config("fr", Mode::Stem), false).unwrap();
        assert!(russian.tokens.iter().all(|token| token.algorithm.is_none()));
    }

    #[test]
    fn locale_casing_german_compounds_and_prefix_normalization() {
        assert_eq!(terms("I İ", "tr", Mode::Exact), vec!["ı", "i"]);
        assert_eq!(
            terms("Krankenhausverwaltung", "de", Mode::Exact),
            vec!["kranken", "haus", "verwaltung"]
        );
        let prefix = analyze("recipes", &config("en", Mode::Stem), true).unwrap();
        assert_eq!(prefix.tokens[0].text, "recipes");
    }

    #[test]
    fn locale_override_changes_analysis_and_invalid_identifiers_fail() {
        let base = config("en", Mode::Stem);
        assert_eq!(
            base.with_locale(Some("fr-FR"))
                .unwrap()
                .language
                .to_string(),
            "fr-FR"
        );
        assert_eq!(
            base.with_locale(None).unwrap().fingerprint(),
            base.fingerprint()
        );
        assert!(Config::new("fr\0en", Mode::Stem, SegmenterMode::Auto).is_err());
        assert!(terms("  !!! 😀", "en", Mode::Exact).is_empty());
    }

    #[test]
    fn compatibility_expansion_keeps_flat_positions_and_original_offsets() {
        let result = analyze("ﷺ", &config("ar", Mode::Exact), false).unwrap();
        assert_eq!(
            result
                .tokens
                .iter()
                .map(|token| token.text.as_str())
                .collect::<Vec<_>>(),
            vec!["صلى", "الله", "عليه", "وسلم"]
        );
        assert!(result
            .tokens
            .iter()
            .all(|token| token.start == 0 && token.end == 3 && !token.colocated));
        assert_eq!(
            result
                .tokens
                .iter()
                .map(|token| token.position)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
    }
}

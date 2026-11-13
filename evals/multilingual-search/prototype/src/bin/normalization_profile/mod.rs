// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

//! Explicit French/Persian preprocessing ablations, separate from frozen analysis.

use std::borrow::Cow;
use std::io::{self, BufRead, Write};

use charabia::{normalizer::NormalizerOption, Language, Normalize, Script, TokenizerBuilder};
use frostem::Stemmer;
use icu_casemap::CaseMapper;
use icu_normalizer::ComposingNormalizer;
use icu_segmenter::GraphemeClusterSegmenter;
use omnesis_multilingual_core::{
    analyze, Analysis, AnalyzedToken, Config, Folding, Mode, SegmenterMode,
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

// Each executable selects one variant; the shared tests exercise both.
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    BoundaryOnly,
    LanguageNorm,
}

impl Profile {
    fn name(self) -> &'static str {
        match self {
            Self::BoundaryOnly => "boundary-only",
            Self::LanguageNorm => "language-norm",
        }
    }

    fn version(self) -> &'static str {
        match self {
            Self::BoundaryOnly => "omnesis-boundary-profile-v1",
            Self::LanguageNorm => "omnesis-language-norm-v1",
        }
    }
}

#[derive(Deserialize)]
struct Request {
    text: String,
    language: Option<String>,
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    segmenter: SegmenterMode,
    #[serde(default)]
    folding: Folding,
    #[serde(default)]
    prefix: bool,
}

struct SpanMap {
    identity: bool,
    boundaries: Vec<(usize, usize)>,
}

impl SpanMap {
    fn new(original: &str, surface: &str, config: &Config) -> Option<Self> {
        if original == surface {
            return Some(Self {
                identity: true,
                boundaries: Vec::new(),
            });
        }
        let normalizer = ComposingNormalizer::new_nfkc();
        let mapper = CaseMapper::new();
        let points: Vec<_> = GraphemeClusterSegmenter::new()
            .segment_str(original)
            .collect();
        let mut normalized = String::new();
        let mut boundaries = vec![(0, 0)];
        for pair in points.windows(2) {
            let value = normalizer.normalize(&original[pair[0]..pair[1]]);
            normalized.push_str(&mapper.lowercase_to_string(&value, &config.language));
            boundaries.push((normalized.len(), pair[1]));
        }
        (normalized == surface).then_some(Self {
            identity: false,
            boundaries,
        })
    }

    fn range(&self, surface: &str, start: usize, end: usize) -> Option<(usize, usize)> {
        if start >= end || !surface.is_char_boundary(start) || !surface.is_char_boundary(end) {
            return None;
        }
        if self.identity {
            return Some((start, end));
        }
        let start = self.boundaries.iter().find(|point| point.0 == start)?.1;
        let end = self.boundaries.iter().find(|point| point.0 == end)?.1;
        (start < end).then_some((start, end))
    }
}

fn target(token: &AnalyzedToken, config: &Config) -> Option<(Language, Script)> {
    match config.language.language.as_str() {
        "fr" if token.language == "fr" && token.script == "Latin" => {
            Some((Language::Fra, Script::Latin))
        }
        "fa" if token.language == "fa" && token.script == "Arabic" => {
            Some((Language::Pes, Script::Arabic))
        }
        _ => None,
    }
}

fn preprocess(
    token: &AnalyzedToken,
    text: &str,
    config: &Config,
    profile: Profile,
    skip_last_stem: bool,
) -> Option<Vec<AnalyzedToken>> {
    let (language, expected_script) = target(token, config)?;
    let original = text.get(token.start..token.end)?;
    let mapping = SpanMap::new(original, &token.surface, config)?;
    let hints = [language];
    let mut builder = TokenizerBuilder::default();
    builder.allow_list(&hints);
    let tokenizer = builder.build();
    let raw: Vec<_> = tokenizer
        .segment(&token.surface)
        .filter(|part| part.lemma().chars().any(char::is_alphanumeric))
        .collect();
    if raw.is_empty() {
        return None;
    }
    // Reject mixed-script spans rather than applying a language profile to a
    // foreign-script child that only happened to share the original ICU word.
    if raw.iter().any(|part| part.script != expected_script) {
        return None;
    }
    let final_index = raw.len() - 1;
    let normalizer = ComposingNormalizer::new_nfkc();
    let mapper = CaseMapper::new();
    let stemmer = Stemmer::try_from_name(config.language.language.as_str()).ok()?;
    let mut result = Vec::with_capacity(raw.len());
    for (index, part) in raw.into_iter().enumerate() {
        let (start, end) = mapping.range(&token.surface, part.byte_start, part.byte_end)?;
        let source = token.surface.get(part.byte_start..part.byte_end)?;
        let surface = mapper
            .lowercase_to_string(&normalizer.normalize(source), &config.language)
            .into_owned();
        let before_stemming = match profile {
            Profile::BoundaryOnly => surface.clone(),
            Profile::LanguageNorm => part
                .normalize(&NormalizerOption {
                    lossy: true,
                    ..Default::default()
                })
                .lemma()
                .to_string(),
        };
        let before_stemming = if before_stemming.is_empty() {
            surface.clone()
        } else {
            before_stemming
        };
        let stem = if skip_last_stem && index == final_index {
            Cow::Borrowed(before_stemming.as_str())
        } else {
            stemmer.stem(&before_stemming)
        };
        let term = if stem.is_empty() {
            before_stemming.as_str()
        } else {
            stem.as_ref()
        };
        let term = normalizer.normalize(term).into_owned();
        if term.is_empty()
            || term
                .chars()
                .any(|value| value.is_ascii_whitespace() || value == '\0')
        {
            return None;
        }
        result.push(AnalyzedToken {
            text: term,
            surface,
            start: token.start + start,
            end: token.start + end,
            position: 0,
            colocated: false,
            language: config.language.language.to_string(),
            script: format!("{:?}", expected_script),
            algorithm: (!(skip_last_stem && index == final_index))
                .then(|| stemmer.algorithm().name().to_string()),
        });
    }
    Some(result)
}

fn apply(
    text: &str,
    config: &Config,
    profile: Profile,
    prefix: bool,
) -> Result<(Analysis, usize), String> {
    if config.folding != Folding::None {
        return Err("Language profiles support request folding=none only".into());
    }
    let mut analysis = analyze(text, config, prefix)?;
    let mut hash = Sha256::new();
    hash.update(analysis.fingerprint.as_bytes());
    hash.update(profile.name().as_bytes());
    hash.update(include_bytes!("mod.rs"));
    hash.update(include_bytes!("../omnesis-boundary-profile-probe.rs"));
    hash.update(include_bytes!("../omnesis-language-norm-probe.rs"));
    hash.update(include_bytes!("../../../normalization-policy.json"));
    analysis.fingerprint = format!("{}:{:x}", profile.version(), hash.finalize());
    analysis.version = profile.version();
    let last = analysis.tokens.len().saturating_sub(1);
    let mut output = Vec::new();
    let mut processed = 0;
    for (index, token) in analysis.tokens.into_iter().enumerate() {
        if config.mode == Mode::Stem {
            if let Some(parts) = preprocess(&token, text, config, profile, prefix && index == last)
            {
                processed += 1;
                output.extend(parts);
                continue;
            }
        }
        output.push(token);
    }
    for (position, token) in output.iter_mut().enumerate() {
        token.position = position;
    }
    analysis.tokens = output;
    Ok((analysis, processed))
}

pub fn run(profile: Profile) -> Result<(), Box<dyn std::error::Error>> {
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let config = Config::new(
            request.language.as_deref().unwrap_or("und"),
            request.mode,
            request.segmenter,
        )?
        .with_folding(request.folding);
        let (analysis, processed) = apply(&request.text, &config, profile, request.prefix)?;
        let mut response = serde_json::to_value(analysis)?;
        response["normalization"] = json!({"profile": profile.name(), "scope": "configured French Latin / Persian Arabic stem spans only", "processed_spans": processed,
            "lossy": profile == Profile::LanguageNorm && processed > 0,
            "protocol_sha256": format!("{:x}", Sha256::digest(include_bytes!("../../../normalization-policy.json")))});
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(&mut stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(language: &str, mode: Mode) -> Config {
        Config::new(language, mode, SegmenterMode::Dictionary).unwrap()
    }
    fn analyze_profile(text: &str, language: &str, profile: Profile) -> Analysis {
        apply(text, &config(language, Mode::Stem), profile, false)
            .unwrap()
            .0
    }
    fn terms(analysis: &Analysis) -> Vec<&str> {
        analysis
            .tokens
            .iter()
            .map(|token| token.text.as_str())
            .collect()
    }

    #[test]
    fn french_apostrophes_are_boundaries_before_stemming() {
        for profile in [Profile::BoundaryOnly, Profile::LanguageNorm] {
            assert_eq!(
                terms(&analyze_profile("l’avion", "fr", profile)),
                vec!["l", "avion"]
            );
            assert_eq!(
                terms(&analyze_profile("l'avion", "fr", profile)),
                vec!["l", "avion"]
            );
        }
    }

    #[test]
    fn only_explicit_language_norm_folds_french_ligatures_and_marks() {
        for (marked, plain) in [
            ("œuf", "oeuf"),
            ("cœur", "coeur"),
            ("hôpital", "hopital"),
            ("côte", "cote"),
        ] {
            assert_ne!(
                terms(&analyze_profile(marked, "fr", Profile::BoundaryOnly)),
                terms(&analyze_profile(plain, "fr", Profile::BoundaryOnly))
            );
            assert_eq!(
                terms(&analyze_profile(marked, "fr", Profile::LanguageNorm)),
                terms(&analyze_profile(plain, "fr", Profile::LanguageNorm))
            );
        }
    }

    #[test]
    fn persian_halfspace_segmentation_is_explicit_and_kaf_yeh_already_stem_equivalent() {
        for profile in [Profile::BoundaryOnly, Profile::LanguageNorm] {
            assert_eq!(
                terms(&analyze_profile("می‌روم", "fa", profile)),
                vec!["می", "روم"]
            );
            assert_eq!(
                terms(&analyze_profile("نمی‌روم", "fa", profile)),
                vec!["نمی", "روم"]
            );
            assert_eq!(
                terms(&analyze_profile("كتاب", "fa", profile)),
                terms(&analyze_profile("کتاب", "fa", profile))
            );
            assert_eq!(
                terms(&analyze_profile("علي", "fa", profile)),
                terms(&analyze_profile("علی", "fa", profile))
            );
        }
    }

    #[test]
    fn persian_marks_and_digits_normalize_only_in_selected_profile() {
        assert_ne!(
            terms(&analyze_profile("کِتاب", "fa", Profile::BoundaryOnly)),
            terms(&analyze_profile("کتاب", "fa", Profile::BoundaryOnly))
        );
        assert_eq!(
            terms(&analyze_profile("کِتاب", "fa", Profile::LanguageNorm)),
            terms(&analyze_profile("کتاب", "fa", Profile::LanguageNorm))
        );
        assert_eq!(
            terms(&analyze_profile("۱۲۳", "fa", Profile::LanguageNorm)),
            vec!["123"]
        );
        assert_eq!(
            terms(&analyze_profile("۱۲۳", "fa", Profile::BoundaryOnly)),
            vec!["۱۲۳"]
        );
    }

    #[test]
    fn exact_other_languages_and_other_scripts_are_unchanged() {
        for profile in [Profile::BoundaryOnly, Profile::LanguageNorm] {
            for (text, language, mode) in [
                ("L’avion côte کِتاب", "fr", Mode::Exact),
                ("کِتاب ۱۲۳", "fa", Mode::Exact),
                ("má ọ̀kọ̀", "vi", Mode::Stem),
                ("کِتاب", "fr", Mode::Stem),
                ("côte", "fa", Mode::Stem),
            ] {
                let config = config(language, mode);
                assert_eq!(
                    serde_json::to_value(analyze(text, &config, false).unwrap().tokens).unwrap(),
                    serde_json::to_value(apply(text, &config, profile, false).unwrap().0.tokens)
                        .unwrap()
                );
            }
        }
    }

    #[test]
    fn original_unicode_offsets_positions_and_prefix_stemming_are_preserved() {
        for profile in [Profile::BoundaryOnly, Profile::LanguageNorm] {
            for (text, language) in [("L’AVION cafe\u{301}", "fr"), ("می‌روم کِتاب", "fa")]
            {
                let answer = analyze_profile(text, language, profile);
                assert!(answer
                    .tokens
                    .iter()
                    .enumerate()
                    .all(|(index, token)| token.position == index
                        && !token.colocated
                        && token.start < token.end
                        && text.is_char_boundary(token.start)
                        && text.is_char_boundary(token.end)
                        && token.end <= text.len()));
            }
            let (answer, _) = apply("l’avions", &config("fr", Mode::Stem), profile, true).unwrap();
            assert_eq!(terms(&answer), vec!["l", "avions"]);
            assert!(answer.tokens.last().unwrap().algorithm.is_none());
        }
        assert_ne!(
            analyze_profile("avion", "fr", Profile::BoundaryOnly).fingerprint,
            analyze_profile("avion", "fr", Profile::LanguageNorm).fingerprint
        );
    }
}

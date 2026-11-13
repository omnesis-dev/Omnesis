// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

//! Separate single-path Korean compound challenger; frozen core sources are unchanged.

use std::borrow::Cow;
use std::io::{self, BufRead, Write};
use std::sync::LazyLock;

use charabia::StrDetection;
use icu_normalizer::ComposingNormalizer;
use icu_segmenter::GraphemeClusterSegmenter;
use lindera::dictionary::{load_embedded_dictionary, DictionaryKind};
use lindera::mode::Mode as LinderaMode;
use lindera::segmenter::Segmenter;
use omnesis_multilingual_core::{
    analyze, Analysis, AnalyzedToken, Config, Folding, Mode, SegmenterMode,
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

const VERSION: &str = "omnesis-korean-compound-v1";
static SEGMENTER: LazyLock<Segmenter> = LazyLock::new(|| {
    Segmenter::new(
        LinderaMode::Normal,
        load_embedded_dictionary(DictionaryKind::KoDic).expect("pinned Korean dictionary"),
        None,
    )
});

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

fn parse_components(surface: &str, kind: &str, expression: &str) -> Option<Vec<String>> {
    if kind != "Compound" {
        return None;
    }
    let components: Option<Vec<_>> = expression
        .split('+')
        .map(|component| {
            let fields: Vec<_> = component.split('/').collect();
            if fields.len() != 3
                || fields.iter().any(|field| field.is_empty())
                || fields[0]
                    .chars()
                    .any(|value| value.is_whitespace() || value == '\0')
                || !fields[1]
                    .chars()
                    .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit())
            {
                return None;
            }
            Some(fields[0].to_string())
        })
        .collect();
    let components = components?;
    if components.len() < 2 || components.concat() != surface {
        return None;
    }
    Some(components)
}

fn original_boundaries(original: &str, surface: &str) -> Option<Vec<(usize, usize)>> {
    let normalizer = ComposingNormalizer::new_nfkc();
    let boundaries: Vec<_> = GraphemeClusterSegmenter::new()
        .segment_str(original)
        .collect();
    let mut result = vec![(0, 0)];
    let mut normalized = String::new();
    for pair in boundaries.windows(2) {
        normalized.push_str(&normalizer.normalize(&original[pair[0]..pair[1]]));
        result.push((normalized.len(), pair[1]));
    }
    (normalized == surface).then_some(result)
}

fn expand(token: &AnalyzedToken, source: &str) -> Option<Vec<AnalyzedToken>> {
    if token.language != "ko" {
        return None;
    }
    let mut raw = SEGMENTER.segment(Cow::Borrowed(&token.surface)).ok()?;
    if raw.len() != 1
        || raw[0].byte_start != 0
        || raw[0].byte_end != token.surface.len()
        || raw[0].surface.as_ref() != token.surface.as_str()
    {
        return None;
    }
    let details = raw[0].details();
    let components = parse_components(&token.surface, details.get(4)?, details.get(7)?)?;
    let original = source.get(token.start..token.end)?;
    let boundaries = original_boundaries(original, &token.surface)?;
    let mut cursor = 0;
    let mut result = Vec::with_capacity(components.len());
    for component in components {
        let end = cursor + component.len();
        let mapped_start = boundaries.iter().find(|pair| pair.0 == cursor)?.1;
        let mapped_end = boundaries.iter().find(|pair| pair.0 == end)?.1;
        if mapped_start >= mapped_end {
            return None;
        }
        result.push(AnalyzedToken {
            script: format!("{:?}", StrDetection::new(&component, None).script()),
            text: component.clone(),
            surface: component,
            start: token.start + mapped_start,
            end: token.start + mapped_end,
            position: 0,
            colocated: false,
            language: "ko".into(),
            algorithm: None,
        });
        cursor = end;
    }
    Some(result)
}

fn challenger(text: &str, config: &Config, prefix: bool) -> Result<(Analysis, usize), String> {
    if config.folding != Folding::None {
        return Err("Compound challenger supports folding=none only".into());
    }
    let mut analysis = analyze(text, config, prefix)?;
    let mut hash = Sha256::new();
    hash.update(analysis.fingerprint.as_bytes());
    hash.update(include_bytes!("omnesis-korean-compound-probe.rs"));
    hash.update(include_bytes!("../../compound-policy.json"));
    analysis.fingerprint = format!("{VERSION}:{:x}", hash.finalize());
    analysis.version = VERSION;
    let last = analysis.tokens.len().saturating_sub(1);
    let mut expanded = 0;
    let mut output = Vec::new();
    for (index, token) in analysis.tokens.into_iter().enumerate() {
        if config.mode == Mode::Stem && !(prefix && index == last) {
            if let Some(parts) = expand(&token, text) {
                expanded += 1;
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
    Ok((analysis, expanded))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let config = Config::new(
            request.language.as_deref().unwrap_or("und"),
            request.mode,
            request.segmenter,
        )?
        .with_folding(request.folding);
        let (analysis, expanded) = challenger(&request.text, &config, request.prefix)?;
        let mut response = serde_json::to_value(analysis)?;
        response["challenger"] = json!({"version": VERSION, "expanded_compounds": expanded,
            "path": "one flat constituent path in stem lane; unchanged precise exact lane",
            "protocol_sha256": format!("{:x}", Sha256::digest(include_bytes!("../../compound-policy.json")))});
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(&mut stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, mode: Mode) -> Analysis {
        challenger(
            text,
            &Config::new("ko", mode, SegmenterMode::Dictionary).unwrap(),
            false,
        )
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
    fn dictionary_compound_and_inflected_surface_share_constituents() {
        let query = run("승차권", Mode::Stem);
        let document = run("승차권을", Mode::Stem);
        assert_eq!(terms(&query), vec!["승차", "권"]);
        assert_eq!(&terms(&document)[..2], terms(&query));
        assert_eq!(query.tokens[0].start, 0);
        assert_eq!(query.tokens[0].end, 6);
        assert_eq!(query.tokens[1].start, 6);
        assert_eq!(query.tokens[1].end, 9);
        assert_eq!(terms(&run("승차권", Mode::Exact)), vec!["승차권"]);
    }

    #[test]
    fn decomposed_hangul_maps_back_to_original_bytes() {
        let query = run("승차권", Mode::Stem);
        assert_eq!(terms(&query), vec!["승차", "권"]);
        assert_eq!(query.tokens[0].end, 15);
        assert_eq!(query.tokens[1].start, 15);
        assert_eq!(query.tokens[1].end, 24);
    }

    #[test]
    fn issue902_and_fresh_particle_pairs_keep_matching_flat_paths() {
        for (query, document) in [
            ("파란고래우체통", "파란고래우체통입니다"),
            ("입장권", "입장권을"),
            ("탑승권", "탑승권을"),
            ("관람권", "관람권을"),
            ("도서관", "도서관을"),
            ("자전거", "자전거를"),
            ("신용카드", "신용카드를"),
            ("여권", "여권을"),
            ("우체통", "우체통을"),
        ] {
            let query = run(query, Mode::Stem);
            let document = run(document, Mode::Stem);
            assert_eq!(&terms(&document)[..query.tokens.len()], terms(&query));
            assert!(document
                .tokens
                .iter()
                .enumerate()
                .all(|(index, token)| token.position == index && !token.colocated));
        }
    }

    #[test]
    fn malformed_and_nonconcatenative_or_inflection_metadata_fall_back() {
        for (surface, kind, expression) in [
            ("승차권", "Inflect", "승차/NNG/*+권/NNG/*"),
            ("승차권", "Compound", "승차/NNG/*+다른/NNG/*"),
            ("승차권", "Compound", "승차/NNG+권/NNG/*"),
            ("승차권", "Compound", "승차/NNG/*+"),
            ("승차권", "Compound", "승차권/NNG/*"),
            ("승차권", "Compound", "승차/NNG/*+권///*"),
        ] {
            assert!(parse_components(surface, kind, expression).is_none());
        }
        assert!(original_boundaries("ㄱㅏ", "가").is_none());
    }

    #[test]
    fn non_korean_analysis_and_precise_korean_lane_keep_frozen_tokens() {
        for (text, language, mode) in [
            ("recipes running", "en", Mode::Stem),
            ("승차권을 파란 봉투에", "ko", Mode::Exact),
        ] {
            let config = Config::new(language, mode, SegmenterMode::Dictionary).unwrap();
            let baseline = analyze(text, &config, false).unwrap();
            let (experimental, count) = challenger(text, &config, false).unwrap();
            assert_eq!(
                serde_json::to_value(&baseline.tokens).unwrap(),
                serde_json::to_value(&experimental.tokens).unwrap()
            );
            assert_eq!(count, 0);
            assert_ne!(baseline.fingerprint, experimental.fingerprint);
        }
    }

    #[test]
    fn exact_and_prefix_preserve_precise_terms_and_fingerprints_are_distinct() {
        let config = Config::new("ko", Mode::Stem, SegmenterMode::Dictionary).unwrap();
        let (prefixed, expanded) = challenger("승차권", &config, true).unwrap();
        assert_eq!(terms(&prefixed), vec!["승차권"]);
        assert_eq!(expanded, 0);
        assert_ne!(
            run("승차권", Mode::Exact).fingerprint,
            run("승차권", Mode::Stem).fingerprint
        );
        assert!(run("승차권", Mode::Stem).fingerprint.starts_with(VERSION));
        assert!(challenger("승차권", &config.with_folding(Folding::Broad), false).is_err());
    }
}

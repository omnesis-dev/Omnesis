// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

use std::io::{self, BufRead, Write};

use icu_casemap::CaseMapper;
use icu_locale_core::LanguageIdentifier;
use icu_normalizer::ComposingNormalizer;
use icu_segmenter::{options::WordBreakOptions, WordSegmenter};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Request {
    text: String,
    language: Option<String>,
    #[serde(default = "auto_mode")]
    mode: String,
}

fn auto_mode() -> String {
    "auto".into()
}

fn language_code(input: &str) -> &str {
    match input {
        "eng" => "en",
        "kor" => "ko",
        "cmn" | "zho" => "zh",
        "jpn" => "ja",
        "tha" => "th",
        "deu" => "de",
        "fra" => "fr",
        "spa" => "es",
        "por" => "pt",
        "ita" => "it",
        "rus" => "ru",
        "ukr" => "uk",
        "tur" => "tr",
        "fin" => "fi",
        "ara" => "ar",
        "heb" => "he",
        "ell" => "el",
        "hin" => "hi",
        "pes" => "fa",
        "vie" => "vi",
        "khm" => "km",
        other => other,
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let normalizer = ComposingNormalizer::new_nfkc();
    let case_mapper = CaseMapper::new();
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let language: LanguageIdentifier = request
            .language
            .as_deref()
            .map(language_code)
            .unwrap_or("und")
            .parse()?;
        let mut options = WordBreakOptions::default();
        options.content_locale = request.language.as_ref().map(|_| &language);
        let segmenter = match request.mode.as_str() {
            "auto" => WordSegmenter::try_new_auto(options)?,
            "dictionary" => WordSegmenter::try_new_dictionary(options)?,
            other => return Err(format!("Unsupported segmentation mode: {other}").into()),
        };
        let mut start = 0;
        let mut tokens = Vec::new();
        for (end, word_type) in segmenter
            .as_borrowed()
            .segment_str(&request.text)
            .iter_with_word_type()
        {
            if end > start {
                let source = &request.text[start..end];
                // Word status can omit a segment ending in combining marks before
                // whitespace. Preserve segments containing a letter or digit.
                if word_type.is_word_like() || source.chars().any(char::is_alphanumeric) {
                    let normalized = normalizer.normalize(source);
                    let lowercased = case_mapper.lowercase_to_string(&normalized, &language);
                    tokens.push(json!({
                        "text": lowercased,
                        "start": start,
                        "end": end,
                        "wordlike_fallback": !word_type.is_word_like(),
                    }));
                }
            }
            start = end;
        }
        serde_json::to_writer(
            &mut stdout,
            &json!({
                "tokens": tokens,
                "engine": "icu4x",
                "version": "2.4.0",
                "mode": request.mode,
                "offset_unit": "utf8_bytes",
                "normalization": "nfkc_then_locale_lowercase",
            }),
        )?;
        writeln!(&mut stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

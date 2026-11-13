// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

use std::io::{self, BufRead, Write};

use charabia::{Language, TokenizerBuilder};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Request {
    text: String,
    language: Option<String>,
    #[serde(default)]
    detect: bool,
}

fn language_code(input: &str) -> &str {
    match input {
        "en" => "eng",
        "ko" => "kor",
        "zh" => "cmn",
        "ja" => "jpn",
        "th" => "tha",
        "de" => "deu",
        "fr" => "fra",
        "es" => "spa",
        "pt" => "por",
        "it" => "ita",
        "ru" => "rus",
        "uk" => "ukr",
        "tr" => "tur",
        "fi" => "fin",
        "ar" => "ara",
        "he" => "heb",
        "el" => "ell",
        "hi" => "hin",
        "fa" => "pes",
        "vi" => "vie",
        "km" => "khm",
        other => other,
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut builder = TokenizerBuilder::default();
    let tokenizer = builder.build();
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let detected = whatlang::detect(&request.text);
        let detection = detected.as_ref().map(|info| {
            json!({
                "language": info.lang().code(),
                "confidence": info.confidence(),
                "reliable": info.is_reliable(),
                "script": format!("{:?}", info.script()),
            })
        });
        let languages: Option<Vec<Language>> = request
            .language
            .as_deref()
            .map(language_code)
            .and_then(Language::from_code)
            .or_else(|| {
                request
                    .detect
                    .then(|| detected.as_ref().map(|info| Language::from(info.lang())))
                    .flatten()
            })
            .map(|language| vec![language]);
        let tokens: Vec<_> = tokenizer
            .tokenize_with_allow_list(&request.text, languages.as_deref())
            .filter(|token| token.is_word())
            .map(|token| {
                json!({
                    "text": token.lemma(),
                    "start": token.byte_start,
                    "end": token.byte_end,
                    "language": token.language.map(|language| language.code()),
                    "script": format!("{:?}", token.script),
                })
            })
            .collect();
        serde_json::to_writer(
            &mut stdout,
            &json!({ "tokens": tokens, "detection": detection }),
        )?;
        writeln!(&mut stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

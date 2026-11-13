// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

use std::io::{self, BufRead, Write};

use frostem::Stemmer;
use omnesis_multilingual_core::config::canonical_language;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Request {
    text: String,
    language: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let language = canonical_language(&request.language)?;
        let stemmer = Stemmer::try_from_name(language.language.as_str()).ok();
        let stem = stemmer
            .as_ref()
            .map(|value| value.stem(&request.text).into_owned())
            .unwrap_or_else(|| request.text.clone());
        serde_json::to_writer(
            &mut stdout,
            &json!({
                "text": stem, "language": language.to_string(),
                "algorithm": stemmer.map(|value| value.algorithm().name()),
                "version": "frostem=2.20261016.3",
            }),
        )?;
        writeln!(&mut stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

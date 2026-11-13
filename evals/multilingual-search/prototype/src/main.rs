// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

use std::io::{self, BufRead, Write};

use omnesis_multilingual_core::{analyze, Config, Mode, SegmenterMode};
use serde::Deserialize;

#[derive(Deserialize)]
struct Request {
    text: String,
    language: Option<String>,
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    segmenter: SegmenterMode,
    #[serde(default)]
    prefix: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let config = Config::new(
            request.language.as_deref().unwrap_or("und"),
            request.mode,
            request.segmenter,
        )?;
        let response = analyze(&request.text, &config, request.prefix)?;
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(&mut stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

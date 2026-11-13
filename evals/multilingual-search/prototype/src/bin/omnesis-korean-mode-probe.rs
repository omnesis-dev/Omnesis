// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

//! Independent raw Lindera mode traces; the frozen analyzer is not configured here.

use std::borrow::Cow;
use std::io::{self, BufRead, Write};

use lindera::dictionary::{load_embedded_dictionary, DictionaryKind};
use lindera::mode::{Mode, Penalty};
use lindera::segmenter::Segmenter;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Request {
    text: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dictionary = load_embedded_dictionary(DictionaryKind::KoDic)?;
    let mut segmenter = Segmenter::new(Mode::Normal, dictionary, None);
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let mut modes = serde_json::Map::new();
        for (name, mode) in [
            ("normal", Mode::Normal),
            ("decompose", Mode::Decompose(Penalty::default())),
        ] {
            segmenter.mode = mode;
            let tokens = segmenter
                .segment(Cow::Borrowed(request.text.as_str()))?
                .into_iter()
                .map(|mut token| {
                    let details: Vec<String> =
                        token.details().into_iter().map(str::to_owned).collect();
                    json!({
                        "text": token.surface,
                        "start": token.byte_start,
                        "end": token.byte_end,
                        "position": token.position,
                        "position_length": token.position_length,
                        "dictionary_details": details,
                    })
                })
                .collect::<Vec<_>>();
            modes.insert(name.into(), json!(tokens));
        }
        serde_json::to_writer(
            &mut stdout,
            &json!({
                "text": request.text,
                "modes": modes,
                "dependency": "lindera=5.3.0",
                "dictionary": "mecab-ko-dic-2.1.1-20180720",
                "offset_unit": "utf8_bytes",
                "normalization": "none; raw standalone diagnostic",
            }),
        )?;
        writeln!(&mut stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

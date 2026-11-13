// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

use std::io::{self, BufRead, Write};

use fasttext_pure_rs::FastText;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Request {
    text: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let model_path = std::env::args()
        .nth(1)
        .ok_or("Usage: omnesis-fasttext-probe MODEL_PATH")?;
    let model = FastText::load(model_path)?;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let predictions: Vec<_> = model
            .predict(&request.text, 3, 0.0)?
            .into_iter()
            .map(|prediction| {
                json!({
                    "language": prediction.label.trim_start_matches("__label__"),
                    "confidence": prediction.probability,
                })
            })
            .collect();
        serde_json::to_writer(
            &mut stdout,
            &json!({"detection": predictions.first(), "predictions": predictions}),
        )?;
        writeln!(&mut stdout)?;
    }
    stdout.flush()?;
    Ok(())
}

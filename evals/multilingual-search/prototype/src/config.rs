// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

use icu_locale_core::LanguageIdentifier;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const ANALYZER_VERSION: &str = "omnesis-multilingual-v1";
pub const DEPENDENCIES: &str = "charabia=0.10.0;lindera=5.3.0;icu4x=2.4.0;frostem=2.20261016.3";
pub const SNOWBALL_COMMIT: &str = "06e1f74f7cf61ea8913c6269480b8d392c33dbae";
pub const QUERY_TERMS_LOCALE: &str = "und-x-omnesis-terms-v1";
pub const KOREAN_DICTIONARY_SHA256: &str =
    "702ced21c6167e9d9aebc674ab5ee54af58d4443975f2940d37d0567c020591a";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Exact,
    #[default]
    Stem,
}

impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Stem => "stem",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SegmenterMode {
    Auto,
    #[default]
    Dictionary,
}

impl SegmenterMode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Dictionary => "dictionary",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub language: LanguageIdentifier,
    pub mode: Mode,
    pub segmenter: SegmenterMode,
    pub folding: Folding,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Folding {
    #[default]
    None,
    Broad,
}

impl Folding {
    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Broad => "broad",
        }
    }
}

impl Config {
    pub fn new(language: &str, mode: Mode, segmenter: SegmenterMode) -> Result<Self, String> {
        if language == QUERY_TERMS_LOCALE {
            return Err("Reserved locale is valid only for already-analyzed MATCH queries".into());
        }
        if language.len() > 63 {
            return Err("Language identifier exceeds 63 bytes".into());
        }
        let language = canonical_language(language)?;
        Ok(Self {
            language,
            mode,
            segmenter,
            folding: Folding::None,
        })
    }

    pub fn with_locale(&self, locale: Option<&str>) -> Result<Self, String> {
        match locale.filter(|value| !value.is_empty()) {
            Some(language) => Self::new(language, self.mode, self.segmenter)
                .map(|config| config.with_folding(self.folding)),
            None => Ok(self.clone()),
        }
    }

    pub fn with_folding(mut self, folding: Folding) -> Self {
        self.folding = folding;
        self
    }

    pub fn fingerprint(&self) -> String {
        let value = format!(
            "{ANALYZER_VERSION};{};{};{};{};{DEPENDENCIES};{}",
            self.language,
            self.mode.name(),
            self.segmenter.name(),
            self.folding.name(),
            env!("OMNESIS_ANALYZER_SOURCE_HASH"),
        );
        format!("{ANALYZER_VERSION}:{:x}", Sha256::digest(value.as_bytes()))
    }
}

pub fn canonical_language(value: &str) -> Result<LanguageIdentifier, String> {
    let mut pieces = value.split('-');
    let first = pieces.next().unwrap_or("und").to_ascii_lowercase();
    let language = match first.as_str() {
        "" | "auto" | "und" => "und",
        "eng" => "en",
        "kor" => "ko",
        "cmn" | "zho" => "zh",
        "jpn" => "ja",
        "tha" => "th",
        "deu" | "ger" => "de",
        "fra" | "fre" => "fr",
        "spa" => "es",
        "por" => "pt",
        "ita" => "it",
        "rus" => "ru",
        "ukr" => "uk",
        "tur" => "tr",
        "fin" => "fi",
        "ara" => "ar",
        "heb" => "he",
        "ell" | "gre" => "el",
        "hin" => "hi",
        "pes" | "fas" | "per" => "fa",
        "vie" => "vi",
        "khm" => "km",
        "nld" | "dut" => "nl",
        "swe" => "sv",
        "dan" => "da",
        "nob" | "no" => "nb",
        "hun" => "hu",
        "ind" => "id",
        "ron" | "rum" => "ro",
        "ces" | "cze" => "cs",
        "pol" => "pl",
        "lit" => "lt",
        "lav" => "lv",
        "est" => "et",
        "tam" => "ta",
        "nep" => "ne",
        "srp" => "sr",
        "cat" => "ca",
        "eus" => "eu",
        "hye" => "hy",
        "gle" => "ga",
        "yid" => "yi",
        "sot" => "st",
        other => other,
    };
    let rest: Vec<_> = pieces.collect();
    let canonical = if rest.is_empty() {
        language.to_string()
    } else {
        format!("{language}-{}", rest.join("-"))
    };
    canonical
        .parse()
        .map_err(|_| format!("Invalid language identifier: {value}"))
}

pub fn charabia_language(language: &str) -> Option<charabia::Language> {
    let code = match language {
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
        "nl" => "nld",
        "sv" => "swe",
        "da" => "dan",
        "nb" => "nob",
        "hu" => "hun",
        "id" => "ind",
        "ro" => "ron",
        "cs" => "ces",
        "pl" => "pol",
        "lt" => "lit",
        "lv" => "lav",
        "et" => "est",
        "ta" => "tam",
        "ne" => "nep",
        "sr" => "srp",
        "ca" => "cat",
        "eu" => "eus",
        "hy" => "hye",
        "ga" => "gle",
        "yi" => "yid",
        "st" => "sot",
        _ => return None,
    };
    charabia::Language::from_code(code)
}

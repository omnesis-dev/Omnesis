// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

use icu_normalizer::ComposingNormalizer;
use icu_segmenter::GraphemeClusterSegmenter;

struct ClusterRange {
    normalized_start: usize,
    normalized_end: usize,
    original_start: usize,
    original_end: usize,
}

pub struct NormalizedText<'a> {
    original: &'a str,
    mapped: Option<(String, Vec<ClusterRange>)>,
}

impl<'a> NormalizedText<'a> {
    pub fn new(original: &'a str) -> Result<Self, String> {
        let normalizer = ComposingNormalizer::new_nfkc();
        if normalizer.is_normalized(original) {
            return Ok(Self {
                original,
                mapped: None,
            });
        }
        let boundaries: Vec<_> = GraphemeClusterSegmenter::new()
            .segment_str(original)
            .collect();
        let mut normalized = String::with_capacity(original.len());
        let mut ranges: Vec<ClusterRange> = Vec::with_capacity(boundaries.len());
        for pair in boundaries.windows(2) {
            let mut original_start = pair[0];
            let mut value = normalizer
                .normalize(&original[original_start..pair[1]])
                .into_owned();
            // Compatibility Jamo can compose across original grapheme boundaries.
            // Merge adjacent source ranges until concatenation is already NFKC.
            while let Some(previous) = ranges.last() {
                let mut joined = normalized[previous.normalized_start..].to_string();
                joined.push_str(&value);
                if normalizer.is_normalized(&joined) {
                    break;
                }
                let previous = ranges.pop().expect("a last range was inspected");
                normalized.truncate(previous.normalized_start);
                original_start = previous.original_start;
                value = normalizer
                    .normalize(&original[original_start..pair[1]])
                    .into_owned();
            }
            let start = normalized.len();
            normalized.push_str(&value);
            if normalized.len() > start {
                ranges.push(ClusterRange {
                    normalized_start: start,
                    normalized_end: normalized.len(),
                    original_start,
                    original_end: pair[1],
                });
            }
        }
        // Verify the offset-building normalization against the whole-text result.
        if normalized != normalizer.normalize(original) {
            return Err("NFKC offset mapping disagrees with whole-text normalization".into());
        }
        Ok(Self {
            original,
            mapped: Some((normalized, ranges)),
        })
    }

    pub fn text(&self) -> &str {
        self.mapped
            .as_ref()
            .map(|(value, _)| value.as_str())
            .unwrap_or(self.original)
    }

    pub fn original_range(&self, start: usize, end: usize) -> Result<(usize, usize), String> {
        if start >= end || end > self.text().len() {
            return Err("Invalid normalized token range".into());
        }
        match &self.mapped {
            None => Ok((start, end)),
            Some((_, ranges)) => {
                let first = ranges.partition_point(|range| range.normalized_end <= start);
                let after_last = ranges.partition_point(|range| range.normalized_start < end);
                if first >= after_last || after_last > ranges.len() {
                    return Err("Normalized range has no original grapheme mapping".into());
                }
                Ok((
                    ranges[first].original_start,
                    ranges[after_last - 1].original_end,
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_hangul_latin_and_compatibility_normalization_matches_whole_text() {
        for source in [
            "파란고래",
            "ㄱㅏ",
            "cafe\u{301}",
            "ﷺ",
            "ＡＢＣ１２３",
            "\u{ff76}\u{ff9e}",
            "\u{1e9b}\u{323}",
        ] {
            let mapped = NormalizedText::new(source).unwrap();
            assert_eq!(
                mapped.text(),
                ComposingNormalizer::new_nfkc().normalize(source)
            );
            for (start, value) in mapped.text().char_indices() {
                let (original_start, original_end) = mapped
                    .original_range(start, start + value.len_utf8())
                    .unwrap();
                assert!(
                    source.is_char_boundary(original_start)
                        && source.is_char_boundary(original_end)
                );
                assert!(original_start < original_end && original_end <= source.len());
            }
        }
    }
}

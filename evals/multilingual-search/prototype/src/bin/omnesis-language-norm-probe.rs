// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

mod normalization_profile;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    normalization_profile::run(normalization_profile::Profile::LanguageNorm)
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

pub mod analyzer;
pub mod config;
mod ffi;
mod normalization;

pub use analyzer::{analyze, Analysis, AnalyzedToken};
pub use config::{Config, Folding, Mode, SegmenterMode};

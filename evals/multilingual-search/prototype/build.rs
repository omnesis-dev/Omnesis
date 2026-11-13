// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

use std::{env, fs, path::Path};

use sha2::{Digest, Sha256};

fn main() {
    for name in [
        "DOCS_RS",
        "LINDERA_CTX_FREQ_FILE",
        "LINDERA_BUILD_DICTIONARY_CACHE_DIR",
        "LINDERA_DICTIONARIES_PATH",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
        assert!(
            env::var_os(name).is_none(),
            "Pinned prototype analysis does not allow the {name} override"
        );
    }
    let root = env::var("CARGO_MANIFEST_DIR").expect("Cargo supplies the manifest directory");
    let mut hash = Sha256::new();
    for name in [
        "Cargo.toml",
        "Cargo.lock",
        "build.rs",
        "src/lib.rs",
        "src/config.rs",
        "src/analyzer.rs",
        "src/ffi.rs",
        "src/normalization.rs",
        "fts5-adapter.c",
    ] {
        println!("cargo:rerun-if-changed={name}");
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update(fs::read(Path::new(&root).join(name)).expect("analysis source must exist"));
        hash.update([0]);
    }
    println!(
        "cargo:rustc-env=OMNESIS_ANALYZER_SOURCE_HASH={:x}",
        hash.finalize()
    );
}

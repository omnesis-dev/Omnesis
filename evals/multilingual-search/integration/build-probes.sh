#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

set -eu
: "${CARGO_TARGET_DIR:?Set the Cargo output directory outside the checkout}"
: "${MULTILINGUAL_TOOLS_DIR:?Set the executable directory outside the checkout}"
: "${CARGO_BUILD_JOBS:=2}"
export CARGO_BUILD_JOBS
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$MULTILINGUAL_TOOLS_DIR"
cargo build --release --locked --manifest-path "$root/prototype/Cargo.toml"
cp "$CARGO_TARGET_DIR/release/omnesis-multilingual-prototype" "$MULTILINGUAL_TOOLS_DIR/prototype"
cargo build --release --locked --manifest-path "$root/icu4x-probe/Cargo.toml"
cp "$CARGO_TARGET_DIR/release/omnesis-icu4x-probe" "$MULTILINGUAL_TOOLS_DIR/icu4x"
cargo build --release --locked --manifest-path "$root/charabia-probe/Cargo.toml"
cp "$CARGO_TARGET_DIR/release/omnesis-charabia-probe" "$MULTILINGUAL_TOOLS_DIR/charabia-full"
cargo build --release --locked --manifest-path "$root/charabia-probe/Cargo.toml" --no-default-features --features lean
cp "$CARGO_TARGET_DIR/release/omnesis-charabia-probe" "$MULTILINGUAL_TOOLS_DIR/charabia-lean"
